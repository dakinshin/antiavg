/**
 * Условные ордера Binance (Algo Order API).
 *
 * С конца 2025 года стопы, тейки и трейлинг живут в отдельном пространстве:
 * свой эндпоинт размещения и отмены, свои идентификаторы и события
 * `ALGO_UPDATE` вместо `ORDER_TRADE_UPDATE`. Сервис, слушающий только второе,
 * не видит стопов вообще — ни чтобы оценить риск, ни чтобы вернуть снятый.
 *
 * Payload'ы здесь — дословно из боевого лога, а не придуманные.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testConfig, type Config } from '../src/config.js';
import { Engine } from '../src/core/engine.js';
import { ActionLimiter } from '../src/core/actionLimiter.js';
import {
  RiskGuard,
  type RiskExecutor,
  type RiskStatusEvent,
  type StopOrderSpec,
  type StopPlacement,
} from '../src/core/riskGuard.js';
import type { ExecutionOutcome } from '../src/core/engine.js';
import {
  algoUpdateToLifecycleEvent,
  algoUpdateToRecord,
  openAlgoOrderToRecord,
  type RawAlgoUpdate,
  type RawOpenAlgoOrder,
} from '../src/binance/mappers.js';
import { stopKindOf } from '../src/core/riskRules.js';
import type { ProtectiveAction } from '../src/types.js';
import { FakeClock, fillEvent, feed, newOrderEvent, nextOrderId, recordingLogger } from './helpers.js';

/** Событие постановки стопа — точная форма из лога 2026-08-19. */
function algoUpdate(over: Partial<RawAlgoUpdate['o']> = {}, timeMs = 1787154610488): RawAlgoUpdate {
  return {
    e: 'ALGO_UPDATE',
    T: timeMs,
    E: timeMs,
    o: {
      caid: 'x-bUKJewSG2a4d7c91306f7eeef43e61',
      aid: 1000002514324592,
      at: 'CONDITIONAL',
      o: 'STOP_MARKET',
      s: 'BTWUSDT',
      S: 'BUY',
      ps: 'BOTH',
      f: 'GTE_GTC',
      q: '0',
      X: 'NEW',
      ai: '',
      tp: '0.5973',
      p: '0',
      wt: 'CONTRACT_PRICE',
      cp: true,
      R: true,
      ...over,
    },
  };
}

describe('разбор условных ордеров', () => {
  it('ALGO_UPDATE превращается в стоп-ордер с ценой срабатывания', () => {
    const rec = algoUpdateToRecord(algoUpdate(), 'antiavg');
    expect(rec.orderId).toBe(1000002514324592);
    expect(rec.origType).toBe('STOP_MARKET');
    // triggerPrice приходит в поле tp, а в остальном сервисе это stopPrice.
    expect(rec.stopPrice).toBeCloseTo(0.5973);
    expect(rec.closePosition).toBe(true);
    expect(rec.algo).toBe(true);
    expect(rec.own).toBe(false);
  });

  it('стоп на закрывающей стороне распознаётся правилами риска', () => {
    const rec = algoUpdateToRecord(algoUpdate(), 'antiavg');
    // BUY-стоп защищает шорт.
    expect(stopKindOf(rec, -31)).toBe('fixed');
    expect(stopKindOf(rec, 31)).toBeNull();
  });

  it('свой стоп узнаётся по префиксу clientAlgoId', () => {
    const rec = algoUpdateToRecord(algoUpdate({ caid: 'antiavg_mt09laxe_1' }), 'antiavg');
    expect(rec.own).toBe(true);
  });

  it('сработавший стоп — терминальное состояние, TRIGGERING — ещё нет', () => {
    const triggering = algoUpdateToLifecycleEvent(algoUpdate({ X: 'TRIGGERING' }), 'antiavg');
    const triggered = algoUpdateToLifecycleEvent(algoUpdate({ X: 'TRIGGERED', ai: '1495006952' }), 'antiavg');
    expect(triggering.orderStatus).toBe('TRIGGERING');
    expect(triggered.orderStatus).toBe('TRIGGERED');
  });

  it('условный ордер из REST-снимка тоже помечается algo', () => {
    const raw: RawOpenAlgoOrder = {
      algoId: 1000002514324992,
      clientAlgoId: 'x-bUKJewSG084f92bf',
      algoType: 'CONDITIONAL',
      orderType: 'STOP_MARKET',
      symbol: 'BTWUSDT',
      side: 'BUY',
      positionSide: 'BOTH',
      quantity: '0',
      triggerPrice: '0.5955',
      closePosition: true,
      createTime: 1787154618829,
    };
    const rec = openAlgoOrderToRecord(raw, 'antiavg');
    expect(rec.algo).toBe(true);
    expect(rec.stopPrice).toBeCloseTo(0.5955);
    expect(rec.origType).toBe('STOP_MARKET');
  });
});

class Stub implements RiskExecutor {
  readonly actions: ProtectiveAction[] = [];
  readonly stops: StopOrderSpec[] = [];
  readonly cancelled: Array<{ orderId: number; algo: boolean }> = [];
  private seq = 90000;

  async execute(a: ProtectiveAction): Promise<ExecutionOutcome> {
    this.actions.push(a);
    return { executed: true, sentQty: a.requestedQty };
  }
  async cancelOrder(_s: string, orderId: number, opts: { algo?: boolean } = {}) {
    this.cancelled.push({ orderId, algo: Boolean(opts.algo) });
    return { cancelled: true };
  }
  async placeStop(spec: StopOrderSpec): Promise<StopPlacement> {
    this.stops.push(spec);
    return { placed: true, orderId: ++this.seq, stopPrice: spec.stopPrice };
  }
}

function harness(overrides: Partial<Config> = {}) {
  const clock = new FakeClock();
  const executor = new Stub();
  const { logger, lines } = recordingLogger();
  const cfg = testConfig({ dryRun: false, aggregationWindowMs: 60_000, cooldownMs: 0, ...overrides });
  const limiter = new ActionLimiter(cfg.maxActionsPerHour);
  const engine = new Engine({ cfg, executor, limiter, now: clock.now, logger });
  const market = {
    balance: 1000,
    price: 100,
    walletBalance: async () => market.balance,
    markPrice: async () => market.price,
    filters: async () => ({
      symbol: 'BTCUSDT',
      stepSize: 0.001,
      minQty: 0.001,
      maxQty: 1000,
      tickSize: 0.01,
      minNotional: 5,
      quantityPrecision: 3,
      pricePrecision: 2,
    }),
  };
  const riskEvents: RiskStatusEvent[] = [];
  const risk = new RiskGuard({
    cfg,
    executor,
    limiter,
    positions: engine.positions,
    orders: engine.orders,
    market,
    hedgeMode: false,
    now: clock.now,
    logger,
    hooks: { onRiskStatus: (e) => riskEvents.push(e) },
  });

  const openLong = (qty: number, price: number) => {
    const id = nextOrderId();
    feed(engine, newOrderEvent({ orderId: id, side: 'BUY', qty, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: id, side: 'BUY', lastQty: qty, lastPrice: price, type: 'MARKET', timeMs: clock.now() }));
    risk.onFill('BTCUSDT', 'BOTH');
  };

  /** Как это делает App: ALGO_UPDATE идёт и в движок, и в риск-модуль. */
  const feedAlgo = (over: Partial<RawAlgoUpdate['o']> = {}) => {
    const lifecycle = algoUpdateToLifecycleEvent(
      algoUpdate({ s: 'BTCUSDT', S: 'SELL', ...over }, clock.now()),
      cfg.clientOrderIdPrefix,
    );
    engine.onOrderEvent(lifecycle);
    risk.onOrderEvent(lifecycle);
    return lifecycle.order.orderId;
  };

  return { cfg, clock, executor, engine, risk, market, riskEvents, logs: lines, openLong, feedAlgo };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('правила риска работают по событиям ALGO_UPDATE', () => {
  it('стоп из ALGO_UPDATE закрывает вердикт «стоп не выставлен»', async () => {
    const h = harness({ maxRiskEnabled: false, maxPositionEnabled: true, maxPositionLeverage: 1000 });
    h.openLong(10, 100);
    await h.risk.settle();
    expect(h.riskEvents.at(-1)?.verdict).toBe('no-stop');

    h.feedAlgo({ tp: '99.5' });
    await h.risk.settle();
    expect(h.riskEvents.at(-1)?.verdict).toBe('within');
  });

  it('стоп дальше лимита риска подтягивается, а старый снимается алго-эндпоинтом', async () => {
    // Депозит 1000, предел 2% = 20. Позиция 10 по 100, стоп 90 -> риск 100.
    const h = harness({ maxRiskEnabled: true, maxRiskPct: 2 });
    h.openLong(10, 100);
    await h.risk.settle();

    const algoId = h.feedAlgo({ tp: '90' });
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(1);
    expect(h.executor.stops[0]?.stopPrice).toBeCloseTo(98);
    // Снимать условный ордер обычным эндпоинтом бессмысленно — он о нём не знает.
    expect(h.executor.cancelled).toContainEqual({ orderId: algoId, algo: true });
  });

  it('снятый стоп возвращается на прежнюю цену', async () => {
    const h = harness({ protectStopOrders: true });
    h.openLong(10, 100);
    const algoId = h.feedAlgo({ tp: '98' });
    await h.risk.settle();

    h.feedAlgo({ tp: '98', X: 'CANCELED', aid: algoId });
    await vi.advanceTimersByTimeAsync(1000);
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(1);
    expect(h.executor.stops[0]?.stopPrice).toBeCloseTo(98);
  });

  it('сработавший стоп (TRIGGERED) не восстанавливается', async () => {
    const h = harness({ protectStopOrders: true });
    h.openLong(10, 100);
    const algoId = h.feedAlgo({ tp: '98' });
    await h.risk.settle();

    h.feedAlgo({ tp: '98', X: 'TRIGGERED', ai: '1495006952', aid: algoId });
    await vi.advanceTimersByTimeAsync(1000);
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(0);
  });

  it('состояние TRIGGERING не считается снятием', async () => {
    const h = harness({ protectStopOrders: true });
    h.openLong(10, 100);
    const algoId = h.feedAlgo({ tp: '98' });
    await h.risk.settle();

    h.feedAlgo({ tp: '98', X: 'TRIGGERING', aid: algoId });
    await vi.advanceTimersByTimeAsync(1000);
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(0);
    expect(h.engine.orders.isOpen(algoId)).toBe(true);
  });

  it('дефолтный стоп не ставится, если стоп пришёл через ALGO_UPDATE', async () => {
    const h = harness({ defaultStopEnabled: true, defaultStopDelayMs: 2000 });
    h.openLong(10, 100);
    h.feedAlgo({ tp: '99' });
    await h.risk.settle();

    await vi.advanceTimersByTimeAsync(2000);
    await h.risk.settle();
    expect(h.executor.stops).toHaveLength(0);
  });
});

/**
 * Правила управления риском в сборе: лимит объёма, дефолтный стоп, защита
 * стопа от снятия и жёсткий лимит риска.
 *
 * Проверяется связка «событие биржи -> модель позиции -> решение», поэтому
 * используются настоящие Engine, PositionStore и OrderRegistry, а заглушены
 * только сеть и время.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testConfig, type Config } from '../src/config.js';
import { Engine } from '../src/core/engine.js';
import { ActionLimiter } from '../src/core/actionLimiter.js';
import { RiskGuard, type RiskExecutor, type RiskStatusEvent, type StopOrderSpec, type StopPlacement } from '../src/core/riskGuard.js';
import type { ExecutionOutcome } from '../src/core/engine.js';
import { toOrderLifecycleEvent } from '../src/binance/mappers.js';
import type { ProtectiveAction } from '../src/types.js';
import {
  FakeClock,
  fillEvent,
  feed,
  newOrderEvent,
  nextOrderId,
  orderStatusEvent,
  recordingLogger,
} from './helpers.js';

class RiskExecutorStub implements RiskExecutor {
  readonly actions: ProtectiveAction[] = [];
  readonly stops: StopOrderSpec[] = [];
  readonly cancelledOrderIds: number[] = [];
  /** Следующий ответ на placeStop. orderId выдаётся уникальный, как биржа. */
  stopResult: StopPlacement = { placed: true };
  private stopSeq = 90000;
  executeResult: ExecutionOutcome = { executed: true, orderId: 1 };

  async execute(action: ProtectiveAction): Promise<ExecutionOutcome> {
    this.actions.push(action);
    return { ...this.executeResult, sentQty: action.requestedQty };
  }

  async cancelOrder(_symbol: string, orderId: number): Promise<{ cancelled: boolean }> {
    this.cancelledOrderIds.push(orderId);
    return { cancelled: true };
  }

  async placeStop(spec: StopOrderSpec): Promise<StopPlacement> {
    this.stops.push(spec);
    const res: StopPlacement = { orderId: ++this.stopSeq, stopPrice: spec.stopPrice, ...this.stopResult };
    if (res.placed) this.lastStopOrderId = res.orderId ?? 0;
    return res;
  }

  lastStopOrderId = 0;

  reset(): void {
    this.actions.length = 0;
    this.stops.length = 0;
    this.cancelledOrderIds.length = 0;
  }
}

function harness(overrides: Partial<Config> = {}) {
  const clock = new FakeClock();
  const executor = new RiskExecutorStub();
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

  /** Открывает позицию рыночным ордером — как это выглядит в потоке событий. */
  const openPosition = (qty: number, price: number, side: 'BUY' | 'SELL' = 'BUY') => {
    const id = nextOrderId();
    const ev = newOrderEvent({ orderId: id, side, qty, type: 'MARKET', timeMs: clock.now() });
    feed(engine, ev);
    risk.onOrderEvent(toOrderLifecycleEvent(ev, cfg.clientOrderIdPrefix));
    const f = fillEvent({ orderId: id, side, lastQty: qty, lastPrice: price, type: 'MARKET', timeMs: clock.now() });
    feed(engine, f);
    risk.onFill('BTCUSDT', 'BOTH');
    return id;
  };

  /** Ставит стоп-ордер от имени человека. */
  const placeUserStop = (stopPrice: number, side: 'BUY' | 'SELL' = 'SELL', qty = 1) => {
    const id = nextOrderId();
    const ev = newOrderEvent({
      orderId: id,
      side,
      qty,
      type: 'STOP_MARKET',
      origType: 'STOP_MARKET',
      stopPrice,
      timeMs: clock.now(),
    });
    feed(engine, ev);
    risk.onOrderEvent(toOrderLifecycleEvent(ev, cfg.clientOrderIdPrefix));
    return id;
  };

  const cancelOrder = (orderId: number, opts: { stopPrice?: number; status?: string; side?: 'BUY' | 'SELL' } = {}) => {
    const ev = orderStatusEvent({
      orderId,
      side: opts.side ?? 'SELL',
      qty: 1,
      type: 'STOP_MARKET',
      origType: 'STOP_MARKET',
      stopPrice: opts.stopPrice ?? 0,
      status: opts.status ?? 'CANCELED',
      timeMs: clock.now(),
    });
    feed(engine, ev);
    risk.onOrderEvent(toOrderLifecycleEvent(ev, cfg.clientOrderIdPrefix));
  };

  return { cfg, clock, executor, engine, risk, market, riskEvents, logs: lines, openPosition, placeUserStop, cancelOrder };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('лимит объёма позиции', () => {
  it('срезает разницу выше потолка сразу после открытия', async () => {
    // Депозит 1000, плечо 3 -> потолок 3000. Открываем 50 по 100 = 5000.
    const h = harness({ maxPositionEnabled: true, maxPositionLeverage: 3 });
    h.openPosition(50, 100);
    await h.risk.settle();

    expect(h.executor.actions).toHaveLength(1);
    expect(h.executor.actions[0]?.mode).toBe('reduce');
    expect(h.executor.actions[0]?.side).toBe('SELL');
    expect(h.executor.actions[0]?.requestedQty).toBeCloseTo(20);
  });

  it('в пределах потолка ничего не делает', async () => {
    const h = harness({ maxPositionEnabled: true, maxPositionLeverage: 3 });
    h.openPosition(10, 100);
    await h.risk.settle();
    expect(h.executor.actions).toHaveLength(0);
  });

  it('долив в ПРИБЫЛЬНУЮ позицию тоже контролируется', async () => {
    const h = harness({ maxPositionEnabled: true, maxPositionLeverage: 3 });
    h.openPosition(20, 100); // 2000 — в пределах
    await h.risk.settle();
    expect(h.executor.actions).toHaveLength(0);

    // Цена выросла: долив по лучшей цене усреднением не является, но объём растёт.
    h.market.price = 110;
    const addId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 10, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 10, lastPrice: 110, type: 'MARKET', timeMs: h.clock.now() }));
    h.risk.onFill('BTCUSDT', 'BOTH');
    await h.risk.settle();

    // 30 по 110 = 3300 при потолке 3000 -> срезать примерно 2.727.
    expect(h.executor.actions).toHaveLength(1);
    expect(h.executor.actions[0]?.requestedQty).toBeGreaterThan(2.7);
    expect(h.executor.actions[0]?.requestedQty).toBeLessThan(2.8);
  });

  it('шорт срезается покупкой', async () => {
    const h = harness({ maxPositionEnabled: true, maxPositionLeverage: 3 });
    h.openPosition(50, 100, 'SELL');
    await h.risk.settle();
    expect(h.executor.actions[0]?.side).toBe('BUY');
  });

  it('выключенная настройка ничего не срезает', async () => {
    const h = harness({ maxPositionEnabled: false });
    h.openPosition(50, 100);
    await h.risk.settle();
    expect(h.executor.actions).toHaveLength(0);
  });
});

describe('дефолтный стоп', () => {
  it('выставляется, если через положенное время стопа так и нет', async () => {
    const h = harness({ defaultStopEnabled: true, defaultStopPct: 1, defaultStopDelayMs: 2000 });
    h.openPosition(1, 100);
    await h.risk.settle();
    expect(h.executor.stops).toHaveLength(0); // ещё рано

    await vi.advanceTimersByTimeAsync(2000);
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(1);
    expect(h.executor.stops[0]?.stopPrice).toBeCloseTo(99);
    expect(h.executor.stops[0]?.side).toBe('SELL');
  });

  it('не выставляется, если человек успел поставить свой', async () => {
    const h = harness({ defaultStopEnabled: true, defaultStopDelayMs: 2000 });
    h.openPosition(1, 100);
    h.placeUserStop(98);
    await h.risk.settle();

    await vi.advanceTimersByTimeAsync(2000);
    await h.risk.settle();
    expect(h.executor.stops).toHaveLength(0);
  });

  it('для шорта стоп выше входа', async () => {
    const h = harness({ defaultStopEnabled: true, defaultStopPct: 1, defaultStopDelayMs: 0 });
    h.openPosition(1, 100, 'SELL');
    await vi.advanceTimersByTimeAsync(1);
    await h.risk.settle();
    expect(h.executor.stops[0]?.stopPrice).toBeCloseTo(101);
    expect(h.executor.stops[0]?.side).toBe('BUY');
  });

  it('цена уже за стопом — позиция закрывается по рынку', async () => {
    const h = harness({ defaultStopEnabled: true, defaultStopPct: 1, defaultStopDelayMs: 0 });
    h.openPosition(1, 100);
    h.market.price = 98; // ушли ниже стопа 99
    await vi.advanceTimersByTimeAsync(1);
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(0);
    expect(h.executor.actions).toHaveLength(1);
    expect(h.executor.actions[0]?.mode).toBe('close');
  });

  it('отказ биржи в постановке стопа виден в логе, а не проглатывается', async () => {
    const h = harness({ defaultStopEnabled: true, defaultStopDelayMs: 0 });
    h.executor.placeStop = async () => {
      throw new Error('APIError(code=-1111): Precision is over the maximum');
    };
    h.openPosition(1, 100);
    await vi.advanceTimersByTimeAsync(1);
    await h.risk.settle();

    const errors = h.logs.filter((l) => l.level === 'error');
    expect(errors.some((l) => String(l.meta.error ?? '').includes('-1111'))).toBe(true);
  });

  it('пока ждём момента выставить стоп, не пугаем «риск не ограничен»', async () => {
    const h = harness({ defaultStopEnabled: true, defaultStopDelayMs: 2000 });
    h.openPosition(1, 100);
    await h.risk.settle();
    // Стоп мы поставим сами через две секунды — заявлять сейчас, что риск ничем
    // не ограничен, значит вводить человека в заблуждение.
    expect(h.riskEvents).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2000);
    await h.risk.settle();
    expect(h.executor.stops).toHaveLength(1);
    expect(h.riskEvents.at(-1)?.verdict).not.toBe('no-stop');
  });

  it('каждый исход проверки объясняется в логе', async () => {
    const h = harness({ defaultStopEnabled: true, defaultStopDelayMs: 2000 });
    h.openPosition(1, 100);
    await h.risk.settle();
    expect(h.logs.some((l) => l.msg.includes('жду стоп по новой позиции'))).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    await h.risk.settle();
    expect(h.logs.some((l) => l.msg.includes('стопа нет — ставлю дефолтный'))).toBe(true);
  });

  it('закрытая позиция стопа не получает', async () => {
    const h = harness({ defaultStopEnabled: true, defaultStopDelayMs: 2000 });
    const openId = h.openPosition(1, 100);
    const closeId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: closeId, side: 'SELL', qty: 1, type: 'MARKET', reduceOnly: true, timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: closeId, side: 'SELL', lastQty: 1, lastPrice: 101, type: 'MARKET', reduceOnly: true, timeMs: h.clock.now() }));
    h.risk.onFill('BTCUSDT', 'BOTH');
    expect(openId).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2000);
    await h.risk.settle();
    expect(h.executor.stops).toHaveLength(0);
  });
});

describe('защита стопа от снятия', () => {
  it('снятый вручную стоп возвращается на прежнюю цену', async () => {
    const h = harness({ protectStopOrders: true });
    h.openPosition(1, 100);
    const stopId = h.placeUserStop(98);
    await h.risk.settle();

    h.cancelOrder(stopId, { stopPrice: 98 });
    await vi.advanceTimersByTimeAsync(1000);
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(1);
    expect(h.executor.stops[0]?.stopPrice).toBeCloseTo(98);
  });

  it('сработавший стоп не восстанавливается', async () => {
    const h = harness({ protectStopOrders: true });
    h.openPosition(1, 100);
    const stopId = h.placeUserStop(98);
    await h.risk.settle();

    h.cancelOrder(stopId, { stopPrice: 98, status: 'FILLED' });
    await vi.advanceTimersByTimeAsync(1000);
    await h.risk.settle();
    expect(h.executor.stops).toHaveLength(0);
  });

  it('снятие биржей при закрытии позиции (EXPIRED) восстановления не вызывает', async () => {
    const h = harness({ protectStopOrders: true });
    h.openPosition(1, 100);
    const stopId = h.placeUserStop(98);
    await h.risk.settle();

    h.cancelOrder(stopId, { stopPrice: 98, status: 'EXPIRED' });
    await vi.advanceTimersByTimeAsync(1000);
    await h.risk.settle();
    expect(h.executor.stops).toHaveLength(0);
  });

  it('если позиция уже закрыта, стоп не возвращается', async () => {
    const h = harness({ protectStopOrders: true });
    h.openPosition(1, 100);
    const stopId = h.placeUserStop(98);
    await h.risk.settle();

    const closeId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: closeId, side: 'SELL', qty: 1, type: 'MARKET', reduceOnly: true, timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: closeId, side: 'SELL', lastQty: 1, lastPrice: 101, type: 'MARKET', reduceOnly: true, timeMs: h.clock.now() }));
    h.risk.onFill('BTCUSDT', 'BOTH');
    h.cancelOrder(stopId, { stopPrice: 98 });

    await vi.advanceTimersByTimeAsync(1000);
    await h.risk.settle();
    expect(h.executor.stops).toHaveLength(0);
  });

  it('выключенная настройка стоп не возвращает', async () => {
    const h = harness({ protectStopOrders: false });
    h.openPosition(1, 100);
    const stopId = h.placeUserStop(98);
    await h.risk.settle();
    h.cancelOrder(stopId, { stopPrice: 98 });
    await vi.advanceTimersByTimeAsync(1000);
    await h.risk.settle();
    expect(h.executor.stops).toHaveLength(0);
  });

  it('бесконечная борьба прекращается после лимита возвратов', async () => {
    const h = harness({ protectStopOrders: true });
    h.openPosition(1, 100);

    // Человек снимает стоп, сервис возвращает, человек снимает возвращённый —
    // и так по кругу. Ровно та ситуация, ради которой существует лимит.
    let stopId = h.placeUserStop(98);
    await h.risk.settle();

    for (let i = 0; i < 14; i++) {
      h.cancelOrder(stopId, { stopPrice: 98 });
      await vi.advanceTimersByTimeAsync(1000);
      await h.risk.settle();
      if (h.executor.lastStopOrderId) stopId = h.executor.lastStopOrderId;
    }

    // 10 возвратов в час — дальше сервис сдаётся и пишет об этом в лог.
    expect(h.executor.stops).toHaveLength(10);
    expect(h.logs.some((l) => l.level === 'error' && l.msg.includes('снимают снова'))).toBe(true);
  });
});

describe('жёсткий лимит риска', () => {
  it('слишком дальний стоп подтягивается к пределу, старый снимается', async () => {
    // Депозит 1000, предел 2% = 20 USDT. Позиция 10 по 100.
    // Стоп на 90 даёт риск 100 -> предельная цена 98.
    const h = harness({ maxRiskEnabled: true, maxRiskPct: 2 });
    h.openPosition(10, 100);
    const stopId = h.placeUserStop(90, 'SELL', 10);
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(1);
    expect(h.executor.stops[0]?.stopPrice).toBeCloseTo(98);
    expect(h.executor.cancelledOrderIds).toContain(stopId);
  });

  it('стоп в пределах лимита не трогается', async () => {
    const h = harness({ maxRiskEnabled: true, maxRiskPct: 2 });
    h.openPosition(10, 100);
    h.placeUserStop(99, 'SELL', 10); // риск 10 из 20
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(0);
    expect(h.executor.cancelledOrderIds).toHaveLength(0);
  });

  it('если цена уже за предельным стопом — позиция закрывается по рынку', async () => {
    const h = harness({ maxRiskEnabled: true, maxRiskPct: 2 });
    h.openPosition(10, 100);
    h.market.price = 97; // предельный стоп 98 уже пройден
    h.placeUserStop(90, 'SELL', 10);
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(0);
    expect(h.executor.actions.some((a) => a.mode === 'close')).toBe(true);
  });

  it('выключённый лимит только уведомляет и ничего не меняет', async () => {
    const h = harness({ maxRiskEnabled: false, protectStopOrders: true, maxRiskPct: 2 });
    h.openPosition(10, 100);
    h.placeUserStop(90, 'SELL', 10);
    await h.risk.settle();

    expect(h.executor.stops).toHaveLength(0);
    expect(h.executor.actions).toHaveLength(0);
    expect(h.riskEvents.at(-1)?.verdict).toBe('exceeded');
    expect(h.riskEvents.at(-1)?.text).toContain('выше предела');
  });

  it('уведомление о норме риска приходит при возврате в допустимые пределы', async () => {
    // Плечо заведомо недостижимое: модуль активен, но объём не трогает.
    const h = harness({ maxRiskEnabled: false, maxPositionEnabled: true, maxPositionLeverage: 1000, maxRiskPct: 2 });
    h.openPosition(10, 100);
    const far = h.placeUserStop(90, 'SELL', 10);
    await h.risk.settle();
    expect(h.riskEvents.at(-1)?.verdict).toBe('exceeded');

    // Человек переставил стоп ближе: снял дальний и поставил новый.
    h.cancelOrder(far, { stopPrice: 90 });
    h.placeUserStop(99.5, 'SELL', 10);
    await h.risk.settle();

    expect(h.riskEvents.at(-1)?.verdict).toBe('within');
    expect(h.riskEvents.at(-1)?.text).toContain('норма риска соблюдена');
  });

  it('пока вердикт не изменился, повторных уведомлений нет', async () => {
    const h = harness({ maxRiskEnabled: false, maxPositionEnabled: true, maxPositionLeverage: 1000, maxRiskPct: 2 });
    h.openPosition(10, 100);
    h.placeUserStop(90, 'SELL', 10);
    await h.risk.settle();
    const after = h.riskEvents.length;

    // Из двух стопов берётся самый дальний — он тот же, состояние не поменялось.
    h.placeUserStop(99.5, 'SELL', 10);
    await h.risk.settle();
    expect(h.riskEvents).toHaveLength(after);
  });

  it('позиция без стопа получает отдельный вердикт, а не «превышено»', async () => {
    const h = harness({ maxRiskEnabled: false, protectStopOrders: true });
    h.openPosition(10, 100);
    await h.risk.settle();
    expect(h.riskEvents.at(-1)?.verdict).toBe('no-stop');
    expect(h.riskEvents.at(-1)?.text).toContain('не ограничен');
  });

  it('одно и то же состояние не уведомляет дважды', async () => {
    const h = harness({ maxRiskEnabled: false, protectStopOrders: true });
    h.openPosition(10, 100);
    await h.risk.settle();
    h.risk.onFill('BTCUSDT', 'BOTH');
    await h.risk.settle();
    h.risk.onFill('BTCUSDT', 'BOTH');
    await h.risk.settle();
    expect(h.riskEvents).toHaveLength(1);
  });
});

describe('границы применимости', () => {
  it('позиция, открытая до запуска сервиса, не трогается', async () => {
    const h = harness({ maxPositionEnabled: true, maxPositionLeverage: 3, defaultStopEnabled: true });
    // Позиция появилась из снимка биржи, а не из исполнения: время открытия
    // неизвестно, openedByOrderId пуст.
    h.engine.seedPositions([
      { symbol: 'BTCUSDT', positionSide: 'BOTH', qty: 50, entryPrice: 100, atMs: h.clock.now() },
    ]);
    h.risk.onReconcile();
    await vi.advanceTimersByTimeAsync(5000);
    await h.risk.settle();

    expect(h.executor.actions).toHaveLength(0);
    expect(h.executor.stops).toHaveLength(0);
  });

  it('предохранитель общий с детектором усреднения', async () => {
    const h = harness({ maxPositionEnabled: true, maxPositionLeverage: 3, maxActionsPerHour: 1 });
    h.openPosition(50, 100);
    await h.risk.settle();
    expect(h.executor.actions).toHaveLength(1);

    // Лимит на час исчерпан — второе действие не проходит.
    h.executor.reset();
    h.market.price = 200;
    h.risk.onReconcile();
    await h.risk.settle();
    expect(h.executor.actions).toHaveLength(0);
  });

  it('перезапуск сохраняет позицию под правилами риска', async () => {
    const first = harness({ maxPositionEnabled: true, maxPositionLeverage: 1000 });
    first.openPosition(1, 100);
    await first.risk.settle();
    const carried = first.risk.ownPositionsSnapshot();
    expect(carried).toHaveLength(1);

    // Новый экземпляр: позиция пришла снимком биржи, openedByOrderId пуст —
    // сама по себе она «чужая».
    const second = harness({ defaultStopEnabled: true, defaultStopPct: 1, defaultStopDelayMs: 0 });
    const openedAtMs = carried[0]!.openedAtMs;
    second.engine.seedPositions(
      [{ symbol: 'BTCUSDT', positionSide: 'BOTH', qty: 1, entryPrice: 100, atMs: second.clock.now() }],
      new Map([['BTCUSDT|BOTH', openedAtMs]]),
    );
    second.risk.seedOwnPositions(carried);
    second.risk.onReconcile();
    await vi.advanceTimersByTimeAsync(1);
    await second.risk.settle();

    // Новая настройка подействовала на позицию, открытую до перезапуска.
    expect(second.executor.stops).toHaveLength(1);
    expect(second.executor.stops[0]?.stopPrice).toBeCloseTo(99);
  });

  it('переоткрытая позиция под правила не возвращается', async () => {
    const h = harness({ maxPositionEnabled: true, maxPositionLeverage: 3, defaultStopEnabled: true });
    // Тот же символ, но открыт заметно позже, чем помнил прошлый запуск.
    h.engine.seedPositions(
      [{ symbol: 'BTCUSDT', positionSide: 'BOTH', qty: 50, entryPrice: 100, atMs: h.clock.now() }],
      new Map([['BTCUSDT|BOTH', h.clock.now()]]),
    );
    h.risk.seedOwnPositions([{ key: 'BTCUSDT|BOTH', openedAtMs: h.clock.now() - 3600_000 }]);
    h.risk.onReconcile();
    await vi.advanceTimersByTimeAsync(5000);
    await h.risk.settle();

    expect(h.executor.actions).toHaveLength(0);
    expect(h.executor.stops).toHaveLength(0);
  });

  it('при выключенных правилах модуль не активен', () => {
    const h = harness();
    expect(h.risk.active).toBe(false);
  });
});

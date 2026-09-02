/**
 * Защита от FOMO: счёт серии коротких стоп-аутов и блокировка торговли.
 *
 * Нижний слой (FomoDetector) проверяется голой арифметикой, верхний — связкой
 * «событие биржи -> модель позиции -> действие», с настоящими Engine,
 * PositionStore и OrderRegistry: заглушены только сеть и часы.
 */
import { describe, expect, it } from 'vitest';
import { testConfig, type Config } from '../src/config.js';
import { Engine } from '../src/core/engine.js';
import { ActionLimiter } from '../src/core/actionLimiter.js';
import { FomoDetector, type ClosedTrade } from '../src/core/fomo.js';
import { FomoGuard, type FomoExecutor, type FomoTriggerInfo } from '../src/core/fomoGuard.js';
import type { ExecutionOutcome } from '../src/core/engine.js';
import { toFillEvent, toOrderLifecycleEvent } from '../src/binance/mappers.js';
import type { OrderLifecycleEvent, ProtectiveAction } from '../src/types.js';
import { FakeClock, fillEvent, newOrderEvent, nextOrderId, recordingLogger } from './helpers.js';
import type { RawOrderTradeUpdate } from '../src/binance/mappers.js';

/* ======================= Чистый детектор ======================= */

const PARAMS = { windowMs: 30_000, count: 3, maxTradeDurationMs: 5000 };

function trade(overrides: Partial<ClosedTrade> & { closedAtMs: number }): ClosedTrade {
  return {
    symbol: 'BTCUSDT',
    positionSide: 'BOTH',
    durationMs: 2000,
    byStop: true,
    ...overrides,
  };
}

describe('FomoDetector', () => {
  it('три коротких стоп-аута подряд в окне дают срабатывание', () => {
    const d = new FomoDetector(PARAMS);
    expect(d.record(trade({ closedAtMs: 1000 })).triggered).toBe(false);
    expect(d.record(trade({ closedAtMs: 6000 })).triggered).toBe(false);
    const last = d.record(trade({ closedAtMs: 11_000 }));
    expect(last.triggered).toBe(true);
    expect(last.trades).toHaveLength(3);
  });

  it('после срабатывания серия обнуляется — второй залп подряд не летит', () => {
    const d = new FomoDetector(PARAMS);
    d.record(trade({ closedAtMs: 1000 }));
    d.record(trade({ closedAtMs: 2000 }));
    expect(d.record(trade({ closedAtMs: 3000 })).triggered).toBe(true);
    expect(d.record(trade({ closedAtMs: 4000 })).triggered).toBe(false);
    expect(d.current()).toBe(1);
  });

  it('сделка длиннее предела серию обнуляет', () => {
    const d = new FomoDetector(PARAMS);
    d.record(trade({ closedAtMs: 1000 }));
    d.record(trade({ closedAtMs: 2000 }));
    d.record(trade({ closedAtMs: 3000, durationMs: 20_000 }));
    expect(d.current()).toBe(0);
    expect(d.record(trade({ closedAtMs: 4000 })).triggered).toBe(false);
  });

  it('закрытие не по стопу серию обнуляет', () => {
    const d = new FomoDetector(PARAMS);
    d.record(trade({ closedAtMs: 1000 }));
    d.record(trade({ closedAtMs: 2000 }));
    d.record(trade({ closedAtMs: 2500, byStop: false }));
    expect(d.current()).toBe(0);
  });

  it('сделки, вышедшие за окно, из серии выпадают', () => {
    const d = new FomoDetector(PARAMS);
    d.record(trade({ closedAtMs: 0 }));
    d.record(trade({ closedAtMs: 1000 }));
    // Третья — через минуту: первые две уже не в окне, срабатывания нет.
    const res = d.record(trade({ closedAtMs: 60_000 }));
    expect(res.triggered).toBe(false);
    expect(res.streak).toBe(1);
  });

  it('неизвестная длительность сделки в серию не идёт', () => {
    const d = new FomoDetector(PARAMS);
    d.record(trade({ closedAtMs: 1000 }));
    d.record(trade({ closedAtMs: 2000, durationMs: null }));
    expect(d.current()).toBe(0);
  });
});

/* ======================= Связка целиком ======================= */

class FomoExecutorStub implements FomoExecutor {
  readonly actions: ProtectiveAction[] = [];
  readonly cancelledOrderIds: number[] = [];
  executeResult: ExecutionOutcome = { executed: true, orderId: 1 };

  async execute(action: ProtectiveAction): Promise<ExecutionOutcome> {
    this.actions.push(action);
    return { ...this.executeResult, sentQty: action.requestedQty };
  }

  async cancelOrder(_symbol: string, orderId: number): Promise<{ cancelled: boolean }> {
    this.cancelledOrderIds.push(orderId);
    return { cancelled: true };
  }
}

function harness(overrides: Partial<Config> = {}) {
  const clock = new FakeClock();
  const executor = new FomoExecutorStub();
  const { logger, lines } = recordingLogger();
  const cfg = testConfig({ dryRun: false, aggregationWindowMs: 60_000, cooldownMs: 0, ...overrides });
  const limiter = new ActionLimiter(cfg.maxActionsPerHour);

  let fomo: FomoGuard;
  const engine = new Engine({
    cfg,
    executor: { execute: (a) => executor.execute(a), cancelOrder: (s, o) => executor.cancelOrder(s, o) },
    limiter,
    now: clock.now,
    logger,
    onPositionClosed: (info) => fomo.onPositionClosed(info),
  });

  const triggers: FomoTriggerInfo[] = [];
  fomo = new FomoGuard({
    cfg,
    executor,
    limiter,
    positions: engine.positions,
    orders: engine.orders,
    // Тот же критерий, что и в RiskGuard: позиция «наша», если сервис видел,
    // каким ордером она открылась.
    isOwnPosition: (s, ps) => {
      const p = engine.positions.peek(s, ps);
      return Boolean(p && p.qty !== 0 && p.openedByOrderId !== null);
    },
    now: clock.now,
    logger,
    hooks: { onFomoTriggered: (i) => triggers.push(i) },
  });

  /** Ровно тот порядок вызовов, что в App.handleEvent. */
  function pump(raw: RawOrderTradeUpdate): void {
    clock.set(raw.T);
    const lifecycle: OrderLifecycleEvent = toOrderLifecycleEvent(raw, cfg.clientOrderIdPrefix);
    engine.onOrderEvent(lifecycle);
    if (raw.o.x === 'TRADE') {
      const f = toFillEvent(raw);
      const applied = engine.onFill(f);
      fomo.onFill(f.symbol, f.positionSide, applied.addedQty);
    }
    fomo.onOrderEvent(lifecycle);
  }

  return { cfg, clock, executor, engine, fomo, triggers, logs: lines, pump };
}

/** Открыть позицию и выбить её стопом. Возвращает время закрытия. */
function stopOut(
  h: ReturnType<typeof harness>,
  opts: { openAt: number; closeAt: number; symbol?: string; origType?: 'STOP_MARKET' | 'MARKET' },
): void {
  const symbol = opts.symbol ?? 'BTCUSDT';
  h.pump(
    fillEvent({ symbol, orderId: nextOrderId(), side: 'BUY', lastQty: 1, lastPrice: 100, timeMs: opts.openAt }),
  );
  h.pump(
    fillEvent({
      symbol,
      orderId: nextOrderId(),
      side: 'SELL',
      lastQty: 1,
      lastPrice: 99,
      type: 'MARKET',
      origType: opts.origType ?? 'STOP_MARKET',
      reduceOnly: true,
      timeMs: opts.closeAt,
    }),
  );
}

describe('FomoGuard', () => {
  it('три коротких стоп-аута подряд блокируют торговлю', async () => {
    const h = harness();
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]!.blocking).toBe(true);
    expect(h.fomo.blocked()).toBe(true);
  });

  it('блокировка закрывает открытую позицию и снимает лимитную заявку', async () => {
    const h = harness();
    // Позиция по другому символу и висящая заявка — их блокировка обязана убрать.
    h.pump(
      fillEvent({ symbol: 'ETHUSDT', orderId: nextOrderId(), side: 'BUY', lastQty: 2, lastPrice: 50, timeMs: 500 }),
    );
    const limitId = nextOrderId();
    h.pump(newOrderEvent({ symbol: 'ETHUSDT', orderId: limitId, side: 'BUY', qty: 1, price: 40, timeMs: 600 }));

    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
    await h.fomo.settle();

    expect(h.executor.cancelledOrderIds).toContain(limitId);
    const closes = h.executor.actions.filter((a) => a.mode === 'close');
    expect(closes.map((a) => a.symbol)).toContain('ETHUSDT');
  });

  it('стоп, защищающий позицию, при блокировке не снимается', async () => {
    const h = harness();
    h.pump(
      fillEvent({ symbol: 'ETHUSDT', orderId: nextOrderId(), side: 'BUY', lastQty: 2, lastPrice: 50, timeMs: 500 }),
    );
    const stopId = nextOrderId();
    h.pump(
      newOrderEvent({
        symbol: 'ETHUSDT',
        orderId: stopId,
        side: 'SELL',
        type: 'STOP_MARKET',
        origType: 'STOP_MARKET',
        qty: 2,
        stopPrice: 48,
        closePosition: true,
        timeMs: 600,
      }),
    );

    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
    await h.fomo.settle();

    expect(h.executor.cancelledOrderIds).not.toContain(stopId);
  });

  it('стоп-заявка НА ВХОД (по прорыву) при блокировке снимается', async () => {
    const h = harness();
    // Позиция в лонге, а заявка тоже BUY STOP_MARKET — это вход по прорыву,
    // а не защита. Спутать одно с другим значит оставить открытым вход в рынок.
    h.pump(
      fillEvent({ symbol: 'ETHUSDT', orderId: nextOrderId(), side: 'BUY', lastQty: 2, lastPrice: 50, timeMs: 500 }),
    );
    const breakoutId = nextOrderId();
    h.pump(
      newOrderEvent({
        symbol: 'ETHUSDT',
        orderId: breakoutId,
        side: 'BUY',
        type: 'STOP_MARKET',
        origType: 'STOP_MARKET',
        qty: 2,
        stopPrice: 55,
        timeMs: 600,
      }),
    );

    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
    await h.fomo.settle();

    expect(h.executor.cancelledOrderIds).toContain(breakoutId);
  });

  it('собственные ордера сервиса при блокировке не отменяются', async () => {
    const h = harness();
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
    await h.fomo.settle();
    h.executor.cancelledOrderIds.length = 0;

    const ownId = nextOrderId();
    h.pump(
      newOrderEvent({
        symbol: 'SOLUSDT',
        orderId: ownId,
        clientOrderId: `${h.cfg.clientOrderIdPrefix}_abc`,
        side: 'SELL',
        type: 'MARKET',
        qty: 1,
        timeMs: 20_000,
      }),
    );
    await h.fomo.settle();

    expect(h.executor.cancelledOrderIds).toHaveLength(0);
  });

  it('во время блокировки новая позиция закрывается по рынку', async () => {
    const h = harness();
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
    await h.fomo.settle();
    h.executor.actions.length = 0;

    h.pump(
      fillEvent({ symbol: 'SOLUSDT', orderId: nextOrderId(), side: 'BUY', lastQty: 3, lastPrice: 20, timeMs: 20_000 }),
    );
    await h.fomo.settle();

    expect(h.executor.actions).toHaveLength(1);
    expect(h.executor.actions[0]).toMatchObject({ symbol: 'SOLUSDT', mode: 'close', side: 'SELL' });
  });

  it('во время блокировки новая заявка снимается', async () => {
    const h = harness();
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
    await h.fomo.settle();
    h.executor.cancelledOrderIds.length = 0;

    const id = nextOrderId();
    h.pump(newOrderEvent({ symbol: 'SOLUSDT', orderId: id, side: 'BUY', qty: 1, price: 15, timeMs: 20_000 }));
    await h.fomo.settle();

    expect(h.executor.cancelledOrderIds).toEqual([id]);
  });

  /** Позиция, открытая ДО запуска сервиса: время открытия неизвестно, ордер тоже. */
  function seedForeignPosition(h: ReturnType<typeof harness>, symbol: string, qty: number): void {
    h.engine.seedPositions([{ symbol, positionSide: 'BOTH', qty, entryPrice: 50, atMs: 100 }]);
    const p = h.engine.positions.peek(symbol, 'BOTH');
    expect(p?.openedByOrderId).toBeNull();
  }

  function triggerBlock(h: ReturnType<typeof harness>): void {
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
  }

  it('позицию вне правил блокировка НЕ закрывает', async () => {
    const h = harness();
    seedForeignPosition(h, 'ETHUSDT', 2);
    triggerBlock(h);
    await h.fomo.settle();

    expect(h.fomo.blocked()).toBe(true);
    expect(h.executor.actions.map((a) => a.symbol)).not.toContain('ETHUSDT');
    expect(h.engine.positions.peek('ETHUSDT', 'BOTH')?.qty).toBe(2);
  });

  it('долив в позицию вне правил во время блокировки срезается', async () => {
    const h = harness();
    seedForeignPosition(h, 'ETHUSDT', 2);
    triggerBlock(h);
    await h.fomo.settle();
    h.executor.actions.length = 0;

    h.pump(
      fillEvent({ symbol: 'ETHUSDT', orderId: nextOrderId(), side: 'BUY', lastQty: 3, lastPrice: 49, timeMs: 20_000 }),
    );
    await h.fomo.settle();

    expect(h.executor.actions).toHaveLength(1);
    // Срезается ровно добавленное, а не вся позиция: она остаётся «не нашей».
    expect(h.executor.actions[0]).toMatchObject({ symbol: 'ETHUSDT', mode: 'reduce', requestedQty: 3 });
  });

  it('выход из позиции вне правил лимиткой блокировка не отменяет', async () => {
    const h = harness();
    seedForeignPosition(h, 'ETHUSDT', 2);
    // Обычная лимитка на продажу без reduceOnly — так человек закрывает лонг.
    const exitId = nextOrderId();
    h.pump(newOrderEvent({ symbol: 'ETHUSDT', orderId: exitId, side: 'SELL', qty: 2, price: 60, timeMs: 500 }));
    // А это вход: доливка снизу.
    const entryId = nextOrderId();
    h.pump(newOrderEvent({ symbol: 'ETHUSDT', orderId: entryId, side: 'BUY', qty: 2, price: 45, timeMs: 500 }));

    triggerBlock(h);
    await h.fomo.settle();

    expect(h.executor.cancelledOrderIds).not.toContain(exitId);
    expect(h.executor.cancelledOrderIds).toContain(entryId);
  });

  it('блокировка кончается сама', async () => {
    const h = harness({ fomoBlockMs: 60_000 });
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
    await h.fomo.settle();
    expect(h.fomo.blocked()).toBe(true);

    h.clock.advance(61_000);
    expect(h.fomo.blocked()).toBe(false);
  });

  it('режим notify сигнализирует, но счёт не трогает', async () => {
    const h = harness({ fomoMode: 'notify' });
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]!.blocking).toBe(false);
    expect(h.fomo.blocked()).toBe(false);
    expect(h.executor.actions).toHaveLength(0);
    expect(h.executor.cancelledOrderIds).toHaveLength(0);
  });

  it('выключенная защита не считает вообще ничего', async () => {
    const h = harness({ fomoMode: 'off' });
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(0);
    expect(h.fomo.blocked()).toBe(false);
  });

  it('длинная сделка между стопами обнуляет серию', async () => {
    const h = harness();
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    // Эта прожила 20 секунд — под правило не подходит.
    stopOut(h, { openAt: 9_000, closeAt: 29_000 });
    stopOut(h, { openAt: 30_000, closeAt: 32_000 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(0);
  });

  it('закрытие руками серию обнуляет', async () => {
    const h = harness();
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000, origType: 'MARKET' });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(0);
  });

  it('сработавший алго-стоп опознаётся, даже если исполнение пришло как MARKET', async () => {
    const h = harness();
    // Так это выглядит после переезда условных ордеров в Algo Order API:
    // ALGO_UPDATE со статусом TRIGGERED, а исполнение — по обычному ордеру.
    const triggered = (symbol: string, atMs: number): OrderLifecycleEvent => ({
      eventTimeMs: atMs,
      transactionTimeMs: atMs,
      executionType: 'TRIGGERED',
      orderStatus: 'TRIGGERED',
      order: {
        orderId: nextOrderId(),
        clientOrderId: 'x',
        symbol,
        side: 'SELL',
        positionSide: 'BOTH',
        type: 'STOP_MARKET',
        origType: 'STOP_MARKET',
        placedAtMs: atMs - 1000,
        origQty: 0,
        executedQty: 0,
        price: 0,
        stopPrice: 99,
        reduceOnly: false,
        closePosition: true,
        own: false,
        algo: true,
      },
    });

    for (const [openAt, closeAt] of [
      [1_000, 3_000],
      [5_000, 8_000],
      [10_000, 12_000],
    ]) {
      h.pump(
        fillEvent({ orderId: nextOrderId(), side: 'BUY', lastQty: 1, lastPrice: 100, timeMs: openAt! }),
      );
      h.clock.set(closeAt! - 100);
      h.fomo.onOrderEvent(triggered('BTCUSDT', closeAt! - 100));
      h.pump(
        fillEvent({
          orderId: nextOrderId(),
          side: 'SELL',
          lastQty: 1,
          lastPrice: 99,
          type: 'MARKET',
          origType: 'MARKET',
          reduceOnly: true,
          timeMs: closeAt!,
        }),
      );
    }
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(1);
    expect(h.fomo.blocked()).toBe(true);
  });
});

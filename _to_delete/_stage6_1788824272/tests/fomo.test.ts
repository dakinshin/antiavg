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

/**
 * Признаки проверяются по отдельности: в PARAMS живёт только серия, в BURST —
 * только пачка. Иначе тест на один признак незаметно проверял бы второй.
 */
const PARAMS = {
  windowMs: 30_000,
  count: 3,
  maxTradeDurationMs: 5000,
  minLossPct: 0.05,
  burstWindowMs: 60_000,
  burstCount: 0,
  burstRetentionMs: 360_000,
};
const BURST = { ...PARAMS, count: 0, burstCount: 3 };

function trade(overrides: Partial<ClosedTrade> & { closedAtMs: number }): ClosedTrade {
  const base = {
    symbol: 'BTCUSDT',
    positionSide: 'BOTH' as const,
    durationMs: 2000,
    byStop: true,
    // Номинал 1000, убыток 5 — это 0.5%, заметно выше порога безубытка.
    pnl: -5,
    notional: 1000,
    ...overrides,
  };
  return {
    ...base,
    // Время открытия по умолчанию выводим из длительности, чтобы не задавать
    // его в каждом тесте руками; явное значение в overrides сильнее.
    openedAtMs:
      overrides.openedAtMs !== undefined
        ? overrides.openedAtMs
        : base.durationMs === null
          ? null
          : base.closedAtMs - base.durationMs,
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

  it('прибыльное закрытие по трейлингу серию обнуляет', () => {
    const d = new FomoDetector(PARAMS);
    d.record(trade({ closedAtMs: 1000 }));
    d.record(trade({ closedAtMs: 2000 }));
    // Трейлинг увёл стоп в плюс — это дисциплина, а не FOMO.
    d.record(trade({ closedAtMs: 2500, pnl: 12 }));
    expect(d.current()).toBe(0);
  });

  it('стоп в безубытке в серию не идёт', () => {
    const d = new FomoDetector(PARAMS);
    d.record(trade({ closedAtMs: 1000 }));
    d.record(trade({ closedAtMs: 2000 }));
    // Порог — 0.05% от 1000, то есть 0.5. Минус 0.2 это проскальзывание
    // на стопе, переставленном в безубыток, а не убыточная сделка.
    d.record(trade({ closedAtMs: 2500, pnl: -0.2 }));
    expect(d.current()).toBe(0);
  });

  it('ровно нулевой результат убытком не считается', () => {
    const d = new FomoDetector(PARAMS);
    expect(d.record(trade({ closedAtMs: 1000, pnl: 0 })).streak).toBe(0);
  });

  it('с нулевым порогом убытком считается любой минус', () => {
    const d = new FomoDetector({ ...PARAMS, minLossPct: 0 });
    d.record(trade({ closedAtMs: 1000, pnl: -0.01 }));
    d.record(trade({ closedAtMs: 2000, pnl: -0.01 }));
    expect(d.record(trade({ closedAtMs: 3000, pnl: -0.01 })).triggered).toBe(true);
  });

  it('неизвестная длительность сделки в серию не идёт', () => {
    const d = new FomoDetector(PARAMS);
    d.record(trade({ closedAtMs: 1000 }));
    d.record(trade({ closedAtMs: 2000, durationMs: null }));
    expect(d.current()).toBe(0);
  });
});

/* ============ Признак 2: пачка убыточных входов ============ */

/** Сделка, открытая в `openedAtMs` и закрытая через `heldMs`. */
function entry(openedAtMs: number, over: Partial<ClosedTrade> = {}): ClosedTrade {
  const held = over.durationMs ?? 3000;
  return trade({ openedAtMs, closedAtMs: openedAtMs + held, durationMs: held, ...over });
}

describe('FomoDetector: пачка убыточных входов', () => {
  it('три убыточные сделки, открытые за минуту, дают срабатывание', () => {
    const d = new FomoDetector(BURST);
    expect(d.record(entry(0)).triggered).toBe(false);
    expect(d.record(entry(20_000)).triggered).toBe(false);
    const last = d.record(entry(50_000));
    expect(last.triggered).toBe(true);
    expect(last.reason).toBe('burst');
    expect(last.trades).toHaveLength(3);
  });

  it('длительность сделки значения не имеет', () => {
    const d = new FomoDetector(BURST);
    // Каждая висела по часу — для серии это дисквалификация, для пачки нет.
    d.record(entry(0, { durationMs: 3_600_000 }));
    d.record(entry(20_000, { durationMs: 3_600_000 }));
    expect(d.record(entry(40_000, { durationMs: 3_600_000 })).triggered).toBe(true);
  });

  it('закрытие не по стопу тоже считается', () => {
    const d = new FomoDetector(BURST);
    d.record(entry(0, { byStop: false }));
    d.record(entry(10_000, { byStop: false }));
    expect(d.record(entry(20_000, { byStop: false })).triggered).toBe(true);
  });

  it('прибыльная сделка между убыточными пачку НЕ обнуляет', () => {
    const d = new FomoDetector(BURST);
    d.record(entry(0));
    d.record(entry(10_000, { pnl: 50 })); // в плюс — просто не считается
    d.record(entry(20_000));
    expect(d.record(entry(30_000)).triggered).toBe(true);
  });

  it('входы, растянутые шире окна, пачкой не считаются', () => {
    const d = new FomoDetector(BURST);
    d.record(entry(0));
    d.record(entry(40_000));
    // Третий вход через полторы минуты после первого: втроём в минуту не лезут.
    expect(d.record(entry(90_000)).triggered).toBe(false);
  });

  it('окно скользит: поздняя тройка срабатывает без первой сделки', () => {
    const d = new FomoDetector(BURST);
    d.record(entry(0));
    d.record(entry(80_000));
    d.record(entry(100_000));
    const last = d.record(entry(120_000));
    expect(last.triggered).toBe(true);
    // Первая сделка в пачку не входит — она открыта двумя минутами раньше.
    expect(last.trades.map((t) => t.openedAtMs)).toEqual([80_000, 100_000, 120_000]);
  });

  it('безубыточные сделки в пачку не идут', () => {
    const d = new FomoDetector(BURST);
    d.record(entry(0, { pnl: -0.1 })); // 0.01% номинала — это безубыток
    d.record(entry(10_000, { pnl: -0.1 }));
    expect(d.record(entry(20_000, { pnl: -0.1 })).triggered).toBe(false);
  });

  it('давно закрытая пачка не выстреливает задним числом', () => {
    const d = new FomoDetector({ ...BURST, burstRetentionMs: 120_000 });
    d.record(entry(0));
    d.record(entry(10_000));
    // Третья открылась в том же окне, но провисела час: к её закрытию первые
    // две уже забыты, и блокировать сейчас было бы поздно и бессмысленно.
    expect(d.record(entry(20_000, { durationMs: 3_600_000 })).triggered).toBe(false);
  });

  it('после срабатывания пачка обнуляется', () => {
    const d = new FomoDetector(BURST);
    d.record(entry(0));
    d.record(entry(10_000));
    expect(d.record(entry(20_000)).triggered).toBe(true);
    expect(d.record(entry(30_000)).triggered).toBe(false);
    expect(d.currentBurst()).toBe(1);
  });

  it('нулевой счётчик выключает признак', () => {
    const d = new FomoDetector({ ...BURST, burstCount: 0 });
    d.record(entry(0));
    d.record(entry(10_000));
    expect(d.record(entry(20_000)).triggered).toBe(false);
  });

  it('серия и пачка работают вместе, докладывается серия', () => {
    const d = new FomoDetector({ ...PARAMS, burstCount: 3 });
    d.record(entry(0, { durationMs: 2000 }));
    d.record(entry(5_000, { durationMs: 2000 }));
    const last = d.record(entry(10_000, { durationMs: 2000 }));
    expect(last.triggered).toBe(true);
    expect(last.reason).toBe('streak');
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
  opts: {
    openAt: number;
    closeAt: number;
    symbol?: string;
    origType?: 'STOP_MARKET' | 'MARKET';
    /** Цена выхода. По умолчанию 99 при входе по 100 — убыток 1%. */
    closePrice?: number;
  },
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
      lastPrice: opts.closePrice ?? 99,
      type: 'MARKET',
      origType: opts.origType ?? 'STOP_MARKET',
      reduceOnly: true,
      timeMs: opts.closeAt,
    }),
  );
}

describe('FomoGuard: пачка убыточных входов', () => {
  /** Серия выключена: проверяем именно второй признак. */
  const burstHarness = () => harness({ fomoStopLossCount: 0 });

  it('три убыточные сделки, открытые за минуту, блокируют торговлю', async () => {
    const h = burstHarness();
    // Каждая держалась по 20 секунд — под серию не подходит ни одна.
    stopOut(h, { openAt: 1_000, closeAt: 21_000 });
    stopOut(h, { openAt: 25_000, closeAt: 45_000 });
    stopOut(h, { openAt: 50_000, closeAt: 70_000 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]!.reason).toBe('burst');
    expect(h.fomo.blocked()).toBe(true);
  });

  it('закрытые руками в убыток считаются наравне со стопами', async () => {
    const h = burstHarness();
    stopOut(h, { openAt: 1_000, closeAt: 21_000, origType: 'MARKET' });
    stopOut(h, { openAt: 25_000, closeAt: 45_000, origType: 'MARKET' });
    stopOut(h, { openAt: 50_000, closeAt: 70_000, origType: 'MARKET' });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]!.reason).toBe('burst');
  });

  it('прибыльная сделка посередине пачку не обнуляет', async () => {
    const h = burstHarness();
    stopOut(h, { openAt: 1_000, closeAt: 5_000 });
    stopOut(h, { openAt: 10_000, closeAt: 15_000, closePrice: 105 }); // в плюс
    stopOut(h, { openAt: 20_000, closeAt: 25_000 });
    stopOut(h, { openAt: 30_000, closeAt: 35_000 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(1);
  });

  it('входы, разнесённые шире минуты, пачкой не считаются', async () => {
    const h = burstHarness();
    stopOut(h, { openAt: 0, closeAt: 5_000 });
    stopOut(h, { openAt: 45_000, closeAt: 50_000 });
    stopOut(h, { openAt: 95_000, closeAt: 100_000 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(0);
  });

  it('во время блокировки собственные закрытия не накручивают новую', async () => {
    // Позиция вне правил остаётся открытой, а её долив мы срезаем; вместе с
    // закрытиями своих позиций это могло бы само по себе набрать новую пачку.
    const h = burstHarness();
    stopOut(h, { openAt: 1_000, closeAt: 21_000 });
    stopOut(h, { openAt: 25_000, closeAt: 45_000 });
    stopOut(h, { openAt: 50_000, closeAt: 70_000 });
    await h.fomo.settle();
    expect(h.triggers).toHaveLength(1);

    // Ещё три убыточных закрытия внутри блокировки.
    stopOut(h, { openAt: 71_000, closeAt: 72_000 });
    stopOut(h, { openAt: 73_000, closeAt: 74_000 });
    stopOut(h, { openAt: 75_000, closeAt: 76_000 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(1);
  });
});

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
    // Признак «пачка» здесь выключен: он на эти же сделки срабатывает
    // законно, и проверять надо именно поведение серии.
    const h = harness({ fomoBurstCount: 0 });
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    // Эта прожила 20 секунд — под правило не подходит.
    stopOut(h, { openAt: 9_000, closeAt: 29_000 });
    stopOut(h, { openAt: 30_000, closeAt: 32_000 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(0);
  });

  it('стопы в безубыток защиту не включают', async () => {
    const h = harness();
    // Стоп переставлен в безубыток и сработал ровно на цене входа.
    stopOut(h, { openAt: 1_000, closeAt: 3_000, closePrice: 100 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000, closePrice: 100 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000, closePrice: 100 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(0);
    expect(h.fomo.blocked()).toBe(false);
  });

  it('прибыльный выход по трейлингу защиту не включает', async () => {
    const h = harness();
    stopOut(h, { openAt: 1_000, closeAt: 3_000, closePrice: 103 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000, closePrice: 102 });
    stopOut(h, { openAt: 10_000, closeAt: 12_000, closePrice: 101 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(0);
  });

  it('безубыточная сделка между стопами серию обнуляет', async () => {
    // Признак «пачка» здесь выключен: он на эти же сделки срабатывает
    // законно, и проверять надо именно поведение серии.
    const h = harness({ fomoBurstCount: 0 });
    stopOut(h, { openAt: 1_000, closeAt: 3_000 });
    stopOut(h, { openAt: 5_000, closeAt: 8_000 });
    stopOut(h, { openAt: 9_000, closeAt: 11_000, closePrice: 100 });
    stopOut(h, { openAt: 12_000, closeAt: 14_000 });
    await h.fomo.settle();

    expect(h.triggers).toHaveLength(0);
  });

  it('закрытие руками серию обнуляет', async () => {
    // Признак «пачка» здесь выключен: он на эти же сделки срабатывает
    // законно, и проверять надо именно поведение серии.
    const h = harness({ fomoBurstCount: 0 });
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

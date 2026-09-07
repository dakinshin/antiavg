/**
 * Профилактика: снятие ещё не исполненных ордеров, которые при срабатывании
 * стали бы усреднением в убытке. Дешевле реакции постфактум — нет рыночного
 * ордера, проскальзывания и зафиксированного убытка.
 */
import { describe, expect, it } from 'vitest';
import { analyzePendingOrder, pendingOrderPrice } from '../src/core/detector.js';
import { testConfig } from '../src/config.js';
import type { OrderRecord } from '../src/types.js';
import { feed, fillEvent, makeHarness, newOrderEvent, nextOrderId } from './helpers.js';

const SYM = 'BTCUSDT';

function order(over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    orderId: 1,
    clientOrderId: 'web_1',
    symbol: SYM,
    side: 'BUY',
    positionSide: 'BOTH',
    type: 'LIMIT',
    origType: 'LIMIT',
    placedAtMs: 10_000,
    origQty: 1,
    executedQty: 0,
    price: 45000,
    stopPrice: 0,
    reduceOnly: false,
    closePosition: false,
    own: false,
    ...over,
  };
}

const longPos = { qty: 1, entryPrice: 50000, openedAtMs: 5000, openTimeKnown: true };
const shortPos = { qty: -1, entryPrice: 50000, openedAtMs: 5000, openTimeKnown: true };

describe('цена срабатывания ордера', () => {
  it('лимитка — своя цена', () => {
    expect(pendingOrderPrice(order({ price: 123 }))).toBe(123);
  });
  it('стоп-маркет — цена срабатывания', () => {
    expect(pendingOrderPrice(order({ origType: 'STOP_MARKET', price: 0, stopPrice: 99 }))).toBe(99);
  });
  it('стоп-лимит — лимитная цена, а не триггер', () => {
    expect(pendingOrderPrice(order({ origType: 'STOP', price: 90, stopPrice: 95 }))).toBe(90);
  });
  it('трейлинг-стоп не оценивается — цена заранее неизвестна', () => {
    expect(pendingOrderPrice(order({ origType: 'TRAILING_STOP_MARKET' }))).toBeNull();
  });
});

describe('какие заявки признаются опасными', () => {
  const cfg = testConfig();

  it('лимитка на покупку ниже средней входа в лонге — опасна', () => {
    const v = analyzePendingOrder(cfg, order({ price: 45000, placedAtMs: 20_000 }), longPos);
    expect(v.dangerous).toBe(true);
    expect(v.adverseDeviationPct).toBeCloseTo(10);
  });

  it('лимитка на покупку ВЫШЕ входа — это добор в прибыли, не трогаем', () => {
    const v = analyzePendingOrder(cfg, order({ price: 55000, placedAtMs: 20_000 }), longPos);
    expect(v.dangerous).toBe(false);
    expect(v.reason).toBe('not-in-loss');
  });

  it('в шорте опасна продажа ВЫШЕ входа', () => {
    const v = analyzePendingOrder(cfg, order({ side: 'SELL', price: 55000, placedAtMs: 20_000 }), shortPos);
    expect(v.dangerous).toBe(true);
  });

  it('в шорте продажа ниже входа — добор в прибыли', () => {
    const v = analyzePendingOrder(cfg, order({ side: 'SELL', price: 45000, placedAtMs: 20_000 }), shortPos);
    expect(v.dangerous).toBe(false);
  });

  it('стоп-маркет на пробой вверх в лонге не опасен', () => {
    const v = analyzePendingOrder(
      cfg,
      order({ origType: 'STOP_MARKET', price: 0, stopPrice: 56000, placedAtMs: 20_000 }),
      longPos,
    );
    expect(v.dangerous).toBe(false);
  });

  it('стоп-маркет на покупку НИЖЕ входа в лонге опасен', () => {
    const v = analyzePendingOrder(
      cfg,
      order({ origType: 'STOP_MARKET', price: 0, stopPrice: 44000, placedAtMs: 20_000 }),
      longPos,
    );
    expect(v.dangerous).toBe(true);
  });

  it('reduceOnly и closePosition позицию увеличить не могут', () => {
    expect(analyzePendingOrder(cfg, order({ reduceOnly: true, placedAtMs: 20_000 }), longPos).reason).toBe('reduce-only');
    expect(analyzePendingOrder(cfg, order({ closePosition: true, placedAtMs: 20_000 }), longPos).reason).toBe('reduce-only');
  });

  it('продажа при лонге позицию не увеличивает', () => {
    const v = analyzePendingOrder(cfg, order({ side: 'SELL', price: 45000, placedAtMs: 20_000 }), longPos);
    expect(v.reason).toBe('not-an-increase');
  });

  it('без позиции ордер только открывает её — не усреднение', () => {
    const v = analyzePendingOrder(cfg, order({ placedAtMs: 20_000 }), {
      qty: 0,
      entryPrice: 0,
      openedAtMs: null,
      openTimeKnown: true,
    });
    expect(v.reason).toBe('position-was-flat');
  });

  it('сетка, выставленная ДО открытия позиции, неприкосновенна', () => {
    const v = analyzePendingOrder(cfg, order({ price: 45000, placedAtMs: 1000 }), longPos);
    expect(v.dangerous).toBe(false);
    expect(v.reason).toBe('pre-existing-order');
  });

  it('с countPreexistingOrders=true снимается и сетка', () => {
    const v = analyzePendingOrder(
      testConfig({ countPreexistingOrders: true }),
      order({ price: 45000, placedAtMs: 1000 }),
      longPos,
    );
    expect(v.dangerous).toBe(true);
  });

  it('порог убытка учитывается', () => {
    const v = analyzePendingOrder(
      testConfig({ lossThresholdPct: 25 }),
      order({ price: 45000, placedAtMs: 20_000 }),
      longPos,
    );
    expect(v.reason).toBe('below-loss-threshold');
  });

  it('собственный защитный ордер сервиса не трогаем', () => {
    const v = analyzePendingOrder(cfg, order({ own: true, price: 45000, placedAtMs: 20_000 }), longPos);
    expect(v.reason).toBe('own-order');
  });

  it('при неизвестном времени открытия по умолчанию не трогаем', () => {
    const v = analyzePendingOrder(cfg, order({ price: 45000, placedAtMs: 20_000 }), {
      ...longPos,
      openedAtMs: null,
      openTimeKnown: false,
    });
    expect(v.reason).toBe('unknown-open-time');
  });
});

describe('движок снимает опасные заявки', () => {
  function openLong(h: ReturnType<typeof makeHarness>, qty = 1, price = 50000) {
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, side: 'BUY', qty, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, side: 'BUY', lastQty: qty, lastPrice: price, type: 'MARKET', timeMs: h.clock.now() }));
  }

  it('лимитка на усреднение снимается сразу после размещения', async () => {
    const h = makeHarness();
    openLong(h);
    h.clock.advance(10_000);

    const bad = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: bad, side: 'BUY', qty: 1, price: 45000, timeMs: h.clock.now() }));
    await new Promise((r) => setImmediate(r));

    expect(h.executor.cancelledOrderIds).toContain(bad);
    // Рыночного ордера при этом не было — в том и смысл профилактики.
    expect(h.executor.actions).toHaveLength(0);
  });

  it('безобидная лимитка остаётся на месте', async () => {
    const h = makeHarness();
    openLong(h);
    h.clock.advance(10_000);

    const ok = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: ok, side: 'BUY', qty: 1, price: 55000, timeMs: h.clock.now() }));
    await new Promise((r) => setImmediate(r));

    expect(h.executor.cancelledOrderIds).toHaveLength(0);
  });

  it('ордер становится опасным, когда средняя уезжает вниз', async () => {
    const h = makeHarness();
    openLong(h, 1, 50000);
    h.clock.advance(10_000);

    // Лимитка на 47000 при средней 50000 уже опасна, поэтому берём 40000
    // и сначала опускаем среднюю доливом.
    const later = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: later, side: 'BUY', qty: 1, price: 60000, timeMs: h.clock.now() }));
    await new Promise((r) => setImmediate(r));
    expect(h.executor.cancelledOrderIds).toHaveLength(0);

    // Средняя поднимается доливом по 70000 -> ордер на 60000 становится усредняющим.
    const add = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: add, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: add, side: 'BUY', lastQty: 1, lastPrice: 70000, type: 'MARKET', timeMs: h.clock.now() }));
    await new Promise((r) => setImmediate(r));

    expect(h.engine.positions.get(SYM, 'BOTH').entryPrice).toBe(60000);
    // Цена ордера ровно равна средней — это ещё не убыток.
    expect(h.executor.cancelledOrderIds).toHaveLength(0);

    const add2 = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: add2, side: 'BUY', qty: 2, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: add2, side: 'BUY', lastQty: 2, lastPrice: 90000, type: 'MARKET', timeMs: h.clock.now() }));
    await new Promise((r) => setImmediate(r));

    expect(h.executor.cancelledOrderIds).toContain(later);
  });

  it('один и тот же ордер не снимается дважды', async () => {
    const h = makeHarness();
    openLong(h);
    h.clock.advance(10_000);

    const bad = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: bad, side: 'BUY', qty: 1, price: 45000, timeMs: h.clock.now() }));
    await new Promise((r) => setImmediate(r));
    feed(h.engine, newOrderEvent({ orderId: bad, side: 'BUY', qty: 1, price: 45000, timeMs: h.clock.now() }));
    await new Promise((r) => setImmediate(r));

    expect(h.executor.cancelledOrderIds.filter((id) => id === bad)).toHaveLength(1);
  });

  it('при выключенной настройке ничего не снимается', async () => {
    const h = makeHarness({ cancelDangerousOrders: false });
    openLong(h);
    h.clock.advance(10_000);

    const bad = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: bad, side: 'BUY', qty: 1, price: 45000, timeMs: h.clock.now() }));
    await new Promise((r) => setImmediate(r));

    expect(h.executor.cancelledOrderIds).toHaveLength(0);
  });

  it('сетка, выставленная до входа, не снимается', async () => {
    const h = makeHarness();
    const grid = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: grid, side: 'BUY', qty: 1, price: 45000, timeMs: h.clock.now() }));
    h.clock.advance(5_000);
    openLong(h);
    await new Promise((r) => setImmediate(r));

    expect(h.executor.cancelledOrderIds).toHaveLength(0);
  });
});

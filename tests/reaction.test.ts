import { describe, expect, it } from 'vitest';
import { feed, fillEvent, makeHarness, newOrderEvent, nextOrderId } from './helpers.js';

const SYM = 'BTCUSDT';

async function openLosingLong(h: ReturnType<typeof makeHarness>, qty = 1, price = 50000) {
  const openId = nextOrderId();
  feed(h.engine, newOrderEvent({ orderId: openId, side: 'BUY', qty, type: 'MARKET', timeMs: h.clock.now() }));
  feed(h.engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: qty, lastPrice: price, type: 'MARKET', timeMs: h.clock.now() }));
  h.clock.advance(60_000);
}

describe('режимы реакции', () => {
  it('reduce срезает ровно добавленный объём', async () => {
    const h = makeHarness({ reactionMode: 'reduce' });
    await openLosingLong(h, 1, 50000);

    const addId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 3, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 3, lastPrice: 45000, type: 'MARKET', timeMs: h.clock.now() }));

    await h.engine.flushAll();
    expect(h.executor.last).toMatchObject({ mode: 'reduce', requestedQty: 3, positionQty: 4, side: 'SELL' });
  });

  it('close закрывает позицию целиком', async () => {
    const h = makeHarness({ reactionMode: 'close' });
    await openLosingLong(h, 1, 50000);

    const addId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 0.5, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 0.5, lastPrice: 45000, type: 'MARKET', timeMs: h.clock.now() }));

    await h.engine.flushAll();
    expect(h.executor.last).toMatchObject({ mode: 'close', requestedQty: 1.5, side: 'SELL' });
  });

  it('срезка не превышает текущий размер позиции', async () => {
    const h = makeHarness({ reactionMode: 'reduce' });
    await openLosingLong(h, 1, 50000);

    const addId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 2, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 2, lastPrice: 45000, type: 'MARKET', timeMs: h.clock.now() }));

    // Пользователь успел закрыть часть позиции до срабатывания реакции.
    const cutId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: cutId, side: 'SELL', qty: 2.5, type: 'MARKET', reduceOnly: true, timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: cutId, side: 'SELL', lastQty: 2.5, lastPrice: 46000, type: 'MARKET', reduceOnly: true, timeMs: h.clock.now() }));

    await h.engine.flushAll();
    expect(h.executor.last?.requestedQty).toBeCloseTo(0.5);
  });

  it('если позиция уже закрыта, действие не отправляется', async () => {
    const h = makeHarness({ reactionMode: 'reduce' });
    await openLosingLong(h, 1, 50000);

    const addId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: h.clock.now() }));

    const cutId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: cutId, side: 'SELL', qty: 2, type: 'MARKET', reduceOnly: true, timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: cutId, side: 'SELL', lastQty: 2, lastPrice: 46000, type: 'MARKET', reduceOnly: true, timeMs: h.clock.now() }));

    await h.engine.flushAll();
    expect(h.executor.actions).toHaveLength(0);
  });
});

describe('агрегация частичных исполнений', () => {
  it('несколько частичных исполнений одной лимитки схлопываются в один ордер', async () => {
    const h = makeHarness();
    await openLosingLong(h, 1, 50000);

    const limitId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: limitId, side: 'BUY', qty: 0.9, price: 47000, timeMs: h.clock.now() }));
    h.clock.advance(1000);

    feed(h.engine, fillEvent({ orderId: limitId, side: 'BUY', lastQty: 0.3, lastPrice: 47000, cumQty: 0.3, origQty: 0.9, orderStatus: 'PARTIALLY_FILLED', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: limitId, side: 'BUY', lastQty: 0.3, lastPrice: 47000, cumQty: 0.6, origQty: 0.9, orderStatus: 'PARTIALLY_FILLED', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: limitId, side: 'BUY', lastQty: 0.3, lastPrice: 47000, cumQty: 0.9, origQty: 0.9, orderStatus: 'FILLED', timeMs: h.clock.now() }));

    await h.engine.flushAll();
    expect(h.executor.actions).toHaveLength(1);
    expect(h.executor.last?.requestedQty).toBeCloseTo(0.9);
    expect(h.executor.last?.triggers).toHaveLength(3);
  });
});

describe('cooldown', () => {
  it('второе действие в пределах cooldown пропускается', async () => {
    const h = makeHarness({ cooldownMs: 10_000 });
    await openLosingLong(h, 1, 50000);

    const a = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: a, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: a, side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: h.clock.now() }));
    await h.engine.flushAll();
    expect(h.executor.actions).toHaveLength(1);

    h.clock.advance(1_000);
    const b = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: b, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: b, side: 'BUY', lastQty: 1, lastPrice: 44000, type: 'MARKET', timeMs: h.clock.now() }));
    await h.engine.flushAll();
    expect(h.executor.actions).toHaveLength(1);

    h.clock.advance(20_000);
    const c = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: c, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: c, side: 'BUY', lastQty: 1, lastPrice: 43000, type: 'MARKET', timeMs: h.clock.now() }));
    await h.engine.flushAll();
    expect(h.executor.actions).toHaveLength(2);
  });

  it('неудачное действие не блокирует следующую попытку', async () => {
    const h = makeHarness({ cooldownMs: 10_000 });
    h.executor.outcome = { executed: false, skipped: 'below-min-qty' };
    await openLosingLong(h, 1, 50000);

    const a = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: a, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: a, side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: h.clock.now() }));
    await h.engine.flushAll();

    h.executor.outcome = { executed: true, orderId: 7 };
    h.clock.advance(500);
    const b = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: b, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: b, side: 'BUY', lastQty: 1, lastPrice: 44000, type: 'MARKET', timeMs: h.clock.now() }));
    await h.engine.flushAll();
    expect(h.executor.actions).toHaveLength(2);
  });
});

describe('несколько символов', () => {
  it('позиции разных символов учитываются независимо', async () => {
    const h = makeHarness();

    const btcOpen = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: btcOpen, symbol: 'BTCUSDT', side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: btcOpen, symbol: 'BTCUSDT', side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: h.clock.now() }));

    const ethOpen = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: ethOpen, symbol: 'ETHUSDT', side: 'SELL', qty: 10, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: ethOpen, symbol: 'ETHUSDT', side: 'SELL', lastQty: 10, lastPrice: 3000, type: 'MARKET', timeMs: h.clock.now() }));

    h.clock.advance(60_000);

    // BTC доливаем в убытке, ETH — в прибыли (цена ниже входа шорта).
    const btcAdd = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: btcAdd, symbol: 'BTCUSDT', side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: btcAdd, symbol: 'BTCUSDT', side: 'BUY', lastQty: 1, lastPrice: 47000, type: 'MARKET', timeMs: h.clock.now() }));

    const ethAdd = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: ethAdd, symbol: 'ETHUSDT', side: 'SELL', qty: 5, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: ethAdd, symbol: 'ETHUSDT', side: 'SELL', lastQty: 5, lastPrice: 2900, type: 'MARKET', timeMs: h.clock.now() }));

    await h.engine.flushAll();
    expect(h.executor.actions).toHaveLength(1);
    expect(h.executor.last?.symbol).toBe('BTCUSDT');
    expect(h.engine.positions.get('ETHUSDT', 'BOTH').qty).toBe(-15);
  });

  it('позиции BTCUSDT и BTCUSDC не смешиваются', async () => {
    const h = makeHarness();
    const a = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: a, symbol: 'BTCUSDT', side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: a, symbol: 'BTCUSDT', side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: h.clock.now() }));
    const b = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: b, symbol: 'BTCUSDC', side: 'BUY', qty: 2, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: b, symbol: 'BTCUSDC', side: 'BUY', lastQty: 2, lastPrice: 50000, type: 'MARKET', timeMs: h.clock.now() }));

    expect(h.engine.positions.get('BTCUSDT', 'BOTH').qty).toBe(1);
    expect(h.engine.positions.get('BTCUSDC', 'BOTH').qty).toBe(2);
  });
});

describe('hedge mode', () => {
  it('LONG и SHORT одного символа отслеживаются раздельно', async () => {
    const h = makeHarness();

    const longOpen = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: longOpen, side: 'BUY', positionSide: 'LONG', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: longOpen, side: 'BUY', positionSide: 'LONG', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: h.clock.now() }));

    const shortOpen = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: shortOpen, side: 'SELL', positionSide: 'SHORT', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: shortOpen, side: 'SELL', positionSide: 'SHORT', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: h.clock.now() }));

    expect(h.engine.positions.get(SYM, 'LONG').qty).toBe(1);
    expect(h.engine.positions.get(SYM, 'SHORT').qty).toBe(-1);

    h.clock.advance(60_000);
    // Долив в убыточный LONG.
    const longAdd = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: longAdd, side: 'BUY', positionSide: 'LONG', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    const res = feed(h.engine, fillEvent({ orderId: longAdd, side: 'BUY', positionSide: 'LONG', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: h.clock.now() }));
    expect(res?.detected).toBe(true);

    await h.engine.flushAll();
    expect(h.executor.last).toMatchObject({ positionSide: 'LONG', side: 'SELL', requestedQty: 1 });
    expect(h.engine.positions.get(SYM, 'SHORT').qty).toBe(-1);
  });

  it('покупка на стороне SHORT — это уменьшение, а не усреднение', async () => {
    const h = makeHarness();
    const shortOpen = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: shortOpen, side: 'SELL', positionSide: 'SHORT', qty: 2, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: shortOpen, side: 'SELL', positionSide: 'SHORT', lastQty: 2, lastPrice: 50000, type: 'MARKET', timeMs: h.clock.now() }));

    h.clock.advance(1_000);
    const buyBack = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: buyBack, side: 'BUY', positionSide: 'SHORT', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    const res = feed(h.engine, fillEvent({ orderId: buyBack, side: 'BUY', positionSide: 'SHORT', lastQty: 1, lastPrice: 52000, type: 'MARKET', timeMs: h.clock.now() }));

    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('not-an-increase');
    expect(h.engine.positions.get(SYM, 'SHORT').qty).toBe(-1);
  });
});

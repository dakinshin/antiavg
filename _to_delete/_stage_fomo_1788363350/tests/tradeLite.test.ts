/**
 * TRADE_LITE — облегчённое и более быстрое событие о сделке. В бою обнаружилось,
 * что иногда оно оказывается ЕДИНСТВЕННЫМ сообщением об исполнении, поэтому
 * реагировать нужно и на него, но без двойного счёта.
 */
import { describe, expect, it } from 'vitest';
import { tradeLiteToFillEvent, type RawTradeLite } from '../src/binance/mappers.js';
import type { OrderRecord } from '../src/types.js';
import { feed, fillEvent, makeHarness, newOrderEvent, nextOrderId } from './helpers.js';

const SYM = 'BTCUSDT';

function tradeLite(over: Partial<RawTradeLite> = {}): RawTradeLite {
  return {
    e: 'TRADE_LITE',
    E: 1000,
    T: 1000,
    s: SYM,
    q: '1',
    p: '50000',
    m: false,
    c: 'web_1',
    S: 'BUY',
    L: '50000',
    l: '1',
    t: 555,
    i: 777,
    ...over,
  };
}

function order(over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    orderId: 777,
    clientOrderId: 'web_1',
    symbol: SYM,
    side: 'BUY',
    positionSide: 'LONG',
    type: 'LIMIT',
    origType: 'LIMIT',
    placedAtMs: 500,
    origQty: 1,
    executedQty: 1,
    price: 50000,
    stopPrice: 0,
    reduceOnly: false,
    closePosition: false,
    own: false,
    ...over,
  };
}

describe('преобразование TRADE_LITE', () => {
  it('в one-way режиме без ордера подставляется BOTH', () => {
    const fill = tradeLiteToFillEvent(tradeLite(), undefined, false);
    expect(fill).toMatchObject({ positionSide: 'BOTH', lastFilledQty: 1, lastFilledPrice: 50000, tradeId: 555 });
  });

  it('в hedge режиме без ордера событие пропускается — сторону не угадать', () => {
    expect(tradeLiteToFillEvent(tradeLite(), undefined, true)).toBeUndefined();
  });

  it('в hedge режиме сторона берётся из реестра ордеров', () => {
    const fill = tradeLiteToFillEvent(tradeLite(), order({ positionSide: 'SHORT' }), true);
    expect(fill?.positionSide).toBe('SHORT');
  });

  it('недостающие поля дополняются из ордера', () => {
    const fill = tradeLiteToFillEvent(tradeLite(), order({ reduceOnly: true, origType: 'STOP_MARKET' }), false);
    expect(fill).toMatchObject({ reduceOnly: true, origType: 'STOP_MARKET' });
  });
});

describe('двойной учёт исключён', () => {
  it('повтор той же сделки из ORDER_TRADE_UPDATE не меняет позицию дважды', async () => {
    const h = makeHarness();

    const openId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));

    // Сначала быстрый TRADE_LITE.
    const sharedTradeId = 9001;
    const lite = tradeLiteToFillEvent(
      tradeLite({ i: openId, t: sharedTradeId, l: '1', L: '50000' }),
      h.engine.orders.get(openId),
      false,
    );
    h.engine.onFill(lite!);
    expect(h.engine.positions.get(SYM, 'BOTH').qty).toBe(1);

    // Затем полный ORDER_TRADE_UPDATE о той же сделке.
    feed(
      h.engine,
      fillEvent({
        orderId: openId,
        tradeId: sharedTradeId,
        side: 'BUY',
        lastQty: 1,
        lastPrice: 50000,
        type: 'MARKET',
        timeMs: h.clock.now(),
      }),
    );

    // Позиция не удвоилась.
    expect(h.engine.positions.get(SYM, 'BOTH').qty).toBe(1);
    expect(h.engine.stats().дубликатовСделок).toBeGreaterThan(0);
  });

  it('усреднение ловится по TRADE_LITE, даже если ORDER_TRADE_UPDATE не пришёл', async () => {
    const h = makeHarness();

    const openId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(
      h.engine,
      fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: h.clock.now() }),
    );
    h.clock.advance(60_000);

    const addId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));

    // Полного события не будет — только облегчённое.
    const lite = tradeLiteToFillEvent(
      tradeLite({ i: addId, t: 9002, l: '1', L: '45000', T: h.clock.now(), E: h.clock.now() }),
      h.engine.orders.get(addId),
      false,
    );
    const res = h.engine.onFill(lite!);

    expect(res.detected).toBe(true);
    await h.engine.flushAll();
    expect(h.executor.last).toMatchObject({ side: 'SELL', requestedQty: 1 });
  });

  it('разные сделки одного ордера обрабатываются каждая', async () => {
    const h = makeHarness();
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, side: 'BUY', qty: 3, price: 50000, timeMs: h.clock.now() }));

    for (const t of [1, 2, 3]) {
      const lite = tradeLiteToFillEvent(
        tradeLite({ i: id, t: 7000 + t, l: '1', L: '50000' }),
        h.engine.orders.get(id),
        false,
      );
      h.engine.onFill(lite!);
    }
    expect(h.engine.positions.get(SYM, 'BOTH').qty).toBe(3);
  });

  it('одинаковые tradeId на разных символах не считаются дубликатом', () => {
    const h = makeHarness();
    const a = tradeLiteToFillEvent(tradeLite({ s: 'BTCUSDT', t: 42, i: 1 }), undefined, false);
    const b = tradeLiteToFillEvent(tradeLite({ s: 'ETHUSDT', t: 42, i: 2 }), undefined, false);
    h.engine.onFill(a!);
    h.engine.onFill(b!);
    expect(h.engine.positions.get('BTCUSDT', 'BOTH').qty).toBe(1);
    expect(h.engine.positions.get('ETHUSDT', 'BOTH').qty).toBe(1);
  });
});

describe('дедупликация не мешает нормальной работе', () => {
  it('частичные исполнения одной лимитки имеют разные tradeId и учитываются все', async () => {
    const h = makeHarness();
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, side: 'BUY', qty: 3, price: 50000, timeMs: h.clock.now() }));

    feed(h.engine, fillEvent({ orderId: id, tradeId: 1, side: 'BUY', lastQty: 1, lastPrice: 50000, cumQty: 1, orderStatus: 'PARTIALLY_FILLED', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, tradeId: 2, side: 'BUY', lastQty: 1, lastPrice: 50000, cumQty: 2, orderStatus: 'PARTIALLY_FILLED', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, tradeId: 3, side: 'BUY', lastQty: 1, lastPrice: 50000, cumQty: 3, orderStatus: 'FILLED', timeMs: h.clock.now() }));

    expect(h.engine.positions.get(SYM, 'BOTH').qty).toBe(3);
    expect(h.engine.stats().дубликатовСделок).toBe(0);
  });

  it('исполнение без tradeId обрабатывается, а не отбрасывается', () => {
    const h = makeHarness();
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, tradeId: 0, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: h.clock.now() }));
    expect(h.engine.positions.get(SYM, 'BOTH').qty).toBe(1);
  });
});

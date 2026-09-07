import { describe, expect, it } from 'vitest';
import { accountUpdate, feed, fillEvent, makeHarness, newOrderEvent, nextOrderId } from './helpers.js';

const SYM = 'BTCUSDT';

describe('усреднение в убытке: рыночный долив', () => {
  it('ловит долив по рынку в убыточный лонг и срезает добавленный объём', async () => {
    const { engine, executor, clock } = makeHarness();

    // Вход: 1 BTC @ 50000
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));

    expect(engine.positions.get(SYM, 'BOTH').qty).toBe(1);
    expect(engine.positions.get(SYM, 'BOTH').entryPrice).toBe(50000);

    // Цена упала, докупаем 0.5 по рынку @ 48000
    clock.advance(60_000);
    const avgId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: avgId, side: 'BUY', qty: 0.5, type: 'MARKET', timeMs: clock.now() }));
    const res = feed(engine, fillEvent({ orderId: avgId, side: 'BUY', lastQty: 0.5, lastPrice: 48000, type: 'MARKET', timeMs: clock.now() }));

    expect(res?.detected).toBe(true);
    expect(res?.addedQty).toBeCloseTo(0.5);
    expect(res?.adverseDeviationPct).toBeCloseTo(4);

    await engine.flushAll();
    expect(executor.actions).toHaveLength(1);
    expect(executor.last).toMatchObject({ symbol: SYM, side: 'SELL', mode: 'reduce', requestedQty: 0.5 });
  });

  it('не реагирует, если долив происходит в прибыли', async () => {
    const { engine, executor, clock } = makeHarness();
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));

    clock.advance(60_000);
    const addId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    const res = feed(engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 1, lastPrice: 52000, type: 'MARKET', timeMs: clock.now() }));

    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('not-in-loss');
    await engine.flushAll();
    expect(executor.actions).toHaveLength(0);
  });

  it('ловит усреднение в убыточном шорте и покупает обратно добавку', async () => {
    const { engine, executor, clock } = makeHarness();
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'SELL', qty: 2, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'SELL', lastQty: 2, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));
    expect(engine.positions.get(SYM, 'BOTH').qty).toBe(-2);

    clock.advance(60_000);
    const addId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: addId, side: 'SELL', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    const res = feed(engine, fillEvent({ orderId: addId, side: 'SELL', lastQty: 1, lastPrice: 52000, type: 'MARKET', timeMs: clock.now() }));

    expect(res?.detected).toBe(true);
    expect(res?.adverseDeviationPct).toBeCloseTo(4);
    await engine.flushAll();
    expect(executor.last).toMatchObject({ side: 'BUY', requestedQty: 1 });
  });

  it('не считает усреднением частичное закрытие позиции', async () => {
    const { engine, clock } = makeHarness();
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 2, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 2, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));

    clock.advance(1000);
    const closeId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: closeId, side: 'SELL', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    const res = feed(engine, fillEvent({ orderId: closeId, side: 'SELL', lastQty: 1, lastPrice: 48000, type: 'MARKET', timeMs: clock.now() }));

    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('not-an-increase');
    expect(engine.positions.get(SYM, 'BOTH').qty).toBe(1);
    expect(engine.positions.get(SYM, 'BOTH').entryPrice).toBe(50000);
  });
});

describe('правило «ордер размещён до открытия позиции»', () => {
  it('вход сеткой лимиток: сработавшие лимитки НЕ считаются усреднением', async () => {
    const { engine, executor, clock } = makeHarness();

    // Сетка выставлена ДО входа.
    const gridA = nextOrderId();
    const gridB = nextOrderId();
    feed(engine, newOrderEvent({ orderId: gridA, side: 'BUY', qty: 1, price: 49000, timeMs: clock.now() }));
    feed(engine, newOrderEvent({ orderId: gridB, side: 'BUY', qty: 1, price: 48000, timeMs: clock.now() }));

    // Позиция открывается первой лимиткой сетки.
    clock.advance(5_000);
    feed(engine, fillEvent({ orderId: gridA, side: 'BUY', lastQty: 1, lastPrice: 49000, timeMs: clock.now() }));
    expect(engine.positions.get(SYM, 'BOTH').qty).toBe(1);

    // Вторая лимитка сетки срабатывает уже в убытке.
    clock.advance(5_000);
    const res = feed(engine, fillEvent({ orderId: gridB, side: 'BUY', lastQty: 1, lastPrice: 48000, timeMs: clock.now() }));

    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('pre-existing-order');
    await engine.flushAll();
    expect(executor.actions).toHaveLength(0);
    expect(engine.positions.get(SYM, 'BOTH').entryPrice).toBeCloseTo(48500);
  });

  it('с countPreexistingOrders=true сетка тоже считается усреднением', async () => {
    const { engine, executor, clock } = makeHarness({ countPreexistingOrders: true });

    const gridA = nextOrderId();
    const gridB = nextOrderId();
    feed(engine, newOrderEvent({ orderId: gridA, side: 'BUY', qty: 1, price: 49000, timeMs: clock.now() }));
    feed(engine, newOrderEvent({ orderId: gridB, side: 'BUY', qty: 1, price: 48000, timeMs: clock.now() }));

    clock.advance(5_000);
    feed(engine, fillEvent({ orderId: gridA, side: 'BUY', lastQty: 1, lastPrice: 49000, timeMs: clock.now() }));
    clock.advance(5_000);
    const res = feed(engine, fillEvent({ orderId: gridB, side: 'BUY', lastQty: 1, lastPrice: 48000, timeMs: clock.now() }));

    expect(res?.detected).toBe(true);
    await engine.flushAll();
    expect(executor.last).toMatchObject({ requestedQty: 1, side: 'SELL' });
  });

  it('лимитка, выставленная ПОСЛЕ открытия позиции и сработавшая в убытке — усреднение', async () => {
    const { engine, executor, clock } = makeHarness();

    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));

    // Лимитка выставлена уже после входа.
    clock.advance(10_000);
    const limitId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: limitId, side: 'BUY', qty: 0.7, price: 47000, timeMs: clock.now() }));

    clock.advance(30_000);
    const res = feed(engine, fillEvent({ orderId: limitId, side: 'BUY', lastQty: 0.7, lastPrice: 47000, timeMs: clock.now() }));

    expect(res?.detected).toBe(true);
    expect(res?.reason).toBeUndefined();
    await engine.flushAll();
    expect(executor.last?.requestedQty).toBeCloseTo(0.7);
  });

  it('стоп-ордер, размещённый до открытия позиции, тоже освобождён от правила', async () => {
    const { engine, clock } = makeHarness();
    const stopId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: stopId, side: 'BUY', qty: 1, type: 'STOP_MARKET', origType: 'STOP_MARKET', stopPrice: 48000, timeMs: clock.now() }));

    clock.advance(1_000);
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));

    clock.advance(60_000);
    const res = feed(engine, fillEvent({ orderId: stopId, side: 'BUY', lastQty: 1, lastPrice: 47900, type: 'MARKET', origType: 'STOP_MARKET', timeMs: clock.now() }));
    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('pre-existing-order');
  });

  it('правило пересчитывается относительно ТЕКУЩЕЙ позиции, а не первой в истории', async () => {
    const { engine, clock } = makeHarness();

    // Ордер A размещён до первого входа — освобождён от правила и для повторного входа.
    const gridA = nextOrderId();
    feed(engine, newOrderEvent({ orderId: gridA, side: 'BUY', qty: 1, price: 40000, timeMs: clock.now() }));

    // Первый цикл: открылись и закрылись.
    clock.advance(1_000);
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));
    clock.advance(1_000);
    const closeId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: closeId, side: 'SELL', qty: 1, type: 'MARKET', reduceOnly: true, timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: closeId, side: 'SELL', lastQty: 1, lastPrice: 51000, type: 'MARKET', reduceOnly: true, timeMs: clock.now() }));
    expect(engine.positions.get(SYM, 'BOTH').qty).toBe(0);

    // Пока позиции нет, пользователь ставит ещё одну лимитку — ордер B.
    clock.advance(1_000);
    const gridB = nextOrderId();
    feed(engine, newOrderEvent({ orderId: gridB, side: 'BUY', qty: 1, price: 41000, timeMs: clock.now() }));

    // Второй вход.
    clock.advance(1_000);
    const open2 = nextOrderId();
    feed(engine, newOrderEvent({ orderId: open2, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: open2, side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: clock.now() }));

    // Оба ордера размещены ДО текущего входа -> оба освобождены.
    clock.advance(1_000);
    expect(feed(engine, fillEvent({ orderId: gridB, side: 'BUY', lastQty: 1, lastPrice: 41000, timeMs: clock.now() }))?.reason).toBe(
      'pre-existing-order',
    );
    expect(feed(engine, fillEvent({ orderId: gridA, side: 'BUY', lastQty: 1, lastPrice: 40000, timeMs: clock.now() }))?.reason).toBe(
      'pre-existing-order',
    );

    // А ордер, поставленный уже после входа, правилом не защищён.
    clock.advance(1_000);
    const late = nextOrderId();
    feed(engine, newOrderEvent({ orderId: late, side: 'BUY', qty: 1, price: 39000, timeMs: clock.now() }));
    clock.advance(1_000);
    const res = feed(engine, fillEvent({ orderId: late, side: 'BUY', lastQty: 1, lastPrice: 39000, timeMs: clock.now() }));
    expect(res?.detected).toBe(true);
  });
});

describe('порог убытка', () => {
  it('игнорирует долив в пределах порога', async () => {
    const { engine, clock } = makeHarness({ lossThresholdPct: 1 });
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));

    clock.advance(1_000);
    const addId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    const res = feed(engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 1, lastPrice: 49800, type: 'MARKET', timeMs: clock.now() }));

    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('below-loss-threshold');
  });

  it('срабатывает при превышении порога', async () => {
    const { engine, clock } = makeHarness({ lossThresholdPct: 1 });
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));

    clock.advance(1_000);
    const addId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    const res = feed(engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 1, lastPrice: 49000, type: 'MARKET', timeMs: clock.now() }));

    expect(res?.detected).toBe(true);
  });
});

describe('исключения', () => {
  it('ликвидация и ADL не считаются усреднением', async () => {
    const { engine, clock } = makeHarness();
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));

    clock.advance(1_000);
    const liqId = nextOrderId();
    const res = feed(
      engine,
      fillEvent({
        orderId: liqId,
        clientOrderId: 'autoclose-12345',
        side: 'BUY',
        lastQty: 1,
        lastPrice: 45000,
        type: 'LIQUIDATION',
        timeMs: clock.now(),
      }),
    );
    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('liquidation-or-adl');
  });

  it('собственные защитные ордера сервиса игнорируются', async () => {
    const { engine, clock } = makeHarness();
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));

    clock.advance(1_000);
    const ownId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: ownId, clientOrderId: 'antiavg_abc_1', side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    const res = feed(
      engine,
      fillEvent({ orderId: ownId, clientOrderId: 'antiavg_abc_1', side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: clock.now() }),
    );
    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('own-order');
  });

  it('символ вне списка наблюдения игнорируется', async () => {
    const { engine, clock } = makeHarness({ symbols: ['ETHUSDT'] });
    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));
    clock.advance(1_000);
    const addId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    const res = feed(engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: clock.now() }));
    expect(res?.reason).toBe('symbol-not-watched');
  });
});

describe('позиции, существовавшие до запуска', () => {
  it('при неизвестном времени открытия по умолчанию не реагирует', async () => {
    const { engine, clock } = makeHarness();
    engine.seedPositions([{ symbol: SYM, positionSide: 'BOTH', qty: 1, entryPrice: 50000, atMs: clock.now() }]);

    clock.advance(1_000);
    const addId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    const res = feed(engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: clock.now() }));

    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('unknown-open-time');
  });

  it('с политикой react реагирует и на такие позиции', async () => {
    const { engine, executor, clock } = makeHarness({ unknownOpenTimePolicy: 'react' });
    engine.seedPositions([{ symbol: SYM, positionSide: 'BOTH', qty: 1, entryPrice: 50000, atMs: clock.now() }]);

    clock.advance(1_000);
    const addId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    const res = feed(engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: clock.now() }));

    expect(res?.detected).toBe(true);
    await engine.flushAll();
    expect(executor.actions).toHaveLength(1);
  });

  it('восстановленное время открытия включает обычное правило', async () => {
    const { engine, clock } = makeHarness();
    const openedAt = clock.now() - 3600_000;
    // Сетка, размещённая ДО открытия позиции.
    const gridId = nextOrderId();
    engine.seedOrders([
      {
        orderId: gridId,
        clientOrderId: `user_${gridId}`,
        symbol: SYM,
        side: 'BUY',
        positionSide: 'BOTH',
        type: 'LIMIT',
        origType: 'LIMIT',
        placedAtMs: openedAt - 60_000,
        origQty: 1,
        price: 45000,
        stopPrice: 0,
        reduceOnly: false,
        closePosition: false,
        own: false,
      },
    ]);
    engine.seedPositions(
      [{ symbol: SYM, positionSide: 'BOTH', qty: 1, entryPrice: 50000, atMs: clock.now() }],
      new Map([[`${SYM}|BOTH`, openedAt]]),
    );

    clock.advance(1_000);
    const res = feed(engine, fillEvent({ orderId: gridId, side: 'BUY', lastQty: 1, lastPrice: 45000, timeMs: clock.now() }));
    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('pre-existing-order');
  });
});

describe('порядок ACCOUNT_UPDATE и ORDER_TRADE_UPDATE', () => {
  it('ACCOUNT_UPDATE, пришедший перед исполнением, не портит среднюю цену входа', async () => {
    const { engine, executor, clock } = makeHarness();

    const openId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: openId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));
    feed(engine, fillEvent({ orderId: openId, side: 'BUY', lastQty: 1, lastPrice: 50000, type: 'MARKET', timeMs: clock.now() }));

    clock.advance(60_000);
    const addId = nextOrderId();
    feed(engine, newOrderEvent({ orderId: addId, side: 'BUY', qty: 1, type: 'MARKET', timeMs: clock.now() }));

    // Биржа сначала присылает ACCOUNT_UPDATE с УЖЕ пересчитанной средней (49000).
    feed(engine, accountUpdate([{ qty: 2, entryPrice: 49000 }], clock.now()));
    // И только потом — исполнение.
    const res = feed(engine, fillEvent({ orderId: addId, side: 'BUY', lastQty: 1, lastPrice: 48000, type: 'MARKET', timeMs: clock.now() }));

    expect(res?.detected).toBe(true);
    expect(res?.before.entryPrice).toBe(50000);
    await engine.flushAll();
    expect(executor.actions).toHaveLength(1);
  });
});

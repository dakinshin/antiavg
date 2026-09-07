/**
 * Наблюдаемость: сервис обязан объяснять каждое своё решение на уровне info.
 * Без этого «не падает, но и не работает» невозможно диагностировать.
 */
import { describe, expect, it } from 'vitest';
import { feed, fillEvent, makeHarness, newOrderEvent, nextOrderId } from './helpers.js';

const SYM = 'BTCUSDT';

function openLong(h: ReturnType<typeof makeHarness>, qty = 1, price = 50000) {
  const id = nextOrderId();
  feed(h.engine, newOrderEvent({ orderId: id, side: 'BUY', qty, type: 'MARKET', timeMs: h.clock.now() }));
  feed(h.engine, fillEvent({ orderId: id, side: 'BUY', lastQty: qty, lastPrice: price, type: 'MARKET', timeMs: h.clock.now() }));
}

describe('каждое исполнение объяснено на уровне info', () => {
  it('открытие позиции логируется с причиной, почему это не усреднение', () => {
    const h = makeHarness();
    openLong(h);
    const line = h.logs.find((l) => l.msg === 'исполнение: не усреднение');
    expect(line?.level).toBe('info');
    expect(line?.meta.reason).toBe('position-was-flat');
    expect(String(line?.meta.причина)).toContain('открытие новой позиции');
  });

  it('долив в прибыли логируется с понятной причиной', () => {
    const h = makeHarness();
    openLong(h);
    h.clock.advance(60_000);
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, side: 'BUY', lastQty: 1, lastPrice: 52000, type: 'MARKET', timeMs: h.clock.now() }));

    const line = h.logs.filter((l) => l.msg === 'исполнение: не усреднение').at(-1);
    expect(line?.meta.reason).toBe('not-in-loss');
    expect(line?.meta.средняяДо).toBe(50000);
    expect(line?.meta.позицияПосле).toBe(2);
  });

  it('пропуск из-за преждевременной сетки показывает обе даты', () => {
    const h = makeHarness();
    const gridId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: gridId, side: 'BUY', qty: 1, price: 45000, timeMs: h.clock.now() }));
    h.clock.advance(5_000);
    openLong(h);
    h.clock.advance(5_000);
    feed(h.engine, fillEvent({ orderId: gridId, side: 'BUY', lastQty: 1, lastPrice: 45000, timeMs: h.clock.now() }));

    const line = h.logs.filter((l) => l.msg === 'исполнение: не усреднение').at(-1);
    expect(line?.meta.reason).toBe('pre-existing-order');
    expect(line?.meta.ордерРазмещён).toBeTruthy();
    expect(line?.meta.позицияОткрыта).toBeTruthy();
  });

  it('обнаружение усреднения логируется на уровне warn', async () => {
    const h = makeHarness();
    openLong(h);
    h.clock.advance(60_000);
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: h.clock.now() }));

    const line = h.logs.find((l) => l.msg === 'ОБНАРУЖЕНО УСРЕДНЕНИЕ В УБЫТКЕ');
    expect(line?.level).toBe('warn');
    expect(line?.meta.добавленоОбъёма).toBe(1);
    expect(h.engine.stats()).toMatchObject({ fills: 2, detections: 1 });
  });
});

describe('расхождение с биржей заметно в логах', () => {
  it('позиция на бирже, которой мы не видели, даёт предупреждение', () => {
    const h = makeHarness();
    h.engine.seedPositions([{ symbol: SYM, positionSide: 'BOTH', qty: 5, entryPrice: 50000, atMs: h.clock.now() }]);

    const line = h.logs.find((l) => l.msg === 'расхождение: биржа показывает позицию, которой мы не видели');
    expect(line?.level).toBe('warn');
    expect(line?.meta.qty).toBe(5);
    expect(h.engine.stats().desyncs).toBe(1);
  });

  it('расхождение объёма по уже известной позиции тоже видно', () => {
    const h = makeHarness();
    openLong(h, 1, 50000);
    h.clock.advance(1000);
    h.engine.seedPositions([
      { symbol: SYM, positionSide: 'BOTH', qty: 3, entryPrice: 50000, atMs: h.clock.now() },
    ]);

    const line = h.logs.find((l) => l.msg === 'расхождение объёма позиции с биржей');
    expect(line?.meta.нашОбъём).toBe(1);
    expect(line?.meta.объёмБиржи).toBe(3);
  });

  it('совпадающий снимок предупреждений не даёт', () => {
    const h = makeHarness();
    openLong(h, 1, 50000);
    h.clock.advance(1000);
    h.engine.seedPositions([
      { symbol: SYM, positionSide: 'BOTH', qty: 1, entryPrice: 50000, atMs: h.clock.now() },
    ]);
    expect(h.logs.filter((l) => l.msg.startsWith('расхождение'))).toHaveLength(0);
  });
});

describe('устаревшие снимки не откатывают состояние', () => {
  it('сверка, снятая ДО исполнения, не затирает объём и среднюю', () => {
    const h = makeHarness();
    openLong(h, 1, 50000);
    const snapshotTakenAt = h.clock.now();

    // Долив происходит уже после того, как снимок был снят.
    h.clock.advance(10_000);
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, side: 'BUY', lastQty: 1, lastPrice: 40000, type: 'MARKET', timeMs: h.clock.now() }));
    expect(h.engine.positions.get(SYM, 'BOTH').qty).toBe(2);

    // Приходит устаревший снимок с объёмом 1.
    h.engine.seedPositions([
      { symbol: SYM, positionSide: 'BOTH', qty: 1, entryPrice: 50000, atMs: snapshotTakenAt },
    ]);

    expect(h.engine.positions.get(SYM, 'BOTH').qty).toBe(2);
    expect(h.engine.positions.get(SYM, 'BOTH').entryPrice).toBe(45000);
    expect(h.engine.stats().staleSnapshots).toBe(1);
  });

  it('свежий снимок применяется нормально', () => {
    const h = makeHarness();
    openLong(h, 1, 50000);
    h.clock.advance(10_000);
    h.engine.seedPositions([
      { symbol: SYM, positionSide: 'BOTH', qty: 2, entryPrice: 47000, atMs: h.clock.now() },
    ]);
    expect(h.engine.positions.get(SYM, 'BOTH').qty).toBe(2);
    expect(h.engine.positions.get(SYM, 'BOTH').entryPrice).toBe(47000);
  });
});

describe('позиция, впервые увиденная через сверку', () => {
  it('после восстановления времени открытия долив по рынку ловится', async () => {
    const h = makeHarness();
    const openedAt = h.clock.now();

    // Исполнения по WebSocket мы пропустили — позиция появилась только из сверки.
    h.clock.advance(30_000);
    h.engine.seedPositions(
      [{ symbol: SYM, positionSide: 'BOTH', qty: 1, entryPrice: 50000, atMs: h.clock.now() }],
      new Map([[`${SYM}|BOTH`, openedAt]]),
    );

    // Пользователь усредняется по рынку.
    h.clock.advance(30_000);
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    const res = feed(h.engine, fillEvent({ orderId: id, side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: h.clock.now() }));

    expect(res?.detected).toBe(true);
    await h.engine.flushAll();
    expect(h.executor.last).toMatchObject({ side: 'SELL', requestedQty: 1 });
  });

  it('без восстановленного времени открытия сервис молчит, но пишет причину', () => {
    const h = makeHarness();
    h.engine.seedPositions([{ symbol: SYM, positionSide: 'BOTH', qty: 1, entryPrice: 50000, atMs: h.clock.now() }]);

    h.clock.advance(30_000);
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, side: 'BUY', qty: 1, type: 'MARKET', timeMs: h.clock.now() }));
    const res = feed(h.engine, fillEvent({ orderId: id, side: 'BUY', lastQty: 1, lastPrice: 45000, type: 'MARKET', timeMs: h.clock.now() }));

    expect(res?.reason).toBe('unknown-open-time');
    const line = h.logs.filter((l) => l.msg === 'исполнение: не усреднение').at(-1);
    expect(String(line?.meta.причина)).toContain('время открытия позиции неизвестно');
  });
});

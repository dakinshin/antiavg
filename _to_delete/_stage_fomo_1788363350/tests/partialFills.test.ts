/**
 * Ложное срабатывание из боевого прогона 2026-08-05 (BLESSUSDT).
 *
 * Один рыночный ордер исполнился тремя частями по ОДНОЙ цене 0.011316.
 * Сервис принял третью часть за усреднение в убытке и срезал позицию.
 * Причин было две, и обе воспроизводятся здесь.
 */
import { describe, expect, it } from 'vitest';
import { adverseDeviationPct, PRICE_NOISE_PCT } from '../src/core/detector.js';
import { feed, fillEvent, makeHarness, newOrderEvent, nextOrderId } from './helpers.js';

const SYM = 'BLESSUSDT';
const PRICE = 0.011316;

describe('шум арифметики не выдаётся за убыток', () => {
  it('пересчёт средней по одной цене даёт погрешность — она ниже порога', () => {
    // Ровно тот расчёт, что случился в бою.
    const entryAfterTwoFills = (446 * PRICE + 487 * PRICE) / (446 + 487);
    expect(entryAfterTwoFills).toBeGreaterThan(PRICE); // погрешность есть
    const deviation = adverseDeviationPct(933, entryAfterTwoFills, PRICE);
    expect(deviation).toBeGreaterThan(0); // формально «в убытке»
    expect(deviation).toBeLessThan(PRICE_NOISE_PCT); // но это шум
  });

  it('реальное движение цены порогом не съедается', () => {
    // Минимальный шаг для такой цены — 1e-6, это ~0.009 %.
    const deviation = adverseDeviationPct(933, PRICE, PRICE - 0.000001);
    expect(deviation).toBeGreaterThan(PRICE_NOISE_PCT * 100);
  });

  it('долив по той же цене не сдвигает среднюю', () => {
    const h = makeHarness();
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, symbol: SYM, side: 'BUY', qty: 1791, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'BUY', lastQty: 446, lastPrice: PRICE, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'BUY', lastQty: 487, lastPrice: PRICE, type: 'MARKET', timeMs: h.clock.now() }));
    expect(h.engine.positions.get(SYM, 'BOTH').entryPrice).toBe(PRICE);
  });
});

describe('частичные исполнения ордера, открывшего позицию', () => {
  it('боевой сценарий BLESSUSDT: три части одного ордера — реакции нет', async () => {
    const h = makeHarness();
    const id = nextOrderId();

    feed(h.engine, newOrderEvent({ orderId: id, symbol: SYM, side: 'BUY', qty: 1791, type: 'MARKET', timeMs: h.clock.now() }));
    const r1 = feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'BUY', lastQty: 446, lastPrice: PRICE, cumQty: 446, origQty: 1791, orderStatus: 'PARTIALLY_FILLED', type: 'MARKET', timeMs: h.clock.now() }));
    const r2 = feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'BUY', lastQty: 487, lastPrice: PRICE, cumQty: 933, origQty: 1791, orderStatus: 'PARTIALLY_FILLED', type: 'MARKET', timeMs: h.clock.now() }));
    const r3 = feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'BUY', lastQty: 858, lastPrice: PRICE, cumQty: 1791, origQty: 1791, orderStatus: 'FILLED', type: 'MARKET', timeMs: h.clock.now() }));

    expect(r1?.reason).toBe('position-was-flat');
    expect(r2?.reason).toBe('same-entry-order');
    expect(r3?.reason).toBe('same-entry-order');

    await h.engine.flushAll();
    expect(h.executor.actions).toHaveLength(0);
    expect(h.engine.positions.get(SYM, 'BOTH').qty).toBe(1791);
  });

  it('проскальзывание внутри одного ордера тоже не усреднение', async () => {
    const h = makeHarness();
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, symbol: SYM, side: 'BUY', qty: 1000, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'BUY', lastQty: 500, lastPrice: 0.0113, type: 'MARKET', timeMs: h.clock.now() }));
    // Вторая часть ушла заметно хуже — но это тот же вход.
    const res = feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'BUY', lastQty: 500, lastPrice: 0.0110, type: 'MARKET', timeMs: h.clock.now() }));

    expect(res?.detected).toBe(false);
    expect(res?.reason).toBe('same-entry-order');
    await h.engine.flushAll();
    expect(h.executor.actions).toHaveLength(0);
  });

  it('ДРУГОЙ ордер в убыточную позицию по-прежнему ловится', async () => {
    const h = makeHarness();
    const openId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: openId, symbol: SYM, side: 'BUY', qty: 1000, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: openId, symbol: SYM, side: 'BUY', lastQty: 1000, lastPrice: 0.0113, type: 'MARKET', timeMs: h.clock.now() }));

    h.clock.advance(60_000);
    const addId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: addId, symbol: SYM, side: 'BUY', qty: 1000, type: 'MARKET', timeMs: h.clock.now() }));
    const res = feed(h.engine, fillEvent({ orderId: addId, symbol: SYM, side: 'BUY', lastQty: 1000, lastPrice: 0.0110, type: 'MARKET', timeMs: h.clock.now() }));

    expect(res?.detected).toBe(true);
    await h.engine.flushAll();
    expect(h.executor.last).toMatchObject({ side: 'SELL', requestedQty: 1000 });
  });

  it('после закрытия позиции тот же ордер уже не защищён', async () => {
    const h = makeHarness();
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, symbol: SYM, side: 'BUY', qty: 2000, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'BUY', lastQty: 1000, lastPrice: 0.0113, type: 'MARKET', timeMs: h.clock.now() }));

    // Позиция закрыта другим ордером.
    const closeId = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: closeId, symbol: SYM, side: 'SELL', qty: 1000, type: 'MARKET', reduceOnly: true, timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: closeId, symbol: SYM, side: 'SELL', lastQty: 1000, lastPrice: 0.0114, type: 'MARKET', reduceOnly: true, timeMs: h.clock.now() }));
    expect(h.engine.positions.get(SYM, 'BOTH').openedByOrderId).toBeNull();

    // Остаток исходного ордера открывает позицию заново.
    h.clock.advance(1000);
    const res = feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'BUY', lastQty: 1000, lastPrice: 0.0110, type: 'MARKET', timeMs: h.clock.now() }));
    expect(res?.reason).toBe('position-was-flat');
  });

  it('шорт: части одного ордера по одной цене не считаются усреднением', async () => {
    const h = makeHarness();
    const id = nextOrderId();
    feed(h.engine, newOrderEvent({ orderId: id, symbol: SYM, side: 'SELL', qty: 3000, type: 'MARKET', timeMs: h.clock.now() }));
    feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'SELL', lastQty: 1000, lastPrice: PRICE, type: 'MARKET', timeMs: h.clock.now() }));
    const r = feed(h.engine, fillEvent({ orderId: id, symbol: SYM, side: 'SELL', lastQty: 2000, lastPrice: PRICE, type: 'MARKET', timeMs: h.clock.now() }));
    expect(r?.detected).toBe(false);
    expect(h.engine.positions.get(SYM, 'BOTH').qty).toBe(-3000);
  });
});

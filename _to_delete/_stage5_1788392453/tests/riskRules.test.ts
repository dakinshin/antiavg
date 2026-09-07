/**
 * Правила управления риском: лимит объёма, дефолтный стоп, оценка риска.
 * Всё здесь — чистая арифметика, поэтому проверяется без биржи и без времени.
 */
import { describe, expect, it } from 'vitest';
import {
  assessRisk,
  defaultStopPrice,
  positionCap,
  positionRisk,
  riskLimitStopPrice,
  roundStopToTick,
  stopAlreadyPassed,
  stopKindOf,
} from '../src/core/riskRules.js';
import type { OrderRecord } from '../src/types.js';
import { ConfigSchema } from '../src/config.js';

function order(over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    orderId: 1,
    clientOrderId: 'x',
    symbol: 'BTCUSDT',
    side: 'SELL',
    positionSide: 'BOTH',
    type: 'STOP_MARKET',
    origType: 'STOP_MARKET',
    placedAtMs: 1000,
    origQty: 1,
    executedQty: 0,
    price: 0,
    stopPrice: 49000,
    reduceOnly: true,
    closePosition: false,
    own: false,
    ...over,
  };
}

describe('распознавание стоп-ордера', () => {
  it('SELL STOP_MARKET защищает лонг', () => {
    expect(stopKindOf(order(), 1)).toBe('fixed');
  });

  it('BUY STOP_MARKET при лонге — вход по прорыву, а не стоп', () => {
    expect(stopKindOf(order({ side: 'BUY' }), 1)).toBeNull();
  });

  it('BUY STOP_MARKET защищает шорт', () => {
    expect(stopKindOf(order({ side: 'BUY', stopPrice: 51000 }), -1)).toBe('fixed');
  });

  it('трейлинг признаётся стопом, но отдельного вида', () => {
    expect(stopKindOf(order({ origType: 'TRAILING_STOP_MARKET', stopPrice: 0 }), 1)).toBe('trailing');
  });

  it('лимитка и тейк-профит стопом не считаются', () => {
    expect(stopKindOf(order({ origType: 'LIMIT', type: 'LIMIT' }), 1)).toBeNull();
    expect(stopKindOf(order({ origType: 'TAKE_PROFIT_MARKET', type: 'TAKE_PROFIT_MARKET' }), 1)).toBeNull();
  });

  it('STOP без цены срабатывания игнорируется — считать риск не по чему', () => {
    expect(stopKindOf(order({ origType: 'STOP', type: 'STOP', stopPrice: 0 }), 1)).toBeNull();
  });

  it('в hedge-режиме стоп по LONG не защищает SHORT', () => {
    expect(stopKindOf(order({ positionSide: 'LONG' }), -1)).toBeNull();
    expect(stopKindOf(order({ positionSide: 'SHORT', side: 'BUY' }), -1)).toBe('fixed');
  });

  it('у пустой позиции стопов не бывает', () => {
    expect(stopKindOf(order(), 0)).toBeNull();
  });
});

describe('дефолтный стоп', () => {
  it('для лонга ниже входа, для шорта выше', () => {
    expect(defaultStopPrice(100, 1, 1)).toBeCloseTo(99);
    expect(defaultStopPrice(100, -1, 1)).toBeCloseTo(101);
  });

  it('процент берётся по модулю — знак не должен переворачивать смысл', () => {
    expect(defaultStopPrice(100, 1, -1)).toBeCloseTo(99);
  });

  it('округление к тику идёт В СТОРОНУ входа, а не наружу', () => {
    // Лонг: 99.37 при тике 0.1 -> 99.4 (ближе ко входу, риск чуть меньше).
    expect(roundStopToTick(99.37, 1, 0.1)).toBeCloseTo(99.4);
    // Шорт: 100.63 -> 100.6.
    expect(roundStopToTick(100.63, -1, 0.1)).toBeCloseTo(100.6);
  });
});

describe('риск позиции', () => {
  it('лонг: убыток от входа до стопа', () => {
    expect(positionRisk(2, 100, 95)).toBeCloseTo(10);
  });

  it('шорт: убыток считается в другую сторону', () => {
    expect(positionRisk(-2, 100, 105)).toBeCloseTo(10);
  });

  it('стоп в прибыли даёт отрицательный риск — это не ошибка', () => {
    expect(positionRisk(2, 100, 110)).toBeCloseTo(-20);
  });

  it('предельная цена стопа обратна расчёту риска', () => {
    const limit = riskLimitStopPrice(2, 100, 10);
    expect(limit).toBeCloseTo(95);
    expect(positionRisk(2, 100, limit)).toBeCloseTo(10);
  });

  it('цена, уже прошедшая стоп, распознаётся для обеих сторон', () => {
    expect(stopAlreadyPassed(1, 95, 94)).toBe(true);
    expect(stopAlreadyPassed(1, 95, 96)).toBe(false);
    expect(stopAlreadyPassed(-1, 105, 106)).toBe(true);
    expect(stopAlreadyPassed(-1, 105, 104)).toBe(false);
  });
});

describe('лимит объёма позиции', () => {
  it('в пределах лимита срезать нечего', () => {
    const cap = positionCap(1, 1000, 1000, 3, 0.001);
    expect(cap.excessQty).toBe(0);
    expect(cap.maxNotional).toBe(3000);
  });

  it('превышение срезается до потолка', () => {
    // Депозит 1000, плечо 3 -> потолок 3000. Позиция 5 по 1000 = 5000.
    const cap = positionCap(5, 1000, 1000, 3, 0.001);
    expect(cap.notional).toBe(5000);
    expect(cap.targetQty).toBeCloseTo(3);
    expect(cap.excessQty).toBeCloseTo(2);
  });

  it('целевой объём округляется ВНИЗ — после срезки лимит соблюдён строго', () => {
    // Потолок 3000 при цене 700 -> 4.2857…; шаг 0.1 -> 4.2, остаток 2940 < 3000.
    const cap = positionCap(6, 700, 1000, 3, 0.1);
    expect(cap.targetQty).toBeCloseTo(4.2);
    expect(cap.targetQty * 700).toBeLessThanOrEqual(cap.maxNotional);
  });

  it('шорт считается по модулю объёма', () => {
    const cap = positionCap(-5, 1000, 1000, 3, 0.001);
    expect(cap.excessQty).toBeCloseTo(2);
  });

  it('нулевой депозит или нулевая цена ничего не срезают', () => {
    expect(positionCap(5, 1000, 0, 3, 0.001).excessQty).toBe(0);
    expect(positionCap(5, 0, 1000, 3, 0.001).excessQty).toBe(0);
  });
});

describe('оценка риска по стопам', () => {
  const balance = 10_000;

  it('без стопов — отдельный вердикт, а не «превышено»', () => {
    expect(assessRisk(1, 100, [], balance, 2).verdict).toBe('no-stop');
  });

  it('только трейлинг — риск неизвестен', () => {
    const a = assessRisk(1, 100, [{ kind: 'trailing', stopPrice: 0 }], balance, 2);
    expect(a.verdict).toBe('unknown');
    expect(a.risk).toBeUndefined();
  });

  it('риск в пределах лимита', () => {
    // 100 единиц по 100, стоп 99 -> риск 100 = 1% от 10000.
    const a = assessRisk(100, 100, [{ kind: 'fixed', stopPrice: 99 }], balance, 2);
    expect(a.verdict).toBe('within');
    expect(a.risk).toBeCloseTo(100);
    expect(a.riskPct).toBeCloseTo(1);
  });

  it('риск за лимитом', () => {
    const a = assessRisk(100, 100, [{ kind: 'fixed', stopPrice: 96 }], balance, 2);
    expect(a.verdict).toBe('exceeded');
    expect(a.risk).toBeCloseTo(400);
    expect(a.maxRisk).toBeCloseTo(200);
  });

  it('из нескольких стопов берётся самый дальний', () => {
    const a = assessRisk(
      100,
      100,
      [
        { kind: 'fixed', stopPrice: 99.5 },
        { kind: 'fixed', stopPrice: 96 },
      ],
      balance,
      2,
    );
    expect(a.stopPrice).toBeCloseTo(96);
    expect(a.verdict).toBe('exceeded');
  });

  it('смесь трейлинга и обычного стопа считается по обычному', () => {
    const a = assessRisk(
      100,
      100,
      [
        { kind: 'trailing', stopPrice: 0 },
        { kind: 'fixed', stopPrice: 99 },
      ],
      balance,
      2,
    );
    expect(a.verdict).toBe('within');
    expect(a.risk).toBeCloseTo(100);
  });

  it('стоп в прибыли лимит проходит всегда', () => {
    expect(assessRisk(100, 100, [{ kind: 'fixed', stopPrice: 105 }], balance, 2).verdict).toBe('within');
  });

  it('предельная цена стопа даёт ровно граничный вердикт', () => {
    const limit = riskLimitStopPrice(100, 100, (balance * 2) / 100);
    const a = assessRisk(100, 100, [{ kind: 'fixed', stopPrice: limit }], balance, 2);
    expect(a.verdict).toBe('within');
    expect(a.risk).toBeCloseTo(a.maxRisk);
  });
});

describe('цена срабатывания стопов сервиса', () => {
  it('по умолчанию — цена последней сделки, как у стопов, выставленных руками', () => {
    const cfg = ConfigSchema.parse({ apiKey: 'k', apiSecret: 's' });
    expect(cfg.stopWorkingType).toBe('CONTRACT_PRICE');
  });

  it('переключается на mark price', () => {
    const cfg = ConfigSchema.parse({ apiKey: 'k', apiSecret: 's', stopWorkingType: 'MARK_PRICE' });
    expect(cfg.stopWorkingType).toBe('MARK_PRICE');
  });
});

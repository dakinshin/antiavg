import { describe, expect, it } from 'vitest';
import { floorToStep, formatByStep, roundToStep, stepDecimals } from '../src/util/num.js';
import { resolveQty } from '../src/binance/executor.js';
import type { SymbolFilters } from '../src/binance/exchangeInfo.js';
import type { ProtectiveAction } from '../src/types.js';

const BTC: SymbolFilters = {
  symbol: 'BTCUSDT',
  stepSize: 0.001,
  minQty: 0.001,
  maxQty: 1000,
  tickSize: 0.1,
  minNotional: 5,
  quantityPrecision: 3,
  pricePrecision: 1,
};

function action(over: Partial<ProtectiveAction> = {}): ProtectiveAction {
  return {
    symbol: 'BTCUSDT',
    positionSide: 'BOTH',
    mode: 'reduce',
    side: 'SELL',
    requestedQty: 0.5,
    positionQty: 1,
    triggers: [],
    ...over,
  };
}

describe('округление по шагу', () => {
  it('stepDecimals', () => {
    expect(stepDecimals(0.001)).toBe(3);
    expect(stepDecimals(1)).toBe(0);
    expect(stepDecimals(0.00001)).toBe(5);
    expect(stepDecimals(10)).toBe(0);
  });

  it('floorToStep округляет вниз без артефактов плавающей точки', () => {
    expect(floorToStep(0.30000000000000004, 0.001)).toBeCloseTo(0.3, 10);
    expect(floorToStep(1.2349, 0.001)).toBeCloseTo(1.234, 10);
    expect(floorToStep(0.0009, 0.001)).toBe(0);
    expect(floorToStep(7.99, 1)).toBe(7);
  });

  it('roundToStep для цен', () => {
    expect(roundToStep(50000.06, 0.1)).toBeCloseTo(50000.1, 10);
    expect(roundToStep(50000.04, 0.1)).toBeCloseTo(50000, 10);
  });

  it('formatByStep не даёт экспоненциальной записи', () => {
    expect(formatByStep(0.000012, 0.000001)).toBe('0.000012');
    expect(formatByStep(1, 0.001)).toBe('1.000');
    expect(formatByStep(12, 1)).toBe('12');
  });
});

describe('resolveQty', () => {
  it('срезает по шагу вниз и не превышает позицию', () => {
    const r = resolveQty(action({ requestedQty: 0.5004, positionQty: 1 }), BTC, 'skip');
    expect(r.ok).toBe(true);
    expect(r.qty).toBeCloseTo(0.5, 10);
  });

  it('ограничивает объём текущим размером позиции', () => {
    const r = resolveQty(action({ requestedQty: 5, positionQty: 0.7 }), BTC, 'skip');
    expect(r.qty).toBeCloseTo(0.7, 10);
  });

  it('объём меньше minQty: skip', () => {
    const r = resolveQty(action({ requestedQty: 0.0004, positionQty: 1 }), BTC, 'skip');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('below-min-qty');
  });

  it('объём меньше minQty: close закрывает позицию целиком', () => {
    const r = resolveQty(action({ requestedQty: 0.0004, positionQty: 1 }), BTC, 'close');
    expect(r.ok).toBe(true);
    expect(r.qty).toBeCloseTo(1, 10);
    expect(r.escalatedToClose).toBe(true);
  });

  it('пустая позиция — действие не требуется', () => {
    const r = resolveQty(action({ positionQty: 0 }), BTC, 'skip');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('position-flat');
  });

  it('шорт: используется модуль объёма позиции', () => {
    const r = resolveQty(action({ side: 'BUY', requestedQty: 0.4, positionQty: -1 }), BTC, 'skip');
    expect(r.ok).toBe(true);
    expect(r.qty).toBeCloseTo(0.4, 10);
  });
});

import { describe, expect, it } from 'vitest';
import { PositionStore } from '../src/core/positionStore.js';

const SYM = 'BTCUSDT';

describe('PositionStore', () => {
  it('открытие фиксирует цену входа и время', () => {
    const s = new PositionStore();
    const r = s.applyFill(SYM, 'BOTH', 1, 50000, 1000);
    expect(r.opened).toBe(true);
    const p = s.get(SYM, 'BOTH');
    expect(p.qty).toBe(1);
    expect(p.entryPrice).toBe(50000);
    expect(p.openedAtMs).toBe(1000);
    expect(p.openTimeKnown).toBe(true);
  });

  it('долив пересчитывает среднюю по объёму', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', 1, 50000, 1000);
    const r = s.applyFill(SYM, 'BOTH', 3, 46000, 2000);
    expect(r.increased).toBe(true);
    expect(r.addedQty).toBe(3);
    expect(s.get(SYM, 'BOTH').entryPrice).toBeCloseTo(47000);
    expect(s.get(SYM, 'BOTH').openedAtMs).toBe(1000);
  });

  it('частичное закрытие не меняет среднюю', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', 2, 50000, 1000);
    s.applyFill(SYM, 'BOTH', -1, 40000, 2000);
    expect(s.get(SYM, 'BOTH').qty).toBe(1);
    expect(s.get(SYM, 'BOTH').entryPrice).toBe(50000);
  });

  it('полное закрытие обнуляет позицию', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', 2, 50000, 1000);
    const r = s.applyFill(SYM, 'BOTH', -2, 40000, 2000);
    expect(r.closed).toBe(true);
    expect(s.get(SYM, 'BOTH').qty).toBe(0);
    expect(s.get(SYM, 'BOTH').entryPrice).toBe(0);
    expect(s.get(SYM, 'BOTH').openedAtMs).toBeNull();
  });

  it('переворот открывает позицию заново по цене сделки', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', 1, 50000, 1000);
    const r = s.applyFill(SYM, 'BOTH', -3, 48000, 2000);
    expect(r.flipped).toBe(true);
    expect(s.get(SYM, 'BOTH').qty).toBe(-2);
    expect(s.get(SYM, 'BOTH').entryPrice).toBe(48000);
    expect(s.get(SYM, 'BOTH').openedAtMs).toBe(2000);
  });

  it('снимок с биржи сохраняет время открытия при неизменном знаке', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', 1, 50000, 1000);
    s.applySnapshot(SYM, 'BOTH', 1.0000001, 50000.5, 3000);
    const p = s.get(SYM, 'BOTH');
    expect(p.openedAtMs).toBe(1000);
    expect(p.openTimeKnown).toBe(true);
  });

  it('позиция, появившаяся только из снимка, имеет неизвестное время открытия', () => {
    const s = new PositionStore();
    s.applySnapshot(SYM, 'BOTH', 1, 50000, 3000);
    const p = s.get(SYM, 'BOTH');
    expect(p.qty).toBe(1);
    expect(p.openTimeKnown).toBe(false);
  });

  it('накопленная ошибка округления убирается снимком', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', 0.1, 100, 1);
    s.applyFill(SYM, 'BOTH', 0.2, 100, 2);
    expect(s.get(SYM, 'BOTH').qty).not.toBe(0.3);
    s.applySnapshot(SYM, 'BOTH', 0.3, 100, 3);
    expect(s.get(SYM, 'BOTH').qty).toBe(0.3);
  });
});

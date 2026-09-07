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

  it('результат сделки копится по закрывающим исполнениям', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', 2, 100, 1); // лонг 2 по 100
    // Половину закрыли в плюс, половину в минус: итог сделки — сумма обеих.
    const partial = s.applyFill(SYM, 'BOTH', -1, 110, 2);
    expect(partial.closed).toBe(false);
    expect(partial.realizedPnl).toBeCloseTo(10);
    const full = s.applyFill(SYM, 'BOTH', -1, 95, 3);
    expect(full.closed).toBe(true);
    expect(full.realizedPnl).toBeCloseTo(5); // +10 и −5
    // Счёт закрытой сделки обнулён — следующая начинает с нуля.
    expect(s.get(SYM, 'BOTH').realizedPnl).toBe(0);
  });

  it('у шорта прибыльно движение вниз', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', -1, 100, 1);
    expect(s.applyFill(SYM, 'BOTH', 1, 90, 2).realizedPnl).toBeCloseTo(10);
  });

  it('стоп в безубыток даёт ровно нулевой результат', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', 1, 100, 1);
    expect(s.applyFill(SYM, 'BOTH', -1, 100, 2).realizedPnl).toBe(0);
  });

  it('переворот закрывает счёт старой сделки и начинает новый', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', 1, 100, 1);
    const flip = s.applyFill(SYM, 'BOTH', -3, 90, 2);
    expect(flip.flipped).toBe(true);
    expect(flip.realizedPnl).toBeCloseTo(-10);
    expect(s.get(SYM, 'BOTH').realizedPnl).toBe(0);
  });

  it('долив результат сделки не трогает', () => {
    const s = new PositionStore();
    s.applyFill(SYM, 'BOTH', 1, 100, 1);
    s.applyFill(SYM, 'BOTH', -0.5, 110, 2); // +5
    expect(s.applyFill(SYM, 'BOTH', 1, 90, 3).realizedPnl).toBeCloseTo(5);
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

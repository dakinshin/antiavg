import type { PositionSnapshot } from '../types.js';

/** Позиция, сидящая в просадке. */
export interface DrawdownPosition {
  symbol: string;
  positionSide: string;
  qty: number;
  entryPrice: number;
  /** Нереализованный убыток, отрицательное число. */
  unrealizedPnl: number;
}

export interface DrawdownStatus {
  /** true — есть хотя бы одна позиция в минусе сверх порога. */
  inDrawdown: boolean;
  positions: DrawdownPosition[];
  /** Суммарный нереализованный убыток по этим позициям. */
  totalLoss: number;
}

/**
 * Какие позиции сидят в просадке.
 *
 * Чистая функция: решение принимается по снимку с биржи, где `unrealizedPnl`
 * посчитан по mark price. Собственную оценку тут использовать нельзя — текущей
 * рыночной цены сервис не отслеживает, ему для детекции она не нужна.
 *
 * `minLoss` задаётся положительным числом: 0 — любой минус считается просадкой,
 * 1 — только убыток больше единицы в валюте котировки.
 */
export function findDrawdown(
  snapshots: PositionSnapshot[],
  minLoss = 0,
): DrawdownStatus {
  const threshold = -Math.abs(minLoss);
  const positions: DrawdownPosition[] = [];

  for (const s of snapshots) {
    if (Math.abs(s.qty) <= 0) continue;
    const pnl = s.unrealizedPnl;
    // PnL нет в снимке — судить не о чем, позицию не учитываем.
    if (pnl === undefined || !Number.isFinite(pnl)) continue;
    // Строгое сравнение: при minLoss = 0 запирает любой минус, но не нулевой PnL.
    if (pnl < threshold && pnl < 0) {
      positions.push({
        symbol: s.symbol,
        positionSide: s.positionSide,
        qty: s.qty,
        entryPrice: s.entryPrice,
        unrealizedPnl: pnl,
      });
    }
  }

  return {
    inDrawdown: positions.length > 0,
    positions,
    totalLoss: positions.reduce((acc, p) => acc + p.unrealizedPnl, 0),
  };
}

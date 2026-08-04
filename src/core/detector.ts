import type { Config } from '../config.js';
import { isSymbolWatched } from '../config.js';
import type { ApplyFillResult } from './positionStore.js';
import type { AveragingSkipReason, DetectionResult, FillEvent, OrderRecord } from '../types.js';

export const LIQUIDATION_CLIENT_ID_PREFIXES = ['autoclose-', 'adl_autoclose'];

export interface PositionBefore {
  qty: number;
  entryPrice: number;
  openedAtMs: number | null;
  openTimeKnown: boolean;
}

export interface AnalyzeInput {
  cfg: Config;
  fill: FillEvent;
  order?: OrderRecord;
  before: PositionBefore;
  applied: ApplyFillResult;
}

function skip(reason: AveragingSkipReason, input: AnalyzeInput, deviationPct = 0): DetectionResult {
  return {
    detected: false,
    reason,
    before: { qty: input.before.qty, entryPrice: input.before.entryPrice },
    after: input.applied.after,
    addedQty: input.applied.addedQty,
    fillPrice: input.fill.lastFilledPrice,
    adverseDeviationPct: deviationPct,
    fill: input.fill,
    ...(input.order ? { order: input.order } : {}),
  };
}

/**
 * Насколько цена исполнения хуже средней цены входа, в процентах.
 * Для long: цена ниже входа -> положительное значение.
 * Для short: цена выше входа -> положительное значение.
 */
export function adverseDeviationPct(positionQty: number, entryPrice: number, fillPrice: number): number {
  if (entryPrice <= 0) return 0;
  const isLong = positionQty > 0;
  const diff = isLong ? entryPrice - fillPrice : fillPrice - entryPrice;
  return (diff / entryPrice) * 100;
}

export function isLiquidationOrAdl(fill: FillEvent): boolean {
  if (fill.type === 'LIQUIDATION' || fill.origType === 'LIQUIDATION') return true;
  return LIQUIDATION_CLIENT_ID_PREFIXES.some((p) => fill.clientOrderId.startsWith(p));
}

/**
 * Главное правило.
 *
 * Усреднением в убытке считается исполнение, которое одновременно:
 *   1) увеличивает уже существующую (не flat) позицию в ту же сторону;
 *   2) происходит по цене хуже средней цены входа на величину >= порога;
 *   3) НЕ порождено ордером, размещённым ДО момента открытия позиции
 *      (если только countPreexistingOrders не включён).
 */
export function analyzeFill(input: AnalyzeInput): DetectionResult {
  const { cfg, fill, order, before, applied } = input;

  if (!isSymbolWatched(cfg, fill.symbol)) return skip('symbol-not-watched', input);
  if (isLiquidationOrAdl(fill)) return skip('liquidation-or-adl', input);
  if (order?.own) return skip('own-order', input);
  if (fill.reduceOnly) return skip('reduce-only', input);

  if (applied.opened || applied.flipped) return skip('position-was-flat', input);
  if (!applied.increased) return skip('not-an-increase', input);

  const deviation = adverseDeviationPct(before.qty, before.entryPrice, fill.lastFilledPrice);
  if (deviation <= 0) return skip('not-in-loss', input, deviation);
  if (deviation < cfg.lossThresholdPct) return skip('below-loss-threshold', input, deviation);
  if (applied.addedQty < cfg.minAveragingQty) return skip('not-an-increase', input, deviation);

  // Правило «ордер размещён до открытия позиции».
  if (!cfg.countPreexistingOrders) {
    if (!before.openTimeKnown || before.openedAtMs === null) {
      if (cfg.unknownOpenTimePolicy === 'skip') return skip('unknown-open-time', input, deviation);
    } else if (order && order.placedAtMs < before.openedAtMs) {
      return skip('pre-existing-order', input, deviation);
    }
  }

  return {
    detected: true,
    before: { qty: before.qty, entryPrice: before.entryPrice },
    after: applied.after,
    addedQty: applied.addedQty,
    fillPrice: fill.lastFilledPrice,
    adverseDeviationPct: deviation,
    fill,
    ...(order ? { order } : {}),
  };
}

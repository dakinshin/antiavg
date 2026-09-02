import type { Config } from '../config.js';
import { isSymbolWatched } from '../config.js';
import type { ApplyFillResult } from './positionStore.js';
import type {
  AveragingSkipReason,
  DetectionResult,
  FillEvent,
  OrderRecord,
  PendingOrderVerdict,
} from '../types.js';

export const LIQUIDATION_CLIENT_ID_PREFIXES = ['autoclose-', 'adl_autoclose'];

/** Человекочитаемые причины, почему исполнение не признано усреднением. */
export const SKIP_REASON_TEXT: Record<AveragingSkipReason, string> = {
  'not-an-increase': 'позиция не увеличилась (закрытие или уменьшение)',
  'position-was-flat': 'это открытие новой позиции, а не долив',
  'not-in-loss': 'цена долива не хуже средней входа',
  'below-loss-threshold': 'убыток меньше порога ANTIAVG_LOSS_THRESHOLD_PCT',
  'pre-existing-order': 'ордер размещён ДО открытия позиции (вход сеткой)',
  'same-entry-order': 'это частичное исполнение того же ордера, которым позиция и открыта',
  'unknown-open-time': 'время открытия позиции неизвестно, политика = skip',
  'liquidation-or-adl': 'ликвидация или ADL',
  'own-order': 'собственный защитный ордер сервиса',
  'reduce-only': 'ордер reduceOnly, позицию увеличить не может',
  'symbol-not-watched': 'символ вне списка наблюдения',
  cooldown: 'действие подавлено паузой между реакциями',
  'no-usable-price': 'цену исполнения ордера определить нельзя',
};

export interface PositionBefore {
  qty: number;
  entryPrice: number;
  openedAtMs: number | null;
  openTimeKnown: boolean;
  openedByOrderId: number | null;
}

/**
 * Порог, ниже которого «ухудшение» цены — это шум арифметики с плавающей точкой,
 * а не убыток.
 *
 * Пересчёт средней цены входа (деление на суммарный объём) даёт погрешность
 * порядка 1e-18 даже когда все исполнения прошли по ОДНОЙ цене. В процентах это
 * ~1e-14, и без порога такой долив выглядит убыточным. Реальный шаг цены на
 * фьючерсах Binance — не мельче ~1e-5 от цены, то есть ~1e-3 %, что на семь
 * порядков выше этого порога.
 */
export const PRICE_NOISE_PCT = 1e-6;

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

  // Частичные исполнения ордера, которым позиция и была открыта, — это одно и то
  // же вхождение. Их цены могут отличаться (проскальзывание по стакану), но
  // усреднением в убыток они не являются.
  if (before.openedByOrderId !== null && before.openedByOrderId === fill.orderId) {
    return skip('same-entry-order', input, adverseDeviationPct(before.qty, before.entryPrice, fill.lastFilledPrice));
  }

  const deviation = adverseDeviationPct(before.qty, before.entryPrice, fill.lastFilledPrice);
  if (deviation <= PRICE_NOISE_PCT) return skip('not-in-loss', input, deviation);
  if (deviation < Math.max(cfg.lossThresholdPct, PRICE_NOISE_PCT)) {
    return skip('below-loss-threshold', input, deviation);
  }
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

/**
 * Цена, по которой ордер предположительно исполнится.
 * Для трейлинг-стопа она неизвестна заранее — такие ордера не оцениваем.
 */
export function pendingOrderPrice(o: OrderRecord): number | null {
  const type = o.origType || o.type;
  switch (type) {
    case 'LIMIT':
      return o.price > 0 ? o.price : null;
    case 'STOP':
    case 'TAKE_PROFIT':
      // Стоп-лимит: исполнится по лимитной цене, если она задана.
      return o.price > 0 ? o.price : o.stopPrice > 0 ? o.stopPrice : null;
    case 'STOP_MARKET':
    case 'TAKE_PROFIT_MARKET':
      return o.stopPrice > 0 ? o.stopPrice : null;
    default:
      return null;
  }
}

export interface PendingPosition {
  qty: number;
  entryPrice: number;
  openedAtMs: number | null;
  openTimeKnown: boolean;
}

function pendingSkip(
  reason: AveragingSkipReason,
  order: OrderRecord,
  price = 0,
  deviation = 0,
): PendingOrderVerdict {
  return { dangerous: false, reason, price, adverseDeviationPct: deviation, order };
}

/**
 * Профилактическое правило: опасен ли ещё не исполненный ордер.
 *
 * Тот же критерий, что и для состоявшегося долива, но вместо цены сделки берётся
 * цена, по которой ордер сработает. Смысл в том, чтобы снять заявку ДО
 * исполнения: это дешевле реакции постфактум — не нужно рыночного ордера, нет
 * проскальзывания и зафиксированного убытка.
 */
export function analyzePendingOrder(
  cfg: Config,
  order: OrderRecord,
  pos: PendingPosition,
): PendingOrderVerdict {
  if (!isSymbolWatched(cfg, order.symbol)) return pendingSkip('symbol-not-watched', order);
  if (order.own) return pendingSkip('own-order', order);
  // Такие ордера позицию увеличить не могут по определению.
  if (order.reduceOnly || order.closePosition) return pendingSkip('reduce-only', order);

  // Нет позиции — нечего усреднять: этот ордер её только откроет.
  if (Math.abs(pos.qty) <= 0) return pendingSkip('position-was-flat', order);

  const increases = pos.qty > 0 ? order.side === 'BUY' : order.side === 'SELL';
  if (!increases) return pendingSkip('not-an-increase', order);

  const price = pendingOrderPrice(order);
  if (price === null || price <= 0) return pendingSkip('no-usable-price', order);

  const deviation = adverseDeviationPct(pos.qty, pos.entryPrice, price);
  if (deviation <= PRICE_NOISE_PCT) return pendingSkip('not-in-loss', order, price, deviation);
  if (deviation < Math.max(cfg.lossThresholdPct, PRICE_NOISE_PCT)) {
    return pendingSkip('below-loss-threshold', order, price, deviation);
  }
  if (order.origQty - order.executedQty < cfg.minAveragingQty) {
    return pendingSkip('not-an-increase', order, price, deviation);
  }

  // То же освобождение, что и для исполнений: сетка, выставленная до входа, — норма.
  if (!cfg.countPreexistingOrders) {
    if (!pos.openTimeKnown || pos.openedAtMs === null) {
      if (cfg.unknownOpenTimePolicy === 'skip') return pendingSkip('unknown-open-time', order, price, deviation);
    } else if (order.placedAtMs < pos.openedAtMs) {
      return pendingSkip('pre-existing-order', order, price, deviation);
    }
  }

  return { dangerous: true, price, adverseDeviationPct: deviation, order };
}

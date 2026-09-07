/**
 * Чистые правила управления риском. Ни сети, ни состояния — только арифметика,
 * которую можно проверить тестами до последней копейки.
 *
 * Соглашение по знаку `qty` то же, что и везде в проекте: long > 0, short < 0.
 */
import type { OrderRecord } from '../types.js';
import { ceilToStep, floorToStep, isZero, roundToStep } from '../util/num.js';

/**
 * Что именно защищает позицию.
 *
 * `fixed` — стоп с известной ценой срабатывания: риск по нему считается точно.
 * `trailing` — трейлинг: цена срабатывания заранее неизвестна и едет за рынком,
 *              поэтому позиция считается «под защитой», но величина риска —
 *              неизвестной. Это сознательный компромисс, а не недоделка.
 */
export type StopKind = 'fixed' | 'trailing';

const FIXED_STOP_TYPES = new Set(['STOP_MARKET', 'STOP']);
const TRAILING_STOP_TYPES = new Set(['TRAILING_STOP_MARKET']);

/**
 * Является ли ордер стоп-ордером ЭТОЙ позиции.
 *
 * Требуется противоположная сторона: BUY STOP_MARKET при открытом лонге — это
 * вход по прорыву, а не защита, и считать его стопом было бы опасной ошибкой.
 */
export function stopKindOf(order: OrderRecord, positionQty: number): StopKind | null {
  if (isZero(positionQty)) return null;
  // В hedge-режиме сторона должна совпадать: стоп по LONG не защищает SHORT.
  if (order.positionSide === 'LONG' && positionQty < 0) return null;
  if (order.positionSide === 'SHORT' && positionQty > 0) return null;
  const closingSide = positionQty > 0 ? 'SELL' : 'BUY';
  if (order.side !== closingSide) return null;

  if (TRAILING_STOP_TYPES.has(order.origType)) return 'trailing';
  if (FIXED_STOP_TYPES.has(order.origType) && order.stopPrice > 0) return 'fixed';
  return null;
}

/** Цена дефолтного стопа: отступ в процентах от средней цены входа. */
export function defaultStopPrice(entryPrice: number, positionQty: number, pct: number): number {
  const k = Math.abs(pct) / 100;
  return positionQty > 0 ? entryPrice * (1 - k) : entryPrice * (1 + k);
}

/**
 * Риск позиции в валюте котировки: сколько будет потеряно, если стоп сработает.
 *
 * Отрицательное значение — не ошибка: стоп, уведённый за цену входа, фиксирует
 * прибыль, и такая позиция любой лимит риска проходит.
 */
export function positionRisk(qty: number, entryPrice: number, stopPrice: number): number {
  const abs = Math.abs(qty);
  return qty > 0 ? (entryPrice - stopPrice) * abs : (stopPrice - entryPrice) * abs;
}

/** Самая дальняя цена стопа, при которой риск ещё укладывается в лимит. */
export function riskLimitStopPrice(qty: number, entryPrice: number, maxRiskQuote: number): number {
  const abs = Math.abs(qty);
  if (abs <= 0) return entryPrice;
  const distance = Math.max(0, maxRiskQuote) / abs;
  return qty > 0 ? entryPrice - distance : entryPrice + distance;
}

/**
 * Цена уже прошла стоп — выставить его туда нельзя, биржа отклонит ордер
 * («Order would immediately trigger»). Единственный способ ограничить риск в
 * такой ситуации — закрыть позицию по рынку.
 */
export function stopAlreadyPassed(positionQty: number, stopPrice: number, markPrice: number): boolean {
  return positionQty > 0 ? markPrice <= stopPrice : markPrice >= stopPrice;
}

/**
 * Приводит цену стопа к шагу цены, округляя В СТОРОНУ ВХОДА.
 *
 * Направление выбрано не для красоты: округление наружу увеличило бы риск на
 * величину тика и позволило бы стопу оказаться чуть дальше разрешённого предела.
 */
export function roundStopToTick(price: number, positionQty: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  return positionQty > 0 ? ceilToStep(price, tickSize) : floorToStep(price, tickSize);
}

/** Округление обычной цены к ближайшему тику (для сравнений и логов). */
export function roundPrice(price: number, tickSize: number): number {
  return tickSize > 0 ? roundToStep(price, tickSize) : price;
}

export interface PositionCap {
  /** Разрешённый номинал позиции в валюте котировки. */
  maxNotional: number;
  /** Текущий номинал. */
  notional: number;
  /** Сколько единиц базовой валюты нужно срезать. 0 — лимит соблюдён. */
  excessQty: number;
  /** Объём, который останется после срезки. */
  targetQty: number;
}

/**
 * Лимит объёма позиции: номинал не выше `leverage × депозит`.
 *
 * Целевой объём округляется ВНИЗ по шагу лота, поэтому после срезки позиция
 * гарантированно оказывается не выше потолка, а не «примерно на нём».
 */
export function positionCap(
  qty: number,
  price: number,
  walletBalance: number,
  maxLeverage: number,
  stepSize: number,
): PositionCap {
  const abs = Math.abs(qty);
  const maxNotional = Math.max(0, walletBalance) * Math.max(0, maxLeverage);
  const notional = abs * price;

  if (price <= 0 || abs <= 0 || maxNotional <= 0 || notional <= maxNotional) {
    return { maxNotional, notional, excessQty: 0, targetQty: abs };
  }

  const allowed = maxNotional / price;
  const targetQty = stepSize > 0 ? floorToStep(allowed, stepSize) : allowed;
  return { maxNotional, notional, excessQty: Math.max(0, abs - targetQty), targetQty };
}

export type RiskVerdict = 'within' | 'exceeded' | 'unknown' | 'no-stop';

export interface RiskAssessment {
  verdict: RiskVerdict;
  /** Риск в валюте котировки. undefined, если посчитать нельзя. */
  risk?: number;
  /** Предельный риск в валюте котировки. */
  maxRisk: number;
  /** Риск в процентах от депозита. undefined вместе с risk. */
  riskPct?: number;
  /** Цена стопа, по которой считали. */
  stopPrice?: number;
}

/**
 * Оценка риска позиции по её стоп-ордерам.
 *
 * Если стопов несколько, берётся САМЫЙ ДАЛЬНИЙ: именно он определяет реальный
 * максимальный убыток. Частичные стопы (на часть объёма) при этом дают
 * завышенную оценку — сознательный перекос в безопасную сторону.
 */
export function assessRisk(
  qty: number,
  entryPrice: number,
  stops: Array<{ kind: StopKind; stopPrice: number }>,
  walletBalance: number,
  maxRiskPct: number,
): RiskAssessment {
  const maxRisk = (Math.max(0, walletBalance) * Math.max(0, maxRiskPct)) / 100;
  if (stops.length === 0) return { verdict: 'no-stop', maxRisk };

  const fixed = stops.filter((s) => s.kind === 'fixed' && s.stopPrice > 0);
  if (fixed.length === 0) return { verdict: 'unknown', maxRisk };

  let worst = fixed[0]!;
  let worstRisk = positionRisk(qty, entryPrice, worst.stopPrice);
  for (const s of fixed.slice(1)) {
    const r = positionRisk(qty, entryPrice, s.stopPrice);
    if (r > worstRisk) {
      worstRisk = r;
      worst = s;
    }
  }

  const riskPct = walletBalance > 0 ? (worstRisk / walletBalance) * 100 : undefined;
  return {
    verdict: worstRisk > maxRisk ? 'exceeded' : 'within',
    risk: worstRisk,
    maxRisk,
    ...(riskPct !== undefined ? { riskPct } : {}),
    stopPrice: worst.stopPrice,
  };
}

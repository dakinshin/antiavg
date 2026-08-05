import { toNum } from '../util/num.js';
import type {
  FillEvent,
  OrderLifecycleEvent,
  OrderRecord,
  OrderSide,
  OrderType,
  PositionSide,
  PositionSnapshot,
} from '../types.js';

/** Сырое событие ORDER_TRADE_UPDATE. */
export interface RawOrderTradeUpdate {
  e: 'ORDER_TRADE_UPDATE';
  E: number;
  T: number;
  o: {
    s: string;
    c: string;
    S: OrderSide;
    o: OrderType;
    f?: string;
    q: string;
    p: string;
    ap: string;
    sp?: string;
    x: string;
    X: string;
    i: number;
    l: string;
    z: string;
    L: string;
    T: number;
    t: number;
    ps: PositionSide;
    R?: boolean;
    cp?: boolean;
    ot?: OrderType;
    rp?: string;
    [k: string]: unknown;
  };
}

/** Сырое событие ACCOUNT_UPDATE. */
export interface RawAccountUpdate {
  e: 'ACCOUNT_UPDATE';
  E: number;
  T: number;
  a: {
    m: string;
    B?: Array<{ a: string; wb: string; cw: string; bc: string }>;
    P?: Array<{
      s: string;
      pa: string;
      ep: string;
      bep?: string;
      cr?: string;
      up: string;
      mt?: string;
      iw?: string;
      ps: PositionSide;
    }>;
  };
}

/**
 * Сырое событие TRADE_LITE — облегчённая и БОЛЕЕ БЫСТРАЯ версия ORDER_TRADE_UPDATE.
 * Полей меньше: нет positionSide и нет reduceOnly.
 */
export interface RawTradeLite {
  e: 'TRADE_LITE';
  E: number;
  T: number;
  s: string;
  q: string;
  p: string;
  m?: boolean;
  c?: string;
  S: OrderSide;
  L: string;
  l: string;
  t: number;
  i: number;
  [k: string]: unknown;
}

export type RawUserDataEvent =
  | RawOrderTradeUpdate
  | RawAccountUpdate
  | { e: string; E?: number; [k: string]: unknown };

export function toOrderRecord(raw: RawOrderTradeUpdate, ownPrefix: string): OrderRecord {
  const o = raw.o;
  return {
    orderId: o.i,
    clientOrderId: o.c ?? '',
    symbol: o.s,
    side: o.S,
    positionSide: o.ps ?? 'BOTH',
    type: o.o,
    origType: (o.ot ?? o.o) as OrderType,
    // Время размещения: для события NEW это время транзакции. Для последующих
    // событий OrderRegistry сохранит минимальное (то есть исходное) значение.
    placedAtMs: raw.T ?? raw.E,
    origQty: toNum(o.q),
    executedQty: toNum(o.z),
    price: toNum(o.p),
    stopPrice: toNum(o.sp),
    reduceOnly: Boolean(o.R),
    closePosition: Boolean(o.cp),
    own: Boolean(ownPrefix) && (o.c ?? '').startsWith(ownPrefix),
  };
}

export function toOrderLifecycleEvent(raw: RawOrderTradeUpdate, ownPrefix: string): OrderLifecycleEvent {
  return {
    eventTimeMs: raw.E,
    transactionTimeMs: raw.T,
    executionType: raw.o.x,
    orderStatus: raw.o.X,
    order: toOrderRecord(raw, ownPrefix),
  };
}

/** true, если событие содержит исполнение (сделку). */
export function isFillEvent(raw: RawOrderTradeUpdate): boolean {
  return raw.o.x === 'TRADE' && toNum(raw.o.l) > 0;
}

export function toFillEvent(raw: RawOrderTradeUpdate): FillEvent {
  const o = raw.o;
  return {
    eventTimeMs: raw.E,
    tradeTimeMs: o.T ?? raw.T ?? raw.E,
    symbol: o.s,
    positionSide: o.ps ?? 'BOTH',
    side: o.S,
    orderId: o.i,
    clientOrderId: o.c ?? '',
    tradeId: o.t ?? 0,
    lastFilledQty: toNum(o.l),
    lastFilledPrice: toNum(o.L),
    cumFilledQty: toNum(o.z),
    type: o.o,
    origType: (o.ot ?? o.o) as OrderType,
    reduceOnly: Boolean(o.R),
    closePosition: Boolean(o.cp),
    origQty: toNum(o.q),
    price: toNum(o.p),
    stopPrice: toNum(o.sp),
    orderStatus: o.X,
  };
}

/**
 * TRADE_LITE -> FillEvent.
 *
 * В событии нет positionSide и reduceOnly, поэтому недостающее берём из реестра
 * ордеров. В hedge mode без записи об ордере сторону позиции определить нельзя —
 * тогда возвращаем undefined и ждём полноценный ORDER_TRADE_UPDATE.
 */
export function tradeLiteToFillEvent(
  raw: RawTradeLite,
  order: OrderRecord | undefined,
  hedgeMode: boolean,
): FillEvent | undefined {
  let positionSide: PositionSide;
  if (order) {
    positionSide = order.positionSide;
  } else if (!hedgeMode) {
    positionSide = 'BOTH';
  } else {
    return undefined;
  }

  return {
    eventTimeMs: raw.E,
    tradeTimeMs: raw.T ?? raw.E,
    symbol: raw.s,
    positionSide,
    side: raw.S,
    orderId: raw.i,
    clientOrderId: raw.c ?? order?.clientOrderId ?? '',
    tradeId: raw.t ?? 0,
    lastFilledQty: toNum(raw.l),
    lastFilledPrice: toNum(raw.L),
    cumFilledQty: toNum(raw.l),
    type: order?.type ?? 'MARKET',
    origType: order?.origType ?? 'MARKET',
    reduceOnly: order?.reduceOnly ?? false,
    closePosition: order?.closePosition ?? false,
    origQty: toNum(raw.q),
    price: toNum(raw.p),
    stopPrice: order?.stopPrice ?? 0,
    orderStatus: 'TRADE_LITE',
  };
}

export function toPositionSnapshots(raw: RawAccountUpdate): PositionSnapshot[] {
  const at = raw.T ?? raw.E;
  return (raw.a.P ?? []).map((p) => ({
    symbol: p.s,
    positionSide: p.ps ?? 'BOTH',
    qty: toNum(p.pa),
    entryPrice: toNum(p.ep),
    unrealizedPnl: toNum(p.up),
    atMs: at,
  }));
}

/** Ответ GET /fapi/v1/openOrders. */
export interface RawOpenOrder {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  type: OrderType;
  origType?: OrderType;
  origQty: string;
  executedQty?: string;
  price: string;
  stopPrice?: string;
  reduceOnly?: boolean;
  closePosition?: boolean;
  time: number;
  updateTime: number;
}

export function openOrderToRecord(raw: RawOpenOrder, ownPrefix: string): OrderRecord {
  return {
    orderId: raw.orderId,
    clientOrderId: raw.clientOrderId ?? '',
    symbol: raw.symbol,
    side: raw.side,
    positionSide: raw.positionSide ?? 'BOTH',
    type: raw.type,
    origType: (raw.origType ?? raw.type) as OrderType,
    placedAtMs: raw.time,
    origQty: toNum(raw.origQty),
    executedQty: toNum(raw.executedQty),
    price: toNum(raw.price),
    stopPrice: toNum(raw.stopPrice),
    reduceOnly: Boolean(raw.reduceOnly),
    closePosition: Boolean(raw.closePosition),
    own: Boolean(ownPrefix) && (raw.clientOrderId ?? '').startsWith(ownPrefix),
  };
}

/** Ответ GET /fapi/v2|v3/positionRisk. */
export interface RawPositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  positionSide: PositionSide;
  unRealizedProfit?: string;
  updateTime?: number;
}

export function positionRiskToSnapshot(raw: RawPositionRisk, fallbackAtMs: number): PositionSnapshot {
  return {
    symbol: raw.symbol,
    positionSide: raw.positionSide ?? 'BOTH',
    qty: toNum(raw.positionAmt),
    entryPrice: toNum(raw.entryPrice),
    unrealizedPnl: toNum(raw.unRealizedProfit),
    atMs: raw.updateTime && raw.updateTime > 0 ? raw.updateTime : fallbackAtMs,
  };
}

/** Ответ GET /fapi/v1/userTrades. */
export interface RawUserTrade {
  symbol: string;
  id: number;
  orderId: number;
  side: OrderSide;
  positionSide: PositionSide;
  qty: string;
  price: string;
  time: number;
  realizedPnl?: string;
}

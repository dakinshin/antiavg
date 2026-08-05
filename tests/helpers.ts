import { testConfig, type Config } from '../src/config.js';
import { Engine, type ExecutionOutcome, type ProtectiveExecutor } from '../src/core/engine.js';
import {
  isFillEvent,
  toFillEvent,
  toOrderLifecycleEvent,
  toPositionSnapshots,
  type RawAccountUpdate,
  type RawOrderTradeUpdate,
} from '../src/binance/mappers.js';
import type { OrderSide, OrderType, PositionSide, ProtectiveAction } from '../src/types.js';
import type { Logger } from '../src/util/logger.js';

export class FakeClock {
  constructor(private t = 1_700_000_000_000) {}
  now = (): number => this.t;
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

export class RecordingExecutor implements ProtectiveExecutor {
  readonly actions: ProtectiveAction[] = [];
  outcome: ExecutionOutcome = { executed: true, orderId: 1 };
  readonly cancelled: string[] = [];

  async execute(action: ProtectiveAction): Promise<ExecutionOutcome> {
    this.actions.push(action);
    return { ...this.outcome, sentQty: action.requestedQty };
  }

  async cancelOpenOrders(symbol: string): Promise<void> {
    this.cancelled.push(symbol);
  }

  get last(): ProtectiveAction | undefined {
    return this.actions[this.actions.length - 1];
  }

  reset(): void {
    this.actions.length = 0;
    this.cancelled.length = 0;
  }
}

export interface HarnessOptions extends Partial<Config> {}

/** Логгер, складывающий записи в массив — для проверки наблюдаемости. */
export function recordingLogger() {
  const lines: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
  const make = (bindings: Record<string, unknown>): Logger => ({
    debug: (m, meta) => lines.push({ level: 'debug', msg: m, meta: { ...bindings, ...meta } }),
    info: (m, meta) => lines.push({ level: 'info', msg: m, meta: { ...bindings, ...meta } }),
    warn: (m, meta) => lines.push({ level: 'warn', msg: m, meta: { ...bindings, ...meta } }),
    error: (m, meta) => lines.push({ level: 'error', msg: m, meta: { ...bindings, ...meta } }),
    child: (extra) => make({ ...bindings, ...extra }),
  });
  return { logger: make({}), lines };
}

export function makeHarness(overrides: HarnessOptions = {}) {
  const clock = new FakeClock();
  const executor = new RecordingExecutor();
  const { logger, lines } = recordingLogger();
  const cfg = testConfig({
    // Таймер агрегации намеренно большой: в тестах вызываем flushAll() вручную.
    aggregationWindowMs: 60_000,
    cooldownMs: 0,
    dryRun: false,
    ...overrides,
  });
  const engine = new Engine({ cfg, executor, now: clock.now, logger });
  return { cfg, clock, executor, engine, logs: lines };
}

let orderIdSeq = 1000;
export function nextOrderId(): number {
  return ++orderIdSeq;
}

export interface OrderEventInit {
  symbol?: string;
  orderId?: number;
  clientOrderId?: string;
  side: OrderSide;
  positionSide?: PositionSide;
  type?: OrderType;
  origType?: OrderType;
  qty: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  closePosition?: boolean;
  timeMs: number;
}

/** Событие размещения ордера (x = NEW). */
export function newOrderEvent(init: OrderEventInit): RawOrderTradeUpdate {
  const orderId = init.orderId ?? nextOrderId();
  return {
    e: 'ORDER_TRADE_UPDATE',
    E: init.timeMs,
    T: init.timeMs,
    o: {
      s: init.symbol ?? 'BTCUSDT',
      c: init.clientOrderId ?? `user_${orderId}`,
      S: init.side,
      o: init.type ?? 'LIMIT',
      f: 'GTC',
      q: String(init.qty),
      p: String(init.price ?? 0),
      ap: '0',
      sp: String(init.stopPrice ?? 0),
      x: 'NEW',
      X: 'NEW',
      i: orderId,
      l: '0',
      z: '0',
      L: '0',
      T: init.timeMs,
      t: 0,
      ps: init.positionSide ?? 'BOTH',
      R: init.reduceOnly ?? false,
      cp: init.closePosition ?? false,
      ot: init.origType ?? init.type ?? 'LIMIT',
    },
  };
}

export interface FillEventInit {
  symbol?: string;
  orderId: number;
  clientOrderId?: string;
  side: OrderSide;
  positionSide?: PositionSide;
  type?: OrderType;
  origType?: OrderType;
  lastQty: number;
  lastPrice: number;
  cumQty?: number;
  origQty?: number;
  reduceOnly?: boolean;
  orderStatus?: string;
  /** У каждого частичного исполнения свой tradeId — как на бирже. */
  tradeId?: number;
  timeMs: number;
}

let tradeIdSeq = 500000;
export function nextTradeId(): number {
  return ++tradeIdSeq;
}

/** Событие исполнения (x = TRADE). */
export function fillEvent(init: FillEventInit): RawOrderTradeUpdate {
  return {
    e: 'ORDER_TRADE_UPDATE',
    E: init.timeMs,
    T: init.timeMs,
    o: {
      s: init.symbol ?? 'BTCUSDT',
      c: init.clientOrderId ?? `user_${init.orderId}`,
      S: init.side,
      o: init.type ?? 'LIMIT',
      f: 'GTC',
      q: String(init.origQty ?? init.lastQty),
      p: String(init.lastPrice),
      ap: String(init.lastPrice),
      sp: '0',
      x: 'TRADE',
      X: init.orderStatus ?? 'FILLED',
      i: init.orderId,
      l: String(init.lastQty),
      z: String(init.cumQty ?? init.lastQty),
      L: String(init.lastPrice),
      T: init.timeMs,
      t: init.tradeId ?? nextTradeId(),
      ps: init.positionSide ?? 'BOTH',
      R: init.reduceOnly ?? false,
      cp: false,
      ot: init.origType ?? init.type ?? 'LIMIT',
    },
  };
}

export function accountUpdate(
  positions: Array<{ symbol?: string; qty: number; entryPrice: number; positionSide?: PositionSide }>,
  timeMs: number,
): RawAccountUpdate {
  return {
    e: 'ACCOUNT_UPDATE',
    E: timeMs,
    T: timeMs,
    a: {
      m: 'ORDER',
      P: positions.map((p) => ({
        s: p.symbol ?? 'BTCUSDT',
        pa: String(p.qty),
        ep: String(p.entryPrice),
        up: '0',
        ps: p.positionSide ?? 'BOTH',
      })),
    },
  };
}

/** Прогоняет сырое событие через маппер и движок — как это делает App. */
export function feed(engine: Engine, raw: RawOrderTradeUpdate | RawAccountUpdate, ownPrefix = 'antiavg') {
  if (raw.e === 'ORDER_TRADE_UPDATE') {
    const r = raw as RawOrderTradeUpdate;
    engine.onOrderEvent(toOrderLifecycleEvent(r, ownPrefix));
    if (isFillEvent(r)) return engine.onFill(toFillEvent(r));
    return undefined;
  }
  for (const snap of toPositionSnapshots(raw as RawAccountUpdate)) engine.onPositionSnapshot(snap);
  return undefined;
}

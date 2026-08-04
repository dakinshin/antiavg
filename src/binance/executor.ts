import type { Config } from '../config.js';
import type { ExecutionOutcome, ProtectiveExecutor } from '../core/engine.js';
import type { ProtectiveAction } from '../types.js';
import type { BinanceRestClient } from './rest.js';
import { BinanceApiError } from './rest.js';
import type { ExchangeInfoCache, SymbolFilters } from './exchangeInfo.js';
import { floorToStep, formatByStep } from '../util/num.js';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/logger.js';

/** Коды Binance, означающие «позиция уже закрыта / нечего уменьшать». */
const BENIGN_CODES = new Set([-2022, -2027, -4003, -1106]);

export interface QtyResolution {
  ok: boolean;
  qty: number;
  reason?: 'below-min-qty' | 'position-flat' | 'no-filters';
  /** true, если пришлось перейти к полному закрытию из-за minQty. */
  escalatedToClose?: boolean;
}

/**
 * Приводит требуемый объём к правилам биржи.
 * Округление ВНИЗ по stepSize — чтобы никогда не срезать больше, чем добавили,
 * и не перевернуть позицию.
 */
export function resolveQty(
  action: ProtectiveAction,
  filters: SymbolFilters | undefined,
  onQtyBelowMin: Config['onQtyBelowMin'],
): QtyResolution {
  const positionAbs = Math.abs(action.positionQty);
  if (positionAbs <= 0) return { ok: false, qty: 0, reason: 'position-flat' };
  if (!filters) return { ok: false, qty: 0, reason: 'no-filters' };

  const step = filters.stepSize > 0 ? filters.stepSize : 0;
  const capped = Math.min(action.requestedQty, positionAbs);
  let qty = step > 0 ? floorToStep(capped, step) : capped;

  if (qty >= filters.minQty && qty > 0) {
    return { ok: true, qty: Math.min(qty, filters.maxQty) };
  }

  // Объём меньше минимального лота биржи.
  if (onQtyBelowMin === 'close') {
    qty = step > 0 ? floorToStep(positionAbs, step) : positionAbs;
    if (qty >= filters.minQty && qty > 0) {
      return { ok: true, qty: Math.min(qty, filters.maxQty), escalatedToClose: true };
    }
  }
  return { ok: false, qty: 0, reason: 'below-min-qty' };
}

export interface BinanceExecutorOptions {
  cfg: Config;
  rest: BinanceRestClient;
  exchangeInfo: ExchangeInfoCache;
  logger?: Logger;
  /** Режим хеджирования (dualSidePosition). Влияет на reduceOnly. */
  hedgeMode: boolean;
  now?: () => number;
}

interface RawOrderResponse {
  orderId: number;
  clientOrderId: string;
  executedQty?: string;
  avgPrice?: string;
  status?: string;
}

export class BinanceExecutor implements ProtectiveExecutor {
  private readonly log: Logger;
  private readonly now: () => number;
  private seq = 0;

  constructor(private readonly opts: BinanceExecutorOptions) {
    this.log = opts.logger ?? noopLogger;
    this.now = opts.now ?? (() => Date.now());
  }

  private clientOrderId(): string {
    const prefix = this.opts.cfg.clientOrderIdPrefix || 'antiavg';
    this.seq = (this.seq + 1) % 100000;
    const id = `${prefix}_${this.now().toString(36)}_${this.seq.toString(36)}`;
    // Binance ограничивает clientOrderId 36 символами.
    return id.slice(0, 36);
  }

  async execute(action: ProtectiveAction): Promise<ExecutionOutcome> {
    // ensure(), а не get(): если полный exchangeInfo не догрузился при старте,
    // фильтры символа подтянутся точечным запросом прямо здесь.
    const filters = await this.opts.exchangeInfo.ensure(action.symbol);
    const resolved = resolveQty(action, filters, this.opts.cfg.onQtyBelowMin);

    if (!resolved.ok) {
      if (resolved.reason === 'no-filters') {
        this.log.error('нет фильтров символа, защитный ордер не отправлен', { symbol: action.symbol });
        return { executed: false, error: 'no-filters' };
      }
      if (resolved.reason === 'position-flat') return { executed: false, skipped: 'position-flat' };
      this.log.warn('объём срезки меньше минимального лота — действие пропущено', {
        symbol: action.symbol,
        requestedQty: action.requestedQty,
        minQty: filters?.minQty,
        stepSize: filters?.stepSize,
        hint: 'ANTIAVG_ON_QTY_BELOW_MIN=close закроет позицию целиком',
      });
      return { executed: false, skipped: 'below-min-qty' };
    }

    const step = filters?.stepSize ?? 0;
    const qtyStr = step > 0 ? formatByStep(resolved.qty, step) : String(resolved.qty);
    const newClientOrderId = this.clientOrderId();

    const params: Record<string, string | number | boolean> = {
      symbol: action.symbol,
      side: action.side,
      type: 'MARKET',
      quantity: qtyStr,
      newClientOrderId,
      newOrderRespType: 'RESULT',
    };

    if (this.opts.hedgeMode || action.positionSide !== 'BOTH') {
      // В hedge mode reduceOnly отправлять нельзя — направление задаётся positionSide.
      params.positionSide = action.positionSide === 'BOTH' ? (action.positionQty > 0 ? 'LONG' : 'SHORT') : action.positionSide;
    } else {
      params.reduceOnly = 'true';
    }

    if (this.opts.cfg.dryRun) {
      this.log.warn('DRY RUN: защитный ордер НЕ отправлен', {
        ...params,
        mode: action.mode,
        escalatedToClose: resolved.escalatedToClose ?? false,
      });
      return { executed: false, skipped: 'dry-run', sentQty: resolved.qty, clientOrderId: newClientOrderId };
    }

    try {
      const res = await this.opts.rest.signedPost<RawOrderResponse>('/fapi/v1/order', params);
      return {
        executed: true,
        sentQty: resolved.qty,
        orderId: res.orderId,
        clientOrderId: res.clientOrderId ?? newClientOrderId,
      };
    } catch (e) {
      if (e instanceof BinanceApiError && e.code !== undefined && BENIGN_CODES.has(e.code)) {
        this.log.info('биржа отклонила защитный ордер как излишний', {
          symbol: action.symbol,
          code: e.code,
          message: e.message,
        });
        return { executed: false, skipped: 'position-flat', error: e.message };
      }
      throw e;
    }
  }

  async cancelOpenOrders(symbol: string): Promise<void> {
    if (this.opts.cfg.dryRun) {
      this.log.warn('DRY RUN: отмена открытых ордеров НЕ выполнена', { symbol });
      return;
    }
    await this.opts.rest.signedDelete('/fapi/v1/allOpenOrders', { symbol });
    this.log.info('открытые ордера отменены', { symbol });
  }
}

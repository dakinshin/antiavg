import type { Config } from '../config.js';
import type { ExecutionOutcome, ProtectiveExecutor } from '../core/engine.js';
import type { StopOrderSpec, StopPlacement } from '../core/riskGuard.js';
import { roundStopToTick } from '../core/riskRules.js';
import type { ProtectiveAction } from '../types.js';
import type { BinanceRestClient } from './rest.js';
import { BinanceApiError } from './rest.js';
import type { ExchangeInfoCache, SymbolFilters } from './exchangeInfo.js';
import { floorToStep, formatByStep } from '../util/num.js';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/logger.js';

/** Коды Binance, означающие «позиция уже закрыта / нечего уменьшать». */
const BENIGN_CODES = new Set([-2022, -2027, -4003, -1106]);

/**
 * Коды, означающие «ордера уже нет»: он исполнился, отменён пользователем или
 * истёк, пока мы принимали решение. Это штатный исход гонки, не ошибка.
 */
const ORDER_GONE_CODES = new Set([-2011, -2013]);

/**
 * «Order would immediately trigger» — цена уже прошла уровень стопа.
 * Штатный ответ, а не поломка: значит, защищаться стопом уже поздно.
 */
const WOULD_TRIGGER_CODES = new Set([-2021]);

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

  /**
   * Ставит защитный стоп на всю позицию.
   *
   * `closePosition=true`, а не `quantity` + `reduceOnly`: такой стоп закрывает
   * позицию целиком, каким бы ни стал её объём после доливов, и биржа сама
   * снимает его, когда позиция закрыта. Количество при closePosition отправлять
   * нельзя — Binance отклонит ордер.
   *
   * `workingType=MARK_PRICE`: по mark price считается ликвидация, и стоп,
   * привязанный к цене последней сделки, на тонком рынке может не сработать
   * там, где по марку позиция уже уничтожена.
   */
  async placeStop(spec: StopOrderSpec): Promise<StopPlacement> {
    const filters = await this.opts.exchangeInfo.ensure(spec.symbol);
    const tick = filters?.tickSize ?? 0;
    const rounded = roundStopToTick(spec.stopPrice, spec.positionQty, tick);
    if (!Number.isFinite(rounded) || rounded <= 0) {
      return { placed: false, reason: 'bad-price' };
    }
    // Без фильтров символа шаг цены неизвестен. String(0.9899999999999999) биржа
    // отвергнет по превышению точности, поэтому обрезаем до восьми знаков и
    // убираем хвостовые нули — и громко говорим, что работаем вслепую.
    if (tick <= 0) {
      this.log.warn('фильтры символа неизвестны, цена стопа округляется вслепую', {
        symbol: spec.symbol,
        stopPrice: rounded,
      });
    }
    const priceStr =
      tick > 0 ? formatByStep(rounded, tick) : rounded.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    const newClientOrderId = this.clientOrderId();

    const params: Record<string, string | number | boolean> = {
      symbol: spec.symbol,
      side: spec.side,
      type: 'STOP_MARKET',
      stopPrice: priceStr,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
      newClientOrderId,
      newOrderRespType: 'RESULT',
    };
    if (this.opts.hedgeMode || spec.positionSide !== 'BOTH') {
      params.positionSide =
        spec.positionSide === 'BOTH' ? (spec.positionQty > 0 ? 'LONG' : 'SHORT') : spec.positionSide;
    }

    if (this.opts.cfg.dryRun) {
      this.log.warn('DRY RUN: стоп НЕ выставлен', { ...params, повод: spec.reason });
      return { placed: false, reason: 'dry-run', stopPrice: rounded, clientOrderId: newClientOrderId };
    }

    try {
      const res = await this.opts.rest.signedPost<RawOrderResponse>('/fapi/v1/order', params);
      return {
        placed: true,
        orderId: res.orderId,
        clientOrderId: res.clientOrderId ?? newClientOrderId,
        stopPrice: rounded,
      };
    } catch (e) {
      if (e instanceof BinanceApiError && e.code !== undefined && WOULD_TRIGGER_CODES.has(e.code)) {
        // Цена уже за стопом: биржа такой ордер не принимает. Это не сбой, а
        // сигнал вызывающему, что ограничивать риск придётся закрытием позиции.
        this.log.warn('стоп сработал бы сразу — биржа отклонила ордер', {
          symbol: spec.symbol,
          stopPrice: priceStr,
          code: e.code,
        });
        return { placed: false, reason: 'would-trigger', stopPrice: rounded };
      }
      // Отказ биржи должен быть виден вместе с тем, ЧТО именно отправлялось:
      // без параметров такая ошибка не диагностируется вообще никак.
      this.log.error('биржа отклонила стоп-ордер', {
        ...params,
        code: e instanceof BinanceApiError ? e.code : undefined,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  /** Снимает конкретный ордер. Уже исчезнувший ордер ошибкой не считается. */
  async cancelOrder(symbol: string, orderId: number): Promise<{ cancelled: boolean; reason?: string }> {
    if (this.opts.cfg.dryRun) {
      this.log.warn('DRY RUN: ордер НЕ отменён', { symbol, orderId });
      return { cancelled: false, reason: 'dry-run' };
    }
    try {
      await this.opts.rest.signedDelete('/fapi/v1/order', { symbol, orderId });
      return { cancelled: true };
    } catch (e) {
      if (e instanceof BinanceApiError && e.code !== undefined && ORDER_GONE_CODES.has(e.code)) {
        this.log.info('ордер уже отсутствует на бирже', { symbol, orderId, code: e.code });
        return { cancelled: false, reason: 'already-gone' };
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

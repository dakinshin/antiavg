import type { BinanceRestClient } from './rest.js';
import { toNum } from '../util/num.js';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/logger.js';

export interface SymbolFilters {
  symbol: string;
  stepSize: number;
  minQty: number;
  maxQty: number;
  tickSize: number;
  minNotional: number;
  quantityPrecision: number;
  pricePrecision: number;
}

interface RawExchangeInfo {
  symbols?: Array<{
    symbol: string;
    contractType?: string;
    status?: string;
    quantityPrecision: number;
    pricePrecision: number;
    filters: Array<Record<string, string>>;
  }>;
}

export interface ExchangeInfoOptions {
  ttlMs?: number;
  logger?: Logger;
  /** Таймаут полной загрузки справочника (ответ на несколько мегабайт). */
  fullLoadTimeoutMs?: number;
  /** Таймаут загрузки одного символа. */
  symbolLoadTimeoutMs?: number;
}

/**
 * Кеш торговых фильтров.
 *
 * Полный /fapi/v1/exchangeInfo — это несколько мегабайт, и на нестабильном канале
 * он может не догрузиться. Поэтому он загружается best-effort и НЕ блокирует старт:
 * фильтры конкретного символа всегда можно дотянуть точечным запросом
 * /fapi/v1/exchangeInfo?symbol=..., который весит килобайты.
 */
export class ExchangeInfoCache {
  private map = new Map<string, SymbolFilters>();
  private loadedAtMs = 0;
  private fullyLoaded = false;
  private readonly inFlight = new Map<string, Promise<SymbolFilters | undefined>>();
  private readonly log: Logger;
  private readonly ttlMs: number;
  private readonly fullLoadTimeoutMs: number;
  private readonly symbolLoadTimeoutMs: number;

  constructor(
    private readonly rest: BinanceRestClient,
    opts: ExchangeInfoOptions = {},
  ) {
    this.log = opts.logger ?? noopLogger;
    this.ttlMs = opts.ttlMs ?? 6 * 60 * 60_000;
    this.fullLoadTimeoutMs = opts.fullLoadTimeoutMs ?? 60_000;
    this.symbolLoadTimeoutMs = opts.symbolLoadTimeoutMs ?? 15_000;
  }

  private parse(info: RawExchangeInfo): SymbolFilters[] {
    return (info.symbols ?? []).map((s) => {
      const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
      const marketLot = s.filters.find((f) => f.filterType === 'MARKET_LOT_SIZE');
      const priceF = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      const notional = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
      return {
        symbol: s.symbol,
        // Для рыночных ордеров действует MARKET_LOT_SIZE, если он задан.
        stepSize: toNum(marketLot?.stepSize ?? lot?.stepSize, 0),
        minQty: toNum(marketLot?.minQty ?? lot?.minQty, 0),
        maxQty: toNum(marketLot?.maxQty ?? lot?.maxQty, Number.MAX_SAFE_INTEGER),
        tickSize: toNum(priceF?.tickSize, 0),
        minNotional: toNum(notional?.notional, 0),
        quantityPrecision: s.quantityPrecision ?? 8,
        pricePrecision: s.pricePrecision ?? 8,
      };
    });
  }

  /** Полная загрузка справочника. Бросает исключение — вызывающий решает, критично ли это. */
  async loadAll(force = false): Promise<void> {
    if (!force && this.fullyLoaded && Date.now() - this.loadedAtMs < this.ttlMs) return;
    const info = await this.rest.publicGet<RawExchangeInfo>(
      '/fapi/v1/exchangeInfo',
      {},
      { timeoutMs: this.fullLoadTimeoutMs, retries: 2 },
    );
    const parsed = this.parse(info);
    if (parsed.length === 0) throw new Error('exchangeInfo вернул пустой список символов');
    for (const f of parsed) this.map.set(f.symbol, f);
    this.fullyLoaded = true;
    this.loadedAtMs = Date.now();
    this.log.info('exchangeInfo загружен полностью', { symbols: this.map.size });
  }

  /** Полная загрузка, но без падения: при ошибке просто логируем и работаем точечно. */
  async loadAllBestEffort(): Promise<boolean> {
    try {
      await this.loadAll();
      return true;
    } catch (e) {
      this.log.warn('полный exchangeInfo загрузить не удалось — фильтры будут догружаться по символам', {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /** Фильтры символа: из кеша либо точечным запросом. */
  async ensure(symbol: string): Promise<SymbolFilters | undefined> {
    const key = symbol.toUpperCase();
    const cached = this.map.get(key);
    if (cached) return cached;

    const running = this.inFlight.get(key);
    if (running) return running;

    const task = (async () => {
      try {
        const info = await this.rest.publicGet<RawExchangeInfo>(
          '/fapi/v1/exchangeInfo',
          { symbol: key },
          { timeoutMs: this.symbolLoadTimeoutMs, retries: 3 },
        );
        const parsed = this.parse(info).find((f) => f.symbol === key);
        if (!parsed) {
          this.log.error('символ не найден в exchangeInfo', { symbol: key });
          return undefined;
        }
        this.map.set(key, parsed);
        this.log.debug('фильтры символа загружены', { symbol: key, stepSize: parsed.stepSize, minQty: parsed.minQty });
        return parsed;
      } catch (e) {
        this.log.error('не удалось загрузить фильтры символа', {
          symbol: key,
          error: e instanceof Error ? e.message : String(e),
        });
        return undefined;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, task);
    return task;
  }

  /** Прогрев кеша в фоне — чтобы в момент защитного действия не ждать сеть. */
  warm(symbols: Iterable<string>): void {
    for (const s of symbols) {
      const key = s.toUpperCase();
      if (this.map.has(key) || this.inFlight.has(key)) continue;
      void this.ensure(key);
    }
  }

  get(symbol: string): SymbolFilters | undefined {
    return this.map.get(symbol.toUpperCase());
  }

  set(filters: SymbolFilters): void {
    this.map.set(filters.symbol.toUpperCase(), filters);
  }

  has(symbol: string): boolean {
    return this.map.has(symbol.toUpperCase());
  }

  size(): number {
    return this.map.size;
  }

  isFullyLoaded(): boolean {
    return this.fullyLoaded;
  }
}

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
  symbols: Array<{
    symbol: string;
    contractType?: string;
    status?: string;
    quantityPrecision: number;
    pricePrecision: number;
    filters: Array<Record<string, string>>;
  }>;
}

export class ExchangeInfoCache {
  private map = new Map<string, SymbolFilters>();
  private loadedAtMs = 0;

  constructor(
    private readonly rest: BinanceRestClient,
    private readonly ttlMs = 6 * 60 * 60_000,
    private readonly log: Logger = noopLogger,
  ) {}

  async load(force = false): Promise<void> {
    if (!force && this.map.size > 0 && Date.now() - this.loadedAtMs < this.ttlMs) return;
    const info = await this.rest.publicGet<RawExchangeInfo>('/fapi/v1/exchangeInfo');
    const next = new Map<string, SymbolFilters>();
    for (const s of info.symbols ?? []) {
      const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
      const marketLot = s.filters.find((f) => f.filterType === 'MARKET_LOT_SIZE');
      const priceF = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      const notional = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
      next.set(s.symbol, {
        symbol: s.symbol,
        // Для рыночных ордеров действует MARKET_LOT_SIZE, если он задан.
        stepSize: toNum(marketLot?.stepSize ?? lot?.stepSize, 0),
        minQty: toNum(marketLot?.minQty ?? lot?.minQty, 0),
        maxQty: toNum(marketLot?.maxQty ?? lot?.maxQty, Number.MAX_SAFE_INTEGER),
        tickSize: toNum(priceF?.tickSize, 0),
        minNotional: toNum(notional?.notional, 0),
        quantityPrecision: s.quantityPrecision ?? 8,
        pricePrecision: s.pricePrecision ?? 8,
      });
    }
    this.map = next;
    this.loadedAtMs = Date.now();
    this.log.info('exchangeInfo загружен', { symbols: this.map.size });
  }

  get(symbol: string): SymbolFilters | undefined {
    return this.map.get(symbol.toUpperCase());
  }

  set(filters: SymbolFilters): void {
    this.map.set(filters.symbol.toUpperCase(), filters);
  }

  size(): number {
    return this.map.size;
  }
}

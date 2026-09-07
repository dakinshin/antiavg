import { describe, expect, it, vi } from 'vitest';
import { BinanceRestClient, BinanceApiError } from '../src/binance/rest.js';
import { ExchangeInfoCache } from '../src/binance/exchangeInfo.js';
import { isTransientNetworkError } from '../src/binance/http.js';
import type { HttpFetch, HttpResponse } from '../src/binance/http.js';

function ok(body: unknown): HttpResponse {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function fail(status: number, body: unknown): HttpResponse {
  return { ok: false, status, text: async () => JSON.stringify(body) };
}

function client(fetchImpl: HttpFetch, over: Partial<ConstructorParameters<typeof BinanceRestClient>[0]> = {}) {
  return new BinanceRestClient({
    baseUrl: 'https://example.invalid',
    apiKey: 'k',
    apiSecret: 's',
    recvWindow: 5000,
    fetchImpl,
    maxRetries: 3,
    ...over,
  });
}

describe('классификация сетевых ошибок', () => {
  it('распознаёт обрыв undici как временную ошибку', () => {
    expect(isTransientNetworkError(new TypeError('terminated'))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(isTransientNetworkError(new DOMException('The operation was aborted', 'AbortError'))).toBe(true);
    expect(isTransientNetworkError(new Error('Invalid API-key'))).toBe(false);
  });
});

describe('повторы REST-запросов', () => {
  it('GET переживает временные обрывы и добирается до ответа', async () => {
    let calls = 0;
    const rest = client(async () => {
      calls++;
      if (calls < 3) throw new TypeError('terminated');
      return ok({ serverTime: 123 });
    });
    const res = await rest.publicGet<{ serverTime: number }>('/fapi/v1/time');
    expect(res.serverTime).toBe(123);
    expect(calls).toBe(3);
  });

  it('GET сдаётся после исчерпания попыток и отдаёт понятную ошибку', async () => {
    let calls = 0;
    const rest = client(
      async () => {
        calls++;
        throw new TypeError('terminated');
      },
      { maxRetries: 2 },
    );
    await expect(rest.publicGet('/fapi/v1/exchangeInfo')).rejects.toBeInstanceOf(BinanceApiError);
    expect(calls).toBe(3);
  });

  it('POST /order НЕ повторяется — двойная отправка ордера недопустима', async () => {
    let calls = 0;
    const rest = client(async () => {
      calls++;
      throw new TypeError('terminated');
    });
    await expect(rest.signedPost('/fapi/v1/order', { symbol: 'BTCUSDT' })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('POST /listenKey повторяется — он идемпотентен', async () => {
    let calls = 0;
    const rest = client(async () => {
      calls++;
      if (calls < 3) throw new TypeError('terminated');
      return ok({ listenKey: 'KEY' });
    });
    expect(await rest.createListenKey()).toBe('KEY');
    expect(calls).toBe(3);
  });

  it('ошибка -1021 приводит к пересинхронизации времени и повтору', async () => {
    let calls = 0;
    const rest = client(async (url) => {
      calls++;
      if (url.includes('/fapi/v1/time')) return ok({ serverTime: Date.now() });
      if (calls <= 1) return fail(400, { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow' });
      return ok([{ symbol: 'BTCUSDT' }]);
    });
    const res = await rest.signedGet<unknown[]>('/fapi/v1/openOrders');
    expect(res).toHaveLength(1);
  });

  it('ошибка ключа не повторяется', async () => {
    let calls = 0;
    const rest = client(async () => {
      calls++;
      return fail(401, { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' });
    });
    await expect(rest.signedGet('/fapi/v1/openOrders')).rejects.toMatchObject({ code: -2015 });
    expect(calls).toBe(1);
  });

  it('таймаут запроса ограничен и не висит бесконечно', async () => {
    const rest = client(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      { maxRetries: 0, timeoutMs: 50 },
    );
    const t = Date.now();
    await expect(rest.publicGet('/fapi/v1/exchangeInfo')).rejects.toThrow();
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('ExchangeInfoCache: точечная загрузка вместо тяжёлого справочника', () => {
  const btc = {
    symbol: 'BTCUSDT',
    quantityPrecision: 3,
    pricePrecision: 1,
    filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'PRICE_FILTER', tickSize: '0.1' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ],
  };

  it('падение полной загрузки не мешает получить фильтры символа', async () => {
    const rest = client(async (url) => {
      if (url.includes('symbol=BTCUSDT')) return ok({ symbols: [btc] });
      throw new TypeError('terminated'); // тяжёлый запрос рвётся
    }, { maxRetries: 0 });

    const cache = new ExchangeInfoCache(rest);
    expect(await cache.loadAllBestEffort()).toBe(false);
    expect(cache.isFullyLoaded()).toBe(false);

    const f = await cache.ensure('BTCUSDT');
    expect(f?.stepSize).toBe(0.001);
    expect(cache.has('BTCUSDT')).toBe(true);
  });

  it('параллельные запросы одного символа схлопываются в один HTTP-вызов', async () => {
    let calls = 0;
    const rest = client(async () => {
      calls++;
      return ok({ symbols: [btc] });
    });
    const cache = new ExchangeInfoCache(rest);
    const [a, b, c] = await Promise.all([cache.ensure('BTCUSDT'), cache.ensure('BTCUSDT'), cache.ensure('BTCUSDT')]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('MARKET_LOT_SIZE имеет приоритет над LOT_SIZE для рыночных ордеров', async () => {
    const rest = client(async () =>
      ok({
        symbols: [
          {
            ...btc,
            filters: [
              { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
              { filterType: 'MARKET_LOT_SIZE', stepSize: '0.01', minQty: '0.01', maxQty: '100' },
            ],
          },
        ],
      }),
    );
    const cache = new ExchangeInfoCache(rest);
    const f = await cache.ensure('BTCUSDT');
    expect(f?.stepSize).toBe(0.01);
    expect(f?.maxQty).toBe(100);
  });

  it('неизвестный символ возвращает undefined, а не зависает', async () => {
    const rest = client(async () => ok({ symbols: [] }));
    const cache = new ExchangeInfoCache(rest);
    expect(await cache.ensure('NOPEUSDT')).toBeUndefined();
  });

  it('пустой список символов считается неудачной полной загрузкой', async () => {
    const rest = client(async () => ok({ symbols: [] }));
    const cache = new ExchangeInfoCache(rest);
    expect(await cache.loadAllBestEffort()).toBe(false);
  });

  it('warm не бросает исключений при недоступной сети', async () => {
    const rest = client(async () => {
      throw new TypeError('terminated');
    }, { maxRetries: 0 });
    const cache = new ExchangeInfoCache(rest);
    expect(() => cache.warm(['BTCUSDT', 'ETHUSDT'])).not.toThrow();
    await vi.waitFor(() => expect(cache.has('BTCUSDT')).toBe(false));
  });
});

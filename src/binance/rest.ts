import { createHmac } from 'node:crypto';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/logger.js';

export interface RestClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  recvWindow: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Максимум повторов для идемпотентных GET/PUT. */
  maxRetries?: number;
}

export class BinanceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'BinanceApiError';
  }
}

type Params = Record<string, string | number | boolean | undefined>;

export class BinanceRestClient {
  private readonly log: Logger;
  private readonly doFetch: typeof fetch;
  private timeOffsetMs = 0;

  constructor(private readonly opts: RestClientOptions) {
    this.log = opts.logger ?? noopLogger;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /** Синхронизация локальных часов с биржей — иначе подпись отклоняется. */
  async syncTime(): Promise<number> {
    const started = Date.now();
    const res = await this.publicGet<{ serverTime: number }>('/fapi/v1/time');
    const rtt = Date.now() - started;
    this.timeOffsetMs = res.serverTime - (started + rtt / 2);
    this.log.info('время синхронизировано с Binance', { offsetMs: Math.round(this.timeOffsetMs), rttMs: rtt });
    return this.timeOffsetMs;
  }

  private timestamp(): number {
    return Date.now() + Math.round(this.timeOffsetMs);
  }

  private qs(params: Params): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === '') continue;
      sp.append(k, String(v));
    }
    return sp.toString();
  }

  private sign(query: string): string {
    return createHmac('sha256', this.opts.apiSecret).update(query).digest('hex');
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Params,
    signed: boolean,
    retriesLeft = this.opts.maxRetries ?? 2,
  ): Promise<T> {
    let query = this.qs(params);
    if (signed) {
      const withMeta = this.qs({ ...params, recvWindow: this.opts.recvWindow, timestamp: this.timestamp() });
      query = `${withMeta}&signature=${this.sign(withMeta)}`;
    }

    const url = `${this.opts.baseUrl}${path}${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = { 'X-MBX-APIKEY': this.opts.apiKey };

    let res: Response;
    try {
      res = await this.doFetch(url, { method, headers });
    } catch (e) {
      if (retriesLeft > 0 && method !== 'POST') {
        await sleep(300);
        return this.request<T>(method, path, params, signed, retriesLeft - 1);
      }
      throw new BinanceApiError(`Сетевая ошибка ${method} ${path}: ${String(e)}`, 0);
    }

    const text = await res.text();
    if (!res.ok) {
      let code: number | undefined;
      let msg = text;
      try {
        const parsed = JSON.parse(text) as { code?: number; msg?: string };
        code = parsed.code;
        msg = parsed.msg ?? text;
      } catch {
        /* ignore */
      }
      // -1021: timestamp вне recvWindow — пересинхронизируемся и повторим один раз.
      if (code === -1021 && retriesLeft > 0) {
        await this.syncTime();
        return this.request<T>(method, path, params, signed, retriesLeft - 1);
      }
      if ((res.status === 429 || res.status >= 500) && retriesLeft > 0 && method !== 'POST') {
        await sleep(res.status === 429 ? 1000 : 400);
        return this.request<T>(method, path, params, signed, retriesLeft - 1);
      }
      throw new BinanceApiError(`Binance ${res.status} ${method} ${path}: ${msg}`, res.status, code, text);
    }

    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  publicGet<T>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>('GET', path, params, false);
  }

  signedGet<T>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>('GET', path, params, true);
  }

  signedPost<T>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>('POST', path, params, true);
  }

  signedPut<T>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>('PUT', path, params, true);
  }

  signedDelete<T>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>('DELETE', path, params, true);
  }

  /** listenKey: создание. */
  async createListenKey(): Promise<string> {
    const res = await this.request<{ listenKey: string }>('POST', '/fapi/v1/listenKey', {}, false);
    return res.listenKey;
  }

  async keepAliveListenKey(): Promise<void> {
    await this.request<unknown>('PUT', '/fapi/v1/listenKey', {}, false);
  }

  async closeListenKey(): Promise<void> {
    await this.request<unknown>('DELETE', '/fapi/v1/listenKey', {}, false);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

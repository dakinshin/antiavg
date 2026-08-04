import { createHmac } from 'node:crypto';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/logger.js';
import { createHttpFetch, isTransientNetworkError, type HttpFetch } from './http.js';

export interface RestClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  recvWindow: number;
  logger?: Logger;
  fetchImpl?: HttpFetch;
  /** Максимум повторов для идемпотентных запросов. */
  maxRetries?: number;
  /** Общий таймаут одного запроса, мс. */
  timeoutMs?: number;
  allowHttp2?: boolean;
  /** Диспетчер undici (прокси). */
  dispatcher?: import('undici').Dispatcher;
}

export interface RequestOptions {
  /** Таймаут именно этого запроса, мс (перекрывает общий). */
  timeoutMs?: number;
  /** Число повторов именно для этого запроса. */
  retries?: number;
  /** Явно пометить POST идемпотентным (например, создание listenKey). */
  idempotent?: boolean;
}

export class BinanceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly body?: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BinanceApiError';
  }

  /** Ошибка сети/таймаута — есть смысл повторить. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

type Params = Record<string, string | number | boolean | undefined>;

const DEFAULT_TIMEOUT_MS = 20_000;

export class BinanceRestClient {
  private readonly log: Logger;
  private readonly doFetch: HttpFetch;
  private readonly defaultTimeoutMs: number;
  private timeOffsetMs = 0;

  constructor(private readonly opts: RestClientOptions) {
    this.log = opts.logger ?? noopLogger;
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch =
      opts.fetchImpl ??
      createHttpFetch({
        allowHttp2: opts.allowHttp2 ?? false,
        headersTimeoutMs: Math.min(this.defaultTimeoutMs, 20_000),
        bodyTimeoutMs: this.defaultTimeoutMs,
        ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
      });
  }

  /** Синхронизация локальных часов с биржей — иначе подпись отклоняется. */
  async syncTime(): Promise<number> {
    const started = Date.now();
    const res = await this.publicGet<{ serverTime: number }>('/fapi/v1/time', {}, { timeoutMs: 10_000 });
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
    reqOpts: RequestOptions = {},
  ): Promise<T> {
    const maxRetries = reqOpts.retries ?? this.opts.maxRetries ?? 3;
    const timeoutMs = reqOpts.timeoutMs ?? this.defaultTimeoutMs;
    // POST — единственный неидемпотентный метод: повторять отправку ордера нельзя.
    const retryable = reqOpts.idempotent ?? method !== 'POST';

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let query = this.qs(params);
      if (signed) {
        // Подпись пересчитывается на каждой попытке: timestamp должен быть свежим.
        const withMeta = this.qs({ ...params, recvWindow: this.opts.recvWindow, timestamp: this.timestamp() });
        query = `${withMeta}&signature=${this.sign(withMeta)}`;
      }
      const url = `${this.opts.baseUrl}${path}${query ? `?${query}` : ''}`;
      const headers: Record<string, string> = { 'X-MBX-APIKEY': this.opts.apiKey };

      try {
        const res = await this.doFetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();

        if (res.ok) return text ? (JSON.parse(text) as T) : ({} as T);

        let code: number | undefined;
        let msg = text;
        try {
          const parsed = JSON.parse(text) as { code?: number; msg?: string };
          code = parsed.code;
          msg = parsed.msg ?? text;
        } catch {
          /* тело не JSON — оставляем как есть */
        }

        const err = new BinanceApiError(`Binance ${res.status} ${method} ${path}: ${msg}`, res.status, code, text);

        // -1021: timestamp вне recvWindow — пересинхронизируемся и пробуем снова.
        if (code === -1021 && attempt < maxRetries) {
          await this.syncTime().catch(() => undefined);
          lastError = err;
          continue;
        }
        if (retryable && err.transient && attempt < maxRetries) {
          lastError = err;
          await sleep(backoffMs(attempt, res.status === 429 ? 1500 : 500));
          this.log.warn('повтор запроса к Binance', { path, status: res.status, attempt: attempt + 1 });
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof BinanceApiError) throw e;
        const transient = isTransientNetworkError(e);
        lastError = e;
        if (retryable && transient && attempt < maxRetries) {
          await sleep(backoffMs(attempt, 500));
          this.log.warn('сетевая ошибка, повтор запроса к Binance', {
            path,
            attempt: attempt + 1,
            error: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
        throw new BinanceApiError(
          `Сетевая ошибка ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`,
          0,
          undefined,
          undefined,
          e,
        );
      }
    }

    throw lastError instanceof BinanceApiError
      ? lastError
      : new BinanceApiError(
          `Сетевая ошибка ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          0,
          undefined,
          undefined,
          lastError,
        );
  }

  publicGet<T>(path: string, params: Params = {}, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, params, false, opts);
  }

  signedGet<T>(path: string, params: Params = {}, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, params, true, opts);
  }

  signedPost<T>(path: string, params: Params = {}, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, params, true, opts);
  }

  signedPut<T>(path: string, params: Params = {}, opts?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, params, true, opts);
  }

  signedDelete<T>(path: string, params: Params = {}, opts?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, params, true, opts);
  }

  /** listenKey: создание. Подпись не требуется, только заголовок с ключом. */
  async createListenKey(): Promise<string> {
    const res = await this.request<{ listenKey: string }>('POST', '/fapi/v1/listenKey', {}, false, {
      retries: 3,
      idempotent: true,
    });
    return res.listenKey;
  }

  async keepAliveListenKey(): Promise<void> {
    await this.request<unknown>('PUT', '/fapi/v1/listenKey', {}, false);
  }

  async closeListenKey(): Promise<void> {
    await this.request<unknown>('DELETE', '/fapi/v1/listenKey', {}, false, { retries: 0, timeoutMs: 5000 });
  }
}

export function backoffMs(attempt: number, base: number): number {
  const raw = Math.min(15_000, base * 2 ** attempt);
  return raw + Math.floor(raw * 0.25 * Math.random());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

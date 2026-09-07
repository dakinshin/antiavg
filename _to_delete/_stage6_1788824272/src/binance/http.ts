/**
 * HTTP-транспорт для REST Binance.
 *
 * Зачем свой слой вместо глобального fetch:
 *  - глобальный fetch в Node может согласовать HTTP/2 по ALPN; на больших ответах
 *    (а /fapi/v1/exchangeInfo — это несколько мегабайт) через VPN и корпоративные
 *    прокси H2-поток регулярно рвётся с «TypeError: terminated». HTTP/1.1 в этой
 *    ситуации ведёт себя стабильнее;
 *  - у глобального fetch нет управляемых таймаутов на заголовки и тело, из-за чего
 *    запрос может висеть десятками секунд без единого байта.
 */
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export type HttpFetch = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

export interface HttpFetchOptions {
  /** Таймаут установки TCP/TLS соединения, мс. */
  connectTimeoutMs?: number;
  /** Таймаут ожидания заголовков ответа, мс. */
  headersTimeoutMs?: number;
  /** Таймаут между байтами тела ответа, мс. */
  bodyTimeoutMs?: number;
  /** false (по умолчанию) — принудительный HTTP/1.1. */
  allowHttp2?: boolean;
  /** Готовый диспетчер (например, прокси). Если задан, используется вместо своего Agent. */
  dispatcher?: Dispatcher;
}

export function createHttpFetch(opts: HttpFetchOptions = {}): HttpFetch {
  const agent = opts.dispatcher ?? new Agent({
    allowH2: opts.allowHttp2 ?? false,
    connect: { timeout: opts.connectTimeoutMs ?? 10_000 },
    headersTimeout: opts.headersTimeoutMs ?? 20_000,
    bodyTimeout: opts.bodyTimeoutMs ?? 60_000,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });

  return async (url, init) => {
    const res = await undiciFetch(url, {
      method: init.method,
      headers: init.headers,
      signal: init.signal ?? null,
      dispatcher: agent,
    });
    return {
      ok: res.ok,
      status: res.status,
      text: () => res.text(),
    };
  };
}

/** Признак «ошибка сети/таймаут», а не отказ биржи. Такие запросы имеет смысл повторить. */
export function isTransientNetworkError(e: unknown): boolean {
  if (!e) return false;
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const cause = (e as { cause?: unknown }).cause;
  const causeMsg = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? '');
  const code = (cause as { code?: string } | undefined)?.code ?? (e as { code?: string }).code ?? '';
  const haystack = `${msg} ${causeMsg} ${code}`;
  return /terminated|aborted|timeout|TimeoutError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed|UND_ERR/i.test(
    haystack,
  );
}

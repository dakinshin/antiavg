/**
 * Поддержка прокси.
 *
 * Зачем: у части провайдеров HTTPS до Binance проходит, а WebSocket после
 * рукопожатия молча глушится — соединение открыто, кадры не идут. Лечится
 * туннелем. REST и WebSocket настраиваются независимо: если по REST всё в
 * порядке, гнать его через прокси незачем.
 */
import type { Agent as HttpAgent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyAgent as UndiciProxyAgent, type Dispatcher } from 'undici';
import { createNodeFetch } from './nodeFetch.js';
import type { HttpFetch } from './http.js';

export type ProxyKind = 'http' | 'socks';

export interface ParsedProxy {
  url: string;
  kind: ProxyKind;
  host: string;
  port: number;
}

const SOCKS_PROTOCOLS = new Set(['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Разбирает адрес прокси. Схема обязательна и определяет тип туннеля:
 * `http://host:port` — CONNECT, `socks5://host:port` — SOCKS.
 */
export function parseProxy(raw: string | undefined): ParsedProxy | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `Некорректный адрес прокси: "${value}". Ожидается схема, например http://127.0.0.1:1080 или socks5://127.0.0.1:1080`,
    );
  }

  const kind: ProxyKind = SOCKS_PROTOCOLS.has(url.protocol)
    ? 'socks'
    : HTTP_PROTOCOLS.has(url.protocol)
      ? 'http'
      : (() => {
          throw new Error(
            `Неподдерживаемая схема прокси "${url.protocol}". Допустимы http, https, socks4, socks5.`,
          );
        })();

  return {
    url: value,
    kind,
    host: url.hostname,
    port: Number(url.port) || (kind === 'socks' ? 1080 : 8080),
  };
}

/** Агент для `ws`: подходит и для CONNECT-прокси, и для SOCKS. */
export function createWsProxyAgent(proxy: ParsedProxy | undefined): HttpAgent | undefined {
  if (!proxy) return undefined;
  return proxy.kind === 'socks'
    ? (new SocksProxyAgent(proxy.url) as unknown as HttpAgent)
    : (new HttpsProxyAgent(proxy.url) as unknown as HttpAgent);
}

/** Диспетчер undici для HTTP-прокси. Для SOCKS undici не подходит — см. createRestFetch. */
export function createRestProxyDispatcher(proxy: ParsedProxy | undefined): Dispatcher | undefined {
  if (!proxy || proxy.kind === 'socks') return undefined;
  return new UndiciProxyAgent({ uri: proxy.url });
}

/**
 * Транспорт REST с учётом прокси.
 *
 * SOCKS undici не умеет, поэтому для него берём node:https с SocksProxyAgent —
 * так REST работает через любой туннель, а не только через CONNECT.
 * Возвращает undefined, когда прокси не нужен: тогда используется обычный undici.
 */
export function createRestFetch(
  proxy: ParsedProxy | undefined,
  timeouts: { headersTimeoutMs?: number; bodyTimeoutMs?: number } = {},
): HttpFetch | undefined {
  if (!proxy || proxy.kind !== 'socks') return undefined;
  return createNodeFetch({
    agent: new SocksProxyAgent(proxy.url),
    ...timeouts,
  });
}

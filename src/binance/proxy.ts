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

/**
 * Диспетчер undici для REST. undici умеет только HTTP-прокси; для SOCKS
 * сообщаем об этом явно, а не молча ходим напрямую.
 */
export function createRestProxyDispatcher(proxy: ParsedProxy | undefined): Dispatcher | undefined {
  if (!proxy) return undefined;
  if (proxy.kind === 'socks') {
    throw new Error(
      'REST через SOCKS-прокси не поддерживается. Укажите http-прокси в BINANCE_REST_PROXY ' +
        'либо оставьте REST напрямую, а через SOCKS пустите только WebSocket (BINANCE_WS_PROXY).',
    );
  }
  return new UndiciProxyAgent({ uri: proxy.url });
}

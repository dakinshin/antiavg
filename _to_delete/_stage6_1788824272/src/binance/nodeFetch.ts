/**
 * Реализация HttpFetch поверх node:http(s).
 *
 * Нужна там, где undici не подходит: undici умеет только HTTP-прокси, а через
 * node:https можно ходить с любым http.Agent — в том числе SocksProxyAgent.
 * Так REST работает и через SOCKS, а не только через CONNECT.
 */
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { Agent as HttpAgent } from 'node:http';
import type { HttpFetch, HttpResponse } from './http.js';

export interface NodeFetchOptions {
  agent?: HttpAgent;
  /** Таймаут ожидания заголовков ответа, мс. */
  headersTimeoutMs?: number;
  /** Таймаут получения тела целиком, мс. */
  bodyTimeoutMs?: number;
}

function decompress(buffer: Buffer, encoding: string | undefined): Buffer {
  if (!encoding) return buffer;
  const enc = encoding.toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
    if (enc.includes('deflate')) return zlib.inflateSync(buffer);
  } catch {
    // Тело пришло не в объявленной кодировке — отдаём как есть.
  }
  return buffer;
}

export function createNodeFetch(opts: NodeFetchOptions = {}): HttpFetch {
  const headersTimeout = opts.headersTimeoutMs ?? 20_000;
  const bodyTimeout = opts.bodyTimeoutMs ?? 60_000;

  return (url, init) =>
    new Promise<HttpResponse>((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === 'http:' ? http : https;

      const req = transport.request(
        target,
        {
          method: init.method,
          headers: { ...init.headers, 'accept-encoding': 'gzip, deflate, br' },
          ...(opts.agent ? { agent: opts.agent } : {}),
        },
        (res) => {
          clearTimeout(headersTimer);
          const chunks: Buffer[] = [];
          const bodyTimer = setTimeout(() => {
            res.destroy(new Error(`таймаут тела ответа ${bodyTimeout} мс`));
          }, bodyTimeout);

          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            clearTimeout(bodyTimer);
            const raw = decompress(Buffer.concat(chunks), res.headers['content-encoding']);
            const status = res.statusCode ?? 0;
            const text = raw.toString('utf8');
            resolve({ ok: status >= 200 && status < 300, status, text: async () => text });
          });
          res.on('error', (e) => {
            clearTimeout(bodyTimer);
            reject(e);
          });
        },
      );

      const headersTimer = setTimeout(() => {
        req.destroy(new Error(`таймаут заголовков ${headersTimeout} мс`));
      }, headersTimeout);

      const onAbort = () => req.destroy(new Error('запрос отменён'));
      init.signal?.addEventListener('abort', onAbort, { once: true });

      req.on('error', (e) => {
        clearTimeout(headersTimer);
        init.signal?.removeEventListener('abort', onAbort);
        reject(e);
      });
      req.end();
    });
}

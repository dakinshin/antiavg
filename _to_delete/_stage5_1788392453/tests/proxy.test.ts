/**
 * Прокси проверяется по-настоящему: поднимается локальный HTTP CONNECT-прокси
 * и локальный WebSocket-сервер, после чего проверяется, что кадры реально
 * доходят через туннель.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import {
  createRestFetch,
  createRestProxyDispatcher,
  createWsProxyAgent,
  parseProxy,
} from '../src/binance/proxy.js';
import { proxyFor, testConfig } from '../src/config.js';
import { describeProbe, probeWs } from '../src/binance/wsProbe.js';
import { createNodeFetch } from '../src/binance/nodeFetch.js';

describe('разбор адреса прокси', () => {
  it('различает http и socks по схеме', () => {
    expect(parseProxy('http://127.0.0.1:1080')).toMatchObject({ kind: 'http', host: '127.0.0.1', port: 1080 });
    expect(parseProxy('socks5://127.0.0.1:1080')).toMatchObject({ kind: 'socks', port: 1080 });
    expect(parseProxy('socks://10.0.0.1')).toMatchObject({ kind: 'socks', port: 1080 });
  });

  it('пустое значение — это отсутствие прокси', () => {
    expect(parseProxy(undefined)).toBeUndefined();
    expect(parseProxy('')).toBeUndefined();
    expect(parseProxy('   ')).toBeUndefined();
  });

  it('адрес без схемы отвергается с понятным сообщением', () => {
    expect(() => parseProxy('127.0.0.1:1080')).toThrow(/схема/i);
  });

  it('неподдерживаемая схема отвергается', () => {
    expect(() => parseProxy('ftp://127.0.0.1:21')).toThrow(/схема/i);
  });

  it('для SOCKS используется node:https, а не диспетчер undici', () => {
    // undici не умеет SOCKS, поэтому диспетчера нет — вместо него отдельный транспорт.
    expect(createRestProxyDispatcher(parseProxy('socks5://127.0.0.1:1080'))).toBeUndefined();
    expect(createRestFetch(parseProxy('socks5://127.0.0.1:1080'))).toBeTypeOf('function');
  });

  it('для http-прокси используется диспетчер undici', () => {
    expect(createRestProxyDispatcher(parseProxy('http://127.0.0.1:1080'))).toBeDefined();
    expect(createRestFetch(parseProxy('http://127.0.0.1:1080'))).toBeUndefined();
  });

  it('точечная настройка перекрывает общую', () => {
    const cfg = testConfig({ proxyUrl: 'http://common:1', wsProxyUrl: 'http://ws:2' });
    expect(proxyFor(cfg, 'ws')).toBe('http://ws:2');
    expect(proxyFor(cfg, 'rest')).toBe('http://common:1');
  });

  it('без настроек прокси нет', () => {
    const cfg = testConfig();
    expect(proxyFor(cfg, 'ws')).toBeUndefined();
    expect(createWsProxyAgent(parseProxy(proxyFor(cfg, 'ws')))).toBeUndefined();
  });
});

describe('WebSocket через HTTP CONNECT-прокси', () => {
  let wss: WebSocketServer;
  let proxy: http.Server;
  let wsPort: number;
  let proxyPort: number;
  const connectTargets: string[] = [];

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', r));
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({ e: 'hello' }));
    });
    wsPort = (wss.address() as AddressInfo).port;

    // Минимальный CONNECT-прокси: туннелирует TCP как настоящий HTTP-прокси.
    proxy = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    proxy.on('connect', (req, clientSocket, head) => {
      connectTargets.push(req.url ?? '');
      const [host, port] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(() => {
    wss?.close();
    proxy?.close();
  });

  it('кадры доходят через туннель, и прокси действительно задействован', async () => {
    const agent = createWsProxyAgent(parseProxy(`http://127.0.0.1:${proxyPort}`));
    expect(agent).toBeDefined();

    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws/test`, { agent });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('через прокси не пришло ни одного кадра'));
      }, 8_000);
      ws.once('message', (data) => {
        clearTimeout(timer);
        ws.close();
        resolve(data.toString());
      });
      ws.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    expect(JSON.parse(message)).toEqual({ e: 'hello' });
    expect(connectTargets.some((t) => t.endsWith(`:${wsPort}`))).toBe(true);
  }, 15_000);
});

describe('проба WebSocket различает исходы', () => {
  it('немедленное закрытие сервером не выдаётся за «тишину»', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', r));
    server.on('connection', (socket) => socket.close(1008, 'нет такого потока'));
    const port = (server.address() as AddressInfo).port;

    const probe = await probeWs(`ws://127.0.0.1:${port}/ws/nope`, 5_000, 1);
    expect(probe.messages).toBe(0);
    expect(probe.closeCode).toBe(1008);
    expect(describeProbe(probe).text).toContain('закрылось');
    server.close();
  }, 10_000);

  it('HTTP-ответ вместо upgrade распознаётся отдельно', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(451);
      res.end('blocked');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const probe = await probeWs(`ws://127.0.0.1:${port}/ws/x`, 5_000, 1);
    expect(probe.httpStatus).toBe(451);
    expect(describeProbe(probe).text).toContain('451');
    server.close();
  }, 10_000);

  it('живой поток отдаёт кадры', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', r));
    server.on('connection', (socket) => socket.send('{"e":"tick"}'));
    const port = (server.address() as AddressInfo).port;

    const probe = await probeWs(`ws://127.0.0.1:${port}/ws/ok`, 5_000, 1);
    expect(describeProbe(probe).ok).toBe(true);
    server.close();
  }, 10_000);
});

describe('REST-транспорт через node:https (нужен для SOCKS)', () => {
  it('получает тело и статус', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ serverTime: 42 }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const f = createNodeFetch({});
    const res = await f(`http://127.0.0.1:${port}/fapi/v1/time`, { method: 'GET', headers: {} });
    expect(res.ok).toBe(true);
    expect(JSON.parse(await res.text())).toEqual({ serverTime: 42 });
    server.close();
  }, 10_000);

  it('распаковывает gzip', async () => {
    const payload = JSON.stringify({ symbols: ['BTCUSDT'] });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(Buffer.from(payload)));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const f = createNodeFetch({});
    const res = await f(`http://127.0.0.1:${port}/x`, { method: 'GET', headers: {} });
    expect(await res.text()).toBe(payload);
    server.close();
  }, 10_000);

  it('ошибочный статус не выдаётся за успех', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(451);
      res.end('{"code":-1,"msg":"blocked"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const f = createNodeFetch({});
    const res = await f(`http://127.0.0.1:${port}/x`, { method: 'GET', headers: {} });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(451);
    server.close();
  }, 10_000);

  it('таймаут заголовков срабатывает, а не висит вечно', async () => {
    const server = http.createServer(() => {
      /* молчим намеренно */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const f = createNodeFetch({ headersTimeoutMs: 200 });
    await expect(f(`http://127.0.0.1:${port}/x`, { method: 'GET', headers: {} })).rejects.toThrow(/таймаут/);
    server.close();
  }, 10_000);
});

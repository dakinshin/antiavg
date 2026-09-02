/**
 * Дымовой тест полной обвязки: поднимает заглушки REST и WebSocket Binance,
 * запускает App целиком и проверяет, что при усреднении в убытке уходит
 * реальный POST /fapi/v1/order с правильными параметрами.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { App } from '../src/app.js';
import { testConfig } from '../src/config.js';
import { noopLogger } from '../src/util/logger.js';

interface CapturedOrder {
  symbol: string;
  side: string;
  type: string;
  quantity: string;
  reduceOnly?: string;
  positionSide?: string;
}

let httpServer: http.Server;
let wss: WebSocketServer;
let restUrl: string;
let wsUrl: string;
let sockets: WebSocket[] = [];
const placedOrders: CapturedOrder[] = [];
/** Имитация «тяжёлый exchangeInfo не догружается» — ровно тот сбой, что был в бою. */
let failFullExchangeInfo = false;

function json(res: http.ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(payload);
}

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    if (p === '/fapi/v1/time') return json(res, { serverTime: Date.now() });
    if (p === '/fapi/v1/exchangeInfo') {
      const wantsSymbol = url.searchParams.has('symbol');
      if (failFullExchangeInfo && !wantsSymbol) {
        // Рвём соединение посреди ответа — так же, как это делал прокси в бою.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"symbols":[');
        res.destroy();
        return;
      }
      return json(res, {
        symbols: [
          {
            symbol: 'BTCUSDT',
            quantityPrecision: 3,
            pricePrecision: 1,
            filters: [
              { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
              { filterType: 'PRICE_FILTER', tickSize: '0.1' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
          },
        ],
      });
    }
    if (p === '/fapi/v1/positionSide/dual') return json(res, { dualSidePosition: false });
    if (p === '/fapi/v3/positionRisk' || p === '/fapi/v2/positionRisk') return json(res, []);
    if (p === '/fapi/v1/openOrders') return json(res, []);
    if (p === '/fapi/v1/userTrades') return json(res, []);
    if (p === '/fapi/v1/listenKey') return json(res, { listenKey: 'TEST_LISTEN_KEY' });
    if (p === '/fapi/v1/order' && req.method === 'POST') {
      placedOrders.push(Object.fromEntries(url.searchParams) as unknown as CapturedOrder);
      return json(res, { orderId: 999, clientOrderId: url.searchParams.get('newClientOrderId') ?? '' });
    }
    res.writeHead(404);
    res.end('{}');
  });

  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const httpPort = (httpServer.address() as AddressInfo).port;
  restUrl = `http://127.0.0.1:${httpPort}`;

  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', r));
  wss.on('connection', (socket) => sockets.push(socket));
  const wsPort = (wss.address() as AddressInfo).port;
  wsUrl = `ws://127.0.0.1:${wsPort}`;
});

afterAll(async () => {
  wss?.close();
  httpServer?.close();
});

function send(payload: unknown): void {
  for (const s of sockets) {
    if (s.readyState === 1) s.send(JSON.stringify(payload));
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseConfig() {
  return testConfig({
    apiKey: 'key',
    apiSecret: 'secret',
    restBaseUrl: restUrl,
    wsBaseUrl: wsUrl,
    dryRun: false,
    reactionMode: 'reduce',
    aggregationWindowMs: 50,
    cooldownMs: 0,
    reconcileIntervalMs: 0,
    reconstructOpenTimeOnBoot: false,
    snapshotApplyDelayMs: 10_000,
  });
}

const now = () => Date.now();

function mkOrder(over: Record<string, unknown>) {
  const t = now();
  return {
    e: 'ORDER_TRADE_UPDATE',
    E: t,
    T: t,
    o: {
      s: 'BTCUSDT',
      c: 'web_1',
      S: 'BUY',
      o: 'MARKET',
      q: '1',
      p: '0',
      ap: '0',
      x: 'NEW',
      X: 'NEW',
      i: 1,
      l: '0',
      z: '0',
      L: '0',
      T: t,
      t: 0,
      ps: 'BOTH',
      R: false,
      ...over,
    },
  };
}

/** Открывает лонг, доливает в убытке и ждёт реакции. */
async function runAveragingScenario(): Promise<void> {
  send(mkOrder({ i: 1, x: 'NEW', X: 'NEW' }));
  send(mkOrder({ i: 1, x: 'TRADE', X: 'FILLED', l: '1', z: '1', L: '50000' }));
  await wait(150);

  send(mkOrder({ i: 2, c: 'web_2', x: 'NEW', X: 'NEW', q: '0.5' }));
  send(mkOrder({ i: 2, c: 'web_2', x: 'TRADE', X: 'FILLED', q: '0.5', l: '0.5', z: '0.5', L: '46000' }));
  await wait(500);
}

describe('интеграция: App целиком', () => {
  it('отправляет защитный ордер при усреднении в убытке', async () => {
    placedOrders.length = 0;
    sockets.length = 0;
    failFullExchangeInfo = false;

    const app = new App({ cfg: baseConfig(), logger: noopLogger });
    await app.start();
    await wait(250);
    expect(sockets.length).toBeGreaterThan(0);

    await runAveragingScenario();

    expect(placedOrders).toHaveLength(1);
    expect(placedOrders[0]).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.500',
      reduceOnly: 'true',
    });
    expect(placedOrders[0]?.positionSide).toBeUndefined();

    await app.stop();
  }, 20_000);

  it('запускается и работает, даже если тяжёлый exchangeInfo обрывается', async () => {
    placedOrders.length = 0;
    sockets.length = 0;
    failFullExchangeInfo = true;

    const app = new App({ cfg: baseConfig(), logger: noopLogger });
    // Раньше здесь падал весь старт с «TypeError: terminated».
    await app.start();
    await wait(250);
    expect(sockets.length).toBeGreaterThan(0);

    await runAveragingScenario();

    // Фильтры символа догрузились точечным запросом — объём посчитан правильно.
    expect(placedOrders).toHaveLength(1);
    expect(placedOrders[0]).toMatchObject({ symbol: 'BTCUSDT', side: 'SELL', quantity: '0.500' });

    await app.stop();
    failFullExchangeInfo = false;
  }, 20_000);
});

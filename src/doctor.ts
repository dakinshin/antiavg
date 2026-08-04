/**
 * Диагностика подключения: `npm run doctor`.
 *
 * Проверяет по шагам всё, что нужно сервису для работы, и показывает, где именно
 * рвётся связь — время ответа, размер тела, коды ошибок Binance.
 */
import 'dotenv/config';
import { loadConfigFromEnv, resolveEndpoints, proxyFor } from './config.js';
import { createRestProxyDispatcher, createWsProxyAgent, parseProxy } from './binance/proxy.js';
import { BinanceRestClient } from './binance/rest.js';
import { AccountService } from './binance/account.js';
import { ExchangeInfoCache } from './binance/exchangeInfo.js';
import { createHttpFetch } from './binance/http.js';
import { createLogger } from './util/logger.js';
import WebSocket from 'ws';

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const results: StepResult[] = [];

/** Открывает WebSocket и ждёт заданное число кадров (или истечения таймаута). */
function waitForFrames(
  url: string,
  timeoutMs: number,
  needMessages: number,
  agent?: import('node:http').Agent,
): Promise<{ opened: boolean; messages: number; waitedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let opened = false;
    let messages = 0;
    const ws = agent ? new WebSocket(url, { agent }) : new WebSocket(url);

    const finish = (err?: Error) => {
      clearTimeout(timer);
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve({ opened, messages, waitedMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      if (!opened) finish(new Error(`таймаут подключения ${timeoutMs} мс`));
      else finish();
    }, timeoutMs);

    ws.once('open', () => {
      opened = true;
      if (needMessages === 0) finish();
    });
    ws.on('message', () => {
      messages++;
      if (messages >= needMessages && needMessages > 0) finish();
    });
    ws.once('error', (err: Error) => finish(err));
  });
}

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  const t = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t;
    results.push({ name, ok: true, ms, detail });
    process.stdout.write(`  ✓ ${name} — ${ms} мс${detail ? ` — ${detail}` : ''}\n`);
    return true;
  } catch (e) {
    const ms = Date.now() - t;
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, ms, detail });
    process.stdout.write(`  ✗ ${name} — ${ms} мс — ${detail}\n`);
    return false;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfigFromEnv();
  const endpoints = resolveEndpoints(cfg);
  const logger = createLogger({ level: 'warn', json: false });

  process.stdout.write(`\nДиагностика AntiAveraging\n`);
  process.stdout.write(`  REST: ${endpoints.rest}\n`);
  process.stdout.write(`  WS:   ${endpoints.ws}\n`);
  process.stdout.write(`  HTTP/2: ${cfg.allowHttp2 ? 'разрешён' : 'выключен (HTTP/1.1)'}\n`);
  process.stdout.write(`  Таймаут запроса: ${cfg.httpTimeoutMs} мс\n`);
  process.stdout.write(`  Прокси REST: ${proxyFor(cfg, 'rest') ?? 'напрямую'}\n`);
  process.stdout.write(`  Прокси WS:   ${proxyFor(cfg, 'ws') ?? 'напрямую'}\n\n`);

  const restProxy = parseProxy(proxyFor(cfg, 'rest'));
  const rest = new BinanceRestClient({
    baseUrl: endpoints.rest,
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
    recvWindow: cfg.recvWindow,
    timeoutMs: cfg.httpTimeoutMs,
    allowHttp2: cfg.allowHttp2,
    logger,
    ...(restProxy ? { dispatcher: createRestProxyDispatcher(restProxy) } : {}),
  });

  await step('синхронизация времени (/fapi/v1/time)', async () => {
    const offset = await rest.syncTime();
    const warn = Math.abs(offset) > 1000 ? ' ⚠ расхождение больше секунды' : '';
    return `смещение ${Math.round(offset)} мс${warn}`;
  });

  await step('полный exchangeInfo (тяжёлый запрос)', async () => {
    const raw = createHttpFetch({
      allowHttp2: cfg.allowHttp2,
      bodyTimeoutMs: cfg.exchangeInfoTimeoutMs,
      headersTimeoutMs: Math.min(cfg.exchangeInfoTimeoutMs, 20_000),
      ...(restProxy ? { dispatcher: createRestProxyDispatcher(restProxy) } : {}),
    });
    const res = await raw(`${endpoints.rest}/fapi/v1/exchangeInfo`, {
      method: 'GET',
      headers: { 'X-MBX-APIKEY': cfg.apiKey },
      signal: AbortSignal.timeout(cfg.exchangeInfoTimeoutMs),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    const mb = (body.length / 1024 / 1024).toFixed(2);
    return `${mb} МБ`;
  });

  await step('точечный exchangeInfo (BTCUSDT)', async () => {
    const cache = new ExchangeInfoCache(rest, { logger, symbolLoadTimeoutMs: cfg.httpTimeoutMs });
    const f = await cache.ensure('BTCUSDT');
    if (!f) throw new Error('фильтры не получены');
    return `stepSize=${f.stepSize}, minQty=${f.minQty}`;
  });

  const account = new AccountService(rest, cfg.clientOrderIdPrefix, logger);

  await step('права ключа и режим позиций (/fapi/v1/positionSide/dual)', async () => {
    const hedge = await account.isHedgeMode();
    return hedge ? 'hedge mode' : 'one-way mode';
  });

  await step('позиции (/fapi/v3|v2/positionRisk)', async () => {
    const p = await account.fetchPositions();
    return `открытых позиций: ${p.length}`;
  });

  await step('открытые ордера (/fapi/v1/openOrders)', async () => {
    const o = await account.fetchOpenOrders();
    return `открытых ордеров: ${o.length}`;
  });

  let listenKey: string | null = null;
  await step('создание listenKey', async () => {
    listenKey = await rest.createListenKey();
    return `${listenKey.slice(0, 6)}…`;
  });

  // Публичный поток отвечает непрерывно — это эталон живого WebSocket.
  const wsProxy = parseProxy(proxyFor(cfg, 'ws'));
  const wsAgent = createWsProxyAgent(wsProxy);
  const publicUrl = `${endpoints.ws}/ws/btcusdt@aggTrade`;

  const directOk = await step('данные по публичному WebSocket НАПРЯМУЮ', async () => {
    const got = await waitForFrames(publicUrl, 12_000, 1);
    if (!got.opened) throw new Error(`соединение не открылось за ${got.waitedMs} мс`);
    if (got.messages === 0) {
      throw new Error(
        `сокет открылся, но за ${got.waitedMs} мс не пришло ни одного кадра — поток глушится`,
      );
    }
    return `${got.messages} сообщ. за ${got.waitedMs} мс`;
  });

  if (wsProxy) {
    await step(`данные по публичному WebSocket ЧЕРЕЗ ПРОКСИ (${wsProxy.url})`, async () => {
      const got = await waitForFrames(publicUrl, 15_000, 1, wsAgent);
      if (!got.opened) throw new Error(`соединение через прокси не открылось за ${got.waitedMs} мс`);
      if (got.messages === 0) throw new Error(`через прокси за ${got.waitedMs} мс кадров тоже нет`);
      return `${got.messages} сообщ. за ${got.waitedMs} мс`;
    });
  } else if (!directOk) {
    process.stdout.write(
      '  · прокси не задан — укажите BINANCE_WS_PROXY, и doctor проверит его отдельным шагом\n',
    );
  }

  if (listenKey) {
    await step('подключение к user data stream', async () => {
      const got = await waitForFrames(`${endpoints.ws}/ws/${listenKey}`, 8_000, 0, wsAgent);
      if (!got.opened) throw new Error('соединение не открылось');
      return 'соединение установлено';
    });
    // listenKey намеренно НЕ удаляем: ключ общий для аккаунта, DELETE обрубил бы
    // поток работающему сервису.
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write('\n');
  if (failed.length === 0) {
    process.stdout.write('Все проверки пройдены. Сервис должен запуститься.\n\n');
    process.exit(0);
  }

  process.stdout.write(`Не пройдено проверок: ${failed.length}\n`);
  for (const f of failed) {
    if (f.name.startsWith('полный exchangeInfo')) {
      process.stdout.write(
        '  → Тяжёлый запрос не проходит. Это не блокирует работу: поставьте\n' +
          '    ANTIAVG_PRELOAD_EXCHANGE_INFO=false, фильтры будут грузиться по символам.\n',
      );
    }
    if (f.detail.includes('451')) {
      process.stdout.write('  → HTTP 451: доступ к Binance заблокирован по региону. Нужен другой канал.\n');
    }
    if (/terminated|timeout|ECONNRESET/i.test(f.detail)) {
      process.stdout.write(
        '  → Обрыв соединения. Проверьте VPN/прокси; при необходимости увеличьте\n' +
          '    BINANCE_HTTP_TIMEOUT_MS и убедитесь, что BINANCE_ALLOW_HTTP2=false.\n',
      );
    }
    if (f.name.startsWith('данные по публичному WebSocket НАПРЯМУЮ')) {
      process.stdout.write(
        '  → Прямой WebSocket до Binance не работает: рукопожатие проходит, кадры не идут.\n' +
          '    Так выглядит блокировка на стороне провайдера. Пустите поток через туннель:\n' +
          '      BINANCE_WS_PROXY=http://127.0.0.1:1080     (или socks5://127.0.0.1:1080)\n' +
          '    REST при этом можно оставить напрямую — он проходит.\n',
      );
    }
    if (f.name.startsWith('данные по публичному WebSocket ЧЕРЕЗ ПРОКСИ')) {
      process.stdout.write(
        '  → Через прокси кадры тоже не идут. Проверьте схему адреса (http:// против\n' +
          '    socks5://) и что сам прокси выпускает трафик на fstream.binance.com:443.\n',
      );
    }
    if (/-2015|-2014/.test(f.detail)) {
      process.stdout.write('  → Ключ отклонён: проверьте API key/secret, права на фьючерсы и белый список IP.\n');
    }
  }
  process.stdout.write('\n');
  process.exit(1);
}

void main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});

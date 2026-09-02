/**
 * Диагностика подключения: `npm run doctor`.
 *
 * Проверяет по шагам всё, что нужно сервису для работы, и показывает, где именно
 * рвётся связь — время ответа, размер тела, коды ошибок Binance.
 */
import 'dotenv/config';
import { loadConfigFromEnv, resolveEndpoints, proxyFor, userStreamUrl } from './config.js';
import { createRestProxyDispatcher, createWsProxyAgent, parseProxy } from './binance/proxy.js';
import { describeProbe, probeWs } from './binance/wsProbe.js';
import { BinanceRestClient } from './binance/rest.js';
import { AccountService } from './binance/account.js';
import { ExchangeInfoCache } from './binance/exchangeInfo.js';
import { createHttpFetch } from './binance/http.js';
import { createLogger } from './util/logger.js';

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const results: StepResult[] = [];

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
  process.stdout.write(`  WS:   ${endpoints.ws}${endpoints.wsPrivatePath}/<listenKey>\n`);
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

  // Матрица проб: публичный поток — эталон живого WebSocket, он шлёт кадры
  // непрерывно. Проверяем обе формы адреса и оба маршрута, чтобы отделить
  // блокировку канала от проблем с ключом.
  const wsProxy = parseProxy(proxyFor(cfg, 'ws'));
  const wsAgent = createWsProxyAgent(wsProxy);

  const routes: Array<{ name: string; agent?: import('node:http').Agent }> = [
    { name: 'напрямую' },
    ...(wsProxy ? [{ name: `через ${wsProxy.url}`, agent: wsAgent }] : []),
  ];
  const forms = [
    { name: `${endpoints.wsMarketPath}/… (новый)`, url: `${endpoints.ws}${endpoints.wsMarketPath}/btcusdt@aggTrade` },
    { name: '/ws/… (устаревший)', url: `${endpoints.ws}/ws/btcusdt@aggTrade` },
  ];

  process.stdout.write('\n  Публичный поток (эталон живого WebSocket):\n');
  let anyPublicOk = false;
  for (const route of routes) {
    for (const form of forms) {
      const label = `публичный WS ${form.name} ${route.name}`;
      const probe = await probeWs(form.url, 12_000, 1, route.agent);
      const d = describeProbe(probe);
      anyPublicOk = anyPublicOk || d.ok;
      results.push({ name: label, ok: d.ok, ms: probe.waitedMs, detail: d.text });
      process.stdout.write(`  ${d.ok ? '✓' : '✗'} ${label} — ${d.text}\n`);
    }
  }

  if (!wsProxy) {
    process.stdout.write(
      '  · прокси не задан. Чтобы проверить туннель, запустите:\n' +
        '      BINANCE_WS_PROXY=socks5://127.0.0.1:1080 npm run doctor\n',
    );
  }

  if (listenKey) {
    process.stdout.write('\n  Пользовательский поток:\n');
    for (const route of routes) {
      const label = `user data stream ${route.name}`;
      // Ждём дольше: на спокойном счёте первый кадр — это ping биржи (~3 мин),
      // поэтому «нет кадров» здесь не диагноз, важен сам факт подключения.
      const probe = await probeWs(userStreamUrl(endpoints, listenKey), 10_000, 0, route.agent);
      const ok = probe.opened && probe.closeCode === undefined && !probe.error;
      const d = describeProbe(probe);
      results.push({
        name: label,
        ok,
        ms: probe.waitedMs,
        detail: ok ? 'соединение установлено и держится' : d.text,
      });
      process.stdout.write(`  ${ok ? '✓' : '✗'} ${label} — ${ok ? 'подключено' : d.text}\n`);
    }
    // listenKey намеренно НЕ удаляем: ключ общий для аккаунта, DELETE обрубил бы
    // поток работающему сервису.
  }

  if (!anyPublicOk) {
    process.stdout.write(
      '\n  ВЫВОД: ни один маршрут не доставляет кадры WebSocket.\n' +
        '  Порядок действий:\n' +
        '    1) socks5h вместо socks5 — DNS будет резолвиться на стороне прокси:\n' +
        '         BINANCE_WS_PROXY=socks5h://127.0.0.1:1080\n' +
        '    2) убедитесь, что на 1080 действительно SOCKS, а не HTTP (или наоборот):\n' +
        '         curl -x socks5h://127.0.0.1:1080 https://fapi.binance.com/fapi/v1/ping\n' +
        '         curl -x http://127.0.0.1:1080   https://fapi.binance.com/fapi/v1/ping\n' +
        '         рабочая схема из curl — та же, что нужна в BINANCE_WS_PROXY\n' +
        '    3) проверьте, что прокси выпускает трафик на fstream.binance.com:443,\n' +
        '       а не только на списки доменов\n',
    );
  } else if (anyPublicOk) {
    const best = results.filter((r) => r.ok && r.name.startsWith('публичный WS'));
    process.stdout.write(`\n  Рабочий маршрут: ${best[0]?.name}\n`);
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

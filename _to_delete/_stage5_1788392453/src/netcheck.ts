/**
 * Сетевая триажная проверка: `npm run netcheck`.
 *
 * Отвечает на один вопрос — на каком слое и по какому маршруту рвётся связь
 * с Binance. Ключи API не нужны, проверяются только публичные эндпоинты.
 *
 * Матрица: хост × маршрут × слой.
 *   хосты   — fapi (REST, контрольный) и fstream (поток, целевой);
 *   маршруты — напрямую и через каждый заданный прокси;
 *   слои    — DNS, TLS+HTTP, WebSocket-кадры.
 *
 * Маршруты берутся из аргументов или переменных окружения:
 *   npm run netcheck -- socks5h://127.0.0.1:1080 http://127.0.0.1:1080
 */
import 'dotenv/config';
import dns from 'node:dns/promises';
import { createWsProxyAgent, parseProxy, type ParsedProxy } from './binance/proxy.js';
import { createNodeFetch } from './binance/nodeFetch.js';
import { describeProbe, probeWs } from './binance/wsProbe.js';

const REST_HOST = 'fapi.binance.com';
const STREAM_HOST = 'fstream.binance.com';

interface Route {
  name: string;
  proxy?: ParsedProxy;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function checkDns(host: string): Promise<string> {
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.map((a) => a.address).join(', ') || 'пусто';
  } catch (e) {
    return `ОШИБКА: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function checkHttp(url: string, route: Route): Promise<string> {
  const agent = createWsProxyAgent(route.proxy);
  const fetchImpl = createNodeFetch({
    ...(agent ? { agent } : {}),
    headersTimeoutMs: 12_000,
    bodyTimeoutMs: 15_000,
  });
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: {} });
    const body = await res.text();
    return `HTTP ${res.status}, ${body.length} байт, ${Date.now() - started} мс`;
  } catch (e) {
    return `ОШИБКА: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function checkWs(url: string, route: Route): Promise<{ ok: boolean; text: string }> {
  const agent = createWsProxyAgent(route.proxy);
  const probe = await probeWs(url, 12_000, 1, agent);
  return describeProbe(probe);
}

async function main(): Promise<void> {
  const fromArgs = process.argv.slice(2);
  const fromEnv = [process.env.BINANCE_WS_PROXY, process.env.BINANCE_REST_PROXY, process.env.BINANCE_PROXY];
  const proxyUrls = [...new Set([...fromArgs, ...fromEnv].filter((v): v is string => Boolean(v?.trim())))];

  const routes: Route[] = [{ name: 'напрямую' }];
  for (const url of proxyUrls) {
    try {
      const proxy = parseProxy(url);
      if (proxy) routes.push({ name: proxy.url, proxy });
    } catch (e) {
      process.stdout.write(`  ! пропускаю ${url}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  process.stdout.write('\nСетевая проверка Binance\n\n');

  process.stdout.write('DNS (локальное разрешение имён):\n');
  for (const host of [REST_HOST, STREAM_HOST]) {
    process.stdout.write(`  ${pad(host, 24)} ${await checkDns(host)}\n`);
  }

  process.stdout.write('\nHTTPS:\n');
  for (const route of routes) {
    const rest = await checkHttp(`https://${REST_HOST}/fapi/v1/ping`, route);
    const stream = await checkHttp(`https://${STREAM_HOST}/`, route);
    process.stdout.write(`  ${pad(route.name, 32)} fapi: ${rest}\n`);
    process.stdout.write(`  ${pad('', 32)} fstream: ${stream}\n`);
  }

  process.stdout.write('\nWebSocket (публичный поток, кадры идут непрерывно):\n');
  const wsResults: Array<{ route: string; form: string; ok: boolean; text: string }> = [];
  // Пути после разделения базовых URL (2026-04-23) и прежние — для сравнения.
  const forms = [
    { name: '/market/ws/… (новый)', url: `wss://${STREAM_HOST}/market/ws/btcusdt@aggTrade` },
    { name: '/market/stream?… (новый)', url: `wss://${STREAM_HOST}/market/stream?streams=btcusdt@aggTrade` },
    { name: '/ws/… (устаревший)', url: `wss://${STREAM_HOST}/ws/btcusdt@aggTrade` },
    { name: '/stream?… (устаревший)', url: `wss://${STREAM_HOST}/stream?streams=btcusdt@aggTrade` },
  ];
  for (const route of routes) {
    for (const form of forms) {
      const r = await checkWs(form.url, route);
      wsResults.push({ route: route.name, form: form.name, ...r });
      process.stdout.write(`  ${r.ok ? '✓' : '✗'} ${pad(route.name, 32)} ${pad(form.name, 22)} ${r.text}\n`);
    }
  }

  const working = wsResults.filter((r) => r.ok);
  process.stdout.write('\n');
  if (working.length > 0) {
    const best = working[0]!;
    process.stdout.write(`ИТОГ: WebSocket работает — маршрут «${best.route}», форма ${best.form}.\n`);
    if (best.form.includes('устаревший')) {
      process.stdout.write('Внимание: работает только устаревший путь — проверьте настройки.\n');
    }
    if (best.route !== 'напрямую') {
      process.stdout.write(`Пропишите в .env:\n  BINANCE_WS_PROXY=${best.route}\n`);
    }
  } else {
    process.stdout.write('ИТОГ: кадры WebSocket не идут ни по одному маршруту.\n\n');
    process.stdout.write('Если молчат ВСЕ формы, включая новые /market/... — дело в канале.\n');
    process.stdout.write('Если молчат только устаревшие /ws и /stream — это нормально:\n');
    process.stdout.write('корневые пути отключены Binance 2026-04-23.\n\n');
    process.stdout.write('Смотрите строки выше:\n');
    process.stdout.write('  · HTTPS до fstream работает, а кадров нет — режется именно поток;\n');
    process.stdout.write('  · HTTPS до fstream не работает, а до fapi работает — прокси или\n');
    process.stdout.write('    провайдер выпускает не все хосты Binance;\n');
    process.stdout.write('  · DNS вернул адреса из приватных диапазонов — имя подменяется,\n');
    process.stdout.write('    нужен socks5h (разрешение имён на стороне прокси).\n');
  }
  process.stdout.write('\n');
}

void main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});

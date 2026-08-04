import { z } from 'zod';

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  });

const numFromEnv = (fallback: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    });

const csvList = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return [] as string[];
    const arr = Array.isArray(v) ? v : v.split(',');
    return arr.map((s) => s.trim().toUpperCase()).filter(Boolean);
  });

export const ConfigSchema = z.object({
  /** --- Доступ --- */
  apiKey: z.string().min(1, 'BINANCE_API_KEY обязателен'),
  apiSecret: z.string().min(1, 'BINANCE_API_SECRET обязателен'),
  testnet: boolFromEnv.default(false),
  restBaseUrl: z.string().optional(),
  wsBaseUrl: z.string().optional(),
  recvWindow: numFromEnv(5000),
  /** Общий таймаут одного HTTP-запроса к Binance, мс. */
  httpTimeoutMs: numFromEnv(20_000),
  /** Таймаут полной загрузки exchangeInfo (несколько мегабайт), мс. */
  exchangeInfoTimeoutMs: numFromEnv(60_000),
  /**
   * Разрешить HTTP/2. По умолчанию выключено: на больших ответах через VPN и прокси
   * H2-поток регулярно рвётся с «TypeError: terminated».
   */
  allowHttp2: boolFromEnv.default(false),
  /**
   * Грузить полный справочник символов при старте. Если false (или если загрузка
   * не удалась), фильтры догружаются точечно по каждому символу.
   */
  preloadExchangeInfo: boolFromEnv.default(true),
  /** Пауза перед повторной попыткой запуска при сетевой ошибке, мс. 0 — не повторять. */
  startupRetryMs: numFromEnv(15_000),

  /** --- Что охраняем --- */
  /** Пустой список = все символы. */
  symbols: csvList,
  /** Символы-исключения (имеют приоритет над symbols). */
  excludeSymbols: csvList,

  /** --- Правило детекции --- */
  /**
   * Порог «убыточности» долива в процентах от средней цены входа.
   * 0 — любое исполнение хуже средней входа считается усреднением в убытке.
   * 0.1 — только если цена долива хуже средней входа минимум на 0.1%.
   */
  lossThresholdPct: numFromEnv(0),
  /**
   * false (по умолчанию): лимитные/стоп-ордера, РАЗМЕЩЁННЫЕ ДО открытия позиции
   * (вход сеткой), усреднением не считаются.
   * true: считаются усреднением независимо от времени размещения.
   */
  countPreexistingOrders: boolFromEnv.default(false),
  /**
   * Что делать, если время открытия позиции неизвестно (позиция была открыта до
   * запуска сервиса и восстановить время по сделкам не удалось).
   *   'skip'  — не реагировать (по умолчанию, безопасно);
   *   'react' — считать любой долив в убытке усреднением.
   */
  unknownOpenTimePolicy: z.enum(['skip', 'react']).default('skip'),
  /** Пытаться восстановить время открытия позиций по истории сделок при старте. */
  reconstructOpenTimeOnBoot: boolFromEnv.default(true),
  /** Глубина восстановления по сделкам, часов назад. */
  reconstructLookbackHours: numFromEnv(24 * 7),
  /** Минимальный объём долива (в базовой валюте), ниже которого игнорируем. */
  minAveragingQty: numFromEnv(0),
  /**
   * Резервная детекция по REST-сверке: если исполнения не приходят по WebSocket,
   * усреднение вычисляется из движения объёма и средней цены входа между снимками.
   */
  restFallbackDetection: boolFromEnv.default(false),
  /**
   * Через сколько миллисекунд молчания WebSocket считать поток мёртвым и
   * переключить сверку на частый опрос. 0 — не переключать.
   */
  wsSilenceTimeoutMs: numFromEnv(45_000),
  /** Интервал частой сверки, когда WebSocket молчит, мс. */
  fallbackPollIntervalMs: numFromEnv(3000),

  /** --- Реакция --- */
  /** 'reduce' — срезать ровно добавленный объём; 'close' — закрыть позицию целиком. */
  reactionMode: z.enum(['reduce', 'close']).default('reduce'),
  /** true — только логировать и не отправлять реальные ордера. */
  dryRun: boolFromEnv.default(true),
  /**
   * Окно агрегации частичных исполнений (мс): несколько fill'ов одного лимитника
   * схлопываются в один защитный ордер.
   */
  aggregationWindowMs: numFromEnv(600),
  /** Пауза между защитными действиями по одной позиции (мс). */
  cooldownMs: numFromEnv(3000),
  /**
   * Что делать, если рассчитанный объём срезки меньше minQty биржи:
   *   'skip'  — пропустить с предупреждением (по умолчанию);
   *   'close' — закрыть позицию целиком.
   */
  onQtyBelowMin: z.enum(['skip', 'close']).default('skip'),
  /** Отменять оставшиеся открытые ордера по символу после реакции. */
  cancelOpenOrdersOnReaction: boolFromEnv.default(false),
  /** Префикс clientOrderId для собственных защитных ордеров. */
  clientOrderIdPrefix: z.string().default('antiavg'),

  /** --- Служебное --- */
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  logJson: boolFromEnv.default(false),
  /** Печатать каждое сырое событие WebSocket — для диагностики «сервис молчит». */
  logRawEvents: boolFromEnv.default(false),
  /** Периодический отчёт о счётчиках событий и позиций, мс. 0 — выключено. */
  statsIntervalMs: numFromEnv(300_000),
  /** Периодическая сверка состояния с REST, мс (0 — выключено). */
  reconcileIntervalMs: numFromEnv(60_000),
  /** Задержка применения снимка из ACCOUNT_UPDATE, мс. */
  snapshotApplyDelayMs: numFromEnv(1500),
  /** Интервал keepalive listenKey, мс. */
  listenKeyKeepAliveMs: numFromEnv(30 * 60_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export const PROD_REST = 'https://fapi.binance.com';
export const PROD_WS = 'wss://fstream.binance.com';
export const TESTNET_REST = 'https://testnet.binancefuture.com';
export const TESTNET_WS = 'wss://stream.binancefuture.com';

export interface ResolvedEndpoints {
  rest: string;
  ws: string;
}

export function resolveEndpoints(cfg: Config): ResolvedEndpoints {
  return {
    rest: cfg.restBaseUrl ?? (cfg.testnet ? TESTNET_REST : PROD_REST),
    ws: cfg.wsBaseUrl ?? (cfg.testnet ? TESTNET_WS : PROD_WS),
  };
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = {
    apiKey: env.BINANCE_API_KEY ?? '',
    apiSecret: env.BINANCE_API_SECRET ?? '',
    testnet: env.BINANCE_TESTNET ?? 'false',
    restBaseUrl: env.BINANCE_REST_URL || undefined,
    wsBaseUrl: env.BINANCE_WS_URL || undefined,
    recvWindow: env.BINANCE_RECV_WINDOW,
    httpTimeoutMs: env.BINANCE_HTTP_TIMEOUT_MS,
    exchangeInfoTimeoutMs: env.BINANCE_EXCHANGE_INFO_TIMEOUT_MS,
    allowHttp2: env.BINANCE_ALLOW_HTTP2 ?? 'false',
    preloadExchangeInfo: env.ANTIAVG_PRELOAD_EXCHANGE_INFO ?? 'true',
    startupRetryMs: env.ANTIAVG_STARTUP_RETRY_MS,

    symbols: env.ANTIAVG_SYMBOLS,
    excludeSymbols: env.ANTIAVG_EXCLUDE_SYMBOLS,

    lossThresholdPct: env.ANTIAVG_LOSS_THRESHOLD_PCT,
    countPreexistingOrders: env.ANTIAVG_COUNT_PREEXISTING_ORDERS ?? 'false',
    unknownOpenTimePolicy: env.ANTIAVG_UNKNOWN_OPEN_TIME_POLICY ?? 'skip',
    reconstructOpenTimeOnBoot: env.ANTIAVG_RECONSTRUCT_OPEN_TIME ?? 'true',
    reconstructLookbackHours: env.ANTIAVG_RECONSTRUCT_LOOKBACK_HOURS,
    minAveragingQty: env.ANTIAVG_MIN_AVERAGING_QTY,
    restFallbackDetection: env.ANTIAVG_REST_FALLBACK ?? 'false',
    wsSilenceTimeoutMs: env.ANTIAVG_WS_SILENCE_TIMEOUT_MS,
    fallbackPollIntervalMs: env.ANTIAVG_FALLBACK_POLL_INTERVAL_MS,

    reactionMode: env.ANTIAVG_REACTION_MODE ?? 'reduce',
    dryRun: env.ANTIAVG_DRY_RUN ?? 'true',
    aggregationWindowMs: env.ANTIAVG_AGGREGATION_WINDOW_MS,
    cooldownMs: env.ANTIAVG_COOLDOWN_MS,
    onQtyBelowMin: env.ANTIAVG_ON_QTY_BELOW_MIN ?? 'skip',
    cancelOpenOrdersOnReaction: env.ANTIAVG_CANCEL_OPEN_ORDERS ?? 'false',
    clientOrderIdPrefix: env.ANTIAVG_CLIENT_ORDER_ID_PREFIX ?? 'antiavg',

    logLevel: env.LOG_LEVEL ?? 'info',
    logJson: env.LOG_JSON ?? 'false',
    logRawEvents: env.ANTIAVG_LOG_RAW_EVENTS ?? 'false',
    statsIntervalMs: env.ANTIAVG_STATS_INTERVAL_MS,
    reconcileIntervalMs: env.ANTIAVG_RECONCILE_INTERVAL_MS,
    snapshotApplyDelayMs: env.ANTIAVG_SNAPSHOT_APPLY_DELAY_MS,
    listenKeyKeepAliveMs: env.ANTIAVG_LISTEN_KEY_KEEPALIVE_MS,
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Некорректная конфигурация:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

/** Удобно для тестов: конфиг с дефолтами и без обязательных ключей. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = ConfigSchema.parse({ apiKey: 'test', apiSecret: 'test' });
  return { ...base, ...overrides };
}

export function isSymbolWatched(cfg: Config, symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (cfg.excludeSymbols.includes(s)) return false;
  if (cfg.symbols.length === 0) return true;
  return cfg.symbols.includes(s);
}

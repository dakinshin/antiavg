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
  /** Путь пользовательского потока. По умолчанию /private/ws (после разделения URL). */
  wsPrivatePath: z.string().optional(),
  /** Путь рыночных потоков. По умолчанию /market/ws. */
  wsMarketPath: z.string().optional(),
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
  /**
   * Прокси для обоих транспортов. Схема обязательна:
   * http://127.0.0.1:1080 или socks5://127.0.0.1:1080.
   */
  proxyUrl: z.string().optional(),
  /** Прокси только для WebSocket (перекрывает proxyUrl). */
  wsProxyUrl: z.string().optional(),
  /** Прокси только для REST (перекрывает proxyUrl). Поддерживается только http/https. */
  restProxyUrl: z.string().optional(),

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
  /**
   * Предохранитель: максимум защитных ордеров в час по всему счёту.
   * Ограничивает ущерб от ошибки в логике или от шторма событий. 0 — без лимита.
   */
  maxActionsPerHour: numFromEnv(30),
  /**
   * Профилактика: снимать ещё не исполненные лимитные и стоп-ордера, которые
   * при срабатывании стали бы усреднением в убытке. Дешевле реакции постфактум —
   * не нужно рыночного ордера и нет проскальзывания.
   */
  cancelDangerousOrders: boolFromEnv.default(true),
  /**
   * Самоограничение: не давать выключить защиту, пока хоть одна позиция сидит
   * в просадке. Смысл в том, чтобы нельзя было отключить сервис в момент
   * слабости и тут же усредниться. Снимается, когда позиция закрыта или вышла
   * в плюс.
   */
  lockStopWhileInDrawdown: boolFromEnv.default(true),
  /**
   * Строгий вариант того же замка: при просадке запрещены ЛЮБЫЕ изменения
   * настроек, а не только ослабляющие защиту. По умолчанию выключен — это
   * заметное неудобство, и включать его человек должен осознанно.
   */
  lockSettingsWhileInDrawdown: boolFromEnv.default(false),
  /**
   * Минимальный нереализованный убыток (в валюте котировки), при котором
   * замок срабатывает. 0 — любой минус. Полезно, если раздражают копеечные
   * просадки от комиссии.
   */
  drawdownLockMinLoss: numFromEnv(0),
  /** --- Лимит объёма позиции --- */
  /**
   * Ограничивать номинал позиции величиной `maxPositionLeverage × депозит`.
   * Проверяется после каждого исполнения, в том числе при доливе в прибыльную
   * позицию: правило про объём не зависит от того, в плюсе позиция или в минусе.
   */
  maxPositionEnabled: boolFromEnv.default(false),
  /** Во сколько раз номинал позиции может превышать депозит. */
  maxPositionLeverage: numFromEnv(3),

  /** --- Дефолтный стоп --- */
  /**
   * Если через defaultStopDelayMs после открытия позиции стоп так и не появился,
   * выставить свой. Позиция без стопа — это неограниченный убыток, и молчаливо
   * соглашаться на него сервис не должен.
   */
  defaultStopEnabled: boolFromEnv.default(false),
  /** Отступ дефолтного стопа от средней цены входа, % от цены. */
  defaultStopPct: numFromEnv(1),
  /**
   * По какой цене срабатывают стопы, которые ставит сервис.
   *
   * `CONTRACT_PRICE` (по умолчанию) — по цене последней сделки. Срабатывает
   * мгновенно и ровно там, где человек видит уровень в стакане. Так же Binance
   * ставит стопы, выставленные руками, — значит, свои и наши ведут себя
   * одинаково, и это важнее теоретических выгод: инструмент, который срабатывает
   * не там, где ожидаешь, перестают понимать.
   *
   * `MARK_PRICE` — по марку: медиана из индекса, индекса со сглаженным базисом
   * и цены сделки, с данными раз в секунду. По нему биржа считает ликвидацию, и
   * он не ловится на проколы стакана — но срабатывает с задержкой около секунды
   * и расходится с тем, что видно глазами.
   */
  stopWorkingType: z.enum(['MARK_PRICE', 'CONTRACT_PRICE']).default('CONTRACT_PRICE'),
  /** Сколько ждать пользовательский стоп, прежде чем выставить свой, мс. */
  defaultStopDelayMs: numFromEnv(2000),

  /** --- Защита стоп-ордера от снятия --- */
  /** Снятый стоп восстанавливать на прежнем месте, пока позиция открыта. */
  protectStopOrders: boolFromEnv.default(false),

  /** --- Лимит риска по позиции --- */
  /**
   * Жёстко ограничивать риск (расстояние до стопа × объём) долей депозита.
   * Выключено — сервис только уведомляет о состоянии риска, ничего не меняя.
   */
  maxRiskEnabled: boolFromEnv.default(false),
  /** Предельный риск по одной позиции, % от депозита. */
  maxRiskPct: numFromEnv(2),
  /** Сколько держать значение депозита из кеша, мс. */
  balanceCacheMs: numFromEnv(30_000),

  /** --- Защита от FOMO --- */
  /**
   * Серия коротких стоп-аутов подряд — признак торговли «на эмоциях», когда
   * убытки уже не осмысляются. Реакция на неё:
   *   'off'    — не следить;
   *   'notify' — сигнализировать в трей, счёт не трогать;
   *   'block'  — сигнализировать И заблокировать торговлю: снять заявки,
   *              закрыть позиции по рынку, держать счёт пустым fomoBlockMs.
   *
   * По умолчанию 'block': смысл защиты именно в том, чтобы остановить руку,
   * а уведомление в этом состоянии человек просто закроет.
   */
  fomoMode: z.enum(['off', 'notify', 'block']).default('block'),
  /** Окно, в которое должна уместиться серия, мс. */
  fomoWindowMs: numFromEnv(30_000),
  /** Сколько стоп-аутов подряд образуют серию. */
  fomoStopLossCount: numFromEnv(3),
  /** Максимальная длительность одной сделки серии, мс. */
  fomoMaxTradeDurationMs: numFromEnv(5000),
  /** Сколько держать блокировку торговли, мс. */
  fomoBlockMs: numFromEnv(300_000),

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
  /**
   * Насколько долго WebSocket должен молчать, чтобы расхождение при сверке
   * считалось признаком мёртвого потока, а не гонкой снимка и исполнения.
   */
  desyncReconnectSilenceMs: numFromEnv(20_000),
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

/**
 * Разделение базовых URL WebSocket (анонс Binance от 2026-03-06).
 *
 * Раньше и рыночные, и пользовательские потоки жили в корне: `/ws` и `/stream`.
 * С 2026-04-23 корневые пути окончательно отключены, трафик разведён по типам:
 *   рыночные данные   -> /market/ws/<поток>,  /market/stream?streams=...
 *   пользовательские  -> /private/ws/<listenKey>, /private/stream
 * Подключение к отключённому пути внешне выглядит как «сокет открыт, кадров нет».
 */
export const WS_PRIVATE_PATH = '/private/ws';
export const WS_MARKET_PATH = '/market/ws';
export const WS_LEGACY_PATH = '/ws';

export interface ResolvedEndpoints {
  rest: string;
  ws: string;
  /** Полный путь к пользовательскому потоку без listenKey. */
  wsPrivatePath: string;
  /** Полный путь к рыночным потокам без имени потока. */
  wsMarketPath: string;
}

export function resolveEndpoints(cfg: Config): ResolvedEndpoints {
  return {
    rest: cfg.restBaseUrl ?? (cfg.testnet ? TESTNET_REST : PROD_REST),
    ws: cfg.wsBaseUrl ?? (cfg.testnet ? TESTNET_WS : PROD_WS),
    wsPrivatePath: cfg.wsPrivatePath ?? WS_PRIVATE_PATH,
    wsMarketPath: cfg.wsMarketPath ?? WS_MARKET_PATH,
  };
}

/** Адрес пользовательского потока. */
export function userStreamUrl(endpoints: ResolvedEndpoints, listenKey: string): string {
  return `${endpoints.ws}${endpoints.wsPrivatePath}/${listenKey}`;
}

/** Адрес рыночного потока. */
export function marketStreamUrl(endpoints: ResolvedEndpoints, stream: string): string {
  return `${endpoints.ws}${endpoints.wsMarketPath}/${stream}`;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = {
    apiKey: env.BINANCE_API_KEY ?? '',
    apiSecret: env.BINANCE_API_SECRET ?? '',
    testnet: env.BINANCE_TESTNET ?? 'false',
    restBaseUrl: env.BINANCE_REST_URL || undefined,
    wsBaseUrl: env.BINANCE_WS_URL || undefined,
    wsPrivatePath: env.BINANCE_WS_PRIVATE_PATH || undefined,
    wsMarketPath: env.BINANCE_WS_MARKET_PATH || undefined,
    recvWindow: env.BINANCE_RECV_WINDOW,
    httpTimeoutMs: env.BINANCE_HTTP_TIMEOUT_MS,
    exchangeInfoTimeoutMs: env.BINANCE_EXCHANGE_INFO_TIMEOUT_MS,
    allowHttp2: env.BINANCE_ALLOW_HTTP2 ?? 'false',
    preloadExchangeInfo: env.ANTIAVG_PRELOAD_EXCHANGE_INFO ?? 'true',
    startupRetryMs: env.ANTIAVG_STARTUP_RETRY_MS,
    proxyUrl: env.BINANCE_PROXY || undefined,
    wsProxyUrl: env.BINANCE_WS_PROXY || undefined,
    restProxyUrl: env.BINANCE_REST_PROXY || undefined,

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
    cancelDangerousOrders: env.ANTIAVG_CANCEL_DANGEROUS_ORDERS ?? 'true',
    lockStopWhileInDrawdown: env.ANTIAVG_LOCK_STOP_IN_DRAWDOWN ?? 'true',
    lockSettingsWhileInDrawdown: env.ANTIAVG_LOCK_SETTINGS_IN_DRAWDOWN ?? 'false',
    drawdownLockMinLoss: env.ANTIAVG_DRAWDOWN_LOCK_MIN_LOSS,
    maxPositionEnabled: env.ANTIAVG_MAX_POSITION_ENABLED ?? 'false',
    maxPositionLeverage: env.ANTIAVG_MAX_POSITION_LEVERAGE,
    defaultStopEnabled: env.ANTIAVG_DEFAULT_STOP_ENABLED ?? 'false',
    defaultStopPct: env.ANTIAVG_DEFAULT_STOP_PCT,
    stopWorkingType: env.ANTIAVG_STOP_WORKING_TYPE ?? 'CONTRACT_PRICE',
    defaultStopDelayMs: env.ANTIAVG_DEFAULT_STOP_DELAY_MS,
    protectStopOrders: env.ANTIAVG_PROTECT_STOP_ORDERS ?? 'false',
    maxRiskEnabled: env.ANTIAVG_MAX_RISK_ENABLED ?? 'false',
    maxRiskPct: env.ANTIAVG_MAX_RISK_PCT,
    balanceCacheMs: env.ANTIAVG_BALANCE_CACHE_MS,
    fomoMode: env.ANTIAVG_FOMO_MODE ?? 'block',
    fomoWindowMs: env.ANTIAVG_FOMO_WINDOW_MS,
    fomoStopLossCount: env.ANTIAVG_FOMO_COUNT,
    fomoMaxTradeDurationMs: env.ANTIAVG_FOMO_MAX_TRADE_MS,
    fomoBlockMs: env.ANTIAVG_FOMO_BLOCK_MS,
    maxActionsPerHour: env.ANTIAVG_MAX_ACTIONS_PER_HOUR,
    cancelOpenOrdersOnReaction: env.ANTIAVG_CANCEL_OPEN_ORDERS ?? 'false',
    clientOrderIdPrefix: env.ANTIAVG_CLIENT_ORDER_ID_PREFIX ?? 'antiavg',

    logLevel: env.LOG_LEVEL ?? 'info',
    logJson: env.LOG_JSON ?? 'false',
    logRawEvents: env.ANTIAVG_LOG_RAW_EVENTS ?? 'false',
    statsIntervalMs: env.ANTIAVG_STATS_INTERVAL_MS,
    reconcileIntervalMs: env.ANTIAVG_RECONCILE_INTERVAL_MS,
    desyncReconnectSilenceMs: env.ANTIAVG_DESYNC_RECONNECT_SILENCE_MS,
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

/** Адрес прокси для конкретного транспорта с учётом общего значения. */
export function proxyFor(cfg: Config, kind: 'ws' | 'rest'): string | undefined {
  return (kind === 'ws' ? cfg.wsProxyUrl : cfg.restProxyUrl) ?? cfg.proxyUrl;
}

export function isSymbolWatched(cfg: Config, symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (cfg.excludeSymbols.includes(s)) return false;
  if (cfg.symbols.length === 0) return true;
  return cfg.symbols.includes(s);
}

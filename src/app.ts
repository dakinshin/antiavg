import type { Config } from './config.js';
import { resolveEndpoints, isSymbolWatched } from './config.js';
import { BinanceRestClient } from './binance/rest.js';
import { ExchangeInfoCache } from './binance/exchangeInfo.js';
import { AccountService } from './binance/account.js';
import { BinanceExecutor } from './binance/executor.js';
import { UserDataStream } from './binance/userDataStream.js';
import {
  isFillEvent,
  toFillEvent,
  toOrderLifecycleEvent,
  toPositionSnapshots,
  type RawAccountUpdate,
  type RawOrderTradeUpdate,
  type RawUserDataEvent,
} from './binance/mappers.js';
import { Engine } from './core/engine.js';
import type { Logger } from './util/logger.js';
import { positionKey } from './types.js';
import { isZero } from './util/num.js';

export interface AppDeps {
  cfg: Config;
  logger: Logger;
}

export class App {
  private readonly rest: BinanceRestClient;
  private readonly exchangeInfo: ExchangeInfoCache;
  private readonly account: AccountService;
  private stream: UserDataStream | null = null;
  private engine: Engine | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private hedgeMode = false;
  /** Счётчики событий по типам — чтобы было видно, что поток вообще живой. */
  private readonly eventCounts = new Map<string, number>();

  constructor(private readonly deps: AppDeps) {
    const endpoints = resolveEndpoints(deps.cfg);
    this.rest = new BinanceRestClient({
      baseUrl: endpoints.rest,
      apiKey: deps.cfg.apiKey,
      apiSecret: deps.cfg.apiSecret,
      recvWindow: deps.cfg.recvWindow,
      timeoutMs: deps.cfg.httpTimeoutMs,
      allowHttp2: deps.cfg.allowHttp2,
      logger: deps.logger.child({ mod: 'rest' }),
    });
    this.exchangeInfo = new ExchangeInfoCache(this.rest, {
      logger: deps.logger.child({ mod: 'exchangeInfo' }),
      fullLoadTimeoutMs: deps.cfg.exchangeInfoTimeoutMs,
      symbolLoadTimeoutMs: Math.min(deps.cfg.httpTimeoutMs, 15_000),
    });
    this.account = new AccountService(
      this.rest,
      deps.cfg.clientOrderIdPrefix,
      deps.logger.child({ mod: 'account' }),
    );
  }

  async start(): Promise<void> {
    const { cfg, logger } = this.deps;
    const endpoints = resolveEndpoints(cfg);

    logger.info('запуск anti-averaging', {
      testnet: cfg.testnet,
      rest: endpoints.rest,
      ws: endpoints.ws,
      reactionMode: cfg.reactionMode,
      dryRun: cfg.dryRun,
      lossThresholdPct: cfg.lossThresholdPct,
      countPreexistingOrders: cfg.countPreexistingOrders,
      symbols: cfg.symbols.length ? cfg.symbols : 'ВСЕ',
    });
    if (cfg.dryRun) {
      logger.warn('DRY RUN включён — реальные ордера отправляться не будут (ANTIAVG_DRY_RUN=false для боевого режима)');
    }

    await this.rest.syncTime();

    // Полный справочник символов весит несколько мегабайт. Если он не догрузится,
    // старт не отменяется: фильтры нужного символа подтянутся точечно.
    if (cfg.preloadExchangeInfo) {
      await this.exchangeInfo.loadAllBestEffort();
    } else {
      logger.info('предзагрузка exchangeInfo отключена, фильтры грузятся по символам');
    }

    const snapshot = await this.account.snapshot();
    this.hedgeMode = snapshot.hedgeMode;
    logger.info('режим позиций', { hedgeMode: this.hedgeMode });

    const executor = new BinanceExecutor({
      cfg,
      rest: this.rest,
      exchangeInfo: this.exchangeInfo,
      logger: logger.child({ mod: 'executor' }),
      hedgeMode: this.hedgeMode,
    });

    this.engine = new Engine({
      cfg,
      executor,
      logger: logger.child({ mod: 'engine' }),
    });

    await this.bootstrapState(snapshot.positions, snapshot.openOrders, true);

    this.stream = new UserDataStream({
      rest: this.rest,
      wsBaseUrl: endpoints.ws,
      keepAliveMs: cfg.listenKeyKeepAliveMs,
      logger: logger.child({ mod: 'ws' }),
      onEvent: (evt) => this.handleEvent(evt),
      onConnected: (attempt) => {
        if (attempt > 0 || this.engine) void this.reconcile('после подключения');
      },
    });
    await this.stream.start();

    if (cfg.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => {
        void this.reconcile('по расписанию');
      }, cfg.reconcileIntervalMs);
      if (typeof this.reconcileTimer.unref === 'function') this.reconcileTimer.unref();
    }

    if (cfg.statsIntervalMs > 0) {
      this.statsTimer = setInterval(() => {
        const engine = this.engine;
        if (!engine) return;
        logger.info('состояние сервиса', {
          ...engine.stats(),
          ws: this.stream?.stats(),
          события: Object.fromEntries(this.eventCounts),
        });
      }, cfg.statsIntervalMs);
      if (typeof this.statsTimer.unref === 'function') this.statsTimer.unref();
    }

    logger.info('сервис готов, слежу за усреднением в убытке');
  }

  private async bootstrapState(
    positions: Awaited<ReturnType<AccountService['fetchPositions']>>,
    openOrders: Awaited<ReturnType<AccountService['fetchOpenOrders']>>,
    initial: boolean,
  ): Promise<void> {
    const { cfg, logger } = this.deps;
    const engine = this.engine;
    if (!engine) return;

    const watched = positions.filter((p) => isSymbolWatched(cfg, p.symbol));

    // Время открытия восстанавливаем только для позиций, по которым мы его ещё не знаем:
    // это запрос истории сделок на каждый символ, гонять его каждую минуту незачем.
    const needOpenTime = watched.filter((p) => {
      const known = engine.positions.peek(p.symbol, p.positionSide);
      return !(known && !isZero(known.qty) && known.openTimeKnown && known.openedAtMs !== null);
    });

    let openTimes = new Map<string, number | null>();
    if (cfg.reconstructOpenTimeOnBoot && needOpenTime.length > 0) {
      openTimes = await this.account
        .resolveOpenTimes(needOpenTime, cfg.reconstructLookbackHours)
        .catch((e: unknown) => {
          logger.warn('восстановление времён открытия не удалось', { error: String(e) });
          return new Map<string, number | null>();
        });
    }

    engine.seedOrders(openOrders);
    engine.seedPositions(watched, openTimes);

    // Прогреваем фильтры символов, по которым уже есть позиции или ордера, чтобы
    // в момент защитного действия не ждать сеть.
    this.exchangeInfo.warm([
      ...new Set([...watched.map((p) => p.symbol), ...openOrders.map((o) => o.symbol)]),
    ]);

    if (initial) {
      for (const p of watched) {
        const key = positionKey(p.symbol, p.positionSide);
        const openedAt = openTimes.get(key) ?? null;
        logger.info('позиция на старте', {
          symbol: p.symbol,
          positionSide: p.positionSide,
          qty: p.qty,
          entryPrice: p.entryPrice,
          openedAt: openedAt ? new Date(openedAt).toISOString() : 'неизвестно',
          policyIfUnknown: openedAt === null ? cfg.unknownOpenTimePolicy : undefined,
        });
      }
      logger.info('состояние загружено', {
        positions: watched.length,
        openOrders: openOrders.length,
      });
    }
  }

  private async reconcile(reason: string): Promise<void> {
    const { logger } = this.deps;
    if (!this.engine) return;
    try {
      const [positions, openOrders] = await Promise.all([
        this.account.fetchPositions(),
        this.account.fetchOpenOrders(),
      ]);
      const desyncsBefore = this.engine.stats().desyncs;
      await this.bootstrapState(positions, openOrders, false);
      const desyncsAfter = this.engine.stats().desyncs;

      // Сверка увидела движение позиции, о котором WebSocket не сообщил.
      // Значит, поток мёртв, даже если сокет открыт: пересоздаём его с новым listenKey.
      if (desyncsAfter > desyncsBefore) {
        const ws = this.stream?.stats();
        logger.warn('позиция изменилась, но исполнений по WebSocket не было', {
          сообщенийПоWS: ws?.messages ?? 0,
          pingОтБиржи: ws?.pings ?? 0,
        });
        this.stream?.forceReconnect('позиция изменилась без событий WebSocket');
      }

      logger.debug('сверка выполнена', { reason, positions: positions.length, openOrders: openOrders.length });
    } catch (e) {
      logger.error('сверка не удалась', { reason, error: String(e) });
    }
  }

  private handleEvent(evt: RawUserDataEvent): void {
    const engine = this.engine;
    if (!engine) return;
    const { cfg, logger } = this.deps;

    const type = String(evt.e ?? 'unknown');
    const seen = this.eventCounts.get(type) ?? 0;
    this.eventCounts.set(type, seen + 1);
    // Первое событие каждого типа — на уровне info: сразу видно, что поток работает.
    if (seen === 0) logger.info('получено первое событие типа', { type });
    if (cfg.logRawEvents) logger.info('RAW событие', { payload: JSON.stringify(evt) });

    switch (evt.e) {
      case 'ORDER_TRADE_UPDATE': {
        const raw = evt as RawOrderTradeUpdate;
        if (!isSymbolWatched(cfg, raw.o.s)) return;
        if (!this.exchangeInfo.has(raw.o.s)) this.exchangeInfo.warm([raw.o.s]);
        engine.onOrderEvent(toOrderLifecycleEvent(raw, cfg.clientOrderIdPrefix));
        if (isFillEvent(raw)) engine.onFill(toFillEvent(raw));
        return;
      }
      case 'ACCOUNT_UPDATE': {
        const raw = evt as RawAccountUpdate;
        for (const snap of toPositionSnapshots(raw)) {
          if (!isSymbolWatched(cfg, snap.symbol)) continue;
          engine.onPositionSnapshot(snap);
        }
        return;
      }
      case 'listenKeyExpired': {
        // Раньше здесь было только сообщение — поток оставался мёртвым навсегда.
        logger.warn('listenKey истёк — беру новый и переподключаюсь');
        this.stream?.forceReconnect('listenKeyExpired');
        return;
      }
      case 'ACCOUNT_CONFIG_UPDATE':
      case 'MARGIN_CALL':
      case 'TRADE_LITE':
      case 'STRATEGY_UPDATE':
      case 'GRID_UPDATE':
      case 'CONDITIONAL_ORDER_TRIGGER_REJECT':
        return;
      default:
        logger.debug('необработанное событие', { type: String(evt.e) });
    }
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.reconcileTimer = null;
    this.statsTimer = null;
    this.engine?.stop();
    await this.stream?.stop();
    this.deps.logger.info('сервис остановлен');
  }
}

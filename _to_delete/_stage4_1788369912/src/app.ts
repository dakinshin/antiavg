import type { Config } from './config.js';
import { resolveEndpoints, isSymbolWatched, proxyFor } from './config.js';
import { BinanceRestClient } from './binance/rest.js';
import { ExchangeInfoCache } from './binance/exchangeInfo.js';
import { AccountService } from './binance/account.js';
import { BinanceExecutor } from './binance/executor.js';
import { UserDataStream } from './binance/userDataStream.js';
import {
  createRestFetch,
  createRestProxyDispatcher,
  createWsProxyAgent,
  parseProxy,
} from './binance/proxy.js';
import {
  algoUpdateToLifecycleEvent,
  isFillEvent,
  toFillEvent,
  toOrderLifecycleEvent,
  toPositionSnapshots,
  tradeLiteToFillEvent,
  type RawAccountUpdate,
  type RawAlgoUpdate,
  type RawOrderTradeUpdate,
  type RawTradeLite,
  type RawUserDataEvent,
} from './binance/mappers.js';
import { Engine, type EngineHooks } from './core/engine.js';
import { ActionLimiter } from './core/actionLimiter.js';
import { RiskGuard, type OwnPositionRef, type RiskHooks } from './core/riskGuard.js';
import { FomoGuard, type FomoHooks } from './core/fomoGuard.js';
import type { Logger } from './util/logger.js';
import { positionKey } from './types.js';
import { isZero } from './util/num.js';
import { findDrawdown, type DrawdownStatus } from './core/drawdown.js';

export interface AppDeps {
  cfg: Config;
  logger: Logger;
  /** Внешний слой (десктоп-обёртка) подписывается на срабатывания и действия. */
  hooks?: EngineHooks;
  /** Отдельные хуки риск-модуля: срезка объёма, стопы, уведомления о риске. */
  riskHooks?: RiskHooks;
  /** Хуки защиты от FOMO: серия стоп-аутов, блокировка торговли. */
  fomoHooks?: FomoHooks;
  /**
   * Позиции, уже признанные «нашими» предыдущим запуском. Передаются при
   * перезапуске с новыми настройками, чтобы живая позиция не выпала из-под
   * правил риска только оттого, что сервис подняли заново.
   */
  ownPositions?: OwnPositionRef[];
  /** Вызывается при каждом изменении состояния потока — для индикатора в трее. */
  onStreamState?: (state: { connected: boolean; reason: string }) => void;
}

/** Снимок состояния для UI. */
export interface AppSnapshot {
  running: boolean;
  hedgeMode: boolean;
  engine: ReturnType<Engine['stats']> | null;
  risk: ReturnType<RiskGuard['stats']> | null;
  fomo: ReturnType<FomoGuard['state']> | null;
  ws: { messages: number; pings: number; connectedAtMs: number; lastMessageAtMs: number } | null;
  positions: Array<{
    symbol: string;
    positionSide: string;
    qty: number;
    entryPrice: number;
    openedAtMs: number | null;
    openTimeKnown: boolean;
  }>;
  eventCounts: Record<string, number>;
}

export class App {
  private readonly rest: BinanceRestClient;
  private readonly exchangeInfo: ExchangeInfoCache;
  private readonly account: AccountService;
  private stream: UserDataStream | null = null;
  private engine: Engine | null = null;
  private risk: RiskGuard | null = null;
  private fomo: FomoGuard | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private hedgeMode = false;
  private readonly restProxyLabel: string | undefined;
  /** Счётчики событий по типам — чтобы было видно, что поток вообще живой. */
  private readonly eventCounts = new Map<string, number>();

  constructor(private readonly deps: AppDeps) {
    const endpoints = resolveEndpoints(deps.cfg);
    const restProxy = parseProxy(proxyFor(deps.cfg, 'rest'));
    this.restProxyLabel = restProxy?.url;
    this.rest = new BinanceRestClient({
      baseUrl: endpoints.rest,
      apiKey: deps.cfg.apiKey,
      apiSecret: deps.cfg.apiSecret,
      recvWindow: deps.cfg.recvWindow,
      timeoutMs: deps.cfg.httpTimeoutMs,
      allowHttp2: deps.cfg.allowHttp2,
      logger: deps.logger.child({ mod: 'rest' }),
      ...(restProxy && restProxy.kind === 'http'
        ? { dispatcher: createRestProxyDispatcher(restProxy) }
        : {}),
      ...(restProxy && restProxy.kind === 'socks'
        ? {
            fetchImpl: createRestFetch(restProxy, {
              headersTimeoutMs: Math.min(deps.cfg.httpTimeoutMs, 20_000),
              bodyTimeoutMs: deps.cfg.exchangeInfoTimeoutMs,
            })!,
          }
        : {}),
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
      ws: `${endpoints.ws}${endpoints.wsPrivatePath}`,
      прокси: {
        rest: this.restProxyLabel ?? 'напрямую',
        ws: proxyFor(cfg, 'ws') ?? 'напрямую',
      },
      reactionMode: cfg.reactionMode,
      dryRun: cfg.dryRun,
      lossThresholdPct: cfg.lossThresholdPct,
      countPreexistingOrders: cfg.countPreexistingOrders,
      symbols: cfg.symbols.length ? cfg.symbols : 'ВСЕ',
    });
    if (cfg.dryRun) {
      logger.warn('DRY RUN включён — реальные ордера отправляться не будут (ANTIAVG_DRY_RUN=false для боевого режима)');
    } else {
      logger.warn('=== БОЕВОЙ РЕЖИМ: сервис будет отправлять РЕАЛЬНЫЕ рыночные ордера ===', {
        реакция: cfg.reactionMode === 'close' ? 'закрывать позицию целиком' : 'срезать добавленный объём',
        символы: cfg.symbols.length ? cfg.symbols : 'ВСЕ',
        порогУбыткаПроц: cfg.lossThresholdPct,
        сеткаДоОткрытия: cfg.countPreexistingOrders ? 'считается усреднением' : 'не считается',
        позицииДоЗапуска: cfg.unknownOpenTimePolicy === 'skip' ? 'не трогаем' : 'РЕАГИРУЕМ',
        предохранительВЧас: cfg.maxActionsPerHour || 'выключен',
      });
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

    // Предохранитель общий: лимит действий в час относится ко всему счёту,
    // а не к каждому механизму по отдельности.
    const limiter = new ActionLimiter(cfg.maxActionsPerHour, (count, limit) => {
      logger.error('ПРЕДОХРАНИТЕЛЬ: защитные действия остановлены', {
        заЧас: count,
        лимит: limit,
        что_делать: 'проверьте логи и позиции вручную; лимит меняется через ANTIAVG_MAX_ACTIONS_PER_HOUR',
      });
    });

    this.engine = new Engine({
      cfg,
      executor,
      limiter,
      logger: logger.child({ mod: 'engine' }),
      // Замыкание, а не прямая ссылка: FomoGuard создаётся ниже — ему нужны
      // модель позиций и реестр ордеров, которые заводит сам движок.
      onPositionClosed: (info) => this.fomo?.onPositionClosed(info),
      ...(this.deps.hooks ? { hooks: this.deps.hooks } : {}),
    });

    this.risk = new RiskGuard({
      cfg,
      executor,
      limiter,
      positions: this.engine.positions,
      orders: this.engine.orders,
      hedgeMode: this.hedgeMode,
      logger: logger.child({ mod: 'risk' }),
      market: {
        walletBalance: () => this.account.fetchWalletBalance(),
        markPrice: (symbol) => this.account.fetchMarkPrice(symbol),
        filters: (symbol) => this.exchangeInfo.ensure(symbol),
      },
      ...(this.deps.riskHooks ? { hooks: this.deps.riskHooks } : {}),
    });
    if (this.risk.active) {
      logger.warn('включены правила управления риском', {
        лимитОбъёма: cfg.maxPositionEnabled ? `${cfg.maxPositionLeverage}× депозита` : 'выкл',
        дефолтныйСтоп: cfg.defaultStopEnabled ? `${cfg.defaultStopPct}% через ${cfg.defaultStopDelayMs} мс` : 'выкл',
        защитаСтопа: cfg.protectStopOrders ? 'вкл' : 'выкл',
        лимитРиска: cfg.maxRiskEnabled ? `${cfg.maxRiskPct}% депозита` : 'только уведомления',
      });
    }

    this.fomo = new FomoGuard({
      cfg,
      executor,
      limiter,
      positions: this.engine.positions,
      orders: this.engine.orders,
      // Признак «наша позиция» ведёт RiskGuard — он же переносит его через
      // перезапуск. Второй такой учёт дал бы два ответа на один вопрос.
      isOwnPosition: (symbol, positionSide) => this.risk?.isOwn(symbol, positionSide) ?? false,
      logger: logger.child({ mod: 'fomo' }),
      ...(this.deps.fomoHooks ? { hooks: this.deps.fomoHooks } : {}),
    });
    if (this.fomo.active) {
      logger.warn('включена защита от FOMO', {
        режим: cfg.fomoMode === 'block' ? 'с блокировкой торговли' : 'только уведомления',
        серия: `${cfg.fomoStopLossCount} стоп-аута подряд`,
        окно: `${Math.round(cfg.fomoWindowMs / 1000)} с`,
        сделкаНеДольше: `${Math.round(cfg.fomoMaxTradeDurationMs / 1000)} с`,
        блокировка: cfg.fomoMode === 'block' ? `${Math.round(cfg.fomoBlockMs / 60000)} мин` : '—',
      });
    }

    await this.bootstrapState(snapshot.positions, snapshot.openOrders, true);

    // Строго ПОСЛЕ bootstrapState: там восстанавливается время открытия позиций,
    // по которому и сверяется, та ли это позиция, что была до перезапуска.
    if (this.deps.ownPositions?.length) this.risk.seedOwnPositions(this.deps.ownPositions);
    this.risk.logCoverage();

    const wsAgent = createWsProxyAgent(parseProxy(proxyFor(cfg, 'ws')));
    this.stream = new UserDataStream({
      rest: this.rest,
      wsBaseUrl: endpoints.ws,
      wsPrivatePath: endpoints.wsPrivatePath,
      keepAliveMs: cfg.listenKeyKeepAliveMs,
      logger: logger.child({ mod: 'ws' }),
      ...(wsAgent ? { wsAgent } : {}),
      onEvent: (evt) => this.handleEvent(evt),
      onConnected: (attempt) => {
        this.deps.onStreamState?.({ connected: true, reason: 'подключено' });
        if (attempt > 0 || this.engine) void this.reconcile('после подключения');
      },
      onError: (err) => this.deps.onStreamState?.({ connected: false, reason: err.message }),
    });
    await this.stream.start();

    if (cfg.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => {
        void this.reconcile('по расписанию');
      }, cfg.reconcileIntervalMs);
    }

    if (cfg.statsIntervalMs > 0) {
      this.statsTimer = setInterval(() => {
        const engine = this.engine;
        if (!engine) return;
        logger.info('состояние сервиса', {
          ...engine.stats(),
          ...(this.risk?.active ? this.risk.stats() : {}),
          ...(this.fomo?.active ? this.fomo.stats() : {}),
          ws: this.stream?.stats(),
          события: Object.fromEntries(this.eventCounts),
        });
      }, cfg.statsIntervalMs);
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
        const silentMs = ws?.lastMessageAtMs ? Date.now() - ws.lastMessageAtMs : Number.MAX_SAFE_INTEGER;
        logger.warn('позиция изменилась, но исполнений по WebSocket не было', {
          сообщенийПоWS: ws?.messages ?? 0,
          pingОтБиржи: ws?.pings ?? 0,
          молчитМс: silentMs,
        });
        // Расхождение может быть просто гонкой: снимок REST успел уйти раньше,
        // чем пришло исполнение. Пересоздаём поток только если он и правда молчит.
        if (silentMs > this.deps.cfg.desyncReconnectSilenceMs) {
          this.stream?.forceReconnect('позиция изменилась, поток молчит');
        } else {
          logger.info('поток активен — считаю расхождение гонкой сверки, переподключение не нужно');
        }
      }

      this.risk?.onReconcile();
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
        const lifecycle = toOrderLifecycleEvent(raw, cfg.clientOrderIdPrefix);
        engine.onOrderEvent(lifecycle);
        if (isFillEvent(raw)) {
          const fill = toFillEvent(raw);
          // addedQty из разбора исполнения: защите от FOMO нужно отличать
          // наращивание позиции от входа и от выхода.
          const applied = engine.onFill(fill);
          this.risk?.onFill(fill.symbol, fill.positionSide);
          this.fomo?.onFill(fill.symbol, fill.positionSide, applied.addedQty);
        }
        // Порядок важен: сначала модель позиции обновлена исполнением, и только
        // потом риск-модуль смотрит на стопы — иначе он судил бы по старому объёму.
        this.risk?.onOrderEvent(lifecycle);
        this.fomo?.onOrderEvent(lifecycle);
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
      case 'TRADE_LITE': {
        // TRADE_LITE приходит РАНЬШЕ ORDER_TRADE_UPDATE и иногда оказывается
        // единственным сообщением о сделке. Реагируем по нему, дубликат
        // отсеивается по tradeId.
        const raw = evt as RawTradeLite;
        if (!isSymbolWatched(cfg, raw.s)) return;
        const fill = tradeLiteToFillEvent(raw, engine.orders.get(raw.i), this.hedgeMode);
        if (fill) {
          const applied = engine.onFill(fill);
          this.risk?.onFill(fill.symbol, fill.positionSide);
          this.fomo?.onFill(fill.symbol, fill.positionSide, applied.addedQty);
        }
        else logger.debug('TRADE_LITE без известного ордера в hedge mode — жду ORDER_TRADE_UPDATE', { symbol: raw.s });
        return;
      }
      case 'ALGO_UPDATE': {
        // Условные ордера — стопы, тейки, трейлинг — с конца 2025 года живут
        // отдельно и приходят ЭТИМ событием, а не ORDER_TRADE_UPDATE. Сервис,
        // который его игнорирует, не видит стопов вообще: ни чтобы оценить
        // риск, ни чтобы вернуть снятый.
        const raw = evt as unknown as RawAlgoUpdate;
        if (!isSymbolWatched(cfg, raw.o.s)) return;
        const lifecycle = algoUpdateToLifecycleEvent(raw, cfg.clientOrderIdPrefix);
        engine.onOrderEvent(lifecycle);
        this.risk?.onOrderEvent(lifecycle);
        this.fomo?.onOrderEvent(lifecycle);
        return;
      }
      case 'ACCOUNT_CONFIG_UPDATE':
      case 'MARGIN_CALL':
      case 'STRATEGY_UPDATE':
      case 'GRID_UPDATE':
      case 'CONDITIONAL_ORDER_TRIGGER_REJECT':
        return;
      default:
        logger.debug('необработанное событие', { type: String(evt.e) });
    }
  }

  /**
   * Есть ли сейчас позиции в просадке.
   *
   * Данные берутся свежим запросом к бирже, а не из накопленного состояния:
   * решение принимается редко и по требованию, поэтому точность важнее экономии
   * запроса. Нереализованный PnL считает биржа по mark price — своей оценки
   * текущей цены у сервиса нет и для детекции не нужно.
   */
  async drawdownStatus(): Promise<DrawdownStatus> {
    const positions = await this.account.fetchPositions();
    const watched = positions.filter((p) => isSymbolWatched(this.deps.cfg, p.symbol));
    return findDrawdown(watched, this.deps.cfg.drawdownLockMinLoss);
  }

  /** Позиции под правилами риска — для передачи в следующий запуск. */
  ownPositions(): OwnPositionRef[] {
    return this.risk ? this.risk.ownPositionsSnapshot() : [];
  }

  /** Полный снимок состояния для внешнего UI. */
  snapshot(): AppSnapshot {
    return {
      running: this.engine !== null,
      hedgeMode: this.hedgeMode,
      engine: this.engine ? this.engine.stats() : null,
      risk: this.risk ? this.risk.stats() : null,
      fomo: this.fomo ? this.fomo.state() : null,
      ws: this.stream ? this.stream.stats() : null,
      positions: this.engine
        ? this.engine.positions.open().map((p) => ({
            symbol: p.symbol,
            positionSide: p.positionSide,
            qty: p.qty,
            entryPrice: p.entryPrice,
            openedAtMs: p.openedAtMs,
            openTimeKnown: p.openTimeKnown,
          }))
        : [],
      eventCounts: Object.fromEntries(this.eventCounts),
    };
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.reconcileTimer = null;
    this.statsTimer = null;
    this.engine?.stop();
    this.risk?.stop();
    this.fomo?.stop();
    await this.stream?.stop();
    this.deps.logger.info('сервис остановлен');
  }
}

/**
 * Управление риском позиции: четыре правила, живущие рядом с детектором
 * усреднения и пользующиеся его же моделью позиции.
 *
 *   1. Лимит объёма       — номинал позиции не выше `плечо × депозит`.
 *   2. Дефолтный стоп     — позиция без стопа его получает.
 *   3. Защита стопа       — снятый стоп возвращается на место.
 *   4. Лимит риска        — стоп не уезжает дальше, чем позволяет доля депозита.
 *
 * Все четыре по умолчанию ВЫКЛЮЧЕНЫ и включаются по отдельности. Все четыре
 * применяются только к позициям, открытым при работающем сервисе: иначе
 * перезапуск программы приводил бы к залпу рыночных ордеров по всему счёту.
 */
import type { Config } from '../config.js';
import type { SymbolFilters } from '../binance/exchangeInfo.js';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/logger.js';
import { isZero, round8 } from '../util/num.js';
import { ActionLimiter } from './actionLimiter.js';
import type { OrderRegistry } from './orderRegistry.js';
import type { PositionStore } from './positionStore.js';
import {
  assessRisk,
  defaultStopPrice,
  positionCap,
  riskLimitStopPrice,
  stopAlreadyPassed,
  stopKindOf,
  type RiskAssessment,
  type RiskVerdict,
  type StopKind,
} from './riskRules.js';
import {
  parsePositionKey,
  positionKey,
  type OrderLifecycleEvent,
  type OrderSide,
  type PositionKey,
  type PositionSide,
  type PositionState,
} from '../types.js';
import type { ExecutionOutcome } from './engine.js';

/** Заявка на выставление стопа. */
export interface StopOrderSpec {
  symbol: string;
  positionSide: PositionSide;
  side: OrderSide;
  stopPrice: number;
  /** Знаковый объём позиции: задаёт направление округления цены. */
  positionQty: number;
  /** Для лога: зачем ставим. */
  reason: string;
}

export interface StopPlacement {
  placed: boolean;
  orderId?: number;
  clientOrderId?: string;
  stopPrice?: number;
  reason?: 'dry-run' | 'would-trigger' | 'bad-price';
}

/** То, что риск-модулю нужно от биржи. Отдельный интерфейс — ради тестов. */
export interface RiskExecutor {
  execute(action: import('../types.js').ProtectiveAction): Promise<ExecutionOutcome>;
  cancelOrder(symbol: string, orderId: number): Promise<{ cancelled: boolean; reason?: string }>;
  placeStop(spec: StopOrderSpec): Promise<StopPlacement>;
}

export interface RiskMarketData {
  /** Депозит счёта (totalWalletBalance). */
  walletBalance(): Promise<number>;
  markPrice(symbol: string): Promise<number>;
  filters(symbol: string): Promise<SymbolFilters | undefined>;
}

export interface RiskStatusEvent {
  symbol: string;
  positionSide: PositionSide;
  verdict: RiskVerdict;
  assessment: RiskAssessment;
  /** Человеческий текст — годится и для трея, и для лога. */
  text: string;
}

export interface RiskHooks {
  /** Позиция срезана до потолка объёма. */
  onPositionCapped?(info: { symbol: string; positionSide: PositionSide; excessQty: number; cap: number }): void;
  /** Выставлен стоп (дефолтный, восстановленный или подтянутый по риску). */
  onStopPlaced?(info: {
    symbol: string;
    positionSide: PositionSide;
    stopPrice: number;
    reason: string;
    placed: boolean;
  }): void;
  /** Позиция закрыта по рынку, потому что защититься стопом уже нельзя. */
  onForcedClose?(info: { symbol: string; positionSide: PositionSide; reason: string }): void;
  /** Изменилось состояние риска (для уведомления в трее). */
  onRiskStatus?(info: RiskStatusEvent): void;
}

export interface RiskGuardOptions {
  cfg: Config;
  executor: RiskExecutor;
  positions: PositionStore;
  orders: OrderRegistry;
  market: RiskMarketData;
  /** Общий с детектором усреднения предохранитель. */
  limiter: ActionLimiter;
  hedgeMode: boolean;
  logger?: Logger;
  now?: () => number;
  hooks?: RiskHooks;
}

/** Сколько раз в час сервис готов возвращать снятый стоп по одной позиции. */
const MAX_RESTORES_PER_HOUR = 10;
/** Пауза перед восстановлением снятого стопа: даём улечься закрытию позиции. */
const RESTORE_DELAY_MS = 700;
/**
 * Насколько может разойтись время открытия позиции, восстановленное по истории
 * сделок, с тем, что сервис помнил до перезапуска. Обе величины приходят из
 * одного поля биржи, поэтому расхождение возможно только на округлениях.
 */
const OWN_MATCH_TOLERANCE_MS = 5000;

/** Позиция, признанная «нашей», в переносимом через перезапуск виде. */
export interface OwnPositionRef {
  key: PositionKey;
  openedAtMs: number;
}

interface StopSnapshot {
  orderId: number;
  symbol: string;
  positionSide: PositionSide;
  side: OrderSide;
  stopPrice: number;
  kind: StopKind;
}

export class RiskGuard {
  private readonly cfg: Config;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly hooks: RiskHooks;

  /** Позиции, которые сервис видел открывшимися при своей жизни. */
  private readonly ownPositions = new Set<PositionKey>();
  /** Отложенные проверки «стоп так и не появился». */
  private readonly stopTimers = new Map<PositionKey, ReturnType<typeof setTimeout>>();
  /** Позиции, для которых проверка дефолтного стопа уже назначалась. */
  private readonly defaultStopArmed = new Set<PositionKey>();
  /** Отложенные восстановления снятых стопов. */
  private readonly restoreTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Последнее известное состояние стоп-ордеров — чтобы знать, что восстанавливать. */
  private readonly knownStops = new Map<number, StopSnapshot>();
  /** Ордера, снятые самим сервисом: их восстанавливать не нужно. */
  private readonly ourCancels = new Set<number>();
  /** Времена восстановлений по позиции — защита от бесконечной борьбы с человеком. */
  private readonly restoreTimes = new Map<PositionKey, number[]>();
  /** Последний сообщённый вердикт по риску — уведомляем только об изменениях. */
  private readonly riskState = new Map<PositionKey, RiskVerdict>();
  /** Позиции, по которым прямо сейчас идёт проверка. */
  private readonly busy = new Set<PositionKey>();
  /** Позиции, о непопадании которых под правила уже сообщили. */
  private readonly notOwnReported = new Set<PositionKey>();
  /** Отпечаток последней оценки риска — чтобы заметить сдвиг стопа. */
  private readonly riskFingerprint = new Map<PositionKey, string>();
  /** Начатые, но не завершённые проверки — чтобы их можно было дождаться. */
  private readonly pendingWork = new Set<Promise<unknown>>();

  private stopped = false;
  private balanceValue = 0;
  private balanceAtMs = 0;
  private balanceInFlight: Promise<number> | null = null;

  private cappedCount = 0;
  private stopsPlaced = 0;
  private stopsRestored = 0;
  private forcedCloses = 0;

  constructor(private readonly opts: RiskGuardOptions) {
    this.cfg = opts.cfg;
    this.log = opts.logger ?? noopLogger;
    this.now = opts.now ?? (() => Date.now());
    this.hooks = opts.hooks ?? {};
  }

  /** Хотя бы одно правило включено — иначе модуль вообще не трогает счёт. */
  get active(): boolean {
    return (
      this.cfg.maxPositionEnabled ||
      this.cfg.defaultStopEnabled ||
      this.cfg.protectStopOrders ||
      this.cfg.maxRiskEnabled
    );
  }

  /**
   * Дождаться завершения всех начатых проверок.
   *
   * Проверки запускаются из синхронных обработчиков событий и живут сами по
   * себе. Нужна явная точка ожидания — иначе тест (и корректная остановка) не
   * может знать, что работа закончена.
   */
  async settle(): Promise<void> {
    while (this.pendingWork.size > 0) {
      await Promise.allSettled([...this.pendingWork]);
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pendingWork.add(p);
    void p
      // Работа, запущенная из таймера, ничьим catch не накрыта. Без этой строки
      // отказ биржи в постановке стопа не оставлял бы ВООБЩЕ никакого следа —
      // ровно та немота, из-за которой сервис однажды уже казался исправным.
      .catch((e: unknown) => {
        this.log.error('фоновая проверка риска упала', {
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
      })
      .finally(() => this.pendingWork.delete(p));
    return p;
  }

  /**
   * Возвращает позиции, которые сервис признал своими, вместе с временем
   * открытия. Нужно, чтобы перезапуск с новыми настройками не превращал живую
   * позицию в «чужую» и не выводил её из-под правил.
   */
  ownPositionsSnapshot(): OwnPositionRef[] {
    const out: OwnPositionRef[] = [];
    for (const key of this.ownPositions) {
      const { symbol, positionSide } = parsePositionKey(key);
      const pos = this.opts.positions.peek(symbol, positionSide);
      if (!pos || isZero(pos.qty) || pos.openedAtMs === null) continue;
      out.push({ key, openedAtMs: pos.openedAtMs });
    }
    return out;
  }

  /**
   * Восстанавливает признак «наша позиция» после перезапуска.
   *
   * Проверка по времени открытия обязательна: между остановкой и стартом
   * позицию могли закрыть и открыть заново. Совпадения ключа `символ|сторона`
   * для этого мало — это была бы уже другая позиция.
   */
  seedOwnPositions(refs: OwnPositionRef[]): void {
    for (const ref of refs) {
      const { symbol, positionSide } = parsePositionKey(ref.key);
      const pos = this.opts.positions.peek(symbol, positionSide);
      if (!pos || isZero(pos.qty)) continue;

      if (!pos.openTimeKnown || pos.openedAtMs === null) {
        this.log.warn('позиция была под правилами риска, но время её открытия не восстановилось', {
          symbol,
          positionSide,
          следствие: 'правила риска к ней больше не применяются',
          подсказка: 'ANTIAVG_RECONSTRUCT_OPEN_TIME=true восстанавливает время по истории сделок',
        });
        continue;
      }
      if (Math.abs(pos.openedAtMs - ref.openedAtMs) > OWN_MATCH_TOLERANCE_MS) {
        this.log.info('позиция по этому символу переоткрыта — считаю её новой', {
          symbol,
          positionSide,
          былоОткрыто: new Date(ref.openedAtMs).toISOString(),
          сейчасОткрыто: new Date(pos.openedAtMs).toISOString(),
        });
        continue;
      }

      this.ownPositions.add(ref.key);
      this.log.info('позиция остаётся под правилами риска после перезапуска', { symbol, positionSide });
    }
  }

  /**
   * Сводка после старта: какие открытые позиции попадают под правила, а какие
   * нет. Печатается один раз и снимает самый частый вопрос — «почему сервис
   * ничего не делает с моей позицией».
   */
  logCoverage(): void {
    if (!this.active) return;
    const open = this.opts.positions.open();
    if (open.length === 0) return;

    const under: string[] = [];
    const outside: string[] = [];
    for (const p of open) {
      const key = positionKey(p.symbol, p.positionSide);
      (this.ownPositions.has(key) ? under : outside).push(key);
    }
    this.log.warn('охват правил риска', {
      подПравилами: under.length ? under : 'нет',
      внеПравил: outside.length ? outside : 'нет',
      пояснение:
        outside.length > 0
          ? 'позиции вне правил открыты не при этом запуске — сервис их не трогает'
          : undefined,
    });
  }

  /* ---------------- Входные точки ---------------- */

  /** Вызывается после того, как исполнение уже применено к модели позиции. */
  onFill(symbol: string, positionSide: PositionSide): void {
    if (this.stopped) return;
    void this.track(this.review(symbol, positionSide, 'исполнение'));
  }

  /** События жизненного цикла ордеров: следим за стопами. */
  onOrderEvent(evt: OrderLifecycleEvent): void {
    if (this.stopped) return;
    const order = evt.order;
    const pos = this.opts.positions.peek(order.symbol, order.positionSide);
    const qty = pos?.qty ?? 0;

    const terminal = ['CANCELED', 'FILLED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'];
    if (!terminal.includes(evt.orderStatus)) {
      const kind = stopKindOf(order, qty);
      if (kind) {
        this.knownStops.set(order.orderId, {
          orderId: order.orderId,
          symbol: order.symbol,
          positionSide: order.positionSide,
          side: order.side,
          stopPrice: order.stopPrice,
          kind,
        });
        // Стоп появился или сдвинулся — самое время проверить, не слишком ли он далеко.
        void this.track(this.review(order.symbol, order.positionSide, 'изменение стопа'));
      }
      return;
    }

    const known = this.knownStops.get(order.orderId);
    this.knownStops.delete(order.orderId);

    // Восстанавливаем ТОЛЬКО снятое вручную. EXPIRED — это уборка со стороны
    // биржи (позиция закрылась, стоп с closePosition снят автоматически), а
    // FILLED означает, что стоп сработал: возвращать его было бы абсурдом.
    if (evt.orderStatus !== 'CANCELED') return;
    if (this.ourCancels.delete(order.orderId)) return;
    if (!known) return;
    if (!this.cfg.protectStopOrders) return;

    this.scheduleRestore(known);
  }

  /** Периодическая сверка: проверяем все открытые позиции. */
  onReconcile(): void {
    if (this.stopped || !this.active) return;
    for (const p of this.opts.positions.open()) {
      void this.track(this.review(p.symbol, p.positionSide, 'сверка'));
    }
  }

  /* ---------------- Основной проход ---------------- */

  private async review(symbol: string, positionSide: PositionSide, reason: string): Promise<void> {
    if (this.stopped || !this.active) return;
    const key = positionKey(symbol, positionSide);
    const pos = this.opts.positions.peek(symbol, positionSide);

    if (!pos || isZero(pos.qty)) {
      this.forget(key);
      return;
    }
    if (!this.isOwnPosition(pos, key)) {
      this.reportNotOwn(key, symbol, positionSide);
      return;
    }
    if (this.busy.has(key)) return;

    this.busy.add(key);
    try {
      if (this.cfg.maxPositionEnabled) await this.enforcePositionCap(symbol, positionSide);
      if (this.cfg.defaultStopEnabled) this.armDefaultStop(symbol, positionSide);
      await this.checkRisk(symbol, positionSide);
    } catch (e) {
      this.log.error('проверка риска не удалась', {
        symbol,
        positionSide,
        повод: reason,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.busy.delete(key);
    }
  }

  /**
   * Позиция считается «нашей», если она открылась при работающем сервисе.
   *
   * Правила риска меняют счёт рыночными ордерами, и распространять их на всё,
   * что человек накопил до запуска, было бы грубым вмешательством: перезапуск
   * программы превратился бы в залп ордеров по всему портфелю.
   */
  private isOwnPosition(pos: PositionState, key: PositionKey): boolean {
    if (this.ownPositions.has(key)) return true;
    if (!pos.openTimeKnown || pos.openedAtMs === null) return false;
    // openedByOrderId проставляется только когда позицию открыл наблюдаемый нами
    // ордер — то есть уже при работающем сервисе.
    if (pos.openedByOrderId === null) return false;
    this.ownPositions.add(key);
    return true;
  }

  /**
   * Позиция под правила не подпадает — сказать об этом ровно один раз.
   *
   * Молчаливый пропуск здесь — худший из возможных: человек включил правило,
   * двигает стоп куда попало и не понимает, почему сервис не реагирует.
   * Ни одной строчки в логе при этом не появлялось.
   */
  private reportNotOwn(key: PositionKey, symbol: string, positionSide: PositionSide): void {
    if (this.notOwnReported.has(key)) return;
    this.notOwnReported.add(key);
    this.log.warn('позиция вне правил риска: она открыта не при этом запуске сервиса', {
      symbol,
      positionSide,
      следствие: 'лимит объёма, дефолтный стоп, защита стопа и лимит риска к ней НЕ применяются',
      что_делать: 'правила начнут действовать со следующей позиции по этому символу',
    });
  }

  private forget(key: PositionKey): void {
    this.ownPositions.delete(key);
    this.riskState.delete(key);
    this.defaultStopArmed.delete(key);
    this.notOwnReported.delete(key);
    this.riskFingerprint.delete(key);
    const timer = this.stopTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.stopTimers.delete(key);
    }
  }

  /* ---------------- 1. Лимит объёма ---------------- */

  private async enforcePositionCap(symbol: string, positionSide: PositionSide): Promise<void> {
    const pos = this.opts.positions.peek(symbol, positionSide);
    if (!pos || isZero(pos.qty)) return;

    const [balance, filters] = await Promise.all([
      this.walletBalance(),
      this.opts.market.filters(symbol),
    ]);
    if (balance <= 0) return;

    // Цена: сначала mark price, при недоступности — средняя входа. Ошибиться в
    // меньшую сторону не страшно, в большую — привело бы к лишней срезке.
    const price = await this.priceFor(symbol, pos.entryPrice);
    const cap = positionCap(pos.qty, price, balance, this.cfg.maxPositionLeverage, filters?.stepSize ?? 0);
    if (cap.excessQty <= 0) return;

    if (!this.opts.limiter.allow(this.now())) {
      this.log.warn('предохранитель: срезка сверхлимитного объёма пропущена', { symbol, positionSide });
      return;
    }

    this.log.warn('объём позиции выше потолка — срезаю разницу по рынку', {
      symbol,
      positionSide,
      объём: round8(Math.abs(pos.qty)),
      номинал: round8(cap.notional),
      потолок: round8(cap.maxNotional),
      депозит: round8(balance),
      плечо: this.cfg.maxPositionLeverage,
      срезать: round8(cap.excessQty),
    });

    const outcome = await this.opts.executor.execute({
      symbol,
      positionSide,
      mode: 'reduce',
      side: pos.qty > 0 ? 'SELL' : 'BUY',
      requestedQty: cap.excessQty,
      positionQty: pos.qty,
      triggers: [],
    });

    if (outcome.executed) this.cappedCount++;
    else this.opts.limiter.refund(this.now());
    this.hooks.onPositionCapped?.({
      symbol,
      positionSide,
      excessQty: outcome.sentQty ?? cap.excessQty,
      cap: cap.maxNotional,
    });
  }

  /* ---------------- 2. Дефолтный стоп ---------------- */

  /**
   * Ставит таймер «через N секунд проверим, появился ли стоп».
   *
   * Ровно один раз за жизнь позиции. Правило звучит как «позиция ОТКРЫЛАСЬ без
   * стопа», а не «у позиции всегда должен быть стоп»: за второе отвечает
   * отдельная настройка, запрещающая снимать стоп, и подменять её здесь было бы
   * тихим расширением того, на что человек согласился.
   */
  private armDefaultStop(symbol: string, positionSide: PositionSide): void {
    const key = positionKey(symbol, positionSide);
    if (this.defaultStopArmed.has(key)) return;
    this.defaultStopArmed.add(key);

    const delay = Math.max(0, this.cfg.defaultStopDelayMs);
    this.log.info('жду стоп по новой позиции', {
      symbol,
      positionSide,
      ждуМс: delay,
      отступПроц: this.cfg.defaultStopPct,
    });
    const timer = setTimeout(() => {
      this.stopTimers.delete(key);
      void this.track(this.ensureDefaultStop(symbol, positionSide));
    }, delay);
    // НЕ unref: пропущенный стоп — это неограниченный убыток, ради него процесс
    // обязан дожить до проверки.
    this.stopTimers.set(key, timer);
  }

  /** Ждём ли мы прямо сейчас появления стопа по этой позиции. */
  private defaultStopPending(key: PositionKey): boolean {
    return this.stopTimers.has(key);
  }

  private async ensureDefaultStop(symbol: string, positionSide: PositionSide): Promise<void> {
    if (this.stopped) return;
    if (!this.cfg.defaultStopEnabled) {
      this.log.info('дефолтный стоп выключен настройкой, проверка пропущена', { symbol, positionSide });
      return;
    }
    const pos = this.opts.positions.peek(symbol, positionSide);
    if (!pos || isZero(pos.qty)) {
      this.log.info('позиция закрыта раньше проверки, дефолтный стоп не нужен', { symbol, positionSide });
      return;
    }

    // За время ожидания человек мог поставить стоп сам — это штатный исход.
    const existing = this.stopsFor(symbol, positionSide);
    if (existing.length > 0) {
      this.log.info('стоп выставлен вручную, дефолтный не нужен', {
        symbol,
        positionSide,
        ордера: existing.map((o) => o.orderId),
      });
      return;
    }

    this.log.info('стопа нет — ставлю дефолтный', {
      symbol,
      positionSide,
      средняяВхода: round8(pos.entryPrice),
      отступПроц: this.cfg.defaultStopPct,
    });

    let stopPrice = defaultStopPrice(pos.entryPrice, pos.qty, this.cfg.defaultStopPct);

    // Лимит риска может требовать стоп ближе, чем дефолтный процент.
    if (this.cfg.maxRiskEnabled) {
      const balance = await this.walletBalance();
      const maxRisk = (balance * this.cfg.maxRiskPct) / 100;
      const limit = riskLimitStopPrice(pos.qty, pos.entryPrice, maxRisk);
      stopPrice = pos.qty > 0 ? Math.max(stopPrice, limit) : Math.min(stopPrice, limit);
    }

    const price = await this.priceFor(symbol, pos.entryPrice);
    if (stopAlreadyPassed(pos.qty, stopPrice, price)) {
      await this.closeAtMarket(
        symbol,
        positionSide,
        `цена ушла за дефолтный стоп ${round8(stopPrice)} (сейчас ${round8(price)})`,
      );
      return;
    }

    await this.placeStop(symbol, positionSide, stopPrice, 'дефолтный стоп');
    // Вердикт по риску мы придержали, пока ждали стоп, — теперь он определён.
    await this.checkRisk(symbol, positionSide);
  }

  /* ---------------- 3. Защита стопа от снятия ---------------- */

  private scheduleRestore(stop: StopSnapshot): void {
    if (this.restoreTimers.has(stop.orderId)) return;
    const timer = setTimeout(() => {
      this.restoreTimers.delete(stop.orderId);
      void this.track(this.restoreStop(stop));
    }, RESTORE_DELAY_MS);
    this.restoreTimers.set(stop.orderId, timer);
  }

  /**
   * Возвращает снятый стоп на прежнее место.
   *
   * Пауза перед восстановлением не косметическая: стоп снимается и тогда, когда
   * позиция закрывается, а событие о закрытии позиции может прийти следом.
   * Без паузы сервис ставил бы стоп на только что закрытую позицию.
   */
  private async restoreStop(stop: StopSnapshot): Promise<void> {
    if (this.stopped || !this.cfg.protectStopOrders) return;
    const pos = this.opts.positions.peek(stop.symbol, stop.positionSide);
    if (!pos || isZero(pos.qty)) return;
    const key = positionKey(stop.symbol, stop.positionSide);
    if (!this.ownPositions.has(key)) return;

    // Стоп мог быть заменён другим — тогда защищать нечего.
    if (this.stopsFor(stop.symbol, stop.positionSide).length > 0) {
      this.log.info('стоп снят, но позиция всё ещё под защитой другого стопа', {
        symbol: stop.symbol,
        positionSide: stop.positionSide,
      });
      return;
    }

    if (stop.kind === 'trailing') {
      // Трейлинг восстановить «на прежнем месте» невозможно: его уровень был
      // вычислен биржей и нигде не сохранён. Ставим обычный стоп по текущим
      // правилам и честно пишем об этом.
      this.log.warn('снят трейлинг-стоп: восстановить его точно нельзя, ставлю обычный', {
        symbol: stop.symbol,
        positionSide: stop.positionSide,
      });
      await this.ensureDefaultStop(stop.symbol, stop.positionSide);
      return;
    }

    if (!this.allowRestore(key)) {
      this.log.error('стоп снимают снова и снова — прекращаю возвращать', {
        symbol: stop.symbol,
        positionSide: stop.positionSide,
        лимитВЧас: MAX_RESTORES_PER_HOUR,
        что_делать: 'выключите «не разрешать снимать стоп» или закройте позицию',
      });
      return;
    }

    let stopPrice = stop.stopPrice;
    // Возвращать стоп за пределы лимита риска нельзя: он тут же был бы подтянут
    // обратно, и два правила зациклились бы друг на друге.
    if (this.cfg.maxRiskEnabled) {
      const balance = await this.walletBalance();
      const limit = riskLimitStopPrice(pos.qty, pos.entryPrice, (balance * this.cfg.maxRiskPct) / 100);
      stopPrice = pos.qty > 0 ? Math.max(stopPrice, limit) : Math.min(stopPrice, limit);
    }

    const price = await this.priceFor(stop.symbol, pos.entryPrice);
    if (stopAlreadyPassed(pos.qty, stopPrice, price)) {
      await this.closeAtMarket(
        stop.symbol,
        stop.positionSide,
        `стоп сняли, а цена уже за уровнем ${round8(stopPrice)}`,
      );
      return;
    }

    const res = await this.placeStop(stop.symbol, stop.positionSide, stopPrice, 'возврат снятого стопа');
    if (res.placed) this.stopsRestored++;
  }

  private allowRestore(key: PositionKey): boolean {
    const nowMs = this.now();
    const times = this.restoreTimes.get(key) ?? [];
    const fresh = times.filter((t) => nowMs - t < 3600_000);
    if (fresh.length >= MAX_RESTORES_PER_HOUR) {
      this.restoreTimes.set(key, fresh);
      return false;
    }
    fresh.push(nowMs);
    this.restoreTimes.set(key, fresh);
    return true;
  }

  /* ---------------- 4. Лимит риска ---------------- */

  private async checkRisk(symbol: string, positionSide: PositionSide): Promise<void> {
    const pos = this.opts.positions.peek(symbol, positionSide);
    if (!pos || isZero(pos.qty)) return;

    const balance = await this.walletBalance();
    if (balance <= 0) return;

    const stops = this.stopsFor(symbol, positionSide).map((o) => ({
      kind: stopKindOf(o, pos.qty)!,
      stopPrice: o.stopPrice,
      orderId: o.orderId,
    }));
    const assessment = assessRisk(pos.qty, pos.entryPrice, stops, balance, this.cfg.maxRiskPct);

    if (!this.cfg.maxRiskEnabled) {
      this.notifyRisk(symbol, positionSide, assessment);
      return;
    }

    if (assessment.verdict !== 'exceeded') {
      this.notifyRisk(symbol, positionSide, assessment);
      return;
    }

    const limitPrice = riskLimitStopPrice(pos.qty, pos.entryPrice, assessment.maxRisk);
    const price = await this.priceFor(symbol, pos.entryPrice);

    this.log.warn('риск по позиции выше предельного — подтягиваю стоп', {
      symbol,
      positionSide,
      риск: round8(assessment.risk ?? 0),
      предел: round8(assessment.maxRisk),
      рискПроц: round8(assessment.riskPct ?? 0),
      стопБыл: round8(assessment.stopPrice ?? 0),
      стопСтанет: round8(limitPrice),
    });

    if (stopAlreadyPassed(pos.qty, limitPrice, price)) {
      // Стоп на допустимом расстоянии поставить уже невозможно: цена его прошла.
      // Единственный способ уложиться в лимит — закрыть позицию.
      await this.closeAtMarket(
        symbol,
        positionSide,
        `риск ${round8(assessment.risk ?? 0)} выше предела ${round8(assessment.maxRisk)}, ` +
          `а стоп на ${round8(limitPrice)} цена уже прошла`,
      );
      return;
    }

    // Сначала ставим новый стоп, потом снимаем старый: иначе между двумя
    // операциями позиция осталась бы вовсе без защиты.
    const placed = await this.placeStop(symbol, positionSide, limitPrice, 'лимит риска');
    if (!placed.placed) return;

    for (const s of stops) {
      if (s.orderId === placed.orderId) continue;
      const risk = assessRisk(pos.qty, pos.entryPrice, [s], balance, this.cfg.maxRiskPct);
      if (risk.verdict !== 'exceeded') continue;
      this.ourCancels.add(s.orderId);
      try {
        await this.opts.executor.cancelOrder(symbol, s.orderId);
      } catch (e) {
        this.ourCancels.delete(s.orderId);
        this.log.error('не удалось снять слишком дальний стоп', {
          symbol,
          orderId: s.orderId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    this.riskState.set(positionKey(symbol, positionSide), 'within');
  }

  /**
   * Уведомление о состоянии риска — только при СМЕНЕ состояния.
   *
   * Иначе при каждом исполнении в трей летело бы одно и то же сообщение, и его
   * очень быстро перестали бы читать.
   */
  private notifyRisk(symbol: string, positionSide: PositionSide, a: RiskAssessment): void {
    const key = positionKey(symbol, positionSide);
    // Пока мы сами ждём момента выставить дефолтный стоп, кричать «риск ничем
    // не ограничен» нечестно: через пару секунд он будет ограничен нами.
    if (a.verdict === 'no-stop' && this.defaultStopPending(key)) return;

    // Вердикт мог не измениться, а стоп — уехать. Уведомление в трее для этого
    // не нужно, но в логе такое обязано быть видно: иначе «передвинул стоп, и
    // ничего не произошло» невозможно отличить от «сервис не работает».
    const fingerprint = `${a.verdict}:${round8(a.stopPrice ?? 0)}:${round8(a.risk ?? 0)}`;
    if (this.riskFingerprint.get(key) !== fingerprint) {
      this.riskFingerprint.set(key, fingerprint);
      this.log.info('оценка риска по позиции', {
        symbol,
        positionSide,
        вердикт: a.verdict,
        риск: a.risk !== undefined ? round8(a.risk) : 'неизвестен',
        предел: round8(a.maxRisk),
        стоп: a.stopPrice !== undefined ? round8(a.stopPrice) : 'нет',
        жёсткийЛимит: this.cfg.maxRiskEnabled ? 'вкл' : 'выкл, только уведомления',
      });
    }

    if (this.riskState.get(key) === a.verdict) return;
    this.riskState.set(key, a.verdict);

    const text =
      a.verdict === 'exceeded'
        ? `${symbol}: риск ${round8(a.risk ?? 0)} USDT (${round8(a.riskPct ?? 0)}% депозита) выше предела ${round8(a.maxRisk)} USDT`
        : a.verdict === 'within'
          ? `${symbol}: норма риска соблюдена — ${round8(a.risk ?? 0)} USDT из ${round8(a.maxRisk)} USDT`
          : a.verdict === 'no-stop'
            ? `${symbol}: стоп не выставлен — риск ничем не ограничен`
            : `${symbol}: риск не поддаётся оценке — позицию держит только трейлинг-стоп`;

    if (a.verdict === 'within') this.log.info('риск по позиции', { symbol, positionSide, text });
    else this.log.warn('риск по позиции', { symbol, positionSide, text });

    this.hooks.onRiskStatus?.({ symbol, positionSide, verdict: a.verdict, assessment: a, text });
  }

  /* ---------------- Общие действия ---------------- */

  private stopsFor(symbol: string, positionSide: PositionSide) {
    const pos = this.opts.positions.peek(symbol, positionSide);
    if (!pos || isZero(pos.qty)) return [];
    return this.opts.orders
      .open()
      .filter((o) => o.symbol === symbol && o.positionSide === positionSide)
      .filter((o) => stopKindOf(o, pos.qty) !== null);
  }

  private async placeStop(
    symbol: string,
    positionSide: PositionSide,
    stopPrice: number,
    reason: string,
  ): Promise<StopPlacement> {
    const pos = this.opts.positions.peek(symbol, positionSide);
    if (!pos || isZero(pos.qty)) return { placed: false };

    const res = await this.opts.executor.placeStop({
      symbol,
      positionSide,
      side: pos.qty > 0 ? 'SELL' : 'BUY',
      stopPrice,
      positionQty: pos.qty,
      reason,
    });

    if (res.placed) {
      this.stopsPlaced++;
      this.log.warn('стоп выставлен', {
        symbol,
        positionSide,
        цена: round8(res.stopPrice ?? stopPrice),
        повод: reason,
        orderId: res.orderId,
      });
      // Свой же стоп сразу кладём в реестр, не дожидаясь события от биржи.
      // Иначе секунду-другую позиция числится незащищённой — и за эту секунду
      // сервис успевает заявить «риск ничем не ограничен» и попробовать
      // поставить второй такой же стоп.
      if (res.orderId !== undefined) {
        this.opts.orders.upsert({
          orderId: res.orderId,
          clientOrderId: res.clientOrderId ?? '',
          symbol,
          positionSide,
          side: pos.qty > 0 ? 'SELL' : 'BUY',
          type: 'STOP_MARKET',
          origType: 'STOP_MARKET',
          placedAtMs: this.now(),
          origQty: 0,
          executedQty: 0,
          price: 0,
          stopPrice: res.stopPrice ?? stopPrice,
          reduceOnly: false,
          closePosition: true,
          own: true,
        });
        // И запоминаем как защищаемый стоп. Полагаться на эхо-событие от биржи
        // нельзя: если оно потеряется, наш собственный стоп окажется единственным,
        // который сервис не станет возвращать после снятия.
        this.knownStops.set(res.orderId, {
          orderId: res.orderId,
          symbol,
          positionSide,
          side: pos.qty > 0 ? 'SELL' : 'BUY',
          stopPrice: res.stopPrice ?? stopPrice,
          kind: 'fixed',
        });
      }
    } else if (res.reason === 'would-trigger') {
      await this.closeAtMarket(symbol, positionSide, `биржа отклонила стоп: цена уже за уровнем (${reason})`);
    } else if (res.reason !== 'dry-run') {
      this.log.error('стоп выставить не удалось', { symbol, positionSide, повод: reason, причина: res.reason });
    }

    this.hooks.onStopPlaced?.({
      symbol,
      positionSide,
      stopPrice: res.stopPrice ?? stopPrice,
      reason,
      placed: res.placed,
    });
    return res;
  }

  private async closeAtMarket(symbol: string, positionSide: PositionSide, reason: string): Promise<void> {
    const pos = this.opts.positions.peek(symbol, positionSide);
    if (!pos || isZero(pos.qty)) return;

    if (!this.opts.limiter.allow(this.now())) {
      this.log.error('предохранитель: экстренное закрытие позиции ПРОПУЩЕНО', { symbol, positionSide, reason });
      return;
    }

    this.log.warn('ЗАКРЫВАЮ ПОЗИЦИЮ ПО РЫНКУ', { symbol, positionSide, причина: reason });
    const outcome = await this.opts.executor.execute({
      symbol,
      positionSide,
      mode: 'close',
      side: pos.qty > 0 ? 'SELL' : 'BUY',
      requestedQty: Math.abs(pos.qty),
      positionQty: pos.qty,
      triggers: [],
    });
    if (outcome.executed) this.forcedCloses++;
    else this.opts.limiter.refund(this.now());
    this.hooks.onForcedClose?.({ symbol, positionSide, reason });
  }

  /** Депозит с кешем: за одну проверку его спрашивают несколько правил сразу. */
  private async walletBalance(): Promise<number> {
    const nowMs = this.now();
    if (this.balanceValue > 0 && nowMs - this.balanceAtMs < this.cfg.balanceCacheMs) {
      return this.balanceValue;
    }
    if (this.balanceInFlight) return this.balanceInFlight;

    this.balanceInFlight = this.opts.market
      .walletBalance()
      .then((v) => {
        this.balanceValue = v;
        this.balanceAtMs = this.now();
        return v;
      })
      .catch((e: unknown) => {
        this.log.error('не удалось получить депозит — правила риска пропущены', { error: String(e) });
        return 0;
      })
      .finally(() => {
        this.balanceInFlight = null;
      });
    return this.balanceInFlight;
  }

  private async priceFor(symbol: string, fallback: number): Promise<number> {
    try {
      return await this.opts.market.markPrice(symbol);
    } catch (e) {
      this.log.warn('mark price недоступна, использую среднюю цену входа', { symbol, error: String(e) });
      return fallback;
    }
  }

  stats(): {
    срезаноПоОбъёму: number;
    выставленоСтопов: number;
    возвращеноСтопов: number;
    закрытийПоРиску: number;
  } {
    return {
      срезаноПоОбъёму: this.cappedCount,
      выставленоСтопов: this.stopsPlaced,
      возвращеноСтопов: this.stopsRestored,
      закрытийПоРиску: this.forcedCloses,
    };
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.stopTimers.values()) clearTimeout(t);
    this.stopTimers.clear();
    for (const t of this.restoreTimers.values()) clearTimeout(t);
    this.restoreTimers.clear();
  }
}

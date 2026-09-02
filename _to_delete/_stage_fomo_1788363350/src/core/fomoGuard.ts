/**
 * Защита от FOMO — действующая часть.
 *
 * Серию коротких стоп-аутов считает `FomoDetector`; здесь решается, что с ней
 * делать. Три режима, ровно как просил человек:
 *
 *   off    — выключено;
 *   notify — только сигнал в трей, счёт не трогаем;
 *   block  — сигнал И блокировка торговли: снимаем лимитные заявки, закрываем
 *            позиции по рынку и держим счёт пустым заданное время.
 *
 * Блокировка не одноразовое действие, а состояние: пока она держится, любая
 * новая заявка снимается, а любая открывшаяся позиция закрывается. Иначе она не
 * была бы блокировкой — человек в этом состоянии как раз и будет пробовать
 * войти снова, и один залп ордеров в начале окна его не остановит.
 */
import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/logger.js';
import { isZero, round8 } from '../util/num.js';
import type { ActionLimiter } from './actionLimiter.js';
import type { OrderRegistry } from './orderRegistry.js';
import type { PositionStore } from './positionStore.js';
import { FomoDetector, type ClosedTrade } from './fomo.js';
import { stopKindOf } from './riskRules.js';
import {
  isTerminalStatus,
  positionKey,
  type OrderLifecycleEvent,
  type OrderRecord,
  type PositionKey,
  type PositionSide,
  type ProtectiveAction,
} from '../types.js';
import type { ExecutionOutcome } from './engine.js';

export interface FomoExecutor {
  execute(action: ProtectiveAction): Promise<ExecutionOutcome>;
  cancelOrder(
    symbol: string,
    orderId: number,
    opts?: { algo?: boolean },
  ): Promise<{ cancelled: boolean; reason?: string }>;
}

export interface FomoTriggerInfo {
  /** Сделки, образовавшие серию. */
  trades: ClosedTrade[];
  /** Блокируем торговлю или только сигнализируем. */
  blocking: boolean;
  /** До какого момента держится блокировка (0 — режим notify). */
  blockUntilMs: number;
  /** Готовый текст для трея. */
  text: string;
}

export interface FomoHooks {
  /** Серия набрана. */
  onFomoTriggered?(info: FomoTriggerInfo): void;
  /** Блокировка кончилась — торговать снова можно. */
  onFomoBlockEnded?(info: { atMs: number }): void;
  /** Во время блокировки что-то отменено или закрыто. */
  onFomoEnforced?(info: {
    symbol: string;
    what: 'order-cancelled' | 'position-closed';
    detail: string;
  }): void;
}

export interface FomoGuardOptions {
  cfg: Config;
  executor: FomoExecutor;
  positions: PositionStore;
  orders: OrderRegistry;
  limiter: ActionLimiter;
  logger?: Logger;
  now?: () => number;
  hooks?: FomoHooks;
}

/**
 * Сколько времени после срабатывания алго-стопа закрытие позиции ещё считается
 * закрытием ПО СТОПУ.
 *
 * Нужно потому, что сработавший условный ордер порождает на бирже отдельный
 * обычный ордер, и в исполнении по нему тип может прийти уже как MARKET.
 * Опираться на один только `origType` значит рисковать не увидеть стоп-аут
 * вообще — то есть не увидеть ровно то, ради чего вся защита.
 */
const STOP_TRIGGER_GRACE_MS = 4000;

/** Типы условных ордеров, срабатывание которых означает стоп-аут. */
const TRIGGERED_STOP_TYPES = new Set(['STOP_MARKET', 'STOP', 'TRAILING_STOP_MARKET']);

export class FomoGuard {
  private readonly cfg: Config;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly hooks: FomoHooks;
  private readonly detector: FomoDetector;

  /** Когда по этой позиции в последний раз сработал стоп. */
  private readonly stopTriggeredAt = new Map<PositionKey, number>();
  /** Позиции, по которым прямо сейчас идёт принудительное закрытие. */
  private readonly closing = new Set<PositionKey>();
  /** Ордера, отмену которых мы уже отправили. */
  private readonly cancelRequested = new Set<number>();
  private readonly pendingWork = new Set<Promise<unknown>>();

  private blockUntilMs = 0;
  private blockTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private triggers = 0;
  private closedByBlock = 0;
  private cancelledByBlock = 0;

  constructor(private readonly opts: FomoGuardOptions) {
    this.cfg = opts.cfg;
    this.log = opts.logger ?? noopLogger;
    this.now = opts.now ?? (() => Date.now());
    this.hooks = opts.hooks ?? {};
    this.detector = new FomoDetector({
      windowMs: this.cfg.fomoWindowMs,
      count: this.cfg.fomoStopLossCount,
      maxTradeDurationMs: this.cfg.fomoMaxTradeDurationMs,
    });
  }

  get active(): boolean {
    return this.cfg.fomoMode !== 'off';
  }

  /** Торговля сейчас заблокирована. */
  blocked(): boolean {
    return this.blockUntilMs > this.now();
  }

  /** Дождаться завершения начатых действий (тесты и корректная остановка). */
  async settle(): Promise<void> {
    while (this.pendingWork.size > 0) {
      await Promise.allSettled([...this.pendingWork]);
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pendingWork.add(p);
    void p
      .catch((e: unknown) => {
        this.log.error('действие защиты от FOMO упало', {
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
      })
      .finally(() => this.pendingWork.delete(p));
    return p;
  }

  /* ---------------- Вход событий ---------------- */

  /**
   * Жизненный цикл ордеров.
   *
   * Две обязанности: запомнить срабатывание стопа (по нему потом опознаётся
   * стоп-аут) и снять заявку, если она появилась во время блокировки.
   */
  onOrderEvent(evt: OrderLifecycleEvent): void {
    if (this.stopped || !this.active) return;
    const order = evt.order;

    if (evt.orderStatus === 'TRIGGERED' && TRIGGERED_STOP_TYPES.has(order.origType)) {
      this.stopTriggeredAt.set(positionKey(order.symbol, order.positionSide), this.now());
    }

    if (isTerminalStatus(evt.orderStatus)) {
      this.cancelRequested.delete(order.orderId);
      return;
    }
    if (!this.blocked()) return;
    void this.track(this.cancelIfNotProtective(order, 'заявка выставлена во время блокировки'));
  }

  /**
   * Исполнение уже применено к модели позиции.
   *
   * Во время блокировки это единственный момент, когда видно, что человек всё
   * же вошёл в рынок, — и позицию надо снять сразу.
   */
  onFill(symbol: string, positionSide: PositionSide): void {
    if (this.stopped || !this.active || !this.blocked()) return;
    void this.track(this.closePosition(symbol, positionSide, 'торговля заблокирована защитой от FOMO'));
  }

  /** Позиция закрылась полностью. */
  onPositionClosed(trade: ClosedTrade): void {
    if (this.stopped || !this.active) return;

    const key = positionKey(trade.symbol, trade.positionSide);
    // Сработавший алго-стоп порождает обычный ордер, и тип исполнения по нему
    // до нас доходит уже без пометки «стоп». Поэтому недавнее срабатывание
    // стопа по этой же позиции считается тем же самым признаком.
    const triggeredAt = this.stopTriggeredAt.get(key);
    const byStop =
      trade.byStop ||
      (triggeredAt !== undefined && trade.closedAtMs - triggeredAt <= STOP_TRIGGER_GRACE_MS);
    this.stopTriggeredAt.delete(key);

    const outcome = this.detector.record({ ...trade, byStop });

    this.log.debug('сделка закрыта, серия FOMO пересчитана', {
      symbol: trade.symbol,
      positionSide: trade.positionSide,
      поСтопу: byStop,
      прожилаМс: trade.durationMs,
      серия: outcome.streak,
      нужно: this.cfg.fomoStopLossCount,
    });

    if (!outcome.triggered) return;
    this.triggers++;

    const blocking = this.cfg.fomoMode === 'block';
    const blockMs = Math.max(0, this.cfg.fomoBlockMs);
    const text =
      `${outcome.trades.length} сделки подряд закрыты стопом за ` +
      `${Math.round((outcome.trades[outcome.trades.length - 1]!.closedAtMs - outcome.trades[0]!.closedAtMs) / 1000)} с — ` +
      (blocking
        ? `торговля заблокирована на ${Math.round(blockMs / 60000)} мин`
        : 'похоже на FOMO; блокировка выключена, решайте сами');

    this.log.error('ЗАЩИТА ОТ FOMO: серия коротких стоп-аутов', {
      сделки: outcome.trades.map((t) => ({
        symbol: t.symbol,
        прожилаМс: t.durationMs,
        закрытаВ: new Date(t.closedAtMs).toISOString(),
      })),
      окноМс: this.cfg.fomoWindowMs,
      режим: this.cfg.fomoMode,
      действие: blocking ? 'блокирую торговлю' : 'только уведомление',
    });

    if (!blocking) {
      this.hooks.onFomoTriggered?.({ trades: outcome.trades, blocking: false, blockUntilMs: 0, text });
      return;
    }

    this.blockUntilMs = this.now() + blockMs;
    this.hooks.onFomoTriggered?.({
      trades: outcome.trades,
      blocking: true,
      blockUntilMs: this.blockUntilMs,
      text,
    });
    this.armBlockEnd(blockMs);
    void this.track(this.enforceBlock());
  }

  /* ---------------- Блокировка ---------------- */

  private armBlockEnd(blockMs: number): void {
    if (this.blockTimer) clearTimeout(this.blockTimer);
    this.blockTimer = setTimeout(() => {
      this.blockTimer = null;
      if (this.stopped) return;
      this.log.warn('защита от FOMO: блокировка торговли снята', {
        держаласьМин: round8(blockMs / 60000),
      });
      this.hooks.onFomoBlockEnded?.({ atMs: this.now() });
    }, blockMs);
    // Уведомление о снятии блокировки процесс держать не обязано.
    if (typeof this.blockTimer.unref === 'function') this.blockTimer.unref();
  }

  /**
   * Привести счёт в состояние «торговли нет»: снять заявки, закрыть позиции.
   *
   * Порядок именно такой. Сначала заявки: пока они висят, закрытая позиция
   * может тут же открыться заново их исполнением, и мы будем гоняться за
   * собственным хвостом.
   */
  private async enforceBlock(): Promise<void> {
    const orders = this.opts.orders.open();
    for (const order of orders) {
      await this.cancelIfNotProtective(order, 'блокировка торговли: снимаю заявку');
    }

    for (const p of this.opts.positions.open()) {
      await this.closePosition(p.symbol, p.positionSide, 'блокировка торговли защитой от FOMO');
    }
  }

  /**
   * Снимает заявку, если она не защищает открытую позицию.
   *
   * Стопы не трогаем: снимать защиту у позиции, которую мы в следующую секунду
   * будем закрывать по рынку, значит на эту секунду оставить её голой. Стоп с
   * closePosition биржа снимет сама, когда позиция закроется.
   */
  private async cancelIfNotProtective(order: OrderRecord, reason: string): Promise<void> {
    if (this.cancelRequested.has(order.orderId)) return;
    // Собственные ордера сервиса не трогаем: именно ими мы сейчас и закрываем
    // позиции. Отменять свой же рыночный ордер на закрытие — абсурд.
    if (order.own) return;
    // Заявка на выход из позиции войти в рынок не может, а значит и торговлей
    // в том смысле, который мы блокируем, не является.
    if (order.reduceOnly || order.closePosition) return;
    const pos = this.opts.positions.peek(order.symbol, order.positionSide);
    if (pos && !isZero(pos.qty) && stopKindOf(order, pos.qty) !== null) return;

    this.cancelRequested.add(order.orderId);
    this.log.warn(reason, {
      symbol: order.symbol,
      orderId: order.orderId,
      тип: order.origType,
      сторона: order.side,
      цена: round8(order.price || order.stopPrice),
    });
    try {
      const res = await this.opts.executor.cancelOrder(order.symbol, order.orderId, { algo: order.algo });
      if (res.cancelled) {
        this.cancelledByBlock++;
        this.hooks.onFomoEnforced?.({
          symbol: order.symbol,
          what: 'order-cancelled',
          detail: `снята заявка ${order.side} ${order.origType} #${order.orderId}`,
        });
      } else if (res.reason !== 'dry-run' && res.reason !== 'already-gone') {
        this.log.warn('заявку снять не удалось', { orderId: order.orderId, причина: res.reason });
      }
    } catch (e) {
      this.cancelRequested.delete(order.orderId);
      this.log.error('ошибка при снятии заявки во время блокировки', {
        symbol: order.symbol,
        orderId: order.orderId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async closePosition(symbol: string, positionSide: PositionSide, reason: string): Promise<void> {
    const key = positionKey(symbol, positionSide);
    if (this.closing.has(key)) return;
    const pos = this.opts.positions.peek(symbol, positionSide);
    if (!pos || isZero(pos.qty)) return;

    if (!this.opts.limiter.allow(this.now())) {
      this.log.error('предохранитель: закрытие позиции по блокировке FOMO ПРОПУЩЕНО', {
        symbol,
        positionSide,
      });
      return;
    }

    this.closing.add(key);
    try {
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
      if (outcome.executed) {
        this.closedByBlock++;
        this.hooks.onFomoEnforced?.({
          symbol,
          what: 'position-closed',
          detail: `позиция закрыта по рынку (${round8(Math.abs(pos.qty))})`,
        });
      } else {
        this.opts.limiter.refund(this.now());
        this.log.warn('закрыть позицию по блокировке не удалось', {
          symbol,
          positionSide,
          skipped: outcome.skipped,
          error: outcome.error,
        });
      }
    } finally {
      this.closing.delete(key);
    }
  }

  /* ---------------- Служебное ---------------- */

  stats(): {
    режимFOMO: string;
    сработалоFOMO: number;
    серияСейчас: number;
    блокировкаДо: string;
    закрытоПоБлокировке: number;
    снятоЗаявокПоБлокировке: number;
  } {
    return {
      режимFOMO:
        this.cfg.fomoMode === 'off'
          ? 'выкл'
          : this.cfg.fomoMode === 'notify'
            ? 'только уведомления'
            : 'с блокировкой',
      сработалоFOMO: this.triggers,
      серияСейчас: this.detector.current(),
      блокировкаДо: this.blocked() ? new Date(this.blockUntilMs).toISOString() : 'нет',
      закрытоПоБлокировке: this.closedByBlock,
      снятоЗаявокПоБлокировке: this.cancelledByBlock,
    };
  }

  /** Состояние для окна и трея. */
  state(): { mode: Config['fomoMode']; blocked: boolean; blockUntilMs: number; streak: number } {
    return {
      mode: this.cfg.fomoMode,
      blocked: this.blocked(),
      blockUntilMs: this.blockUntilMs,
      streak: this.detector.current(),
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.blockTimer) clearTimeout(this.blockTimer);
    this.blockTimer = null;
  }
}

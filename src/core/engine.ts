import type { Config } from '../config.js';
import { isSymbolWatched } from '../config.js';
import { analyzeFill, SKIP_REASON_TEXT } from './detector.js';
import { OrderRegistry } from './orderRegistry.js';
import { PositionStore } from './positionStore.js';
import { isZero, round8, sameSign } from '../util/num.js';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/logger.js';
import {
  positionKey,
  type DetectionResult,
  type FillEvent,
  type OrderLifecycleEvent,
  type PositionKey,
  type PositionSnapshot,
  type PositionState,
  type OrderRecord,
  type ProtectiveAction,
} from '../types.js';

export interface ExecutionOutcome {
  executed: boolean;
  /** Фактически отправленное количество после округления по stepSize. */
  sentQty?: number;
  orderId?: number;
  clientOrderId?: string;
  skipped?: 'below-min-qty' | 'position-flat' | 'dry-run';
  error?: string;
}

export interface ProtectiveExecutor {
  /** Отправляет защитный рыночный ордер. */
  execute(action: ProtectiveAction): Promise<ExecutionOutcome>;
  /** Отменяет все открытые ордера по символу (опционально). */
  cancelOpenOrders?(symbol: string): Promise<void>;
}

export interface EngineHooks {
  onDetection?(d: DetectionResult): void;
  onSkip?(d: DetectionResult): void;
  onAction?(a: ProtectiveAction, outcome: ExecutionOutcome): void;
}

export interface EngineOptions {
  cfg: Config;
  executor: ProtectiveExecutor;
  logger?: Logger;
  now?: () => number;
  hooks?: EngineHooks;
}

interface PendingAction {
  addedQty: number;
  triggers: DetectionResult[];
  timer: ReturnType<typeof setTimeout> | null;
  firstAtMs: number;
}

interface PendingSnapshot {
  snapshot: PositionSnapshot;
  timer: ReturnType<typeof setTimeout>;
}

export class Engine {
  readonly positions = new PositionStore();
  readonly orders = new OrderRegistry();

  private readonly cfg: Config;
  private readonly executor: ProtectiveExecutor;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly hooks: EngineHooks;

  private readonly pending = new Map<PositionKey, PendingAction>();
  private readonly pendingSnapshots = new Map<PositionKey, PendingSnapshot>();
  private readonly lastActionAtMs = new Map<PositionKey, number>();
  private readonly inFlight = new Set<PositionKey>();
  /**
   * Время последнего обработанного исполнения по позиции ПО ЧАСАМ БИРЖИ.
   * Снимок, снятый раньше этого момента, устарел и применяться не должен.
   */
  private readonly lastFillAtMs = new Map<PositionKey, number>();

  /** Открытые ордера на момент предыдущей сверки — для вычисления кандидатов. */
  private prevOpenOrders = new Map<number, OrderRecord>();
  private filledCandidates: OrderRecord[] = [];

  private stopped = false;
  private fills = 0;
  private restDetections = 0;
  private detections = 0;
  private staleSnapshots = 0;
  private desyncs = 0;

  constructor(opts: EngineOptions) {
    this.cfg = opts.cfg;
    this.executor = opts.executor;
    this.log = opts.logger ?? noopLogger;
    this.now = opts.now ?? (() => Date.now());
    this.hooks = opts.hooks ?? {};
  }

  /** Регистрация ордера (событие NEW и любые последующие). */
  onOrderEvent(evt: OrderLifecycleEvent): void {
    this.orders.upsert(evt.order);
    const terminal = ['CANCELED', 'FILLED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'];
    if (terminal.includes(evt.orderStatus)) {
      this.orders.markClosed(evt.order.orderId, this.now());
    }
    this.orders.sweep(this.now());
  }

  /** Загрузка снимка открытых ордеров при старте / сверке. */
  seedOrders(records: OrderLifecycleEvent['order'][]): void {
    // Ордера, которые между сверками исчезли из списка открытых или у которых
    // выросло исполненное количество, — кандидаты на роль «того самого» ордера,
    // породившего изменение позиции. Нужны, когда исполнения не приходят по WS.
    const nowIds = new Map<number, OrderRecord>();
    for (const r of records) {
      this.orders.upsert(r);
      nowIds.set(r.orderId, r);
    }

    const candidates: OrderRecord[] = [];
    for (const [orderId, prev] of this.prevOpenOrders) {
      const current = nowIds.get(orderId);
      if (!current) {
        candidates.push(prev);
      } else if (current.executedQty > prev.executedQty + 1e-12) {
        candidates.push(current);
      }
    }
    this.filledCandidates = candidates;

    this.prevOpenOrders = nowIds;
  }

  /**
   * Загрузка снимка позиций при старте / сверке (применяется немедленно).
   * `openTimes` — восстановленное время открытия по ключу `symbol|positionSide`;
   * null или отсутствие ключа означает «время неизвестно».
   */
  seedPositions(snapshots: PositionSnapshot[], openTimes?: Map<string, number | null>): void {
    const seen = new Set<PositionKey>();
    for (const s of snapshots) {
      const key = positionKey(s.symbol, s.positionSide);
      seen.add(key);
      if (isZero(s.qty)) {
        this.positions.applySnapshot(s.symbol, s.positionSide, 0, 0, s.atMs, {
          openedAtMs: null,
          openTimeKnown: true,
        });
        continue;
      }
      const existing = this.positions.peek(s.symbol, s.positionSide);

      // Биржа знает о позиции, а мы считаем её пустой — значит, мы пропустили
      // исполнения по WebSocket. Это ровно та поломка, при которой сервис молчит,
      // поэтому она должна быть громкой.
      if (!existing || isZero(existing.qty)) {
        this.desyncs++;
        this.log.warn('расхождение: биржа показывает позицию, которой мы не видели', {
          symbol: s.symbol,
          positionSide: s.positionSide,
          qty: s.qty,
          entryPrice: s.entryPrice,
          подсказка: 'исполнения не доходят по WebSocket — работает резервный путь через REST',
        });
      } else if (Math.abs(existing.qty - s.qty) > Math.abs(s.qty) * 1e-6 + 1e-9) {
        this.desyncs++;
        this.log.warn('расхождение объёма позиции с биржей', {
          symbol: s.symbol,
          positionSide: s.positionSide,
          нашОбъём: round8(existing.qty),
          объёмБиржи: round8(s.qty),
        });
        // Позиция выросла в ту же сторону, а исполнения мы не видели — разбираем
        // прирост как усреднение прямо здесь, по данным REST.
        this.detectIncreaseFromSnapshot(existing, s);
      }

      // Если позицию мы уже ведём сами и время открытия известно — не теряем его.
      const keepKnown =
        existing && !isZero(existing.qty) && existing.openTimeKnown && existing.openedAtMs !== null;
      const resolved = openTimes?.get(key) ?? null;
      const openedAtMs = keepKnown ? existing.openedAtMs : resolved;

      // Снимок мог быть снят до последнего исполнения — тогда объём и среднюю не трогаем,
      // иначе сверка откатит состояние назад и следующий долив будет разобран неверно.
      const lastFill = this.lastFillAtMs.get(key);
      if (lastFill !== undefined && s.atMs > 0 && s.atMs < lastFill) {
        this.staleSnapshots++;
        this.log.debug('снимок устарел, применяю только время открытия', {
          symbol: s.symbol,
          snapshotAtMs: s.atMs,
          lastFillAtMs: lastFill,
        });
        this.positions.setOpenTime(s.symbol, s.positionSide, openedAtMs, openedAtMs !== null);
        continue;
      }

      this.positions.applySnapshot(s.symbol, s.positionSide, s.qty, s.entryPrice, s.atMs, {
        openedAtMs,
        openTimeKnown: openedAtMs !== null,
      });
    }
    // Позиции, которых больше нет в снимке, считаем закрытыми.
    for (const p of this.positions.all()) {
      const key = positionKey(p.symbol, p.positionSide);
      if (isZero(p.qty) || seen.has(key)) continue;
      this.positions.applySnapshot(p.symbol, p.positionSide, 0, 0, Date.now(), {
        openedAtMs: null,
        openTimeKnown: true,
      });
    }
  }

  /**
   * Резервный путь: усреднение, вычисленное из разницы двух снимков позиции.
   *
   * Работает, когда исполнения не приходят по WebSocket. Средняя цена входа —
   * величина, по которой прирост восстанавливается точно:
   *   entry₁·|qty₁| = entry₀·|qty₀| + price·added   =>   price = (entry₁·|qty₁| − entry₀·|qty₀|) / added
   * То есть цену долива не нужно знать из сделки — она следует из движения средней.
   */
  private detectIncreaseFromSnapshot(prev: PositionState, next: PositionSnapshot): void {
    if (!this.cfg.restFallbackDetection) return;
    if (isZero(prev.qty) || isZero(next.qty)) return;
    if (!sameSign(prev.qty, next.qty)) return;

    const prevAbs = Math.abs(prev.qty);
    const nextAbs = Math.abs(next.qty);
    const added = nextAbs - prevAbs;
    if (added <= 0) return;
    if (prev.entryPrice <= 0 || next.entryPrice <= 0) return;

    const price = (next.entryPrice * nextAbs - prev.entryPrice * prevAbs) / added;
    if (!Number.isFinite(price) || price <= 0) return;

    const before = {
      qty: prev.qty,
      entryPrice: prev.entryPrice,
      openedAtMs: prev.openedAtMs,
      openTimeKnown: prev.openTimeKnown,
    };

    // Кандидат-ордер: из тех, что исчезли или доисполнились между сверками,
    // берём самый ранний по времени размещения — он даёт правилу «сетка выставлена
    // до открытия позиции» самый мягкий (то есть безопасный) ответ.
    const candidates = this.filledCandidates.filter(
      (o) => o.symbol === next.symbol && o.positionSide === next.positionSide && !o.reduceOnly,
    );
    const order = candidates.sort((a, b) => a.placedAtMs - b.placedAtMs)[0];

    const signedDelta = next.qty > 0 ? added : -added;
    const fill: FillEvent = {
      eventTimeMs: next.atMs,
      tradeTimeMs: next.atMs,
      symbol: next.symbol,
      positionSide: next.positionSide,
      side: next.qty > 0 ? 'BUY' : 'SELL',
      orderId: order?.orderId ?? -1,
      clientOrderId: order?.clientOrderId ?? '',
      tradeId: 0,
      lastFilledQty: added,
      lastFilledPrice: price,
      cumFilledQty: added,
      type: order?.type ?? 'MARKET',
      origType: order?.origType ?? 'MARKET',
      reduceOnly: false,
      closePosition: false,
      origQty: added,
      price,
      stopPrice: 0,
      orderStatus: 'FILLED',
    };

    const applied = this.positions.applyFill(next.symbol, next.positionSide, signedDelta, price, next.atMs);
    const result = analyzeFill({ cfg: this.cfg, fill, order, before, applied });

    const common = {
      symbol: next.symbol,
      positionSide: next.positionSide,
      источник: 'REST-сверка',
      добавленоОбъёма: round8(added),
      ценаДолива: round8(price),
      средняяДо: round8(prev.entryPrice),
      средняяПосле: round8(next.entryPrice),
      отклонениеОтВходаПроц: round8(result.adverseDeviationPct),
      ордерКандидат: order ? order.orderId : 'не найден (похоже на рыночный ордер)',
    };

    if (!result.detected) {
      const reason = result.reason ?? 'not-an-increase';
      this.log.info('прирост позиции по сверке: не усреднение', {
        ...common,
        причина: SKIP_REASON_TEXT[reason],
        reason,
      });
      this.hooks.onSkip?.(result);
      return;
    }

    this.detections++;
    this.restDetections++;
    this.log.warn('ОБНАРУЖЕНО УСРЕДНЕНИЕ В УБЫТКЕ (по сверке, WebSocket молчит)', common);
    this.hooks.onDetection?.(result);
    this.enqueue(positionKey(next.symbol, next.positionSide), result);
  }

  /** Обработка исполнения — основная точка входа детекции. */
  onFill(fill: FillEvent): DetectionResult {
    const key = positionKey(fill.symbol, fill.positionSide);
    this.fills++;
    // Время по часам БИРЖИ: с ним сравниваются снимки, чтобы не применить устаревший.
    this.lastFillAtMs.set(key, fill.tradeTimeMs || fill.eventTimeMs || this.now());
    this.cancelPendingSnapshot(key);

    const order = this.orders.get(fill.orderId);
    const p = this.positions.get(fill.symbol, fill.positionSide);
    const before = {
      qty: p.qty,
      entryPrice: p.entryPrice,
      openedAtMs: p.openedAtMs,
      openTimeKnown: p.openTimeKnown,
    };

    const signedDelta = fill.side === 'BUY' ? fill.lastFilledQty : -fill.lastFilledQty;
    const applied = this.positions.applyFill(
      fill.symbol,
      fill.positionSide,
      signedDelta,
      fill.lastFilledPrice,
      fill.tradeTimeMs || fill.eventTimeMs || this.now(),
    );

    const result = analyzeFill({ cfg: this.cfg, fill, order, before, applied });

    // Каждое исполнение видно на уровне info: без этого невозможно понять,
    // почему сервис молчит.
    const common = {
      symbol: fill.symbol,
      positionSide: fill.positionSide,
      side: fill.side,
      qty: fill.lastFilledQty,
      price: fill.lastFilledPrice,
      orderType: fill.origType,
      orderId: fill.orderId,
      позицияДо: round8(result.before.qty),
      средняяДо: round8(result.before.entryPrice),
      позицияПосле: round8(applied.after.qty),
      средняяПосле: round8(applied.after.entryPrice),
      отклонениеОтВходаПроц: round8(result.adverseDeviationPct),
    };

    if (!result.detected) {
      const reason = result.reason ?? 'not-an-increase';
      this.log.info('исполнение: не усреднение', {
        ...common,
        причина: SKIP_REASON_TEXT[reason],
        reason,
        ...(reason === 'pre-existing-order' && order
          ? {
              ордерРазмещён: new Date(order.placedAtMs).toISOString(),
              позицияОткрыта: before.openedAtMs ? new Date(before.openedAtMs).toISOString() : null,
            }
          : {}),
      });
      this.hooks.onSkip?.(result);
      return result;
    }

    this.detections++;
    this.log.warn('ОБНАРУЖЕНО УСРЕДНЕНИЕ В УБЫТКЕ', {
      ...common,
      добавленоОбъёма: result.addedQty,
    });
    this.hooks.onDetection?.(result);
    this.enqueue(key, result);
    return result;
  }

  /** Отложенное применение снимка позиции из ACCOUNT_UPDATE. */
  onPositionSnapshot(snapshot: PositionSnapshot): void {
    if (this.stopped) return;
    if (!isSymbolWatched(this.cfg, snapshot.symbol)) return;
    const key = positionKey(snapshot.symbol, snapshot.positionSide);

    // Снимок применяем с задержкой: Binance присылает ACCOUNT_UPDATE раньше
    // ORDER_TRADE_UPDATE, и немедленное применение затёрло бы среднюю цену
    // входа ДО долива, которая нужна детектору.
    this.cancelPendingSnapshot(key);
    const delay = Math.max(0, this.cfg.snapshotApplyDelayMs);
    const timer = setTimeout(() => {
      this.pendingSnapshots.delete(key);
      this.applySnapshotNow(snapshot);
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.pendingSnapshots.set(key, { snapshot, timer });
  }

  /** Немедленная сверка (REST reconcile). */
  applySnapshotNow(snapshot: PositionSnapshot): void {
    const key = positionKey(snapshot.symbol, snapshot.positionSide);
    const lastFill = this.lastFillAtMs.get(key);
    if (lastFill !== undefined && snapshot.atMs > 0 && snapshot.atMs < lastFill) {
      this.staleSnapshots++;
      this.log.debug('снимок устарел, пропущен', { key, snapshotAtMs: snapshot.atMs, lastFillAtMs: lastFill });
      return;
    }
    const p = this.positions.get(snapshot.symbol, snapshot.positionSide);
    const drift = Math.abs(p.qty - snapshot.qty);
    if (drift > 1e-9 || Math.abs(p.entryPrice - snapshot.entryPrice) > 1e-6) {
      this.log.debug('сверка позиции с биржей', {
        symbol: snapshot.symbol,
        positionSide: snapshot.positionSide,
        localQty: p.qty,
        remoteQty: snapshot.qty,
        localEntry: p.entryPrice,
        remoteEntry: snapshot.entryPrice,
      });
    }
    this.positions.applySnapshot(
      snapshot.symbol,
      snapshot.positionSide,
      snapshot.qty,
      snapshot.entryPrice,
      snapshot.atMs,
    );
  }

  private cancelPendingSnapshot(key: PositionKey): void {
    const pendingSnap = this.pendingSnapshots.get(key);
    if (pendingSnap) {
      clearTimeout(pendingSnap.timer);
      this.pendingSnapshots.delete(key);
    }
  }

  private enqueue(key: PositionKey, detection: DetectionResult): void {
    const nowMs = this.now();
    const existing = this.pending.get(key);
    if (existing) {
      existing.addedQty += detection.addedQty;
      existing.triggers.push(detection);
      return;
    }
    const entry: PendingAction = {
      addedQty: detection.addedQty,
      triggers: [detection],
      timer: null,
      firstAtMs: nowMs,
    };
    this.pending.set(key, entry);

    const window = Math.max(0, this.cfg.aggregationWindowMs);
    if (window === 0) {
      void this.flush(key);
      return;
    }
    entry.timer = setTimeout(() => {
      void this.flush(key);
    }, window);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  /** Принудительно выполнить накопленное действие (используется в тестах и при shutdown). */
  async flush(key: PositionKey): Promise<ExecutionOutcome | null> {
    const entry = this.pending.get(key);
    if (!entry) return null;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(key);

    if (this.stopped) return null;
    if (this.inFlight.has(key)) {
      this.log.warn('защитное действие уже выполняется, пропуск', { key });
      return null;
    }

    const nowMs = this.now();
    const last = this.lastActionAtMs.get(key);
    if (last !== undefined && nowMs - last < this.cfg.cooldownMs) {
      this.log.warn('cooldown, защитное действие пропущено', { key, sinceMs: nowMs - last });
      return null;
    }

    const first = entry.triggers[0];
    if (!first) return null;
    const p = this.positions.get(first.fill.symbol, first.fill.positionSide);
    if (isZero(p.qty)) {
      this.log.info('позиция уже закрыта, защитное действие не требуется', { key });
      return null;
    }

    const positionAbs = Math.abs(p.qty);
    const requestedQty =
      this.cfg.reactionMode === 'close' ? positionAbs : Math.min(entry.addedQty, positionAbs);

    const action: ProtectiveAction = {
      symbol: p.symbol,
      positionSide: p.positionSide,
      mode: this.cfg.reactionMode,
      side: p.qty > 0 ? 'SELL' : 'BUY',
      requestedQty,
      positionQty: p.qty,
      triggers: entry.triggers,
    };

    this.inFlight.add(key);
    this.lastActionAtMs.set(key, nowMs);
    try {
      const outcome = await this.executor.execute(action);
      this.hooks.onAction?.(action, outcome);
      if (outcome.executed) {
        this.log.warn('защитное действие выполнено', {
          symbol: action.symbol,
          positionSide: action.positionSide,
          mode: action.mode,
          side: action.side,
          qty: outcome.sentQty ?? action.requestedQty,
          orderId: outcome.orderId,
          triggers: entry.triggers.length,
        });
        if (this.cfg.cancelOpenOrdersOnReaction && this.executor.cancelOpenOrders) {
          await this.executor.cancelOpenOrders(action.symbol).catch((e: unknown) => {
            this.log.error('не удалось отменить открытые ордера', {
              symbol: action.symbol,
              error: String(e),
            });
          });
        }
      } else {
        this.log.warn('защитное действие не выполнено', {
          symbol: action.symbol,
          positionSide: action.positionSide,
          skipped: outcome.skipped,
          error: outcome.error,
        });
        // Не выполнили — снимаем отметку cooldown, чтобы не «проглотить» следующий триггер.
        if (outcome.skipped !== 'dry-run') this.lastActionAtMs.delete(key);
      }
      return outcome;
    } catch (e) {
      this.lastActionAtMs.delete(key);
      this.log.error('ошибка при выполнении защитного действия', {
        symbol: action.symbol,
        error: e instanceof Error ? e.message : String(e),
      });
      return { executed: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Выполнить все накопленные действия немедленно. */
  async flushAll(): Promise<void> {
    for (const key of [...this.pending.keys()]) {
      await this.flush(key);
    }
  }

  /** Счётчики для периодического отчёта о жизни сервиса. */
  stats(): {
    fills: number;
    detections: number;
    restDetections: number;
    staleSnapshots: number;
    desyncs: number;
    openPositions: number;
  } {
    return {
      fills: this.fills,
      detections: this.detections,
      staleSnapshots: this.staleSnapshots,
      restDetections: this.restDetections,
      desyncs: this.desyncs,
      openPositions: this.positions.open().length,
    };
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.pending.values()) if (entry.timer) clearTimeout(entry.timer);
    this.pending.clear();
    for (const s of this.pendingSnapshots.values()) clearTimeout(s.timer);
    this.pendingSnapshots.clear();
  }
}

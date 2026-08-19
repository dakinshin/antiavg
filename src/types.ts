/**
 * Общие типы домена.
 *
 * Соглашение по знаку количества: `qty` ВЕЗДЕ знаковое и совпадает с семантикой
 * Binance `positionAmt` / `pa`:
 *   one-way (positionSide = BOTH): long > 0, short < 0
 *   hedge   (positionSide = LONG): всегда >= 0
 *   hedge   (positionSide = SHORT): всегда <= 0
 * Благодаря этому «увеличение позиции» — это всегда «знак дельты совпадает со
 * знаком текущей позиции», независимо от режима счёта.
 */

export type OrderSide = 'BUY' | 'SELL';
export type PositionSide = 'BOTH' | 'LONG' | 'SHORT';

export type OrderType =
  | 'LIMIT'
  | 'MARKET'
  | 'STOP'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT'
  | 'TAKE_PROFIT_MARKET'
  | 'TRAILING_STOP_MARKET'
  | 'LIQUIDATION';

/** Ключ позиции. Позиция каждого символа учитывается отдельно. */
export type PositionKey = string; // `${symbol}|${positionSide}`

export function positionKey(symbol: string, positionSide: PositionSide): PositionKey {
  return `${symbol}|${positionSide}`;
}

export function parsePositionKey(key: PositionKey): { symbol: string; positionSide: PositionSide } {
  const idx = key.lastIndexOf('|');
  return {
    symbol: key.slice(0, idx),
    positionSide: key.slice(idx + 1) as PositionSide,
  };
}

/** Запись об ордере в реестре — нужна, чтобы знать время РАЗМЕЩЕНИЯ ордера. */
export interface OrderRecord {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  type: OrderType;
  /** Исходный тип (для стоп-ордеров, сработавших в MARKET/LIMIT). */
  origType: OrderType;
  /** Время размещения ордера (мс). Именно оно сравнивается с временем открытия позиции. */
  placedAtMs: number;
  origQty: number;
  /** Исполненное количество на момент последнего известия об ордере. */
  executedQty: number;
  price: number;
  stopPrice: number;
  reduceOnly: boolean;
  closePosition: boolean;
  /** true, если ордер размещён самим сервисом (защитный) — такие игнорируем. */
  own: boolean;
  /**
   * true для условных ордеров (стопы, тейки, трейлинг).
   *
   * С конца 2025 года Binance ведёт их в ОТДЕЛЬНОМ пространстве: свои id,
   * свой эндпоинт размещения и отмены, свои события `ALGO_UPDATE`. Обычный
   * `POST /fapi/v1/order` отвечает на них ошибкой -4120.
   */
  algo: boolean;
}

/**
 * Статусы, после которых ордера больше нет.
 *
 * `TRIGGERED` — про условные ордера: сработавший алго-ордер завершён, вместо
 * него биржа создаёт обычный ордер с собственным id. `TRIGGERING` — переходное
 * состояние, ордер ещё жив.
 */
const TERMINAL_STATUSES = new Set([
  'CANCELED',
  'FILLED',
  'EXPIRED',
  'REJECTED',
  'EXPIRED_IN_MATCH',
  'TRIGGERED',
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Состояние отслеживаемой позиции. */
export interface PositionState {
  symbol: string;
  positionSide: PositionSide;
  /** Знаковое количество. 0 = позиции нет. */
  qty: number;
  /** Средняя цена входа. 0, если позиции нет. */
  entryPrice: number;
  /**
   * Время открытия позиции (переход из flat в non-flat), мс.
   * null — позиция существовала на момент старта и время восстановить не удалось.
   */
  openedAtMs: number | null;
  /** true, если openedAtMs достоверно известен (позиция открылась при работающем сервисе или восстановлена по сделкам). */
  openTimeKnown: boolean;
  /**
   * Ордер, которым позиция была открыта. Его последующие частичные исполнения —
   * это то же самое вхождение, а не долив: усреднением они быть не могут.
   */
  openedByOrderId: number | null;
  /** Время последнего изменения (мс). */
  updatedAtMs: number;
}

/** Нормализованное событие исполнения (fill). */
export interface FillEvent {
  eventTimeMs: number;
  tradeTimeMs: number;
  symbol: string;
  positionSide: PositionSide;
  side: OrderSide;
  orderId: number;
  clientOrderId: string;
  tradeId: number;
  /** Количество последнего исполнения (l), всегда > 0. */
  lastFilledQty: number;
  /** Цена последнего исполнения (L). */
  lastFilledPrice: number;
  /** Накопленное исполненное количество (z). */
  cumFilledQty: number;
  type: OrderType;
  origType: OrderType;
  reduceOnly: boolean;
  closePosition: boolean;
  origQty: number;
  price: number;
  stopPrice: number;
  /** Статус ордера (X): NEW / PARTIALLY_FILLED / FILLED / ... */
  orderStatus: string;
}

/** Нормализованное событие жизненного цикла ордера (NEW / CANCELED / EXPIRED / ...). */
export interface OrderLifecycleEvent {
  eventTimeMs: number;
  transactionTimeMs: number;
  executionType: string; // x
  orderStatus: string; // X
  order: OrderRecord;
}

/** Снимок позиции из ACCOUNT_UPDATE или REST. */
export interface PositionSnapshot {
  symbol: string;
  positionSide: PositionSide;
  qty: number;
  entryPrice: number;
  unrealizedPnl?: number;
  atMs: number;
}

export type AveragingSkipReason =
  | 'not-an-increase'
  | 'position-was-flat'
  | 'not-in-loss'
  | 'below-loss-threshold'
  | 'pre-existing-order'
  | 'same-entry-order'
  | 'unknown-open-time'
  | 'liquidation-or-adl'
  | 'own-order'
  | 'reduce-only'
  | 'symbol-not-watched'
  | 'cooldown'
  | 'no-usable-price';

/** Результат анализа одного fill. */
export interface DetectionResult {
  detected: boolean;
  reason?: AveragingSkipReason;
  /** Состояние позиции ДО применения fill. */
  before: { qty: number; entryPrice: number };
  /** Состояние позиции ПОСЛЕ применения fill. */
  after: { qty: number; entryPrice: number };
  /** Добавленный (усредняющий) объём, абсолютное значение. */
  addedQty: number;
  /** Цена, по которой произошёл долив. */
  fillPrice: number;
  /** Отклонение цены долива от средней входа в процентах (>0 = хуже входа). */
  adverseDeviationPct: number;
  fill: FillEvent;
  /** Ордер, породивший fill (если известен). */
  order?: OrderRecord;
}

/** Вердикт по ещё не исполненному ордеру. */
export interface PendingOrderVerdict {
  dangerous: boolean;
  reason?: AveragingSkipReason;
  /** Цена, по которой ордер предположительно исполнится. */
  price: number;
  /** Насколько эта цена хуже средней входа, в процентах. */
  adverseDeviationPct: number;
  order: OrderRecord;
}

export type ReactionMode = 'reduce' | 'close';

/** Задание на защитное действие. */
export interface ProtectiveAction {
  symbol: string;
  positionSide: PositionSide;
  mode: ReactionMode;
  /** Сторона защитного ордера (противоположна стороне позиции). */
  side: OrderSide;
  /** Требуемое количество (абсолютное, до округления по stepSize). */
  requestedQty: number;
  /** Текущее знаковое количество позиции на момент принятия решения. */
  positionQty: number;
  /** Триггеры, которые привели к этому действию. */
  triggers: DetectionResult[];
}

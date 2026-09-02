import { isZero, sameSign } from '../util/num.js';
import { positionKey, type PositionKey, type PositionSide, type PositionState } from '../types.js';

export interface ApplyFillResult {
  before: { qty: number; entryPrice: number };
  after: { qty: number; entryPrice: number };
  /** Позиция открылась этим исполнением (была flat). */
  opened: boolean;
  /** Позиция закрылась этим исполнением. */
  closed: boolean;
  /** Позиция перевернулась (был long -> стал short или наоборот). */
  flipped: boolean;
  /** Позиция увеличилась в ту же сторону. */
  increased: boolean;
  /** Абсолютная величина, на которую позиция увеличилась (0, если не увеличилась). */
  addedQty: number;
}

/**
 * Состояние позиций, рассчитанное ПО ИСПОЛНЕНИЯМ.
 *
 * Почему не берём entryPrice напрямую из ACCOUNT_UPDATE: Binance при
 * одновременной отправке присылает ACCOUNT_UPDATE ПЕРЕД ORDER_TRADE_UPDATE, то
 * есть на момент обработки fill'а биржевой entryPrice уже пересчитан с учётом
 * этого же долива. Для детекции нужна средняя цена ДО долива, поэтому позицию
 * ведём сами, а снимки биржи применяем отложенно (см. applySnapshot).
 */
export class PositionStore {
  private readonly positions = new Map<PositionKey, PositionState>();

  get(symbol: string, positionSide: PositionSide): PositionState {
    const key = positionKey(symbol, positionSide);
    let p = this.positions.get(key);
    if (!p) {
      p = {
        symbol,
        positionSide,
        qty: 0,
        entryPrice: 0,
        openedAtMs: null,
        openTimeKnown: true, // позиции нет — «время открытия» тривиально известно
        openedByOrderId: null,
        updatedAtMs: 0,
      };
      this.positions.set(key, p);
    }
    return p;
  }

  peek(symbol: string, positionSide: PositionSide): PositionState | undefined {
    return this.positions.get(positionKey(symbol, positionSide));
  }

  all(): PositionState[] {
    return [...this.positions.values()];
  }

  open(): PositionState[] {
    return this.all().filter((p) => !isZero(p.qty));
  }

  /**
   * Применяет исполнение к позиции и возвращает состояния до/после.
   * `signedDelta` — знаковое изменение позиции: BUY = +qty, SELL = -qty.
   */
  applyFill(
    symbol: string,
    positionSide: PositionSide,
    signedDelta: number,
    price: number,
    atMs: number,
    orderId: number | null = null,
  ): ApplyFillResult {
    const p = this.get(symbol, positionSide);
    const before = { qty: p.qty, entryPrice: p.entryPrice };

    const wasFlat = isZero(p.qty);
    const next = p.qty + signedDelta;

    let opened = false;
    let closed = false;
    let flipped = false;
    let increased = false;
    let addedQty = 0;

    if (wasFlat) {
      // Открытие новой позиции.
      p.qty = next;
      p.entryPrice = price;
      p.openedAtMs = atMs;
      p.openTimeKnown = true;
      p.openedByOrderId = orderId;
      opened = !isZero(next);
    } else if (sameSign(p.qty, signedDelta)) {
      // Долив в ту же сторону — пересчёт средней.
      // Долив по той же цене НЕ пересчитываем: деление вносит ошибку порядка
      // 1e-18, из-за которой средняя оказывается «чуть выше» цены и следующий
      // долив по той же цене выглядит убыточным.
      if (Math.abs(price - p.entryPrice) > Math.abs(p.entryPrice) * 1e-12) {
        const notional = Math.abs(p.qty) * p.entryPrice + Math.abs(signedDelta) * price;
        const totalQty = Math.abs(p.qty) + Math.abs(signedDelta);
        p.entryPrice = totalQty > 0 ? notional / totalQty : price;
      }
      p.qty = next;
      increased = true;
      addedQty = Math.abs(signedDelta);
    } else if (isZero(next)) {
      // Полное закрытие.
      p.qty = 0;
      p.entryPrice = 0;
      p.openedAtMs = null;
      p.openTimeKnown = true;
      p.openedByOrderId = null;
      closed = true;
    } else if (sameSign(next, p.qty)) {
      // Частичное закрытие — средняя не меняется.
      p.qty = next;
    } else {
      // Переворот: остаток открывается по цене исполнения.
      p.qty = next;
      p.entryPrice = price;
      p.openedAtMs = atMs;
      p.openTimeKnown = true;
      p.openedByOrderId = orderId;
      flipped = true;
    }

    p.updatedAtMs = atMs;
    return { before, after: { qty: p.qty, entryPrice: p.entryPrice }, opened, closed, flipped, increased, addedQty };
  }

  /**
   * Применяет авторитетный снимок с биржи (ACCOUNT_UPDATE / REST).
   * Время открытия сохраняется, если позиция не меняла знак и не была flat.
   */
  applySnapshot(
    symbol: string,
    positionSide: PositionSide,
    qty: number,
    entryPrice: number,
    atMs: number,
    openTimeHint?: { openedAtMs: number | null; openTimeKnown: boolean },
  ): { changed: boolean; prevQty: number } {
    const p = this.get(symbol, positionSide);
    const prevQty = p.qty;
    const changed = !isZero(qty - p.qty) || Math.abs(entryPrice - p.entryPrice) > 1e-9;

    const wasFlat = isZero(prevQty);
    const isFlat = isZero(qty);

    p.qty = isFlat ? 0 : qty;
    p.entryPrice = isFlat ? 0 : entryPrice;
    p.updatedAtMs = atMs;

    if (isFlat) {
      p.openedAtMs = null;
      p.openTimeKnown = true;
      p.openedByOrderId = null;
    } else if (openTimeHint) {
      p.openedAtMs = openTimeHint.openedAtMs;
      p.openTimeKnown = openTimeHint.openTimeKnown;
    } else if (wasFlat) {
      // Позиция появилась «из ниоткуда» (мы пропустили исполнения) — время неизвестно.
      p.openedAtMs = atMs;
      p.openTimeKnown = false;
      p.openedByOrderId = null;
    } else if (!sameSign(prevQty, qty)) {
      // Переворот, замеченный только по снимку.
      p.openedAtMs = atMs;
      p.openTimeKnown = false;
      p.openedByOrderId = null;
    }

    return { changed, prevQty };
  }

  /** Явно задать время открытия (после восстановления по истории сделок). */
  setOpenTime(symbol: string, positionSide: PositionSide, openedAtMs: number | null, known: boolean): void {
    const p = this.get(symbol, positionSide);
    p.openedAtMs = openedAtMs;
    p.openTimeKnown = known;
  }

  clear(): void {
    this.positions.clear();
  }
}

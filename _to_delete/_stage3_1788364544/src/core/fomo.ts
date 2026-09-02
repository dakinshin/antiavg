/**
 * Защита от FOMO — чистая часть.
 *
 * FOMO (fear of missing opportunity) у трейдера выглядит так: сильное движение,
 * вход, мгновенный стоп, немедленный повторный вход, снова стоп — и так по кругу,
 * пока депозит не кончится. Убытки в этот момент не осмысляются: работает не
 * расчёт, а желание успеть.
 *
 * Признак, по которому это состояние отличается от нормальной торговли, —
 * СЕРИЯ коротких сделок, закрытых стопом, подряд и в узком окне времени.
 * Одна такая сделка ничего не значит: скальпер живёт ими. Три подряд за
 * полминуты — уже поведение, а не рынок.
 *
 * Здесь только арифметика серии: ни сети, ни таймеров, ни ордеров. Всё, что
 * действует, живёт в `fomoGuard.ts`.
 */
import type { PositionSide } from '../types.js';

/** Закрывшаяся сделка — вход и полный выход из позиции. */
export interface ClosedTrade {
  symbol: string;
  positionSide: PositionSide;
  /** Время полного закрытия позиции, мс. */
  closedAtMs: number;
  /**
   * Сколько позиция прожила, мс. `null` — время открытия неизвестно (позиция
   * существовала до запуска сервиса). Такая сделка в серию не засчитывается:
   * условие «не дольше N секунд» по ней проверить нечем.
   */
  durationMs: number | null;
  /** Позиция закрыта стоп-ордером (или ликвидацией), а не руками и не по тейку. */
  byStop: boolean;
}

export interface FomoParams {
  /** Окно, в которое должна уместиться серия, мс. */
  windowMs: number;
  /** Сколько сделок подряд образуют серию. */
  count: number;
  /** Максимальная длительность одной сделки серии, мс. */
  maxTradeDurationMs: number;
}

export interface FomoOutcome {
  /** Серия набрана — пора действовать. */
  triggered: boolean;
  /** Длина текущей серии ПОСЛЕ этой сделки. */
  streak: number;
  /** Сделки серии — только когда triggered. */
  trades: ClosedTrade[];
}

/**
 * Считает серии коротких стоп-аутов.
 *
 * «Подряд» понимается буквально: любая сделка, которая в условие не попала —
 * закрыта руками, по тейку или прожила дольше положенного, — серию обнуляет.
 * Более мягкое прочтение («просто N стопов за окно») ловило бы и спокойную
 * торговлю, где между стопами были нормальные сделки, а это уже не FOMO.
 */
export class FomoDetector {
  private streak: ClosedTrade[] = [];

  constructor(private readonly params: FomoParams) {}

  /** Учесть закрывшуюся сделку. */
  record(trade: ClosedTrade): FomoOutcome {
    const qualifies =
      trade.byStop &&
      trade.durationMs !== null &&
      trade.durationMs <= Math.max(0, this.params.maxTradeDurationMs);

    if (!qualifies) {
      this.streak = [];
      return { triggered: false, streak: 0, trades: [] };
    }

    this.streak.push(trade);

    // Из начала выбрасываем то, что уже не помещается в окно. Это не поломка
    // серии: сделки, оставшиеся в окне, по-прежнему идут подряд и могут
    // достроиться до полной серии следующими.
    const window = Math.max(0, this.params.windowMs);
    while (this.streak.length > 0 && trade.closedAtMs - this.streak[0]!.closedAtMs > window) {
      this.streak.shift();
    }

    const need = Math.max(1, Math.floor(this.params.count));
    if (this.streak.length < need) {
      return { triggered: false, streak: this.streak.length, trades: [] };
    }

    const trades = this.streak.slice();
    // Серию обнуляем: иначе каждая следующая сделка срабатывала бы снова,
    // и одно и то же событие обрушивалось бы на человека пачкой.
    this.streak = [];
    return { triggered: true, streak: trades.length, trades };
  }

  /** Текущая длина серии — для отчётов. */
  current(): number {
    return this.streak.length;
  }

  reset(): void {
    this.streak = [];
  }
}

/** Типы ордеров, закрытие которыми считается стоп-аутом. */
const STOP_CLOSE_TYPES = new Set([
  'STOP_MARKET',
  'STOP',
  'TRAILING_STOP_MARKET',
  // Ликвидация — тот же стоп-аут, только поставленный биржей. Психологически
  // это событие ровно того же ряда, и не считать его было бы странно.
  'LIQUIDATION',
]);

export function isStopCloseType(origType: string): boolean {
  return STOP_CLOSE_TYPES.has(origType);
}

/**
 * Защита от FOMO — чистая часть.
 *
 * FOMO (fear of missing opportunity) у трейдера выглядит так: сильное движение,
 * вход, мгновенный стоп, немедленный повторный вход, снова стоп — и так по кругу,
 * пока депозит не кончится. Убытки в этот момент не осмысляются: работает не
 * расчёт, а желание успеть.
 *
 * Состояние опознаётся по ДВУМ независимым признакам. Достаточно любого:
 *
 *   1. СЕРИЯ — несколько коротких сделок ПОДРЯД, закрытых стопом в убыток, в
 *      узком окне времени. Ловит быстрый цикл «вход — стоп — снова вход».
 *   2. ПАЧКА — несколько убыточных сделок, ОТКРЫТЫХ в пределах минуты.
 *      Ни «подряд», ни ограничения на длительность: ловит того, кто набрал
 *      несколько позиций разом и все их потерял, даже если между ними были
 *      удачные сделки и держал он их долго.
 *
 * Первый признак про ритм выходов, второй — про кучность входов. Один без
 * другого оставляет дыру: серия не заметит залпового набора позиций, а пачка —
 * методичного долбления в одну точку с паузами.
 *
 * Здесь только арифметика: ни сети, ни таймеров, ни ордеров. Всё, что
 * действует, живёт в `fomoGuard.ts`.
 */
import type { PositionSide } from '../types.js';

/** Закрывшаяся сделка — вход и полный выход из позиции. */
export interface ClosedTrade {
  symbol: string;
  positionSide: PositionSide;
  /**
   * Время открытия позиции, мс. `null` — неизвестно (позиция существовала до
   * запуска сервиса). Такая сделка не идёт ни в один из признаков: по ней
   * нечем проверить ни длительность, ни кучность входов.
   */
  openedAtMs: number | null;
  /** Время полного закрытия позиции, мс. */
  closedAtMs: number;
  /** Сколько позиция прожила, мс. `null` вместе с `openedAtMs`. */
  durationMs: number | null;
  /** Позиция закрыта стоп-ордером (или ликвидацией), а не руками и не по тейку. */
  byStop: boolean;
  /** Результат сделки в валюте котировки, без комиссии. Минус — убыток. */
  pnl: number;
  /** Номинал позиции на момент закрытия — база для относительного порога. */
  notional: number;
}

export interface FomoParams {
  /** Окно, в которое должна уместиться серия стоп-аутов, мс. */
  windowMs: number;
  /** Сколько стоп-аутов подряд образуют серию. 0 — признак выключен. */
  count: number;
  /** Максимальная длительность одной сделки серии, мс. */
  maxTradeDurationMs: number;
  /**
   * Минимальный убыток сделки, % от номинала позиции. Ниже — сделка считается
   * закрытой в безубыток и ни в один признак не идёт.
   */
  minLossPct: number;
  /** Окно, в которое должны уложиться ОТКРЫТИЯ убыточных сделок, мс. */
  burstWindowMs: number;
  /** Сколько убыточных сделок в этом окне образуют пачку. 0 — признак выключен. */
  burstCount: number;
  /**
   * Сколько помнить убыточную сделку ради признака «пачка», считая от её
   * ЗАКРЫТИЯ. Нужно, чтобы давно закрытая пачка не выстрелила задним числом:
   * сделка, открытая в общем окне, но провисевшая час, иначе включила бы
   * блокировку тогда, когда помогать уже некому.
   */
  burstRetentionMs: number;
}

/** Какой из двух признаков сработал. */
export type FomoReason = 'streak' | 'burst';

export interface FomoOutcome {
  /** Признак набран — пора действовать. */
  triggered: boolean;
  /** Какой именно признак сработал. */
  reason?: FomoReason;
  /** Длина текущей серии стоп-аутов ПОСЛЕ этой сделки. */
  streak: number;
  /** Сколько убыточных сделок сейчас в самой плотной пачке. */
  burst: number;
  /** Сделки, образовавшие признак, — только когда triggered. */
  trades: ClosedTrade[];
}

export class FomoDetector {
  /** Признак 1: непрерывная серия коротких стоп-аутов. */
  private streak: ClosedTrade[] = [];
  /** Признак 2: недавние убыточные сделки, в порядке закрытия. */
  private losses: ClosedTrade[] = [];
  /** Самая плотная пачка на момент последней сделки — для отчётов. */
  private burstSize = 0;

  constructor(private readonly params: FomoParams) {}

  /**
   * Убыточна ли сделка настолько, чтобы её считать.
   *
   * Порог нужен не для красоты. Стоп, переставленный в безубыток, срабатывает
   * ровно на цене входа, но исполняется по рынку — и результат выходит чуть
   * отрицательным на проскальзывание. Считать такую сделку убыточной значило бы
   * записывать в FOMO ровно то поведение, которое ему противоположно:
   * дисциплинированный выход в ноль.
   *
   * Порог относительный — доля номинала позиции. Абсолютная сумма в USDT
   * зависела бы от размера счёта, и одно и то же число значило бы разное на
   * депозите в 200 и в 20 000.
   */
  private isLoss(trade: ClosedTrade): boolean {
    if (trade.pnl >= 0) return false;
    const threshold = (Math.max(0, trade.notional) * Math.max(0, this.params.minLossPct)) / 100;
    return -trade.pnl > threshold;
  }

  /** Учесть закрывшуюся сделку. */
  record(trade: ClosedTrade): FomoOutcome {
    const loss = this.isLoss(trade);
    const known = trade.openedAtMs !== null && trade.durationMs !== null;

    const streakTrades = this.recordStreak(trade, loss, known);
    const burstTrades = this.recordBurst(trade, loss, known);

    // Если сработали оба, докладываем серию: она строже (требует стопов и
    // коротких сделок), а значит точнее описывает, что именно произошло.
    const fired = streakTrades ?? burstTrades;
    if (fired) {
      // Оба накопителя обнуляем при любом срабатывании: иначе сразу после
      // блокировки второй признак выстрелил бы на тех же самых сделках.
      this.streak = [];
      this.losses = [];
      this.burstSize = 0;
      return {
        triggered: true,
        reason: streakTrades ? 'streak' : 'burst',
        streak: this.streak.length,
        burst: this.burstSize,
        trades: fired,
      };
    }

    return { triggered: false, streak: this.streak.length, burst: this.burstSize, trades: [] };
  }

  /** Признак 1. Возвращает сделки серии, если она набрана. */
  private recordStreak(trade: ClosedTrade, loss: boolean, known: boolean): ClosedTrade[] | null {
    const need = Math.floor(this.params.count);
    if (need <= 0) return null;

    const qualifies =
      trade.byStop &&
      loss &&
      known &&
      trade.durationMs! <= Math.max(0, this.params.maxTradeDurationMs);

    if (!qualifies) {
      // «Подряд» понимается буквально: любая сделка, которая в условие не
      // попала, серию обнуляет. Мягкое прочтение ловило бы и спокойную
      // торговлю, где между стопами были нормальные сделки.
      this.streak = [];
      return null;
    }

    this.streak.push(trade);

    // Из начала выбрасываем то, что уже не помещается в окно. Это не поломка
    // серии: сделки, оставшиеся в окне, по-прежнему идут подряд и могут
    // достроиться до полной серии следующими.
    const window = Math.max(0, this.params.windowMs);
    while (this.streak.length > 0 && trade.closedAtMs - this.streak[0]!.closedAtMs > window) {
      this.streak.shift();
    }

    return this.streak.length >= need ? this.streak.slice() : null;
  }

  /**
   * Признак 2. Возвращает сделки пачки, если она набрана.
   *
   * Считаются ЛЮБЫЕ убыточные сделки, не только закрытые стопом: человек в
   * этом состоянии столько же раз закрывает руками, поймав очередной минус.
   * Окно меряется по времени ОТКРЫТИЯ — суть признака в кучности входов, а не
   * в том, когда позиции доехали до выхода.
   */
  private recordBurst(trade: ClosedTrade, loss: boolean, known: boolean): ClosedTrade[] | null {
    const need = Math.floor(this.params.burstCount);
    if (need <= 0) return null;
    if (!loss || !known) return null;

    this.losses.push(trade);

    // Забываем всё, что закрылось слишком давно.
    const retention = Math.max(0, this.params.burstRetentionMs);
    this.losses = this.losses.filter((t) => trade.closedAtMs - t.closedAtMs <= retention);

    const window = Math.max(0, this.params.burstWindowMs);
    const opens = this.losses.map((t) => t.openedAtMs!).sort((a, b) => a - b);
    const self = trade.openedAtMs!;

    // Ищем окно длиной `window`, которое накрывает открытие ЭТОЙ сделки и ещё
    // как минимум need−1 чужих. Требование включить свежую сделку не даёт
    // одному и тому же старому набору срабатывать снова и снова.
    let best: ClosedTrade[] | null = null;
    for (const lo of opens) {
      if (lo > self || self - lo > window) continue;
      const group = this.losses.filter((t) => t.openedAtMs! >= lo && t.openedAtMs! <= lo + window);
      if (group.length > this.burstSize) this.burstSize = group.length;
      if (group.length >= need && (!best || group.length > best.length)) best = group;
    }
    return best;
  }

  /** Текущая длина серии стоп-аутов — для отчётов. */
  current(): number {
    return this.streak.length;
  }

  /** Самая плотная пачка убыточных входов — для отчётов. */
  currentBurst(): number {
    return this.burstSize;
  }

  reset(): void {
    this.streak = [];
    this.losses = [];
    this.burstSize = 0;
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

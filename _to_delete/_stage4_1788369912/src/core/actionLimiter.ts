/**
 * Часовой предохранитель на защитные действия.
 *
 * Общий на весь сервис: и детектор усреднения, и риск-модуль тратят один и тот
 * же лимит. Иначе «30 действий в час» превратилось бы в 60 — по 30 на каждый
 * механизм, — а человек, выставляя число, имеет в виду счёт целиком.
 *
 * Окно скользящее: как только самые старые действия выходят за пределы часа,
 * лимит снова разрешает работать. Отметка «СРАБОТАЛ» при этом остаётся навсегда
 * — она нужна человеку, чтобы заметить, что такое вообще случалось.
 */
export class ActionLimiter {
  private readonly timestamps: number[] = [];
  private trippedFlag = false;

  constructor(
    private readonly limitPerHour: number,
    private readonly onTrip?: (count: number, limit: number) => void,
  ) {}

  /** Разрешено ли ещё одно действие. Разрешённое сразу засчитывается. */
  allow(nowMs: number): boolean {
    if (this.limitPerHour <= 0) return true;

    const hourAgo = nowMs - 3600_000;
    while (this.timestamps.length > 0 && this.timestamps[0]! < hourAgo) this.timestamps.shift();

    if (this.timestamps.length >= this.limitPerHour) {
      // Сообщаем один раз: иначе лог утонет в повторах при каждом событии.
      if (!this.trippedFlag) {
        this.trippedFlag = true;
        this.onTrip?.(this.timestamps.length, this.limitPerHour);
      }
      return false;
    }
    this.timestamps.push(nowMs);
    return true;
  }

  /** Действие не состоялось — возвращаем потраченный слот. */
  refund(nowMs: number): void {
    const idx = this.timestamps.lastIndexOf(nowMs);
    if (idx >= 0) this.timestamps.splice(idx, 1);
    else this.timestamps.pop();
  }

  count(): number {
    return this.timestamps.length;
  }

  tripped(): boolean {
    return this.trippedFlag;
  }
}

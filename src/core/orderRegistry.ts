import type { OrderRecord } from '../types.js';

/**
 * Реестр ордеров. Хранит время РАЗМЕЩЕНИЯ ордера — ключевую величину для
 * правила «ордер, размещённый до открытия позиции, усреднением не считается».
 *
 * Записи держим ещё какое-то время после закрытия ордера: fill и финальное
 * событие приходят вместе, а сверки/логи могут запросить ордер позже.
 */
export class OrderRegistry {
  private readonly byId = new Map<number, OrderRecord>();
  private readonly closedAt = new Map<number, number>();

  constructor(private readonly retentionMs = 10 * 60_000) {}

  /**
   * Регистрирует ордер. Время размещения фиксируется ОДИН РАЗ — при первом
   * появлении ордера; последующие события (частичные исполнения, изменения)
   * его не сдвигают.
   */
  upsert(record: OrderRecord): OrderRecord {
    const existing = this.byId.get(record.orderId);
    if (existing) {
      const merged: OrderRecord = {
        ...existing,
        ...record,
        placedAtMs: Math.min(existing.placedAtMs, record.placedAtMs),
        own: existing.own || record.own,
      };
      this.byId.set(record.orderId, merged);
      return merged;
    }
    this.byId.set(record.orderId, record);
    return record;
  }

  get(orderId: number): OrderRecord | undefined {
    return this.byId.get(orderId);
  }

  has(orderId: number): boolean {
    return this.byId.has(orderId);
  }

  /** Помечает ордер завершённым — запись будет удалена по истечении retention. */
  markClosed(orderId: number, nowMs: number): void {
    if (this.byId.has(orderId)) this.closedAt.set(orderId, nowMs);
  }

  /** Удаляет просроченные записи закрытых ордеров. */
  sweep(nowMs: number): number {
    let removed = 0;
    for (const [orderId, ts] of this.closedAt) {
      if (nowMs - ts >= this.retentionMs) {
        this.byId.delete(orderId);
        this.closedAt.delete(orderId);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.byId.size;
  }

  all(): OrderRecord[] {
    return [...this.byId.values()];
  }

  clear(): void {
    this.byId.clear();
    this.closedAt.clear();
  }
}

import { describe, expect, it } from 'vitest';
import { OrderRegistry } from '../src/core/orderRegistry.js';
import type { OrderRecord } from '../src/types.js';

function rec(over: Partial<OrderRecord> & { orderId: number; placedAtMs: number }): OrderRecord {
  return {
    clientOrderId: `c${over.orderId}`,
    symbol: 'BTCUSDT',
    side: 'BUY',
    positionSide: 'BOTH',
    type: 'LIMIT',
    origType: 'LIMIT',
    origQty: 1,
    price: 100,
    stopPrice: 0,
    reduceOnly: false,
    closePosition: false,
    own: false,
    ...over,
  };
}

describe('OrderRegistry', () => {
  it('время размещения фиксируется по первому событию и не сдвигается', () => {
    const r = new OrderRegistry();
    r.upsert(rec({ orderId: 1, placedAtMs: 1000 }));
    r.upsert(rec({ orderId: 1, placedAtMs: 5000, origQty: 2 }));
    const stored = r.get(1);
    expect(stored?.placedAtMs).toBe(1000);
    expect(stored?.origQty).toBe(2);
  });

  it('флаг own не теряется при обновлении', () => {
    const r = new OrderRegistry();
    r.upsert(rec({ orderId: 2, placedAtMs: 1000, own: true }));
    r.upsert(rec({ orderId: 2, placedAtMs: 1000, own: false }));
    expect(r.get(2)?.own).toBe(true);
  });

  it('закрытые ордера удаляются после retention', () => {
    const r = new OrderRegistry(1000);
    r.upsert(rec({ orderId: 3, placedAtMs: 0 }));
    r.markClosed(3, 10_000);
    expect(r.sweep(10_500)).toBe(0);
    expect(r.has(3)).toBe(true);
    expect(r.sweep(11_000)).toBe(1);
    expect(r.has(3)).toBe(false);
  });
});

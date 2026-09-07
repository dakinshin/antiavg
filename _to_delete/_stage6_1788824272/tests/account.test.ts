import { describe, expect, it } from 'vitest';
import { AccountService } from '../src/binance/account.js';
import { BinanceRestClient } from '../src/binance/rest.js';
import type { RawUserTrade } from '../src/binance/mappers.js';

function makeRestWithTrades(trades: RawUserTrade[]): BinanceRestClient {
  const rest = new BinanceRestClient({
    baseUrl: 'https://example.invalid',
    apiKey: 'k',
    apiSecret: 's',
    recvWindow: 5000,
  });
  // Подменяем только signedGet — сеть не трогаем.
  (rest as unknown as { signedGet: (p: string) => Promise<unknown> }).signedGet = async (path: string) => {
    if (path === '/fapi/v1/userTrades') return trades;
    throw new Error(`unexpected path ${path}`);
  };
  return rest;
}

function trade(over: Partial<RawUserTrade> & { id: number; time: number; side: 'BUY' | 'SELL'; qty: string }): RawUserTrade {
  return {
    symbol: 'BTCUSDT',
    orderId: over.id,
    positionSide: 'BOTH',
    price: '50000',
    ...over,
  } as RawUserTrade;
}

describe('восстановление времени открытия позиции по сделкам', () => {
  it('находит момент последнего перехода из flat в позицию', async () => {
    const rest = makeRestWithTrades([
      trade({ id: 1, time: 1000, side: 'BUY', qty: '1' }),
      trade({ id: 2, time: 2000, side: 'SELL', qty: '1' }), // закрылись
      trade({ id: 3, time: 5000, side: 'BUY', qty: '2' }), // <- открытие текущей позиции
      trade({ id: 4, time: 6000, side: 'BUY', qty: '1' }),
    ]);
    const svc = new AccountService(rest, 'antiavg');
    const res = await svc.resolveOpenTimes(
      [{ symbol: 'BTCUSDT', positionSide: 'BOTH', qty: 3, entryPrice: 50000, atMs: 9999 }],
      24,
    );
    expect(res.get('BTCUSDT|BOTH')).toBe(5000);
  });

  it('переворот позиции считается новым открытием', async () => {
    const rest = makeRestWithTrades([
      trade({ id: 1, time: 1000, side: 'BUY', qty: '1' }),
      trade({ id: 2, time: 4000, side: 'SELL', qty: '3' }), // переворот в шорт -2
    ]);
    const svc = new AccountService(rest, 'antiavg');
    const res = await svc.resolveOpenTimes(
      [{ symbol: 'BTCUSDT', positionSide: 'BOTH', qty: -2, entryPrice: 50000, atMs: 9999 }],
      24,
    );
    expect(res.get('BTCUSDT|BOTH')).toBe(4000);
  });

  it('если реплей не сходится с фактическим объёмом — время неизвестно', async () => {
    const rest = makeRestWithTrades([trade({ id: 1, time: 1000, side: 'BUY', qty: '1' })]);
    const svc = new AccountService(rest, 'antiavg');
    const res = await svc.resolveOpenTimes(
      [{ symbol: 'BTCUSDT', positionSide: 'BOTH', qty: 5, entryPrice: 50000, atMs: 9999 }],
      24,
    );
    expect(res.get('BTCUSDT|BOTH')).toBeNull();
  });

  it('hedge mode: стороны восстанавливаются независимо', async () => {
    const rest = makeRestWithTrades([
      trade({ id: 1, time: 1000, side: 'BUY', qty: '1', positionSide: 'LONG' }),
      trade({ id: 2, time: 3000, side: 'SELL', qty: '2', positionSide: 'SHORT' }),
    ]);
    const svc = new AccountService(rest, 'antiavg');
    const res = await svc.resolveOpenTimes(
      [
        { symbol: 'BTCUSDT', positionSide: 'LONG', qty: 1, entryPrice: 50000, atMs: 9999 },
        { symbol: 'BTCUSDT', positionSide: 'SHORT', qty: -2, entryPrice: 50000, atMs: 9999 },
      ],
      24,
    );
    expect(res.get('BTCUSDT|LONG')).toBe(1000);
    expect(res.get('BTCUSDT|SHORT')).toBe(3000);
  });
});

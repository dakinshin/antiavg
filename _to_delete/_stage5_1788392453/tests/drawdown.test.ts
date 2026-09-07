/**
 * Замок на выключение защиты: пока позиция в просадке, отключить сервис нельзя.
 * Механизм самоограничения — чтобы нельзя было выключить охранника в момент
 * слабости и тут же усредниться.
 */
import { describe, expect, it } from 'vitest';
import { findDrawdown } from '../src/core/drawdown.js';
import { ConfigSchema } from '../src/config.js';
import type { PositionSnapshot } from '../src/types.js';

function pos(over: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    symbol: 'BTCUSDT',
    positionSide: 'BOTH',
    qty: 1,
    entryPrice: 50000,
    unrealizedPnl: 0,
    atMs: 1000,
    ...over,
  };
}

describe('определение просадки', () => {
  it('позиция в минусе запирает выключение', () => {
    const st = findDrawdown([pos({ unrealizedPnl: -12.5 })]);
    expect(st.inDrawdown).toBe(true);
    expect(st.totalLoss).toBe(-12.5);
    expect(st.positions[0]?.symbol).toBe('BTCUSDT');
  });

  it('позиция в плюсе замок не ставит', () => {
    expect(findDrawdown([pos({ unrealizedPnl: 7 })]).inDrawdown).toBe(false);
  });

  it('нулевой PnL просадкой не считается', () => {
    expect(findDrawdown([pos({ unrealizedPnl: 0 })]).inDrawdown).toBe(false);
  });

  it('закрытая позиция игнорируется, даже если PnL отрицательный', () => {
    expect(findDrawdown([pos({ qty: 0, unrealizedPnl: -100 })]).inDrawdown).toBe(false);
  });

  it('пустой список — замка нет', () => {
    expect(findDrawdown([]).inDrawdown).toBe(false);
  });

  it('порог отсекает копеечные просадки', () => {
    expect(findDrawdown([pos({ unrealizedPnl: -0.4 })], 1).inDrawdown).toBe(false);
    expect(findDrawdown([pos({ unrealizedPnl: -1.4 })], 1).inDrawdown).toBe(true);
  });

  it('порог задаётся положительным числом, знак не важен', () => {
    expect(findDrawdown([pos({ unrealizedPnl: -1.4 })], -1).inDrawdown).toBe(true);
  });

  it('достаточно одной убыточной позиции из нескольких', () => {
    const st = findDrawdown([
      pos({ symbol: 'BTCUSDT', unrealizedPnl: 30 }),
      pos({ symbol: 'ETHUSDT', unrealizedPnl: -5 }),
    ]);
    expect(st.inDrawdown).toBe(true);
    expect(st.positions).toHaveLength(1);
    expect(st.positions[0]?.symbol).toBe('ETHUSDT');
  });

  it('суммарный убыток складывается по всем красным позициям', () => {
    const st = findDrawdown([
      pos({ symbol: 'BTCUSDT', unrealizedPnl: -10 }),
      pos({ symbol: 'ETHUSDT', unrealizedPnl: -2.5 }),
      pos({ symbol: 'SOLUSDT', unrealizedPnl: 100 }),
    ]);
    expect(st.positions).toHaveLength(2);
    expect(st.totalLoss).toBeCloseTo(-12.5);
  });

  it('позиция без данных о PnL не запирает — судить не о чем', () => {
    const st = findDrawdown([{ ...pos(), unrealizedPnl: undefined }]);
    expect(st.inDrawdown).toBe(false);
  });

  it('шорт в просадке запирает так же, как лонг', () => {
    expect(findDrawdown([pos({ qty: -3, unrealizedPnl: -8 })]).inDrawdown).toBe(true);
  });
});

describe('замки просадки: значения по умолчанию', () => {
  it('замок на выключение защиты включён, замок на настройки — нет', () => {
    const cfg = ConfigSchema.parse({ apiKey: 'k', apiSecret: 's' });
    expect(cfg.lockStopWhileInDrawdown).toBe(true);
    expect(cfg.lockSettingsWhileInDrawdown).toBe(false);
    expect(cfg.drawdownLockMinLoss).toBe(0);
  });

  it('строгий замок включается переменной окружения', () => {
    const cfg = ConfigSchema.parse({
      apiKey: 'k',
      apiSecret: 's',
      lockSettingsWhileInDrawdown: 'true',
    });
    expect(cfg.lockSettingsWhileInDrawdown).toBe(true);
  });
});

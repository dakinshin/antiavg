import type { BinanceRestClient } from './rest.js';
import { BinanceApiError } from './rest.js';
import {
  openOrderToRecord,
  positionRiskToSnapshot,
  type RawOpenOrder,
  type RawPositionRisk,
  type RawUserTrade,
} from './mappers.js';
import type { OrderRecord, PositionSide, PositionSnapshot } from '../types.js';
import { toNum, isZero, sameSign } from '../util/num.js';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/logger.js';

export interface AccountSnapshot {
  positions: PositionSnapshot[];
  openOrders: OrderRecord[];
  hedgeMode: boolean;
  atMs: number;
}

export class AccountService {
  constructor(
    private readonly rest: BinanceRestClient,
    private readonly clientOrderIdPrefix: string,
    private readonly log: Logger = noopLogger,
  ) {}

  async isHedgeMode(): Promise<boolean> {
    const res = await this.rest.signedGet<{ dualSidePosition: boolean }>('/fapi/v1/positionSide/dual');
    return Boolean(res.dualSidePosition);
  }

  /** Позиции. Пробуем v3, при отсутствии откатываемся на v2. */
  async fetchPositions(): Promise<PositionSnapshot[]> {
    const at = Date.now();
    let raw: RawPositionRisk[];
    try {
      raw = await this.rest.signedGet<RawPositionRisk[]>('/fapi/v3/positionRisk');
    } catch (e) {
      if (e instanceof BinanceApiError && (e.status === 404 || e.code === -1121 || e.code === -1102)) {
        raw = await this.rest.signedGet<RawPositionRisk[]>('/fapi/v2/positionRisk');
      } else {
        throw e;
      }
    }
    return raw.map((r) => positionRiskToSnapshot(r, at)).filter((p) => !isZero(p.qty));
  }

  /**
   * Депозит счёта — `totalWalletBalance`, без нереализованного PnL.
   *
   * Именно от него считаются лимит плеча и лимит риска. База намеренно не
   * «дышит» вместе с рынком: иначе просадка сама по себе ужимала бы разрешённый
   * объём и провоцировала срезку позиции в худший момент.
   */
  async fetchWalletBalance(): Promise<number> {
    let raw: { totalWalletBalance?: string };
    try {
      raw = await this.rest.signedGet<{ totalWalletBalance?: string }>('/fapi/v3/account');
    } catch (e) {
      if (e instanceof BinanceApiError && (e.status === 404 || e.code === -1121 || e.code === -1102)) {
        raw = await this.rest.signedGet<{ totalWalletBalance?: string }>('/fapi/v2/account');
      } else {
        throw e;
      }
    }
    const balance = toNum(raw.totalWalletBalance);
    if (!Number.isFinite(balance) || balance <= 0) {
      throw new Error(`биржа вернула непригодный баланс: ${String(raw.totalWalletBalance)}`);
    }
    return balance;
  }

  /**
   * Mark price символа. Публичный запрос без подписи.
   *
   * Именно mark price, а не last price: по нему биржа считает нереализованный
   * PnL и по нему же срабатывают стопы с `workingType=MARK_PRICE`.
   */
  async fetchMarkPrice(symbol: string): Promise<number> {
    const raw = await this.rest.publicGet<{ markPrice?: string }>('/fapi/v1/premiumIndex', { symbol });
    const price = toNum(raw.markPrice);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`биржа вернула непригодную mark price для ${symbol}: ${String(raw.markPrice)}`);
    }
    return price;
  }

  async fetchOpenOrders(): Promise<OrderRecord[]> {
    const raw = await this.rest.signedGet<RawOpenOrder[]>('/fapi/v1/openOrders');
    return raw.map((o) => openOrderToRecord(o, this.clientOrderIdPrefix));
  }

  async snapshot(): Promise<AccountSnapshot> {
    const [hedgeMode, positions, openOrders] = await Promise.all([
      this.isHedgeMode(),
      this.fetchPositions(),
      this.fetchOpenOrders(),
    ]);
    return { positions, openOrders, hedgeMode, atMs: Date.now() };
  }

  /**
   * Восстанавливает время открытия позиции по истории сделок.
   *
   * Проигрывает сделки по возрастанию времени, отслеживая знаковый нетто-объём
   * по (symbol, positionSide). Момент последнего перехода 0 -> не-0 и есть время
   * открытия текущей позиции. Если итог реплея не сходится с фактическим
   * объёмом позиции — значит, история неполная, и время считается неизвестным.
   */
  async reconstructOpenTime(
    symbol: string,
    lookbackHours: number,
  ): Promise<Map<PositionSide, { openedAtMs: number; netQty: number }>> {
    const capHours = Math.min(Math.max(lookbackHours, 1), 24 * 7);
    const startTime = Date.now() - capHours * 3600_000;

    const trades: RawUserTrade[] = [];
    let fromId: number | undefined;
    for (let page = 0; page < 20; page++) {
      const params: Record<string, string | number> = { symbol, limit: 1000 };
      if (fromId !== undefined) params.fromId = fromId;
      else params.startTime = startTime;

      const batch = await this.rest.signedGet<RawUserTrade[]>('/fapi/v1/userTrades', params);
      if (batch.length === 0) break;
      trades.push(...batch);
      if (batch.length < 1000) break;
      const last = batch[batch.length - 1];
      if (!last) break;
      fromId = last.id + 1;
    }

    trades.sort((a, b) => (a.time === b.time ? a.id - b.id : a.time - b.time));

    const net = new Map<PositionSide, number>();
    const openedAt = new Map<PositionSide, number>();

    for (const t of trades) {
      const ps: PositionSide = t.positionSide ?? 'BOTH';
      const delta = t.side === 'BUY' ? toNum(t.qty) : -toNum(t.qty);
      const prev = net.get(ps) ?? 0;
      const next = prev + delta;

      if (isZero(prev) && !isZero(next)) {
        openedAt.set(ps, t.time);
      } else if (!isZero(prev) && !isZero(next) && !sameSign(prev, next)) {
        // Переворот внутри одной сделки — позиция считается открытой заново.
        openedAt.set(ps, t.time);
      } else if (isZero(next)) {
        openedAt.delete(ps);
      }
      net.set(ps, next);
    }

    const out = new Map<PositionSide, { openedAtMs: number; netQty: number }>();
    for (const [ps, at] of openedAt) {
      out.set(ps, { openedAtMs: at, netQty: net.get(ps) ?? 0 });
    }
    return out;
  }

  /**
   * Для каждой открытой позиции пытается определить время открытия.
   * Возвращает Map<`symbol|positionSide`, openedAtMs | null>.
   */
  async resolveOpenTimes(
    positions: PositionSnapshot[],
    lookbackHours: number,
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    const symbols = [...new Set(positions.map((p) => p.symbol))];

    for (const symbol of symbols) {
      let reconstructed: Map<PositionSide, { openedAtMs: number; netQty: number }>;
      try {
        reconstructed = await this.reconstructOpenTime(symbol, lookbackHours);
      } catch (e) {
        this.log.warn('не удалось восстановить время открытия позиции', { symbol, error: String(e) });
        for (const p of positions.filter((x) => x.symbol === symbol)) {
          result.set(`${p.symbol}|${p.positionSide}`, null);
        }
        continue;
      }

      for (const p of positions.filter((x) => x.symbol === symbol)) {
        const key = `${p.symbol}|${p.positionSide}`;
        const found = reconstructed.get(p.positionSide);
        // Реплей должен сойтись с фактическим объёмом позиции.
        const matches = found !== undefined && Math.abs(found.netQty - p.qty) <= Math.abs(p.qty) * 1e-6 + 1e-9;
        if (matches && found) {
          result.set(key, found.openedAtMs);
          this.log.info('время открытия позиции восстановлено по сделкам', {
            symbol: p.symbol,
            positionSide: p.positionSide,
            openedAt: new Date(found.openedAtMs).toISOString(),
          });
        } else {
          result.set(key, null);
          this.log.warn('время открытия позиции восстановить не удалось', {
            symbol: p.symbol,
            positionSide: p.positionSide,
            replayQty: found?.netQty,
            actualQty: p.qty,
          });
        }
      }
    }
    return result;
  }
}

import WebSocket from 'ws';
import type { BinanceRestClient } from './rest.js';
import type { Logger } from '../util/logger.js';
import { noopLogger } from '../util/logger.js';
import type { RawUserDataEvent } from './mappers.js';

export interface UserDataStreamOptions {
  rest: BinanceRestClient;
  wsBaseUrl: string;
  keepAliveMs: number;
  logger?: Logger;
  /** Пересоздание WebSocket — подменяется в тестах. */
  wsFactory?: (url: string) => WebSocket;
  /** Максимальная пауза между сообщениями до принудительного реконнекта. */
  stalenessTimeoutMs?: number;
  onEvent(evt: RawUserDataEvent): void;
  /** Вызывается после (пере)подключения — момент для полной сверки состояния. */
  onConnected(attempt: number): void;
  onError?(err: Error): void;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export class UserDataStream {
  private ws: WebSocket | null = null;
  private listenKey: string | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private stalenessTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastMessageAtMs = 0;
  private closed = false;

  private readonly log: Logger;

  constructor(private readonly opts: UserDataStreamOptions) {
    this.log = opts.logger ?? noopLogger;
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
    const interval = Math.max(60_000, this.opts.keepAliveMs);
    this.keepAliveTimer = setInterval(() => {
      void this.opts.rest.keepAliveListenKey().catch((e: unknown) => {
        this.log.error('keepalive listenKey не удался', { error: String(e) });
        // Ключ мог протухнуть — переподключаемся с новым.
        this.scheduleReconnect();
      });
    }, interval);
    if (typeof this.keepAliveTimer.unref === 'function') this.keepAliveTimer.unref();

    const staleness = this.opts.stalenessTimeoutMs ?? 6 * 60_000;
    this.stalenessTimer = setInterval(() => {
      if (this.lastMessageAtMs === 0) return;
      if (Date.now() - this.lastMessageAtMs > staleness) {
        this.log.warn('нет сообщений от Binance слишком долго — переподключение', {
          silentMs: Date.now() - this.lastMessageAtMs,
        });
        this.lastMessageAtMs = Date.now();
        this.scheduleReconnect();
      }
    }, 30_000);
    if (typeof this.stalenessTimer.unref === 'function') this.stalenessTimer.unref();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.listenKey = await this.opts.rest.createListenKey();
    const url = `${this.opts.wsBaseUrl}/ws/${this.listenKey}`;
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u));
    const ws = factory(url);
    this.ws = ws;
    this.lastMessageAtMs = Date.now();

    ws.on('open', () => {
      this.attempt = 0;
      this.log.info('user data stream подключён');
      this.opts.onConnected(this.attempt);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.lastMessageAtMs = Date.now();
      let parsed: RawUserDataEvent;
      try {
        parsed = JSON.parse(data.toString()) as RawUserDataEvent;
      } catch (e) {
        this.log.error('не удалось разобрать сообщение WS', { error: String(e) });
        return;
      }
      try {
        this.opts.onEvent(parsed);
      } catch (e) {
        this.log.error('ошибка в обработчике события', {
          error: e instanceof Error ? e.stack ?? e.message : String(e),
        });
      }
    });

    ws.on('ping', () => {
      this.lastMessageAtMs = Date.now();
      try {
        ws.pong();
      } catch {
        /* ignore */
      }
    });

    ws.on('error', (err: Error) => {
      this.log.error('ошибка WebSocket', { error: err.message });
      this.opts.onError?.(err);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.log.warn('WebSocket закрыт', { code, reason: reason?.toString() ?? '' });
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    try {
      this.ws?.removeAllListeners();
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.ws = null;

    this.attempt += 1;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(this.attempt, 5));
    const jitter = Math.floor(delay * 0.25 * Math.random());
    this.log.info('переподключение к user data stream', { attempt: this.attempt, delayMs: delay + jitter });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((e: unknown) => {
        this.log.error('переподключение не удалось', { error: String(e) });
        this.scheduleReconnect();
      });
    }, delay + jitter);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.stalenessTimer) clearInterval(this.stalenessTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.keepAliveTimer = null;
    this.stalenessTimer = null;
    this.reconnectTimer = null;
    try {
      this.ws?.removeAllListeners();
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    if (this.listenKey) {
      await this.opts.rest.closeListenKey().catch(() => undefined);
      this.listenKey = null;
    }
  }
}

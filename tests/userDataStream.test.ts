import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { UserDataStream } from '../src/binance/userDataStream.js';
import type { BinanceRestClient } from '../src/binance/rest.js';

class FakeSocket extends EventEmitter {
  terminated = false;
  closed = false;
  readyState = 1;
  terminate(): void {
    this.terminated = true;
  }
  close(): void {
    this.closed = true;
  }
  pong(): void {}
}

function fakeRest() {
  const calls = { create: 0, keepAlive: 0, close: 0 };
  const rest = {
    createListenKey: async () => {
      calls.create++;
      return `KEY${calls.create}`;
    },
    keepAliveListenKey: async () => {
      calls.keepAlive++;
    },
    closeListenKey: async () => {
      calls.close++;
    },
  } as unknown as BinanceRestClient;
  return { rest, calls };
}

function makeStream(over: Partial<Parameters<typeof UserDataStream.prototype.constructor>[0]> = {}) {
  const { rest, calls } = fakeRest();
  const sockets: FakeSocket[] = [];
  const events: unknown[] = [];
  const connects: number[] = [];

  const stream = new UserDataStream({
    rest,
    wsBaseUrl: 'wss://example.invalid',
    keepAliveMs: 60_000,
    wsFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    onEvent: (e) => events.push(e),
    onConnected: (a) => connects.push(a),
    ...over,
  });

  return { stream, calls, sockets, events, connects };
}

describe('жизненный цикл listenKey', () => {
  it('при остановке listenKey НЕ удаляется', async () => {
    // DELETE инвалидирует ключ для всего аккаунта: перезапуск сервиса убил бы
    // поток только что стартовавшему экземпляру.
    const h = makeStream();
    await h.stream.start();
    h.sockets[0]?.emit('open');
    await h.stream.stop();

    expect(h.calls.close).toBe(0);
    expect(h.calls.create).toBe(1);
    expect(h.sockets[0]?.closed).toBe(true);
  });

  it('каждое переподключение берёт свежий listenKey', async () => {
    vi.useFakeTimers();
    try {
      const h = makeStream();
      await h.stream.start();
      h.sockets[0]?.emit('open');

      h.stream.forceReconnect('тест');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(h.calls.create).toBe(2);
      expect(h.sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('обнаружение мёртвого потока', () => {
  it('сокет открыт, но кадров нет — принудительное переподключение', async () => {
    vi.useFakeTimers();
    try {
      const h = makeStream({ stalenessTimeoutMs: 60_000 });
      await h.stream.start();
      h.sockets[0]?.emit('open');

      // Полная тишина: ни сообщений, ни ping.
      await vi.advanceTimersByTimeAsync(75_000);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(h.calls.create).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ping от биржи считается признаком живого потока', async () => {
    vi.useFakeTimers();
    try {
      const h = makeStream({ stalenessTimeoutMs: 60_000 });
      await h.stream.start();
      const sock = h.sockets[0];
      sock?.emit('open');

      // Каждые 30 с приходит ping — переподключаться не должны.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        sock?.emit('ping');
      }

      expect(h.calls.create).toBe(1);
      expect(h.stream.stats().pings).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('счётчики отражают принятые сообщения', async () => {
    const h = makeStream();
    await h.stream.start();
    const sock = h.sockets[0];
    sock?.emit('open');
    sock?.emit('message', Buffer.from(JSON.stringify({ e: 'ORDER_TRADE_UPDATE' })));
    sock?.emit('message', Buffer.from(JSON.stringify({ e: 'ACCOUNT_UPDATE' })));

    expect(h.stream.stats().messages).toBe(2);
    expect(h.events).toHaveLength(2);
    await h.stream.stop();
  });

  it('битый JSON не роняет обработчик', async () => {
    const h = makeStream();
    await h.stream.start();
    const sock = h.sockets[0];
    sock?.emit('open');
    expect(() => sock?.emit('message', Buffer.from('не json'))).not.toThrow();
    expect(h.events).toHaveLength(0);
    await h.stream.stop();
  });

  it('закрытие сокета приводит к переподключению', async () => {
    vi.useFakeTimers();
    try {
      const h = makeStream();
      await h.stream.start();
      h.sockets[0]?.emit('open');
      h.sockets[0]?.emit('close', 1006, Buffer.from(''));

      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.calls.create).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('после stop() переподключений больше не происходит', async () => {
    vi.useFakeTimers();
    try {
      const h = makeStream();
      await h.stream.start();
      h.sockets[0]?.emit('open');
      await h.stream.stop();

      h.stream.forceReconnect('после остановки');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.calls.create).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

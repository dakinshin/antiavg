/**
 * Проба WebSocket-эндпоинта.
 *
 * Вынесена отдельно от doctor.ts, чтобы её можно было использовать и в тестах,
 * не запуская всю диагностику.
 */
import WebSocket from 'ws';

export interface ProbeResult {
  opened: boolean;
  messages: number;
  waitedMs: number;
  closeCode?: number;
  closeReason?: string;
  httpStatus?: number;
  error?: string;
}

/**
 * Пробует WebSocket и возвращает ПОЛНУЮ картину, а не только «пришли кадры или нет».
 *
 * Важно различать три исхода, которые внешне выглядят одинаково:
 *   - соединение не открылось          -> блокировка на уровне TCP/TLS;
 *   - открылось и сразу закрылось      -> биржа отвергла поток (код закрытия скажет почему);
 *   - открылось и молчит               -> кадры режутся по дороге.
 * Промис никогда не реджектится: любой исход — это данные для диагноза.
 */
export function probeWs(
  url: string,
  timeoutMs: number,
  needMessages: number,
  agent?: import('node:http').Agent,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const state: ProbeResult = { opened: false, messages: 0, waitedMs: 0 };
    let settled = false;
    const ws = agent ? new WebSocket(url, { agent }) : new WebSocket(url);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.waitedMs = Date.now() - started;
      // Слушатель ошибок оставляем: ws может доэмитить 'error' уже после
      // terminate(), и без обработчика это превратится в unhandled error.
      for (const evt of ['open', 'message', 'close', 'unexpected-response', 'ping']) {
        ws.removeAllListeners(evt);
      }
      ws.removeAllListeners('error');
      ws.on('error', () => {});
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      resolve(state);
    };

    const timer = setTimeout(finish, timeoutMs);

    ws.once('open', () => {
      state.opened = true;
      if (needMessages === 0) finish();
    });
    ws.on('message', () => {
      state.messages++;
      if (needMessages > 0 && state.messages >= needMessages) finish();
    });
    ws.once('close', (code: number, reason: Buffer) => {
      state.closeCode = code;
      state.closeReason = reason?.toString() || '';
      finish();
    });
    // Сервер ответил обычным HTTP вместо upgrade — например, 451 или 403.
    ws.once('unexpected-response', (_req, res: { statusCode?: number; statusMessage?: string }) => {
      state.httpStatus = res.statusCode;
      state.error = `HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim();
      finish();
    });
    ws.once('error', (err: Error) => {
      state.error = err.message;
      finish();
    });
  });
}

/** Человекочитаемый итог пробы. */
export function describeProbe(r: ProbeResult): { ok: boolean; text: string } {
  if (r.messages > 0) return { ok: true, text: `${r.messages} кадр(ов) за ${r.waitedMs} мс` };
  if (r.error) return { ok: false, text: `ошибка: ${r.error}` };
  if (!r.opened) return { ok: false, text: `не открылось за ${r.waitedMs} мс (нет ответа)` };
  if (r.closeCode !== undefined) {
    return {
      ok: false,
      text: `открылось и закрылось через ${r.waitedMs} мс, код ${r.closeCode}${r.closeReason ? ` (${r.closeReason})` : ''}`,
    };
  }
  return { ok: false, text: `открылось, но за ${r.waitedMs} мс НИ ОДНОГО кадра` };
}

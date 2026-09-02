/**
 * Файл лога.
 *
 * В упакованном приложении `process.stdout` не ведёт никуда: консоли нет, и всё,
 * что сервис писал на уровне info, исчезало бесследно. В окне видны только
 * предупреждения и ошибки — этого хватает, чтобы заметить проблему, и не хватает,
 * чтобы понять её причину. Поэтому весь поток пишется ещё и в файл, который
 * человек может открыть и прислать.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Сколько дневных файлов хранить. Больше — беспричинно занятое место. */
const KEEP_DAYS = 7;

let stream: fs.WriteStream | null = null;
let streamDay = '';

export function logDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function rotate(): void {
  try {
    const dir = logDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('antiavg-') && f.endsWith('.log'))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_DAYS))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    /* уборка старых логов не должна мешать работе */
  }
}

function ensureStream(): fs.WriteStream | null {
  const day = dayStamp();
  if (stream && streamDay === day) return stream;
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    stream?.end();
    stream = fs.createWriteStream(path.join(dir, `antiavg-${day}.log`), { flags: 'a' });
    streamDay = day;
    rotate();
    return stream;
  } catch {
    // Нет прав на запись — работаем без файла, но не падаем из-за этого.
    stream = null;
    return null;
  }
}

export function writeLog(line: string): void {
  ensureStream()?.write(line + '\n');
}

export function closeLog(): void {
  stream?.end();
  stream = null;
  streamDay = '';
}

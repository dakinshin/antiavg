export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  json: boolean;
  /** Инъекция часов — удобно в тестах. */
  now?: () => number;
  sink?: (line: string) => void;
}

function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/secret|apikey|api_key|signature|listenkey|token|password/i.test(k)) {
      out[k] = '***';
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createLogger(opts: LoggerOptions, bindings: Record<string, unknown> = {}): Logger {
  const now = opts.now ?? (() => Date.now());
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const min = LEVELS[opts.level];

  function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < min) return;
    const merged = redact({ ...bindings, ...(meta ?? {}) });
    const ts = new Date(now()).toISOString();
    if (opts.json) {
      sink(JSON.stringify({ ts, level, msg, ...merged }));
    } else {
      const tail = Object.keys(merged).length ? ' ' + JSON.stringify(merged) : '';
      sink(`${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`);
    }
  }

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (extra) => createLogger(opts, { ...bindings, ...extra }),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

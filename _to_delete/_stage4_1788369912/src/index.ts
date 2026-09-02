import 'dotenv/config';
import { loadConfigFromEnv } from './config.js';
import { createLogger } from './util/logger.js';
import { App } from './app.js';
import { BinanceApiError } from './binance/rest.js';
import { isTransientNetworkError } from './binance/http.js';

function isRetryableStartupError(e: unknown): boolean {
  if (e instanceof BinanceApiError) {
    // Ошибки ключа/подписи/прав повторять бессмысленно.
    if (e.status === 401 || e.status === 403 || e.status === 418 || e.status === 451) return false;
    if (e.code !== undefined && e.code <= -2014 && e.code >= -2015) return false;
    return e.transient;
  }
  return isTransientNetworkError(e);
}

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfigFromEnv();
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
    return;
  }

  const logger = createLogger({ level: cfg.logLevel, json: cfg.logJson });

  let app: App | null = null;
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('получен сигнал завершения', { signal });
    void Promise.resolve(app?.stop())
      .catch((e: unknown) => logger.error('ошибка при остановке', { error: String(e) }))
      .finally(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('необработанное отклонение промиса', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('необработанное исключение', { error: err.stack ?? err.message });
    shutdown('uncaughtException');
  });

  for (let attempt = 1; !shuttingDown; attempt++) {
    app = new App({ cfg, logger });
    try {
      await app.start();
      return;
    } catch (e) {
      await Promise.resolve(app.stop()).catch(() => undefined);
      app = null;

      const retryable = isRetryableStartupError(e) && cfg.startupRetryMs > 0;
      logger.error('не удалось запустить сервис', {
        attempt,
        retryable,
        error: e instanceof Error ? e.message : String(e),
      });
      if (!retryable) {
        if (e instanceof Error && e.stack) logger.debug('стек ошибки запуска', { stack: e.stack });
        process.exit(1);
        return;
      }

      const delay = Math.min(120_000, cfg.startupRetryMs * Math.min(attempt, 8));
      logger.warn('повторная попытка запуска', { delayMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

void main();

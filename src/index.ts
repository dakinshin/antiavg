import 'dotenv/config';
import { loadConfigFromEnv } from './config.js';
import { createLogger } from './util/logger.js';
import { App } from './app.js';

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
  const app = new App({ cfg, logger });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('получен сигнал завершения', { signal });
    void app
      .stop()
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

  try {
    await app.start();
  } catch (e) {
    logger.error('не удалось запустить сервис', {
      error: e instanceof Error ? e.stack ?? e.message : String(e),
    });
    process.exit(1);
  }
}

void main();

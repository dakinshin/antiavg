/**
 * Обёртка над ядром: запуск, остановка, сбор событий для окна.
 *
 * Ядро не переписывается и не дублируется — используется тот же `App`, что и в
 * консольной версии. Отсюда берутся только его хуки и снимок состояния.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Settings } from './settings.js';
import type { GuardState } from './trayIcon.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/* Типы ядра импортируются лениво, поэтому здесь они структурные. */
type CoreConfig = Record<string, unknown>;
interface CoreApp {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): CoreSnapshot;
}
export interface CoreSnapshot {
  running: boolean;
  hedgeMode: boolean;
  engine: Record<string, unknown> | null;
  ws: { messages: number; pings: number; connectedAtMs: number; lastMessageAtMs: number } | null;
  positions: Array<{
    symbol: string;
    positionSide: string;
    qty: number;
    entryPrice: number;
    openedAtMs: number | null;
    openTimeKnown: boolean;
  }>;
  eventCounts: Record<string, number>;
}

interface Core {
  App: new (deps: Record<string, unknown>) => CoreApp;
  ConfigSchema: { parse(v: unknown): CoreConfig };
  createLogger: (o: Record<string, unknown>) => unknown;
  SKIP_REASON_TEXT: Record<string, string>;
}

/**
 * В собранном приложении ядро лежит в `core/`, в разработке — в `../dist`.
 * Пробуем оба, не гадая по флагам окружения.
 */
async function loadCore(): Promise<Core> {
  const candidates = [
    path.join(here, '..', 'core'),
    path.join(here, '..', '..', 'dist'),
  ];
  let lastError: unknown;
  for (const base of candidates) {
    try {
      // pathToFileURL, а не строка «file://» + путь: на Windows путь вида
      // C:\\… в конкатенации даёт нерабочий URL.
      const url = (...p: string[]) => pathToFileURL(path.join(base, ...p)).href;
      const [app, config, logger, detector] = await Promise.all([
        import(url('app.js')),
        import(url('config.js')),
        import(url('util', 'logger.js')),
        import(url('core', 'detector.js')),
      ]);
      return {
        App: app.App,
        ConfigSchema: config.ConfigSchema,
        createLogger: logger.createLogger,
        SKIP_REASON_TEXT: detector.SKIP_REASON_TEXT,
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `Не удалось загрузить ядро. Соберите его: npm run build в корне проекта. ` +
      `Подробности: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export type EventKind = 'detection' | 'action' | 'skip' | 'info' | 'warn' | 'error';

export interface GuardEvent {
  id: number;
  atMs: number;
  kind: EventKind;
  symbol?: string;
  text: string;
  amount?: number;
}

export interface GuardStatus {
  state: GuardState;
  title: string;
  running: boolean;
  dryRun: boolean;
  startedAtMs: number | null;
  lastError: string | null;
  snapshot: CoreSnapshot | null;
}

const MAX_EVENTS = 400;

export class Guard {
  private core: Core | null = null;
  private app: CoreApp | null = null;
  private events: GuardEvent[] = [];
  private seq = 0;
  private startedAtMs: number | null = null;
  private lastError: string | null = null;
  private starting = false;
  private alarmUntilMs = 0;
  private dryRun = true;

  constructor(
    private readonly onChange: () => void,
    private readonly onEvent: (e: GuardEvent) => void,
    private readonly onDetection: (e: GuardEvent) => void,
  ) {}

  private push(kind: EventKind, text: string, extra: Partial<GuardEvent> = {}): GuardEvent {
    const e: GuardEvent = { id: ++this.seq, atMs: Date.now(), kind, text, ...extra };
    this.events.unshift(e);
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
    this.onEvent(e);
    return e;
  }

  recentEvents(): GuardEvent[] {
    return this.events;
  }

  isRunning(): boolean {
    return this.app !== null;
  }

  status(): GuardStatus {
    let state: GuardState = 'stopped';
    if (this.starting) state = 'connecting';
    else if (this.app) {
      if (Date.now() < this.alarmUntilMs) state = 'alarm';
      else if (this.lastError) state = 'error';
      else state = this.dryRun ? 'dry' : 'live';
    } else if (this.lastError) state = 'error';

    return {
      state,
      title: '',
      running: this.app !== null,
      dryRun: this.dryRun,
      startedAtMs: this.startedAtMs,
      lastError: this.lastError,
      snapshot: this.app ? this.app.snapshot() : null,
    };
  }

  private buildConfig(core: Core, s: Settings): CoreConfig {
    return core.ConfigSchema.parse({
      apiKey: s.apiKey,
      apiSecret: s.apiSecret,
      testnet: s.testnet,
      dryRun: s.dryRun,
      reactionMode: s.reactionMode,
      lossThresholdPct: s.lossThresholdPct,
      countPreexistingOrders: s.countPreexistingOrders,
      unknownOpenTimePolicy: s.unknownOpenTimePolicy,
      symbols: s.symbols,
      maxActionsPerHour: s.maxActionsPerHour,
      onQtyBelowMin: s.onQtyBelowMin,
      wsProxyUrl: s.wsProxy || undefined,
      restProxyUrl: s.restProxy || undefined,
      logLevel: 'info',
    });
  }

  async start(settings: Settings): Promise<{ ok: boolean; error?: string }> {
    if (this.app || this.starting) return { ok: true };
    if (!settings.apiKey || !settings.apiSecret) {
      return { ok: false, error: 'Не заданы ключи API. Откройте настройки.' };
    }

    this.starting = true;
    this.lastError = null;
    this.dryRun = settings.dryRun;
    this.onChange();

    try {
      this.core ??= await loadCore();
      const core = this.core;
      const cfg = this.buildConfig(core, settings);

      // Логи ядра попадают в ленту событий окна: sink вместо вывода в консоль.
      const logger = core.createLogger({
        level: 'info',
        json: false,
        sink: (line: string) => {
          process.stdout.write(line + '\n');
          const level = /\sWARN\s/.test(line) ? 'warn' : /\sERROR\s/.test(line) ? 'error' : null;
          // В ленту тянем только заметное: остальное уже приходит через хуки.
          if (level && !line.includes('исполнение:')) {
            const msg = line.replace(/^\S+\s+\w+\s+/, '').split(' {')[0] ?? line;
            this.push(level, msg);
          }
        },
      });

      const app = new core.App({
        cfg,
        logger,
        hooks: {
          onDetection: (d: any) => {
            this.alarmUntilMs = Date.now() + 60_000;
            const e = this.push('detection', `усреднение в убытке, долив ${d.addedQty} по ${d.fillPrice}`, {
              symbol: d.fill?.symbol,
              amount: d.addedQty,
            });
            this.onDetection(e);
            this.onChange();
          },
          onAction: (a: any, outcome: any) => {
            const qty = outcome?.sentQty ?? a.requestedQty;
            const text = outcome?.executed
              ? `защитный ордер отправлен: ${a.side} ${qty} по рынку`
              : `защитное действие не выполнено (${outcome?.skipped ?? outcome?.error ?? 'причина неизвестна'})`;
            this.push('action', text, { symbol: a.symbol, amount: -qty });
            this.onChange();
          },
          onSkip: (d: any) => {
            const reason = d.reason ? (core.SKIP_REASON_TEXT[d.reason] ?? d.reason) : '';
            this.push('skip', reason, {
              symbol: d.fill?.symbol,
              amount: d.fill?.side === 'BUY' ? d.fill?.lastFilledQty : -(d.fill?.lastFilledQty ?? 0),
            });
          },
        },
        onStreamState: (st: { connected: boolean; reason: string }) => {
          if (!st.connected) this.lastError = st.reason;
          else this.lastError = null;
          this.onChange();
        },
      });

      await app.start();
      this.app = app;
      this.startedAtMs = Date.now();
      this.starting = false;
      this.push('info', settings.dryRun ? 'защита запущена в режиме наблюдения' : 'защита запущена в боевом режиме');
      this.onChange();
      return { ok: true };
    } catch (e) {
      this.starting = false;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.push('error', `не удалось запустить защиту: ${this.lastError}`);
      this.onChange();
      return { ok: false, error: this.lastError };
    }
  }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = null;
    this.startedAtMs = null;
    if (app) {
      await app.stop().catch(() => undefined);
      this.push('warn', 'защита остановлена пользователем');
    }
    this.onChange();
  }
}

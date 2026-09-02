/**
 * Главный процесс: окно, трей, жизненный цикл, IPC.
 *
 * Ключевое поведение по требованию: крестик СВОРАЧИВАЕТ окно в трей, а не
 * выключает защиту. Остановка — только явным действием с подтверждением.
 */
import { app, BrowserWindow, Menu, Tray, ipcMain, dialog, shell, Notification } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Guard, type GuardEvent } from './guard.js';
import { loadSettings, saveSettings, redact, encryptionAvailable, DEFAULT_SETTINGS, type Settings } from './settings.js';
import { stateTitle, trayIcon } from './trayIcon.js';
import { closeLog, logDir } from './logFile.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** true только после подтверждённого выхода — иначе окно просто прячется. */
let allowQuit = false;
let settings: Settings = { ...DEFAULT_SETTINGS };
/**
 * Запуск вместе с системой не должен разворачивать окно на весь экран.
 * На Windows опция openAsHidden игнорируется (она только для macOS), поэтому
 * автозапуск помечается собственным аргументом.
 */
const startHidden = process.argv.includes('--hidden');

// Один экземпляр: два процесса на одном счёте отработали бы один долив дважды.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const guard = new Guard(
  () => pushState(),
  (e) => win?.webContents.send('guard:event', e),
  (e) => notifyDetection(e),
  (title, body) => notify(title, body),
);

function pushState(): void {
  const status = guard.status();
  win?.webContents.send('guard:state', status);
  if (tray) {
    tray.setImage(trayIcon(status.state));
    const title = stateTitle(status.state);
    tray.setToolTip(`AntiAvg — ${title}`);
    tray.setContextMenu(buildTrayMenu());
  }
}

function notify(title: string, body: string, urgency: 'normal' | 'critical' = 'normal'): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, urgency })
    .on('click', () => showWindow())
    .show();
}

function notifyDetection(e: GuardEvent): void {
  notify(`AntiAvg: ${e.symbol ?? 'позиция'}`, `Усреднение в убытке — ${e.text}`, 'critical');
}

function buildTrayMenu(): Menu {
  const running = guard.isRunning();
  return Menu.buildFromTemplate([
    { label: stateTitle(guard.status().state), enabled: false },
    { type: 'separator' },
    { label: 'Показать окно', click: () => showWindow() },
    running
      ? { label: 'Остановить защиту…', click: () => void requestStop('трей') }
      : { label: 'Запустить защиту', click: () => void guard.start(settings) },
    { type: 'separator' },
    { label: 'Выход…', click: () => void requestQuit() },
  ]);
}

/** Денежная сумма для диалога: без хвоста из плавающей точки. */
function money(v: number): string {
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Остановка защиты — всегда через подтверждение.
 *
 * Если включён замок и хотя бы одна позиция в просадке, остановка не
 * предлагается вовсе: смысл настройки в том, чтобы решение «выключу защиту и
 * усреднюсь» нельзя было принять в тот момент, когда оно кажется
 * привлекательным. Замок снимается сам, когда убыточных позиций не остаётся.
 */
async function requestStop(source: string): Promise<boolean> {
  if (!guard.isRunning()) return true;
  showWindow();

  const lock = await guard.checkDrawdownLock(settings);
  if (lock.locked && lock.status) {
    const lines = lock.status.positions
      .slice(0, 12)
      .map(
        (p) =>
          `• ${p.symbol} ${p.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.qty)} ` +
          `по ${p.entryPrice} — ${money(p.unrealizedPnl)} USDT`,
      );
    const more = lock.status.positions.length - lines.length;
    if (more > 0) lines.push(`• …и ещё ${more}`);

    await dialog.showMessageBox(win ?? undefined!, {
      type: 'info',
      buttons: ['Понятно'],
      defaultId: 0,
      title: 'Защиту сейчас выключить нельзя',
      message: `Есть позиции в просадке на ${money(lock.status.totalLoss)} USDT.`,
      detail:
        `${lines.join('\n')}\n\n` +
        'Включена настройка «Не выключать защиту при просадке». Выключить её можно, ' +
        'когда убыточных позиций не останется — то есть после закрытия позиции или ' +
        'её возврата в плюс.\n\n' +
        `Запрос из: ${source}.`,
    });
    return false;
  }

  const { response } = await dialog.showMessageBox(win ?? undefined!, {
    type: 'warning',
    buttons: ['Отмена', 'Остановить защиту'],
    defaultId: 0,
    cancelId: 0,
    title: 'Остановить защиту?',
    message: 'Защита от усреднения будет выключена.',
    detail:
      'Пока она выключена, доливы в убыточные позиции не отслеживаются и срезаться не будут. ' +
      `Запрос из: ${source}.`,
  });
  if (response !== 1) return false;
  await guard.stop();
  return true;
}

async function requestQuit(): Promise<void> {
  if (guard.isRunning()) {
    const stopped = await requestStop('выход из приложения');
    if (!stopped) return;
  }
  allowQuit = true;
  app.quit();
}

function showWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d0d',
    title: 'AntiAvg',
    icon: path.join(here, '..', 'build-resources', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  void win.loadFile(path.join(here, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    // При автозапуске окно не показываем — приложение живёт в трее.
    if (!startHidden) win?.show();
    pushState();
  });

  // Крестик прячет окно. Защита продолжает работать.
  win.on('close', (e) => {
    if (allowQuit) return;
    e.preventDefault();
    win?.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });

  win.on('closed', () => {
    win = null;
  });

  // Внешние ссылки — в системный браузер, а не внутрь приложения.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray(): void {
  tray = new Tray(trayIcon('stopped'));
  tray.setToolTip('AntiAvg');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

/* ---------------- IPC ---------------- */

ipcMain.handle('guard:getState', () => guard.status());
ipcMain.handle('guard:getEvents', () => guard.recentEvents());
ipcMain.handle('guard:start', async () => guard.start(settings));
ipcMain.handle('guard:stop', async () => ({ stopped: await requestStop('окно') }));

ipcMain.handle('settings:get', () => ({
  values: redact(settings),
  encryptionAvailable: encryptionAvailable(),
}));

/**
 * Настройки, которыми замок можно было бы обойти, не нажимая «Остановить».
 * Снять галочку замка, уйти в режим наблюдения или отключить снятие опасных
 * ордеров — всё это ровно то же самое действие, только другим путём.
 */
/**
 * Какие поля реально изменились. Окно присылает всю форму целиком, поэтому
 * «сохранить, ничего не трогая» — нормальная ситуация, и запирать её незачем.
 */
function changedKeys(before: Settings, after: Settings): Array<keyof Settings> {
  return (Object.keys(after) as Array<keyof Settings>).filter((k) => before[k] !== after[k]);
}

interface WeakeningRule {
  key: keyof Settings;
  label: string;
  /** Ослабляет ли переход `before -> after` защиту. */
  weaker(before: Settings, after: Settings): boolean;
}

/** Галка со «слабым» значением: сняли — ослабили (или наоборот для dryRun). */
function flag(key: keyof Settings, weakValue: boolean, label: string): WeakeningRule {
  return { key, label, weaker: (b, a) => b[key] !== weakValue && a[key] === weakValue };
}

/** Шкала строгости режима FOMO: выключить или снять блокировку — ослабление. */
const FOMO_RANK: Record<string, number> = { off: 0, notify: 1, block: 2 };

const WEAKENING: WeakeningRule[] = [
  flag('lockStopWhileInDrawdown', false, 'Не выключать защиту при просадке'),
  flag('dryRun', true, 'Режим наблюдения (без реальных ордеров)'),
  flag('cancelDangerousOrders', false, 'Снимать опасные ордера'),
  flag('maxPositionEnabled', false, 'Ограничивать объём позиции'),
  flag('defaultStopEnabled', false, 'Дефолтный стоп'),
  flag('protectStopOrders', false, 'Не разрешать снимать стоп'),
  flag('maxRiskEnabled', false, 'Жёстко ограничивать риск'),
  {
    key: 'fomoMode',
    label: 'Защита от FOMO',
    weaker: (b, a) => (FOMO_RANK[a.fomoMode] ?? 0) < (FOMO_RANK[b.fomoMode] ?? 0),
  },
  // Числа защиты от FOMO тоже можно «выключить», не трогая переключатель:
  // потребовать больше стопов, сузить окно, укоротить блокировку. Замок это
  // закрывает — иначе он значил бы только то, что галка осталась на месте.
  {
    key: 'fomoCount',
    label: 'Сколько стоп-аутов подряд включают защиту от FOMO',
    weaker: (b, a) => a.fomoCount > b.fomoCount,
  },
  { key: 'fomoWindowSec', label: 'Окно защиты от FOMO', weaker: (b, a) => a.fomoWindowSec < b.fomoWindowSec },
  {
    key: 'fomoTradeSec',
    label: 'Длительность сделки для защиты от FOMO',
    weaker: (b, a) => a.fomoTradeSec < b.fomoTradeSec,
  },
  {
    key: 'fomoBlockMin',
    label: 'Длительность блокировки после FOMO',
    weaker: (b, a) => a.fomoBlockMin < b.fomoBlockMin,
  },
];

ipcMain.handle('settings:save', async (_e, incoming: Partial<Settings>) => {
  const before = settings;
  // Замаскированные значения из окна не затирают реальные ключи.
  const next: Settings = {
    ...settings,
    ...incoming,
    apiKey: incoming.apiKey && !incoming.apiKey.startsWith('••') ? incoming.apiKey : settings.apiKey,
    apiSecret:
      incoming.apiSecret && !incoming.apiSecret.startsWith('••') ? incoming.apiSecret : settings.apiSecret,
  };

  // Строгий замок: при просадке настройки не меняются вообще. Проверяем раньше
  // мягкого — если он заперт, разбирать отдельные поля уже незачем.
  if (changedKeys(settings, next).length > 0) {
    const strict = await guard.checkDrawdownLock(settings, 'settings');
    if (strict.locked && strict.status) {
      await dialog.showMessageBox(win ?? undefined!, {
        type: 'info',
        buttons: ['Понятно'],
        title: 'Настройки сейчас изменить нельзя',
        message: `Есть позиции в просадке на ${money(strict.status.totalLoss)} USDT.`,
        detail:
          'Включена настройка «Не менять настройки при просадке» — пока есть убыточные ' +
          'позиции, не сохраняется ничего, включая саму эту галку.\n\n' +
          'Замок откроется, когда позиция будет закрыта или вернётся в плюс.',
      });
      return { ok: true, needsRestart: false, values: redact(settings) };
    }
  }

  // Замок закрывает и обходные пути, иначе он не значил бы ничего.
  const weakened = WEAKENING.filter((w) => w.weaker(settings, next));
  if (weakened.length > 0) {
    const lock = await guard.checkDrawdownLock(settings);
    if (lock.locked && lock.status) {
      for (const w of weakened) {
        // Ключ приходит из WEAKENING, то есть заведомо принадлежит Settings;
        // общего способа записать «поле по имени» в типизированный объект нет.
        (next as unknown as Record<string, unknown>)[w.key] = settings[w.key];
      }
      await dialog.showMessageBox(win ?? undefined!, {
        type: 'info',
        buttons: ['Понятно'],
        title: 'Настройка не изменена',
        message: `Есть позиции в просадке на ${money(lock.status.totalLoss)} USDT.`,
        detail:
          `Пока это так, нельзя ослабить защиту:\n${weakened.map((w) => `• ${w.label}`).join('\n')}\n\n` +
          'Остальные изменения сохранены. Вернитесь к этим настройкам, когда убыточных ' +
          'позиций не останется.',
      });
    }
  }

  const res = saveSettings(next);
  settings = next;

  app.setLoginItemSettings({
    openAtLogin: next.launchOnLogin,
    // openAsHidden работает только на macOS; на Windows роль играет аргумент.
    openAsHidden: true,
    args: ['--hidden'],
  });

  // Настройки применяются только при старте ядра, поэтому сохранение при
  // работающей защите означает перезапуск. Спрашивать об этом незачем: человек
  // ввёл новые значения и нажал «Сохранить» — намерение выражено. Открытые
  // позиции при перезапуске остаются под правилами риска.
  let restarted = false;
  if (guard.isRunning() && changedKeys(before, next).length > 0) {
    restarted = true;
    await guard.restart(next);
  }

  // values возвращаем всегда: если замок откатил часть полей, окно должно
  // показать то, что реально сохранено, а не то, что человек нажал.
  return { ...res, needsRestart: guard.isRunning() && !restarted, restarted, values: redact(next) };
});

ipcMain.handle('app:openLogFolder', () => {
  void shell.openPath(logDir());
});

/* ---------------- Запуск ---------------- */

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  settings = loadSettings();
  createTray();
  createWindow();

  if (settings.autoStartGuard && settings.apiKey && settings.apiSecret) {
    // С повторами: при старте вместе с системой сеть может быть ещё не готова.
    void guard.startWithRetry(settings);
  }

  app.on('activate', () => showWindow());
});

// Подписка сама по себе отменяет стандартный выход при закрытии всех окон:
// приложение продолжает жить в трее.
app.on('window-all-closed', () => {
  /* намеренно пусто */
});

// Завершение сеанса Windows/macOS (выключение, перезагрузка, выход из системы)
// задерживать нельзя: система ждать диалог не станет, а замок — самоограничение,
// а не право блокировать выключение компьютера.
// (событие только для Windows, в типах Electron его нет — отсюда приведение)
(app as unknown as NodeJS.EventEmitter).on('session-end', () => {
  allowQuit = true;
});

app.on('quit', () => closeLog());

app.on('before-quit', (e) => {
  if (allowQuit) return;
  e.preventDefault();
  void requestQuit();
});

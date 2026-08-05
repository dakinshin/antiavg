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

const here = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** true только после подтверждённого выхода — иначе окно просто прячется. */
let allowQuit = false;
let settings: Settings = { ...DEFAULT_SETTINGS };

// Один экземпляр: два процесса на одном счёте отработали бы один долив дважды.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const guard = new Guard(
  () => pushState(),
  (e) => win?.webContents.send('guard:event', e),
  (e) => notifyDetection(e),
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

function notifyDetection(e: GuardEvent): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: `AntiAvg: ${e.symbol ?? 'позиция'}`,
    body: `Усреднение в убытке — ${e.text}`,
    urgency: 'critical',
  })
    .on('click', () => showWindow())
    .show();
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

/** Остановка защиты — всегда через подтверждение. */
async function requestStop(source: string): Promise<boolean> {
  if (!guard.isRunning()) return true;
  showWindow();
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
    win?.show();
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

ipcMain.handle('settings:save', async (_e, incoming: Partial<Settings>) => {
  // Замаскированные значения из окна не затирают реальные ключи.
  const next: Settings = {
    ...settings,
    ...incoming,
    apiKey: incoming.apiKey && !incoming.apiKey.startsWith('••') ? incoming.apiKey : settings.apiKey,
    apiSecret:
      incoming.apiSecret && !incoming.apiSecret.startsWith('••') ? incoming.apiSecret : settings.apiSecret,
  };

  const res = saveSettings(next);
  settings = next;

  app.setLoginItemSettings({ openAtLogin: next.launchOnLogin, openAsHidden: true });

  const needsRestart = guard.isRunning();
  return { ...res, needsRestart };
});

ipcMain.handle('app:openLogFolder', () => {
  void shell.openPath(app.getPath('userData'));
});

/* ---------------- Запуск ---------------- */

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  settings = loadSettings();
  createTray();
  createWindow();

  if (settings.autoStartGuard && settings.apiKey && settings.apiSecret) {
    void guard.start(settings);
  }

  app.on('activate', () => showWindow());
});

// Подписка сама по себе отменяет стандартный выход при закрытии всех окон:
// приложение продолжает жить в трее.
app.on('window-all-closed', () => {
  /* намеренно пусто */
});

app.on('before-quit', (e) => {
  if (allowQuit) return;
  e.preventDefault();
  void requestQuit();
});

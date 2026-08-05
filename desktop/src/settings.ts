/**
 * Настройки приложения.
 *
 * Ключи API НЕ лежат в открытом виде: они шифруются `safeStorage`, который на
 * Windows использует DPAPI (привязка к учётной записи Windows), на macOS —
 * Keychain. Если шифрование в системе недоступно, секреты не сохраняются вовсе:
 * лучше спросить их заново, чем оставить на диске открытым текстом.
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface Settings {
  /** Расшифрованные ключи. Пусто — значит ещё не заданы. */
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
  dryRun: boolean;
  reactionMode: 'reduce' | 'close';
  lossThresholdPct: number;
  countPreexistingOrders: boolean;
  unknownOpenTimePolicy: 'skip' | 'react';
  cancelDangerousOrders: boolean;
  symbols: string;
  maxActionsPerHour: number;
  onQtyBelowMin: 'skip' | 'close';
  wsProxy: string;
  restProxy: string;
  autoStartGuard: boolean;
  launchOnLogin: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  apiSecret: '',
  testnet: false,
  dryRun: true,
  reactionMode: 'reduce',
  lossThresholdPct: 0,
  countPreexistingOrders: false,
  unknownOpenTimePolicy: 'skip',
  cancelDangerousOrders: true,
  symbols: '',
  maxActionsPerHour: 30,
  onQtyBelowMin: 'skip',
  wsProxy: '',
  restProxy: '',
  autoStartGuard: false,
  launchOnLogin: false,
};

/** То, что реально пишется на диск: секреты — зашифрованными строками base64. */
interface StoredSettings extends Omit<Settings, 'apiKey' | 'apiSecret'> {
  apiKeyEnc?: string;
  apiSecretEnc?: string;
}

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encrypt(value: string): string | undefined {
  if (!value) return undefined;
  if (!encryptionAvailable()) return undefined;
  return safeStorage.encryptString(value).toString('base64');
}

function decrypt(value: string | undefined): string {
  if (!value) return '';
  if (!encryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    // Ключ перестал расшифровываться (сменился пользователь Windows,
    // перенесли профиль) — считаем, что настроек нет.
    return '';
  }
}

export function loadSettings(): Settings {
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const stored = JSON.parse(raw) as StoredSettings;
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      apiKey: decrypt(stored.apiKeyEnc),
      apiSecret: decrypt(stored.apiSecretEnc),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next: Settings): { ok: boolean; warning?: string } {
  const { apiKey, apiSecret, ...rest } = next;
  const stored: StoredSettings = { ...rest };

  let warning: string | undefined;
  const encKey = encrypt(apiKey);
  const encSecret = encrypt(apiSecret);

  if ((apiKey || apiSecret) && (!encKey || !encSecret)) {
    warning =
      'Системное шифрование недоступно, ключи НЕ сохранены на диск. ' +
      'Они действуют только до перезапуска приложения.';
  } else {
    if (encKey) stored.apiKeyEnc = encKey;
    if (encSecret) stored.apiSecretEnc = encSecret;
  }

  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(stored, null, 2), { mode: 0o600 });
    return warning ? { ok: true, warning } : { ok: true };
  } catch (e) {
    return { ok: false, warning: e instanceof Error ? e.message : String(e) };
  }
}

/** Настройки без секретов — то, что безопасно отдать в окно. */
export function redact(s: Settings): Settings & { hasKeys: boolean } {
  return {
    ...s,
    apiKey: s.apiKey ? '••••••••' + s.apiKey.slice(-4) : '',
    apiSecret: s.apiSecret ? '••••••••' : '',
    hasKeys: Boolean(s.apiKey && s.apiSecret),
  };
}

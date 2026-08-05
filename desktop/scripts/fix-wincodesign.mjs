/**
 * Обходит известную поломку electron-builder на Windows.
 *
 * Проблема: пакет winCodeSign, которым electron-builder правит ресурсы .exe,
 * внутри содержит симлинки на macOS-библиотеки (libcrypto.dylib, libssl.dylib).
 * Windows не даёт создавать симлинки без прав администратора или включённого
 * «Режима разработчика», распаковка падает с «Cannot create symbolic link»,
 * и сборка обрывается.
 *
 * Решение: скачать тот же архив и распаковать его самим с ключом -snl-, который
 * разворачивает симлинки в обычные файлы, сразу в кэш electron-builder под
 * ожидаемым именем. Дальше сборка находит пакет готовым и ничего не качает.
 *
 * Почему Node, а не PowerShell: Windows PowerShell 5.1 читает .ps1 как ANSI,
 * поэтому любой не-ASCII символ в скрипте ломает разбор файла. Node читает
 * UTF-8 всегда.
 *
 * Запуск: npm run fix:wincodesign   (прав администратора не требует)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const VERSION = '2.6.0';
const URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-${VERSION}/winCodeSign-${VERSION}.7z`;

const here = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`\n  ОШИБКА: ${msg}\n`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  console.log('Этот обход нужен только для сборки под Windows. Здесь делать нечего.');
  process.exit(0);
}

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const cacheDir = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
const target = path.join(cacheDir, `winCodeSign-${VERSION}`);

if (fs.existsSync(path.join(target, 'windows-10'))) {
  console.log(`winCodeSign ${VERSION} уже распакован: ${target}`);
  console.log('Можно запускать: npm run dist:win');
  process.exit(0);
}

const sevenZip = path.join(here, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
if (!fs.existsSync(sevenZip)) {
  fail(`не найден 7za.exe: ${sevenZip}\n  Сначала выполните npm install в папке desktop.`);
}

fs.mkdirSync(cacheDir, { recursive: true });
const archive = path.join(cacheDir, `winCodeSign-${VERSION}.7z`);

console.log(`Скачиваю winCodeSign ${VERSION}…`);
const res = await fetch(URL);
if (!res.ok) fail(`не удалось скачать (${res.status} ${res.statusText})`);
fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
console.log(`  получено ${(fs.statSync(archive).size / 1024 / 1024).toFixed(1)} МБ`);

console.log('Распаковываю без симлинков…');
// -snl-  не создавать символические ссылки — в них и была причина падения
// -y     соглашаться на перезапись
// -bd    без индикатора прогресса
const out = spawnSync(sevenZip, ['x', '-snl-', '-y', '-bd', archive, `-o${target}`], {
  encoding: 'utf8',
});

if (out.status !== 0) {
  fail(`распаковка вернула код ${out.status}\n${out.stderr || out.stdout || ''}`);
}

fs.rmSync(archive, { force: true });

if (!fs.existsSync(path.join(target, 'windows-10'))) {
  fail(`архив распакован, но ожидаемой папки нет: ${path.join(target, 'windows-10')}`);
}

console.log(`\n  Готово. Кэш подготовлен: ${target}`);
console.log('  Теперь запускайте: npm run dist:win\n');

<#
  Обходит известную поломку electron-builder на Windows.

  Проблема: пакет winCodeSign, который electron-builder скачивает для правки
  ресурсов .exe, внутри содержит симлинки на macOS-библиотеки
  (libcrypto.dylib, libssl.dylib). Windows не даёт создавать симлинки без прав
  администратора или включённого «Режима разработчика», поэтому распаковка
  падает с «Cannot create symbolic link», и сборка обрывается.

  Что делает скрипт: скачивает тот же архив и распаковывает его САМ, с ключом
  -snl- (симлинк'и разворачиваются в обычные файлы), прямо в кэш
  electron-builder под ожидаемым именем. После этого сборка находит пакет
  готовым и ничего не качает.

  Запуск:  npm run fix:wincodesign
  Права администратора НЕ нужны.
#>

$ErrorActionPreference = 'Stop'

$version = '2.6.0'
$cacheDir = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
$target = Join-Path $cacheDir "winCodeSign-$version"
$url = "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-$version/winCodeSign-$version.7z"

if (Test-Path (Join-Path $target 'windows-10')) {
  Write-Host "winCodeSign $version уже распакован: $target" -ForegroundColor Green
  exit 0
}

$sevenZip = Join-Path $PSScriptRoot '..\node_modules\7zip-bin\win\x64\7za.exe'
if (-not (Test-Path $sevenZip)) {
  throw "Не найден 7za.exe: $sevenZip. Сначала выполните npm install в папке desktop."
}

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$archive = Join-Path $cacheDir "winCodeSign-$version.7z"

Write-Host "Скачиваю winCodeSign $version…"
Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing

Write-Host "Распаковываю без симлинков…"
# -snl-  : не создавать символические ссылки (в этом и была причина падения)
# -y     : отвечать «да» на перезапись
& $sevenZip x -snl- -y -bd $archive "-o$target" | Out-Null

if ($LASTEXITCODE -ne 0) {
  throw "Распаковка вернула код $LASTEXITCODE"
}

Remove-Item $archive -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Готово. Кэш подготовлен: $target" -ForegroundColor Green
Write-Host "Теперь запускайте: npm run dist:win"

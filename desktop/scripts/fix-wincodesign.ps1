# Kept only for backward compatibility: the real fix lives in fix-wincodesign.mjs.
# This file is intentionally ASCII-only - Windows PowerShell 5.1 reads .ps1 as ANSI,
# so any non-ASCII character here would break parsing.
Write-Host "Delegating to Node script..."
node "$PSScriptRoot\fix-wincodesign.mjs"
exit $LASTEXITCODE

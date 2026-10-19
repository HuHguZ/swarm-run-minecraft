# Перезапуск бота честного прогона (NeuroDown на server-run 25569, демон 8769)
# и наблюдателя за директором (director-watch.js пишет director-watch.log).
#   .\restart-run.ps1 [-Goal beat_game] [-NoWatch]
param([string]$Goal = 'beat_game', [switch]$NoWatch)
$root = Split-Path $PSScriptRoot -Parent
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*director-watch.js*' -or $_.CommandLine -like '*campaign.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-NetTCPConnection -LocalPort 8769 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-Sleep 2
$env:ND_WS_PORT = '8769'; $env:MC_USERNAME = 'NeuroDown'; $env:MC_PORT = '25569'; $env:ND_VIEWER_PORT = '3029'; $env:ND_MEMORY_DIR = "$root\memory-run"
Start-Process -FilePath node.exe -ArgumentList 'src/index.js' -WorkingDirectory "$root\dist\daemon" -RedirectStandardOutput "$root\daemon\run-8769.out.log" -RedirectStandardError "$root\daemon\run-8769.err.log" -WindowStyle Hidden
Start-Sleep 5
if (-not $NoWatch) {
  Start-Process -FilePath node.exe -ArgumentList 'tools\director-watch.js', 'ws://127.0.0.1:8769', $Goal -WorkingDirectory "$root\dist\daemon" -RedirectStandardOutput "$root\daemon\director-watch.out" -RedirectStandardError "$root\daemon\director-watch.err" -WindowStyle Hidden
}
if (Get-NetTCPConnection -LocalPort 8769 -State Listen -ErrorAction SilentlyContinue) { '8769 up' } else { '8769 DOWN' }

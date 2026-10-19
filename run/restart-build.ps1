# Restart the farming/riding-workstream daemon: bot NeuroBuild on its own test server
# server-build (127.0.0.1:25566), WebSocket 8771, memory in memory-build,
# viewer 3021. Kills only whatever listens on 8771.
#   powershell -ExecutionPolicy Bypass -File run\restart-build.ps1
$root = Split-Path $PSScriptRoot -Parent
Get-NetTCPConnection -LocalPort 8771 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-Sleep 2
$env:ND_WS_PORT = '8771'; $env:MC_USERNAME = 'NeuroBuild'; $env:MC_PORT = '25566'; $env:ND_VIEWER_PORT = '3021'
$env:ND_MEMORY_DIR = "$root\memory-build"
New-Item -ItemType Directory -Force "$root\memory-build" | Out-Null
Remove-Item Env:ND_DEBUG_PVP -ErrorAction SilentlyContinue
Start-Process -FilePath node.exe -ArgumentList 'src/index.js' -WorkingDirectory "$root\dist\daemon" -RedirectStandardOutput "$root\daemon\build-8771.out.log" -RedirectStandardError "$root\daemon\build-8771.err.log" -WindowStyle Hidden
Start-Sleep 4
if (Get-NetTCPConnection -LocalPort 8771 -State Listen -ErrorAction SilentlyContinue) { '8771 up' } else { '8771 DOWN' }

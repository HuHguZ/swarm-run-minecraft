# Restart the nether-workstream daemon: bot NeuroNether on its own test server
# server-nether (127.0.0.1:25567), WebSocket 8772, memory in memory-nether,
# viewer 3022. Kills only whatever listens on 8772.
#   powershell -ExecutionPolicy Bypass -File run\restart-nether.ps1
$root = Split-Path $PSScriptRoot -Parent
Get-NetTCPConnection -LocalPort 8772 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-Sleep 2
$env:ND_WS_PORT = '8772'; $env:MC_USERNAME = 'NeuroNether'; $env:MC_PORT = '25567'; $env:ND_VIEWER_PORT = '3022'
$env:ND_MEMORY_DIR = "$root\memory-nether"
New-Item -ItemType Directory -Force "$root\memory-nether" | Out-Null
Remove-Item Env:ND_DEBUG_PVP -ErrorAction SilentlyContinue
Start-Process -FilePath node.exe -ArgumentList 'src/index.js' -WorkingDirectory "$root\dist\daemon" -RedirectStandardOutput "$root\daemon\nether-8772.out.log" -RedirectStandardError "$root\daemon\nether-8772.err.log" -WindowStyle Hidden
Start-Sleep 4
if (Get-NetTCPConnection -LocalPort 8772 -State Listen -ErrorAction SilentlyContinue) { '8772 up' } else { '8772 DOWN' }

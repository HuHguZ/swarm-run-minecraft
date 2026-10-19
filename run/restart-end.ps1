# Restart the end-workstream daemon: bot NeuroEnd on its own test server
# server-end (127.0.0.1:25568), WebSocket 8773, memory in memory-end,
# viewer 3023. Kills only whatever listens on 8773.
#   powershell -ExecutionPolicy Bypass -File run\restart-end.ps1
#   $env:ND_DEBUG_DRAGON='1' before it for the dragon.js trace in the log.
$root = Split-Path $PSScriptRoot -Parent
Get-NetTCPConnection -LocalPort 8773 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-Sleep 2
$env:ND_WS_PORT = '8773'; $env:MC_USERNAME = 'NeuroEnd'; $env:MC_PORT = '25568'; $env:ND_VIEWER_PORT = '3023'
$env:ND_MEMORY_DIR = "$root\memory-end"
New-Item -ItemType Directory -Force "$root\memory-end" | Out-Null
Remove-Item Env:ND_DEBUG_PVP -ErrorAction SilentlyContinue
Start-Process -FilePath node.exe -ArgumentList 'src/index.js' -WorkingDirectory "$root\dist\daemon" -RedirectStandardOutput "$root\daemon\end-8773.out.log" -RedirectStandardError "$root\daemon\end-8773.err.log" -WindowStyle Hidden
Start-Sleep 4
if (Get-NetTCPConnection -LocalPort 8773 -State Listen -ErrorAction SilentlyContinue) { '8773 up' } else { '8773 DOWN' }

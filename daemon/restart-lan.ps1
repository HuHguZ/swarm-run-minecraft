# Перезапуск двух ботов в LAN-мире пользователя: NeuroDown (8765, основной,
# память memory/) и NeuroDown2 (8768, память memory-arena2). Порт мира меняется
# при каждом открытии — передать: .\restart-lan.ps1 -McPort 63523 [-PvpDebug]
param([Parameter(Mandatory = $true)][string]$McPort, [switch]$PvpDebug)
$root = Split-Path $PSScriptRoot -Parent
foreach ($p in 8765, 8768) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }
Start-Sleep 2
function StartD($ws, $name, $mem, $view, $out, $err) {
  $env:ND_WS_PORT = "$ws"; $env:MC_USERNAME = $name; $env:MC_PORT = $McPort; $env:ND_VIEWER_PORT = "$view"
  if ($mem) { $env:ND_MEMORY_DIR = "$root\$mem"; New-Item -ItemType Directory -Force "$root\$mem" | Out-Null } else { Remove-Item Env:ND_MEMORY_DIR -ErrorAction SilentlyContinue }
  if ($PvpDebug) { $env:ND_DEBUG_PVP = '1' } else { Remove-Item Env:ND_DEBUG_PVP -ErrorAction SilentlyContinue }
  Start-Process -FilePath node.exe -ArgumentList 'src/index.js' -WorkingDirectory "$root\dist\daemon" -RedirectStandardOutput "$root\daemon\$out" -RedirectStandardError "$root\daemon\$err" -WindowStyle Hidden
}
StartD 8765 'NeuroDown' $null 3007 'daemon.out.log' 'daemon.err.log'
StartD 8768 'NeuroDown2' 'memory-arena2' 3018 'arena-8768.out.log' 'arena-8768.err.log'
Start-Sleep 4
foreach ($p in 8765, 8768) { if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { "$p up" } else { "$p DOWN" } }

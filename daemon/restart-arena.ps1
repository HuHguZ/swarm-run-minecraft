# Перезапуск двух бойцов арены (тестовый Paper на 25565).
$root = Split-Path $PSScriptRoot -Parent
foreach ($p in 8767, 8768) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }
Start-Sleep 2
function StartD($ws, $name, $mem, $view) {
  $env:ND_WS_PORT = "$ws"; $env:MC_USERNAME = $name; $env:MC_PORT = '25565'; $env:ND_MEMORY_DIR = "$root\$mem"; $env:ND_VIEWER_PORT = "$view"
  New-Item -ItemType Directory -Force "$root\$mem" | Out-Null
  Start-Process -FilePath node.exe -ArgumentList 'src/index.js' -WorkingDirectory "$root\daemon" -RedirectStandardOutput "$root\daemon\arena-$ws.out.log" -RedirectStandardError "$root\daemon\arena-$ws.err.log" -WindowStyle Hidden
}
StartD 8767 'NeuroDown' 'memory-arena1' 3017
StartD 8768 'NeuroDown2' 'memory-arena2' 3018

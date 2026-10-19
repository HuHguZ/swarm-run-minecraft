# Перезапуск демонов фермы координатора (слоты 1..16) с тем же окружением, что
# у farm.js startDaemon: ws 8800+i, бот NeuroFarm<i>, сервер 25600+i, viewer
# 3100+i, память farm\memory-<i>. Сервер слота не трогает.
param([int[]]$Slots = @(1,2,3,4,5,6,7,8,9,10))
$root = Split-Path $PSScriptRoot -Parent
foreach ($i in $Slots) {
  $ws = 8800 + $i
  $conn = Get-NetTCPConnection -LocalPort $ws -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conn) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep 2
foreach ($i in $Slots) {
  $env:ND_WS_PORT = "$(8800 + $i)"; $env:MC_USERNAME = "NeuroFarm$i"; $env:MC_PORT = "$(25600 + $i)"; $env:ND_VIEWER_PORT = "$(3100 + $i)"; $env:ND_MEMORY_DIR = "$root\farm\memory-$i"
  $p = Start-Process -FilePath node.exe -ArgumentList 'src/index.js' -WorkingDirectory "$root\dist\daemon" -RedirectStandardOutput "$root\farm\daemon-$i.out.log" -RedirectStandardError "$root\farm\daemon-$i.err.log" -WindowStyle Hidden -PassThru
  Write-Host "slot $i daemon pid $($p.Id)"
}
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
  $down = @($Slots | Where-Object { -not (Get-NetTCPConnection -LocalPort (8800 + $_) -State Listen -ErrorAction SilentlyContinue) })
  if ($down.Count -eq 0) { Write-Host 'all up'; exit 0 }
  Start-Sleep -Milliseconds 500
}
Write-Host "DOWN: $down"
exit 1

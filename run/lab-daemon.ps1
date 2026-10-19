# Лабораторный демон (server-nether 25567): порт ws, имя бота, папка памяти.
# Убивает только процесс, слушающий свой ws-порт.
param([int]$Port = 8773, [string]$Name = 'NeuroNether', [int]$Mc = 25567, [int]$Viewer = 3033, [string]$Mem = 'memory-lab-bastion', [switch]$Stop)
$root = Split-Path $PSScriptRoot -Parent
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn) { Write-Host "stopping daemon pid $($c.OwningProcess)"; Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
if ($conn) { Start-Sleep 2 }
if ($Stop) { exit 0 }
$env:ND_WS_PORT = "$Port"; $env:MC_USERNAME = $Name; $env:MC_PORT = "$Mc"; $env:ND_VIEWER_PORT = "$Viewer"; $env:ND_MEMORY_DIR = "$root\$Mem"
$p = Start-Process -FilePath node.exe -ArgumentList 'src/index.js' -WorkingDirectory "$root\dist\daemon" -RedirectStandardOutput "$root\daemon\lab-$Port.out.log" -RedirectStandardError "$root\daemon\lab-$Port.err.log" -WindowStyle Hidden -PassThru
Write-Host "daemon pid $($p.Id)"
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { Write-Host "$Port up"; exit 0 }
  Start-Sleep -Milliseconds 500
}
Write-Host "$Port DOWN"
exit 1

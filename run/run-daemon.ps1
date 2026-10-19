# Starts/stops ONLY the campaign daemon on ws 8769 (NeuroDown -> server-run 25569).
# Kills nothing but the process listening on 8769. No director-watch.
param([switch]$Stop)
$root = Split-Path $PSScriptRoot -Parent
$conn = Get-NetTCPConnection -LocalPort 8769 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn) { Write-Host "stopping daemon pid $($c.OwningProcess)"; Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
if ($conn) { Start-Sleep 2 }
if ($Stop) { exit 0 }
$env:ND_WS_PORT = '8769'; $env:MC_USERNAME = 'NeuroDown'; $env:MC_PORT = '25569'; $env:ND_VIEWER_PORT = '3029'; $env:ND_MEMORY_DIR = "$root\memory-run"
$p = Start-Process -FilePath node.exe -ArgumentList 'src/index.js' -WorkingDirectory "$root\dist\daemon" -RedirectStandardOutput "$root\daemon\run-8769.out.log" -RedirectStandardError "$root\daemon\run-8769.err.log" -WindowStyle Hidden -PassThru
Write-Host "daemon pid $($p.Id)"
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  if (Get-NetTCPConnection -LocalPort 8769 -State Listen -ErrorAction SilentlyContinue) { Write-Host '8769 up'; exit 0 }
  Start-Sleep -Milliseconds 500
}
Write-Host '8769 DOWN'
exit 1

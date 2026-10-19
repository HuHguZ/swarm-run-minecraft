# Starts/stops ONLY my campaign.js process (pid kept in campaign.pid here).
param([switch]$Stop, [string]$Stages = '', [int]$EyesNeed = 0, [switch]$Endermen)
$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $PSScriptRoot 'campaign.pid'
if (Test-Path $pidFile) {
  $old = Get-Content $pidFile
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $old" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine -like '*campaign.js*') { Write-Host "stopping campaign pid $old"; Stop-Process -Id $old -Force }
  Remove-Item $pidFile
}
if ($Stop) { exit 0 }
$env:ND_WS = 'ws://127.0.0.1:8769'
# Empty end portal frames in the stronghold room (12 minus eyes already there); server-run: 10.
if ($EyesNeed -gt 0) { $env:ND_EYES_NEED = "$EyesNeed" }
# Enderman hunting (pearls stage) only with the user's permission.
if ($Endermen) { $env:ND_ENDERMEN = '1' } else { Remove-Item Env:ND_ENDERMEN -ErrorAction SilentlyContinue }
$argList = @('campaign.js'); if ($Stages) { $argList += $Stages }
$p = Start-Process -FilePath node.exe -ArgumentList $argList -WorkingDirectory "$root\dist\daemon" -RedirectStandardOutput "$root\daemon\campaign.out" -RedirectStandardError "$root\daemon\campaign.err" -WindowStyle Hidden -PassThru
$p.Id | Set-Content $pidFile
Write-Host "campaign pid $($p.Id)"

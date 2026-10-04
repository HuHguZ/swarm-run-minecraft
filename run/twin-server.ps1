# Двойник мира прохождения: server-twin (25570), тот же сид, что у server-run.
# Репетиции этапов на той же карте (бастион, крепость Ада, крепость Края).
# -Stop убивает процесс без сохранения; штатно — /stop от бота-оператора.
param([switch]$Stop)
$Java = "C:\Users\user\AppData\Roaming\.minecraft\runtime\java-runtime-delta\windows\java-runtime-delta\bin\java.exe"
$Dir = 'C:\Users\user\Desktop\work\minecraft-claude\server-twin'
$Port = 25570
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn) { Write-Host "stopping server-twin pid $($c.OwningProcess)"; Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
if ($conn) { Start-Sleep -Seconds 3 }
if ($Stop) { exit 0 }
Start-Process -FilePath $Java -WorkingDirectory $Dir -WindowStyle Hidden -ArgumentList "-Xms1G", "-Xmx3G", "-XX:+UseG1GC", "-Dfile.encoding=UTF-8", "-jar", "paper-1.21.11-132.jar", "--nogui" -RedirectStandardOutput (Join-Path $Dir "console.out.log") -RedirectStandardError (Join-Path $Dir "console.err.log")
$deadline = (Get-Date).AddSeconds(240)
while ((Get-Date) -lt $deadline) {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { Write-Host "server-twin up on $Port"; exit 0 }
  Start-Sleep -Seconds 2
}
throw "server-twin did not come up"

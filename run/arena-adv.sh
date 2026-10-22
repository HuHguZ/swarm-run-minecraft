#!/usr/bin/env bash
# Слот 31, стенд бота-противника: собрать dist-adv$N, снимок arena-adv$N, перезапустить демонов (если не DRIVER_ONLY) и драйвер.
#   run/arena-adv.sh N        (ARENA_TRACE_NEAR=1 ARENA_BOOST=0 — трасса стояний, без «человек на арене»); лог драйвера: farm/results/duo-31/arenaadv$N.out
cd /c/Users/user/Desktop/work/minecraft-claude || exit 1
N=$1; D=dist-adv$N; CODE=arena-adv$N; S=$(dirname "$0")
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { \$_.CommandLine -like '*adversary.js*' -or \$_.CommandLine -like '*ffa.js arms 31' } | % { Stop-Process -Id \$_.ProcessId -Force }"
node scripts/build.mjs --out $D 2>&1 | tail -1
if [ -z "$DRIVER_ONLY" ]; then
  node $D/farm/farm.js snapshot $CODE --drop > /dev/null 2>&1; node $D/farm/farm.js snapshot $CODE 2>&1 | tail -1 | cut -c1-120
  node $D/farm/farm.js daemons 31 --code $CODE 2>&1 | tail -1
  node $D/farm/arena/ffa.js down 31 > /dev/null 2>&1
  FFA_CODE=$CODE ND_RESPAWN_MS=3000 ND_SCAFFOLD_ANY=1 node $D/farm/arena/ffa.js up 31 29 > farm/results/duo-31/ffa-up.log 2>&1
  echo "демонов: $(grep -c '✓' farm/results/duo-31/ffa-up.log)"
  powershell -NoProfile -Command "\$n=0; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { \$_.CommandLine -like '*src/index.js*' } | % { try { \$p = Get-Process -Id \$_.ProcessId; \$p.ProcessorAffinity = [IntPtr][Int64]4294901760; \$p.PriorityClass = 'BelowNormal'; \$n++ } catch {} }; \"закреплено \$n\""
fi
CODE=$CODE D=$D ROUND_S=${ROUND_S:-1800} bash $S/arena-play.sh drive adv$N 2>&1 | tail -1

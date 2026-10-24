#!/usr/bin/env bash
# Игра людей против роя: слот 31 (25631), обычная скорость 20 TPS без пошагового режима, 30 ботов синие, люди — красные
# (ARMS_SOLO=1: набор человека — незерит, меч, булава, лук, яблоки). Код — dist-play, снимок arena-play.
#   arena-play.sh up | drive N | down     лог: farm/results/duo-31/arena<N>.out
cd /c/Users/user/Desktop/work/minecraft-claude || exit 1
SL=31; C=${C:-29}; CODE=${CODE:-arena-play}; D=${D:-dist-play}
stop_driver () { powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { \$_.CommandLine -like '*arena*ffa.js arms $SL' } | % { Stop-Process -Id \$_.ProcessId -Force; 'driver stopped' }"; }
case "$1" in
up)
  node $D/farm/farm.js snapshot $CODE --drop > /dev/null 2>&1; node $D/farm/farm.js snapshot $CODE 2>&1 | tail -1
  FARM_MAX_PLAYERS=50 FARM_VIEW_DISTANCE=12 node $D/farm/farm.js up 1 --from $SL --tick-rate ${TR:-20} --code $CODE > farm/results/duo-$SL/up.log 2>&1
  tail -2 farm/results/duo-$SL/up.log
  FFA_CODE=$CODE ND_RESPAWN_MS=3000 ND_SCAFFOLD_ANY=1 node $D/farm/arena/ffa.js up $SL $C > farm/results/duo-$SL/ffa-up.log 2>&1
  echo "демонов: $(grep -c '✓' farm/results/duo-$SL/ffa-up.log)"
  node $D/farm/farm.js nice 2>&1 | tail -2; echo up ;;
drive)
  stop_driver; N=${2:-x}
  ARMS_MAP=colosseum ARMS_SOLO=1 ARMS_HUMAN_TEAMS="${ARMS_HUMAN_TEAMS:-}" ARMS_POS="600 120 600" ROUND_S=${ROUND_S:-1200} TICK_RATE=${TR:-20} ARMS_LAN=0 ARMS_WEATHER=${ARMS_WEATHER:-thunder} ND_SWARM_TRACE=1 \
    nohup node $D/farm/arena/ffa.js arms $SL > farm/results/duo-$SL/arena$N.out 2>&1 &
  echo "драйвер $(date +%T), лог arena$N.out" ;;
down)
  stop_driver; node $D/farm/arena/ffa.js down $SL > /dev/null 2>&1; node $D/farm/farm.js down $SL 2>&1 | tail -1 ;;
esac

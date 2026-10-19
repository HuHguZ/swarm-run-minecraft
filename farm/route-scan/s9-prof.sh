#!/bin/sh
# S9: профиль CPU демона (инспектор V8) на маршруте «новый мир → Ад», пошаговый слот, снимок кода, плечо ND_S9.
#   sh farm/route-scan/s9-prof.sh <слот> <тег> <снимок> <сид> <плечо 0|1> [KEY=VAL ...]
# Профиль — farm/logs/s9/<тег>.cpuprofile (весь прогон сцены). Мир гасится в конце.
cd "$(dirname "$0")/../.." || exit 1
slot=$1; tag=$2; code=$3; seed=$4; arm=$5; shift 5
for try in $(seq 1 1440); do
  ND_S9=$arm node dist/farm/farm.js up 1 --from "$slot" --seeds "$seed" --fresh --lockstep --reup --code "$code" > "farm/logs/s9-up-$slot.log" 2>&1
  grep -q "демон .* ✓" "farm/logs/s9-up-$slot.log" && break
  grep -q "лимит" "farm/logs/s9-up-$slot.log" || { echo "up не вышел"; tail -5 "farm/logs/s9-up-$slot.log"; exit 1; }
  sleep 5
done
port=$((9300 + slot))
node dist/farm/farm.js daemons "$slot" ND_S9=$arm NODE_OPTIONS=--inspect=127.0.0.1:$port > "farm/logs/s9/$tag-daemons.log" 2>&1
sleep 3
rm -f "farm/logs/s9/$tag.stop"
node research/claude-1006/lockstep-tools/cdp-prof.js $port 900 "farm/logs/s9/$tag.cpuprofile" "farm/logs/s9/$tag.stop" > "farm/logs/s9/$tag-prof.log" 2>&1 &
echo "[$(date +%H:%M:%S)] профиль $tag: слот $slot, сид $seed, ND_S9=$arm"
ND_S9=$arm node dist/farm/farm.js run try-lab-fresh.js --slots "$slot" --tag "$tag" UNTIL=nether MINUTES=${MINUTES:-20} DEATHS_MAX=1 "$@" > "farm/results/$tag.run.log" 2>&1
touch "farm/logs/s9/$tag.stop"; sleep 3; wait
cp "farm/daemon-$slot.out.log" "farm/results/$tag/daemon-$slot.out.log" 2>/dev/null
[ "$KEEP_SLOT" = 1 ] || node dist/farm/farm.js down "$slot" > /dev/null 2>&1
echo "[$(date +%H:%M:%S)] профиль $tag готов"

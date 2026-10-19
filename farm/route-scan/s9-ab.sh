#!/bin/sh
# S9 (07.10): A/B скорости тела на маршруте «новый мир → Ад» — ОДИН пошаговый слот, ОДИН снимок кода, флаг демона ND_S9
# (0 — прежний код, 1 — кеш блоков/описания/бюджет A* в узлах). На каждый сид два прогона со свежим миром, порядок плеч
# чередуется (0,1 / 1,0). Настройки сцены — как у S8b/S8c (постройки+лава по карте).
#   sh farm/route-scan/s9-ab.sh <слот> <тег> <снимок> <сид1,сид2,...> [KEY=VAL ...]
# Итоги: farm/results/<тег>-<k>-s9<плечо>/. Мягкий стоп — touch farm/logs/s9-STOP. Мир гасится в конце.
cd "$(dirname "$0")/../.." || exit 1
slot=$1; tag=$2; code=$3; seeds=$4; shift 4
k=0
for seed in $(echo "$seeds" | tr ',' ' '); do
  k=$((k+1))
  arms="0 1"; [ $((k % 2)) -eq 0 ] && arms="1 0"
  for arm in $arms; do
    [ -f farm/logs/s9-STOP ] && { echo "стоп по farm/logs/s9-STOP"; break 2; }
    t="$tag-$k-s9$arm"
    [ -f "farm/results/$t/slot-$slot.jsonl" ] && { echo "$t уже есть — пропуск"; continue; }
    for try in $(seq 1 1440); do
      ND_S9=$arm node dist/farm/farm.js up 1 --from "$slot" --seeds "$seed" --fresh --lockstep --reup --code "$code" > "farm/logs/s9-up-$slot.log" 2>&1
      grep -q "демон .* ✓" "farm/logs/s9-up-$slot.log" && break
      grep -q "лимит" "farm/logs/s9-up-$slot.log" || { echo "[$(date +%H:%M:%S)] up не вышел:"; tail -5 "farm/logs/s9-up-$slot.log"; exit 1; }
      sleep 5
    done
    grep -q "демон .* ✓" "farm/logs/s9-up-$slot.log" || { echo "мира не дали за 2 ч"; exit 1; }
    echo "[$(date +%H:%M:%S)] слот $slot: сид $seed, партия $t, снимок $code, ND_S9=$arm"
    ND_S9=$arm node dist/farm/farm.js run try-lab-fresh.js --slots "$slot" --tag "$t" UNTIL=nether MINUTES=${MINUTES:-20} DEATHS_MAX=1 "$@" > "farm/results/$t.run.log" 2>&1
    cp "farm/daemon-$slot.out.log" "farm/results/$t/daemon-$slot.out.log" 2>/dev/null
    cp "farm/server-$slot/console.out.log" "farm/results/$t/console-$slot.out.log" 2>/dev/null
    tail -1 "farm/results/$t/slot-$slot.jsonl" 2>/dev/null | cut -c1-300
  done
done
node dist/farm/farm.js down "$slot" > /dev/null 2>&1
echo "[$(date +%H:%M:%S)] слот $slot: серия $tag кончилась"

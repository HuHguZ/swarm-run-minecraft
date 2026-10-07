#!/bin/sh
# S8 (07.10): серия «новый мир → Ад» на ОДНОМ пошаговом слоте. Для каждого сида: up --fresh --lockstep (под общим замком;
# отказ по лимиту миров — ждать 60 с и повторять), сцена try-lab-fresh UNTIL=nether, копия журнала демона, down своего слота.
#   sh farm/route-scan/s8-cycle.sh <слот> <тег> <сид1,сид2,...> [KEY=VAL ...]
# Итоги: farm/results/<тег>-<k>/; сводка — node farm/route-scan/report.js или tree.js. Мягкий стоп — touch farm/logs/s8-STOP.
cd "$(dirname "$0")/../.." || exit 1
slot=$1; tag=$2; seeds=$3; shift 3
k=0
for seed in $(echo "$seeds" | tr ',' ' '); do
  k=$((k+1))
  [ -f farm/logs/s8-STOP ] && { echo "стоп по farm/logs/s8-STOP"; break; }
  for try in $(seq 1 1440); do
    node farm/farm.js up 1 --from "$slot" --seeds "$seed" --fresh --lockstep > "farm/logs/s8-up-$slot.log" 2>&1
    grep -q "демон .* ✓" "farm/logs/s8-up-$slot.log" && break
    # Не лимит — чужая беда или сломанный слот: дальше не иду (чужое не гашу).
    grep -q "лимит" "farm/logs/s8-up-$slot.log" || { echo "[$(date +%H:%M:%S)] up не вышел:"; tail -5 "farm/logs/s8-up-$slot.log"; exit 1; }
    sleep 5
  done
  grep -q "демон .* ✓" "farm/logs/s8-up-$slot.log" || { echo "мира не дали за 2 ч"; exit 1; }
  echo "[$(date +%H:%M:%S)] слот $slot: сид $seed, партия $tag-$k"
  node farm/farm.js run try-lab-fresh.js --slots "$slot" --tag "$tag-$k" UNTIL=nether MINUTES=30 DEATHS_MAX=1 ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1 "$@" > "farm/results/$tag-$k.run.log" 2>&1
  cp "farm/daemon-$slot.out.log" "farm/results/$tag-$k/daemon-$slot.out.log" 2>/dev/null
  node farm/farm.js down "$slot" > /dev/null 2>&1
  tail -1 "farm/results/$tag-$k/slot-$slot.jsonl" 2>/dev/null | cut -c1-300
done
echo "[$(date +%H:%M:%S)] слот $slot: серия $tag кончилась"

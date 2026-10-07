#!/bin/sh
# S8c (07.10, копия s8b-cycle): серия «новый мир → Ад» на ОДНОМ пошаговом слоте и СНИМКЕ кода. Для каждого сида (повтор — через запятую
# ещё раз): up --fresh --lockstep --code <снимок> (под общим замком; отказ по лимиту — ждать и повторять), сцена
# try-lab-fresh UNTIL=nether, копия журнала демона, down своего слота.
#   sh farm/route-scan/s8b-cycle.sh <слот> <тег> <снимок> <сид1,сид2,...> [KEY=VAL ...]
# Итоги: farm/results/<тег>-<k>/. Мягкий стоп — touch farm/logs/s8c-STOP.
cd "$(dirname "$0")/../.." || exit 1
slot=$1; tag=$2; code=$3; seeds=$4; shift 4
k=0
for seed in $(echo "$seeds" | tr ',' ' '); do
  k=$((k+1))
  [ -f farm/logs/s8c-STOP ] && { echo "стоп по farm/logs/s8c-STOP"; break; }
  [ -f "farm/results/$tag-$k/slot-$slot.jsonl" ] && { echo "$tag-$k уже есть — пропуск"; continue; }
  for try in $(seq 1 1440); do
    node farm/farm.js up 1 --from "$slot" --seeds "$seed" --fresh --lockstep --reup --code "$code" > "farm/logs/s8c-up-$slot.log" 2>&1
    grep -q "демон .* ✓" "farm/logs/s8c-up-$slot.log" && break
    grep -q "лимит" "farm/logs/s8c-up-$slot.log" || { echo "[$(date +%H:%M:%S)] up не вышел:"; tail -5 "farm/logs/s8c-up-$slot.log"; exit 1; }
    sleep 5
  done
  grep -q "демон .* ✓" "farm/logs/s8c-up-$slot.log" || { echo "мира не дали за 2 ч"; exit 1; }
  echo "[$(date +%H:%M:%S)] слот $slot: сид $seed, партия $tag-$k, снимок $code"
  node farm/farm.js run try-lab-fresh.js --slots "$slot" --tag "$tag-$k" UNTIL=nether MINUTES=${MINUTES:-30} DEATHS_MAX=1 "$@" > "farm/results/$tag-$k.run.log" 2>&1
  cp "farm/daemon-$slot.out.log" "farm/results/$tag-$k/daemon-$slot.out.log" 2>/dev/null
  tail -1 "farm/results/$tag-$k/slot-$slot.jsonl" 2>/dev/null | cut -c1-300
done
# KEEP_SLOT=1 — мир не гасить (дальше в цепочке следующая серия с --reup).
[ "$KEEP_SLOT" = 1 ] || node farm/farm.js down "$slot" > /dev/null 2>&1
echo "[$(date +%H:%M:%S)] слот $slot: серия $tag кончилась"

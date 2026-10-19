#!/bin/sh
# Серия потока nether-end (dev-F) на одном слоте: для каждого сида — свежий мир и сцена.
#   sh farm/series/ne-cycle.sh <слот> <серия> <сид1,сид2,...> [СЦЕНА=try-lab-ne-run.js] -- [KEY=VAL ...]
# Теги партий: neF-<серия><слот>-<k>. Итоги: node dist/farm/analysis/ne-sum.js neF-<серия><слот>-1 …
cd "$(dirname "$0")/../.." || exit 1
slot=$1; series=$2; seeds=$3; shift 3
scene=try-lab-ne-run.js
if [ "$1" != "--" ] && [ -n "$1" ]; then scene=$1; shift; fi
[ "$1" = "--" ] && shift
k=0
for seed in $(echo "$seeds" | tr ',' ' '); do
  k=$((k+1))
  echo "[$(date +%H:%M:%S)] слот $slot: сид $seed, партия neF-$series$slot-$k"
  # down — и демон тоже: иначе up оставляет старый процесс демона (старый код и память прошлого мира в памяти процесса).
  node dist/farm/farm.js down "$slot"
  node dist/farm/farm.js up 1 --from "$slot" --seeds "$seed" --fresh
  node dist/farm/farm.js run "$scene" --slots "$slot" --tag "neF-$series$slot-$k" "$@"
  # Журнал демона перезаписывается при следующем up — копия рядом с итогами партии.
  cp "farm/daemon-$slot.out.log" "farm/results/neF-$series$slot-$k/daemon-$slot.out.log" 2>/dev/null
done
echo "[$(date +%H:%M:%S)] слот $slot: серия $series кончилась"

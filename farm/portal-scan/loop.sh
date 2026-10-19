#!/bin/sh
# Цикл: слоты 29–30 — свежие случайные миры, прогрузка, скан, down. Только 29–30.
cd /c/Users/user/Desktop/work/minecraft-claude
N=${1:-5}
HALF=${2:-384}
for k in $(seq 1 $N); do
  echo "== цикл $k $(date +%H:%M:%S)"
  node dist/farm/farm.js down 29-30
  node dist/farm/farm.js up 2 --from 29 --fresh --random
  node dist/farm/portal-scan/scan.js gen 29 $HALF &
  node dist/farm/portal-scan/scan.js gen 30 $HALF &
  wait
  node --max-old-space-size=6144 farm/portal-scan/scan.js scan 29 $HALF
  node --max-old-space-size=6144 farm/portal-scan/scan.js scan 30 $HALF
done
echo "== конец $(date +%H:%M:%S)"

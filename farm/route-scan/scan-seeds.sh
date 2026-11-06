#!/bin/sh
# Скан копий миров для маршрута (поток route): на одном своём слоте по очереди — свежий мир сида, прогрузка квадрата
# 2*HALF у спавна, чтение region-файлов → farm/route-scan/<сид>.json, слот опустить.
#   sh farm/route-scan/scan-seeds.sh <слот> <сид> [<сид> ...]     (HALF=160 по умолчанию; готовые сиды пропускаются)
CDPATH= cd "$(dirname "$0")/../.." || exit 1
SLOT=$1; shift
HALF=${HALF:-160}
for S in "$@"; do
  if [ -f "farm/route-scan/$S.json" ] && node -e "const j=require('./farm/route-scan/$S.json');process.exit(j.half>=$HALF&&!j.missingChunks&&Array.isArray(j.lava)&&j.v>=6?0:1)"; then echo "== $S: уже есть"; continue; fi
  echo "== $S слот $SLOT $(date +%H:%M:%S)"
  node dist/farm/farm.js down $SLOT > /dev/null 2>&1
  node dist/farm/farm.js up 1 --from $SLOT --fresh --seeds $S 2>&1 | tail -1
  node dist/farm/route-scan/scan.js gen $SLOT $HALF
  node --max-old-space-size=6144 farm/route-scan/scan.js scan $SLOT $HALF
done
node dist/farm/farm.js down $SLOT > /dev/null 2>&1
echo "== конец слот $SLOT $(date +%H:%M:%S)"

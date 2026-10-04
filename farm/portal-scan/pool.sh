#!/bin/sh
# Скан лавы у пула хороших сидов (farm/seeds/good-v1.json), слоты 29–30, по два сида за цикл.
#   sh farm/portal-scan/pool.sh <с> <по>     — индексы в списке seeds, [с, по)
cd /c/Users/user/Desktop/work/minecraft-claude
FROM=${1:-0}; TO=${2:-100}; HALF=${HALF:-224}
export PORTAL_SCAN_OUT=farm/portal-scan/results-pool
mkdir -p $PORTAL_SCAN_OUT
SEEDS=$(node -e "const j=require('./farm/seeds/good-v1.json');console.log(j.seeds.slice($FROM,$TO).map(s=>s.seed).join(' '))")
set -- $SEEDS
while [ $# -gt 0 ]; do
  A=$1; B=${2:-$1}; shift; [ $# -gt 0 ] && shift
  if [ -f "$PORTAL_SCAN_OUT/$A.json" ] && [ -f "$PORTAL_SCAN_OUT/$B.json" ]; then continue; fi
  echo "== $A $B $(date +%H:%M:%S)"
  node farm/farm.js down 29-30
  node farm/farm.js up 2 --from 29 --fresh --seeds $A,$B
  node farm/portal-scan/scan.js gen 29 $HALF &
  node farm/portal-scan/scan.js gen 30 $HALF &
  wait
  node --max-old-space-size=6144 farm/portal-scan/scan.js scan 29 $HALF
  node --max-old-space-size=6144 farm/portal-scan/scan.js scan 30 $HALF
done
node farm/farm.js down 29-30
echo "== конец $(date +%H:%M:%S)"

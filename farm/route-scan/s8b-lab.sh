#!/bin/sh
# S8b: лаборатория литья одним ведром на снимке кода (слот 8, --lockstep, мир не гасится — дальше серия с --reup).
#   sh farm/route-scan/s8b-lab.sh <снимок> <тег> [KEY=VAL ...]
cd "$(dirname "$0")/../.." || exit 1
code=$1; tag=$2; shift 2
for try in $(seq 1 1440); do
  node dist/farm/farm.js up 1 --from 8 --pool --fresh --lockstep --reup --code "$code" > farm/logs/s8b-up-8.log 2>&1
  grep -q "демон .* ✓" farm/logs/s8b-up-8.log && break
  grep -q "лимит" farm/logs/s8b-up-8.log || { echo "up не вышел"; tail -5 farm/logs/s8b-up-8.log; exit 1; }
  sleep 5
done
echo "[$(date +%H:%M:%S)] лаборатория $tag на снимке $code"
node dist/farm/farm.js run try-lab-ow-cast1.js --slots 8 --tag "$tag" "$@" > "farm/results/$tag.run.log" 2>&1
cp farm/daemon-8.out.log "farm/results/$tag/daemon-8.out.log" 2>/dev/null
echo "[$(date +%H:%M:%S)] лаборатория $tag кончилась"

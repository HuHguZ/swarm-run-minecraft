#!/bin/sh
# Скан копий миров параллельно на нескольких своих слотах (поток route, 03.10): слоты уже подняты с нужными сидами
# (farm.js up … --fresh --seeds …), здесь — gen + scan на каждом сразу, потом сводка. Слоты не опускает.
#   sh farm/route-scan/scan-par.sh 8-20,27-29 [HALF]
cd /c/Users/user/Desktop/work/minecraft-claude
SPEC=$1
HALF=${2:-160}
SLOTS=$(node -e "const s=process.argv[1];const o=[];for(const p of s.split(',')){const m=/^(\d+)(?:-(\d+))?$/.exec(p);if(!m)continue;for(let i=+m[1];i<=+(m[2]||m[1]);i++)o.push(i)}console.log(o.join(' '))" "$SPEC")
mkdir -p farm/route-scan/logs
for S in $SLOTS; do
  ( node dist/farm/route-scan/scan.js gen $S $HALF > farm/route-scan/logs/gen-$S.log 2>&1 && \
    node --max-old-space-size=4096 farm/route-scan/scan.js scan $S $HALF > farm/route-scan/logs/scan-$S.log 2>&1; \
    echo "слот $S: $(tail -c 300 farm/route-scan/logs/scan-$S.log)" ) &
  sleep 2
done
wait
echo "== скан готов $(date +%H:%M:%S)"

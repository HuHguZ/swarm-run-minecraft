#!/bin/sh
# Пары слотов 29–30 с одним сидом: natural против baseline (try-lab-portal-natural.js). Только 29–30.
#   sh farm/portal-scan/pairs.sh <tag> <минут> <сид1> [сид2 ...]
cd /c/Users/user/Desktop/work/minecraft-claude
TAG=$1; MIN=$2; shift 2
k=0
for S in "$@"; do
  k=$((k+1))
  echo "== пара $k сид $S $(date +%H:%M:%S)"
  node dist/farm/farm.js down 29-30
  ND_PORTAL_NATURAL=1 node dist/farm/farm.js up 2 --from 29 --fresh --seeds $S,$S
  sleep 8
  node dist/farm/farm.js run try-lab-portal-natural.js --slots 29-30 --tag $TAG MODE=pair SWAP=$((k % 2)) MINUTES=$MIN
done
node dist/farm/farm.js down 29-30
echo "== конец $(date +%H:%M:%S)"

#!/bin/sh
# Дракон e2e с трассой боя (ND_DRAGON_TRACE у демона) на слоте фермы, свежий Энд каждый раз:
#   sh dragon-trace.sh <слот> <тег> <попыток> [KEY=VAL ...]
# По умолчанию набор кампании: железо, щит, лук+64, булыжник 64, еда 16, ведро, 6 кроватей, без яблок.
S=$1; TAG=$2; N=${3:-1}; shift 3
cd /c/Users/user/Desktop/work/minecraft-claude
TR=farm/logs/trace-$TAG; mkdir -p $TR
for k in $(seq 1 $N); do
  node dist/farm/farm.js down $S >> farm/logs/$TAG.log 2>&1
  P=$((25600 + S)); for w in $(seq 1 30); do netstat -ano | grep -q ":$P .*LISTENING" || break; sleep 2; done; sleep 5
  rm -rf farm/server-$S/world_the_end
  ND_DRAGON_TRACE="$PWD/$TR" node dist/farm/farm.js up 1 --from $S >> farm/logs/$TAG.log 2>&1
  node dist/farm/farm.js run try-dragon.js --slots $S --tag $TAG-$k E2E=1 E2E_KIT=campaign E2E_BEDS=6 E2E_GAPPLES=0 \
    E2E_OUT="$PWD/farm/logs/$TAG.jsonl" "$@" -- e2e >> farm/logs/$TAG.log 2>&1
done
echo "=== $TAG: конец" >> farm/logs/$TAG.log

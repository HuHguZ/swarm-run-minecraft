#!/bin/sh
# Дракон «только кровати» (режим по умолчанию RPC dragon) на слоте фермы, свежий Энд каждый раз:
#   sh beds-run.sh <слот> <тег> <попыток> [KEY=VAL ...]
# Набор: campaign2 (железо+«Защита II», меч, щит, кирка, лук+64, 128 булыжника, еда 16, 2 ведра,
# 2 золотых яблока) + E2E_BEDS кроватей (по умолчанию 16). Перед каждой попыткой /random reset *.
S=$1; TAG=$2; N=${3:-1}; shift 3
cd /c/Users/user/Desktop/work/minecraft-claude
TR=farm/logs/trace-$TAG; mkdir -p $TR
for k in $(seq 1 $N); do
  node farm/farm.js down $S >> farm/logs/$TAG.log 2>&1
  P=$((25600 + S)); for w in $(seq 1 30); do netstat -ano | grep -q ":$P .*LISTENING" || break; sleep 2; done; sleep 5
  rm -rf farm/server-$S/world_the_end
  ND_DRAGON_TRACE="$PWD/$TR" node farm/farm.js up 1 --from $S >> farm/logs/$TAG.log 2>&1
  for w in 1 2 3 4 5 6; do node farm/farm.js rcon $S "random reset *" >> farm/logs/$TAG.log 2>&1 && break; sleep 5; done
  node farm/farm.js run try-dragon.js --slots $S --tag $TAG-$k E2E=1 E2E_KIT=campaign2 E2E_BEDS=${BEDS:-16} E2E_GAPPLES=2 \
    E2E_MIN=${MIN:-15} E2E_OUT="$PWD/farm/logs/$TAG.jsonl" "$@" -- e2e >> farm/logs/$TAG.log 2>&1
done
node farm/farm.js down $S >> farm/logs/$TAG.log 2>&1
echo "=== $TAG: конец" >> farm/logs/$TAG.log

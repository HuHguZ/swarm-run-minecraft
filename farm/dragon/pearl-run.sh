#!/bin/sh
# Жемчуг с платформы на остров (s5 06.10): мир сида pool21 №1 на слоте, сцена try-dragon-pearl на 750 и на 20 тиках.
#   sh farm/dragon/pearl-run.sh <тег> <слот> [бросков]
TAG=$1; S=$2; N=${3:-6}
cd /c/Users/user/Desktop/work/minecraft-claude
L=farm/logs/$TAG.log; P=$((25600 + S))
SEED=$(sed -n 1p farm/dragon/pool21.txt | tr -d '\r')
node farm/farm.js down $S >> $L 2>&1
for u in $(seq 1 60); do
  node farm/farm.js up 1 --from $S --fresh --seeds $SEED >> $L 2>&1
  netstat -ano | grep -q ":$P .*LISTENING" && break
  echo "up не вышел ($u), жду 30 с" >> $L; sleep 30
done
for R in 750 20; do
  node farm/farm.js run try-dragon-pearl.js --slots $S --tag $TAG-r$R PEARLS=$N PEARL_RATE=$R E2E_OUT="$PWD/farm/logs/$TAG-r$R.jsonl" >> $L 2>&1
done
echo "=== $TAG конец" >> $L

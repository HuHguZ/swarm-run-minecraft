#!/bin/sh
# Серия без пар (01.10): как ab-run.sh, но у каждого слота свой случайный сид (слоты 1..2N).
#   sh pearl-run.sh <тег> <пар N> [KEY=VAL ...]
# Пара i: слот i — ARM_A (по умолчанию ND_PEARL=0), слот i+N — ARM_B (ND_PEARL=1); KEY=VAL через пробел — и демону, и сцене, сид общий (случайный, пишется в $TAG-seeds.txt).
# Набор: campaign2 + BEDS (7) кроватей, без якорей и плачущего, обсидиан 4, PEARLS (5) жемчуга обеим рукам.
TAG=$1; N=$2; shift 2
cd /c/Users/user/Desktop/work/minecraft-claude
TR=farm/logs/trace-$TAG; mkdir -p $TR
: > farm/logs/$TAG-seeds.txt
one () {
  S=$1; ARM=$2; SEED=$3; shift 3
  for kv in $ARM; do export "$kv"; done
  L=farm/logs/$TAG-$S.log
  node dist/farm/farm.js down $S >> $L 2>&1
  P=$((25600 + S)); for w in $(seq 1 30); do netstat -ano | grep -q ":$P .*LISTENING" || break; sleep 2; done; sleep 3
  env $ARM ND_DRAGON_TRACE="$PWD/$TR/s$S" node dist/farm/farm.js up 1 --from $S --fresh --seeds $SEED >> $L 2>&1
  for w in $(seq 1 24); do node dist/farm/farm.js rcon $S "random reset *" > farm/logs/$TAG-rr-$S.txt 2>&1; cat farm/logs/$TAG-rr-$S.txt >> $L; grep -q "Reset" farm/logs/$TAG-rr-$S.txt && break; sleep 5; done; sleep 3
  mkdir -p $TR/s$S; node dist/farm/dragon/rec-dragon.js $S "$PWD/$TR/s$S/rec-1.jsonl" $(( ${MIN:-10} * 60 + 240 )) >> $L 2>&1 &
  RP=$!
  # сцена не поднялась («бот не в игре» под нагрузкой фермы) — ещё раз, пока итога нет (до 3 раз)
  for try in 1 2 3; do
  [ -s farm/logs/$TAG-s$S.jsonl ] && break
  [ $try -gt 1 ] && { env $ARM ND_DRAGON_TRACE="$PWD/$TR/s$S" node dist/farm/farm.js daemons $S >> $L 2>&1; sleep 10; }
  env $ARM node dist/farm/farm.js run try-dragon.js --slots $S --tag $TAG-s$S E2E=1 E2E_KIT=campaign2 E2E_BEDS=${BEDS:-7} E2E_ANCHORS=${ANCHORS:-0} \
    E2E_OBSIDIAN=${OBSIDIAN:-4} E2E_CRYING=0 E2E_PEARLS=${PEARLS:-5} E2E_GAPPLES=2 E2E_MIN=${MIN:-10} \
    E2E_OUT="$PWD/farm/logs/$TAG-s$S.jsonl" "$@" -- e2e >> $L 2>&1
  done
  kill $RP 2>/dev/null
  node dist/farm/farm.js down $S >> $L 2>&1
}
for i in $(seq 1 $N); do
  SEED=$(node -e "console.log(String(Math.floor(Math.random()*9e15)-4e15))"); SEED2=$(node -e "console.log(String(Math.floor(Math.random()*9e15)-4e15))")
  echo "$i $SEED $SEED2" >> farm/logs/$TAG-seeds.txt
  one $i "${ARM_A:-ND_PEARL=0}" $SEED "$@" &
  sleep 2
  one $((i + N)) "${ARM_B:-ND_PEARL=1}" $SEED2 "$@" &
  sleep 2
done
wait
echo "=== $TAG: конец" >> farm/logs/$TAG-seeds.txt

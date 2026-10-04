#!/bin/sh
# Серия боёв по раундам на своих слотах (02.10, поток dragon): у каждого боя свой случайный сид, слоты не простаивают.
#   sh farm/dragon/r-run.sh <тег> <слот_от> <слот_до> <раундов> [KEY=VAL ...]
# ARM — env демона и сцены (по умолчанию ND_RUNNER=1). Бой k = (раунд−1)·nслотов + номер слота в диапазоне (1..):
#   итог farm/logs/<тег>-s<k>.jsonl, трасса farm/logs/trace-<тег>/s<k>/, сиды — <тег>-seeds.txt.
# Набор: campaign2 + BEDS (4) кроватей, без якорей, обсидиан 4, PEARLS (5) жемчуга, MIN (10) минут на бой.
# Сводка: node farm/dragon/an-r.js <тег>; LABPLUG=1 — плагин-свидетель DragonLab, события — trace-<тег>/s<k>/lab-ev.jsonl
TAG=$1; A=$2; B=$3; R=$4; shift 4
cd /c/Users/user/Desktop/work/minecraft-claude
TR=farm/logs/trace-$TAG; mkdir -p $TR
ARM=${ARM:-ND_RUNNER=1}
NS=$((B - A + 1))
touch farm/logs/$TAG-seeds.txt
fight () {
  S=$1; K=$2; SEED=$3; shift 3
  L=farm/logs/$TAG-$K.log
  echo "бой $K слот $S сид $SEED $(date +%H:%M:%S)" >> $L
  node farm/farm.js down $S >> $L 2>&1
  P=$((25600 + S)); for w in $(seq 1 30); do netstat -ano | grep -q ":$P .*LISTENING" || break; sleep 2; done; sleep 3
  # LABPLUG=1 — свидетель сервера DragonLab (только наблюдает): взрывы, seen родителя, позы головы; события боя — в трассу
  [ -n "$LABPLUG" ] && { cp farm/dragon/lab-plugin/DragonLab.jar farm/server-$S/plugins/ 2>/dev/null; rm -f farm/server-$S/plugins/DragonLab/events.jsonl; }
  env $ARM ND_DRAGON_TRACE="$PWD/$TR/s$K" node farm/farm.js up 1 --from $S --fresh --seeds $SEED >> $L 2>&1
  for w in $(seq 1 24); do node farm/farm.js rcon $S "random reset *" > farm/logs/$TAG-rr-$K.txt 2>&1; cat farm/logs/$TAG-rr-$K.txt >> $L; grep -q "Reset" farm/logs/$TAG-rr-$K.txt && break; sleep 5; done; sleep 3
  mkdir -p $TR/s$K; node farm/dragon/rec-dragon.js $S "$PWD/$TR/s$K/rec-1.jsonl" $(( ${MIN:-10} * 60 + 240 )) >> $L 2>&1 &
  RP=$!
  for try in 1 2 3; do
  [ -s farm/logs/$TAG-s$K.jsonl ] && break
  [ $try -gt 1 ] && { env $ARM ND_DRAGON_TRACE="$PWD/$TR/s$K" node farm/farm.js daemons $S >> $L 2>&1; sleep 10; }
  env $ARM node farm/farm.js run try-dragon.js --slots $S --tag $TAG-s$K E2E=1 E2E_KIT=campaign2 E2E_BEDS=${BEDS:-4} E2E_ANCHORS=${ANCHORS:-0} \
    E2E_OBSIDIAN=${OBSIDIAN:-4} E2E_CRYING=0 E2E_PEARLS=${PEARLS:-5} E2E_GAPPLES=2 E2E_MIN=${MIN:-10} \
    E2E_OUT="$PWD/farm/logs/$TAG-s$K.jsonl" "$@" -- e2e >> $L 2>&1
  done
  kill $RP 2>/dev/null
  [ -n "$LABPLUG" ] && cp farm/server-$S/plugins/DragonLab/events.jsonl $TR/s$K/lab-ev.jsonl 2>/dev/null
}
lane () {
  S=$1; I=$2; shift 2
  for r in $(seq 1 $R); do
    K=$(( (r - 1) * NS + I ))
    SEED=$(node -e "console.log(String(Math.floor(Math.random()*9e15)-4e15))")
    echo "$K $S $SEED" >> farm/logs/$TAG-seeds.txt
    fight $S $K $SEED "$@"
  done
  node farm/farm.js down $S >> farm/logs/$TAG-down.log 2>&1
}
for S in $(seq $A $B); do
  lane $S $((S - A + 1)) "$@" &
  sleep 3
done
wait
echo "=== $TAG: конец $(date +%H:%M:%S)" >> farm/logs/$TAG-seeds.txt

#!/bin/sh
# Серия боёв по раундам на своих слотах (02.10 19:20, поток dragon): сиды — фиксированный список из пула хороших сидов
# (farm/dragon/pool21.txt — 21 сид good-v2 с проверенной лавой; бой k берёт k-й сид, серии сравнимы попарно), keep_inventory=false.
#   sh farm/dragon/r-run3.sh <тег> <слот_от> <слот_до> <раундов> [KEY=VAL ...]
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
  # лимит миров общий на все потоки (s5 06.10): пока слот занят чужим миром — ждать и повторять, не идти дальше без сервера
  for u in $(seq 1 60); do
    env $ARM ND_DRAGON_TRACE="$PWD/$TR/s$K" node farm/farm.js up 1 --from $S --fresh --seeds $SEED >> $L 2>&1
    netstat -ano | grep -q ":$P .*LISTENING" && break
    echo "up не вышел ($u), жду 30 с" >> $L; sleep 30
  done
  for w in $(seq 1 24); do node farm/farm.js rcon $S "random reset *" > farm/logs/$TAG-rr-$K.txt 2>&1; cat farm/logs/$TAG-rr-$K.txt >> $L; grep -q "Reset" farm/logs/$TAG-rr-$K.txt && break; sleep 5; done; sleep 3
  mkdir -p $TR/s$K
  # HANGWATCH=1 (s5c 06.10) — сторож зависания демона на бой (профиль CPU через инспектор, если в ARM есть NODE_OPTIONS=--inspect)
  HW=; [ -n "$HANGWATCH" ] && { node farm/dragon/hang-watch.js $S "$PWD/$TR/s$K" $(( ${MIN:-10} * 60 + 600 )) >> $L 2>&1 & HW=$!; }
  node farm/dragon/rec-dragon.js $S "$PWD/$TR/s$K/rec-1.jsonl" $(( ${MIN:-10} * 60 + 240 )) >> $L 2>&1 &
  RP=$!
  for try in 1 2 3; do
  [ -s farm/logs/$TAG-s$K.jsonl ] && break
  [ $try -gt 1 ] && { env $ARM ND_DRAGON_TRACE="$PWD/$TR/s$K" node farm/farm.js daemons $S >> $L 2>&1; sleep 10; }
  env $ARM node farm/farm.js run try-dragon.js --slots $S --tag $TAG-s$K E2E=1 E2E_KIT=campaign2 E2E_BEDS=${BEDS:-4} E2E_ANCHORS=${ANCHORS:-0} \
    E2E_OBSIDIAN=${OBSIDIAN:-4} E2E_CRYING=0 E2E_PEARLS=${PEARLS:-5} E2E_GAPPLES=2 E2E_MIN=${MIN:-10} \
    E2E_OUT="$PWD/farm/logs/$TAG-s$K.jsonl" "$@" -- e2e >> $L 2>&1 &
  # сторож реального времени (s5 06.10: бой встал навсегда — титры после портала): WALLMAX (900) с — оборвать сцену
  WP=$!; for w in $(seq 1 ${WALLMAX:-900}); do kill -0 $WP 2>/dev/null || break; sleep 1; done
  kill -0 $WP 2>/dev/null && { echo "сцена дольше ${WALLMAX:-900} с — обрываю" >> $L; node farm/farm.js kill-runs $TAG-s$K >> $L 2>&1; kill $WP 2>/dev/null; break; }
  wait $WP 2>/dev/null
  done
  kill $RP 2>/dev/null
  [ -n "$HW" ] && kill $HW 2>/dev/null
  [ -n "$LABPLUG" ] && cp farm/server-$S/plugins/DragonLab/events.jsonl $TR/s$K/lab-ev.jsonl 2>/dev/null
  # лог демона и сервера боя (s5 06.10: следующий up их затирает)
  cp farm/daemon-$S.out.log $TR/s$K/daemon.out.log 2>/dev/null; cp farm/daemon-$S.err.log $TR/s$K/daemon.err.log 2>/dev/null; cp farm/server-$S/logs/latest.log $TR/s$K/server.log 2>/dev/null
}
lane () {
  S=$1; I=$2; shift 2
  for r in $(seq 1 $R); do
    K=$(( (r - 1) * NS + I ))
    PF=${POOL:-farm/dragon/pool21.txt}; PN=$(grep -c . $PF)
    SEED=$(sed -n "$(( (K - 1) % PN + 1 ))p" $PF | tr -d '\r')
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

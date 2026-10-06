#!/bin/sh
# Профиль CPU демона в одном бою (s5 06.10): r-run3 с инспектором (порт 0 — свой у каждого процесса node), профиль
# снимается с демона слота, пока идёт сцена.  sh farm/dragon/prof-fight.sh <тег> <слот> <сек профиля> [KEY=VAL ...]
TAG=$1; S=$2; SECS=$3; shift 3
cd /c/Users/user/Desktop/work/minecraft-claude
OUT=farm/logs/trace-$TAG/prof.cpuprofile; mkdir -p farm/logs/trace-$TAG
( for w in $(seq 1 300); do
    [ -s farm/results/$TAG-s1/slot-$S.out ] && grep -q "e2e" farm/results/$TAG-s1/slot-$S.out && break; sleep 1; done
  URL=$(grep -o 'ws://127.0.0.1:[0-9]*/[-0-9a-f]*' farm/daemon-$S.err.log | tail -1)
  PORT=$(echo "$URL" | sed 's#ws://127.0.0.1:\([0-9]*\)/.*#\1#')
  echo "профиль: порт $PORT" >> farm/logs/$TAG-1.log
  node farm/dragon/cdp-prof.js $PORT $SECS $OUT >> farm/logs/$TAG-1.log 2>&1 ) &
ARM="ND_RUNNER=1 NODE_OPTIONS=--inspect=127.0.0.1:0" sh farm/dragon/r-run3.sh $TAG $S $S 1 "$@"
wait

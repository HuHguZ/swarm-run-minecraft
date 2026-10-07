#!/bin/sh
# S8c: дождаться конца серии $AFTER в цепочке A, остановить цепочку A и пустить цепочку B на том же мире.
cd "$(dirname "$0")/../.." || exit 1
until grep -q "серия $AFTER кончилась" farm/logs/s8c-chainA.log; do sleep 3; done
for p in $(ps -ef | grep -v grep | grep -E "s8c-chainA|s8c-cycle.sh 8 s8c-a" | awk '{print $2}'); do kill $p 2>/dev/null; done
sleep 2
nxt=$(ls -d farm/results/s8c-a-* 2>/dev/null | grep -v "$AFTER" | while read d; do [ -f "$d/slot-8.jsonl" ] || echo "$d"; done)
for d in $nxt; do node farm/farm.js kill-runs "$(basename $d)" > /dev/null 2>&1; mkdir -p farm/results/_s8c-broken; mv "$d"* farm/results/_s8c-broken/ 2>/dev/null; done
echo "[$(date +%H:%M:%S)] цепочка A остановлена после $AFTER, запускаю B: CODE=$CODE P=$P LINES=$LINES"
exec sh farm/route-scan/s8c-chain.sh

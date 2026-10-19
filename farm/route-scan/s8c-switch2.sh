#!/bin/sh
# S8c: дождаться конца прогона $AFTER (файл итога), остановить текущую цепочку ($KILL — шаблон процессов) и пустить новую.
cd "$(dirname "$0")/../.." || exit 1
until [ -f "farm/results/$AFTER/slot-8.jsonl" ]; do sleep 3; done
for p in $(ps -ef | grep -v grep | grep -E "$KILL" | awk '{print $2}'); do [ "$p" = "$$" ] || kill $p 2>/dev/null; done
sleep 2
for d in $(ls -d farm/results/$PREV-* 2>/dev/null); do [ -d "$d" ] && [ ! -f "$d/slot-8.jsonl" ] && { node dist/farm/farm.js kill-runs "$(basename $d)" > /dev/null 2>&1; mkdir -p farm/results/_s8c-broken; mv "$d" farm/results/_s8c-broken/; mv "$d.run.log" farm/results/_s8c-broken/ 2>/dev/null; }; done
echo "[$(date +%H:%M:%S)] остановлено после $AFTER, запускаю: CODE=$CODE P=$P LINES=$LINES"
exec sh farm/route-scan/s8c-chain.sh

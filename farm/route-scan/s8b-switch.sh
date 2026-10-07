#!/bin/sh
# S8b: после s8b-b2-16 — остановить цепочку 2 (первый повтор B2 готов) и сразу пустить цепочку 3 (C) на том же мире.
cd "$(dirname "$0")/../.." || exit 1
until [ -f farm/results/s8b-b2-16/slot-8.jsonl ]; do sleep 3; done
for p in $(ps -ef | grep -v grep | grep -E "s8b-chain2|s8b-cycle.sh 8 s8b-b2" | awk '{print $2}'); do kill $p 2>/dev/null; done
sleep 2
if [ -d farm/results/s8b-b2-17 ]; then node farm/farm.js kill-runs s8b-b2-17; mkdir -p farm/results/_s8b-broken; mv farm/results/s8b-b2-17* farm/results/_s8b-broken/; fi
echo "[$(date +%H:%M:%S)] цепочка 2 остановлена после s8b-b2-16, запускаю цепочку 3"
exec sh farm/route-scan/s8b-chain3.sh

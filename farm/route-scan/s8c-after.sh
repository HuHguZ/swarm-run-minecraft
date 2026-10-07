#!/bin/sh
# S8c: после итоговой цепочки G — второй повтор базы A «известный сид» (снимок s8c-a), тот же слот 8.
cd "$(dirname "$0")/../.." || exit 1
until grep -q "серия s8c-g-b1 кончилась" farm/logs/s8c-chainG.log; do sleep 5; done
echo "[$(date +%H:%M:%S)] G кончилась — база A, «известный сид» ×2-й"
CODE=s8c-a P=s8c-a LINES="s2" exec sh farm/route-scan/s8c-chain.sh

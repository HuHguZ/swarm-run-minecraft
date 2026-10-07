#!/bin/sh
# S8b: контроль итогового дерева (снимок s8b-d = s8b-c + «дерево: кирка есть — рощи не искать», WALKBLOCKS выкл. по умолчанию),
# 16 сидов × 1, 20 мин, после цепочки 3 (тот же мир, --reup), мир гасится в конце.
cd "$(dirname "$0")/../.." || exit 1
until grep -q "серия s8b-v1 кончилась" farm/logs/s8b-chain3.log; do sleep 2; done
SEEDS=$(cat farm/route-scan/s8b-seeds.txt)
MINUTES=20 sh farm/route-scan/s8b-cycle.sh 8 s8b-d s8b-d "$SEEDS" ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1

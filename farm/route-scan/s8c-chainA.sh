#!/bin/sh
# S8c: база A на снимке s8c-a (= дерево 07.10 ~09:10 + уровни знания карты ND_MAP), один мир (слот 8, --lockstep, --reup),
# 16 сидов S8b, окно 20 мин. Порядок: постройки+лава ×1 → вслепую ×1 → блоки скана ×1 → постройки+лава ×1 (второй повтор).
cd "$(dirname "$0")/../.." || exit 1
SEEDS=$(cat farm/route-scan/s8b-seeds.txt)
CODE=${CODE:-s8c-a}; P=${P:-s8c-a}
STRUCT="ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1 ND_MAP=struct"
BLOCKS="ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1 ND_MAP=blocks"
BLIND="ND_OW_DEEP=1 ND_PORTAL_NATURAL=1 ND_MAP=0"
KEEP_SLOT=1 MINUTES=20 sh farm/route-scan/s8c-cycle.sh 8 $P-s1 $CODE "$SEEDS" $STRUCT $EXTRA
KEEP_SLOT=1 MINUTES=20 sh farm/route-scan/s8c-cycle.sh 8 $P-v1 $CODE "$SEEDS" $BLIND $EXTRA
KEEP_SLOT=1 MINUTES=20 sh farm/route-scan/s8c-cycle.sh 8 $P-b1 $CODE "$SEEDS" $BLOCKS $EXTRA
MINUTES=20 sh farm/route-scan/s8c-cycle.sh 8 $P-s2 $CODE "$SEEDS" $STRUCT $EXTRA

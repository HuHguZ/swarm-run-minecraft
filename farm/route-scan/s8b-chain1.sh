#!/bin/sh
# S8b: цепочка на одном мире (слот 8, --reup между частями): лаборатория литья на s8b-b0 → добор базы s8b-a1 (s8b-a) →
# серия B (снимок s8b-b, 16 сидов × 2, 20 мин) → вторая база s8b-a2 (s8b-a, 20 мин) → вслепую s8b-v1 (s8b-b, ND_MAP=0).
cd "$(dirname "$0")/../.." || exit 1
SEEDS=$(cat farm/route-scan/s8b-seeds.txt)
MAP="ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1"
sh farm/route-scan/s8b-lab.sh s8b-b0 s8b-c1b TRIALS=2 POOL=shift,shore,flat,low,grass,cave,bowl
KEEP_SLOT=1 sh farm/route-scan/s8b-cycle.sh 8 s8b-a1 s8b-a "$SEEDS" $MAP
until [ -f .daemon-s8b-b/SNAPSHOT.json ] || [ -f farm/logs/s8b-STOP ]; do sleep 10; done
KEEP_SLOT=1 MINUTES=20 sh farm/route-scan/s8b-cycle.sh 8 s8b-b s8b-b "$SEEDS,$SEEDS" $MAP
KEEP_SLOT=1 MINUTES=20 sh farm/route-scan/s8b-cycle.sh 8 s8b-a2 s8b-a "$SEEDS" $MAP
MINUTES=20 sh farm/route-scan/s8b-cycle.sh 8 s8b-v1 s8b-b "$SEEDS" ND_OW_DEEP=1 ND_PORTAL_NATURAL=1 ND_MAP=0

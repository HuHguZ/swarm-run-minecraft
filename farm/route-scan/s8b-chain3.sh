#!/bin/sh
# S8b: цепочка на одном мире (слот 8, --reup): C (снимок s8b-c, 16 сидов × 2, 20 мин) → вторая база s8b-a2 (s8b-a, 20 мин) →
# вслепую s8b-v1 (s8b-c, ND_MAP=0, без ND_ROUTE и MAP_LAVA).
cd "$(dirname "$0")/../.." || exit 1
SEEDS=$(cat farm/route-scan/s8b-seeds.txt)
MAP="ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1"
MAPC="$MAP ND_ROUTE_WALKBLOCKS=0"
KEEP_SLOT=1 MINUTES=20 sh farm/route-scan/s8b-cycle.sh 8 s8b-c s8b-c "$SEEDS,$SEEDS" $MAPC
KEEP_SLOT=1 MINUTES=20 sh farm/route-scan/s8b-cycle.sh 8 s8b-a2 s8b-a "$SEEDS" $MAP
MINUTES=20 sh farm/route-scan/s8b-cycle.sh 8 s8b-v1 s8b-c "$SEEDS" ND_OW_DEEP=1 ND_PORTAL_NATURAL=1 ND_MAP=0 ND_ROUTE_WALKBLOCKS=0

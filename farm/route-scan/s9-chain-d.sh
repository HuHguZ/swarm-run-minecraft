#!/bin/sh
# S9: снимок s9-d (срез A* 120 узлов): профиль маршрута ND_S9=1, затем A/B s9-ab4 (6 сидов × 2). Слот 19, гасится в конце.
cd "$(dirname "$0")/../.." || exit 1
sh farm/route-scan/s9-prof.sh 19 s9-prof2 s9-d 959549910934800019 1 ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1 ND_MAP=struct
SEEDS=$(cut -d, -f1-6 farm/route-scan/s8b-seeds.txt)
sh farm/route-scan/s9-ab.sh 19 s9-ab4 s9-d "$SEEDS" ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1 ND_MAP=struct
echo "[$(date +%H:%M:%S)] цепочка s9-d кончилась"

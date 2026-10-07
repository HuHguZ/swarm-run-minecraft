#!/bin/sh
# S9: уступить окно S10 (COORD 10:44): ждать, пока слот 12 (S10) поднимется и погаснет, затем цепочка S9 на слоте 19.
cd "$(dirname "$0")/../.." || exit 1
up12 () { netstat -ano -p TCP | grep LISTENING | grep -c "0.0.0.0:25612 "; }
until [ "$(up12)" -ge 1 ]; do sleep 20; done
echo "[$(date +%H:%M:%S)] S10 взял слот 12 — жду, пока погасит"
until [ "$(up12)" -eq 0 ]; do sleep 20; done
echo "[$(date +%H:%M:%S)] слот 12 погашен — цепочка S9"
sh farm/route-scan/s9-prof.sh 19 s9-prof1 s9-c 959549910934800019 1 ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1 ND_MAP=struct
SEEDS=$(cut -d, -f1-6 farm/route-scan/s8b-seeds.txt)
sh farm/route-scan/s9-ab.sh 19 s9-ab3 s9-c "$SEEDS" ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1 ND_MAP=struct
bash farm/route-scan/s9-stress.sh 19 s9-c 2
echo "[$(date +%H:%M:%S)] цепочка S9 кончилась"

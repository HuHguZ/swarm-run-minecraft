#!/bin/sh
# После скана 0–100: пары на первых 6 сидах пула, потом скан 100–300.
cd /c/Users/user/Desktop/work/minecraft-claude
until grep -q "== конец" farm/portal-scan/pool-1.log; do sleep 15; done
node farm/portal-scan/pool-merge.js
sh farm/portal-scan/pairs.sh pn-pool 10 2911374257081450067 5647002953211837822 -8877121381267541911 6162616963942616824 -4332886356280409547 -5289050370803891447
sh farm/portal-scan/pool.sh 100 300
node farm/portal-scan/pool-merge.js

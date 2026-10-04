#!/bin/sh
# Пары на 6 первых сидах пула (исправленный run), потом скан пула 100–300 и сборка good-v2.json.
cd /c/Users/user/Desktop/work/minecraft-claude
sh farm/portal-scan/pairs.sh pn-pool 10 2911374257081450067 5647002953211837822 -8877121381267541911 6162616963942616824 -4332886356280409547 -5289050370803891447
sh farm/portal-scan/pool.sh 100 300
node farm/portal-scan/pool-merge.js

#!/bin/sh
# 02.10 вечер (агент G): заходы литья до 30 (предел — время и стороны), без прироста 4 захода — другая сторона; сцена
# пишет hpDrops. hint на −1438 (урон −10 HP разом — где?) и 8388 (мангры, заходы кончились), потом скан пула и merge.
cd /c/Users/user/Desktop/work/minecraft-claude
sh farm/portal-scan/hint.sh pn-hint4 10 -1438498926029987630 8388397891651367710
sh farm/portal-scan/pool.sh 100 300
node farm/portal-scan/pool-merge.js

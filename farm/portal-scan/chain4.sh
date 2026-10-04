#!/bin/sh
# 02.10 вечер (агент G, после обрыва): natural с подсказкой (hint) на сидах пула с видимой лавой; пары natural (лучи мимо
# воды, высота вместо столба) против baseline на 6 сидах пула (keep_inventory=false); скан пула 100–300 и merge.
cd /c/Users/user/Desktop/work/minecraft-claude
sh farm/portal-scan/hint.sh pn-hint 10 -1438498926029987630 2911374257081450067 5647002953211837822 6162616963942616824 -955261348487910180 2631719127963822673 3432579183344257717 8388397891651367710
sh farm/portal-scan/pairs.sh pn-v3 10 -1438498926029987630 7220656985006407029 2631719127963822673 -955261348487910180 3432579183344257717 8388397891651367710
sh farm/portal-scan/pool.sh 100 300
node farm/portal-scan/pool-merge.js

#!/bin/sh
# 02.10 вечер (агент G): hint на окончательном коде (после пар pn-v3) — 8 сидов пула с видимой лавой, потом скан пула
# 100–300 и merge.
cd /c/Users/user/Desktop/work/minecraft-claude
sh farm/portal-scan/hint.sh pn-hint3 10 -1438498926029987630 2911374257081450067 5647002953211837822 6162616963942616824 -955261348487910180 2631719127963822673 3432579183344257717 8388397891651367710
sh farm/portal-scan/pool.sh 100 300
node dist/farm/portal-scan/pool-merge.js

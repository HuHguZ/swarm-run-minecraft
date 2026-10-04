#!/bin/sh
# После batch1 (pn-rand + pn-rp): первые две пары pn-rand шли до 16:19 (старый goto/мост) — перемерить на новом коде.
cd /c/Users/user/Desktop/work/minecraft-claude
until [ "$(grep -c '== конец' farm/portal-scan/batch2.log)" -ge 2 ]; do sleep 20; done
sh farm/portal-scan/pairs.sh pn-rand2 10 -1614298337981879516 4307605278284484928

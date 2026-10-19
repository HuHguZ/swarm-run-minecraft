#!/bin/sh
# Скан копий миров для списка сидов (поток route): партиями по 16 на своих слотах (8–20 ← до 13 сидов, 27–29 ← до 3),
# свежие миры, gen+scan параллельно (scan-par.sh); в конце слоты опускаются.
#   sh farm/route-scan/scan-list.sh <файл сидов через запятую>
cd /c/Users/user/Desktop/work/minecraft-claude
ALL=$(cat "$1" | tr -d '\r\n')
N=$(echo "$ALL" | tr ',' '\n' | grep -c .)
i=1
while [ $i -le $N ]; do
  node dist/farm/farm.js down 8-20,27-29 > /dev/null 2>&1
  A_END=$((i + 12)); [ $A_END -gt $N ] && A_END=$N
  A=$(echo "$ALL" | cut -d, -f$i-$A_END); NA=$((A_END - i + 1))
  node dist/farm/farm.js up $NA --from 8 --fresh --seeds $A 2>&1 | grep -c "✓"
  SPEC="8-$((7 + NA))"
  i=$((A_END + 1))
  if [ $i -le $N ]; then
    B_END=$((i + 2)); [ $B_END -gt $N ] && B_END=$N
    B=$(echo "$ALL" | cut -d, -f$i-$B_END); NB=$((B_END - i + 1))
    node dist/farm/farm.js up $NB --from 27 --fresh --seeds $B 2>&1 | grep -c "✓"
    SPEC="$SPEC,27-$((26 + NB))"
    i=$((B_END + 1))
  fi
  sh farm/route-scan/scan-par.sh "$SPEC"
done
node dist/farm/farm.js down 8-20,27-29 > /dev/null 2>&1
echo "== скан списка готов $(date +%H:%M:%S)"

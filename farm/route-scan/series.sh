#!/bin/sh
# Серия «новый мир → вход в Ад» потока route на своих 16 слотах (8–20, 27–29), сиды — из файла (16 через запятую).
#   sh farm/route-scan/series.sh <tag> <файл сидов> [KEY=VAL ...]
#   ROUTE_SLOTS=8,9 — выбранные слоты коллектора; без переменной сохраняется исходная серия из 16.
# Свежие миры (--fresh) с сидами по порядку: слоты 8..20 ← сиды 1..13, 27..29 ← 14..16. Сцена try-lab-fresh.js
# (сама: /random reset, keep_inventory=false, утро 1000), 30 мин, смерть = провал (DEATHS_MAX=1), маршрут ND_ROUTE=1.
# После серии слоты остаются поднятыми (следующая серия сама опустит).
cd /c/Users/user/Desktop/work/minecraft-claude || exit 1
TAG=$1; SEEDS=$(cat "$2" | tr -d '\r\n'); shift 2
SLOTS=${ROUTE_SLOTS:-8-20,27-29}
echo "== $TAG $(date +%H:%M:%S): опускаю $SLOTS"
node dist/farm/farm.js down "$SLOTS" 2>&1 | tail -1
if [ -n "$ROUTE_SLOTS" ]; then
  i=0
  for s in $(echo "$ROUTE_SLOTS" | tr ',' ' '); do
    i=$((i+1)); seed=$(echo "$SEEDS" | cut -d, -f"$i")
    node dist/farm/farm.js up 1 --from "$s" --fresh --seed "$seed" 2>&1 | grep -c "✓"
  done
else
  A=$(echo "$SEEDS" | cut -d, -f1-13); B=$(echo "$SEEDS" | cut -d, -f14-16)
  node dist/farm/farm.js up 13 --from 8 --fresh --seeds "$A" 2>&1 | grep -c "✓"
  node dist/farm/farm.js up 3 --from 27 --fresh --seeds "$B" 2>&1 | grep -c "✓"
fi
CPU=$(powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average")
echo "== $TAG $(date +%H:%M:%S): CPU $CPU %, старт сцены"
node dist/farm/farm.js run try-lab-fresh.js --slots "$SLOTS" --tag $TAG UNTIL=nether MINUTES=30 DEATHS_MAX=1 ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1 "$@" > farm/results/$TAG.run.log 2>&1
echo "== $TAG $(date +%H:%M:%S): конец"
node dist/farm/route-scan/report.js $TAG

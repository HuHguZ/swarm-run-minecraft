#!/bin/sh
# Серия «новый мир → вход в Ад» потока route на своих 16 слотах (8–20, 27–29), сиды — из файла (16 через запятую).
#   sh farm/route-scan/series.sh <tag> <файл сидов> [KEY=VAL ...]
# Свежие миры (--fresh) с сидами по порядку: слоты 8..20 ← сиды 1..13, 27..29 ← 14..16. Сцена try-lab-fresh.js
# (сама: /random reset, keep_inventory=false, утро 1000), 30 мин, смерть = провал (DEATHS_MAX=1), маршрут ND_ROUTE=1.
# После серии слоты остаются поднятыми (следующая серия сама опустит).
cd /c/Users/user/Desktop/work/minecraft-claude
TAG=$1; SEEDS=$(cat "$2" | tr -d '\r\n'); shift 2
A=$(echo $SEEDS | cut -d, -f1-13); B=$(echo $SEEDS | cut -d, -f14-16)
echo "== $TAG $(date +%H:%M:%S): опускаю 8-20,27-29"
node farm/farm.js down 8-20,27-29 2>&1 | tail -1
node farm/farm.js up 13 --from 8 --fresh --seeds $A 2>&1 | grep -c "✓"
node farm/farm.js up 3 --from 27 --fresh --seeds $B 2>&1 | grep -c "✓"
CPU=$(powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average")
echo "== $TAG $(date +%H:%M:%S): CPU $CPU %, старт сцены"
node farm/farm.js run try-lab-fresh.js --slots 8-20,27-29 --tag $TAG UNTIL=nether MINUTES=30 DEATHS_MAX=1 ND_OW_DEEP=1 MAP_LAVA=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1 "$@" > farm/results/$TAG.run.log 2>&1
echo "== $TAG $(date +%H:%M:%S): конец"
node farm/route-scan/report.js $TAG

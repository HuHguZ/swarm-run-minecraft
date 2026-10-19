#!/bin/bash
# Причинная проверка правок r5 маршрута (Codex, codex-lab/r5-route/REPORT.md): на 32 общих сидах с rt3-A7/V4
# (codex-lab/r5-route/matched-seeds-{1,2}.txt) режимы 11 — обе правки (бюджет построек + злость голема), 00 — обе выкл.
# (поведение r4), 10 — только бюджет. Слоты 8–20, 27–29 (farm/route-scan/series.sh). Серия не начинается, если не успевает
# к сроку. Флаги — и в окружение (демон: голем в fauna.js), и в env сцены (кампания: бюджет в route.js).
#   bash farm/series/r5-route-check.sh <ЧЧ:ММ> [метка]       мягкий стоп: touch farm/logs/collect/STOP
cd /c/Users/user/Desktop/work/minecraft-claude || exit 1
UNTIL=$1; TAG=${2:-r5c}
D=farm/logs/collect; mkdir -p "$D"
now () { echo $(( 10#$(date +%H) * 60 + 10#$(date +%M) )); }
END=$(( 10#${UNTIL%:*} * 60 + 10#${UNTIL#*:} ))
say () { echo "[$(date +%H:%M:%S)] $*"; }
for run in 1-11 1-00 2-11 2-00 1-10 2-10; do
  part=${run%-*}; mode=${run#*-}
  if [ -f "$D/STOP" ] || [ $(( $(now) + 36 )) -gt $END ]; then say "стоп перед $TAG-$part-$mode"; break; fi
  export ND_ROUTE_STRUCTURE_BUDGET=${mode:0:1} ND_GOLEM_ANGER=${mode:1:1}
  say "серия $TAG-$part-$mode (бюджет $ND_ROUTE_STRUCTURE_BUDGET, голем $ND_GOLEM_ANGER)"
  sh farm/route-scan/series.sh "$TAG-$part-$mode" "codex-lab/r5-route/matched-seeds-$part.txt" \
    "ND_ROUTE_STRUCTURE_BUDGET=$ND_ROUTE_STRUCTURE_BUDGET" "ND_GOLEM_ANGER=$ND_GOLEM_ANGER"
done
say "маршрут: опускаю 8-20,27-29"
node dist/farm/farm.js down 8-20,27-29 > /dev/null 2>&1

#!/bin/bash
# Сбор логов прохождения до срока (пользователь 04.10): два потока циклами, без агентов.
#   route  — слоты 8–20, 27–29: «новый мир → Ад» (farm/route-scan/series.sh), сиды с полным сканом v6, по 16 за цикл;
#   nether — слоты 1–7, 21–26, 30–32: «вход в Ад → Энд» (farm/ne-series.sh, try-lab-ne-run.js), сиды пула good-v2.
# Циклы чередуют плечи на ОДНИХ сидах (циклы 2m-1 и 2m — один блок из 16): a — умолчания кода, b — флаги-кандидаты r4 (маршрут: ускорения route-speed; Ад: ND_BARTER_FLOW=1).
# Новый цикл не начинается, если не успевает к сроку. В конце все слоты опускаются.
#   bash farm/collect.sh <ЧЧ:ММ> [метка]      мягкий стоп: touch farm/logs/collect/STOP (текущие циклы доиграют)
# Итоги: farm/logs/collect/<метка>.log, серии — farm/results/<метка>-rt<k><a|b>/ и farm/results/neF-<метка>N<k><a|b>x<слот>-1/.
cd /c/Users/user/Desktop/work/minecraft-claude || exit 1
UNTIL=$1; TAG=${2:-col}
D=farm/logs/collect; mkdir -p "$D"; rm -f "$D/STOP"
now () { echo $(( 10#$(date +%H) * 60 + 10#$(date +%M) )); }
END=$(( 10#${UNTIL%:*} * 60 + 10#${UNTIL#*:} ))
ok () { [ ! -f "$D/STOP" ] && [ $(( $(now) + $1 )) -le $END ]; }
say () { echo "[$(date +%H:%M:%S)] $*"; }

# Сиды маршрута: только с полным сканом копии (gravelBuried), перемешаны, по кругу.
node -e '
const fs = require("fs"), p = "farm/route-scan/"
const s = fs.readdirSync(p).filter(f => /^-?\d+\.json$/.test(f) && /"gravelBuried"/.test(fs.readFileSync(p + f, "utf8"))).map(f => f.slice(0, -5))
let h = 7; const r = () => (h = (h * 1103515245 + 12345) % 2147483648) / 2147483648
for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [s[i], s[j]] = [s[j], s[i]] }
fs.writeFileSync(process.argv[1], s.join("\n") + "\n")' "$D/$TAG-route-seeds.txt"
# Сиды Ада: пул good-v2 (лава не false), перемешан.
node -e '
const fs = require("fs")
const s = require("./farm/seeds/good-v2.json").seeds.filter(x => x.lava !== false).map(x => String(x.seed))
let h = 11; const r = () => (h = (h * 1103515245 + 12345) % 2147483648) / 2147483648
for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [s[i], s[j]] = [s[j], s[i]] }
fs.writeFileSync(process.argv[1], s.join("\n") + "\n")' "$D/$TAG-nether-seeds.txt"

route_loop () {
  local k=0 arm n
  n=$(wc -l < "$D/$TAG-route-seeds.txt")
  while ok 36; do
    k=$((k + 1)); arm=$([ $((k % 2)) -eq 1 ] && echo a || echo b)
    awk -v k=$k -v n="$n" '{a[NR]=$0} END {b = int((k-1)/2); for (i = 0; i < 16; i++) printf "%s%s", a[(b*16+i)%n+1], (i < 15 ? "," : "\n")}' \
      "$D/$TAG-route-seeds.txt" > "$D/$TAG-rt$k.txt"
    say "route цикл $k$arm"
    if [ $arm = a ]; then sh farm/route-scan/series.sh "$TAG-rt$k$arm" "$D/$TAG-rt$k.txt"
    else sh farm/route-scan/series.sh "$TAG-rt$k$arm" "$D/$TAG-rt$k.txt" ND_ROUTE_ONE=1 ND_ROUTE_WOOD_ONCE=1 ND_ROUTE_PICK_FIRST=1 \
      ND_ROUTE_COOK_RESERVE=1 ND_ROUTE_QUOTAS=1 ND_ROUTE_STRUCTURES_FIRST=1 ND_ROUTE_SHAFT_BACK=1; fi
  done
  say "route: циклов $k, опускаю 8-20,27-29"
  node farm/farm.js down 8-20,27-29 > /dev/null 2>&1
}

nether_loop () {
  # Флаги демона и кампании серии B4 потока nether (ND_GUARD и правки r4 — по умолчанию в коде).
  export ND_GOLD_ROUTE=1 ND_BRUTE_HUNKER=1 ND_THRONE_HOT=1 ND_PEARL_PICK=1 ND_SPAWNER_HOT=1 ND_OPEN_BARTER=1 ND_ANGER_SAFE=1 \
    ND_GHAST_SWAT=1 ND_FR_STRICT=1 ND_OBS_EXIT=1 ND_NE_STAY=1
  local k=0 arm cb cenv
  while ok 66; do
    k=$((k + 1)); arm=$([ $((k % 2)) -eq 1 ] && echo a || echo b)
    sed -n "$(( (k - 1) / 2 * 16 + 1 )),$(( ((k - 1) / 2 + 1) * 16 ))p" "$D/$TAG-nether-seeds.txt" > "$D/$TAG-ne$k.txt"
    if [ $arm = b ]; then export ND_BARTER_FLOW=1; cb=',"ND_BARTER_FLOW":"1"'; else unset ND_BARTER_FLOW; cb=''; fi
    cenv='{"ND_BASTION_FIRST":"1","ND_SH_NETHER":"1","ND_SEALED_BREACH":"1","ND_SPAWNER_TUNNEL":"1","ND_GOLD_FAST_SAFE":"1","ND_NE_ROUTE":"1","ND_SH_STAY":"1"'"$cb"'}'
    say "nether цикл $k$arm"
    sh farm/ne-series.sh "${TAG}N$k${arm}x" "1 2 3 4 5 6 7 21 22 23 24 25 26 30 31 32" "$D/$TAG-ne$k.txt" \
      MAP=1 MAP_SH=1 GRID=1 NEAR_B2=1 MINUTES=60 "CENV=$cenv"
  done
  say "nether: циклов $k, опускаю 1-7,21-26,30-32"
  node farm/farm.js down 1-7,21-26,30-32 > /dev/null 2>&1
}

say "сбор до $UNTIL, метка $TAG"
route_loop > "$D/$TAG-route.log" 2>&1 &
sleep 90
( nether_loop ) > "$D/$TAG-nether.log" 2>&1 &
wait
say "сбор окончен"

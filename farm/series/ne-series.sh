#!/bin/sh
# farm/series/ne-series.sh <серия> "<слоты>" <файл сидов> [KEY=VAL...]  (поток nether, 03.10)
# Логи — farm/logs/neF3/<серия>-<слот>.log; итоги — node dist/farm/analysis/ne-sum.js neF-<серия><слот>-1 …
# Каждому слоту — один сид (по порядку), все параллельно с шагом 15 с. Флаги демона — из окружения.
cd /c/Users/user/Desktop/work/minecraft-claude || exit 1
series=$1; slots=$2; seedfile=$3; shift 3
i=0
for s in $slots; do
  i=$((i+1))
  seed=$(sed -n "${i}p" "$seedfile" | tr -d '\r ')
  [ -z "$seed" ] && break
  sh farm/series/ne-cycle.sh "$s" "$series" "$seed" -- "$@" > "farm/logs/neF3/$series-$s.log" 2>&1 &
  sleep 15
done
wait
echo "серия $series кончилась $(date +%H:%M:%S)"

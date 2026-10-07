#!/bin/sh
# S8c: серии одного снимка на слоте 8 (--lockstep, --reup), 16 сидов S8b, окно 20 мин.
#   CODE=<снимок> P=<префикс тега> LINES="v1 s1 b1" sh farm/route-scan/s8c-chain.sh
# Строки: vN — вслепую (главная метрика, ND_MAP=0, маршрут по увиденному), sN — «известный сид» (ND_MAP=struct),
# bN — «полный скан» (ND_MAP=blocks). Мир гасится в конце цепочки.
cd "$(dirname "$0")/../.." || exit 1
SEEDS=$(cat farm/route-scan/s8b-seeds.txt)
BASE="ND_OW_DEEP=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1"
set -- $LINES
n=$#; i=0
for line in "$@"; do
  i=$((i+1))
  case "$line" in
    v*) ENVS="$BASE ND_MAP=0" ;;
    s*) ENVS="$BASE MAP_LAVA=1 ND_MAP=struct" ;;
    b*) ENVS="$BASE MAP_LAVA=1 ND_MAP=blocks" ;;
  esac
  if [ $i -lt $n ]; then KEEP=1; else KEEP=0; fi
  KEEP_SLOT=$KEEP MINUTES=20 sh farm/route-scan/s8c-cycle.sh 8 $P-$line $CODE "$SEEDS" $ENVS $EXTRA
done

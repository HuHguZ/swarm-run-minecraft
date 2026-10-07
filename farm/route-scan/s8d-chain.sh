#!/bin/sh
# S8d: серии одного снимка на слоте 8 (--lockstep, --reup), окно 20 мин. Мир гасится в конце цепочки.
#   CODE=<снимок> P=<префикс тега> LINES="v1 s1 b1" [SEEDS=<файл>] [EXTRA="K=V ..."] sh farm/route-scan/s8d-chain.sh
# Строки: vN — вслепую (главная метрика, ND_MAP=0, маршрут по увиденному), sN — «известный сид» (ND_MAP=struct),
# bN — «полный скан» (ND_MAP=blocks), oN — вслепую с выключенными правками S8d (A/B на том же снимке: S8D_OFF).
cd "$(dirname "$0")/../.." || exit 1
SEEDS=$(cat ${SEEDS:-farm/route-scan/s8b-seeds.txt})
BASE="ND_OW_DEEP=1 ND_PORTAL_NATURAL=1 ND_ROUTE=1"
# Правки S8d выключены (прежнее поведение S8c-g) — плечо A на том же снимке.
S8D_OFF_DAEMON="ND_STRUCT_EYES=0 ND_EXPLORE_STUCK=0 ND_GRIND_PICKUP=0 ND_GRIND_NICHE=0"
S8D_OFF="ND_ROUTE_CAVE=0 ND_ROUTE_LAKES=0 ND_ROUTE_SMELTB=0 ND_ROUTE_IRONWOOD=0 ND_ROUTE_EARLYGRAVEL=0 ND_ROUTE_UNDERGO=0 ND_ROUTE_NIGHTPRICE=0 ND_ROUTE_GOLEM_RISK=0 ND_ROUTE_GOLEM_FREE=1 ND_HONEST_LAVA=0 ND_ROUTE_HUNTFIRST=0 ND_ROUTE_EARLYFLINT=0 ND_ROUTE_WETGRAVEL=0 ND_ROUTE_FLINTUP=0 ND_ROUTE_ORE_MEMORY=0 ND_ROUTE_INTERRUPT_MAX=0 ND_ROUTE_WATERPRICE=0"
set -- $LINES
n=$#; i=0
for line in "$@"; do
  i=$((i+1))
  case "$line" in
    v*) ENVS="$BASE ND_MAP=0"; DENV="" ;;
    o*) ENVS="$BASE ND_MAP=0 $S8D_OFF"; DENV="$S8D_OFF_DAEMON" ;;
    s*) ENVS="$BASE MAP_LAVA=1 ND_MAP=struct"; DENV="" ;;
    b*) ENVS="$BASE MAP_LAVA=1 ND_MAP=blocks"; DENV="" ;;
  esac
  if [ $i -lt $n ]; then KEEP=1; else KEEP=0; fi
  DAEMON_ENV="$DENV" KEEP_SLOT=$KEEP MINUTES=${MINUTES:-20} sh farm/route-scan/s8d-cycle.sh 8 $P-$line $CODE "$SEEDS" $ENVS $EXTRA
done

#!/bin/sh
# Дуэли кристаллами на слоте фермы (2026-09-30): арена daemon/arena.js на
# сервере слота, бойцы NeuroFarm<i> (демон 8800+i) и NeuroFarm<i>b (8900+i).
#   sh farm/crystal/duel.sh 29 10 c2-29          10 раундов, вывод farm/crystal/c2-29.out
#   EXTRA="ARENA_HOLES=8" sh farm/crystal/duel.sh 30 6 holes-30
#   EXTRA="ARENA_WATCH=HuHguZ" sh farm/crystal/duel.sh 29 4 watch-29   зритель-наблюдатель
#   SWAP=1 …   стороны наоборот: A — демон 89xx (NeuroFarm<i>b), B — 88xx (проверка перекоса сторон)
# Настройки — как у живой арены (deploy-arena.sh), кроме Колизея и мира.
SLOT=${1:-29}
ROUNDS=${2:-4}
TAG=${3:-duel-$SLOT}
if [ -n "$SWAP" ]; then
  PA=89; PB=88; NA_=NeuroFarm${SLOT}b; NB_=NeuroFarm$SLOT
else
  PA=88; PB=89; NA_=NeuroFarm$SLOT; NB_=NeuroFarm${SLOT}b
fi
cd "$(dirname "$0")/../../daemon" || exit 1
env ARENA_A=ws://127.0.0.1:$PA$SLOT ARENA_B=ws://127.0.0.1:$PB$SLOT \
  ARENA_NAME_A=$NA_ ARENA_NAME_B=$NB_ \
  ARENA_ENCH=0 ARENA_NOTIMER=1 ARENA_STALL_S=120 ARENA_RETURN_S=120 ARENA_R=${ARENA_R:-24} \
  ARENA_POS="${ARENA_POS:-200 100 200}" ARENA_MODE=${ARENA_MODE:-kits}   ARENA_PREP_RATE=${ARENA_PREP_RATE:-20} ARENA_FIGHT_RATE=${ARENA_FIGHT_RATE:-750} $EXTRA \
  node arena.js "$ROUNDS" "${KIT:-кристаллы}" > "../farm/crystal/$TAG.out" 2>&1

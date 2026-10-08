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
# PAIR=j (S7d): вторая пара на сервере слота — NeuroFarm<слот>c (ws 88jj) и NeuroFarm<слот>d (ws 89jj), bside.js pair-up.
PS=${PAIR:-$SLOT}
if [ -n "$PAIR" ]; then N1=NeuroFarm${SLOT}c; N2=NeuroFarm${SLOT}d; else N1=NeuroFarm$SLOT; N2=NeuroFarm${SLOT}b; fi
if [ -n "$SWAP" ]; then
  PA=89; PB=88; NA_=$N2; NB_=$N1
else
  PA=88; PB=89; NA_=$N1; NB_=$N2
fi
cd "$(dirname "$0")/../../daemon" || exit 1
env ARENA_A=ws://127.0.0.1:$PA$PS ARENA_B=ws://127.0.0.1:$PB$PS \
  ARENA_NAME_A=$NA_ ARENA_NAME_B=$NB_ ND_SERVER_LOG="${ND_SERVER_LOG:-../farm/server-$SLOT/logs/latest.log}" \
  ARENA_ENCH=0 ARENA_NOTIMER=1 ARENA_STALL_S=120 ARENA_RETURN_S=120 ARENA_R=${ARENA_R:-24} \
  ARENA_POS="${ARENA_POS:-200 100 200}" ARENA_MODE=${ARENA_MODE:-kits}   ARENA_PREP_RATE=${ARENA_PREP_RATE:-20} ARENA_FIGHT_RATE=${ARENA_FIGHT_RATE:-750} $EXTRA \
  node arena.js "$ROUNDS" "${KIT:-кристаллы}" > "${OUT:-../farm/crystal/$TAG.out}" 2>&1

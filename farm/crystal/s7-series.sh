#!/bin/sh
# Базовая серия PvP на TS при 750 TPS (s7, 2026-10-06): каждый набор — N раундов
# как есть и N со сменой сторон (SWAP=1). Вывод farm/crystal/<префикс>-<набор>-{std,swap}.out.
#   sh farm/crystal/s7-series.sh 27 5 s7b 'копья|булава на булаву|арбалет'
SLOT=${1:-27}; N=${2:-5}; PRE=${3:-s7b}; KITS=${4:-копья|булава на булаву|арбалет|ловушки и удочка|только якоря|кристаллы|арсенал}
cd "$(dirname "$0")/../.." || exit 1
IFS='|'
for k in $KITS; do
  short=$(printf '%s' "$k" | tr ' :' '__')
  KIT="$k" sh farm/crystal/duel.sh "$SLOT" "$N" "$PRE-$short-std"
  SWAP=1 KIT="$k" sh farm/crystal/duel.sh "$SLOT" "$N" "$PRE-$short-swap"
done
echo "серия $PRE готова"

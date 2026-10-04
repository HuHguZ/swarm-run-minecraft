#!/bin/sh
# natural с подсказкой из скана копии мира (MODE=hint, good-v2.json поле sky), по два РАЗНЫХ сида за раз на 29–30.
#   sh farm/portal-scan/hint.sh <tag> <минут> <сид1> <сид2> [<сид3> <сид4> ...]
cd /c/Users/user/Desktop/work/minecraft-claude
TAG=$1; MIN=$2; shift 2
while [ $# -gt 0 ]; do
  A=$1; B=${2:-$1}; shift; [ $# -gt 0 ] && shift
  echo "== $A $B $(date +%H:%M:%S)"
  node farm/farm.js down 29-30
  ND_PORTAL_NATURAL=1 node farm/farm.js up 2 --from 29 --fresh --seeds $A,$B
  sleep 8
  node farm/farm.js run try-lab-portal-natural.js --slots 29-30 --tag $TAG MODE=hint MINUTES=$MIN
done
node farm/farm.js down 29-30
echo "== конец $(date +%H:%M:%S)"

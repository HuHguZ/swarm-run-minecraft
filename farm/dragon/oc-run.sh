#!/bin/sh
# Дракон «только кровати», один цикл: как beds-run.sh, плюс запись дракона сервером по тикам (rec-dragon.js).
#   sh oc-run.sh <слот> <тег> <попыток> [KEY=VAL ...]
S=$1; TAG=$2; N=${3:-1}; shift 3
cd /c/Users/user/Desktop/work/minecraft-claude
TR=farm/logs/trace-$TAG; mkdir -p $TR
for k in $(seq 1 $N); do
  node farm/farm.js down $S >> farm/logs/$TAG.log 2>&1
  P=$((25600 + S)); for w in $(seq 1 30); do netstat -ano | grep -q ":$P .*LISTENING" || break; sleep 2; done; sleep 5
  # SEEDS=random — новый мир со случайным сидом (другой Энд: столбы, узлы пути); иначе сид двойника, свежий Энд.
  if [ "${SEEDS:-random}" = random ]; then UPF="--fresh --random"; else rm -rf farm/server-$S/world_the_end; UPF=""; fi
  ND_DRAGON_TRACE="$PWD/$TR" node farm/farm.js up 1 --from $S $UPF >> farm/logs/$TAG.log 2>&1
  # farm.js rcon при ошибке пишет «ОШИБКА» и выходит с 0 — ждать ответа «Reset» (fin2: 3 слота
  # без сброса, RCON ещё не поднят, сцена «ответа от сервера нет»).
  for w in $(seq 1 24); do node farm/farm.js rcon $S "random reset *" > /tmp/oc-rr-$S.txt 2>&1; cat /tmp/oc-rr-$S.txt >> farm/logs/$TAG.log; grep -q "Reset" /tmp/oc-rr-$S.txt && break; sleep 5; done; sleep 3
  node farm/dragon/rec-dragon.js $S "$PWD/$TR/rec-$k.jsonl" $(( ${MIN:-15} * 60 + 240 )) >> farm/logs/$TAG.log 2>&1 &
  RP=$!
  node farm/farm.js run try-dragon.js --slots $S --tag $TAG-$k E2E=1 E2E_KIT=campaign2 E2E_BEDS=${BEDS:-16} E2E_GAPPLES=2 \
    E2E_MIN=${MIN:-15} E2E_OUT="$PWD/farm/logs/$TAG.jsonl" "$@" -- e2e >> farm/logs/$TAG.log 2>&1
  kill $RP 2>/dev/null
done
node farm/farm.js down $S >> farm/logs/$TAG.log 2>&1
echo "=== $TAG: конец" >> farm/logs/$TAG.log

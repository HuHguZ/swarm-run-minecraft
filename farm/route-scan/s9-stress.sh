#!/bin/bash
# S9: A/B скорости тела в стресс-сцене тактики (try-stress-tactics, 6 фаз боя) и на прямом goto 200 бл. (маршрут lockstep.md)
# — один пошаговый мир, один снимок, флаг демона ND_S9 0/1 (перезапуск демона между плечами). Зонд часов
# (try-lockstep-probe) пишет темп (подтверждённые тики сервера / с стены) и долю физики.
#   bash farm/route-scan/s9-stress.sh <слот> <снимок> [повторов=2]
# Итоги: farm/results/s9-st<плечо>-<n>/, s9-rt<плечо>-<n>/; сводка — farm/logs/s9/stress.log. Мир гасится в конце.
R=/c/Users/user/Desktop/work/minecraft-claude; cd $R || exit 1
SLOT=$1; CODE=$2; N=${3:-2}; SEED=-1916258304016700532
L=farm/logs/s9; mkdir -p $L
WS=ws://127.0.0.1:88$SLOT
log(){ echo "[$(TZ=MSK-3 date +%H:%M:%S)] $*" | tee -a $L/stress.log; }
stress(){ tag=$1; mkdir -p farm/results/$tag; rm -f $L/stop
  (cd daemon && ND_WS=$WS PROBE_OUT=../farm/results/$tag/probe.jsonl PROBE_STOP=../$L/stop node try-lockstep-probe.js > /dev/null 2>&1) &
  node farm/farm.js run try-stress-tactics.js --slots $SLOT --tag $tag > farm/results/$tag.run.log 2>&1
  touch $L/stop; wait
  log "$tag: $(grep -h physics farm/results/$tag/slot-$SLOT.jsonl | sed -E 's/.*"phase":"([^"]+)".*"died":([a-z]+).*"ticks":([0-9]+).*"physics":([0-9.null]+).*/\1 died=\2 t=\3 ph=\4/' | tr '\n' ';') probe: $(tail -1 farm/results/$tag/probe.jsonl)"; }
route(){ tag=$1; mkdir -p farm/results/$tag; rm -f $L/stop
  node run/rpc.js --ws $WS connect > /dev/null 2>&1
  node run/rpc.js --ws $WS say "{\"text\":\"/spreadplayers 0 0 0 1 false NeuroFarm$SLOT\"}" > /dev/null 2>&1; sleep 4
  (cd daemon && ND_WS=$WS PROBE_OUT=../farm/results/$tag/probe.jsonl PROBE_STOP=../$L/stop node try-lockstep-probe.js > /dev/null 2>&1) &
  node run/rpc.js --ws $WS goto '{"x":160,"z":120,"timeoutSeconds":300}' > farm/results/$tag/goto.txt 2>&1
  touch $L/stop; wait; cp farm/daemon-$SLOT.out.log farm/results/$tag/daemon-$SLOT.out.log
  log "$tag: $(head -1 farm/results/$tag/goto.txt | cut -c1-200) probe: $(tail -1 farm/results/$tag/probe.jsonl)"; }
for try in $(seq 1 1440); do
  ND_S9=0 node farm/farm.js up 1 --from $SLOT --seeds $SEED --fresh --lockstep --reup --code $CODE > farm/logs/s9-up-$SLOT.log 2>&1
  grep -q "демон .* ✓" farm/logs/s9-up-$SLOT.log && break
  grep -q "лимит" farm/logs/s9-up-$SLOT.log || { log "up не вышел"; tail -5 farm/logs/s9-up-$SLOT.log; exit 1; }
  sleep 5
done
for arm in 0 1; do
  node farm/farm.js daemons $SLOT ND_S9=$arm > $L/daemons-$arm.log 2>&1; sleep 3
  log "плечо ND_S9=$arm, снимок $CODE, слот $SLOT"
  for n in $(seq 1 $N); do stress s9-st$arm-$n; route s9-rt$arm-$n; done
done
node farm/farm.js down $SLOT > /dev/null 2>&1
log "стресс-серия кончилась, слот $SLOT погашен"

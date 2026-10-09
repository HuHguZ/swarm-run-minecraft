#!/bin/sh
# Codex сам ведёт проект (пользователь 09.10): полные права, ферма, субагенты; задача — codex-lab/auto-task.md.
# Ход за ходом продолжает одну сессию (resume), пока нет codex-lab/AUTO-STOP или AUTO-DONE; на лимите ждёт.
#   запуск в фоне: см. HANDOFF; стоп: touch codex-lab/AUTO-STOP (ход доработает до конца)
#   замечание в следующий ход: написать в codex-lab/auto-inbox.md
P=C:/Users/user/Desktop/work/minecraft-claude
cd "$P" || exit 1
L=codex-lab/auto; mkdir -p $L
OPTS="--skip-git-repo-check -m ${CODEX_MODEL:-gpt-6-astra} --color never --dangerously-bypass-approvals-and-sandbox -C $P"
OPTS="$OPTS -c model_reasoning_effort=${CODEX_EFFORT:-max} --enable multi_agent"
log () { echo "$(date '+%m-%d %H:%M:%S') $*" >> $L/driver.log; }
# ход оборвался на лимите — ферма не должна простаивать до сброса
farmdown () {
  for s in $(node -e "console.log(Object.keys(require('./farm/slots.json').slots).join(' '))"); do
    node farm/crystal/bside.js down $s >> $L/driver.log 2>&1; node farm/farm.js down $s >> $L/driver.log 2>&1
  done
}
echo $$ > $L/driver.pid
id=$(cat $L/session 2>/dev/null); fails=0
while [ ! -f codex-lab/AUTO-STOP ] && [ ! -f codex-lab/AUTO-DONE ]; do
  node run/codex-limits.js --check >> $L/driver.log 2>&1
  if [ $? -eq 3 ]; then [ -z "$down" ] && { farmdown; down=1; log "на лимите — ферма погашена"; }; log "на лимите — жду 20 мин"; sleep 1200; continue; fi
  down=
  out=$L/turn-$(date +%m%d-%H%M%S).log; t0=$(date +%s)
  if [ -z "$id" ]; then
    codex exec $OPTS - < codex-lab/auto-task.md > $out 2>&1; code=$?
    id=$(grep -m1 -oE 'session id: [0-9a-f-]+' $out | cut -d' ' -f3); [ -n "$id" ] && echo "$id" > $L/session
  else
    msg="Продолжай работу по codex-lab/auto-task.md. Сверься с codex-lab/auto-log.md и верхом HANDOFF.md, возьми следующий шаг. Если сделано всё или упёрся в решение пользователя — погаси ферму, запиши итог и создай codex-lab/AUTO-DONE."
    # новые замечания пользователя: codex-lab/auto-inbox.md уходит в начало следующего хода и архивируется
    if [ -s codex-lab/auto-inbox.md ]; then
      msg="Новое от пользователя — учти сразу, приоритет выше текущего плана:
$(cat codex-lab/auto-inbox.md)

$msg"; mv codex-lab/auto-inbox.md $L/inbox-$(date +%m%d-%H%M%S).md
    fi
    codex exec $OPTS resume "$id" "$msg" > $out 2>&1; code=$?
  fi
  node run/codex-limits.js --after $out >> $L/driver.log 2>&1
  dt=$(( $(date +%s) - t0 )); log "ход: exit $code, $dt с, сессия $id, лог $out"
  # ponytail: быстрый провал подряд — пауза растёт, после 6 подряд драйвер останавливается
  if [ $dt -lt 120 ]; then fails=$((fails+1)); [ $fails -ge 6 ] && { log "6 быстрых провалов подряд — стоп"; break; }; sleep $((fails*300)); else fails=0; sleep 20; fi
done
farmdown; log "драйвер завершён"; rm -f $L/driver.pid

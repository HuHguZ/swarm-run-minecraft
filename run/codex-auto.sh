#!/bin/sh
# Codex сам ведёт проект (пользователь 09.10): полные права, ферма, субагенты; задача — codex-lab/auto-task.md.
# Ход за ходом продолжает одну сессию (resume), пока нет codex-lab/AUTO-STOP или AUTO-DONE.
# Только gpt-6.1-sol на ultra (пользователь 21.10); лимитов нет.
#   запуск в фоне: см. HANDOFF; стоп: touch codex-lab/AUTO-STOP (ход доработает до конца)
#   замечание в следующий ход: написать в codex-lab/auto-inbox.md
P=C:/Users/user/Desktop/work/minecraft-claude
cd "$P" || exit 1
L=codex-lab/auto; mkdir -p $L
OPTS="--skip-git-repo-check -m gpt-6.1-sol --color never --dangerously-bypass-approvals-and-sandbox -C $P"
OPTS="$OPTS -c model_reasoning_effort=ultra --enable multi_agent"
log () { echo "$(date '+%m-%d %H:%M:%S') $*" >> $L/driver.log; }
# в конце работы драйвера — закрыть только свой стенд слота 31
farmdown () {
  case " ${CODEX_KEEP_SLOTS:-} " in *" 31 "*) return ;; esac
  node dist/farm/farm.js down 31 >> $L/driver.log 2>&1
}
echo $$ > $L/driver.pid
id=$(cat $L/session 2>/dev/null); fails=0
while [ ! -f codex-lab/AUTO-STOP ] && [ ! -f codex-lab/AUTO-DONE ]; do
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
  dt=$(( $(date +%s) - t0 )); log "ход: exit $code, $dt с, сессия $id, лог $out"
  # ponytail: быстрый провал подряд — пауза растёт, после 6 подряд драйвер останавливается
  if [ $dt -lt 120 ]; then fails=$((fails+1)); [ $fails -ge 6 ] && { log "6 быстрых провалов подряд — стоп"; break; }; sleep $((fails*300)); else fails=0; sleep 20; fi
done
farmdown; log "драйвер завершён"; rm -f $L/driver.pid

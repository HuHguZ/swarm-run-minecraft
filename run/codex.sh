#!/bin/sh
# Codex (gpt-6-astra, размышления max — выбор пользователя 08.10; было gpt-6.1-sol) — напарник по просьбе пользователя (29.09): ревью, советы, второе мнение, свои
# опыты. Отвечает прямо в вывод. Песочница: пишет только в codex-lab/ и farm/ (свой слот 4), код
# бота — только чтение: правки присылает текстом, вносит агент Claude. Правила — codex-lab/AGENTS.md.
#   sh run/codex.sh "вопрос"               новый разговор; «session id: …» в начале вывода — для продолжения
#   sh run/codex.sh --resume <id> "ещё"    продолжить тот же разговор (помнит всё сказанное)
#   sh run/codex.sh - < вопрос.md           длинный вопрос через stdin
#   CODEX_EFFORT=low|medium|high|xhigh sh run/codex.sh …   по умолчанию max — думает минутами
#   CODEX_MODEL=gpt-6.1-sol sh run/codex.sh …   другая модель (по умолчанию gpt-6-astra)
#   CODEX_SEARCH=1 sh run/codex.sh …        с поиском в интернете (гайды, вики, разборы забегов)
# Долгое — в фоне (run_in_background) и ждать уведомления: молчаливый вызов сторож рвёт на 600 с.
# Лимиты (окно 5 ч и неделя) — run/codex-limits.js: на лимите вызов сразу отвечает «на лимите до …»
# с кодом 3 — работай сам и зови снова после сброса. Последняя строка вывода — остаток лимитов.
P=C:/Users/user/Desktop/work/minecraft-claude
cd "$P" || exit 1
node run/codex-limits.js --check; [ $? -eq 3 ] && exit 3
OPTS="--skip-git-repo-check -m ${CODEX_MODEL:-gpt-6-astra} --color never -s workspace-write -C $P/codex-lab --add-dir $P/farm"
OPTS="$OPTS -c model_reasoning_effort=${CODEX_EFFORT:-max}"
if [ "$1" = "--resume" ]; then id=$2; shift 2; set -- resume "$id" "$@"; fi
tmp=$(mktemp)
SEARCH=""; [ -n "$CODEX_SEARCH" ] && SEARCH="--search"
{ codex $SEARCH exec $OPTS "$@"; echo $? > "$tmp.code"; } 2>&1 | grep -v -E '^hook: ' | tee "$tmp"
code=$(cat "$tmp.code" 2>/dev/null || echo 1)
node run/codex-limits.js --after "$tmp"; lim=$?
rm -f "$tmp" "$tmp.code"
[ $lim -eq 3 ] && exit 3
exit $code

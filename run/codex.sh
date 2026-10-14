#!/bin/sh
# Codex (gpt-6.1-sol, размышления max — выбор пользователя 14.10) — напарник по просьбе пользователя (29.09): ревью, советы, второе мнение, свои
# опыты. Отвечает прямо в вывод. Песочница: пишет только в codex-lab/ и farm/ (свой слот 4), код
# бота — только чтение: правки присылает текстом, вносит агент Claude. Правила — codex-lab/AGENTS.md.
#   sh run/codex.sh "вопрос"               новый разговор; «session id: …» в начале вывода — для продолжения
#   sh run/codex.sh --resume <id> "ещё"    продолжить тот же разговор (помнит всё сказанное)
#   sh run/codex.sh - < вопрос.md           длинный вопрос через stdin
#   CODEX_SEARCH=1 sh run/codex.sh …        с поиском в интернете (гайды, вики, разборы забегов)
# Модель и размышления не меняются (пользователь 14.10: только gpt-6.1-sol на max) — думает минутами.
# Лимитов нет (подписка пользователя), звать сколько надо.
# Долгое — в фоне (run_in_background) и ждать уведомления: молчаливый вызов сторож рвёт на 600 с.
P=C:/Users/user/Desktop/work/minecraft-claude
cd "$P" || exit 1
OPTS="--skip-git-repo-check -m gpt-6.1-sol --color never -s workspace-write -C $P/codex-lab --add-dir $P/farm"
OPTS="$OPTS -c model_reasoning_effort=max"
if [ "$1" = "--resume" ]; then id=$2; shift 2; set -- resume "$id" "$@"; fi
tmp=$(mktemp)
SEARCH=""; [ -n "$CODEX_SEARCH" ] && SEARCH="--search"
{ codex $SEARCH exec $OPTS "$@"; echo $? > "$tmp"; } 2>&1 | grep -v -E '^hook: '
code=$(cat "$tmp" 2>/dev/null || echo 1)
rm -f "$tmp"
exit $code

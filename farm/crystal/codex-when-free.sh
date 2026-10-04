#!/bin/sh
# Ждёт конца лимита Codex и зовёт его на ревью crystal (фон, вывод — farm/crystal/codex-review.out).
cd /c/Users/user/Desktop/work/minecraft-claude || exit 1
while true; do node run/codex-limits.js --check >/dev/null 2>&1; [ $? -ne 3 ] && break; sleep 30; done
echo "[$(date +%H:%M:%S)] лимит снят, зову Codex" > farm/crystal/codex-review.out
CODEX_SEARCH=1 sh run/codex.sh - < farm/crystal/codex-review.md >> farm/crystal/codex-review.out 2>&1
echo "[$(date +%H:%M:%S)] codex exit $?" >> farm/crystal/codex-review.out

#!/bin/sh
# ВЫКЛАДКА ДУЭЛЕЙ КРИСТАЛЛАМИ НА ЖИВУЮ АРЕНУ — ПОДГОТОВЛЕНО, НЕ ЗАПУСКАЛОСЬ (агент crystal, 2026-09-30).
# Запускает только пользователь или координатор с его согласия. Делает то же, что обычная выкладка
# (шапка deploy-arena.sh), и ничего сверх:
#   1) снимок: daemon/src → daemon-stage/src, dist/daemon/arena/arena.js → deploy-tmp/arena-next.js;
#   2) deploy-arena.sh ждёт конца текущего раунда, deploy-live.ps1 меняет src у демонов 8765/8768,
#      arena-live.js ← arena-next.js, арена снова запускается.
# Наборы арены — в последней строке deploy-arena.sh ("арсенал,небо и порох"). Чтобы шли кристаллы,
# перед шагом 2 поменять там список на "кристаллы" (только кристаллы) или "арсенал,небо и порох,кристаллы"
# (по очереди, раунд за раундом) — это правка deploy-arena.sh, её делает тот, кто выкладывает.
# MC_PORT LAN-мира меняется при каждом открытии мира — проверить в deploy-live.ps1 до запуска.
# ВАЖНО: уезжает ВЕСЬ daemon/src, не только кристаллы. С живого снимка 27.09 в нём изменено 32 файла и
# добавлено 12 (правки всех агентов: combat-safety, drops, bastion, dragon, pvp, fortify, flee, bow…) —
# на арене поменяется и поведение в других наборах. Список: сравнить daemon/src с daemon-live/src.
# Колизей: ARENA_COLOS_FLAG не задавать — живой флаг daemon/colosseum-built.json (ферма писала в свой).
#   sh farm/crystal/deploy-crystal.sh
set -e
R=/c/Users/user/Desktop/work/minecraft-claude
mkdir -p "$R/deploy-tmp"
rm -rf "$R/daemon-stage/src"
cp -r "$R/daemon/src" "$R/daemon-stage/src"
cp "$R/dist/daemon/arena/arena.js" "$R/deploy-tmp/arena-next.js"
echo "снимок готов: daemon-stage/src, deploy-tmp/arena-next.js"
grep -n 'arena-live.js 0' "$R/deploy-arena.sh" | sed 's/^/наборы сейчас: /'
cd "$R" && nohup sh deploy-arena.sh > deploy-tmp/deploy.log 2>&1 < /dev/null &
echo "выкладка ждёт конца раунда, лог — deploy-tmp/deploy.log"

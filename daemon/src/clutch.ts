'use strict'
// Блочный клатч от падения (TODO.md «Спидраннерское перемещение блоками», шаг 1;
// Codex 30.09.2026, codex-lab/clutch — механика по javap Paper 1.21.11, таблицы
// там же: placement-mechanics.md, fall-mechanics.md). Там, где вода не годится —
// Ад, нет ведра в хотбаре, посадка на листву/полублок/забор, внизу лава или
// пустота, — блок на ВИДИМУЮ грань (pick.faceAim), чтобы сесть на него с < 4
// блоков (урон = floor(fall + 1e-6 − 3), LivingEntity.calculateFallDamage):
// у стены — на её боковую грань в первые тики падения, при отбросе с края —
// цепочка до 3 блоков под траекторией (по одному за тик, каждый опирается на
// предсказанный предыдущий).
// Тик: решение на physicsTick по позиции, которую уйдёт пакетом этого тика;
// клик — сразу после пакета позиции (событие move), так сервер проверит
// пересечение клетки с телом (BlockItem.canPlace → Level.checkEntityCollision,
// касание можно) по той же позиции. Блок ставим и в свой мир (как ванильный
// клиент), чтобы следующий simulate уже встал на него; отказ сервера
// (block_change с другим состоянием) или тишина 1 с — откат.
// Зависимости — параметрами (Vec3, faceAim, simulate, makeBlock, PlayerState,
// общая рука lockHand): модуль переносим и тестируем без сокетов.
//
// Части (clutch/): blocks — блоки и решение decide, plan — планировщик create(), guard* — сторож install (состояние,
// прогноз и вода, щелчки, тик, подписки).
export { IDLE, FILLER, intersects, selectBlock, decide, copyState } from './clutch/blocks'
export { create } from './clutch/plan'
export { install } from './clutch/guard'

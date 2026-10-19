'use strict'
// Архитектор: план → место → смета → стройка. Чертёж и генераторы — в
// blueprint.js (без мира), раскладка сундуков и таблички — в sorting.js.
//
// Главные решения, и откуда они:
//  · Состояние блока (куда смотрит ступень, дверь, кровать, сундук) сервер
//    берёт из НАПРАВЛЕНИЯ ИГРОКА в момент постановки
//    (BlockPlaceContext.getHorizontalDirection → Player.getDirection, байткод
//    paper-1.21.11.jar), а верх/низ ступени и плиты — из нажатой грани и
//    высоты точки клика. mineflayer.placeBlock сам смотрит в центр грани и тем
//    самым выбирает направление за нас, поэтому здесь постановка своя: взгляд
//    с нужным yaw отдельным пакетом (bot.look с force шлёт его следующим тиком
//    физики, physics.js updatePosition), потом _genericPlace с forceLook
//    'ignore' и точной точкой клика (delta). Пакеты одного соединения сервер
//    разбирает по порядку — поворот приходит раньше клика.
//  · Мир проверяется, а не ответ: после клика читаем блок в клетке.
//  · Повтор после обрыва ничего не ломает: готовая клетка (имя и состояние
//    совпали) пропускается, и второй вызов доделывает недостающее. Место,
//    поворот и сам план лежат в памяти (state.build), поэтому «где строил» не
//    теряется даже с автовыбором места.
//  · Высоко — леса: столб из дешёвого блока под собой (build.towerUp), потом
//    разобрать его сверху вниз. Pathfinder на время стройки не копает и не
//    строит сам (canDig=false, без столбов и мостков) — иначе он прорубает
//    путь сквозь только что поставленную стену.
//  · Дверь ставится последней, пока её нет — проём остаётся выходом; и перед
//    каждой клеткой, пока бот внутри постройки, проверяется, что выйти он
//    ещё может (поиск пешего пути наружу с прыжком на блок и падением).
//
// Части (daemon/src/architect/): world — константы и предикаты блоков; plan — план, палитра, геометрия; site — выбор
// места; estimate — память стройки и смета; reach — досягаемость и ходьба; hands — постановка и леса; signs — таблички;
// execute — сама стройка; prepare — подготовка; entries — preview/build/kinds/status/forget.
export { isDone, REACH, YAW, JOB } from './architect/world'
export { resolvePalette, autoMaterial } from './architect/plan'
export { pickSurfaceSite, pickHillside } from './architect/site'
export { canWalkOut, reachMap, walk, buildMovements, standSpots } from './architect/reach'
export { putCell, placeOptions, digAt } from './architect/hands'
export { writeSign, signText, onceSignEditor } from './architect/signs'
export { execute } from './architect/execute'
export { prepare } from './architect/prepare'
export { build, preview, kindsExport as kinds, status, forget } from './architect/entries'

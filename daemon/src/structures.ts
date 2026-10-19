'use strict'
// Постройки игры: узнать по тому, что видно, запомнить, рассудить, где искать
// следующую, зайти, обезвредить ловушку и забрать ценное — объяснив, зачем.
//
// Узнавание честное: блок засчитан, только если луч от глаз упирается в него
// (sight.seesBlock), сущность — если до неё есть луч. Сигнатура постройки —
// группы блоков (и сущностей "e:имя"), которые вместе больше нигде не растут:
// спавнер + замшелый булыжник — данж, рельсы + паутина + доски — шахта,
// обсидиан + незерак/плакучий обсидиан без портала внутри — руины портала...
//
// Когда постройка уже опознана, человек знает её планировку: сундуки
// пустынного храма — в камере под центральной синей терракотой, у храма в
// джунглях — за стенами. Поэтому сундуки в пределах опознанной постройки
// ищутся по данным мира (findBlocks), а не только глазами: это знание
// игры, а не подсказка сервера. Узнавание — только глазами.
//
// Факты — из paper-1.21.11.jar (SPEEDRUN.md, «Постройки»):
//   structure_set/*.json — spacing/separation регионов,
//   tags/worldgen/biome/has_structure/*.json — где что растёт,
//   loot_table/chests/*.json — что внутри,
//   DesertPyramidPiece — плита (10,-11,10) над 9 TNT (9..11,-13,9..11),
//     сундуки в 2 блоках от плиты по сторонам света;
//   TripWireBlock.playerWillDestroy — ножницы в руке ставят DISARMED,
//     без ножниц сломанная нить срабатывает;
//   PiglinAi.angerNearbyPiglins — открыл сундук/бочку или сломал золотой блок
//     (тег guarded_by_piglins): злятся все пиглины в кубе ±16, кто тебя видит.
//     Золотая броня от этого НЕ спасает — она только от нападения при встрече.
//
// ЭТИКА (правило человека): сундук, который поставил ИГРОК, без решения
// человека не трогаем. playerMarks() — признаки чужой руки: табличка, рамка,
// эндер-сундук, шалкер, наковальня, воронка у сундука, кровать не в деревне.
//
// Части (daemon/src/structures/): common — мелкие помощники; kinds — таблицы построек; memory — память в журнале;
// scan — узнавание; worth — ценность лута; site — место и тело; water — воздух и вода; templates — шаблоны;
// dig — копка и лестницы; take — взять и обобрать; handlers — обработчики по видам; explore — фон и поход.
export { KINDS, SETS, TRAP_BLOCKS, STRUCTURE_PLACES, TEMPLATE_KINDS } from './structures/kinds'
export { whereNext, opportunities, known, compact, recordedAt, readTreasureMaps, remember } from './structures/memory'
export { scan, look, sees, gather, evaluate } from './structures/scan'
export { decide } from './structures/worth'
export { playerMarks, piglinsWatching, piglinsNear, armTraps, seenNear, digAt } from './structures/site'
export { withAir } from './structures/water'
export { templateFit, fitKnown } from './structures/templates'
export { digToSee, digDown } from './structures/dig'
export { takeWorth, takeCart } from './structures/take'
export { forget, explore, install } from './structures/explore'

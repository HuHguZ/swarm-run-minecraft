'use strict'
// Огненные стержни: бой у спавнера блейзов, пока в рюкзаке не станет N
// стержней. Сам бой — combat.fight (и pvp.duel под ним: лук с упреждением,
// щит, стрейф под летуном); здесь — всё, что вокруг боя: где стоять, кого бить
// следующим, когда есть, чем добить висящего, и счёт прибыли по рюкзаку, а не
// по убийствам.
//
// Механика — по байткоду paper-1.21.11 (Blaze, Blaze$BlazeAttackGoal,
// SmallFireball, Snowball, BaseSpawner) и data/minecraft/loot_table:
//   * блейз 20 хп, 0.6x1.8. Видя цель ближе 48 блоков, к ней НЕ летит: висит
//     и стреляет очередью из 3 шаров раз в ~178 тиков (~9 с). Шар — 5 урона
//     на normal и 5 с огня. Сближается сам только первые 5 тиков после того,
//     как потерял цель из виду; ближе 2 блоков бьёт в упор (6).
//   * высота: держится у глаз цели со сдвигом, который раз в 100 тиков
//     перебрасывается в -6.4..+7.4 (triangle(0.5, 6.891)); вниз падает
//     медленно (vy*0.6). Поэтому он то в досягаемости меча, то нет.
//   * его шар ударом НЕ отбить (small_fireball не в #redirectable_projectile),
//     щит — держит спереди.
//   * снежок по блейзу — 3 урона (Snowball.onHitEntity: instanceof Blaze ? 3 : 0),
//     то есть 7 снежков на блейза; вода и дождь жгут его по 1 за удар.
//   * лут: blaze_rod uniform 0..1 и ТОЛЬКО при убийстве игроком — полстержня
//     на блейза в среднем; сгоревший в лаве или упавший не даёт ничего.
//   * спавнер: работает, пока игрок в 16 блоках от его центра; раз в 200–799
//     тиков 4 попытки в кубе ±4 по x/z и -1..+1 по y; не больше 6 блейзов в
//     кубе 9x9x9 вокруг; свет и пол не нужны. X/Z — разность двух nextDouble (центр чаще краёв).
//     Если все 4 клетки не годятся, повтор на следующем тике; длинная задержка — после успеха/переполнения.
// Рецепты (data/minecraft/recipe): blaze_powder — бесформенный из 1 стержня, 2
// порошка; ender_eye — бесформенный из порошка и жемчуга. Значит, стержень —
// это два ока.
//
// Части (daemon/src/blaze/): targets — цели, стержни на полу, кто смотрит; potions — огнестойкость; approach — подход,
// сбор стержней, отдых; radar — шары и прицел; post — пост и яма; bunker — бункер и коробка; hold — бой у спавнера
// (holdSpawner); camp — стрельба из лунки; farm-rods — farmRods, оркестр этапа.
export {
  droppedRods, liveBlazes, sweepRisk, rodsShort, bystanderOnLine, reachTo, nearestBlaze, visibleSpawner,
  EYES_WANTED, SPAWNER_PLACE
} from './blaze/targets'
export { drinkable, drinkFireResistance, hasEffect, frSpendOk, frCount } from './blaze/potions'
export { collectRods, canApproachSpawner, walkNear } from './blaze/approach'
export { makeRadar, blazeEye, seesMe } from './blaze/radar'
export { floorUnder, fightMoves, digInPlace, digInNear, pitWhyAt, choosePost, windowForPost } from './blaze/post'
export { boxRest } from './blaze/bunker'
export { farmRods } from './blaze/farm-rods'

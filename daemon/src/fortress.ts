'use strict'
// Крепость Ада: увидеть её честно и дойти до неё (mc_fortress). Зрение — как у
// человека: блок засчитан, только если луч от глаз упирается в него
// (bot.canSeeBlock), кирпич за стеной не подсказывает ничего.
//
// Почему своё сканирование, а не observe. observe делает один findBlocks на все
// «интересные» виды с count 300 и фильтрует видимость ПОСЛЕ отсечки (NETHER.md,
// срез 5а): в Аду лава съедает весь бюджет, и спавнер в 21 блоке при лаве под
// полом не виден, хотя луч до него есть. Здесь у каждого вида свой бюджет, и в
// ответе — сколько кандидатов проверено лучом (это нижняя граница «видно»).
//
// Факты (байткод и данные paper-1.21.11):
//   * крепость строится из nether_bricks, nether_brick_fence и
//     nether_brick_stairs (NetherFortressPieces); в самом Аду эти блоки больше
//     нигде не растут — увидел кирпич, значит, крепость (бастион — из blackstone);
//   * nether_complexes: регион 27x27 чанков (432 блока), в каждом одна постройка,
//     крепость с весом 2 из 5 (40%), бастион — 60%;
//   * спидраннеры идут от портала вдоль оси X: коридоры крепости длинные, их
//     легче пересечь поперёк (SPEEDRUN.md);
//   * тронный зал блейзов (MonsterThrone 7x8x9) — спавнер на подиуме, в
//     открытой части крепости; блейз, скелет-иссушитель, зомби-пиглин, скелет и
//     магмовый куб спавнятся по всей коробке кусков крепости.
//
// Части (daemon/src/fortress/): look — взгляд, память спавнера и бастиона; legs — переходы, подъём, добор блоков и
// кирок; sweep — обход регионов; tour — тронный зал и продолжение крепости; spawner — подход к спавнеру; scout — mc_fortress.
export { look, placeOf, FORTRESS_BLOCKS, BASTION_BLOCKS, PLACE, SPAWNER_PLACE, BASTION_PLACE } from './fortress/look'
export { climbTo, keepBlocks, walkLeg } from './fortress/legs'
export { bastionRegions, regionOf } from './fortress/sweep'
export { deckLeg, tour, spawnerHint, hintFlipped, axisLeg } from './fortress/tour'
export { toSpawner } from './fortress/spawner'
export { scout } from './fortress/scout'

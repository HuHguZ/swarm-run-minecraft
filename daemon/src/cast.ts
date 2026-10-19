'use strict'

// Портал в Ад без алмазной кирки: литьё рамы вёдрами (спидран-приём).
//
// Механика — по исходникам 1.21.11 (extracted_minecraft_data, client1.21.11):
// * LiquidBlock.shouldSpreadLiquid: лава смотрит на соседей по
//   POSSIBLE_FLOW_DIRECTIONS = [DOWN, SOUTH, NORTH, EAST, WEST] через
//   pos.relative(direction.getOpposite()) — СВЕРХУ и с четырёх сторон, но не
//   снизу. Там вода — источник лавы становится obsidian, текущая лава —
//   cobblestone. Зовётся из onPlace (лаву поставили к воде) и из
//   neighborChanged (воду поставили к лаве) — порядок любой, застывает сразу.
// * Сама лава растекается только по своему тику: onPlace → scheduleTick(...,
//   fluid.getTickDelay), у лавы в верхнем мире 30 тиков. Полторы секунды на
//   воду — с запасом, дальше вода успевает раньше, чем лава течёт.
// * BucketItem.use: полное ведро бросает луч от глаз с ClipContext.Fluid.NONE
//   (жидкости луч проходит насквозь) и кладёт жидкость в клетку по грани, в
//   которую упёрся (getBlockPos().relative(getDirection())): воздух или
//   заменимое — ИСТОЧНИК; текущая вода заменима (LiquidBlock своего
//   canBeReplaced не имеет). Поэтому жидкость ставится «на грань опоры», как
//   блок, и целиться надо в грань, а не в клетку: луч в клетку с лавой пройдёт
//   её насквозь и заменит лаву водой на полу. Пустое ведро — SOURCE_ONLY:
//   берёт только источник.
// * Рама — PortalShape: углы не проверяются, 10 обсидиана (nether.js).
//
// Раскладка (origin — левая нижняя клетка проёма, как в nether.js; i вдоль
// рамы, j вверх; F(i,j) — ряд перед рамой, где стоит тело):
//   низ (0,-1),(1,-1) — с земли: лава на пол под клеткой, вода себе под ноги
//                       (клетка ног — соседка рамы спереди);
//   стойки j=0        — с земли: лава на нижний угол (булыжник), вода в проём
//                       на низ рамы (клетка проёма — соседка стойки);
//   стойки j=1,2      — со столба перед стойкой: лава на верх клетки ниже,
//                       вода себе под ноги (на вершину столба);
//   верх (0,3),(1,3)  — со столба до j=3: лава на верх временной подпорки в
//                       проёме (0,2)/(1,2), вода в верхний угол рамы
//                       (-1,3)/(2,3) — на верх стойки.
// Потом подпорки долой, проём чистый; поджиг — nether.portal: готовую раму он
// находит сам и зажигает.
import { lavaSources, refillState, resumeOnePlan } from './cast/plan'
import { countOf, digRisk, digVisible, eyes, feetCell, hasFluid, isAir, isSolid, levelOf } from './cast/base'
import { aimFor, hold, landing, pour, scoop, scoopAim, standSpots } from './cast/bucket'
import { centreOn, descend, dryFeet, liveLava, walk } from './cast/walk'
export { geom, outlineAim, steadyFloor, SOFT_PLANT, PLACE } from './cast/base'
export { planCast, judge, lavaSources, hearLava, hearWater } from './cast/plan'
export { landing, aimFor, scoopAim, standSpots } from './cast/bucket'
export { windowCandidates, openWindow, liveLava } from './cast/walk'
export { castPortal } from './cast/portal'
// Внутренности для cast1.js (одно ведро): те же прицел, черпак, копка и ходьба.
const _inExport = { resumeOnePlan, refillState, digVisible, digRisk, scoopAim, pour, scoop, aimFor, landing, levelOf, isAir, isSolid, hasFluid, walk, centreOn, feetCell, descend, dryFeet, hold, countOf, standSpots, lavaSources, liveLava, eyes }
export { _inExport as _in }

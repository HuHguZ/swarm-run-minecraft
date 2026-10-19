'use strict'
// Таблица этапов: STAGES, defStage, готовность READY/DEFER/DONE и пороги, которые они читают.
import { NIGHT_DOWN2, OW_DEEP } from '../flags'
import { stage, state, sit, known, netherExplored, netherViewRevision, foodHuntEmpty, foodSpentMs, nightHeld,
  castSurfaceFailed, lavaSourceKnown, waterDeepFailAt, wantBeds, ironChestTried } from '../state'
import { have, y, dim, LOGS, COBBLE, RAW, FOOD, foodUnits, netherFoodHave, PICK_STONE, PICK_IRON, PICK_DIAMOND,
  portalFar, portalBuckets, armorPointsNow, rodsNow } from '../queries'
const gameClock: typeof import('../../src/game-clock') = require('../../src/game-clock')
const canWorkAtNight = () => sit.foes === 0 && !sit.inWater && !sit.buried &&
  (state.health ?? 0) >= 16 && (state.food ?? 0) >= 14 &&
  (!sit.surface || (NIGHT_DOWN2() ? stage === 'wood' || !sit.night : have(/_(sword|axe)$/) > 0 || stage === 'wood' || stage === 'stone'))

const STAGES = []
const OTHER_WORLD = new Set(['bastion', 'nether', 'pearls', 'eyes', 'stronghold', 'dragon'])
const fed = (items, level) => have(FOOD) + ((have('furnace') || have(COBBLE) >= 8) ? have(RAW) : 0) >= items || (state.food ?? 20) >= level
// Набор литья готов и лава видена рядом — портал важнее ночной копки (cl-h 14.10: в 24.5 бл. от лавы ушёл копать, погиб внизу).
// Только проверенный источник (обзор вдаль видел годное озеро): лава из обзора 64 бывает текущей, ночью к ней шёл и искал
// источник разведкой — смерть от скелета (cl-s 14.10, 52-я мин).
const castNear = () => !!known.lava && !!state.pos && ((lavaSourceKnown && Math.hypot(known.lava.x - state.pos.x, known.lava.z - state.pos.z) <= 96) ||
  (process.env.ND_OW_KIT_LAVA !== '0' && !sit.surface && Math.hypot(known.lava.x - state.pos.x, (known.lava.y ?? y()) - y(), known.lava.z - state.pos.z) <= 12)) &&
  have('water_bucket') > 0 && READY.cast()
// Ночь спидрана до портала без брони: поверху — смерть (cl-a…cl-k 14.10: 15 смертей из 22 прогонов, почти все ночью — охота,
// поиск воды, берег). Есть кирка и дерево на кирки — ночь идёт работой под землёй (главный цикл), наземные этапы — с рассветом.
// Дерево на кирки: спуск без запаса кончался «палок нет — наверх за деревом» на y 25 (cl-f 14.10, 18 мин простоя).
// Лава с набором рядом (castNear) ночь не снимает: литьё зовёт сам главный цикл, остальные наземные этапы — с рассветом (cl-p
// 14.10: с ведром у лавы граф выбрал охоту, ночью поверху — смерть от скелета).
// Броня: один железный нагрудник (6) ночь не держит — с ним охота ночью кончилась смертью от зомби (cl-r 14.10, 36-я мин);
// поверху ночью работаю в полном железе (15).
// С сумерек (11840), а не с ночи: нору копать до спавна мобов, а не под стрелами (cl-u 14.10: смерть на 10-й мин, через минуту
// после темноты, пока искалось сухое место; cl-z: паук на 9.8).
// И после литья портала: сборы (еда, кровать) ночью поверху — смерть от скелета на 173-й мин (cl-af 14.10). С порталом ночь
// уходит в Ад, если готов, иначе — та же нора/коробка/работа внизу.
const nightHold = () => dim() === 'overworld' && (!!sit.night || !!sit.dusk) && state.playPolicy?.mode === 'speedrun' &&
  armorPointsNow() < 15 && (have(/_pickaxe$/) > 0 || (process.env.ND_NIGHT_WORK !== '0' && nightHeld && !sit.surface)) && process.env.ND_NIGHT_DIG !== '0'
// Копать ночью вниз — только с деревом на сменные кирки: каменной хватает на один спуск лестницей (131 удар), без палок она
// ломалась внизу, подъём рукой сквозь камень — 8 мин (cl-q 14.10). Без дерева ночь — в норе или коробке.
const nightDigWood = () => have(LOGS) > 0 || have(/_planks$/) >= 2 || have('stick') >= 2
// Ночью без еды наверх за охотой не иду, пока хп хватает на работу внизу (≥ 6): охота ночью — главная из смертей серии.
const weakAndHungry = () => (state.health ?? 20) < (process.env.ND_OW_DEEP === '1' && !known.portal && (state.dimension || 'overworld') === 'overworld' ? 6 : 12) &&
  !have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 && (!sit.night || state.playPolicy?.mode === 'speedrun') && !((state.health ?? 20) >= 6 && nightHold())
const READY = {
  stone: () => have(/_pickaxe$/) > 0,
  iron: () => have(PICK_STONE) > 0 && (fed(3, 15) || (foodHuntEmpty >= 2 && (state.food ?? 20) >= 8)),
  cast: () => have(/bucket$/) >= portalBuckets() && (have('flint_and_steel') || have('fire_charge') || have('iron_ingot')) > 0,
  diamond: () => have(PICK_IRON) > 0 && fed(5, 19),
  obsidian: () => have(PICK_DIAMOND) > 0 && have(/bucket$/) > 0,
  portal: () => have('obsidian') >= 10,
  prep: () => have(PICK_STONE) > 0,
  nether: () => have(/^(stone|iron|diamond|netherite)_pickaxe$/) > 0 && (dim() === 'the_nether' || netherFoodHave() >= netherFoodNeed()),
  pearls: () => (have(PICK_IRON) > 0 || have(/^(iron|diamond|netherite)_sword$/) > 0),
  bastion: () => (have(PICK_IRON) > 0 || (!ironChestTried && dim() === 'the_nether' && have('iron_ingot') + have('raw_iron') + have('iron_nugget') / 9 >= 1)) && (foodUnits() >= 6 || (state.food ?? 0) >= 18)
}
function netherFoodNeed () {
  const base = rodsNow() >= 5 ? 3 : 6
  if (process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_FOOD2 !== '0') return Math.min(base, 2)
  // Ночь у горящего портала: в Аду ночи нет, поверху — тоже 3 порции (fp1-s13-1 16.10: портал на 29 мин, 3 свиных котлеты,
  // поверху «еды мало» — 17 мин ночных штреков вместо входа). ND_NIGHT_PORTAL_SURFACE=0 — прежнее «только снизу».
  if (sit.night && (!sit.surface || process.env.ND_NIGHT_PORTAL_SURFACE !== '0') && known.portal && portalFar() < 48) return Math.min(base, 3)
  return base
}
const netherLack = () => [
  have(/^(stone|iron|diamond|netherite)_pickaxe$/) > 0 ? '' : 'кирки',
  netherFoodHave() >= netherFoodNeed() ? '' : `еды (${netherFoodHave()} из ${netherFoodNeed()})`
].filter(Boolean).join(', ') || 'ничего'
// Огнестойкость (зелье с бартера) снимает огонь ифритов — главный урон без брони (шар 5 + горение): с ней и щитом бой у спавнера
// не ждёт железной брони из верхнего мира (b0-7-2 14.10: 30 мин за железом, на обратном пути — смерть). Цена боя — в графе (blazeRisk).
// Бой у спавнера без брони и огнестойкости — не запрет, а цена (AGENTS.md «гибкость»: «к ифритам только с огнестойкостью» — пример
// запрещённого жёсткого правила): броню, щит и огнестойкость оценивает blazeRisk графа (core/speedrun.ts), вариант боя без них —
// ближняя коробка для меча (blaze.ts planKillBox), щит на залп, отход на лечение и возврат. Здесь — только кирка и еда (ревью Codex 14.10).
const fightReady = () => READY.nether()
const fightLack = netherLack
const DEFER = {
  food: () => nightWork() || (!sit.surface && have(FOOD) >= 6 && (state.food ?? 20) >= 14) ||
    (OW_DEEP && !known.portal && foodHuntEmpty >= 2 && !weakAndHungry()) ||
    (OW_DEEP && !known.portal && foodSpentMs >= FOOD_CAP_MS && foodUnits() >= 3 && !weakAndHungry()) ||
    (OW_DEEP && !!known.portal && (known.portal.y ?? 64) < 40 && near3(known.portal, 48) && !sit.surface && y() < 40 && (sit.night || READY.nether()) && !weakAndHungry()) ||
    (sit.night && !sit.surface && foodUnits() >= 4) ||
    (OW_DEEP && !known.portal && !sit.surface && y() < 50 && (state.food ?? 20) >= 10 && !weakAndHungry()),
  water: () => (nightWork() && have(PICK_IRON) > 0) ||
    (OW_DEEP && !known.portal && !sit.surface && y() < 50 && gameClock.now() - waterDeepFailAt < 8 * 60000),
  cast: () => (state.playPolicy?.mode !== 'speedrun' && sit.night && sit.surface && dim() === 'overworld' && !(OW_DEEP && !surfaceLavaNear())) ||
    (have(PICK_DIAMOND) > 0 && have(/bucket$/) > 0 && y() < 0) ||
    (castSurfaceFailed && !known.lava)
}
const DONE: any = {}
function defStage (name, needed, run) { STAGES.push({ name, needed, run, ready: READY[name] || (() => true), defer: DEFER[name] || (() => false), done: () => (DONE[name] ? DONE[name]() : !needed()) }) }
function stageProgress (name) {
  const resources = {
    wood: /_log$|_stem$|_planks$|_pickaxe$/,
    stone: /^cobblestone$|^cobbled_deepslate$|_pickaxe$|_sword$/,
    food: /^(cooked_.+|beef|porkchop|mutton|chicken|rabbit|cod|salmon|bread|baked_potato|golden_carrot|apple|carrot|sweet_berries|melon_slice|pumpkin_pie|golden_apple|mushroom_stew|beetroot_soup|rabbit_stew|dried_kelp|cookie)$|_wool$|_bed$/,
    iron: /^(raw_iron|iron_ingot|iron_block|raw_iron_block|bucket|water_bucket|shield|flint_and_steel|raw_gold|gold_ingot|golden_helmet)$|^iron_(pickaxe|chestplate|leggings|boots|sword)$/,
    water: /^water_bucket$/,
    cast: /^obsidian$/,
    diamond: /^diamond$|^diamond_pickaxe$/,
    obsidian: /^obsidian$/,
    portal: /^obsidian$/,
    prep: /^(cooked_.+|gold_ingot|golden_helmet|arrow|stick|flint_and_steel|shield)$|_bed$|_pickaxe$/,
    bastion: /^(gold_block|gold_ingot|ender_pearl|potion|splash_potion)$/,
    nether: /^blaze_rod$|^blaze_powder$/,
    pearls: /^ender_pearl$|^ender_eye$/,
    eyes: /^ender_eye$/,
    endkit: /_bed$|_wool$|_boat$|^(arrow|spectral_arrow|bow|water_bucket|bucket|iron_ingot|raw_iron|string|feather|flint|golden_apple|cobblestone|cobbled_deepslate|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|dirt|end_stone)$/
  }
  const result: any = {}
  const re = resources[name]
  if (re) for (const [item, count] of Object.entries(state.inventory || {})) if (re.test(item)) result[item] = count
  for (const key of ['portal', 'fortress', 'stronghold', 'endPortal', 'dragonWon']) result[`known:${key}`] = known[key] ? 1 : 0
  if (dim() === 'the_end') result.end = 1
  if (name === 'nether') { result.explored = netherExplored; result.fortressView = netherViewRevision }
  return result
}

const nightWork = () => state.playPolicy?.mode !== 'speedrun' && sit.night && !canWorkAtNight() && (state.food ?? 20) >= (NIGHT_DOWN2() ? 6 : 12) && have(PICK_STONE) > 0 && !have(/_bed$/)
const FOOD_STOCK = 8
const FOOD_CAP_MS = 180000
// До первого Ада запас уже оценён netherFoodNeed; шерсть — цель endkit, а не условие входа.
const entrySupplies = () => process.env.ND_ENTRY_SUPPLIES === '1' && dim() === 'overworld' && rodsNow() < 7 && wantBeds === 1
const foodShort = () => Math.max(0, entrySupplies() && known.portal ? netherFoodNeed() - netherFoodHave() : FOOD_STOCK - foodUnits())
const near3 = (p, r) => !!p && !!state.pos && Math.hypot(p.x - state.pos.x, (p.y ?? y()) - state.pos.y, p.z - state.pos.z) <= r
const lavaApproachSeconds = (q, proven = false) => !q || !state.pos ? Infinity :
  Math.hypot(q.x - state.pos.x, q.z - state.pos.z) / 2.5 + Math.abs((q.y ?? y()) - y()) * 2 + (proven ? 0 : 60)
const surfaceLavaNear = () => !!known.lava && (known.lava.y ?? 64) >= 0 && !!state.pos && Math.hypot(known.lava.x - state.pos.x, known.lava.z - state.pos.z) <= 96
const stageRun = name => STAGES.find(s => s.name === name).run

// Порядок этапов — поведение (выбор этапа и legacy-список only идут по STAGES). Файлы этапов импортирует только
// stages/all.ts; если порядок сбился (файл этапа импортирован раньше), кампания не стартует.
const STAGE_ORDER = ['routeEnter', 'route', 'wood', 'stone', 'food', 'iron', 'water', 'cast', 'diamond', 'obsidian', 'portal', 'prep', 'bastion', 'nether', 'pearls', 'eyes', 'endkit', 'stronghold', 'dragon']
function assertStageOrder () {
  const names = STAGES.map(s => s.name).join(',')
  if (names !== STAGE_ORDER.join(',')) throw new Error(`кампания: порядок этапов ${names}, ожидался ${STAGE_ORDER.join(',')}`)
}

export { canWorkAtNight, STAGES, OTHER_WORLD, castNear, nightHold, nightDigWood, weakAndHungry, READY, netherFoodNeed,
  netherLack, fightReady, fightLack, DONE, defStage, stageProgress, nightWork, FOOD_STOCK, FOOD_CAP_MS, entrySupplies,
  foodShort, near3, lavaApproachSeconds, surfaceLavaNear, stageRun, assertStageOrder }

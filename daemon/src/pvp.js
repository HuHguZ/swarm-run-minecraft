'use strict'
const gameClock = require('./game-clock')
// Бой с человеком. Не «подойти и махать», как с зомби, а то, что делает живой
// игрок: бьёт с края дальности, отходит на время перезарядки, чтобы его не
// достали в ответ, крутится вокруг, бьёт в прыжке ради крита, W-tap'ом
// сбрасывает спринт ради отбрасывания, кидает паутину под ноги, лаву и огонь,
// снежки навстречу разбегу, стреляет издалека, пьёт и кидает зелья, ест
// золотые яблоки, держит тотем, щитом закрывается в перезарядке, а по щиту
// противника бьёт топором.
//
// Почему это отдельный модуль, а не ветка в combat.fightBody: цикл моба
// рассчитан на 650 мс между решениями и на pathfinder, который ведёт тело. Тут
// решение принимается каждые 50 мс, телом правят клавиши напрямую, а
// pathfinder включается, только когда противник дальше FAR и надо обходить
// рельеф.
//
// Все числа механики — Java 1.21 (minecraft.wiki, «Damage», «Attack cooldown»,
// «Critical hit», «Shield», «Arrow», «Cobweb»). Где число снято на глаз, это
// сказано рядом.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('./movement')
const { bestWeapon } = require('./items')
const { withTimeout, placeBlockAt, pickFiller, towerUp } = require('./build')
const threats = require('./threats')
const { blockName, solid, stepSafe: stepSafeRaw, wantsJump, keyDir } = require('./moves')
const flee = require('./flee')
const { shoot: bowShoot } = require('./bow')
const throwMod = require('./throw')
const fortify = require('./fortify')
const tools = require('./tools')
// Честный удар: бить только то, что клиент игры взял бы в прицел (pick.js).
const pick = require('./pick')
const hazards = require('./hazards')
// Края и пустота (2026-09-25: бот упал в дыру арены в небе): рефлекс на
// каждый тик, куда кинет удар, ведро воды.
const edges = require('./edges')
const { raySees } = require('./perception')
const assess = require('./assess')
const arrows = require('./arrows')
// Темп (2026-09-25): когда есть и пить, вскрытая коробка, план начала, наказание занятого.
const tempo = require('./tempo')
// Ядро ближнего боя (2026-09-26): заряд по тикам сервера, спринт-удар и W/S-tap
// по тикам, ×0.6 себе, hit-select и jump-reset, атрибут-свап, щит по таймингу.
const melee = require('./melee')
// Тотем по событию 35 и заранее под смертельный удар (2026-09-26).
const totemMod = require('./totem')
// Стояние на столбах: мост к нему или спуск, где падение дешёвое (2026-09-26).
const bridge = require('./bridge')
// Булава и заряды ветра (2026-09-26): удар с падения, толчок, защита от булавы.
const mace = require('./mace')
// Человек в бою (2026-09-26): стойка до сшибки, жесты, финты, фазы, засада.
const showman = require('./showman')
// Чтение врага и дальний бой (2026-09-26): поглощение, эффекты по частицам, его
// тотем, выбитый щит, заряженный арбалет (read.js); свой арбалет, фейерверки,
// выбор стрел (ranged.js).
const read = require('./read')
const ranged = require('./ranged')
const { canUseRanged } = require('./play-policy')
// Копьё 1.21.11 (2026-09-26): укол STAB по лучу 2.0–4.5, разгон спринтом.
const spear = require('./spear')
// 1 против 2 (2026-09-26): оба спереди, в линию, фокус слабого, рывок из-под
// двоих, паутина под второго (duo.js).
const duoMod = require('./duo')
// Подручное (2026-09-26): удочка, трезубец, хорус, ловушки (utility.js).
const utilityMod = require('./utility')
// Элитры (elytra.js, 2026-09-26): уход лечиться в воздух, пике с булавой;
// против летуна — стрелять в его рамку 0.6, щит или шаг из-под пике.
const elytra = require('./elytra')
// «Динамит» (boom.js, 2026-09-26): вагонетки с TNT под горящую стрелу,
// кристаллы на обсидиане; от его взрывчатки — разобрать, ударить первым, уйти.
const boom = require('./boom')
// Кристаллы Края (crystal.js, 2026-09-30): кристалл у его ног и удар, заранее в
// его окно неуязвимости, «поставил — отошёл — стрела», сбить его кристалл,
// отойти, обсидиан вокруг ног. Кристаллы у boom.js тогда не берутся.
const crystal = require('./crystal')

const TICK_MS = 50
// Дальность удара — от глаз до хитбокса цели. Ванильный клиент бьёт на 3.0;
// 2.9 оставляет запас на то, что цель сдвинется между нашим расчётом и пакетом.
const HIT_REACH = 2.9
// Сколько считаем за чужую дальность. Человек с хорошим пингом достаёт на все
// 3.0, и отход в перезарядке должен выводить из-под неё с запасом.
const THEIR_REACH = 3.4
// Дальше этого тело ведёт pathfinder: клавишами по прямой через рельеф не
// пройти. Ближе — только клавиши.
const FAR = 7
const EYE = 1.62
// Сколько строится укрытие (placeBlockAt: взгляд, пакет, ответ сервера —
// 3–5 тиков на блок): колонна 1×2 и стенка 3×2.
const COVER_MS = 500
const COVER_WIDE_MS = 1500
// Запас к чужой дальности при отходе в перезарядке.
const REACH_MARGIN = 0.7
// Крит — ждать спуска в любом подъёме (его удар подкинул, jump-reset), а не
// только после своего прыжка за критом (2026-09-26); ND_CRIT_ANY_RISE=0 — как
// раньше (прогон «до»).
const CRIT_ANY_RISE = process.env.ND_CRIT_ANY_RISE !== '0'
// Качество боя (2026-09-26, жалобы пользователя на живые дуэли: «зависают,
// стоят вдвоём», «смотрел вниз и ставил блоки, а его забивали», «вдвоём пьют и
// смотрят друг на друга»): стройка не под его рукой и брошенная под ударами,
// нажим после тишины, наказание едока вместо своего глотка, стенка перед
// глотком. ND_FIGHTFIX=0 — как раньше (прогон «до»); счёт тот же.
const FIX = process.env.ND_FIGHTFIX !== '0'
// Сколько строится: коробка — центровка до 0.7 с и 10 блоков по 0.15–0.25 с
// (fortify.boxIn), столб — прыжок до +1.1 (~7 тиков) и блок (build.towerUp).
const BOX_MS = 2500
// Коробка ставится лицом к нему первым (fortify.boxPlan): центровка и два
// блока лица — ~0.9 с; дальше, чтобы достать, ему обходить к открытой стороне,
// а она закрывается раньше, чем он обойдёт. Удар сквозь стенку закрыт
// (pick.js, 2026-09-26), и коробка теперь держит по-настоящему — строить её
// можно, если он не успеет к лицу (раньше ждали всю стройку, 2.5 с, и в дуэли
// коробка не вставала ни разу: try-duelbox «не строю — он достанет»).
const BOX_FRONT_MS = 1300
const PILLAR_MS = 400
// Сколько тиков до первого шага вниз при вертикальной скорости vy (б/т):
// prismarine-physics как LivingEntity.travel — шаг на vy, потом (vy − 0.08)·0.98.
function ticksToFall (vy) {
  let n = 1
  let v = vy
  while (v >= -1e-3 && n < 30) { v = (v - 0.08) * 0.98; n++ }
  return n
}

// Перезарядка удара = 20 / attack_speed тиков (minecraft.wiki «Attack cooldown»),
// плюс тик запаса: сервер считает свои тики, и удар на полтика раньше — это
// 20% урона вместо 100%.
const LAG_MS = 50
function cooldownMs (item) {
  return baseCooldownMs(item) + LAG_MS
}
function baseCooldownMs (item) {
  // Кулак заряжается за 5 тиков, но цель после удара неуязвима 10 тиков, и
  // удар в это окно пропадает. Значит, для кулака шаг — 10 тиков.
  if (!item) return 500
  const n = item.name
  if (/_sword$/.test(n)) return 625 // 1.6
  if (/^(wooden|stone)_axe$/.test(n)) return 1250 // 0.8
  if (n === 'iron_axe') return 1111 // 0.9
  if (/_axe$/.test(n)) return 1000 // золото, алмаз, незерит: 1.0
  if (/_pickaxe$/.test(n)) return 833 // 1.2
  if (/_shovel$/.test(n)) return 1000
  if (n === 'wooden_hoe' || n === 'golden_hoe') return 1000
  if (n === 'stone_hoe') return 500
  if (n === 'iron_hoe') return 333
  if (/_hoe$/.test(n)) return 500
  if (n === 'trident') return 909
  if (n === 'mace') return 1667
  return 500
}

// Порядок реестра зелий 1.21 (Potions.java регистрирует их в этом порядке, а
// компонент potion_contents несёт номер в реестре).
const POTIONS = [
  'water', 'mundane', 'thick', 'awkward', 'night_vision', 'long_night_vision',
  'invisibility', 'long_invisibility', 'leaping', 'long_leaping', 'strong_leaping',
  'fire_resistance', 'long_fire_resistance', 'swiftness', 'long_swiftness',
  'strong_swiftness', 'slowness', 'long_slowness', 'strong_slowness',
  'turtle_master', 'long_turtle_master', 'strong_turtle_master', 'water_breathing',
  'long_water_breathing', 'healing', 'strong_healing', 'harming', 'strong_harming',
  'poison', 'long_poison', 'strong_poison', 'regeneration', 'long_regeneration',
  'strong_regeneration', 'strength', 'long_strength', 'strong_strength',
  'weakness', 'long_weakness', 'luck', 'slow_falling', 'long_slow_falling',
  'wind_charged', 'weaving', 'oozing', 'infested'
]

function potionOf (item) {
  if (!item || !/potion$/.test(item.name)) return null
  const c = item.componentMap && item.componentMap.get('potion_contents')
  const d = c && c.data
  if (!d) return null
  const raw = d.potionId ?? d.potion ?? d.id
  if (typeof raw === 'number') return POTIONS[raw] || null
  if (typeof raw === 'string') return raw.replace(/^minecraft:/, '')
  // Форма компонента в prismarine-item менялась от версии к версии; имя
  // зелья в нём всё равно где-то лежит строкой.
  const s = JSON.stringify(d)
  const hit = POTIONS.slice().sort((a, b) => b.length - a.length).find(p => s.includes(p))
  return hit || null
}

// Что это зелье делает в бою. base — имя без long_/strong_.
function potionRole (name) {
  if (!name) return null
  const base = name.replace(/^(long|strong)_/, '')
  if (base === 'healing') return 'heal'
  if (base === 'regeneration') return 'regen'
  if (['strength', 'swiftness', 'fire_resistance', 'turtle_master', 'invisibility'].includes(base)) return 'buff'
  if (['harming', 'poison', 'slowness', 'weakness'].includes(base)) return 'debuff'
  return null
}

function findItem (bot, test) {
  return bot.inventory.items().find(test) || null
}

// Сколько такого предмета везде, включая руку (она тоже слот инвентаря).
function countOf (bot, name) {
  return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
}

function findPotion (bot, kind, role) {
  return findItem(bot, i => i.name === kind && potionRole(potionOf(i)) === role)
}

// Что осталось из расходников после боя — мозгу решать, лезть ли снова.
function leftovers (bot) {
  const out = {}
  for (const i of bot.inventory.items()) {
    let key = null
    if (/golden_apple$/.test(i.name)) key = i.name
    else if (i.name === 'ender_pearl' || i.name === 'totem_of_undying' || i.name === 'cobweb' || /arrow$/.test(i.name)) key = i.name
    else if (/potion$/.test(i.name)) key = `${i.name}:${potionOf(i) || '?'}`
    if (key) out[key] = (out[key] || 0) + i.count
  }
  return Object.keys(out).length ? out : undefined
}

function hasEffect (bot, name) {
  try {
    const eff = bot.registry.effectsByName[name]
    if (!eff) return false
    return !!(bot.entity.effects && bot.entity.effects[eff.id])
  } catch { return false }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// От глаз наблюдателя до ближайшей точки хитбокса цели.
function reachFrom (eye, e) {
  const hw = (e.width || 0.6) / 2
  const h = e.height || 1.8
  const p = e.position
  const cx = clamp(eye.x, p.x - hw, p.x + hw)
  const cy = clamp(eye.y, p.y, p.y + h)
  const cz = clamp(eye.z, p.z - hw, p.z + hw)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

function livingFlags (bot, e) {
  try {
    const keys = bot.registry.entitiesByName.player.metadataKeys
    const i = keys.indexOf('living_entity_flags')
    const f = e.metadata[i >= 0 ? i : 8]
    return typeof f === 'number' ? f : 0
  } catch { return 0 }
}

// Что противник держит в руке, которой сейчас пользуется, если пользуется.
function usingItem (bot, e) {
  const f = livingFlags(bot, e)
  if (!(f & 0x01)) return null
  const eq = e.equipment || []
  const it = (f & 0x02) ? eq[1] : eq[0]
  return it ? it.name : 'что-то'
}

const EDIBLE = /apple|beef|pork|chicken|mutton|rabbit|cod|salmon|bread|potato|carrot|stew|soup|cookie|melon|berries|pie|potion|honey|kelp|chorus/

function onFire (bot) {
  try { return (bot.entity.metadata[0] & 0x01) !== 0 } catch { return false }
}

// blockName, solid, stepSafe, wantsJump, keyDir — в moves.js (общие с побегом).
// В бою в воду не шагаем: медленно и без критов. Горим или уже в воде —
// можно (выплыть, потушиться).
function stepSafe (bot, dir) {
  return stepSafeRaw(bot, dir, { water: onFire(bot) || !!(bot.entity && bot.entity.isInWater) })
}
// Упреждение: где цель будет через ticks тиков, по её скорости из двух
// последних позиций.
// Скорость — не по двум последним точкам, а средняя за ~0.6 с. Стрейфящий
// противник (человек, паук) дёргается влево-вправо, и мгновенная скорость
// каждый тик показывает в новую сторону: упреждение по ней отправляло стрелу
// туда, куда он дёрнулся, а не туда, где он будет. Среднее за окно гасит
// колебания (целимся в середину его стрейфа) и честно показывает, куда он
// реально идёт. Для ровно идущего моба это та же скорость.
const TRACK_WINDOW_MS = 600
function makeTracker (entity) {
  const hist = []
  let vel = { x: 0, y: 0, z: 0 }
  return {
    update () {
      const now = gameClock.now()
      const p = entity.position
      const last = hist[hist.length - 1]
      if (!last || now - last.t >= 40) hist.push({ x: p.x, y: p.y, z: p.z, t: now })
      while (hist.length > 2 && now - hist[0].t > TRACK_WINDOW_MS) hist.shift()
      const a = hist[0]
      const b = hist[hist.length - 1]
      const dt = (b.t - a.t) / 50
      if (dt > 0.5) vel = { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt }
    },
    vel: () => vel,
    at (ticks) {
      const p = entity.position
      return new Vec3(p.x + vel.x * ticks, p.y + vel.y * ticks, p.z + vel.z * ticks)
    }
  }
}

function yawTo (from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

// ---------------------------------------------------------------- профиль
//
// С кем дерёмся. Микро то же — удар с края своей дальности, отход в
// перезарядке, крит в прыжке, — но числа и запреты разные. Зомби достаёт
// рукой на ~1.4 блока от хитбокса до хитбокса (атака моба по раздутому на
// ~0.8 боксу, minecraft.wiki «Zombie»), а мы — на 2.9: бьём и отступаем,
// и он не отвечает вовсе. Человек достаёт на все 3.
const UNDEAD = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged',
  'wither_skeleton', 'zombified_piglin', 'zoglin', 'phantom', 'skeleton_horse', 'zombie_horse', 'wither'])
const FIRE_IMMUNE = new Set(['blaze', 'magma_cube', 'wither_skeleton', 'ghast', 'strider', 'zombified_piglin',
  'zoglin', 'hoglin', 'piglin', 'piglin_brute', 'warden', 'wither', 'ender_dragon'])
const WEB_IMMUNE = new Set(['spider', 'cave_spider'])
const RANGED_MOBS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'drowned',
  'breeze', 'shulker', 'evoker', 'guardian', 'elder_guardian', 'piglin'])
const MOB_REACH = {
  zombie: 2.2, husk: 2.2, drowned: 2.2, zombie_villager: 2.2, zombified_piglin: 2.2,
  skeleton: 2.2, stray: 2.2, bogged: 2.2, wither_skeleton: 2.6,
  spider: 2.6, cave_spider: 2.0, enderman: 2.8, vindicator: 2.4, piglin_brute: 2.4,
  hoglin: 2.8, zoglin: 2.8, ravager: 3.4, iron_golem: 3.2, slime: 2.6, magma_cube: 2.6,
  silverfish: 1.6, endermite: 1.6, witch: 2.0, creeper: 3.2
}

function isPlayer (e) { return !!e && (e.type === 'player' || !!e.username) }

function profileOf (e) {
  if (isPlayer(e)) return { player: true, theirReach: THEIR_REACH }
  const n = e.name
  return {
    player: false,
    theirReach: MOB_REACH[n] ?? 2.4,
    undead: UNDEAD.has(n),
    fireImmune: FIRE_IMMUNE.has(n),
    webImmune: WEB_IMMUNE.has(n),
    ranged: RANGED_MOBS.has(n),
    creeper: n === 'creeper',
    flying: FLYERS.has(n)
  }
}
const FLYERS = new Set(['ghast', 'phantom', 'vex', 'blaze', 'allay', 'bee', 'wither', 'ender_dragon'])

// Следующий враг рядом — для зачистки: убил одного, не стоим, пока второй
// бьёт в спину.
const FOES = new Set([...Object.keys(MOB_REACH), 'blaze', 'ghast', 'pillager', 'evoker', 'vex', 'breeze',
  'guardian', 'phantom', 'warden', 'shulker', 'piglin', 'creaking'])
// Мёртвый моб ещё около секунды числится в мире (анимация смерти), и выбор
// «следующего» раз за разом возвращал только что убитого — бот терял его из
// виду и выходил из боя, оставив живых. dead — id убитых в этом бою.
function nextFoe (bot, radius, dead = null) {
  const me = bot.entity.position
  return bot.nearestEntity(e => e && e.position && FOES.has(e.name) && e.name !== 'iron_golem' &&
    e.position.distanceTo(me) < radius && e.isValid !== false && !(dead && dead.has(e.id)) && !lookDead(bot, e) &&
    assess.inSight(bot, e)) || null
}

// Здоровье из метаданных (ванильный сервер шлёт его всем, кто видит сущность).
// У игрока — вместе с поглощением (read.js, 2026-09-26: метаданные
// player_absorption): золотое яблоко +4, тотем +8, зачарованное +16 — это тоже
// его здоровье в решениях «добивать или отходить» и «кого бить из двоих».
function healthOf (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' ? h + read.absorptionOf(bot, e) : null
  } catch { return null }
}

// Здоровье из метаданных, если сервер его прислал: 0 — умирает.
function lookDead (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' && h <= 0
  } catch { return false }
}

function creeperSwelling (bot, e) {
  try {
    const keys = bot.registry.entitiesByName.creeper.metadataKeys
    const i = keys.indexOf('swell_dir')
    return e.metadata[i >= 0 ? i : 16] === 1
  } catch { return false }
}

// Мобы, которых боец бьёт, не дожидаясь приказа (2026-09-27, пользователь:
// «выпал вниз — ночью бьют мобы, а он даже не сопротивляется; уничтожать
// любую угрозу, не только соперника»). Нейтральные — только если уже били
// нас. Варден и гаст — не сюда: первого не убить, второго не достать.
const HOSTILE_MOB = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|bogged|wither_skeleton|spider|cave_spider|creeper|witch|slime|magma_cube|silverfish|endermite|phantom|pillager|vindicator|evoker|vex|ravager|piglin_brute|hoglin|zoglin|blaze|breeze|guardian|shulker)$/
const ANGRY_IF_HIT = /^(enderman|zombified_piglin|piglin|polar_bear|wolf|bee)$/

// ------------------------------------------------------------------- duel

async function duel (session, ctl, entity, opts = {}) {
  const safety = opts.guard?.safety || require('./combat-safety').watch(session.bot)
  try { return await duelBody(session, ctl, entity, { ...opts, safety }) } finally {
    if (!opts.guard?.safety) safety.close()
  }
}

async function duelBody (session, ctl, entity, opts = {}) {
  const rangedAllowed = () => canUseRanged(session, entity, opts)
  const bot = session.bot
  const {
    retreatAtHealth = 4,
    timeoutSeconds = 60,
    guard = null,
    // Бой-реванш заканчивается, когда человек перестал бить и ушёл: бот
    // злится, но не маньяк. Для боя, заказанного мозгом, не задаётся.
    calmAfterMs = 0,
    healAt = 10,
    // Убил — брать следующего врага в этом радиусе, а не возвращаться.
    clearArea = 0,
    // Поле арены (arena.js): {x, y, z, r} — центр, уровень ног на полу,
    // полуразмер квадрата поля.
    arena = null
  } = opts
  let label = entity.username || entity.name
  const deadline = gameClock.now() + Math.min(300, timeoutSeconds) * 1000
  let track = makeTracker(entity)
  let prof = profileOf(entity)
  const kills = []
  let backOffUntil = 0
  let fleeingSwell = false
  let swellPlan = null
  let swellPlanAt = 0
  let seenAt = gameClock.now()
  let unseen = false
  let repositionUntil = 0
  let stuckTicks = 0

  const st = {
    swings: 0,
    cutFails: 0,
    landed: 0,
    crits: 0,
    sprintHits: 0,
    axeOnShield: 0,
    dodges: 0,
    tricks: {},
    healed: [],
    hpStart: Math.round(bot.health ?? 20)
  }
  // Лента решений (ND_TRACE_PVP=1): время от начала боя, приём, где я и где он —
  // чтобы по логу восстановить цепочку («сломал стену → убежал → столб → вниз»).
  const traceT0 = gameClock.now()
  const used = (what) => {
    st.tricks[what] = (st.tricks[what] || 0) + 1
    if (process.env.ND_TRACE_PVP) {
      try {
        const m = bot.entity.position; const h = entity && entity.position
        console.log(`[trace] ${bot.username} +${((gameClock.now() - traceT0) / 1000).toFixed(1)}s ${what} | я ${m.x.toFixed(1)},${m.y.toFixed(1)},${m.z.toFixed(1)} хп ${Math.round(bot.health ?? 0)}${h ? ` | он ${h.x.toFixed(1)},${h.y.toFixed(1)},${h.z.toFixed(1)} d=${m.distanceTo(h).toFixed(1)}` : ''}`)
      } catch {}
    }
  }
  // Счёт качества боя (2026-09-26, жалобы «стоят вдвоём, ничего не
  // происходит», «вдвоём пьют и смотрят друг на друга», «ставил блоки под
  // собой, а его забивали»): окна без размена ударами, оба пьют разом,
  // стройка под его рукой. Только счёт — поведение ниже, под FIX.
  const quiet = { at: gameClock.now(), gaps10: 0, total10: 0, longest: 0 }
  const noteExchange = () => {
    const now = gameClock.now()
    const gap = now - quiet.at
    if (gap >= 10000) { quiet.gaps10++; quiet.total10 += gap }
    if (gap > quiet.longest) quiet.longest = gap
    quiet.at = now
  }
  const ovl = { ms: 0, n: 0, at: gameClock.now(), was: false }
  st.build = { box: 0, pillar: 0, counter: 0, pit: 0, boxHot: 0, pillarHot: 0, counterHot: 0, pitHot: 0, aborted: 0, refused: 0, boxMs: [] }
  st.eatPunish = { tries: 0, swaps: 0 }

  // Характер на этот бой. Два одинаковых бота с одинаковым китом делали одно и
  // то же в один тик (живой прогон: оба закрылись в коробки одновременно) —
  // скучно и предсказуемо. Пороги и реакции — с разбросом, решения — с
  // долей случая, как у живого игрока.
  const style = {
    aggression: 0.35 + Math.random() * 0.6, // кидаться ли в окна (ест, прячется)
    reactMs: 80 + Math.random() * 220, // заметил — через сколько ответил
    fortAt: healAt + Math.round(Math.random() * 5) - 2, // когда в коробку
    patchBudget: 3 + Math.floor(Math.random() * 6), // сколько блоков латать в осаде
    boxPatienceMs: 15000 + Math.random() * 25000, // сколько сидеть в коробке
    punchLimit: 4 + Math.floor(Math.random() * 4), // сколько прорубать без удара
    pressMs: 5000 + Math.random() * 1500 // сколько терпеть без размена до нажима (FIX)
  }
  st.style = { агрессия: Math.round(style.aggression * 100) / 100, реакцияМс: Math.round(style.reactMs), коробкаНа: style.fortAt }
  // Темп (tempo.js): задержка старта — два одинаковых бота не начинают в один
  // тик (арена 2026-09-25: оба «выпил strength, swiftness, regeneration»
  // подряд); слежка за тем, чем занят враг, — на событиях, не в цикле.
  style.openDelayMs = Math.round(Math.random() * (FIX ? 1200 : 700))
  const tt = tempo.track(bot, {
    threats: () => [entity, ...[...attackers.values()].filter(a => gameClock.now() - a.at < 8000).map(a => a.e)],
    reactMs: style.reactMs
  })
  session.tempo = tt
  // Чтение врага (read.js, 2026-09-26): его тотем (событие 35), выбитый щит,
  // заряженный арбалет, поглощение и эффекты. tempo.punish по tt.read видит окно
  // «всё в ход» после его тотема; итог — в отчёт боя, в tricks.
  const foe = read.watch(bot, { threats: tt.threats })
  tt.read = foe
  // Копьё (spear.js): он «обнял» ближе 2 блоков — ход мечу до этого времени.
  let spearOffUntil = 0
  {
    const close0 = tt.close
    let closed = false
    tt.close = () => {
      close0()
      if (closed) return
      closed = true
      foe.close()
      const fsx = foe.stats
      if (fsx.pops) st.tricks[`враг: сработал тотем ×${fsx.pops}`] = 1
      if (fsx.shieldBreaks) st.tricks[`враг: щит выбит ×${fsx.shieldBreaks}`] = 1
      if (fsx.aimedAtMe) st.tricks[`враг: заряженный арбалет на мне ×${fsx.aimedAtMe}`] = 1
      if (fsx.absorb) st.tricks[`враг: поглощение до ${Math.round(fsx.absorb)}`] = 1
      const effs = Object.keys(fsx.effects)
      if (effs.length) st.tricks['враг: эффекты ' + effs.join(', ')] = 1
      if (st.xbow && (st.xbow.shots || st.xbow.loads)) st.tricks[`арбалет: выстрелов ${st.xbow.shots || 0}, попал ${st.xbow.hits || 0}, зарядок ${st.xbow.loads || 0}`] = 1
    }
  }
  // Сидим в целой коробке — рукой и стрелой не достать.
  const fortSealed = () => !!(fort && fortify.enclosure(bot, fort.cell).sealed)
  // Когда что впервые заметили: реакция — не в тот же тик.
  const noticed = {}
  const after = (key, cond, ms = style.reactMs) => {
    if (!cond) { delete noticed[key]; return false }
    if (!noticed[key]) noticed[key] = gameClock.now()
    return gameClock.now() - noticed[key] >= ms
  }
  // Бросок кубика на событие (одно решение на одно «он начал есть»).
  const rolls = {}
  const roll = (key, cond, p) => {
    if (!cond) { delete rolls[key]; return false }
    if (!(key in rolls)) rolls[key] = Math.random() < p
    return rolls[key]
  }
  let punches = 0

  let weapon = bestWeapon(bot)
  let nextReady = 0
  let lastSwing = 0
  let swingCrit = false
  let lastHurtByTarget = gameClock.now()
  let killed = false
  let strafeKey = Math.random() < 0.5 ? 'left' : 'right'
  let strafeFlipAt = 0
  let dodgeUntil = 0
  let dodgeKey = null
  // Щит от его заряженного арбалета держим ещё немного после прицела (ниже).
  let cbShieldUntil = 0
  // Он отпустил тетиву — стрела уже летит. Сами стрелы сервер присылает
  // редко (обновление раз в 20 тиков, исследование исходников 1.21.11), и по
  // летящей стреле уклон не успевает; человек смотрит на натяжение. Натягивал
  // дольше 0.35 с и перестал — это выстрел.
  let theirDrawAt = 0
  const sawRelease = () => {
    const using = usingItem(bot, entity)
    if (using === 'bow') { if (!theirDrawAt) theirDrawAt = gameClock.now(); return false }
    const shot = theirDrawAt && gameClock.now() - theirDrawAt > 350
    theirDrawAt = 0
    return !!shot
  }
  let jumpedForCrit = false
  // Ядро ближнего боя (melee.js): часы заряда по тикам, план клавиш по тикам,
  // отброс, свап; тотем по событию (totem.js). hitKind — чем бьём следующий
  // удар ('sprint' | 'crit' | 'plain'), выбирается раз на замах.
  // jump-reset к нему — не через яму между нами (FIX, edges.dropAlong: линия к
  // нему на 2.6 — прыжок со спринтом); яма за спиной — прыжок, наоборот, гасит толчок.
  const mf = melee.fight(bot, { target: () => entity, jumpOk: (e) => !(FIX && e && e.position && bot.entity && edges.dropAlong(bot, bot.entity.position.plus(bot.entity.position.minus(e.position)), 2.6)) })
  const tot = totemMod.install(bot)
  // Счёт itemuse.js — на весь демон; в отчёт боя — разница с началом боя.
  const use0 = bot._ndUse ? { ...bot._ndUse.stats } : null
  let hitKind = null
  let firstHitDone = false
  let totemAt = 0
  let maceTotem = false
  let selectSince = 0
  // Ответный удар (hit-select, PVP-RESEARCH в.4 п.4): его толчок пришёл, наш
  // заряд > 0.9 и он в руке — бьём в этот же тик: наш ×0.6 гасит 40% его
  // толчка, а он получает наш целиком. Не в поднятый щит, не с предметом в
  // ходу (удар бы съелся), только по человеку.
  mf.setCounter((e) => {
    if (!prof.player || e !== entity || !bot.entity) return false
    if (reachFrom(bot.entity.position.offset(0, EYE, 0), e) > HIT_REACH) return false
    if (mf.clock.charge(0) <= 0.9 || usingItem(bot, e) === 'shield') return false
    const use = bot._ndUse
    if (use && (use.cur || gameClock.now() - (use.endedAt || 0) < mf.clock.msPerTick)) return false
    const sprintHit = mf.clock.srvSprint
    mf.hit(e, { after: sprintHit ? 'wtap' : null, kind: 'counter' })
    st.swings++
    lastSwing = gameClock.now()
    firstHitDone = true
    hitKind = null
    used('ответный удар на его удар')
    return true
  })
  const cd = {} // когда какой приём снова можно
  const ready = (k) => gameClock.now() >= (cd[k] || 0)
  const rest = (k, ms) => { cd[k] = gameClock.now() + ms }

  let targetHurtAt = 0
  let shieldUpAt = 0
  let shieldDownAt = 0
  const onHurt = (victim, source) => {
    if (victim === entity) targetHurtAt = gameClock.now()
    // Размен между нами — в любую сторону (рука, стрела, зелье): счёт тишины и нажим.
    if (source && bot.entity && ((victim === entity && source.id === bot.entity.id) || (victim === bot.entity && source.id === entity.id))) noteExchange()
    if (victim === entity && source === bot.entity) {
      st.landed++
      if (gameClock.now() - lastSwing < 400 && swingCrit) st.crits++
    }
    if (victim === bot.entity && source && source.id === entity.id) lastHurtByTarget = gameClock.now()
    // Кто ещё нас бьёт, кроме цели: вдвоём на одного второй лупил в спину,
    // пока бот гонялся за первым (арена 2026-09-25, двое против бота).
    // Не сам себе обидчик: своё зелье вреда/свой огонь приходят с source = мы,
    // бот разворачивался на себя и бил — сервер кикал «неверная сущность»
    // (latest.log 2026-09-25, четыре вылета с арены).
    if (victim === bot.entity && source && isPlayer(source) && source.id !== entity.id && source.id !== bot.entity.id && source.username !== bot.username) {
      const a = attackers.get(source.id) || { e: source, n: 0 }
      a.at = gameClock.now(); a.n++; a.e = source
      attackers.set(source.id, a)
    }
  }
  const attackers = new Map()
  let switchedAt = 0
  // Самый опасный из тех, кто бил последние 4 с и ещё жив рядом.
  const otherAttacker = () => {
    const now = gameClock.now()
    let best = null
    for (const [id, a] of attackers) {
      const e = a.e
      if (now - a.at > 4000 || !e || e.isValid === false || dead.has(id) || lookDead(bot, e) || e.id === entity.id) continue
      const dist = e.position.distanceTo(bot.entity.position)
      if (dist > 14) continue
      const score = (now - a.at) / 1000 + dist / 3 - a.n * 0.3
      if (!best || score < best.score) best = { e, dist, score }
    }
    return best
  }
  const dead = new Set()
  const onDead = (e) => { if (e) dead.add(e.id); if (e === entity) killed = true }
  // Своя смерть посреди долгого дела (подъём, добыча): после возрождения хп
  // снова 20, и цикл «возвращался на поле» с точки возрождения мира (живая
  // арена 2026-09-27). Смерть — конец боя.
  let selfDied = false
  const onSelfDeath = () => { selfDied = true }
  bot.on('death', onSelfDeath)
  // Мобы (HOSTILE_MOB): кто бил нас последние 5 с — и кто подошёл бить.
  const mobHits = new Map()
  const onMobHurt = (victim, source) => {
    try {
      if (victim !== bot.entity || !source || isPlayer(source)) return
      const nm = source.name || ''
      if (HOSTILE_MOB.test(nm) || ANGRY_IF_HIT.test(nm)) mobHits.set(source.id, gameClock.now())
    } catch {}
  }
  bot.on('entityHurt', onMobHurt)
  let mobDetour = null
  let mobCheckAt = 0
  const mobThreat = () => {
    if (!bot.entity) return null
    const me = bot.entity.position
    const eyeM = me.offset(0, EYE, 0)
    const now = gameClock.now()
    let best = null
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position || isPlayer(e)) continue
      const nm = e.name || ''
      const hitting = now - (mobHits.get(e.id) || 0) < 5000
      if (!HOSTILE_MOB.test(nm) && !(hitting && ANGRY_IF_HIT.test(nm))) continue
      if (dead.has(e.id) || lookDead(bot, e)) continue
      const dist = e.position.distanceTo(me)
      if (dist > (hitting ? 14 : 6)) continue
      const close = dist < (nm === 'creeper' ? 5 : 4)
      if (!hitting && !close) continue
      // Не бил и за стеной — не отвлекаться.
      if (!hitting && !raySees(bot, eyeM, e.position.offset(0, (e.height || 1.8) * 0.6, 0))) continue
      const score = dist - (hitting ? 4 : 0) - (nm === 'creeper' ? 3 : 0)
      if (!best || score < best.score) best = { e, dist, hitting, score }
    }
    return best
  }
  // ctl для долгих дел внизу (добыча блоков): моб рядом — бросить, цикл его убьёт.
  const mobCtl = { get aborted () { return ctl.aborted || !!mobThreat() }, onAbort: ctl.onAbort, abort: () => ctl.abort() }
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  // 1 против 2 (duo.js, 2026-09-26): кто второй (и между кусками боя), фокус,
  // клещи, линия, рывок; счёт «оба достают / клещи» — и при ND_DUO=0.
  const duo = duoMod.create(bot, { target: () => entity, attackers, dead, used, tt, holdWeapon: () => holdWeapon(), setAim: (m) => { aim = m }, potionOf })
  ctl.onAbort.push(() => duo.close())
  // Подручное (utility.js): удочка, трезубец, хорус, ловушки; «меня дёрнули удочкой».
  const util = utilityMod.create(bot, { used, tt })
  ctl.onAbort.push(() => util.close())
  // Отбивание фаерболов — на каждом тике физики, мимо главного цикла: шар
  // проходит 7 блоков за ~6 тиков, а цикл бывает занят луком или зельем, и
  // в живом прогоне ни один шар не был отбит (лог [fireball]: 6.8 -> 2.5 за
  // один шаг цикла). Удар по шару сразу; взгляд на гаста — чтобы полетел в него.
  const swatted = new Map()
  const onTickSwat = () => {
    try {
      if (!bot.entity) return
      const eyeNow = bot.entity.position.offset(0, EYE, 0)
      for (const fb of Object.values(bot.entities)) {
        if (!fb || fb.name !== 'fireball' || !fb.position) continue
        const rr = reachFrom(eyeNow, fb)
        if (rr > 3.0) continue
        const last = swatted.get(fb.id) || 0
        if (gameClock.now() - last < 150) continue
        swatted.set(fb.id, gameClock.now())
        const g = bot.nearestEntity(e => e && e.name === 'ghast' && e.position && e.position.distanceTo(bot.entity.position) < 64)
        if (g) {
          const tgt = g.position.offset(0, 2, 0)
          const dx = tgt.x - eyeNow.x; const dy2 = tgt.y - eyeNow.y; const dz = tgt.z - eyeNow.z
          bot.look(Math.atan2(-dx, -dz), Math.atan2(dy2, Math.hypot(dx, dz)), true).catch(() => {})
        }
        bot.attack(fb)
        used('отбил фаербол')
      }
      if (swatted.size > 64) swatted.clear()
    } catch {}
  }
  bot.on('physicsTick', onTickSwat)

  // Натяжение его лука и заряд арбалета — по тикам, мимо главного цикла:
  // стройка столба держит цикл, а решать «блок сейчас или щит» надо по фазе
  // его натяжения (towerShield). drawAt — когда начал тянуть; shots / shotAt —
  // его стрелы (по их рождению); loadedAt / xbowShotAt — заряд арбалета.
  const bowWatch = { drawAt: 0, shotAt: 0, shots: 0, seen: -1, loadedAt: 0, xbowShotAt: 0 }
  const arrowLog = arrows.track(bot)
  const onTickArcher = () => {
    try {
      if (!entity.isValid || !prof.player) return
      const now = gameClock.now()
      // Выстрел — по рождению его стрелы (arrows.track): флаги и предмет в руке
      // запаздывают и теряются (сцена «две дыры» 2026-09-27: из 4 попаданий
      // натяжение с луком в руке видно одно).
      const sh = arrowLog.shots.get(entity.id)
      const n = sh ? sh.n : 0
      if (bowWatch.who !== entity.id) { bowWatch.who = entity.id; bowWatch.seen = n; bowWatch.drawAt = 0; bowWatch.loadedAt = 0 }
      // Выстрелил — следующее натяжение с нуля (флаги между выстрелами могут
      // не опуститься: пакеты за один тик).
      if (n > bowWatch.seen) { bowWatch.shots += n - bowWatch.seen; bowWatch.seen = n; bowWatch.shotAt = sh.at; bowWatch.drawAt = 0; bowWatch.lastU = null }
      // Тянет: рука занята, в руке лук — или предмет не виден, а он уже стрелял.
      const f = livingFlags(bot, entity)
      const eq0 = entity.equipment && entity.equipment[0] ? entity.equipment[0].name : null
      const uNow = (f & 0x01) && !(f & 0x02) && (eq0 === 'bow' || (!eq0 && bowWatch.shots > 0)) ? 'bow' : usingItem(bot, entity)
      if (process.env.ND_DEBUG_TOWER && uNow !== bowWatch.lastU) { console.log('[bowWatch]', JSON.stringify({ u: uNow, flags: livingFlags(bot, entity), eq0: entity.equipment && entity.equipment[0] ? entity.equipment[0].name : null })); bowWatch.lastU = uNow }
      if (uNow === 'bow') { if (!bowWatch.drawAt && now - bowWatch.shotAt > 60) bowWatch.drawAt = now } else bowWatch.drawAt = 0
      const hand = entity.equipment && entity.equipment[0]
      const cb = hand && hand.name === 'crossbow' ? read.crossbowInfo(bot, hand) : null
      if (cb && cb.loaded) { if (!bowWatch.loadedAt) bowWatch.loadedAt = now } else if (bowWatch.loadedAt) {
        if (cb) bowWatch.xbowShotAt = now
        bowWatch.loadedAt = 0
      }
    } catch {}
  }
  bot.on('physicsTick', onTickArcher)

  // Пол из-под ног. Человек ломает блок под ботом (или под столбом) — бот
  // стоял, пока не падал вниз (арена 2026-09-25: «не понимает, что его
  // сталкивают»). Видим разрушение по анимации трещин — сходим на целую клетку.
  // Уже падаем высоко — ведро воды под себя.
  let floorEscape = null // { dir: {x,z}, until }
  const safeNeighbor = (feet) => {
    const opts = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const c = feet.offset(dx, 0, dz)
      if (solid(bot, c.offset(0, -1, 0)) && !solid(bot, c) && !solid(bot, c.offset(0, 1, 0))) opts.push({ x: dx, z: dz })
    }
    return opts.length ? opts[Math.floor(Math.random() * opts.length)] : null
  }
  const onCrack = (block, stage, breaker) => {
    try {
      if (!bot.entity || !block || !block.position) return
      if (breaker && breaker.id === bot.entity.id) return
      const feet = bot.entity.position.floored()
      const bp = block.position
      const under = bp.x === feet.x && bp.z === feet.z && bp.y < feet.y && bp.y >= feet.y - 3
      if (!under) return
      const dir = safeNeighbor(feet)
      if (dir) floorEscape = { dir, until: gameClock.now() + 700 }
      if (ready('floorNote')) { rest('floorNote', 3000); used('ломают пол подо мной — схожу') }
    } catch {}
  }
  bot.on('blockBreakProgressObserved', onCrack)
  let groundY = bot.entity ? bot.entity.position.y : 0
  let mlgArmed = false
  const onTickFall = async () => {
    try {
      const e = bot.entity
      if (!e) return
      if (e.onGround || e.isInWater) { groundY = e.position.y; mlgArmed = false; return }
      if (e.velocity.y > -0.3 || groundY - e.position.y < 2) return
      // Сколько до земли.
      let land = null
      for (let k = 1; k < 64; k++) {
        const c = e.position.offset(0, -k, 0).floored()
        if (solid(bot, c)) { land = c; break }
      }
      const fallTotal = land ? groundY - (land.y + 1) : 99
      if (fallTotal < 4) return
      const water = findItem(bot, i => i.name === 'water_bucket')
      if (!water) return
      if (!mlgArmed) { mlgArmed = true; await bot.equip(water, 'hand').catch(() => {}); used('падаю — ведро воды наготове') }
      if (land && e.position.y - (land.y + 1) < 3.2) {
        await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {})
        bot.activateItem()
        used('вода под себя (MLG)')
        groundY = e.position.y
        gameClock.setTimeout(() => { try { const b = findItem(bot, i => i.name === 'bucket'); const w = bot.findBlock({ matching: bb => bb && bb.name === 'water', maxDistance: 3 }); if (b && w) bot.equip(b, 'hand').then(() => bot.activateBlock(w)).catch(() => {}) } catch {} }, 900)
      }
    } catch {}
  }
  // Ведро теперь ставит общий сторож (edges.installFallGuard, на всё время
  // игры): здешний срабатывал на тик раньше, чем надо, — use_item уходил до
  // пакета позиции, и сервер кидал луч с прошлой высоты (арена 2026-09-25:
  // «вода под себя ×2» — и смерть от падения). Этот — только если того нет.
  if (!bot._ndFallGuard) bot.on('physicsTick', onTickFall)
  const onMlg = (e) => {
    if (e.what === 'fired') used('вода под себя (MLG)')
    else if (e.what === 'saved') used('MLG: приземлился в воду')
    else if (e.what === 'missed') used('MLG: промахнулся')
    else if (e.what === 'picked') used('MLG: воду обратно в ведро')
  }
  bot.on('nd_mlg', onMlg)

  // Прицел живёт отдельно от решений: пока цикл ждёт глоток зелья или
  // натяжение лука, голова всё равно должна идти за целью.
  let aim = 'target'
  let aimPoint = null
  // Куда на его рамке целиться, когда грудь за блоком, а голова видна (pick.aim).
  let sightOff = null
  const aimTimer = gameClock.setInterval(() => {
    if (!bot.entity || !entity.isValid) return
    // Оба едят или пьют разом (счёт для арены): мы — предмет в ходу (itemuse.js)
    // или глоток eatHeld, он — метаданные «рука занята» с едой или зельем (tempo).
    try {
      const nowO = gameClock.now()
      const u = bot._ndUse && bot._ndUse.cur
      const k = u ? tempo.useKind(u.name) : null
      const both = prof.player && (session.eating || k === 'eat' || k === 'drink') && !!tt.state(entity).consuming
      if (both) {
        const dtO = Math.min(200, nowO - ovl.at)
        ovl.ms += dtO
        if (!ovl.was) ovl.n++
        // «Пьют и смотрят друг на друга»: на виду и ближе 24 бл.
        if (entity.position.distanceTo(bot.entity.position) < 24 && raySees(bot, bot.entity.position.offset(0, EYE, 0), entity.position.offset(0, (entity.height || 1.8) * 0.55, 0))) ovl.openMs = (ovl.openMs || 0) + dtO
      }
      ovl.was = both
      ovl.at = nowO
    } catch {}
    try {
      // Копает (pathfinder в погоне прорубает стену, кирка по его коробке) —
      // голова на блок, а не на него: человек смотрит, что ломает. Раньше
      // таймер тянул взгляд к цели, и бот рубил стену, глядя в сторону
      // (2026-09-26).
      if (bot.targetDigBlock && bot.targetDigBlock.position) {
        bot.lookAt(bot.targetDigBlock.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
        return
      }
      // Ведёт pathfinder (обход стены, погоня) — голова его: он поворачивает
      // взгляд к следующей точке пути и жмёт «вперёд» туда, куда смотрит. Таймер
      // тянул голову к цели за стеной, и бот шёл в стену, а не в обход
      // (try-unstick 2026-09-26: обсидиан со щелью в 6 блоках — 15 с у стены).
      // Падаем с ведром — голова сторожа падения (edges.installFallGuard): луч
      // use_item берёт поворот из пакета, а таймер между взглядом вниз и
      // пакетом разворачивал его к цели — ведро «срабатывало», воды не было.
      if (pathing || edges.falling(bot)) return
      if (aim === 'target') {
        const p = track.at(2)
        bot.lookAt(sightOff ? p.plus(sightOff) : p.offset(0, (entity.height || 1.8) * 0.75, 0), true).catch(() => {})
      } else if (aim === 'away') {
        const me = bot.entity.position
        const yaw = yawTo(entity.position, me) // от него к нам — туда и бежим
        bot.look(yaw + (Math.random() - 0.5) * 0.6, 0, true).catch(() => {})
      } else if (aim === 'point' && aimPoint) {
        bot.look(aimPoint.yaw, aimPoint.pitch, true).catch(() => {})
      }
    } catch {}
  }, TICK_MS)

  const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
  const clear = () => { for (const k of keys) { try { bot.setControlState(k, false) } catch {} } }
  const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
  // Человек (showman.js, 2026-09-26): стойка, жесты, финты, фазы — поверх
  // характера боя (style); ND_HUMAN=0 — без него (null, крючки ниже молчат).
  const hm = showman.create({
    bot, session, target: () => entity, style, used, set, tt, styleOut: st.style,
    aimTo: (mode, point = null) => { aim = mode; aimPoint = point },
    stopPath: () => { if (pathing) { pathTo(false); pathing = false } },
    stepOk: (k) => stepSafe(bot, keyDir(bot, k)),
    fillerCount: () => { const f = pickFiller(bot); return f ? countOf(bot, f.name) : 0 },
    cover: async (pos) => { const n = await coverFrom(pos, { what: 'засада: колонна между нами' }); await holdWeapon(); return n },
    // Взмах в воздух на Paper сбрасывает заряд (замер try-showman.js swing).
    weaponMs: () => cooldownMs(bot.heldItem),
    onAirSwing: () => { nextReady = Math.max(nextReady, gameClock.now() + cooldownMs(bot.heldItem)) },
    // Жест «прыжки» — не у ямы по линии его толчка (FIX, edges.dropAlong).
    nearDrop: () => { try { return FIX && !!entity.position && edges.dropAlong(bot, entity.position, 4.5) } catch { return false } }
  })
  if (hm) ctl.onAbort.push(() => hm.close())

  const pathTo = (on, goal = null) => {
    try {
      // И pathfinder в погоне — мимо паутины (своей или его).
      const mv = bot.pathfinder.movements
      const webId = bot.registry.blocksByName.cobweb && bot.registry.blocksByName.cobweb.id
      if (on && mv && mv.blocksToAvoid && webId != null) mv.blocksToAvoid.add(webId)
      // Держим арену (он выпал с поля): вместо погони за ним — к точке у
      // поля над ним (holdGoal, цикл ниже).
      if (on && !goal && holdGoal) goal = holdGoal
      if (on) bot.pathfinder.setGoal(goal || new goals.GoalFollow(entity, 2), !goal)
      else bot.pathfinder.setGoal(null)
    } catch {}
  }
  let pathing = false

  // В бою pathfinder не строит, но КОПАЕТ: стену между нами часто быстрее
  // прорубить, чем обходить — A* сам сравнит (блок стоит 1 + 3×секунды копки,
  // шаг — 1: стекло и булыжник рубит, обсидиан обходит). Раньше копание было
  // выключено (бот прорубал стекло арены и не мог вернуться), но теперь он
  // поднимается обратно (edges.climbBack), а пользователь разрешил ломать
  // любые блоки: «упёрлись в стену вдвоём, не ломают и не обходят» (2026-09-26).
  // Настройки возвращаются на выходе.
  const mv = bot.pathfinder && bot.pathfinder.movements
  const mvWas = mv ? { canDig: mv.canDig, towers: mv.allow1by1towers, scaffold: mv.scafoldingBlocks, parkour: mv.allowParkour, drop: mv.maxDropDown } : null
  if (mv) { mv.allow1by1towers = false; mv.scafoldingBlocks = [] }
  // И не прыгает через ямы (паркур: удар в прыжке над дырой — падение) и не
  // спрыгивает глубже трёх блоков (с четырёх — урон; 2026-09-25).
  if (mv) { mv.allowParkour = false; mv.maxDropDown = edges.SAFE_FALL }
  // Копать или обходить — по времени (2026-09-26). pathfinder считает блок
  // копания как (1 + 3·t)·digCost, где t — время по данным игры
  // (prismarine-block digTime: твёрдость, инструмент, чары), а шаг — 1. В
  // погоне бежим спринтом: 0.2806 бл/тик = 5.6 бл/с (tempo.SPRINT_BPT) —
  // секунда копания стоит 5.6 шагов, не 3: digCost = 5.6/3.
  const digWas = mv ? mv.digCost : null
  if (mv) mv.digCost = tempo.SPRINT_BPT * 20 / 3
  const restoreMoves = () => {
    if (!mv || !mvWas) return
    mv.canDig = mvWas.canDig; mv.allow1by1towers = mvWas.towers; mv.scafoldingBlocks = mvWas.scaffold
    mv.allowParkour = mvWas.parkour; mv.maxDropDown = mvWas.drop
    if (digWas != null) mv.digCost = digWas
    if (nbWas) mv.getNeighbors = nbWas
  }
  // Поле арены (arena.js передаёт геометрию): квадрат |dx|,|dz| ≤ r вокруг
  // центра, ноги на уровне y. Живая арена 2026-09-27: соперник выпал в дыру,
  // наш по погоне (GoalFollow, копать можно) спрыгнул на его столб и стал
  // копать его вниз. Пока мы на поле, ни один ход pathfinder'а не кончается
  // ниже пола или за краем поля — фильтр по клетке назначения, как пол в Аду
  // (worlds.tuneMovements); выпали сами — фильтра нет, путь наверх любой.
  const AR = arena && Number.isFinite(arena.y) && Number.isFinite(arena.r) ? arena : null
  const onField = (p) => !!AR && !!p && p.y >= AR.y - 1.5 && Math.abs(p.x - AR.x) <= AR.r + 0.5 && Math.abs(p.z - AR.z) <= AR.r + 0.5
  const nbWas = mv && AR && typeof mv.getNeighbors === 'function' ? mv.getNeighbors : null
  if (nbWas) {
    mv.getNeighbors = function (node) {
      const out = nbWas.call(this, node)
      if (!bot.entity || !onField(bot.entity.position)) return out
      return out.filter(m => m.y >= AR.y && Math.abs(m.x + 0.5 - AR.x) <= AR.r && Math.abs(m.z + 0.5 - AR.z) <= AR.r)
    }
  }
  // Где ждать его у поля: клетка пола, ближайшая к точке над ним, у которой
  // все восемь соседей — тоже пол (не край дыры: его удар снизу скинет).
  let holdGoal = null
  let holdGoalAt = 0
  const guardSpot = (p) => {
    if (!AR) return null
    const fy = Math.floor(AR.y + 1e-6) - 1
    const cx = Math.max(AR.x - AR.r + 1, Math.min(AR.x + AR.r - 1, p.x))
    const cz = Math.max(AR.z - AR.r + 1, Math.min(AR.z + AR.r - 1, p.z))
    const floorAt = (x, z) => { const b = bot.blockAt(new Vec3(x, fy, z), false); return !!b && b.boundingBox === 'block' }
    const clearAt = (x, z) => { for (const k of [1, 2]) { const b = bot.blockAt(new Vec3(x, fy + k, z), false); if (!b || b.boundingBox !== 'empty' || /lava|fire|cobweb/.test(b.name)) return false } return true }
    let best = null
    for (let dx = -7; dx <= 7; dx++) {
      for (let dz = -7; dz <= 7; dz++) {
        const x = Math.floor(cx) + dx; const z = Math.floor(cz) + dz
        if (Math.abs(x + 0.5 - AR.x) > AR.r - 1 || Math.abs(z + 0.5 - AR.z) > AR.r - 1) continue
        if (!floorAt(x, z) || !clearAt(x, z)) continue
        let safe = true
        for (let ax = -1; ax <= 1 && safe; ax++) for (let az = -1; az <= 1 && safe; az++) if (!floorAt(x + ax, z + az)) safe = false
        if (!safe) continue
        const dist = Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z)
        if (!best || dist < best.dist) best = { x, z, dist }
      }
    }
    return best ? new Vec3(best.x, fy + 1, best.z) : null
  }
  // Шахты, до которых не дошли или где столб не вырос, — не выбирать снова.
  const badShafts = new Set()
  // Рефлекс края на каждый тик физики (edges.guard): никакие клавиши — ни
  // боя, ни еды на ходу, ни лука, ни pathfinder'а — не уведут с обрыва. Пока
  // враг в шести блоках, ещё и запас от края: его удар кидает на 2-4 блока.
  const edgeGuard = edges.guard(bot, {
    margin: () => (entity && entity.isValid && entity.position && bot.entity && entity.position.distanceTo(bot.entity.position) < 6 ? 0.35 : 0)
  })
  // Булава (mace.js, 2026-09-26): слежка за его взлётами и падениями — на
  // тике физики; итог — в отчёте боя (поле mace).
  const mc = mace.track(bot, { enemy: () => entity })
  ctl.onAbort.push(() => mc.close())
  // Элитры (elytra.js): слежка за его полётом и свои взлёты; рефлекс края на
  // время полёта отпускается (edgeGuard.allow) — клавиши элитрам не нужны.
  const sky = elytra.create(bot, { enemy: () => entity, used, edgeGuard, arena: AR })
  ctl.onAbort.push(() => sky.close())
  // «Динамит» (boom.js): мины и выстрелы по взрывчатке, защита от его.
  const bm = boom.create(bot, { enemy: () => entity, used, crystals: !crystal.ON })
  ctl.onAbort.push(() => bm.close())
  const cx = crystal.create(bot, { enemy: () => entity, used })
  ctl.onAbort.push(() => cx.close())
  // Долгие дела под угрозой (2026-09-26): глоток, еда, стройка — бросать в тот
  // же тик, как mace.track увидел его взлёт или падение на нас (удар булавы с
  // высоты — ваншот, защита — в ветке maceThreat цикла), а стройку — ещё и
  // когда бьют: два попадания или одно на малом хп (FIX).
  const maceNow = () => { try { return !!(prof.player && mc.threat()) } catch { return false } }
  const maceAbort = (what) => { st.maceAborts = (st.maceAborts || 0) + 1; used('бросил ' + what + ': булава сверху') }
  const buildGuard = () => {
    let n = 0
    let last = tt.myHurtAt
    const g = () => {
      if (g.why) return true
      // Бьёт издалека (стрела: его рука до нас не достаёт) — ответить нечем, а
      // бросить столб значит стоять под его луком (2026-09-27: «бросил столб к
      // его столбу: бьют — дерусь», и 9–11 попаданий снизу). Такие попадания
      // стройку не рвут, пока хп выше 8; от них — щит между блоками (towerShield).
      if (tt.myHurtAt !== last) {
        last = tt.myHurtAt
        let far = false
        try { far = entity.isValid && reachFrom(entity.position.offset(0, EYE, 0), bot.entity) > tempo.PLAYER_REACH + 0.5 } catch {}
        if (!far || (bot.health ?? 20) <= 8) n++
      }
      // Стою в лаве или огне, горю — бросить: цикл боя выведет из огня и
      // потушит (живая арена 2026-09-26: бот лез столбом к нему, ему кинули
      // паутину и лаву — подъём шёл до конца, пока он не сгорел).
      const fn = blockName(bot, bot.entity.position.floored())
      if (/^(lava|fire|soul_fire)$/.test(fn || '')) { g.why = `стою в ${fn}`; return true }
      // Горим — бросать стройку только на малом хп: огонь — 1 хп в секунду, а
      // его огненные стрелы поджигают снова и снова (живая арена 2026-09-27:
      // «не поднялся: горю» 22 раза за бой — ни одного подъёма).
      if (onFire(bot) && !hasEffect(bot, 'fire_resistance') && (bot.health ?? 20) <= 8) { g.why = 'горю'; return true }
      if (FIX && maceNow()) { g.why = 'булава сверху'; return true }
      if (FIX && prof.player && (n >= 2 || (n >= 1 && (bot.health ?? 20) <= 8))) { g.why = 'бьют'; return true }
      return false
    }
    return g
  }
  // ctl для стройки (towerUp, bridge, climbBack читают только aborted).
  const guardCtl = (g) => ({ get aborted () { return ctl.aborted || g() }, onAbort: ctl.onAbort, abort: () => ctl.abort() })
  const buildDone = (g, what) => {
    if (!g.why) return false
    st.build.aborted++
    if (g.why === 'булава сверху') maceAbort(what)
    else used(g.why === 'бьют' ? `бросил ${what}: бьют — дерусь` : `бросил ${what}: ${g.why}`)
    return true
  }
  // Успеет ли он ударить, пока строим ms: его путь до руки спринтом (tempo.eta —
  // пик скорости за 2 с, паутина, его глоток) или стрела, если лук в руке.
  const buildHot = (ms) => { try { return prof.player && tt.eta(entity) < ms + style.reactMs } catch { return false } }
  const noteBuild = (kind, ms) => {
    const hot = buildHot(ms)
    st.build[kind]++
    if (hot) st.build[kind + 'Hot']++
    return hot
  }

  ctl.onAbort.push(() => {
    gameClock.clearInterval(aimTimer)
    clear()
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.deactivateItem() } catch {}
    restoreMoves()
    edgeGuard.stop()
    bot.removeListener('nd_mlg', onMlg)
    tt.close()
    if (session.tempo === tt) session.tempo = null
    mf.close()
  })

  // Смена предмета в главной руке обнуляет заряд удара (minecraft.wiki
  // «Attack speed»). Любой приём — паутина, зелье, ведро — стоит полной
  // перезарядки после возврата к мечу, и таймер обязан это знать, иначе
  // первый удар после приёма уходит с 20% урона.
  const heldName = () => (bot.heldItem ? bot.heldItem.name : null)
  const switched = (before) => {
    if (heldName() !== before) nextReady = Math.max(nextReady, gameClock.now() + cooldownMs(bot.heldItem))
  }

  // Оружие под цель: против моба в алмазной броне топор может бить больнее
  // меча (крупный удар броня режет меньше) — assess.weaponFor считает.
  let chosenWeapon = null
  const pickWeaponFor = (e) => {
    chosenWeapon = null
    if (!e || isPlayer(e)) return
    try {
      const w = assess.weaponFor(bot, e)
      if (w && w.item) chosenWeapon = w.item.name
    } catch {}
  }

  const holdWeapon = async () => {
    // Копает (pathfinder в погоне, столб) — руку посреди копки не менять:
    // сервер считает время копки по предмету в руке, и с мечом вместо кирки
    // блок «бьётся рукой» без конца (живая арена 2026-09-27: булыжник его столба).
    if (bot.targetDigBlock) return
    const before = heldName()
    weapon = (chosenWeapon && findItem(bot, i => i.name === chosenWeapon)) || bestWeapon(bot)
    const held = bot.heldItem
    if (weapon && (!held || held.name !== weapon.name)) {
      try { await bot.equip(weapon, 'hand') } catch {}
    } else if (!weapon && held && !/_sword$|_axe$/.test(held.name)) {
      // С пустыми руками кулак, а не кирка: кирка бьёт почти так же, но
      // заряжается втрое дольше.
      try { await bot.unequip('hand') } catch {}
    }
    switched(before)
  }

  const holdItem = async (item) => {
    const before = heldName()
    try { await bot.equip(item, 'hand'); return true } catch { return false } finally { switched(before) }
  }

  // Использовать то, что в руке, под заданным углом и вернуть взгляд на цель.
  const useAt = async (yaw, pitch, { holdMs = 0 } = {}) => {
    aim = 'point'
    aimPoint = { yaw, pitch }
    await bot.look(yaw, pitch, true).catch(() => {})
    await sleep(60)
    bot.activateItem()
    if (holdMs) {
      await sleep(holdMs)
      bot.deactivateItem()
    }
    await sleep(60)
    aim = 'target'
  }

  // Бросить в цель: снежок, яйцо, взрывное зелье. speed/gravity — снаряда.
  // Бросок по нему (throw.js: точная физика броска, поправка зелья на -20°,
  // своё движение и упреждение его движения). В середину тела: прямое
  // попадание — полная сила зелья. Разобьётся у нас под носом (стена,
  // потолок) — не бросать: вред и яд пришлись бы по себе.
  // На земле ли он — по опоре под рамкой (edges.support): onGround чужих
  // сущностей mineflayer не ведёт (поле всегда undefined, находка mace.js
  // 2026-09-26), и «onGround !== false» было правдой всегда.
  const foeGrounded = () => { try { return edges.support(bot, entity.position, new Map()).drop <= 0.05 } catch { return true } }
  const leadFn = (frac) => (t) => {
    const p = track.at(Math.min(30, t))
    const y = !foeGrounded() ? p.y : entity.position.y
    return new Vec3(p.x, y + (entity.height || 1.8) * frac, p.z)
  }
  // Долетит ли отсюда (грубо, стоя): зелье — 0.5 блока за тик при гравитации
  // 0.05, с места это 5-6 блоков (тир: 7 и 9 «не долетит», с разбега — да).
  // Проверка до смены предмета: смена сбрасывает заряд меча.
  const reachable = (item) => {
    const k = throwMod.kindOf(item.name)
    if (!k) return false
    const from = bot.entity.position.offset(0, EYE - 0.1, 0)
    return !!throwMod.aim(from, leadFn(0.5), k)
  }
  // minLand — ближе скольких блоков облако не пускать (своё зелье по себе).
  // Всплеск в добиваемого (duo.burst, 2026-09-26) берёт 3.3: бросок зелья
  // (0.5 бл/тик, −20° к взгляду, тяжесть 0.05 — ThrowablePotionItem.use,
  // AbstractThrownPotion) до середины его тела долетает лишь на ~4.5 бл.
  // (throw.aim: 5 бл. — «не долетит»), и порог 4.5 оставлял окно в полблока;
  // с 3.3 нам достаётся 1 − √(3.3² + 1)/4 ≈ 14% (≈ 1.7 из 12,
  // AbstractThrownPotion.applySplash), ему — всё.
  const throwAt = async (item, what, { minLand = 4.5 } = {}) => {
    if (!reachable(item)) return false
    if (!(await holdItem(item))) return false
    aim = 'free'
    let r = null
    try {
      r = await throwMod.throwAt(bot, leadFn(0.5), {
        item: bot.heldItem,
        onAim: (res) => {
          const at = res.land && res.land.at
          if (!at) return true
          const me0 = bot.entity.position
          if (at.y < me0.y - 2.3) return true
          return Math.hypot(at.x - me0.x, at.z - me0.z) >= minLand
        }
      })
    } catch {}
    aim = 'target'
    if (r && r.thrown) { used(what); return true }
    await holdWeapon()
    return false
  }

  // Поставить блок-ловушку (паутину) в клетку, где стоит цель: упираемся в
  // верхнюю грань блока под ней. Паутина без коллизии, поэтому человек в
  // клетке не мешает её поставить.
  const placeUnder = async (item, what) => {
    const cell = entity.position.floored()
    const below = bot.blockAt(cell.offset(0, -1, 0))
    const here = bot.blockAt(cell)
    if (!below || below.boundingBox !== 'block' || !here || here.boundingBox !== 'empty' || here.name !== 'air') return false
    // Честно (pick.faceAim, 2026-09-26: «это как чит WH»): ставим, только если
    // верх блока под ним виден — не сквозь стенку его коробки и не сквозь его
    // же ноги (прицел клиента взял бы его рамку, а не блок).
    const faceP = pick.faceAim(bot, below.position, new Vec3(0, 1, 0))
    if (!faceP) return false
    if (!(await holdItem(item))) return false
    aim = 'free'
    try {
      await bot.lookAt(faceP, true)
      await withTimeout(bot.placeBlock(below, new Vec3(0, 1, 0)), 600)
    } catch {}
    aim = 'target'
    const placed = blockName(bot, cell)
    if (placed && placed !== 'air') { used(what); return true }
    return false
  }

  // Стенка в два блока между нами и точкой pos (враг, стрелок): соседняя
  // клетка по главной оси в его сторону, ноги и голова. Снизу вверх — верхнему
  // блоку нужна опора.
  const wallToward = async (pos, what) => {
    if (!pickFiller(bot)) return 0
    const me0 = bot.entity.position
    const dx = pos.x - me0.x
    const dz = pos.z - me0.z
    const step = Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1)
    const base = me0.floored().plus(step)
    let placed = 0
    aim = 'free'
    for (const c of [base, base.offset(0, 1, 0)]) {
      if (FIX && maceNow()) { maceAbort('стенку'); break }
      try {
        const r = await placeBlockAt(bot, c, { timeoutMs: 700 })
        if (r.ok && !r.already) placed++
      } catch {}
    }
    aim = 'target'
    if (placed) used(what)
    return placed
  }

  // Укрытие под ситуацию — сколько блоков и где. От лучника — стенка 3×2
  // поперёк линии огня: клетки по направлению на него и ±45°, так что и по
  // диагонали, и при шаге в сторону стрела упирается в блок. Блоков меньше
  // шести — одна колонка 1×2. От ближника стенка его не держит (обойдёт за
  // секунду) — колонка перед носом, чтобы выиграть шаг.
  const coverFrom = async (pos, { wide = false, what = 'укрытие' } = {}) => {
    const filler = pickFiller(bot)
    if (!filler) return 0
    const have = countOf(bot, filler.name)
    const me0 = bot.entity.position
    const dx0 = pos.x - me0.x
    const dz0 = pos.z - me0.z
    const n = Math.hypot(dx0, dz0) || 1
    const mine = me0.floored()
    const cells = []
    for (const a of (wide && have >= 6 ? [0, -Math.PI / 4, Math.PI / 4] : [0])) {
      const c = Math.cos(a); const sn = Math.sin(a)
      const ux = (dx0 * c - dz0 * sn) / n
      const uz = (dx0 * sn + dz0 * c) / n
      const cell = new Vec3(Math.floor(me0.x + ux * 1.3), mine.y, Math.floor(me0.z + uz * 1.3))
      if (cell.equals(mine) || cells.some(q => q.equals(cell))) continue
      cells.push(cell)
    }
    let placed = 0
    aim = 'free'
    let maceStop = false
    for (const cell of cells) {
      if (maceStop) break
      // Снизу вверх: верхнему нужна опора.
      for (const c of [cell, cell.offset(0, 1, 0)]) {
        // Булава сверху (FIX) — стенку бросить: защита в цикле.
        if (FIX && maceNow()) { maceStop = true; maceAbort('стенку'); break }
        try {
          const r = await placeBlockAt(bot, c, { timeoutMs: 700 })
          if (r.ok && !r.already) placed++
        } catch {}
      }
    }
    aim = 'target'
    if (placed) { used(what); st.blocks = (st.blocks || 0) + placed }
    return placed
  }

  // Стенка перед глотком (FIX, 2026-09-26: «пьют и смотрят друг на друга —
  // даже не закрываются стенками, чтобы спокойно пить»): он видит нас ближе
  // 24 бл. (в арсенале лук и арбалет у всех) — колонна 1×2 между нами, а если
  // лук, арбалет или трезубец у него в руке — стенка 3×2. В целой коробке
  // и на столбе не нужно.
  const coverForDrink = async () => {
    try {
      if (!prof.player || fort || perch || !entity.isValid || !pickFiller(bot) || !ready('drinkCover')) return 0
      const dd = entity.position.distanceTo(bot.entity.position)
      if (dd > 24 || !raySees(bot, entity.position.offset(0, EYE, 0), bot.entity.position.offset(0, 1.2, 0))) return 0
      rest('drinkCover', 2500)
      const hisMain = entity.equipment && entity.equipment[0] ? entity.equipment[0].name : ''
      const archerNow = /^(bow|crossbow|trident)$/.test(hisMain)
      // Стенка — только если он не успеет дойти, пока строим И пьём: иначе
      // глоток всё равно оборвётся («бросил пить — он рядом»), а блоки останутся
      // мусором на арене (2026-09-26: 24 стенки за 14 раундов, часть — зря).
      if (tempo.ON && !tt.safe(tempo.consumeMs('potion') + (archerNow ? COVER_WIDE_MS : COVER_MS)).ok) return 0
      return await coverFrom(entity.position, { wide: archerNow, what: archerNow ? 'стенка 3×2 перед глотком (он с луком)' : 'колонна перед глотком' })
    } catch { return 0 }
  }

  // Столб: уйти вверх, где его рука не достанет, и регенерировать
  // (minecraft.wiki «Hunger»: при сытости 20 и запасе насыщения — 1 хп за
  // полсекунды). Высота — расчётом, а не «пять на глаз»: игрок бьёт на 3 блока
  // от глаз (1.62), а в прыжке глаза поднимаются ещё на 1.25 — рука достаёт до
  // 5.9 над его ногами. Ноги — выше этого, с учётом того, что он может стоять
  // выше или ниже нас. Спуск потом стоит (высота − 3) хп — это тоже в расчёте.
  let perch = null
  let siegeGoal = null
  const perchHeight = () => {
    const need = entity.position.y + EYE + 1.25 + 3.0 + 0.1 - bot.entity.position.y
    return Math.max(3, Math.ceil(need))
  }
  const PERCH_MAX = 8
  const headroom = (n) => {
    const f = bot.entity.position.floored()
    for (let i = 2; i <= n + 2; i++) {
      const b = bot.blockAt(f.offset(0, i, 0))
      if (!b || b.boundingBox !== 'empty') return false
    }
    return true
  }
  const pillarOut = async () => {
    const h = perchHeight()
    const filler = pickFiller(bot)
    if (h > PERCH_MAX || !filler || countOf(bot, filler.name) < h || !headroom(h + 1)) return false
    // Столб растёт ~0.4 с на блок (прыжок до +1.1 и блок, build.towerUp): он
    // успеет дойти и бить по ногам — не начинать (FIX).
    if (FIX && buildHot(h * PILLAR_MS)) { st.build.refused++; used('столб: не строю — он достанет за стройку'); return false }
    noteBuild('pillar', h * PILLAR_MS)
    const gP = buildGuard()
    const before = heldName()
    const y0 = bot.entity.position.y
    pathTo(false); pathing = false
    clear()
    aim = 'free'
    try { await towerUp(bot, guardCtl(gP), h, { sneak: false, fast: true, beforeStep: towerShield }) } catch {}
    aim = 'target'
    switched(before)
    await holdWeapon()
    if (buildDone(gP, 'столб')) return false
    const top = bot.entity.position.y
    if (top - y0 < 3) return false
    perch = { since: gameClock.now(), y0, top, h: Math.round(top - y0) }
    used(`ушёл на столб ${perch.h} бл. (спуск −${Math.max(0, perch.h - 3)} хп)`)
    st.blocks = (st.blocks || 0) + perch.h
    return true
  }
  // Вниз — к нему: прыжок с пяти блоков стоит 2 хп (урон падения = высота − 3),
  // а падая на него, бьём критом. Спрыгиваем туда, где внизу не лава и не огонь.
  const dropFromPerch = async () => {
    const me0 = bot.entity.position
    const toward = yawTo(me0, entity.position)
    let yaw = toward
    for (const off of [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      const y = toward + off
      const cell = me0.offset(-Math.sin(y) * 1.2, 0, -Math.cos(y) * 1.2).floored()
      // Пола в пределах столба нет — это пустота (столб у края арены в
      // небе), туда не прыгать (2026-09-25).
      let bad = true
      for (let k = 0; k <= PERCH_MAX + 2; k++) {
        const n = blockName(bot, cell.offset(0, -k, 0))
        if (!n || n === 'air' || n === 'cave_air') continue
        bad = /lava|fire|magma|cactus|campfire|sweet_berry/.test(n)
        break
      }
      if (!bad) { yaw = y; break }
    }
    // Булава (mace.js, 2026-09-26): он внизу рядом — булаву в руку заранее
    // (заряд 33 тика: к удару полный, с критом) и удар с падения на спуске.
    const smashDrop = prof.player && mace.fallSmashReady(bot, entity)
    if (smashDrop) {
      const m = findItem(bot, i => i.name === 'mace')
      if (m && (!bot.heldItem || bot.heldItem.name !== 'mace')) await holdItem(m)
      const t1 = gameClock.now()
      while (gameClock.now() - t1 < 1100 && !ctl.aborted && mace.fallSmashReady(bot, entity)) await sleep(TICK_MS)
    }
    aim = 'free'
    await bot.look(yaw, 0, true).catch(() => {})
    clear()
    // Спуск со своего столба — намеренный: рефлекс края его пропускает.
    edgeGuard.allow(PERCH_MAX + 2, 1500)
    set('forward', true)
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 900 && bot.entity.position.y > perch.top - 0.6 && !ctl.aborted) await sleep(TICK_MS)
    set('forward', false)
    if (smashDrop) {
      const fr = await mace.descend(bot, ctl, entity, { vel: () => track.vel(), stats: mc.st })
      mc.st.fallSmash++
      if (fr.hit) { st.swings++; lastSwing = gameClock.now(); mc.st.smashHits++ }
      used(fr.hit ? 'булава: удар со столба' : 'булава: со столба не достал')
      await holdWeapon()
    }
    aim = 'target'
    perch = null
    used('спрыгнул со столба')
  }

  // Крепость (fortify.js): закрыться в своей клетке, лечиться внутри, латать
  // то, что он выламывает, бить его через дыру, выйти с нужной стороны.
  let fort = null
  const healItem = () => findPotion(bot, 'splash_potion', 'heal') || findPotion(bot, 'potion', 'heal') ||
    findPotion(bot, 'potion', 'regen') || findItem(bot, i => /golden_apple$/.test(i.name)) ||
    findItem(bot, i => /cooked_|bread|baked_potato|golden_carrot|steak/.test(i.name))
  const fortPossible = () => {
    const filler = pickFiller(bot)
    if (!filler || countOf(bot, filler.name) < 10 || !fortify.canBreakOut(bot, filler)) return false
    if (!bot.entity.onGround || bot.entity.isInWater) return false
    const cell = bot.entity.position.floored()
    for (const k of [2, 3]) {
      const b = bot.blockAt(cell.offset(0, k, 0))
      if (!b || b.boundingBox !== 'empty') return false
    }
    // Крипер рядом — коробка его не держит, а стоять в ней значит не убежать.
    const creeper = bot.nearestEntity(e => e && e.name === 'creeper' && e.position.distanceTo(bot.entity.position) < 9)
    if (creeper) return false
    // Лечиться чем-то надо: предмет, или сытость для естественной регенерации.
    return !!healItem() || (bot.food ?? 0) >= 18
  }
  // Клетка под коробку: пол есть, ноги/голова/крыша свободны, и все четыре
  // стены можно поставить — не паутина, не чужие блоки впритык. Иначе коробка
  // выходила с дырами (арена 2026-09-25: рядом паутина и блоки — бот
  // строился на месте и протупил, а надо было отбежать и окопаться там, где свободно).
  const isAir = (c) => { const b = bot.blockAt(c); return !!b && b.name === 'air' }
  const cellOk = (c) => {
    if (!solid(bot, c.offset(0, -1, 0))) return false
    for (const y of [0, 1, 2]) if (!isAir(c.offset(0, y, 0)) && !(y < 2 && c.equals(fortify.feetCell(bot)) && bot.blockAt(c.offset(0, y, 0)).boundingBox === 'empty' && bot.blockAt(c.offset(0, y, 0)).name !== 'cobweb')) return false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const y of [0, 1]) if (!isAir(c.offset(dx, y, dz))) return false
    }
    return true
  }
  const fortSpot = () => {
    const here = fortify.feetCell(bot)
    if (cellOk(here)) return here
    const away = bot.entity.position.minus(entity.position)
    let best = null; let bs = Infinity
    for (let dx = -5; dx <= 5; dx++) {
      for (let dz = -5; dz <= 5; dz++) {
        for (const dy of [0, -1, 1]) {
          const c = here.offset(dx, dy, dz)
          if (!cellOk(c)) continue
          const dist = Math.hypot(dx, dz)
          // Ближе к нам и дальше от него.
          const toward = (dx * away.x + dz * away.z) / (Math.hypot(away.x, away.z) || 1)
          const sc = dist - toward * 0.6 + Math.abs(dy)
          if (sc < bs) { bs = sc; best = c }
        }
      }
    }
    return best
  }
  const fortOut = async () => {
    // Коробка — центровка и 10 блоков, ~2.5 с глядя под ноги (fortify.boxIn):
    // он дойдёт и забьёт — не начинать (FIX), лечиться отрывом или драться.
    if (FIX && buildHot(BOX_FRONT_MS)) { st.build.refused++; rest('fort', 1200); if (ready('boxNoNote')) { rest('boxNoNote', 3000); used('коробка: не строю — он достанет за стройку') } return false }
    noteBuild('box', BOX_MS)
    aim = 'free'
    pathTo(false); pathing = false
    clear()
    const spot = fortSpot()
    if (!spot) { aim = 'target'; used('негде строить коробку'); return false }
    if (!spot.equals(fortify.feetCell(bot))) {
      used('отбегаю на чистое место под коробку')
      try {
        bot.pathfinder.setGoal(new goals.GoalBlock(spot.x, spot.y, spot.z))
        const t0 = gameClock.now()
        while (gameClock.now() - t0 < 3000 && !ctl.aborted && !fortify.feetCell(bot).equals(spot)) await sleep(50)
      } catch {}
      bot.pathfinder.setGoal(null)
      clear()
      if (!fortify.feetCell(bot).equals(spot)) {
        if (process.env.ND_DEBUG_PVP || process.env.ND_TRACE_PVP) console.log('[fort] не добежал', JSON.stringify({ spot, pos: bot.entity.position }))
        aim = 'target'; used('не добежал до места под коробку'); return false
      }
    }
    // Бьют посреди стройки (два попадания или одно на малом хп) или булава
    // сверху — бросить и драться (buildGuard).
    const gB = buildGuard()
    const boxT0 = gameClock.now()
    const box = await fortify.boxIn(bot, { toward: entity.position, roof: true, ctl: guardCtl(gB) })
    // Сколько стройка заняла на деле (сверка с BOX_MS).
    if (st.build.boxMs.length < 12) st.build.boxMs.push(gameClock.now() - boxT0)
    if (process.env.ND_DEBUG_PVP) console.log('[fort]', JSON.stringify({ placed: box.placed, walls: box.walls, roof: box.roof, failed: box.failed, cell: box.cell, pos: bot.entity.position }))
    if (box.walls < 3 || (gB.why && !box.sealed)) {
      aim = 'target'
      await holdWeapon()
      if (!buildDone(gB, 'коробку') && box.placed) used('коробка не вышла')
      return false
    }
    fort = box
    st.blocks = (st.blocks || 0) + box.placed
    used(`закрылся в коробке (${box.placed} бл.)`)
    if (box.hardN) used(`коробка: лицо, бока и крыша — ${box.hard}`)
    const t0 = gameClock.now()
    let patchedTotal = 0
    let hitThrough = 0
    // Осада в реальном времени: сколько раз стену вскрывали и когда, сколько
    // латок осталось по характеру и по рюкзаку.
    let breaches = 0
    let holeSince = 0
    let budget = style.patchBudget
    let why = null
    let breakAway = false
    while (!ctl.aborted && gameClock.now() - t0 < 70000) {
      if ((bot.health ?? 0) <= 0) break
      const hpNow = bot.health ?? 20
      const swell = bot.nearestEntity(e => e && e.name === 'creeper' && e.position.distanceTo(bot.entity.position) < 6 && creeperSwelling(bot, e))
      if (swell) { used('крипер у коробки — выхожу'); break }
      const eye0 = bot.entity.position.offset(0, EYE, 0)
      // Он в дыре и достаётся рукой — бить через неё (прицел как у клиента:
      // pick.aim, а не raySees — тот прощал блок у самой цели).
      const holeAim = entity.isValid && reachFrom(eye0, entity) <= HIT_REACH && gameClock.now() >= nextReady
        ? pick.aim(bot, entity, { eye: pick.eyeOf(bot), range: HIT_REACH }) : null
      if (holeAim && holeAim.point) {
        await holdWeapon()
        await bot.lookAt(holeAim.point, true).catch(() => {})
        try { bot.attack(entity) } catch {}
        st.swings++
        hitThrough++
        lastSwing = gameClock.now()
        nextReady = lastSwing + cooldownMs(bot.heldItem)
        await sleep(TICK_MS)
        continue
      }
      // Темп (2026-09-25: «горел в коробке, её ломали, а он тупо ел и стоял»).
      // Горим — вода под ноги и обратно. Коробку вскрыли — ломают блоки рядом с
      // ним, он достаёт нас или копает стену, по нам попали, горим без воды —
      // не стоять: явный перевес (хп больше на 6 или он сам ест) — выходить
      // драться, иначе выломать выход с дальней от него стороны и бежать.
      if (tempo.ON && prof.player) {
        const burningNow = onFire(bot) && !hasEffect(bot, 'fire_resistance')
        const wb = burningNow && !bot.entity.isInWater && ready('fortWater') ? findItem(bot, i => i.name === 'water_bucket') : null
        if (wb) {
          rest('fortWater', 2000)
          await useOnGroundAt(wb, box.cell, 'вода: потушился в коробке')
          await sleep(250)
          await scoop(box.cell)
          await holdWeapon()
          continue
        }
        const encB = fortify.enclosure(bot, box.cell)
        const fs = entity.isValid ? tt.foes.get(entity.id) : null
        const theirEye0 = entity.position.offset(0, EYE, 0)
        const canHitMe = entity.isValid && reachFrom(theirEye0, bot.entity) <= tempo.PLAYER_REACH &&
          pick.canHit(bot, bot.entity, { eye: theirEye0, range: tempo.PLAYER_REACH })
        // Копает стену: доломает больше чем через 1.2 с (обсидиан, tempo.
        // digLeftMs) — ещё не вскрыли, лечиться дальше; скоро — вскрыли.
        const digLeft = entity.isValid ? tt.digLeftMs(entity) : null
        const digging = !!(fs && gameClock.now() - fs.digAt < 1200 && fs.digPos && fs.digPos.distanceTo(box.cell) <= 2.5) && (digLeft == null || digLeft < 1200)
        if (!digging && digLeft != null && digLeft >= 1200 && fs && fs.digPos && fs.digPos.distanceTo(box.cell) <= 2.5 && ready('hardDigNote')) { rest('hardDigNote', 3000); used('он ломает крепкую стену — ещё лечусь') }
        const nearHole = !encB.sealed && entity.isValid && entity.position.distanceTo(bot.entity.position) < 5
        const hurtNow = gameClock.now() - tt.myHurtAt < 1000
        const breach = canHitMe ? 'он достаёт через дыру' : digging ? 'он ломает стену' : hurtNow ? 'по мне попали' : nearHole ? 'дыра, он рядом' : burningNow ? 'горю, воды нет' : null
        if (breach) {
          tt.stats.breaches++
          const theirHp0 = healthOf(bot, entity)
          const edge = (theirHp0 != null && hpNow >= theirHp0 + 6) || !!tt.state(entity).consuming
          why = `вскрыли (${breach}) — ${edge ? 'перевес, выхожу драться' : 'вырываюсь с тыла'}`
          breakAway = !edge
          break
        }
      }
      // Выломал — латать (кошки-мышки: он ломает, мы ставим), но не сразу —
      // реакция живая, он может успеть сунуть меч, — и не бесконечно: бюджет
      // латок по характеру и по рюкзаку. Ломает быстрее, чем латаем, или латки
      // кончились — менять план: бить через дыру (выше) или выходить с другой
      // стороны.
      const enc = fortify.enclosure(bot, box.cell)
      if (!enc.sealed) {
        if (!holeSince) { holeSince = gameClock.now(); breaches++ }
        const filler = pickFiller(bot)
        if (!filler || budget <= 0) { why = 'латать нечем или хватит'; break }
        if (breaches >= 3 && gameClock.now() - t0 < 12000) { why = 'ломает быстрее, чем латаю'; break }
        if (gameClock.now() - holeSince >= style.reactMs) {
          const n = await fortify.patch(bot, box.plan, { mats: box.mats })
          if (n) { patchedTotal += n; budget -= n; st.blocks = (st.blocks || 0) + n; holeSince = 0 }
        }
      } else holeSince = 0
      // Темп: в целой коробке, которую никто не копает, — выпить баффы, которых
      // нет (коробка в начале боя — ради этого), по глотку за проход.
      if (tempo.ON && prof.player && ready('fortBuff') && tt.safe(tempo.consumeMs('potion'), { fortSealed: fortSealed() }).ok) {
        rest('fortBuff', 400)
        const potOf = k => findItem(bot, i => i.name === 'potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k)
        const need = [['strength', 'strength'], ['speed', 'swiftness'], ['regeneration', 'regeneration']].find(([e, k]) => !hasEffect(bot, e) && potOf(k))
        if (need && (await drink(potOf(need[1]), 'выпил в коробке ' + need[1]))) { await holdWeapon(); continue }
      }
      // Лечиться: предмет, пока хп не полное; иначе — ждать регенерацию.
      // Темп: глоток и еда — только пока коробка целая и не горим (сторож в
      // eatHeld бросит, если вскроют посреди глотка); взрывное — всегда.
      const item0 = hpNow < 17 && ready('fortEat') ? healItem() : null
      const item = item0 && (/splash_potion/.test(item0.name) || !(tempo.ON && prof.player) ||
        tt.safe(tempo.consumeMs(item0.name), { fortSealed: fortSealed() }).ok) ? item0 : null
      if (item) {
        rest('fortEat', 1800)
        if (/splash_potion/.test(item.name)) {
          if (await holdItem(item)) { await useAt(bot.entity.yaw, -Math.PI / 2); used('лечение под ноги'); st.healed.push('взрывное лечения') }
          aim = 'free'
        } else if (await holdItem(item)) {
          if (await eatHeld(item.name)) { used('съел в коробке ' + item.name); st.healed.push(item.name) }
        }
      }
      // Когда выходить. Отлечились — сразу. Лечиться нечем — ждать естественную
      // регенерацию (идёт при сытости от 18); без неё ждать нечего. Живой
      // прогон: бот съел в коробке три яблока, по таймеру в 30 с полез наружу
      // на 8 хп, а тот ждал у стены и добил его в выломанную дыру.
      const waited = gameClock.now() - t0
      const regen = (bot.food ?? 0) >= 18
      if (hpNow >= 18) break
      if (!healItem() && hpNow >= 14 && waited > 12000) break
      if (!healItem() && !regen && waited > 15000) break
      if (waited > Math.max(style.boxPatienceMs, 20000) && hpNow >= 10) { why = 'надоело сидеть'; break }
      if (waited > 60000) break
      await sleep(100)
    }
    if (why) used(`из коробки: ${why}`)
    // Убит в коробке (он вскрыл её и добил) или выбит из неё — ломать выход
    // уже не из чего: иначе бот после возрождения «ломал» стену там, где его нет.
    const stillIn = bot.entity && (bot.health ?? 0) > 0 && bot.entity.position.floored().equals(box.cell)
    if (!stillIn) {
      used((bot.health ?? 0) <= 0 ? 'убит в своей коробке' : 'выбит из коробки')
      fort = null
      aim = 'target'
      if ((bot.health ?? 0) > 0) await holdWeapon()
      return true
    }
    if (patchedTotal) used(`залатал коробку (${patchedTotal} бл.)`)
    if (hitThrough) used(`бил через дыру ×${hitThrough}`)
    // Выход: здоровее его — выскочить ему во фланг, нет — с тыла.
    const theirs = healthOf(bot, entity)
    // Вскрыли без перевеса (темп) — только с тыла, и потом бегом.
    const bold = !breakAway && (bot.health ?? 0) >= (theirs ?? 20) - 2
    const out = await fortify.breakOut(bot, box.cell, bold ? { toward: entity.position } : { away: entity.position }, {
      // Он у пробитой дыры — бить через неё, а не доламывать выход под его мечом.
      onHole: async () => {
        const eye0 = bot.entity.position.offset(0, EYE, 0)
        if (!entity.isValid || reachFrom(eye0, entity) > HIT_REACH) return false
        await holdWeapon()
        if (gameClock.now() < nextReady) await sleep(nextReady - gameClock.now())
        const ha = pick.aim(bot, entity, { eye: pick.eyeOf(bot), range: HIT_REACH })
        if (!ha || !ha.point) return false
        await bot.lookAt(ha.point, true).catch(() => {})
        try { bot.attack(entity) } catch {}
        st.swings++
        lastSwing = gameClock.now()
        nextReady = lastSwing + cooldownMs(bot.heldItem)
        return true
      }
    })
    if (process.env.ND_DEBUG_PVP) console.log('[fort] out', JSON.stringify({ ok: out.ok, side: out.side, hp: bot.health, theirs, bold, steps: out.steps }))
    used(out.ok ? (bold ? 'вышел из коробки ему во фланг' : 'вышел из коробки с тыла') : 'не выбрался из коробки')
    if (out.ok) {
      await bot.lookAt(out.exit.offset(0.5, 1.2, 0.5), true).catch(() => {})
      set('forward', true)
      await sleep(350)
      set('forward', false)
      // Вырвался с тыла (темп) — бегом от него спринтом с прыжками, пока не
      // оторвался настолько, что можно лечиться, или пока он не догнал.
      if (breakAway) {
        fort = null
        aim = 'free'
        const how = await tempo.kite(bot, ctl, () => [entity], {
          ms: 2500,
          until: () => tt.safe(tempo.consumeMs('golden_apple')).ok,
          stop: () => entity.isValid && reachFrom(entity.position.offset(0, EYE, 0), bot.entity) <= tempo.PLAYER_REACH
        })
        tt.stats.breachEscapes++
        tt.stats.kites++
        used('вырвался из вскрытой коробки: ' + how)
      }
    }
    fort = null
    aim = 'target'
    await holdWeapon()
    return true
  }

  // Стенка между нами (его или случайная) — пробить, если она рядом и
  // ломается быстро (tools.js: время по правилам игры лучшим, что есть в
  // рюкзаке). Живой прогон: боты 40 с кружили вокруг обломков коробок,
  // вместо того чтобы выбить один блок.
  const punchThrough = async () => {
    rest('punch', 700)
    const eye0 = bot.entity.position.offset(0, EYE, 0)
    const to = entity.position.offset(0, (entity.height || 1.8) * 0.6, 0)
    const delta = to.minus(eye0)
    const dist = delta.norm()
    if (dist < 0.5 || dist > 7) return false
    let hit = null
    try { hit = bot.world.raycast(eye0, delta.scaled(1 / dist), dist, b => b && b.boundingBox === 'block') } catch {}
    if (!hit || hit.position.offset(0.5, 0.5, 0.5).distanceTo(eye0) > 4.5) return false
    const plan = tools.bestFor(bot, hit)
    if (plan.ms > 1500) return false
    pathTo(false); pathing = false
    clear()
    aim = 'free'
    const r = await tools.breakFast(bot, hit.position, { maxMs: 1500 })
    aim = 'target'
    await holdWeapon()
    if (r.ok) { used(`пробил его стенку (${r.tool})`); return true }
    return false
  }

  // Рельеф: ямы и лава (hazards.js). Пересчёт раз в 250 мс.
  let terrainAt = 0
  let myPit = null
  let theirPit = null
  let nearFoe = []
  let nearMe = []
  // Край (edges.js): план толчка и «спиной к яме» — прогон физики, раз в
  // 250 мс. edgeTally — счёт для разбора: столкнули мы его, выбили нас или
  // сорвались сами (просьба 2026-09-25: сбивать в дыру, самому не падать).
  let push = null
  let pushAt = 0
  let behindDrop = null
  // Яма по линии его толчка — прыгать ли за критом (FIX), раз в 200 мс.
  let jumpDrop = false
  let jumpDropAt = 0
  let backAt = 0
  let theyUpSince = 0
  const falls = { mine: 0, ground: null, his: 0, hisY: [] }
  const edgeTally = (now) => {
    try {
      const b = bot.entity
      if (b.onGround) { falls.ground = b.position.y; if (falls.mine && now - falls.mine > 500) falls.mine = 0 }
      if (!b.onGround && falls.ground != null && b.position.y < falls.ground - 3 && !falls.mine) {
        falls.mine = now
        used(now - lastHurtByTarget < 1500 ? 'выбили в яму' : 'сорвался в яму сам')
      }
      if (!entity || !entity.position) return
      falls.hisY.push({ y: entity.position.y, t: now })
      while (falls.hisY.length > 2 && now - falls.hisY[0].t > 800) falls.hisY.shift()
      if (falls.hisY[0].y - entity.position.y > 3 && now - lastSwing < 2500 && now - falls.his > 5000) {
        falls.his = now
        used('столкнул в яму')
      }
    } catch {}
  }

  // Выбраться из ямы: блоки есть — столб на глубину и шаг на край (в сторону от
  // него); блоков нет — ступени в стене лучшим инструментом: выбить два блока
  // перед собой на уровне головы и выше и запрыгнуть на тот, что под ними.
  const climbOut = async (pit) => {
    const filler = pickFiller(bot)
    const foe = entity.position
    pathTo(false); pathing = false
    clear()
    aim = 'free'
    try {
      if (filler && countOf(bot, filler.name) >= pit.depth && headroom(pit.depth + 1)) {
        noteBuild('pit', pit.depth * PILLAR_MS)
        const gT = buildGuard()
        try { await towerUp(bot, guardCtl(gT), pit.depth, { sneak: false, fast: true, beforeStep: towerShield }) } catch {}
        if (buildDone(gT, 'столб из ямы')) return true
        const f = bot.entity.position.floored()
        let best = null
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const c = f.offset(dx, 0, dz)
          if (!solid(bot, c.offset(0, -1, 0)) || solid(bot, c) || solid(bot, c.offset(0, 1, 0))) continue
          const away = Math.hypot(c.x + 0.5 - foe.x, c.z + 0.5 - foe.z)
          if (!best || away > best.away) best = { c, away }
        }
        if (best) {
          await bot.lookAt(best.c.offset(0.5, 1.2, 0.5), true).catch(() => {})
          set('forward', true)
          await sleep(450)
          set('forward', false)
        }
        used(`выбрался из ямы столбом (${pit.depth} бл.)`)
        st.blocks = (st.blocks || 0) + pit.depth
        return true
      }
      // Ступени: стена в сторону от него.
      const f0 = bot.entity.position.floored()
      let dir = null
      let far = -1
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!solid(bot, f0.offset(dx, 0, dz))) continue
        const away = Math.hypot(f0.x + dx + 0.5 - foe.x, f0.z + dz + 0.5 - foe.z)
        if (away > far) { far = away; dir = [dx, dz] }
      }
      if (!dir) return false
      for (let k = 0; k < pit.depth + 1 && !ctl.aborted; k++) {
        const f = bot.entity.position.floored()
        const step = f.offset(dir[0], 0, dir[1])
        for (const c of [step.offset(0, 1, 0), step.offset(0, 2, 0), f.offset(0, 2, 0)]) {
          if (solid(bot, c)) { const r = await tools.breakFast(bot, c, { maxMs: 4000 }); if (!r.ok) return false }
        }
        if (!solid(bot, step)) break
        await bot.lookAt(step.offset(0.5, 1.5, 0.5), true).catch(() => {})
        set('forward', true); set('jump', true)
        const y0 = bot.entity.position.y
        const t0 = gameClock.now()
        while (gameClock.now() - t0 < 700 && bot.entity.position.y < y0 + 0.9) await sleep(TICK_MS)
        set('jump', false)
        await sleep(150)
        set('forward', false)
      }
      used('вырубил ступени из ямы')
      return true
    } finally {
      clear()
      aim = 'target'
      await holdWeapon()
    }
  }

  // Лава в яму: ведро — в клетку ямы на уровне края, щёлкнув по боковой грани
  // края (сервер ставит жидкость туда, куда смотрит игрок), — стечёт на него.
  // Над его головой крыша — это коробка, а не яма (hazards.pitTrap смотрит
  // только стены): сперва вскрыть её самым быстрым инструментом, не стоя на
  // ней (стою на крыше — шаг на край стены), потом лить в дыру. Лить — только
  // если луч ведра правда кладёт жидкость в его столб (bucketLanding).
  const lavaIntoPit = async (lava) => {
    const f = entity.position.floored()
    let roof = null
    for (let y = f.y + 2; y <= theirPit.rimY; y++) {
      const c = new Vec3(f.x, y, f.z)
      if (solid(bot, c)) { roof = c; break }
    }
    if (roof) {
      const myFeet = bot.entity.position.floored()
      if (myFeet.x === roof.x && myFeet.z === roof.z && myFeet.y === roof.y + 1) {
        const around = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        const step = [...around.map(([dx, dz]) => myFeet.offset(dx, 0, dz)), ...around.map(([dx, dz]) => myFeet.offset(dx, -1, dz))]
          .find(c => !solid(bot, c) && !solid(bot, c.offset(0, 1, 0)) && solid(bot, c.offset(0, -1, 0)) && !/lava|fire|magma/.test(blockName(bot, c.offset(0, -1, 0)) || ''))
        if (!step) return false
        aim = 'free'
        await bot.lookAt(step.offset(0.5, 1.6, 0.5), true).catch(() => {})
        clear()
        set('forward', true)
        const t0 = gameClock.now()
        while (gameClock.now() - t0 < 700 && !ctl.aborted) {
          const p = bot.entity.position.floored()
          if (p.x === step.x && p.z === step.z) break
          await sleep(TICK_MS)
        }
        clear()
        aim = 'target'
        rest('pitLava', 250)
        used('сошёл с его крыши — вскрывать')
        return true
      }
      const rb = bot.blockAt(roof)
      const plan = tools.bestFor(bot, rb)
      if (plan.unbreakable || plan.ms > 2500 || roof.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, EYE, 0)) > 4.4) return false
      pathTo(false); pathing = false
      clear()
      aim = 'free'
      const stop = await digWatch(rb, () => maceNow() ? 'булава летит' : null)
      aim = 'target'
      await holdWeapon()
      if (stop) used(`бросил вскрывать крышу: ${stop}`)
      else if (!solid(bot, roof)) { rest('pitLava', 250); used(`вскрыл крышу его коробки (${plan.item ? plan.item.name : 'рукой'}) — лью в дыру`) }
      return true
    }
    // Куда смотреть: в его пол (жидкость встанет в клетку его ног) или в
    // боковую грань края ямы — что луч ведра правда доносит до его столба.
    const inColumn = c => c.x === f.x && c.z === f.z && c.y >= f.y && c.y <= theirPit.rimY
    const eye0 = bot.entity.position.offset(0, EYE, 0)
    const cands = [f.offset(0.5, 0, 0.5)]
    const top = new Vec3(f.x, theirPit.rimY - 1, f.z)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rim = top.offset(dx, 0, dz)
      if (solid(bot, rim)) cands.push(rim.offset(0.5 - dx * 0.5, 0.5, 0.5 - dz * 0.5))
    }
    const pick = cands.filter(pt => pt.distanceTo(eye0) < 4.4).find(pt => { const land = bucketLanding(pt); return land && inColumn(land.cell) })
    if (process.env.ND_DEBUG_PVP) console.log('[pitlava]', JSON.stringify({ me: bot.entity.position.floored(), him: f, rimY: theirPit.rimY, cands: cands.map(pt => { const land = bucketLanding(pt); return { pt: [pt.x, pt.y, pt.z], dist: +pt.distanceTo(eye0).toFixed(2), land: land && [land.cell.x, land.cell.y, land.cell.z], hit: land && [land.block.x, land.block.y, land.block.z] } }), pick: !!pick }))
    if (!pick) return false
    if (!(await holdItem(lava))) return false
    aim = 'free'
    await bot.lookAt(pick, true).catch(() => {})
    await sleep(60)
    try { bot.activateItem() } catch {}
    await sleep(80)
    aim = 'target'
    used('вылил лаву ему в яму')
    await holdWeapon()
    return true
  }

  // Ведро/огниво: используются взглядом на верхнюю грань блока под целью.
  // Куда встанет жидкость из ведра, если смотреть в точку pt. Ведро — не
  // установка блока по клику: сервер сам бросает луч от глаз по взгляду
  // (BucketItem.use → getPlayerPOVHitResult, дальность 4.5, контуры блоков,
  // жидкости мимо) и ставит жидкость перед первой задетой гранью. Смотреть
  // «в пол под ним» сквозь его коробку значит лить на её крышу (живая арена
  // 2026-09-26: бот встал на крышу коробки и вылил лаву себе под ноги).
  const bucketLanding = (pt) => {
    // Присев — глаза ниже (1.27 против 1.62), и луч ведра другой.
    const eye = bot.entity.position.offset(0, bot.getControlState('sneak') ? 1.27 : EYE, 0)
    const delta = pt.minus(eye)
    const dist = delta.norm()
    if (dist < 1e-3) return null
    let hit = null
    // Без фильтра: с фильтром WorldSync.raycast отдаёт блок, не считая
    // пересечения (ни грани, ни точки) — здесь нужна именно грань.
    try { hit = bot.world.raycast(eye, delta.scaled(1 / dist), 4.5) } catch {}
    if (!hit) return null
    const N = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][hit.face]
    if (!N) return null
    return { block: hit.position, cell: hit.position.offset(N[0], N[1], N[2]) }
  }
  const useOnGroundAt = async (item, cell, what) => {
    const below = bot.blockAt(cell.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') return false
    if (/_bucket$/.test(item.name)) {
      const land = bucketLanding(below.position.offset(0.5, 1, 0.5))
      if (!land || !land.cell.equals(cell)) return false
    }
    if (!(await holdItem(item))) return false
    aim = 'free'
    try {
      await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
      await sleep(50)
      if (item.name === 'flint_and_steel') await withTimeout(bot.activateBlock(below, new Vec3(0, 1, 0)), 600)
      else bot.activateItem()
    } catch {}
    await sleep(80)
    aim = 'target'
    used(what)
    return true
  }

  // Забрать жидкость обратно ведром.
  const scoop = async (cell) => {
    const bucket = findItem(bot, i => i.name === 'bucket')
    if (!bucket) return
    if (!(await holdItem(bucket))) return
    aim = 'free'
    try {
      await bot.lookAt(cell.offset(0.5, 0.2, 0.5), true)
      await sleep(50)
      bot.activateItem()
    } catch {}
    await sleep(80)
    aim = 'target'
  }

  // Стреляют, пока строим столб (2026-09-27, пользователь: «не выворачиваются
  // от стрел, когда на башню залезают»). На столбе вбок не уйти, а между
  // прыжками руки свободны: он тянет лук (дольше 0.25 с) или целится заряженным
  // арбалетом — повернуться к нему и поднять щит (спереди стрела гасится
  // целиком), держать, пока не выстрелит, и ещё на полёт стрелы; щита нет —
  // присесть (рамка ниже на 0.3) и переждать выстрел.
  // Блок или щит перед каждым блоком столба — по фазе его натяжения (bowWatch,
  // по тикам). Замер 2026-09-27 (try-towerarrows): щит «заранее, пока лук в
  // руке» не принял ни одной стрелы — бот-лучник держит тетиву, пока щит
  // поднят к нему (bow.js holdWhile, до 2.5 с), а мы через 2.5 с опускали щит
  // под блок — и стрела уходила ровно в это окно, 9–10 попаданий за подъём.
  // Как человек: блок — пока он только начал тянуть (полное натяжение 1.15 с,
  // наш шаг столба ~0.5 с); натянул почти — щит к нему и ждать выстрела
  // дольше его терпения, чтобы стрела ушла в щит; выстрелил — блок, пока он
  // тянет следующую. Щита нет — строить без пауз: на столбе 1×1 от стрелы не
  // отойти (стрелу ловит бокс шире нашего на 0.3 с каждой стороны).
  const TOWER_SAFE_DRAW_MS = 500
  const towerShield = async () => {
    if (!entity.isValid || !prof.player) return null
    const shield = guard && guard.stats && guard.stats.worn
    if (!shield) return null
    const held = entity.equipment && entity.equipment[0] ? entity.equipment[0].name : ''
    const xbow = held === 'crossbow' && !!bowWatch.loadedAt
    const drawMs = bowWatch.drawAt ? gameClock.now() - bowWatch.drawAt : -1
    // Не тянет или только начал — блок успеваем до выстрела.
    if (!xbow && drawMs < TOWER_SAFE_DRAW_MS) return null
    // Не видит нас — и выстрела не будет.
    if (!raySees(bot, entity.position.offset(0, EYE, 0), bot.entity.position.offset(0, 1.2, 0))) return null
    try { await bot.lookAt(entity.position.offset(0, 1.4, 0), true) } catch {}
    const raised = await guard.raise(true)
    if (process.env.ND_DEBUG_TOWER) console.log('[towerShield] raise', JSON.stringify({ drawMs, xbow, raised, shots: bowWatch.shots }))
    const t0 = gameClock.now()
    const shots0 = bowWatch.shots
    let shot = false
    // Его терпение с поднятым щитом — 2.5 с (bow.js holdMaxMs); ждать дольше.
    while (gameClock.now() - t0 < 4000 && !ctl.aborted && entity.isValid) {
      if (bowWatch.shots > shots0) { shot = true; break }
      // Опустил лук, не выстрелив (сменил оружие), арбалет разряжен иначе — блок.
      if (!bowWatch.drawAt && !bowWatch.loadedAt) break
      if (!raySees(bot, entity.position.offset(0, EYE, 0), bot.entity.position.offset(0, 1.2, 0))) break
      // Смотреть на него: щит держит только спереди (по горизонтали).
      bot.lookAt(entity.position.offset(0, 1.4, 0), true).catch(() => {})
      await sleep(TICK_MS)
    }
    // Стрела ещё летит — щит держать, пока не долетит.
    if (shot) await sleep(Math.min(400, 60 + entity.position.distanceTo(bot.entity.position) * 17))
    await guard.raise(false)
    if (process.env.ND_DEBUG_TOWER) console.log('[towerShield] lower', JSON.stringify({ shot, waited: gameClock.now() - t0 }))
    if (shot) { st.towerShots = (st.towerShots || 0) + 1; if (ready('towerShieldNote')) { rest('towerShieldNote', 3000); used('на столбе — стрела в щит, строю дальше') } }
    return 'waited'
  }

  const pendingLava = []
  // Вода, которой смыли паутину с себя: вычерпать, когда стекла.
  const pendingWater = []

  // Путь к нему перекрыт (живая арена 2026-09-26: лава под ним, он на блоке
  // посреди лавы, мы у края — две минуты оба стояли, «застой — ничья»). На
  // прямой к нему: лава или огонь на уровне ног, дыра или лава в полу. Как
  // игрок: лаву — зачерпнуть пустым ведром (источник) или залить водой,
  // клетку — заложить блоком (мост через лаву и яму).
  const hazardOnLine = () => {
    const me0 = bot.entity.position
    const dx = entity.position.x - me0.x; const dz = entity.position.z - me0.z
    const len = Math.hypot(dx, dz)
    if (len < 1) return null
    const feetY = Math.floor(me0.y + 1e-3)
    for (let t = 0.8; t <= Math.min(4.5, len - 0.5); t += 0.35) {
      const feet = new Vec3(Math.floor(me0.x + dx / len * t), feetY, Math.floor(me0.z + dz / len * t))
      const fn = blockName(bot, feet) || ''
      if (/^(lava|fire|soul_fire)$/.test(fn)) return { cell: feet, kind: fn }
      const floor = feet.offset(0, -1, 0)
      const fl = bot.blockAt(floor)
      if (fl && (fl.name === 'lava' || (fl.boundingBox === 'empty' && !/water|cobweb/.test(fl.name)))) return { cell: floor, kind: fl.name === 'lava' ? 'lava' : 'pit' }
    }
    return null
  }
  const unblockPath = async () => {
    const h = hazardOnLine()
    if (!h) return false
    if (h.cell.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, EYE, 0)) > 4.4) return false
    const b = bot.blockAt(h.cell)
    const lava = !!b && b.name === 'lava'
    let level = null
    try { level = b && b.getProperties ? b.getProperties().level : null } catch {}
    clear()
    if (lava && (level === 0 || level === '0') && findItem(bot, i => i.name === 'bucket')) {
      await scoop(h.cell)
      await holdWeapon()
      if (blockName(bot, h.cell) !== 'lava') { used('лава между нами — зачерпнул ведром'); return true }
    }
    if (pickFiller(bot)) {
      const r = await placeBlockAt(bot, h.cell, { timeoutMs: 700, honest: true }).catch(() => ({ ok: false }))
      await holdWeapon()
      if (r.ok) { used(h.kind === 'pit' ? 'дыра между нами — заложил блоком' : 'лава между нами — заложил блоком'); return true }
    }
    const wb = lava ? findItem(bot, i => i.name === 'water_bucket') : null
    if (wb && !/nether/.test(String((bot.game && bot.game.dimension) || ''))) {
      await useOnGroundAt(wb, h.cell, 'лава между нами — залил водой')
      pendingWater.push({ cell: h.cell, at: gameClock.now() })
      await holdWeapon()
      return true
    }
    return false
  }

  // Копать, пока не случилось важнее: abortIf() → причина — копку рвём
  // (bot.stopDigging), инструмент берёт сама обёртка bot.dig (tools.install).
  const digWatch = async (block, abortIf) => {
    let why = null
    const plan = tools.bestFor(bot, block)
    const iv = gameClock.setInterval(() => {
      if (why) return
      const w = abortIf()
      if (w) { why = w; try { bot.stopDigging() } catch {} }
    }, TICK_MS)
    try { await withTimeout(bot.dig(block, true), (Number.isFinite(plan.ms) ? plan.ms : 1000) + 500) } catch {} finally { gameClock.clearInterval(iv) }
    return why
  }


  // Съесть или выпить то, что в руке. Не bot.consume(): mineflayer считает
  // еду законченной по событию heldItemChanged, а оно приходит от сервера через
  // мгновение после того, как предмет взят в руку, — еда обрывалась, не
  // начавшись. Прогон: оба лучника умерли с двумя яблоками в рюкзаке, зелье
  // силы не выпито ни разу, а бот, поставив стенку «перед едой», тут же
  // выбегал из-за неё. Держим «использовать», пока предмета не станет меньше.
  // Темп (2026-09-25: «не может позволить себе кушать, когда его забивают»):
  // против человека глоток держится, только пока безопасно (tempo.safe: он не
  // добежит и не дострелит раньше конца глотка, по нам не попали, не горим).
  // Стало опасно — бросаем в тот же тик. desperate — прижат и хп на исходе:
  // доедаем, что бы ни было.
  // Он ест или пьёт, и мы успеем наказать до конца его глотка (2026-09-26,
  // жалоба: «вдвоём пьют зелье и смотрят друг на друга, хотя кто-то мог
  // атаковать»): рукой — спринтом (tempo.SPRINT_BPT) до края руки раньше, чем
  // он допьёт; зельем вреда — 3–7 бл. на виду; арбалетом — заряжен, или
  // быстрая перезарядка (10 тиков, CrossbowItem.getChargeDuration) успеет;
  // луком — натяжение успеет. Такое окно дороже своего бафа.
  const punishable = () => {
    try {
      if (!prof.player || !tempo.ON || !entity || !entity.isValid || !bot.entity) return null
      const c = tt.state(entity).consuming
      if (!c || c.left < 300) return null
      const me0 = bot.entity.position
      const r0 = reachFrom(me0.offset(0, EYE, 0), entity)
      const d0 = Math.hypot(entity.position.x - me0.x, entity.position.z - me0.z)
      if (Math.abs(entity.position.y - me0.y) < 2.5 && (Math.max(0, r0 - HIT_REACH) / tempo.SPRINT_BPT) * TICK_MS + 150 < c.left) return { kind: 'rush', left: c.left }
      if (!raySees(bot, me0.offset(0, EYE, 0), entity.position.offset(0, (entity.height || 1.8) * 0.55, 0))) return null
      if (d0 > 3 && d0 < 7 && findItem(bot, i => i.name === 'splash_potion' && /harming$/.test(potionOf(i) || ''))) return { kind: 'harm', left: c.left }
      const arrowsNow = rangedAllowed() && !!findItem(bot, i => /arrow$/.test(i.name))
      const xbs = arrowsNow ? ranged.crossbows(bot) : []
      if (d0 >= 2.5 && d0 <= 40 && xbs.some(x => x.info.loaded)) return { kind: 'crossbow', left: c.left }
      if (d0 >= 4 && d0 <= 30 && xbs.length && c.left > 1000) return { kind: 'crossbow', left: c.left }
      if (d0 >= 5 && d0 <= 30 && arrowsNow && findItem(bot, i => i.name === 'bow') && c.left > 900) return { kind: 'bow', left: c.left }
      return null
    } catch { return null }
  }

  const eatHeld = async (name, abortIf = null, { desperate = false, buff = false } = {}) => {
    const had = countOf(bot, name)
    await sleep(120)
    if (!bot.heldItem || bot.heldItem.name !== name) return false
    const unsafe = prof.player && tempo.ON && !desperate ? tt.guard(name, { fortSealed }) : null
    // Пока брали предмет в руку (≥120 мс), он мог подбежать — тогда не начинать.
    if (unsafe && unsafe()) { tt.stats.refused++; used('не стал есть: ' + (tt.lastAbort || 'опасно')); return false }
    // FIX: булава сверху — глоток не начинать (ваншот; защита — в цикле).
    if (FIX && maceNow()) { maceAbort('глоток'); return false }
    // FIX: он сам начал есть или пить, а мы успеем наказать — бросить свой
    // глоток (баф всегда, лечение — пока хп не на исходе) и наказывать.
    const hpE = bot.health ?? 20
    // Баф — бросить, едва он сам начал пить (не в такт, сближаться); лечение
    // на хорошем хп — только если успеем наказать.
    const punishFirst = () => FIX && !desperate && (buff || hpE >= 12) && !fortSealed() && !!(buff ? tt.state(entity).consuming : punishable())
    if (prof.player) tt.noteConsume(name, { desperate, fortSealed: fortSealed() })
    let dropped = false
    session.eating = true
    try {
      bot.activateItem()
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 2400 && countOf(bot, name) >= had && !ctl.aborted && !(abortIf && abortIf())) {
        if (unsafe && unsafe()) { dropped = true; break }
        if (FIX && maceNow()) { dropped = 'mace'; break }
        if (punishFirst()) { dropped = 'punish'; break }
        await sleep(50)
      }
    } finally {
      session.eating = false
    }
    const ok = countOf(bot, name) < had
    if (!ok) { try { bot.deactivateItem() } catch {} }
    if (!ok && dropped === 'mace') maceAbort('глоток')
    else if (!ok && dropped === 'punish') { st.eatPunish.swaps++; used('бросил свой глоток — он сам пьёт, наказываю') } else if (!ok && dropped) { tt.stats.aborted++; used('бросил глоток: ' + (tt.lastAbort || 'опасно')) }
    return ok
  }

  const drink = async (item, what, abortIf = null, opt = {}) => {
    if (!(await holdItem(item))) return false
    if (!(await eatHeld(item.name, abortIf, opt))) return false
    used(what)
    const role = potionRole(potionOf(item))
    if (role === 'heal' || role === 'regen') st.healed.push(what)
    return true
  }

  const escapePearl = async () => {
    const pearl = findItem(bot, i => i.name === 'ender_pearl')
    if (!pearl || !ready('pearl') || (bot.health ?? 0) <= 6) return null
    rest('pearl', 3000)
    const from = entity.position.clone()
    aim = 'free'
    const r = (await holdItem(pearl)) ? await throwMod.throwAt(bot, null, {
      item: bot.heldItem,
      pick: throwMod.escapePick(bot, tp => Math.min(32, Math.hypot(tp.x - from.x, tp.z - from.z)), { maxDrop: 4 })
    }).catch(() => null) : null
    aim = 'target'
    if (!r?.thrown) { await holdWeapon(); return null }
    used('жемчуг: оторвался')
    await sleep(900)
    return { thrown: true, how: 'уход жемчугом', clear: !tt.threats().some(e => e?.position && e.isValid !== false && e.position.distanceTo(bot.entity.position) < 8) }
  }

  const finish = async (out) => {
    gameClock.clearInterval(aimTimer)
    clear()
    pathTo(false)
    restoreMoves()
    try { bot.deactivateItem() } catch {}
    if (guard) await guard.raise(false)
    for (const cell of pendingLava.splice(0)) await scoop(cell)
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('physicsTick', onTickSwat)
    bot.removeListener('physicsTick', onTickArcher)
    bot.removeListener('entityHurt', onMobHurt)
    bot.removeListener('death', onSelfDeath)
    bot.removeListener('physicsTick', onTickFall)
    edgeGuard.stop()
    bot.removeListener('nd_mlg', onMlg)
    if (edgeGuard.stats.saves || edgeGuard.stats.air) st.tricks['рефлекс края: ' + Object.entries(edgeGuard.stats.why).map(([k, v]) => `${k}×${v}`).join(', ')] = 1
    bot.removeListener('blockBreakProgressObserved', onCrack)
    bot.removeListener('entityDead', onDead)
    tt.close()
    if (session.tempo === tt) session.tempo = null
    mc.close()
    sky.close()
    bm.close()
    cx.close()
    mf.close()
    // 1 против 2 (duo.js), подручное (utility.js): итог — в приёмы (до того, как их соберут ниже).
    duo.close()
    util.close()
    // Человек (showman): итог — доля времени на показуху и финты — в приёмы.
    const human = hm && prof.player ? hm.report() : undefined
    if (hm) hm.close()
    // Копьё (2026-09-26): разгоны и попадания, смены копьё ↔ меч.
    if (st.spearCharges || st.spearSwaps) st.tricks[`копьё: разгонов ${st.spearCharges || 0}, попал ${st.spearChargeHits || 0}; смен копьё↔меч ${st.spearSwaps || 0}`] = 1
    const tricks = Object.keys(st.tricks).length ? st.tricks : undefined
    const ts = tt.stats
    // Тишина до конца боя — тоже окно.
    { const gapEnd = gameClock.now() - quiet.at; if (gapEnd >= 10000) { quiet.gaps10++; quiet.total10 += gapEnd } if (gapEnd > quiet.longest) quiet.longest = gapEnd }
    return {
      pvp: prof.player || undefined,
      micro: true,
      // Качество боя (2026-09-26): окна без размена ≥10 с, оба ели/пили разом,
      // стройка (под его рукой, брошена), наказания едока, нажим, булава сверху.
      quality: prof.player ? {
        gaps10: quiet.gaps10,
        quiet10S: Math.round(quiet.total10 / 100) / 10,
        longestS: Math.round(quiet.longest / 100) / 10,
        bothEatS: Math.round(ovl.ms / 100) / 10,
        bothEatN: ovl.n,
        bothEatOpenS: Math.round((ovl.openMs || 0) / 100) / 10,
        pearlSpace: st.pearlSpace || 0,
        build: st.build,
        eatPunish: st.eatPunish,
        eatHits: ts.busyByKind['ест/пьёт'] || 0,
        pressure: st.pressure || 0,
        maceAborts: st.maceAborts || 0,
        phases: human && human.фазы,
        showS: human ? Math.round(human.showMs / 100) / 10 : undefined,
        persona: human && human.нрав
      } : undefined,
      // Темп: сколько ел и сколько из этого под давлением, сколько бросил,
      // чем открыл бой, сколько попал, пока он был занят, вскрытия коробки.
      tempo: prof.player ? { on: tempo.ON, open: tt.opening || undefined, ate: ts.consumes, pressured: ts.pressured, aborted: ts.aborted, desperate: ts.desperate || undefined, refused: ts.refused || undefined, foeAte: ts.foeConsumes, busyHits: ts.busyLanded, busyBy: Object.keys(ts.busyByKind).length ? ts.busyByKind : undefined, punish: Object.keys(ts.punish).length ? ts.punish : undefined, breaches: ts.breaches || undefined, escapes: ts.breachEscapes || undefined, kites: ts.kites || undefined } : undefined,
      target: label,
      kills: kills.length ? kills : undefined,
      assessment: planText || undefined,
      arrows: st.arrows || undefined,
      blocks: st.blocks || undefined,
      style: st.style,
      arrowHits: st.arrows ? (st.arrowHits || 0) : undefined,
      towerShots: st.towerShots || undefined,
      // Арена: сколько держал поле, пока он внизу; возвращения; добытые блоки; мобы.
      holds: st.holds || undefined,
      returns: st.returns || undefined,
      gathered: st.gathered || undefined,
      mobKills: st.mobKills || undefined,
      swings: st.swings,
      landed: st.landed,
      crits: st.crits,
      sprintHits: st.sprintHits,
      axeOnShield: st.axeOnShield || undefined,
      // Булава и заряды ветра (mace.js): взлёты, удары с падения, толчки, защита.
      mace: mc.report(),
      // Элитры (elytra.js): взлёты, уходы с лечением, пике, посадки; его полёт.
      elytra: sky.report(),
      // «Динамит» (boom.js): поставил, взорвал, урон ему и себе, разобрал его,
      // ушёл от его взрывчатки, сколько блоков выбито (светокамень — дыры).
      boom: bm.report(),
      // Кристаллы (crystal.js): поставил, ударом/стрелой, заранее, взрывы свои и
      // его, урон ему и себе, «попы» (его — от моих, мои — от его), обсидиан
      // вокруг ног, сбил его кристалл, уходы; сквозь стену (должно быть 0).
      crystal: cx.report(),
      // Ближний бой по звукам сервера (melee.js): спринт-удары, криты, серии,
      // W/S-tap, отброс с jump-reset и без, свапы; тотем; замедление с предметом.
      melee: mf.report(),
      totem: tot.pops || tot.fast || tot.slow ? { pops: tot.pops, reequips: tot.reequips, fails: tot.reequipFails || undefined, fast: tot.fast, slow: tot.slow, why: tot.why } : undefined,
      itemUse: bot._ndUse ? (() => { const s = bot._ndUse.stats; const b = use0 || {}; const df = k => (s[k] || 0) - (b[k] || 0); return { slowTicks: df('slowTicks'), sprintBlocked: df('sprintBlocked'), sprintNoFwd: df('sprintNoFwd'), sprintStops: df('sprintStops'), sprintStarts: df('sprintStarts'), wallStops: df('wallStops'), wallTicks: df('wallTicks') } })() : undefined,
      // Человек (showman.js): нрав, фазы, время на стойку/финты, что делал.
      human,
      dodges: st.dodges || undefined,
      tricks,
      healed: st.healed.length ? st.healed : undefined,
      weapon: weapon ? weapon.name : 'кулаки',
      hp: `${st.hpStart} -> ${Math.round(bot.health ?? 0)}`,
      left: leftovers(bot),
      ...out
    }
  }

  // Разбор толпы до первого удара: с кого начать и чем бить. Цель, которую
  // дал мозг, меняется только при зачистке (clearArea) — иначе он просил
  // именно её.
  let planText = null
  let planVerdict = null
  let replanAt = 0
  const retarget = (e) => {
    if (!e || e === bot.entity || (bot.entity && e.id === bot.entity.id)) return
    entity = e
    label = entity.username || entity.name
    track = makeTracker(entity)
    seenAt = gameClock.now()
    prof = profileOf(entity)
    killed = false
    targetHurtAt = 0
    lastHurtByTarget = gameClock.now()
    if (guard) guard.watch(entity, 3.2)
    pickWeaponFor(entity)
  }
  if (!prof.player) {
    try {
      const p = assess.plan(bot, { radius: clearArea || 16 })
      if (p) {
        planText = p.text
        planVerdict = p.verdict
        if (clearArea && p.first && p.first.e && p.first.e !== entity) retarget(p.first.e)
      }
    } catch {}
    pickWeaponFor(entity)
  }

  await holdWeapon()
  if (guard) await guard.wear()
  if (process.env.ND_DEBUG_PVP) console.log('[pvp] start', JSON.stringify({ t: label, held: heldName(), inv: bot.inventory.items().map(i => `${i.name}×${i.count}`) }))

  // Перед сближением — баффы, пока до него далеко: глоток стоит 1.6 с, и
  // пить вплотную значит подарить три удара.
  // minD — с какой дистанции пить (глоток 1.6 с). В бою зовётся снова, когда
  // окно есть: он отошёл, сидит на столбе, мы в коробке (арена 2026-09-25:
  // бой вплотную с первой секунды — 7 питьевых зелий так и не открыты).
  const buffUp = async (minD = 6, extra = []) => {
    const d = entity.position.distanceTo(bot.entity.position)
    if (d < minD) return
    for (const [kind, eff] of [['strength', 'strength'], ['swiftness', 'speed'], ['regeneration', 'regeneration'], ['fire_resistance', 'fire_resistance'], ...extra]) {
      if (hasEffect(bot, eff)) continue
      const splash = findItem(bot, i => i.name === 'splash_potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === kind)
      if (splash) {
        if (await holdItem(splash)) { await useAt(bot.entity.yaw, -Math.PI / 2); used('зелье на себя: ' + kind) }
        continue
      }
      const pot = findItem(bot, i => i.name === 'potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === kind)
      // Баф — не ценой ударов: подошёл на удар или бьёт — глоток бросаем
      // (арена 2026-09-25: «пока зелья пьёт, я его тупо забил»). Один глоток
      // за окно, а не все подряд: 4 зелья = 6.4 с стоя.
      // Темп: против человека мерка — не дистанция, а успеет ли он добежать
      // или дострелить за глоток (tempo.safe); сторож в eatHeld бросит глоток сам.
      const tempoGate = tempo.ON && prof.player
      if (pot && tempoGate) {
        const sf = tt.safe(tempo.consumeMs('potion'), { fortSealed: fortSealed() })
        if (!sf.ok) { tt.stats.refused++; break }
      }
      // FIX: он сам пьёт или ест, и мы успеем наказать — окно дороже бафа.
      if (pot && FIX && prof.player && !fortSealed() && (punishable() || !!tt.state(entity).consuming)) {
        st.eatPunish.skips = (st.eatPunish.skips || 0) + 1
        if (ready('punFirstNote')) { rest('punFirstNote', 3000); used('не пью — он сам пьёт, наказываю') }
        break
      }
      if (pot && (tempoGate || entity.position.distanceTo(bot.entity.position) >= minD)) {
        const hp0 = bot.health ?? 20
        const close = () => reachFrom(bot.entity.position.offset(0, EYE, 0), entity) < HIT_REACH + 1.2 || (bot.health ?? 20) < hp0 - 0.5
        if (close()) break
        // FIX: он видит нас — стенка между нами перед глотком.
        if (FIX && prof.player) await coverForDrink()
        const ok = await drink(pot, 'выпил ' + kind, close, { buff: true })
        if (!ok) { used('бросил пить — он рядом'); break }
        if (minD < 6 && !tempoGate) break
      }
    }
    await holdWeapon()
  }
  // План начала (tempo.pickOpening) — на каждый бой свой, по дистанции, киту,
  // здоровью и характеру: рывок со спринт-ударом, лук издалека, баффы (только
  // пока он не успеет добежать), жемчуг к нему, зелья в него, коробка с
  // баффами внутри. Против моба — как раньше: баффы, пока он далеко.
  let rushUntil = 0
  let bowFirstUntil = 0
  let splashFirst = false
  if (tempo.ON && prof.player) {
    await sleep(style.openDelayMs)
    const drinkable = k => findItem(bot, i => i.name === 'potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k)
    const d0 = entity.position.distanceTo(bot.entity.position)
    const plan = tempo.pickOpening({
      d: d0,
      hp: bot.health ?? 20,
      aggression: style.aggression,
      foeBusy: !!tt.state(entity).consuming,
      has: {
        // Арбалет — тоже «издалека» (ranged.js, 2026-09-26): стрелы или фейерверки.
        bow: rangedAllowed() && !!((findItem(bot, i => i.name === 'bow') && findItem(bot, i => /arrow$/.test(i.name))) ||
          (findItem(bot, i => i.name === 'crossbow') && findItem(bot, i => /arrow$|^firework_rocket$/.test(i.name)))),
        drinkBuffs: ['strength', 'swiftness', 'regeneration'].some(k => drinkable(k)),
        splashDebuff: !!findItem(bot, i => i.name === 'splash_potion' && potionRole(potionOf(i)) === 'debuff'),
        pearls: countOf(bot, 'ender_pearl'),
        // Коробка в начале — только если он не дойдёт за стройку (FIX).
        fort: fortPossible() && !(FIX && buildHot(BOX_FRONT_MS)),
        heal: !!healItem()
      }
    })
    tt.opening = plan.kind
    st.style.начало = plan.kind
    used('начало: ' + ({ rush: 'рывок', bow: 'лук издалека', buff: 'баффы', splash: 'зелья в него', pearl: 'жемчуг к нему', fort: 'коробка с баффами' })[plan.kind])
    if (plan.kind === 'buff') await buffUp(0)
    else if (plan.kind === 'rush') rushUntil = gameClock.now() + 3000
    else if (plan.kind === 'bow') bowFirstUntil = gameClock.now() + 6000
    else if (plan.kind === 'splash') splashFirst = true
    else if (plan.kind === 'pearl') {
      const pearl = findItem(bot, i => i.name === 'ender_pearl')
      aim = 'free'
      const pr = pearl && (await holdItem(pearl))
        ? await throwMod.throwAt(bot, leadFn(0.1), {
          item: bot.heldItem,
          onAim: (res) => !!(res.land && !res.land.void && throwMod.safeLanding(bot, res.land.tp) && res.land.tp.y > bot.entity.position.y - 5)
        }).catch(() => null)
        : null
      aim = 'target'
      if (pr && pr.thrown) { used('жемчуг к нему'); await sleep(800) }
      await holdWeapon()
      rushUntil = gameClock.now() + 2500
    } else if (plan.kind === 'fort') {
      rest('fort', 15000)
      if (!(await fortOut())) await buffUp(0)
    }
  } else await buffUp()

  // Разгон копьём издалека (2026-09-26): против бегущего на нас окно разгона
  // (spear.chargeWindow) открывается в 8–10 бл. — дальше FAR, где цикл занят
  // погоней; блок копья (4б) до такого расстояния не доходит.
  const spearChargeFar = async (r0, d0) => {
    if (!prof.player || !seesNow() || (bot.food ?? 20) <= 6 || !ready('spearCharge')) return false
    const sp = spear.spearOf(bot)
    if (!sp || !stepSafe(bot, keyDir(bot, 'forward'))) return false
    const me0 = bot.entity.position
    const v0 = track.vel()
    const tw = (v0.x * (me0.x - entity.position.x) + v0.z * (me0.z - entity.position.z)) / Math.max(d0, 0.1)
    if (!spear.chargeWindow(sp.item.name, r0, tw)) return false
    rest('spearCharge', 3000)
    if (!bot.heldItem || bot.heldItem.name !== sp.item.name) await holdItem(sp.item)
    if (guard) await guard.raise(false)
    aim = 'free'
    const hpS = healthOf(bot, entity)
    const ch = await spear.charge(bot, ctl, entity, { maxMs: 1800, safe: k => stepSafe(bot, keyDir(bot, k)), vel: () => track.vel(), onHit: () => { st.landed++ } })
    aim = 'target'
    st.spearCharges = (st.spearCharges || 0) + 1
    if (ch.hit) st.spearChargeHits = (st.spearChargeHits || 0) + 1
    used(ch.hit ? `разгон копьём — попал (${hpS != null && healthOf(bot, entity) != null ? Math.round((hpS - healthOf(bot, entity)) * 10) / 10 : '?'} хп)` : `разгон копьём — мимо (${ch.why || 'время'})`)
    return true
  }
  const seesNow = () => { try { return raySees(bot, bot.entity.position.offset(0, EYE, 0), entity.position.offset(0, (entity.height || 1.8) * 0.55, 0)) } catch { return false } }

  // Страховка от цикла без тика (2026-09-26, try-duo: качели выбора цели шли
  // проходами цикла только с микрозадачами — таймеры, пакеты и RPC демона
  // стояли минуту): полсотни проходов подряд без макрозадачи — отдать ход.
  let loopYielded = true
  let loopSpins = 0
  const markLoopYield = () => { loopYielded = true }
  while (!ctl.aborted) {
    if (loopYielded) loopSpins = 0
    else if (++loopSpins >= 50) { loopSpins = 0; await new Promise(resolve => setImmediate(resolve)) }
    loopYielded = false
    setImmediate(markLoopYield)
    const now = gameClock.now()
    if (!bot.entity || (bot.health ?? 20) <= 0 || selfDied) return finish({ died: true })
    // Падаем с высоты, ведро наготове (edges.installFallGuard) — рука его, не
    // боя: смена предмета посреди падения уносила ведро из руки.
    edgeTally(now)
    if (edges.falling(bot)) { clear(); await sleep(TICK_MS); continue }
    // Моб, по которому только что попали и который исчез, — убит: сущность
    // снимается с мира через секунду после смерти, и entityDead приходит не всегда.
    if (!killed && !entity.isValid && !prof.player && now - targetHurtAt < 2500) killed = true
    // Моб по дороге (mobDetour): убит, ушёл или не видно — снова соперник.
    if (mobDetour) {
      const md = mobDetour
      let seenM = false
      try { seenM = entity.isValid && assess.inSight(bot, entity) } catch {}
      if (seenM) md.seenAt = now
      const farM = !entity.isValid || !entity.position || entity.position.distanceTo(bot.entity.position) > 16
      if (killed || farM || lookDead(bot, entity) || now - md.seenAt > 5000 || now - md.at > 25000) {
        const wasKilled = killed
        if (wasKilled) st.mobKills = (st.mobKills || 0) + 1
        dead.add(entity.id)
        mobDetour = null
        killed = false
        unseen = false
        const back = md.back
        if (back && back.isValid !== false && bot.entities[back.id]) {
          retarget(back)
          used(wasKilled ? `убил ${md.name} — снова к ${label}` : `${md.name} отстал — снова к ${label}`)
          await holdWeapon()
          continue
        }
        return finish({ lost: `${back ? (back.username || back.name) : '?'} пропал из виду` })
      }
    }
    // Цель, которую не видно 6 секунд, — за стеной или в пещере: гнаться за
    // ней pathfinder'ом значит биться в стекло (живой прогон: бот ломился к
    // криперу снаружи арены). Бросаем её, как пропавшую.
    if (!prof.player) {
      if (assess.inSight(bot, entity)) seenAt = now
      else if (now - seenAt > 6000) { dead.add(entity.id); unseen = true }
    }
    // Цель пропала без удара от нас — при зачистке это не повод уходить.
    const lostIt = !killed && (!entity.isValid || unseen)
    if (unseen && !clearArea) return finish({ lost: `${label} не видно — за стеной` })
    unseen = false
    if (killed || (lostIt && clearArea)) {
      dead.add(entity.id)
      if (killed) kills.push(label)
      let next = null
      if (clearArea) {
        // Следующий — по плану (кто опаснее за время, что на него уйдёт), а
        // не просто ближайший.
        try { const p = assess.plan(bot, { radius: clearArea, exclude: dead }); next = p && p.first ? p.first.e : null } catch {}
        if (!next) next = nextFoe(bot, clearArea, dead)
      }
      if (!next && prof.player) { const o = otherAttacker(); if (o) { next = o.e; used(`переключился на ${o.e.username}`) } }
      if (!next) {
        // Победа (showman): присесть над ним, взмах, оглядеться — рефлексом
        // мимо боя, он кончится сам (~3 с).
        if (hm && killed && prof.player) hm.victory()
        return finish(kills.length ? { killed: kills.length > 1 ? kills.join(', ') : kills[0] } : { lost: `${label} пропал из виду` })
      }
      // Заряд меча и перезарядки приёмов — общие, они про нас.
      retarget(next)
      await holdWeapon()
      continue
    }
    // Перепланировать на ходу: зашипел крипер рядом, или цель ушла далеко, а
    // рядом другой бьёт.
    if (clearArea && !prof.player && now >= replanAt) {
      replanAt = now + 1500
      try {
        const p = assess.plan(bot, { radius: clearArea, exclude: dead })
        const f = p && p.first
        if (f && f.e && f.e !== entity && f.e.isValid !== false) {
          const curD = entity.position.distanceTo(bot.entity.position)
          if (f.swelling || (curD > 10 && f.dist < 5)) { retarget(f.e); await holdWeapon(); continue }
        }
      } catch {}
    }
    if (!entity.isValid) return finish({ lost: `${label} пропал из виду` })
    if (now > deadline) return finish({ timeout: true, targetAlive: true })

    track.update()
    const me = bot.entity.position
    const eye = me.offset(0, EYE, 0)
    const d = Math.hypot(entity.position.x - me.x, entity.position.z - me.z)
    const dy = entity.position.y - me.y
    const r = reachFrom(eye, entity)
    const theirEye = entity.position.offset(0, EYE, 0)
    const theirR = reachFrom(theirEye, bot.entity)
    const hp = bot.health ?? 20
    // Общая проверка раньше нажима, стройки и атак. Лечебный предмет не
    // означает, что его можно успеть использовать под чужим оружием.
    const medical = findPotion(bot, 'splash_potion', 'heal') || findPotion(bot, 'potion', 'heal') ||
      findPotion(bot, 'potion', 'regen') || findItem(bot, i => /golden_apple$/.test(i.name))
    const safety = opts.safety.check({ target: entity, entities: tt.threats(),
      minHealth: Math.max(8, retreatAtHealth), instantHeal: !!medical })
    const safeMedical = medical && !safety.hazard && hp > safety.hit + 2 &&
      (medical.name === 'splash_potion' || tt.safe(tempo.consumeMs(medical.name), { fortSealed: fortSealed() }).ok)
    // Арена (arena.js, поле AR): бой на поле до конца — правило пользователя
    // («бой на поле», раунд до смерти); общий отход combat-safety с поля не
    // уводит (2026-09-30: кристалл снимает 12 — «не переживу размен» и бегство
    // на каждом проходе). Лечение по recover с безопасным лечением — ниже, как было.
    const arenaStay = !!AR && prof.player && safety.action !== 'dead'
    if (!arenaStay && safety.action !== 'fight' && (safety.action !== 'recover' || !safeMedical)) {
      pathTo(false); pathing = false; clear(); aim = 'free'
      if (guard) await guard.raise(false)
      let escape = null
      if (safety.action !== 'dead' && prof.player) {
        const chorus = await util.chorusMaybe(ctl, { hp, foes: duo.foes(), trapped: null,
          pearls: countOf(bot, 'ender_pearl'), canHeal: safety.healable,
          pearlAt: safety.threshold, burst: totemMod.burstOf(bot, entity) })
        if (chorus?.ok) escape = { clear: true, how: 'уход хорусом', chorus }
        else escape = await escapePearl()
      }
      aim = 'free'
      if (safety.action !== 'dead' && !escape?.clear) escape = await require('./combat-safety').disengage(session, ctl, tt.threats)
      used('общая безопасность: ' + safety.reason)
      return finish({ lowHealth: safety.action !== 'dead', safety, escape, health: bot.health })
    }
    if (safety.action === 'recover' && safeMedical) {
      pathTo(false); pathing = false; clear()
      if (guard) await guard.raise(false)
      if (medical.name === 'splash_potion') {
        if (await holdItem(medical)) { await useAt(bot.entity.yaw, -Math.PI / 2); st.healed.push('взрывное лечения') }
      } else if (medical.name === 'potion') await drink(medical, 'лечение до нового размена')
      else if (await holdItem(medical)) {
        if (await eatHeld(medical.name)) st.healed.push(medical.name)
      }
      await holdWeapon()
      await sleep(TICK_MS)
      continue
    }
    const their = usingItem(bot, entity)
    const blocking = their === 'shield'
    const theyEat = their && EDIBLE.test(their)
    const theyBow = their === 'bow' || their === 'crossbow'
    // Что он делает — чтобы ответить не шаблоном, а по ситуации.
    const theirHp = healthOf(bot, entity)
    const seesBody = raySees(bot, eye, entity.position.offset(0, (entity.height || 1.8) * 0.55, 0))
    // Честный прицел (pick.js, 2026-09-26: «боты через один блок пробивают»).
    // raySees прощает блок у самой цели — стенка его коробки проходила как
    // «виден», и удар уходил сквозь неё. Здесь — как у клиента игры: луч из
    // глаз до его рамки не упирается ни в блок, ни в паутину. sight.point —
    // куда бить (голова над стенкой, плечо из-за угла), sight.blocked — во что
    // упёрся прямой луч к груди.
    const sight = r <= HIT_REACH + 0.3 ? pick.aim(bot, entity, { eye: pick.eyeOf(bot), range: HIT_REACH }) : null
    const inSight = !!(sight && sight.point)
    sightOff = inSight ? sight.off : null
    // Спрятался за блоками рядом с нами (стенка перед едой — видно по лучу;
    // в руке, но под прицел не взять — тоже: стенка его коробки вплотную).
    // Не он, а мы за своей колонной в засаде (showman) — не ломать её самим.
    const hidden = prof.player && (!seesBody || (r <= HIT_REACH && !inSight)) && d <= FAR + 2 && !(hm && hm.hiding())
    // Ушёл на столб: выше нас и рукой не достать.
    // Только стоя на блоке: подброшенный зарядом ветра, прыжком или взлётом
    // булавы — не «на столбе», и ждать внизу тогда нечего (2026-09-26).
    const theyUp = dy > 2.5 && r > HIT_REACH && foeGrounded()
    // Занят не нами: ест, пьёт, прячется, сидит на столбе.
    const busyFoe = prof.player && (theyEat || hidden || theyUp)
    // Нажим (FIX, 2026-09-26: «зависают, стоят вдвоём, ничего не происходит»):
    // размена ударами не было style.pressMs (5–6.5 с) — сходиться и бить или
    // стрелять, поверх стойки, пассивных фаз, бафа и отрыва. Не когда лечимся в
    // целой коробке или на столбе и не на последних хп с лечением в рюкзаке.
    const pressing = FIX && prof.player && now - quiet.at > style.pressMs && !fortSealed() && !perch && !(hp <= 8 && !!healItem())
    if (pressing && !st.pressOn) { st.pressOn = true; st.pressure = (st.pressure || 0) + 1; bowFirstUntil = 0; used('нажим: долго без размена — иду бить') } else if (!pressing) st.pressOn = false
    // ---- Арена (arena.js передаёт поле): кто на поле, кто выпал.
    const meBelow = !!AR && me.y < AR.y - 1.5
    const meOut = !!AR && (meBelow || !onField(me))
    const heOut = !!AR && prof.player && !onField(entity.position) && entity.position.y < AR.y - 2.5
    // Он выпал, мы на поле — держать арену (2026-09-27, пользователь: «боты
    // должны на арене сражаться, а не с неё убегать»). Вылет с ринга — его
    // поражение: за ним не прыгать (фильтр ходов выше не выпускает с поля),
    // ждать у поля над ним, в шаге от края: вылезет — удар, виден — стрела
    // и трезубец (ветки ниже), пока его нет — лечиться (busyFoe).
    if (heOut && !meOut) {
      if (!st.holdSince) { st.holdSince = now; st.holds = (st.holds || 0) + 1; used('он выпал с поля — держу арену') }
      if (now >= holdGoalAt) {
        holdGoalAt = now + 1500
        const spot = guardSpot(entity.position)
        holdGoal = spot ? new goals.GoalNear(spot.x, spot.y, spot.z, 1) : new goals.GoalNear(AR.x, AR.y, AR.z, 3)
        if (spot && spot.distanceTo(me) > 2.2 && !pathing) { pathTo(true); pathing = true }
      }
    } else if (holdGoal) {
      holdGoal = null
      st.holdSince = 0
      if (pathing) { pathTo(false); pathing = false }
    }
    // ---- Мобы: любая угроза бойцу (2026-09-27). Моб бьёт нас или подошёл
    // бить (крипер — ближе 5), а соперник не в руке или кто-то из нас вне
    // поля — сперва моб, тем же циклом (профиль моба); убит или ушёл —
    // снова соперник (mobDetour, начало цикла). Крипер вплотную — всегда.
    if (prof.player && !mobDetour && now >= mobCheckAt) {
      mobCheckAt = now + 250
      const m = mobThreat()
      if (m && (r > HIT_REACH + 1.5 || meOut || heOut || (m.e.name === 'creeper' && m.dist < 3.5))) {
        mobDetour = { back: entity, at: now, seenAt: now, name: m.e.name }
        if (pathing) { pathTo(false); pathing = false }
        retarget(m.e)
        used(`${m.e.name} ${m.hitting ? 'бьёт меня' : 'идёт на меня'} — сперва его`)
        await holdWeapon()
        continue
      }
    }
    // ---- Выпал сам — вернуться на поле: это главное (2026-09-27,
    // пользователь: «он просто голову поднял и смотрел на соперника; бот
    // должен начать думать, как вернуться на арену; нет блоков — программа
    // выживания: быстро добыть и строиться»). Блоков мало — добыть рядом
    // (edges.gatherBlocks: земля, камень, песок — чем быстрее), потом столб
    // через дыру к уровню пола (edges.climbBack, floorY). Мобы — ветка выше.
    if (meBelow && prof.player && !edges.falling(bot) && ready('climbBack')) {
      rest('climbBack', 2500)
      if (pathing) { pathTo(false); pathing = false }
      clear()
      aim = 'free'
      // Далеко от поля (улетел, упал за стену) — сперва под поле: дыры ищутся в 40 блоках.
      const farH = Math.max(Math.abs(bot.entity.position.x - AR.x), Math.abs(bot.entity.position.z - AR.z))
      if (farH > AR.r + 10) {
        used('далеко от поля — иду под него')
        try { bot.pathfinder.setGoal(new goals.GoalNearXZ(AR.x, AR.z, Math.max(4, AR.r - 4))) } catch {}
        const tW = gameClock.now()
        while (gameClock.now() - tW < 25000 && !ctl.aborted && !selfDied && !mobThreat() && Math.max(Math.abs(bot.entity.position.x - AR.x), Math.abs(bot.entity.position.z - AR.z)) > AR.r) await sleep(250)
        try { bot.pathfinder.setGoal(null) } catch {}
      }
      const need = Math.max(2, Math.ceil(AR.y - bot.entity.position.y) + 1)
      let have = edges.fillerCount(bot)
      if (have < need) {
        if (!st.gatherNoteAt || now - st.gatherNoteAt > 15000) { st.gatherNoteAt = now; used(`блоков на подъём ${have} из ${need} — добываю`) }
        const gb = await edges.gatherBlocks(bot, mobCtl, { want: need + 4 - have, maxMs: 25000 })
        st.gathered = (st.gathered || 0) + gb.got
        if (gb.got) used(`добыл ${gb.got} бл. на подъём (${gb.what}, ${Math.round(gb.ms / 1000)} с)`)
        else if (gb.why && gb.why !== 'прервали') used(`блоки не добыл: ${gb.why}`)
        have = edges.fillerCount(bot)
      }
      if (have >= need && !mobThreat()) {
        const t0c = gameClock.now()
        const gK = buildGuard()
        let cb = null
        try { cb = await edges.climbBack(bot, guardCtl(gK), entity, { beforeStep: towerShield, archer: bowWatch.shots > 0 || !!findItem(bot, i => i.name === 'bow' || i.name === 'crossbow'), floorY: AR.y, exclude: badShafts, digNear: 12000 }) } catch (e) { cb = { ok: false, why: e.message } }
        if (buildDone(gK, 'подъём на поле')) cb = { ok: false, why: gK.why }
        // Не вышло — вся дыра (клетки рядом) из выбора: иначе следующая клетка той же дыры.
        if (cb && !cb.ok && cb.shaft && /не дошёл|не выломал|не растёт|не подпрыгнул/.test(cb.why || '')) for (let ax = -2; ax <= 2; ax++) for (let az = -2; az <= 2; az++) badShafts.add((cb.shaft.x + ax) + ',' + (cb.shaft.z + az))
        if (cb && cb.ok) st.returns = (st.returns || 0) + 1
        used(cb && cb.ok ? `вернулся на поле (${cb.how}, ${Math.round((gameClock.now() - t0c) / 1000)} с)` : `не вернулся: ${(cb && (cb.why || cb.how)) || '?'}`)
      }
      aim = 'target'
      await holdWeapon()
      continue
    }
    // Булава сверху (mace.js, 2026-09-26): он взлетел на заряде ветра или
    // падает на нас с высоты — щит к нему (передний щит держит удар булавы
    // целиком, LivingEntity.applyItemBlocking), без щита — шаг из-под точки,
    // куда он сядет; долетел до руки — ударить в воздухе (отброс уносит его из
    // досягаемости). Сидит сверху с булавой — не стоять под ним.
    const maceThreat = prof.player ? mc.threat() : null
    // Тотем на время булавы сверху — в ПРАВУЮ руку: левая держит щит (он
    // гасит удар целиком, если успеем развернуться), а тотем спасает из любой
    // руки (LivingEntity.checkTotemDeathProtection смотрит обе). Раньше ветка
    // ниже делала continue раньше проверки тотема, и боты умирали от булавы с
    // тотемом в рюкзаке (2026-09-26: «тотем не юзают, чтобы не умирать»).
    if (maceThreat && !maceTotem && bot.inventory.slots[45]?.name !== 'totem_of_undying' && bot.heldItem?.name !== 'totem_of_undying') {
      const tt0 = findItem(bot, i => i.name === 'totem_of_undying')
      if (tt0) { maceTotem = true; bot.equip(tt0, 'hand').then(() => used('тотем в правую руку: булава сверху')).catch(() => { maceTotem = false }) }
    }
    if (!maceThreat && maceTotem) {
      maceTotem = false
      if (bot.heldItem?.name === 'totem_of_undying') await holdWeapon()
    }
    if (maceThreat) {
      if (pathing) { pathTo(false); pathing = false }
      aim = 'target'
      // Удар булавы с высоты — почти всегда ваншот (замер mace.js: с 6-10 блоков
      // 20 из 20 по алмазу). Щит успевает (5 тиков подъёма + тик) — щит к нему.
      // Не успевает, а до удара 12+ тиков — жемчуг из-под него (полёт жемчуга
      // ~8-10 тиков, стоит 5 хп). Иначе — развернуться и бежать спринтом: шаг
      // назад идёт шагом (спринт только вперёд), а он в полёте подруливает
      // (2026-09-26: «он же понимает, что это ваншот — значит, убегать или
      // телепортироваться заранее»).
      const shieldOk = !!(guard && guard.stats && guard.stats.worn) && (maceThreat.eta >= 6 || maceThreat.shielded)
      let how = null
      if (maceThreat.kind === 'above' || shieldOk) {
        how = mace.defend(bot, maceThreat, { guard, entity, vel: () => track.vel(), set, keyDir, stepSafe: dir => stepSafe(bot, dir), stats: mc.st })
      } else {
        const pearlOut = findItem(bot, i => i.name === 'ender_pearl')
        if (pearlOut && maceThreat.eta >= 12 && hp > 7 && ready('pearlFromMace')) {
          rest('pearlFromMace', 4000)
          aim = 'free'
          const foeAt = entity.position.clone()
          const pr = (await holdItem(pearlOut))
            ? await throwMod.throwAt(bot, null, {
              item: bot.heldItem,
              pick: throwMod.escapePick(bot, tp => Math.min(24, Math.hypot(tp.x - foeAt.x, tp.z - foeAt.z)), { minDist: 6, maxDrop: 4 })
            }).catch(() => null)
            : null
          aim = 'target'
          if (pr && pr.thrown) { how = 'жемчуг из-под булавы'; mc.st.dodges++ }
          const tt1 = findItem(bot, i => i.name === 'totem_of_undying')
          if (tt1 && bot.inventory.slots[45]?.name !== 'totem_of_undying') await bot.equip(tt1, 'hand').catch(() => {})
        }
        if (!how) {
          aim = 'away'
          const fwd = keyDir(bot, 'forward')
          if (stepSafe(bot, fwd)) {
            for (const x of ['back', 'left', 'right']) set(x, false)
            set('forward', true); set('sprint', (bot.food ?? 20) > 6); set('jump', false)
            how = 'бегу из-под булавы'
            if (!maceThreat.dodged) { maceThreat.dodged = true; mc.st.dodges++ }
          } else {
            aim = 'target'
            how = mace.defend(bot, maceThreat, { guard, entity, vel: () => track.vel(), set, keyDir, stepSafe: dir => stepSafe(bot, dir), stats: mc.st })
          }
        }
      }
      if (how && ready('maceDef:' + how)) { rest('maceDef:' + how, 2500); used(how) }
      if (how !== 'щит к булаве сверху' && maceThreat.kind === 'air' && now >= nextReady && r <= HIT_REACH && pick.canHit(bot, entity, { range: HIT_REACH })) {
        try { bot.attack(entity) } catch {}
        st.swings++
        mc.st.counterHits++
        lastSwing = gameClock.now()
        nextReady = lastSwing + cooldownMs(bot.heldItem)
        used('ударил его в полёте')
      }
      await sleep(TICK_MS)
      continue
    }
    // ---- Элитры (elytra.js, 2026-09-26): он на элитрах идёт пике на нас (с
    // булавой — свап на нагрудник и удар с падения; с мечом — крит пролётом,
    // Player.canCriticalAttack полёт не запрещает). Щит к нему, если успеет
    // встать (5 тиков — Items.SHIELD blockDelayTicks; держит, если его точка
    // в 90° по горизонтали), иначе — поперёк его пути спринтом; долетел до
    // руки — бить в воздухе (его рамка в полёте 0.6×0.6, pick.hitboxOf).
    const skyThreat = prof.player ? sky.threat() : null
    if (skyThreat) {
      if (pathing) { pathTo(false); pathing = false }
      aim = 'target'
      let how = null
      if (guard && guard.stats && guard.stats.worn && (skyThreat.eta >= 6 || skyThreat.shielded)) {
        guard.raise(true)
        if (!skyThreat.shielded) { skyThreat.shielded = true; sky.fl.st.shieldUps++ }
        for (const x of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(x, false)
        how = 'щит к пике с элитр'
      } else {
        const hv = sky.fl.vel()
        const hn = Math.hypot(hv.x, hv.z) || 1
        // Поперёк его пути: из сторон — та, что уводит дальше от его точки.
        let best = null
        for (const k of ['left', 'right', 'back', 'forward']) {
          const dir = keyDir(bot, k)
          if (!stepSafe(bot, dir)) continue
          const across = Math.abs((dir.x * hv.z - dir.z * hv.x) / hn)
          const q = me.offset(dir.x * 2, 0, dir.z * 2)
          const away = Math.hypot(q.x - skyThreat.at.x, q.z - skyThreat.at.z)
          const sc = across * 2 + away
          if (!best || sc > best.sc) best = { k, sc }
        }
        if (best) {
          for (const x of ['forward', 'back', 'left', 'right']) set(x, x === best.k)
          set('sprint', best.k === 'forward' && (bot.food ?? 20) > 6); set('jump', false)
          if (!skyThreat.dodged) { skyThreat.dodged = true; sky.fl.st.dodges++ }
          how = 'ушёл поперёк его пике'
        }
      }
      if (how && ready('skyDef:' + how)) { rest('skyDef:' + how, 2500); used(how) }
      if (how !== 'щит к пике с элитр' && now >= nextReady && r <= HIT_REACH && pick.canHit(bot, entity, { range: HIT_REACH })) {
        try { bot.attack(entity) } catch {}
        st.swings++
        sky.fl.st.counterHits++
        lastSwing = gameClock.now()
        nextReady = lastSwing + cooldownMs(bot.heldItem)
        used('ударил летуна в пролёте')
      }
      await sleep(TICK_MS)
      continue
    }
    // ---- Его взрывчатка у меня (boom.js, 2026-09-26): вагонетка с TNT в руке —
    // разобрать ударом (VehicleEntity: урон ×10 > 40 — меч с одного удара,
    // выпадает предметом, не взрывается); его кристалл ближе к нему, чем ко
    // мне, — ударить первым; иначе отойти, пока прогноз урона не станет
    // терпимым (формула ServerExplosion по нашей броне). Нет взрывчатки
    // рядом — ветка молчит.
    // Заметил — через реакцию (style.reactMs), как живой: вагонетку под ноги
    // ставят за два тика, и ответ в тот же тик был бы нечестным.
    const boomSeen = prof.player ? bm.threat() : null
    const boomThreat = after('boomSeen', !!boomSeen, style.reactMs) && ready('boomDef') ? boomSeen : null
    if (boomThreat) {
      rest('boomDef', 250)
      if (pathing) { pathTo(false); pathing = false }
      aim = 'free'
      let howB = null
      try { howB = await bm.defend(ctl, boomThreat, { stepSafe: dir => stepSafe(bot, dir) }) } catch {}
      aim = 'target'
      if (howB) {
        if (ready('boomNote:' + howB.slice(0, 20))) { rest('boomNote:' + howB.slice(0, 20), 2500); used(howB) }
        await holdWeapon()
        continue
      }
      // Взорвать ему нечем сейчас — не отвлекаться, бой дальше (через 0.5 с снова).
      rest('boomDef', 500)
    }
    // ---- Кристаллы Края (crystal.js, 2026-09-30): его кристалл у меня — сбить
    // (ему больнее или в своё окно неуязвимости) или отойти; мой — у его ног и
    // удар в тот же тик, заранее в его окно (удар, как окно кончится), готовый
    // у него — рукой или стрелой издалека, «поставил — отошёл — стрела»; он с
    // кристаллами рядом — обсидиан вокруг ног. Урон — формула ServerExplosion
    // обоим; себе больше, чем ему, и свой тотем — никогда. Решение — не чаще
    // раза в 60 мс; заметил его кристалл — через реакцию (style.reactMs).
    if (prof.player && blockName(bot, me.floored()) !== 'cobweb' && !perch && !fort && ready('crystal') && cx.engaged()) {
      rest('crystal', 60)
      const ca = cx.plan({ vel: track.vel(), press: pressing })
      const react = !ca || (ca.kind !== 'defuse' && ca.kind !== 'dodge') || after('crystalSeen', true, style.reactMs)
      if (!ca) delete noticed.crystalSeen
      if (ca && react) {
        if (guard) await guard.raise(false)
        if (pathing) { pathTo(false); pathing = false }
        clear()
        aim = 'free'
        const beforeC = heldName()
        let rc = null
        try { rc = await cx.run(ctl, ca, { stepSafe: dir => stepSafe(bot, dir), stop: () => FIX && maceNow() }) } catch (e) { rc = { note: 'кристаллы: ' + e.message } }
        aim = 'target'
        clear()
        switched(beforeC)
        if (rc && rc.note && ready('cxNote:' + ca.kind)) { rest('cxNote:' + ca.kind, 1500); used(rc.note) }
        if (!rc || !rc.keepItem) await holdWeapon()
        rest('crystal', (rc && rc.wait) || 150)
        if (/^(hit|shoot|place-hit|place-shoot)$/.test(ca.kind) && rc && rc.ok) noteExchange()
        continue
      }
    }
    // Броня лежит в рюкзаке, а на теле пусто — надеть в первое окно (он не на
    // ударе): защита 0 проигрывает любой размен.
    if (ready('dressMid') && theirR > HIT_REACH + 1 && bot.inventory.items().some(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name))) {
      rest('dressMid', 4000)
      const worn = [5, 6, 7, 8].filter(s => bot.inventory.slots[s]).length
      if (worn < 4) {
        try { const r = await require('./armor').equipBestArmor(session, ctl, { confirmMs: 300 }); if (r && r.equipped && r.equipped.length) used('надел броню в бою') } catch {}
      }
    }
    // Баффы в бою: окно — он в 5+ блоках, занят, или мы в коробке/на столбе.
    // Темп: окно — не «он в 5 блоках», а «он не успеет за глоток» (tempo.safe).
    // FIX: он сам пьёт или ест, а мы успеем наказать, — не пить (наказание
    // ниже, «Наказать занятого»); в нажиме — не пить; перезарядка бафа со
    // случаем (2.5–5 с), чтобы два бота не пили в такт.
    // Он пьёт, а наказать не успеть (далеко, за стенкой) — всё равно не пить
    // следом: сближаться, пока он медленный (прогон «после» 2026-09-26: «оба
    // пьют разом» росло — стенка перед глотком прятала его от наказания).
    if (prof.player && ready('rebuff') && !(FIX && (pressing || punishable() || (!fortSealed() && !!tt.state(entity).consuming))) && (tempo.ON ? tt.safe(tempo.consumeMs('potion'), { fortSealed: fortSealed() }).ok : (theirR > 5 || busyFoe || fort || perch))) {
      rest('rebuff', FIX ? 2500 + Math.random() * 2500 : 3000)
      const KIND = { strength: 'strength', speed: 'swiftness', regeneration: 'regeneration' }
      const lack = Object.entries(KIND).some(([e, k]) => !hasEffect(bot, e) &&
        findItem(bot, i => /potion$/.test(i.name) && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k))
      if (lack) await buffUp(fort || perch ? 0 : 4.5, fort ? [['turtle_master', 'resistance']] : [])
    }
    // Двое на одного: разворот на того, кто бьёт в спину, если текущая цель
    // сама нас не трогает, недостижима или тот, второй, ближе и достаётся рукой.
    // Не метаться: каждый разворот — смена цели, и если текущую достаём
    // рукой, разворот только сбивает заряд удара (арена 2026-09-25: вдвоём
    // по очереди били, бот крутился между ними и почти не махал).
    // 1 против 2 (duo.js, 2026-09-26): кого бить из двоих — слабого, занятого,
    // у края — сразу после своего удара (заряд пуст) или разворотом на второго,
    // когда он в руке, а заряд готов; оба на мне — рывок, пока не растянутся;
    // паутина под второго. Правило ниже — когда duo выключен (ND_DUO=0).
    if (prof.player && duo.active()) {
      const dz = duo.decide({ entity, charge: mf.clock.charge(0), justSwung: now - lastSwing < 250, hp, hasAxe: !!findItem(bot, i => /_axe$/.test(i.name)), meInWeb: blockName(bot, me.floored()) === 'cobweb', perch: !!perch, fort: !!fort, cooldownLeft: mf.clock.leftMs(1) })
      if (dz && dz.kind === 'focus' && dz.e !== entity) { duo.switched(entity, dz.e, dz.why); switchedAt = now; retarget(dz.e); await holdWeapon(); await new Promise(resolve => setImmediate(resolve)); continue }
      if (dz && dz.kind === 'reset') { if (pathing) { pathTo(false); pathing = false } clear(); const rr = await duo.runReset(ctl, dz); if (rr.pick && rr.pick !== entity) retarget(rr.pick); continue }
      if (dz && dz.kind === 'web' && (await duo.webSecond(dz.e))) continue
      // Всплеск в добиваемого (duo.burst, 2026-09-26): вред II броском или
      // булава с падения — чтобы урон не размазывался по двоим и доходил до
      // убийства.
      const bz = duo.burst({ hp, meInWeb: blockName(bot, me.floored()) === 'cobweb', perch: !!perch, fort: !!fort })
      if (bz) {
        if (bz.e !== entity) { duo.switched(entity, bz.e, bz.why); switchedAt = now; retarget(bz.e) }
        if (pathing) { pathTo(false); pathing = false }
        if (bz.kind === 'harm') {
          if (guard) await guard.raise(false)
          if (await throwAt(bz.item, '1 против 2: ' + bz.why, { minLand: 3.3 })) { await holdWeapon(); continue }
          duo.burstFailed('harm')
        } else if (bz.kind === 'smash') {
          if (guard) await guard.raise(false)
          clear()
          aim = 'free'
          const res = await mace.windSmash(bot, ctl, entity, {
            vel: () => track.vel(),
            stats: mc.st,
            stillOk: () => entity.isValid && Math.hypot(entity.position.x - bot.entity.position.x, entity.position.z - bot.entity.position.z) < 4.6 && !mace.shieldAtUs(bot, entity) && !duo.secondThreat()
          })
          aim = 'target'
          rest('smash', 5000)
          if (res.swung) { st.swings++; lastSwing = gameClock.now() }
          if (!res.aborted) used('1 против 2: ' + (res.hit ? 'булава в добиваемого — удар с падения' : res.launched ? 'булава в добиваемого — взлёт, не достал' : res.cancelled ? 'булава в добиваемого — передумал' : 'булава в добиваемого — не взлетел'))
          await holdWeapon()
          continue
        }
      }
    }
    if (prof.player && !duo.active() && now - switchedAt > 3000) {
      const o = otherAttacker()
      if (o) {
        const oR = reachFrom(eye, o.e)
        const targetIdle = now - lastHurtByTarget > 3000
        const oLow = (healthOf(bot, o.e) ?? 20) + 6 < (theirHp ?? 20)
        const curInReach = r <= HIT_REACH + 0.3 && !busyFoe
        if (!curInReach && ((oR <= HIT_REACH + 0.3 && (r > HIT_REACH || targetIdle || busyFoe || oLow)) || (busyFoe && o.dist < d + 4) || (targetIdle && r > HIT_REACH + 3))) {
          switchedAt = now
          used(`разворот на ${o.e.username} — бьёт в спину`)
          retarget(o.e)
          await holdWeapon()
          continue
        }
      }
    }
    // Стрелы на земле — свои промахи и его: сбегать в окно, пока он далеко
    // или занят (просьба 2026-09-25). Окно и нужду считает arrows.plan; бег
    // бросаем, едва он сократил до 5 блоков или нас ударили.
    // FIX: он пьёт или ест, и мы успеем наказать, или нажим — не за стрелами, а к нему.
    if (ready('arrowRun') && !fort && !perch && !(FIX && (pressing || punishable())) && bot.inventory.items().some(i => i.name === 'bow' || i.name === 'crossbow')) {
      rest('arrowRun', 600)
      const lying = arrows.plan(bot, { enemy: entity, busy: busyFoe, hp })
      if (lying) {
        // Погоня pathfinder'ом перебивает клавиши каждый тик: бот «бежал за
        // стрелой», а ехал к противнику (сцена try-arrows 2026-09-26).
        if (pathing) { pathTo(false); pathing = false }
        // И прицел: aimTimer каждый тик разворачивает голову к нему, а
        // «вперёд» идёт туда, куда смотрит голова. На бег — отпустить.
        aim = 'free'
        const run = await arrows.collect(bot, ctl, {
          target: lying,
          safe: dir => stepSafe(bot, dir),
          abortIf: () => (entity.isValid && entity.position.distanceTo(bot.entity.position) < 5) || (FIX && maceNow())
        }).finally(() => { aim = 'target' })
        if (run.got) used(`подобрал стрелы ×${run.got}`)
        else if (run.moved) used(`сбегал за стрелой — ${run.why === 'собрал' ? 'её уже нет' : run.why}`)
        if (run.moved) { await holdWeapon(); continue }
      }
    }
    if (now >= terrainAt) {
      terrainAt = now + 250
      myPit = hazards.pitTrap(bot, me)
      theirPit = dy < -1.5 ? hazards.pitTrap(bot, entity.position) : null
      nearFoe = hazards.hazardsNear(bot, entity.position, 3)
      nearMe = hazards.hazardsNear(bot, me, 2)
    }
    const inWeb = blockName(bot, entity.position.floored()) === 'cobweb' ||
      blockName(bot, entity.position.floored().offset(0, 1, 0)) === 'cobweb'
    const meInWeb = blockName(bot, me.floored()) === 'cobweb' || blockName(bot, me.floored().offset(0, 1, 0)) === 'cobweb'
    // Заряд — по тикам сервера (melee.js: удар и смена предмета видны по
    // пакетам, T = 20/attack_speed, тики — по возрасту мира): раньше было
    // «625 мс + 50 запаса» — терялось 1–2 тика на каждом замахе.
    const cooldownLeft = mf.clock.leftMs(1)

    // Злость проходит: человек не бьёт давно и стоит далеко.
    if (calmAfterMs && now - lastHurtByTarget > calmAfterMs && d > 8) {
      return finish({ calmed: true, why: `${label} не бьёт ${Math.round((now - lastHurtByTarget) / 1000)}с и отошёл` })
    }

    // Лава, поставленная под него, убирается сама через полторы секунды:
    // оставлять её в мире значит поджечь потом себя или чужой дом.
    for (let i = pendingLava.length - 1; i >= 0; i--) {
      if (now - pendingLava[i].at > 1500) {
        const cell = pendingLava.splice(i, 1)[0].cell
        await scoop(cell)
        await holdWeapon()
      }
    }
    // Вода, смывшая паутину с меня: стекла (0.3–0.5 с) — обратно в ведро, пока
    // рядом; горим — пусть ещё постоит (до 3 с). Источник в клетке головы или
    // над ней: scoop смотрит в неё (изнутри источника луч берёт его же).
    for (let i = pendingWater.length - 1; i >= 0; i--) {
      const pw = pendingWater[i]
      if (now - pw.at < 700 || (onFire(bot) && now - pw.at < 3000)) continue
      pendingWater.splice(i, 1)
      const wb = bot.blockAt(pw.cell)
      if (!wb || wb.name !== 'water' || wb.metadata !== 0) continue
      if (pw.cell.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)) > 4) continue
      await scoop(pw.cell)
      await holdWeapon()
    }

    // ---- 1. Экстренное.

    // В паутине: из неё не прыгнуть и не критануть (паутина каждый тик
    // обнуляет высоту падения), двигаешься вчетверо медленнее. Живой прогон
    // показал, что бот в ней просто стоял: вода в клетку с паутиной не
    // встаёт, а режущая ветка шла после водяной и до неё не доходило.
    // Теперь сначала режем — мечом или ножницами это ~0.4 с, — и каждую
    // клетку, где есть паутина, ноги и голову, по очереди. Проверяем по миру.
    // Но только когда он нас не достаёт. Живой прогон: бот резал паутину раз
    // за разом, пока второй стоял рядом и бил, — и умер, не ответив. Когда он в
    // досягаемости, из паутины бьём в ответ (без крита, но бьём), а режем, льём
    // и выползаем в окна, когда он отошёл: на перезарядку, за зельем, к луку.
    // Темп (арена 2026-09-25: бот в паутине перед обсидианом, враг вне руки —
    // «отвечал ударами» в пустоту и умер с пятью яблоками в рюкзаке): бить из
    // паутины — только когда он правда достаётся рукой и удар вот-вот заряжен;
    // иначе снять паутину — чем быстрее (замер 2026-09-26, webwater-probe.js):
    //  · мечом или ножницами — 8 тиков на клетку (твёрдость 4, скорость 15,
    //    делитель 30; tools.bestFor), и всё это время бот смотрит на паутину;
    //  · водой — взгляд вниз и ведро: вода встаёт в клетку головы (паутина у
    //    ног) или над головой (паутина и в голове: луч стартует внутри её
    //    контура, грань — против луча), стекает и ломает паутину через 300 /
    //    460 мс, а занят бот ~0.15 с — дальше снова бьёт;
    //  · рукой — никогда (400 тиков, 20 с). Горим — вода (и тушит). В аду вода
    //    испаряется — только меч. Раньше время резки считалось бесконечным
    //    (tools.bestFor не знал паутину) — рядом с ним бот не резал и не лил,
    //    а стоял и «отвечал ударами»: 812 раз за день арены против 348 снятий.
    // Под ударом режем по клетке за раз и рвём резку, если взлетела булава
    // (арена 2026-09-26: резал паутину, пока в него летели с булавой, и умер).
    const webCells = meInWeb ? [me.floored(), me.floored().offset(0, 1, 0)].filter(c => blockName(bot, c) === 'cobweb') : []
    if (meInWeb) { if (!st.webSince) st.webSince = now } else st.webSince = 0
    let webPlan = null
    if (webCells.length) {
      const f = me.floored()
      const headWeb = webCells.some(c => c.y === f.y + 1)
      const wCell = headWeb ? f.offset(0, 2, 0) : f.offset(0, 1, 0)
      const wItem = findItem(bot, i => i.name === 'water_bucket')
      const nether = /nether/.test(String((bot.game && bot.game.dimension) || ''))
      const opts = []
      if (wItem && !nether && /^(air|cave_air)$/.test(blockName(bot, wCell) || '')) {
        opts.push({ how: 'water', item: wItem, cell: wCell, busyMs: 150, freeMs: 150 + (headWeb ? 460 : 300) })
      }
      const cutOne = tools.bestFor(bot, bot.blockAt(webCells[0])).ms
      const cutAll = webCells.reduce((s, c) => s + tools.bestFor(bot, bot.blockAt(c)).ms, 0)
      // Меч в воздухе внутри паутины — ×5 дольше (2 с на клетку: игра делит
      // скорость копки на 5 без опоры под ногами), и всё равно лучше, чем ждать.
      if (cutOne <= 2500) opts.push({ how: 'cut', busyMs: cutOne, freeMs: cutAll })
      // В досягаемости важнее, сколько бот занят; вне — когда свободен.
      const inReach = r <= HIT_REACH + 0.5
      const score = o => o.freeMs + (inReach ? o.busyMs : 0)
      webPlan = (onFire(bot) && opts.find(o => o.how === 'water')) || opts.sort((a, b) => score(a) - score(b) || (a.how === 'cut' ? -1 : 1))[0] || null
    }
    // Когда снимать: он не достаёт; или мой удар ещё заряжается дольше, чем
    // займёт шаг; или сижу в паутине дольше 1.5 с (удар не проходит — всё
    // равно снимать).
    // Голова в паутине — прицел упирается в неё саму (VoxelShape.clip: глаза
    // внутри контура), и удара нет вовсе: снимать сразу (pick.js).
    const webSafe = !!webPlan && (r > HIT_REACH || !inSight || cooldownLeft >= webPlan.busyMs || now - st.webSince > 1500)
    if (meInWeb && ready('webFight')) {
      if (!webPlan) { rest('webFight', 3000); used('в паутине — снять нечем (ни меча, ни ножниц, ни воды)') } else if (!webSafe) { rest('webFight', 3000); used('в паутине — сперва удар, сниму в перезарядке') }
    }
    if (webPlan && webSafe && !(prof.player && mc.threat()) && ready('cutweb')) {
      rest('cutweb', 250)
      if (webPlan.how === 'water') {
        if (await holdItem(webPlan.item)) {
          aim = 'point'
          aimPoint = { yaw: bot.entity.yaw, pitch: -Math.PI / 2 }
          await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {})
          await sleep(TICK_MS)
          try { bot.activateItem() } catch {}
          await sleep(TICK_MS)
          aim = 'target'
          pendingWater.push({ cell: webPlan.cell, at: gameClock.now() })
          used(onFire(bot) ? 'вода на себя: потушился и смыл паутину' : `вода: смыл паутину (${webCells.length} кл.)`)
        }
        await holdWeapon()
        continue
      }
      // Меч или ножницы — по клетке за шаг, между шагами снова бой.
      aim = 'free'
      const stop = await digWatch(bot.blockAt(webCells[0]), () => (prof.player && mc.threat()) ? 'булава летит' : null)
      aim = 'target'
      if (stop) used(`бросил резать паутину: ${stop}`)
      else if (blockName(bot, webCells[0]) !== 'cobweb') { used(`разрезал паутину (${heldName()})`); st.cutFails = 0 } else if (++st.cutFails >= 2) {
        // Не режется (он ставит новую, сервер не даёт) — не долбить её
        // бесконечно: три секунды на бой и на воду.
        rest('cutweb', 3000)
        st.cutFails = 0
      }
      await holdWeapon()
      continue
    }
    // Он в руке, но прицел упирается в паутину между нами или у его головы
    // (pick.js: контур паутины — полный куб, удар сквозь неё клиент не даёт).
    // Срезать ту, что мешает: ноги его остаются в паутине, а грудь открыта.
    if (!meInWeb && r <= HIT_REACH && !inSight && sight && sight.blocked && sight.blocked.block &&
        sight.blocked.block.name === 'cobweb' && !(prof.player && mc.threat()) && ready('cutHisWeb')) {
      const cut = tools.bestFor(bot, sight.blocked.block)
      if (cut.ms <= 1200) {
        rest('cutHisWeb', 400)
        aim = 'free'
        const stop = await digWatch(sight.blocked.block, () => (prof.player && mc.threat()) ? 'булава летит' : null)
        aim = 'target'
        if (stop) used(`бросил резать его паутину: ${stop}`)
        else if (blockName(bot, sight.blocked.pos) !== 'cobweb') used('срезал паутину, что закрывала его')
        await holdWeapon()
        continue
      }
      rest('cutHisWeb', 2000)
    }
    // Горим (не в паутине — там выше) — вода под ноги и сразу обратно.
    const water = findItem(bot, i => i.name === 'water_bucket')
    if (water && onFire(bot) && !meInWeb && ready('water') && !bot.entity.isInWater) {
      rest('water', 3000)
      const cell = me.floored()
      await useOnGroundAt(water, cell, 'вода: потушился')
      await sleep(250)
      await scoop(cell)
      await holdWeapon()
      continue
    }
    // Стоим в огне или лаве (он поджёг клетку или вылил лаву под ноги) — вон
    // из клетки сразу, в соседнюю безопасную: каждый тик в огне снова поджигает,
    // лава — 4 хп за полсекунды. Ведро — выше, оно быстрее; это когда ведра нет.
    const feetName = blockName(bot, me.floored())
    if (/^(lava|fire|soul_fire)$/.test(feetName) && ready('outOfFire')) {
      rest('outOfFire', 600)
      const cell = me.floored()
      let best = null
      for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const c = cell.offset(x, 0, z)
        const n = blockName(bot, c)
        const head = blockName(bot, c.offset(0, 1, 0))
        if (!(n === 'air' || n === 'cave_air') || !(head === 'air' || head === 'cave_air')) continue
        if (!solid(bot, c.offset(0, -1, 0)) || /lava|fire|magma/.test(blockName(bot, c.offset(0, -1, 0)) || '')) continue
        // Подальше от него: не выпрыгивать ему под меч.
        const away = Math.hypot(c.x + 0.5 - entity.position.x, c.z + 0.5 - entity.position.z)
        if (!best || away > best.away) best = { c, away }
      }
      if (best) {
        aim = 'free'
        await bot.lookAt(best.c.offset(0.5, 1, 0.5), true).catch(() => {})
        clear()
        set('forward', true); set('jump', true); set('sprint', true)
        const t0 = gameClock.now()
        while (gameClock.now() - t0 < 500 && /^(lava|fire|soul_fire)$/.test(blockName(bot, bot.entity.position.floored())) && !ctl.aborted) await sleep(TICK_MS)
        clear()
        aim = 'target'
        used(feetName === 'lava' ? 'выпрыгнул из лавы' : 'вышел из огня')
        continue
      }
    }
    // Горим, а ведра нет — в воду рядом, если есть (огонь от лавы горит 15 с
    // по 1 хп, вода гасит сразу).
    if (onFire(bot) && !bot.entity.isInWater && !hasEffect(bot, 'fire_resistance') && ready('toWater')) {
      rest('toWater', 2500)
      const waterId = bot.registry.blocksByName.water && bot.registry.blocksByName.water.id
      // Вода в 10 блоках (было 6), ближайшая по пути: прямо — если до неё
      // рукой подать и шаги безопасны, иначе pathfinder'ом в обход (2026-09-26:
      // «когда горит — учитывает ли воду рядом? забежать, если ведра нет»).
      const pools = waterId !== undefined ? bot.findBlocks({ matching: waterId, maxDistance: 10, count: 12 }) : []
      const here = bot.entity.position
      const pool = pools.map(v => bot.blockAt(v)).filter(b => b && Math.abs(b.position.y - here.y) <= 3)
        .sort((x, y) => x.position.distanceTo(here) - y.position.distanceTo(here))[0] || null
      if (pool) {
        aim = 'free'
        const near = pool.position.offset(0.5, 0, 0.5).distanceTo(here) <= 4.5
        const t0 = gameClock.now()
        if (near) {
          await bot.lookAt(pool.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
          set('forward', true); set('sprint', true); set('back', false); set('left', false); set('right', false)
          while (gameClock.now() - t0 < 1800 && !bot.entity.isInWater && !ctl.aborted) {
            set('jump', wantsJump(bot, keyDir(bot, 'forward')))
            await sleep(TICK_MS)
          }
          clear()
        } else {
          pathTo(true, new goals.GoalBlock(pool.position.x, pool.position.y, pool.position.z)); pathing = true
          while (gameClock.now() - t0 < 3500 && !bot.entity.isInWater && !ctl.aborted) await sleep(TICK_MS)
          pathTo(false); pathing = false
          clear()
        }
        aim = 'target'
        if (bot.entity.isInWater) used(near ? 'потушился в воде' : 'добежал до воды — потушился')
        continue
      }
    }
    // Ни резать, ни лить (нечем или ждём окна): хотя бы выползать — стоять в
    // паутине значит подставляться, а шаг наружу медленный, но он есть.
    if (meInWeb && (!webPlan || webSafe)) {
      clear()
      const out = ['back', 'left', 'right'].find(k => stepSafe(bot, keyDir(bot, k)))
      if (out) set(out, true)
    }

    // Тотем в левую руку (totem.js, 2026-09-26). Сработал — новый встаёт сам
    // по событию 35, в тот же тик. Здесь — заранее, когда его удар может убить
    // (два его крита после брони до смерти, булава сверху, взрывчатка рядом),
    // и щит обратно, когда угроза ушла: щит гасит удар целиком спереди, тотем
    // спасает один раз — держать тот, что нужнее сейчас.
    if (now >= totemAt) {
      totemAt = now + 250
      const offIt = bot.inventory.slots[45]
      const offN = offIt ? offIt.name : null
      const mt = prof.player ? mc.threat() : null
      const wt = totemMod.wantTotem(bot, { entity, maceThreat: mt && mt.mace ? mt : null, theirR })
      if (wt.yes && offN !== 'totem_of_undying' && now - tot.lastSwitch > 400 && findItem(bot, i => i.name === 'totem_of_undying')) {
        if (tot.equip('заранее: ' + wt.why)) { tot.preempt++; used('тотем в левую руку: ' + wt.why) }
      } else if (!wt.yes && offN === 'totem_of_undying' && guard && guard.stats && guard.stats.have && now - tot.lastSwitch > 5000 &&
          now - tot.lastPop > 5000 && wt.hp >= 2 * wt.burst + 8 && !bot.currentWindow) {
        const sh = findItem(bot, i => i.name === 'shield')
        if (sh) { tot.lastSwitch = now; tot.shieldBack++; bot.equip(sh, 'off-hand').then(() => used('щит обратно в левую руку')).catch(() => {}) }
      }
    }

    // ---- Элитры (elytra.js, 2026-09-26): уход лечиться в воздух — хп на
    // исходе, а на земле он успеет за глоток (tempo.safe): взлёт прочь, яблоко
    // или питьё в воздухе, где рука не достаёт, посадка вдали (замер
    // elytra-probe3: 3 из 3 — 8→20 хп за 6–7 с, 2–3 фейерверка). И пике с
    // булавой сверху: булава, нагрудник, фейерверки, он на земле под открытым
    // небом (6 из 6 по стоящему в алмазе — насмерть, себе 0). Только с
    // элитрами и фейерверками в рюкзаке — без них ветка молчит.
    if (prof.player && ready('sky') && !meInWeb && !perch && !fort && bot.entity.onGround) {
      const airHeal = () => findItem(bot, i => i.name === 'enchanted_golden_apple') || findItem(bot, i => i.name === 'golden_apple') ||
        findPotion(bot, 'potion', 'heal') || findPotion(bot, 'potion', 'regen')
      const eatSafe = tempo.ON ? tt.safe(tempo.consumeMs('golden_apple')).ok : theirR > 6
      const eqS = entity.equipment || []
      const hisShield = (!!(eqS[1] && eqS[1].name === 'shield') || !!(eqS[0] && eqS[0].name === 'shield')) && !(foe.shieldOff(entity) > 1500)
      const sp = sky.decide({ hp, healAt, heal: !!airHeal(), eatSafe, d, dy, foeGrounded: foeGrounded(), hisShield })
      if (sp) {
        rest('sky', 2000)
        pathTo(false); pathing = false
        clear()
        if (guard) await guard.raise(false)
        aim = 'free'
        let res = null
        try { res = await sky.run(ctl, sp, { heal: airHeal, enough: () => (bot.health ?? 0) >= 16, vel: () => track.vel() }) } catch (e) { res = { note: 'элитры: ' + e.message } }
        aim = 'target'
        clear()
        if (res && res.note) used(res.note)
        if (res && res.hit) { st.swings++; lastSwing = gameClock.now() }
        if (res && res.ate) for (const a of res.ate) st.healed.push(a + ' (в воздухе)')
        nextReady = Math.max(nextReady, gameClock.now() + cooldownMs(bot.heldItem))
        await holdWeapon()
        if (guard) await guard.wear()
        continue
      }
    }
    // Лечение. Взрывное лечения — мгновенно, под ноги. Яблоко и питьё — 1.6 с,
    // поэтому сначала отойти, если он рядом.
    // Против лучника — раньше: полная стрела через железо снимает до шести, и
    // есть яблоко (1.6 с) на 10 хп значит не доесть (прогон: оба лучника
    // умерли с двумя яблоками в рюкзаке).
    const archer = theyBow || prof.ranged
    // Он занят (ест за стенкой, сидит на столбе) и далеко — лучшее время
    // отлечиться самому: бить его сейчас некуда, а он вернётся полным.
    const calmHeal = busyFoe && d > 3.5 && hp < 16 && !!healItem()
    // Крепость вместо еды на открытом месте: его рука (или толпа мобов) рядом
    // и лечиться под ударами не выйдет. Против лучника коробка с крышей — тоже
    // укрытие. Строится ~2 с, поэтому — пока он не вплотную.
    // Против мобов — когда их толпа или совсем плохо: одному зомби коробка ни к чему.
    const mobCrowd = !prof.player && (flee.hostilesAround(bot, 8).length >= 2 || hp <= 8)
    // Темп: лечиться надо, а на открытом месте он успеет добежать за глоток —
    // коробка и издалека (в ней глоток безопасен).
    const needSafeEat = tempo.ON && prof.player && hp <= healAt && !!healItem() && !tt.safe(tempo.consumeMs('golden_apple')).ok
    // Кристаллы (2026-09-30): коробку с крышей из обсидиана кристалл не берёт, а
    // кирки в наборе нет — бой встал бы до «застоя». Против кристаллов —
    // обсидиан вокруг ног (crystal.js), не коробка.
    if (!fort && ready('fort') && hp <= style.fortAt && !busyFoe && !meInWeb && !perch && !cx.dominant() &&
        (prof.player ? (theirR < 7 || archer || needSafeEat) && theirR > 2.2 : mobCrowd) && fortPossible()) {
      rest('fort', 15000)
      if (await fortOut()) continue
    }
    if ((hp <= healAt + (archer ? 3 : 0) || calmHeal) && ready('heal')) {
      if (calmHeal && hp > healAt + (archer ? 3 : 0) && ready('calmNote')) { rest('calmNote', 5000); used('лечусь, пока он занят') }
      const splash = findPotion(bot, 'splash_potion', 'heal')
      if (splash && (await holdItem(splash))) {
        rest('heal', 800)
        await useAt(bot.entity.yaw, -Math.PI / 2)
        used('лечение под ноги'); st.healed.push('взрывное лечения')
        await holdWeapon()
        continue
      }
      const absorbing = hasEffect(bot, 'absorption')
      // Темп: прижат (в паутине, он достаёт, а резать не успеваю; или загнан в
      // угол) и хп на исходе — самое сильное, что есть, даже под ударами:
      // зачарованное яблоко (поглощение IV + сопротивление, Consumables),
      // черепашье зелье (сопротивление III, Potions.TURTLE_MASTER), яблоко.
      const desperate = tempo.ON && prof.player && hp <= 6 && ((meInWeb && !webSafe) || gameClock.now() - (st.corneredAt || 0) < 3000)
      const turtle = desperate ? findItem(bot, i => i.name === 'potion' && /turtle_master$/.test(potionOf(i) || '')) : null
      const gapple = findItem(bot, i => i.name === 'enchanted_golden_apple') ||
        (!absorbing && findItem(bot, i => i.name === 'golden_apple'))
      const potion = findPotion(bot, 'potion', 'heal') || findPotion(bot, 'potion', 'regen')
      const food = !gapple && !potion && (bot.food ?? 20) < 18 &&
        findItem(bot, i => /cooked_|bread|baked_potato|golden_carrot/.test(i.name))
      // FIX: он сам ест или пьёт, мы успеем наказать, а хп не на исходе — окно
      // дороже своего глотка (наказание ниже, «Наказать занятого»).
      const punFirst = FIX && !desperate && hp > 8 && !!punishable()
      if (punFirst) { st.eatPunish.skips = (st.eatPunish.skips || 0) + 1; if (ready('punFirstNote')) { rest('punFirstNote', 3000); used('не ем — он сам ест или пьёт, наказываю') } }
      const pick = punFirst ? null : (desperate && (findItem(bot, i => i.name === 'enchanted_golden_apple') || turtle)) || gapple || potion || food
      if (pick) {
        rest('heal', 2500)
        // Под паутину его, если есть: ест тот, кого не могут догнать. Нет
        // паутины — стенка из блоков между нами (так закрываются в PvP).
        const web = findItem(bot, i => i.name === 'cobweb')
        let walled = 0
        if (web && theirR < 4.5 && !archer && ready('web')) { rest('web', 5000); await placeUnder(web, 'паутина перед едой') }
        // FIX: он видит нас ближе 24 бл. — стенка тоже; но под его рукой (глоток
        // всё равно не начнём — tempo.safe ниже) блоки не тратить, кроме лучника
        // (стенка и делает глоток безопасным) и «прижат».
        else if ((theirR < 5 || archer || (FIX && seesBody && d < 24)) && !theyUp && ready('wall') && (!FIX || desperate || tt.safe(tempo.consumeMs(pick.name) + (archer ? COVER_WIDE_MS : COVER_MS)).ok)) {
          rest('wall', 3000)
          walled = await coverFrom(entity.position, archer
            ? { wide: true, what: 'стенка 3×2 от лучника перед едой' }
            : { what: 'колонка перед едой' })
        }
        // Темп (2026-09-25: «ешь, если более-менее безопасно, а не когда тебя
        // забивают»): есть — только если он не успеет добежать или дострелить
        // за глоток (tempo.safe). Нет — не жевать под мечом, а оторваться
        // бегом (он в паутине — тем быстрее), и есть, когда оторвался; догнал
        // или бежать некуда — драться.
        if (tempo.ON && prof.player && !desperate && !tt.safe(tempo.consumeMs(pick.name)).ok) {
          tt.stats.refused++
          if (ready('refuseNote')) { rest('refuseNote', 3000); used('не ем под ударами — отрываюсь') }
          let how = 'в паутине'
          // FIX: нажим (долго без размена) и хп не на исходе — не бегать, драться.
          if (FIX && pressing && hp > 8) how = 'нажим'
          else if (!meInWeb) {
            pathTo(false); pathing = false
            clear()
            aim = 'free'
            how = await tempo.kite(bot, ctl, tt.threats, {
              ms: 1800,
              until: () => tt.safe(tempo.consumeMs(pick.name)).ok,
              stop: () => entity.isValid && reachFrom(entity.position.offset(0, EYE, 0), bot.entity) <= tempo.PLAYER_REACH
            })
            aim = 'target'
            tt.stats.kites++
            // Бежать некуда или он догнал (скорость та же или больше) — прижат.
            if (how === 'некуда' || how === 'догнал') st.corneredAt = gameClock.now()
          }
          // Не оторвался — не бегать по кругу: два пустых отрыва подряд —
          // пауза в лечении на 6 с, драться (или коробка, жемчуг — ниже и выше).
          if (how !== 'оторвался') {
            st.kiteFails = (st.kiteFails || 0) + 1
            // Догнал на последних хп — сразу снова в лечение: это уже «прижат».
            rest('heal', how === 'догнал' && hp <= 6 ? 0 : st.kiteFails >= 2 ? 6000 : 1500)
            if (st.kiteFails >= 2) st.kiteFails = 0
            await holdWeapon()
            continue
          }
          st.kiteFails = 0
        }
        if (desperate && ready('desperateNote')) { rest('desperateNote', 4000); used('прижат на ' + Math.round(hp) + ' хп — ем под ударами ' + pick.name) }
        pathTo(false); pathing = false
        clear()
        // За стенкой от лучника — стоять: шаг вбок выводит из-под неё (прогон:
        // бот ставил блоки и тут же выходил под стрелы). От ближника — пятиться.
        if (!(archer && walled)) {
          set('back', stepSafe(bot, keyDir(bot, 'back')))
          set(strafeKey, stepSafe(bot, keyDir(bot, strafeKey)))
        }
        if (pick.name === 'potion') await drink(pick, 'выпил ' + (potionOf(pick) || 'зелье'), null, { desperate })
        else if (await holdItem(pick)) {
          // Съел — это «стало на одно меньше», а не «вызов вернулся»: в
          // прогоне бот «съел» семь яблок из двух.
          if (await eatHeld(pick.name, null, { desperate })) { used('съел ' + pick.name); st.healed.push(pick.name) }
        }
        clear()
        await holdWeapon()
        continue
      }
    }

    // Отступление. Против человека бегство по прямой бесполезно — он так же
    // быстр, — поэтому отход только если есть чем оторваться: жемчуг. Жемчуг
    // сам стоит 5 хп при приземлении (minecraft.wiki «Ender Pearl»), поэтому
    // уходить им надо заранее, пока эти 5 хп есть: на 3 хп бросок — это
    // самоубийство. Лечиться нечем — вот тогда и пора.
    const canHeal = !!(findPotion(bot, 'splash_potion', 'heal') || findPotion(bot, 'potion', 'heal') ||
      findItem(bot, i => /golden_apple$/.test(i.name)))
    // Против моба у отхода есть своя доктрина (combat.retreat: штрек, стена,
    // столб, побег с оглядкой) — отдаём ей.
    if (!prof.player && hp <= retreatAtHealth && !canHeal) {
      return finish({ lowHealth: true, health: Math.round(hp) })
    }
    // Хорус и «Тягун» (utility.js, 2026-09-26): случайный прыжок ±8 сквозь стены
    // за 0 хп — когда жемчуг хуже (заперт, хп ≤ 6 — жемчуг сам снимет 5, уходить
    // нечем); за край не ведёт ли — прогоном тех же 16 попыток, что у сервера.
    // Под дождём или в воде — рывок трезубцем прочь от двоих.
    if (prof.player && ready('chorusEsc') && hp <= Math.max(retreatAtHealth, 9)) {
      rest('chorusEsc', 1500)
      aim = 'free'
      const cr = (await util.chorusMaybe(ctl, { hp, foes: duo.foes(), trapped: meInWeb && !webSafe ? 'паутина' : myPit ? 'яма' : null, pearls: countOf(bot, 'ender_pearl'), canHeal, pearlAt: Math.max(retreatAtHealth, 9), burst: totemMod.burstOf(bot, entity) })) ||
        (hp <= 6 && duo.foes().length >= 2 ? await util.riptideAway(duo.foes()) : null)
      aim = 'target'
      if (cr && cr.ok) { await holdWeapon(); continue }
    }
    const pearlAt = Math.max(retreatAtHealth, 9)
    // Темп: лечиться есть чем, но под ним не поесть — жемчуг тоже, за место для еды.
    // FIX: не больше двух за бой — каждый жемчуг уводит бой в погоню и тишину
    // (прогон «после» 2026-09-26: 30 «жемчуг: оторвался» на 10 раундов против 16).
    const pearlForSpace = tempo.ON && prof.player && canHeal && !tt.safe(tempo.consumeMs('golden_apple')).ok && !(FIX && (st.pearlSpace || 0) >= 2)
    if (prof.player && hp <= pearlAt && hp > 6 && (!canHeal || pearlForSpace)) {
      const pearl = findItem(bot, i => i.name === 'ender_pearl')
      if (pearl && ready('pearl')) {
        // Куда — не «прочь под 25°», а по честной точке переноса (throw.js
        // escapePick): не в лаву, не в пустоту, не в стену арены, как можно
        // дальше от него, а бросок на бегу учтён так же, как у лука.
        const r = await escapePearl()
        if (r && r.thrown) {
          // Жемчуг за место для еды (темп) — лечиться здесь же: ветка лечения
          // сверху проверит, успеет ли он добежать.
          if (pearlForSpace) { st.pearlSpace = (st.pearlSpace || 0) + 1; rest('heal', 0); await holdWeapon(); continue }
          // Оторвался — есть из чего столб: не бросать бой, а уйти наверх, пока
          // он бежит сюда (ниже). Не из чего — отдать решение мозгу, как раньше:
          // в прогоне бот после жемчуга просто стоял, и его добили.
          const f = pickFiller(bot)
          if (!f || countOf(bot, f.name) < perchHeight()) {
            return finish({ retreated: true, mode: 'ушёл жемчугом', health: Math.round(bot.health ?? 0) })
          }
          await holdWeapon()
          continue
        }
      }
      // Жемчуга нет: драться до конца, но только наверняка — критами.
    }

    // Лечиться нечем, а он далеко (после жемчуга или отстал) — на столб.
    // Строится ~0.6 с на блок: подбежать и ударить по ногам, пока растёт, он
    // не должен успеть — отсюда запас по дистанции.
    if (prof.player && !perch && hp <= pearlAt && !canHeal && d > 12 && !theyBow && ready('pillar')) {
      rest('pillar', 6000)
      if (await pillarOut()) continue
    }
    if (perch) {
      // Стрелы кончились (или лука нет) — сидеть на столбе незачем: вниз,
      // драться рукой, пока хп позволяет (арена 2026-09-25: бот стоял на
      // столбе без стрел и ничего не делал).
      const noArrows = !findItem(bot, i => /arrow$/.test(i.name)) || !findItem(bot, i => i.name === 'bow' || i.name === 'crossbow')
      // Но не на последних хп: сперва отлечиться наверху (регенерация, еда,
      // яблоко), спускаться — когда после прыжка останется 14+.
      if (noArrows && bot.entity.position.y >= perch.top - 1.2 && hp - Math.max(0, perch.h - 3) >= 14 && ready('perchNoArrows')) {
        rest('perchNoArrows', 5000)
        used('стрелы кончились — спрыгиваю со столба')
        await dropFromPerch()
        continue
      }
      if (bot.entity.position.y < perch.top - 1.2) {
        perch = null
        used('сбили со столба')
      } else if (hp - Math.max(0, perch.h - 3) >= 14 || (now - perch.since > 45000 && hp - Math.max(0, perch.h - 3) >= 6)) {
        await dropFromPerch()
        continue
      }
    }

    // ---- 2. Снаряды.
    const inc = threats.incoming(bot).filter(p => p.ticks <= 12)
    // На столбе по нам стреляют: пританцовывать крадучись (присед не даёт
    // сойти с края) влево-вправо — стоящая мишень ловит каждую стрелу.
    if (perch && bot.entity.position.y >= perch.top - 1.2 && (theyBow || inc.some(x => /arrow|trident/.test(x.name)))) {
      if (now >= strafeFlipAt) { strafeKey = strafeKey === 'left' ? 'right' : 'left'; strafeFlipAt = now + 150 + Math.random() * 250 }
      set('sneak', true)
      set('left', strafeKey === 'left'); set('right', strafeKey === 'right')
      if (ready('perchDanceNote')) { rest('perchDanceNote', 4000); used('пританцовываю на столбе от стрел') }
    } else if (perch) set('sneak', false)

    // Фаербол гаста отбивается ударом: шар летит туда, куда смотрит ударивший
    // (minecraft.wiki «Fireball»). Смотрим на гаста — и шар возвращается к
    // нему; прямое попадание гаста убивает. Бить можно в любой перезарядке.
    // Любой шар в досягаемости руки — не только тот, что летит точно в нас:
    // взрыв задевает и мимо (волна гастов 2026-09-25: ни одного отбития).
    const ball = inc.find(p => p.name === 'fireball' && reachFrom(eye, p.entity) <= 3.2) ||
      (() => {
        const f = Object.values(bot.entities).find(e => e && e.name === 'fireball' && e.position && reachFrom(eye, e) <= 3.2)
        return f ? { entity: f, name: 'fireball' } : null
      })()
    if (ball && ready('deflect')) {
      rest('deflect', 150)
      const ghast = entity.name === 'ghast' ? entity
        : bot.nearestEntity(e => e && e.name === 'ghast' && e.position && e.position.distanceTo(me) < 64)
      aim = 'free'
      try {
        // Шар полетит туда, куда сервер считает наш взгляд, — а поворот
        // уходит пакетом движения на следующем тике физики. Ударили в тот же
        // миг — сервер отбил по старому взгляду, в стену (живой прогон).
        // Поворот, тик ожидания, удар. Целимся в центр гаста с упреждением.
        const aimAt = ghast
          ? ghast.position.offset(0, 2, 0).plus((ghast.velocity || new Vec3(0, 0, 0)).scaled(10))
          : ball.entity.position.plus(ball.entity.position.minus(eye))
        await bot.lookAt(aimAt, true)
        await sleep(60)
        if (ball.entity.isValid !== false) {
          bot.attack(ball.entity)
          used('отбил фаербол')
        }
      } catch {}
      aim = 'target'
      await sleep(TICK_MS)
      continue
    }

    // По нам стреляют, а здоровья мало — стенка из двух блоков навстречу
    // стреле: блок ставится за четверть секунды, а уклон спасает не всегда.
    const arrowIn = inc.find(p => /arrow|trident/.test(p.name) && p.ticks >= 4)
    if (arrowIn && hp <= healAt + 2 && ready('wall') && pickFiller(bot)) {
      rest('wall', 2500)
      const from = me.minus(new Vec3(arrowIn.vel.x, 0, arrowIn.vel.z).normalize().scaled(4))
      if (await coverFrom(from, { wide: true, what: 'стенка от стрел' })) { await holdWeapon(); continue }
    }

    // Выстрел по нам: рвануть в другую сторону от той, куда шли, — он
    // упреждал по нашему ходу.
    if (sawRelease()) {
      const flip = strafeKey === 'left' ? 'right' : 'left'
      const key = stepSafe(bot, keyDir(bot, flip)) ? flip : (stepSafe(bot, keyDir(bot, strafeKey)) ? strafeKey : null)
      if (key) {
        dodgeKey = key
        strafeKey = key
        dodgeUntil = now + 450
        strafeFlipAt = now + 450 + Math.random() * 500
        st.dodges++
        used('ушёл с линии выстрела')
      }
    }
    // Стрелы и прочее — сойти с линии.
    if (inc.length && now > dodgeUntil) {
      const key = threats.dodgeKey(bot, inc[0], k => stepSafe(bot, keyDir(bot, k)))
      if (key) {
        dodgeKey = key
        dodgeUntil = now + 350
        st.dodges++
      }
    }
    // Его заряженный арбалет смотрит на нас (read.js, 2026-09-26): выстрел —
    // одним «использовать», стрела 3.15 бл/тик долетает за 2–4 тика, после спуска
    // не уйти. Щит на руке и не «Пронзание» — щит (ниже, у щита от лука); иначе
    // не стоять на линии: рывки стрейфом в случайную сторону, пока он целится.
    const aimedCb = prof.player && seesBody ? foe.aimedAtMe(entity) : null
    // Щит — ближе FAR (7): стрела оттуда летит 1–2 тика, уйти вбок не успеть.
    // Дальше — пробег вбок (погоня ниже больше не глушит его pathfinder'ом,
    // стойка showman под прицелом отпускает тело). Замер try-xbow hisxbow с
    // 9 бл., 2026-09-26: щит и там — 6 из 8 (щит гасит лишь через 5 тиков после
    // подъёма, LivingEntity.getItemBlockingWith, Items.SHIELD BlocksAttacks(0.25 с…),
    // а с ним ход ×0.2); пробег — 6 из 6 («Пронзание», где щит бесполезен).
    // Держать щит, пока прицел на нас, и ещё 400 мс после (он ведёт прицел
    // заново) — если его арбалет всё ещё заряжен; выстрелил — щит вниз, его
    // перезарядка — наше окно.
    const cbNow = !!(aimedCb && !aimedCb.piercing && guard && guard.stats && guard.stats.worn && r > HIT_REACH && d <= FAR)
    if (cbNow) cbShieldUntil = now + 400
    const hisCb = prof.player ? (read.crossbowInfo(bot, entity.equipment && entity.equipment[0]) || read.crossbowInfo(bot, entity.equipment && entity.equipment[1])) : null
    const cbShield = cbNow || (now < cbShieldUntil && !!(hisCb && hisCb.loaded && !hisCb.piercing) && r > HIT_REACH && !!(guard && guard.stats && guard.stats.worn))
    // Пробеги, а не дёрганье (2026-09-26, try-xbow hisxbow: помог 1 уклон из
    // 4): смена стороны каждые 200–450 мс держала бота почти на месте — скорость
    // вбок набирается 3–4 тика (земля: v·0.546 + 0.098 за тик, предел 0.216
    // бл/тик), разворот — 2 тика почти без хода. Стрела арбалета (3.15 бл/тик)
    // с 9 бл. летит 3 тика: при ходе вбок 0.2 бл/тик прицел «в нас сейчас»
    // промахивается на 0.6–0.8 (рамка 0.3 + стрела 0.25). Пробег 550–1000 мс,
    // разворот в половине случаев — чтобы и упреждение его не спасало: ему
    // придётся доводить прицел заново.
    if (aimedCb && !cbShield && now > dodgeUntil) {
      const flip = Math.random() < 0.5 ? (strafeKey === 'left' ? 'right' : 'left') : strafeKey
      const key = stepSafe(bot, keyDir(bot, flip)) ? flip : (stepSafe(bot, keyDir(bot, strafeKey)) ? strafeKey : null)
      if (key) { dodgeKey = key; strafeKey = key; dodgeUntil = now + 550 + Math.random() * 450; strafeFlipAt = dodgeUntil; st.dodges++ }
      if (ready('cbAimNote')) { rest('cbAimNote', 3000); used(`его заряженный арбалет на мне (${aimedCb.ammo || '?'}${aimedCb.piercing ? ', «Пронзание»' : ''}) — схожу с линии`) }
    }

    // ---- Рельеф. Сам в яме, а он не достаёт — выбираться.
    if (myPit && !theirPit && r > HIT_REACH && ready('pitOut')) {
      rest('pitOut', 2500)
      if (await climbOut(myPit)) continue
    }
    // Он в яме — не выпускать: лава сверху (только игрока — моба и мечом
    // добьём), паутина на него, зелья и стрелы вниз (ниже, по дальности).
    if (theirPit && !myPit) {
      const lava = findItem(bot, i => i.name === 'lava_bucket')
      if (lava && prof.player && ready('pitLava')) {
        rest('pitLava', 6000)
        if (await lavaIntoPit(lava)) continue
      }
      const web = findItem(bot, i => i.name === 'cobweb')
      if (web && ready('pitWeb') && r < 5.3) {
        rest('pitWeb', 4000)
        if (await placeUnder(web, 'паутина ему в яму')) { await holdWeapon(); continue }
      }
      if (ready('pitNote')) { rest('pitNote', 5000); used('он в яме — не выпускаю') }
    }

    // ---- Он высоко над нами (выпали с арены в небе и выжили, 2026-09-25: бот
    // стоял внизу и смотрел вверх на него за полсотни блоков) — наверх: столб
    // через дыру в его полу или сквозь потолок (edges.climbBack). Не на столбе
    // своём и не когда он сам на столбе рядом (это ниже — ответный столб).
    // Только если он там СТОИТ дольше 1.5 с: взлёт с булавой на зарядах ветра
    // тоже даёт «выше на 6+», и бот строил столб к летящему, а тот уже падал
    // обратно — колонна вверх впустую (2026-09-26, пользователь: «бессмысленно
    // строят колонну наверх, чуть постоят и идут обратно»).
    if (dy > 6 && foeGrounded()) { if (!st.highSince) st.highSince = now } else st.highSince = 0
    if (!AR && prof.player && dy > 6 && st.highSince && now - st.highSince > 1500 && !perch && d < 90 && ready('climbBack')) {
      rest('climbBack', 5000)
      pathTo(false); pathing = false
      clear()
      aim = 'free'
      const t0c = gameClock.now()
      let cb = null
      const gK = buildGuard()
      try { cb = await edges.climbBack(bot, guardCtl(gK), entity, { beforeStep: towerShield, archer: bowWatch.shots > 0 || !!findItem(bot, i => i.name === 'bow' || i.name === 'crossbow') }) } catch (e) { cb = { ok: false, why: e.message } }
      if (buildDone(gK, 'подъём к нему')) cb = { ok: false, why: gK.why }
      aim = 'target'
      await holdWeapon()
      used(cb && cb.ok ? `поднялся к нему (${cb.how}, ${Math.round((gameClock.now() - t0c) / 1000)} с)` : `не поднялся: ${(cb && (cb.why || cb.how)) || '?'}`)
      if (process.env.ND_DEBUG_PVP) console.log('[climb]', JSON.stringify(cb))
      continue
    }

    // ---- Наказать занятого (темп, 2026-09-25: «когда другой пьёт — это для
    // тебя возможность»). Чем он занят, tempo.track видит по событиям
    // (метаданные «рука занята» + предмет в ней, взмах, блоки, телепорт);
    // здесь — ответ: зелье вреда (12 магией сквозь броню: STRONG_HARMING,
    // HealOrHarmMobEffect 6 << уровень), рывок и удар, пока он медленный
    // (×0.2 с предметом в ходу), стрела издалека, шаг внутрь после его взмаха.
    let punRush = false
    let punStep = false
    let punBow = false
    if (tempo.ON && prof.player && !meInWeb && !perch) {
      const harm = findItem(bot, i => i.name === 'splash_potion' && /harming$/.test(potionOf(i) || ''))
      const pun = tt.punish(entity, {
        d, r, sees: seesBody, hitReach: HIT_REACH,
        has: { harm: !!harm, bow: !cx.dominant() && !!(findItem(bot, i => i.name === 'bow') && findItem(bot, i => /arrow$/.test(i.name))) }
      })
      if (pun) {
        // Счёт: сколько его глотков мы пошли наказывать (раз на глоток).
        const cEat = /^он (ест|пьёт)$/.test(pun.why) ? tt.state(entity).consuming : null
        if (cEat && cEat.since !== st.eatPunish.at) { st.eatPunish.at = cEat.since; st.eatPunish.tries++ }
        if (ready('punNote:' + pun.kind)) {
          rest('punNote:' + pun.kind, 2500)
          tt.punished(pun.kind)
          used(`наказываю (${pun.why}): ${({ harm: 'зелье вреда', rush: 'рывок', bow: 'стрела', step: 'шаг внутрь' })[pun.kind]}`)
        }
        if (pun.kind === 'harm' && harm && ready('punHarm')) {
          rest('punHarm', 1500)
          if (await throwAt(harm, 'зелье вреда в занятого')) { await holdWeapon(); continue }
        }
        punRush = pun.kind === 'rush' || pun.kind === 'harm'
        punBow = pun.kind === 'bow'
        // Шаг внутрь — только если наш удар зарядится раньше его: иначе
        // обычный отход в перезарядке (он и даёт спринт-удар на возврате).
        punStep = pun.kind === 'step' && cooldownLeft < pun.left
      }
    }

    // ---- Заряд ветра как толчок (mace.js, 2026-09-26): в яму или с края
    // (прогон тела edges.knockRun), со столба (сядет ниже всплеска — урон от
    // падения), по занятому (ест, пьёт, тянет лук: 1 урона и подброс), навстречу
    // рывку, пока свой удар не заряжен. Смена слота обнуляет заряд меча.
    if (prof.player && !perch && !fort && !meInWeb && ready('windPush')) {
      const vv = track.vel()
      const closingNow = (vv.x * (me.x - entity.position.x) + vv.z * (me.z - entity.position.z)) / Math.max(d, 0.1)
      const pp = mace.pushPlan(bot, entity, { sees: seesBody, theyUp, busy: theyEat ? 'ест или пьёт' : theyBow ? 'тянет лук' : null, closing: closingNow, cooldownLeft, blocking })
      if (pp) {
        rest('windPush', 1500)
        if (guard) await guard.raise(false)
        aim = 'free'
        const wr = await mace.windPush(bot, entity, { vel: () => track.vel(), swap: true })
        aim = 'target'
        if (wr.fired) {
          mc.notePush(entity, pp.why)
          used('заряд ветра: ' + pp.why)
          nextReady = Math.max(nextReady, gameClock.now() + cooldownMs(bot.heldItem))
          await holdWeapon()
          continue
        }
      }
    }

    // ---- Против летуна на элитрах (elytra.js, 2026-09-26): по земле его не
    // догнать и рукой не достать — не гнаться pathfinder'ом под ним, стрелять
    // в его рамку 0.6×0.6 (Avatar.POSES: FALL_FLYING) с упреждением по его
    // полёту (та же физика элитр — elytra.predictGlider), между выстрелами —
    // стрейф. Стрелять нечем — стрейф на месте, пока не сядет.
    if (prof.player && sky.gliding() && !meInWeb && r > HIT_REACH) {
      if (pathing) { pathTo(false); pathing = false }
      const bowA = findItem(bot, i => i.name === 'bow')
      const arrA = findItem(bot, i => /arrow$/.test(i.name))
      const d3 = me.distanceTo(entity.position)
      if (rangedAllowed() && bowA && arrA && d3 >= 4 && d3 < 48 && seesBody && ready('bowAir')) {
        rest('bowAir', 300)
        if (guard) await guard.raise(false)
        clear()
        aim = 'free'
        const beforeA = heldName()
        let sideA = Math.random() < 0.5 ? 'left' : 'right'
        let flipA = gameClock.now() + 300 + Math.random() * 400
        const shotA = await bowShoot(bot, entity, {
          point: (t) => { const q = sky.fl.at(Math.min(30, Math.max(0, Math.round(t)))); return q ? q.offset(0, 0.3, 0) : entity.position.offset(0, 0.3, 0) },
          follow: false,
          onHit: () => { st.arrowHits = (st.arrowHits || 0) + 1; sky.fl.st.hits++ },
          shouldStop: () => ctl.aborted || !sky.gliding() || !!sky.threat() || (FIX && maceNow()),
          onDraw: () => {
            if (gameClock.now() > flipA) { sideA = sideA === 'left' ? 'right' : 'left'; flipA = gameClock.now() + 300 + Math.random() * 500 }
            set('left', sideA === 'left' && stepSafe(bot, keyDir(bot, 'left')))
            set('right', sideA === 'right' && stepSafe(bot, keyDir(bot, 'right')))
          }
        })
        clear()
        aim = 'target'
        switched(beforeA)
        if (shotA.shot) { used('стрела по летуну на элитрах'); st.arrows = (st.arrows || 0) + 1; sky.fl.st.shots++ }
        await holdWeapon()
        continue
      }
      if (now >= strafeFlipAt) { strafeKey = strafeKey === 'left' ? 'right' : 'left'; strafeFlipAt = now + 400 + Math.random() * 700 }
      set('forward', false); set('back', false); set('jump', false); set('sprint', false)
      set('left', strafeKey === 'left' && stepSafe(bot, keyDir(bot, 'left')))
      set('right', strafeKey === 'right' && stepSafe(bot, keyDir(bot, 'right')))
      if (ready('skyWaitNote')) { rest('skyWaitNote', 5000); used('он на элитрах — не гонюсь, жду посадки') }
      await sleep(TICK_MS)
      continue
    }
    // ---- «Динамит» (boom.js, 2026-09-26): стрела во взрывчатку у него (своя
    // мина или его — вагонетку только горящей стрелой, MinecartTNT.hurtServer),
    // кристалл у его ног и удар (если себе терпимо), мина между нами (рельс и
    // вагонетка с TNT или кристалл), когда он идёт на нас или занят. Урон —
    // по формуле игры обоим; только с рельсами и вагонетками или кристаллами.
    if (prof.player && !meInWeb && !perch && !fort && ready('boom')) {
      rest('boom', 200)
      const vB = track.vel()
      const closingB = (vB.x * (me.x - entity.position.x) + vB.z * (me.z - entity.position.z)) / Math.max(d, 0.1)
      const bp = bm.plan({ closing: closingB, busy: !!(theyEat || inWeb || blocking) })
      if (bp) {
        if (guard) await guard.raise(false)
        pathTo(false); pathing = false
        clear()
        aim = 'free'
        const beforeB = heldName()
        let rb = null
        try { rb = await bm.run(ctl, bp, { stepSafe: dir => stepSafe(bot, dir), stop: () => FIX && maceNow() }) } catch (e) { rb = { note: 'взрывчатка: ' + e.message } }
        aim = 'target'
        clear()
        switched(beforeB)
        if (rb && rb.note) used(rb.note)
        await holdWeapon()
        rest('boom', bp.kind === 'shoot' ? 400 : 1500)
        continue
      }
    }
    // ---- 3а. Арбалет (ranged.js, 2026-09-26): заряженный — мгновенный выстрел в
    // окно, которого лук не ловит (добить после его тотема, он ест или пьёт,
    // «Пронзание» сквозь поднятый щит, фейерверк издалека, первый выстрел);
    // разряженный — зарядить, пока он не успеет дойти (tempo.safe), стрейфя.
    // Арбалет держит дистанцию (2026-09-26: «арбалет» 0:4 и ничья против лука со
    // щитом — после выстрела цикл шёл в сближение, бой уходил в меч, а зарядка
    // ждала tempo.safe, куда входит и его лук: пока лук в руке и видит нас, окна
    // «безопасно» почти не бывало — за раунд одна зарядка). Теперь: он в 4.5–24
    // бл., а арбалет — наше «издалека» (ranged.crossbowFirst) — пятиться и
    // стрейфить, заряжать, пока его МЕЧ не успеет (быстрая перезарядка III —
    // 10 тиков, CrossbowItem.getChargeDuration), стрелять; бежит на нас, а
    // заряда нет — стенка между нами (coverFrom) и зарядка за ней; вплотную —
    // меч (дальше по циклу). В 1 против 2 — нет (там свой порядок, duo.js).
    const xbAmmo = !!(findItem(bot, i => /arrow$/.test(i.name)) || findItem(bot, i => i.name === 'firework_rocket'))
    // С булавой в наборе (арсенал) — нет: её взлёт и зелья в 4–8 бл. дороже
    // стрелы, а этот блок стоит раньше них и забирал бы средние дистанции.
    // Стрелы его не берут (2026-09-26: «Защита от снарядов» на всех кусках —
    // ×0.2, стрела арбалета по алмазу ~0.5 хп; живая арена — перестрелка на 7
    // минут вничью): держать дистанцию и стрелять незачем, меч даёт в разы
    // больше. Фейерверк бьёт взрывом — его режет «Взрывоустойчивость», не она.
    // Сравнение — с нашим ударом по той же броне: «Защита» режет оба, и тогда
    // арбалет с дистанции не хуже меча под его ударами; «Защита от снарядов» —
    // только стрелу. Слабо — стрела меньше 0.4 нашего крит-удара или меньше 0.8.
    const shotDmg = prof.player ? Math.max(ranged.expectedDamage(bot, entity, 'arrow'), ranged.rocketsOf(bot) ? ranged.expectedDamage(bot, entity, 'firework') : 0) : 9
    let meleeDmg = 0
    if (prof.player) {
      try {
        const w = bestWeapon(bot)
        const WEAPON = require('./totem').WEAPON
        let raw = ((w && WEAPON[w.name]) || 1) * 1.5
        const sharp = w ? read.enchLevel(bot, w, 'sharpness') : 0
        if (sharp > 0) raw += 1 + 0.5 * (sharp - 1)
        const armorE = (entity.equipment || []).slice(2)
        const g = assess.gearOf(armorE)
        const epfM = Math.min(20, armorE.reduce((n, it) => n + (it ? read.enchLevel(bot, it, 'protection') : 0), 0))
        meleeDmg = assess.afterArmor(raw, g.armor, g.tough) * (1 - epfM / 25)
      } catch {}
    }
    const blockedLong = !!st.blockedSince && now - st.blockedSince > 2500
    const arrowsWeak = prof.player && !blockedLong && (shotDmg < 0.8 || shotDmg < 0.4 * meleeDmg) && !!findItem(bot, i => /_(sword|axe)$/.test(i.name) || i.name === 'mace')
    if (arrowsWeak && ready('arrowsWeakNote')) { rest('arrowsWeakNote', 8000); used('стрелы его почти не берут — в ближний бой') }
    const xbKite = prof.player && !arrowsWeak && !meInWeb && !perch && !fort && !theyUp && !punRush && now >= rushUntil && xbAmmo &&
      d >= 4.5 && d <= 24 && !duo.active() && !!findItem(bot, i => i.name === 'crossbow') && ranged.crossbowFirst(bot) &&
      !findItem(bot, i => i.name === 'mace')
    const hisShield = !!((entity.equipment && entity.equipment[1] && entity.equipment[1].name === 'shield') || blocking)
    // Зарядка «пока меч не успеет»: его путь до руки на спринте (0.28 бл/тик) —
    // не короче заряда без запаса на отпускание; лук его — не помеха (от стрелы
    // щит и уклон, а не отказ от зарядки); по нам только что попали — нет.
    const xbLoadSafe = (ms) => {
      if (gameClock.now() - tt.myHurtAt < 300) return false
      const gap = Math.max(0, theirR - tempo.PLAYER_REACH)
      return (gap / tempo.SPRINT_BPT) * TICK_MS >= ms - 250
    }
    if (rangedAllowed() && prof.player && !meInWeb && ready('xbow') && findItem(bot, i => i.name === 'crossbow')) {
      rest('xbow', 200)
      let xSide = strafeKey
      let xFlip = now + 300 + Math.random() * 400
      const fsX = foe.state(entity)
      const hisMain = entity.equipment && entity.equipment[0] ? entity.equipment[0].name : ''
      const vX = track.vel()
      const xCtx = {
        entity, d, r, sees: seesBody, hp, fs: fsX, busy: tt.state(entity), allIn: foe.allIn(entity),
        kite: xbKite, hisShield, theyDraw: theyBow, weak: arrowsWeak,
        safe: (ms) => (xbKite ? xbLoadSafe(ms) : tt.safe(ms, { fortSealed: fortSealed() }).ok),
        shieldAtUs: mace.shieldAtUs(bot, entity),
        others: [...attackers.values()].filter(a => gameClock.now() - a.at < 8000).map(a => a.e),
        opening: !firstHitDone, rushing: punRush || now < rushUntil,
        totemOff: !!(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'totem_of_undying'),
        velFn: () => track.vel(),
        abortIf: () => gameClock.now() - tt.myHurtAt < 300 || (entity.isValid && reachFrom(entity.position.offset(0, EYE, 0), bot.entity) <= tempo.PLAYER_REACH + 0.5) || (FIX && maceNow()),
        onLoadTick: () => {
          if (gameClock.now() > xFlip) { xSide = xSide === 'left' ? 'right' : 'left'; xFlip = gameClock.now() + 300 + Math.random() * 500 }
          set('forward', false); set('sprint', false)
          set('left', xSide === 'left' && stepSafe(bot, keyDir(bot, 'left')))
          set('right', xSide === 'right' && stepSafe(bot, keyDir(bot, 'right')))
        },
        arrowCtx: {
          d, fs: fsX, player: true,
          running: (vX.x * (entity.position.x - me.x) + vX.z * (entity.position.z - me.z)) / Math.max(d, 0.1) > 0.12,
          strongHitter: fsX.effects && fsX.effects.has('strength') || /_axe$|^mace$|^netherite_sword$/.test(hisMain)
        }
      }
      const xPlan = ranged.plan(bot, xCtx)
      let xb = null
      if (xPlan) {
        if (guard) await guard.raise(false)
        pathTo(false); pathing = false
        aim = 'free'
        xb = await ranged.step(bot, ctl, xCtx, { used, holdWeapon, stats: st.xbow || (st.xbow = {}), planned: xPlan })
        aim = 'target'
      }
      if (xb && xb.did === 'fire' && xb.ok) {
        // Смена слота в одном тике — заряд меча сервер обнулил (Paper, замер mace.js).
        nextReady = Math.max(nextReady, gameClock.now() + cooldownMs(bot.heldItem))
        continue
      }
      if (xb && xb.did === 'load') continue
      if (xb && xb.blocked) rest('xbow', 1500)
    }
    if (xbKite) {
      if (pathing) { pathTo(false); pathing = false }
      const loadedX = ranged.crossbows(bot).some(x => x.info.loaded)
      const vK = track.vel()
      const toMeK = (vK.x * (me.x - entity.position.x) + vK.z * (me.z - entity.position.z)) / Math.max(d, 0.1)
      // Бежит на нас, заряда нет и не успеть — стенка между нами, заряд за ней.
      if (!loadedX && toMeK > 0.12 && d < 9 && !xbLoadSafe(10 * TICK_MS + 350) && pickFiller(bot) && ready('xbCover')) {
        rest('xbCover', 2500)
        const put = await coverFrom(entity.position, { what: 'арбалет: стенка между нами — заряжаю за ней' })
        if (put) { rest('xbow', 0); await holdWeapon(); continue }
      }
      // Он тянет лук, а ответить нечем (заряда нет) — щит к нему: стрелу щит
      // гасит целиком спереди; заряд есть — щит вниз, выстрел в его натяжение
      // (блок 3а выше: пока тянет, его щит не поднят).
      if (guard && guard.stats && guard.stats.worn) {
        if (theyBow && !loadedX && seesBody) { guard.raise(true); if (ready('bowShieldNote')) { rest('bowShieldNote', 4000); used('щит от стрелы') } } else guard.raise(false)
      }
      // Шаг: пятиться, когда он идёт на нас (или ближе 7), подойти, если ушёл
      // дальше 14; стрейф с разворотами — уйти с линии его лука.
      if (now >= strafeFlipAt) { strafeKey = strafeKey === 'left' ? 'right' : 'left'; strafeFlipAt = now + 300 + Math.random() * 600 }
      if (sawRelease()) { strafeKey = strafeKey === 'left' ? 'right' : 'left'; strafeFlipAt = now + 400 + Math.random() * 400; st.dodges++; used('ушёл с линии выстрела') }
      const backK = (toMeK > 0.03 || d < 7) && stepSafe(bot, keyDir(bot, 'back'))
      const fwdK = d > 14 && !backK && stepSafe(bot, keyDir(bot, 'forward'))
      set('forward', fwdK); set('back', backK)
      set('left', strafeKey === 'left' && stepSafe(bot, keyDir(bot, 'left')))
      set('right', strafeKey === 'right' && stepSafe(bot, keyDir(bot, 'right')))
      set('sprint', fwdK && (bot.food ?? 20) > 6); set('jump', false)
      if (ready('xbKiteNote')) { rest('xbKiteNote', 5000); used('арбалет: держу дистанцию, заряжаю и стреляю') }
      await sleep(TICK_MS)
      continue
    }

    // ---- 3. Лук — пока не подошёл. Ближника не подпускаем: стреляем с 6
    // блоков, пятясь, пока он идёт (в прогоне бот сам шёл к мобам и получал).
    // Человека — дальше 7. Скелета — только издалека: в перестрелке с ним
    // быстрее сблизиться зигзагом.
    // На столбе — стрелять по всему, что не вплотную: уйти всё равно некуда.
    // На столбе прямо над нами по земле до него 0-2 блока, а мечом не достать —
    // тут меряем по прямой и стреляем почти в упор (арена 2026-09-25: игрок
    // залез на колонну, бот с луком в рюкзаке стоял под ним с мечом).
    // Меча/топора нет (перестрелка: лук и щит) — лук и есть оружие: сближаться
    // кулаками под его стрелами — проигрыш (арена 2026-09-25: 4 выстрела за раунд).
    const noMelee = !findItem(bot, i => /_(sword|axe)$/.test(i.name))
    const bowRange = theirPit ? 1.2 : theyUp ? 1.5 : noMelee ? 2.5 : perch ? 3 : prof.player ? FAR : prof.ranged ? 12 : 6
    const bowItem = rangedAllowed() ? findItem(bot, i => i.name === 'bow') : null
    const arrowItem = findItem(bot, i => /arrow$/.test(i.name))
    // Летуну дистанция — по прямой в пространстве, а не по земле: гаст над
    // головой на высоте 15 «рядом» только на карте.
    const dBow = prof.flying || theyUp ? me.distanceTo(entity.position) : d
    const sees = seesBody
    if (process.env.ND_DEBUG_PVP && now - (st.dbgAt || 0) > 1000) {
      st.dbgAt = now
      console.log('[pvp]', JSON.stringify({ t: label, d: Math.round(d * 10) / 10, dBow: Math.round(dBow * 10) / 10, dy: Math.round(dy), hp: Math.round(hp), r: Math.round(r * 10) / 10, theirR: Math.round(theirR * 10) / 10, cd: cooldownLeft, iframes: Math.max(0, targetHurtAt + 500 - now), blocking, meInWeb, pathing, held: heldName(), swings: st.swings, bow: !!bowItem, arrows: !!arrowItem, sees, range: bowRange, ready: ready('bow'), flying: !!prof.flying }))
    }
    // Темп: рывок (начало боя или наказание) — не стоять с луком; стрела в
    // занятого — и с 5 блоков.
    // Арбалет с быстрой перезарядкой бьёт чаще и всегда критом (ranged.crossbowFirst) —
    // тогда лук молчит, стреляет блок 3а.
    // Стрелы не берут — лук только туда, куда мечом не достать (столб, яма, мы на столбе).
    // Кристаллы (2026-09-30): лук — подрыв кристаллов (crystal.js), не перестрелка:
    // с луком на 20 блоках бой кристаллами превращался в тир (прогон crystal t1).
    const bowPointless = (arrowsWeak || cx.dominant()) && !theyUp && !perch && !theirPit
    if (bowItem && arrowItem && !bowPointless && dBow >= (punBow ? 5 : bowRange) && dBow < (prof.flying ? 64 : 48) && ready('bow') && sees && !punRush && now >= rushUntil && !(prof.player && ranged.crossbowFirst(bot))) {
      rest('bow', 250)
      if (guard) await guard.raise(false)
      pathTo(false); pathing = false
      clear()
      const before = heldName()
      aim = 'free'
      let side = Math.random() < 0.5 ? 'left' : 'right'
      let flipAt = gameClock.now() + 300 + Math.random() * 400
      const closeAt = theyUp ? 0 : prof.player ? 5 : 3.5
      // Какой стрелой (ranged.js, 2026-09-26): лук берёт левую руку, потом слоты
      // 0..35 по порядку (Player.getProjectile) — выбранную пачку ставим первой.
      // Вред — добить или мимо алмаза, коротким натяжением; медлительность —
      // он убегает; слабость — он сильно бьёт; яд — издалека.
      let prepB = { drawMs: null, why: null }
      if (prof.player) {
        const fsB = foe.state(entity)
        const vB = track.vel()
        const hisHand = entity.equipment && entity.equipment[0] ? entity.equipment[0].name : ''
        prepB = await ranged.prepBow(bot, {
          d: dBow, fs: fsB, player: true,
          running: (vB.x * (entity.position.x - me.x) + vB.z * (entity.position.z - me.z)) / Math.max(d, 0.1) > 0.12,
          heavyArmor: assess.gearOf((entity.equipment || []).slice(2)).armor >= 15,
          strongHitter: (fsB.effects && fsB.effects.has('strength')) || /_axe$|^mace$|^netherite_sword$/.test(hisHand)
        }).catch(() => ({ drawMs: null, why: null }))
        if (prepB.why) used('стрела: ' + prepB.why)
      }
      const shot = await bowShoot(bot, entity, {
        velFn: () => track.vel(),
        follow: false,
        drawMs: prepB.drawMs || undefined,
        // Его щит поднят к нам — держать тетиву, пустить, как опустит (bow.js).
        holdWhile: prof.player ? () => mace.shieldAtUs(bot, entity) : null,
        onHit: () => { st.arrowHits = (st.arrowHits || 0) + 1 },
        // Фаербол подлетает — бросить тетиву: отбить его важнее выстрела.
        shouldStop: () => ctl.aborted || entity.position.distanceTo(bot.entity.position) < closeAt ||
          Object.values(bot.entities).some(e => e && e.name === 'fireball' && e.position && e.position.distanceTo(bot.entity.position) < 7) || (theyUp && reachFrom(bot.entity.position.offset(0, EYE, 0), entity) <= HIT_REACH) || (FIX && maceNow()),
        // Натягивая, не стоять столбом: стрейф и шаг назад от того, кто идёт.
        onDraw: () => {
          track.update()
          // Он выстрелил, пока мы тянем, — сменить сторону сейчас же.
          if (sawRelease()) { side = side === 'left' ? 'right' : 'left'; flipAt = gameClock.now() + 400 + Math.random() * 400; st.dodges++; used('ушёл с линии выстрела') }
          if (gameClock.now() > flipAt) { side = side === 'left' ? 'right' : 'left'; flipAt = gameClock.now() + 300 + Math.random() * 500 }
          const v = track.vel()
          const mp = bot.entity.position
          const dist = Math.max(0.1, mp.distanceTo(entity.position))
          const toMe = (v.x * (mp.x - entity.position.x) + v.z * (mp.z - entity.position.z)) / dist
          set('left', side === 'left' && stepSafe(bot, keyDir(bot, 'left')))
          set('right', side === 'right' && stepSafe(bot, keyDir(bot, 'right')))
          set('back', (toMe > 0.05 || !prof.player) && stepSafe(bot, keyDir(bot, 'back')))
        }
      })
      clear()
      aim = 'target'
      switched(before)
      if (shot.shot) { used('выстрел из лука'); st.arrows = (st.arrows || 0) + 1 }
      // Стрелять не из чего — стена на пути. Не долбить в неё: пару секунд
      // лук не трогаем, а идём pathfinder'ом к цели в обход (через проём),
      // пока путь не откроется.
      if (shot.blocked) {
        rest('bow', 2500)
        repositionUntil = gameClock.now() + 2500
        if (!st.blockedShots) used('стена на линии — обхожу')
        st.blockedShots = (st.blockedShots || 0) + 1
      }
      await holdWeapon()
      continue
    }

    // ---- Подручное (utility.js, 2026-09-26): удочка (со столба, в яму или лаву,
    // едока — к мечу), трезубец («Верность», молния в грозу, «Тягун» рывком к
    // нему), ловушки застрявшему (лава на паутину, коробка 1×2, наковальня).
    // До стойки showman: сдёрнуть со столба важнее, чем покрасоваться.
    if (prof.player && !perch && !fort && !meInWeb && ready('utility')) {
      rest('utility', 150)
      aim = 'free'
      const ua = await util.step({ entity, d, dy, r, hp, sees: seesBody, theyUp, busy: tt.state(entity), vel: () => track.vel(), others: duo.foes().filter(e => e !== entity), ctl })
      aim = 'target'
      if (ua) { if (ua.rush) rushUntil = gameClock.now() + 1500; await holdWeapon(); continue }
    }

    // ---- Человек (showman.js, 2026-09-26): до сшибки и в затишье — стойка
    // (круг, присед, кивок, взмах, подзыв), ответ тем же на его жест, засада за
    // колонной. Берёт тело на тик, пока безопасно, и отдаёт в тот же тик, как
    // только он пошёл в атаку, натянул лук или что-то бросил.
    if (hm && prof.player && (await hm.pre({
      now, d, dy, r, theirR, hp, theirHp, theyBow, blocking, seesBody, busyFoe, meInWeb, cooldownLeft,
      perch: !!perch, fort: !!fort, incoming: inc.length, vel: track.vel(), others: !!otherAttacker(),
      openRush: now < rushUntil, punRush, cbAimed: !!aimedCb || cbShield, press: pressing
    }))) { await sleep(TICK_MS); continue }

    // ---- Он спрятался. Коробка (3-4 стены) — осада: киркой выломать блок у
    // его головы и бить через дыру; кирки нет — караулить выход в двух шагах
    // (и лечиться — calmHeal выше). Просто стенка — обойти её.
    if (hidden && !perch && after('hidden', true) && punches < style.punchLimit && ready('punch')) {
      if (await punchThrough()) { punches++; continue }
    }
    if (!hidden) delete noticed.hidden
    if (hidden && !perch && punches >= style.punchLimit && ready('punchGiveUp')) {
      // Прорубаю, а он латает быстрее — не зацикливаться: паузу на лечение и
      // караул, потом снова.
      rest('punchGiveUp', 6000)
      rest('punch', 5000)
      punches = 0
      used('он латает быстрее — жду и лечусь')
    }
    if (hidden && !perch) {
      const theirCell = entity.position.floored()
      const enc = fortify.enclosure(bot, theirCell)
      const pickaxe = fortify.pickaxeOf(bot)
      if (enc.walls >= 3 && pickaxe) {
        const plan = fortify.siegePlan(bot, theirCell, me)
        // Крепкая коробка (обсидиан: 2–9 с на блок, 2026-09-26) — пока ещё
        // издали, зелье вреда или яда к нему: брызги достают сквозь стены
        // (AbstractThrownPotion.applySplash: все в 4 блоках от разрыва, луча
        // нет), а вплотную бросать нельзя — облако и по себе.
        if (plan && plan.digMs > 2500 && d >= 4.6 && d <= 8 && ready('boxPotion')) {
          const pot = findItem(bot, i => i.name === 'splash_potion' && /(harming|poison)$/.test(potionOf(i) || ''))
          if (pot) {
            rest('boxPotion', 5000)
            if (await throwAt(pot, 'зелье в его коробку')) { await holdWeapon(); continue }
          }
        }
        if (plan && plan.digMs <= 12000) {
          const standDist = Math.hypot(plan.stand.x + 0.5 - me.x, plan.stand.z + 0.5 - me.z)
          if (standDist > 0.9) {
            const key = `${plan.stand.x},${plan.stand.y},${plan.stand.z}`
            if (siegeGoal !== key) { siegeGoal = key; pathTo(true, new goals.GoalBlock(plan.stand.x, plan.stand.y, plan.stand.z)); pathing = true; clear() }
            await sleep(TICK_MS)
            continue
          }
          if (ready('siege')) {
            rest('siege', 300)
            pathTo(false); pathing = false; siegeGoal = null
            clear()
            aim = 'free'
            // Долгая ломка (обсидиан) — с глазами наружу: он вышел, булава
            // летит, по нам попали — бросить (раньше обсидиан дольше 8 с не
            // ломался вовсе, и осаждающий 25 с стоял у стены).
            const stop = await digWatch(bot.blockAt(plan.breakAt), () => (prof.player && mc.threat()) ? 'булава летит'
              : !entity.isValid ? 'он пропал' : entity.position.floored().distanceTo(theirCell) > 1.5 ? 'он вышел'
                : gameClock.now() - tt.myHurtAt < 300 ? 'бьют меня' : null)
            aim = 'target'
            await holdWeapon()
            if (!fortify.solidAt(bot, plan.breakAt)) used(plan.digMs > 2500 ? 'выломал блок его крепкой коробки' : 'выломал блок его коробки киркой')
            else if (stop) used(`бросил ломать его коробку: ${stop}`)
            continue
          }
        } else if (plan && ready('guard')) { rest('guard', 4000); used('его коробку не вскрыть — караулю') }
      } else if (enc.walls >= 3) {
        if (ready('guard')) { rest('guard', 4000); used('караулю его коробку') }
      } else if (r > HIT_REACH && ready('punch') && (await punchThrough())) {
        continue
      } else if (r > HIT_REACH && !theyUp && !(st.flankStuckUntil && now < st.flankStuckUntil)) {
        // Стенка, не коробка: в обход, пока он за ней ест. Он наверху (на
        // столбе) — не обходить, а строить свой столб (ниже, theyUp). Обход без
        // толку (3 с, а до него не ближе на блок; живой прогон 2026-09-27:
        // 20 с «обхожу его стенку» на месте под его столбом) — 6 с на другое:
        // столб, пролом, стрелы.
        if (!pathing) { pathTo(true); pathing = true; clear(); st.flankFrom = { at: now, d } }
        if (st.flankFrom && now - st.flankFrom.at > 3000) {
          if (d > st.flankFrom.d - 1) {
            st.flankStuckUntil = now + 6000
            pathTo(false); pathing = false
            used('обход не выходит — иначе')
          }
          st.flankFrom = { at: now, d }
        }
        if (ready('flank')) { rest('flank', 3000); used(theyEat ? 'рывок в обход, пока он ест' : 'обхожу его стенку') }
        await sleep(TICK_MS)
        continue
      }
    } else if (siegeGoal) { siegeGoal = null; pathTo(false); pathing = false }

    // Он на столбе, а лука нет — строить свой рядом: взобраться до его ног и
    // бить снизу вверх. Сперва — встать вплотную к его столбу.
    // Лук есть, но стрел нет или он сидит наверху дольше шести секунд —
    // тоже строить: стрелять в него снизу вечно — не бой (2026-09-25).
    if (theyUp) { if (!theyUpSince) theyUpSince = now } else theyUpSince = 0
    const upLong = theyUpSince && now - theyUpSince > 6000
    if (theyUp && prof.player && !perch && (!findItem(bot, i => i.name === 'bow') || !findItem(bot, i => /arrow$/.test(i.name)) || upLong) && ready('counterPillar')) {
      const filler = pickFiller(bot)
      const need = Math.floor(entity.position.y - me.y) - 1
      if (filler && need >= 2 && need <= 12 && countOf(bot, filler.name) >= need && headroom(need + 1)) {
        if (d > 1.6) {
          if (!pathing) { pathTo(true, new goals.GoalNear(entity.position.x, me.y, entity.position.z, 1)); pathing = true; clear() }
          await sleep(TICK_MS)
          continue
        }
        rest('counterPillar', 8000)
        pathTo(false); pathing = false
        clear()
        aim = 'free'
        // Он сверху достаёт рукой (≤ 3.4 от его глаз) — под ним не расти: столб
        // поднимает голову к его мечу (FIX); бьют посреди стройки — бросить.
        if (FIX && theirR <= THEIR_REACH) { st.build.refused++; aim = 'target'; used('столб к его столбу: не строю — он достаёт сверху'); continue }
        noteBuild('counter', need * PILLAR_MS)
        const gC = buildGuard()
        try { await towerUp(bot, guardCtl(gC), need, { sneak: false, fast: true, beforeStep: towerShield }) } catch {}
        aim = 'target'
        await holdWeapon()
        if (buildDone(gC, 'столб к его столбу')) continue
        used(`строю столб к его столбу (${need} бл.)`)
        continue
      }
    }

    // Упёрся: между нами стена в рост (закрыты и луч к телу, и луч у ног) или
    // тело трётся о блок, не доставая его. Клавишами её не пройти — pathfinder
    // (с копанием, см. выше) решит, обойти или прорубить (2026-09-26: «уперлись
    // в стену вдвоём, не пытаясь ни блоки сломать, ни обойти»).
    if (bot.entity.isCollidedHorizontally && (bot.getControlState('forward') || bot.getControlState('left') || bot.getControlState('right'))) stuckTicks++
    else stuckTicks = 0
    if (!perch && !fort && r > HIT_REACH && now >= repositionUntil && ready('unstick')) {
      const wall = !seesBody && !raySees(bot, me.offset(0, 0.4, 0), entity.position.offset(0, 0.4, 0))
      if (wall || stuckTicks >= 8) {
        rest('unstick', 1500)
        repositionUntil = now + 3000
        stuckTicks = 0
        used(wall ? 'стена между нами — путь в обход или насквозь' : 'упёрся — обхожу')
      }
    }
    // Обход стены: клавишами через стекло не пройти — ведёт pathfinder.
    if (now < repositionUntil && r > HIT_REACH && !perch) {
      if (!pathing) { pathTo(true); pathing = true; clear() }
      await sleep(TICK_MS)
      continue
    }

    // Летун, до которого мечом не достать (гаст высоко, фантом кружит): не
    // лезть под него по земле, а стрейфиться на месте — лук и отбитые шары
    // сделают остальное.
    if (prof.flying && (dy > 3 || entity.name === 'ghast')) {
      if (pathing) { pathTo(false); pathing = false }
      if (now >= strafeFlipAt) {
        strafeKey = strafeKey === 'left' ? 'right' : 'left'
        strafeFlipAt = now + 400 + Math.random() * 900
      }
      const zig = dodgeKey && now < dodgeUntil ? dodgeKey : strafeKey
      set('forward', false)
      set('back', false)
      set('left', zig === 'left' && stepSafe(bot, keyDir(bot, 'left')))
      set('right', zig === 'right' && stepSafe(bot, keyDir(bot, 'right')))
      set('sprint', false)
      set('jump', false)
      await sleep(TICK_MS)
      continue
    }

    // Стоим на столбах друг против друга (интеграционная арена 2026-09-26:
    // оба в 4–5 блоках над полом, в 4.8 друг от друга, минутами без удара:
    // рефлекс края не пускает вниз, мостить никто не умеет). Четыре секунды
    // без размена — мост к нему на уровне своей опоры (bridge.build), а нечем
    // или не вышло — спуск туда, где падение стоит floor(h − 3) и хп хватает.
    if (prof.player && !fort && !meInWeb && r > HIT_REACH && d < 8 && Math.abs(dy) <= 1.6 &&
        now - Math.max(lastHurtByTarget, targetHurtAt, lastSwing) > 4000 && ready('standoff')) {
      const el = bridge.elevatedToward(bot, entity.position)
      if (el.drop > edges.SAFE_FALL || el.lava) {
        rest('standoff', 3000)
        pathTo(false); pathing = false
        clear()
        aim = 'free'
        let how = null
        try {
          const gM = buildGuard()
          const br = pickFiller(bot) ? await bridge.build(bot, guardCtl(gM), entity) : { ok: false, why: 'нечем мостить' }
          if (buildDone(gM, 'мост')) br.ok = false
          how = br.ok ? `мост к нему (${br.placed} бл.)` : null
          if (!br.ok) {
            const dr = await bridge.dropDown(bot, ctl, entity, { edgeGuard })
            how = dr.ok ? `спрыгнул к нему (−${dr.dmg} хп)` : `застряли на столбах: ${br.why}; ${dr.why || 'спуска нет'}`
            if (dr.ok) perch = null
          }
        } catch (e) { how = 'стояние на столбах: ' + e.message }
        aim = 'target'
        await holdWeapon()
        used(how)
        continue
      }
    }

    // Он тянет лук, а мы сейчас не стреляем — закрыться щитом (гасит стрелу
    // целиком спереди), вместо того чтобы ловить её грудью.
    if (theyBow && prof.player && guard && guard.stats && guard.stats.worn && sees && r > HIT_REACH) {
      guard.raise(true)
      if (ready('bowShieldNote')) { rest('bowShieldNote', 4000); used('щит от стрелы') }
    }
    // Его заряженный арбалет на нас (read.js): щит держит стрелу и взрыв
    // фейерверка спереди; «Пронзание» — нет, тогда только уход с линии (выше).
    if (cbShield) {
      guard.raise(true)
      if (ready('cbShieldNote')) { rest('cbShieldNote', 4000); used(`щит от заряженного арбалета (${aimedCb.ammo || '?'})`) }
    }
    // ---- 4. Далеко: догонять.
    if (d > FAR && !(noMelee && bowItem && arrowItem)) {
      // Щит от его заряженного арбалета (cbShield выше) — не опускать.
      if (guard) await guard.raise(!!cbShield)
      // На столбе не гнаться: pathfinder повёл бы вниз, прочь от регенерации.
      if (perch) { clear(); await sleep(TICK_MS); continue }
      // Начало «лук издалека» (темп): не сближаться, стрейфиться между выстрелами.
      // Арбалет со снарядами — так же (ranged.js, 2026-09-26).
      if (rangedAllowed() && now < bowFirstUntil && ((bowItem && arrowItem) || (ranged.crossbows(bot).length && (arrowItem || findItem(bot, i => i.name === 'firework_rocket')))) && !punRush) {
        if (pathing) { pathTo(false); pathing = false }
        if (now >= strafeFlipAt) { strafeKey = strafeKey === 'left' ? 'right' : 'left'; strafeFlipAt = now + 300 + Math.random() * 500 }
        set('forward', false)
        set('left', strafeKey === 'left' && stepSafe(bot, keyDir(bot, 'left')))
        set('right', strafeKey === 'right' && stepSafe(bot, keyDir(bot, 'right')))
        await sleep(TICK_MS)
        continue
      }
      // Копьё: он бежит на нас — разгон навстречу, если окно открыто (выше).
      if (!theyUp && !perch && !fort && !meInWeb && (await spearChargeFar(r, d))) continue
      // Человек с луком держит дистанцию — жемчуг к нему: 5 хп за то, чтобы
      // не бегать под стрелами (Tutorial:PvP — «pearl to close the gap»).
      const shooter = theyBow || prof.ranged
      const pearl = findItem(bot, i => i.name === 'ender_pearl')
      if (prof.player && theyBow && pearl && pearl.count >= 2 && d > 14 && d < 40 && hp > 13 && ready('pearlIn')) {
        rest('pearlIn', 8000)
        // К его ногам, с упреждением его стрейфа; переносит на тик раньше
        // точки удара — то есть чуть не долетая до него, что и нужно.
        aim = 'free'
        const r = (await holdItem(pearl))
          ? await throwMod.throwAt(bot, leadFn(0.1), {
            item: bot.heldItem,
            onAim: (res) => !!(res.land && !res.land.void && throwMod.safeLanding(bot, res.land.tp) && res.land.tp.y > bot.entity.position.y - 5)
          }).catch(() => null)
          : null
        aim = 'target'
        if (!(r && r.thrown)) await holdWeapon()
        if (r && r.thrown) {
          used('жемчуг: к лучнику')
          await sleep(800)
          await holdWeapon()
          continue
        }
      }
      const f = keyDir(bot, 'forward')
      // Его заряженный арбалет смотрит на нас (read.js; уклон выше): дальше FAR
      // бой вёл сюда — к pathfinder'у, а он клавиши уклона не слушает (hisxbow
      // 2026-09-26: бот через пустоту «шёл» к нему по несуществующему пути и
      // стоял под выстрелом). Здесь — пробег вбок, вперёд — если там есть пол.
      if (aimedCb && seesBody && d < 40) {
        if (pathing) { pathTo(false); pathing = false }
        // Вперёд — можно: ближе FAR встретит щит (hisxbow 2026-09-26: с шагом
        // вперёд 6 из 8, без него — только пробег — 4 из 8).
        const fw = stepSafe(bot, f)
        const zig = dodgeKey && now < dodgeUntil ? dodgeKey : strafeKey
        set('forward', fw); set('back', false)
        set('sprint', fw && (bot.food ?? 20) > 6)
        set('left', zig === 'left' && stepSafe(bot, keyDir(bot, 'left')))
        set('right', zig === 'right' && stepSafe(bot, keyDir(bot, 'right')))
        set('jump', false)
        if (ready('cbDodgeNote')) { rest('cbDodgeNote', 4000); used(`его арбалет на мне — пробег вбок (${aimedCb.steadyMs} мс держит прицел)`) }
        await sleep(TICK_MS)
        continue
      }
      if (shooter && seesBody && stepSafe(bot, f) && d < 30) {
        if (pathing) { pathTo(false); pathing = false }
        if (now >= strafeFlipAt) {
          strafeKey = strafeKey === 'left' ? 'right' : 'left'
          strafeFlipAt = now + 300 + Math.random() * 500
        }
        const zig = dodgeKey && now < dodgeUntil ? dodgeKey : strafeKey
        set('forward', true)
        set('sprint', (bot.food ?? 20) > 6)
        set('left', zig === 'left' && stepSafe(bot, keyDir(bot, 'left')))
        set('right', zig === 'right' && stepSafe(bot, keyDir(bot, 'right')))
        set('jump', wantsJump(bot, f) || Math.random() < 0.15)
        await sleep(TICK_MS)
        continue
      }
      if (!pathing) { pathTo(true); pathing = true; clear() }
      set('sprint', true)
      await sleep(TICK_MS)
      continue
    }
    if (pathing) { pathTo(false); pathing = false }

    // ---- 4. Приёмы на средней дистанции.

    // Снежков и яиц тут нет намеренно: в Java они по игроку не дают ни урона,
    // ни отбрасывания, ни кадров неуязвимости (minecraft.wiki «Snowball»,
    // «Egg»). Бросок стоил бы полной перезарядки меча за ноль.
    const vel = track.vel()
    const closing = (vel.x * (me.x - entity.position.x) + vel.z * (me.z - entity.position.z)) / Math.max(d, 0.1)

    // ---- Булава: взлёт на заряде ветра и удар с падения (mace.js, 2026-09-26).
    // С 6–8 блоков заряженная булава с критом по алмазу снимает 20+ хп (замер
    // probe-mace: 5 ударов из 5 убили с полного). Раз в 5 с; два промаха
    // подряд — пауза 12 с.
    // Своя лава под ним ещё стоит (pendingLava) — не взлетать: сядем в неё.
    // Сначала обездвижить: свободно бегающий уходит из-под падения (он видит
    // взлёт), а в паутине или под медлительностью — нет. Паутина под ноги
    // (вплотную) или всплеск медлительности (2.5-7 бл.) — и взлёт следующим
    // ходом (2026-09-26: «атакующий должен сделать так, чтобы второй был
    // заблокирован, чтобы ваншотнуть»).
    let smashSetup = false
    if (prof.player && !perch && !fort && !meInWeb && hp > 6 && ready('smash') && ready('smashSetup') && mace.smashPlan(bot, entity)) {
      const pinned = inWeb || busyFoe || theyEat || read.effectsOf(bot, entity).has('slowness')
      if (!pinned) {
        const webS = findItem(bot, i => i.name === 'cobweb')
        const slowS = findItem(bot, i => i.name === 'splash_potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === 'slowness')
        if (webS && r < 4.2 && foeGrounded() && ready('web')) {
          rest('web', 5000); rest('smashSetup', 2500)
          if (await placeUnder(webS, 'булава: сначала паутина под него')) { smashSetup = true; await holdWeapon(); continue }
        } else if (slowS && d > 2.5 && d < 7 && ready('debuff')) {
          rest('debuff', 1500); rest('smashSetup', 2500)
          if (await throwAt(slowS, 'булава: сначала медлительность в него')) { smashSetup = true; await holdWeapon(); continue }
        }
      }
    }
    if (!smashSetup && prof.player && !perch && !fort && !meInWeb && hp > 6 && !pendingLava.length && ready('smash')) {
      // Взлёт — ~10 тиков у земли и в подъёме: его удар или выстрел в эти тики
      // срезает подъём — в воздухе сервер оставляет в толчке свою v.y, а не нашу
      // (LivingEntity.knockback; арена 2026-09-26: «всплеск пришёл, vy 1.02,
      // скорость от сервера ×5, vy max −0.08»). Не взлетать, если он уже
      // достаёт и его удар готов (придёт в первые тики взлёта), тянет лук или
      // его заряженный арбалет смотрит на нас. «Готов за 8 тиков» было слишком
      // строго: вплотную это всегда так, и в «булава на булаву» за 4 мин не было
      // ни одного взлёта (застой); удар в 9 тиков заряда булавы — не беда: сбил
      // с земли — взлёт отменяется (mace.windSmash ждёт землю).
      const fsM = tt.foes.get(entity.id)
      const handM = entity.equipment && entity.equipment[0] ? entity.equipment[0].name : ''
      const readyM = fsM && fsM.swungAt ? Math.max(0, fsM.swungAt + tempo.swingCooldownMs(handM) - now) : 0
      // 1 против 2 (duo.js, 2026-09-26): и второй — его удар в тики взлёта тоже срежет подъём.
      const hitSoon = (theirR <= tempo.PLAYER_REACH && readyM < 2 * TICK_MS) || theyBow || !!aimedCb || (duo.active() && duo.secondThreat())
      const sp = hitSoon ? null : mace.smashPlan(bot, entity)
      if (hitSoon && ready('smashWaitNote') && mace.smashPlan(bot, entity)) { rest('smashWaitNote', 4000); used('булава: не взлетаю — его удар или выстрел собьёт взлёт') }
      if (sp) {
        rest('smash', 5000)
        if (guard) await guard.raise(false)
        clear()
        aim = 'free'
        const res = await mace.windSmash(bot, ctl, entity, {
          vel: () => track.vel(),
          stats: mc.st,
          stillOk: () => entity.isValid && Math.hypot(entity.position.x - bot.entity.position.x, entity.position.z - bot.entity.position.z) < 4.6 && !mace.shieldAtUs(bot, entity)
        })
        aim = 'target'
        if (res.swung) { st.swings++; lastSwing = gameClock.now() }
        if (res.launched && !res.hit) { st.smashMiss = (st.smashMiss || 0) + 1; if (st.smashMiss >= 2) { rest('smash', 12000); st.smashMiss = 0 } } else if (res.hit) st.smashMiss = 0
        // Отказ — с причиной (mace.windSmash: паутина на теле, блок над головой,
        // не на земле, ушёл или поднял щит) — проверка правок 2026-09-26 в арене.
        if (!res.aborted) used(res.hit ? 'булава: удар с падения' : res.launched ? 'булава: взлёт, не достал' : res.cancelled ? (res.note || 'булава: передумал взлетать') : 'булава: не взлетел' + (res.why ? ` (${res.why.split(', ')[0]})` : ''))
        // Взлёт не поднял в паутине — это то, что проверка перед взлётом должна
        // была исключить: считать отдельно.
        if (!res.launched && res.why && /в паутине/.test(res.why)) used('булава: взлёт в паутине не поднял (проверка перед взлётом пропустила)')
        // Разбор неудачного взлёта и второй заряд стоя (mace.windSmash, 2026-09-26).
        if (res.retry) used(`булава: второй заряд стоя — взлетел (первый: ${res.retry.split(', ')[0]})`)
        if (res.why && !res.launched) console.log('[mace] не взлетел:', res.why)
        // Себе больше 3 хп за взлёт (арена 2026-09-26: −9…−16) — откуда, в лог.
        if ((res.self || 0) > 3) console.log('[mace]', res.note)
        if (process.env.ND_DEBUG_PVP) console.log('[mace]', res.note)
        await holdWeapon()
        continue
      }
    }

    // Зелья вреда/яда/медлительности/слабости — в него, пока не вплотную.
    // Нежить вред лечит, а яд её не берёт (minecraft.wiki «Harming»,
    // «Poison») — ей только медлительность и слабость.
    if ((d > 2.5 || theirPit) && d < 7 && ready('debuff')) {
      // Что на нём уже висит (read.js, частицы эффектов) — второй раз не кидать.
      const effNow = read.effectsOf(bot, entity)
      // 1 против 2 (duo.js, 2026-09-26): вред — только всплеском в добиваемого
      // (duo.burst), не в кого попало на полном здоровье.
      const duoOn = prof.player && duo.active()
      const fits = i => {
        const base = (potionOf(i) || '').replace(/^(long|strong)_/, '')
        return potionRole(potionOf(i)) === 'debuff' && !(prof.undead && (base === 'harming' || base === 'poison')) && !effNow.has(base) && !(duoOn && base === 'harming')
      }
      // Начало «зелья в него» (темп): медлительность, слабость, яд — подряд;
      // вред — приберечь на миг, когда он будет есть или пить.
      const pref = splashFirst ? ['slowness', 'weakness', 'poison'].map(k => findItem(bot, i => i.name === 'splash_potion' && fits(i) && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k)).find(Boolean) : null
      if (splashFirst && !pref) splashFirst = false
      const bad = pref || findItem(bot, i => (i.name === 'splash_potion' || i.name === 'lingering_potion') && fits(i))
      if (bad) {
        rest('debuff', pref ? 400 : 1500)
        if (await throwAt(bad, 'зелье в него: ' + (potionOf(bad) || '?'))) {
          await holdWeapon()
          continue
        }
      }
    }

    // Паутина под ноги: в паутине он почти не двигается и не прыгает, а мы
    // бьём критами с края дальности.
    const web = findItem(bot, i => i.name === 'cobweb')
    // Пауков паутина не держит, а крипер в паутине всё равно взорвётся.
    if (web && !inWeb && !prof.webImmune && !prof.creeper && r < 4.2 && foeGrounded() && ready('web')) {
      rest('web', 5000)
      if (await placeUnder(web, 'паутина под него')) { await holdWeapon(); continue }
    }

    // Лава под ноги — только не вплотную (сами в неё и шагнём) и не когда он
    // уже горит. Убирается через 1.5 с (pendingLava выше).
    const lava = findItem(bot, i => i.name === 'lava_bucket')
    // Только против людей: мобу хватит меча, а лава в мире — лишний риск.
    // С огнестойкостью на нём (read.js: частицы эффектов) — не тратить.
    const fireProof = prof.player && read.effectsOf(bot, entity).has('fire_resistance')
    if (lava && prof.player && !fireProof && r > 2 && r < 4.3 && ready('lava') && dy > -1 && dy < 1.5) {
      const cell = entity.position.floored()
      if (blockName(bot, cell) === 'air' || blockName(bot, cell) === 'cobweb') {
        rest('lava', 8000)
        if (await useOnGroundAt(lava, cell, 'лава под него')) {
          pendingLava.push({ cell, at: gameClock.now() })
          await holdWeapon()
          continue
        }
      }
    }

    // Огниво — то же, но огонь гаснет сам. В спидране — только против игрока:
    // огниво — ключ от портала в Ад, а поджог свиньи на охоте стёр последнее
    // (2026-09-29 12:51: жареные отбивные, огнива нет, сборы ищут гравий).
    const flint = findItem(bot, i => i.name === 'flint_and_steel')
    // Против эндерменов поджог не помог: ферма pearls-fire-1 — 9 смертей из 9,
    // как и без огнива (pearls-fulliron-2 — 13 из 13), 0 жемчуга.
    const fireOk = prof.player || session.playPolicy?.mode !== 'speedrun'
    if (flint && fireOk && !prof.fireImmune && !fireProof && !prof.creeper && r > 1.8 && r < 4.3 && ready('fire')) {
      const cell = entity.position.floored()
      if (blockName(bot, cell) === 'air') {
        rest('fire', 6000)
        if (await useOnGroundAt(flint, cell, 'поджёг')) { await holdWeapon(); continue }
      }
    }

    // ---- 4б. Копьё (spear.js, 2026-09-26). Укол — пакетом STAB, как у ванильного
    // клиента, по лучу от 2.0 до 4.5: дальше его меча (3.0). Держать его на этом
    // краю, колоть при полном заряде, в перезарядке отходить из-под его руки;
    // разгон спринтом («использовать», ход без замедления), когда он бежит на нас
    // или стоит в 5–10 блоках: 1 + floor(отн. скорость × множитель) — по стоящему
    // алмазным 7. Ближе 1.9 укол не достаёт — «обнял», тогда 3 с ход мечу.
    // 2026-09-26: укол алмазным копьём — ~1 хп сквозь алмаз (1 + 3 = 4 урона;
    // броня 20 и прочность 8 режут до 24%, CombatRules.getDamageAfterAbsorb),
    // меч с критом — ~3. Копьё — тычок, пока он дальше руки меча (его и нашей,
    // 3.0), вплотную — меч. Смена предмета обнуляет заряд (Player.tick: другой
    // предмет в главной руке — attackStrengthTicker = 0), поэтому меняем, когда
    // это ничего не стоит: сразу после своего удара (заряд и так ноль) или когда
    // оружие в руке здесь бесполезно (укол ближе 2 не достаёт). Прежде: копьё в
    // руке всегда, меч — на 3 с, когда «обнял», и обратно копьё — каждая смена
    // съедала полный заряд (арена «копья»: укол ×92–117 за раунд, по 1 хп).
    const spearIt = prof.player && now >= spearOffUntil && !theyUp && !perch && !fort && !meInWeb ? spear.spearOf(bot) : null
    let spearTurn = !!spearIt
    if (spearIt) {
      const sName = spearIt.item.name
      const heldSpear = !!(bot.heldItem && spear.isSpear(bot.heldItem.name))
      const swordS = bestWeapon(bot)
      const sjNow = spear.jabReach(bot, entity)
      const justHit = now - lastSwing < 250
      if (heldSpear) {
        // Копьё в руке, а он ближе 2 — укол не достаёт: меч сейчас (заряд
        // копья тут бесполезен), кроме случая, когда укол готов и он ещё на луче.
        if (swordS && (sjNow.close || r < 2.1) && !(sjNow.ok && spear.readyIn(bot, sName) === 0)) {
          st.spearSwaps = (st.spearSwaps || 0) + 1
          used('копьё → меч: он ближе 2 бл., укол не достаёт')
          await holdWeapon()
          spearTurn = false
        }
      } else {
        // Меч в руке. К копью — когда он дальше руки меча, а заряд меча пуст
        // (только ударили) или всё равно не пригодится (дальше 4.2); он в руке
        // или вот-вот войдёт — бить мечом (ниже по циклу).
        const beyond = r > HIT_REACH + 0.4 && !sjNow.close
        const cheap = justHit || mf.clock.charge(0) < 0.4 || r > 4.2
        if (!swordS || (beyond && cheap)) {
          st.spearSwaps = (st.spearSwaps || 0) + 1
          if (swordS) used('меч → копьё: он дальше руки, заряд меча пуст')
          await holdItem(spearIt.item)
        } else spearTurn = false
      }
    }
    if (spearIt && spearTurn) {
      const sName = spearIt.item.name
      if (!bot.heldItem || bot.heldItem.name !== sName) await holdItem(spearIt.item)
      const sReady = spear.readyIn(bot, sName)
      const sj = spear.jabReach(bot, entity)
      const vS = track.vel()
      const towardMe = (vS.x * (me.x - entity.position.x) + vS.z * (me.z - entity.position.z)) / Math.max(d, 0.1)
      // Разгон — только когда его рамка войдёт в луч 2.0–4.5 ПОСЛЕ задержки
      // копья (spear.chargeWindow): начатый ближе проскакивал его.
      const win = spear.chargeWindow(sName, r, towardMe)
      if (win && seesBody && (bot.food ?? 20) > 6 && ready('spearCharge') && stepSafe(bot, keyDir(bot, 'forward'))) {
        rest('spearCharge', 3000)
        if (guard) await guard.raise(false)
        aim = 'free'
        const hpS = healthOf(bot, entity)
        const ch = await spear.charge(bot, ctl, entity, { maxMs: 1800, safe: k => stepSafe(bot, keyDir(bot, k)), vel: () => track.vel(), onHit: () => { st.landed++ } })
        aim = 'target'
        st.spearCharges = (st.spearCharges || 0) + 1
        if (ch.hit) st.spearChargeHits = (st.spearChargeHits || 0) + 1
        used(ch.hit ? `разгон копьём — попал (${hpS != null && healthOf(bot, entity) != null ? Math.round((hpS - healthOf(bot, entity)) * 10) / 10 : '?'} хп)` : `разгон копьём — мимо (${ch.why || 'время'})`)
        continue
      }
      // Только что укололи, а он уже в руке меча (≤ 3.0) — меч сейчас: заряд
      // копья после укола и так ноль, смена ничего не стоит.
      if (now - lastSwing < 250 && r <= HIT_REACH && bestWeapon(bot)) {
        st.spearSwaps = (st.spearSwaps || 0) + 1
        used('копьё → меч сразу после укола: он в руке меча')
        await holdWeapon()
        continue
      }
      if (sj.ok && sReady === 0 && targetHurtAt + 500 <= now) {
        if (guard) await guard.raise(false)
        aim = 'free'
        const j = await spear.jab(bot, entity)
        aim = 'target'
        if (j.ok) { st.swings++; lastSwing = gameClock.now(); used('укол копьём') }
        await sleep(TICK_MS)
        continue
      }
      // Полоса: заряжен — подойти на край укола (3.8), нет — держаться 3.4–4.3,
      // вне его меча (3.0 + пинг).
      const wantR = sReady < 250 ? 3.8 : 4.2
      const fwdS = r > wantR && stepSafe(bot, keyDir(bot, 'forward'))
      const backS = r < 3.4 && stepSafe(bot, keyDir(bot, 'back'))
      if (now >= strafeFlipAt) { strafeKey = strafeKey === 'left' ? 'right' : 'left'; strafeFlipAt = now + 350 + Math.random() * 900 }
      set('forward', fwdS)
      set('back', backS && !fwdS)
      set('left', strafeKey === 'left' && stepSafe(bot, keyDir(bot, 'left')))
      set('right', strafeKey === 'right' && stepSafe(bot, keyDir(bot, 'right')))
      set('sprint', fwdS && r > 5 && (bot.food ?? 20) > 6)
      set('jump', false)
      if (ready('spearNote')) { rest('spearNote', 5000); used('копьё: держу его на 3.4–4.5, дальше его меча') }
      await sleep(TICK_MS)
      continue
    }

    // ---- 5. Ближний бой.

    // Щит противника: топором (любой удар топором по поднятому щиту выбивает
    // его на 5 с), а без топора — не бить в щит, а обходить сбоку.
    const axe = findItem(bot, i => /_axe$/.test(i.name))

    // Движение. Смотрим на цель, поэтому клавиши = направления относительно него.
    // Удар в его кадры неуязвимости (10 тиков после любого урона) проходит
    // только разницей — копим заряд, пока окно не закроется.
    const iframes = Math.max(0, targetHurtAt + 500 - now)
    // Щит. Бить в поднятый щит спереди бесполезно, а человек ловит момент:
    // бот махнул в щит — тот опустил и ударил в откат (арена 2026-09-25).
    // Поэтому: без топора в щит спереди не машем, держимся на краю его
    // дальности, заходим сбоку, и копим заряд; как только щит опустился —
    // это он замахивается, бьём первыми полным ударом.
    if (blocking) shieldUpAt = now
    else if (shieldUpAt && !shieldDownAt) shieldDownAt = now
    if (blocking) shieldDownAt = 0
    const fYaw = entity.yaw || 0
    const fx = -Math.sin(fYaw); const fz = -Math.cos(fYaw)
    const tx = me.x - entity.position.x; const tz = me.z - entity.position.z
    const tn = Math.hypot(tx, tz) || 1
    const facingMe = (fx * tx + fz * tz) / tn > 0.2 // щит закрывает переднюю полусферу
    // Его щит поднят меньше 5 тиков назад — ещё не держит (LivingEntity.
    // getItemBlockingWith: blockDelayTicks 5, Items.SHIELD): бить сейчас
    // обычным ударом, а не топором и не в обход. Метаданные подъёма видим к
    // концу его тика — тик запаса на доставку (melee.js, 2026-09-26).
    const tState = tt.state(entity)
    const shieldFresh = blocking && !!tState.since && now - tState.since < 4 * mf.clock.msPerTick - 30
    if (shieldFresh && ready('freshShieldNote')) { rest('freshShieldNote', 3000); used('бью в окно подъёма его щита') }
    const intoShield = blocking && !axe && facingMe && !shieldFresh
    const punish = !blocking && shieldDownAt && now - shieldDownAt < 600
    if (intoShield && ready('shieldNote')) { rest('shieldNote', 5000); used('не бью в щит — жду, когда опустит') }
    if (punish && ready('punishNote')) { rest('punishNote', 3000); used('опустил щит — бью первым') }
    // Его заряд (взмах — entitySwingArm в tempo, T его оружия) и «гонка»: он
    // в своей досягаемости и уже заряжен — бить с c > 0.9 (полузамах: крит и
    // спринт-удар засчитаны, урон 88%, на тик раньше полного), кто первый.
    const hisHand = entity.equipment && entity.equipment[0] ? entity.equipment[0].name : ''
    const fsH = tt.foes.get(entity.id)
    const hisReadyMs = fsH && fsH.swungAt ? Math.max(0, fsH.swungAt + tempo.swingCooldownMs(hisHand) - now) : 0
    const race = prof.player && theirR <= tempo.PLAYER_REACH && hisReadyMs <= TICK_MS
    const cdHit = race ? mf.clock.leftMs(0.91) : cooldownLeft
    const canHit = cdHit === 0 && iframes === 0 && r <= HIT_REACH && !intoShield && inSight
    let forward = false
    let back = false
    let strafe = null
    let sprint = false

    if (now >= strafeFlipAt) {
      strafeKey = strafeKey === 'left' ? 'right' : 'left'
      strafeFlipAt = now + 350 + Math.random() * 900
    }

    // Его щит выбит (read.js: звук item.shield.break у него, 100 тиков кулдауна
    // BlocksAttacks.disable) — закрыться ему нечем: давить, не отходить.
    const shieldBroken = prof.player && foe.shieldOff(entity) > 300
    if (shieldBroken && ready('shieldOffNote')) { rest('shieldOffNote', 5000); used('его щит выбит — давлю') }
    const vulnerable = inWeb || theyEat || theyBow || (blocking && axe) || punRush || shieldBroken
    // Рывок: он ест или пьёт на виду — спринтом к нему, пока жуёт (1.6 с).
    // Темп: наказание занятого и рывок начала боя — без броска кубика.
    const rush = (after('rush', theyEat && seesBody && r > HIT_REACH - 0.3) && roll('rush', theyEat, style.aggression)) ||
      ((punRush || now < rushUntil) && r > HIT_REACH - 0.3)
    if (cooldownLeft <= 150) {
      // Готов бить — сближаемся до края дальности.
      if (r > HIT_REACH - 0.15) { forward = true; sprint = !jumpedForCrit }
    } else if (!vulnerable && !punStep && theirR < prof.theirReach + (prof.player ? 0.2 : REACH_MARGIN) && cooldownLeft > 250) {
      // (punStep, темп: он только что махнул — его удар ещё не заряжен, не пятиться.)
      // Перезарядка: выйти из-под его руки — с запасом, а не когда он уже
      // замахнулся: за тик он проходит 0.2-0.3 блока, а мы узнаём о нём с
      // опозданием на тик-два.
      back = true
    } else if (vulnerable && r > HIT_REACH - 0.3) {
      forward = true
    }
    if (rush) {
      forward = true
      sprint = true
      if (ready('rush')) { rest('rush', 2500); used(now < rushUntil ? 'рывок со спринт-ударом' : punRush ? 'рывок на занятого' : 'рывок, пока он ест') }
    }
    // Он на столбе — не упираться в столб: стоять в 2-3 блоках и ждать,
    // когда спрыгнет (упадёт — бьём критом, пока он приходит в себя).
    if (theyUp) {
      forward = d > 3.2
      back = d < 1.8
      if (ready('waitUp')) { rest('waitUp', 4000); used('он на столбе — жду внизу') }
    }
    // После удара по криперу — отойти, не дожидаясь, пока зашипит.
    if (now < backOffUntil) { forward = false; back = true }
    strafe = strafeKey

    // Крипер шипит: ~1.5 с до взрыва, и он гаснет, если отойти дальше ~7.
    // Разворот и спринт прочь — пятиться слишком медленно.
    // Куда — не «строго от него», а туда, где свободно: прочь от крипера по
    // прямой упиралось в стекло арены, и бот долбился в стену, пока тот
    // взрывался. Направление выбирает побег (flee.pickDirection) — по всем
    // врагам, стенам, обрывам и лаве, раз в 300 мс.
    if (prof.creeper && creeperSwelling(bot, entity) && d < 6.5) {
      if (!swellPlan || now >= swellPlanAt) {
        swellPlan = flee.pickDirection(bot, flee.hostilesAround(bot, 24), swellPlan ? swellPlan.yaw : null)
        swellPlanAt = now + 300
      }
      aim = 'free'
      if (swellPlan) await bot.look(swellPlan.yaw, 0, true).catch(() => {})
      if (guard) await guard.raise(false)
      const f = keyDir(bot, 'forward')
      set('back', false); set('left', false); set('right', false)
      set('forward', !!swellPlan && stepSafe(bot, f))
      set('sprint', (bot.food ?? 20) > 6)
      set('jump', wantsJump(bot, f))
      if (!fleeingSwell) { used('убегаю от шипящего крипера'); fleeingSwell = true }
      await sleep(TICK_MS)
      continue
    }
    fleeingSwell = false
    swellPlan = null
    if (aim === 'away' || aim === 'free') aim = 'target'
    if (blocking && !axe) {
      // Обход щита: на краю его досягаемости и вбок, в лоб не лезть.
      forward = r > 3.4
      back = r < 2.6
      if (!strafe) strafe = strafeKey || 'left'
    }
    // Он только что опустил щит — шаг вперёд, чтобы удар долетел первым.
    if (punish && r > HIT_REACH - 0.3) { forward = true; back = false }
    if (dodgeKey && now < dodgeUntil) { strafe = dodgeKey; back = false }
    // Человек (showman.js): фаза боя, финт на краю его руки и наказание его
    // промаха, отход-сброс — поверх решения выше; край, ямы и шаги — ниже, удар
    // (canHit) — как был.
    if (hm && prof.player && !theyUp) {
      ({ forward, back, strafe, sprint } = hm.steer({ forward, back, strafe, sprint }, {
        r, theirR, d, hp, theirHp, cooldownLeft, blocking, vulnerable, rush,
        dodging: !!(dodgeKey && now < dodgeUntil), flank: blocking && !axe, press: pressing
      }))
    }
    // 1 против 2 (duo.js): клещи — наружу; иначе к клетке, где оба спереди,
    // ближний закрывает дальнего, спина к стене без обрыва. Края и шаги — ниже.
    if (prof.player && !theyUp && duo.active()) ({ forward, back, strafe, sprint } = duo.steer({ forward, back, strafe, sprint }, { entity, r, cooldownLeft }))

    // Столкнуть в яму или лаву — по его полёту после нашего удара (edges.
    // pushPlan: та же физика, числа из игры — толчок 0.4 от любого удара, даже
    // незаряженного, +0.5 за спринт при полном заряде; просьба 2026-09-25
    // «скинуть в дырку, если видит, что рядом, и сразу бить»). Выйдет отсюда —
    // бить сейчас; выйдет с другой стороны — обойти его туда, по дуге.
    let pushing = false
    let edgeHit = null
    if (!theirPit && !myPit && d < 6 && now >= pushAt) {
      pushAt = now + 250
      try { push = edges.pushPlan(bot, entity, { vel: track.vel() }) } catch { push = null }
    }
    if (push && d < 6 && !theirPit && !myPit) {
      if (push.now) {
        pushing = true
        edgeHit = push.now
        back = false
        if (r > HIT_REACH - 0.15 || (push.now === 'sprint' && cooldownLeft <= 150)) forward = true
        if (push.now === 'sprint' && cooldownLeft <= 150) sprint = true
        if (ready('pushNote')) { rest('pushNote', 3000); used(push.now === 'hit' ? 'он у края — бью сразу' : 'толкаю его в яму спринт-ударом') }
      } else if (push.stand) {
        pushing = true
        const px = push.stand.x - me.x
        const pz = push.stand.z - me.z
        const yaw = bot.entity.yaw
        const fwd = px * -Math.sin(yaw) + pz * -Math.cos(yaw)
        const right = px * Math.cos(yaw) + pz * -Math.sin(yaw)
        if (Math.abs(right) > 0.3) strafe = right > 0 ? 'right' : 'left'
        if (fwd > 0.5 && cooldownLeft <= 150) forward = true
        else if (fwd < -0.5) { back = true; forward = false }
        if (ready('pushNote')) { rest('pushNote', 3000); used('захожу, чтобы столкнуть') }
      }
    }
    // Старое правило (ближайшая яма в паре блоков за ним) — если физика
    // ничего не нашла.
    const hz = !pushing && !theirPit && !myPit ? hazards.nearest(nearFoe, entity.position) : null
    if (hz && hz.d >= 0.6 && hz.d <= 2.8 && !fleeingSwell) {
      const hx = hz.pos.x + 0.5 - entity.position.x
      const hzz = hz.pos.z + 0.5 - entity.position.z
      const hn = Math.hypot(hx, hzz) || 1
      const fx = entity.position.x - me.x
      const fz = entity.position.z - me.z
      const fn = Math.hypot(fx, fz) || 1
      const cos = (fx * hx + fz * hzz) / (fn * hn)
      if (cos > 0.8) {
        pushing = true
        if (cooldownLeft <= 150) { forward = true; sprint = true; back = false }
        if (ready('pushNote')) { rest('pushNote', 4000); used(`толкаю его в ${hz.kind === 'лава' ? 'лаву' : hz.kind === 'паутина' ? 'паутину' : 'яму'}`) }
      } else {
        // Обойти: точка за ним на линии «опасность → он», в 2.4 блока.
        const px = entity.position.x - hx / hn * 2.4 - me.x
        const pz = entity.position.z - hzz / hn * 2.4 - me.z
        const yaw = bot.entity.yaw
        const fwd = px * -Math.sin(yaw) + pz * -Math.cos(yaw)
        const right = px * Math.cos(yaw) + pz * -Math.sin(yaw)
        if (Math.abs(right) > 0.4) strafe = right > 0 ? 'right' : 'left'
        if (fwd > 0.6 && cooldownLeft <= 150) forward = true
        if (ready('pushNote')) { rest('pushNote', 4000); used('захожу, чтобы столкнуть') }
      }
    }
    // Самому не стоять спиной к лаве или яме: опасность сзади (по линии «он →
    // мы») ближе двух блоков — не пятиться, уходить вбок.
    const behind = nearMe.find(h => {
      const bx = h.pos.x + 0.5 - me.x
      const bz = h.pos.z + 0.5 - me.z
      const bd = Math.hypot(bx, bz)
      if (bd > 2.2) return false
      const ax = me.x - entity.position.x
      const az = me.z - entity.position.z
      return (bx * ax + bz * az) / ((Math.hypot(ax, az) || 1) * (bd || 1)) > 0.5
    })
    if (behind && !pushing) {
      back = false
      const yaw = bot.entity.yaw
      const right = (behind.pos.x + 0.5 - me.x) * Math.cos(yaw) + (behind.pos.z + 0.5 - me.z) * -Math.sin(yaw)
      strafe = right > 0 ? 'left' : 'right'
      if (ready('backNote')) { rest('backNote', 4000); used(`не стою спиной к ${behind.kind === 'лава' ? 'лаве' : behind.kind === 'паутина' ? 'паутине' : 'яме'}`) }
    }
    // И дальше двух блоков: его спринт-удар (0.4 + 0.5) кидает на 3-4 блока,
    // и если он кинет нас в яму даже со встречным «вперёд» в полёте
    // (edges.backToDrop, та же физика) — уйти с линии вбок, туда, где от края
    // дальше, и не пятиться.
    if (!pushing && theirR < 5.5) {
      if (now >= backAt) { backAt = now + 200; try { behindDrop = edges.backToDrop(bot, entity.position, { kb: entity.equipment && entity.equipment[0] ? read.enchLevel(bot, entity.equipment[0], 'knockback') : 0 }) } catch { behindDrop = null } }
    } else behindDrop = null
    if (behindDrop) {
      back = false
      const side = ['left', 'right'].map(k => { const v = keyDir(bot, k); return { k, c: edges.clearance(bot, me.offset(v.x * 1.2, 0, v.z * 1.2), 2.5) } })
      strafe = side[0].c >= side[1].c ? side[0].k : side[1].k
      if (ready('backNote')) { rest('backNote', 4000); used('не стою спиной к яме (его удар кинул бы)') }
    }
    // В его яму за ним не прыгать.
    const intoHazard = (k) => {
      const dir = keyDir(bot, k)
      const c = me.offset(dir.x * 0.9, -1, dir.z * 0.9).floored()
      return nearMe.some(h => h.pos.x === c.x && h.pos.z === c.z)
    }
    const wantFwd = forward
    if (forward && intoHazard('forward')) forward = false
    if (strafe && intoHazard(strafe)) strafe = null

    // Безопасность каждого шага.
    if (forward && !stepSafe(bot, keyDir(bot, 'forward'))) forward = false
    // Хотел к нему, а шаг — в лаву, огонь или яму: дольше 1.2 с — чинить путь
    // (unblockPath), не вышло — обход pathfinder'ом; пока путь перекрыт, лук
    // и арбалет стреляют и по броне, которую стрелы почти не берут.
    if (prof.player && wantFwd && !forward && r > HIT_REACH + 0.3 && !perch && !fort) { if (!st.blockedSince) st.blockedSince = now } else if (forward || !wantFwd) st.blockedSince = 0
    if (st.blockedSince && now - st.blockedSince > 1200 && ready('unblock')) {
      rest('unblock', 1500)
      if (await unblockPath()) { st.unblocks = (st.unblocks || 0) + 1; continue }
      if (ready('detourNote')) { rest('detourNote', 4000); used('путь к нему перекрыт — обхожу') }
      repositionUntil = now + 3000
    }
    if (back && !stepSafe(bot, keyDir(bot, 'back'))) back = false
    if (strafe && !stepSafe(bot, keyDir(bot, strafe))) {
      strafeKey = strafe === 'left' ? 'right' : 'left'
      strafe = stepSafe(bot, keyDir(bot, strafeKey)) ? strafeKey : null
    }

    // Крит или спринт-удар. Крит (+50%) — когда размениваемся вплотную или
    // он беззащитен (в паутине, ест, тянет лук). Спринт-удар с W-tap — когда
    // он бежит на нас: отбрасывание выносит его из дальности раньше, чем он
    // зарядится, и ответа не будет (minecraft.wiki «Tutorial:PvP»).
    // Прыжок за ~300 мс до готовности: вершина на 6-м тике, окно крита 7-11.
    // Без спринта — со спринтом крит не засчитывается. Из паутины крита нет.
    // Бежит на нас — рывок издалека, не колебание сближения в размене
    // вплотную (с «> 0.15 и d > 2.5» спринт-удар выбирался в 90% замахов,
    // критов не было вовсе; арена 2026-09-26).
    const charging = closing > 0.2 && d > 4
    // Крипера — тоже критом в прыжке (+50%: два удара вместо трёх железным
    // мечом), а сразу после удара — отход (backOffUntil ниже), чтобы не
    // стоять рядом, когда он зашипит.
    // Выбор удара — раз на замах (melee.choose, 2026-09-26): спринт-удар, где
    // решает отброс (первый удар и рывок начала, толчок к краю, он бежит на
    // нас, я слабее, серия), крит, где решает урон (он беззащитен, крипер), и
    // по характеру в остальном. Раньше крит брался в 70% без разбора, а спринт
    // снимался в досягаемости — спринт-ударов было 0–5 за раунд.
    // Выбор — к концу своей перезарядки (за 8 тиков): прыжок за критом
    // начинается за ~6 тиков до готовности, и решать надо по тому, готов ли к
    // этому времени его удар, а не по тому, что было сразу после нашего.
    if ((!hitKind && cooldownLeft < 8 * mf.clock.msPerTick) || edgeHit === 'sprint') {
      const myHp = hp + totemMod.absorption(bot)
      hitKind = edgeHit === 'sprint' ? 'sprint' : mf.choose({
        // Паутина в любой клетке рамки (prismarine isInWeb), не только в ногах:
        // в ней крита нет — Entity.makeStuckInBlock обнуляет падение (арена
        // 2026-09-26: «паутина» — первая причина промаха крита, 6 из 29).
        meInWeb: meInWeb || !!bot.entity.isInWeb,
        creeper: prof.creeper,
        defenseless: inWeb || theyEat || theyBow,
        first: !firstHitDone,
        charging,
        hisReadyMs: prof.player ? hisReadyMs : null,
        myReadyMs: cooldownLeft,
        // Он достаёт (или войдёт в руку за тик-два) — его готовый удар придёт
        // раньше нашего спуска (melee.choose, 2026-09-26).
        // Вплотную (≤ 2.2) крит достаёт и после его удара: в воздухе его толчок
        // даёт ~0.25 б/т от него (LivingEntity.knockback: v/2 − 0.4), за 3–4 тика
        // спуска — меньше блока. Гонка с краю руки (2.2–3.0) — спринт-удар.
        close: prof.player && r > 2.2 && theirR <= tempo.PLAYER_REACH + Math.max(0, closing) * 2,
        weaker: prof.player && theirHp != null && myHp + 4 < theirHp,
        comboOn: now - lastHurtByTarget > 1500 && now - lastSwing < 1500
      })
    }
    // Крит выбран раньше, а к прыжку видно «гонку»: он достаёт, и его удар
    // будет готов раньше, чем наш крит упадёт (через тик-два после нашей
    // готовности) — прыжок отдаст ему первый удар, а ударить придётся на
    // подъёме, без крита (замер 2026-09-26: 27 из 36 промахов крита — удар на
    // подъёме в гонке). С земли — спринт-удар (первый удар с отбросом). Вплотную
    // (≤ 2.2) — прыгать: крит достанет и после его удара (см. close выше).
    if (hitKind === 'crit' && bot.entity.onGround && prof.player && theirR <= tempo.PLAYER_REACH + 0.3 &&
        r > 2.2 && hisReadyMs <= cooldownLeft + 2 * mf.clock.msPerTick && !(inWeb || theyEat || theyBow)) {
      hitKind = (bot.food ?? 20) > 6 ? 'sprint' : 'plain'
      if (ready('raceNote')) { rest('raceNote', 4000); used('гонка — без прыжка за критом, спринт-удар') }
    }
    // FIX: у ямы по линии его толчка — без прыжка за критом: его удар в
    // прыжке (спринт — 4–5 бл., edges.dropAlong) унесёт в неё; спринт-удар с земли.
    if (FIX && hitKind === 'crit' && bot.entity.onGround && prof.player && d < 6) {
      if (now >= jumpDropAt) { jumpDropAt = now + 200; try { jumpDrop = edges.dropAlong(bot, entity.position, 4.5) } catch { jumpDrop = false } }
      if (jumpDrop) {
        hitKind = (bot.food ?? 20) > 6 ? 'sprint' : 'plain'
        if (ready('dropCritNote')) { rest('dropCritNote', 4000); used('у ямы — без прыжка за критом') }
      }
    }
    const wantCrit = hitKind === 'crit' && !blocking && !meInWeb && !bot.entity.isInWeb
    const wantSprintHit = hitKind === 'sprint' && !meInWeb && (bot.food ?? 20) > 6
    if (bot.entity.onGround) jumpedForCrit = false
    let jump = false
    if (wantCrit && bot.entity.onGround && cooldownLeft < 320 && r < HIT_REACH + 0.9 && !meInWeb) {
      jump = true
      jumpedForCrit = true
      // «Спринт-крит»: наш спринт-удар уже снял спринт на сервере, START не
      // слали — клавишу не отпускать: крит засчитается (Player.canCritical-
      // Attack смотрит isSprinting() сервера), а бежим со скоростью спринта.
      sprint = sprint && !mf.clock.srvSprint
    }
    // Спринт-удар: «вперёд» и спринт держать до самого удара и в досягаемости
    // (раньше спринт снимался на r ≤ 2.75, и удар уходил без него). Сервер
    // считает, что не бежим (наш прошлый спринт-удар), — перевзвести: тик без
    // спринта, потом START (melee.rearm).
    if (wantSprintHit && cooldownLeft <= 150 && !back && r < HIT_REACH + 1.5 && !intoHazard('forward') && stepSafe(bot, keyDir(bot, 'forward'))) {
      forward = true
      sprint = true
      if (!mf.clock.srvSprint && bot.getControlState('sprint') && !mf.planning()) mf.rearm()
    }
    // Копьё у него (read.spearIn, 2026-09-26): укол бьёт по лучу от 2.0 до 4.5
    // (AttackRange копья) — ближе ~1.9 не достаёт. Не отходить в перезарядке на
    // его луч, а прилипнуть (замер try-spear: с 1.4 бл. укол мимо).
    if (prof.player && read.spearIn(entity) && theirR < 5 && !pushing) {
      back = false
      if (r > 1.3 && !intoHazard('forward') && stepSafe(bot, keyDir(bot, 'forward'))) forward = true
      if (ready('spearHugNote')) { rest('spearHugNote', 4000); used('у него копьё — прилипаю ближе 2 блоков') }
    }
    const moveDir = forward ? 'forward' : back ? 'back' : strafe
    if (moveDir && wantsJump(bot, keyDir(bot, moveDir))) jump = true
    // Прыжок с разбега летит дальше, чем шаг, который проверял stepSafe (0.9):
    // крит в погоне за овцой у обрыва унёс бота с высоты 81 на 59 — 2 хп из 20
    // (кампания 2026-09-25). Куда приземлимся — проверить на 1.8 (шагом) и 2.6
    // (спринтом); опасно — крит на месте, без хода.
    if (jump && moveDir && jumpedForCrit) {
      const far = sprint ? 2.6 : 1.8
      if (!stepSafeRaw(bot, keyDir(bot, moveDir), { water: onFire(bot), reach: far }) ||
          !stepSafeRaw(bot, keyDir(bot, moveDir), { water: onFire(bot), reach: far / 2 + 0.45 })) {
        forward = false; back = false; strafe = null; sprint = false
      }
    }

    if (floorEscape && gameClock.now() < floorEscape.until) {
      let best = null; let bd = -2
      for (const k of ['forward', 'back', 'left', 'right']) {
        const v = keyDir(bot, k); const dot = v.x * floorEscape.dir.x + v.z * floorEscape.dir.z
        if (dot > bd) { bd = dot; best = k }
      }
      forward = best === 'forward'; back = best === 'back'; strafe = best === 'left' || best === 'right' ? best : null
      sprint = forward; jump = false
    }
    // Своя же паутина: цель ушла из неё, а бот шагал следом прямо в неё
    // (пользователь 2026-09-25: «сам себе ловушку делает»). Шаг в клетку с
    // паутиной у ног или головы — отменить, пока сами не в паутине.
    if (!meInWeb) {
      const webAhead = (key) => {
        const v = keyDir(bot, key)
        for (const k of [0.6, 1.1]) {
          const c = me.offset(v.x * k, 0, v.z * k).floored()
          if (blockName(bot, c) === 'cobweb' || blockName(bot, c.offset(0, 1, 0)) === 'cobweb') return true
        }
        return false
      }
      if (forward && webAhead('forward')) {
        forward = false; sprint = false
        if (!strafe) strafe = webAhead('left') ? 'right' : 'left'
        if (ready('webAvoidNote')) { rest('webAvoidNote', 4000); used('обхожу свою паутину') }
      }
      if (back && webAhead('back')) back = false
      if (strafe && webAhead(strafe)) strafe = null
    }
    // Крит ждёт спуска в воздухе — START спринта не слать (2026-09-26): сервер
    // тогда «бежит», и крита нет (Player.canCriticalAttack: !isSprinting()
    // сервера). Бежим без START после своего спринт-удара («спринт-крит») —
    // клавишу не трогать; сервер «бежит» — STOP.
    if (hitKind === 'crit' && !bot.entity.onGround && !meInWeb) sprint = sprint && bot.getControlState('sprint') && !mf.clock.srvSprint
    // Тиковый план (W-tap, S-tap, jump-reset, перевзвод — melee.js) — поверх:
    // цикл не должен перескочить через отпущенный на тик «вперёд».
    const kk = mf.override({ forward, back, left: strafe === 'left', right: strafe === 'right', sprint: sprint && (bot.food ?? 20) > 6, jump })
    set('forward', kk.forward)
    set('back', kk.back)
    set('left', kk.left)
    set('right', kk.right)
    set('sprint', kk.sprint)
    set('jump', kk.jump)

    // Щит по таймингу (melee.shield, 2026-09-26): поднять за ≥ 5 тиков
    // (blockDelayTicks) до того, как его удар может прийти — он в досягаемости
    // или войдёт в неё и его заряд будет готов; опустить, когда бьём сами или
    // удара не будет: поднятый щит — это ×0.2 хода (itemuse.js) и ни одного
    // своего удара. Раньше щит поднимался на всю нашу перезарядку. Против
    // топора — не поднимать (выбьет на 5 с).
    const theirHand = hisHand
    const offShield = bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield'
    if (guard && guard.stats && guard.stats.worn && offShield) {
      const adv = mf.shield({ theirR, closing, hisReadyMs, hisHand: theirHand, myLeftMs: cdHit, inMyReach: r <= HIT_REACH })
      if (adv === 'raise') guard.raise(true)
      // Его заряженный арбалет на нас (cbShield выше, read.js) — щит не опускать.
      else if (adv === 'lower' && !cbShield) await guard.raise(false)
    }

    // Удар. Он у края, и хватит обычного толчка (0.4 не зависит от заряда) —
    // бить, как только кончились его кадры неуязвимости, не дожидаясь заряда.
    const edgeSpam = edgeHit === 'hit' && iframes === 0 && r <= HIT_REACH && !intoShield && inSight && cooldownLeft > 0
    if (edgeSpam && ready('edgeSpamNote')) { rest('edgeSpamNote', 3000); used('бью у края, не дожидаясь заряда') }
    // Hit-select (Tutorial:PvP; PVP-RESEARCH в.4): он заряжен, лезет на нас и
    // уже достаёт — первым не бить до 3 тиков: его удар придёт, и ответный
    // (mf.setCounter) уйдёт в тот же тик, с нашим ×0.6 против его толчка, а
    // он получит наш целиком. Не ударил за 3 тика — бьём сами.
    const selectWait = prof.player && race && closing > 0.1 && !pushing && theirR < 3.0 && mf.skill.counter > 0.7
    if (selectWait) { if (!selectSince) selectSince = now } else selectSince = 0
    const holdForSelect = selectWait && now - selectSince < 3 * mf.clock.msPerTick
    if (holdForSelect && ready('selectNote')) { rest('selectNote', 4000); used('жду его удара, чтобы ответить (hit-select)') }
    if ((canHit && !holdForSelect) || edgeSpam) {
      // Падаем — по последнему пакету позиции, а не по скорости (melee.critNow:
      // на вершине скорость уже вниз, а сдвиг ещё вверх — сервер крит не
      // даёт). Прыгнули ради крита и ещё не падаем — подождать, это считанные
      // тики; ждать нельзя, только если его удар уже заряжен и он достаёт.
      const falling = mf.clock.critNow()
      const rising = !bot.entity.onGround && !falling
      // Ждать спуска — в любом подъёме, не только после своего прыжка за
      // критом (2026-09-26): его удар подкинул (0.4 вверх — P-crit), jump-reset,
      // прыжок через блок. Арена «железо» (3 раунда): 12 критов из 38 выборов
      // крита, 24 промаха — удар на подъёме. Сколько ждать — по своей скорости
      // (тики до шага вниз); дольше 7 тиков или «гонка» вплотную — бить сейчас,
      // но до спуска тик-два — ждать и в гонке: ×1.5 за 100 мс.
      const upTicks = rising ? ticksToFall(bot.entity.velocity.y) : 0
      const critWait = rising && !edgeSpam && (jumpedForCrit || (hitKind === 'crit' && CRIT_ANY_RISE)) &&
        upTicks <= 7 && !(race && theirR <= 2.6 && upTicks > 2 && r > 2.2) && !bot.entity.isInWater && !meInWeb
      if (critWait && !jumpedForCrit && ready('pcritNote')) { rest('pcritNote', 4000); used('жду спуска для крита (подбросило)') }
      if (!critWait) {
        // Топор по поднятому щиту — сменой слота в том же тике, что и удар
        // (melee.hit; PVP-RESEARCH б.3): щит выключен на 100 тиков (замер
        // try-swap.js на Paper: set_cooldown minecraft:shield 100). На ванильном
        // сервере (мир по LAN) заряд и урон остаются от меча; Paper с
        // update-equipment-on-player-actions заряд обнуляет — там это просто
        // быстрая смена, не хуже прежней (melee.FAST_AXE). Топора нет в хотбаре
        // и не положить, или ND_FAST_AXE=0 — старая смена через equip.
        let swungWith = weapon
        let swapTo = -1
        if (blocking && !shieldFresh && axe && weapon && weapon.name !== axe.name) {
          if (melee.FAST_AXE) {
            swapTo = melee.axeSlot(bot)
            if (swapTo < 0 && (await mace.ensureHotbar(bot, [axe.name]))) swapTo = melee.axeSlot(bot)
          }
          if (swapTo < 0 && (await holdItem(axe))) swungWith = axe
        }
        if (guard) await guard.raise(false)
        // Предмет в ходу (щит, еда) — удара нет: клик атаки ванильный клиент
        // в этот тик съедает (Minecraft.handleKeybinds, пока isUsingItem);
        // отпустили меньше тика назад — удар на следующем проходе.
        const use = bot._ndUse
        if (!(use && (use.cur || gameClock.now() - (use.endedAt || 0) < mf.clock.msPerTick))) {
          const sprintHit = mf.clock.srvSprint && mf.clock.charge(0) > 0.9
          swingCrit = falling && !mf.clock.srvSprint
          // После спринт-удара — W-tap (тик без «вперёд» и START: следующий
          // спринт-удар снова с отбросом) или S-tap, если он лезет на нас.
          const after = sprintHit ? (closing > 0.1 && theirR < 3.2 && !pushing ? 'stap' : 'wtap') : null
          mf.hit(entity, { swapTo, after, kind: hitKind, diag: { jumped: jumpedForCrit, race: race && theirR <= 2.6 } })
          st.swings++
          punches = 0
          rushUntil = 0
          firstHitDone = true
          hitKind = null
          lastSwing = gameClock.now()
          nextReady = lastSwing + cooldownMs(swungWith)
          if (sprintHit) st.sprintHits++
          if (blocking && !shieldFresh && (swapTo >= 0 || (swungWith && /_axe$/.test(swungWith.name)))) st.axeOnShield++
          if (swungWith !== weapon) await holdWeapon()
          if (prof.creeper) backOffUntil = gameClock.now() + 700
        }
      }
    }

    await sleep(TICK_MS)
  }
  return finish({ aborted: true })
}

module.exports = { duel, cooldownMs, potionOf, potionRole, reachFrom, stepSafe, keyDir, profileOf, FOES }

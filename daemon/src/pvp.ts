'use strict'
const gameClock = require('./game-clock')
// Все числа механики — Java 1.21 (minecraft.wiki, «Damage», «Attack cooldown»,

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
const edges = require('./edges')
const { raySees, thundering } = require('./perception')
const assess = require('./assess')
const arrows = require('./arrows')
const tempo = require('./tempo')
const melee = require('./melee')
const totemMod = require('./totem')
const bridge = require('./bridge')
const mace = require('./mace')
const showman = require('./showman')
const read = require('./read')
const ranged = require('./ranged')
const { canUseRanged } = require('./play-policy')
// Копьё 1.21.11 (2026-09-26): укол STAB по лучу 2.0–4.5, разгон спринтом.
const spear = require('./spear')
const duoMod = require('./duo')
const utilityMod = require('./utility')
const elytra = require('./elytra')
const boom = require('./boom')
const crystal = require('./crystal')
const { counterattackAfterFailedEscape } = require('./pvp/last-stand')
const { foodAnimals, foodIgnitionAllowed } = require('./pvp/food-fire')

const TICK_MS = 50
const HIT_REACH = 2.9
const THEIR_REACH = 3.4
const FAR = 7
const EYE = 1.62
const COVER_MS = 500
const COVER_WIDE_MS = 1500
const REACH_MARGIN = 0.7
const CRIT_ANY_RISE = process.env.ND_CRIT_ANY_RISE !== '0'
const FIX = process.env.ND_FIGHTFIX !== '0'
const BOX_MS = 2500
const BOX_FRONT_MS = 1300
const PILLAR_MS = 400
function ticksToFall (vy) {
  let n = 1
  let v = vy
  while (v >= -1e-3 && n < 30) { v = (v - 0.08) * 0.98; n++ }
  return n
}

const LAG_MS = 50
function cooldownMs (item) {
  return baseCooldownMs(item) + LAG_MS
}
function baseCooldownMs (item) {
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
  const s = JSON.stringify(d)
  const hit = POTIONS.slice().sort((a, b) => b.length - a.length).find(p => s.includes(p))
  return hit || null
}

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

function countOf (bot, name) {
  return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
}

function findPotion (bot, kind, role) {
  return findItem(bot, i => i.name === kind && potionRole(potionOf(i)) === role)
}

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
  return require('./fightkit').hasEffect(bot, name)
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

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

function stepSafe (bot, dir) {
  return stepSafeRaw(bot, dir, { water: onFire(bot) || !!(bot.entity && bot.entity.isInWater) })
}
function makeTracker (entity) {
  return require('./bow').trackTarget(entity)
}

function yawTo (from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

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

const FOES = new Set([...Object.keys(MOB_REACH), 'blaze', 'ghast', 'pillager', 'evoker', 'vex', 'breeze',
  'guardian', 'phantom', 'warden', 'shulker', 'piglin', 'creaking'])
function nextFoe (bot, radius, dead = null) {
  const me = bot.entity.position
  return bot.nearestEntity(e => e && e.position && FOES.has(e.name) && e.name !== 'iron_golem' &&
    e.position.distanceTo(me) < radius && e.isValid !== false && !(dead && dead.has(e.id)) && !lookDead(bot, e) &&
    assess.inSight(bot, e)) || null
}

function healthOf (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' ? h + read.absorptionOf(bot, e) : null
  } catch { return null }
}

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

const HOSTILE_MOB = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|bogged|wither_skeleton|spider|cave_spider|creeper|witch|slime|magma_cube|silverfish|endermite|phantom|pillager|vindicator|evoker|vex|ravager|piglin_brute|hoglin|zoglin|blaze|breeze|guardian|shulker)$/
const ANGRY_IF_HIT = /^(enderman|zombified_piglin|piglin|polar_bear|wolf|bee)$/

async function duel (session, ctl, entity, opts: any = {}) {
  const safety = opts.guard?.safety || require('./combat-safety').watch(session.bot)
  try { return await duelBody(session, ctl, entity, { ...opts, safety }) } finally {
    if (!opts.guard?.safety) safety.close()
  }
}

async function duelBody (session, ctl, entity, opts: any = {}) {
  const rangedAllowed = () => canUseRanged(session, entity, opts)
  const bot = session.bot
  let lastStand = opts.lastStand === true || opts.repelLava === true
  const foodFire = { attempts: 0, ignited: 0, burningObserved: 0 }
  const burningFood = new Set<number>()
  const fireTerrainSafe = (cell) => {
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 4; dy++) {
      const block = bot.blockAt(cell.offset(dx, dy, dz))
      if (!block || /_log$|_wood$|_planks$|_leaves$|_wool$|_carpet$|_fence$|_stairs$|_slab$|chest|barrel|bookshelf|hay_block|bamboo|vine/.test(block.name)) return false
    }
    return true
  }
  const {
    retreatAtHealth = 4,
    timeoutSeconds = 60,
    guard = null,
    calmAfterMs = 0,
    healAt = 10,
    clearArea = 0,
    arena = null
  } = opts
  let label = entity.username || entity.name
  const deadline = gameClock.now() + Math.min(300, timeoutSeconds) * 1000
  let track = makeTracker(entity)
  let prof = profileOf(entity)
  const kills = []
  let backOffUntil = 0
  let splashAt = -1e9
  let fleeingSwell = false
  let swellPlan = null
  let swellPlanAt = 0
  let seenAt = gameClock.now()
  let unseen = false
  let repositionUntil = 0
  let stuckTicks = 0
  // Копьё на изготовку против тарана с элитр (s7b): встречный разгон — отн. скорость = его скорость к нам.
  let bracing = 0
  // Прыжки в бою (s7b 06.10, API S6 navigation/parkour.combatHop): упёрся, он на уступе, или идём к нему (путь), а
  // 2.5 с дистанция > 5 не сокращается — короткий прыжок на видимую опору ближе к нему, без урона от падения.
  // Не в ближнем «держу дистанцию» (копьё 3.4–4.5: s7e — 17 попыток за раунд). ND_PVP_HOP=0 — выкл.
  const HOP = process.env.ND_PVP_HOP !== '0'
  let hopD = Infinity
  let hopDAt = gameClock.now()

  const st: any = {
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
  const traceT0 = gameClock.now()
  // Урон приёмов (аудит комбо, 2026-10-06): падение его хп (с поглощением) —
  // последнему приёму не старше 1.5 с, иначе «прочее». Оценка: лечение между
  // тиками и тотем её занижают.
  st.trickDmg = {}
  // Хп противника-игрока в решениях — только оценкой (правило пользователя 06.10, боевой калькулятор:
  // pvp/combat-observe.trackFoe → hp-estimate по подтверждённым попаданиям, видимому лечению, тотему, регенерации).
  // healthOf остаётся для мобов и телеметрии (trickDmg, mace.dealt).
  const co = require('./pvp/combat-observe')
  let calc = co.trackFoe(bot, entity, { honest: true })
  const foeEst = () => calc.hp.snapshot()
  const foeHpDecide = (e = entity) => co.isPlayer(e) ? (e === calc.entity ? foeEst().mean : 20) : healthOf(bot, e)
  // Граф боя (S7d, pvp/fight-graph): каждые 5 тиков — план калькулятора + длинные приёмы → решение и разрешения веткам.
  // ND_FIGHT_GRAPH=0 — прежний порядок веток (сравнение на снимках). Комбо — цепочки приёмов перед его потерей хп.
  const fg = require('./pvp/fight-graph')
  const GRAPH = process.env.ND_FIGHT_GRAPH !== '0'
  const combo = fg.comboLog(() => gameClock.now())
  const blk = require('./pvp/block-log').install(bot)
  let gp = null
  const noteGate = (kind) => {
    st.calc = st.calc || { plans: 0, kinds: {} }
    st.calc.gated = st.calc.gated || {}
    st.calc.gated[kind] = (st.calc.gated[kind] || 0) + 1
  }
  const gate = (kind) => {
    if (!GRAPH || !gp) return true
    if (gp.allow(kind)) return true
    noteGate(kind)
    return false
  }
  // Небо над ним для молнии «Громовержца» (channeling.json: can_see_sky у жертвы) — честно: крыша над ним известна,
  // только если я её вижу (pick.blockSeen); невидимый сверху блок — неизвестность, человек считал бы небо открытым.
  // Стекло и барьер свет неба пропускают (над ареной фермы барьер) — не крыша.
  const skyOver = (e) => {
    try {
      const top = e.position.floored().offset(0, 2, 0)
      for (let k = 0; k < 40; k++) {
        const c = top.offset(0, k, 0)
        const b = bot.blockAt(c, false)
        if (!b) return true
        if (b.boundingBox !== 'block' || /glass|barrier|ice/.test(b.name)) continue
        return !pick.blockSeen(bot, c)
      }
    } catch {}
    return true
  }
  // Навес рядом: клетка, где стоять (опора, 2 воздуха), а над головой в 1–5 бл. — непрозрачный блок, который я вижу.
  const shelterNear = (R = 6) => {
    const me0 = bot.entity.position.floored()
    let best = null
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) for (const dy of [0, -1, 1]) {
      const c = me0.offset(dx, dy, dz)
      const dd = Math.hypot(dx, dz)
      if (dd > R || (best && dd >= best.d)) continue
      const fl = bot.blockAt(c.offset(0, -1, 0), false); const a0 = bot.blockAt(c, false); const a1 = bot.blockAt(c.offset(0, 1, 0), false)
      if (!fl || fl.boundingBox !== 'block' || !a0 || a0.boundingBox !== 'empty' || !a1 || a1.boundingBox !== 'empty' || /lava|fire|cobweb|water/.test(a0.name + a1.name)) continue
      let roof = null
      for (let k = 2; k <= 6 && !roof; k++) { const b = bot.blockAt(c.offset(0, k, 0), false); if (b && b.boundingBox === 'block' && !/glass|barrier|ice/.test(b.name)) roof = c.offset(0, k, 0) }
      if (!roof || !pick.blockSeen(bot, roof)) continue
      best = { x: c.x, y: c.y, z: c.z, d: dd }
    }
    return best
  }
  // Трасса боя для разбора (ND_TRACE_PVP): время, кто, что — в лог демона.
  const TRACE = !!process.env.ND_TRACE_PVP
  let myHpT = null
  const trace = (what) => { try { console.log(`[trace] ${new Date().toISOString().slice(11, 19)} ${bot.username} +${((gameClock.now() - traceT0) / 1000).toFixed(1)}s ${what}`) } catch {} }
  // Точка прострела: клетка в 3–6 бл. по горизонтали от его колонны, где стоять (опора, 2 воздуха) и откуда луч
  // от глаз до его груди свободен — ближайшая ко мне.
  let losGoal = null
  let foeSeenPos = null
  const losSpot = () => {
    try {
      const me0 = bot.entity.position
      const ep = foeSeenPos
      if (!ep) return null
      const chest = ep.offset(0, (entity.height || 1.8) * 0.6, 0)
      let best = null
      for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
        const hd = Math.hypot(dx, dz)
        if (hd < 3 || hd > 6.2) continue
        for (const dy0 of [0, 1, -1]) {
          const c = new Vec3(Math.floor(ep.x) + dx, Math.floor(me0.y) + dy0, Math.floor(ep.z) + dz)
          const fl = bot.blockAt(c.offset(0, -1, 0), false); const a0 = bot.blockAt(c, false); const a1 = bot.blockAt(c.offset(0, 1, 0), false)
          if (!fl || fl.boundingBox !== 'block' || !a0 || a0.boundingBox !== 'empty' || !a1 || a1.boundingBox !== 'empty' || /lava|fire|cobweb/.test(a0.name + a1.name)) continue
          if (AR && !onField(c.offset(0.5, 0, 0.5))) continue
          if (!raySees(bot, c.offset(0.5, EYE, 0.5), chest)) continue
          const md = Math.hypot(c.x + 0.5 - me0.x, c.z + 0.5 - me0.z)
          if (!best || md < best.md) best = { x: c.x, y: c.y, z: c.z, md }
          break
        }
      }
      return best
    } catch { return null }
  }
  let lastTrick = null
  let shieldHitAt = -1e9
  let foeHp = null
  const onTickDmg = () => {
    const h = healthOf(bot, entity)
    if (typeof h !== 'number') return
    if (foeHp != null && h < foeHp - 0.05) {
      if (st.shield && gameClock.now() - shieldHitAt < 600) st.shield.through = Math.round((st.shield.through + foeHp - h) * 10) / 10
      const k = lastTrick && gameClock.now() - lastTrick.at <= 1500 ? lastTrick.what : 'прочее'
      st.trickDmg[k] = Math.round(((st.trickDmg[k] || 0) + foeHp - h) * 10) / 10
      combo.dealt(foeHp - h)
      if (TRACE) trace(`ему −${Math.round((foeHp - h) * 10) / 10} (у него ${Math.round(h)}; телеметрия)`)
    }
    if (TRACE) {
      const mh = (bot.health ?? 0)
      if (myHpT != null && mh < myHpT - 0.05) trace(`мне −${Math.round((myHpT - mh) * 10) / 10} (у меня ${Math.round(mh)})`)
      myHpT = mh
    }
    foeHp = h
  }
  bot.on('physicsTick', onTickDmg)
  const used = (what) => {
    st.tricks[what] = (st.tricks[what] || 0) + 1
    lastTrick = { what, at: gameClock.now() }
    combo.note(what)
    if (process.env.ND_TRACE_PVP) {
      try {
        const m = bot.entity.position; const h = entity && entity.position
        // Оценка его хп (решения) и точное (только телеметрия — для разбора боя, не для решений).
        let est = ''
        try { const e = foeEst(); est = ` оценка ${Math.round(e.lo)}–${Math.round(e.hi)} (точно ${Math.round(healthOf(bot, entity) ?? -1)})` } catch {}
        console.log(`[trace] ${new Date().toISOString().slice(11, 19)} ${bot.username} +${((gameClock.now() - traceT0) / 1000).toFixed(1)}s ${what} | я ${m.x.toFixed(1)},${m.y.toFixed(1)},${m.z.toFixed(1)} хп ${Math.round(bot.health ?? 0)}${h ? ` | он ${h.x.toFixed(1)},${h.y.toFixed(1)},${h.z.toFixed(1)} d=${m.distanceTo(h).toFixed(1)}${est}` : ''}`)
      } catch {}
    }
  }
  const quiet = { at: gameClock.now(), gaps10: 0, total10: 0, longest: 0 }
  const noteExchange = () => {
    const now = gameClock.now()
    const gap = now - quiet.at
    if (gap >= 10000) { quiet.gaps10++; quiet.total10 += gap }
    if (gap > quiet.longest) quiet.longest = gap
    quiet.at = now
  }
  const ovl: any = { ms: 0, n: 0, at: gameClock.now(), was: false }
  st.build = { box: 0, pillar: 0, counter: 0, pit: 0, boxHot: 0, pillarHot: 0, counterHot: 0, pitHot: 0, aborted: 0, refused: 0, boxMs: [] }
  st.eatPunish = { tries: 0, swaps: 0 }

  const style: any = {
    aggression: 0.35 + Math.random() * 0.6, // кидаться ли в окна (ест, прячется)
    reactMs: 80 + Math.random() * 220, // заметил — через сколько ответил
    fortAt: healAt + Math.round(Math.random() * 5) - 2, // когда в коробку
    patchBudget: 3 + Math.floor(Math.random() * 6), // сколько блоков латать в осаде
    boxPatienceMs: 15000 + Math.random() * 25000, // сколько сидеть в коробке
    punchLimit: 4 + Math.floor(Math.random() * 4), // сколько прорубать без удара
    pressMs: 5000 + Math.random() * 1500 // сколько терпеть без размена до нажима (FIX)
  }
  st.style = { агрессия: Math.round(style.aggression * 100) / 100, реакцияМс: Math.round(style.reactMs), коробкаНа: style.fortAt }
  style.openDelayMs = Math.round(Math.random() * (FIX ? 1200 : 700))
  const tt = tempo.track(bot, {
    threats: () => [entity, ...[...attackers.values()].filter(a => gameClock.now() - a.at < 8000).map(a => a.e)],
    reactMs: style.reactMs
  })
  session.tempo = tt
  const foe = read.watch(bot, { threats: tt.threats })
  tt.read = foe
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
  const fortSealed = () => !!(fort && fortify.enclosure(bot, fort.cell).sealed)
  const noticed: any = {}
  const after = (key, cond, ms = style.reactMs) => {
    if (!cond) { delete noticed[key]; return false }
    if (!noticed[key]) noticed[key] = gameClock.now()
    return gameClock.now() - noticed[key] >= ms
  }
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
  // редко (обновление раз в 20 тиков, исследование исходников 1.21.11), и по
  let theirDrawAt = 0
  const sawRelease = () => {
    const using = usingItem(bot, entity)
    if (using === 'bow') { if (!theirDrawAt) theirDrawAt = gameClock.now(); return false }
    const shot = theirDrawAt && gameClock.now() - theirDrawAt > 350
    theirDrawAt = 0
    return !!shot
  }
  let jumpedForCrit = false
  const mf = melee.fight(bot, { target: () => entity, jumpOk: (e) => !(FIX && e && e.position && bot.entity && edges.dropAlong(bot, bot.entity.position.plus(bot.entity.position.minus(e.position)), 2.6)) })
  const tot = totemMod.install(bot)
  const use0 = bot._ndUse ? { ...bot._ndUse.stats } : null
  let hitKind = null
  let firstHitDone = false
  let totemAt = 0
  let maceTotem = false
  let selectSince = 0
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
    if (source && bot.entity && ((victim === entity && source.id === bot.entity.id) || (victim === bot.entity && source.id === entity.id))) noteExchange()
    if (victim === entity && source === bot.entity) {
      st.landed++
      if (lastStand) session.bus?.emit('last_stand_hit', { target: entity.id, swings: st.swings, landed: st.landed,
        targetHealth: healthOf(bot, entity), health: bot.health })
      if (gameClock.now() - lastSwing < 400 && swingCrit) st.crits++
    }
    if (victim === bot.entity && source && source.id === entity.id) lastHurtByTarget = gameClock.now()
    if (victim === bot.entity && source && isPlayer(source) && source.id !== entity.id && source.id !== bot.entity.id && source.username !== bot.username) {
      const a = attackers.get(source.id) || { e: source, n: 0 }
      a.at = gameClock.now(); a.n++; a.e = source
      attackers.set(source.id, a)
    }
  }
  const attackers = new Map()
  let switchedAt = 0
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
  const onDead = (e) => {
    if (e) dead.add(e.id)
    if (e === entity) {
      killed = true
      if (lastStand) session.bus?.emit('last_stand_kill', { target: entity.id, swings: st.swings, landed: st.landed, health: bot.health })
    }
  }
  let selfDied = false
  const onSelfDeath = () => { selfDied = true }
  bot.on('death', onSelfDeath)
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
    for (const e of ((Object.values(bot.entities) as any[]) as any)) {
      if (!e || e === bot.entity || !e.position || isPlayer(e)) continue
      const nm = e.name || ''
      const hitting = now - (mobHits.get(e.id) || 0) < 5000
      if (!HOSTILE_MOB.test(nm) && !(hitting && ANGRY_IF_HIT.test(nm))) continue
      if (dead.has(e.id) || lookDead(bot, e)) continue
      const dist = e.position.distanceTo(me)
      if (dist > (hitting ? 14 : 6)) continue
      const close = dist < (nm === 'creeper' ? 5 : 4)
      if (!hitting && !close) continue
      if (!hitting && !raySees(bot, eyeM, e.position.offset(0, (e.height || 1.8) * 0.6, 0))) continue
      const score = dist - (hitting ? 4 : 0) - (nm === 'creeper' ? 3 : 0)
      if (!best || score < best.score) best = { e, dist, hitting, score }
    }
    return best
  }
  const mobCtl = { get aborted () { return ctl.aborted || !!mobThreat() }, onAbort: ctl.onAbort, abort: () => ctl.abort() }
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  const duo = duoMod.create(bot, { target: () => entity, attackers, dead, used, tt, holdWeapon: () => holdWeapon(), setAim: (m) => { aim = m }, potionOf })
  ctl.onAbort.push(() => duo.close())
  const util = utilityMod.create(bot, { used, tt })
  ctl.onAbort.push(() => util.close())
  const swatted = new Map()
  const onTickSwat = () => {
    try {
      if (!bot.entity) return
      const eyeNow = bot.entity.position.offset(0, EYE, 0)
      for (const fb of ((Object.values(bot.entities) as any[]) as any)) {
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

  const bowWatch: any = { drawAt: 0, shotAt: 0, shots: 0, seen: -1, loadedAt: 0, xbowShotAt: 0 }
  const arrowLog = arrows.track(bot)
  const onTickArcher = () => {
    try {
      if (!entity.isValid || !prof.player) return
      const now = gameClock.now()
      const sh = arrowLog.shots.get(entity.id)
      const n = sh ? sh.n : 0
      if (bowWatch.who !== entity.id) { bowWatch.who = entity.id; bowWatch.seen = n; bowWatch.drawAt = 0; bowWatch.loadedAt = 0 }
      if (n > bowWatch.seen) { bowWatch.shots += n - bowWatch.seen; bowWatch.seen = n; bowWatch.shotAt = sh.at; bowWatch.drawAt = 0; bowWatch.lastU = null }
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
  if (!bot._ndFallGuard) bot.on('physicsTick', onTickFall)
  const onMlg = (e) => {
    if (e.what === 'fired') used('вода под себя (MLG)')
    else if (e.what === 'saved') used('MLG: приземлился в воду')
    else if (e.what === 'missed') used('MLG: промахнулся')
    else if (e.what === 'picked') used('MLG: воду обратно в ведро')
  }
  bot.on('nd_mlg', onMlg)

  let aim = 'target'
  let aimPoint = null
  let sightOff = null
  const aimTimer = gameClock.setInterval(() => {
    if (!bot.entity || !entity.isValid) return
    try {
      const nowO = gameClock.now()
      const u = bot._ndUse && bot._ndUse.cur
      const k = u ? tempo.useKind(u.name) : null
      const both = prof.player && (session.eating || k === 'eat' || k === 'drink') && !!tt.state(entity).consuming
      if (both) {
        const dtO = Math.min(200, nowO - ovl.at)
        ovl.ms += dtO
        if (!ovl.was) ovl.n++
        if (entity.position.distanceTo(bot.entity.position) < 24 && raySees(bot, bot.entity.position.offset(0, EYE, 0), entity.position.offset(0, (entity.height || 1.8) * 0.55, 0))) ovl.openMs = (ovl.openMs || 0) + dtO
      }
      ovl.was = both
      ovl.at = nowO
    } catch {}
    try {
      if (bot.targetDigBlock && bot.targetDigBlock.position) {
        bot.lookAt(bot.targetDigBlock.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
        return
      }
      if (pathing || edges.falling(bot)) return
      if (aim === 'target') {
        // Прогноз следящего бывает с NaN по x/z (s7-arms11, [nan-guard] lookAt({x:null,y:106,z:null})) — тогда смотрю на тело.
        const p0 = track.at(2)
        const p = [p0.x, p0.y, p0.z].every(Number.isFinite) ? p0 : entity.position
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
  const hm = showman.create({
    bot, session, target: () => entity, style, used, set, tt, styleOut: st.style,
    aimTo: (mode, point = null) => { aim = mode; aimPoint = point },
    stopPath: () => { if (pathing) { pathTo(false); pathing = false } },
    stepOk: (k) => stepSafe(bot, keyDir(bot, k)),
    fillerCount: () => { const f = pickFiller(bot); return f ? countOf(bot, f.name) : 0 },
    cover: async (pos) => { const n = await coverFrom(pos, { what: 'засада: колонна между нами' }); await holdWeapon(); return n },
    weaponMs: () => cooldownMs(bot.heldItem),
    onAirSwing: () => { nextReady = Math.max(nextReady, gameClock.now() + cooldownMs(bot.heldItem)) },
    nearDrop: () => { try { return FIX && !!entity.position && edges.dropAlong(bot, entity.position, 4.5) } catch { return false } }
  })
  if (hm) ctl.onAbort.push(() => hm.close())

  const pathTo = (on, goal = null) => {
    try {
      const mv = bot.pathfinder.movements
      const webId = bot.registry.blocksByName.cobweb && bot.registry.blocksByName.cobweb.id
      if (on && mv && mv.blocksToAvoid && webId != null) mv.blocksToAvoid.add(webId)
      if (on && !goal && holdGoal) goal = holdGoal
      if (on) bot.pathfinder.setGoal(goal || new goals.GoalFollow(entity, 2), !goal)
      else bot.pathfinder.setGoal(null)
    } catch {}
  }
  let pathing = false

  const mv = bot.pathfinder && bot.pathfinder.movements
  const mvWas = mv ? { canDig: mv.canDig, towers: mv.allow1by1towers, scaffold: mv.scafoldingBlocks, parkour: mv.allowParkour, drop: mv.maxDropDown } : null
  if (mv) { mv.allow1by1towers = false; mv.scafoldingBlocks = [] }
  if (mv) { mv.allowParkour = false; mv.maxDropDown = edges.SAFE_FALL }
  const digWas = mv ? mv.digCost : null
  if (mv) mv.digCost = tempo.SPRINT_BPT * 20 / 3
  const restoreMoves = () => {
    if (!mv || !mvWas) return
    mv.canDig = mvWas.canDig; mv.allow1by1towers = mvWas.towers; mv.scafoldingBlocks = mvWas.scaffold
    mv.allowParkour = mvWas.parkour; mv.maxDropDown = mvWas.drop
    if (digWas != null) mv.digCost = digWas
    if (nbWas) mv.getNeighbors = nbWas
    if (floorGuard) { const i = mv.exclusionAreasBreak.indexOf(floorGuard); if (i >= 0) mv.exclusionAreasBreak.splice(i, 1) }
  }
  const AR = arena && Number.isFinite(arena.y) && Number.isFinite(arena.r) ? arena : null
  // Путь к нему не копает пол поля (S7d, блоки в бою: s7d-b «булава против щита» — 27 попыток копать блок под своими
  // ногами, 0 удачных): дыра в полу арены в небе — падение в пустоту; pathfinder копает, когда цель ниже. Пол и ниже —
  // цена 100 (= нельзя для pathfinder), выше пола (стенки рельефа, его коробка) — как было.
  const floorGuard = AR && mv && Array.isArray(mv.exclusionAreasBreak) ? (b) => (b && b.position && b.position.y <= AR.y - 1 ? 100 : 0) : null
  if (floorGuard) mv.exclusionAreasBreak.push(floorGuard)
  const onField = (p) => !!AR && !!p && p.y >= AR.y - 1.5 && Math.abs(p.x - AR.x) <= AR.r + 0.5 && Math.abs(p.z - AR.z) <= AR.r + 0.5
  const nbWas = mv && AR && typeof mv.getNeighbors === 'function' ? mv.getNeighbors : null
  if (nbWas) {
    mv.getNeighbors = function (node) {
      const out = nbWas.call(this, node)
      if (!bot.entity || !onField(bot.entity.position)) return out
      return out.filter(m => m.y >= AR.y && Math.abs(m.x + 0.5 - AR.x) <= AR.r && Math.abs(m.z + 0.5 - AR.z) <= AR.r)
    }
  }
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
  const badShafts = new Set()
  const edgeGuard = edges.guard(bot, {
    margin: () => (entity && entity.isValid && entity.position && bot.entity && entity.position.distanceTo(bot.entity.position) < 6 ? 0.35 : 0)
  })
  const mc = mace.track(bot, { enemy: () => entity })
  ctl.onAbort.push(() => mc.close())
  const sky = elytra.create(bot, { enemy: () => entity, used, edgeGuard, arena: AR })
  ctl.onAbort.push(() => sky.close())
  const pearlResponse = require('./combat/pearl-response').createPearlResponse(bot, {
    enemy: () => entity, used,
    webAt: async (point, controller) => {
      const web = findItem(bot, i => i.name === 'cobweb')
      return !!web && pvpSkills.placeAt(web, new Vec3(point.x, point.y, point.z), 'паутина в точке прилёта жемчуга', controller)
    }
  })
  ctl.onAbort.push(() => pearlResponse.close())
  const bm = boom.create(bot, { enemy: () => entity, used, crystals: !crystal.ON })
  ctl.onAbort.push(() => bm.close())
  // Хп соперника-игрока в решениях кристаллов — оценкой (правило 06.10); урон своих подрывов — в оценку (S7c).
  const cx = crystal.create(bot, { enemy: () => entity, used, foeHp: (e) => foeHpDecide(e), noteAttack: (r, o) => calc.noteAttack(r, o) })
  ctl.onAbort.push(() => cx.close())
  const maceNow = () => { try { return !!(prof.player && mc.threat()) } catch { return false } }
  const maceAbort = (what) => { st.maceAborts = (st.maceAborts || 0) + 1; used('бросил ' + what + ': булава сверху') }
  const buildGuard = (...args: any[]) => pvpSkills.buildGuard(...args)
  const guardCtl = (...args: any[]) => pvpSkills.guardCtl(...args)
  const buildDone = (...args: any[]) => pvpSkills.buildDone(...args)
  const buildHot = (...args: any[]) => pvpSkills.buildHot(...args)
  const noteBuild = (...args: any[]) => pvpSkills.noteBuild(...args)

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

  const heldName = (...args: any[]) => pvpSkills.heldName(...args)
  const switched = (...args: any[]) => pvpSkills.switched(...args)

  let chosenWeapon = null
  const pickWeaponFor = (...args: any[]) => pvpSkills.pickWeaponFor(...args)

  const holdWeapon = (...args: any[]) => pvpSkills.holdWeapon(...args)

  const holdItem = (...args: any[]) => pvpSkills.holdItem(...args)

  const useAt = (...args: any[]) => pvpSkills.useAt(...args)

  const foeGrounded = (...args: any[]) => pvpSkills.foeGrounded(...args)
  const leadFn = (...args: any[]) => pvpSkills.leadFn(...args)
  const reachable = (...args: any[]) => pvpSkills.reachable(...args)
  const throwAt = (...args: any[]) => pvpSkills.throwAt(...args)

  const placeUnder = (...args: any[]) => pvpSkills.placeUnder(...args)

  const wallToward = (...args: any[]) => pvpSkills.wallToward(...args)

  const coverFrom = (...args: any[]) => pvpSkills.coverFrom(...args)

  const coverForDrink = (...args: any[]) => pvpSkills.coverForDrink(...args)

  let perch = null
  let siegeGoal = null
  const perchHeight = (...args: any[]) => pvpSkills.perchHeight(...args)
  const PERCH_MAX = 8
  const headroom = (...args: any[]) => pvpSkills.headroom(...args)
  const pillarOut = (...args: any[]) => pvpSkills.pillarOut(...args)
  const dropFromPerch = (...args: any[]) => pvpSkills.dropFromPerch(...args)

  let fort = null
  const healItem = (...args: any[]) => pvpSkills.healItem(...args)
  const fortPossible = (...args: any[]) => pvpSkills.fortPossible(...args)
  const isAir = (...args: any[]) => pvpSkills.isAir(...args)
  const cellOk = (...args: any[]) => pvpSkills.cellOk(...args)
  const fortSpot = (...args: any[]) => pvpSkills.fortSpot(...args)
  const fortOut = (...args: any[]) => pvpSkills.fortOut(...args)

  const punchThrough = (...args: any[]) => pvpSkills.punchThrough(...args)

  let terrainAt = 0
  let myPit = null
  let theirPit = null
  let nearFoe = []
  let nearMe = []
  let push = null
  let pushAt = 0
  let behindDrop = null
  let jumpDrop = false
  let jumpDropAt = 0
  let backAt = 0
  let theyUpSince = 0
  const falls = { mine: 0, ground: null, his: 0, hisY: [] }
  const edgeTally = (...args: any[]) => pvpSkills.edgeTally(...args)

  const climbOut = (...args: any[]) => pvpSkills.climbOut(...args)

  const lavaIntoPit = (...args: any[]) => pvpSkills.lavaIntoPit(...args)

  const bucketLanding = (...args: any[]) => pvpSkills.bucketLanding(...args)
  const useOnGroundAt = (...args: any[]) => pvpSkills.useOnGroundAt(...args)

  const scoop = (...args: any[]) => pvpSkills.scoop(...args)

  const TOWER_SAFE_DRAW_MS = 500
  const towerShield = (...args: any[]) => pvpSkills.towerShield(...args)

  const pendingLava = []
  const pendingWater = []

  const hazardOnLine = (...args: any[]) => pvpSkills.hazardOnLine(...args)
  const unblockPath = (...args: any[]) => pvpSkills.unblockPath(...args)

  const digWatch = (...args: any[]) => pvpSkills.digWatch(...args)

  const punishable = (...args: any[]) => pvpSkills.punishable(...args)

  const eatHeld = (...args: any[]) => pvpSkills.eatHeld(...args)
  const consumeItem = (...args: any[]) => pvpSkills.consumeItem(...args)

  const drink = (...args: any[]) => pvpSkills.drink(...args)

  const escapePearl = (...args: any[]) => pvpSkills.escapePearl(...args)

  const finish = async (out) => {
    gameClock.clearInterval(aimTimer)
    clear()
    pathTo(false)
    restoreMoves()
    try { bot.deactivateItem() } catch {}
    // Погиб — отчёт сразу: сессия ждёт его 1 с реального времени после смерти (intent-runner), щит и вычерпывание
    // лавы мёртвому не нужны (S7c: у погибшего в ROUND пустые crystal/elytra — отчёт не успевал).
    if (guard && !selfDied) await guard.raise(false)
    if (!selfDied) for (const cell of pendingLava.splice(0)) await scoop(cell)
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('physicsTick', onTickSwat)
    bot.removeListener('physicsTick', onTickArcher)
    bot.removeListener('entityHurt', onMobHurt)
    bot.removeListener('death', onSelfDeath)
    bot.removeListener('physicsTick', onTickFall)
    bot.removeListener('physicsTick', onTickDmg)
    edgeGuard.stop()
    bot.removeListener('nd_mlg', onMlg)
    if (edgeGuard.stats.saves || edgeGuard.stats.air) st.tricks['рефлекс края: ' + (Object.entries(edgeGuard.stats.why) as [string, any][]).map(([k, v]) => `${k}×${v}`).join(', ')] = 1
    bot.removeListener('blockBreakProgressObserved', onCrack)
    bot.removeListener('entityDead', onDead)
    tt.close()
    if (session.tempo === tt) session.tempo = null
    mc.close()
    sky.close()
    calc.stop()
    blk.close()
    pearlResponse.close()
    bm.close()
    cx.close()
    mf.close()
    duo.close()
    util.close()
    const human = hm && prof.player ? hm.report() : undefined
    if (hm) hm.close()
    if (st.spearCharges || st.spearSwaps) st.tricks[`копьё: разгонов ${st.spearCharges || 0}, попал ${st.spearChargeHits || 0}; смен копьё↔меч ${st.spearSwaps || 0}`] = 1
    const tricks = Object.keys(st.tricks).length ? st.tricks : undefined
    const ts = tt.stats
    { const gapEnd = gameClock.now() - quiet.at; if (gapEnd >= 10000) { quiet.gaps10++; quiet.total10 += gapEnd } if (gapEnd > quiet.longest) quiet.longest = gapEnd }
    // Отчёт — и в память демона (S7d): арена забирает его status { lastDuel }, если ответ fight опоздал или пуст
    // (s7d-base: у 2 из 5 раундов «элитр» пустые ROUND обеих сторон — стоп арены обгонял отчёт).
    const rep = buildReport(out, tricks, human, ts)
    try { bot._ndLastDuel = { at: gameClock.wall.now(), foe: label, detail: rep } } catch {}
    return rep
  }
  function buildReport (out, tricks, human, ts) {
    return {
      pvp: prof.player || undefined,
      lastStand: lastStand || undefined,
      micro: true,
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
      tempo: prof.player ? { on: tempo.ON, open: tt.opening || undefined, ate: ts.consumes, pressured: ts.pressured, aborted: ts.aborted, desperate: ts.desperate || undefined, refused: ts.refused || undefined, foeAte: ts.foeConsumes, busyHits: ts.busyLanded, busyBy: Object.keys(ts.busyByKind).length ? ts.busyByKind : undefined, punish: Object.keys(ts.punish).length ? ts.punish : undefined, breaches: ts.breaches || undefined, escapes: ts.breachEscapes || undefined, kites: ts.kites || undefined } : undefined,
      target: label,
      kills: kills.length ? kills : undefined,
      assessment: planText || undefined,
      arrows: st.arrows || undefined,
      blocks: st.blocks || undefined,
      style: st.style,
      arrowHits: st.arrows ? (st.arrowHits || 0) : undefined,
      towerShots: st.towerShots || undefined,
      holds: st.holds || undefined,
      returns: st.returns || undefined,
      gathered: st.gathered || undefined,
      mobKills: st.mobKills || undefined,
      swings: st.swings,
      landed: st.landed,
      crits: st.crits,
      sprintHits: st.sprintHits,
      axeOnShield: st.axeOnShield || undefined,
      hops: st.hops ? { tries: st.hops, ok: st.hopOk || 0, eff: st.hopEff || 0, why: st.hopWhy } : undefined,
      calc: st.calc ? { plans: st.calc.plans, kinds: st.calc.kinds, picks: st.calc.picks, gated: st.calc.gated, weapons: st.calc.weapons, last: st.calc.last, err: st.calcErr } : undefined,
      combos: combo.report(),
      vsShield: st.shield,
      storm: st.storm,
      breakUnder: st.breakUnder,
      blockLog: blk.report(),
      util: util.stats && (util.stats.trident || util.stats.riptide || util.stats.anvils || util.stats.boxes || util.stats.lava) ? { trident: util.stats.trident, tridentHit: util.stats.tridentHit, bolts: util.stats.bolts, riptide: util.stats.riptide, anvils: util.stats.anvils, boxes: util.stats.boxes, lava: util.stats.lava } : undefined,
      xbow: st.xbow && Object.keys(st.xbow).length ? st.xbow : undefined,
      rod: util.stats && (util.stats.rod || util.stats.hookedOnMe || util.stats.pulledMe) ? { casts: util.stats.rod, hooked: util.stats.rodHooked, hookedOnMe: util.stats.hookedOnMe, counter: util.stats.rodCounter, pulledMe: util.stats.pulledMe } : undefined,
      mace: mc.report(),
      elytra: sky.report(),
      pearlResponse: pearlResponse.report(),
      recoveryNodes: st.recoveryNodes,
      foodFire: foodFire.attempts ? foodFire : undefined,
      boom: bm.report(),
      crystal: cx.report(),
      melee: mf.report(),
      totem: tot.pops || tot.fast || tot.slow ? { pops: tot.pops, reequips: tot.reequips, fails: tot.reequipFails || undefined, fast: tot.fast, slow: tot.slow, why: tot.why } : undefined,
      itemUse: bot._ndUse ? (() => { const s = bot._ndUse.stats; const b = use0 || {}; const df = k => (s[k] || 0) - (b[k] || 0); return { slowTicks: df('slowTicks'), sprintBlocked: df('sprintBlocked'), sprintNoFwd: df('sprintNoFwd'), sprintStops: df('sprintStops'), sprintStarts: df('sprintStarts'), wallStops: df('wallStops'), wallTicks: df('wallTicks') } })() : undefined,
      human,
      dodges: st.dodges || undefined,
      tricks,
      trickDmg: Object.keys(st.trickDmg).length ? st.trickDmg : undefined,
      healed: st.healed.length ? st.healed : undefined,
      weapon: weapon ? weapon.name : 'кулаки',
      hp: `${st.hpStart} -> ${Math.round(bot.health ?? 0)}`,
      left: leftovers(bot),
      ...out
    }
  }

  let planText = null
  let planVerdict = null
  let replanAt = 0
  const retarget = (e) => {
    if (!e || e === bot.entity || (bot.entity && e.id === bot.entity.id)) return
    entity = e
    foeSeenPos = null
    st.bowProg = []
    foeHp = null
    calc.stop(); calc = co.trackFoe(bot, entity, { honest: true })
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
  const combatContext = {
get consumeItem () { return consumeItem },
get aim () { return aim }, set aim (value) { aim = value },
get aimPoint () { return aimPoint }, set aimPoint (value) { aimPoint = value },
get assess () { return assess },
get bestWeapon () { return bestWeapon },
get blockName () { return blockName },
get bot () { return bot },
get bowWatch () { return bowWatch },
get BOX_FRONT_MS () { return BOX_FRONT_MS },
get BOX_MS () { return BOX_MS },
get bucketLanding () { return bucketLanding },
get buildDone () { return buildDone },
get buildGuard () { return buildGuard },
get buildHot () { return buildHot },
get cellOk () { return cellOk },
get chosenWeapon () { return chosenWeapon }, set chosenWeapon (value) { chosenWeapon = value },
get clear () { return clear },
get cooldownMs () { return cooldownMs },
get countOf () { return countOf },
get COVER_MS () { return COVER_MS },
get COVER_WIDE_MS () { return COVER_WIDE_MS },
get coverForDrink () { return coverForDrink },
get coverFrom () { return coverFrom },
get creeperSwelling () { return creeperSwelling },
get ctl () { return ctl }, set ctl (value) { ctl = value },
get digWatch () { return digWatch },
get drink () { return drink },
get eatHeld () { return eatHeld },
get edgeGuard () { return edgeGuard },
get edges () { return edges },
get entity () { return entity }, set entity (value) { entity = value },
get EYE () { return EYE },
get falls () { return falls },
get findItem () { return findItem },
get findPotion () { return findPotion },
get FIX () { return FIX },
get foeGrounded () { return foeGrounded },
get fort () { return fort }, set fort (value) { fort = value },
get fortify () { return fortify },
get fortSealed () { return fortSealed },
get fortSpot () { return fortSpot },
get gameClock () { return gameClock },
get goals () { return goals },
get guard () { return guard },
get guardCtl () { return guardCtl },
get hasEffect () { return hasEffect },
get hazardOnLine () { return hazardOnLine },
get headroom () { return headroom },
get healItem () { return healItem },
get healthOf () { return healthOf },
get foeHpDecide () { return foeHpDecide },
get heldName () { return heldName },
get HIT_REACH () { return HIT_REACH },
get holdItem () { return holdItem },
get holdWeapon () { return holdWeapon },
get isAir () { return isAir },
get isPlayer () { return isPlayer },
get keyDir () { return keyDir },
get lastHurtByTarget () { return lastHurtByTarget }, set lastHurtByTarget (value) { lastHurtByTarget = value },
get lastSwing () { return lastSwing }, set lastSwing (value) { lastSwing = value },
get leadFn () { return leadFn },
get mace () { return mace },
get maceAbort () { return maceAbort },
get maceNow () { return maceNow },
get mc () { return mc },
get nextReady () { return nextReady }, set nextReady (value) { nextReady = value },
get noteBuild () { return noteBuild },
get onFire () { return onFire },
get pathing () { return pathing }, set pathing (value) { pathing = value },
get pathTo () { return pathTo },
get pendingWater () { return pendingWater },
get perch () { return perch }, set perch (value) { perch = value },
get PERCH_MAX () { return PERCH_MAX },
get perchHeight () { return perchHeight },
get pick () { return pick },
get pickFiller () { return pickFiller },
get PILLAR_MS () { return PILLAR_MS },
get placeBlockAt () { return placeBlockAt },
get potionOf () { return potionOf },
get potionRole () { return potionRole },
get process () { return process },
get prof () { return prof }, set prof (value) { prof = value },
get punishable () { return punishable },
get ranged () { return ranged },
get rangedAllowed () { return rangedAllowed },
get raySees () { return raySees },
get reachable () { return reachable },
get reachFrom () { return reachFrom },
get ready () { return ready },
get rest () { return rest },
get scoop () { return scoop },
get seesNow () { return seesNow },
get session () { return session }, set session (value) { session = value },
get set () { return set },
get sleep () { return sleep },
get solid () { return solid },
get spear () { return spear },
get st () { return st },
get stepSafe () { return stepSafe },
get style () { return style },
get switched () { return switched },
get tempo () { return tempo },
get theirPit () { return theirPit }, set theirPit (value) { theirPit = value },
get throwMod () { return throwMod },
get TICK_MS () { return TICK_MS },
get tools () { return tools },
get TOWER_SAFE_DRAW_MS () { return TOWER_SAFE_DRAW_MS },
get towerShield () { return towerShield },
get towerUp () { return towerUp },
get track () { return track }, set track (value) { track = value },
get tt () { return tt },
get useAt () { return useAt },
get used () { return used },
get useOnGroundAt () { return useOnGroundAt },
get Vec3 () { return Vec3 },
get weapon () { return weapon }, set weapon (value) { weapon = value },
get withTimeout () { return withTimeout },
get yawTo () { return yawTo }
}
const pvpSkills = {
...require('./pvp/equipment').createEquipment(combatContext),
...require('./pvp/cover').createCover(combatContext),
...require('./pvp/terrain').createTerrain(combatContext),
...require('./pvp/recovery').createRecovery(combatContext)
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

  const buffUp = (...args: any[]) => pvpSkills.buffUp(...args)
  let rushUntil = 0
  let bowFirstUntil = 0
  let splashFirst = false
  if (tempo.ON && prof.player && !lastStand) {
    await sleep(style.openDelayMs)
    const drinkable = k => findItem(bot, i => i.name === 'potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k)
    const d0 = entity.position.distanceTo(bot.entity.position)
    const plan = tempo.pickOpening({
      d: d0,
      hp: bot.health ?? 20,
      aggression: style.aggression,
      foeBusy: !!tt.state(entity).consuming,
      has: {
        bow: rangedAllowed() && !!((findItem(bot, i => i.name === 'bow') && findItem(bot, i => /arrow$/.test(i.name))) ||
          (findItem(bot, i => i.name === 'crossbow') && findItem(bot, i => /arrow$|^firework_rocket$/.test(i.name)))),
        drinkBuffs: ['strength', 'swiftness', 'regeneration'].some(k => drinkable(k)),
        splashDebuff: !!findItem(bot, i => i.name === 'splash_potion' && potionRole(potionOf(i)) === 'debuff'),
        pearls: countOf(bot, 'ender_pearl'),
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
  } else if (!lastStand) await buffUp()

  const spearChargeFar = (...args: any[]) => pvpSkills.spearChargeFar(...args)
  const seesNow = () => { try { return raySees(bot, bot.entity.position.offset(0, EYE, 0), entity.position.offset(0, (entity.height || 1.8) * 0.55, 0)) } catch { return false } }

  let loopYielded = true
  let loopSpins = 0
  const markLoopYield = () => { loopYielded = true }
  while (!ctl.aborted) {
    if (loopYielded) loopSpins = 0
    else if (++loopSpins >= 50) { loopSpins = 0; await new Promise<any>(resolve => setImmediate(resolve)) }
    loopYielded = false
    setImmediate(markLoopYield)
    const now = gameClock.now()
    if (!bot.entity || (bot.health ?? 20) <= 0 || selfDied) return finish({ died: true })
    if (opts.purpose === 'food' && foodAnimals.has(entity.name) && (entity.metadata?.[0] & 1) && !burningFood.has(entity.id)) {
      burningFood.add(entity.id); foodFire.burningObserved++
    }
    edgeTally(now)
    if (edges.falling(bot)) { clear(); await sleep(TICK_MS); continue }
    if (!killed && !entity.isValid && !prof.player && now - targetHurtAt < 2500) killed = true
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
    if (!prof.player) {
      if (assess.inSight(bot, entity)) seenAt = now
      else if (now - seenAt > 6000) { dead.add(entity.id); unseen = true }
    }
    const lostIt = !killed && (!entity.isValid || unseen)
    if (unseen && !clearArea) return finish({ lost: `${label} не видно — за стеной` })
    unseen = false
    if (killed || (lostIt && clearArea)) {
      dead.add(entity.id)
      if (killed) kills.push(label)
      let next = null
      if (clearArea) {
        try { const p = assess.plan(bot, { radius: clearArea, exclude: dead }); next = p && p.first ? p.first.e : null } catch {}
        if (!next) next = nextFoe(bot, clearArea, dead)
      }
      if (!next && prof.player) { const o = otherAttacker(); if (o) { next = o.e; used(`переключился на ${o.e.username}`) } }
      if (!next) {
        if (hm && killed && prof.player) hm.victory()
        return finish(kills.length ? { killed: kills.length > 1 ? kills.join(', ') : kills[0] } : { lost: `${label} пропал из виду` })
      }
      retarget(next)
      await holdWeapon()
      continue
    }
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
    if (opts.repelLava && (entity.position.distanceTo(bot.entity.position) > 3 || !hasEffect(bot, 'fire_resistance'))) return finish({ repelled: true })
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
    const medical = findPotion(bot, 'splash_potion', 'heal') || findPotion(bot, 'potion', 'heal') ||
      findPotion(bot, 'potion', 'regen') || findItem(bot, i => /golden_apple$/.test(i.name))
    const safety = opts.safety.check({ target: entity, entities: tt.threats(),
      minHealth: Math.max(8, retreatAtHealth), instantHeal: !!medical, repelLava: opts.repelLava })
    const safeMedical = medical && !safety.hazard && hp > safety.hit + 2 &&
      (medical.name === 'splash_potion' || tt.safe(tempo.consumeMs(medical.name), { fortSealed: fortSealed() }).ok)
    const arenaStay = !!AR && prof.player && safety.action !== 'dead'
    const flightRecovery = prof.player && bot.entity.elytraFlying && hp > 6 && hp <= healAt && medical &&
      countOf(bot, 'firework_rocket') >= 2 && theirR > 8 && !safety.hazard && !maceNow()
    if (!arenaStay && !flightRecovery && !(lastStand && safety.action !== 'dead' && !safety.hazard) && safety.action !== 'fight' && (safety.action !== 'recover' || !safeMedical)) {
      pathTo(false); pathing = false; clear(); aim = 'free'
      if (guard) await guard.raise(false)
      const escapeFrom = bot.entity.position.clone()
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
      if (counterattackAfterFailedEscape({ alive: (bot.health ?? 0) > 0, interrupted: ctl.aborted,
        clear: !!escape?.clear, hazardous: !!safety.hazard, targetVisible: seesNow(),
        targetReach: reachFrom(bot.entity.position.offset(0, EYE, 0), entity), moved: bot.entity.position.distanceTo(escapeFrom) })) {
        lastStand = true
        st.failedEscapeCounter = (st.failedEscapeCounter || 0) + 1
        used('выход заблокирован — защищаюсь ударами')
        aim = 'target'
        await holdWeapon()
        if (guard) await guard.wear()
        continue
      }
      used('общая безопасность: ' + safety.reason)
      return finish({ lowHealth: safety.action !== 'dead', safety, escape, health: bot.health })
    }
    const meInWeb = blockName(bot, me.floored()) === 'cobweb' || blockName(bot, me.floored().offset(0, 1, 0)) === 'cobweb'
    if (prof.player && !meInWeb && !fort && !perch && ready('pearlResponse')) {
      const plan = pearlResponse.decide({ hp, interrupted: maceNow() || ctl.aborted || (session.tactics?.snapshot().threatLevel ?? 0) >= 3 })
      if (plan) {
        pathTo(false); pathing = false; clear()
        if (guard) await guard.raise(false)
        aim = 'free'
        let result = null
        try { result = await pearlResponse.run(ctl, plan) } catch (error) { result = { note: error.message } }
        aim = 'target'; clear()
        if (result?.note) used(result.note)
        if (result?.hit) { st.swings++; st.landed++; lastSwing = gameClock.now() }
        rest('pearlResponse', result?.ok ? 1200 : 300)
        nextReady = Math.max(nextReady, gameClock.now() + cooldownMs(bot.heldItem))
        await holdWeapon()
        if (guard) await guard.wear()
        continue
      }
    }

    if (prof.player && (ready('sky') || bot.entity.elytraFlying || sky.gliding()) && !meInWeb && !perch && !fort && (bot.entity.elytraFlying || !maceNow())) {
      const airHeal = () => findItem(bot, i => i.name === 'enchanted_golden_apple') || findItem(bot, i => i.name === 'golden_apple') ||
        findPotion(bot, 'potion', 'heal') || findPotion(bot, 'potion', 'regen')
      const eatSafe = tempo.ON ? tt.safe(tempo.consumeMs('golden_apple')).ok : theirR > 6
      const eqS = entity.equipment || []
      const hisShield = (!!(eqS[1] && eqS[1].name === 'shield') || !!(eqS[0] && eqS[0].name === 'shield')) && !(foe.shieldOff(entity) > 1500)
      const sp0 = sky.decide({ hp, healAt, heal: !!airHeal(), eatSafe, d, dy, foeGrounded: foeGrounded(), hisShield })
      // Взлёт ради тарана/пике — только если граф боя не нашёл на земле приёма заметно лучше (в воздухе — не мешаем).
      const sp = sp0 && /^(lance|dive)$/.test(sp0.kind) && !bot.entity.elytraFlying && !gate(sp0.kind) ? null : sp0
      if (sp) {
        rest('sky', 2000)
        const crash0 = (bot._ndElytra?.crashes || []).length
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
        // Опыт длинного приёма — в цену графа (касание/удар, удар о стену за этот полёт).
        if (/^(lance|dive)$/.test(sp.kind)) fg.noteExperience(bot._ndFightXp || (bot._ndFightXp = {}), sp.kind, { hit: !!(res && res.hit), crash: (bot._ndElytra?.crashes || []).length > crash0 })
        nextReady = Math.max(nextReady, gameClock.now() + cooldownMs(bot.heldItem))
        await holdWeapon()
        if (guard) await guard.wear()
        continue
      }
    }
    if (safety.action === 'recover' && safeMedical) {
      pathTo(false); pathing = false; clear()
      if (guard) await guard.raise(false)
      if (medical.name === 'splash_potion') {
        if (await holdItem(medical)) { await useAt(bot.entity.yaw, -Math.PI / 2); st.healed.push('взрывное лечения') }
      } else if (medical.name === 'potion') await drink(medical, 'лечение до нового размена')
      else if (await pvpSkills.consumeItem(medical)) st.healed.push(medical.name)
      await holdWeapon()
      await sleep(TICK_MS)
      continue
    }
    const their = usingItem(bot, entity)
    const blocking = their === 'shield'
    const theyEat = their && EDIBLE.test(their)
    // Натянутый трезубец — тот же стрелок (бросок через ≥ 10 тиков натяжения): щит, рывок на занятого (S7d, пункт I).
    const theyBow = their === 'bow' || their === 'crossbow' || their === 'trident'
    const theirHp = foeHpDecide(entity)
    // Граф боя (S7d): раз в 5 тиков — план калькулятора (kill-planner: удар/крит/топор/копьё/булава/арбалет/лук/удочка/
    // трезубец/кристалл/якорь) и длинные приёмы (таран, пике) → лучший по чистому урону в секунду; ветки ниже
    // исполняют приём, только если граф его не отверг (gate). Ближнее оружие — по урону в секунду против его брони.
    if (prof.player && ready('calcPlan')) {
      rest('calcPlan', 5 * TICK_MS)
      try {
        const obs = co.observe(bot, entity, { tracker: calc, since: Math.round((now - lastSwing) / TICK_MS), shieldOffTicks: Math.round((foe.shieldOff(entity) || 0) / TICK_MS) })
        obs.storm = thundering(bot)
        obs.foeSky = obs.storm ? skyOver(entity) : false
        // Булава с падения: взлёт зарядом ветра — подъём и спуск ~28 тиков, высота по потолку (mace.smashPlan).
        try { const smp = findItem(bot, i => i.name === 'mace') ? mace.smashPlan(bot, entity) : null; if (smp) obs.smash = { h: smp.h, ticks: 28 } } catch {}
        const cp = require('./pvp/kill-planner').planAttack(obs, { depth: 3 })
        const opts = []
        if (GRAPH && sky.ON !== false) {
          const sp0 = spear.spearOf(bot)
          if (sp0 && require('./combat/aerial-lance').lancePlan(bot, entity, { d, hp, hisShield: obs.foe.blocking })) opts.push(fg.lanceOption(obs, sp0.item.name, bot._ndFightXp || (bot._ndFightXp = {})))
          const dv = findItem(bot, i => i.name === 'mace') && findItem(bot, i => i.name === 'elytra') ? 12 : 0
          if (dv) opts.push(fg.diveOption(obs, dv, bot._ndFightXp || (bot._ndFightXp = {})))
        }
        gp = fg.decide(obs, cp, opts)
        st.calc = st.calc || { plans: 0, kinds: {} }
        st.calc.plans++
        if (cp && cp.action) {
          st.calc.kinds[cp.action.kind] = (st.calc.kinds[cp.action.kind] || 0) + 1
          st.calc.last = { why: cp.why, pKill: cp.pKill != null ? Math.round(cp.pKill * 100) / 100 : null, hp: cp.hp ? [Math.round(cp.hp.lo), Math.round(cp.hp.hi)] : null, graph: gp.why }
        }
        if (gp.pick) { st.calc.picks = st.calc.picks || {}; st.calc.picks[gp.pick] = (st.calc.picks[gp.pick] || 0) + 1 }
        if (GRAPH) {
          const mc0 = fg.meleeChoice(obs)
          // Щит: топор — ударом-свапом в тик удара (melee.FAST_AXE, заряд меча не теряется), не сменой в руке.
          const want = mc0 && !mc0.shield ? mc0.item : null
          if (want && want !== chosenWeapon) {
            chosenWeapon = want
            st.calc.weapons = st.calc.weapons || {}
            st.calc.weapons[want] = (st.calc.weapons[want] || 0) + 1
            // Сменить в руке, только если сейчас в руке меч/топор/пусто (копьё, булава, удочка — у своих веток).
            const hn = bot.heldItem ? bot.heldItem.name : null
            if (!hn || /_(sword|axe)$/.test(hn)) await holdWeapon()
          }
        }
        // След решения — в трассу боя (не в used: метка не должна перехватывать урон приёма в trickDmg).
        if (process.env.ND_TRACE_PVP && gp.pick && gp.pick !== st.lastPick) {
          st.lastPick = gp.pick
          try { console.log(`[trace] ${new Date().toISOString().slice(11, 19)} ${bot.username} +${((gameClock.now() - traceT0) / 1000).toFixed(1)}s граф: ${gp.why} | ${gp.scores.slice(0, 3).map(x => x.kind + ' ' + x.value).join(', ')}`) } catch {}
        }
      } catch (err) { st.calcErr = String(err && err.message || err).slice(0, 120) }
    }
    const seesBody = raySees(bot, eye, entity.position.offset(0, (entity.height || 1.8) * 0.55, 0))
    // Где я его видел в последний раз (S7d, ревью Codex: честность — позиция из пакетов сущности идёт и сквозь стену):
    // точка прострела и «столб к его столбу» считают от увиденного, а не от свежего пакета.
    if (seesBody) foeSeenPos = entity.position.clone()
    // Честный прицел (pick.js, 2026-09-26: «боты через один блок пробивают»).
    const sight = r <= HIT_REACH + 0.3 ? pick.aim(bot, entity, { eye: pick.eyeOf(bot), range: HIT_REACH }) : null
    const inSight = !!(sight && sight.point)
    sightOff = inSight ? sight.off : null
    // в руке, но под прицел не взять — тоже: стенка его коробки вплотную).
    const hidden = prof.player && (!seesBody || (r <= HIT_REACH && !inSight)) && d <= FAR + 2 && !(hm && hm.hiding())
    const theyUp = dy > 2.5 && r > HIT_REACH && foeGrounded()
    const busyFoe = prof.player && (theyEat || hidden || theyUp)
    const pressing = FIX && prof.player && now - quiet.at > style.pressMs && !fortSealed() && !perch && !(hp <= 8 && !!healItem())
    if (pressing && !st.pressOn) { st.pressOn = true; st.pressure = (st.pressure || 0) + 1; bowFirstUntil = 0; used('нажим: долго без размена — иду бить') } else if (!pressing) st.pressOn = false
    const meBelow = !!AR && me.y < AR.y - 1.5
    const meOut = !!AR && (meBelow || !onField(me))
    const heOut = !!AR && prof.player && !onField(entity.position) && entity.position.y < AR.y - 2.5
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
    if (meBelow && prof.player && !edges.falling(bot) && ready('climbBack')) {
      rest('climbBack', 2500)
      if (pathing) { pathTo(false); pathing = false }
      clear()
      aim = 'free'
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
        const gK: any = buildGuard()
        let cb = null
        try { cb = await edges.climbBack(bot, guardCtl(gK), entity, { beforeStep: towerShield, archer: bowWatch.shots > 0 || !!findItem(bot, i => i.name === 'bow' || i.name === 'crossbow'), floorY: AR.y, exclude: badShafts, digNear: 12000 }) } catch (e) { cb = { ok: false, why: e.message } }
        if (buildDone(gK, 'подъём на поле')) cb = { ok: false, why: gK.why }
        if (cb && !cb.ok && cb.shaft && /не дошёл|не выломал|не растёт|не подпрыгнул/.test(cb.why || '')) for (let ax = -2; ax <= 2; ax++) for (let az = -2; az <= 2; az++) badShafts.add((cb.shaft.x + ax) + ',' + (cb.shaft.z + az))
        if (cb && cb.ok) st.returns = (st.returns || 0) + 1
        used(cb && cb.ok ? `вернулся на поле (${cb.how}, ${Math.round((gameClock.now() - t0c) / 1000)} с)` : `не вернулся: ${(cb && (cb.why || cb.how)) || '?'}`)
      }
      aim = 'target'
      await holdWeapon()
      continue
    }
    const maceThreat = prof.player ? mc.threat() : null
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
              jump: 'auto', // S6b pearl-jump: в прыжке дальше, если с места цель не достать
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
    const skyThreat = prof.player ? sky.threat() : null
    if (bracing && (!skyThreat || gameClock.now() - bracing > 3000)) { bracing = 0; try { bot.deactivateItem() } catch {} }
    // Он летит на нас (пике/таран): копьё в руку, взгляд на него и «использовать» — задержка копья должна кончиться
    // до встречи. Урон разгона ему = 1 + floor(rel·mult), rel = −(наш взгляд · его скорость)·20 (KineticWeapon, javap):
    // на его 1.5 б/т — ~29 до брони. Наш щит/уклон — если копья нет или поздно.
    const braceWith = skyThreat && !bracing && !meInWeb ? spear.spearOf(bot) : null
    if (braceWith && skyThreat.eta >= Math.round(braceWith.spec.delay * 20) + 1 && skyThreat.eta <= 30) {
      if (pathing) { pathTo(false); pathing = false }
      for (const x of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(x, false)
      try {
        if (bot.heldItem?.name !== braceWith.item.name) await bot.equip(braceWith.item, 'hand')
        const q = skyThreat.at || entity.position
        const ey = pick.eyeOf(bot)
        await bot.look(Math.atan2(-(q.x - ey.x), -(q.z - ey.z)), Math.atan2(q.y + 0.3 - ey.y, Math.hypot(q.x - ey.x, q.z - ey.z)), true)
        if (bot.heldItem?.name === braceWith.item.name) { bot.activateItem(); bracing = gameClock.now(); used('копьё на изготовку против тарана') }
      } catch {}
      await sleep(TICK_MS)
      continue
    }
    if (bracing && skyThreat) {
      // Держим и ведём взгляд за ним (луч копья 2.0–4.5 по взгляду).
      const q = sky.fl.at(2) || entity.position
      const ey = pick.eyeOf(bot)
      bot.look(Math.atan2(-(q.x - ey.x), -(q.z - ey.z)), Math.atan2(q.y + 0.3 - ey.y, Math.hypot(q.x - ey.x, q.z - ey.z)), true).catch(() => {})
      await sleep(TICK_MS)
      continue
    }
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
      rest('boomDef', 500)
    }
    if (prof.player && blockName(bot, me.floored()) !== 'cobweb' && !perch && !fort && ready('crystal') && cx.engaged()) {
      rest('crystal', 60)
      const ca0 = cx.plan({ vel: track.vel(), press: pressing })
      // Кристалл/якорь — расходник: калькулятор нашёл дешёвое добивание (удар/выстрел, худший исход попадания > верха
      // оценки его хп) — взрывчатку не тратим (kill-planner: «кулак добивает — кристалл не тратим»).
      const cheapKill = GRAPH && gp && gp.plan && /^добиваю/.test(gp.plan.why || '') && !/^(crystal|anchor)$/.test(gp.plan.action.kind)
      const ca = ca0 && /^(place|place-hit|place-shoot|anchor|obby)$/.test(ca0.kind) && cheapKill ? (noteGate('кристалл: добиваю дешевле'), null) : ca0
      const react = !ca || !/^(defuse|dodge|shield|cover|wall|anchorPop)$/.test(ca.kind) || after('crystalSeen', true, style.reactMs)
      if (!ca) delete noticed.crystalSeen
      if (ca && react) {
        if (guard) await guard.raise(false)
        if (pathing) { pathTo(false); pathing = false }
        clear()
        aim = 'free'
        const beforeC = heldName()
        let rc = null
        // Учёт блоков (block-log): что ставит/ломает ветка кристаллов — по виду плана.
        const CXT = { obby: 'обсидиан под кристалл', surround: 'обсидиан вокруг ног', wall: 'заслон от взрыва (блок между)', cover: 'укрытие от взрыва', anchor: 'якорь у его ног', place: 'кристалл', 'place-hit': 'кристалл', 'place-shoot': 'кристалл' }
        bot._ndBlockTag = CXT[ca.kind] ? { what: CXT[ca.kind], at: gameClock.wall.now() } : null
        try { rc = await cx.run(ctl, ca, { stepSafe: dir => stepSafe(bot, dir), stop: () => FIX && maceNow() }) } catch (e) { rc = { note: 'кристаллы: ' + e.message } } finally { bot._ndBlockTag = null }
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
    if (ready('dressMid') && theirR > HIT_REACH + 1 && bot.inventory.items().some(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name))) {
      rest('dressMid', 4000)
      const worn = [5, 6, 7, 8].filter(s => bot.inventory.slots[s]).length
      // Элитры на груди, а я на земле (сел после полёта, нагрудник не вернулся) — тоже переодеться (S7d, ревью Codex
      // №2); в воздухе armor.planSwaps элитры не трогает.
      const wingsOnGround = bot.entity.onGround && !bot.entity.elytraFlying && bot.inventory.slots[6]?.name === 'elytra'
      if (worn < 4 || wingsOnGround) {
        try { const r = await require('./armor').equipBestArmor(session, ctl, { confirmMs: 300 }); if (r && r.equipped && r.equipped.length) used('надел броню в бою') } catch {}
      }
    }
    if (prof.player && ready('rebuff') && !(FIX && (pressing || punishable() || (!fortSealed() && !!tt.state(entity).consuming))) && (tempo.ON ? tt.safe(tempo.consumeMs('potion'), { fortSealed: fortSealed() }).ok : (theirR > 5 || busyFoe || fort || perch))) {
      rest('rebuff', FIX ? 2500 + Math.random() * 2500 : 3000)
      const KIND = { strength: 'strength', speed: 'swiftness', regeneration: 'regeneration' }
      const lack = (Object.entries(KIND) as [string, any][]).some(([e, k]) => !hasEffect(bot, e) &&
        findItem(bot, i => /potion$/.test(i.name) && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k))
      if (lack) await buffUp(fort || perch ? 0 : 4.5, fort ? [['turtle_master', 'resistance']] : [])
    }
    if (prof.player && duo.active()) {
      const dz = duo.decide({ entity, charge: mf.clock.charge(0), justSwung: now - lastSwing < 250, hp, hasAxe: !!findItem(bot, i => /_axe$/.test(i.name)), meInWeb: blockName(bot, me.floored()) === 'cobweb', perch: !!perch, fort: !!fort, cooldownLeft: mf.clock.leftMs(1) })
      if (dz && dz.kind === 'focus' && dz.e !== entity) { duo.switched(entity, dz.e, dz.why); switchedAt = now; retarget(dz.e); await holdWeapon(); await new Promise<any>(resolve => setImmediate(resolve)); continue }
      if (dz && dz.kind === 'reset') { if (pathing) { pathTo(false); pathing = false } clear(); const rr = await duo.runReset(ctl, dz); if (rr.pick && rr.pick !== entity) retarget(rr.pick); continue }
      if (dz && dz.kind === 'web' && (await duo.webSecond(dz.e))) continue
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
        const oLow = (foeHpDecide(o.e) ?? 20) + 6 < (theirHp ?? 20)
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
    if (ready('arrowRun') && !fort && !perch && !(FIX && (pressing || punishable())) && bot.inventory.items().some(i => i.name === 'bow' || i.name === 'crossbow')) {
      rest('arrowRun', 600)
      const lying = arrows.plan(bot, { enemy: entity, busy: busyFoe, hp })
      if (lying) {
        if (pathing) { pathTo(false); pathing = false }
        // И прицел: aimTimer каждый тик разворачивает голову к нему, а
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

    const cooldownLeft = mf.clock.leftMs(1)

    if (calmAfterMs && now - lastHurtByTarget > calmAfterMs && d > 8) {
      return finish({ calmed: true, why: `${label} не бьёт ${Math.round((now - lastHurtByTarget) / 1000)}с и отошёл` })
    }

    for (let i = pendingLava.length - 1; i >= 0; i--) {
      if (now - pendingLava[i].at > 1500) {
        const cell = pendingLava.splice(i, 1)[0].cell
        await scoop(cell)
        await holdWeapon()
      }
    }
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
      if (cutOne <= 2500) opts.push({ how: 'cut', busyMs: cutOne, freeMs: cutAll })
      const inReach = r <= HIT_REACH + 0.5
      const score = o => o.freeMs + (inReach ? o.busyMs : 0)
      webPlan = (onFire(bot) && opts.find(o => o.how === 'water')) || opts.sort((a, b) => score(a) - score(b) || (a.how === 'cut' ? -1 : 1))[0] || null
    }
    // Голова в паутине — прицел упирается в неё саму (VoxelShape.clip: глаза
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
      aim = 'free'
      const stop = await digWatch(bot.blockAt(webCells[0]), () => (prof.player && mc.threat()) ? 'булава летит' : null)
      aim = 'target'
      if (stop) used(`бросил резать паутину: ${stop}`)
      else if (blockName(bot, webCells[0]) !== 'cobweb') { used(`разрезал паутину (${heldName()})`); st.cutFails = 0 } else if (++st.cutFails >= 2) {
        rest('cutweb', 3000)
        st.cutFails = 0
      }
      await holdWeapon()
      continue
    }
    // Он в руке, но прицел упирается в паутину между нами или у его головы
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
    if (onFire(bot) && !bot.entity.isInWater && !hasEffect(bot, 'fire_resistance') && ready('toWater')) {
      rest('toWater', 2500)
      const waterId = bot.registry.blocksByName.water && bot.registry.blocksByName.water.id
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
    if (meInWeb && (!webPlan || webSafe)) {
      clear()
      const out = ['back', 'left', 'right'].find(k => stepSafe(bot, keyDir(bot, k)))
      if (out) set(out, true)
    }

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

    
    const archer = theyBow || prof.ranged
    const calmHeal = busyFoe && d > 3.5 && hp < 16 && !!healItem()
    const mobCrowd = !prof.player && (flee.hostilesAround(bot, 8).length >= 2 || hp <= 8)
    const needSafeEat = tempo.ON && prof.player && hp <= healAt && !!healItem() && !tt.safe(tempo.consumeMs('golden_apple')).ok
    if (!lastStand && !fort && ready('fort') && hp <= style.fortAt && !busyFoe && !meInWeb && !perch && !cx.dominant() &&
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
      const desperate = tempo.ON && prof.player && hp <= 6 && ((meInWeb && !webSafe) || gameClock.now() - (st.corneredAt || 0) < 3000)
      const turtle = desperate ? findItem(bot, i => i.name === 'potion' && /turtle_master$/.test(potionOf(i) || '')) : null
      const gapple = findItem(bot, i => i.name === 'enchanted_golden_apple') ||
        (!absorbing && findItem(bot, i => i.name === 'golden_apple'))
      const potion = findPotion(bot, 'potion', 'heal') || findPotion(bot, 'potion', 'regen')
      const food = !gapple && !potion && (bot.food ?? 20) < 18 &&
        findItem(bot, i => /cooked_|bread|baked_potato|golden_carrot/.test(i.name))
      const punFirst = FIX && !desperate && hp > 8 && !!punishable()
      if (punFirst) { st.eatPunish.skips = (st.eatPunish.skips || 0) + 1; if (ready('punFirstNote')) { rest('punFirstNote', 3000); used('не ем — он сам ест или пьёт, наказываю') } }
      const candidate = punFirst ? null : (desperate && (findItem(bot, i => i.name === 'enchanted_golden_apple') || turtle)) || gapple || potion || food
      const pick = lastStand && candidate && !tt.safe(tempo.consumeMs(candidate.name)).ok ? null : candidate
      if (pick) {
        rest('heal', 2500)
        const web = findItem(bot, i => i.name === 'cobweb')
        let walled = 0
        if (web && theirR < 4.5 && !archer && ready('web')) { rest('web', 5000); await placeUnder(web, 'паутина перед едой') }
        else if ((theirR < 5 || archer || (FIX && seesBody && d < 24)) && !theyUp && ready('wall') && (!FIX || desperate || tt.safe(tempo.consumeMs(pick.name) + (archer ? COVER_WIDE_MS : COVER_MS)).ok)) {
          rest('wall', 3000)
          walled = await coverFrom(entity.position, archer
            ? { wide: true, what: 'стенка 3×2 от лучника перед едой' }
            : { what: 'колонка перед едой' })
        }
        if (tempo.ON && prof.player && !desperate && !tt.safe(tempo.consumeMs(pick.name)).ok) {
          tt.stats.refused++
          if (ready('refuseNote')) { rest('refuseNote', 3000); used('не ем под ударами — отрываюсь') }
          let how = 'в паутине'
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
            if (how === 'некуда' || how === 'догнал') st.corneredAt = gameClock.now()
          }
          if (how !== 'оторвался') {
            st.kiteFails = (st.kiteFails || 0) + 1
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
        if (!(archer && walled)) {
          set('back', stepSafe(bot, keyDir(bot, 'back')))
          set(strafeKey, stepSafe(bot, keyDir(bot, strafeKey)))
        }
        if (pick.name === 'potion') await drink(pick, 'выпил ' + (potionOf(pick) || 'зелье'), null, { desperate })
        else if (await pvpSkills.consumeItem(pick, null, { desperate })) { used('съел ' + pick.name); st.healed.push(pick.name) }
        clear()
        await holdWeapon()
        continue
      }
    }

    const canHeal = !!(findPotion(bot, 'splash_potion', 'heal') || findPotion(bot, 'potion', 'heal') ||
      findItem(bot, i => /golden_apple$/.test(i.name)))
    if (!lastStand && !prof.player && hp <= retreatAtHealth && !canHeal) {
      return finish({ lowHealth: true, health: Math.round(hp) })
    }
    if (!lastStand && prof.player && ready('chorusEsc') && hp <= Math.max(retreatAtHealth, 9)) {
      rest('chorusEsc', 1500)
      aim = 'free'
      const cr = (await util.chorusMaybe(ctl, { hp, foes: duo.foes(), trapped: meInWeb && !webSafe ? 'паутина' : myPit ? 'яма' : null, pearls: countOf(bot, 'ender_pearl'), canHeal, pearlAt: Math.max(retreatAtHealth, 9), burst: totemMod.burstOf(bot, entity) })) ||
        (hp <= 6 && duo.foes().length >= 2 ? await util.riptideAway(duo.foes(), ctl) : null)
      aim = 'target'
      if (cr && cr.ok) { await holdWeapon(); continue }
    }
    const pearlAt = Math.max(retreatAtHealth, 9)
    const pearlForSpace = tempo.ON && prof.player && canHeal && !tt.safe(tempo.consumeMs('golden_apple')).ok && !(FIX && (st.pearlSpace || 0) >= 2)
    if (!lastStand && prof.player && hp <= pearlAt && hp > 6 && (!canHeal || pearlForSpace)) {
      const pearl = findItem(bot, i => i.name === 'ender_pearl')
      if (pearl && ready('pearl')) {
        const r = await escapePearl()
        if (r && r.thrown) {
          if (pearlForSpace) { st.pearlSpace = (st.pearlSpace || 0) + 1; rest('heal', 0); await holdWeapon(); continue }
          const f = pickFiller(bot)
          if (!f || countOf(bot, f.name) < perchHeight()) {
            return finish({ retreated: true, mode: 'ушёл жемчугом', health: Math.round(bot.health ?? 0) })
          }
          await holdWeapon()
          continue
        }
      }
    }

    if (!lastStand && prof.player && !perch && hp <= pearlAt && !canHeal && d > 12 && !theyBow && ready('pillar')) {
      rest('pillar', 6000)
      if (await pillarOut()) continue
    }
    if (perch) {
      const noArrows = !findItem(bot, i => /arrow$/.test(i.name)) || !findItem(bot, i => i.name === 'bow' || i.name === 'crossbow')
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

    const inc = threats.incoming(bot).filter(p => p.ticks <= 12)
    if (perch && bot.entity.position.y >= perch.top - 1.2 && (theyBow || inc.some(x => /arrow|trident/.test(x.name)))) {
      if (now >= strafeFlipAt) { strafeKey = strafeKey === 'left' ? 'right' : 'left'; strafeFlipAt = now + 150 + Math.random() * 250 }
      set('sneak', true)
      set('left', strafeKey === 'left'); set('right', strafeKey === 'right')
      if (ready('perchDanceNote')) { rest('perchDanceNote', 4000); used('пританцовываю на столбе от стрел') }
    } else if (perch) set('sneak', false)

    const ball = inc.find(p => p.name === 'fireball' && reachFrom(eye, p.entity) <= 3.2) ||
      (() => {
        const f = (Object.values(bot.entities) as any[]).find((e : any) => e && e.name === 'fireball' && e.position && reachFrom(eye, e) <= 3.2)
        return f ? { entity: f, name: 'fireball' } : null
      })()
    if (ball && ready('deflect')) {
      rest('deflect', 150)
      const ghast = entity.name === 'ghast' ? entity
        : bot.nearestEntity(e => e && e.name === 'ghast' && e.position && e.position.distanceTo(me) < 64)
      aim = 'free'
      try {
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

    const arrowIn = inc.find(p => /arrow|trident/.test(p.name) && p.ticks >= 4)
    if (arrowIn && hp <= healAt + 2 && ready('wall') && pickFiller(bot)) {
      rest('wall', 2500)
      const from = me.minus(new Vec3(arrowIn.vel.x, 0, arrowIn.vel.z).normalize().scaled(4))
      if (await coverFrom(from, { wide: true, what: 'стенка от стрел' })) { await holdWeapon(); continue }
    }

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
    if (inc.length && now > dodgeUntil) {
      const key = threats.dodgeKey(bot, inc[0], k => stepSafe(bot, keyDir(bot, k)))
      if (key) {
        dodgeKey = key
        dodgeUntil = now + 350
        st.dodges++
      }
    }
    const aimedCb = prof.player && seesBody ? foe.aimedAtMe(entity) : null
    // стойка showman под прицелом отпускает тело). Замер try-xbow hisxbow с
    // Держать щит, пока прицел на нас, и ещё 400 мс после (он ведёт прицел
    const cbNow = !!(aimedCb && !aimedCb.piercing && guard && guard.stats && guard.stats.worn && r > HIT_REACH && d <= FAR)
    if (cbNow) cbShieldUntil = now + 400
    const hisCb = prof.player ? (read.crossbowInfo(bot, entity.equipment && entity.equipment[0]) || read.crossbowInfo(bot, entity.equipment && entity.equipment[1])) : null
    const cbShield = cbNow || (now < cbShieldUntil && !!(hisCb && hisCb.loaded && !hisCb.piercing) && r > HIT_REACH && !!(guard && guard.stats && guard.stats.worn))
    // с 9 бл. летит 3 тика: при ходе вбок 0.2 бл/тик прицел «в нас сейчас»
    // придётся доводить прицел заново.
    if (aimedCb && !cbShield && now > dodgeUntil) {
      const flip = Math.random() < 0.5 ? (strafeKey === 'left' ? 'right' : 'left') : strafeKey
      const key = stepSafe(bot, keyDir(bot, flip)) ? flip : (stepSafe(bot, keyDir(bot, strafeKey)) ? strafeKey : null)
      if (key) { dodgeKey = key; strafeKey = key; dodgeUntil = now + 550 + Math.random() * 450; strafeFlipAt = dodgeUntil; st.dodges++ }
      if (ready('cbAimNote')) { rest('cbAimNote', 3000); used(`его заряженный арбалет на мне (${aimedCb.ammo || '?'}${aimedCb.piercing ? ', «Пронзание»' : ''}) — схожу с линии`) }
    }

    if (myPit && !theirPit && r > HIT_REACH && ready('pitOut')) {
      rest('pitOut', 2500)
      if (await climbOut(myPit)) continue
    }
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

    if (dy > 6 && foeGrounded()) { if (!st.highSince) st.highSince = now } else st.highSince = 0
    if (!AR && prof.player && dy > 6 && st.highSince && now - st.highSince > 1500 && !perch && d < 90 && ready('climbBack')) {
      rest('climbBack', 5000)
      pathTo(false); pathing = false
      clear()
      aim = 'free'
      const t0c = gameClock.now()
      let cb = null
      const gK: any = buildGuard()
      try { cb = await edges.climbBack(bot, guardCtl(gK), entity, { beforeStep: towerShield, archer: bowWatch.shots > 0 || !!findItem(bot, i => i.name === 'bow' || i.name === 'crossbow') }) } catch (e) { cb = { ok: false, why: e.message } }
      if (buildDone(gK, 'подъём к нему')) cb = { ok: false, why: gK.why }
      aim = 'target'
      await holdWeapon()
      used(cb && cb.ok ? `поднялся к нему (${cb.how}, ${Math.round((gameClock.now() - t0c) / 1000)} с)` : `не поднялся: ${(cb && (cb.why || cb.how)) || '?'}`)
      if (process.env.ND_DEBUG_PVP) console.log('[climb]', JSON.stringify(cb))
      continue
    }

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
        const cEat = /^он (ест|пьёт)$/.test(pun.why) ? tt.state(entity).consuming : null
        if (cEat && cEat.since !== st.eatPunish.at) { st.eatPunish.at = cEat.since; st.eatPunish.tries++ }
        if (ready('punNote:' + pun.kind)) {
          rest('punNote:' + pun.kind, 2500)
          tt.punished(pun.kind)
          used(`наказываю (${pun.why}): ${({ harm: 'зелье вреда', rush: 'рывок', bow: 'стрела', step: 'шаг внутрь' })[pun.kind]}`)
        }
        if (pun.kind === 'harm' && harm && ready('punHarm')) {
          rest('punHarm', 1500)
          if (await throwAt(harm, 'зелье вреда в занятого')) { splashAt = gameClock.now(); backOffUntil = splashAt + 700; await holdWeapon(); continue }
        }
        // «Вред» брошен — рывок к нему только когда бутылка разбилась (S7d: репетиция «арсенал» — бросок и сразу рывок
        // «на занятого» в зону всплеска своего «вреда II»: «killed by … using magic»; ревью Codex по jar — всплеск
        // задевает и бросившего, щит зелье не отражает).
        punRush = pun.kind === 'rush' || (pun.kind === 'harm' && gameClock.now() - splashAt > 700)
        punBow = pun.kind === 'bow'
        punStep = pun.kind === 'step' && cooldownLeft < pun.left
      }
    }

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

    if (prof.player && sky.gliding() && !meInWeb && r > HIT_REACH) {
      if (pathing) { pathTo(false); pathing = false }
      const bowA = findItem(bot, i => i.name === 'bow')
      const arrA = findItem(bot, i => /arrow$/.test(i.name))
      const d3 = me.distanceTo(entity.position)
      const airPoint = (t) => { const q = sky.fl.at(Math.max(0, t)); return q ? q.offset(0, .3, 0) : entity.position.offset(0, .3, 0) }
      const stopAirShot = () => ctl.aborted || !sky.gliding() || !!sky.threat() || (FIX && maceNow())
      const airCrossbow = ranged.crossbows(bot).find(x => x.info.loaded && x.info.ammo !== 'firework')
      if (rangedAllowed() && airCrossbow && d3 >= 4 && d3 < 48 && seesBody && ready('xbowAir')) {
        rest('xbowAir', 300)
        if (guard) await guard.raise(false)
        aim = 'free'
        const airShot = await ranged.fire(bot, entity, airCrossbow.item, { point: airPoint, shouldStop: stopAirShot,
          onHit: () => { st.arrowHits = (st.arrowHits || 0) + 1; sky.fl.st.hits++ } })
        aim = 'target'
        if (airShot.fired) { used('арбалет по летуну на элитрах'); st.arrows = (st.arrows || 0) + 1; sky.fl.st.shots++; continue }
      }
      if (rangedAllowed() && bowA && arrA && d3 >= 4 && d3 < 48 && seesBody && ready('bowAir')) {
        rest('bowAir', 300)
        if (guard) await guard.raise(false)
        clear()
        aim = 'free'
        const beforeA = heldName()
        let sideA = Math.random() < 0.5 ? 'left' : 'right'
        let flipA = gameClock.now() + 300 + Math.random() * 400
        const shotA = await bowShoot(bot, entity, {
          point: airPoint,
          follow: false,
          onHit: () => { st.arrowHits = (st.arrowHits || 0) + 1; sky.fl.st.hits++ },
          shouldStop: stopAirShot,
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
    const xbAmmo = !!(findItem(bot, i => /arrow$/.test(i.name)) || findItem(bot, i => i.name === 'firework_rocket'))
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
    const xbLoadSafe = (ms) => {
      if (gameClock.now() - tt.myHurtAt < 300) return false
      const gap = Math.max(0, theirR - tempo.PLAYER_REACH)
      return (gap / tempo.SPRINT_BPT) * TICK_MS >= ms - 250
    }
    if (rangedAllowed() && prof.player && !meInWeb && ready('xbow') && findItem(bot, i => i.name === 'crossbow')) {
      rest('xbow', 200)
      let xSide = strafeKey
      let xFlip = now + 300 + Math.random() * 400
      // «Добиваю» (ranged.plan) — по верху оценки его хп, не по метаданным.
      const fsX = co.isPlayer(entity) ? { ...foe.state(entity), ehp: foeEst().hi } : foe.state(entity)
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
      if (!loadedX && toMeK > 0.12 && d < 9 && !xbLoadSafe(10 * TICK_MS + 350) && pickFiller(bot) && ready('xbCover')) {
        rest('xbCover', 2500)
        const put = await coverFrom(entity.position, { what: 'арбалет: стенка между нами — заряжаю за ней' })
        if (put) { rest('xbow', 0); await holdWeapon(); continue }
      }
      if (guard && guard.stats && guard.stats.worn) {
        if (theyBow && !loadedX && seesBody) { guard.raise(true); if (ready('bowShieldNote')) { rest('bowShieldNote', 4000); used('щит от стрелы') } } else guard.raise(false)
      }
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

    const noMelee = !findItem(bot, i => /_(sword|axe)$/.test(i.name))
    const bowRange = theirPit ? 1.2 : theyUp ? 1.5 : noMelee ? 2.5 : perch ? 3 : prof.player ? FAR : prof.ranged ? 12 : 6
    const bowItem = rangedAllowed() ? findItem(bot, i => i.name === 'bow') : null
    const arrowItem = findItem(bot, i => /arrow$/.test(i.name))
    const dBow = prof.flying || theyUp ? me.distanceTo(entity.position) : d
    const sees = seesBody
    if (process.env.ND_DEBUG_PVP && now - (st.dbgAt || 0) > 1000) {
      st.dbgAt = now
      console.log('[pvp]', JSON.stringify({ t: label, d: Math.round(d * 10) / 10, dBow: Math.round(dBow * 10) / 10, dy: Math.round(dy), hp: Math.round(hp), r: Math.round(r * 10) / 10, theirR: Math.round(theirR * 10) / 10, cd: cooldownLeft, iframes: Math.max(0, targetHurtAt + 500 - now), blocking, meInWeb, pathing, held: heldName(), swings: st.swings, bow: !!bowItem, arrows: !!arrowItem, sees, range: bowRange, ready: ready('bow'), flying: !!prof.flying }))
    }
    // Стрелы не обгоняют его лечение (S7d, s7d-e-29p «только якоря»: 5 ничьих из 5 — 7 мин перестрелки на 20–47 бл.,
    // попадание 1.6–2.5 раз в 3–5 с, а у него регенерация и 12 яблок): за последние 20 с стрельбы (≥ 4 выстрела) моя
    // оценка его хп (середина: попадания вниз, его видимое лечение и регенерация в границах насыщения вверх) не
    // опустилась хоть на 1 — лук не двигает бой, сближаюсь (якорь, кристалл, ближний). На исходе (верх ≤ 8) — стреляю.
    let arrowsStall = false
    if (prof.player && dBow > 8 && !!findItem(bot, i => /_(sword|axe)$/.test(i.name) || i.name === 'mace')) {
      try {
        const eB = foeEst()
        const pr = st.bowProg || (st.bowProg = [])
        if (!pr.length || now - pr[pr.length - 1].at > 1000) pr.push({ at: now, mean: eB.mean, shots: st.arrows || 0, apples: calc.seenApples || 0 })
        while (pr.length > 2 && now - pr[1].at >= 20000) pr.shift()
        const old = pr[0]
        // Увиденные съеденные им яблоки — тоже прогресс лука (ревью Codex): стрелы заставили тратить запас.
        if (now - old.at >= 20000 && (st.arrows || 0) - old.shots >= 4) arrowsStall = eB.hi > 8 && eB.mean > old.mean - 1 && (calc.seenApples || 0) === old.apples
      } catch {}
      if (arrowsStall && ready('arrowsStallNote')) { rest('arrowsStallNote', 8000); st.arrowsStall = (st.arrowsStall || 0) + 1; used('стрелы не обгоняют его лечение — сближаюсь') }
    }
    const bowPointless = (arrowsWeak || arrowsStall || cx.dominant()) && !theyUp && !perch && !theirPit
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
      let prepB = { drawMs: null, why: null }
      if (prof.player) {
        const fsB = co.isPlayer(entity) ? { ...foe.state(entity), ehp: foeEst().hi } : foe.state(entity)
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
        holdWhile: prof.player ? () => mace.shieldAtUs(bot, entity) : null,
        onHit: () => { st.arrowHits = (st.arrowHits || 0) + 1 },
        shouldStop: () => ctl.aborted || entity.position.distanceTo(bot.entity.position) < closeAt ||
          (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'fireball' && e.position && e.position.distanceTo(bot.entity.position) < 7) || (theyUp && reachFrom(bot.entity.position.offset(0, EYE, 0), entity) <= HIT_REACH) || (FIX && maceNow()),
        onDraw: () => {
          track.update()
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
      if (shot.blocked) {
        rest('bow', 2500)
        repositionUntil = gameClock.now() + 2500
        if (!st.blockedShots) used('стена на линии — обхожу')
        st.blockedShots = (st.blockedShots || 0) + 1
      }
      await holdWeapon()
      continue
    }

    if (prof.player && !perch && !fort && !meInWeb && ready('utility')) {
      rest('utility', 150)
      aim = 'free'
      const ua = await util.step({ entity, d, dy, r, hp, foeHp: foeHpDecide(entity), sees: seesBody, theyUp, blocking, busy: tt.state(entity), vel: () => track.vel(), others: duo.foes().filter(e => e !== entity), ctl, allow: (k) => gate(k) })
      aim = 'target'
      if (ua) { if (ua.rush) rushUntil = gameClock.now() + 1500; await holdWeapon(); continue }
    }

    if (hm && prof.player && bot.entity.onGround && !bot.entity.elytraFlying && (await hm.pre({
      now, d, dy, r, theirR, hp, theirHp, theyBow, blocking, seesBody, busyFoe, meInWeb, cooldownLeft,
      perch: !!perch, fort: !!fort, incoming: inc.length, vel: track.vel(), others: !!otherAttacker(),
      openRush: now < rushUntil, punRush, cbAimed: !!aimedCb || cbShield, press: pressing
    }))) { await sleep(TICK_MS); continue }

    if (hidden && !perch && after('hidden', true) && punches < style.punchLimit && ready('punch')) {
      if (await punchThrough()) { punches++; continue }
    }
    if (!hidden) delete noticed.hidden
    if (hidden && !perch && punches >= style.punchLimit && ready('punchGiveUp')) {
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

    if (theyUp) { if (!theyUpSince) theyUpSince = now } else theyUpSince = 0
    const upLong = theyUpSince && now - theyUpSince > 6000
    // Сломать опору под ним (S7d, пункт G): он стоит выше (столб, уступ), блок под его ногами виден, в досягаемости,
    // ломается быстро (время копки 1.21.11 — bot.digTime лучшим инструментом) и сам я не под его ударом —
    // сломать: он падает (с высоты > 3 — урон), теряет высоту. Иначе — дороже, чем ждать/стрелять/строить свой столб.
    if (prof.player && dy >= 1.4 && foeGrounded() && theirR > 3.3 && !perch && !fort && !meInWeb && ready('breakUnder')) {
      rest('breakUnder', 700)
      try {
        const cell = entity.position.offset(0, -0.5, 0).floored()
        const blk = bot.blockAt(cell)
        const eyeP = bot.entity.position.offset(0, EYE, 0)
        const myCell = bot.entity.position.offset(0, -0.5, 0).floored()
        const hw = (entity.width || 0.6) / 2
        // Он на этой клетке целиком (иначе стоит ещё на соседней — ломать бесполезно).
        const onlyThis = Math.floor(entity.position.x - hw + 0.01) === cell.x && Math.floor(entity.position.x + hw - 0.01) === cell.x &&
          Math.floor(entity.position.z - hw + 0.01) === cell.z && Math.floor(entity.position.z + hw - 0.01) === cell.z
        if (blk && blk.boundingBox === 'block' && blk.diggable !== false && onlyThis && !cell.equals(myCell) &&
            eyeP.distanceTo(cell.offset(0.5, 0.5, 0.5)) <= 4.4 && pick.blockSeen(bot, cell) && !/obsidian|bedrock|barrier|crying/.test(blk.name)) {
          const tool = (() => { try { return bot.pathfinder.bestHarvestTool(blk) } catch { return null } })()
          if (tool && bot.heldItem?.name !== tool.name) await holdItem(tool)
          let ms = Infinity
          try { ms = bot.digTime(blk) } catch {}
          if (ms <= 1500) {
            if (pathing) { pathTo(false); pathing = false }
            clear()
            aim = 'free'
            const h0 = entity.position.y
            let ok = false
            bot._ndBlockTag = { what: 'сломать опору под ним', at: gameClock.wall.now() }
            try { await withTimeout(bot.dig(blk, true), ms + 600); ok = !bot.blockAt(cell) || bot.blockAt(cell).boundingBox === 'empty' } catch {}
            bot._ndBlockTag = null
            aim = 'target'
            st.breakUnder = st.breakUnder || { tries: 0, ok: 0, fell: 0 }
            st.breakUnder.tries++
            if (ok) st.breakUnder.ok++
            await sleep(300)
            if (ok && entity.position.y < h0 - 0.8) st.breakUnder.fell++
            used(ok ? `сломал опору под ним (${blk.name}, ${Math.round(ms)} мс)${entity.position.y < h0 - 0.8 ? ' — упал' : ''}` : `опору под ним не сломал (${blk.name})`)
            await holdWeapon()
            continue
          } else if (tool) await holdWeapon()
        }
      } catch {}
    }
    if (theyUp && prof.player && !perch && (!findItem(bot, i => i.name === 'bow') || !findItem(bot, i => /arrow$/.test(i.name)) || upLong) && ready('counterPillar')) {
      const filler = pickFiller(bot)
      const fp = foeSeenPos || me
      const need = foeSeenPos ? Math.floor(fp.y - me.y) - 1 : 0
      if (filler && need >= 2 && need <= 12 && countOf(bot, filler.name) >= need && headroom(need + 1)) {
        // Подойти под него — по горизонтали (S7d, s7d-p-27: d — расстояние в 3D, при нём на 8 бл. выше «d > 1.6»
        // не кончалось никогда — путь дошёл, и бот стоял молча 95–110 с до ничьей по застою). Не подходится 3 с — иначе.
        const hdP = Math.hypot(fp.x - me.x, fp.z - me.z)
        if (hdP > 1.6) {
          // Своя цель пути — всегда (путь мог идти к чужой цели — точке прострела, и стоять на ней).
          if (!st.cpFrom || now - st.cpFrom.seen > 500) { pathTo(true, new goals.GoalNear(fp.x, me.y, fp.z, 1)); pathing = true; clear(); st.cpFrom = { at: now, hd: hdP, seen: now } }
          st.cpFrom.seen = now
          if (now - st.cpFrom.at > 3000) {
            if (hdP > st.cpFrom.hd - 0.5) { rest('counterPillar', 8000); pathTo(false); pathing = false; st.cpFrom = null; used('столб к его столбу: не подойти под него'); continue }
            st.cpFrom = { at: now, hd: hdP, seen: now }
          }
          await sleep(TICK_MS)
          continue
        }
        st.cpFrom = null
        rest('counterPillar', 8000)
        pathTo(false); pathing = false
        clear()
        aim = 'free'
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

    if (bot.entity.isCollidedHorizontally && (bot.getControlState('forward') || bot.getControlState('left') || bot.getControlState('right'))) stuckTicks++
    else stuckTicks = 0
    if (d < hopD - 0.5 || r <= HIT_REACH) { hopD = d; hopDAt = now }
    if (HOP && prof.player && !perch && !fort && !meInWeb && bot.entity.onGround && !bot.entity.isInWater && r > HIT_REACH && d < 9 &&
        ready('hop') && (stuckTicks >= 4 || (dy > 0.6 && dy < 2.6 && d < 5) || (pathing && d > 5 && now - hopDAt > 2500 && Math.abs(dy) < 2.6))) {
      rest('hop', 1500)
      const me0 = bot.entity.position.clone()
      const foeAt = entity.position.clone()
      const score = (t) => {
        const dd = Math.hypot(t.x - foeAt.x, t.z - foeAt.z)
        if (dd > d - 0.4 || t.y < me0.y - 3) return -Infinity
        return -dd - Math.abs(t.y - foeAt.y) * 0.3 + (t.y > me0.y ? 0.3 : 0)
      }
      pathTo(false); pathing = false; clear()
      let hop = null
      try { hop = await require('./navigation/parkour').combatHop(bot, ctl, { score, radius: 4 }) } catch (e) { hop = { ok: false, why: e.message } }
      st.hops = (st.hops || 0) + 1
      // Итог по делу (S7d): исполнитель S6 строг (сбитая траектория от его удара — «physics_diverged»), а в бою важно,
      // долетел ли я до точки или стал к нему ближе на 1.5+ без падения: это «удался по делу».
      await sleep(TICK_MS * 4)
      const meH = bot.entity.position
      const landed = !!(hop && hop.target && bot.entity.onGround && meH.distanceTo(hop.target) <= 1.3)
      const closer = Math.hypot(meH.x - entity.position.x, meH.z - entity.position.z) <= d - 1.5 && meH.y >= me0.y - 1
      if (hop && (hop.ok || landed || closer)) {
        st.hopOk = (st.hopOk || 0) + (hop.ok ? 1 : 0)
        st.hopEff = (st.hopEff || 0) + 1
        used(stuckTicks >= 4 ? 'прыжок через препятствие к нему' : dy > 0.6 ? 'прыжок на его уступ' : 'прыжок к нему (путь стоял)')
      } else { if (hop && hop.why) st.hopWhy = hop.why; rest('hop', 6000) } // s7b: 67 попыток за раунд, 1 удачная — реже после отказа
      hopD = Infinity; hopDAt = gameClock.now(); stuckTicks = 0
      continue
    }
    // Окно перестановки кончилось, а цель — точка прострела (статичная): путь стоит на ней с pathing = true, и ветки
    // «if (!pathing) pathTo(true)» к нему больше не идут (S7d, s7d-p-27: 95–110 с молча до ничьей). Снять — до новой
    // перестановки (ревью Codex: иначе окно продлевается раньше очистки), и новую цель пути — с чистого листа.
    if (losGoal && now >= repositionUntil) { losGoal = null; pathTo(false); pathing = false }
    if (!perch && !fort && r > HIT_REACH && now >= repositionUntil && ready('unstick')) {
      const wall = !seesBody && !raySees(bot, me.offset(0, 0.4, 0), entity.position.offset(0, 0.4, 0))
      if (wall || stuckTicks >= 8) {
        pathTo(false); pathing = false
        rest('unstick', 1500)
        repositionUntil = now + 3000
        stuckTicks = 0
        // Он высоко над стеной/столбом (S7d: s7d-g-27 р.3 — 60 с «стена между нами» под его столбом в 7 бл., ничья
        // по застою): путь «к нему» ведёт под столб, где луча нет. Точка в 3–6 бл. от его колонны, откуда его видно
        // (лук, заряд ветра «со столба», удочка, свой столб рядом) — туда.
        losGoal = null
        if (dy > 2.2) {
          const spot = losSpot()
          if (spot) { losGoal = new goals.GoalBlock(spot.x, spot.y, spot.z); st.losSpots = (st.losSpots || 0) + 1 }
        }
        used(losGoal ? 'он высоко за стеной — отхожу туда, откуда его видно' : wall ? 'стена между нами — путь в обход или насквозь' : 'упёрся — обхожу')
      }
    }
    if (now < repositionUntil && r > HIT_REACH && !perch) {
      if (!pathing) { pathTo(true, losGoal); pathing = true; clear() }
      if (losGoal && seesBody) { repositionUntil = 0; losGoal = null; pathTo(false); pathing = false }
      await sleep(TICK_MS)
      continue
    }

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

    const bowShield = theyBow && !hisCb && (prof.player || prof.ranged) && guard?.stats?.worn && sees && r > HIT_REACH
    if (bowShield) {
      guard.raise(true)
      if (ready('bowShieldNote')) { rest('bowShieldNote', 4000); used(their === 'trident' ? 'щит от трезубца' : 'щит от стрелы') }
    }
    // Гроза и у него «Громовержец» (видно в руке): молния бьёт только под открытым небом (channeling.json can_see_sky) —
    // под навес, если он рядом (≤ 6 бл., крышу вижу), и держаться там, пока он мечет издали; сблизился — бой как всегда.
    // Цена: под навесом бросок даёт ему 8 вместо 8 + 5 + поджог; долго без размена — нажим (pressing) выводит в бой.
    if (prof.player && seesBody && d > 4.5 && !pressing && !meInWeb && !perch && !fort && thundering(bot)) {
      const hisTri = [entity.equipment && entity.equipment[0], entity.equipment && entity.equipment[1]].find(it => it && it.name === 'trident' && read.enchLevel(bot, it, 'channeling') > 0)
      if (hisTri) {
        st.storm = st.storm || { seen: 0, shelters: 0, under: 0, noShelter: 0 }
        if (!skyOver(bot.entity)) {
          if (ready('stormUnder')) { rest('stormUnder', 3000); st.storm.under++; used('гроза: под навесом — молния не достанет') }
          if (pathing) { pathTo(false); pathing = false }
          for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) set(k, false)
          if (bowShield) guard.raise(true)
          await sleep(TICK_MS)
          continue
        }
        if (ready('stormCover')) {
          rest('stormCover', 2500)
          st.storm.seen++
          const c = shelterNear(6)
          if (c) {
            st.storm.shelters++
            used('гроза: у него «Громовержец» — под навес')
            if (guard) await guard.raise(false)
            try { bot.pathfinder.setGoal(new goals.GoalBlock(c.x, c.y, c.z)) } catch {}
            const tS = gameClock.now()
            while (gameClock.now() - tS < 3000 && !ctl.aborted && !selfDied && skyOver(bot.entity) && entity.position.distanceTo(bot.entity.position) > 3.5) await sleep(TICK_MS)
            try { bot.pathfinder.setGoal(null) } catch {}
            continue
          } else st.storm.noShelter++
        }
      }
    }
    if (cbShield) {
      guard.raise(true)
      if (ready('cbShieldNote')) { rest('cbShieldNote', 4000); used(`щит от заряженного арбалета (${aimedCb.ammo || '?'})`) }
    }
    if (d > FAR && !(noMelee && bowItem && arrowItem)) {
      if (guard) await guard.raise(!!(cbShield || bowShield))
      if (perch) { clear(); await sleep(TICK_MS); continue }
      if (rangedAllowed() && now < bowFirstUntil && ((bowItem && arrowItem) || (ranged.crossbows(bot).length && (arrowItem || findItem(bot, i => i.name === 'firework_rocket')))) && !punRush) {
        if (pathing) { pathTo(false); pathing = false }
        if (now >= strafeFlipAt) { strafeKey = strafeKey === 'left' ? 'right' : 'left'; strafeFlipAt = now + 300 + Math.random() * 500 }
        set('forward', false)
        set('left', strafeKey === 'left' && stepSafe(bot, keyDir(bot, 'left')))
        set('right', strafeKey === 'right' && stepSafe(bot, keyDir(bot, 'right')))
        await sleep(TICK_MS)
        continue
      }
      if (!theyUp && !perch && !fort && !meInWeb && (await spearChargeFar(r, d))) continue
      const shooter = theyBow || prof.ranged
      const pearl = findItem(bot, i => i.name === 'ender_pearl')
      if (prof.player && theyBow && pearl && pearl.count >= 2 && d > 14 && d < 40 && hp > 13 && ready('pearlIn')) {
        rest('pearlIn', 8000)
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
      if (aimedCb && seesBody && d < 40) {
        if (pathing) { pathTo(false); pathing = false }
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

    const vel = track.vel()
    const closing = (vel.x * (me.x - entity.position.x) + vel.z * (me.z - entity.position.z)) / Math.max(d, 0.1)

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
      const fsM = tt.foes.get(entity.id)
      const handM = entity.equipment && entity.equipment[0] ? entity.equipment[0].name : ''
      const readyM = fsM && fsM.swungAt ? Math.max(0, fsM.swungAt + tempo.swingCooldownMs(handM) - now) : 0
      const hitSoon = (theirR <= tempo.PLAYER_REACH && readyM < 2 * TICK_MS) || theyBow || !!aimedCb || (duo.active() && duo.secondThreat())
      const sp0 = hitSoon ? null : mace.smashPlan(bot, entity)
      // Взлёт с булавой — если граф (калькулятор: булава с падения против удара/топора/копья) его не отверг.
      const sp = sp0 && gate('smash') ? sp0 : null
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
        if (!res.aborted) used(res.hit ? 'булава: удар с падения' : res.launched ? 'булава: взлёт, не достал' : res.cancelled ? (res.note || 'булава: передумал взлетать') : 'булава: не взлетел' + (res.why ? ` (${res.why.split(', ')[0]})` : ''))
        if (!res.launched && res.why && /в паутине/.test(res.why)) used('булава: взлёт в паутине не поднял (проверка перед взлётом пропустила)')
        if (res.retry) used(`булава: второй заряд стоя — взлетел (первый: ${res.retry.split(', ')[0]})`)
        if (res.why && !res.launched) console.log('[mace] не взлетел:', res.why)
        if ((res.self || 0) > 3) console.log('[mace]', res.note)
        if (process.env.ND_DEBUG_PVP) console.log('[mace]', res.note)
        await holdWeapon()
        continue
      }
    }

    if ((d > 2.5 || theirPit) && d < 7 && ready('debuff')) {
      const effNow = read.effectsOf(bot, entity)
      const duoOn = prof.player && duo.active()
      const fits = i => {
        const base = (potionOf(i) || '').replace(/^(long|strong)_/, '')
        return potionRole(potionOf(i)) === 'debuff' && !(prof.undead && (base === 'harming' || base === 'poison')) && !effNow.has(base) && !(duoOn && base === 'harming')
      }
      const pref = splashFirst ? ['slowness', 'weakness', 'poison'].map(k => findItem(bot, i => i.name === 'splash_potion' && fits(i) && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k)).find(Boolean) : null
      if (splashFirst && !pref) splashFirst = false
      const bad = pref || findItem(bot, i => (i.name === 'splash_potion' || i.name === 'lingering_potion') && fits(i))
      if (bad) {
        rest('debuff', pref ? 400 : 1500)
        if (await throwAt(bad, 'зелье в него: ' + (potionOf(bad) || '?'))) {
          splashAt = gameClock.now(); backOffUntil = splashAt + 700
          await holdWeapon()
          continue
        }
      }
    }

    const web = findItem(bot, i => i.name === 'cobweb')
    if (web && !inWeb && !prof.webImmune && !prof.creeper && r < 4.2 && foeGrounded() && ready('web')) {
      rest('web', 5000)
      if (await placeUnder(web, 'паутина под него')) { await holdWeapon(); continue }
    }

    const lava = findItem(bot, i => i.name === 'lava_bucket')
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

    const flint = findItem(bot, i => i.name === 'flint_and_steel')
    const foodHunt = opts.purpose === 'food' && foodAnimals.has(entity.name)
    const fireCell = entity.position.floored()
    const animalFire = foodHunt && !!flint && foodIgnitionAllowed({ purpose: opts.purpose, animal: entity.name,
      remainingUses: (flint.maxDurability ?? 64) - (flint.durabilityUsed ?? 0), grounded: !!bot.entity.onGround && foeGrounded(),
      visible: seesBody, burning: !!(entity.metadata?.[0] & 1),
      selfSafe: hp >= 12 && bot.entity.position.distanceTo(fireCell.offset(.5, .5, .5)) > 2 && !bot.entity.isInWater && !bot.entity.isInLava,
      terrainSafe: fireTerrainSafe(fireCell) })
    const fireOk = foodHunt ? animalFire : prof.player || session.playPolicy?.mode !== 'speedrun'
    if (flint && fireOk && !prof.fireImmune && !fireProof && !prof.creeper && r > 1.8 && r < 4.3 && ready('fire')) {
      const cell = entity.position.floored()
      if (blockName(bot, cell) === 'air') {
        rest('fire', 6000)
        if (foodHunt) foodFire.attempts++
        if (await useOnGroundAt(flint, cell, foodHunt ? 'поджёг добычу для готового мяса' : 'поджёг')) {
          if (foodHunt) foodFire.ignited++
          await holdWeapon(); continue
        }
        await holdWeapon()
      }
    }

    const spearIt = prof.player && now >= spearOffUntil && !theyUp && !perch && !fort && !meInWeb ? spear.spearOf(bot) : null
    let spearTurn = !!spearIt
    if (spearIt) {
      const sName = spearIt.item.name
      const heldSpear = !!(bot.heldItem && spear.isSpear(bot.heldItem.name))
      const swordS = bestWeapon(bot)
      const sjNow = spear.jabReach(bot, entity)
      const justHit = now - lastSwing < 250
      if (heldSpear) {
        if (swordS && (sjNow.close || r < 2.1) && !(sjNow.ok && spear.readyIn(bot, sName) === 0)) {
          st.spearSwaps = (st.spearSwaps || 0) + 1
          used('копьё → меч: он ближе 2 бл., укол не достаёт')
          await holdWeapon()
          spearTurn = false
        }
      } else {
        const beyond = r > HIT_REACH + 0.4 && !sjNow.close
        const cheap = justHit || mf.clock.charge(0) < 0.4 || r > 4.2
        if (!swordS || (beyond && cheap)) {
          st.spearSwaps = (st.spearSwaps || 0) + 1
          if (swordS) used('меч → копьё: он дальше руки, заряд меча пуст')
          await holdItem(spearIt.item)
        } else spearTurn = false
      }
    }
    // Щит поднят, а топор есть: укол и разгон копья щит гасит целиком (копьё щит не выбивает — Weapon без
    // disable_blocking), s7d-c-30p «копья»: 389 погашенных ударов, 3 ничьих — копьё в сторону, ближе и топором (свап в
    // тик удара в основной ветке), потом снова копьё.
    if (spearIt && spearTurn && blocking && findItem(bot, i => /_axe$/.test(i.name)) && !(foe.shieldOff(entity) > 300)) {
      spearTurn = false
      if (bot.heldItem && spear.isSpear(bot.heldItem.name)) await holdWeapon()
      if (ready('spearShieldNote')) { rest('spearShieldNote', 4000); used('щит поднят — копьё в сторону, топором') }
    }
    if (spearIt && spearTurn) {
      const sName = spearIt.item.name
      if (!bot.heldItem || bot.heldItem.name !== sName) await holdItem(spearIt.item)
      const sReady = spear.readyIn(bot, sName)
      const sj = spear.jabReach(bot, entity)
      const vS = track.vel()
      const towardMe = (vS.x * (me.x - entity.position.x) + vS.z * (me.z - entity.position.z)) / Math.max(d, 0.1)
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

    const axe = findItem(bot, i => /_axe$/.test(i.name))

    const iframes = Math.max(0, targetHurtAt + 500 - now)
    if (blocking) shieldUpAt = now
    else if (shieldUpAt && !shieldDownAt) shieldDownAt = now
    if (blocking) shieldDownAt = 0
    const fYaw = entity.yaw || 0
    const fx = -Math.sin(fYaw); const fz = -Math.cos(fYaw)
    const tx = me.x - entity.position.x; const tz = me.z - entity.position.z
    const tn = Math.hypot(tx, tz) || 1
    const facingMe = (fx * tx + fz * tz) / tn > 0.2 // щит закрывает переднюю полусферу
    const tState = tt.state(entity)
    const shieldFresh = blocking && !!tState.since && now - tState.since < 4 * mf.clock.msPerTick - 30
    if (shieldFresh && ready('freshShieldNote')) { rest('freshShieldNote', 3000); used('бью в окно подъёма его щита') }
    const intoShield = blocking && !axe && facingMe && !shieldFresh
    const punish = !blocking && shieldDownAt && now - shieldDownAt < 600
    if (intoShield && ready('shieldNote')) { rest('shieldNote', 5000); used('не бью в щит — жду, когда опустит') }
    if (punish && ready('punishNote')) { rest('punishNote', 3000); used('опустил щит — бью первым') }
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

    const shieldBroken = prof.player && foe.shieldOff(entity) > 300
    if (shieldBroken && ready('shieldOffNote')) { rest('shieldOffNote', 5000); used('его щит выбит — давлю') }
    const vulnerable = inWeb || theyEat || theyBow || (blocking && axe) || punRush || shieldBroken
    const rush = (after('rush', theyEat && seesBody && r > HIT_REACH - 0.3) && roll('rush', theyEat, style.aggression)) ||
      ((punRush || now < rushUntil) && r > HIT_REACH - 0.3)
    if (cooldownLeft <= 150) {
      if (r > HIT_REACH - 0.15) { forward = true; sprint = !jumpedForCrit }
    } else if (!vulnerable && !punStep && theirR < prof.theirReach + (prof.player ? 0.2 : REACH_MARGIN) && cooldownLeft > 250) {
      back = true
    } else if (vulnerable && r > HIT_REACH - 0.3) {
      forward = true
    }
    if (rush) {
      forward = true
      sprint = true
      if (ready('rush')) { rest('rush', 2500); used(now < rushUntil ? 'рывок со спринт-ударом' : punRush ? 'рывок на занятого' : 'рывок, пока он ест') }
    }
    if (theyUp) {
      forward = d > 3.2
      back = d < 1.8
      if (ready('waitUp')) { rest('waitUp', 4000); used('он на столбе — жду внизу') }
    }
    if (now < backOffUntil) { forward = false; back = true }
    strafe = strafeKey

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
      forward = r > 3.4
      back = r < 2.6
      if (!strafe) strafe = strafeKey || 'left'
    }
    if (punish && r > HIT_REACH - 0.3) { forward = true; back = false }
    if (dodgeKey && now < dodgeUntil) { strafe = dodgeKey; back = false }
    if (hm && prof.player && !theyUp) {
      ({ forward, back, strafe, sprint } = hm.steer({ forward, back, strafe, sprint }, {
        r, theirR, d, hp, theirHp, cooldownLeft, blocking, vulnerable, rush,
        dodging: !!(dodgeKey && now < dodgeUntil), flank: blocking && !axe, press: pressing
      }))
    }
    if (prof.player && !theyUp && duo.active()) ({ forward, back, strafe, sprint } = duo.steer({ forward, back, strafe, sprint }, { entity, r, cooldownLeft }))

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
      } else if (push.stand && !(FIX && pressing)) {
        // Обход «встать так, чтобы яма была за ним» — пока размены идут; долго без размена (нажим) — бить, а не кружить
        // (S7d, s7d-z-27 «булава против щита»: 4+ мин на 3.0 бл. — я «захожу, чтобы столкнуть», он «не стою спиной к
        // яме», ничья по пределу раунда).
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
      } else if (!(FIX && pressing)) {
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
    if (!pushing && theirR < 5.5) {
      if (now >= backAt) { backAt = now + 200; try { behindDrop = edges.backToDrop(bot, entity.position, { kb: entity.equipment && entity.equipment[0] ? read.enchLevel(bot, entity.equipment[0], 'knockback') : 0 }) } catch { behindDrop = null } }
    } else behindDrop = null
    if (behindDrop) {
      back = false
      const side = ['left', 'right'].map(k => { const v = keyDir(bot, k); return { k, c: edges.clearance(bot, me.offset(v.x * 1.2, 0, v.z * 1.2), 2.5) } })
      strafe = side[0].c >= side[1].c ? side[0].k : side[1].k
      if (ready('backNote')) { rest('backNote', 4000); used('не стою спиной к яме (его удар кинул бы)') }
    }
    const intoHazard = (k) => {
      const dir = keyDir(bot, k)
      const c = me.offset(dir.x * 0.9, -1, dir.z * 0.9).floored()
      return nearMe.some(h => h.pos.x === c.x && h.pos.z === c.z)
    }
    const wantFwd = forward
    if (forward && intoHazard('forward')) forward = false
    if (strafe && intoHazard(strafe)) strafe = null

    if (forward && !stepSafe(bot, keyDir(bot, 'forward'))) forward = false
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

    const charging = closing > 0.2 && d > 4
    if ((!hitKind && cooldownLeft < 8 * mf.clock.msPerTick) || edgeHit === 'sprint') {
      const myHp = hp + totemMod.absorption(bot)
      hitKind = edgeHit === 'sprint' ? 'sprint' : mf.choose({
        meInWeb: meInWeb || !!bot.entity.isInWeb,
        creeper: prof.creeper,
        defenseless: inWeb || theyEat || theyBow,
        first: !firstHitDone,
        charging,
        hisReadyMs: prof.player ? hisReadyMs : null,
        myReadyMs: cooldownLeft,
        close: prof.player && r > 2.2 && theirR <= tempo.PLAYER_REACH + Math.max(0, closing) * 2,
        weaker: prof.player && theirHp != null && myHp + 4 < theirHp,
        comboOn: now - lastHurtByTarget > 1500 && now - lastSwing < 1500
      })
    }
    if (hitKind === 'crit' && bot.entity.onGround && prof.player && theirR <= tempo.PLAYER_REACH + 0.3 &&
        r > 2.2 && hisReadyMs <= cooldownLeft + 2 * mf.clock.msPerTick && !(inWeb || theyEat || theyBow)) {
      hitKind = (bot.food ?? 20) > 6 ? 'sprint' : 'plain'
      if (ready('raceNote')) { rest('raceNote', 4000); used('гонка — без прыжка за критом, спринт-удар') }
    }
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
      sprint = sprint && !mf.clock.srvSprint
    }
    if (wantSprintHit && cooldownLeft <= 150 && !back && r < HIT_REACH + 1.5 && !intoHazard('forward') && stepSafe(bot, keyDir(bot, 'forward'))) {
      forward = true
      sprint = true
      if (!mf.clock.srvSprint && bot.getControlState('sprint') && !mf.planning()) mf.rearm()
    }
    if (prof.player && read.spearIn(entity) && theirR < 5 && !pushing) {
      back = false
      if (r > 1.3 && !intoHazard('forward') && stepSafe(bot, keyDir(bot, 'forward'))) forward = true
      if (ready('spearHugNote')) { rest('spearHugNote', 4000); used('у него копьё — прилипаю ближе 2 блоков') }
    }
    const moveDir = forward ? 'forward' : back ? 'back' : strafe
    if (moveDir && wantsJump(bot, keyDir(bot, moveDir))) jump = true
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
    if (hitKind === 'crit' && !bot.entity.onGround && !meInWeb) sprint = sprint && bot.getControlState('sprint') && !mf.clock.srvSprint
    const kk = mf.override({ forward, back, left: strafe === 'left', right: strafe === 'right', sprint: sprint && (bot.food ?? 20) > 6, jump })
    set('forward', kk.forward)
    set('back', kk.back)
    set('left', kk.left)
    set('right', kk.right)
    set('sprint', kk.sprint)
    set('jump', kk.jump)

    const theirHand = hisHand
    const offShield = bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield'
    if (guard && guard.stats && guard.stats.worn && offShield) {
      const adv = mf.shield({ theirR, closing, hisReadyMs, hisHand: theirHand, myLeftMs: cdHit, inMyReach: r <= HIT_REACH })
      if (adv === 'raise') guard.raise(true)
      else if (adv === 'lower' && !cbShield) await guard.raise(false)
    }

    const edgeSpam = edgeHit === 'hit' && iframes === 0 && r <= HIT_REACH && !intoShield && inSight && cooldownLeft > 0
    if (edgeSpam && ready('edgeSpamNote')) { rest('edgeSpamNote', 3000); used('бью у края, не дожидаясь заряда') }
    // Хит-селект = (1) ответный удар в тик его отброса (melee.counterFn: свой спринт-удар ×0.6 гасит часть его толчка —
    // Player.causeExtraKnockback) и (2) ожидание его удара до 3 тиков. ND_HS_WAIT=0 — без (2): по jar выигрыш даёт только
    // отброс (1), а ожидание отдаёт ему первый удар (A/B s7d-e-28-hsb: выключенный хит-селект 7 : 3).
    const selectWait = prof.player && race && closing > 0.1 && !pushing && theirR < 3.0 && mf.skill.counter > 0.7 && process.env.ND_HIT_SELECT !== '0' && process.env.ND_HS_WAIT !== '0'
    if (selectWait) { if (!selectSince) selectSince = now } else selectSince = 0
    const holdForSelect = selectWait && now - selectSince < 3 * mf.clock.msPerTick
    if (holdForSelect && ready('selectNote')) { rest('selectNote', 4000); used('жду его удара, чтобы ответить (hit-select)') }
    if ((canHit && !holdForSelect) || edgeSpam) {
      const falling = mf.clock.critNow()
      const rising = !bot.entity.onGround && !falling
      const upTicks = rising ? ticksToFall(bot.entity.velocity.y) : 0
      const critWait = rising && !edgeSpam && (jumpedForCrit || (hitKind === 'crit' && CRIT_ANY_RISE)) &&
        upTicks <= 7 && !(race && theirR <= 2.6 && upTicks > 2 && r > 2.2) && !bot.entity.isInWater && !meInWeb
      if (critWait && !jumpedForCrit && ready('pcritNote')) { rest('pcritNote', 4000); used('жду спуска для крита (подбросило)') }
      if (!critWait) {
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
        const use = bot._ndUse
        if (!(use && (use.cur || gameClock.now() - (use.endedAt || 0) < mf.clock.msPerTick))) {
          const sprintHit = mf.clock.srvSprint && mf.clock.charge(0) > 0.9
          swingCrit = falling && !mf.clock.srvSprint
          const after = sprintHit ? (closing > 0.1 && theirR < 3.2 && !pushing ? 'stap' : 'wtap') : null
          mf.hit(entity, { swapTo, after, kind: hitKind, diag: { jumped: jumpedForCrit, race: race && theirR <= 2.6 } })
          // Щит (пункт H): удар по поднятому щиту — топором (выключит) или сбоку/сзади вне его 90° (BlocksAttacks);
          // урон, прошедший при поднятом щите, считает onTickDmg (окно 600 мс). Звено комбо — вид удара.
          if (blocking) {
            const sh = st.shield || (st.shield = { hits: 0, axe: 0, outside: 0, through: 0 })
            sh.hits++
            const axeHit = swapTo >= 0 || (swungWith && /_axe$/.test(swungWith.name))
            if (axeHit) sh.axe++
            const ang = require('./pvp/damage-model').shieldAngle(typeof entity.headYaw === 'number' ? entity.headYaw : (entity.yaw || 0), entity.position, bot.entity.position)
            if (ang > 90) { sh.outside++; if (ready('flankNote')) { rest('flankNote', 3000); used('удар мимо щита: сбоку/сзади') } }
            shieldHitAt = gameClock.now()
            if (axeHit) used('топор по щиту')
          }
          combo.note(swapTo >= 0 ? 'топор' : hitKind === 'crit' ? 'крит' : hitKind === 'sprint' ? 'спринт-удар' : 'удар')
          if (TRACE) trace(`удар: ${swapTo >= 0 ? 'топором (свап)' : hitKind === 'crit' ? 'в прыжке за критом' : hitKind === 'sprint' ? 'спринт-удар' : 'обычный'}${after ? ' + ' + after : ''}${blocking ? ' — по щиту' : ''} (d=${r.toFixed(1)})`)
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

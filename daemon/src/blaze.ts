'use strict'
const gameClock = require('./game-clock')
const drops = require('./drops')
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

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, xyz, stuckGuard, gotoPath } = require('./movement')
const { walkable, standable } = require('./walkable')
const { seesBlock } = require('./sight')
const { countOf, itemNamed } = require('./items')
const { canUseRanged } = require('./play-policy')
const { canSeePoint, eyePos, raySees } = require('./perception')
const worlds = require('./worlds')
const survival = require('./combat-safety')

// 12 рамок портала в Край, каждая с оком с шансом 10% (PortalRoom:
// nextFloat() > 0.9) — в худшем случае нужны все 12; плюс броски при поиске
// крепости: око разбивается в 20% (EyeOfEnder surviveAfterDeath = nextInt(5) > 0).
const EYES_WANTED = 14
const SPAWNER_RANGE = 16
// ND_BLAZE_FP=1 — под огнестойкостью вылазка за стержнями не рвётся шарами (03.10, поток nether).
// По умолчанию вкл. с 03.10 08:10 (B17: ≥ 7 стержней 2/3 со старым боем; до правки — стержни лежали, вылазки рвались);
// откат — ND_BLAZE_FP=0.
const FP_SORTIE = typeof process !== 'undefined' && process.env.ND_BLAZE_FP !== '0'
const SPAWNER_PLACE = 'спавнер блейзов'
// Снежок летит 1.5 блока за тик; дальше 24 блоков он опускается и расходится.
const SNOW_RANGE = 24
// Досягаемость меча: от глаз до хитбокса, entity_interaction_range 3.0.
const SWORD_REACH = 3.0
// Из укрытия мечом — только за теми, кто висит в этом радиусе от угла.
const CHASE_FROM_COVER = 7
// Дальше этого от укрытия бой без огнестойкости не уводит (см. farmRods).
const LEASH = 9

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
// Ход боя — в лог демона: отчёт намерения, оборванного смертью, до мозга не
// доезжает, а разбирать, где именно ушли хп, надо.
// Время (ЧЧ:ММ:СС) — для разбора, куда ушли минуты этапа (dev-F 02.10).
const log = (what, o) => console.log('[blaze]', new Date().toTimeString().slice(0, 8), what, JSON.stringify(o))

// Типы урона — номер в реестре damage_type (пакет damage_event), реестр по
// алфавиту имён: data/minecraft/damage_type/*.json в server-1.21.11.jar, 50
// штук (сверено 2026-09-27; тот же список в dragon.js).
const DAMAGE_TYPES = ['arrow', 'bad_respawn_point', 'cactus', 'campfire', 'cramming', 'dragon_breath', 'drown', 'dry_out',
  'ender_pearl', 'explosion', 'fall', 'falling_anvil', 'falling_block', 'falling_stalactite', 'fireball', 'fireworks',
  'fly_into_wall', 'freeze', 'generic', 'generic_kill', 'hot_floor', 'in_fire', 'in_wall', 'indirect_magic', 'lava',
  'lightning_bolt', 'mace_smash', 'magic', 'mob_attack', 'mob_attack_no_aggro', 'mob_projectile', 'on_fire',
  'out_of_world', 'outside_border', 'player_attack', 'player_explosion', 'sonic_boom', 'spear', 'spit', 'stalagmite',
  'starve', 'sting', 'sweet_berry_bush', 'thorns', 'thrown', 'trident', 'unattributed_fireball', 'wind_charge',
  'wither', 'wither_skull']

// Куда ушли хп: каждая потеря здоровья — к последнему damage_event по нам
// (тип и кто), и к тому, чем тело было занято (phase). Разбор смертей в
// лаборатории этапов: «сгорел» от шара, от огня после шара, от лавы — это три
// разные поправки.
function damageLedger (bot, phaseOf) {
  const byType = {}
  const byPhase = {}
  const hits = []
  let last = null
  let hp = bot.health ?? 20
  const onPk = pk => {
    if (!bot.entity || !pk || pk.entityId !== bot.entity.id) return
    const src = pk.sourceCauseId > 0 ? bot.entities[pk.sourceCauseId - 1] : null
    const direct = pk.sourceDirectId > 0 ? bot.entities[pk.sourceDirectId - 1] : null
    last = { type: DAMAGE_TYPES[pk.sourceTypeId] || String(pk.sourceTypeId), by: src ? src.name : undefined, t: gameClock.now() }
    // Геометрия щита в миг удара: куда смотрим, откуда прилетело (снаряд или
    // тот, кто бил), поднят ли щит по метаданным и сколько мс назад.
    try {
      const from = (direct && direct.position) || (src && src.position)
      if (from && ledger.probe) {
        const me = bot.entity.position
        const dx = from.x - me.x; const dz = from.z - me.z; const n = Math.hypot(dx, dz) || 1
        const fx = -Math.sin(bot.entity.yaw); const fz = -Math.cos(bot.entity.yaw)
        last.geo = { ang: Math.round(Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / n))) * 180 / Math.PI), ...ledger.probe() }
      }
    } catch {}
  }
  const onHealth = () => {
    const now = bot.health ?? 0
    if (now < hp) {
      const lost = hp - now
      const fresh = last && gameClock.now() - last.t < 600
      const key = fresh ? last.type + (last.by && last.by !== last.type ? ':' + last.by : '') : 'unknown'
      const phase = phaseOf() || '-'
      byType[key] = (byType[key] || 0) + lost
      byPhase[phase] = (byPhase[phase] || 0) + lost
      if (hits.length < 60) hits.push({ t: gameClock.now(), k: key, lost: Math.round(lost * 10) / 10, hp: Math.round(now * 10) / 10, ph: phase, geo: fresh && last.geo && key !== 'on_fire' ? last.geo : undefined })
      if (fresh && last.geo && key !== 'on_fire') log('удар', { k: key, lost: Math.round(lost * 10) / 10, hp: Math.round(now * 10) / 10, ph: phase, ...last.geo })
    }
    hp = now
  }
  bot._client.on('damage_event', onPk)
  bot.on('health', onHealth)
  const r1 = o => Object.fromEntries((Object.entries(o) as [string, any][]).map(([k, v]: any) => [k, Math.round(v * 10) / 10]).sort((a: any, b: any) => b[1] - a[1]))
  const ledger = {
    probe: null,
    stop () {
      bot._client.removeListener('damage_event', onPk)
      bot.removeListener('health', onHealth)
    },
    report () {
      const total: any = (Object.values(byType) as any[]).reduce((s: any, v) => s + v, 0)
      return total > 0 ? { total: Math.round(total * 10) / 10, byType: r1(byType), byPhase: r1(byPhase) } : undefined
    },
    hits
  }
  return ledger
}

// Сколько стержней не хватает на EYES_WANTED око с тем, что уже есть: оки,
// порошок и стержни (по два ока с каждого).
function rodsShort (bot, eyesWanted = EYES_WANTED) {
  const eyes = countOf(bot, 'ender_eye')
  const powder = countOf(bot, 'blaze_powder')
  const rods = countOf(bot, 'blaze_rod')
  return Math.max(0, Math.ceil(Math.max(0, eyesWanted - eyes - powder) / 2) - rods)
}

// От глаз до ближайшей точки хитбокса — так сервер меряет удар.
function reachTo (bot, e) {
  const eye = eyePos(bot)
  const w = (e.width || 0.6) / 2
  const h = e.height || 1.8
  const p = e.position
  const cx = clamp(eye.x, p.x - w, p.x + w)
  const cy = clamp(eye.y, p.y, p.y + h)
  const cz = clamp(eye.z, p.z - w, p.z + w)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

const seesMob = (bot, e) => canSeePoint(bot, e.position.offset(0, (e.height || 1.8) * 0.55, 0))
// S1f (аудит S10 №20): ифриты, стержни и стрелы — только известные телу (видимые/слышимые: eyes.knownEntities), не все сущности слежения.
const ents = (bot): any[] => require('./perception/eyes').knownEntities(bot)

// Живой блейз в радиусе: сначала видимые, потом ближайшие.
function nearestBlaze (bot, radius, dead) {
  const me = bot.entity.position
  const list = ents(bot).filter((e : any) => e && e.name === 'blaze' && e.position && e.isValid !== false &&
    !dead.has(e.id) && e.position.distanceTo(me) <= radius)
  if (!list.length) return null
  list.sort((a: any, b: any) => (seesMob(bot, b) - seesMob(bot, a)) || (a.position.distanceTo(me) - b.position.distanceTo(me)))
  return list[0]
}

// Спавнер, который ВИДНО (fairPlay: луч от глаз). Спавнер за стеной честно не
// замечен — его может назвать память.
function visibleSpawner (bot, mcData, radius = 32) {
  const id = mcData.blocksByName.spawner.id
  const found = bot.findBlocks({ matching: [id], maxDistance: radius, count: 16 })
  const me = bot.entity.position
  found.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  for (const p of found) {
    const b = bot.blockAt(p)
    if (b && seesBlock(bot, b)) return p
  }
  return null
}

// reachable — только те, за которыми collectRods пойдёт (не ниже 3 блоков под
// ногами, не у лавы). Иначе бой крутил «вылазку» без единого await на таймере —
// 7 млн оборотов за попытку, тело замирало под шарами (лаборатория, замер 10).
function droppedRods (bot, radius = 12, { reachable = false }: any = {}) {
  const me = bot.entity.position
  let n = 0
  for (const e of ents(bot)) {
    if (!e || e.name !== 'item' || !e.position || e.position.distanceTo(me) > radius) continue
    if (reachable && (e.position.y < me.y - 3 || lavaNear(bot, e.position))) continue
    try {
      const it = e.getDroppedItem && e.getDroppedItem()
      if (it && it.name === 'blaze_rod') n += it.count
    } catch {}
  }
  return n
}

const isRod = e => { try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'blaze_rod' } catch { return false } }

// Подобрать именно стержни. Общий подбор (actions.collectNearbyDrops) идёт к
// ближайшему предмету любого рода и застревал на чужой куче: сцена (в) простояла
// 125 с, а стержень так и остался лежать рядом.
// Лава рядом с точкой (в 3 блоках по x/z, от 2 ниже до 1 выше): за стержнем у
// лавопада тело шло к лаве (замер 3: «tried to swim in lava to escape Blaze»).
function lavaNear (bot, p, r = 3) {
  const lava = bot.registry.blocksByName.lava.id
  const c = p.floored()
  for (let x = -r; x <= r; x++) for (let y = -2; y <= 1; y++) for (let z = -r; z <= r; z++) {
    const b = bot.blockAt(c.offset(x, y, z))
    if (b && b.type === lava) return true
  }
  return false
}

// Свои стрелы на полу (мимо блейза — в пол и стены): подобрать в вылазке.
// Стрела в земле неподвижна; брать те, что не выше 1.6 над полом и не у лавы.
function arrowsOnFloor (bot, radius = 14) {
  const me = bot.entity.position
  return ents(bot).filter((e : any) => e && e.name === 'arrow' && e.position && e.isValid !== false &&
    e.position.distanceTo(me) <= radius && e.position.y >= me.y - 3 && e.position.y <= me.y + 2.5 &&
    (!e.velocity || Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z) < 0.01) && !lavaNear(bot, e.position, 2))
}

async function collectRods (bot, ctl, radius = 12, ms = 6000, { arrows = false, stopIf = null }: any = {}) {
  const t0 = gameClock.now()
  let walks = 0
  const skip = new Set()
  // Опасность посреди вылазки (заряд, шар к нам) — бросить и назад: замер 20,
  // 14.5 хп за одну вылазку с опущенным щитом, смерть.
  const sub = { aborted: false, onAbort: [] }
  const watch = stopIf ? gameClock.setInterval(() => {
    if (!sub.aborted && (ctl.aborted || stopIf())) { sub.aborted = true; try { bot.pathfinder.setGoal(null) } catch {} }
  }, 100) : null
  if (!stopIf) ctl = ctl
  const outer = ctl
  ctl = stopIf ? { get aborted () { return outer.aborted || sub.aborted }, onAbort: outer.onAbort } : ctl
  try {
  while (!ctl.aborted && gameClock.now() - t0 < ms && walks < 6) {
    const me = bot.entity.position
    // Где стержень ляжет (drops.js): убитый блейз висит в воздухе, и mineflayer до
    // секунды показывает дроп там, а не на полу.
    const at = e => { try { return drops.restOf(bot, e) } catch { return e.position } }
    let rod: any = ents(bot)
      .filter((e : any) => e && e.name === 'item' && e.position && at(e).distanceTo(me) <= radius && isRod(e) && !skip.has(e.id))
      .filter((e : any) => { const p = at(e); if (p.y < me.y - 3 || lavaNear(bot, p)) { skip.add(e.id); return false } return true })
      .sort((a, b) => at(a).distanceTo(me) - at(b).distanceTo(me))[0]
    if (!rod && arrows) rod = arrowsOnFloor(bot, radius).filter((e : any) => !skip.has(e.id)).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    if (rod && rod.name === 'arrow') skip.add(rod.id)
    if (!rod) break
    walks++
    // Стержень — общим подбором (drops.pickOne): цель «рамка подбора касается предмета».
    // Прежний GoalNear(клетка, 1) считал дошедшим и в 1.45 от стержня при рамке 1.425 — и
    // шёл к тому же стержню до шести раз (ревью Codex, 29.09). Стрела — не предмет: к ней
    // по-прежнему шагом.
    const left = () => Math.max(1000, ms - (gameClock.now() - t0))
    const go = async (limit) => rod.name === 'item'
      ? (await drops.pickOne(bot, ctl, { id: rod.id, e: rod }, { timeoutMs: limit })) === 'picked'
      : (await walkNear(bot, ctl, rod.position.floored(), 1, limit)).ok
    const ok = await go(left())
    // Без копки не дойти (стержни в комнате спавнера на 3 блока выше коробки —
    // двойник мира прохождения, 2026-09-28: 15 убийств, 10 стержней лежат,
    // подобрано 0): ступеньку — прокопать. Боевые ходы (fightMoves) копать не
    // дают; на сбор — дают, на 6 с.
    if (!ok && !ctl.aborted && bot.entities[rod.id]) {
      const saved = bot.pathfinder.movements
      try {
        const { Movements } = require('mineflayer-pathfinder')
        const m = new Movements(bot)
        m.canDig = true
        m.allow1by1towers = false
        m.allowParkour = false
        m.allowSprinting = false
        m.maxDropDown = 3
        try { require('./worlds').tuneMovements(bot, m) } catch {}
        bot.pathfinder.setMovements(m)
        const ok2 = await go(Math.min(6000, left()))
        if (!ok2) skip.add(rod.id)
      } finally { try { bot.pathfinder.setMovements(saved) } catch {} }
    }
    if (bot.entities[rod.id] && rod.name === 'item') skip.add(rod.id)
    await sleep(300)
  }
  } finally { if (watch) gameClock.clearInterval(watch) }
  return stopIf && sub.aborted ? -walks - 1 : walks
}

// minecraft-data 1.21.11 зовёт эффекты по-старому, в PascalCase
// (effectsByName.FireResistance, id 11 — совпадает с номером в пакете
// entity_effect); по snake_case там пусто, и проверка «зелье уже действует»
// молча отвечала «нет».
// Огнестойкость, выпитая самим телом, — по часам (16.10: в сценах у спавнера entity.effects тела пуст всегда — эффекта клиент не видит,
// а сервер его дал; цикл боя пил все зелья подряд и сгорал после первых 3 мин). Зелье огнестойкости — 3600 тиков (jar Potions:
// fire_resistance 3600), взрывное — то же.
function frByClock (bot) { return !!bot._ndFrUntil && gameClock.now() < bot._ndFrUntil }
function hasEffect (bot, name) {
  if (name === 'fire_resistance' && frByClock(bot)) return true
  try {
    const pascal = String(name).split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')
    const eff = bot.registry.effectsByName[name] || bot.registry.effectsByName[pascal]
    return !!(eff && bot.entity.effects && bot.entity.effects[eff.id])
  } catch { return false }
}

// Огнестойкость, если она есть: шар — это огонь, и под зельем он не жжёт
// вовсе (fireball в #is_fire). Пьём заранее, а не на половине хп.
// Есть ли зелье огнестойкости (обычное или взрывное) — для боя мечом (blaze-melee.ts).
function drinkable (bot) {
  const { potionOf } = require('./pvp')
  return bot.inventory.items().some(i => /^(potion|splash_potion)$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || ''))
}
async function drinkFireResistance (bot, { renew = false }: any = {}) {
  if (hasEffect(bot, 'fire_resistance') && !renew) return 'уже действует'
  const { potionOf } = require('./pvp')
  const pot = bot.inventory.items().find(i => i.name === 'potion' && /fire_resistance$/.test(potionOf(i) || ''))
  if (!pot) {
    // Взрывное из бартера (8 из 469, как и обычное): бросить себе под ноги —
    // в центре облака действие полное (ThrownPotion: 1 − расстояние/4).
    const splash = bot.inventory.items().find(i => i.name === 'splash_potion' && /fire_resistance$/.test(potionOf(i) || ''))
    if (!splash) return null
    try {
      await bot.equip(splash, 'hand')
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      bot.activateItem()
      await sleep(250)
      bot.deactivateItem()
      bot._ndFrUntil = gameClock.now() + 3600 * 50 - 2000
      return 'выпил fire_resistance'
    } catch (e) {
      return `взрывное не бросил: ${e.message}`
    }
  }
  try {
    const before = bot.inventory.items().filter(i => i.name === 'potion' && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
    await bot.equip(pot, 'hand')
    await bot.consume()
    const after = bot.inventory.items().filter(i => i.name === 'potion' && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
    if (after < before) bot._ndFrUntil = gameClock.now() + 3600 * 50 - 2000
    return 'выпил fire_resistance'
  } catch (e) {
    return `зелье не выпил: ${e.message}`
  }
}

// Снежок в блейза с упреждением по его скорости (throw.js throwAt решает
// баллистику сам; здесь — только куда целить).
async function snowballAt (bot, blaze, track) {
  const snow = itemNamed(bot, 'snowball')
  if (!snow) return { thrown: false, why: 'снежков нет' }
  const { throwAt } = require('./throw')
  const fn = t => blaze.position.offset(0, 0.9, 0).plus(track.vel().scaled(t))
  return throwAt(bot, fn, { item: snow })
}

function makeTrack (e) {
  let last = null
  let v = new Vec3(0, 0, 0)
  return {
    update () {
      const now = gameClock.now()
      const p = e.position.clone()
      if (last) {
        const dt = (now - last.t) / 50
        if (dt > 0.5) v = p.minus(last.p).scaled(1 / dt)
      }
      last = { p, t: now }
    },
    vel: () => v
  }
}

function canApproachSpawner (bot, dead) {
  return hasEffect(bot, 'fire_resistance') || watchers(bot, dead) === 0
}
async function walkNear (bot, ctl, target, range, ms, { stopIf = null }: any = {}) {
  if (stopIf?.()) return { ok: false, error: 'на пути линия огня — сначала бой или укрытие' }
  const guard = stuckGuard(bot, ctl)
  let timer = null
  const path = gotoPath(bot, new goals.GoalNear(target.x, target.y, target.z, range))
  let stopped = false, release = null
  const changed = new Promise<void>(resolve => { release = resolve })
  const onTick = () => {
    if (!stopIf?.()) return
    stopped = true
    try { bot.pathfinder.setGoal(null) } catch {}
    path.cancel?.(); release?.()
  }
  if (stopIf) bot.on('physicsTick', onTick)
  try {
    await Promise.race([
      path,
      guard.promise,
      changed,
      new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), ms) })
    ])
    if (stopped) return { ok: false, error: 'на пути появилась линия огня — новый выбор боя или укрытия' }
    // goto «успешен» и на пустом пути (noPath длины 0, mineflayer-pathfinder
    // lib/goto.js) — дошёл, только если правда рядом.
    const d = bot.entity.position.distanceTo(new Vec3(target.x + 0.5, target.y, target.z + 0.5))
    return d <= range + 1.8 ? { ok: true } : { ok: false, error: 'пути нет' }
  } catch (e) {
    try { bot.pathfinder.setGoal(null) } catch {}
    return { ok: false, error: e.message }
  } finally {
    if (stopIf) bot.removeListener('physicsTick', onTick)
    path.cancel?.()
    guard.stop()
    if (timer) gameClock.clearTimeout(timer)
  }
}

// Где ни один из этих блейзов не видит: кольца от 5 до 22 блоков, 24
// направления, клетка, где можно стоять, без лавы в 2 блоках. Блейз, потерявший
// цель, подлетает только первые 5 тиков (BlazeAttackGoal lastSeen < 5) — за
// углом его шары не достают, и там можно отъесться.
function restSpots (bot, blazes, { min = 4, max = 24, want = 6, maxSeen = 0 }: any = {}) {
  const lava = bot.registry.blocksByName.lava.id
  const out: any = []
  // Только связанные с нами клетки (walkable.js): кольца точек находили
  // «укрытие» за стеной и на крыше арены — туда не дойти, и первый прогон
  // потратил все четыре отдыха на путь в никуда.
  const nodes = walkable(bot, bot.entity.position, { radius: max, maxNodes: 3000 })
  out.stats = { nodes: nodes.length, hot: 0, seen: 0 }
  for (const { pos, d } of nodes) {
    if (out.length >= want) break
    if (d < min) continue
    const r = d
    let hot = false
    for (let dx = -2; dx <= 2 && !hot; dx++) {
      for (let dy = -1; dy <= 1 && !hot; dy++) {
        for (let dz = -2; dz <= 2 && !hot; dz++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz))
          if (b && b.type === lava) hot = true
        }
      }
    }
    if (hot) { out.stats.hot++; continue }
    const eye = pos.offset(0.5, 1.62, 0.5)
    let seen = 0
    for (const b of blazes) {
      if (raySees(bot, b.position.offset(0, 1.2, 0), eye) && ++seen > maxSeen) break
    }
    if (seen > maxSeen) { out.stats.seen++; continue }
    out.push({ pos, r, seen })
  }
  return out
}

// Отдышаться: за угол, поесть, ждать хп. Возвращает, что вышло.
// Ифрит, которого знает игрок: виден лучом или слышен (дыхание/залп ифрита — звук сущности, слышен в 16 бл.: дальность звука по
// умолчанию, SoundEvent.createVariableRangeEvent 1.21.11). Дальше 16 — только видимые (замечание проверки 06.10: как у игрока).
const BLAZE_HEAR = 16
function liveBlazes (bot, dead, radius = 48) {
  // Своё честное правило (слух 16 / видимые) — без eyes.knownEntities.
  return (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'blaze' && e.position && e.isValid !== false &&
    !dead.has(e.id) && e.position.distanceTo(bot.entity.position) <= radius && (e.position.distanceTo(bot.entity.position) <= BLAZE_HEAR || seesMob(bot, e)))
}

// Сколько блейзов видят нас сейчас (луч от их глаз до наших).
function watchers (bot, dead) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  return liveBlazes(bot, dead, 40).filter((b : any) => raySees(bot, b.position.offset(0, 1.2, 0), eye)).length
}

// Не стоять под перекрёстным огнём: на ближайшую связанную клетку, откуда
// видно не больше одного блейза. Блейз, потерявший цель, подлетает 5 тиков и
// снова висит — из-за угла они выходят по одному, и меч достаёт их по очереди.
async function takeCover (bot, ctl, dead) {
  const blazes = liveBlazes(bot, dead, 40)
  const spots: any = restSpots(bot, blazes, { min: 2, max: 22, want: 4, maxSeen: 1 })
  for (const s of spots) {
    if (ctl.aborted) break
    await walkNear(bot, ctl, s.pos, 0, 10000)
    if (bot.entity.position.floored().distanceTo(s.pos) <= 1.5) return { at: xyz(s.pos), seen: watchers(bot, dead) }
  }
  return { at: null, why: spots.length ? 'до укрытия не дошёл' : 'укрытия рядом нет', blazes: blazes.length, ...spots.stats }
}

async function rest (session, ctl, dead, { until = 18, maxMs = 45000 }: any = {}) {
  const bot = session.bot
  const actions = require('./actions')
  const blazes = ents(bot).filter((e : any) => e && e.name === 'blaze' && e.position && e.isValid !== false &&
    !dead.has(e.id) && e.position.distanceTo(bot.entity.position) <= 48)
  const hp0 = Math.round(bot.health ?? 0)
  const spots = restSpots(bot, blazes)
  let at = null
  let tried = 0
  for (const s of spots.slice(0, 4)) {
    if (ctl.aborted) break
    tried++
    await walkNear(bot, ctl, s.pos, 0, 15000)
    // Свидетель — где тело стоит и видит ли его кто-то, а не «pathfinder
    // закончил»: он кончает и без пути.
    if (bot.entity.position.floored().distanceTo(s.pos) > 1.5) continue
    const eye = bot.entity.position.offset(0, 1.62, 0)
    if (blazes.some((b : any) => b.isValid !== false && raySees(bot, b.position.offset(0, 1.2, 0), eye))) continue
    at = s.pos
    break
  }
  if (!at) return { rested: false, why: spots.length ? `до укрытия не дошёл (пробовал ${tried})` : 'укрытия от блейзов рядом нет', hp: hp0 }
  const t0 = gameClock.now()
  let ate = null
  while (!ctl.aborted && gameClock.now() - t0 < maxMs && (bot.health ?? 0) < until) {
    if ((bot.food ?? 20) < 20) {
      try { const r = await actions.eat(session, {}); if (r && r.ate) ate = r.ate } catch {}
    }
    // Пришёл блейз — отдых кончился, дерёмся.
    const near = ents(bot).some((e : any) => e && e.name === 'blaze' && e.position && e.isValid !== false &&
      !dead.has(e.id) && e.position.distanceTo(bot.entity.position) <= 12 && seesMob(bot, e))
    if (near) break
    await sleep(1000)
  }
  const rested = !ctl.aborted && (bot.health ?? 0) >= until && (bot.food ?? 0) >= 18
  return { rested, why: rested ? undefined : 'за укрытием не восстановился', at: xyz(at), seconds: Math.round((gameClock.now() - t0) / 1000), hp: `${hp0} -> ${Math.round(bot.health ?? 0)}`, ate: ate || undefined }
}

// ============================================================ бой у спавнера
// Лаборатория этапов (2026-09-27, try-lab-blaze.js: настоящая крепость
// server-nether, набор кампании без огнестойкости). Старый бой через
// combat.fight/pvp.duel: 2 блейза за 103 с и 25.7 хп урона — огонь после
// шаров 12, сами шары 7.5, удар в упор 6.2; на 7 хп «укрытия рядом нет», и
// все следующие вызовы кончались сразу. Здесь бой по механике блейза
// (BlazeAttackGoal, SmallFireball, LivingEntity.applyItemBlocking, 1.21.11):
//   * очередь: флаг charged (метаданные flags, бит 0) встаёт за 60 тиков до
//     первого шара; шары на 60/66/72-м тике, флаг падает на 78-м, потом 100
//     тиков тишины. Щит лицом к нему — с 2.3 с после подъёма флага и до 0.7 с
//     после падения (шару ещё лететь).
//   * щит гасит шар ЦЕЛИКОМ вместе с огнём: SmallFireball.onHitEntity
//     возвращает прежние тики огня, если hurtServer отказал. Держит всё в
//     передних 180° по горизонтали (blocks_attacks horizontal_blocking_angle
//     90), срабатывает через 0.25 с после подъёма (block_delay_seconds).
//   * радар: spawn_entity small_fireball несёт точку и скорость (lpVec3 —
//     читаем сами, как dragon.js); прямая у нашего тела — щит к ней.
//   * между очередями — меч, если достаю (3 блока от глаз до коробки), иначе
//     лук, если до ближайшей очереди больше 1.5 с; иначе подойти на шаг.
//   * мало хп — коробка из 10 блоков (fortify.boxIn), поесть, отлечиться
//     (блейз без взгляда бросает цель через 60 тиков и гасит заряд),
//     выломать сторону к спавнеру.

const CHARGE_MS = 3000 // флаг встал → первый шар
const VOLLEY_END_MS = 3900 // флаг падает
const SHIELD_LEAD_MS = 700 // щиту нужно 0.25 с плюс запас на пакеты
const TAIL_MS = 800 // после падения флага шар ещё летит
const MELEE = 2.95
// Откат удара по предмету в руке (attack_speed 1.21.11: меч 1.6/с = 625 мс, кирка 1.2/с = 833 мс — pvp.cooldownMs, +1 тик запаса).
// Кирка с интервалом меча била на 3/4 силы (замечание проверки 06.10).
const swingMs = bot => require('./pvp').cooldownMs(bot.heldItem)
const BOW_MIN = 3.5
// Лук — только по близким (14): дальний блейз и умирает далеко, стержень за
// пределами вылазки (замер 26: 5 убийств, стержни за 24-28 блоков).
const BOW_MAX = 14
const REST_BLOCKS = 10
const BLAZE_EYE = 1.53 // 1.8 × 0.85
// Ближе этого щит поднимается по заряду (шар долетает быстрее 0.6 с — по
// радару не успеть: щиту нужно 0.25 с); дальше — по радару, только когда шар
// правда летит в нас. Разброс шара — triangle(dx, 2.297·√d·0.5): с 9 блоков
// ±3.4 блока, и большинство очередей мимо. Пятый замер: четверо видящих в 8–10
// блоках держали щит «по заряду» почти всё время — 3 стрелы за 95 с.
const NEAR = 7

function flagsIndex (bot) {
  try {
    const keys = bot.registry.entitiesByName.blaze.metadataKeys
    const i = keys.indexOf('flags')
    if (i >= 0) return i
  } catch {}
  return 16
}

function chargedNow (bot, e, idx) {
  const f = e && e.metadata ? e.metadata[idx] : undefined
  return typeof f === 'number' && (f & 1) !== 0
}

// Луч без поблажек (perception.raySees считает видимым всё, что упёрлось
// ближе 1.2 блока к цели, — за стенкой коробки это «видит»).
function losClear (bot, a, b) {
  const d = b.minus(a)
  const dist = d.norm()
  if (dist < 0.3) return true
  try {
    const hit = bot.world.raycast(a, d.scaled(1 / dist), dist - 0.05, x => x && x.boundingBox !== 'empty')
    return !hit
  } catch { return true }
}

// Тот же луч, но клетки из skip — воздух (окно, которое ещё выкопаем).
function losClearBut (bot, a, b, skip) {
  const d = b.minus(a)
  const dist = d.norm()
  if (dist < 0.3) return true
  const dir = d.scaled(1 / dist)
  let from = a
  let left = dist
  for (let i = 0; i < 4; i++) {
    let hit = null
    try { hit = bot.world.raycast(from, dir, left - 0.05, x => x && x.boundingBox !== 'empty') } catch { return true }
    if (!hit) return true
    if (!skip.some(c => c.equals(hit.position))) return false
    const t = hit.position.offset(0.5, 0.5, 0.5).minus(from).dot(dir) + 0.9
    from = from.plus(dir.scaled(t))
    left -= t
    if (left <= 0.1) return true
  }
  return false
}

const myEye = bot => require('./pick').eyeOf(bot)
// Какая высота на его коробке видна из наших глаз (доля роста): середина,
// выше, макушка, низ. Замер 9: блейз видит нас глазами (1.53), а середина его
// тела (0.99) за краем ступени помоста — лук упирался в блок 285,59,328.
const AIM_FRACS = [0.55, 0.8, 0.95, 0.3]
// Под блейзом есть пол не глубже 7 блоков и не ниже нас на 4 — стержень с
// убитого упадёт туда, где его подобрать. Над пустотой (за краем помоста,
// над лавовым морем) убийство даёт 0 (замер 10: 10 убийств — 0 стержней).
// Куда упадёт стержень с убитого: прямо вниз (ItemEntity без толчка по
// горизонтали почти не сносит), до 12 блоков, сквозь воздух — ни лавы, ни
// воды. Клетка на полу — или null.
function dropCell (bot, pos) {
  const c = pos.floored()
  for (let dy = 0; dy <= 12; dy++) {
    const b = bot.blockAt(c.offset(0, -dy, 0))
    if (!b) return null
    if (/lava|water/.test(b.name)) return null
    if (b.boundingBox === 'block') return dy === 0 ? null : c.offset(0, -dy + 1, 0)
  }
  return null
}
// Стержень с этого блейза поднять можно: клетка падения — в наборе клеток, куда
// дойти ногами (reach, walkable от места боя), или рядом с такой.
function floorBelow (bot, e, me, reach = null) {
  const cell = dropCell(bot, e.position)
  if (!cell) return false
  if (!reach) return cell.y >= Math.floor(me.y) - 5 && cell.y <= Math.floor(me.y) + 1
  const k = q => `${q.x},${q.y},${q.z}`
  if (reach.has(k(cell))) return true
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (reach.has(k(cell.offset(dx, 0, dz)))) return true
  return false
}
function aimFrac (bot, e) {
  const eye = myEye(bot)
  for (const f of AIM_FRACS) if (losClear(bot, eye, e.position.offset(0, (e.height || 1.8) * f, 0))) return f
  return null
}
const blazeEye = e => e.position.offset(0, BLAZE_EYE, 0)
const seesMe = (bot, e) => losClear(bot, blazeEye(e), myEye(bot))

// SmallFireball 5, melee 6, shield delay 5 ticks (jar 1.21.11); only current rays/projectiles enter the price.
function blazeShieldPrice (bot, blazes, radar, guard, fireproof, face) {
  const now = gameClock.now()
  const incoming = fireproof ? [] : radar.incoming(now)
  const sources = incoming.map(b => ({ from: b.from, hit: 5, eta: b.eta }))
  for (const e of blazes) {
    if (!seesMe(bot, e)) continue
    if (e.position.distanceTo(bot.entity.position) < 2) sources.push({ from: blazeEye(e), hit: 6, eta: 0 })
    else if (!fireproof && e.position.distanceTo(bot.entity.position) < 48 && radar.untilDanger(e, now) === 0) sources.push({ from: blazeEye(e), hit: 5, eta: 0 })
  }
  const me = bot.entity.position
  const to = face?.minus(me)
  const shield = guard.stats.worn && bot.inventory.slots[45]?.name === 'shield' && now >= (bot._ndShieldDisabledUntil || 0)
  const ready = shield && !!guard.blocking?.()
  const armor = require('./assess').gearOf([5, 6, 7, 8].map(i => bot.inventory.slots[i]))
  const damage = sources.reduce((n, s) => {
    const d = s.from.minus(me)
    const blocked = shield && to && d.x * to.x + d.z * to.z >= 0 && (ready || s.eta >= 5 * 50)
    return n + (blocked ? 0 : require('./assess').afterArmor(s.hit, armor.armor, armor.tough))
  }, 0)
  // shortcut: the burning metadata has no remaining duration; reserve a full projectile burn until native telemetry supplies it.
  const fire = !fireproof && (bot.entity.metadata?.[0] & 1) ? 5 : 0
  return { damage, fire, cost: damage + fire, sources, incoming }
}

// Сырой spawn_entity: id, entityId (varint), UUID (16), type (varint), x y z
// (f64 BE), lpVec3 — minecraft-protocol читает lpVec3 как little-endian, и
// направления у него мусор (dragon.js, 2026-09-26).
function readVarIntAt (buf, off) {
  let v = 0; let s = 0; let b
  do { b = buf[off++]; v += (b & 0x7f) * 2 ** s; s += 7 } while (b & 0x80 && s < 35)
  return [v, off]
}
function spawnVelocityRaw (buf) {
  let off = 0
  let v
  ;[v, off] = readVarIntAt(buf, off)
  let entityId
  ;[entityId, off] = readVarIntAt(buf, off)
  off += 16
  let type
  ;[type, off] = readVarIntAt(buf, off)
  const x = buf.readDoubleBE(off); const y = buf.readDoubleBE(off + 8); const z = buf.readDoubleBE(off + 16)
  off += 24
  const a = buf[off]
  if (a === 0) return { entityId, type, pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 } }
  const packed = buf.readUInt32BE(off + 2) * 65536 + buf[off + 1] * 256 + a
  let scale = a & 3
  if ((a & 4) === 4) { const [c] = readVarIntAt(buf, off + 6); scale += c * 4 }
  const un = sh => Math.min(Math.floor(packed / 2 ** sh) % 32768, 32766) * 2 / 32766 - 1
  return { entityId, type, pos: { x, y, z }, vel: { x: un(3) * scale, y: un(18) * scale, z: un(33) * scale } }
}
// Путь шара за n тиков: v ← (v + 0.1·v̂)·0.95, v₀ = 0.1 (AbstractHurtingProjectile).
const FB_PATH = (() => { const out = [0]; let v = 0.1; let s = 0; for (let k = 1; k <= 120; k++) { v = (v + 0.1) * 0.95; s += v; out.push(s) } return out })()
function fbTicksTo (dist) { for (let k = 0; k < FB_PATH.length; k++) if (FB_PATH[k] >= dist) return k; return FB_PATH.length }

// Радар: заряд каждого блейза (когда встал флаг) и летящие шары.
function makeRadar (bot) {
  const idx = flagsIndex(bot)
  const charge = new Map() // id -> { on, since (мс|null — встал до нас), off }
  const balls = new Map() // entityId -> { p0, dir, t0 }
  const stats: any = { balls: 0 }
  let fbType = null
  try { fbType = bot.registry.entitiesByName.small_fireball.id } catch {}
  const onUpd = e => {
    if (!e || e.name !== 'blaze') return
    const on = chargedNow(bot, e, idx)
    const c = charge.get(e.id)
    const now = gameClock.now()
    if (!c) { charge.set(e.id, { on, since: null, off: on ? 0 : now, first: now }); return }
    if (on && !c.on) { c.on = true; c.since = now }
    if (!on && c.on) { c.on = false; c.off = now }
  }
  const onRaw = buf => {
    try {
      const r = spawnVelocityRaw(buf)
      if (fbType === null || r.type !== fbType) return
      const v = r.vel
      const n = Math.hypot(v.x, v.y, v.z)
      if (n < 1e-6) return
      balls.set(r.entityId, { p0: new Vec3(r.pos.x, r.pos.y, r.pos.z), dir: new Vec3(v.x / n, v.y / n, v.z / n), t0: gameClock.now() })
      stats.balls++
      // Разбор: куда метил шар (промах мимо тела в миг вылета).
      try {
        const body = bot.entity.position.offset(0, 0.9, 0)
        const b = balls.get(r.entityId)
        const rr = body.minus(b.p0)
        const s2 = rr.x * b.dir.x + rr.y * b.dir.y + rr.z * b.dir.z
        const miss = Math.hypot(rr.x - b.dir.x * s2, rr.y - b.dir.y * s2, rr.z - b.dir.z * s2)
        if (miss < 2.5 && s2 > 0) { stats.aimed = (stats.aimed || 0) + 1; log('шар', { d: Math.round(s2 * 10) / 10, miss: Math.round(miss * 10) / 10, eta: fbTicksTo(s2) * 50 }) }
      } catch {}
      if (balls.size > 64) for (const [k, b] of balls) if (gameClock.now() - b.t0 > 5000) balls.delete(k)
    } catch {}
  }
  const onGone = e => { if (e) { charge.delete(e.id); balls.delete(e.id) } }
  bot.on('entityUpdate', onUpd)
  bot.on('entityGone', onGone)
  bot._client.on('raw.spawn_entity', onRaw)
  return {
    stats,
    stop () {
      bot.removeListener('entityUpdate', onUpd)
      bot.removeListener('entityGone', onGone)
      bot._client.removeListener('raw.spawn_entity', onRaw)
    },
    // Сколько мс до его ближайшей очереди (0 — уже опасен, Infinity — не заряжен
    // и тихо). Не видевшего подъём флага считаем опасным сразу. Окно — по
    // тикам очереди и полёту шара до нас (fl): шары вылетают на 3000/3300/3600
    // мс после подъёма флага и летят fl; щит поднят за 400 мс до первого
    // попадания (0.25 с блок + пакеты) и до 100 мс после последнего — ~1.1 с
    // на очередь вместо 2.4 (второй замер: трое видящих держали щит всё время).
    untilDanger (e, now = gameClock.now()) {
      const c = charge.get(e.id)
      const on = c ? c.on : chargedNow(bot, e, idx)
      const fl = fbTicksTo(e.position.offset(0, 1.4, 0).distanceTo(bot.entity.position.offset(0, 0.9, 0))) * 50
      if (!on) {
        if (c && c.off && now - c.off < Math.max(0, fl - 200) + 100) return 0
        return Infinity
      }
      if (!c || c.since === null) return 0
      const t = now - c.since
      const start = CHARGE_MS - 400 + fl
      const end = CHARGE_MS + 600 + fl + 100
      if (t < start) return start - t
      // В окне — опасен; флаг висит дольше очереди — цель у него за стеной:
      // выстрелит, как только увидит.
      return 0
    },
    charged (e) { const c = charge.get(e.id); return c ? c.on : chargedNow(bot, e, idx) },
    // Шары, чья прямая проходит у нашего тела и ещё не прилетели: [{ from, eta }].
    incoming (now = gameClock.now()) {
      const out = []
      const body = bot.entity.position.offset(0, 0.9, 0)
      for (const [id, b] of balls) {
        const age = (now - b.t0) / 50
        if (age > 60) { balls.delete(id); continue }
        const r = body.minus(b.p0)
        const s = r.x * b.dir.x + r.y * b.dir.y + r.z * b.dir.z
        if (s < -0.5) continue
        const px = r.x - b.dir.x * s; const py = r.y - b.dir.y * s; const pz = r.z - b.dir.z * s
        const miss = Math.hypot(px, py * 0.7, pz)
        if (miss > 1.4) continue
        const flown = FB_PATH[Math.min(FB_PATH.length - 1, Math.floor(age))] || 0
        if (flown > s + 1) continue
        // Стена между шаром и нами — не долетит.
        if (!losClear(bot, b.p0.plus(b.dir.scaled(Math.max(0, flown))), body)) continue
        out.push({ from: b.p0, eta: Math.max(0, (fbTicksTo(s) - age) * 50), id })
      }
      return out
    }
  }
}

// Пол под точкой: ближайшая клетка, где можно стоять, не ниже 4 блоков.
function floorUnder (bot, p) {
  const { standable } = require('./walkable')
  const c = p.floored()
  for (let dy = 0; dy >= -4; dy--) {
    const q = c.offset(0, dy, 0)
    if (standable(bot, q)) return q
  }
  return null
}

// Точка боя у спавнера (замер 4: с места прихода в 11 блоках спавнер за краем
// помоста, лук упирался в забор, и бой простоял минуту без выстрела). Клетка в
// 3.5..9 блоках от спавнера по горизонтали, откуда ВИДНО больше всего точек
// куба спавна (±3 по x/z, +0.5 и +2 по высоте — там висят блейзы), без лавы в
// 3 блоках и не на краю; лучше — со стеной за спиной (все блейзы спереди, щит
// держит их разом).
function spawnView (bot, eye, c) {
  let seen = 0
  for (const x of [-3, -1, 1, 3]) for (const z of [-3, -1, 1, 3]) for (const y of [0.5, 2]) {
    if (losClear(bot, eye, c.offset(x, y, z))) seen++
  }
  return seen
}
function choosePost (bot, spawner, avoid = null) {
  if (!spawner) return null
  const c = spawner.offset(0.5, 0, 0.5)
  const nodes = walkable(bot, bot.entity.position, { radius: 16, maxNodes: 2500 })
  let best = null
  for (const { pos, d } of nodes) {
    if (!standable(bot, pos)) continue
    const h = Math.hypot(pos.x + 0.5 - c.x, pos.z + 0.5 - c.z)
    // Вплотную к спавнеру (1.5..4): новые блейзы появляются в ±4 от него на
    // его высоте ±1 (BaseSpawner) — в досягаемости меча, и бьются до первой
    // очереди (заряд 3 с). Замер 11: у спавнера 3 убийства за 10 с, с 7 блоков —
    // одно за полминуты и 21 стрела на 6 убийств.
    if (h < 1.4 || h > 9) continue
    if (Math.abs(pos.y - spawner.y) > 2) continue
    // A nearby step can expose the hall from behind its floor. Avoiding the
    // previous post costs preference; it must not discard the only real exit.
    const repeatCost = avoid ? Math.max(0, 2.5 - pos.distanceTo(avoid)) : 0
    const eye = pos.offset(0.5, 1.62, 0.5)
    if (eye.distanceTo(c.offset(0, 0.5, 0)) > 13) continue
    if (lavaNear(bot, pos, 3)) continue
    const f = bot.blockAt(pos); const hd = bot.blockAt(pos.offset(0, 1, 0))
    if ((f && /fire/.test(f.name)) || (hd && /fire/.test(hd.name))) continue
    let edge = 0
    for (const sd of DOOR_SIDES) {
      const g1 = bot.blockAt(pos.plus(sd).offset(0, -1, 0)); const g2 = bot.blockAt(pos.plus(sd).offset(0, -2, 0)); const g0 = bot.blockAt(pos.plus(sd))
      if (!solidB(g0) && !solidB(g1) && !solidB(g2)) edge++
    }
    const view = spawnView(bot, eye, c)
    if (view < 4) continue
    const bx = (pos.x + 0.5 - c.x) / h; const bz = (pos.z + 0.5 - c.z) / h
    const back = pos.offset(Math.round(bx), 0, Math.round(bz))
    let cover = 0
    for (const y of [0, 1]) if (solidB(bot.blockAt(back.offset(0, y, 0)))) cover++
    // S1e: на посту должна копаться яма отлёжки (3, иначе 2): отлечиться на помосте крепости «в толщу» не выходило — «лава/пусто у
    // ямы», ход к соседним клеткам под ударами ифритов вплотную (s1e-K4-7: 19.9 урона в фазе «в толщу отлечиться», смерть; K4-4, K4-1).
    const pit = process.env.ND_POST_PIT === '0' ? 0 : !pitWhyAt(bot, pos, 3) ? 2 : !pitWhyAt(bot, pos, 2) ? 1 : 0
    const score = view - edge * 4 + cover * 1.5 - Math.abs(h - 2.5) * 1.5 - Math.abs(pos.y - spawner.y) - d * 0.1 + pit * 3 - repeatCost
    if (!best || score > best.score) best = { pos, score, h: Math.round(h * 10) / 10, view, cover, edge, pit }
  }
  return best
}

// A remembered spawner tells us where its hall is, not where a hidden blaze is.
// Open one visible obstruction towards that known volume, like a bunker window.
function windowForPost (bot, spawner) {
  if (!spawner || !standable(bot, bot.entity.position.floored())) return null
  const pick = require('./pick'); const tools = require('./tools')
  const eye = pick.eyeOf(bot), c = spawner.offset(0.5, 0, 0.5)
  const targets = []
  for (const x of [-3, -1, 1, 3]) for (const z of [-3, -1, 1, 3]) for (const y of [0.5, 2]) targets.push(c.offset(x, y, z))
  const candidates = new Map()
  for (const q of targets) {
    const delta = q.minus(eye), len = delta.norm()
    if (len < 0.05) continue
    const hit = pick.blockOnRay(bot, eye, delta.scaled(1 / len), len - 0.05)
    if (hit) candidates.set(hit.pos.toString(), hit.block)
  }
  let best = null
  for (const block of candidates.values()) {
    const pos = block.position
    if (/spawner|chest|barrel|shulker/.test(block.name) || !tools.breakable(block)) continue
    if (!bot.canDigBlock(block) || !pick.blockSeen(bot, pos, { range: 4.5 })) continue
    const dig = tools.bestFor(bot, block)
    if (!Number.isFinite(dig.ms)) continue
    let gain = 0
    for (const q of targets) {
      const delta = q.minus(eye), len = delta.norm()
      if (len < 0.05) continue
      const hit = pick.blockOnRay(bot, eye, delta.scaled(1 / len), len - 0.05)
      if (!hit || !hit.pos.equals(pos)) continue
      // Only this block is ignored. A second wall still closes the view.
      const after = bot.world.raycast(eye, delta.scaled(1 / len), len - 0.05,
        b => b && b.boundingBox !== 'empty' && !b.position.equals(pos))
      if (!after) gain++
    }
    const score = gain / Math.max(50, dig.ms)
    // Equal-cost views: open the upper window, not a notch in the hall floor.
    if (gain > 0 && (!best || score > best.score || (score === best.score && pos.y > best.pos.y))) best = { pos, gain, ms: dig.ms, score }
  }
  return best
}

// Ходьба без копания и стройки: к блейзу на шаг — не сквозь стену крепости и
// не столбом в воздух.
function fightMoves (session) {
  const bot = session.bot
  const { Movements } = require('mineflayer-pathfinder')
  const m = new Movements(bot)
  m.canDig = false
  m.allow1by1towers = false
  m.allowParkour = false
  m.allowSprinting = false
  m.maxDropDown = 2
  m.scafoldingBlocks = []
  try { require('./worlds').tuneMovements && require('./worlds').tuneMovements(bot, m) } catch {}
  return m
}

// Коробка на отдых: 10 блоков, поесть, ждать хп, выйти к спавнеру.
// Клетка под коробку: пол под ней и под всеми четырьмя соседями (стенам есть на
// что встать), над головой и вокруг — воздух или блок (не лава, не огонь), лавы
// в 3 блоках нет. Ближайшая, кроме той, где не вышло.
function boxSpot (bot, not) {
  const nodes = walkable(bot, bot.entity.position, { radius: 10, maxNodes: 1500 })
  for (const { pos, d } of nodes) {
    if (d < 1 || (not && pos.equals(not))) continue
    let ok = true
    for (const sd of DOOR_SIDES) {
      const g = bot.blockAt(pos.plus(sd).offset(0, -1, 0))
      const f = bot.blockAt(pos.plus(sd))
      const h = bot.blockAt(pos.plus(sd).offset(0, 1, 0))
      if (!solidB(g) && !solidB(f)) { ok = false; break }
      if (!(solidB(f) || airB(f)) || !(solidB(h) || airB(h))) { ok = false; break }
    }
    if (!ok) continue
    const roof = bot.blockAt(pos.offset(0, 2, 0))
    if (!(solidB(roof) || airB(roof))) continue
    if (lavaNear(bot, pos, 3)) continue
    return pos
  }
  return null
}

async function boxRest (session, ctl, { toward, until = 19, maxMs = 60000, hardMs = maxMs, onPhase = () => {}, threat = null }: any = {}) {
  const bot = session.bot
  const fortify = require('./fortify')
  const actions = require('./actions')
  const { pickFiller } = require('./build')
  const filler = pickFiller(bot)
  const blocks = bot.inventory.items().filter(i => /^(cobblestone|cobbled_deepslate|netherrack|stone|dirt|blackstone|basalt|nether_bricks|soul_soil|andesite|diorite|granite|tuff|deepslate)$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  if (!filler || blocks < REST_BLOCKS) return { rested: false, why: `блоков на коробку мало (${blocks} из ${REST_BLOCKS})` }
  const hp0 = Math.round(bot.health ?? 0)
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  onPhase('коробка')
  let box = null
  let enc = null
  const tries = []
  // Враг вплотную или бьют во время стройки — коробку бросить: 2026-09-29
  // 13:55 основной бот строил её рядом с ифритом, клетки заняты, «другое
  // место» — и три удара 10.7 → 0. Решает вызвавший (бегство, не стройка).
  const underAttack = () => (threat && threat()) || (bot.health ?? 0) <= hp0 - 4
  for (let attempt = 0; attempt < 3 && !ctl.aborted; attempt++) {
    if (underAttack()) return { rested: false, threat: true, why: 'враг вплотную — коробку не строю', tries }
    box = await fortify.boxIn(bot, { toward, roof: true, ctl, timeoutMs: 800, hard: false })
    if (!box.sealed) {
      // Недостроено: достроить (патч по тому же плану) — на краю моста опоры нет.
      await fortify.patch(bot, box.plan, { timeoutMs: 800 }).catch(() => 0)
    }
    enc = fortify.enclosure(bot, box.cell)
    tries.push({ at: xyz(box.cell), placed: box.placed, walls: enc.walls, roof: enc.roof, failed: box.failed ? box.failed.slice(0, 2) : undefined })
    if (enc.sealed) break
    if (underAttack()) return { rested: false, threat: true, why: 'враг вплотную — коробку не достроить', tries }
    // Не закрылось (проём в стене крепости, край помоста): сидеть в полукоробке
    // под шарами — смерть (замер 3: «placed 1», 26 с на огне и в лаве). Клетка,
    // где у всех четырёх сторон есть пол, без лавы в 3 блоках — и снова.
    const spot = boxSpot(bot, box.cell)
    if (!spot) break
    onPhase('коробка: другое место')
    await walkNear(bot, ctl, spot, 0, 8000)
    if (!bot.entity.position.floored().equals(spot)) break
  }
  if (!enc || !enc.sealed) {
    return { rested: false, why: 'коробка не закрылась', tries }
  }
  const t0 = gameClock.now()
  let ate = 0
  // Лечение идёт — сидеть и после maxMs (до hardMs), пока хп растёт: 2026-09-29
  // 12:27 закрытая коробка за 60 с вылечила дольками арбуза 11 → 18, отдых
  // объявлен незавершённым на 18 из 19, и бой у спавнера брошен целиком.
  // 20 с без прибавки — лечение встало (еда кончилась, сытость < 18).
  let bestHp = bot.health ?? 0
  let riseAt = t0
  onPhase('отдых в коробке')
  while (!ctl.aborted && (bot.health ?? 0) < until) {
    const now = gameClock.now()
    if ((bot.health ?? 0) > bestHp) { bestHp = bot.health ?? 0; riseAt = now }
    if (now - t0 >= maxMs && (now - t0 >= hardMs || now - riseAt > 20000)) break
    if ((bot.food ?? 20) < 20) {
      try { const r = await actions.eat(session, {}); if (r && r.ate) ate++ } catch {}
    }
    if ((bot.food ?? 20) < 18 && !bot.inventory.items().some(i => /cooked|bread|apple|carrot|potato|steak|porkchop|mutton|chicken|rabbit|cod|salmon|beef|stew|cookie|pie|melon|berries/.test(i.name))) break
    await sleep(500)
  }
  const healed = `${hp0} -> ${Math.round(bot.health ?? 0)}`
  const rested = !ctl.aborted && (bot.health ?? 0) >= until && (bot.food ?? 0) >= 18
  if (!rested) return { rested: false, why: 'лечение в коробке не завершено', placed: box.placed,
    sealed: enc.sealed, seconds: Math.round((gameClock.now() - t0) / 1000), hp: healed, ate, exited: false }
  onPhase('выход из коробки')
  const out = await fortify.breakOut(bot, box.cell, { toward }).catch(e => ({ ok: false, steps: [e.message] }))
  // Выломанное — в рюкзак (коробка ест 10 блоков, запас 64).
  try { await actions.collectNearbyDrops(bot, ctl, { radius: 3, timeoutMs: 2500 }) } catch {}
  // Дыра в стене ещё не выход. Сбор своего дропа оставлял тело внутри
  // коробки: второй бой 400 с не видел ни одного ифрита. Выйти ногами и
  // проверить клетку после сбора, пока следующая тактика не взяла руки.
  let exited = false
  if (out.ok && out.outside && !ctl.aborted) {
    await walkNear(bot, ctl, out.outside, 0, 5000)
    exited = bot.entity.position.floored().equals(out.outside)
  }
  return {
    rested: true,
    placed: box.placed,
    tries: tries.length > 1 ? tries : undefined,
    sealed: enc.sealed,
    seconds: Math.round((gameClock.now() - t0) / 1000),
    hp: healed,
    ate: ate || undefined,
    exited,
    out: exited ? 'вышел' : `выход не завершён: ${(out.steps || []).join(', ')}`
  }
}

// Шалаш с дверью у спавнера. Второй замер (щит по очередям, бой в открытую):
// хп держалось, но видели сразу 5 блейзов, щит стоял всё время, за 120 с
// ни одного убийства, а шары из-за спины (180° не хватает) всё равно сняли 7
// хп и 10 огня. Клетка со стенами с трёх сторон и крышей оставляет только
// дверь 1x2 к спавнеру: нас видно лишь в конусе двери (±45° из середины
// клетки), значит, все шары летят в дверь — щит к двери держит каждый. Бьём
// из двери: мечом того, кто в упор, луком — остальных в тишине между
// очередями. Блейз без взгляда на нас цель бросает через 60 тиков
// (TargetGoal unseenMemoryTicks) и заряд гасит (BlazeAttackGoal.stop).
const DOOR_SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

function solidB (b) { return !!b && b.boundingBox === 'block' }
function airB (b) { return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }

// Где строить: клетка в 2.5..7 блоках от спавнера по горизонтали, глаза не
// ниже его центра на 3 и не выше на 2, дверь (сосед к спавнеру, ноги и
// голова) свободна, спавнер виден из глаз через дверь не дальше 40° от её
// оси, стены ставятся с пола (край моста — нет).
function planBunker (bot, spawner, have) {
  const c = spawner.offset(0.5, 0.5, 0.5)
  const lava = bot.registry.blocksByName.lava.id
  const nodes = walkable(bot, bot.entity.position, { radius: 18, maxNodes: 3000 })
  let best = null
  const tried = { n: 0, far: 0, door: 0, los: 0, hot: 0, edge: 0, blocks: 0 }
  for (const { pos, d } of nodes) {
    tried.n++
    const h = Math.hypot(pos.x + 0.5 - c.x, pos.z + 0.5 - c.z)
    const dyEye = c.y - (pos.y + 1.62)
    if (h < 2.5 || h > 9 || dyEye < -2.5 || dyEye > 3.5 || pos.offset(0.5, 1.62, 0.5).distanceTo(c) > 13) { tried.far++; continue }
    const vx = c.x - (pos.x + 0.5); const vz = c.z - (pos.z + 0.5)
    const front = Math.abs(vx) >= Math.abs(vz) ? new Vec3(Math.sign(vx), 0, 0) : new Vec3(0, 0, Math.sign(vz))
    const ang = Math.acos(Math.max(-1, Math.min(1, (vx * front.x + vz * front.z) / (Math.hypot(vx, vz) || 1))))
    if (ang > 0.7) { tried.door++; continue }
    // Окно — голова со стороны спавнера: воздух или кирпич, который выкопаем;
    // ноги с той стороны — воздух (дверь) или блок (подоконник).
    const winCell = pos.plus(front).offset(0, 1, 0)
    const win = bot.blockAt(winCell)
    const sill = bot.blockAt(pos.plus(front))
    const digWin = solidB(win) && /nether_brick|netherrack|cobblestone|stone|blackstone|basalt|soul|gravel|dirt/.test(win.name) && !/spawner|chest/.test(win.name)
    if (!(airB(win) || digWin) || !(airB(sill) || solidB(sill))) { tried.door++; continue }
    const eye = pos.offset(0.5, 1.62, 0.5)
    let hot = false
    for (let x = -2; x <= 2 && !hot; x++) for (let y = -1; y <= 2 && !hot; y++) for (let z = -2; z <= 2 && !hot; z++) {
      const b = bot.blockAt(pos.offset(x, y, z))
      if (b && (b.type === lava || /fire/.test(b.name))) hot = true
    }
    if (hot) { tried.hot++; continue }
    // Стены: три стороны кроме двери, ноги и голова; крыша над головой.
    const walls = []
    let bad = false
    for (const s of DOOR_SIDES) {
      if (s.equals(front)) continue
      for (const y of [0, 1]) {
        const q = pos.plus(s).offset(0, y, 0)
        const b = bot.blockAt(q)
        if (solidB(b)) continue
        if (!airB(b)) { bad = true; break }
        // Ноги стены ставятся на пол под ней (или к соседу по стене);
        // голова — на ноги.
        if (y === 0 && !solidB(bot.blockAt(q.offset(0, -1, 0)))) { bad = true; break }
        walls.push(q)
      }
      if (bad) break
    }
    if (bad) { tried.edge++; continue }
    const roof = pos.offset(0, 2, 0)
    let roofNeed = []
    if (!solidB(bot.blockAt(roof))) {
      // Крыше опереться: блок над стеной сзади (back+2) — на её голову.
      const back = front.scaled(-1)
      const sup = pos.plus(back).offset(0, 2, 0)
      roofNeed = solidB(bot.blockAt(sup)) ? [roof] : [sup, roof]
      if (!airB(bot.blockAt(roof))) { tried.edge++; continue }
    }
    const need = walls.length + roofNeed.length
    if (need > have) { tried.blocks++; continue }
    // Сколько клеток куба спавна видно из двери — туда смотрит бой.
    let seen = 0
    for (let x = -3; x <= 3; x += 2) for (let z = -3; z <= 3; z += 2) for (const y of [0, 1.5]) {
      const q = c.offset(x, y, z)
      if (q.distanceTo(eye) < 1.5) continue
      const dx = q.x - eye.x; const dz = q.z - eye.z
      if ((dx * front.x + dz * front.z) / (Math.hypot(dx, dz) || 1) < 0.72) continue
      if (losClearBut(bot, eye, q, digWin ? [winCell] : [])) seen++
    }
    if (seen < 3) { tried.los++; continue }
    const score = seen * 1.2 - need * 0.8 - (digWin ? 1 : 0) - Math.abs(h - 4) * 1.2 - Math.abs(dyEye - 0.5) * 0.7 - d * 0.05
    if (!best || score > best.score) best = { cell: pos, front, walls, roof: roofNeed, need, digWin: digWin ? winCell : null, sill: solidB(sill), h: Math.round(h * 10) / 10, seen, score }
  }
  if (best) best.tried = tried
  return best || { none: true, tried }
}

// Блок на верх соседнего блока, чья верхняя грань выше глаз: из клетки 1x2
// её не видно (честная стройка — только по видимым граням, pick.faceAim), а в
// прыжке глаза на 1.25 выше — видно. Так ставится опора крыши на заднюю стену.
async function jumpPlaceTop (bot, below, timeoutMs = 900) {
  const { pickFiller, withTimeout } = require('./build')
  const { faceAim } = require('./pick')
  const stack = pickFiller(bot)
  if (!stack) return { ok: false, why: 'нечем строить' }
  if (!bot.heldItem || bot.heldItem.type !== stack.type) { try { await bot.equip(stack, 'hand') } catch (e) { return { ok: false, why: e.message } } }
  const ref = bot.blockAt(below)
  if (!solidB(ref)) return { ok: false, why: 'опоры нет' }
  const up = new Vec3(0, 1, 0)
  bot.setControlState('jump', true)
  const t0 = gameClock.now()
  let seen = false
  try {
    while (gameClock.now() - t0 < 900) {
      await sleep(20)
      if (bot.entity.position.y + 1.62 > below.y + 1.2 && faceAim(bot, below, up)) { seen = true; break }
    }
  } finally { bot.setControlState('jump', false) }
  if (!seen) return { ok: false, why: 'верхнюю грань не увидел и в прыжке' }
  try {
    await bot.lookAt(below.offset(0.5, 1, 0.5), true)
    await withTimeout(bot.placeBlock(ref, up), timeoutMs)
  } catch {}
  await sleep(200)
  return { ok: solidB(bot.blockAt(below.offset(0, 1, 0))) }
}

// Коробка с окном у спавнера (лаборатория 2026-09-27, замеры 10-12: в открытую
// у спавнера смерть в 4 попытках из 5 — огонь от шаров со спины, иссушитель,
// удары блейзов в упор). Клетка в 1..5 блоках от спавнера на его высоте ±1,
// стены с четырёх сторон на ноги и голову, крыша; открыт один блок на уровне
// головы — окно в сторону, откуда видно больше всего куба спавна. Всё, что
// летит в нас, летит в окно: щит к окну держит каждый шар (±90° по
// горизонтали), блейз (1.8) и иссушитель (2.4) в окно 1x1 не пролезают, а
// меч из окна достаёт того, кто подлетел (3 блока от глаз). Подбор снаружи
// через стену не гарантирован: Player.aiStep расширяет нашу рамку лишь на 1 блок.
function planKillBox (bot, spawner, have, { hMin = 3, hMax = 7.5, hBest = 5, lowWindow = false }: any = {}) {
  const c = spawner.offset(0.5, 0.5, 0.5)
  const nodes = walkable(bot, bot.entity.position, { radius: 16, maxNodes: 3000 })
  let best = null
  const tried = { n: 0, far: 0, hot: 0, walls: 0, blocks: 0, view: 0 }
  for (const { pos, d } of nodes) {
    tried.n++
    const h = Math.hypot(pos.x + 0.5 - c.x, pos.z + 0.5 - c.z)
    // 3..7 блоков: конус окна (±45° по горизонтали, −51..+37° по вертикали)
    // накрывает куб спавна ±4 только издали — замер 21: коробка в 2 блоках от
    // спавнера видела одного блейза из пяти, 1 стрела за 70 с.
    // Пол зала тоже годится (на 3-4 ниже спавнера): блейзы висят на его высоте
    // и выше, окно смотрит на них снизу вверх (до +37°).
    if (h < hMin || h > hMax || pos.y - spawner.y > 1 || pos.y - spawner.y < -4 || d > 30) { tried.far++; continue }
    if (lavaNear(bot, pos, 2)) { tried.hot++; continue }
    const walls = []
    let bad = false
    for (const sd of DOOR_SIDES) {
      const f = pos.plus(sd); const hd = f.offset(0, 1, 0)
      const bf = bot.blockAt(f); const bh = bot.blockAt(hd)
      if (!(solidB(bf) || airB(bf)) || !(solidB(bh) || airB(bh))) { bad = true; break }
      if (airB(bf)) {
        // Край помоста: под стеной пусто — сначала подпорка (к блоку под нашими
        // ногами она встаёт боком), потом стена (замер 22: у края все 18 клеток
        // отпали, «места под коробку нет»).
        // Под стеной пусто (край помоста) — не годится: подпорку честно (по
        // видимой грани) из клетки не поставить — замер 24, «не к чему
        // прислонить блок» трижды.
        if (!solidB(bot.blockAt(f.offset(0, -1, 0)))) { bad = true; break }
        walls.push(f)
      }
      if (airB(bh)) walls.push(hd)
    }
    if (bad) { tried.walls++; continue }
    const roofAt = pos.offset(0, 2, 0)
    const rb = bot.blockAt(roofAt)
    if (!(solidB(rb) || airB(rb))) { tried.walls++; continue }
    const eye = pos.offset(0.5, 1.62, 0.5)
    for (const sd of DOOR_SIDES) {
      const win = pos.plus(sd).offset(0, lowWindow ? 0 : 1, 0)
      const pad = pos.plus(sd.scaled(2))
      if (lowWindow && (!solidB(bot.blockAt(pad.offset(0, -1, 0))) || !airB(bot.blockAt(pad)) || !airB(bot.blockAt(pad.offset(0, 1, 0))))) continue
      const wb = bot.blockAt(win)
      if (!wb || wb.name === 'spawner') continue
      const digWin = solidB(wb)
      if (digWin && !/nether_brick|netherrack|cobblestone|stone|blackstone|basalt|soul_soil/.test(wb.name)) continue
      let roof = []
      if (!solidB(rb)) {
        const back = pos.minus(sd).offset(0, 2, 0)
        roof = solidB(bot.blockAt(back)) ? [roofAt] : [back, roofAt]
      }
      const myWalls = walls.filter(q => !q.equals(win))
      const need = myWalls.length + roof.length + (lowWindow ? 1 : 0)
      if (need > have) { tried.blocks++; continue }
      // Куб спавна через окно: луч из глаз проходит плоскость стены в
      // пределах грани окна и дальше чист.
      let seen = 0
      if (!lowWindow) for (const x of [-3, -1, 1, 3]) for (const z of [-3, -1, 1, 3]) for (const y of [0, 1.5, 3]) {
        const q = c.offset(x, y, z)
        const dx = q.x - eye.x; const dz = q.z - eye.z
        const along = dx * sd.x + dz * sd.z
        if (along < 0.6) continue
        const t = 0.5 / along
        const lat = (dx * Math.abs(sd.z) + dz * Math.abs(sd.x)) * t
        const hy = eye.y + (q.y - eye.y) * t
        if (Math.abs(lat) > 0.45 || hy < pos.y + 1.05 || hy > pos.y + 1.95) continue
        if (losClearBut(bot, eye, q, [win])) seen++
      }
      if (!lowWindow && seen < 3) { tried.view++; continue }
      const score = seen * 2 - need * 0.5 - Math.abs(h - hBest) * 0.8 - d * 0.3 - (lowWindow ? pad.offset(0.5, 0.5, 0.5).distanceTo(c) : 0)
      if (!best || score > best.score) best = { cell: pos, front: sd, walls: myWalls, roof, digWin: digWin ? win : null, win, lowWindow, seen, need, h: Math.round(h * 10) / 10, score }
    }
  }
  if (best) best.tried = tried
  return best || { none: true, tried }
}

async function buildBunker (session, ctl, plan, setPhase) {
  const bot = session.bot
  const { placeBlockAt } = require('./build')
  const fortify = require('./fortify')
  setPhase('к шалашу')
  const w = await walkNear(bot, ctl, plan.cell, 0, 15000)
  if (!bot.entity.position.floored().equals(plan.cell)) {
    // Ещё шаг: pathfinder «дошёл» в соседнюю клетку.
    await walkNear(bot, ctl, plan.cell, 0, 5000)
  }
  if (!bot.entity.position.floored().equals(plan.cell)) return { ok: false, why: `до клетки шалаша не дошёл (${w.error || 'встал рядом'})` }
  await fortify.centerInCell(bot)
  setPhase('стройка шалаша')
  let placed = 0
  const failed = []
  for (const q of [...plan.walls, ...plan.roof]) {
    if (ctl.aborted) break
    let r = await placeBlockAt(bot, q, { timeoutMs: 900, honest: true }).catch(e => ({ ok: false, reason: e.message }))
    // Опора крыши на задней стене: её верх выше глаз — в прыжке.
    if (!r.ok && solidB(bot.blockAt(q.offset(0, -1, 0)))) {
      await fortify.centerInCell(bot)
      const j = await jumpPlaceTop(bot, q.offset(0, -1, 0))
      await sleep(300)
      r = j.ok ? { ok: true } : { ok: false, reason: `${r.reason}; в прыжке: ${j.why || 'не встал'}` }
    }
    if (r.ok && !r.already) placed++
    else if (!r.ok) failed.push(`${q.x},${q.y},${q.z}: ${r.reason}`)
  }
  if (plan.digWin && solidB(bot.blockAt(plan.digWin))) {
    try { await require('./tools').breakFast(bot, plan.digWin, { maxMs: 4000 }) } catch {}
  }
  const cell = plan.cell
  let open = 0
  for (const s of DOOR_SIDES) {
    if (s.equals(plan.front)) { if (plan.win && (!solidB(bot.blockAt(cell.plus(s).offset(0, plan.lowWindow ? 1 : 0, 0))) || !airB(bot.blockAt(plan.win)))) open++; continue }
    for (const y of [0, 1]) if (!solidB(bot.blockAt(cell.plus(s).offset(0, y, 0)))) open++
  }
  const roofed = solidB(bot.blockAt(cell.offset(0, 2, 0)))
  return { ok: open === 0 && roofed, placed, open, roofed, failed: failed.length ? failed.slice(0, 4) : undefined }
}

// Дверь заложить (отдых) и открыть снова.
async function shutDoor (bot, b) {
  const { placeBlockAt } = require('./build')
  const cells = [b.cell.plus(b.front), b.cell.plus(b.front).offset(0, 1, 0)].filter(q => !solidB(bot.blockAt(q)))
  b.shut = cells.length ? cells : (b.shut || [b.win || b.cell.plus(b.front).offset(0, 1, 0)])
  let ok = 0
  for (const q of cells) {
    const r = await placeBlockAt(bot, q, { timeoutMs: 900 }).catch(() => ({ ok: false }))
    if (r.ok) ok++
  }
  return ok === cells.length && [0, 1].every(y => solidB(bot.blockAt(b.cell.plus(b.front).offset(0, y, 0))))
}
async function openDoor (bot, b) {
  const tools = require('./tools')
  for (const q of (b.shut || [b.cell.plus(b.front).offset(0, 1, 0)]).slice().reverse()) {
    const blk = bot.blockAt(q)
    if (blk && blk.boundingBox === 'block') { try { await tools.breakFast(bot, q, { maxMs: 4000 }) } catch {} }
  }
  return (b.shut || []).every(q => airB(bot.blockAt(q)))
}

// Ближний бой со щитом: щит к нему всё время, взмах — сразу после его удара в
// щит (звук блока: у моба перезарядка 20 тиков, наш щит снова держит через 5)
// или если он молчит 1.2 с. Замер 11: combat.fight (pvp.duel) держал щит
// опущенным — иссушитель добил с 8 хп двумя ударами под огнём.
// Нейтральный на линии стрельбы: стрела мимо блейза (или сквозь него) попадёт в зомби-пиглина — и злится вся стая
// (ZombifiedPiglin.alertOthers). neF-fort25-3 02.10: лук под огнестойкостью, 4 удара по 4.8 от зомби-пиглинов за 6 с,
// смерть на 9-м убитом блейзе. Отрезок глаз → цель и чуть за неё (промах летит дальше), коридор 1.6 бл.
// Взмах меча с полным откатом на земле — размашистый удар (Player.attack: всем живым в рамке цели, раздутой на 1/0.25/1, в 3 бл.
// от нас — 1 урона): зомби-пиглин рядом с ифритом получает удар от игрока и злит всю группу (s1-post30/31 06.10: смерть от
// зомбифицированных пиглинов у спавнера). Нейтрал вплотную к цели — не бить, щит.
function sweepRisk (bot, e) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[]).some((o: any) => o && o !== e && o.id !== e.id && o.position && /^(zombified_piglin|piglin|piglin_brute|enderman)$/.test(o.name || '') &&
    Math.abs(o.position.x - e.position.x) < 1.7 && Math.abs(o.position.z - e.position.z) < 1.7 && o.position.y < e.position.y + (e.height || 1.8) + 0.3 && o.position.y + (o.height || 1.9) > e.position.y - 0.3 &&
    o.position.distanceTo(me) < 4 && seesMob(bot, o))
}

function bystanderOnLine (bot, e) {
  const eye = bot.entity.position.offset(0, 1.52, 0)
  const tgt = e.position.offset(0, (e.height || 1.8) * 0.5, 0)
  const dx = tgt.x - eye.x; const dy = tgt.y - eye.y; const dz = tgt.z - eye.z
  const L2 = dx * dx + dy * dy + dz * dz || 1
  for (const o of ((Object.values(bot.entities) as any[]) as any)) {
    if (!o || o === e || o.id === e.id || !o.position || !/^(zombified_piglin|piglin|piglin_brute|enderman)$/.test(o.name || '')) continue
    const cx = o.position.x; const cy = o.position.y + (o.height || 1.9) * 0.5; const cz = o.position.z
    const t = ((cx - eye.x) * dx + (cy - eye.y) * dy + (cz - eye.z) * dz) / L2
    if (t < -0.05 || t > 1.35) continue
    if (Math.hypot(eye.x + dx * t - cx, eye.y + dy * t - cy, eye.z + dz * t - cz) < 1.6) return o
  }
  return null
}

async function meleeGuarded (session, ctl, foe, { guard, bailAt = 7, maxMs = 25000, face = null, shouldStop = null }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  let swings = 0
  let last = 0
  let blocks = guard.stats.blocked
  let blockAt = 0
  const hp0 = Math.round(bot.health ?? 20)
  let why = null
  try {
    while (!ctl.aborted && gameClock.now() - t0 < maxMs && foe.isValid !== false && bot.entities[foe.id]) {
      await sleep(40)
      if ((bot.health ?? 20) <= bailAt) { why = 'мало хп'; break }
      if (shouldStop && shouldStop()) { why = 'общая опасность'; break }
      const aim = foe.position.offset(0, (foe.height || 1.8) * 0.6, 0)
      try { await bot.lookAt(aim, true) } catch {}
      if (guard.stats.blocked > blocks) { blocks = guard.stats.blocked; blockAt = gameClock.now() }
      const r = reachTo(bot, foe)
      const win = gameClock.now() - blockAt < 700 || gameClock.now() - Math.max(last, t0) > 1200
      if (r <= MELEE && gameClock.now() - last >= swingMs(bot) && win) {
        await guard.raise(false)
        try { bot.attack(foe); swings++; last = gameClock.now() } catch {}
        continue
      }
      if (r > 6) { why = 'ушёл'; break }
      if (r > MELEE) {
        // Шаг к нему без щита — только если он не рядом со своей атакой.
        try { bot.pathfinder.setGoal(new goals.GoalFollow(foe, 1.5), true) } catch {}
        if (r < 4) await guard.raise(true)
        else await guard.raise(false)
        continue
      }
      try { bot.pathfinder.setGoal(null) } catch {}
      await guard.raise(true)
    }
  } finally {
    try { bot.pathfinder.setGoal(null) } catch {}
  }
  return { killed: foe.isValid === false || !bot.entities[foe.id], swings, hp: `${hp0} -> ${Math.round(bot.health ?? 0)}`, why }
}

const OTHER_FOES = new Set(['wither_skeleton', 'skeleton', 'magma_cube', 'hoglin', 'piglin_brute', 'ghast'])
const FOOD_RE = /cooked|bread|apple|carrot|potato|steak|porkchop|mutton|chicken|rabbit|cod|salmon|beef|stew|cookie|pie|melon|berries/
const BLOCK_RE = /^(cobblestone|cobbled_deepslate|netherrack|stone|dirt|blackstone|basalt|nether_bricks|soul_soil|andesite|diorite|granite|tuff|deepslate|polished_blackstone|polished_basalt|end_stone)$/
const blocksHave = bot => bot.inventory.items().filter(i => BLOCK_RE.test(i.name)).reduce((n, i) => n + i.count, 0)
const arrowsHave = bot => bot.inventory.items().filter(i => /arrow$/.test(i.name)).reduce((n, i) => n + i.count, 0)
function shieldWear (bot) {
  try {
    const it = bot.inventory.slots[45]
    if (!it || it.name !== 'shield') return null
    const dmg = (it.components || []).find(c => c.type === 'damage')
    const used = dmg ? (dmg.data ?? 0) : (it.durabilityUsed || 0)
    return { used, left: 336 - used }
  } catch { return null }
}

// Сам бой у спавнера. Возвращает, что вышло; убийства считает farmRods.
// Иссушитель вплотную — бой из ямы глубиной 2 (nether-route.pitFight: его рамка удара раздута только вширь), а не вердикт
// «не переживу размен» и бег (s1c-A-7 06.10: иссушитель у помоста — 9.6 ударом и 4 иссушением за секунду, отказ, бег — смерть;
// s1c-L-3: 19 урона за ожидание «спавнер виден?» в начале навыка).
function witherClose (bot) {
  if (process.env.ND_WITHER_PIT === '0') return null
  return (Object.values(bot.entities) as any[]).find((e: any) => e && e.name === 'wither_skeleton' && e.isValid !== false && e.position &&
    e.position.distanceTo(bot.entity.position) < 3.6 && seesMob(bot, e)) || null
}
async function pitFrom (session, ctl, out, w) {
  const NR = require('./nether-route')
  let ok = await NR.pitFight(session, ctl, (out.pitSt ||= {}), w).catch(() => false)
  if (ok) out.witherPits = (out.witherPits || 0) + 1
  // Яму не выкопать (мост крепости: под ногами воздух) — столб 3 и лук сверху (rangedClear: рамка удара иссушителя 2.4 по высоте не
  // достаёт ноги на +3; s1c-P-2 06.10: на мосту у помоста 3 удара за секунду, «withered away»).
  if (!ok) { ok = await NR.rangedClear(session, ctl, out.pitSt, { radius: 6 }).catch(() => false); if (ok) out.witherTowers = (out.witherTowers || 0) + 1 }
  return ok
}

async function holdSpawner (session, ctl, ctx) {
  const bot = session.bot
  const combat = require('./combat')
  const actions = require('./actions')
  const { bestWeapon } = require('./items')
  const { spawner, want, deadline, dead, setPhase, fireproof: fp } = ctx
  const out: any = { melee: 0, arrows: 0, blocks: 0, rests: [], sorties: 0, shieldMs: 0, foes: [], bunker: null, hits: 0, swingNoLease: 0 }
  let clearRevision = 0, clearChecked = ''
  const onClearBlock = () => { clearRevision++ }
  // Свидетель попадания — entityHurt ифрита, а не счёт взмахов (s1-post07 06.10: melee 17, убийств 0).
  const onBlazeHurt = e => { if (e && e.name === 'blaze') out.hits++ }
  bot.on('entityHurt', onBlazeHurt)
  const lockOwner = () => { try { return require('./reflex-lock').owner(session)?.source || null } catch { return null } }
  const guard = combat.makeShield(session, ctl, { shield: 'ranged' })
  const safety = survival.watch(bot)
  const radar = makeRadar(bot)
  const lookSpeed = bot.physics ? [bot.physics.yawSpeed, bot.physics.pitchSpeed] : null
  if (bot.physics) { bot.physics.yawSpeed = 1000; bot.physics.pitchSpeed = 1000 }
  const saved = bot.pathfinder.movements
  const moves = fightMoves(session)
  bot.pathfinder.setMovements(moves)
  let weapon = bestWeapon(bot)
  const equipSword = async () => {
    weapon = bestWeapon(bot)
    if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
  }
  // Нейтрал вплотную к ифриту — бить киркой: у кирки нет размашистого удара (Player.isSweepAttack — только меч), зомби-пиглины
  // не злятся; без нейтралов — меч (s1-LA-6 06.10: при запрете удара ифрит в 0.8 бл. бил безответно, смерть).
  const equipFor = async (e) => {
    if (!sweepRisk(bot, e)) return equipSword()
    const pk = bot.inventory.items().filter(i => /_pickaxe$/.test(i.name)).sort((a, b) => ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'].indexOf(b.name.split('_')[0]) - ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'].indexOf(a.name.split('_')[0]))[0]
    out.pickSwings = (out.pickSwings || 0) + 1
    if (pk && (!bot.heldItem || bot.heldItem.name !== pk.name)) { try { await bot.equip(pk, 'hand') } catch {} }
  }
  let lastSwing = gameClock.now()
  // Смена предмета в руке обнуляет откат удара (Player.tick → resetAttackStrengthTicker при смене main hand, 1.21.11).
  let swapAt = 0
  const onHeld = () => { swapAt = gameClock.now() }
  bot.on('heldItemChanged', onHeld)
  // Удар, только когда откат предмета в руке прошёл; оружие под цель (кирка при нейтрале рядом) — до проверки отката.
  const swingFor = async (e) => {
    await equipFor(e)
    if (gameClock.now() - Math.max(lastSwing, swapAt) < swingMs(bot)) return false
    const aim = require('./pick').aim(bot, e)
    if (!aim?.point) return false
    await setShield(false)
    try { await bot.lookAt(aim.point, true) } catch {}
    try { if (lockOwner()) out.swingNoLease++; bot.attack(e); lastSwing = gameClock.now(); out.melee++ } catch {}
    await setShield(true, inBunker() ? doorPoint() : blazeEye(e))
    return true
  }
  let idleSince = gameClock.now()
  // S1e: спавнер работает, только когда игрок в 16 бл. от его центра (BaseSpawner.isNearPlayer, requiredPlayerRange 16) — молчит
  // издали (s1e-B0-3: «спавнер молчит 50с — стою в 18 бл.» ×3, этап ифритов брошен) — подойти на 8 и ждать снова, а не уходить.
  let silentApproach = 0
  let lastBeat = 0
  let shieldOn = false
  let shieldAt = 0
  let goalAt = 0
  let stopped = null
  let bail = false
  let bunker = null
  let lastBow = gameClock.now()
  let lowWindowCrouchAt = 0
  let sortieAfter = 0
  let lastVisAt = gameClock.now()
  let reposts = 0
  let approaches = 0
  let farApproaches = 0
  let seenBlocks = 0
  let blockAt = 0
  // Коробку не достроили (блейз в клетке стены, сервер не ответил) — достроить
  // в тишине, до 4 раз (замер 18: «в клетке стоит blaze», 12 хп на стройке).
  let boxPlan = null
  let boxTries = 0
  let boxRetryAt = 0
  const noShot = new Map()
  const fireproof = () => fp || hasEffect(bot, 'fire_resistance')
  // Бой начат под огнестойкостью — она и держит его (шар и горение — #is_fire). Кончилась посреди боя — новое зелье
  // (ферма 02.10 neF-blz-3: 3 мин под зельем — 0 урона огнём, после — шары 10.8 и горение 5); нет зелья — отдых и
  // конец захода, а не продолжение тира без защиты (разбор Codex ne-blaze.md, правка 1).
  const startedFireproof = fireproof()
  const setShield = async (on, face = null) => {
    if (face) { try { await bot.lookAt(face, true) } catch {} }
    if (on) {
      if (!shieldOn) { shieldOn = true; shieldAt = gameClock.now() }
      await guard.raise(true)
    } else if (shieldOn) { shieldOn = false; out.shieldMs += gameClock.now() - shieldAt; await guard.raise(false) }
  }
  if (ctx.ledger) ctx.ledger.probe = () => ({ up: combat.shieldUp(bot), want: shieldOn, ms: shieldOn ? gameClock.now() - shieldAt : undefined })
  const stopWalking = () => { try { bot.pathfinder.setGoal(null) } catch {}; bot.clearControlStates() }
  const inBunker = () => bunker && bot.entity.position.floored().equals(bunker.cell)
  const doorPoint = () => bunker ? bunker.cell.plus(bunker.front).offset(0.5, 1.6, 0.5).plus(bunker.front.scaled(3)) : null
  // Близкий враг запрещает неподвижный отдых, но требует раннего отхода.
  const meleeThreat = () => liveBlazes(bot, dead, 6).find((e : any) => e.position.distanceTo(bot.entity.position) < 2.7 && seesMe(bot, e)) || null
  const foesNow = () => require('./flee').hostilesAround(bot, 24).map(h => h.e).filter(e => !dead.has(e.id))
  const checkSafety = phase => {
    const foes = foesNow()
    const risk = safety.check({ entities: foes, phase,
      expectedEnemy: phase === 'start' ? 'blaze' : null, minHealth: Math.max(8, ctx.restAt) })
    if (process.env.ND_BLAZE_WORLD_STATE === '0' || !foes.length || foes.some(e => e.name !== 'blaze') ||
        risk.action !== 'leave' || !/не переживу ближайший размен/.test(risk.reason || '')) return risk
    const vis = liveBlazes(bot, dead, 48).filter(e => seesMe(bot, e))
    const from = [...vis.map(blazeEye), ...radar.incoming(gameClock.now()).map(b => b.from)]
    const price = blazeShieldPrice(bot, vis, radar, guard, fireproof(), from.length ? faceFor(from) : null)
    if (price.cost >= (bot.health ?? 0)) return risk
    return { ...risk, action: 'fight', reason: 'размен по лучам, щиту и летящим шарам', blazeCost: price.cost }
  }
  // Опасность: видящие нас в окне очереди и летящие к нам шары.
  const dangersNow = (vis, now) => {
    const out2 = []
    if (fireproof()) return out2
    for (const e of vis) if (e.position.distanceTo(bot.entity.position) <= NEAR && radar.untilDanger(e, now) === 0) out2.push(blazeEye(e))
    for (const b of radar.incoming(now)) if (b.eta < 1600) out2.push(b.from)
    return out2
  }
  const faceFor = (dangers) => {
    const me = bot.entity.position
    if (inBunker()) return doorPoint()
    let sx = 0; let sz = 0
    for (const d of dangers) { const dx = d.x - me.x; const dz = d.z - me.z; const n = Math.hypot(dx, dz) || 1; sx += dx / n; sz += dz / n }
    if (Math.hypot(sx, sz) < 0.3 * dangers.length) return dangers.slice().sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0]
    return me.offset(sx * 4, 1.6, sz * 4)
  }
  let blockedCorner = null
  // Отдых: в шалаше — заложить дверь; без шалаша — коробка.
  const restNow = async () => {
    stopWalking()
    if (process.env.ND_BLAZE_WORLD_STATE !== '0' && !fireproof()) {
      const blazes = liveBlazes(bot, dead, 48)
      // A connected neighbouring corner is cheaper than digging a pit under the current volley.
      const feet = bot.entity.position.floored()
      const exposed = blazes.some(e => seesMe(bot, e)) || radar.incoming(gameClock.now()).length > 0
      const corner = exposed && !inBunker() && DOOR_SIDES.map(d => feet.plus(d)).find(pos =>
        seesBlock(bot, bot.blockAt(pos.offset(0, -1, 0))) && standable(bot, pos) &&
        [0, 1].every(y => !/fire|lava/.test(bot.blockAt(pos.offset(0, y, 0))?.name || '')) &&
        blazes.every(e => !losClear(bot, blazeEye(e), pos.offset(0.5, 1.62, 0.5))) &&
        radar.incoming(gameClock.now()).every(b => !losClear(bot, b.from, pos.offset(0.5, 0.9, 0.5))))
      if (corner) {
        const key = JSON.stringify([xyz(feet), xyz(corner), [-1, 0, 1].map(y => bot.blockAt(corner.offset(0, y, 0))?.stateId),
          blazes.filter(e => e.position.distanceTo(corner) < 2).map(e => [e.id, xyz(e.position)])])
        if (key !== blockedCorner) {
          blockedCorner = key
          const from = blazes.filter(e => seesMe(bot, e)).map(blazeEye)
          await setShield(true, from.length ? faceFor(from) : null)
          setPhase('за соседний угол до лечения')
          await require('./sealed').stepMove(bot, ctl, { kind: 'flat', to: corner }).catch(() => null)
        }
      }
      // The existing radar ends this wait when the physical volley/flight ends or its ray is closed.
      while (!ctl.aborted && (bot.health ?? 0) > 0 && gameClock.now() < deadline && guard.stats.worn) {
        const vis = liveBlazes(bot, dead, 48).filter(e => seesMe(bot, e))
        const from = [...dangersNow(vis, gameClock.now()), ...radar.incoming(gameClock.now()).map(b => b.from)]
        if (!from.length) break
        setPhase('щит до укрытия для лечения')
        await setShield(true, faceFor(from))
        await sleep(50)
      }
    }
    // Нельзя опустить щит и строить/есть под рукой. Отрыв тот же, что в PvP;
    // затем существующее бегство от стрелков ищет разрыв линии огня.
    await setShield(false)
    let escape = null
    if (!inBunker()) {
      setPhase('отрыв до лечения')
      // Без FR под лучами ифритов бег — под залпами (s1c-L-4 06.10: «отрыв до лечения» 14.8 шарами и огнём, смерть): ифрит вплотную
      // не повод бежать — сперва в толщу на месте (две копки; в яме 1×1 с крышкой его удар и шары не достают), бег — если не вышло.
      const nofrSeen = !fireproof() && liveBlazes(bot, dead, 24).some(e => seesMe(bot, e))
      // Бег (kite) — только от ифрита вплотную. От стрелков бег — спиной под
      // очереди: на ферме 2026-09-29 «отрыв до лечения» дал 14–18 из 20
      // смертельного урона. Без ближнего врага — сразу стенка (ниже).
      // S1d 07.10: ифрит вплотную — и под FR сперва яма 3 с крышкой (удар ифрита требует луча и d² < 4 — в закрытой яме его нет), а не
      // отрыв: «не удалось разорвать контакт для лечения» — 3 из 5 смертей у спавнера в серии s1d-F (F22-1, F21b-1, F21b-4). ND_PIT_MELEE=0 — прежнее.
      const usePit = nofrSeen || (process.env.ND_PIT_MELEE !== '0' && !!meleeThreat())
      escape = meleeThreat() && !usePit ? await survival.disengage(session, ctl, foesNow) : { clear: true, how: nofrSeen ? 'без бега: без FR — в толщу' : usePit ? 'без бега: ифрит вплотную — в толщу' : 'без бега: вплотную никого' }
      if (!escape.clear) {
        const enemy = meleeThreat() || foesNow()[0]
        if (enemy && (bot.health ?? 0) > 0 && !ctl.aborted) escape.cover = await combat.retreat(session, ctl, enemy)
        if (meleeThreat() || (bot.health ?? 0) <= 0 || ctl.aborted) return { rested: false, why: 'не удалось разорвать контакт для лечения', escape }
      }
      // Без огнестойкости под лучами ифритов — отлёжка в толще на месте (2 вниз + крышка, digInPlace: две копки и один блок),
      // а не стройка коробки под залпами со снятым щитом (s1c-N-2 06.10: фаза «коробка» — 4 шара подряд, 17 урона, смерть).
      // Отлечился — крышку сломать, столб 2 под себя и бой дальше; наверх не вышел — конец захода в толще (dugIn).
      if (usePit || (!fireproof() && liveBlazes(bot, dead, 24).some(e => seesMe(bot, e)))) {
        setPhase('в толщу отлечиться')
        const dug: any = await digInNear(bot, ctl).catch(e => ({ ok: false, why: e.message }))
        log('в толщу отлечиться', dug)
        if (dug.ok && dug.sealed) {
          const hp0 = Math.round(bot.health ?? 0)
          const t0 = gameClock.now()
          while (!ctl.aborted && gameClock.now() - t0 < Math.min(60000, Math.max(0, deadline - gameClock.now() - 15000)) && (bot.health ?? 0) < 19) {
            if ((bot.food ?? 20) < 20) { try { await actions.eat(session, {}) } catch {} }
            if ((bot.food ?? 20) < 18 && !bot.inventory.items().some(i => FOOD_RE.test(i.name))) break
            await sleep(500)
          }
          const hp1 = Math.round(bot.health ?? 0)
          const top = bot.entity.position.floored().offset(0, 2, 0)
          if ((bot.health ?? 0) >= 14 && !ctl.aborted) {
            try { const b = bot.blockAt(top); if (b && b.boundingBox === 'block') await require('./sealed').digCell(bot, top) } catch {}
            const up = await require('./build').towerUp(bot, ctl, dug.depth || 2, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
            if (up && up.ok) return { rested: hp1 >= 18, where: 'яма на месте', hp: `${hp0} -> ${hp1}`, seconds: Math.round((gameClock.now() - t0) / 1000), escape }
          }
          stopped = `отлёжка в толще: хп ${hp0} -> ${hp1}, наверх не вышел — остаюсь в яме`
          bail = true
          out.dugIn = { ok: true, sealed: !!dug.sealed, at: xyz(bot.entity.position) }
          return { rested: false, where: 'яма на месте', why: stopped, escape }
        }
      }
      if (liveBlazes(bot, dead, 24).some(e => seesMe(bot, e))) {
        setPhase('из линии огня до лечения')
        const shooter = liveBlazes(bot, dead, 24).find(e => seesMe(bot, e))
        // Та же быстрая стенка/укрытие, что у обычного боя: сначала закрыть
        // огонь двумя блоками, а не восемь секунд бежать под очередями.
        escape.cover = await combat.retreat(session, ctl, shooter, { timeoutMs: 4000 })
        if (meleeThreat() || (bot.health ?? 0) <= 0 || ctl.aborted) return { rested: false, why: 'враг догнал до укрытия', escape }
      }
      const safe = () => !foesNow().some(e => seesMe(bot, e))
      if (safe()) {
        setPhase('лечение за общим укрытием')
        const healed = await survival.recover(session, ctl, { safe, until: 19,
          maxMs: Math.min(30000, Math.max(0, deadline - gameClock.now() - 2000)) })
        if (healed.rested) return { ...healed, where: 'за стенкой или углом', escape }
        if (healed.hazard) {
          setPhase('из опасного блока вместо лечения')
          escape.hazard = await survival.disengage(session, ctl, foesNow)
          return { ...healed, escape }
        }
        if (ctl.aborted || (bot.health ?? 0) <= 0 || safe()) return { ...healed, escape }
      }
    }
    if (inBunker()) {
      setPhase('отдых в шалаше')
      const hp0 = Math.round(bot.health ?? 0)
      const shut = await shutDoor(bot, bunker)
      if (!shut) {
        await setShield(true, doorPoint())
        return { rested: false, where: 'шалаш', shut: false, why: 'окно не закрыто — не ем' }
      }
      const t0 = gameClock.now()
      let ate = 0
      while (!ctl.aborted && gameClock.now() - t0 < 60000 && ((bot.health ?? 0) < 19 || (bot.food ?? 20) < 18)) {
        if ((bot.food ?? 20) < 20) { try { const r = await actions.eat(session, {}); if (r && r.ate) ate++ } catch {} }
        if ((bot.food ?? 20) < 18 && !bot.inventory.items().some(i => FOOD_RE.test(i.name))) break
        await sleep(500)
      }
      const rested = !ctl.aborted && (bot.health ?? 0) >= 19 && (bot.food ?? 0) >= 18
      if (!rested) return { rested: false, where: 'шалаш', shut, opened: false, why: 'лечение не завершено — окно закрыто' }
      // raise() подтверждает использование; blocking() также проверяет пять тиков.
      await equipSword()
      await setShield(true, doorPoint())
      for (let k = 0; k < 20 && !guard.blocking() && !ctl.aborted; k++) await sleep(50)
      if (!guard.blocking()) return { rested: false, where: 'шалаш', shut, opened: false, why: 'щит не готов — окно закрыто' }
      const opened = await openDoor(bot, bunker)
      if (!opened) return { rested: false, where: 'шалаш', shut, opened: false, why: 'окно не открылось' }
      await equipSword()
      await setShield(true, doorPoint())
      return { rested, why: rested ? undefined : 'шалаш не дал восстановиться', where: 'шалаш', shut, opened, hp: `${hp0} -> ${Math.round(bot.health ?? 0)}`, seconds: Math.round((gameClock.now() - t0) / 1000), ate: ate || undefined }
    }
    // Ифрит вплотную — не строить у него под рукой: сразу бегство (ниже).
    const r: any = meleeThreat() ? { rested: false, threat: true, why: 'враг вплотную — коробку не строю' }
      : await boxRest(session, ctl, { toward: spawner || null, onPhase: setPhase, threat: () => !!meleeThreat(),
        maxMs: Math.min(60000, Math.max(0, deadline - gameClock.now() - 2000)),
        hardMs: Math.min(150000, Math.max(0, deadline - gameClock.now() - 2000)) })
    if (r.rested) {
      if (r.exited === false) { stopped = 'отлечился, но из коробки не вышел — нужен безопасный проход'; bail = true }
      return { ...r, escape }
    }
    if (r.sealed && !r.rested) return { ...r, escape }
    // Коробка не закрылась — за угол, где ни один не видит (старый отдых), а нет
    // угла — бегом прочь от них, и поесть там.
    setPhase('отдых за углом')
    const r2 = r.threat ? { rested: false, why: 'враг вплотную' } : await rest(session, ctl, dead, { until: 18, maxMs: 40000 })
    if (r2.rested) return { ...r2, box: r }
    setPhase('бегство на отдых')
    let fled = null
    try { fled = await require('./flee').smartFlee(session, ctl, { timeoutMs: 12000, safeDist: 24, reason: 'блейзы' }) } catch (e) { fled = { error: e.message } }
    const t1 = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t1 < 30000 && (bot.health ?? 0) < 18 && !liveBlazes(bot, dead, 32).some(e => seesMe(bot, e))) {
      if ((bot.food ?? 20) < 20) { try { await actions.eat(session, {}) } catch {} }
      await sleep(500)
    }
    return { rested: (bot.health ?? 0) >= 18 && (bot.food ?? 0) >= 18,
      why: 'укрытие не позволило восстановиться', where: 'бегство', escape,
      fled: fled && (fled.mode || fled.error), hp: Math.round(bot.health ?? 0), box: r, cover: r2.why }
  }
  let home = null
  // Куда дойти ногами от места боя (для «стержень с этого поднять» и вылазок).
  let reach = null
  const refreshReach = () => {
    try { reach = new Set(walkable(bot, bot.entity.position, { radius: 20, maxNodes: 5000 }).map(n => `${n.pos.x},${n.pos.y},${n.pos.z}`)) } catch { reach = null }
    // Из закрытой коробки (второй вызов начинается в ней) ногами никуда — тогда
    // правило «пол в 5 ниже и 1 выше ног» (прогон 33: 0 выстрелов за вызов).
    log("куда дойти", { cells: reach ? reach.size : null, at: xyz(bot.entity.position) })
    if (reach && reach.size < 20) reach = null
  }
  const witherPit = async () => {
    const w = witherClose(bot)
    if (!w) return false
    await setShield(false)
    stopWalking()
    setPhase('яма от иссушителя')
    const ok = await pitFrom(session, ctl, out, w)
    return ok
  }
  try {
    await equipSword()
    await guard.wear()
    await witherPit()
    home = bot.entity.position.floored()
    refreshReach()
    // Позвали с малым хп (прошлый вызов кончился на 2–3 хп): сначала поесть и
    // отлежаться (замер 35: второй вызов на 2 хп — смерть через 1 с по дороге
    // «к точке боя», горел).
    const preparation = checkSafety('start')
    out.safety = preparation
    // Под огнестойкостью и среди одних ифритов «не переживу размен» — неверно (расчёт берёт удар 6 у каждого и шары): бой
    // начинать (s1-LE-10 06.10: «не переживу ближайший размен» на 20 хп при старте → навык вышел, смерть у спавнера).
    const onlyBlazes = () => foesNow().every((e: any) => e.name === 'blaze')
    const frOnlyBlazes = () => fireproof() && onlyBlazes() && (bot.health ?? 0) >= 9
    // Без огнестойкости среди одних ифритов вердикт «не переживу размен» (удар 6 каждого и шары) — не отказ: с 14+ хп бой по
    // механике ифрита, при малом хп — отлёжка в толще (restNow) и возврат (s1c-N-4 06.10: «не переживу» на 16 хп → бег → смерть).
    // Еды нет — отлёжка не лечит: тогда вердикт safety в силе.
    const nofrOnlyBlazes = () => !fireproof() && onlyBlazes() && (bot.health ?? 0) > 0 && bot.inventory.items().some(i => FOOD_RE.test(i.name))
    if ((preparation.action === 'leave' && !frOnlyBlazes() && !(nofrOnlyBlazes() && (bot.health ?? 0) >= 14)) || preparation.action === 'dead') {
      setPhase('отказ от неподготовленного боя')
      out.safety = preparation
      if (preparation.action !== 'dead') out.escape = await survival.disengage(session, ctl, foesNow)
      return { ...out, stopped: preparation.reason, bail: true }
    }
    if (preparation.action === 'recover' && !ctl.aborted) {
      const r = await restNow()
      out.rests.push({ ...r, atStart: true })
      log('отдых до боя', r)
      if (!r.rested) return { ...out, stopped: r.why || 'не восстановился до боя', bail: true }
    }
    if (spawner && p0(ctx).clearSpawner !== false && process.env.ND_BLAZE_CLEAR !== '0') require('./blaze-clear').observe(bot, spawner)
    // --- шалаш
    // Шалаш — по желанию (bunker: true): замер 7 — из-под крыши видно только
    // до 37° вверх, блейзы у спавнера висят выше и за минуту не показались ни
    // разу; открытый бой с точки обзора дал 5 стержней за 77 с (замер 3).
    if (spawner && !fireproof() && p0(ctx).box !== false && p0(ctx).bunker !== true) {
      // Без лука и стрел коробка — ближняя, под меч (2 бл. от спавнера): к дальнему окну ифриты не подлетают, «стрелы кончились»
      // (blz-lsb-7/blz-std-5 14.10: коробка в 3–7.5 бл. без лука — 0 убийств, смерть). Ревью Codex 14.10.
      const ranged = itemNamed(bot, 'bow') && arrowsHave(bot) > 0 && canUseRanged(session, { name: 'blaze' }, p0(ctx))
      const plan = planKillBox(bot, spawner, blocksHave(bot), ranged ? {} : { hMin: 1.4, hMax: 3.2, hBest: 2, lowWindow: p0(ctx).lowWindow === true })
      if (plan.none) {
        out.bunker = { built: false, kind: 'окно', why: 'места под коробку с окном нет', tried: plan.tried }
        if (p0(ctx).lowWindow === true) return { ...out, stopped: 'эксперимент: места под щель нет', bail: true }
      } else {
        setPhase('коробка с окном')
        const b = await buildBunker(session, ctl, plan, setPhase)
        out.bunker = { built: b.ok, kind: plan.lowWindow ? 'ножная щель' : 'окно', cell: xyz(plan.cell), front: xyz(plan.front), h: plan.h, seen: plan.seen, placed: b.placed, open: b.open, roofed: b.roofed, failed: b.failed, why: b.why }
        if (b.ok) bunker = { cell: plan.cell, front: plan.front, window: true, win: plan.win, lowWindow: plan.lowWindow }
        else if (plan.lowWindow) return { ...out, stopped: 'эксперимент: щель не построена', bail: true }
        else boxPlan = plan
      }
      log('коробка с окном', out.bunker)
    }
    if (spawner && !fireproof() && p0(ctx).bunker === true) {
      const plan = planBunker(bot, spawner, blocksHave(bot))
      if (plan.none) {
        out.bunker = { built: false, why: 'места под шалаш нет', tried: plan.tried }
      } else {
        const b = await buildBunker(session, ctl, plan, setPhase)
        out.bunker = { built: b.ok, cell: xyz(plan.cell), front: xyz(plan.front), h: plan.h, seen: plan.seen, placed: b.placed, open: b.open, roofed: b.roofed, failed: b.failed, why: b.why }
        // Без крыши шалаш хуже открытого боя: сверху (до 7 блоков над глазами) видят
        // в клетку со всех сторон.
        if (b.ok) bunker = { cell: plan.cell, front: plan.front }
      }
      log('шалаш', out.bunker)
    }
    // Без шалаша — точка боя с видом на куб спавна.
    if (!bunker && spawner) {
      const post = choosePost(bot, spawner)
      // Ифриты уже вплотную — бой с места, а не ход к точке: по дороге (3.6 бл.) тело не отвечало и получило 10 ударов
      // (s1-post06 06.10: 32 урона в фазе «к точке боя», смерть до первого взмаха). Основной цикл бьёт тех, кто в досягаемости.
      const pressed = liveBlazes(bot, dead, 5).length
      if (post && pressed) log('точка боя: ифриты вплотную — бьюсь с места', { pressed, post: xyz(post.pos) })
      if (post && !pressed) {
        out.post = { ...xyz(post.pos), h: post.h, view: post.view, cover: post.cover, edge: post.edge }
        setPhase('к точке боя')
        // Под охраной (nether.guarded): ударили по дороге — ответ обидчику, потом снова к точке. neF-fB25-1 02.10: магмовые
        // кубы 9 ударов (12.5 хп) за 12 с ходьбы без ответа, затем блейзы — смерть до первого выстрела.
        // Ифрит догнал вплотную или −4 хп по дороге — ход бросить, бой с места (основной цикл: щит и меч по тем, кто в
        // досягаемости). sr-l-3 10.10: 8 ударов вплотную по 3.4 «к точке боя», смерть до первого взмаха.
        const hp0 = bot.health ?? 20
        const pressedNow = () => liveBlazes(bot, dead, 3.5).length > 0 || (bot.health ?? 20) < hp0 - 4
        for (let k = 0; k < 3 && !ctl.aborted && !pressedNow(); k++) {
          let done = false
          const w = await require('./nether').guarded(session, ctl, sub => Promise.race([
            walkNear(bot, sub, post.pos, 0, 12000).finally(() => { done = true }),
            (async () => { while (!done && !sub.aborted) { if (pressedNow()) { try { bot.pathfinder.setGoal(null) } catch {} return { pressed: true } } await sleep(100) } return {} })()
          ])).catch(() => ({}))
          if (w && w.pressed) { log('к точке боя: догнали — бьюсь с места', { hp: Math.round(bot.health ?? 0), near: liveBlazes(bot, dead, 3.5).length }); break }
          if (!w || !w.fought) break
        }
        home = post.pos
      }
      log('точка боя', out.post || { none: true })
    }
    await equipSword()
    bot.on('blockUpdate', onClearBlock)
    while (!ctl.aborted && !bail) {
      // Каждый оборот — через таймер: ветка без sleep (вылазка, которой нечего
      // собрать) иначе держит цикл событий, и пакеты мира не читаются.
      await sleep(20)
      const now = gameClock.now()
      // Набрал — но ифриты с лучом к нам рядом: под огнестойкостью добить их здесь (до 60 с), а не уходить из навыка под удары —
      // выход из боя после «набрал» убивал (s1-LG-3 06.10: 5 стержней на 6-й мин, «закопаться» под ифритами 17 → 2 хп, смерть).
      if (countOf(bot, 'blaze_rod') >= want) {
        const pressing = liveBlazes(bot, dead, 8).some(e => seesMe(bot, e))
        if (!pressing || !fireproof() || (bot.health ?? 0) < 6) break
        if (!out.clearUntil) { out.clearUntil = now + 60000; log('набрал — добиваю ифритов рядом', { n: liveBlazes(bot, dead, 8).length, hp: Math.round(bot.health ?? 0) }) }
        if (now > out.clearUntil) break
      }
      if (now > deadline) { stopped = 'время вышло'; break }
      // shortcut: эксперимент проверяет удары из щели; приманивание и сбор проверяются отдельной сценой.
      if (bunker?.lowWindow) {
        if (!inBunker()) { stopped = 'эксперимент: тело вышло из щели'; bail = true; break }
        try { bot.pathfinder.setGoal(null) } catch {}
        for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(key, false)
        if (!bot.getControlState('sneak')) { lowWindowCrouchAt = now; bot.setControlState('sneak', true) }
        setPhase('щит у ножной щели')
        const blazes = liveBlazes(bot, dead, 32)
        const intact = solidB(bot.blockAt(bunker.cell.offset(0, -1, 0))) && solidB(bot.blockAt(bunker.cell.offset(0, 2, 0))) &&
          DOOR_SIDES.every(s => [0, 1].every(y => s.equals(bunker.front) && y === 0 || solidB(bot.blockAt(bunker.cell.plus(s).offset(0, y, 0)))))
        const fire = [0, 1].some(y => /fire|lava/.test(bot.blockAt(bunker.cell.offset(0, y, 0))?.name || '')) || !!(bot.entity.metadata?.[0] & 1)
        if (!intact || fire || blazes.some(e => seesMe(bot, e)) || foesNow().some(e => e.name !== 'blaze')) {
          stopped = 'эксперимент: укрытие нарушено, огонь или другой враг'; bail = true; break
        }
        if ((bot.health ?? 0) < 19 || (bot.food ?? 20) < 18) {
          const r = await restNow(); out.rests.push(r)
          if (!r.rested) { stopped = r.why || 'эксперимент: не вылечился'; bail = true; break }
          await equipSword(); continue
        }
        await setShield(true, doorPoint())
        const e = blazes.filter(e => require('./pick').canHit(bot, e)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
        if (now - lastBeat > 2000) {
          lastBeat = now
          log('ножная щель', { t: Math.round((now - ctx.t0) / 1000), hp: bot.health, food: bot.food, melee: out.melee, hits: out.hits, kills: ctx.kills?.length, rods: countOf(bot, 'blaze_rod'), canHit: !!e, eye: myEye(bot), blocking: guard.blocking(), at: xyz(bot.entity.position) })
        }
        if (gameClock.now() - lowWindowCrouchAt >= 250 && guard.blocking() && !radar.incoming(gameClock.now()).length && e && await swingFor(e)) setPhase('меч из ножной щели')
        if (gameClock.now() - lastSwing > 75000) { stopped = 'эксперимент: 75 с без удара из щели'; break }
        await sleep(50)
        continue
      }
      if (startedFireproof && !fireproof() && !out.frLostAt) {
        let d = await drinkFireResistance(bot)
        // Эффект приходит отдельным пакетом после глотка — до 4 с (ферма 02.10 neF-blz-4: через 2 с ещё «нет» → зря кончил бой).
        for (let i = 0; i < 40 && d === 'выпил fire_resistance' && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
        // Не подействовало, а зелья ещё есть — ещё раз (D2-25 03.10: 10 зелий в рюкзаке, «новое зелье не подействовало»,
        // бой брошен — следующий вызов шёл «к точке боя» без огнестойкости: удары вплотную, смерть).
        for (let k = 0; k < 2 && !hasEffect(bot, 'fire_resistance') && d === 'выпил fire_resistance'; k++) {
          d = await drinkFireResistance(bot)
          for (let i = 0; i < 40 && d === 'выпил fire_resistance' && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
        }
        log('огнестойкость кончилась', { drank: d, now: hasEffect(bot, 'fire_resistance') })
        if (!fireproof()) {
          // Огнестойкость — плюс к безопасности, не допуск (решение пользователя 06.10 22:33): бой дальше по механике ифрита — щит
          // на залп (радар заряда), меч между залпами, коробка с окном в тишине, отдых в укрытии при малом хп и возврат.
          out.frLostAt = gameClock.now()
          setPhase('бой без огнестойкости')
          if (!bunker && !boxPlan && spawner) {
            const plan = planKillBox(bot, spawner, blocksHave(bot))
            if (!plan.none) { boxPlan = plan; boxTries = 0; boxRetryAt = 0 }
          }
          log('огнестойкость кончилась — бой дальше без неё', { drank: d, hp: Math.round(bot.health ?? 0), box: boxPlan ? xyz(boxPlan.cell) : null })
          if ((bot.health ?? 0) < ctx.restAt || (bot.health ?? 0) < 16 && liveBlazes(bot, dead, 16).filter(e => seesMe(bot, e)).length >= 2) {
            const r = await restNow()
            out.rests.push(r)
            if (!r.rested && (bot.health ?? 0) < 10) { stopped = `огнестойкость кончилась, хп ${Math.round(bot.health ?? 0)}, отдых не вышел: ${r.why || 'нет укрытия'}`; bail = true; break }
            await equipSword()
          }
          continue
        }
      }
      // ND_GUARD=1 (ne-guard): иссушитель/магмовый куб/злой пиглин бьёт или иссушитель вплотную — ответ сразу (столб 3,
      // коробка, бой со щитом), а не «бегство» под ударами (B0-26 03.10: под огнестойкостью у помоста — магмовый куб и два
      // удара иссушителя за 2 с в «бегстве», refuge не спас).
      if (process.env.ND_GUARD !== '0') {
        const G = require('./ne-guard')
        const h = G.hot(bot)
        if (h) {
          await setShield(false)
          const rr = await G.react(session, ctl, { force: h, sitMs: 15000 })
          if (rr.cancelled || ctl.aborted || session.bot !== bot) { stopped = 'прервано'; break }
          if (rr.acted !== false) {
            out.guards = (out.guards || 0) + 1
            log('страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) })
            await equipSword()
            continue
          }
        }
      }
      if (await witherPit()) { await equipSword(); continue }
      // Без FR бой держится на отдыхе с едой; еда кончается — закончить заход в толще, а не дойти до «нечем восстановить здоровье»
      // и бега под залпами (s1c-F-9 06.10: без FR 110.9 урона за бой, отдыхи в коробке, еда кончилась — бег, смерть).
      if (!fireproof() && bot.inventory.items().filter(i => FOOD_RE.test(i.name)).reduce((n, i) => n + i.count, 0) <= 2 && (bot.health ?? 20) < 18) {
        stopped = 'без огнестойкости еда кончается — заход заканчиваю в толще'
        bail = true
        break
      }
      const hp = bot.health ?? 0
      const risk = checkSafety('continue')
      if (risk.action === 'leave' && nofrOnlyBlazes() && !frOnlyBlazes()) {
        out.safety = risk
        const r = await restNow()
        out.rests.push(r)
        log('отдых вместо ухода', { why: risk.reason, ...r })
        if (bail) break
        if (!r.rested && (bot.health ?? 0) < 14) { stopped = `${risk.reason}; отдых не вышел: ${r.why || 'нет укрытия'}`; bail = true; break }
        await equipSword()
        await guard.wear()
        continue
      }
      if ((risk.action === 'leave' && !frOnlyBlazes()) || risk.action === 'dead') {
        out.safety = risk; stopped = risk.reason; bail = true
        if (risk.action !== 'dead') {
          await setShield(false)
          out.escape = await survival.disengage(session, ctl, foesNow)
          if (!out.escape.clear && !ctl.aborted && (bot.health ?? 0) > 0) {
            const enemy = meleeThreat() || foesNow()[0]
            if (enemy) out.escape.cover = await combat.retreat(session, ctl, enemy)
          }
        }
        break
      }
      // Под огнестойкостью ифрит опасен только вплотную (3.4 за удар в железе): отдых с «бегством» при 16–19 хп гибелен —
      // уход с помоста, падение, ифриты догоняют (s1-post10 06.10: 3 стержня, «бегство на отдых» при 16.6 хп → 1.5 хп → смерть).
      // Бой со щитом дальше до 5 хп, если вокруг одни ифриты.
      // Запас хп — на удары тех, кто вплотную (3.4 в железе каждый): с толпой у тела порог выше (s1c-B-6 06.10: 4 ифрита рядом,
      // «держу до 5 хп» — 20 → 0 до первого отдыха).
      const nearBlazes = liveBlazes(bot, dead, 3).length
      // S1e: запас — ожидаемый урон, пока убиваем тех, кто вплотную, по одному: удар ифрита вплотную 6 раз в 20 тиков (Blaze ATTACK_DAMAGE 6,
      // BlazeAttackGoal attackTime 20) — 3.4 по железу в секунду с каждого; ифрит 20 хп — 4 удара мечом на откате 0.625 с ≈ 2.5 с. С n
      // вплотную — 3.4·2.5·n(n+1)/2 (+4 на отход в яму): 1 — 12.5 хп, 2 — 29.5 (держать нельзя). Было 3.4·n + 2 (5.4 / 8.8): тело
      // доходило до 2–6 хп, и отход уже не успевал (s1e-K4-4, K4-7). ND_FR_HOLD=0 — прежнее.
      const holdNeed = process.env.ND_FR_HOLD === '0' ? Math.max(5, 3.4 * nearBlazes + 2) : 3.4 * 2.5 * nearBlazes * (nearBlazes + 1) / 2 + 4
      const holdUnderFr = fireproof() && hp >= holdNeed && foesNow().every((e: any) => e.name === 'blaze')
      // Под FR с малым хп — поесть, когда вплотную никого (отдых с уходом гибелен: s1-LA-3 06.10 — 4 стержня, «хп 7, укрытие
      // не позволило», убежище «CORNERED» → смерть). Порог боя со щитом — 5 хп (был 9).
      if (holdUnderFr && hp < 14 && (bot.food ?? 20) < 20 && !liveBlazes(bot, dead, 4).some(e => reachTo(bot, e) <= 2.6) && gameClock.now() - (out.frEatAt || 0) > 4000) {
        out.frEatAt = gameClock.now()
        await setShield(false)
        try { await actions.eat(session, {}); out.frEats = (out.frEats || 0) + 1 } catch {}
        await equipSword()
        continue
      }
      if (risk.action === 'recover' && holdUnderFr && gameClock.now() - (out.frHoldLogAt || 0) > 5000) { out.frHoldLogAt = gameClock.now(); out.frHolds = (out.frHolds || 0) + 1; log('отдых отложен: огнестойкость, вокруг одни ифриты', { hp: Math.round(hp) }) }
      if (risk.action === 'recover' && !holdUnderFr) {
        out.safety = risk
        const r = await restNow()
        out.rests.push(r)
        log('отдых', r)
        // Отдых «не завершён», а хп уже 14+ (neF-e2e-3 02.10: «хп 20, не восстановился» — заход кончился на 1 стержне):
        // бой дальше; конец захода — только когда хп так и осталось низким.
        if (!r.rested && (bot.health ?? 0) < 14) { stopped = `хп ${Math.round(bot.health ?? 0)}, не восстановился: ${r.why || r.cover || 'нет безопасного отдыха'}`; bail = true; break }
        await equipSword()
        await guard.wear()
        continue
      }
      // Без огнестойкости под лучами двух и больше ифритов урон за секунды — шары, горение, удары вплотную (s1c-B-3 06.10: FR
      // кончилась на 17 хп при 5 ифритах, 18 → 3 за 2 с; в толщу — поздно). Порог отлёжки в толще — 16 хп, а не общий 12.
      if (!fireproof() && hp < 16 && gameClock.now() - (out.nofrRestAt || 0) > 5000 &&
          liveBlazes(bot, dead, 16).filter(e => seesMe(bot, e)).length >= 2) {
        out.nofrRestAt = gameClock.now()
        const r = await restNow()
        out.rests.push(r)
        log('отдых без FR под ифритами', { hp: Math.round(hp), ...r })
        if (bail) break
        if (!r.rested && (bot.health ?? 0) < 12) { stopped = `хп ${Math.round(bot.health ?? 0)} без огнестойкости, отдых не вышел: ${r.why || 'нет укрытия'}`; bail = true; break }
        await equipSword()
        continue
      }
      // Огонь под ногами: шар, пролетевший мимо, поджигает клетку у места
      // удара (SmallFireball.onHitBlock), и тело в ней горит 8 с (FireBlock.
      // entityInside). Замер 8: 7 хп огня без единого попадания шара. Шаг на
      // соседнюю клетку без огня — раньше щита.
      {
        const feet = bot.entity.position.floored()
        const inFire = [feet, feet.offset(0, 1, 0)].some(q => { const b = bot.blockAt(q); return b && /fire/.test(b.name) })
        if (inFire) {
          const { standable } = require('./walkable')
          const to = DOOR_SIDES.map(d => feet.plus(d)).find(q => standable(bot, q) && !lavaNear(bot, q, 1) &&
            ![q, q.offset(0, 1, 0)].some(c => { const b = bot.blockAt(c); return b && /fire/.test(b.name) }))
          if (to) {
            await setShield(false)
            setPhase('из огня')
            out.fireSteps = (out.fireSteps || 0) + 1
            try { bot.pathfinder.setGoal(new goals.GoalBlock(to.x, to.y, to.z)) } catch {}
            await sleep(400)
            stopWalking()
            continue
          }
        }
      }
      const blazes = liveBlazes(bot, dead, 32)
      const vis = blazes.filter(e => seesMe(bot, e))
      if (gameClock.now() - lastBeat > 2000) {
        lastBeat = gameClock.now()
        // Рюкзак полон — стержни не подбираются (B16f21 03.10): лишнее за спину.
        if (process.env.ND_NE_ROUTE !== '0' && bot.inventory.emptySlotCount() < 3 && !vis.some((e : any) => e.position.distanceTo(bot.entity.position) < 4)) { try { await require('./nether-route').makeRoom(bot, 5) } catch {} }
        const me = bot.entity.position
        log('шаг', { t: Math.round((now - ctx.t0) / 1000), hp: Math.round(hp), rods: countOf(bot, 'blaze_rod'), kills: ctx.kills ? ctx.kills.length : undefined, melee: out.melee, hits: out.hits, noLease: out.swingNoLease, lease: lockOwner(), arrows: out.arrows, shield: shieldOn, inB: !!inBunker(), fire: !!(bot.entity.metadata && (bot.entity.metadata[0] & 1)), pos: xyz(me), b: blazes.slice(0, 6).map((e : any) => [Math.round(e.position.distanceTo(me) * 10) / 10, Math.round((blazeEye(e).y - myEye(bot).y) * 10) / 10, seesMe(bot, e) ? 1 : 0, Math.min(99, Math.round(radar.untilDanger(e, now) / 100) / 10)]) })
      }
      // --- чужие рядом (иссушитель, магмакуб) — обычный бой.
      const foes = (Object.values(bot.entities) as any[]).filter((e : any) => e && OTHER_FOES.has(e.name) && e.position && e.isValid !== false &&
        e.position.distanceTo(bot.entity.position) <= 6 && seesMob(bot, e))
      if (foes.length) {
        const f: any = foes.sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
        // Иссушитель бьёт 8 (в железе 4.5) дважды в секунду под огнём шаров —
        // замер 10: смерть с 11.5 хп за 3 с. Мало хп — сперва коробка.
        // Без огнестойкости бой с иссушителем под шарами блейзов — тир по нам (ферма 02.10 neF-blz-2: «slain by Wither
        // Skeleton», огонь 17 + шары 13.5): закрыться и кончить заход (разбор Codex ne-blaze.md, правка 2).
        // Отход в укрытие и возврат, а не конец боя: отлечился — бой дальше.
        if (!fireproof() && vis.length && f.name !== 'magma_cube') {
          const r = await restNow()
          out.rests.push(r)
          log('отдых', { from: f.name, crossfire: true, ...r })
          if (!r.rested && (bot.health ?? 0) < 14) { stopped = 'чужой враг под огнём блейзов без огнестойкости, отдых не вышел'; bail = true; break }
          await equipSword()
          continue
        }
        if (hp < 13 && f.name !== 'magma_cube') {
          const r = await restNow()
          out.rests.push(r)
          log('отдых', { from: f.name, ...r })
          if (!r.rested) { stopped = r.why || 'отдых не завершён'; bail = true; break }
          await equipSword()
          continue
        }
        await setShield(false)
        stopWalking()
        setPhase('бой: ' + f.name)
        // Ближний бой — щит между взмахами ('always'): удар моба в поднятый
        // щит гасится целиком и отбрасывает его самого (applyItemBlocking →
        // blockUsingItem). Стрелку — 'ranged'.
        const melee = f.name !== 'skeleton' && f.name !== 'ghast'
        const r = melee
          ? await meleeGuarded(session, ctl, f, { guard, bailAt: Math.max(ctx.bailAt, 8), shouldStop: () => checkSafety('continue').action === 'leave' || dangersNow(liveBlazes(bot, dead, 32).filter(e => seesMe(bot, e)), gameClock.now()).length > 0 }).catch(e => ({ error: e.message }))
          : await combat.fight(session, ctl, { target: '#' + f.id, purpose: 'defense', allowRanged: p0(ctx).allowRanged, timeoutSeconds: 20, retreatAtHealth: Math.max(ctx.bailAt, 9), shield: 'ranged' }).catch(e => ({ error: e.message }))
        shieldOn = false
        try { await guard.raise(false) } catch {}
        log('чужой', { name: f.name, ...r })
        out.foes.push({ name: f.name, killed: !!r.killed || !!(r.kills && r.kills.length), hp: Math.round(bot.health ?? 0) })
        await equipSword()
        if (bunker && !inBunker()) await walkNear(bot, ctl, bunker.cell, 0, 8000)
        continue
      }
      const dangers = dangersNow(vis, now)
      // Опасен тот, кого достаёт меч, и шаров к нам не летит: бить его, а не
      // стоять за щитом (замер 23: блейз в 1.3 блока, заряжен, 0 взмахов за 20 с).
      if (dangers.length && gameClock.now() - lastSwing >= swingMs(bot) && !radar.incoming(now).length) {
        const close: any = blazes.filter((e : any) => reachTo(bot, e) <= MELEE && require('./pick').canHit(bot, e))
          .sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
        if (close && await swingFor(close)) {
          setPhase('меч под огнём')
          await sleep(80)
          await setShield(true, faceFor(dangers))
          continue
        }
      }
      if (dangers.length) {
        stopWalking()
        setPhase('щит')
        if (!bot.heldItem || !weapon || bot.heldItem.name !== weapon.name) await equipSword()
        await setShield(true, faceFor(dangers))
        await sleep(50)
        continue
      }
      // --- достроить коробку в тишине.
      if (!bunker && boxPlan && boxTries < 4 && now > boxRetryAt && !meleeThreat() &&
          !vis.some(e => radar.untilDanger(e, now) < 2500)) {
        boxTries++
        await setShield(false)
        setPhase('достройка коробки')
        const b = await buildBunker(session, ctl, boxPlan, setPhase)
        log('достройка коробки', { n: boxTries, ok: b.ok, placed: b.placed, open: b.open, roofed: b.roofed, failed: b.failed })
        if (b.ok) { bunker = { cell: boxPlan.cell, front: boxPlan.front, window: true, win: boxPlan.win, lowWindow: boxPlan.lowWindow }; boxPlan = null; out.bunker = { ...(out.bunker || {}), built: true, retries: boxTries } } else boxRetryAt = gameClock.now() + 8000
        await equipSword()
        continue
      }
      // --- меч: видимый в досягаемости.
      const inReach = blazes.filter((e : any) => reachTo(bot, e) <= MELEE && require('./pick').canHit(bot, e))
        .sort((a, b) => reachTo(bot, a) - reachTo(bot, b))
      if (inReach.length) {
        idleSince = now
        stopWalking()
        const e: any = inReach[0]
        // Блейз в 2 блоках бьёт сам раз в 20 тиков (BlazeAttackGoal, d² < 4):
        // щит к нему, взмах — сразу после его удара в щит или если он молчит
        // 1.2 с (замер 12: 24 хп ударами блейзов у спавнера).
        if (guard.stats.blocked > seenBlocks) { seenBlocks = guard.stats.blocked; blockAt = gameClock.now() }
        const close = e.position.distanceTo(bot.entity.position) < 2.4
        // Под огнестойкостью и с 12+ хп — бить на каждом откате (625 мс), не ждать удара в щит: вплотную ифрит наносит лишь 3.4, а
        // убитый перестаёт бить совсем (s1-LF-1/LA-6 06.10: ифриты вплотную, 4–6 попаданий за 15 с, 0 убийств).
        // …но не когда вплотную двое и больше: удары ифритов вплотную идут чаще, чем мы их убиваем (s1c-B-6 06.10: под FR 4 ифрита в
        // 4 бл., 6 ударов по 3.4 за пару секунд, 20 → 0) — тогда щит к ближнему и удар после блока, как без FR.
        const crowd = blazes.filter((b: any) => b.position.distanceTo(bot.entity.position) < 2.6).length
        const window = (fireproof() && hp >= 12 && crowd <= 1) || !close || gameClock.now() - blockAt < 700 || gameClock.now() - lastSwing > 1200
        if (window && await swingFor(e)) {
          setPhase('меч')
        } else {
          await setShield(true, blazeEye(e))
        }
        await sleep(50)
        continue
      }
      // Под огнестойкостью очереди не страшны (шар и горение — #is_fire): «тихо» всегда, лук стреляет без пауз под очередь
      // (разбор Codex ne-blaze.md, правка 3).
      const quiet: any = fireproof() ? Infinity : vis.filter((e : any) => e.position.distanceTo(bot.entity.position) <= NEAR).reduce((m, e) => Math.min(m, radar.untilDanger(e)), Infinity)
      // --- лук: ближайший видимый, если до ближайшей очереди видящих > 1.5 с.
      const bowOk = itemNamed(bot, 'bow') && arrowsHave(bot) > 0 && canUseRanged(session, { name: 'blaze' }, p0(ctx))
      // Без убийств 60 с — стрелять и по ифриту без пола под ним: стержень может упасть ниже или пропасть, но убитый уступает место
      // новому из спавнера, а ждать над пустотой — 0 убийств за 400 с (s1c-P-3/P-7 06.10, 4120…: «время вышло», «за стеной»).
      const kills0 = (ctx.kills || []).length
      if (kills0 !== out.killsSeen) { out.killsSeen = kills0; out.killAt = now }
      const anyFloor = now - (out.killAt || ctx.t0 || now) > 60000
      // …и дальше BOW_MAX (sr-g-3 10.10: ифриты висят в 15.2–15.6 бл., «shoot 0» 400 с, лук и 64 стрелы целы, 0 убийств).
      const bowMax = anyFloor ? 24 : BOW_MAX
      const shootable = blazes.filter((e : any) => { const d = e.position.distanceTo(bot.entity.position); return d >= BOW_MIN && d <= bowMax && aimFrac(bot, e) !== null && now - (noShot.get(e.id) || 0) > 2500 && (anyFloor || floorBelow(bot, e, bot.entity.position, reach)) && !bystanderOnLine(bot, e) })
        .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
      if (now - (out.dropAt || 0) > 10000) {
        out.dropAt = now
        const drops = ents(bot).filter((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 32)
          .map((e : any) => { let n = '?'; try { const it = e.getDroppedItem && e.getDroppedItem(); n = it ? it.name : '?' } catch {} return [n, xyz(e.position)] })
        log('лут', { kills: (ctx.kills || []).map(k => k.at), drops })
      }
      if (now - (out.dbgAt || 0) > 2000) { out.dbgAt = now; log('выбор', { vis: vis.length, shoot: shootable.length, seen: blazes.filter(e => seesMob(bot, e)).length, quiet: quiet === Infinity ? 'inf' : Math.round(quiet), bowOk: !!bowOk, inB: !!inBunker() }) }
      if (bowOk && shootable.length && quiet > 1300 && (!bunker || inBunker())) {
        idleSince = now
        stopWalking()
        await setShield(false)
        const e: any = shootable[0]
        const track = makeTrack(e)
        track.update()
        setPhase('лук')
        const t1 = gameClock.now()
        const frac = aimFrac(bot, e) ?? 0.55
        const r = await require('./bow').shoot(bot, e, {
          velFn: () => { track.update(); return track.vel() },
          // Точка прицела — видимая часть коробки (aimFrac), с упреждением.
          point: t => { track.update(); const v = track.vel(); return e.position.offset(v.x * t, (e.height || 1.8) * frac + v.y * t, v.z * t) },
          follow: false,
          mode: 'settle',
          shouldStop: () => {
            const n = gameClock.now()
            if (!canUseRanged(session, e, p0(ctx))) return true
            if (!e.isValid) return true
            if (meleeThreat() || checkSafety('continue').action === 'leave') return true
            if (fireproof()) return false
            if (radar.incoming(n).some(b => b.eta < 900)) return true
            return liveBlazes(bot, dead, 32).some((b : any) => seesMe(bot, b) && b.position.distanceTo(bot.entity.position) <= NEAR && radar.untilDanger(b, n) < 300)
          }
        }).catch(err => ({ shot: false, why: err.message }))
        if (r.shot) { out.arrows++; lastBow = gameClock.now() } else if (r.blocked || /не долетит/.test(r.why || '')) { noShot.set(e.id, gameClock.now()) }
        if (!r.shot) log('лук', { d: Math.round(e.position.distanceTo(bot.entity.position) * 10) / 10, why: r.why })
        if (gameClock.now() - t1 < 200) await sleep(200)
        await equipSword()
        continue
      }
      // --- вылазка: стержни на полу, никто не заряжен — собрать и назад.
      const charging = vis.some(e => radar.charged(e))
      // Вылазка: стержень в 4 блоках — хватает 1.5 с тишины (два шага и назад);
      // дальше — 2.5 с и никто не заряжен. Замер 13: из коробки 4 убийства,
      // стержень лежал в 2.7 блока, а тишины в 2.5 с не было ни разу.
      const nearRod = droppedRods(bot, 4, { reachable: true }) > 0
      // Стрел мало, а на полу их хватает — тоже вылазка.
      const arrowRun = arrowsHave(bot) < 10 && arrowsOnFloor(bot, 14).length >= 3
      const quietAll: any = vis.reduce((m, e) => Math.min(m, radar.untilDanger(e)), Infinity)
      // Под огнестойкостью шар не жжёт вовсе (fireball в #is_fire) — опасен только удар вплотную. neF-XF22-2 03.10: под
      // зельем 24 убийства, 10 стержней в 1–5 бл. на полу, подобрано 0 — каждую вылазку рвал «шар летит».
      const danger = () => (FP_SORTIE && fireproof()) ? !!meleeThreat() : (radar.incoming(gameClock.now()).length > 0 || liveBlazes(bot, dead, 32).some(b => seesMe(bot, b) && radar.untilDanger(b) < 900))
      // Дальняя вылазка — только между волнами (живых блейзов в 20 блоках нет):
      // стержни лежат у спавнера, и при живых её рвало на полпути (замер 27:
      // 2 стержня в 8 блоках, 0 подобрано). Ближний стержень — при тишине.
      // «Между волнами» — ни одного живого в 20 бывает редко: у спавнера кто-то
      // висит всегда (замер 31: 14 убийств, 4 стержня на полу, 0 подобрано).
      // Годится и так: заряженных нет, тишина 2.5 с, у стержня в 6 блоках блейзов
      // нет; вылазка всё равно обрывается по опасности (stopIf).
      const rodsNear = ents(bot).filter((e : any) => e && e.name === 'item' && e.position && isRod(e) && e.position.distanceTo(bot.entity.position) <= 16)
      const calmRod = rodsNear.some((r : any) => !liveBlazes(bot, dead, 32).some((b : any) => b.position.distanceTo(r.position) < 6))
      const clear = !liveBlazes(bot, dead, 20).length || (calmRod && quietAll > 2500)
      // Вылазка — только с 14+ хп; обрыв на < 12 (замеры 34–35: весь урон
      // попыток со смертью — «сбор» и «назад в коробку», 13–26 хп за вызов).
      const sortieStop = () => danger() || (bot.health ?? 20) < 12
      const fpSortie = FP_SORTIE && fireproof() && (bot.health ?? 20) >= 12 && !meleeThreat() && droppedRods(bot, 12, { reachable: true }) > 0
      if (now > sortieAfter && (fpSortie || (!charging && (bot.health ?? 20) >= 14 && ((nearRod && quietAll > 1500) || (clear && (droppedRods(bot, 16, { reachable: true }) > 0 || arrowRun)))))) {
        await setShield(false)
        setPhase('вылазка за стержнями')
        out.sorties++
        const got = countOf(bot, 'blaze_rod')
        let walks = 0
        if (bunker && bunker.window && inBunker()) {
          // Из коробки с окном — дверью: блок под окном выломать, собрать,
          // вернуться, заложить.
          const door = bunker.cell.plus(bunker.front)
          try { await require('./tools').breakFast(bot, door, { maxMs: 3000 }) } catch {}
          walks = await collectRods(bot, ctl, 16, 9000, { arrows: arrowRun, stopIf: sortieStop })
          setPhase('назад в коробку')
          await walkNear(bot, ctl, bunker.cell, 0, 6000)
          if (!inBunker()) await walkNear(bot, ctl, bunker.cell, 0, 4000)
          if (inBunker()) {
            await require('./fortify').centerInCell(bot)
            try { await require('./build').placeBlockAt(bot, door, { timeoutMs: 900 }) } catch {}
          }
        } else {
          walks = await collectRods(bot, ctl, 10, 7000, { arrows: arrowRun, stopIf: sortieStop })
        }
        if (walks < 0) log('вылазка прервана', { walks: -walks - 1 })
        if (walks <= 0 || countOf(bot, 'blaze_rod') === got) sortieAfter = gameClock.now() + 8000
        if (bunker && !inBunker()) { setPhase('назад в шалаш'); await walkNear(bot, ctl, bunker.cell, 0, 8000) }
        continue
      }
      if (spawner && p0(ctx).clearSpawner !== false && process.env.ND_BLAZE_CLEAR !== '0') {
        const workWindow = () => {
          if (meleeThreat() || foesNow().some(e => e.name !== 'blaze')) return 0
          if (fireproof()) return Infinity
          return Math.min(...liveBlazes(bot, dead, 32).filter(e => seesMe(bot, e)).map(e => radar.untilDanger(e)), ...radar.incoming(gameClock.now()).map(b => b.eta)) - SHIELD_LEAD_MS
        }
        // Existing blazes and floor drops satisfy part of the demand before another spawn is useful.
        const remaining = Math.max(0, want - countOf(bot, 'blaze_rod') - droppedRods(bot, 16, { reachable: true }) - blazes.length * .5)
        const at = bot.entity.position
        const inventory = bot.inventory.items().filter(i => /_pickaxe$|^(tnt|flint_and_steel|fire_charge)$/.test(i.name)).map(i => `${i.name}:${i.count}:${i.durabilityUsed}:${JSON.stringify(i.enchants || [])}`).join(',')
        const state = `${clearRevision}/${at.x},${at.y},${at.z}/${remaining}/${inventory}/${fireproof()}/${workWindow() > 0}/${blazes.map(e => `${e.id}:${radar.charged(e)}`).join(',')}/${radar.incoming(gameClock.now()).length}`
        if (remaining && state !== clearChecked) {
          clearChecked = state
          const protectedCells = []
          for (const shelter of [bunker?.cell, boxPlan?.cell, home].filter(Boolean)) {
            for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = -1; y <= 3; y++) protectedCells.push(shelter.floored().offset(x, y, z))
          }
          const clearing = require('./blaze-clear')
          const plan = clearing.plan(bot, spawner, { rods: remaining, protectedCells, horizon: (deadline - gameClock.now()) / 1000, windowMs: workWindow() })
          if (plan) {
            await setShield(false)
            setPhase('расчистка спавнера')
            const safe = (remainingMs = 0) => countOf(bot, 'blaze_rod') < want && workWindow() > remainingMs && !!bot.entity.onGround && (fireproof() || !(bot.entity.metadata?.[0] & 1))
            const result = await clearing.execute(session, ctl, plan, safe)
            const receipt = { ...result, pos: xyz(plan.pos), mode: plan.mode, gain: plan.gain, beforeUpper: plan.beforeUpper, savedSeconds: plan.savedSeconds, costSeconds: plan.costSeconds, remaining }
            ;(out.clearing || (out.clearing = [])).push(receipt)
            log('расчистка спавнера', receipt)
            await equipSword()
            if (result.ok) clearRevision++
            continue
          }
        }
      }
      if (!blazes.length) {
        if (now - idleSince > (spawner ? 50000 : 8000)) {
          if (spawner && silentApproach < 2 && bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) > 15) {
            silentApproach++
            log('спавнер молчит издали — подхожу', { d: Math.round(bot.entity.position.distanceTo(spawner)), n: silentApproach })
            await walkNear(bot, ctl, spawner, 8, 15000)
            idleSince = gameClock.now()
            continue
          }
          stopped = spawner
            ? `спавнер молчит ${Math.round((now - idleSince) / 1000)}с (блейзов нет) — стою в ${Math.round(bot.entity.position.distanceTo(spawner))} бл. от него`
            : 'блейзов в 32 блоках больше не вижу'
          break
        }
      } else idleSince = now
      // --- блейзы рядом, но ни одного не видно 6 с (висят над помостом, за
      // стеной): другая точка боя с видом на куб спавна. Замер 8: у края
      // помоста трое в 3–7 блоках, не видно ни одного, 2 стержня за 3 минуты.
      if (vis.length) lastVisAt = now
      // Без увиденного спавнера скрытая сущность не задаёт точную цель хода.
      // Уже увиденная крепость и её видимый пол дают следующий законный обзор.
      if (!bunker && !spawner && !vis.length && now - lastVisAt > 6000 && quiet > 1500 && process.env.ND_BLAZE_NOSP_APPROACH !== '0') {
        const fortress = require('./fortress')
        const known = fortress.placeOf(session, fortress.PLACE)
        if (!known || require('./worlds').worldOfRecord(known) !== 'the_nether') {
          stopped = 'ифритов и спавнера не видно, увиденная крепость неизвестна — нужен поиск'
          break
        }
        const from = bot.entity.position.clone()
        setPhase('новый обзор увиденной крепости')
        const view = await fortress.tour(session, ctl, { hops: 1, deadline: Math.min(deadline, now + 6000) })
        const spawners = view.spawners || []
        const seenBlazes = view.blazes?.seen || 0
        out.views = (out.views || 0) + 1
        log('новый обзор без спавнера', { n: out.views, from: xyz(from), at: xyz(bot.entity.position), seen: view.seen, spawners: spawners.length, blazes: seenBlazes })
        if (spawners.length) {
          out.spawners = spawners.map(xyz)
          stopped = 'увидел спавнер — следующий бой у него'
          break
        }
        if (bot.entity.position.distanceTo(from) < 0.8 && !seenBlazes) {
          stopped = 'нового обзора крепости не достиг — нужен другой подход'
          break
        }
        home = bot.entity.position.floored()
        idleSince = lastVisAt = gameClock.now()
        continue
      }
      // Видны, но все дальше дальности лука (sr-k-3 10.10: «vis 3, shoot 0» 127 раз, ифриты в 25–30 бл., 0 убийств за 400 с) — подойти
      // к ближнему на 12 бл. по той же цене, что к ифриту за стеной.
      const bowReach = now - (out.killAt || ctx.t0 || now) > 60000 ? 24 : BOW_MAX
      if (!bunker && bowOk && vis.length && !shootable.length && quiet > 1500 && farApproaches < 8 &&
        vis.every((e: any) => e.position.distanceTo(bot.entity.position) > bowReach) && (bot.health ?? 0) >= (fireproof() ? 12 : 16)) {
        const near: any = vis.slice().sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
        farApproaches++
        out.farApproaches = farApproaches
        setPhase('к дальнему ифриту на выстрел')
        log('к дальнему ифриту', { n: farApproaches, d: Math.round(near.position.distanceTo(bot.entity.position)), to: xyz(near.position) })
        await walkNear(bot, ctl, floorUnder(bot, near.position) || near.position.floored(), 12, 8000)
        continue
      }
      if (!bunker && spawner && blazes.some((e : any) => e.position.distanceTo(bot.entity.position) < 16) && now - lastVisAt > 6000 && quiet > 1500 && reposts < 12) {
        await setShield(false)
        const np = choosePost(bot, spawner, home)
        lastVisAt = now
        reposts++
        if (np && !np.pos.equals(bot.entity.position.floored())) {
          setPhase('другая точка боя')
          home = np.pos
          out.reposts = (out.reposts || 0) + 1
          log('другая точка', { ...xyz(np.pos), view: np.view, h: np.h })
          await walkNear(bot, ctl, np.pos, 0, 8000)
          continue
        }
        const window = windowForPost(bot, spawner)
        if (window && !ctl.aborted) {
          stopWalking()
          setPhase('окно к залу спавнера')
          const dug = await require('./tools').breakFast(bot, window.pos, { maxMs: 8000 })
          log('окно к залу спавнера', { at: xyz(window.pos), gain: window.gain, ...dug })
          await equipSword()
          if (dug.ok) {
            out.windows = (out.windows || 0) + 1
            refreshReach()
            lastVisAt = gameClock.now()
            continue
          }
        }
        // Точки обзора нет, а тело ниже/выше помоста и вплотную пусто — ходом по сетке на пол зала (s1-post14/15 06.10: с y66
        // при спавнере y69 ни одного убийства за 6 мин).
        if ((Math.floor(bot.entity.position.y) < spawner.y - 1 || Math.floor(bot.entity.position.y) > spawner.y + 2) && !liveBlazes(bot, dead, 5).some(e => seesMe(bot, e)) && process.env.ND_NE_ROUTE !== '0' && (out.levelRoutes || 0) < 3) {
          out.levelRoutes = (out.levelRoutes || 0) + 1
          setPhase('на помост')
          // S1f (вслепую — сетки копии нет, routeTo отказывал сразу): ход к полу зала pathfinder'ом со ступенями/столбом (fortress.climbTo),
          // как игрок поднимается к помосту (s1f-D1-1: спавнер увиден с 11 бл. ниже — «за стеной, точки обзора нет», 0 стержней).
          const NRg = require('./nether-route').gridOf(session)
          const rr = NRg || process.env.ND_BLAZE_CLIMB === '0'
            ? await require('./nether-route').routeTo(session, ctl, { x: spawner.x, y: spawner.y, z: spawner.z, r: 2, dy: 0, solidFloor: true, frKeep: 1, ironOk: true, abortNear: { re: '^blaze$', r: 4 }, timeoutSeconds: 40 }).catch(e => ({ ok: false, why: e.message }))
            : await require('./fortress').climbTo(session, ctl, spawner.offset(Math.sign(bot.entity.position.x - spawner.x) * 3 || 3, -1, Math.sign(bot.entity.position.z - spawner.z) * 3), gameClock.now() + 40000).then(w => ({ ok: w.ok, why: w.error, steps: null })).catch(e => ({ ok: false, why: e.message }))
          log(NRg ? 'на помост по сетке' : 'на помост ступенями', { ok: rr.ok, why: rr.why, steps: rr.steps, at: xyz(bot.entity.position) })
          await equipSword()
          continue
        }
        if (reposts >= 2) {
          // Точки обзора нет — подойти к ближайшему скрытому ифриту: из-за угла
          // он виден, дальше меч/щит основного цикла. Ферма 2026-09-29: 4 из 4
          // боёв кончились «за стеной» за ~55 с, основной мир так же.
          const hidden: any = blazes.filter((e : any) => e.position.distanceTo(bot.entity.position) < 16)
            .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
          // Под огнестойкостью подход к скрытому ифриту безопасен (шары не жгут) — заходов больше: лук+зелье neF-blz-5 02.10
          // кончил бой на 6 из 7 тремя «за стеной» подряд.
          // S1f: без огнестойкости подход к скрытому ифриту — цена: у цели ещё ифриты (в 6 бл.) — это клетка спавна, вплотную каждый бьёт
          // 3.4 (удар 6 по железу) раз в ~1 с и шарами по 2.7: s1f-FA-3 — «к ифриту за стеной» к помосту (4 ифрита), хп 20 → 0 за 3 с.
          // Подход — только к одиночке и с хп ≥ 16 (ожидаемый урон ~2 ударов). ND_BLAZE_APPROACH_PRICE=0 — прежнее (хп ≥ 12).
          const crowdAt = hidden ? blazes.filter((e: any) => e !== hidden && e.position.distanceTo(hidden.position) < 6).length : 0
          const approachOk = fireproof() || process.env.ND_BLAZE_APPROACH_PRICE === '0' ? (bot.health ?? 0) >= 12 : crowdAt === 0 && (bot.health ?? 0) >= 16
          if (hidden && !approachOk) log('к ифриту за стеной — не иду', { crowd: crowdAt, hp: Math.round(bot.health ?? 0), fr: fireproof() })
          if (hidden && approaches < (fireproof() ? 14 : 6) && approachOk) {
            approaches++
            out.approaches = approaches
            setPhase('к ифриту за стеной')
            log('к ифриту за стеной', { n: approaches, to: xyz(hidden.position) })
            await walkNear(bot, ctl, floorUnder(bot, hidden.position) || hidden.position.floored(), 2, 6000)
            lastVisAt = gameClock.now()
            continue
          }
          stopped = 'ифриты за стеной, доступной точки обзора нет — бой без прогресса прекращён'
          break
        }
      }
      // --- без шалаша: далеко от места боя (отдых бегом, погоня) — назад.
      if (!bunker && home && bot.entity.position.distanceTo(home) > 8 && quiet > 1500) {
        await setShield(false)
        if (gameClock.now() - goalAt > 800) {
          goalAt = gameClock.now()
          setPhase('назад к спавнеру')
          try { bot.pathfinder.setGoal(new goals.GoalNear(home.x, home.y, home.z, 2), true) } catch {}
        }
        await sleep(100)
        continue
      }
      // --- без шалаша: шаг к низкому блейзу в тишине (меч).
      if (!bunker) {
        const stepTo: any = vis.filter((e : any) => {
          const dyEye = blazeEye(e).y - myEye(bot).y
          const flat = Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)
          return dyEye < 1.8 && dyEye > -2.5 && flat < 7
        }).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
        if (stepTo && quiet > 1200) {
          await setShield(false)
          const f = floorUnder(bot, stepTo.position)
          if (f && gameClock.now() - goalAt > 400) {
            goalAt = gameClock.now()
            setPhase('шаг к блейзу')
            try { bot.pathfinder.setGoal(new goals.GoalNear(f.x, f.y, f.z, 1.5), true) } catch {}
          }
          await sleep(100)
          continue
        }
      } else if (!inBunker() && bunker.window && now - (bunker.outSince || (bunker.outSince = now)) > 15000) {
        log('коробка брошена', { at: xyz(bot.entity.position) })
        bunker = null
        continue
      } else if (!inBunker()) {
        await setShield(false)
        if (gameClock.now() - goalAt > 800) {
          goalAt = gameClock.now()
          setPhase('назад в шалаш')
          try { bot.pathfinder.setGoal(new goals.GoalBlock(bunker.cell.x, bunker.cell.y, bunker.cell.z), true) } catch {}
        }
        await sleep(100)
        continue
      }
      if (bunker) bunker.outSince = 0
      stopWalking()
      // Огонь у ног (шары, прошедшие мимо, жгут пол помоста): в тишине — затушить
      // рукой, как игрок (огонь ломается мгновенно). Шаг в огонь — 8 с горения.
      if (!bunker && quiet > 2000 && now - (out.fireAt || 0) > 1500) {
        const feet = bot.entity.position.floored()
        let fire = null
        for (let x = -2; x <= 2 && !fire; x++) for (let z = -2; z <= 2 && !fire; z++) for (const y of [0, 1, -1]) {
          const b = bot.blockAt(feet.offset(x, y, z))
          if (b && b.name === 'fire') { fire = b; break }
        }
        out.fireAt = now
        if (fire && fire.position.offset(0.5, 0.5, 0.5).distanceTo(myEye(bot)) < 4.2 && losClearBut(bot, myEye(bot), fire.position.offset(0.5, 0.3, 0.5), [fire.position])) {
          await setShield(false)
          setPhase('тушу огонь')
          try { await bot.lookAt(fire.position.offset(0.5, 0.2, 0.5), true); await bot.dig(fire, true); out.fires = (out.fires || 0) + 1 } catch {}
          await equipSword()
          continue
        }
      }
      if ((bot.food ?? 20) < 18 && quiet > 2500) {
        await setShield(false)
        setPhase('еда')
        try { await actions.eat(session, {}) } catch {}
        await equipSword()
        continue
      }
      // Стрел нет, а к окну за 30 с никто не подлетел — из коробки их не
      // взять (замер 16: 7 убийств за 32 стрелы, потом ни одного). Выйти
      // дверью и драться у спавнера мечом; отдых — снова коробкой.
      // Стрел нет — новая коробка вплотную к спавнеру (1.4..3 блока): новые
      // блейзы появляются в ±4 от него, и меч через окно их достаёт. Выход в
      // открытый бой без стрел кончался смертью (замеры 19, 26: иссушитель).
      // По желанию (meleeBox: true): замер 30 — путь к коробке у спавнера шёл по
      // горящему помосту мимо иссушителя, 24 хп за переход, смерть. По умолчанию
      // без стрел — стоп словами (стрелы кончились), тело в коробке.
      if (p0(ctx).meleeBox === true && bunker && bunker.window && !bowOk && !bunker.melee && now - lastSwing > 20000 && now - lastBow > 20000 && quietAll > 3000) {
        // Дверь сначала: из закрытой коробки заливка «куда дойти» видит одну клетку.
        const door = bunker.cell.plus(bunker.front)
        try { await require('./tools').breakFast(bot, door, { maxMs: 3000 }) } catch {}
        const plan = planKillBox(bot, spawner, blocksHave(bot), { hMin: 1.4, hMax: 3.2, hBest: 2 })
        log('коробка для меча', plan.none ? { none: true, tried: plan.tried } : { cell: xyz(plan.cell), h: plan.h, seen: plan.seen })
        if (!plan.none) {
          const b = await buildBunker(session, ctl, plan, setPhase)
          if (b.ok) { bunker = { cell: plan.cell, front: plan.front, window: true, melee: true }; home = plan.cell; out.meleeBox = xyz(plan.cell) } else { boxPlan = plan; boxTries = 0; bunker = null; home = plan.cell }
          continue
        }
        // Места нет — дверь назад.
        try { await require('./build').placeBlockAt(bot, door, { timeoutMs: 900 }) } catch {}
        bunker.melee = true
      }
      if (bunker && !bowOk && now - lastSwing > 30000 && now - lastBow > 30000) {
        stopped = arrowsHave(bot) > 0
          ? 'стрелы оставлены в резерве, а к окну коробки блейзы не подлетают — нужен ближний бой или явное разрешение стрелять; стою в коробке'
          : 'стрелы кончились, а к окну коробки блейзы не подлетают — нужны стрелы (или снежки); стою в коробке'
        out.needArrows = true
        break
      }
      setPhase('ожидание')
      const face = bunker ? doorPoint() : (vis.length ? blazeEye(vis[0]) : (spawner ? spawner.offset(0.5, 0.5, 0.5) : null))
      await setShield(!fireproof() && (vis.length > 0 || !!spawner), face)
      await sleep(100)
    }
    // Стержни у спавнера — собрать перед уходом (из коробки — дверью: закрытая
    // коробка держала тело, 4 стержня так и остались лежать, замер 31).
    // Не ниже 12 хп и с обрывом по опасности: этот сбор без проверок брал до
    // 26 хп за вызов (замеры 34–35), а стержни пролежат 5 минут — следующий
    // вызов их поднимет.
    const finalStop = () => (bot.health ?? 20) < 10 || radar.incoming(gameClock.now()).length > 0 || liveBlazes(bot, dead, 32).some(b => seesMe(bot, b) && radar.untilDanger(b) < 900)
    // Набрал — лежащие стержни не нужны; без FR сбор при ифритах в виду — под удары (s1c-L-1 06.10: без FR 12 убийств, 5 стержней,
    // затем «сбор» — 5 ударов вплотную и шары, 20 → 2).
    const calmFloor = fireproof() || !liveBlazes(bot, dead, 10).some(e => seesMe(bot, e))
    if (!bunker?.lowWindow && !ctl.aborted && !bail && droppedRods(bot, 16) > 0 && (bot.health ?? 20) >= 12 && countOf(bot, 'blaze_rod') < want && calmFloor) {
      await setShield(false)
      setPhase('сбор')
      if (bunker && inBunker()) { try { await require('./tools').breakFast(bot, bunker.cell.plus(bunker.front), { maxMs: 3000 }) } catch {} }
      await collectRods(bot, ctl, 16, 12000, { stopIf: finalStop })
      if (bunker && !inBunker()) { await walkNear(bot, ctl, bunker.cell, 0, 6000); if (inBunker()) { try { await require('./build').placeBlockAt(bot, bunker.cell.plus(bunker.front), { timeoutMs: 900 }) } catch {} } }
    }
  } finally {
    if (bunker?.lowWindow && inBunker() && (bot.health ?? 0) > 0 && !ctl.aborted) {
      out.windowSealed = await shutDoor(bot, bunker).catch(() => false)
    }
    bot.removeListener('blockUpdate', onClearBlock)
    bot.removeListener('entityHurt', onBlazeHurt)
    bot.removeListener('heldItemChanged', onHeld)
    try { await setShield(false) } catch {}
    stopWalking()
    radar.stop()
    safety.close()
    guard.close()
    if (bot.physics && lookSpeed) { bot.physics.yawSpeed = lookSpeed[0]; bot.physics.pitchSpeed = lookSpeed[1] }
    try { bot.pathfinder.setMovements(saved) } catch {}
  }
  out.shield = guard.report()
  out.shieldWear = shieldWear(bot)
  out.radar = radar.stats
  out.arrowsLeft = arrowsHave(bot)
  return { ...out, stopped, bail }
}
const p0 = ctx => ctx.p || {}

// ND_BLAZE_HOLE=1 — «яма у спавнера»: в клетке помоста вплотную к спавнеру выкопать 2 вниз и стоять в яме 1×1. Рамка удара
// иссушителя (2.4 в высоту, раздута только вширь — Mob.getAttackBoundingBox) с помоста не достаёт тело с ногами на −2
// (B5f22/B6f22/B11f31 03.10 — иссушители на помосте убивали за 16 с); блейз без луча к цели летит к ней
// (BlazeAttackGoal: lastSeen < 5 → setWantedPosition) и над ямой — в досягаемости меча снизу; стержень убитого над
// ямой падает в яму — подбирается сам. Нет убийств 75 с — выйти (столб из блоков под себя) и дальше по-старому.
async function holeCamp (session, ctl, { spawner, want, deadline, dead, setPhase, out, equipSword, shield, frLeft }: any) {
  const bot = session.bot
  const pick = require('./pick')
  const SL = require('./sealed')
  const floorY = spawner.y
  const solid = b => !!b && b.boundingBox === 'block'
  const hot = b => !!b && /lava|fire|magma/.test(b.name)
  // Клетка ямы: соседняя со спавнером клетка помоста, под ней 3 твёрдых (два копаем, на третьем стоим), без лавы рядом.
  const cand = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => new Vec3(spawner.x + dx, floorY, spawner.z + dz)).filter(c => {
    const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0))
    if (!a || !b || a.boundingBox !== 'empty' || b.boundingBox !== 'empty') return false
    for (const dy of [-1, -2, -3]) { const q = bot.blockAt(c.offset(0, dy, 0)); if (!solid(q) || hot(q)) return false }
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [-1, -2]) { const q = bot.blockAt(c.offset(x, dy, z)); if (!q || /lava/.test(q.name)) return false }
    return true
  }).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  if (!cand.length) { log('яма у спавнера: места нет', {}); return { ok: false, why: 'места нет' } }
  // Клетка — ближняя к телу; стоим уже в такой (в 1 бл. от спавнера) — копать здесь.
  const here = bot.entity.position.floored()
  let H = cand.find(c => c.equals(here)) || cand[0]
  setPhase('яма у спавнера')
  // Блейз вплотную — сперва бить (удар раз в секунду по 3.4 — пока копал, B13f31 03.10: смерть за 6 с).
  let lastSwing0 = 0
  const fightClose = async (ms = 4000) => {
    const t1 = gameClock.now()
    while (gameClock.now() - t1 < ms && !ctl.aborted) {
      const close: any = liveBlazes(bot, dead, 6).filter(e => reachTo(bot, e) <= 3.0 && pick.canHit(bot, e)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
      if (!close) return
      if (gameClock.now() - lastSwing0 >= 640) {
        await shield(false)
        try { await bot.lookAt(close.position.offset(0, (close.height || 1.8) * 0.5, 0), true) } catch {}
        try { bot.attack(close); lastSwing0 = gameClock.now(); out.swings++ } catch {}
        await sleep(60)
      }
      await shield(true, close.position.offset(0, (close.height || 1.8) * 0.5, 0))
      await sleep(80)
    }
    await shield(false)
  }
  // Снизу (тело ниже помоста — подход по сетке кончился под ним, s1-post14/15/18 06.10: y66 при помосте y68) — сразу в дно ямы
  // ходом сквозь кирпич: по помосту под ифритами не идти, выкапывать нечего.
  const atBottom = () => { const f = bot.entity.position.floored(); return f.x === H.x && f.z === H.z && f.y === floorY - 2 }
  if (!atBottom() && bot.entity.position.y < floorY - 0.5) {
    await fightClose()
    const NR = require('./nether-route')
    if (NR.enabled() && NR.gridOf(session)) {
      const rb = await NR.routeTo(session, ctl, { x: H.x, y: floorY - 2, z: H.z, r: 0, dy: 0, ironOk: true, timeoutSeconds: 40 }).catch(e => ({ ok: false, why: e.message }))
      log('яма у спавнера: снизу в дно', { ok: rb.ok, why: rb.why, at: xyz(bot.entity.position), bottom: atBottom() })
    }
  }
  if (!atBottom() && !bot.entity.position.floored().equals(H)) {
    await fightClose()
    // Соседняя клетка — шагом (walkNear с допуском 0 не входил в клетку рядом: B14f31 03.10 «не дошёл» за 1 бл.).
    if (bot.entity.position.floored().distanceTo(H) <= 1.5) await SL.stepMove(bot, ctl, { kind: 'flat', to: H }).catch(() => null)
    else {
      // Дальше соседней — ходом по сетке точно в клетку (walkNear не входил: B14f21 — «не дошёл» за 3 бл.).
      const NR = require('./nether-route')
      if (NR.enabled() && NR.gridOf(session)) await NR.routeTo(session, ctl, { x: H.x, y: H.y, z: H.z, r: 0, dy: 0, ironOk: true, timeoutSeconds: 30 }).catch(() => null)
      else await walkNear(bot, ctl, H, 0, 5000)
    }
    if (!bot.entity.position.floored().equals(H) && bot.entity.position.floored().distanceTo(H) <= 1.5) await SL.stepMove(bot, ctl, { kind: 'flat', to: H }).catch(() => null)
  }
  if (!atBottom() && !bot.entity.position.floored().equals(H)) {
    const alt = cand.find(c => c.equals(bot.entity.position.floored()))
    if (!alt) { log('яма у спавнера: не дошёл', { to: xyz(H), at: xyz(bot.entity.position) }); return { ok: false, why: 'не дошёл' } }
    H = alt
  }
  for (const dy of atBottom() ? [] : [-1, -2]) {
    await fightClose()
    let r = await SL.digCell(bot, H.offset(0, dy, 0)).catch(e => 'err ' + e.message)
    if (r !== 'ok' && r !== 'air') { await fightClose(); r = await SL.digCell(bot, H.offset(0, dy, 0)).catch(e => 'err ' + e.message) }
    if (r !== 'ok' && r !== 'air') { log('яма у спавнера: копка', { r, cell: xyz(H.offset(0, dy, 0)), block: (bot.blockAt(H.offset(0, dy, 0)) || {}).name, held: bot.heldItem && bot.heldItem.name }); return { ok: false, why: 'копка ' + r } }
    for (let i = 0; i < 20 && !bot.entity.onGround; i++) await sleep(50)
    await sleep(150)
  }
  const inHole = () => bot.entity.position.y < floorY - (process.env.ND_BLAZE_HOLE_DEPTH === '1' && out.hole ? 0.5 : 1.5)
  for (let i = 0; i < 10 && !inHole(); i++) await sleep(100)
  if (!inHole()) { log('яма у спавнера: не в яме', { at: xyz(bot.entity.position), y: Math.round(bot.entity.position.y * 10) / 10, H: xyz(H), below: [-1, -2, -3].map(dy => { const b = bot.blockAt(H.offset(0, dy, 0)); return b ? b.name : '?' }) }); return { ok: false, why: 'не в яме' } }
  out.hole = xyz(H)
  // ND_BLAZE_HOLE_DEPTH=1: из дна (−2) подняться на блок — глаза над полом помоста: ифриты у спавнера (пол..+2) видны и в
  // досягаемости меча, стержни с соседних клеток пола подбираются; в яме −2 они висели в 4–6 бл. вне досягаемости
  // (s1-post24/25hole 06.10: 150 с без убийств, 0 убийств).
  if (process.env.ND_BLAZE_HOLE_DEPTH === '1') {
    const up = await require('./build').towerUp(bot, ctl, 1, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
    out.holeDepth = Math.round((floorY - bot.entity.position.y) * 10) / 10
    log('яма у спавнера: глубина 1', { ok: !!(up && up.ok), y: Math.round(bot.entity.position.y * 10) / 10 })
  }
  log('яма у спавнера', { at: xyz(H), y: Math.round(bot.entity.position.y * 10) / 10 })
  await equipSword()
  let lastSwing = 0
  let lastKill = gameClock.now()
  let kills0 = dead.size
  let lastLog = 0
  while (!ctl.aborted && gameClock.now() < deadline) {
    if (countOf(bot, 'blaze_rod') >= out.want) { out.stopped = 'набрал'; break }
    if (!hasEffect(bot, 'fire_resistance')) {
      if (frLeft() > 0) { await drinkFireResistance(bot).catch(() => null); out.drinks++; for (let i = 0; i < 20 && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100); await equipSword(); continue }
      // В яме без зелья шары летят только сверху (видно — значит, и бьём) — продолжать, пока хп держится.
    }
    // Сытость ≥ 19 — быстрое лечение (FoodData: при 20 и насыщении — 1 хп за 10 тиков); есть, когда вплотную никого.
    if (((bot.food ?? 20) <= 18 || ((bot.health ?? 20) < 14 && (bot.food ?? 20) < 20)) && !liveBlazes(bot, dead, 4).some(e => reachTo(bot, e) <= 2.6)) { try { await require('./actions').eat(session, {}) } catch {} ; await equipSword() }
    if ((bot.health ?? 20) < 7) { out.stopped = `хп ${Math.round(bot.health ?? 0)} в яме`; break }
    if (dead.size > kills0) { kills0 = dead.size; lastKill = gameClock.now() }
    const now = gameClock.now()
    const blazes = liveBlazes(bot, dead, 12)
    if (now - lastLog > 5000 && bot.inventory.emptySlotCount() < 3) { try { await require('./nether-route').makeRoom(bot, 5) } catch {} }
    if (now - lastLog > 5000) { lastLog = now; log('яма', { t: Math.round((now - lastKill) / 1000), hp: Math.round(bot.health ?? 0), rods: countOf(bot, 'blaze_rod'), blazes: blazes.length, near: blazes.filter((e : any) => e.position.distanceTo(bot.entity.position) < 4).length, swings: out.swings, kills: dead.size }) }
    const inReach = blazes.filter(e => reachTo(bot, e) <= 3.0 && pick.canHit(bot, e)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))
    if (inReach.length) {
      const e: any = inReach[0]
      if (now - lastSwing >= 640) {
        await shield(false)
        try { await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.5, 0), true) } catch {}
        try { bot.attack(e); lastSwing = gameClock.now(); out.swings++ } catch {}
        await sleep(60)
      }
      if (reachTo(bot, e) <= 2.4) await shield(true, e.position.offset(0, (e.height || 1.8) * 0.5, 0))
      await sleep(50)
      continue
    }
    await shield(false)
    // Под огнестойкостью ждать волну дольше: спавнер — раз в 10–40 с по 1–4, ифриты висят в 4–6 бл. и подлетают не сразу; выход из
    // ямы под ними — уход с безопасного места (s1-post21hole 06.10: «75 с без убийств» → бой по-старому → смерть после навыка).
    if (now - lastKill > (hasEffect(bot, 'fire_resistance') ? 150000 : 75000)) { out.stopped = `в яме ${hasEffect(bot, 'fire_resistance') ? 150 : 75} с без убийств`; break }
    await sleep(100)
  }
  // Выйти: столб из блоков под себя (2), до уровня помоста — только когда набрал или огнестойкости больше нет. По времени/без
  // убийств/на малом хп — остаться в яме: следующий вызов blaze продолжит отсюда (atBottom), а наверху между вызовами ифриты
  // добивали тело (s1-post21hole/22hole 06.10: вышел из ямы по времени — смерть до следующего вызова).
  const frAny = hasEffect(bot, 'fire_resistance') || frLeft() > 0
  if (inHole() && !ctl.aborted && (bot.health ?? 0) > 0 && (out.stopped === 'набрал' || !frAny)) {
    const r = await require('./build').towerUp(bot, ctl, 2, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
    log('яма у спавнера: вышел', { ok: !!(r && r.ok), y: Math.round(bot.entity.position.y * 10) / 10 })
  }
  return { ok: true }
}

// Бой «у самого спавнера» под огнестойкостью (ND_BLAZE_CAMP=1, поток nether 03.10). Под зельем шар блейза не жжёт
// вовсе (fireball в #is_fire, LivingEntity.hurt), опасен только удар вплотную (6, в железе ~3.4 — BlazeAttackGoal).
// Блейзы спавнера появляются в ±4 от него и по высоте −1..+1 (BaseSpawner spawnRange 4) — стоять у самого спавнера.
// Иссушители спавнятся на кирпиче помоста и бьют вплотную (neF-B5f22-1 03.10: 3 блейза за 16 с, потом два иссушителя
// — 18 урона ударами и 6 иссушением за 16 с, смерть). Поэтому — столб в 3 блока на помосте: рамка удара моба — его
// рамка, раздутая по горизонтали (Mob.getAttackBoundingBox, 1.20.5+), по высоте — нет; иссушитель 2.4 в высоту, ноги
// тела на +3 — не достаёт. С вершины: меч по блейзам в досягаемости, лук по дальним. Стержни падают на помост — слезть
// (шаг со столба, 3 блока без урона), собрать, снова столб; иссушитель на помосте — сперва его луком сверху.
async function campSpawner (session, ctl, { spawner, want, deadline, dead, setPhase = () => {}, p = {} }: any) {
  const bot = session.bot
  const pick = require('./pick')
  const { potionOf } = require('./pvp')
  const frLeft = () => bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
  let base = bot.entity.position.floored()
  const PILLAR = 3
  // Помост тронного зала — ноги на высоте спавнера (MonsterThrone: спавнер на помосте). «Наверху» — ноги на +2.6 и выше.
  const floorY = spawner ? spawner.y : base.y
  const out: any = { swings: 0, drinks: 0, picks: 0, fights: 0, shots: 0, towers: 0, descents: 0, wsShots: 0, rods0: countOf(bot, 'blaze_rod'), stopped: null, post: xyz(base) }
  const t0 = gameClock.now()
  let lastSwing = 0
  let lastLog = 0
  let lastAct = gameClock.now()
  let post = base
  const noShot = new Map()
  const swordOf = () => bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((a, b) => ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(b.name.split('_')[0]) - ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(a.name.split('_')[0]))[0]
  const equipSword = async () => { const sw = swordOf(); if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} } }
  const OTHER = /^(wither_skeleton|magma_cube|piglin_brute|hoglin|skeleton|zoglin)$/
  const fillers = () => { try { return require('./sealed').fillerCount(bot) } catch { return 0 } }
  // Щит между взмахами: блейз вплотную бьёт раз в 20 тиков (6, в железе ~3.4 — и под огнестойкостью: удар не огонь;
  // neF-B5f31-1 03.10 — у спавнера 20 → 7 хп ударами за полторы минуты, смерть). Щит к нему, взмах — когда меч готов.
  let guard = null
  try { guard = require('./combat').makeShield(session, ctl, { shield: 'always' }) } catch {}
  let shieldOn = false
  const shield = async (on, face = null) => {
    if (!guard) return
    if (on && face) { try { await bot.lookAt(face, true) } catch {} }
    if (on && !shieldOn) { shieldOn = true; try { await guard.raise(true) } catch {} } else if (!on && shieldOn) { shieldOn = false; try { await guard.raise(false) } catch {} }
  }
  const onTop = () => bot.entity.position.y >= floorY + PILLAR - 0.4
  const bowReady = () => itemNamed(bot, 'bow') && arrowsHave(bot) > 0 && canUseRanged(session, { name: 'blaze' }, p)
  let climbFailAt = 0
  // Стенки «чашки» на вершине: блок у опоры (сбоку от верхнего блока столба) и на нём — у ног. Отдача удара блейза
  // скидывала тело со столба 1×1 к иссушителям (B8f23 03.10: дважды за 3 мин), а голова над стенками — бой как был.
  const cup = async () => {
    const { placeBlockAt } = require('./build')
    const f = bot.entity.position.floored()
    let placed = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (ctl.aborted || fillers() < 2) break
      for (const dy of [-1, 0]) {
        const c = f.offset(dx, dy, dz)
        const b = bot.blockAt(c)
        if (!b || b.boundingBox === 'block') continue
        const r = await placeBlockAt(bot, c, { timeoutMs: 1200 }).catch(() => null)
        if (r && r.ok && !r.already) placed++
        else if (dy === -1) break
      }
    }
    return placed
  }
  const climb = async () => {
    if (onTop()) return true
    if (p.campPillar === false || fillers() < PILLAR) return false
    if (gameClock.now() - climbFailAt < 6000) return false
    // Столб — с пола у спавнера (помост, ступени, стенка: ±2 от уровня помоста — B11f31 03.10 стоял на +1 и столб
    // не строился, иссушитель убил).
    if (Math.abs(bot.entity.position.y - floorY) > 2.2 || !bot.entity.onGround) return false
    setPhase('лагерь: столб')
    post = bot.entity.position.floored()
    const r = await require('./build').towerUp(bot, ctl, PILLAR, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
    out.towers++
    let walls = 0
    if (onTop()) { bot.setControlState('sneak', true); walls = await cup() } else climbFailAt = gameClock.now()
    log('лагерь: столб', { ok: !!(r && r.ok), placed: r && r.placed, walls, reason: r && r.reason, y: Math.round(bot.entity.position.y * 10) / 10, post: xyz(post) })
    await equipSword()
    setPhase('лагерь у спавнера')
    return onTop()
  }
  // Лук по цели (блейз или иссушитель): точка — середина рамки с упреждением.
  const shootAt = async (e, frac = 0.55) => {
    const track = makeTrack(e)
    track.update()
    const r = await require('./bow').shoot(bot, e, {
      velFn: () => { track.update(); return track.vel() },
      point: t => { track.update(); const v = track.vel(); return e.position.offset(v.x * t, (e.height || 1.8) * frac + v.y * t, v.z * t) },
      follow: false,
      mode: 'settle',
      shouldStop: () => !e.isValid || liveBlazes(bot, dead, 6).some(b => reachTo(bot, b) <= 2.6)
    }).catch(err => ({ shot: false, why: err.message }))
    await equipSword()
    return r || { shot: false }
  }
  // Слезть со столба на помост: шаг в соседнюю клетку помоста (пол на уровне основания столба).
  let descWhy = ''
  const descend = async () => {
    descWhy = ''
    const f = bot.entity.position.floored()
    if (f.y - floorY > 5) { descWhy = 'высоко'; return false }
    const cells = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => new Vec3(f.x + dx, floorY, f.z + dz)).filter(c => {
      const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0))
      if (!a || !b || !u) return false
      if (a.boundingBox !== 'empty' || b.boundingBox !== 'empty' || u.boundingBox !== 'block' || /lava|fire|magma/.test(u.name)) return false
      // Столб над ней до нашей высоты — свободен.
      for (let y = c.y + 2; y <= f.y + 1; y++) { const q = bot.blockAt(new Vec3(c.x, y, c.z)); if (!q || q.boundingBox !== 'empty') return false }
      return !(spawner && c.x === spawner.x && c.z === spawner.z)
    })
    // Стенки чашки: в выбранную сторону — снести блок у ног и опору под ним (свои блоки, видно вплотную).
    const SL = require('./sealed')
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let c = cells[0]
    if (!c) {
      for (const [dx, dz] of dirs) {
        const w0 = f.offset(dx, 0, dz); const w1 = f.offset(dx, -1, dz)
        const land = new Vec3(f.x + dx, floorY, f.z + dz)
        const u = bot.blockAt(land.offset(0, -1, 0)); const a = bot.blockAt(land)
        if (!u || u.boundingBox !== 'block' || /lava|fire|magma/.test(u.name) || !a || a.boundingBox !== 'empty') continue
        let clear = true
        for (let y = floorY + 1; y < f.y - 1; y++) { const q = bot.blockAt(new Vec3(land.x, y, land.z)); if (!q || q.boundingBox !== 'empty') { clear = false; break } }
        if (!clear) continue
        const r0 = await SL.digCell(bot, w0).catch(e => 'err ' + e.message)
        const r1 = await SL.digCell(bot, w1).catch(e => 'err ' + e.message)
        const b0 = bot.blockAt(w0); const b1 = bot.blockAt(w1)
        if (b0 && b0.boundingBox === 'empty' && b1 && b1.boundingBox === 'empty') { c = land; break }
        descWhy = `стенка ${xyz(w0)}: ${r0}/${r1}`
      }
    }
    if (!c) {
      // Шагнуть некуда (стоим над краем зала, у забора: B10f21 03.10 — 30 с наверху, 0 ударов) — копать вниз под собой:
      // свой блок/забор/стенку, по 1 клетке, пока ноги не у помоста (под колонной — твёрдое, без лавы).
      setPhase('лагерь: вниз копкой')
      bot.setControlState('sneak', false)
      for (let k = 0; k < 5 && !ctl.aborted && bot.entity.position.y >= floorY + 1.5; k++) {
        const g0 = bot.entity.position.floored()
        let landY = null
        for (let y = g0.y - 2; y >= floorY - 2; y--) { const q = bot.blockAt(new Vec3(g0.x, y, g0.z)); if (!q) break; if (/lava|fire/.test(q.name)) { landY = null; break } if (q.boundingBox === 'block') { landY = y; break } }
        if (landY == null || g0.y - 1 - landY > 4) { descWhy = `под собой пусто/лава (land ${landY})`; return false }
        const r = await SL.digCell(bot, g0.offset(0, -1, 0)).catch(() => 'err')
        if (r !== 'ok' && r !== 'air') { descWhy = 'копка вниз: ' + r; return false }
        for (let i = 0; i < 30 && !bot.entity.onGround; i++) await sleep(50)
        await sleep(150)
      }
      out.descents++
      if (bot.entity.position.y < floorY + 2.6) base = bot.entity.position.floored()
      return bot.entity.position.y < floorY + 2.6
    }
    setPhase('лагерь: вниз')
    bot.setControlState('sneak', false)
    const tx = c.x + 0.5; const tz = c.z + 0.5
    try {
      for (let i = 0; i < 30 && !ctl.aborted; i++) {
        const q = bot.entity.position
        if (Math.floor(q.x) === c.x && Math.floor(q.z) === c.z) break
        await bot.lookAt(new Vec3(tx, q.y + 1.6, tz), true).catch(() => {})
        bot.setControlState('forward', true)
        await sleep(50)
      }
    } finally { bot.setControlState('forward', false) }
    for (let i = 0; i < 40 && !bot.entity.onGround; i++) await sleep(50)
    out.descents++
    if (bot.entity.position.y < floorY + 1) base = bot.entity.position.floored()
    else descWhy = `шагнул к ${xyz(c)}, а стою на ${Math.round(bot.entity.position.y * 10) / 10}`
    return bot.entity.position.y < floorY + 1
  }
  // Основное место — на помосте у спавнера (блейзы появляются в ±4 и по высоте −1..+1 — там их и бить: B5f23 03.10,
  // на полу 14 убийств за 278 с; со столба +3 — 0–6 за 5–6 мин, B9f21/B9f23: блейз с лучом к цели не подлетает,
  // BlazeAttackGoal только стреляет). Столб с чашкой — укрытие от иссушителя (он не достаёт ноги на +3): забраться,
  // луком его сверху, слезть.
  // Место под стержни (рюкзак, набитый незераком после хода, не подбирал стержень в 1 бл.: B16f21 03.10).
  try { await require('./nether-route').makeRoom(bot, 6) } catch {}
  await equipSword()
  // Яма у спавнера (ND_BLAZE_HOLE=1): сверху — сперва вниз, потом яма; вышло мало — дальше гибрид как был.
  if (process.env.ND_BLAZE_HOLE === '1' && spawner) {
    if (onTop()) await descend()
    if (!onTop()) {
      out.want = want
      const hr = await holeCamp(session, ctl, { spawner, want, deadline, dead, setPhase, out, equipSword, shield, frLeft })
      out.holeResult = hr && hr.why
      // Остались в яме (время/без убийств/мало хп при живой огнестойкости) — лагерь на столбе не начинать, вернуть управление.
      if (bot.entity.position.y < floorY - 0.5 && out.hole && out.stopped !== 'набрал') { out.inHole = true; out.stopped = out.stopped || 'время вышло'; out.rods = countOf(bot, 'blaze_rod'); out.seconds = Math.round((gameClock.now() - t0) / 1000); out.kills = dead.size; log('лагерь итог', out); return out }
    }
  }
  let up = onTop()
  setPhase('лагерь у спавнера')
  const WS = /^(wither_skeleton|piglin_brute|hoglin|zoglin)$/
  while (!ctl.aborted && gameClock.now() < deadline) {
    const have = countOf(bot, 'blaze_rod')
    if (have >= want) { out.stopped = 'набрал'; break }
    if (!hasEffect(bot, 'fire_resistance')) {
      if (frLeft() > 0) {
        const d = await drinkFireResistance(bot).catch(e => e.message)
        out.drinks++
        for (let i = 0; i < 40 && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
        log('лагерь: огнестойкость', { d, left: frLeft(), on: hasEffect(bot, 'fire_resistance') })
        await equipSword()
        // Не подействовало (глоток прерван ударом/пакет эффекта запоздал: B17c21 03.10) — ещё раз, потом выход.
        if (!hasEffect(bot, 'fire_resistance')) { out.frMiss = (out.frMiss || 0) + 1; if (out.frMiss >= 3) { out.stopped = 'зелье не подействовало'; break } }
        continue
      }
      out.stopped = 'огнестойкость кончилась, зелий нет'
      break
    }
    // Сытость ≥ 19 — быстрое лечение (FoodData); есть, когда вплотную никого.
    if (((bot.food ?? 20) <= 18 || ((bot.health ?? 20) < 14 && (bot.food ?? 20) < 20)) && !liveBlazes(bot, dead, 4).some(e => reachTo(bot, e) <= 2.6)) {
      try { await require('./actions').eat(session, {}) } catch {}
      await equipSword()
    }
    if ((bot.health ?? 20) < 7) { out.stopped = `хп ${Math.round(bot.health ?? 0)} — лагерь бросаю`; break }
    up = onTop()
    if (up !== !!bot.getControlState('sneak')) bot.setControlState('sneak', up)
    const me = bot.entity.position
    const now = gameClock.now()
    const blazes = liveBlazes(bot, dead, 20)
    const others = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.position && e.isValid !== false && OTHER.test(e.name || '') && e.position.distanceTo(me) < 12)
    // Иссушитель/брут рядом на уровне помоста (по горизонтали ≤ 8, по высоте ≤ 3) — угроза ближнего боя.
    // Только видимые (луч от глаз до груди): за стенами крепости иссушители есть всегда (B11f21 — наверху без спуска).
    const vis = e => { try { return require('./perception').raySees(bot, require('./perception').eyePos(bot), e.position.offset(0, (e.height || 1.8) * 0.6, 0)) } catch { return true } }
    const melee = others.filter((e : any) => WS.test(e.name) && Math.hypot(e.position.x - me.x, e.position.z - me.z) <= 8 && Math.abs(e.position.y - floorY) <= 3 && vis(e))
    if (now - lastLog > 5000 && bot.inventory.emptySlotCount() < 3) { try { await require('./nether-route').makeRoom(bot, 5) } catch {} }
    if (now - lastLog > 5000) { lastLog = now; log('лагерь', { t: Math.round((now - t0) / 1000), hp: Math.round(bot.health ?? 0), up, rods: have, blazes: blazes.length, ws: melee.length, swings: out.swings, shots: out.shots, picks: out.picks, kills: dead.size }) }
    if (!up && melee.length) {
      // Наверх (столб с чашкой); не вышло — бой.
      if (await climb()) { lastAct = gameClock.now(); continue }
      const foe: any = melee.filter(e => pick.canHit(bot, e, { range: 6 })).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
      if (foe && now - (noShot.get('f' + foe.id) || 0) > 5000) {
        out.fights++
        setPhase('лагерь: бой ' + foe.name)
        const tf = gameClock.now()
        const r = await require('./combat').fight(session, ctl, { target: '#' + foe.id, timeoutSeconds: 20, retreatAtHealth: 7, shield: 'always', clearArea: 0 }).catch(e => ({ error: e.message }))
        log('лагерь: чужой', { name: foe.name, killed: !!(r && (r.killed || (r.kills && r.kills.length))), hp: Math.round(bot.health ?? 0), ms: gameClock.now() - tf })
        if (gameClock.now() - tf < 1500) { noShot.set('f' + foe.id, gameClock.now()); await sleep(250) }
        await equipSword()
        setPhase('лагерь у спавнера')
        continue
      }
    }
    // Наверху и иссушитель внизу — луком его (сверху он не достаёт).
    if (up && melee.length) {
      const ws: any = melee.filter((e : any) => now - (noShot.get(e.id) || 0) > 2000).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
      if (ws && bowReady()) {
        setPhase('лагерь: лук по ' + ws.name)
        const r = await shootAt(ws, 0.6)
        if (r.shot) { out.wsShots++; lastAct = gameClock.now() } else noShot.set(ws.id, gameClock.now())
        if (onTop()) bot.setControlState('sneak', true)
        continue
      }
    }
    // Меч по блейзу в досягаемости; щит к ближнему между взмахами.
    const inReach = blazes.filter(e => reachTo(bot, e) <= 3.0 && pick.canHit(bot, e)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))
    if (inReach.length) {
      const e: any = inReach[0]
      if (now - lastSwing >= 640) {
        await shield(false)
        try { await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.6, 0), true) } catch {}
        try { bot.attack(e); lastSwing = gameClock.now(); out.swings++; lastAct = gameClock.now() } catch {}
        await sleep(60)
      }
      if (reachTo(bot, e) <= 2.4) await shield(true, e.position.offset(0, (e.height || 1.8) * 0.6, 0))
      await sleep(50)
      continue
    }
    if (shieldOn) await shield(false)
    // Наверху, иссушителей рядом нет — вниз, к спавнеру (там блейзы).
    if (up && !melee.length && !others.some((e : any) => WS.test(e.name) && e.position.distanceTo(me) < 10 && vis(e)) && now - (noShot.get('down') || 0) > 5000) {
      if (await descend()) { lastAct = gameClock.now(); continue }
      noShot.set('down', gameClock.now())
      log('лагерь: слезть не вышло', { at: xyz(bot.entity.position), floorY, why: descWhy })
    }
    // Стержни рядом на помосте — подобрать сразу (под зельем шары не страшны).
    if (!up && now - (noShot.get('rods') || 0) > 10000) {
      const rodsNear = ents(bot).filter((e : any) => e && e.name === 'item' && e.position && isRod(e) && e.position.distanceTo(me) <= 7 && e.position.y >= floorY - 2.5 && !lavaNear(bot, e.position, 1))
      if (rodsNear.length) {
        setPhase('лагерь: стержни')
        const r0 = countOf(bot, 'blaze_rod')
        await collectRods(bot, ctl, 7, 4000)
        // Не прибавилось — эти стержни недостижимы (под спавнером, за забором): 10 с не пробовать (B13f21: 32 захода, 0).
        if (countOf(bot, 'blaze_rod') > r0) out.picks++
        else noShot.set('rods', gameClock.now())
        lastAct = gameClock.now()
        await equipSword()
        setPhase('лагерь у спавнера')
        continue
      }
    }
    // Блейз над помостом в 6 бл. и на высоте досягаемости — подойти под него по помосту (меч, а не лук: стержень
    // упадёт рядом; блейз с лучом сам не подлетает — BlazeAttackGoal).
    if (!up) {
      const chase: any = blazes.filter((e : any) => Math.hypot(e.position.x - me.x, e.position.z - me.z) <= 6 && e.position.y >= floorY - 1 && e.position.y <= floorY + 2.2 && now - (noShot.get('c' + e.id) || 0) > 4000)
        .map((e : any) => ({ e, c: new Vec3(Math.floor(e.position.x), floorY, Math.floor(e.position.z)) }))
        .filter(({ c }: any) => { const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0)); return a && b && u && a.boundingBox === 'empty' && b.boundingBox === 'empty' && u.boundingBox === 'block' && !/lava|fire|magma/.test(u.name) })
        .sort((a: any, b: any) => a.e.position.distanceTo(me) - b.e.position.distanceTo(me))[0]
      if (chase) {
        setPhase('лагерь: к блейзу')
        const w = await walkNear(bot, ctl, chase.c, 1, 2500)
        if (!w || !w.ok) noShot.set('c' + chase.e.id, gameClock.now())
        setPhase('лагерь у спавнера')
        continue
      }
    }
    // Дальние блейзы над помостом — луком (стержень упадёт на помост).
    const overFloor = e => !spawner || Math.hypot(e.position.x - spawner.x - 0.5, e.position.z - spawner.z - 0.5) <= 3.5
    const target: any = bowReady() ? blazes.filter((e : any) => { const d = e.position.distanceTo(me); return d >= 3.2 && d <= 16 && overFloor(e) && now - (noShot.get(e.id) || 0) > 2500 && aimFrac(bot, e) !== null && !bystanderOnLine(bot, e) }).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] : null
    if (target) {
      setPhase('лагерь: лук')
      const r = await shootAt(target, aimFrac(bot, target) ?? 0.55)
      if (r.shot) { out.shots++; lastAct = gameClock.now() } else noShot.set(target.id, gameClock.now())
      if (onTop()) bot.setControlState('sneak', true)
      setPhase('лагерь у спавнера')
      continue
    }
    // Внизу — вплотную к спавнеру (соседняя клетка помоста): новые блейзы появляются в ±4 от него — ближе к мечу.
    if (!up && spawner && Math.hypot(bot.entity.position.x - spawner.x - 0.5, bot.entity.position.z - spawner.z - 0.5) > 1.9 && now - (noShot.get('hug') || 0) > 8000) {
      const hug = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => new Vec3(spawner.x + dx, floorY, spawner.z + dz)).filter(c => {
        const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0))
        return a && b && u && a.boundingBox === 'empty' && b.boundingBox === 'empty' && u.boundingBox === 'block' && !/lava|fire|magma/.test(u.name)
      }).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
      if (hug) { const w = await walkNear(bot, ctl, hug, 0, 3000); if (!w || !w.ok) noShot.set('hug', gameClock.now()); else base = hug }
      else noShot.set('hug', gameClock.now())
      continue
    }
    await sleep(120)
  }
  try { await shield(false) } catch {}
  bot.setControlState('sneak', false)
  out.rods = countOf(bot, 'blaze_rod') - out.rods0
  out.seconds = Math.round((gameClock.now() - t0) / 1000)
  out.kills = dead.size
  if (!out.stopped) out.stopped = ctl.aborted ? 'прервано' : 'время вышло'
  log('лагерь итог', out)
  return out
}

// Закопаться на месте: 2 клетки вниз и крышка над головой. Яма 1×1 глубиной 2 — ифрит не достаёт ударом (BlazeAttackGoal: d² < 4),
// шару нужен луч (s1-post24/25hole 06.10: в такой яме хп 20 всё время). Выход из навыка под ифритами иначе убивал: «к колонне
// не дошёл», 17 → 2 хп (s1-LG-3, LH-3: 5 стержней и смерть через секунды).
// Почему яма глубины depth под клеткой ног f не годится (null — годится): клетки ямы и пол под ней твёрдые, без лавы/воды/огня;
// стенки ямы твёрдые со всех сторон: яма у края помоста с воздухом сбоку открыта ифритам (их удар вплотную требует луча —
// BlazeAttackGoal: hasLineOfSight; s1c-M-2 06.10: «sealed», а 7 ударов в яме сбоку, смерть). Общая для digInPlace и digInNear.
const PIT_BAD = b => !b || /lava|water|fire|magma|spawner|bedrock|chest/.test(b.name)
function pitWhyAt (bot, f, depth) {
  const cs = [1, 2, 3].slice(0, depth).map(d => f.offset(0, -d, 0))
  for (const c of cs) { const b = bot.blockAt(c); if (PIT_BAD(b) || b.boundingBox !== 'block') return 'под ногами: ' + (b ? b.name : '?') }
  const fl = bot.blockAt(f.offset(0, -depth - 1, 0))
  if (PIT_BAD(fl) || fl.boundingBox !== 'block') return `пол на −${depth + 1}: ` + (fl ? fl.name : '?')
  for (const c of cs) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const b = bot.blockAt(c.offset(dx, 0, dz)); if (!b || /lava/.test(b.name) || b.boundingBox !== 'block') return 'лава/пусто у ямы' }
  return null
}

async function digInPlace (bot, ctl) {
  const SL = require('./sealed')
  // В прыжке/отбросе под ногами воздух (s1-LH-9/LH-10 06.10: «под ногами: air») — сперва стоять на земле.
  for (let i = 0; i < 30 && !bot.entity.onGround && !ctl.aborted; i++) await sleep(50)
  const f = bot.entity.position.offset(0, 0.2, 0).floored()
  // Глубина 3: крышка — над головой в клетке f−1, у неё 4 стенки ямы — грань для установки есть всегда. При глубине 2 крышка
  // шла в клетку пола f, а у неё на ровном месте ни одной опорной грани (сбоку воздух, снизу голова): «крышка не встала»,
  // шары в открытый верх (S1d s1d-N-3: 19 жемчуга, в яме без крышки 50 урона «в толщу отлечиться», смерть на 41-й мин).
  // Глубина 3 не помещается (помост крепости в 1–2 блока толщиной над пустотой: «лава/пусто у ямы» — s1d-G21-5, смерть) — яма 2
  // по-старому, без гарантии крышки, но с твёрдыми стенками. ND_PIT_DEPTH=2 — сразу 2.
  const pitWhy = depth => pitWhyAt(bot, f, depth)
  const why3 = process.env.ND_PIT_DEPTH === '2' ? 'ND_PIT_DEPTH=2' : pitWhy(3)
  const why2 = why3 ? pitWhy(2) : null
  if (why3 && why2) return { ok: false, why: why2 }
  const DEPTH = why3 ? 2 : 3
  const cells = [1, 2, 3].slice(0, DEPTH).map(d => f.offset(0, -d, 0))
  for (const c of cells) {
    if (ctl.aborted) return { ok: false, why: 'прервано' }
    // Копку под ударами сервер обрывает («server interrupted», s1c-B-3 06.10) — повторить до трёх раз.
    let r = 'err'
    for (let k = 0; k < 3 && r !== 'ok' && r !== 'air' && !ctl.aborted; k++) r = await SL.digCell(bot, c).catch(e => 'err ' + e.message)
    if (r !== 'ok' && r !== 'air') return { ok: false, why: 'копка ' + r }
    for (let i = 0; i < 20 && !bot.entity.onGround; i++) await sleep(50)
  }
  for (let i = 0; i < 10 && bot.entity.position.y > f.y - DEPTH + 0.5; i++) await sleep(100)
  if (bot.entity.position.y > f.y - DEPTH + 0.5) return { ok: false, why: 'не опустился' }
  const top = bot.entity.position.floored().offset(0, 2, 0)
  // Крышка — до трёх попыток (ифрит в клетке над ямой мешает поставить: s1-LL-6 06.10 «sealed: false» → видели в открытый верх).
  let sealed = false
  for (let k = 0; k < 3 && !sealed && !ctl.aborted; k++) { sealed = !!(await SL.fillCell(bot, top).catch(() => false)); if (!sealed) await sleep(300) }
  return { ok: true, sealed: !!sealed, depth: DEPTH, at: xyz(bot.entity.position) }
}

// В толщу рядом: на мосту/помосте под ногами воздух (s1c-A-2 06.10: «под ногами: air» у спавнера — навык вернул тело под ифритов,
// смерть через секунду). Тогда — ближняя клетка (≤ 4 бл., тот же уровень), где 3 вниз твёрдое и нет лавы рядом, 1–3 шага и там.
async function digInNear (bot, ctl, r = 4) {
  const first: any = await digInPlace(bot, ctl)
  if (first.ok || ctl.aborted || !/под ногами|пол на|лава\/пусто/.test(first.why || '')) return first
  const { standable } = require('./walkable')
  const f = bot.entity.position.offset(0, 0.2, 0).floored()
  const cands = []
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (!dx && !dz) continue
    const c = f.offset(dx, 0, dz)
    if (!standable(bot, c)) continue
    // Соседняя клетка — под ту же яму, что примет digInPlace: 3, иначе 2 (проверка S1d (г): брали только клетки под яму 3 —
    // на помосте крепости в 2–3 блока соседней не находилось, хотя яма 2 там встаёт). Яма 2 — чуть дороже (крышка без гарантии).
    const depth = process.env.ND_PIT_DEPTH !== '2' && !pitWhyAt(bot, c, 3) ? 3 : !pitWhyAt(bot, c, 2) ? 2 : 0
    if (depth) cands.push({ c, depth, cost: c.distanceTo(f) + (depth === 3 ? 0 : 1.5) })
  }
  cands.sort((a, b) => a.cost - b.cost)
  for (const { c } of cands.slice(0, 3)) {
    if (ctl.aborted) break
    const w = await walkNear(bot, ctl, c, 0, 4000)
    if (!w.ok || !bot.entity.position.offset(0, 0.2, 0).floored().equals(c)) continue
    const r2: any = await digInPlace(bot, ctl)
    if (r2.ok) return { ...r2, moved: xyz(c) }
  }
  return { ...first, near: cands.length }
}

async function farmRods (session, ctl, p: any = {}) {
  const bot = session.bot
  try { require('./ne-guard').swatInstall(bot) } catch {}
  try { require('./ne-guard').attach(session) } catch {}
  const mcData = session.mcData
  const combat = require('./combat')
  const actions = require('./actions')
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const retreatAt = clamp(p.retreatAtHealth ?? 8, 3, 16)
  // Раньше порога отхода — отдых за углом: пять блейзов разом снимают 16 хп за
  // полминуты (замер try-blaze-rods (а), первый прогон), а порог — это конец боя.
  const restAt = Math.max(retreatAt + 6, 14)
  let restsLeft = p.rest === false ? 0 : 4
  const rests = []
  const covers = []
  let coverAt = 0
  let coverFailAt = 0
  let lastBeat = 0
  let anchor = null
  let farSince = 0
  let coverFails = 0
  let bail = false
  let fled = null
  let dugIn = null
  let radius = clamp(p.radius ?? 20, 8, 32)
  // Бой мечом (ND_BLAZE_MELEE) владеет руками с начала навыка: тактика не рвёт подготовку у спавнера (bnf3/bnf4 16.10: TACTICAL
  // на 2–4-й с — заход потерян до первого взмаха). Чужие враги вплотную тактика по-прежнему берёт (protectedEncounter).
  if (process.env.ND_BLAZE_MELEE !== '0' && worlds.worldOf(bot) === 'the_nether') session._blazeCombatCtl = ctl
  const rods0 = countOf(bot, 'blaze_rod')
  const short = rodsShort(bot, p.eyes ?? EYES_WANTED)
  // rods — сколько должно СТАТЬ в рюкзаке (так зовёт автомат: blaze {rods: 7});
  // count — сколько добыть сверх того, что есть.
  const want = p.rods ? Math.max(rods0 + 1, p.rods) : rods0 + Math.max(1, p.count ?? short)
  const hp0 = Math.round(bot.health ?? 20)
  const here = worlds.worldOf(bot)

  const kills = []
  const dead = new Set()
  let phase = 'начало'
  const ledger = damageLedger(bot, () => phase)
  // Кого мы задели за последние 3 с: пропажа засчитывается убийством только у
  // них. Иначе смена мира (worlds.js чистит все сущности) и смерть самого бота
  // рождали «убил 8» у бота, убившего одного.
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'blaze') hurtAt.set(e.id, gameClock.now()) }
  bot.on('entityHurt', onHurt)
  const onDead = (e, how) => {
    if (!e || e.name !== 'blaze' || !e.position || dead.has(e.id)) return
    if (e.position.distanceTo(bot.entity.position) > 24) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    dead.add(e.id)
    kills.push({ at: xyz(e.position), t: Math.round((gameClock.now() - t0) / 100) / 10 })
  }
  const onGone = e => onDead(e, 'gone')
  // entityDead приходит не всегда (pvp.js: «сущность снимается с мира через
  // секунду после смерти, и entityDead приходит не всегда») — счёт по нему одному
  // давал «по 1 стержню на блейза» 12 раз из 14, где игра даёт 0..1. Блейз не
  // исчезает сам в 24 блоках от игрока, поэтому пропажа рядом — тоже смерть.
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)

  const fights = []
  const ate = []
  let thrown = 0
  let walked = null
  let stopped = null
  let highTimeouts = 0
  let potion = null
  let toured = null
  let held = null
  let camp = null
  let unseenWalks = 0
  // Недостижимые за стеной — не мёртвые: убийство их всё равно засчитается.
  const skip = new Set()

  try {
    // --- где спавнер: видно глазами, иначе память этого мира.
    const pitOut: any = {}
    if (witherClose(bot)) { phase = 'яма от иссушителя'; await pitFrom(session, ctl, pitOut, witherClose(bot)) }
    let spawner = visibleSpawner(bot, mcData, 32)
    // Сразу после входа/телепорта чанки вокруг ещё грузятся: спавнер в трёх
    // блоках «не виден», и бой шёл к старой записи памяти за 1971 блок
    // (ферма 2026-09-29, blaze-mainkit-1). Подождать до 4 с.
    for (let k = 0; !spawner && k < 8 && !ctl.aborted; k++) {
      if (witherClose(bot)) { phase = 'яма от иссушителя'; await pitFrom(session, ctl, pitOut, witherClose(bot)) }
      await sleep(500); spawner = visibleSpawner(bot, mcData, 32)
    }
    let spawnerFrom = spawner ? 'вижу' : null
    const places = (session.journal.state && session.journal.state.places) || {}
    const rec = places[SPAWNER_PLACE]
    if (!spawner && rec && worlds.worldOfRecord(rec) === here) {
      spawner = new Vec3(rec.x, rec.y, rec.z)
      spawnerFrom = 'память'
      // Запись есть, а на месте уже не спавнер (сломан) — забыть, а не ждать
      // его 50 секунд (сцена (в): «спавнер молчит» у убранного спавнера).
      const b = bot.blockAt(spawner)
      if (b && b.name !== 'spawner' && seesBlock(bot, b)) {
        session.journal.patch(s => { if (s.places) delete s.places[SPAWNER_PLACE] })
        spawner = null
        spawnerFrom = null
      }
    }
    // Ни спавнера, ни блейза рядом, а крепость найдена — дойти до неё и обойти
    // по видимому кирпичу, пока не увидим тронный зал (fortress.js tour).
    if (!spawner && !nearestBlaze(bot, radius, dead) && here === 'the_nether' && p.tour !== false) {
      const fortress = require('./fortress')
      const known = fortress.placeOf(session, fortress.PLACE)
      if (known && worlds.worldOfRecord(known) === here) {
        phase = 'обход крепости'
        toured = await fortress.tour(session, ctl, { deadline: Math.min(deadline, gameClock.now() + 240000) })
        // Спавнера не нашёл, а блейзов видел — бить тех, что есть (крепость
        // спавнит их и без спавнера): дальше обычных 20 блоков.
        if (toured.blazes && !p.radius) radius = 32
        if (toured.spawners && toured.spawners.length) {
          const s = toured.spawners[0]
          spawner = new Vec3(s.x, s.y, s.z)
          spawnerFrom = 'вижу'
        }
      }
    }
    if (spawner && spawnerFrom === 'вижу' && !(rec && rec.x === spawner.x && rec.y === spawner.y && rec.z === spawner.z)) {
      session.journal.patch(s => {
        if (!s.places) s.places = {}
        s.places[SPAWNER_PLACE] = { ...xyz(spawner), dimension: here, note: 'спавнер блейзов: стоять в 16 блоках, чтобы работал' }
      })
      session.journal.append(SPAWNER_PLACE, `спавнер блейзов на ${spawner.x},${spawner.y},${spawner.z}`, spawner)
    }
    // Спавнер работает, только пока мы в 16 блоках от его центра — подойти,
    // но не в упор: блейзы появляются в ±4 от него.
    // Не на уровне помоста (ноги ниже/выше спавнера больше чем на 2) — тоже ход по сетке на пол зала: из-под помоста ифриты
    // над краем не видны и не достаются (s1-post07/09/14/15 06.10: тело на y66 при спавнере y69 в 5 бл. — 0 убийств за 6 мин).
    // Ниже помоста уже на 2 (ноги y−2: глаза под верхом пола, s1-LA-1/LB-1 06.10: y67 при спавнере y69 — 0 убийств за 2 зелья FR).
    const offLevel = () => !!spawner && (Math.floor(bot.entity.position.y) < spawner.y - 1 || Math.floor(bot.entity.position.y) > spawner.y + 2)
    // …но не под ударами: ход по сетке не дерётся, 5 шагов под ифритами вплотную — 22.7 урона и смерть (s1-post17 06.10); ифрит без
    // луча к нам (тело в своём закрытом штреке под помостом) не мешает (s1-post18: 6 ифритов в 3–6 бл., все за стеной, 0 убийств);
    // тогда бой с места, а на помост — из основного цикла, когда рядом пусто.
    if (spawner && (bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) > SPAWNER_RANGE - 4 || offLevel() && !liveBlazes(bot, dead, 6).some(e => seesMe(bot, e)))) {
      // Издалека (спавнер из памяти за полкрепости) — отрезками и штреком
      // (nether.js walkToward): одним GoalNear pathfinder по Аду не находит.
      phase = 'путь к спавнеру'
      // Сетка копии мира есть — сперва ходом по ней на пол зала (цель fortress mode=spawner): с крыши крепости в 16 бл. над
      // спавнером pathfinder не спускался (s1-post03 06.10: walkNear 0 шагов, «точка боя none», 370 с без выстрела, ифриты в
      // 17–31 бл. — дальше BOW_MAX). Бой тактика здесь не рвёт (protectedEncounter blaze), так что ход доходит.
      const NR = require('./nether-route')
      if (NR.enabled() && NR.gridOf(session) && here === 'the_nether') {
        // Огнестойкость — до хода к помосту, а не после: на ходу шары ифритов жгли (s1-LB-5 06.10: «fireball:blaze» 6.3 урона за
        // 34 с хода, на помосте 5 хп → смерть).
        if (!hasEffect(bot, 'fire_resistance') && liveBlazes(bot, dead, 24).length) {
          const d0 = await drinkFireResistance(bot)
          for (let i = 0; i < 20 && d0 === 'выпил fire_resistance' && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
        }
        const rr = await NR.routeTo(session, ctl, { x: spawner.x, y: spawner.y, z: spawner.z, r: 2, dy: 0, solidFloor: true, frKeep: 2,
          // Без огнестойкости ход к помосту под шарами — горение и залпы без щита (s1c-L-2 06.10: 15 шарами и 17 огнём за 68 с хода,
          // смерть до боя): ифрит с лучом в 14 бл. — ход бросить, бой (радар, щит, коробка) с места.
          frNear: { x: spawner.x, y: spawner.y, z: spawner.z, r: 22 }, ironOk: true, abortNear: { re: '^blaze$', r: hasEffect(bot, 'fire_resistance') ? 4 : 14 },
          timeoutSeconds: Math.max(30, Math.min(180, Math.round((deadline - gameClock.now()) / 1000) - 60)) }).catch(e => ({ ok: false, why: e.message }))
        log('путь к спавнеру по сетке', { ok: rr.ok, why: rr.why, steps: rr.steps, dug: rr.dug, s: rr.seconds, at: xyz(bot.entity.position) })
      }
    }
    if (spawner && canApproachSpawner(bot, dead) && bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) > SPAWNER_RANGE - 4) {
      walked = bot.entity.position.distanceTo(spawner) > 32
        ? await require('./nether').walkToward(session, ctl, spawner, Math.min(deadline, gameClock.now() + 150000), { range: 7 })
        : await walkNear(bot, ctl, spawner, 7, Math.max(5000, Math.min(60000, deadline - gameClock.now())), { stopIf: () => !canApproachSpawner(bot, dead) })
    }

    // Место под стержни — до боя (рюкзак после хода по Аду бывает полон: стержень рядом не подбирается — B16f21 03.10).
    if (process.env.ND_NE_ROUTE !== '0') { try { await require('./nether-route').makeRoom(bot, 6) } catch {} }
    potion = await drinkFireResistance(bot)
    // Эффект приходит отдельным пакетом после глотка — до него «зелья нет», и
    // первый же шаг цикла уходил прятаться.
    if (potion === 'выпил fire_resistance') {
      for (let i = 0; i < 20 && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
    }

    // Only the running combat loop owns the hands; the preceding survey/path still needs tactical protection.
    session._blazeCombatCtl = ctl
    // Без огнестойкости бой не запрещён (ND_FR_STRICT убран 06.10, решение пользователя): holdSpawner ведёт его по механике ифрита.
    if (here === 'the_nether' && !hasEffect(bot, 'fire_resistance')) log('бой без огнестойкости', { potion, hp: Math.round(bot.health ?? 0) })
    // Яма (ND_BLAZE_HOLE=1) сама доходит до клетки у спавнера ходом по сетке, отбиваясь (holeCamp fightClose), — лагерь и с 9 бл.
    // (s1-post13camp 06.10: старт в 6–8 бл. — лагерь не включался, бой по-старому).
    if (process.env.ND_BLAZE_CAMP === '1' && spawner && !p.legacy && bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) <= (process.env.ND_BLAZE_HOLE === '1' ? 9 : 5.6)) {
      const { potionOf } = require('./pvp')
      const frN = bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
      let seen = false
      try { const b = bot.blockAt(spawner); seen = !!b && bot.canSeeBlock(b) } catch {}
      // Спавнер из памяти (карта) и мы в 5.6 бл. — лагерь и без луча к нему (стоим над ним на своих блоках).
      if ((seen || spawnerFrom === 'память') && (hasEffect(bot, 'fire_resistance') || frN > 0)) {
        phase = 'лагерь у спавнера'
        camp = await campSpawner(session, ctl, { spawner, want, deadline, dead, p, setPhase: s => { phase = s } })
        if (camp.stopped === 'набрал') stopped = null
      } else log('лагерь не начат', { seen, fr: hasEffect(bot, 'fire_resistance'), frN })
    }
    // Лагерь кончился без огнестойкости — дальше holdSpawner без неё (вылазки там под радаром залпов, не «по-старому»).
    if (camp && camp.inHole) { stopped = stopped || camp.stopped; bail = true }
    // ND_BLAZE_MELEE=1 — бой «мечом по месту» (blaze-melee.ts) вместо holdSpawner: бить того, кто в досягаемости, подходить к
    // видимому на высоте глаз, без коробки с окном; отлёжка — только когда вплотную никого.
    if (!bail && !p.legacy && spawner && !camp && process.env.ND_BLAZE_MELEE !== '0') {
      phase = 'бой мечом у спавнера'
      held = await require('./blaze-melee').meleeCamp(session, ctl, { spawner, want, deadline, dead, setPhase: s => { phase = s } })
      log('бой мечом', held)
      stopped = held.stopped === 'набрал' ? null : held.stopped
      bail = !!held.bail
      camp = held
    }
    if (!bail && !p.legacy && !(held && held.mode === 'melee') && !(camp && (camp.stopped === 'набрал' || /^хп/.test(camp.stopped)))) {
      // Бой по механике блейза (holdSpawner): щит под очереди, меч/лук между
      // ними, коробка на отдых. Старый цикл — legacy: true (для сравнения).
      phase = 'бой у спавнера'
      held = await holdSpawner(session, ctl, {
        spawner, want, deadline, dead, t0, p, ledger, kills,
        setPhase: s => { phase = s },
        restAt: clamp(p.restAtHealth ?? 12, 6, 18),
        bailAt: clamp(p.retreatAtHealth ?? 6, 3, 12),
        fireproof: false
      })
      stopped = held.stopped
      bail = held.bail
      if (held.dugIn) dugIn = held.dugIn
    }
    let idleSince = gameClock.now()
    while (p.legacy) {
      const have = countOf(bot, 'blaze_rod')
      const hp = Math.round(bot.health ?? 0)
      if (ctl.aborted) { stopped = 'прервано'; break }
      if (have >= want) break
      if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
      // Сначала отдых за углом, и только если его нет — конец боя.
      if (restsLeft > 0 && hp <= restAt) {
        restsLeft--
        phase = 'отдых'
        const r = await rest(session, ctl, dead)
        rests.push(r)
        log('отдых', r)
        if (r.rested) continue
        restsLeft = 0
      }
      if (hp <= retreatAt) { stopped = `хп ${hp} — дальше не дерусь (порог ${retreatAt})`; bail = true; break }
      if (highTimeouts >= 3) {
        stopped = 'блейз держится выше досягаемости меча, а бить издалека нечем: нужен лук со стрелами или снежки'
        break
      }
      // Автопилот в намерении не ест (autopilot.js bodyBusy) — ест бой сам,
      // между блейзами, пока шары не летят.
      if ((bot.food ?? 20) <= 14) {
        try {
          const r = await actions.eat(session, {})
          if (r && r.ate) ate.push(r.ate)
        } catch {}
      }

      // Больше двух видят нас — сначала укрытие, потом бой (замер (а): пять
      // блейзов разом сняли 20 хп за 24 с, и бот умер посреди второго боя).
      const watching = watchers(bot, dead)
      if (gameClock.now() - lastBeat > 2000) {
        lastBeat = gameClock.now()
        log('шаг', { t: Math.round((gameClock.now() - t0) / 1000), hp, watching, fire: !!(bot.entity.metadata && (bot.entity.metadata[0] & 1)), pos: xyz(bot.entity.position) })
      }
      // Под огнестойкостью шары не жгут вовсе (fireball в #is_fire) — прятаться
      // не от чего, опасен только удар в упор, и бой идёт в открытую.
      const fireproof = hasEffect(bot, 'fire_resistance')
      // Под зельем угол не нужен: иначе сторож «не гоняться из укрытия»
      // держал бы тело там вечно (прогон с зельем простоял 396 с при шести
      // видящих и не ударил ни разу).
      if (fireproof) anchor = null
      if (!fireproof && covers.length < 12 && watching >= 2 && gameClock.now() - coverFailAt > 15000) {
        phase = 'укрытие'
        const c = await takeCover(bot, ctl, dead)
        covers.push(c)
        log('укрытие', { watching, hp: Math.round(bot.health ?? 0), ...c })
        if (c.at) { coverAt = gameClock.now(); anchor = new Vec3(c.at.x, c.at.y, c.at.z); farSince = 0 } else { coverFailAt = gameClock.now(); coverFails++ }
        continue
      }
      // Трое и больше видят, укрыться не вышло дважды, а огнестойкости нет —
      // это не бой, а тир по нам: 4–5 блейзов в железе снимают 20 хп за 8 с
      // открытого стояния (замеры (а)). Уйти, пока хп есть, и сказать почему.
      // Или: укрыться только что не вышло, а видят трое — ждать второго отказа
      // значит стоять под очередями (прогон (г): 16 → 5 хп между отказами).
      if (!fireproof && watching >= 3 && (coverFails >= 2 || gameClock.now() - coverFailAt < 15000)) {
        stopped = `видят сразу ${watching} блейза, а укрыться не вышло — под перекрёстным огнём не стою. ` +
          'Нужна огнестойкость (зелье: бартер пиглинов или варка) или укрытие у спавнера — поставь блоки и позови снова'
        bail = true
        break
      }

      const blaze: any = nearestBlaze(bot, radius, skip.size ? new Set([...dead, ...skip]) : dead)
      if (!blaze) {
        if (droppedRods(bot, 12) > 0) {
          phase = 'сбор'
          await collectRods(bot, ctl, 12, 6000)
          continue
        }
        const idle = gameClock.now() - idleSince
        if (idle > (spawner ? 50000 : toured ? 30000 : 6000)) {
          stopped = spawner
            ? `спавнер молчит ${Math.round(idle / 1000)}с (блейзов в ${radius} бл. нет) — встань в 16 блоках от него на ${spawner.x},${spawner.y},${spawner.z}`
            : `блейзов в ${radius} блоках больше не вижу`
          break
        }
        phase = 'ожидание'
        await sleep(400)
        continue
      }
      idleSince = gameClock.now()
      // Только что ушли в укрытие и никого не видно — подождать, пока выйдут
      // из-за угла, а не гнаться pathfinder'ом обратно под огонь.
      if (!seesMob(bot, blaze) && gameClock.now() - coverAt < 6000) {
        await sleep(400)
        continue
      }
      // Ближайший за стеной, и мы не в укрытии — подойти, а не звать бой:
      // бой по невидимому отвечает «не видно — за стеной» сразу, и прогон 11
      // крутил так четырнадцать «боёв» подряд у крепости без спавнера.
      if (!seesMob(bot, blaze) && !anchor) {
        if (unseenWalks < 6) {
          unseenWalks++
          phase = 'к невидимому'
          await walkNear(bot, ctl, blaze.position.floored(), 6, 8000)
          continue
        }
        skip.add(blaze.id)
        unseenWalks = 0
        continue
      }
      unseenWalks = 0

      // Висит выше меча и видно — снежок, пока есть: 3 урона без сближения.
      const r = reachTo(bot, blaze)
      // Только один на один: стоя с поднятой рукой под тремя очередями, бот
      // сгорал с 20 до 10 хп за шестнадцать снежков (замер (а), третий прогон).
      if (r > SWORD_REACH + 0.3 && r <= SNOW_RANGE && watching <= 1 && itemNamed(bot, 'snowball') && seesMob(bot, blaze)) {
        const track = makeTrack(blaze)
        track.update()
        await sleep(100)
        track.update()
        phase = 'снежки'
        const s = await snowballAt(bot, blaze, track).catch(() => null)
        if (s && s.thrown) thrown++
        await sleep(200)
        continue
      }

      // Из укрытия за далёким не гоняться: погоня через всю комнату увела тело
      // на 15 блоков от угла, и обратный путь под двумя очередями стоил 11 хп
      // (замер (а), шестой прогон). Далёкого бьют лук и снежки; мечом — только
      // того, кто сам подлетел, или если ждать уже 15 с, а видит нас он один.
      if (anchor && blaze.position.distanceTo(anchor) > CHASE_FROM_COVER) {
        if (!farSince) farSince = gameClock.now()
        if (gameClock.now() - farSince < 15000 || watching > 1) {
          await sleep(400)
          continue
        }
      } else {
        farSince = 0
      }

      // Из укрытия без огнестойкости — на поводке: бой гнался за блейзом на 13
      // блоков от угла, и там тело увидели одиннадцать (try-blaze-rods (г),
      // 2026-09-25: смерть). Дальше LEASH от угла — бой обрывается, назад в угол.
      const sub = { aborted: false, onAbort: [] }
      const leash = gameClock.setInterval(() => {
        const far = anchor && !fireproof && bot.entity && bot.entity.position.distanceTo(anchor) > LEASH
        if ((ctl.aborted || far) && !sub.aborted) {
          sub.aborted = true
          for (const fn of sub.onAbort) { try { fn() } catch {} }
        }
      }, 150)
      phase = 'бой'
      const f = await combat.fight(session, sub, {
        // Именно этого, видимого (combat.findTarget «#id»). По имени бой брал
        // ближайшего вообще — за стеной — и уводил тело из укрытия под огонь
        // остальных: «blaze не видно — за стеной» дважды за прогон.
        target: '#' + blaze.id,
        purpose: 'resource',
        resourceGoal: { item: 'blaze_rod', count: want },
        allowRanged: p.allowRanged,
        clearArea: 0,
        retreatAtHealth: restsLeft > 0 ? restAt : retreatAt,
        // Короткий бой: погоня за одним выводит из укрытия под остальных, и
        // решение «где стоять» надо пересматривать чаще (второй бой того же
        // прогона — 20 → 11 хп при двух видящих).
        timeoutSeconds: 12,
        shield: p.shield || 'ranged'
      }).catch(e => ({ error: String(e.message || e) })).finally(() => gameClock.clearInterval(leash))
      if (sub.aborted && !ctl.aborted) f.leashed = true
      const brief = {
        killed: f.killed || (f.kills ? f.kills.join(', ') : undefined),
        swings: f.swings,
        arrows: f.arrows,
        hp: f.hp,
        why: f.leashed ? `поводок: дальше ${LEASH} бл. от укрытия не гонюсь` : (f.error || f.lost || f.stopped || (f.timeout ? 'время боя вышло' : undefined))
      }
      fights.push(brief)
      log('бой', { watching, ...brief })
      // «Не достал»: бой кончился по времени, а ни взмаха, ни стрелы не было.
      if ((f.timeout || (!brief.killed && /время/.test(brief.why || ''))) && !f.swings && !f.arrows) {
        highTimeouts++
      } else if (brief.killed) {
        highTimeouts = 0
      }
      if ((f.retreated || f.lowHealth) && restsLeft <= 0) { stopped = `отошёл: ${f.mode || f.why || 'мало хп'}`; break }
      phase = 'сбор'
      await collectRods(bot, ctl, 10, 5000)
      // Бой увёл от угла — назад, пока новые не набежали.
      if (anchor && bot.entity.position.distanceTo(anchor) > 5 && !ctl.aborted) {
        phase = 'назад в укрытие'
        await walkNear(bot, ctl, anchor, 0, 8000)
      }
    }
    // Бросая бой, не стоять под шарами: намерение кончится, а автопилот уводит
    // тело только ниже своего порога (autopilot fleeIfDying). Бег с оглядкой на
    // всех, кто рядом (flee.js smartFlee), до 12 с.
    // Набрал или бросаю бой, а ифриты с лучом рядом — в толщу на месте, а не бег под шарами.
    if (!ctl.aborted && !dugIn && here === 'the_nether' && (bot.health ?? 0) > 0 && liveBlazes(bot, dead, 10).some(e => seesMe(bot, e))) {
      phase = 'в толщу на месте'
      dugIn = await digInNear(bot, ctl).catch(e => ({ ok: false, why: e.message }))
      log('в толщу на месте', dugIn)
    }
    if (bail && !(dugIn && dugIn.ok) && !ctl.aborted && (watchers(bot, dead) > 0 || !survival.safeGround(bot))) {
      try {
        phase = 'бегство'
        if (!survival.safeGround(bot)) await survival.disengage(session, ctl, () => liveBlazes(bot, dead, 32))
        fled = await require('./flee').smartFlee(session, ctl, { timeoutMs: 12000, safeDist: 20, reason: 'блейзы' })
      } catch (e) { fled = { error: e.message } }
    }
    if (!ctl.aborted && !bail && !(dugIn && dugIn.ok)) await collectRods(bot, ctl, 12, 5000)
  } finally {
    bot.removeListener('entityDead', onDead)
    if (session._blazeCombatCtl === ctl) delete session._blazeCombatCtl
    bot.removeListener('entityGone', onGone)
    bot.removeListener('entityHurt', onHurt)
    ledger.stop()
    log('урон', { hp: Math.round(bot.health ?? 0), ...(ledger.report() || {}), last: ledger.hits.slice(-6) })
  }

  const rods = countOf(bot, 'blaze_rod')
  const gained = rods - rods0
  const left = droppedRods(bot, 12)
  const detail: any = {
    rods: { before: rods0, now: rods, gained, want },
    dugIn: dugIn && dugIn.ok ? dugIn : undefined,
    kills: kills.length,
    killsAt: kills.slice(0, 12),
    perKill: kills.length ? Math.round(gained / kills.length * 100) / 100 : null,
    fights: fights.slice(-8),
    snowballs: thrown ? { thrown, left: countOf(bot, 'snowball') } : undefined,
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    camp: camp || undefined,
    clearing: held?.clearing,
    safety: held?.safety,
    escape: held?.escape,
    damage: ledger.report(),
    ate: ate.length ? ate : undefined,
    rests: rests.length ? rests : (held && held.rests.length ? held.rests : undefined),
    doctrine: held ? { melee: held.melee, arrows: held.arrows, arrowsLeft: held.arrowsLeft, shieldSec: Math.round(held.shieldMs / 1000), bunker: held.bunker || undefined, sorties: held.sorties || undefined, foes: held.foes.length ? held.foes : undefined, shield: held.shield ? { blocked: held.shield.blocked, raises: held.shield.raises, hpUp: held.shield.hpUnderShield, hpOpen: held.shield.hpOpen } : undefined, shieldWear: held.shieldWear || undefined, balls: held.radar ? held.radar.balls : undefined } : undefined,
    covers: covers.length ? covers : undefined,
    fled: fled ? { mode: fled.mode, ran: fled.ran, from: fled.from } : undefined,
    potion: potion || undefined,
    spawner: undefined,
    walked: walked || undefined,
    toured: toured ? { hops: toured.hops.length, spawners: toured.spawners, seen: toured.seen, at: toured.at } : undefined,
    groundLeft: left || undefined,
    eyesPossible: countOf(bot, 'ender_eye') + countOf(bot, 'blaze_powder') + 2 * rods,
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  const places = (session.journal.state && session.journal.state.places) || {}
  if (places[SPAWNER_PLACE] && worlds.worldOfRecord(places[SPAWNER_PLACE]) === here) {
    const s = places[SPAWNER_PLACE]
    detail.spawner = { x: s.x, y: s.y, z: s.z }
  }
  if (rods < want) {
    detail.need = held && held.needArrows ? { what: 'arrow', count: 32, have: 0, for: 'blaze_rod' } : { what: 'blaze_rod', count: want - rods, have: rods }
    detail.stopped = `${stopped || 'встал'} — стержней ${rods} из ${want} (убил ${kills.length}, выпало ${gained}` +
      `${left ? `, ещё ${left} лежат рядом` : ''})`
  }
  detail.note = `Стержней +${gained} (теперь ${rods}), убито блейзов ${kills.length}` +
    (kills.length ? ` — по ${detail.perKill} на блейза (игра даёт 0 или 1, в среднем 0.5)` : '') +
    `. Хватит на ${detail.eyesPossible} око(в) при жемчуге. ` +
    (rods >= want ? 'Порошок: mc_craft item=blaze_powder (1 стержень = 2 порошка).' : 'Позови ещё раз у спавнера — он работает, пока я в 16 блоках.')
  return detail
}

module.exports = { drinkable, floorUnder, makeRadar, blazeEye, seesMe, fightMoves, droppedRods, collectRods, canApproachSpawner, walkNear, digInPlace, digInNear, pitWhyAt, choosePost, windowForPost, liveBlazes, sweepRisk, farmRods, rodsShort, bystanderOnLine, reachTo, nearestBlaze, visibleSpawner, boxRest, drinkFireResistance, hasEffect, EYES_WANTED, SPAWNER_PLACE }

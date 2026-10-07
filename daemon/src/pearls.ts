'use strict'
const gameClock = require('./game-clock')
// Жемчуг эндера: охота на эндерменов из укрытия и бартер с пиглинами (mc_pearls).
//
// Механика — байткод paper-1.21.11 (EnderMan, Mob.getAttackBoundingBox,
// PiglinAi, loot_table) — разобрано 2026-09-25:
//   * эндермен 40 хп, 0.6x2.9, глаза на 2.55. Злится, когда игрок смотрит ему
//     в ГЛАЗА: dot(взгляд, к его глазам) > 1 - 0.025/d, есть луч, дальше 64 не
//     ищет; тыква на голове спасает. Пока на него смотрят и он ближе 4 блоков —
//     телепортируется прочь; не смотрят и дальше 16 — прыгает к игроку.
//   * удар мечом игрока — полный урон и БЕЗ телепорта; снаряд (стрела, снежок) —
//     урона нет, он уходит телепортом. Вода и дождь жгут и гонят телепортом.
//   * досягаемость моба: его коробка, раздутая на 0.8283 по x/z и НИ НА СКОЛЬКО
//     по высоте, должна пересечь игрока: по оси дальше 1.43 — не достаёт. Но
//     голая яма не спасает: он в неё спрыгивает (см. digHideout). Держит штрек
//     высотой 2 в двух блоках от дна шахты: туда он (2.9) не влезает, а меч
//     достаёт его ноги в шахте.
//   * лут: ender_pearl 0..1, БЕЗ условия «убит игроком» — в среднем 0.5.
//   * бартер: только gold_ingot (PiglinAi.BARTERING_ITEM); взрослый пиглин берёт
//     брошенный слиток, если левая рука не занята любимым; разглядывает 119
//     тиков (~6 с) и бросает добычу к ближайшему видимому игроку. Жемчуг — вес 10
//     из 469 (2.1% за слиток), 2–4 штуки: ~15 слитков на жемчужину. Удар по
//     пиглину во время разглядывания срывает сделку и злит всех в 16 блоках.
//   * пиглин нейтрален, пока на игроке хоть ОДНА золотая вещь брони
//     (#piglin_safe_armor: golden_helmet/chestplate/leggings/boots).

const { goals } = require('mineflayer-pathfinder')
const { sleep, xyz, stuckGuard } = require('./movement')
const { itemNamed, countOf, countItems, diffItems, equipBestTool, missingHarvestTool, bestWeapon } = require('./items')
const { canSeePoint, eyePos } = require('./perception')
const { towerUp } = require('./build')
const worlds = require('./worlds')
const BF = require('./barter-flow')
const survival = require('./combat-safety')

const GOLD_ARMOR = ['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots']
const ARMOR_SLOT = { golden_helmet: 5, golden_chestplate: 6, golden_leggings: 7, golden_boots: 8 }
const DEST = { golden_helmet: 'head', golden_chestplate: 'torso', golden_leggings: 'legs', golden_boots: 'feet' }
const SWING_MS = 650
// Удар-вызов из окопа: спокойный эндермен до стольких блоков от ямы (ферма
// 29.09, foxhole-3 с радиусом 10: ни одного вызова за 4 прогона — в 10 блоках
// никого, а в 24 — от 1 до 7).
const POKE_R = 16
// Что эндермен уносит (tags/block/enderman_holdable 1.21.11, те, что бывают у ямы).
const HOLDABLE = /^(warped_nylium|crimson_nylium|grass_block|dirt|coarse_dirt|podzol|mycelium|rooted_dirt|moss_block|mud|sand|red_sand|gravel|clay|warped_roots|crimson_roots|warped_fungus|crimson_fungus)$/
// Кого обходить на охоте за жемчугом: спокойные эндермены нейтральны, а обход
// всех враждебных делал клетки леса «дорогими» — путь к месту окопа выходил
// partial (ферма 29.09).
const FOX_AVOID = new Set(['hoglin', 'zoglin', 'piglin_brute', 'ghast', 'magma_cube', 'blaze', 'wither_skeleton', 'skeleton', 'creeper', 'zombie', 'husk', 'spider', 'witch', 'slime'])
const ADMIRE_MS = 119 * 50

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
const log = (what, o) => console.log('[pearls]', what, JSON.stringify(o))

function meta (bot, e, key) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys.indexOf(key)
    return i >= 0 ? e.metadata[i] : undefined
  } catch { return undefined }
}

const seesMob = (bot, e, frac = 0.55) => canSeePoint(bot, e.position.offset(0, (e.height || 1.8) * frac, 0))
// S1f (аудит S10 №20): эндермены, зомби-пиглины и прочие в решениях охоты — только известные телу (видимые/слышимые: eyes.knownEntities).
const ents = (bot): any[] => require('./perception/eyes').knownEntities(bot)

// xz — цель по горизонтали (GoalNearXZ): жемчуг на крыше окопа (на 2 выше пола) GoalNear(…, 0) не достигался никогда.
async function walkTo (bot, ctl, target, range, ms, stopIf = null, xz = false) {
  const guard = stuckGuard(bot, ctl, 8000)
  let timer = null
  let poll = null
  try {
    await Promise.race([
      bot.pathfinder.goto(xz ? new goals.GoalNearXZ(target.x, target.z, range) : new goals.GoalNear(target.x, target.y, target.z, range)),
      guard.promise,
      new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), Math.max(500, ms)) }),
      new Promise<any>((_resolve, reject) => { if (stopIf) poll = gameClock.setInterval(() => { try { if (stopIf()) reject(new Error('опасность рядом')) } catch {} }, 250) })
    ])
    return { ok: true }
  } catch (e) {
    try { bot.pathfinder.setGoal(null) } catch {}
    return { ok: false, error: e.message }
  } finally {
    guard.stop()
    if (timer) gameClock.clearTimeout(timer)
    if (poll) gameClock.clearInterval(poll)
  }
}

async function pickUp (bot, ctl, radius, ms) {
  const { collectNearbyDrops } = require('./actions')
  return collectNearbyDrops(bot, ctl, { radius, timeoutMs: ms })
}

// ------------------------------------------------------------------ hunt

// Укрытие буквой «Г»: шахта 1x1 в три блока и штрек 1x2 в два блока от её дна.
// Просто яма не держит: pathfinder моба считает клетку ямы проходимой (над ней
// небо, высоты хватает), эндермен спрыгивает в неё прямо на бота и бьёт
// (прогон 2026-09-25: «NeuroNether was slain by Enderman» из ямы в 2 блока).
// В штрек высотой 2 он (2.9) не влезает, со дна шахты до бота 2 блока —
// дальше его 1.43 по оси; меч от глаз до его коробки достаёт на 1.7.
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]]

async function digCell (bot, mcData, c) {
  const b = bot.blockAt(c)
  if (!b) return 'мир не прогружен'
  if (b.boundingBox === 'empty' && !/lava|water/.test(b.name)) return null
  if (/lava|water/.test(b.name) || b.name === 'bedrock') return `на пути ${b.name}`
  const problem = missingHarvestTool(bot, b, mcData)
  if (problem) return problem
  try { await equipBestTool(bot, b); await bot.dig(b) } catch (e) { return e.message }
  return null
}

function hazardNear (bot, c) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = bot.blockAt(c.offset(dx, dy, dz))
        if (b && /lava|water/.test(b.name)) return b.name
      }
    }
  }
  return null
}

async function stepInto (bot, cell) {
  const target = cell.offset(0.5, 0, 0.5)
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 2000 && bot.entity.position.floored().distanceTo(cell) >= 0.5) {
      await bot.lookAt(target.offset(0, 1.6, 0), true)
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false) }
  await sleep(250)
  return bot.entity.position.floored().equals(cell)
}

// План норы ДО того, как злить (лаборатория 2026-09-27, прогон 2: злой
// эндермен пришёл, пока тело искало, куда копать штрек, — «slain by Enderman»
// за 22 с). Шахта глубиной 3 (или 4, если на 3 потолка штрека нет): клетки
// шахты — твёрдые, копаемые, без жидкости рядом; штрек 2 клетки в сторону —
// копаемые или воздух, над обеими твёрдый потолок. null — здесь норы не будет.
function solidAt (bot, p) { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' }
function diggable (bot, mcData, p) {
  const b = bot.blockAt(p)
  if (!b) return false
  if (b.boundingBox === 'empty') return !/lava|water/.test(b.name)
  if (b.name === 'bedrock' || /lava|water/.test(b.name)) return false
  return !missingHarvestTool(bot, b, mcData)
}
function hideoutPlan (bot, mcData, top = bot.entity.position.floored()) {
  for (const depth of [3, 4]) {
    let ok = true
    for (let i = 1; i <= depth && ok; i++) {
      const c = top.offset(0, -i, 0)
      if (!solidAt(bot, c) || !diggable(bot, mcData, c) || hazardNear(bot, c)) ok = false
    }
    // Под дном шахты — пол (иначе провалимся дальше).
    if (!ok || !solidAt(bot, top.offset(0, -depth - 1, 0))) continue
    const shaft = top.offset(0, -depth, 0)
    for (const [dx, dz] of CARDINAL) {
      const t1 = shaft.offset(dx, 0, dz)
      const t2 = shaft.offset(2 * dx, 0, 2 * dz)
      if (!solidAt(bot, t1.offset(0, 2, 0)) || !solidAt(bot, t2.offset(0, 2, 0))) continue
      if (!solidAt(bot, t1.offset(0, -1, 0)) || !solidAt(bot, t2.offset(0, -1, 0))) continue
      if (hazardNear(bot, t1) || hazardNear(bot, t2)) continue
      if (![t1, t1.offset(0, 1, 0), t2, t2.offset(0, 1, 0)].every(c => diggable(bot, mcData, c))) continue
      return { top, depth, dir: [dx, dz] }
    }
  }
  return null
}

async function digHideout (bot, ctl, mcData, plan = null) {
  // Встать в середину клетки: с края тело держится на соседнем блоке и в
  // выкопанную под собой яму не падает (лаборатория 2026-09-27: «шахта вышла
  // глубиной 0/1» три вызова подряд).
  try { await require('./fortify').centerInCell(bot, 900) } catch {}
  const top = bot.entity.position.floored()
  const depth = plan && plan.top.equals(top) ? plan.depth : 3
  // Шахта: три (четыре) блока вниз, тело падает само.
  for (let i = 0; i < depth && !ctl.aborted; i++) {
    const feet = bot.entity.position.floored()
    const h = hazardNear(bot, feet.offset(0, -1, 0))
    if (h) return { ok: false, why: `рядом ${h} — укрытие тут не копаю` }
    const err = await digCell(bot, mcData, feet.offset(0, -1, 0))
    if (err) return { ok: false, why: err }
    await sleep(450)
  }
  const shaft = bot.entity.position.floored()
  if (top.y - shaft.y < 3) return { ok: false, why: `шахта вышла глубиной ${top.y - shaft.y}` }
  // Штрек: сторона, где над обеими клетками твёрдый потолок и нет жидкостей;
  // сторона из плана — первой.
  const dirs = plan && plan.top.equals(top) ? [plan.dir, ...CARDINAL.filter(d => d[0] !== plan.dir[0] || d[1] !== plan.dir[1])] : CARDINAL
  for (const [dx, dz] of dirs) {
    const t1 = shaft.offset(dx, 0, dz)
    const t2 = shaft.offset(2 * dx, 0, 2 * dz)
    const roof1 = bot.blockAt(t1.offset(0, 2, 0))
    const roof2 = bot.blockAt(t2.offset(0, 2, 0))
    if (!roof1 || !roof2 || roof1.boundingBox !== 'block' || roof2.boundingBox !== 'block') continue
    if (hazardNear(bot, t1) || hazardNear(bot, t2)) continue
    let err = null
    for (const c of [t1.offset(0, 1, 0), t1, t2.offset(0, 1, 0), t2]) {
      err = await digCell(bot, mcData, c)
      if (err) break
    }
    if (err) continue
    if (!(await stepInto(bot, t1)) || !(await stepInto(bot, t2))) continue
    // Лицом к шахте — оттуда придёт.
    try { await bot.lookAt(shaft.offset(0.5, 0.3, 0.5), true) } catch {}
    return { ok: true, shaft, stand: t2, top }
  }
  return { ok: false, why: 'штрек от дна шахты вбок не вышел ни в одну сторону (нет потолка или жидкость рядом)', shaft }
}

// Назад: к дну шахты и столбом наверх (порода из шахты и штрека — в рюкзаке).
async function climbOut (bot, ctl, hide) {
  if (!hide) return { ok: true }
  if (!bot.entity.position.floored().equals(hide.shaft)) {
    const t1 = hide.shaft.plus(hide.stand.minus(hide.shaft).scaled(0.5)).floored()
    await stepInto(bot, t1)
    await stepInto(bot, hide.shaft)
  }
  const r = await towerUp(bot, ctl, hide.top.y - bot.entity.position.floored().y)
  return { ok: bot.entity.position.floored().y >= hide.top.y, placed: r.placed, why: r.reason }
}

// Злится он на взгляд в ГЛАЗА (EnderMan.isBeingStaredBy → hasLineOfSight от
// глаз к глазам): в лесу у большинства глаза за ножкой гриба. Первыми — те,
// чьи глаза видно и кто дальше 5 блоков; потом видимые телом; потом ближние.
// Луч без поблажек: perception.raySees считает видимым всё, во что луч упёрся
// ближе 1.2 блока к цели, а сервер (Entity.hasLineOfSight, COLLIDER) — нет:
// лабораторный прогон 5 — 76 взглядов «в глаза» у ножки гриба, злости ноль.
function clearRay (bot, a, b) {
  const d = b.minus(a)
  const dist = d.norm()
  if (dist < 0.3) return true
  try {
    const hit = bot.world.raycast(a, d.scaled(1 / dist), dist - 0.05, x => x && x.boundingBox !== 'empty')
    if (hit && (clearRay.stats = clearRay.stats || {})) { const k = hit.name; clearRay.stats[k] = (clearRay.stats[k] || 0) + 1 }
    return !hit
  } catch (err) { if (!clearRay.warned) { clearRay.warned = true; log('raycast', { error: err.message }) } return false }
}
declare namespace clearRay {
  let stats: Record<string, any>
  let warned: boolean
}

const eyesSeen = (bot, e) => clearRay(bot, bot.entity.position.offset(0, 1.62, 0), e.position.offset(0, 2.55, 0))

// Луч из o по dir (единичный) — расстояние входа в коробку min..max или null.
function rayBoxEntry (o, dir, min, max) {
  let t0 = 0; let t1 = Infinity
  for (const ax of ['x', 'y', 'z']) {
    if (Math.abs(dir[ax]) < 1e-9) { if (o[ax] < min[ax] || o[ax] > max[ax]) return null; continue }
    let ta = (min[ax] - o[ax]) / dir[ax]; let tb = (max[ax] - o[ax]) / dir[ax]
    if (ta > tb) { const t = ta; ta = tb; tb = t }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb)
    if (t0 > t1) return null
  }
  return t0
}

// Куда смотреть, чтобы бить эндермена и не смотреть ему в глаза. EnderMan.
// isBeingStaredBy = isLookingAtMe(player, 0.025, scaleByDistance, COLLIDER,
// eyeY): взгляд ближе угла acos(1 − 0.025/d) к его оси на высоте глаз (2.55) —
// «в глаза», и злой ближе 4 блоков телепортируется прочь
// (EndermanLookForPlayerGoal.tick). Сверху (со столба) ноги закрыты краем
// своего блока, а торс — в 5–9° от глаз: берём точку коробки, где луч чист,
// вход в коробку ≤ 3.0 (честная дальность удара) и угол от глаз с запасом 3°.
function safeAim (bot, em) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const w = (em.width || 0.6) / 2
  const h = em.height || 2.9
  const min = { x: em.position.x - w, y: em.position.y, z: em.position.z - w }
  const max = { x: em.position.x + w, y: em.position.y + h, z: em.position.z + w }
  const ax = em.position.offset(0, 2.55, 0).minus(eye)
  const al = ax.norm() || 1
  const limit = Math.acos(Math.max(-1, 1 - 0.025 / al)) * 180 / Math.PI + 3
  let best = null
  for (const y of [2.1, 1.7, 1.3, 0.9, 0.5, 0.2]) {
    for (const [ox, oz] of [[0, 0], [w * 0.8, 0], [-w * 0.8, 0], [0, w * 0.8], [0, -w * 0.8]]) {
      const pt = em.position.offset(ox, y, oz)
      const v = pt.minus(eye)
      const d = v.norm()
      if (d < 0.1) continue
      const dir = v.scaled(1 / d)
      const tIn = rayBoxEntry(eye, dir, min, max)
      if (tIn === null || tIn > 3.0) continue
      const deg = Math.acos(Math.max(-1, Math.min(1, (v.x * ax.x + v.y * ax.y + v.z * ax.z) / (d * al)))) * 180 / Math.PI
      if (deg < limit) continue
      if (!clearRay(bot, eye, eye.plus(dir.scaled(Math.max(0, tIn - 0.02))))) continue
      if (!best || deg > best.deg) best = { pt, deg: Math.round(deg), tIn: Math.round(tIn * 10) / 10 }
    }
  }
  return best
}
function nearestEnderman (bot, radius, dead) {
  const me = bot.entity.position
  // Ближние (6..20) приходят к шахте за секунды; с 30 блоков злой шёл дольше
  // 30 с ожидания (лаборатория, прогон 6).
  const rank = e => { const d = e.position.distanceTo(me); const eyes = eyesSeen(bot, e); return (eyes && d >= 6 && d <= 20 ? 4 : eyes && d > 5 ? 2 : 0) + (seesMob(bot, e) ? 1 : 0) }
  return ents(bot)
    .filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id) && e.position.distanceTo(me) <= radius)
    .map((e : any) => ({ e, r: rank(e), d: e.position.distanceTo(me) }))
    .sort((a, b) => (b.r - a.r) || (a.d - b.d))
    .map(x => x.e)[0] || null
}

// От глаз до ближайшей точки его коробки.
function reachTo (bot, e) {
  const eye = eyePos(bot)
  const w = (e.width || 0.6) / 2
  const h = e.height || 2.9
  const p = e.position
  const cx = clamp(eye.x, p.x - w, p.x + w)
  const cy = clamp(eye.y, p.y, p.y + h)
  const cz = clamp(eye.z, p.z - w, p.z + w)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

// Пройтись в поисках: связанная клетка в dist блоках (walkable).
async function searchWalk (bot, ctl, dist = 16, stopIf = null, { high = false }: any = {}) {
  const { walkable } = require('./walkable')
  const nodes = walkable(bot, bot.entity.position, { radius: dist + 4, maxNodes: 3000 })
  const me = bot.entity.position
  const far = nodes.filter(n => { const d = Math.hypot(n.pos.x - me.x, n.pos.z - me.z); return d >= dist * 0.6 && d <= dist + 4 })
  if (!far.length) {
    // Ощупью некуда (яма, остатки коробки) — pathfinder с копанием, 16 блоков в
    // случайную сторону.
    const a = Math.random() * Math.PI * 2
    const tx = Math.round(me.x + Math.sin(a) * dist); const tz = Math.round(me.z + Math.cos(a) * dist)
    const w = await require('./movement').travelXZ(bot, ctl, tx, tz, { range: 3, retries: 1, deadline: gameClock.now() + 20000 })
    return { x: tx, z: tz, ok: w.ok, blind: true }
  }
  // high — на возвышенность (верхняя четверть по высоте): с гребня видно глаза,
  // из низины — нет (прогоны 41–43: 20 эндерменов в 6..28 и ни у одного не
  // видно глаз, тело сползло к лавовому морю, y 40).
  let pool = far
  if (high && far.length > 4) {
    const ys = far.map(n => n.pos.y).sort((a, b) => b - a)
    const cut = ys[Math.floor(ys.length / 4)]
    pool = far.filter(n => n.pos.y >= cut)
  }
  const pick = pool[Math.floor(Math.random() * pool.length)].pos
  const w = await walkTo(bot, ctl, pick, 1, 15000, stopIf)
  return { ...xyz(pick), ok: w.ok, why: w.ok ? undefined : w.error }
}

// Лава в клетке предмета или вокруг (за жемчугом у лавы не ходить).
function lavaAround (bot, pos) {
  const c = pos.floored()
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 0; dy++) for (let dz = -1; dz <= 1; dz++) {
    const b = bot.blockAt(c.offset(dx, dy, dz))
    if (b && /lava/.test(b.name)) return true
  }
  return false
}

// Бой с эндерменом без норы: смотреть в тело, не в глаза (взгляд в глаза
// ближе 4 блоков — телепорт, EndermanLookForPlayerGoal), меч по перезарядке,
// щит между ударами (его удар в щит отбрасывает его самого).
async function openFight (session, ctl, em, { retreatAt = 8, dead, maxMs = 25000 }: any = {}) {
  const bot = session.bot
  const combat = require('./combat')
  const guard = combat.makeShield(session, ctl, { shield: 'ranged' })
  const safety = survival.watch(bot)
  const t0 = gameClock.now()
  let swings = 0
  let last = 0
  let blocks = 0
  let blockAt = 0
  const hp0 = Math.round(bot.health ?? 20)
  // Его взмах (MeleeAttackGoal: swing, удар, перезарядка 20 тиков) — окно для
  // нашего удара: секунда, пока он не бьёт. Звук блока щитом до бота не доходит.
  let hisSwings = 0
  let stale = false
  let crowd = false
  let retargets = 0
  const onSwing = e => { if (e && e.id === em.id) { blockAt = gameClock.now(); hisSwings++ } }
  bot.on('entitySwingArm', onSwing)
  try {
    const w = bestWeapon(bot)
    if (w) { try { await bot.equip(w, 'hand') } catch {} }
    await guard.wear()
    let lastNear = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t0 < maxMs && em.isValid !== false && !dead.has(em.id)) {
      const risk = safety.check({ target: em, entities: ents(bot).filter((e : any) =>
        e?.name === 'enderman' && e.isValid !== false && !dead.has(e.id) && meta(bot, e, 'creepy')),
      minHealth: Math.max(8, retreatAt) })
      if (risk.action !== 'fight') break
      // Двое злых в 6 блоках — на земле не выстоять (двойник мира прохождения,
      // 2026-09-28: 20 → 1.8 хп за 15 с от двоих); выйти — дальше столб.
      if (ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < 6).length >= 2) { crowd = true; break }
      // Злой, что 8 с не подходит ближе 8 блоков (застрял), — не ждать 40 с
      // (прогон 48: три боя по 40 с без единого взмаха).
      {
        const closer = ents(bot).filter((e : any) => e && e.name === 'enderman' && e !== em && e.position && e.isValid !== false && !dead.has(e.id) && meta(bot, e, 'creepy') && reachTo(bot, e) <= 3.2)
          .sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
        if (closer && reachTo(bot, closer) + 0.5 < reachTo(bot, em)) { em = closer; retargets++ }
      }
      if (reachTo(bot, em) <= 8) lastNear = gameClock.now()
      else if (gameClock.now() - lastNear > 8000) { stale = true; break }
      const body = em.position.offset(0, 1.0, 0)
      try { await bot.lookAt(body, true) } catch {}
      const r = reachTo(bot, em)
      // Взмах — сразу после его удара в щит (звук блока): у него перезарядка
      // 20 тиков, наш щит снова держит через 5. Или если он молчит 1.5 с.
      if (guard.stats.blocked > blocks) { blocks = guard.stats.blocked; blockAt = gameClock.now() }
      const window = gameClock.now() - blockAt < 700 || gameClock.now() - Math.max(last, t0) > 1500
      if (r <= 3.0 && gameClock.now() - last >= SWING_MS && window) {
        await guard.raise(false)
        try { bot.attack(em); swings++; last = gameClock.now() } catch {}
      } else if (r <= 5) {
        await guard.raise(true)
      } else if (r <= 8 && Math.abs(em.position.y - bot.entity.position.y) <= 2) {
        await guard.raise(false)
        try { bot.pathfinder.setGoal(new goals.GoalFollow(em, 1.5), true) } catch {}
      } else {
        // Далеко или ниже/выше обрыва — не бегать за ним (прогон 40: бой увёл
        // тело к лавовому морю, y 38): злой придёт сам.
        try { bot.pathfinder.setGoal(null) } catch {}
        await guard.raise(false)
      }
      await sleep(60)
    }
  } finally {
    safety.close()
    bot.removeListener('entitySwingArm', onSwing)
    try { bot.pathfinder.setGoal(null) } catch {}
    try { await guard.raise(false) } catch {}
    guard.close()
  }
  return { killed: dead.has(em.id), target: em, retargets, stale, crowd, swings, hisSwings, blocked: guard.stats.blocked, hp: `${hp0} -> ${Math.round(bot.health ?? 0)}`, seconds: Math.round((gameClock.now() - t0) / 1000) }
}

// ------------------------------------------------------------ hunt: столб
// Лаборатория этапов (2026-09-27, искажённый лес Ада у 0,0 server-nether):
// нора «шахта + штрек» в 6 раундах из 6 не дождалась злого эндермена — к
// шахте он не идёт (30 с ожидания, с 4 и с 12 блоков), а место под нору в
// лесу с карманами лавы находилось через раз. Столб в 3 блока:
//   * Mob.getAttackBoundingBox раздувает его коробку на 0.83 только по
//     горизонтали: с земли у столба (рост 2.9) до наших ног (+3) не хватает
//     0.1 — ударить не может, если вокруг столба нет ступеньки выше подножия;
//   * путь к нам MeleeAttackGoal не находит и ведёт к ближайшей клетке —
//     подножию столба; меч сверху достаёт его голову (1.7 от глаз);
//   * смотреть ему в ноги, не в глаза: взгляд в глаза ближе 4 блоков —
//     телепорт (EndermanLookForPlayerGoal), в ноги с высоты — 12° мимо конуса.
// Высота столба для этой клетки (0 — нельзя). Самая высокая поверхность у
// соседей s (блок на уровне подножия — s = 1): столб h должен поднять ноги
// выше его макушки (s + 2.9) — h >= s + 3; меч сверху достаёт макушку того,
// кто стоит на подножии, только с h <= 4 (глаза на h + 1.62, до макушки 2.9 —
// не больше 2.8 по вертикали). Над подножием — h + 2 клетки воздуха.
function pillarSpot (bot, feet, why = null) {
  const lava = bot.registry.blocksByName.lava.id
  const solid = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'block' }
  const liquid = q => { const b = bot.blockAt(q); return !!b && /lava|water/.test(b.name) }
  const no = k => { if (why) why[k] = (why[k] || 0) + 1; return 0 }
  if (!solid(feet.offset(0, -1, 0))) return no('floor')
  let s = 0
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      for (let y = 4; y >= 0; y--) if (solid(feet.offset(dx, y, dz))) { s = Math.max(s, y + 1); break }
    }
  }
  const h = s + 3
  if (h > 5) return no('high')
  for (let y = 0; y <= h + 1; y++) { const b = bot.blockAt(feet.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || liquid(feet.offset(0, y, 0))) return no('air') }
  for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) {
    const b = bot.blockAt(feet.offset(dx, dy, dz))
    if (b && b.type === lava) return no('lava')
  }
  return h
}

async function pillarUp (bot, ctl, opts: any = {}) {
  const { walkable } = require('./walkable')
  let feet = bot.entity.position.floored()
  let h = 0
  {
    // Место, откуда с вершины видно глаза эндерменов (6..24 блока) — в лесу
    // их закрывают ножки грибов и край обрыва: лаборатория, прогон 10 — 20
    // эндерменов в 48 блоках, ни одного с видимыми глазами со столба.
    const nodes = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 6000 })
    const ems = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !(opts.skip && opts.skip.has(e.id)) && !trappedEm(bot, e))
    let best = null
    let checked = 0
    const why = { nodes: nodes.length }
    for (const n of nodes) {
      const hh = pillarSpot(bot, n.pos, why)
      if (!hh) continue
      if (++checked > 250) break
      const eye = n.pos.offset(0.5, hh + 1.62, 0.5)
      let seen = 0
      for (const e of (ems as any)) {
        const d = e.position.distanceTo(eye)
        if (d < 6 || d > 24) continue
        if (clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++
      }
      const score = seen * 10 - n.d * 0.3 + (hh === 3 ? 2 : 0)
      if (!best || score > best.score) best = { pos: n.pos, h: hh, seen, score }
    }
    const spot = best ? { pos: best.pos } : null
    if (best && best.pos.equals(feet)) { h = best.h }
    else if (spot) {
    // (дальше — дойти до места)
    h = pillarSpot(bot, spot.pos)
    const wk = await walkTo(bot, ctl, spot.pos, 0, 15000, opts.stopIf)
    if (!wk.ok && opts.stopIf && opts.stopIf()) return { ok: false, danger: true, why: 'злой рядом — столб прямо здесь' }
    if (!bot.entity.position.floored().equals(spot.pos)) await stepInto(bot, spot.pos)
    feet = bot.entity.position.floored()
    // Встал рядом — годится и эта клетка, если столб на ней выходит.
    if (!feet.equals(spot.pos)) {
      const here = pillarSpot(bot, feet)
      if (!here) return { ok: false, why: 'до места под столб не дошёл' }
      h = here
    }
    }
    if (!spot) return { ok: false, why: `места под столб (соседи не выше подножия+2, над ним 5-7 блоков воздуха, лавы в 3 нет) рядом нет: ${JSON.stringify(why)}` }
    if (best) log('место под столб', { at: xyz(best.pos), h: best.h, eyesSeen: best.seen, checked })
  }
  try { await require('./fortify').centerInCell(bot, 900) } catch {}
  // Кто дойдёт до подножия ногами (злить только их: лаборатория — злой
  // застревал ниже обрыва в 5 блоках и стоял там полминуты).
  let reach = null
  try { reach = endermanReach(bot, bot.entity.position.floored()) } catch (e) { log('заливка', { error: e.message }) }
  const r = await towerUp(bot, ctl, h)
  const top = bot.entity.position.floored()
  return { ok: top.y - feet.y >= h, base: feet, top, h, reach, placed: r.placed, why: r.reason }
}

// Эндермен в яме: ни в одну из четырёх сторон не шагнуть (ровно или на блок
// вверх, три клетки воздуха над новой опорой). Прогон 30: четверо в старой
// шахте прошлых прогонов — глаза видно со столба, прийти не могут, и место
// под столб выбиралось по ним.
function trappedEm (bot, e) {
  const f = e.position.floored()
  const empty = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/lava/.test(b.name) }
  for (const [dx, dz] of CARDINAL) {
    const n = f.offset(dx, 0, dz)
    if (empty(n) && empty(n.offset(0, 1, 0)) && empty(n.offset(0, 2, 0))) return false
    if (empty(n.offset(0, 1, 0)) && empty(n.offset(0, 2, 0)) && empty(n.offset(0, 3, 0)) && empty(f.offset(0, 3, 0))) return false
  }
  return true
}

// Откуда злой эндермен дойдёт до подножия столба: обратная заливка от
// подножия. Он шагает на блок вверх/вниз (шаг 1.0) и прыгает с обрыва — у моба
// с целью getMaxFallDistance = 3 + (хп − 33% макс.) − 4·(3 − сложность): у
// эндермена на normal до 25 блоков. Значит в обратную сторону: соседняя клетка
// на −1..+1, или выше на сколько угодно (до 12), если над нашей клеткой в её
// сторону — воздух до его головы. Рост 2.9 — три клетки воздуха.
// (Прогон 28: обычная заливка «куда дойду я» не пускала ни одного из 5
// видимых — все стояли выше подножия.)
function endermanReach (bot, base, { radius = 26, maxNodes = 5000 }: any = {}) {
  const key = q => `${q.x},${q.y},${q.z}`
  const empty = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
  const floor = q => { const b = bot.blockAt(q.offset(0, -1, 0)); return !!b && b.boundingBox === 'block' && !/magma|lava/.test(b.name) }
  const stand3 = q => floor(q) && empty(q) && empty(q.offset(0, 1, 0)) && empty(q.offset(0, 2, 0))
  const seen = new Set([key(base)])
  const out = [base]
  const r2 = radius * radius
  for (let i = 0; i < out.length && out.length < maxNodes; i++) {
    const L = out[i]
    for (const [dx, dz] of CARDINAL) {
      const x = L.x + dx; const z = L.z + dz
      if ((x - base.x) ** 2 + (z - base.z) ** 2 > r2) continue
      // Над нашей клеткой L воздух до какой высоты (для прыжка оттуда вниз).
      for (let dy = -1; dy <= 12; dy++) {
        const H = L.offset(dx, dy, dz)
        if (seen.has(key(H))) continue
        if (!stand3(H)) continue
        if (dy >= 2) {
          let clear = true
          for (let y = L.y + 3; y <= H.y + 2 && clear; y++) if (!empty(L.offset(0, y - L.y, 0))) clear = false
          if (!clear) continue
        } else if (dy === 1) {
          if (!empty(L.offset(0, 3, 0))) continue
        } else if (dy === -1) {
          if (!empty(H.offset(0, 3, 0))) continue
        }
        seen.add(key(H))
        out.push(H)
      }
    }
  }
  return seen
}

// Столб прямо здесь — злой рядом (место не выбираем): 3 блока, если над
// головой 5 клеток воздуха (или сколько велит pillarSpot при соседях выше).
async function emergencyPillar (bot, ctl) {
  const feet = bot.entity.position.floored()
  let h = pillarSpot(bot, feet)
  if (!h) {
    let ok = true
    for (let y = 0; y <= 4; y++) { const b = bot.blockAt(feet.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || /lava|water/.test(b.name)) ok = false }
    h = ok ? 3 : 0
  }
  if (!h) return { ok: false, why: 'над головой нет места под столб' }
  try { await require('./fortify').centerInCell(bot, 600) } catch {}
  const r = await towerUp(bot, ctl, h)
  const top = bot.entity.position.floored()
  return { ok: top.y - feet.y >= h, base: feet, top, h, reach: null, placed: r.placed, why: r.reason, emergency: true }
}

// Вниз со столба: копать под собой (блоки назад в рюкзак).
async function pillarDown (bot, ctl, mcData, base) {
  for (let i = 0; i < 4 && !ctl.aborted; i++) {
    const feet = bot.entity.position.floored()
    if (feet.y <= base.y) break
    const err = await digCell(bot, mcData, feet.offset(0, -1, 0))
    if (err) return { ok: false, why: err }
    await sleep(350)
  }
  return { ok: bot.entity.position.floored().y <= base.y }
}

async function huntPillar (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const radius = clamp(p.radius ?? 40, 8, 64)
  const pearls0 = countOf(bot, 'ender_pearl')
  const want = pearls0 + Math.max(1, p.count ?? 4)
  const hp0 = Math.round(bot.health ?? 20)
  const retreatAt = clamp(p.retreatAtHealth ?? 8, 3, 16)
  const kills = []
  const dead = new Set()
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'enderman') hurtAt.set(e.id, gameClock.now()) }
  const onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || dead.has(e.id) || !e.position) return
    if (e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    dead.add(e.id)
    kills.push({ at: xyz(e.position), t: Math.round((gameClock.now() - t0) / 1000) })
  }
  const onGone = e => onDead(e, 'gone')
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  const rounds = []
  const skip = new Set()
  let stopped = null
  let pillar = null
  let fails = 0
  let searches = 0
  const weapon = bestWeapon(bot)
  const onTop = () => pillar && bot.entity.position.floored().y >= pillar.base.y + (pillar.h || 3)
  const angryClose = r => ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < r)
  // Уже стою на своём столбе (прошлый вызов оборвали): столб — это он.
  {
    const f = bot.entity.position.floored()
    const solid = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'block' }
    const bare = q => [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => !solid(q.offset(dx, 0, dz)))
    if (solid(f.offset(0, -1, 0)) && solid(f.offset(0, -2, 0)) && solid(f.offset(0, -3, 0)) && bare(f.offset(0, -1, 0)) && bare(f.offset(0, -2, 0))) {
      pillar = { base: f.offset(0, -3, 0), top: f, reused: true }
    }
  }
  try {
    while (!ctl.aborted) {
      if (countOf(bot, 'ender_pearl') >= want) break
      if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
      // На столбе хп мало — есть и ждать наверху (с земли злой не достаёт).
      if (onTop() && (bot.health ?? 20) < 14) {
        if ((bot.food ?? 20) < 20) { try { await require('./actions').eat(session, {}) } catch {} }
        try { await bot.look(bot.entity.yaw, -1.5, true) } catch {}
        await sleep(1000)
        continue
      }
      if (!onTop() && (bot.health ?? 20) <= retreatAt && !angryClose(16)) { stopped = `хп ${Math.round(bot.health)} — дальше не охочусь`; break }
      if ((bot.food ?? 20) <= 16) { try { await require('./actions').eat(session, {}) } catch {} }
      // 1. На столб. Злой рядом — столб прямо здесь (прогон 27: злой, которого
      // разозлил взгляд на ходу, убил тело за 19 с, пока оно шло к месту).
      if (!onTop()) {
        let up: any = angryClose(12) ? await emergencyPillar(bot, ctl) : await pillarUp(bot, ctl, { skip, stopIf: () => angryClose(10) })
        // Ад — пещеры с низким сводом: места под столб нет — пройти дальше.
        for (let k = 0; k < 8 && !up.ok && !ctl.aborted && gameClock.now() + 30000 < deadline; k++) {
          if (angryClose(12)) {
            up = await emergencyPillar(bot, ctl)
            if (up.ok) break
            // Столб не встал (свод низко) — бой на земле: в тело, щит.
            const em0 = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id) && meta(bot, e, 'creepy'))
              .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
            if (em0) {
              const f: any = await openFight(session, ctl, em0, { retreatAt: 5, dead, maxMs: 30000 }).catch(e => ({ error: e.message }))
              log('бой на земле', { ...f, why: up.why })
              if (f.killed) await pickUp(bot, ctl, 5, 3000)
            }
            continue
          }
          // В яме (ногами никуда: стены выше шага) — выбраться столбом.
          try {
            const around = require('./walkable').walkable(bot, bot.entity.position, { radius: 6, maxNodes: 40 }).length
            if (around <= 3) { const t = await towerUp(bot, ctl, 3); log('из ямы', { nodes: around, placed: t.placed, why: t.reason }) }
          } catch {}
          const w = await searchWalk(bot, ctl, 22, () => angryClose(10))
          log('поиск места под столб', { to: w, why: up.why })
          up = angryClose(12) ? await emergencyPillar(bot, ctl) : await pillarUp(bot, ctl, { skip, stopIf: () => angryClose(10) })
        }
        if (!up.ok) { stopped = `столб не вышел: ${up.why || 'встал'}`; break }
        pillar = up
        log('столб', { base: xyz(up.base), placed: up.placed, emergency: up.emergency })
      }
      // 2. Кого злить: глаза видно строго, 6..24 блока.
      const me = bot.entity.position
      const cands = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false &&
        !dead.has(e.id) && !skip.has(e.id) && e.position.distanceTo(me) <= radius)
      const angry = cands.filter(e => meta(bot, e, 'creepy'))
      let em: any = angry.sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
      const round: any = { from: null }
      if (!em) {
        const walksHere = e => !pillar || !pillar.reach || [0, -1, 1].some(dy => { const f = e.position.floored().offset(0, dy, 0); return pillar.reach.has(`${f.x},${f.y},${f.z}`) })
        em = cands.filter((e : any) => { const d = e.position.distanceTo(me); return d >= 6 && d <= 24 && eyesSeen(bot, e) && walksHere(e) && !trappedEm(bot, e) })
          .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
        if (!em) {
          // Никого на виду: подождать (они ходят и телепортируются), потом
          // сменить место — вниз, пройтись, новый столб.
          if (searches++ < 8 || gameClock.now() + 20000 < deadline) {
            try { await bot.look(bot.entity.yaw + 1.2, -0.6, true) } catch {}
            await sleep(2500)
            // Столб стоит ~10 с — менять место не чаще раза в 20 с.
            if (searches % 8 === 0) {
              const all = cands.length
              const inRange = cands.filter((e : any) => { const d = e.position.distanceTo(me); return d >= 6 && d <= 24 })
              const eyes = inRange.filter(e => eyesSeen(bot, e))
              log('никого', { all, inRange: inRange.length, eyes: eyes.length, walk: eyes.filter(walksHere).length, reach: pillar && pillar.reach ? pillar.reach.size : null, base: pillar ? xyz(pillar.base) : null, seen: eyes.slice(0, 5).map((e : any) => { const f = e.position.floored(); const b = bot.blockAt(f.offset(0, -1, 0)); return [f.x, f.y, f.z, b ? b.name : null] }) })
              await pillarDown(bot, ctl, mcData, pillar.base)
              await pickUp(bot, ctl, 5, 3000)
              const w = await searchWalk(bot, ctl, 16)
              log('поиск', { to: w })
              pillar = null
            }
            continue
          }
          stopped = `эндерменов в ${radius} блоках не вижу` + (worlds.worldOf(bot) === 'the_nether' ? ' (в Аду их больше всего в искажённом лесу — warped_forest)' : ' (в верхнем мире они ходят ночью)')
          break
        }
        round.from = Math.round(em.position.distanceTo(me))
        const tA = gameClock.now()
        let looks = 0
        while (!ctl.aborted && gameClock.now() - tA < 6000 && !meta(bot, em, 'creepy') && em.isValid !== false) {
          if (eyesSeen(bot, em)) { await bot.lookAt(em.position.offset(0, 2.55, 0), true); looks++ }
          await sleep(100)
        }
        round.looks = looks
        if (!meta(bot, em, 'creepy')) { skip.add(em.id); round.skipped = 'не разозлился'; rounds.push(round); log('раунд', round); if (++fails >= 6) { stopped = 'шестерых подряд не разозлил'; break } continue }
      } else {
        round.from = Math.round(em.position.distanceTo(me))
        round.already = true
      }
      // Сразу глаза вниз (отвесно) — не смотреть в глаза подходящему.
      try { await bot.look(bot.entity.yaw, -1.5, true) } catch {}
      if (weapon) { try { await bot.equip(weapon, 'hand') } catch {} }
      // 3. Ждать у подножия и бить сверху.
      const tB = gameClock.now()
      let swings = 0
      let last = 0
      const hpTop = bot.health ?? 20
      let dbgAt = 0
      while (!ctl.aborted && gameClock.now() - tB < 35000 && em.isValid !== false && !dead.has(em.id)) {
        if ((bot.health ?? 20) <= retreatAt) break
        const r = reachTo(bot, em)
        if (gameClock.now() - dbgAt > 3000) { dbgAt = gameClock.now(); log('ждёт', { t: Math.round((gameClock.now() - tB) / 1000), r: Math.round(r * 10) / 10, creepy: !!meta(bot, em, 'creepy'), pos: xyz(em.position) }) }
        // Встал ниже и не подходит (лаборатория, прогон 11: злой 12 с стоял
        // в 5.1 блока на 3 ниже подножия): спуститься по столбу, пока его
        // макушка ниже наших ног, — с края обрыва меч достаёт, он нас нет.
        if (r > 3.0 && gameClock.now() - tB > 4000 && pillar && bot.entity.position.floored().y > pillar.base.y) {
          const feetY = bot.entity.position.floored().y
          if (feetY - 1 > em.position.y + 2.95) {
            const e2 = await digCell(bot, mcData, bot.entity.position.floored().offset(0, -1, 0))
            if (!e2) { round.stepDown = (round.stepDown || 0) + 1; await sleep(400); continue }
          }
        }
        const aim = r <= 3.2 ? safeAim(bot, em) : null
        if (aim) {
          try { await bot.lookAt(aim.pt, true) } catch {}
          if (gameClock.now() - last >= SWING_MS) { try { bot.attack(em); swings++; last = gameClock.now(); round.aim = aim.deg } catch {} }
        } else {
          try { await bot.look(bot.entity.yaw, -1.5, true) } catch {}
          if (r <= 3.0) round.noAim = (round.noAim || 0) + 1
        }
        await sleep(60)
      }
      round.swings = swings
      round.killed = dead.has(em.id)
      round.hurtOnTop = Math.round(hpTop - (bot.health ?? 20))
      round.seconds = Math.round((gameClock.now() - tB) / 1000)
      rounds.push(round)
      log('раунд', round)
      if (round.killed) {
        fails = 0
        // Жемчуг у подножия: вниз, подобрать, столб заново — если других
        // злых рядом нет (иначе бить с вершины дальше, подобрать потом).
        await sleep(800)
        const angryNear = ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < 16)
        if (angryNear) round.stayed = true
        else {
          await pillarDown(bot, ctl, mcData, pillar.base)
          await pickUp(bot, ctl, 5, 4000)
          pillar = null
        }
      } else {
        skip.add(em.id)
        if (++fails >= 6) { stopped = 'злые не подходят к столбу'; break }
      }
    }
  } finally {
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entityDead', onDead)
    bot.removeListener('entityGone', onGone)
  }
  // Со столба — вниз (не оставлять тело на трёх блоках).
  if (pillar && onTop()) await pillarDown(bot, ctl, mcData, pillar.base).catch(() => null)
  await pickUp(bot, ctl, 5, 3000).catch(() => null)
  const pearls = countOf(bot, 'ender_pearl')
  const detail: any = {
    mode: 'hunt',
    style: 'столб',
    pearls: { before: pearls0, now: pearls, gained: pearls - pearls0, want },
    kills: kills.length,
    rounds: rounds.slice(-8),
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (pearls < want) {
    detail.need = { what: 'ender_pearl', count: want - pearls, have: pearls }
    detail.stopped = `${stopped || 'встал'} — жемчуга ${pearls} из ${want} (убил ${kills.length}; игра даёт 0..1 с эндермена, в среднем 0.5)`
  }
  detail.note = `Жемчуг +${detail.pearls.gained} (теперь ${pearls}), эндерменов убито ${kills.length}. Приём: столб в 3 блока на ровном месте — эндермен с земли не достаёт, меч сверху бьёт его в голову.`
  return detail
}

// ------------------------------------------------------------ hunt: штрек
// Штрек 1x2 в стене (style: 'tunnel', по умолчанию). Лаборатория 2026-09-27:
// дуэли в открытую — 4 смерти из 4 за 1.5–3 мин (второй злой, пиглины), нора
// «шахта + штрек» — злые к шахте не идут (путь к нам не строится). Здесь путь
// есть: вход штрека — клетка S на земле (над ней 3 блока воздуха), мы — в
// двух клетках вглубь, штрек высотой 2. Эндермен (2.9) в штрек не влезает и
// встаёт в S; его удар (коробка +0.83 по горизонтали) до нас не достаёт
// (1.13 < 1.7), наш меч до его коробки — 1.7 от глаз. Злим взглядом из штрека.
function tunnelSpot (bot, mcData, feet) {
  const solid = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'block' }
  const air = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
  const lava = bot.registry.blocksByName.lava.id
  if (!solid(feet.offset(0, -1, 0)) || !air(feet) || !air(feet.offset(0, 1, 0)) || !air(feet.offset(0, 2, 0))) return null
  for (const [dx, dz] of CARDINAL) {
    let ok = true
    for (let k = 1; k <= 3 && ok; k++) {
      const c = feet.offset(dx * k, 0, dz * k)
      // Пол, ноги, голова — в стене; над головой — потолок (штрек высотой 2).
      if (!solid(c.offset(0, -1, 0)) || !solid(c.offset(0, 2, 0))) ok = false
      if (k <= 2) for (const q of [c, c.offset(0, 1, 0)]) { const b = bot.blockAt(q); if (!b || (b.boundingBox === 'block' && missingHarvestTool(bot, b, mcData))) ok = false }
    }
    if (!ok) continue
    let hot = false
    for (let x = -2; x <= 2 && !hot; x++) for (let y = -1; y <= 3 && !hot; y++) for (let z = -2; z <= 2 && !hot; z++) {
      const b = bot.blockAt(feet.offset(dx * 2 + x, y, dz * 2 + z))
      if (b && (b.type === lava || /water/.test(b.name))) hot = true
    }
    if (hot) continue
    return { mouth: feet, dir: [dx, dz] }
  }
  return null
}

async function digTunnel (bot, ctl, mcData, { radius = 28, exclude = [] }: any = {}) {
  const { walkable } = require('./walkable')
  // Место — где от входа видно больше всего глаз эндерменов в 8..24 (лес
  // закрывает обзор: штрек 1 в лесу за 3 минуты не увидел ни одного).
  let spot = null
  {
    const ems = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false)
    let best = null
    let checked = 0
    for (const x of walkable(bot, bot.entity.position, { radius, maxNodes: 8000 })) {
      if (exclude.some(m => m.distanceTo(x.pos) < 8)) continue
      const sp = tunnelSpot(bot, mcData, x.pos)
      if (!sp) continue
      if (++checked > 160) break
      const eye = x.pos.offset(0.5, 1.62, 0.5)
      let seen = 0
      for (const e of (ems as any)) { const d = e.position.distanceTo(eye); if (d >= 6 && d <= 32 && !trappedEm(bot, e) && clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++ }
      const score = seen * 10 - x.d * 0.2
      if (!best || score > best.score) best = { pos: x.pos, seen, score }
    }
    if (best) log('место штрека', { at: xyz(best.pos), eyesSeen: best.seen, checked })
    if (best && best.pos.equals(bot.entity.position.floored())) spot = tunnelSpot(bot, mcData, best.pos)
    var n = best ? { pos: best.pos } : null
  }
  if (!spot) {
    if (!n) return { ok: false, why: 'стены для штрека (2 блока высотой, потолок, без лавы) рядом нет' }
    await walkTo(bot, ctl, n.pos, 0, 20000)
    if (!bot.entity.position.floored().equals(n.pos)) await stepInto(bot, n.pos)
    spot = tunnelSpot(bot, mcData, bot.entity.position.floored())
    if (!spot) return { ok: false, why: 'до места штрека не дошёл' }
  }
  const [dx, dz] = spot.dir
  const c1 = spot.mouth.offset(dx, 0, dz)
  const c2 = spot.mouth.offset(2 * dx, 0, 2 * dz)
  for (const c of [c1.offset(0, 1, 0), c1, c2.offset(0, 1, 0), c2]) {
    const err = await digCell(bot, mcData, c)
    if (err) return { ok: false, why: err }
  }
  if (!(await stepInto(bot, c1)) || !(await stepInto(bot, c2))) return { ok: false, why: 'в штрек не шагнул' }
  try { await bot.lookAt(spot.mouth.offset(0.5, 1.2, 0.5), true) } catch {}
  return { ok: true, mouth: spot.mouth, c1, stand: c2, dir: spot.dir }
}

// ------------------------------------------------------------ будка
// Штрек без стены: 1x2 из булыжника на месте с обзором (прогоны 54–55: у
// стен в лесу глаз почти не видно — 1 убийство за 7 мин). Мы в c2 (P), c1 —
// перед нами, вход S — ещё дальше, на нём встаёт эндермен (рост 2.9 в c1 под
// крышей высотой 2 не лезет). Стены на ноги и голову у c2 и c1, задняя — в 3
// блока (опора крыши), задние углы (иначе удар по диагонали сзади: его коробка
// удара +0.83 по горизонтали достаёт соседнюю клетку наискосок), крыша над c2
// и c1. До 17 блоков. Из c2 до S — 2 блока: он не достаёт, меч достаёт (1.7).
function safeGround (bot, f) {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      let depth = 0
      for (let dy = -1; dy >= -5; dy--) {
        const b = bot.blockAt(f.offset(dx, dy, dz))
        if (!b) break
        if (/lava/.test(b.name)) return false
        if (b.boundingBox === 'block') break
        depth++
      }
      if (depth > 3) return false
    }
  }
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -3; dy <= 1; dy++) { const b = bot.blockAt(f.offset(dx, dy, dz)); if (b && /lava/.test(b.name)) return false }
  return true
}
function boothSite (bot, P, d) {
  const [dx, dz] = d
  const sx = -dz; const sz = dx
  const air = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/water|lava|fire/.test(b.name) }
  const solid = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'block' }
  const c1 = P.offset(dx, 0, dz)
  const S = P.offset(2 * dx, 0, 2 * dz)
  if (!solid(P.offset(0, -1, 0)) || !solid(c1.offset(0, -1, 0)) || !solid(S.offset(0, -1, 0))) return null
  for (const c of [P, c1]) if (!air(c) || !air(c.offset(0, 1, 0))) return null
  if (!air(S) || !air(S.offset(0, 1, 0)) || !air(S.offset(0, 2, 0))) return null
  const back = P.offset(-dx, 0, -dz)
  const corners = [back.offset(sx, 0, sz), back.offset(-sx, 0, -sz)]
  const sides2 = [P.offset(sx, 0, sz), P.offset(-sx, 0, -sz)]
  const sides1 = [c1.offset(sx, 0, sz), c1.offset(-sx, 0, -sz)]
  const order = []
  for (const w of corners) order.push(w, w.offset(0, 1, 0))
  order.push(back, back.offset(0, 1, 0), back.offset(0, 2, 0))
  for (const w of sides2) order.push(w, w.offset(0, 1, 0))
  for (const w of sides1) order.push(w, w.offset(0, 1, 0))
  order.push(P.offset(0, 2, 0), c1.offset(0, 2, 0))
  let need = 0
  for (const c of order) {
    const b = bot.blockAt(c)
    if (!b || /water|lava/.test(b.name)) return null
    if (b.boundingBox !== 'block') need++
  }
  return { P, c1, S, dir: d, order, need, critical: [back, back.offset(0, 1, 0), ...sides2, ...sides2.map(w => w.offset(0, 1, 0)), ...sides1, ...sides1.map(w => w.offset(0, 1, 0)), ...corners, P.offset(0, 2, 0), c1.offset(0, 2, 0)] }
}
function boothPlan (bot, { radius = 32, exclude = [] }: any = {}) {
  const { walkable } = require('./walkable')
  const ems = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !trappedEm(bot, e))
  const nodes = walkable(bot, bot.entity.position, { radius, maxNodes: 6000 })
  let best = null
  let checked = 0
  for (let i = 0; i < nodes.length && checked < 300; i += 2) {
    const n = nodes[i]
    if (exclude.some(m => m.distanceTo(n.pos) < 8)) continue
    for (const d of CARDINAL) {
      const site = boothSite(bot, n.pos, d)
      if (!site) continue
      if (!safeGround(bot, n.pos)) break
      checked++
      const eye = site.S.offset(0.5, 1.62, 0.5)
      let seen = 0
      for (const e of (ems as any)) { const dd = e.position.distanceTo(eye); if (dd >= 6 && dd <= 32 && clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++ }
      const score = seen * 10 - n.d * 0.3 - site.need * 0.5
      if (!best || score > best.score) best = { ...site, seen, score, steps: n.d, checked }
    }
  }
  return best
}
async function buildBooth (bot, ctl, mcData, { radius = 32, exclude = [] }: any = {}) {
  const { placeBlockAt, FILLER } = require('./build')
  const plan = boothPlan(bot, { radius, exclude })
  if (!plan) return { ok: false, why: 'места под будку (ровно, S на 3 воздуха, без лавы и обрыва) нет' }
  log('место будки', { at: xyz(plan.P), dir: plan.dir, seen: plan.seen, need: plan.need, steps: plan.steps })
  const have = bot.inventory.items().filter(i => FILLER.includes(i.name) && !/sand|gravel/.test(i.name)).reduce((n, i) => n + i.count, 0)
  if (plan.need > have) return { ok: false, why: `на будку нужно ${plan.need} блоков, есть ${have}` }
  await walkTo(bot, ctl, plan.P, 0, 20000)
  if (!bot.entity.position.floored().equals(plan.P)) await stepInto(bot, plan.P)
  if (!bot.entity.position.floored().equals(plan.P)) return { ok: false, why: 'до места будки не дошёл' }
  try { await require('./fortify').centerInCell(bot, 700) } catch {}
  let placed = 0
  const failed = []
  for (const c of plan.order) {
    if (ctl.aborted) break
    const b = bot.blockAt(c)
    if (b && b.boundingBox === 'block') continue
    if (b && b.name !== 'air' && b.name !== 'cave_air') { try { await bot.dig(b) } catch {} }
    let r = null
    for (let k = 0; k < 2 && !(r && r.ok); k++) r = await placeBlockAt(bot, c, { timeoutMs: 1500 }).catch(e => ({ ok: false, reason: e.message }))
    if (r && r.ok) { if (!r.already) placed++ } else failed.push(`${c.x},${c.y},${c.z}:${r ? r.reason : '?'}`)
  }
  const holes = plan.critical.filter(c => { const b = bot.blockAt(c); return !b || b.boundingBox !== 'block' })
  if (holes.length) return { ok: false, why: `будка не достроена: дыр ${holes.length}`, failed: failed.slice(0, 4), placed }
  try { await bot.lookAt(plan.S.offset(0.5, 1.2, 0.5), true) } catch {}
  return { ok: true, mouth: plan.S, c1: plan.c1, stand: plan.P, dir: plan.dir, booth: true, placed, seen: plan.seen }
}

async function huntTunnel (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const pearls0 = countOf(bot, 'ender_pearl')
  const want = pearls0 + Math.max(1, p.count ?? 4)
  const hp0 = Math.round(bot.health ?? 20)
  const rounds = []
  const dead = new Set()
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'enderman') hurtAt.set(e.id, gameClock.now()) }
  const onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || !e.position || e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    dead.add(e.id)
  }
  const onGone = e => onDead(e, 'gone')
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  let stopped = null
  let tun = null
  let kills = 0
  let aggros = 0
  let drops = 0
  let moves = 0
  const mouths = []
  const skip = new Map() // не разозлился — до
  const angrySince = new Map() // злой с
  const ignore = new Map() // злой, но не идёт — до
  const weapon = bestWeapon(bot)
  const isPearl = e => { try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'ender_pearl' } catch { return false } }
  const endermen = () => ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id))
  const skipped = e => (skip.get(e.id) || 0) > gameClock.now()
  const ignored = e => (ignore.get(e.id) || 0) > gameClock.now()
  // Злые, что ещё идут к нам. В штреке их можно ждать сколько угодно: у входа
  // встаёт только один (рост 2.9 в штрек 1x2 не лезет), бьём его из глубины.
  const pending = () => endermen().filter((e : any) => meta(bot, e, 'creepy') && !ignored(e) && e.position.distanceTo(bot.entity.position) < 40)
  const nearMouth = r => endermen().some((e : any) => meta(bot, e, 'creepy') && !ignored(e) && e.position.distanceTo(tun.mouth.offset(0.5, 0, 0.5)) < r)
  const stare = async (target, ms) => {
    const tS = gameClock.now()
    while (!ctl.aborted && gameClock.now() - tS < ms && !meta(bot, target, 'creepy') && target.isValid !== false) {
      if (eyesSeen(bot, target)) await bot.lookAt(target.position.offset(0, 2.55, 0), true).catch(() => {})
      await sleep(100)
    }
    const ok = !!meta(bot, target, 'creepy')
    if (ok) aggros++
    else skip.set(target.id, gameClock.now() + 30000)
    return ok
  }
  const targetsFrom = (me, max = 32) => endermen().filter(e => !skipped(e) && !meta(bot, e, 'creepy') && !trappedEm(bot, e))
    .filter((e : any) => { const d = e.position.distanceTo(me); return d >= 6 && d <= max })
    .filter(e => eyesSeen(bot, e))
    .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
  const home = async () => {
    const f = bot.entity.position.floored()
    if (f.equals(tun.stand)) return
    if (!f.equals(tun.c1) && !f.equals(tun.mouth)) await walkTo(bot, ctl, tun.mouth, 0, 8000)
    if (!bot.entity.position.floored().equals(tun.c1)) await stepInto(bot, tun.c1)
    await stepInto(bot, tun.stand)
    try { await bot.lookAt(tun.mouth.offset(0.5, 0.8, 0.5), true) } catch {}
  }
  // Лут падает там, где он умер (у входа): шаг в c1 подбирает всё у входа
  // (подбор — коробка тела +1). Откатился дальше — дойти, если злых нет.
  const collect = async (at) => {
    const items = () => (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(at) < 8 && !lavaAround(bot, e.position))
    await sleep(900)
    let seen = items()
    if (!seen.length) { await sleep(1200); seen = items() }
    const res: any = { drop: seen.length }
    if (!seen.length) return res
    drops++
    const had = countOf(bot, 'ender_pearl')
    if (!endermen().some(e => reachTo(bot, e) <= 3.2)) { await stepInto(bot, tun.c1); await sleep(700) }
    for (const it of (items() as any)) {
      if (countOf(bot, 'ender_pearl') > had || nearMouth(10) || ctl.aborted) break
      await walkTo(bot, ctl, it.position.floored(), 0, 5000)
      await sleep(400)
    }
    res.got = countOf(bot, 'ender_pearl') - had
    await home()
    return res
  }
  let lastChance = gameClock.now()
  try {
    // Будка на месте с обзором; не вышла — штрек в стене.
    tun = p.booth === false ? { ok: false } : await buildBooth(bot, ctl, mcData, { radius: 32 })
    if (!tun.ok) { log('будка', tun); tun = await digTunnel(bot, ctl, mcData, { radius: 40 }) }
    log('штрек', tun.ok ? { mouth: xyz(tun.mouth), stand: xyz(tun.stand), booth: !!tun.booth, seen: tun.seen, placed: tun.placed } : tun)
    if (!tun.ok) { stopped = tun.why; tun = null }
    while (tun && !ctl.aborted) {
      if (countOf(bot, 'ender_pearl') >= want) break
      if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
      if (!bot.entity.position.floored().equals(tun.stand)) await home()
      const all = endermen()
      // Злой 25 с и не у входа — застрял: не ждать его.
      for (const e of (all as any)) {
        if (!meta(bot, e, 'creepy')) { angrySince.delete(e.id); continue }
        if (!angrySince.has(e.id)) angrySince.set(e.id, gameClock.now())
        else if (gameClock.now() - angrySince.get(e.id) > 25000 && reachTo(bot, e) > 3.2) ignore.set(e.id, gameClock.now() + 60000)
      }
      // 1. У входа — бить в тело (в глаза не смотреть: ближе 4 — телепорт).
      const near: any = all.filter(e => reachTo(bot, e) <= 3.0).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
      if (near) {
        if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
        const r: any = { id: near.id, t: Math.round((gameClock.now() - t0) / 1000), swings: 0 }
        const hpA = bot.health ?? 20
        let last = 0
        const tA = gameClock.now()
        while (!ctl.aborted && gameClock.now() - tA < 20000 && near.isValid !== false && !dead.has(near.id)) {
          if (reachTo(bot, near) > 3.2) { await sleep(100); if (gameClock.now() - tA > 6000) break; continue }
          try { await bot.lookAt(near.position.offset(0, 1.0, 0), true) } catch {}
          if (gameClock.now() - last >= SWING_MS) { try { bot.attack(near); r.swings++; last = gameClock.now() } catch {} }
          await sleep(60)
        }
        await sleep(200)
        r.killed = dead.has(near.id)
        r.hpLost = Math.round((hpA - (bot.health ?? 20)) * 10) / 10
        if (r.killed) {
          kills++
          Object.assign(r, await collect(near.position.clone()))
        } else skip.set(near.id, gameClock.now() + 20000)
        r.pearls = countOf(bot, 'ender_pearl')
        rounds.push(r)
        log('штрек: бой', r)
        continue
      }
      if ((bot.food ?? 20) <= 16) { try { await require('./actions').eat(session, {}) } catch {} }
      // 2. Злых в пути трое и больше — ждать их у входа.
      if (pending().length >= 3) { await sleep(300); continue }
      // 3. Злить отсюда (из глубины видно узко).
      const here = targetsFrom(bot.entity.position)
      if (here.length) {
        lastChance = gameClock.now()
        await stare(here[0], 5000)
        try { await bot.lookAt(tun.mouth.offset(0.5, 0.8, 0.5), true) } catch {}
        continue
      }
      // 3б. Глаз не видно (искажённый лес: грибы и лозы — на ферме 60–80
      // эндерменов в 48 блоках и 0 видимых глаз): разозлить УДАРОМ спокойного у
      // входа (удар злит без взгляда и без телепорта — EnderMan.hurtServer) и
      // сразу назад в штрек: злой идёт за нами к входу, внутрь (рост 2.9 в
      // 1x2) не лезет, бьём его из глубины. На земле дуэль с двумя-тремя злыми
      // стоила смерти в 4 прогонах из 5.
      if (!nearMouth(10) && !pending().length && p.poke !== false) {
        const mouthC = tun.mouth.offset(0.5, 0, 0.5)
        const pool = endermen()
        const calm: any = pool.filter((e : any) => !meta(bot, e, 'creepy') && !skipped(e) && !trappedEm(bot, e) && e.position.distanceTo(mouthC) <= 14 &&
          Math.abs(e.position.y - mouthC.y) <= 3 && !pool.some((o : any) => o !== e && o.position.distanceTo(e.position) < 4))
          .sort((a: any, b: any) => a.position.distanceTo(mouthC) - b.position.distanceTo(mouthC))[0]
        if (calm) {
          const pk: any = { id: calm.id, from: Math.round(calm.position.distanceTo(mouthC)) }
          await stepInto(bot, tun.c1)
          await stepInto(bot, tun.mouth)
          const pick = require('./pick')
          const cap = () => { if (bot.entity && bot.entity.pitch > -0.45) bot.entity.pitch = -0.45 }
          bot.on('physicsTick', cap)
          bot._ndNoMobAvoid = true
          const tP = gameClock.now()
          try {
            while (!ctl.aborted && gameClock.now() - tP < 9000 && calm.isValid !== false && bot.entities[calm.id] && !meta(bot, calm, 'creepy')) {
              if (reachTo(bot, calm) <= 2.9) {
                const a = pick.aim(bot, calm)
                if (a && a.point) {
                  if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
                  try { await bot.lookAt(calm.position.offset(0, 0.6, 0), true) } catch {}
                  try { bot.attack(calm); pk.hit = true } catch {}
                  break
                }
              }
              await walkTo(bot, ctl, calm.position.floored(), 1, 2500)
            }
          } finally {
            bot._ndNoMobAvoid = false
            bot.removeListener('physicsTick', cap)
          }
          await home()
          pk.angry = !!meta(bot, calm, 'creepy')
          pk.s = Math.round((gameClock.now() - tP) / 1000)
          log('штрек: удар-вызов', pk)
          if (pk.angry) { aggros++; lastChance = gameClock.now() } else skip.set(calm.id, gameClock.now() + 30000)
          continue
        }
      }
      // 4. Выйти ко входу (злых у входа в 10 нет): злить до двух подряд, назад.
      if (!nearMouth(10)) {
        await stepInto(bot, tun.c1)
        await stepInto(bot, tun.mouth)
        const out = targetsFrom(bot.entity.position)
        if (out.length) lastChance = gameClock.now()
        let n = 0
        for (const t of out.slice(0, 4)) {
          if (n >= 2 || nearMouth(8) || ctl.aborted) break
          if (!eyesSeen(bot, t)) continue
          if (await stare(t, 4000)) n++
        }
        if (n) log('штрек: разозлил у входа', { n, seen: out.length })
        await stepInto(bot, tun.c1)
        await stepInto(bot, tun.stand)
        try { await bot.lookAt(tun.mouth.offset(0.5, 0.8, 0.5), true) } catch {}
        if (!n) await sleep(700)
      } else await sleep(300)
      // 5. Две минуты некого злить — новый штрек в 40 блоках (до 3 раз).
      if (gameClock.now() - lastChance > 120000 && !pending().length && moves < 3) {
        moves++
        mouths.push(tun.mouth)
        const old = tun
        await stepInto(bot, tun.c1)
        await stepInto(bot, tun.mouth)
        let t2: any = p.booth === false ? { ok: false } : await buildBooth(bot, ctl, mcData, { radius: 32, exclude: mouths })
        if (!t2.ok) t2 = await digTunnel(bot, ctl, mcData, { radius: 40, exclude: mouths })
        log('штрек: новое место', t2.ok ? { mouth: xyz(t2.mouth), n: moves } : t2)
        if (t2.ok) tun = t2
        else { tun = old; await home() }
        lastChance = gameClock.now()
      }
    }
  } finally {
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entityDead', onDead)
    bot.removeListener('entityGone', onGone)
  }
  // Из штрека — наружу (к входу).
  if (tun) { await stepInto(bot, tun.c1).catch(() => false); await stepInto(bot, tun.mouth).catch(() => false) }
  const pearls = countOf(bot, 'ender_pearl')
  const secs = Math.round((gameClock.now() - t0) / 1000)
  const detail: any = {
    mode: 'hunt',
    style: 'штрек',
    pearls: { before: pearls0, now: pearls, gained: pearls - pearls0, want },
    kills,
    aggros,
    drops,
    moves,
    killsPerHour: secs ? Math.round(kills * 3600 / secs) : 0,
    pearlsPer10min: secs ? Math.round((pearls - pearls0) * 6000 / secs) / 10 : 0,
    rounds: rounds.slice(-10),
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    seconds: secs
  }
  if (pearls < want) {
    detail.need = { what: 'ender_pearl', count: want - pearls, have: pearls }
    detail.stopped = `${stopped || 'встал'} — жемчуга ${pearls} из ${want} (убил ${kills})`
  }
  detail.note = `Жемчуг +${detail.pearls.gained}, убито ${kills} (разозлил ${aggros}, выпало ${drops}) за ${secs} с (штрек 1x2 в стене).`
  return detail
}

// ------------------------------------------------------------ окоп
// Окоп под крышей (style: 'foxhole'). Сверка с байткодом paper-1.21.11
// (2026-09-29): эндермен бьёт, только если (1) его коробка, раздутая на 0.828
// ТОЛЬКО по горизонтали (Mob.getAttackBoundingBox → inflate(r, 0, r)),
// пересекает нашу и (2) луч от его глаз (2.55) к нашим глазам чист по COLLIDER
// (MeleeAttackGoal.canPerformAttack → Sensing.hasLineOfSight →
// LivingEntity.hasLineOfSight(target, COLLIDER, NONE, target.eyeY)).
// Мы — в яме глубиной 1 (ноги на 1 ниже земли), над ямой крыша на +1 от земли
// (потолок в 2 блока над нашими ногами). Эндермен на земле рядом: коробка
// достаёт, но луч «глаза → глаза» (2.55 → 0.62 над землёй) пересекает y = +1
// внутри клетки ямы — в крыше. Перебор его позиций вокруг с шагом 0.05
// (scratch foxhole.js): 0 опасных при ровной земле; опасна только соседняя
// клетка НИЖЕ земли (его ноги на нашем уровне, луч проходит под крышей) —
// такое место не берём. Наш меч достаёт его ноги сквозь щель между землёй и
// крышей (луч на высоте ~0.6), в клетку ямы он не влезает (2.9 > 2), на крыше
// стоит выше нас (коробка удара вниз не растёт). Злим взглядом издали (от 5
// блоков: ближе 4 взгляд в глаза телепортирует его — EndermanLookForPlayerGoal),
// глаза ближних закрывает та же крыша, а удар мечом (живой обидчик) телепорта не
// вызывает (EnderMan.hurtServer). Выпавший рядом жемчуг подбирается из ямы сам
// (подбор — коробка тела +1 по горизонтали).
function foxSite (bot, mcData, P, why = null) {
  const no = r => { if (why) why[r] = (why[r] || 0) + 1; return null }
  const air = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
  const solid = q => solidAt(bot, q)
  const H = P.offset(0, -1, 0)
  const R = P.offset(0, 1, 0)
  if (!air(P) || !air(R) || !solid(H) || !solid(H.offset(0, -1, 0))) return no('клетка')
  if (!diggable(bot, mcData, H)) return no('не копается')
  const hb = bot.blockAt(H)
  if (hb && /magma|soul_sand|soul_soil|powder_snow|gravel|sand$/.test(hb.name)) return no('пол')
  // Стенки ямы — 4 соседа на уровне ног; вокруг — ровно: у каждого из 8 соседей
  // пол на уровне земли или сам сосед — стена (ниже земли — опасная клетка).
  // Ямку у соседа (пол ниже земли, сама клетка пола — воздух) засыпаем блоком,
  // до 4 штук: «ровного места нет» было главной причиной простоя (ферма 29.09,
  // foxhole-5: из 9 переездов 6 — «мест нет»).
  const fills = []
  const addFill = F => { if (!fills.some(f => f.equals(F))) fills.push(F) }
  for (const [dx, dz] of CARDINAL) {
    const W = H.offset(dx, 0, dz)
    if (solid(W)) continue
    if (!air(W)) return no('стенки ямы')
    addFill(W)
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      const N = P.offset(dx, 0, dz)
      if (solid(N)) continue
      const F = N.offset(0, -1, 0)
      if (solid(F)) continue
      if (!air(F)) return no('сосед ниже')
      addFill(F)
    }
  }
  if (fills.length > 4) return no('ровнять много')
  const solidOrFill = q => solid(q) || fills.some(f => f.equals(q))
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -3; dy <= 2; dy++) {
    const b = bot.blockAt(P.offset(dx, dy, dz))
    if (b && /lava|water/.test(b.name)) return no('жидкость')
  }
  // Опора крыши: готовый твёрдый сосед у R — или стенка A (земля) + A2 (на ней).
  let dir = null
  let needProp = true
  for (const [dx, dz] of CARDINAL) if (solid(R.offset(dx, 0, dz))) { dir = [dx, dz]; needProp = false; break }
  if (needProp && solid(R.offset(0, 1, 0))) needProp = false
  if (needProp) {
    for (const [dx, dz] of CARDINAL) {
      const A = P.offset(dx, 0, dz)
      if ((air(A) || solid(A)) && (air(A.offset(0, 1, 0)) || solid(A.offset(0, 1, 0)))) { dir = [dx, dz]; break }
    }
    if (!dir) return no('опора')
  }
  // Выход — сосед на земле с другой стороны (две клетки воздуха, пол).
  let out = null
  for (const [dx, dz] of CARDINAL) {
    if (dir && dx === dir[0] && dz === dir[1]) continue
    const N = P.offset(dx, 0, dz)
    if (air(N) && air(N.offset(0, 1, 0)) && solidOrFill(N.offset(0, -1, 0))) { out = N; break }
  }
  if (!out) return no('выход')
  const A = dir ? P.offset(dir[0], 0, dir[1]) : null
  return { P, H, R, A, A2: A ? A.offset(0, 1, 0) : null, needProp, out, dir, fills }
}

// Уже сидим в окопе (прошлый вызов): над головой +1 воздух, +2 крыша, стенки.
function foxHere (bot, mcData) {
  const F = bot.entity.position.floored()
  const air = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
  if (!solidAt(bot, F.offset(0, 2, 0)) || !air(F.offset(0, 1, 0)) || !air(F)) return null
  for (const [dx, dz] of CARDINAL) if (!solidAt(bot, F.offset(dx, 0, dz))) return null
  const P = F.offset(0, 1, 0)
  let out = null
  for (const [dx, dz] of CARDINAL) {
    const N = P.offset(dx, 0, dz)
    if (air(N) && air(N.offset(0, 1, 0)) && solidAt(bot, N.offset(0, -1, 0))) { out = N; break }
  }
  if (!out) return null
  return { P, H: F, R: F.offset(0, 2, 0), out, reused: true }
}

async function foxDropIn (bot, fox) {
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 2500 && !bot.entity.position.floored().equals(fox.H)) {
      await bot.lookAt(fox.P.offset(0.5, 0.2, 0.5), true)
      bot.setControlState('forward', bot.entity.position.floored().y > fox.H.y)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false) }
  try { await require('./fortify').centerInCell(bot, 500) } catch {}
  return bot.entity.position.floored().equals(fox.H)
}

async function foxRoof (bot, fox) {
  const { placeBlockAt } = require('./build')
  let r = null
  for (let k = 0; k < 3 && !(r && r.ok); k++) r = await placeBlockAt(bot, fox.R, { timeoutMs: 1500 }).catch(e => ({ ok: false, reason: e.message }))
  return solidAt(bot, fox.R) ? { ok: true } : { ok: false, why: `крыша не встала: ${r ? r.reason : '?'}` }
}

async function foxBuild (bot, ctl, mcData, site, danger = null) {
  const { placeBlockAt } = require('./build')
  const fortify = require('./fortify')
  // Сами под потолком в яме (старый окоп прошлого вызова, пол ниже земли) —
  // потолок долой, иначе прыжок из ямы упирается в него: pathfinder «stuck»
  // (ферма 29.09, foxhole-4: «до места окопа не дошёл» с 50,53,19).
  {
    const F = bot.entity.position.floored()
    const up = F.offset(0, 2, 0)
    if (!F.equals(site.P) && solidAt(bot, up) && !hazardNear(bot, up) && solidAt(bot, F.offset(0, -1, 0))) await digCell(bot, mcData, up)
  }
  if (!bot.entity.position.floored().equals(site.P)) await walkTo(bot, ctl, site.P, 0, 12000)
  if (!bot.entity.position.floored().equals(site.P) && bot.entity.position.distanceTo(site.P.offset(0.5, 0, 0.5)) < 3) await stepInto(bot, site.P)
  if (!bot.entity.position.floored().equals(site.P)) return { ok: false, why: 'до места окопа не дошёл' }
  let placed = 0
  // В середину клетки ДО опоры: край тела в клетке опоры — «ответа от сервера
  // нет» (ферма 29.09, pearls-foxhole-3: 2 окопа из 9 не встали так).
  try { await fortify.centerInCell(bot, 700) } catch {}
  // Эндермен в клетке засыпки, опоры или крыши — не строить здесь: блок не встанет,
  // а возня у самых его ног кончалась боем в открытую (foxhole-11, слот 8: смерть
  // после «ямку не засыпал: в клетке стоит enderman»).
  const busyCell = c => ents(bot).some((e : any) => e && e.name === 'enderman' && e.position &&
    Math.abs(e.position.x - (c.x + 0.5)) < 0.9 && Math.abs(e.position.z - (c.z + 0.5)) < 0.9 && e.position.y < c.y + 1 && e.position.y + 2.9 > c.y)
  for (const c of [...(site.fills || []), site.A, site.A2, site.R].filter(Boolean)) if (!solidAt(bot, c) && busyCell(c)) return { ok: false, why: 'в клетке эндермен' }
  for (const c of site.fills || []) {
    if (danger && danger()) return { ok: false, why: 'злой рядом' }
    if (solidAt(bot, c)) continue
    let r = null
    for (let k = 0; k < 2 && !(r && r.ok); k++) r = await placeBlockAt(bot, c, { timeoutMs: 1500 }).catch(e => ({ ok: false, reason: e.message }))
    if (!solidAt(bot, c)) return { ok: false, why: `ямку у окопа не засыпал: ${r ? r.reason : '?'}` }
    placed++
  }
  if (site.needProp) {
    for (const c of [site.A, site.A2]) {
      if (danger && danger()) return { ok: false, why: 'злой рядом' }
      if (solidAt(bot, c)) continue
      let r = null
      for (let k = 0; k < 2 && !(r && r.ok); k++) r = await placeBlockAt(bot, c, { timeoutMs: 1500 }).catch(e => ({ ok: false, reason: e.message }))
      if (!solidAt(bot, c)) return { ok: false, why: `опора крыши не встала: ${r ? r.reason : '?'}` }
      placed++
    }
  }
  try { await fortify.centerInCell(bot, 700) } catch {}
  const e = await digCell(bot, mcData, site.H)
  if (e) return { ok: false, why: `яма не копается: ${e}` }
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 1500 && !bot.entity.position.floored().equals(site.H)) await sleep(50)
  if (!bot.entity.position.floored().equals(site.H) && !(await foxDropIn(bot, site))) return { ok: false, why: 'в яму не спустился' }
  try { await fortify.centerInCell(bot, 500) } catch {}
  // Стенки ямы из того, что эндермен уносит (#enderman_holdable: нилий, земля,
  // гравий…), — заменить незераком/булыжником: вынутая стенка открывает сбоку
  // клетку на нашем уровне, и луч к нам проходит под крышей (foxhole-13, слот 15:
  // в яме 6 ударов по нам и смерть). Своя стенка — копать и ставить обратно.
  let swapped = 0
  for (const [dx, dz] of CARDINAL) {
    const W = site.H.offset(dx, 0, dz)
    const wb = bot.blockAt(W)
    if (!wb || !HOLDABLE.test(wb.name)) continue
    if (danger && danger()) break
    const e = await digCell(bot, mcData, W)
    if (e) continue
    let r = null
    for (let k = 0; k < 2 && !(r && r.ok); k++) r = await placeBlockAt(bot, W, { timeoutMs: 1500 }).catch(err => ({ ok: false, reason: err.message }))
    if (solidAt(bot, W)) swapped++
    else return { ok: false, why: `стенку ямы не вернул: ${r ? r.reason : '?'}` }
  }
  const roof = await foxRoof(bot, site)
  if (!roof.ok) return { ok: false, why: roof.why }
  return { ok: true, placed: placed + 1 + swapped, swapped }
}

// Из ямы на землю к выходу — прыжком вперёд сами. Pathfinder из ямы глубиной 1
// отвечал «goal_reached» или «stuck», а тело так и стояло на дне (ферма 29.09,
// foxhole-4: новое место не искалось — заливка из ямы не выходила наружу).
async function leaveFoxhole (bot, fox) {
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 1800 && bot.entity.position.floored().y < fox.P.y) {
      await bot.lookAt(fox.out.offset(0.5, 1.6, 0.5), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
  await sleep(150)
  return bot.entity.position.floored().y >= fox.P.y
}

async function foxExit (bot, ctl, mcData, fox) {
  if (bot.entity.position.floored().y >= fox.P.y) return true
  if (solidAt(bot, fox.R)) { const e = await digCell(bot, mcData, fox.R); if (e) return false }
  await sleep(150)
  if (await leaveFoxhole(bot, fox)) return true
  await walkTo(bot, ctl, fox.out, 0, 4000)
  return bot.entity.position.floored().y >= fox.P.y
}

async function foxEnter (bot, ctl, fox) {
  if (!bot.entity.position.floored().equals(fox.H)) {
    if (bot.entity.position.distanceTo(fox.P.offset(0.5, 0, 0.5)) > 1.6) await walkTo(bot, ctl, fox.out, 0, 8000)
    if (!(await foxDropIn(bot, fox))) return false
  }
  if (!solidAt(bot, fox.R)) return (await foxRoof(bot, fox)).ok
  return true
}

async function huntFoxhole (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const pearls0 = countOf(bot, 'ender_pearl')
  const want = pearls0 + Math.max(1, p.count ?? 4)
  const hp0 = Math.round(bot.health ?? 20)
  const rounds = []
  const dead = new Set()
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'enderman') hurtAt.set(e.id, gameClock.now()) }
  const onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || !e.position || e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    dead.add(e.id)
  }
  const onGone = e => onDead(e, 'gone')
  // Взгляд вниз всегда, кроме нарочного взгляда в глаза выбранному (как в дуэли).
  let pitchCap = -0.35
  const capPitch = () => { if (pitchCap !== null && bot.entity && bot.entity.pitch > pitchCap) bot.entity.pitch = pitchCap }
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  bot.on('physicsTick', capPitch)
  let stopped = null
  let fox = null
  let kills = 0
  let aggros = 0
  let stares = 0
  let peeks = 0
  let moves = 0
  let hits = 0
  let hitsOnMe = 0
  const skip = new Map()
  const angrySince = new Map()
  // Кто был злым последние 45 с: злость эндермена (NeutralMob) живёт 20–39 с и
  // после того, как метка «злой» снята (цель потеряна без луча за 3 с), — увидит
  // нас снова и сразу бьёт. Таких не подкрадываться и из ямы при них не выходить.
  const recentAngry = new Map()
  const hot = e => angry(e) || gameClock.now() - (recentAngry.get(e.id) || 0) < 45000
  const ignore = new Map()
  const weapon = bestWeapon(bot)
  const isPearl = e => { try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'ender_pearl' } catch { return false } }
  const endermen = () => ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id))
  const skipped = e => (skip.get(e.id) || 0) > gameClock.now()
  const ignored = e => (ignore.get(e.id) || 0) > gameClock.now()
  const angry = e => !!meta(bot, e, 'creepy')
  const pending = () => endermen().filter((e : any) => angry(e) && !ignored(e) && e.position.distanceTo(bot.entity.position) < 40)
  let reach = null
  const canCome = e => e.position.distanceTo(bot.entity.position) > 16 || !reach || reach.has(`${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}`)
  const onMeHurt = victim => { if (victim === bot.entity) hitsOnMe++ }
  bot.on('entityHurt', onMeHurt)
  const inHole = () => fox && bot.entity.position.floored().equals(fox.H) && solidAt(bot, fox.R)
  const stare = async (target, ms) => {
    stares++
    pitchCap = null
    const tS = gameClock.now()
    try {
      while (!ctl.aborted && gameClock.now() - tS < ms && !angry(target) && target.isValid !== false && bot.entities[target.id]) {
        if (target.position.distanceTo(bot.entity.position) < 5) break
        if (eyesSeen(bot, target)) await bot.lookAt(target.position.offset(0, 2.55, 0), true).catch(() => {})
        await sleep(100)
      }
    } finally {
      pitchCap = -0.35
      try { await bot.look(bot.entity.yaw, -0.5, true) } catch {}
    }
    const ok = angry(target)
    if (ok) aggros++
    else skip.set(target.id, gameClock.now() + 30000)
    return ok
  }
  const starePool = (maxD = 24) => {
    const me = bot.entity.position
    return endermen().filter(e => !skipped(e) && !angry(e) && !trappedEm(bot, e))
      .filter((e : any) => { const d = e.position.distanceTo(me); return d >= 5 && d <= maxD })
      .filter(e => canCome(e) && eyesSeen(bot, e))
      .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
  }
  // Места: bad — не построилось (исключаем саму клетку), used — ушли, потому
  // что рядом некого злить (исключаем 8 блоков вокруг). Раньше любое прошлое
  // место, даже не дошли, закрывало 10 блоков, и следующее выходило за 30–44
  // шага — pathfinder туда в лесу не доходил (ферма 29.09, foxhole-3: «до места
  // окопа не дошёл» 5 раз из 9).
  const bad = []
  const used = []
  // opts.near — окоп вплотную к этому месту (подкрасться к спокойному: из ямы
  // достать его мечом, и злой уже не бьёт — луча нет).
  const newSite = async (opts: any = {}) => {
    const { walkable } = require('./walkable')
    const ems = endermen().filter(e => !trappedEm(bot, e))
    const cands = []
    let checked = 0
    let nodes = 0
    const rej = {}
    // Из ямы заливка наружу не выходит (прыжок упирается в крышу) — от выхода.
    // Только если стоим на дне этой самой ямы: после «к эндерменам» тело ниже
    // старой ямы, но далеко от неё — заливка от старого выхода давала 0 клеток.
    const from = fox && bot.entity.position.floored().equals(fox.H) ? fox.out : bot.entity.position
    let list = walkable(bot, from, { radius: 24, maxNodes: 4000 })
    if (list.length < 5 && from !== bot.entity.position) list = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 4000 })
    // Сидим в яме (чужая нора, старый окоп, провал): заливка — 1–2 клетки, мест нет
    // (foxhole-9, слоты 1 и 5: «мест нет, nodes 0–1»). Подняться столбом на 2 и снова.
    if (list.length < 5) {
      try { await require('./build').towerUp(bot, ctl, 2) } catch {}
      list = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 4000 })
    }
    for (const n of list) {
      if (bad.some(s => s.distanceTo(n.pos) < 1.5) || used.some(s => s.distanceTo(n.pos) < 1.5)) continue
      if (opts.near && (Math.hypot(n.pos.x + 0.5 - opts.near.x, n.pos.z + 0.5 - opts.near.z) > 2.6 || Math.hypot(n.pos.x + 0.5 - opts.near.x, n.pos.z + 0.5 - opts.near.z) < 1.2 || Math.abs(n.pos.y - Math.floor(opts.near.y)) > 1)) continue
      nodes++
      const site = foxSite(bot, mcData, n.pos, rej)
      if (!site) continue
      if (++checked > 250) break
      const eye = n.pos.offset(0.5, 0.62, 0.5)
      let seen = 0
      let around = 0
      let near = 0
      for (const e of (ems as any)) {
        const d = e.position.distanceTo(eye)
        if (d > 5 && d <= 24) { around++; if (clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++ }
        if (d <= POKE_R) near++
      }
      // Рядом (до POKE_R) — под удар-вызов: глаз в лесу почти не видно. Близкое
      // к телу место дороже дальнего: дальние pathfinder в лесу часто не находил.
      // Рядом со старым местом (там уже звать некого) — дешевле, но не запрет: в
      // холмах заливка короткая, и запрет 8 блоков оставлял «мест нет» (слот 1).
      const stale = used.some(s => s.distanceTo(n.pos) < 8) ? 8 : 0
      const score = seen * 6 + near * 3 + around - n.d * 0.8 - (site.needProp ? 1 : 0) - site.fills.length * 0.7 - stale
      cands.push({ site, score, seen, around, near, steps: n.d })
    }
    if (!cands.length) { log('окоп: мест нет', { nodes, rej, at: xyz(bot.entity.position.floored()) }); return { ok: false, why: 'ровного места под окоп (яма 1x1, пол вокруг на уровне, без лавы) рядом нет', checked, nodes } }
    cands.sort((a, c) => c.score - a.score)
    let last = null
    for (const c of cands.slice(0, 3)) {
      if (ctl.aborted) break
      log('место окопа', { at: xyz(c.site.P), seen: c.seen, near: c.near, around: c.around, steps: c.steps, prop: c.site.needProp, checked })
      const b = await foxBuild(bot, ctl, mcData, c.site, () => endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 5))
      if (b.ok) {
        try { reach = endermanReach(bot, c.site.out, { radius: 28 }) } catch { reach = null }
        return { ok: true, fox: c.site, placed: b.placed }
      }
      bad.push(c.site.P)
      last = b
      log('окоп не встал', { at: xyz(c.site.P), why: b.why })
      // Злой уже рядом — не бродить по местам, бой решит основной цикл.
      if (endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 8)) break
    }
    return last || { ok: false, why: 'окоп не построился' }
  }
  let lastChance = gameClock.now()
  let lastPeek = gameClock.now()
  let lastPoke = 0
  let pokes = 0
  let lastNear = gameClock.now()
  let lastReach = gameClock.now()
  let stalks = 0
  let openFights = 0
  const avoid0 = bot._ndMobAvoidOnly
  bot._ndMobAvoidOnly = FOX_AVOID
  // Злой уже в 5 блоках, а мы не в яме (вышли за жемчугом, не вернулись) —
  // бой на месте со щитом (как дуэль), а не поиск места под окоп у него под рукой.
  const fightOpen = async () => {
    const me = bot.entity.position
    const em: any = endermen().filter((e : any) => angry(e) && !ignored(e) && e.position.distanceTo(me) < 5).sort((a: any, c: any) => a.position.distanceTo(me) - c.position.distanceTo(me))[0]
    if (!em) return false
    openFights++
    const hpA = bot.health ?? 20
    const f: any = await openFight(session, ctl, em, { retreatAt: 6, dead, maxMs: 30000 }).catch(e => ({ error: e.message }))
    const r: any = { id: em.id, open: true, killed: dead.has(em.id), swings: f && f.swings, hpLost: Math.round((hpA - (bot.health ?? 20)) * 10) / 10 }
    if (r.killed) {
      kills++
      await sleep(1500)
      await pickUp(bot, ctl, 6, 2500)
    }
    r.pearls = countOf(bot, 'ender_pearl')
    // Ни одного взмаха (не достать: выше, за блоком) — не крутиться на нём: 20 с мимо
    // (ферма 29.09, foxhole-8 слот 13: «бой снаружи» с 0 взмахов по кругу).
    if (!r.killed && !(f && f.swings)) ignore.set(em.id, gameClock.now() + 20000)
    rounds.push(r)
    log('окоп: бой снаружи', r)
    return true
  }
  // S1f (проверка S1e (г)): «тело в своём окопе» — для тактики: стрелков вдали (гаст, скелет) окоп держит сам (крыша), охоту не рвать.
  bot._ndInFoxhole = () => !!fox && !!inHole()
  try {
    fox = foxHere(bot, mcData)
    if (fox) { try { reach = endermanReach(bot, fox.out, { radius: 28 }) } catch {} ; log('окоп: уже в нём', { at: xyz(fox.P) }) }
    else {
      const s = await newSite()
      log('окоп', s.ok ? { at: xyz(s.fox.P), placed: s.placed } : s)
      if (!s.ok) stopped = s.why
      else fox = s.fox
    }
    while (fox && !ctl.aborted) {
      if (countOf(bot, 'ender_pearl') >= want) break
      if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
      // Без кирки окоп не копается — выйти, пусть этап сделает запасные (campaign spares).
      if (!bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) { stopped = 'кирка кончилась'; break }
      if (!inHole()) {
        if (await fightOpen()) continue
        const ok = await foxEnter(bot, ctl, fox)
        if (!ok) {
          log('окоп: не вернулся', { at: xyz(bot.entity.position) })
          if (await fightOpen()) continue
          bad.push(fox.P)
          const s = await newSite()
          if (!s.ok) { stopped = `в окоп не вернулся, новый не вышел: ${s.why}`; break }
          fox = s.fox
          moves++
          continue
        }
      }
      // Есть и лечиться — в окопе безопасно.
      if ((bot.food ?? 20) <= 16 || ((bot.health ?? 20) < 16 && (bot.food ?? 20) < 20)) { try { await require('./actions').eat(session, {}) } catch {} }
      const all = endermen()
      for (const e of (all as any)) {
        if (!angry(e)) { angrySince.delete(e.id); continue }
        recentAngry.set(e.id, gameClock.now())
        if (!angrySince.has(e.id)) angrySince.set(e.id, gameClock.now())
        else if (gameClock.now() - angrySince.get(e.id) > 25000 && reachTo(bot, e) > 3.2) ignore.set(e.id, gameClock.now() + 60000)
      }
      // 1. В досягаемости — бить в тело (в глаза не смотреть).
      // Запас 0.2 до 3.0: сервер меряет досягаемость от своей позиции тела, и на краю
      // взмахи не засчитывались (foxhole-11, слот 19: 31 взмах, эндермен жив).
      const zpNear = ents(bot).filter((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(bot.entity.position) < 8)
      const near: any = all.filter((e : any) => reachTo(bot, e) <= 2.8 && safeAim(bot, e) && !zpNear.some((o : any) => o.position.distanceTo(e.position) < 3)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
      if (near) {
        lastReach = gameClock.now()
        if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
        const r: any = { id: near.id, t: Math.round((gameClock.now() - t0) / 1000), swings: 0, angry: angry(near) }
        const hpA = bot.health ?? 20
        const onMe0 = hitsOnMe
        let last = 0
        const tA = gameClock.now()
        let gone = 0
        // Сколько взмахов дошло (его entityHurt) — на ферме бывало 31–37 взмахов без
        // убийства, а он в это время бил нас в яме (foxhole-13, слоты 15 и 19).
        let landed = 0
        const onHit = e => { if (e && e.id === near.id) landed++ }
        bot.on('entityHurt', onHit)
        // Щит между взмахами: яма бережёт от луча, но не от всего (эндермен уносит
        // блоки стенки — нилий #enderman_holdable — и бьёт сбоку).
        const guard = require('./combat').makeShield(session, ctl, { shield: 'ranged' })
        try {
          await guard.wear()
          while (!ctl.aborted && gameClock.now() - tA < 30000 && near.isValid !== false && bot.entities[near.id] && !dead.has(near.id)) {
            const aim = reachTo(bot, near) <= 2.8 ? safeAim(bot, near) : null
            if (!aim) { if (!gone) gone = gameClock.now(); if (gameClock.now() - gone > 6000) break; await sleep(100); continue }
            gone = 0
            try { await bot.lookAt(aim.pt, true) } catch {}
            if (gameClock.now() - last >= SWING_MS) {
              await guard.raise(false)
              if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
              try { bot.attack(near); r.swings++; hits++; last = gameClock.now() } catch {}
            } else if (gameClock.now() - last > 150) await guard.raise(true)
            await sleep(60)
          }
        } finally {
          bot.removeListener('entityHurt', onHit)
          try { await guard.raise(false) } catch {}
          guard.close()
        }
        r.landed = landed
        pitchCap = -0.35
        await sleep(250)
        r.killed = dead.has(near.id)
        r.hpLost = Math.round((hpA - (bot.health ?? 20)) * 10) / 10
        r.hitsOnMe = hitsOnMe - onMe0
        if (r.killed) {
          kills++
          lastChance = gameClock.now()
          const at = near.position.clone()
          await sleep(1500)
          const had = countOf(bot, 'ender_pearl')
          const lying = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(at) < 8 && !lavaAround(bot, e.position))
          r.drop = lying.length
          // Не подобралось из ямы само, злых рядом нет — выйти и подобрать.
          if (lying.length && !endermen().some((e : any) => angry(e) && !ignored(e) && e.position.distanceTo(bot.entity.position) < 12)) {
            if (await foxExit(bot, ctl, mcData, fox)) {
              for (const it of (lying as any)) {
                if (!bot.entities[it.id] || ctl.aborted) continue
                // S1e: до 1 бл. по горизонтали, а не «в клетку предмета» (лаборатория s1e-L3: 18 убийств → подобрано 2, «собрал лежащий
                // жемчуг got 0» ×122 — жемчуг на крыше окопа и на наростах, клетка недостижима); коробка подбора (+1 вширь, +0.5 вверх)
                // достаёт его с соседней клетки.
                await walkTo(bot, ctl, it.position, 1, 5000, () => endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 6), true)
                await sleep(300)
              }
              await foxEnter(bot, ctl, fox)
            }
          }
          r.got = countOf(bot, 'ender_pearl') - had
        } else skip.set(near.id, gameClock.now() + 15000)
        r.pearls = countOf(bot, 'ender_pearl')
        rounds.push(r)
        log('окоп: бой', r)
        continue
      }
      // 2. Злые идут — ждать (взгляд вниз).
      const pend = pending()
      if (pend.length) { lastChance = gameClock.now(); lastReach = gameClock.now(); await sleep(400); continue }
      // 3. Злить отсюда: глаза видно из ямы (щель под крышей).
      const pool = starePool()
      if (pool.length) {
        lastChance = gameClock.now()
        await stare(pool[0], 5000)
        continue
      }
      // 4. Глаз не видно и из ямы, и с земли (искажённый лес: на ферме 0 видимых
      // глаз при 4–7 эндерменах в 24 блоках) — удар-вызов ближнего спокойного:
      // выйти, дойти (до POKE_R от ямы), ударить раз и сразу назад под крышу.
      // Удар живого не телепортирует (EnderMan.hurtServer); злой идёт за нами
      // к яме и там уже не достаёт. Соседей у него в 3 блоках нет — взмах мечом
      // задевает соседей и злит и их. Дойти до ямы он должен уметь (reach).
      const hole = fox.P.offset(0.5, 0, 0.5)
      const pool2 = endermen()
      if (pool2.some((e : any) => !trappedEm(bot, e) && e.position.distanceTo(hole) <= POKE_R && canCome(e))) lastNear = gameClock.now()
      if (p.poke === true && gameClock.now() - lastPoke > 6000) {
        const calm: any = pool2.filter((e : any) => !angry(e) && !skipped(e) && !trappedEm(bot, e) && e.position.distanceTo(hole) <= POKE_R &&
          Math.abs(e.position.y - fox.P.y) <= 6 && canCome(e) && !pool2.some((o : any) => o !== e && o.position.distanceTo(e.position) < 3))
          .sort((a: any, c: any) => a.position.distanceTo(hole) - c.position.distanceTo(hole))[0]
        // Раз в 30 с — почему некого звать (кто в POKE_R и что мешает).
        if (!calm && gameClock.now() - (huntFoxhole._why || 0) > 30000) {
          huntFoxhole._why = gameClock.now()
          const why = {}
          const inc = k => { why[k] = (why[k] || 0) + 1 }
          for (const e of (pool2 as any)) {
            if (e.position.distanceTo(hole) > POKE_R) continue
            if (angry(e)) inc('злой')
            else if (skipped(e)) inc('пропуск')
            else if (trappedEm(bot, e)) inc('заперт')
            else if (Math.abs(e.position.y - fox.P.y) > 6) inc('высота')
            else if (!canCome(e)) inc('не дойдёт')
            else inc('сосед')
          }
          if (Object.keys(why).length) log('окоп: звать некого', why)
        }
        if (calm) {
          lastPoke = gameClock.now()
          pokes++
          const pk: any = { id: calm.id, from: Math.round(calm.position.distanceTo(hole)), hit: false }
          const hp1 = bot.health ?? 20
          if (await foxExit(bot, ctl, mcData, fox)) {
            const tP = gameClock.now()
            bot._ndNoMobAvoid = true
            try {
              while (!ctl.aborted && gameClock.now() - tP < 10000 && calm.isValid !== false && bot.entities[calm.id] && !angry(calm)) {
                if (reachTo(bot, calm) <= 2.9) {
                  const a = require('./pick').aim(bot, calm)
                  if (a && a.point) {
                    if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
                    try { await bot.lookAt(calm.position.offset(0, 0.6, 0), true) } catch {}
                    try { bot.attack(calm); pk.hit = true } catch {}
                    break
                  }
                }
                await walkTo(bot, ctl, calm.position.floored(), 1, 1500)
              }
            } finally { bot._ndNoMobAvoid = false }
            // Разозлили — бой тут же, лицом и со щитом (openFight: один на один,
            // двое злых в 6 блоках или мало хп — выход), а не бегом к яме спиной
            // к нему: на ферме злой догонял и бил по дороге (foxhole-9 слот 13:
            // −8.8 хп за обратный путь с 15 блоков, потом смерть у ямы).
            if (pk.hit && angry(calm) && calm.isValid !== false && bot.entities[calm.id]) {
              const f: any = await openFight(session, ctl, calm, { retreatAt: 10, dead, maxMs: 30000 }).catch(e => ({ error: e.message }))
              pk.fight = { killed: dead.has(calm.id), swings: f && f.swings, crowd: f && f.crowd || undefined, stale: f && f.stale || undefined }
              if (pk.fight.killed) {
                kills++
                await sleep(1500)
                await pickUp(bot, ctl, 6, 2500)
              }
            }
            await foxEnter(bot, ctl, fox)
            pk.angry = angry(calm)
            pk.s = Math.round((gameClock.now() - tP) / 1000)
            pk.hpLost = Math.round((hp1 - (bot.health ?? 20)) * 10) / 10
            pk.pearls = countOf(bot, 'ender_pearl')
            log('окоп: удар-вызов', pk)
            if (pk.angry) { aggros++; lastChance = gameClock.now() } else skip.set(calm.id, gameClock.now() + 30000)
          } else log('окоп: удар-вызов — из ямы не вышел', { id: calm.id, at: xyz(bot.entity.position) })
          continue
        }
      }
      // 5. Выглянуть: крышу долой, на землю, злить взглядом до двух с полного
      // роста, и сразу назад под крышу. Раз в 45 с: на ферме с земли глаза
      // видно редко (выглядывал 30+ раз — «seen 0»), а каждый выход — риск.
      // Злой рядом (даже «забытый» — застрял или 25 с не подходил) — из ямы не
      // выходить: он и выйдет нам навстречу. Злость эндермена гаснет за 20–39 с
      // (NeutralMob, PERSISTENT_ANGER_TIME). foxhole-11, слот 19: выход к новому
      // месту при злом рядом — 16 → 2 хп и смерть.
      if (endermen().some((e : any) => hot(e) && !trappedEm(bot, e) && e.position.distanceTo(bot.entity.position) < 20)) { await sleep(700); continue }
      // Выглядывать — только по просьбе (peek: true): глаз с земли в лесу почти не видно
      // (ферма: «seen 0» в 30+ выглядываниях), а каждый выход — копка крыши и износ кирки.
      if (p.peek === true && gameClock.now() - lastPeek > 45000) {
        lastPeek = gameClock.now()
        peeks++
        if (await foxExit(bot, ctl, mcData, fox)) {
          const out = starePool(28)
          let n = 0
          for (const t of out.slice(0, 4)) {
            if (n >= 2 || ctl.aborted) break
            if (endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 10)) break
            if (await stare(t, 4000)) n++
          }
          if (out.length) lastChance = gameClock.now()
          await foxEnter(bot, ctl, fox)
          log('окоп: выглянул', { seen: out.length, angered: n })
        }
        continue
      }
      // 6. Подкрасться: в досягаемости из ямы никого 5 с — к ближнему спокойному
      // (до 40 блоков), окоп вплотную к нему (1.2–2.6 блока), и бить его из ямы:
      // злой рядом, но луча к нам нет — не бьёт (MeleeAttackGoal: hasLineOfSight).
      // Бой в открытую (удар-вызов с 15 блоков) убивал: ферма 29.09, foxhole-9 —
      // 3 смерти из 4 после вызова («slain by Enderman», −9…−12 хп на обратном пути).
      // 5б. Жемчуг лежит рядом (выпал, а подобрать не дали злые, или с прошлого
      // вызова) — злых поблизости нет: выйти и собрать (основной бот 29.09 18:09:
      // «drop 1, got 0» — единственный за 400 с жемчуг остался лежать).
      {
        const lying = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) &&
          e.position.distanceTo(bot.entity.position) < 16 && !lavaAround(bot, e.position))
        if (lying.length && !endermen().some((e : any) => hot(e) && e.position.distanceTo(bot.entity.position) < 10)) {
          const had = countOf(bot, 'ender_pearl')
          if (await foxExit(bot, ctl, mcData, fox)) {
            for (const it of (lying as any)) {
              if (!bot.entities[it.id] || ctl.aborted) continue
              await walkTo(bot, ctl, it.position, 1, 6000, () => endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 6), true)
              await sleep(300)
            }
          }
          log('окоп: собрал лежащий жемчуг', { lying: lying.length, got: countOf(bot, 'ender_pearl') - had })
          continue
        }
      }
      if (gameClock.now() - lastReach > 5000 && stalks < 20) {
        const me = bot.entity.position
        // Зомби-пиглины рядом с целью — нет: взмах задевает соседей, и злится вся стая
        // (foxhole-14r: «slain by Zombified Piglin»; то же правило у дуэли).
        const zp = ents(bot).filter((o : any) => o && o.name === 'zombified_piglin' && o.position)
        // Только тех, к кому есть клетка «куда дойду» в 1.2–2.6 блока по горизонтали и
        // ±1 по высоте: выбор «ближайшего по прямой» слал к эндерменам на уступах —
        // «мест нет, nodes 0» и «время вышло» по кругу (основной бот 29.09, 18:02–18:09).
        const { walkable } = require('./walkable')
        const from = bot.entity.position.floored().equals(fox.H) ? fox.out : me
        const flood = walkable(bot, from, { radius: 40, maxNodes: 12000 })
        const spotFor = e => {
          let best = null
          for (const n of flood) {
            const dh = Math.hypot(n.pos.x + 0.5 - e.position.x, n.pos.z + 0.5 - e.position.z)
            if (dh < 1.2 || dh > 2.6 || Math.abs(n.pos.y - Math.floor(e.position.y)) > 1) continue
            if (!best || n.d < best.d) best = n
          }
          return best
        }
        const pick = endermen().filter((e : any) => !hot(e) && !skipped(e) && !trappedEm(bot, e) && e.position.distanceTo(me) < 40 && !zp.some((o : any) => o.position.distanceTo(e.position) < 8))
          .map(e => ({ e, n: spotFor(e) })).filter(x => x.n).sort((a, c) => a.n.d - c.n.d)[0]
        const t: any = pick && pick.e
        // Брут, хоглин, гаст рядом — из окопа не выходить ни сдвинуться, ни подкрасться (chain6-14 30.09: окоп у
        // бастиона, «минуту некого злить — сдвинуться», вышел — брут; разбор Codex).
        const foesNear = ents(bot).some((e : any) => e && e.position && ((/^(piglin_brute|hoglin|zoglin|wither_skeleton)$/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 24) || (e.name === 'ghast' && e.position.distanceTo(bot.entity.position) < 48)))
        if (foesNear) { lastChance = gameClock.now(); await sleep(700); continue }
        if (!t) {
          // Спокойных, к кому дойти, в 40 нет — старое правило: минуту некого злить — сдвинуться.
          if (gameClock.now() - lastChance > 60000 && moves < 6) {
            moves++
            used.push(fox.P)
            await foxExit(bot, ctl, mcData, fox)
            const s = await newSite()
            log('окоп: новое место', s.ok ? { at: xyz(s.fox.P), n: moves } : s)
            if (s.ok) fox = s.fox
            lastChance = gameClock.now()
          }
          await sleep(700)
          continue
        }
        stalks++
        lastReach = gameClock.now()
        used.push(fox.P)
        await foxExit(bot, ctl, mcData, fox)
        const st: any = { id: t.id, from: Math.round(t.position.distanceTo(bot.entity.position)), steps: pick.n.d }
        if (pick.n.pos.distanceTo(bot.entity.position) > 2) {
          const g = pick.n.pos
          const w = await walkTo(bot, ctl, g, 1, 15000, () => endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 6))
          st.walk = w.ok ? 'ok' : w.error
        }
        if (!bot.entities[t.id] || t.isValid === false || angry(t)) { st.why = 'ушёл или злой'; log('окоп: подкрасться', st); skip.set(t.id, gameClock.now() + 20000); continue }
        const s = await newSite({ near: t.position.clone() })
        st.site = s.ok ? xyz(s.fox.P) : s.why
        st.dist = s.ok ? Math.round(t.position.distanceTo(s.fox.P.offset(0.5, 0, 0.5)) * 10) / 10 : undefined
        log('окоп: подкрасться', st)
        if (s.ok) { fox = s.fox; lastChance = gameClock.now() } else skip.set(t.id, gameClock.now() + 30000)
        continue
      }
      await sleep(700)
    }
  } finally {
    bot._ndInFoxhole = null
    bot._ndMobAvoidOnly = avoid0
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entityDead', onDead)
    bot.removeListener('entityGone', onGone)
    bot.removeListener('entityHurt', onMeHurt)
    bot.removeListener('physicsTick', capPitch)
  }
  // Жемчуга хватает — наружу (дальше идти ногами); нет — сидеть в окопе до следующего вызова.
  if (fox && countOf(bot, 'ender_pearl') >= want) await foxExit(bot, ctl, mcData, fox).catch(() => false)
  const pearls = countOf(bot, 'ender_pearl')
  const secs = Math.round((gameClock.now() - t0) / 1000)
  const detail: any = {
    mode: 'hunt',
    style: 'окоп',
    pearls: { before: pearls0, now: pearls, gained: pearls - pearls0, want },
    kills,
    aggros,
    stares,
    peeks,
    pokes,
    stalks,
    openFights,
    moves,
    hits,
    hitsOnMe,
    killsPerHour: secs ? Math.round(kills * 3600 / secs) : 0,
    rounds: rounds.slice(-10),
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    seconds: secs
  }
  if (pearls < want) {
    detail.need = { what: 'ender_pearl', count: want - pearls, have: pearls }
    detail.stopped = `${stopped || 'встал'} — жемчуга ${pearls} из ${want} (убил ${kills})`
  }
  detail.note = `Жемчуг +${detail.pearls.gained}, убито ${kills} (разозлил ${aggros} из ${stares} взглядов, выглядывал ${peeks}) за ${secs} с (окоп под крышей).`
  return detail
}
declare namespace huntFoxhole {
  let _why: any
}


// ------------------------------------------------------------ hunt: дуэль
// Честный бой один на один (style: 'duel'): эндермен, у которого в 16 блоках
// нет другого, взгляд в глаза с 6..20 блоков, потом combat.fight со щитом
// 'always' (его удар в поднятый щит гасится целиком и отбрасывает его). Между
// боями — еда. Меряем убийства в час и хп за убийство.
async function huntDuel (session, ctl, p: any = {}) {
  const bot = session.bot
  const combat = require('./combat')
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const pearls0 = countOf(bot, 'ender_pearl')
  const want = pearls0 + Math.max(1, p.count ?? 4)
  const hp0 = Math.round(bot.health ?? 20)
  const retreatAt = clamp(p.retreatAtHealth ?? 9, 4, 16)
  const rounds = []
  const skip = new Set()
  const rests = []
  const home0 = bot.entity.position.clone()
  // Убит — по смерти (entityDead) или пропаже в 12 блоках через <3 с после
  // нашего удара; «isValid false» бывает и у ушедшего телепортом (дуэль 4:
  // «убит» с двух взмахов).
  const deadIds = new Set()
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'enderman') hurtAt.set(e.id, gameClock.now()) }
  const onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || !e.position) return
    if (e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    deadIds.add(e.id)
  }
  const onGone = e => onDead(e, 'gone')
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  // Взгляд вниз всегда, кроме нарочного взгляда в глаза выбранному. Эндермен
  // злится на взгляд в глаза (EnderMan.isLookingAtMe: угол до его глаз меньше
  // acos(1 − 0.025/d) — 2.9° на 20 блоках), а тело ходило и дралось с pitch
  // около 0 и злило чужих: «второй злой» — в смертях дуэлей 1–7 (лаборатория
  // 2026-09-27); вблизи (< 4 бл.) взгляд в глаза ещё и телепортирует его прочь
  // посреди боя (EndermanLookForPlayerGoal.tick). В бою −20°: прицел на его
  // ногах и поясе (внутри его коробки до 3 блоков), до его глаз ≥ 30°.
  const onMeHurt = victim => {
    if (victim !== bot.entity) return
    const me = bot.entity.position
    const near = (Object.values(bot.entities) as any[]).filter((e : any) => e && e !== bot.entity && e.position && e.position.distanceTo(me) < 5 && e.type !== 'object' && e.name !== 'item')
      .map((e : any) => [e.name, e.id, Math.round(e.position.distanceTo(me) * 10) / 10, meta(bot, e, 'creepy') ? 1 : 0])
    log('удар по мне', { hp: Math.round((bot.health ?? 0) * 10) / 10, near })
  }
  bot.on('entityHurt', onMeHurt)
  let pitchCap = -0.5
  const capPitch = () => { if (pitchCap !== null && bot.entity && bot.entity.pitch > pitchCap) bot.entity.pitch = pitchCap }
  bot.on('physicsTick', capPitch)
  const ignoreAngry = new Map()
  // Где драться можно: в 2 блоках вокруг нет обрыва глубже 3 (удар эндермена
  // отбрасывает — прогон 51: «fell from a high place»), лавы в 4 блоках нет
  // (прогон 51: «tried to swim in lava to escape Ghast»).
  const safeSpot = (f) => {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        let depth = 0
        for (let dy = -1; dy >= -5; dy--) {
          const b = bot.blockAt(f.offset(dx, dy, dz))
          if (!b) break
          if (/lava/.test(b.name)) return false
          if (b.boundingBox === 'block') break
          depth++
        }
        if (depth > 3) return false
      }
    }
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -3; dy <= 1; dy++) { const b = bot.blockAt(f.offset(dx, dy, dz)); if (b && /lava/.test(b.name)) return false }
    return true
  }
  const angryClose = r => ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !deadIds.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < r)
  // Кого злить (глаза видно строгим лучом отсюда): 6..28 блоков, рядом с ним
  // никого в 3 и злых в 16 (кроме застрявших), пиглинов в 10 нет, не в яме,
  // не дальше 64 от места старта.
  const pickTarget = (all, me) => all.filter(e => !skip.has(e.id) && eyesSeen(bot, e))
    .filter(e => { const d = e.position.distanceTo(me); return d >= 6 && d <= 28 })
    .filter(e => !all.some(o => o !== e && (o.position.distanceTo(e.position) < 3 || (meta(bot, o, 'creepy') && !((ignoreAngry.get(o.id) || 0) > gameClock.now()) && !trappedEm(bot, o) && o.position.distanceTo(e.position) < 16))))
    .filter(e => !ents(bot).some((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(e.position) < 10))
    .filter(e => e.position.distanceTo(home0) < 64 && !trappedEm(bot, e))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
  // Откуда видно больше глаз: заливка «куда дойду» (24), каждая третья клетка
  // (до 200), луч от глаз клетки к глазам эндерменов 6..28 — как в pillarUp.
  const vantage = (all) => {
    const { walkable } = require('./walkable')
    const nodes = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 3000 })
    const ems = all.filter(e => !skip.has(e.id) && !trappedEm(bot, e) && e.position.distanceTo(home0) < 64)
    if (!ems.length) return null
    let best = null
    let checked = 0
    for (let i = 0; i < nodes.length && checked < 200; i += 3) {
      const n = nodes[i]
      if (n.d < 3) continue
      if (!safeSpot(n.pos)) continue
      checked++
      const eye = n.pos.offset(0.5, 1.62, 0.5)
      let seen = 0
      for (const e of ems) {
        const d = e.position.distanceTo(eye)
        if (d < 6 || d > 28) continue
        if (clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++
      }
      const score = seen * 10 - n.d * 0.2
      if (seen && (!best || score > best.score)) best = { pos: n.pos, seen, score, d: n.d }
    }
    return best ? { ...best, checked } : null
  }
  const lookout = async () => {
    const feet = bot.entity.position.floored()
    const res: any = {}
    if (angryClose(10)) return { why: 'злой рядом' }
    for (let y = 2; y <= 5; y++) { const b = bot.blockAt(feet.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || /lava|water/.test(b.name)) return { why: 'над головой нет 4 блоков воздуха' } }
    if (lavaAround(bot, feet) || lavaAround(bot, feet.offset(0, -1, 0))) return { why: 'лава рядом' }
    try { await require('./fortify').centerInCell(bot, 600) } catch {}
    const up = await towerUp(bot, ctl, 3)
    res.placed = up.placed || 0
    const top = bot.entity.position.floored()
    if (top.y - feet.y >= 2) {
      let target = null
      for (let k = 0; k < 4 && !target && !ctl.aborted && !angryClose(6); k++) {
        const all2 = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false)
        target = pickTarget(all2, bot.entity.position)
        if (k === 0) { const me3 = bot.entity.position; const inR = all2.filter((e : any) => { const d = e.position.distanceTo(me3); return d >= 6 && d <= 28 }); res.inRange = inR.length; clearRay.stats = {}; res.eyesTop = inR.filter(e => eyesSeen(bot, e)).length; res.blockedBy = clearRay.stats; res.y = Math.round(me3.y) }
        if (!target) { try { await bot.look(bot.entity.yaw + Math.PI / 2, -0.5, true) } catch {} ; await sleep(600) }
        else res.eyes = all2.filter(e => eyesSeen(bot, e)).length
      }
      if (target) {
        res.from = Math.round(target.position.distanceTo(bot.entity.position))
        pitchCap = null
        const tA = gameClock.now()
        while (!ctl.aborted && gameClock.now() - tA < 5000 && !meta(bot, target, 'creepy') && target.isValid !== false) {
          if (eyesSeen(bot, target)) await bot.lookAt(target.position.offset(0, 2.55, 0), true).catch(() => {})
          await sleep(100)
        }
        pitchCap = -0.5
        res.angry = !!meta(bot, target, 'creepy')
        if (!res.angry) skip.add(target.id)
      }
    } else res.why = `столб не вышел: ${up.reason || ''}`
    // Вниз: свой столб из-под ног (блоки — в рюкзак).
    for (let i = 0; i < 5 && !ctl.aborted; i++) {
      const f = bot.entity.position.floored()
      if (f.y <= feet.y) break
      const e2 = await digCell(bot, session.mcData, f.offset(0, -1, 0))
      if (e2) { res.down = e2; break }
      await sleep(300)
    }
    try { await bot.look(bot.entity.yaw, -0.5, true) } catch {}
    return res
  }
  let angryWait = 0
  let kills = 0
  let hpSpent = 0
  let stopped = null
  let idle = 0
  while (!ctl.aborted) {
    if (countOf(bot, 'ender_pearl') >= want) break
    if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
    // Лечиться до боя: сытость 18+ и хп 16+. Хп мало — в коробку 1x1 с
    // крышей (blaze.boxRest): злой эндермен без луча не бьёт (MeleeAttackGoal:
    // hasLineOfSight) и через 60 тиков теряет цель (лаборатория, дуэль 1:
    // двоих убил, третий злой пришёл на 12 хп — смерть).
    // Злой уже рядом — бой (от эндермена не уйти: телепорт), коробка при нём
    // не закрывается («в клетке стоит enderman», дуэль 2: смерть).
    const me0 = bot.entity.position
    const angryNow = ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && meta(bot, e, 'creepy') && e.position.distanceTo(me0) < 16)
    if ((bot.health ?? 20) < 16 && !angryNow) {
      const r = await require('./blaze').boxRest(session, ctl, { toward: null, until: 19, maxMs: 60000 }).catch(e => ({ rested: false, why: e.message }))
      rests.push({ hp: r.hp, s: r.seconds, ok: r.rested, why: r.why })
      log('отдых', r)
      if (!r.rested) { try { await require('./actions').eat(session, {}) } catch {} ; await sleep(1500) }
      continue
    }
    if ((bot.food ?? 20) <= 17) { try { await require('./actions').eat(session, {}) } catch {} }
    const me = bot.entity.position
    const all = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false)
    const angry = all.filter((e : any) => meta(bot, e, 'creepy') && e.position.distanceTo(me) < 16 && (e.position.distanceTo(me) < 4 || (!skip.has(e.id) && seesMob(bot, e))))
    // Злить нового — только если злых в 24 блоках нет вовсе.
    // Злой, который 15 с не подходит (застрял за обрывом), — не в счёт на минуту
    // (прогон дуэли 3: бот простоял 6 минут, ожидая застрявшего).
    const angryNear = all.some((e : any) => meta(bot, e, 'creepy') && e.position.distanceTo(me) < 24 && !((ignoreAngry.get(e.id) || 0) > gameClock.now()))
    let em: any = angry.sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
    const round: any = { t: Math.round((gameClock.now() - t0) / 1000) }
    if (!em && angryNear) {
      if (!angryWait) angryWait = gameClock.now()
      if (gameClock.now() - angryWait > 15000) {
        for (const e of (all as any)) if (meta(bot, e, 'creepy')) ignoreAngry.set(e.id, gameClock.now() + 60000)
        angryWait = 0
      }
      await sleep(1000)
      continue
    }
    angryWait = 0
    const safeHere = safeSpot(bot.entity.position.floored())
    if (!em && safeHere && p.poke !== false && !angryClose(16)) {
      // Глаз не видно (искажённый лес: грибы и лозы — на двойнике мира
      // прохождения 66 эндерменов в 48 блоках, видимых глаз 0; штрек — 0
      // убийств за 400 с): разозлить УДАРОМ. Удар игрока злит эндермена без
      // всякого взгляда и без телепорта (EnderMan.hurtServer: телепорт — только
      // от снаряда или без живого обидчика; цель — обидчик, HurtByTargetGoal).
      const calm: any = all.filter((e : any) => !skip.has(e.id) && !meta(bot, e, 'creepy') && e.position.distanceTo(me) <= 16 && !trappedEm(bot, e) &&
        !all.some((o : any) => o !== e && o.position.distanceTo(e.position) < 4) &&
        !ents(bot).some((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(e.position) < 10) &&
        e.position.distanceTo(home0) < 64 && safeSpot(e.position.floored()))
        .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
      if (calm) {
        const pk: any = { id: calm.id, from: Math.round(calm.position.distanceTo(me)) }
        const tP = gameClock.now()
        while (!ctl.aborted && gameClock.now() - tP < 15000 && calm.isValid !== false && bot.entities[calm.id] && !meta(bot, calm, 'creepy')) {
          if (reachTo(bot, calm) <= 2.9) {
            const a = require('./pick').aim(bot, calm)
            if (a && a.point) {
              const w = bestWeapon(bot)
              if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) { try { await bot.equip(w, 'hand') } catch {} }
              pitchCap = -0.35
              try { await bot.lookAt(calm.position.offset(0, 0.6, 0), true) } catch {}
              try { bot.attack(calm); pk.hit = true } catch {}
              await sleep(400)
              break
            }
          }
          bot._ndNoMobAvoid = true
          try { pk.walk = (await walkTo(bot, ctl, calm.position.floored(), 1, 3000, () => angryClose(6))).error || 'ok' } finally { bot._ndNoMobAvoid = false }
          pk.dist = Math.round(reachTo(bot, calm) * 10) / 10
        }
        pitchCap = -0.5
        pk.angry = !!meta(bot, calm, 'creepy')
        pk.s = Math.round((gameClock.now() - tP) / 1000)
        log('удар-вызов', pk)
        if (pk.angry) { idle = 0; continue }
        skip.add(calm.id); gameClock.setTimeout(() => skip.delete(calm.id), 30000)
      }
    }
    if (!em) {
      const cand = safeHere ? pickTarget(all, me) : null
      if (!cand && idle % 3 === 0) {
        const v = vantage(all)
        if (v) {
          log('обзор', { to: xyz(v.pos), seen: v.seen, steps: v.d, checked: v.checked })
          await walkTo(bot, ctl, v.pos, 0, 15000, () => angryClose(6))
          idle++
          continue
        }
      }
      if (!cand && safeHere && idle % 3 === 1) {
        // С земли в лесу глаз не видно (прогоны 41–44: 20 эндерменов в 6..28,
        // видимых глаз 0): вышка в 3 блока здесь же — осмотреться сверху,
        // разозлить, спуститься и драться на земле (бой на земле 0–3 хп).
        const lo: any = await lookout()
        log('вышка', lo)
        if (lo.angry) { idle = 0; continue }
      }
    }
    if (!em) {
      em = !safeHere ? null : all.filter((e : any) => !skip.has(e.id) && eyesSeen(bot, e))
        // До 28 блоков (прогоны 41–42: в 6..20 ни у кого не видно глаз, 5 мин поиска;
        // допуск взгляда на 28 блоках — 2.4°, lookAt точен, дальний злой
        // телепортируется к нам сам: EndermanLookForPlayerGoal, дальше 16).
        .filter((e : any) => { const d = e.position.distanceTo(me); return d >= 6 && d <= 28 })
        // В лесу по 20 штук в 48 блоках — «никого в 16» не бывает: рядом с ним
        // никого в 6 и ни одного злого в 16.
        .filter((e : any) => !all.some((o : any) => o !== e && (o.position.distanceTo(e.position) < 3 || (meta(bot, o, 'creepy') && !((ignoreAngry.get(o.id) || 0) > gameClock.now()) && !trappedEm(bot, o) && o.position.distanceTo(e.position) < 16))))
        // Зомби-пиглины рядом — нет: удар с размаха задевает соседей, и стая злится
        // (дуэль 5: «slain by Zombified Piglin»).
        .filter((e : any) => !ents(bot).some((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(e.position) < 10))
        // Далеко от места старта не уходить (искажённый лес кончается).
        .filter((e : any) => e.position.distanceTo(home0) < 64 && !trappedEm(bot, e))
        .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
      if (!em) {
        if (++idle > 6) {
          idle = 0
          // Далеко ушли — назад к месту старта, иначе поиск дальше.
          if (bot.entity.position.distanceTo(home0) > 40 || bot.entity.position.y < home0.y - 10) { await walkTo(bot, ctl, home0.floored(), 4, 20000); continue }
          {
            const me1 = bot.entity.position
            const inR = all.filter((e : any) => { const d = e.position.distanceTo(me1); return d >= 6 && d <= 28 })
            const eyes = inR.filter(e => eyesSeen(bot, e))
            log('никого', { all: all.length, inRange: inR.length, eyes: eyes.length, angry: all.filter(e => meta(bot, e, 'creepy')).length, trapped: all.filter(e => trappedEm(bot, e)).length, skip: skip.size, y: Math.round(me1.y) })
          }
          const w = await searchWalk(bot, ctl, 24, () => angryClose(6), { high: true })
          log('поиск', { to: w })
        } else await sleep(1500)
        continue
      }
      idle = 0
      pitchCap = null
      const tA = gameClock.now()
      let looks = 0
      while (!ctl.aborted && gameClock.now() - tA < 5000 && !meta(bot, em, 'creepy') && em.isValid !== false) {
        if (eyesSeen(bot, em)) { await bot.lookAt(em.position.offset(0, 2.55, 0), true); looks++ }
        await sleep(100)
      }
      pitchCap = -0.5
      round.looks = looks
      if (!meta(bot, em, 'creepy')) { skip.add(em.id); continue }
    } else round.already = true
    try { await bot.look(bot.entity.yaw, -0.5, true) } catch {}
    const hpA = bot.health ?? 20
    // До конца: отход от эндермена бесполезен, бой кончается его смертью или нашей;
    // новые бои — только с 16+ хп (отдых в коробке до них).
    // Свой бой (openFight): ждать его на месте со щитом, бить в тело сразу
    // после его взмаха. combat.fight с опущенным взглядом не бил (прогон 38:
    // 4 боя, 0–4 взмаха, 0 убийств), а без него злил чужих.
    pitchCap = -0.35
    // Двое злых уже в 8 блоках — сразу столб, без боя на земле (двойник мира
    // прохождения: трое злых сняли 20 хп за 12 с).
    const crowdNow = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !deadIds.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < 8).length >= 2
    let f: any = crowdNow ? { crowd: true, swings: 0 } : await openFight(session, ctl, em, { retreatAt: 13, dead: deadIds, maxMs: 40000 }).catch(e => ({ error: e.message }))
    pitchCap = -0.5
    // Хп 10 и он жив — столб в 3 блока прямо здесь: его коробка удара раздута
    // только по горизонтали, до ног на +3 он не достаёт, а меч сверху бьёт его
    // голову (дуэль 3: смерть на 12 хп от второго злого).
    if (em.isValid !== false && bot.entities[em.id] && !ctl.aborted && ((bot.health ?? 20) <= 13 || f.crowd)) {
      const base = bot.entity.position.floored()
      const up = await towerUp(bot, ctl, 3)
      round.pillar = up.placed
      const w = bestWeapon(bot)
      if (w) { try { await bot.equip(w, 'hand') } catch {} }
      const tP = gameClock.now()
      let last = 0
      let nearAt = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tP < 30000 && em.isValid !== false && bot.entities[em.id]) {
        // Злые к столбу не идут 10 с (стоят в 6+ блоках) — слезть и дальше: на
        // двойнике три столба подряд по 35 с без единого взмаха.
        if (ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !deadIds.has(e.id) && meta(bot, e, 'creepy') && reachTo(bot, e) < 6)) nearAt = gameClock.now()
        if (gameClock.now() - nearAt > 10000) break
        // Со столба бьём любого злого, кто под нами в досягаемости (их бывает двое).
        const near: any = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !deadIds.has(e.id) && meta(bot, e, 'creepy') && reachTo(bot, e) <= 3.0)
          .sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0] || em
        const r = reachTo(bot, near)
        try { await bot.lookAt(near.position.offset(0, 2.2, 0), true) } catch {}
        if (r <= 3.0 && gameClock.now() - last >= SWING_MS) { try { bot.attack(near); last = gameClock.now() } catch {} }
        if ((bot.food ?? 20) < 18 && r > 4) { try { await require('./actions').eat(session, {}) } catch {} }
        await sleep(80)
      }
      f = { ...f, killed: em.isValid === false || !bot.entities[em.id], fromPillar: true }
      // Вниз: свой столб из-под ног.
      for (let i = 0; i < 4 && !ctl.aborted; i++) {
        const feet = bot.entity.position.floored()
        if (feet.y <= base.y) break
        const e2 = await digCell(bot, session.mcData, feet.offset(0, -1, 0))
        if (e2) break
        await sleep(400)
      }
    }
    const lost = Math.max(0, hpA - (bot.health ?? 0))
    hpSpent += lost
    await sleep(300)
    if (f.target && f.target !== em) { round.retarget = f.retargets; em = f.target }
    round.killed = deadIds.has(em.id)
    round.swings = f.swings
    if (f.stale) { round.stale = true; ignoreAngry.set(em.id, gameClock.now() + 60000) }
    round.his = f.hisSwings
    round.blocked = f.blocked
    round.hpLost = Math.round(lost * 10) / 10
    round.why = f.error || f.stopped || f.mode || undefined
    if (round.killed) {
      kills++
      // Лут падает, когда тело убирают (через 20 тиков после смерти), там, где
      // он умер, — а отброс ударом уносит его на 2–4 блока (прогон 40: 6
      // убийств, 1 жемчуг: подбор в 6 блоках от себя сразу после боя).
      const deathAt = em.position.clone()
      await sleep(1300)
      const isPearl = e => { try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'ender_pearl' } catch { return false } }
      let drops = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(deathAt) < 10 && !lavaAround(bot, e.position))
      if (!drops.length) {
        // Метаданные предмета приходят позже самого предмета — ещё раз через 1.5 с.
        await sleep(1500)
        drops = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(deathAt) < 12 && !lavaAround(bot, e.position))
      }
      round.drop = drops.length
      round.items = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(deathAt) < 12).map((e : any) => { try { const it = e.getDroppedItem(); return it ? it.name : '?' } catch { return '!' } }).join(',') || undefined
      round.pearlsNow = countOf(bot, 'ender_pearl')
      for (const d of (drops as any)) {
        if (!bot.entities[d.id] || ctl.aborted) continue
        await walkTo(bot, ctl, d.position.floored(), 0, 7000)
        await pickUp(bot, ctl, 3, 1500)
      }
      await pickUp(bot, ctl, 6, 2000)
    } else { skip.add(em.id); gameClock.setTimeout(() => skip.delete(em.id), 20000) }
    rounds.push(round)
    log('дуэль', round)
    if ((bot.health ?? 20) <= retreatAt) {
      // Отойти и отъесться: злых рядом нет — есть; есть — уйти.
      try { await require('./actions').eat(session, {}) } catch {}
    }
  }
  bot.removeListener('entityHurt', onHurt)
  bot.removeListener('entityDead', onDead)
  bot.removeListener('entityGone', onGone)
  bot.removeListener('physicsTick', capPitch)
  bot.removeListener('entityHurt', onMeHurt)
  const pearls = countOf(bot, 'ender_pearl')
  const secs = Math.round((gameClock.now() - t0) / 1000)
  const detail: any = {
    mode: 'hunt',
    style: 'дуэль',
    pearls: { before: pearls0, now: pearls, gained: pearls - pearls0, want },
    kills,
    hpPerKill: kills ? Math.round(hpSpent / kills * 10) / 10 : null,
    killsPerHour: secs ? Math.round(kills * 3600 / secs) : 0,
    rests: rests.length ? rests : undefined,
    rounds: rounds.slice(-10),
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    seconds: secs
  }
  if (pearls < want) {
    detail.need = { what: 'ender_pearl', count: want - pearls, have: pearls }
    detail.stopped = `${stopped || 'встал'} — жемчуга ${pearls} из ${want} (убил ${kills})`
  }
  detail.note = `Жемчуг +${detail.pearls.gained}, убито ${kills} за ${secs} с, хп на убийство ${detail.hpPerKill}.`
  return detail
}

// S1e 07.10: сколько разных эндерменов было в виду (луч к телу, 64 бл.) за вызов охоты — кампания прекращает заходы, где их нет
// (S1d: 23–40 мин охоты «без единого в виду»), и считает по этому цену жемчуга эндерменами.
async function hunt (session, ctl, p: any = {}) {
  const bot = session.bot
  const ids = new Set()
  const peek = () => { try { for (const e of Object.values(bot.entities) as any[]) if (e && e.name === 'enderman' && e.position && e.position.distanceTo(bot.entity.position) <= 64 && seesMob(bot, e)) ids.add(e.id) } catch {} }
  peek()
  const timer = gameClock.setInterval(peek, 1000)
  try {
    const r: any = await huntStyled(session, ctl, p)
    peek()
    return { ...r, seenEndermen: ids.size }
  } finally { gameClock.clearInterval(timer) }
}

async function huntStyled (session, ctl, p: any = {}) {
  const boatSkill = require('./combat/enderman-boat')
  const target = p.boatTrap === false ? null : boatSkill.boatTarget(session)
  if (!target) return huntLegacy(session, ctl, p.style === 'boat' ? { ...p, style: 'foxhole' } : p)
  const bot = session.bot
  const before = countOf(bot, 'ender_pearl')
  const wanted = Math.max(1, p.count ?? 4)
  const began = gameClock.now()
  const result = await boatSkill.tryEndermanBoat(session, ctl, target)
  if (result.killed && !ctl.aborted && bot.health > 0) {
    await sleep(1300)
    await pickUp(bot, ctl, 6, 2500)
  }
  const now = countOf(bot, 'ender_pearl')
  const gained = now - before
  const seconds = (gameClock.now() - began) / 1000
  const remaining = (p.timeoutSeconds ?? 240) - seconds
  const detail = { mode: 'hunt', style: 'лодка', boatTrap: result, kills: result.killed ? 1 : 0,
    pearls: { before, now, gained, want: before + wanted }, seconds: Math.round(seconds),
    stopped: result.why, note: result.killed ? 'Эндермен посажен в лодку подтверждённым пакетом пассажиров и убит.' : 'Лодка не поймала эндермена: ' + result.why }
  log('лодка', result)
  if (gained >= wanted || p.boatOnly === true || ctl.aborted || bot.health <= 0 || remaining < 30) return detail
  const fallback = await huntLegacy(session, ctl, { ...p, style: p.style === 'boat' ? 'foxhole' : p.style,
    count: wanted - gained, timeoutSeconds: remaining })
  const final = countOf(bot, 'ender_pearl')
  return { ...fallback, boatTrap: result, kills: (fallback.kills || 0) + (result.killed ? 1 : 0),
    pearls: { before, now: final, gained: final - before, want: before + wanted }, seconds: Math.round((gameClock.now() - began) / 1000) }
}

async function huntLegacy (session, ctl, p: any = {}) {
  if (p.style === 'duel') return huntDuel(session, ctl, p)
  if (p.style === 'foxhole') return huntFoxhole(session, ctl, p)
  if (p.style === 'pillar') return huntPillar(session, ctl, p)
  if (p.style !== 'shaft') return huntTunnel(session, ctl, p)
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const radius = clamp(p.radius ?? 40, 8, 64)
  const pearls0 = countOf(bot, 'ender_pearl')
  const want = pearls0 + Math.max(1, p.count ?? 4)
  const hp0 = Math.round(bot.health ?? 20)
  const retreatAt = clamp(p.retreatAtHealth ?? 8, 3, 16)
  const kills = []
  const dead = new Set()
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'enderman') hurtAt.set(e.id, gameClock.now()) }
  const onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || dead.has(e.id) || !e.position) return
    if (e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    dead.add(e.id)
    kills.push({ at: xyz(e.position), t: Math.round((gameClock.now() - t0) / 1000) })
  }
  const onGone = e => onDead(e, 'gone')
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  const rounds = []
  let stopped = null
  let hide = null
  // Не разозлился, не дошёл, не пришёл к шахте — следующий, а не конец охоты
  // (лаборатория: первый же «не поймал взгляд» кончал вызов, 1 жемчуг за 5).
  const skip = new Set()
  let fails = 0
  let searches = 0
  try {
    const weapon = bestWeapon(bot)
    while (!ctl.aborted) {
      if (countOf(bot, 'ender_pearl') >= want) break
      if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
      if ((bot.health ?? 20) <= retreatAt) { stopped = `хп ${Math.round(bot.health)} — дальше не охочусь`; break }
      // Автопилот в намерении не ест — между раундами ест охота сама: хп
      // восстанавливаются только при сытости 18+.
      if ((bot.food ?? 20) <= 16) {
        try { await require('./actions').eat(session, {}) } catch {}
      }
      const em: any = nearestEnderman(bot, radius, skip.size ? new Set([...dead, ...skip]) : dead)
      if (!em) {
        // Никого на виду — пройтись: в лесу за грибами их не видно с места.
        if (searches < 4 && deadline - gameClock.now() > 30000) {
          searches++
          if (hide) { await climbOut(bot, ctl, hide).catch(() => null); hide = null }
          const w = await searchWalk(bot, ctl, rounds.length ? 20 : 16)
          log('поиск', { n: searches, to: w })
          continue
        }
        stopped = `эндерменов в ${radius} блоках не вижу` + (worlds.worldOf(bot) === 'the_nether' ? ' (в Аду их больше всего в искажённом лесу — warped_forest)' : ' (в верхнем мире они ходят ночью)')
        break
      }
      const round: any = { enderman: em.id, from: Math.round(em.position.distanceTo(bot.entity.position)) }
      rounds.push(round)
      if (hide) { round.climbFirst = await climbOut(bot, ctl, hide); hide = null }
      // Сначала место для норы, потом злить: без плана — шаг в сторону.
      let plan = hideoutPlan(bot, mcData)
      if (!plan) {
        // Ближайшая связанная клетка, где нора выйдет (в Аду под ногами
        // пустоты и карманы лавы — случайный шаг попадал в них трижды из трёх).
        const { walkable } = require('./walkable')
        const spot = walkable(bot, bot.entity.position, { radius: 12, maxNodes: 2500 })
          .find(n => n.d >= 1 && hideoutPlan(bot, mcData, n.pos))
        if (spot) {
          const w = await walkTo(bot, ctl, spot.pos, 0, 12000)
          if (!bot.entity.position.floored().equals(spot.pos)) await stepInto(bot, spot.pos)
          const at = bot.entity.position.floored()
          round.moved = { ...xyz(spot.pos), ok: w.ok, at: at.equals(spot.pos) ? undefined : xyz(at) }
          plan = hideoutPlan(bot, mcData)
          if (!plan) round.moved.replan = !!hideoutPlan(bot, mcData, spot.pos)
        }
      }
      if (!plan) {
        skip.add(em.id)
        log('раунд', { ...round, skipped: 'нет места под нору' })
        if (++fails >= 4) { stopped = 'места под нору (шахта 3-4 и штрек под потолком) рядом не нашёл'; break }
        continue
      }
      round.plan = { depth: plan.depth, dir: plan.dir }
      // 1. Разозлить: взгляд в глаза — с земли, из ямы их не видно (первый
      //    прогон: яма, потом 30 с взгляда в край ямы, эндермен так и не
      //    разозлился). Смотреть, пока он дальше 4 блоков: ближе под взглядом он
      //    уходит телепортом.
      if (hide) { round.climbFirst = await climbOut(bot, ctl, hide); hide = null }
      const angryBefore = !!meta(bot, em, 'creepy')
      const tA = gameClock.now()
      const stare = { looks: 0, blind: 0 }
      try { bot.clearControlStates() } catch {}
      while (!ctl.aborted && gameClock.now() - tA < 8000 && !meta(bot, em, 'creepy') && em.isValid !== false) {
        const eyes = em.position.offset(0, 2.55, 0)
        if (em.position.distanceTo(bot.entity.position) < 5) break
        if (eyesSeen(bot, em)) { await bot.lookAt(eyes, true); stare.looks++ } else stare.blind++
        // Глаз не видно 2 с — не ждать восьми: идти и ударить.
        if (stare.blind >= 20 && !stare.looks) break
        await sleep(100)
      }
      round.angry = !!meta(bot, em, 'creepy') || angryBefore
      round.stare = stare
      // Взгляд не поймал (он отвернулся, ушёл за угол, телепортнулся) — один
      // удар мечом злит наверняка: удар игрока без телепорта, цель — мы.
      if (!round.angry && em.isValid !== false && em.position.distanceTo(bot.entity.position) < 24) {
        await walkTo(bot, ctl, em.position.floored(), 2, 12000)
        if (reachTo(bot, em) <= 3.0) {
          if (weapon) { try { await bot.equip(weapon, 'hand') } catch {} }
          try { await bot.lookAt(em.position.offset(0, 0.5, 0), true); bot.attack(em); round.poked = true } catch {}
          await sleep(300)
          round.angry = !!meta(bot, em, 'creepy') || !!round.poked
        }
      }
      if (!round.angry) {
        skip.add(em.id)
        log('раунд', { ...round, skipped: 'не разозлил и не дошёл' })
        if (++fails >= 4) { stopped = 'четверых подряд не разозлил: взгляд в глаза не ловится, дойти не выходит'; break }
        continue
      }
      // Разозлили ударом — он рядом, копать при нём нельзя: бой на месте.
      if (round.poked) {
        const f = await openFight(session, ctl, em, { retreatAt, dead })
        round.open = f
        log('раунд', round)
        if (f.killed) { fails = 0; await pickUp(bot, ctl, 6, 4000) } else { skip.add(em.id); if (++fails >= 4) { stopped = 'после удара не добил: бой на месте не вышел'; break } }
        continue
      }
      // 2. Сразу прочь глазами и вниз: шахта и штрек — семь блоков породы,
      //    с киркой это пара секунд, злой эндермен с 8 блоков идёт две-три.
      try { await bot.look(bot.entity.yaw, -Math.PI / 2, true) } catch {}
      const h = await digHideout(bot, ctl, mcData, plan)
      round.hideout = h.ok ? `шахта ${h.shaft.x},${h.shaft.y},${h.shaft.z}, стою в ${h.stand.x},${h.stand.y},${h.stand.z}` : h.why
      if (!h.ok) {
        if (h.shaft) hide = { shaft: h.shaft, stand: h.shaft, top: h.shaft.offset(0, 3, 0) }
        // Злой уже идёт, а норы нет — бой на месте: меч в тело, щит между ударами.
        const f = await openFight(session, ctl, em, { retreatAt, dead })
        round.open = f
        log('раунд', round)
        if (f.killed) { fails = 0; await pickUp(bot, ctl, 6, 4000) } else { skip.add(em.id); if (++fails >= 4) { stopped = `укрытие не вышло: ${h.why}`; break } }
        continue
      }
      hide = h
      // 3. Ждать в штреке и бить в ноги того, кто спрыгнет в шахту. На голову
      //    не смотреть: взгляд в глаза ближе 4 блоков — и он уходит телепортом.
      try { await bot.lookAt(hide.shaft.offset(0.5, 0.3, 0.5), true) } catch {}
      if (weapon) { try { await bot.equip(weapon, 'hand') } catch {} }
      const tB = gameClock.now()
      let swings = 0
      let lastSwing = 0
      // Свидетель «укрытие держит»: хп, потерянные уже В штреке (до него —
      // пока копал — эндермен бить может, это цена, а не сбой).
      const hpHide = bot.health ?? 20
      let hpMin = hpHide
      round.hpAtHide = Math.round(hpHide)
      while (!ctl.aborted && gameClock.now() - tB < 30000 && em.isValid !== false && !dead.has(em.id)) {
        hpMin = Math.min(hpMin, bot.health ?? 20)
        round.hurtInHide = Math.round(hpHide - hpMin)
        if ((bot.health ?? 20) <= retreatAt) break
        const r = reachTo(bot, em)
        if (r <= 3.0 && gameClock.now() - lastSwing >= SWING_MS) {
          try {
            await bot.lookAt(em.position.offset(0, 0.3, 0), true)
            bot.attack(em)
            swings++
            lastSwing = gameClock.now()
          } catch {}
        }
        await sleep(60)
      }
      round.swings = swings
      round.killed = dead.has(em.id)
      round.seconds = Math.round((gameClock.now() - tB) / 1000)
      log('раунд', round)
      if (round.killed) {
        // Жемчуг лежит на дне шахты, где он умер: два шага туда.
        await sleep(900)
        const t1 = hide.shaft.plus(hide.stand.minus(hide.shaft).scaled(0.5)).floored()
        await stepInto(bot, t1)
        await stepInto(bot, hide.shaft)
        await pickUp(bot, ctl, 3, 3000)
        fails = 0
      } else if (!round.swings) {
        // Не пришёл за 30 с — либо не злой, либо дороги к шахте нет: следующий.
        skip.add(em.id)
        if (++fails >= 4) {
          stopped = round.angry ? 'эндермены злые, но к шахте не приходят' : 'не разозлился: взгляд в глаза не поймал (нужен луч до его глаз и дальше 4 блоков)'
          break
        }
      }
    }
  } finally {
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entityDead', onDead)
    bot.removeListener('entityGone', onGone)
  }
  const out = await climbOut(bot, ctl, hide).catch(() => null)
  const pearls = countOf(bot, 'ender_pearl')
  const detail: any = {
    mode: 'hunt',
    pearls: { before: pearls0, now: pearls, gained: pearls - pearls0, want },
    kills: kills.length,
    rounds: rounds.slice(-6),
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    climbedOut: out ? out.ok : undefined,
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (pearls < want) {
    detail.need = { what: 'ender_pearl', count: want - pearls, have: pearls }
    detail.stopped = `${stopped || 'встал'} — жемчуга ${pearls} из ${want} (убил ${kills.length}; игра даёт 0..1 с эндермена, в среднем 0.5)`
  }
  detail.note = `Жемчуг +${detail.pearls.gained} (теперь ${pearls}), эндерменов убито ${kills.length}. ` +
    'Приём: шахта в 3 блока и штрек высотой 2 от её дна — эндермен (2.9) в штрек не влезает и со дна шахты не достаёт, ' +
    'а меч из штрека бьёт его в ноги; в глаза ему смотрю только издали, чтобы разозлить.'
  return detail
}

// ------------------------------------------------------------------ barter

function wornGold (bot) {
  for (const n of GOLD_ARMOR) {
    const it = bot.inventory.slots[ARMOR_SLOT[n]]
    if (it && it.name === n) return n
  }
  return null
}

// Кто в бастионе опасен при любом золоте (исходники 1.21.11, 2026-09-26):
//   * piglin_brute — золото его не успокаивает, бьёт всегда (13 урона на normal);
//   * hoglin — враждебен всегда.
// И что злит самих пиглинов (PiglinAi.angerNearbyPiglins, ANGER_DURATION 600
// тиков = 30 с): открыть сундук/бочку — тех, кто ВИДИТ (canSee), в ±16;
// сломать блок из #guarded_by_piglins (gold_block, gilded_blackstone, сундук,
// бочка, золотая руда, raw_gold_block) — ВСЕХ в ±16 без проверки взгляда
// (Block.playerWillDestroy → angerNearbyPiglins(…, false)); ударить пиглина.
function bastionThreats (bot) {
  const me = bot.entity.position
  const out = []
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || !e.position || e.isValid === false) continue
    const d = e.position.distanceTo(me)
    if (e.name === 'piglin_brute' && d <= 20 && seesMob(bot, e)) out.push({ name: e.name, dist: Math.round(d) })
    else if (e.name === 'hoglin' && d <= 12 && seesMob(bot, e)) out.push({ name: e.name, dist: Math.round(d) })
  }
  return out
}

// Клетки, куда дойти ногами (radius 20), и «стоит ли пиглин на такой»: ±1 по
// горизонтали и высоте от его ног.
function reachCells (bot) {
  const { walkable } = require('./walkable')
  const set = new Set()
  try { for (const n of walkable(bot, bot.entity.position, { radius: 20, maxNodes: 3000 })) set.add(`${n.pos.x},${n.pos.y},${n.pos.z}`) } catch {}
  return set
}
function reachable (set, pos) {
  const f = pos.floored()
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
    if (set.has(`${f.x + dx},${f.y + dy},${f.z + dz}`)) return true
  }
  return false
}

async function barter (session, ctl, p: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 180, 20, 600) * 1000 - 4000
  if (worlds.worldOf(bot) !== 'the_nether') {
    return { mode: 'barter', traded: 0, stopped: 'пиглины живут в Аду; в верхнем мире они через 15 с становятся зомби-пиглинами — бартер только там' }
  }
  // Золото на теле — иначе пиглин нападает сам, едва увидит.
  let gold = wornGold(bot)
  if (!gold) {
    const spare = GOLD_ARMOR.map(n => itemNamed(bot, n)).find(Boolean)
    if (!spare) {
      return {
        mode: 'barter',
        traded: 0,
        need: { what: 'golden_helmet', count: 1, have: 0 },
        stopped: 'без золотой брони пиглины нападают сами (PiglinAi.isWearingSafeArmor: хватит одной вещи). Шлем: 5 золотых слитков на верстаке'
      }
    }
    try { await bot.equip(spare, DEST[spare.name]) } catch (e) { return { mode: 'barter', traded: 0, stopped: `не надел ${spare.name}: ${e.message}` } }
    gold = spare.name
  }
  const threats0 = bastionThreats(bot)
  if (threats0.length && !p.force) {
    return { mode: 'barter', traded: 0, threats: threats0, stopped: `рядом ${threats0.map(t => `${t.name} в ${t.dist}`).join(', ')} — эти бьют при любом золоте; отойти от них (или force:true)` }
  }
  const ingots0 = countOf(bot, 'gold_ingot')
  if (!ingots0) return { mode: 'barter', traded: 0, need: { what: 'gold_ingot', count: Math.max(1, p.count ?? 8), have: 0 }, stopped: 'слитков золота нет — меняют только gold_ingot' }
  const toTrade = Math.min(ingots0, Math.max(1, p.count ?? ingots0))
  const before = countItems(bot)
  const hp0 = Math.round(bot.health ?? 20)
  const busy = new Map() // пиглин -> когда вернётся к сделке
  let thrown = 0
  let handed = 0
  let picked = 0
  let stopped = null
  let nobodySince = 0
  const tosses = []
  if (BF.enabled()) { try { require('./ne-guard').attach(session) } catch {} }

  // Счёт по рюкзаку, а не по броскам: пиглин, занятый прошлым слитком, новый
  // не берёт, и подбор добычи возвращает его нам (первый прогон: брошено 6,
  // в рюкзаке снова 2). Такой слиток бросается ещё раз.
  const spent = () => ingots0 - countOf(bot, 'gold_ingot')
  while (!ctl.aborted && gameClock.now() < deadline && spent() < toTrade && thrown < toTrade * 3) {
    const me = bot.entity.position
    if (BF.enabled()) {
      const G = require('./ne-guard')
      if (G.busy(bot) || G.hot(bot)) { await G.react(session, ctl); stopped = 'страж прервал бартер'; break }
    }
    // Только те, до кого дойти ногами (заливка walkable): в бастионе пиглины
    // за стенами и на других этажах — к ним walkTo не доходил, слиток летел
    // броском, и его никто не брал (лаборатория бастиона, 2026-09-28: 188 с,
    // 20 бросков, 3 сделки). И не «рукой через стену»: пиглин в загоне за
    // стеной взял 17 слитков, а добыча легла у его ног в загоне (прогон 9).
    const reach = reachCells(bot)
    const piglins = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'piglin' && e.position && e.isValid !== false &&
      !meta(bot, e, 'baby') && e.position.distanceTo(me) <= 16 && seesMob(bot, e) && (busy.get(e.id) || 0) < gameClock.now() &&
      reachable(reach, e.position) && (!BF.enabled() || BF.ready(bot, e, busy)))
      .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
    if (!piglins.length) {
      const anyone = (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'piglin' && e.position && e.position.distanceTo(me) <= 16)
      if (!anyone) { stopped = 'взрослых пиглинов в 16 блоках не вижу'; break }
      // Есть, но ни до кого не дойти (за стеной, на другом этаже), а сделок в
      // работе нет — не ждать до конца срока (лаборатория: 176 с впустую).
      if (!nobodySince) nobodySince = gameClock.now()
      const trading = [...busy.values()].some(t => t > gameClock.now() && t - gameClock.now() < ADMIRE_MS + 1600)
      if (!trading && gameClock.now() - nobodySince > 10000) { stopped = 'пиглины рядом есть, но ни до одного не дойти (стены, другой этаж)'; break }
      // Все заняты разглядыванием — собрать то, что уже бросили к нам.
      const loot = (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(me) <= 8)
      if (loot && !BF.enabled()) picked += await pickUp(bot, ctl, 8, 2500)
      else await sleep(500)
      continue
    }
    nobodySince = 0
    const pg: any = piglins[0]
    const threats = bastionThreats(bot)
    if (threats.length && !p.force) { stopped = `подошли ${threats.map(t => `${t.name} в ${t.dist}`).join(', ')} — бросаю сделки`; break }
    const ingot = itemNamed(bot, 'gold_ingot')
    if (!ingot) break
    // Вручить (по умолчанию): PiglinAi.mobInteract — правый клик слитком по
    // взрослому, который ничего не разглядывает (canAdmire), кладёт слиток
    // ему в левую руку сразу: без полёта, без 40 тиков задержки подбора
    // брошенного и без малыша, который перехватит слиток и оставит себе.
    // Досягаемость по сущности — 3 блока (entity_interaction_range).
    if (p.how !== 'toss') {
      if (pg.position.distanceTo(bot.entity.position) > 2.6) {
        await walkTo(bot, ctl, pg.position.floored(), 1, Math.min(8000, deadline - gameClock.now()))
      }
      if (pg.isValid !== false && bot.entities[pg.id] && pg.position.distanceTo(bot.entity.position) <= 3.2) {
        const had = countOf(bot, 'gold_ingot')
        try {
          await bot.equip(ingot, 'hand')
          const aim = BF.enabled() ? require('./pick').aim(bot, pg) : null
          if (BF.enabled() && (!aim || !aim.point)) { busy.set(pg.id, gameClock.now() + 1000); continue }
          await bot.lookAt(aim ? aim.point : pg.position.offset(0, 1.2, 0), true)
          await bot.activateEntity(pg)
        } catch (e) { stopped = `слиток не вручил: ${e.message}`; break }
        await sleep(350)
        if (countOf(bot, 'gold_ingot') < had) {
          thrown++
          handed++
          tosses.push({ piglin: pg.id, handed: true })
          busy.set(pg.id, gameClock.now() + ADMIRE_MS + (BF.enabled() ? 150 : 1500))
        } else {
          // Не взял: уже держит золото или злой — к следующему.
          busy.set(pg.id, gameClock.now() + 4000)
        }
        if (BF.enabled() || piglins.length > 1) continue
        await sleep(ADMIRE_MS)
        picked += await pickUp(bot, ctl, 8, 4000)
        continue
      }
    }
    if (BF.enabled() && p.how !== 'toss') { busy.set(pg.id, gameClock.now() + 1000); continue }
    // Бросок: не подошёл на 3 блока (стена, лава) или how:'toss'. Пиглин идёт
    // за предметом только ближе 9 — и только если дойдёт до него: дальше 6
    // блоков не бросать (слиток лежал, пиглин стоял за стеной).
    if (p.how !== 'toss' && pg.position.distanceTo(bot.entity.position) > 6) { busy.set(pg.id, gameClock.now() + 8000); continue }
    if (pg.position.distanceTo(bot.entity.position) > 4) {
      await walkTo(bot, ctl, pg.position.floored(), 3, Math.min(10000, deadline - gameClock.now()))
    }
    try {
      await bot.lookAt(pg.position.offset(0, 0.2, 0), true)
      await bot.toss(ingot.type, null, 1)
      thrown++
      tosses.push({ piglin: pg.id, dist: Math.round(pg.position.distanceTo(bot.entity.position) * 10) / 10 })
      busy.set(pg.id, gameClock.now() + ADMIRE_MS + 1500)
    } catch (e) {
      stopped = `слиток не бросил: ${e.message}`
      break
    }
    await sleep(700)
    // Пиглинов несколько — следующему можно бросать, пока этот разглядывает.
    if (piglins.length > 1) continue
    // Один — ждать его сделки и подобрать то, что он бросил к нам.
    await sleep(ADMIRE_MS)
    picked += await pickUp(bot, ctl, 8, 4000)
  }
  // Последние сделки ещё идут — дождаться и подобрать.
  if (thrown && !ctl.aborted) {
    await sleep(Math.min(ADMIRE_MS + 1500, Math.max(0, deadline - gameClock.now())))
    picked += await pickUp(bot, ctl, 8, 6000)
  }
  const got = diffItems(before, countItems(bot))
  const gained: any = {}
  for (const [k, v] of ((Object.entries(got) as [string, any][]) as any)) if (v > 0) gained[k] = v
  const pearls = gained.ender_pearl || 0
  const detail: any = {
    mode: 'barter',
    wearing: gold,
    thrown,
    handed,
    spent: spent(),
    ingotsLeft: countOf(bot, 'gold_ingot'),
    gained,
    pearls,
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    tosses: tosses.slice(-8),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (stopped) detail.stopped = stopped
  detail.note = `Отдал ${detail.spent} слитк(ов) (бросков ${thrown}), выменял: ${(Object.entries(gained) as [string, any][]).map(([k, v]) => `${k}×${v}`).join(', ') || 'ничего не подобрал'}. ` +
    `Жемчуга ${pearls} — игра даёт его в 2.1% сделок (2–4 шт.), ~15 слитков на жемчужину; эндермены выгоднее.`
  return detail
}

// Без mode — по тому, что видно (так зовёт автомат: pearls {count}): пиглин
// в 24 блоках и слитки в рюкзаке в Аду — бартер всеми слитками; иначе охота
// (без эндермена в поле зрения она сразу отвечает, где их искать).
async function pearls (session, ctl, p: any = {}) {
  if (p.mode === 'barter') return barter(session, ctl, p)
  if (p.mode === 'hunt') return hunt(session, ctl, p)
  const bot = session.bot
  const me = bot.entity.position
  const seen = (name, r) => (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === name && e.position &&
    e.position.distanceTo(me) <= r && seesMob(bot, e))
  const inNether = worlds.worldOf(bot) === 'the_nether'
  let r
  if (inNether && countOf(bot, 'gold_ingot') > 0 && seen('piglin', 24) && !seen('enderman', 40)) {
    r = await barter(session, ctl, { ...p, count: undefined })
  } else {
    r = await hunt(session, ctl, p)
    if (inNether && !r.kills && countOf(bot, 'gold_ingot') > 0 && !seen('piglin', 24)) {
      r.note = (r.note || '') + ` Слитков ${countOf(bot, 'gold_ingot')} — пиглинам (mode=barter), когда увижу взрослого пиглина.`
    }
  }
  return { ...r, auto: true }
}

module.exports = { pearls, hunt, barter, digHideout, reachTo, emergencyPillar, pillarDown, walkTo }

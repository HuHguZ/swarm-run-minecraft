'use strict'
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from '../movement'
import { bestWeapon } from '../items'
import { eyePos } from '../perception'
import * as survival from '../combat-safety'
import { SWING_MS, clamp, log, meta, seesMob, ents, walkTo } from './common'

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
  const { walkable }: typeof import('../walkable') = require('../walkable')
  const nodes = walkable(bot, bot.entity.position, { radius: dist + 4, maxNodes: 3000 })
  const me = bot.entity.position
  const far = nodes.filter(n => { const d = Math.hypot(n.pos.x - me.x, n.pos.z - me.z); return d >= dist * 0.6 && d <= dist + 4 })
  if (!far.length) {
    // Ощупью некуда (яма, остатки коробки) — pathfinder с копанием, 16 блоков в
    // случайную сторону.
    const a = Math.random() * Math.PI * 2
    const tx = Math.round(me.x + Math.sin(a) * dist); const tz = Math.round(me.z + Math.cos(a) * dist)
    const w = await (require('../movement') as typeof import('../movement')).travelXZ(bot, ctl, tx, tz, { range: 3, retries: 1, deadline: gameClock.now() + 20000 })
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
  const combat: typeof import('../combat') = require('../combat')
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

export { clearRay, eyesSeen, safeAim, nearestEnderman, reachTo, searchWalk, lavaAround, openFight }

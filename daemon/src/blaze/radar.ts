'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { log } from './targets'

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
const swingMs = bot => (require('../pvp') as typeof import('../pvp')).cooldownMs(bot.heldItem)
const BOW_MIN = 3.5
// Лук — только по близким (14): дальний блейз и умирает далеко, стержень за
// пределами вылазки (замер 26: 5 убийств, стержни за 24-28 блоков).
const BOW_MAX = 14
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

const myEye = bot => (require('../pick') as typeof import('../pick')).eyeOf(bot)
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
function seesMe (bot, e) { return losClear(bot, blazeEye(e), myEye(bot)) }

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
  const armor = (require('../assess') as typeof import('../assess')).gearOf([5, 6, 7, 8].map(i => bot.inventory.slots[i]))
  const damage = sources.reduce((n, s) => {
    const d = s.from.minus(me)
    const blocked = shield && to && d.x * to.x + d.z * to.z >= 0 && (ready || s.eta >= 5 * 50)
    return n + (blocked ? 0 : (require('../assess') as typeof import('../assess')).afterArmor(s.hit, armor.armor, armor.tough))
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
  const traceBalls = process.env.ND_BLAZE_SHIELD_TRACE === '1' ? new Map<number, any>() : null
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
      if (traceBalls) {
        traceBalls.set(r.entityId, { ...balls.get(r.entityId) })
        if (traceBalls.size > 64) traceBalls.delete(traceBalls.keys().next().value)
      }
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
  const onGone = e => { if (e) {
    const b = traceBalls?.get(e.id)
    if (b) { b.goneAt = gameClock.now(); b.lastSeen = e.position?.clone() ?? null }
    charge.delete(e.id); balls.delete(e.id)
  } }
  bot.on('entityUpdate', onUpd)
  bot.on('entityGone', onGone)
  bot._client.on('raw.spawn_entity', onRaw)
  return {
    stats,
    // Diagnostics retains a gone projectile briefly; native current and modelled positions stay distinct.
    trace (now = gameClock.now()) {
      if (!traceBalls) return []
      const rows = []
      const body = bot.entity.position.offset(0, .9, 0)
      const vec = p => p ? [p.x,p.y,p.z] : null
      for (const [id,b] of traceBalls) {
        if (now-b.t0>5000) { traceBalls.delete(id); continue }
        const age = (now-b.t0)/50, flown = FB_PATH[Math.min(FB_PATH.length-1,Math.max(0,Math.floor(age)))] || 0
        const s = body.minus(b.p0).dot(b.dir)
        rows.push({ id, p0:vec(b.p0), dir:vec(b.dir), t0:b.t0, ageTicks:age,
          current:vec(bot.entities[id]?.position), modeledCurrent:vec(b.p0.plus(b.dir.scaled(flown))),
          lastSeen:vec(b.lastSeen), goneAt:b.goneAt ?? null, eta:Math.max(0,(fbTicksTo(s)-age)*50) })
      }
      return rows
    },
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
    // Lower bound to the FIRST NEW shot, not the arrival time of balls already in flight.
    // Falling charged also means goal.stop(): metadata alone cannot prove the 160-tick cooldown+charge.
    // An uncharged blaze must enter a new 60-tick charge. Recheck this bound on every step.
    quietFor (e, now = gameClock.now()) {
      const c = charge.get(e.id)
      if (!(c ? c.on : chargedNow(bot, e, idx))) return CHARGE_MS
      return !c || c.since === null ? 0 : Math.max(0, CHARGE_MS - (now - c.since))
    },
    charged (e) { const c = charge.get(e.id); return c ? c.on : chargedNow(bot, e, idx) },
    // Шары, чья прямая проходит у нашего тела и ещё не прилетели: [{ from, eta }].
    incoming (now = gameClock.now(), readOnly = false) {
      const out = []
      const body = bot.entity.position.offset(0, 0.9, 0)
      for (const [id, b] of balls) {
        const age = (now - b.t0) / 50
        if (age > 60) { if (!readOnly) balls.delete(id); continue }
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
        out.push({ from: b.p0, dir: b.dir, eta: Math.max(0, (fbTicksTo(s) - age) * 50), id, ...(traceBalls ? { p0: b.p0.clone(), dir: b.dir.clone(), current: bot.entities[id]?.position?.clone() ?? null, modeledCurrent: b.p0.plus(b.dir.scaled(Math.max(0, flown))), ageTicks: age } : {}) })
      }
      return out
    }
  }
}

export {
  SHIELD_LEAD_MS, MELEE, swingMs, BOW_MIN, BOW_MAX, NEAR, losClear, losClearBut, myEye, floorBelow, aimFrac,
  blazeEye, seesMe, blazeShieldPrice, makeRadar
}

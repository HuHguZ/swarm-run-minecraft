'use strict'
// Бой с драконом (dragon/pillar-run.ts): кто сидит и как давно видели, накопленный урон на насесте, опасные зоны дракона.
const { gameClock, Vec3, cloudsOf, CENTER, dragonOf, phaseOf, PHASE, SITTING, partsOf, hpOf, fireballsOf }: typeof import('../dig-down-to') = require('../dig-down-to')
const { podiumTop, sight, takeoffBoxes, dragonVel, wingBoxes }: typeof import('../fall-guard') = require('../fall-guard')
const { dangerAt, noteNear }: typeof import('../evade-raw') = require('../evade-raw')
const { chargeOf, takeoffSoon }: typeof import('../crystal-shot-spot') = require('../crystal-shot-spot')

let sitRec = null

let sightMe = null

function sightKey (dId) { return dId + ':' + sightMe }

function sitState (d, ph, now) {
  if (d && SITTING.has(ph)) {
    if (!sitRec || sitRec.id !== d.id || sitRec.ended) {
      const known = sight.get(sightKey(d.id))
      sitRec = { id: d.id, t0: now, roared: known === 'seeing', blind: known === 'blind', flames: 0, lastPh: null }
    }
    if (ph === PHASE.ROARING || ph === PHASE.FLAMING) { sitRec.roared = true; sitRec.blind = false; sight.set(sightKey(d.id), 'seeing') }
    if (ph === PHASE.FLAMING && sitRec.lastPh !== PHASE.FLAMING) { sitRec.flames++; sitRec.flameAt = now }
    sitRec.lastPh = ph
    sitRec.pos = d.position.clone(); sitRec.yaw = d.yaw
    return sitRec
  }
  if (sitRec && !sitRec.ended) sitRec.ended = now
  return null
}

function blindKnown (rec, now = gameClock.now()) {
  if (!rec || rec.roared) return false
  if (rec.blind) return true
  const b = !!rec.nearAt && now - rec.nearAt > 450
  if (b && rec.id != null) { rec.blind = true; sight.set(sightKey(rec.id), 'blind') }
  return b
}

let sitAcc = { id: null, dmg: 0, hp: null, sitting: false }

function noteSitDamage (bot, d, ph) {
  const hp = hpOf(bot, d)
  if (sitAcc.id !== d.id) sitAcc = { id: d.id, dmg: 0, hp, sitting: SITTING.has(ph) }
  if (hp != null && sitAcc.hp != null && hp < sitAcc.hp - 0.01 && (sitAcc.sitting || SITTING.has(ph))) {
    sitAcc.dmg += sitAcc.hp - hp
    if (sitAcc.dmg > 50) sitAcc.dmg = 0
  }
  if (hp != null) sitAcc.hp = hp
  sitAcc.sitting = SITTING.has(ph)
}

function takeoffOnHit () { return sitAcc.dmg + 9.5 > 50 }

function hazardNow (bot, extra: any = {}) {
  const ctx = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot).filter(f => f.ticks < 60), parts: extra.parts || null, breath: extra.breath || null }
  Object.assign(ctx, dragonZones(bot))
  const bad = dangerAt(bot, bot.entity.position, ctx)
  return bad ? { ...bad, ctx } : null
}

function dragonZones (bot, now = gameClock.now()) {
  if (bot.entity) sightMe = bot.entity.id
  const d = dragonOf(bot)
  if (!d) { sitState(null, null, now); return {} }
  const ph = phaseOf(bot, d)
  const v = dragonVel(d, now)
  const rec = sitState(d, ph, now)
  if (rec) noteNear(rec, d, bot, now)
  noteSitDamage(bot, d, ph)
  const ch = chargeOf(bot, d, ph)
  if (ch) return { charge: ch }
  const out: any = {}
  const me = bot.entity.position
  const near = Math.hypot(d.position.x - me.x, d.position.z - me.z) < 40
  // Крылья на посадке, взлёте и в низком полёте: коробки сейчас и через 3, 6,
  // 9 тиков по скорости (на взлёте — до блока за тик).
  if (near && !SITTING.has(ph) && (ph === PHASE.LANDING || ph === PHASE.TAKEOFF || d.position.y - me.y < 10)) {
    out.wings = []
    for (const k of [0, 3, 6, 9]) out.wings.push(...wingBoxes(new Vec3(d.position.x + v.x * k, d.position.y + v.y * k, d.position.z + v.z * k), d.yaw, 0.6))
    out.wingKind = ph === PHASE.TAKEOFF ? 'взлёт' : 'крыло'
    out.wingAway = d.position.clone()
    if (ph === PHASE.TAKEOFF) {
      const n = Math.hypot(v.x, v.z)
      out.wingAxis = { p: d.position.clone(), dir: n > 0.05 ? { x: v.x / n, z: v.z / n } : { x: Math.sin(d.yaw), z: Math.cos(d.yaw) } }
      // Начало взлёта (скорость ещё мала): коробки по скорости стоят на месте, и
      if (n < 0.5) out.wings.push(...takeoffBoxes(d.position, n > 0.05 ? Math.atan2(v.x, v.z) : d.yaw, 16))
    }
  }
  // Сидит, а взлёт скоро (слепой — 100 тиков): коридор взлёта вперёд по взгляду.
  if (rec && near && takeoffSoon(rec, now)) {
    out.wings = takeoffBoxes(d.position, d.yaw)
    out.wingKind = 'взлёт скоро'
    out.wingAxis = { p: d.position.clone(), dir: { x: Math.sin(d.yaw), z: Math.cos(d.yaw) } }
  }
  if (ph === PHASE.LANDING) {
    const P = podiumTop(bot)
    if (P != null && d.position.y < P + 12) out.landing = { c: new Vec3(CENTER.x, P, CENTER.z), r: 14.5, yMin: P - 2.2 }
  }
  if (!SITTING.has(ph) && ph !== PHASE.LANDING) return out
  const parts = partsOf(bot, d, null)
  out.parts = parts
  // Дуга головы — пока видящий доворачивает к нам (высматривая, первые 25
  // тиков); слепой (высматривает дольше 1.6 с без рёва) не поворачивается.
  if (ph === PHASE.SCANNING && !blindKnown(rec, now)) out.sweep = { pos: d.position, dir: parts.dir }
  return out
}

export {
  sitRec, sightMe, sightKey, sitState, blindKnown, sitAcc, noteSitDamage, takeoffOnHit, hazardNow, dragonZones
}

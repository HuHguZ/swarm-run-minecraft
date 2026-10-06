const { findItem, clearControls, gameClock, sleep, cloudsOf, CENTER, Vec3, SAFE_FROM_CRYSTAL, EYE, bow, PHASE, stepTo, dbg } = require('./dig-down-to')
const { countOf } = require('./evade-raw')
const { surfaceY, inClouds, nearEdge, standY } = require('./fall-guard')
async function unstick (bot, ctl, stats) {
  stats.dodges = stats.dodges || {}
  stats.dodges.застрял = (stats.dodges.застрял || 0) + 1
  clearControls(bot)
  const me = bot.entity.position
  const opts = []
  for (let r = 2; r <= 3; r++) {
    for (let k = 0; k < 8; k++) {
      const a = Math.PI * k / 4
      const x = me.x + Math.cos(a) * r; const z = me.z + Math.sin(a) * r
      const y = standY(bot, x, z, me.y, 2, 1)
      if (y == null || nearEdge(bot, new Vec3(x, y, z), 2)) continue
      opts.push({ feet: new Vec3(Math.floor(x) + 0.5, y, Math.floor(z) + 0.5), up: y - Math.floor(me.y) })
    }
  }
  opts.sort((a, b) => b.up - a.up)
  for (const o of opts.slice(0, 3)) {
    const r = await stepTo(bot, ctl, o.feet, { ms: 1500, sprint: false, stopAt: 0.5 })
    dbg('unstick', o.feet.toString(), r.ok ? 'ok' : r.why)
    if (r.ok || bot.entity.position.distanceTo(me) > 1) return true
  }
  return false
}

function makeRubberband (bot) {
  const times = []
  const f = () => { times.push(gameClock.now()); while (times.length && gameClock.now() - times[0] > 2000) times.shift() }
  bot._client.on('position', f)
  return { count: () => { while (times.length && gameClock.now() - times[0] > 2000) times.shift(); return times.length }, close: () => bot._client.removeListener('position', f) }
}

function crystalShotSpot (bot, cr) {
  const me = bot.entity.position
  const clouds = cloudsOf(bot)
  const toC = { x: CENTER.x - cr.pos.x, z: CENTER.z - cr.pos.z }
  const base = Math.atan2(toC.z, toC.x)
  let best = null
  for (const R of [12, 15, 18, 22, 26, 30, 34, 38]) {
    for (let k = -8; k <= 8; k++) {
      const a = base + k * Math.PI / 12
      const x = cr.pos.x + Math.cos(a) * R; const z = cr.pos.z + Math.sin(a) * R
      const sf = surfaceY(bot, x, z)
      if (!sf || sf.name !== 'end_stone') continue
      const feet = new Vec3(Math.floor(x) + 0.5, sf.y, Math.floor(z) + 0.5)
      if (feet.distanceTo(cr.pos) < SAFE_FROM_CRYSTAL) continue
      if (inClouds(clouds, feet, 3)) continue
      if (nearEdge(bot, feet, 2)) continue
      const eye = feet.offset(0, EYE - 0.1, 0)
      // Пологая (крутая, но с подъёмом) или навесом: высокий обелиск своим
      // краем закрывает кристалл от стрелы снизу, навесная приходит сверху.
      for (const mode of [true, 'lob']) {
        const sol = bow.aim(eye, () => cr.aim, bow.SPEED, bow.GRAVITY, mode)
        if (!sol) continue
        if (bow.blockedAt(bot, eye, sol)) continue
        // Встанем не точно в центр клетки: путь должен быть чист и в треть
        // блока от неё, иначе на месте стрела зацепит край обелиска.
        const robust = [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]].every(([ox, oz]) => {
          const e2 = eye.offset(ox, 0, oz)
          const s2 = bow.aim(e2, () => cr.aim, bow.SPEED, bow.GRAVITY, mode)
          return s2 && !bow.blockedAt(bot, e2, s2)
        })
        if (!robust) continue
        // Цена: дорога + крутизна + время полёта (дольше летит — шире разлёт).
        const cost = feet.distanceTo(me) + Math.max(0, sol.pitch - 1.0) * 20 + sol.ticks * 0.3 + (mode === 'lob' ? 10 : 0)
        if (!best || cost < best.cost) best = { feet, sol, cost, mode }
      }
    }
  }
  return best
}

async function pointBlank (bot, ctl, pointOf, stop = null) {
  const point = typeof pointOf === 'function' ? pointOf : () => pointOf
  const bowItem = findItem(bot, /^bow$/)
  if (!bowItem) return { shot: false, why: 'лука нет' }
  if (countOf(bot, /arrow$/) < 1) return { shot: false, why: 'стрел нет' }
  clearControls(bot)
  try { await bot.equip(bowItem, 'hand') } catch (e) { return { shot: false, why: e.message } }
  await bot.lookAt(point(), true).catch(() => {})
  const charge = bow.observeCharge(bot)
  if (!charge.start()) { charge.close(); return { shot: false, why: charge.why(), fullChargeConfirmed: false } }
  let released = false
  try {
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 1200 || !charge.ready()) {
    if (ctl.aborted || (stop && stop()) || charge.why() || gameClock.now() - t0 >= 1200 + 2500) return { shot: false, why: charge.why() || 'bow_charge_not_confirmed', fullChargeConfirmed: false }
    await bot.lookAt(point(), true).catch(() => {})
    await Promise.race([sleep(50), charge.cancelled])
  }
  let nextTick
  await Promise.race([new Promise<any>(resolve => { nextTick = resolve; bot.once('physicsTick', resolve) }), charge.cancelled])
  bot.removeListener('physicsTick', nextTick)
  if (!charge.ready()) return { shot: false, why: charge.why() || 'bow_charge_not_confirmed', fullChargeConfirmed: false }
  bot.deactivateItem()
  released = true; charge.close()
  return { shot: true, fullChargeConfirmed: true, nativeCharge: charge.snapshot() }
  } finally { if (released) charge.close(); else charge.cancel() }
}

function takeoffSoon (rec, now) {
  if (!rec || rec.ended) return false
  if (!rec.roared) return now - rec.t0 > 3800
  return rec.flames >= 4 && !!rec.flameAt && now - rec.flameAt > 8500
}

let chargeRec = null

function chargeOf (bot, d, ph) {
  if (ph !== PHASE.CHARGING) { chargeRec = null; return null }
  if (!chargeRec || chargeRec.id !== d.id || gameClock.now() - chargeRec.t0 > 8000) {
    chargeRec = { id: d.id, t0: gameClock.now(), from: d.position.clone(), target: bot.entity.position.clone(), yaw: d.yaw }
  }
  return chargeRec
}

module.exports = { unstick, makeRubberband, crystalShotSpot, pointBlank, takeoffSoon, chargeRec, chargeOf }

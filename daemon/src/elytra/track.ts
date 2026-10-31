'use strict'
// Элитры (elytra.ts): слежка за летуном — летит ли, где будет, его пике на нас.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { TICK_MS, EYE_FLY, r2 }: typeof import('./consts') = require('./consts')
const { lookVec, glideStep }: typeof import('./physics') = require('./physics')

// ---------------------------------------------------------------- слежка

// Он на элитрах: метаданные shared_flags 0x80 (mineflayer entity.elytraFlying)
// или поза FALL_FLYING (1). Скорость — по позициям за ~150 мс.
function gliding (e) {
  if (!e) return false
  if (e.elytraFlying) return true
  try { return (e.metadata?.[0] & 0x80) !== 0 || e.metadata?.[6] === 1 || e.metadata?.[6] === 'fall_flying' } catch { return false }
}

// Где он будет через t тиков: по его скорости, в полёте без ракеты — той же
// физикой по его взгляду (метаданные yaw/pitch mineflayer ведёт для всех).
function predictGlider (e, vel, t) {
  const p = { x: e.position.x, y: e.position.y, z: e.position.z }
  const v = { x: vel.x, y: vel.y, z: vel.z }
  if (!gliding(e)) return new Vec3(p.x + v.x * t, p.y + v.y * t, p.z + v.z * t)
  const n = Math.floor(t)
  for (let i = 0; i < n; i++) glideStep(p, v, e.yaw || 0, e.pitch || 0, false)
  const fraction = t - n
  if (fraction > 0) {
    const next = { ...p }
    glideStep(next, v, e.yaw || 0, e.pitch || 0, false)
    p.x += (next.x - p.x) * fraction; p.y += (next.y - p.y) * fraction; p.z += (next.z - p.z) * fraction
  }
  return new Vec3(p.x, p.y, p.z)
}

// Слежка за ним в бою: летит ли, сколько в воздухе, его пике на нас (время до
// сближения по его скорости и точке ближе всего).
function track (bot, { enemy, listen = true, clip = null }: any) {
  const st = { seen: 0, dives: 0, shots: 0, hits: 0, shieldUps: 0, dodges: 0, counterHits: 0, airMs: 0 }
  const his = { id: null, hist: [], vel: { x: 0, y: 0, z: 0 }, flying: false, since: 0, receipt: null, using: undefined, readyAt: 0 }
  let active = null
  const onTick = () => {
    try {
      const e = enemy()
      if (!e || !e.position || e.isValid === false) return
      const now = gameClock.now()
      const receipt = e._ndPositionReceipts?.[1]
      if (his.id !== e.id || e._ndVisible === false || (receipt !== his.receipt && receipt?.kind === 'reacquired')) {
        his.id = e.id; his.hist = []; his.vel = { x: 0, y: 0, z: 0 }; his.using = undefined
        if (his.flying) st.airMs += now - his.since
        his.flying = false
      }
      his.receipt = receipt
      if (e._ndVisible === false) return
      const flagIndex = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('living_entity_flags') ?? -1
      const flags = e.metadata?.[flagIndex >= 0 ? flagIndex : 8] || 0
      const held = e.equipment?.[(flags & 2) ? 1 : 0]?.name
      const spec = (require('../spear') as typeof import('../spear')).SPEARS[held]
      const using = (flags & 1) && spec ? held : null
      if (using !== his.using) {
        // Already raised on first sight may be charged; a visible start has the native delay.
        his.readyAt = using && his.using !== undefined ? now + spec.delay * 1000 : now
        his.using = using
      }
      his.hist.push({ x: e.position.x, y: e.position.y, z: e.position.z, t: now })
      while (his.hist.length > 2 && now - his.hist[0].t > 160) his.hist.shift()
      const a = his.hist[0]; const bb = his.hist[his.hist.length - 1]
      const dt = (bb.t - a.t) / 50
      if (e._ndVisible === true && (receipt?.kind === 'rel_entity_move' || receipt?.kind === 'entity_move_look')) {
        // Visible packet observations survive a slow flight tick; reacquisition still resets the shared tracker.
        const v = (require('../bow/track') as typeof import('../bow/track')).observedVelocity(e)
        his.vel = v.ageTicks <= 160 / TICK_MS ? { x: v.x, y: v.y, z: v.z } : { x: 0, y: 0, z: 0 }
      } else if (dt > 0.6) his.vel = { x: (bb.x - a.x) / dt, y: (bb.y - a.y) / dt, z: (bb.z - a.z) / dt }
      const fl = gliding(e)
      if (fl && !his.flying) { his.since = now; st.seen++ }
      if (!fl && his.flying) st.airMs += now - his.since
      his.flying = fl
    } catch {}
  }
  if (listen) bot.on('physicsTick', onTick)
  // Копьё достаёт раньше тела: тот же луч KineticWeapon, что у собственного тарана.
  const threat = () => {
    const e = enemy()
    if (!e || !e.position || e._ndVisible === false || !his.flying || !bot.entity) return (active = null)
    const me = bot.entity.position.offset(0, 0.9, 0)
    const held = his.using || e.equipment?.[0]?.name
    const lance = his.using ? (require('../combat/aerial-lance') as typeof import('../combat/aerial-lance')) : null
    const look = lookVec(e.yaw || 0, e.pitch || 0)
    const p = { x: e.position.x, y: e.position.y, z: e.position.z }
    const v = { ...his.vel }
    const myV = bot.entity.velocity || { x: 0, y: 0, z: 0 }
    const now = gameClock.now()
    let best = null
    let contact = null
    for (let t = 0; t <= 24; t++) {
      if (t) {
        const prev = { x: p.x, y: p.y + 0.3, z: p.z }
        glideStep(p, v, e.yaw || 0, e.pitch || 0, false)
        // shortcut: centre-line sweep; expand to the glider box if native traces show corner crossings.
        if (clip) {
          const delta = new Vec3(p.x - prev.x, p.y + 0.3 - prev.y, p.z - prev.z), length = delta.norm()
          if (length && clip(prev, delta.scaled(1 / length), length) < length) break
        }
      }
      const q = new Vec3(p.x, p.y, p.z)
      if (lance && !contact && t <= 20 && now + t * TICK_MS >= his.readyAt && lance.lanceDamage(held, look, v, myV).dmg > 0 &&
        lance.lanceHits(q.offset(0, EYE_FLY, 0), look, v, bot.entity.position.offset(myV.x * t, myV.y * t, myV.z * t), bot.entity.height || 1.8, bot.entity.width || 0.6, clip)) contact = { t, q }
      if (!t) continue
      const d = Math.hypot(q.x - me.x, q.y + 0.3 - me.y, q.z - me.z)
      if (!best || d < best.d) best = { d, t, q }
    }
    const sp = Math.hypot(his.vel.x, his.vel.y, his.vel.z)
    const diving = best && best.d < 3.5 && best.t <= 20 && sp > 0.5
    // A flyer can brake or orbit instead of keeping myV*t; a charged close pass can turn into that manoeuvre.
    const turningLance = diving && gliding(bot.entity) && lance && now + best.t * TICK_MS >= his.readyAt && lance.lanceDamage(held, look, his.vel, myV).dmg > 0
    if (contact || diving) {
      const miss = best?.d ?? contact.q.offset(0, .3, 0).distanceTo(me)
      const out = { kind: contact || turningLance ? 'lance' : 'dive', eta: (contact || best).t, miss: r2(miss), at: (contact || best).q, speed: r2(sp), mace: held === 'mace' }
      if (!active) st.dives++
      active = active ? Object.assign(active, out) : out
      return active
    }
    active = null
    return null
  }
  return {
    st,
    his,
    update: onTick,
    threat,
    flying: () => his.flying,
    vel: () => his.vel,
    at: (t) => { const e = enemy(); return e ? predictGlider(e, his.vel, t) : null },
    report () {
      const out = {
        seen: st.seen || undefined,
        airS: st.airMs ? Math.round(st.airMs / 100) / 10 : undefined,
        dives: st.dives || undefined,
        shots: st.shots || undefined,
        hits: st.hits || undefined,
        shieldUps: st.shieldUps || undefined,
        dodges: st.dodges || undefined,
        counterHits: st.counterHits || undefined
      }
      return (Object.values(out) as any[]).some(v => v !== undefined) ? out : undefined
    },
    close () { if (listen) bot.removeListener('physicsTick', onTick) }
  }
}

export {
  gliding, predictGlider, track
}

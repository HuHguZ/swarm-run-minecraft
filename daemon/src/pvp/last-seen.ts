const pick = require('../pick')
const gameClock = require('../game-clock')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const SEE_THROUGH = /glass|_pane$|^barrier$|^iron_bars$/
const FULL = [[0, 0, 0, 1, 1, 1]]

// The same collision rays as pick, with transparent blocks skipped only for sight.
function seesPlayer (bot, e) {
  if (!bot.entity || !e?.position || e.isValid === false) return false
  try {
    const eye = pick.eyeOf(bot)
    const box = pick.hitboxOf(bot, e)
    const world = { blockAt: p => bot.blockAt(p, false) || { boundingBox: 'block', shapes: FULL } }
    for (const [x, y, z] of [[.5, .5, .5], [.5, .9, .5], [.1, .5, .1], [.9, .5, .9], [.1, .5, .9], [.9, .5, .1]]) {
      const point = new Vec3(box.lo.x + box.w * x, box.lo.y + box.h * y, box.lo.z + box.w * z)
      const delta = point.minus(eye)
      const d = delta.norm()
      if (d > 64) continue
      if (d < 1e-6 || !pick.blockOnRay(world, eye, delta.scaled(1 / d), d, SEE_THROUGH)) return true
    }
  } catch {}
  return false
}

function createLastSeen (bot) {
  const records = new Map<number, any>()
  const sources = new WeakMap<object, any>()
  const source = e => sources.get(e) || e
  const refresh = rec => {
    const { raw, view } = rec
    const wasVisible = view._ndVisible
    view._ndVisible = seesPlayer(bot, raw)
    view.isValid = raw.isValid
    if (!view._ndVisible) return
    const now = raw._ndObservationNow?.() ?? gameClock.observationNow()
    const receipt = raw._ndPositionReceipts?.[1]
    const moved = !view.position || !view.position.equals(raw.position)
    for (const key of ['id', 'type', 'name', 'username', 'uuid', 'height', 'width', 'onGround', 'yaw', 'pitch', 'headYaw', 'elytraFlying', '_ndGlideBoosted', '_ndGlideRevision']) view[key] = raw[key]
    if (view.position) view.position.update(raw.position)
    else view.position = raw.position.clone()
    const keys = bot.registry?.entitiesByName?.player?.metadataKeys || []
    const health = keys.indexOf('health') < 0 ? 9 : keys.indexOf('health')
    const absorption = keys.indexOf('player_absorption') < 0 ? 17 : keys.indexOf('player_absorption')
    view.metadata = (raw.metadata || []).map((v, i) => i === health || i === absorption ? undefined : structuredClone(v))
    view.equipment = (raw.equipment || []).map(it => it && Object.assign(Object.create(Object.getPrototypeOf(it)), structuredClone(it)))
    view._ndSeenAt = gameClock.now()
    if (!wasVisible || moved || (receipt && receipt !== rec.receipt)) {
      const current = { ...receipt, x: view.position.x, y: view.position.y, z: view.position.z,
        t: receipt?.t ?? now, grounded: view.onGround, ...(!wasVisible ? { kind: 'reacquired' } : {}) }
      // A hidden displacement is a new baseline, never a measured speed.
      view._ndPositionReceipts = [wasVisible ? view._ndPositionReceipts?.[1] : null, current]
      rec.receipt = receipt
      view.emit('ndPositionObserved')
    }
  }
  const observe = e => {
    if (!e || (e.type !== 'player' && !e.username)) return e
    const raw = source(e)
    let rec = records.get(raw.id)
    if (!rec || rec.raw !== raw) {
      if (rec) rec.raw.removeListener?.('ndPositionObserved', rec.update)
      const view: any = new EventEmitter()
      sources.set(view, raw)
      view._ndVisible = false
      view._ndObservationNow = () => raw._ndObservationNow?.() ?? gameClock.observationNow()
      Object.defineProperties(view, {
        velocity: { get: () => require('../bow').trackTarget(view).vel() },
        heldItem: { get: () => view.equipment?.[0] }
      })
      rec = { raw, view }
      rec.update = () => refresh(rec)
      raw.on?.('ndPositionObserved', rec.update)
      records.set(raw.id, rec)
    }
    refresh(rec)
    return rec.view.position ? rec.view : null
  }
  const tick = () => { for (const rec of records.values()) refresh(rec) }
  bot.on('physicsTick', tick)
  return {
    observe, source,
    visible: e => { const observed = observe(e); return !!observed && observed._ndVisible !== false },
    close () {
      bot.removeListener('physicsTick', tick)
      for (const rec of records.values()) rec.raw.removeListener?.('ndPositionObserved', rec.update)
      records.clear()
    }
  }
}

module.exports = { createLastSeen, seesPlayer }

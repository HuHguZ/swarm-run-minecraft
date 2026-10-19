import { EventEmitter } from 'node:events'
import * as fastblocks from '../fastblocks'
import * as gameClock from '../game-clock'
import * as pick from '../pick'
import { Vec3 } from './vec3'
const SEE_THROUGH = /glass|_pane$|^barrier$|^iron_bars$/
const FULL = [[0, 0, 0, 1, 1, 1]]

// A rendered enemy item exposes its kind and glint, not a tooltip or stack contents.
function visiblePlayerItem (it) {
  if (!it) return null
  if (it._ndVisual) return it
  const view: any = { name: it.name, count: 1, enchanted: false, componentMap: new Map(), _ndVisual: true }
  const map = Object.getOwnPropertyDescriptor(it, 'componentMap')?.value
  if (!(map instanceof Map)) return view
  const data = key => Object.getOwnPropertyDescriptor(Map.prototype.get.call(map, key) || {}, 'data')?.value
  view.enchanted = Map.prototype.has.call(map, 'enchantments')
  const glint = data('enchantment_glint_override')
  if (typeof glint === 'boolean') view.enchanted = glint
  if (it.name === 'crossbow') {
    const d = data('charged_projectiles')
    const ammo = d && (Object.getOwnPropertyDescriptor(d, 'projectiles')?.value || Object.getOwnPropertyDescriptor(d, 'items')?.value)
    if (Array.isArray(ammo) && ammo.length) view.componentMap.set('charged_projectiles', { data: { projectiles: [{ name: 'unknown' }] } })
  }
  if (/potion$/.test(it.name || '')) {
    const d = data('potion_contents')
    const color = d && Object.getOwnPropertyDescriptor(d, 'customColor')?.value
    if (Number.isInteger(color)) view.componentMap.set('potion_contents', { data: { customColor: color } })
  }
  return view
}

// The same collision rays as pick, with transparent blocks skipped only for sight.
function seesPlayer (bot, e) {
  if (!bot.entity || !e?.position || e.isValid === false) return false
  try {
    const eye = pick.eyeOf(bot)
    const box = pick.hitboxOf(bot, e)
    const unknown = { boundingBox: 'block', shapes: FULL }
    const cache = fastblocks.install(bot)
    const world = { blockAt: p => { try { return (cache ? cache.block(p.x, p.y, p.z) : bot.blockAt(p, false)) || unknown } catch { return unknown } } }
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

function gearPartVisible(bot, raw, index) {
  if (!bot.entity || !raw?.position || raw.isValid === false || !Number.isInteger(index) || index < 0 || index > 5) return false
  // Rendered player proportions: hands, feet, legs, torso, head. Test the part before reading its item packet.
  const heights = [[.35, .75], [.35, .75], [0, .18], [.15, .50], [.48, .75], [.75, 1]][index]
  try {
    const eye = pick.eyeOf(bot), box = pick.hitboxOf(bot, raw)
    const unknown = { boundingBox: 'block', shapes: FULL }
    const cache = fastblocks.install(bot)
    const world = { blockAt: p => { try { return (cache ? cache.block(p.x, p.y, p.z) : bot.blockAt(p, false)) || unknown } catch { return unknown } } }
    for (const y of heights) for (const x of [.1, .5, .9]) for (const z of [.1, .5, .9]) {
      const point = new Vec3(box.lo.x + box.w * x, box.lo.y + box.h * y, box.lo.z + box.w * z), delta = point.minus(eye), distance = delta.norm()
      if (distance > 64) continue
      if (distance < 1e-6 || !pick.blockOnRay(world, eye, delta.scaled(1 / distance), distance, SEE_THROUGH)) return true
    }
  } catch {}
  return false
}

function observePlayerGear(bot, raw, prior = null) {
  const equipment = Array.from({ length: 6 }, (_, i) => prior?.equipment?.[i] || null)
  const known = Array.from({ length: 6 }, (_, i) => !!prior?.known?.[i])
  const visible = Array.from({ length: 6 }, (_, i) => gearPartVisible(bot, raw, i))
  for (let i = 0; i < 6; i++) if (visible[i]) { equipment[i] = visiblePlayerItem(raw.equipment?.[i]); known[i] = true }
  return { equipment, known, visible, unknownArmorSlots: known.slice(2).filter(k => !k).length }
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
    view.metadata = Array.from({ length: raw.metadata?.length || 0 }, (_, i) => i === health || i === absorption ? undefined : structuredClone(raw.metadata[i]))
    rec.gear = observePlayerGear(bot, raw, rec.gear)
    view.equipment = rec.gear.equipment
    view._ndGearVisible = rec.gear.visible
    view._ndUnknownArmorSlots = rec.gear.unknownArmorSlots
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
        velocity: { get: () => (require('../bow') as typeof import('../bow')).trackTarget(view).vel() },
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

export { createLastSeen, seesPlayer, visiblePlayerItem, gearPartVisible, observePlayerGear }

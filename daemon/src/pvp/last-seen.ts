import { EventEmitter } from 'node:events'
import * as fastblocks from '../fastblocks'
import * as gameClock from '../game-clock'
import * as pick from '../pick'
import { Vec3 } from './vec3'
export const SIGHT_TRANSPARENT = /glass|_pane$|^barrier$|^iron_bars$|^cobweb$/
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

// One synchronous query: a ray crossing the interior of a previously hit shape is also blocked.
function sightRay (bot) {
  const eye = pick.eyeOf(bot), unknown = { boundingBox: 'block', shapes: FULL }, cache = fastblocks.install(bot)
  const world = { blockAt: p => { try { return (cache ? cache.block(p.x, p.y, p.z) : bot.blockAt(p, false)) || unknown } catch { return unknown } } }
  let occluder: { lo: import('vec3').Vec3; hi: import('vec3').Vec3 } | null = null
  return (point, range) => {
    const delta = point.minus(eye), distance = delta.norm()
    if (distance > range) return false
    if (distance < 1e-6) return true
    const dir = delta.scaled(1 / distance)
    if (occluder && pick.rayBox(eye, dir, occluder.lo, occluder.hi, distance) != null) return false
    const hit = pick.blockOnRay(world, eye, dir, distance, SIGHT_TRANSPARENT)
    if (!hit) return true
    if (hit.block !== unknown) {
      const shapes = pick.shapesOf(hit.block)
      // A sole outline is unambiguous, including slabs. Shrink it so grazing rays still use DDA.
      if (shapes?.length === 1) {
        const [x0, y0, z0, x1, y1, z1] = shapes[0], eps = 1e-7
        // DDA only visits an outline when it enters the owning cell (e.g. a fence can extend above it).
        const insideCell = x0 >= 0 && y0 >= 0 && z0 >= 0 && x1 <= 1 && y1 <= 1 && z1 <= 1
        if (insideCell && x1 - x0 > 2 * eps && y1 - y0 > 2 * eps && z1 - z0 > 2 * eps) {
          occluder = { lo: hit.pos.offset(x0 + eps, y0 + eps, z0 + eps), hi: hit.pos.offset(x1 - eps, y1 - eps, z1 - eps) }
        }
      }
    }
    return false
  }
}

// The same collision rays as pick, with transparent blocks skipped only for sight.
function seesPlayer (bot, e) {
  if (!bot.entity || !e?.position || e.isValid === false || e._ndVisible === false) return false
  try {
    const flags = Number(e.metadata?.[0]) || 0
    const flames = !!(flags & 0x01) && bot.players?.[e.username]?.gamemode !== 3
    if ((e.type === 'player' || e.username) && (flags & 0x20) && !(flags & 0x40) && !flames) {
      // Without an outline or flames an invisible enemy needs an exposed equipment layer.
      return visibleGearSlots(bot, e).some((seen, i) => {
        if (!seen || e._ndGearVisible?.[i] === false) return false
        const item = e.equipment?.[i]
        return !!item?.name && item.name !== 'air'
      })
    }
    const box = pick.hitboxOf(bot, e), visible = sightRay(bot)
    for (const [x, y, z] of [[.5, .5, .5], [.5, .9, .5], [.1, .5, .1], [.9, .5, .9], [.1, .5, .9], [.9, .5, .1]]) {
      const point = new Vec3(box.lo.x + box.w * x, box.lo.y + box.h * y, box.lo.z + box.w * z)
      // Глаза — до 128 бл. (трекинг игроков сервера): на открытом его видно издали (пользователь 25.10: «видели меня на максимальном
      // расстоянии»).
      if (visible(point, 128)) return true
    }
  } catch {}
  return false
}

// Rendered player proportions: hands, feet, legs, torso, head. Both hands use the same samples.
const handHeights = [.35, .75]
const gearHeights = [handHeights, handHeights, [0, .18], [.15, .50], [.48, .75], [.75, 1]]
function measureGearParts(bot, raw, parts: number[]) {
  try {
    if (bot.entity && raw?.position && raw.isValid !== false) {
      const box = pick.hitboxOf(bot, raw), visible = sightRay(bot)
      return parts.map(index => {
        for (const y of gearHeights[index]) for (const x of [.1, .5, .9]) for (const z of [.1, .5, .9]) {
          const point = new Vec3(box.lo.x + box.w * x, box.lo.y + box.h * y, box.lo.z + box.w * z)
          if (visible(point, 64)) return true
        }
        return false
      })
    }
  } catch {}
  return parts.map(() => false)
}
function gearPartVisible(bot, raw, index) {
  return Number.isInteger(index) && index >= 0 && index <= 5 && measureGearParts(bot, raw, [index])[0]
}

function visibleGearSlots(bot, raw) {
  const [hands, feet, legs, chest, head] = measureGearParts(bot, raw, [0, 2, 3, 4, 5])
  return [hands, hands, feet, legs, chest, head]
}

function observePlayerGear(bot, raw, prior = null) {
  const equipment = Array.from({ length: 6 }, (_, i) => prior?.equipment?.[i] || null)
  const known = Array.from({ length: 6 }, (_, i) => !!prior?.known?.[i])
  const visible = visibleGearSlots(bot, raw)
  for (let i = 0; i < 6; i++) if (visible[i]) { equipment[i] = visiblePlayerItem(raw.equipment?.[i]); known[i] = true }
  return { equipment, known, visible, unknownArmorSlots: known.slice(2).filter(k => !k).length }
}

const sharedSights = new WeakMap<object, { sight: ReturnType<typeof buildLastSeen>; owners: number }>()
function createLastSeen (bot) {
  let shared = sharedSights.get(bot)
  if (!shared) {
    shared = { sight: buildLastSeen(bot), owners: 0 }
    sharedSights.set(bot, shared)
  }
  shared.owners++
  let closed = false
  return { ...shared.sight, close () {
    if (closed) return
    closed = true
    if (--shared.owners === 0) { shared.sight.close(); sharedSights.delete(bot) }
  } }
}

function cloneMetaValue (v: any): any {
  if (v == null || typeof v !== 'object') return v
  if (Array.isArray(v)) {
    const out = new Array(v.length)
    for (let i = 0; i < v.length; i++) out[i] = cloneMetaValue(v[i])
    return out
  }
  if (ArrayBuffer.isView(v)) return structuredClone(v)
  const out: Record<string, any> = {}
  for (const k of Object.keys(v)) out[k] = cloneMetaValue(v[k])
  return out
}

function sameXYZ (a: { x: number; y: number; z: number } | null | undefined, b: { x: number; y: number; z: number } | null | undefined): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.z === b.z
}

function nearXYZ (a: { x: number; y: number; z: number } | null | undefined, b: { x: number; y: number; z: number } | null | undefined, maxSq: number): boolean {
  if (!a || !b) return false
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz <= maxSq
}

function refreshVisibleEquipment (raw, prior) {
  const equipment = prior.equipment.slice()
  const known = prior.known.slice()
  const visible = prior.visible
  for (let i = 0; i < 6; i++) if (visible[i]) { equipment[i] = visiblePlayerItem(raw.equipment?.[i]); known[i] = true }
  return { equipment, known, visible, unknownArmorSlots: known.slice(2).filter(k => !k).length }
}

function buildLastSeen (bot) {
  const records = new Map<number, any>()
  const sources = new WeakMap<object, any>()
  const retired = new WeakMap<object, any>()
  const source = e => sources.get(e) || e
  const metaKeys = bot.registry?.entitiesByName?.player?.metadataKeys || []
  const healthIdx = metaKeys.indexOf('health') < 0 ? 9 : metaKeys.indexOf('health')
  const absorptionIdx = metaKeys.indexOf('player_absorption') < 0 ? 17 : metaKeys.indexOf('player_absorption')
  const gone = raw => {
    const rec = records.get(raw?.id)
    if (!rec || rec.raw !== raw) return
    records.delete(raw.id)
    raw.removeListener?.('ndPositionObserved', rec.update)
    rec.view._ndVisible = false
    rec.view.isValid = false
    retired.set(raw, rec.view)
  }
  const onEquipPacket = pkt => {
    const rec = records.get(pkt?.entityId)
    if (rec) rec.equipRev = (rec.equipRev || 0) + 1
  }
  const onEquipEntity = e => {
    const rec = records.get(e?.id)
    if (rec && rec.raw === e) rec.equipRev = (rec.equipRev || 0) + 1
  }
  const onMetaEntity = e => {
    const rec = records.get(e?.id)
    if (rec && rec.raw === e) rec.metaRev = (rec.metaRev || 0) + 1
  }
  const refresh = (rec, occluded = false) => {
    const { raw, view } = rec
    const tick = bot.ndClock?.ticks
    const hasTick = Number.isSafeInteger(tick)
    const fast = bot._ndFastBlocks
    const terrainVer = fast?.live ? fast.ver : null
    const myPos = bot.entity?.position
    const rawPos = raw.position
    const receipt = raw._ndPositionReceipts?.[1]
    if (hasTick && terrainVer !== null &&
        rec.memoTick === tick &&
        rec.memoTerrain === terrainVer &&
        rec.memoOccluded === occluded &&
        rec.memoInspect === !!rec.inspectGear &&
        rec.memoEquipRev === (rec.equipRev || 0) &&
        rec.memoMetaRev === (rec.metaRev || 0) &&
        rec.observer === bot.entity &&
        rec.memoRawValid === raw.isValid &&
        rec.memoReceipt === receipt &&
        rec.memoFlags === raw.metadata?.[0] &&
        rec.memoYaw === raw.yaw &&
        rec.memoPitch === raw.pitch &&
        rec.memoHeadYaw === raw.headYaw &&
        rec.memoOnGround === raw.onGround &&
        rec.memoGlide === raw.elytraFlying &&
        sameXYZ(rec.memoMyPos, myPos) &&
        sameXYZ(rec.memoRawPos, rawPos)) {
      return
    }
    const wasVisible = view._ndVisible && rec.observer === bot.entity
    rec.observer = bot.entity
    view._ndVisible = !occluded && seesPlayer(bot, raw)
    view.isValid = raw.isValid
    if (view.isValid === false) { gone(raw); return }
    if (hasTick && terrainVer !== null) {
      rec.memoTick = tick
      rec.memoTerrain = terrainVer
      rec.memoOccluded = occluded
      rec.memoInspect = !!rec.inspectGear
      rec.memoEquipRev = rec.equipRev || 0
      rec.memoMetaRev = rec.metaRev || 0
      rec.memoRawValid = raw.isValid
      rec.memoReceipt = receipt
      rec.memoFlags = raw.metadata?.[0]
      rec.memoYaw = raw.yaw
      rec.memoPitch = raw.pitch
      rec.memoHeadYaw = raw.headYaw
      rec.memoOnGround = raw.onGround
      rec.memoGlide = raw.elytraFlying
      rec.memoMyPos = myPos ? { x: myPos.x, y: myPos.y, z: myPos.z } : null
      rec.memoRawPos = rawPos ? { x: rawPos.x, y: rawPos.y, z: rawPos.z } : null
    }
    if (!view._ndVisible) return
    const now = raw._ndObservationNow?.() ?? gameClock.observationNow()
    const moved = !view.position || !view.position.equals(raw.position)
    for (const key of ['id', 'type', 'name', 'username', 'uuid', 'height', 'width', 'onGround', 'yaw', 'pitch', 'headYaw', 'elytraFlying', '_ndGlideBoosted', '_ndGlideRevision']) view[key] = raw[key]
    if (view.position) view.position.update(raw.position)
    else view.position = raw.position.clone()
    const rawMeta = raw.metadata
    const metaLen = rawMeta?.length || 0
    const meta = new Array(metaLen)
    for (let i = 0; i < metaLen; i++) meta[i] = (i === healthIdx || i === absorptionIdx) ? undefined : cloneMetaValue(rawMeta[i])
    view.metadata = meta
    if (rec.inspectGear) {
      const canReuseGearRays = wasVisible && !!rec.gear && hasTick && terrainVer !== null &&
        terrainVer === rec.gearTerrainVer &&
        (tick - rec.gearTick) < 4 &&
        rec.gearHeight === raw.height &&
        nearXYZ(rec.gearMyPos, myPos, 0.15 * 0.15) &&
        nearXYZ(rec.gearRawPos, rawPos, 0.15 * 0.15)
      if (canReuseGearRays) {
        rec.gear = refreshVisibleEquipment(raw, rec.gear)
      } else {
        rec.gear = observePlayerGear(bot, raw, rec.gear)
        rec.gearTick = hasTick ? tick : -Infinity
        rec.gearTerrainVer = terrainVer
        rec.gearHeight = raw.height
        rec.gearMyPos = myPos ? { x: myPos.x, y: myPos.y, z: myPos.z } : null
        rec.gearRawPos = rawPos ? { x: rawPos.x, y: rawPos.y, z: rawPos.z } : null
      }
      view.equipment = rec.gear.equipment
      view._ndMaceSeen ||= rec.gear.equipment.slice(0, 2).some(it => it?.name === 'mace')
      view._ndGearVisible = rec.gear.visible
      view._ndUnknownArmorSlots = rec.gear.unknownArmorSlots
    }
    view._ndSeenAt = gameClock.now()
    if (!wasVisible || moved || (receipt && receipt !== rec.receipt)) {
      // Keep the public discontinuity after its baseline packet leaves the two-receipt window.
      const relative = /^(rel_entity_move|entity_move_look)$/.test(receipt?.kind || '')
      if (!wasVisible || !relative) view._ndMotionEpoch = (view._ndMotionEpoch || 0) + 1
      const current = { ...receipt, x: view.position.x, y: view.position.y, z: view.position.z,
        t: receipt?.t ?? now, grounded: view.onGround, ...(!wasVisible ? { kind: 'reacquired' } : {}) }
      // A hidden displacement is a new baseline, never a measured speed.
      view._ndEarlierPositionReceipt = wasVisible && relative && receipt !== rec.receipt ? view._ndPositionReceipts?.[0] : null
      view._ndPositionReceipts = [wasVisible ? view._ndPositionReceipts?.[1] : null, current]
      rec.receipt = receipt
      view.emit('ndPositionObserved')
    }
  }
  const track = (e, occluded: boolean, inspectGear = true) => {
    if (!e || (e.type !== 'player' && !e.username)) return e
    const raw = source(e)
    const past = retired.get(raw)
    if (past) return past.position ? past : null
    let rec = records.get(raw.id)
    if (!rec || rec.raw !== raw) {
      if (raw.isValid === false) return null
      if (rec) gone(rec.raw)
      const view: any = new EventEmitter()
      sources.set(view, raw)
      view._ndVisible = false
      view._ndUnknownArmorSlots = 4
      view._ndObservationNow = () => raw._ndObservationNow?.() ?? gameClock.observationNow()
      Object.defineProperties(view, {
        velocity: { get: () => (require('../bow/track') as typeof import('../bow/track')).trackTarget(view).vel() },
        heldItem: { get: () => view.equipment?.[0] }
      })
      rec = { raw, view }
      rec.update = () => refresh(rec)
      raw.on?.('ndPositionObserved', rec.update)
      records.set(raw.id, rec)
    }
    rec.inspectGear ||= inspectGear
    refresh(rec, occluded)
    return rec.view.position ? rec.view : null
  }
  const observe = e => track(e, false)
  const tick = () => { for (const rec of records.values()) refresh(rec) }
  const swing = e => {
    const rec = records.get(e?.id)
    if (!rec || rec.raw !== e) return
    refresh(rec)
    if (rec.view._ndVisible) rec.view._ndSwingAt = gameClock.now()
  }
  bot.on('physicsTick', tick)
  bot.on('entityGone', gone)
  bot.on('entitySwingArm', swing)
  bot.on('entityEquip', onEquipEntity)
  bot.on('entityUpdate', onMetaEntity)
  bot._client?.on?.('entity_equipment', onEquipPacket)
  return {
    observe, observeMotion: e => track(e, false, false), source,
    markOccluded: e => { track(e, true) },
    visible: e => { const observed = observe(e); return !!observed && observed._ndVisible !== false },
    close () {
      bot.removeListener('physicsTick', tick)
      bot.removeListener('entityGone', gone)
      bot.removeListener('entitySwingArm', swing)
      bot.removeListener('entityEquip', onEquipEntity)
      bot.removeListener('entityUpdate', onMetaEntity)
      bot._client?.removeListener?.('entity_equipment', onEquipPacket)
      for (const rec of records.values()) rec.raw.removeListener?.('ndPositionObserved', rec.update)
      records.clear()
    }
  }
}

export { createLastSeen, seesPlayer, visiblePlayerItem, gearPartVisible, observePlayerGear }

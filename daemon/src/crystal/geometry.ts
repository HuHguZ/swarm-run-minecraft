'use strict'
// Кристаллы (crystal.ts): константы, рамки и лучи — куда ставить, чем бить, что закрывает.

import * as pick from '../pick'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

const P = 6
const EYE = 1.62
const HIT_R = 3.0
const PLACE_R = 4.5
const TICK = 50
const IFRAME_MS = 500
const AIRS = new Set(['air', 'cave_air', 'void_air'])
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
// Якорь: сила 5, взрывается там, где не работает (верхний мир, Край).
const ANCHOR_P = 5
const ANCHOR_WORLDS = /overworld|end$|the_end/
// Якорь готов к бою: якоря и светокамень есть, измерение — где он взрывается.
const anchorReady = (bot, k) => k.anchors > 0 && k.glowstone > 0 && ANCHOR_WORLDS.test(bot.game && bot.game.dimension || 'overworld')

const r1 = (x) => Math.round(x * 10) / 10

// Щит (javap 1.21.11, research/claude-1006/s7c/jar): взрыв кристалла/якоря не в #bypasses_shield,
// LivingEntity.applyItemBlocking → BlocksAttacks.resolveBlockedDamage по DamageSource.getSourcePosition
// (кристалл — его позиция, якорь — центр блока): горизонтальный угол взгляда на источник ≤ 90° — урон 0
// (DamageReduction щита: base 0, factor 1). Толчок взрыва щит не гасит (ServerExplosion.hurtEntities: push
// после hurtServer). Держит через 5 тиков после подъёма.
function shieldUpOf (bot, e) {
  try { const u = (require('../pvp/combat-observe') as typeof import('../pvp/combat-observe')).usingOf(bot, e); return !!(u && u.name === 'shield') } catch { return false }
}
// Кэш лучей без одной клетки: якорь снимается раньше взрыва (RespawnAnchorBlock.explode: removeBlock, потом
// explode) — его блок лучам не преграда. Кэш — как в boom.segmentBlocked (get/set по «x,y,z»).
function without (cache, cell) {
  const ak = `${cell.x},${cell.y},${cell.z}`
  return { get: (k) => (k === ak ? null : cache.get(k)), set: (k, v) => { if (k !== ak) cache.set(k, v) }, has: (k) => k === ak || cache.has(k) }
}
function shieldCovers (e, at, src) {
  const dm: typeof import('../pvp/damage-model') = require('../pvp/damage-model')
  return dm.shieldAngle(e.headYaw ?? e.yaw ?? 0, at || e.position, src) <= dm.SHIELD_HALF_ANGLE
}

// ---------------------------------------------------------------- геометрия

function boxOf (e) {
  const w = e.width ?? 0.6
  const h = e.height ?? 1.8
  const p = e.position
  return { minX: p.x - w / 2, minY: p.y, minZ: p.z - w / 2, maxX: p.x + w / 2, maxY: p.y + h, maxZ: p.z + w / 2 }
}
function intersects (a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ
}
// Рамка кристалла 2×2×2 с центром низа в c.
function crystalBox (c) { return { minX: c.x - 1, minY: c.y, minZ: c.z - 1, maxX: c.x + 1, maxY: c.y + 2, maxZ: c.z + 1 } }
function boxDist (p, b) {
  const x = Math.max(b.minX, Math.min(p.x, b.maxX))
  const y = Math.max(b.minY, Math.min(p.y, b.maxY))
  const z = Math.max(b.minZ, Math.min(p.z, b.maxZ))
  return Math.hypot(p.x - x, p.y - y, p.z - z)
}

function blockAt (bot, cache, x, y, z) {
  const k = `${x},${y},${z}`
  if (cache && cache.has('b' + k)) return cache.get('b' + k)
  let b = null
  try { b = (cache?.world || bot).blockAt(new Vec3(x, y, z), false) } catch {}
  if (cache) cache.set('b' + k, b)
  return b
}
const copyCache = cache => Object.assign(new Map(cache), cache?.world ? { world: cache.world } : {})
const isAirB = (b) => !!b && AIRS.has(b.name)
const isBaseB = (b) => !!b && (b.name === 'obsidian' || b.name === 'bedrock')
const solidB = (b) => !!b && b.boundingBox === 'block'

// Можно ли поставить кристалл на блок base (EndCrystalItem.useOn): обсидиан
// или бедрок, над ним воздух, в столбе 1×2 над ним ни одной сущности.
function baseFree (bot, base, { cache = null, ents = null }: any = {}) {
  if (!isBaseB(blockAt(bot, cache, base.x, base.y, base.z))) return false
  if (!isAirB(blockAt(bot, cache, base.x, base.y + 1, base.z))) return false
  const col = { minX: base.x, minY: base.y + 1, minZ: base.z, maxX: base.x + 1, maxY: base.y + 3, maxZ: base.z + 1 }
  for (const e of ents || (Object.values(bot.entities || {}) as any[])) {
    if (!e || !e.position || e.isValid === false) continue
    if (intersects(col, boxOf(e))) return false
  }
  return true
}
const centerOf = (base) => new Vec3(base.x + 0.5, base.y + 1, base.z + 0.5)

// Живое и кристаллы перекрывают прицел клиента (GameRenderer.pick: сущность
// под лучом раньше блока — клик уйдёт в неё, не в грань).
function pickBlockers (bot, eye) {
  return (Object.values(bot.entities || {}) as any[]).filter((e : any) => e && e !== bot.entity && e.position && e.isValid !== false &&
    e.position.distanceTo(eye) < 9 && (e.type === 'player' || e.name === 'end_crystal' || /mob|hostile|animal|passive|water|ambient/.test(e.type || '')))
}

// Грань блока base, в которую можно честно кликнуть (pick.faceAim): верх
// первым, потом бока к нам. Возвращает { face, pt } или null.
const FACES = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
function faceFor (bot, base, eye, avoid) {
  for (const f of FACES) {
    const c = base.offset(0.5 + f.x * 0.5, 0.5 + f.y * 0.5, 0.5 + f.z * 0.5)
    if ((eye.x - c.x) * f.x + (eye.y - c.y) * f.y + (eye.z - c.z) * f.z <= 0) continue
    if (c.distanceTo(eye) > PLACE_R + 0.6) continue
    const pt = pick.faceAim(bot, base, f, { eye, range: PLACE_R - 0.05, avoid })
    if (pt) return { face: f, pt }
  }
  return null
}

// Ударить кристалл (в точке center) отсюда: рамка 2×2×2 в 3.0 от глаз, луч к
// точке рамки не упирается в блок (как pick.aim) и не проходит сквозь рамку
// сущности раньше кристалла — он сам, другой кристалл, моб: прицел клиента взял
// бы их, не кристалл (GameRenderer.pick; ревью Codex 2026-09-30). Перебор точек
// рамки — кристалл за его спиной виден краем.
const AIM_FRACS = []
for (const fy of [0.5, 0.8, 0.3, 0.95, 0.1]) {
  for (const [fx, fz] of [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5], [0.5, 0.15], [0.5, 0.85], [0.15, 0.15], [0.85, 0.85], [0.15, 0.85], [0.85, 0.15]]) AIM_FRACS.push([fx, fy, fz])
}
function hitAim (bot, center, eye, range = HIT_R - 0.1) {
  const cb = crystalBox(center)
  if (boxDist(eye, cb) > range) return null
  const lo = { x: cb.minX, y: cb.minY, z: cb.minZ }
  const hi = { x: cb.maxX, y: cb.maxY, z: cb.maxZ }
  const occ = pickBlockers(bot, eye).filter((e : any) => e.position.distanceTo(center) >= 0.2).map(boxOf)
  for (const [fx, fy, fz] of AIM_FRACS) {
    const tp = new Vec3(lo.x + 2 * fx, lo.y + 2 * fy, lo.z + 2 * fz)
    const delta = tp.minus(eye)
    const len = delta.norm()
    if (len < 1e-6) return tp
    const d = delta.scaled(1 / len)
    const tE = pick.rayBox(eye, d, lo, hi, range + 0.001)
    if (tE == null || tE > range) continue
    if (pick.blockOnRay(bot, eye, d, tE)) continue
    if (occ.some(b => { const t = pick.rayBox(eye, d, { x: b.minX, y: b.minY, z: b.minZ }, { x: b.maxX, y: b.maxY, z: b.maxZ }, tE); return t != null && t < tE - 0.02 })) continue
    return tp
  }
  return null
}

// Независимая проверка «не сквозь стену» для счёта (другой луч — prismarine
// world.raycast по формам блоков): первый блок на пути к точке — не раньше неё.
function losClear (bot, eye, pt, { expectBlock = null }: any = {}) {
  try {
    const d = pt.minus(eye)
    const len = d.norm()
    if (len < 1e-3) return true
    const hit = bot.world.raycast(eye, d.scaled(1 / len), len + 0.05)
    if (!hit) return true
    if (expectBlock && hit.position && hit.position.equals(expectBlock)) return true
    const at = hit.intersect ? hit.intersect.distanceTo(eye) : hit.position.offset(0.5, 0.5, 0.5).distanceTo(eye)
    return at >= len - 0.03
  } catch { return false }
}

function surrounded (bot, cell, cache?) {
  return SIDES.every(s => solidB(blockAt(bot, cache, cell.x + s.x, cell.y, cell.z + s.z)))
}
function feetCell (p) { return new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-3), Math.floor(p.z)) }

export {
  P, EYE, HIT_R, PLACE_R, TICK, IFRAME_MS, AIRS, SIDES, ANCHOR_P, ANCHOR_WORLDS, anchorReady, r1, shieldUpOf, without, shieldCovers, boxOf, intersects, crystalBox, boxDist, blockAt, copyCache, isAirB, isBaseB, solidB, baseFree, centerOf, pickBlockers, FACES, faceFor, AIM_FRACS, hitAim, losClear, surrounded, feetCell
}

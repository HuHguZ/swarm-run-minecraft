'use strict'
// Ходьба: вода — клетки воды и воздуха, тики воздуха и всплытия, цена шага по воде, суша рядом, маршрут вплавь.
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as geometry from '../navigation/geometry'
import { lazyEyes, lazyPick } from './lazy'

// bot.entity.isInWater comes from the physics simulation and does not reliably
// flip on 1.21.11 — the bot was drowning with the flag reading false. Trust the
// blocks the body actually occupies instead.
export function inWater (bot) {
  if (!bot || !bot.entity) return false
  if (bot.entity.isInWater) return true
  const p = bot.entity.position
  for (const dy of [0, 0.9, -0.2]) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (waterCell(b)) return true
  }
  return process.env.ND_WATER_RESCUE === '1' && waterCell(bot.blockAt(lazyPick().eyeOf(bot)))
}

// Nearest spot with solid ground and breathable air above it.
export function findNearestLand (bot, maxRadius = 24) {
  const me = bot.entity.position.floored()
  for (let r = 1; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (let dy = -2; dy <= 12; dy++) {
          const p = me.offset(dx, dy, dz)
          const feet = bot.blockAt(p)
          const head = bot.blockAt(p.offset(0, 1, 0))
          const ground = bot.blockAt(p.offset(0, -1, 0))
          if (!feet || !head || !ground) continue
          if (waterCell(ground) || ground.boundingBox !== 'block') continue
          if (waterCell(feet) || feet.boundingBox !== 'empty') continue
          if (waterCell(head) || head.boundingBox !== 'empty') continue
          return p
        }
      }
    }
  }
  return null
}

// These plants contain source water even though their collision box is empty.
export const waterCell = b => !!b && (/^(water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/.test(b.name) ||
  (process.env.ND_WATER_ESCAPE_BUDGET !== '0' || process.env.ND_WATER_RESCUE === '1') && (b.isWaterlogged || b.getProperties?.().waterlogged === true))
const swimPassable = b => !!b && b.boundingBox === 'empty' && !/lava/.test(b.name)
export const breathCell = b => swimPassable(b) && (!waterCell(b) || process.env.ND_WATER_RESCUE === '1' && b.name === 'bubble_column')
export const headWet = bot => {
  const b = bot.blockAt(lazyPick().eyeOf(bot))
  return waterCell(b) && !(process.env.ND_WATER_RESCUE === '1' && b.name === 'bubble_column')
}
export const dryFooting = bot => !!bot.entity.onGround && !inWater(bot) && bot.blockAt(bot.entity.position.offset(0, -0.2, 0))?.boundingBox === 'block'
export const idleBreath = bot => {
  const p = bot.entity.position.offset(0, 1.62, 0)
  if (!lazyEyes().seesNow(bot, p)) return false
  const b = bot.blockAt(p)
  return breathCell(b)
}

// LivingEntity.baseTick: air -20 costs 2 HP, resets to 0; oxygenLevel is rounded air/15.
export function airTicks (bot) {
  const key = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('air_supply') ?? -1
  const air = key >= 0 ? bot.entity.metadata?.[key] : undefined
  return Number.isFinite(air) ? air : Math.max(0, (bot.oxygenLevel ?? 20) * 15 - 7)
}

// J: eight bubbles of air in native ticks, using air_supply when present.
// Physical air debt remains real while a different intent owns the body.
export const owDeathWaterOn = bot => typeof process !== 'undefined' && process.env.ND_OW_DEATH_WATER === '1' &&
  String(bot?.game?.dimension || '').replace(/^minecraft:/, '') === 'overworld'
export const owAirEmergency = bot => owDeathWaterOn(bot) && (bot.health ?? 20) > 0 && inWater(bot) && airTicks(bot) <= 8 * 15

// LivingEntity.jumpInLiquid / travelInWater: +.04, vertical drag .8, gravity .005.
export function swimUpTicks (height, velocity = 0) {
  let y = 0, ticks = 0
  while (y < height && ticks < 320) { velocity += .04; y += velocity; velocity = velocity * .8 - .005; ticks++ }
  return ticks
}

// Extra path cost in dry walking steps: a submerged step includes a visible return to air.
// Unknown/hidden depth is not inspected, and water remains a finite-cost option.
export function waterStepCost (bot, block) {
  if (process.env.ND_WATER_ESCAPE_BUDGET === '0' || !block?.position || !waterCell(block)) return 0
  let depth = 0
  for (let y = 1; y <= 16; y++) {
    const p = block.position.offset(0, y, 0)
    if (!lazyEyes().seesNow(bot, p) || !waterCell(bot.blockAt(p))) break
    depth++
  }
  const sprint = (bot.food ?? 20) > 6
  const eta = (1 - (sprint ? .9 : .8)) / (.02 * .98) + swimUpTicks(depth)
  const walkTicks = (1 - .546) / (.1 * .98 * (sprint ? 1.3 : 1))
  const hp = 2 * Math.ceil(Math.max(0, eta - airTicks(bot) - 20) / 20)
  // One path unit per predicted HP is a policy price, not a damage multiplier.
  return Math.min(90, Math.max(0, eta / walkTicks - 1) + hp)
}

// A dry ore can still have a wet approach (fp3-s14-1). Price only cells currently seen.
export function waterApproachCost (bot, target) {
  if (process.env.ND_WATER_ESCAPE_BUDGET === '0' || !bot.world || !bot.registry || !bot.game) return 0
  const from = bot.entity.position, d = Math.ceil(from.distanceTo(target)), seen = new Set()
  let cost = 0
  for (let i = 1; i <= d; i++) {
    const p = from.scaled(1 - i / d).plus(target.scaled(i / d)).floored(), key = p.toString()
    if (seen.has(key) || !lazyEyes().seesNow(bot, p)) continue
    seen.add(key)
    cost += waterStepCost(bot, bot.blockAt(p))
  }
  return cost
}

// Only the column currently visible from our eyes; no knowledge of air behind a roof.
export function airAbove (bot) {
  const eye = lazyPick().eyeOf(bot)
  for (let y = Math.floor(eye.y); y <= Math.floor(eye.y) + 16; y++) {
    const p = new Vec3(eye.x, y, eye.z)
    if (!lazyEyes().seesNow(bot, p)) return null
    const b = bot.blockAt(p)
    if (!swimPassable(b)) return null
    if (breathCell(b)) return p
  }
  return null
}

// Search connected body-sized cells, rather than declaring a whole pool closed
// because one column has a roof. Unknown cells and lava cannot be crossed.
// The first breath wins when air is scarce; otherwise try to reach dry ground.
export function findSwimRoute (bot, { radius = 8, rise = 12, visibleOnly = false, breathOnly = false, toward = null, observed = null }: any = {}) {
  // The PvP escape observes water/air as well as solid faces. Do not plan through
  // an opaque block containing our head; that remains the embedded-body rescue.
  if (visibleOnly && !geometry.bodyClear(bot, bot.entity.position, { water: true, web: true })) return null
  const known = new Map()
  const read = p => {
    if (!visibleOnly) return bot.blockAt(p)
    const key = p.toString()
    if (!known.has(key)) {
      let block = null
      try { if (lazyEyes().seesNow(bot, p)) { block = bot.blockAt(p); if (block) observed?.set(key, block) } else block = observed?.get(key) || null } catch {}
      known.set(key, block)
    }
    return known.get(key)
  }
  const start = bot.entity.position.floored()
  const underRoof = visibleOnly && (geometry.verticalLift(bot, bot.entity.position, 1) ?? 1) < 1
  const key = p => `${p.x},${p.y},${p.z}`
  const queue = [{ p: start, parent: -1 }]
  const seen = new Set([key(start)])
  let air = null, water = null
  const urgent = (breathOnly || (bot.oxygenLevel ?? 20) <= 8) && headWet(bot)
  const eyeCell = process.env.ND_WATER_ESCAPE_BUDGET !== '0' ? Math.floor(lazyPick().eyeHeight(bot)) : 1
  const route = (i, kind) => {
    const path = []
    const target = queue[i].p
    while (queue[i].parent >= 0) { path.unshift(queue[i].p); i = queue[i].parent }
    return { kind, target, path }
  }
  const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  // Same bounded observation work as shoreRoute; a partial search can still return a visible breath.
  for (let i = 0; i < queue.length && (process.env.ND_WATER_ESCAPE_BUDGET === '0' || i < 6000); i++) {
    const p = queue[i].p
    const feet = read(p)
    const head = read(p.offset(0, eyeCell, 0))
    const floor = read(p.offset(0, -1, 0))
    const land = swimPassable(feet) && swimPassable(head) && !waterCell(feet) && !waterCell(head) && floor?.boundingBox === 'block'
    if (land) return route(i, 'land')
    if (breathCell(head)) {
      if (!air) air = route(i, 'air')
      if (urgent) return air
    }
    if (toward && p.equals(toward)) return route(i, 'water')
    // Under an overhang, visible water can lead upward before its air becomes visible (j1k1-s2-4).
    if (underRoof && waterCell(feet) && waterCell(head) && p.y > start.y &&
        (p.x !== start.x || p.z !== start.z) && (!water || p.y > water.target.y)) water = route(i, 'water')
    const over = read(p.offset(0, 2, 0))
    const next = [...sides.map(d => p.plus(d)), p.offset(0, 1, 0), p.offset(0, -1, 0)]
    // A swim jump can leave water onto the ledge one block above it.
    if (swimPassable(over)) next.push(...sides.map(d => p.plus(d).offset(0, 1, 0)))
    for (const q of next) {
      if (Math.max(Math.abs(q.x - start.x), Math.abs(q.z - start.z)) > radius || Math.abs(q.y - start.y) > rise) continue
      if (seen.has(key(q))) continue
      const f = read(q); const h = read(q.offset(0, eyeCell, 0)); const g = read(q.offset(0, -1, 0))
      if (!swimPassable(f) || !swimPassable(h)) continue
      if (!waterCell(f) && !waterCell(h) && g?.boundingBox !== 'block' && !(process.env.ND_WATER_ESCAPE_BUDGET !== '0' && waterCell(g))) continue
      seen.add(key(q))
      queue.push({ p: q, parent: i })
    }
  }
  return air || (toward ? null : water)
}

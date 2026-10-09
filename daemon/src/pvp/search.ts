import { Vec3 } from 'vec3'
import { standPositions } from '../navigation/geometry'
import { visibleLanding } from '../navigation/parkour'
import { combatMovement } from './movement'
const { goals, Movements } = require('mineflayer-pathfinder')
const clock = require('../game-clock')
const pick = require('../pick')

// Shared by acquisition and LOS repositioning: packet-only cells stay unknown,
// including apparently empty head space above a visible support.
export function observedCollision (bot) {
  const cells = new Map(); let observedAt = -Infinity
  const sightWorld = { blockAt: pos => bot.blockAt(pos, false) ||
    { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } }
  return { physics: bot.physics, game: bot.game, blockAt (pos) {
    if (observedAt !== clock.now()) { observedAt = clock.now(); cells.clear() }
    const cell = pos.floored(); const key = cell.toString()
    if (cells.has(key)) return cells.get(key)
    const eye = pick.eyeOf(bot)
    const points = [[.5, .5, .5]]
    for (const x of [.05, .95]) for (const y of [.05, .95]) for (const z of [.05, .95]) points.push([x, y, z])
    const seen = points.some(([x, y, z]) => {
      const delta = cell.offset(x, y, z).minus(eye); const len = delta.norm()
      const hit = len > 0 ? pick.blockOnRay(sightWorld, eye, delta.scaled(1 / len), len, /glass|_pane$|^barrier$|^iron_bars$/) : null
      return !hit || hit.pos.equals(cell)
    })
    const block = seen ? bot.blockAt(cell, false) : null
    cells.set(key, block); return block
  } }
}

// Search viewpoints from our own pose and visible supports, never the hidden target's packets.
export async function acquireTarget (bot, ctl, vision, raw, { deadline, arena = null }: any) {
  const start = clock.now()
  const target = () => raw.username ? bot.players?.[raw.username]?.entity || raw : bot.entities?.[raw.id] || raw
  let entity = vision.observe(target())
  const search = { legs: 0, seconds: 0 }
  if (entity) return { entity, search }
  const movement = combatMovement(bot, arena)
  arena = movement.arena
  const observed = observedCollision(bot)
  const mv = bot.pathfinder.movements
  const getBlock = mv?.getBlock; const entityDetection = mv?.allowEntityDetection
  if (getBlock) {
    const visibleMoves = Object.create(mv); visibleMoves.bot = observed
    // fastblocks closes over the packet cache instead of reading this.bot.
    const readBlock = mv._ndFast ? Movements.prototype.getBlock : getBlock
    mv.getBlock = (...args) => readBlock.apply(visibleMoves, args)
    mv.allowEntityDetection = false // Packet-only entities must not alter this unseen-target route's cost.
  }
  const visited = [bot.entity.position.clone()]
  const yaw = bot.entity.yaw || 0
  let goal = null; let until = start; let moved = false
  const stop = () => { bot.pathfinder.setGoal(null); bot.clearControlStates() }
  let wake = null
  const cancel = () => wake?.()
  ctl.onAbort?.push(cancel)
  try {
    while (!ctl.aborted && bot.health > 0 && clock.now() < deadline) {
      entity = vision.observe(target())
      if (entity) break
      const me = bot.entity.position
      if (bot.entity.onGround && (!goal || me.distanceTo(goal) < 1.5 || clock.now() >= until)) {
        if (moved) stop()
        visited.push(me.clone())
        let best = null; let score = -Infinity
        for (let i = 0; i < 8; i++) for (const radius of [6, 3]) {
          const angle = yaw + i * Math.PI / 4
          const column = new Vec3(me.x - Math.sin(angle) * radius, me.y, me.z - Math.cos(angle) * radius)
          for (const p of standPositions(observed, column, { rise: 1.25, drop: 3 })) {
            if (arena && (p.y < Math.min(arena.y, Math.floor(me.y)) || Math.abs(p.x - arena.x) > arena.r - 1 || Math.abs(p.z - arena.z) > arena.r - 1)) continue
            if (!visibleLanding(bot, p)) continue
            const novelty = Math.min(...visited.map(old => p.distanceTo(old)))
            if (novelty > score) { best = p; score = novelty }
          }
        }
        goal = best
        until = clock.now() + 8000 // Same bounded leg as movement.stuckGuard.
        if (goal) {
          visited.push(goal.clone())
          if (visited.length > 64) visited.splice(0, visited.length - 64)
          bot.pathfinder.setGoal(new goals.GoalNear(goal.x, goal.y, goal.z, 1))
          search.legs++; moved = true
        }
      }
      await new Promise<void>(resolve => {
        const timer = clock.setTimeout(done, 100)
        function done () { clock.clearTimeout(timer); wake = null; resolve() }
        wake = done
      })
    }
    search.seconds = (clock.now() - start) / 1000
    return { entity, search }
  } finally {
    cancel()
    if (ctl.onAbort) { const i = ctl.onAbort.indexOf(cancel); if (i >= 0) ctl.onAbort.splice(i, 1) }
    try { if (moved) stop() } finally {
      if (getBlock) { mv.getBlock = getBlock; mv.allowEntityDetection = entityDetection }
      movement.restore()
    }
  }
}

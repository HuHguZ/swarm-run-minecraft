// Булава (mace.ts): мир вокруг — досягаемость удара, опора под телом, огонь и лава у ног, посадка (прогон физики),
// цена падения, паутина на теле, воздух над головой.
import vec3 from 'vec3'
import * as edges from '../edges'
// Честный удар (pick.js, 2026-09-26): сквозь крышу его коробки не бить.
import * as pick from '../pick'
import { clamp } from './consts'
// Фабрика vec3 (parseFloat, null → 0,0,0), как прежний require('vec3'); тип — класс Vec3.
export const Vec3 = vec3 as unknown as typeof import('vec3').Vec3

export function reachFrom (eye, e, bot = null) {
  const hw = (e.width || 0.6) / 2
  const h = bot ? pick.hitboxOf(bot, e).h : (e.height || 1.8)
  const p = e.position
  const cx = clamp(eye.x, p.x - hw, p.x + hw)
  const cy = clamp(eye.y, p.y, p.y + h)
  const cz = clamp(eye.z, p.z - hw, p.z + hw)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

// Верх опоры под телом (edges.support: самая высокая колонка под углами рамки).
export function floorTop (bot, pos) {
  try {
    const s = edges.support(bot, pos, new Map())
    return Number.isFinite(s.drop) ? pos.y - s.drop : -Infinity
  } catch { return -Infinity }
}

// Стоит ли он на чём-то: mineflayer onGround чужих сущностей не ведёт вовсе
// (entities.js его не пишет — поле всегда undefined), поэтому по опоре под
// рамкой (edges.support) и по вертикальной скорости.
export function grounded (bot, e, vy = 0) {
  if (!e || !e.position) return true
  if (Math.abs(vy) > 0.1) return false
  try {
    const s = edges.support(bot, e.position, new Map())
    return s.drop <= 0.05
  } catch { return true }
}

// Огонь и лава у ног в радиусе r: сесть туда после взлёта — 4 хп за 10 тиков
// (арена 2026-09-26: удар с падения убил, а сам сел в лаву — −11 и смерть).
const BURN = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/
export function burnNear (bot, pos, r = 2.5) {
  const c = pos.floored()
  for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
    for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
      if (dx * dx + dz * dz > r * r + 0.5) continue
      for (const dy of [0, -1]) {
        const b = bot.blockAt(c.offset(dx, dy, dz))
        if (b && BURN.test(b.name)) return true
      }
    }
  }
  return false
}

// Где сядем с этими клавишами (2026-09-26): прогон той же физики
// (prismarine-physics мимо рефлекса края — bot._ndSimOrig) до первой опоры или
// лавы; burn — посадка в лаву, огонь, магму, костёр.
export function burnAt (bot, pos) {
  for (const [sx, sz] of [[0, 0], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
    for (const dy of [0.2, -0.5]) {
      const b = bot.blockAt(new Vec3(Math.floor(pos.x + sx), Math.floor(pos.y + dy), Math.floor(pos.z + sz)))
      if (b && BURN.test(b.name)) return true
    }
  }
  return false
}
export function landing (bot, control, { maxTicks = 60, observed = false, arena = null }: any = {}) {
  try {
    const sim = (bot._ndSimOrig || bot.physics.simulatePlayer).bind(bot.physics)
    const view = observed ? (require('../pvp/search') as typeof import('../pvp/search')).observedCollision(bot) : bot
    const world = { getBlock: (p) => view.blockAt(p, false) }
    const st = edges.stateOf(bot, control)
    for (let t = 0; t < maxTicks; t++) {
      sim(st, world)
      if (arena && (Math.abs(st.pos.x - arena.x) + .3 > arena.r || Math.abs(st.pos.z - arena.z) + .3 > arena.r || st.pos.y <= (arena.killY ?? -64))) return null
      if (st.isInLava) return { at: st.pos, burn: true, t }
      if (st.onGround) return { at: st.pos, burn: burnAt(bot, st.pos), t, landed: true }
    }
    return { at: st.pos, burn: false, t: maxTicks, landed: false }
  } catch { return null }
}
export const NO_KEYS = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
export const AIR_KEYS = [{}, { forward: true }, { back: true }, { left: true }, { right: true }, { forward: true, left: true }, { forward: true, right: true }, { back: true, left: true }, { back: true, right: true }].map(k => ({ ...NO_KEYS, ...k }))
export function fallCost(bot, at, peak) {
  const floor = bot.blockAt(at.offset(0, -.01, 0).floored())
  if (!floor) return Infinity
  const dm: typeof import('../pvp/damage-model') = require('../pvp/damage-model'), read: typeof import('../read') = require('../read')
  const worn = [5, 6, 7, 8].map(s => bot.inventory.slots[s]).filter(Boolean).map(it => ({ name: it.name, ench: { protection: read.enchLevel(bot, it, 'protection'), feather_falling: read.enchLevel(bot, it, 'feather_falling') } }))
  const resistance = bot.registry?.effectsByName?.resistance
  const raw = (require('../navigation/landing') as typeof import('../navigation/landing')).landingDamage(floor, Math.max(0, peak - at.y), bot.entity.attributes)
  return dm.afterDefense(raw, 'fall', dm.defenseOf(worn, { resistance: bot.entity.effects?.[resistance?.id]?.amplifier ?? -1 }))
}

// Паутина в рамке тела (ноги и голова, четыре угла) — prismarine ставит
// isInWeb по тем же клеткам.
export function webOnBody (bot) {
  if (bot.entity && bot.entity.isInWeb) return true
  const p = bot.entity.position
  for (const [dx, dz] of [[0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
    for (const dy of [0.1, 1.0, 1.7]) {
      const b = bot.blockAt(new Vec3(Math.floor(p.x + dx), Math.floor(p.y + dy), Math.floor(p.z + dz)))
      if (b && b.name === 'cobweb') return true
    }
  }
  return false
}

// Сколько блоков воздуха над головой (до n).
export function headroom (bot, pos, n = 14) {
  const f = pos.floored()
  for (let i = 2; i < n + 2; i++) {
    for (const [dx, dz] of [[0, 0], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
      const b = bot.blockAt(new Vec3(Math.floor(pos.x + dx), f.y + i, Math.floor(pos.z + dz)))
      if (!b || b.boundingBox !== 'empty') return i - 2
    }
  }
  return n
}

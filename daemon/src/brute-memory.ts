// ND_BRUTE_MEMORY=1. Coordinates below are copies of ray-visible observations.
// The first observed area is an assumed patrol anchor, NOT the native HOME memory:
// a brute can be chasing already when first seen, and HOME does not leash combat.
import * as gameClock from './game-clock'
import { entities } from './perception/eyes'

type Point = { x: number; y: number; z: number }
export type BruteSpot = Point & { id: number; seenAt: number; firstSeenAt: number; assumedPatrolAnchor: Point }
type Memory = { spots: Map<string, BruteSpot>; sampledAt: number; installed: boolean; priced: Map<string, Point>; lastResetAt: number; replan: boolean }
const movementOwners = new WeakSet<object>()
const pathfinderOwners = new WeakSet<object>()
const dimension = bot => String(bot?.game?.dimension || '').replace(/^minecraft:/, '')
export const enabled = () => process.env.ND_BRUTE_MEMORY === '1'
const point = (p: Point): Point => ({ x: p.x, y: p.y, z: p.z })
const valid = p => p && [p.x, p.y, p.z].every(Number.isFinite)
function memory (bot): Memory {
  return bot._ndBruteMemory || (bot._ndBruteMemory = { spots: new Map(), sampledAt: -Infinity, installed: false, priced: new Map(), lastResetAt: -Infinity, replan: false })
}

export function observe (bot, force = false) {
  if (!enabled() || !bot?.entity || (bot.health ?? 20) <= 0 || dimension(bot) !== 'the_nether') return
  const m = memory(bot), now = gameClock.now()
  if (!force && now >= m.sampledAt && now - m.sampledAt < 100) return
  m.sampledAt = now
  // entities.seen uses the fail-closed eyes ray, unlike perception.raySees's
  // fail-open fallback. Hidden entity positions never enter this map.
  let seen: any[] = []
  try { seen = entities(bot, { radius: 48, rememberMs: 0, hearMs: 0 }) } catch { return }
  for (const e of seen) {
    if (!e.seen || e.name !== 'piglin_brute' || !valid(e.pos)) continue
    const key = String(e.id), old = m.spots.get(key)
    m.spots.set(key, { id: e.id, ...point(e.pos), seenAt: now,
      firstSeenAt: old?.firstSeenAt ?? now,
      assumedPatrolAnchor: old ? point(old.assumedPatrolAnchor) : point(e.pos) })
    const priced = m.priced.get(key)
    if (!priced || Math.hypot(priced.x - e.pos.x, priced.y - e.pos.y, priced.z - e.pos.z) >= 2) {
      m.replan = true; m.priced.set(key, point(e.pos))
      console.log('[brute-memory]', JSON.stringify({ id: e.id, lastSeenPos: point(e.pos), seenAt: now, ray: true, anchorApprox: true }))
    }
  }
  // Bounded session memory; unload and loss of LOS do not erase an observation.
  if (m.spots.size > 256) {
    const oldest = [...m.spots].sort((a, b) => a[1].seenAt - b[1].seenAt)
    for (const [key] of oldest.slice(0, m.spots.size - 256)) { m.spots.delete(key); m.priced.delete(key) }
  }
  // A remembered price must affect an already executing route as well. The
  // native setter invalidates its path while preserving the current goal.
  if (m.replan && now - m.lastResetAt >= 500 && bot.pathfinder?.movements) {
    m.replan = false; m.lastResetAt = now
    for (const [key, s] of m.spots) m.priced.set(key, point(s))
    bot.pathfinder.setMovements(bot.pathfinder.movements)
  }
}

export function install (bot) {
  if (!enabled() || !bot) return
  const m = memory(bot)
  if (!m.installed) {
    m.installed = true
    const tick = () => observe(bot)
    const clear = () => { m.spots.clear(); m.priced.clear(); m.sampledAt = -Infinity; m.replan = false }
    bot.on?.('physicsTick', tick)
    bot.on?.('death', clear)
    bot.once?.('end', () => { bot.removeListener?.('physicsTick', tick); bot.removeListener?.('death', clear); clear(); m.installed = false })
  }
  // Some skills construct a private Movements instead of calling worlds.ts.
  // Decorate both execution and speculative searches, once per pathfinder.
  const pf = bot.pathfinder
  if (pf && !pathfinderOwners.has(pf)) {
    pathfinderOwners.add(pf)
    for (const name of ['setMovements', 'getPathTo', 'getPathFromTo']) {
      const original = pf[name]
      if (typeof original !== 'function') continue
      pf[name] = function (...args) { addPrice(bot, args[0]); return original.apply(this, args) }
    }
    if (pf.movements) addPrice(bot, pf.movements)
  }
  observe(bot)
}

export function spots (bot): BruteSpot[] {
  if (!enabled() || dimension(bot) !== 'the_nether') return []
  const m: Memory = bot?._ndBruteMemory
  return m ? [...m.spots.values()].map(s => ({ ...s, assumedPatrolAnchor: point(s.assumedPatrolAnchor) })) : []
}

// Price, not a claim about current occupancy. Core 13 blocks, a soft margin to
// 16 (including the jar's variable follow range up to 13.38), vertical band 8.
function zone (p: Point, s: Point) {
  if (Math.abs(p.y - s.y) > 8) return 0
  const d = Math.hypot(p.x - s.x, p.z - s.z)
  return d <= 13 ? 1 : d < 16 ? (16 - d) / 3 : 0
}
const amplitude = (now: number, seenAt: number) => Math.max(4, 16 / (1 + Math.max(0, now - seenAt) / 120000))

export function riskNear (bot, p = bot?.entity?.position): { cost: number; nearest: number | null; ageMs: number | null; count: number } {
  const result = { cost: 0, nearest: null as number | null, ageMs: null as number | null, count: 0 }
  if (!enabled() || dimension(bot) !== 'the_nether' || !valid(p)) return result
  const m: Memory = bot?._ndBruteMemory
  if (!m) return result
  const now = gameClock.now()
  for (const s of m.spots.values()) {
    const weight = zone(p, s)
    if (!weight) continue
    const d = Math.hypot(p.x - s.x, p.z - s.z)
    result.count++
    result.cost = Math.max(result.cost, weight * amplitude(now, s.seenAt))
    if (result.nearest === null || d < result.nearest) { result.nearest = d; result.ageMs = Math.max(0, now - s.seenAt) }
  }
  return result
}

export const shelterRisk = riskNear
// ND_NE_BRUTE_POSTS: посты брутов шаблона (hyp-focus.brutePosts) — та же цена, что у первого места увиденного брута; снимок раз в 2 с
// (A* зовёт цену на каждую клетку). nbp99a-5408: 11 блоков золота в руках, ход из гнезда к входу штрека через этаж брутов y45–48 — брут
// из-за угла в 2 бл., 12.9 + 8.3.
function templatePosts (bot): Point[] {
  if (process.env.ND_NE_BRUTE_POSTS !== '1') return []
  const now = gameClock.now(), c = bot._ndBrutePostsCache
  if (c && now - c.at < 2000 && now >= c.at) return c.posts
  let posts: Point[] = []
  try { posts = (require('./bastion/hyp-focus') as typeof import('./bastion/hyp-focus')).brutePosts(bot) } catch {}
  bot._ndBrutePostsCache = { at: now, posts }
  return posts
}
export function penalty (bot, p: Point): number {
  if (!enabled() || dimension(bot) !== 'the_nether' || !valid(p)) return 0
  const m: Memory = bot?._ndBruteMemory
  if (!m) return 0
  let near = 0, anchor = 0
  const now = gameClock.now()
  for (const s of m.spots.values()) {
    near = Math.max(near, zone(p, s) * amplitude(now, s.seenAt))
    anchor = Math.max(anchor, zone(p, s.assumedPatrolAnchor) * 4)
  }
  for (const t of templatePosts(bot)) anchor = Math.max(anchor, zone(p, t) * 4)
  // Native Movements rejects a whole move at >=100. Do not sum a crowd into
  // a forbidden step; even an exit starting inside a danger zone stays possible.
  return Math.min(20, near + anchor)
}

function addPrice (bot, movements) {
  if (!enabled() || !Array.isArray(movements?.exclusionAreasStep)) return movements
  if (!movementOwners.has(movements)) {
    movementOwners.add(movements)
    movements.exclusionAreasStep.push(block => {
      const p = block?.position
      return p ? penalty(bot, { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }) : 0
    })
  }
  return movements
}

export function tuneMovements (bot, movements) {
  if (!enabled()) return movements
  install(bot)
  return addPrice(bot, movements)
}
export const priceMovements = tuneMovements

export function routeZones (bot): number[][] {
  const now = gameClock.now()
  return spots(bot).flatMap(s => [[s.x, s.y, s.z, amplitude(now, s.seenAt)],
    [s.assumedPatrolAnchor.x, s.assumedPatrolAnchor.y, s.assumedPatrolAnchor.z, 4]])
}

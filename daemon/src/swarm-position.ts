import { Vec3 } from 'vec3'
import { observedCollision } from './pvp/search'
import { bodyClear, dimensions, HAZARD, shapeBoxes, standPositions, supportAt, type Point, type CollisionWorld } from './navigation/geometry'
import { landingDamage } from './navigation/landing'
import { windInside, windLanding, type WindArena } from './combat/team-wind'
const pick = require('./pick')
const edges = require('./edges')
const projectile = require('./throw')
const { seesPlayer } = require('./pvp/last-seen')
const clock = require('./game-clock')
const terrainMemory = new WeakMap<object, Map<string, { block: any; at: number }>>()

export type PositionPurpose = 'ranged' | 'recover' | 'escape' | 'build'
export type PositionMethod = 'walk' | 'pearl' | 'wind' | 'build'
export interface SwarmPositionQuery {
  purpose: PositionPurpose
  arena?: WindArena
  enemies?: Array<{ id: string | number }>
  radius?: number
  limit?: number
  methods?: PositionMethod[]
  reserve?: Record<string, number>
  // Потолок времени ответа по стене (мс): арена реального времени не ждёт полного обзора. Без него — полный обзор.
  budgetMs?: number
}
export interface PositionAccess { kind: PositionMethod; cost: number; skill: string; params: any; plan?: any }
export interface SwarmPosition {
  at: Point; score: number; cover: number; highGround: number; sight: string[]
  support: string; methods: PositionAccess[]; why: string[]
}
const point = (p: Point): Point => ({ x: p.x, y: p.y, z: p.z })
const vector = (p: Point) => new Vec3(p.x, p.y, p.z)
const key = (p: Point) => `${p.x},${p.y},${p.z}`
const finite = (p: Point) => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
const UNKNOWN = { name: 'unknown', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }

function observedWorld(bot: any): CollisionWorld {
  const owner = bot._ndPositionOwner || bot, sight = observedCollision(owner), cache = new Map<string, any>()
  let memory = terrainMemory.get(owner)
  if (!memory) {
    memory = new Map(); terrainMemory.set(owner, memory)
    owner.on?.('blockUpdate', (old, updated) => { const at = updated?.position || old?.position; if (at) memory!.delete(key(at)) })
  }
  return { physics: sight.physics, game: sight.game, blockAt(p: Vec3) {
    const at = p.floored(), id = key(at)
    if (!cache.has(id)) {
      const seen = sight.blockAt(at), now = clock.now()
      if (seen) memory!.set(id, { block: seen, at: now })
      const old = memory!.get(id)
      if (old && now - old.at > 30_000) memory!.delete(id)
      cache.set(id, seen || (old && now - old.at <= 30_000 ? old.block : null))
    }
    return cache.get(id)
  } }
}

function ray(world: CollisionWorld, from: Vec3, to: Vec3) {
  const delta = to.minus(from), length = delta.norm()
  if (length < 1e-7) return null
  return pick.blockOnRay({ blockAt(p: Vec3) { return world.blockAt(p) || { ...UNKNOWN, position: p.floored() } } }, from, delta.scaled(1 / length), length)
}

// A walking promise needs a supported, observed corridor; parkour/flight get their own physics check.
function walkCost(world: CollisionWorld, from: Vec3, to: Vec3, arena?: WindArena): number | null {
  if (Math.abs(to.y - from.y) > .6) return null
  const length = from.distanceTo(to), samples = Math.max(1, Math.ceil(length * 4))
  let last = from
  for (let i = 0; i <= samples; i++) {
    const p = from.plus(to.minus(from).scaled(i / samples)), support = supportAt(world, p.offset(0, .6, 0), 1.2)
    if (!support || Math.abs(support.top - p.y) > .6) return null
    p.y = support.top
    if (Math.abs(p.y - last.y) > .6 || !windInside(p, arena, dimensions(world).half) || !bodyClear(world, p)) return null
    last = p
  }
  return length / 4.3
}

function visibleEnemies(bot: any, ids: SwarmPositionQuery['enemies']) {
  const result: Array<{ id: string; position: Vec3; eye: Vec3 }> = []
  for (const request of ids || []) {
    const entity: any = Object.values(bot.entities || {}).find((e: any) => e && (e.username === request.id || e.id === request.id))
    if (!entity || entity === bot.entity || !seesPlayer(bot, entity)) continue
    // Read pose only AFTER our own vision succeeds. Supplied positions/health/inventory never enter this query.
    result.push({ id: String(entity.username || entity.id), position: entity.position.clone(), eye: entity.position.offset(0, pick.eyeHeight(bot, entity), 0) })
  }
  return result
}

function tactical(world: CollisionWorld, at: Vec3, start: Vec3, enemies: ReturnType<typeof visibleEnemies>, purpose: PositionPurpose, hasBow: boolean) {
  let cover = 0, nearest = Infinity
  const sight: string[] = []
  for (const enemy of enemies) {
    nearest = Math.min(nearest, at.distanceTo(enemy.position))
    let blocked = 0
    for (const height of [.5, 1.1, 1.62]) {
      const hit = ray(world, enemy.eye, at.offset(0, height, 0))
      if (hit && world.blockAt(hit.pos)) blocked++ // Unknown cells cannot earn cover credit.
      if (!hit && height === 1.62) sight.push(enemy.id)
    }
    cover += blocked / 3
  }
  cover /= Math.max(1, enemies.length)
  const highGround = Math.max(0, at.y - (enemies.length ? Math.min(...enemies.map(e => e.position.y)) : start.y))
  const distance = start.distanceTo(at)
  const separation = Number.isFinite(nearest) ? Math.min(18, nearest) : 0
  const fireLane = sight.length / Math.max(1, enemies.length)
  let score = -distance * .12
  if (purpose === 'ranged') score += highGround * (hasBow ? 4 : .4) + fireLane * (hasBow ? 4 : .2) + cover * 2 + separation * .25
  if (purpose === 'recover') score += cover * 12 + separation * .9 - highGround * .15
  if (purpose === 'escape') score += cover * 5 + separation * 1.8
  if (purpose === 'build') score += cover * 5 + separation * .6 + highGround * .5
  return { cover, highGround, sight, score, why: [cover > .5 ? 'observed_cover' : 'open_footprint', highGround > 0 ? 'higher_support' : 'level_support'] }
}

function pearlFootprint(world: CollisionWorld, at: Point, arena?: WindArena): boolean {
  for (const x of [-.65, 0, .65]) for (const z of [-.65, 0, .65]) {
    const p = vector(at).offset(x, 0, z), floor = supportAt(world, p, .03)
    if (!floor || Math.abs(floor.top - at.y) > .02 || p.x <= floor.box.minX || p.x >= floor.box.maxX || p.z <= floor.box.minZ || p.z >= floor.box.maxZ || !windInside(p, arena) || !bodyClear(world, p)) return false
  }
  return true
}

function pearlTrial(bot: any, world: CollisionWorld, target: Vec3, arena: WindArena | undefined, context: any, sol: any) {
  if (!pearlFootprint(world, target, arena)) return null
  const { from, moved, airborne } = context
  let safe = true
  const adapter = { world: { raycast(p: Vec3, direction: Vec3, length: number) {
    const to = p.plus(direction.scaled(length))
    if (!windInside(p, arena, 0) || !windInside(to, arena, 0)) safe = false
    const hit = ray(world, p, to)
    if (!hit) return null
    const block = world.blockAt(hit.pos)
    if (!block) safe = false
    return { ...(block || { ...UNKNOWN, position: hit.pos }), intersect: p.plus(direction.scaled(hit.t)) }
  } } }
  const impact = projectile.landing(adapter, from, sol.yaw, sol.pitch, projectile.KINDS.ender_pearl, moved, airborne)
  if (!safe || !impact?.tp || impact.void || !bodyClear(world, impact.tp) || !windInside(impact.tp, arena)) return null
  const state = edges.cloneState(edges.stateOf(bot, edges.IDLE), edges.IDLE)
  state.pos = impact.tp.clone(); state.onGround = false; state.control = { ...edges.IDLE }
  const sim = edges.simOf(bot), collision = { getBlock: p => world.blockAt(p) }, path = [], peak = state.pos.y
  for (let tick = 0; tick < 40; tick++) {
    sim(state, collision); path.push(point(state.pos))
    if (!bodyClear(world, state.pos) || !windInside(state.pos, arena) || state.isInLava || state.isInWater) return null
    if (state.onGround) {
      const floor = supportAt(world, state.pos, .03)
      if (!floor || landingDamage(floor.block, Math.max(0, peak - state.pos.y), bot.entity.attributes) > 0 || !windLanding(world, state, target) || !pearlFootprint(world, state.pos, arena)) return null
      return { yaw: sol.yaw, pitch: sol.pitch, tp: point(impact.tp), land: point(state.pos), path, target: point(target), from: point(from), moved: point(moved), airborne, footprint: .65 }
    }
  }
  return null
}

function* pearlSearch(bot: any, world: CollisionWorld, target: Vec3, arena: WindArena | undefined, context: any) {
  const low = projectile.aim(context.from, target, projectile.KINDS.ender_pearl, context.moved, context.airborne)
  if (low) { const result = pearlTrial(bot, world, target, arena, context, low); if (result) return result; yield }
  // Low arcs can hit a roof's underside. Search the descending branch with the same native projectile model.
  // Precision follows a one-cell footprint; no coordinates or guessed launch physics enter the search.
  const yaw = Math.atan2(-(target.x - context.from.x), -(target.z - context.from.z))
  let best: any = null, nearest = Infinity
  for (let degree = 89.875; degree >= 45; degree -= .125) {
    const result = pearlTrial(bot, world, target, arena, context, { yaw, pitch: degree * Math.PI / 180 })
    if (result) {
      const off = Math.hypot(result.land.x - target.x, result.land.z - target.z)
      if (off < nearest) { nearest = off; best = result }
    }
    yield
  }
  return best
}

export async function pearlPositionPlan(bot: any, { to, arena }: { to: Point; arena?: WindArena }) {
  if (!finite(to) || !bot?.entity || !projectile.canSurvivePearl(bot) || !windInside(to, arena) || !windInside(bot.entity.position, arena)) return { ok: false, best: null, tried: 0 }
  const world = observedWorld(bot), target = vector(to)
  if (!bodyClear(world, target) || !pearlFootprint(world, target, arena)) return { ok: false, best: null, tried: 0 }
  const context = { from: pick.eyeOf(bot).offset(0, -.1, 0), moved: bot.entity.velocity.clone(), airborne: !bot.entity.onGround }
  const search = pearlSearch(bot, world, target, arena, context)
  let tried = 0, slice = performance.now() + 4
  for (;;) {
    const step = search.next(); tried++
    if (step.done) return { ok: !!step.value, best: step.value, tried }
    if (performance.now() >= slice) { await new Promise<void>(resolve => setImmediate(resolve)); slice = performance.now() + 4 }
  }
}

export async function pearlToPosition(session: any, ctl: any, { to, arena }: { to: Point; arena?: WindArena }) {
  const bot = session.bot, target = finite(to) && vector(to)
  const item = bot.inventory?.items().find(it => it.name === 'ender_pearl')
  if (!target || !item || !projectile.canSurvivePearl(bot) || !windInside(target, arena)) return { ok: false, why: 'unsafe_or_unavailable_pearl' }
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  const proposal = await pearlPositionPlan(bot, { to, arena })
  if (!proposal.best || ctl.aborted) return { ok: false, why: ctl.aborted ? 'interrupted' : 'no_observed_pearl_trajectory', tried: proposal.tried }
  let teleported = false, chosen: any = null
  const onTeleport = () => { teleported = true }
  bot.on('forcedMove', onTeleport)
  try {
    const shot = await projectile.throwAt(bot, target, { item, jump: false, sprint: false, pick(context) {
      // Replan from the real movement packet at release; no externally supplied plan is executed.
      const world = observedWorld(bot)
      if (!bodyClear(world, target) || !pearlFootprint(world, target, arena) || !projectile.canSurvivePearl(bot)) return null
      const release = pearlTrial(bot, world, target, arena, context, proposal.best)
      if (release) { chosen = release; return chosen }
      const search = pearlSearch(bot, world, target, arena, context)
      for (;;) { const result = search.next(); if (result.done) { chosen = result.value; return chosen } }
    }, onAim: () => !ctl.aborted })
    if (!shot.thrown || !chosen) return { ok: false, why: 'pearl_not_released', shot }
    return await new Promise<any>(resolve => {
      let tick = 0, settled = 0, done = false
      const finish = (ok: boolean, why?: string) => {
        if (done) return
        done = true; bot.removeListener('physicsTick', onTick)
        const index = ctl.onAbort?.indexOf(cancel) ?? -1
        if (index >= 0) ctl.onAbort.splice(index, 1)
        resolve({ ok, why, teleported, at: point(bot.entity.position), target: to, ticks: tick, plan: chosen, shot })
      }
      const cancel = () => finish(false, 'interrupted')
      const onTick = () => {
        tick++
        if (ctl.aborted || bot.health <= 0) { cancel(); return }
        if (!windInside(bot.entity.position, arena)) { finish(false, 'arena_boundary'); return }
        if (teleported) {
          const state = edges.stateOf(bot, edges.IDLE)
          if (windLanding(bot, state, target)) settled++; else settled = 0
          if (settled >= 6) { finish(true); return }
          if (state.onGround && Math.abs(state.pos.y - target.y) > .03 || state.isInLava || state.isInWater) { finish(false, 'wrong_or_unsafe_support'); return }
          const control = require('./combat/team-wind').windSteer(bot, state, target, arena)
          void bot.look(control.yaw, 0, true).catch(cancel)
          for (const [key, value] of Object.entries(control.control)) bot.setControlState(key, value)
        }
        if (tick >= 140) finish(false, teleported ? 'landing_not_confirmed' : 'pearl_teleport_not_received')
      }
      ctl.onAbort?.push(cancel); bot.on('physicsTick', onTick)
    })
  } finally { bot.removeListener('forcedMove', onTeleport); bot.clearControlStates() }
}

function material(bot: any, counts: Record<string, number>, reserve: Record<string, number>) {
  const Block = require('prismarine-block')(bot.registry)
  return Object.keys(counts).filter(name => {
    const type = bot.registry.blocksByName[name]
    if (!type || HAZARD.test(name) || /glass|sand$|gravel$|concrete_powder$/.test(name) || counts[name] <= Math.max(1, reserve[name] || 0)) return false
    const block = Block.fromStateId(type.defaultState)
    return block.shapes?.some(s => s.every((n, i) => n === (i < 3 ? 0 : 1)))
  }).sort((a, b) => counts[b] - counts[a])[0]
}

/** Pure query over this body's observed terrain. Every access option is priced and physically checked. */
export async function swarmPositions(bot: any, query: SwarmPositionQuery): Promise<{ candidates: SwarmPosition[]; observed: true }> {
  const empty = { candidates: [] as SwarmPosition[], observed: true as const }
  if (!bot?.entity || !query || !['ranged', 'recover', 'escape', 'build'].includes(query.purpose) || !finite(bot.entity.position)) return empty
  if (query.enemies && (!Array.isArray(query.enemies) || query.enemies.length > 128 || query.enemies.some(e => !e || !['string', 'number'].includes(typeof e.id))) ||
      query.methods && (!Array.isArray(query.methods) || query.methods.some(m => !['walk', 'pearl', 'wind', 'build'].includes(m)))) return empty
  const radius = Math.min(12, Math.max(1, Math.floor(query.radius ?? 6))), limit = Math.min(40, Math.max(1, Math.floor(query.limit ?? 6)))
  if (!Number.isFinite(radius) || !Number.isFinite(limit) || !windInside(bot.entity.position, query.arena)) return empty
  const methods = new Set(query.methods || ['walk', 'pearl', 'wind', 'build'])
  const counts: Record<string, number> = {}
  for (const item of bot.inventory?.items?.() || []) counts[item.name] = (counts[item.name] || 0) + item.count
  const world = observedWorld(bot), start = bot.entity.position.clone(), enemies = visibleEnemies(bot, query.enemies), cache = new Map<string, Vec3[]>(), seen = new Set<string>()
  const candidates: SwarmPosition[] = []
  const upper = new Set<string>()
  for (const distance of [Math.max(1, Math.floor(radius / 2)), radius]) for (let i = 0; i < 8; i++) {
    upper.add(`${Math.round(Math.cos(i * Math.PI / 4) * distance)},${Math.round(Math.sin(i * Math.PI / 4) * distance)}`)
  }
  let slice = performance.now() + 4
  // Бюджет запроса (budgetMs): обзор от ближних клеток к дальним и планы способов обрываются, ответ — лучшее найденное
  // (арена 14.10: в Колизее при 12 демонах запрос шёл 27–41 с, тело стояло, сторож его сбрасывал).
  const deadline = performance.now() + (Number.isFinite(query.budgetMs) ? Math.max(100, query.budgetMs!) : Infinity)
  const cells: Array<[number, number]> = []
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) if (dx * dx + dz * dz <= radius * radius) cells.push([dx, dz])
  cells.sort((a, b) => a[0] * a[0] + a[1] * a[1] - b[0] * b[0] - b[1] * b[1])
  for (const [dx, dz] of cells) {
    if (performance.now() >= deadline) break
    if (performance.now() >= slice) { await new Promise<void>(resolve => setImmediate(resolve)); slice = performance.now() + 4 }
    for (const at of standPositions(world, start.offset(dx, 0, dz), { rise: upper.has(`${dx},${dz}`) ? 64 : 8, drop: 3 }, cache)) {
      if (at.distanceTo(start) < .5 || !windInside(at, query.arena) || seen.has(key(at))) continue
      const floor = supportAt(world, at, .03)
      if (!floor || at.x <= floor.box.minX || at.x >= floor.box.maxX || at.z <= floor.box.minZ || at.z >= floor.box.maxZ) continue
      seen.add(key(at))
      const assessed = tactical(world, at, start, enemies, query.purpose, !!counts.bow && !!(counts.arrow || counts.spectral_arrow || counts.tipped_arrow))
      candidates.push({ at: point(at), support: floor.block.name, methods: [], ...assessed })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  // ponytail: bounded terrain query; exhaustive jump planning remains in the executor RPC.
  let windChecks = 0, pearlChecks = 0
  const physicsBot = { ...bot, _ndPositionOwner: bot, blockAt: p => world.blockAt(p) }
  for (const candidate of candidates) {
    if (performance.now() >= deadline) break
    if (performance.now() >= slice) { await new Promise<void>(resolve => setImmediate(resolve)); slice = performance.now() + 4 }
    const at = vector(candidate.at), cost = methods.has('walk') ? walkCost(world, start, at, query.arena) : null
    if (cost !== null) candidate.methods.push({ kind: 'walk', cost, skill: 'goto', params: { ...candidate.at } })
    if (!candidate.methods.length && methods.has('pearl') && counts.ender_pearl && at.distanceTo(start) > 2 && pearlChecks++ < 6) {
      const plan = await pearlPositionPlan(physicsBot, { to: at, arena: query.arena })
      if (plan.best) candidate.methods.push({ kind: 'pearl', cost: 1 + 5 / Math.max(1, bot.health || 20) + 3 / counts.ender_pearl, skill: 'pearl_to', params: { to: point(at), arena: query.arena, observed: true }, plan: plan.best })
    }
    if (!candidate.methods.length && methods.has('wind') && counts.wind_charge && windChecks++ < 2) {
      const plan = (await require('./wind-leap').planAsync(physicsBot, at, { arena: query.arena, maxTries: 16 })).best
      if (plan) candidate.methods.push({ kind: 'wind', cost: plan.ticks / 20 + 2 / counts.wind_charge, skill: 'wind_leap', params: { to: candidate.at, arena: query.arena }, plan })
    }
  }
  if (methods.has('build')) {
    const item = material(bot, counts, query.reserve || {})
    if (item) for (const source of candidates.filter(c => c.methods.some(m => m.kind === 'walk'))) {
      const at = vector(source.at), support = supportAt(world, at, .03)
      if (!support || Math.abs(at.y - Math.round(at.y)) > 1e-6 || support.box.maxX - support.box.minX < .99 || support.box.maxZ - support.box.minZ < .99) continue
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cell = support.block.position, place = new Vec3(cell.x + dx, at.y - 1, cell.z + dz), target = place.offset(.5, 1, .5), current = world.blockAt(place)
        if (!current || shapeBoxes(current).length || HAZARD.test(current.name) || seen.has(key(target)) || !windInside(target, query.arena) || !bodyClear(world, target)) continue
        const assessed = tactical(world, target, start, enemies, query.purpose, !!counts.bow && !!counts.arrow)
        seen.add(key(target))
        const cost = (source.methods.find(m => m.kind === 'walk')?.cost || 0) + 1 + 3 / Math.max(1, counts[item] - Math.max(1, query.reserve?.[item] || 0))
        candidates.push({ at: point(target), support: item, ...assessed, methods: [{ kind: 'build', cost, skill: 'swarm_work', params: { kind: 'place', at: point(place), item }, plan: { approach: source.at, reference: point(cell), cells: [{ kind: 'place', at: point(place), item }], reserve: Math.max(1, query.reserve?.[item] || 0) } }] })
      }
    }
  }
  if (methods.has('build') && ['ranged', 'build'].includes(query.purpose)) {
    const item = material(bot, counts, query.reserve || {}), reserve = Math.max(1, query.reserve?.[item] || 0)
    if (item) for (let height = 1; height <= Math.min(16, counts[item] - reserve) && performance.now() < deadline; height++) {
      const params = { height, item, reserve, arena: query.arena }
      const column = require('./swarm-position-work').pillarCheck(bot, params, world)
      if (!column.ok) break
      const at = vector(column.at), assessed = tactical(world, at, start, enemies, query.purpose, !!counts.bow && !!counts.arrow)
      const cost = height * .8 + height / Math.max(1, counts[item] - reserve) + 1
      candidates.push({ at: point(at), support: item, ...assessed,
        methods: [{ kind: 'build', cost, skill: 'swarm_pillar', params, plan: { kind: 'pillar', cells: column.cells.map(point), height, item, reserve } }] })
    }
  }
  return { observed: true, candidates: candidates.filter(c => c.methods.length).map(c => ({ ...c, score: c.score - Math.min(...c.methods.map(m => m.cost)) })).sort((a, b) => b.score - a.score).slice(0, limit) }
}

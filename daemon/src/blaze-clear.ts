'use strict'
// BaseSpawner/EntityType/ServerExplosion, Paper 1.21.11: report and offline evidence in codex-lab/blaze-clear.
import { Vec3 } from 'vec3'
import pick = require('./pick')
import * as tools from './tools'
import * as eyes from './perception/eyes'
const FULL = [[0, 0, 0, 1, 1, 1]], UNKNOWN = [[0, 0, 0, 1, 1.5, 1]]
const HALF = Math.fround(.6) / 2, HEIGHT = Math.fround(1.8)
const key = p => `${p.x},${p.y},${p.z}`
const removable = b => /^(nether_bricks|nether_brick_fence|nether_brick_stairs)$/.test(b?.name || '')
const air = b => !!b && /^(air|cave_air|void_air)$/.test(b.name)
const sides = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
function cdf(x) { return x <= -4 ? 0 : x >= 4 ? 1 : x < 0 ? (x + 4) ** 2 / 32 : 1 - (4 - x) ** 2 / 32 }

// Integrate the union of forbidden centre rectangles, separately for each of the three integer foot heights.
function chance(sp, blocks, removed = new Set()) {
  let answer = 0
  for (const dy of [-1, 0, 1]) {
    const rect = []
    for (const b of blocks) {
      if (removed.has(key(b.position))) continue
      // Removing a neighbouring stair can turn an outer corner into a larger straight stair.
      const changingStair = /_stairs$/.test(b.name) && blocks.some(other => /_stairs$/.test(other.name) && removed.has(key(other.position)) && other.position.y === b.position.y && Math.abs(other.position.x - b.position.x) + Math.abs(other.position.z - b.position.z) === 1)
      const shapes = changingStair || /^(lava|water)$/.test(b.name) ? FULL : b.shapes || UNKNOWN
      for (const s of shapes) {
        const p = b.position
        if (sp.y + dy >= p.y + s[4] || sp.y + dy + HEIGHT <= p.y + s[1]) continue
        const r = [Math.max(-4, p.x + s[0] - HALF - sp.x - .5), Math.min(4, p.x + s[3] + HALF - sp.x - .5),
          Math.max(-4, p.z + s[2] - HALF - sp.z - .5), Math.min(4, p.z + s[5] + HALF - sp.z - .5)]
        if (r[0] < r[1] && r[2] < r[3]) rect.push(r)
      }
    }
    const xs = [...new Set([-4, 4, ...rect.flatMap(r => r.slice(0, 2))])].sort((a, b) => a - b)
    let blocked = 0
    for (let i = 1; i < xs.length; i++) {
      const x = (xs[i - 1] + xs[i]) / 2
      const zs = rect.filter(r => r[0] < x && r[1] > x).map(r => r.slice(2)).sort((a, b) => a[0] - b[0])
      let lo = -4, hi = -4, zMass = 0
      for (const z of zs) {
        if (z[0] > hi) { zMass += cdf(hi) - cdf(lo); [lo, hi] = z } else hi = Math.max(hi, z[1])
      }
      zMass += cdf(hi) - cdf(lo)
      blocked += (cdf(xs[i]) - cdf(xs[i - 1])) * zMass
    }
    answer += (1 - blocked) / 3
  }
  return Math.max(0, Math.min(1, answer))
}
function rate(p) { return 4800 * p / (1 + 499.5 * (1 - (1 - p) ** 4)) }
function price(gain, rods, costSeconds, horizon = Infinity, beforeChance = 1 - gain, recoverySeconds = 0) {
  if (!Number.isFinite(recoverySeconds) || recoverySeconds < 0) return null
  costSeconds += recoverySeconds
  if (![gain, rods, costSeconds, beforeChance].every(Number.isFinite) || gain <= 0 || gain >= 1 || rods <= 0 || costSeconds < 0 || beforeChance < 0 || beforeChance + gain > 1 + Number.EPSILON * 8 || !(horizon > costSeconds)) return null
  // T(p)-T(p+gain) decreases as p increases. Use the largest p consistent with OBSERVED solids;
  // unknown cells are air only in this upper bound, and solid in the separately proved gain.
  const before = rate(beforeChance), after = rate(Math.min(1, beforeChance + gain))
  const demand = Math.min(rods, Math.max(0, horizon - costSeconds) * before / 120)
  const savedSeconds = before > 0 ? demand * 120 * (1 / before - 1 / after)
    : Math.min(horizon - costSeconds, rods * 120 / after)
  const netSeconds = savedSeconds - costSeconds
  return netSeconds > 0 ? { savedSeconds, costSeconds, netSeconds } : null
}
function throughGaps(bot, p, eye) {
  const optical = { blockAt(q) {
    const b = bot.blockAt(q, false)
    return !b || b.name === 'lava' ? { name: b?.name || '?', boundingBox: 'block', shapes: FULL, position: q } : b
  } }
  // Exact outline rays can pass between fence bars. Lava and unloaded cells remain opaque.
  const points = [[.5, .5, .5]]
  for (const x of [.15, .85]) for (const y of [.15, .85]) for (const z of [.15, .85]) points.push([x, y, z])
  return points.some(f => {
    const delta = p.offset(...f).minus(eye), length = delta.norm()
    if (!length) return true
    const hit = pick.blockOnRay(optical, eye, delta.scaled(1 / length), length + .01, null)
    return !hit || hit.pos.equals(p)
  })
}
function view(bot) {
  if (!bot._ndBlazeClearObserved || bot._ndBlazeClearObserved.world !== bot.world || bot._ndBlazeClearObserved.dimension !== bot.game.dimension) {
    bot._ndBlazeClearObserved = { world: bot.world, dimension: bot.game.dimension, cells: new Map() }
  }
  if (!bot._ndBlazeClearInvalidation) {
    bot._ndBlazeClearInvalidation = true
    bot.on('blockUpdate', (old, next) => { const p = next?.position || old?.position; if (p) bot._ndBlazeClearObserved?.cells.delete(key(p)) })
    bot.on('end', () => bot._ndBlazeClearObserved?.cells.clear())
  }
  const observed = bot._ndBlazeClearObserved.cells
  const cache = new Map(), read = eyes.reader(bot), shapes = eyes.shapeCache(bot.registry), eye = pick.eyeOf(bot)
  return p => {
    const k = key(p)
    if (!cache.has(k)) {
      if (p.offset(.5, .5, .5).distanceTo(eye) <= 16 && (eyes.seesCell(read, shapes, eye, p) || throughGaps(bot, p, eye))) observed.set(k, bot.blockAt(p, false))
      cache.set(k, observed.get(k) || null)
    }
    return cache.get(k)
  }
}
function safeBoundary(pos, protectedCells, seen) {
  return !protectedCells.some(p => p.equals(pos)) && removable(seen(pos)) && sides.every(d => {
    const b = seen(pos.offset(...d))
    return b && !/lava|water|^(sand|red_sand|gravel)$|_concrete_powder$/.test(b.name)
  })
}
function safeCell(bot, pos, protectedCells, seen = view(bot)) {
  if (protectedCells.some(p => p.equals(pos)) || pos.y < Math.floor(bot.entity.position.y)) return false
  if (!removable(seen(pos)) || !bot.canDigBlock?.(seen(pos)) || !pick.blockAim(bot, pos, { range: 4.5, seeThrough: null })) return false
  // Read neighbours only after sight has certified them. Unknown backs of walls may hide lava.
  return safeBoundary(pos, protectedCells, seen)
}
function volume(sp, seen) {
  const blocks = []
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = -2; y <= 2; y++) {
    const p = sp.offset(x, y, z)
    blocks.push(seen(p) || { name: '?', position: p, shapes: UNKNOWN })
  }
  return blocks
}
function observe(bot, sp) {
  if (!sp || !bot.game || !bot.world?.getColumn) return 0
  return volume(sp, view(bot)).filter(b => b.name !== '?').length
}
function coverCells(bot, protectedCells) {
  // The caller supplies the actual bunker/rest-post envelope. Keep the current niche and its floor as well.
  const cells = new Map(protectedCells.map(p => [key(p), p]))
  const feet = bot.entity.position.floored()
  for (const [dx, , dz] of sides.filter(d => !d[1]).concat([[0, 0, 0]])) for (let y = -1; y <= 2; y++) {
    const p = feet.offset(dx, y, dz); cells.set(key(p), p)
  }
  return [...cells.values()]
}
function plan(bot, sp, { rods, protectedCells = [], horizon = Infinity, windowMs = Infinity }: any) {
  if (!sp || !(rods > 0) || !(windowMs > 0) || !bot.game || !bot.entity?.onGround || !bot.canDigBlock || sp.offset(.5, .5, .5).distanceTo(bot.entity.position) >= 16) return null
  const seen = view(bot), blocks = volume(sp, seen), before = chance(sp, blocks)
  const beforeUpper = chance(sp, blocks.filter(b => b.name !== '?'))
  const keep = [sp, ...coverCells(bot, protectedCells)]
  const candidates = blocks.filter(b => b.position.y >= sp.y && removable(b) && safeCell(bot, b.position, keep, seen))
  let best = null
  // A 1.8-high blaze can need a pair; all three above-platform cells can free both upper foot levels together.
  // Keep the collection floor and price only a column reachable from the current post.
  const overheadMs = Math.max((require('./game-clock') as typeof import('./game-clock')).TICK_MS, bot._ndBlazeClearOverheadMs || 0)
  // Returning to sword resets its attack ticker; shield delay overlaps that recovery.
  const recoverySeconds = process.env.ND_BLAZE_CLEAR_PRICE === '1'
    ? Math.max(250, (require('./pvp') as typeof import('./pvp')).cooldownMs((require('./items') as typeof import('./items')).bestWeapon(bot))) / 1000 : 0
  for (const b of candidates) {
    const above = candidates.find(c => c.position.equals(b.position.offset(0, 1, 0)))
    const top = above && candidates.find(c => c.position.equals(b.position.offset(0, 2, 0)))
    for (const cut of [[b], ...(above ? [[b, above]] : []), ...(top ? [[b, above, top]] : [])]) {
      const gain = chance(sp, blocks, new Set(cut.map(b => key(b.position)))) - before
      const targets = cut.map(b => { const digSeconds = tools.bestFor(bot, b).ms / 1000; return { pos: b.position, stateId: b.stateId, digSeconds, costSeconds: digSeconds + overheadMs / 1000 } })
      const cost = targets.reduce((n, t) => n + t.costSeconds, 0)
      const paid = (cost + recoverySeconds) * 1000 <= windowMs ? price(gain, rods, cost, horizon, beforeUpper, recoverySeconds) : null
      if (paid && (!best || paid.netSeconds > best.netSeconds)) best = { mode: 'pick', ...targets[0], targets, gain, beforeUpper, ...paid, protectedCells: keep }
    }
  }
  const explosive = tntPrice(bot, sp, { rods, protectedCells: keep, horizon, seen, blocks })
  return explosive && explosive.costSeconds * 1000 <= windowMs && (!best || explosive.netSeconds > best.netSeconds) ? explosive : best
}

const tntRays = []
for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) {
  if (![x, y, z].some(n => n === 0 || n === 15)) continue
  const v = [x, y, z].map(n => Math.fround(Math.fround(n / 15) * 2 - 1)), length = Math.hypot(...v)
  tntRays.push(v.map(n => n / length * Math.fround(.3)))
}
function tntEnvelope(bot, cell, keep, seen) {
  const full = p => {
    const b = seen(p)
    return b?.name === 'nether_bricks' && b.shapes?.length === 1 && b.shapes[0].every((n, i) => n === FULL[0][i])
  }
  // A pre-existing two-high brick socket bounds a .98-wide TNT's horizontal centre to +/- .01.
  // Its known floor arrests the initial .2 upward impulse before the 80-tick fuse expires.
  const inner = [cell.offset(0, -1, 0)]
  for (const d of sides.filter(d => !d[1])) for (const y of [0, 1]) {
    const p = cell.offset(d[0], y, d[2]); if (!full(p)) return null
    if (!y) inner.push(p)
  }
  if (!full(cell.offset(0, -1, 0)) || inner.some(p => !safeBoundary(p, keep, seen))) return null
  const centre = [cell.x + .5, cell.y + Math.fround(.98) * .0625, cell.z + .5]
  const gap = (1 - Math.fround(.98)) / 2 + 1e-6
  const possible = new Set()
  for (const ray of tntRays) {
    // Include every possible voxel sequence in the bounded centre interval, including boundary points.
    const offsets = centre.map((c, axis) => {
      const bound = axis === 1 ? 1e-6 : gap, edges = [-bound, bound]
      for (let step = 0; step < 24; step++) {
        const p = c + step * ray[axis], shift = Math.round(p) - p
        if (shift > -bound && shift < bound) edges.push(shift)
      }
      edges.sort((a, b) => a - b)
      return [...edges, ...edges.slice(1).map((v, i) => (v + edges[i]) / 2)]
    })
    for (const dx of offsets[0]) for (const dy of offsets[1]) for (const dz of offsets[2]) {
      let p = centre.map((v, i) => v + [dx, dy, dz][i]), energy = Math.fround(5.2)
      while (energy > 0) {
        const pos = new Vec3(...(p.map(Math.floor) as [number, number, number])), b = pos.equals(cell) ? null : seen(pos)
        if (!pos.equals(cell) && !b) return null
        if (b && !air(b)) {
          const resistance = bot.registry.blocksByName[b.name]?.resistance
          if (!Number.isFinite(resistance)) return null
          energy = Math.fround(energy - Math.fround(Math.fround(resistance + Math.fround(.3)) * Math.fround(.3)))
          if (energy > 0) {
            if (!safeBoundary(pos, keep, seen)) return null
            possible.add(key(pos))
          }
        }
        energy = Math.fround(energy - Math.fround(.22500001)); p = p.map((v, i) => v + ray[i])
      }
    }
  }
  // Minimum energy 2.8 guarantees one hit on these four side bricks and the floor (resistance cost 1.89).
  return { guaranteed: new Set(inner.map(key)), possible }
}
function tntPrice(bot, sp, { rods, protectedCells = [], horizon = Infinity, seen = null, blocks = null }: any) {
  const items = bot.inventory.items()
  if (!items.some(i => i.name === 'tnt') || !items.some(i => /^(flint_and_steel|fire_charge)$/.test(i.name)) || !(rods > 0) || !bot.game) return null
  seen = seen || view(bot); blocks = blocks || volume(sp, seen)
  const keep = [sp, ...protectedCells, ...blocks.filter(b => b.position.y < sp.y).map(b => b.position)]
  // shortcut: only an existing brick socket plus a straight observed retreat; do not build a blast chamber as a ritual.
  for (const b of blocks.filter(removable)) for (const d of sides.filter(d => !d[1])) {
    const cell = b.position.offset(...d), centre = cell.offset(.5, Math.fround(.98) * .0625, .5), me = bot.entity.position
    if (!air(seen(cell)) || !air(seen(cell.offset(0, 1, 0))) || centre.distanceTo(me) < 1.2 ||
      !pick.blockAim(bot, cell.offset(0, -1, 0), { range: 4.5, seeThrough: null })) continue
    const envelope = tntEnvelope(bot, cell, keep, seen)
    if (!envelope) continue
    const direction = centre.minus(me); direction.y = 0
    if (!direction.norm()) continue
    const away = direction.normalize().scaled(-1), route = []
    let safe = true
    for (let distance = 1; distance <= 9; distance++) {
      const p = me.plus(away.scaled(distance)).floored()
      if (!air(seen(p)) || !air(seen(p.offset(0, 1, 0))) || seen(p.offset(0, -1, 0))?.boundingBox !== 'block') { safe = false; break }
      route.push(p)
    }
    if (!safe || !route.length) continue
    const routeFloor = route.map(p => p.offset(0, -1, 0))
    if (routeFloor.some(p => envelope.possible.has(key(p)))) continue
    const gain = chance(sp, blocks, envelope.guaranteed) - chance(sp, blocks)
    // Walking ETA estimate, charged twice for retreat and return, plus the jar's 4 s fuse.
    const costSeconds = 4 + 2 * route.length * .25
    const beforeUpper = chance(sp, blocks.filter(b => b.name !== '?')), paid = price(gain, rods, costSeconds, horizon, beforeUpper)
    if (paid) return { mode: 'tnt', pos: cell, spawner: sp, gain, beforeUpper, ...paid, route, retreat: route[route.length - 1], home: me.clone(), protectedCells: keep.concat(routeFloor) }
  }
  return null
}
async function execute(session, ctl, p, safe) {
  const bot = session.bot, clock: typeof import('./game-clock') = require('./game-clock'), started = clock.now(), hp = bot.health
  let workEnd = started + p.costSeconds * 1000
  const ready = () => !ctl.aborted && safe(Math.max(0, workEnd - clock.now())) && (bot.health ?? 0) >= hp
  if (!ready()) return { ok: false, why: 'обстановка изменилась' }
  if (p.mode === 'pick' && p.targets?.length > 1) {
    const completed = []
    for (const target of p.targets) {
      const r = await execute(session, ctl, { ...p, ...target, targets: null }, safe)
      if (r.ok) completed.push(target.pos)
      else return { ...r, completed, partial: completed.length > 0, seconds: (clock.now() - started) / 1000 }
    }
    return { ok: true, mode: 'pick', completed, gain: p.gain, seconds: (clock.now() - started) / 1000 }
  }
  if (p.mode === 'tnt') {
    const certified = () => {
      if (!ready()) return false
      const seen = view(bot)
      return p.route.every(q => air(seen(q)) && air(seen(q.offset(0, 1, 0))) && seen(q.offset(0, -1, 0))?.boundingBox === 'block') && !!tntEnvelope(bot, p.pos, p.protectedCells, seen)
    }
    if (!certified()) return { ok: false, why: 'TNT: обстановка изменилась' }
    const result = await (require('./tnt') as typeof import('./tnt')).tntAt(session, ctl, { at: p.pos.offset(.5, 0, .5), maxOff: 0, exact: true, beforeIgnite: certified })
    if (!result.lit) return { ok: false, why: result.why }
    const fuseEnd = clock.now() + 4000
    const retreat = await (require('./blaze') as typeof import('./blaze')).walkNear(bot, ctl, p.retreat, 0, 3500)
    // Fuse physics, not a strategy mode timer. The caller returns to the same protected post after detonation.
    await clock.sleep(Math.max(0, fuseEnd - clock.now()))
    const back = retreat.ok && ready()
      ? await (require('./blaze') as typeof import('./blaze')).walkNear(bot, ctl, p.home.floored(), 0, 5000) : null
    return { ok: !!retreat.ok, returned: !!back?.ok, mode: 'tnt', placed: result.placed, seconds: (clock.now() - started) / 1000 }
  }
  if (bot.blockAt(p.pos)?.stateId !== p.stateId || !safeCell(bot, p.pos, p.protectedCells)) return { ok: false, why: 'клетка изменилась' }
  let interrupted = false
  const watch = () => { if (!ready() || !air(bot.blockAt(p.pos)) && !safeCell(bot, p.pos, p.protectedCells)) { interrupted = true; bot.stopDigging() } }
  bot.on('physicsTick', watch)
  try {
    await tools.equipFastest(bot, bot.blockAt(p.pos))
    if (!ready() || !safeCell(bot, p.pos, p.protectedCells)) return { ok: false, why: 'обстановка изменилась' }
    const aim = pick.blockAim(bot, p.pos, { range: 4.5, seeThrough: null })
    if (!aim) return { ok: false, why: 'прицел закрыт' }
    await bot.lookAt(aim, true)
    workEnd = clock.now() + p.costSeconds * 1000
    if (!ready()) return { ok: false, why: 'окна для копки уже нет' }
    await (require('./build') as typeof import('./build')).withTimeout(bot.dig(bot.blockAt(p.pos), 'ignore'), p.costSeconds * 1000 + 1500)
    const elapsed = clock.now() - started
    if (!interrupted && air(bot.blockAt(p.pos))) bot._ndBlazeClearOverheadMs = Math.max(clock.TICK_MS, bot._ndBlazeClearOverheadMs || 0, elapsed - p.digSeconds * 1000)
    return { ok: !interrupted && air(bot.blockAt(p.pos)), mode: p.mode, pos: p.pos, gain: p.gain, savedSeconds: p.savedSeconds, seconds: (clock.now() - started) / 1000 }
  } catch (e) { return { ok: false, why: e.message } } finally {
    bot.removeListener('physicsTick', watch)
    bot.stopDigging()
  }
}
export { chance, rate, price, plan, safeCell, tntPrice, execute, tntEnvelope, observe }

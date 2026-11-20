import test from 'node:test'
import assert from 'node:assert/strict'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmLoot } from './swarm/swarm-driver/loot'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'
import { installSight } from './arena/watch'
import { generate } from '../daemon/arena/colosseum-arms'

function upperTour (move, otherPlaces: any[] = []) {
  const calls: any[] = [], target = { x: 40, y: 88, z: 0, tier: 3 }
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} } }
  const board = { enemies: () => [] }
  const b = { name: 'A', team: 'blue', c: { async call(method, params) {
    assert.equal(method, 'goto')
    calls.push(params)
    return move(pos.A, target, calls.length)
  } } }
  const sw = createDriverState({ bots: [b], pos, alive: () => true, now: () => 1000,
    arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => pos.A.p, log() {}, hideouts: [...otherPlaces, target] })
  Object.assign(sw, { teamOf: () => 'blue', boardOf: () => board }, swarmRetry(sw))
  Object.assign(sw, swarmMoves(sw))
  Object.assign(sw, swarmLoot(sw))
  return { calls, target, pos, sw, tour: () => sw.tour(b, board) }
}

test('the best reachable upper loot tier takes priority over cheap lower circles', async () => {
  const f = upperTour((frame, target) => {
    frame.p = { ...target }
    return { status: 'done', detail: { arrived: frame.p } }
  }, [{ x: 4, y: 64, z: 0, tier: 0 }, { x: 8, y: 72, z: 0, tier: 1 },
    { x: 50, y: 98, z: 0, tier: 5, climbFrom: 88 }])
  assert.equal(await f.tour(), true)
  assert.equal(f.calls[0].y, 88, 'upper gallery before the lower loot; the roof needs unavailable blocks')
})

test('upper gallery walk gets its priced travel time and continues a confirmed partial ascent', async () => {
  const f = upperTour((frame, target, n) => {
    frame.p = n === 1 ? { x: 16, y: 72, z: 0 } : { ...target }
    return { status: 'done', detail: n === 1 ? { why: 'timeout' } : { arrived: frame.p } }
  })
  const walk = f.sw.travelCost({ name: 'A' }, f.target).walk
  assert.equal(await f.tour(), true)
  assert.equal(f.calls[0].timeoutSeconds, Math.ceil(walk), 'the 6-second local move budget cannot execute the priced upper route')
  assert.equal(f.calls[0].climb, undefined, 'existing stairs do not require building blocks')
  assert.equal(f.sw.retries.size, 0, 'confirmed ascent is progress, even without an arrival receipt')
  assert.equal(f.sw.toured.get('blue').get(0).done, undefined)
  assert.equal(await f.tour(), true)
  assert.equal(f.calls.length, 2, 'the next turn continues to the same upper gallery')
  assert.equal(f.sw.toured.get('blue').get(0).done, true)
})

test('a roof ascent gets its priced travel time instead of the old fixed twenty seconds', async () => {
  const f = upperTour((frame, target) => {
    frame.p = { ...target }
    return { status: 'done', detail: { arrived: frame.p } }
  })
  Object.assign(f.target, { y: 98, climbFrom: 64 })
  Object.assign(f.pos.A.inv, { cobblestone: 64 })
  f.sw.pearlUp = async () => null
  const walk = f.sw.travelCost({ name: 'A' }, f.target).walk
  assert.equal(await f.tour(), true)
  assert.equal(f.calls[0].timeoutSeconds, Math.ceil(walk))
  assert.equal(f.calls[0].climb, true)
  assert.equal(f.calls[0].exactY, true)
})

test('an upper tour that stops making progress releases its reservation and stops retrying', async () => {
  const f = upperTour(() => ({ status: 'done', detail: { why: 'no path' } }))
  assert.equal(await f.tour(), true)
  assert.equal(f.sw.toured.get('blue').has(0), false, 'another bot can try the gallery')
  assert.equal(await f.tour(), false)
  assert.equal(f.calls.length, 1, 'unchanged failed geometry cannot reserve the gallery forever')
})

test('a goto arrival below the upper gallery does not complete its tour', async () => {
  const f = upperTour((frame, target) => {
    frame.p = { x: target.x, y: 64, z: target.z }
    return { status: 'done', detail: { arrived: frame.p } }
  })
  await f.tour()
  assert.equal(f.sw.toured.get('blue').get(0).done, undefined)
  await f.tour()
  assert.equal(f.sw.toured.get('blue').has(0), false, 'false arrival under the ceiling cannot keep the route reserved')
})

test('one native complete ladder receipt opens the same upper loot route to two allies without blocks', async () => {
  const target = { x: 2.5, y: 70, z: .5, climbFrom: 64, tier: 4 }, calls: any[] = []
  const wall = { key: 'shared-wall', x: 0, y: 64, z: 0, top: 69, face: { x: 1, z: 0 } }
  const pos: any = { Builder: { p: { x: 2.5, y: 64, z: .5 }, hp: 20, inv: { ladder: 6 } },
    A: { p: { x: 3.5, y: 64, z: .5 }, hp: 20, inv: {}, armor: {} }, B: { p: { x: 4.5, y: 64, z: .5 }, hp: 20, inv: {}, armor: {} } }
  const board = { enemies: () => [] }
  const bots = ['Builder', 'A', 'B'].map(name => ({ name, team: 'blue', c: { async call(method, params) {
    calls.push({ name, method, params })
    if (method === 'status') return { state: { pos: pos[name].p, health: 20, inventory: pos[name].inv } }
    if (method === 'ladder_up') {
      assert.deepEqual(params.wall, { x: 0, y: 64, z: 0 }); assert.deepEqual(params.face, wall.face)
      pos[name].p = { x: .5, y: 70, z: .5 }
      return { status: 'done', detail: { ok: true, complete: true, placed: name === 'Builder' ? 6 : 0, at: pos[name].p } }
    }
    assert.equal(method, 'goto')
    assert.equal(params.climb, undefined, 'ready ladders need no new digging or pillar construction')
    assert.equal(params.y, 64, 'generic navigation approaches the base, not the upper ladder neighbor')
    assert.equal(params.x, 1.5)
    pos[name].p = { x: params.x, y: params.y, z: params.z }
    return { status: 'done', detail: { arrived: pos[name].p } }
  } } }))
  const sw: any = createDriverState({ bots, pos, alive: () => true, now: () => 1000, arena: { x: 0, y: 64, z: 0, r: 100 },
    home: () => pos.A.p, log() {}, chestTops: [target, { ...target, z: 2.5 }], ladderSites: [wall] })
  Object.assign(sw, { teamOf: () => 'blue', boardOf: () => board, siteOpen: () => true, siteFailed() {}, say2() {} }, swarmRetry(sw))
  Object.assign(sw, swarmMoves(sw)); Object.assign(sw, swarmLoot(sw))
  const work = swarmTurnWork(sw), task = { kind: 'goto', data: { ladder: wall.key }, position: wall }
  for (const b of bots.slice(1)) assert.equal(sw.lootOffer(b, board), null, 'no imaginary route before native completion')
  await work.turnLadder({ b: bots[0], task, round: sw.generation, member: { health: 20 }, context: { members: [] }, enemies: [] } as any)
  assert.equal(sw.ladderRoutes.length, 1)
  for (const b of bots.slice(1)) {
    assert.ok(Number.isFinite(sw.lootOffer(b, board)?.seconds), 'a completed shared ladder removes the physical block deficit')
    assert.equal(await sw.tour(b, board), true)
  }
  assert.equal(calls.filter(c => c.method === 'ladder_up').length, 3, 'both allies with empty supplies use the existing native column controller')
  assert.equal(calls.filter(c => c.method === 'goto').length, 2)
})

test('a confirmed partial walk on the shared ladder continues without rebuilding or blacklisting it', async () => {
  const f = upperTour(() => { throw new Error('a body already in the column must not use generic goto') })
  Object.assign(f.target, { x: 4, y: 70, climbFrom: 64 })
  f.pos.A.p = { x: 5, y: 64, z: 0 }
  f.sw.bots[0].c.call = async (method, params) => {
    assert.equal(method, 'ladder_up'); f.calls.push(params)
    f.pos.A.p = f.calls.length === 1 ? { x: 5, y: 67, z: 0 } : { ...f.target }
    return { status: 'done', detail: { ok: f.calls.length > 1, complete: true, placed: 0, at: f.pos.A.p } }
  }
  f.sw.ladderRoutes.push({ key: 'partial-wall', base: { x: 5, y: 64, z: 0 }, top: { x: 4, y: 70, z: 0 } })
  assert.equal(await f.tour(), true)
  assert.equal(f.sw.retries.size, 0, 'three blocks of native ascent are progress')
  assert.equal(await f.tour(), true)
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(p => p.wall && !p.climb), 'the same completed native column supplies both legs')
})

test('ordinary colosseum sight supplies real upper loot ladder sites without any enemy input', t => {
  const driver: typeof import('./swarm/swarm-driver') = require('./swarm/swarm-driver')
  let options: any
  t.mock.method(driver, 'createSwarmDriver', opts => { options = opts; return { enemies: () => [] } as any })
  installSight({ i: 31, arms: true, bots: [], names: [], pos: {}, humans: {}, X: 600, Y: 120, Z: 600, R: 80,
    L: generate('team1'), perches: [], deathAt: {}, log() {}, rcon() { throw new Error('the producer cannot contact a server') } } as any)
  assert.ok(options.ladderSites.length > 0)
  const useful = options.ladderSites.filter(s => options.chestTops.some(p => s.top + 1 <= p.y + 1 && p.y - s.y >= 3 && Math.hypot(p.x - s.x, p.z - s.z) < 12))
  assert.ok(useful.length > 0, 'the actual supplied wall sites can serve a concrete upper loot destination')
})

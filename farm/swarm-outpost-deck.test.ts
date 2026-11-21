import test from 'node:test'
import assert from 'node:assert/strict'
import { fitOutpost, outpostSurvey } from './swarm/swarm-driver/outpost'
import { outpostTread } from '../daemon/src/swarm-work'
import { withinArena } from '../daemon/src/navigation/parkour/model'
import { createSwarmDriver } from './swarm/swarm-driver'
import { registry, Block } from '../daemon/test/parkour-fixture'
import { SwarmBoard } from '../daemon/src/swarm'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmBuild } from './swarm/swarm-driver/build'

const at = { x: 0, y: 64, z: 0 }, arena = { x: .5, z: .5, r: 4, killY: 59 }
const stone = { name: 'stone', solid: true }, air = { name: 'air', solid: false }
const stair = { name: 'sandstone_stairs', solid: false, tread: true }
const survey = fn => outpostSurvey(at).map(p => ({ at: p, existing: fn(p.x, p.y - at.y, p.z) }))

test('an outpost near the rim selects an exit the walking body can actually use', () => {
  const origin = { x: 600, y: 144, z: 539 }, bounds = { x: 600.5, z: 600.5, r: 64 }
  const seen = outpostSurvey(origin).map(p => ({ at: p, existing: p.y === 143 ? stone : air }))
  const outside = dz => ({ x: origin.x + .5, y: origin.y, z: origin.z + dz + .5 })
  assert.equal(withinArena({}, outside(-2), bounds), false)
  assert.equal(fitOutpost(origin, seen, bounds, 'north'), undefined)
  assert.equal(withinArena({}, outside(2), bounds), true)
  assert.deepEqual(fitOutpost(origin, seen, bounds), { y: 144, direction: 'south' })
})

test('an outpost raises its deck onto a stair row and checks the raised ceiling before claiming it', () => {
  const terrace = (x, y) => x === 1 && y === 0 ? stair : y === -1 ? stone : air
  const cells = survey(terrace)
  assert.equal(cells.length, 65)
  assert.deepEqual(fitOutpost(at, cells, arena), { y: 65, direction: 'north' })
  assert.equal(fitOutpost(at, survey((x,y,z) => y === 3 && x === 1 && z === 1 ? stair : terrace(x,y)), arena), undefined)
  assert.deepEqual(fitOutpost(at, survey((x,y) => y === -1 ? stair : air), arena), { y: 64, direction: 'north' })
  assert.equal(fitOutpost({ ...at, y: 318 }, [], arena), undefined)
})

test('an outpost puts its doorway over a visible landing and rejects exits into a known drop or beyond the arena', () => {
  const platform = (x,y,z) => y === -1 && Math.abs(x) <= 1 && Math.abs(z) <= 1 ? stone : air
  const cells = survey((x,y,z) => x === 2 && z === 0 && y === -2 ? stair : platform(x,y,z))
  assert.deepEqual(fitOutpost(at, cells, arena), { y: 64, direction: 'east' })
  assert.equal(fitOutpost(at, cells, { ...arena, x: -.5, r: 2.5 }), undefined)
  assert.equal(fitOutpost(at, cells, { ...arena, killY: 62 }), undefined)
  assert.equal(fitOutpost(at, survey(platform), arena), undefined)
  assert.equal(fitOutpost(at, survey(() => undefined), arena), undefined)
  assert.equal(fitOutpost(at, survey((x,y,z) => Math.abs(x) === 2 || Math.abs(z) === 2 ? undefined : platform(x,y,z)), arena), undefined)
  const hiddenDoor = survey((x,y,z) => x === 0 && z === -1 && y === 1 ? undefined : y === -1 ? stone : air)
  assert.equal(fitOutpost(at, hiddenDoor, arena, 'north'), undefined)
  assert.deepEqual(fitOutpost(at, hiddenDoor, arena), { y: 64, direction: 'south' })
  const boundary = { ...at, x: 29_999_998 }
  const edge = outpostSurvey(boundary).map(at => ({ at, existing: at.y === 63 ? stone : air }))
  assert.equal(fitOutpost(boundary, edge, undefined, 'east'), undefined)
  assert.deepEqual(fitOutpost(at, survey((x,y,z) => x === 2 && z === 0 && y === -1 ? stone : air), arena), { y: 64, direction: 'east' })
  assert.equal(fitOutpost(at, survey((x,y,z) => z === -2 && y === -1 ? { name: 'lava', solid: false } : platform(x,y,z)), arena), undefined)
})

test('outpost floor treads require the broad supporting shape of an actual 1.21.11 slab or stair', () => {
  const block = (name, properties = {}) => Block.fromProperties(registry.blocksByName[name].id, properties)
  for (const type of ['bottom', 'top', 'double']) assert.ok(outpostTread(block('stone_slab', { type })))
  for (const half of ['top', 'bottom']) for (const shape of ['straight', 'inner_left', 'outer_right']) {
    assert.ok(outpostTread(block('sandstone_stairs', { half, shape })))
  }
  for (const name of ['oak_fence', 'magma_block', 'scaffolding', 'air']) assert.ok(!outpostTread(block(name)))
  assert.ok(!outpostTread({ name: 'stone_slab', shapes: [] }))
})

test('a builder standing on a bottom slab puts the deck in its support cell and discards a survey from the previous round', async () => {
  for (const reset of [false, true]) {
    const feet = { x: .5, y: 63.5, z: .5 }, work = []
    const bot: any = { name: 'A', team: 'blue', swarmPosition: { purpose: 'build', at: feet, highGround: 4 }, c: { async call(method, p) {
      if (method === 'swarm_pose' && p.cells && p.outpost) {
        if (reset) driver.reset()
        return { detail: { cells: p.cells.map(at => ({ at, existing: at.y === 63 ? stair : air })) } }
      }
      if (method === 'swarm_pose' && p.inspectOnly) return { detail: { existing: stair } }
      if (method === 'swarm_work') {
        work.push(p)
        return { detail: { done: true, at: p.at, after: p.item, before: p.item, already: true, confirmation: 'visible_existing' } }
      }
      return {}
    } } }
    const pos = { A: { p: feet, hp: 20, inv: { iron_pickaxe: 1, cobblestone: 64 }, armor: {} } }
    const driver = createSwarmDriver({ bots: [bot], pos, arena, home: () => feet, alive: () => true, hostile: () => false, log() {} })
    await driver.turn(bot)
    const build = driver.snapshot().blue.tasks.filter(t => t.kind === 'build')
    assert.equal(build.length, reset ? 0 : 32)
    assert.equal(work.length, reset ? 0 : 1)
    if (!reset) {
      assert.ok(work[0].outpostFloor)
      assert.equal(work[0].at.y, 63)
      assert.equal(work[0].item, stair.name)
      assert.equal(build.filter(t => t.status === 'done').length, 1)
    }
  }
})

test('two builders surveying different blocks of the same ledge concurrently contribute to one outpost', async () => {
  const board = new SwarmBoard('blue', () => 1000), pending = [], placed = []
  const members = ['A', 'B'].map((id, x) => ({ id, team: 'blue', role: 'miner-builder' as const, position: { ...at, x },
    health: 20, strength: 1, inventory: { cobblestone: 32 } }))
  board.setMembers(members)
  const bots = members.map(m => ({ name: m.id, c: { async call(method, p) {
    if (method === 'swarm_pose' && p.cells) {
      if (placed.length >= 2) return { detail: { cells: [] } }
      await new Promise<void>(resolve => pending.push(resolve))
      return { detail: { cells: p.cells.map(at => ({ at, existing: at.y === 63 ? stone : air })) } }
    }
    if (method === 'swarm_pose') return { detail: { existing: stone } }
    if (method === 'swarm_work') {
      placed.push({ by: m.id, at: p.at })
      return { detail: { done: true, at: p.at, after: 'stone', before: 'stone', already: true, confirmation: 'visible_existing' } }
    }
    return {}
  } } }))
  const sw: any = { bots, pos: Object.fromEntries(members.map(m => [m.id, { p: m.position, inv: m.inventory }])),
    blueprints: new Map(), placed: new Map(), now: () => 1000, alive: () => true, teamOf: () => 'blue', telemetry: { built: 0 },
    renew: (b, worker, cell) => b.renew(cell.id, worker.name, cell.claim.token, 25000), log() {}, say() {}, detail: r => r?.detail || {} }
  Object.assign(sw, swarmRetry(sw))
  const { buildStep } = swarmBuild(sw)
  const steps = members.map((member, i) => buildStep(bots[i], { member, members, board }, { kind: 'outpost', origin: member.position }))
  assert.equal(pending.length, 2)
  for (const wake of pending.reverse()) wake()
  await Promise.all(steps)
  assert.equal(sw.blueprints.size, 1)
  assert.equal(board.tasks().length, 32)
  assert.deepEqual(placed.map(r => r.by).sort(), ['A', 'B'])
  assert.notDeepEqual(placed[0].at, placed[1].at)
  assert.equal(board.tasks().filter(t => t.status === 'done').length, 2)
  // From the lower step, the proposed room would intersect the unfinished deck above the worker.
  sw.pos.A.p = members[0].position = { ...at, z: 2, y: 62 }
  await buildStep(bots[0], { member: members[0], members, board }, { kind: 'outpost', origin: sw.pos.A.p })
  assert.equal(board.tasks().filter(t => t.status === 'done').length, 3)
  assert.equal(sw.blueprints.size, 1)
  const deck = [...sw.blueprints.values()][0], context = { member: members[0], members, board }
  for (const dz of [-1, -2]) {
    const entrance = { ...deck.origin, z: deck.origin.z + dz }
    const worked = await buildStep(bots[0], context, { kind: 'beacon', origin: entrance })
    assert.equal(worked, false, 'leave both the doorway and its landing open for the team')
  }
  assert.equal(sw.blueprints.size, 1)
})

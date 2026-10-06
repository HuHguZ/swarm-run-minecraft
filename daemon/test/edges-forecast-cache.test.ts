'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const edges = require('../src/edges')

const base = () => ({ pos: new Vec3(.5, 64, .5), vel: new Vec3(0, 0, 0), onGround: true })
const forecast = bot => edges.run(bot, base(), {} as Record<string, any>, { hold: 2, max: 3, groundY: 64 })

test('a synchronous physics forecast reads each full block once and refreshes on the next run', () => {
  let reads = 0
  let ground = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ waterlogged: false }) }
  const bot = {
    blockAt: (p, extra) => { assert.equal(extra, false); reads++; return ground },
    physics: { simulatePlayer (state, world) {
      const a = world.getBlock(new Vec3(.2, 63.1, .2))
      const b = world.getBlock(new Vec3(.8, 63.9, .8))
      assert.equal(a, b, 'one cell retains the complete Block object')
      assert.equal(a.shapes, ground.shapes)
      assert.equal(a.getProperties().waterlogged, false)
      state.isInLava = a.name === 'lava'
    } }
  }
  assert.equal(forecast(bot).fall, false)
  assert.equal(reads, 1, 'three forecast steps reuse the full block in this cell')
  ground = { ...ground, name: 'lava' }
  assert.equal(forecast(bot).lava, true)
  assert.equal(reads, 2, 'a later forecast sees the changed world')
})

test('distinct cells, including negative coordinates, keep distinct exact Block objects', () => {
  const cells = new Map()
  const seen = []
  const bot = {
    blockAt: p => {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      assert.equal(cells.has(key), false, 'one read per cell in this forecast')
      const block = { name: key, shapes: [[0, 0, 0, 1, .5, 1]] }
      cells.set(key, block)
      return block
    },
    physics: { simulatePlayer (state, world) {
      const points = [new Vec3(-.1, 63, 0), new Vec3(.1, 63, 0), new Vec3(0, 64, 0), new Vec3(0, 63, 1)]
      for (const p of points) {
        const b = world.getBlock(p)
        assert.equal(b, cells.get(b.name))
        seen.push(b)
      }
    } }
  }
  forecast(bot)
  assert.equal(cells.size, 4)
  assert.notEqual(seen[0], seen[1])
  assert.equal(seen[0], seen[4])
})

test('an unknown block is reused only within this forecast and is re-read after a chunk arrives', () => {
  let loaded = false
  let reads = 0
  const bot = {
    blockAt: () => { reads++; return loaded ? { name: 'stone' } : null },
    physics: { simulatePlayer (state, world) {
      const b = world.getBlock(new Vec3(0, 63, 0))
      assert.equal(b?.name ?? null, loaded ? 'stone' : null)
    } }
  }
  forecast(bot)
  assert.equal(reads, 1)
  loaded = true
  forecast(bot)
  assert.equal(reads, 2)
})

test('an undefined full-block result retains its value without repeating reads in the forecast', () => {
  let reads = 0
  const bot = {
    blockAt: () => { reads++; return undefined },
    physics: { simulatePlayer (state, world) { assert.equal(world.getBlock(new Vec3(0, 63, 0)), undefined) } }
  }
  forecast(bot)
  assert.equal(reads, 1)
})

test('a failed forecast cannot leave a stale geometry cache for another forecast', () => {
  let fail = true
  let reads = 0
  const bot = {
    blockAt: () => { reads++; return { name: fail ? 'air' : 'stone' } },
    physics: { simulatePlayer (state, world) {
      const b = world.getBlock(new Vec3(0, 63, 0))
      if (fail) throw new Error('forecast failed')
      assert.equal(b.name, 'stone')
    } }
  }
  assert.throws(() => forecast(bot), /forecast failed/)
  fail = false
  assert.equal(forecast(bot).fall, false)
  assert.equal(reads, 2)
})

test('terrain columns still inspect the current full block outside physics forecasts', () => {
  let ground = 'stone'
  const bot = { blockAt: p => ({ name: p.y < 64 ? ground : 'air', boundingBox: p.y < 64 && ground === 'stone' ? 'block' : 'empty' }) }
  assert.equal(edges.hazardAround(bot, new Vec3(.5, 64, .5), 5, new Map()), false)
  ground = 'lava'
  assert.equal(edges.hazardAround(bot, new Vec3(.5, 64, .5), 5, new Map()), true)
  assert.equal(edges.column(bot, 0, 0, 64).lava, true)
})

test('cached forecasts match the installed physics for full blocks, slabs and waterlogged stairs', () => {
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const { Physics, PlayerState } = require('prismarine-physics')
  for (const [name, properties] of [
    ['stone', {} as Record<string, any>],
    ['oak_slab', { type: 'bottom', waterlogged: false }],
    ['oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: true }]
  ]) {
    let reads = 0
    const stateId = Block.fromProperties(name, properties).stateId
    const read = p => {
      reads++
      const b = Block.fromStateId(p.y < 63 ? registry.blocksByName.stone.minStateId : p.y < 64 ? stateId : 0)
      b.position = p.floored()
      return b
    }
    const bot = {
      version: '1.21.11',
      entity: { position: new Vec3(.5, 64, .5), velocity: new Vec3(.4, .4, .1), onGround: true, effects: {} as Record<string, any>, attributes: {} as Record<string, any>, yaw: 0, pitch: 0 },
      inventory: { slots: [] },
      blockAt: read,
      physics: Physics(registry, { getBlock: read })
    }
    const control = { forward: true, back: false, left: false, right: false, jump: false, sprint: true, sneak: false }
    const expected = new PlayerState(bot, { ...control })
    for (let tick = 0; tick < 28; tick++) bot.physics.simulatePlayer(expected, { getBlock: read })
    const uncachedReads = reads
    reads = 0
    const result = edges.run(bot, new PlayerState(bot, control), control, { hold: 28, max: 28, groundY: 64, safe: 100 })
    assert.equal(result.fall, false, name)
    assert.deepEqual(result.rest, expected.pos, `${name}: exact trajectory is retained`)
    assert.ok(reads < uncachedReads / 2, `${name}: ${reads} reads versus ${uncachedReads}`)
  }
})

test('pushPlan shares one exact geometry snapshot across trajectories and refreshes for its next call', () => {
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const { Physics } = require('prismarine-physics')
  const worlds = new Set()
  const reads = new Map()
  let inPhysics = false
  let ground = 'stone'
  const read = p => {
    const cell = p.floored()
    if (inPhysics) {
      const key = `${cell.x},${cell.y},${cell.z}`
      reads.set(key, (reads.get(key) || 0) + 1)
    }
    const inside = cell.x >= -4 && cell.x <= 32 && cell.z >= -4 && cell.z <= 6
    const b = Block.fromStateId(cell.y < 64 && inside ? registry.blocksByName[ground].minStateId : 0)
    b.position = cell
    return b
  }
  const bot = {
    version: '1.21.11', registry,
    entity: { position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), onGround: true, effects: {} as Record<string, any>, attributes: {} as Record<string, any>, yaw: 0, pitch: 0 },
    inventory: { slots: [] }, blockAt: read,
    physics: Physics(registry, { getBlock: read })
  }
  const simulate = bot.physics.simulatePlayer
  let ticks = 0
  bot.physics.simulatePlayer = (state, world) => {
    worlds.add(world); ticks++; inPhysics = true
    try { return simulate(state, world) } finally { inPhysics = false }
  }
  const foe = { position: new Vec3(2.5, 64, .5), equipment: [] }
  edges.pushPlan(bot, foe, { kb: 0 })
  assert.ok(ticks > 28, 'the real planner evaluates multiple complete trajectories')
  assert.equal(worlds.size, 1, 'all trajectories use one synchronous snapshot')
  assert.ok(reads.size > 0)
  assert.ok([...reads.values()].every(n => n === 1), 'each physics cell constructs its full Block once')
  const firstWorld = [...worlds][0]
  reads.clear(); worlds.clear(); ground = 'lava'
  edges.pushPlan(bot, foe, { kb: 0 })
  assert.equal(worlds.size, 1)
  assert.notEqual([...worlds][0], firstWorld, 'a later planner call owns a new snapshot')
  assert.ok(reads.size > 0, 'changed terrain is read again')
})

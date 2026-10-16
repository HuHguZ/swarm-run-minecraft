import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const { Vec3 } = require('vec3')
const { RaycastIterator } = require('prismarine-world/src/iterators')

function fixture (y: number, closed = false) {
  const blocks = new Map<string, string>()
  for (let x = 124; x <= 138; x++) blocks.set(`${x},${y - 1},-131`, 'netherrack')
  if (closed) for (let z = -134; z <= -128; z++) for (let h = y; h <= y + 16; h++) blocks.set(`126,${h},${z}`, 'netherrack')
  const bot: any = { game: { dimension: 'the_nether' }, health: 20,
    entity: { position: new Vec3(124.5, y, -130.5) },
    blockAt: p => { const q = p.floored(); const name = blocks.get(`${q.x},${q.y},${q.z}`) || 'air'; const empty = /^(air|lava|fire)$/.test(name); return {
      name, position: q, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]]
    } },
    findBlocks: ({ matching, maxDistance }) => [...blocks.keys()].map(k => new Vec3(...k.split(',').map(Number)))
      .filter(p => p.distanceTo(bot.entity.position) <= maxDistance && matching(bot.blockAt(p))) }
  bot.world = { raycast: (origin, direction, range, match) => {
    const ray = new RaycastIterator(origin, direction, range)
    let p = origin
    while (p) {
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
      if (match ? match(b, ray) : ray.intersect(b.shapes, b.position)) return b
      p = ray.next()
    }
    return null
  } }
  const file = path.resolve(__dirname, '../src/fortress.js')
  const context: any = { require: createRequire(file), module: { exports: {} }, console: { log () {} }, process, testBot: bot, moves: [] }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    look = () => ({ seen: 0, seenList: [] });
    keepBlocks = async () => null;
    spawnerHint = () => null;
    placeOf = () => ({ x: 127, y: 48, z: -131, dimension: 'the_nether' });
    climbWalk = async (_session, _ctl, top, _deadline, opts) => {
      moves.push({ top: { x: top.x, y: top.y, z: top.z }, exact: opts?.exact });
      testBot.entity.position = top.offset(0.5, 1, 0.5);
      return { ok: true };
    };
  `, context)
  return { bot, blocks, context, session: { bot, mcData: {} } }
}

for (const y of [60, 74]) test(`fortress with only one remembered brick walks to a visible supported view at y=${y}`, async () => {
  const f = fixture(y)
  const start = f.bot.entity.position.clone()
  const r = await f.context.module.exports.tour(f.session, { aborted: false }, { deadline: Infinity, hops: 2, pie: true })
  assert.ok(f.context.moves.some(m => Math.hypot(m.top.x + 0.5 - start.x, m.top.z + 0.5 - start.z) >= 8), 'a singleton memory does not infer a bridge axis or end the tour')
  assert.ok(r.explored >= 2, 'a new actual view is credited before planning another leg')
  assert.ok(r.hops.some(h => h.view), 'the receipt identifies a physical observation probe')
  assert.ok(f.context.moves.every(m => m.exact), 'a nearby view must not use the old radius-three successful no-op')
})

test('fortress view probe cannot choose a supported floor behind an opaque wall', async () => {
  const f = fixture(60, true)
  await f.context.module.exports.tour(f.session, { aborted: false }, { deadline: Infinity, hops: 2, pie: true })
  assert.ok(f.context.moves.every(m => m.top.x < 126), 'hidden support cells never become strategic observation points')
})

for (const fluid of ['lava', 'fire']) test(`fortress view probe does not treat ${fluid} as open room for the body`, async () => {
  const f = fixture(60)
  for (let x = 125; x <= 138; x++) f.blocks.set(`${x},60,-131`, fluid)
  await f.context.module.exports.tour(f.session, { aborted: false }, { deadline: Infinity, hops: 2, pie: true })
  assert.equal(f.context.moves.length, 0)
})

test('exact observation arrival rejects an acknowledged path without movement, preserving the default climb contract', async () => {
  const f = fixture(60)
  const file = path.resolve(__dirname, '../src/fortress.js')
  const baseRequire = createRequire(file)
  let goal: any = null
  f.bot.pathfinder = { thinkTimeout: 5000, setGoal () {} }
  const context: any = { module: { exports: {} }, console, process,
    require: name => name === './movement' ? { ...baseRequire(name),
      stuckGuard: () => ({ promise: new Promise(() => {}), stop () {} }),
      gotoPath: (_bot, g) => { goal = g; return Promise.resolve() }
    } : name === './nether' ? { guarded: (_session, ctl, run) => run(ctl) } : baseRequire(name) }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.testClimbWalk = climbWalk;', context)
  const top = new Vec3(126, 59, -131)
  const ack = await context.module.exports.testClimbWalk(f.session, { aborted: false }, top, Infinity, { exact: true })
  assert.equal(ack.ok, false, 'a successful path promise is not a new eye position')
  assert.equal(goal.isEnd({ x: 124, y: 60, z: -131 }), false)
  const legacy = await context.module.exports.testClimbWalk(f.session, { aborted: false }, top, Infinity)
  assert.equal(legacy.ok, true, 'existing inferred deck/blaze callers keep their previous radius')
  f.bot.entity.position = new Vec3(126.5, 60, -130.5)
  const landed = await context.module.exports.testClimbWalk(f.session, { aborted: false }, top, Infinity, { exact: true })
  assert.equal(landed.ok, true)
})
test('repeated tours retain actual views while short steps do not claim new exploration', async () => {
  const f = fixture(74)
  for (const key of f.blocks.keys()) if (+key.split(',')[0] > 130) f.blocks.delete(key)
  const stops = []
  for (let i = 0; i < 3; i++) {
    const before = f.context.moves.length
    const r = await f.context.module.exports.tour(f.session, { aborted: false }, { deadline: Infinity, hops: 2, pie: false })
    assert.equal(r.explored, 1, 'the room is shorter than the exploration credit distance')
    stops.push(...f.context.moves.slice(before).map(p => `${p.top.x},${p.top.y},${p.top.z}`))
  }
  assert.equal(stops.length, 6, 'each call can still seek a supported visible floor')
  assert.equal(new Set(stops).size, stops.length, 'later calls must remember earlier observations')
})

test('observation history belongs to its dimension and repeated looks do not grow it', async () => {
  const f = fixture(74)
  for (let i = 0; i < 3; i++) await f.context.module.exports.tour(f.session, { aborted: false }, { deadline: Infinity, hops: 0 })
  assert.equal((f.session as any)._ndTourVisited.views.length, 1)
  f.bot.game.dimension = 'overworld'
  f.bot.entity.position = new Vec3(0.5, 74, 0.5)
  await f.context.module.exports.tour(f.session, { aborted: false }, { deadline: Infinity, hops: 0 })
  const remembered = (f.session as any)._ndTourVisited
  assert.equal(remembered.world, 'overworld')
  assert.equal(remembered.views.length, 1)
  assert.equal(remembered.views[0].x, 0.5)
})

function coveredBridge(cancel = false) {
  const f = fixture(51), rises: number[] = [], digs: any[] = []
  f.blocks.set('124,53,-131', 'nether_bricks')
  f.context.observed = [new Vec3(124, 53, -131)]
  vm.runInNewContext('look = () => ({ seen: 1, seenList: observed });', f.context)
  const realRequire = f.context.require
  f.context.require = name => name === './build' ? {
    towerUp: async (_bot, ctl, blocks) => {
      rises.push(blocks)
      if (cancel) ctl.aborted = true
      return { ok: false, placed: 0, why: ['потолок nether_bricks'] }
    },
    digUp: async (_bot, _ctl, options) => {
      digs.push(options)
      const from = f.bot.entity.position.y
      f.blocks.delete('124,53,-131')
      for (let y = from; y < from + options.blocks; y++) f.blocks.set(`124,${y},-131`, 'cobblestone')
      f.bot.entity.position.y += options.blocks
      return { dug: 1 }
    }
  } : realRequire(name)
  return { ...f, rises, digs }
}

test('a visible fortress ceiling is opened to its observed walking floor after a blocked tower', async () => {
  const f = coveredBridge()
  const result = await f.context.module.exports.tour(f.session, { aborted: false }, { deadline: Infinity, hops: 1 })
  assert.equal(f.digs.length, 1, 'the tower ceiling receipt must lead to a legal upward route')
  assert.equal(f.digs[0].blocks, 3, 'target feet are one above the seen ceiling, not an inferred world height')
  assert.equal(f.rises[0], 3)
  assert.equal(f.bot.entity.position.y, 54)
  assert.equal(f.bot.blockAt(f.bot.entity.position.offset(0, -1, 0)).boundingBox, 'block')
  assert.ok(result.hops.some(h => h.digUp === 1))
})

test('a cancelled ceiling tower does not begin a late upward excavation', async () => {
  const f = coveredBridge(true)
  const ctl = { aborted: false }
  await f.context.module.exports.tour(f.session, ctl, { deadline: Infinity, hops: 1 })
  assert.equal(ctl.aborted, true)
  assert.equal(f.digs.length, 0)
})


test('fortress view probe cannot infer headroom above a visible bridge underside', () => {
  const f = fixture(60)
  f.bot.entity.position = new Vec3(124.5, 57, -130.5)
  vm.runInNewContext('module.exports.testViewLeg = viewLeg;', f.context)
  assert.equal(f.context.module.exports.testViewLeg(f.bot, [f.bot.entity.position]), null)
})

function deckFixture () {
  const f = fixture(64)
  f.blocks.clear()
  for (const [x, z] of [[124, -131], [125, -131], [126, -131], [124, -130], [124, -129]]) f.blocks.set(`${x},63,${z}`, 'nether_bricks')
  return f
}
test('visible deck DFS backtracks from a dead end and visits the other branch', () => {
  const f = deckFixture(), state = {}, walked = []
  for (let i = 0; i < 12; i++) {
    const leg = f.context.module.exports.deckLeg(f.bot, state)
    if (!leg) break
    walked.push(leg)
    f.bot.entity.position = leg.floor.offset(0.5, 1, 0.5)
  }
  assert.ok(walked.some(p => p.back))
  assert.ok(walked.some(p => p.floor.x === 124 && p.floor.z === -129))
})
test('visible deck DFS does not retry an acknowledged move without actual arrival', () => {
  const f = deckFixture(), state = {}
  const first = f.context.module.exports.deckLeg(f.bot, state)
  const next = f.context.module.exports.deckLeg(f.bot, state)
  assert.ok(first && next)
  assert.equal(next.floor.equals(first.floor), false)
})


test('neR-1: the visible bridge overhead is approached before following a horizontal pie hint below it', async () => {
  const f = coveredBridge()
  vm.runInNewContext('spawnerHint = () => ({ x: 148, z: -131, by: "пирог", yaw: 90 });', f.context)
  await f.context.module.exports.tour(f.session, { aborted: false }, { deadline: Infinity, hops: 1, pie: true })
  assert.equal(f.rises.length, 1)
  assert.equal(f.digs[0]?.blocks, 3)
  assert.equal(f.bot.entity.position.y, 54)
})

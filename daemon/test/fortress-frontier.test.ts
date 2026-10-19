import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import { cjsContext } from './cjs-context'
import { Vec3 } from 'vec3'
import { RaycastIterator } from 'prismarine-world/src/iterators'
import { bodySource } from './source-fixture'

function scene({ moving = true, blocked = false, enabled = true } = {}) {
  const cells = new Map<string, string>()
  for (let x = -15; x <= 15; x++) for (let z = -2; z <= 2; z++) cells.set(`${x},63,${z}`, 'netherrack')
  const brick = new Vec3(13, 64, 0)
  cells.set('13,64,0', 'nether_bricks')
  if (blocked) for (let y = 64; y < 72; y++) for (let z = -4; z <= 4; z++) cells.set(`2,${y},${z}`, 'netherrack')
  const items = [{ name: 'stone_pickaxe', count: 1, durabilityUsed: 0 }]
  const bot: any = { game: { dimension: 'the_nether' }, health: 20, food: 20, entities: {},
    entity: { position: new Vec3(.5, 64, .5) }, inventory: { items: () => items },
    blockAt: p => { const q = p.floored(), name = cells.get([q.x,q.y,q.z].join(',')) || 'air'
      const empty = /^(air|lava|water|fire)$/.test(name)
      return { name, position: q, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0,0,0,1,1,1]], stateId: name }
    },
    findBlocks: ({ matching, maxDistance }) => [...cells.keys()].map(k => new Vec3(...(k.split(',').map(Number) as [number, number, number])))
      .filter(p => p.distanceTo(bot.entity.position) <= maxDistance && matching(bot.blockAt(p))) }
  bot.world = { raycast: (from, direction, distance, match) => {
    const ray = new RaycastIterator(from, direction, distance)
    let p = from
    while (p) {
      const b = bot.blockAt(new Vec3(p.x,p.y,p.z))
      if (match ? match(b, ray) : ray.intersect(b.shapes, b.position)) return b
      p = ray.next()
    }
    return null
  } }
  const file = path.resolve(__dirname, '../src/fortress.ts'), native = createRequire(file)
  const calls: any[] = [], messages: any[] = []
  const context: any = { module: { exports: {} }, require: native, console: { log: (...args) => messages.push(args) },
    process: { env: { ND_FORTRESS_FRONTIER: enabled ? '1' : '0' } }, fixtureBot: bot, fixtureBrick: brick,
    fixtureMove: top => { calls.push(top.clone()); if (moving) bot.entity.position = top.offset(.5,1,.5); return { ok: moving, error: moving ? undefined : 'noPath' } } }
  vm.runInNewContext(transformSync(bodySource(file), { loader: 'ts', format: 'cjs' }).code + `
    look = () => ({ seen: 1, seenList: [fixtureBrick] });
    keepBlocks = async () => null;
    spawnerHint = () => null;
    climbWalk = async (_s, _c, top) => fixtureMove(top);
    climbTo = legTo = async () => ({ ok: false, error: 'old blocked target' });
    module.exports.testViewLeg = viewLeg;
  `, cjsContext(context))
  const session: any = { bot, mcData: {}, journal: { state: { places: { 'крепость (ад)': { x: 13,y:64,z:0,dimension:'the_nether' } } } } }
  return { context, calls, messages, cells, brick, items, bot, session, run: (advance = false, hops = 4) => context.module.exports.tour(session, { aborted: false }, { deadline: Infinity, hops, pie: false, advance }) }
}

test('an off-deck fortress tour takes a supported visible observation step before repeating an inaccessible brick', async () => {
  const f = scene(), start = f.bot.entity.position.clone()
  const r = await f.run()
  assert.ok(f.bot.entity.position.distanceTo(start) >= 8, 'seeing bricks while standing on netherrack needs its own change of viewpoint')
  assert.ok(r.hops.some(h => h.frontier), 'a real frontier action has a receipt')
  assert.ok(f.calls[0].x > 0, 'the observed fortress, not an arbitrary compass direction, ranks the observation goal')
})

test('unchanged noPath receipts consume different visible goals; another call does not retry the same failed endpoint', async () => {
  const f = scene({ moving: false })
  await f.run(true, 3)
  await f.run(true, 3)
  assert.ok(f.calls.length >= 2)
  const keys = f.calls.map(p => [p.x,p.y,p.z].join(','))
  assert.equal(new Set(keys).size, keys.length, 'failure is remembered across RPC calls without a timer')
})

test('frontier observation never targets a support or headroom hidden behind an opaque wall', async () => {
  const f = scene({ blocked: true })
  await f.run(true, 4)
  assert.ok(f.calls.length > 0)
  assert.ok(f.calls.every(p => p.x < 2))
})

for (const fluid of ['lava', 'water', 'fire']) test(`a frontier step rejects ${fluid} in the body`, async () => {
  const f = scene()
  for (const p of [...f.cells.keys()]) if (p.includes(',63,')) {
    const [x,,z] = p.split(','); f.cells.set(`${x},64,${z}`, fluid)
  }
  await f.run(true, 1)
  assert.equal(f.calls.length, 0)
})

test('the control switch preserves the pre-frontier fortress tour', async () => {
  const f = scene({ enabled: false })
  await f.run()
  assert.equal(f.calls.length, 0)
})

test('a short advance without new evidence does not claim a new search view', async () => {
  const f = scene()
  for (const p of [...f.cells.keys()]) if (p.includes(',63,') && Math.abs(Number(p.split(',')[0])) > 2) f.cells.delete(p)
  f.cells.delete('13,64,0')
  f.brick.x = 2; f.brick.y = 63
  f.cells.set('2,63,0', 'nether_bricks')
  const r = await f.run(true, 1)
  assert.equal(r.advanced, false, 'a fresh RPC or a short path is not eight-block displacement or new geometry')
})

test('unrelated loot cannot reopen a failed endpoint; changed building supply can', async () => {
  const f = scene({ moving: false })
  await f.run(true, 1)
  const first = f.calls[0]
  f.items.push({ name: 'quartz', count: 64, durabilityUsed: 0 })
  await f.run(true, 1)
  assert.ok(!f.calls[1].equals(first), 'quartz does not change a failed walking route')
  f.items.push({ name: 'cobblestone', count: 32, durabilityUsed: 0 })
  await f.run(true, 1)
  assert.ok(f.calls[2].equals(first), 'new physical building supply can change route feasibility')
})

test('deckSteps counts confirmed walking arrivals, not failed path attempts', async () => {
  const f = scene({ moving: false })
  f.cells.set('0,63,0', 'nether_bricks'); f.cells.set('1,63,0', 'nether_bricks')
  const r = await f.run(false, 1)
  assert.equal(r.deckSteps, 0)
})

test('a failed approach without displacement yields to the observation tour instead of making forty identical legs', async () => {
  const f = scene({ moving: false })
  f.session.mcData = { blocksByName: { spawner: { id: 1 } } }
  f.session.journal.state.places['крепость (ад)'].x = 60
  const native = f.context.require
  f.context.require = name => name === './perception/eyes' ? { locate: () => [] } : native(name)
  vm.runInNewContext(`
    globalThis.approachCalls = 0; globalThis.tourCalls = 0;
    legTo = async () => { approachCalls++; return { ok: false, error: 'no path from this mouth' }; };
    tour = async () => { tourCalls++; return { hops: [], explored: 1 }; };
    module.exports.testBody = toSpawnerBody;
  `, cjsContext(f.context))
  await f.context.module.exports.testBody(f.session, { aborted: false }, { deadline: Infinity })
  assert.equal(f.context.approachCalls, 1)
  assert.equal(f.context.tourCalls, 1)
})

test('a coarse blaze sound ranks a visible supported view in its direction without exposing a hidden point', async () => {
  const f = scene()
  vm.runInNewContext("spawnerHint = () => ({ x: -12, z: 0, by: 'слух', dir: 'west', band: 'средне' });", cjsContext(f.context))
  const r = await f.context.module.exports.tour(f.session, { aborted: false }, { deadline: Infinity, hops: 1, advance: true, pie: true })
  assert.ok(f.calls[0].x < 0)
  assert.equal(r.hops[0].by, 'слух')
})

test('a flipped F3 bearing retains the existing vertical ascent before another ground frontier', async () => {
  const f = scene(), rises: number[] = [], native = f.context.require
  f.context.require = name => name === './build' ? {
    towerUp: async (_bot, _ctl, n) => { rises.push(n); return { ok: false, placed: 0 } },
    digUp: async () => ({ dug: 0 })
  } : native(name)
  vm.runInNewContext("let bearings = 0; spawnerHint = () => ++bearings === 1 ? { x: -12, z: 0, by: 'пирог', yaw: 90 } : { x: 12, z: 0, by: 'пирог', yaw: -90 };", cjsContext(f.context))
  const r = await f.context.module.exports.tour(f.session, { aborted: false }, { deadline: Infinity, hops: 2, pie: true })
  assert.ok(rises.length > 0, 'a new visible ground goal cannot hide the reason to climb towards a spawner above or below')
  assert.ok(r.hops.some(h => h.vertical))
})

test('the first-spawner clock records a current ray once and never treats a hidden memory as current sight', () => {
  const f = scene()
  f.session.journal.patch = fn => fn(f.session.journal.state)
  f.session.journal.append = () => {}
  f.cells.set('13,64,0', 'spawner')
  vm.runInNewContext('module.exports.testRemember = rememberSpawner;', cjsContext(f.context))
  const remember = f.context.module.exports.testRemember
  remember(f.session, { x: 13, y: 64, z: 0 })
  remember(f.session, { x: 13, y: 64, z: 0 })
  const events = () => f.messages.filter(args => args.includes('спавнер: вижу'))
  assert.equal(events().length, 1)
  assert.ok(Number.isFinite(JSON.parse(events()[0].at(-1)).gameMs))
  f.cells.set('14,64,0', 'spawner')
  for (let y = 64; y < 72; y++) for (let z = -4; z <= 4; z++) f.cells.set(`2,${y},${z}`, 'netherrack')
  remember(f.session, { x: 14, y: 64, z: 0 })
  assert.equal(events().length, 1)
})

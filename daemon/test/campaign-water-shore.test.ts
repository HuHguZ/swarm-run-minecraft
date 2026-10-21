import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { campaignTs, withSetters } from './campaign-source'
import { declarationsOf } from './source-fixture'
import { cjsContext } from './cjs-context'

const source = campaignTs().replace(/\r\n/g, '\n')
const noop = async () => {}
const enabled = { ND_DIG_PLUG_WATER: '1' }
// One inlet corner is nearest; the rest of the visible shoreline is to the north.
const coast = [{ x: -1, y: 62, z: 0 }, ...Array.from({ length: 21 }, (_, i) => ({ x: i - 10, y: 62, z: -3 }))]
const observation = (seen = coast): any => ({ detail: { fair: true, blocks: [{ name: 'water', nearest: seen[0], seen }] } })

function functions(context: any, ...names: string[]) {
  return vm.runInNewContext(transformSync(declarationsOf(source, ...names) + `\n({${names.join(',')}})`, { loader: 'ts' }).code,
    cjsContext(withSetters(context)))
}
function retreat(env: Record<string, string> = enabled, o = observation()) {
  const goals: any[] = [], requests: any[] = []
  const context: any = { process: { env }, state: { pos: { x: 0, y: 63, z: 0 } }, sit: { surface: true },
    died: false, strategyInterrupted: false, heading: 0, known: {}, sense: noop, refresh: noop, dim: () => 'overworld', log() {},
    toSurface: async () => true, walkAway: async () => { throw new Error('unexpected direction without visible water') },
    act: async (method, params) => { requests.push({ method, params }); if (method === 'observe') return o
      assert.equal(method, 'goto'); goals.push(params); return { status: 'done' } } }
  Object.assign(context, functions(context, 'inlandWaterOrigin', 'awayFrom', 'awayFromWater'))
  return { context, goals, requests, run: (visibleOnly = false) => context.awayFromWater(24, visibleOnly) }
}

test('K shore: the whole visible coast sends a retreat inland, not along its nearest corner', async () => {
  const f = retreat()
  const receipt = await f.run()
  assert.equal(f.goals[0].x, 0)
  assert.equal(f.goals[0].z, 24)
  assert.equal(receipt.status, 'done')
  assert.equal(f.goals[0].surface, 'strict')
  assert.equal(f.requests[0].params.fair, true)
})

for (const env of [{}, { ND_DIG_PLUG_WATER: '0' }, { ...enabled, ND_DIG_PLUG_WATER_SHORE: '0' }]) {
  test(`K shore: default and disabled flags retain the old nearest-cell retreat ${JSON.stringify(env)}`, async () => {
    const f = retreat(env)
    await f.run()
    assert.equal(f.goals[0].x, 24)
    assert.equal(f.goals[0].z, 0)
    assert.equal(f.requests[0].params.fair, undefined)
  })
}

test('K shore: remembered, non-fair, malformed and symmetric water cannot invent land', async () => {
  for (const o of [
    { detail: { fair: true, blocks: [{ ...observation().detail.blocks[0], remembered: true }] } },
    { detail: { fair: false, blocks: observation().detail.blocks } },
    { detail: { blocks: observation().detail.blocks } },
    { detail: { fair: true, blocks: [{ name: 'water', seen: [{ x: NaN, z: 1 }] }] } },
    observation([{ x: -1, y: 62, z: 0 }, { x: 1, y: 62, z: 0 }]),
    { detail: { fair: true, blocks: [] } }
  ]) {
    const f = retreat(enabled, o)
    assert.equal(await f.run(true), null)
    assert.equal(f.goals.length, 0)
  }
})

test('K shore: surface first, then observe again; a failed climb never starts the retreat', async () => {
  for (const climbs of [true, false]) {
    const f = retreat()
    f.context.sit.surface = false
    const order: string[] = []
    f.context.toSurface = async () => { order.push('surface'); if (climbs) { f.context.state.pos = { x: 0, y: 63, z: 0 }; f.context.sit.surface = true }; return climbs }
    const act = f.context.act
    f.context.act = async (m, p) => { order.push(m); return act(m, p) }
    await f.run()
    assert.deepEqual(order, climbs ? ['surface', 'observe', 'goto'] : ['surface'])
  }
})

test('K shore: death during the observation never queues a movement', async () => {
  const f = retreat()
  f.context.act = async () => { f.context.died = true; return observation() }
  await f.run()
  assert.equal(f.goals.length, 0)
})

test('K shore: interruption or death while surfacing never queues a shore observation or movement', async () => {
  for (const stop of ['died', 'strategyInterrupted']) {
    const f = retreat()
    f.context.sit.surface = false
    f.context.toSurface = async () => { f.context[stop] = true; return true }
    await f.run()
    assert.equal(f.requests.length, 0)
  }
})

function descent(env: Record<string, string> = enabled, cluster = true) {
  const requests: any[] = [], retreats: any[] = []
  const context: any = { process: { env }, state: { pos: { x: 0, y: 63, z: 0 } }, sit: { surface: true, night: false },
    died: false, strategyInterrupted: false, OW_DEEP: false, OW_SHAFT: false, PICK_STONE: /pickaxe$/,
    known: {}, recoverGuard: noop, unclutter: noop, spares: noop, reserve: noop, sense: noop, torches: noop,
    ensurePick: async () => true, have: () => 0, y: () => context.state.pos.y, dim: () => 'overworld',
    mobInTheWay: async () => false, NIGHT_DOWN2: () => false, nightHold: () => false, log() {},
    awayFrom: async p => { retreats.push(p); return { status: 'done' } },
    awayFromWater: async (distance, visibleOnly = false) => { retreats.push({ distance, visibleOnly }); return { status: 'done' } },
    act: async (method, params) => { requests.push({ method, params })
      if (method === 'observe') return observation()
      assert.equal(method, 'dig_down'); context.state.pos.y = 16; return { detail: { dug: 3, steps: 2 } } } }
  Object.assign(context, functions(context, 'inlandWaterOrigin', 'descend'))
  return { context, requests, retreats, run: () => context.descend(16, { wetCluster: cluster }) }
}

test('K shore: iron and lava stairs face inland before digging; flags off retain north', async () => {
  for (const [env, cluster, direction] of [[enabled, true, 'south'], [{}, true, 'north'], [enabled, false, 'south'],
    [{ ...enabled, ND_DIG_PLUG_WATER_SHORE: '0' }, true, 'north']] as any[]) {
    const f = descent(env, cluster)
    await f.run()
    assert.equal(f.requests.find(r => r.method === 'dig_down').params.direction, direction)
    assert.equal(f.requests.some(r => r.method === 'observe'), direction === 'south')
  }
})

for (const spelling of ['у 100,62,0 — дальше не копаю', 'на 100,62,0: нет опоры — обходи']) test(`K shore: fresh visible coast after water ${spelling}`, async () => {
  const f = descent()
  let digs = 0
  f.context.act = async (method, params) => {
    f.requests.push({ method, params })
    if (method === 'observe') return observation()
    if (++digs === 1) return { detail: { stopped: `вода ${spelling}` } }
    f.context.state.pos.y = 16
    return { detail: { dug: 3, steps: 2 } }
  }
  await f.run()
  assert.deepEqual(f.retreats, [{ distance: 24, visibleOnly: true }, { distance: 24, visibleOnly: false }])
})

test('K shore: tactical interruption during the shore view prevents the dig', async () => {
  const f = descent()
  f.context.act = async method => { assert.equal(method, 'observe'); f.context.strategyInterrupted = true; return observation() }
  await f.run()
  assert.equal(f.requests.length, 0)
})

test('K shore: preflight relocation covers iron and deep lava descents and yields on death', async () => {
  for (const [toY, wetCluster] of [[16, true], [-57, false]] as const) {
    const f = descent()
    f.context.awayFromWater = async (distance, onlyVisible) => {
      assert.equal(distance, 24); assert.equal(onlyVisible, true); f.context.died = true
    }
    await f.context.descend(toY, { wetCluster })
    assert.equal(f.requests.length, 0)
  }
})

test('K shore: perception exposes only already visible water samples and keeps the old schema when off', () => {
  const perception = fs.readFileSync(path.join(__dirname, '../src/perception.ts'), 'utf8')
  for (const [env, fair, samples] of [[enabled, true, true], [{}, true, false], [enabled, false, false]] as any[]) {
    let reads = 0
    const context: any = { process: { env }, interestingIds: () => [1], round: p => ({ x: p.x, y: p.y, z: p.z }),
      require: name => { assert.equal(name, './sight'); return { visibleOf: () => coast.map(p => ({ name: 'water', position: { ...p, distanceTo: () => 4 } })) } } }
    const observe = vm.runInNewContext(transformSync(declarationsOf(perception, 'observe') + '\nobserve', { loader: 'ts' }).code, cjsContext(context))
    const me = { x: 0, y: 63, z: 0, offset: () => me }
    const bot = { entity: { position: me }, entities: {}, blockAt: () => { reads++; return { name: 'grass_block' } }, blockAtCursor: () => null }
    const out = observe(bot, {}, { fair })
    assert.equal(out.blocks[0].seen?.length, samples ? coast.length : undefined)
    assert.equal(reads, 1, 'only the existing standingOn terrain read is permitted')
    if (samples) assert.deepEqual(JSON.parse(JSON.stringify(out.blocks[0].seen)), coast)
  }
})

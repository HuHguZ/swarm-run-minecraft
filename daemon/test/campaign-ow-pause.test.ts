import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { declarationsOf } from './source-fixture'
import { createCampaignIntelligence } from '../src/campaign/intelligence'
import { usefulProgress, stateKey } from '../src/core/world-state'

const read = (name: string) => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8')
function policy(enabled = true) {
  const state: any = { dimension: 'overworld', health: 20, food: 20, inventory: { bucket: 1 }, pos: { x: 0, y: 64, z: 0 }, tactics: { threatLevel: 0 } }
  const sit: any = { night: false, dusk: false, surface: true, inWater: true }
  const known: any = { water: { x: 4, y: 64, z: 0 }, lava: { x: 50, y: 64, z: 0 } }
  const clock = { t: 0 }, logs: string[] = []
  const helper = read('campaign/nether-plan.ts')
  const context: any = { state, sit, known, lavaSourceKnown: true, process: { env: { ND_OW_PAUSE_CAUSE: enabled ? '1' : '0' } },
    gameClock: { now: () => clock.t }, PAUSE_MIN: [5, 10, 20, 40], dim: () => state.dimension,
    have: (name: string) => state.inventory[name] || 0, lighter: () => !!state.inventory.flint_and_steel,
    foodUnits: () => state.inventory.bread || 0, log: (s: string) => logs.push(s) }
  const causePath = path.resolve(__dirname, '../src/campaign/overworld-pause.ts')
  if (fs.existsSync(causePath)) {
    const cause = declarationsOf(fs.readFileSync(causePath, 'utf8'), 'overworldPauseCause').replace(/^export /gm, '')
    vm.runInNewContext(transformSync(cause + ';this.cause=overworldPauseCause', { loader: 'ts' }).code, context)
    context.overworldPauseCause = context.cause
  }
  const source = read('campaign/loop.ts')
  const begin = source.indexOf('const fails = new Map()'), end = source.indexOf('    const resetPauses', begin)
  vm.runInNewContext(transformSync(declarationsOf(helper, 'overworldFailureState') + '\n' + source.slice(begin, end) + '\nthis.api={fails,cooling,failStage}', { loader: 'ts' }).code, context)
  const api = context.api
  return { ...api, state, sit, known, clock, logs, fail: (name = 'cast') => api.failStage(name, name), cooling: (name = 'cast') => api.cooling({ name }) }
}
test('F the first empty OW attempt pauses by cause, and an hour alone cannot reopen it', () => {
  const f = policy(); f.fail(); assert.equal(f.cooling(), true)
  f.clock.t += 3600000; assert.equal(f.cooling(), true)
})
for (const change of ['place', 'height', 'inventory', 'resource', 'night', 'dusk', 'water', 'tactics']) test(`F ${change} reopens immediately without a time gate`, () => {
  const f = policy(); f.fail(); f.fail(); assert.equal(f.cooling(), true)
  if (change === 'place') f.state.pos.x += 16
  if (change === 'height') f.state.pos.y -= 8
  if (change === 'inventory') f.state.inventory.iron_ingot = 3
  if (change === 'resource') f.known.lava.y -= 12
  if (change === 'night') f.sit.night = true
  if (change === 'dusk') f.sit.dusk = true
  if (change === 'water') f.sit.inWater = false
  if (change === 'tactics') f.state.tactics.action = 'shore'
  assert.equal(f.cooling(), false)
})
test('F the control keeps two failures and the five minute pause; Nether stays untouched', () => {
  const f = policy(false); f.fail(); assert.equal(f.cooling(), false); f.fail(); assert.equal(f.cooling(), true)
  f.clock.t += 300000; assert.equal(f.cooling(), false)
  const ne = policy(); ne.state.dimension = 'the_nether'; ne.fail('food'); assert.equal(ne.cooling('food'), false)
  ne.fail('food'); assert.equal(ne.cooling('food'), true); ne.clock.t += 300000; assert.equal(ne.cooling('food'), false)
})
test('F coordinate drift, timestamps and inventory key ordering cannot release the same cause', () => {
  const f = policy(); f.state.inventory = { bucket: 1, stick: 2 }; f.fail()
  f.state.inventory = { stick: 2, bucket: 1 }; f.state.pos.x += 1; f.state.pos.y += 1
  f.known.lava.updatedAt = 'new timestamp'; f.known.lava.note = 'observer metadata'
  assert.equal(f.cooling(), true)
})

function brain(enabled = true) {
  process.env.ND_OW_PAUSE_CAUSE = enabled ? '1' : '0'
  const clock = { t: 0 }, records: any[] = [], calls: string[] = []
  const observation: any = { state: { dimension: 'overworld', health: 20, food: 20, pos: { x: 0, y: 64, z: 0 },
    inventory: { stone_pickaxe: 1, bucket: 1, water_bucket: 1, flint_and_steel: 1 }, tactics: { threatLevel: 0 } },
    known: { lava: { x: 50, y: 64, z: 0 } }, situation: { inWater: true, night: false } }
  const intelligence = createCampaignIntelligence({ eyes: 12, beds: 5, now: () => clock.t, sleep: async () => {}, record: r => records.push(r),
    observe: async () => observation, call: async () => ({}), execute: async c => { calls.push(c.skill); return { outcome: 'FAILURE', events: [] } } })
  intelligence.director.options.goal = s => s.facts.portal?.value === true
  for (const strategy of intelligence.registry.all()) strategy.estimateRisk = () => 0
  intelligence.registry.get('LavaPoolPortal')!.estimateCost = () => 1
  const stages = ['food', 'cast'].map(name => ({ name, needed: () => true, ready: () => true, defer: () => false, done: () => false, run: async () => {} }))
  return { intelligence, clock, observation, stages, records, calls, select: (blocked: string[]) => intelligence.select(stages, s => blocked.includes(s.name), name => blocked.includes(name)) }
}
test('F a paused graph ID cannot bypass cooling through special dispatch; next productive edge wins by price', async () => {
  const old = process.env.ND_OW_PAUSE_CAUSE
  try {
    const f = brain(); const before = await f.select([])
    assert.equal(before?.strategy?.id, 'LavaPoolPortal'); assert.equal(before?.stage.pauseKey, 'LavaPoolPortal')
    const result = await f.select(['LavaPoolPortal'])
    assert.equal(result?.strategy?.id, 'FindFood')
    await result!.stage.run(); assert.deepEqual(f.calls, ['food'])
  } finally { if (old === undefined) delete process.env.ND_OW_PAUSE_CAUSE; else process.env.ND_OW_PAUSE_CAUSE = old }
})
test('F director exhaustion follows the same cause, and snapshot metadata never manufactures useful progress', async () => {
  const old = process.env.ND_OW_PAUSE_CAUSE
  try {
    const f = brain(), strategy = f.intelligence.registry.get('LavaPoolPortal')!
    await f.intelligence.director.run(strategy); await f.intelligence.director.run(strategy)
    f.clock.t += 3600000
    let state = await f.intelligence.environment.observe(); f.intelligence.director.decide(state)
    assert.equal(f.intelligence.director.canRun(strategy, state), false)
    assert.equal(f.intelligence.director.nextRetryAt(), null)
    const before = structuredClone(state); f.observation.situation.inWater = false
    state = await f.intelligence.environment.observe()
    assert.equal(usefulProgress(before, state), false); assert.equal(stateKey(before), stateKey(state))
    f.intelligence.director.decide(state); assert.equal(f.intelligence.director.canRun(strategy, state), true)
  } finally { if (old === undefined) delete process.env.ND_OW_PAUSE_CAUSE; else process.env.ND_OW_PAUSE_CAUSE = old }
})
test('F a paused graph producer cannot restart through Recovery under a different ID', async () => {
  const old = process.env.ND_OW_PAUSE_CAUSE
  try {
    const f = brain(); f.observation.state.inventory = {}
    f.intelligence.director.options.goal = s => s.resources.wood > 0
    for (const strategy of f.intelligence.registry.all()) if (strategy.id !== 'AcquireWood') strategy.preconditions = () => false
    const stage = { name: 'wood', needed: () => true, ready: () => true, defer: () => false, done: () => false, run: async () => {} }
    assert.equal((await f.intelligence.select([stage], () => false))?.strategy?.id, 'AcquireWood')
    assert.equal(await f.intelligence.select([stage], () => false, name => name === 'AcquireWood'), null)
  } finally { if (old === undefined) delete process.env.ND_OW_PAUSE_CAUSE; else process.env.ND_OW_PAUSE_CAUSE = old }
})
test('F paused hunting leaves carried eating, bread and healing as separate graph choices', async () => {
  const old = process.env.ND_OW_PAUSE_CAUSE
  try {
    const f = brain(); f.observation.state.food = 14; f.observation.state.inventory.bread = 3
    const selected = await f.select(['food', 'FindFood', 'LavaPoolPortal'])
    assert.equal(selected?.strategy?.id, 'EatFood')
    f.observation.state.tactics.threatLevel = 2
    assert.equal(await f.select(['food', 'FindFood']), null)
  } finally { if (old === undefined) delete process.env.ND_OW_PAUSE_CAUSE; else process.env.ND_OW_PAUSE_CAUSE = old }
})
for (const dimension of ['overworld', 'the_nether']) test(`F stage pause identity remains native in ${dimension}`, async () => {
  const seen: string[] = [], state: any = { dimension }, loop: any = { fails: new Map(), failureKey: n => n, failStage: n => seen.push(n), resetPauses: () => {} }
  const context: any = { state, sit: {}, process: { env: { ND_OW_PAUSE_CAUSE: '1' } }, dim: () => dimension,
    setStage: () => {}, bag: () => '', log: () => {}, stageProgress: () => ({}), telemetry: { on: () => false },
    gameClock: { now: () => 0 }, strategyExecuting: false, manualControl: false, died: false, only: null,
    refresh: async () => {}, sense: async () => {}, readMemory: async () => {} }
  vm.runInNewContext(transformSync(declarationsOf(read('campaign/loop/stage.ts'), 'loopStage') + ';this.run=loopStage', { loader: 'ts' }).code, context)
  const stage = { name: 'nether', pauseKey: 'FindFortress', run: async () => {}, needed: () => true, done: () => false, defer: () => false }
  await context.run(loop, stage, 1)
  assert.deepEqual(seen, [dimension === 'overworld' ? 'FindFortress' : 'nether'])
})
test('F an interrupted attempt without resources also waits for a changed cause', async () => {
  const calls: string[] = [], loop: any = { fails: new Map(), failureKey: n => n, failStage: n => calls.push(n) }
  const context: any = { process: { env: { ND_OW_PAUSE_CAUSE: '1' } }, dim: () => 'overworld', setStage: () => {}, state: {},
    bag: () => '', log: () => {}, stageProgress: () => ({}), telemetry: { on: () => false }, gameClock: { now: () => 0 },
    strategyExecuting: false, manualControl: false, died: false, only: null, refresh: async () => {}, sense: async () => {}, readMemory: async () => {} }
  vm.runInNewContext(transformSync(declarationsOf(read('campaign/loop/stage.ts'), 'loopStage') + ';this.run=loopStage', { loader: 'ts' }).code, context)
  await context.run(loop, { name: 'cast', pauseKey: 'LavaPoolPortal', run: async () => {}, needed: () => true, interrupted: () => true }, 1)
  assert.deepEqual(calls, ['LavaPoolPortal'])
})
function idle(enabled = true, night = false, threat = 0) {
  const calls: string[] = [], clock = { now: () => 0 }
  const state: any = { health: 20, tactics: { threatLevel: threat }, pos: { x: 0, y: 64, z: 0 } }
  const need = [ { name: 'food', defer: () => true, ready: () => true }, { name: 'cast', defer: () => false, ready: () => true } ]
  const loop: any = { fails: new Map([['cast', { owPause: true, observed: 'water', until: Infinity }]]), failureKey: n => n,
    cooling: s => s.name === 'cast', resetPauses: () => calls.push('reset') }
  const context: any = { process: { env: { ND_OW_PAUSE_CAUSE: enabled ? '1' : '0' } }, state, sit: { night, surface: true }, died: false,
    only: null, known: {}, setStage: () => {}, dim: () => 'overworld', STAGES: [], OTHER_WORLD: new Set(),
    continueFortressChoice: async () => false, log: () => {}, NIGHT_DOWN2: () => false, gameClock: clock,
    nightGuard: async () => calls.push('nightGuard'), leaveWater: async () => calls.push('shore'),
    act: async (name: string) => { calls.push(name); return { status: 'done' } },
    walkAway: async () => { calls.push('walkAway'); state.pos.x += 64 }, toSurface: async () => calls.push('toSurface'),
    refresh: async () => calls.push('refresh'), sense: async () => calls.push('sense'), readMemory: async () => calls.push('memory') }
  vm.runInNewContext(transformSync(declarationsOf(read('campaign/loop/idle.ts'), 'loopIdle') + ';this.run=loopIdle', { loader: 'ts' }).code, context)
  return { calls, state, context, run: () => context.run(loop, need, 0) }
}
test('F daytime deferred food plus paused cast walks to a new view, with fresh situation and no blanket reset/wait', async () => {
  const f = idle(); await f.run(); assert.ok(f.calls.includes('walkAway')); assert.ok(f.calls.includes('sense')); assert.ok(f.calls.includes('memory'))
  assert.equal(f.calls.includes('wait'), false); assert.equal(f.calls.includes('reset'), false)
})
test('F control and real tactical ownership retain their existing safety behavior', async () => {
  const off = idle(false); await off.run(); assert.ok(off.calls.includes('wait')); assert.equal(off.calls.includes('walkAway'), false)
  const threat = idle(true, false, 2); await threat.run(); assert.equal(threat.calls.includes('walkAway'), false)
  const night = idle(true, true); await night.run(); assert.equal(night.calls.includes('walkAway'), false)
})
test('F failed relocation cannot spin or wait for minutes at the same cause; the full circle reopens stages instead of quitting', async () => {
  const f = idle(); f.context.walkAway = async () => f.calls.push('noPath')
  for (let i = 0; i < 6; i++) assert.equal(await f.run(), 'continue')
  assert.equal(await f.run(), 'continue'); assert.equal(f.calls.filter(x => x === 'noPath').length, 6)
  assert.ok(f.calls.includes('reset'))
  assert.equal(f.calls.includes('wait'), false)
})

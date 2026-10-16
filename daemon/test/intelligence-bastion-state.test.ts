const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { withClockFixture } = require('./clock-fixture')

function campaignFixture(interrupted = false, conversion = true, goldLeft = 17, endermen = '1') {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 87, y: 35, z: 139 },
    armor: { feet: 'golden_boots' }, potions: {} as Record<string, number>, inventory: { stone_pickaxe: 2, iron_pickaxe: 1, cooked_beef: 12,
      crafting_table: 1, oak_planks: 16, stick: 8, cobblestone: 64 } as Record<string, number> }
  const calls: string[] = []
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  class Socket {
    listeners = new Map<string, (...args: unknown[]) => void>()
    on(name: string, handler: (...args: unknown[]) => void) { this.listeners.set(name, handler) }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw)
      calls.push(method)
      requests.push({ method, params })
      if (method === 'craft' && params.item === 'gold_ingot' && conversion) {
        state.inventory.gold_ingot = state.inventory.gold_block * 9
        delete state.inventory.gold_block
      }
      const detail = method === 'recall' ? { state: { places: {
        'бастион (ад)': { x: 87, y: 35, z: 139, dimension: 'the_nether', gold: [[87,35,139]] },
        'бастион 2 (ад)': { x: 545, y: 48, z: -99, dimension: 'the_nether', gold: [[545,48,-99]],
          chests: [[550,43,-97]], starts: [{ type: 'hoglin_stable', rotation: 0 }] },
        'выработан: бастион (ад)': { x: 93, y: 39, z: 128, dimension: 'the_nether', note: 'Бартер завершён: золото выработано или два сухих захода подряд' }
      } } } : method === 'bastion'
        ? interrupted ? {} : { goldBlocksDug: 0, ingotsTraded: 0, knownGoldLeft: goldLeft, stopped: 'время вышло' }
        : method === 'situation' ? { surface: false, foes: 0, pickLeft: 512 } : {}
      const cut = method === 'bastion' && interrupted
      queueMicrotask(() => this.listeners.get('message')!(JSON.stringify({ id, ok: true, result: { status: cut ? 'interrupted' : 'done',
        ...(cut ? { code: 'TACTICAL', by: { type: 'tactical' }, error: 'reflex: действие прервано' } : {}), detail, state, events: [] } })))
    }
    close() {}
  }
  const filename = path.resolve(__dirname, '../campaign.js')
  const local = createRequire(filename)
  const context = { require: (name: string) => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync() {} } : local(name),
    __dirname: path.dirname(filename), module: { exports: {} as Record<string, any> },
    process: { argv: ['node', 'campaign.js'], env: { ND_NE_RECOVER: '0', ND_NE_ROUTE: '1', ND_NE_STAY: '1', ND_GOLD_FAST_SAFE: '1', ND_GOLD_ROUTE: '1', ND_ENDERMEN: endermen } }, // прежний путь (J2 сам включает ND_NE_RECOVER)
    console: { log() {}, error() {} }, setTimeout, Date, queueMicrotask, AbortController, fixtureState: state }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
    state = fixtureState; sit = { surface: false, foes: 0, pickLeft: 512 };
    recoverGuard = async () => {};
    known.portal = { x: 1, y: 64, z: 1 };
    known.bastions = [{ key: 'бастион (ад)', x: 87, y: 35, z: 139, gold: [[87,35,139]] }];
    module.exports = { run: () => stageRun('bastion')(), next: nextBastion, endermen: () => STAGES.find(s => s.name === 'pearls').needed(),
      execute: skill => executeStrategy({ skill, params: {} }, new AbortController().signal), recall: readMemory,
      observation: intelligenceObservation, nether: () => stageRun('nether')(), fact: graphFact, pearlGoal: eyesWant,
      spent: () => { for (const b of known.bastions) bState(b).spent = true } };
    module.exports.blockSupply = () => { sit.pickLeft = 0; replenishNetherSupply = async () => ({ ready: false, interrupted: false, reason: 'visible wood unavailable' }) };
    module.exports.deferBarter = () => { bState(known.bastions[0]).barterUntil = gameClock.now() + 60000 };
    module.exports.deferMining = () => { for (const b of known.bastions) deferBastionMining(b) };
    module.exports.active = () => activeBastion();
  `, withClockFixture(context))
  return { context, state, calls, requests }
}

test('two dry approaches preserve mapped gold while hunting remains available by price', async () => {
  const { context, calls } = campaignFixture()
  await context.module.exports.run()
  await context.module.exports.run()
  assert.equal(context.module.exports.next()?.key, 'бастион (ад)')
  assert.equal(context.module.exports.endermen(), true)
  assert.equal(calls.includes('remember'), false)
})

test('an unsuccessful tool refill cannot launch real bastion excavation or exhaust mapped gold', async () => {
  const { context, state, requests } = campaignFixture()
  delete state.inventory.oak_planks
  delete state.inventory.crafting_table
  delete state.inventory.iron_pickaxe
  delete state.inventory.stone_pickaxe
  context.module.exports.blockSupply()
  await context.module.exports.run()
  assert.equal(requests.filter(request => request.method === 'bastion').length, 0)
  assert.equal(context.module.exports.next()?.key, 'бастион (ад)')
  assert.equal(requests.some(request => request.method === 'remember'), false)
  state.inventory.gold_ingot = 62
  await context.module.exports.run()
  assert.equal(requests.find(request => request.method === 'bastion')?.params.mode, 'barter')
})

test('the actual campaign loop respects failed graph verification when incidental blocks increase', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../campaign.js'), 'utf8')
  const start = source.indexOf('      const progressed =')
  const end = source.indexOf('\n', start)
  assert.ok(start >= 0 && end > start)
  const check = (s: { progressed?: () => boolean }, before: Record<string, number>, after: Record<string, number>) =>
    vm.runInNewContext(source.slice(start, end) + '\nprogressed', { s, before, after })
  assert.equal(check({ progressed: () => false }, { blocks: 64 }, { blocks: 128 }), false,
    'native tunnel netherrack cannot turn a failed Bastion skill into a useful partial stage or reset its watchdog')
  assert.equal(check({ progressed: () => true }, {}, {}), true, 'verified movement or handoff progress survives a constant inventory')
  assert.equal(check({}, { iron: 1 }, { iron: 3 }), true, 'explicit legacy stages retain their resource progress policy')
})

test('an unreachable graph cannot send the body home for rods while factual Bastion pearls are still pending', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../campaign.js'), 'utf8')
  const start = source.indexOf("      if (!selection && dim() === \"the_nether\"")
  assert.ok(start >= 0)
  const end = source.indexOf('{', start)
  const guard = source.slice(start, end) + '{ result = true }'
  const returnsHome = (pending: boolean) => {
    const context = { selection: null, dim: () => 'the_nether', bastionPearlsPending: () => pending,
      need: [{ name: 'nether' }, { name: 'bastion' }], READY: { nether: () => false }, fightGearWanted: false,
      fightReady: () => false, result: false, gameClock: { now: () => 0 }, homeForGearAfter: -Infinity, homeForGearState: null, netherRetryState: () => "same" }
    vm.runInNewContext(guard, context)
    return context.result
  }
  assert.equal(returnsHome(true), false, 'unfinished mapped Bastions and missing pearls retain their resource phase')
  assert.equal(returnsHome(false), true, 'after actual pearl completion, missing blaze gear can still trigger the return')
})

test('two completed dry mining attempts defer mapped B1 for another known Bastion without claiming exhaustion or skipping carried-gold barter', async () => {
  const { context, state, calls, requests } = campaignFixture()
  await context.module.exports.recall()
  await context.module.exports.run()
  assert.equal(context.module.exports.next().key, 'бастион (ад)', 'one failure retains the same target')
  await context.module.exports.run()
  assert.equal(context.module.exports.next().key, 'бастион 2 (ад)', 'the untouched alternative becomes executable')
  assert.equal(context.module.exports.endermen(), false)
  assert.equal(calls.includes('remember'), false, 'remaining mapped gold is not falsely persisted as spent')
  assert.deepEqual(requests.filter(request => request.method === 'bastion').map(request => request.params.x), [87, 87])
  state.inventory.gold_ingot = 36
  await context.module.exports.observation()
  assert.equal(context.module.exports.next().key, 'бастион (ад)', 'actual carried gold retains the nearby protected trader priority')
})

test('one to three remaining mapped gold blocks cannot be reported exhausted', async () => {
  for (const goldLeft of [1, 2, 3]) {
    const { context, calls } = campaignFixture(false, true, goldLeft)
    await context.module.exports.run()
    await context.module.exports.run()
    assert.equal(context.module.exports.next()?.key, 'бастион (ад)')
    assert.equal(context.module.exports.endermen(), true)
    assert.equal(calls.includes('remember'), false)
  }
})

test('an interrupted Bastion RPC without detail cannot change exhaustion or remember a dry result', async () => {
  const { context, calls } = campaignFixture(true)
  const initial = context.module.exports.next()
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await context.module.exports.execute('bastion')
    assert.equal(result.outcome, 'INTERRUPTED')
    assert.equal(context.module.exports.next().key, initial.key)
  }
  assert.equal(context.module.exports.endermen(), true)
  assert.equal(calls.filter(method => method === 'bastion').length, 3)
  assert.equal(calls.includes('remember'), false)
})

test('the strategic Piglin barter converts carried gold blocks and verifies ingots before handing them over', async () => {
  for (const conversion of [true, false]) {
    const { context, state, calls, requests } = campaignFixture(false, conversion)
    state.inventory.gold_block = 9
    const result = await context.module.exports.execute('piglinBarter')
    assert.equal(result.outcome, conversion ? 'SUCCESS' : 'FAILURE')
    assert.equal(calls.includes('bastion'), conversion)
    if (conversion) {
      assert.equal(state.inventory.gold_ingot, 81)
      assert.ok(calls.indexOf('craft') < calls.indexOf('bastion'))
      const params = requests.find(request => request.method === 'bastion')!.params
      assert.deepEqual([params.x, params.y, params.z], [87, 35, 139])
      assert.equal(params.mode, 'barter')
      assert.equal(params.sealed, true)
    }
  }
})

test('ambiguous persisted dry checkpoints do not exhaust the first or untouched second mapped Bastion', async () => {
  const { context } = campaignFixture()
  await context.module.exports.recall()
  assert.equal(context.module.exports.next().key, 'бастион (ад)')
  assert.equal(context.module.exports.endermen(), false)
})

test('the barter adapter binds to the nearest observed Bastion instead of the first journal place', async () => {
  const { context, state, requests } = campaignFixture()
  await context.module.exports.recall()
  state.pos = { x: 545, y: 48, z: -99 }
  state.inventory.gold_ingot = 36
  await context.module.exports.execute('piglinBarter')
  const params = requests.find(request => request.method === 'bastion')!.params
  assert.deepEqual([params.x, params.y, params.z], [545, 48, -99])
  assert.equal(JSON.stringify(params.knownChests), JSON.stringify([[550,43,-97]]))
  assert.equal(JSON.stringify(params.starts), JSON.stringify([{ type: 'hoglin_stable', rotation: 0 }]))
  assert.equal(params.timeoutSeconds, 540, 'construction gets time inside the existing 600-second director watchdog')
})

test('141 carried ingots continue bounded protected barter at the current Bastion before a distant untouched Bastion', async () => {
  const { context, state, requests } = campaignFixture()
  await context.module.exports.recall()
  state.pos = { x: 102, y: 62, z: 134 }
  state.inventory.gold_ingot = 141
  context.module.exports.deferBarter()
  assert.equal(context.module.exports.next().key, 'бастион (ад)')
  await context.module.exports.run()
  const params = requests.find(request => request.method === 'bastion')!.params
  assert.deepEqual([params.x, params.y, params.z], [87, 35, 139])
  assert.equal(params.mode, 'barter')
  assert.equal(params.timeoutSeconds, 540)
  assert.equal(requests.some(request => request.method === 'remember'), false, 'a dry barter cannot exhaust mapped native gold')
})

test('one fire-resistance potion cannot send the graph or legacy body to rods before pearls and carried gold are settled', async () => {
  const { context, state, calls } = campaignFixture()
  state.potions.fire_resistance = 1
  state.inventory.gold_ingot = 44
  state.inventory.gold_block = 2
  let observation = await context.module.exports.observation()
  assert.equal(observation.facts.blaze_allowed.value, false)
  await context.module.exports.nether()
  assert.equal(calls.includes('fortress'), false)
  assert.equal(calls.includes('blaze'), false)
  context.module.exports.spent()
  observation = await context.module.exports.observation()
  assert.equal(observation.facts.blaze_allowed.value, false, '62 carried ingots still have to be offered to a real trader')
  state.inventory.ender_pearl = context.module.exports.pearlGoal()
  observation = await context.module.exports.observation()
  assert.equal(observation.facts.blaze_allowed.value, true, 'actual pearl goal and FR permit the fortress stage')
})

test('a deferred Bastion no longer holds rods and endermen behind the pearl gate', async () => {
  const { context, state } = campaignFixture()
  state.potions.fire_resistance = 1
  let observation = await context.module.exports.observation()
  assert.equal(observation.facts.bastions_exhausted.value, false)
  context.module.exports.deferMining()
  assert.equal(context.module.exports.active(), null)
  assert.ok(context.module.exports.next(), 'nextBastion still offers a deferred site when nothing else is left')
  observation = await context.module.exports.observation()
  assert.equal(observation.facts.bastions_exhausted.value, true)
  assert.equal(observation.facts.blaze_allowed.value, true)
})

test('fire resistance with nothing left to trade opens rods before the pearl goal; carried gold still trades first', async () => {
  const { context, state } = campaignFixture()
  let observation = await context.module.exports.observation()
  assert.equal(observation.facts.blaze_allowed.value, false, 'active Bastion, nothing to trade, no FR: its gold is the cheaper next step')
  state.potions.fire_resistance = 2
  observation = await context.module.exports.observation()
  assert.equal(observation.facts.blaze_allowed.value, true, 'active Bastion, 0 gold, FR in the bag')
  state.inventory.gold_ingot = 8
  observation = await context.module.exports.observation()
  assert.equal(observation.facts.blaze_allowed.value, false)
})

test('two carried barters without a single ingot exhaust barter and defer the Bastion', async () => {
  const { context, state } = campaignFixture()
  await context.module.exports.recall()
  state.pos = { x: 102, y: 62, z: 134 }
  state.inventory.gold_ingot = 58
  await context.module.exports.run()
  let observation = await context.module.exports.observation()
  assert.equal(observation.facts.barter_exhausted.value, false)
  await context.module.exports.run()
  observation = await context.module.exports.observation()
  assert.equal(observation.facts.barter_exhausted.value, true)
  assert.equal(context.module.exports.active().key, 'бастион 2 (ад)', 'the barren Bastion waits; the next mapped one is still work')
  assert.equal(observation.facts.bastions_exhausted.value, false)
})


test('pearl stage ignores the old flag, incomplete rods and still available mapped gold', () => {
  const { context, state } = campaignFixture(false, true, 17, '0')
  assert.equal(state.inventory.blaze_rod || 0, 0)
  assert.ok(context.module.exports.next())
  assert.equal(context.module.exports.endermen(), true)
})

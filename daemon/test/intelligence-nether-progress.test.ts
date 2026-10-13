const test = require('node:test')
const assert = require('node:assert/strict')
const { deathFreeEnd, netherGoalMet, netherPass, bastionMetrics, explicitBarterMetrics, deliveredBarterReceipts, netherStageProgress, netherSupplyProgress } = require('../src/campaign/nether-progress')
const { emptyWorld, fact } = require('../src/core/world-state')

test('Nether completion fails when death arrives in the same observation as End entry', () => {
  assert.equal(deathFreeEnd({ reachedEnd: true, health: 20, deaths: 0 }), true)
  assert.equal(deathFreeEnd({ reachedEnd: true, health: 20, deaths: 1 }), false)
  assert.equal(deathFreeEnd({ reachedEnd: true, health: 0, deaths: 0 }), false)
  assert.equal(deathFreeEnd({ reachedEnd: false, health: 20, deaths: 0 }), false)
})

test('Bastion telemetry reads quantities followed by punctuation', () => {
  const metrics = bastionMetrics('бастион (ад): золотых блоков 16, слитков пиглинам 109, в рюкзаке {}\nбастион 2 (ад): золотых блоков 4, слитков пиглинам 36 — готово')
  assert.equal(metrics.reduce((sum, row) => sum + row.ingots, 0), 145)
  assert.equal(metrics[0].blocks, 16)
})

test('explicit Piglin metrics count server inventory gold spent once, excluding legacy mining, death, and invented throw counts', () => {
  const row = { level: 'act', skill: 'bastion', status: 'done', run: 'real-run', seq: 42, death: false,
    params: JSON.stringify({ mode: 'barter', x: 87, z: 139 }),
    before: { dim: 'the_nether', hp: 20, res: { gold: 72, goldBlocks: 2 } },
    after: { dim: 'the_nether', hp: 20, res: { gold: 44, goldBlocks: 2 } } }
  const metrics = explicitBarterMetrics([row, row, { ...row, seq: 43, death: true },
    { ...row, seq: 44, params: JSON.stringify({ mode: 'auto' }) },
    { ...row, seq: 45, handed: 999, after: row.before }])
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0].ingots, 28)
  assert.equal(metrics[0].key, 'PiglinBarter@87,139')
})

test('an interrupted inventory observation cannot turn disappearing gold into confirmed barter', () => {
  const before = { dim: 'the_nether', hp: 20, res: { gold: 69, goldBlocks: 8 } }
  const partial = { dim: 'the_nether', hp: 20, res: { gold: 7, goldBlocks: 8 } }
  const complete = { dim: 'the_nether', hp: 20, res: { gold: 141, goldBlocks: 0 } }
  const row = { level: 'act', skill: 'bastion', run: 'native-full12', seq: 90, death: false,
    params: JSON.stringify({ mode: 'barter', x: 87, z: 139 }), status: 'interrupted', before, after: partial }
  assert.deepEqual(explicitBarterMetrics([row, { ...row, seq: 91, status: 'done', before: partial, after: complete }]), [])
})

test('structured barter mode survives a truncated known-gold parameter log without counting mining or partial snapshots', () => {
  const row = { level: 'act', skill: 'bastion', status: 'done', death: false, run: 'native15', seq: 39,
    params: '{"x":87,"knownGold":[[87,35,139],[88', barterMode: 'barter', barterSite: { x: 87, z: 139 },
    before: { dim: 'the_nether', hp: 20, res: { gold: 141 } }, after: { dim: 'the_nether', hp: 20, res: { gold: 121 } } }
  const rows = explicitBarterMetrics([row, row, { ...row, seq: 40, status: 'interrupted' },
    { ...row, seq: 41, barterMode: 'auto' }, { ...row, seq: 42, after: row.before }])
  assert.deepEqual(rows, [{ key: 'PiglinBarter@87,139', blocks: 0, ingots: 20 }])
})

test('barter proof needs actual delivered piglin loot packets rather than spent gold or guessed tosses', () => {
  const row = { level: 'act', skill: 'bastion', status: 'done', death: false, run: 'native', seq: 4,
    ingotsTraded: 141, tossed: 12, barterReceipts: 4 }
  assert.equal(deliveredBarterReceipts([row]), 0, 'gold left on the floor and undelivered drops do not pass')
  const received = { ...row, barterDelivered: 4 }
  assert.equal(deliveredBarterReceipts([received, received, { ...received, seq: 5, status: 'interrupted' }]), 4)
  assert.equal(deliveredBarterReceipts([{ ...received, death: true }]), 0)
})

test('Nether stage progress verifies its resources, barter receipts, or distance to the same mapped destination', () => {
  const before = emptyWorld()
  before.dimension = 'the_nether'
  before.position = { x: 0, y: 64, z: 0 }
  before.facts.bastion_position = fact({ x: 100, y: 64, z: 0 }, 'map', 0)
  const after = structuredClone(before)
  after.resources.blocks = 10
  assert.equal(netherStageProgress('bastion', before, after), false)
  after.position.x = 9
  assert.equal(netherStageProgress('bastion', before, after), true)
  after.position.x = 0
  after.facts.bastion_traded = fact(8, 'observed', 1)
  assert.equal(netherStageProgress('bastion', before, after), true)
  assert.equal(netherStageProgress('nether', before, after), false)
  after.resources.rods = 1
  assert.equal(netherStageProgress('nether', before, after), true)
})

test('fortress exploration advances the strategy graph only with new Nether observation stops', () => {
  const before = emptyWorld()
  before.dimension = 'the_nether'
  before.facts.fortress_explored = fact(4, 'observed', 0)
  const after = structuredClone(before)
  after.facts.fortress_explored = fact(5, 'observed', 1)
  assert.equal(netherStageProgress('nether', before, after), true)
  assert.equal(netherStageProgress('bastion', before, after), false)
  after.facts.fortress_explored.value = 4
  assert.equal(netherStageProgress('nether', before, after), false, 'the same visited stops do not postpone failure handling')
  after.facts.fortress_explored.value = 5
  after.dimension = 'overworld'
  assert.equal(netherStageProgress('nether', before, after), false)
})

test('Nether supply progress rejects incidental tunnel blocks and verifies only missing usable supplies', () => {
  const before = emptyWorld()
  before.inventory = { oak_planks: 6, crafting_table: 1, stick: 3, blackstone: 64 }
  before.facts.nether_pick_swings = fact(438, 'observed', 0)
  before.facts.nether_tools_ready = fact(false, 'observed', 0)
  const after = structuredClone(before)
  after.inventory.netherrack = 128
  after.inventory.blackstone++
  after.resources.blocks = 129
  after.health = 20
  after.position = { x: 100, y: 64, z: 0 }
  assert.equal(netherSupplyProgress(before, after), false)
  after.inventory.crimson_stem = 1
  assert.equal(netherSupplyProgress(before, after), true)
  delete after.inventory.crimson_stem
  before.facts.nether_pick_swings = fact(100, 'observed', 0)
  after.facts.nether_pick_swings = fact(250, 'observed', 1)
  assert.equal(netherSupplyProgress(before, after), true)
})

test('Nether PASS needs pearls and powder for every eye in the bag, alive and back in the Overworld', () => {
  const bag = { ender_pearl: 8, ender_eye: 2, blaze_rod: 4 }
  assert.equal(netherGoalMet(bag, 10), true) // 8+2 pearls, 2*4+2 powder
  assert.equal(netherGoalMet({ ...bag, blaze_rod: 3 }, 10), false) // 6+2 powder < 10
  assert.equal(netherGoalMet({ ...bag, blaze_rod: 3, blaze_powder: 2 }, 10), true)
  assert.equal(netherGoalMet({ ...bag, ender_pearl: 7 }, 10), false)
  const ok = { dimension: 'overworld', health: 12, deaths: 0, inventory: bag, eyesNeed: 10 }
  assert.equal(netherPass(ok), true)
  assert.equal(netherPass({ ...ok, dimension: 'the_nether' }), false)
  assert.equal(netherPass({ ...ok, deaths: 1 }), false)
  assert.equal(netherPass({ ...ok, health: 0 }), false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { campaignVm } from './campaign-source'

function fixture({ fast = true, portal = false, lava = true, hp = 20, hunger = 20, mode = 'speedrun' } = {}) {
  const calls: string[] = []
  const ctx = campaignVm(`
    state = testState; sit = {surface: true, night: false, foes: 0};
    if (testLava) { known.lava = {x: 20, y: 68, z: 0}; lavaSourceKnown = true }
    if (testPortal) known.portal = {x: 2, y: 68, z: 0};
    sense = refresh = readMemory = nightGuard = async () => {};
    act = async (method, params) => { testCalls.push(method); return {status:'done', detail:{went: method === 'portal'}} };
    cook = async () => { testCalls.push('cook') };
    makeBed = async () => { testCalls.push('makeBed') };
    foodRun = async () => { testCalls.push('foodRun') };
    craft = async () => { testCalls.push('craft'); return true };
    quickHunt = async () => { testCalls.push('quickHunt') };
    module.exports = { READY, food: STAGES.find(s => s.name === 'food'), prep: STAGES.find(s => s.name === 'prep'), enterNether, loopChores, wood: STAGES.find(s => s.name === 'wood') };
  `, { env: { ND_OW_FAST: fast ? '1' : '0', ND_NETHER_COOK: '1', ND_STRUCT_LOOT:'0' }, globals: {
    testCalls: calls, testPortal: portal, testLava: lava,
    testState: { health: hp, food: hunger, playPolicy: { mode }, dimension: 'overworld',
      pos: {x:0,y:68,z:0}, inventory: {stone_pickaxe:1, flint_and_steel:1, water_bucket:1, iron_ingot:1, beef:1, oak_log:2}, armor:{} }
  } })
  return { ...ctx.module.exports, calls }
}

test('O known nearby surface lava: kit precedes reserve food while hunger already covers existing iron readiness', () => {
  assert.equal(fixture().food.defer(), true)
  assert.equal(fixture({fast:false}).food.defer(), false)
  assert.equal(fixture({lava:false}).food.defer(), false)
  assert.equal(fixture({hunger:10}).food.defer(), false)
  assert.equal(fixture({hp:5,hunger:10}).food.defer(), false)
  assert.equal(fixture({hp:1,hunger:20}).food.defer(), false)
  assert.equal(fixture({mode:'casual'}).food.defer(), false)
})

test('O fast portal readiness removes six-meal gate but preserves ordinary and urgent recovery', () => {
  assert.equal(fixture({portal:true}).READY.nether(), true)
  assert.equal(fixture({portal:true,fast:false}).READY.nether(), false)
  assert.equal(fixture({portal:true,hp:5,hunger:10}).READY.nether(), false)
  assert.equal(fixture({portal:true,hp:1,hunger:20}).READY.nether(), false)
})

test('O after cast prep does not hunt, cook, make bed, shield or refresh wood', async () => {
  const f = fixture({portal:true})
  await f.prep.run()
  assert.deepEqual(f.calls, [])
  assert.equal(f.wood.needed(), false)
})

test('O fast enter goes through portal before optional cooking and equipment', async () => {
  const f = fixture({portal:true})
  await f.enterNether()
  assert.deepEqual(f.calls, ['portal'])
})

test('O flag OFF retains optional cooking/equipment', async () => {
  const f = fixture({portal:true,fast:false})
  await f.enterNether()
  assert.ok(f.calls.includes('cook'))
})

test('O loop chores leave reserve hunting until after the kit/cast', async () => {
  const f = fixture()
  await f.loopChores({cooling:()=>false} as any)
  assert.deepEqual(f.calls, [])
})

test('O actual graph prices direct entry without banning food or healing', async () => {
  const { createCampaignIntelligence } = require('../src/campaign/intelligence')
  const fact = {status:'known', value:true, source:'observed', at:0, confidence:1}
  const intelligence = createCampaignIntelligence({eyes:10, beds:7, now:()=>0,
    observe:async()=>({state:{dimension:'overworld',health:20,food:20,inventory:{stone_pickaxe:1}},
      facts:{portal:fact,nether_ready:fact}}), call:async()=>({}),sleep:async()=>{},record:()=>{},
    execute:async()=>({outcome:'SUCCESS',events:[]})})
  const selection = await intelligence.select([],()=>false)
  assert.equal(selection?.strategy?.id, 'EnterNether')
  assert.ok(intelligence.registry.get('FindFood'))
  assert.ok(intelligence.registry.get('Heal'))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { speedrunRegistry } from '../src/core/speedrun'
import { emptyWorld, fact, knows } from '../src/core/world-state'
import { plan } from '../src/core/strategy'
import { runDeepLava, deepLavaPrice, lavaSearchSeconds } from '../src/campaign/deep-lava'

function kit(y = 16) {
  const s = emptyWorld(); s.dimension = 'overworld'; s.position = { x: 0, y, z: 0 }
  s.resources = { bucket: 1, water: 1, lighter: 1, stone_tool: 1, food: 8 }
  s.inventory = { stone_pickaxe: 1, water_bucket: 1, flint_and_steel: 1, oak_log: 4, crafting_table: 1, cooked_beef: 8 }
  s.facts.lava = fact(null, 'observed', 0, 0)
  return s
}
test('P flag is opt-in; a kit with no visible lava gets an executable deep alternative', () => {
  assert.equal(speedrunRegistry().get('DeepLavaPortal'), undefined)
  const deep = speedrunRegistry({ deepLava: true }).get('DeepLavaPortal')
  assert.ok(deep, 'DeepLavaPortal is missing')
  assert.equal(deep.preconditions(kit()), true)
  assert.equal(deep.command(kit()).skill, 'deepLavaCast')
})
test('P graph chooses by price: fresh surface leg, then deep after empty searches; visible lava stays cast', () => {
  const registry = speedrunRegistry({ deepLava: true }), s = kit()
  assert.equal(plan(registry, s, q => knows(q, 'portal')).steps[0]?.id, 'ScoutLava')
  s.facts.lava_empty_searches = fact(8, 'observed', 0)
  assert.equal(plan(registry, s, q => knows(q, 'portal')).steps[0]?.id, 'DeepLavaPortal')
  s.facts.lava = fact(true, 'observed', 0)
  s.facts.lava_position = fact({ x: 2, y: 16, z: 0 }, 'observed', 0)
  assert.equal(plan(registry, s, q => knows(q, 'portal')).steps[0]?.id, 'LavaPoolPortal')
})
test('P deep route requires real tools/igniter; empty bucket pays for local water, no seed or elapsed trigger', () => {
  const deep = speedrunRegistry({ deepLava: true }).get('DeepLavaPortal')
  assert.ok(deep, 'DeepLavaPortal is missing')
  for (const key of ['bucket', 'lighter', 'stone_tool']) {
    const s = kit(); s.resources[key] = 0; assert.equal(deep.preconditions(s), false, key)
  }
  const empty = kit(); empty.resources.water = 0
  assert.equal(deep.preconditions(empty), true)
  assert.ok(deep.estimateCost(empty) > deep.estimateCost(kit()))
  const s = kit(); s.elapsedMs = 40 * 60000
  assert.equal(deep.estimateCost(s), deep.estimateCost(kit()))
  assert.equal(deep.successCondition(kit(), kit(-54)), false)
})

function stand(options: any = {}) {
  let time = 0, at = { x: 0, y: 16, z: 0 }, portal = false, stopped = false, water = options.water !== false
  const calls = [], prepared = []
  const port = {
    now: () => time, stopped: () => stopped, position: () => ({ ...at }), portal: () => portal, water: () => water,
    prepare: async n => { prepared.push(n) }, hear: true,
    act: async (method, params) => {
      calls.push({ method, params, at: { ...at }, time }); time += 1000
      if (options.interrupt === method) { stopped = true; return { status: 'interrupted' } }
      if (method === 'observe') return { status: 'done', detail: { blocks: options.lava?.(at) || [] } }
      if (method === 'portal') return { status: 'done', detail: { heard: options.heard ? [options.heard] : [] } }
      if (method === 'bucket' && options.fillWater) water = true
      if (options.blocked && /dig_down|tunnel/.test(method)) return { status: 'done', detail: { stopped: options.blocked } }
      if (method === 'dig_down') at = { ...at, y: at.y - params.depth, x: at.x + params.depth }
      if (method === 'tunnel') at = { ...at, z: at.z + params.length }
      if (method === 'goto' && !options.gotoBlocked) at = { x: params.x, y: params.y, z: params.z }
      return { status: 'done' }
    },
    cast: async params => {
      calls.push({ method: 'cast', params, at: { ...at }, time }); time += 1000
      if (options.castFail) return { status: 'done', detail: { stopped: options.castFail } }
      if (options.castNeed) return { status: 'done', detail: { need: options.castNeed } }
      portal = true; return { status: 'done' }
    }
  }
  return { port, calls, prepared, at: () => at, time: () => time }
}
const visible = at => [{ name: 'lava', nearest: { x: at.x + 2, y: at.y - 1, z: at.z }, remembered: false }]
test('P staircase sees mid-depth cave before -54; no shaft or imagined sound target', async () => {
  const s = stand({ lava: at => at.y <= -24 ? visible(at) : [] })
  assert.equal(await runDeepLava(s.port, 600), 'портал подтверждён')
  assert.ok(s.at().y > -54)
  const stairs = s.calls.filter(c => c.method === 'dig_down')
  assert.equal(stairs.length, 5)
  assert.ok(stairs.every(c => c.params.mode === 'stairs' && c.params.depth <= 8 && c.params.maxFallHp === 0 && c.params.nightWork === true))
  assert.equal(s.calls.filter(c => c.method === 'cast').length, 1)
  assert.equal(s.calls.find(c => c.method === 'cast').params.maxDig, 80)
})
test('P sound uses only a direction, remembered/hidden lava never authorizes cast or exact goto', async () => {
  const s = stand({ heard: { dir: 'west', below: true, height: -13, flat: 3, dist: 14 },
    lava: () => [{ name: 'lava', nearest: { x: 2, y: -29, z: 2 }, remembered: true }] })
  await runDeepLava(s.port, 50)
  assert.ok(s.calls.some(c => c.method === 'dig_down' && c.params.direction === 'west'))
  assert.equal(s.calls.filter(c => ['goto', 'cast'].includes(c.method)).length, 0)
  assert.ok(s.at().y >= -54)
  assert.ok(s.calls.filter(c => c.method === 'tunnel').every(c => c.params.direction !== 'down'))
})
for (const method of ['observe', 'portal', 'dig_down']) test(`P interruption at ${method} ends the route`, async () => {
  const s = stand({ interrupt: method })
  assert.equal(await runDeepLava(s.port, 600), 'прервано')
  assert.equal(s.calls.at(-1).method, method)
})
test('P stalled stairs do not repeat indefinitely; NIGHT_RISK still stops immediately', async () => {
  const s = stand({ blocked: 'вода у 1,2,3' })
  assert.match(await runDeepLava(s.port, 600), /две проходки/)
  assert.equal(s.calls.filter(c => c.method === 'dig_down').length, 2)
  const risky = stand({ blocked: 'NIGHT_RISK: темно' })
  assert.match(await runDeepLava(risky.port, 600), /NIGHT_RISK/)
  assert.equal(risky.calls.filter(c => c.method === 'dig_down').length, 1)
  const ore = stand({ blocked: 'для deepslate_gold_ore нужна кирка получше' })
  await runDeepLava(ore.port, 600)
  const attempts = ore.calls.filter(c => c.method === 'dig_down')
  assert.equal(attempts.length, 2)
  assert.notEqual(attempts[0].params.direction, attempts[1].params.direction)
})
test('P every RPC fits remaining game budget; no descent or cast after expiration', async () => {
  const s = stand()
  await runDeepLava(s.port, 3)
  assert.ok(s.calls.every(c => c.params.timeoutSeconds <= (3000 - c.time) / 1000))
  assert.equal(s.time(), 3000)
  assert.equal(s.calls.length, 3)
})
test('P unchanged failed shore is cast once; item need returns to the planner', async () => {
  const fixed = [{ name: 'lava', nearest: { x: 1, y: 16, z: 0 } }]
  const s = stand({ lava: () => fixed, castFail: 'места на берегу нет' })
  await runDeepLava(s.port, 30)
  assert.equal(s.calls.filter(c => c.method === 'cast').length, 1)
  const need = stand({ lava: visible, castNeed: { what: 'water_bucket', count: 1 } })
  assert.match(await runDeepLava(need.port, 600), /water_bucket/)
  assert.equal(need.calls.filter(c => c.method === 'dig_down').length, 0)
})
test('P price counts three cells per stair and local empty-search receipts; no dry aquifer promise', () => {
  const s = kit(), p = deepLavaPrice(s)
  assert.equal(p.depth, 70)
  assert.ok(Math.abs(p.dig - 215.1) < 1e-8)
  assert.equal(p.swings, 348)
  const iron = kit(); iron.resources.iron_pick = 1; delete iron.inventory.stone_pickaxe
  assert.ok(deepLavaPrice(iron).seconds < p.seconds)
  const hungry = kit(); hungry.health = 6
  const d = speedrunRegistry({ deepLava: true }).get('DeepLavaPortal')
  assert.ok(d.estimateRisk(hungry) > d.estimateRisk(s))
  assert.equal(lavaSearchSeconds(s), 120)
  s.facts.lava_empty_searches = fact(5, 'observed', 0)
  assert.equal(lavaSearchSeconds(s), 420)
})
test('P empty bucket can collect visible nearby aquifer water before casting; unsuccessful fill never invents water', async () => {
  const blocks = at => [...visible(at), { name: 'water', nearest: { x: at.x + 2, y: at.y, z: at.z } }]
  const s = stand({ water: false, fillWater: true, lava: blocks })
  assert.equal(await runDeepLava(s.port, 600), 'портал подтверждён')
  assert.ok(s.calls.findIndex(c => c.method === 'bucket') < s.calls.findIndex(c => c.method === 'cast'))
  const failed = stand({ water: false, lava: blocks })
  await runDeepLava(failed.port, 15)
  assert.equal(failed.calls.filter(c => c.method === 'cast').length, 0)
  assert.ok(failed.calls.some(c => c.method === 'portal' && c.params.fluid === 'water'))
})
test('P actual campaign selector executes deep even when legacy cast is deferred', async () => {
  const previous = process.env.ND_OW_DEEP_LAVA
  process.env.ND_OW_DEEP_LAVA = '1'
  try {
    const { createCampaignIntelligence } = require('../src/campaign/intelligence') as typeof import('../src/campaign/intelligence')
    const s = kit(); let ran = false
    const observation: any = { state: { dimension: 'overworld', pos: s.position, health: 20, food: 20, inventory: s.inventory },
      facts: { lava_empty_searches: fact(20, 'observed', 0) } }
    const i = createCampaignIntelligence({ eyes: 12, beds: 5, now: () => 0, sleep: async () => {}, record: () => {},
      observe: async () => observation, call: async () => ({}), execute: async command => {
        assert.equal(command.skill, 'deepLavaCast'); ran = true
        observation.facts.portal = fact(true, 'observed', 0)
        return { outcome: 'SUCCESS', events: [] }
      } })
    const select = await i.select([{ name: 'cast', needed: () => true, ready: () => true, defer: () => true, done: () => false, run: async () => assert.fail('legacy cast invoked') }], () => false)
    assert.equal(select?.strategy?.id, 'DeepLavaPortal')
    await select.stage.run()
    assert.equal(ran, true)
  } finally { if (previous === undefined) delete process.env.ND_OW_DEEP_LAVA; else process.env.ND_OW_DEEP_LAVA = previous }
})
test('ND_OW_DEEP_SHAFT: shaft down to -54, stalled shaft takes one stair leg aside, then shaft again', async () => {
  process.env.ND_OW_DEEP_SHAFT = '1'
  try {
    let time = 0, at = { x: 0, y: 16, z: 0 }, portal = false, shafts = 0
    const calls = []
    const port = {
      now: () => time, stopped: () => false, position: () => ({ ...at }), portal: () => portal, water: () => true,
      prepare: async () => {}, hear: false,
      act: async (method, params) => {
        calls.push(method); time += 1000
        if (method === 'observe') return { status: 'done', detail: { blocks: at.y <= -54 ? visible(at) : [] } }
        if (method === 'tunnel' && params.direction === 'down') {
          shafts++
          if (shafts === 1) at = { ...at, y: at.y - 20 }
          if (shafts >= 3) at = { ...at, y: -54 }
          return { status: 'done', detail: { stopped: shafts === 2 ? 'вода сбоку — не копаю' : undefined } }
        }
        if (method === 'dig_down') at = { ...at, y: at.y - params.depth, x: at.x + params.depth }
        if (method === 'goto') at = { x: params.x, y: params.y, z: params.z }
        return { status: 'done' }
      },
      cast: async () => { calls.push('cast'); time += 1000; portal = true; return { status: 'done' } }
    }
    assert.equal(await runDeepLava(port, 600), 'портал подтверждён')
    assert.equal(shafts, 3)
    assert.equal(calls.filter(c => c === 'dig_down').length, 1)
    assert.ok(deepLavaPrice(kit(63)).seconds < (delete process.env.ND_OW_DEEP_SHAFT, deepLavaPrice(kit(63)).seconds))
  } finally { delete process.env.ND_OW_DEEP_SHAFT }
})

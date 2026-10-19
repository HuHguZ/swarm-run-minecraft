import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { cjsContext } from './cjs-context'

const source = readFileSync(join(__dirname, '../arena/arms-run.js'), 'utf8')
const body = source.slice(source.indexOf('class ArmsEnv {'), source.indexOf('async function brain('))
import * as AG from '../src/pvp/arms-graph'
const key = p => `${p.x},${p.y},${p.z}`
const pos = x => ({ x, y: 0, z: 0 })
function fixture({ reply = { status: 'failed', error: 'noPath' }, inventory = {}, items = [], storage = Array(36).fill(null), chests = [pos(1), pos(8)] }: any = {}) {
  let now = 0; let position = pos(0); let players = []
  const calls: any[] = []; const watches: any[] = []
  const seen = new Map(chests.map(p => [key(p), { ...p, id: key(p), seenAt: 0, seenFrom: pos(0), opened: false, looted: false, contents: null, taken: 0, attempt: null }]))
  const side: any = { t0: 0, foe: 'Foe', stats: { chests: 0, firstWeapon: null, firstArmor: null },
    know: { revision: 0, foe: null, areas: [], scouted: new Set(), chests: seen, caches: new Map() },
    director: { interrupt: reason => calls.push({ method: 'interrupt', reason }) },
    async call(method, params) {
      calls.push({ method, params })
      if (method === 'status') return { state: { pos: position, health: 20, food: 20, inventory }, detail: { items, storage } }
      if (method === 'players') return { detail: { players } }
      if (method === 'blocks_around') return { detail: { found: chests } }
      if (method === 'armor' || method === 'stop') return { status: 'done' }
      if (method === 'chest_take') { now += 500; return typeof reply === 'function' ? reply(params) : reply }
      throw new Error(`unexpected RPC ${method}`)
    }
  }
  const { emptyWorld, fact }: typeof import('../src/core/world-state') = require('../src/core/world-state')
  const layout = { half: 30, spawns: [pos(0)] }
  for (const field of ['chests', 'g', 'secret']) Object.defineProperty(layout, field, { get() { throw new Error('hidden layout ' + field) } })
  const context = { AG, get Loot() { return (require('../src/pvp/arms-loot') as typeof import('../src/pvp/arms-loot')) }, LOOT_PRIOR: [[{ name: 'iron_sword' }]],
    emptyWorld, fact, LOOT_MS: 60000, X: 0, Y: 0, Z: 0, L: layout, W: p => p, COVERS: [], key,
    every: (_ms, fn) => { watches.push(fn); return fn }, gameClock: { now: () => now, clearInterval() {} } }
  const ArmsEnv = runInNewContext(body + '\nArmsEnv', cjsContext(context))
  const env = new ArmsEnv(side, { over: false, roundScope: 'r1' })
  return { env, side, calls, watches, seen, now: () => now,
    command: (id = '8,0,0', roundScope = 'r1') => ({ skill: 'arms.loot', strategy: 'LootChest', params: { chestId: id, roundScope, quoteAt: now } }),
    run: (id = '8,0,0', roundScope = 'r1') => env.execute({ skill: 'arms.loot', params: { chestId: id, roundScope, quoteAt: now } }, new AbortController().signal),
    setPosition: p => { position = p }, setInventory: value => { inventory = value }, setStorage: value => { storage = value },
    setPlayers: value => { players = value }, setTime: value => { now = value } }
}

test('LootChest executes the selected id, even when another known chest is nearer', async () => {
  const f = fixture()
  await f.run('8,0,0')
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(c => c.method === 'chest_take').params)), { item: 'all', x: 8, y: 0, z: 0 })
})

test('two failed approaches abandon the attempt without claiming loot; another chest stays available', async () => {
  const f = fixture()
  for (let n = 0; n < 2; n++) assert.equal((await f.run('1,0,0')).outcome, 'FAILURE')
  const chest: any = f.seen.get('1,0,0')
  assert.equal(chest.looted, false); assert.equal(chest.opened, false)
  assert.equal(chest.attempt.abandoned, true); assert.equal(f.side.stats.chests, 0)
  await f.env.look()
  assert.equal(chest.attempt.abandoned, true, 'seeing the same chest again is not evidence that the approach changed')
  assert.equal((f.seen.get('8,0,0') as any).looted, false)
})

test('stale scope or missing target makes no chest_take call and never selects a replacement', async () => {
  for (const [id, scope] of [['8,0,0', 'old-round'], ['9,0,0', 'r1'], [undefined, 'r1']]) {
    const f = fixture()
    const r = await f.env.execute({ skill: 'arms.loot', params: { chestId: id, roundScope: scope } }, new AbortController().signal)
    assert.equal(r.outcome, 'FAILURE')
    assert.equal(f.calls.filter(c => c.method === 'chest_take').length, 0)
  }
})

test('a receipt for a different position cannot prove transfer or an empty selected chest', async () => {
  const f = fixture({ reply: { status: 'done', detail: { at: pos(1), took: { iron_sword: 1 }, contents: {} } } })
  assert.equal((await f.run()).outcome, 'FAILURE')
  assert.equal(f.side.stats.chests, 0)
  assert.equal((f.seen.get('8,0,0') as any).opened, false)
})

test('full-inventory done is partial new knowledge, then failure without new movement or knowledge', async () => {
  const f = fixture({ reply: { status: 'done', detail: { at: pos(8), took: {}, contents: { iron_sword: 1 }, left: { iron_sword: 'full' }, stopped: 'inventory full' } } })
  assert.equal((await f.run()).outcome, 'PARTIAL')
  assert.equal((await f.run()).outcome, 'FAILURE')
  const c: any = f.seen.get('8,0,0')
  assert.equal(c.opened, true); assert.equal(c.looted, false); assert.equal(c.taken, 0)
  assert.equal(f.side.stats.chests, 0)
})

test('first empty observation is partial knowledge and not a looted-chest score', async () => {
  const f = fixture({ reply: { status: 'done', detail: { at: pos(8), took: {}, contents: {} } } })
  assert.equal((await f.run()).outcome, 'PARTIAL')
  assert.equal((f.seen.get('8,0,0') as any).looted, true)
  assert.equal(f.side.stats.chests, 0)
})

test('interrupted partial transfer retains actual contents and moved items without success', async () => {
  const f = fixture({ reply: { status: 'interrupted', detail: { at: pos(8), took: { arrow: 4 }, contents: { arrow: 8 } } } })
  assert.equal((await f.run()).outcome, 'INTERRUPTED')
  const c: any = f.seen.get('8,0,0')
  assert.equal(c.taken, 4); assert.equal(c.opened, true); assert.equal(c.looted, false)
  assert.equal(f.side.stats.chests, 0)
})

test('confirmed food transfer survives auto-consumption, while unrelated inventory delta proves nothing', async () => {
  const f = fixture({ reply: { status: 'done', detail: { at: pos(8), took: { bread: 2 }, contents: {} } } })
  assert.equal((await f.run()).outcome, 'SUCCESS')
  assert.equal((f.seen.get('8,0,0') as any).taken, 2)
  assert.equal(f.side.stats.chests, 1)
  const pickup = fixture({ reply: { status: 'failed', error: 'noPath' } })
  pickup.setInventory({ diamond_sword: 1 })
  assert.equal((await pickup.run()).outcome, 'FAILURE')
  assert.equal(pickup.side.stats.chests, 0)
})

test('observe quotes actual candidates, then graph command executes the valued chest without a nearest substitution', async () => {
  const f = fixture({ items: [{ name: 'bow' }] })
  Object.assign(f.seen.get('1,0,0'), { opened: true, contents: [{ name: 'bow' }] })
  Object.assign(f.seen.get('8,0,0'), { opened: true, contents: [{ name: 'arrow', count: 12 }] })
  f.setTime(70000)
  const before = await f.env.observe()
  assert.equal(before.facts.loot_target_id.value, '8,0,0')
  assert.equal(before.facts.deadline.value, true)
  assert.equal(before.facts.loot_target_pos.source, 'observed')
  assert(before.facts.loot_cost_ticks.value >= 200)
  assert(before.facts.loot_gain.value > 0)
  assert.equal(before.facts.loot_forecast, undefined)
  const loot = AG.armsRegistry().get('LootChest')
  assert.equal(loot.preconditions(before), true)
  await f.env.execute(loot.command(before), new AbortController().signal)
  assert.equal(f.calls.find(c => c.method === 'chest_take').params.x, 8)
})

test('abandoning a chest changes the next selected id but creates no loot progress or success', async () => {
  const f = fixture()
  const before = await f.env.observe()
  for (let n = 0; n < 2; n++) await f.run('1,0,0')
  const after = await f.env.observe()
  assert.equal(after.facts.loot_target_id.value, '8,0,0')
  assert.equal(after.resources.loot_completed, 0)
  assert.equal(after.resources.loot_progress, 0)
  assert.equal(AG.armsRegistry().get('LootChest').successCondition(before, after), false)
  f.setPosition(pos(4)); await f.env.look()
  assert.equal((f.seen.get('1,0,0') as any).attempt, null, 'a newly observed approach permits a new bounded attempt')
})

test('last visible foe observations are copied and hidden packets never update the position or its age', async () => {
  const f = fixture(), at = pos(11)
  f.setPlayers([{ name: 'Foe', canSee: true, at, dist: 11, gear: [] }])
  await f.env.foe(); at.x = 99
  assert.equal(f.side.know.foe.pos.x, 11)
  f.setTime(500)
  f.setPlayers([{ name: 'Foe', canSee: true, at: pos(10), dist: 10, gear: [] }])
  await f.env.foe()
  assert.equal(f.side.know.foe.previous.pos.x, 11)
  const hidden = { name: 'Foe', canSee: false }
  Object.defineProperty(hidden, 'at', { get() { throw new Error('hidden packet position') } })
  f.setPlayers([hidden]); f.setTime(1500)
  await f.env.observe()
  assert.equal(f.side.know.foe.pos.x, 10); assert.equal(f.side.know.foe.at, 500)
})

test('priced loot watcher keeps a valuable nearby transfer at distance 11 but interrupts a worse immediate threat', async () => {
  for (const distance of [11, 0]) {
    let f: any
    f = fixture({ reply: async () => {
      f.setPosition(pos(7)); f.setTime(60000)
      f.setPlayers([{ name: 'Foe', canSee: true, at: pos(7 + distance), dist: distance, gear: ['iron_sword'] }])
      await f.watches[0]()
      return { status: 'done', detail: { at: pos(8), took: { iron_sword: 1 }, contents: {} } }
    } })
    await f.env.observe()
    await f.run()
    const interrupts = f.calls.filter(c => c.method === 'interrupt')
    assert.equal(interrupts.length, distance === 0 ? 1 : 0)
    const comparison = f.side.know.lootWatch
    assert(comparison.continueTicks > 0, 'elapsed time never makes an unconfirmed interaction free')
    assert.equal(comparison.travelTicks, 0, 'the completed approach is not paid twice')
    assert.equal(comparison.chestId, '8,0,0')
    assert.equal(comparison.interrupted, distance === 0)
  }
})

test('only own completed movement receipts become directed route history; matched opening records interaction time', async () => {
  let f: any
  f = fixture({ reply: () => {
    f.setPosition(pos(7))
    return { status: 'done', detail: { at: pos(8), took: { iron_sword: 1 }, contents: {} } }
  } })
  await f.run()
  const route = f.side.know.traversals[0]
  assert.equal(route.completed, true); assert.equal(route.from.x, 0); assert.equal(route.to.x, 7)
  assert.equal(route.ticks, 10)
  assert.equal(f.side.know.lootInteractions?.length || 0, 0, 'moving plus opening is not a pure interaction receipt')
  const close = fixture({ chests: [pos(1)], reply: { status: 'done', detail: { at: pos(1), took: { iron_sword: 1 }, contents: {} } } })
  await close.run('1,0,0')
  assert.equal(close.side.know.lootInteractions[0].ticks, 10)
  const failed = fixture()
  await failed.run()
  assert.equal(failed.side.know.traversals[0].completed, false)
})

test('a stopped watcher cannot interrupt a later action when its pending observation returns', async () => {
  let f: any, pending: Promise<void>, release: (reply: any) => void, started: () => void
  const queried = new Promise<void>(resolve => { started = resolve })
  f = fixture({ chests: [pos(1)], reply: async () => {
    pending = f.watches[0]()
    await queried
    return { status: 'failed', error: 'noPath' }
  } })
  const call = f.side.call.bind(f.side)
  f.side.call = (method, params) => method === 'players' ? new Promise(resolve => { release = resolve; started() }) : call(method, params)
  await f.run('1,0,0')
  release({ detail: { players: [{ name: 'Foe', canSee: true, at: pos(0), dist: 0, gear: ['diamond_sword'] }] } })
  await pending
  assert.equal(f.calls.filter(c => c.method === 'interrupt').length, 0)
  const before = f.calls.length
  await f.watches[0]()
  assert.equal(f.calls.length, before)
})

test('cancellation during the route-start observation prevents a late chest_take action', async () => {
  const f = fixture(), ctl = new AbortController(), call = f.side.call.bind(f.side)
  let positions = 0
  f.side.call = async (method, params) => {
    const result = await call(method, params)
    if (method === 'status' && ++positions === 2) ctl.abort('new decision')
    return result
  }
  const result = await f.env.execute(f.command(), ctl.signal)
  assert.equal(result.outcome, 'INTERRUPTED')
  assert.equal(f.calls.filter(c => c.method === 'chest_take').length, 0)
})

test('confirmed loot stays SUCCESS when the watcher polls during post-receipt armor', async () => {
  const { StrategicDirector }: typeof import('../src/core/strategy') = require('../src/core/strategy')
  const items = []
  let f: any
  f = fixture({ items, chests: [pos(8)], reply: async () => {
    await f.watches[0]()
    items.push({ name: 'iron_sword', count: 1 })
    f.setInventory({ iron_sword: 1 })
    return { status: 'done', detail: { at: pos(8), took: { iron_sword: 1 }, contents: {} } }
  } })
  f.setPosition(pos(7)); f.setTime(1000)
  f.setPlayers([{ name: 'Foe', canSee: true, at: pos(18), dist: 11, gear: ['iron_sword'] }])
  const call = f.side.call.bind(f.side)
  f.side.call = async (method, params) => {
    if (method === 'armor') await f.watches[0]()
    return call(method, params)
  }
  const registry = AG.armsRegistry()
  f.side.director = new StrategicDirector(registry, f.env, { goal: AG.opponentDefeated })
  const result = await f.side.director.run(registry.get('LootChest'), await f.env.observe())
  assert.equal(f.side.know.lastLoot.outcome, 'SUCCESS', 'actual receipt emptied the chosen chest')
  assert.equal(result.outcome, 'SUCCESS', 'post-transfer observation must not interrupt completed loot')
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 0)
})

test('a worse threat before the receipt still interrupts actual LootChest director execution', async () => {
  const { StrategicDirector }: typeof import('../src/core/strategy') = require('../src/core/strategy')
  let f: any
  f = fixture({ chests: [pos(8)], reply: async () => {
    await f.watches[0]()
    return { status: 'interrupted', detail: { at: pos(8), took: { arrow: 4 }, contents: { arrow: 8 } } }
  } })
  f.setPosition(pos(7)); f.setTime(1000)
  f.setPlayers([{ name: 'Foe', canSee: true, at: pos(7), dist: 0, gear: ['iron_sword'] }])
  const registry = AG.armsRegistry()
  f.side.director = new StrategicDirector(registry, f.env, { goal: AG.opponentDefeated })
  const result = await f.side.director.run(registry.get('LootChest'), await f.env.observe())
  assert.equal(result.outcome, 'INTERRUPTED')
  assert.ok(f.calls.some(c => c.method === 'stop'))
  assert.equal(f.side.know.lastLoot.receipt.interrupted, true)
  assert.equal(f.side.know.lastLoot.receipt.emptied, false)
  assert.equal(f.seen.get('8,0,0').taken, 4)
})

test('an in-flight loot observation cannot interrupt after its chest receipt settles', async () => {
  const { StrategicDirector }: typeof import('../src/core/strategy') = require('../src/core/strategy')
  let f: any, pending: Promise<void>, release: (reply: any) => void, started: () => void
  let delayPlayers = false
  const queried = new Promise<void>(resolve => { started = resolve })
  f = fixture({ chests: [pos(8)], reply: async () => {
    delayPlayers = true
    pending = f.watches[0]()
    await queried
    return { status: 'done', detail: { at: pos(8), took: { iron_sword: 1 }, contents: {} } }
  } })
  f.setPosition(pos(7)); f.setTime(1000)
  const call = f.side.call.bind(f.side)
  f.side.call = async (method, params) => {
    if (method === 'players' && delayPlayers) return new Promise(resolve => { release = resolve; started() })
    if (method === 'armor') {
      delayPlayers = false
      release({ detail: { players: [{ name: 'Foe', canSee: true, at: pos(7), dist: 0, gear: ['iron_sword'] }] } })
      await pending
    }
    return call(method, params)
  }
  const registry = AG.armsRegistry()
  f.side.director = new StrategicDirector(registry, f.env, { goal: AG.opponentDefeated })
  const result = await f.side.director.run(registry.get('LootChest'), await f.env.observe())
  assert.equal(f.side.know.lastLoot.outcome, 'SUCCESS')
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 0)
})

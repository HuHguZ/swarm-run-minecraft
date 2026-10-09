import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
const { StrategicDirector } = require('../src/core/strategy')
const { emptyWorld, fact, cloneWorld } = require('../src/core/world-state')
const AG = require('../src/pvp/arms-graph'), Loot = require('../src/pvp/arms-loot')
const source = readFileSync(join(__dirname, '../arms-run.js'), 'utf8')
const body = source.slice(source.indexOf('class ArmsEnv {'), source.indexOf('async function brain('))
const pos = x => ({ x, y: 0, z: 0 }), key = p => `${p.x},${p.y},${p.z}`
const rewards = [{ name: 'diamond_sword', count: 1 }, { name: 'diamond_chestplate', count: 1 }]
function fixture() {
  let now = 1000, health = 20, food = 20, position = pos(0), items: any[] = [], foePosition = pos(40), fights = 0
  let inventory: Record<string, number> = {}, estimate = { lo: 20, hi: 20, mean: 20, conf: 1 }
  const calls: any[] = [], watches: any[] = [], sleeps: number[] = []
  const chest: any = { ...pos(1), id: key(pos(1)), seenAt: 0, seenFrom: pos(0), opened: true, looted: false, contents: rewards, taken: 0, attempt: null }
  const round = { over: false, roundScope: 'r1', winner: null }
  const side: any = { t0: 0, foe: 'Foe', spawn: { x: -10 }, stats: { chests: 0, firstWeapon: null, firstArmor: null, engages: 0, fights: 0, fightEvents: [], fightWhy: {}, powerAtEngage: null },
    know: { revision: 0, foe: null, areas: [], scouted: new Set(), chests: new Map([[chest.id, chest]]), caches: new Map() } }
  let onFight = async (_params) => ({ status: 'done', detail: { swings: 0, landed: 0 } })
  let fightError: any = null
  side.call = async (method, params) => {
    calls.push({ method, params })
    if (method === 'status') return { state: { pos: position, health, food, inventory }, detail: { items, storage: [...items, ...Array(36 - items.length).fill(null)], foeEstimate: estimate } }
    if (method === 'players') return { detail: { players: [{ name: 'Foe', canSee: true, at: foePosition, dist: Math.abs(foePosition.x - position.x), gear: ['iron_sword'] }] } }
    if (method === 'blocks_around') return { detail: { found: [pos(1)] } }
    if (method === 'armor' || method === 'stop') return { status: 'done' }
    if (method === 'fight') { fights++; try { return await onFight(params) } catch (error) { fightError = error; throw error } }
    if (method === 'fight_yield') return { status: 'done', detail: { accepted: true, receivedAt: now } }
    if (method === 'chest_take') {
      assert.equal(params.x, 1); now += 700
      items = rewards.map(i => ({ ...i })); inventory = Object.fromEntries(items.map(i => [i.name, i.count]))
      return { status: 'done', detail: { at: pos(1), took: inventory, contents: {} } }
    }
    throw new Error('unexpected RPC ' + method)
  }
  const ArmsEnv = runInNewContext(body + '\nArmsEnv', { AG, Loot, LOOT_PRIOR: [rewards], emptyWorld, fact, LOOT_MS: 60000,
    X: 0, Y: 0, Z: 0, L: { half: 30, spawns: [pos(0)] }, W: p => p, COVERS: [], HUNT: [pos(0)], key,
    sleep: async ms => { sleeps.push(ms); now += ms }, pace: async ms => { now += ms },
    every: (ms, fn) => { const w = { ms, fn, active: true }; watches.push(w); return w }, gameClock: { now: () => now, clearInterval: w => { w.active = false } } })
  const env = new ArmsEnv(side, round)
  side.director = new StrategicDirector(AG.armsRegistry(), env, { goal: AG.opponentDefeated, riskPenalty: AG.ARMS_RISK_PENALTY, maxFailures: 2 })
  const request = () => calls.filter(c => c.method === 'fight_yield' && c.params.request).at(-1)?.params
  return { env, side, round, chest, calls, watches, sleeps, request, now: () => now, fights: () => fights,
    async watch() { const w = [...watches].reverse().find(w => w.ms === 500 && w.active); assert(w, 'Engage needs its cooperative observation watcher'); await w.fn() },
    yieldReply: () => { const p = request(); assert(p, 'priced preparation should request a cooperative return'); return { status: 'done', detail: { stopped: 'strategic preparation', swings: 1, landed: 1,
      strategicYield: { ...p.request, receivedAt: now, returnedAt: now } } } },
    onFight: fn => { onFight = fn }, setHealth: n => { health = n }, setFood: n => { food = n }, setFoe: p => { foePosition = p },
    setItems: value => { items = value; inventory = Object.fromEntries(items.map(i => [i.name, i.count ?? 1])) },
    setEstimate: value => { estimate = value }, advance: ms => { now += ms },
    engage: async () => { const result = await side.director.run(side.director.registry.get('Engage')); if (fightError) throw fightError; return result } }
}

test('director bounded comparison reuses penalties and leaves ordinary full planning unchanged', () => {
  const records = [], s = emptyWorld()
  s.resources = { power: 1, unscouted: 1, chests: 0 }
  s.facts.enemy_power = fact(20, 'observed', 0); s.facts.loot_prior_gain = fact(20, 'inferred', 0)
  const env = { now: () => 0 }, d = new StrategicDirector(AG.armsRegistry(), env, { goal: AG.opponentDefeated, riskPenalty: 6000, record: x => records.push(x) })
  assert.equal(d.decide(s).steps[0].id, 'ScoutArea')
  const count = records.length
  assert.deepEqual(d.decide(s, undefined, { maxDepth: 1, record: false }).steps.map(x => x.id), ['Engage'])
  assert.equal(records.length, count)
  assert.equal(d.decide(s).steps[0].id, 'ScoutArea')
})

test('actual ArmsEnv yields for its priced chest, consumes its receipt, and resumes the same HP scope', async () => {
  const f = fixture()
  f.onFight(async params => {
    assert.equal(params.allowStrategicYield, true); assert.equal(params.roundScope, 'r1')
    if (f.fights() === 1) {
      f.setEstimate({ lo: 8, hi: 12, mean: 10, conf: 0.8 })
      await f.watch()
      const q = f.request(); assert.equal(q.request.preparation, 'LootChest')
      assert(q.request.after < q.request.before); assert.equal(q.fightId, params.fightId)
      return f.yieldReply()
    }
    await f.watch()
    return { status: 'done', detail: { swings: 1, landed: 1 } }
  })
  const first = await f.engage()
  assert.equal(first.outcome, 'PARTIAL'); assert.equal(first.result.detail.strategicYield.preparation, 'LootChest')
  assert.equal(f.sleeps.length, 0, 'verified strategic return is not an instant-fight failure')
  const next = await f.env.observe(), selected = f.side.director.decide(next)
  assert.equal(selected.steps[0].id, 'LootChest')
  const taken = await f.side.director.run(selected.steps[0], next)
  assert.equal(taken.outcome, 'SUCCESS'); assert.equal(f.side.know.lastLoot.chestId, f.chest.id)
  assert.equal(f.side.know.lastLoot.receipt.moved.diamond_sword, 1)
  const strengthened = await f.env.observe(); assert(strengthened.resources.power > next.resources.power)
  assert.equal(strengthened.facts.enemy_hp_mean.value, 10)
  await f.engage()
  const fights = f.calls.filter(c => c.method === 'fight')
  assert.notEqual(fights[0].params.fightId, fights[1].params.fightId)
  assert(f.calls.filter(c => c.method === 'status' && c.params?.foeEstimate).every(c => c.params.foeEstimate.roundScope === 'r1'))
  assert.equal(f.calls.filter(c => c.method === 'stop').length, 0)
})

test('empty/abandoned loot and physically impossible recovery do not request yield', async () => {
  for (const abandoned of [false, true]) {
    const f = fixture(); f.setHealth(3); f.setFood(10)
    if (abandoned) f.chest.attempt = { abandoned: true }
    else f.chest.contents = []
    f.onFight(async () => { await f.watch(); return { status: 'done', detail: {} } })
    await f.engage()
    assert.equal(f.request(), undefined)
  }
})

test('price change during a fight revokes pending preparation without a distance gate', async () => {
  const f = fixture()
  f.onFight(async () => {
    await f.watch(); assert(f.request())
    f.chest.attempt = { spentTicks: 20000, failures: 1, abandoned: false }
    f.advance(500); await f.watch()
    const last = f.calls.filter(c => c.method === 'fight_yield').at(-1)
    assert.equal(last.params.request, null)
    return { status: 'done', detail: {} }
  })
  await f.engage()
})

test('returning straight to Engage cannot repeatedly yield on unchanged evidence or time alone', async () => {
  const f = fixture()
  f.onFight(async () => {
    await f.watch()
    return f.fights() === 1 ? f.yieldReply() : { status: 'done', detail: {} }
  })
  await f.engage()
  const before = f.calls.filter(c => c.method === 'fight_yield' && c.params.request).length
  f.advance(10000); await f.engage()
  assert.equal(f.calls.filter(c => c.method === 'fight_yield' && c.params.request).length, before)
})

test('late observation after a settled fight cannot send yield into the next action', async () => {
  const f = fixture(), original = f.side.call.bind(f.side)
  let pending, release, queried
  const ready = new Promise(resolve => { queried = resolve })
  f.onFight(async () => {
    f.side.call = (method, params) => method === 'status' && params?.foeEstimate ? new Promise(resolve => { release = () => resolve(original(method, params)); queried() }) : original(method, params)
    try { pending = f.watch(); await Promise.race([ready, pending]) }
    finally { f.side.call = original }
    return { status: 'done', detail: {} }
  })
  await f.engage(); release(); await pending
  assert.equal(f.request(), undefined)
})

test('existing failure penalties and exhaustion still govern the fight preparation comparison', async () => {
  const f = fixture(), state = await f.env.observe(), loot = f.side.director.registry.get('LootChest')
  const initial = f.env.preparation(state)
  assert.equal(initial.preparation, 'LootChest')
  f.side.director.verify(loot, state, cloneWorld(state), { outcome: 'FAILURE', events: [] })
  const penalized = f.side.director.decide(state, new Set(['LootChest', 'Recover', 'Engage']), { maxDepth: 2, record: false })
  assert(penalized.cost > initial.after)
  f.side.director.verify(loot, state, cloneWorld(state), { outcome: 'FAILURE', events: [] })
  assert(f.side.director.exhaustedStrategies().includes('LootChest'))
  assert.equal(f.env.preparation(state), null)
})

test('Recover with actual food can beat continued combat, while no-food recovery stays unavailable', async () => {
  const f = fixture(); f.chest.contents = []; f.setHealth(3); f.setFood(10)
  f.setItems([{ name: 'iron_sword', count: 1 }, { name: 'enchanted_golden_apple', count: 1 }])
  f.onFight(async () => {
    await f.watch()
    assert.equal(f.request().request.preparation, 'Recover')
    return f.yieldReply()
  })
  const r = await f.engage()
  assert.equal(r.result.detail.strategicYield.preparation, 'Recover')
  assert.equal(f.side.director.decide(await f.env.observe()).steps[0].id, 'Recover')
})

test('visible foe approach raises the same quote price and can restore Engage', async () => {
  const f = fixture(), safe = await f.env.observe(), safeQuote = f.side.know.lootQuote
  assert.equal(f.env.preparation(safe).preparation, 'LootChest')
  f.setFoe(pos(1)); f.advance(500)
  const threatened = await f.env.observe(), unsafeQuote = f.side.know.lootQuote
  assert(unsafeQuote.costTicks === safeQuote.costTicks && unsafeQuote.totalWithFight > safeQuote.totalWithFight)
  assert.equal(f.env.preparation(threatened), null)
})

test('round replacement during a pending observation cannot alter new knowledge or send old requests', async () => {
  const f = fixture(), original = f.side.call.bind(f.side)
  let pending, release, queried
  const ready = new Promise(resolve => { queried = resolve })
  const replacement = { sentinel: true }
  f.onFight(async () => {
    f.side.call = (method, params) => method === 'players' ? new Promise(resolve => { release = () => resolve(original(method, params)); queried() }) : original(method, params)
    try { pending = f.watch(); await Promise.race([ready, pending]) }
    finally { f.side.call = original }
    f.round.over = true; f.side.know = replacement
    release(); await pending
    assert.deepEqual(replacement, { sentinel: true })
    return { status: 'done', detail: {} }
  })
  // Only execute the old action: a real replaced round never calls its director again.
  await f.env.observe()
  await f.env.execute({ skill: 'arms.engage' }, new AbortController().signal)
  assert.equal(f.request(), undefined)
  assert.deepEqual(replacement, { sentinel: true })
})

test('a forecast or wrong-scope quote cannot request an unobserved preparation target', async () => {
  for (const missing of ['loot_target_id', 'loot_round_scope']) {
    const f = fixture(), state = await f.env.observe()
    delete state.facts[missing]
    state.facts.loot_forecast = fact(true, 'inferred', 1000)
    assert.equal(f.env.preparation(state), null)
  }
  const f = fixture(), state = await f.env.observe()
  f.side.know.lootQuote.roundScope = 'old-round'
  assert.equal(f.env.preparation(state), null)
})

test('an unissued strategic-return receipt retains the instant-failure pause and cannot block future preparation', async () => {
  const f = fixture()
  f.onFight(async () => ({ status: 'done', detail: { strategicYield: { requestId: 'old', preparation: 'LootChest', quoteEvidence: 'old' } } }))
  const r = await f.engage()
  assert.equal(r.result.detail.strategicYield, undefined)
  assert.deepEqual(f.sleeps, [1000])
  assert.equal(f.side.know.strategicReturn, undefined)
})

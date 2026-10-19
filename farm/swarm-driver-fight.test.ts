// Драйвер роя: бой и бегство — сближение и удар, дальний бой с высоты, паника, последний бой, ветер в паре, ротация линии, прерванный бой, погоня.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'

test('a fresh committed fight approaches the observed opponent and attacks on the next reported contact', async () => {
  const priorNow = Date.now; let now = priorNow()
  Date.now = () => now
  const calls = [], armor = { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' }
  const bots = Array.from({ length: 20 }, (_, i) => ({ name: 'Ally' + String(i).padStart(2, '0'), team: 'blue', c: null }))
  const pos = Object.fromEntries(bots.map((b, i) => [b.name, { p: { x: 0, y: 64, z: i / 10 }, hp: 20, inv: { iron_sword: 1 }, armor }]))
  for (const b of bots) b.c = { async call(method, params) {
    calls.push({ method, params })
    if (method === 'goto') pos[b.name].p = { x: params.x - params.range, y: params.y, z: params.z }
    return { detail: {} }
  } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 15, y: 64, z: 0, r: 100 }, home: () => ({ x: 0, y: 64, z: 0 }), hostile: (_, id) => id === 'Foe', log: () => {} })
  const seen = { id: 'Foe', visible: true, position: { x: 35, y: 64, z: 0 }, equipment: { weapon: 'iron_sword', armor: Object.values(armor) } }
  try {
    for (const b of bots) driver.observe(b, [seen])
    await driver.turn(bots[0])
    const task = driver.snapshot().blue.tasks.find(t => t.assignedTo === bots[0].name)
    assert.equal(task.kind, 'fight'); assert.equal(task.data.committed, true)
    assert.equal(driver.panic(bots[0]), false)
    assert.equal(calls.at(-1).method, 'goto')
    assert.equal(calls.at(-1).params.x, seen.position.x, 'approach the public opponent rather than converge on the own-centre formation')
    now += 600
    for (const b of bots) driver.observe(b, [seen])
    await driver.turn(bots[0])
    assert.equal(calls.at(-1).method, 'fight', 'fresh reported contact must reach the native fight RPC')
    assert.equal(calls.at(-1).params.target, 'Foe')
  } finally { Date.now = priorNow }
})
test('a fresh long-range fight keeps a witnessed ranged high-ground position', async () => {
  const calls = [], roof = { x: 0, y: 76, z: 0 }
  const friends = ['B', 'C', 'D'].map(name => ({ name, team: 'blue', c: { async call() { return {} } } }))
  const bot = { name: 'A', team: 'blue', swarmPosition: { purpose: 'ranged', at: roof }, c: { async call(method, params) { calls.push({ method, params }); return {} } } }
  const armor = { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' }
  const pos = Object.fromEntries([...friends.map(b => [b.name, { p: roof, hp: 20, inv: { iron_sword: 1 }, armor }]), ['A', { p: roof, hp: 20, inv: { bow: 1, arrow: 64 }, armor }]])
  const driver = createSwarmDriver({ bots: [bot, ...friends], pos, alive: () => true, arena: { x: 15, y: 64, z: 0, r: 100 }, home: () => roof, hostile: () => true, log: () => {} })
  for (const b of [bot, ...friends]) driver.observe(b, [{ id: 'Foe', visible: true, position: { x: 25, y: 64, z: 0 }, equipment: { weapon: 'iron_sword' }, threat: 'melee' }])
  await driver.turn(bot)
  assert.equal(driver.snapshot().blue.tasks.find(t => t.assignedTo === 'A').kind, 'fight')
  assert.equal(calls.some(c => c.method === 'goto'), false, 'do not abandon the already observed roof for a distant melee opponent')
  assert.equal(calls.at(-1).method, 'fight')
  assert.deepEqual(pos.A.p, roof)
})
test('independent allied reports share one planning cycle while a new danger still triggers immediate panic', async () => {
  const { SwarmBoard }: typeof import('../daemon/src/swarm') = require('../daemon/src/swarm')
  const priorUpsert = SwarmBoard.prototype.upsert, priorNow = Date.now
  let now = priorNow(), plans = 0
  Date.now = () => now
  SwarmBoard.prototype.upsert = function (task) { if (task.id.startsWith('pvp:')) plans++; return priorUpsert.call(this, task) }
  const bots = Array.from({ length: 20 }, (_, k) => ({ name: 'A' + k, team: 'blue', c: { async call() { return { detail: {} } } } }))
  const pos = Object.fromEntries(bots.map((b, k) => [b.name, { p: { x: k / 10, y: 64, z: 0 }, hp: 20, inv: { netherite_sword: 1 }, armor: { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' } }]))
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 }, home: b => pos[b.name].p, hostile: () => true, log: () => {} })
  try {
    for (const b of bots) { driver.observe(b, []); await driver.turn(b); now += 20 }
    assert.equal(plans, 20, 'twenty independently arriving reports must not recompute the full twenty-member plan twenty times')
    now += 500
    driver.observe(bots[0], []); await driver.turn(bots[0])
    assert.equal(plans, 40, 'the next planning interval must incorporate current allied reports')
    for (const b of bots.slice(1)) pos[b.name].p.x = 100
    pos.A0.inv = {} as any; pos.A0.armor = {} as any
    driver.observe(bots[0], [{ id: 'Foe', visible: true, position: { x: 1, y: 64, z: 0 }, equipment: { weapon: 'netherite_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: true } }])
    assert.equal(driver.panic(bots[0]), true, 'a fresh dangerous observation must bypass the slower strategic planning cycle')
  } finally { SwarmBoard.prototype.upsert = priorUpsert; Date.now = priorNow }
})
test('a poorly equipped bot disperses from an armored threat and does not initiate a duel', async () => {
  const calls = []
  const bot = { name: 'A', team: 'blue', c: { async call(method, params) { calls.push({ method, params }); return { detail: { mode: 'оторвался', ran: 7 } } } } }
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} } }
  const driver = createSwarmDriver({ bots: [bot], pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 }, home: () => pos.A.p, hostile: () => true, log: () => {} })
  driver.observe(bot, [{ id: 'Foe', position: { x: 6, y: 64, z: 0 }, velocity: { x: -.3, y: 0, z: 0 }, equipment: { weapon: 'netherite_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: true }, visible: true }])
  await driver.turn(bot)
  assert.equal(calls.some(c => c.method === 'fight'), false)
  assert.equal(calls.some(c => c.method === 'flee'), true)
})
test('failed escape permits last stand only after a physical cornered result', async () => {
  const calls = []
  const bot = { name: 'A', team: 'blue', c: { async call(method, params) { calls.push({ method, params }); return { detail: method === 'flee' ? { cornered: true, mode: 'прижали — бежать некуда' } : {} } } } }
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} } }
  const driver = createSwarmDriver({ bots: [bot], pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 }, home: () => pos.A.p, hostile: () => true, log: () => {} })
  driver.observe(bot, [{ id: 'Foe', position: { x: 2, y: 64, z: 0 }, equipment: { weapon: 'netherite_sword', armor: ['netherite_chestplate'] }, visible: true }])
  await driver.turn(bot)
  assert.equal(calls[0].method, 'flee')
  assert.equal(calls[1].method, 'fight')
  assert.equal(calls[1].params.lastStand, true)
})
test('a confirmed escape leads to looting instead of an endless panic loop', async () => {
  const calls = []
  const bot = { name: 'A', team: 'blue', c: { async call(method, params) {
    calls.push({ method, params })
    if (method === 'flee') return { detail: { mode: 'оторвался', at: { x: -16, y: 64, z: 0 } } }
    if (method === 'blocks_around') return { detail: { found: [{ x: -17, y: 64, z: 0 }] } }
    if (method === 'chest_take') return { detail: { took: { iron_chestplate: 1 } } }
    return {}
  } } }
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} } }
  const arena = { x: 0, y: 64, z: 0, r: 24, killY: 60 }
  const driver = createSwarmDriver({ bots: [bot], pos, alive: () => true, arena, home: () => pos.A.p, hostile: () => true, log: () => {}, arms: true })
  driver.observe(bot, [{ id: 'Foe', position: { x: 6, y: 64, z: 0 }, equipment: { weapon: 'netherite_sword', armor: ['netherite_chestplate'], enchanted: true }, visible: true }])
  await driver.turn(bot)
  assert.ok(calls.some(c => c.method === 'chest_take'), 'the escape receipt creates a real preparation opportunity')
  assert.equal(calls.some(c => c.method === 'fight'), false)
})
test('a ranged bot chooses an observed roof, forwards arena bounds, and does not use supplied hidden enemy coordinates', async () => {
  const calls = [], roof = { x: 2.5, y: 76, z: .5 }
  const bot: any = { name: 'A', team: 'blue', c: { async call(method, params) {
    calls.push({ method, params })
    if (method === 'swarm_position') return { detail: { observed: true, candidates: [{ at: roof, score: 20, cover: .8, highGround: 12, methods: [{ kind: 'pearl', cost: 2, skill: 'pearl_to', params: { to: roof, observed: true } }] }] } }
    if (method === 'pearl_to') return { detail: { ok: true, at: { ...roof, x: roof.x + .05 } } }
    return {}
  } } }
  const pos: any = { A: { p: { x: .5, y: 64, z: .5 }, hp: 20, inv: { bow: 1, arrow: 64, ender_pearl: 4 }, armor: {} } }
  // The first builder slot is not a ranged role; add a real same-team fighter before A.
  const friend = { name: 'B', team: 'blue', c: { async call() { return {} } } }
  pos.B = { ...pos.A, inv: { iron_sword: 1 } }
  const arena = { x: .5, z: .5, r: 24, killY: 60 }
  const driver = createSwarmDriver({ bots: [friend, bot], pos, alive: () => true, arena, home: () => pos.A.p, hostile: () => false, log: () => {} })
  await driver.turn(bot)
  const query = calls.find(c => c.method === 'swarm_position'), pearl = calls.find(c => c.method === 'pearl_to')
  assert.ok(pearl)
  assert.deepEqual(query.params.enemies, [])
  assert.deepEqual(pearl.params.arena, arena)
  assert.equal(pearl.params.observed, true)
  assert.deepEqual(bot.swarmPosition.at, roof)
  assert.equal(pos.A.p.x, roof.x + .05, 'keep the actual body receipt rather than the ideal goal')
})
test('the arena driver reserves both allies and launches paired wind on one future world tick', async () => {
  const calls = [], roof = { x: 2.5, y: 67, z: .5 }; let driver
  const actor = (name, tick) => ({ name, team: 'blue', c: { async call(method, params) {
    calls.push({ name, method, params })
    if (method === 'swarm_position') return { detail: { observed: true, candidates: [{ at: roof, score: 12, highGround: 3, methods: [{ kind: 'wind', cost: 1, skill: 'wind_leap', params: { to: roof } }] }] } }
    if (method === 'status') return { detail: { physics: { pos: { x: -.5, y: 64, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true } } }
    if (method === 'wind_receive' || method === 'wind_boost') {
      assert.ok(driver.snapshot().blue.tasks.some(t => t.claim && t.participants?.length === 2))
      if (params.dryRun) return { detail: { ok: true, gameTick: tick, plan: { target: roof } } }
      assert.equal(params.startTick, 141)
      return { detail: { ok: true, at: roof } }
    }
    return {}
  } } })
  const friend = actor('B', 101), bot = actor('A', 100)
  const pos = { B: { p: { x: -.5, y: 64, z: .5 }, hp: 20, inv: { iron_sword: 1, wind_charge: 8 }, armor: {} }, A: { p: { x: .5, y: 64, z: .5 }, hp: 20, inv: { bow: 1, arrow: 64, wind_charge: 8 }, armor: {} } }
  driver = createSwarmDriver({ bots: [friend, bot], pos, alive: () => true, arena: { x: .5, z: .5, r: 24 }, home: () => pos.A.p, hostile: () => false, log: () => {} })
  await driver.turn(bot)
  assert.equal(calls.filter(c => /wind_(receive|boost)/.test(c.method) && !c.params.dryRun).length, 2)
  assert.equal(calls.some(c => c.method === 'wind_leap'), false)
  assert.equal(driver.snapshot().blue.tasks.some(t => t.claim), false)
})
test('a line rotation stops the old front mid-fight instead of letting its long fight run out', async () => {
  const priorNow = Date.now, priorDoctrine = process.env.SWARM_DOCTRINE
  let now = 1000, release: any = null
  Date.now = () => now; process.env.SWARM_DOCTRINE = 'line'
  const calls: any[] = [], armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  const bots: any[] = ['A', 'B', 'C'].map(name => ({ name, team: 'blue', c: null }))
  const pos = { A: { p: { x: 3, y: 64, z: 0 }, hp: 20, inv: { iron_sword: 1 }, armor }, B: { p: { x: -2, y: 64, z: 1 }, hp: 20, inv: { iron_sword: 1 }, armor }, C: { p: { x: -2, y: 64, z: 2 }, hp: 20, inv: { iron_sword: 1 }, armor } }
  for (const b of bots) b.c = { call(method) { calls.push({ who: b.name, method }); return method === 'fight' ? new Promise(r => { release = r }) : Promise.resolve({ detail: {} }) } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => ({ x: 0, y: 64, z: 0 }), hostile: (_, id) => id === 'Foe', log: () => {} })
  const seen = { id: 'Foe', visible: true, position: { x: 4, y: 64, z: 0 }, equipment: { weapon: 'wooden_sword', armor: [] } }
  try {
    for (const b of bots) driver.observe(b, [seen])
    const running = driver.turn(bots[0])
    await new Promise(r => setImmediate(r))
    assert.ok(calls.some(c => c.who === 'A' && c.method === 'fight'), 'the on-duty front engages')
    now += 23500
    for (const b of bots) driver.observe(b, [seen])
    assert.ok(calls.some(c => c.who === 'A' && c.method === 'stop'), 'the shift change interrupts the old front')
    release({ detail: {} }); await running
  } finally { Date.now = priorNow; if (priorDoctrine === undefined) delete process.env.SWARM_DOCTRINE; else process.env.SWARM_DOCTRINE = priorDoctrine }
})
test('two naked allies panic at an enchanted netherite foe before any plan exists (native harness scene)', () => {
  const bots: any[] = ['A', 'B'].map(name => ({ name, team: 'blue', c: { async call() { return {} } } }))
  const pos = { A: { p: { x: .5, y: 64, z: -.5 }, hp: 20, inv: {}, armor: {} }, B: { p: { x: .5, y: 64, z: 1.5 }, hp: 20, inv: {}, armor: {} } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 3, y: 64, z: 0, r: 18 }, home: () => ({ x: -5, y: 64, z: 0 }), hostile: (_, id) => id === 'Foe', log: () => {} })
  const seen = { id: 'Foe', visible: true, position: { x: 6.5, y: 64, z: .5 }, equipment: { weapon: 'netherite_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: true } }
  for (const b of bots) driver.observe(b, [seen])
  assert.deepEqual(bots.map(b => driver.panic(b)), [true, true], 'a futile trade is judged on the spot, not after the next plan')
})
function fightLoopFixture() {
  const f: any = { now: 1000, calls: [], lines: [], reply: { status: 'done', detail: { landed: 0, swings: 0 } },
    tactics: { action: 'Flee', owner: 'Tactical', requireObservation: true } }
  f.bot = { name: 'A', team: 'blue', c: { async call(method, params) {
    f.calls.push({ method, params })
    if (method === 'fight') return f.reply
    if (method === 'dig_to') return { status: 'done', detail: { dug: 1 } }
    if (method === 'observe') return { status: 'done', detail: { tactics: f.tactics }, state: { tactics: f.tactics } }
    return { status: 'done', detail: {} }
  } } }
  const armor = { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' }
  f.pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: { iron_sword: 1, iron_pickaxe: 1 }, armor } }
  f.driver = createSwarmDriver({ bots: [f.bot], pos: f.pos, alive: () => true, aggressive: true,
    arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => f.pos.A.p,
    hostile: (_, id) => id === 'Foe', log: line => f.lines.push(line), now: () => f.now })
  f.turn = () => {
    f.driver.observe(f.bot, [{ id: 'Foe', visible: true, position: { x: 2.8, y: 64, z: 0 }, equipment: { weapon: 'wooden_sword' } }])
    return f.driver.turn(f.bot)
  }
  return f
}
test('two completed zero-hit fights breach a close wall; a landed hit resets the streak', async () => {
  const f = fightLoopFixture()
  for (const landed of [0, 1, 0, 0]) {
    f.reply = { status: 'done', detail: { landed, swings: landed } }
    await f.turn()
  }
  await f.turn()
  assert.deepEqual(f.calls.filter(c => /^(fight|dig_to)$/.test(c.method)).map(c => c.method),
    ['fight', 'fight', 'fight', 'fight', 'dig_to'])
})
for (const type of ['cancelled', 'tactical']) test(`an interrupted ${type} fight waits for observation and tactical release`, async () => {
  const f = fightLoopFixture()
  f.reply = { status: 'interrupted', by: { type }, partial: true, detail: { landed: 0, swings: 0 },
    state: { tactics: f.tactics } }
  await f.turn()
  const first = f.calls.length
  await f.turn()
  assert.equal(f.calls.length, first, 'the cooldown sends no immediate retry RPC')
  for (let i = 0; i < 8; i++) { f.now += 100; await f.turn() }
  assert.equal(f.calls.filter(c => c.method === 'fight').length, 1)
  assert.equal(f.calls.some(c => c.method === 'dig_to'), false)
  assert.ok(f.lines.some(line => line.includes('interrupted') && line.includes(type)))
  f.tactics = { action: null, owner: 'Skill', requireObservation: true }
  f.now += 600; await f.turn()
  assert.equal(f.calls.filter(c => c.method === 'fight').length, 1, 'an outstanding observation requirement still blocks the retry')
  f.tactics = { action: null, owner: 'Skill', requireObservation: false }
  f.reply = { status: 'done', detail: { landed: 1, swings: 1 } }
  f.now += 600; await f.turn()
  assert.equal(f.calls.filter(c => c.method === 'fight').length, 2)
  assert.ok(f.calls.some(c => c.method === 'observe'))
  f.reply = { status: 'interrupted', by: { type }, detail: {} }
  await f.turn()
  f.driver.reset()
  const queries = f.calls.filter(c => c.method === 'observe').length
  f.reply = { status: 'done', detail: { landed: 1, swings: 1 } }
  await f.turn()
  assert.equal(f.calls.filter(c => c.method === 'fight').length, 4)
  assert.equal(f.calls.filter(c => c.method === 'observe').length, queries, 'reset discards the old interruption')
})
test('an old-round interrupted fight cannot pause the new round', async () => {
  const f = fightLoopFixture()
  let release: any
  f.reply = new Promise(resolve => { release = resolve })
  const pending = f.turn()
  await new Promise(resolve => setImmediate(resolve))
  f.driver.reset()
  release({ status: 'interrupted', by: { type: 'tactical' }, detail: { landed: 0, swings: 0 } })
  await pending
  f.reply = { status: 'done', detail: { landed: 1, swings: 1 } }
  await f.turn()
  assert.equal(f.calls.filter(c => c.method === 'fight').length, 2)
})
test('погоня: последний бой только при физическом зажатии', async () => {
  for (const cornered of [false, true]) {
    const calls: any[] = []
    const b = { name: 'A', team: 'blue', c: { async call(method, params) {
      calls.push({ method, params })
      return { status: 'done', detail: method === 'flee'
        ? cornered ? { cornered: true } : { mode: 'оторвался' } : {} }
    } } }
    const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} } }
    const driver = createSwarmDriver({ bots: [b], pos, alive: () => true,
      aggressive: true, now: () => 1000, arena: { x: 0, y: 64, z: 0, r: 100 },
      home: () => pos.A.p, hostile: () => true, log: () => {} })
    driver.observe(b, [{ id: 'Foe', visible: true,
      position: { x: 4, y: 64, z: 0 }, velocity: { x: -.28, y: 0, z: 0 },
      equipment: { weapon: 'netherite_sword', enchanted: true, armor: [
        'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'
      ] } }])
    await driver.turn(b)
    assert.deepEqual(calls.map(c => c.method), cornered ? ['flee', 'fight'] : ['flee'])
    assert.deepEqual(calls[0].params.toward, [])
    assert.equal(calls[0].params.safeDist, 22)
  }
})

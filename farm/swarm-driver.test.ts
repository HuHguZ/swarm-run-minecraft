import test from 'node:test'
import assert from 'node:assert/strict'
const { createSwarmDriver } = require('./swarm-driver')

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
  const { SwarmBoard } = require('../daemon/src/swarm')
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

test('a transferred armour item worn before the next own status is a confirmed receipt', async () => {
  const states: Record<string, any> = {
    A: { inventory: { iron_sword: 1, iron_boots: 2 }, armor: {}, pos: { x: 0, y: 64, z: 0 } },
    B: { inventory: { iron_sword: 1 }, armor: {}, pos: { x: 1, y: 64, z: 0 } }
  }
  const calls: any[] = []
  const bots = Object.keys(states).map(name => ({ name, team: 'blue', c: { async call(method, params: any = {}) {
    calls.push({ name, method, params })
    if (method === 'status') return { state: structuredClone(states[name]) }
    if (method === 'assist' && params.mode === 'toss') { states.A.inventory.iron_boots--; return { detail: { ok: true } } }
    if (method === 'assist' && params.mode === 'pickup') { states.B.armor.feet = 'iron_boots'; return { detail: { ok: true } } }
    return { detail: {} }
  } } }))
  const pos: Record<string, any> = Object.fromEntries(Object.entries(states).map(([name, state]) => [name, { p: state.pos, hp: 20, inv: structuredClone(state.inventory), armor: {} }]))
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 }, home: b => pos[b.name].p, hostile: () => false, log: () => {}, arms: true })
  driver.observe(bots[0], [])
  await driver.turn(bots[0])
  assert.ok(calls.some(c => c.name === 'B' && c.method === 'assist' && c.params.mode === 'pickup'))
  assert.equal(driver.snapshot().blue.stats.transfers, 1, 'moving the received item to an armour slot must not erase its receipt')
  assert.equal(pos.B.armor.feet, 'iron_boots', 'the shared own report must reflect the completed equip')
})

test('arena search uses own pose, never the enemy daemon position or inventory', async () => {
  const calls = []
  const own = { name: 'A', team: 'blue', c: { async call(method, params) { calls.push({ method, params }); return { detail: {} } } } }
  const foe = { name: 'B', team: 'red' }
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: { iron_sword: 1 }, armor: {} }, B: {} }
  for (const key of ['p', 'hp', 'inv', 'armor']) Object.defineProperty(pos.B, key, { get() { throw new Error('enemy daemon read:' + key) } })
  const driver = createSwarmDriver({ bots: [own, foe], pos, alive: n => n === 'A', arena: { x: 0, y: 64, z: 0, r: 24 }, home: () => pos.A.p, hostile: (a, n) => n !== 'A', log: () => {} })
  driver.observe(own, [])
  await driver.turn(own)
  assert.ok(calls.some(c => c.method === 'goto'), 'no sighting means an actual search leg')
  assert.equal(calls.some(c => c.method === 'fight'), false)
  assert.deepEqual(driver.snapshot().blue.enemies, [])
})

test('one allied sighting is shared, other teams and hidden updates are rejected', () => {
  const bots = ['A', 'C'].map(name => ({ name, team: 'blue' }))
  const pos = Object.fromEntries(bots.map(b => [b.name, { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} }]))
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 }, home: () => pos.A.p, hostile: (_, n) => n === 'Foe', log: () => {} })
  driver.observe(bots[0], [{ id: 'Foe', position: { x: 5, y: 64, z: 0 }, visible: true }, { id: 'C', position: pos.C.p, visible: true }])
  driver.observe(bots[1], [{ id: 'Foe', position: { x: 90, y: 64, z: 90 }, visible: false }])
  const knowledge = driver.snapshot().blue.enemies
  assert.equal(knowledge.length, 1)
  assert.equal(knowledge[0].position.x, 5)
})

test('group shelter accepts fractional spawn positions and its roof has an acyclic support plan', async () => {
  const cells = []
  const bot = { name: 'A', team: 'blue', c: { async call(method, params) { if (method === 'swarm_work') { cells.push(params.at); return { detail: { done: true, at: params.at, after: params.item } } } return {} } } }
  const pos = { A: { p: { x: 0.5, y: 64, z: 0.5 }, hp: 20, inv: { iron_pickaxe: 1, iron_sword: 1, cobblestone: 64 }, armor: {} } }
  const driver = createSwarmDriver({ bots: [bot], pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 }, home: () => pos.A.p, hostile: () => false, log: () => {} })
  for (let i = 0; i < 55; i++) await driver.turn(bot)
  assert.equal(cells.length, 55)
  assert.equal(new Set(cells.map(p => JSON.stringify(p))).size, 55)
  assert.equal(driver.snapshot().blue.tasks.filter(t => t.kind === 'build' && t.status === 'done').length, 55)
  const firstRoof = cells.findIndex(p => p.y === 66)
  assert.equal(firstRoof, 30, 'all walls finish before the roof removes jumping viewpoints')
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

test('a long failed placement sequence retains its fenced lease until completion', async () => {
  const realNow = Date.now; let now = realNow()
  Date.now = () => now
  try {
    const calls = []
    const leases = []; let driver
    const bot = { name: 'A', team: 'blue', c: { async call(method, params) {
      calls.push(method)
      if (method === 'goto') { now += 3900; return {} }
      if (method === 'swarm_pose') return { detail: { poses: Array.from({ length: 4 }, (_, i) => ({ x: 4 + i, y: 64, z: 0 })) } }
      if (method === 'swarm_work') { leases.push(driver.snapshot().blue.tasks.some(t => t.status === 'claimed' && t.claim?.owner === 'A')); now += 2900; return { detail: { done: false } } }
      return {}
    } } }
    const pos = { A: { p: { x: .5, y: 64, z: .5 }, hp: 20, inv: { iron_pickaxe: 1, cobblestone: 64 }, armor: {} } }
    driver = createSwarmDriver({ bots: [bot], pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 }, home: () => pos.A.p, hostile: () => false, log: () => {} })
    await driver.turn(bot)
    assert.equal(calls.filter(m => m === 'swarm_work').length, 5, 'all placement attempts ran under a renewed lease')
    assert.ok(leases.every(Boolean), 'every mutation still owns its current lease')
    assert.ok(driver.snapshot().blue.tasks.every(t => !t.claim), 'completion releases its own token')
  } finally { Date.now = realNow }
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

test('an outpost reuses witnessed stone flooring without requiring stone in its inventory', async () => {
  const calls = [], at = { x: .5, y: 76, z: .5 }
  const bot: any = { name: 'A', team: 'blue', swarmPosition: { purpose: 'build', at, highGround: 4 }, c: { async call(method, params) {
    if (method === 'swarm_pose' && params.inspectOnly) return { detail: { existing: { name: 'stone', solid: true } } }
    if (method === 'swarm_work') { calls.push(params); return { detail: { done: true, at: params.at, after: params.item } } }
    return {}
  } } }
  const pos = { A: { p: at, hp: 20, inv: { iron_pickaxe: 1, cobblestone: 64 }, armor: {} } }
  const driver = createSwarmDriver({ bots: [bot], pos, alive: () => true, arena: { x: .5, z: .5, r: 24 }, home: () => at, hostile: () => false, log: () => {} })
  for (let n = 0; n < 32; n++) await driver.turn(bot)
  const floor = calls.filter(p => p.at.y === 75)
  assert.equal(floor.length, 9)
  assert.ok(floor.every(p => p.item === 'stone'), 'native worker witnesses the existing floor rather than trying to replace it')
  assert.equal(driver.snapshot().blue.tasks.filter(t => t.kind === 'build' && t.status === 'done').length, 32)
})

async function placementRetryFixture(reply, poses) {
  const calls: any[] = [], foe = { x: 8.5, y: 64, z: .5 }
  const armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  const bots = ['A', 'B', 'C', 'D'].map(name => ({ name, team: 'blue', c: null }))
  const pos: any = Object.fromEntries(bots.map((b, k) => [b.name, { p: { x: .5, y: 64, z: .5 + k }, hp: 20, inv: { iron_sword: 1, iron_pickaxe: 1, cobblestone: 64 }, armor }]))
  let work = 0, moves = 0
  for (const b of bots) b.c = { async call(method, params) {
    calls.push({ method, params })
    if (method === 'goto') { moves++; pos[b.name].p = { x: params.x, y: params.y, z: params.z }; return { detail: { arrived: pos[b.name].p } } }
    if (method === 'swarm_pose') return { detail: { poses: poses(moves) } }
    if (method === 'swarm_work') return { detail: reply(++work, params, pos[b.name].p) }
    return { detail: {} }
  } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 }, home: () => pos.A.p, hostile: (_, id) => id === 'Foe', log: () => {} })
  driver.observe(bots[0], [{ id: 'Foe', visible: true, position: foe, equipment: { weapon: 'wooden_sword' } }])
  await driver.turn(bots[0])
  return { calls, snapshot: driver.snapshot().blue }
}

test('a threat-aborted placement moves to the safer witnessed pose before retrying and acknowledging', async () => {
  const near = { x: 2.5, y: 64, z: .5 }, safer = { x: -2.5, y: 64, z: .5 }
  const { calls, snapshot } = await placementRetryFixture((n, p, at) => {
    if (n === 1) return { done: false, aborted: true, why: 'direct_threat' }
    assert.deepEqual(at, safer, 'a fresh worker rechecks the actual moved body rather than ignoring the previous threat')
    return { done: true, at: p.at, after: p.item }
  }, () => [near, safer])
  assert.deepEqual(calls.filter(c => c.method === 'goto').map(c => ({ x: c.params.x, y: c.params.y, z: c.params.z })), [safer])
  assert.equal(calls.filter(c => c.method === 'swarm_work').length, 2)
  assert.equal(snapshot.stats.built, 1)
  assert.equal(snapshot.tasks.filter(t => t.kind === 'build' && t.status === 'done').length, 1)
  assert.ok(calls.filter(c => c.method === 'goto').every(c => c.params.surface === 'strict' && c.params.arena), 'reuse bounded honest navigation')
})

test('a threat discovered after a placement approach can try a different safer pose', async () => {
  const near = { x: 2.5, y: 64, z: .5 }, safer = { x: -2.5, y: 64, z: .5 }
  const { calls, snapshot } = await placementRetryFixture((n, p) => n === 1 ? { done: false, why: 'no_support' } : n === 2 ? { done: false, aborted: true, why: 'direct_threat' } : { done: true, at: p.at, after: p.item }, moves => moves ? [near, safer] : [near])
  assert.equal(calls.filter(c => c.method === 'swarm_work').length, 3)
  assert.deepEqual(calls.filter(c => c.method === 'goto').map(c => c.params.x), [near.x, safer.x])
  assert.equal(snapshot.stats.built, 1)
})

test('a continued physical threat exhausts only different safer poses and never acknowledges', async () => {
  const { calls, snapshot } = await placementRetryFixture(() => ({ done: false, aborted: true, why: 'direct_threat' }), moves => [{ x: -.5 - moves, y: 64, z: .5 }])
  const moved = calls.filter(c => c.method === 'goto')
  assert.equal(moved.length, 4, 'the existing local approach budget must remain bounded despite repeated threat aborts')
  assert.equal(new Set(moved.map(c => JSON.stringify(c.params))).size, moved.length)
  assert.equal(calls.filter(c => c.method === 'swarm_work').length, moved.length + 1)
  assert.equal(snapshot.stats.built, 0)
  assert.equal(snapshot.tasks.some(t => t.kind === 'build' && t.status === 'done'), false)
  assert.equal(snapshot.tasks.some(t => t.claim), false)
})

test('a direct threat does not retry from the same or a more exposed pose', async () => {
  const { calls, snapshot } = await placementRetryFixture(() => ({ done: false, aborted: true, why: 'direct_threat' }), () => [{ x: .5, y: 64, z: .5 }, { x: 2.5, y: 64, z: .5 }])
  assert.equal(calls.filter(c => c.method === 'swarm_work').length, 1)
  assert.equal(calls.some(c => c.method === 'goto'), false)
  assert.equal(snapshot.stats.built, 0)
})

test('a safer retry without the matching cell receipt cannot acknowledge construction', async () => {
  const { snapshot } = await placementRetryFixture((n, p) => n === 1 ? { done: false, aborted: true, why: 'direct_threat' } : { done: true, at: { ...p.at, x: p.at.x + 1 }, after: p.item }, () => [{ x: -2.5, y: 64, z: .5 }])
  assert.equal(snapshot.stats.built, 0)
  assert.equal(snapshot.tasks.some(t => t.kind === 'build' && t.status === 'done'), false)
})

for (const why of ['cancelled', 'taking_damage', 'dead']) test(`a ${why} placement abort still stops all pose fallback`, async () => {
  const { calls, snapshot } = await placementRetryFixture(() => ({ done: false, aborted: true, why }), () => [{ x: -2.5, y: 64, z: .5 }])
  assert.equal(calls.filter(c => c.method === 'swarm_work').length, 1)
  assert.equal(calls.some(c => c.method === 'swarm_pose' || c.method === 'goto'), false)
  assert.equal(snapshot.stats.built, 0)
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

test('an idle cocoon builder steps out of the box instead of holding in a slit under an unbuilt roof cell', async () => {
  const priorNow = Date.now, priorDoctrine = process.env.SWARM_DOCTRINE
  let now = 1000
  Date.now = () => now; process.env.SWARM_DOCTRINE = 'cocoon'
  const calls: any[] = [], armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  // Every placement is confirmed, so the builder runs out of cells while it still stands in the east slit.
  const bots: any[] = ['A', 'B', 'C'].map(name => ({ name, team: 'blue', c: { async call(method, params) { calls.push({ who: name, method, params }); return { detail: method === 'swarm_work' ? { done: true, at: params.at, after: params.item } : {} } } } }))
  const pos = { A: { p: { x: 1.5, y: 65, z: .5 }, hp: 20, inv: { iron_pickaxe: 1, cobblestone: 64, iron_sword: 1 }, armor }, B: { p: { x: -3, y: 64, z: 3 }, hp: 20, inv: { iron_sword: 1 }, armor }, C: { p: { x: -3, y: 64, z: -3 }, hp: 20, inv: { iron_sword: 1 }, armor } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => ({ x: 0, y: 64, z: 0 }), hostile: (_, id) => id === 'Foe', log: () => {} })
  const cells = () => (driver.snapshot().blue?.tasks || []).filter(t => t.kind === 'build' && t.data?.blueprint === 'cocoon:0,64,0')
  try {
    for (let i = 0; i < 40 && !(cells().length && cells().every(t => t.status === 'done')); i++) {
      for (const b of bots) driver.observe(b, [{ id: 'Foe', visible: true, position: { x: .5, y: 64, z: .5 }, equipment: { weapon: 'wooden_sword', armor: [] } }])
      await driver.turn(bots[0]); now += 100
    }
    assert.equal(cells().length, 23); assert.ok(cells().every(t => t.status === 'done'))
    for (const b of bots) driver.observe(b, [{ id: 'Foe', visible: true, position: { x: .5, y: 64, z: .5 }, equipment: { weapon: 'wooden_sword', armor: [] } }])
    calls.length = 0
    await driver.turn(bots[0])
    assert.equal(driver.snapshot().blue.tasks.find(t => t.assignedTo === 'A')?.data?.buildKind, 'cocoon')
    const out = calls.filter(c => c.who === 'A').at(-1)
    assert.equal(out.method, 'goto', 'leave the box rather than hold in the slit')
    assert.ok(out.params.x > 3, 'outward, past the ring of the cocoon')
  } finally { Date.now = priorNow; if (priorDoctrine === undefined) delete process.env.SWARM_DOCTRINE; else process.env.SWARM_DOCTRINE = priorDoctrine }
})

test('an opened empty chest is marked checked for a minute instead of being revisited every loot cooldown', async () => {
  const priorNow = Date.now
  let now = 1000
  Date.now = () => now
  const calls: any[] = []
  const bots: any[] = ['A', 'B'].map(name => ({ name, team: 'blue', c: { async call(method, params) { calls.push({ who: name, method, params }); return { detail: method === 'blocks_around' ? { found: [{ x: 3, y: 64, z: 0 }] } : method === 'chest_take' ? { at: { x: 3, y: 64, z: 0 }, took: {}, contents: {} } : {} } } } }))
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} }, B: { p: { x: 0, y: 64, z: 2 }, hp: 20, inv: {}, armor: {} } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => ({ x: 0, y: 64, z: 0 }), hostile: () => false, log: () => {}, arms: true })
  const takes = () => calls.filter(c => c.method === 'chest_take').length
  try {
    for (const b of bots) driver.observe(b, [])
    await driver.turn(bots[0]); assert.equal(takes(), 1)
    now += 5000; await driver.turn(bots[0]); assert.equal(takes(), 1, 'the empty chest is not reopened after the 4 s loot cooldown')
    now += 61000; await driver.turn(bots[0]); assert.equal(takes(), 2, 'a refill is possible later, so the mark expires')
  } finally { Date.now = priorNow }
})

test('a sighting is no fresher than the status request that carried it', () => {
  const priorNow = Date.now
  let now = 10000
  Date.now = () => now
  const bots: any[] = ['A', 'B'].map(name => ({ name, team: 'blue', c: { async call() { return {} } } }))
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} }, B: { p: { x: 1, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => ({ x: 0, y: 64, z: 0 }), hostile: (_, id) => id === 'Foe', log: () => {} })
  try {
    driver.observe(bots[0], [{ id: 'Foe', visible: true, position: { x: 5, y: 64, z: 0 } }], now - 400)
    assert.equal(driver.enemies(bots[0])[0].seenAt, 9600, 'stamped when the status was asked, 400 ms before the reply')
    driver.observe(bots[1], [{ id: 'Foe', visible: true, position: { x: 5, y: 64, z: 0 } }])
    assert.equal(driver.enemies(bots[1])[0].seenAt, 10000, 'without a request time — now')
  } finally { Date.now = priorNow }
})

test('two naked allies panic at an enchanted netherite foe before any plan exists (native harness scene)', () => {
  const bots: any[] = ['A', 'B'].map(name => ({ name, team: 'blue', c: { async call() { return {} } } }))
  const pos = { A: { p: { x: .5, y: 64, z: -.5 }, hp: 20, inv: {}, armor: {} }, B: { p: { x: .5, y: 64, z: 1.5 }, hp: 20, inv: {}, armor: {} } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 3, y: 64, z: 0, r: 18 }, home: () => ({ x: -5, y: 64, z: 0 }), hostile: (_, id) => id === 'Foe', log: () => {} })
  const seen = { id: 'Foe', visible: true, position: { x: 6.5, y: 64, z: .5 }, equipment: { weapon: 'netherite_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: true } }
  for (const b of bots) driver.observe(b, [seen])
  assert.deepEqual(bots.map(b => driver.panic(b)), [true, true], 'a futile trade is judged on the spot, not after the next plan')
})

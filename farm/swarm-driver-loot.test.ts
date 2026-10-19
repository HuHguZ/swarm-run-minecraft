// Драйвер роя: лут и обмен — передача брони, поиск, наблюдения союзников, пустые сундуки, кучи, захват, маршрут лута с обходом врага.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'

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
test('an opened empty chest stays empty until the arena reports its refill, however long that takes', async () => {
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
    now += 61000; await driver.turn(bots[0]); assert.equal(takes(), 1, 'a minute alone does not refill a chest')
    driver.refill({ x: 3, y: 64, z: 0 })
    now += 5000; await driver.turn(bots[0]); assert.equal(takes(), 2, 'the refill notice reopens it')
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
test('a chest found empty is skipped until refilled; a naked bot then picks up a fallen ally pile, but not while chased', async () => {
  const priorNow = Date.now
  let now = 1000
  Date.now = () => now
  const calls: any[] = []
  let items = 3
  const bots: any[] = ['A', 'B'].map(name => ({ name, team: 'blue', c: { async call(method, params) {
    calls.push({ who: name, method, params })
    if (method === 'goto') return { status: 'done', detail: { arrived: { x: params.x, y: params.y, z: params.z } } }
    if (method === 'assist') return { detail: items-- > 0 ? { ok: true } : { ok: false, why: 'не вижу вещи' } }
    return { detail: method === 'blocks_around' ? { found: [{ x: 3, y: 64, z: 0 }] } : method === 'chest_take' ? { at: { x: 3, y: 64, z: 0 }, took: {}, contents: {} } : {} }
  } } }))
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} }, B: { p: { x: 0, y: 64, z: 2 }, hp: 20, inv: {}, armor: {} } }
  const pile = { p: { x: 20, y: 64, z: 5 }, at: 900, looted: new Set<string>(), retryAt: 0 }
  let foe: any = null
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => ({ x: 0, y: 64, z: 0 }), hostile: (_, id) => id === 'Foe', log: () => {}, arms: true, drops: () => [pile] })
  const takes = () => calls.filter(c => c.method === 'chest_take').length
  const pickups = () => calls.filter(c => c.method === 'assist' && c.params.mode === 'pickup').length
  try {
    pile.at = Infinity // кучи ещё нет
    for (const b of bots) driver.observe(b, [])
    await driver.turn(bots[0]); assert.equal(takes(), 1)
    driver.refill({ x: 3, y: 64, z: 0 })
    now += 5000; await driver.turn(bots[0]); assert.equal(takes(), 2, 'a refilled chest is opened again')
    now += 61000
    pile.at = now - 1000
    foe = { id: 'Foe', visible: true, position: { x: 8, y: 64, z: 0 } }
    for (const b of bots) driver.observe(b, [foe])
    await driver.turn(bots[0])
    assert.equal(pickups(), 0, 'a human 8 blocks off: no chest, no pile')
    foe = null; now += 9000
    for (const b of bots) driver.observe(b, [])
    await driver.turn(bots[0])
    assert.equal(takes(), 2, 'found empty twice — not reopened')
    assert.equal(pickups(), 4, 'three items picked up, the fourth call sees nothing')
    assert.ok(calls.some(c => c.method === 'goto' && Math.abs(c.params.x - 20) < 1.5), 'walked to the pile')
    assert.equal(pile.retryAt, now + 30000)
  } finally { Date.now = priorNow }
})
function lootReceiptFixture({ chest = null, pile = null, aggressive = false }: any = {}) {
  const f: any = { now: 1000, calls: [], lines: [], item: null,
    move: async (_name, p) => ({ status: 'done', detail: { arrived: { x: p.x, y: p.y, z: p.z } } }),
    pickup: async () => ({ detail: { ok: false } }) }
  f.bots = ['A', 'B'].map(name => ({ name, team: 'blue', c: { async call(method, params) {
    f.calls.push({ who: name, method, params })
    if (method === 'blocks_around') return { detail: { found: chest ? [chest] : [] } }
    if (method === 'items_near') return { detail: { items: f.item ? [f.item] : [] } }
    if (method === 'goto') return f.move(name, params)
    if (method === 'assist') return f.pickup(name, params)
    if (method === 'status') return { state: { inventory: f.pos[name].inv, armor: f.pos[name].armor } }
    return { detail: {} }
  } } }))
  f.pos = Object.fromEntries(f.bots.map(b => [b.name, { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} }]))
  f.driver = createSwarmDriver({ bots: f.bots, pos: f.pos, alive: () => true,
    arena: { x: 0, y: 64, z: 0, r: 100, killY: 60 }, home: () => f.pos.A.p,
    hostile: () => false, log: line => f.lines.push(line), arms: true, aggressive,
    drops: () => pile ? [pile] : [], now: () => f.now })
  return f
}
test('a chest requires a completed approach receipt and stays under a visible stationary open', async () => {
  for (const reply of [{ status: 'done', detail: {} }, { status: 'timeout', detail: { arrived: { x: 8, y: 64, z: 0 } } }]) {
    const f = lootReceiptFixture({ chest: { x: 8, y: 64, z: 0 } })
    f.move = async () => reply
    await f.driver.turn(f.bots[0])
    assert.equal(f.calls.filter(c => c.method === 'chest_take').length, 0)
    assert.ok(f.driver.snapshot().blue.tasks.every(t => !t.claim))
  }
  const f = lootReceiptFixture({ chest: { x: 8, y: 64, z: 0 } })
  await f.driver.turn(f.bots[0])
  const take = f.calls.find(c => c.method === 'chest_take')
  assert.ok(take)
  assert.equal(take.params.timeoutSeconds, 8)
  assert.equal(take.params.stay, true)
  assert.equal(take.params.visibleOnly, true)
})
test('a failed pile approach releases a 30 second retry for every bot, including previously looted piles', async () => {
  const pile: any = { p: { x: 20, y: 64, z: 5 }, at: 900, looted: new Set() }
  const f = lootReceiptFixture({ pile })
  f.move = async () => ({ status: 'failed' })
  await f.driver.turn(f.bots[0])
  assert.equal(f.calls.filter(c => c.method === 'assist').length, 0)
  assert.equal(pile.retryAt, 31000)
  f.now = 30999
  await f.driver.turn(f.bots[0])
  assert.equal(f.calls.filter(c => c.method === 'assist').length, 0)
  f.now = 31000
  f.move = async (_name, p) => ({ status: 'done', detail: { arrived: p } })
  pile.looted.add('A')
  let remaining = 1
  f.pickup = async () => ({ detail: { ok: remaining-- > 0 } })
  await f.driver.turn(f.bots[1])
  assert.equal(f.calls.filter(c => c.who === 'B' && c.method === 'assist').length, 2)
  assert.equal(pile.retryAt, 61000)
})
test('a pile stays reserved until the current attempt finishes, even after 30 seconds', async () => {
  const pile: any = { p: { x: 20, y: 64, z: 5 }, at: 900, looted: new Set() }
  const f = lootReceiptFixture({ pile })
  let release: any
  const gate = new Promise(resolve => { release = resolve })
  f.move = async (name, p) => {
    if (name === 'A' && p.x === pile.p.x) await gate
    return { status: 'done', detail: { arrived: p } }
  }
  const pending = f.driver.turn(f.bots[0])
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(pile.retryAt, Infinity)
    f.now += 31000
    await f.driver.turn(f.bots[1])
    assert.equal(f.calls.filter(c => c.who === 'B' && c.method === 'assist').length, 0)
  } finally { release(); await pending }
  assert.equal(pile.retryAt, f.now + 30000)
})
for (const received of [false, true]) test('grab waits for pickup and requires its own inventory delta: ' + received, async () => {
  const f = lootReceiptFixture({ aggressive: true })
  f.item = { id: 7, name: 'diamond_chestplate', at: { x: 2, y: 64, z: 0 }, d: 2 }
  let release: any
  const gate = new Promise(resolve => { release = resolve })
  f.pickup = async name => {
    await gate
    if (received) f.pos[name].inv = { diamond_chestplate: 1 }
    return { detail: { ok: true } }
  }
  const pending = f.driver.turn(f.bots[0])
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.bots[0].climbing, true)
    const pickup = f.calls.find(c => c.method === 'assist')
    assert.ok(pickup)
    assert.equal(pickup.params._climb, true)
    assert.equal(pickup.params.item, 'diamond_chestplate')
  } finally { release(); await pending }
  assert.equal(f.bots[0].climbing, false)
  assert.equal(f.calls.filter(c => c.method === 'armor').length, received ? 1 : 0)
})
test('лут слабого: куча за врагом поручается A* с avoid; отказ тела запрещает подбор', async () => {
  for (const [px, ok] of [[47, false], [-20, true]] as const) {
    const calls: any[] = []
    const bot: any = { name: 'A', team: 'blue', c: { async call (method, params) {
      calls.push({ method, params })
      if (method === 'goto') return !ok && params.x === px ? { status: 'failed', detail: { error: 'AVOID_NO_PATH' } } : { status: 'done', detail: { arrived: { x: params.x, y: params.y, z: params.z } } }
      if (method === 'assist') return { detail: { ok: false } }
      if (method === 'flee') return { detail: { mode: 'оторвался', at: { x: 0, y: 64, z: 0 } } }
      return { detail: method === 'blocks_around' ? { found: [] } : {} }
    } } }
    const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} } }
    const pile = { p: { x: px, y: 64, z: 0 }, at: Date.now() - 1000, looted: new Set<string>(), retryAt: 0 }
    const driver = createSwarmDriver({ bots: [bot], pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => pos.A.p, hostile: () => true, log: () => {}, arms: true, drops: () => [pile] })
    driver.observe(bot, [{ id: 'Foe', visible: true, position: { x: 23, y: 64, z: 0 }, equipment: { weapon: 'netherite_sword', armor: ['netherite_chestplate'], enchanted: true } }])
    await driver.turn(bot)
    const toPile = calls.find(c => c.method === 'goto' && Math.abs(c.params.x - px) < 1.5)
    assert.ok(toPile, `куча в ${px}: обход решает тело`)
    assert.deepEqual(toPile.params.arena.avoid, [{ x: 23, y: 64, z: 0, r: 22 }])
    if (!ok) assert.equal(calls.some(c => c.method === 'assist' && c.params.mode === 'pickup'), false)
  }
})
function routeLootFixture({ chests = [], hideouts = [], item = null, pile = null, inventory = {}, armor = {}, aggressive = true }: any = {}) {
  const f: any = { now: 1000, calls: [], blocked: new Set(), chests, onMove: null }
  const p = (x, z = 0, y = 64) => ({ x, y, z })
  f.bots = ['A', 'B', 'C', 'D'].map(name => ({ name, team: 'blue', c: { async call(method, params: any = {}) {
    f.calls.push({ who: name, method, params })
    if (method === 'blocks_around') return { detail: { found: f.chests } }
    if (method === 'items_near') return { detail: { items: item ? [item] : [] } }
    if (method === 'goto') {
      if (f.onMove) await f.onMove(params)
      if (f.blocked.has(params.x)) return { status: 'failed', detail: { error: 'AVOID_NO_PATH' } }
      f.pos[name].p = { x: params.x, y: params.y, z: params.z }
      return { status: 'done', detail: { arrived: f.pos[name].p } }
    }
    if (method === 'chest_take') return { detail: { took: { diamond_chestplate: 1 } } }
    if (method === 'status') return { state: { inventory: f.pos[name].inv, armor: f.pos[name].armor } }
    return { status: 'done', detail: {} }
  } } }))
  f.pos = Object.fromEntries(f.bots.map(b => [b.name, { p: p(0), hp: 20, inv: { ...inventory }, armor: { ...armor } }]))
  f.arena = { x: 0, y: 64, z: 0, r: 100, killY: 60 }
  f.driver = createSwarmDriver({ bots: f.bots, pos: f.pos, alive: () => true, arms: true, aggressive, hideouts,
    arena: f.arena, home: () => p(0), hostile: (_, id) => id === 'Human', now: () => f.now, log: () => {}, drops: () => pile ? [pile] : [] })
  f.see = (at = p(40), seenAt = f.now) => f.driver.observe(f.bots[0], [{ id: 'Human', visible: true, position: at,
    equipment: { weapon: 'netherite_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: true } }], seenAt)
  f.turn = () => f.driver.turn(f.bots[0])
  f.see()
  return f
}
test('loot route: naked chest/pile approaches and weak armed grab receive enemy exclusions', async () => {
  for (const scenario of [
    { chests: [{ x: 80, y: 64, z: 0 }] },
    { pile: { p: { x: 0, y: 64, z: 40 }, at: 1000 } },
    { inventory: { trident: 1 }, item: { id: 7, name: 'diamond_chestplate', at: { x: 7, y: 64, z: 0 }, d: 7 } }
  ]) {
    const f = routeLootFixture(scenario)
    await f.turn()
    const move = f.calls.find(c => c.method === 'goto')
    assert.ok(move, JSON.stringify(scenario))
    assert.deepEqual(move.params.arena.avoid, [{ x: 40, y: 64, z: 0, r: 22 }])
    assert.equal(f.arena.avoid, undefined, 'the shared combat/flee arena is unchanged')
    for (const c of f.calls.filter(c => c.method === 'flee' || c.method === 'fight')) assert.equal(c.params.arena.avoid, undefined)
  }
})
test('loot route: safe flat and climbing tours beyond a distant human are sent to A* with an exclusion', async () => {
  for (const high of [false, true]) {
    const f = routeLootFixture({ inventory: { cobblestone: 32 }, hideouts: [{ x: 80, y: high ? 70 : 64, z: 0, ...(high ? { climbFrom: 64 } : {}) }] })
    await f.turn()
    const move = f.calls.find(c => c.method === 'goto' && c.params.x === 80)
    assert.ok(move, 'a detour may exist; do not reject the straight segment in the driver')
    assert.deepEqual(move.params.arena.avoid, [{ x: 40, y: 64, z: 0, r: 22 }])
    if (high) { assert.equal(move.params.climb, true); assert.equal(f.bots[0].climbing, false) }
  }
})
test('loot route: failed chest approach cools that chest and immediately tries the next one', async () => {
  const f = routeLootFixture({ chests: [{ x: 80, y: 64, z: 0 }, { x: -8, y: 64, z: 0 }] })
  f.blocked.add(80)
  await f.turn()
  assert.deepEqual(f.calls.filter(c => c.method === 'goto').map(c => c.params.x), [80, -8])
  assert.deepEqual(f.calls.filter(c => c.method === 'chest_take').map(c => c.params.x), [-8])
  f.now += 4100; f.see(); f.pos.A.p = { x: 0, y: 64, z: 0 }; f.chests = [{ x: 80, y: 64, z: 0 }]; f.calls.length = 0
  await f.turn()
  assert.equal(f.calls.some(c => c.method === 'goto' && c.params.x === 80), false)
})
test('loot route: ready looters and stale reports do not receive exclusions', async () => {
  const armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  for (const ready of [false, true]) {
    const f = routeLootFixture({ aggressive: true, inventory: ready ? { netherite_sword: 1 } : {}, armor: ready ? armor : {},
      item: { id: 7, name: ready ? 'mace' : 'diamond_chestplate', at: { x: -7, y: 64, z: 0 }, d: 7 } })
    if (ready) for (const m of Object.values(f.pos) as any[]) m.enchants = [{ name: 'netherite_sword', ench: { sharpness: 5 } }, ...[5, 6, 7, 8].map(slot => ({ slot, ench: { protection: 4 } }))]
    else f.now += 10001
    await f.turn()
    const move = f.calls.find(c => c.method === 'goto')
    assert.ok(move)
    assert.equal(move.params.arena.avoid, undefined)
  }
})
test('loot route: a failed tour is cooled even after partial progress, so the next turn picks another place', async () => {
  const f = routeLootFixture({ hideouts: [{ x: 70, y: 64, z: 0 }, { x: -80, y: 64, z: 0 }] })
  f.blocked.add(70)
  f.onMove = p => { if (p.x === 70) f.pos.A.p = { x: 5, y: 64, z: 0 } }
  await f.turn()
  f.now += 1000; f.see(); f.calls.length = 0
  await f.turn()
  const move = f.calls.find(c => c.method === 'goto')
  assert.equal(move?.params.x, -80)
})
test('loot route: seenAt retains an observation for 7.9 s and the board expires it at 8 s', async () => {
  for (const age of [7900, 8000]) {
    const f = routeLootFixture({ item: { id: 7, name: 'diamond_chestplate', at: { x: -7, y: 64, z: 0 }, d: 7 } })
    f.now += age
    await f.turn()
    const move = f.calls.find(c => c.method === 'goto')
    assert.ok(move)
    assert.equal(!!move.params.arena.avoid?.length, age < 8000)
  }
})
test('loot route: flee gets no exclusions even for a naked bot', async () => {
  const f = routeLootFixture()
  f.see({ x: 10, y: 64, z: 0 })
  await f.turn()
  const flee = f.calls.find(c => c.method === 'flee')
  assert.ok(flee)
  assert.equal(flee.params.arena.avoid, undefined)
})
test('a chest at hand is opened before the order: the bot on the roof takes the netherite, then goes to the fight (user 16.10)', async () => {
  const priorNow = Date.now
  let now = 1000
  Date.now = () => now
  const calls: any[] = []
  const bots: any[] = ['A', 'B'].map(name => ({ name, team: 'blue', c: { async call(method, params) {
    calls.push({ who: name, method, params })
    if (method === 'goto') return { status: 'done', detail: { arrived: { x: params.x, y: params.y, z: params.z } } }
    return { detail: method === 'blocks_around' ? { found: [{ x: 3, y: 94, z: 0 }] } : method === 'chest_take' ? { at: { x: 3, y: 94, z: 0 }, took: { netherite_chestplate: 1 }, contents: {} } : {} }
  } } }))
  const pos = { A: { p: { x: 1.5, y: 94, z: .5 }, hp: 20, inv: { cobblestone: 20 }, armor: {} }, B: { p: { x: 0, y: 64, z: 2 }, hp: 20, inv: {}, armor: {} } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => ({ x: 0, y: 64, z: 0 }), hostile: (_, id) => id === 'Foe', log: () => {}, arms: true,
    chestTops: [{ x: 3.5, y: 94, z: .5, climbFrom: 88, tier: 3 }] })
  const foe = { id: 'Foe', visible: true, position: { x: 40, y: 64, z: 0 } }
  try {
    for (const b of bots) driver.observe(b, [foe])
    await driver.turn(bots[0])
    const first = calls.find(c => c.who === 'A' && c.method !== 'blocks_around' && c.method !== 'armor')
    assert.equal(first?.method, 'chest_take', `the chest at hand first, not ${first?.method}`)
    calls.length = 0
    now += 1000; for (const b of bots) driver.observe(b, [foe])
    await driver.turn(bots[0])
    assert.ok(!calls.some(c => c.method === 'chest_take'), 'emptied: the order goes on')
  } finally { Date.now = priorNow }
})

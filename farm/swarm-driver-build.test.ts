// Драйвер роя: стройка — укрытие группы, аренда при долгой кладке, аванпост, отход на безопасную позу, кокон, вода, яма-ловушка.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'

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
test('a bot standing in water clears the source (or swims out) before anything else, once per cooldown', async () => {
  const priorNow = Date.now
  let now = 1000
  Date.now = () => now
  const calls: any[] = []
  const bots: any[] = ['A', 'B'].map(name => ({ name, team: 'blue', c: { async call(method) { calls.push({ who: name, method }); return { detail: method === 'clear_water' ? { ok: true, how: 'убрал воду (ведром)' } : {} } } } }))
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: {}, armor: {}, water: true }, B: { p: { x: 0, y: 64, z: 2 }, hp: 20, inv: {}, armor: {} } }
  const lines: string[] = []
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => ({ x: 0, y: 64, z: 0 }), hostile: () => false, log: (s: string) => lines.push(s), arms: true })
  try {
    for (const b of bots) driver.observe(b, [])
    await driver.turn(bots[0])
    assert.deepEqual(calls.filter(c => c.who === 'A').map(c => c.method), ['clear_water'], 'water first, the turn ends on success')
    assert.ok(lines.some(l => /💧 A: убрал воду/.test(l)))
    now += 1000; await driver.turn(bots[0])
    assert.equal(calls.filter(c => c.method === 'clear_water').length, 1, 'not again within the cooldown')
    await driver.turn(bots[1])
    assert.ok(!calls.some(c => c.who === 'B' && c.method === 'clear_water'), 'a dry bot does not call it')
  } finally { Date.now = priorNow }
})
for (const interrupted of [false, true]) test('яма с места, без похода' + (interrupted ? ', повтор после тактики' : ''), async () => {
  let now = 1000, attempts = 0
  const calls: any[] = [], lines: string[] = []
  const site = { x: 1, y: 63, z: 0, feetY: 64, blocks: ['smooth_sandstone', 'smooth_sandstone'],
    stands: [{ x: 20.5, y: 64, z: .5 }] }
  const bots = ['A', 'B', 'C', 'D'].map(name => ({ name, team: 'blue', c: null as any }))
  const armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  const pos = Object.fromEntries(bots.map((b, i) => [b.name, { p: { x: i ? 10 : .5, y: 64, z: i ? i * 10 : .5 },
    hp: 20, inv: { netherite_sword: 1, netherite_pickaxe: 1 }, armor }]))
  for (const b of bots) b.c = { async call(method, params) {
    calls.push({ method, params })
    if (method === 'status') return { state: { pos: pos[b.name].p } }
    if (method === 'observe') return { status: 'done', state: { tactics: {} } }
    if (method === 'swarm_work') {
      if (interrupted && ++attempts === 1) return { status: 'interrupted', by: { type: 'tactical', requireObservation: true, threatLevel: 2 } }
      return { status: 'done', detail: { ok: true } }
    }
    return { status: 'done', detail: {} }
  } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, aggressive: true,
    arena: { x: 0, y: 64, z: 0, r: 100 }, home: () => pos.A.p, hostile: (_, n) => n === 'Foe',
    digSites: () => [site], log: line => lines.push(line), now: () => now })
  const see = () => driver.observe(bots[0], [{ id: 'Foe', visible: true, position: { x: 5, y: 64, z: .5 },
    equipment: { weapon: 'wooden_sword' } }])
  see()
  await driver.turn(bots[0])
  if (interrupted) { now += 600; see(); await driver.turn(bots[0]); assert.ok(calls.some(c => c.method === 'observe')) }
  assert.equal(calls.some(c => c.method === 'goto' || c.method === 'center_in'), false)
  const work = calls.filter(c => c.method === 'swarm_work')
  assert.equal(work.length, interrupted ? 3 : 2)
  assert.deepEqual(work.slice(-2).map(c => c.params.at), [{ x: 1, y: 63, z: 0 }, { x: 1, y: 62, z: 0 }])
  assert.ok(work.every(c => c.params._hunt && c.params._climb))
  assert.equal(lines.some(l => l.includes('не подошёл')), false)
  now += 600; see(); await driver.turn(bots[0])
  assert.equal(calls.filter(c => c.method === 'swarm_work').length, work.length, 'готовую яму не копать снова')
})
test('отбор ямы: свой пол, вне опоры, в досягаемости нижнего блока', () => {
  const { canDigTrap }: typeof import('../daemon/src/swarm') = require('../daemon/src/swarm')
  const s = { x: 1, y: 63, z: 0, feetY: 64 }
  assert.equal(canDigTrap({ x: .5, y: 64, z: .5 }, s), true)
  assert.equal(canDigTrap({ x: 1.25, y: 64, z: .5 }, s), false)
  assert.equal(canDigTrap({ x: -5, y: 64, z: .5 }, s), false)
  assert.equal(canDigTrap({ x: .5, y: 72, z: .5 }, s), false)
})
test('копку ямы не отбирает обычная тактика; мало хп и аварии снимают защиту', () => {
  const { protectedClimb }: typeof import('../daemon/src/reflex-lock') = require('../daemon/src/reflex-lock')
  const s: any = { current: { name: 'swarm_work', params: { kind: 'dig', _climb: true }, ctl: { aborted: false } },
    bot: { health: 20, entity: {} }, cfg: { lowHealth: 8 }, tactics: { snapshot: () => ({ state: {} }) } }
  assert.equal(protectedClimb(s), true)
  s.bot.health = 8; assert.equal(protectedClimb(s), false)
  s.bot.health = 20; s.tactics.snapshot = () => ({ state: { dangerousFall: true } })
  assert.equal(protectedClimb(s), false)
  s.tactics.snapshot = () => ({ state: {} }); delete s.current.params._climb
  assert.equal(protectedClimb(s), false)
})

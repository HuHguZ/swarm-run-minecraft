// Драйвер роя: стройка — укрытие группы, аренда при долгой кладке, аванпост, отход на безопасную позу, кокон, вода, яма-ловушка.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'
import { swarmBuild } from './swarm/swarm-driver/build'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { SwarmBoard } from '../daemon/src/swarm'

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

test('two builders on different tiers share a shelter anchored to the team home floor', async () => {
  const home = { x: 564.5, y: 120, z: 594.5 }, pos: any = {}
  const laid = new Set<string>(), by: string[] = []
  let finish!: () => void
  const placement = new Promise<void>(resolve => { finish = resolve })
  const bots = ['Z', 'Scout', 'Wing', 'Friend'].map((name, i) => {
    pos[name] = { p: i ? { ...home } : { x: 571, y: 124, z: 570 }, hp: 20,
      inv: { iron_pickaxe: 1, iron_sword: 1, cobblestone: 64 }, armor: {} }
    return { name, team: 'red', c: { async call(method, p) {
      if (method === 'goto') {
        // The gallery and square connect by stairs. There is no platform suspended above this team's home.
        pos[name].p = { x: p.x + 1.5, y: home.y, z: p.z + .5 }
        return { status: 'done', detail: { arrived: pos[name].p } }
      }
      if (method !== 'swarm_work' || p.kind !== 'place') return { detail: {} }
      await placement
      const at = p.at, key = (x, y, z) => [x, y, z].join(',')
      const support = at.y === home.y || [[0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]
        .some(([x, y, z]) => laid.has(key(at.x + x, at.y + y, at.z + z)))
      if (!support) return { detail: { done: false, noVisibleSupport: true, viewpoint: pos[name].p } }
      const me = pos[name].p, cell = key(at.x, at.y, at.z)
      assert.ok(Math.hypot(at.x + .5 - me.x, at.y + .5 - (me.y + 1.62), at.z + .5 - me.z) < 4.5)
      assert.equal(laid.has(cell), false)
      laid.add(cell); by.push(name)
      return { detail: { done: true, at, after: p.item } }
    } } }
  })
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arms: true,
    arena: { x: 600.5, y: 120, z: 600.5, r: 80, killY: 113 }, home: () => home, hostile: () => false, log() {} })
  const working = [driver.turn(bots[0])]
  try {
    await new Promise(setImmediate)
    working.push(driver.turn(bots[3]))
    await new Promise(setImmediate)
    const claims = driver.snapshot().red.tasks.filter(t => t.data?.blueprint === 'shelter' && t.status === 'claimed')
    assert.deepEqual(claims.map(t => t.claim.owner).sort(), ['Friend', 'Z'])
    assert.equal(new Set(claims.map(t => t.id)).size, 2)
  } finally { finish(); await Promise.all(working) }
  const cells = driver.snapshot().red.tasks.filter(t => t.data?.blueprint === 'shelter')
  assert.equal(cells.length, 55)
  assert.deepEqual([...new Set(cells.map(t => t.position.y))].sort(), [120, 121, 122])
  assert.deepEqual(by.sort(), ['Friend', 'Z'])
  assert.equal(cells.filter(c => c.status === 'done').length, 2)
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
test('two shelter builders can complete unsupported work after a neighbouring receipt', async () => {
  const start = { x: 0, y: 64, z: 0 }, near = { x: 2, y: 64, z: 0 }, beside = { x: 2, y: 64, z: 1 }
  const targets: Record<string, string[]> = { A: [], D: [] }
  const key = p => `${p.x},${p.y},${p.z}`
  let support = false, finish!: () => void
  const bots = ['A', 'B', 'C', 'D'].map(name => ({ name, team: 'blue', c: { async call(method, p) {
    if (method === 'goto') return { status: 'failed' }
    if (method !== 'swarm_work') return { detail: {} }
    targets[name].push(key(p.at))
    const receipt = { detail: { done: true, at: p.at, after: p.item } }
    if (name === 'D' && key(p.at) === key(beside)) {
      return new Promise(resolve => { finish = () => { support = true; resolve(receipt) } })
    }
    if (support && key(p.at) === key(near)) return receipt
    return { detail: { done: false, noVisibleSupport: true, why: 'не к чему прислонить блок: вокруг клетки нет ни одной твёрдой грани' } }
  } } }))
  const pos = Object.fromEntries(bots.map((b, i) => [b.name, {
    p: b.name === 'A' ? { x: 1.4, y: 64, z: .1 } : b.name === 'D' ? { x: 2.8, y: 64, z: 1 } : { x: -8, y: 64, z: i },
    inv: { iron_sword: 1, iron_pickaxe: 1, cobblestone: 64 }, hp: 20, armor: {}
  }]))
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 },
    home: () => start, hostile: () => false, log() {} })
  const alice = bots[0], dan = bots[3]
  // All 15 base cells lack a face from A. Try each and stop; wall tops and roof still depend on receipts.
  for (let i = 0; i < 18; i++) await driver.turn(alice)
  assert.equal(targets.A[0], key(near))
  assert.equal(targets.A.length, 15)
  assert.equal(new Set(targets.A).size, 15)
  const pending = driver.turn(dan)
  try {
    await new Promise(setImmediate)
    assert.deepEqual(targets.D, [key(beside)], 'a second builder can try the same cells from its own viewpoint')
    await driver.turn(alice)
    assert.equal(targets.A.length, 15, 'an outstanding claim supplies no physical face')
  } finally { finish?.(); await pending }
  for (let i = 0; i < 5; i++) await driver.turn(alice)
  const completed = driver.snapshot().blue.tasks.filter(t => t.kind === 'build' && t.status === 'done').map(t => key(t.position)).sort()
  assert.deepEqual(completed, [key(near), key(beside)].sort())
  assert.equal(targets.A.filter(cell => cell === key(near)).length, 2)
  assert.equal(targets.A.filter(cell => cell === '-2,64,0').length, 1, 'no retry at a distant unsupported cell')
})

test('a builder waiting on a neighbour can try its original wall again after the helper cancels', async () => {
  const wall = { x: 2, y: 64, z: 0 }, neighbour = { ...wall, z: 1 }
  const near = p => p.x === wall.x && p.y === wall.y && p.z === wall.z
  let release, arrived, calls = 0, cancelled = false
  const started = new Promise<void>(r => { arrived = r })
  const hold = new Promise<void>(r => { release = r })
  const bots = ['A','B','C','D'].map(name => ({ name, team: 'blue', c: { async call(method, p) {
    if (method !== 'swarm_work') return { detail: {} }
    if (name === 'D') {
      assert.deepEqual(p.at, neighbour); arrived(); await hold
      return { detail: { done: false, aborted: true, why: 'cancelled' } }
    }
    if (near(p.at)) {
      calls++
      if (cancelled) return { detail: { done: true, at: p.at, after: p.item } }
      return { detail: { noVisibleSupport: true, reachableNeighbours: [neighbour] } }
    }
    return { detail: { noVisibleSupport: true } }
  } } }))
  const pos = Object.fromEntries(bots.map((b, i) => [b.name, { hp: 20, inv: { dirt: 8, iron_pickaxe: 1, iron_sword: 1 }, armor: {},
    p: b.name === 'A' ? { x: 1.4, y: 64, z: .1 } : b.name === 'D' ? { x: 2.8, y: 64, z: 1 } : { x: -8, y: 64, z: i } }]))
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 },
    home: () => ({ x: 0, y: 64, z: 0 }), hostile: () => false, log() {} })
  const helper = driver.turn(bots[3])
  try {
    await Promise.race([started, helper])
    await driver.turn(bots[0]); await driver.turn(bots[0])
    assert.equal(calls, 1)
  } finally { cancelled = true; release(); await helper }
  await driver.turn(bots[0])
  assert.equal(calls, 2)
  assert.ok(driver.snapshot().blue.tasks.some(t => t.status === 'done' && near(t.position)))
})
test('a late witness of different masonry cannot overwrite the next builder’s live claim', async () => {
  const realNow = Date.now; let now = realNow()
  Date.now = () => now
  let releaseA, releaseD
  const calls = new Map()
  const home = { x: 0, y: 64, z: 0 }
  const bots = ['A', 'B', 'C', 'D'].map(name => ({ name, team: 'blue', c: { async call(method, p) {
    if (method !== 'swarm_work') return { detail: {} }
    calls.set(name, p.at)
    await new Promise(resolve => { if (name === 'A') releaseA = resolve; else releaseD = resolve })
    return { detail: name === 'A'
      ? { done: true, at: p.at, after: 'sandstone', before: 'sandstone', already: true, confirmation: 'visible_existing' }
      : { done: true, at: p.at, after: p.item } }
  } } }))
  const pos = Object.fromEntries(bots.map(b => [b.name, { p: { x: 1.4, y: 64, z: .1 }, hp: 20,
    inv: { cobblestone: 64, iron_pickaxe: 1, iron_sword: 1 }, armor: {} }]))
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { ...home, r: 24 }, home: () => home, hostile: () => false, log() {} })
  let alice, dan
  try {
    alice = driver.turn(bots[0]); await new Promise(setImmediate)
    assert.ok(releaseA)
    now += 25001
    dan = driver.turn(bots[3]); await new Promise(setImmediate)
    assert.ok(releaseD)
    assert.deepEqual(calls.get('A'), calls.get('D'))
    releaseA(); await alice
    assert.equal(driver.snapshot().blue.tasks.find(t => t.claim?.owner === 'D')?.data.block, 'cobblestone')
    releaseD(); await dan
    assert.equal(driver.snapshot().blue.tasks.find(t => t.kind === 'build' && t.status === 'done')?.data.block, 'cobblestone')
  } finally { releaseA?.(); releaseD?.(); await Promise.all([alice, dan]); Date.now = realNow }
})
function singleBuildCell(afterFailure?: (state: any) => void) {
  const pos: any = { A: { p: { x: 0, y: 64, z: 0 }, inv: { stone: 8 } } }, attempts: string[] = []
  const board = new SwarmBoard('blue', () => 100)
  const member = { id: 'A', team: 'blue', health: 20, strength: 1, role: 'miner-builder' as const, position: pos.A.p, inventory: pos.A.inv }
  board.setMembers([member])
  let success = false
  const bot = { name: 'A', c: { async call(method, p) {
    if (method !== 'swarm_work') return { detail: {} }
    attempts.push(`${p.at.x},${p.at.y},${p.at.z}`)
    return { detail: success ? { done: true, at: p.at, after: p.item } :
      { done: false, noVisibleSupport: true, viewpoint: { ...pos.A.p } } }
  } } }
  const sw: any = { pos, now: () => 100, alive: () => true, bots: [bot], blueprints: new Map(), placed: new Map(), telemetry: { built: 0 },
    buildGo: async () => { afterFailure?.(pos.A); return {} }, log() {}, say() {}, detail: r => r?.detail || {},
    renew: (board, bot, cell) => board.renew(cell.id, bot.name, cell.claim.token, 25000) }
  Object.assign(sw, swarmRetry(sw))
  const { buildStep } = swarmBuild(sw)
  return { attempts, sw, success: () => { success = true }, step: (id = 'gate', x = 1) => {
    const at = { x, y: 64, z: 0 }
    return buildStep(bot, { board, member: { ...member, position: pos.A.p }, members: [member] }, { kind: 'cutoff', id, origin: at, cells: [{ at }] })
  } }
}
test('a failed face belongs to the worker viewpoint, even after an unsuccessful approach moves the body', async () => {
  const f = singleBuildCell(body => { body.p = { x: 2.5, y: 64, z: 0 } })
  await f.step()
  f.success()
  await f.step()
  assert.equal(f.sw.telemetry.built, 1)
})
test('a replacement blueprint at the same coordinates can retry independently', async () => {
  const f = singleBuildCell()
  await f.step()
  await f.step('other', -1)
  f.success()
  await f.step()
  assert.deepEqual(f.attempts, ['1,64,0', '-1,64,0', '1,64,0'])
  assert.equal(f.sw.telemetry.built, 1)
})
test('a cocoon roof builder cannot spend blocks on a pillar after a teammate claimed its cell during the approach', async () => {
  let now = 1000, handover, teammate, pillars = 0, finish
  const placing = new Promise<void>(resolve => { finish = resolve })
  const origin = { x: 0, y: 64, z: 0 }, at = { ...origin, y: 66 }
  const board = new SwarmBoard('blue', () => now)
  const members = ['A', 'B'].map(id => ({ id, team: 'blue', role: 'miner-builder' as const, position: origin,
    health: 20, strength: 1, inventory: { stone: 8 } }))
  board.setMembers(members)
  const bots = members.map(m => ({ name: m.id, c: { async call(method, p) {
    if (method === 'swarm_work' && m.id === 'B') { await placing; return { detail: { done: true, at: p.at, after: p.item } } }
    if (method === 'swarm_pillar') pillars++
    return { detail: {} }
  } } }))
  const sw: any = { pos: Object.fromEntries(members.map(m => [m.id, { p: origin, inv: m.inventory }])),
    now: () => now, alive: () => true, bots, teamOf: () => 'blue', blueprints: new Map(), placed: new Map(), telemetry: { built: 0 },
    buildGo: async (_, to) => {
      if (Math.abs(to.x - .5) === 2 && !handover) {
        now += 25001
        teammate = step(1)
        await new Promise(setImmediate)
        handover = board.tasks()[0].claim
        assert.equal(handover?.owner, 'B')
      }
      return { status: 'done', detail: { arrived: to } }
    }, log() {}, say() {}, detail: r => r?.detail || {}, renew: (b, worker, cell) => b.renew(cell.id, worker.name, cell.claim.token, 25000) }
  Object.assign(sw, swarmRetry(sw))
  const { buildStep } = swarmBuild(sw)
  const step = i => buildStep(bots[i], { board, member: members[i], members }, { kind: 'cocoon', origin, cells: [{ at }] })
  try {
    await step(0)
    assert.ok(handover)
    assert.equal(pillars, 0)
    assert.deepEqual(board.tasks()[0].claim, handover)
  } finally { finish(); await teammate }
  assert.equal(sw.telemetry.built, 1)
  assert.equal(board.tasks()[0].status, 'done')
})
test('replacing many blueprints at one site keeps one protected coordinate and no round-long face failures', async () => {
  const f = singleBuildCell()
  for (let i = 0; i < 48; i++) await f.step('abandoned' + i)
  assert.equal(f.sw.retries.size, 0)
  f.success()
  for (let i = 0; i < 48; i++) await f.step('completed' + i)
  assert.equal(f.sw.telemetry.built, 48)
  assert.equal(f.sw.placed.get('blue').size, 1)
})
test('an outpost reuses witnessed stone flooring without requiring stone in its inventory', async () => {
  const calls = [], at = { x: .5, y: 76, z: .5 }
  const bot: any = { name: 'A', team: 'blue', swarmPosition: { purpose: 'build', at, highGround: 4 }, c: { async call(method, params) {
    if (method === 'swarm_pose' && params.outpost && params.cells) return { detail: { cells: params.cells.map(at => ({ at,
      existing: at.y === 75 ? { name: 'stone', solid: true } : { name: 'air', solid: false } })) } }
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
async function placementRetryFixture(reply, poses, blocks = { cobblestone: 64 } as Record<string, number>, existing?: string, intercept?, witnesses = 1) {
  const calls: any[] = [], foe = { x: 8.5, y: 64, z: .5 }
  const armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  const bots = ['A', 'B', 'C', 'D'].map(name => ({ name, team: 'blue', c: null }))
  const pos: any = Object.fromEntries(bots.map((b, k) => [b.name, { p: { x: .5, y: 64, z: .5 + k }, hp: 20, inv: { iron_sword: 1, iron_pickaxe: 1, cobblestone: 64 }, armor }]))
  pos.A.inv = { iron_sword: 1, iron_pickaxe: 1, ...blocks }
  let work = 0, moves = 0
  for (const b of bots) b.c = { async call(method, params) {
    calls.push({ method, params })
    const overridden = intercept?.(method, params)
    if (overridden) return overridden
    if (method === 'goto') { moves++; pos[b.name].p = { x: params.x, y: params.y, z: params.z }; return { detail: { arrived: pos[b.name].p } } }
    if (method === 'swarm_pose' && params.inspectOnly) return { detail: { existing: existing ? { name: existing, solid: true } : { name: 'air', solid: false } } }
    if (method === 'swarm_pose') return { detail: { poses: poses(moves) } }
    if (method === 'swarm_work') return { detail: reply(++work, params, pos[b.name].p) }
    return { detail: {} }
  } }
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 24 }, home: () => pos.A.p, hostile: (_, id) => id === 'Foe', log: () => {} })
  for (const observer of bots.slice(0, witnesses)) {
    driver.observe(observer, [{ id: 'Foe', visible: true, position: foe, equipment: { weapon: 'wooden_sword' } }])
  }
  await driver.turn(bots[0])
  return { calls, snapshot: driver.snapshot().blue, driver, bot: bots[0], pos }
}
test('the normal construction turn leaves an occupied wall cell for later and continues the shared blueprint', async () => {
  let obstacle
  const f = await placementRetryFixture((_, p) => {
    obstacle ??= { ...p.at }
    return p.at.x === obstacle.x && p.at.y === obstacle.y && p.at.z === obstacle.z
      ? { done: false, why: 'occupied_cell', before: 'stone_slab' }
      : { done: true, at: p.at, after: p.item }
  }, () => [])
  await f.driver.turn(f.bot)
  const work = f.calls.filter(c => c.method === 'swarm_work')
  assert.equal(work.length, 2)
  assert.notDeepEqual(work[0].params.at, work[1].params.at)
  const tasks = f.driver.snapshot().blue.tasks.filter(t => t.kind === 'build')
  assert.ok(tasks.some(t => t.status === 'pending' && t.data.obstruction?.block === 'stone_slab'))
  assert.equal(tasks.filter(t => t.status === 'done').length, 1)
})

test('a builder contributes its own solid blocks to an ally’s blueprint and records the actual material', async () => {
  const { calls, snapshot } = await placementRetryFixture((_, p) => p.item === 'oak_planks'
    ? { done: true, at: p.at, after: p.item } : { done: false, why: `нет ${p.item} в инвентаре` }, () => [], { sand: 64, oak_planks: 16 })
  assert.deepEqual(calls.filter(c => c.method === 'swarm_work').map(c => c.params.item), ['oak_planks'])
  const cells = snapshot.tasks.filter(t => t.kind === 'build')
  assert.equal(cells.find(c => c.status === 'done')?.data.block, 'oak_planks')
  assert.ok(cells.some(c => c.status === 'pending' && c.data.block === 'cobblestone'))
})
test('a builder can witness an already placed planned block even when only carrying other materials', async () => {
  const { calls, snapshot } = await placementRetryFixture((_, p) => ({ done: true, at: p.at, after: p.item }), () => [], { oak_planks: 16 }, 'cobblestone')
  assert.deepEqual(calls.filter(c => c.method === 'swarm_work').map(c => c.params.item), ['cobblestone'])
  assert.equal(snapshot.stats.built, 1)
})
test('a missing item reported by the worker makes changing stance pointless', async () => {
  const { calls, snapshot } = await placementRetryFixture((_, p) => ({ done: false, why: `нет ${p.item} в инвентаре` }), () => [{ x: -2.5, y: 64, z: .5 }])
  assert.equal(calls.filter(c => c.method === 'swarm_work').length, 1)
  assert.ok(!calls.some(c => c.method === 'goto' || c.method === 'swarm_pose'))
  assert.equal(snapshot.stats.built, 0)
  assert.ok(!snapshot.tasks.some(t => t.claim))
})
test('receiving a different material reopens building at the same position with the same total block count', async () => {
  let received = false
  const stances: Array<{ x: number; y: number; z: number }> = []
  const f = await placementRetryFixture((_, p, stance) => {
    stances.push({ ...stance })
    return received ? { done: true, at: p.at, after: p.item } : { done: false, why: `нет ${p.item} в инвентаре` }
  }, () => [], undefined, undefined, method => {
    // The builder cannot change stance between the first refusal and the delivery.
    if (method === 'goto' && stances.length) return { status: 'failed', detail: { why: 'noPath' } }
  }, 2)
  await f.driver.turn(f.bot)
  assert.equal(f.calls.filter(c => c.method === 'swarm_work').length, 1)
  delete f.pos.A.inv.cobblestone
  f.pos.A.inv.oak_planks = 64
  received = true
  await f.driver.turn(f.bot)
  assert.deepEqual(f.calls.filter(c => c.method === 'swarm_work').map(c => c.params.item), ['cobblestone', 'oak_planks'])
  assert.deepEqual(stances[1], stances[0])
  assert.equal(f.driver.snapshot().blue.stats.built, 1)
})
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
test('an interrupted builder shares the confirmed last block and leaves without another action', async () => {
  const f = await placementRetryFixture((_, p) => ({ done: true, after: p.item, at: p.at, aborted: true, why: 'direct_threat', safety: 'leave', retreat: { clear: false } }),
    () => [], undefined, undefined, (method, p) => method === 'swarm_pose' && p.placementSafety ? { detail: { safeToResume: false } } : undefined)
  assert.equal(f.snapshot.stats.built, 1)
  assert.equal(f.snapshot.tasks.filter(t => t.status === 'done' && t.kind === 'build').length, 1)
  const afterWork = f.calls.slice(f.calls.findIndex(c => c.method === 'swarm_work') + 1)
  assert.deepEqual(afterWork.map(c => c.method), ['swarm_keep', 'swarm_keep', 'swarm_keep'])
  await f.driver.turn(f.bot)
  assert.equal(f.calls.filter(c => c.method === 'swarm_work').length, 1, 'the receipt cannot make the next unsafe cell eligible')
})

for (const safety of ['leave', 'recover']) test(`a builder respects the native ${safety} and can resume the same cell afterwards`, async () => {
  let safe = false
  const f = await placementRetryFixture((_, p) => safe ? { done: true, at: p.at, after: p.item } :
    { done: false, aborted: true, why: 'direct_threat', safety, retreat: { ok: true } }, () => [{ x: -2.5, y: 64, z: .5 }])
  const work = () => f.calls.filter(c => c.method === 'swarm_work')
  assert.equal(work().length, 1)
  assert.ok(!f.calls.some(c => c.method === 'goto' || c.method === 'swarm_pose'))
  assert.ok(f.snapshot.tasks.every(t => !t.claim))
  safe = true
  await f.driver.turn(f.bot)
  assert.deepEqual(work().map(c => c.params.at), [work()[0].params.at, work()[0].params.at])
  assert.equal(f.driver.snapshot().blue.stats.built, 1)
})

test('a builder whose retreat did not clear contact yields subsequent turns until its own eyes clear the work', async () => {
  let exposed = true
  const f = await placementRetryFixture((_, p) => exposed
    ? { done: false, aborted: true, why: 'direct_threat', safety: 'recover', retreat: { clear: false } }
    : { done: true, at: p.at, after: p.item }, () => [], undefined, undefined, (method, p) => {
    if (method === 'swarm_pose' && p.placementSafety) return { detail: { safeToResume: !exposed } }
    if (method === 'goto') return { status: 'failed', detail: { why: 'noPath' } }
  })
  const work = () => f.calls.filter(c => c.method === 'swarm_work')
  const first = work()[0].params.at
  for (let i = 0; i < 3; i++) await f.driver.turn(f.bot)
  assert.equal(work().length, 1, 'a failed escape must not restart the same placement every turn')
  assert.ok(f.calls.some(c => c.method === 'fight'), 'the ordinary turn can choose another action')
  assert.ok(f.driver.snapshot().blue.tasks.every(t => !t.claim))
  exposed = false
  await f.driver.turn(f.bot)
  assert.deepEqual(work().map(c => c.params.at), [first, first])
  assert.equal(f.driver.snapshot().blue.stats.built, 1)
})

test('blocked builders leave the same shelter cell to a teammate, and start the next round independently', async () => {
  const home = { x: .5, y: 64, z: .5 }, pos: any = {}, work = [], probes = []
  let firstRound = true
  const bots = ['Z', 'Scout', 'Wing', 'Friend'].map(name => {
    pos[name] = { p: { ...home }, hp: 20, inv: { iron_pickaxe: 1, iron_sword: 1, cobblestone: 64 }, armor: {} }
    return { name, team: 'red', c: { async call(method, p) {
      if (method === 'swarm_pose' && p.placementSafety) { probes.push(name); return { detail: { safeToResume: false } } }
      if (method !== 'swarm_work') return { detail: {} }
      work.push({ name, at: p.at })
      return { detail: firstRound && name === 'Z' ? { done: false, aborted: true, why: 'direct_threat', safety: 'leave', retreat: { clear: false } }
        : { done: true, at: p.at, after: p.item } }
    } } }
  })
  const driver = createSwarmDriver({ bots, pos, alive: () => true, arms: true, arena: { x: 0, y: 64, z: 0, r: 24 }, home: () => home, hostile: () => false, log() {} })
  await driver.turn(bots[0]); await driver.turn(bots[0]); await driver.turn(bots[3])
  assert.deepEqual(work, [{ name: 'Z', at: work[0].at }, { name: 'Friend', at: work[0].at }])
  assert.deepEqual(probes, ['Z'])
  driver.reset(); firstRound = false
  await driver.turn(bots[0])
  assert.deepEqual(work.at(-1), { name: 'Z', at: work[0].at })
  assert.equal(probes.length, 1)
  assert.equal(driver.snapshot().red.tasks.filter(t => t.status === 'done').length, 1)
})
test('a tactical interruption while approaching a placement pose yields until the body is available', async () => {
  let held = true, safe = false
  const f = await placementRetryFixture((_, p) => safe ? { done: true, at: p.at, after: p.item } : { done: false },
    () => [{ x: -2.5, y: 64, z: .5 }], undefined, undefined, method => {
      if (method === 'goto' && held) return { status: 'interrupted', by: { type: 'tactical', requireObservation: true } }
      if (method === 'observe') return { status: 'done', state: { tactics: held ? { action: 'escape' } : {} } }
    })
  const work = () => f.calls.filter(c => c.method === 'swarm_work')
  assert.equal(work().length, 1)
  assert.equal(f.calls.at(-1).method, 'goto')
  assert.ok(f.snapshot.tasks.every(t => !t.claim))
  await f.driver.turn(f.bot)
  assert.equal(f.calls.at(-1).method, 'observe')
  assert.equal(work().length, 1)
  const now = Date.now
  try {
    Date.now = () => now() + 600
    safe = true; held = false
    await f.driver.turn(f.bot)
    assert.equal(work().length, 2)
    assert.deepEqual(work()[0].params.at, work()[1].params.at)
    assert.equal(f.driver.snapshot().blue.stats.built, 1)
  } finally { Date.now = now }
})
test('a confirmed placement survives a late tactical interruption without issuing another action', async () => {
  const f = await placementRetryFixture(() => assert.fail('expected the interrupted receipt'), () => [],
    undefined, undefined, (method, p) => {
      if (method === 'swarm_work') return { status: 'interrupted', by: { type: 'tactical' }, partial: true,
        detail: { done: true, at: p.at, after: p.item } }
      if (method === 'observe') return { status: 'done', state: { tactics: { action: 'escape' } } }
    })
  assert.equal(f.snapshot.stats.built, 1)
  await f.driver.turn(f.bot)
  assert.equal(f.calls.at(-1).method, 'observe')
  assert.equal(f.calls.filter(c => c.method === 'swarm_work').length, 1)
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
test('a bot standing in water clears the source (or swims out) before anything else, once per place', async () => {
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
    assert.deepEqual(calls.filter(c => c.who === 'A' && c.method !== 'cache_scan').map(c => c.method), ['clear_water'], 'water first, the turn ends on success')
    assert.ok(lines.some(l => /💧 A: убрал воду/.test(l)))
    now += 1000; await driver.turn(bots[0])
    assert.equal(calls.filter(c => c.method === 'clear_water').length, 1, 'not again from the same place')
    pos.A.p = { x: 3, y: 64, z: 0 }; now += 1000; await driver.turn(bots[0])
    assert.equal(calls.filter(c => c.method === 'clear_water').length, 2, 'moved 3 blocks and still in water: try again')
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

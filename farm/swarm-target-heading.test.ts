import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { createSwarmDriver } from './swarm/swarm-driver'

// cl28i (15×15, 28.10): на сближении в начале раунда цель команды менялась z → d → … — 17 походов разом оборваны за секунду
// («goto → goto (цель z→d)» 26 за раунд), хотя новая цель рядом с прежней и путь лежит туда же.
function walk(next: { x: number, z: number }) {
  const calls: string[] = []
  const b: any = { name: 'A', swarmExecuting: true, swarmTask: { kind: 'goto', data: { target: 'Old' } }, last: { m: 'goto', pending: true },
    c: { call(method) { calls.push(method); return Promise.resolve({}) } } }
  const enemies = [{ id: 'Old', position: { x: 40, y: 64, z: 0 }, seenAt: 0 }, { id: 'New', position: { ...next, y: 64 }, seenAt: 10000 }]
  const sw: any = { generation: 1, now: () => 10000, alive: () => true, pos: { A: { p: { x: 0, y: 64, z: 0 } } }, log() {}, detail: r => r?.detail || r,
    refresh: () => ({ task: { kind: 'goto', data: { target: 'New' } }, board: { enemies: () => enemies } }) }
  return { stopped: swarmTurn(sw).preempt(b), calls }
}

test('смена цели в ту же сторону не рвёт поход; в другую — рвёт', () => {
  assert.equal(walk({ x: 42, z: 4 }).stopped, false, 'новая цель в 4.5 бл. от прежней на 42 бл. пути — тот же путь')
  const away = walk({ x: -40, z: 0 })
  assert.equal(away.stopped, true, 'цель за спиной — новый путь')
  assert.ok(away.calls.includes('stop'))
})

function switchingPlans() {
  let target = 'Old', calls = 0, refreshed = 0
  const stops = []
  const b: any = { name: 'A', swarmExecuting: true, swarmTurnOwner: { cancelled: false },
    swarmTask: { kind: 'goto', data: { target } }, last: { m: 'goto', pending: true },
    c: { call(method) {
      assert.equal(method, 'stop'); calls++
      return new Promise((resolve, reject) => stops.push({ resolve, reject }))
    } } }
  const sw: any = { generation: 4, now: () => 1000, alive: () => true, pos: { A: { p: { x: 0, y: 64, z: 0 } } },
    log() {}, refresh: () => { refreshed++; return { task: { kind: 'goto', data: { target } }, board: { enemies: () => [] } } } }
  const turns = swarmTurn(sw)
  return { b, sw, stops, get calls() { return calls }, get refreshed() { return refreshed },
    plan(id) { target = id; return turns.preempt(b) } }
}

test('replanning a cancelled walk sends one stop until the native walk releases its owner', async () => {
  const f = switchingPlans()
  assert.ok(f.plan('B'))
  f.plan('C'); f.plan('D')
  f.stops[0].resolve({ status: 'done', detail: { stopped: true } })
  await new Promise(setImmediate)
  f.plan('E')
  assert.equal(f.calls, 1)
  assert.equal(f.refreshed, 1)
  f.b.swarmTurnOwner = { cancelled: false }
  f.b.last = { m: 'goto', pending: true }
  assert.ok(f.plan('F'))
  assert.equal(f.calls, 2)
})

test('an undelivered phase stop retries only for the same pending native action and round', async () => {
  for (const change of ['same', 'new action', 'settled', 'new round']) {
    const f = switchingPlans()
    assert.ok(f.plan('B'))
    f.stops[0].reject(new Error('unavailable'))
    await new Promise(setImmediate)
    if (change === 'new action') f.b.last = { m: 'swarm_hold', pending: true }
    if (change === 'settled') f.b.last.pending = false
    if (change === 'new round') f.sw.generation++
    f.plan('B'); f.plan('B')
    assert.equal(f.calls, change === 'same' ? 2 : 1, change)
  }
})

test('an ascent declining the phase stop can release it on the following observation', async () => {
  const f = switchingPlans()
  assert.ok(f.plan('B'))
  f.stops[0].resolve({ status: 'skipped', detail: { why: 'лезу к цели' } })
  await new Promise(setImmediate)
  assert.ok(f.plan('B'))
  f.stops[1].resolve({ status: 'done', detail: { stopped: true } })
  await new Promise(setImmediate)
  assert.equal(f.plan('C'), false)
  assert.equal(f.calls, 2)
})

async function chestRetarget(newX: number, incomingArrow = false, target = 'New') {
  let now = 1000, stops = 0, finish: (status: string) => void
  const at = { x: 1, y: 64, z: 0 }, log: string[] = []
  const bot: any = { name: 'A', team: 'blue', c: { async call(method, params) {
    if (method === 'blocks_around') return { detail: { found: [at] } }
    if (method === 'chest_take') {
      const op = bot.last = { m: method, p: params, pending: true }
      return new Promise(resolve => { finish = status => {
        op.pending = false
        resolve({ status, detail: status === 'done' ? { at, contents: {}, took: { golden_apple: 1 } } : {} })
      } })
    }
    if (method === 'stop') { stops++; finish?.('interrupted') }
    return { status: 'done', detail: {} }
  } } }
  const me = { x: .5, y: 64, z: .5 }
  const pos = { A: { p: me, hp: 20, inv: { diamond_sword: 1 }, armor: { torso: 'diamond_chestplate' } } }
  const driver = createSwarmDriver({ bots: [bot], pos, alive: () => true, arms: true,
    arena: { x: 0, y: 64, z: 0, r: 90 }, home: () => me, hostile: (_, id) => id !== 'A',
    chestTops: [at], now: () => now, log: line => log.push(line) })
  const see = (id: string, x: number) => driver.observe(bot, [{ id, visible: true, position: { x, y: 64, z: 0 }, equipment: { weapon: 'wooden_sword' } }])
  see('Old', 56)
  const turn = driver.turn(bot)
  try {
    await new Promise(setImmediate)
    assert.equal(bot.swarmTask?.data?.target, 'Old', log.join('\n'))
    assert.equal(bot.last?.m, 'chest_take', log.join('\n'))
    now += 2000
    if (incomingArrow) bot.arrowThreat = { active: true, at: now }
    see(target, newX)
  } finally { finish?.('done'); await turn }
  return { stops, log, tasks: driver.snapshot().blue.tasks }
}
test('a nearby chest can finish while the swarm switches between distant targets', async () => {
  const result = await chestRetarget(-32)
  assert.equal(result.stops, 0, result.log.join('\n'))
  assert.ok(result.tasks.some(t => t.id === 'chest:1,64,0' && t.status === 'done'))
  assert.ok(result.log.some(l => l.includes('chest:1,64,0 +1')))
})
test('switching to a nearby threat still interrupts chest collection', async () => {
  const result = await chestRetarget(-3)
  assert.equal(result.stops, 1, result.log.join('\n'))
  assert.ok(!result.tasks.some(t => t.id === 'chest:1,64,0' && t.status === 'done'))
})
test('incoming arrows interrupt chest collection even when the new target is far', async () => {
  const result = await chestRetarget(-32, true)
  assert.equal(result.stops, 1, result.log.join('\n'))
  assert.ok(!result.tasks.some(t => t.id === 'chest:1,64,0' && t.status === 'done'))
})
test('the current enemy reaching the chest also interrupts without requiring a target change', async () => {
  const result = await chestRetarget(4, false, 'Old')
  assert.equal(result.stops, 1, result.log.join('\n'))
  assert.ok(!result.tasks.some(t => t.id === 'chest:1,64,0' && t.status === 'done'))
})

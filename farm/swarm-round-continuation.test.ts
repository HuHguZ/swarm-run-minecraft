import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'
import { swarmLifecycle } from './swarm/swarm-driver/lifecycle'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { SwarmBoard } from '../daemon/src/swarm/board'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve: (value: any) => void
  let reject: (reason: any) => void
  const promise = new Promise<any>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve: (value: any) => resolve(value), reject: (reason: any) => reject(reason) }
}

function fixture(deferBot = 'Healer', deferMethod = 'goto') {
  let clock = 1000
  const calls: any[] = [], pending = deferred()
  const armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  const bots: any[] = ['Patient', 'Healer'].map(name => ({ name, team: 'blue', c: { call(method, params) {
    calls.push({ bot: name, method, params })
    if (name === deferBot && method === deferMethod) return pending.promise
    return Promise.resolve({ status: 'done', detail: {} })
  } } }))
  const pos: any = {
    Patient: { p: { x: 12, y: 64, z: 0 }, hp: 3, armor, inv: { netherite_sword: 1 } },
    Healer: { p: { x: 0, y: 64, z: 0 }, hp: 20, armor,
      inv: { netherite_sword: 1, splash_potion: 1 }, potions: { splash_healing: 1 } }
  }
  const dead = new Set<string>()
  const driver = createSwarmDriver({ bots, pos, alive: name => !dead.has(name), arena: { x: 0, y: 64, z: 0, r: 100 },
    home: () => pos.Healer.p, hostile: () => false, log() {}, now: () => clock })
  return { calls, pending, bots, pos, driver, healer: bots[1], kill: name => dead.add(name), advance: () => { clock += 1000 } }
}

test('a current-round healer still approaches and heals', async () => {
  const f = fixture(), turn = f.driver.turn(f.healer)
  await flush()
  assert.deepEqual(f.calls.map(c => c.method), ['goto'])
  assert.equal(f.healer.swarmTask.kind, 'heal')
  f.pending.resolve({ status: 'done', detail: { arrived: true } })
  await turn
  assert.deepEqual(f.calls.map(c => c.method), ['goto', 'assist'])
})

test('a same-phase refresh and task copy keep the current healer approach valid', async () => {
  const f = fixture(), turn = f.driver.turn(f.healer)
  await flush()
  f.advance()
  f.driver.observe(f.healer, [])
  assert.equal(f.calls.some(c => c.method === 'stop'), false)
  f.healer.swarmTask = { ...f.healer.swarmTask, data: { ...f.healer.swarmTask.data } }
  f.pending.resolve({ status: 'done', detail: { arrived: true } })
  await turn
  assert.deepEqual(f.calls.map(c => c.method), ['goto', 'assist'])
})

test('a healer that died during its approach cannot send the old heal', async () => {
  const f = fixture(), turn = f.driver.turn(f.healer)
  await flush()
  f.kill('Healer')
  f.pending.resolve({ status: 'done', detail: { arrived: true } })
  await turn
  assert.deepEqual(f.calls.map(c => c.method), ['goto'])
})

test('a rejected approach releases ownership and the next turn can run', async () => {
  const f = fixture(), turn = f.driver.turn(f.healer)
  await flush()
  f.pending.reject(new Error('transport lost'))
  await assert.rejects(turn, /transport lost/)
  assert.equal(f.healer.swarmTurnOwner, undefined)
  assert.equal(f.healer.swarmExecuting, undefined)
  await assert.rejects(f.driver.turn(f.healer), /transport lost/)
  assert.equal(f.calls.filter(c => c.method === 'goto').length, 2)
  assert.equal(f.healer.swarmTurnOwner, undefined)
})

test('a healer stopped by the real same-round preempt cannot resume its old heal', async () => {
  const f = fixture(), turn = f.driver.turn(f.healer)
  await flush()
  assert.equal(f.healer.swarmTask.kind, 'heal')
  f.pos.Healer.hp = 1
  f.advance()
  f.driver.observe(f.healer, [])
  assert.equal(f.calls.at(-1).method, 'stop')
  assert.equal(f.healer.swarmTask.kind, 'recover')
  const cutoff = f.calls.length
  f.pending.resolve({ status: 'interrupted', by: { method: 'stop' }, detail: { interrupted: true } })
  await turn
  assert.deepEqual(f.calls.slice(cutoff), [])
})

for (const [actor, method, task] of [['Healer', 'goto', 'heal'], ['Patient', 'goto', 'recover'], ['Healer', 'clear_water', 'heal']]) {
  test(`a late ${method} reply cannot continue the old ${task} after reset`, async () => {
    const f = fixture(actor, method), b = f.bots.find(b => b.name === actor)
    if (method === 'clear_water') f.pos.Healer.water = true
    const turn = f.driver.turn(b)
    await flush()
    assert.equal(b.swarmTask.kind, task)
    assert.equal(f.calls.at(-1).method, method)
    f.driver.reset()
    const cutoff = f.calls.length
    f.pos.Patient.hp = 20
    f.pos.Patient.p = { x: -20, y: 120, z: 0 }
    f.pending.resolve({ status: 'done', detail: { ok: false, observed: true, candidates: [] } })
    await turn
    assert.deepEqual(f.calls.slice(cutoff), [])
  })
}

test('a pending turn retains its ownership across reset until its continuation settles', async () => {
  const f = fixture(), old = f.driver.turn(f.healer)
  await flush()
  assert.equal(f.healer.swarmExecuting, true)
  f.driver.reset()
  f.pos.Patient.hp = 3
  const next = f.driver.turn(f.healer)
  await flush()
  try {
    assert.equal(f.calls.filter(c => c.method === 'goto').length, 1, 'a second turn cannot overlap the old cleanup')
    assert.equal(f.healer.swarmExecuting, true)
  } finally {
    f.pending.resolve({ status: 'done', detail: { arrived: true } })
    await Promise.all([old, next])
  }
  assert.equal(f.healer.swarmExecuting, undefined)
})

test('a stale bait approach cannot eat in the next round', async () => {
  const calls: any[] = [], pending = deferred(), at = { x: 0, y: 64, z: 0 }
  const b: any = { name: 'A', team: 'blue', c: { call(method, params) {
    calls.push({ method, params }); return Promise.resolve({ status: 'done', detail: {} })
  } } }
  const sw: any = createDriverState({ bots: [b], pos: { A: { p: at, hp: 20, inv: {} } }, alive: () => true,
    arena: { x: 0, y: 64, z: 0, r: 100 }, log() {}, home: () => at })
  Object.assign(sw, swarmRetry(sw), { go: () => { calls.push({ method: 'goto' }); return pending.promise }, detail: r => r?.detail || r || {} })
  const turn = swarmTurnWork(sw).turnGoto({ b, context: {}, task: { kind: 'goto', position: { x: 10, y: 64, z: 0 }, data: { bait: true } },
    round: 0, m: sw.pos.A, enemies: [], contact: false } as any)
  await flush()
  assert.equal(calls.at(-1).method, 'goto')
  swarmLifecycle(sw).reset()
  const cutoff = calls.length
  pending.resolve({ status: 'done', detail: { arrived: true } })
  await turn
  assert.deepEqual(calls.slice(cutoff), [])
})

test('a stale dig approach cannot replace the new round reply or discard its plan', async () => {
  const pending = deferred(), calls: string[] = [], at = { x: 5, y: 64, z: .5 }
  const task: any = { id: 'dig:A', kind: 'goto', position: { x: 0, y: 63, z: 0 },
    data: { dig: '0,63,0', undermine: true, stands: [{ x: 1.5, y: 64, z: .5 }] } }
  const b: any = { name: 'A', team: 'blue', swarmTask: task, c: { call(method) {
    calls.push(method)
    return method === 'goto' ? pending.promise : Promise.resolve({ state: { pos: at } })
  } } }
  const sw: any = createDriverState({ bots: [b], pos: { A: { p: at, hp: 20, inv: {} } }, alive: () => true,
    arena: { x: 0, y: 64, z: 0, r: 100 }, log() {}, home: () => at })
  Object.assign(sw, swarmRetry(sw), { detail: r => r?.detail || r || {}, teamOf: () => 'blue' })
  const board = new SwarmBoard('blue', () => 1000)
  sw.boards.set('blue', board)
  const turn = swarmTurnWork(sw).turnDig({ b, context: { members: [] }, board, task, round: 0, m: sw.pos.A } as any)
  await flush()
  assert.deepEqual(calls, ['status', 'goto'])
  swarmLifecycle(sw).reset()
  const cutoff = calls.length
  const current = {}, reply = { status: 'current-round' }
  sw.planned.set('blue', current)
  b.swarmFightReply = reply
  pending.resolve({ status: 'interrupted', by: 'old-round' })
  await turn
  assert.equal(b.swarmFightReply, reply)
  assert.equal(sw.planned.get('blue'), current)
  assert.equal(sw.cooldown.has('fight:A'), false)
  assert.deepEqual(calls.slice(cutoff), [])
})

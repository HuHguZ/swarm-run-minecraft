import test from 'node:test'
import assert from 'node:assert/strict'
import { observationMethods } from '../daemon/src/rpc/observation'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'
import { installSight, watchAlarm, watchStatus } from './arena/watch'

test('status distinguishes the active autonomous rescue from an ordinary or finished flight', async () => {
  const session: any = { current: { name: 'fly_to', params: { rescue: true }, ctl: { aborted: false } },
    immediate: async fn => ({ detail: await fn() }) }
  const rpc = observationMethods({ session, cfg: {} } as any)
  assert.equal((await rpc.status({})).detail.rescuing, true)
  session.current.ctl.aborted = true
  assert.equal((await rpc.status({})).detail.rescuing, false)
  session.current.ctl.aborted = false; session.current.params.rescue = false
  assert.equal((await rpc.status({})).detail.rescuing, false)
  session.current = null
  assert.equal((await rpc.status({})).detail.rescuing, false)
})

test('a busy rescue is not a failed perch and does not issue another escape order', async () => {
  const calls: string[] = [], m: any = { p: { x: 0, y: 64, z: 0 }, inv: { elytra: 1, firework_rocket: 10 } }
  const b: any = { name: 'A', c: { async call(method) { calls.push(method); return { status: 'failed', code: 'RESCUE_BUSY' } } } }
  const sw: any = { generation: 1, now: () => 1000, alive: () => true, pos: { A: m }, blocked: () => false,
    detail: r => r.detail || r, failed() { throw Error('rescue is not terrain failure') }, log() { throw Error('rescue is not a new flight attempt') } }
  const board = { recordFact() { throw Error('do not blacklist the requested perch') } }
  await swarmTurnTasks(sw).turnFlee({ b, board, round: 1, m, task: { position: { x: 20, y: 80, z: 0 }, data: { perch: true } },
    enemies: [], context: { members: [] } } as any)
  assert.deepEqual(calls, ['fly_to'])
})

test('rescue ownership blocks plan preemption and new turns, then releases with the next status', async () => {
  const calls: string[] = [], m: any = { rescuing: true }, b: any = { name: 'A', swarmExecuting: true,
    swarmTask: { kind: 'fight' }, c: { call: async method => { calls.push(method) } } }
  let refreshes = 0
  const sw: any = { now: () => 1000, alive: () => true, pos: { A: m }, refresh() { refreshes++; return { member: null } } }
  const actions = swarmTurn(sw)
  assert.equal(actions.preempt(b), false)
  await actions.turn(b)
  assert.equal(refreshes, 0); assert.deepEqual(calls, [])
  m.rescuing = false
  await actions.turn(b)
  assert.equal(refreshes, 1)
})

test('the first RESCUE_BUSY reply reaches the driver before the next periodic status', async () => {
  const b: any = { name: 'A', team: 'blue', c: { call: async () => ({ status: 'failed', code: 'RESCUE_BUSY' }) } }
  const ctx: any = { i: 31, arms: false, bots: [b], names: ['A'], pos: { A: { p: { x: 0, y: 64, z: 0 } } },
    humans: {}, X: 0, Y: 64, Z: 0, R: 24, rcon() {}, log() {}, alive: () => true, deathAt: {}, home: () => '0 0', hostile: () => true }
  installSight(ctx)
  assert.equal((await b.c.call('fly_to', { at: { x: 20, y: 80, z: 0 } })).code, 'RESCUE_BUSY')
  assert.equal(ctx.pos.A.rescuing, true)
  assert.equal(b.last.pending, false)
})

test('the arena status, panic, proximity alarm and freeze watcher respect native rescue ownership', async t => {
  let now = 1000, rescuing = true
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setInterval', fn => fn as any)
  const calls: string[] = [], p = { x: 0, y: 64, z: 0 }
  const b: any = { name: 'A', team: 'blue', swarmTask: { kind: 'fight' },
    last: { m: 'chest_take', pending: true, at: 0, p: {} }, c: { async call(method) {
      calls.push(method)
      return { state: { pos: p, health: 20, inventory: {}, clock: { ticks: now / 50 } }, detail: { rescuing, sightings: [] } }
    } } }
  const ctx: any = { bots: [b], names: ['A'], pos: { A: { p, hp: 20, inv: {}, frameAt: now, observedAt: now } },
    busy: new Set(), out: new Set(), deadNow: new Set(), labNeed: {}, deathAt: {}, rel: {}, humans: {}, round: 1, between: false,
    teams: false, arms: false, X: 0, Y: 64, Z: 0, STOPF: 'codex-lab/no-such-rescue-stop', teamOf: () => 'blue', alive: () => true,
    log() {}, readDeaths() {}, enemiesOf: () => [{ n: 'Enemy', d: 1, spd: 5.6, human: true }],
    swarmDriver: { observe() {}, panic: () => true, release: () => { calls.push('release') } } }
  const timers: any = watchStatus(ctx), alarm = watchAlarm(ctx) as unknown as () => void
  timers.poll(); await new Promise(r => setImmediate(r))
  assert.equal(ctx.pos.A.rescuing, true)
  alarm(); timers.frozenT(); now += 11000; timers.frozenT()
  assert.deepEqual(calls, ['status'])
  rescuing = false
  timers.poll(); await new Promise(r => setImmediate(r))
  assert.equal(ctx.pos.A.rescuing, false)
  assert.deepEqual(calls, ['status', 'status', 'release', 'stop'], 'ordinary panic resumes after the actual rescue ends')
})

test('a stale ascent cannot stop rescue before the general freeze guard; an ordinary stalled ascent still stops', t => {
  t.mock.method(globalThis, 'setInterval', fn => fn as any)
  for (const rescuing of [true, false]) {
    const calls: string[] = [], now = Date.now(), p = { x: 0, y: 64, z: 0 }
    const b: any = { name: 'A', climbing: true, swarmAscent: { to: { x: 0, y: 80, z: 0 }, left: 16, y: 64, blocks: 0,
      progressAt: 0, frame: 1, pending: true, stalled: true }, last: { m: 'goto', pending: true, p: { _climb: true } },
      arrowThreat: { active: true, at: now }, c: { call: async method => { calls.push(method) } } }
    const ctx: any = { bots: [b], names: ['A'], pos: { A: { p, inv: {}, rescuing, observedAt: now, frameAt: now, frame: 2 } },
      busy: new Set(), out: new Set(), deadNow: new Set(), labNeed: {}, deathAt: {}, rel: {}, humans: {}, round: 1,
      between: false, teams: false, arms: false, alive: () => true, log() {}, STOPF: 'codex-lab/no-such-rescue-stop' }
    const timers: any = watchStatus(ctx)
    timers.frozenT()
    assert.deepEqual(calls, rescuing ? [] : ['stop'])
  }
})

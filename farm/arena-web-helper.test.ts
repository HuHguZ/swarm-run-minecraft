import test from 'node:test'
import assert from 'node:assert/strict'
import { installDangers } from './arena/dangers'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'

const settle = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  const calls: any[] = []
  const body = (name, x, inv): any => ({ name, team: 'blue', last: { m: 'goto', pending: false }, c: { call(method, params) {
    if (method === 'swarm_pose') return Promise.resolve({ detail: { existing: { name: 'air', solid: false } } })
    const actor = ctx.bots.find(o => o.name === name)
    const action = method === 'stop' ? null : (actor.last = { m: method, p: params, pending: true })
    return new Promise(resolve => calls.push({ name, method, params, reply: detail => {
      if (action) action.pending = false
      resolve({ status: 'done', detail })
    } }))
  } }, x, inv })
  const a = body('A', 0, {}), b = body('B', 6, { iron_sword: 1 })
  const ctx: any = { round: 1, bots: [a, b], pos: Object.fromEntries([a, b].map(o => [o.name, { p: { x: o.x, y: 64, z: 0 }, inv: o.inv }])),
    busy: new Set(), out: new Set(), deadNow: new Set(), alive: name => !ctx.out.has(name) && !ctx.deadNow.has(name),
    enemiesOf: () => [], swarmDriver: { panic: () => false, canEngage: () => true }, log() {} }
  installDangers(ctx)
  let observedAt = Date.now()
  const report = (web, dangers = {}) => a.c.onDanger({ pos: ctx.pos.A.p, observedAt: ++observedAt,
    dangers: { web: web ? [{ at: { x: 0, y: 64, z: 0 }, cells: 1 }] : [], ...dangers } })
  return { a, b, ctx, calls, report }
}

for (const change of ['round', 'victim death', 'helper death', 'web ended']) test(`late helper approach cannot start cutting after ${change}`, async () => {
  const f = fixture(); f.report(true)
  const approach = f.calls.find(c => c.name === 'B' && c.method === 'goto')
  assert.ok(approach)
  if (change === 'round') f.ctx.round++
  if (change === 'victim death') f.ctx.deadNow.add('A')
  if (change === 'helper death') f.ctx.deadNow.add('B')
  if (change === 'web ended') f.report(false)
  approach.reply({ ok: true }); await settle()
  assert.equal(f.calls.filter(c => c.name === 'B' && c.method === 'cut_ally_web').length, 0)
  assert.equal(f.b.webRescue, null)
  assert.equal(f.a.webHelper, null)
})

for (const state of ['walking', 'new owner', 'gliding victim']) test('a freed ally recalls only their own rescue walk: ' + state, async () => {
  const f = fixture()
  f.report(true)
  const walk = f.calls.find(c => c.name === 'B' && c.method === 'goto')
  assert.ok(walk)
  if (state === 'new owner') f.b.last = { m: 'goto', pending: true }
  if (state === 'gliding victim') f.ctx.pos.A.gliding = true
  f.report(false); f.report(false)
  assert.equal(f.calls.filter(c => c.name === 'B' && c.method === 'stop').length, state === 'new owner' ? 0 : 1)
  walk.reply({ ok: false }); await settle()
  assert.equal(f.calls.some(c => c.name === 'B' && c.method === 'cut_ally_web'), false)
  assert.equal(f.ctx.busy.has('B'), false)
})

for (const state of ['emergency', 'dangerous retreat', 'mace defense']) test('a web distress call preserves an ally in ' + state, () => {
  const f = fixture()
  if (state === 'emergency') f.ctx.pos.B.tactics = { owner: 'Emergency' }
  if (state === 'mace defense') f.b.maceDefense = { round: 1, until: Date.now() + 2000 }
  if (state === 'dangerous retreat') {
    f.b.last = { m: 'flee', pending: true }
    f.ctx.swarmDriver.panic = actor => actor === f.b
  }
  f.report(true)
  assert.equal(f.calls.some(c => c.name === 'B'), false)
  assert.ok(f.calls.some(c => c.name === 'A' && c.method === 'clear_web'))
})

test('one failed helper is not called repeatedly in the same web', async () => {
  const f = fixture(); f.report(true)
  f.calls.find(c => c.name === 'B' && c.method === 'goto').reply({ ok: false }); await settle()
  f.calls.find(c => c.name === 'B' && c.method === 'cut_ally_web').reply({ ok: false, why: 'не достаю' }); await settle()
  for (let i = 0; i < 20; i++) { f.report(true); await settle() }
  assert.equal(f.calls.filter(c => c.name === 'B' && c.method === 'goto').length, 1)
})

test('the helper keeps approaching when the upper web clears but the victim is still trapped at the pickup', async t => {
  const f = fixture()
  const tick = require('../daemon/test/tick-plugins-fixture') as typeof import('../daemon/test/tick-plugins-fixture')
  const { dangers } = require('../daemon/src/threats') as typeof import('../daemon/src/threats')
  const victim = tick.install(tick.testClock())
  t.after(() => victim.emit('end'))
  victim.entity.position.set(.5, 64, .5)
  f.ctx.pos.A.p = victim.entity.position
  let upper = true
  victim.blockAt = p => tick.block(p.x === 0 && p.z === 0 && (p.y === 64 || upper && p.y === 65) ? 'cobweb' : 'air', p.floored())
  const report = () => f.report(true, { web: dangers(victim, { foes: [] }).web })
  report()
  const approach = f.calls.find(c => c.name === 'B' && c.method === 'goto')
  upper = false
  report()
  assert.deepEqual(f.calls.filter(c => c.name === 'B').map(c => c.method), ['goto'])
  approach.reply({ arrived: { x: 2, y: 64, z: 0 } }); await settle()
  const cut = f.calls.find(c => c.name === 'B' && c.method === 'cut_ally_web')
  assert.equal(cut?.params.target, 'A')
  cut.reply({ ok: true, cut: 1 }); await settle()
  assert.equal(f.b.webRescue, null)
})

test('web contact beyond the original pickup cancels the old approach', async () => {
  const f = fixture()
  f.report(true)
  const approach = f.calls.find(c => c.name === 'B' && c.method === 'goto')
  f.ctx.pos.A.p.x = 9
  f.report(true, { web: [{ at: { x: 9, y: 64, z: 0 }, cells: 1 }] })
  assert.equal(f.calls.filter(c => c.name === 'B' && c.method === 'stop').length, 1)
  approach.reply({ ok: false }); await settle()
  assert.ok(!f.calls.some(c => c.method === 'cut_ally_web'))
  f.report(true, { web: [{ at: { x: 9, y: 64, z: 0 }, cells: 1 }] })
  assert.ok(f.calls.some(c => c.name === 'B' && c.method === 'cut_ally_web'))
})

test('a fresh web at the same pickup cannot revive an approach already cancelled on release', async () => {
  const f = fixture()
  f.report(true)
  const old = f.calls.find(c => c.name === 'B' && c.method === 'goto')
  f.report(false)
  f.report(true)
  old.reply({ arrived: f.ctx.pos.A.p }); await settle()
  assert.deepEqual(f.calls.filter(c => c.name === 'B').map(c => c.method), ['goto', 'stop'])
  f.report(true)
  assert.equal(f.calls.filter(c => c.name === 'B' && c.method === 'goto').length, 2)
})

test('a helper approaches the reported gallery with the arena boundary and lethal floor', () => {
  const f = fixture()
  Object.assign(f.ctx, { X: 0, Y: 64, Z: 0, R: 24, arms: true, L: { y0: 0 } })
  f.ctx.pos.A.p.y = 72
  f.report(true, { web: [{ at: { x: 0, y: 72, z: 0 }, cells: 1 }] })
  const { params } = f.calls.find(c => c.name === 'B' && c.method === 'goto')
  assert.equal(params.y, 72)
  assert.equal(params.exactY, true)
  assert.equal(params.climb, true)
  assert.equal(params.arena.killY, 61)
  assert.equal(params.arena.r, 24)
})

test('a helper that could not reach the web can cut on passing the still-trapped ally later', async () => {
  const f = fixture()
  f.ctx.pos.B.p.x = 11
  f.report(true)
  f.calls.find(c => c.name === 'B' && c.method === 'goto').reply({ ok: false }); await settle()
  f.calls.find(c => c.name === 'B' && c.method === 'cut_ally_web').reply({ ok: false, why: 'не достаю' }); await settle()
  f.ctx.pos.B.p.x = 10
  f.report(true)
  assert.equal(f.calls.filter(c => c.name === 'B').length, 2)
  f.ctx.pos.B.p.x = 2.5
  f.report(true); f.report(true)
  assert.deepEqual(f.calls.filter(c => c.name === 'B').map(c => c.method), ['goto', 'cut_ally_web', 'cut_ally_web'])
  f.calls.at(-1).reply({ ok: true, cut: 1 }); await settle()
})

test('a live helper approaches and cuts the unchanged web', async () => {
  const f = fixture(); f.report(true)
  assert.equal(f.ctx.busy.has('B'), true)
  f.calls.find(c => c.name === 'B' && c.method === 'goto').reply({ ok: true }); await settle()
  f.calls.find(c => c.name === 'B' && c.method === 'cut_ally_web').reply({ ok: true, cut: 1 }); await settle()
  assert.equal(f.b.webRescue, null)
  assert.equal(f.a.webHelper, null)
  assert.equal(f.ctx.busy.has('B'), false)
})

test('a legacy zero-cut reply cannot confirm that an unseen ally is already free', async () => {
  const f = fixture(), lines = []
  f.ctx.log = (...args) => lines.push(args.join(' '))
  installDangers(f.ctx)
  f.report(true)
  f.calls.find(c => c.method === 'goto').reply({ ok: true }); await settle()
  f.calls.find(c => c.method === 'cut_ally_web').reply({ ok: true, cut: 0 }); await settle()
  assert.ok(lines.some(s => s.includes('срез не подтверждён')))
  assert.ok(!lines.some(s => s.includes('союзник уже свободен') || s.includes('вырезал (')))
})

const aimed = { aims: [{ name: 'Bow', weapon: 'bow', at: { x: 18, y: 64, z: 0 } }] }
test('a webbed defender raises a shield to the archer while the helper cuts, then releases both actors', async () => {
  const f = fixture()
  f.ctx.pos.A.offHand = { item: 'shield' }
  f.report(true, aimed); f.report(true, aimed)
  const hold = f.calls.find(c => c.name === 'A')
  assert.equal(hold?.method, 'swarm_hold')
  assert.equal(hold.params.whileWebbed, true)
  assert.equal(hold.params.whileDraw, 'Bow')
  assert.equal(f.calls.filter(c => c.name === 'A').length, 1)
  f.calls.find(c => c.name === 'B' && c.method === 'goto').reply({ ok: true }); await settle()
  f.calls.find(c => c.name === 'B' && c.method === 'cut_ally_web').reply({ ok: true, cut: 1 }); await settle()
  f.report(false, aimed)
  hold.reply({ ok: true, why: 'web_cleared' }); await settle()
  assert.equal(f.ctx.busy.size, 0)
})

test('a distant archer does not freeze a trapped bot when the shield is unavailable', async () => {
  const f = fixture()
  f.ctx.pos.A.offHand = { item: 'shield' }
  f.report(true, aimed)
  const hold = f.calls.find(c => c.method === 'swarm_hold')
  assert.ok(hold)
  hold.reply({ ok: false, why: 'shield_cooldown' }); await settle()
  for (let i = 0; i < 3; i++) {
    f.report(true, aimed)
    const cut = f.calls.filter(c => c.name === 'A').at(-1)
    assert.equal(cut.method, 'clear_web')
    assert.equal(cut.params.force, i === 2)
    cut.reply(i < 2 ? { ok: false, why: 'direct_threat' } : { ok: true, left: 0 }); await settle()
  }
  assert.equal(f.calls.filter(c => c.method === 'swarm_hold').length, 1)
})

test('an old helper completion cannot clear a newer rescue of the same victim', async () => {
  const f = fixture(); f.report(true)
  const newer = { target: 'A', round: ++f.ctx.round }
  f.b.webRescue = newer
  f.calls.find(c => c.name === 'B' && c.method === 'goto').reply({ ok: true }); await settle()
  assert.equal(f.b.webRescue, newer)
  assert.equal(f.a.webHelper, f.b)
})

test('an old victim releases its link when the helper belongs to a different rescue', async () => {
  const f = fixture(); f.report(true)
  const newer = { target: 'C', round: ++f.ctx.round }
  f.b.webRescue = newer
  f.calls.find(c => c.name === 'B' && c.method === 'goto').reply({ ok: true }); await settle()
  assert.equal(f.b.webRescue, newer)
  assert.equal(f.a.webHelper, null)
})

test('helper lava danger takes ownership and the old approach cannot cut or release it', async () => {
  const f = fixture(); f.report(true)
  f.b.c.onDanger({ pos: f.ctx.pos.B.p, dangers: { lava: [{ at: f.ctx.pos.B.p, d: 0 }] } })
  const lava = f.calls.find(c => c.name === 'B' && c.method === 'lava_escape')
  assert.ok(lava)
  f.calls.find(c => c.name === 'B' && c.method === 'goto').reply({ ok: true }); await settle()
  assert.equal(f.calls.some(c => c.name === 'B' && c.method === 'cut_ally_web'), false)
  assert.equal(f.ctx.busy.has('B'), true)
  lava.reply({ ok: true }); await settle()
  assert.equal(f.ctx.busy.has('B'), false)
})

for (const state of ['rescuing', 'gliding', 'combo', 'reserved', 'wind_receive', 'wind_boost']) test(`helper selection preserves active ${state}`, () => {
  const f = fixture()
  if (state === 'reserved') f.b.swarmReserved = {}
  else if (state.startsWith('wind_')) f.b.last = { m: state, pending: true }
  else f.ctx.pos.B[state] = true
  f.report(true)
  assert.equal(f.calls.some(c => c.name === 'B'), false)
})

test('helper smash danger raises its shield ahead of the old approach', async () => {
  const f = fixture(); f.ctx.pos.B.inv.shield = 1; f.report(true)
  f.b.c.onDanger({ pos: f.ctx.pos.B.p, dangers: { smashes: [{ name: 'Foe', ticks: 10, at: f.ctx.pos.B.p }] } })
  assert.ok(f.calls.some(c => c.name === 'B' && c.method === 'swarm_hold'))
  f.calls.find(c => c.name === 'B' && c.method === 'goto').reply({ ok: true }); await settle()
  assert.equal(f.calls.some(c => c.name === 'B' && c.method === 'cut_ally_web'), false)
  assert.equal(f.ctx.busy.has('B'), true)
})

function driverFixture() {
  const calls: string[] = [], b: any = { name: 'Helper', swarmExecuting: true, swarmTask: { kind: 'goto', data: {} },
    webRescue: { target: 'Victim', round: 1 }, c: { call: async m => { calls.push(m); return {} } } }
  const task = { kind: 'flee', data: {}, position: { x: 0, y: 64, z: 0 } }, board = { enemies: () => [], tasks: () => [], facts: () => [] }
  const driver = swarmTurn({ now: Date.now, alive: () => true, log() {}, pos: { Helper: { p: task.position } },
    generation: 1, refresh: () => ({ board, member: {}, task, members: [] }), say() {}, chestAtHand: () => false,
    onslaught: () => false, turnFlee: async () => calls.push('flee') })
  return { b, calls, driver }
}

test('ordinary new turn preserves web rescue, then resumes after release', async () => {
  const f = driverFixture(); await f.driver.turn(f.b); assert.deepEqual(f.calls, [])
  f.b.webRescue = null; await f.driver.turn(f.b); assert.deepEqual(f.calls, ['flee'])
})

test('ordinary phase preemption preserves web rescue, then resumes after release', () => {
  const f = driverFixture(); assert.equal(f.driver.preempt(f.b), false); assert.deepEqual(f.calls, [])
  f.b.webRescue = null; assert.equal(f.driver.preempt(f.b), true); assert.deepEqual(f.calls, ['stop'])
})

test('an existing shared busy owner is not selected as a web helper', () => {
  const f = fixture(); f.ctx.busy.add('B'); f.report(true)
  assert.equal(f.calls.some(c => c.name === 'B'), false)
  assert.equal(f.ctx.busy.has('B'), true)
})

test('a helper whose old turn does not unwind is released without approaching or cutting', async t => {
  const f = fixture(); f.b.swarmExecuting = true
  let now = 10000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (work: () => void) => { now += 3000; queueMicrotask(work); return 0 as any })
  f.report(true)
  f.calls.find(c => c.name === 'B' && c.method === 'stop').reply({ ok: true }); await settle()
  assert.equal(f.calls.some(c => c.name === 'B' && /^(goto|cut_ally_web)$/.test(c.method)), false)
  assert.equal(f.ctx.busy.has('B'), false)
  assert.equal(f.b.webRescue, null)
  f.report(true); await settle()
  assert.equal(f.calls.filter(c => c.name === 'B').length, 1)
})

test('a helper waits for the old flee continuation to unwind before approaching the web', async () => {
  const calls: any[] = [], a: any = { name: 'A', team: 'blue' }, b: any = { name: 'B', team: 'blue', swarmExecuting: true }
  for (const actor of [a, b]) actor.c = { call(method, params) {
    actor.last = { m: method, p: params, pending: true }
    if (method === 'stop') { calls.push({ name: actor.name, method, params }); return Promise.resolve({ status: 'done' }) }
    return new Promise(resolve => calls.push({ name: actor.name, method, params, reply: detail => { actor.last.pending = false; resolve({ status: 'done', detail }) } }))
  } }
  const p = { x: 6, y: 64, z: 0 }, enemy = { id: 'Foe', position: { x: 11, y: 64, z: 0 }, seenAt: Date.now() }
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, inv: {} }, B: { p, inv: { iron_sword: 1, elytra: 1, firework_rocket: 8, wind_charge: 2 } } }
  const ctx: any = { bots: [a, b], pos, round: 1, busy: new Set(), out: new Set(), deadNow: new Set(), alive: () => true,
    enemiesOf: () => [], swarmDriver: { panic: () => false, canEngage: () => true }, log() {} }
  installDangers(ctx)
  const task = { kind: 'flee', data: {}, position: p }, sw = { now: Date.now, alive: () => true, log() {}, pos, arena: { x: 0, y: 64, z: 0, r: 80 },
    generation: 1, bounded: p => p, blocked: () => false, failed() {}, detail: r => r?.detail || r, cooldown: new Map() }
  const old = swarmTurnTasks(sw).turnFlee({ b, member: {}, context: { members: [] }, board: {}, task, round: 1, m: pos.B, enemies: [enemy] })
    .finally(() => { delete b.swarmExecuting })
  assert.equal(calls[0].method, 'fly_to')
  a.c.onDanger({ pos: pos.A.p, dangers: { web: [{ at: pos.A.p, cells: 1 }] } })
  assert.ok(b.webRescue)
  calls[0].reply({ ok: false, why: 'interrupted' }); await settle()
  assert.equal(calls.some(c => c.name === 'B' && c.method === 'goto'), false, 'the old turn still owns its wind_jump continuation')
  calls.find(c => c.name === 'B' && c.method === 'wind_jump').reply({ ok: true, used: 1 })
  await old
  await new Promise(resolve => setTimeout(resolve, 65))
  const approach = calls.find(c => c.name === 'B' && c.method === 'goto')
  assert.ok(approach); assert.equal(b.swarmExecuting, undefined)
  approach.reply({ ok: true }); await settle()
  calls.find(c => c.name === 'B' && c.method === 'cut_ally_web').reply({ ok: true, cut: 1 }); await settle()
  assert.equal(ctx.busy.has('B'), false)
})

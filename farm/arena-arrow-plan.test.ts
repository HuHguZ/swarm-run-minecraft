import test from 'node:test'
import assert from 'node:assert/strict'
import { installDangers } from './arena/dangers'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { runAscent } from './swarm/swarm-driver/ascent'

const tick = () => new Promise(resolve => setImmediate(resolve))
function scene(t, shield = false) {
  let now = 10000
  const calls: any[] = [], queued: any[] = [], p = { x: 0, y: 64, z: 0 }, foe = { x: 1, y: 68, z: 0 }
  t.mock.method(Date, 'now', () => now)
  t.mock.method(Math, 'random', () => .6)
  t.mock.method(globalThis, 'setTimeout', fn => { queued.push(fn); return 0 as any })
  const b: any = { name: 'A', team: 'blue', last: { m: 'goto' }, dodgeStyle: { delay: 0, skip: 0, jumpy: 0 },
    c: { call(method, params) {
      if (method === 'swarm_pose') return Promise.resolve({ detail: { existing: { name: 'stone', solid: true } } })
      b.last = { m: method, p: params, pending: true }
      return new Promise(resolve => calls.push({ method, params, reply: detail => resolve({ status: 'done', detail }) }))
    } } }
  const ctx: any = { round: 1, bots: [b], X: 0, Y: 64, Z: 0, R: 30, L: { y0: 0 }, pos: { A: { p, hp: 20, inv: shield ? { shield: 1 } : {} } },
    busy: new Set(), out: new Set(), deadNow: new Set(), enemiesOf: () => [{ n: 'Foe', p: foe, d: Math.sqrt(17), mob: false }],
    swarmDriver: { panic: () => false, canEngage: () => true }, log() {} }
  installDangers(ctx)
  const aim = { name: 'Foe', weapon: 'bow', at: foe, side: { x: 1, z: 0 } }
  return { b, ctx, calls, queued, p, foe, aim,
    report: dangers => b.c.onDanger({ pos: p, dangers }),
    flush: () => { while (queued.length) queued.shift()() },
    advance: () => { now += 300 } }
}

test('натянутый лук и снаряды не ставят отдельную реакцию даже со щитом', async t => {
  const f = scene(t, true), action = f.b.last
  f.report({ aims: [f.aim] }); f.flush(); await tick()
  f.b.climbing = true
  for (let i = 0; i < 5; i++) { f.advance(); f.report({ aims: [f.aim] }); f.flush() }
  f.report({ arrows: [{ name: 'arrow', ticks: 2, from: f.foe, side: { x: 1, z: 0 } }] })
  f.report({ potions: [{ name: 'splash_potion', ticks: 2, at: f.p }] })
  await tick()
  assert.deepEqual(f.calls, [])
  assert.equal(f.b.last, action)
  assert.equal(f.ctx.busy.has('A'), false)
  assert.equal(f.b.arrowThreat.active, true)
  f.report({})
  assert.equal(f.b.arrowThreat.active, false)
  f.report({ lava: [{ d: 0, at: f.p }] })
  assert.equal(f.calls.at(-1).method, 'lava_escape', 'немедленная опасность сохраняет приоритет')
})

test('щит к булаве владеет реакцией, а прицел и снаряд его не заменяют', async t => {
  const f = scene(t, true)
  f.report({ smashes: [{ name: 'Mace', at: f.foe, ticks: 12, dbg: '' }] })
  const owner = f.b.shieldHold
  assert.equal(f.calls[0].params.whileSmash, 'Mace')
  f.report({ aims: [f.aim] }); f.flush()
  f.report({ arrows: [{ name: 'arrow', ticks: 2, from: f.foe, side: { x: 1, z: 0 } }] })
  assert.equal(f.calls.length, 1)
  assert.equal(f.b.shieldHold, owner)
  assert.ok(f.ctx.busy.has('A'))
  f.calls[0].reply({ ok: true }); await tick()
  assert.equal(f.ctx.busy.has('A'), false)
})

test('смена фазы не отменяет поднимающегося раненого, но отпускает застывший подъём', async () => {
  let now = 1000, finish
  const calls: any[] = [], frame: any = { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: { stone: 8 }, frame: 1, frameAt: now, observedAt: now }
  const b: any = { name: 'A', swarmExecuting: true, swarmTask: { kind: 'fight' },
    c: { call: async (method, params) => { calls.push({ method, params }); return {} } } }
  const sw: any = { now: () => now, pos: { A: frame }, alive: () => true, log() {},
    refresh: () => ({ task: { kind: 'flee', data: { panic: true } } }) }
  const pending = runAscent(b, frame, { x: 1, y: 68, z: 0 }, () => new Promise(resolve => { finish = resolve }), () => now)
  const { preempt } = swarmTurn(sw)
  now = 2200; frame.p.y++; frame.hp = 16; frame.frame++; frame.frameAt = frame.observedAt = now
  assert.equal(preempt(b), false, 'попадание стрелой не срывает реальный набор высоты')
  assert.deepEqual(calls, [])
  now = 4200; frame.frame++; frame.frameAt = frame.observedAt = now
  assert.equal(preempt(b), true, 'свежие кадры без движения больше не удерживают старую фазу')
  assert.deepEqual(calls[0], { method: 'stop', params: { _climb: true } })
  finish({}); await pending
})


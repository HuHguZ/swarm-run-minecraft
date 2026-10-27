import test from 'node:test'
import assert from 'node:assert/strict'
import { installDangers } from './arena/dangers'

const settle = () => new Promise(resolve => setImmediate(resolve))
function scene(t) {
  let observedAt = 1000, block = 'stone', hold = false
  t.mock.method(Math, 'random', () => .6)
  const calls: any[] = [], lines: string[] = [], inspections: any[] = [], p = { x: 0, y: 64, z: 0 }
  const b: any = { name: 'A', team: 'blue', last: { m: 'goto', pending: false }, c: { call(method, params) {
    if (method === 'swarm_pose') {
      const value = { detail: { existing: { name: block, solid: block !== 'air' } } }
      return hold ? new Promise(resolve => inspections.push(() => resolve(value))) : Promise.resolve(value)
    }
    b.last = { m: method, p: params, pending: true }
    return new Promise((resolve, reject) => calls.push({ method, params,
      reply: (detail, status = 'done') => { b.last.pending = false; resolve({ status, detail }) }, reject }))
  } } }
  const ctx: any = { round: 1, bots: [b], pos: { A: { p, inv: {} } }, busy: new Set(), out: new Set(), deadNow: new Set(),
    enemiesOf: () => [], log: text => lines.push(text) }
  installDangers(ctx)
  const cloud = { id: 7, at: { x: 2, y: 64, z: 0 }, r: 3 }
  const report = (clouds = [cloud], extra = {}) => b.c.onDanger({ pos: ctx.pos.A.p, observedAt: ++observedAt, dangers: { clouds, ...extra } })
  return { b, ctx, calls, lines, cloud, report, geometry: value => { block = value },
    holdInspections: () => { hold = true }, releaseInspections: () => { hold = false; inspections.splice(0).forEach(reply => reply()) } }
}

test('a failed cloud dodge retries after a visible obstruction changes without moving the bot', async t => {
  const f = scene(t)
  f.report(); assert.equal(f.calls[0].method, 'evade')
  f.calls[0].reply({ ok: false, why: 'blocked' }); await settle()
  for (let i = 0; i < 12; i++) { f.report(); await settle() }
  assert.equal(f.calls.length, 1, 'unchanged failed exit must not spam evade RPC')
  f.geometry('air'); f.report(); await settle()
  assert.equal(f.calls.length, 2, 'the same cloud must reconsider the newly opened exit')
  assert.equal(f.calls[1].method, 'evade')
  f.calls[1].reply({ ok: true }); await settle()
  f.report(); await settle(); assert.equal(f.calls.length, 2, 'success marks this unchanged cloud handled')
})

test('a released tactical interruption can retry the same cloud immediately', async t => {
  const f = scene(t)
  f.ctx.pos.A.tactics = { owner: 'Tactical', action: 'Hold', requireObservation: true }
  f.report(); f.calls[0].reply({ ok: false, why: 'interrupted' }); await settle()
  f.report(); await settle(); assert.equal(f.calls.length, 1)
  f.ctx.pos.A.tactics = { owner: 'Skill', action: null, requireObservation: false }
  f.report(); await settle()
  assert.equal(f.calls.length, 2)
  f.calls[1].reply({ ok: true }); await settle()
})

test('a cloud is queued while its dodge is pending and success does not repeat it', async t => {
  const f = scene(t)
  f.report()
  for (let i = 0; i < 12; i++) f.report()
  assert.equal(f.calls.length, 1)
  f.calls[0].reply({ ok: true }); await settle()
  f.report(); await settle(); assert.equal(f.calls.length, 1)
  assert.equal(f.ctx.busy.has('A'), false)
})

test('a rejected cloud RPC does not permanently consume the danger episode', async t => {
  const f = scene(t)
  f.report(); f.calls[0].reject(new Error('socket closed')); await settle()
  f.report(); await settle()
  assert.equal(f.calls.length, 2, 'a fresh danger receipt can retry an unconfirmed RPC')
  f.calls[1].reply({ ok: true }); await settle()
})

test('an old cloud reply cannot release the next round reaction', async t => {
  const f = scene(t)
  f.report(); f.ctx.round++; f.report()
  assert.equal(f.calls.length, 2)
  f.calls[0].reply({ ok: false, why: 'blocked' }); await settle()
  assert.equal(f.ctx.busy.has('A'), true)
  f.report(); await settle(); assert.equal(f.calls.length, 2)
  f.calls[1].reply({ ok: true }); await settle()
  assert.equal(f.ctx.busy.has('A'), false)
})

test('successful dig fallback finishes one cloud attempt and keeps its existing callback contract', async t => {
  const f = scene(t)
  f.report(); f.calls[0].reply({ ok: false, why: 'некуда' }); await settle()
  assert.equal(f.calls[1].method, 'dig_to')
  f.calls[1].reply({ dug: 1 }); await settle()
  assert.equal(f.calls[2].method, 'evade')
  f.calls[2].reply({ ok: true }); await settle()
  f.report(); await settle(); assert.equal(f.calls.length, 3)
})

test('an interrupted outer RPC cannot confirm a partial ok detail or hide the interruption reason', async t => {
  const f = scene(t)
  f.ctx.pos.A.tactics = { owner: 'Tactical', action: 'Hold', requireObservation: true }
  f.report(); f.calls[0].reply({ ok: true }, 'interrupted'); await settle()
  f.report(); await settle(); assert.equal(f.calls.length, 1)
  f.ctx.pos.A.tactics = { owner: 'Skill', action: null, requireObservation: false }
  f.report(); await settle(); assert.equal(f.calls.length, 2)
  f.calls[1].reply({ ok: true }); await settle()
})

test('an ownership change during obstacle inspection does not reopen the old cloud over its replacement', async t => {
  const f = scene(t)
  f.report(); f.holdInspections(); f.calls[0].reply({ ok: false, why: 'blocked' })
  await Promise.resolve(); await Promise.resolve()
  const other = { id: 8, at: { x: 0, y: 64, z: 2 }, r: 3 }
  f.report([f.cloud, other]); assert.equal(f.calls.length, 2)
  f.releaseInspections(); await settle()
  f.report([f.cloud, other]); await settle()
  assert.equal(f.calls.length, 2, 'the superseded cloud cannot cancel the newer pending dodge')
  assert.equal(f.ctx.busy.has('A'), true)
  f.calls[1].reply({ ok: true }); await settle()
})

test('a failed geometry batch stays unknown without per-cell compatibility requests', async t => {
  for (const status of ['rejected', 'failed', 'interrupted']) {
    const f = scene(t), call = f.b.c.call; let batches = 0, singles = 0
    f.b.c.call = (method, params) => {
      if (method !== 'swarm_pose') return call(method, params)
      if (params.cells) { batches++; return status === 'rejected' ? Promise.reject(Error('socket closed')) : Promise.resolve({ status }) }
      singles++; return call(method, params)
    }
    f.report(); f.calls[0].reply({ ok: false, why: 'blocked' }); await settle()
    assert.equal(batches, 1); assert.equal(singles, 0, `${status} must not fan out`)
    f.report(); await settle(); assert.equal(f.calls.length, 1, 'unknown is not a newly opened route')
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { installDangers } from './arena/dangers'

const settle = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const calls: any[] = [], p = { x: 538.8923, y: 150.5, z: 626.8758 }
  const foe = { n: 'Foe', mob: false, d: 2.4, p: { x: 540, y: 150.5, z: 628 } }
  const b: any = { name: 'A', team: 'red', last: { m: 'goto', pending: false }, c: { call(method, params) {
    b.last = { m: method, p: params, pending: true }
    return new Promise(resolve => calls.push({ method, params, reply: detail => { b.last.pending = false; resolve({ status: 'done', detail }) } }))
  } } }
  const ctx: any = { round: 1, bots: [b], pos: { A: { p, inv: { netherite_sword: 1, ender_pearl: 2 } } },
    busy: new Set(), out: new Set(), deadNow: new Set(), enemiesOf: () => [foe],
    swarmDriver: { panic: () => false, canEngage: () => true }, log() {} }
  installDangers(ctx)
  let observedAt = 10000
  // Actual threats.dangers emits only stable first-web cell + cell count; no ticking field.
  const report = (web = true) => b.c.onDanger({ pos: p, observedAt: ++observedAt,
    dangers: { web: web ? [{ at: { x: 538, y: 150, z: 626 }, cells: 1 }] : [] } })
  return { b, ctx, foe, calls, report }
}

test('unchanged web episode does not reissue an instantly completed fight on every danger receipt', async () => {
  const f = fixture(); f.report(); assert.equal(f.calls[0].method, 'fight')
  f.calls[0].reply({ ok: false, why: 'target_gone' }); await settle()
  for (let i = 0; i < 79; i++) { f.report(); await settle(); f.calls.at(-1).reply({ ok: false, why: 'target_gone' }); await settle() }
  assert.equal(f.calls.length, 1)
  assert.equal(f.ctx.busy.has('A'), false, 'completion still releases reaction ownership')
})

test('changed physical inputs and a new web episode can retry immediately', async () => {
  const f = fixture(); f.report(); f.calls[0].reply({ ok: false }); await settle()
  f.ctx.pos.A.inv.water_bucket = 1
  f.report(); assert.equal(f.calls.length, 2, 'new escape tool changes the price')
  f.calls[1].reply({ ok: false }); await settle()
  f.foe.p.x += 1; f.report(); assert.equal(f.calls.length, 3, 'new enemy geometry changes the price')
  f.calls[2].reply({ ok: false }); await settle()
  f.report(false); assert.equal(f.calls.length, 3, 'leaving the web ends this episode')
  f.report(); assert.equal(f.calls.length, 4, 're-entering a web is a new episode')
  f.calls[3].reply({ ok: false }); await settle()
})

test('observing the same web while fight is pending does not turn ownership bookkeeping into new danger input', async () => {
  const f = fixture(); f.report(); f.report(); f.report()
  assert.equal(f.calls.length, 1)
  f.calls[0].reply({ ok: false }); await settle()
  f.report(); assert.equal(f.calls.length, 1)
})

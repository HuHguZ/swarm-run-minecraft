import test from 'node:test'
import assert from 'node:assert/strict'
import combat = require('../src/combat')
import { swarmMethods } from '../src/rpc/swarm'
import { digStepSafe } from '../src/pvp/body'
import { Vec3 } from 'vec3'
import { runIntent } from '../src/session/intent-runner'
import { edgeTurn } from '../src/pvp/turn-melee'

const scope = { target: 'Champ', roundScope: 'blue:1', fightId: 'fight-1' }
const guard = { digAvoid: [{ x: 1, y: 63, z: 0, feetY: 64 }], swarmStand: { x: 2.5, y: 64, z: .5 } }
function fixture() {
  const ctl = { aborted: false, onAbort: [], _ndFightClosed: false }
  const params: any = { ...scope, allowPlayer: true, timeoutSeconds: 12 }
  const current = { name: 'fight', ctl, params }
  const session: any = { current, state: () => ({ busy: session.current?.name }),
    immediate() { throw new Error('must not enter immediate or drain events') },
    cancel() { throw new Error('must not cancel the live fight') },
    bus: { drain() { throw new Error('must not drain combat events') } } }
  const methods: any = swarmMethods({ session } as any)
  const ask = (patch = {}) => methods.fight_guard?.({ ...scope, ...guard, ...patch }) || { detail: { accepted: false, reason: 'unsupported' } }
  return { session, current, ctl, params, ask }
}

test('fight_guard updates the exact live fight without aborting, and the existing step consumer sees it', async () => {
  const f = fixture(), original = f.session.current
  const reply = await f.ask()
  assert.equal(reply.detail.accepted, true, reply.detail.reason)
  assert.equal(reply.status, 'done'); assert.deepEqual(reply.events, [])
  assert.equal(f.session.current, original); assert.equal(f.current.ctl, f.ctl); assert.equal(f.ctl.aborted, false)
  assert.deepEqual(f.params.digAvoid, guard.digAvoid); assert.deepEqual(f.params.swarmStand, guard.swarmStand)
  assert.notEqual(f.params.digAvoid, guard.digAvoid, 'wire arrays are copied')
  assert.notEqual(f.params.digAvoid[0], guard.digAvoid[0], 'wire coordinates are copied')
  const bot: any = { entity: { position: new Vec3(.5, 64, .5), width: .6, height: 1.8, metadata: [] } }
  assert.equal(digStepSafe({ bot, session: f.session, opts: {} }, { x: 1, z: 0 }), false)
  assert.equal((await f.ask({ digAvoid: [], swarmStand: null })).detail.accepted, true)
  assert.equal(digStepSafe({ bot, session: f.session, opts: {} }, { x: 1, z: 0 }), true)
  assert.deepEqual(f.params.digAvoid, []); assert.equal(f.params.swarmStand, null)
})

test('fight_guard rejects stale, aborted, closed and malformed snapshots atomically', async () => {
  const f = fixture()
  assert.equal((await f.ask()).detail.accepted, true)
  const snapshot = JSON.stringify(f.params), cells = f.params.digAvoid, stand = f.params.swarmStand
  for (const patch of [{ target: 'Other' }, { roundScope: 'blue:0' }, { fightId: 'previous' }, { fightId: '' },
    { digAvoid: null }, { digAvoid: [{}] }, { digAvoid: Array(4097).fill(guard.digAvoid[0]) },
    { digAvoid: [{ x: 1.5, y: 63, z: 0 }] }, { digAvoid: [{ x: 1, y: 63, z: 0, feetY: NaN }] },
    { swarmStand: { x: Infinity, y: 64, z: 0 } }, { swarmStand: { x: 30000001, y: 64, z: 0 } }, { swarmStand: undefined }]) {
    assert.equal((await f.ask(patch)).detail.accepted, false, JSON.stringify(patch))
    assert.equal(JSON.stringify(f.params), snapshot); assert.equal(f.params.digAvoid, cells); assert.equal(f.params.swarmStand, stand)
  }
  f.ctl.aborted = true; assert.equal((await f.ask()).detail.accepted, false)
  f.ctl.aborted = false; f.ctl._ndFightClosed = true; assert.equal((await f.ask()).detail.accepted, false)
  f.ctl._ndFightClosed = false; f.session.current = { ...f.current, name: 'evade' }
  assert.equal((await f.ask()).detail.accepted, false)
  f.session.current = { ...f.current, ctl: { aborted: false }, params: { ...f.params, fightId: 'fight-2' } }
  assert.equal((await f.ask()).detail.accepted, false, 'an old fight token cannot mutate the next controller')
})

test('fight_guard leaves the real intent runner and its live controller running until its worker completes', async () => {
  let finish: (v: any) => void, drains = 0
  const params: any = { ...scope }, worker = new Promise(r => { finish = r })
  const session: any = { current: null, state: () => ({ busy: session.current?.name }), bus: { drain: () => { drains++; return [] } } }
  const running = runIntent.call(session, 'fight', () => worker, { params, exclusive: false, interruptible: false, timeoutMs: 0 })
  await new Promise(resolve => setImmediate(resolve))
  const current = session.current
  assert.equal(current.name, 'fight'); assert.equal(current.ctl.aborted, false)
  const reply = await (swarmMethods({ session } as any) as any).fight_guard({ ...scope, ...guard })
  assert.equal(reply.detail.accepted, true)
  assert.equal(session.current, current); assert.equal(current.ctl.aborted, false); assert.equal(drains, 0)
  assert.deepEqual(current.params.digAvoid, guard.digAvoid)
  finish({ landed: 1 })
  assert.equal((await running).status, 'done'); assert.equal(session.current, null); assert.equal(drains, 1)
  assert.equal((await (swarmMethods({ session } as any) as any).fight_guard({ ...scope, ...guard })).detail.accepted, false)
})

test('fight_guard updates the actual edgeTurn shove direction and clears it without restarting the fight', async () => {
  const f = fixture(), to = { x: -6, y: 64, z: .5 }, me = new Vec3(2.5, 64, .5)
  const ctx: any = { bot: { entity: { position: me, yaw: Math.PI / 2 }, blockAt: () => null },
    entity: { position: new Vec3(0, 64, .5), username: scope.target }, session: f.session, opts: {}, st: {},
    prof: { player: true }, pushAt: Infinity, backAt: Infinity, nearMe: [], nearFoe: [], duo: { foes: () => [] }, ready: () => false }
  const frame = (): any => ({ now: 1000, me, d: 2.5, r: 2.5, theirR: 2.5, cooldownLeft: 0, canHit: true, inSight: true })
  assert.equal((await f.ask({ shoveAt: to })).detail.accepted, true)
  assert.deepEqual(f.params.shoveAt, to)
  assert.notEqual(f.params.shoveAt, to, 'incoming coordinates are copied')
  to.x = 99
  let turn = frame(); edgeTurn(ctx, turn)
  assert.equal(turn.edgeHit, 'sprint', 'current.params reaches the real consumer without frozen PvP opts')
  assert.equal(f.ctl.aborted, false)
  assert.equal((await f.ask({ shoveAt: { x: 6, y: 64, z: .5 } })).detail.accepted, true)
  turn = frame(); edgeTurn(ctx, turn)
  assert.equal(turn.canHit, false, 'an updated edge requires the opposite side immediately')
  assert.equal((await f.ask()).detail.accepted, true)
  assert.equal(f.params.shoveAt.x, 6, 'old callers omitting this optional field preserve the live directive')
  assert.equal((await f.ask({ shoveAt: null })).detail.accepted, true)
  assert.equal(f.params.shoveAt, null)
  assert.equal(f.session.current, f.current); assert.equal(f.ctl.aborted, false)
  assert.equal((await f.ask({ shoveAt: { x: -6, y: 64, z: .5 } })).detail.accepted, true)
  turn = frame(); edgeTurn(ctx, turn); assert.equal(turn.edgeHit, 'sprint')
  assert.equal((await f.ask({ shoveAt: null })).detail.accepted, true)
  turn = frame(); edgeTurn(ctx, turn)
  assert.equal(turn.pushing, false, 'cleared live order must not survive in the250ms natural-edge cache')
  assert.equal(turn.edgeHit, null)
})

test('malformed optional shove coordinates cannot partially update a live guard', async () => {
  const f = fixture()
  assert.equal((await f.ask({ shoveAt: { x: -6, y: 64, z: .5 } })).detail.accepted, true)
  const before = JSON.stringify(f.params), shove = f.params.shoveAt, cells = f.params.digAvoid
  for (const shoveAt of [{}, { x: 0, y: NaN, z: 0 }, { x: Infinity, y: 64, z: 0 }, { x: 30000001, y: 64, z: 0 }, false]) {
    assert.equal((await f.ask({ digAvoid: [], shoveAt })).detail.accepted, false)
    assert.equal(JSON.stringify(f.params), before)
    assert.equal(f.params.shoveAt, shove); assert.equal(f.params.digAvoid, cells)
  }
})

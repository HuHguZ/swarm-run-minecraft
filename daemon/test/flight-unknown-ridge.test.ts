import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { worldOf } from '../src/elytra/physics'

async function scene(t, terrain = 'open') {
  const time = new clock.GameClock({ manual: true, epoch: 1000 }); clock.activate(time)
  t.after(() => time.dispose())
  const bot: any = Object.assign(new EventEmitter(), { health: 20, inventory: { slots: [] },
    entity: { position: new Vec3(.5, 120, .5), velocity: new Vec3(0, 0, 0), onGround: true },
    blockAt(p) {
      const q = p.floored()
      if (terrain === 'high-wall' ? q.y > 168 : q.y > 128) return null
      const solid = terrain === 'high-wall' && q.y === 168 || terrain === 'roof' && q.y === 123 || terrain !== 'void' && q.y < 120
      return { position: q, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0,0,0,1,1,1]] : [] }
    } })
  t.mock.method(require('../src/elytra/kit'), 'kit', () => ({ elytra: true, rockets: 12 }))
  t.mock.method(require('../src/elytra/kit'), 'wearingElytra', () => true)
  t.mock.method(require('../src/elytra/track'), 'gliding', () => true)
  t.mock.method(require('../src/elytra/install'), 'flightControl', (_bot, ctl) => ctl)
  let request: any
  t.mock.method(require('../src/combat/flight-route'), 'runFlightRoute', async (_session, _ctl, p) => {
    request = p; return { ok: false, stopped: 'test route captured' }
  })
  const session = { bot, require: () => bot, runIntent: (_name, action) => action({ aborted: false }) }
  const result = await require('../src/rpc/aerial').aerialMethods({ session }).fly_to({ at: { x: 10.5, y: 120, z: .5 }, arena: { x: 0, z: 0, r: 80 } })
  return { result, request, W: worldOf(bot, { observed: true }) }
}

test('unobserved high cells cannot invent a 48-block ridge above a visible landing', async t => {
  const { request, W } = await scene(t)
  assert(request, 'the visible floor and local air permit a route candidate despite unknown distant overhead')
  assert.equal(request.gates[0].center.y, 128)
  assert.equal(W.solid(2, 168, 0), true, 'unknown space still blocks avoidance')
  assert.equal(W.boxHit(2.5, 168, .5), true, 'planning must not turn unknown into flyable air')
  assert.equal(W.floorBelow(2.5, 168, .5, 0), null, 'unknown cannot become landing support')
})

test('a genuinely observed high wall still exceeds the flight clearance limit', async t => {
  const { request, result } = await scene(t, 'high-wall')
  assert.equal(request, undefined)
  assert.match(result.why, /48/)
})

test('skipping unknown ridge height cannot invent a landing floor over the void', async t => {
  const { request, result } = await scene(t, 'void')
  assert.equal(request, undefined)
  assert.match(result.why, /негде сесть/)
})

test('an observed low roof still rules out a vertical landing beneath it', async t => {
  const { request, result } = await scene(t, 'roof')
  assert.equal(request, undefined)
  assert.match(result.why, /негде сесть/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

// Observed fixture only: the roof covers the requested low point, while the field is open toward the centre.
async function request(t: any, target: 'underRoof' | 'centre', floor: 'dry' | 'unknown' | 'water' | 'lava' = 'dry', ridge = false, steppedRoof = false) {
  const bot: any = new EventEmitter()
  Object.assign(bot, { health: 20, inventory: { slots: [], items: () => [] }, entity: {
    position: new Vec3(551.5, 153, 554.5), velocity: new Vec3(0, 0, 0), onGround: true, elytraFlying: false
  } })
  const roof = (x: number, z: number) => x < 580 && z < 580
  const solid = (x: number, y: number, z: number) => y === 119 || roof(x, z) && y === (steppedRoof && x >= 560 ? 150 : 152) || ridge && x >= 590 && x <= 592 && z >= 580 && y >= 119 && y <= 170
  const world = {
    solid,
    floorBelow(x: number, y: number, z: number, depth: number) {
      x = Math.floor(x); z = Math.floor(z)
      for (let yy = Math.floor(y); yy >= Math.floor(y) - depth; yy--) {
        if (!solid(x, yy, z)) continue
        if (yy === 119 && !roof(x, z)) return floor === 'unknown' ? null : { top: 120, water: floor === 'water', lava: floor === 'lava' }
        return { top: yy + 1 }
      }
      return null
    },
    boxHit(x: number, y: number, z: number, height = 1.8) {
      for (let xx = Math.floor(x - .3); xx <= Math.floor(x + .3 - 1e-9); xx++)
        for (let yy = Math.floor(y); yy <= Math.floor(y + height - 1e-9); yy++)
          for (let zz = Math.floor(z - .3); zz <= Math.floor(z + .3 - 1e-9); zz++)
            if (solid(xx, yy, zz)) return true
      return false
    }
  }
  t.mock.method(require('../src/elytra/kit'), 'kit', () => ({ elytra: true, rockets: 12 }))
  t.mock.method(require('../src/elytra/kit'), 'wearingElytra', () => true)
  t.mock.method(require('../src/elytra/track'), 'gliding', () => true)
  let observed = false, route: any = null
  t.mock.method(require('../src/elytra/physics'), 'worldOf', (_bot, options) => { observed = options?.observed === true; return world })
  t.mock.method(require('../src/combat/flight-route'), 'runFlightRoute', async (_session, _ctl, p) => {
    route = p
    return { ok: true, landing: p.landing, ground: p.landing, landingError: 0 }
  })
  const { aerialMethods } = require('../src/rpc/aerial')
  const session: any = { require: () => bot, runIntent: (_name, action) => action({ aborted: false }) }
  const at = target === 'underRoof' ? { x: 551, y: 120, z: 550 } : { x: 600.5, y: 120, z: 600.5 }
  const arena = { x: 600.5, y: 120, z: 600.5, r: 77, killY: 116 }
  const result = await aerialMethods({ session }).fly_to({ at, arena })
  assert.equal(observed, true, 'arena flight must use observed collision geometry')
  return { result, route, world }
}

test('fly_to from a roof rejects a low destination beneath that roof instead of landing through it', async t => {
  const { result, route } = await request(t, 'underRoof')
  assert.equal(result.ok, false)
  assert.equal(result.why, 'негде сесть у цели (под навесом или занято)')
  assert.equal(route, null)
})

test('fly_to from a roof accepts an explicit observed open field destination toward the centre', async t => {
  const { result, route, world } = await request(t, 'centre')
  assert.equal(result.ok, true)
  assert.ok(route, 'the actual RPC must reach its ordinary route executor')
  assert.equal(route.landing.y, 120)
  assert.ok(Math.hypot(route.landing.x - 600.5, route.landing.z - 600.5) < 4)
  assert.equal(world.boxHit(route.landing.x, route.landing.y, route.landing.z), false)
  const over = route.gates.find(g => g.id === 'над гребнем')
  assert.ok(over.center.x > 575 && over.center.z > 575, 'stay above the roof through its far edge before starting descent')
  assert.equal(over.center.y, 157, 'keep the ordinary four-block roof clearance without adding eight metres above the high launch point')
  assert.equal(route.gates.length, 1, 'the launch roof is below our feet, so climb forward toward its far edge')
})

for (const floor of ['unknown', 'water', 'lava'] as const) test(`fly_to roof exit never approves ${floor} field support`, async t => {
  const { result, route } = await request(t, 'centre', floor)
  assert.equal(result.ok, false)
  assert.equal(route, null)
})

test('fly_to clears the lower roof beyond the highest ridge before beginning the landing', async t => {
  const { route } = await request(t, 'centre', 'dry', false, true)
  assert.ok(route)
  const over = route.gates.find(g => g.id === 'над гребнем')
  assert.ok(over.center.x > 575 && over.center.z > 575, 'a lower roof still blocks the descent to field Y120')
  assert.equal(over.center.y, 157, 'cruise height still clears the highest part by four blocks')
  assert.equal(route.gates.length, 1, 'a descending roof does not require a vertical circle over the launch point')
})

test('fly_to roof exit preserves the climb over a real higher ridge on the way to the field', async t => {
  const { result, route } = await request(t, 'centre', 'dry', true)
  assert.equal(result.ok, true)
  const over = route.gates.find(g => g.id === 'над гребнем')
  assert.ok(over.center.x >= 590 && over.center.x <= 593)
  assert.ok(over.center.y >= 175)
  assert.equal(route.landing.y, 120)
})

for (const floor of [154, 153.875, 153.5]) test(`takeoff reaches the open sky pad at Y${floor} before accepting the approach`, async t => {
  const ctl = { aborted: false }, bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(551.5, 153, 554.5), onGround: true }
  let goal: any
  bot.pathfinder = { async goto(g) { goal = g; ctl.aborted = true }, setGoal() {} }
  t.mock.method(require('../src/elytra/install'), 'flightControl', (_bot, parent) => parent)
  t.mock.method(require('../src/elytra/install'), 'install', () => ({}))
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({
    solid: () => false, floorBelow: () => ({ top: floor }), boxHit: (_x, y) => y < floor
  }))
  const file = require.resolve('../src/elytra/flight'), cached = require.cache[file]
  delete require.cache[file]
  t.after(() => { require.cache[file] = cached })
  const { takeoff } = require('../src/elytra/flight')
  const result = await takeoff(bot, ctl)
  assert.ok(goal, JSON.stringify(result))
  assert.equal(goal.isEnd({ x: 551, y: 153, z: 554 }), false, 'same X/Z on the lower floor is not the sky pad')
  assert.equal(goal.isEnd({ x: 551, y: 154, z: 554 }), true)
})

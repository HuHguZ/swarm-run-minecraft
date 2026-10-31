import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

for (const [startY, ceilingY, initiallyClear] of [[115.8, 118, false], [115, 119, true]] as const) {
test(`landing below a platform at ${startY} leaves its ceiling before climbing, then resumes descent`, async t => {
  const bot: any = Object.assign(new EventEmitter(), { health: 20, fireworkRocketDuration: 0,
    entity: { position: new Vec3(69, startY, 0), velocity: new Vec3(0, -.1, 0), onGround: false, elytraFlying: true } })
  let covered = !initiallyClear
  const W = { solid: (x, y) => covered && y === ceilingY && x >= 68,
    boxHit: (x, y, _z, h = .6) => covered && x + .3 > 68 && y < ceilingY + 1 && y + h > ceilingY,
    floorBelow: () => null }
  const physics = require('../src/elytra/physics'), install = require('../src/elytra/install')
  const goals: any[] = [], state = { driving: 0, fd: 0 }
  t.mock.method(physics, 'worldOf', () => W)
  t.mock.method(install, 'install', () => state)
  t.mock.method(install, 'flightControl', (_b, ctl) => ctl)
  t.mock.method(install, 'steer', () => {})
  t.mock.method(require('../src/elytra/kit'), 'rocketCount', () => 0)
  t.mock.method(require('../src/elytra/rocket-forecast'), 'rocketForecast', () => ({ boost: 0 }))
  t.mock.method(require('../src/elytra/control'), 'choose', (_w, _s, goal) => {
    goals.push(goal)
    return { c: 1, yaw: 0, pitch: 0, r: { kind: null, t: 18, fd: 0 } }
  })
  const file = require.resolve('../src/elytra/flight'), saved = require.cache[file]
  delete require.cache[file]
  t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved })
  const ctl = { aborted: false }, at = new Vec3(0, 120, 0)
  const running = require('../src/elytra/flight').land(bot, ctl, { at,
    arena: { x: 0, y: 120, z: 0, r: 80, killY: 113 } })
  try {
    if (initiallyClear) {
      bot.emit('physicsTick')
      assert.deepEqual(goals.pop().at, new Vec3(0, 124, 0))
      covered = true
      bot.entity.position.y = 117.2
    }
    bot.emit('physicsTick')
    assert.equal(goals[0]?.kind, 'point', 'below the floor is a recovery, not a descending landing')
    assert.equal(goals[0].at.y, initiallyClear ? 117.2 : startY)
    assert(goals[0].at.x < 68 && goals[0].at.x > 60, 'first leave the ceiling through a nearby opening')
    assert.equal(goals[0].minY, 114)
    bot.entity.position = new Vec3(67, 114.9, 0)
    bot.emit('physicsTick')
    assert.deepEqual(goals[1].at, new Vec3(67, 124, 0), 'lift in the clear column actually reached')
    bot.entity.position.y = 121
    bot.emit('physicsTick')
    assert.equal(goals[2].kind, 'land', 'reaching safe height ends the detour')
    assert.equal(goals[2].at, at)
  } finally { ctl.aborted = true; bot.emit('physicsTick'); await running }
  assert.equal(state.driving, 0)
  assert.equal(bot.listenerCount('physicsTick'), 0)
})
}

test('landing prices an airborne undershoot instead of rewarding flight below its support', () => {
  const { cost } = require('../src/elytra/control')
  const goal = { kind: 'land', at: new Vec3(0, 120, 0) }
  const W = { floorBelow: () => null }
  const price = y => cost(W, {}, goal, () => goal.at,
    { kind: null, p: new Vec3(20, y, 0), v: new Vec3(0, -.2, 0), fd: 1, t: 18 }, 0, 0)
  assert.equal(price(115), price(125), 'being five metres below the pad is not cheaper than being five metres above it')
  assert(price(110) > price(115), 'further descent away from the pad has a price')
})

for (const [rockets, useReserve, powered] of [[3, false, false], [4, false, true], [3, true, true], [0, true, false]]) {
  test(`flight steers for available thrust: rockets=${rockets}, reserve=${useReserve}`, async t => {
    const bot: any = Object.assign(new EventEmitter(), { health: 20, fireworkRocketDuration: 0,
      entity: { position: new Vec3(0, 80, 0), velocity: new Vec3(0, 0, 0), onGround: false, elytraFlying: true } })
    const state: any = { driving: 0, fd: 0 }, calls: boolean[] = [], steering: number[] = []
    const unpowered = { c: 20, yaw: .1, pitch: .2, r: { kind: 'floor', t: 17, fd: 2 } }
    const boosted = { c: 10, yaw: .3, pitch: .4, r: { kind: null, t: 18, fd: 0 } }
    t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({}))
    const install = require('../src/elytra/install')
    t.mock.method(install, 'install', () => state)
    t.mock.method(install, 'flightControl', (_bot, ctl) => ctl)
    t.mock.method(install, 'steer', (_bot, yaw) => { steering.push(yaw) })
    let fired = 0
    t.mock.method(install, 'fireRocket', () => { fired++; return { ok: true } })
    t.mock.method(require('../src/elytra/kit'), 'rocketCount', () => rockets)
    t.mock.method(require('../src/elytra/rocket-forecast'), 'rocketForecast', () => ({ boost: 0 }))
    t.mock.method(require('../src/elytra/control'), 'choose', (_world, _state, _goal, options) => {
      calls.push(!!options?.rocketNow)
      return options?.rocketNow ? { ...boosted } : { ...unpowered }
    })
    const file = require.resolve('../src/elytra/flight'), saved = require.cache[file]
    delete require.cache[file]
    t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved })
    const { fly } = require('../src/elytra/flight')
    const ctl = { aborted: false }
    const flying = fly(bot, ctl, { useReserve, rocketIf: () => true, goal: { kind: 'point', at: new Vec3(20, 80, 0) } })
    try {
      bot.emit('physicsTick')
      assert.deepEqual(calls, powered ? [false, true] : [false], 'reserved fuel cannot enter the powered forecast')
      assert.deepEqual(steering, [powered ? boosted.yaw : unpowered.yaw])
      assert.equal(fired, powered ? 1 : 0)
      assert.equal(state.lastPlan.k, powered ? boosted.r.kind : unpowered.r.kind, 'receipt describes the selected trajectory')
      assert.equal(state.lastPlan.t, powered ? boosted.r.t : unpowered.r.t)
    } finally {
      ctl.aborted = true; bot.emit('physicsTick'); await flying
    }
    assert.equal(state.driving, 0)
    assert.equal(bot.listenerCount('physicsTick'), 0)
  })
}

test('return from outside the arena can use rescue fuel and retains its recovery goal for the powered forecast', async t => {
  const bot: any = Object.assign(new EventEmitter(), { health: 20, fireworkRocketDuration: 0,
    entity: { position: new Vec3(82, 115, 0), velocity: new Vec3(0, -.3, 0), onGround: false, elytraFlying: true } })
  const state: any = { driving: 0, fd: 1 }, plans: any[] = []
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({}))
  const install = require('../src/elytra/install')
  t.mock.method(install, 'install', () => state)
  t.mock.method(install, 'flightControl', (_bot, ctl) => ctl)
  let fired = 0, steered: number
  t.mock.method(install, 'steer', (_bot, yaw) => { steered = yaw })
  t.mock.method(install, 'fireRocket', () => { fired++; return { ok: true } })
  t.mock.method(require('../src/elytra/kit'), 'rocketCount', () => 3)
  t.mock.method(require('../src/elytra/rocket-forecast'), 'rocketForecast', () => ({ boost: 0 }))
  const control = require('../src/elytra/control'), nativeReturn = control.returnInside
  t.mock.method(control, 'choose', (_w, _st, goal, opts) => {
    plans.push({ goal, powered: !!opts?.rocketNow })
    return { c: opts?.rocketNow ? 5 : 20, yaw: opts?.rocketNow ? .9 : .1, pitch: .7,
      r: { kind: null, t: 18, fd: 0 } }
  })
  t.mock.method(control, 'returnInside', (_w, st, arena) => {
    const W = { boxHit: () => false, floorBelow: () => null }
    return nativeReturn(W, st, arena)
  })
  const file = require.resolve('../src/elytra/flight'), saved = require.cache[file]
  delete require.cache[file]
  t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved })
  const ctl = { aborted: false }, { fly } = require('../src/elytra/flight')
  const running = fly(bot, ctl, { useReserve: true, arena: { x: 0, y: 120, z: 0, r: 80, killY: 113 },
    rocketIf: () => true, goal: { kind: 'point', at: new Vec3(40, 124, 0) } })
  try {
    bot.emit('physicsTick')
    assert.equal(fired, 1, 'outside does not disable an available rescue rocket')
    assert.equal(steered, .9, 'the body uses the powered return course')
    assert.equal(plans.at(-1).goal.at.x, 0, 'power follows the recovery course instead of the old task')
    assert(plans.at(-1).goal.at.y >= 120, 'return climbs to the field rather than following the descent')
    assert(plans.at(-1).goal.at.y > 120, 'return has climb clearance above the field')
    assert.equal(plans.at(-1).goal.minY, 120, 'the field height prices continued descent')
  } finally { ctl.aborted = true; bot.emit('physicsTick'); await running }
})

for (const [bareCost, poweredCost, rockets, active, expected, complete = false] of [
  [5000, 30, 3, 0, true], [10, 30, 3, 0, false], [5000, 9000, 3, 0, false],
  [5000, 30, 0, 0, false], [5000, 30, 3, 12, false], [5000, 30, 3, 0, false, true]
]) {
  test(`landing prices recovery fuel: coast=${bareCost}, powered=${poweredCost}, fuel=${rockets}, active=${active}, complete=${complete}`, async t => {
    const bot: any = Object.assign(new EventEmitter(), { health: 20, fireworkRocketDuration: active,
      entity: { position: new Vec3(60, 125, 0), velocity: new Vec3(0, -.6, 0), onGround: false, elytraFlying: true } })
    const state: any = { driving: 0, fd: 12 }, calls: boolean[] = []
    t.mock.method(require('../src/elytra/physics'), 'worldOf', () => ({ floorBelow: () => null }))
    const install = require('../src/elytra/install')
    t.mock.method(install, 'install', () => state)
    t.mock.method(install, 'flightControl', (_bot, ctl) => ctl)
    let fired = 0, steering = 0
    t.mock.method(install, 'steer', (_bot, yaw) => { steering = yaw })
    t.mock.method(install, 'fireRocket', () => { fired++; return { ok: true } })
    t.mock.method(require('../src/elytra/kit'), 'rocketCount', () => rockets)
    t.mock.method(require('../src/elytra/rocket-forecast'), 'rocketForecast', () => ({ boost: active }))
    const control = require('../src/elytra/control')
    const recovery = { kind: 'point', at: new Vec3(0, 129, 0), minY: 120, gap: 3 }
    t.mock.method(control, 'returnInside', () => ({ c: bareCost, yaw: .1, pitch: .6, goal: recovery,
      r: { kind: null, t: 18, fd: 30 } }))
    t.mock.method(control, 'choose', (_w, _st, goal, options) => {
      const powered = !!options?.rocketNow
      calls.push(powered)
      if (goal.kind === 'land' && bareCost === 5000 && !complete) return null
      return { c: powered ? poweredCost : bareCost, yaw: powered ? .8 : .1, pitch: .6,
        path: complete ? [{ yaw: .1, pitch: .6 }] : undefined,
        r: { kind: powered ? null : 'floor', t: 18, fd: powered ? 0 : 30 } }
    })
    const file = require.resolve('../src/elytra/flight'), saved = require.cache[file]
    delete require.cache[file]
    t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved })
    const ctl = { aborted: false }
    const running = require('../src/elytra/flight').land(bot, ctl, { at: new Vec3(0, 120, 0),
      arena: { x: 0, y: 120, z: 0, r: 80, killY: 113 } })
    try {
      bot.emit('physicsTick')
      assert.equal(fired, expected ? 1 : 0, 'landing can spend its emergency reserve on a collision-checked recovery')
      assert.equal(steering, expected ? .8 : .1)
      assert.deepEqual(calls, rockets && !active && bareCost === 5000 && !complete ? [false, true] : [false])
    } finally { ctl.aborted = true; bot.emit('physicsTick'); await running }
    assert.equal(state.driving, 0)
    assert.equal(bot.listenerCount('physicsTick'), 0)
  })
}

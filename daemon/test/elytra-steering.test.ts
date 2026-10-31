import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { install, steer } from '../src/elytra/install'
import * as lock from '../src/reflex-lock'
import * as physics from '../src/elytra/physics'
import * as control from '../src/elytra/control'
import * as forecast from '../src/elytra/rocket-forecast'

for (const skyFirst of [false, true]) for (const cancelled of [false, true]) {
  test(`only the active pilot turns through async hand guards: skyFirst=${skyFirst}, cancelled=${cancelled}`, async () => {
    const looks: number[][] = []
    const bot: any = Object.assign(new EventEmitter(), {
      registry: require('minecraft-data')('1.21.11'), inventory: { slots: [], items: () => [] }, entities: {}, health: 20,
      entity: { position: new Vec3(0, 150, 0), velocity: new Vec3(0, -.1, -1), elytraFlying: true, onGround: false },
      look: (yaw, pitch) => { looks.push([yaw, pitch]); return Promise.resolve() },
      _client: Object.assign(new EventEmitter(), { write() {} })
    })
    const session: any = { bot }
    if (skyFirst) install(bot)
    lock.install(session)
    const state = install(bot)
    state.driving = 1
    const ctl = { aborted: false }
    const own = lock.run(session, ctl, () => steer(bot, 2.8, .45))
    ctl.aborted = cancelled
    const foreign = bot.look(0, -1, true)
    await Promise.all([own, foreign])
    assert.deepEqual(looks, cancelled ? [] : [[2.8, .45]],
      'deferred own steering must pass, foreign looks and cancelled pilot work must stay fenced')
  })
}

for (const tactical of [false, true]) test(`an owned landing keeps steering after its launching ${tactical ? 'tactical lease' : 'intent'} is cancelled`, async t => {
  const looks: number[][] = []
  const bot: any = Object.assign(new EventEmitter(), {
    registry: require('minecraft-data')('1.21.11'), inventory: { slots: [], items: () => [] }, entities: {}, health: 20,
    entity: { position: new Vec3(0, 150, 0), velocity: new Vec3(0, -.1, -1), elytraFlying: true, onGround: false },
    look: (yaw, pitch) => { looks.push([yaw, pitch]); return Promise.resolve() },
    _client: Object.assign(new EventEmitter(), { write() {} })
  })
  const session: any = { bot }
  lock.install(session)
  install(bot)
  t.mock.method(physics, 'worldOf', () => ({ at: () => 0 }))
  t.mock.method(control, 'choose', () => ({ yaw: 2.8, pitch: .45, c: 0, r: { kind: null } }))
  t.mock.method(forecast, 'rocketForecast', () => ({ boost: 0 }))
  const file = require.resolve('../src/elytra/flight'), saved = require.cache[file]
  delete require.cache[file]
  t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved })
  const { fly } = require('../src/elytra/flight')
  const root = { aborted: false }
  let flying: Promise<any>, work: Promise<any>
  const launch = ctl => flying = fly(bot, require('../src/elytra/install').flightControl(bot, ctl, true), {
    goal: { kind: 'point', at: new Vec3(0, 154, 10) }, noRocket: () => true })
  if (tactical) work = lock.start(session, launch, { immediate: true })
  else lock.run(session, root, () => launch(root))
  try {
    bot.emit('physicsTick'); await new Promise(setImmediate)
    assert.equal(looks.length, 1)
    if (tactical) lock.cancel(session)
    else root.aborted = true
    bot.emit('physicsTick'); await new Promise(setImmediate)
    assert.equal(looks.length, 2, 'the independent live landing owner must keep turning after the old hands are cancelled')
    let release!: () => void
    const takeover = lock.start(session, () => new Promise<void>(resolve => { release = resolve }), { owner: 'Emergency', immediate: true })
    try {
      bot.emit('physicsTick'); await new Promise(setImmediate)
      assert.equal(looks.length, 2, 'the landing must not borrow a different active emergency lease')
    } finally {
      require('../src/elytra/install').flightControl(bot, { aborted: false })
      release(); await takeover; await new Promise(setImmediate)
    }
    assert.equal(looks.length, 2, 'a deferred look must not survive revocation of the landing owner')
  } finally {
    require('../src/elytra/install').flightControl(bot, { aborted: false })
    bot.emit('physicsTick'); await flying; if (work) await work
  }
  bot.emit('physicsTick'); await new Promise(setImmediate)
  assert.equal(bot._ndElytra.driving, 0)
})

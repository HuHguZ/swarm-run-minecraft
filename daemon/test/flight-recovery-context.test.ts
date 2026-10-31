import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as locks from '../src/reflex-lock'
import * as lance from '../src/combat/aerial-lance'
import { runFlightRoute } from '../src/combat/flight-route'
import sky = require('../src/elytra')

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

function fixture() {
  const bot: any = new EventEmitter(), writes: any[] = []
  const spear = { name: 'iron_spear', count: 1 }, rocket = { name: 'firework_rocket', count: 8 }
  bot.entity = { id: 1, position: new Vec3(.5, 110, .5), velocity: new Vec3(.6, 0, 0), yaw: 0, pitch: .12,
    elytraFlying: true, onGround: false }
  Object.assign(bot, { health: 20, heldItem: spear, inventory: { slots: [], items: () => [spear, rocket] },
    _client: new EventEmitter(), _ndElytra: { driving: 0, fd: 0, startedAt: 0 }, pathfinder: {},
    fireworkRocketDuration: 0, activateItem: () => {}, deactivateItem: () => {},
    look: async (yaw, pitch) => { writes.push({ yaw, pitch }); bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    blockAt: p => ({ name: p.y < 100 ? 'stone' : 'air', boundingBox: p.y < 100 ? 'block' : 'empty' }) })
  bot.inventory.slots[6] = { name: 'elytra' }; bot.inventory.slots[45] = rocket
  const session: any = { bot, bus: { emit: () => {} } }, parent = { aborted: true }
  locks.install(session)
  const start = (kind: string, ctl = parent, inherited = false) => {
    const action = () => kind === 'lance'
      ? lance.lance(bot, ctl, { id: 2, type: 'player', username: 'foe', position: new Vec3(5, 100, .5),
        onGround: true, isValid: true }, { passes: 0, telemetryHp: () => null })
      : runFlightRoute(session, ctl, { gates: [{ id: 'out', center: { x: 20.5, y: 110, z: .5 }, normal: { x: 1, y: 0, z: 0 }, radius: 4 }],
        landing: { x: .5, y: 100, z: .5 } })
    return inherited ? action() : locks.run(session, ctl, action)
  }
  const stop = async () => { bot.health = 0; bot.emit('physicsTick'); await flush() }
  return { bot, session, parent, writes, start, stop }
}

for (const kind of ['lance', 'route']) test(`${kind}: background landing receives a live control context and yields to a new flight`, async () => {
  const { bot, session, parent, writes, start, stop } = fixture()
  try {
    await start(kind)
    assert.equal(bot._ndElytra.driving, 1)
    await locks.run(session, parent, () => sky.steer(bot, 2, 2))
    assert.equal(writes.length, 0, 'ordinary cancelled work remains fenced')
    bot.emit('physicsTick'); await flush()
    assert.equal(writes.length, 1, 'the actual background landing must steer')
    const current = { aborted: false }
    const done = locks.run(session, current, () => sky.fly(bot, current, {
      goal: { kind: 'point', at: new Vec3(30, 110, .5) }, noRocket: () => true }))
    bot.emit('physicsTick'); await flush()
    assert.equal(writes.length, 2, 'only the replacement flight steers')
    assert.equal(bot._ndElytra.driving, 1)
    await stop(); await done
    const before = writes.length
    bot.emit('physicsTick'); await flush()
    assert.equal(writes.length, before, 'death leaves no background steering')
  } finally { await stop() }
})

for (const revoke of [false, true]) test(`background landing waits for Emergency and ${revoke ? 'stays revoked' : 'resumes'}`, async () => {
  const { bot, session, writes, start, stop } = fixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    const reflex = locks.start(session, () => held, { owner: 'Emergency', immediate: true })
    await start('lance')
    bot.emit('physicsTick'); await flush()
    assert.equal(writes.length, 0)
    if (revoke) sky.flightControl(bot, { aborted: false })
    release(); await reflex; await flush()
    assert.equal(writes.length, revoke ? 0 : 1, 'only a current recovery resumes after Emergency')
  } finally { release(); await stop() }
})

test('ordinary landing keeps its own active Tactical lease', async () => {
  const { bot, session, writes, start, stop } = fixture()
  let done: any
  try {
    done = locks.start(session, ctl => start('lance', ctl, true), { owner: 'Tactical', immediate: true })
    for (let n = 0; n < 10 && !bot._ndElytra.driving; n++) await flush()
    assert.equal(bot._ndElytra.driving, 1)
    bot.emit('physicsTick'); await flush()
    assert.equal(writes.length, 1, 'live Tactical work must not wait on itself')
  } finally { await stop(); await done }
})

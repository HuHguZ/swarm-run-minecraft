import test from 'node:test'
import assert from 'node:assert/strict'
import { runBoatHops, type BoatHopPort } from '../src/tactics/boat-hop-graph'
import { boatLavaAim, placeBoatOnLava } from '../src/combat/boat-placement'
import { boatHopPlan } from '../src/combat/boat-hop'
const { Vec3 } = require('vec3')

test('lava emergency finds the nearest visible progressing hop without scanning every fluid ray', () => {
  let reads = 0
  const bot: any = { health: 20, entity: { position: new Vec3(.5, 63.9, .5), height: 1.8, eyeHeight: 1.62 }, entities: {},
    inventory: { items: () => [{ name: 'oak_boat', count: 16 }] },
    blockAt: (point: any) => {
      reads++
      const at = point.floored()
      const name = at.y >= 64 ? 'air' : at.x >= 5 ? 'stone' : 'lava'
      return { position: at, name, boundingBox: name === 'stone' ? 'block' : 'empty',
        shapes: name === 'stone' ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({ level: 0 }) }
    } }
  const plan = boatHopPlan(bot)
  assert.deepEqual(plan, { at: { x: 1, y: 63, z: 0 }, surface: 'lava' })
  assert.ok(reads < 1000, `emergency performed ${reads} block reads`)
})

test('lava hops spend existing boats and can continue after a destroyed item is lost', async () => {
  let time = 0; let stock = 2; let x = 0; let id = 10
  const broken: number[] = []
  const port: BoatHopPort = { now: () => time, sleep: async ms => { time += ms }, health: () => 16, aborted: () => false,
    stock: () => stock, position: () => ({ x, y: 64, z: 0 }), plan: () => ({ at: { x: x + 2, y: 63, z: 0 }, surface: 'lava' }),
    place: async () => { stock--; return ++id }, mount: async () => { x += 2; return true }, breakBoat: async boat => { broken.push(boat); return true },
    safe: () => x >= 4, phase: () => {} }
  const result = await runBoatHops(port)
  assert.equal(result.ok, true)
  assert.equal(result.hops, 2)
  assert.equal(result.spent, 2)
  assert.equal(stock, 0)
  assert.deepEqual(broken, [11])
  assert.deepEqual(result.path, ['Plan', 'Place', 'Mount', 'Verify', 'Break', 'Plan', 'Place', 'Mount', 'Verify', 'Done'])
  port.stock = () => 0; port.safe = () => false
  const empty = await runBoatHops(port)
  assert.equal(empty.ok, false)
  assert.equal(empty.hops, 0)
  assert.equal(empty.why, 'available boats exhausted')
})

test('fall clutch waits for interaction range and requires actual spawn, mount and safe landing', async () => {
  let time = 0; let mounted = false; let health = 20
  const port: BoatHopPort = { now: () => time, sleep: async ms => { time += ms }, health: () => health, aborted: () => false,
    stock: () => 1, position: () => ({ x: 0, y: mounted ? 64 : 68, z: 0 }),
    plan: () => time >= 300 ? { at: { x: 0, y: 63, z: 0 }, surface: 'dry' } : null,
    place: async () => 8, mount: async () => { mounted = true; return true }, breakBoat: async () => false,
    safe: () => mounted && time >= 500, phase: () => {} }
  const result = await runBoatHops(port, { fallClutch: true })
  assert.equal(result.ok, true)
  assert.equal(result.hops, 1)
  assert.ok(time >= 800, 'landing remains observed during a stability interval')
  mounted = false; time = 300; port.mount = async () => { health = 0; return false }
  const died = await runBoatHops(port, { fallClutch: true })
  assert.equal(died.ok, false)
  assert.equal(died.died, true)
  assert.equal(died.hops, 0)
})

test('death inventory loss does not count the remaining boats as placed', async () => {
  let health = 20; let stock = 16
  const port: BoatHopPort = { now: () => 0, sleep: async () => {}, health: () => health, aborted: () => false,
    stock: () => stock, position: () => ({ x: 0, y: 64, z: 0 }), plan: () => ({ at: { x: 1, y: 63, z: 0 }, surface: 'lava' }),
    place: async () => { health = 0; stock = 0; return null }, mount: async () => false, breakBoat: async () => false,
    safe: () => false, phase: () => {} }
  const failed = await runBoatHops(port)
  assert.equal(failed.died, true)
  assert.equal(failed.spent, 0)
  health = 20; stock = 16
  port.place = async () => { health = 0; stock = 0; return 10 }
  const spawned = await runBoatHops(port)
  assert.equal(spawned.died, true)
  assert.equal(spawned.spent, 1, 'one confirmed placement cannot consume the entire lost inventory')
})

test('lava boat placement uses a visible fluid ray and does not claim an absent boat spawn', async () => {
  const item = { name: 'oak_boat', count: 2 }
  let used = 0
  const bot: any = { health: 20, entity: { position: new Vec3(.5, 65, .5), height: 1.8, eyeHeight: 1.62 }, entities: {},
    inventory: { items: () => [item] }, equip: async () => {}, lookAt: async () => {}, activateItem: () => { used++; item.count-- },
    blockAt: (point: any) => ({ position: point.floored(), name: point.y < 64 ? 'lava' : 'air', boundingBox: 'empty', shapes: [], getProperties: () => ({ level: 0 }) }) }
  const at = new Vec3(1, 63, 0)
  assert.ok(boatLavaAim(bot, at))
  const result = await placeBoatOnLava({ bot }, { aborted: false, onAbort: [] }, { at, maxMs: 25 })
  assert.equal(used, 1)
  assert.equal(item.count, 1)
  assert.equal(result.ok, false)
  const original = bot.blockAt
  bot.blockAt = (point: any) => point.x >= 1 && point.y >= 64 ? { position: point.floored(), name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : original(point)
  assert.equal(boatLavaAim(bot, at), null, 'a solid wall blocks a fluid use ray')
})

test('lava placement confirms a short-lived native boat in its spawn event before the next game tick', async () => {
  const { EventEmitter } = require('node:events')
  const bot: any = new EventEmitter()
  const item = { name: 'oak_boat', count: 2 }
  const boat = { id: 123, name: 'oak_boat', position: new Vec3(1.5, 63 + 8 / 9, .5) }
  Object.assign(bot, { health: 20, entity: { position: new Vec3(.5, 65, .5), height: 1.8, eyeHeight: 1.62 }, entities: {},
    inventory: { items: () => [item] }, equip: async () => {}, lookAt: async () => {},
    activateItem: () => {
      queueMicrotask(() => { bot.entities[boat.id] = boat; bot.emit('entitySpawn', boat); delete bot.entities[boat.id] })
    },
    blockAt: (point: any) => ({ position: point.floored(), name: point.y < 64 ? 'lava' : 'air', boundingBox: 'empty', shapes: [], getProperties: () => ({ level: 0 }) }) })
  const ctl = { aborted: false, onAbort: [] }
  const result = await placeBoatOnLava({ bot }, ctl, { at: new Vec3(1, 63, 0), maxMs: 25 })
  assert.equal(result.ok, true)
  assert.equal(result.boat, boat)
  assert.equal(bot.listenerCount('entitySpawn'), 0)
  assert.equal(ctl.onAbort.length, 0)
  bot.activateItem = () => { throw new Error('use packet failed') }
  await assert.rejects(placeBoatOnLava({ bot }, ctl, { at: new Vec3(1, 63, 0), maxMs: 25 }), /use packet failed/)
  assert.equal(bot.listenerCount('entitySpawn'), 0)
  assert.equal(ctl.onAbort.length, 0)
})

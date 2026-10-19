import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebBoatGraph, type WebBoatFacts } from '../src/tactics/web-boat-graph'
import { placeBoatOn, mountBoat } from '../src/combat/boat-placement'
import { webBoatPlan, webBoatExit } from '../src/tactics/web-boat'
import { Vec3 } from 'vec3'

test('web rescue advances only after each placement, passenger mount and safe height are observed', () => {
  const graph = new WebBoatGraph()
  const facts: WebBoatFacts = { aborted: false, alive: true, webPlaced: true, inWeb: true, supports: 2, boatSpawned: true, mounted: true, safeHeight: false }
  for (const expected of ['EnterWeb', 'BuildSupports', 'PlaceBoat', 'MountBoat', 'VerifyExit']) assert.equal(graph.advance(facts), expected)
  assert.equal(graph.advance(facts), 'Failed', 'mount alone cannot claim lava rescue')
  const success = new WebBoatGraph()
  facts.safeHeight = true
  for (let phase = 0; phase < 6; phase++) success.advance(facts)
  assert.equal(success.phase, 'Done')
  const cancelled = new WebBoatGraph()
  assert.equal(cancelled.advance({ ...facts, aborted: true }), 'Failed')
})

function fixture(spawns: boolean, mounts: boolean) {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.health = 20
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), metadata: [], height: 1.8, width: .6 }
  bot.entities = {}
  bot.inventory = { items: () => [{ name: 'oak_boat', count: 1 }], firstEmptyHotbarSlot: () => 37 }
  bot.setQuickBarSlot = () => {}
  bot.equip = async (item: any) => { bot.heldItem = item }
  bot.lookAt = async () => {}
  bot.blockAt = (position: any) => ({ name: position.y < 64 ? 'stone' : 'air', boundingBox: position.y < 64 ? 'block' : 'empty',
    position: position.floored(), shapes: position.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  const boat = { id: 2, name: 'oak_boat', position: new Vec3(1.5, 64, .5), height: .5625, width: 1.375, passengers: [] }
  bot.activateItem = () => { if (spawns) { bot.entities[boat.id] = boat; bot.emit('entitySpawn', boat) } }
  bot.mount = () => { if (mounts) { bot.vehicle = boat; bot.emit('mount', boat) } }
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  return { session: { bot }, ctl, boat }
}

test('dry boat placement waits for a real entity and mount waits for a real passenger', async () => {
  const absent = fixture(false, false)
  assert.equal((await placeBoatOn(absent.session, absent.ctl, { at: { x: 1, y: 63, z: 0 }, maxMs: 50 })).ok, false)
  const actual = fixture(true, true)
  const placed = await placeBoatOn(actual.session, actual.ctl, { at: { x: 1, y: 63, z: 0 }, maxMs: 50 })
  assert.equal(placed.ok, true)
  assert.equal(placed.boat?.id, 2)
  assert.equal((await mountBoat(actual.session, actual.ctl, actual.boat, { maxMs: 50 })).ok, true)
  const rejected = fixture(true, false)
  assert.equal((await mountBoat(rejected.session, rejected.ctl, rejected.boat, { maxMs: 50 })).ok, false)
  assert.equal(rejected.session.bot.listenerCount('mount'), 0)
  assert.equal(rejected.ctl.onAbort.length, 0)
})

test('web rescue builds above the wall and verifies the actual mounted boat rather than a stale player position', () => {
  const bot: any = { health: 20, entity: { position: new Vec3(1.5, 100.5, .5), height: 1.8, metadata: [] }, entities: {},
    inventory: { items: () => [{ name: 'cobweb', count: 1 }, { name: 'cobblestone', count: 2 }, { name: 'oak_boat', count: 1 }] },
    blockAt(p: any) {
      const q = p.floored(); const solid = q.x === 0 && q.y <= 103
      return { position: q, name: solid ? 'stone' : q.y <= 100 ? 'lava' : 'air', boundingBox: solid ? 'block' : 'empty',
        shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
    } }
  const plan = webBoatPlan({ bot })
  assert.ok(plan)
  assert.equal(plan.base.y, plan.web.y + 2)
  assert.equal(plan.supports[0].y, plan.web.y + 1)
  assert.ok(plan.base.y >= 103, 'the boat bounding box clears the wall, instead of colliding beside it')
  const boat: any = { id: 2, name: 'oak_boat', position: new Vec3(plan.base.x + .5, plan.base.y + 1, plan.base.z + .5), isValid: true }
  bot.vehicle = boat; bot.entities[2] = boat
  const oldBlockAt = bot.blockAt
  bot.blockAt = (p: any) => p.floored().equals(new Vec3(plan.base.x, plan.base.y, plan.base.z))
    ? { position: p.floored(), name: 'cobblestone', boundingBox: 'block' } : oldBlockAt(p)
  assert.equal(webBoatExit(bot, plan, boat, 100.5), true)
  assert.equal(bot.entity.position.y, 100.5, 'the adapter does not synthesize a player teleport after mount')
  bot.vehicle = null
  assert.equal(webBoatExit(bot, plan, boat, 100.5), false)
  bot.vehicle = boat; boat.position.y = 100.8
  assert.equal(webBoatExit(bot, plan, boat, 100.5), false, 'mounting a boat in lava is not a dry rescue')
})

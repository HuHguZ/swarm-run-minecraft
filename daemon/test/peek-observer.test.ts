import test from 'node:test'
import assert from 'node:assert/strict'

import { Vec3 } from 'vec3'
import { EventBus } from '../src/events'
import { Session } from '../src/session'

function fixture () {
  const bus = new EventBus()
  const bot: any = { entity: { position: new Vec3(9.5, 51.875, -13.7), velocity: new Vec3(0, 0, 0), onGround: true },
    entities: {}, game: { dimension: 'the_nether' }, inventory: { slots: Array(46).fill(null) },
    physics: { playerHeight: 1.8, playerHalfWidth: 0.3, gravity: 0.08 },
    getControlState: () => false, blockAt: () => ({ name: 'soul_sand' }) }
  const session: any = { bot, bus, current: { name: 'fortress' },
    state: () => ({ connected: true, health: 20, inventory: {} }) }
  session.immediate = worker => Session.prototype.immediate.call(session, worker)
  const { observationMethods }: typeof import('../src/rpc/observation') = require('../src/rpc/observation')
  // Execute the real handlers (src/rpc/observation.ts), omitting only process/server startup.
  const methods: Record<string, any> = observationMethods({ session, bus, cfg: { fairPlay: true, host: '127.0.0.1', port: 25621 }, state: { dangerWatch: null } })
  return { bus, bot, session, methods }
}

test('peek observes physics and inventory while preserving buffered damage/emergency/chat for status', async () => {
  const f = fixture()
  f.bot.inventory.slots[9] = { name: 'netherrack', count: 16 }
  const queued = [f.bus.emit('damage', { health: 19 }), f.bus.emit('emergency', { action: 'shield' }), f.bus.emit('chat', { message: 'observer marker' })]
  for (let i = 0; i < 3; i++) {
    const r = await f.methods.peek({ physics: true, items: true })
    assert.equal(r.detail.physics?.onGround, true, 'observer gets the same native body fields as status')
    assert.deepEqual(JSON.parse(JSON.stringify(r.detail.items)), [{ name: 'netherrack', count: 16, ench: {} }])
    assert.equal(r.detail.storage.length, 36)
    assert.equal(r.detail.storage[0].name, 'netherrack')
    assert.equal(r.detail.storage[0].count, 16)
    assert.equal(r.events.length, 0)
    assert.deepEqual(f.bus.buffer, queued, 'observation does not deliver events belonging to the brain')
    assert.equal(f.bus.pending()?.type, 'chat', 'a buffered wake still interrupts the next brain intent')
  }
  const r = await f.methods.status({ physics: true, items: true })
  assert.deepEqual(r.events, queued, 'the original status handler still delivers all queued events')
  assert.equal(f.bus.buffer.length, 0)
  assert.equal(r.detail.physics.onGround, true)
  assert.equal(r.detail.items[0].name, 'netherrack')
})

test('peek without optional detail stays small and tolerates a disconnected body', async () => {
  const f = fixture()
  const small = await f.methods.peek()
  assert.equal(small.detail.physics, undefined)
  assert.equal(small.detail.items, undefined)
  assert.equal(small.detail.busy, 'fortress')
  const events = [f.bus.emit('disconnected')]
  f.session.bot = null
  const absent = await f.methods.peek({ physics: true, items: true })
  assert.equal(absent.detail.physics, undefined)
  assert.equal(absent.detail.items.length, 0)
  assert.equal(absent.detail.storage, null)
  assert.deepEqual(f.bus.buffer, events)
})

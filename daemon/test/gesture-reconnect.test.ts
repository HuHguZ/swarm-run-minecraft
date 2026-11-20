import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { hook } from '../src/gestures'
import locks = require('../src/reflex-lock')
import { wall } from '../src/game-clock'

test('a disconnected session declines a reflex before taking control', async () => {
  const session = { bot: null, reflex: null }
  let invoked = false
  const result = await locks.start(session, () => { invoked = true })
  assert.equal(result.cancelled, true)
  assert.equal(invoked, false)
  assert.equal(session.reflex, null)
  assert.equal(locks.owner(session), null)
})

test('a queued reflex cannot invoke work after the session replaces its body', async () => {
  const session = { bot: new EventEmitter() }
  let invoked = false
  const result = locks.start(session, () => { invoked = true })
  session.bot = new EventEmitter()
  assert.equal((await result).cancelled, true)
  assert.equal(invoked, false)
  assert.equal(locks.owner(session), null)
})

for (const afterDrop of ['connected', 'disconnected', 'reconnected']) {
  test(`a delayed item gesture belongs to the body that saw it (${afterDrop})`, t => {
    let deliver: () => void
    t.mock.method(wall, 'setTimeout', (callback, ms) => {
      assert.equal(ms, 400)
      deliver = callback
      return {}
    })
    const player = { username: 'Friend', position: new Vec3(0, 64, 3), yaw: 0 }
    const item = { id: 7, name: 'item', position: player.position.offset(0, 1.32, 0) }
    const bot = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0, 64, 0) }, world: { raycast: () => null },
      players: { Friend: { entity: player } }, entities: { 7: item }
    })
    const bus = new EventEmitter()
    const events = [], gifts = []
    bus.on('gesture', event => events.push(event.kind))
    const session: any = { bot, bus, mood: { state: { mood: 60 }, bump: name => gifts.push(name) } }
    hook({ session }, bot)
    t.after(() => bot.emit('end'))
    bot.emit('entitySpawn', item)
    bot.emit('itemDrop', item)
    assert.equal(typeof deliver, 'function')
    if (afterDrop === 'connected') session.current = { name: 'fight' }
    else session.bot = afterDrop === 'reconnected' ? new EventEmitter() : null
    deliver()
    assert.deepEqual(gifts, afterDrop === 'connected' ? ['Friend'] : [])
    assert.deepEqual(events, afterDrop === 'connected' ? ['кинул мне'] : [])
    assert.equal(locks.owner(session), null)
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import threats = require('../src/threats')

test('floor danger uses visible cracks/removals or coarse nearby digging, never a hidden cell or own active digging', () => {
  for (const c of [
    { cover: 'glass', event: 'crack', signal: 'sight' },
    { cover: 'stone', event: 'crack', signal: null },
    { cover: 'glass', event: 'remove', signal: 'sight' },
    { cover: 'stone', event: 'remove', signal: null },
    { event: 'sound', sound: 'hit', x: 1.5, signal: 'sound' },
    { event: 'sound', sound: 'break', x: 1.5, signal: 'sound' },
    { event: 'sound', sound: 'place', x: 1.5, signal: null },
    { event: 'sound', sound: 'hit', x: 9.5, signal: null },
    { event: 'sound', sound: 'hit', x: 1.5, own: true, signal: null },
    { event: 'sound', sound: 'break', x: 1.5, completed: true, signal: null },
    { cover: 'glass', event: 'crack', own: true, signal: null }
  ]) {
    const bot: any = new EventEmitter(); bot._client = new EventEmitter()
    bot.registry = require('minecraft-data')('1.21.11')
    bot.entity = { id: 1, position: new Vec3(.5, 0, .5), height: 1.8 }
    bot.entities = {}
    let removed = false
    bot.blockAt = p => {
      const q = p.floored(), name = q.y === -1 ? c.cover || 'stone' : q.y <= -2 && !removed ? 'stone' : 'air'
      return { position: q, name, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] }
    }
    const under = bot.blockAt(new Vec3(0, -2, 0))
    if (c.own) bot.targetDigBlock = under
    threats.dangers(bot, { foes: [] })
    if (c.completed) bot.emit('diggingCompleted', under)
    if (c.event === 'crack') bot.emit('blockBreakProgressObserved', under, 1, { id: c.own ? 1 : 2 })
    if (c.event === 'remove') { removed = true; bot.emit('blockUpdate', under, bot.blockAt(under.position)) }
    if (c.event === 'sound') bot._client.emit('sound_effect', {
      sound: { data: { soundName: `minecraft:block.stone.${c.sound}` } }, x: c.x * 8, y: -8, z: 4, volume: 1 })
    const danger = threats.dangers(bot, { foes: [] }).floor
    assert.equal(danger[0]?.signal || null, c.signal, JSON.stringify(c))
    if (c.signal === 'sound') {
      assert.equal(danger[0].holes, 0)
      assert.equal(danger[0].at.y, bot.entity.position.y, 'hearing must not reveal the hidden cell height')
      assert.notEqual(danger[0].at.x, c.x, 'hearing returns the band midpoint, not packet coordinates')
    }
    bot.emit('end')
  }
})

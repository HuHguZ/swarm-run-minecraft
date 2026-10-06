'use strict'
// raw.entity_velocity: буфер — пакет целиком с номером 0x63 впереди. Тело с id 99 (= 0x63) не должно принимать чужие скорости.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const { fixSelfKnockback } = require('../src/edges')

test('self knockback fix: another entity velocity never lands on a body whose id equals the packet id', () => {
  const bot: any = { _client: new EventEmitter(), entity: { id: 99, velocity: new Vec3(0.1, 0.2, 0.3) },
    registry: { protocol: { play: { toClient: { types: { packet_entity_velocity: ['container', [{ name: 'velocity', type: 'lpVec3' }]] } } } } } }
  fixSelfKnockback(bot)
  // Сущность 65 (0x41), скорость — ненулевой первый байт lpVec3 (раньше при start 0 он читался как скорость тела 99).
  bot._client.emit('raw.entity_velocity', Buffer.from([0x63, 0x41, 0x41, 0x22, 0x10, 0x20, 0x30, 0x40]))
  assert.deepEqual([bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z], [0.1, 0.2, 0.3])
  // Своя — применяется (нулевой вектор lpVec3 — один байт 0).
  bot._client.emit('raw.entity_velocity', Buffer.from([0x63, 99, 0]))
  assert.deepEqual([bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z], [0, 0, 0])
})

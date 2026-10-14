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

// Скорость падения в пакете удара (агент Ада 14.10, c13–c16: y −1.9…−2.2 «странная» перед падением в лаву) — в пределах тела.
test('self knockback fix: a fall speed of -2.1 from the server is applied, an impossible one is not', () => {
  const lp = (vx: number, vy: number, vz: number, scale: number) => {
    const q = (v: number) => BigInt(Math.round((v / scale + 1) * 32766 / 2))
    const packed = (q(vz) << 33n) | (q(vy) << 18n) | (q(vx) << 3n) | BigInt(scale)
    const buf = Buffer.alloc(6)
    buf[0] = Number(packed & 0xFFn); buf[1] = Number((packed >> 8n) & 0xFFn); buf.writeUInt32BE(Number(packed >> 16n), 2)
    return buf
  }
  const bot: any = { _client: new EventEmitter(), entity: { id: 7, velocity: new Vec3(0, 0, 0) },
    registry: { protocol: { play: { toClient: { types: { packet_entity_velocity: ['container', [{ name: 'velocity', type: 'lpVec3' }]] } } } } } }
  fixSelfKnockback(bot)
  bot._client.emit('raw.entity_velocity', Buffer.concat([Buffer.from([0x63, 7]), lp(0, -2.1, 0, 3)]))
  assert.ok(Math.abs(bot.entity.velocity.y + 2.1) < 0.01, String(bot.entity.velocity.y))
  bot.entity.velocity.set(0, 0, 0)
  bot._client.emit('raw.entity_velocity', Buffer.concat([Buffer.from([0x63, 7]), lp(0, -2.9, 0, 3)]))
  assert.ok(Math.abs(bot.entity.velocity.y + 2.9) < 0.01, 'до предела 3.92 — тоже')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { captureOpeningWire } from './swarm/swarm-driver/combo-wire'

test('opening wire preserves write this/args/result/errors, snapshots native spawn velocity, and restores exact write/listeners', () => {
  const client: any = new EventEmitter(), calls: any[] = [], token = {}, context = {}, originalError = new Error('original failure')
  const original = function (this: any, ...args: any[]) { calls.push({ context: this, args }); if (args[0] === 'look') throw originalError; return token }
  client.write = original
  const existing = () => {}
  client.on('packet', existing)
  const bot = { _client: client, entity: { position: { x: 0, y: 151, z: 0 }, yaw: 1, pitch: 2, onGround: false, velocity: { x: 0, y: .42, z: 0 } } }
  const capture = captureOpeningWire(bot), packet = { hand: 0, rotation: { x: 3, y: 4 }, sequence: 1 }, callback = () => {}
  try {
    assert.strictEqual(client.write.call(context, 'use_item', packet, 42, callback), token)
    assert.strictEqual(calls[0].context, context)
    assert.deepEqual(calls[0].args, ['use_item', packet, 42, callback])
    assert.strictEqual(calls[0].args[1], packet)
    packet.rotation.x = 99
    for (const name of ['position', 'position_look', 'flying', 'tick_end']) assert.strictEqual(client.write(name, { flags: {} }), token)
    assert.strictEqual(client.write('teleport_confirm', { teleportId: 37 }), token)
    assert.throws(() => client.write('look', { yaw: 90, pitch: 0 }), e => e === originalError)
    assert.strictEqual(client.write('keep_alive', { keepAliveId: 1n }), token)
    const spawn = Buffer.alloc(49), packed = 1 + 16383 * 2 ** 3 + 32766 * 2 ** 18
    spawn[0] = 1; spawn[1] = 7; spawn[18] = 1
    spawn.writeDoubleBE(7, 19); spawn.writeDoubleBE(151, 27); spawn.writeDoubleBE(0, 35)
    spawn[43] = packed % 256; spawn[44] = Math.floor(packed / 256) % 256; spawn.writeUInt32BE(Math.floor(packed / 65536), 45)
    client.emit('packet', { entityId: 7, type: 1, x: 7, y: 151, z: 0 }, { name: 'spawn_entity' }, spawn)
    client.emit('packet', { entityId: 8, type: 1, x: 13, y: 151, z: 0 }, { name: 'spawn_entity' }, spawn)
    client.emit('packet', { effectId: 2002, location: { x: 7, y: 151, z: 0 }, data: 0 }, { name: 'world_event' })
    client.emit('packet', { teleportId: 37, x: 1, y: 151, z: 2 }, { name: 'position' })
    client.emit('packet', { dimension: 'overworld' }, { name: 'respawn' })
    client.emit('packet', { reason: 3, gameMode: 0 }, { name: 'game_state_change' })
    assert.deepEqual(capture.rows.map(r => r.name), ['use_item', 'position', 'position_look', 'flying', 'tick_end', 'teleport_confirm', 'look', 'spawn_entity', 'world_event', 'position', 'respawn', 'game_state_change'])
    assert.equal(capture.rows[0].data.rotation.x, 3)
    assert.equal(capture.rows[0].own.onGround, false)
    assert.equal(capture.rows[0].own.velocity.y, .42)
    assert.equal(capture.rows[5].data.teleportId, 37)
    assert.equal(capture.rows[9].data.teleportId, 37)
    assert.equal(capture.rows[9].direction, 'in')
    assert.deepEqual(capture.rows[7].velocity, { x: 0, y: 1, z: -1 })
    assert.ok(capture.rows.every(r => Number.isFinite(r.ms)))
  } finally { capture.close() }
  assert.strictEqual(client.write, original)
  assert.equal(client.listenerCount('packet'), 1)
  const count = capture.rows.length
  client.write('position', { x: 1 }); client.emit('packet', { effectId: 2002 }, { name: 'world_event' })
  assert.equal(capture.rows.length, count)
  capture.close()
  assert.strictEqual(client.write, original)
})

test('serialized opening tap copies actual bytes, filters decoded packet names, and removes only its listener', () => {
  const client: any = new EventEmitter(), serializer: any = new EventEmitter(), copied: Buffer[] = []
  const params = { y: 151, flags: { onGround: false } }, original = () => 'unchanged', existing = () => {}
  serializer.proto = { parsePacketBuffer(type: string, buffer: Buffer) {
    assert.equal(type, 'packet'); copied.push(buffer)
    const names = { 0x1e: 'position_look', 0x40: 'use_item', 0x2a: 'player_input', 0x2b: 'player_loaded', 0xff: 'keep_alive' }
    return { data: { name: names[buffer[0]], params: buffer[0] === 0x1e ? params : { hand: 0 } } }
  } }
  serializer.on('data', existing); client.serializer = serializer; client.write = original
  const capture = captureOpeningWire({ _client: client, entity: { position: { x: 0, y: 151, z: 0 } } })
  try {
    const bytes = Buffer.from([0x1e, 151])
    serializer.emit('data', bytes); bytes[1] = 99; params.flags.onGround = true
    for (const id of [0x40, 0x2a, 0x2b, 0xff]) serializer.emit('data', Buffer.from([id]))
    assert.deepEqual(capture.rows.map(r => [r.direction, r.name]), [['serialized', 'position_look'], ['serialized', 'use_item'], ['serialized', 'player_input'], ['serialized', 'player_loaded']])
    assert.deepEqual(copied[0], Buffer.from([0x1e, 151]))
    assert.equal(capture.rows[0].hex, '1e97')
    assert.equal(capture.rows[0].data.flags.onGround, false)
  } finally { capture.close() }
  assert.strictEqual(client.write, original)
  assert.equal(serializer.listenerCount('data'), 1)
  const count = capture.rows.length
  serializer.emit('data', Buffer.from([0x40]))
  assert.equal(capture.rows.length, count)
})

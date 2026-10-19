import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { watchDigReceipt } from '../src/environments/dig-receipt'

function receiptFixture() {
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', _client: new EventEmitter(),
    block: { stateId: 83, name: 'netherrack', boundingBox: 'block' },
    blockAt() { return this.block },
    _updateBlockState(_at, stateId) { this.block = { stateId, name: stateId === 109 ? 'lava' : stateId ? 'netherrack' : 'air', boundingBox: stateId && stateId !== 109 ? 'block' : 'empty' } }
  })
  const at = new Vec3(4, 67, 6)
  const watch = watchDigReceipt(bot, at)
  const packet = (stateId, position = at) => {
    bot._updateBlockState(position, stateId)
    bot._client.emit('block_change', { location: position, type: stateId })
  }
  return { bot, at, watch, packet }
}

test('predicted client air and unrelated server air cannot confirm destruction, and timeout restores the original collision', async () => {
  const f = receiptFixture()
  f.bot._updateBlockState(f.at, 0)
  f.bot._client.emit('block_change', { location: new Vec3(5, 67, 6), type: 0 })
  assert.equal(await f.watch.settle(0), 'timeout')
  assert.equal(f.bot.blockAt(f.at).name, 'netherrack')
  f.watch.close()
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
})

test('actual server air confirms destruction, rejection and cancellation restore real geometry', async () => {
  const confirmed = receiptFixture()
  confirmed.packet(0)
  assert.equal(await confirmed.watch.settle(), 'confirmed')
  confirmed.watch.close()
  const rejected = receiptFixture()
  rejected.bot._updateBlockState(rejected.at, 0)
  const pending = rejected.watch.settle(200)
  rejected.packet(83)
  assert.equal(await pending, 'rejected')
  assert.equal(rejected.bot.blockAt(rejected.at).name, 'netherrack')
  rejected.watch.close()
  const cancelled = receiptFixture()
  cancelled.bot._updateBlockState(cancelled.at, 0)
  cancelled.bot.emit('death')
  assert.equal(await cancelled.watch.settle(), 'interrupted')
  assert.equal(cancelled.bot.blockAt(cancelled.at).name, 'netherrack')
  cancelled.watch.close()
  const cancelledAfterPacket = receiptFixture()
  cancelledAfterPacket.packet(0)
  cancelledAfterPacket.bot.emit('death')
  assert.equal(await cancelledAfterPacket.watch.settle(), 'interrupted')
  assert.equal(cancelledAfterPacket.bot.blockAt(cancelledAfterPacket.at).name, 'air')
  cancelledAfterPacket.watch.close()
})

test('1.21.11 section packets match only the tracked global coordinate', async () => {
  const f = receiptFixture()
  f.bot._updateBlockState(f.at, 0)
  f.bot._client.emit('multi_block_change', { chunkCoordinates: { x: 0, y: 4, z: 0 }, records: [(4 << 8) | (6 << 4) | 3] })
  assert.equal(await f.watch.settle(), 'confirmed')
  f.watch.close()
})

test('server lava filling a mined cell is preserved and cannot become a walkable air receipt', async () => {
  const f = receiptFixture()
  f.bot._updateBlockState(f.at, 0)
  const pending = f.watch.settle(200)
  f.packet(109)
  assert.equal(await pending, 'rejected')
  assert.equal(f.bot.blockAt(f.at).name, 'lava')
  assert.equal(f.bot.blockAt(f.at).boundingBox, 'empty')
  f.watch.close()
})

test('a native server packet wakes the waiting skill immediately without a wall timer round trip', async () => {
  const f = receiptFixture()
  let resolved = false
  const pending = f.watch.settle(200).then(result => { resolved = true; return result })
  f.packet(0)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(resolved, true)
  assert.equal(await pending, 'confirmed')
  assert.equal(f.watch.timing().packet, 'single')
  f.watch.close()
})

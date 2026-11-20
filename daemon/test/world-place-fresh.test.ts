import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { tuneMovements } from '../src/worlds'

function fixture() {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const bot: any = new EventEmitter(), ref = new Vec3(0, 0, 0), dest = ref.offset(0, 1, 0)
  let placed = false, obstructed = false, sent = 0, inside = 0
  bot.registry = registry; bot.entities = {}; bot.game = { dimension: 'overworld' }
  bot.entity = { id: 1, name: 'player', position: new Vec3(.5, 2.00133597911216, .5), width: .6, height: 1.8 }
  bot.heldItem = { name: 'cobblestone', type: registry.itemsByName.cobblestone.id }
  bot.inventory = { items: () => [bot.heldItem], slots: [] }
  bot.blockAt = p => {
    const at = p.floored(), name = at.equals(ref) || obstructed && at.equals(ref.offset(0, 2, 0)) ? 'stone' : placed && at.equals(dest) ? 'cobblestone' : 'air'
    const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = at; return b
  }
  bot.lookAt = async (_p, force) => { if (!force) bot.entity.position.y = 1.42 }
  bot.waitForTicks = async () => {}; bot.swingArm = () => {}
  bot.supportFeature = name => name === 'blockPlaceHasInsideBlock'
  bot._client = { write: (name, packet) => {
    assert.equal(name, 'block_place'); sent++
    if (bot.entity.position.y < 2) { inside++; return }
    assert.deepEqual(packet.location, ref); placed = true
  } }
  require('mineflayer/lib/plugins/generic_place')(bot)
  tuneMovements(bot, {})
  return { bot, ref, dest, count: () => ({ sent, inside }), obstruct: () => { obstructed = true } }
}

test('tower placement does not await a second native aim after checking the body', async () => {
  const f = fixture()
  await f.bot.placeBlock(f.bot.blockAt(f.ref), new Vec3(0, 1, 0))
  assert.deepEqual(f.count(), { sent: 1, inside: 0 })
  assert.equal(f.bot.blockAt(f.dest).name, 'cobblestone')
})

test('a body moved into the destination during aim never sends a placement packet', async () => {
  const f = fixture(); f.bot.lookAt = async () => { f.bot.entity.position.y = 1.42 }
  await assert.rejects(f.bot.placeBlock(f.bot.blockAt(f.ref), new Vec3(0, 1, 0)))
  assert.equal(f.count().sent, 0)
})

test('a reference face occluded during aim never sends a placement packet', async () => {
  const f = fixture(); f.bot.lookAt = async () => { f.obstruct() }
  await assert.rejects(f.bot.placeBlock(f.bot.blockAt(f.ref), new Vec3(0, 1, 0)))
  assert.equal(f.count().sent, 0)
})

test('an aborted aim keeps its lease cancellation and does not place', async () => {
  const f = fixture(), error = Object.assign(new Error('cancelled'), { code: 'REFLEX_CANCELLED' })
  f.bot.lookAt = async () => { throw error }
  await assert.rejects(f.bot.placeBlock(f.bot.blockAt(f.ref), new Vec3(0, 1, 0)), error)
  assert.equal(f.count().sent, 0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

const SL = require('../src/sealed')
const tools = require('../src/tools')
const registry = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')(registry)

type HandItem = { name: string; type: number; count: number; slot: number; maxDurability?: number; durabilityUsed?: number; enchants: [] }

function handDigFixture(name: string, names: string[] = []) {
  const at = new Vec3(4, 67, 6)
  let block = Block.fromStateId(registry.blocksByName[name].minStateId, 0)
  block.position = at
  const items: HandItem[] = names.map((name, slot) => ({ name, type: registry.itemsByName[name].id, count: 1, slot,
    maxDurability: registry.itemsByName[name].maxDurability, durabilityUsed: 0, enchants: [] }))
  const swings: Array<{ hand: string | null; harvest: boolean; ticks: number }> = []
  const bot = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, _client: new EventEmitter(), heldItem: items[0] ?? null as HandItem | null,
    entity: { position: at.offset(-1, 0, 0), onGround: true, effects: {} }, inventory: { items: () => items },
    blockAt: (_position: Vec3) => block,
    async equip(item: HandItem) { this.heldItem = item },
    async unequip() { this.heldItem = null },
    digTime(b: typeof block) { return b.digTime(this.heldItem?.type ?? null, false, false, false, [], {}) },
    _updateBlockState(position: Vec3, stateId: number) { block = Block.fromStateId(stateId, 0); block.position = position },
    stopDigging() {},
    async dig(b: typeof block) {
      swings.push({ hand: this.heldItem?.name ?? null, harvest: b.canHarvest(this.heldItem?.type ?? null), ticks: this.digTime(b) / 50 })
      this._updateBlockState(at, 0)
      this._client.emit('block_change', { location: at, type: 0 })
    }
  })
  tools.install(bot)
  return { at, bot, swings }
}

test('recovery clears ordinary Nether walls without a pick using the native hand dig time and confirmed server air', async () => {
  for (const name of ['netherrack', 'polished_blackstone_bricks']) {
    const f = handDigFixture(name, ['iron_sword', 'netherrack'])
    assert.equal(await SL.digCell(f.bot, f.at), 'ok')
    assert.equal(f.swings.length, 1)
    assert.equal(f.swings[0].hand, 'netherrack')
    assert.ok(f.swings[0].ticks >= 1)
    assert.equal(f.bot.blockAt(f.at).name, 'air')
    assert.equal(f.bot._client.listenerCount('block_change'), 0)
  }
})

test('allowGuard cannot discard a remembered gold block with bare hands or a stone pick', async () => {
  for (const inventory of [[], ['stone_pickaxe']]) {
    const f = handDigFixture('gold_block', inventory)
    assert.equal(await SL.digCell(f.bot, f.at, { allowGuard: true }), 'tool:gold_block')
    assert.deepEqual(f.swings, [])
    assert.equal(f.bot.blockAt(f.at).name, 'gold_block')
  }
  const usable = handDigFixture('gold_block', ['iron_pickaxe'])
  assert.equal(await SL.digCell(usable.bot, usable.at, { allowGuard: true }), 'ok')
  assert.equal(usable.swings[0].harvest, true)
})

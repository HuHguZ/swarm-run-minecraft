import test from 'node:test'
import assert from 'node:assert/strict'
import { scene, base } from './swarm-chest-lid-fixture'
import { block } from './tick-plugins-fixture'

test('double chest Q: only its visible reciprocal half qualifies and an open opposite half prevents the click', async () => {
  const Block = require('prismarine-block')('1.21.11'), pair = base.offset(1, 0, 0)
  for (const mode of ['confirmed', 'not reserved', 'wrong direction', 'hidden partner', 'other open', 'other already covered', 'closed again', 'split while aiming']) {
    const f = scene()
    const half = (at, type, facing = 'north') => {
      const b = Block.fromProperties('chest', { type, facing, waterlogged: false }, 0); b.position = at; f.cells.set(at.toString(), b)
      return b
    }
    try {
      half(base, 'left')
      const other = half(pair, 'right', mode === 'wrong direction' ? 'west' : 'north')
      if (mode === 'hidden partner') for (const pos of [pair.offset(0, 1, 0), pair.offset(0, 0, 1), pair.offset(0, 1, 1)]) f.cells.set(pos.toString(), block('stone', pos))
      if (mode === 'other open' || mode === 'closed again') {
        require('mineflayer/lib/plugins/block_actions')(f.bot)
        const lid = count => f.bot._client.emit('block_action', { location: pair, blockId: other.type, byte1: 1, byte2: count })
        lid(1)
        if (mode === 'closed again') lid(0)
      }
      if (mode === 'other already covered') {
        const lid = pair.offset(0, 1, 0); f.cells.set(lid.toString(), block('cobblestone', lid))
      }
      if (mode === 'split while aiming') {
        const look = f.bot.lookAt
        f.bot.lookAt = async p => { await look(p); half(pair, 'single') }
      }
      const r = await f.call(mode === 'not reserved' ? {} : { chestPartner: pair })
      const permitted = ['confirmed', 'closed again'].includes(mode)
      assert.equal(r.done, permitted, mode)
      assert.equal(f.bot.packets.filter(p => p.name === 'block_place').length, Number(permitted), mode)
    } finally { f.bot.emit('end') }
  }
})

test('Q crouched crosshair clicks the native chest top and requires its exact server update', async () => {
  for (const confirmed of [true, false]) {
    const f = scene()
    if (!confirmed) f.noReceipt()
    const result = await f.call()
    const click = f.bot.packets.find(p => p.name === 'block_place')
    assert.ok(click); assert.deepEqual(click.location, base); assert.equal(click.direction, 1); assert.equal(click.cursorY, .875)
    assert.ok(f.bot.packets.slice(0, f.bot.packets.indexOf(click)).some(p => p.name === 'player_input' && p.inputs.shift))
    assert.equal(result.done, confirmed); assert.equal(f.bot.getControlState('sneak'), false)
    f.bot.emit('end')
  }
})
test('a sword guard can cap the chest with the spare hand and keeps an occupied shield slot', async () => {
  for (const mode of ['empty', 'preloaded', 'shield', 'switched']) {
    const f = scene(), [stone] = f.bot.inventory.items()
    const sword = { name: 'iron_sword', type: f.bot.registry.itemsByName.iron_sword.id }
    const shield = { name: 'shield', type: f.bot.registry.itemsByName.shield.id }
    try {
      f.bot.heldItem = sword
      f.bot.inventory.slots[45] = mode === 'preloaded' ? stone : mode === 'shield' ? shield : null
      f.bot.inventory.items = () => mode === 'preloaded' ? [sword] : [sword, stone]
      f.bot.equip = async (stack, hand) => { if (hand === 'off-hand') f.bot.inventory.slots[45] = stack; else f.bot.heldItem = stack }
      if (mode === 'switched') {
        const look = f.bot.lookAt
        f.bot.lookAt = async p => { await look(p); f.bot.inventory.slots[45] = shield }
      }
      const outcome = await f.call()
      const packet = f.bot.packets.find(p => p.name === 'block_place')
      assert.equal(outcome.done, mode !== 'switched', mode)
      assert.equal(packet?.hand, mode === 'switched' ? undefined : mode === 'shield' ? 0 : 1, mode)
      if (mode !== 'shield') assert.equal(f.bot.heldItem, sword)
      if (mode === 'shield' || mode === 'switched') assert.equal(f.bot.inventory.slots[45], shield)
    } finally { f.bot.emit('end') }
  }
})

test('Q refuses an open chest, the occupied earlier pose, an unseen rival, a barrel and glass', async () => {
  for (const mode of ['open', 'body', 'hidden', 'barrel', 'glass']) {
    const f = scene()
    if (mode === 'open') f.bot.emit('chestLidMove', f.bot.blockAt(base), 1)
    if (mode === 'body') f.bot.entity.position.set(664.6,150.5,578.95)
    if (mode === 'hidden') f.rival['_ndVisible'] = false
    if (mode === 'barrel') f.cells.set(base.toString(), block('barrel', base))
    const result = await f.call(mode === 'glass' ? { item: 'glass' } : {})
    assert.equal(result.done, false, mode); assert.equal(f.bot.packets.filter(p => p.name === 'block_place').length, 0, mode)
    f.bot.emit('end')
  }
})
test('a genuine Q placement receipt survives cancellation immediately after its block update', async () => {
  const f = scene(); f.cancelAfterReceipt()
  try {
    const r = await f.call()
    assert.equal(r.aborted, true); assert.equal(r.done, true); assert.equal(r.after, 'cobblestone')
  } finally { f.bot.emit('end') }
})

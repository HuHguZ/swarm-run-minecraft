import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { swarmMethods } from '../src/rpc/swarm'
import { seesPlayer } from '../src/pvp/last-seen'

const registry = require('prismarine-registry')('1.21.11')
const Entity = require('prismarine-entity')(registry), Item = require('prismarine-item')(registry)
const Block = require('prismarine-block')(registry)
const itemSlot = registry.supportFeature('metadataIxOfItem')
const block = name => Block.fromStateId(registry.blocksByName[name].defaultState, 0)
const air = block('air'), stone = block('stone')

function scene() {
  let wall = true, reads = 0
  const decoded: number[] = []
  const bot = { registry, entity: { position: new Vec3(.5, 64, .5), height: 1.8 }, entities: {} as Record<number, any>,
    blockAt(p) { reads++; return wall && p.x === 1 ? stone : air } }
  const drop = (id: number, name: string | null, distance: number) => {
    const e = new Entity(id), item = name ? new Item(registry.itemsByName[name].id, name === 'arrow' ? 16 : 1) : null
    Object.assign(e, { name: 'item', type: 'object', width: registry.entitiesByName.item.width, height: registry.entitiesByName.item.height,
      position: bot.entity.position.offset(distance, 0, 0) })
    e.metadata[itemSlot] = Item.toNotch(item)
    const decode = e.getDroppedItem.bind(e)
    e.getDroppedItem = () => { decoded.push(id); return decode() }
    bot.entities[id] = e
    return e
  }
  drop(10, null, -.2)
  for (let i = 0; i < 6; i++) drop(20 + i, 'mace', 2 + i / 10)
  for (let i = 0; i < 32; i++) drop(100 + i, i % 2 ? 'arrow' : 'iron_sword', -(3 + i / 10))
  const session = { require: () => bot, immediate: fn => fn() }
  const rpc = swarmMethods({ session } as any).items_near
  // Previous exhaustive query defines the existing rounded-distance tie order.
  const exhaustive = radius => {
    const items = []
    for (const e of Object.values(bot.entities)) {
      const d = e.position.distanceTo(bot.entity.position)
      if (d > radius || !seesPlayer(bot, e)) continue
      const it = e.getDroppedItem()
      if (it) items.push({ id: e.id, name: it.name, count: it.count, at: { x: e.position.x, y: e.position.y, z: e.position.z }, d: +d.toFixed(1) })
    }
    return items.sort((a, b) => a.d - b.d).slice(0, 12)
  }
  return { bot, drop, rpc, exhaustive, removeWall() { wall = false }, measure() {
    const result = { reads, decoded: decoded.splice(0) }; reads = 0; return result
  } }
}

test('40 nearby-item queries inspect only far enough to fill the visible list', async t => {
  let before = 0, after = 0, beforeItems = 0, afterItems = 0
  for (let i = 0; i < 40; i++) {
    const f = scene(), expected = f.exhaustive(7), baseline = f.measure()
    const { items } = await f.rpc({ radius: 7 }), selected = f.measure()
    assert.deepEqual(items, expected)
    assert.equal(items.length, 12)
    assert.ok(selected.decoded.every(id => id === 10 || id >= 100), 'no hidden stack metadata was decoded')
    before += baseline.reads; after += selected.reads
    beforeItems += baseline.decoded.length; afterItems += selected.decoded.length
  }
  t.diagnostic(`40 clients, block lookups ${before} → ${after}, native stack decodes ${beforeItems} → ${afterItems}`)
  assert.equal(afterItems, 40 * 13, '12 actual items plus one visible entity with no item metadata')
  assert.ok(after < before)
})

test('new and moving drops, a removed wall, and rounded ties are reflected in the next RPC', async () => {
  const f = scene()
  const read = async () => {
    const { items } = await f.rpc({ radius: 7 })
    assert.deepEqual(items, f.exhaustive(7))
    return items.map(it => it.id)
  }
  const initial = await read()
  assert.ok(!initial.includes(20) && !initial.includes(131))
  f.bot.entities[131].position = new Vec3(-.4, 64.5, .5)
  assert.equal((await read())[0], 131)
  f.drop(4, 'diamond_sword', -3.04); f.drop(5, 'arrow', -2.98)
  assert.deepEqual((await read()).slice(1, 4), [4, 5, 100], 'the farther item comes first when its rounded distance ties')
  delete f.bot.entities[131]
  f.removeWall()
  assert.deepEqual((await read()).slice(0, 6), [20, 21, 22, 23, 24, 25])
})

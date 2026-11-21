import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { install } from '../src/fastblocks'
import { worldTruthMethods } from '../src/rpc/world-truth'
import { Session } from '../src/session'

const registry = require('prismarine-registry')('1.21.11')
const Chunk = require('prismarine-chunk')('1.21.11'), World = require('prismarine-world')('1.21.11')
const chest = new Vec3(11, 120, 8)

function scene() {
  const world = new World().sync
  let reads = 0, uniformReads = 0
  for (const [cx, cz] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const column = new Chunk(), get = column.getBlockStateId.bind(column)
    column.getBlockStateId = p => {
      reads++
      if (column.sections[(p.y - column.minY) >> 4]?.data.value !== undefined) uniformReads++
      return get(p)
    }
    world.setColumn(cx, cz, column, false)
  }
  const put = (p, name) => world.setBlockStateId(p, registry.blocksByName[name].defaultState)
  put(chest, 'chest')
  reads = 0; uniformReads = 0
  const bot: any = { world, registry, game: { minY: -64, height: 384 }, entity: { position: new Vec3(8.5, 120, 8.5) },
    findBlocks() { throw Error('expected installed client scanner') }, blockAt: p => world.getBlock(p) }
  install(bot)
  const session = { bot, mcData: registry, bus: { drain: () => [] }, state: () => ({}), require: () => bot, immediate: Session.prototype.immediate }
  const rpc = worldTruthMethods({ session } as any)
  const scan = async (find = 'chest', radius = 16, count = 8) => (await rpc.blocks_around({ find, seen: true, radius, count })).detail.found
  return { bot, put, scan, get reads() { return reads }, get uniformReads() { return uniformReads } }
}

test('the normal loot RPC skips uniform non-chest sections on consecutive polls of forty clients', async t => {
  let reads = 0, uniformReads = 0
  for (let i = 0; i < 40; i++) {
    const f = scene()
    for (let poll = 0; poll < 2; poll++) assert.deepEqual(await f.scan(), [{ x: chest.x, y: chest.y, z: chest.z }])
    reads += f.reads; uniformReads += f.uniformReads
  }
  t.diagnostic(`state reads ${reads}, uniform section reads ${uniformReads}`)
  assert.equal(uniformReads, 0)
})

test('the next visible loot query follows wall placement, chest replacement and newly populated sections', async () => {
  const f = scene()
  const p = chest.offset(-1, 0, 0)
  for (let y = 0; y < 3; y++) f.put(p.offset(0, y, 0), 'stone')
  assert.deepEqual(await f.scan(), [])
  for (let y = 0; y < 3; y++) f.put(p.offset(0, y, 0), 'air')
  assert.deepEqual(await f.scan(), [{ x: chest.x, y: chest.y, z: chest.z }])
  f.put(chest, 'air')
  f.put(new Vec3(17, 120, 8), 'chest')
  assert.deepEqual(await f.scan(), [{ x: 17, y: 120, z: 8 }])
})

test('a matching uniform section and a global palette both expose their visible resource', async () => {
  const f = scene(), column = f.bot.world.getColumn(1, 0), sy = (120 - column.minY) >> 4
  column.sections[sy] = column.sections[sy].constructor.fromLocalPalette({ palette: [registry.blocksByName.stone.defaultState] })
  assert.deepEqual(await f.scan('stone', 16, 1), [{ x: 16, y: 120, z: 8 }])
  const center = f.bot.world.getColumn(0, 0)
  for (let i = 0; i < 260; i++) center.setBlockStateId(new Vec3(i & 15, 112 + (i >> 8), (i >> 4) & 15), i + 1)
  assert.equal(center.sections[sy].palette, undefined)
  assert.equal(center.sections[sy].data.value, undefined)
  assert.deepEqual(await f.scan(), [{ x: chest.x, y: chest.y, z: chest.z }])
})

'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const { transformSync } = require('esbuild')
function current (relative) {
  const file = path.join(__dirname, relative); const req = createRequire(file)
  const context = { module: { exports: {} as any }, console, process,
    require: name => name === './pvp/last-seen' ? current('../src/pvp/last-seen.ts') : req(name) }
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, context, { filename: file })
  return context.module.exports
}
const totem = current('../src/totem.ts')
const { wantTotem } = totem
const plain = value => JSON.parse(JSON.stringify(value))

test('totem scans fresh visible anchors but never reacts to anchors behind a wall', () => {
  const registry = require('prismarine-registry')('1.21.11')
  const Chunk = require('prismarine-chunk')(registry)
  const Block = require('prismarine-block')(registry)
  const columns = new Map()
  let reads = 0
  const column = (x, z) => {
    const key = `${x},${z}`
    if (!columns.has(key)) {
      const col = new Chunk({ minY: -64, worldHeight: 384 })
      const read = col.getBlockStateId.bind(col)
      col.getBlockStateId = p => { reads++; return read(p) }
      columns.set(key, col)
    }
    return columns.get(key)
  }
  const slots = Array(46).fill(null)
  const bot = {
    health: 20,
    game: { minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    registry,
    inventory: { slots, items: () => slots.filter(Boolean) },
    nearestEntity: () => null,
    world: { getColumn: column, raycast: (eye, dir, range) => require('../src/pick').blockOnRay(bot, eye, dir, range)?.block || null },
    blockAt: p => {
      const b = Block.fromStateId(column(p.x >> 4, p.z >> 4).getBlockStateId(new Vec3(p.x & 15, p.y, p.z & 15)), 0)
      b.position = p.clone()
      return b
    },
    findBlock: () => { throw new Error('full Block search must not be used') }
  }
  assert.deepEqual(plain(wantTotem(bot)), { yes: false })
  assert.equal(columns.size, 0, 'no world scan without a usable totem')
  slots[45] = { name: 'totem_of_undying' }
  assert.equal(wantTotem(bot).yes, false)
  assert.equal(reads, 0, 'uniform air sections need no cell reads')
  const set = (x, y, z, name) => column(x >> 4, z >> 4).setBlockStateId(new Vec3(x & 15, y, z & 15), registry.blocksByName[name].defaultState)
  for (const [x, y, z] of [[0, 64, 0], [2, 64, 0], [1, 63, 0], [1, 65, 0], [1, 64, -1], [1, 64, 1]]) set(x, y, z, 'stone')
  set(1, 64, 0, 'respawn_anchor')
  assert.equal(wantTotem(bot).yes, false, 'a fully buried anchor is not a visible threat')
  set(0, 64, 0, 'air'); set(1, 65, 0, 'air')
  assert.deepEqual(plain(wantTotem(bot)), { yes: true, why: 'взрывчатка рядом' }, 'opening the actual ray exposes the anchor')
  set(1, 64, 0, 'stone')
  set(7, 64, 0, 'respawn_anchor')
  assert.equal(wantTotem(bot).yes, false, 'updates are read afresh and anchors outside radius 6 do not count')
  slots[45] = null
  slots[36] = { name: 'totem_of_undying' }
  set(1, 64, 0, 'respawn_anchor')
  assert.equal(wantTotem(bot).yes, true, 'a totem in the inventory can be equipped')
})

for (const name of ['end_crystal', 'tnt', 'tnt_minecart']) test(`totem needs actual LOS to nearby ${name}, including inside four blocks`, () => {
  let wall = true
  const entity = { id: 2, name, position: new Vec3(2.5, 64, .5), width: name === 'end_crystal' ? 2 : .98, height: name === 'end_crystal' ? 2 : .98 }
  const bot = { health: 20, entity: { id: 1, position: new Vec3(.5, 64, .5) },
    inventory: { slots: Array(46).fill(null), items: () => [{ name: 'totem_of_undying' }] },
    nearestEntity: filter => filter(entity) ? entity : null,
    blockAt: p => ({ position: p, name: wall && p.x === 1 ? 'stone' : 'air', boundingBox: wall && p.x === 1 ? 'block' : 'empty', shapes: wall && p.x === 1 ? [[0, 0, 0, 1, 1, 1]] : [] }) }
  assert.equal(wantTotem(bot).yes, false)
  wall = false
  assert.equal(wantTotem(bot).yes, true)
  entity.position.x = 8.5
  assert.equal(wantTotem(bot).yes, false, 'visible but outside the existing threat radius')
})

function popFixture () {
  const bot: any = { entity: { id: 1 }, _client: new EventEmitter(), quickBarSlot: 0,
    inventory: { slots: Array(46).fill(null), items: () => [] }, setQuickBarSlot () {} }
  bot.inventory.slots[36] = { name: 'totem_of_undying' }
  bot._client.write = () => {}
  const state = totem.install(bot)
  const pop = () => bot._client.emit('entity_status', { entityId: 1, entityStatus: 35 })
  return { bot, state, pop }
}

test('totem snapshots are detached, read-only and delta only covers the requested interval', () => {
  const f = popFixture()
  for (let i = 0; i < 9; i++) f.pop()
  const before = totem.snapshot(f.bot)
  f.pop(); f.pop()
  const after = totem.snapshot(f.bot)
  assert.equal(before.pops, 9)
  assert.equal(before.why['сработал'], 9)
  assert.deepEqual(plain(totem.delta(before, after)), { pops: 2, reequips: 2, fails: 0, fast: 2, slow: 0, why: { 'сработал': 2 } })
  assert.equal(f.state.pops, 11, 'reporting never resets the lifetime reflex')
  assert.equal(f.bot._client.listenerCount('entity_status'), 1)
  const next = totem.snapshot(f.bot)
  assert.equal(totem.delta(next, totem.snapshot(f.bot)).pops, 0, 'previous rounds are not counted again')
})

test('missing boundary or a replaced bot makes the full-round totem count unknown', () => {
  const a = popFixture(); const b = popFixture()
  assert.equal(totem.delta(totem.snapshot(a.bot), totem.snapshot(b.bot)), null)
  assert.equal(totem.delta(null, totem.snapshot(b.bot)), null)
  assert.equal(totem.snapshot(null), null)
  const empty: any = { entity: { id: 3 } }
  const before = totem.snapshot(empty)
  assert.equal(empty._ndTotem, undefined, 'status must not install a combat reflex')
  assert.equal(totem.delta(before, totem.snapshot(empty)).pops, 0)
})

test('status totem telemetry is opt-in and uses the same live counters without installing listeners', async () => {
  const file = path.join(__dirname, '../src/index.ts')
  const source = fs.readFileSync(file, 'utf8')
  const method = source.slice(source.indexOf('  status: async (p) =>'), source.indexOf('  // Наблюдатель сцены'))
  const f = popFixture(); f.pop()
  const context = { cfg: {}, session: { bot: f.bot, immediate: async fn => fn() }, require: name => {
    assert.equal(name, './totem'); return totem
  }, status: null }
  vm.runInNewContext(`this.status = ({${method}}).status`, context)
  assert.equal((await context.status({})).totem, undefined)
  const before = (await context.status({ totem: true })).totem
  f.pop()
  const after = (await context.status({ totem: true })).totem
  assert.equal(totem.delta(before, after).pops, 1)
  assert.equal(f.bot._client.listenerCount('entity_status'), 1)
})

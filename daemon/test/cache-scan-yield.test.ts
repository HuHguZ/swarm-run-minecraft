import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { cacheScan } from '../src/cache-scan'
import { castRays, CacheModel, pieCounts } from '../src/swarm/cache-model'
import { cacheMethods } from '../src/rpc/caches'
import { Session } from '../src/session'
import clock = require('../src/game-clock')
import pick = require('../src/pick')
import { block, data, testBot } from './tick-plugins-fixture'

function fixture(t, slow = 'rays') {
  const bot = testBot(); bot.health = 20; bot.game.height = 384; bot.game.dimension = 'overworld'
  let ms = 0, reads = 0, chestChecks = 0, sections = 0, beats = 0
  t.mock.method(clock.wall, 'monotonic', () => ms)
  const state = (x, y, z) => y <= 0 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState
  bot.world = { getColumn: (cx, cz) => ({ getBlockStateId(p) { reads++; if (slow === 'rays') ms++; return state(cx * 16 + p.x, p.y, cz * 16 + p.z) } }) }
  const chests = Array.from({ length: 12 }, (_, i) => new Vec3(i, 1, 3))
  bot.findBlocks = () => chests
  t.mock.method(pick, 'blockSeen', () => { chestChecks++; if (slow === 'chests') { ms += 5; setImmediate(() => beats++) }; return true })
  bot._ndEyes = {
    shapes: { opaque: s => s === data.blocksByName.stone.defaultState }, syncDim() {},
    sectionsNear: () => Array.from({ length: 12 }, (_, cx) => ({ cx, cz: 0, sy: 0 })),
    section: (_read, cx) => { sections++; if (slow === 'pie') { ms += 5; setImmediate(() => beats++) }; return { cells: [{ x: cx, y: 1, z: 3, pie: true, name: 'chest' }] } }
  }
  return { bot, chests, stats: () => ({ reads, chestChecks, sections, beats }), opaque: (x, y, z) => state(x, y, z) === data.blocksByName.stone.defaultState ? 1 : 0 }
}
const options = { rays: 32, range: 8, spin: .25, pieStep: 5, pieRange: 64 }

for (const stage of ['rays', 'chests', 'pie']) test(`cache scan lets an I/O turn run during ${stage} and preserves the complete static report`, async t => {
  const f = fixture(t, stage)
  let during = null
  setImmediate(() => { during = f.stats() })
  const scan = await cacheScan(f.bot, options)
  assert.ok(during, 'a queued body/network callback must run before the scan completes')
  if (stage === 'rays') assert.ok(during.reads > 0 && during.reads < f.stats().reads)
  if (stage !== 'rays') assert.ok(f.stats().beats > 0, 'the expensive stage must yield internally')
  assert.deepEqual(scan.hits, castRays(scan.eye, f.opaque, 32, .25, 8))
  assert.deepEqual(scan.chests, f.chests.map(p => [p.x, p.y, p.z]))
  assert.deepEqual(scan.pie.bins, pieCounts(scan.eye, f.chests, 5, 64))
})

test('movement returns only rays from the original eye; unfinished directions stay unknown to the real cache model', async t => {
  const f = fixture(t)
  setImmediate(() => { f.bot.entity.position.x += 1 })
  const scan = await cacheScan(f.bot, options)
  assert.equal(scan.eye.x, .5)
  const pending = h => Array.isArray(h) && h.length === 1 && h[0] === 0
  assert.ok(scan.hits.some(pending), 'uncomputed directions must not be reported as clear air')
  assert.ok(scan.hits.some(h => !pending(h)), 'completed observations survive movement')
  assert.equal(f.stats().chestChecks, 0, 'do not mix later chest sightings with the old origin')
  const expected = castRays(scan.eye, f.opaque, 32, .25, 8)
  scan.hits.forEach((h, i) => { if (!pending(h)) assert.deepEqual(h, expected[i]) })
  const box = { x0: -8, x1: 8, y0: -8, y1: 8, z0: -8, z1: 8 }
  const safe = new CacheModel(box), invented = new CacheModel(box)
  safe.addScan(scan); invented.addScan({ ...scan, hits: scan.hits.map(h => pending(h) ? 0 : h) })
  assert.ok([...invented.state].filter(s => s === 1).length > [...safe.state].filter(s => s === 1).length)
})

for (const event of ['death', 'end', 'respawn', 'world', 'dimension', 'entity']) test(`cache scan discards a partial report after ${event} and releases its listeners`, async t => {
  const f = fixture(t)
  setImmediate(() => {
    if (event === 'world') f.bot.world = {}
    else if (event === 'dimension') f.bot.game.dimension = 'the_nether'
    else if (event === 'entity') f.bot.entity = { ...f.bot.entity }
    else f.bot.emit(event)
  })
  assert.equal(await cacheScan(f.bot, options), null)
  for (const name of ['death', 'end', 'respawn', 'blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload']) assert.equal(f.bot.listenerCount(name), 0)
})

for (const event of ['blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload']) test(`${event} ends the old scan before its cached column can supply new observations`, async t => {
  const f = fixture(t)
  setImmediate(() => f.bot.emit(event, block('air', new Vec3(1, 1, 0)), block('stone', new Vec3(1, 1, 0))))
  const scan = await cacheScan(f.bot, options)
  assert.ok(scan.hits.some(h => Array.isArray(h) && h[0] === 0))
  assert.equal(f.stats().chestChecks, 0)
})

for (const stage of ['chests', 'pie']) test(`movement during ${stage} keeps earlier sightings without publishing partial pie counts`, async t => {
  const f = fixture(t, stage), owner = stage === 'chests' ? f.bot : f.bot._ndEyes, method = stage === 'chests' ? 'findBlocks' : 'sectionsNear'
  const original = owner[method]
  owner[method] = (...args) => { setImmediate(() => { f.bot.entity.position.x++ }); return original.apply(owner, args) }
  const scan = await cacheScan(f.bot, options)
  assert.deepEqual(scan.hits, castRays(scan.eye, f.opaque, 32, .25, 8))
  assert.ok(scan.chests.length > 0)
  assert.equal(scan.pie, undefined, 'incomplete F3 counts cannot erase previously observed chest evidence')
  if (stage === 'chests') assert.ok(scan.chests.length < f.chests.length)
})

test('the actual cache_scan RPC waits for the cooperative report through Session.immediate', async t => {
  const f = fixture(t)
  const session: any = { bot: f.bot, bus: { drain: () => [] }, state: () => ({}), require: () => f.bot, immediate: Session.prototype.immediate }
  let beat = false; setImmediate(() => { beat = true })
  const reply = await cacheMethods({ session } as any).cache_scan(options)
  assert.equal(beat, true)
  assert.equal(reply.status, 'done')
  assert.equal(reply.detail.hits.length, 32)
  assert.equal(reply.detail.then, undefined)
})

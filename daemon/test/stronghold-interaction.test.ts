'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { Module, createRequire } = require('node:module')
const Vec3 = require('vec3')

function room ({ wall = false, glass = false, spawners = [], hidden = new Set(), onEquip = null, onLook = null }: any = {}) {
  const filename = path.resolve(__dirname, '../src/endportal.js'), real = createRequire(filename)
  const md = real('minecraft-data')('1.21.11'), frames = [], clicks = [], digs = [], walks = [], looks = []
  let now = 0, eyes = 1
  const ctl = { aborted: false, onAbort: [] }
  for (const a of [-1, 0, 1]) for (const b of [-2, 2]) frames.push(new Vec3(a, 64, b), new Vec3(b, 64, a))
  const target = new Vec3(0, 64, -2), filled = new Set(frames.filter(p => !p.equals(target)).map(String))
  const solid = (name, p, shapes = [[0, 0, 0, 1, 1, 1]]) => ({ name, type: md.blocksByName[name].id, position: p.floored(), shapes, boundingBox: 'block' })
  const bot: any = { registry: md, health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { position: new Vec3(.5, 64, -3.5), onGround: true, height: 1.8 }, entities: {},
    inventory: { items: () => eyes ? [{ name: 'ender_eye', type: md.itemsByName.ender_eye.id, count: eyes }] : [] },
    blockAt (pos) {
      const p = pos.floored()
      if (p.y === 65 && p.z === -3 && (wall || glass)) return solid(glass ? 'glass' : 'stone', p)
      if (p.y < 64) return solid('stone', p)
      if (frames.some(f => f.equals(p))) return { ...solid('end_portal_frame', p, [[0, 0, 0, 1, .8125, 1]]), getProperties: () => ({ eye: filled.has(String(p)), facing: 'south' }) }
      if (spawners.some(s => s.equals(p)) && !digs.some(d => d.pos.equals(p))) return solid('spawner', p)
      return { name: 'air', type: 0, position: p, shapes: [], boundingBox: 'empty' }
    },
    findBlocks ({ matching, count = Infinity }) {
      if (matching.includes(md.blocksByName.end_portal_frame.id)) return frames.slice(0, count)
      if (matching.includes(md.blocksByName.spawner.id)) return spawners.slice(0, count)
      if (matching.includes(md.blocksByName.end_portal.id) && filled.size === 12) return Array.from({ length: 9 }, (_, i) => new Vec3(i % 3 - 1, 64, Math.floor(i / 3) - 1))
      return []
    },
    equip: async () => { onEquip?.(ctl) },
    lookAt: async point => { looks.push(point); onLook?.(ctl, () => { wall = true }) },
    dig: async (block, forceLook) => { digs.push({ pos: block.position, forceLook }) },
    activateBlock: async (block, face, cursor) => { clicks.push({ pos: block.position, face, cursor, legacy: true }); filled.add(String(block.position)); eyes-- },
    _genericPlace: async (block, face, opts) => { clicks.push({ pos: block.position, face, cursor: opts.delta, forceLook: opts.forceLook }); filled.add(String(block.position)); eyes-- },
    pathfinder: { goto: async goal => { walks.push(goal) }, setGoal: () => {} }
  }
  const mocks = {
    './game-clock': { now: () => now, setTimeout: () => ({}), clearTimeout: () => {} },
    './movement': { sleep: async ms => { now += ms }, xyz: p => ({ x: p.x, y: p.y, z: p.z }), stuckGuard: () => ({ promise: new Promise(() => {}), stop: () => {} }) },
    './sight': { seesBlock: (_b, block) => !hidden.has(String(block.position)) },
    './items': { countOf: () => eyes, itemNamed: () => eyes ? { name: 'ender_eye' } : null, equipBestTool: async () => bot.equip({ name: 'iron_pickaxe' }, 'hand') }
  }
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename))
  mod.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : real(name)
  mod._compile(fs.readFileSync(filename, 'utf8'), filename)
  const session = { bot, mcData: md, journal: { state: { places: { 'портал в Край': { x: 0, y: 64, z: 0, dimension: 'overworld' } } }, patch: fn => fn(session.journal.state), append: () => {} } }
  return { bot, target, ctl, clicks, digs, walks, looks, run: () => mod.exports.fillFrames(session, ctl, { timeoutSeconds: 90 }) }
}

for (const glass of [false, true]) test(`fill does not click through ${glass ? 'glass' : 'stone'} even with remembered frame coordinates`, async () => {
  const s = room({ wall: !glass, glass })
  const r = await s.run()
  assert.equal(s.clicks.length, 0)
  assert.equal(r.lit, false)
})

test('fill uses a reachable face and preserves its cursor instead of activateBlock recentering the look', async () => {
  const s = room(), r = await s.run()
  assert.equal(r.lit, true)
  assert.equal(s.clicks.length, 1)
  const c = s.clicks[0]
  assert.equal(c.legacy, undefined)
  assert.equal(c.forceLook, 'ignore')
  assert.equal(typeof c.cursor.minus, 'function')
  assert.ok(['x', 'y', 'z'].every(k => Number.isFinite(c.cursor[k]) && c.cursor[k] >= 0 && c.cursor[k] <= 1))
  assert.ok(s.looks.at(-1).distanceTo(c.pos.plus(c.cursor)) < 1e-9)
})

test('fill attempts to get a line of sight before reporting an occluded frame', async () => {
  const s = room({ wall: true }), r = await s.run()
  assert.equal(r.lit, false)
  assert.ok(s.walks.length > 0)
  assert.equal(s.clicks.length, 0)
})

test('fill can use a face between 4.2 and the physical 4.5 block reach without an extra walk', async () => {
  const s = room()
  s.bot.entity.position.z = -6.3
  const r = await s.run()
  assert.equal(r.lit, true)
  assert.equal(s.walks.length, 0)
})

test('fill rechecks cancellation after equipping the eye', async () => {
  const s = room({ onEquip: ctl => { ctl.aborted = true } })
  await s.run()
  assert.equal(s.clicks.length, 0)
})

test('fill rechecks the ray after awaiting lookAt', async () => {
  const s = room({ onLook: (_ctl, obstruct) => obstruct() })
  await s.run()
  assert.equal(s.clicks.length, 0)
})

test('room spawner selection ignores hidden candidates instead of walking toward a loaded dungeon', async () => {
  const hidden = new Vec3(-2, 64, -3), visible = new Vec3(2, 64, -3)
  const s = room({ spawners: [hidden, visible], hidden: new Set([String(hidden)]) })
  const r = await s.run()
  assert.deepEqual(r.spawner.at, { x: visible.x, y: visible.y, z: visible.z })
  assert.equal(s.digs.length, 1)
  assert.ok(s.digs[0].pos.equals(visible))
  assert.equal(s.digs[0].forceLook, 'ignore')
})

test('room spawner is left alone if none has been seen', async () => {
  const hidden = new Vec3(0, 64, -4), s = room({ spawners: [hidden], hidden: new Set([String(hidden)]) })
  const r = await s.run()
  assert.equal(s.digs.length, 0)
  assert.equal(r.spawner, undefined)
})

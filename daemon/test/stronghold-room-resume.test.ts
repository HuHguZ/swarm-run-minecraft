'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

function roomScene (estimate = null) {
  const path: typeof import('node:path') = require('node:path')
  const { Module, createRequire }: typeof import('node:module') = require('node:module')
  const filename = path.resolve(__dirname, '../src/endportal.js')
  const real = createRequire(filename)
  const bot: any = new EventEmitter()
  const ctl = { aborted: false, onAbort: [] }
  let now = 0; let offHold = false; const walks = []; const bores = []; const descents = []
  const md = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  bot.registry = md; bot.health = 20; bot.food = 20
  bot.entity = { position: new Vec3(.5, 64, .5), onGround: true }
  bot.entities = {}; bot.inventory = { items: () => [] }
  bot.findBlocks = () => []
  bot.blockAt = p => ({ name: p.y < bot.entity.position.y ? offHold ? 'stone' : 'stone_bricks' : 'air', boundingBox: p.y < bot.entity.position.y ? 'block' : 'empty', position: p.floored() })
  bot.pathfinder = { movements: { blocksCantBreak: new Set() }, goto: async goal => {
    walks.push(goal); bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5); ctl.aborted = true
  }, setGoal: () => {} }
  const senses = { pieArcs: () => [{ center: 0 }], triangulate: () => estimate, vecOf: () => ({ x: 0, z: 1 }), hearLavaPoint: () => null }
  const mocks = {
    './game-clock': { now: () => now, setInterval: () => ({}), clearInterval: () => {}, setTimeout: () => ({}), clearTimeout: () => {} },
    './movement': { sleep: async () => { now += 50 }, xyz: p => ({ x: p.x, y: p.y, z: p.z }), stuckGuard: () => ({ promise: new Promise(() => {}), stop: () => {} }) },
    './walkable': { walkable: () => Array.from({ length: 8 }, (_, i) => ({ pos: bot.entity.position.floored().offset(i + 1, 0, 0), d: i + 1 })) },
    './perception': { eyePos: b => b.entity.position.offset(0, 1.62, 0), raySees: () => true },
    './perception/eyes': { seesNow: () => false, entities: () => [] },
    './perception/senses': senses,
    './perception/knowledge': { level: () => 'rsg' },
    './stronghold': { mappedRoom: () => null },
    './worlds': { worldOf: () => 'overworld' },
    './combat': { nearestHostile: () => null },
    './nether': { guarded: async (_s, _c, fn) => fn(ctl) },
    './endportal-descent': {
      honestBore: async (_s, _c, target, opts) => { bores.push({ target, opts }); ctl.aborted = true; return { moved: 30, dug: 58 } },
      honestEnter: async () => { descents.push(bot.entity.position.clone()); bot.entity.position.y -= 10; ctl.aborted = true; return { inside: false, steps: ['down'] } },
      pieElevation: () => null
    }
  }
  const module: any = new Module(filename)
  module.filename = filename; module.paths = (Module as any)._nodeModulePaths(path.dirname(filename))
  module.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : real(name)
  // Тело endportal разнесено по endportal/: bodySource склеивает его в один скрипт — подмены по spec (и ленивые) доходят до частей.
  module._compile((require('./source-fixture') as typeof import('./source-fixture')).bodySource(filename), filename)
  const session: any = { bot, mcData: md, journal: { state: { places: {} } }, _roomExplore: { key: 'нет', visited: [], known: new Map(), failed: new Set(), pie: [{ x: -8, z: 0, yaw: 0 }, { x: -4, z: 0, yaw: 0 }] } }
  return { bot, ctl, session, walks, bores, descents, run: () => module.exports.findRoom(session, ctl, { go: false, timeoutSeconds: 40 }), leaveCorridor () { offHold = true; bot.entity.position = new Vec3(20.5, 54, .5); ctl.aborted = false } }
}

for (const estimate of [null, { x: 20, z: 20, spread: NaN }, { x: 20, z: 20, spread: Infinity }, { x: 20, z: 20, spread: 0, uncertainty: 20 }]) test(`room follows corridors when two pie samples lack precision (${estimate ? String(estimate.spread) + '/' + estimate.uncertainty : 'parallel'})`, async () => {
  const s = roomScene(estimate)
  await s.run()
  assert.equal(s.bores.length, 0, 'a bearing fallback is not a triangulated location')
  assert.equal(s.walks.length, 1)
})

test('room keeps the immediate bore for a finite, well-conditioned pie estimate', async () => {
  const s = roomScene({ x: 20, z: 20, spread: .1, uncertainty: 1 })
  await s.run()
  assert.equal(s.bores.length, 1)
  assert.equal(s.bores[0].opts.maxSteps, 48)
})

test('room resumes an explored stronghold by returning to its observed corridor instead of descending again', async () => {
  const s = roomScene()
  await s.run()
  s.leaveCorridor()
  await s.run()
  assert.equal(s.descents.length, 0)
  assert.equal(s.walks.length, 2)
  assert.equal(s.walks[1].y, 64, 'the remembered corridor is above the stray tunnel')
  assert.equal(s.bot.entity.position.y, 64)
})

test('two nearly parallel pie bearings have finite residual but large position uncertainty', () => {
  const { triangulate }: typeof import('../src/perception/senses') = require('../src/perception/senses')
  const s = [{ x: 1140.52, z: 900.5, yaw: 119 }, { x: 1130.5, z: 894.5, yaw: 117 }]
  const e = triangulate(s)
  assert.ok(e && Number.isFinite(e.spread), JSON.stringify(e))
  assert.ok(e.uncertainty > 6, JSON.stringify(e))
  const good = triangulate([{ x: 0, z: 0, yaw: -45 }, { x: 40, z: 0, yaw: 45 }])
  assert.ok(good && good.uncertainty < 1, JSON.stringify(good))
})

function enterScene (brick = false) {
  const path: typeof import('node:path') = require('node:path')
  const { Module, createRequire }: typeof import('node:module') = require('node:module')
  const filename = path.resolve(__dirname, '../src/endportal-descent.js')
  const real = createRequire(filename)
  const ctl = { aborted: false }
  const dug = []; const air = new Set()
  const bot: any = { entity: { position: new Vec3(.5, 64, .5), onGround: true }, health: 20,
    blockAt: p => ({ name: air.has(p.toString()) ? 'air' : brick && p.x === 1 && p.z === 0 && p.y >= 64 ? 'stone_bricks' : 'stone', boundingBox: air.has(p.toString()) ? 'empty' : 'block', position: p }),
    digTime: () => 100, dig: async b => { dug.push(b.position); air.add(b.position.toString()); ctl.aborted = true }
  }
  const mocks = { './game-clock': { now: () => 0 }, './movement': { sleep: async () => {}, xyz: p => p }, './items': { equipBestTool: async () => {}, missingHarvestTool: () => null }, './perception/eyes': { seesNow: () => true } }
  const module: any = new Module(filename)
  module.filename = filename; module.paths = (Module as any)._nodeModulePaths(path.dirname(filename))
  module.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : real(name)
  module._compile((require('node:fs') as typeof import('node:fs')).readFileSync(filename, 'utf8'), filename)
  return { bot, dug, run: () => module.exports.honestEnter({ bot }, ctl, { deadline: 1000, roomy: () => false, bricks: /^stone_bricks$/, allowDescent: false }) }
}

test('a dead end after entering the stronghold does not dig a new downward staircase', async () => {
  const s = enterScene()
  const r = await s.run()
  assert.deepEqual(s.dug, [])
  assert.deepEqual(r.steps, [])
  assert.equal(s.bot.entity.position.y, 64)
})

test('a dead end after entering the stronghold can still open a visible brick wall', async () => {
  const s = enterScene(true)
  const r = await s.run()
  assert.ok(s.dug.length > 0)
  assert.ok(r.steps.some(x => x.startsWith('сквозь стену')), JSON.stringify(r))
  assert.equal(s.bot.entity.position.y, 64)
})

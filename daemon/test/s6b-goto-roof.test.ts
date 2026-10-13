'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')

// session.goto with a stubbed pathfinder (as goto.test.ts): which surface walk did the attempt use?
function fixture (skyAt: (p: any) => number, open = true) {
  const file = path.join(__dirname, '../src/session.js')
  const realRequire = createRequire(file)
  const context = { module: { exports: {} as Record<string, any> }, console, setTimeout, clearTimeout, Date,
    require: name => {
      const actual = realRequire(name)
      if (name === './build') return { ...actual, escapePit: async () => ({ wasInPit: false }) }
      if (name === './movement') return { ...actual, inWater: () => false, stuckGuard: () => ({ promise: new Promise<void>(() => {}), stop () {} }), unstick: async () => {} }
      return actual
    } }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(10.5, 100, 0.5), onGround: true }
  bot.world = { getColumnAt: () => ({ minY: -64, skyLightSections: Array(26).fill({}) }) }
  bot.blockAt = (p: any) => ({ position: p, skyLight: skyAt(p), boundingBox: p.y === 99 ? 'block' : 'empty', name: 'air' })
  const seen: boolean[] = []
  const dig: boolean[] = []
  const session: any = { bot, require: () => bot, updateMovements () {}, underSky: () => open, runIntent: (_name, work) => work({ aborted: false, onAbort: [] }) }
  bot.pathfinder = { movements: { canDig: true, scafoldingBlocks: [] },
    setGoal (goal) { if (!goal) return; seen.push(session.surfaceWalk); dig.push(bot.pathfinder.movements.canDig); bot.entity.position = new Vec3(goal.x + .5, 100, goal.z + .5); setImmediate(() => bot.emit('path_update', { status: 'success', path: [] })) },
    goto: async () => {} }
  return { goto: p => context.module.exports.Session.prototype.goto.call(session, p), seen, dig }
}

test('goto into a roofed room drops the roof step cost; an open-sky goal keeps it (arena mirror asymmetry, s6b 06.10)', async () => {
  // Room x <= 0 under a roof (sky 4), field x > 0 open (15).
  const roofed = fixture(p => p.x <= 0 ? 4 : 15)
  await roofed.goto({ x: -2, y: 100, z: 0, range: 1 })
  assert.deepEqual(roofed.seen, [false], 'a roofed goal cannot be reached over the surface')
  const open = fixture(p => p.x <= 0 ? 4 : 15)
  await open.goto({ x: 20, y: 100, z: 0, range: 1 })
  assert.deepEqual(open.seen, [true], 'an open-sky goal still prefers the surface')
})

test('goto without y keeps the strict surface walk when the goal column is a mountain (no tunnel through it, S6c 07.10)', async () => {
  // Mountain at x <= 0: at body height (y 100) its column is solid rock, sky 0. The body will stand on its top.
  const hill = fixture(p => p.x <= 0 ? 0 : 15)
  await hill.goto({ x: -2, z: 0, range: 1, surface: 'strict' })
  assert.deepEqual(hill.seen, [true], 'no y: the roof check must not read the rock at body height')
  assert.deepEqual(hill.dig, [false], 'strict still forbids digging')
  // A roofed goal with y drops only the roof step cost: strict still forbids digging.
  const room = fixture(p => p.x <= 0 ? 4 : 15)
  await room.goto({ x: -2, y: 100, z: 0, range: 1, surface: 'strict' })
  assert.deepEqual(room.seen, [false])
  assert.deepEqual(room.dig, [false], 'a roofed goal is no licence to dig')
})

test('explicit overland XZ travel keeps its surface price after entering a cave; cave targets remain reachable', async () => {
  const overland = fixture(() => 0, false)
  await overland.goto({ x: 50, z: 0, surface: true })
  assert.deepEqual(overland.seen, [true], 'entering a cave must not erase the overland intent')
  assert.deepEqual(overland.dig, [true], 'surface preference must not forbid digging')
  const cave = fixture(() => 0, false)
  await cave.goto({ x: 50, y: 100, z: 0, surface: true })
  assert.deepEqual(cave.seen, [false], 'an explicit roofed destination still asks to enter the cave')
  const optOut = fixture(() => 0, false)
  await optOut.goto({ x: 50, z: 0, surface: false })
  assert.deepEqual(optOut.seen, [false])
})

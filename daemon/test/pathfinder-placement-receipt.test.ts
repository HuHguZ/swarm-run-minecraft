'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { transformSync } = require('esbuild')
const { Vec3 } = require('vec3')
const Move = require('mineflayer-pathfinder/lib/move')
const { Movements, goals } = require('mineflayer-pathfinder')

const fixtureFile = path.join(__dirname, 'tick-plugins.test.ts')
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split('\ntest(')[0]
const helpers: any = { exports: {} }
new Function('require', 'module', 'exports', transformSync(fixtureSource + '\nmodule.exports = { install, testClock, block }', {
  loader: 'ts', format: 'cjs', target: 'node22'
}).code)(createRequire(fixtureFile), helpers, helpers.exports)

async function placement (useOne = false) {
  const { install, testClock, block } = helpers.exports
  const bot = install(testClock(750), { pathfinder: true, physicsEnabled: false })
  bot.entity.position.set(-414.5, 56, 171.5)
  const destination = new Vec3(-415, 56, 171)
  let placed = 'air'
  bot.blockAt = p => block(p.floored().equals(destination) ? placed : p.y < 56 ? 'nether_bricks' : 'air', p)
  const mv = new Movements(bot)
  mv.canDig = false
  mv.getScaffoldingItem = () => ({ name: 'nether_bricks', type: bot.registry.itemsByName.nether_bricks.id, count: 8 })
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.LOSWhenPlacingBlocks = false
  const node = new Move(-415, 57, 171, 7, 1)
  node.toPlace.push({ x: -415, y: 55, z: 171, dx: 0, dy: 1, dz: 0, useOne })
  const start = new Move(-414, 56, 171, 8, 0)
  mv.getNeighbors = from => from.hash === start.hash ? [node] : []
  const goal = new goals.GoalBlock(-415, 57, 171)
  const published = [node]
  bot.pathfinder.getPathTo = () => ({ status: 'success', path: published })
  const resets = []
  bot.on('path_reset', reason => resets.push(reason))
  let finish, reject
  const pending = new Promise<void>((resolve, no) => { finish = resolve; reject = no })
  let attempt = null
  bot.equip = async () => {}
  bot.placeBlock = (ref, face) => { attempt = ref.position.plus(face); return pending }
  bot.activateBlock = ref => { attempt = ref.position; return pending }
  bot.pathfinder.setGoal(goal)
  bot.emit('physicsTick')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attempt, useOne ? destination.offset(0, -1, 0) : destination, 'the actual installed executor has sent this action')
  assert.equal(node.toPlace.length, 0, 'native consumes the action before its server receipt')
  const normalize = (point = node) => {
    mv.getNeighbors = from => from.hash === start.hash ? [point] : []
    const search = bot.pathfinder.getPathFromTo(mv, bot.entity.position, goal, { startMove: start })
    try { return search.next().value.result.path } finally { search.return() }
  }
  const update = (position = destination, name = 'nether_bricks') => {
    const old = block('air', position)
    if (position.equals(destination)) placed = name
    bot.emit('blockUpdate', old, block(name, position))
  }
  return { bot, node, goal, resets, destination, normalize, update,
    replaceHead: () => { published[0] = new Move(-415, 57, 171, 7, 1) },
    complete: async () => { finish(); await new Promise(resolve => setImmediate(resolve)) },
    fail: async () => { reject(new Error('server rejected placement')); await new Promise(resolve => setImmediate(resolve)) },
    close: () => { finish(); bot.pathfinder.setGoal(null); bot.emit('end') } }
}

test('native pending support retains its planned standing height across another A* publication', async () => {
  const s = await placement()
  try {
    assert.equal(s.bot.pathfinder.isBuilding(), true)
    const path = s.normalize()
    assert.equal(path[0], s.node, 'continuing A* and the executor share this actual Move')
    assert.equal(s.node.y, 57, 'an unconfirmed support must not normalize the standing point to the old floor')
    s.update()
    await s.complete()
    s.normalize()
    assert.equal(s.node.y, 57, 'confirmed solid support now supplies the physical standing height')
    assert.equal(s.node.x, -414.5)
  } finally { s.close() }
})

test('exact confirmed native support preserves the active path and placement owner', async () => {
  const s = await placement()
  try {
    s.update()
    assert.deepEqual(s.resets, [], 'own successful construction must not restart search from the old floor')
    assert.equal(s.bot.pathfinder.isMoving(), true)
    assert.equal(s.bot.pathfinder.isBuilding(), true, 'the placement promise still owns its completion')
    assert.equal(s.bot.pathfinder.goal, s.goal)
    await s.complete()
    assert.equal(s.bot.pathfinder.isBuilding(), false)
    assert.equal(s.bot.pathfinder.isMoving(), true)
  } finally { s.close() }
})

for (const [label, position, name] of [
  ['external nearby change', new Vec3(-415, 57, 171), 'stone'],
  ['wrong destination block', new Vec3(-415, 56, 171), 'stone'],
  ['failed destination remains nonsolid', new Vec3(-415, 56, 171), 'water']
] as Array<[string, any, string]>) test(`native placement still resets for ${label}`, async () => {
  const s = await placement()
  try {
    s.update(position, name)
    assert.deepEqual(s.resets, ['block_updated'])
    assert.equal(s.bot.pathfinder.isMoving(), false)
    assert.equal(s.bot.pathfinder.isBuilding(), false)
  } finally { s.close() }
})

test('a goal cancellation revokes the old native placement receipt', async () => {
  const s = await placement()
  try {
    s.bot.pathfinder.setGoal(new goals.GoalBlock(-410, 56, 171))
    s.bot.emit('physicsTick')
    s.resets.length = 0
    s.update()
    assert.deepEqual(s.resets, ['block_updated'], 'old completion cannot exempt a new path from world changes')
  } finally { s.close() }
})

test('a different current first Move cannot inherit the pending placement exemption', async () => {
  const s = await placement()
  try {
    s.replaceHead()
    s.update()
    assert.deepEqual(s.resets, ['block_updated'])
  } finally { s.close() }
})

test('another Move still normalizes against its actual physical support', async () => {
  const s = await placement()
  try {
    const other = new Move(-415, 57, 171, 7, 1)
    s.normalize(other)
    assert.equal(other.y, 56, 'pending construction is not a global height lock')
    assert.equal(s.node.y, 57)
  } finally { s.close() }
})

test('failed native placement revokes its receipt before another path starts', async () => {
  const s = await placement()
  try {
    await s.fail()
    assert.deepEqual(s.resets, ['place_error'])
    s.bot.emit('physicsTick')
    s.resets.length = 0
    s.update()
    assert.deepEqual(s.resets, ['block_updated'])
  } finally { s.close() }
})

test('native block activation cannot claim an unrelated scaffold update', async () => {
  const s = await placement(true)
  try {
    s.update()
    assert.deepEqual(s.resets, ['block_updated'])
  } finally { s.close() }
})

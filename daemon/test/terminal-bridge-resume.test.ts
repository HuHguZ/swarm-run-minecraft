const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const movement = require('../src/movement')
const blockmoves = require('../src/blockmoves')

function bridgeFixture () {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { position: new Vec3(2.7, 1, 1.05), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0 }
  bot.health = 20
  bot.inventory = { slots: Array(46).fill(null), items: () => [] }
  bot.getControlState = () => false
  bot.setControlState = () => {}
  bot.look = async () => {}
  bot.blockAt = p => ({ name: p.y < 1 ? 'stone' : 'air', boundingBox: p.y < 1 ? 'block' : 'empty', position: p.floored() })
  let path = [], count = 0
  bot.pathfinder = {
    goal: null, movements: {}, isMoving: () => path.length > 0,
    isMining: () => false, isBuilding: () => false,
    setGoal (g) { this.goal = g; count++; bot.emit('goal_updated', g) }
  }
  const goal = new goals.GoalBlock(2, 1, 0)
  const walk = movement.gotoGoal(bot, goal)
  walk.catch(() => {})
  const n: any = new Vec3(2.5, 1, .5)
  Object.assign(n, { hash: '2,1,0', cost: 1, toBreak: [], toPlace: [], ndBridge: { ref: { x: 1, y: 0, z: 0 }, dir: { x: 1, z: 0 } } })
  const context = { bestNode: { data: n, parent: { data: new Vec3(1.5, 1, .5) } }, openDataMap: new Map() }
  const r = { status: 'success', path: [n], context }
  bot.emit('path_update', r)
  path = r.path
  const exec = blockmoves.install({ bot, pathNodes: path, lastPath: r }, { log: () => {} })
  return { bot, goal, path, exec, walk, count: () => count, close () { exec.stop(); walk.cancel() } }
}

test('the actual bridge consumer exhausts a terminal path outside the goal and rebases it', () => {
  const f = bridgeFixture()
  try {
    assert.equal(f.goal.isEnd(f.bot.entity.position), false)
    f.exec.step()
    assert.equal(f.exec.stats.selfShift, 1)
    assert.equal(f.path.length, 0)
    assert.equal(f.bot.pathfinder.isMoving(), false)
    f.bot.emit('physicsTick')
    assert.equal(f.count(), 2, 'resume from the actual body without waiting for another path publication')
  } finally { f.close() }
})

for (const variant of ['arrived', 'mining', 'building', 'airborne', 'emergency']) test('terminal bridge resume preserves ' + variant, () => {
  const f = bridgeFixture()
  try {
    f.exec.step()
    if (variant === 'arrived') f.bot.entity.position = new Vec3(2.5, 1, .5)
    if (variant === 'mining') f.bot.pathfinder.isMining = () => true
    if (variant === 'building') f.bot.pathfinder.isBuilding = () => true
    if (variant === 'airborne') f.bot.entity.onGround = false
    if (variant === 'emergency') f.bot.pathfinder.goal = null
    f.bot.emit('physicsTick')
    assert.equal(f.count(), 1)
  } finally { f.close() }
})

'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))('1.21.11')
import { Session } from '../src/session'
import movement = require('../src/movement')
import blockmoves = require('../src/blockmoves')

const node = (x, y, z, extra: any = {}) => Object.assign(new Vec3(x, y, z), {
  hash: `${Math.floor(x)},${Math.ceil(y)},${Math.floor(z)}`, cost: 1,
  toBreak: [], toPlace: [], parkour: false, remainingBlocks: 64
}, extra)

function contextFor (nodes) {
  let last: any = { data: new Vec3(.5, 1, .5), parent: null }
  for (const data of nodes) last = { data, parent: last }
  return { bestNode: last, openDataMap: new Map([[last.data.hash, last]]) }
}

function fixture () {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0 }
  bot.health = 20
  bot.registry = data
  const keys: Record<string, boolean> = {}
  bot.setControlState = (key, value) => { keys[key] = value }
  bot.getControlState = key => !!keys[key]
  bot.clearControlStates = () => { for (const key of Object.keys(keys)) keys[key] = false }
  bot.look = () => Promise.resolve()
  bot.blockAt = p => {
    const block = Block.fromStateId(data.blocksByName[p.y < 1 ? 'stone' : 'air'].defaultState, 0)
    block.position = p.floored()
    return block
  }
  bot.inventory = { slots: [], items: () => [] }
  bot.quickBarSlot = 0
  let execution = [], goals = 0
  bot.pathfinder = {
    goal: null, movements: {},
    setGoal (goal) { this.goal = goal; goals++; bot.emit('goal_updated', goal) },
    isMoving: () => execution.length > 0, isMining: () => false, isBuilding: () => false,
    canMove: () => true
  }
  const session: any = { bot, pathNodes: null, lastPath: null }
  // This is the production registration order: Session observes the publication
  // before gotoGoal's per-intent listener, then native assigns result.path.
  bot.on('path_update', r => Session.prototype.notePath.call(session, r))
  const goal = new ((require('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder')).goals.GoalNearXZ)(0, 8, 1)
  const walk = movement.gotoGoal(bot, goal)
  walk.catch(() => {})
  const publish = (status, context, path) => {
    const result = { status, context, path, cost: 8, time: 1, visitedNodes: 2, generatedNodes: 3 }
    bot.emit('path_update', result)
    execution = result.path
    return result
  }
  return { bot, session, publish, keys, goal, get path () { return execution },
    get goals () { return goals }, close () { walk.cancel(); bot.emit('end') } }
}

test('Session path consumers observe the actual first partial and its native consumption', () => {
  const f = fixture()
  try {
    const nodes = [node(.5, 1, 1.5), node(.5, 1, 2.5)]
    f.publish('partial', contextFor(nodes), nodes.slice())
    assert.equal(f.session.pathNodes, f.path)
    f.path.shift()
    assert.equal(f.session.pathNodes[0], nodes[1], 'consumers must advance with the executor')
  } finally { f.close() }
})

test('a held prefix keeps bridge controls on the executed branch when another partial arrives', () => {
  const f = fixture()
  let bridge
  try {
    const first = node(.5, 1, 1.5), held = node(.5, 1, 2.5)
    const context = contextFor([first, held])
    f.publish('partial', context, [first, held])
    f.path.shift()
    bridge = blockmoves.install(f.session, { log () {} })
    const other = node(1.5, 1, .5, { ndBridge: { ref: { x: 0, y: 0, z: 0 }, dir: { x: 1, z: 0 }, y: 1 } })
    f.publish('partial', context, [other])
    assert.equal(f.path[0], held, 'the native executor retains its ready prefix')
    bridge.step()
    assert.equal(!!f.keys.back, false, 'an unexecuted bridge must not turn the body sideways')
    assert.equal(f.session.pathNodes, f.path)
  } finally { bridge?.stop(); f.close() }
})

test('terminal parent-chain replacement reaches existing Session consumers too', () => {
  const f = fixture()
  try {
    const blocked = node(.5, 1, 1.5), ready = [node(1.5, 1, .5), node(1.5, 1, 1.5)]
    const context = contextFor([blocked])
    f.publish('partial', context, [blocked])
    const terminal = contextFor(ready).bestNode
    context.openDataMap.set(ready.at(-1).hash, terminal)
    f.bot.pathfinder.canMove = () => false
    f.publish('success', context, ready.slice(1))
    assert.deepEqual(f.path, ready)
    assert.equal(f.session.pathNodes, f.path)
    f.path.shift()
    assert.equal(f.session.pathNodes[0], ready[1])
  } finally { f.close() }
})

test('a consumed prefix clears consumers while search continues, then rebases an unwalkable terminal', () => {
  const f = fixture()
  try {
    const first = node(.5, 1, 1.5), context = contextFor([first])
    f.publish('partial', context, [first])
    f.path.shift()
    f.publish('partial', context, [node(1.5, 1, 1.5)])
    assert.equal(f.path.length, 0)
    assert.equal(f.session.pathNodes.length, 0, 'old-origin nodes must not steer custom consumers')
    f.bot.emit('physicsTick')
    assert.equal(f.goals, 1, 'keep the continuing search after consuming its partial prefix')
    f.bot.pathfinder.canMove = () => false
    f.publish('success', context, [node(1.5, 1, 1.5)])
    assert.equal(f.session.pathNodes.length, 0, 'an unwalkable terminal must not steer custom consumers either')
    f.bot.emit('physicsTick')
    assert.equal(f.goals, 2)
    assert.equal(f.bot.pathfinder.goal, f.goal)
  } finally { f.close() }
})

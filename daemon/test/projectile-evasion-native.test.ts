import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import threats = require('../src/threats')
import locks = require('../src/reflex-lock')
import { gotoGoal } from '../src/movement/goto'

const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()

for (const threat of ['arrow', 'bow']) test(`native physics keeps pending goto moving forward and sideways under ${threat}`, async t => {
  let now = 1200, settled = false, sideResets = 0, moved = false
  t.mock.method(clock, 'now', () => now)
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const world = { getBlock(p: Vec3) {
    const cell = p.floored(), block = Block.fromStateId(registry.blocksByName[cell.y === 63 ? 'stone' : 'air'].defaultState, 0)
    block.position = cell; return block
  } }
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, health: 20, food: 20,
    game: { dimension: 'overworld', minY: -64, height: 384 }, inventory: { slots: [], items: () => [] }, entities: {},
    _client: Object.assign(new EventEmitter(), { write() {} }), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { id: 1, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, -.0784, 0), yaw: 0, pitch: 0, onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, attributes: {}, effects: {}, metadata: [] },
    physics: native.Physics(registry, world), blockAt: p => world.getBlock(p),
    getControlState: key => controls[key], setControlState(key, value) { if (key === 'jump' && value && !controls.jump) this.jumpQueued = true; controls[key] = value },
    clearControlStates() { for (const key of Object.keys(controls)) this.setControlState(key, false) }
  })
  const goal = { isEnd: (p: Vec3) => p.z <= -20 }, path = [{ x: .5, y: 64, z: -20 }], goals: any[] = []
  bot.pathfinder = { goal: null, path, setGoal(value) { this.goal = value; goals.push(value); bot.emit('goal_updated', value) },
    isMoving: () => true, isMining: () => false, isBuilding: () => false }
  const ctl = { aborted: false }, session: any = { bot, current: { name: 'goto', ctl, params: { z: -20 } } }
  const incoming = { id: 2, name: 'arrow', ticks: 8, at: { x: .5, y: 65, z: .5 }, from: { x: .5, y: 65, z: -8 },
    vel: { x: 0, y: 0, z: 1 }, side: { x: 1, z: 0 }, blockable: true }
  t.mock.method(threats, 'projectileDangers', () => ({ arrows: threat === 'arrow' ? [incoming] : [], potions: [],
    aims: threat === 'bow' ? [{ id: 3, name: 'Archer', weapon: 'bow', at: incoming.from, side: incoming.side }] : [] }))
  locks.install(session)
  const run = gotoGoal(bot, goal)
  const result = run.then(() => { settled = true; return 'arrived' }, error => { settled = true; return error.name })
  // Поздний исполнитель пути продолжает писать свои клавиши; примесь проходит в настоящую интеграцию следующего тика.
  const pathTick = () => {
    bot.setControlState('forward', true); bot.setControlState('left', false); bot.setControlState('right', false)
    if (controls.left || controls.right) sideResets++
  }
  bot.on('physicsTick', pathTick)
  pathTick()
  const start = bot.entity.position.clone()
  try {
    for (let tick = 0; tick < 8; tick++) {
      bot.physics.simulatePlayer(new native.PlayerState(bot, controls), world).apply(bot)
      now += 50; bot.emit('physicsTick'); bot.emit('physicTick')
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(settled, false); assert.equal(bot.pathfinder.goal, goal); assert.equal(bot.pathfinder.path, path)
    }
    assert.ok(Math.abs(bot.entity.position.x - start.x) > .05, `side displacement: ${bot.entity.position}`)
    assert.ok(bot.entity.position.z < start.z - .3, `forward progress: ${bot.entity.position}`)
    assert.equal(bot.entity.position.y, 64); assert.equal(ctl.aborted, false)
    assert.ok(sideResets >= 6, 'pathfinder key resets cannot erase the active dodge')
    assert.deepEqual(goals, [goal], 'no goal reset or replacement during either threat')
    t.diagnostic(`${threat}: dx=${(bot.entity.position.x - start.x).toFixed(3)}, dz=${(bot.entity.position.z - start.z).toFixed(3)}, ticks=8`)
    moved = true
  } finally {
    bot.removeListener('physicsTick', pathTick); bot.emit('end')
    assert.equal(await result, 'Disconnected')
    assert.equal(bot.listenerCount('physicTick'), 0)
    if (moved) assert.ok(Object.values(controls).every(value => !value), 'end releases the mixed controls')
  }
})

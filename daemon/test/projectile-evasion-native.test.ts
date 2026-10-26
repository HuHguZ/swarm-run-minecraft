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

const surfaces: { name: string; y: number; walking: boolean; edge?: string; rayX?: boolean; yaw?: number; handoff?: boolean; lateral?: string; at?: number }[] = [
  { name: 'stone', y: 64, walking: true },
  { name: 'smooth_sandstone_slab', y: 63.5, walking: true },
  { name: 'smooth_sandstone_slab', y: 63.5, walking: false },
  { name: 'smooth_sandstone_stairs', y: 63.5, walking: false },
  { name: 'stone', y: 64, walking: false, rayX: true },
  { name: 'smooth_sandstone_slab', y: 63.5, walking: false, rayX: true },
  ...[Math.PI, Math.PI / 2, Math.PI / 4, -Math.PI / 4].map(yaw => ({ name: 'smooth_sandstone_slab', y: 63.5, walking: false, rayX: true, yaw })),
  { name: 'smooth_sandstone_slab', y: 63.5, walking: true, rayX: true },
  { name: 'smooth_sandstone_slab', y: 63.5, walking: false, rayX: true, handoff: true },
  { name: 'smooth_sandstone_slab', y: 63.5, walking: false, rayX: true, edge: 'hole' },
  ...[Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3].flatMap((yaw, i) => ['left', 'right'].map(lateral => ({ name: 'smooth_sandstone_slab', y: 63.5, walking: false, rayX: true, yaw, lateral, at: i % 2 ? 900 : 1200 }))),
  ...[0, Math.PI / 2, Math.PI / 4, -Math.PI / 4].map(yaw => ({ name: 'smooth_sandstone_slab', y: 63.5, walking: false, rayX: true, yaw, edge: 'island' })),
  ...['hole', 'wall', 'lower', 'raised', 'unknown'].map(edge => ({ name: 'smooth_sandstone_slab', y: 63.5, walking: false, edge }))
]
for (const surface of surfaces) for (const threat of ['arrow', 'bow']) test(`native pending goto under ${threat}: ${surface.name}, ${surface.walking ? 'walking' : 'empty partial'}, ${surface.edge || 'level'}${surface.handoff ? ", handoff" : ''}${surface.lateral ? ', wanted=' + surface.lateral : ''}${surface.rayX ? ', rayX yaw=' + (surface.yaw ?? 0) : ''}`, async t => {
  let now = surface.at ?? 1200, settled = false, sideResets = 0, moved = false, active = true, walking = surface.walking
  t.mock.method(clock, 'now', () => now)
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const world = { getBlock(p: Vec3) {
    const cell = p.floored(), edge = (cell.x !== 0 || surface.edge === 'island' && cell.z !== 0) && surface.edge
    if (edge === 'unknown') return null
    const groundY = edge === 'lower' ? 62 : 63
    const ground = surface.name === 'smooth_sandstone_stairs' && cell.z !== 0 ? 'smooth_sandstone_slab' : surface.name
    const name = edge === 'hole' || edge === 'island' ? 'air' : edge === 'wall' && cell.y >= 63 && cell.y <= 65 ? 'stone' :
      cell.y === groundY ? edge === 'raised' ? 'stone' : ground : 'air'
    const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
    block.position = cell; return block
  } }
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, health: 20, food: 20,
    game: { dimension: 'overworld', minY: -64, height: 384 }, inventory: { slots: [], items: () => [] }, entities: {},
    _client: Object.assign(new EventEmitter(), { write() {} }), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { id: 1, position: new Vec3(.5, surface.y, surface.name === 'smooth_sandstone_stairs' ? .85 : .5), velocity: new Vec3(0, -.0784, 0), yaw: surface.yaw ?? 0, pitch: 0, onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, attributes: {}, effects: {}, metadata: [] },
    physics: native.Physics(registry, world), blockAt: p => world.getBlock(p),
    getControlState: key => controls[key], setControlState(key, value) { if (key === 'jump' && value && !controls.jump) this.jumpQueued = true; controls[key] = value },
    clearControlStates() { for (const key of Object.keys(controls)) this.setControlState(key, false) }
  })
  const goal = { isEnd: (p: Vec3) => p.z <= -20 }, path = surface.walking ? [{ x: .5, y: surface.y, z: -20 }] : [], goals: any[] = []
  bot.pathfinder = { goal: null, path, setGoal(value) { this.goal = value; goals.push(value); bot.emit('goal_updated', value) },
    isMoving: () => path.length > 0, isMining: () => false, isBuilding: () => false }
  const ctl = { aborted: false }, session: any = { bot, current: { name: 'goto', ctl, params: { z: -20 } } }
  const incoming = { id: 2, name: 'arrow', ticks: 8, at: { x: .5, y: 65, z: .5 }, from: surface.rayX ? { x: -8, y: 65, z: .5 } : { x: .5, y: 65, z: -8 },
    vel: surface.rayX ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }, side: surface.rayX ? { x: 0, z: 1 } : { x: 1, z: 0 }, blockable: true }
  t.mock.method(threats, 'projectileDangers', () => ({ arrows: active && threat === 'arrow' ? [incoming] : [], potions: [],
    aims: active && threat === 'bow' ? [{ id: 3, name: 'Archer', weapon: 'bow', at: incoming.from, side: incoming.side }] : [] }))
  locks.install(session)
  const run = gotoGoal(bot, goal)
  const result = run.then(() => { settled = true; return 'arrived' }, error => { settled = true; return error.name })
  // Поздний исполнитель пути продолжает писать свои клавиши; примесь проходит в настоящую интеграцию следующего тика.
  const pathTick = () => {
    bot.setControlState('forward', walking); bot.setControlState('left', surface.lateral === 'left'); bot.setControlState('right', surface.lateral === 'right')
    if (controls.left || controls.right || !walking && (controls.forward || controls.back)) sideResets++
  }
  bot.on('physicsTick', pathTick)
  pathTick()
  if (!surface.walking) bot.emit('path_update', { status: 'partial', path })
  const start = bot.entity.position.clone()
  try {
    for (let tick = 0; tick < 8; tick++) {
      bot.physics.simulatePlayer(new native.PlayerState(bot, controls), world).apply(bot)
      now += 50; bot.emit('physicsTick'); bot.emit('physicTick')
      await new Promise<void>(resolve => setImmediate(resolve))
      if (surface.lateral && tick === 0) {
        const sign = threat === 'arrow' || Math.floor(now / 300) % 2 ? 1 : -1
        const transverse = input => {
          const state = new native.PlayerState(bot, input)
          bot.physics.simulatePlayer(state, world)
          return (state.pos.z - bot.entity.position.z) * sign
        }
        const previous = Math.max(...['left', 'right'].map(key => transverse({ ...controls, forward: false, back: false, left: key === 'left', right: key === 'right' })))
        assert.ok(transverse(controls) + 1e-12 >= previous, 'combined native displacement cannot lose to the previous safe lateral option')
      }
      assert.equal(settled, false); assert.equal(bot.pathfinder.goal, goal); assert.equal(bot.pathfinder.path, path)
      assert.equal(controls.jump, false, 'evasion never adds a path-changing jump')
    }
    const edge = surface.edge
    if (edge && !(surface.rayX && edge === 'hole')) {
      assert.equal(bot.entity.position.x, start.x, `unsafe ${edge} is not an evasion`)
      assert.equal(sideResets, 0)
      if (edge === 'island') assert.equal(bot.entity.position.z, start.z, 'all four directions lack safe support')
    } else {
      assert.ok(Math.abs(surface.rayX ? bot.entity.position.z - start.z : bot.entity.position.x - start.x) > .05, `side displacement: ${bot.entity.position}`)
      assert.ok(sideResets >= 6, 'pathfinder key resets cannot erase the active dodge')
    }
    if (surface.walking) assert.ok(bot.entity.position.z < start.z - .3, `forward progress: ${bot.entity.position}`)
    else if (!surface.rayX) assert.ok(Math.abs(bot.entity.position.z - start.z) < 1e-12, 'an empty partial path contributes no forward key')
    assert.equal(bot.entity.position.y, start.y); assert.equal(ctl.aborted, false)
    assert.deepEqual(goals, [goal], 'no goal reset or replacement during either threat')
    t.diagnostic(`${threat}: dx=${(bot.entity.position.x - start.x).toFixed(3)}, dz=${(bot.entity.position.z - start.z).toFixed(3)}, ticks=8`)
    moved = true
    if (surface.handoff) {
      walking = true
      pathTick(); now += 50; bot.emit('physicsTick'); bot.emit('physicTick')
      assert.equal(controls.forward, true, 'new path intent owns its longitudinal axis on the next late tick')
      assert.equal(controls.back, false, 'old mixed back cannot oppose the new forward intent')
      bot.physics.simulatePlayer(new native.PlayerState(bot, controls), world).apply(bot)
      assert.equal(settled, false); assert.equal(bot.pathfinder.goal, goal)
    }
    active = false
    pathTick(); now += 50; bot.emit('physicTick')
    assert.equal(controls.forward, walking, 'threat end restores current path intent')
    for (const key of ['back', 'left', 'right', 'jump']) assert.equal(controls[key], key === surface.lateral, 'restore current wanted key: ' + key)
  } finally {
    bot.removeListener('physicsTick', pathTick); bot.emit('end')
    assert.equal(await result, 'Disconnected')
    assert.equal(bot.listenerCount('physicTick'), 0)
    if (moved) assert.ok(Object.values(controls).every(value => !value), 'end releases the mixed controls')
  }
})

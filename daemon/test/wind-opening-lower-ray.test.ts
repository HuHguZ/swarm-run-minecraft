import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import { Vec3 } from 'vec3'
import * as wind from '../src/combat/enemy-wind'
import { enemyWindShot, enemyWindFrames, planEnemyWind, type EnemyWindOptions } from '../src/combat/enemy-wind'
import { windImpulse } from '../src/combat/team-wind'
import { wall } from '../src/game-clock'
import { afterPacket } from '../src/mace/hands'
import { stubRequire } from './stub-require'

function fixture() {
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const blockAt = (p: Vec3) => {
    const block = Block.fromStateId(registry.blocksByName[p.y < 120 ? 'stone' : 'air'].defaultState)
    block.position = p.floored()
    return block
  }
  const foe: any = {
    id: 2, username: 'Red', type: 'player', _ndVisible: true,
    position: new Vec3(599.03, 120, 571.77), velocity: new Vec3(0, 0, 0),
    width: .6, height: 1.8, onGround: true, yaw: 3.2643, pitch: 0, metadata: [0], equipment: []
  }
  const position = new Vec3(600.5, 127.63, 588), velocity = new Vec3(-.334, .1, -1.281)
  const own = { id: 'Blue', position, velocity, launchMovement: velocity, onGround: false, gliding: true, eyeHeight: .4, gameTick: 500 }
  const bot = Object.assign(new EventEmitter(), {
    version: '1.21.11', username: own.id, registry, food: 20,
    game: { minY: -64, height: 384 }, inventory: { slots: [], items: () => [] },
    blockAt, physics: require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: blockAt }),
    entity: { id: 1, username: own.id, position, velocity, onGround: false, elytraFlying: true, yaw: 0, pitch: 0 },
    players: { Red: { entity: foe, gamemode: 0 } }, entities: { 2: foe },
    ndClock: { age: 500n, ticks: 0, serverTicks: 0 }
  })
  const arena = { x: 600.5, z: 600.5, r: 80, ellipse: { a: 77, b: 65 }, killY: 113 }
  const options: EnemyWindOptions = { arena, startTick: 500, maxShots: 1, delays: [0], reactAfterHit: true }
  return { bot, foe, own, options, arena }
}

test('a fast supported hit retains the same arrival while lowering an above-eye impact', () => {
  const { bot, foe, own, options, arena } = fixture()
  const frames = enemyWindFrames(bot, foe, arena, [], 0, true)
  const low = enemyWindShot(bot, foe, own, frames, { height: .4 })
  const high = enemyWindShot(bot, foe, own, frames, { height: 1.6 })
  assert.ok(high && (!low || low.ticks > high.ticks))
  assert.ok(windImpulse(bot, high.feet, high.burst).y < 0)
  const plan = planEnemyWind(bot, foe, [own], options)
  assert.ok(plan)
  const shot = plan.shots[0]
  assert.equal(shot.aimHeight, 1.2)
  assert.equal(shot.ticks, high.ticks)
  assert.ok(windImpulse(bot, shot.feet, shot.burst).y > 0)
  assert.ok(plan.nominal.outwardEffect! > .4)
  const recheck = enemyWindShot(bot, foe, own, frames, { height: shot.aimHeight })
  assert.deepEqual(recheck?.velocity, shot.velocity)
})

test('the optional angle does not displace a fully certified incumbent on deadline', t => {
  const { bot, foe, own, options } = fixture()
  let now = 0
  const original = bot.physics.simulatePlayer
  t.mock.method(wall, 'monotonic', () => now)
  t.mock.method(bot.physics, 'simulatePlayer', (...args) => { now++; return original(...args) })
  const ordinary = planEnemyWind(bot, foe, [own], { ...options, maxShots: undefined })
  assert.ok(ordinary)
  assert.equal(ordinary.shots[0].aimHeight, 1.6)
  const deadline = now + 2
  now = 0
  const constrained = planEnemyWind(bot, foe, [own], { ...options, deadline })
  assert.ok(constrained && now <= deadline)
  assert.deepEqual({ ...constrained, tried: ordinary.tried }, ordinary)
})

test('the normal lag-one reflex uses the lower angle in its fresh near-rim release plan', t => {
  const { bot, own, arena } = fixture()
  arena.ellipse.b = 54
  const packets: { off: boolean; yaw: number; pitch: number }[] = []
  const actualBot = Object.assign(bot, { health: 20, _client: new EventEmitter(), _ndLaunchMovement: () => own.launchMovement,
    activateItem(off: boolean) { packets.push({ off, yaw: bot.entity.yaw, pitch: bot.entity.pitch }) } })
  t.mock.method(wall, 'monotonic', () => 1000)
  t.after(() => actualBot.emit('end'))
  const plans: NonNullable<ReturnType<typeof planEnemyWind>>[] = []
  const file = resolve(__dirname, '../src/combat/wind-out.js')
  const module = { exports: {} as any }
  const req = stubRequire(file, {
    '../mace/hands': { install() {}, windReady: () => true, windCooling: () => false, offWind: () => true, hotbarIndex: () => -1, afterPacket },
    './enemy-wind-execute': { enemyWindReport: () => ({ ok: true, ready: true, report: own }) },
    './enemy-wind': { ...wind, planEnemyWind(...args: Parameters<typeof planEnemyWind>) {
      const plan = planEnemyWind(...args)
      if (plan) plans.push(plan)
      return plan
    } }
  })
  runInThisContext('(function(require,module,exports,__filename,__dirname){' + readFileSync(file, 'utf8') + '\n})', { filename: file })(
    req, module, module.exports, file, dirname(file))
  module.exports.installWindOut({ bot: actualBot, current: { name: 'wing_orbit' }, _rescue: { arena, killY: 113 } })
  actualBot.emit('physicsTick'); actualBot.emit('physicsTick')
  assert.equal(packets.length, 0)
  actualBot.emit('ndMovementSent')
  assert.deepEqual(plans.map(plan => plan.shots[0].fireDelay), [1, 0])
  assert.equal(plans[0].repriceRim, true)
  const released = plans[1].shots[0]
  assert.equal(released.aimHeight, 1.2)
  assert.deepEqual(packets, [{ off: true, yaw: released.yaw, pitch: released.pitch }])
})

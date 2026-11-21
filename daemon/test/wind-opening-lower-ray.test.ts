import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import { Vec3 } from 'vec3'
import * as wind from '../src/combat/enemy-wind'
import { enemyWindShot, enemyWindFrames, planEnemyWind, type EnemyWindOptions } from '../src/combat/enemy-wind'
import { windImpulse, type WindReport } from '../src/combat/team-wind'
import { wall } from '../src/game-clock'
import { afterPacket } from '../src/mace/hands'
import { stubRequire } from './stub-require'
import pick = require('../src/pick')

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

test('each near-rim reprice sees a new wall, missing terrain, and an ally crossing the muzzle', () => {
  const { bot, foe, own, options } = fixture()
  const forecast = (allies = [own]) => planEnemyWind(bot, foe, [own], { ...options, allies })
  const clear = forecast()
  assert.ok(clear)
  const terrain = bot.blockAt
  for (const obstruction of ['wall', 'unknown']) {
    bot.blockAt = p => {
      if (Math.floor(p.z) !== 584 || p.y < 120) return terrain(p)
      if (obstruction === 'unknown') return null
      const block = terrain(new Vec3(p.x, 119, p.z))
      block.position = p.floored()
      return block
    }
    assert.equal(forecast(), null, obstruction)
  }
  bot.blockAt = terrain
  const ally = { ...own, id: 'Escort', position: own.position.offset(-.1, -.5, -.9),
    velocity: new Vec3(0, 0, 0), launchMovement: new Vec3(0, 0, 0), gliding: false, eyeHeight: 1.62 }
  assert.equal(forecast([own, ally]), null)
  assert.deepEqual(forecast()?.shots, clear.shots)
})

test('one release prices its visible moving bodies without enumerating the same roster for every flight tick', t => {
  const { bot, foe, own, options } = fixture()
  const allies = [own] as WindReport[]
  for (let i = 0; i < 38; i++) {
    const id = 10 + i, username = 'Far' + i, position = foe.position.offset(32 + i % 12, 0, 20 + i % 8)
    const player = { ...foe, id, username, position }
    bot.entities[id] = player; bot.players[username] = { entity: player, gamemode: 0 }
    if (i % 2 === 0) allies.push({ id: username, position, velocity: new Vec3(0, 0, 0), onGround: true, gameTick: 500 })
  }
  for (let i = 0; i < 80; i++) bot.entities[100 + i] = { id: 100 + i, type: 'object', name: 'item', position: foe.position.clone() }
  let enumerations = 0, boxes = 0
  const values = Object.values, hitbox = pick.hitboxOf
  t.mock.method(Object, 'values', (table: object) => {
    if (table[foe.id] === foe) enumerations++
    return values(table)
  })
  t.mock.method(pick, 'hitboxOf', (...args: Parameters<typeof hitbox>) => {
    if (args[1].id === foe.id) boxes++
    return hitbox(...args)
  })
  const plan = () => planEnemyWind(bot, foe, [own], { ...options, allies, collision: wind.windCollisionWorld(bot), certifyRelease: true })
  const clear = plan()
  assert.equal(clear?.shots[0].aimHeight, 1.2)
  assert.equal(clear?.shots[0].ticks, 7)
  assert.ok(enumerations <= 3 && boxes < 12, `${enumerations} roster enumerations and ${boxes} target hitboxes`)
  // A new visible body can physically intercept the shot on the next release.
  bot.entities[200] = { ...foe, id: 200, username: 'Crossing', position: own.position.offset(-.1, -.5, -.9) }
  assert.equal(plan(), null)
  bot.entities[200].metadata = [0x20]
  assert.deepEqual(plan()?.shots, clear.shots, 'an invisible player with no visible equipment cannot change this aim')
  bot.entities[200].equipment = [null, null, null, null, { name: 'iron_chestplate' }]
  assert.equal(plan(), null, 'visible armour crossing the muzzle can be seen')
  delete bot.entities[200]
  assert.deepEqual(plan()?.shots, clear.shots)
})

for (const msPerRay of [0, .4, .6, 2]) test(`the near-rim release respects its native forecast budget at ${msPerRay} ms per block ray`, t => {
  const { bot, own, arena } = fixture()
  arena.ellipse.b = 54
  const packets: { off: boolean; yaw: number; pitch: number }[] = []
  const actualBot = Object.assign(bot, { health: 20, _client: new EventEmitter(), _ndLaunchMovement: () => own.launchMovement,
    activateItem(off: boolean) { packets.push({ off, yaw: bot.entity.yaw, pitch: bot.entity.pitch }) } })
  let releaseRays = 0, repricing = false
  const blockOnRay = pick.blockOnRay
  t.mock.method(pick, 'blockOnRay', (...args: Parameters<typeof blockOnRay>) => {
    if (repricing) releaseRays++
    return blockOnRay(...args)
  })
  t.mock.method(wall, 'monotonic', () => 1000 + releaseRays * msPerRay)
  t.after(() => actualBot.emit('end'))
  const plans: NonNullable<ReturnType<typeof planEnemyWind>>[] = []
  const file = resolve(__dirname, '../src/combat/wind-out.js')
  const module = { exports: {} as any }
  const req = stubRequire(file, {
    '../mace/hands': { install() {}, windReady: () => true, windCooling: () => false, offWind: () => true, hotbarIndex: () => -1, afterPacket },
    './enemy-wind-execute': { enemyWindReport: () => ({ ok: true, ready: true, report: own }) },
    './enemy-wind': { ...wind, planEnemyWind(...args: Parameters<typeof planEnemyWind>) {
      repricing = args[3].certifyRelease === true
      const plan = planEnemyWind(...args)
      repricing = false
      if (plan) plans.push(plan)
      return plan
    } }
  })
  runInThisContext('(function(require,module,exports,__filename,__dirname){' + readFileSync(file, 'utf8') + '\n})', { filename: file })(
    req, module, module.exports, file, dirname(file))
  const session: any = { bot: actualBot, current: { name: 'wing_orbit' }, _rescue: { arena, killY: 113 } }
  module.exports.installWindOut(session)
  actualBot.emit('physicsTick'); actualBot.emit('physicsTick')
  assert.equal(packets.length, 0)
  actualBot.emit('ndMovementSent')
  if (msPerRay === 2) {
    assert.equal(packets.length, 0)
    assert.equal(session._windOut.log.at(-1)?.why, 'stale_release')
    const red = bot.players.Red.entity
    const other = { ...red, id: 3, username: 'Other', position: red.position.offset(3, 0, 10) }
    bot.players[other.username] = { entity: other, gamemode: 0 }; bot.entities[other.id] = other
    bot.ndClock.ticks++; own.gameTick++
    actualBot.emit('physicsTick'); actualBot.emit('physicsTick'); actualBot.emit('ndMovementSent')
    assert.equal(packets.length, 1, 'a newly visible opponent has a safe launch in the next native frame')
    assert.deepEqual(plans.at(-1)?.targetAt, other.position)
    assert.ok(plans.at(-1)!.nominal.outwardEffect! > 0)
    return
  }
  assert.ok(releaseRays > 0 && releaseRays * msPerRay <= 50, `${releaseRays} terrain queries in a 50 ms release window`)
  assert.deepEqual(plans.map(plan => plan.shots[0].fireDelay), [1, 0])
  assert.equal(plans[0].repriceRim, true)
  const released = plans[1].shots[0]
  if (msPerRay <= .4) assert.equal(released.aimHeight, 1.2)
  assert.ok(plans[1].nominal.outwardEffect! > 0)
  assert.deepEqual(packets, [{ off: true, yaw: released.yaw, pitch: released.pitch }])
})

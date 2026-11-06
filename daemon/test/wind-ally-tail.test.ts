import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import * as hands from '../src/mace/hands'
import { installWindOut } from '../src/combat/wind-out'
import enemy = require('../src/combat/enemy-wind')
import execute = require('../src/combat/enemy-wind-execute')
import { WIND, windBlockImpact } from '../src/combat/team-wind'
import { getPhysics } from '../src/tick-plugins'

const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const arena = { x: 600, z: 600, r: 80, ellipse: { a: 77, b: 65 } }
const gameTick = 15781895

function localTailFixture(scenario: 'exposed' | 'occluded' | 'close' | 'hidden') {
  // ED #1380 release, standing k as observed, and the native stair that consumes only the centre ray.
  const muzzle = new Vec3(614.6288975101252, 122.8694684964928, 625.1301705398256)
  const long = scenario !== 'close'
  const from = long ? muzzle : new Vec3(622.5, 135.62, 560.5)
  const feet = long ? new Vec3(621.8397264006553, 134, 556.6344030120626) : new Vec3(622.5, 134, 558)
  const velocity = long ? new Vec3(.19748016480324077, .3486461123279571, -1.875866930842208) : new Vec3(0, 0, -1.5)
  const burst = long ? new Vec3(621.7765619503193, 135.48848480013706, 557.2344030359045) : feet.offset(0, 1.62, .3)
  const allyFeet = long ? new Vec3(621.725261083774, 136, 552.3000767048077) : new Vec3(622.5, 134, 555)
  const player = (id: number, username: string, position: Vec3, onGround = true) => ({
    id, username, name: 'player', type: 'player', isValid: true, position, velocity: new Vec3(0, 0, 0),
    onGround, elytraFlying: !onGround, width: .6, height: 1.8, yaw: 0, pitch: 0, effects: {}, attributes: {}, equipment: []
  })
  const own = player(393, 'Blue', from.offset(0, long ? -.4 : -1.62, 0), !long)
  const foe = player(630, 'Red', feet), ally = player(267, 'Wing', allyFeet)
  if (scenario === 'hidden') Object.defineProperty(ally, 'velocity', {get() { throw Error('hidden ally movement was read') }})
  const supports = [foe, ally, own].filter(e => e.onGround).map(e => e.position.floored().offset(0, -1, 0))
  const blockAt = (point: Vec3) => {
    const p = point.floored()
    const wall = (scenario === 'occluded' || scenario === 'hidden') && p.z === 553 && p.x >= 620 && p.x <= 624 && p.y >= 133 && p.y <= 139
    const stair = long && p.x === 622 && p.y === 135 && p.z === 554
    const support = supports.some(q => q.equals(p))
    const block = stair ? Block.fromProperties('smooth_sandstone_stairs', {facing: 'north', half: 'bottom', shape: 'straight', waterlogged: false})
      : Block.fromStateId(registry.blocksByName[wall && scenario === 'occluded' ? 'glass' : wall || support ? 'stone' : 'air'].defaultState)
    block.position = p
    return block
  }
  const uses: boolean[] = []
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', game: { minY: -64, height: 384 }, registry, food: 20, health: 20, username: own.username,
    entity: own, _ndSwarmAllies: [ally.username], entities: {267: ally, 393: own, 630: foe},
    players: Object.fromEntries([own, foe, ally].map(e => [e.username, {entity: e, gamemode: 0}])),
    ndClock: { age: BigInt(gameTick), ticks: 20, serverTicks: 20, observationRate: () => 20 },
    _client: new EventEmitter(), quickBarSlot: 0, inventory: { slots: [], items: () => [] },
    physics: getPhysics().Physics(registry, {getBlock: blockAt}), blockAt, getControlState: () => false,
    activateItem(off: boolean) { uses.push(off) }
  })
  const shot: enemy.EnemyWindShot = {thrower: own.username, fireDelay: 0, ticks: long ? 37 : 2,
    from, velocity, burst, feet, aim: feet.offset(0, 1.6, 0), aimHeight: 1.6, yaw: 0, pitch: 0}
  return {bot, foe, own, ally, shot, uses}
}

test('wind out protects a visible ally behind a plausible miss at the real local release boundary', async t => {
  for (const scenario of ['exposed', 'occluded', 'close', 'hidden'] as const) await t.test(scenario, st => {
    const {bot, foe, own, ally, shot, uses} = localTailFixture(scenario)
    st.after(() => bot.emit('end'))
    st.mock.method(clock.wall, 'monotonic', () => 0)
    st.mock.method(hands, 'windReady', () => true)
    st.mock.method(hands, 'windCooling', () => false)
    st.mock.method(hands, 'offWind', () => false)
    st.mock.method(hands, 'hotbarIndex', () => 0)
    st.mock.method(hands, 'afterPacket', (_bot, release) => release())
    st.mock.method(enemy, 'windMotionFresh', () => true)
    st.mock.method(execute, 'enemyWindReport', () => ({ok: true, ready: true, report: {
      id: own.username, position: own.position, velocity: own.velocity, onGround: own.onGround, eyeHeight: own.onGround ? 1.62 : .4, gameTick
    }}))
    const delays: number[] = []
    st.mock.method(enemy, 'planEnemyWind', (_bot, _foe, _own, opts) => {
      assert.equal(opts.allies.some(a => a.id === ally.username), scenario !== 'hidden')
      const [delay] = opts.delays
      delays.push(delay)
      const baseline = {out: false, exited: false, air: 0, progress: 0}
      return {gameTick, targetAt: foe.position, baseline, nominal: {...baseline, progress: .55}, worst: baseline,
        repriceRim: true, releaseSafeKey: enemy.windImpactKey(shot), shots: [{...shot, fireDelay: delay}]}
    })
    const session: any = {bot, current: {name: 'fly_to', ctl: {onAbort: []}}, _rescue: {arena, killY: 113}}
    installWindOut(session)
    bot.emit('physicsTick'); bot.emit('physicsTick')
    assert.deepEqual(delays, [1, 0], 'initial plan and final ordinary lag-zero release price')
    assert.deepEqual(uses, scenario === 'exposed' ? [] : [false])
    if (scenario === 'exposed') assert.equal(session._windOut.log.at(-1).why, 'ally_tail_unsafe')
  })
})

test('the real stair consumes the nominal projectile but an interior launch direction can pass it', () => {
  const {bot, shot} = localTailFixture('exposed')
  const stop = (velocity: Vec3) => {
    const length = velocity.norm()
    return windBlockImpact(bot, shot.from, velocity.scaled(1 / length), 39 * length, length)
  }
  assert.equal(stop(shot.velocity)?.block.name, 'smooth_sandstone_stairs')
  const spread = WIND.speed * WIND.dispersion * .75
  assert.equal(stop(shot.velocity.offset(-spread, spread, spread)), null)
})

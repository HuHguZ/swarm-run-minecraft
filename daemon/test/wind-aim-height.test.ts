import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
import { enemyWindShot } from '../src/combat/enemy-wind'
import { worldTick, windMovement } from '../src/combat/team-wind'
import { stubRequire } from './stub-require'

// AE d actual returned prefix, rows1389/1390: aim is from frame8, first body collision is frame7.
const recordedFeet = [
  [600.6490109694937, 135.84620204880196, 600.5075632923875],
  [600.6441743537214, 133.83399984777083, 600.5176363990623],
  [600.6144157265329, 131.78364165085472, 600.529300402872],
  [600.5619780689558, 129.69589057724357, 600.5424121230743],
  [600.488902493725, 127.57149448375809, 600.5568412651941],
  [600.3970464134294, 125.41118627009679, 600.5724692612586],
  [600.2881000735248, 123.21568417797823, 600.5891882144128],
  [600.163601597376, 120.9856920843003, 600.6068999385188],
  [600.024950677245, 120, 600.625515084191],
  [599.7719917558966, 120, 600.6549422553404],
  [599.5070896008111, 120, 600.683496879376],
  [599.2356664401053, 120, 600.7115750926873],
  [598.9606828103307, 120, 600.7393931857432],
  [598.6837551644446, 120, 600.7670692531397],
  [598.4057660857616, 120, 600.794667774526],
  [598.1271974647715, 120, 600.8222239557908],
  [597.8483124136817, 120, 600.8497570193493]
]
function nativeCase() {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const report = { id: 'NeuroFarm31d', position: new Vec3(594.4895295130705, 132.3182796207239, 597.1527907866226),
    velocity: new Vec3(-.03430733731412556, -.4431845393086478, -.04055638842296648),
    launchMovement: new Vec3(-.034307337314089636, -.4431845393086462, -.04055638842294229), onGround: false, eyeHeight: .4 }
  const bot: any = { game: { minY: -64, height: 384 }, entity: { id: 1, username: report.id, position: report.position }, entities: {}, blockAt(p: Vec3) {
    const b = Block.fromStateId(registry.blocksByName[p.y < 120 ? 'sandstone' : 'air'].defaultState); b.position = p.floored(); return b
  } }
  const frames = recordedFeet.map(p => ({ pos: new Vec3(p[0], p[1], p[2]), vel: new Vec3(0, 0, 0), onGround: p[1] === 120 }))
  return { bot, report, frames, foe: { id: 404, width: .6, height: 1.8 } }
}

test('recorded AE moving-Y recheck preserves the selected body height on an unchanged snapshot', () => {
  const f = nativeCase(), first = enemyWindShot(f.bot, f.foe, f.report, f.frames, { height: .4 })!
  assert.ok(first); assert.equal(first.ticks, 7)
  assert.equal(first.aim.y, 120.4); assert.equal(first.feet.y, 120.9856920843003)
  const face = first.feet.x - Math.fround(.6) / 2 - Math.fround((first.ticks - 2) / 20)
  const nativeBurst = first.from.plus(first.velocity.scaled((face - first.from.x) / first.velocity.x))
  assert.ok(first.burst.distanceTo(nativeBurst) < 1e-12)
  const derived = first.aim.y - first.feet.y
  assert.equal(derived, -.5856920843002911)
  const old = enemyWindShot(f.bot, f.foe, f.report, f.frames, { height: derived })!
  assert.ok(old); assert.equal(old.ticks, 8); assert.ok(Math.abs(old.pitch - first.pitch) > .0172275)
  const repeat = enemyWindShot(f.bot, f.foe, f.report, f.frames, { height: (first as any).aimHeight ?? derived })
  assert.deepEqual(repeat, first, 'same public frames and launch must not change aim, angles, burst or arrival')
})

for (const height of [0, .4, 1.6, 3]) test(`native shot retains requested height ${height} while clamping the actual body aim`, () => {
  const f = nativeCase()
  if (height === 0) f.frames = f.frames.map(at => ({ ...at, pos: f.frames[7].pos.clone() }))
  const shot = enemyWindShot(f.bot, f.foe, f.report, f.frames, { height })!
  assert.ok(shot); assert.equal((shot as any).aimHeight, height)
  assert.ok(f.frames.some(at => at.pos.offset(0, Math.min(height, 1.75), 0).equals(shot.aim)))
})

test('constant-Y native control keeps the legacy aim-minus-feet result', () => {
  const f = nativeCase(), frames = f.frames.map(at => ({ ...at, pos: f.frames[0].pos.clone() }))
  const shot = enemyWindShot(f.bot, f.foe, f.report, frames, { height: .4 })!
  assert.ok(shot)
  const legacy = enemyWindShot(f.bot, f.foe, f.report, frames, { height: shot.aim.y - shot.feet.y })!
  // Legacy subtraction may round .4 to .4000000000000057; every native shot field remains exact.
  const { aimHeight: _requested, ...native } = shot as any, { aimHeight: _derived, ...legacyNative } = legacy as any
  assert.deepEqual(legacyNative, native)
})

function callerFixture(kind: 'reflex' | 'execute', aimHeight?: number) {
  const heights: number[] = [], uses: number[] = [], foe: any = { id: 2, username: 'Red', type: 'player', position: new Vec3(4, 5, .5),
    velocity: new Vec3(.1, .2, 0), onGround: false, width: .6, height: 1.8, metadata: [], equipment: [] }
  const bot: any = Object.assign(new EventEmitter(), { username: 'Blue', health: 20, entity: { id: 1, username: 'Blue', position: new Vec3(0, 1, .5),
    velocity: new Vec3(0, 0, 0), onGround: true, attributes: {}, effects: {}, metadata: [] }, ndClock: { age: 100n, ticks: 0, serverTicks: 0,
      observationNow: () => 1000, observationRate: () => 20 }, players: { Red: { entity: foe, gamemode: 0 } }, entities: { 2: foe },
    inventory: { slots: [], items: () => [{ name: 'wind_charge', count: 4 }] }, _client: new EventEmitter(), quickBarSlot: 0,
    getControlState: () => false, blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] }), look: async () => {},
    activateItem: () => { uses.push(worldTick(bot)!); bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:wind_charge', cooldownTicks: 10 }) } })
  const shot: any = { thrower: 'Blue', fireDelay: 0, fireTick: 100, arrivalTick: 103, ticks: 3, from: bot.entity.position.offset(0, 1.62, 0),
    feet: foe.position.clone(), aim: foe.position.offset(0, -.5856920843002911, 0), burst: foe.position.offset(-.5, .4, 0),
    velocity: new Vec3(1.5, .1, 0), yaw: 0, pitch: 0, ...(aimHeight === undefined ? {} : { aimHeight }) }
  const plan: any = { target: 'Red', targetAt: foe.position.clone(), gameTick: 100, resistance: { lo: 0, hi: 0 }, shots: [shot],
    baseline: { out: false, progress: 0, air: 10 }, nominal: { out: false, exited: false, progress: 1, air: 15 }, worst: { out: false, exited: false, progress: 0 } }
  const owner = { name: 'fight', ctl: { aborted: false } }, arena = { x: 0, y: 0, z: 0, r: 80 }, session: any = { bot, current: owner, _rescue: { arena } }
  const own = () => ({ id: 'Blue', position: { ...bot.entity.position }, velocity: { ...bot.entity.velocity }, onGround: true, gameTick: worldTick(bot) })
  const file = path.resolve(__dirname, `../src/combat/${kind === 'reflex' ? 'wind-out' : 'enemy-wind-execute'}.js`), module = { exports: {} as any }
  const req = stubRequire(file, {
    '../game-clock': { now: () => 1000, wall: { monotonic: () => 0 } },
    '../mace/hands': { install: () => {}, windReady: () => true, windCooling: () => false, windCount: () => 4, offWind: () => true, hotbarIndex: () => 0,
      afterPacket: (_b, fn) => fn() },
    './team-wind': { ...require('../src/combat/team-wind'), windMovement },
    './enemy-wind-execute': { enemyWindReport: () => ({ ok: true, ready: true, report: own() }) },
    './enemy-wind': { WIND_FORECAST_TICKS: 65, installWindTracking: () => {}, windMotionFresh: () => true, windCollisionWorld: () => bot,
      planEnemyWind: (_b, _e, _r, options) => ({ ...plan, shots: [{ ...shot, fireDelay: options.delays[0] }] }),
      enemyWindFrames: () => [{}], enemyWindShot: (_b, _e, _own, _f, options) => { heights.push(options.height); return { ...shot } },
      pendingWindHit: () => null, windTeamSafe: () => true, observeOwnWindBurst: () => () => {} },
    './ally-safety': { isAlly: () => false }, '../pvp/last-seen': { seesPlayer: () => true,
      createLastSeen: () => ({ observe: e => e, visible: () => true, close: () => {} }) },
    '../reflex-lock': { owner: () => null }, '../bow/track': { observedVelocity: () => ({ x: .1, y: .2, z: 0 }) },
    '../elytra/track': { gliding: () => false }, '../edges': { worldOf: b => ({ getBlock: p => b.blockAt(p) }), afterPacket: (_b, fn) => setImmediate(fn) }
  })
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${readFileSync(file, 'utf8')}\n})`, { filename: file })(req, module, module.exports, file, path.dirname(file))
  return { bot, heights, uses, shot, owner, session, async run() {
    try {
      if (kind === 'reflex') { module.exports.installWindOut(session); bot.emit('physicsTick'); bot.emit('physicsTick') }
      else {
        const ctl = { aborted: false, onAbort: [], waitReflex: async () => {} }; let done = false
        const pending = module.exports.enemyWindExecute(session, ctl, { plan, arena }).then(r => { done = true; return r })
        for (let n = 0; n < 15 && !done; n++) { await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)); if (!done) { bot.ndClock.ticks++; bot.emit('physicsTick') } }
        assert.equal((await pending).fired, true); assert.equal(ctl.onAbort.length, 0)
      }
      assert.deepEqual(uses, [100]); assert.equal(session.current, owner)
    } finally { bot.emit('end'); bot.removeAllListeners(); bot._client.removeAllListeners() }
  } }
}

for (const kind of ['reflex', 'execute'] as const) for (const height of [.4, 0, undefined]) {
  test(`${kind} recheck uses ${height === undefined ? 'legacy aim-minus-feet' : `explicit body height ${height}`} on unchanged snapshots`, async () => {
    const f = callerFixture(kind, height), expected = height ?? f.shot.aim.y - f.shot.feet.y
    await f.run()
    assert.equal(f.heights.length, 1)
    assert.ok(f.heights.every(h => h === expected), `recheck received heights ${f.heights}, expected ${expected}`)
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { runInThisContext } from 'node:vm'
import { Vec3 } from 'vec3'
import * as wind from '../src/combat/team-wind'
import * as pick from '../src/pick'
import * as enemy from '../src/combat/enemy-wind'

const file = resolve(__dirname, '../src/combat/enemy-wind.js'), real = createRequire(file), mod = { exports: {} as any }
runInThisContext('(function(require,module,exports,__filename,__dirname){' + readFileSync(file, 'utf8') + '\nmodule.exports.__poseTest={rollout,enemyView,bodyState,segment};\n})', { filename: file })(real, mod, mod.exports, file, dirname(file))
const { rollout, enemyView, bodyState, segment } = mod.exports.__poseTest

function fixture(pose: 'standing' | 'crouching' | 'gliding', y = pose === 'gliding' ? 100 : 64, roof = false) {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const read = p => {
    const b = roof && Math.floor(p.y) === 65
      ? Block.fromProperties('stone_slab', { type: 'top', waterlogged: 'false' }, 0)
      : Block.fromStateId(registry.blocksByName[p.y < 64 ? 'stone' : 'air'].defaultState)
    b.position = p.floored(); return b
  }
  // Client entity.height can remain standing; the visible pose is authoritative.
  const metadata: any[] = [pose === 'gliding' ? 128 : 0]; metadata[6] = pose === 'gliding' ? 1 : pose === 'crouching' ? 5 : 0
  const raw: any = { id: 2, username: 'Red', name: 'player', type: 'player', isValid: true, _ndVisible: true,
    position: new Vec3(0, y, 0), velocity: new Vec3(0, 0, 0), onGround: pose !== 'gliding',
    yaw: 0, pitch: 0, width: .6, height: 1.8, metadata, equipment: [] }
  for (const key of ['health', 'hp', 'attributes', 'effects']) Object.defineProperty(raw, key, { get() { throw new Error('private foreign ' + key) } })
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, food: 20, health: 20,
    game: { minY: -64, height: 384 }, ndClock: { age: 100n, ticks: 0, serverTicks: 0 }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    blockAt: read, inventory: { slots: [], items: () => [] }, entities: { 2: raw }, players: { Red: { entity: raw, gamemode: 0 } },
    entity: { id: 1, position: new Vec3(-6, y, 0), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, effects: {}, attributes: {} } })
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: read })
  const arena = { x: 0, z: 0, r: 200, killY: 40 }
  const view = () => ({ ...enemyView(bot, raw), reactAfterHit: true, keepObservedInput: true, outward: new Vec3(1, 0, 0) })
  return { bot, raw, arena, view }
}

function hitOn(f: ReturnType<typeof fixture>, tick: number, height: number, eye: number) {
  const foe = f.view(), baseline = rollout(f.bot, foe, [], f.arena, 0), feet = baseline.frames[tick].pos
  const shot = { thrower: 'Blue', fireDelay: tick - 1, ticks: 1, from: feet.offset(-1, .4, 0), velocity: new Vec3(1.5, 0, 0) }
  const run = rollout(f.bot, foe, [shot], f.arena, 0)
  assert.equal(run.impacts.length, 1)
  const expected = wind.windImpulse(f.bot, feet, run.impacts[0].burst, { resistance: 0, height, eyeHeight: eye })
  const actual = run.frames[tick].vel.minus(baseline.frames[tick].vel)
  assert.ok(actual.distanceTo(expected) < 1e-12, `native pose ${height}/${eye}: ${JSON.stringify({ actual, expected })}`)
  return { run, baseline, expected }
}

test('a visible target pose supplies its collider and eyes without private player fields', () => {
  for (const [pose, height, eye] of [['standing', 1.8, 1.62], ['crouching', 1.5, 1.27], ['gliding', .6, .4]] as const) {
    const f = fixture(pose), view = f.view(), box = pick.hitboxOf(f.bot, f.raw)
    assert.equal(view.height, box.h); assert.equal(view.width, box.w); assert.equal(view.eyeHeight, eye)
    assert.equal(view.height, height)
  }
})

test('native fall-flying blast has horizontal direction at its .4 eye plane, not a standing upward kick', () => {
  const f = fixture('gliding'), feet = new Vec3(0, 100, 0), burst = new Vec3(-1, 100.4, 0)
  // ServerExplosion.hurtEntities uses getEyePosition; Avatar.FALL_FLYING is .6f high with .4f eyes.
  const native = wind.windImpulse(f.bot, feet, burst, { resistance: 0, height: .6, eyeHeight: .4 })
  assert.ok(Math.abs(native.x - .672508244607991) < 1e-12); assert.equal(native.y, 0)
  const old = wind.windImpulse(f.bot, feet, burst, { resistance: 0, height: .6 })
  assert.ok(Math.abs(old.x - .4263217761479279) < 1e-12); assert.ok(Math.abs(old.y - .5201125669004715) < 1e-12)
  hitOn(f, 1, .6, .4)
})

test('standing blasts and a crouching body retained under a low roof keep their native pose eyes', () => {
  hitOn(fixture('standing'), 1, 1.8, 1.62)
  hitOn(fixture('crouching', 64, true), 1, 1.5, 1.27)
})

test('a glider that has landed uses the current simulated standing pose for a later burst', () => {
  const f = fixture('gliding', 64.05), foe = f.view(), state = bodyState(f.bot, foe)
  const world = { getBlock: f.bot.blockAt }
  let tick = 0
  while (tick < 20 && (state.elytraFlying || state.ndPoseHeight !== 1.8 || !state.onGround)) { f.bot.physics.simulatePlayer(state, world); tick++ }
  assert.ok(tick > 1 && tick < 20); assert.equal(state.onGround, true); assert.equal(state.elytraFlying, false)
  hitOn(f, tick, 1.8, 1.62)
})

test('the target public fall-flying collider prevents an otherwise valid ray above its .6 body', () => {
  const f = fixture('gliding'), foe = f.view()
  const frames = Array.from({ length: 66 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const own = { id: 'Blue', position: { x: -3, y: 100, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: false, eyeHeight: 1.4 }
  // Atomic callers recheck with the fair raw body, not enemyView's normalized object.
  for (const target of [foe, f.raw]) {
    const shot = enemy.enemyWindShot(f.bot, target, own, frames, { height: 1.6 })!
    assert.ok(shot); assert.equal(shot.aimHeight, 1.6)
    assert.ok(Math.abs(shot.aim.y - 100.55) < 1e-12)
    const box = pick.hitboxOf(f.bot, f.raw), length = shot.velocity.norm(), direction = shot.velocity.scaled(1 / length)
    const hit = pick.rayBox(shot.from.plus(shot.velocity.scaled(shot.ticks - 1)), direction, box.lo, box.hi, length)
    assert.ok(hit !== null && hit > 0 && hit < length, 'selected ray must physically enter the visible .6 body')
  }
  const above = wind.windLaunch(new Vec3(-3, 101.4, 0), new Vec3(0, 101.6, 0))!
  const rawHit = segment(f.bot, f.raw, f.raw.position, new Vec3(-3, 101.4, 0), above.velocity, 2, 'Blue')
  assert.equal(rawHit.blocked, false); assert.equal(rawHit.burst, undefined, 'raw pending/collision checks cannot invent an overhead body hit')
})

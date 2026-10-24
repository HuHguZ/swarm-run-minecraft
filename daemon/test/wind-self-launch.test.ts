import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { aerialMethods } from '../src/rpc/aerial'
import * as edges from '../src/edges'
import * as hands from '../src/mace/hands'
import { windImpulse, windShot } from '../src/combat/team-wind'
import * as pick from '../src/pick'
import { descend } from '../src/mace/descend'
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()

function fixture() {
  const controls = { ...edges.IDLE }, shots: any[] = []
  let tick = 0, jumped = -1, moved = new Vec3(0, 0, 0)
  const world = { getBlock(p: Vec3) {
    const block = Block.fromStateId(registry.blocksByName[p.y < 1 ? 'stone' : 'air'].defaultState)
    block.position = p.floored(); return block
  } }
  const charge = { name: 'wind_charge', count: 64, slot: 36 }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384 }, health: 20, food: 20,
    inventory: { slots: Array(46).fill(null), items: () => [charge] }, quickBarSlot: 0, entities: {},
    _client: new EventEmitter(),
    entity: { position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      height: 1.8, width: .6, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    blockAt: (p: Vec3) => world.getBlock(p), physics: native.Physics(registry, world),
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    equip: async () => {}, look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    setQuickBarSlot: (slot: number) => { bot.quickBarSlot = slot },
    getControlState: (key: string) => controls[key], setControlState: (key: string, value: boolean) => { controls[key] = value },
    clearControlStates: () => Object.assign(controls, edges.IDLE),
    waitForTicks: async (count: number) => { for (let t = 0; t < count; t++) await new Promise(resolve => bot.once('physicsTick', resolve)) },
    activateItem: () => shots.push({ tick, jumped, position: bot.entity.position.clone(), moved: moved.clone(),
      pitch: bot.entity.pitch, yaw: bot.entity.yaw, controls: { ...controls } })
  })
  bot.inventory.slots[36] = charge
  const step = () => {
    const from = bot.entity.position.clone(), grounded = bot.entity.onGround
    const state = edges.stateOf(bot, controls); bot.physics.simulatePlayer(state, world); state.apply(bot)
    moved = bot.entity.position.minus(from); tick++
    if (grounded && !bot.entity.onGround && controls.jump) jumped = tick
    bot.emit('physicsTick')
  }
  return { bot, shots, step, world, movement: () => moved.clone() }
}

test('self wind: release on takeoff, compensate packet motion, and refuse an MLG burst after touchdown', async t => {
  const { bot, shots, step } = fixture()
  const ctl = { aborted: false, onAbort: [] }
  const session = { require: () => bot, runIntent: (_name: string, fn: any) => fn(ctl) }
  const pump = setInterval(step, 2)
  try {
    await aerialMethods({ session } as any).wind_jump({ toward: { x: .5, z: -20 } })
  } finally { clearInterval(pump) }
  assert.equal(shots.length, 1)
  assert.equal(shots[0].tick - shots[0].jumped, 0, 'the second jump tick loses lift while the charge still has to reach the floor')
  assert.equal(shots[0].controls.forward, false, 'looking behind must not run backwards before the burst')
  const up = fixture(), upPump = setInterval(up.step, 2)
  try {
    const upSession = { require: () => up.bot, runIntent: (_name: string, fn: any) => fn(ctl) }
    await aerialMethods({ session: upSession } as any).wind_jump({ up: true })
  } finally { clearInterval(upPump) }
  assert.equal(up.shots.length, 1)
  assert.equal(up.shots[0].position.y, 1, 'up releases from the floor before the jump adds upward projectile velocity')
  assert.ok(up.shots[0].controls.jump, 'takeoff starts on the next native physics tick, before the burst')
  assert.ok(Math.abs(up.shots[0].pitch + Math.PI / 2) < 1e-6, 'up aims directly at its own feet')
  const peak = (delay: number) => {
    const run = fixture()
    run.step(); run.step() // Два тика покоя: обычное устойчивое состояние onGround.
    if (delay >= 0) { run.bot.setControlState('jump', true); run.step(); run.bot.setControlState('jump', false) }
    for (let tick = 0; tick < delay; tick++) run.step()
    const shot = windShot(run.bot, pick.eyeOf(run.bot), new Vec3(.5, 1, .5), run.movement())!
    assert.ok(shot && Math.abs(shot.pitch + Math.PI / 2) < 1e-6)
    for (let tick = 0; tick < shot.ticks; tick++) {
      if (delay < 0) run.bot.setControlState('jump', tick === -delay - 1)
      run.step()
    }
    run.bot.setControlState('jump', false)
    run.bot.entity.velocity.add(windImpulse(run.bot, run.bot.entity.position, shot.burst))
    let top = run.bot.entity.position.y
    for (let tick = 0; tick < 80 && run.bot.entity.velocity.y > 0; tick++) { run.step(); top = Math.max(top, run.bot.entity.position.y) }
    return { rise: top - 1, flightTicks: shot.ticks }
  }
  const old = peak(1), early = peak(0), ground = peak(-1)
  assert.ok(ground.rise > early.rise && early.rise > old.rise, `one charge: ground ${ground.rise}, first takeoff tick ${early.rise}, second ${old.rise}`)
  t.diagnostic(JSON.stringify({ model: 'up: one charge, native physics and jar wind impulse', old, early, ground }))
  const own = hands as any
  const f = fixture()
  own.install(f.bot)
  f.bot.setControlState('jump', true); f.step(); f.bot.setControlState('jump', false)
  const shot = own.selfWindAim(f.bot, { moved: new Vec3(0, .42, 0) })
  assert.ok(shot && shot.pitch < 0)
  assert.ok(shot.impact.distanceTo(new Vec3(.5, 1, .5)) < 1e-6)
  assert.ok(Math.abs(shot.pitch + Math.PI / 2) < 1e-6, 'mineflayer down is negative pitch')
  f.bot.entity.velocity = new Vec3(.273, .3332, 0)
  const running = own.selfWindAim(f.bot, { moved: new Vec3(.3, .42, 0) })
  assert.ok(running && Math.abs(running.velocity.x) < 1e-6, 'the floor hit compensates inherited horizontal packet displacement')
  assert.ok(running.pitch > -Math.PI / 2, 'a sprinting throw needs an angle against its inherited movement')
  const blockAt = f.bot.blockAt
  f.bot.blockAt = (p: Vec3) => {
    if (p.floored().y !== 0) return blockAt(p)
    const slab = Block.fromStateId(registry.blocksByName.stone_slab.defaultState)
    slab.position = p.floored(); return slab
  }
  const slabShot = own.selfWindAim(f.bot, { moved: new Vec3(.3, .42, 0) })
  assert.ok(slabShot)
  assert.equal(slabShot.impact.y, .5, 'use the slab surface, not the containing full cube')
  assert.equal(slabShot.burst.y, .75, 'the jar offsets the burst .25 along the real hit normal')
  f.bot.blockAt = () => null
  assert.equal(own.selfWindAim(f.bot, { moved: new Vec3(0, 0, 0) }), null, 'unloaded floor cannot justify spending a charge')
  f.bot.blockAt = blockAt
  f.bot.entity.position = new Vec3(.5, 1.3, .5); f.bot.entity.velocity = new Vec3(0, -.4, 0); f.bot.entity.onGround = false
  assert.equal(own.selfWindAim(f.bot, { moved: new Vec3(0, -.4, 0) }), null, 'already hitting the floor before detonation is too late for MLG')
  f.bot.entity.position = new Vec3(.5, 3, .5); f.bot.entity.velocity = new Vec3(0, -.7, 0)
  const immediate = own.fireWind(f.bot, () => own.selfWindAim(f.bot, { moved: new Vec3(0, -.65, 0) }), { immediate: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok((await immediate).fired, 'MLG releases after this packet without waiting for another physics tick')
  const mlg = fixture(), mlgCtl = { aborted: false, onAbort: [] }
  mlg.bot.entity.position.y = 4.7; mlg.bot.entity.velocity.y = -.7; mlg.bot.entity.onGround = false
  mlg.bot._ndWind = { impactY: 10, until: Infinity }
  const falling = descend(mlg.bot, mlgCtl, { position: new Vec3(20, 1, 20), isValid: true, height: 1.8, width: .6 })
  mlg.step()
  await new Promise(resolve => setImmediate(resolve))
  mlgCtl.aborted = true; mlg.step(); await falling
  assert.equal(mlg.shots.length, 1, 'the actual mace descent uses the immediate MLG path')
  assert.equal(mlg.shots[0].tick, 1, 'descent must not schedule its rescue charge on the next physics tick')
})

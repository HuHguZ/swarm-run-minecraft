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

for (const reaction of ['open', 'early teleport', 'shield', 'shield and axe', 'shield facing away', 'new life', 'respawn before launch'] as const)
test('a real pearl ambush rechecks the arriving opponent at the mace packet: ' + reaction, async () => {
  const { bot, shots, step } = fixture()
  const clock = require('../src/game-clock'), game = clock.activate(new clock.GameClock({ manual: true }))
  game.advanceTicks(40)
  const ctl = { aborted: false }, session = { bot, require: () => bot, runIntent: (_name, fn) => fn(ctl) }
  const mace = { name: 'mace', slot: 37 }, charge = bot.inventory.slots[36]
  bot.inventory.slots[36] = null; bot.inventory.slots[45] = charge
  bot.inventory.slots[37] = mace; bot.inventory.slots[reaction === 'shield and axe' ? 38 : 14] = { name: 'iron_axe' }
  bot.heldItem = mace; bot.quickBarSlot = 1; bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  bot.entity.id = 1; bot.ndClock = { age: 1000, serverTicks: 0, ticks: 0 }
  if (reaction === 'early teleport') bot.entity.attributes['minecraft:explosion_knockback_resistance'] = { value: .4 }
  const target: any = { id: 2, username: 'Red', name: 'player', type: 'player', isValid: true, metadata: [], equipment: [],
    yaw: Math.PI / 2, height: 1.8, width: .6, position: new Vec3(12.5, 1, .5) }
  Object.defineProperty(target.metadata, 9, { get() { throw Error('private enemy health') } })
  bot.entities[2] = target; bot.players = { Red: { entity: target } }
  const at = new Vec3(1.5, 1, .5), swings: string[] = [], hitTicks: number[] = []
  bot.attack = e => {
    assert.equal(e.id, target.id)
    hitTicks.push(bot.ndClock.ticks)
    swings.push(bot.inventory.slots[36 + bot.quickBarSlot].name)
  }
  let impact = -1, queued = false, result
  const run = aerialMethods({ session } as any).pearl_ambush({ owner: 'Red', at, gameTick: 1000, eta: 50 })
    .then(r => { result = r })
  try {
    for (let t = 1; t <= 150 && !result; t++) {
      game.advanceTicks(1); bot.ndClock.ticks = t
      if (reaction === 'respawn before launch' && t === 18) bot.players.Red.entity = { ...target, id: 3 }
      if (t === (reaction === 'early teleport' ? 32 : 50)) {
        target.position.update(at)
        target._ndPositionReceipts = [null, { ...at, t: clock.observationNow(), kind: 'sync_entity_position' }]
      }
      if (t === impact) bot.entity.velocity.add(windImpulse(bot, bot.entity.position, new Vec3(.5, 1.25, .5)))
      step()
      if (bot._ndSmashNow && !queued) {
        queued = true
        if (reaction === 'new life') bot.players.Red.entity = { ...target, id: 3 }
        if (reaction.startsWith('shield')) {
          target.equipment[1] = { name: 'shield' }; target.metadata[8] = 3
          target.yaw = reaction === 'shield facing away' ? -Math.PI / 2 : Math.PI / 2
        }
      }
      bot.emit('ndMovementSent')
      if (shots.length && impact < 0) impact = t + 2
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (reaction === 'respawn before launch') {
      assert.equal(shots.length, 0, 'a known replacement cannot inherit the old life’s pearl ambush')
      assert.equal(result.ok, false)
      assert.deepEqual(swings, [])
      return
    }
    assert.equal(shots.length, 1, 'self-wind use')
    assert.ok(queued, JSON.stringify(result))
    assert.ok(bot.entity.onGround)
    const defended = reaction === 'shield' || reaction === 'new life'
    assert.deepEqual(swings, defended ? [] : reaction === 'shield and axe' ? ['iron_axe', 'mace'] : ['mace'])
    if (reaction === 'early teleport') assert.ok(hitTicks[0] < 50, JSON.stringify({ shot: shots[0].tick, impact, hitTicks }))
    assert.equal(result.hit, !defended)
    await run
  } finally { ctl.aborted = true; bot.emit('physicsTick'); game.dispose(); clock.activate(null) }
})


for (const finalSight of ['open', 'stronger', 'shield', 'hidden'] as const) test('Wind Burst uses the last airborne frame of its second smash: ' + finalSight, async () => {
  const { bot, step } = fixture()
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const game = clock.activate(new clock.GameClock({ manual: true }))
  game.advanceTicks(40)
  const mace = { name: 'mace', slot: 36, componentMap: new Map([['enchantments', { data: [{ id: 'wind_burst', level: 1 }, { id: 'density', level: 5 }] }]]) }
  bot.inventory.slots[36] = mace; bot.inventory.items = () => [mace]; bot._ndMaceHeldAt = clock.now() - 1700
  Object.assign(bot.entity, { id: 1, position: new Vec3(.5, 1.5, .5), velocity: new Vec3(0, 1.2, 0), onGround: false })
  const actor = (id: number, username: string, x: number, equipment: any[]) => {
    const metadata = []
    Object.defineProperty(metadata, 9, { get() { throw new Error('exact enemy HP') } })
    return { id, username, name: 'player', type: 'player', position: new Vec3(x, 1, .5), height: 1.8, width: .6, yaw: Math.PI / 2, isValid: true, equipment, metadata }
  }
  const first = actor(2, 'First', .55, []), prey = actor(3, 'Prey', 1.5, [])
  const stronger = actor(4, 'Strong', 1.7, [{ name: 'netherite_sword' }, null, ...['boots', 'leggings', 'chestplate', 'helmet'].map(n => ({ name: 'netherite_' + n }))])
  bot.entities = { 3: prey }
  bot.heldItem = mace
  bot.players = { Prey: { entity: prey, gamemode: 0 } }
  const sideStarts: string[] = []
  const ctl = { aborted: false }
  const arena = { x: .5, z: .5, r: 32, killY: -5 }
  require('../src/combat/wind-out').installWindOut({ bot, _rescue: { arena }, current: { name: 'fight', ctl },
    runIntent: async (name, worker) => { sideStarts.push(name); return { detail: await worker(ctl) } } })
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  const ctx: any = { bot, vision, entity: first, opts: { targets: ['Prey', 'Strong'] }, dead: new Set([2]), attackers: new Map(),
    track: { vel: () => new Vec3(0,0,0) }, foeEst: () => ({ lo: 0, hi: 20 }), kills: [], used() {}, retarget(e) { ctx.entity = e } }
  require('../src/pvp/duel-target').installMaceChain(ctx)
  const swings = []
  bot.attack = entity => swings.push({ id: entity.id, onGround: bot.entity.onGround })
  let result
  const descent = descend(bot, ctl, first, { chain: ctx.maceChain, initialHit: { at: clock.now(), target: 'First' },
    telemetryHp: () => null, windMlg: false }).then(r => { result = r })
  try {
    for (let tick = 1; tick <= 70 && !result; tick++) {
      if (tick === 29) {
        if (finalSight === 'stronger') bot.entities[stronger.id] = stronger
        if (finalSight === 'shield') { prey.equipment[1] = { name: 'shield' }; prey.metadata[8] = 3 }
        if (finalSight === 'hidden') prey.metadata[0] = 0x20
      }
      game.advanceTicks(1); step(); bot.emit('ndMovementSent'); await Promise.resolve()
    }
    await descent
    assert.ok(bot.entity.onGround)
    assert.deepEqual(sideStarts, [], 'the airborne trampoline reflex cannot take the current rebound away from the duel')
    if (finalSight === 'shield' || finalSight === 'hidden') {
      assert.deepEqual(swings, [])
      assert.equal(result.relocated, true)
    } else {
      assert.deepEqual(swings, [{ id: finalSight === 'stronger' ? 4 : 3, onGround: false }])
      assert.equal(result.hits.length, 2)
      assert.ok(result.hits[1].fall > 8 && result.hits[1].fall < 9)
    }
  } finally { ctl.aborted = true; bot.emit('physicsTick'); vision.close(); game.dispose(); clock.activate(null) }
})

for (const mode of ['unclaimed flight', 'queued behind duel', 'hidden before packet', 'handoff before packet'] as const)
test('the passive mace descent respects the current body and target: ' + mode, async () => {
  const { bot, step } = fixture()
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const game = clock.activate(new clock.GameClock({ manual: true }))
  const mace = { name: 'mace', slot: 36 }
  bot.inventory.slots[36] = mace; bot.inventory.items = () => [mace]; bot.heldItem = mace
  Object.assign(bot.entity, { id: 1, position: new Vec3(.5, 9, .5), velocity: new Vec3(0, -.2, 0), onGround: false })
  const prey = { id: 2, username: 'Prey', name: 'player', type: 'player', isValid: true, position: new Vec3(1.5, 1, .5), metadata: [], equipment: [] }
  const chosen = { ...prey, id: 3, username: 'Chosen', position: new Vec3(.5,1,1.5), metadata: [] }
  let healthReads = 0
  Object.defineProperty(prey.metadata, 9, { get() { healthReads++; return 6 } })
  bot.entities = { 2: prey, 3: chosen }; bot.players = { Prey: { entity: prey, gamemode: 0 } }
  const ctl = { aborted: false }, arena = { x:.5, z:.5, r:24, killY:-4 }, attacks: number[] = []
  let queued: () => void, passive, ordered, calls = 0, changed = false
  bot.attack = e => attacks.push(e.id)
  require('../src/combat/wind-out').installWindOut({ bot, _rescue: { arena }, current: null,
    async runIntent(_name, worker) {
      calls++
      if (mode === 'queued behind duel') await new Promise<void>(resolve => { queued = resolve })
      passive = await worker(ctl)
      return { detail: passive }
    } })
  try {
    for (let tick = 0; tick < 45; tick++) {
      game.advanceTicks(1); step()
      const staged = !!bot._ndSmashNow
      if (!changed && (mode === 'queued behind duel' && queued || mode === 'handoff before packet' && staged)) {
        changed = true
        ordered = descend(bot, ctl, chosen, { telemetryHp: () => null, windMlg: false })
        queued?.()
      }
      if (!changed && mode === 'hidden before packet' && staged) { changed = true; prey.metadata[0] = 0x20 }
      bot.emit('ndMovementSent')
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.equal(calls, 1)
    assert.deepEqual(attacks, mode === 'unclaimed flight' ? [prey.id] : mode === 'queued behind duel' ? [chosen.id] : [])
    assert.equal(!!passive.hit, mode === 'unclaimed flight')
    assert.equal(changed, mode !== 'unclaimed flight')
    assert.equal(healthReads, 0)
    assert.ok(bot.entity.onGround)
    await ordered
  } finally { ctl.aborted = true; queued?.(); bot.emit('physicsTick'); bot.emit('end'); game.dispose(); clock.activate(null) }
})

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

for (const rescue of ['wind', 'water bucket', 'disabled']) {
  test(`an empty Wind Burst chain still protects the landing: ${rescue}`, async t => {
    const { bot, step, shots } = fixture()
    const mace = { name: 'mace', componentMap: new Map([['enchantments', { data: [{ id: 'wind_burst', level: 1 }] }]]) }
    bot.inventory.items = () => [mace, bot.inventory.slots[36], ...(rescue === 'water bucket' ? [{ name: 'water_bucket' }] : [])]
    bot.entity.position.y = 10; bot.entity.velocity.y = .55; bot.entity.onGround = false
    let now = 1000
    t.mock.method(require('../src/game-clock'), 'now', () => now)
    const stats = { mlg: 0, rebounds: 0 }
    const run = descend(bot, { aborted: false }, { isValid: true, position: new Vec3(1.5, 1, .5) }, {
      chain: { choose: () => null }, initialHit: { at: now }, telemetryHp: () => null, windMlg: rescue !== 'disabled', stats
    })
    for (let tick = 0; tick < 80 && !bot.entity.onGround; tick++) {
      now += 50
      step()
      bot.emit('ndMovementSent')
      await Promise.resolve()
    }
    assert.ok(bot.entity.onGround)
    const report = await run
    assert.equal(report.hits.length, 1)
    assert.equal(stats.rebounds, 1)
    assert.equal(shots.length, rescue === 'wind' ? 1 : 0, 'release the available wind charge if a bucket cannot cover the fall')
    assert.equal(stats.mlg, shots.length)
    if (shots.length) {
      assert.ok(shots[0].position.y > 1 && shots[0].moved.y < 0)
      assert.ok(shots[0].pitch < -1.5, 'the charge was aimed at visible ground while still airborne')
    }
  })
}

for (const [shelf, first] of [['inside', 'hit'], ['outside', 'hit'], ['inside', 'gone'], ['inside', 'outpaced']] as const) test(`a wounded airborne mace uses an upper ledge ${shelf} the arena (first target ${first})`, async t => {
  const { bot, step, world } = fixture()
  const mace = { name: 'mace', componentMap: new Map([['enchantments', { data: [{ id: 'wind_burst', level: 1 }] }]]) }
  bot.inventory.items = () => [mace]
  const arena = { x: .5, z: .5, r: shelf === 'inside' ? 32 : 1.25, killY: 4 }
  const foe = { id: 22, username: 'Far', name: 'player', type: 'player', isValid: true, height: 1.8, width: .6,
    position: new Vec3(24, 12, .5), equipment: [], metadata: [] }
  bot.health = 4
  bot.entity.position.y = 10; bot.entity.velocity.y = .8; bot.entity.onGround = false
  world.getBlock = (pos: Vec3) => {
    const p = pos.floored()
    const onLedge = p.x >= 2 && p.x <= 6 && p.z >= -1 && p.z <= 1 && p.y === 11
    const b = Block.fromStateId(registry.blocksByName[onLedge ? 'stone' : 'air'].defaultState)
    b.position = p
    return b
  }
  let now = 1000, choices = 0
  t.mock.method(require('../src/game-clock'), 'now', () => now)
  const ctl = { aborted: false }
  const { chainChoice }: typeof import('../src/combat/mace-chain') = require('../src/combat/mace-chain')
  const run = descend(bot, ctl, foe, { initialHit: first === 'hit' ? { at: now } : null, windMlg: false, telemetryHp: () => null,
    chain: { arena, home: new Vec3(3.5, 12, .5), choose: (peak: number) => {
      choices++
      return chainChoice(bot, [foe], { peak, arena })
    } }
  })
  let lowest = bot.entity.position.y, peak = lowest, landedAt = 0, steered = false
  for (let tick = 0; tick < 55 && bot.entity.position.y > arena.killY; tick++) {
    if (tick === 0 && first === 'gone') foe.isValid = false
    if (tick === 0 && first === 'outpaced') foe.position.x = -24
    now += 50; step()
    lowest = Math.min(lowest, bot.entity.position.y); peak = Math.max(peak, bot.entity.position.y)
    if (!landedAt && bot.entity.onGround) landedAt = tick + 1
    if (['left', 'right', 'forward', 'back'].some(k => bot.getControlState(k))) steered = true
  }
  ctl.aborted = true; bot.emit('physicsTick')
  const report = await run
  assert.ok(choices > 0)
  assert.equal(report.hits.length, first === 'hit' ? 1 : 0)
  t.diagnostic(JSON.stringify({ shelf, peak, landedAt, end: bot.entity.position, minY: lowest }))
  assert.equal(report.relocated, shelf === 'inside')
  assert.equal(steered, shelf === 'inside')
  if (shelf === 'outside') return
  assert.ok(lowest > arena.killY, 'letting go of the controls falls through the killing plane')
  assert.ok(bot.entity.onGround)
  assert.equal(bot.entity.position.y, 12, 'the body remains on the shelf after the descent releases its inputs')
})

for (const change of ['wind_burst', 'entity_gone', 'lost_sight', 'lost_at_release', 'visible_pearl'] as const) test(`the airborne mace uses current visibility for its second target after ${change}`, async t => {
  const { bot, step } = fixture()
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const game = clock.activate(new clock.GameClock({ manual: true }))
  game.advanceTicks(20)
  const mace = { name: 'mace', slot: 36, componentMap: new Map(change === 'wind_burst' ? [['enchantments', { data: [{ id: 'wind_burst', level: 1 }] }]] : []) }
  bot.inventory.slots[36] = mace; bot.inventory.items = () => [mace]
  Object.assign(bot.entity, { id: 1, position: new Vec3(.5, 24, .5), onGround: false, velocity: new Vec3(0, .3, 0) })
  const weak = { id: 2, type: 'player', name: 'player', username: 'Weak', isValid: true, position: new Vec3(-3.5, 1, .5),
    height: 1.8, width: .6, metadata: [], equipment: [{ name: 'wooden_sword' }] }
  const strong = { ...weak, id: 3, username: 'Strong', position: new Vec3(change === 'wind_burst' ? 8 : 1.5, 1, .5),
    equipment: [{ name: 'netherite_sword' }, null, ...['boots', 'leggings', 'chestplate', 'helmet'].map(slot => ({ name: 'netherite_' + slot }))] }
  bot.entities = { 2: weak, 3: strong }
  if (change === 'visible_pearl') { weak.metadata[0] = 0x20; weak.equipment = [] }
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  const ctx: any = { bot, vision, entity: vision.observe(change === 'wind_burst' ? weak : strong), opts: { targets: ['Weak', 'Strong'] }, dead: new Set(),
    attackers: new Map(), track: { vel: () => new Vec3(0, 0, 0) }, foeEst: () => ({ lo: 0, hi: 20 }), kills: [],
    used: () => {}, retarget: entity => { ctx.entity = entity } }
  require('../src/pvp/duel-target').installMaceChain(ctx)
  const airChoices: Array<string | null> = []
  const choose = ctx.maceChain.choose
  ctx.maceChain.choose = (...args) => {
    const choice = choose(...args)
    airChoices.push(choice?.entity.username ?? null)
    return choice
  }
  const attacks = []
  bot.attack = e => attacks.push({ target: e.username, grounded: bot.entity.onGround })
  const ctl = { aborted: false }
  let report, hidAtRelease = false
  const initialHit = change === 'wind_burst' ? { at: clock.now(), target: 'First' } : null
  const run = descend(bot, ctl, ctx.entity, { initialHit,
    chain: ctx.maceChain, windMlg: false, telemetryHp: () => null }).then(out => { report = out })
  try {
    for (let tick = 0; tick < 90 && !report; tick++) {
      if (tick === 2 && change !== 'wind_burst') {
        if (change === 'entity_gone') {
          delete bot.entities[strong.id]; bot.emit('entityGone', strong)
        } else if (change === 'visible_pearl') {
          strong.position.x = 26
          assert.ok(vision.visible(strong), 'the original target is still in open sight')
        } else {
          strong.equipment = []; strong.metadata[0] = 0x20
        }
      }
      if (tick === 9 && change === 'visible_pearl') weak.metadata[0] = 0
      game.advanceTicks(1); step()
      if (change === 'lost_at_release' && bot._ndSmashNow && !hidAtRelease) {
        assert.equal(ctx.entity.id, weak.id)
        weak.equipment = []; weak.metadata[0] = 0x20
        assert.equal(vision.visible(weak), false)
        hidAtRelease = true
      }
      bot.emit('ndMovementSent'); await Promise.resolve()
    }
    assert.deepEqual(attacks, change === 'lost_at_release' ? [] : [{ target: 'Weak', grounded: false }])
    if (change === 'visible_pearl') {
      const abandoned = airChoices.indexOf(null)
      assert.ok(abandoned > 0 && airChoices[0] === 'Strong', 'the primary was physically reachable before the visible teleport')
      assert.ok(airChoices.indexOf('Weak') > abandoned, 'only the new visible opportunity interrupts relocation')
    }
    assert.ok(bot.entity.onGround)
    assert.ok(report)
    if (change === 'lost_at_release') { assert.ok(hidAtRelease); assert.deepEqual(report.hits, []); return }
    assert.deepEqual(report.hits.map(hit => hit.target), change === 'wind_burst' ? ['First', 'Weak'] : ['Weak'])
    t.diagnostic(JSON.stringify({ change, target: report.hits.at(-1).target, fall: report.hits.at(-1).fall, ms: report.ms }))
  } finally {
    ctl.aborted = true; bot.emit('physicsTick'); await run
    vision.close(); game.dispose(); clock.activate(null)
  }
})

test('a landing forecast on the rising rebound includes the remaining climb before the drop', () => {
  const { bot, step } = fixture()
  bot.entity.position.y = 10; bot.entity.velocity.y = .8; bot.entity.onGround = false
  const { landing, fallCost } = require('../src/mace/world') as typeof import('../src/mace/world')
  const forecast = landing(bot, edges.IDLE, { maxTicks: 100, observed: true })
  assert.ok(forecast?.landed)
  const initial = bot.entity.position.y
  let peak = initial
  for (let i = 0; i < 100 && !bot.entity.onGround; i++) { step(); peak = Math.max(peak, bot.entity.position.y) }
  assert.ok(bot.entity.onGround)
  assert.equal(forecast.peak, peak)
  assert.ok(fallCost(bot, forecast.at, forecast.peak) > fallCost(bot, forecast.at, initial))
})

test('windSmash measures the opponent it actually struck after losing its first target in flight', async t => {
  const { bot, shots, step } = fixture()
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const game = clock.activate(new clock.GameClock({ manual: true }))
  game.advanceTicks(20)
  bot.entity.id = 1
  bot.inventory.slots[37] = { name: 'mace', slot: 37 }
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  bot.quickBarSlot = 1
  const player = (id, x) => ({ id, type: 'player', name: 'player', username: 'Player' + id, isValid: true,
    height: 1.8, width: .6, position: new Vec3(x, 1, .5), metadata: [], equipment: [] })
  const first = player(2, 1.5), second = player(3, -.5)
  bot.entities = { 2: first, 3: second }
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  const ctx: any = { bot, vision, entity: vision.observe(first), opts: { targets: [first.username, second.username] },
    dead: new Set(), attackers: new Map(), track: { vel: () => new Vec3(0, 0, 0) }, foeEst: () => ({ lo: 0, hi: 20 }),
    kills: [], used: () => {}, retarget: entity => { ctx.entity = entity } }
  require('../src/pvp/duel-target').installMaceChain(ctx)
  let secondHp = 12, impact = -1, lost = false, report
  bot.attack = target => { assert.equal(target.id, second.id); secondHp = 4 }
  const ctl = { aborted: false }
  const run = require('../src/mace/smash').windSmash(bot, ctl, ctx.entity, { chain: ctx.maceChain, chargeTicks: 0,
    swap: true, telemetryHp: entity => entity.id === first.id ? 20 : secondHp }).then(out => { report = out })
  try {
    for (let tick = 0; tick < 100 && !report; tick++) {
      game.advanceTicks(1); step(); bot.emit('ndMovementSent')
      if (shots.length && impact < 0) impact = tick + 2
      if (tick === impact) bot.entity.velocity.add(windImpulse(bot, bot.entity.position, new Vec3(.5, 1.25, .5)))
      if (bot._ndDescend && !lost) { delete bot.entities[first.id]; bot.emit('entityGone', first); lost = true }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.ok(lost && report?.launched && report.hit, report?.note)
    await run
    assert.equal(shots.length, 1)
    assert.equal(report.hits[0].target, second.username)
    assert.equal(secondHp, 4)
    assert.equal(report.dealt, 8)
    t.diagnostic(JSON.stringify({ shotCount: shots.length, peak: report.peak, firstHit: report.hits[0].target, dealt: report.dealt }))
  } finally {
    ctl.aborted = true; bot.emit('physicsTick'); game.advanceTicks(100)
    vision.close(); game.dispose(); clock.activate(null)
  }
})

for (const floor of ['stone', 'missing', 'removed during windup', 'unsafe on miss', 'glass wall', 'upper slab', 'upper ceiling',
  'upper support removed', 'upper approach removed', 'upper hidden before launch', 'upper hidden before hit', 'upper wall before hit'] as const) test('mace duel between tiers: ' + floor, async t => {
  const { bot, shots, step, world } = fixture()
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const game = clock.activate(new clock.GameClock({ manual: true }))
  game.advanceTicks(20)
  // Feet at Y=2.5 on a lower slab above the rim, opponent at Y=1 on the tier below.
  let removed = false
  const upper = floor.startsWith('upper')
  const tier = upper ? 3.5 : floor === 'unsafe on miss' ? 0 : 1
  world.getBlock = p => {
    const { x, y } = p.floored()
    const name = upper ? (floor === 'upper ceiling' && x === 0 && y === 4 || floor === 'upper wall before hit' && removed && x === 2 && y >= 1 && y <= 14 ? 'stone' :
      x >= 3 && y === 3 && !(removed && floor === 'upper support removed') ? 'stone_slab' :
      x >= 3 && y < 3 && !(removed && floor === 'upper support removed') ? 'stone' :
      y < 1 && !(removed && floor === 'upper approach removed' && x > 0 && x < 3) ? 'stone' : 'air') :
      x <= 0 && y === 2 ? 'stone_slab' : x <= 0 && y < 2 ? 'stone' :
      x === 1 && y >= 1 && y <= 13 && floor === 'glass wall' ? 'glass' :
      y < tier && floor !== 'missing' && !removed ? 'stone' : 'air'
    const b = Block.fromStateId(registry.blocksByName[name].defaultState)
    b.position = p.floored(); return b
  }
  bot.entity.id = 1; bot.entity.position.y = upper ? 1 : 2.5
  if (floor === 'unsafe on miss') bot.entity.attributes['minecraft:safe_fall_distance'] = { value: 2 }
  step(); step()
  const mace = { name: 'mace', slot: 37 }
  bot.inventory.slots[37] = mace; bot.heldItem = mace
  bot.inventory.slots[45] = bot.inventory.slots[36]; bot.inventory.slots[36] = null
  bot.inventory.items = () => [mace]
  const foe = { id: 2, type: 'player', name: 'player', username: 'Foe', isValid: true,
    height: 1.8, width: .6, position: new Vec3(upper ? 3.25 : 3.1, tier, .5), equipment: [], metadata: [] }
  bot.entities = { 2: foe }
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  const ctl = { aborted: false }, notes: string[] = [], hitY: number[] = []
  const ctx: any = { bot, vision, entity: vision.observe(foe), opts: { targets: [foe.username] },
    prof: { player: true }, pendingLava: [], ctl, tt: { foes: new Map() }, duo: { active: () => false },
    arena: { x: 0, z: 0, r: 18, killY: -6 },
    gate: () => true, ready: () => true, rest() {}, mc: { st: null }, st: {}, clear: () => bot.clearControlStates(),
    holdWeapon: async () => {}, used: (note: string) => notes.push(note), telemetryHp: () => null,
    dead: new Set(), attackers: new Map(), kills: [], track: { vel: () => new Vec3(0, 0, 0) },
    foeEst: () => ({ lo: 0, hi: 20 }), windInputs: () => 'terrain', retarget: e => { ctx.entity = e } }
  require('../src/pvp/duel-target').installMaceChain(ctx)
  bot.attack = e => { assert.equal(e.id, foe.id); hitY.push(bot.entity.position.y) }
  pick.install(bot)
  let done = false, impact = -1, peak = bot.entity.position.y
  try {
    assert.ok(ctx.entity?._ndVisible, 'the opponent is directly visible even through the glass control')
    const turn = { hp: 20, now: clock.now(), theirR: 4, d: 2.75, dy: foe.position.y - bot.entity.position.y }
    if (upper) {
      ctx.GRAPH = true; ctx.co = require('../src/pvp/combat-observe'); ctx.fg = require('../src/pvp/fight-graph')
      ctx.calc = ctx.co.trackFoe(bot, ctx.entity, { honest: true, visible: vision.visible })
      ctx.foe = { shieldOff: () => 0 }; ctx.sky = { ON: false }; ctx.lastSwing = -10000
      await require('../src/pvp/turn-graph').fightGraphTurn(ctx, turn)
      assert.ok(ctx.gp, ctx.st.calcErr)
      ctx.gate = kind => ctx.gp.allow(kind)
    }
    const run = require('../src/pvp/turn-mace').smashTurn(ctx, turn)
      .then(() => { done = true })
    for (let tick = 0; tick < 130 && !done; tick++) {
      if (tick === 5 && floor === 'removed during windup') removed = true
      game.advanceTicks(1); step()
      if (!shots.length && bot.listenerCount('ndMovementSent') > 0) {
        if (floor === 'upper support removed' || floor === 'upper approach removed') removed = true
        if (floor === 'upper hidden before launch') foe.metadata[0] = 0x20
      }
      if (bot._ndSmashNow && floor === 'upper hidden before hit') foe.metadata[0] = 0x20
      if (bot._ndSmashNow && floor === 'upper wall before hit') removed = true
      bot.emit('ndMovementSent')
      if (shots.length && impact < 0) impact = tick + 2
      if (tick === impact) bot.entity.velocity.add(windImpulse(bot, bot.entity.position, new Vec3(.5, upper ? 1.25 : 2.75, .5)))
      peak = Math.max(peak, bot.entity.position.y)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.ok(done, notes.join(', ')); await run
    const hit = floor === 'stone' || floor === 'upper slab'
    assert.equal(shots.length, hit || floor === 'upper hidden before hit' || floor === 'upper wall before hit' ? 1 : 0, notes.join(', '))
    assert.equal(hitY.length, hit ? 1 : 0, notes.join(', '))
    assert.ok(bot.entity.onGround)
    if (floor.includes('removed') || floor === 'upper wall before hit') assert.ok(removed, 'the terrain changed after planning')
    if (floor === 'upper hidden before launch' || floor === 'upper hidden before hit') assert.equal(foe.metadata[0], 0x20)
    if (hit) {
      assert.equal(bot.entity.position.y, 1)
      assert.ok(peak - hitY[0] > 1.5)
      t.diagnostic(JSON.stringify({ peak, swingY: hitY[0], landingY: bot.entity.position.y, charges: shots.length }))
    }
  } finally { ctl.aborted = true; bot.emit('physicsTick'); game.advanceTicks(150); ctx.calc?.stop(); vision.close(); game.dispose(); clock.activate(null) }
})

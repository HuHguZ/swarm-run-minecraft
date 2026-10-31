import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { createLastSeen } from '../src/pvp/last-seen'
import bow = require('../src/bow')
import pick = require('../src/pick')

test('one body shares player observations while consumer close stays independent and idempotent', () => {
  const f = scene(), a = createLastSeen(f.bot), b = createLastSeen(f.bot)
  try {
    const av = a.observe(f.raw), bv = b.observe(f.raw)
    assert.equal(f.bot.listenerCount('physicsTick'), 1)
    assert.equal(f.raw.listenerCount('ndPositionObserved'), 1)
    assert.equal(av, bv)
    a.close(); a.close()
    assert.equal(f.bot.listenerCount('physicsTick'), 1, 'one consumer cannot close another')
    f.move(3.5)
    assert.equal(bv.position.x, 3.5)
    f.wall(true)
    assert.equal(b.visible(bv), false, 'new occlusion is still checked')
    f.wall(false)
    assert.equal(b.visible(bv), true)
    const other = scene(), c = createLastSeen(other.bot)
    try { assert.notEqual(c.observe(other.raw), bv, 'different observers never share eyesight') } finally { c.close() }
    b.close()
    assert.equal(f.bot.listenerCount('physicsTick'), 0)
    assert.equal(f.raw.listenerCount('ndPositionObserved'), 0)
    const next = createLastSeen(f.bot)
    try { assert.notEqual(next.observe(f.raw), bv, 'the last close discards old state') } finally { next.close() }
  } finally { a.close(); b.close() }
})

function scene () {
  let now = 1000
  let wall = false
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  bot.entity = { id: 1, position: new Vec3(.5, 0, .5), onGround: true }
  bot.blockAt = p => ({ name: wall && p.x === 1 ? 'stone' : 'air', position: p,
    boundingBox: wall && p.x === 1 ? 'block' : 'empty', shapes: wall && p.x === 1 ? [[0, 0, 0, 1, 1, 1]] : [] })
  const raw: any = new EventEmitter()
  Object.assign(raw, { id: 2, type: 'player', name: 'player', username: 'Foe', isValid: true,
    position: new Vec3(2.5, 0, .5), velocity: new Vec3(9, 9, 9), onGround: true,
    height: 1.8, width: .6, yaw: 0, equipment: [{ name: 'iron_sword', componentMap: new Map() }], metadata: [] })
  raw._ndObservationNow = () => now
  raw._ndPositionReceipts = [null, { x: 2.5, y: 0, z: .5, t: now, kind: 'rel_entity_move', grounded: true }]
  bot.entities = { 1: bot.entity, 2: raw }
  const move = (x, dt = 50) => {
    now += dt
    raw.position.x = x
    raw._ndPositionReceipts = [raw._ndPositionReceipts[1], { x, y: 0, z: .5, t: now, kind: 'rel_entity_move', grounded: true }]
    raw.emit('ndPositionObserved')
    bot.emit('physicsTick')
  }
  return { bot, raw, move, wall: v => { wall = v; bot.emit('physicsTick') } }
}

function socialScene (t, x = 6.5) {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const time = new clock.GameClock({ manual: true, epoch: 10000 }); clock.activate(time)
  t.mock.method(Math, 'random', () => .5)
  t.mock.method(console, 'log', () => {})
  const f = scene(); f.raw.position.x = x
  f.bot.username = 'NeuroDown'; f.bot.health = 20
  f.bot.setControlState = () => {}; f.bot.look = async () => {}; f.bot.chat = () => {}
  const looks = []
  f.bot.lookAt = async p => { looks.push(p.clone()) }
  const vision = createLastSeen(f.bot)
  const target = vision.observe(f.raw)
  const session = { bot: f.bot, current: null, tactics: { snapshot: () => ({ threatLevel: 0 }) } }
  const hm = (require('../src/showman') as typeof import('../src/showman')).create({ bot: f.bot, session, target: () => target, observe: vision.observe,
    set: () => {}, aimTo: () => {}, stopPath: () => {}, stepOk: () => true, fillerCount: () => 0 })
  return { ...f, target, hm, time, looks, close: () => { hm.close(); vision.close(); time.dispose() } }
}

for (const [event, gesture] of [['entityCrouch', 'присед'], ['entitySwingArm', 'взмах']]) test(`PvP: showman reacts to visible ${gesture}, ignoring hidden event packets`, async t => {
  const f = socialScene(t)
  try {
    f.time.advanceTicks(10)
    f.wall(true)
    f.bot.emit(event, f.raw); f.bot.emit(event, f.raw)
    const state = { d: 6, theirR: 6, hp: 20, theirHp: 20, press: true }
    await f.hm.pre(state)
    assert.equal(f.hm.report().acts[`вижу его жест: ${gesture}`], undefined)
    f.wall(false)
    f.bot.emit(event, f.raw); f.bot.emit(event, f.raw)
    await f.hm.pre(state)
    assert.equal(f.hm.report().acts[`вижу его жест: ${gesture}`], 1)
  } finally { f.close() }
})

test('PvP: showman cannot punish a hidden swing as a visible miss', t => {
  const f = socialScene(t, 4)
  try {
    const state = { r: 3.4, d: 3.5, theirR: 3.2, hp: 20, theirHp: 20, cooldownLeft: 0 }
    const keys = { forward: false, back: true, sprint: false }
    f.wall(true)
    f.bot.emit('entitySwingArm', f.raw)
    f.hm.steer(keys, state)
    assert.equal(f.hm.report().bites, 0)
    f.wall(false)
    f.bot.emit('entitySwingArm', f.raw)
    const out = f.hm.steer(keys, state)
    assert.equal(f.hm.report().bites, 1)
    assert.equal(out.forward, true)
    assert.equal(out.sprint, true)
    assert.equal(out.back, false)
  } finally { f.close() }
})

for (const visible of [false, true]) test(`PvP: showman victory looks at ${visible ? 'observed death' : 'last seen position, not hidden death coordinates'}`, async t => {
  const f = socialScene(t, 2.5)
  const ctl = { aborted: false }
  let celebration = Promise.resolve()
  t.mock.method((require('../src/reflex-lock') as typeof import('../src/reflex-lock')), 'start', (_session, run) => (celebration = run(ctl)))
  try {
    if (!visible) f.wall(true)
    f.move(12)
    const expected = f.target.position.offset(0, .3, 0)
    f.bot.emit('entityDead', f.raw)
    f.hm.victory()
    f.time.advanceTicks(10)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.looks[0], expected)
  } finally {
    ctl.aborted = true; f.time.advanceTicks(100)
    await celebration
    f.close()
  }
})

test('PvP: telemetry source survives replacement and close without keeping observation listeners', () => {
  const f = scene()
  const vision = createLastSeen(f.bot)
  const first = vision.observe(f.raw)
  const replacement = Object.assign(new EventEmitter(), { id: f.raw.id, type: 'player', position: f.raw.position.clone() })
  const second = vision.observe(replacement)
  vision.close()
  assert.strictEqual(vision.source(first), f.raw)
  assert.strictEqual(vision.source(second), replacement)
  assert.equal(f.raw.listenerCount('ndPositionObserved'), 0)
  assert.equal(replacement.listenerCount('ndPositionObserved'), 0)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('PvP: hidden packets cannot move the last seen target, change gear, or supply exact health', () => {
  const f = scene()
  f.raw.metadata[9] = 3
  f.raw.metadata[17] = 8
  const vision = createLastSeen(f.bot)
  try {
    const e = vision.observe(f.raw)
    assert.equal(e.metadata[9], undefined, 'even visible players do not expose exact HP')
    assert.equal(e.metadata[17], undefined)
    assert.equal(e.velocity.x, 0, 'raw packet velocity is not an observation')
    const followPosition = e.position
    f.move(2.7)
    assert.strictEqual(e.position, followPosition, 'nxg GoalFollow keeps this Vec3 reference')
    assert.equal(followPosition.x, 2.7, 'the same pursuit vector follows visible movement')
    const seen = e.position.clone()
    f.wall(true)
    f.raw.equipment[0].name = 'mace'
    f.raw.metadata[9] = 1
    f.raw.metadata[17] = 12
    f.raw.yaw = 2
    f.move(12)
    assert.deepEqual(e.position, seen, 'the pursuit target must remain at its last visible position')
    assert.equal(e.equipment[0].name, 'iron_sword')
    assert.equal(e.yaw, 0)
    assert.equal(e.metadata[9], undefined)
    assert.equal(e.metadata[17], undefined)
    assert.equal(vision.visible(e), false)
    assert.strictEqual(vision.observe(f.raw), e, 'GoalFollow and skills keep the same observed object')
  } finally { vision.close() }
})

test('PvP: tempo and HP estimation ignore hidden item, swing, totem, and environmental damage packets', () => {
  const f = scene()
  const vision = createLastSeen(f.bot)
  const e = vision.observe(f.raw)
  const tempo = (require('../src/tempo') as typeof import('../src/tempo')).track(f.bot, { threats: () => [vision.observe(e)] })
  const read = (require('../src/read') as typeof import('../src/read')).watch(f.bot, { threats: tempo.threats, visible: vision.visible })
  const calc = (require('../src/pvp/combat-observe') as typeof import('../src/pvp/combat-observe')).trackFoe(f.bot, e, { visible: vision.visible })
  const flags = f.bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  try {
    f.raw.equipment[0].name = 'golden_apple'
    f.raw.metadata[flags] = 1
    f.bot.emit('entityUpdate', f.raw)
    assert.ok(tempo.state(e).consuming, 'visible consumption is still observed')
    f.wall(true)
    f.bot.emit('entitySwingArm', f.raw)
    f.bot.emit('entityUpdate', f.raw)
    assert.equal(tempo.state(f.raw).consuming, undefined)
    assert.equal(tempo.state(f.raw).swung, undefined)
    for (let i = 0; i < 34; i++) f.bot.emit('physicsTick')
    f.raw.metadata[flags] = 0
    f.bot.emit('entityUpdate', f.raw)
    f.bot.emit('physicsTick')
    assert.equal(calc.seenApples, 0)
    const hp = calc.hp.snapshot()
    f.bot._client.emit('entity_status', { entityId: 2, entityStatus: 35 })
    f.bot._client.emit('damage_event', { entityId: 2, sourceCauseId: 0, sourceTypeId: 0 })
    assert.deepEqual(calc.hp.snapshot(), hp, 'unseen effects do not narrow or move the estimate')
    assert.equal(calc.pops, 0)
    assert.equal(read.poppedAgo(e), Infinity)
    calc.noteAttack({ min: 2, max: 3, mean: 2.5, raw: 4 })
    f.bot._client.emit('damage_event', { entityId: 2, sourceCauseId: 2, sourceTypeId: 0 })
    assert.ok(calc.hp.snapshot().hi < hp.hi, 'our confirmed projectile hit remains usable out of sight')
    f.wall(false)
    f.bot._client.emit('entity_status', { entityId: 2, entityStatus: 35 })
    assert.equal(calc.pops, 1)
    assert.notEqual(read.poppedAgo(e), Infinity)
  } finally { calc.stop(); read.close(); tempo.close(); vision.close() }
})

test('PvP: the two-opponent tracker cannot replace an observed target with the live player packet', () => {
  const f = scene()
  f.bot.username = 'NeuroDown'
  f.bot.players = { Foe: { entity: f.raw } }
  const vision = createLastSeen(f.bot)
  const e = vision.observe(f.raw)
  const duo = (require('../src/duo') as typeof import('../src/duo')).create(f.bot, { target: () => e, observe: vision.observe,
    attackers: new Map([[2, { e: f.raw, at: (require('../src/game-clock') as typeof import('../src/game-clock')).now() }]]) })
  try {
    f.bot._ndDuo.seen.set('Foe', (require('../src/game-clock') as typeof import('../src/game-clock')).now())
    f.wall(true)
    f.move(12)
    assert.strictEqual(duo.foes()[0], e)
    assert.equal(duo.foes()[0].position.x, 2.5)
  } finally { duo.close(); vision.close() }
})

test('PvP: only visible block cracks interrupt cover, even when the miner is hidden', () => {
  const f = scene()
  const vision = createLastSeen(f.bot)
  const e = vision.observe(f.raw)
  const tempo = (require('../src/tempo') as typeof import('../src/tempo')).track(f.bot, { threats: () => [vision.observe(e)] })
  const blockAt = f.bot.blockAt
  f.bot.blockAt = p => ({ ...blockAt(p), digTime: () => 1000 })
  try {
    f.wall(true)
    assert.equal(e._ndVisible, false)
    assert.equal(tempo.safe(1600, { fortSealed: true }).ok, true)
    const hiddenBlock = { position: new Vec3(2, 1, 0) }
    f.bot.emit('blockBreakProgressObserved', hiddenBlock, 2, f.raw)
    assert.equal(tempo.digLeftMs(e), null, 'a break packet behind the wall is not an observed animation')
    assert.equal(tempo.safe(1600, { fortSealed: true }).ok, true, 'hidden cracks cannot force us out of cover')
    const visibleWall = { position: new Vec3(1, 1, 0) }
    f.bot.emit('blockBreakProgressObserved', visibleWall, 2, f.raw)
    assert.ok(tempo.digLeftMs(e) <= 1000)
    assert.equal(tempo.safe(1600, { fortSealed: true }).ok, false, 'visible cracks still warn of the hidden miner breaking our cover')
  } finally { tempo.close(); vision.close() }
})

test('PvP: a wall within melee range hides an unknown player, and loss of sight resets velocity on reacquisition', () => {
  const f = scene()
  const vision = createLastSeen(f.bot)
  try {
    f.wall(true)
    assert.equal(vision.observe(f.raw), null, 'no initial location from a packet behind a wall')
    f.wall(false)
    const e = vision.observe(f.raw)
    const track = bow.trackTarget(e)
    f.move(2.7)
    assert.ok(track.vel().x > 0)
    f.wall(true)
    f.move(32)
    f.wall(false)
    assert.equal(e.position.x, 32)
    assert.equal(track.vel().x, 0, 'the hidden displacement is not observed running speed')
    f.move(32.2)
    assert.ok(track.vel().x > 0 && track.vel().x < 1)
  } finally { vision.close() }
  assert.equal(f.raw.listenerCount('ndPositionObserved'), 0)
})

test('PvP: sight through glass does not grant a melee hit; unavailable terrain does not reveal a player', () => {
  const f = scene()
  f.bot.blockAt = p => ({ name: p.x === 1 ? 'glass' : 'air', position: p,
    boundingBox: p.x === 1 ? 'block' : 'empty', shapes: p.x === 1 ? [[0, 0, 0, 1, 1, 1]] : [] })
  const vision = createLastSeen(f.bot)
  try {
    const e = vision.observe(f.raw)
    assert.ok(e)
    assert.equal(vision.visible(e), true)
    assert.equal(pick.canHit(f.bot, e), false)
    f.bot.blockAt = () => null
    f.move(10)
    assert.equal(e.position.x, 2.5)
    assert.equal(vision.visible(e), false)
  } finally { vision.close() }
})

test('PvP: pick never attacks the empty last seen position and retains the visible blocking wall', () => {
  const f = scene()
  const vision = createLastSeen(f.bot)
  let attacks = 0
  f.bot.attack = () => { attacks++ }
  pick.install(f.bot)
  try {
    const e = vision.observe(f.raw)
    f.bot.blockAt = p => ({ name: p.x === 5 ? 'stone' : 'air', position: p,
      boundingBox: p.x === 5 ? 'block' : 'empty', shapes: p.x === 5 ? [[0, 0, 0, 1, 1, 1]] : [] })
    f.move(12)
    assert.equal(e.position.x, 2.5)
    assert.equal(pick.canHit(f.bot, e), false, 'an unobstructed remembered location is not the current target')
    f.bot.attack(e)
    assert.equal(attacks, 0)
    f.bot.blockAt = p => ({ name: p.x === 1 ? 'stone' : 'air', position: p,
      boundingBox: p.x === 1 ? 'block' : 'empty', shapes: p.x === 1 ? [[0, 0, 0, 1, 1, 1]] : [] })
    assert.ok(pick.aim(f.bot, e)?.blocked, 'the visible wall can still be removed')
  } finally { vision.close() }
})

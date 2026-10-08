import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { runInThisContext } from 'node:vm'
const Vec3 = require('vec3')

function load (name: string, mocks: Record<string, any>, overrides: Record<string, any> = {}) {
  const file = resolve(__dirname, '../src', name + '.js')
  const real = createRequire(file)
  const mod = { exports: {} as any }
  const inject = Object.keys(overrides).map(key => `${key} = __overrides[${JSON.stringify(key)}]`).join('\n')
  runInThisContext(`(function(require,module,exports,__filename,__dirname,__overrides){${readFileSync(file, 'utf8')}\n${inject}\n})`, { filename: file })
    ((id: string) => id in mocks ? mocks[id] : real(id), mod, mod.exports, file, dirname(file), overrides)
  return mod.exports
}

function fixture () {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.health = 20
  bot.entity = { id: 1, name: 'player', type: 'player', position: new Vec3(.5, 0, .5), velocity: new Vec3(0, 0, 0), onGround: true, metadata: [], yaw: 0 }
  const foe = { id: 2, name: 'player', type: 'player', username: 'Foe', position: new Vec3(2.5, 0, .5), width: .6, height: 1.8, isValid: true, onGround: true, metadata: [], equipment: [], _ndVisible: true }
  bot.entities = { 1: bot.entity, 2: foe }
  bot.inventory = { items: () => [{ name: 'bow', count: 1 }, { name: 'arrow', count: 16 }], slots: [] }
  bot.game = { difficulty: 'normal' }
  bot.world = { raycast: () => null }
  bot.blockAt = p => ({ position: p.floored(), name: 'air', boundingBox: 'empty', shapes: [] })
  bot.look = bot.lookAt = bot.equip = async () => {}
  bot.setControlState = bot.setQuickBarSlot = bot.attack = bot.activateItem = bot.deactivateItem = () => {}
  bot.getControlState = () => false
  let now = 1000
  const timers = new Set<any>()
  const timer = (fn, ms, repeat = false) => { const t = { fn, ms, repeat, at: now + ms }; timers.add(t); return t }
  const clock = { now: () => now, setTimeout: timer, clearTimeout: t => timers.delete(t),
    setInterval: (fn, ms) => timer(fn, ms, true), clearInterval: t => timers.delete(t),
    sleep: ms => new Promise<void>(done => timer(done, ms)) }
  const step = async (ms = 50) => {
    now += ms
    bot.emit('physicsTick')
    for (const t of [...timers]) if (t.at <= now) { if (t.repeat) t.at = now + t.ms; else timers.delete(t); t.fn() }
    await new Promise<void>(done => setImmediate(done))
  }
  const finish = async promise => {
    let done = false; let value; let error
    promise.then(v => { done = true; value = v }, e => { done = true; error = e })
    for (let i = 0; !done && i < 200; i++) await step()
    assert.ok(done, 'fixture operation completed within 200 ticks')
    if (error) throw error
    return value
  }
  let hp = 28
  const telemetryHp = e => { assert.equal(e.id, foe.id); return hp }
  return { bot, foe, clock, step, finish, telemetryHp, hp: value => { hp = value } }
}

test('mace push telemetry reads the explicit accessor while its target has no HP', async () => {
  const f = fixture()
  f.bot._ndMaceInstalled = true
  const mace = load('mace', { './game-clock': f.clock, './edges': { support: (_b, p) => ({ drop: p.y }) } })
  const tracker = mace.track(f.bot, { enemy: () => f.foe, telemetryHp: f.telemetryHp })
  try {
    tracker.notePush(f.foe, 'wind')
    f.hp(22)
    await f.step()
    assert.equal(tracker.report().pushHits, 1)
    assert.equal(f.foe.metadata[9], undefined)
  } finally { tracker.close() }
})

test('mace descent keeps exact damage samples out of the observed target', async () => {
  const f = fixture()
  const mace = load('mace', { './game-clock': f.clock, './edges': { support: (_b, p) => ({ drop: p.y }) } })
  f.bot.entity.position.y = 17
  f.bot.entity.onGround = false
  const pending = mace.descend(f.bot, { aborted: false }, f.foe, { telemetryHp: f.telemetryHp, windMlg: false })
  f.bot.entity.position.y = .8
  f.bot.entity.velocity.y = -1
  await f.step()
  f.hp(13)
  await f.step()
  f.bot.entity.onGround = true
  const result: any = await f.finish(pending)
  assert.ok(result.hit, result.why)
  assert.equal(result.hit.hp0, 28)
  assert.equal(result.hit.hpMin, 13)
  assert.equal(f.foe.metadata[9], undefined)
})

test('boom reports nonzero damage through an observed target and does not invent unknown HP', async () => {
  for (const known of [true, false]) {
    const f = fixture()
    const boom = load('boom', { './game-clock': f.clock, './bow': { shoot: async () => ({ shot: true }) } })
    const b = boom.create(f.bot, { enemy: () => f.foe, telemetryHp: known ? f.telemetryHp : () => null })
    try {
      const shot = await b.run({ aborted: false }, { kind: 'shoot', ex: { name: 'end_crystal', position: f.foe.position }, j: { him: { dmg: 6 }, mine: { dmg: 0 } } })
      assert.equal(shot.ok, true)
      f.hp(22)
      await f.step(1100)
      assert.deepEqual(b.st.dealt, known ? [6] : [])
    } finally { b.close() }
  }
})

test('crystal separates damage telemetry from the HP estimate used to judge an attack', async () => {
  const f = fixture()
  const boom = { defenseOf: () => ({ armor: 0, tough: 0, epf: 0, resist: 0 }),
    blast: (_bot, _at, _power, pos) => ({ dmg: pos.x > 1 ? 8 : 1, raw: pos.x > 1 ? 8 : 1, kb: new Vec3(0, 0, 0), seen: 1 }) }
  const crystal = load('crystal', { './game-clock': f.clock, './boom': boom })
  const c = { id: 3, name: 'end_crystal', position: new Vec3(2.5, 0, .5), isValid: true }
  f.bot.entities[3] = c
  const cx = crystal.create(f.bot, { enemy: () => f.foe, foeHp: () => 9, telemetryHp: f.telemetryHp })
  try {
    assert.equal(cx.hisHp(f.foe), 9)
    const attack = await cx.run({ aborted: false }, { kind: 'hit', c, land: 8, t: { me: 1 } })
    assert.equal(attack.ok, true, attack.note)
    f.bot._client.emit('explosion', { center: c.position, radius: 6 })
    f.hp(22)
    await f.step(450)
    assert.deepEqual(cx.st.dealt, [6])
    assert.equal(cx.hisHp(f.foe), 9, 'the exact telemetry sample does not replace the estimate')
    assert.equal(f.foe.metadata[9], undefined)
  } finally { cx.close() }
  f.foe.metadata[9] = 1
  const noEstimate = crystal.create(f.bot, { enemy: () => f.foe })
  try { assert.equal(noEstimate.hisHp(f.foe), 20, 'player without an estimate uses a prior, never raw HP') } finally { noEstimate.close() }
})

test('aerial lance confirms its own event independently of exact telemetry and preserves damage samples', async () => {
  for (const confirmed of [true, false]) {
    const f = fixture()
    f.bot.entity.elytraFlying = true
    f.bot.entity.onGround = false
    f.bot.entity.position.y = 7
    f.bot.entity.velocity.z = -1.4
    const rocket = { name: 'firework_rocket', count: 8 }
    const spear = { name: 'iron_spear', count: 1 }
    f.bot.heldItem = spear
    f.bot.inventory.slots[45] = rocket
    f.bot.inventory.slots[6] = { name: 'diamond_chestplate' }
    f.bot.inventory.items = () => [rocket, spear]
    const state = { fd: 0, startedAt: 1000, driving: 0 }
    const sky = { worldOf: () => ({ floorBelow: () => null }), install: () => state,
      wearingElytra: () => true, plainRocket: it => it?.name === 'firework_rocket', gliding: e => !!e.elytraFlying,
      rocketCount: () => 8, lookVec: () => ({ x: 0, y: 0, z: -1 }),
      fly: async () => ({ why: 'разбег' }), rollout: () => ({ path: [], kind: null }),
      choose: () => ({ yaw: 0, pitch: 0 }), steer: () => {}, landingSpot: () => null,
      land: async () => { f.bot.entity.elytraFlying = false; f.bot.entity.onGround = true; return { ok: true } } }
    const mod = load('combat/aerial-lance', { '../game-clock': f.clock, '../elytra': sky })
    f.bot.activateItem = () => {
      // The same exact HP decrease only confirms a hit when the damage cause is us.
      f.clock.setTimeout(() => { f.hp(22); f.bot._client.emit('damage_event', { entityId: 2, sourceCauseId: confirmed ? 2 : 0 }) }, 50)
    }
    const stats: any = {}
    const result: any = await f.finish(mod.lance(f.bot, { aborted: false }, f.foe, { passes: 1, stats, telemetryHp: f.telemetryHp }))
    await f.step(600)
    assert.equal(result.hit, confirmed, result.note)
    assert.equal(result.total, 6)
    assert.deepEqual(stats.lanceDealt, confirmed ? [6] : undefined)
    assert.equal(f.foe.metadata[9], undefined)
  }
})

test('dive uses confirmed own damage, not a sent swing or exact HP, and removes its listener', async () => {
  for (const mode of ['own', 'other', 'blocked']) {
    const f = fixture()
    const mace = { name: 'mace', count: 1 }
    const chest = { name: 'diamond_chestplate', count: 1 }
    const rocket = { name: 'firework_rocket', count: 8 }
    f.bot.heldItem = mace
    f.bot.inventory.items = () => [mace, chest, rocket]
    f.bot.inventory.slots[45] = rocket
    f.bot.fireworkRocketDuration = 10
    f.bot.equip = async (item, hand) => { if (hand === 'off-hand') f.bot.inventory.slots[45] = item }
    f.bot.activateItem = () => { f.bot.entity.elytraFlying = false }
    const state = { fd: 10, driving: 0 }
    const sky = load('elytra', { './game-clock': f.clock,
      './pick': { ...require('../src/pick'), canHit: () => {
        if (mode === 'blocked') { f.clock.setTimeout(() => { f.bot.entity.onGround = true }, 50); return false }
        return true
      } },
      './mace': { slamHit: () => {
        f.hp(22)
        f.bot._client.emit('damage_event', { entityId: 2, sourceCauseId: mode === 'own' ? 2 : 0 })
        f.bot.entity.onGround = true
      } }
    }, {
      // Isolate flight setup; execute the actual descent, strike scheduling, and report.
      worldOf: () => ({ floorBelow: () => ({ top: 0 }) }), install: () => state,
      swapChest: async () => ({ ok: true }), chestDown: async () => ({ ok: true }),
      takeoff: async () => { f.bot.entity.onGround = false; f.bot.entity.elytraFlying = true; return { ok: true } },
      fly: async () => {
        await f.step(1900)
        f.bot.entity.position = new Vec3(2.5, 3, .5)
        f.bot.entity.velocity = new Vec3(0, -1, 0)
        return { why: 'над ним' }
      },
      choose: () => ({ yaw: 0, pitch: -1 }), steer: () => {}
    })
    const stats: any = {}
    const result: any = await f.finish(sky.diveSmash(f.bot, { aborted: false }, f.foe, { stats, telemetryHp: f.telemetryHp }))
    assert.equal(result.ok, true, result.note)
    assert.equal(result.hit, mode === 'own', result.note)
    assert.equal(stats.diveHits || 0, mode === 'own' ? 1 : 0)
    assert.deepEqual(stats.diveDealt, mode === 'own' ? [6] : undefined)
    assert.equal(f.bot._client.listenerCount('damage_event'), 0)
  }
})

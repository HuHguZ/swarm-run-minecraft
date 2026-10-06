import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const Vec3 = require('vec3')
const bow = require('../src/bow')
const ranged = require('../src/ranged')
const clock = require('../src/game-clock')

function actor() {
  const c = new clock.GameClock({ manual: true, epoch: 1000 })
  clock.activate(c)
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  const item = { name: 'bow', slot: 36 }
  bot.inventory = { items: () => [item, { name: 'arrow' }] }; bot.heldItem = item
  bot.entity = { id: 1, position: new Vec3(0, 20, 0), velocity: new Vec3(0, 0, 0), onGround: true }
  bot.registry = { entitiesByName: { player: { metadataKeys: ['living_entity_flags'] } } }
  bot.world = { raycast: () => null }; bot.blockAt = () => null
  bot.quickBarSlot = 0; bot.setQuickBarSlot = value => { bot.quickBarSlot = value }
  bot.controls = { forward: true }; bot.setControlState = (key, value) => { bot.controls[key] = value }
  bot.look = () => Promise.resolve()
  bot.lookAt = () => Promise.resolve()
  bot.equip = item => { bot.heldItem = item; return Promise.resolve() }
  let releases = 0
  bot.activateItem = () => bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 1 }] })
  bot.deactivateItem = () => { releases++ }
  c.attach(bot)
  const age = n => bot._client.emit('update_time', { age: BigInt(n) })
  age(1000)
  const target = { id: 2, position: new Vec3(6, 20, 0), height: 1.8, onGround: true }
  const frame = async () => {
    c.advanceTicks(1); bot.emit('physicsTick'); bot.emit('physicTick'); bot.emit('ndMovementSent')
    await new Promise(resolve => setImmediate(resolve))
  }
  return { c, bot, age, target, frame, releases: () => releases, close: () => { bot.emit('end'); c.dispose() } }
}

function installedActor(weapon) {
  const a = actor(); const bot = a.bot
  const data = require('minecraft-data')('1.21.11')
  const Block = require('prismarine-block')('1.21.11')
  bot.registry = data; bot.version = '1.21.11'; bot.supportFeature = data.supportFeature
  bot.game = { gameMode: 'survival', minY: -64 }; bot.isAlive = true
  bot.entity.effects = {}; bot.entity.attributes = {}; bot.entity.eyeHeight = 1.62
  bot.entities = {}; bot.getEquipmentDestSlot = () => 5
  const item = { name: weapon, slot: 36 }; bot.heldItem = item
  bot.inventory.slots = []; bot.inventory.slots[36] = item
  bot.inventory.items = () => [item, { name: 'arrow' }]
  bot.blockAt = p => { const b = Block.fromStateId(data.blocksByName.air.defaultState, 0); b.position = p.floored(); return b }
  bot.packets = []; bot._client.state = 'play'
  bot._client.write = (name, packet) => bot.packets.push({ name, ...packet })
  bot.activateItem = () => weapon === 'bow'
    ? bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags'), value: 1 }] })
    : bot._client.write('use_item', { hand: 0 })
  bot.deactivateItem = () => bot._client.write('block_dig', { status: 5 })
  require('../src/tick-plugins').createTickPlugins(a.c).plugins.physics(bot, { physicsEnabled: true })
  bot.emit('login')
  bot._client.emit('position', { x: 4103, y: 180, z: 3110, yaw: 0, pitch: 0, flags: {}, teleportId: 1 })
  bot.entity.onGround = false
  a.target.position = new Vec3(4108.834832328143, 171.41553791583252, 3120.5); a.target.onGround = false
  return { ...a, item, frame: async () => { a.c.advanceTicks(1); await new Promise(resolve => setImmediate(resolve)) } }
}

for (const weapon of ['bow', 'crossbow']) test(`installed ${weapon} final aim observes Air44 age after slow planning, before movement and use`, async t => {
  const a = installedActor(weapon)
  const read = require('../src/read')
  t.mock.method(read, 'crossbowInfo', () => ({ loaded: true, ammo: 'arrow', multishot: false, piercing: 0 }))
  const warnings: string[] = []
  t.mock.method(console, 'warn', message => { warnings.push(String(message)) })
  const target = { id: 2, position: new Vec3(4108.834832328143, 171.41553791583252, 3120.5), height: 1.8, onGround: false }
  const ageAtSolve = 2.37357421875; const ageAtRelease = 3.1597607421875
  let ageTicks = ageAtSolve
  const velFn = () => ({ x: .2486572265625, y: -1.0828051011809083, z: 0, ageTicks })
  try {
    const shooting = weapon === 'bow' ? bow.shoot(a.bot, target, { velFn, follow: false, traceAim: true })
      : ranged.fire(a.bot, target, a.item, { velFn, traceAim: true })
    await new Promise(resolve => setImmediate(resolve))
    if (weapon === 'bow') {
      a.age(1001); a.age(1021)
      for (let i = 0; i < 23; i++) await a.frame()
    }
    // Replay the elapsed observation time from Air44 without another physical
    // frame. This callback registers after the shot's final planning listener.
    a.bot.on('physicsTick', () => { ageTicks = ageAtRelease })
    a.bot.packets.length = 0
    await a.frame()
    const result = await shooting
    assert.equal(result.shot ?? result.fired, true)
    assert.equal(result.aimObservation.velocity.ageTicks, ageAtRelease, 'early physicsTick must not commit the stale Air44 snapshot')
    const expected = bow.leadTarget(target, velFn)(result.flightTicks ?? result.ticks)
    assert.ok(expected.distanceTo(new Vec3(result.aimAt.x, result.aimAt.y, result.aimAt.z)) < 1e-9)
    const names = a.bot.packets.map(p => p.name)
    const movement = names.findIndex(name => /^position(_look)?$/.test(name))
    const end = names.indexOf('tick_end'); const use = names.indexOf(weapon === 'bow' ? 'block_dig' : 'use_item')
    assert.ok(movement >= 0 && end > movement && use > end, names.join(','))
    const conv = require('mineflayer/lib/conversions')
    assert.equal(a.bot.packets[movement].yaw, Math.fround(conv.toNotchianYaw(a.bot.entity.yaw)))
    assert.equal(a.bot.packets[movement].pitch, Math.fround(conv.toNotchianPitch(a.bot.entity.pitch)))
    assert.equal(warnings.filter(message => message.includes('deprecated event (physicTick)')).length, 0, 'only our marked final aim listener skips the upstream warning')
    assert.equal(a.bot.listenerCount('physicTick'), 0)
  } finally { a.close() }
})

for (const weapon of ['bow', 'crossbow']) test(`installed ${weapon} late final aim cancels after planning without a use packet or listener`, async t => {
  const a = installedActor(weapon)
  const read = require('../src/read')
  t.mock.method(read, 'crossbowInfo', () => ({ loaded: true, ammo: 'arrow', multishot: false, piercing: 0 }))
  t.mock.method(console, 'warn', () => {}) // test-local capture; production warning remains intact
  let stopped = false
  try {
    const shooting = weapon === 'bow' ? bow.shoot(a.bot, a.target, { follow: false, shouldStop: () => stopped })
      : ranged.fire(a.bot, a.target, a.item, { shouldStop: () => stopped })
    await new Promise(resolve => setImmediate(resolve))
    if (weapon === 'bow') {
      a.age(1001); a.age(1021)
      for (let i = 0; i < 23; i++) await a.frame()
    }
    assert.equal(a.bot.listenerCount('physicTick'), 1)
    a.bot.on('physicsTick', () => {
      assert.equal(a.bot.packets.filter(p => p.name === 'block_dig' || p.name === 'use_item').length, 0, 'no early release before planning completes')
      stopped = true
    })
    a.bot.packets.length = 0
    await a.frame()
    const result = await shooting
    assert.equal(result.shot ?? result.fired, false)
    assert.equal(a.bot.packets.filter(p => p.name === 'block_dig' || p.name === 'use_item').length, 0)
    assert.equal(a.bot.listenerCount('physicTick'), 0)
  } finally { a.close() }
})

test('native cancellation clears the late bow listener without another physical frame', async () => {
  const a = actor()
  try {
    const shooting = bow.shoot(a.bot, a.target, { follow: false })
    await new Promise(resolve => setImmediate(resolve)); a.age(1001); a.age(1021)
    for (let i = 0; i < 23; i++) await a.frame()
    assert.equal(a.bot.listenerCount('physicTick'), 1)
    a.c.setState({ tick_rate: 20, is_frozen: true }); a.bot.emit('respawn')
    const result = await shooting
    assert.equal(result.shot, false)
    assert.equal(a.releases(), 0)
    assert.equal(a.bot.listenerCount('physicTick'), 0)
    assert.equal(a.bot.listenerCount('physicsTick'), 0)
  } finally { a.close() }
})

test('Air41 twenty-seven client ticks and eight native ticks cannot release a full bow', async () => {
  const a = actor()
  let drawCalls = 0
  try {
    const shooting = bow.shoot(a.bot, a.target, { follow: false, onDraw: () => { drawCalls++ } })
    await new Promise(resolve => setImmediate(resolve))
    a.age(1001) // first actual age after the native main-hand use receipt
    for (let i = 0; i < 27; i++) await a.frame()
    a.age(1008)
    assert.equal(a.releases(), 0, 'Air41 native charge8 must not be represented by the full-speed aim')
    assert.ok(drawCalls > 0)
    assert.equal(a.bot.controls.forward, true)
    a.age(1021)
    await a.frame(); await a.frame()
    const result = await shooting
    assert.equal(result.shot, true)
    assert.equal(result.fullChargeConfirmed, true)
    assert.equal(a.releases(), 1)
  } finally { a.close() }
})

test('native charge ignores pre-ACK ages, off-hand use, and client prediction', () => {
  const a = actor()
  try {
    a.bot.activateItem = () => {}
    const charge = bow.observeCharge(a.bot)
    charge.start()
    a.age(1020)
    a.bot._client.emit('entity_metadata', { entityId: 2, metadata: [{ key: 0, value: 1 }] })
    a.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 3 }] })
    assert.equal(charge.ready(0), false)
    a.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 1 }] })
    a.c.advanceTicks(100)
    assert.equal(charge.ready(), false)
    a.age(1040)
    assert.equal(charge.snapshot().confirmedTicks, 0, 'the pre-ACK twenty ticks do not count')
    a.age(1059); assert.equal(charge.ready(), false)
    a.age(1060); assert.equal(charge.ready(), true)
    charge.close()
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
    assert.equal(a.bot._client.listenerCount('update_time'), 1, 'only the original GameClock anchor listener remains')
  } finally { a.close() }
})

for (const reason of ['using-ended', 'respawn', 'slot', 'end', 'rewind']) test(`native bow charge cancels on ${reason}`, () => {
  const a = actor()
  try {
    const charge = bow.observeCharge(a.bot)
    charge.start(); a.age(1001); a.age(1021)
    assert.equal(charge.ready(), true)
    if (reason === 'using-ended') a.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 0 }] })
    if (reason === 'respawn') a.bot.emit('respawn')
    if (reason === 'slot') { a.bot.quickBarSlot = 1; a.bot.emit('heldItemChanged') }
    if (reason === 'end') a.bot.emit('end')
    if (reason === 'rewind') a.age(999)
    assert.equal(charge.ready(), false)
    assert.ok(charge.why())
    charge.cancel()
    assert.equal(a.releases(), 0)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
  } finally { a.close() }
})

test('short TNT draw acknowledges use but is never prolonged to twenty ticks', async () => {
  const a = actor()
  try {
    const shooting = bow.shoot(a.bot, a.target, { drawMs: 450, follow: false })
    for (let i = 0; i < 12; i++) await a.frame()
    const result = await shooting
    assert.equal(a.releases(), 1)
    assert.equal(result.fullChargeConfirmed, false)
    assert.equal(result.speedEstimated, true)
    assert.equal(result.nativeCharge.useConfirmed, true)
    assert.equal(result.nativeCharge.confirmedTicks, null)
  } finally { a.close() }
})

test('a short draw without native ACK cancels without extending its strength', async () => {
  const a = actor()
  a.bot.activateItem = () => {}
  try {
    const shooting = bow.shoot(a.bot, a.target, { drawMs: 450, follow: false })
    for (let i = 0; i < 12; i++) await a.frame()
    const result = await shooting
    assert.equal(result.shot, false)
    assert.equal(a.releases(), 0)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
  } finally { a.close() }
})

test('native waiting and shield holding share one existing hold budget', async () => {
  const a = actor()
  let drawCalls = 0
  try {
    const shooting = bow.shoot(a.bot, a.target, { follow: false, holdWhile: () => true, onDraw: () => { drawCalls++ } })
    await new Promise(resolve => setImmediate(resolve)); a.age(1001)
    for (let i = 0; i < 60; i++) await a.frame()
    assert.equal(a.releases(), 0)
    a.age(1021)
    for (let i = 0; i < 16; i++) await a.frame()
    const result = await shooting
    assert.equal(result.shot, true)
    assert.equal(a.releases(), 1, 'charging does not give the shield another 2500 ms budget')
    assert.ok(drawCalls > 60)
    assert.equal(a.bot.controls.forward, true)
  } finally { a.close() }
})

test('full draw timeout and disconnect cancel without arrows or observation listeners', async () => {
  for (const disconnect of [false, true]) {
    const a = actor()
    try {
      const shooting = bow.shoot(a.bot, a.target, { follow: false })
      await new Promise(resolve => setImmediate(resolve)); a.age(1001)
      if (disconnect) a.bot.emit('end')
      else for (let i = 0; i < 80; i++) await a.frame()
      const result = await shooting
      assert.equal(result.shot, false)
      assert.equal(a.releases(), 0)
      assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
      assert.equal(a.bot.listenerCount('physicsTick'), 0)
    } finally { a.close() }
  }
})

for (const phase of ['draw', 'native', 'shield', 'settle', 'snap2']) test(`paused ${phase} wait cancels without another game tick`, async () => {
  const a = actor()
  let result
  try {
    if (phase === 'settle') a.bot.entity.velocity.x = .04
    const shooting = bow.shoot(a.bot, a.target, { follow: false,
      mode: phase === 'settle' || phase === 'snap2' ? phase : 'compensate',
      ...(phase === 'shield' ? { holdWhile: () => true } : {}) })
    shooting.then(value => { result = value })
    await new Promise(resolve => setImmediate(resolve)); a.age(1001)
    if (phase !== 'draw') {
      if (phase !== 'native') a.age(1021)
      for (let i = 0; i < 24; i++) await a.frame()
    }
    assert.equal(result, undefined, 'the charge is awaiting its next game timer')
    a.c.setState({ tick_rate: 20, is_frozen: true })
    if (phase === 'native') a.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 0 }] })
    else if (phase === 'shield') { a.bot.quickBarSlot = 1; a.bot.emit('heldItemChanged') }
    else a.bot.emit('respawn')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(result?.shot, false, 'native cancellation must wake a paused charge wait')
    assert.equal(a.releases(), 0)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
    assert.equal(a.bot.listenerCount('physicsTick'), 0)
    assert.equal(a.bot.controls.forward, phase === 'settle' || phase === 'snap2' ? false : true)
  } finally { a.close() }
})

test('legacy clients without native authority cannot claim a full charge', async () => {
  const a = actor()
  try {
    delete a.bot.ndClock
    const result = await bow.shoot(a.bot, a.target, { follow: false })
    assert.equal(result.shot, false)
    assert.equal(result.fullChargeConfirmed, false)
    assert.equal(result.why, 'bow_native_authority_unavailable')
    assert.equal(a.releases(), 0)
  } finally { a.close() }
})

function shootDragon(name, a) {
  // Evaluate the actual TS function, keeping forecasts and network external.
  // No daemon JS rebuild or dragon/module setup runs during a native campaign.
  const fs = require('node:fs'); const path = require('node:path')
  const esbuild = require('esbuild')
  const file = name === 'pointBlank' ? 'crystal-shot-spot.ts' : 'station-plan.ts'
  const source = fs.readFileSync(path.join(__dirname, '../src/dragon', file), 'utf8')
  const body = source.match(new RegExp(`async function ${name}\\b[\\s\\S]*?^}`, 'm'))?.[0]
  assert.ok(body)
  const dragon = { id: 3 }
  const deps = {
    bow, gameClock: clock, sleep: (ms: number) => clock.sleep(ms), EYE: 1.62,
    findItem: (bot: any, re: RegExp) => bot.inventory.items().find(item => re.test(item.name)), countOf: () => 1,
    clearControls: () => {}, dragonOf: () => dragon, PHASE: { LANDING: 7 }, PHASE_RU: {},
    phaseOf: () => 7, hpOf: () => 20, r1: (n: number) => Math.round(n * 10) / 10,
    landingForecast: () => ({ t: clock.now(), path: Array.from({ length: 30 }, () => ({ head: new Vec3(3, 20, 0) })) }),
    pick: { blockOnRay: () => null }, runnerAim: () => {}, lookAtSafe: () => Promise.resolve(), partsOf: () => null, makeTrack: () => {}
  }
  const code = esbuild.transformSync(body, { loader: 'ts', format: 'cjs', target: 'node24' }).code
  const run = new Function('require', ...Object.keys(deps), code + `\nreturn ${name}`)(id => id === '../bow' ? bow : require(id), ...Object.values(deps))
  const ctl = { aborted: false }
  return name === 'pointBlank' ? run(a.bot, ctl, a.target.position)
    : name === 'runnerGapArrow' ? run({ bot: a.bot }, ctl, {}, {}, { minHit: 0, maxHit: Infinity, deadline: 10000 })
      : run({ bot: a.bot }, ctl, {}, {}, 0)
}

for (const name of ['pointBlank', 'runnerGapArrow', 'runnerArrow']) test(`direct dragon ${name} uses the shared native full-charge gate`, async () => {
  const a = actor()
  try {
    const shooting = shootDragon(name, a)
    await new Promise(resolve => setImmediate(resolve)); a.age(1001)
    for (let i = 0; i < 27; i++) await a.frame()
    a.age(1008)
    assert.equal(a.releases(), 0, 'direct dragon paths cannot bypass native charge using local elapsed')
    a.age(1021)
    for (let i = 0; i < 12; i++) await a.frame()
    const result = await shooting
    assert.equal(a.releases(), 1)
    assert.equal(name === 'pointBlank' ? result.fullChargeConfirmed : result.shot.fullChargeConfirmed, true)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
  } finally { a.close() }
})

for (const name of ['pointBlank', 'runnerGapArrow', 'runnerArrow']) test(`direct dragon ${name} cancels a paused draw on respawn`, async () => {
  const a = actor()
  let result
  try {
    shootDragon(name, a).then(value => { result = value })
    await new Promise(resolve => setImmediate(resolve))
    a.c.setState({ tick_rate: 20, is_frozen: true })
    a.bot.emit('respawn')
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(result, 'native cancellation must settle without a new game tick')
    assert.equal(result.shot ?? false, false)
    assert.equal(a.releases(), 0)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
    assert.equal(a.bot.listenerCount('physicsTick'), 0)
  } finally { a.close() }
})

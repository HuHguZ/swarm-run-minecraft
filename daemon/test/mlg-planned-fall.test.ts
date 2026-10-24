import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import edges = require('../src/edges')
import reflex = require('../src/reflex-lock')
import * as clock from '../src/game-clock'

// Real guard, hand/reflex wrappers and game clock. Only packet/world receipts are simulated.
function fixture () {
  const game = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot: any = new EventEmitter(); bot._client = new EventEmitter()
  bot.entity = { position: new Vec3(.5, 4, .5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0 }
  bot.health = 8; bot.game = { gameMode: 'survival', dimension: 'minecraft:overworld' }
  bot.quickBarSlot = 0; bot.inventory = new EventEmitter(); bot.inventory.slots = []
  bot.inventory.slots[36] = { name: 'iron_sword', slot: 36 }
  bot.inventory.slots[37] = { name: 'water_bucket', slot: 37 }
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  bot.heldItem = bot.inventory.slots[36]
  const packets = []; const events = []; let water = false
  bot._client.write = (name, data) => packets.push({ name, ...data })
  bot.setQuickBarSlot = slot => { bot.quickBarSlot = slot; bot.heldItem = bot.inventory.slots[36 + slot] }
  bot.equip = async () => {}
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.activateItem = () => {
    const held = bot.heldItem?.name
    bot._client.write('use_item', { held, pitch: bot.entity.pitch })
    if (held === 'water_bucket' || held === 'bucket') {
      water = held === 'water_bucket'
      bot.inventory.slots[37] = { name: water ? 'bucket' : 'water_bucket', slot: 37 }
      bot.heldItem = bot.inventory.slots[37]
    }
  }
  bot.blockAt = p => { const q = p.floored(); const name = water && q.y === 0 ? 'water' : q.y < 0 ? 'stone' : 'air'; return {
    name, position: q, boundingBox: name === 'stone' ? 'block' : 'empty', shapes: name === 'stone' ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({ level: 0 })
  } }
  const session: any = { bot }
  const oldClutch = process.env.ND_CLUTCH; process.env.ND_CLUTCH = '0'
  let guard
  try { guard = edges.installFallGuard(session) } finally { if (oldClutch == null) delete process.env.ND_CLUTCH; else process.env.ND_CLUTCH = oldClutch }
  reflex.install(session)
  bot.on('nd_mlg', e => events.push(e))
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  const tick = async (y, vy, grounded = false) => {
    bot.entity.position.y = y; bot.entity.velocity.y = vy; bot.entity.onGround = grounded
    game.advanceTicks(1); bot.emit('physicsTick'); bot.emit('ndMovementSent'); await flush()
  }
  const fall = async (height = 4) => { await tick(height - .1, -.3); await tick(2.2, -.8) }
  const land = async () => { await tick(0, 0, true); for (let i = 0; i < 6; i++) await tick(0, 0, true) }
  return { bot, guard, session, game, packets, events, tick, fall, land, close: () => game.dispose() }
}

test('a planned four-to-eight-block fall reuses actual water use; the ordinary four-block threshold stays unchanged', async () => {
  const ordinary = fixture()
  try { await ordinary.fall(); assert.equal(ordinary.guard.fired, 0) } finally { ordinary.close() }
  for (const height of [4, 5, 6, 8]) {
    const f = fixture()
    try {
      f.guard.planWater?.({ owner: 'perch', until: f.game.now() + 3000 })
      assert.equal(f.bot.quickBarSlot, 0); assert.equal(f.packets.length, 0, 'planning does not seize aim or hand')
      await f.fall(height)
      assert.equal(f.guard.fired, 1, `planned ${height}-block fall reaches existing placement`)
      assert.deepEqual(f.packets.map(p => [p.name, p.held, p.pitch]), [['use_item', 'water_bucket', -Math.PI / 2]])
    } finally { f.close() }
  }
})

test('ground release and game-clock expiry remove only their own planned fall', async () => {
  for (const how of ['release', 'expiry', 'replacement']) {
    const f = fixture()
    try {
      const release = f.guard.planWater({ owner: 'perch', until: f.game.now() + 250 })
      assert.equal(typeof release, 'function')
      if (how === 'expiry') f.game.advanceTicks(5)
      else {
        if (how === 'replacement') f.guard.planWater({ owner: 'next-perch', until: f.game.now() + 3000 })
        release()
      }
      await f.fall()
      assert.equal(f.guard.fired, how === 'replacement' ? 1 : 0)
    } finally { f.close() }
  }
})

test('release in the air preserves that fall, then native-style pickup completes and the next fall is ordinary', async () => {
  const f = fixture()
  try {
    const release = f.guard.planWater({ owner: 'perch', until: f.game.now() + 3000 })
    await f.tick(3.9, -.3); release()
    await f.tick(2.2, -.8)
    assert.equal(f.guard.fired, 1, 'abort does not remove water safety during the committed fall')
    await f.land()
    assert.equal(f.guard.picked, 1); assert.equal(f.guard.placed, null)
    assert.equal(f.guard.saved, 1, 'early pickup keeps the pending 300 ms damage receipt alive')
    assert.equal(f.bot.inventory.slots[37].name, 'water_bucket'); assert.equal(f.bot.health, 8)
    assert.deepEqual(f.packets.map(p => p.held), ['water_bucket', 'bucket'])
    await f.fall()
    assert.equal(f.guard.fired, 1, 'released intent cannot leak into a later fall')
  } finally { f.close() }
})

test('planned-water readiness reports physical inventory/settle constraints without the six-block price gate', () => {
  const f = fixture()
  const oldMlg = process.env.ND_MLG
  try {
    delete process.env.ND_MLG
    f.bot.health = 4
    assert.equal(f.guard.waterReady().ok, true, 'own HP belongs in caller price, not bucket readiness')
    f.bot.inventory.slots[10] = f.bot.inventory.slots[37]; f.bot.inventory.slots[37] = null
    assert.equal(f.guard.waterReady().toBar, true)
    assert.equal(f.guard.planWater({ owner: 'unready', until: f.game.now() + 1000 }), null)
    f.bot.inventory.slots[37] = { name: 'water_bucket', slot: 37 }; f.bot.inventory.slots[10] = null
    f.bot.inventory.emit('updateSlot', 37, null, f.bot.inventory.slots[37])
    assert.equal(f.guard.waterReady().ok, false); assert.ok(f.guard.waterReady().retryMs > 0)
    f.game.advanceTicks(6); assert.equal(f.guard.waterReady().ok, true)
    f.bot.game.dimension = 'minecraft:the_nether'; assert.equal(f.guard.waterReady().ok, false)
    f.bot.game.dimension = 'minecraft:overworld'; f.bot.game.gameMode = 'creative'; assert.equal(f.guard.waterReady().ok, false)
    f.bot.game.gameMode = 'survival'; process.env.ND_MLG = '0'; assert.equal(f.guard.waterReady().ok, false)
    delete process.env.ND_MLG; f.session.mlgOff = true; assert.equal(f.guard.waterReady().ok, false)
    f.session.mlgOff = false; assert.equal(f.guard.planWater({ owner: 'expired', until: f.game.now() }), null)
  } finally { if (oldMlg == null) delete process.env.ND_MLG; else process.env.ND_MLG = oldMlg; f.close() }
})

test('a quick pickup waits for the existing damage receipt before reporting saved or missed', async () => {
  const f = fixture()
  try {
    f.guard.planWater({ owner: 'perch', until: f.game.now() + 3000 })
    await f.fall(); await f.tick(0, 0, true)
    for (let i = 0; i < 4; i++) await f.tick(0, 0, true)
    assert.equal(f.bot.inventory.slots[37].name, 'water_bucket', 'pickup packet completed before the damage receipt')
    assert.equal(f.guard.saved, 0)
    f.bot.health = 6
    for (let i = 0; i < 2; i++) await f.tick(0, 0, true)
    assert.equal(f.guard.saved, 0); assert.equal(f.guard.missed, 1); assert.equal(f.guard.picked, 1)
    assert.equal(f.guard.placed, null)
  } finally { f.close() }
})

test('план паутины переживает отмену в воздухе, ставит по видимой грани в Аду и прекращается после посадки', async () => {
  for (const how of ['air', 'ground', 'blocked', 'late']) {
    const f = fixture()
    const oldClutch = process.env.ND_CLUTCH
    try {
      delete process.env.ND_CLUTCH
      f.bot.game.dimension = 'minecraft:the_nether'
      f.bot.inventory.slots[37] = { name: 'cobweb', slot: 37, count: 2 }
      f.bot._genericPlace = (ref, face, opts) => {
        assert.equal(f.bot.heldItem?.name, 'cobweb')
        assert.deepEqual([ref.position.y, face.y, opts.delta.y], [-1, 1, 1])
        f.bot._client.write('block_place', { held: f.bot.heldItem.name })
      }
      assert.equal(f.guard.webReady().ok, true)
      assert.equal(f.guard.waterReady().ok, false)
      const release = f.guard.planWater({ owner: 'drop', until: f.game.now() + 3000, material: 'cobweb' })
      assert.equal(typeof release, 'function')
      f.bot._ndParkourForecast = { intentional: true }
      if (how === 'ground') release()
      else {
        await f.tick(3.9, -.3); release()
        if (how === 'blocked') f.bot.entities = { obstacle: { name: 'player', position: new Vec3(.5, 0, .5), height: 1.8, width: 2 } }
        if (how === 'late') {
          const before = f.bot.look
          f.bot.look = (yaw, pitch) => { f.bot.inventory.slots[37] = null; return before(yaw, pitch) }
        }
      }
      await f.tick(2.2, -.8)
      const placements = f.packets.filter(p => p.name === 'block_place')
      assert.equal(placements.length, how === 'air' ? 1 : 0, how)
      if (how === 'air') {
        assert.deepEqual(f.packets.map(p => p.name), ['look', 'block_place'])
        await f.land(); assert.equal(f.guard.missed, 1, 'неподтверждённая паутина не считается спасением')
        await f.fall(); assert.equal(f.packets.filter(p => p.name === 'block_place').length, 1)
      }
    } finally { if (oldClutch == null) delete process.env.ND_CLUTCH; else process.env.ND_CLUTCH = oldClutch; f.close() }
  }
})

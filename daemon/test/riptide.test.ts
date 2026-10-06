import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { verticalLift } from '../src/navigation/geometry'
import { riptideImpulse, planRiptide, planRiptideTo, runRiptide } from '../src/navigation/riptide'
import { IDLE } from '../src/navigation/parkour'
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()

function model(terrain: (p: Vec3) => [string, Record<string, unknown>?]) {
  const world = { getBlock(p: Vec3) {
    p = p.floored(); const [name, properties] = terrain(p)
    const block = properties ? Block.fromProperties(name, properties, 40) : Block.fromStateId(registry.blocksByName[name].defaultState, 40)
    block.position = p; return block
  } }
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter(); bot.version = '1.21.11'; bot.registry = registry
  bot.entity = { id: 7, position: new Vec3(.5, 1, .5), velocity: new Vec3(0, -.0784000015258789, 0), onGround: true,
    isInWater: false, isInLava: false, isInWeb: false, yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} }
  bot.health = 20; bot.food = 20; bot.inventory = { slots: [], items: () => [] }
  bot.physics = native.Physics(registry, world); bot.blockAt = (p: Vec3) => world.getBlock(p)
  bot.jumpTicks = 0; bot.jumpQueued = false; bot.fireworkRocketDuration = 0
  bot.controlState = { ...IDLE }; bot.quickBarSlot = 0
  bot.clearControlStates = () => { bot.controlState = { ...IDLE } }
  bot.getControlState = (key: string) => bot.controlState[key]
  bot.setControlState = (key: string, value: boolean) => { bot.controlState[key] = value }
  bot.look = async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.equip = async (item: unknown) => { bot.heldItem = item }
  bot.activateItem = () => {
    bot.activated = true
    const index = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
    bot._client.emit('entity_metadata', { entityId: bot.entity.id, metadata: [{ key: index, value: 1 }] })
  }
  bot.deactivateItem = () => { bot.released = true }
  bot.setQuickBarSlot = (slot: number) => { bot.quickBarSlot = slot; bot.activated = false }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, bot.controlState); bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
    }
  }
  return bot
}

test('riptide impulse and ground lift use vanilla strength and whole-body state collision', () => {
  for (const [level, strength] of [[1, 1.5], [2, 2.25], [3, 3]]) assert.ok(Math.abs(riptideImpulse(level, -.7, .4)!.norm() - strength) < 2e-6)
  assert.equal(riptideImpulse(4, 0, 0), null)
  const full = model(p => p.y === 3 ? ['stone'] : ['air'])
  assert.ok(Math.abs(verticalLift(full, full.entity.position, 1.2)! - .2) < 1e-6)
  const slab = model(p => p.y === 3 ? ['oak_slab', { type: 'top', waterlogged: false }] : ['air'])
  assert.ok(Math.abs(verticalLift(slab, slab.entity.position, 1.2)! - .7) < 1e-6)
  const partial = model(p => p.x === 1 && p.y === 3 ? ['stone'] : ['air'])
  assert.equal(verticalLift(partial, partial.entity.position, 1.2), 1.2)
  partial.entity.position.x = .8
  assert.ok(Math.abs(verticalLift(partial, partial.entity.position, 1.2)! - .2) < 1e-6, 'an adjacent ceiling clips the body edge too')
})

test('riptide forecast refuses a damaging high launch and never mutates actual motion', () => {
  const bot = model(p => p.y < 1 ? ['stone'] : ['air'])
  const position = bot.entity.position.clone(); const velocity = bot.entity.velocity.clone()
  const horizontal = planRiptide(bot, 3, -Math.PI / 2, 0)
  assert.ok(horizontal); assert.ok(horizontal.states.at(-1).onGround)
  const precise = planRiptide(bot, 3, -Math.PI / 2, 0, new Vec3(18.5, 1, .5))
  assert.ok(precise, 'earned speed can settle on the same safe landing plane before centering')
  assert.ok(precise.states.at(-1)!.pos.distanceTo(new Vec3(18.5, 1, .5)) < .25)
  assert.equal(planRiptide(bot, 3, -Math.PI / 2, Math.PI / 2), null, 'falling back onto an ordinary floor from the high launch would hurt')
  assert.deepEqual(bot.entity.position, position); assert.deepEqual(bot.entity.velocity, velocity)
})

test('targeted Riptide chooses a safe native pitch after the actual charge without moving or using an item', async () => {
  const bot = model(p => p.y < 1 ? ['stone'] : ['air'])
  const position = bot.entity.position.clone(); const velocity = bot.entity.velocity.clone()
  const target = new Vec3(18.5, 1, .5)
  const chosen = await planRiptideTo(bot, { aborted: false }, 3, target, () => true)
  assert.ok(chosen, 'a distant supported target must be reachable with its existing native air steering')
  assert.ok(chosen.plan.states.at(-1)!.pos.distanceTo(target) < .25)
  assert.equal(await planRiptideTo(bot, { aborted: false }, 3, target, () => false), null, 'dry release cannot authorize even a geometrically valid landing')
  assert.equal(await planRiptideTo(bot, { aborted: true }, 3, target, () => true), null)
  assert.deepEqual(bot.entity.position, position); assert.deepEqual(bot.entity.velocity, velocity)
  assert.equal(bot.activated, undefined)
})

test('navigation Riptide reaches a loaded raised platform whose exposed landing is hidden by its front wall', async () => {
  const bot = model(p => p.x >= 22 && p.x <= 34 && Math.abs(p.z) <= 1 && p.y >= 1 && p.y <= 14 ? ['stone'] : p.y < 1 ? ['stone'] : ['air'])
  bot.world = { getBlock: bot.blockAt, raycast: require('prismarine-world/src/worldsync').prototype.raycast }
  const target = new Vec3(28.5, 15, .5)
  assert.equal(require('../src/navigation/parkour').visibleLanding(bot, target), false, 'the front wall hides the top from eye-level sight')
  assert.ok(planRiptide(bot, 3, -Math.PI / 2, .6, target), 'the same native forecast clears the observed front wall and lands without damage')
  const chosen = await planRiptideTo(bot, { aborted: false }, 3, target, () => true)
  assert.ok(chosen, 'movement must inspect the whole loaded trajectory instead of vetoing a hidden top')
  assert.ok(chosen.plan.states.at(-1)!.pos.distanceTo(target) < .25)
  assert.equal(bot.activated, undefined)
})

test('ordinary shared route selects an existing enchanted Riptide and waits for its self receipt and real target landing', async () => {
  const bot = model(p => p.y < 1 ? ['stone'] : ['air'])
  bot.rainState = 1; bot.game = { dimension: 'overworld', minY: 0, height: 32 }
  const trident = { name: 'trident', componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'minecraft:riptide', level: 3 }] } }]]) }
  bot.inventory.items = () => [trident]
  const index = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  bot.deactivateItem = () => { bot.released = true; bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: index, value: 4 }] }) }
  bot.waitForTicks = (ticks: number) => new Promise<void>(resolve => {
    const listener = () => { if (--ticks === 0) { bot.removeListener('physicsTick', listener); resolve() } }
    bot.on('physicsTick', listener)
  })
  const pump = setInterval(() => {
    const state = new native.PlayerState(bot, bot.controlState); bot.physics.simulatePlayer(state, { getBlock: bot.blockAt }); state.apply(bot)
    bot.emit('physicsTick'); bot.emit('ndMovementSent')
  }, 1)
  try {
    const target = new Vec3(18.5, 1, .5)
    const result = await require('../src/navigation/parkour').route(bot, { aborted: false }, { toward: target, maxLandings: 2 })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.landings.some((landing: any) => landing.mode === 'riptide' && landing.serverSpin && landing.ok))
    assert.ok(bot.entity.position.distanceTo(target) < .3); assert.equal(bot.entity.onGround, true); assert.equal(bot.health, 20)
    assert.equal(bot.released, true); assert.deepEqual(bot.controlState, IDLE)
    assert.equal(bot._ndParkourForecast, undefined); assert.equal(bot._client.listenerCount('entity_metadata'), 0)
  } finally { clearInterval(pump) }
})

test('rain activation requires the actual observed biome and loaded sky column', () => {
  const { rainAt } = require('../src/utility')
  const bot = model(p => p.y < 1 ? ['stone'] : ['air'])
  bot.rainState = 1; bot.game = { dimension: 'overworld', minY: 0, height: 16 }
  assert.equal(rainAt(bot, bot.entity.position), true)
  const read = bot.blockAt
  bot.blockAt = (p: Vec3) => p.y === 1 ? { ...read(p), biome: { id: registry.biomesByName.desert.id } } : read(p)
  assert.equal(rainAt(bot, bot.entity.position), false)
  bot.blockAt = (p: Vec3) => p.y === 10 ? null : read(p)
  assert.equal(rainAt(bot, bot.entity.position), false, 'an unloaded sky is not proof of rain activation')
  bot.blockAt = (p: Vec3) => p.y === 3 ? Block.fromStateId(registry.blocksByName.stone.defaultState, 40) : read(p)
  assert.equal(rainAt(bot, bot.entity.position), false)
})

test('dry or unconfirmed Riptide cannot create client momentum', async () => {
  const bot = model(p => p.y < 1 ? ['stone'] : ['air'])
  const item = { name: 'trident' }; const position = bot.entity.position.clone()
  const dry = await runRiptide(bot, { aborted: false }, item, 3, -Math.PI / 2, 0, () => false, async release => release())
  assert.equal(dry.ok, false); assert.equal(bot.activated, undefined)
  const index = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  bot.deactivateItem = () => {
    bot._client.emit('entity_metadata', { entityId: 8, metadata: [{ key: index, value: 4 }] })
    bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: index, value: 1 }] })
  }
  const missing = await runRiptide(bot, { aborted: false }, item, 3, -Math.PI / 2, 0, () => true, async release => release())
  assert.equal(missing.ok, false); assert.equal(missing.serverSpin, false)
  assert.deepEqual(bot.entity.position, position)
  assert.equal(bot.entity.velocity.x, 0); assert.equal(bot._client.listenerCount('entity_metadata'), 0)
})

test('only the actual self spin receipt permits earned Riptide prediction and native stable landing', async () => {
  const bot = model(p => p.y < 1 ? ['stone'] : ['air'])
  const index = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  bot.deactivateItem = () => {
    bot.released = true
    bot._client.emit('entity_metadata', { entityId: 8, metadata: [{ key: index, value: 4 }] })
    bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: index, value: 4 }] })
  }
  const result = await runRiptide(bot, { aborted: false }, { name: 'trident' }, 3, -Math.PI / 2, 0, () => true, async release => release())
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.serverSpin, true)
  assert.ok('chargedTicks' in result && 'moved' in result && 'samples' in result)
  assert.equal(result.chargedTicks, 13); assert.ok(result.moved! > 4)
  assert.ok(result.samples.length >= 6); assert.equal(bot.entity.onGround, true); assert.equal(bot.health, 20)
  assert.equal(bot._client.listenerCount('entity_metadata'), 0)
  assert.deepEqual(bot.controlState, IDLE, 'a confirmed Riptide landing releases its temporary braking keys')
})

test('Riptide charge begins at its real main-hand use receipt and cannot finish in a client catch-up burst', async () => {
  const bot = model(p => p.y < 1 ? ['stone'] : ['air'])
  const index = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  let frames = 0; let serverMs = 1000; let useAt: number | undefined
  bot.ndClock = { serverNow: () => serverMs }
  bot.activateItem = () => { bot.activated = true }
  const advance = bot.waitForTicks
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      frames++
      if (frames === 1) bot._client.emit('entity_metadata', { entityId: 8, metadata: [{ key: index, value: 1 }] })
      if (frames === 2) bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: index, value: 3 }] })
      if (frames === 16) {
        useAt = serverMs
        bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: index, value: 1 }] })
      }
      if (frames > 16) serverMs += frames <= 29 ? 20 : 50
      await advance(1)
    }
  }
  bot.deactivateItem = () => {
    bot.released = true
    assert.notEqual(useAt, undefined, 'release must follow the real self main-hand acknowledgement')
    assert.ok(serverMs - useAt! >= 13 * 50, 'old client frames cannot supply server use duration')
    bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: index, value: 4 }] })
  }
  const result = await runRiptide(bot, { aborted: false }, { name: 'trident' }, 3, -Math.PI / 2, 0, () => true, async release => release())
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.serverSpin, true)
  assert.ok('chargedTicks' in result && result.chargedTicks! > 13)
  assert.equal(bot.health, 20); assert.equal(bot.entity.onGround, true)
  assert.equal(bot._ndParkourForecast, undefined); assert.equal(bot._client.listenerCount('entity_metadata'), 0)
  assert.deepEqual(bot.controlState, IDLE)
})

test('another entity or an off-hand use receipt cannot authorize a Riptide charge or release', async () => {
  const bot = model(p => p.y < 1 ? ['stone'] : ['air'])
  const index = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  bot.activateItem = () => {
    bot.activated = true
    bot._client.emit('entity_metadata', { entityId: 8, metadata: [{ key: index, value: 1 }] })
    bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: index, value: 3 }] })
  }
  const result = await runRiptide(bot, { aborted: false }, { name: 'trident' }, 3, -Math.PI / 2, 0, () => true, async release => release())
  assert.equal(result.ok, false); assert.equal(result.why, 'riptide_use_not_confirmed')
  assert.equal(bot.released, undefined); assert.equal(bot.entity.velocity.x, 0)
  assert.equal(bot._ndParkourForecast, undefined); assert.equal(bot._client.listenerCount('entity_metadata'), 0)
})

test('Riptide refuses a fall that would hit damaging ground during its real charge before using the item', async () => {
  const bot = model(p => p.y < 1 ? ['stone'] : p.y === 1 && p.x >= 15 ? ['water'] : ['air'])
  bot.entity.position.y = 8; bot.entity.velocity.y = -.8; bot.entity.onGround = false
  assert.ok(planRiptide(bot, 3, -Math.PI / 2, 0), 'an immediate hypothetical impulse reaches water, but activation requires a real charge first')
  const result = await runRiptide(bot, { aborted: false }, { name: 'trident' }, 3, -Math.PI / 2, 0, () => true, async release => release())
  assert.equal(result.ok, false); assert.equal(bot.activated, undefined)
})

test('a rainy airborne charge revalidates the next real release tick and uses the same landing controller', async () => {
  const bot = model(p => p.y < 0 ? ['stone'] : p.y < 3 ? ['water'] : ['air'])
  bot.entity.position.y = 25; bot.entity.velocity.y = -.2; bot.entity.onGround = false
  const index = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  bot.deactivateItem = () => { bot.released = true; bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: index, value: 4 }] }) }
  const result = await runRiptide(bot, { aborted: false }, { name: 'trident' }, 3, -Math.PI / 2, .6, () => true, async release => { await bot.waitForTicks(1); release() })
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.serverSpin, true)
  assert.equal(bot.health, 20); assert.ok(bot.entity.isInWater); assert.deepEqual(bot.controlState, IDLE)
})

test('a real walk off a ledge, airborne charge and Riptide use one validated movement owner and safe water landing', async () => {
  const bot = model(p => p.x === 0 && p.z === 0 && p.y >= 3 && p.y < 41 ? ['stone'] : p.y < 0 ? ['stone'] : p.y < 3 ? ['water'] : ['air'])
  bot.entity.position.y = 41
  const index = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  bot.deactivateItem = () => { bot.released = true; bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: index, value: 4 }] }) }
  const result = await runRiptide(bot, { aborted: false }, { name: 'trident' }, 3, -Math.PI / 2, .6, () => true,
    async release => { await bot.waitForTicks(1); release() }, new Vec3(30.5, 0, .5), { ticks: 6 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok('launchSamples' in result && 'chargeSamples' in result && 'releaseState' in result)
  const launch = result.launchSamples as Array<{ onGround: boolean }>
  const charge = result.chargeSamples as Array<{ onGround: boolean }>
  const release = result.releaseState as { onGround: boolean }
  assert.ok(launch.some(state => !state.onGround), 'the initial approach genuinely leaves observed ledge support')
  assert.equal(charge.length, 13); assert.ok(charge.every(state => !state.onGround)); assert.equal(release.onGround, false)
  assert.equal(bot._ndParkourForecast, undefined); assert.deepEqual(bot.controlState, IDLE)
  assert.equal(bot.health, 20); assert.ok(bot.entity.isInWater && bot.entity.onGround)
})

test('a delayed native spin receipt keeps only the validated safe coast owned between release and acknowledgement', async () => {
  const bot = model(p => p.x === 0 && p.z === 0 && p.y >= 3 && p.y < 41 ? ['stone'] : p.y < 0 ? ['stone'] : p.y < 3 ? ['water'] : ['air'])
  bot.entity.position.y = 41
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const index = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  let afterRelease = 0
  bot.deactivateItem = () => { bot.released = true }
  const advance = bot.waitForTicks
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      if (bot.released && !bot.accepted) {
        const marker = bot._ndParkourForecast
        const positions = [marker?.from, marker?.next].filter(Boolean).map((p: Vec3) => new Vec3(p.x, p.y, p.z))
        if (!positions.some((p: Vec3) => p.distanceTo(bot.entity.position) <= .1)) {
          ctl.aborted = true; ctl.onAbort.slice().forEach(abort => abort()); return
        }
      }
      await advance(1)
      if (bot.released && !bot.accepted && ++afterRelease === 4) {
        bot.accepted = true
        bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: index, value: 4 }] })
      }
    }
  }
  const result = await runRiptide(bot, ctl, { name: 'trident' }, 3, -Math.PI / 2, .6, () => true,
    async release => { await bot.waitForTicks(1); release() }, new Vec3(30.5, 0, .5), { ticks: 6 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(ctl.aborted, false); assert.equal(result.serverSpin, true)
  assert.equal(bot.health, 20); assert.ok(bot.entity.isInWater && bot.entity.onGround)
  assert.equal(bot._ndParkourForecast, undefined); assert.deepEqual(bot.controlState, IDLE)
})

test('rain at the launch cannot authorize a projected airborne release beneath an actual loaded roof', async () => {
  const { rainAt } = require('../src/utility')
  const bot = model(p => p.y === 44 && p.x >= 2 ? ['stone'] : p.x === 0 && p.z === 0 && p.y >= 3 && p.y < 41 ? ['stone'] : p.y < 0 ? ['stone'] : p.y < 3 ? ['water'] : ['air'])
  bot.entity.position.y = 41; bot.rainState = 1; bot.game = { dimension: 'overworld', minY: 0, height: 64 }
  const before = bot.entity.position.clone()
  assert.equal(rainAt(bot, before), true, 'the initial launch has observed rain and an open sky')
  const result = await runRiptide(bot, { aborted: false }, { name: 'trident' }, 3, -Math.PI / 2, .6,
    state => rainAt(bot, state?.pos ?? bot.entity.position), async release => release(), new Vec3(30.5, 0, .5), { ticks: 6 })
  assert.equal(result.ok, false); assert.equal(result.ticks, 0); assert.equal(bot.activated, undefined)
  assert.deepEqual(bot.entity.position, before); assert.equal(bot.released, undefined)
})

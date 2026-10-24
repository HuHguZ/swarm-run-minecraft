import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { createAerialCombat } from '../src/combat/aerial-executor'
import * as graph from '../src/combat/aerial-graph'
import * as lance from '../src/combat/aerial-lance'
import * as flight from '../src/elytra/flight'
import sky = require('../src/elytra')
import pick = require('../src/pick')
import clock = require('../src/game-clock')

test('пике уступает копью по летящему на элитрах противнику, по стоящему остаётся', () => {
  const actor = (id: number, y: number) => ({ id, position: { x: 0, y, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, flying: true, grounded: false, alive: true })
  const state: graph.AerialState = { self: actor(1, 72), target: actor(2, 68), health: 20, interrupted: false,
    safeLanding: { x: 0, y: 64, z: 0 }, corridorClear: true,
    equipment: { elytra: true, chestplate: true, rockets: 8, pearls: 0, mace: true, spear: true },
    maceDropReady: true, maceReady: true, spearReady: true, fallDistance: 4, pearlDamage: 5 }
  assert.equal(graph.evaluateAerial(state).node, 'SpearStrike')
  state.target!.flying = false
  state.target!.grounded = true
  assert.equal(graph.evaluateAerial(state).node, 'DiveStrike')
})

test('после тарана: заряд в полёте, сброс и удар для человека и бота; щит, взлёт и отмена срывают пике', async t => {
  let now = 5000, active: any
  t.mock.method(clock, 'now', () => now)
  t.mock.method(pick, 'canHit', () => active.bot.entity.position.y <= 67 && active.bot.entity.position.y > 64)
  t.mock.method(pick, 'aim', () => ({ point: active.target.position }))
  t.mock.method(clock, 'sleep', async () => {
    now += 50
    const { bot } = active
    if (!bot.entity.elytraFlying) {
      const y = bot.entity.position.y
      sky.fallStep(bot.entity.position, bot.entity.velocity)
      bot._ndElytra.fd += y - bot.entity.position.y
    }
  })
  for (const mode of ['human', 'swarm', 'outbound', 'shield', 'flying', 'takeoff', 'abort', 'switched', 'low', 'ready', 'late-shield', 'late-charge']) {
    const mace = { name: 'mace' }, spear = { name: 'diamond_spear' }
    const target: any = { id: 2, type: 'player', username: mode === 'human' ? 'Human' : 'NeuroDown_foe',
      position: new Vec3(1, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, isValid: true,
      metadata: [mode === 'shield' ? 3 : 0], equipment: [null, { name: 'shield' }], elytraFlying: mode === 'flying' }
    const bot: any = { health: mode === 'low' ? 8 : 20, heldItem: mode === 'ready' ? mace : spear,
      _ndMaceHeldAt: mode === 'ready' ? now - 1650 : 0, _ndElytra: { fd: 1 },
      entity: { id: 1, position: new Vec3(0, 72, 0), velocity: new Vec3(.05, -.1, 0), elytraFlying: true },
      inventory: { items: () => [mace, spear], slots: [] }, world: { raycast: () => null },
      registry: { entitiesByName: { player: { metadataKeys: ['living_entity_flags'] } } }, lookAt: async () => {} }
    const ctl = { aborted: false }, swaps: string[] = []
    if (mode === 'outbound') { bot.entity.position.x = 8; bot.entity.velocity.x = 1.4 }
    let attacks = 0, waited = 0
    active = { bot, target }
    bot.equip = async item => { bot.heldItem = item; bot._ndMaceHeldAt = now }
    bot.attack = e => {
      assert.equal(e, target); assert.equal(bot.entity.elytraFlying, false)
      assert.ok(now - bot._ndMaceHeldAt >= 1650); attacks++
    }
    const world = { at: (_x, y) => y < 64 ? 1 : 0, solid: (_x, y) => y < 64,
      floorBelow: () => ({ top: 64 }), boxHit: (_x, y) => y < 64 }
    const operations: any = { enemy: () => target, stats: {}, allow() {}, used() {},
      kit: () => ({ elytra: true, chest: true, mace: true, rockets: mode === 'ready' ? 0 : 8 }),
      worldOf: () => world,
      landingSpot: () => new Vec3(1, 64, 0), gliding: e => !!e.elytraFlying,
      predictGlider: e => e.position,
      swapChest: async (_b, name) => {
        swaps.push(name); bot.entity.elytraFlying = name === 'elytra'
        if (name === 'chest' && mode === 'late-shield') target.metadata[0] = 3
        if (name === 'chest' && mode === 'late-charge') bot._ndMaceHeldAt = now
        return { ok: true }
      }, startGlide() {},
      fly: async (_b, _c, options) => {
        assert.equal(options.goal().kind, 'point')
        assert.ok(options.goal().at.y > target.position.y)
        assert.equal(options.until(), null, 'заряд ещё не готов')
        for (let ticks = 0; ticks <= options.maxMs / 50; ticks++) {
          now += 50; waited++
          if (mode === 'outbound') {
            const state = { p: bot.entity.position, v: bot.entity.velocity, fd: bot._ndElytra.fd, boost: bot.fireworkRocketDuration || 0 }
            const goal = options.goal(), plan = sky.choose(world, state, goal)
            const rocket = !state.boost && flight.rocketChoice(world, state, goal, plan, options.rocketIf(state))
            if (rocket?.fire) { plan.yaw = rocket.yaw; plan.pitch = rocket.pitch; state.boost = 26 }
            const step = sky.rollout(world, state.p, state.v, plan.yaw, plan.pitch, state.boost, 1, { fd: state.fd })
            assert.equal(step.kind, null, 'разворот не касается пола')
            bot.entity.position = new Vec3(step.p.x, step.p.y, step.p.z)
            bot.entity.velocity = new Vec3(step.v.x, step.v.y, step.v.z)
            bot._ndElytra.fd = step.fd; bot.fireworkRocketDuration = Math.max(0, state.boost - 1)
          }
          if (mode === 'takeoff') target.elytraFlying = true
          if (mode === 'abort') ctl.aborted = true
          if (mode === 'switched') bot.heldItem = spear
          if (options.until()) return { ok: true }
        }
        assert.fail('ожидание заряда не завершилось')
      } }
    const result = await createAerialCombat(bot, operations).afterLance(ctl)
    const hit = ['human', 'swarm', 'outbound', 'ready'].includes(mode)
    assert.equal(!!result?.hit, hit, mode)
    assert.equal(attacks, hit ? 1 : 0, mode)
    assert.deepEqual(swaps, hit || mode === 'late-shield' || mode === 'late-charge' ? ['chest', 'elytra'] : [], mode)
    if (mode === 'human' || mode === 'swarm') assert.ok(waited >= 33)
    if (mode === 'ready') assert.equal(waited, 0, 'готовая булава — сброс без ракеты и нового набора')
  }
})

test('обычный воздушный бой передаёт продолжение executor в настоящий lance', async t => {
  const executor: typeof import('../src/combat/aerial-executor') = require('../src/combat/aerial-executor')
  let followed = 0
  t.mock.method(executor, 'createAerialCombat', () => ({ afterLance: async () => { followed++; return { hit: true } } }) as any)
  t.mock.method(lance, 'lance', async (_b, ctl, _e, options) => options.afterPass(ctl))
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0, 64, 0), onGround: true, velocity: new Vec3(0, 0, 0) }
  bot._ndElytra = {}; bot._ndSkyWorld = { boxHit: () => false }
  bot.inventory = { slots: [], items: () => [] }
  const combat = sky.create(bot, { enemy: () => ({ position: new Vec3(8, 64, 0) }) })
  try {
    assert.equal((await combat.run({ aborted: false }, { kind: 'lance' })).hit, true)
    assert.equal(followed, 1)
  } finally { combat.close() }
})

test('таран вызывает продолжение после попадания и промаха; следующий заход снова с копьём', async t => {
  let active: any
  t.mock.method(flight, 'fly', async (_b, _ctl, options: any) => {
    if (options.phase === 'таран: разбег') {
      assert.equal(active.bot.heldItem.name, 'iron_spear')
      assert.equal(active.bot.inventory.slots[45].name, 'firework_rocket')
    }
    return { why: options.phase === 'таран: разбег' ? 'разбег' : 'вышел' }
  })
  t.mock.method(flight, 'land', async () => { active.bot.entity.onGround = true; active.bot.entity.elytraFlying = false; return { ok: true } })
  t.mock.method(flight, 'chestDown', async () => ({ ok: true }))
  t.mock.method(clock, 'sleep', async () => {})
  for (const hit of [true, false]) {
    const bot: any = new EventEmitter(), spear = { name: 'iron_spear' }, rocket = { name: 'firework_rocket', count: 8 }
    bot.entity = { id: 1, position: new Vec3(0, 107, 0), velocity: new Vec3(.05, -.1, 0), elytraFlying: true }
    bot.health = 20; bot.heldItem = spear; bot.inventory = { items: () => [spear, rocket], slots: [] }
    bot.inventory.slots[6] = { name: 'elytra' }; bot.inventory.slots[45] = rocket
    bot._client = new EventEmitter(); bot._ndElytra = { driving: 0, fd: 0, startedAt: 0 }
    bot.look = async () => {}; bot.activateItem = () => {}; bot.deactivateItem = () => {}
    bot.equip = async (item, hand) => { if (hand === 'off-hand') bot.inventory.slots[45] = item; else bot.heldItem = item }
    bot.fireworkRocketDuration = 20
    bot.blockAt = p => ({ name: p.y < 100 ? 'stone' : 'air', boundingBox: p.y < 100 ? 'block' : 'empty' })
    const target: any = { id: 2, type: 'player', username: 'NeuroDown_foe', position: new Vec3(1, 100, 0), onGround: true, isValid: true }
    const ctl = { aborted: false }, stats: any = {}
    active = { bot }
    let followed = 0
    const done = lance.lance(bot, ctl, target, { passes: 2, stats, telemetryHp: () => null,
      afterPass: async flightCtl => {
        assert.equal(flightCtl.aborted, false)
        followed++; bot.heldItem = { name: 'mace' }
        bot.inventory.slots[45] = { name: 'diamond_chestplate' }
        return { hit: true }
      } })
    try {
      for (let tick = 0; tick < 60 && followed < 2; tick++) {
        await new Promise<void>(resolve => setImmediate(resolve))
        if (hit) bot._client.emit('damage_event', { entityId: 2, sourceCauseId: 2, sourceDirectId: 2, sourceTypeId: 37 })
        else bot.entity.position.x = tick % 6 < 2 ? 0 : 2 + tick % 6 * .2
        bot.emit('physicsTick')
      }
      assert.equal(followed, 2, hit ? 'попадание' : 'промах')
      const result = await done
      assert.equal(result.hit, true, 'попадание булавой сохраняется в результате тарана')
    } finally {
      ctl.aborted = true; bot.entity.elytraFlying = false; bot.entity.onGround = true
      bot.emit('physicsTick'); await done
    }
  }
})

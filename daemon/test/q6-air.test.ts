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
import { wingOrbit } from '../src/combat/wing-orbit'

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
  t.mock.method(lance, 'lance', async (_b, ctl, _e, options) => { options.stats.lanceEvasions = 1; return options.afterPass(ctl) })
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0, 64, 0), onGround: true, velocity: new Vec3(0, 0, 0) }
  bot._ndElytra = {}; bot._ndSkyWorld = { boxHit: () => false }
  bot.inventory = { slots: [], items: () => [] }
  const combat = sky.create(bot, { enemy: () => ({ position: new Vec3(8, 64, 0) }) })
  try {
    assert.equal((await combat.run({ aborted: false }, { kind: 'lance' })).hit, true)
    assert.equal(followed, 1)
    assert.equal(combat.report().lanceEvasions, 1, 'internal combat reports retain the emergency exit count')
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

test('two visible gliders hand their accepted escort to ordinary air combat without orbiting indefinitely', async t => {
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    assert.equal(options.until(), 'цель на элитрах')
    return { why: options.until() }
  })
  let fought = 0, landed = 0
  t.mock.method(require('../src/combat'), 'fight', async () => { fought++; return { hits: 0 } })
  t.mock.method(flight, 'land', async () => { landed++; return { ok: true } })
  const a = orbitWindFixture(2, 0, true), b = orbitWindFixture(2, 0, true)
  ;(a.session as any).updateMovements = (b.session as any).updateMovements = () => {}
  a.bot.players.Foe.entity = b.bot.entity
  b.bot.players.Foe.entity = a.bot.entity
  const out = await Promise.all([a, b].map(f => wingOrbit(f.session, f.ctl, f.params)))
  assert.ok(out.every(r => r.ok && r.why === 'цель на элитрах'))
  assert.equal(fought, 2); assert.equal(landed, 2)
})
test('высота облёта стоящего, падающего без элитр и гребня сохраняет прежний заход', async t => {
  t.mock.method(flight, 'land', async () => ({ ok: false, why: 'orbit-only model' }))
  for (const [mode, onGround, ledge, offset] of [['perch', true, false, 3], ['fall', false, false, 3], ['ledge', true, true, 2]] as const) {
    const foe: any = { id: 2, type: 'player', username: 'Foe', position: new Vec3(30, 120, 0), onGround, elytraFlying: false, isValid: true }
    const bot: any = Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 120, 0), velocity: new Vec3(1, 0, 0), elytraFlying: true, onGround: false },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
      players: { Foe: { entity: foe } }, inventory: { slots: [], items: () => [{ name: 'elytra' }, { name: 'firework_rocket', count: 5 }, { name: 'wind_charge', count: 2 }] } })
    t.mock.method(flight, 'fly', async (_b, _ctl, o) => {
      const goal = o.goal()
      assert.equal(o.until(), null, 'контроль высоты имеет заряды для продолжения облёта')
      assert.equal(goal.at.y, foe.position.y + offset, mode)
      assert.equal(o.rocketIf({ p: foe.position, v: new Vec3(1, 0, 0) }), true, mode)
      return { why: 'control' }
    })
    await wingOrbit({ require: () => bot }, { aborted: false }, { target: 'Foe', floorY: 64, ledge, arena: ledge ? { x: 0, y: 64, z: 0, r: 64 } : null })
  }
})

function orbitWindFixture(main = 2, off = 0, flying = false) {
  const supply = { main, off }, slots: any[] = []
  slots[6] = { name: 'elytra', count: 1 }
  const foe = Object.assign(new EventEmitter(), { id: 2, type: 'player', username: 'Foe', position: new Vec3(20, 150, 0), onGround: false, metadata: [] })
  const bot: any = Object.assign(new EventEmitter(), { health: 20, _ndWindCd: 100000,
    entity: { id: 1, type: 'player', username: 'Wing', position: new Vec3(0, 130, 0), velocity: new Vec3(1, 0, 0), onGround: !flying, elytraFlying: flying },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    players: { Foe: { entity: foe } }, inventory: { slots,
      items: () => [{ name: 'firework_rocket', count: 8 }, ...(supply.main ? [{ name: 'wind_charge', count: supply.main }] : [])] } })
  Object.defineProperty(slots, '45', { get: () => supply.off ? { name: 'wind_charge', count: supply.off } : null })
  return { bot, supply, session: { require: () => bot }, ctl: { aborted: false }, params: { target: 'Foe', floorY: 120 } }
}

test('recorded AA d unknown forecast ignores the old ground ledge hint for its air goal and rocket request', async t => {
  const f = orbitWindFixture(2, 0, true), foe: any = f.bot.players.Foe.entity
  // AA d +1657ms: actual enemyWindFrames returned [], current public feet and own body below.
  foe.position = new Vec3(600.45703125, 125.48347654938698, 600.330078125)
  f.bot.entity.position = new Vec3(596.7853652506574, 128.45157456403558, 606.2267638198339)
  Object.defineProperty(foe, 'health', { get() { throw Error('private enemy HP') } })
  Object.defineProperty(foe, 'velocity', { get() { throw Error('private enemy velocity') } })
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    const goal = options.goal()
    assert.notEqual(typeof goal.at, 'function', 'unknown future stays an observed current-pose fallback')
    assert.equal(goal.at.y, 126.70347654938698)
    assert.equal(options.rocketIf({ p: f.bot.entity.position, v: new Vec3(1, 0, 0) }, null, goal), false,
      'the recorded glider is already above the current public-eye approach')
    assert.equal(options.until(), null)
    return { why: 'recorded unknown goal control' }
  })
  t.mock.method(flight, 'land', async () => ({ ok: true }))
  await wingOrbit(f.session, f.ctl, { ...f.params, ledge: true, arena: { x: 600.5, y: 120, z: 600.5, r: 80 } })
})

for (const departure of ['jump', 'fall']) test(`a supported ledge switches to air after a visible ${departure} and stops on the next actual support`, async t => {
  const f = orbitWindFixture(2, 0, true), foe: any = f.bot.players.Foe.entity
  foe.position = new Vec3(30, 120, 0); foe.onGround = true
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    assert.equal(options.goal().at.y, 122, 'the real supported perch still uses its centre-side arc')
    assert.equal(options.until(), null, 'a standing initial perch is not an immediate landing')
    foe.onGround = false; foe.position.y = departure === 'jump' ? 127.5 : 115.5
    assert.equal(options.goal().at.y, foe.position.y + pick.eyeHeight(f.bot, foe) - pick.eyeHeight(f.bot), 'the initial hint yields to the public-eye air approach')
    assert.equal(options.until(), null, 'air without support remains an escort')
    foe.onGround = true; foe.position.y = 120
    assert.equal(options.until(), 'он внизу', 'the completed air phase does not orbit the returned ground target again')
    return { why: options.until() }
  })
  t.mock.method(flight, 'land', async () => ({ ok: true }))
  await wingOrbit(f.session, f.ctl, { ...f.params, floorY: 64, ledge: true, arena: { x: 0, y: 64, z: 0, r: 80 } })
})

for (const scenario of [
  { name: 'legacy late ETA', eta: 1, fires: false },
  { name: 'legacy feasible ETA', eta: 30, fires: true },
  { name: 'fresh native ETA', eta: 30, observed: 100, received: 100, fires: true },
  { name: 'native ETA delivered two ticks late', eta: 30, observed: 100, received: 102, fires: false },
  { name: 'expiry after queue', eta: 30, observed: 100, received: 100, change: 'advance', fires: false },
  { name: 'abort after queue', eta: 30, observed: 100, received: 100, change: 'abort', fires: false },
  { name: 'body change after queue', eta: 30, observed: 100, received: 100, change: 'body', fires: false },
  { name: 'clock change after queue', eta: 30, observed: 100, received: 100, change: 'clock', fires: false },
  { name: 'frozen clock after queue', eta: 30, observed: 100, received: 100, change: 'freeze', fires: false }
]) test(`a forty-five-block pearl pop keeps the native arrival deadline: ${scenario.name}`, async t => {
  t.mock.method(clock, 'now', () => 1000)
  let shots = 0
  const wind = { name: 'wind_charge', count: 1, slot: scenario.change ? 45 : 36 }, slots: any[] = []; slots[wind.slot] = wind
  const bot: any = Object.assign(new EventEmitter(), { username: 'Blue', health: 20, quickBarSlot: 0,
    ndClock: scenario.received === undefined ? undefined : { age: BigInt(scenario.received), ticks: 0, serverTicks: 0 },
    game: { minY: -64, height: 384 }, inventory: { slots, items: () => [wind] },
    entity: { id: 1, username: 'Blue', position: new Vec3(0, 120, .5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0 },
    blockAt: (p: Vec3) => ({ name: p.y < 120 ? 'stone' : 'air', boundingBox: p.y < 120 ? 'block' : 'empty',
      shapes: p.y < 120 ? [[0, 0, 0, 1, 1, 1]] : [], position: p.floored() }),
    activateItem: () => { shots++ }, setQuickBarSlot: () => {} })
  const ctl = { aborted: false }
  const pending = require('../src/combat/pearl-ambush').pearlPop({ bot }, ctl, {
    at: { x: 45, y: 120, z: .5 }, eta: scenario.eta, gameTick: scenario.observed
  })
  if (scenario.change) {
    assert.equal(bot.listenerCount('ndMovementSent'), 1, 'the offhand release is already queued')
    if (scenario.change === 'advance') bot.ndClock.ticks += 2
    if (scenario.change === 'abort') ctl.aborted = true
    if (scenario.change === 'body') bot.entity = { ...bot.entity, id: 2 }
    if (scenario.change === 'clock') bot.ndClock = { ...bot.ndClock }
    if (scenario.change === 'freeze') bot.ndClock.frozen = true
    bot.emit('ndMovementSent')
  }
  const result = await pending
  assert.equal(result.ok, scenario.fires)
  assert.equal(shots, Number(scenario.fires))
  if (scenario.fires) assert.equal(result.ticks, 31, 'the actual native floor ray is longer than thirty ticks')
  else if (!scenario.change || scenario.change === 'advance') assert.match(result.why, /^поздно: полёт заряда/)
})

test('an arena orbit without motion history aligns its muzzle with the current fair eyes', async t => {
  const f = orbitWindFixture(2, 0, true), foe = f.bot.players.Foe.entity
  f.bot.entity._ndPoseHeight = .6
  let landed = 0
  t.mock.method(flight, 'fly', async (_bot, owner, options) => {
    assert.equal(owner, f.ctl)
    const goal = options.goal()
    assert.equal(goal.at.y + pick.eyeHeight(f.bot), foe.position.y + pick.eyeHeight(f.bot, foe))
    assert.equal(options.rocketIf({ p: goal.at.offset(0, .1, 0), v: new Vec3(1, 0, 0) }, null, goal), false)
    assert.equal(options.until(), null)
    foe.onGround = true
    assert.equal(options.until(), 'он внизу', 'the unknown future does not remove actual landing detection')
    return { why: options.until() }
  })
  t.mock.method(flight, 'land', async (_bot, owner) => { assert.equal(owner, f.ctl); landed++; return { ok: true } })
  assert.equal((await wingOrbit(f.session, f.ctl, { ...f.params, arena: { x: 0, y: 120, z: 0, r: 80 } })).why, 'он внизу')
  assert.equal(landed, 1)
})

test('an already gliding target reaches the same safe native launch as other visible targets', async t => {
  const f = orbitWindFixture(), foe: any = f.bot.players.Foe.entity
  foe.metadata = []; foe.metadata[0] = 0x80
  let launches = 0
  t.mock.method(flight, 'takeoff', async () => { launches++; return { ok: false, why: 'controlled unsafe launch' } })
  const r = await wingOrbit(f.session, f.ctl, f.params)
  assert.equal(r.ok, false)
  assert.equal(r.why, 'взлёт: controlled unsafe launch'); assert.equal(launches, 1)
})

test('wind orbit keeps its owner through ordinary combat before landing when the target opens elytra', async t => {
  const f = orbitWindFixture(2, 0, true), foe: any = f.bot.players.Foe.entity
  let now = 1000
  t.mock.method(clock, 'now', () => now)
  ;(f.session as any).updateMovements = () => {}
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    assert.equal(options.until(), null)
    foe.metadata = []; foe.metadata[6] = 'fall_flying'
    f.bot.blockAt = () => ({ name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] })
    assert.equal(options.until(), 'цели не видно', 'loss of sight ends the orbit without reacting to hidden pose packets')
    f.bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
    assert.equal(options.until(), 'цель на элитрах')
    now += 2000
    return { why: options.until() }
  })
  let landed = 0
  t.mock.method(flight, 'land', async () => { landed++; return { ok: true } })
  let fought = 0
  t.mock.method(require('../src/combat'), 'fight', async (session, ctl, options) => {
    fought++
    assert.equal(session, f.session)
    assert.equal(ctl, f.ctl)
    assert.equal(landed, 0, 'keep the existing airborne approach')
    assert.equal(options.target, 'Foe')
    assert.equal(options.allowPlayer, true)
    assert.equal(options.allowRanged, true)
    assert.equal(options.timeoutSeconds, 10, 'use only the remaining orbit budget')
    return { hits: 1 }
  })
  const r = await wingOrbit(f.session, f.ctl, f.params)
  assert.equal(fought, 1)
  assert.equal(landed, 1)
  assert.equal(r.combat.hits, 1)
  assert.equal(r.why, 'цель на элитрах')
})

for (const exit of ['aborted', 'expired', 'failed']) test(`orbit combat handoff ${exit} keeps cancellation, budget and landing`, async t => {
  const f = orbitWindFixture(2, 0, true), foe: any = f.bot.players.Foe.entity
  let now = 1000, fought = 0, landed = 0
  t.mock.method(clock, 'now', () => now)
  ;(f.session as any).updateMovements = () => {}
  t.mock.method(flight, 'fly', async () => {
    foe.metadata = []; foe.metadata[0] = 0x80
    if (exit === 'aborted') f.ctl.aborted = true
    if (exit === 'expired') now += 12000
    return { why: 'цель на элитрах' }
  })
  t.mock.method(require('../src/combat'), 'fight', async () => { fought++; throw new Error('combat failed') })
  t.mock.method(flight, 'land', async (_b, ctl) => { assert.equal(ctl, f.ctl); landed++; return { ok: true } })
  if (exit === 'failed') await assert.rejects(wingOrbit(f.session, f.ctl, f.params), /combat failed/)
  else await wingOrbit(f.session, f.ctl, f.params)
  assert.equal(fought, exit === 'failed' ? 1 : 0)
  assert.equal(landed, 1, 'normal cleanup is retained even when combat throws')
})

test('облёт без зарядов не начинает взлёт', async t => {
  const f = orbitWindFixture(0), launches: any[] = []
  t.mock.method(flight, 'takeoff', async (...args) => { launches.push(args); return { ok: false, why: 'unexpected launch' } })
  const result = await wingOrbit(f.session, f.ctl, f.params)
  assert.equal(launches.length, 0, 'нет средства атаки — не начинаем новый полёт')
  assert.equal(result.ok, false)
  assert.equal(result.why, 'нет зарядов ветра')
})

for (const initial of [false, true]) test(`облёт с ${initial ? 'исходно пустым запасом в воздухе' : 'потраченным последним зарядом'} штатно садится`, async t => {
  const f = orbitWindFixture(initial ? 0 : 2, 0, true), calls: string[] = []
  t.mock.method(flight, 'takeoff', async () => { assert.fail('уже летящий не взлетает снова') })
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    if (!initial) assert.equal(options.until(), null, 'два заряда ещё дают смысл облёту')
    f.supply.main = 0
    assert.equal(options.until(), 'заряды закончились', 'выходим сразу после расхода, не ждём 12 с')
    calls.push('fly')
    return { why: options.until() }
  })
  t.mock.method(flight, 'land', async () => {
    calls.push('land'); f.bot.entity.onGround = true; f.bot.entity.elytraFlying = false
    return { ok: true }
  })
  t.mock.method(flight, 'chestDown', async () => { calls.push('chest'); return { ok: true } })
  const result = await wingOrbit(f.session, f.ctl, f.params)
  assert.deepEqual(calls, ['fly', 'land', 'chest'])
  assert.equal(result.why, 'заряды закончились')
  assert.equal(result.landed, true)
})

for (const hand of ['main', 'off']) test(`последний заряд в ${hand} и его перезарядка не отменяют облёт`, async t => {
  const f = orbitWindFixture(hand === 'main' ? 1 : 0, hand === 'off' ? 1 : 0, true)
  t.mock.method(clock, 'now', () => 0)
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    assert.equal(options.until(), null, 'положительный запас остаётся полезным во время cooldown')
    return { why: 'positive control' }
  })
  t.mock.method(flight, 'land', async () => ({ ok: false }))
  assert.equal((await wingOrbit(f.session, f.ctl, f.params)).why, 'positive control')
})

for (const grounded of [true, false]) test(`облёт с флагом полёта ${grounded ? 'на земле сначала взлетает' : 'в воздухе не взлетает повторно'}`, async t => {
  const f = orbitWindFixture(2, 0, true), calls: string[] = []
  f.bot.entity.onGround = grounded
  assert.equal(sky.gliding(f.bot.entity), true, 'флаг полёта сам по себе ещё не доказывает отрыв от земли')
  t.mock.method(flight, 'takeoff', async () => {
    assert.equal(f.bot.entity.onGround, true)
    calls.push('takeoff')
    f.bot.entity.onGround = false
    f.bot.entity.position.y += .42
    return { ok: true }
  })
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    assert.equal(f.bot.entity.onGround, false, 'на земле нельзя выдавать пустой облёт за успешный полёт')
    calls.push('fly')
    assert.equal(options.until(), null, 'положительные заряды сохраняют полезный облёт')
    assert.equal(options.goal().kind, 'point')
    return { why: 'entry control' }
  })
  t.mock.method(flight, 'land', async () => {
    calls.push('land'); f.bot.entity.onGround = true; f.bot.entity.elytraFlying = false
    return { ok: true }
  })
  t.mock.method(flight, 'chestDown', async () => { calls.push('chest'); return { ok: true } })
  const result = await wingOrbit(f.session, f.ctl, f.params)
  assert.deepEqual(calls, [...(grounded ? ['takeoff'] : []), 'fly', 'land', 'chest'])
  assert.equal(result.ok, true)
  assert.equal(result.nearTicks, 0, 'цель fixture дальше16бл.; goal всё же действительно считался')
  assert(Number.isFinite(result.closest), 'успешный проход не остаётся closest=null')
})

for (const shots of [0, 2, null]) test(`orbit receipt reports ${shots ?? 'unknown'} actual reflex releases separately from proximity`, async t => {
  const f = orbitWindFixture(2, 0, true)
  if (shots !== null) (f.session as any)._windOut = { fired: 12 }
  t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
    options.goal()
    if (shots !== null) (f.session as any)._windOut.fired += shots
    return { why: 'receipt control' }
  })
  t.mock.method(flight, 'land', async () => ({ ok: true }))
  const result = await wingOrbit(f.session, f.ctl, f.params)
  assert.equal(result.windShots, shots)
  assert.equal(result.nearTicks, 0, 'no charge receipt is inferred from contact distance')
})

test('a visible low jump with unknown foreign onGround delegates flight feasibility without a height veto', async t => {
  const f = orbitWindFixture(), foe: any = f.bot.players.Foe.entity
  delete foe.onGround
  foe.position.y = 121.25
  let launches = 0
  t.mock.method(flight, 'takeoff', async () => { launches++; return { ok: false, why: 'controlled unsafe launch' } })
  const r = await wingOrbit(f.session, f.ctl, f.params)
  assert.equal(r.ok, false)
  assert.equal(r.why, 'взлёт: controlled unsafe launch'); assert.equal(launches, 1)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('a known floor beyond the height scan cannot end an airborne orbit with unknown foreign onGround', async t => {
  const now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const f = orbitWindFixture(2, 0, true), foe: any = f.bot.players.Foe.entity
  delete foe.onGround
  foe.position.y = 170
  f.bot.blockAt = p => ({ name: p.y < 120 ? 'stone' : 'air', boundingBox: p.y < 120 ? 'block' : 'empty', position: p.floored() })
  assert.equal(require('../src/combat/wind-out').heightAbove(f.bot, foe.position), Infinity, 'the existing scan stops before the known arena floor')
  t.mock.method(flight, 'fly', async (_bot, owner, o) => {
    assert.equal(owner, f.ctl)
    assert.equal(o.until(), null, 'only actual support or onGround ends the airborne chain')
    assert.equal(o.maxMs, 12000, 'the existing bounded flight and its own safety retain ownership')
    return { why: 'high-chain control' }
  })
  let landed = 0
  t.mock.method(flight, 'land', async (_bot, owner) => { assert.equal(owner, f.ctl); landed++; return { ok: true } })
  assert.equal((await wingOrbit(f.session, f.ctl, f.params)).why, 'high-chain control')
  assert.equal(landed, 1)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('a wind orbit stops live tracking behind a wall and releases its sight observer after safe landing', async t => {
  const f = orbitWindFixture(2, 0, true), foe: any = f.bot.players.Foe.entity
  for (const key of ['velocity', 'inventory']) Object.defineProperty(foe, key, { get() { throw Error(`private ${key}`) } })
  t.mock.method(flight, 'fly', async (_bot, _ctl, o) => {
    assert.ok(o.goal(), 'the initial visible position is a legal goal')
    f.bot.blockAt = p => ({ name: 'stone', boundingBox: 'block', position: p.floored(), shapes: [[0, 0, 0, 1, 1, 1]] })
    foe.position.x += 12
    assert.equal(o.goal(), null, 'a hidden movement packet cannot move the flight goal')
    assert.equal(o.until(), 'цели не видно')
    return { why: o.until() }
  })
  let landed = 0
  t.mock.method(flight, 'land', async (_b, ctl, o) => { landed++; assert.equal(ctl, f.ctl); assert.equal(o.away, null); return { ok: true } })
  const r = await wingOrbit(f.session, f.ctl, f.params)
  assert.equal(r.why, 'цели не видно')
  assert.equal(landed, 1)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(foe.listenerCount('ndPositionObserved'), 0)
})

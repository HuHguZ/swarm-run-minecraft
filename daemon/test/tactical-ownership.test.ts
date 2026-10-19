import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import lock = require('../src/reflex-lock')
import { Autopilot } from '../src/autopilot'
import { TacticalSystem, observeTactics } from '../src/tactics/minecraft'
import { threatLevel } from '../src/tactics/state'
import { Vec3 } from 'vec3'

function fixture() {
  const writes: string[] = []
  const bot: any = new EventEmitter()
  bot.inventory = { slots: [], items: () => [] }
  bot.pathfinder = { setGoal: () => {}, setMovements: () => {}, stop: () => {} }
  bot.clearControlStates = () => {}
  bot.attack = () => writes.push('attack')
  bot.lookAt = async () => { writes.push('look') }
  const session: any = { bot, current: null, reflex: null }
  return { session, bot, writes }
}

function observingFixture() {
  const f = fixture()
  f.bot.version = '1.21.11'
  f.bot.health = 20; f.bot.food = 20
  f.bot.inventory.items = () => [{ name: 'bread', count: 8 }, { name: 'iron_sword', count: 1 }]
  f.bot.registry = { foodsByName: { bread: { foodPoints: 5, saturation: 6 } }, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
  f.bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [], yaw: 0, pitch: 0 }
  f.bot.entities = {}
  f.bot.game = { dimension: 'overworld', gameMode: 'survival' }
  f.bot.blockAt = (p: any) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty',
    position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  f.session.bus = { emit: () => {} }
  return f
}

test('injury observations expire on a dimension transfer or protected preparation but retain fresh damage in the new world', () => {
  const { session, bot } = observingFixture()
  bot._client = new EventEmitter()
  session.autopilot = new Autopilot(session, {})
  session.autopilot.hookDamage(bot)
  bot.entities[2] = { id: 2, name: 'spider' }
  bot._client.emit('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 3 })
  assert.equal(session.autopilot.lastHurt.dimension, 'overworld')
  assert.equal(observeTactics(session).contact, true)
  assert.equal(observeTactics(session).canFight, false, 'the injury packet does not invent an attackable entity')
  bot.game.dimension = 'the_nether'; bot.entities = {}
  bot.emit('respawn')
  assert.equal(session.autopilot.lastHurt, null)
  assert.equal(observeTactics(session).contact, false)
  bot.entities[3] = { id: 3, name: 'skeleton' }
  bot._client.emit('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 4 })
  assert.equal(session.autopilot.lastHurt.dimension, 'the_nether')
  assert.equal(observeTactics(session).contact, true)
  bot.game.gameMode = 'creative'
  assert.equal(observeTactics(session), null)
  assert.equal(session.autopilot.lastHurt, null)
  bot.game.gameMode = 'survival'; bot.entities = {}
  assert.equal(observeTactics(session).contact, false)
})

test('a server-mounted dry boat supersedes stale player lava and falling flags, while a lava boat remains hazardous', () => {
  const { session, bot } = observingFixture()
  const player = bot.entity.position.clone()
  bot.entity.onGround = false; bot.entity.isInLava = true
  bot._ndClutch = { lastDecision: { action: 'water' } }
  const boat = { id: 8, name: 'oak_boat', position: new Vec3(.5, 67, .5), isValid: true }
  bot.vehicle = boat; bot.entities[8] = boat
  bot.blockAt = (p: any) => ({ position: p.floored(), name: p.y < 67 ? 'stone' : 'air',
    boundingBox: p.y < 67 ? 'block' : 'empty', shapes: p.y < 67 ? [[0, 0, 0, 1, 1, 1]] : [] })
  const dry = observeTactics(session)
  assert.equal(dry.lava, false)
  assert.equal(dry.dangerousFall, false)
  assert.equal(dry.airborne, false)
  assert.deepEqual(bot.entity.position, player, 'observing a passenger does not simulate a player teleport')
  bot.blockAt = (p: any) => ({ position: p.floored(), name: 'lava', boundingBox: 'empty', shapes: [] })
  assert.equal(observeTactics(session).lava, true)
  assert.equal(threatLevel(observeTactics(session)), 4)
})

test('a matching planned jump prevents pre-lava takeover without hiding damage or actual lava contact', () => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const timer = new clock.GameClock({ manual: true, epoch: 0 }); clock.activate(timer)
  const { session, bot } = observingFixture()
  session.current = { name: 'parkour' }
  bot.entity.position.y = 65; bot.entity.onGround = false; bot.entity.velocity = new Vec3(0, -.2, 0)
  bot._ndClutch = { lastDecision: { action: 'none', why: 'no_blocks' }, forecast: {
    at: 0, from: bot.entity.position.clone(), landing: { lava: true, top: 60 }, ground: false, excluded: false } }
  bot._ndParkourForecast = { from: bot.entity.position.clone(), next: bot.entity.position.offset(0, -.2, 0), until: 100, hp: 20 }
  try {
    const planned = observeTactics(session)
    assert.equal(planned.lavaAhead, false); assert.equal(threatLevel(planned), 0)
    bot.health = 19
    assert.equal(observeTactics(session).lavaAhead, true, 'damage revokes the planned-jump exemption before controller cleanup')
    assert.equal(threatLevel(observeTactics(session)), 4)
    bot.health = 20; bot.entity.isInLava = true
    const contact = observeTactics(session)
    assert.equal(contact.lava, true, 'an actual lava contact remains an emergency even beside a fresh plan endpoint')
    assert.equal(threatLevel(contact), 4)
  } finally { timer.dispose(); clock.activate(null) }
})

test('a fire-resistant body can repel a visible nearby attacker in lava with a usable weapon', () => {
  const { session, bot } = observingFixture()
  bot.health = 4
  bot.game.dimension = 'the_nether'
  bot.entity.isInLava = true
  bot.registry.effectsByName.fire_resistance = { id: 12 }
  bot.entity.effects[12] = { amplifier: 0, duration: 400 }
  const enemy = { id: 2, name: 'skeleton', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6, equipment: [], metadata: [] }
  bot.entities[2] = enemy
  assert.equal(observeTactics(session).canFight, true)
  delete bot.entity.effects[12]
  assert.equal(observeTactics(session).canFight, false, 'unresisted lava remains an escape emergency')
  bot.entity.effects[12] = { amplifier: 0, duration: 400 }
  enemy.position = new Vec3(4, 64, .5)
  assert.equal(observeTactics(session).canFight, false, 'the body does not chase an archer in lava')
  enemy.position = new Vec3(2.5, 64, .5)
  bot.inventory.items = () => [{ name: 'iron_sword', count: 1, maxDurability: 250, durabilityUsed: 247 }]
  assert.equal(observeTactics(session).canFight, false, 'a broken weapon cannot enable repel')
  bot.inventory.items = () => [{ name: 'iron_sword', count: 1 }]
  const blockAt = bot.blockAt
  bot.blockAt = (p: any) => Math.floor(p.x) === 1 && p.y >= 64 && p.y < 66
    ? { name: 'stone', boundingBox: 'block', position: p.floored(), shapes: [[0, 0, 0, 1, 1, 1]] } : blockAt(p)
  assert.equal(observeTactics(session).canFight, false, 'repel preserves honest line of sight')
})

test('lava rescue skips refuge geometry which is unavailable in the active graph', () => {
  const { session, bot } = observingFixture()
  const survival: typeof import('../src/survival') = require('../src/survival')
  const original = survival.refugeLook
  let calls = 0
  bot.health = 8; bot.entity.isInLava = true
  bot.entities[2] = { id: 2, name: 'skeleton', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6, equipment: [], metadata: [] }
  survival.refugeLook = () => { calls++; return null }
  try {
    observeTactics(session)
    assert.equal(calls, 0)
    bot.entity.isInLava = false
    observeTactics(session)
    assert.equal(calls, 1, 'ordinary combat retains shelter planning')
  } finally { survival.refugeLook = original }
})

test('a selected lava repel invokes bounded combat before the Nether guard', async () => {
  const { session, bot } = observingFixture()
  bot.game.dimension = 'the_nether'; bot.health = 4; bot.entity.isInLava = true
  bot.registry.effectsByName.fire_resistance = { id: 12 }
  bot.entity.effects[12] = { amplifier: 0, duration: 400 }
  bot.entities[2] = { id: 2, name: 'skeleton', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6, equipment: [], metadata: [] }
  const combat: typeof import('../src/combat') = require('../src/combat')
  const guard: typeof import('../src/ne-guard/react') = require('../src/ne-guard/react')
  const originalFight = combat.fight; const originalReact = guard.react
  const calls: Array<Record<string, unknown>> = []
  combat.fight = async (_session: unknown, _ctl: unknown, options: Record<string, unknown>) => { calls.push(options); return { swings: 1 } }
  guard.react = async () => { throw new Error('legacy guard must not replace lava repel') }
  try {
    const system: any = new TacticalSystem(session)
    const ctl = { aborted: false, onAbort: [], abort() { this.aborted = true } }
    await system.execute({ id: 'Fight', owner: 'Tactical', score: 151, cost: 1, risk: .1 }, ctl, observeTactics(session))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].target, '#2')
    assert.equal(calls[0].repelLava, true)
    assert.equal(calls[0].timeoutSeconds, 4)
    assert.equal(calls[0].purpose, 'defense')
  } finally { combat.fight = originalFight; guard.react = originalReact }
})

test('a Nether refuge choice reaches the refuge executor instead of the guard melee/tower policy (sr-m-3)', async () => {
  const { session, bot } = observingFixture()
  bot.game.dimension = 'the_nether'; bot.health = 10
  bot.entities[2] = { id: 2, name: 'blaze', position: new Vec3(10.5, 64, .5), height: 1.8, width: .6, equipment: [], metadata: [] }
  const survival: typeof import('../src/survival') = require('../src/survival')
  const guard: typeof import('../src/ne-guard/react') = require('../src/ne-guard/react')
  const originalRefuge = survival.refuge; const originalReact = guard.react
  const calls: Array<Record<string, unknown>> = []
  survival.refuge = async (_session: unknown, _ctl: unknown, options: Record<string, unknown>) => { calls.push(options); return { healed: true } }
  guard.react = async () => { throw new Error('a distant blaze is no melee refuge') }
  try {
    const system: any = new TacticalSystem(session)
    const ctl = { aborted: false, onAbort: [], abort() { this.aborted = true } }
    const state = observeTactics(session)
    // Heal already used refuge; keep that contract while removing the four Nether overrides.
    for (const id of ['BlockOff', 'PillarUp', 'DigDown', 'Hide', 'Heal']) {
      assert.equal((await system.execute({ id, score: 120, reason: 'available refuge' }, ctl, state)).healed, true)
    }
    assert.equal(calls.length, 5)
    assert.deepEqual(calls.map(options => options.why), ['tactical BlockOff', 'tactical PillarUp', 'tactical DigDown', 'tactical Hide', 'tactical Heal'])
  } finally { survival.refuge = originalRefuge; guard.react = originalReact }
})

test('a visible attacker preempts an active fire-resistant climb without losing its shore goal', async () => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock')
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  const { session, bot } = observingFixture()
  bot.entity.isInLava = true
  bot.registry.effectsByName.fire_resistance = { id: 12 }
  bot.entity.effects[12] = { amplifier: 0, duration: 400 }
  const goal = { at: new Vec3(.5, 68, .5), deadline: 12000, startY: 64, placed: 1 }
  session._tacticalLavaClimbGoal = goal
  const system: any = new TacticalSystem(session)
  session.tactics = system
  const calls: string[] = []
  let climbAborted = false
  system.execute = (action: { id: string }, ctl: { onAbort: Array<() => void> }) => {
    calls.push(action.id)
    return new Promise(resolve => ctl.onAbort.push(() => { if (action.id === 'ClimbOut') climbAborted = true; resolve({ cancelled: true }) }))
  }
  try {
    system.attach(bot); system.update(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(lock.owner(session)?.source, 'ClimbOut')
    bot.entities[2] = { id: 2, name: 'skeleton', position: new Vec3(2.5, 64, .5), height: 1.8, width: .6, equipment: [], metadata: [] }
    c.advanceTicks(8); system.update(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ['ClimbOut', 'Fight'])
    assert.equal(climbAborted, true)
    assert.equal(lock.owner(session)?.source, 'Fight')
    assert.equal(session._tacticalLavaClimbGoal, goal)
  } finally { system.detach(); c.dispose() }
})

test('aerial hand arming does not claim Emergency, but an actual fall lease and clutch still do', async () => {
  const { session, bot } = observingFixture()
  bot.entity.onGround = false
  bot._ndHandLock = { on: () => true }
  bot._ndAerialRecovering = () => true
  session.current = { name: 'fight' }
  const armed = observeTactics(session)
  assert.equal(armed.emergencyController, false)
  assert.equal(armed.aerialCombat, true)
  assert.equal(armed.protectedEncounter, true)
  assert.equal(threatLevel(armed), 0)
  lock.emergency(session, () => {}, 0)
  assert.equal(observeTactics(session).emergencyController, true)
  assert.equal(threatLevel(observeTactics(session)), 4)
  lock.cancel(session)
  await session.reflex
  bot._ndClutch = { lastDecision: { action: 'water' } }
  assert.equal(threatLevel(observeTactics(session)), 4, 'actual clutch danger retains its Emergency priority')
})

test('only the live intended Enderman boat encounter is protected from minor tactical takeover', () => {
  const { session, bot } = observingFixture()
  const enderman = { id: 2, name: 'enderman', position: new Vec3(.5, 64, 2.5), height: 2.9, equipment: [], metadata: [] }
  bot.entities[2] = enderman
  bot.entities[3] = { id: 3, name: 'oak_boat', position: new Vec3(.5, 64, 3.5) }
  session.current = { name: 'pearls', target: '#2' }
  const encounter = { targetId: 2, boatId: 3, expiresAt: Date.now() + 10000, safe: () => true }
  bot._ndEndermanBoatEncounter = encounter
  assert.equal(observeTactics(session).protectedEncounter, true)
  bot.entities[4] = { id: 4, name: 'zombie', position: new Vec3(2.5, 64, .5), height: 1.8, equipment: [], metadata: [] }
  assert.equal(observeTactics(session).protectedEncounter, false)
  delete bot.entities[4]
  encounter.expiresAt = 0
  assert.equal(observeTactics(session).protectedEncounter, false)
  encounter.expiresAt = Date.now() + 10000
  delete bot.entities[3]
  assert.equal(observeTactics(session).protectedEncounter, false)
  bot.entities[3] = { id: 3, name: 'oak_boat', position: new Vec3(.5, 64, 3.5) }
  bot.health = 3
  assert.equal(threatLevel(observeTactics(session)), 3, 'critical health still preempts the encounter')
})

test('enemy disappearance preserves the completed LastStand result before strategic release', async () => {
  const { session, bot } = observingFixture()
  bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(.5, 64, 2.5), height: 1.8, width: .6, equipment: [], metadata: [] }
  const combat: typeof import('../src/combat') = require('../src/combat')
  const previous = combat.fight
  const events: any[] = []
  let complete!: (result: any) => void
  combat.fight = () => new Promise(resolve => { complete = resolve })
  session.bus.emit = (type: string, detail: any) => events.push({ type, ...detail })
  const tactics: any = session.tactics = new TacticalSystem(session)
  try {
    tactics.attach(bot)
    const state = observeTactics(session)
    tactics.begin({ id: 'LastStand', score: 155, reason: 'corner' }, [], state, 3)
    await new Promise<void>(resolve => setImmediate(resolve))
    delete bot.entities[2]
    tactics.update(true)
    assert.equal(tactics.snapshot().action, 'LastStand')
    assert.ok(!events.some(event => event.type === 'tactical_finished'))
    complete({ swings: 3, landed: 2, killed: 'zombie', lastStand: true })
    await tactics.waitForRelease()
    const ended = events.find(event => event.type === 'tactical_finished')
    assert.equal(ended.result, 'completed')
    assert.equal(ended.detail.landed, 2)
    assert.equal(ended.detail.killed, 'zombie')
    assert.equal(tactics.snapshot().action, null)
  } finally { combat.fight = previous; tactics.detach() }
})

test('bounded cover and combat complete before weaker contact selects Shield or releases the hands', async () => {
  for (const action of ['BlockOff', 'PillarUp', 'DigDown', 'Hide', 'Fight', 'LastStand']) for (const visible of [true, false]) {
    const { session, bot } = observingFixture()
    const events: any[] = []
    bot.inventory.slots[45] = { name: 'shield' }
    if (visible) bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(.5, 64, 5.5), height: 1.8, width: .6, equipment: [], metadata: [] }
    session.bus.emit = (type: string, detail: any) => events.push({ type, ...detail })
    const tactics: any = session.tactics = new TacticalSystem(session)
    const completions: Array<(result: any) => void> = []
    tactics.execute = () => new Promise(resolve => { completions.push(resolve) })
    try {
      tactics.attach(bot)
      tactics.begin({ id: action, score: 95, reason: 'bounded pending defense' }, [], observeTactics(session), 2)
      await new Promise<void>(resolve => setImmediate(resolve))
      tactics.update(true)
      assert.equal(tactics.snapshot().action, action, `${action}: weaker contact cannot cancel the pending executor`)
      assert.ok(!events.some(event => event.type === 'tactical_finished'))
      completions[0]({ acted: true, box: { ok: true } })
      await tactics.waitForRelease()
      assert.equal(events.find(event => event.type === 'tactical_finished').result, 'completed')
      assert.equal(tactics.snapshot().action, null)
      if (visible) {
        tactics.update(true)
        assert.equal(tactics.snapshot().action, null, 'a zombie five blocks away supplies no imminent block; the completed executor still released its hands')
      }
    } finally { for (const complete of completions) complete({ cancelled: true }); tactics.detach() }
  }
})

test('a native fall cancels pending cover immediately despite its completion protection', async () => {
  const { session, bot } = observingFixture()
  const tactics: any = session.tactics = new TacticalSystem(session)
  let worker: any
  let complete!: () => void
  tactics.execute = (action: any, ctl: any) => { worker = ctl; return new Promise<void>(resolve => { complete = resolve }) }
  try {
    tactics.attach(bot)
    tactics.begin({ id: 'BlockOff', score: 95, reason: 'bounded pending defense' }, [], observeTactics(session), 2)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(worker.aborted, false)
    bot.entity.onGround = false
    bot._ndClutch = { lastDecision: { action: 'water' } }
    tactics.update(true)
    assert.equal(tactics.snapshot().threatLevel, 4)
    assert.equal(worker.aborted, true, 'the existing fall Emergency has immediate priority')
  } finally { complete(); tactics.detach() }
})

test('an external Emergency takeover records interruption before a cancelled tactical worker settles', async () => {
  const { session, bot } = observingFixture()
  bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(.5, 64, 2.5), height: 1.8, width: .6, equipment: [], metadata: [] }
  const combat: typeof import('../src/combat') = require('../src/combat')
  const previous = combat.fight
  const events: any[] = []
  let complete!: () => void
  let release!: () => void
  combat.fight = () => new Promise<void>(resolve => { complete = resolve })
  session.bus.emit = (type: string, detail: any) => events.push({ type, ...detail })
  const tactics: any = session.tactics = new TacticalSystem(session)
  try {
    tactics.attach(bot)
    tactics.begin({ id: 'Fight', score: 90, reason: 'contact' }, [], observeTactics(session), 2)
    await new Promise<void>(resolve => setImmediate(resolve))
    const rescue = lock.start(session, () => new Promise<void>(resolve => { release = resolve }), { source: 'fall-controller', owner: 'Emergency', priority: 3, preempt: true })
    await new Promise<void>(resolve => setImmediate(resolve))
    const ended = events.find(event => event.type === 'tactical_finished')
    assert.equal(ended.result, 'interrupted')
    assert.equal(ended.detail.cancelled, true)
    assert.equal(lock.owner(session).source, 'fall-controller')
    release(); await rescue
    complete()
  } finally { combat.fight = previous; tactics.detach() }
})

test('a selected fight never calls combat when its observed target vanished before act', async () => {
  const { session, bot } = observingFixture()
  bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(.5, 64, 2.5), height: 1.8, width: .6, equipment: [], metadata: [] }
  const state = observeTactics(session)
  assert.equal(state.enemies[0].id, 2)
  delete bot.entities[2]
  const combat: typeof import('../src/combat') = require('../src/combat')
  const previous = combat.fight
  let fights = 0
  combat.fight = async () => { fights++ }
  try {
    const tactics: any = new TacticalSystem(session)
    const result = await tactics.execute({ id: 'Fight', score: 90, reason: 'contact' }, { aborted: false, onAbort: [] }, state)
    assert.equal(result.unavailable, true)
    assert.equal(fights, 0)
  } finally { combat.fight = previous }
})

test('calm observation keeps an unfinished recovery lease until its executor confirms completion', async () => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock'), timer = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  try {
  for (const action of ['Eat', 'Heal']) {
    const { session, bot } = observingFixture()
    let state = { ...observeTactics(session), health: 12, food: 10, burning: action === 'Eat', cover: action === 'Heal',
      contact: action === 'Heal', canFight: false, enemies: [] }
    let complete!: (value: any) => void, aborted = false
    const system = new TacticalSystem(session, { observe: () => ({ ...state, at: clock.now() }), record: () => {},
      execute: (_action: any, ctl: any) => new Promise(resolve => {
        complete = resolve
        ctl.onAbort.push(() => { aborted = true; resolve({ cancelled: true }) })
      }) })
    try {
      system.attach(bot); system.update(true)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(lock.owner(session)?.source, action)
      state = { ...state, health: 16, food: 20, burning: false, cover: false, contact: false }
      system.update(true)
      timer.advanceTicks(1200); system.update(true)
      assert.equal(lock.owner(session)?.source, action, `${action}: level 0 is not the pending operation's receipt`)
      assert.equal(aborted, false)
      complete({ confirmed: true }); await system.waitForRelease()
      assert.equal(lock.owner(session), null)
      assert.equal(system.snapshot().requireObservation, true)
    } finally { system.detach() }
  }
  } finally { timer.dispose(); clock.activate(null) }
})

async function unreachablePiglin(action = 'Fight', configure = (_f: any) => {}) {
  const f = observingFixture(), guard: typeof import('../src/ne-guard/react') = require('../src/ne-guard/react'), combat: typeof import('../src/combat') = require('../src/combat')
  f.bot.game.dimension = 'the_nether'
  configure(f)
  f.bot.registry.entitiesByName.piglin = { metadataKeys: ['mob_flags'] }
  const piglin = f.bot.entities[2] = { id: 2, name: 'piglin', position: new Vec3(7.5, 64, .5), height: 1.95, width: .6,
    isValid: true, metadata: [4], equipment: [{ name: 'crossbow' }] }
  const state = observeTactics(f.session)
  assert.ok(state.enemies.some(enemy => enemy.id === 2 && enemy.threatening))
  const react = guard.react, fight = combat.fight
  guard.react = async () => ({ duel: { stopped: 'не достать', swings: 0 } })
  combat.fight = async () => ({ swings: 0, kills: [] })
  try {
    await (new TacticalSystem(f.session) as any).execute({ id: action, score: 90, reason: 'contact' }, { aborted: false, onAbort: [] }, state)
  } finally { guard.react = react; combat.fight = fight }
  return { ...f, piglin, threatening: () => observeTactics(f.session).enemies.some(enemy => enemy.id === 2 && enemy.threatening) }
}

test('a confirmed unreachable duel is not retried by elapsed time, for Fight and LastStand', async () => {
  const clock: typeof import('../src/game-clock') = require('../src/game-clock'), timer = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  try {
    for (const action of ['Fight', 'LastStand']) {
      const f = await unreachablePiglin(action)
      assert.equal(f.threatening(), false)
      timer.advanceTicks(1200)
      assert.equal(f.threatening(), false, `${action}: an unchanged gap is still a gap after a minute`)
    }
  } finally { timer.dispose(); clock.activate(null) }
})

test('unreachable contact reopens immediately on a changed stance, target cell, route or weapon', async () => {
  const mutations = [
    (f: any) => { f.bot.entity.position.x += 1 },
    (f: any) => { f.piglin.position.z += 1 },
    (f: any) => { const read = f.bot.blockAt; f.bot.blockAt = (p: any) => p.x === 1 && p.y === 63 && p.z === 0
      ? { name: 'air', boundingBox: 'empty', position: p.floored(), shapes: [] } : read(p) },
    (f: any) => { f.bot.inventory.items = () => [{ name: 'diamond_sword', count: 1 }] }
  ]
  for (const mutate of mutations) {
    const f = await unreachablePiglin()
    assert.equal(f.threatening(), false)
    mutate(f)
    assert.equal(f.threatening(), true, mutate.toString())
  }
})

test('unrelated inventory and health changes do not repair an unreachable contact', async () => {
  const f = await unreachablePiglin(), items = f.bot.inventory.items()
  f.bot.health = 19
  f.bot.inventory.items = () => [...items, { name: 'arrow', count: 12 }]
  assert.equal(f.threatening(), false)
  f.piglin.position.x = 3.5
  assert.equal(f.threatening(), true, 'arrival at contact range is an immediate exit from the failed path')
})

test('changed collision reopens the route with the same block name; unrelated block state does not', async () => {
  let open = false, unrelated = false
  const f = await unreachablePiglin('Fight', ({ bot }) => {
    const read = bot.blockAt
    bot.blockAt = (p: any) => p.x === 1 && p.y === 63 && p.z === 0
      ? { name: 'oak_trapdoor', stateId: open ? 2 : unrelated ? 3 : 1, boundingBox: open ? 'empty' : 'block', position: p.floored(), shapes: open ? [] : [[0, 0, 0, 1, 1, 1]] }
      : read(p)
  })
  assert.equal(f.threatening(), false)
  unrelated = true
  assert.equal(f.threatening(), false, 'only collision, not every stateId change, can repair this route')
  open = true
  assert.equal(f.threatening(), true)
})

test('a reused entity id and a dimension transfer cannot inherit another unreachable encounter', async () => {
  for (const replace of [true, false]) {
    const f = await unreachablePiglin()
    assert.equal(f.threatening(), false)
    if (replace) f.bot.entities[2] = { ...f.piglin, position: f.piglin.position.clone() }
    else {
      f.bot.game.dimension = 'overworld'
      f.session.autopilot = { lastHurt: { at: (require('../src/game-clock') as typeof import('../src/game-clock')).now(), dimension: 'overworld', sourceId: 2, byMob: true, type: 'mob_attack' } }
    }
    assert.equal(f.threatening(), true)
  }
})

test('a fresh attacker behind a wall remains an injury contact but is not an observed combat target', () => {
  const { session, bot } = observingFixture()
  bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(.5, 64, 2.5), height: 1.8, width: .6, equipment: [], metadata: [] }
  session.autopilot = { lastHurt: { at: Date.now(), byMob: true, dimension: 'overworld' } }
  const nativeBlockAt = bot.blockAt
  bot.blockAt = (point: any) => point.z === 1 && point.y >= 64 && point.y <= 66
    ? { name: 'stone', boundingBox: 'block', position: point.floored(), shapes: [[0, 0, 0, 1, 1, 1]] }
    : nativeBlockAt(point)
  const state = observeTactics(session)
  assert.equal(state.contact, true)
  assert.equal(state.canFight, false)
  assert.deepEqual(state.enemies, [])
})

test('one control lease cancels old tactical continuations before emergency takes over', async () => {
  const { session, bot, writes } = fixture()
  let resume!: () => void
  let oldCtl: any
  const old = lock.start(session, async (ctl: any) => {
    oldCtl = ctl
    await new Promise<void>(resolve => { resume = resolve })
    bot.attack()
  }, { owner: 'Tactical', priority: 2 })
  await Promise.resolve()
  assert.equal(lock.owner(session).owner, 'Tactical')
  const emergency = lock.start(session, async () => { bot.attack() }, { owner: 'Emergency', priority: 3, preempt: true })
  assert.equal(oldCtl.aborted, true)
  assert.equal(lock.owner(session).owner, 'Emergency')
  resume()
  await Promise.all([old, emergency])
  await Promise.resolve()
  assert.deepEqual(writes, ['attack'])
  assert.equal(lock.owner(session), null)
})

test('lower priority cannot replace the active emergency controller', async () => {
  const { session } = fixture()
  let release!: () => void
  const emergency = lock.start(session, () => new Promise<void>(resolve => { release = resolve }), { owner: 'Emergency', priority: 3 })
  await Promise.resolve()
  let ran = false
  const denied = lock.start(session, () => { ran = true }, { owner: 'Tactical', priority: 2, preempt: true })
  assert.equal(denied, emergency)
  assert.equal(ran, false)
  release()
  await emergency
})

test('creative preparation cancels the active rescue lease and fences its late controls without aborting an unrelated skill', async () => {
  const { session, bot, writes } = observingFixture()
  let resume!: () => void
  let oldCtl: any
  const skill = { aborted: false, abort() { this.aborted = true } }
  session.current = { name: 'map', ctl: skill }
  bot.setControlState = () => writes.push('control')
  const tactics: any = session.tactics = new TacticalSystem(session)
  tactics.attach(bot)
  const old = lock.start(session, async (ctl: any) => {
    oldCtl = ctl
    await new Promise<void>(resolve => { resume = resolve })
    bot.attack()
    bot.setControlState('forward', true)
  }, { source: 'ClimbOut', owner: 'Emergency', priority: 3 })
  try {
    await Promise.resolve()
    const lease = lock.owner(session)
    assert.equal(lease.ctl, oldCtl)
    tactics.substantive = true
    bot.game.gameMode = 'creative'
    tactics.update(true)
    assert.equal(oldCtl.aborted, true)
    assert.equal(lock.owner(session), null)
    assert.equal(tactics.snapshot().state, null)
    assert.equal(skill.aborted, false, 'unavailable observation cancels the rescue, not the current mapping intent')
    resume(); await old; await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(writes, [], 'the old rescue cannot attack or move after creative setup has acquired control')
    bot.game.gameMode = 'survival'
    tactics.update(true)
    assert.ok(tactics.snapshot().state, 'normal observation resumes in survival')
  } finally { tactics.detach() }
})

test('cancelled native flight and boat continuations cannot send control packets after emergency takeover', async () => {
  const { session, bot } = fixture()
  const packets: string[] = []
  bot._client = new EventEmitter()
  bot._client.write = (name: string) => packets.push(name)
  bot.mount = () => bot._client.write('use_entity')
  let resume!: () => void
  const old = lock.start(session, async () => {
    await new Promise<void>(resolve => { resume = resolve })
    bot._client.write('client_command', { actionId: 8 })
    bot._client.write('block_place', {})
    bot._client.write('vehicle_move', {})
    bot.mount()
  }, { owner: 'Tactical', priority: 2 })
  await Promise.resolve()
  const rescue = lock.start(session, () => { bot._client.write('use_item', {}) }, { owner: 'Emergency', priority: 3, preempt: true })
  resume()
  await Promise.all([old, rescue])
  assert.deepEqual(packets, ['use_item'])
})

test('emergency hand callback runs synchronously with the same lease', async () => {
  const { session, bot, writes } = fixture()
  const value = lock.emergency(session, () => { bot.attack(); return 7 }, 0)
  assert.equal(value, 7)
  assert.equal(lock.owner(session).owner, 'Emergency')
  assert.deepEqual(writes, ['attack'])
  lock.cancel(session)
  await session.reflex
  assert.equal(lock.owner(session), null)
})

test('an asynchronous emergency keeps one lease until aim and nested use settle', async () => {
  const { session, bot, writes } = fixture()
  let aimed!: () => void
  const work = lock.emergency(session, async () => {
    await new Promise<void>(resolve => { aimed = resolve })
    return lock.emergency(session, () => { bot.attack(); return 9 }, 0)
  }, 0)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(lock.owner(session).owner, 'Emergency')
  assert.deepEqual(writes, [])
  aimed()
  assert.equal(await work, 9)
  await session.reflex
  assert.deepEqual(writes, ['attack'])
  assert.equal(lock.owner(session), null)
})

for (const { delay, blocked } of [{ delay: 0, blocked: false }, { delay: 2600, blocked: false }, { delay: 0, blocked: true }]) {
test(blocked ? 'unbreakable embedding emits tactical failure without reporting release' : `embedded pearl arrival survives ${delay}ms dig latency, preempts the skill and verifies release`, async () => {
  const { session, bot } = fixture()
  let embedded = true
  let dug = 0
  const events: any[] = []
  bot.version = '1.21.11'
  bot.health = 20
  bot.food = 20
  bot.inventory.items = () => [{ name: 'bread', count: 8 }]
  bot.registry = { foodsByName: { bread: { foodPoints: 5, saturation: 6 } }, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
  bot.entity = { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true, effects: {}, metadata: [] }
  bot.entities = {}
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot._client = new EventEmitter()
  bot.blockAt = (position: any) => {
    const head = embedded && Math.floor(position.y) === 65
    const floor = Math.floor(position.y) < 64
    return { name: head ? blocked ? 'bedrock' : 'dirt' : floor ? 'stone' : 'air', boundingBox: head || floor ? 'block' : 'empty',
      position: position.floored(), shapes: head || floor ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  bot.dig = async (block: any) => {
    assert.equal(block.name, 'dirt')
    if (delay) await new Promise<void>(resolve => setTimeout(resolve, delay))
    dug++; embedded = false
  }
  bot.stopDigging = () => {}
  session.bus = { emit: (type: string, payload: any) => events.push({ type, ...payload }) }
  session.cfg = { lowHealth: 8 }
  session.journal = { append: () => {} }
  session.current = { name: 'fight', ctl: { aborted: false, abort() { this.aborted = true } } }
  const current = session.current
  session.autopilot = new Autopilot(session, session.cfg)
  session.tactics = new TacticalSystem(session)
  session.tactics.attach(bot)
  bot.emit('forcedMove')
  assert.equal(current.ctl.aborted, true)
  assert.equal(session.tactics.snapshot().action, 'FreeEmbedded')
  assert.equal(session.tactics.snapshot().state.edible, true, 'inventory food is observed using the Mineflayer data registry')
  assert.equal(lock.owner(session).owner, 'Emergency')
  const ticks = setInterval(() => session.tactics.update(true), 50)
  try { await session.tactics.waitForRelease() } finally { clearInterval(ticks) }
  if (blocked) {
    assert.equal(dug, 0)
    assert.equal(embedded, true)
    assert.ok(events.some(event => event.type === 'tactical_failed' && /бедрок/.test(event.reason)))
    assert.ok(!events.some(event => event.type === 'freed' || event.type === 'tactical_released'))
    assert.equal(session.replanRevision ?? 0, 0)
    session.tactics.detach()
    return
  }
  session.tactics.update(true)
  assert.equal(dug, 1)
  assert.equal(embedded, false)
  assert.ok(events.some(event => event.type === 'freed'))
  assert.equal(session.replanRevision, 1)
  session.tactics.detach()
})
}


test('neP-1: contact with lava supersedes a stale fall-controller observation', () => {
  const { session, bot } = observingFixture()
  bot.game.dimension = 'the_nether'; bot.entity.onGround = false; bot.entity.isInLava = true
  bot._ndClutch = { lastDecision: { action: 'clutch' } }; bot._ndFallGuard = { placed: true }
  const state = observeTactics(session)
  assert.equal(state.lava, true)
  assert.equal(state.dangerousFall, false)
  assert.equal(state.emergencyController, false)
  const { TacticalArbiter }: typeof import('../src/tactics/arbiter') = require('../src/tactics/arbiter')
  assert.equal(new TacticalArbiter().decide(state).selected?.id, 'Flee')
})

test('lava escape can take the obsolete fall lease without waiting for its watchdog', async () => {
  const { session, bot } = observingFixture()
  const tactics: any = session.tactics = new TacticalSystem(session)
  tactics.attach(bot)
  let fallCtl: any, release: (() => void) | undefined
  const actions: string[] = []
  const pending = lock.start(session, ctl => { fallCtl = ctl; return new Promise<void>(r => { release = r }) },
    { source: 'fall-controller', owner: 'Emergency', priority: 3 })
  await new Promise<void>(r => setImmediate(r))
  bot.game.dimension = 'the_nether'; bot.entity.onGround = false; bot.entity.isInLava = true
  bot._ndClutch = { lastDecision: { action: 'clutch' } }
  tactics.execute = async action => { actions.push(action.id); return { safe: true } }
  try {
    tactics.update(true)
    await new Promise<void>(r => setImmediate(r))
    assert.equal(fallCtl.aborted, true)
    assert.equal(actions[0], 'Flee')
  } finally { release?.(); lock.cancel(session); await pending; tactics.detach() }
})

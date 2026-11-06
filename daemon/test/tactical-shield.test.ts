import { bodySource } from './source-fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as clock from '../src/game-clock'
import * as esbuild from 'esbuild'

function sourceModule(name: string, overrides: Record<string, unknown> = {}, expose = '') {
  const file = path.resolve(__dirname, '../src', name + '.ts')
  const local = createRequire(file)
  const module = { exports: {} as Record<string, any> }
  // tactics/minecraft и ne-guard — фасад и части (tactics/minecraft/, ne-guard/) одной областью (подмены по spec доходят до частей)
  const source = name === 'tactics/minecraft' || name === 'ne-guard' ? bodySource(file) + expose : esbuild.transformSync(readFileSync(file, 'utf8') + expose, { loader: 'ts', format: 'cjs', target: 'node24' }).code
  vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap(source), { filename: file })(module.exports,
    (id: string) => id in overrides ? overrides[id] : local(id), module, file, path.dirname(file))
  return module.exports
}

function actor() {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.version = '1.21.11'; bot.health = 20; bot.food = 20
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, width: .6,
    onGround: true, yaw: 0, pitch: 0, metadata: [], effects: {} }
  const key = bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  const shield = { name: 'shield', type: bot.registry.itemsByName.shield.id, count: 1 }
  const sword = { name: 'iron_sword', type: bot.registry.itemsByName.iron_sword.id, count: 1 }
  bot.inventory = new EventEmitter(); bot.inventory.slots = []; bot.inventory.slots[45] = shield
  bot.inventory.items = () => [sword]
  bot.heldItem = sword; bot.quickBarSlot = 0
  bot.entities = { 2: { id: 2, name: 'piglin_brute', position: new Vec3(.5, 64, 5.5),
    height: 1.95, width: .6, equipment: [], metadata: [], isValid: true } }
  bot.blockAt = (p: any) => ({ position: p.floored(), name: p.y < 64 ? 'stone' : 'air',
    boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.lookAt = async () => {}
  bot.clearControlStates = () => {}; bot.pathfinder = { setGoal: () => {} }
  const writes: Array<{ hand: boolean; at: number }> = []
  let releases = 0
  bot.activateItem = (off = false) => { writes.push({ hand: off, at: c.ticks }) }
  bot.deactivateItem = () => { releases++; metadata(0) }
  const metadata = (flags: number, id = 1) => {
    if (id === 1) bot.entity.metadata[key] = flags
    bot._client.emit('entity_metadata', { entityId: id, metadata: [{ key, value: flags }] })
  }
  c.attach(bot)
  const age = (n: number) => bot._client.emit('update_time', { age: BigInt(n) })
  age(1000)
  const session: any = { bot, current: null, bus: { emit: () => {} } }
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const fn of this.onAbort) fn() } }
  const bow = sourceModule('bow')
  // makeShield с ленивым require('../bow') живёт в части combat/shield: лук подменяется в ней, она — в combat.
  const shieldPart = sourceModule('combat/shield', { '../bow': bow })
  const combat = sourceModule('combat', { './combat/shield': shieldPart })
  const tactics = sourceModule('tactics/minecraft', { '../combat': combat })
  return { c, bot, session, ctl, key, shield, metadata, age, bow, combat, tactics, writes,
    releases: () => releases, close() { bot.emit('end'); c.dispose() } }
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve))

function nativeItemUse(a) {
  a.bot.setControlState = () => {}; a.bot.getControlState = () => false; a.bot.look = async () => {}
  a.bot.physics = { simulatePlayer: s => s }; a.bot._client.write = () => {}
  const activate = a.bot.activateItem, deactivate = a.bot.deactivateItem
  a.bot.activateItem = off => { activate(off); a.bot.usingHeldItem = true; a.bot._client.write('use_item', { hand: off ? 1 : 0 }) }
  a.bot.deactivateItem = () => { deactivate(); a.bot.usingHeldItem = false; a.bot._client.write('block_dig', { status: 5 }) }
  return (require('../src/itemuse') as typeof import('../src/itemuse')).install(a.bot)
}

function drawingSkeleton(a) {
  const e = a.bot.entities[2]
  e.name = 'skeleton'; e.position = new Vec3(.5, 64, -9.5); e.yaw = Math.PI
  e.equipment = [{ name: 'bow' }]
  e.metadata[a.bot.registry.entitiesByName.skeleton.metadataKeys.indexOf('living_entity_flags')] = 1
  return e
}

for (const shot of ['draw', 'projectile']) test(`passive projectile body keeps goto through ${shot} without another tactical action`, async () => {
  const a = actor()
  const goal = { x: 10, y: 64, z: .5 }, path = [{ x: 1, y: 64, z: .5 }]
  let activeGoal: any = goal
  const actions: string[] = []
  a.bot.pathfinder = { goal, path, setGoal: (value: any) => { activeGoal = value } }
  a.session.current = { name: 'goto', ctl: a.ctl, params: { x: 10, y: 64, z: .5 } }
  a.bot._ndProjectileEvasion = { pressure: true }
  if (shot === 'draw') drawingSkeleton(a)
  else {
    a.bot.game.dimension = 'the_nether'
    a.bot.entities[2].name = 'ghast'; a.bot.entities[2].position = new Vec3(24.5, 64, .5)
    a.bot.entities[3] = { id: 3, name: 'fireball', position: new Vec3(7, 64.9, .5) }
    observeProjectile(a)
  }
  const system = new a.tactics.TacticalSystem(a.session, { record: () => {}, execute: (action: any, ctl: any) => {
    actions.push(action.id)
    return new Promise(resolve => ctl.onAbort.push(() => resolve({ cancelled: true })))
  } })
  try {
    system.attach(a.bot); system.update(true); await turn()
    assert.ok(a.tactics.observeTactics(a.session).protectedEncounter)
    assert.deepEqual(actions, [], 'Shield and its retreat alternatives must not take the body from goto')
    assert.equal(activeGoal, goal); assert.equal(a.bot.pathfinder.path, path)
    assert.equal(a.ctl.aborted, false)
  } finally { system.detach(); a.close() }
})

for (const danger of ['low health', 'melee', 'lava']) test(`passive projectile body leaves ${danger} to native tactics`, async () => {
  const a = actor()
  a.bot._ndProjectileEvasion = { pressure: true }
  a.session.current = { name: 'goto', ctl: a.ctl, params: {} }
  drawingSkeleton(a)
  if (danger === 'low health') a.bot.health = 6
  if (danger === 'melee') a.bot.entities[4] = { id: 4, name: 'zombie', position: new Vec3(.5, 64, 2.5), height: 1.95, width: .6, equipment: [], metadata: [], isValid: true }
  if (danger === 'lava') a.bot.entity.isInLava = true
  const actions: string[] = []
  const system = new a.tactics.TacticalSystem(a.session, { record: () => {}, execute: (action: any, ctl: any) => {
    actions.push(action.id)
    return new Promise(resolve => ctl.onAbort.push(() => resolve({ cancelled: true })))
  } })
  try {
    system.attach(a.bot); system.update(true); await turn()
    assert.equal(a.tactics.observeTactics(a.session).protectedEncounter, false)
    assert.ok(actions.length > 0, 'the projectile layer must not take over the unrelated danger')
  } finally { system.detach(); a.close() }
})

test('native tactics reuses the projectile body draw history instead of clearing its release receipt', () => {
  const a = actor()
  const point = { id: 2, point: new Vec3(.5, 65.6, -9.5), kind: 'unmeasured bow flight' }
  let reads = 0
  a.bot._ndProjectileEvasion = { pressure: true, get guard() { reads++; return point } }
  try {
    const observed = a.tactics.observeTactics(a.session)
    assert.equal(observed.owGuard, point)
    assert.equal(reads, 1)
  } finally { a.close() }
})

test('пассивный слой не оставляет без решения свободного или уже отменённого бота', () => {
  for (const idle of [true, false]) {
    const a = actor()
    a.bot._ndProjectileEvasion = { pressure: true }
    drawingSkeleton(a)
    a.session.current = idle ? null : { name: 'goto', ctl: { aborted: true }, params: {} }
    try { assert.equal(a.tactics.observeTactics(a.session).protectedEncounter, false) } finally { a.close() }
  }
})

test('swarm bow hold keeps one native shield through the draw and its last arrow, then cleans up', async () => {
  const a = actor()
  let pending: Promise<any>, done = false, drawing = true, arrow = false
  const dangers = () => ({ aims: drawing ? [{ name: 'Foe', weapon: 'bow' }] : [], arrows: arrow ? [{ name: 'arrow' }] : [] })
  const work = sourceModule('swarm-position-work', { './combat': a.combat, './threats': { dangers }, './swarm-work': { directThreat: () => null } })
  a.bot.setControlState = () => {}; a.bot.look = async () => {}
  try {
    pending = work.swarmHold(a.session, a.ctl, { shield: true, requireShield: true, whileDraw: 'Foe', seconds: 20 }).then((r: any) => { done = true; return r })
    await turn(); a.metadata(3); a.age(1001)
    for (let tick = 2; tick < 35; tick++) { a.age(1000 + tick); a.c.advanceTicks(1); await turn() }
    assert.equal(done, false, 'neither 300ms reactions nor the native ACK timeout finish the draw')
    assert.equal(a.writes.length, 1, 'one raise, not a fresh use packet every reaction')
    assert.equal(a.releases(), 0)
    drawing = false; arrow = true
    for (let tick = 0; tick < 12; tick++) { a.c.advanceTicks(1); await turn() }
    assert.equal(done, false, 'the last arrow still needs the raised shield')
    arrow = false
    for (let tick = 0; tick < 12 && !done; tick++) { a.c.advanceTicks(1); await turn() }
    assert.equal(done, true)
    const result = await pending
    assert.equal(result.ok, true); assert.equal(result.why, 'completed')
    assert.ok(result.shield.blockingSeconds > 1)
    assert.equal(a.releases(), 1)
    assert.equal(a.ctl.onAbort.length, 0)
  } finally { a.ctl.abort(); if (pending) await pending; a.close() }
})

test('swarm bow hold releases its native shield on cancellation or a new melee threat', async () => {
  for (const why of ['cancelled', 'direct_threat']) {
    const a = actor(); let threat = false, pending: Promise<any>
    const work = sourceModule('swarm-position-work', { './combat': a.combat,
      './threats': { dangers: () => ({ aims: [{ name: 'Foe', weapon: 'bow' }], arrows: [] }) },
      './swarm-work': { directThreat: () => threat ? {} : null } })
    a.bot.setControlState = () => {}; a.bot.look = async () => {}
    try {
      pending = work.swarmHold(a.session, a.ctl, { shield: true, requireShield: true, whileDraw: 'Foe', seconds: 20 })
      await turn(); a.metadata(3); a.age(1001)
      for (let tick = 2; tick < 12; tick++) { a.age(1000 + tick); a.c.advanceTicks(1); await turn() }
      assert.equal(a.releases(), 0)
      if (why === 'cancelled') a.ctl.abort()
      else { threat = true; a.bot.emit('physicsTick') }
      assert.equal((await pending).why, why)
      assert.equal(a.releases(), 1); assert.equal(a.ctl.onAbort.length, 0)
    } finally { a.ctl.abort(); if (pending) await pending; a.close() }
  }
})

test('swarm bow hold returns to another defence immediately when its native shield becomes unavailable', async () => {
  const a = actor(); let done = false, pending: Promise<any>
  const work = sourceModule('swarm-position-work', { './combat': a.combat,
    './threats': { dangers: () => ({ aims: [{ name: 'Foe', weapon: 'bow' }], arrows: [] }) },
    './swarm-work': { directThreat: () => null } })
  a.bot.setControlState = () => {}; a.bot.look = async () => {}
  try {
    pending = work.swarmHold(a.session, a.ctl, { shield: true, requireShield: true, whileDraw: 'Foe', seconds: 20 }).then((r: any) => { done = true; return r })
    await turn(); a.metadata(3); a.age(1001)
    for (let tick = 2; tick < 12; tick++) { a.age(1000 + tick); a.c.advanceTicks(1); await turn() }
    a.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:shield', cooldownTicks: 100 })
    for (let tick = 0; tick < 8 && !done; tick++) { a.c.advanceTicks(1); await turn() }
    assert.equal(done, true, 'no standing under arrows until the twenty-second watchdog')
    assert.equal((await pending).why, 'shield_cooldown', 'the driver must not remember a cooldown as a failed route')
    assert.equal(a.releases(), 1)
  } finally { a.ctl.abort(); if (pending) await pending; a.close() }
})

test('swarm bow hold keeps its facing when the shooter disappears behind cover but his arrow remains', async () => {
  const a = actor(); let drawing = true, arrow = false, pending: Promise<any>, done = false, spins = 0, looks = 0
  const work = sourceModule('swarm-position-work', { './combat': a.combat,
    './threats': { dangers: () => ({ aims: drawing ? [{ name: 'Foe', weapon: 'bow' }] : [], arrows: arrow ? [{ name: 'arrow' }] : [] }) },
    './swarm-work': { directThreat: () => null } })
  a.bot.entities[2] = { ...a.bot.entities[2], name: 'player', type: 'player', username: 'Foe' }
  a.bot.setControlState = () => {}
  a.bot.look = async () => { spins++ }
  a.bot.lookAt = async p => { looks++; a.bot.entity.yaw = Math.atan2(-(p.x - a.bot.entity.position.x), -(p.z - a.bot.entity.position.z)) }
  try {
    pending = work.swarmHold(a.session, a.ctl, { shield: true, requireShield: true, whileDraw: 'Foe', enemies: ['Foe'], seconds: 20 }).then((r: any) => { done = true; return r })
    await turn(); a.metadata(3); a.age(1001)
    for (let tick = 2; tick < 12; tick++) { a.age(1000 + tick); a.c.advanceTicks(1); await turn() }
    assert.ok(looks > 0, 'the shield first faced the visible shooter')
    const yaw = a.bot.entity.yaw
    a.bot.entities = {}; drawing = false; arrow = true
    for (let tick = 0; tick < 12; tick++) { a.c.advanceTicks(1); await turn() }
    assert.equal(done, false); assert.equal(spins, 0)
    assert.equal(a.bot.entity.yaw, yaw, 'the last arrow meets the shield front, not a scanning turn')
  } finally { a.ctl.abort(); if (pending) await pending; a.close() }
})

test('OW visible draw is a shield reason before the first arrow and expires on its actual release', () => {
  const a = actor()
  try {
    const e = drawingSkeleton(a), state = a.tactics.observeTactics(a.session)
    assert.equal(state.owGuard?.id, 2)
    const choices = (require('../src/tactics/state') as typeof import('../src/tactics/state')).candidates(state)
    assert.equal(choices[0].id, 'Shield')
    e.metadata[a.bot.registry.entitiesByName.skeleton.metadataKeys.indexOf('living_entity_flags')] = 0
    assert.equal(a.tactics.observeTactics(a.session).owGuard?.kind, 'unmeasured bow flight')
    a.bot.entity.position.x += 2
    assert.equal(a.tactics.observeTactics(a.session).owGuard, null, 'crossing out of its old firing line ends that uncertainty')
  } finally { a.close() }
})

test('OW confirmed Shield survives the old 600ms completion while a visible bow remains drawn', async () => {
  const a = actor()
  let pending: Promise<any>, done = false
  try {
    const e = drawingSkeleton(a), system = new a.tactics.TacticalSystem(a.session)
    pending = system.execute({ id: 'Shield', score: 110 }, a.ctl, a.tactics.observeTactics(a.session)).then((r: any) => { done = true; return r })
    await turn(); a.metadata(3); a.age(1001)
    for (let tick = 2; tick < 25; tick++) { a.age(1000 + tick); a.c.advanceTicks(1); await turn() }
    assert.equal(done, false, 'confirmation timeout is not the duration of a defence mode')
    e.metadata[a.bot.registry.entitiesByName.skeleton.metadataKeys.indexOf('living_entity_flags')] = 0
    for (let tick = 0; tick < 25 && !done; tick++) { a.c.advanceTicks(1); await turn() }
    assert.equal(done, true); assert.equal((await pending).shielded, true)
  } finally { a.ctl.abort(); await pending; a.close() }
})

test('OW Shield faces the incoming projectile instead of the nearest unrelated shooter', async () => {
  const a = actor(), looks: any[] = []
  let pending: Promise<any>
  try {
    drawingSkeleton(a)
    a.bot.entities[3] = { id: 3, name: 'arrow', position: new Vec3(6.5, 64.9, .5) }
    observeProjectile(a)
    a.bot.lookAt = async (at: any) => { looks.push(at.clone()) }
    pending = new a.tactics.TacticalSystem(a.session).execute({ id: 'Shield', score: 110 }, a.ctl, a.tactics.observeTactics(a.session))
    await turn()
    assert.equal(looks[0]?.x, 6.5)
  } finally { a.ctl.abort(); await pending; a.close() }
})

function observeProjectile(a, id = 3) {
  const e = a.bot.entities[id], current = e.position.clone()
  e.position = current.offset(1, 0, 0)
  ;(require('../src/threats') as typeof import('../src/threats')).incoming(a.bot)
  a.c.advanceTicks(1); e.position = current
}

test('Full40 Shield cannot complete after its old three-tick pulse', async () => {
  const a = actor()
  let result: any
  try {
    const system = new a.tactics.TacticalSystem(a.session)
    const pending = system.execute({ id: 'Shield', score: 80 }, a.ctl, a.tactics.observeTactics(a.session)).then((r: any) => { result = r })
    await turn(); a.metadata(3); a.age(1001)
    a.c.advanceTicks(3); await turn()
    assert.equal(result, undefined, 'three ticks never reach native BlocksAttacks.blockDelayTicks=5')
    assert.equal(a.releases(), 0, 'the actual protection is held while the native gate is pending')
    a.ctl.abort(); await pending
    assert.equal(a.releases(), 1)
  } finally { a.close() }
})

test('offhand self-use gate dates five ticks only after its own delayed ACK and a later native age', () => {
  const a = actor()
  const use = a.bow.observeCharge(a.bot, { item: 'shield', hand: 'off-hand' })
  try {
    assert.equal(use.start(), true)
    assert.equal(a.writes[0].hand, true)
    a.age(1040); a.c.advanceTicks(50)
    a.metadata(3, 2); a.metadata(1)
    assert.equal(use.ready(5), false, 'other entity and main-hand metadata do not acknowledge the shield')
    a.metadata(3); a.age(1050); a.age(1053)
    assert.equal(use.ready(5), false)
    a.age(1055)
    assert.equal(use.ready(5), true)
    assert.equal(use.snapshot().confirmedTicks, 5)
    a.bot.quickBarSlot = 1
    assert.equal(use.ready(5), true, 'a passive main-hand slot change does not replace the offhand shield')
    a.bot.inventory.slots[45] = null; a.bot.inventory.emit('updateSlot', 45)
    assert.equal(use.ready(5), false)
  } finally { use.close(); a.close() }
})

test('shared shield reports actual ready blocking and a server block sound, then rejects axe cooldown', async () => {
  const a = actor()
  const guard = a.combat.makeShield(a.session, a.ctl, { shield: 'always' })
  try {
    assert.equal(await guard.wear(), true)
    const raised = guard.raise(true)
    await turn(); a.metadata(3); a.age(1001); a.c.advanceTicks(1); await turn()
    assert.equal(await raised, true)
    assert.equal(guard.blocking(), false, 'using ACK is distinct from blocking')
    a.age(1006)
    assert.equal(guard.blocking(), true)
    a.bot._client.emit('sound_effect', { sound: { data: { soundName: 'minecraft:item.shield.block' } }, x: 4, y: 512, z: 4 })
    assert.equal(guard.report().blocked, 1, 'the report counts a native shield block receipt, not our activate intent')
    a.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:shield', cooldownTicks: 100 })
    assert.equal(guard.blocking(), false)
    assert.equal(guard.report().disabled, 1)
    assert.equal(a.tactics.observeTactics(a.session).shield, false, 'the graph cannot select a disabled shield')
  } finally { guard.close(); a.close() }
})

for (const duringLook of ['unchanged', 'cross over', 'release', 'lost sight', 'abort'])
test(`a confirmed shield with uncertain age faces a late descent only while its use and fight are live (${duringLook})`, async () => {
  const a = actor(), use = nativeItemUse(a)
  const guard = a.combat.makeShield(a.session, a.ctl, { shield: 'always' })
  const { maceDefenseTurn }: typeof import('../src/pvp/turn-mace') = require('../src/pvp/turn-mace')
  const { installFallAndAim }: typeof import('../src/pvp/duel-events') = require('../src/pvp/duel-events')
  const { track }: typeof import('../src/mace/track') = require('../src/mace/track')
  const { trackTarget }: typeof import('../src/bow/track') = require('../src/bow/track')
  const { smashShieldAim }: typeof import('../src/combat/shield') = require('../src/combat/shield')
  const foe = a.bot.entities[2]
  Object.assign(foe, { name: 'player', type: 'player', username: 'RedPReplay', _ndVisible: true,
    onGround: false, equipment: [{ name: 'wind_charge' }] })
  const mc = track(a.bot, { enemy: () => foe, telemetryHp: () => null })
  const controls: Record<string, boolean> = {}, notes: string[] = []
  a.bot.blockAt = p => ({ position: p.floored(), name: p.y < 120 ? 'stone' : 'air',
    boundingBox: p.y < 120 ? 'block' : 'empty', shapes: p.y < 120 ? [[0, 0, 0, 1, 1, 1]] : [] })
  a.bot.look = async (yaw, pitch) => { a.bot.entity.yaw = yaw; a.bot.entity.pitch = pitch }
  a.bot.lookAt = async point => {
    const delta = point.minus(a.bot.entity.position)
    await a.bot.look(Math.atan2(-delta.x, -delta.z), 0)
    if (duringLook === 'release') a.bot.deactivateItem()
    if (duringLook === 'lost sight') foe._ndVisible = false
    if (duringLook === 'abort') a.ctl.abort()
  }
  a.session.current = { name: 'fight', ctl: a.ctl }
  try {
    assert.equal(await guard.wear(), true)
    const raised = guard.raise(true)
    await turn()
    a.metadata(3)
    a.bot.emit('entityUpdate', a.bot.entity)
    a.c.advanceTicks(1)
    await turn()
    await raised
    a.age(1020)
    assert.equal(use.cur?.confirmed, true)
    assert.deepEqual(guard.nativeUse(), { useConfirmed: true, confirmedTicks: 0 })
    assert.equal(guard.blocking(), false)

    // DT A2's positions, and DV A3's relative receipts while crossing over the defender.
    const crossover = duringLook === 'cross over'
    const me = a.bot.entity.position
    const positions = crossover ? [
      [604.089111328125, 129.62190428376198, 0], [604.3671875, 128.51155272126198, 100.9886],
      [604.3671875, 128.51155272126198, 100.9886], [604.597412109375, 127.13484373688698, 199.3255],
      [604.597412109375, 127.13484373688698, 199.3255], [604.7880859375, 125.50227537751198, 299.6941]
    ] : [
      [604.182373046875, 128.48762694001198], [604.182373046875, 128.48762694001198],
      [604.43408203125, 127.10920897126198], [604.642578125, 125.47517576813698]
    ]
    const z = crossover ? 600.4609375 : 600.47802734375
    me.set(crossover ? 604.9436286605934 : 604.345202075822, 120, crossover ? 600.5423042462245 : 600.5414834180015)
    let observed = 0, receipt
    foe._ndObservationNow = () => observed
    const aimTracker = trackTarget(foe)
    for (const [x, y, t] of positions) {
      foe.position.set(x, y, z)
      if (crossover && t !== receipt?.t) {
        const next = { x, y, z, t, kind: 'entity_move_look', grounded: false }
        foe._ndPositionReceipts = [receipt, next]
        receipt = next
      }
      observed = (t ?? observed) + 25
      if (crossover) aimTracker.update()
      a.c.advanceTicks(1)
      a.bot.emit('physicsTick')
    }
    if (crossover) {
      assert.equal(aimTracker.hasPhysicalVelocity(), true)
      const projected = smashShieldAim(a.bot, foe)
      assert.ok(projected && Math.abs(projected.x - 605.025634161499) < 1e-6, 'same trusted crossover seen on the DV trace')
    }
    const threat = mc.threat()
    assert.equal(threat?.kind, 'air')
    assert.equal(threat?.eta, 3)
    threat.webTried = true
    const ctx: any = { session: a.session, ctl: a.ctl, bot: a.bot, entity: foe, guard, prof: { player: true },
      opts: { maceIntent: a.session.current }, mc,
      track: crossover ? aimTracker : { vel: () => ({ x: .104248046875, z: 0 }), at: () => foe.position },
      holdWeapon: async () => {}, pathTo() {}, pvpSkills: { itemReady: () => false }, ready: () => true, rest() {},
      set: (key, value) => { controls[key] = value }, st: { swings: 0 }, used: note => notes.push(note),
      nextReady: Infinity, sleep: async () => {}, vision: { observe: () => foe }, tt: { state: () => ({}) }, ovl: { at: clock.now() } }
    await maceDefenseTurn(ctx, { hp: 20, now: clock.now(), r: 3.52 } as any)
    assert.equal(guard.blocking(), false)
    assert.equal(a.writes.length, 1, 'the aim change does not restart shield use')
    if (duringLook === 'abort') {
      assert.deepEqual(controls, {}, 'a cancelled fight cannot start a dodge after turning')
      return
    }
    if (duringLook !== 'unchanged' && !crossover) {
      assert.equal(ctx.aim, 'point', 'a lost use or target returns to the ordinary retreat')
      assert.equal(controls.forward, true)
      assert.equal(threat.shielded, false)
      return
    }
    installFallAndAim(ctx)
    me.set(crossover ? 604.9424725677278 : 604.2843063818032, 120, crossover ? 600.5639721681893 : 600.5481634754478)
    a.c.advanceTicks(1)
    await turn()
    const dx = (crossover ? 605.0144241993461 : 604.8900015730826) - me.x
    const dz = (crossover ? 600.4608757305566 : 600.4780754268633) - me.z
    assert.ok(-Math.sin(a.bot.entity.yaw) * dx - Math.cos(a.bot.entity.yaw) * dz > 0,
      'the native source must stay in front after both the fight turn and its aim timer')
    assert.equal(controls.back, true, 'use the safe backward step while facing the source')
    assert.equal(threat.shielded, false, 'aiming does not claim an unproven block')
  } finally { mc.close(); guard.close(); a.close() }
})

for (const state of ['ready', 'late-visible', 'late-hidden', 'young', 'disabled', 'lost', 'wrong-angle', 'released', 'adopted-disabled', 'adopted-lost', 'adopted-released', 'adopted-wrong-angle'])
  test(`fresh late mace defence respects a real ${state} offhand guard`, async () => {
    const a = actor(), notes: string[] = []
    nativeItemUse(a)
    const guard = a.combat.makeShield(a.session, a.ctl, { shield: 'always' })
    const foe = a.bot.entities[2]
    Object.assign(foe, { name: 'player', type: 'player', username: 'RedPReplay', position: new Vec3(603.7179700625796, 123.68262020949392, 600.4406512177436) })
    Object.assign(a.bot.entity, { position: new Vec3(605.2671456546208, 121.25220334025373, 600.5079851304929), onGround: false,
      velocity: new Vec3(0, -.07544406518948656, 0) })
    const late = state === 'late-visible' || state === 'late-hidden'
    if (late) {
      foe.position.set(604.79248046875, 124.83088865876198, 600.59912109375)
      Object.assign(foe, { _ndVisible: state === 'late-visible', onGround: false })
      a.bot.entity.position.set(604.9447816325196, 120, 600.4209948355688)
      a.bot.entity.onGround = true
      a.bot.lookAt = async (point: import('vec3').Vec3) => {
        const delta = point.minus(a.bot.entity.position)
        a.bot.entity.yaw = Math.atan2(-delta.x, -delta.z)
      }
    }
    a.bot.blockAt = p => ({ position: p.floored(), name: p.y < 120 ? 'stone' : 'air',
      boundingBox: p.y < 120 ? 'block' : 'empty', shapes: p.y < 120 ? [[0, 0, 0, 1, 1, 1]] : [] })
    a.bot.look = async (yaw, pitch) => { a.bot.entity.yaw = yaw; a.bot.entity.pitch = pitch }
    const delta = foe.position.minus(a.bot.entity.position), facing = Math.atan2(-delta.x, -delta.z)
    const threat: any = { kind: 'air', dy: 2.43, dh: 1.55, eta: 3, peak: 129.09, launched: true, mace: true, webTried: true }
    const adopted = state.startsWith('adopted-')
    const mode = adopted ? state.slice('adopted-'.length) : state
    const ctx: any = { session: a.session, ctl: a.ctl, bot: a.bot, entity: foe, guard, prof: { player: true }, opts: {},
      mc: { threat: () => threat, st: { shieldUps: 0, dodges: 0 } }, track: { vel: () => ({ x: .18, y: -.8, z: 0 }) },
      holdWeapon: async () => {}, pathTo() {}, pvpSkills: { itemReady: () => false }, ready: () => true, rest() {},
      set: (k, v) => a.bot.setControlState(k, v), st: { swings: 0 }, used: note => notes.push(note), nextReady: Infinity, sleep: async () => {} }
    const { maceDefenseTurn }: typeof import('../src/pvp/turn-mace') = require('../src/pvp/turn-mace')
    try {
      assert.equal(await guard.wear(), true)
      const raised = guard.raise(true)
      await turn(); a.metadata(3); a.age(1001); a.c.advanceTicks(1); await turn(); await raised
      a.age(mode === 'young' ? 1005 : 1016)
      a.bot.entity.yaw = facing
      guard.watch(foe, 3.2)
      if (mode !== 'young') assert.equal(guard.blocking(), true, 'actual ACK and fifteen native ticks are ready')
      if (adopted) threat.shielded = true
      else assert.equal(threat.shielded, undefined, 'fresh fight/target markers know no previous defence')
      if (mode === 'disabled') a.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:shield', cooldownTicks: 100 })
      if (mode === 'lost') { a.bot.inventory.slots[45] = null; a.bot.inventory.emit('updateSlot', 45) }
      if (mode === 'released') a.bot.deactivateItem()
      if (mode === 'wrong-angle' || late) a.bot.entity.yaw += Math.PI
      await maceDefenseTurn(ctx, { hp: 20, now: clock.now(), r: 2.66 } as any)
      if (mode === 'ready' || mode === 'late-visible') {
        assert.equal(ctx.aim, 'target', 'preserve the already mature frontal shield instead of turning its back')
        assert.ok(Math.cos(a.bot.entity.yaw - facing) >= 0)
        assert.equal(a.writes.length, 1, 'adopting existing use cannot reset its native delay')
        if (late) {
          const native = new Vec3(604.9668768915933, 122.97755082327646, 600.5991429717766).minus(a.bot.entity.position)
          assert.ok(-Math.sin(a.bot.entity.yaw) * native.x - Math.cos(a.bot.entity.yaw) * native.z > 0)
          assert.ok(notes.includes('щит к булаве сверху'))
        }
      } else {
        assert.equal(ctx.aim, 'point', 'the old marker cannot make an unavailable or backwards shield ready forever')
        assert.ok(notes.includes('бегу из-под булавы'))
      }
    } finally { guard.close(); a.close() }
  })

test('the shield request survives a fall rescue only by raising again after its hand is released', async () => {
  const a = actor(), reflex: typeof import('../src/reflex-lock') = require('../src/reflex-lock')
  const guard = a.combat.makeShield(a.session, a.ctl, { shield: 'always' })
  let pending
  try {
    assert.equal(await guard.wear(), true)
    reflex.install(a.session)
    pending = guard.raise(true)
    assert.equal(a.writes.length, 1)
    assert.equal(await guard.raise(true), false)
    assert.equal(a.writes.length, 1, 'a delayed ACK cannot restart the five-tick use each loop')
    // Native H: clutch takes the hand at15145002..005; the shield never
    // received USING_ITEM before take()/cleanup() released the item.
    reflex.emergency(a.session, () => {}, 200)
    a.c.advanceTicks(4); await turn()
    assert.equal(reflex.owner(a.session), null)
    const resumed = guard.raise(true)
    assert.equal(a.writes.length, 2, 'the old unconfirmed request was physically cancelled by the rescue')
    a.metadata(3); a.age(1001); a.c.advanceTicks(1); await turn()
    await resumed
    a.age(1006)
    assert.equal(guard.blocking(), true, 'the resumed request still needs its own native five-tick proof')
  } finally { guard.close(); a.ctl.abort(); await pending; a.close() }
})

test('a foreign rescue and an aborted skill cannot create a pending shield request', async () => {
  const a = actor(), reflex: typeof import('../src/reflex-lock') = require('../src/reflex-lock')
  const guard = a.combat.makeShield(a.session, a.ctl, { shield: 'always' })
  let blocked
  try {
    assert.equal(await guard.wear(), true)
    reflex.install(a.session)
    reflex.emergency(a.session, () => {}, 200)
    const owner = reflex.owner(a.session)
    blocked = guard.raise(true)
    assert.equal(guard.traceState().want, false, 'the rescue owns the hand; a suppressed packet is not a request')
    assert.equal(reflex.owner(a.session), owner, 'shield defence preserves the actual emergency lease')
    assert.equal(a.writes.length, 0)
    a.c.advanceTicks(4); await turn()
    const stale = { aborted: true }
    assert.equal(await reflex.run(a.session, stale, () => guard.raise(true)), false)
    assert.equal(guard.traceState().want, false)
    assert.equal(a.writes.length, 0, 'an old aborted skill cannot send use after the rescue')
  } finally { guard.close(); a.ctl.abort(); await blocked; a.close() }
})

test('passive smash shield reissues once after rescue without taking the rescue hand', async t => {
  const a = actor(), reflex: typeof import('../src/reflex-lock') = require('../src/reflex-lock')
  const threats: typeof import('../src/threats') = require('../src/threats')
  const out: typeof import('../src/combat/wind-out') = require('../src/combat/wind-out')
  a.bot.setControlState = () => {}
  a.session._ndFoes = ['Foe']; a.session._rescue = { arena: { x: .5, z: .5, r: 30 } }
  t.mock.method(threats, 'smashes', () => [{ name: 'Foe', ticks: 12, from: { x: 1, y: 74, z: 1 }, at: { x: .5, y: 64, z: .5 } }] as any)
  try {
    reflex.install(a.session); out.installWindOut(a.session)
    a.bot.emit('physicsTick'); a.bot.emit('physicsTick')
    assert.equal(a.writes.length, 1, 'a pending native ACK is not a reason to resend every tick')
    reflex.emergency(a.session, () => {}, 200)
    const owner = reflex.owner(a.session)
    for (let i = 0; i < 4; i++) { a.bot.emit('physicsTick'); a.c.advanceTicks(1) }
    assert.equal(a.writes.length, 1, 'no shield use can steal the active rescue hand')
    assert.equal(reflex.owner(a.session), owner)
    await turn(); assert.equal(reflex.owner(a.session), null)
    a.bot.emit('physicsTick'); a.bot.emit('physicsTick')
    assert.equal(a.writes.length, 2, 'the cancelled passive request must resume on the first free body tick')
  } finally { a.close() }
})

test('passive smash shield renews a physically released use during a same-epoch skill handoff', async t => {
  const a = actor(), reflex: typeof import('../src/reflex-lock') = require('../src/reflex-lock')
  const threats: typeof import('../src/threats') = require('../src/threats')
  const out: typeof import('../src/combat/wind-out') = require('../src/combat/wind-out')
  const use = nativeItemUse(a)
  const work = sourceModule('swarm-position-work', { './combat': a.combat })
  const holdCtl = { aborted: false, onAbort: [] as Array<() => void>, abort() { this.aborted = true; for (const f of [...this.onAbort]) f() } }
  let holding
  a.session._ndFoes = ['Foe']; a.session._rescue = { arena: { x: .5, z: .5, r: 30 } }
  t.mock.method(threats, 'smashes', () => [{ name: 'Foe', ticks: 9, from: { x: 1, y: 73, z: 1 }, at: { x: .5, y: 64, z: .5 } }] as any)
  try {
    reflex.install(a.session); out.installWindOut(a.session)
    a.bot.emit('physicsTick')
    assert.equal(a.writes.length, 1)
    const pending = use.cur
    a.bot.usingHeldItem = false // stock MF does this even for unrelated entity_status
    a.bot._client.emit('entity_status', { entityId: 2, entityStatus: 2 })
    a.bot.emit('physicsTick')
    assert.equal(use.cur, pending)
    assert.equal(a.writes.length, 1, 'another entity status and a delayed ACK cannot restart shield use')
    a.c.advanceTicks(7); a.bot.emit('physicsTick')
    assert.equal(use.cur, null, 'itemuse expires an unconfirmed intent after its existing 300ms leash')
    assert.equal(a.writes.length, 1, 'that expiry is not a real release packet and cannot restart the block delay')
    const epoch = a.session._reflexState.epoch, tick = a.c.ticks
    // Native J31p: cancelled swarm_hold.close() releases item use, followed
    // by fight in the same reflex epoch while the real smash is still nine ticks away.
    holding = work.swarmHold(a.session, holdCtl, { shield: true, requireShield: true, whileSmash: 'Foe', seconds: 20 })
    await turn()
    const before = a.writes.length
    holdCtl.abort(); await holding
    assert.equal(use.cur, null, 'real swarmHold cleanup sends the native release packet')
    assert.ok(use.stats.ended['отпустил'] > 0)
    assert.equal(a.session._reflexState.epoch, epoch)
    assert.equal(a.c.ticks, tick, 'request and cancellation can happen in the same game tick')
    a.bot.emit('physicsTick'); a.bot.emit('physicsTick')
    assert.equal(a.writes.length, before + 1, 'a real release cancels the remembered use; a delayed ACK alone does not')
  } finally { holdCtl.abort(); await holding; a.close() }
})

test('shared shield replaces an unconfirmed request after a real release in the same game tick', async () => {
  const a = actor(), use = nativeItemUse(a)
  const guard = a.combat.makeShield(a.session, a.ctl, { shield: 'always' })
  let pending, resumed
  try {
    await guard.wear(); pending = guard.raise(true)
    const tick = a.c.ticks
    a.bot.deactivateItem()
    assert.equal(use.stats.ended['отпустил'], 1)
    resumed = guard.raise(true)
    assert.equal(a.c.ticks, tick)
    assert.equal(a.writes.length, 2, 'a same-tick release cancels even a use whose ACK never arrived')
    a.metadata(3); a.age(1001); a.c.advanceTicks(1); await turn()
    a.age(1006)
    assert.equal(guard.blocking(), true)
    a.bot._client.write('block_dig', { status: 5 })
    assert.equal(guard.blocking(), false, 'a sent release invalidates protection before delayed self metadata changes')
  } finally { guard.close(); a.ctl.abort(); await Promise.all([pending, resumed]); a.close() }
})

test('Shield keeps protection after native five ticks while still admissible, and completes when the threat clears', async () => {
  const a = actor()
  let result: any
  const looks: any[] = []
  a.bot.lookAt = async (at: any) => { looks.push(at.clone()) }
  try {
    const system = new a.tactics.TacticalSystem(a.session)
    const pending = system.execute({ id: 'Shield', score: 80 }, a.ctl, a.tactics.observeTactics(a.session)).then((r: any) => { result = r })
    await turn(); a.metadata(3); a.age(1001); a.c.advanceTicks(1); await turn()
    a.age(1006); a.c.advanceTicks(1); await turn()
    assert.equal(result, undefined, 'a ready shield is not a completed pulse while the same incoming threat remains')
    assert.equal(a.releases(), 0)
    a.bot.entities[2].position = new Vec3(5.5, 64, .5)
    a.c.advanceTicks(1); await turn()
    assert.equal(looks.at(-1).x, 5.5, 'held protection follows the current observed threat direction')
    delete a.bot.entities[2]; a.c.advanceTicks(1); await pending
    assert.equal(result.shielded, true)
    assert.ok(result.shield.confirmedTicks >= 5)
    assert.equal(a.releases(), 1)
  } finally { a.close() }
})

for (const name of ['ghast', 'blaze']) test(`Shield faces an observed ${name} beyond melee search range and loses it behind a wall`, async () => {
  const a = actor()
  const looks: any[] = []
  a.bot.game.dimension = 'the_nether'
  a.bot.entities[2].name = name
  a.bot.entities[2].position = new Vec3(24.5, 64, .5)
  a.bot.entities[3] = { id: 3, name: 'small_fireball', position: new Vec3(6.5, 64.9, .5) }
  observeProjectile(a)
  a.session.autopilot = { lastHurt: { at: clock.now(), sourceId: 2, byMob: true, type: 'fireball', dimension: 'the_nether' } }
  a.bot.lookAt = async (at: any) => { looks.push(at.clone()); a.bot.entity.yaw = Math.atan2(.5 - at.x, .5 - at.z) }
  let pending: Promise<any>
  try {
    const observed = a.tactics.observeTactics(a.session)
    assert.ok(observed.enemies.some((enemy: any) => enemy.id === 2 && enemy.distance > 16), 'the ranged attacker was actually observed')
    assert.equal(observed.incomingProjectiles, 1, 'a measured incoming fireball keeps the guard admissible')
    const system = new a.tactics.TacticalSystem(a.session)
    pending = system.execute({ id: 'Shield', score: 80 }, a.ctl, observed)
    await turn(); a.metadata(3); a.age(1001); a.c.advanceTicks(1); await turn()
    assert.equal(looks[0]?.x, 24.5, 'the shield must turn toward the visible distant attacker before use')
    assert.equal(a.bot.entity.yaw, -Math.PI / 2)
    a.bot.entities[2].position = new Vec3(-23.5, 64, .5)
    a.age(1006); a.c.advanceTicks(1); await turn()
    assert.equal(looks.at(-1)?.x, -23.5, 'held protection follows the currently observed direction at range')
    const count = looks.length
    const flat = a.bot.blockAt
    a.bot.blockAt = (p: any) => p.x <= -10 && p.x >= -11 ? { position: p.floored(), name: 'blackstone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : flat(p)
    a.bot.entities[2].position = new Vec3(-25.5, 64, .5)
    a.c.advanceTicks(1); await turn()
    assert.equal(looks.length, count, 'a tracked entity behind a wall does not supply a new direction')
    a.ctl.abort(); await pending
  } finally { a.ctl.abort(); await pending; a.close() }
})

for (const cause of ['slot', 'cooldown', 'death', 'abort', 'authority']) test(`native Shield ${cause} cannot turn missing protection into completed success`, async () => {
  const a = actor()
  try {
    if (cause === 'authority') a.bot.ndClock = null
    const system = new a.tactics.TacticalSystem(a.session)
    const pending = system.execute({ id: 'Shield', score: 80 }, a.ctl, a.tactics.observeTactics(a.session)).then(
      (r: any) => ({ result: r }), (error: Error) => ({ error: error.message }))
    await turn()
    if (cause === 'slot') { a.bot.inventory.slots[45] = null; a.bot.inventory.emit('updateSlot', 45) }
    if (cause === 'cooldown') a.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:shield', cooldownTicks: 100 })
    if (cause === 'death') { a.bot.health = 0; a.bot.emit('death') }
    if (cause === 'abort') a.ctl.abort()
    const outcome = await pending
    assert.notEqual(outcome.result?.shielded, true)
    assert.ok(cause === 'abort' ? outcome.result?.cancelled : outcome.error)
    assert.equal(a.bot._client.listenerCount('set_cooldown'), 0)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
  } finally { a.close() }
})

test('a started Shield survives projectile removal while the observed shooter still threatens, through native confirmation', async () => {
  const a = actor()
  const events: any[] = []
  a.session.bus.emit = (type: string, detail: any) => events.push({ type, ...detail })
  a.bot.game.dimension = 'the_nether'
  a.bot.entities[2].name = 'ghast'
  a.bot.entities[2].position = new Vec3(24.5, 64, .5)
  a.bot.entities[3] = { id: 3, name: 'fireball', position: new Vec3(7, 64.9, .5) }
  observeProjectile(a)
  const system = new a.tactics.TacticalSystem(a.session, { record: () => {} })
  try {
    system.attach(a.bot); system.update(true); await turn()
    assert.equal(events.find(event => event.type === 'tactical_selected')?.action, 'Shield')
    assert.equal(a.writes.length, 1, 'the actual shield executor has requested offhand use')
    const releasedBefore = a.releases() // Taking the control lease clears any earlier item use.
    // The hit removes its projectile before the later packet/sample records the damage source.
    delete a.bot.entities[3]
    a.bot.health = 17
    a.session.autopilot = { lastHurt: { at: clock.now(), sourceId: 2, byMob: true, type: 'fireball', dimension: 'the_nether' } }
    system.update(true); await turn()
    assert.equal(events.some(event => event.type === 'tactical_finished'), false, 'the observed shooter is still a threat; removal must not abort the native shield ACK')
    assert.equal(a.releases(), releasedBefore, 'the active offhand use must stay raised')
    a.metadata(3); a.age(1001); a.c.advanceTicks(1); await turn()
    a.age(1006); a.c.advanceTicks(1); await turn()
    assert.equal(a.releases(), releasedBefore, 'a confirmed guard remains bounded by its existing executor deadline')
    delete a.bot.entities[2]
    for (let tick = 0; tick < 100 && !events.some(event => event.type === 'tactical_finished'); tick++) { a.c.advanceTicks(1); await turn() }
    const finished = events.find(event => event.type === 'tactical_finished')
    assert.equal(finished?.result, 'completed')
    assert.equal(finished?.detail?.shielded, true)
    assert.ok(finished?.detail?.shield?.confirmedTicks >= 5)
    assert.ok(a.releases() > releasedBefore, 'the bounded guard releases when the shooter really disappears')
    assert.equal(a.bot.entity.metadata[a.key] & 3, 0, 'offhand use is actually cleared after completion')
  } finally { system.detach(); a.close() }
})

for (const next of ['occluded', 'fall', 'melee']) test(`a started ranged Shield yields to ${next} instead of retaining its control lease`, async () => {
  const a = actor()
  const events: any[] = []
  a.session.bus.emit = (type: string, detail: any) => events.push({ type, ...detail })
  a.bot.game.dimension = 'the_nether'
  a.bot.entities[2].name = 'ghast'
  a.bot.entities[2].position = new Vec3(24.5, 64, .5)
  a.bot.entities[3] = { id: 3, name: 'fireball', position: new Vec3(7, 64.9, .5) }
  observeProjectile(a)
  const system = new a.tactics.TacticalSystem(a.session, { record: () => {},
    execute: (action: any, ctl: any, state: any) => action.id === 'Shield' ? system.execute(action, ctl, state) : Promise.resolve({}) })
  try {
    system.attach(a.bot); system.update(true); await turn()
    assert.equal(events.find(event => event.type === 'tactical_selected')?.action, 'Shield')
    const releasedBefore = a.releases()
    delete a.bot.entities[3]
    a.session.autopilot = { lastHurt: { at: clock.now(), sourceId: 2, byMob: true, type: 'fireball', dimension: 'the_nether' } }
    if (next === 'occluded') {
      const flat = a.bot.blockAt
      a.bot.blockAt = (p: any) => p.x >= 10 && p.x < 11 ? { position: p.floored(), name: 'blackstone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : flat(p)
    } else if (next === 'fall') {
      a.bot.entity.onGround = false; a.bot.entity.velocity = new Vec3(0, -.3, 0)
      a.bot._ndClutch = { lastDecision: { action: 'clutch' } }
    } else {
      a.bot.entities[4] = { id: 4, name: 'zombie', position: new Vec3(2.5, 64, .5), height: 1.95, width: .6, metadata: [], equipment: [], isValid: true }
    }
    system.update(true); await turn()
    assert.ok(events.some(event => event.type === 'tactical_finished' && event.action === 'Shield'), 'the actual pending guard must settle after losing its lease')
    assert.ok(a.releases() > releasedBefore, 'the former guard must really lower its offhand use')
    assert.notEqual(system.snapshot().action, 'Shield')
    if (next === 'melee') assert.ok(events.some(event => event.type === 'tactical_selected' && event.action === 'Fight'), 'a higher-scored melee defence can take over')
  } finally { system.detach(); a.close() }
})

test('BlockOff preserves a CORNERED receipt and its pressure diagnostics without reporting a completed refuge', async () => {
  const a = actor()
  a.bot.game.dimension = 'the_nether'
  const survival: typeof import('../src/survival') = require('../src/survival')
  const receipt = { code: 'CORNERED', how: 'none', healed: false, box: { ok: false, placed: 0, left: ['91,52,142'], pressure: true } }
  const refuge = survival.refuge
  survival.refuge = async () => receipt
  const events: any[] = []
  a.session.bus.emit = (type: string, detail: any) => events.push({ type, ...detail })
  try {
    const system = new a.tactics.TacticalSystem(a.session)
    system.begin({ id: 'BlockOff', score: 95 }, [], a.tactics.observeTactics(a.session), 2)
    await system.waitForRelease()
    const finished = events.find(event => event.type === 'tactical_finished')
    assert.equal(finished.result, 'failed')
    assert.equal(finished.detail.box.pressure, true)
    assert.equal(finished.detail.box.placed, 0)
    assert.equal(finished.detail.code, 'CORNERED')
    assert.equal(finished.detail.healed, false)
  } finally { survival.refuge = refuge; a.close() }
})

test('Full40 saved Brute inside the two-block refuge volume prevents box success; outside and neutral actors do not', async () => {
  const a = actor()
  const guard = sourceModule('ne-guard', {}, '\nmodule.exports.__boxIn=boxIn;module.exports.__sealedAt=sealedAt;')
  a.bot.entity.position = new Vec3(98.5, 43, 141.5)
  a.bot.entities[2].position = new Vec3(98.30000001192093, 43, 141.69999998807907)
  a.bot.entities[2].health = 44
  a.bot.inventory.items = () => [{ name: 'cobbled_deepslate', count: 61 }]
  a.bot.blockAt = (p: any) => {
    const air = Math.floor(p.x) === 98 && Math.floor(p.z) === 141 && (Math.floor(p.y) === 43 || Math.floor(p.y) === 44)
    return { position: p.floored(), name: air ? 'air' : 'blackstone', boundingBox: air ? 'empty' : 'block', shapes: air ? [] : [[0, 0, 0, 1, 1, 1]] }
  }
  try {
    const blocked = await guard.__boxIn(a.bot, a.bot.entities[2], { ctl: a.ctl })
    assert.equal(blocked.ok, false, 'a complete shell enclosing a hostile with us is not refuge')
    assert.equal(blocked.pressure, true)
    assert.equal(blocked.placed, 0)
    assert.equal(guard.__sealedAt(a.bot, a.bot.entity.position.floored()), false)
    a.bot.entities[2].position = new Vec3(100.5, 43, 141.5)
    assert.equal((await guard.__boxIn(a.bot, a.bot.entities[2], { ctl: a.ctl })).ok, true, 'a brute behind the solid shell does not invalidate actual cover')
    a.bot.entities[2].position = new Vec3(98.3, 43, 141.7)
    a.bot.entities[2].name = 'piglin'; a.bot.entities[2].metadata = []
    assert.equal((await guard.__boxIn(a.bot, a.bot.entities[2], { ctl: a.ctl })).ok, true, 'neutral barter piglins do not become hostile')
    a.bot.entities[2].name = 'oak_boat'
    assert.equal((await guard.__boxIn(a.bot, a.bot.entities[2], { ctl: a.ctl })).ok, true, 'a protected boat is not a melee hostile')
    a.ctl.abort()
    assert.equal((await guard.__boxIn(a.bot, null, { ctl: a.ctl })).cancelled, true)
  } finally { a.close() }
})

test('box construction reobserves hostile entry before another placement and before success', async () => {
  const a = actor()
  let placed = 0
  const filled = new Set<string>()
  a.bot.entities[2].position = new Vec3(3.5, 64, .5)
  a.bot.inventory.items = () => [{ name: 'cobbled_deepslate', count: 61 }]
  a.bot.blockAt = (p: any) => {
    const solid = p.y < 64 || filled.has(p.floored().toString())
    return { position: p.floored(), name: solid ? 'blackstone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  const guard = sourceModule('ne-guard', { './build': { placeBlockAt: async (_bot: unknown, p: any) => {
    placed++; filled.add(p.toString()); a.bot.entities[2].position = new Vec3(.3, 64, .7); return { ok: true }
  } } }, '\nmodule.exports.__boxIn=boxIn;')
  try {
    const result = await guard.__boxIn(a.bot, a.bot.entities[2], { ctl: a.ctl })
    assert.equal(placed, 1, 'the existing fair placement stops when a hostile enters our interior')
    assert.equal(result.ok, false)
    assert.equal(result.pressure, true)
    assert.equal(result.placed, 1, 'already acknowledged placements remain real partial progress')
  } finally { a.close() }
})

test('a failed diagonal refuge after a real hit cannot start another guarded wait', async () => {
  const a = actor()
  const refusal = { ok: false, placed: 0, left: ['0,64,0'], pressure: true, interior: [2] }
  const guard = sourceModule('ne-guard', {}, '\nmodule.exports.__reactBody=reactBody;module.exports.__setHooks=(h)=>{boxIn=h.boxIn;sit=h.sit;duel=h.duel;};')
  a.bot.blockAt = (p: any) => ({ position: p.floored(), name: 'blackstone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] })
  let boxes = 0; let sits = 0; let lastStand = false
  guard.__setHooks({
    boxIn: async () => ++boxes === 1 ? { ok: true, placed: 7, left: [] } : refusal,
    sit: async () => ({ hit: ++sits === 1 }),
    duel: async (_session: unknown, _ctl: unknown, _e: unknown, _ms: number, opts: { lastStand?: boolean }) => {
      lastStand = opts.lastStand === true; return { swings: 1, killed: true }
    }
  })
  try {
    const result = await guard.__reactBody(a.session, a.ctl, {}, { e: a.bot.entities[2], why: 'brute near refuge' })
    assert.equal(sits, 1, 'an observed hostile entering the failed refuge cannot authorize another 25-second wait')
    assert.equal(lastStand, true, 'the existing close-combat fallback handles the failed refuge')
    assert.equal(result.boxDiag.pressure, true)
    assert.deepEqual(result.boxDiag.interior, [2])
  } finally { a.close() }
})

async function rangedDuelFixture({ name = 'skeleton', hand = 'bow', player = false, visible = true, worn = true, aborted = false, loaded = false, piercing = false, distance = 10 } = {}) {
  const a = actor()
  a.bot.setMaxListeners(30)
  a.bot.entities[2].name = player ? 'player' : name
  if (player) { a.bot.entities[2].username = 'Target'; a.bot.entities[2].type = 'player' }
  a.bot.entities[2].position = new Vec3(.5, 64, distance + .5)
  a.bot.entities[2].yaw = 0; a.bot.entities[2].pitch = Math.atan2(-.72, distance)
  const componentMap = new Map<string, unknown>()
  if (loaded) componentMap.set('charged_projectiles', { data: { projectiles: [{ name: 'arrow' }] } })
  if (piercing) componentMap.set('enchantments', { data: { enchantments: [{ id: 'piercing', level: 1 }] } })
  a.bot.entities[2].equipment[0] = { name: hand, componentMap }
  a.bot.entities[2].metadata[a.bot.registry.entitiesByName[a.bot.entities[2].name].metadataKeys.indexOf('living_entity_flags')] = 1
  a.bot.world = { raycast: () => visible ? null : { position: new Vec3(.5, 65, 4.5) } }
  if (!visible) {
    const flat = a.bot.blockAt
    a.bot.blockAt = (p: any) => p.z >= 4 && p.z < 5 ? { position: p.floored(), name: 'blackstone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : flat(p)
  }
  a.bot.entity.velocity = new Vec3(0, 0, 0)
  a.bot.entity.attributes = {}
  a.bot.controlState = {}
  a.bot.setControlState = (key: string, value: boolean) => { a.bot.controlState[key] = value }
  a.bot.getControlState = (key: string) => !!a.bot.controlState[key]
  a.bot._client.write = () => {}
  a.bot.attack = () => {}
  a.bot.look = async () => {}
  a.bot.equip = async (item: unknown) => { a.bot.heldItem = item }
  a.bot.getEquipmentDestSlot = () => 36
  a.session.mcData = a.bot.registry
  const raises: boolean[] = []
  const guard = { stats: { worn }, melee: false, measure: false,
    safety: { check: () => ({ action: 'fight', hazard: false }) },
    wear: async () => true, watch() {}, swung() {}, report: () => ({}),
    raise: async (value: boolean) => { raises.push(value); return value }
  }
  const movement: typeof import('../src/movement') = require('../src/movement')
  const pvp = sourceModule('pvp', { './movement': { ...movement, sleep: async (ms: number) => { a.c.advanceTicks(Math.max(1, Math.ceil(ms / 50))); await turn() } } })
  try {
    if (aborted) a.ctl.abort()
    const result = await pvp.duel(a.session, a.ctl, a.bot.entities[2], { lastStand: true, timeoutSeconds: .5, guard })
    return { result, raises }
  } finally { a.close() }
}

test('a visible skeleton beyond melee reach keeps the existing offhand guard during LastStand', async () => {
  const { result, raises } = await rangedDuelFixture()
  assert.equal(result.swings, 0, 'the target is outside honest melee reach')
  assert.ok(raises.includes(true), 'the existing guard must defend from the observed ranged mob: ' + JSON.stringify(raises))
  assert.ok(raises.slice(0, -1).every(value => value === true), 'the far-approach branch must not lower the bow shield in the same loop: ' + JSON.stringify(raises))
})

test('OW middle approach does not lower its bow shield later in the same movement loop', async () => {
  const { raises } = await rangedDuelFixture({ distance: 6 })
  assert.ok(raises.includes(true))
  assert.ok(raises.slice(0, -1).every(value => value === true), JSON.stringify(raises))
})

test('ranged mobs outside the new bow policy retain their existing guard', async () => {
  assert.ok((await rangedDuelFixture({ name: 'pillager', hand: 'crossbow' })).raises.includes(true))
})

test('OW first unknown zombie exchange raises the shield instead of dropping it for a ready sword', async () => {
  const { raises, result } = await rangedDuelFixture({ name: 'zombie', hand: 'iron_sword', distance: 1 })
  assert.ok(raises.includes(true))
  assert.equal(result.swings, 0)
})

test('player bow uses the same far shield while crossbow keeps its existing loaded-aim gate', async () => {
  assert.ok((await rangedDuelFixture({ player: true })).raises.includes(true))
  assert.equal((await rangedDuelFixture({ player: true, hand: 'crossbow' })).raises.includes(true), false)
  assert.ok((await rangedDuelFixture({ player: true, hand: 'crossbow', loaded: true, distance: 6 })).raises.includes(true))
  assert.ok((await rangedDuelFixture({ player: true, hand: 'crossbow', loaded: true, piercing: true, distance: 6 })).raises.includes(true), 'hidden piercing level cannot change the ordinary player view of a loaded crossbow')
})

test('ranged guard requires visible draw and actual worn availability, and does not start after cancellation', async () => {
  for (const options of [{ name: 'zombie', hand: 'iron_sword' }, { visible: false }, { worn: false }, { aborted: true }]) {
    assert.equal((await rangedDuelFixture(options)).raises.includes(true), false, JSON.stringify(options))
  }
})

test('a threat that passes before the server confirms the raised shield ends the Shield, it does not fail it (farm 06.10)', async () => {
  const a = actor()
  let result: any, error: any
  try {
    const system = new a.tactics.TacticalSystem(a.session)
    const pending = system.execute({ id: 'Shield', score: 80 }, a.ctl, a.tactics.observeTactics(a.session))
      .then((r: any) => { result = r }, (e: any) => { error = e })
    await turn()
    a.bot.entities = {}
    for (let tick = 0; tick < 200 && result === undefined && error === undefined; tick++) { a.c.advanceTicks(1); await turn() }
    assert.equal(error, undefined, error?.message)
    assert.equal(result?.shielded, false)
  } finally { a.close() }
})

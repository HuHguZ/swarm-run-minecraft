import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as bow from '../src/bow/ballistics'
import * as ranged from '../src/ranged'
import * as spear from '../src/spear'
import { armRelease } from '../src/bow/shot-release'
import { stateSummary } from '../src/perception'
import { tntTeamRisk, igniteTntNow } from '../src/tnt'
import { memberForce } from '../src/swarm/race'
import { allyAt, isAlly } from '../src/combat/ally-safety'
import * as pick from '../src/pick'

function scene() {
  const bot: any = new EventEmitter()
  bot.username = 'Me'
  bot.entity = { id: 1, username: 'Me', position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, 0), yaw: -Math.PI / 2, pitch: 0, onGround: true }
  bot.teamMap = { Me: { team: 'blue', friendlyFire: 1 }, Ally: { team: 'blue', friendlyFire: 1 }, Foe: { team: 'red' } }
  bot.players = {}; bot.entities = {}; bot.game = { minY: -64 }
  bot.blockAt = p => ({ name: p.y < 100 ? 'stone' : 'air', position: p.floored(), boundingBox: p.y < 100 ? 'block' : 'empty', shapes: p.y < 100 ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.world = { raycast: () => null }
  bot.registry = { entitiesByName: { player: { metadataKeys: [] } } }
  bot.inventory = { slots: [], items: () => [{ name: 'arrow', count: 16 }] }
  const ally: any = { id: 2, username: 'Ally', type: 'player', position: new Vec3(4, 100, 0), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: .6 }
  bot.entities[2] = ally
  const foe: any = { id: 3, username: 'Foe', type: 'player', position: new Vec3(3, 100, 0), onGround: true, height: 1.8, width: .6 }
  bot.entities[3] = foe
  return { bot, ally, foe }
}

test('ordinary melee never retaliates against a known teammate after accidental friendly wind damage', () => {
  const { bot, ally, foe } = scene(), sent: number[] = []
  ally.position.x = 2; foe.position.x = 2
  bot.attack = e => { sent.push(e.id) }
  pick.install(bot)
  bot.attack(ally)
  assert.deepEqual(sent, [], 'native FF=true allows player_attack, so every ordinary attack caller needs this guard')
  bot.attack(foe)
  assert.deepEqual(sent, [foe.id])
  delete bot.teamMap.Ally
  bot._ndSwarmAllies = ['Ally']
  bot.attack(ally)
  assert.deepEqual(sent, [foe.id], 'own public roster also prevents a stale reflex attack')
  assert.equal(isAlly(bot, 'Ally'), true)
  assert.equal(isAlly(bot, 'Foe'), false)
})

test('arrow trajectory rejects visible allies, including a teammate crossing between ticks', () => {
  const { bot, ally } = scene(), from = new Vec3(0, 101.52, 0), sol = { yaw: -Math.PI / 2, pitch: 0, ticks: 4 }
  assert.ok(bow.blockedAt(bot, from, sol), 'static teammate on arrow path')
  ally.position = new Vec3(5, 100, 2); ally.velocity = new Vec3(0, 0, -1.2)
  assert.ok(bow.blockedAt(bot, from, sol), 'relative swept body crosses arrow segment')
  ally.position = new Vec3(4, 100, 5); ally.velocity = new Vec3(0, 0, 0)
  assert.equal(bow.blockedAt(bot, from, sol), null, 'clear enemy shot stays available')
  ally.position = new Vec3(4, 100, 0); bot.players.Ally = { gamemode: 3 }
  assert.equal(bow.blockedAt(bot, from, sol), null, 'spectator cannot intercept')
  delete bot.players.Ally; ally.position = new Vec3(7, 100, 0)
  assert.ok(bow.blockedAt(bot, from, { ...sol, ticks: 1 }), 'a miss or Piercing arrow continues behind its planned target')
  ally._ndVisible = false
  Object.defineProperty(ally, 'velocity', { get() { throw new Error('hidden motion read') } })
  assert.equal(bow.blockedAt(bot, from, sol), null, 'hidden teammate motion is not read')
})

test('spear rejects allies behind its enemy because native piercing attacks hit every body on the ray', () => {
  const { bot, ally, foe } = scene()
  assert.equal(spear.jabReach(bot, foe).ok, false)
  ally.position.z = 3
  assert.equal(spear.jabReach(bot, foe).ok, true)
})

test('shared spear guard cancels an already braced aerial or ground charge before movement is sent', () => {
  const { bot, ally } = scene()
  bot.heldItem = { name: 'diamond_spear' }; bot.usingHeldItem = true
  let cancelled = 0; bot.deactivateItem = () => { cancelled++; bot.usingHeldItem = false }
  spear.install(bot)
  bot.emit('physicTick')
  assert.equal(cancelled, 1)
  ally.position.z = 3; bot.usingHeldItem = true; bot.emit('physicTick')
  assert.equal(cancelled, 1, 'safe charge is preserved')
  ally.position.z = 0; bot._ndUse = { cur: { hand: 1, name: 'shield' } }; bot.emit('physicTick')
  assert.equal(cancelled, 1, 'a spear in the other hand must not release our active shield')
})

for (const packet of ['position', 'position_look', 'look', 'flying', 'physicTick']) test(`held spear checks its actual transmitted position for ${packet}`, () => {
  const { bot, ally } = scene(), sent: string[] = []
  bot._client = new EventEmitter()
  bot._client.write = name => { sent.push(name) }
  bot.heldItem = { name: 'diamond_spear' }
  bot._ndUse = { cur: { hand: 0, name: 'diamond_spear', confirmed: true } }
  bot.deactivateItem = () => { sent.push('release'); bot._ndUse.cur = null }
  ally.position.z = 3
  spear.install(bot)
  bot._client.write('position', { x: 0, y: 100, z: 0 })
  bot.entity.position.x = 10
  ally.position.z = 0
  assert.equal(spear.teamSafe(bot), true, 'the local predicted body is already beyond this ally')
  if (packet === 'physicTick') bot.emit(packet)
  else bot._client.write(packet, { x: 0, y: 100, z: 0, yaw: 270, pitch: 0 })
  assert.equal(sent[1], 'release', 'release before the server receives the unsafe ray, even without new XYZ')
  assert.equal(bot._ndUse.cur, null)
  bot.emit('end')
})

for (const reset of ['position', 'respawn']) test(`a native ${reset} resets the held spear's previous transmitted origin`, () => {
  const { bot, ally } = scene(), sent: string[] = []
  bot._client = new EventEmitter(); bot._client.write = name => { sent.push(name) }
  bot.heldItem = { name: 'diamond_spear' }
  bot._ndUse = { cur: { hand: 0, name: 'diamond_spear', confirmed: true } }
  bot.deactivateItem = () => { sent.push('release') }
  ally.position.z = 3
  spear.install(bot)
  bot._client.write('position', { x: 0, y: 100, z: 0 })
  bot.entity.position.x = 10; ally.position.z = 0
  if (reset === 'position') bot._client.emit(reset, { x: 10, y: 100, z: 0 })
  else bot.emit(reset)
  bot._client.write('look', { yaw: 270, pitch: 0 })
  assert.deepEqual(sent, ['position', 'look'], 'do not release for a stale location from the previous life or correction')
  bot.emit('end')
})

test('an unsent local position waits for the actual movement packet before releasing a safe native charge', () => {
  const { bot, ally } = scene(), sent: string[] = []
  bot._client = new EventEmitter(); bot._client.write = name => { sent.push(name) }
  bot.heldItem = { name: 'diamond_spear' }
  bot._ndUse = { cur: { hand: 0, name: 'diamond_spear', confirmed: true } }
  bot.deactivateItem = () => { sent.push('release'); bot._ndUse.cur = null }
  ally.position.x = 6
  spear.install(bot)
  bot._client.write('position', { x: 0, y: 100, z: 0 })
  bot.entity.position.x = 2
  assert.equal(spear.teamSafe(bot), false, 'the future local position would hit our ally')
  bot.emit('physicTick')
  assert.deepEqual(sent, ['position'], 'the server still holds the safe previous position')
  bot._client.write('position', { x: 2, y: 100, z: 0 })
  assert.deepEqual(sent, ['position', 'release', 'position'], 'release exactly before making the unsafe origin native')
  bot.emit('end')
})

function observedStrafe(ally, age: number, z = 0) {
  ally.position = new Vec3(4, 100, z)
  ally._ndPositionReceipts = [
    { x: 4, y: 100, z: z - .5, t: 950, grounded: true, kind: 'rel_entity_move' },
    { x: 4, y: 100, z, t: 1000, grounded: true, kind: 'rel_entity_move' }
  ]
  ally._ndObservationNow = () => 1000 + age * 50
}

for (const age of [0, 4]) test(`spear keeps the actual visible ally on its beam at observation age ${age}`, t => {
  const { bot, ally } = scene(), sent: any[] = []
  const registry = require('prismarine-registry')('1.21.11'), data = require('minecraft-data')('1.21.11')
  Object.assign(bot, { registry, version: '1.21.11', QUICK_BAR_START: 36, _client: new EventEmitter(),
    supportFeature: name => data.supportFeature(name), health: 20, food: 20,
    physics: { simulatePlayer() {} }, setControlState() {}, getControlState() { return false } })
  bot.entity.metadata = []
  bot._client.write = (name, packet) => sent.push({ name, packet })
  require('mineflayer/lib/plugins/inventory')(bot, {})
  bot.quickBarSlot = 0
  bot.inventory.slots[36] = { name: 'diamond_spear', type: registry.itemsByName.diamond_spear.id, count: 1 }
  require('../src/itemuse').install(bot); spear.install(bot)
  observedStrafe(ally, age)
  assert.equal(allyAt(bot, ally, 0).z, age * .5, 'real receipt age shifts both forecast endpoints')
  assert.equal(allyAt(bot, ally, 1).z, (age + 1) * .5)
  bot.activateItem(); bot.entity.metadata[8] = 1; bot.emit('entityUpdate', bot.entity)
  assert.equal(bot._ndUse.cur?.confirmed, true)
  const safe = spear.teamSafe(bot)
  bot.emit('physicTick'); bot._client.write('flying', { onGround: true })
  const release = sent.findIndex(p => p.name === 'block_dig' && p.packet.status === 5)
  t.diagnostic(JSON.stringify({ age, visibleZ: ally.position.z, forecastZ: [allyAt(bot, ally, 0).z, allyAt(bot, ally, 1).z], safe, release, movement: sent.findIndex(p => p.name === 'flying') }))
  assert.equal(safe, false, 'the forecast cannot erase the last visible body on the native piercing ray')
  assert.ok(release >= 0 && release < sent.findIndex(p => p.name === 'flying'), 'the existing late guard releases the real mainhand use before movement')
  assert.equal(bot._ndUse.cur, null)
  bot.emit('physicTick')
  assert.equal(sent.filter(p => p.name === 'block_dig' && p.packet.status === 5).length, 1)
  bot.emit('end')
})

test('an aged ally whose observed body and entire forecast stay outside the spear beam remains safe', () => {
  const { bot, ally } = scene()
  observedStrafe(ally, 4, 3)
  assert.equal(allyAt(bot, ally, 0).z, 5)
  assert.equal(spear.teamSafe(bot), true)
})

test('a held spear covers the ally moving first while our next movement packet is pending', () => {
  const { bot, ally } = scene()
  bot.entity.onGround = false; bot.entity.elytraFlying = true
  bot.entity.velocity.z = .6
  Object.assign(ally, { position: new Vec3(4, 100, -.6), onGround: false, elytraFlying: true, height: .6,
    _ndPositionReceipts: [
      { x: 4, y: 100, z: -1.2, t: 950, grounded: false, kind: 'rel_entity_move' },
      { x: 4, y: 100, z: -.6, t: 1000, grounded: false, kind: 'rel_entity_move' }
    ], _ndObservationNow: () => 1000 })
  assert(allyAt(bot, ally, 1).z > -.425, 'the observed ally will cross the held ray before our next move')
  assert.equal(spear.teamSafe(bot), false, 'equal sideways motion cannot erase the interval before our packet is applied')
  bot.entity.velocity.z = 0
  assert.equal(spear.teamSafe(bot), false, 'a stationary holder already sees the same crossing')
  ally.position.z = -3
  ally._ndPositionReceipts[0].z = -3.6; ally._ndPositionReceipts[1].z = -3
  bot.entity.velocity.z = .6
  assert.equal(spear.teamSafe(bot), true, 'a parallel teammate outside both poses must not interrupt the charge')
})

test('spear safety never reads the known-hidden ally position or motion', () => {
  const { bot, ally } = scene()
  ally._ndVisible = false
  for (const name of ['position', 'velocity', '_ndPositionReceipts']) Object.defineProperty(ally, name, { get() { throw new Error('hidden geometry read') } })
  assert.equal(spear.teamSafe(bot), true)
})

test('an ally behind an actual opaque wall contributes no hidden forecast to spear safety', () => {
  const { bot, ally } = scene(), read = bot.blockAt
  bot.blockAt = p => p.x >= 2 && p.x < 3 && p.y >= 100 && p.y < 103
    ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(p)
  Object.defineProperty(ally, '_ndPositionReceipts', { get() { throw new Error('hidden motion read') } })
  assert.equal(spear.teamSafe(bot), true)
})

test('unknown future strafe terrain cannot erase the visible ally from a spear beam', () => {
  const { bot, ally } = scene(), read = bot.blockAt
  observedStrafe(ally, 4)
  bot.blockAt = p => p.z >= 1 ? null : read(p)
  assert.equal(spear.teamSafe(bot), false)
})

test('rocket rejects a teammate in the explosion and on a side multishot ray', () => {
  const { bot, ally, foe } = scene(), from = new Vec3(0, 101.47, 0)
  foe.position.x = 12
  const sol = { yaw: -Math.PI / 2, pitch: 0, dist: 12, at: new Vec3(12, 101.47, 0), ticks: 7.5 }
  ally.position = new Vec3(12, 100, 3)
  assert.equal(ranged.rocketSafe(bot, from, sol, false).ok, false)
  ally.position = new Vec3(6, 100, Math.tan(Math.PI / 18) * 6)
  assert.equal(ranged.rocketSafe(bot, from, sol, true).ok, false)
  ally.position = new Vec3(12, 100, 8)
  assert.equal(ranged.rocketSafe(bot, from, sol, false).ok, true)
})

test('flight-zero rocket prices its native early expiration rather than assuming flight one', () => {
  const { bot, ally, foe } = scene(), from = new Vec3(0, 101.47, 0)
  foe.position.x = 40; ally.position = new Vec3(16, 100, 4)
  const item = { componentMap: new Map([['charged_projectiles', { data: { projectiles: [{ components: [{ type: 'fireworks', data: { flightDuration: 0 } }] }] } }]]) }
  assert.equal(ranged.rocketSafe(bot, from, { yaw: -Math.PI / 2, pitch: 0, dist: 40, ticks: 25, at: new Vec3(40, 101.47, 0) }, false, item).ok, false)
})

test('a visible wall that stops a crossing teammate cannot make its future arrow lane look empty', () => {
  const { bot, ally } = scene(), read = bot.blockAt
  ally.position = new Vec3(7, 100, 0); ally.velocity = new Vec3(0, 0, -1)
  bot.blockAt = p => p.x === 7 && p.z === -1 && p.y >= 100 && p.y <= 102
    ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(p)
  assert.ok(bow.blockedAt(bot, new Vec3(0, 101.52, 0), { yaw: -Math.PI / 2, pitch: 0, ticks: 4 }))
})

test('a packet-only post-target wall cannot terminate checks of future teammate crossings', () => {
  const { bot, ally } = scene()
  ally.position = new Vec3(8, 100, 4); ally.velocity = new Vec3(0, 0, -4 / 3)
  bot.world.raycast = p => p.x >= 3 && p.x < 5 ? { position: new Vec3(4, 100, 0) } : null
  assert.ok(bow.blockedAt(bot, new Vec3(0, 101.52, 0), { yaw: -Math.PI / 2, pitch: 0, ticks: 1 }))
})

test('offensive arrow choice never falls back to speed or regeneration on an enemy', () => {
  const { bot } = scene()
  const arrow = (name: string, potion?: string) => ({ name, count: 8, componentMap: new Map(potion ? [['potion_contents', { data: { potion } }]] : []) })
  const speed = arrow('tipped_arrow', 'minecraft:swiftness'), regen = arrow('tipped_arrow', 'minecraft:regeneration'), poison = arrow('tipped_arrow', 'minecraft:poison')
  bot.inventory = { slots: [], items: () => [speed, regen] }
  assert.equal(ranged.pickArrow(bot), null)
  bot.inventory.items = () => [speed, regen, poison]
  assert.equal(ranged.pickArrow(bot)?.item, poison)
  assert.equal(ranged.arrowCount(bot), 8)
  bot.inventory.slots[45] = arrow('spectral_arrow')
  assert.equal(ranged.arrowCount(bot), 16, 'native offhand ammunition is counted once')
  const loaded = potion => ({ componentMap: new Map([['charged_projectiles', { data: { projectiles: [{ name: 'tipped_arrow', components: [{ type: 'potion_contents', data: { potion } }] }] } }]]) })
  assert.equal(ranged.offensiveLoaded(bot, loaded('regeneration')), false)
  assert.equal(ranged.offensiveLoaded(bot, loaded('poison')), true)
})

test('own ammo summary keeps item identities for logistics and enables a bow with harmful tipped arrows', () => {
  const { bot } = scene()
  const tipped = potion => ({ name: 'tipped_arrow', count: 8, componentMap: new Map([['potion_contents', { data: { potion } }]]) })
  bot.inventory = { slots: [], items: () => [{ name: 'bow', count: 1 }, tipped('poison'), tipped('regeneration')] }
  const state = stateSummary(bot)
  assert.equal(state.inventory.arrow, undefined, 'no phantom plain arrows for name-based transfers')
  assert.equal(state.inventory.tipped_arrow, 16)
  assert.equal(state.attackArrows, 8)
  const member: any = { inventory: state.inventory, attackArrows: state.attackArrows, position: { x: 0, y: 100, z: 0 }, strength: 1 }
  assert.ok(memberForce(member) > memberForce({ ...member, attackArrows: 0 }), 'harmful tipped arrows make the ranged weapon usable')
})

test('TNT prices teammate HP and knockback instead of relying on friendlyFire protection', () => {
  const { bot, ally } = scene(), center = new Vec3(5, 100, 0)
  const unsafe = tntTeamRisk(bot, center)
  assert.ok(unsafe.damage > 0 && unsafe.push > 0 && unsafe.unsafe)
  ally.position.x = 20
  assert.deepEqual(tntTeamRisk(bot, center), { damage: 0, push: 0, unsafe: false })
})

test('TNT ignition checks fresh allies and sends its native click without another smooth-look await', () => {
  const { bot, ally } = scene(), c = new Vec3(3, 100, 0), read = bot.blockAt, sent: any[] = []
  bot.blockAt = p => p.floored().equals(c) ? { name: 'tnt', position: c, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(p)
  bot.heldItem = { name: 'flint_and_steel' }
  bot._client = { write(name, packet) { sent.push({ name, packet }) } }
  bot.activateBlock = () => { throw new Error('activateBlock awaits another smooth look') }
  const d = c.offset(0, .5, .5).minus(bot.entity.position.offset(0, 1.62, 0))
  bot.entity.yaw = Math.atan2(-d.x, -d.z); bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  ally.position.x = 20
  assert.equal(igniteTntNow(bot, c).ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].name, 'block_place')
  assert.equal(sent[0].packet.direction, 4)
  assert.equal(sent[0].packet.insideBlock, false)
  ally.position.x = 5
  assert.equal(igniteTntNow(bot, c).ok, false)
  assert.equal(sent.length, 1, 'late teammate cancels the actual click')
})

test('ally forecast does not turn a fresh stationary receipt or its age into velocity', () => {
  const { bot, ally } = scene()
  let at = 1000
  ally._ndObservationNow = () => at
  ally._ndPositionReceipts = [null, { ...ally.position, t: at, grounded: true, kind: 'sync_entity_position' }]
  allyAt(bot, ally, 0)
  at += 50; ally.position.x += .3
  ally._ndPositionReceipts = [ally._ndPositionReceipts[1], { ...ally.position, t: at, grounded: true, kind: 'rel_entity_move' }]
  assert.ok(allyAt(bot, ally, 2).x > ally.position.x)
  at += 50
  ally._ndPositionReceipts = [ally._ndPositionReceipts[1], { ...ally.position, t: at, grounded: true, kind: 'rel_entity_move' }]
  at += 250
  assert.equal(allyAt(bot, ally, 2).x, ally.position.x)
})

test('ally falling forecast cannot read raw cached future terrain behind a wall', () => {
  const { bot, ally } = scene(), read = bot.blockAt
  ally.onGround = false; ally.position = new Vec3(4, 102, 0); ally.velocity = new Vec3(1, 0, 0)
  bot._ndSkyWorld = { floorBelow: () => ({ top: 150 }) }
  bot._ndObservedSkyWorld = { floorBelow: () => ({ top: 102 }) }
  bot.blockAt = p => p.x === 5 ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(p)
  assert.ok(allyAt(bot, ally, 2).y < 102, 'unknown hidden floor is not accepted as a known support')
})

test('spear STAB checks the actual old look when its target moves after aiming', async () => {
  const { bot, ally, foe } = scene()
  ally.position.z = 3
  bot.heldItem = { name: 'diamond_spear' }; bot._client = { write() { throw new Error('unsafe STAB sent') } }
  bot.look = (yaw, pitch) => { Object.assign(bot.entity, { yaw, pitch }); return Promise.resolve() }
  const pending = spear.jab(bot, foe)
  bot.emit('physicsTick')
  foe.position.z = 3; ally.position.z = 0
  assert.equal((await pending).ok, false)
})

test('bow rechecks allies at actual release after the final aim was solved', () => {
  const { bot, ally, foe } = scene()
  let sent = 0, cancelled = 0
  bot.deactivateItem = () => { sent++ }
  const sol = { yaw: -Math.PI / 2, pitch: 0, ticks: 4 }
  const S: any = { bot, entity: foe, charge: { ready: () => true, close() {} }, cancelDraw: () => { cancelled++ }, stopTick() {}, eye: () => new Vec3(0, 101.52, 0), speed: 3, mode: 'settle' }
  ally.position.z = 0
  const result = armRelease(S).release(sol, null, null, bot.entity.position)
  assert.equal(result.released, undefined)
  assert.equal(sent, 0)
  assert.equal(cancelled, 1)
})

test('bow cancels if inventory order changed to a beneficial arrow during the draw', () => {
  const { bot, ally, foe } = scene()
  ally.position.z = 5
  let sent = 0; bot.deactivateItem = () => { sent++ }
  bot.inventory.slots[45] = { name: 'tipped_arrow', slot: 45, componentMap: new Map([['potion_contents', { data: { potion: 'regeneration' } }]]) }
  const S: any = { bot, entity: foe, charge: { ready: () => true, close() {} }, cancelDraw() {}, stopTick() {}, eye: () => new Vec3(0, 101.52, 0), speed: 3, mode: 'settle' }
  const result = armRelease(S).release({ yaw: -Math.PI / 2, pitch: 0, ticks: 4 }, null, null, bot.entity.position)
  assert.equal(result.released, undefined)
  assert.equal(sent, 0)
})

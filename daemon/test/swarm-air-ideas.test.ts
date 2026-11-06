import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

const air: typeof import('../src/swarm/combos/air-ideas') = require('../src/swarm/combos/air-ideas')
const item = (name: string, slot = 36, ench: Record<string, number> = {}) => ({ name, slot, count: 64,
  componentMap: new Map([['enchantments', { data: { enchantments: Object.entries(ench).map(([id, level]) => ({ id, level })) } }]]) })
function fixture(items = [item('wind_charge')], timeEvery = 20) {
  const bot: any = new EventEmitter(), uses: string[] = [], attacks: number[] = [], controls: Record<string, boolean> = {}
  let tick = 0, wall = false
  bot.username = 'actor'; bot.health = 20; bot.food = 20
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, metadata: [] }
  bot.entities = {}; bot.players = {}; bot._client = new EventEmitter()
  bot.game = { minY: -64 }; bot.registry = { entitiesByName: { player: { metadataKeys: ['living_entity_flags'] } }, enchantments: {} }
  bot.ndClock = { age: 0n, serverTicks: 0, ticks: 0 }
  bot.inventory = { slots: [], items: () => items }; for (const it of items) bot.inventory.slots[it.slot] = it
  bot.heldItem = items[0]; bot.quickBarSlot = 0
  bot.equip = async it => { bot.heldItem = it }
  bot.setQuickBarSlot = s => { bot.quickBarSlot = s; bot.heldItem = bot.inventory.slots[36 + s] }
  bot.activateItem = () => { uses.push(bot.heldItem?.name); bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 1 }] }) }
  bot.deactivateItem = () => { bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, value: 0 }] }) }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async p => { const d = p.minus(bot.entity.position.offset(0, 1.62, 0)); await bot.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))) }
  bot.blockAt = p => ({ name: wall ? 'stone' : 'air', boundingBox: wall ? 'block' : 'empty', position: p, shapes: wall ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.world = { raycast: () => null }
  bot.setControlState = (k, v) => { controls[k] = v }; bot.getControlState = k => !!controls[k]
  bot.attack = e => attacks.push(e.id)
  bot.waitForTicks = async n => { for (let i = 0; i < n; i++) {
    tick++; bot.ndClock.ticks++
    if (tick % timeEvery === 0) { bot.ndClock.age = BigInt(tick); bot.ndClock.serverTicks = tick; bot._client.emit('update_time', {}) }
    bot.emit('physicsTick')
  } }
  const target: any = { id: 2, username: 'enemy', name: 'player', type: 'player', isValid: true,
    position: new Vec3(6, 64, 0), velocity: new Vec3(0, 0, 0), height: 1.8, width: .6, metadata: [] }
  Object.defineProperty(target, 'health', { get() { throw Error('enemy HP must stay private') } })
  return { bot, target, uses, attacks, controls, tick: () => tick, wall: () => { wall = true } }
}

test('air prototypes expose real actor actions', () => {
  for (const name of ['windAt', 'punchAt', 'maceDive', 'chargedSpear', 'aerialPass', 'slowFallingAt']) assert.equal(typeof air[name], 'function', name)
})
test('wind launches an actual charge without reading enemy HP', async () => {
  const f = fixture()
  assert.equal((await air.windAt(f.bot, f.target)).fired, true)
  assert.deepEqual(f.uses, ['wind_charge'])
})

test('wind can throw its only offhand charge while retaining the held weapon', async () => {
  const f = fixture([]), charge = item('wind_charge', 45); charge.count = 1
  f.bot.inventory.slots[45] = charge
  f.bot.heldItem = item('netherite_sword')
  f.bot.equip = async () => { throw Error('offhand charge does not require a main-hand swap') }
  f.bot.activateItem = off => { assert.equal(off, true); f.uses.push(f.bot.inventory.slots[45].name) }
  assert.equal((await air.windAt(f.bot, f.target)).fired, true)
  assert.equal(f.bot.heldItem.name, 'netherite_sword')
  assert.deepEqual(f.uses, ['wind_charge'])
})

test('offhand wind rechecks the actual hand before release', async () => {
  const f = fixture([]), charge = item('wind_charge', 45); charge.count = 1
  f.bot.inventory.slots[45] = charge
  const look = f.bot.look
  f.bot.look = async (yaw, pitch) => { await look(yaw, pitch); f.bot.inventory.slots[45] = item('shield', 45) }
  assert.equal((await air.windAt(f.bot, f.target)).fired, false)
  assert.equal(f.uses.length, 0)
})

test('wind uses its last charge past 32m while ordinary Punch keeps its existing range', async () => {
  const charge = item('wind_charge'); charge.count = 1
  const f = fixture([charge]); f.target.position.x = 33
  assert.equal((await air.windAt(f.bot, f.target)).fired, true)
  assert.deepEqual(f.uses, ['wind_charge'])
  const blocked = fixture([charge]); blocked.target.position.x = 33; blocked.wall()
  assert.equal((await air.windAt(blocked.bot, blocked.target)).fired, false)
  assert.equal(blocked.uses.length, 0)
  const unknown = fixture([charge]); unknown.target.position.x = 33; unknown.bot.blockAt = () => null
  assert.equal((await air.windAt(unknown.bot, unknown.target)).fired, false, 'an unknown corridor is not visible')
  assert.equal(unknown.uses.length, 0)
  const archer = fixture([item('bow', 36, { punch: 2 }), item('arrow', 37)]); archer.target.position.x = 33
  assert.equal((await air.punchAt(archer.bot, archer.target)).fired, false)
})
test('wind telemetry separates the used aim from movement observed before release', async () => {
  const f = fixture(), look = f.bot.look
  let observationNow = 1010, aimedYaw = 0, aimedPitch = 0
  f.target.onGround = true
  f.target._ndObservationNow = () => observationNow
  f.target._ndPositionReceipts = [
    { x: 5.8, y: 64, z: 0, t: 950, grounded: true, kind: 'rel_entity_move' },
    { x: 6, y: 64, z: 0, t: 1000, grounded: true, kind: 'rel_entity_move' }
  ]
  f.bot.look = async (yaw, pitch) => {
    aimedYaw = yaw; aimedPitch = pitch; await look(yaw, pitch)
    f.target.position.x = 5.8; observationNow = 1100
    f.target._ndPositionReceipts = [f.target._ndPositionReceipts[1],
      { x: 5.8, y: 64, z: 0, t: 1050, grounded: true, kind: 'entity_move_look' }]
    f.bot.entity.position.x = .05; f.bot.entity.velocity.x = .02
  }
  const r: any = await air.windAt(f.bot, f.target)
  assert.equal(r.fired, true); assert.deepEqual(f.uses, ['wind_charge'])
  assert.ok(r.trace, 'successful wind must retain aim and packet-time observations')
  const { aim, release } = r.trace
  assert.deepEqual(aim.target, { x: 6, y: 64, z: 0 })
  assert.deepEqual(release.target, { x: 5.8, y: 64, z: 0 })
  assert.ok(Math.abs(aim.v.x - .2) < 1e-12); assert.ok(Math.abs(release.v.x + .2) < 1e-12)
  assert.equal(aim.v.ageTicks, .2); assert.equal(release.v.ageTicks, 1)
  assert.equal(aim.v.hasConfidence, true); assert.equal(release.v.hasConfidence, true)
  assert.equal(aim.v.receiptKind, 'rel_entity_move'); assert.equal(release.v.receiptKind, 'entity_move_look')
  assert.equal(aim.v.clockReceiptMs, 1000); assert.equal(release.v.clockReceiptMs, 1050)
  assert.ok(release.ms >= aim.ms); assert.ok(aim.at.x > 6)
  assert.equal(aim.own.position.x, 0); assert.equal(release.own.position.x, .05)
  assert.equal(aim.own.movement.x, 0); assert.equal(release.own.movement.x, .02)
  assert.equal(r.yaw, aimedYaw); assert.equal(r.pitch, aimedPitch)
  assert.equal(aim.shot.yaw, r.yaw); assert.equal(aim.shot.pitch, r.pitch); assert.equal(aim.shot.time, r.ticks)
  f.target.position.x = 9; f.bot.entity.position.x = 2
  assert.equal(aim.target.x, 6); assert.equal(release.target.x, 5.8); assert.equal(release.own.position.x, .05)
})

test('wind rechecks cancellation after equipment', async () => {
  const f = fixture(), ctl = { aborted: false }; f.bot.heldItem = null
  f.bot.equip = async it => { f.bot.heldItem = it; ctl.aborted = true }
  assert.equal((await air.windAt(f.bot, f.target, { ctl })).fired, false)
  assert.equal(f.uses.length, 0)
})
test('wind rejects a wall appearing during aim', async () => {
  const f = fixture(); const look = f.bot.look; f.bot.look = async (...p) => { await look(...p); f.wall() }
  assert.equal((await air.windAt(f.bot, f.target)).fired, false)
  assert.equal(f.uses.length, 0)
})
test('wind release refusal identifies the changed aim without weakening the guard', async () => {
  const f = fixture(), look = f.bot.look
  f.bot.look = async (...p) => { await look(...p); f.bot.entity.yaw += .1 }
  const r = await air.windAt(f.bot, f.target)
  assert.equal(r.fired, false); assert.equal(r.why, 'release_changed_or_unsafe'); assert.equal(r.check, 'aim')
  assert.equal(f.uses.length, 0)
})
test('wind waits for the movement packet after changing its local look', async () => {
  const f = fixture(), wait = f.bot.waitForTicks, activate = f.bot.activateItem
  let movementYaw = 0, releasedYaw = 0
  f.bot.waitForTicks = async n => { await wait(n); movementYaw = f.bot.entity.yaw }
  f.bot.activateItem = () => { releasedYaw = movementYaw; activate() }
  const r = await air.windAt(f.bot, f.target)
  assert.equal(r.fired, true); assert.equal(releasedYaw, r.yaw)
})
test('explicit ally launches require health and safe landing telemetry', async () => {
  const f = fixture(); f.bot._ndSwarmAllies = ['enemy']
  assert.equal((await air.windAt(f.bot, f.target, { allowAlly: true })).fired, false)
  assert.equal((await air.windAt(f.bot, f.target, { allowAlly: true, allyHealth: () => 20, allySafe: () => false })).fired, false)
  assert.equal(f.uses.length, 0)
})
test('explicit ally wind executes only while the safe-runway receipt still holds', async () => {
  const f = fixture(); f.bot._ndSwarmAllies = ['enemy']
  const r = await air.windAt(f.bot, f.target, { allowAlly: true, allyHealth: () => 20, allySafe: () => true })
  assert.equal(r.fired, true); assert.deepEqual(f.uses, ['wind_charge'])
})
test('Punch uses a plain arrow, confirmed native draw and a real release', async () => {
  const f = fixture([item('bow', 36, { punch: 2 }), item('arrow', 37)])
  const r = await air.punchAt(f.bot, f.target, { drawTicks: 6 })
  assert.equal(r.fired, true); assert.equal(r.confirmedTicks, 20)
  assert.deepEqual(f.uses, ['bow']); assert.ok(f.tick() >= 8)
})
test('ally Punch refuses Power and Flame rather than hiding friendly damage', async () => {
  const f = fixture([item('bow', 36, { punch: 2, flame: 1 }), item('arrow', 37)]); f.bot._ndSwarmAllies = ['enemy']
  const r = await air.punchAt(f.bot, f.target, { allowAlly: true, allyHealth: () => 100, allySafe: () => true, foe: { position: new Vec3(12, 64, 0) } })
  assert.equal(r.fired, false)
})
test('native Punch can accelerate an explicitly safe ally without requiring spear use', async () => {
  const f = fixture([item('bow', 36, { punch: 2 }), item('arrow', 37)]); f.bot._ndSwarmAllies = ['enemy']
  const r = await air.punchAt(f.bot, f.target, { allowAlly: true, allyHealth: () => 100, allySafe: () => true, foe: { position: new Vec3(12, 64, 0) } })
  assert.equal(r.fired, true); assert.equal(r.confirmedTicks, 20)
})
test('Punch waits for the movement packet after changing its local look', async () => {
  const f = fixture([item('bow', 36, { punch: 2 }), item('arrow', 37)]), wait = f.bot.waitForTicks, activate = f.bot.activateItem
  let movementYaw = 0, releasedYaw = 0
  f.bot.waitForTicks = async n => { await wait(n); movementYaw = f.bot.entity.yaw }
  f.bot.deactivateItem = () => { releasedYaw = movementYaw }
  f.bot.activateItem = () => activate()
  const r = await air.punchAt(f.bot, f.target, { drawTicks: 20 })
  assert.equal(r.fired, true); assert.equal(releasedYaw, f.bot.entity.yaw)
})
test('Punch refuses a short shot if its native power changed while the look packet was sent', async () => {
  const f = fixture([item('bow', 36, { punch: 2 }), item('arrow', 37)], 1)
  assert.equal((await air.punchAt(f.bot, f.target, { drawTicks: 6 })).fired, false)
})
test('full native Punch draw is allowed for a healthy consenting ally', async () => {
  const f = fixture([item('bow', 36, { punch: 2 }), item('arrow', 37)]); f.bot._ndSwarmAllies = ['enemy']
  const r = await air.punchAt(f.bot, f.target, { drawTicks: 20, allowAlly: true, allyHealth: () => 100, allySafe: () => true, foe: { position: new Vec3(12, 64, 0) } })
  assert.equal(r.fired, true); assert.equal(r.confirmedTicks, 20)
})
test('full Punch draw cannot spend the final ten allied HP', async () => {
  const f = fixture([item('bow', 36, { punch: 2 }), item('arrow', 37)]); f.bot._ndSwarmAllies = ['enemy']
  const r = await air.punchAt(f.bot, f.target, { drawTicks: 20, allowAlly: true, allyHealth: () => 10, allySafe: () => true, foe: { position: new Vec3(12, 64, 0) } })
  assert.equal(r.fired, false)
})
test('inherited shooter speed cannot hide extra native critical damage to an ally', async () => {
  const f = fixture([item('bow', 36, { punch: 2 }), item('arrow', 37)]); f.bot._ndSwarmAllies = ['enemy']
  f.bot.entity.velocity.x = 1
  const r = await air.punchAt(f.bot, f.target, { drawTicks: 20, allowAlly: true, allyHealth: () => 11, allySafe: () => true, foe: { position: new Vec3(12, 64, 0) } })
  assert.equal(r.fired, false)
})
test('a missed Punch shot checks the ally beyond the original target', async () => {
  const f = fixture([item('bow', 36, { punch: 2 }), item('arrow', 37)])
  f.bot._ndSwarmAllies = ['friend']; f.bot.entities[3] = { id: 3, username: 'friend', name: 'player', type: 'player', isValid: true,
    position: new Vec3(9, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: .6, metadata: [] }
  assert.equal((await air.punchAt(f.bot, f.target, { drawTicks: 20 })).fired, false)
})
test('Punch continuation also checks the gap after a fractional target-intersection tick', async () => {
  const f = fixture([item('bow', 36, { punch: 2 }), item('arrow', 37)])
  f.bot._ndSwarmAllies = ['friend']; f.bot.entities[3] = { id: 3, username: 'friend', name: 'player', type: 'player', isValid: true,
    position: new Vec3(7.6, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: .6, metadata: [] }
  assert.equal((await air.punchAt(f.bot, f.target, { drawTicks: 20 })).fired, false)
})
test('mace attempts an ordinary falling hit so Slow Falling is measured by native damage', async () => {
  const f = fixture([item('mace')]); f.target.position = new Vec3(0, 64, -1)
  f.bot.entity.position = new Vec3(0, 65, 0); f.bot.entity.velocity.y = -.05; f.bot.entity.onGround = false
  const r = await air.maceDive(f.bot, f.target, { maxTicks: 3 })
  assert.equal(r.sent, true); assert.deepEqual(f.attacks, [2]); assert.equal(r.observedDrop, 0)
})
test('mace never hits a teammate or through a new wall', async () => {
  const f = fixture([item('mace')]); f.target.position = new Vec3(0, 64, -1); f.bot._ndSwarmAllies = ['enemy']
  assert.equal((await air.maceDive(f.bot, f.target, { maxTicks: 2 })).sent, false)
  f.bot._ndSwarmAllies = []; f.wall()
  assert.equal((await air.maceDive(f.bot, f.target, { maxTicks: 2 })).sent, false)
  assert.equal(f.attacks.length, 0)
})
test('charged spear holds real use ticks and clears its controls on abort', async () => {
  const f = fixture([item('iron_spear')]), ctl = { aborted: false }; const wait = f.bot.waitForTicks
  f.bot.waitForTicks = async n => { await wait(n); if (f.tick() >= 6) ctl.aborted = true }
  const r = await air.chargedSpear(f.bot, f.target, { ctl, maxTicks: 30, stand: true })
  assert.equal(r.started, true); assert.equal(r.readyTicks, 12); assert.equal(r.why, 'cancelled')
  assert.deepEqual(f.uses, ['iron_spear']); assert.equal(f.controls.jump, false)
})
test('charged spear installs the existing packet-time ally crossing guard', async () => {
  const f = fixture([item('iron_spear')]), ctl = { aborted: false }; f.bot._ndSwarmAllies = ['friend']
  const wait = f.bot.waitForTicks, deactivate = f.bot.deactivateItem, activate = f.bot.activateItem
  let ended = 0, stoppedAtPacket = false
  f.bot.activateItem = () => { activate(); f.bot.usingHeldItem = true }
  f.bot.deactivateItem = () => { ended++; deactivate(); f.bot.usingHeldItem = false }
  f.bot.waitForTicks = async n => {
    await wait(n)
    if (f.tick() !== 5) return
    f.bot.entities[3] = { id: 3, username: 'friend', name: 'player', type: 'player', isValid: true,
      position: new Vec3(3, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: .6, metadata: [] }
    f.bot.emit('physicTick'); stoppedAtPacket = ended > 1; ctl.aborted = true
  }
  await air.chargedSpear(f.bot, f.target, { ctl, maxTicks: 30 })
  assert.equal(stoppedAtPacket, true)
})
test('charged spear reports only its attributed public spear receipt and still holds the complete eighty-tick window', async () => {
  for (const received of [false, true]) {
    const f = fixture([item('iron_spear')]), activate = f.bot.activateItem
    const packet = { entityId: 2, sourceTypeId: 37, sourceCauseId: 2, sourceDirectId: 2 }
    f.bot.activateItem = () => {
      activate()
      for (const foreign of [{ sourceCauseId: 9 }, { sourceDirectId: 9 }, { entityId: 9 }, { sourceTypeId: 26 }])
        f.bot._client.emit('damage_event', { ...packet, ...foreign })
      if (received) { f.bot._client.emit('damage_event', packet); packet.sourceTypeId = 99 }
    }
    const result: any = await air.chargedSpear(f.bot, f.target, { maxTicks: 80, stand: true })
    assert.equal(result.contactObserved, received)
    assert.equal(result.ticks, 80); assert.equal(f.tick(), 83)
    assert.equal(result.why, 'contact_timeout', 'preserve the legacy field rather than changing hold behavior')
    assert.equal(result.endReason, 'max_ticks')
    if (received) {
      assert.deepEqual(result.firstReceipt.packet, { entityId: 2, sourceTypeId: 37, sourceCauseId: 2, sourceDirectId: 2 })
      assert.equal(result.firstReceipt.tick, 0, 'the listener is armed before activateItem')
    } else assert.equal(result.firstReceipt, null)
    assert.equal(f.bot._client.listenerCount('damage_event'), 0)
    assert.equal(f.controls.jump, false)
    f.bot._client.emit('damage_event', { ...packet, sourceTypeId: 37 })
    assert.equal(result.contactObserved, received)
  }
})
test('charged spear reports a public hit arriving after action cancellation while the own wait and observer are still pending', async () => {
  const f = fixture([item('iron_spear')]), ctl = { aborted: false }, wait = f.bot.waitForTicks
  f.bot.entities[2] = f.target
  let resume!: () => void, entered!: () => void
  const pending = new Promise<void>(resolve => { resume = resolve }), waiting = new Promise<void>(resolve => { entered = resolve })
  f.bot.waitForTicks = async n => {
    if (f.tick() >= 3) { entered(); await pending }
    await wait(n)
  }
  const action = air.chargedSpear(f.bot, f.target, { ctl, maxTicks: 80 })
  await waiting
  ctl.aborted = true
  const packet = { entityId: 2, sourceTypeId: 37, sourceCauseId: 2, sourceDirectId: 2 }
  assert.equal(f.bot._client.listenerCount('damage_event'), 1)
  f.bot._client.emit('damage_event', packet)
  resume() // The next native physics tick lets the existing loop observe its cancellation.
  const result: any = await action
  assert.equal(result.contactObserved, true); assert.deepEqual(result.firstReceipt.packet, packet)
  assert.equal(result.endReason, 'cancelled'); assert.equal(result.why, 'cancelled')
  assert.deepEqual(f.uses, ['iron_spear']); assert.equal(f.controls.jump, false)
  assert.equal(f.bot._client.listenerCount('damage_event'), 0)
})
test('charged spear rejects old-life receipts and removes receipt listeners on disconnect, target removal and activation failure', async () => {
  for (const kind of ['disconnect', 'gone', 'replaced', 'own_life', 'own_health', 'respawn', 'activate_error']) {
    const f = fixture([item('iron_spear')]), ctl = { aborted: false }, wait = f.bot.waitForTicks
    f.bot.entities[2] = f.target
    const packet = { entityId: 2, sourceTypeId: 37, sourceCauseId: 2, sourceDirectId: 2 }
    if (kind === 'activate_error') f.bot.activateItem = () => {
      assert.equal(f.bot._client.listenerCount('damage_event'), 1)
      throw new Error('activation failed')
    }
    f.bot.waitForTicks = async n => {
      await wait(n)
      if (f.tick() !== 5) return
      if (kind === 'gone') f.bot.emit('entityGone', f.target)
      if (kind === 'replaced') f.bot.entities[2] = { ...f.target }
      if (kind === 'own_life') f.bot.entity = { ...f.bot.entity }
      if (kind === 'own_health') f.bot.health = 0
      if (kind === 'respawn') f.bot.emit('respawn')
      if (kind === 'disconnect') { f.bot.emit('end'); throw new Error('native wait disconnected') }
      f.bot._client.emit('damage_event', packet)
    }
    const action = air.chargedSpear(f.bot, f.target, { ctl, maxTicks: 8 })
    if (kind === 'activate_error' || kind === 'disconnect') await assert.rejects(action, /activation failed|native wait disconnected/)
    else {
      const result: any = await action
      assert.equal(result.contactObserved, false, kind); assert.equal(result.firstReceipt, null, kind)
    }
    assert.equal(f.bot._client.listenerCount('damage_event'), 0, kind)
    for (const event of ['entityGone', 'entitySpawn', 'respawn', 'death']) assert.equal(f.bot.listenerCount(event), 0, `${kind}/${event}`)
    assert.equal(f.controls.jump, false, kind)
  }
})
test('cancelled aerial pass starts no rocket or spear action', async () => {
  const f = fixture()
  const r = await air.aerialPass(f.bot, f.target, { ctl: { aborted: true } })
  assert.equal(r.ok, false); assert.equal(f.uses.length, 0)
})
test('aerial pass cancels its existing flight when the target becomes an ally', async () => {
  const f = fixture([item('iron_spear')]), path = require.resolve('../src/combat/aerial-lance'); require(path)
  const cached = require.cache[path], original = cached.exports; let called = false
  cached.exports = { ...original, lance: async (_bot, ctl) => {
    called = true
    assert.equal(ctl.aborted, false)
    f.bot._ndSwarmAllies = ['enemy']
    return { ok: !ctl.aborted }
  } }
  try { assert.equal((await air.aerialPass(f.bot, f.target)).ok, false); assert.equal(called, true) }
  finally { cached.exports = original }
})
test('aerial pass cancels an active spear when the other flight lane crosses its ray', async () => {
  const f = fixture([item('iron_spear')]), path = require.resolve('../src/combat/aerial-lance'); require(path)
  const cached = require.cache[path], original = cached.exports; let called = false
  f.bot._ndSwarmAllies = ['friend']; f.bot.entity.yaw = -Math.PI / 2; f.bot.usingHeldItem = true
  cached.exports = { ...original, lance: async (_bot, ctl) => {
    called = true
    assert.equal(ctl.aborted, false)
    f.bot.entities[3] = { id: 3, username: 'friend', name: 'player', type: 'player', isValid: true,
      position: new Vec3(3, 64, 0), velocity: new Vec3(0, 0, 0), height: 1.8, width: .6, metadata: [] }
    return { ok: !ctl.aborted }
  } }
  try { assert.equal((await air.aerialPass(f.bot, f.target)).ok, false); assert.equal(called, true) }
  finally { cached.exports = original }
})
test('anti-mace splash refuses allies at the target and never reads enemy HP', async () => {
  const f = fixture()
  const r = await air.slowFallingAt(f.bot, f.target, { allies: [{ position: f.target.position }] })
  assert.equal(r.thrown, false); assert.equal(f.uses.length, 0)
})
test('anti-mace prototype throws an actual Slow Falling potion at a separated target', async () => {
  const potion: any = item('splash_potion'); potion.componentMap.set('potion_contents', { data: { potionId: 'slow_falling' } })
  const f = fixture([potion]); f.bot.world.raycast = (from, direction, length) => {
    const t = direction.y < 0 ? (64 - from.y) / direction.y : Infinity
    return t >= 0 && t <= length ? { intersect: from.plus(direction.scaled(t)), position: from.plus(direction.scaled(t)).floored() } : null
  }
  f.target.position.x = 5.46
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    const r = await air.slowFallingAt(f.bot, f.target)
    assert.equal(r.thrown, true, JSON.stringify(r)); assert.deepEqual(f.uses, ['splash_potion'])
  } finally { clearInterval(timer) }
})
test('Slow Falling splash notices an ally who entered while the potion was equipped', async () => {
  const potion: any = item('splash_potion'); potion.componentMap.set('potion_contents', { data: { potionId: 'slow_falling' } })
  const f = fixture([potion]); f.target.position.x = 5.46
  f.bot.world.raycast = (from, direction, length) => {
    const t = direction.y < 0 ? (64 - from.y) / direction.y : Infinity
    return t >= 0 && t <= length ? { intersect: from.plus(direction.scaled(t)), position: from.plus(direction.scaled(t)).floored() } : null
  }
  f.bot.equip = async it => {
    f.bot.heldItem = it; f.bot._ndSwarmAllies = ['friend']
    f.bot.entities[3] = { id: 3, username: 'friend', name: 'player', type: 'player', isValid: true,
      position: new Vec3(5.46, 64, .5), velocity: new Vec3(0, 0, 0), height: 1.8, width: .6, metadata: [] }
  }
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    assert.equal((await air.slowFallingAt(f.bot, f.target)).thrown, false); assert.equal(f.uses.length, 0)
  } finally { clearInterval(timer) }
})
test('Slow Falling delivery above a teammate does not confuse that lower teammate with a projectile impact', async () => {
  const potion: any = item('splash_potion'); potion.componentMap.set('potion_contents', { data: { potionId: 'slow_falling' } })
  const f = fixture([potion]); f.target.position.x = 5.46; f.bot._ndSwarmAllies = ['victim']
  const ally: any = { id: 3, username: 'victim', name: 'player', type: 'player', isValid: true,
    position: new Vec3(5.46, 56, 0), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: .6, metadata: [] }
  f.bot.entities[3] = ally
  f.bot.world.raycast = (from, direction, length) => {
    const t = direction.y < 0 ? (64 - from.y) / direction.y : Infinity
    return t >= 0 && t <= length ? { intersect: from.plus(direction.scaled(t)), position: from.plus(direction.scaled(t)).floored() } : null
  }
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    const r = await air.slowFallingAt(f.bot, f.target, { allies: [ally] })
    assert.equal(r.thrown, true, JSON.stringify(r)); assert.deepEqual(f.uses, ['splash_potion'])
  } finally { clearInterval(timer) }
})

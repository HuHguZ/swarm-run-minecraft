import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as pick from '../src/pick'
import { waterCatch } from '../src/swarm/combos/landing-rescue'

const cell = { x: 600, y: 151, z: 597 }
function fixture() {
  const bot: any = new EventEmitter(), ctl = { aborted: false }
  const bucket = { name: 'water_bucket', count: 1, slot: 36 }, items: any[] = [bucket]
  const ally: any = { id: 2, username: 'mace', name: 'player', type: 'player', isValid: true, _ndVisible: true,
    position: new Vec3(600.5, 160, 597.5), width: .6, height: 1.8 }
  let water = false, occupied = false, wall = false, floor = 'stone', uses = 0, ticks = 0, equips = 0, looks = 0
  const hooks: any = {}
  bot.username = 'support'; bot._ndSwarmAllies = ['mace']; bot.players = { mace: { gamemode: 0 } }
  bot.entity = { id: 1, position: new Vec3(600.5, 151, 601.5), yaw: 0, pitch: 0, onGround: true }
  bot.entities = { 1: bot.entity, 2: ally }; bot.game = { dimension: 'overworld' }
  Object.defineProperty(bot, 'health', { get() { throw Error('HP is not a water placement predicate') } })
  Object.defineProperty(ally, 'health', { get() { throw Error('ally HP is not a water placement predicate') } })
  bot.inventory = { items: () => items }; bot.heldItem = { name: 'wind_charge', slot: 37, count: 1 }
  bot.equip = async item => { equips++; bot.heldItem = item; hooks.equip?.() }
  bot.lookAt = async point => {
    looks++
    const d = point.minus(pick.eyeOf(bot))
    bot.entity.yaw = Math.atan2(-d.x, -d.z); bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    hooks.look?.(point)
  }
  bot.waitForTicks = async n => { for (let i = 0; i < n; i++) { ticks++; bot.emit('physicsTick'); hooks.tick?.() } }
  bot.activateItem = () => { uses++; hooks.use?.() }
  bot.blockAt = p => {
    const at = p.floored(), target = at.x === cell.x && at.y === cell.y && at.z === cell.z
    const solid = at.y === 150 || wall && at.z === 600 && at.y >= 151 || target && occupied
    const name = target && water ? 'water' : solid ? at.y === 150 ? floor : 'cobblestone' : 'air'
    return { name, stateId: name === 'air' ? 0 : name === 'water' ? 2 : name === 'stone' ? 1 : 3,
      position: at, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({}) }
  }
  bot.world = { raycast: (origin, direction, range, matcher) => {
    const hit = pick.blockOnRay(bot, origin, direction, range)
    if (!hit) return null
    const block = bot.blockAt(hit.pos)
    return matcher(block, { intersect: () => ({ face: 1 }) }) ? block : null
  } }
  bot.on('newListener', name => { if (name === 'ndMovementSent' && hooks.packet) queueMicrotask(() => hooks.packet()) })
  return { bot, ally, ctl, hooks, items, uses: () => uses, ticks: () => ticks, equips: () => equips, looks: () => looks,
    water: () => { water = true }, occupy: () => { occupied = true }, wall: () => { wall = true }, replaceFloor: () => { floor = 'dirt' } }
}

test('one real bucket use has distinct source-water and inventory receipts and no HP predicate', async () => {
  const f = fixture()
  f.hooks.use = () => { f.items.splice(0); f.bot.heldItem = { name: 'bucket' }; f.water() }
  const result = await waterCatch(f.bot, f.ally, cell, f.ctl)
  assert.equal(result.sent, true); assert.equal(result.waterObserved, true); assert.equal(result.bucketChanged, true)
  assert.equal(f.uses(), 1); assert.equal(f.equips(), 1); assert.equal(f.ticks(), 1)
  assert.ok(result.sentAt !== null && result.observedAt !== null)
  assert.equal(result.aim?.y, 151)
})

test('sham pays equip, aim and movement-packet preparation but never activates the bucket', async () => {
  const f = fixture(), result = await waterCatch(f.bot, f.ally, cell, f.ctl, false)
  assert.equal(result.why, 'sham'); assert.equal(result.sent, false)
  assert.equal(f.uses(), 0); assert.equal(f.equips(), 1); assert.equal(f.looks(), 1); assert.equal(f.ticks(), 1)
})

test('hidden or non-allied input is rejected before accessing its private position', async () => {
  for (const hidden of [true, false]) {
    const f = fixture()
    if (hidden) f.ally._ndVisible = false
    else f.bot._ndSwarmAllies = []
    Object.defineProperty(f.ally, 'position', { get() { throw Error('hidden ally geometry') } })
    const result = await waterCatch(f.bot, f.ally, cell, f.ctl)
    assert.equal(result.sent, false); assert.equal(f.equips(), 0)
  }
})

test('a wall appearing during look prevents the placement after await', async () => {
  const f = fixture(); f.hooks.look = f.wall
  const result = await waterCatch(f.bot, f.ally, cell, f.ctl)
  assert.equal(result.sent, false); assert.equal(f.uses(), 0); assert.equal(f.looks(), 1)
})

test('cancellation after looking and ally role change during equip both stop the pending use', async () => {
  const cancelled = fixture(); cancelled.hooks.tick = () => { cancelled.ctl.aborted = true }
  assert.equal((await waterCatch(cancelled.bot, cancelled.ally, cell, cancelled.ctl)).why, 'cancelled')
  const changed = fixture(); changed.hooks.equip = () => { changed.bot._ndSwarmAllies = [] }
  assert.equal((await waterCatch(changed.bot, changed.ally, cell, changed.ctl)).sent, false)
  assert.equal(changed.looks(), 0); assert.equal(cancelled.uses() + changed.uses(), 0)
})

test('packet-time guards catch a new wall, lost ally role, changed held item and moved body', async () => {
  for (const change of ['wall', 'role', 'hand', 'move']) {
    const f = fixture()
    f.hooks.packet = () => {
      if (change === 'wall') f.wall()
      if (change === 'role') f.bot._ndSwarmAllies = []
      if (change === 'hand') f.bot.heldItem = { name: 'bucket' }
      if (change === 'move') f.bot.entity.position.z = 606.5
    }
    assert.equal((await waterCatch(f.bot, f.ally, cell, f.ctl)).sent, false, change)
    assert.equal(f.uses(), 0, change)
  }
})

test('a player crossing the pointed ray during look or packet release prevents pouring through that player', async () => {
  for (const phase of ['look', 'packet']) {
    const f = fixture()
    f.hooks[phase] = () => { f.bot.entities[3] = { id: 3, username: 'foe', name: 'player', type: 'player',
      position: new Vec3(600.5, 151, 599.5), width: .6, height: 1.8, isValid: true } }
    const result = await waterCatch(f.bot, f.ally, cell, f.ctl)
    assert.equal(result.sent, false); assert.equal(f.uses(), 0)
  }
})

test('an alternate visible face does not authorize pouring along the original newly obstructed ray', async () => {
  const f = fixture()
  let alternateVisible = false
  f.hooks.look = (original: Vec3) => {
    f.bot.entities[3] = { id: 3, name: 'slime', type: 'mob', position: new Vec3(600.5, 151.6, 599.5),
      width: .08, height: .4, isValid: true }
    const alternate = pick.faceAim(f.bot, new Vec3(600, 150, 597), new Vec3(0, 1, 0))
    alternateVisible = !!alternate && !alternate.equals(original)
  }
  const result = await waterCatch(f.bot, f.ally, cell, f.ctl)
  assert.equal(result.sent, false)
  assert.equal(alternateVisible, true); assert.equal(f.uses(), 0)
  assert.equal(result.detail?.stage, 'after_look')
  assert.equal(result.detail?.check, 'entity_blocks_view')
})

test('quantized native look remains legal when its actual ray still reaches the intended water cell', async () => {
  for (const [dyaw, dpitch] of [[-.0011158278052672552, -.00035758074315028754], [.0007692823750981, -.0009559142401198]]) {
    const f = fixture()
    f.bot.entity.position.set(601.5379964955434, 151, 600.7694252006778)
    f.hooks.look = () => { f.bot.entity.yaw += dyaw; f.bot.entity.pitch += dpitch }
    f.hooks.use = () => { f.items.splice(0); f.water() }
    const result = await waterCatch(f.bot, f.ally, cell, f.ctl)
    assert.equal(result.sent, true); assert.equal(result.waterObserved, true); assert.equal(f.uses(), 1)
    assert.deepEqual(result.actualView?.blockCell, { x: 600, y: 150, z: 597 })
    assert.deepEqual(result.actualView?.waterCell, cell)
    assert.notDeepEqual(result.actualView?.hitPoint, result.aim)
    assert.equal(result.actualView?.yaw, f.bot.entity.yaw)
    assert.equal(result.actualView?.pitch, f.bot.entity.pitch)
  }
})

test('a concurrent turn that takes the actual ray away from the target still prevents pouring', async () => {
  for (const phase of ['look', 'packet']) {
    const f = fixture(); f.hooks[phase] = () => { f.bot.entity.yaw += Math.PI / 2 }
    const result = await waterCatch(f.bot, f.ally, cell, f.ctl)
    assert.equal(result.sent, false); assert.equal(f.uses(), 0)
    assert.equal(result.detail?.check, 'view_lands_elsewhere')
  }
})

test('replaced floor and newly occupied source cell are rechecked after look', async () => {
  for (const change of ['floor', 'cell']) {
    const f = fixture(); f.hooks.look = change === 'floor' ? f.replaceFloor : f.occupy
    assert.equal((await waterCatch(f.bot, f.ally, cell, f.ctl)).sent, false)
    assert.equal(f.uses(), 0)
  }
})

test('existing water is a no-fire result and is never credited as this rescue', async () => {
  const f = fixture(); f.water()
  const result = await waterCatch(f.bot, f.ally, cell, f.ctl)
  assert.equal(result.why, 'water_already'); assert.equal(result.sent, false); assert.equal(result.waterObserved, false)
  assert.equal(f.equips(), 0); assert.equal(f.uses(), 0)
})

test('emptying inventory without a water block cannot count as a water receipt', async () => {
  const f = fixture(); f.hooks.use = () => { f.items.splice(0); f.bot.heldItem = { name: 'bucket' } }
  const started = performance.now(), result = await waterCatch(f.bot, f.ally, cell, f.ctl)
  assert.equal(result.sent, true); assert.equal(result.bucketChanged, true); assert.equal(result.waterObserved, false)
  assert.ok(performance.now() - started >= 1000)
  assert.ok(performance.now() - started < 1500)
})

test('receipt wait notices ally death but a foe death does not cancel a successful catch', async () => {
  const dead = fixture(); dead.hooks.use = () => queueMicrotask(() => dead.bot.emit('entityDead', dead.ally))
  const started = performance.now(), result = await waterCatch(dead.bot, dead.ally, cell, dead.ctl)
  assert.equal(result.sent, true); assert.equal(result.why, 'cancelled'); assert.ok(performance.now() - started < 500)
  const foe = fixture(); foe.hooks.use = () => {
    foe.bot.emit('entityDead', { id: 3 }); foe.items.splice(0); foe.water()
  }
  assert.equal((await waterCatch(foe.bot, foe.ally, cell, foe.ctl)).waterObserved, true)
})

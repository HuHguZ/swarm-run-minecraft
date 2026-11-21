import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as ranged from '../src/ranged'
import * as spear from '../src/spear'
import { aerialMethods } from '../src/rpc/aerial'
import { seesPlayer, gearPartVisible } from '../src/pvp/last-seen'

const registry = require('minecraft-data')('1.21.11'), Item = require('prismarine-item')(registry)
const active = registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
const item = (name: string, components = []) => Item.fromNotch({ itemId: registry.itemsByName[name].id, itemCount: 1, components, removeComponents: [] })
const punchBow = (level: number) => item('bow', [{ type: 'enchantments', data: { enchantments: [{ id: registry.enchantmentsByName.punch.id, level }] } }])

function fixture(t) {
  const body = (id, username, z) => ({ id, username, type: 'player', position: new Vec3(.5, 64, z), velocity: new Vec3(0, 0, 0),
    metadata: [], equipment: [], height: 1.8, width: .6, isValid: true, onGround: true })
  const me = body(1, 'Archer', .5), ally = body(2, 'Lancer', -2.5), foe = body(3, 'Enemy', -6.5)
  let wall = false, released = 0, drawn = 0, packet: () => void
  const bow = punchBow(2), swaps = []
  bow.slot = 36
  ally.equipment[0] = item('iron_spear'); ally.metadata[active] = 1
  const bot: any = Object.assign(new EventEmitter(), { entity: me, username: 'Archer', players: { Lancer: { entity: ally }, Enemy: { entity: foe } },
    entities: { 2: ally, 3: foe }, _client: new EventEmitter(), registry,
    heldItem: bow, quickBarSlot: 0, inventory: { items: () => [bow, { name: 'arrow', count: 5 }], slots: [] }, equip: async () => {}, look: async () => {},
    waitForTicks: async () => {}, activateItem: () => { drawn++ }, deactivateItem: () => { released++; bot.emit('entityHurt', ally) },
    setQuickBarSlot: i => { swaps.push(i); bot.quickBarSlot = i }, world: { raycast: () => wall },
    blockAt: p => ({ name: wall && p.z === -1 ? 'stone' : 'air', boundingBox: wall && p.z === -1 ? 'block' : 'empty', position: p }) })
  const ctl = { aborted: false, onAbort: [] }
  const session = { bot, require: () => bot, runIntent: (_name, worker) => worker(ctl) }
  t.mock.method(ranged, 'readyArrow', async () => true)
  t.mock.method(spear, 'afterPacket', (_bot, next) => { packet = next })
  const rpc = aerialMethods({ session } as any)
  return { rpc, bot, foe, ally, ctl, swaps, get drawn() { return drawn }, get released() { return released },
    wall() { wall = true }, async draw() { await new Promise(resolve => setImmediate(resolve)); for (let n = 0; n < 38 && !packet; n++) bot.emit('physicsTick') },
    packet: () => packet?.(), abort() { ctl.aborted = true; for (const fn of [...ctl.onAbort]) fn() } }
}

for (const mode of ['visible', 'backpack bow', 'hidden ally', 'hidden foe', 'late wall', 'late arc obstacle', 'late abort', 'late sidestep', 'late invisible foe', 'new slot'] as const) {
  test('arrow boost RPC preserves sight and the owning draw: ' + mode, async t => {
    const f = fixture(t)
    if (mode === 'hidden ally') { f.ally.metadata[0] = 0x20; f.ally.equipment = [] }
    if (mode === 'hidden foe') f.foe.metadata[0] = 0x20
    if (mode === 'backpack bow') {
      f.bot.inventory.items()[0].slot = 9; f.bot.heldItem = null
      f.bot.equip = async item => { f.bot.heldItem = { ...item, slot: 36 } }
    }
    const pending = f.rpc.boost_shot({ ally: 'Lancer', foe: 'Enemy', draw: 3 })
    await f.draw()
    if (mode === 'late wall') f.wall()
    if (mode === 'late abort') f.abort()
    if (mode === 'late sidestep') f.ally.position.x += 2
    if (mode === 'late arc obstacle') f.bot.world.raycast = () => ({ name: 'stone' })
    if (mode === 'late invisible foe') f.foe.metadata[0] = 0x20
    if (mode === 'new slot') { f.bot.quickBarSlot = 3; f.bot.heldItem = { name: 'shield', slot: 39 } }
    f.packet()
    const result = await pending
    const fires = mode === 'visible' || mode === 'backpack bow'
    assert.equal(result.ok, fires)
    assert.equal(f.released, Number(fires))
    assert.equal(f.drawn, mode.startsWith('hidden') ? 0 : 1)
    assert.equal(f.bot.listenerCount('entityHurt'), 0)
    if (mode.startsWith('late')) assert.ok(f.swaps.length > 0, 'cancel the drawn bow by slot change')
    if (mode === 'new slot') assert.deepEqual(f.swaps, [], 'leave the replacement equipment alone')
  })
}

test('lance RPC loses an invisible target and the pearl keeps only its reported landing', async t => {
  const f = fixture(t), snapshots: any[] = []
  t.mock.method(spear, 'spearOf', () => ({ item: { name: 'iron_spear' } }))
  t.mock.method(spear, 'charge', async (_bot, _ctl, target) => {
    snapshots.push([target.isValid, target.position?.clone(), target.id])
    f.foe.metadata[0] = 0x20
    f.foe.position.x += 1
    snapshots.push([target.isValid, target.position?.clone(), target.id])
    return { ok: true }
  })
  const lost = await f.rpc.boost_lance({ foe: 'Enemy' })
  assert.equal(lost.ok, false); assert.equal(lost.why, 'врага не вижу')
  assert.deepEqual(snapshots, [[true, new Vec3(.5, 64, -6.5), 3], [false, undefined, undefined]])
  assert.equal((await f.rpc.boost_lance({ foe: 'Enemy' })).ok, false)
  snapshots.length = 0
  const at = new Vec3(.5, 64, -6.5)
  await f.rpc.boost_lance({ foe: 'Enemy', at, eta: 0 })
  assert.deepEqual(snapshots, [[true, at, undefined], [true, at, undefined]])
  f.foe.metadata[0] = 0; snapshots.length = 0
  await f.rpc.boost_lance({ foe: 'Enemy', at, eta: 0 })
  assert.deepEqual(snapshots, [[true, new Vec3(2.5, 64, -6.5), 3], [true, at, undefined]])
})

test('a queued pearl boost cannot start after arrival or release a drawn arrow after its launch window', async t => {
  const f = fixture(t), at = new Vec3(.5, 64, -6.5)
  f.bot.ndClock = { age: 100n, serverTicks: 0, ticks: 55 }
  let charges = 0
  t.mock.method(spear, 'spearOf', () => ({ item: { name: 'iron_spear' } }))
  t.mock.method(spear, 'charge', async () => { charges++; return { ok: true } })
  const msg = { at, eta: 12, gameTick: 100, foe: 'Enemy', ally: 'Lancer', draw: 3 }
  const lateLance = await f.rpc.boost_lance(msg)
  assert.equal(lateLance.ok, false)
  assert.equal(charges, 0)
  const lateShot = f.rpc.boost_shot(msg)
  await f.draw(); f.packet()
  assert.equal((await lateShot).ok, false)
  assert.equal(f.drawn, 0)

  f.bot.ndClock.ticks = 0
  const pending = f.rpc.boost_shot({ ...msg, eta: 11 })
  await f.draw()
  assert.equal(f.drawn, 1, 'a fresh shared intercept can draw')
  f.bot.ndClock.ticks = 12
  f.packet()
  assert.equal((await pending).ok, false)
  assert.equal(f.released, 0, 'the packet queue consumed the remaining flight time')
})

for (const mode of ['main spear', 'offhand spear', 'food', 'offhand shield', 'idle', 'unknown layout', 'hidden hand', 'plain bow', 'weaker Punch'] as const) {
  test('arrow boost requires a currently visible active spear and Punch at release: ' + mode, async t => {
    const f = fixture(t)
    assert.equal(active, 8)
    if (mode === 'unknown layout') f.bot.registry = { ...registry, entitiesByName: { player: { metadataKeys: [] } } }
    const pending = f.rpc.boost_shot({ ally: 'Lancer', foe: 'Enemy', draw: 3 })
    await f.draw()
    if (mode === 'offhand spear') { f.ally.metadata[active] = 3; f.ally.equipment = [item('shield'), item('iron_spear')] }
    if (mode === 'food') f.ally.equipment = [item('bread'), item('iron_spear')]
    if (mode === 'offhand shield') { f.ally.metadata[active] = 3; f.ally.equipment = [item('iron_spear'), item('shield')] }
    if (mode === 'idle') f.ally.metadata[active] = 0
    if (mode === 'plain bow') { f.bot.heldItem = item('bow'); f.bot.heldItem.slot = 36 }
    if (mode === 'weaker Punch') { f.bot.heldItem = punchBow(1); f.bot.heldItem.slot = 36 }
    if (mode === 'hidden hand') {
      const original = f.bot.blockAt
      f.bot.blockAt = p => p.z === -2 && (p.y === 64 || p.y === 65) ? { name: 'stone_slab', boundingBox: 'block', position: p,
        shapes: [[0, 0, 0, 1, p.y === 65 ? .5 : 1, 1]] } : original(p)
      assert.equal(seesPlayer(f.bot, f.ally), true)
      assert.equal(gearPartVisible(f.bot, f.ally, 0), false)
    }
    f.packet()
    const fires = mode === 'main spear' || mode === 'offhand spear'
    assert.equal((await pending).ok, fires)
    assert.equal(f.released, Number(fires))
  })
}

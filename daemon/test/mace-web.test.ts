import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import * as pick from '../src/pick'
import { maceDefenseTurn } from '../src/pvp/turn-mace'
const threats: typeof import('../src/threats') = require('../src/threats')

const data = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')(data)

test('mace defence webs the predicted landing through a visible face and retains its shield fallback', async t => {
  const bot: any = new EventEmitter(), cells = new Map(), placements = [], notes = []
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), metadata: [], height: 1.8 }
  bot.entities = {}; bot.registry = data; bot.health = 20; bot.food = 20
  bot.heldItem = { name: 'sword' }; bot.player = { ping: 0 }
  bot.inventory = { slots: Array(46).fill(null) }; bot.inventory.slots[36] = { name: 'cobweb', slot: 36, count: 16 }
  bot.inventory.slots[45] = { name: 'shield' }
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  const block = (p, name) => { const b = Block.fromStateId(data.blocksByName[name].defaultState); b.position = p.floored(); return b }
  bot.blockAt = p => cells.get(p.floored().toString()) || block(p, p.y < 64 ? 'stone' : 'air')
  bot.setQuickBarSlot = slot => { bot.heldItem = bot.inventory.slots[36 + slot] }
  bot.lookAt = async () => {}
  bot._placeBlockWithOptions = async (ref, face, options) => {
    const at = ref.position.plus(face); placements.push(at)
    assert.equal(options.forceLook, 'ignore')
    assert.ok(pick.faceAim(bot, ref.position, face))
    cells.set(at.toString(), block(at, 'cobweb'))
  }
  const place = bot._placeBlockWithOptions
  let sm: any = { name: 'Foe', ticks: 10, at: { x: 2.5, y: 65.5, z: .5 },
    from: { x: 2.5, y: 73.6, z: .5 }, vel: { x: 0, y: -.4, z: 0 } }
  t.mock.method(threats, 'smashes', () => [sm])
  let raised = 0
  const guard: any = { stats: { worn: true }, blocking: () => false, raise: () => { raised++ } }
  const threat: any = { kind: 'air', eta: 10, dh: 2, vy: -.4 }
  const ctx: any = { bot, guard, ctl: { aborted: false }, prof: { player: true }, maceTotem: true,
    entity: { username: 'Foe', position: new Vec3(2.5, 72, .5) }, mc: { threat: () => threat, st: { shieldUps: 0 } },
    track: { vel: () => sm.vel }, pathTo() {}, set() {}, pvpSkills: {}, ready: () => true, rest() {}, used: s => notes.push(s),
    holdWeapon: async () => { bot.heldItem = { name: 'sword' } }, sleep: async () => {} }
  await maceDefenseTurn(ctx, { hp: 20, now: 0, r: 5 } as any)
  assert.deepEqual(placements.map(p => [p.x, p.y, p.z]), [[2, 64, 0]])
  assert.equal(raised, 1, 'placement does not prove that the attacker has entered the web')
  assert.ok(notes.some(s => /паутин/.test(s)))
  cells.clear(); threat.webTried = false; threat.shielded = false
  guard.traceState = () => ({ want: true })
  const beforeRaise = placements.length
  await maceDefenseTurn(ctx, { hp: 20, now: 0, r: 5 } as any)
  assert.equal(placements.length, beforeRaise, 'an already rising shield must finish its five-tick delay')

  const { webSmash } = require('../src/mace/web')
  for (const change of ['late', 'deadline', 'shield_in_bag', 'unknown_motion', 'own_column', 'occupied', 'occluded', 'out_of_reach', 'not_hotbar', 'shield_up', 'cancelled', 'cancel_during_aim', 'prediction_changed', 'server_refused']) {
    cells.clear(); sm = { ...sm, from: { x: 2.5, y: 73.6, z: .5 }, vel: { x: 0, y: -.4, z: 0 } }
    bot.inventory.slots[36] = { name: 'cobweb', slot: 36, count: 16 }; bot.heldItem = { name: 'sword' }
    const opts: any = { ctl: { aborted: false } }
    bot.lookAt = async () => {}; bot._placeBlockWithOptions = place
    if (change === 'late') sm.from.y = 67
    if (change === 'deadline') opts.deadlineTicks = 3
    if (change === 'shield_in_bag') opts.shieldTicks = 11
    if (change === 'unknown_motion') sm.vel = null
    if (change === 'own_column') sm.from.x = .5
    if (change === 'occupied') for (let y = 64; y < 77; y++) cells.set(new Vec3(2, y, 0).toString(), block(new Vec3(2, y, 0), 'stone'))
    if (change === 'occluded') for (let y = 64; y < 77; y++) cells.set(new Vec3(1, y, 0).toString(), block(new Vec3(1, y, 0), 'stone'))
    if (change === 'out_of_reach') sm.from.x = 9.5
    if (change === 'not_hotbar') bot.inventory.slots[36] = null
    if (change === 'shield_up') opts.shieldTicks = 0
    if (change === 'cancelled') opts.ctl.aborted = true
    if (change === 'cancel_during_aim') bot.lookAt = async () => { opts.ctl.aborted = true }
    if (change === 'prediction_changed') bot.lookAt = async () => { sm.from.x = .5 }
    if (change === 'server_refused') bot._placeBlockWithOptions = async () => {}
    const before = placements.length
    assert.equal((await webSmash(bot, 'Foe', opts)).placed, false, change)
    assert.equal(placements.length, before, change)
  }
  cells.clear(); bot.lookAt = async () => {}; bot._placeBlockWithOptions = place
  sm.from = { x: 2.5, y: 101.6, z: .5 }; sm.vel = { x: 0, y: -4, z: 0 }
  assert.equal((await webSmash(bot, 'Foe')).placed, true, 'a fast fall crosses the web cell between ticks')
  assert.deepEqual(placements.at(-1), new Vec3(2, 64, 0))

  // Своя рамка занята, но над головой можно перехватить булаву через видимую грань стены.
  cells.clear(); sm.from = { x: .5, y: 75.6, z: .5 }; sm.vel = { x: 0, y: -.4, z: 0 }
  cells.set(new Vec3(1, 66, 0).toString(), block(new Vec3(1, 66, 0), 'stone'))
  assert.ok(pick.faceAim(bot, new Vec3(1, 66, 0), new Vec3(-1, 0, 0)), 'reference face is visible')
  const overhead = await webSmash(bot, 'Foe')
  assert.ok(overhead.placed, 'a web above the head does not trap the defender: ' + JSON.stringify(overhead))
  assert.deepEqual(placements.at(-1), new Vec3(0, 66, 0))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { trade } from '../src/crystal'
import * as boom from '../src/boom'
import { worthHit } from '../src/crystal/scoring'
import { createActions } from '../src/crystal/actions'
import { runAnchor } from '../src/crystal/run'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

function fixture() {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.username = 'Me'; bot.health = 20; bot.food = 20; bot.game = { difficulty: 'normal', dimension: 'overworld' }
  const player = (id, username, x): any => ({ id, username, name: 'player', type: 'player', position: new Vec3(x, 0, .5), width: .6, height: 1.8, metadata: [], equipment: [], isValid: true })
  bot.entity = player(1, 'Me', .5)
  const foe = player(2, 'Foe', 3.5), ally = player(3, 'Ally', 100)
  for (const e of [foe, ally]) Object.defineProperty(e.metadata, 9, { get() { throw new Error('player health metadata is not a policy input') } })
  bot.entities = { 1: bot.entity, 2: foe, 3: ally }
  const team = { team: 'blue', friendlyFire: 1 }
  bot.teamMap = { Me: team, Ally: team, Foe: { team: 'red', friendlyFire: 1 } }
  const ench = name => ({ name, count: 1, componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'minecraft:protection', level: 4 }] } }]]) })
  const armor = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'].map(ench)
  const sword = { name: 'diamond_sword', count: 1, slot: 36 }, slots: any[] = []
  armor.forEach((item, i) => { slots[5 + i] = item }); slots[36] = sword
  foe.equipment = [null, null, armor[3], armor[2], armor[1], armor[0]]
  bot.inventory = { slots, items: () => [sword] }
  bot.quickBarSlot = 0; bot.heldItem = sword
  bot.setQuickBarSlot = () => {}; bot.lookAt = async () => {}
  let hits = 0, shots = 0, clicks = 0
  bot.attack = () => { hits++ }
  const anchor = new Vec3(5, 0, 0)
  bot.blockAt = p => {
    const q = p.floored(), name = q.equals(anchor) ? 'respawn_anchor' : q.y === -1 ? 'obsidian' : 'air'
    return { name, position: q, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ charges: 1 }) }
  }
  bot.world = { raycast: () => null }
  bot._genericPlace = async (b, f, opts) => {
    if (opts.forceLook !== 'ignore') await bot.lookAt(b.position.offset(.5, .5, .5), opts.forceLook)
    clicks++
  }
  const S: any = { bot, st: {}, enemy: () => foe, hisHp: () => 20, mine: new Map(), fail: () => {}, inWin: () => null,
    noteBlast: () => {}, cellKey: p => `${p.x},${p.y},${p.z}` }
  const deps: any = { boom: { ...boom, shootAt: async (_b, _c, _e, opts) => {
    ally.position = new Vec3(3.5, 0, 1.5)
    const stopped = opts.shouldStop(); if (!stopped) shots++
    return { shot: !stopped }
  } }, trade, CX2: true, gameClock: { now: () => 1000 }, sleep: async () => {} }
  const actions = createActions(S, deps); Object.assign(S, actions)
  const c = { id: 4, name: 'end_crystal', position: new Vec3(3.5, 0, .5), isValid: true }
  bot.entities[4] = c
  const exchange = (power = 6) => trade(bot, c.position, foe, bot.entity, boom.defenseOf(bot, foe), boom.defenseOf(bot, bot.entity), new Map(), { power })
  return { bot, ally, foe, team, S, deps, actions, c, anchor, exchange, count: () => ({ hits, shots, clicks }) }
}

test('known ally blast damage blocks an otherwise profitable trade without reading player HP', () => {
  const f = fixture(), before = f.exchange()
  assert.equal(worthHit(before, { myEff: 20, hisEff: 20, hisLand: before.him }), true, JSON.stringify(before))
  f.ally.position = new Vec3(3.5, 0, 1.5)
  const t: any = f.exchange()
  assert.ok(t.allyDamage > 0)
  assert.equal(worthHit(t, { myEff: 20, hisEff: 20, hisLand: t.him }), false)
})

test('friendly-fire cancellation removes crystal HP cost but leaves physical ally knockback; anchors remain ownerless', () => {
  const f = fixture(); f.ally.position = new Vec3(3.5, 0, 1.5); f.team.friendlyFire = 2
  const crystal: any = f.exchange(), anchor: any = f.exchange(5)
  assert.equal(crystal.allyDamage, 0, 'scoreboard bit 0 cancels player-attributed damage')
  assert.ok(crystal.allyPush > 0, 'ServerExplosion pushes after hurtServer returned false')
  assert.ok(anchor.allyDamage > 0, 'ownerless anchor cannot use friendly-fire cancellation')
  assert.equal(worthHit(crystal, { myEff: 20, hisEff: 20, hisLand: crystal.him }), false)
})

test('native crystal hit rechecks an ally who enters during the awaited look', async () => {
  const f = fixture()
  assert.equal(f.actions.freshWorth(f.c.position).ok, true)
  f.bot.lookAt = async () => { f.ally.position = new Vec3(3.5, 0, 1.5) }
  assert.equal(await f.actions.hit(f.c), false)
  assert.equal(f.count().hits, 0)
})

test('bow draw cancels when an ally enters the crystal blast', async () => {
  const f = fixture()
  assert.equal(await f.actions.shoot({ aborted: false }, f.c, {}), false)
  assert.equal(f.count().shots, 0)
})

test('native anchor pop rechecks after look instead of letting genericPlace await beyond the check', async () => {
  const f = fixture()
  f.anchor.x = 3
  const before: any = { ok: false }
  await runAnchor(f.S, f.deps, { aborted: false }, { kind: 'anchorPop', cell: f.anchor }, {}, before, f.foe)
  assert.equal(before.ok, true, 'the visible charged anchor is usable before the ally approaches')
  f.bot.lookAt = async () => { f.ally.position = new Vec3(3.5, 0, 1.5) }
  const out: any = { ok: false }
  await runAnchor(f.S, f.deps, { aborted: false }, { kind: 'anchorPop', cell: f.anchor }, {}, out, f.foe)
  assert.equal(out.ok, false)
  assert.equal(f.count().clicks, 1, 'only the earlier safe click reached the native action')
})

test('own charged anchor stays intact when an ally approaches during the detonation look', async () => {
  const f = fixture(); f.anchor.x = 3
  const glowstone = { name: 'glowstone', count: 2, slot: 37 }
  f.bot.inventory.slots[37] = glowstone
  f.bot.inventory.items = () => [f.bot.inventory.slots[36], glowstone]
  f.S.myAnchorCells = new Set()
  f.deps.placeBlockAt = async () => ({ ok: true })
  let looks = 0
  f.bot.lookAt = async () => { if (++looks === 2) f.ally.position = new Vec3(3.5, 0, 1.5) }
  const out: any = { ok: false }
  await runAnchor(f.S, f.deps, { aborted: false }, { kind: 'anchor', cell: f.anchor }, {}, out, f.foe)
  assert.equal(out.ok, false)
  assert.equal(f.count().clicks, 1, 'charge reached native use; detonation did not')
})

test('moving the ally clear makes the same crystal immediately usable again', async () => {
  const f = fixture(); f.ally.position = new Vec3(3.5, 0, 1.5)
  assert.equal(await f.actions.hit(f.c), false)
  f.ally.position = new Vec3(100, 0, .5)
  assert.equal(await f.actions.hit(f.c), true)
  assert.equal(f.count().hits, 1)
})

test('known spectator teammates are not physical blast victims', () => {
  const f = fixture(); f.ally.position = new Vec3(3.5, 0, 1.5)
  f.bot.players = { Ally: { gamemode: 3 } }
  const t: any = f.exchange()
  assert.equal(t.allyDamage, 0)
  assert.equal(t.allyPush, 0)
  assert.equal(worthHit(t, { myEff: 20, hisEff: 20, hisLand: t.him }), true)
})

test('a lost target during look cannot bypass the final ally-risk decision', async () => {
  const f = fixture()
  f.bot.lookAt = async () => { f.foe.isValid = false; f.ally.position = new Vec3(3.5, 0, 1.5) }
  assert.equal(await f.actions.hit(f.c), false)
  assert.equal(f.count().hits, 0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as esbuild from 'esbuild'

function source(name: string, overrides: Record<string, any> = {}) {
  const file = path.resolve(__dirname, '../src', name + '.ts'), local = createRequire(file), module = { exports: {} as any }
  const code = esbuild.transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap(code), { filename: file })(module.exports,
    (id: string) => overrides[id] ?? local(id), module, file, path.dirname(file))
  return module.exports
}

function fixture(hp = 20) {
  const bot: any = new EventEmitter(), cells = new Map(), control: any = {}, calls: any[] = [], notes: string[] = []
  const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11'), Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
  let now = 5000
  const clock = { now: () => now, setTimeout, clearTimeout }
  bot.registry = registry; bot.health = hp; bot.food = 20; bot._client = new EventEmitter(); bot.version = '1.21.11'
  bot.entity = { id: 1, name: 'player', position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), width: .6, height: 1.8, onGround: true, effects: {}, metadata: [] }
  bot.entities = {}; bot.inventory = { slots: [], items: () => [{ name: 'dirt', type: registry.itemsByName.dirt.id, count: 64 }] }
  bot.blockAt = p => {
    const at = p.floored(), b = Block.fromStateId(registry.blocksByName[cells.get(at.toString()) || (at.y < 64 ? 'stone' : 'air')].defaultState)
    b.position = at; return b
  }
  bot.lookAt = async () => {}; bot.look = async () => {}; bot.equip = async i => { bot.heldItem = i }
  bot.setControlState = (k, v) => { control[k] = v }; bot.getControlState = k => !!control[k]
  bot.clearControlStates = () => { for (const k of Object.keys(control)) control[k] = false }
  bot.nearestEntity = () => null; bot.pathfinder = { setGoal: () => {}, movements: {} }
  const put = (ref, face, opts) => {
    const at = ref.position.plus(face); calls.push({ at, opts }); cells.set(at.toString(), bot.heldItem.name)
    bot.emit('blockUpdate', null, bot.blockAt(at)); return Promise.resolve()
  }
  bot._placeBlockWithOptions = put; bot.placeBlock = put; bot._genericPlace = put
  const sleep = async ms => {
    now += ms
    bot.entity.position.y = control.jump ? 65 : 64; bot.entity.onGround = !control.jump
    bot.emit('physicsTick')
  }
  const pick = source('pick'), build = source('build', { './game-clock': clock, './movement': { sleep } })
  const fortify = source('fortify', { './game-clock': clock, './movement': { sleep }, './build': build, './pick': pick })
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const fn of [...this.onAbort]) fn() } }
  const enemy: any = { id: 2, username: 'Enemy', name: 'player', type: 'player', position: new Vec3(2.5, 64, .5), width: .6, height: 1.8, isValid: true, metadata: [], equipment: [{ name: 'iron_sword' }] }
  const ctx: any = { bot, ctl, entity: enemy, prof: { player: true }, FIX: true, Vec3, pick, fortify, gameClock: clock,
    st: { build: { refused: 0, aborted: 0, box: 0, boxMs: [] } }, style: { reactMs: 150 }, BOX_MS: 2500, BOX_FRONT_MS: 1300,
    tt: { myHurtAt: 0, eta: () => 0, threats: () => [enemy] }, tempo: { PLAYER_REACH: 3 }, process: { env: {} },
    blockName: (_bot, p) => bot.blockAt(p).name, onFire: () => false, hasEffect: () => false,
    maceNow: () => false, ready: () => true, rest: () => {}, used: s => notes.push(s),
    pickFiller: build.pickFiller, countOf: () => 64, pathTo: () => {}, clear: bot.clearControlStates,
    holdWeapon: async () => {}, cooldownMs: () => 675, aim: 'target', pathing: false,
    reachFrom: () => 2, sleep }
  Object.assign(ctx, source('pvp/cover').createCover(ctx))
  ctx.fortSpot = () => fortify.feetCell(bot)
  return { bot, cells, calls, notes, ctl, enemy, ctx, fortify, control }
}

test('an enemy occupying a required wall refuses a box before centering or sending placement packets', async () => {
  const f = fixture(); f.enemy.position.x = 1.5; f.bot.entities[2] = f.enemy
  const out = await f.fortify.boxIn(f.bot, { toward: f.enemy.position, ctl: f.ctl })
  assert.equal(out.sealed, false); assert.equal(out.placed, 0); assert.equal(f.calls.length, 0)
  assert.match(out.why, /в клетке стоит/)
})

test('low HP and an immediately reachable visible enemy cannot trade a whole shelter for lethal incoming hits', async () => {
  const f = fixture(6); f.bot.entities[2] = f.enemy
  f.enemy.metadata = new Proxy([], { get(target, property) { if (String(property) === '9') throw Error('enemy health is private'); return target[property] } })
  Object.defineProperty(f.enemy.equipment[0], 'enchants', { get() { throw Error('enemy enchantments are private') } })
  f.ctx.tt.eta = () => 1600
  f.ctx.fortify = { ...f.fortify, boxIn: async () => { f.calls.push({ box: true }); return { cell: f.fortify.feetCell(f.bot), walls: 0, roof: false, placed: 0 } } }
  assert.equal(await f.ctx.fortOut(), false)
  assert.equal(f.calls.length, 0); assert.equal(f.ctx.fort, undefined); assert.equal(f.ctx.aim, 'target')
})

test('a shared box aborts immediately when hit during an unconfirmed placement', async () => {
  const f = fixture(8)
  f.bot._placeBlockWithOptions = async (_ref, _face, opts) => {
    f.calls.push({ opts }); f.bot.health = 4; f.bot.emit('health'); await new Promise(() => {})
  }
  const out = await f.fortify.boxIn(f.bot, { toward: f.enemy.position, ctl: f.ctl, timeoutMs: 3000 })
  assert.equal(out.aborted, true); assert.equal(out.sealed, false); assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].opts.forceLook, 'ignore'); assert.equal(f.bot.listenerCount('health'), 0)
})

test('a wounded duelist puts its weapon back before clicking when a player enters the door during the aim', async () => {
  const f = fixture(7); f.ctx.tt.eta = () => Infinity
  f.bot.supportFeature = f.bot.registry.supportFeature
  require('mineflayer/lib/plugins/entities')(f.bot)
  f.enemy.position.x = 4.5; f.bot.entities[2] = f.enemy
  let weapon = false, aims = 0
  f.ctx.holdWeapon = async () => { weapon = true }
  f.bot.lookAt = async () => {
    if (++aims !== 1) return
    f.bot._client.emit('rel_entity_move', { entityId: 2, dX: -3 * 4096, dY: 0, dZ: 0, onGround: true })
    assert.equal(f.enemy.position.x, 1.5)
  }
  const native = f.bot._placeBlockWithOptions
  f.bot._placeBlockWithOptions = (ref, face, opts) => {
    if (ref.position.plus(face).x === 1) { f.calls.push({ refused: true }); throw Error('server refused occupied cell') }
    return native(ref, face, opts)
  }
  assert.equal(await f.ctx.fortOut(), false)
  assert.equal(f.calls.length, 0, 'no request for the occupied cell')
  assert.ok(weapon); assert.equal(f.ctx.aim, 'target'); assert.equal(f.ctx.fort, undefined)
  assert.ok(f.notes.some(note => note === 'бросил коробку: в клетке стоит player'))
  assert.equal(f.ctx.st.build.aborted, 1)
  assert.equal(f.bot.listenerCount('entityMoved'), 0)
})

test('a visible player entering the room releases a pending shelter click before any hit or server reply', async () => {
  const f = fixture(7); f.ctx.tt.eta = () => Infinity
  f.enemy.position.x = 4.5; f.bot.entities[2] = f.enemy
  let sent, reply, weapon = false
  const pending = new Promise(resolve => { sent = resolve })
  f.bot._placeBlockWithOptions = async () => { f.calls.push('sent'); sent(); await new Promise(resolve => { reply = resolve }) }
  f.ctx.holdWeapon = async () => { weapon = true }
  const turn = f.ctx.fortOut()
  await pending
  f.enemy.position.x = .6; f.bot.emit('entityMoved', f.enemy)
  await new Promise(resolve => setImmediate(resolve))
  try { assert.ok(weapon, 'still waiting with building blocks in hand') }
  finally { f.ctl.abort(); reply(); await turn }
  assert.deepEqual(f.calls, ['sent'])
  assert.equal(f.bot.listenerCount('entityMoved'), 0)
})

test('a wounded duelist displaced out of a partial box returns to the fight before its next placement', async t => {
  const f = fixture(7), { bot, ctx, enemy } = f
  const weapon = bot.heldItem = { name: 'iron_sword', type: bot.registry.itemsByName.iron_sword.id, count: 1 }
  const inventory = [...bot.inventory.items(), weapon]
  bot.inventory.items = () => inventory
  Object.assign(ctx, require('../src/pvp/equipment').createEquipment(ctx), { bestWeapon: require('../src/items').bestWeapon, nextReady: 0 })
  t.after(() => ctx.closeEquipment())
  ctx.style.fortAt = 10; ctx.cx = { dominant: () => false }; ctx.healAt = 9
  ctx.healItem = () => null; ctx.fortPossible = () => true
  enemy.position.x = 5.5; bot.entities[enemy.id] = enemy
  ctx.tt.eta = () => Infinity
  const native = require('../src/tick-plugins').getPhysics(), world = { getBlock: p => bot.blockAt(p) }
  const physics = native.Physics(bot.registry, world)
  let moved = false
  bot.lookAt = async () => {
    if (moved || f.calls.length !== 1) return
    moved = true
    assert.equal(bot.heldItem.name, 'dirt')
    // A lateral gust can move the body without lowering its HP. There is still an open rear exit.
    bot.entity.velocity = new Vec3(-.95, 0, 0)
    const body = new native.PlayerState(bot, { ...require('../src/edges').IDLE })
    physics.simulatePlayer(body, world); body.apply(bot); bot.emit('physicsTick')
    assert.ok(bot.entity.position.x < -.3); assert.equal(bot.health, 7)
  }
  const place = bot._placeBlockWithOptions
  bot._placeBlockWithOptions = async (...args) => {
    const result = await place(...args)
    if (f.calls.length > 1) f.ctl.abort() // terminate the old builder if it still sent a second packet
    return result
  }
  const { fortTurn } = require('../src/pvp/turn-heal')
  assert.equal(await fortTurn(ctx, { hp: 7, d: 5, theirR: 4.7 }), undefined)
  assert.ok(moved)
  t.diagnostic(`displaced to X=${bot.entity.position.x.toFixed(3)}, ${f.calls.length} placement packet(s)`)
  assert.equal(f.calls.length, 1, 'a second click would build the old box from outside')
  assert.equal(f.ctl.aborted, false); assert.equal(bot.heldItem, weapon); assert.equal(ctx.aim, 'target')
  assert.equal(ctx.st.build.aborted, 1); assert.equal(ctx.fort, undefined)
})

test('a spectator, an unarmed invisible player, a dropped item and a player outside the wall do not interrupt a shelter', async () => {
  const f = fixture(), native = f.bot.lookAt
  // One wall already exists; its outer face is x=2.
  for (const h of [0, 1]) f.cells.set(new Vec3(1, 64 + h, 0).toString(), 'stone')
  f.bot.players = { Observer: { gamemode: 3 } }
  const spectator = { ...f.enemy, id: 3, username: 'Observer', position: new Vec3(-.5, 64, .5) }
  const unseen = { ...f.enemy, id: 4, username: 'Unseen', metadata: [0x20], equipment: [], position: new Vec3(2.5, 64, .5) }
  const drop = { id: 5, name: 'item', position: new Vec3(-.5, 64, .5) }
  for (const e of [f.enemy, spectator, unseen, drop]) f.bot.entities[e.id] = e
  f.bot.lookAt = async (...args) => {
    f.enemy.position.x = 2.31
    f.bot.emit('entityMoved', f.enemy)
    unseen.position.x = .6
    f.bot.emit('entityMoved', unseen)
    unseen.position.x = 2.5
    f.bot.emit('entityMoved', unseen)
    f.bot.emit('entitySpawn', spectator)
    f.bot.emit('entitySpawn', drop)
    await native(...args)
  }
  const box = await f.fortify.boxIn(f.bot, { toward: f.enemy.position, ctl: f.ctl })
  assert.equal(box.sealed, true, box.why); assert.equal(box.placed, 8); assert.equal(box.aborted, false)
  assert.equal(f.bot.listenerCount('entityMoved'), 0); assert.equal(f.bot.listenerCount('entitySpawn'), 0)
})

test('an unpressured complete box builds honest walls and a real jumping roof support', async () => {
  const f = fixture()
  const out = await f.fortify.boxIn(f.bot, { toward: f.enemy.position, ctl: f.ctl })
  assert.equal(out.sealed, true); assert.equal(out.placed, 10)
  assert.ok(f.calls.some(c => c.opts?.delta), 'roof support clicked in its visible face while jumping')
  assert.equal(f.control.jump, false)
})

test('a construction obstruction ends the attempt and patch respects cancellation', async () => {
  const f = fixture(); f.bot._placeBlockWithOptions = async () => { throw Error('occupied by enemy') }
  const out = await f.fortify.boxIn(f.bot, { ctl: f.ctl, timeoutMs: 1 })
  assert.equal(out.placed, 0); assert.equal(out.sealed, false); assert.ok(out.failed?.length)
  f.ctl.abort()
  assert.equal(await f.fortify.patch(f.bot, out.plan, { ctl: f.ctl }), 0)
})

test('three walls and a failed roof cannot be reported as a fort', async () => {
  const f = fixture(); f.ctx.tt.eta = () => Infinity
  f.ctx.fortify = { ...f.fortify, boxIn: async () => ({ cell: f.fortify.feetCell(f.bot), walls: 3, roof: false, placed: 6, sealed: false }) }
  assert.equal(await f.ctx.fortOut(), false); assert.equal(f.ctx.fort, undefined)
})

test('the construction feasibility check prices existing walls and refuses an insufficient physical block supply', () => {
  const f = fixture(); f.bot.inventory.items = () => [{ name: 'dirt', count: 3 }]
  assert.equal(f.fortify.boxCheck(f.bot).ok, false)
  for (const side of f.fortify.SIDES) for (const h of [0, 1]) f.cells.set(new Vec3(0, 64, 0).plus(side).offset(0, h, 0).toString(), 'stone')
  const need = f.fortify.boxCheck(f.bot)
  assert.equal(need.ok, true); assert.equal(need.blocks, 2); assert.ok(need.ms < 1000)
})

test('a wounded duelist seals the two-block doorway of an existing alcove with the two blocks it has', async () => {
  const f = fixture(8), cell = f.fortify.feetCell(f.bot)
  const materials = f.bot.inventory.items()
  materials[0].count = 2
  f.bot.inventory.items = () => materials
  f.ctx.countOf = () => materials[0].count
  f.ctx.healItem = () => null
  f.ctx.solid = (bot, p) => bot.blockAt(p).boundingBox === 'block'
  const cover = source('pvp/cover').createCover(f.ctx)
  for (const s of f.fortify.SIDES.filter(s => s.x !== 1)) {
    for (const y of [0, 1]) f.cells.set(cell.plus(s).offset(0, y, 0).toString(), 'stone')
  }
  f.cells.set(cell.offset(0, 2, 0).toString(), 'stone')
  f.enemy.position.x = 10
  assert.equal(cover.fortPossible(), true)
  assert.ok(cover.fortSpot().equals(cell))
  // The only way out must remain safe to walk through after opening the door.
  f.cells.set(cell.offset(2, -1, 0).toString(), 'lava')
  assert.equal(cover.fortPossible(), false)
  f.cells.set(cell.offset(2, -1, 0).toString(), 'stone')
  materials[0].count = 1
  assert.equal(cover.fortPossible(), false)
  materials[0].count = 2
  const out = await f.fortify.boxIn(f.bot, { toward: f.enemy.position, ctl: f.ctl })
  assert.equal(out.sealed, true)
  assert.deepEqual(f.calls.map(c => c.at.toString()), ['(1, 64, 0)', '(1, 65, 0)'])
})

for (const intercepted of [false, true]) test(`a wounded duelist heads for an adjacent alcove with two blocks: ${intercepted ? 'a visible rush intercepts the delayed step' : 'there is time to seal it'}`, async t => {
  const f = fixture(6), ctx = f.ctx, here = f.fortify.feetCell(f.bot), alcove = here.offset(-1, 0, 0)
  const fill = { ...f.bot.inventory.items()[0], count: 2 }
  f.bot.inventory.items = () => [fill]
  f.enemy.position.x = 10.3; f.enemy.equipment[0].name = 'netherite_sword'; f.bot.entities[2] = f.enemy
  for (const side of f.fortify.SIDES.filter(s => s.x !== 1)) for (const y of [0, 1]) f.cells.set(alcove.plus(side).offset(0, y, 0).toString(), 'stone')
  f.cells.set(alcove.offset(0, 2, 0).toString(), 'stone')
  ctx.pvpSkills = source('pvp/cover').createCover(ctx)
  Object.assign(ctx, ctx.pvpSkills, {
    countOf: () => fill.count, solid: (bot, p) => bot.blockAt(p).boundingBox === 'block',
    cx: { dominant: () => false }, healAt: 10, healItem: () => ({ name: 'golden_apple' }),
    goals: require('mineflayer-pathfinder').goals, EYE: 1.62, HIT_REACH: 3, nextReady: Infinity,
    foeHpDecide: () => null
  })
  const vision = require('../src/pvp/last-seen').createLastSeen(f.bot)
  ctx.entity = vision.observe(f.enemy)
  ctx.tt = source('tempo', { './game-clock': ctx.gameClock }).track(f.bot, { threats: () => [ctx.entity] })
  t.after(() => { ctx.tt.close(); vision.close() })
  ctx.style.fortAt = 10
  ctx.st.healed = []; ctx.consumeItem = async () => { f.bot.health = 18; return true }
  const goals = [], sleep = ctx.sleep
  f.bot.pathfinder.setGoal = goal => { if (goal) goals.push(goal) }
  ctx.fortify = { ...f.fortify, breakOut: async () => ({ ok: false }) }
  let steps = 0
  ctx.sleep = async ms => {
    if (f.bot.entity.position.floored().equals(here)) {
      assert.deepEqual([goals[0].x, goals[0].y, goals[0].z], [alcove.x, alcove.y, alcove.z])
      if (++steps === 5 && !intercepted) f.bot.entity.position = alcove.offset(.5, 0, .5)
      f.enemy.position.x -= .28 // Observed vanilla sprint per game tick.
      f.bot.emit('entityMoved', f.enemy)
    } else f.bot.health = 18
    await sleep(ms)
  }
  const weapon = { name: 'iron_sword' }; f.bot.heldItem = weapon
  ctx.pvpSkills.holdWeapon = async () => { f.bot.heldItem = weapon }
  ctx.session = {}
  const { installSkillDelegates, installFort } = require('../src/pvp/duel-skills')
  installSkillDelegates(ctx); installFort(ctx)
  const { fortTurn } = require('../src/pvp/turn-heal')
  await fortTurn(ctx, { hp: 6, d: 9.8, theirR: 9.5 })
  assert.equal(goals.length, 1, 'the duelist used the one-step route to existing cover')
  assert.deepEqual(f.calls.map(c => c.at.toString()), intercepted ? [] : [here.toString(), here.offset(0, 1, 0).toString()])
  assert.equal(f.bot.heldItem, weapon); assert.equal(ctx.aim, 'target')
  if (intercepted) assert.ok(steps > 1 && steps < 20, 'the closing sprint should cancel the route before its three-second timeout')
  assert.equal(f.notes.some(n => n.includes('закрылся в коробке')), !intercepted)
})

test('cancellation during roof-support equipment cannot enable a late jump or placement', async () => {
  const f = fixture(), at = new Vec3(1, 66, 0)
  f.cells.set(at.offset(0, -1, 0).toString(), 'stone')
  f.bot.equip = async () => { f.ctl.abort() }
  const result = await f.fortify.jumpPlace(f.bot, at, { ctl: f.ctl })
  assert.equal(result.ok, false); assert.equal(f.control.jump, undefined); assert.equal(f.calls.length, 0)
})

function sealedRecovery(hp = 10, food = 20) {
  const f = fixture(hp)
  f.bot.food = food; f.enemy.isValid = false; f.ctx.tt.eta = () => Infinity
  f.ctx.style.patchBudget = 10; f.ctx.style.reactMs = 0; f.ctx.style.boxPatienceMs = 0
  f.ctx.healItem = () => null; f.ctx.foeHpDecide = () => null
  const cell = f.fortify.feetCell(f.bot)
  f.ctx.fortify = { ...f.fortify, boxCheck: () => ({ ok: true, ms: 0 }),
    boxIn: async () => ({ cell, placed: 0, sealed: true, plan: [], mats: [] }),
    enclosure: () => ({ sealed: true }), breakOut: async () => ({ ok: false }) }
  return f
}

test('a sealed box keeps useful recovery across 0.5/3/15/60 seconds and exits on recovered health', async () => {
  const f = sealedRecovery(), sleep = f.ctx.sleep, deltas = [500, 2500, 12000, 45000, 0]
  let samples = 0
  f.ctx.sleep = async () => {
    await sleep(deltas[samples++] ?? 0)
    if (samples === 5) f.bot.health = 18
    if (samples > 5) f.ctl.abort()
  }
  await f.ctx.fortOut()
  assert.equal(samples, 5, 'elapsed time cannot end useful regeneration')
  assert.equal(f.bot.health, 18); assert.equal(f.control.sneak, false)
})

test('a sealed box with no healing or regeneration exits without waiting for patience', async () => {
  const f = sealedRecovery(10, 17)
  let sleeps = 0
  f.ctx.sleep = async () => { sleeps++; f.ctl.abort() }
  await f.ctx.fortOut()
  assert.equal(sleeps, 0)
})

for (const breached of [true, false]) test(`a wounded duelist rechecks its completed shelter before eating: ${breached ? 'slab in the breach' : 'intact wall'}`, async () => {
  const f = fixture(6), { bot, ctx, enemy, fortify } = f
  const cell = fortify.feetCell(bot), front = cell.offset(1, 1, 0)
  enemy.position.x = 12.5; enemy.equipment[0].name = 'netherite_sword'; bot.entities[enemy.id] = enemy
  for (const p of fortify.boxPlan(cell, enemy.position, true)) {
    if (!p.equals(front)) f.cells.set(p.toString(), 'stone')
  }
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  const tempo = require('../src/tempo') as typeof import('../src/tempo')
  ctx.entity = vision.observe(enemy)
  assert.ok(ctx.entity?._ndVisible)
  ctx.tt = tempo.track(bot, { threats: () => [ctx.entity].filter(e => e._ndVisible) })
  ctx.tempo = { ...tempo, ON: true }; ctx.EYE = 1.62; ctx.HIT_REACH = 3
  ctx.reachFrom = (eye, e) => require('../src/mace/world').reachFrom(eye, e, bot)
  ctx.st.healed = []; ctx.style.patchBudget = 4; ctx.ready = name => name === 'fortEat'
  ctx.fortSealed = () => !!ctx.fort && fortify.enclosure(bot, ctx.fort.cell).sealed
  ctx.healItem = () => ({ name: 'golden_apple' }); ctx.foeHpDecide = () => null
  let meals = 0, exit, ticksToHit: number | null = null
  ctx.consumeItem = async () => { meals++; bot.health = 18; return true }
  ctx.fortify = { ...fortify, breakOut: async (_bot, _cell, direction) => { exit = direction; return { ok: false } } }
  ctx.used = note => {
    f.notes.push(note)
    if (!note.startsWith('закрылся в коробке')) return
    assert.ok(ctx.fortSealed())
    if (breached) f.cells.set(front.toString(), 'stone_slab')
    enemy.position.x = 4.3
    bot.emit('physicsTick')
    const native = require('../src/tick-plugins').getPhysics(), world = { getBlock: p => bot.blockAt(p) }
    const physics = native.Physics(bot.registry, world)
    const walker = { ...bot, version: bot.version, entity: { ...enemy, yaw: Math.PI / 2, velocity: new Vec3(0, 0, 0), onGround: true, effects: {}, attributes: {} } }
    const step = new native.PlayerState(walker, { ...require('../src/edges').IDLE, forward: true, sprint: true })
    for (let tick = 0; tick <= 12; tick++) {
      assert.ok([step.pos.x, step.pos.y, step.pos.z].every(Number.isFinite))
      if (ctx.pick.canHit(bot, bot.entity, { eye: step.pos.offset(0, 1.62, 0), range: 3 })) { ticksToHit = tick; break }
      physics.simulatePlayer(step, world)
    }
  }
  try {
    await ctx.fortOut()
    assert.ok(f.calls.some(c => c.at.equals(front)), 'the real builder closed the initial opening')
    if (breached) assert.ok(ticksToHit > 0 && ticksToHit < 12)
    else assert.equal(ticksToHit, null)
    assert.equal(meals, breached ? 0 : 1)
    if (breached) assert.ok(exit?.away && f.notes.some(n => n.includes('ищу выход')))
  } finally { ctx.tt.close?.(); vision.close() }
})

test('a partial block closes the shelter only when its inward face is covered', () => {
  const { bot, cells, fortify } = fixture()
  const cell = fortify.feetCell(bot), front = cell.offset(1, 1, 0)
  for (const p of fortify.boxPlan(cell, front, true)) cells.set(p.toString(), 'stone')
  cells.set(cell.offset(0, 2, 0).toString(), 'stone_slab')
  assert.equal(fortify.enclosure(bot, cell).sealed, true, 'the lower face of a bottom roof slab is continuous')
  const Block = require('prismarine-block')(bot.registry), read = bot.blockAt
  for (const facing of ['west', 'east']) {
    const stair = Block.fromProperties('stone_stairs', { facing, shape: 'straight', half: 'bottom', waterlogged: 'false' }, 0)
    bot.blockAt = p => p.equals(front) ? stair : read(p)
    assert.equal(fortify.enclosure(bot, cell).sealed, facing === 'west', facing)
  }
})

test('being knocked out ends the box recovery at the next world observation', async () => {
  const f = sealedRecovery()
  let sleeps = 0
  f.ctx.sleep = async () => { if (++sleeps === 1) f.bot.entity.position.x += 3; else f.ctl.abort() }
  await f.ctx.fortOut()
  assert.equal(sleeps, 1)
  assert.equal(f.ctx.fort, null); assert.equal(f.control.sneak, false)
})

test('confirmed repairs spend the block budget without a three-breaches time window', async () => {
  const f = sealedRecovery()
  let patches = 0
  f.ctx.fortify.enclosure = () => ({ sealed: patches >= 4 })
  f.ctx.fortify.patch = async () => { if (++patches === 4) f.bot.health = 18; return 1 }
  await f.ctx.fortOut()
  assert.equal(patches, 4); assert.equal(f.ctx.st.blocks, 4)
})

test('unconfirmed recovery ends the box attempt instead of waiting forever on the same item', async () => {
  const f = sealedRecovery(10, 17)
  let sleeps = 0
  f.ctx.healItem = () => ({ name: 'golden_apple' }); f.ctx.consumeItem = async () => false
  f.ctx.sleep = async () => { sleeps++; f.ctl.abort() }
  await f.ctx.fortOut()
  assert.equal(sleeps, 0)
  assert.ok(f.notes.some(note => /не подтверждено/.test(note)))
})

for (const layout of ['open face', 'occupied face', 'incoming hit', 'stone exit', 'dirt exit', 'fast rear', 'quick front', 'guarded front', 'returning swordsman', 'screened swordsman',
  'hidden lava', 'hidden void', 'hidden wall'] as const) test(
  'a wall opens during the wounded duelist’s meal: ' + layout, async t => {
  const hidden = layout.startsWith('hidden')
  const returning = layout === 'returning swordsman' || layout === 'screened swordsman'
  const physicalExit = hidden || returning || ['stone exit', 'dirt exit', 'fast rear', 'quick front', 'guarded front'].includes(layout)
  const situation = physicalExit ? 'incoming hit' : layout
  const f = fixture(6), { ctx, bot, fortify, enemy } = f
  const cell = fortify.feetCell(bot), front = cell.offset(1, 1, 0)
  for (const p of fortify.boxPlan(cell, enemy.position, true)) if (!p.equals(front)) f.cells.set(p.toString(), 'stone')
  if (returning) f.cells.delete(front.offset(0,-1,0).toString())
  if (layout === 'dirt exit' || layout === 'fast rear' || hidden) for (const y of [0, 1]) f.cells.set(cell.offset(-1, y, 0).toString(), 'dirt')
  if (layout === 'fast rear' || hidden) {
    const items = bot.inventory.items()
    bot.inventory.items = () => [...items, { name: 'diamond_shovel', type: bot.registry.itemsByName.diamond_shovel.id, count: 1 }]
  }
  const hiddenAt = cell.offset(-2, layout === 'hidden wall' ? 0 : -1, 0)
  if (hidden) f.cells.set(hiddenAt.toString(), layout === 'hidden lava' ? 'lava' : layout === 'hidden void' ? 'air' : 'bedrock')
  // The attacker outside the head-height opening can step in from the top of the adjacent block.
  if (situation === 'occupied face') f.cells.set(front.offset(1, -1, 0).toString(), 'stone')
  enemy.position.x = 12.5; enemy.equipment[0].name = returning ? 'bow' : 'netherite_sword'; bot.entities[enemy.id] = enemy
  const vision = require('../src/pvp/last-seen').createLastSeen(bot)
  ctx.entity = vision.observe(enemy)
  const tempo = source('tempo', { './game-clock': ctx.gameClock })
  ctx.tt = tempo.track(bot, { threats: () => [ctx.entity].filter(e => e._ndVisible) })
  t.after(() => { ctx.tt.close(); vision.close() })
  Object.assign(ctx, source('pvp/recovery').createRecovery(ctx), {
    tempo: { ...tempo, ON: true }, EYE: 1.62, HIT_REACH: 3, nextReady: Infinity, session: {},
    reachFrom: (eye, e) => require('../src/mace/world').reachFrom(eye, e, bot),
    fortSealed: () => !!ctx.fort && fortify.enclosure(bot, ctx.fort.cell).sealed,
    ready: name => name === 'fortEat' || name === 'patchNote', foeHpDecide: () => null,
    holdItem: async item => { await bot.equip(item, 'hand'); return true },
    edges: require('../src/edges'), keyDir: () => 0, stepSafe: () => false, set: () => {}
  })
  ctx.st.healed = []; ctx.st.eatPunish = { swaps: 0 }; ctx.style.patchBudget = 3
  const apple = { name: 'golden_apple', count: 1, slot: 37 }
  ctx.healItem = () => apple.count ? apple : null
  ctx.countOf = (_bot, name) => name === apple.name ? apple.count : 64
  const native = require('../src/tick-plugins').getPhysics(), world = { getBlock: p => bot.blockAt(p) }
  const physics = native.Physics(bot.registry, world)
  let bites = 0, using = false, elapsed = 0, breachAt = 0, stopAt = 0, exit
  const sleep = ctx.sleep
  bot.activateItem = () => { using = true; bites++; elapsed = 0 }
  bot.deactivateItem = () => { if (using && bites === 1) stopAt = ctx.gameClock.now(); using = false }
  ctx.sleep = async ms => {
    if (using) {
      elapsed += ms
      if (bites === 1 && !breachAt && elapsed >= 350) {
        assert.ok(ctx.fortSealed())
        const old = bot.blockAt(front); f.cells.delete(front.toString()); bot.emit('blockUpdate', old, bot.blockAt(front))
        if (returning) enemy.equipment[0] = { name: 'netherite_sword' }
        enemy.position.set(returning ? 6.45 : situation === 'occupied face' ? 2.31 : situation === 'incoming hit' ? 3.3 : 5.0,
          situation === 'occupied face' ? 65 : 64, .5)
        const walker = { ...bot, entity: { ...enemy, yaw: Math.PI / 2, onGround: true, velocity: new Vec3(-.12, -.0784, 0), effects: {}, attributes: {} } }
        const state = new native.PlayerState(walker, { ...require('../src/edges').IDLE, forward: true, sprint: true })
        physics.simulatePlayer(state, world); enemy.position.update(state.pos)
        bot.emit('entityMoved', enemy); bot.emit('physicsTick')
        assert.ok(ctx.entity._ndVisible)
        if (situation === 'occupied face') assert.ok(enemy.position.x - enemy.width / 2 < front.x + 1 && enemy.position.y === front.y)
        if (situation === 'incoming hit') {
          if (!returning) {
            assert.ok(ctx.pick.canHit(bot, bot.entity, { eye: enemy.position.offset(0, 1.62, 0), range: 3 }))
            bot.emit('entitySwingArm', enemy)
          }
          bot.health -= 4; bot.emit('entityHurt', bot.entity, returning ? { id: 10, name: 'arrow' } : enemy)
          if (layout === 'quick front' || layout === 'guarded front' || returning) {
            // Only the frontal door is open. Its value changes with the visible attacker's position.
            f.cells.delete(cell.offset(1, 0, 0).toString())
            for (const s of fortify.SIDES.filter(s => s.x !== 1)) f.cells.set(cell.plus(s.scaled(2)).toString(), 'bedrock')
            if (layout === 'quick front') { enemy.position.set(7.5, 64, .5); bot.emit('entityMoved', enemy); bot.emit('physicsTick') }
          }
        }
        breachAt = ctx.gameClock.now()
      } else if (elapsed >= tempo.consumeMs(apple.name)) { apple.count--; bot.health = 18 }
    }
    await sleep(ms)
    assert.ok(ctx.gameClock.now() < 15000, 'the duel must reach a decision')
  }
  ctx.fortify = { ...fortify, breakOut: async (_bot, _cell, direction) => { exit = direction; return { ok: false } } }
  const measure = physicalExit && runExit(f, physics, world, direction => {
    exit = direction
    if (hidden || layout === 'fast rear')
      assert.equal(require('../src/pvp/search').observedCollision(bot).blockAt(hiddenAt), null, 'the intact rear wall hides the exterior')
  }, returning ? () => {
    if (layout === 'screened swordsman') for (const y of [64,65]) f.cells.set(new Vec3(4,y,0).toString(), 'stone')
    const walker = { ...bot, entity: { ...enemy, yaw: Math.PI / 2, onGround: true, velocity: enemy.velocity ?? new Vec3(-.2,-.0784,0), effects: {}, attributes: {} } }
    const state = new native.PlayerState(walker, { ...require('../src/edges').IDLE, forward: true, sprint: true })
    physics.simulatePlayer(state, world); enemy.position.update(state.pos); enemy.velocity = state.vel
    bot.emit('entityMoved', enemy)
  } : undefined)
  let completed
  if (returning) {
    ctx.healAt = 8; ctx.style.fortAt = 6; ctx.cx = { dominant: () => false }
    const d = ctx.entity.position.distanceTo(bot.entity.position)
    completed = (await require('../src/pvp/turn-heal').fortTurn(ctx, { hp: bot.health, d,
      theirR: ctx.reachFrom(ctx.entity.position.offset(0,1.62,0), bot.entity), theyBow: ctx.entity.equipment[0]?.name === 'bow' })) === 'next'
  } else completed = await ctx.fortOut()
  assert.ok(breachAt && stopAt - breachAt <= 50, f.notes.join(', '))
  assert.equal(ctx.tt.stats.aborted, 1, 'the ordinary watcher cancelled the meal at the fresh opening')
  const placements = f.calls.filter(call => call.at.equals(front)).length
  assert.equal(placements, situation === 'open face' ? 2 : 1, f.notes.join(', '))
  assert.equal(bites, situation === 'open face' ? 2 : 1)
  if (situation !== 'open face') assert.ok(exit?.away, f.notes.join(', '))
  else assert.deepEqual(ctx.st.healed, [apple.name])
  if (measure) {
    if (returning) {
      await ctx.sleep(ctx.tempo.swingCooldownMs('netherite_sword'))
      t.diagnostic(JSON.stringify({ steps: measure.steps.length, end: bot.entity.position, hp: bot.health, strike: measure.nextStrike, shield: measure.guard }))
      if (layout === 'screened swordsman') {
        assert.equal(ctx.entity._ndVisible, false); assert.equal(measure.steps.length, 7)
        assert.equal(measure.guard, 0); assert.equal(measure.nextStrike, ''); assert.equal(completed, true)
        return
      }
      assert.ok(measure.steps.length > 0 && measure.steps.length < 7, `advanced ${measure.steps.length} ticks after opening`)
      assert.equal(measure.nextStrike, 'blocked'); assert.equal(bot.health, 2)
      assert.equal(measure.guard, 1); assert.equal(completed, false); assert.equal(f.control.forward, false)
      return
    }
    const slow = hidden || layout === 'stone exit' || layout === 'dirt exit' || layout === 'guarded front'
    assert.deepEqual(measure.swings, [], 'emergency egress cannot spend time attacking out of another opening')
    if (hidden) {
      assert.equal(measure.dug[0]?.pos, cell.offset(-1, 1, 0).toString(), 'the first dig must be identical to the safe-floor control')
      assert.ok(measure.dug.length <= 2)
    } else assert.equal(measure.dug.length, slow || layout === 'quick front' ? 0 : 2)
    assert.equal(measure.steps.length, slow ? 0 : 7)
    assert.equal(measure.guard, slow ? 1 : 0)
    assert.equal(completed, !slow)
    if (slow) {
      await ctx.sleep(ctx.tempo.swingCooldownMs('netherite_sword'))
      assert.deepEqual(measure.nextStrike, 'blocked')
    }
    assert.equal(bot.health, 2, 'a second full sword strike would kill us')
    if (!slow) {
      assert.ok(measure.steps.every(p => p.support && p.y === 64))
      assert.ok(layout === 'quick front' ? bot.entity.position.x > 1 : bot.entity.position.x < 0)
    }
    t.diagnostic(JSON.stringify({ layout, ...measure, end: bot.entity.position, health: bot.health }))
  }
  t.diagnostic(JSON.stringify({ situation, cancelledAfterMs: stopAt - breachAt, repairs: placements - 1, completedMeals: 1 - apple.count }))
})

function runExit(f, physics, world, direction, advanceEnemy?: () => void) {
  const { bot, ctx, enemy, fortify } = f
  const measure = { swings: [] as number[], dug: [] as any[], steps: [] as any[], guard: 0, nextStrike: '' }
  bot.physics = physics; bot.game = { minY: -64, height: 384 }; bot.entity.attributes = {}; bot.entity.yaw = Math.PI / 2; bot.entity.pitch = 0
  bot.jumpTicks = 0; bot.jumpQueued = false; bot.fireworkRocketDuration = 0
  const geo = require('../src/navigation/geometry'), edges = require('../src/edges'), tools = require('../src/tools')
  const damage = require('../src/pvp/damage-model')
  let start = 0, shieldAt = Infinity
  bot.lookAt = async at => {
    const d = at.minus(ctx.pick.eyeOf(bot))
    bot.entity.yaw = Math.atan2(-d.x, -d.z); bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  }
  bot.attack = () => measure.swings.push(ctx.gameClock.now() - start)
  bot.dig = async block => {
    assert.ok([...fortify.SIDES, new Vec3(0, 1, 0), new Vec3(0, -1, 0)].some(face => ctx.pick.faceAim(bot, block.position, face)))
    const ms = tools.bestFor(bot, block).ms
    await ctx.sleep(ms); f.cells.delete(block.position.toString()); bot.emit('blockUpdate', block, bot.blockAt(block.position))
    measure.dug.push({ pos: block.position.toString(), ms })
  }
  ctx.set = bot.setControlState
  ctx.guard = { raise: async on => { if (on) { measure.guard++; shieldAt = ctx.gameClock.now() } } }
  bot.inventory.slots[45] = { name: 'shield' }
  ctx.tempo.kite = async () => 'проверено до начала кайта'
  ctx.fortify = { ...fortify, breakOut: async (...args) => {
    direction(args[2]); start = ctx.gameClock.now(); ctx.nextReady = start + 200
    const sleep = ctx.sleep
    ctx.sleep = async ms => {
      for (let elapsed = 0; elapsed < ms; elapsed += 50) {
        const controls = Object.fromEntries(Object.keys(edges.IDLE).map(k => [k, bot.getControlState(k)]))
        const state = edges.stateOf(bot, controls); physics.simulatePlayer(state, world); state.apply(bot)
        advanceEnemy?.()
        await sleep(Math.min(50, ms - elapsed))
        if (controls.forward) measure.steps.push({ x: state.pos.x, y: state.pos.y, support: !!geo.supportAt(bot, state.pos, .04) })
        if (!measure.nextStrike && (advanceEnemy || ctx.gameClock.now() - start >= ctx.tempo.swingCooldownMs('netherite_sword')) &&
            ctx.pick.canHit(bot, bot.entity, { eye: enemy.position.offset(0, 1.62, 0), range: 3 })) {
          const blocked = damage.shieldBlocks({ raised: ctx.gameClock.now() - shieldAt >= damage.SHIELD_DELAY_TICKS * 50,
            angle: damage.shieldAngle(bot.entity.yaw, bot.entity.position, enemy.position) })
          measure.nextStrike = blocked ? 'blocked' : 'hit'
          if (!blocked) { bot.health = Math.max(0, bot.health - damage.attackDamage('netherite_sword')); bot.emit('entityHurt', bot.entity, enemy) }
        }
      }
    }
    return fortify.breakOut(...args)
  } }
  return measure
}

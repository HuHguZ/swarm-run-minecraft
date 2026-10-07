// S4c (round 4): runs are priced, not banned; smartFlee sees shooters to their jar reach and attacking players; the exit
// check walks natural ground (1-block steps), so a corner is not "found" and "lost" on every step.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { check } from '../src/tactics/sim-run'
import { roughScenario } from '../src/tactics/sim-scenarios'
import { runGain, type TacticalState } from '../src/tactics/state'
const flee = require('../src/flee')
const { observeTactics, TacticalSystem } = require('../src/tactics/minecraft')
const gameClock = require('../src/game-clock')
const { Vec3 } = require('vec3')

process.env.ND_TELEMETRY = '0'
const tactical = (changes: Partial<TacticalState> = {}): TacticalState => ({ at: 0, health: 20, food: 20, armor: 15, weapon: true, shield: false,
  enemies: [], incomingProjectiles: 0, burning: false, lava: false, fireResistance: false, explosion: false, dangerousFall: false,
  emergencyController: false, inWater: false, cover: false, portal: false, escapeRoute: true, blocks: 16, water: false, edible: true,
  canFight: true, contact: false, shelter: null, protectedEncounter: false, ...changes })

test('shooter reaches in the flight doctrine are the jar\'s (javap 1.21.11): blaze 48, ghast 64, bow 15, pillager 32, shulker 20', () => {
  assert.deepEqual(['blaze', 'ghast', 'skeleton', 'stray', 'pillager', 'shulker'].map(kind => flee.DOCTRINE[kind].range), [48, 64, 15, 15, 32, 20])
})

function field({ wallAt = null as number | null } = {}) {
  const bot: any = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8 }
  bot.entities = {}
  // A wall across x = wallAt stops every ray that crosses it.
  bot.world = { raycast: (from: any, dir: any, range: number) => {
    if (wallAt === null || dir.x <= 0) return null
    const t = (wallAt - from.x) / dir.x
    return t >= 0 && t <= range ? { position: new Vec3(wallAt, Math.floor(from.y + dir.y * t), Math.floor(from.z + dir.z * t)) } : null
  } }
  const add = (id: number, name: string, x: number, extra: Record<string, unknown> = {}) => {
    bot.entities[id] = { id, name, position: new Vec3(x + .5, 64, .5), height: 1.8, ...extra }
  }
  return { bot, add }
}

test('smartFlee is not "escaped" while a blaze 30 blocks off sees it: shaken past the weapon reach or behind a wall (farm s4b-flap-1..3)', () => {
  const open = field()
  open.add(2, 'blaze', 30)
  assert.equal(flee.shaken(open.bot, flee.hostilesAround(open.bot, 64), 17), false, 'a blaze fires from its follow range 48')
  open.bot.entities[2].position = new Vec3(50.5, 64, .5)
  assert.equal(flee.shaken(open.bot, flee.hostilesAround(open.bot, 64), 17), true, 'past 48 it cannot shoot')
  const walled = field({ wallAt: 10 })
  walled.add(2, 'blaze', 30)
  assert.equal(flee.shaken(walled.bot, flee.hostilesAround(walled.bot, 64), 17), true, 'a wall breaks its line of fire')
  const ghast = field()
  ghast.add(3, 'ghast', 60)
  assert.equal(flee.shaken(ghast.bot, flee.hostilesAround(ghast.bot, 64), 17), false, 'a ghast fires from 64')
})

test('an attacking player is a pursuer of smartFlee (a bystander is not); with a bow he is a shooter (slot 27: "escaped" in a tick)', () => {
  const { bot, add } = field()
  add(5, 'player', 12, { username: 'Tank' })
  add(6, 'player', 40, { username: 'Archer', heldItem: { name: 'bow' } })
  assert.equal(flee.hostilesAround(bot, 64).length, 0, 'players are not mobs of the doctrine')
  const foes = flee.hostilesAround(bot, 64, [5, 6])
  assert.deepEqual(foes.map((h: any) => [h.e.username, h.doc.radius, h.doc.range ?? null]), [['Tank', 10, null], ['Archer', 10, 48]])
  assert.equal(flee.shaken(bot, foes, 17), false, 'the swordsman is 12 blocks off')
  bot.entities[5].position = new Vec3(30.5, 64, .5)
  assert.equal(flee.shaken(bot, flee.hostilesAround(bot, 64, [5, 6]), 17), false, 'the archer at 40 still sees the body')
  assert.equal(flee.shaken(bot, flee.hostilesAround(bot, 64, [5]), 17), true)
})

test('run price: full against walkers and fire, .3 against a pursuer that outpaces it, .4 against a player, .5 for unseen shots', () => {
  const foe = (kind: string, player = false) => ({ id: 2, kind, distance: 5, player, threatening: true, hit: 2 })
  assert.equal(runGain(tactical({ contact: true, enemies: [foe('zombie')] })), 1)
  assert.equal(runGain(tactical({ contact: true, enemies: [foe('blaze')] })), .3)
  assert.equal(runGain(tactical({ contact: true, enemies: [foe('Tank', true)] })), .4)
  assert.equal(runGain(tactical({ incomingProjectiles: 1 })), .5)
  assert.equal(runGain(tactical({ contact: true })), 1, 'a hit from an unseen attacker')
  assert.equal(runGain(tactical({ contact: true, enemies: [foe('blaze'), { ...foe('zombie'), id: 3 }] })), 1, 'the run still shakes the zombie')
  assert.equal(runGain(tactical({ burning: true, water: true, enemies: [foe('blaze')] })), 1, 'the bucket puts the fire out (escapeFire)')
  assert.equal(runGain(tactical({ burning: true, enemies: [foe('blaze')] })), .3, 'no bucket: running does not put fire out, the blaze still outranges it')
  assert.equal(runGain(tactical({ lava: true, enemies: [foe('blaze')] })), 1, 'the swim out of lava')
})

test('the exit check walks natural ground: a step up or a drop of 1-2 is a route, a cliff or lava is not (slot 18, 22:57: LastStand<->CreateDistance)', () => {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'
  bot.health = 20; bot.food = 20
  bot.inventory = { slots: [], items: () => [{ name: 'bread', count: 8 }] }
  bot.pathfinder = { setGoal: () => {}, setMovements: () => {}, stop: () => {} }
  bot.registry = { foodsByName: { bread: { foodPoints: 5, saturation: 6 } }, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [], yaw: 0, pitch: 0 }
  bot.entities = {}
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  // Ground y 64 at the body; every cell around it is a terrace: odd rings one up, even rings one down (no 3 flat cells).
  let ground = (x: number, z: number) => Math.max(Math.abs(x), Math.abs(z)) === 0 ? 64 : 64 + (Math.max(Math.abs(x), Math.abs(z)) % 2 ? 1 : 0)
  let liquid: string | null = null
  bot.blockAt = (p: any) => {
    const q = p.floored()
    const solid = q.y < ground(q.x, q.z)
    const name = solid ? 'stone' : liquid && q.y === ground(q.x, q.z) && Math.max(Math.abs(q.x), Math.abs(q.z)) > 0 ? liquid : 'air'
    return { name, position: q, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  const session: any = { bot, current: null, reflex: null, bus: { emit: () => {} } }
  assert.equal(observeTactics(session).escapeRoute, true, 'steps up and down are walked')
  ground = (x: number, z: number) => Math.max(Math.abs(x), Math.abs(z)) === 0 ? 64 : 58
  assert.equal(observeTactics(session).escapeRoute, false, 'a 6-block cliff on every side is no route')
  ground = () => 64
  liquid = 'lava'
  assert.equal(observeTactics(session).escapeRoute, false, 'nor a lava field')
})

test('stage B rough ground: a respawn among zombies keeps one answer per corner - no LastStand<->CreateDistance swings in 24 tapes', async () => {
  const flaps: string[] = []
  for (let seed = 1; seed <= 24; seed++) {
    const result = await check(roughScenario(seed), { observe: 'minecraft' })
    for (const violation of result.violations) if (violation.kind === 'flapping') flaps.push(`rough-${seed}: ${violation.detail}`)
  }
  assert.deepEqual(flaps, [])
})

for (const delay of [0, 10]) test(`a run that "escaped" ${delay ? 'within a second' : 'at once'} sits out 2 s under both of its names (stand fuzz-68/fuzz-5085: CreateDistance>Flee>CreateDistance)`, async () => {
  const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
  const bot: any = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), onGround: true }
  bot.health = 6; bot.food = 20
  const picks: string[] = []
  const session: any = { bot, current: null, reflex: null, bus: { emit: (name: string, payload: any) => { if (name === 'tactical_selected') picks.push(payload.action) } } }
  const system = new TacticalSystem(session, { observe: () => tactical({ at: gameClock.now(), incomingProjectiles: 1, blocks: 0 }), record: () => {},
    execute: async () => { if (delay) await gameClock.sleep(delay * 50); return { mode: 'оторвался', ran: delay ? 3 : 0 } } })
  try {
    system.attach(bot)
    for (let i = 0; i < 14; i++) {
      timer.advanceTicks(3)
      system.update(true)
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(picks.filter(pick => pick === 'Flee' || pick === 'CreateDistance').length, 1, picks.join(','))
  } finally { system.detach(); timer.dispose(); gameClock.activate(null) }
})

test('ne-guard duel does not walk toward a foe over the edge of a bridge (review g: falls under Fight at blazes and withers)', async () => {
  const guard = require('../src/ne-guard')
  const run = async (bridge: boolean) => {
    const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
    const bot: any = new EventEmitter()
    bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, yaw: Math.PI / 2, pitch: 0, onGround: true }
    bot.health = 20
    bot.inventory = { slots: [], items: () => [] }
    bot.heldItem = null
    // A 1-wide bridge along z (x = 0): the foe stands 6 blocks off to the west, beyond the edge when bridge is true.
    bot.blockAt = (p: any) => { const q = p.floored(); const floor = q.y === 63 && (!bridge || q.x === 0); return { name: floor ? 'nether_bricks' : 'air', position: q, boundingBox: floor ? 'block' : 'empty' } }
    bot.world = { raycast: () => null }
    bot.lookAt = async () => {}
    bot.attack = () => {}; bot.activateItem = () => {}; bot.deactivateItem = () => {}
    const pressed: boolean[] = []
    bot.setControlState = (key: string, on: boolean) => { if (key === 'forward') pressed.push(on) }
    const foe = { id: 2, name: 'wither_skeleton', position: new Vec3(-5.5, 64, .5), height: 2.4, isValid: true }
    bot.entities = { 1: bot.entity, 2: foe }
    const ctl = { aborted: false, onAbort: [] as Array<() => void> }
    const fight = guard.duel({ bot }, ctl, foe, 3500)
    try {
      for (let i = 0; i < 80; i++) { timer.advanceTicks(2); await new Promise(resolve => setImmediate(resolve)) }
      await fight
    } finally { timer.dispose(); gameClock.activate(null) }
    return pressed
  }
  assert.ok((await run(false)).includes(true), 'on open ground the duel steps to the foe')
  assert.ok(!(await run(true)).includes(true), 'over the edge it does not')
})

test('burning on dry ground without a bucket runs with smartFlee, not escapeFire\'s blind 1.2 s sprint (review g: edges)', async () => {
  const director = require('../src/director')
  const calls: string[] = []
  const saved = { fire: director.escapeFire, flee: flee.smartFlee }
  director.escapeFire = async () => { calls.push('escapeFire'); return { status: 'done' } }
  flee.smartFlee = async () => { calls.push('smartFlee'); return { mode: 'оторвался' } }
  try {
    const bot: any = new EventEmitter()
    bot.entity = { id: 1, position: new Vec3(.5, 64, .5) }
    bot.entities = {}
    bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
    const system = new TacticalSystem({ bot, bus: { emit: () => {} } })
    const ctl = { aborted: false, onAbort: [] }
    const action = { id: 'Flee', score: 65, reason: '' }
    await (system as any).execute(action, ctl, tactical({ burning: true }))
    await (system as any).execute(action, ctl, tactical({ burning: true, water: true }))
    await (system as any).execute(action, ctl, tactical({ lava: true }))
    assert.deepEqual(calls, ['smartFlee', 'escapeFire', 'escapeFire'])
  } finally { director.escapeFire = saved.fire; flee.smartFlee = saved.flee }
})

test('escapeFire on dry ground without a bucket leaves only a fire cell, by safe steps - no blind 1.2 s sprint-jump (review g)', async () => {
  const { escapeFire } = require('../src/director')
  const run = async (inFire: boolean) => {
    const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
    const bot: any = new EventEmitter()
    bot.entity = { id: 1, position: new Vec3(.5, 64, .5), yaw: 0, pitch: 0, onGround: true, isInLava: false }
    bot.game = { dimension: 'overworld' }
    bot.inventory = { items: () => [] }
    bot.lookAt = async () => {}
    // A 1-wide bridge along z over the void; fire in the body's cell when inFire.
    bot.blockAt = (p: any) => { const q = p.floored(); const floor = q.y === 63 && q.x === 0; const fire = inFire && q.x === 0 && q.z === 0 && q.y === 64
      return { name: floor ? 'stone' : fire ? 'fire' : 'air', position: q, boundingBox: floor ? 'block' : 'empty' } }
    const keys: Record<string, boolean[]> = { forward: [], sprint: [] }
    bot.setControlState = (key: string, on: boolean) => { (keys[key] ??= []).push(on) }
    bot.clearControlStates = () => {}
    const done = escapeFire({ bot }, { aborted: false, onAbort: [] })
    try { for (let i = 0; i < 40; i++) { timer.advanceTicks(1); await new Promise(resolve => setImmediate(resolve)) } return { result: await done, keys } }
    finally { timer.dispose(); gameClock.activate(null) }
  }
  const dry = await run(false)
  assert.equal(dry.result.detail.how, 'не в огне — бег огонь не тушит')
  assert.ok(!dry.keys.forward.includes(true) && !dry.keys.sprint.includes(true), 'no sprint while merely burning')
  const fire = await run(true)
  assert.equal(fire.result.detail.how, 'вышел из огня')
  assert.ok(!fire.keys.sprint.includes(true), 'steps, never a blind sprint')
})

test('a flight does not end at a drop: pickDirection prices the edge at its end (native A/B s4c-ab: knocked off the platform by a wither skeleton)', () => {
  const bot: any = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), yaw: 0, isInWater: false }
  bot.entities = {}
  // Floor y 63 on x, z in [-20, 20], cut at z = -11 (void north of it): the north run ends 1 block from the drop.
  bot.blockAt = (p: any) => { const q = p.floored(); const floor = q.y === 63 && Math.abs(q.x) <= 20 && q.z >= -11 && q.z <= 20
    return { name: floor ? 'stone' : 'air', position: q, boundingBox: floor ? 'block' : 'empty' } }
  assert.ok(flee.edgeRisk(bot, new Vec3(.5, 64, -9.5)) > 0, 'the north end is by the drop')
  assert.equal(flee.edgeRisk(bot, new Vec3(.5, 64, 9.5)), 0, 'the south end is inland')
  const plan = flee.pickDirection(bot, [], null)
  assert.ok(plan && flee.edgeRisk(bot, plan.end) === 0, `the run ends 2+ blocks from any drop: ${JSON.stringify(plan?.end)}`)
})

test('two runs that left an armed body\'s pursuer as close make the escape exhausted, wherever they ended (native s4c-ab: wither skeleton, knocked off the platform)', () => {
  const { EscapeProgress } = require('../src/tactics/escape-progress')
  const at = (x: number, d: number, extra: Record<string, unknown> = {}) => ({ at: x * 100, position: { x, y: 64, z: 0 }, threatDistance: d,
    exits: `cell-${x}`, available: true, actions: ['Flee', 'CreateDistance'], armed: true, ...extra })
  const chase = (armed: boolean) => {
    const p = new EscapeProgress()
    let x = 0
    for (let k = 0; k < 2; k++) { p.observe(at(x, 4.3, { armed })); p.begin('CreateDistance', at(x, 4.3, { armed })); x += 12; p.finish('CreateDistance', at(x, 4.2, { armed }), 'completed') }
    return p.observe(at(x, 4.2, { armed })).exhausted
  }
  assert.equal(chase(true), true, 'armed: the stand beats a third run into the edge')
  assert.equal(chase(false), false, 'with fists a chased run is still the better bet')
  const p = new EscapeProgress()
  p.begin('CreateDistance', at(0, 4.3)); p.finish('CreateDistance', at(12, 4.2), 'completed')
  p.begin('CreateDistance', at(12, 4.2)); p.finish('CreateDistance', at(24, 9), 'completed')
  assert.equal(p.observe(at(24, 9)).exhausted, false, 'a run that gained distance resets the count')
  p.begin('CreateDistance', at(24, 4)); p.finish('CreateDistance', at(30, 4), 'completed')
  p.begin('CreateDistance', at(30, 4)); p.finish('CreateDistance', at(36, 4), 'completed')
  assert.equal(p.observe(at(36, 4, { swim: true })).exhausted, false, 'lava: the swim out is not a run from the pursuer')
})

// S4d (round 4): a fight against an ordinary mob is priced by who trades in the next exchange (a far creeper or a far
// second zombie does not spoil it); the struck melee attacker is known without the eye ray; a blast is taken on the shield
// unless a drop waits behind; a tactical run reports a pursuer that keeps within reach instead of running to the edge.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runGain, type TacticalState } from '../src/tactics/state'
const { evaluate } = require('../src/combat-safety')
const flee = require('../src/flee')
const survival = require('../src/survival')
const combat = require('../src/combat')
const { observeTactics, TacticalSystem, dropBehind } = require('../src/tactics/minecraft')
const gameClock = require('../src/game-clock')
const { Vec3 } = require('vec3')

process.env.ND_TELEMETRY = '0'
const withFlag = <T>(value: string | undefined, fn: () => T): T => {
  const was = process.env.ND_S4D
  if (value === undefined) delete process.env.ND_S4D; else process.env.ND_S4D = value
  try { return fn() } finally { if (was === undefined) delete process.env.ND_S4D; else process.env.ND_S4D = was }
}
const withFlagAsync = async <T>(value: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const was = process.env.ND_S4D
  if (value === undefined) delete process.env.ND_S4D; else process.env.ND_S4D = value
  try { return await fn() } finally { if (was === undefined) delete process.env.ND_S4D; else process.env.ND_S4D = was }
}
const tactical = (changes: Partial<TacticalState> = {}): TacticalState => ({ at: 0, health: 20, food: 20, armor: 15, weapon: true, shield: false,
  enemies: [], incomingProjectiles: 0, burning: false, lava: false, fireResistance: false, explosion: false, dangerousFall: false,
  emergencyController: false, inWater: false, cover: false, portal: false, escapeRoute: true, blocks: 16, water: false, edible: true,
  canFight: true, contact: false, shelter: null, protectedEncounter: false, ...changes })

test('a creeper 12 blocks off does not turn a fight with the zombie at the body into a retreat; a hissing or close one does (s5c-b1-1, f2-2, g3-3)', () => {
  const iron = { health: 20, food: 20, foodPoints: 40, weapon: true, phase: 'continue' }
  const zombie = { name: 'zombie', hit: 1.5, distance: 2.5 }
  const far = { name: 'creeper', hit: 19.4, distance: 12 }
  assert.equal(withFlag(undefined, () => evaluate({ ...iron, threats: [zombie, far] }).action), 'fight')
  assert.equal(withFlag('0', () => evaluate({ ...iron, threats: [zombie, far] }).action), 'leave', 'S4c: the creeper\'s 19.4 set the threshold to 20+')
  assert.equal(withFlag(undefined, () => evaluate({ ...iron, threats: [zombie, { ...far, distance: 6, swelling: true }] }).action), 'leave', 'hissing: the Dodge alarm')
  assert.equal(withFlag(undefined, () => evaluate({ ...iron, threats: [zombie, { ...far, distance: 3.5 }] }).action), 'leave', 'at the body')
})

test('a second zombie 15 blocks off is not in the next exchange: the cheap fight at food 12 stays a fight (s8-f1-12: box at 3.3 blocks, death)', () => {
  const was = process.env.ND_FIGHT_COST
  process.env.ND_FIGHT_COST = '1'
  try {
    const hungry = { health: 20, food: 12, foodPoints: 0, weapon: true, expected: 4, phase: 'continue',
      threats: [{ name: 'zombie', hit: 3, distance: 3.3 }, { name: 'zombie', hit: 3, distance: 15.7 }] }
    const now = withFlag(undefined, () => evaluate(hungry))
    assert.equal(now.action, 'fight')
    assert.equal(now.cheap, true)
    assert.notEqual(withFlag('0', () => evaluate(hungry).action), 'fight', 'S4c: threshold 11 + 2.5 x 4 > 20, then "food < 18"')
    // Three walkers at the body are still a crowd, not a cheap fight.
    const crowd = { ...hungry, threats: [0, 1, 2].map(k => ({ name: 'zombie', hit: 3, distance: 2 + k })) }
    assert.notEqual(withFlag(undefined, () => evaluate(crowd).action), 'fight')
  } finally { if (was === undefined) delete process.env.ND_FIGHT_COST; else process.env.ND_FIGHT_COST = was }
})

function walled() {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'
  bot.health = 20; bot.food = 20
  bot.inventory = { slots: [], items: () => [{ name: 'bread', count: 8 }] }
  bot.pathfinder = { setGoal: () => {}, setMovements: () => {}, stop: () => {} }
  bot.registry = { foodsByName: { bread: { foodPoints: 5, saturation: 6 } }, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [], yaw: 0, pitch: 0 }
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  // Floor y 63; a wall x = 1 (y 64-65) between the eye and the zombie at x 2.5.
  bot.blockAt = (p: any) => {
    const q = p.floored()
    const solid = q.y < 64 || q.x === 1 && q.y <= 65
    return { name: solid ? 'stone' : 'air', position: q, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  bot.world = { raycast: () => null }
  const zombie = { id: 2, name: 'zombie', type: 'mob', position: new Vec3(2.5, 64, .5), height: 1.95, width: .6, isValid: true, metadata: [] }
  bot.entities = { 1: bot.entity, 2: zombie }
  return bot
}

test('the zombie that just struck in melee is a foe even when the eye ray misses it; an arrow\'s shooter is not (s5c-g3-3: run from "nobody")', () => {
  const bot = walled()
  const session: any = { bot, current: null, reflex: null, bus: { emit: () => {} },
    autopilot: { lastHurt: { at: gameClock.now(), type: 'mob_attack', byMob: true, sourceId: 2, dimension: 'overworld' } } }
  const seen = withFlag(undefined, () => observeTactics(session))
  assert.deepEqual(seen.enemies.map((e: any) => [e.kind, !!e.unseen]), [['zombie', true]])
  assert.equal(seen.canFight, true)
  assert.equal(withFlag('0', () => observeTactics(session)).enemies.length, 0, 'S4c: no foe in sight, an unidentified attacker')
  session.autopilot.lastHurt.type = 'arrow'
  assert.equal(withFlag(undefined, () => observeTactics(session)).enemies.length, 0)
})

function creeperField({ drop = false } = {}) {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'
  bot.health = 20
  bot.registry = { entitiesByName: { creeper: { metadataKeys: [...Array(16).fill('x'), 'swell_dir', 'is_powered'] }, tnt: { metadataKeys: [] } } }
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, yaw: 0, pitch: 0, onGround: true }
  // Floor y 63; with drop, nothing west of x = -1 (the creeper stands east: the blast throws the body west).
  bot.blockAt = (p: any) => { const q = p.floored(); const floor = q.y === 63 && (!drop || q.x >= -1)
    return { name: floor ? 'stone' : 'air', position: q, boundingBox: floor ? 'block' : 'empty' } }
  bot.lookAt = async () => {}
  bot.clearControlStates = () => {}
  bot.setControlState = () => {}
  const metadata: any[] = []; metadata[16] = 1
  bot.entities = { 1: bot.entity, 3: { id: 3, name: 'creeper', position: new Vec3(3, 64, .5), height: 1.7, isValid: true, metadata } }
  return bot
}

test('a hissing creeper is taken on the raised shield, facing it; with a drop behind the body it is still run from', async () => {
  assert.equal(dropBehind(creeperField(), new Vec3(3, 64, .5)), false)
  assert.equal(dropBehind(creeperField({ drop: true }), new Vec3(3, 64, .5)), true)
  const saved = { dodge: survival.dodgeCreeper, shield: combat.makeShield }
  const calls: string[] = []
  survival.dodgeCreeper = async () => { calls.push('run'); return { how: 'dodge' } }
  combat.makeShield = () => {
    let up = false
    return { wear: async () => true, raise: async () => { up = true; calls.push('raise'); return true }, blocking: () => up, failure: () => null, close: () => {} }
  }
  const run = async (drop: boolean) => {
    const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
    const bot = creeperField({ drop })
    const system = new TacticalSystem({ bot, bus: { emit: () => {} } })
    const done = (system as any).execute({ id: 'Dodge', score: 150, reason: '' }, { aborted: false, onAbort: [] }, tactical({ shield: true, explosion: true }))
    try {
      for (let i = 0; i < 20; i++) { timer.advanceTicks(1); if (i === 10) delete bot.entities[3]; await new Promise(resolve => setImmediate(resolve)) }
      return await done
    } finally { timer.dispose(); gameClock.activate(null) }
  }
  try {
    const blocked = await withFlagAsync(undefined, () => run(false))
    assert.equal(blocked.how, 'shield-blast')
    assert.equal(blocked.blocked, true)
    assert.equal(blocked.clear, true, 'the creeper is gone (spent on the shield)')
    calls.length = 0
    assert.equal((await withFlagAsync(undefined, () => run(true))).how, 'dodge', 'knockback over the drop: run')
    assert.equal((await withFlagAsync('0', () => run(false))).how, 'dodge', 'S4c: always the run')
    assert.ok(!calls.includes('raise'))
  } finally { survival.dodgeCreeper = saved.dodge; combat.makeShield = saved.shield }
})

test('a primed TNT is taken on the shield until it explodes, not for 4 s (arena 16.10: lowered 0.4 s before the blast)', async () => {
  const { shieldBlast } = require('../src/tactics/blast')
  const saved = combat.makeShield
  combat.makeShield = () => { let up = false; return { wear: async () => true, raise: async () => { up = true; return true }, blocking: () => up, failure: () => null, close: () => {} } }
  const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
  const bot = creeperField()
  bot.entities[3] = { id: 3, name: 'tnt', position: new Vec3(3, 64, .5), height: .98, isValid: true, metadata: [] }
  try {
    const done = shieldBlast({ bot }, { aborted: false, onAbort: [] })
    for (let i = 0; i < 120; i++) { timer.advanceTicks(1); if (i === 90) delete bot.entities[3]; await new Promise(resolve => setImmediate(resolve)) }
    const r = await done
    assert.equal(r.blocked, true)
    assert.equal(r.clear, true, 'the shield came down only after the TNT was gone')
    assert.ok(r.seconds >= 4.5, `held ${r.seconds} s, past the former 4 s cap`)
  } finally { timer.dispose(); gameClock.activate(null); combat.makeShield = saved }
})

test('a primed TNT is run from even with a shield; the shield only when the run has nowhere to go (arena 16.10)', async () => {
  const saved = { pick: flee.pickDirection, shield: combat.makeShield }
  let way: any = { yaw: Math.PI / 2, dir: { x: -1, z: 0 } }
  flee.pickDirection = () => way
  combat.makeShield = () => { let up = false; return { wear: async () => true, raise: async () => { up = true; return true }, blocking: () => up, failure: () => null, close: () => {} } }
  const run = async () => {
    const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
    const bot = creeperField()
    bot.look = async () => {}
    bot.entities[3] = { id: 3, name: 'tnt', position: new Vec3(3, 64, .5), height: .98, isValid: true, metadata: [] }
    const system = new TacticalSystem({ bot, bus: { emit: () => {} } })
    const done = (system as any).execute({ id: 'Dodge', score: 150, reason: '' }, { aborted: false, onAbort: [] }, tactical({ shield: true, explosion: true, blast: 'tnt' }))
    try {
      for (let i = 0; i < 40; i++) { timer.advanceTicks(1); if (i === 20) delete bot.entities[3]; await new Promise(resolve => setImmediate(resolve)) }
      return await done
    } finally { timer.dispose(); gameClock.activate(null) }
  }
  try {
    assert.equal((await withFlagAsync(undefined, run)).how, 'dodge-blast', 'a free run: away from the TNT, no shield')
    way = null
    assert.equal((await withFlagAsync(undefined, run)).how, 'shield-blast', 'cornered: the shield')
  } finally { flee.pickDirection = saved.pick; combat.makeShield = saved.shield }
})

test('a tactical run says "не отрывается" after 3 game s when the walker keeps within 5 blocks; other callers run on (S4c: wither skeleton, edge)', async () => {
  const run = async (chaseExit: boolean) => {
    const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
    const bot: any = new EventEmitter()
    bot.health = 20; bot.food = 20
    bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, yaw: 0, pitch: 0, onGround: true, velocity: new Vec3(0, 0, 0) }
    bot.blockAt = (p: any) => { const q = p.floored(); const floor = q.y === 63 && Math.abs(q.x) <= 16 && Math.abs(q.z) <= 16
      return { name: floor ? 'stone' : 'air', position: q, boundingBox: floor ? 'block' : 'empty' } }
    bot.world = { raycast: () => null }
    bot.pathfinder = { setGoal: () => {} }
    bot.look = async () => {}
    bot.setControlState = () => {}
    bot.clearControlStates = () => {}
    const foe = { id: 2, name: 'wither_skeleton', position: new Vec3(4, 64, .5), height: 2.4, isValid: true }
    bot.entities = { 1: bot.entity, 2: foe }
    const done = flee.smartFlee({ bot }, { aborted: false, onAbort: [] }, { timeoutMs: 5000, safeDist: 17, chaseExit })
    try {
      for (let i = 0; i < 120; i++) { timer.advanceTicks(1); await new Promise(resolve => setImmediate(resolve)) }
      return await done
    } finally { timer.dispose(); gameClock.activate(null) }
  }
  const tactic = await withFlagAsync(undefined, () => run(true))
  assert.equal(tactic.mode, 'не отрывается')
  assert.equal(tactic.chased, true)
  assert.equal((await withFlagAsync(undefined, () => run(false))).mode, 'бежал до конца срока')
  assert.equal((await withFlagAsync('0', () => run(true))).mode, 'бежал до конца срока')
})

test('the blaze skill keeps its blazes; a wither skeleton at the body is the tactics\' fight (s1c-A-5: slain at the spawner, no tactics in 40 s)', () => {
  const bot = walled()
  bot.blockAt = (p: any) => { const q = p.floored(); const solid = q.y < 64
    return { name: solid ? 'stone' : 'air', position: q, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] } }
  bot.entities[2] = { id: 2, name: 'blaze', type: 'mob', position: new Vec3(5.5, 65, .5), height: 1.8, width: .6, isValid: true, metadata: [] }
  const session: any = { bot, current: { name: 'blaze', ctl: { aborted: false } }, reflex: null, bus: { emit: () => {} } }
  assert.equal(withFlag(undefined, () => observeTactics(session)).protectedEncounter, true, 'blazes only: the skill fights')
  bot.entities[3] = { id: 3, name: 'wither_skeleton', type: 'mob', position: new Vec3(2.5, 64, .5), height: 2.4, width: .7, isValid: true, metadata: [] }
  assert.equal(withFlag(undefined, () => observeTactics(session)).protectedEncounter, false)
  assert.equal(withFlag('0', () => observeTactics(session)).protectedEncounter, true, 'S4c: the skill owned it')
})

test('a wither skeleton\'s stone sword is counted once (javap: ATTACK_DAMAGE 4 + sword 4 = 8; brute 7 + golden axe 6 = 13)', () => {
  const assess = require('../src/assess')
  const bot: any = { entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => [] }, registry: {} }
  const iron = { armor: 15, tough: 0 }
  const ws = { name: 'wither_skeleton', position: new Vec3(3, 64, 0), equipment: [{ name: 'stone_sword' }] }
  const brute = { name: 'piglin_brute', position: new Vec3(3, 64, 0), equipment: [{ name: 'golden_axe' }] }
  assert.equal(withFlag(undefined, () => assess.sizeUp(bot, ws, iron).hit), 4.5)
  assert.equal(withFlag('0', () => assess.sizeUp(bot, ws, iron).hit), 7.7, 'S4c: 8 + 4 again')
  assert.equal(withFlag(undefined, () => assess.sizeUp(bot, brute, iron).hit), 8.6)
  const zombie = { name: 'zombie', position: new Vec3(3, 64, 0), equipment: [{ name: 'iron_sword' }] }
  assert.equal(withFlag(undefined, () => assess.sizeUp(bot, zombie, iron).hit), withFlag('0', () => assess.sizeUp(bot, zombie, iron).hit), 'a zombie\'s sword is not its own')
})

test('a blaze 30 blocks off that is shooting at the body is a foe (fortress bridge); a quiet one is not; the run from it is priced .3', () => {
  const bot = walled()
  bot.blockAt = (p: any) => { const q = p.floored(); const solid = q.y < 64
    return { name: solid ? 'stone' : 'air', position: q, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] } }
  bot.entities[2] = { id: 2, name: 'blaze', type: 'mob', position: new Vec3(30.5, 66, .5), height: 1.8, width: .6, isValid: true, metadata: [] }
  const session: any = { bot, current: null, reflex: null, bus: { emit: () => {} }, autopilot: { lastHurt: null } }
  assert.equal(withFlag(undefined, () => observeTactics(session)).enemies.length, 0, 'not shooting: not part of the incident')
  session.autopilot.lastHurt = { at: gameClock.now(), type: 'fireball', byMob: true, sourceId: 2, dimension: 'overworld' }
  const shot = withFlag(undefined, () => observeTactics(session))
  assert.deepEqual(shot.enemies.map((e: any) => [e.kind, Math.round(e.distance)]), [['blaze', 30]])
  assert.equal(withFlag(undefined, () => runGain(shot)), .3)
  assert.equal(withFlag('0', () => observeTactics(session)).enemies.length, 0, 'S4c: beyond the 16-block horizon')
  // The fire it lit replaces lastHurt with on_fire (no source); the shot is still remembered for 3 s.
  session.autopilot.lastHurt = { at: gameClock.now(), type: 'on_fire', byMob: false, sourceId: null, dimension: 'overworld' }
  assert.equal(withFlag(undefined, () => observeTactics(session)).enemies.length, 1)
})

test('a walker already at the body is fought while the body outlasts burst + one blow, hungry or not (s4d-smoke2 hungry-zombies: box at 3.4 blocks, 16 -> 6 hp)', () => {
  const hungry = { food: 12, foodPoints: 0, weapon: true, expected: 4, phase: 'continue',
    threats: [{ name: 'zombie', hit: 3, distance: 2.5 }, { name: 'zombie', hit: 3, distance: 15 }] }
  const at16 = withFlag(undefined, () => evaluate({ ...hungry, health: 16 }))
  assert.equal(at16.action, 'fight')
  assert.equal(at16.trade, true)
  const { sustainableFight } = require('../src/tactics/state')
  assert.equal(sustainableFight(at16, 16), true)
  assert.notEqual(withFlag(undefined, () => evaluate({ ...hungry, health: 9 }).action), 'fight', 'burst 6 + blow 3: not at 9')
  assert.notEqual(withFlag(undefined, () => evaluate({ ...hungry, health: 16, threats: [{ name: 'zombie', hit: 3, distance: 5 }] }).action), 'fight', 'not yet at the body: "recover" stands')
  assert.notEqual(withFlag(undefined, () => evaluate({ ...hungry, health: 16, weapon: false }).action), 'fight')
  assert.notEqual(withFlag('0', () => evaluate({ ...hungry, health: 16 }).action), 'fight', 'S4c: "сытость не позволяет лечиться"')
})

test('a different attacker is met with Fight immediately even without an explicit kill notification', () => {
  const { TacticalArbiter } = require('../src/tactics/arbiter')
  const zombie = { id: 2, kind: 'zombie', distance: 3, player: false, threatening: true, hit: 1.4 }
  const run = (forgive: boolean) => {
    const arbiter = new TacticalArbiter()
    assert.equal(arbiter.decide(tactical({ at: 0, contact: true, enemies: [zombie] })).selected?.id, 'Fight')
    arbiter.decide(tactical({ at: 150 }))  // the zombie died: Fight's candidate is gone (dropped)
    arbiter.finished()
    if (forgive) arbiter.forgive('Fight')
    return arbiter.decide(tactical({ at: 450, contact: true, enemies: [{ ...zombie, id: 3 }] })).selected?.id
  }
  assert.equal(run(true), 'Fight')
  assert.equal(run(false), 'Fight', 'a new target cannot inherit the previous fight penalty')
})

test('an archer within 8 blocks is rushed by a hungry body that outlasts the exchange; one at 12 is not a trade yet (s8-f3-3: shot in the back)', () => {
  const hungry = { health: 20, food: 11, foodPoints: 0, weapon: true, expected: 5, phase: 'continue' }
  assert.equal(withFlag(undefined, () => evaluate({ ...hungry, threats: [{ name: 'skeleton', hit: 3.5, distance: 6 }] }).trade), true)
  assert.notEqual(withFlag(undefined, () => evaluate({ ...hungry, threats: [{ name: 'skeleton', hit: 3.5, distance: 12 }] }).action), 'fight')
})

test('a husk\'s iron spear adds its material bonus: 3 + 2 = 5 (Item$Properties.spear, ToolMaterial.IRON 2)', () => {
  const assess = require('../src/assess')
  const bot: any = { entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => [] }, registry: {} }
  const husk = { name: 'husk', position: new Vec3(3, 64, 0), equipment: [{ name: 'iron_spear' }] }
  assert.equal(withFlag(undefined, () => assess.sizeUp(bot, husk, { armor: 0, tough: 0 }).hit), 5)
  assert.equal(withFlag('0', () => assess.sizeUp(bot, husk, { armor: 0, tough: 0 }).hit), 3, 'S4c: the spear was not a weapon')
})

test('a walker the armed body would fight on arrival prices the run down (.2) until it is at the body; a creeper does not (bridge: Flee under fire)', () => {
  const ws = { id: 2, kind: 'wither_skeleton', distance: 7, player: false, threatening: true, hit: 4.5 }
  const blaze = { id: 5, kind: 'blaze', distance: 25, player: false, threatening: true }
  assert.equal(withFlag(undefined, () => runGain(tactical({ enemies: [ws] }))), .2)
  assert.equal(withFlag(undefined, () => runGain(tactical({ burning: true, enemies: [ws, blaze] }))), .3, 'burning under the blazes: the run buys the blaze price, not the walker')
  assert.equal(withFlag(undefined, () => runGain(tactical({ burning: true, enemies: [ws] }))), 1, 'burning, no shooter: the run is the way out of the fire (stand fuzz2-713)')
  assert.equal(withFlag(undefined, () => runGain(tactical({ enemies: [{ ...ws, distance: 3 }] }))), 1, 'at the body: the old price')
  assert.equal(withFlag(undefined, () => runGain(tactical({ canFight: false, enemies: [ws] }))), 1)
  assert.equal(withFlag(undefined, () => runGain(tactical({ enemies: [{ ...ws, kind: 'creeper' }] }))), 1)
  assert.equal(withFlag('0', () => runGain(tactical({ enemies: [ws] }))), 1)
})

test('a tactical Fight is "engaged": combat.fight does not drop it at the start-of-fight food check (60 of 3135 live Fights "skipped")', async () => {
  const saved = combat.fight
  const seen: any[] = []
  combat.fight = async (_s: any, _c: any, opts: any) => { seen.push(opts); return { killed: true } }
  try {
    const bot = walled()
    bot.blockAt = (p: any) => { const q = p.floored(); const solid = q.y < 64
      return { name: solid ? 'stone' : 'air', position: q, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] } }
    const system = new TacticalSystem({ bot, bus: { emit: () => {} } })
    const zombie = { id: 2, kind: 'zombie', distance: 2, player: false, threatening: true, hit: 3 }
    await (system as any).execute({ id: 'Fight', score: 90, reason: '' }, { aborted: false, onAbort: [] }, tactical({ contact: true, enemies: [zombie] }))
    assert.equal(seen[0]?.engaged, true)
  } finally { combat.fight = saved }
  const start = evaluate({ health: 20, food: 20, foodPoints: 0, weapon: true, phase: 'start', threats: [{ name: 'zombie', hit: 3, distance: 6 }] })
  assert.equal(start.action, 'leave', 'the start check alone refuses with no food reserve')
  assert.equal(evaluate({ health: 20, food: 20, foodPoints: 0, weapon: true, phase: 'continue', threats: [{ name: 'zombie', hit: 3, distance: 6 }] }).action, 'fight')
})


test('a melee walker off the white list is a trade too when the margin holds (wither skeleton at food 16), a brute is not', () => {
  const body = { health: 20, food: 16, foodPoints: 40, weapon: true, phase: 'continue' }
  assert.equal(withFlag(undefined, () => evaluate({ ...body, threats: [{ name: 'wither_skeleton', hit: 4.5, distance: 3 }] }).trade), true)
  assert.notEqual(withFlag(undefined, () => evaluate({ ...body, threats: [{ name: 'piglin_brute', hit: 8.6, distance: 3 }] }).action), 'fight')
  assert.notEqual(withFlag(undefined, () => evaluate({ ...body, threats: [{ name: 'blaze', hit: 2.5, distance: 3 }] }).trade), true, 'a blaze is the blaze skill\'s fight')
  assert.notEqual(withFlag('0', () => evaluate({ ...body, threats: [{ name: 'wither_skeleton', hit: 4.5, distance: 3 }] }).action), 'fight')
})

test('a fight dropped at full health (hunger) comes back at full health: the recovery mark is capped at max health', async () => {
  const timer = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 0 }))
  const bot: any = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), onGround: true }
  bot.health = 20; bot.food = 20
  const picks: string[] = []
  let canFight = false
  const ws = { id: 2, kind: 'wither_skeleton', distance: 3, player: false, threatening: true, hit: 4.5 }
  const session: any = { bot, current: null, reflex: null, bus: { emit: (name: string, payload: any) => { if (name === 'tactical_selected') picks.push(payload.action) } } }
  const system = new TacticalSystem(session, { observe: () => tactical({ at: gameClock.now(), contact: true, canFight, enemies: [ws] }), record: () => {},
    execute: async () => { await gameClock.sleep(100); return {} } })
  try {
    system.attach(bot)
    for (let i = 0; i < 6; i++) { timer.advanceTicks(3); system.update(true); await new Promise(resolve => setImmediate(resolve)) }
    canFight = true
    for (let i = 0; i < 40; i++) { timer.advanceTicks(3); system.update(true); await new Promise(resolve => setImmediate(resolve)) }
    assert.ok(picks.includes('Fight'), picks.join(','))
  } finally { system.detach(); timer.dispose(); gameClock.activate(null) }
})

test('time to kill reads a mob\'s synced health: a zombie at 4 hp is a short fight (mobs only)', () => {
  const assess = require('../src/assess')
  const bot: any = { entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => [{ name: 'stone_sword', count: 1 }] },
    registry: { entitiesByName: { zombie: { metadataKeys: [...Array(9).fill('x'), 'health'] } } } }
  const zombie = (hp: number) => { const metadata: any[] = []; metadata[9] = hp; return { name: 'zombie', position: new Vec3(2, 64, 0), equipment: [], metadata } }
  const full = withFlag(undefined, () => assess.sizeUp(bot, zombie(20), { armor: 0, tough: 0 }).toKill)
  const low = withFlag(undefined, () => assess.sizeUp(bot, zombie(4), { armor: 0, tough: 0 }).toKill)
  assert.ok(low < full / 3, `${low} vs ${full}`)
  assert.equal(withFlag('0', () => assess.sizeUp(bot, zombie(4), { armor: 0, tough: 0 }).toKill), full)
})

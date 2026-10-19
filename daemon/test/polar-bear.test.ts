import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as assess from '../src/assess'
import safety = require('../src/combat-safety')
import { observeTactics } from '../src/tactics/minecraft'
import { candidates } from '../src/tactics/state'

function scene() {
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', health: 20, food: 20, oxygenLevel: 20,
    entity: { id: 1, position: new Vec3(.5, 64, .5), onGround: true, height: 1.8, width: .6, effects: {}, metadata: [] },
    entities: {}, game: { dimension: 'overworld', gameMode: 'survival' },
    registry: { foodsByName: { bread: { foodPoints: 5 } }, entitiesByName: {}, effectsByName: {}, blocksByName: {} },
    inventory: { slots: [], items: () => [{ name: 'stone_sword', count: 1 }, { name: 'bread', count: 2 }] },
    blockAt(p: Vec3) { const solid = p.y < 64; return { name: solid ? 'stone' : 'air', position: p.floored(),
      boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] } }
  })
  const bear = (id: number, x: number, baby = false, angry = false) => bot.entities[id] = {
    id, name: 'polar_bear', position: new Vec3(x, 64, .5), width: baby ? .7 : 1.4, height: baby ? .7 : 1.4,
    isValid: true, metadata: { 15: angry ? 4 : 0, 16: baby, 17: false }
  }
  return { bot, bear, session: { bot, current: null, bus: { emit() {} } } }
}

test('an attacking polar bear is priced and enters tactics before it kills the unarmored body', () => {
  const { bot, bear, session } = scene()
  bear(2, 3, false, true)
  assert.equal(assess.MOBS.polar_bear?.hp, 30)
  assert.equal(assess.MOBS.polar_bear.dmg, 6)
  assert.equal(safety.inspect(bot).threats[0]?.name, 'polar_bear')
  const state = observeTactics(session)
  assert.equal(state.enemies[0]?.kind, 'polar_bear')
  assert.ok(state.polarBear, 'a visible aggressive bear has a state-driven response')
  assert.equal(candidates(state)[0].id, state.polarBear.action)
})

test('a solitary calm adult and a cub alone do not start a fight or tax the route', () => {
  const { bot, bear, session } = scene(), polar: typeof import('../src/polar-bear') = require('../src/polar-bear')
  bear(2, 4)
  assert.deepEqual(polar.risks(bot), [])
  assert.equal(safety.inspect(bot).threats.length, 0)
  assert.equal(observeTactics(session).enemies.length, 0)
  assert.deepEqual(assess.plan(bot).foes, [], 'general assessment also leaves the calm neutral alone')
  bot.entities = {}; bear(3, 4, true)
  assert.deepEqual(polar.risks(bot), [])
})

test('visible cub uses the jar box, with spatial hysteresis and no timed re-entry', () => {
  const { bot, bear } = scene(), polar: typeof import('../src/polar-bear') = require('../src/polar-bear')
  const adult = bear(2, 10), cub = bear(3, 18.9, true)
  assert.equal(polar.risks(bot)[0].avoiding, true)
  cub.position.x = 40
  adult.position.x = 16
  assert.equal(polar.risks(bot)[0].avoiding, true, 'past the inner boundary the family remains avoided')
  adult.position.x = 25
  assert.equal(polar.risks(bot).length, 0, 'the outer boundary releases the old cause')
  adult.position.x = 10
  assert.equal(polar.risks(bot).length, 0, 'without cub or aggression returning does not invent a danger')
})

test('new visible family and its spatial release invalidate a running path once per changed cause', () => {
  const { bot, bear, session } = scene()
  let replans = 0
  session['updateMovements'] = () => { replans++ }
  session.current = { name: 'goto' } as any
  bear(2, 15); const cub = bear(3, 16, true)
  observeTactics(session); observeTactics(session)
  assert.equal(replans, 1)
  cub.position.x = 40
  bot.entity.position.x = -10
  observeTactics(session); observeTactics(session)
  assert.equal(replans, 2)
})

test('a cub behind an opaque wall cannot make a visible neutral bear hostile', () => {
  const { bot, bear } = scene(), polar: typeof import('../src/polar-bear') = require('../src/polar-bear'), read = bot.blockAt
  bear(2, 4); bear(3, 8, true)
  bot.blockAt = (p: Vec3) => p.x >= 6 && p.x < 7 ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(p)
  assert.equal(polar.risks(bot).length, 0)
})

test('a damage packet identifies a neutral attacker without requiring a second hit', () => {
  const { bot, bear, session } = scene()
  bear(2, 3)
  session['autopilot'] = { lastHurt: { sourceId: 2, at: (require('../src/game-clock') as typeof import('../src/game-clock')).now(), byMob: true, type: 'mob_attack', dimension: 'overworld' } }
  assert.equal(observeTactics(session).enemies[0]?.kind, 'polar_bear')
  assert.equal(safety.inspect(bot).threats[0]?.name, 'polar_bear')
})

test('water never offers a losing straight swim as an escape; a nearby shore still competes on price', () => {
  const { choose }: typeof import('../src/polar-bear') = require('../src/polar-bear')
  const state = { hp: 20, hit: 6, fightSeconds: 3.75, shield: true, water: true, distance: 3, route: true }
  assert.equal(choose(state).action, 'Fight')
  assert.equal(choose({ ...state, distance: 14, shoreSeconds: .5 }).action, 'Surface')
  assert.equal(choose({ ...state, pillarSeconds: 2 }).action, 'Fight', 'a climb interrupted before clearing reach is not a safe pillar')
})

test('spawn follow-range variation is covered by the outer escape boundary', () => {
  const { MECH }: typeof import('../src/polar-bear') = require('../src/polar-bear')
  assert.equal(MECH.followMax, 20 * (1 + .11485))
  assert.equal(MECH.cubMax, MECH.followMax / 2)
})

test('sprint, walking, a support column and the sword compete by current survival and time', () => {
  const { choose }: typeof import('../src/polar-bear') = require('../src/polar-bear')
  const state = { hp: 20, hit: 6, fightSeconds: 3.75, shield: false, water: false, distance: 10, route: true }
  assert.equal(choose(state).action, 'Flee')
  assert.equal(choose({ ...state, food: 6, shield: true }).action, 'Fight')
  assert.equal(choose({ ...state, distance: 14, pillarSeconds: 2 }).action, 'PillarUp')
})

test('waiting for a distant bear to arrive cannot erase the price of the fight after contact', () => {
  const result = (require('../src/polar-bear') as typeof import('../src/polar-bear')).choose({ hp: 20, hit: 6, fightSeconds: 3.75,
    shield: false, water: false, distance: 20 })
  assert.ok(result.loss > 0)
})

test('a dry body cannot price a route through surrounding water as a winning land sprint', () => {
  const { bot, bear, session } = scene(), polar: typeof import('../src/polar-bear') = require('../src/polar-bear'), read = bot.blockAt
  bear(2, 10, false, true)
  bot.blockAt = (p: Vec3) => p.y >= 63 && p.y < 64 && (Math.floor(p.x) !== 0 || Math.floor(p.z) !== 0)
    ? { name: 'water', position: p.floored(), boundingBox: 'empty', shapes: [] } : read(p)
  assert.notEqual(polar.plan(session).action, 'Flee')
})

test('three blocks above the observed bear are safe; two blocks are inside its possible jump', () => {
  const { bot, bear, session } = scene(), polar: typeof import('../src/polar-bear') = require('../src/polar-bear')
  const e = bear(2, 2, false, true)
  bot.entity.position.y = 66
  assert.equal(polar.canReach(bot, e), true)
  bot.entity.position.y = 67
  assert.equal(polar.canReach(bot, e), false)
  assert.equal(polar.plan(session), null, 'a completed pillar cannot start another pillar')
})

test('the env switch restores the old observation without bear tactical responses', () => {
  const prev = process.env.ND_POLAR_BEAR
  process.env.ND_POLAR_BEAR = '0'
  try {
    const { bot, bear, session } = scene()
    bear(2, 3, false, true)
    assert.equal(safety.inspect(bot).threats.length, 0)
    assert.equal(observeTactics(session).polarBear, null)
  } finally { if (prev === undefined) delete process.env.ND_POLAR_BEAR; else process.env.ND_POLAR_BEAR = prev }
})

test('the tactical graph can change a bear response on a changed route or contact, including at low HP', () => {
  const { bot, bear, session } = scene(), { TacticalGraph }: typeof import('../src/tactics/graph') = require('../src/tactics/graph')
  bear(2, 3, false, true)
  const s = observeTactics(session), graph = new TacticalGraph()
  s.health = 4; s.canFight = false
  s.polarBear.action = 'Fight'
  assert.equal(graph.canTransition('Flee', 'Fight', s), true)
  s.drowning = false; s.polarBear.action = 'Surface'
  assert.equal(graph.canTransition('Fight', 'Surface', s), true)
})

test('a visible attacking bear beyond sixteen blocks reaches the real defense executor', async () => {
  const { bot, bear, session } = scene(), { TacticalSystem }: typeof import('../src/tactics/minecraft') = require('../src/tactics/minecraft')
  const combat: typeof import('../src/combat') = require('../src/combat'), original = combat.fight
  bear(2, 20, false, true)
  const state = observeTactics(session)
  assert.equal(state.enemies[0]?.id, 2)
  state.polarBear.action = 'Fight'
  let options
  combat.fight = async (_session, _ctl, opts) => { options = opts; return { swings: 1 } }
  try {
    await (new TacticalSystem(session) as any).execute({ id: 'Fight' }, { aborted: false }, state)
    assert.equal(options?.target, '#2')
    assert.equal(options.lastStand, true)
    assert.equal(options.shield, 'always')
  } finally { combat.fight = original }
})

test('the tactical simulator uses the jar bear health, pursuit speed and reach', () => {
  const { createWorld, stepWorld }: typeof import('../src/tactics/sim-world') = require('../src/tactics/sim-world')
  const { MECH }: typeof import('../src/polar-bear') = require('../src/polar-bear')
  const world = createWorld({ name: 'bear-model', events: [{ at: 0, type: 'enemy', kind: 'polar_bear', distance: 8 }] })
  stepWorld(world)
  const bear = world.enemies[0]
  assert.equal(bear.hp, 30); assert.equal(bear.damage, 6); assert.equal(bear.every, 20)
  assert.equal(bear.speed, MECH.land)
  assert.ok(Math.abs(bear.reach - MECH.reach) < 1e-9)
})

test('sim-world: a shielded body fights the bear in deep water through real tactical selection', async () => {
  const { runSystem }: typeof import('../src/tactics/sim-run') = require('../src/tactics/sim-run')
  const result = await runSystem({ name: 'polar-water-contact', ticks: 220, skill: false,
    body: { armor: 0, weapon: 'stone_sword', shield: true, blocks: 0, meals: 0, food: 17 },
    world: { exits: false, cover: false }, events: [
      { at: 1, type: 'water', ticks: 200 }, { at: 1, type: 'enemy', kind: 'polar_bear', distance: 3 }
    ] }, { observe: 'minecraft' })
  assert.ok(result.selections.some(s => s.action === 'Fight'), JSON.stringify(result.selections))
  assert.ok(!result.selections.some(s => /Flee|CreateDistance/.test(s.action)), JSON.stringify(result.selections))
  assert.equal(result.died, null, result.log.join('\n'))
})

test('sim-world: bear combat holds the shield between swings through its five-tick raise delay', () => {
  const { createWorld, stepAction, stepWorld, hurt }: typeof import('../src/tactics/sim-world') = require('../src/tactics/sim-world')
  const w = createWorld({ name: 'polar-shield-ready', body: { shield: true, weapon: 'stone_sword' },
    events: [{ at: 0, type: 'enemy', kind: 'polar_bear', distance: 1.5 }] })
  stepWorld(w)
  const run: any = { id: 'Fight', started: w.tick, data: {} }
  for (let i = 0; i < 6; i++) { stepAction(w, run); stepWorld(w) }
  assert.equal(w.body.shieldUp, 5)
  w.body.invul = 0
  assert.equal(hurt(w, 6, 'mob', w.enemies[0]), 0, 'a fresh frontal impact is blocked, without help from damage immunity')
})

test('sim-world: approaching the bear in water uses swimming rather than walking speed', () => {
  const { createWorld, stepAction, stepWorld }: typeof import('../src/tactics/sim-world') = require('../src/tactics/sim-world')
  const { MECH }: typeof import('../src/polar-bear') = require('../src/polar-bear')
  const w = createWorld({ name: 'polar-water-approach', events: [
    { at: 0, type: 'water', ticks: 100 }, { at: 0, type: 'enemy', kind: 'polar_bear', distance: 8 }
  ] })
  stepWorld(w)
  const { x, z } = w.body
  stepAction(w, { id: 'Fight', started: w.tick, data: {} })
  assert.ok(Math.abs(Math.hypot(w.body.x - x, w.body.z - z) - MECH.swim / 20) < 1e-9)
})

test('sim-world: the land escape clears the bear follow range and does not stop inside it', async () => {
  const { runSystem }: typeof import('../src/tactics/sim-run') = require('../src/tactics/sim-run')
  const result = await runSystem({ name: 'polar-land-clear', ticks: 400, skill: false,
    body: { armor: 0, weapon: 'stone_sword', shield: false, blocks: 0, meals: 0, food: 17 },
    world: { exits: true, cover: false, floorDiggable: false },
    events: [{ at: 1, type: 'enemy', kind: 'polar_bear', distance: 3 }] }, { observe: 'minecraft' })
  assert.equal(result.died, null, result.log.join('\n'))
  assert.ok(!result.selections.some(s => s.action === 'Fight'), JSON.stringify(result.selections))
})

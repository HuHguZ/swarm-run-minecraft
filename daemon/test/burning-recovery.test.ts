import test from 'node:test'
import assert from 'node:assert/strict'
import { candidates, type TacticalState } from '../src/tactics/state'
import { TacticalGraph } from '../src/tactics/graph'
import { TacticalArbiter } from '../src/tactics/arbiter'
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const clock = require('../src/game-clock')
const { TacticalSystem } = require('../src/tactics/minecraft')

// H2 native: shore soul_sand/air, FR bottles empty, cooked_beef x2, food 17,
// HP 10 -> 0 from on_fire while the route action had nobody to flee from.
const shore = (changes: Partial<TacticalState> = {}): TacticalState => ({ at: 0, health: 10, food: 17, armor: 14,
  weapon: true, shield: true, enemies: [], incomingProjectiles: 0, burning: true, lava: false, fireResistance: false,
  explosion: false, dangerousFall: false, emergencyController: false, inWater: false, cover: false, portal: false,
  escapeRoute: true, blocks: 555, water: false, edible: true, canFight: false, contact: false, shelter: null,
  protectedEncounter: false, ...changes })

test('dry burning at food 17 offers the bite needed for regeneration before returning to work', () => {
  for (const health of [20, 18, 13, 10, 7]) assert.equal(candidates(shore({ health }))[0]?.id, 'Eat')
  for (const food of [17, 18, 19]) assert.equal(candidates(shore({ food }))[0]?.id, 'Eat')
  const graph = new TacticalGraph()
  for (const previous of ['Flee', 'CreateDistance'] as const) {
    assert.equal(graph.canTransition(previous, 'Eat', shore()), true)
    assert.equal(graph.candidates(shore(), previous)[0]?.id, 'Eat')
  }
  const arbiter = new TacticalArbiter()
  assert.equal(arbiter.decide(shore({ lava: true, at: 0 })).selected?.id, 'Flee')
  assert.equal(arbiter.decide(shore({ at: 1200 })).selected?.id, 'Eat')
})

test('burn recovery does not displace physical escape, active attackers or a usable extinguisher', () => {
  for (const state of [shore({ lava: true }), shore({ lavaAhead: true }), shore({ dangerousFall: true }),
    shore({ incomingProjectiles: 1 }), shore({ contact: true }), shore({ water: true }),
    shore({ enemies: [{ id: 2, kind: 'blaze', distance: 12, player: false, threatening: true }] }),
    shore({ food: 20 }), shore({ edible: false })]) {
    assert.notEqual(candidates(state)[0]?.id, 'Eat')
  }
})

test('a fire tick crossing the low-health level does not restart the same recovery bite', () => {
  const arbiter = new TacticalArbiter()
  assert.equal(arbiter.decide(shore({ health: 10, at: 0 })).selected?.id, 'Eat')
  const lower = arbiter.decide(shore({ health: 8, at: 1500 }))
  assert.equal(lower.level, 3)
  assert.equal(lower.selected?.id, 'Eat')
  assert.equal(lower.change, false)
  const projectile = arbiter.decide(shore({ health: 8, at: 1550, incomingProjectiles: 1 }))
  assert.notEqual(projectile.selected?.id, 'Eat')
  assert.equal(projectile.change, true)
})

test('burn recovery checks local contact before the real bite and observes food/inventory confirmation', async () => {
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  const bot: any = new EventEmitter()
  const beef = { name: 'cooked_beef', type: 1, count: 2 }
  bot.health = 10; bot.food = 17; bot.heldItem = null
  bot.entity = { position: new Vec3(.5, 64, .5), height: 1.8, onGround: true, yaw: 0, metadata: [1] }
  bot.game = { dimension: 'the_nether' }
  bot.inventory = { slots: [], items: () => [beef] }
  bot.blockAt = p => ({ name: p.y < 64 ? 'soul_sand' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored() })
  bot.equip = async () => {}
  bot.consume = async () => { await clock.sleep(1600); beef.count--; bot.food = 20 }
  const session = { bot, mcData: { foodsByName: { cooked_beef: { foodPoints: 8, saturation: 12.8 } } }, bus: { emit() {} } }
  const system = new TacticalSystem(session)
  const ctl = { aborted: false, onAbort: [], abort() { this.aborted = true } }
  try {
    const work = (system as any).execute({ id: 'Eat', score: 105, reason: 'recover from burning' }, ctl, shore())
    for (let i = 0; i < 45; i++) { timer.advanceTicks(1); await new Promise<void>(resolve => setImmediate(resolve)) }
    const result = await work
    assert.equal(result.ate, 'cooked_beef')
    assert.equal(result.food, 20)
    assert.equal(result.spent, 1)
    assert.equal(beef.count, 1)
  } finally { system.detach(); timer.dispose(); clock.activate(null) }
})

test('a failed contact escape never starts the recovery bite', async () => {
  const director = require('../src/director')
  const original = director.escapeFire
  let bites = 0
  const bot = { entities: {}, entity: { position: new Vec3(.5, 64, .5) }, inventory: { items: () => [] } }
  const system = new TacticalSystem({ bot, bus: { emit() {} } })
  const actions = require('../src/actions'), oldEat = actions.eat
  director.escapeFire = async () => ({ status: 'failed', detail: { escaped: false } })
  actions.eat = async () => { bites++; return { ate: 'cooked_beef' } }
  try {
    const result = await (system as any).execute({ id: 'Eat', score: 105, reason: '' }, { aborted: false, onAbort: [] }, shore())
    assert.equal(bites, 0)
    assert.equal(result.failed, true)
  } finally { actions.eat = oldEat; director.escapeFire = original; system.detach() }
})

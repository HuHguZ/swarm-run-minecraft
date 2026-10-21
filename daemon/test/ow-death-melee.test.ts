import test from 'node:test'
import assert from 'node:assert/strict'
import { candidates, type TacticalState } from '../src/tactics/state'
import { TacticalArbiter } from '../src/tactics/arbiter'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { observeTactics } from '../src/tactics/minecraft/observe'

function flag<T>(value: string | undefined, run: () => T): T {
  const keys = ['ND_OW_DEATH_MELEE', 'ND_OW_NIGHT_FLEE']
  const old = keys.map(key => process.env[key])
  if (value === undefined) delete process.env.ND_OW_DEATH_MELEE
  else process.env.ND_OW_DEATH_MELEE = value
  process.env.ND_OW_NIGHT_FLEE = '0'
  try { return run() } finally {
    keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i] })
  }
}

const state = (extra: Partial<TacticalState> = {}): TacticalState => ({ dimension: 'overworld', at: 0,
  health: 14, food: 13, armor: 0, weapon: false, shield: false,
  enemies: [{ id: 1, kind: 'zombie', distance: 2, hit: 3, threatening: true, player: false }],
  incomingProjectiles: 0, burning: false, lava: false, fireResistance: false, explosion: false,
  dangerousFall: false, emergencyController: false, inWater: false, cover: false, portal: false,
  escapeRoute: true, escapeExhausted: true, blocks: 0, water: false, edible: false, canFight: false,
  contact: true, shelter: 'DigDown', digDownCostHp: 3, protectedEncounter: false, ...extra })

test('J: an exhausted OW retreat compares the untried hole with the priced fist stand', () => flag('1', () => {
  const choices = candidates(state())
  assert.equal(choices[0].id, 'DigDown')
  assert.ok(choices.some(c => c.id === 'LastStand' && c.score > 0))
  assert.ok(choices.some(c => c.id === 'Flee' && c.score > 0))
}))

test('J: one HP and no weapon still buys a run; a physical dead end retains the stand', () => flag('1', () => {
  const bare = state({ health: 1, shelter: null })
  assert.equal(candidates(bare)[0].id, 'Flee')
  assert.equal(candidates({ ...bare, escapeRoute: false })[0].id, 'LastStand')
}))

test('J: newly available shelter can replace an already running last stand', () => flag('1', () => {
  const arbiter = new TacticalArbiter()
  assert.equal(arbiter.decide(state({ escapeRoute: false, shelter: null })).selected?.id, 'LastStand')
  const next = arbiter.decide(state({ at: 150 }))
  assert.equal(next.selected?.id, 'DigDown')
  assert.equal(next.change, true)
}))

test('J: armor and a sustainable weapon can keep the stand cheaper than construction', () => flag('1', () => {
  assert.equal(candidates(state({ health: 20, food: 20, armor: 15, weapon: true, canFight: true,
    blocks: 64, shelter: 'BlockOff', enemies: [{ id: 1, kind: 'zombie', distance: 2, hit: 1,
      threatening: true, player: false }] }))[0].id, 'LastStand')
}))

test('J: a costly exposed hole is priced rather than forced', () => flag('1', () => {
  const choices = candidates(state({ health: 13 }))
  assert.equal(choices[0].id, 'LastStand')
  assert.ok(choices.some(c => c.id === 'DigDown' && c.score > 0))
}))

test('J: the default and explicit zero preserve the existing score', () => {
  for (const value of [undefined, '0']) flag(value, () => assert.equal(candidates(state())[0].id, 'LastStand'))
})

test('J: only overworld and minecraft:overworld opt in', () => flag('1', () => {
  for (const dimension of ['overworld', 'minecraft:overworld']) assert.equal(candidates(state({ dimension }))[0].id, 'DigDown')
  for (const dimension of [undefined, 'the_nether', 'minecraft:the_nether', 'the_end', 'fake_overworld']) {
    assert.equal(candidates(state({ dimension }))[0].id, 'LastStand', String(dimension))
  }
}))

test('J: shooter-only and player encounters retain their previous price', () => flag('1', () => {
  for (const [kind, player] of [['skeleton', false], ['HuHguZ', true]] as const) {
    const s = state({ enemies: [{ id: 1, kind, distance: 2, hit: 3, threatening: true, player }] })
    const enabled = candidates(s)
    flag('0', () => assert.deepEqual(enabled, candidates(s)))
  }
  const mixed = state({ enemies: [...state().enemies,
    { id: 2, kind: 'HuHguZ', distance: 2, hit: 5, threatening: true, player: true }] })
  const enabled = candidates(mixed)
  flag('0', () => assert.deepEqual(enabled, candidates(mixed)))
}))

test('J: damage-priced stands remain fallbacks for every supported walker', () => flag('1', () => {
  for (const kind of ['zombie', 'husk', 'zombie_villager', 'spider', 'cave_spider']) {
    const choices = candidates(state({ enemies: [{ id: 1, kind, distance: 2, hit: 3, threatening: true, player: false }] }))
    assert.equal(choices[0].id, 'DigDown', kind)
  }
}))

test('J: explosions and drowning keep their existing immediate response', () => flag('1', () => {
  assert.equal(candidates(state({ explosion: true }))[0].id, 'Dodge')
  assert.equal(candidates(state({ inWater: true, drowning: true }))[0].id, 'Surface')
}))

test('J: Minecraft observations carry the current dimension through world transfers', () => {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'; bot.health = 20; bot.food = 20
  bot.inventory = { slots: [], items: () => [] }
  bot.registry = { foodsByName: {}, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62,
    onGround: true, effects: {}, metadata: [], yaw: 0, pitch: 0 }
  bot.entities = {}
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.blockAt = (p: any) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty',
    position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  const session: any = { bot, current: null, reflex: null, bus: { emit() {} } }
  for (const dimension of ['overworld', 'minecraft:overworld', 'the_nether', 'the_end']) {
    bot.game.dimension = dimension
    assert.equal(observeTactics(session)?.dimension, dimension)
  }
})

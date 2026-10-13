import test from 'node:test'
import assert from 'node:assert/strict'
import { candidates, threatLevel } from '../src/tactics/state'
import { TacticalGraph } from '../src/tactics/graph'
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const clock = require('../src/game-clock')
const { observeTactics, TacticalSystem } = require('../src/tactics/minecraft')

function field() {
  const bot: any = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.11')
  bot.version = '1.21.11'; bot.health = 18; bot.food = 20
  bot.entity = { id: 1, position: new Vec3(50.7, 26, -126.3), height: 1.8, onGround: true, yaw: 0, metadata: [0], effects: {} }
  bot.entities = {}; bot.game = { dimension: 'the_nether' }
  bot.inventory = { slots: [], items: () => [] }
  bot.blockAt = (p: any) => {
    const q = p.floored(), hot = q.x === 50 && q.y === 25 && q.z === -127
    return { name: hot ? 'magma_block' : q.y < 26 ? 'netherrack' : 'air', boundingBox: q.y < 26 ? 'block' : 'empty', position: q }
  }
  bot.getControlState = () => false
  return { bot, mcData: bot.registry, autopilot: { lastHurt: { at: clock.now(), type: 'hot_floor', byMob: false, dimension: 'the_nether' } }, bus: { emit() {} } }
}

test('Q24 actual hot_floor damage on magma selects an escape despite no burning, lava or foes', () => {
  const session = field(), state = observeTactics(session)
  assert.equal(state.burning, false); assert.equal(state.lava, false); assert.equal(state.enemies.length, 0)
  assert.equal(state.hotFloor, true)
  assert.ok(threatLevel(state) >= 2)
  assert.equal(candidates(state)[0]?.id, 'Flee')
  const graph = new TacticalGraph()
  for (const previous of ['Heal', 'Eat', 'Fight', 'BlockOff'] as const) assert.equal(graph.candidates(state, previous)[0]?.id, 'Flee')
})

test('old hot_floor receipts do not cause flight after leaving magma, a world change or expiry', () => {
  for (const change of [
    (s: any) => { s.bot.entity.position = new Vec3(52.5, 26, -126.5) },
    (s: any) => { s.autopilot.lastHurt.dimension = 'overworld' },
    (s: any) => { s.autopilot.lastHurt.at -= 10000 },
    (s: any) => { s.autopilot.lastHurt.type = 'on_fire' }
  ]) {
    const session = field(); change(session)
    assert.equal(!!observeTactics(session).hotFloor, false)
  }
})

function campfireField(name = 'campfire', lit = true) {
  const session = field(), bot = session.bot
  bot.game.dimension = 'overworld'
  bot.entity.position = new Vec3(-275.5, 68.4375, -442.5)
  session.autopilot.lastHurt = { at: clock.now(), type: 'campfire', byMob: false, dimension: 'overworld' }
  bot.blockAt = (p: any) => {
    const q = p.floored(), fire = q.x === -276 && q.y === 68 && q.z === -443
    return { name: fire ? name : q.y < 68 ? 'grass_block' : 'air', boundingBox: fire || q.y < 68 ? 'block' : 'empty',
      position: q, getProperties: () => fire ? { lit } : {} }
  }
  return session
}

for (const name of ['campfire', 'soul_campfire']) test(`actual campfire damage on partial ${name} support selects contact escape`, () => {
  const state = observeTactics(campfireField(name))
  assert.equal(state.hotFloor, true)
  assert.equal(state.burning, false)
  assert.equal(state.lava, false)
  assert.equal(candidates(state)[0]?.id, 'Flee')
})

test('an extinguished campfire or ended campfire contact cannot retain a hot-floor alarm', () => {
  for (const change of [
    (s: any) => { s.bot.blockAt = campfireField('campfire', false).bot.blockAt },
    (s: any) => { s.autopilot.lastHurt.at -= 10000 },
    (s: any) => { s.autopilot.lastHurt.type = 'hot_floor' },
    (s: any) => { delete s.autopilot.lastHurt },
    (s: any) => { s.autopilot.lastHurt.dimension = 'the_nether' },
    (s: any) => { s.bot.entity.position = s.bot.entity.position.offset(1, 0, 0) },
    (s: any) => { s.bot.entity.onGround = false },
    (s: any) => { const e = s.bot.registry.effectsByName.fire_resistance || s.bot.registry.effectsByName.FireResistance; s.bot.entity.effects[e.id] = { amplifier: 0 } }
  ]) {
    const session = campfireField(); change(session)
    assert.equal(!!observeTactics(session).hotFloor, false)
  }
})

test('ordinary fire and lava remain their own physical tactical hazards', () => {
  const fire = campfireField('campfire', false)
  fire.bot.entity.metadata[0] = 1
  const lava = campfireField('campfire', false)
  lava.bot.entity.isInLava = true
  assert.equal(observeTactics(fire).burning, true)
  assert.equal(observeTactics(lava).lava, true)
})

test('fire resistance ends the damaging magma incident without spending another potion', () => {
  const session = field()
  const resistance = session.bot.registry.effectsByName.fire_resistance || session.bot.registry.effectsByName.FireResistance
  session.bot.entity.effects[resistance.id] = { amplifier: 0 }
  const state = observeTactics(session)
  assert.equal(state.fireResistance, true)
  assert.equal(!!state.hotFloor, false)
  assert.equal(threatLevel(state), 0)
})

test('damaging magma with no dry exit uses an available fire-resistance potion before more healing', () => {
  const state = { ...observeTactics(field()), hotFloor: true, escapeRoute: false, fireResistancePotion: true }
  assert.equal(candidates(state)[0]?.id, 'UseFireResistance')
  const graph = new TacticalGraph()
  for (const previous of ['Heal', 'Eat', 'Fight', 'BlockOff'] as const) assert.equal(graph.candidates(state, previous)[0]?.id, 'UseFireResistance')
  assert.notEqual(candidates({ ...state, dangerousFall: true, emergencyController: true })[0]?.id, 'Flee')
})

test('an imminent explosion is dodged before drinking on damaging magma', () => {
  const state = { ...observeTactics(field()), hotFloor: true, fireResistancePotion: true, explosion: true, blast: 'tnt' as const }
  assert.equal(candidates(state)[0]?.id, 'Dodge')
  const graph = new TacticalGraph()
  for (const previous of ['Heal', 'Eat', 'Fight', 'BlockOff'] as const) assert.equal(graph.candidates(state, previous)[0]?.id, 'Dodge')
})

test('a sealed magma escape reports tactical failure rather than completed work', async () => {
  const session = field(), original = session.bot.blockAt
  session.bot.blockAt = (p: any) => {
    const q = p.floored()
    return q.y >= 26 && (q.x !== 50 || q.z !== -127)
      ? { name: 'netherrack', boundingBox: 'block', position: q } : original(p)
  }
  const system = new TacticalSystem(session)
  try {
    const result = await (system as any).execute({ id: 'Flee', score: 142, reason: 'leave damaging magma' }, { aborted: false, onAbort: [] }, { ...observeTactics(session), hotFloor: true })
    assert.equal(result.status, 'failed')
    assert.equal(result.detail.escaped, false)
    assert.equal(result.failed, true)
  } finally { system.detach() }
})

test('the hot-floor flight uses physical contact escape rather than fleeing from no enemy', async () => {
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  const session = field(), bot = session.bot
  bot.lookAt = async (p: any) => { bot.entity.yaw = Math.atan2(-(p.x - bot.entity.position.x), -(p.z - bot.entity.position.z)) }
  let moved = false
  bot.setControlState = (key: string, on: boolean) => {
    if (key === 'forward' && on) { moved = true; bot.entity.position = bot.entity.position.offset(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw)) }
  }
  bot.clearControlStates = () => {}
  const system = new TacticalSystem(session)
  try {
    const state = { ...observeTactics(session), hotFloor: true }
    const work = (system as any).execute({ id: 'Flee', score: 142, reason: 'leave damaging magma' }, { aborted: false, onAbort: [] }, state)
    for (let i = 0; i < 40; i++) { timer.advanceTicks(1); await new Promise<void>(resolve => setImmediate(resolve)) }
    const result = await work
    assert.equal(moved, true, JSON.stringify(result))
    assert.equal(result.detail.escaped, true)
    assert.notEqual(bot.blockAt(bot.entity.position.offset(0, -.01, 0)).name, 'magma_block')
  } finally { system.detach(); timer.dispose(); clock.activate(null) }
})

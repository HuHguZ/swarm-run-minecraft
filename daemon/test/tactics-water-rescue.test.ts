import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const { Vec3 } = require('vec3')
const clockMod = require('../src/game-clock')
const movement = require('../src/movement')
const { TacticalSystem, observeTactics } = require('../src/tactics/minecraft')
const { TacticalArbiter } = require('../src/tactics/arbiter')
const { candidates, threatLevel } = require('../src/tactics/state')

function fixture(name = 'structure') {
  const clock = clockMod.activate(new clockMod.GameClock({ manual: true, epoch: 10000 }))
  const bot: any = new EventEmitter()
  let wet = true
  Object.assign(bot, { version: '1.21.11', health: 17.2, food: 20, oxygenLevel: 20, entities: {},
    registry: { foodsByName: {}, entitiesByName: {}, effectsByName: {}, blocksByName: {} },
    inventory: { slots: [], items: () => [] }, game: { dimension: 'overworld', gameMode: 'survival' },
    entity: { id: 1, position: new Vec3(.5, 60, .5), height: 1.8, eyeHeight: 1.62, onGround: false,
      effects: {}, metadata: [], yaw: 0, pitch: 0, isInWater: true },
    pathfinder: { setGoal() {}, stop() {} }, clearControlStates() {}, getControlState: () => false,
    blockAt(p: any) {
      const q = p.floored(), solid = q.y < 60, water = wet && !solid && q.y < 62
      return { name: solid ? 'stone' : water ? 'water' : 'air', position: q,
        boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({}) }
    } })
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const f of this.onAbort) f() } }
  const session: any = { bot, bus: { emit() {} }, current: { name, ctl }, reflex: null,
    autopilot: { lastHurt: { at: clockMod.now(), byMob: true, source: 'drowned', sourceId: 2, dimension: 'overworld' } } }
  return { session, bot, ctl, clock, dry() { wet = false; bot.entity.isInWater = false; bot.entity.onGround = true },
    close() { clock.dispose() } }
}

for (const name of ['structure', 'mine', 'explore']) test(`water damage preempts ${name} before the Surface promise completes`, async () => {
  const previous = process.env.ND_TACTICS_WATER_HURT
  process.env.ND_TACTICS_WATER_HURT = '1'
  const f = fixture(name)
  let complete: (r: any) => void = () => {}
  const tactics = f.session.tactics = new TacticalSystem(f.session, { record() {}, execute: () => new Promise(resolve => { complete = resolve }) })
  try {
    f.session._airManaged = true
    tactics.attach(f.bot); tactics.update(true)
    assert.equal(f.ctl.aborted, true, 'the worker is cancelled synchronously on the injury sample')
    assert.equal(tactics.snapshot().action, 'Surface', 'full lungs do not make fighting/work safe in this water')
    assert.equal(tactics.snapshot().state.waterEscape, true)
    await new Promise<void>(resolve => setImmediate(resolve))
    f.clock.advanceTicks(200)
    f.bot.entities[2] = { id: 2, name: 'drowned', position: new Vec3(1.5, 60, .5), height: 1.95, width: .6, metadata: [], equipment: [] }
    f.bot.entity.isInWater = false // stale physics flag / a moment with dry eyes is not dry support
    assert.equal(movement.inWater(f.bot), true)
    assert.equal(observeTactics(f.session).waterEscape, true)
    f.bot.entity.position.y = 63.4492 // ia8-fp1-s12-2/402: above the water during a jump, still without dry support
    assert.equal(movement.inWater(f.bot), false)
    assert.equal(observeTactics(f.session).waterEscape, true, 'surfacing alone cannot hand the body to a new box build')
    f.bot.entity.position.y = 60
    f.dry()
    assert.equal(observeTactics(f.session).waterEscape, false, 'dry supported ground ends the mode, without a timer')
    complete({ ok: true }); await tactics.waitForRelease()
  } finally {
    complete({ cancelled: true }); tactics.detach(); f.close()
    if (previous === undefined) delete process.env.ND_TACTICS_WATER_HURT; else process.env.ND_TACTICS_WATER_HURT = previous
  }
})

test('water injury switch off preserves the existing noncritical RPC; dry injury and dimension transfer do not latch water', () => {
  const previous = process.env.ND_TACTICS_WATER_HURT
  const f = fixture()
  try {
    process.env.ND_TACTICS_WATER_HURT = '0'
    assert.ok(!observeTactics(f.session).waterEscape)
    assert.equal(f.ctl.aborted, false)
    process.env.ND_TACTICS_WATER_HURT = '1'
    assert.equal(observeTactics(f.session).waterEscape, true)
    f.bot.game.dimension = 'the_nether'
    assert.equal(observeTactics(f.session).waterEscape, false, 'old-world injury cannot own the new world')
    f.bot.game.dimension = 'overworld'; f.dry()
    assert.equal(observeTactics(f.session).waterEscape, false)
  } finally { f.close(); if (previous === undefined) delete process.env.ND_TACTICS_WATER_HURT; else process.env.ND_TACTICS_WATER_HURT = previous }
})

test('new attackers and low HP do not restart an ongoing swim to dry ground', () => {
  const f = fixture()
  try {
    const state = { ...observeTactics(f.session), waterEscape: true }
    const arbiter = new TacticalArbiter()
    assert.equal(arbiter.decide(state).selected.id, 'Surface')
    const next = arbiter.decide({ ...state, health: 5, enemies: [{ id: 3, kind: 'drowned', distance: 2, threatening: true, player: false }] })
    assert.equal(next.selected.id, 'Surface')
    assert.equal(next.change, false, 'continue the same bounded executor')
  } finally { f.close() }
})

test('the real damage_event hook takes water rescue on the first drowned hit at 17.2 HP', async () => {
  const previous = process.env.ND_TACTICS_WATER_HURT
  process.env.ND_TACTICS_WATER_HURT = '1'
  const f = fixture()
  let complete: (r: any) => void = () => {}
  f.bot._client = new EventEmitter(); f.bot.health = 20
  const { Autopilot } = require('../src/autopilot')
  f.session.autopilot = new Autopilot(f.session, {})
  f.session.autopilot.hookDamage(f.bot)
  f.bot.entities[2] = { id: 2, name: 'drowned', position: new Vec3(1.5, 60, .5), height: 1.95, width: .6, metadata: [], equipment: [] }
  const tactics = f.session.tactics = new TacticalSystem(f.session, { record() {}, execute: () => new Promise(resolve => { complete = resolve }) })
  try {
    tactics.attach(f.bot)
    f.bot._client.emit('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 3 })
    f.bot.health = 17.2; f.bot.emit('health')
    assert.equal(f.ctl.aborted, true)
    assert.equal(tactics.snapshot().action, 'Surface')
    await new Promise<void>(resolve => setImmediate(resolve))
    complete({ ok: true }); await tactics.waitForRelease()
  } finally {
    complete({ cancelled: true }); tactics.detach(); f.close()
    if (previous === undefined) delete process.env.ND_TACTICS_WATER_HURT; else process.env.ND_TACTICS_WATER_HURT = previous
  }
})

test('a favorable underwater fight remains cheaper than surfacing, while the work RPC is still interrupted immediately', async () => {
  const f = fixture('mine')
  const state = { ...observeTactics(f.session), waterEscape: true, inWater: true, weapon: true, canFight: true, contact: true,
    enemies: [{ id: 2, kind: 'drowned', distance: 2, hit: 2.8, threatening: true, player: false }] }
  let complete: (r: any) => void = () => {}
  const tactics = f.session.tactics = new TacticalSystem(f.session, { observe: () => state, record() {}, execute: () => new Promise(resolve => { complete = resolve }) })
  try {
    assert.equal(threatLevel(state), 2, 'one noncritical hit does not pretend the health is critical')
    const prices = candidates(state)
    assert.ok(prices.find(c => c.id === 'Fight').score > prices.find(c => c.id === 'Surface').score)
    tactics.attach(f.bot); tactics.update(true)
    assert.equal(f.ctl.aborted, true, 'a favorable fight also owns the body before the old work can resume')
    assert.equal(tactics.snapshot().action, 'Fight')
    await new Promise<void>(resolve => setImmediate(resolve))
    complete({ killed: 'drowned' }); await tactics.waitForRelease()
  } finally { complete({ cancelled: true }); tactics.detach(); f.close() }
})

test('a supported sealed air pocket ends the water takeover even with wet feet', () => {
  const previous = process.env.ND_TACTICS_WATER_HURT
  process.env.ND_TACTICS_WATER_HURT = '1'
  const f = fixture()
  try {
    assert.equal(observeTactics(f.session).waterEscape, true)
    f.clock.advanceTicks(200)
    f.bot.entity.onGround = true
    f.bot.oxygenLevel = 8 // a safe sealed pocket can hand back before a full refill
    f.bot.blockAt = (p: any) => {
      const q = p.floored(), inside = q.x === 0 && q.z === 0 && (q.y === 60 || q.y === 61)
      return { name: inside ? q.y === 60 ? 'water' : 'air' : 'stone', position: q,
        boundingBox: inside ? 'empty' : 'block', shapes: inside ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
    }
    assert.equal(movement.inWater(f.bot), true)
    assert.equal(observeTactics(f.session).waterEscape, false, 'safe shelter may return to work without pretending wet feet are dry shore')
  } finally { f.close(); if (previous === undefined) delete process.env.ND_TACTICS_WATER_HURT; else process.env.ND_TACTICS_WATER_HURT = previous }
})

test('full air with no contact releases an offshore takeover, so it cannot loop Surface from nobody forever', () => {
  const previous = process.env.ND_TACTICS_WATER_HURT
  process.env.ND_TACTICS_WATER_HURT = '1'
  const f = fixture()
  try {
    assert.equal(observeTactics(f.session).waterEscape, true)
    f.clock.advanceTicks(200)
    f.bot.entity.position.y = 61.5
    assert.equal(movement.inWater(f.bot), true)
    assert.equal(f.bot.entity.onGround, false)
    const state = observeTactics(f.session)
    assert.equal(state.contact, false)
    assert.equal(state.waterEscape, false, 'breath recovery and ended contact return water travel to the campaign')
  } finally { f.close(); if (previous === undefined) delete process.env.ND_TACTICS_WATER_HURT; else process.env.ND_TACTICS_WATER_HURT = previous }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clockMod from '../src/game-clock'
import { observeTactics, TacticalSystem } from '../src/tactics/minecraft'
import { candidates } from '../src/tactics/state'
import { TacticalArbiter } from '../src/tactics/arbiter'
import * as careful from '../src/careful'
import * as locks from '../src/reflex-lock'
import { declarationsOf } from './source-fixture'
import { campaignTs } from './campaign-source'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

function fixture(dimension = 'overworld', oxygen = 0, name = 'mine') {
  const clock = clockMod.activate(new clockMod.GameClock({ manual: true, epoch: 10000 }))
  const bot: any = new EventEmitter(), control: any = { sneak: false }
  Object.assign(bot, { version: '1.21.11', health: 20, food: 20, oxygenLevel: oxygen, entities: {},
    registry: { foodsByName: {}, entitiesByName: {}, effectsByName: {}, blocksByName: {} },
    inventory: { slots: [], items: () => [] }, game: { dimension, gameMode: 'survival' },
    entity: { id: 1, position: new Vec3(.5, 50, .5), height: 1.8, eyeHeight: 1.62, onGround: true,
      effects: {}, metadata: [], yaw: 0, pitch: 0, isInWater: false }, // stale physics, water is physically at the eyes
    pathfinder: { setGoal() {}, stop() {} }, clearControlStates() { for (const k of Object.keys(control)) control[k] = false },
    getControlState: (k: string) => !!control[k], setControlState(k: string, v: boolean) { control[k] = v },
    supportFeature: () => true, _client: Object.assign(new EventEmitter(), { write() {} }),
    blockAt(p: any) {
      const q = p.floored(), solid = q.y < 50
      return { name: solid ? 'magma_block' : q.y < 53 ? 'water' : 'air', position: q,
        boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({}) }
    } })
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const f of this.onAbort) f() } }
  const session: any = { bot, current: { name, ctl }, bus: { emit() {} }, cfg: {}, reflex: null, autopilot: {} }
  return { session, bot, ctl, clock, close() { clock.dispose() } }
}

test('J OW air alarm reads the occupied water despite stale physics; flag off and other dimensions retain policy', () => {
  const saved = process.env.ND_OW_DEATH_WATER
  try {
    for (const dimension of ['overworld', 'minecraft:overworld', 'the_nether', 'the_end']) for (const enabled of ['0', '1']) {
      process.env.ND_OW_DEATH_WATER = enabled
      const f = fixture(dimension)
      try { assert.equal(!!observeTactics(f.session).waterEmergency, enabled === '1' && dimension.replace(/^minecraft:/, '') === 'overworld') }
      finally { f.close() }
    }
  } finally { if (saved === undefined) delete process.env.ND_OW_DEATH_WATER; else process.env.ND_OW_DEATH_WATER = saved }
})

test('J debt of air keeps Surface available after a failed retreat/Surface and before a burial wait', () => {
  const f = fixture()
  try {
    const state = { ...observeTactics(f.session), waterEmergency: true, drowning: true, embedded: true,
      escapeExhausted: true, failedEscapes: ['Surface', 'Flee'] as any, blocks: 0 }
    assert.equal(candidates(state)[0]?.id, 'Surface')
    const arbiter = new TacticalArbiter()
    assert.equal(arbiter.decide(state).selected?.id, 'Surface')
    assert.equal(arbiter.decide({ ...state, health: 3 }).change, false, 'a hurt pulse must not reset the active swim')
  } finally { f.close() }
})

test('J actual drowning preempts a commanded movement intent through the ordinary tactical lease', async () => {
  const saved = process.env.ND_OW_DEATH_WATER; process.env.ND_OW_DEATH_WATER = '1'
  const f = fixture('overworld', 0, 'juke')
  let complete: (v: any) => void = () => {}
  const tactics = f.session.tactics = new TacticalSystem(f.session, { record() {}, execute: () => new Promise(resolve => { complete = resolve }) })
  try {
    tactics.attach(f.bot); tactics.update(true)
    assert.equal(f.ctl.aborted, true)
    assert.equal(tactics.snapshot().action, 'Surface')
    assert.equal(tactics.snapshot().owner, 'Emergency')
    await new Promise<void>(resolve => setImmediate(resolve))
    complete({ ok: true }); await tactics.waitForRelease()
  } finally {
    complete({ cancelled: true }); tactics.detach(); f.close()
    if (saved === undefined) delete process.env.ND_OW_DEATH_WATER; else process.env.ND_OW_DEATH_WATER = saved
  }
})

test('J late magma safety releases its own Shift when physical air runs out, including input-packet enforcement', () => {
  const saved = process.env.ND_OW_DEATH_WATER, magma = process.env.ND_MAGMA_ESCAPE
  process.env.ND_OW_DEATH_WATER = '1'; process.env.ND_MAGMA_ESCAPE = '1'
  const f = fixture('overworld', 20)
  try {
    careful.install(f.session, f.bot); f.bot.emit('physicTick')
    assert.equal(f.bot.getControlState('sneak'), true)
    f.bot.oxygenLevel = 0; f.bot.emit('physicTick')
    assert.equal(f.bot.getControlState('sneak'), false)
    assert.equal(locks.keepMagmaSneak(f.session), false)
  } finally {
    f.close()
    if (saved === undefined) delete process.env.ND_OW_DEATH_WATER; else process.env.ND_OW_DEATH_WATER = saved
    if (magma === undefined) delete process.env.ND_MAGMA_ESCAPE; else process.env.ND_MAGMA_ESCAPE = magma
  }
})

test('J managed air still interrupts a protected encounter when native air reaches the OW alarm', async () => {
  const saved = process.env.ND_OW_DEATH_WATER; process.env.ND_OW_DEATH_WATER = '1'
  const f = fixture('overworld', 8, 'blaze')
  f.session._airManaged = true; f.session._blazeCombatCtl = f.ctl
  let complete: (v: any) => void = () => {}
  const tactics = f.session.tactics = new TacticalSystem(f.session, { record() {}, execute: () => new Promise(resolve => { complete = resolve }) })
  try {
    const state = observeTactics(f.session)
    assert.equal(state.drowning, false); assert.equal(state.protectedEncounter, true)
    tactics.attach(f.bot); tactics.update(true)
    assert.equal(f.ctl.aborted, true)
    assert.equal(tactics.snapshot().action, 'Surface')
    await new Promise<void>(resolve => setImmediate(resolve))
    complete({ ok: true }); await tactics.waitForRelease()
  } finally {
    complete({ cancelled: true }); tactics.detach(); f.close()
    if (saved === undefined) delete process.env.ND_OW_DEATH_WATER; else process.env.ND_OW_DEATH_WATER = saved
  }
})

test('J air can leave the stale airborne-controller node, while an actual dangerous fall keeps its controller', () => {
  const f = fixture()
  try {
    const state = { ...observeTactics(f.session), drowning: false, emergencyController: true, waterEmergency: false }
    const arbiter = new TacticalArbiter()
    assert.equal(arbiter.decide(state).selected, null)
    assert.equal(arbiter.decide({ ...state, waterEmergency: true }).selected?.id, 'Surface')
    assert.equal(arbiter.decide({ ...state, waterEmergency: true, dangerousFall: true }).selected, null)
  } finally { f.close() }
})

test('J submerged burial uses water escape; dry burial and flag-off retain the existing wait', async () => {
  const code = declarationsOf(campaignTs(), 'waitDugOut')
  for (const enabled of ['0', '1']) for (const wet of [false, true]) {
    const calls: string[] = []
    const ctx: any = { process: { env: { ND_OW_DEATH_WATER: enabled } }, dim: () => 'overworld', sit: { inWater: wet, buried: true },
      died: false, fighting: false, log() {}, setFighting() {}, leaveWater: async () => calls.push('water'),
      act: async () => calls.push('wait'), sense: async () => { ctx.sit.buried = false } }
    vm.runInNewContext(transformSync(code + '\nthis.run = waitDugOut', { loader: 'ts' }).code, ctx)
    await ctx.run()
    assert.deepEqual(calls, enabled === '1' && wet ? ['water'] : ['wait'])
  }
})

import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as vm from 'node:vm'
import { createRequire } from 'node:module'
import { bodySource } from './source-fixture'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { missing } from '../src/dragon'

async function finish (weapon, bow, arrows, ph = 0) {
  const file = require.resolve('../src/dragon/pillar-run')
  const local = createRequire(file)
  let now = 0; let shots = 0; let waits = 0; let perches = 0
  const ctl: any = { aborted: false, feed: {}, bedsOnly: true, pillarMode: false, beds: true }
  const inventory = [weapon && { name: weapon, count: 1 }, bow && { name: 'bow', count: 1 },
    arrows && { name: 'arrow', count: arrows }, { name: 'cobblestone', count: 64 }].filter(Boolean)
  const bot: any = { health: 20, food: 20, isAlive: true, game: { dimension: 'the_end' },
    entity: { position: new Vec3(15.5, 65, 0.5), onGround: true }, entities: {},
    inventory: { items: () => inventory, slots: [] } }
  const d = { id: 42, yaw: 0, position: new Vec3(0.5, 75, 0.5) }
  const mocks: any = {
    './dig-down-to': { ...local('./dig-down-to'), gameClock: { now: () => now },
      makeTrack: () => ({ tick: () => d }), dragonOf: () => d, hpOf: () => 82, phaseOf: () => ph,
      yieldTick: async () => { now += 1000 }, sleep: async () => { waits++; ctl.aborted = true },
      items: { bestWeapon: () => weapon ? { name: weapon } : null },
      partsOf: () => ({ headC: new Vec3(0.5, 75, 0.5), bodyC: d.position }) },
    './fall-guard': { ...local('./fall-guard'), hunters: () => [], overCloud: () => false,
      nearEdge: () => false, podiumTop: () => 68, pickSpot: () => null },
    './evade-raw': { ...local('./evade-raw'), dangerAt: () => null, lookAtSafe: async () => {} },
    './station-plan': { ...local('./station-plan'), onSpike: () => false, onOwnPillar: () => null,
      rangedShot: async () => { shots++; ctl.aborted = true; return true } },
    './pillar-plan': { ...local('./pillar-plan'), noteTakeoff: () => {}, stationBedPlaced: () => false, crysOn: () => false }
  }
  const module = { exports: {} as any }
  // Тело pillar-run разнесено по dragon/pillar-run/: bodySource склеивает его в один скрипт (подмены по spec — во всех частях).
  vm.runInNewContext(bodySource(file) + '\ndragonZones = () => ({}); hazardNow = () => null; perchAttack = onPerch;', cjsContext({
    module, exports: module.exports, require: name => mocks[name] || local(name), process, console, setImmediate,
    onPerch: async () => { perches++; ctl.aborted = true }
  }), { filename: file })
  const rep: any = { dragon: {} }
  await module.exports.fightDragon({ bot }, ctl, rep, { phases: [], dodges: {} }, { deadline: 10000 })
  return { rep, shots, waits, perches }
}

test('spent beds: dragon healed to native 82 HP can still be finished with available arrows', async () => {
  const result = await finish('iron_sword', true, 48)
  assert.equal(result.shots, 1)
  assert.equal(result.rep.need, undefined)
})

test('spent beds: a sword keeps the fight waiting for another landing', async () => {
  const result = await finish('iron_sword', false, 0)
  assert.equal(result.waits, 1)
  assert.equal(result.rep.need, undefined)
})

test('spent beds: a bow with arrows can finish without a sword', async () => {
  const result = await finish(null, true, 48)
  assert.equal(result.shots, 1)
  assert.equal(result.rep.need, undefined)
})

test('spent beds with no remaining attack equipment reports a physical need', async () => {
  const result = await finish(null, false, 0)
  assert.equal(result.rep.need.what, 'red_bed')
  assert.equal(result.shots + result.waits, 0)
})

test('spent beds: a sword uses the existing perch fight without a bed station', async () => {
  const result = await finish('iron_sword', false, 0, 5)
  assert.equal(result.perches, 1)
  assert.equal(result.rep.need, undefined)
})

test('an empty bow cannot keep an exhausted-bed fight alive', async () => {
  const result = await finish(null, true, 0)
  assert.equal(result.rep.need.what, 'red_bed')
  assert.equal(result.shots + result.waits, 0)
})

for (const kit of [{ weapon: 'iron_sword', bow: 0, arrows: 0 }, { weapon: null, bow: 1, arrows: 48 }]) {
  test(`beds RPC can resume on the island with ${kit.weapon || 'bow'} after beds are spent`, () => {
    const needs = missing({ ...kit, beds: 0, blocks: 0, food: 0, pickaxe: 'iron_pickaxe' }, 'beds', { crystals: 2, caged: 2, island: true })
    assert.deepEqual(needs, [])
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAerial, interceptPoint, type AerialState } from '../src/combat/aerial-graph'
import { createAerialCombat } from '../src/combat/aerial-executor'

const actor = (id: number, x: number, y: number) => ({ id, position: { x, y, z: 0 }, velocity: { x: 0.1, y: -0.6, z: 0 }, flying: true, grounded: false, alive: true })
const state = (): AerialState => ({ self: actor(1, 0, 80), target: actor(2, 2, 77), health: 20, interrupted: false,
  safeLanding: { x: 0, y: 64, z: 0 }, corridorClear: true, equipment: { elytra: true, chestplate: true, rockets: 8, pearls: 4, mace: true, spear: true },
  maceReady: true, spearReady: true, fallDistance: 4, pearlDamage: 5 })

test('airborne graph attacks a moving airborne opponent with a confirmed landing', () => {
  const s = state()
  assert.equal(evaluateAerial(s).node, 'DiveStrike')
  s.equipment.mace = false
  assert.equal(evaluateAerial(s).node, 'SpearStrike')
  s.target!.velocity.x = 0.6
  assert.ok(interceptPoint(s.self, s.target!).x > s.target!.position.x)
})
test('void and blocked corridors cannot authorize a strike or pearl', () => {
  const s = state(); s.safeLanding = null
  assert.equal(evaluateAerial(s).selected, undefined)
  s.safeLanding = { x: 0, y: 64, z: 0 }; s.corridorClear = false
  assert.equal(evaluateAerial(s).node, 'SafeLanding')
  s.health = 5; s.corridorClear = true
  assert.equal(evaluateAerial(s).node, 'SafeLanding')
})
test('target loss and interruption stop the active aerial attack', () => {
  const s = state(); s.target = null
  assert.equal(evaluateAerial(s).node, 'SafeLanding')
  s.interrupted = true
  assert.equal(evaluateAerial(s).node, 'Interrupted')
})
test('airborne ranged node requires available ammunition, firing corridor and safe landing', () => {
  const s = state(); s.target!.position.x = 22; s.equipment.mace = false; s.equipment.spear = false
  s.equipment.ranged = true; s.rangedReady = true
  assert.equal(evaluateAerial(s).node, 'RangedVolley')
  s.corridorClear = false
  assert.equal(evaluateAerial(s).node, 'SafeLanding')
  s.corridorClear = true; s.safeLanding = null
  assert.equal(evaluateAerial(s).selected, undefined)
  s.safeLanding = { x: 0, y: 64, z: 0 }; s.rangedReady = false
  assert.notEqual(evaluateAerial(s).node, 'RangedVolley')
})

test('a flight that enters ranged reach stops interception and fires the selected volley', async () => {
  const Vec3 = require('vec3')
  const ranged = require('../src/ranged')
  const originals = { crossbows: ranged.crossbows, fire: ranged.fire }
  const crossbow = { name: 'crossbow', slot: 36 }
  const target = { id: 2, position: new Vec3(80, 100, 0), velocity: new Vec3(0, 0, 0), flying: true }
  const bot: any = { health: 20, entity: { id: 1, position: new Vec3(0, 100, 0), velocity: new Vec3(1, 0, 0), flying: true },
    inventory: { items: () => [crossbow] }, world: { raycast: () => null } }
  let fired = 0
  ranged.crossbows = () => [{ item: crossbow, info: { loaded: true, ammo: 'arrow' } }]
  ranged.fire = async () => { fired++; return { fired: true } }
  const operations: any = {
    enemy: () => target, worldOf: () => ({ floorBelow: () => ({ top: 80 }) }),
    kit: () => ({ elytra: true, chest: false, mace: false, rockets: 1 }), landingSpot: () => new Vec3(20, 80, 0),
    gliding: (e: any) => e.flying, stats: {}, allow() {}, used() {},
    fly: async (_ctl: any, _ignored: any, options: any) => {
      target.position.x = 20
      assert.equal(options.until(), 'RangedVolley')
      return { ok: true }
    }
  }
  try {
    const result = await createAerialCombat(bot, operations).run({ aborted: false })
    assert.equal(result.node, 'RangedVolley')
    assert.equal(result.fired, true)
    assert.equal(fired, 1)
  } finally { Object.assign(ranged, originals) }
})

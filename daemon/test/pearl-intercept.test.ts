import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { predictPearl, planPearlResponse, pearlHeightWorth, type ObservedPearl, type PearlWorld, type PearlResponseState } from '../src/combat/pearl-intercept'

const observed: ObservedPearl = { id: 8, ownerId: 2, position: { x: 0, y: 5, z: 0 }, velocity: { x: 1, y: 0.2, z: 0.5 }, observedAt: 1000, visible: true, alive: true }
const ground: PearlWorld = { trace: (a, b) => b.y <= 0 ? { point: { ...b, y: 0 } } : null }
const state: PearlResponseState = { position: { x: 0, y: 0, z: 0 }, health: 20, pearlDamage: 5, pearls: 2, cobwebs: 1,
  interrupted: false, safeArrival: true, occupied: false, routeClear: true, walkingBlocksPerTick: 0.28 }
test('observed pearls predict three dimensional movement and reconcile changed collisions', () => {
  const first = predictPearl(observed, ground, 1100)!
  assert.ok(first.teleport.x > 10 && first.teleport.z > 5)
  assert.ok(first.teleport.y > 0)
  const wall: PearlWorld = { trace: (a, b) => b.x >= 3 ? { point: { ...b, x: 3 } } : ground.trace(a, b) }
  const second = predictPearl(observed, wall, 1100)!
  assert.ok(second.ticks < first.ticks)
  assert.ok(second.teleport.x < 3)
})
test('unseen, expired, removed and unloaded pearls never authorize interception', () => {
  assert.equal(predictPearl({ ...observed, visible: false }, ground, 1100), null)
  assert.equal(predictPearl({ ...observed, alive: false }, ground, 1100), null)
  assert.equal(predictPearl(observed, ground, 2600), null)
  assert.equal(predictPearl(observed, { trace: () => 'unloaded' }, 1100), null)
})
test('arrival response chooses trap, walking interception, or safe counter pearl', () => {
  const prediction = predictPearl(observed, ground, 1100)!
  assert.equal(planPearlResponse({ ...prediction, teleport: { x: 3, y: 0, z: 0 } }, state)?.kind, 'TrapArrival')
  assert.equal(planPearlResponse({ ...prediction, teleport: { x: 5, y: 0, z: 0 }, ticks: 40 }, { ...state, cobwebs: 0 })?.kind, 'PearlIntercept')
  assert.equal(planPearlResponse(prediction, { ...state, cobwebs: 0, routeClear: false })?.kind, 'CounterPearl')
  for (const change of [{ safeArrival: false }, { occupied: true }, { interrupted: true }, { health: 6 }]) assert.equal(planPearlResponse(prediction, { ...state, ...change }), null)
})
test('height pearl dive is optional and requires a visible clear exit and safe recovery', () => {
  const option = { impact: { x: 0, y: 10, z: 0 }, teleport: { x: 1, y: 8, z: 0 }, enemy: { x: 2, y: 0, z: 0 },
    visible: true, loaded: true, bodyClear: true, exitClear: true, safeRecovery: true, health: 20, pearlDamage: 5, hasPearl: true, hasWeapon: true, interrupted: false }
  assert.equal(pearlHeightWorth(option), true)
  for (const change of [{ bodyClear: false }, { exitClear: false }, { safeRecovery: false }, { visible: false }, { health: 12 }, { interrupted: true }]) assert.equal(pearlHeightWorth({ ...option, ...change }), false)
})

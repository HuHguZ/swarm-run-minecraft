import test from 'node:test'
import assert from 'node:assert/strict'
const { Vec3 } = require('vec3')
const clock = require('../src/game-clock')
const threats = require('../src/threats')

// Local Paper 1.21.11 AbstractHurtingProjectile.tick/applyInertia/getInertia:
// before moving, velocity = (velocity + normalize(velocity) * .1) * .95.
const inertia = Math.fround(.95)
function nativeFlight(x: number, velocity: number, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    velocity = (velocity - .1) * inertia
    x += velocity
  }
  return { x, velocity }
}

for (const name of ['fireball', 'small_fireball', 'dragon_fireball']) test(`${name} is forecast early enough to raise a native shield against its accelerating flight`, () => {
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot = { entity: { position: new Vec3(0, 64, 0) }, entities: {} as any,
    blockAt: p => ({ name: 'air', position: p, boundingBox: 'empty', shapes: [] }) }
  // Two genuine position receipts, one native tick apart, measure -.5 block/tick.
  bot.entities[2] = { id: 2, name, position: new Vec3(6.5, 64.9, 0),
    _ndPositionReceipts: [{ x: 7, y: 64.9, z: 0, t: 950 }, { x: 6.5, y: 64.9, z: 0, t: 1000 }], _ndObservationNow: () => 1000 }
  try {
    bot.entities[2].position.x = 7; threats.incoming(bot)
    timer.advanceTicks(1); bot.entities[2].position.x = 6.5
    const trajectory = Array.from({ length: 10 }, (_, i) => nativeFlight(6.5, -.5, i + 1).x)
    const closestTick = trajectory.reduce((best, x, i) => Math.abs(x) < Math.abs(trajectory[best]) ? i : best, 0) + 1
    assert.ok(closestTick >= 5 && Math.abs(trajectory[closestTick - 1]) < .9, 'native trajectory reaches the body inside the existing ten-tick alarm')
    const incoming = threats.incoming(bot).filter((projectile: any) => projectile.ticks <= 10)
    assert.equal(incoming.length, 1, 'the existing alarm must use fireball acceleration, not decaying arrow flight')
    assert.equal(incoming[0].ticks, closestTick)
    assert.ok(Math.abs(incoming[0].at.x - trajectory[closestTick - 1]) < 1e-8, 'prediction follows the local native equation')
  } finally { timer.dispose(); clock.activate(null) }
})

test('accelerating fireball prediction still rejects a trajectory passing beside the body', () => {
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot = { entity: { position: new Vec3(0, 64, 0) },
    blockAt: p => ({ name: 'air', position: p, boundingBox: 'empty', shapes: [] }), entities: {
    2: { id: 2, name: 'fireball', position: new Vec3(6.5, 64.9, 3),
      _ndPositionReceipts: [{ x: 7, y: 64.9, z: 3, t: 950 }, { x: 6.5, y: 64.9, z: 3, t: 1000 }], _ndObservationNow: () => 1000 }
  } }
  try {
    bot.entities[2].position.x = 7; threats.incoming(bot)
    timer.advanceTicks(1); bot.entities[2].position.x = 6.5
    assert.equal(threats.incoming(bot).length, 0)
  }
  finally { timer.dispose(); clock.activate(null) }
})

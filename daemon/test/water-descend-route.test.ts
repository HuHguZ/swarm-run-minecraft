import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'

const { findSwimRoute } = require('../src/movement')
const { shoreRoute } = require('../src/survival/hold-out')

// A swim bob puts the feet above the fluid. The bank is reachable through the
// water one cell below, while the unsupported air cannot be walked across.
function pond(barrier: string | null = 'water') {
  return {
    oxygenLevel: 20,
    entity: { position: new Vec3(.5, 2.2, .5) },
    blockAt(at: Vec3) {
      const p = at.floored()
      let name: string | null = 'stone'
      if (p.z === 0 && p.x >= 0 && p.x <= 3 && p.y >= 1 && p.y <= 4) name = p.y === 1 && p.x < 3 ? 'water' : 'air'
      if (p.x === 1 && p.z === 0 && p.y >= 1) name = barrier
      return name === null ? null : { name, boundingBox: /water|air|lava/.test(name) ? 'empty' : 'block', position: p }
    }
  }
}

test('swim route survives the airborne bob above the connected water', () => {
  const route = findSwimRoute(pond())
  assert.equal(route.kind, 'land')
  assert.deepEqual(route.target, new Vec3(3, 1, 0))
  assert.ok(route.path.some((p: Vec3) => p.y < 2))
})

test('shore route can rejoin the lower water rather than abandoning its bank', () => {
  const route = shoreRoute(pond())
  assert.ok(route)
  assert.deepEqual(route.target, new Vec3(3, 1, 0))
  assert.ok(route.path.some((p: Vec3) => p.y < 2))
})

for (const barrier of ['stone', 'lava', null]) test(`descending water route still rejects ${barrier ?? 'unknown'}`, () => {
  assert.notEqual(findSwimRoute(pond(barrier))?.kind, 'land')
  assert.equal(shoreRoute(pond(barrier)), null)
})

test('shore descent remains inside the existing drop budget', () => {
  assert.equal(shoreRoute(pond(), { drop: 0 }), null)
})

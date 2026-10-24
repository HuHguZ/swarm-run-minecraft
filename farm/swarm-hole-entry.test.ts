import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTeam } from './swarm/swarm-driver/team'

test('a fully opened two-layer hole remains an edge from the remaining lower floor', () => {
  const holes = [{ x: 2, y: 119, z: 0, feetY: 120, bottomY: 118, drop: Infinity }]
  const { edgeNear } = swarmTeam({ holes, edgeOf: () => null } as any)
  const edge = edgeNear({ x: .5, y: 119, z: .5 })
  assert.ok(edge); assert.equal(edge.drop, Infinity); assert.equal(edge.at, 2)
  assert.equal(edgeNear({ x: .5, y: 117, z: .5 }), null, 'do not use an opening above the victim')
  assert.equal(edgeNear({ x: .5, y: 122, z: .5 }), null, 'an unrelated upper floor is unchanged')
})

test('a one-layer opening does not claim a lower layer was removed', () => {
  const { edgeNear } = swarmTeam({ holes: [{ x: 2, y: 119, z: 0, feetY: 120, bottomY: 119, drop: Infinity }], edgeOf: () => null } as any)
  assert.equal(edgeNear({ x: .5, y: 118, z: .5 }), null)
})

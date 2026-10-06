'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { shouldJump } = require('../src/sprintjump')

// Floor y=0 along x 0..8, z -1..1 (stone); feet at y=1. `extra` overrides cells "x,y,z".
function bot (extra: Record<string, string> = {}) {
  const at = (p: any) => {
    const q = p.floored(); const key = `${q.x},${q.y},${q.z}`
    const name = extra[key] ?? (q.y === 0 && q.x >= -1 && q.x <= 9 && Math.abs(q.z) <= 1 ? 'stone' : 'air')
    return { name, position: q, boundingBox: /air|lava|fire|water/.test(name) ? 'empty' : 'block' }
  }
  const controls: Record<string, boolean> = { forward: true, sprint: true, sneak: false }
  return { entity: { position: new Vec3(.5, 1, .5), onGround: true }, food: 20, blockAt: at, getControlState: (k: string) => !!controls[k], pathfinder: { isMining: () => false, isBuilding: () => false } } as any
}
const path = Array.from({ length: 6 }, (_, i) => ({ x: i + 1.5, y: 1, z: .5 }))

test('sprint jump only on a straight segment whose sides hold the body (no lava, no drop beside it)', () => {
  assert.equal(shouldJump(bot(), path), true, 'open floor')
  assert.equal(shouldJump(bot({ '3,1,1': 'stone', '3,2,1': 'stone' }), path), true, 'a wall beside stops a lateral drift')
  assert.equal(shouldJump(bot({ '3,0,1': 'lava' }), path), false, 'lava beside a landing cell')
  assert.equal(shouldJump(bot({ '4,0,-1': 'air' }), path), false, 'a hole beside the line')
  assert.equal(shouldJump(bot({ '2,1,-1': 'fire' }), path), false, 'fire beside the line')
  const owned = bot(); owned._ndParkourForecast = { from: owned.entity.position, until: Infinity, hp: 20 }
  assert.equal(shouldJump(owned, path), false, 'a verified parkour trajectory keeps its own keys')
  assert.equal(shouldJump(bot(), path.slice(0, 4)), false, 'too short a straight run')
})

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
  const step = [...path.slice(0, 5), { x: 6.5, y: 2, z: .5 }]
  assert.equal(shouldJump(bot(), step), false, 'a step right after the straight: no jump into it (s6c-sj-trace6)')
})

function rig (nodes: any[], extra: Record<string, string> = {}) {
  const { EventEmitter } = require('node:events')
  const { install } = require('../src/sprintjump')
  const b: any = Object.assign(new EventEmitter(), bot(extra))
  b.setControlState = () => {}
  install(b)
  b.emit('path_update', { status: 'success', path: nodes })
  return b
}
const node = (x: number, y: number, z: number) => ({ x, y, z, toBreak: [], toPlace: [] })

test('nodes a sprint jump flies over are taken off the executor path, so it does not turn back to them (s6b-sprint6-trace)', () => {
  const nodes = Array.from({ length: 8 }, (_, i) => node(i + 1.5, 1, .5))
  const b = rig(nodes)
  b.emit('physicsTick') // on the ground at x .5: the jump starts, the straight run is ours
  assert.equal(b._ndSprintJump.jumps, 1)
  b.entity.onGround = false
  b.entity.position = new Vec3(2.9, 2.1, .55) // mid-air, past nodes 1.5 and 2.5, never within 0.35 of them
  b.emit('physicsTick')
  assert.deepEqual(nodes.map(n => n.x).slice(0, 2), [3.5, 4.5], 'the very array the executor reads lost the passed nodes')
  b.entity.position = new Vec3(3.4, 2.1, 2.2) // off the line: nothing is skipped
  b.emit('physicsTick')
  assert.equal(nodes[0].x, 3.5)
})

test('without our own jump no node is taken off the executor path (stairs, plain running)', () => {
  // Stairs up from x 1.5: nothing validated, the body over a node is the executor's business (its 0.35/1 rule).
  const stairs = [node(1.5, 2, .5), node(2.5, 3, .5), node(3.5, 4, .5), node(4.5, 5, .5), node(5.5, 6, .5), node(6.5, 7, .5)]
  const b = rig(stairs)
  b.entity.position = new Vec3(1.7, 1.9, .5)
  b.emit('physicsTick')
  assert.equal(b._ndSprintJump.jumps, 0)
  assert.equal(stairs.length, 6, 'a stair node in reach of the old 0.5/1.5 window stays')
})

test('a sprint jump never takes off the corner node before a turn (no corner cutting)', () => {
  // Straight +x 1.5..5.5, then a turn to +z at x 5.5.
  const nodes = [1.5, 2.5, 3.5, 4.5, 5.5].map(x => node(x, 1, .5)).concat([node(5.5, 1, 1.5), node(5.5, 1, 2.5)])
  const b = rig(nodes, { '5,0,2': 'stone', '5,0,3': 'stone' })
  b.emit('physicsTick')
  assert.equal(b._ndSprintJump.jumps, 1)
  b.entity.onGround = false
  b.entity.position = new Vec3(5.9, 1.4, .5) // overshot the corner along +x, 0.4 past it (the old rule took it off)
  b.emit('physicsTick')
  assert.equal(nodes[0].x, 5.5, 'the corner node is still the executor target')
  assert.equal(nodes[0].z, .5)
})

test('the take-off node of a pathfinder parkour jump stays (its next node is not a neighbour cell)', () => {
  // Straight 1.5..5.5, then a 3-block gap: landing at 8.5 (pathfinder parkour move).
  const nodes = [1.5, 2.5, 3.5, 4.5, 5.5].map(x => node(x, 1, .5)).concat([node(8.5, 1, .5), node(9.5, 1, .5)])
  const b = rig(nodes)
  b.emit('physicsTick')
  b.entity.onGround = false
  b.entity.position = new Vec3(5.6, 1.6, .5)
  b.emit('physicsTick')
  assert.equal(nodes[0].x, 5.5, 'take-off node kept: canSprintJump decides the gap jump from it, not from 4.5')
  assert.equal(b._ndSprintJump.skipped, 4)
})

test('a path update mid-air (new node objects) still lets the jump take off the nodes it flew over (s6c-sj-trace1)', () => {
  const b = rig(Array.from({ length: 8 }, (_, i) => node(i + 1.5, 1, .5)))
  b.emit('physicsTick')
  const fresh = Array.from({ length: 8 }, (_, i) => node(i + 1.5, 1, .5))
  b.emit('path_update', { status: 'partial', path: fresh })
  b.entity.onGround = false
  b.entity.position = new Vec3(2.7, 2.2, .5)
  b.emit('physicsTick')
  assert.equal(fresh[0].x, 3.5)
})

test('goto {sprintJump:false} turns sprint jumping off for that bot only (A/B in one session)', () => {
  const nodes = Array.from({ length: 8 }, (_, i) => node(i + 1.5, 1, .5))
  const b = rig(nodes)
  b._ndSprintJumpWanted = false
  b.emit('physicsTick')
  assert.equal(b._ndSprintJump.jumps, 0)
  b._ndSprintJumpWanted = undefined
  b.emit('physicsTick')
  assert.equal(b._ndSprintJump.jumps, 1)
})

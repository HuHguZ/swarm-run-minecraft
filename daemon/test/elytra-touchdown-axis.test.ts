import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { worldOf } from '../src/elytra/physics'
import { cost } from '../src/elytra/control'

function world(x: number, z: number) {
  return worldOf(Object.assign(new EventEmitter(), { blockAt(p) {
    const solid = Math.floor(p.y) < 120 || Math.floor(p.y) === 120 && Math.floor(p.x) === x && Math.floor(p.z) === z
    return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: [] }
  } }))
}

for (const swap of [false, true]) test(`touchdown prices the remaining ${swap ? 'X' : 'Z'}-first corner collision (GS native wall hit)`, () => {
  // Recorded first floor contact; the old sampled diagonal slipped between the corner and the next sample.
  const p = { x: 612.9602984115193, y: 119.99747804293357, z: 628.3079690554239 }
  const v = { x: .44011745138272923, y: -.10360006982381449, z: .6773345875937492 }
  if (swap) { [p.x, p.z] = [p.z, p.x]; [v.x, v.z] = [v.z, v.x] }
  const r = { kind: 'floor', t: 1, p, v, fd: 1.990630868297984, remainingMove: { x: v.x, z: v.z } }
  const goal = { kind: 'land', at: p }, W = swap ? world(629, 612) : world(612, 629)
  assert(cost(W, { p, v }, goal, () => p, r, 0, 0) >= 400)
})

test('touchdown does not test the shorter axis at the old position after the longer axis clears a corner', () => {
  const p = { x: .5, y: 120, z: .5 }, v = { x: 2.4, y: -.1, z: 1.7 }
  const r = { kind: 'floor', t: 1, p, v, fd: 0, remainingMove: { x: v.x, z: v.z } }
  const at = { x: p.x + v.x, y: p.y, z: p.z + v.z }
  assert.equal(cost(world(0, 2), { p, v }, { kind: 'land', at }, () => at, r, 0, 0), .3)
})

for (const axis of ['x', 'z']) test(`landing prefers the actual touchdown over a nearer pre-${axis} contact that overshoots`, () => {
  const at = { x: .5, y: 120, z: .5 }, W = world(999, 999), goal = { kind: 'land', at }
  const candidate = (offset: number, speed: number) => {
    const p = { ...at, [axis]: at[axis] + offset }, v = { x: 0, y: -.1, z: 0, [axis]: speed }
    const remainingMove = { x: v.x, z: v.z }
    return cost(W, { p, v }, goal, () => at, { kind: 'floor', t: 1, p, v, fd: 0, remainingMove }, 0, 0)
  }
  // Equal speed, fall and time: the first contact is closer, but its remaining move carries it past the pad.
  assert(candidate(1, -1.2) < candidate(.4, 1.2))
})

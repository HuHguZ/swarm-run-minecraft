// Огонь тушится ударом: у ног и по пути к цели, только видимый прицелом (пользователь 16.10).
import test from 'node:test'
import assert from 'node:assert/strict'
const { Vec3 } = require('vec3')
const { fireToPunch } = require('../src/fire-punch')

function field(fires: number[][], walls: number[][] = [], goal: any = null) {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  const fire = new Set(fires.map(([x, y, z]) => key(x, y, z))), wall = new Set(walls.map(([x, y, z]) => key(x, y, z)))
  return {
    health: 20, pathfinder: { goal },
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.8 },
    blockAt(p: any) {
      const q = p.floored(), k = key(q.x, q.y, q.z), solid = q.y === 63 || wall.has(k)
      return { name: fire.has(k) ? 'fire' : solid ? 'stone' : 'air', position: q, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
    }
  }
}

test('fire at the feet and on the way to the goal is punched; fire behind or behind a wall is not', () => {
  assert.ok(fireToPunch(field([[1, 64, 0]])), 'next to the feet')
  assert.ok(fireToPunch(field([[3, 64, 0]], [], { x: 10, y: 64, z: 0 })), 'on the way to the goal')
  assert.equal(fireToPunch(field([[-3, 64, 0]], [], { x: 10, y: 64, z: 0 })), null, 'behind the body: leave it')
  assert.equal(fireToPunch(field([[3, 64, 0]], [[2, 64, 0], [2, 65, 0]], { x: 10, y: 64, z: 0 })), null, 'behind a wall: the crosshair does not reach it')
  const b = field([[1, 64, 0]]) as any; b.targetDigBlock = {}
  assert.equal(fireToPunch(b), null, 'already digging something')
})

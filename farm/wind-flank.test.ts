import test from 'node:test'
import assert from 'node:assert/strict'
import { flankSpots } from './swarm/swarm-driver/wind'

test('wind flank: shooters under or outside an airborne foe move to the centre side at a shallow angle', () => {
  const arena = { x: 0, z: 0, r: 30 }
  const foe = { x: 10, y: 6, z: 0 } // 6 бл. над полом, к востоку от центра
  const f = flankSpots(foe, arena, 0, [{ x: 10, y: 0, z: 1 }])
  assert.ok(f.bad({ x: 10.5, y: 0, z: 0.5 }), 'прямо под ним — плохой угол')
  assert.ok(f.bad({ x: 16, y: 0, z: 0 }), 'снаружи — толкнёт внутрь')
  assert.ok(!f.bad({ x: 0, y: 0, z: 0 }), 'со стороны центра, далеко — годится')
  assert.ok(!f.bad({ x: 6, y: 6, z: 0 }), 'already level with the foe on the inside side')
  for (const s of f.spots) { assert.ok(s.x < foe.x - 8, 'на сторону центра, дальше 1.5 высоты'); assert.ok(!f.bad(s)) }
  // У края места снаружи нет — точки остаются внутри арены.
  const g = flankSpots({ x: 27, y: 1, z: 27 }, arena, 0, [])
  for (const s of g.spots) assert.ok(Math.max(Math.abs(s.x), Math.abs(s.z)) <= 28)
})

test('the central ground flank and wing use the same outward axis', () => {
  const arena = { x: 600.5, z: 600.5, r: 77, ellipse: { a: 77, b: 65 } }
  const target = { x: 600.6, y: 126, z: 600.7 }
  const f = flankSpots(target, arena, 120, [{ x: 613, y: 120, z: 602 }])
  assert.deepEqual(f.out, { x: 0, z: 1 })
  assert.ok(f.spots.every(p => p.z < target.z))
})

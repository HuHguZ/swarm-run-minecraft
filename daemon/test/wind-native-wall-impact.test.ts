import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { windBlockImpact, windShot } from '../src/combat/team-wind'

// DG B #928 synchronized native launch and the first wall entered in tick nine.
const from = new Vec3(558.9458159885332, 132.43375491551302, 594.4672459577016)
const motion = new Vec3(-.6917391331917286, -.9263889660603422, .6641941581920661)
const nativeHit = new Vec3(553.4112111838662, 125.02171679806426, 599.7814634173967)
const wall = new Vec3(553, 124, 599)
const blocking = new Vec3(556, 128, 598)
function fixture({ wallPresent = false, earlier = '' } = {}) {
  return {
    blockAt(p: Vec3) {
      const cell = p.floored()
      if (cell.equals(blocking) && earlier === 'unknown') return null
      const wallHere = wallPresent && cell.equals(wall)
      const solid = cell.y === 123 || cell.equals(blocking) && earlier === 'stone'
      return { position: cell, name: wallHere ? 'diorite_wall' : solid ? 'smooth_quartz' : 'air',
        boundingBox: solid || wallHere ? 'block' : 'empty',
        shapes: wallHere ? [[.3125, 0, 0, .6875, 1.5, 1]] : solid ? [[0, 0, 0, 1, 1, 1]] : [] }
    }
  }
}

test('the native wall overhang is first struck in the tick that enters its voxel', () => {
  const world = fixture({ wallPresent: true }), speed = motion.norm(), direction = motion.scaled(1 / speed)
  const origin = from.plus(motion.scaled(8))
  assert.equal(windBlockImpact(world, from.plus(motion.scaled(7)), direction, speed), null)
  const hit = windBlockImpact(world, origin, direction, speed)
  assert.ok(hit)
  assert.ok(hit.impact.distanceTo(nativeHit) < 1e-9)
  assert.ok(hit.burst.distanceTo(nativeHit.offset(0, .25, 0)) < 1e-9)
  assert.deepEqual(hit.normal, new Vec3(0, 1, 0))
  // Reflect.apply also allows running this portable test against the frozen four-argument baseline.
  const sweep = Reflect.apply(windBlockImpact, null, [world, from, direction, 12 * speed, speed]) as typeof hit
  assert.ok(sweep.impact.distanceTo(nativeHit) < 1e-9)
  assert.deepEqual(sweep.pos, wall)
  assert.equal(Math.ceil(sweep.distance / speed), 9)
})

const recordedFloors = [
  // DG A #807 relift.
  [new Vec3(554.7845152427763, 132.49856352443243, 596.482979142338), new Vec3(-.4868296716646683, -1.5395221302043245, .6724847515026198),
    new Vec3(552.0970885348073, 124, 600.1952702927732)],
  // DG B #929 harmless floor impact.
  [new Vec3(558.760963148112, 130.58868500529314, 598.5474663738476), new Vec3(-.6127091660337833, -.5298168892207522, .09638245788933436),
    new Vec3(551.1414482232665, 124, 599.7460571851051)]
]
test('normal observed floors keep their native face, burst and earlier blockers', () => {
  for (const [start, velocity, impact] of recordedFloors) {
    const speed = velocity.norm(), direction = velocity.scaled(1 / speed)
    const result = Reflect.apply(windBlockImpact, null, [fixture(), start, direction, 20 * speed, speed]) as ReturnType<typeof windBlockImpact>
    assert.ok(result)
    assert.ok(result.impact.distanceTo(impact) < 1e-9)
    assert.ok(result.burst.distanceTo(impact.offset(0, .25, 0)) < 1e-9)
  }
  const [start, , aim] = recordedFloors[1]
  assert.ok(windShot(fixture(), start, aim))
  assert.equal(windShot(fixture({ earlier: 'stone' }), start, aim), null)
  assert.equal(windShot(fixture({ earlier: 'unknown' }), start, aim), null)
})

function xRay({ wallX = 2, unknownX = -1 } = {}) {
  const read: number[] = []
  const world = {
    blockAt(p: Vec3) {
      const cell = p.floored(), solid = cell.x === wallX
      read.push(cell.x)
      if (cell.x === unknownX) return null
      return { position: cell, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty',
        shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
    }
  }
  const ray = (fromX: number, distance: number, step: number) => Reflect.apply(windBlockImpact, null,
    [world, new Vec3(fromX, .5, .5), new Vec3(1, 0, 0), distance, step]) as ReturnType<typeof windBlockImpact>
  return { ray, read, world }
}

test('the clipped last step cannot credit a native inside sample beyond the requested horizon', () => {
  const { ray, read } = xRay({ wallX: 1 })
  assert.equal(ray(.9999, .0002, 1.5), null)
  assert.ok(Math.max(...read) <= 1)
  const available = ray(.9999, .01, 1.5)
  assert.ok(available)
  assert.ok(Math.abs(available.impact.x - 1.0014) < 1e-12)
})

test('a face at the full tick end waits, while a clipped in-step face is included', () => {
  const { ray } = xRay()
  assert.equal(ray(1, 1, 1), null)
  const next = ray(1, 1.01, 1)
  assert.ok(next && Math.abs(next.impact.x - 2.001) < 1e-12)
  assert.equal(ray(.25, 1.74, 1.5), null)
  assert.equal(ray(.25, 1.75, 1.5)?.impact.x, 2)
})

test('a pending surface stops reading at the first unknown step and still consumes the first known obstruction', () => {
  const unknown = xRay({ wallX: 90, unknownX: 3 })
  assert.equal(unknown.ray(.25, 90, 1.5), null)
  assert.ok(Math.max(...unknown.read) <= 4)
  const blocked = xRay({ wallX: 2, unknownX: 3 })
  assert.equal(blocked.ray(.25, 90, 1.5)?.impact.x, 2)
  assert.ok(Math.max(...blocked.read) <= 2)
})

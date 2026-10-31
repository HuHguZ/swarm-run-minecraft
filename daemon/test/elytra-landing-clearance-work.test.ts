import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { rollout } from '../src/elytra/physics'
import { yawTo, wrap } from '../src/elytra/consts'

for (const hazard of ['plain', 'wall', 'lava']) test(`landing fallback skips unused deep clearance scans, preserving the full quote (${hazard})`, () => {
  const file = require.resolve('../src/elytra/control'), load = createRequire(file), control: any = {}
  runInNewContext(readFileSync(file, 'utf8'), { exports: control, require: name => name === './landing'
    ? { landingPlan: () => null } : load(name) }, { filename: file })
  let deep = 0
  const world = () => ({
    boxHit: (x, y) => y < 120 || hazard === 'wall' && x > 5 && y < 124,
    floorBelow: (_x, y, _z, depth = 40) => {
      if (depth === 12) deep++
      return y >= 120 && y - depth <= 120 ? { top: 120, lava: hazard === 'lava' } : null
    }
  })
  const st = { p: { x: .5, y: 124.5, z: .5 }, v: { x: .5, y: -.15, z: .2 }, boost: 0, fd: .3 }
  const goal = { kind: 'land', at: { x: 5.5, y: 120, z: 2.5 } }
  const selected = control.choose(world(), st, goal), selectedDeep = deep
  // Reference: every candidate keeps the old full-depth clearance scan.
  const bearing = yawTo(st.p, goal.at), heading = Math.atan2(-st.v.x, -st.v.z), yaws = new Set<number>()
  for (const offset of control.YAW_OFF) { yaws.add(wrap(bearing + offset)); if (Math.abs(offset) <= .9) yaws.add(wrap(heading + offset)) }
  let expected: any = null
  const W = world()
  for (const yaw of yaws) for (const pitch of control.PITCHES) {
    const r = rollout(W, st.p, st.v, yaw, pitch, 0, 18, { fd: st.fd, movementFall: true })
    const c = control.cost(W, st, goal, () => goal.at, r, yaw, pitch)
    if (!expected || c < expected.c) expected = { yaw, pitch, c, r }
  }
  assert.equal(selected.yaw, expected.yaw)
  assert.equal(selected.pitch, expected.pitch)
  assert.equal(selected.c, expected.c)
  assert.deepEqual(JSON.parse(JSON.stringify(selected.r)), JSON.parse(JSON.stringify(expected.r)),
    'collision, movement fall, support price and the reported full-depth floor gap must remain identical')
  assert(selectedDeep <= 4, `only the selected 18-tick forecast needs deep clearance: ${selectedDeep}`)
})

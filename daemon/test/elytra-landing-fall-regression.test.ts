import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { choose } from '../src/elytra/control'
import { rollout } from '../src/elytra/physics'
import { wall } from '../src/game-clock'

// RED research test: a conservative movement estimate, not exact server fallDistance.
for (const delayed of [false, true]) test('landing from 22 blocks clears accumulated downward movement before touchdown' + (delayed ? ' despite an exhausted compute window' : ''), t => {
  let elapsed = 0
  if (delayed) t.mock.method(wall, 'monotonic', () => (elapsed += 50))
  const floor = 120
  const solid = (x, y, z) => y < floor || Math.abs(x - 600) > 30 || Math.abs(z - 600) > 30
  const W: any = {
    boxHit(x, y, z, h = 1.8) {
      for (let X = Math.floor(x - .3); X <= Math.floor(x + .3 - 1e-9); X++)
        for (let Y = Math.floor(y); Y <= Math.floor(y + h - 1e-9); Y++)
          for (let Z = Math.floor(z - .3); Z <= Math.floor(z + .3 - 1e-9); Z++) if (solid(X, Y, Z)) return true
      return false
    },
    floorBelow(x, y, z, depth = 40) {
      for (let Y = Math.floor(y); Y >= Math.floor(y) - depth; Y--)
        if (solid(Math.floor(x), Y, Math.floor(z))) return { top: Y + 1 }
      return null
    }
  }
  let p = new Vec3(600, floor + 22, 600), v = new Vec3(1.2, 0, 0), fd = 1, event = null
  for (let t = 0; t < 400 && !event; t++) {
    const pl = choose(W, { p, v, boost: 0, fd }, { kind: 'land', at: new Vec3(605.5, floor, 605.5), edge: () => false })
    const oldY = p.y
    const r = rollout(W, p, v, pl.yaw, pl.pitch, 0, 1, { fd })
    p = new Vec3(r.p.x, r.p.y, r.p.z); v = new Vec3(r.v.x, r.v.y, r.v.z)
    // Deliberately independent of rollout's client-velocity-based fd reset.
    fd = p.y > oldY ? 0 : fd + Math.max(0, oldY - p.y)
    event = r.kind
  }
  assert.equal(event, 'floor')
  assert(fd <= 3, 'movement fall estimate at touchdown: ' + fd)
})

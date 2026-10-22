// Связка против сильного (22.10): взлёт с булавой из прыжка за критом и топор по поднятому щиту — сразу, без заряда меча.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { landingSoon } from '../src/mace/world'
import { axeTapNow } from '../src/pvp/turn-melee'

function body(y: number, vy: number, onGround = false) {
  return {
    entity: { position: new Vec3(0.5, y, 0.5), velocity: new Vec3(0, vy, 0), onGround, height: 1.8, width: 0.6 },
    blockAt(p: any) {
      const q = p.floored(), solid = q.y === 63
      return { name: solid ? 'stone' : 'air', position: q, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
    }
  }
}

test('a mace launch counts the last ticks of a crit jump as ground, not the rise or a high fall', () => {
  assert.ok(landingSoon(body(64, 0, true)), 'standing')
  assert.ok(landingSoon(body(64.8, -0.1)), 'coming down, 0.8 above the floor')
  assert.ok(landingSoon(body(65, 0)), 'at the top of a jump')
  assert.ok(!landingSoon(body(64.8, 0.3)), 'still rising')
  assert.ok(!landingSoon(body(66.5, -0.2)), 'falling from 2.5: not soon')
})

test('an axe hits a raised shield at once, not after the sword charges: fresh, from behind or already broken — no', () => {
  const base = { axe: { name: 'diamond_axe' }, blocking: true, shieldFresh: false, facingMe: true, r: 2.8, inSight: true, shieldOffMs: 0 }
  assert.ok(axeTapNow(base), 'his shield faces me, I have an axe: hit now')
  assert.ok(!axeTapNow({ ...base, shieldFresh: true }), 'first 4 ticks the shield does not block — the sword goes through')
  assert.ok(!axeTapNow({ ...base, facingMe: false }), 'from behind the hit is not blocked, nothing to disable')
  assert.ok(!axeTapNow({ ...base, shieldOffMs: 4000 }), 'already broken')
  assert.ok(!axeTapNow({ ...base, axe: null }), 'no axe')
  assert.ok(!axeTapNow({ ...base, r: 3.6 }), 'out of reach')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { landingPlan } from '../src/elytra/landing'
import { rollout, worldOf } from '../src/elytra/physics'
import { cost } from '../src/elytra/control'

function fixture () {
  let blocked = false
  let calls = 0
  const solid = (x, y, z) => blocked || y < 120 || Math.abs(x - 600) > 30 || Math.abs(z - 600) > 30
  const W: any = {
    boxHit(x, y, z, h = 1.8) {
      calls++
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
  return { W, block: () => { blocked = true }, calls: () => calls }
}
const initial = () => ({ p: new Vec3(600, 142, 600), v: new Vec3(1.2, 0, 0), fd: 1, boost: 0 })
const goal = () => ({ at: new Vec3(605.5, 120, 605.5) })
const priceFor = W => r => {
  const f = W.floorBelow(r.p.x, r.p.y + .5, r.p.z, 3)
  return { c: 0, safe: !!f && !f.lava && !f.water && !W.boxHit(r.p.x, f.top, r.p.z) }
}
function step (W, st, plan) {
  const r = rollout(W, st.p, st.v, plan.yaw, plan.pitch, st.boost, 1, { fd: st.fd })
  return { ...r, boost: Math.max(0, st.boost - 1), fd: r.p.y > st.p.y && !r.kind ? 0 : st.fd + Math.max(0, st.p.y - r.p.y) }
}

test('multi-phase landing preserves speed through the turn and confirms a real climb before touchdown', () => {
  const { W } = fixture()
  const price = priceFor(W)
  let st: any = initial()
  let ascents = 0
  let pitchChanges = 0
  let lastPitch = null
  let first = null
  for (let t = 0; t < 240 && !st.kind; t++) {
    const plan = landingPlan(W, st, goal(), price)
    assert(plan, 'a complete safe manoeuvre remains available')
    if (!first) first = plan
    if (lastPitch !== null && plan.pitch !== lastPitch) pitchChanges++
    lastPitch = plan.pitch
    const next = step(W, st, plan)
    if (!next.kind && next.p.y > st.p.y) ascents++
    st = next
  }
  assert(Math.abs(first.yaw + Math.PI / 2) < 1e-8, 'the initial look follows the current momentum')
  assert.equal(st.kind, 'floor')
  assert(ascents > 0, 'accepted upward movement clears the movement fall estimate')
  assert(pitchChanges > 0, 'descent and flare use different commands')
  assert(st.fd <= 3)
})

test('remembered landing rechecks changed geometry and rejects unknown solid cells', () => {
  const f = fixture(), st = initial(), g = goal()
  const price = priceFor(f.W)
  const first = landingPlan(f.W, st, g, price)
  assert(first)
  const next = step(f.W, st, first)
  f.block()
  assert.equal(landingPlan(f.W, next, g, price), null)
})

test('knockback discards the old manoeuvre and replans from the actual velocity', () => {
  const a = fixture(), b = fixture(), st = initial(), g = goal()
  const price = priceFor(a.W)
  const first = landingPlan(a.W, st, g, price)
  assert(first)
  const actual = { ...step(a.W, st, first), v: new Vec3(-1.2, 0, 0) }
  const replanned = landingPlan(a.W, actual, g, price)
  const fresh = landingPlan(b.W, actual, g, priceFor(b.W))
  assert(replanned && fresh)
  assert.equal(replanned.yaw, fresh.yaw)
  assert.equal(replanned.pitch, fresh.pitch)
  assert(Math.abs(replanned.yaw - first.yaw) > 2)
})

test('arena kill height is checked again before using a remembered landing', () => {
  const { W } = fixture(), st = initial()
  const price = priceFor(W)
  const g: any = { ...goal(), arena: { x: 600, z: 600, r: 30, killY: 110 } }
  const first = landingPlan(W, st, g, price)
  assert(first)
  const actual = step(W, st, first)
  g.arena.killY = 150
  assert.equal(landingPlan(W, actual, g, price), null)
})

test('extreme altitude is bounded and cannot cache an unfinished flight as a landing', () => {
  let calls = 0
  const W = { boxHit: () => { calls++; return false }, floorBelow: () => null }
  const st = { ...initial(), p: new Vec3(600, 1e6, 600) }
  assert.equal(landingPlan(W, st, goal(), priceFor(W)), null)
  assert(calls < 65536, 'world queries stay bounded independently of altitude')
})

test('landing endpoint and skid reject hazardous or newly unknown surface cells', () => {
  let kind = 'stone'
  const bot: any = { on() {}, blockAt(p) {
    if (p.y >= 120) return { name: 'air', boundingBox: 'empty' }
    return kind === 'unknown' ? null : { name: kind, boundingBox: 'block' }
  } }
  const W = worldOf(bot)
  const p = new Vec3(600.5, 120, 600.5)
  const g = { kind: 'land', at: p }
  const r: any = { kind: 'floor', t: 1, p, v: { x: 0, y: -.1, z: 0 }, fd: 1 }
  assert.equal(W.landingSafe(p), true)
  assert(cost(W, {}, g, () => p, r, 0, 0) < 1)
  for (const hazard of ['magma_block', 'campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'unknown']) {
    kind = hazard
    assert.equal(W.landingSafe(p), false, hazard)
    assert(cost(W, {}, g, () => p, r, 0, 0) >= 5000, hazard + ' reaches the landing cost')
  }
  kind = 'stone'
  assert.equal(W.landingSafe(p), true, 'the safety check reads fresh geometry after an update')
})

test('landing skid cannot certify climbing a full block by lifting its collision probe', () => {
  const p = new Vec3(0, 120, 0)
  const g = { kind: 'land', at: p }
  const r: any = { kind: 'floor', t: 1, p, v: { x: 1, y: -.1, z: 0 }, fd: 1 }
  let raised = false
  const W: any = {
    floorBelow: x => ({ top: raised && x >= 1 ? 121 : 120 }),
    boxHit: (x, y) => raised && x >= 1 && y < 121
  }
  const price = () => cost(W, {}, g, () => p, r, 0, 0)
  assert(price() < 1, 'a continuous level surface remains accepted')
  raised = true
  assert(price() >= 5000, 'friction on a level surface cannot certify a full-block rise')
})

test('runout checks the actual lower support height, hazards, and lost continuous support', () => {
  const g: any = { kind: 'land', at: new Vec3(-.4, 100, .5), arena: { x: 0, z: 0, r: 10, killY: 98 } }
  const r: any = { kind: 'floor', t: 1, p: g.at, v: { x: .8, y: -.1, z: 0 }, fd: 1 }
  let lower = false
  let hazard = false
  const checked = []
  const W: any = {
    boxHit: () => false,
    floorBelow: x => ({ top: lower && x > 0 ? 97 : 100 }),
    landingSafe: p => { checked.push(p.y); return !hazard || p.y !== 97 }
  }
  const price = () => cost(W, {}, g, () => g.at, r, 0, 0)
  assert(price() < 1, 'continuous safe support remains accepted')
  lower = true
  assert(price() >= 5000, 'lower support crosses the kill plane')
  g.arena.killY = 90
  hazard = true
  assert(price() >= 5000)
  assert(checked.includes(97), 'the hazard predicate sees the actual lower surface')
  hazard = false
  assert(price() >= 5000, 'a horizontal friction tail cannot certify a drop into the air')
})

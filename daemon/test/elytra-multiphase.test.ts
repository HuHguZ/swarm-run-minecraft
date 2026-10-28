import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { landingPlan } from '../src/elytra/landing'
import { rollout, worldOf } from '../src/elytra/physics'
import { choose, cost } from '../src/elytra/control'

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

test('bounded landing search gives reflected trajectories the same safe touchdown price', () => {
  // Gone-rocket state translated onto an explicitly known flat stone plane, not native arena geometry.
  const flat = () => ({
    boxHit: (x, y, z) => y < 0,
    floorBelow(x, y, z, depth = 40) {
      const start = Math.floor(y), Y = Math.min(-1, start)
      return Y >= start - depth ? { top: Y + 1 } : null
    },
    landingSafe: () => true,
    groundInertia: () => .6 * .91,
    airborneInertia: .91
  })
  const plans = [1, -1].map(sign => {
    const st = { p: new Vec3(0, 7.99904611479846, 0), v: new Vec3(sign * 1.1215206993805078, -.05434218764864825, -.931249670246468), fd: .0651348951951718, boost: 0 }
    const g = { kind: 'land', at: new Vec3(sign * 22.52242528871688, 0, -3.5429565232895), maxFallDamage: 0,
      arena: { x: sign * -8.47757471128312, y: 0, z: -3.5429565232895, r: 80, killY: -7, ellipse: { a: 77, b: 65 } } }
    const plan = choose(flat(), st, g)
    assert(plan && plan.work > 0, 'shared choose finds a complete landing manoeuvre')
    assert.equal(plan.r.kind, 'floor')
    assert(plan.r.fd <= 3, 'both directions retain the zero-damage fall limit')
    assert(plan.work <= 32769, 'the existing search budget is unchanged')
    return { plan, distance: Math.hypot(plan.r.p.x - g.at.x, plan.r.p.z - g.at.z) }
  })
  assert(Math.abs(plans[0].distance - plans[1].distance) < 1e-8, 'a budget cutoff must not favor one turn direction')
  assert(Math.abs(plans[0].plan.c - plans[1].plan.c) < 1e-8, 'reflected safe landings have the same actual shared price')
  assert(plans[0].distance < 3, 'the already available close touchdown survives the budget cutoff')
})

function warmRocketLanding (ticks) {
  const { W } = fixture()
  // Observed light31 input translated into the existing known flat fixture, not native arena geometry.
  const g = { kind: 'land', at: new Vec3(601.5, 120, 600.5) }
  let st: any = {
    p: new Vec3(577.6413188673238, 127.95891707293028, 604.5722533812385),
    v: new Vec3(1.4977452701814322, -.011523174863615102, .11243596754594322),
    fd: .011523174863611985, boost: 24
  }
  for (let t = 0; t < ticks; t++) {
    const plan = choose(W, st, g)
    assert(plan && plan.r.kind === 'floor' && plan.r.fd <= 3, 'warm a complete safe route through real shared choose')
    st = step(W, st, plan)
    assert(!st.kind, 'forecast changes before touchdown')
  }
  return { W, st, g }
}

for (const [name, ticks, boost] of [['expires', 15, 0], ['refreshes', 1, 40]] as const) {
  test(`shared landing choose replans when a rocket ${name} on the expected path`, () => {
    const { W, st, g } = warmRocketLanding(ticks)
    const actual = { ...st, boost }
    const replanned = choose(W, actual, g)
    const fresh = choose(fixture().W, actual, g)
    assert(replanned && fresh && fresh.r.kind === 'floor' && fresh.r.fd <= 3)
    assert(Math.abs(replanned.c - fresh.c) < 1e-8, 'a changed thrust forecast must compare the newly available cheaper landing')
    assert.equal(replanned.yaw, fresh.yaw)
    assert.equal(replanned.pitch, fresh.pitch)
    assert.deepEqual(replanned.r.p, fresh.r.p)
  })
}

test('unchanged remaining rocket thrust keeps the complete cached landing route', () => {
  const { W, st, g } = warmRocketLanding(15)
  assert.equal(st.boost, 9)
  const cached = choose(W, st, g)
  const fresh = choose(fixture().W, st, g)
  assert(cached && fresh && cached.r.kind === 'floor' && cached.r.fd <= 3)
  assert(cached.work < fresh.work, 'ordinary one-tick countdown still reuses the verified route')
})

test('landing certification also obeys the early-expiry price verdict on the same commands', () => {
  const { W } = fixture()
  const st = { p: new Vec3(600, 121, 600), v: new Vec3(1, -.1, 0), fd: .1, boost: 17, boostMin: 0 }
  // A price callback may reject either touchdown (for example its support or runout).
  // The early branch has no remaining rocket at contact; no two-branch route is acceptable here.
  const plan = landingPlan(W, st, goal(), r => ({ c: 5, safe: r.boost > 0 }))
  assert.equal(plan, null, 'a nominally accepted floor cannot hide the early-expiry rejection')
})

test('landing price pays the worse touchdown without a second search budget', () => {
  const { W } = fixture()
  const st = { p: new Vec3(600, 121, 600), v: new Vec3(1, -.1, 0), fd: .1, boost: 17, boostMin: 0 }
  const plan = landingPlan(W, st, goal(), r => ({ c: r.boost > 0 ? 5 : 100, safe: true }))
  assert(plan, 'a route with both complete safe touchdowns is still available')
  assert.equal(plan.c, 100, 'the existing price of the early touchdown reaches the chosen plan')
  assert(plan.work <= 32769, 'both route checks share the existing work budget')
})

test('an unchanged zero early-expiry bound reuses the complete cached route', () => {
  const { W } = fixture()
  const st = { p: new Vec3(600, 121, 600), v: new Vec3(1, -.1, 0), fd: .1, boost: 17, boostMin: 0 }
  const price = r => ({ c: r.boost > 0 ? 5 : 100, safe: true })
  const first = landingPlan(W, st, goal(), price)
  assert(first)
  const next = { ...step(W, st, first), boostMin: 0 }
  const cached = landingPlan(W, next, goal(), price)
  const fresh = landingPlan(fixture().W, next, goal(), price)
  assert(cached && fresh)
  assert.equal(cached.c, 100)
  assert(cached.work < fresh.work, 'ordinary age rounding must not discard the verified path every callback')
})

test('a local choose fallback is not a certified complete early-expiry landing', () => {
  const W = { boxHit: () => false, floorBelow: () => null }
  const st = { ...initial(), p: new Vec3(600, 1e6, 600), boost: 17, boostMin: 0 }
  const plan = choose(W, st, { kind: 'land', ...goal() })
  assert(plan && plan.work === undefined && plan.r.kind === null,
    'no complete safe route exists here: the unchanged local horizon is a fallback, not a two-branch landing certificate')
})

test('a changed forecast cannot reuse a safe cached route at a newly worse price', () => {
  const flat = () => ({ boxHit: (x, y, z) => y < 120, floorBelow: () => ({ top: 120 }) })
  const W = flat(), g = goal()
  const st = { p: new Vec3(600, 121, 600), v: new Vec3(1, -.1, 0), fd: .1, boost: 17, boostMin: 0, boostUntil: 10000 }
  let premium = 0
  const price = () => ({ c: premium, safe: true })
  const first = landingPlan(W, st, g, price)
  assert(first)
  const actual = { ...step(W, st, first), boost: 8, boostMin: 0, boostUntil: st.boostUntil }
  premium = 100
  const replanned = landingPlan(W, actual, g, price), fresh = landingPlan(flat(), actual, g, price)
  assert(replanned && fresh)
  assert.equal(replanned.c, 100)
  assert(replanned.work >= fresh.work, 'after a forecast change a worse cached price competes with newly available routes')
})

test('ordinary countdown tolerates tiny body and price drift without restarting the full landing search', () => {
  const flat = () => ({ boxHit: (x, y, z) => y < 120, floorBelow: () => ({ top: 120 }) })
  const W = flat(), g = goal()
  const st = { p: new Vec3(600, 121, 600), v: new Vec3(1, -.1, 0), fd: .1, boost: 17, boostMin: 0, boostUntil: 10000 }
  let drift = 0
  const price = () => ({ c: drift, safe: true })
  const first = landingPlan(W, st, g, price)
  assert(first)
  const actual = { ...step(W, st, first), boostMin: 0, boostUntil: st.boostUntil }
  actual.p.x += .0001; actual.v.x += .00001; drift = .0001
  const cached = landingPlan(W, actual, g, price), fresh = landingPlan(flat(), actual, g, price)
  assert(cached && fresh)
  assert.equal(cached.c, .0001)
  assert(cached.work < fresh.work, 'the new quality guard applies to changed thrust, not ordinary submillimetre drift')
})

test('a landing safe after mean expiry rejects the same commands when a late rocket drives into a wall', () => {
  const W = { boxHit: (x, y, z) => y < 0 || x + .30000001192092896 > 2, floorBelow: () => ({ top: 0 }) }
  const st = { p: new Vec3(.5, .2, .5), v: new Vec3(1, -.3, 0), fd: 0, boost: 0, boostMin: 0, boostMax: 5 }
  const quiet = rollout(W, st.p, st.v, -Math.PI / 2, 0, 0, 1)
  const live = rollout(W, st.p, st.v, -Math.PI / 2, 0, 5, 1)
  assert.equal(quiet.kind, 'floor')
  assert.equal(live.kind, 'wall')
  assert(live.dmg > 10, 'real glide physics makes the zero/mean-safe command dangerous under surviving thrust')
  const price = r => ({ c: Math.abs(r.v.y + .28224), safe: true })
  const plan = landingPlan(W, st, { at: new Vec3(1.5, 0, .5) }, price)
  assert(plan, 'another complete route may pay a higher touchdown price')
  assert.notEqual(rollout(W, st.p, st.v, plan.yaw, plan.pitch, 5, 1).kind, 'wall')
  assert(plan.work <= 32769, 'the late branch shares the original search budget')
})

test('a changed maximum thrust bound cannot skip cached route price competition when the mean is zero', () => {
  const flat = () => ({ boxHit: (x, y, z) => y < 120, floorBelow: () => ({ top: 120 }) })
  const W = flat(), g = goal()
  const st = { p: new Vec3(600, 121, 600), v: new Vec3(1, -.1, 0), fd: .1, boost: 0, boostMin: 0, boostMax: 5, boostUntil: 10000 }
  let premium = 0
  const price = () => ({ c: premium, safe: true })
  const first = landingPlan(W, st, g, price)
  assert(first)
  const actual = { ...step(W, st, first), boostMin: 0, boostMax: 5, boostUntil: st.boostUntil }
  premium = 100
  const replanned = landingPlan(W, actual, g, price), fresh = landingPlan(flat(), actual, g, price)
  assert(replanned && fresh)
  assert(replanned.work >= fresh.work, 'max-bound rounding also rechecks a newly worse cached price')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { choose } from '../src/elytra/control'
import { rollout } from '../src/elytra/physics'
import { landingPlan } from '../src/elytra/landing'
import { EventEmitter } from 'node:events'
import { worldOf } from '../src/elytra/physics'

const floor = 100
const world = () => ({
  boxHit: (_x, y, _z) => y < floor,
  floorBelow: (_x, y, _z, depth = 40) => y >= floor && y - depth <= floor ? { top: floor } : null
})

for (const [height, speed, x, z] of [[.5, .6, 6, 0], [1, 1.2, 6, 6], [2, .6, 3, 6]]) {
  test(`a complete nearby landing can beat the manoeuvre along current velocity (${height}/${speed})`, () => {
    const W = world()
    const st = { p: { x: .5, y: floor + height, z: .5 }, v: { x: speed, y: -.1, z: 0 }, boost: 0, fd: 0 }
    const goal = { kind: 'land', at: { x: .5 + x, y: floor, z: .5 + z } }
    const choice = choose(W, st, goal)
    const touch = rollout(W, st.p, st.v, choice.yaw, choice.pitch, 0, 18, { movementFall: true })
    assert.equal(touch.kind, 'floor')
    assert(touch.fd <= 3, 'the complete approach must clear the independent movement fall estimate')
    assert(Math.hypot(touch.p.x - goal.at.x, touch.p.z - goal.at.z) <= 3, 'safe touchdown must reach the requested pad')

    let state = st, event: string | null = null
    for (let tick = 0; tick < 80 && !event; tick++) {
      const next = choose(W, state, goal)
      const step = rollout(W, state.p, state.v, next.yaw, next.pitch, 0, 1, { fd: state.fd, movementFall: true })
      state = { p: step.p, v: step.v, boost: 0, fd: step.fd }
      event = step.kind
    }
    assert.equal(event, 'floor')
    assert(state.fd <= 3)
    assert(Math.hypot(state.p.x - goal.at.x, state.p.z - goal.at.z) <= 3, 'replanning must retain the arrival')
  })
}

test('a shorter complete landing also reaches the pad with the last uncertain tick of rocket thrust', () => {
  const W = world()
  const st = { p: { x: .5, y: floor + .5, z: .5 }, v: { x: 1.2, y: -.1, z: 0 }, boost: 0, boostMin: 0, boostMax: 1, fd: 0 }
  const goal = { kind: 'land', at: { x: 6.5, y: floor, z: 3.5 } }
  const choice = choose(W, st, goal)
  for (const boost of [st.boostMin, st.boostMax]) {
    const touch = rollout(W, st.p, st.v, choice.yaw, choice.pitch, boost, 18, { movementFall: true })
    assert.equal(touch.kind, 'floor')
    assert(touch.fd <= 3)
    assert(Math.hypot(touch.p.x - goal.at.x, touch.p.z - goal.at.z) <= 3)
  }
})

test('following the chosen short landing reuses its complete route instead of searching a different manoeuvre', () => {
  const measured = () => {
    const W = world(), boxHit = W.boxHit
    let calls = 0
    W.boxHit = (...args: Parameters<typeof boxHit>) => { calls++; return boxHit(...args) }
    return { W, calls: () => calls }
  }
  const cachedWorld = measured(), freshWorld = measured()
  const st = { p: { x: .5, y: floor + 1, z: .5 }, v: { x: 1.2, y: -.1, z: 0 }, boost: 0, fd: 0 }
  const goal = { kind: 'land', at: { x: 6.5, y: floor, z: 6.5 } }
  const first = choose(cachedWorld.W, st, goal)
  const step = rollout(cachedWorld.W, st.p, st.v, first.yaw, first.pitch, 0, 1, { movementFall: true })
  const actual = { p: step.p, v: step.v, fd: step.fd, boost: 0 }
  const before = cachedWorld.calls()
  const cached = choose(cachedWorld.W, actual, goal)
  const cachedCalls = cachedWorld.calls() - before
  const fresh = choose(freshWorld.W, actual, goal)
  assert.equal(cached.r.kind, 'floor')
  assert.equal(fresh.r.kind, 'floor')
  assert(cached.r.fd <= 3 && fresh.r.fd <= 3)
  assert(cachedCalls < freshWorld.calls(), `cache ${cachedCalls}, fresh ${freshWorld.calls()}`)
})

test('the cached short route includes a later touchdown under the rocket upper bound', () => {
  const W = world(), looks = { yaws: [-Math.PI / 2], pitches: [0] }
  const st = { p: { x: .5, y: floor + .5, z: .5 }, v: { x: .2, y: -.1, z: 0 }, fd: 0, boost: 0, boostMin: 0, boostMax: 1 }
  const goal = { at: { x: 3.3, y: floor, z: .5 } }
  const price = r => ({ c: Math.hypot(r.p.x - goal.at.x, r.p.z - goal.at.z), safe: true })
  const first = landingPlan(W, st, goal, price, 18, looks)
  assert(first)
  assert.equal(first.pitch, 0)
  const later = rollout(W, st.p, st.v, first.yaw, first.pitch, 1, 18, { movementFall: true })
  assert.equal(later.kind, 'floor')
  assert(later.fd <= 3 && later.t + 1 > first.r.t)
  const step = rollout(W, st.p, st.v, first.yaw, first.pitch, 0, 1, { movementFall: true })
  const next = { p: step.p, v: step.v, fd: step.fd, boost: 0, boostMin: 0, boostMax: 0 }
  const cached = landingPlan(W, next, goal, price, 18, looks)
  const fresh = landingPlan(world(), next, goal, price, 18, looks)
  assert(cached && fresh && cached.work < fresh.work)
})

test('a short safe approach is compared before a long descent exhausts the search budget', () => {
  const data = require('minecraft-data')('1.21.11'), Block = require('prismarine-block')(data)
  const grid = require('../arena/build-colosseum').plan({ X: 600, Y: 120, Z: 600, R: 24, ceilH: 16 }).m.g
  const blocks = new Map(), bot: any = new EventEmitter()
  bot.blockAt = p => {
    const x = p.x - 600, y = p.y - 120, z = p.z - 600
    const token = x < grid.x0 || x > grid.x1 || y < grid.y0 || y > grid.y1 || z < grid.z0 || z > grid.z1
      ? 'air' : grid.pal[grid.data[grid.i(x, y, z)]] || 'air'
    if (!blocks.has(token)) {
      const [name, tail] = token.split('[')
      const props = tail ? Object.fromEntries(tail.slice(0, -1).split(',').map(s => s.split('='))) : {}
      blocks.set(token, Block.fromProperties(data.blocksByName[name].id, props, 0))
    }
    return { ...blocks.get(token), position: p }
  }
  // Recorded JG touchdown approach; the requested pad is behind a higher roof.
  const W = worldOf(bot), goal = { kind: 'land', at: { x: 551.5, y: 150.5, z: 640.5 } }
  const st = { p: { x: 550.0604937874825, y: 155.65596420274528, z: 639.1466114008662 },
    v: { x: 1.0201480137786123, y: .14117262986526755, z: .7567629247154923 }, fd: 0, boost: 0, boostMin: 0, boostMax: 0 }
  const choice = choose(W, st, goal)
  assert.equal(choice.r.kind, 'floor')
  assert(choice.r.fd <= 3, 'the complete approach must still avoid fall damage')
  const error = Math.hypot(choice.r.p.x + (choice.r.remainingMove?.x || 0) - goal.at.x,
    choice.r.p.y - goal.at.y, choice.r.p.z + (choice.r.remainingMove?.z || 0) - goal.at.z)
  assert(error < 7, `a reachable nearer safe touchdown must beat the 14-block overshoot: ${error}`)
  assert(choice.work <= 32769, 'the same bounded search must include the short approach')
})

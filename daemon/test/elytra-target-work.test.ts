import test from 'node:test'
import assert from 'node:assert/strict'
import { choose } from '../src/elytra/control'
import { predictGlider } from '../src/elytra/track'

test('moving-point steering forecasts each future tick once and refreshes on the next choice', () => {
  const W = { boxHit: () => false, floorBelow: () => null }
  const st = { p: { x: .5, y: 107, z: .5 }, v: { x: 1.1, y: -.1, z: 0 }, boost: 8, fd: 1 }
  const e = { position: { x: 15, y: 107, z: .5 }, elytraFlying: true, yaw: 1.2, pitch: -.15 }
  const velocity = { x: .5, y: -.1, z: .1 }
  const calls = new Map<number, number>()
  const at = (tick: number) => {
    calls.set(tick, (calls.get(tick) || 0) + 1)
    return predictGlider(e, velocity, tick).offset(0, -.1, 0)
  }
  const goal = { kind: 'point', at, reach: true, gap: 2, speedMin: .8 }
  const first = choose(W, st, goal)
  assert(first)
  assert.equal(first.yaw, -Math.PI / 2)
  assert.equal(first.pitch, -.1)
  assert(Math.abs(first.c - 1.8774996980904737) < 1e-12, 'the moving-target course and price stay unchanged')
  assert.equal(calls.size, 19)
  assert([...calls.values()].every(n => n === 1), 'all candidates share the same forecast for that tick')

  calls.clear()
  e.position = { x: -8, y: 109, z: 4 }
  e.yaw = -.8
  const next = choose(W, st, goal)
  assert([...calls.values()].every(n => n === 1))
  assert(next && (next.yaw !== first.yaw || next.pitch !== first.pitch), 'a new receipt changes the next steering choice')
})

test('a failed moving-target forecast is not retained by a later choice', () => {
  const W = { boxHit: () => false, floorBelow: () => null }
  const st = { p: { x: 0, y: 100, z: 0 }, v: { x: 0, y: 0, z: -.4 }, boost: 0 }
  const failure = Error('missing observation')
  let failed = true
  const goal = { kind: 'point', at: () => { if (failed) throw failure; return { x: 0, y: 101, z: -8 } } }
  assert.throws(() => choose(W, st, goal), e => e === failure)
  failed = false
  assert(choose(W, st, goal))
})

test('a target callback may reuse its position object without overwriting other forecast ticks', () => {
  const W = { boxHit: () => false, floorBelow: () => null }
  const st = { p: { x: 0, y: 100, z: 0 }, v: { x: .3, y: -.1, z: -.4 }, boost: 8 }
  const position = { x: 0, y: 0, z: 0 }
  const at = (t: number) => ({ x: 3 + .4 * t, y: 102 - .1 * t, z: -8 + .2 * t })
  const goal = { kind: 'point', reach: true, gap: 2 }
  assert.deepEqual(choose(W, st, { ...goal, at: t => Object.assign(position, at(t)) }), choose(W, st, { ...goal, at }))
})

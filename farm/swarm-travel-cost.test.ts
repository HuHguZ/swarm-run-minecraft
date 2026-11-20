import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmMoves } from './swarm/swarm-driver/moves'

function fixture () {
  const b = { name: 'A' }, target = { x: 11.2, y: 88, z: 0, climbFrom: 64 }
  const route = { key: 'upper', base: { x: 5.6, y: 64, z: 0 }, top: { x: 5.6, y: 88, z: 0 } }
  const sw: any = { pos: { A: { p: { x: 0, y: 64, z: 0 }, inv: {}, armor: {} } },
    arena: { x: 0, y: 64, z: 0, r: 100 }, ladderRoutes: [], blocked: () => false, lootSafe: () => true }
  const moves = swarmMoves(sw)
  return { b, target, route, sw, price: (from?) => moves.travelCost(b, target, from) }
}

test('a confirmed ladder makes upper travel available without a pick or building blocks', () => {
  const f = fixture()
  assert.equal(f.price().walk, Infinity, 'an unopened climb still needs its own supplies')
  f.sw.ladderRoutes.push(f.route)
  const seconds = f.price().walk
  assert.ok(seconds > 12 && seconds < 13, 'two one-second approaches plus a 24-block native ladder climb')
  f.sw.blocked = () => true
  assert.equal(f.price().walk, Infinity, 'a route that failed for this bot is unavailable')
  f.sw.blocked = () => false
  f.route.top.y = 80
  assert.equal(f.price().walk, Infinity, 'a partial ladder does not supply the remaining eight levels')
  f.sw.pos.A.inv = { cobblestone: 11 }
  assert.ok(Number.isFinite(f.price().walk), 'the same partial route works with supplies for its unfinished top')
})

test('the same travel price evaluates a return from an observed lower position', () => {
  const f = fixture(), lower = { ...f.sw.pos.A.p }
  f.sw.pos.A.p = { x: 0, y: 88, z: 0 }
  assert.equal(f.price().walk, 2)
  assert.equal(f.price(lower).walk, Infinity, 'the current upper position cannot hide the cost of coming back up')
  f.sw.ladderRoutes.push(f.route)
  assert.ok(f.price(lower).walk > 12 && f.price(lower).walk < 13)
  assert.equal(f.price().walk, 2, 'quoting a return leaves the observed body position unchanged')
})

test('a body already inside the ladder column pays only for the remaining rise', () => {
  const f = fixture(), mid = { x: 5.6, y: 84, z: 0 }
  f.sw.ladderRoutes.push(f.route)
  f.sw.pos.A.p = mid
  assert.ok(f.price().walk > 2.6 && f.price().walk < 2.8, 'four remaining ladder blocks and the final one-second approach')
  f.sw.pos.A.p = { x: 0, y: 88, z: 0 }
  assert.ok(f.price(mid).walk > 2.6 && f.price(mid).walk < 2.8, 'an explicit observed entry uses the same continuation price')
  assert.equal(f.price({ x: 3.6, y: 84, z: 0 }).walk, Infinity, 'a body away from the column cannot enter twenty blocks above its base')
  assert.ok(f.price({ x: 0, y: 64, z: 0 }).walk > 12 && f.price({ x: 0, y: 64, z: 0 }).walk < 13,
    'the full approach and climb from the bottom are unchanged')
})

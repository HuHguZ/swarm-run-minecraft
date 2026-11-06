import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import pick = require('../src/pick')
import { pendingWindHit } from '../src/combat/enemy-wind'
import { windImpulse } from '../src/combat/team-wind'
const clock: typeof import('../src/game-clock') = require('../src/game-clock')
const threats: typeof import('../src/threats') = require('../src/threats')

// CG walk f's returned frames and fair projectile motion before e#1610 hit the tier floor.
const spawn = new Vec3(659.0674422368129, 148.84847902335997, 610.346293860742)
const position = new Vec3(659.5072680286851, 148.6441248097896, 610.2959815752497)
const velocity = new Vec3(1.4193741479218906, -.6594772137533382, -.16236418752670684)
const observedAt = 1793886140550.2336, born = 1793886140257.8613, motionAt = 1793886140273.355
const burst = new Vec3(669.50268645599, 144.25, 609.1525917267628)
const kick = new Vec3(-.06491885016032511, .5969222854087789, -.08013887877962317)
const frames = [
  [669.2054492698567, 145.466796875, 608.9328730683951],
  [669.2258630724768, 145.51076318269318, 608.8814328014225],
  [669.2250006824638, 145.47545016354522, 608.8321147280298],
  [669.2055617320665, 145.3624434025808, 608.7847278507944],
  [669.1684333368077, 145.17329677315433, 608.7390983620625],
  [669.1152075467247, 144.90953307118284, 608.6950680968686],
  [669.047333127352, 144.572644636694, 608.6524931250943]
].map(([x, y, z]) => ({ pos: new Vec3(x, y, z), vel: new Vec3(0, 0, 0), onGround: false }))

function fixture(t: TestContext, phase = observedAt) {
  const owner = { id: 189, username: 'e', position: spawn, width: .6, height: .6 }
  const own = { id: 199, username: 'f', position: new Vec3(660.495, 147.637, 604.993), width: .6, height: .6 }
  const foe = { id: 630, username: 'red', position: frames[0].pos, width: .6, height: 1.8 }
  const charge = { id: 1610, name: 'wind_charge', position: spawn }
  const entities: Record<number, any> = { 189: owner, 199: own, 630: foe, 1610: charge }
  const ndClock = { age: 15782045n, ticks: 0, serverTicks: 0 }
  let extraSolid = (_p: Vec3) => false, hidden = (_p: Vec3) => false, reads = 0
  const world: any = { blockAt(p: Vec3) {
    reads++
    const cell = p.floored(), { x, y, z } = cell
    if (hidden(cell)) return null
    const solid = extraSolid(cell) || y === 143 && x >= 668 && x <= 670 && z >= 607 && z <= 610
    return { name: solid ? 'cut_sandstone' : 'air', boundingBox: solid ? 'block' : 'empty', position: cell,
      shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  } }
  const bot = { ...world, entity: own, entities, ndClock }
  t.mock.method(clock, 'observationNow', () => phase)
  t.mock.method(threats, 'thrownTracker', () => new Map([[1610, { name: 'wind_charge', owner: owner.id, p: spawn, observedAt: born }]]))
  t.mock.method(threats, 'projectileView', () => ({ position: spawn, _ndPositionReceipts: [null, { t: motionAt }],
    _ndWindMotion: { position, velocity, t: motionAt }, _ndObservationNow: () => phase }))
  t.mock.method(pick, 'canHit', () => true)
  return { bot, foe, world, entities, reads: () => reads, solid: (f: typeof extraSolid) => { extraSolid = f },
    hide: (f: typeof hidden) => { hidden = f }, predict: (f = frames, scheduled = []) => pendingWindHit(bot, foe, f, scheduled, world) }
}

test('pending wind preserves the exposed CG floor gust before the next relay fires', t => {
  const f = fixture(t), result = f.predict()
  assert.equal(result?.id, 1610)
  assert.equal(result?.ticks, 2)
  assert.ok(result.burst.distanceTo(burst) < 1e-9)
  assert.ok(windImpulse(f.world, frames[3].pos, result.burst, { resistance: 0 }).distanceTo(kick) < .001)
  const fireTick = Number(f.bot.ndClock.age) - Math.round((observedAt - born) / 50)
  assert.equal(f.predict(frames, [{ thrower: 'e', from: spawn, velocity, fireTick } as any]), null)
})

test('a distant visible charge needs no terrain queries for a pending gust', t => {
  const f = fixture(t)
  assert.equal(f.predict(frames.map(frame => ({ ...frame, pos: frame.pos.offset(0, 0, 8) }))), null)
  assert.equal(f.reads(), 0)
})

test('a close block explosion needs known exposed target geometry', t => {
  const f = fixture(t), near = frames.map(frame => ({ ...frame, pos: new Vec3(669.2, 144.25, 607.69) }))
  assert.equal(f.predict(near)?.id, 1610)
  const screen = ({ x, y, z }: Vec3) => z === 608 && x >= 668 && x <= 670 && y >= 144 && y <= 146
  f.hide(screen)
  assert.equal(f.predict(near), null, 'unknown cover cannot certify a pending blast')
  f.hide(() => false)
  f.solid(screen)
  assert.equal(f.predict(near), null, 'opaque cover prevents the blast')
})

test('an earlier terminal collision consumes the charge before the predicted floor gust', t => {
  const f = fixture(t, observedAt - 100)
  assert.equal(f.predict()?.id, 1610)
  f.solid(({ x, y, z }) => x === 665 && y === 146 && z === 609)
  assert.equal(f.predict(), null, 'an earlier distant block does not move the burst forward to the target')
  f.solid(() => false)
  f.entities[8000] = { id: 8000, username: 'ally', type: 'player', position: new Vec3(665.5, 145.2, 609.6), width: .6, height: 1.8 }
  assert.equal(f.predict(), null, 'an earlier visible body consumes the projectile before the floor')
})

test('a witnessed ray that crossed since the latest fair body receipt holds the next release', t => {
  const at = 1300, launch = new Vec3(0, 129, 600.5), moved = launch.offset(1.5, 0, 0), motion = new Vec3(1.5, 0, 0)
  const own = { id: 1, username: 'blue', position: new Vec3(4.5, 129, 596.5), width: .6, height: 1.8 }
  const feet = new Vec3(7.5, 128, 600.5)
  const receipt = (time: number, position = feet) => ({ ...position, t: time, kind: 'rel_entity_move', grounded: false, flying: false, revision: 1 })
  const history = [receipt(1050), receipt(1100)]
  const foe = { id: 630, username: 'red', position: feet, width: .6, height: 1.8, _ndVisible: true,
    _ndPositionReceipts: history, _ndObservationNow: () => at }
  const charge = { id: 1610, name: 'wind_charge', position: moved }
  let glass: number | null = null, visibleCharge = true
  const collision: any = { blockAt(p: Vec3) {
    const cell = p.floored(), stopsRay = glass !== null && cell.equals(new Vec3(glass, 129, 600))
    return { name: stopsRay ? 'glass' : 'air', boundingBox: stopsRay ? 'block' : 'empty', position: cell,
      shapes: stopsRay ? [[0, 0, 0, 1, 1, 1]] : [] }
  } }
  const bot = { ...collision, entity: own, entities: { 630: foe, 1610: charge }, players: { red: { entity: foe } },
    ndClock: { age: 506n, ticks: 0, serverTicks: 0 } }
  t.mock.method(clock, 'observationNow', () => at)
  t.mock.method(threats, 'thrownTracker', () => new Map([[1610, { name: 'wind_charge', owner: 2, p: launch, observedAt: 1000 }]]))
  t.mock.method(threats, 'projectileView', () => visibleCharge ? { position: moved, _ndPositionReceipts: [null, { t: 1050 }],
    _ndWindMotion: { position: moved, velocity: motion, t: 1050 }, _ndObservationNow: () => at } : null)
  t.mock.method(pick, 'canHit', () => true)
  const predict = () => pendingWindHit(bot, foe, Array.from({ length: 5 }, () => ({ pos: foe.position,
    vel: new Vec3(0, 0, 0), onGround: false })), [], collision)

  visibleCharge = false
  assert.equal(predict(), null, 'a projectile without a current visible witness cannot postpone a release')
  visibleCharge = true
  foe._ndVisible = false
  assert.equal(predict(), null, 'hidden body receipts cannot witness a crossing')
  foe._ndVisible = true
  foe._ndPositionReceipts = []
  assert.equal(predict(), null, 'a body without a fair receipt cannot witness a crossing')
  foe._ndPositionReceipts = [receipt(1225), receipt(1275)]
  assert.equal(predict(), null, 'a new visible body position after the crossing settles the pending hit')
  foe._ndPositionReceipts = history
  glass = 4
  assert.equal(predict(), null, 'glass can be seen through but consumes the ray before it reaches the body')
  glass = 2
  assert.equal(predict(), null, 'a block crossed before the newest body receipt still consumes the ray')
  glass = null
  const result = predict()
  assert.equal(result?.id, 1610)
  assert.equal(result.ticks, 1)

  glass = 0
  assert.equal(predict()?.id, 1610, 'a block behind the last witnessed projectile position cannot consume it')
  glass = null
  foe.position = feet.offset(-3.5, 0, 0)
  foe._ndPositionReceipts = [receipt(1060, foe.position), receipt(1110, foe.position)]
  assert.equal(predict()?.id, 1610, 'the ray can enter the body in the first partial tick after its receipt')
})

test('a native wind ray inside the Paper player width is not missed at the boundary', t => {
  const observed = 1000, id = 50, edge = (.6 + Math.fround(.6)) / 4
  const origin = new Vec3(0, 1, edge), velocity = new Vec3(1.5, 0, 0), position = new Vec3(1, 0, 0)
  const foe = { id: 2, username: 'Red', type: 'player', width: .6, height: 1.8, position }
  const entity = { id: 1, username: 'Blue', type: 'player', position: new Vec3(-3, 0, -2) }
  const charge = { id, name: 'wind_charge', position: origin }
  const collision: any = { blockAt: (p: Vec3) => ({ name: 'air', position: p.floored(), boundingBox: 'empty', shapes: [] }) }
  const bot = { ...collision, entity, entities: { [id]: charge }, ndClock: { age: 1n, ticks: 0, serverTicks: 0 } }
  t.mock.method(clock, 'observationNow', () => observed)
  t.mock.method(threats, 'thrownTracker', () => new Map([[id, { name: charge.name, owner: entity.id, p: origin, observedAt: observed }]]))
  t.mock.method(threats, 'projectileView', () => ({ position: origin, _ndPositionReceipts: [null, { t: observed }],
    _ndWindMotion: { position: origin, velocity, t: observed }, _ndObservationNow: () => observed }))
  const frame = { pos: position, vel: new Vec3(0, 0, 0), onGround: true }
  const predict = () => pendingWindHit(bot, foe, [frame, frame], [], collision)
  assert.equal(predict()?.id, id)
  origin.z = Math.fround(.6) / 2 + 1e-8
  assert.equal(predict(), null, 'a ray outside the native width is still a miss')
})

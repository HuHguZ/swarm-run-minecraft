import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { runInThisContext } from 'node:vm'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import * as enemy from '../src/combat/enemy-wind'

const file = resolve(__dirname, '../src/combat/enemy-wind.js'), real = createRequire(file), mod = { exports: {} as any }
runInThisContext('(function(require,module,exports,__filename,__dirname){' + readFileSync(file, 'utf8') + '\nmodule.exports.__liftTest={rollout,bounds,teamWorld,enemyView};\n})', { filename: file })(real, mod, mod.exports, file, dirname(file))
const { rollout, bounds, teamWorld, enemyView } = mod.exports.__liftTest
const compare = (a, b) => Number(a.exited) - Number(b.exited) || a.outwardEffect - b.outwardEffect || a.progress - b.progress

function fixture(wallHeight = 2, count = 2) {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const native = require('../src/tick-plugins').getPhysics(), half = Math.fround(.6) / 2, z = 601 - half
  const read = p => {
    const q = p.floored(), wall = q.z === 601 && q.y >= 120 && q.y < 120 + wallHeight
    const b = Block.fromStateId(registry.blocksByName[q.y < 120 || wall ? 'sand' : 'air'].defaultState)
    b.position = q; return b
  }
  const reports = Array.from({ length: count }, (_, i) => ({ id: i ? `Second${i}` : 'Caster',
    position: { x: 600.5 + i * 2, y: 120, z: z - 6 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }))
  const raw: any = { id: 99, username: 'Red', name: 'player', type: 'player', isValid: true, _ndVisible: true,
    position: new Vec3(600.5, 120, z), velocity: new Vec3(0, 0, 0), onGround: true, yaw: Math.PI, pitch: 0, height: 1.8, width: .6, metadata: [0],
    equipment: [null, null, ...['netherite_boots', 'netherite_leggings', 'netherite_chestplate', 'netherite_helmet'].map(name => ({ name, enchanted: true, _ndVisual: true }))] }
  for (const key of ['health', 'hp', 'attributes']) Object.defineProperty(raw, key, { get() { throw new Error(`private foreign ${key}`) } })
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, username: 'Caster', food: 20, health: 20, game: { minY: -64, height: 384 },
    inventory: { slots: [], items: () => [{ name: 'wind_charge', count: 64 }] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    ndClock: { age: 500n, ticks: 0, serverTicks: 0 }, blockAt: read, entities: { 99: raw }, players: { Red: { entity: raw, gamemode: 0 } },
    entity: { id: 1, username: 'Caster', position: new Vec3(600.5, 120, z - 6), velocity: new Vec3(0, 0, 0), onGround: true, yaw: Math.PI, pitch: 0, effects: {}, attributes: {} } })
  bot.physics = native.Physics(registry, { getBlock: read })
  const arena = { x: 600.5, z: 600.5, r: 80, ellipse: { a: 77, b: 65 }, killY: 113 }
  const options = { arena, startTick: 500, maxShots: 2, delays: [0, 2], reactAfterHit: true, juggle: false }
  return { bot, raw, reports, arena, options, plan(extra: any = {}) { return enemy.planEnemyWind(bot, raw, reports, { ...options, ...extra }) } }
}

test('an initial neutral native lift unlocks a positive two-thrower chain over a two-block wall', () => {
  const f = fixture(), tracks = new Map(), snapshot = teamWorld(f.bot, f.reports, tracks)
  const foe = { ...enemyView(f.bot, f.raw), reactAfterHit: true, keepObservedInput: true, outward: new Vec3(0, 0, 1) }
  const baseline = rollout(snapshot, foe, [], f.arena, 0)
  const first = enemy.enemyWindShot(snapshot, foe, f.reports[0], baseline.frames, { fireDelay: 0, height: .4 })!
  const prefix = bounds(snapshot, foe, [first], f.arena, 0, f.reports, tracks, new Map(), undefined, compare)
  assert.equal(compare(prefix, baseline), 0)
  assert.equal(prefix.air, baseline.air, 'the grounded air counter is not a causal lift witness')
  assert.ok(prefix.frames.some((frame, i) => !frame.onGround && frame.pos.y > baseline.frames[i].pos.y))
  const second = enemy.enemyWindShot(snapshot, foe, f.reports[1], prefix.frames, { fireDelay: 2, height: 1.6 })!
  const oracle = bounds(snapshot, foe, [first, second], f.arena, 0, f.reports, tracks, new Map(), undefined, compare)
  assert.ok(oracle && compare(oracle, baseline) > 0, 'the complete native chain passes every ordinary-KB branch and actual ally safety')
  const plan = f.plan()
  assert.ok(plan, 'a neutral first lift is provisional until the next ready thrower proves a useful complete chain')
  assert.equal(plan.shots.length, 2)
  assert.equal(new Set(plan.shots.map(s => s.thrower)).size, 2)
  assert.notEqual(plan.shots[0].arrivalTick, plan.shots[1].arrivalTick)
  for (let mask = 0; mask < 4; mask++) {
    const run = rollout(snapshot, foe, plan.shots, f.arena, 0, mask)
    assert.equal(run.impacts.length, 2)
    assert.ok(run.outwardEffect > 0 && run.progress > baseline.progress, `ordinary-KB mask ${mask}`)
  }
})

function twoNeutralLifts(f: ReturnType<typeof fixture>) {
  const tracks = new Map(), snapshot = teamWorld(f.bot, f.reports, tracks)
  const foe = { ...enemyView(f.bot, f.raw), reactAfterHit: true, keepObservedInput: true, outward: new Vec3(0, 0, 1) }
  const baseline = rollout(snapshot, foe, [], f.arena, 0)
  const first = enemy.enemyWindShot(snapshot, foe, f.reports[0], baseline.frames, { fireDelay: 0, height: .4 })!
  const p1 = bounds(snapshot, foe, [first], f.arena, 0, f.reports, tracks, new Map(), undefined, compare)
  const second = enemy.enemyWindShot(snapshot, foe, f.reports[1], p1.frames, { fireDelay: 2, height: .4 })!
  const p2 = bounds(snapshot, foe, [first, second], f.arena, 0, f.reports, tracks, new Map(), undefined, compare)
  return { tracks, snapshot, foe, baseline, first, second, p1, p2 }
}

test('two initial neutral native lifts unlock a strictly useful third throw over a four-block wall', () => {
  const f = fixture(4, 3), n = twoNeutralLifts(f)
  assert.equal(compare(n.p1, n.baseline), 0)
  assert.equal(compare(n.p2, n.p1), 0)
  for (const [current, previous] of [[n.p1, n.baseline], [n.p2, n.p1]]) {
    assert.ok(current.frames.some((frame, i) => !frame.onGround && frame.pos.y > previous.frames[i].pos.y))
  }
  const third = enemy.enemyWindShot(n.snapshot, n.foe, f.reports[2], n.p2.frames, { fireDelay: 2, height: 1.6 })!
  const oracle = bounds(n.snapshot, n.foe, [n.first, n.second, third], f.arena, 0, f.reports, n.tracks, new Map(), undefined, compare)
  assert.ok(oracle && compare(oracle, n.baseline) > 0, 'the full chain passes all eight ordinary-KB branches and actual ally safety')
  const plan = f.plan({ maxShots: 3 })
  assert.ok(plan, 'two initial neutral lifts may wait for the third ready thrower to prove strict final gain')
  assert.equal(plan.shots.length, 3)
  assert.equal(new Set(plan.shots.map(s => s.thrower)).size, 3)
  assert.equal(new Set(plan.shots.map(s => s.arrivalTick)).size, 3)
  for (let mask = 0; mask < 8; mask++) {
    const run = rollout(n.snapshot, n.foe, plan.shots, f.arena, 0, mask)
    assert.equal(run.impacts.length, 3)
    assert.ok(run.outwardEffect > 0 && run.progress > n.baseline.progress, `ordinary-KB mask ${mask}`)
  }
})

test('multiple neutral lifts require a final useful slot, not merely extra ready bodies', () => {
  assert.equal(fixture(4, 3).plan({ maxShots: 2 }), null)
  assert.equal(fixture(4, 2).plan({ maxShots: 3 }), null)
  assert.equal(fixture(8, 3).plan({ maxShots: 3 }), null, 'a bounded neutral group with no positive finish is never dispatched')
})

test('a third throw blocked by an actual reported ally cannot complete two neutral lifts', () => {
  const f = fixture(4, 3), n = twoNeutralLifts(f)
  const third = enemy.enemyWindShot(n.snapshot, n.foe, f.reports[2], n.p2.frames, { fireDelay: 2, height: 1.6 })!
  assert.ok(third)
  const centre = third.from.plus(third.velocity.scaled(1.5))
  const ally = { id: 'ThirdRayAlly', position: { x: centre.x, y: centre.y - .9, z: centre.z }, velocity: { x: 0, y: 0, z: 0 }, onGround: false, gameTick: 500 }
  const blocked = teamWorld(f.bot, [...f.reports, ally], new Map())
  assert.equal(enemy.enemyWindShot(blocked, n.foe, f.reports[2], n.p2.frames, { fireDelay: 2, height: 1.6 }), null)
  assert.equal(f.plan({ maxShots: 3, allies: [ally] }), null)
})

test('a neutral lift cannot be dispatched with one slot or only one ready thrower', () => {
  assert.equal(fixture().plan({ maxShots: 1 }), null)
  assert.equal(fixture(2, 1).plan({ maxShots: 3 }), null)
})

test('an inward lifting first shot cannot become a provisional neutral prefix', () => {
  const f = fixture(0)
  for (const report of f.reports) report.position.z = f.raw.position.z + 6
  f.bot.entity.position.z = f.reports[0].position.z
  assert.equal(f.plan(), null)
})

test('a neutral lift with no useful continuation stays null, including an unsafe second thrower', () => {
  assert.equal(fixture(4).plan(), null, 'lift alone does not justify a whole neutral group')
  const f = fixture(), ally = { id: 'Ally', position: { x: 602.5, y: 121.5, z: 595.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: false, gameTick: 500 }
  const tracks = new Map(), clear = teamWorld(f.bot, f.reports, tracks)
  const foe = { ...enemyView(f.bot, f.raw), reactAfterHit: true, keepObservedInput: true, outward: new Vec3(0, 0, 1) }
  const baseline = rollout(clear, foe, [], f.arena, 0)
  const first = enemy.enemyWindShot(clear, foe, f.reports[0], baseline.frames, { fireDelay: 0, height: .4 })!
  const prefix = bounds(clear, foe, [first], f.arena, 0, f.reports, tracks, new Map(), undefined, compare)
  assert.ok(enemy.enemyWindShot(clear, foe, f.reports[1], prefix.frames, { fireDelay: 2, height: 1.6 }))
  const blocked = teamWorld(f.bot, [...f.reports, ally], new Map())
  assert.equal(enemy.enemyWindShot(blocked, foe, f.reports[1], prefix.frames, { fireDelay: 2, height: 1.6 }), null,
    'the falling reported body really intersects the second ray')
  assert.equal(f.plan({ allies: [ally] }), null, 'the second projectile must still pass actual reported ally geometry')
})

test('an interrupted neutral-prefix search returns no partial group', t => {
  const f = fixture(), native = f.bot.physics.simulatePlayer.bind(f.bot.physics)
  let steps = 0, now = 0
  t.mock.method(clock.wall, 'monotonic', () => now)
  f.bot._ndSimOrig = (state, world) => { if (++steps === 200) now = 2; return native(state, world) }
  assert.equal(f.plan({ deadline: 1 }), null)
  assert.equal(now, 2, 'the deadline really interrupts native work')
})

test('after the first useful shot every retained addition remains a strict improvement', () => {
  const f = fixture(0, 3), plan = f.plan({ maxShots: 3 })!
  assert.ok(plan)
  const tracks = new Map(), snapshot = teamWorld(f.bot, f.reports, tracks)
  const foe = { ...enemyView(f.bot, f.raw), reactAfterHit: true, keepObservedInput: true, outward: new Vec3(0, 0, 1) }
  let previous = rollout(snapshot, foe, [], f.arena, 0)
  for (let i = 1; i <= plan.shots.length; i++) {
    const current = bounds(snapshot, foe, plan.shots.slice(0, i), f.arena, 0, f.reports, tracks, new Map(), undefined, compare)
    assert.ok(compare(current, previous) > 0, 'an ordinary positive plan cannot acquire a trailing neutral lift')
    previous = current
  }
})

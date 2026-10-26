import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()

function fixture() {
  const cells = new Map<string, string>()
  for (let x = -8; x <= 4; x++) for (let z = -5; z <= 5; z++) cells.set(`${x},0,${z}`, 'stone')
  const world = { getBlock(p: Vec3) {
    const q = p.floored(), name = cells.get(`${q.x},${q.y},${q.z}`) || 'air'
    const block = Block.fromStateId(registry.blocksByName[name].defaultState); block.position = q; return block
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384 }, health: 20, food: 20,
    inventory: { slots: [], items: () => [] }, entities: {},
    entity: { id: 1, username: 'A', position: new Vec3(-2, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    blockAt: p => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    ndClock: { age: 500n, serverTicks: 20, ticks: 20 }, physics: native.Physics(registry, world)
  })
  const foe: any = { id: 2, username: 'Enemy', name: 'player', type: 'player', isValid: true,
    position: new Vec3(3.5, 2.5, .5), velocity: new Vec3(.08, .2, 0), onGround: false, height: 1.8, width: .6,
    equipment: [], metadata: [] }
  bot.entities[2] = foe
  const throwers = [-2, -4, -6].map((x, i) => ({ id: String.fromCharCode(65 + i), position: { x, y: 1, z: [.5, -1, 2][i] }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }))
  const options = { arena: { x: -1.5, z: .5, r: 6.5, killY: -10 }, startTick: 505, maxShots: 3 }
  return { bot, foe, throwers, options, cells }
}

test('enemy wind forecasts the native airborne body and schedules distinct throwers/arrival ticks', t => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture(), before = foe.position.clone()
  const plan = planEnemyWind(bot, foe, throwers, options)
  assert.ok(plan, 'a visible airborne target near the void is worth a wind chain')
  assert.ok(plan.shots.length >= 2, JSON.stringify(plan))
  assert.equal(new Set(plan.shots.map(s => s.thrower)).size, plan.shots.length)
  assert.equal(new Set(plan.shots.map(s => s.arrivalTick)).size, plan.shots.length)
  assert.ok(plan.shots.every(s => s.fireTick >= options.startTick && s.arrivalTick > s.fireTick))
  assert.ok(plan.shots.some(s => Math.abs(s.feet.y - (foe.position.y + foe.velocity.y * (s.arrivalTick - 500))) > .1), 'gravity is forecast by the body, not a constant vertical lead')
  assert.ok(plan.nominal.progress > plan.baseline.progress)
  assert.equal(plan.baseline.out, false)
  assert.equal(plan.nominal.out, true)
  assert.deepEqual(foe.position, before, 'planning cannot move the real enemy')
  t.diagnostic(JSON.stringify({ shots: plan.shots.map(s => ({ thrower: s.thrower, fireTick: s.fireTick, arrivalTick: s.arrivalTick })), baseline: plan.baseline, nominal: plan.nominal, worst: plan.worst }))
})

test('entity-hit burst is the actual intercepted body surface, with the age-dependent native margin', () => {
  const { enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers } = fixture()
  const frames = Array.from({ length: 30 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const shot = enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 0, height: 1.4 })
  assert.ok(shot)
  const margin = Math.max(0, Math.min(.3, (shot.ticks - 2) / 20))
  assert.ok(Math.abs(shot.burst.x - (foe.position.x - .3 - margin)) < 1e-6)
  assert.ok(shot.burst.distanceTo(foe.position.offset(0, 1.4, 0)) > .3)
})

test('walls, unknown ray cells and honestly visible friendly interception prevent a direct hostile shot', () => {
  const { enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, cells } = fixture()
  const frames = Array.from({ length: 30 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  for (let y = 1; y <= 5; y++) cells.set(`0,${y},0`, 'stone')
  assert.equal(enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 0, height: 1.4 }), null)
  cells.clear()
  bot.entities[3] = { id: 3, username: 'Ally', type: 'player', position: new Vec3(0, 1.5, .5), width: .6, height: 1.8 }
  assert.equal(enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 0, height: 1.4 }), null)
  delete bot.entities[3]
  bot.blockAt = () => null
  assert.equal(enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 0, height: 1.4 }), null)
})

test('release revalidation includes an earlier projectile still in flight after the shared epoch advances', () => {
  const { enemyWindFrames, enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  const frames = enemyWindFrames(bot, foe, options.arena)
  const shot = enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 0, height: .4 })
  assert.ok(shot && shot.ticks > 2)
  foe.position = frames[2].pos; foe.velocity = frames[2].vel; foe.onGround = frames[2].onGround
  const without = enemyWindFrames(bot, foe, options.arena)
  const inflight = enemyWindFrames(bot, foe, options.arena, [{ ...JSON.parse(JSON.stringify(shot)), fireDelay: -2 }])
  assert.ok(inflight[shot.ticks + 2].pos.distanceTo(without[shot.ticks + 2].pos) > .1, 'the second launch forecasts the first burst instead of cancelling the chain as a changed trajectory')
})

test('dated own radio reports advance with their real controls and refuse an unknown or stale epoch', () => {
  const { windReportAt, planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  const report = { ...throwers[0], yaw: -Math.PI / 2, gameTick: 500, control: { forward: true, sprint: true } }
  const current = windReportAt(bot, report, 502)
  assert.ok(current.position.x > report.position.x)
  assert.equal(current.gameTick, 502)
  assert.equal(windReportAt(bot, report, 521), null)
  assert.equal(windReportAt(bot, report, 499), null)
  assert.equal(windReportAt(bot, { ...throwers[0], gameTick: undefined }, 502), null)
  assert.equal(planEnemyWind(bot, foe, throwers.map(r => ({ ...r, gameTick: 470 })), options), null)
})

test('a reported ally moving into the future projectile segment intercepts before the hostile body burst', () => {
  const { enemyWindFrames, enemyWindShot } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  const ally = { id: 'Crossing', position: { x: 1.5, y: 1, z: 3 }, velocity: { x: 0, y: 0, z: -.3 },
    onGround: true, yaw: 0, gameTick: 500, control: { forward: true, sprint: true } }
  const entity: any = { id: 3, username: ally.id, type: 'player', position: new Vec3(1.5, 1, 3), width: .6, height: 1.8, _ndReportedAlly: true }
  bot.entities[3] = entity
  const frames = enemyWindFrames(bot, foe, options.arena)
  assert.ok(enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 5, height: .4 }), 'its old pose is clear of the shot')
  assert.equal(enemyWindShot(bot, foe, throwers[0], frames, { fireDelay: 5, height: .4, allies: [ally] }), null, 'the native future body occupies the actual flight segment')
})

test('blast resistance is a bound from visible glint, never exact opponent attributes, HP or enchantment levels', () => {
  const { windResistance, planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  assert.deepEqual(windResistance(foe), { lo: 0, hi: 0 })
  const gear: any = { name: 'netherite_boots', componentMap: new Map([['enchantments', { get data() { throw new Error('hidden enchantment levels') } }]]) }
  foe.equipment = [null, null, gear]
  assert.deepEqual(windResistance(foe), { lo: 0, hi: .6 })
  foe.equipment.push({ ...gear, name: 'netherite_leggings' })
  assert.deepEqual(windResistance(foe), { lo: 0, hi: 1 })
  Object.defineProperty(foe, 'attributes', { get() { throw new Error('hidden enemy attributes') } })
  Object.defineProperty(foe.metadata, 9, { get() { throw new Error('exact HP') } })
  const plan = planEnemyWind(bot, foe, throwers, options)
  assert.ok(plan)
  assert.equal(plan.resistance.hi, 1)
  assert.equal(plan.worst.out, false, 'fully resistant gear cannot be called a guaranteed wind kill')
})

test('a blast volume that would carry a nearby ally into the void is rejected even off the projectile ray', () => {
  const { windTeamSafe } = require('../src/combat/enemy-wind')
  const { bot, options } = fixture()
  const ally = { id: 'B', position: { x: 4.5, y: 2, z: 1.5 }, velocity: { x: .1, y: .1, z: 0 }, onGround: false }
  const shot = { ticks: 2, burst: new Vec3(4, 2.2, 1.5) }
  assert.equal(windTeamSafe(bot, [ally], [shot], options.arena), false)
  const safe = { ...ally, position: { x: -3, y: 1, z: 1.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  assert.equal(windTeamSafe(bot, [safe], [shot], options.arena), true, 'allies outside the burst are not blocked by an arbitrary distance gate')
})

test('planner work stays bounded with thirty reports and shares each ally native forecast', t => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  const { bot, foe, throwers, options } = fixture()
  const crowd = [...throwers, ...Array.from({ length: 27 }, (_, i) => ({
    id: 'Ally' + i, position: { x: -7 + i % 9 * 1.2, y: 1, z: [-4.5, 4.5, -3][Math.floor(i / 9)] },
    velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500, control: { forward: false, jump: false }
  }))]
  for (const [name, reports] of [['three', throwers], ['thirty', crowd]] as const) {
    const times: number[] = []
    for (let i = 0; i < 6; i++) {
      const start = performance.now(), plan = planEnemyWind(bot, foe, reports, options)
      times.push(performance.now() - start)
      if (plan) assert.ok(plan.tried <= 36, 'report count does not expand the native search budget')
    }
    t.diagnostic(JSON.stringify({ reports: name, coldMs: times[0], warmMeanMs: times.slice(1).reduce((a, b) => a + b, 0) / 5, maxMs: Math.max(...times) }))
  }
})

test('a running enemy keeps running until the burst: the forecast does not stop him on the spot', () => {
  const { planEnemyWind } = require('../src/combat/enemy-wind')
  // Бег со «Скоростью II» по полу к краю (0.39 бл/т): до попадания он бежит дальше и сам уходит за край — заряд не нужен (baseline.out).
  const run = fixture()
  run.foe.position = new Vec3(0.5, 1, 1.5); run.foe.onGround = true; run.foe.velocity = new Vec3(0, 0, .39)
  const p1 = planEnemyWind(run.bot, run.foe, run.throwers, { ...run.options, reactAfterHit: true })
  assert.ok(!p1 || p1.baseline.out, JSON.stringify(p1?.baseline))
  // Стоящий там же — сам не вылетает.
  const still = fixture()
  still.foe.position = new Vec3(0.5, 1, 1.5); still.foe.onGround = true; still.foe.velocity = new Vec3(0, 0, 0)
  const p2 = planEnemyWind(still.bot, still.foe, still.throwers, { ...still.options, reactAfterHit: true })
  assert.ok(p2 && !p2.baseline.out, JSON.stringify(p2?.baseline))
})

test('colosseum edge is the outer-wall ellipse, not the square: minor axis and diagonal rims are at the edge', () => {
  const { arenaRoom } = require('../src/combat/team-wind') as typeof import('../src/combat/team-wind')
  const arena = { x: 600, z: 600, r: 80, ellipse: { a: 77, b: 65 } }
  assert.ok(Math.abs(arenaRoom(arena, { x: 600, z: 662.5 }) - 2.5) < 1e-6)
  assert.ok(arenaRoom(arena, { x: 647.5, z: 647.5 }) < 8)
  assert.ok(arenaRoom(arena, { x: 600, z: 600 }) >= 65)
  assert.ok(arenaRoom(arena, { x: 600, z: 670 }) < 0)
  assert.equal(arenaRoom({ x: 0, z: 0, r: 10 }, { x: 3, z: -7 }), 3)
})

test('one synchronous enemy wind plan shares raw sight cells and the next plan sees same-tick block updates', () => {
  const { planEnemyWind } = require('../src/combat/enemy-wind') as typeof import('../src/combat/enemy-wind')
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const fixed = new clock.GameClock({ manual: true, epoch: 0 })
  clock.activate(fixed)
  try {
    for (const unknown of [false, true]) {
      const f = fixture(), read = f.bot.blockAt, cells = new Set<string>(); let reads = 0
      f.bot.blockAt = (p: Vec3) => {
        reads++; cells.add(p.floored().toString())
        return unknown && (p.x >= 5 || p.y >= 5) ? null : read(p)
      }
      const before = planEnemyWind(f.bot, f.foe, f.throwers, f.options)
      assert.ok(before)
      assert.ok(reads < cells.size * 2, `shared raw LOS reads: ${reads} reads / ${cells.size} cells`)
      const firstReads = reads
      f.cells.clear()
      const after = planEnemyWind(f.bot, f.foe, f.throwers, f.options)
      assert.notDeepEqual(after, before, 'cache must end with the synchronous call, even without a game tick')
      assert.ok(reads > firstReads, 'new forecast must reread terrain')
    }
  } finally { clock.activate(null); fixed.dispose() }
})

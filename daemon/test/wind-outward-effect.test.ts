import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { runInThisContext } from 'node:vm'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { trackTarget } from '../src/bow/track'
import * as enemy from '../src/combat/enemy-wind'
import { windOutward } from '../src/combat/team-wind'
import { windOutDecide } from '../src/combat/wind-out'
import pick = require('../src/pick')

const file = resolve(__dirname, '../src/combat/enemy-wind.js'), real = createRequire(file), mod = { exports: {} as any }
runInThisContext('(function(require,module,exports,__filename,__dirname){' + readFileSync(file, 'utf8') + '\nmodule.exports.__effectTest={rollout,enemyView};\n})', { filename: file })(real, mod, mod.exports, file, dirname(file))
const { rollout, enemyView } = mod.exports.__effectTest

function fixture(kind: 'free' | 'wall' | 'inward' = 'free', wallHeight = 4) {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const half = require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: () => null }).playerHalfWidth
  const z = kind === 'wall' ? 601 - half : 600.5
  const read = p => {
    const wall = kind === 'wall' && Math.floor(p.z) === 601 && p.y >= 120 && p.y < 120 + wallHeight
    const b = Block.fromStateId(registry.blocksByName[p.y < 120 || wall ? 'sand' : 'air'].defaultState)
    b.position = p.floored(); return b
  }
  const own = { id: 'Caster', position: { x: 600.5, y: 120, z: z + (kind === 'inward' ? 6 : -6) }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }
  const raw: any = { id: 99, username: 'Red', name: 'player', type: 'player', isValid: true, _ndVisible: true,
    position: new Vec3(600.5, 120, z), velocity: new Vec3(0, 0, 0), onGround: true, yaw: Math.PI, pitch: 0, height: 1.8, width: .6, metadata: [0],
    equipment: [null, null, ...['netherite_boots', 'netherite_leggings', 'netherite_chestplate', 'netherite_helmet'].map(name => ({ name, enchanted: true, _ndVisual: true }))] }
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, username: own.id, food: 20, health: 20, game: { minY: -64, height: 384 },
    inventory: { slots: [], items: () => [{ name: 'wind_charge', count: 64 }] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    ndClock: { age: 500n, ticks: 0, serverTicks: 0 }, blockAt: read, entities: { 99: raw }, players: { Red: { entity: raw, gamemode: 0 } },
    entity: { id: 1, username: own.id, position: new Vec3(own.position.x, own.position.y, own.position.z), velocity: new Vec3(0, 0, 0), onGround: true, yaw: Math.PI, pitch: 0, effects: {}, attributes: {} } })
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: read })
  const arena = { x: 600.5, z: 600.5, r: 80, ellipse: { a: 77, b: 65 }, killY: 113 }
  const foe = () => ({ ...enemyView(bot, raw), reactAfterHit: true, keepObservedInput: true, outward: new Vec3(0, 0, 1) })
  const plan = (juggle = false) => enemy.planEnemyWind(bot, raw, [own], { arena, startTick: 502, maxShots: 1, delays: [0], reactAfterHit: true, juggle }) as any
  return { bot, raw, own, arena, foe, plan }
}

test('a covered dead end needs retained progress to justify another gust', () => {
  const { bot, raw, own, arena } = fixture()
  const Block = require('prismarine-block')(bot.registry)
  let wall = true
  const read = p => {
    const at = p.floored()
    const solid = at.y < 120 || (at.y === 123 && at.z <= 565) || (wall && at.z <= 557 && at.y <= 126)
    const block = Block.fromStateId(bot.registry.blocksByName[solid ? 'smooth_sandstone' : 'air'].defaultState)
    block.position = at
    return block
  }
  bot.blockAt = read
  bot.physics = require('../src/tick-plugins').getPhysics().Physics(bot.registry, { getBlock: read })
  Object.assign(raw, { position: new Vec3(600.5, 121, 560.5), velocity: new Vec3(0, .2, -.33),
    onGround: false, yaw: 0, metadata: [8], equipment: [] })
  own.position = bot.entity.position = new Vec3(600.5, 120, 563.1)
  bot.entity.yaw = 0
  bot.heldItem = { name: 'netherite_sword' }

  assert.ok(pick.aim(bot, raw, { range: 3 }), 'ground melee has reach and line of sight')
  assert.equal(windOutDecide(bot, own, arena), null, 'both trajectories already reach the end wall at the landing tick')
  wall = false
  assert.ok(windOutDecide(bot, own, arena), 'a gust still helps when it can carry the target farther under the same ceiling')
})

test('the relay takes the earlier useful hit while keeping a useful distant ray when it is alone', () => {
  const f = fixture()
  f.raw.position = new Vec3(624.5, 120, 600.5)
  f.raw.equipment = []
  const near = { ...f.own, position: { x: 621.5, y: 120, z: 601.7 } }
  const far = { ...f.own, id: 'Relay', position: { x: 608.5, y: 120, z: 596.5 } }
  f.bot.entity.position = new Vec3(near.position.x, near.position.y, near.position.z)
  const options = { arena: f.arena, startTick: 500, maxShots: 1, delays: [0], reactAfterHit: true, allies: [near, far] }
  const plan = (reports: (typeof near)[]) => enemy.planEnemyWind(f.bot, f.raw, reports, options)
  const nearOnly = plan([near]), farOnly = plan([far])
  assert.ok(nearOnly && farOnly)
  assert.ok(nearOnly.shots[0].ticks < farOnly.shots[0].ticks)
  assert.ok(nearOnly.nominal.outwardEffect! > 0 && farOnly.nominal.outwardEffect! > nearOnly.nominal.outwardEffect!)
  assert.equal(plan([near, far])?.shots[0].thrower, near.id)
  assert.equal(plan([far])?.shots[0].thrower, far.id)
})

test('outward wind can reverse a descent without delaying or losing the incumbent contact', () => {
  for (const { vx, ascent, x, expected } of [
    { vx: .4, ascent: .1, x: 610, expected: .4 },
    { vx: .6, ascent: .2176763044, x: 609.6, expected: .4 },
    { vx: .4, ascent: 0, x: 609, expected: 1.6 }
  ]) {
    const { bot, raw, own, arena } = fixture()
    delete raw._ndVisible // Supply a controlled body seed; receipt fitting is covered separately.
    Object.assign(raw, { position: new Vec3(620.8254246792, 138.70129278, 603.8488319898),
      velocity: new Vec3(vx, ascent, .1034002059), onGround: false })
    const velocity = { x: 1.2172481605, y: -.0233763539, z: .1278177142 }
    const position = new Vec3(x, 138.6425281132, 601.8481103383)
    Object.assign(own, { position, velocity, launchMovement: velocity, onGround: false, gliding: true,
      eyeHeight: .4, pitch: .12, yaw: -1.67 })
    Object.assign(bot.entity, { position, onGround: false, elytraFlying: true })
    const plan = enemy.planEnemyWind(bot, raw, [own], {
      arena, startTick: 500, maxShots: 1, delays: [0], reactAfterHit: true, juggle: true
    })
    assert.equal(plan?.shots[0].aimHeight, expected)
    assert.ok(plan.nominal.outwardEffect! > 0)
  }
})

test('steep relifts at the apex and delayed relifts past it both reach coordination', () => {
  for (const { dy, z, delay, early, late } of [
    { dy: .3, z: 620.5, delay: 0, early: false, late: true },
    { dy: .4, z: 620.5, delay: 0, early: true, late: false },
    { dy: .4, z: 620.5, delay: 1, early: false, late: true },
    { dy: .5, z: 620.5, delay: 0, early: true, late: false },
    { dy: .5, z: 655.5, delay: 0, early: false, late: false }
  ]) {
    const { bot, raw, own, arena, foe } = fixture()
    own.position.z = bot.entity.position.z = z - 4
    const feet = new Vec3(600.5, 124, z)
    const receipt = (p: Vec3, t: number) => ({ ...p, t, yaw: 0, pitch: 0, grounded: false, flying: false,
      revision: 1, kind: 'rel_entity_move' })
    const earlier = receipt(feet.offset(0, -dy - dy / .98 - .08, .2), 900)
    const previous = receipt(feet.offset(0, -dy, .1), 950)
    const current = receipt(feet, 1000)
    Object.assign(raw, { onGround: false, yaw: 0, metadata: [8], _ndMotionEpoch: 1, _ndObservationNow: () => 1000,
      position: new Vec3(previous.x, previous.y, previous.z), _ndPositionReceipts: [earlier, previous] })
    const track = trackTarget(raw)
    Object.assign(raw, { position: feet, _ndPositionReceipts: [previous, current], _ndEarlierPositionReceipt: earlier })
    track.update()
    const choice = windOutDecide(bot, own, arena, delay)
    assert.equal(choice?.kind, 'juggle')
    assert.equal(choice?.shot.ticks, 4)
    assert.ok(choice.plan.nominal.progress > choice.plan.baseline.progress)
    const crest = rollout(bot, foe(), [], arena, 0).frames.findIndex(frame => frame.vel.y <= 0)
    assert.equal(crest, Math.round(dy * 10))
    assert.equal(choice.plan.lateLift, late, JSON.stringify({ dy, z, crest, delay, shot: choice.shot }))
    assert.equal(choice.plan.earlyLift, early, JSON.stringify({ dy, z, crest, shot: choice.shot }))
  }
})

test('the centre lift stays coordinated when visible sprint receipts rise but the aged forecast has crested', () => {
  for (const { z, dy, early } of [
    { z: 600.5, dy: .1, early: true },
    { z: 600.5, dy: -.2, early: false },
    { z: 620.5, dy: .1, early: false }
  ]) {
    const { bot, raw, own, arena, foe } = fixture()
    own.position.z = bot.entity.position.z = z - 4
    const feet = new Vec3(600.5, 124, z)
    const receipt = (p: Vec3, t: number) => ({ ...p, t, yaw: 0, pitch: 0, grounded: false, flying: false,
      revision: 1, kind: 'rel_entity_move' })
    const earlier = receipt(feet.offset(0, -dy - dy / Math.fround(.98) - .08, .2), 900)
    const previous = receipt(feet.offset(0, -dy, .1), 950), current = receipt(feet, 1000)
    Object.assign(raw, { onGround: false, yaw: 0, metadata: [8], _ndMotionEpoch: 1, _ndGlideRevision: 1,
      _ndObservationNow: () => 1050, position: new Vec3(previous.x, previous.y, previous.z), _ndPositionReceipts: [earlier, previous] })
    const track = trackTarget(raw)
    Object.assign(raw, { position: feet, _ndPositionReceipts: [previous, current], _ndEarlierPositionReceipt: earlier })
    track.update()
    assert.equal(track.hasPhysicalVelocity(), true)
    assert.equal(track.vel().y > 0, dy > 0)
    assert.ok(foe().velocity.y < 0)
    const choice = windOutDecide(bot, own, arena, 0)
    assert.equal(choice?.kind, 'juggle')
    assert.equal(choice?.plan.lateLift, false)
    assert.equal(choice?.plan.earlyLift, early)
  }
})

for (const motion of ['idle', 'running against the gust'] as const) {
  test(`among useful native rays, same-tick landing displacement wins for a target ${motion}`, () => {
    const f = fixture(), p = f.raw.position, moving = motion !== 'idle'
    f.raw.metadata[0] = moving ? 8 : 0
    f.raw._ndPositionReceipts = [
      { x: p.x, y: p.y, z: p.z + (moving ? .18 : 0), t: 950, kind: 'sync_entity_position', grounded: true },
      { x: p.x, y: p.y, z: p.z, t: 1000, kind: 'rel_entity_move', grounded: true }
    ]
    f.raw._ndObservationNow = () => 1000
    for (const key of ['velocity', 'health', 'hp', 'attributes']) Object.defineProperty(f.raw, key, { get() { throw new Error(`private foreign ${key}`) } })
    const foe = f.foe(), baseline = rollout(f.bot, foe, [], f.arena, 0)
    const results = [.4, 1.6].map(height => {
      const shot = enemy.enemyWindShot(f.bot, foe, f.own, baseline.frames, { fireDelay: 2, height })
      assert.ok(shot)
      return [0, 1].map(mask => {
        const run = rollout(f.bot, foe, [shot], f.arena, 0, mask)
        assert.equal(run.impacts.length, 1)
        const hit = run.impacts[0].fireDelay + run.impacts[0].ticks
        const landing = run.frames.findIndex((frame, tick) => tick > hit && frame.onGround)
        assert.ok(landing > hit && !run.exited)
        assert.ok(enemy.windTeamSafe(f.bot, [f.own], run.impacts, f.arena))
        return { effect: run.outwardEffect, end: run.progress, matched: run.frames[landing].pos.z - baseline.frames[landing].pos.z }
      })
    })
    for (const mask of [0, 1]) {
      const low = results[0][mask], high = results[1][mask]
      assert.ok(high.effect > low.effect && low.effect > 0)
      assert.ok(low.matched > high.matched && high.matched > 0)
      if (moving) assert.ok(low.end < high.end, 'the isolated landing position would choose the opposite ray')
    }
    const plan = f.plan()
    assert.ok(plan)
    assert.equal(plan.tried, 2, 'open air keeps the ordinary two angles')
    assert.equal(plan.shots[0].aimHeight, .4)
    assert.equal(plan.baseline.outwardEffect, 0)
    assert.equal(plan.nominal.outwardEffect, Math.min(...results[0].map(r => r.effect)), 'the signed admission certificate is retained')
    assert.equal(plan.worst.outwardEffect, undefined, 'reactive worst-case certification does not buy extra pricing steps')
    assert.ok(windOutDecide(f.bot, f.own, f.arena), 'the connected caller admits the physical benefit')
  })
}

test('a useful near-rim shot chooses the angle that clears native spread around a slab', () => {
  const f = fixture(), read = f.bot.blockAt, Block = require('prismarine-block')(f.bot.registry)
  f.own.position.z = 628.5
  f.bot.entity.position.z = 628.5
  f.raw.position.z = 650.5
  let slab = false
  f.bot.blockAt = p => {
    if (!slab || !p.floored().equals(new Vec3(600, 120, 646))) return read(p)
    const block = Block.fromProperties('smooth_sandstone_slab', { type: 'bottom' }, 0)
    block.position = p.floored()
    return block
  }
  const plan = () => enemy.planEnemyWind(f.bot, f.raw, [f.own], { arena: f.arena, startTick: 502, maxShots: 1,
    delays: [0], reactAfterHit: true, collision: { blockAt: f.bot.blockAt } as any })
  assert.equal(plan()?.shots[0].aimHeight, .4)
  slab = true
  const nominal = enemy.enemyWindShot(f.bot, f.raw, f.own, rollout(f.bot, f.foe(), [], f.arena, 0).frames, { height: .4 })
  assert.ok(nominal, 'the mean low ray passes the slab')
  assert.equal(plan()?.shots[0].aimHeight, 1.6)
})

test('a late rim throw preserves the high landing when a lower aim sends the target down inside', () => {
  const f = fixture(), Block = require('prismarine-block')(f.bot.registry)
  const collision = { physics: f.bot.physics, game: f.bot.game, blockAt(p: Vec3) {
    const q = p.floored()
    const block = q.y === 150 && q.x <= 550
      ? Block.fromProperties('smooth_sandstone_slab', { type: 'bottom' }, 0)
      : Block.fromStateId(f.bot.registry.blocksByName[q.y < 140 ? 'sandstone' : 'air'].defaultState)
    block.position = q
    return block
  } }
  f.bot.blockAt = collision.blockAt
  f.raw.position.set(552.727613, 150.108876, 563.713986)
  f.raw.velocity.set(-.399383, .672997, -.440153)
  Object.assign(f.raw, { onGround: false, yaw: 4.074253, metadata: [8] })
  const position = new Vec3(578.900497, 140, 576.906253), velocity = new Vec3(-.5035, .883829, .189391)
  const own = { ...f.own, position, velocity, launchMovement: velocity, onGround: false, gliding: true, eyeHeight: .4 }
  Object.assign(f.bot.entity, { position, velocity, onGround: false, elytraFlying: true })
  const body = enemyView(f.bot, f.raw, collision)
  const foe = { ...body, outward: windOutward(f.arena, body.position, body.width), reactAfterHit: true, keepObservedInput: true }
  const baseline = rollout(f.bot, foe, [], f.arena, 0)
  assert.equal(baseline.position.y, 150.5)
  const shot = (height: number) => enemy.enemyWindShot(f.bot, foe, own, baseline.frames, { height })!
  const low = shot(.4), high = shot(1.6)
  assert.ok(low.ticks > baseline.endpointTick && low.ticks === high.ticks)
  for (const mask of [0, 1]) {
    const down = rollout(f.bot, foe, [low], f.arena, 0, mask)
    const stay = rollout(f.bot, foe, [high], f.arena, 0, mask)
    assert.ok(down.outwardEffect > 0 && down.progress < baseline.progress && down.position.y < baseline.position.y)
    assert.ok(stay.outwardEffect > 0 && stay.progress > baseline.progress && stay.position.y === baseline.position.y)
  }
  const plan = enemy.planEnemyWind(f.bot, f.raw, [own], { arena: f.arena, startTick: 500, maxShots: 1,
    delays: [0], reactAfterHit: true, juggle: true, collision })
  assert.equal(plan?.shots[0].aimHeight, 1.6)
})

test('twenty ready rim throwers reuse corridor block shapes for one plan and observe changes on the next', t => {
  const f = fixture(), read = f.bot.blockAt, Block = require('prismarine-block')(f.bot.registry)
  f.bot.username = f.bot.entity.username = 'A'
  f.bot.entity.position.z = 628.5
  f.raw.position.z = 650.5
  f.raw.equipment = []
  const reports = Array.from({ length: 20 }, (_, i) => ({ ...f.own, id: i ? `B${i}` : 'A',
    position: { x: 600.5 + (i - 10) * .77, y: 120, z: 628.5 - i % 4 } }))
  let slab = true
  const collision = { blockAt(p: Vec3) {
    const q = p.floored()
    if (!slab || q.y !== 120 || q.z !== 646 || q.x < 595 || q.x > 607) return read(p)
    const block = Block.fromProperties('smooth_sandstone_slab', { type: 'bottom' }, 0)
    block.position = q; return block
  } } as any
  const shapesOf = pick.shapesOf, reads = new Map<string, number>()
  t.mock.method(pick, 'shapesOf', block => {
    const key = block.position.toString()
    reads.set(key, (reads.get(key) || 0) + 1)
    return shapesOf(block)
  })
  const plan = () => enemy.planEnemyWind(f.bot, f.raw, reports, { arena: f.arena, startTick: 502,
    maxShots: 3, delays: [0, 2], reactAfterHit: true, collision })
  for (const aim of [1.6, .4]) {
    const result = plan()
    assert.equal(result?.tried, 228)
    assert.deepEqual(result?.shots.map(shot => shot.aimHeight), [aim, aim, aim])
    const total = [...reads.values()].reduce((sum, count) => sum + count, 0)
    t.diagnostic(`corridor shape reads ${total} for ${reads.size} distinct cells`)
    assert.ok(reads.size > 100)
    assert.equal(total, reads.size)
    reads.clear()
    slab = false
  }
})

test('native collision removes outward credit for a positive raw impulse into a touching wall', () => {
  const f = fixture('wall'), foe = f.foe(), baseline = rollout(f.bot, foe, [], f.arena, 0)
  for (const height of [.4, 1.6]) {
    const shot = enemy.enemyWindShot(f.bot, foe, f.own, baseline.frames, { fireDelay: 2, height })!
    for (const mask of [0, 1]) {
      const run = rollout(f.bot, foe, [shot], f.arena, 0, mask), tick = run.impacts[0].fireDelay + run.impacts[0].ticks
      assert.ok(run.frames[tick].vel.z - baseline.frames[tick].vel.z > 0)
      assert.equal(run.outwardEffect, 0)
    }
  }
  assert.equal(f.plan(), null, 'raw H into a blocking wall is not useful outward movement')
})

test('an unknown interior floor can end an ellipse forecast without certifying ejection', () => {
  const f = fixture(), foe = f.foe(), { ellipse, ...square } = f.arena
  const supported = rollout(f.bot, foe, [], f.arena, 0)
  assert.equal(supported.out, false)
  assert.equal(supported.frames.at(-1).pos.y, 120)

  const unknownFloor = { ...f.bot, blockAt: p => p.y < 120 ? null : f.bot.blockAt(p) }
  const interior = rollout(unknownFloor, foe, [], f.arena, 0)
  const legacy = rollout(unknownFloor, foe, [], square, 0)
  assert.ok(interior.frames.at(-1).pos.y < f.arena.killY - 1)
  assert.equal(interior.frames.length, legacy.frames.length)
  assert.equal(legacy.out, true, 'the legacy square still counts its interior hole')
  assert.equal(legacy.exited, false)
  assert.equal(interior.exited, false)
  assert.equal(interior.out, false)
  assert.equal(interior.ticks, null)

  const outside = rollout(unknownFloor, { ...foe, position: foe.position.offset(ellipse.a + 1, 0, 0) }, [], f.arena, 0)
  assert.ok(outside.out && outside.exited)
})

test('a grounded observed sprint can clear a one-block wall after the first clipped post-gust step', () => {
  const f = fixture('wall', 1)
  // Controlled visible sprint/motion input; this is not a captured historical railing.
  f.raw.metadata[0] = 8; f.raw.velocity.z = .13
  for (const key of ['health', 'hp', 'attributes']) Object.defineProperty(f.raw, key, { get() { throw new Error(`private foreign ${key}`) } })
  const foe = f.foe(), baseline = rollout(f.bot, foe, [], f.arena, 0)
  const shot = enemy.enemyWindShot(f.bot, foe, f.own, baseline.frames, { fireDelay: 0, height: .4 })!
  const runs = [0, 1].map(mask => rollout(f.bot, foe, [shot], f.arena, 0, mask))
  const tick = shot.fireDelay + shot.ticks
  assert.equal(runs[0].outwardEffect, 0)
  assert.ok(runs[0].frames[tick + 1].pos.y < 121)
  assert.equal(runs[0].frames[tick + 1].pos.z, baseline.frames[tick + 1].pos.z)
  assert.ok(runs[0].frames[tick + 2].pos.y > 121)
  assert.ok(runs[0].frames[tick + 2].pos.z > baseline.frames[tick + 2].pos.z)
  assert.ok(runs.every(r => r.progress > baseline.progress))
  const plan = enemy.planEnemyWind(f.bot, f.raw, [f.own], { arena: f.arena, startTick: 500, maxShots: 1, delays: [0], reactAfterHit: true, juggle: false })!
  assert.ok(plan)
  assert.equal(plan.tried, 3, 'a visible lip enables the low ray even when the landing has open headroom')
  assert.equal(plan.nominal.outwardEffect, 0)
  assert.ok(plan.nominal.progress > plan.baseline.progress)
  assert.equal(windOutDecide(f.bot, f.own, f.arena)?.kind, 'chain')
})

test('an idle body does not earn delayed outward credit merely by rising above the same one-block wall', () => {
  const f = fixture('wall', 1), foe = f.foe(), baseline = rollout(f.bot, foe, [], f.arena, 0)
  const shot = enemy.enemyWindShot(f.bot, foe, f.own, baseline.frames, { fireDelay: 0, height: .4 })!
  const run = rollout(f.bot, foe, [shot], f.arena, 0, 0)
  assert.equal(run.outwardEffect, 0)
  assert.equal(run.progress, baseline.progress)
  assert.equal(windOutDecide(f.bot, f.own, f.arena), null)
})

test('zero immediate effect uses signed relative future progress while negative effect and legacy prices retain their contracts', t => {
  const f = fixture(), plan = f.plan()
  assert.ok(plan)
  let priced: any
  t.mock.method(enemy, 'planEnemyWind', () => priced)
  for (const [effect, future, kind] of [
    [0, .2, 'chain'], [0, 0, undefined], [0, -.2, undefined],
    [-.1, 3, undefined], [.1, -3, 'chain'],
    [undefined, .2, 'chain'], [undefined, -.2, undefined]
  ] as Array<[number | undefined, number, string | undefined]>) {
    priced = { ...plan, shots: [{ ...plan.shots[0], fireDelay: 0 }],
      baseline: { ...plan.baseline, progress: -2, outwardEffect: effect === undefined ? undefined : 0 },
      nominal: { ...plan.nominal, progress: -2 + future, outwardEffect: effect } }
    assert.equal(windOutDecide(f.bot, f.own, f.arena)?.kind, kind, `effect=${effect}, relative future=${future}`)
  }
})

test('a certified actual outer exit retains priority over both immediate and future prices', t => {
  const f = fixture(), plan = f.plan()
  assert.ok(plan)
  t.mock.method(enemy, 'planEnemyWind', () => ({ ...plan, shots: [{ ...plan.shots[0], fireDelay: 0 }],
    baseline: { ...plan.baseline, progress: 0, outwardEffect: 0 },
    nominal: { ...plan.nominal, exited: true, progress: -2, outwardEffect: -.1 },
    worst: { ...plan.worst, exited: false } }))
  assert.equal(windOutDecide(f.bot, f.own, f.arena)?.kind, 'out?')
})

test('an airborne crossing that returns to the Colosseum is not a finished ejection', () => {
  const f = fixture(), start = { ...f.foe(), position: new Vec3(600.5, 137, 666.45), onGround: false }
  const running = rollout(f.bot, { ...start, velocity: new Vec3(0, 0, -.16), run: { yaw: 0 } }, [], f.arena, 0)
  assert.equal(running.exited, true)
  assert.equal(running.out, false)
  assert.ok(running.position.z < 665.5, 'the target comes back inside before landing')
  const idle = rollout(f.bot, { ...start, velocity: new Vec3(0, 0, 0), run: null }, [], f.arena, 0)
  assert.equal(idle.exited, true)
  assert.equal(idle.out, true)
})

test('a rim throw keeps the next lift open in both native damage branches', () => {
  for (const [roofY, pace, expectedAim] of [[127, 0, 1.6], [123, .15, .05], [124, .15, null]] as const) {
    const f = fixture(), read = f.bot.blockAt, Block = require('prismarine-block')(f.bot.registry)
    f.raw.position = new Vec3(600.5, 120, 650.5)
    f.raw.velocity = new Vec3(0, -.08, pace)
    f.own.position.z = f.bot.entity.position.z = 644.5
    if (expectedAim === null) f.arena.ellipse.b = 72
    f.bot.blockAt = p => {
      if (p.y !== roofY || p.z < 654 || p.z > 660) return read(p)
      const roof = Block.fromStateId(f.bot.registry.blocksByName.stone.defaultState)
      roof.position = p.floored(); return roof
    }
    const plan = enemy.planEnemyWind(f.bot, f.raw, [f.own], {
      arena: f.arena, startTick: 500, maxShots: 1, delays: [0], reactAfterHit: true
    })
    assert.equal(plan?.shots[0].aimHeight ?? null, expectedAim, 'avoid the reachable lower space under the rim overhang')
    if (!plan) continue
    const foe = f.foe(), { verticalLift } = require('../src/navigation/geometry')
    for (const mask of [0, 1]) {
      const run = rollout(f.bot, foe, plan.shots, f.arena, 0, mask)
      assert.ok(run.outwardEffect > 0)
      assert.equal(verticalLift(f.bot, run.position, 8), 8)
    }
  }
})

test('a visible roof bounds lift even when blocks above it are unobserved', () => {
  const f = fixture(), read = f.bot.blockAt, Block = require('prismarine-block')(f.bot.registry)
  const { verticalLift } = require('../src/navigation/geometry')
  let roofVisible = true
  f.bot.blockAt = p => {
    if (p.y > 125) return null
    if (p.y !== 125 || !roofVisible) return read(p)
    const roof = Block.fromStateId(f.bot.registry.blocksByName.stone.defaultState)
    roof.position = p.floored(); return roof
  }
  assert.equal(verticalLift(f.bot, f.raw.position, 8), null)
  assert.ok(Math.abs(verticalLift(f.bot, f.raw.position, 8, true) - 3.2) < 1e-9)
  roofVisible = false
  assert.equal(verticalLift(f.bot, f.raw.position, 8, true), null)
})

test('the native forecast distinguishes a wall before landing from open interior air', () => {
  for (const kind of ['free', 'wall'] as const) {
    const f = fixture(kind)
    const foe = { ...f.foe(), position: new Vec3(600.5, 122, 600.5), velocity: new Vec3(0, -.08, .25), onGround: false }
    const run = rollout(f.bot, foe, [], f.arena, 0)
    assert.equal(run.blockedBeforeLanding, kind === 'wall')
    assert.ok(run.frames[run.endpointTick].onGround)
  }
})

test('a supported crossing only stays terminal if the forecast remains outside', () => {
  const f = fixture(), feet = new Vec3(679.5, 120, 600.5)
  const foe = { ...f.foe(), position: feet, onGround: true, yaw: Math.PI / 2 }
  const stays = rollout(f.bot, foe, [], f.arena, 0)
  assert.equal(stays.out, true)
  const returns = rollout(f.bot, { ...foe, velocity: new Vec3(-.21, -.0784, 0),
    run: { yaw: Math.PI / 2, control: { forward: true, sprint: true } } }, [], f.arena, 0)
  assert.equal(returns.exited, true)
  assert.equal(returns.out, false)
  assert.equal(returns.ticks, null)
})

test('a ballistic mace approach is priced through its first landing after a high ascent', () => {
  const f = fixture(), eyes = new Vec3(600.5, 121.62, 600.5)
  const foe = { ...f.foe(), position: new Vec3(600.5, 128, 600.5), velocity: new Vec3(0, .75, 0),
    onGround: false, run: null, protect: [eyes] }
  const threat = rollout(f.bot, foe, [], f.arena, 0)
  assert.ok(threat.clear < 3.5)
  assert.ok(threat.reach > 20 && threat.reach <= threat.endpointTick)
})

test('an outward gust off a high ledge prices the lower landing, with visible fall protection', () => {
  const f = fixture(), read = f.bot.blockAt, Block = require('prismarine-block')(f.bot.registry)
  f.bot.blockAt = p => {
    const at = p.floored()
    if (at.x !== 601 || at.y !== 150 || at.z !== 600) return read(p)
    const block = Block.fromStateId(f.bot.registry.blocksByName.stone.defaultState)
    block.position = at; return block
  }
  const foe = { ...f.foe(), position: new Vec3(601.65, 151, 600.5), onGround: true, velocity: new Vec3(0, -.0784, 0),
    run: null, equipment: [], _ndUnknownArmorSlots: 0 }
  const own = { ...f.own, position: { x: 596, y: 151, z: 600.5 } }
  f.bot.entity.position = new Vec3(596, 151, 600.5)
  const baseline = rollout(f.bot, foe, [], f.arena, 0)
  const shot = enemy.enemyWindShot(f.bot, foe, own, baseline.frames, { height: .4 })
  assert.ok(shot)
  const displaced = rollout(f.bot, foe, [shot], f.arena, 0)
  assert.equal(displaced.position.y, 120)
  assert.equal(displaced.out, false)
  assert.equal(displaced.fallDamage, 28)
  assert.equal(baseline.fallDamage, 0)
  const plan = enemy.planEnemyWind(f.bot, { ...foe, _ndVisible: true }, [own], {
    arena: f.arena, startTick: 500, delays: [0], maxShots: 1, reactAfterHit: true
  })
  assert.equal(plan?.fallThreat, true, 'the connected planner selects the dangerous landing')
  const second = { ...own, id: 'Wing', position: { x: 580, y: 151, z: 600.5 } }
  const group = enemy.planEnemyWind(f.bot, { ...foe, _ndVisible: true }, [own, second], {
    arena: f.arena, startTick: 500, delays: [0], maxShots: 2, reactAfterHit: true
  })
  assert.equal(group?.fallThreat, true, 'extra ready shooters do not hide a dangerous landing')
  assert.equal(group.shots.length, 1, 'one useful gust suffices; keep the second shooter available')
  const equipped = { ...foe, equipment: [null, null, ...Array.from({ length: 4 }, () => ({ name: 'diamond_boots', enchanted: true, _ndVisual: true }))] }
  assert.ok(rollout(f.bot, equipped, [shot], f.arena, 0).fallDamage < 20)
  const falling = { ...foe, position: new Vec3(602.5, 151, 600.5), onGround: false }
  assert.equal(rollout(f.bot, falling, [], f.arena, 0).fallDamage, 28)
  assert.ok(rollout(f.bot, { ...falling, equipment: equipped.equipment }, [], f.arena, 0).fallDamage < 20,
    'a protected baseline landing must not suppress a useful shot as an already lethal fall')
})

test('an opposite native gust has negative causal outward effect in both ordinary-KB branches', () => {
  const f = fixture('inward'), foe = f.foe(), baseline = rollout(f.bot, foe, [], f.arena, 0)
  for (const height of [.4, 1.6]) {
    const shot = enemy.enemyWindShot(f.bot, foe, f.own, baseline.frames, { fireDelay: 2, height })!
    for (const mask of [0, 1]) assert.ok(rollout(f.bot, foe, [shot], f.arena, 0, mask).outwardEffect < 0)
  }
  assert.equal(f.plan(), null)
})

test('ordinary impacts add one native pricing step, the legal last-tick impact adds two, worst/protect add none', () => {
  const f = fixture(), foe = f.foe(), baseline = rollout(f.bot, foe, [], f.arena, 0)
  const native = f.bot.physics.simulatePlayer.bind(f.bot.physics)
  let steps = 0
  f.bot._ndSimOrig = (state, world) => { steps++; return native(state, world) }
  for (const delay of [2, 61]) {
    const shot = enemy.enemyWindShot(f.bot, foe, f.own, baseline.frames, { fireDelay: delay, height: 1.6 })!
    assert.equal(shot.fireDelay + shot.ticks, delay + 4)
    steps = 0
    const run = rollout(f.bot, foe, [shot], f.arena, 0)
    assert.ok(run.outwardEffect > 0)
    assert.equal(steps, delay === 61 ? 67 : 66)
    for (const unchanged of [{ ...foe, keepObservedInput: false }, { ...foe, protect: [new Vec3(600.5, 121.62, 606.5)] }]) {
      steps = 0
      const worst = rollout(f.bot, unchanged, [shot], f.arena, 0)
      assert.equal(worst.outwardEffect, undefined)
      assert.equal(steps, 65)
    }
  }
})

test('a deadline expiring in the counterfactual native step aborts the complete outcome', t => {
  const f = fixture(), foe = f.foe(), baseline = rollout(f.bot, foe, [], f.arena, 0)
  const native = f.bot.physics.simulatePlayer.bind(f.bot.physics)
  let steps = 0, now = 0, stop = 8
  t.mock.method(clock.wall, 'monotonic', () => now)
  f.bot._ndSimOrig = (state, world) => { if (++steps === stop) now = 2; return native(state, world) }
  for (const c of [{ delay: 2, stop: 8 }, { delay: 61, stop: 66 }, { delay: 61, stop: 67 }]) {
    now = 0; steps = 0; stop = c.stop
    const shot = enemy.enemyWindShot(f.bot, foe, f.own, baseline.frames, { fireDelay: c.delay, height: 1.6 })!
    steps = 0
    assert.equal(rollout(f.bot, foe, [shot], f.arena, 0, 0, new Map(), 1), null)
    assert.equal(steps, stop)
  }
})

test('a caller uses certified causal gain even when the isolated endpoint is worse', t => {
  const f = fixture(), plan = f.plan()
  assert.ok(plan)
  // Policy fixture: the native-ray plan remains real; only its reported prices vary.
  t.mock.method(enemy, 'planEnemyWind', () => ({ ...plan, shots: [{ ...plan.shots[0], fireDelay: 0 }],
    baseline: { ...plan.baseline, progress: 0, outwardEffect: 0 }, nominal: { ...plan.nominal, progress: -2, outwardEffect: .3 } }))
  assert.equal(windOutDecide(f.bot, f.own, f.arena)?.kind, 'chain')
})

test('a useful air setup remains a tie-break when the wall clips horizontal movement', t => {
  const f = fixture('wall')
  f.raw.position.y = 121; f.raw.velocity.y = -.2; f.raw.onGround = false
  delete f.raw._ndVisible
  f.own.position.z = f.raw.position.z - 2
  f.bot.entity.position.z = f.own.position.z
  // Controlled public motion estimate; this test exercises native geometry, not receipt inference.
  t.mock.method(require('../src/bow/track'), 'observedVelocity', () => ({ x: 0, y: -.2, z: 0, ageTicks: 0 }))
  const plan: any = enemy.planEnemyWind(f.bot, f.raw, [f.own], { arena: f.arena, startTick: 500, maxShots: 1, delays: [0], reactAfterHit: true, juggle: true })
  assert.ok(plan)
  assert.equal(plan.nominal.outwardEffect, 0)
  assert.ok(plan.nominal.air > plan.baseline.air)
  assert.equal(windOutDecide(f.bot, f.own, f.arena)?.kind, 'juggle')
})

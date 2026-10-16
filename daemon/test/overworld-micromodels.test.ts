import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, stepWorld, hurt, explosionExposure, observeWorld } from '../src/tactics/sim-world'
import { runRecorded } from '../src/tactics/sim-run'
import { observedArrivals } from '../src/tactics/sim-scenarios'
import { mineflayerFacade } from '../src/tactics/sim-mineflayer'

const world = (kind = 'zombie', distance = .8, body: any = {}, extra: any = {}) => createWorld({ name: 'jar-micro', seed: 1, body: { hp: 100, food: 0, armor: 0, knockbackResistance: 1, ...body }, events: [{ at: 1, type: 'enemy', kind, distance, ...extra }] })

test('MeleeAttackGoal attacks at ticks 1/21/41, rather than 1/22/43', () => {
  const w = world(), hits: number[] = []; w.onHurt = () => hits.push(w.tick)
  for (let t = 0; t < 41; t++) stepWorld(w)
  assert.deepEqual(hits, [1, 21, 41]); assert.equal(w.body.hp, 91)
})

test('Mob melee uses inflated overlapping hitboxes, not a three-block radial hit', () => {
  const w = world('zombie', 2); stepWorld(w); w.enemies[0].speed = 0
  for (let t = 0; t < 20; t++) stepWorld(w)
  assert.equal(w.body.hp, 100)
})

test('RangedBowAttackGoal draws for twenty ticks between forty-tick cooldowns', () => {
  const w = world('skeleton', 10)
  for (let t = 0; t < 141; t++) stepWorld(w)
  assert.deepEqual(w.log.filter(s => s.includes('shot skeleton')).map(s => Number(s.split(' ')[0])), [21, 81, 141])
})

test('a skeleton projectile hits a stationary body but cannot home after the body moves away', () => {
  const stationary = world('skeleton', 10), moved = world('skeleton', 10)
  for (let t = 0; t < 21; t++) { stepWorld(stationary); stepWorld(moved) }
  const before = moved.body.hp; moved.body.z = 20
  for (let t = 0; t < 18; t++) { stepWorld(stationary); stepWorld(moved) }
  assert.ok(stationary.body.hp < 100); assert.equal(moved.body.hp, before)
})

test('ServerExplosion samples the body hitbox and a complete intervening wall blocks every ray', () => {
  const w = world(); assert.equal(explosionExposure(w, 3, 0, 0), 1)
  w.spec.obstacles = [[1, -1, -4, 2, 4, 4]]
  assert.equal(explosionExposure(w, 3, 0, 0), 0)
})

test('an ignited creeper stops navigating; exactly seven blocks still sustains its fuse', () => {
  const w = world('creeper', 2.4); stepWorld(w)
  assert.equal(w.enemies[0].x, 2.4); assert.equal(w.enemies[0].swell, 1)
  w.enemies[0].x = 7; stepWorld(w); assert.equal(w.enemies[0].swell, 2)
})

test('a defusing creeper must enter three blocks again; leftover fuse progress is not a positive swell direction', () => {
  const w = world('creeper', 2.4)
  for (let t = 0; t < 5; t++) stepWorld(w)
  const e = w.enemies[0]; e.speed = 0; e.x = 8; stepWorld(w)
  assert.equal(e.swell, 4); assert.equal(e.swellDir, -1)
  e.x = 6; stepWorld(w); assert.equal(e.swell, 3); assert.equal(e.swellDir, -1)
})

test('a full-exposure creeper at 2.4 blocks deals the jar explosion damage, including a lethal hit at hp18', () => {
  for (const hp of [100, 18]) {
    const w = world('creeper', 2.4, { hp }, { swell: 29 }); stepWorld(w)
    const expected = Math.fround((.6 * .6 + .6) / 2 * 7 * 6 + 1)
    assert.equal(w.body.hp, Math.max(0, hp - expected))
  }
})

test('a walker and creeper already inside the box are not protected by its outer walls', () => {
  for (const kind of ['zombie', 'creeper']) {
    const w = world(kind, .25); w.body.shelter = { kind: 'box', breach: 0 }
    stepWorld(w); w.enemies[0].speed = 0
    for (let t = 1; t < 30; t++) stepWorld(w)
    assert.ok(w.body.hp < 100, kind)
  }
})

test('LivingEntity knockback changes velocity only on an accepted hit', () => {
  const w = world('zombie', 1, { knockbackResistance: 0 }); stepWorld(w)
  const source = w.enemies[0], first = w.body.vx
  assert.ok(first < 0); assert.ok(w.body.vy > 0)
  hurt(w, 3, 'mob', source); assert.equal(w.body.vx, first, 'i-frame rejects the repeated hit and its impulse')
  const x = w.body.x; stepWorld(w); assert.ok(w.body.x < x); assert.ok(w.body.y > 0)
})

test('a hit during a crit jump cannot add the on-ground knockback lift', () => {
  const w = world('zombie', 1, { knockbackResistance: 0 }); w.body.jumpAt = 0
  stepWorld(w); assert.equal(w.body.vy, 0)
  const vx = w.body.vx; stepWorld(w); assert.equal(w.body.vx, vx * .91)
})

test('arrow knockback follows the incoming velocity even after its owner moved to the other side', () => {
  const w = world('skeleton', 10, { knockbackResistance: 0 }); stepWorld(w)
  hurt(w, 4, 'arrow', w.enemies[0], { x: -1, z: 0 })
  assert.ok(w.body.vx > 0)
})

test('recorded actions retain their tick boundaries and observed later arrivals enter at that tick', () => {
  const r = runRecorded({ name: 'arrival', ticks: 50, body: { hp: 20, food: 0, armor: 0, blocks: 0 }, world: { exits: false }, events: [{ at: 25, type: 'enemy', kind: 'zombie', distance: .8 }] }, [])
  assert.equal(r.hits[0].tick, 25); assert.equal(r.hits[0].lost, 3); assert.equal(r.damage, 6)
})

test('difficulty scales mob and arrow damage before armor, without changing player melee', () => {
  for (const [difficulty, expected] of [[1, 2.5], [2, 3], [3, 4.5]] as const) {
    const w = world(); w.spec.difficulty = difficulty; stepWorld(w)
    assert.equal(100 - w.body.hp, expected)
  }
  const w = world('player', 1, {}, { player: true, damage: 3 }); w.spec.difficulty = 3; stepWorld(w)
  assert.ok(100 - w.body.hp <= 4.5)
})

test('a wall blocks skeleton shots and creeper ignition; partial exposure lies between zero and one', () => {
  for (const kind of ['skeleton', 'creeper']) {
    const w = world(kind, 2.4); w.spec.obstacles = [[1, -1, -4, 2, 4, 4]]
    stepWorld(w); w.enemies[0].speed = 0
    for (let t = 1; t < 30; t++) stepWorld(w)
    assert.equal(w.body.hp, 100); assert.equal(w.enemies[0].swell, 0)
  }
  const w = world(); w.spec.obstacles = [[1, -1, -4, 2, .3, 4]]
  const exposure = explosionExposure(w, 3, 0, 0); assert.ok(exposure > 0 && exposure < 1)
})

test('incoming arrow observation and facade retain the ballistic position and velocity', () => {
  const w = world('skeleton', 10)
  for (let t = 0; t < 21; t++) stepWorld(w)
  assert.ok(observeWorld(w)!.incomingProjectiles > 0)
  const { bot, sync } = mineflayerFacade(w, {} as any); sync()
  const arrow = Object.values(bot.entities).find((e: any) => e.name === 'arrow') as any
  assert.ok(arrow); assert.equal(arrow.position.x, w.arrows[0].x + .5); assert.equal(arrow.velocity.y, w.arrows[0].vy)
  w.body.z = 20; assert.equal(observeWorld(w)!.incomingProjectiles, 0)
})

test('observed arrivals count new multiplicities without duplicating a lost and regained sighting', () => {
  const enemy = { kind: 'zombie', distance: 8 }
  assert.deepEqual(observedArrivals([{ at: 0, enemies: [enemy] }, { at: 10, enemies: [] }, { at: 20, enemies: [enemy, enemy] }]).map(e => e.at), [0, 20])
  assert.throws(() => observedArrivals([{ at: -1, enemies: [] }]))
  assert.throws(() => observedArrivals([{ at: 0, enemies: [{ ...enemy, distance: NaN }] }]))
  assert.throws(() => runRecorded({ name: 'bad', events: [] }, [{ at: 2, ticks: -1, id: 'Fight' }]))
})

test('regression fuzz-3008: building for thirty ticks at hp4 loses to the first close arrow; moving away survives', () => {
  const scenario: any = { name: 'close-bow-build-eta', seed: 3008, ticks: 100, body: { hp: 4, food: 15, armor: 7 }, events: [{ at: 1, type: 'enemy', kind: 'skeleton', distance: 3.6, angle: 4.6 }] }
  assert.equal(runRecorded(scenario, [{ at: 1, ticks: 60, id: 'BlockOff' }]).died, 'arrow')
  assert.equal(runRecorded(scenario, [{ at: 1, ticks: 60, id: 'Flee' }]).died, null)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { planEnemyWind } from '../src/combat/enemy-wind'
import { windOutDecide, windKind } from '../src/combat/wind-out'

function fixture(yaw = -Math.PI / 2, x = 0) {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const read = p => { const b = Block.fromStateId(registry.blocksByName[p.y < 1 ? 'stone' : 'air'].defaultState); b.position = p.floored(); return b }
  const foe: any = { id: 99, username: 'Red', type: 'player', name: 'player', isValid: true, position: new Vec3(x, 1, 0),
    velocity: new Vec3(0, 0, 0), onGround: true, width: .6, height: 1.8, yaw, pitch: 0, metadata: [], equipment: [] }
  const reports = [-6, 6].map((x, i) => ({ id: i ? 'East' : 'West', position: { x, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: 500 }))
  const botFor = report => {
    const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, username: report.id, game: { minY: -64, height: 384 }, food: 20, health: 20,
      inventory: { slots: [], items: () => [{ name: 'wind_charge', count: 64 }] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
      ndClock: { age: 500n, ticks: 0, serverTicks: 0 },
      entity: { id: report.id === 'West' ? 1 : 2, username: report.id, position: new Vec3(report.position.x, report.position.y, report.position.z), velocity: new Vec3(0, 0, 0),
        onGround: true, yaw: report.id === 'West' ? -Math.PI / 2 : Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
      entities: { 99: foe }, players: { Red: { entity: foe, gamemode: 0 } }, blockAt: read })
    bot.physics = require('../src/tick-plugins').getPhysics().Physics(registry, { getBlock: read })
    return bot
  }
  const arena = { x: 0, z: 0, r: 80, ellipse: { a: 77, b: 65 }, killY: -10 }
  const plan = report => planEnemyWind(botFor(report), foe, [report], { arena, maxShots: 1, startTick: 502, delays: [0], allies: reports, reactAfterHit: true, juggle: true })
  return { foe, reports, botFor, arena, plan }
}

for (const yaw of [-Math.PI / 2, Math.PI / 2]) test(`opposed local throwers share the centre's shorter arena axis despite yaw ${yaw}`, () => {
  const f = fixture(yaw)
  f.arena.ellipse = { a: 65, b: 77 }
  const plan = f.plan(f.reports[0])
  assert.ok(plan)
  assert.ok(plan.nominal.progress > 0)
  assert.equal(f.plan(f.reports[1]), null, 'an equal opposite native gust cannot also count as outward progress')
  const dx = plan.nominal.position.x - f.foe.position.x
  assert.ok(Math.abs(plan.nominal.progress - dx) < 1e-12)
})

test('the initial outward axis stays fixed even when the candidate crosses the centre', () => {
  const f = fixture(Math.PI / 2, .31), plan = f.plan(f.reports[0])
  assert.ok(plan, 'outside the central body footprint, radial position defines the eastward direction despite an opposite look')
  assert.equal(f.plan(f.reports[1]), null)
  assert.ok(Math.abs(plan.nominal.progress - (plan.nominal.position.x - .31) * 65 / 77) < 1e-12)
})

test('an actual native exit on the opposite side stays useful despite negative signed progress', () => {
  const f = fixture(-Math.PI / 2, .31), own = f.reports[1], bot = f.botFor(own)
  Object.assign(f.foe, { position: new Vec3(.31, 3, 0), velocity: new Vec3(0, .4, 0), onGround: false })
  const arena = { x: 0, z: 0, r: .4, killY: -10 }
  const plan = planEnemyWind(bot, f.foe, [own], { arena, maxShots: 1, startTick: 500, delays: [0], reactAfterHit: true, juggle: true })
  assert.ok(plan)
  assert.equal(plan.nominal.exited, true)
  assert.ok(plan.nominal.progress < 0, 'the west exit opposes the initial east axis')
  const decision = windOutDecide(bot, own, arena)
  assert.ok(decision)
  assert.ok(['out', 'out?'].includes(decision.kind))
  assert.equal(windKind({ worstOut: true, nominalOut: true, progress: -1, juggle: false }), 'out')
  assert.equal(windKind({ worstOut: false, nominalOut: true, progress: -1, juggle: false }), 'out?')
  assert.equal(windKind({ worstOut: false, nominalOut: false, progress: -1, juggle: true }), null)
})

for (const sameYaw of [true, false]) test(`exact AF centre-crossing public poses keep useful aligned throws (${sameYaw ? 'same' : 'opposite'} yaw)`, () => {
  const poses = [new Vec3(600.491943359375, 1, 600.469970703125), new Vec3(600.51123046875, 1, 600.54150390625)]
  for (let i = 0; i < poses.length; i++) {
    const f = fixture(i && !sameYaw ? .2699806186678728 : 3.411573272257666)
    f.foe.position = poses[i].clone(); f.arena.x = f.arena.z = 600.5
    f.reports[0].position = { x: 600.5, y: 1, z: 594.5 }; f.reports[1].position = { x: 600.5, y: 1, z: 606.5 }
    const plan = f.plan(f.reports[0])
    assert.ok(plan, 'the same north-side caster offers a positive native throw for both public poses')
    assert.ok(plan.nominal.progress > 0)
    assert.ok(Math.abs(plan.nominal.progress - (plan.nominal.position.z - poses[i].z)) < 1e-12)
    assert.equal(f.plan(f.reports[1]), null, 'the opposite south-side impulse cannot gain from a seven-centimetre centre crossing')
  }
})

test('the native horizontal footprint includes its boundary and corners; just outside keeps radial direction', () => {
  for (const z of [0, .3]) {
    const f = fixture(0, .3)
    f.foe.position.z = z
    f.reports[0].position = { x: .3, y: 1, z: -6 }; f.reports[1].position = { x: .3, y: 1, z: 6 }
    const plan = f.plan(f.reports[0])
    assert.ok(plan)
    assert.ok(Math.abs(plan.nominal.progress - (plan.nominal.position.z - z)) < 1e-12, 'AABB containment is not a radial dead zone')
  }
  const f = fixture(0, .3 + 1 / 4096), plan = f.plan(f.reports[0])
  assert.ok(plan)
  assert.ok(Math.abs(plan.nominal.progress - (plan.nominal.position.x - f.foe.position.x) * 65 / 77) < 1e-12)
  assert.equal(f.plan(f.reports[1]), null)
})

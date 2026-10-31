import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { createAerialCombat } from '../src/combat/aerial-executor'
import { RESCUE_ROCKETS } from '../src/elytra/consts'

function fixture() {
  const target = { id: 2, position: new Vec3(20, 100, 0), velocity: new Vec3(0, 0, 0), flying: true }
  const bot: any = { health: 20, entity: { id: 1, position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, 0), flying: false, onGround: true },
    inventory: { slots: [], items: () => [] }, world: { raycast: () => null } }
  const state = { rockets: RESCUE_ROCKETS, launches: 0, flies: 0, lands: 0 }
  const flight = createAerialCombat(bot, {
    enemy: () => target, worldOf: () => ({ floorBelow: () => ({ top: 80 }) }),
    kit: () => ({ elytra: true, chest: false, mace: false, rockets: state.rockets }), landingSpot: () => new Vec3(20, 80, 0),
    gliding: entity => !!entity.flying, stats: {}, allow() {}, used() {},
    takeoff: async () => { state.launches++; state.rockets--; bot.entity.flying = true; bot.entity.onGround = false; return { ok: true } },
    fly: async () => { state.flies++; return {} },
    predictGlider: entity => entity.position.clone(),
    land: async () => { state.lands++; return { ok: true } }
  } as any)
  return { flight, state, bot }
}

test('ground interception cannot spend the launch reserve and resumes immediately after restocking', async () => {
  const f = fixture()
  for (let rockets = 0; rockets <= RESCUE_ROCKETS; rockets++) {
    f.state.rockets = rockets
    for (let attempt = 0; attempt < 10; attempt++) assert.equal(f.flight.decide().selected, undefined, `rockets=${rockets}`)
  }
  f.state.rockets = RESCUE_ROCKETS + 1
  assert.equal(f.flight.decide().node, 'AerialIntercept')
  await f.flight.run({ aborted: false })
  assert.equal(f.state.launches, 1)
  assert.equal(f.state.flies, 1)
  assert.equal(f.state.rockets, RESCUE_ROCKETS)
})

test('a stale aerial selection rechecks launch fuel before taking the body', async () => {
  const f = fixture()
  f.state.rockets = RESCUE_ROCKETS + 1
  assert.ok(f.flight.decide().selected)
  f.state.rockets = RESCUE_ROCKETS
  const reply = await f.flight.run({ aborted: false })
  assert.equal(reply.ok, false)
  assert.equal(f.state.launches, 0)
  assert.equal(f.state.flies, 0)
})

test('already airborne interception and an unpowered landing retain their actual fuel', async () => {
  const f = fixture()
  f.bot.entity.flying = true; f.bot.entity.onGround = false
  f.state.rockets = 1
  assert.equal(f.flight.decide().node, 'AerialIntercept')
  await f.flight.run({ aborted: false })
  assert.equal(f.state.launches, 0)
  assert.equal(f.state.flies, 1)
  f.state.rockets = 0
  assert.equal(f.flight.decide().node, 'SafeLanding')
  await f.flight.run({ aborted: false })
  assert.equal(f.state.launches, 0)
  assert.equal(f.state.lands, 1)
})

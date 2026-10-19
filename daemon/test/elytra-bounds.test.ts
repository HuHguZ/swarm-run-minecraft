import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import sky = require('../src/elytra')
const empty = { boxHit: () => false, floorBelow: () => null }

test('elytra rollout checks the complete boosted trajectory and full body, while legacy flight keeps its behavior', () => {
  const pos = { x: .5, y: 10, z: .5 }, velocity = { x: 1.6, y: 0, z: 0 }, arena = { x: .5, z: .5, r: 4, killY: 0 }
  const old = sky.rollout(empty, pos, velocity, -Math.PI / 2, 0, 26, 18, { keepPath: true })
  assert.equal(old.kind, null)
  assert.ok(old.p.x > arena.x + arena.r)
  const safe = sky.rollout(empty, pos, velocity, -Math.PI / 2, 0, 26, 18, { keepPath: true, arena })
  assert.equal(safe.kind, 'outside')
  assert.ok(safe.t < 18, 'a reachable goal does not permit an excursion outside before return')
  assert.deepEqual(pos, { x: .5, y: 10, z: .5 })
  assert.equal(sky.rollout(empty, { x: 4.4, y: 10, z: .5 }, velocity, Math.PI / 2, 0, 0, 18, { arena }).kind, 'outside', 'a center inside the square with an outside body is invalid')
  const lethal = sky.rollout(empty, { x: .5, y: .05, z: .5 }, { x: 0, y: -.3, z: 0 }, 0, -.8, 0, 18, { arena })
  assert.equal(lethal.kind, 'outside')
})

test('elytra choice refuses profiles that leave the arena, including rocket choices', () => {
  const arena = { x: 0, z: 0, r: 8, killY: 0 }
  const state = { p: { x: 0, y: 12, z: 0 }, v: { x: .4, y: -.05, z: 0 }, boost: 0, fd: 0 }
  const goal = { kind: 'point', at: { x: 1, y: 12, z: 0 }, arena }
  const choice = sky.choose(empty, state, goal)
  assert.ok(choice)
  assert.notEqual(choice.r.kind, 'outside')
  const rocket = sky.rocketChoice(empty, state, goal, choice, true)
  if (rocket.fire) assert.notEqual(sky.rollout(empty, state.p, state.v, rocket.yaw, rocket.pitch, 26, 18, { arena }).kind, 'outside')
})

test('arena flight collision treats packet-only terrain as blocked and rechecks unknown cells after a new viewpoint', async () => {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(.5, 10, .5) },
    blockAt(p: Vec3) { const at = p.floored(), solid = at.x === 2 && at.y >= 1 && at.y <= 20; return { position: at, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] } }
  })
  const raw = sky.worldOf(bot), observed = sky.worldOf(bot, { observed: true })
  assert.equal(raw.at(4, 10, 0), 0)
  assert.equal(observed.at(4, 10, 0), 1)
  bot.entity.position = new Vec3(3.5, 10, .5)
  await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(observed.at(4, 10, 0), 0)
})

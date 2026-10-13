import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
const flee = require('../src/flee')

function corner(openEast = false) {
  return {
    entity: { position: new Vec3(.7, 0, .3) },
    physics: { playerHalfWidth: Math.fround(.6) / 2, playerHeight: 1.8 },
    blockAt(point: Vec3) {
      const position = point.floored()
      const wall = position.y >= 0 && position.y < 2 &&
        (Math.abs(position.x) === 1 && position.z === 0 && !(openEast && position.x === 1) || position.x === 0 && Math.abs(position.z) === 1)
      return { position, name: position.y < 0 || wall ? 'stone' : 'air', boundingBox: position.y < 0 || wall ? 'block' : 'empty' }
    }
  }
}

test('flee rays cannot fit the body through touching diagonal wall corners', () => {
  assert.equal(flee.pickDirection(corner(), []), null)
})

test('flee rays retain a real open corridor beside blocked diagonal corners', () => {
  const plan = flee.pickDirection(corner(true), [])
  assert.ok(plan)
  assert.ok(plan.dir.x > 0, 'uses the open east side')
})

test('flee rays retain a one-block climb with actual overhead clearance', () => {
  const bot = corner(true)
  bot.blockAt = (point: Vec3) => {
    const position = point.floored()
    const solid = position.y < (position.x >= 1 ? 1 : 0)
    return { position, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty' }
  }
  const plan = flee.pickDirection(bot, [], Math.PI * 1.5)
  assert.ok(plan)
  assert.ok(plan.dir.x > 0)
  assert.equal(plan.end.y, 1)
})

test('cell escape follows the first leg of a corner instead of cutting across the wall', () => {
  const bot = corner()
  bot.entity.position = new Vec3(.5, 0, .5)
  bot.blockAt = (point: Vec3) => {
    const position = point.floored()
    const corridor = position.x === 0 && position.z === 0 || position.x === 1 && position.z >= 0 && position.z <= 8
    const solid = position.y < 0 || !corridor && position.y < 2
    return { position, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty' }
  }
  const route = flee.escapeRoute(bot, [{ e: { position: new Vec3(.5, 0, -2.5) }, doc: flee.DOCTRINE.zombie, d: 3 }])
  assert.ok(route)
  assert.ok(Math.abs(Math.cos(route.yaw)) < 1e-7, 'first leg goes east before turning south')
})

test('enclosure: a one-door room costs more than open ground (arena 12.10: do not flee into a dead end)', () => {
  const world = (room: boolean) => ({
    entity: { position: new Vec3(.5, 0, .5) },
    blockAt(point: Vec3) {
      const p = point.floored()
      // Комната 3×3 с выходом на восток в коридор длиной 1 — или открытое поле.
      const inside = Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1 || p.x === 2 && p.z === 0
      const solid = p.y < 0 || room && p.y < 2 && !inside
      return { position: p, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty' }
    }
  })
  const open = flee.enclosure(world(false), new Vec3(.5, 0, .5))
  const room = flee.enclosure(world(true), new Vec3(.5, 0, .5))
  assert.equal(open, 0)
  assert.ok(room > 10, `комната ${room}`)
})

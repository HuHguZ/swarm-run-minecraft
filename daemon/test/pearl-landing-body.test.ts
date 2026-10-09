import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
const { safeLanding, escapePick } = require('../src/throw')

function world(extra: (p: Vec3) => any = () => undefined) {
  const block = (p: Vec3, name: string, shapes: number[][] = []) => ({ name, position: p, shapes,
    boundingBox: shapes.length ? 'block' : 'empty' })
  const solid = (p: Vec3) => block(p, 'stone_bricks', [[0, 0, 0, 1, 1, 1]])
  const bot: any = { entity: { position: new Vec3(.5, 10, .5) }, blockAt(p: Vec3) {
    const override = extra(p)
    if (override !== undefined) return override === 'solid' ? solid(p) : override === null ? null : block(p, override)
    return p.y < 10 ? solid(p) : block(p, 'air')
  } }
  return bot
}

test('pearl landing rejects intersections that cannot fit even the native crawl pose', () => {
  for (const [tp, obstruction] of [
    [new Vec3(.5, 10.6, .5), new Vec3(0, 11, 0)],
    [new Vec3(.8, 10, .5), new Vec3(1, 10, 0)],
    [new Vec3(.5, 10, .2), new Vec3(0, 10, -1)]
  ]) {
    const bot = world(p => p.equals(obstruction) ? 'solid' : undefined)
    assert.equal(safeLanding(bot, tp), null, `body overlaps ${obstruction}`)
  }
})

test('unknown body space and hazards touching the side do not become safe pearl arrivals', () => {
  assert.equal(safeLanding(world(p => p.x === 1 && p.y === 10 ? null : undefined), new Vec3(.8, 10, .5)), null)
  assert.equal(safeLanding(world(p => p.x === 1 && p.y === 10 ? 'lava' : undefined), new Vec3(.8, 10, .5)), null)
})

test('clear dry and water arrivals remain available, including a wall outside the body', () => {
  assert.deepEqual(safeLanding(world(), new Vec3(.5, 10, .5)), { floorY: 10, fall: 0 })
  assert.deepEqual(safeLanding(world(p => p.x === 1 && p.y >= 10 ? 'solid' : undefined), new Vec3(.65, 10, .5)), { floorY: 10, fall: 0 })
  assert.deepEqual(safeLanding(world(p => p.y === 10 ? 'water' : undefined), new Vec3(.5, 10, .5)), { floorY: 11, water: true })
  assert.deepEqual(safeLanding(world(p => p.y === 10 ? 'cobweb' : undefined), new Vec3(.5, 10, .5)), { floorY: 10, fall: 0 })
  assert.deepEqual(safeLanding(world(p => p.y === 11 ? 'solid' : undefined), new Vec3(.5, 10, .5)), { floorY: 10, fall: 0 }, 'native dry crawl under a low ceiling remains possible')
})

test('the actual escape selector prefers a clear arrival over a more distant side collision', () => {
  const bot = world(p => p.x === 21 && p.y === 10 ? 'solid' : undefined)
  const pick = escapePick(bot, tp => tp.x)
  const chosen = pick({ from: bot.entity.position, landing: yaw => ({
    tp: new Vec3(yaw === 0 ? 20.8 : 12.5, 10, .5)
  }) })
  assert.equal(chosen?.at.x, 12.5)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { drive, worldOf } from './parkour-fixture'
import { jumpDown } from '../src/combat/jump-down'

const arena = { x: 0, z: 0, r: 30, y: 120, killY: 113 }
const World = require('prismarine-world')('1.21.11')
function rim(cells, startY = 120) {
  const { bot, world } = worldOf([[0, startY - 1, 0, 'stone'], ...cells])
  bot.world = new World(null, null).sync
  bot.world.getBlock = world.getBlock
  bot.entity.position = new Vec3(.9, startY, .5)
  bot.entity.velocity.y = -.0784000015258789
  drive(bot, world)
  const ctl = { aborted: false, onAbort: [] }
  return { bot, ctl, run: () => jumpDown({ bot, require: () => bot }, ctl, { from: new Vec3(-2, startY, .5), arena }) }
}

test('a pursued fighter steps off the rim and brakes on one visible lower slab', async () => {
  const f = rim([[1, 118, 0, 'stone_slab', { type: 'bottom', waterlogged: false }]])
  const result = await f.run()
  assert.equal(result.ok, true, result.why)
  assert.equal(f.bot.entity.position.y, 118.5)
  assert.equal(f.bot.entity.onGround, true)
  assert.ok(Math.hypot(f.bot.entity.velocity.x, f.bot.entity.velocity.z) < .05)
  assert.equal(result.drop, 1.5)
})

test('the upper surface of a bottom slab is a walkable approach to a visible ledge', async () => {
  const slab = { type: 'bottom', waterlogged: false }
  const f = rim([[0, 120, 0, 'stone_slab', slab], [1, 120, 0, 'stone_slab', slab], [2, 119, 0, 'soul_sand']])
  f.bot.entity.position.set(.99, 120.5, .5)
  const result = await f.run()
  assert.equal(result.ok, true, result.why)
  assert.equal(f.bot.entity.position.y, 119.875)
})

test('a shelf at the kill plane or an unobserved foothold never starts the descent', async () => {
  for (const hidden of [false, true]) {
    const f = rim([[1, hidden ? 114 : 112, 0, 'stone']])
    if (hidden) f.bot.entity.position.x = .5 // край крыши закрывает луч к глубокому уступу
    let inputs = 0
    f.bot.setControlState = () => { inputs++ }
    assert.equal((await f.run()).ok, false)
    assert.equal(inputs, 0)
  }
})

test('a deep dry escape accounts for landing damage before leaving the rim', async () => {
  const cells = [[1, 114, 0, 'stone']]
  const weak = rim(cells)
  weak.bot.health = 7
  assert.equal((await weak.run()).ok, false)
  assert.equal(weak.bot.entity.position.y, 120)

  const fit = rim(cells)
  const pending = fit.run()
  await fit.bot.waitForTicks(80)
  const result = await pending
  assert.equal(result.ok, true, result.why)
  assert.equal(result.dmg, 2)
  assert.equal(fit.bot.entity.position.y, 115)
  assert.equal(fit.bot.entity.onGround, true)
})

test('a deep water entry succeeds on contact inside the arena', async () => {
  const f = rim([[1, 115, 0, 'water'], [1, 114, 0, 'water'], [1, 113, 0, 'stone']])
  f.bot.health = 3
  const result = await f.run()
  assert.equal(result.ok, true, result.why)
  assert.equal(result.dmg, 0)
  assert.equal(f.bot.entity.isInWater, true)
})

test('a bucket that cannot be used leaves the survivable dry descent available', async () => {
  const f = rim([[1, 114, 0, 'stone']])
  f.bot.game.gameMode = 'survival'
  f.bot.inventory.slots[36] = { name: 'water_bucket' }
  f.bot.inventory.items = () => f.bot.inventory.slots.filter(Boolean)
  f.bot._ndFallGuard = { waterReady: () => ({ ok: false }), planWater: () => assert.fail('unavailable bucket') }
  const pending = f.run()
  await f.bot.waitForTicks(80)
  const result = await pending
  assert.equal(result.ok, true, result.why)
  assert.equal(result.mlg, false)
  assert.equal(result.dmg, 2)
})

test('interruption in mid-air cannot acknowledge a dry landing', async () => {
  const f = rim([[1, 114, 0, 'stone']])
  f.bot.on('physicsTick', () => {
    if (f.bot.entity.position.y < 118.5 && !f.bot.entity.onGround) f.ctl.aborted = true
  })
  const pending = f.run()
  for (let tick = 0; tick < 80 && !f.ctl.aborted; tick++) await f.bot.waitForTicks(1)
  assert.equal(f.ctl.aborted, true)
  assert.equal(f.bot.entity.onGround, false)
  assert.equal((await pending).ok, false)
})

test('a correction across the kill plane invalidates a predicted water landing', async () => {
  const f = rim([[1, 115, 0, 'water'], [1, 114, 0, 'water']])
  f.bot.once('physicsTick', () => {
    f.bot.entity.position.y = arena.killY
    f.bot.entity.isInWater = true
  })
  const result = await f.run()
  assert.equal(result.ok, false)
  assert.equal(result.why, 'outside_arena')
})

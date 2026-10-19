import test from 'node:test'
import assert from 'node:assert/strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import suffocation = require('../src/autopilot/suffocation')
import pick = require('../src/pick')

function fixture(position, solidCells) {
  const bot: any = { entity: { position, height: 1.8, effects: [] },
    blockAt(p) {
      const at = p.floored(), solid = solidCells.some(q => q.equals(at))
      return { position: at, name: solid ? 'gravel' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
    } }
  return { bot, auto: { announced: false, fallingOverhead: () => null } }
}

test('suffocation at the eyes while jumping is not mistaken for clear headroom below', () => {
  const at = new Vec3(0, 66, 0), { bot, auto } = fixture(new Vec3(.5, 64.4, .5), [at])
  const hit = pick.blockOnRay(bot, pick.eyeOf(bot), new Vec3(0, 1, 0), .1)
  assert.ok(hit?.pos.equals(at), 'the client eye is physically inside the opaque roof')
  const buried = suffocation.buriedBy.call(auto, bot)
  assert.ok(buried?.block?.position.equals(at), 'the escape must clear the block at the eyes, rather than report freed')
  assert.equal(suffocation.visibleBurialBlock.call(auto, bot, buried.block), true)
})

test('suffocation where the eye footprint overlaps an adjacent cell keeps the visible escape block', () => {
  const at = new Vec3(1, 65, 0), { bot, auto } = fixture(new Vec3(.9, 64, .5), [at])
  const buried = suffocation.buriedBy.call(auto, bot)
  assert.ok(buried?.block?.position.equals(at), 'the head overlaps gravel across the centre-cell boundary')
  assert.equal(suffocation.visibleBurialBlock.call(auto, bot, buried.block), true, 'the touching gravel is the first block on the client ray')
})

test('a neighbouring wall outside the eye footprint and a normal two-block roof do not bury the body', () => {
  for (const cells of [[new Vec3(1, 65, 0)], [new Vec3(0, 66, 0)]]) {
    const { bot, auto } = fixture(new Vec3(.5, 64, .5), cells)
    assert.equal(suffocation.buriedBy.call(auto, bot), null)
  }
})

test('a bamboo stalk through the eyes does not bury the body: not a suffocating state (cl-m 14.10, 2936 escape digs)', () => {
  const stalk = (p: any) => ({ position: p.floored(), name: 'bamboo', boundingBox: 'block', shapes: [[0.15625, 0, 0.15625, 0.34375, 1, 0.34375]] })
  const bot: any = { entity: { position: new Vec3(.25, 64, .25), height: 1.8, effects: [] },
    blockAt: (p: any) => p.floored().x === 0 && p.floored().z === 0 && p.floored().y >= 64 ? stalk(p) : { position: p.floored(), name: 'air', boundingBox: 'empty', shapes: [] } }
  assert.equal(suffocation.buriedBy.call({ announced: false, fallingOverhead: () => null }, bot), null)
  const mud = fixture(new Vec3(.5, 64.4, .5), [])
  mud.bot.blockAt = (p: any) => ({ position: p.floored(), name: p.floored().y === 66 ? 'mud' : 'air', boundingBox: p.floored().y === 66 ? 'block' : 'empty', shapes: p.floored().y === 66 ? [[0, 0, 0, 1, 0.875, 1]] : [] })
  assert.equal(suffocation.buriedBy.call(mud.auto, mud.bot)?.name, 'mud', 'mud suffocates although its shape is 14/16')
})

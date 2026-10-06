'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { shaftToBricks, mappedStepRisk } = require('../src/endportal')

function rig (overrides: any = {} as Record<string, any>) {
  const bot: Record<string, any> = { entity: { position: new Vec3(0.5, 7, 0.5) }, registry: { itemsByName: {} as Record<string, any> }, entities: {} as Record<string, any>,
    inventory: { items: () => [{ name: 'stone_pickaxe', type: 2, count: 1 }, { name: 'stone_pickaxe', type: 2, count: 1 }] },
    equip: async () => {}, clearControlStates () {},
    blockAt: q => { const p = q.floored(); const name = overrides[`${p.x},${p.y},${p.z}`] || (p.y < bot.entity.position.y ? 'stone' : 'air')
      return { name, type: 1, position: p, boundingBox: /air|water|lava/.test(name) ? 'empty' : 'block', shapes: [[0, 0, 0, 1, 1, 1]] } },
    dig: async b => { bot.entity.position = new Vec3(0.5, b.position.y, 0.5) } }
  bot.world = { raycast: () => bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)) }
  return { bot, session: { bot, mcData: { blocks: { 1: {} as Record<string, any> }, items: {} as Record<string, any> } }, ctl: { aborted: false, onAbort: [] } }
}

test('mapped descent crosses unrelated bricks, reaches exact height and never goes to bedrock', async () => {
  const { session, ctl, bot } = rig({ '1,7,0': 'stone_bricks' })
  const r = await shaftToBricks(session, ctl, { minY: -58, targetY: 5, deadline: Date.now() + 4000 })
  assert.equal(r.reached, true)
  assert.equal(bot.entity.position.y, 5)
  assert.equal(r.dug, 2)
})
test('already at mapped height: no additional dig even with no visible bricks', async () => {
  const { session, ctl } = rig()
  const r = await shaftToBricks(session, ctl, { minY: -58, targetY: 7, deadline: Date.now() + 1000 })
  assert.equal(r.reached, true)
  assert.equal(r.dug, 0)
})
test('mapped route rejects fluids, unknown blocks, portal frames, infested bricks and harmful floors', () => {
  for (const name of ['water', 'lava', 'end_portal_frame', 'infested_stone_bricks', 'spawner']) {
    const { bot } = rig({ '1,7,0': name })
    assert.ok(mappedStepRisk(bot, new Vec3(1, 7, 0)))
  }
  const { bot } = rig({ '1,6,0': 'pointed_dripstone' })
  assert.ok(mappedStepRisk(bot, new Vec3(1, 7, 0)))
  bot.blockAt = () => null
  assert.ok(mappedStepRisk(bot, new Vec3(1, 7, 0)))
})

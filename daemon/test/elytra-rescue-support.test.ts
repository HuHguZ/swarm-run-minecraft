import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { native, Block, worldOf } from './parkour-fixture'
import { aerialMethods } from '../src/rpc/aerial'
import { observedCollision } from '../src/pvp/search'
import { supportAt } from '../src/navigation/geometry'

const idle = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

async function receipt(t, surface: string, edge: boolean, changed = '') {
  const { bot, world } = worldOf([[670, 144, 579, surface]])
  const top = surface.endsWith('_slab') ? 144.5 : 145
  bot.entity.position = new Vec3(edge ? 671.0203437444777 : 670.6851676689461, top, 579.6565139339469)
  bot.entity.velocity.y = -.0784000015258789
  for (let tick = 0; tick < 4; tick++) {
    bot.physics.simulatePlayer(new native.PlayerState(bot, idle), world).apply(bot)
    assert.equal(bot.entity.onGround, true); assert.equal(bot.entity.position.y, top)
  }
  const support = supportAt(observedCollision(bot), bot.entity.position, .04)
  assert.equal(support?.top, top, 'the supporting shape must be available through actual LOS')
  const read = bot.blockAt
  if (changed === 'left') bot.entity.position.x = 671.31
  if (changed === 'airgap') bot.entity.position.y += .1
  if (changed === 'unknown') bot.blockAt = p => p.floored().equals(new Vec3(670, 144, 579)) ? null : read(p)
  if (['magma_block', 'water', 'above', 'waterlogged'].includes(changed)) bot.blockAt = p => {
    const at = p.floored(), replace = at.x === 670 && at.z === 579 && at.y === (changed === 'water' || changed === 'above' ? 145 : 144)
    if (!replace) return read(p)
    const block = Block.fromProperties(changed === 'waterlogged' ? surface : changed === 'above' ? 'stone' : changed, changed === 'waterlogged' ? { type: 'bottom', waterlogged: true } : {})
    block.position = at; return block
  }
  t.mock.method(require('../src/elytra/kit'), 'kit', () => ({ elytra: true, rockets: 0 }))
  t.mock.method(require('../src/elytra/kit'), 'wearingElytra', () => false)
  t.mock.method(require('../src/elytra/install'), 'flightControl', (_b, ctl) => ctl)
  t.mock.method(require('../src/elytra/flight'), 'landingSpot', () => null)
  t.mock.method(require('../src/elytra/flight'), 'fly', async () => ({ why: 'сел', ground: bot.entity.position.clone() }))
  const session: any = { bot, require: () => bot, runIntent: async (_name, work) => ({ status: 'done', detail: await work({ aborted: false }) }) }
  return aerialMethods({ session } as any).fly_to({ at: { x: 600, y: 120, z: 600 }, rescue: true, killY: 113, arena: { x: 600, y: 120, z: 600, r: 80 } })
}

for (const surface of ['smooth_sandstone_slab', 'stone']) for (const edge of [false, true]) test(`rescue confirms native observed ${surface} contact at ${edge ? 'body edge' : 'center'}`, async t => {
  const r = await receipt(t, surface, edge)
  assert.equal(r.detail.ok, true); assert.equal(r.detail.why, null)
})

for (const changed of ['unknown', 'magma_block', 'water', 'above', 'waterlogged', 'left', 'airgap']) test(`rescue rejects ${changed} support despite a stale grounded flag`, async t => {
  const r = await receipt(t, changed === 'waterlogged' ? 'smooth_sandstone_slab' : 'stone', false, changed)
  assert.equal(r.detail.ok, false); assert.equal(r.detail.why, 'unsafe_contact')
})

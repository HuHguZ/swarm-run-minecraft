'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const nether = require('../src/nether')

test('exit kit: only ordinary obsidian, a diamond pick does not waive ten', () => {
  assert.equal(nether.exitKit({ obsidian: 9, crying_obsidian: 64, diamond_pickaxe: 1, flint_and_steel: 1 }).ready, false)
  assert.equal(nether.exitKit({ obsidian: 10, flint_and_steel: 1 }).ready, true)
  assert.equal(nether.exitKit({ obsidian: 10 }).ready, false)
  assert.equal(nether.exitKit({ obsidian: 10, fire_charge: 1 }).ready, true)
})

function rig (name = 'netherrack', hidden = false) {
  const pos = new Vec3(0, 64, 0)
  let block = { name, type: 1, position: pos, hardness: 0.4, boundingBox: /water|lava/.test(name) ? 'empty' : 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
  const bot = { entity: { position: new Vec3(0.5, 64, -0.5) }, inventory: { items: () => [] }, entities: {} as Record<string, any>,
    blockAt: (_position?: unknown) => block, world: { raycast: () => hidden ? null : block },
    dig: async () => { block = { ...block, name: 'air', boundingBox: 'empty' } } }
  const session = { bot, mcData: { blocks: { 1: { harvestTools: { 2: true } } }, items: { 2: { name: 'stone_pickaxe' } } } }
  return { session, ctl: { aborted: false, onAbort: [] }, pos }
}

test('V2-30: clear netherrack without a pick and confirm the cell is air', async () => {
  const { session, ctl, pos } = rig()
  const r = await nether.clearCells(session, ctl, [pos])
  assert.equal(r.stopped, undefined)
  assert.equal(r.dug, 1)
  assert.equal(session.bot.blockAt(pos).name, 'air')
})
test('clearing refuses liquid even with empty collision box', async () => {
  for (const name of ['water', 'lava']) {
    const { session, ctl, pos } = rig(name)
    const r = await nether.clearCells(session, ctl, [pos])
    assert.match(r.stopped, /water|lava/)
    assert.equal(r.dug, 0)
  }
})
test('clearing refuses a hidden block and a swing with no block update', async () => {
  const hidden = rig('netherrack', true)
  assert.match((await nether.clearCells(hidden.session, hidden.ctl, [hidden.pos])).stopped, /вид|прицел/)
  const unchanged = rig()
  unchanged.session.bot.dig = async () => {}
  assert.match((await nether.clearCells(unchanged.session, unchanged.ctl, [unchanged.pos])).stopped, /остал|расчищ/)
})

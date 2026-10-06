'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const pearls = require('../src/pearls')
const { EventEmitter } = require('node:events')

// Boundaries are mocked; the real barter function must consult the guard before walking/clicking.
test('ND_BARTER_FLOW yields the hands to ND_GUARD before selecting a trader', async () => {
  const G = require('../src/ne-guard'); const worlds = require('../src/worlds')
  const old = { attach: G.attach, busy: G.busy, hot: G.hot, react: G.react, worldOf: worlds.worldOf }
  const prior = process.env.ND_BARTER_FLOW
  process.env.ND_BARTER_FLOW = '1'
  let reactions = 0; let clicked = 0
  G.attach = () => {}; G.busy = () => true; G.hot = () => null; G.react = async () => { reactions++ }
  worlds.worldOf = () => 'the_nether'
  const bot = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(0, 64, 0) }; bot.health = 20; bot.entities = {} as Record<string, any>
  bot.inventory = { slots: Array(46).fill(null), items: () => [{ name: 'gold_ingot', count: 18 }] }
  bot.inventory.slots[8] = { name: 'golden_boots' }
  bot.activateEntity = async () => { clicked++ }
  try {
    const r = await pearls.barter({ bot }, { aborted: false }, { count: 18 })
    assert.equal(reactions, 1); assert.equal(clicked, 0)
    assert.equal(r.spent, 0); assert.equal(r.stopped, 'страж прервал бартер')
  } finally {
    Object.assign(G, old); worlds.worldOf = old.worldOf
    if (prior === undefined) delete process.env.ND_BARTER_FLOW; else process.env.ND_BARTER_FLOW = prior
  }
})

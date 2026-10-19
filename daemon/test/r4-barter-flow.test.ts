'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as BF from '../src/barter-flow'
import bastion = require('../src/bastion')

test('guarded barter runs by default and waits only for an actual bounded lure receipt', () => {
  const old = process.env.ND_BARTER_FLOW
  try {
    delete process.env.ND_BARTER_FLOW
    assert.equal(BF.enabled(), true)
    assert.equal(BF.awaitingLure(undefined, 31000), false, 'unexecuted lure plans never extend the window')
    assert.equal(BF.awaitingLure(30300, 36000), true, 'real toss gets the vanilla admire and item-flight window')
    assert.equal(BF.awaitingLure(30300, 30300 + BF.ADMIRE_MS + 2500), false)
    process.env.ND_BARTER_FLOW = '0'
    assert.equal(BF.enabled(), false)
  } finally { if (old === undefined) delete process.env.ND_BARTER_FLOW; else process.env.ND_BARTER_FLOW = old }
})

test('10 pearls require 243 ingots for 80%, even with perfect delivery', () => {
  assert(BF.pearlChance(242, 10) < 0.8)
  assert(BF.pearlChance(243, 10) >= 0.8)
  assert.equal(BF.pearlBudget(10, 0.8, 1), 243)
  assert(BF.pearlBudget(10, 0.85, 0.95) > 243)
  assert.equal(BF.pearlBudget(0), 0)
  assert(Math.abs(BF.pearlChance(1, 2) - 10 / 469) < 1e-15)
})
test('scheduler excludes baby, angry, offhand gold and locally reserved trader', () => {
  const bot = { registry: { entitiesByName: { piglin: { metadataKeys: ['baby', 'mob_flags'] } } } }
  const pg = { id: 3, position: {} as Record<string, any>, metadata: [false, 0], equipment: [] }
  const busy = new Map([[3, 7000]])
  assert.equal(BF.ready(bot, pg, busy, 6999), false)
  assert.equal(BF.ready(bot, pg, busy, 7000), true)
  pg.metadata[0] = true; assert.equal(BF.ready(bot, pg, busy, 7000), false)
  pg.metadata[0] = false; pg.metadata[1] = 4; assert.equal(BF.ready(bot, pg, busy, 7000), false)
  pg.metadata[1] = 0; pg.equipment[1] = { name: 'gold_ingot' }; assert.equal(BF.ready(bot, pg, busy, 7000), false)
})
test('retry keeps carried gold, but does not invent progress for a working or empty barter', () => {
  assert.equal(BF.retry({ barterRetry: 'нет места', ingotsTraded: 0 }, { gold_block: 2 }), true)
  assert.equal(BF.retry({ barterRetry: 'нет места', ingotsTraded: 0 }, { gold_ingot: 17 }), false)
  assert.equal(BF.retry({ barterRetry: 'нет места', ingotsTraded: 2 }, { gold_block: 2 }), false)
})
test('actual handNoWalk does not click a piglin hidden behind a block', async () => {
  const pick: typeof import('../src/pick') = require('../src/pick')
  const old = pick.aim
  let clicked = 0
  pick.aim = () => null
  try {
    const pg = { id: 5, equipment: [] }
    const bot = { entities: { 5: pg }, activateEntity: async () => { clicked++ } }
    assert.equal(await bastion.handNoWalk(bot, pg), false)
    assert.equal(clicked, 0)
  } finally { pick.aim = old }
})
test('relocation refuses missing copy grid without moving the bot', async () => {
  // gridOf определён в nether-route/base.ts: подмена — в определяющей части (фасад отдаёт её через живой геттер).
  const NR: typeof import('../src/nether-route/base') = require('../src/nether-route/base')
  const old = NR.gridOf
  NR.gridOf = () => null
  try {
    assert.equal(await bastion.moveBarterSite({ bot: {} as Record<string, any> }, { aborted: false }, { sealedState: {} as Record<string, any> }, {} as Record<string, any>, Date.now() + 60000), false)
  } finally { NR.gridOf = old }
})

import test = require('node:test')
import assert = require('node:assert/strict')
import { load, ready } from './campaign-seams-fixture'
import { speedrunRegistry } from '../src/core/speedrun'
import type { Effect } from '../src/core/world-state'
const enabled = { ND_END_PREP_PRICE: '1' }
const bare = (extra = {}) => ready({ red_bed: 0, obsidian: 0, oak_boat: 0, ender_eye: 16, ...extra })

test('pricing: unavailable beds and station obsidian do not block the first eye', () => {
  const c = load(bare(), undefined, enabled)
  assert.equal(c.needed('endkit'), false)
  assert.equal(c.done('endkit'), true)
  assert.equal(c.needed('stronghold'), true)
})

test('pricing: before eyes this readiness does not suppress ordinary food collection', () => {
  const c = load(bare({ ender_eye: 0 }), undefined, enabled)
  assert.equal(c.done('endkit'), false)
})

test('pricing: exhaustion counter does not hide a newly carried bed recipe', () => {
  const c = load(bare({ white_wool: 3, oak_planks: 3, crafting_table: 1 }), undefined, enabled)
  c.runs(99)
  assert.equal(c.needed('endkit'), true)
  assert.equal(c.done('endkit'), false)
})

test('pricing: a complete kit goes directly to FindStronghold through the real graph', async () => {
  const c = load(ready({ ender_eye: 16, cooked_beef: 32, red_bed: 6, obsidian: 4 }), undefined, enabled)
  assert.equal(c.done('endkit'), true)
  const selected = await c.select()
  assert.equal(selected.strategy.id, 'FindStronghold')
  assert.equal(c.calls.some(x => /^(mine|fight|explore|goto|craft)$/.test(x.method)), false)
})

test('pricing: the graph records a decision without inventing beds, water or blocks', () => {
  const prep = speedrunRegistry({ endPrepPrice: true }).get('PrepareEnd')
  assert.deepEqual(prep.expectedEffects, { facts: { end_ready: true } })
  assert.equal(prep.modelCost, true, 'legacy twenty-minute kit measurements must not price local crafts')
})

test('pricing: portal-room collection remains available with only the empty frames worth of eyes', () => {
  const { emptyWorld, fact }: typeof import('../src/core/world-state') = require('../src/core/world-state')
  const s = emptyWorld(); s.resources.eyes = 7; s.facts.end_portal = fact(true, 'observed', 0)
  assert.equal(speedrunRegistry({ endPrepPrice: true }).get('PrepareEnd').preconditions(s), true)
  assert.equal(speedrunRegistry().get('PrepareEnd').preconditions(s), false)
})

test('pricing: a readiness decision does not turn off survival food when the bag is empty', () => {
  const { emptyWorld, fact }: typeof import('../src/core/world-state') = require('../src/core/world-state')
  const s = emptyWorld(); s.resources.food = 0; s.facts.end_ready = fact(true, 'observed', 0)
  assert.equal(speedrunRegistry({ endPrepPrice: true }).get('FindFood').preconditions(s), true)
  assert.equal(speedrunRegistry().get('FindFood').preconditions(s), false)
})

test('pricing: a full kit with snapshot hunger and damage can eat or heal without another collection ritual', async () => {
  const state = ready({ ender_eye: 16, cooked_beef: 32, red_bed: 6 }); state.health = 18; state.food = 19
  const c = load(state, undefined, enabled)
  assert.equal(c.needed('endkit'), false)
  const selected = await c.select()
  assert.ok(['EatFood', 'Heal', 'FindStronghold'].includes(selected.strategy.id), selected.strategy.id)
})

test('pricing: the switch defaults to the previous collection and graph effects', () => {
  for (const env of [{}, { ND_END_PREP_PRICE: '0' }]) {
    const c = load(bare(), undefined, env)
    assert.equal(c.needed('endkit'), true)
    assert.equal(c.done('endkit'), false)
  }
  assert.ok((speedrunRegistry().get('PrepareEnd').expectedEffects as Effect).atLeast.beds > 0)
})

test('carried offers: full kit never duplicates beds or farms optional arrows', () => {
  const { endPrepOffers }: typeof import('../src/campaign/end-prep') = require('../src/campaign/end-prep')
  assert.deepEqual(endPrepOffers(ready({ red_bed: 6, feather: 64, flint: 64 }).inventory, 5), [])
})

test('carried offers: use the jar recipe for a missing bed and compare both sides in seconds', () => {
  const { endPrepOffers }: typeof import('../src/campaign/end-prep') = require('../src/campaign/end-prep')
  const [offer] = endPrepOffers({ white_wool: 3, oak_planks: 3, crafting_table: 1 }, 1)
  assert.equal(offer.item, 'white_bed')
  assert.equal(offer.value, 15)
  assert.ok(offer.cost < offer.value)
  assert.equal(offer.plan.steps.at(-1).output.item, 'white_bed')
  assert.equal(offer.plan.inventory.white_wool, 0)
})

test('carried offers: table and material conversions are part of the price', () => {
  const { endPrepOffers }: typeof import('../src/campaign/end-prep') = require('../src/campaign/end-prep')
  assert.equal(endPrepOffers({ white_wool: 3, oak_log: 2 }, 1).length, 0,
    'planks, table and bed cost more than the one-bed value')
  const [batch] = endPrepOffers({ white_wool: 9, oak_planks: 13 }, 3)
  assert.ok(batch && batch.cost < batch.value, 'three beds can amortize making a table')
  assert.ok(batch.plan.steps.some(s => s.output.item === 'crafting_table'))
})

test('carried offers: wool colors and gold shortages are real recipe constraints', () => {
  const { endPrepOffers }: typeof import('../src/campaign/end-prep') = require('../src/campaign/end-prep')
  assert.equal(endPrepOffers({ red_wool: 1, blue_wool: 1, green_wool: 1, oak_planks: 16 }).length, 0)
  const [apple] = endPrepOffers({ apple: 1, gold_ingot: 8, crafting_table: 1 })
  assert.equal(apple.item, 'golden_apple')
  assert.equal(apple.value, 20)
  assert.equal(endPrepOffers({ apple: 1, gold_ingot: 7, crafting_table: 1 }).length, 0)
  assert.equal(endPrepOffers({ golden_apple: 2, apple: 1, gold_ingot: 16, crafting_table: 1 }).length, 0)
})

test('pricing executor: only missing carried crafts run, without wool hunting or night excursions', async () => {
  const state = bare({ white_wool: 3, oak_planks: 3, crafting_table: 1 })
  const c = load(state, (method, p) => {
    if (method === 'craft' && p.item === 'white_bed') {
      state.inventory.white_wool -= 3; state.inventory.oak_planks -= 3; state.inventory.white_bed = 1
    }
    return {}
  }, enabled)
  let guarded = 0
  c.hooks({ nightGuard: async () => { guarded++ } })
  await c.run('endkit')
  assert.equal(state.inventory.white_bed, 1)
  assert.equal(guarded, 0)
  assert.deepEqual(c.calls.filter(x => !['status', 'situation'].includes(x.method)).map(x => x.method), ['craft'])
  assert.equal(c.needed('endkit'), false, 'no indefinite hunt to fill the other four bed slots')
  assert.equal(c.done('endkit'), true)
  assert.ok(c.logs.some(x => /END_PREP_PRICE.*cost=.*value=/.test(x)))
})

test('pricing executor: a failed craft is remembered by state, not an elapsed timer', async () => {
  const state = bare({ white_wool: 3, oak_planks: 3, crafting_table: 1 })
  const c = load(state, () => ({}), enabled)
  await c.run('endkit')
  assert.equal(c.needed('endkit'), false)
  assert.equal(c.done('endkit'), true)
  state.inventory.white_wool = 6
  await c.select()
  assert.equal(c.needed('endkit'), true, 'new resources change the offer')
})

test('pricing executor: physical means of hurting the dragon is still checked at entry', async () => {
  const state = bare({ iron_sword: 0, bow: 0, spectral_arrow: 0 })
  const c = load(state, () => ({}), enabled)
  c.known.endPortal = { x: 0, y: 60, z: 0 }
  await assert.rejects(c.run('dragon'), /END_SEAM_NOT_READY/)
  assert.equal(c.calls.some(x => x.method === 'stronghold' && x.params.mode === 'fill'), false)
})

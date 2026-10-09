import test from 'node:test'
import assert from 'node:assert/strict'
const Loot = require('../src/pvp/arms-loot')
const AL = require('../arms-layout')
const room = () => Array(36).fill(null)

async function withdrawAll(reward: any[], storage: any[]) {
  const { withdrawPass } = require('../src/containers')
  const clock = require('../src/game-clock'), data = require('minecraft-data')('1.21.11')
  const game = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const slots = [...reward, ...storage].map(item => item && structuredClone(item))
  const start = reward.length
  const same = (a, b) => JSON.stringify([a.name, a.ench || {}, a.stars, a.crossbow]) === JSON.stringify([b.name, b.ench || {}, b.stars, b.crossbow])
  const sum = (items, id) => items.filter(Boolean).filter(item => data.itemsByName[item.name].id === id).reduce((n, item) => n + item.count, 0)
  const win: any = { slots, inventoryStart: start, inventoryEnd: slots.length,
    containerItems: () => slots.slice(0, start).filter(Boolean),
    containerCount: id => sum(slots.slice(0, start), id), count: id => sum(slots.slice(start), id),
    async withdraw(id, _metadata, requested) {
      for (let i = 0; i < start && requested > 0; i++) {
        const item = slots[i]
        if (!item || data.itemsByName[item.name].id !== id) continue
        const limit = data.itemsByName[item.name].stackSize
        while (item.count > 0 && requested > 0) {
          let to = slots.findIndex((other, j) => j >= start && other && same(other, item) && other.count < limit)
          if (to < 0) to = slots.findIndex((other, j) => j >= start && !other)
          if (to < 0) throw new Error('destination full')
          const count = Math.min(requested, item.count, limit - (slots[to]?.count || 0))
          slots[to] = { ...item, count: (slots[to]?.count || 0) + count }
          item.count -= count; requested -= count
        }
        if (!item.count) slots[i] = null
      }
    } }
  try {
    let settled = false
    const names = [...new Set(win.containerItems().map(item => item.name))]
    const pending = withdrawPass({ currentWindow: win }, data, win, names, {}).finally(() => { settled = true })
    for (let i = 0; !settled && i < 40; i++) { await new Promise(resolve => setImmediate(resolve)); game.advanceTicks(5) }
    assert(settled, 'actual withdrawPass must finish under the fixture clock')
    return { receipt: await pending, inventory: slots.slice(start).filter(Boolean) }
  } finally { game.dispose() }
}

function contentsReceipt(reward: any[]) {
  const contents = {}
  for (const item of reward) contents[item.name] = (contents[item.name] || 0) + item.count
  return Loot.lootReceipt({ x: 0, y: 0, z: 0 }, { status: 'done', detail: {
    at: { x: 0, y: 0, z: 0 }, took: {}, contents, stopped: 'inventory full' } }).contents
}

const nearlyFull = (free: number) => Array.from({ length: 36 }, (_, i) =>
  i >= 36 - free ? null : i === 0 ? { name: 'bow', count: 1 } : { name: 'cobblestone', count: 64 })

test('known contents preserve first-name order: real all transfer takes bread before arrows in the last slot', async () => {
  const reward = [{ name: 'bread', count: 1 }, { name: 'arrow', count: 12 }], storage = nearlyFull(1)
  const contents = contentsReceipt(reward), actual = await withdrawAll(reward, storage)
  const { powerOf } = require('../src/pvp/arms-graph')
  const gain = powerOf(actual.inventory).total - powerOf(storage.filter(Boolean)).total
  assert.deepEqual(actual.receipt.took, { bread: 1 })
  assert.equal(Loot.marginalGain(storage.filter(Boolean), contents, storage), gain)
  assert.deepEqual(contents.map(item => item.name), ['bread', 'arrow'])
})

test('aggregated separated stacks retain the actual all transfer order by first name', async () => {
  const reward = [{ name: 'bread', count: 1 }, { name: 'arrow', count: 12 }, { name: 'bread', count: 64 }]
  const storage = nearlyFull(2), contents = contentsReceipt(reward), actual = await withdrawAll(reward, storage)
  const { powerOf } = require('../src/pvp/arms-graph')
  assert.deepEqual(actual.receipt.took, { bread: 65 })
  assert.equal(Loot.marginalGain(storage.filter(Boolean), contents, storage),
    powerOf(actual.inventory).total - powerOf(storage.filter(Boolean)).total)
})

test('public sample capacity groups repeated names like all transfer without losing rich variant order', async () => {
  for (const reward of [
    [{ name: 'bread', count: 1 }, { name: 'arrow', count: 12 }, { name: 'bread', count: 64 }],
    [{ name: 'iron_sword', count: 1 }, { name: 'totem_of_undying', count: 1 }, { name: 'iron_sword', count: 1, ench: { sharpness: 5 } }]
  ]) {
    const storage = nearlyFull(2), actual = await withdrawAll(reward, storage)
    const { powerOf } = require('../src/pvp/arms-graph')
    assert.equal(Loot.marginalGain(storage.filter(Boolean), reward, storage),
      powerOf(actual.inventory).total - powerOf(storage.filter(Boolean)).total)
    if (reward[0].name === 'iron_sword') assert.deepEqual(actual.inventory.slice(-2).map(item => item.ench), [undefined, { sharpness: 5 }])
  }
})

test('public arms prior has fixed independent seeds and exposes only item outcomes', () => {
  const before = process.env.SEED
  try {
    process.env.SEED = 'current-world-a'
    const a = AL.publicLootSamples()
    process.env.SEED = 'current-world-b'
    const b = AL.publicLootSamples()
    assert.equal(AL.publicLootSamples.length, 0)
    assert.deepEqual(a, b)
    assert(a.length > 16 && a.every(items => Array.isArray(items) && items.every(i => typeof i === 'string')))
    a[0].push('not-a-real-reward')
    assert(!AL.publicLootSamples()[0].includes('not-a-real-reward'), 'callers cannot modify the cached distribution')
  } finally { if (before == null) delete process.env.SEED; else process.env.SEED = before }
})

test('public item parsing reuses pinned enchantments and recognizes only the exact arms rocket form', () => {
  const items = Loot.sampleItems([['iron_sword[enchantments={sharpness:5,unbreaking:3}]', 'arrow 12', AL.ROCKET3 + ' 4', 'firework_rocket 2']], AL.ROCKET3)[0]
  assert.deepEqual(items.map(i => [i.name, i.count, i.ench, i.stars]), [
    ['iron_sword', 1, { sharpness: 5, unbreaking: 3 }, undefined], ['arrow', 12, {}, undefined],
    ['firework_rocket', 4, {}, 3], ['firework_rocket', 2, {}, 0]
  ])
})

test('loot value is marginal: duplicate armor or weaker weapon adds nothing; arrows enable a bow', () => {
  assert.equal(Loot.marginalGain([{ name: 'iron_chestplate' }], [{ name: 'iron_chestplate' }], room()), 0)
  assert.equal(Loot.marginalGain([{ name: 'iron_sword', ench: { sharpness: 5 } }], [{ name: 'diamond_sword' }], room()), 0)
  assert(Loot.marginalGain([{ name: 'bow' }], [{ name: 'arrow', count: 12 }], room()) > 0)
  assert.equal(Loot.marginalGain([{ name: 'bow' }], [{ name: 'firework_rocket', stars: 3, count: 4 }], room()), 0)
})

test('loot capacity uses actual storage, simple partial stacks and no imagined discard or component merge', () => {
  const full = Array.from({ length: 36 }, () => ({ name: 'cobblestone', count: 64 }))
  assert.equal(Loot.marginalGain([{ name: 'bow' }], [{ name: 'arrow', count: 12 }], full), 0)
  const partial: any[] = full.slice(); partial[0] = { name: 'arrow', count: 60 }
  assert(Loot.marginalGain([{ name: 'bow' }], [{ name: 'arrow', count: 12 }], partial) > 0)
  partial[0] = { name: 'arrow', count: 60, plain: false }
  assert.equal(Loot.marginalGain([{ name: 'bow' }], [{ name: 'arrow', count: 12 }], partial), 0)
  partial[0] = { name: 'firework_rocket', count: 60, stars: 1 }
  assert.equal(Loot.marginalGain([{ name: 'crossbow' }], [{ name: 'firework_rocket', count: 4, stars: 3 }], partial), 0)
})

test('expected gain is the mean of independently capacity-limited marginal outcomes', () => {
  const owned = [{ name: 'bow' }], outcomes = [[{ name: 'arrow' }], [{ name: 'bow' }]]
  const one = Loot.marginalGain(owned, outcomes[0], room())
  assert.equal(Loot.expectedGain(owned, outcomes, room()), one / 2)
  assert.equal(Loot.expectedGain(owned, [], room()), 0)
})

const p = (x: number, z = 0) => ({ x, y: 0, z })
const chest = (id: string, at: any, contents: any[] | null = null) => ({ ...at, id, seenAt: 0, seenFrom: at, opened: contents !== null, looted: false, contents, taken: 0, attempt: null })
const traversal = (to: any, points: any[], ticks = 300, completed = true) => ({ from: points[0], to, points, ticks, completed, at: 0 })
function quote(c: any, { owned = [], traversals = [], foe = null, now = 0 }: any = {}) {
  const { emptyWorld, fact } = require('../src/core/world-state')
  const { armsRegistry, powerOf } = require('../src/pvp/arms-graph')
  const state = emptyWorld(); state.position = p(0)
  state.resources.power = powerOf(owned).total; state.facts.enemy_power = fact(10, 'observed', 0)
  return Loot.quoteLoot({ state, owned, storage: room(), chest: c, prior: [[{ name: 'iron_sword' }]], traversals, foe,
    roundScope: 'r1', now, engage: armsRegistry().get('Engage') })
}

test('confirmed long detour changes candidate choice; failed/reverse routes do not create a shortcut', () => {
  const a = chest('a', p(5)), b = chest('b', p(10))
  const route = traversal(p(5), [p(0), p(0, 40), p(5, 40), p(5)], 1000)
  const qa = quote(a, { traversals: [route] }), qb = quote(b)
  assert.equal(qa.travelSource, 'traversed'); assert.equal(qa.travelTicks, 1000)
  assert.equal(Loot.chooseLoot([qa, qb]).chestId, 'b')
  const failed = Loot.routeEstimate(p(0), a, [{ ...route, ticks: 1, completed: false }])
  assert.equal(failed.source, 'estimate'); assert(failed.ticks > 1)
  assert.equal(Loot.routeEstimate(p(5), chest('back', p(0)), [route]).source, 'estimate')
})

test('a completed directed route can price its actually visited suffix', () => {
  const route = traversal(p(10), [p(0), p(5), p(10)], 400)
  const suffix = Loot.routeEstimate(p(5), chest('a', p(10)), [route])
  assert.equal(suffix.source, 'traversed'); assert(suffix.ticks > 0 && suffix.ticks < 400)
})

test('a nearer duplicate loses to compatible ammunition in the selected chest', () => {
  const owned = [{ name: 'bow' }]
  const a = quote(chest('a', p(3), [{ name: 'bow' }]), { owned })
  const b = quote(chest('b', p(9), [{ name: 'arrow', count: 12 }]), { owned })
  assert.equal(a.gain, 0); assert(b.gain > 0)
  assert.equal(Loot.chooseLoot([a, b]).chestId, 'b')
})

test('route exposure distinguishes observed approaches and widens old foe knowledge without moving it', () => {
  const a = chest('a', p(20, 20)), b = chest('b', p(20, -20))
  const routes = [traversal(a.seenFrom, [p(0), p(0, 20), a.seenFrom]), traversal(b.seenFrom, [p(0), p(0, -20), b.seenFrom])]
  const foe = { at: 0, pos: p(0, 20) }
  const qa = quote(a, { traversals: routes, foe }), qb = quote(b, { traversals: routes, foe })
  assert(qa.riskHi > qb.riskHi)
  assert.equal(Loot.chooseLoot([qa, qb]).chestId, 'b')
  const old = quote(b, { traversals: routes, foe, now: 10000 })
  assert(old.riskHi >= qb.riskHi && old.riskLo < qb.riskLo)
  assert.deepEqual(foe.pos, p(0, 20))
  const unknown = quote(b, { foe })
  assert(unknown.riskHi > unknown.riskLo, 'unobserved route has no invented safe wall')
})

test('quote ordering is deterministic and a failed elapsed action cannot erase interaction cost', () => {
  const a = quote(chest('a', p(0))), b = { ...a, chestId: 'b' }
  assert.equal(Loot.chooseLoot([b, a]).chestId, 'a')
  const late = quote(chest('a', p(0)), { now: 1e6 })
  assert.equal(late.costTicks, 200)
  assert.equal(late.quoteAt, 1e6)
})

test('unknown approach can justify a useful first chest without charging two guaranteed fights', () => {
  const q = quote(chest('a', p(5)))
  const s = require('../src/core/world-state').emptyWorld()
  s.position = p(0); s.resources.power = 1; s.facts.enemy_power = require('../src/core/world-state').fact(10, 'observed', 0)
  const engage = require('../src/pvp/arms-graph').armsRegistry().get('Engage')
  const direct = engage.estimateCost(s) + engage.estimateRisk(s) * 6000
  assert(q.totalWithFight < direct)
  assert.equal(q.exposureLo, 0); assert.equal(q.exposureHi, 1)
  assert.equal(q.exposure, 0.5)
  assert.equal(q.riskPrior, 'interval-midpoint')
  for (const contents of [[], [{ name: 'bow' }]]) {
    const owned = contents.length ? [{ name: 'bow' }] : []
    const empty = quote(chest('a', p(5), contents), { owned })
    assert.equal(empty.gain, 0)
    assert(empty.totalWithFight > direct, 'uncertainty alone must not reward a useless chest')
  }
})

test('a visible enemy approaching a visited interaction point increases conditional risk', () => {
  const target = chest('a', p(0))
  const far = quote(target, { foe: { at: 0, pos: p(40) } })
  const close = quote(target, { foe: { at: 0, pos: p(2) } })
  assert(close.totalWithFight > far.totalWithFight)
  assert(close.risk > far.risk)
})

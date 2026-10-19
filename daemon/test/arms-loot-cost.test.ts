import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { cjsContext } from './cjs-context'

import * as AG from '../src/pvp/arms-graph'
import * as Loot from '../src/pvp/arms-loot'
import { emptyWorld, fact } from '../src/core/world-state'
const source = readFileSync(join(__dirname, '../arena/arms-run.js'), 'utf8')
const body = source.slice(source.indexOf('class ArmsEnv {'), source.indexOf('async function brain('))
const at = { x: 1, y: 0, z: 0 }, here = { x: 0, y: 0, z: 0 }
const remaining = ['iron_sword', 'bow', 'arrow', 'iron_pickaxe', 'iron_axe', 'cooked_beef', 'cobblestone'].map(name => ({ name, count: 1 }))
const room = () => Array(36).fill(null)
async function learned({ interrupted = true, moved = { bread: 8 }, ticks = 9 }: any = {}) {
  let now = 0
  const chest = { ...at, id: '1,0,0', seenAt: 0, seenFrom: here, opened: false, looted: false, contents: null, taken: 0, attempt: null }
  const side: any = { t0: 0, foe: 'Foe', stats: { chests: 0, firstWeapon: null, firstArmor: null },
    know: { revision: 0, foe: null, areas: [], scouted: new Set(), chests: new Map([[chest.id, chest]]), caches: new Map() },
    async call(method) {
      if (method === 'status') return { state: { pos: here, health: 20, food: 20, inventory: {} }, detail: { items: [], storage: room() } }
      if (method === 'players') return { detail: { players: [] } }
      if (method === 'blocks_around') return { detail: { found: [] } }
      if (method === 'armor') return { status: 'done' }
      assert.equal(method, 'chest_take'); now += ticks * 50
      return { status: interrupted ? 'interrupted' : 'done', detail: { at, took: moved,
        contents: interrupted ? Object.fromEntries(remaining.map(i => [i.name, i.count])) : {} } }
    }
  }
  const ArmsEnv = runInNewContext(body + '\nArmsEnv', cjsContext({ AG, Loot, LOOT_PRIOR: [remaining], emptyWorld, fact, LOOT_MS: 60000,
    X: 0, Y: 0, Z: 0, L: { half: 30, spawns: [here] }, W: p => p, COVERS: [], key: p => `${p.x},${p.y},${p.z}`,
    every: () => null, gameClock: { now: () => now, clearInterval() {} } }))
  const env = new ArmsEnv(side, { over: false, roundScope: 'r1' })
  const result = await env.execute({ skill: 'arms.loot', params: { chestId: chest.id, roundScope: 'r1' } }, new AbortController().signal)
  const state = await env.observe()
  return { side, result, quote: (contents: any[] | null) => env.lootQuote(state, { ...chest, looted: false, contents }) }
}

test('actual partial receipt prices seven remaining names above their mandatory withdraw waits', async () => {
  const f = await learned()
  assert.equal(f.result.outcome, 'INTERRUPTED')
  assert(f.quote(remaining).costTicks >= 7 * 250 / 50)
  assert(f.quote(remaining).costTicks > f.quote(remaining.slice(0, 1)).costTicks)
  assert.deepEqual(JSON.parse(JSON.stringify(f.side.know.lootInteractions)), [{ ticks: 9, movedNames: 1, interrupted: true }])
})

test('a full one-name SUCCESS also cannot price a future seven-name chest as one transfer', async () => {
  const f = await learned({ interrupted: false })
  assert.equal(f.result.outcome, 'SUCCESS')
  assert(f.quote(remaining).costTicks >= 35)
  assert.equal(f.quote(remaining.slice(0, 1)).costTicks, 9)
})

test('completed seven-name receipt retains paid overhead without charging seven waits to one name', async () => {
  const f = await learned({ interrupted: false, moved: Object.fromEntries(remaining.map(i => [i.name, 1])), ticks: 36 })
  assert.equal(f.quote(remaining).costTicks, 36)
  assert.equal(f.quote(remaining.slice(0, 1)).costTicks, 6)
})

test('opened no-transfer interruption retains its paid time instead of teaching a free interaction', async () => {
  const f = await learned({ moved: {} })
  assert.equal(f.quote([]).costTicks, 9)
  assert(f.quote(remaining).costTicks >= 44)
})

test('unknown contents use existing prior outcomes and actual capacity, grouping repeated names', () => {
  const sample = [{ ticks: 9, movedNames: 1, interrupted: true }]
  const outcomes = [remaining, [{ name: 'bread', count: 1 }, { name: 'bread', count: 8 }]]
  const full: any[] = Array.from({ length: 36 }, () => ({ name: 'cobblestone', count: 64 }))
  assert.equal(Loot.interactionCost(sample, outcomes, room()), 24)
  assert.equal(Loot.interactionCost(sample, outcomes, full), 4)
  full[0] = null
  assert.equal(Loot.interactionCost(sample, outcomes, full), 9)
  assert.equal(Loot.interactionCost([], outcomes, room()), 200)
})

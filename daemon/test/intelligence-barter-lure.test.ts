'use strict'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as BF from '../src/barter-flow'

function tradeFixture ({ reachable = true, score = 6, seconds = 540, hand = false, abortAt = Infinity } = {}) {
  let now = 100000
  const started = now
  let gold = 12
  const tossAt: number[] = []
  const ctl = { aborted: false }
  const pg = { id: 2, name: 'piglin', position: new Vec3(3.5, 2, 0.5), height: 1.95 }
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    entity: { position: new Vec3(0.5, 0, 0.5) },
    entities: { 2: pg } as Record<number, object>, health: 20,
    registry: { entitiesByName: { item: { id: 1 } } },
    inventory: { items: () => [{ name: 'gold_ingot', count: gold }], emptySlotCount: () => 8 }
  })
  const bo = {
    kind: 'pit', P: { x: 0, y: 0, z: 0 }, F: { x: 0, y: 0, z: 0 },
    M: { x: 0, y: 2, z: 0 }, O: { x: 1, y: 2, z: 0 }, sill: true
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/bastion/booth-trade.js'), 'utf8')
  const from = source.indexOf('async function boothTrade(')
  const to = source.indexOf('\nconst MEMO', from)
  assert.ok(from >= 0 && to > from)
  let handed = false
  const context = vm.createContext(cjsContext({
    Vec3, Map, Set, Number, Math,
    gameClock: { now: () => now },
    BF: { ...BF, enabled: () => true, ready: () => true },
    require: name => name.endsWith('ne-guard') ? { attach () {}, busy: () => false, hot: () => null }
      : name.endsWith('drops') ? { blockGetter: () => () => ({ name: 'air' }) }
        : assert.fail('unexpected dependency ' + name),
    countOf: (_bot, name) => name === 'gold_ingot' ? gold : 0,
    mobs: (_bot, name) => name === 'piglin' ? [pg] : [],
    isBaby: () => false, aggressive: () => false, admiring: () => false,
    pitLike: () => true, junkOut: async () => {}, lastGoldBreak: () => 0,
    unholdGold: async () => false, distToBox: () => hand ? 2 : 4,
    raySees: () => true, throwLands: () => ({ ok: true }),
    handNoWalk: async () => { if (!hand || handed) return false; handed = true; gold--; return true },
    pitLures: () => [{ score, at: new Vec3(3.5, 2, 0.5), aim: new Vec3(3.5, 2, 0.5),
      region: new Set(reachable ? ['3,0'] : ['8,8']) }],
    floorRegion: () => new Set(),
    tossOut: async () => {
      tossAt.push(now - started); gold--
      bot.entities[3] = { id: 3, name: 'item', position: new Vec3(3.5, 2, 0.5), getDroppedItem: () => ({ name: 'gold_ingot', count: 1 }) }
      return true
    },
    sleep: async ms => { now += ms; if (now - started >= abortAt) ctl.aborted = true }
  }))
  vm.runInContext(source.slice(from, to) + '\nthis.run = boothTrade', context)
  return { run: () => context.run({ bot }, ctl, { traded: 0 }, bo, started + seconds * 1000, { keep: 0 }), tossAt }
}

for (const [score, threshold] of [[6, 50000], [4, 70000]]) test(`reachable first lure score ${score} executes after its existing threshold`, async () => {
  const f = tradeFixture({ score })
  const result = await f.run()
  assert.equal(f.tossAt.length, 1)
  assert.ok(f.tossAt[0] > threshold && f.tossAt[0] < threshold + 3000)
  assert.equal(result.handed, 0)
  assert.equal(result.barterReceipts, 0)
  assert.equal(result.barterDelivered, 0)
  assert.equal(result.stopped, 'яма не работает')
  assert.ok(result.seconds < threshold / 1000 + 15, 'unacknowledged toss retains the ordinary bounded receipt wait')
})

test('unreachable adults do not extend the ordinary thirty-second idle budget', async () => {
  const f = tradeFixture({ reachable: false })
  const result = await f.run()
  assert.equal(f.tossAt.length, 0)
  assert.match(result.stopped, /30 с/)
  assert.ok(result.seconds < 35)
})

test('first-lure search respects the original trade deadline and cancellation', async () => {
  const short = tradeFixture({ seconds: 40 })
  const result = await short.run()
  assert.equal(short.tossAt.length, 0)
  assert.ok(result.seconds <= 40)
  const cancelled = tradeFixture({ abortAt: 15000 })
  const cut = await cancelled.run()
  assert.equal(cancelled.tossAt.length, 0)
  assert.ok(cut.seconds < 20)
})

test('an actual first handoff restores the ordinary thirty-second no-receipt budget', async () => {
  const f = tradeFixture({ hand: true })
  const result = await f.run()
  assert.equal(result.handed, 1)
  assert.equal(f.tossAt.length, 0)
  assert.equal(result.barterReceipts, 0)
  assert.match(result.stopped, /30 с/)
  assert.ok(result.seconds < 35)
})

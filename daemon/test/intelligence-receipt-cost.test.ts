import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { Vec3 } from 'vec3'
import { ReceiptCostWindow } from '../src/environments/receipt-cost'
import { bodySource } from './source-fixture'

test('route plans reuse only confirmed dig receipts after eight samples and roll over recent costs', () => {
  const costs = new ReceiptCostWindow()
  const context = 'the_nether|1.21.11|750'
  for (let index = 0; index < 7; index++) costs.observe(context, { result: 'confirmed', packet: 'single', gameMs: 2000 })
  assert.equal(costs.seconds(context), 0)
  costs.observe(context, { result: 'rejected', packet: 'single', gameMs: 60000 })
  costs.observe(context, { result: 'confirmed', packet: 'none', gameMs: 0 })
  assert.equal(costs.seconds(context), 0, 'rejected or predicted changes cannot train routing')
  costs.observe(context, { result: 'confirmed', packet: 'section', gameMs: 2000 })
  assert.equal(costs.seconds(context), 2)
  assert.equal(costs.seconds(context), 2, 'starting another plan does not erase observed execution costs')
  for (let index = 0; index < 32; index++) costs.observe(context, { result: 'confirmed', packet: 'single', gameMs: 4000 })
  assert.equal(costs.seconds(context), 4, 'old server conditions age out of the bounded window')
})

test('world dimension, protocol version, tick rate, and a new connection reset receipt calibration', () => {
  for (const changed of ['overworld|1.21.11|750', 'the_nether|1.21.12|750', 'the_nether|1.21.11|20']) {
    const costs = new ReceiptCostWindow()
    for (let index = 0; index < 8; index++) costs.observe('the_nether|1.21.11|750', { result: 'confirmed', packet: 'single', gameMs: 2000 })
    assert.equal(costs.seconds(changed), 0)
  }
  assert.equal(new ReceiptCostWindow().seconds('the_nether|1.21.11|750'), 0)
})

test('actual route dig callbacks retain their measured cost for the next RPC session', async () => {
  const cleared = new Set<string>()
  const client = new EventEmitter()
  const events = new EventEmitter()
  let now = 0
  const clock = { now: () => now, snapshot: () => ({ ticks: now / 50, tickRate: 750 }), wall: { monotonic: () => performance.now() },
    setTimeout(fn: () => void, milliseconds: number) { return setTimeout(fn, milliseconds).unref() } }
  const bot = {
    version: '1.21.11', game: { dimension: 'the_nether' }, ndClock: { snapshot: () => ({ tickRate: 750 }) },
    entity: { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true },
    _client: client, on: events.on.bind(events), removeListener: events.removeListener.bind(events),
    inventory: { items: () => [] }, setControlState() {},
    blockAt(cell: Vec3) {
      const solid = cell.y < 64 || cell.z === 0 && cell.x >= 1 && cell.x <= 4 && cell.y <= 65 && !cleared.has(cell.toString())
      return { name: solid ? 'stone' : 'air', stateId: solid ? 1 : 0, position: cell, boundingBox: solid ? 'block' : 'empty' }
    },
    async dig({ position }: { position: Vec3 }) {
      setTimeout(() => {
        cleared.add(position.toString()); now += 1500
        client.emit('multi_block_change', { chunkCoordinates: { x: 0, y: 4, z: 0 },
          records: [(position.x & 15) * 256 + (position.z & 15) * 16 + (position.y & 15)] })
      }, 1)
    }
  }
  const sealedFilename = require.resolve('../src/sealed')
  const sealedRequire = createRequire(sealedFilename)
  const sealedModule = { exports: {} }
  new Function('require', 'module', 'exports', readFileSync(sealedFilename, 'utf8'))(
    (name: string) => name === './game-clock' ? clock : sealedRequire(name), sealedModule, sealedModule.exports)
  const realSealed = sealedModule.exports as { digCell: (...args: unknown[]) => Promise<string> }
  const sealed = {
    digCell: realSealed.digCell,
    async stepMove(_bot: typeof bot, _ctl: unknown, { to }: { to: Vec3 }) { bot.entity.position = to.clone(); return true }
  }
  const filename = require.resolve('../src/nether-route')
  const realRequire = createRequire(filename)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bodySource(filename) +
    '\nmodule.exports.probeStep = stepOne; module.exports.probeCost = session => { const history = receiptCostFor(session); return history.costs.seconds(history.context) }')(
    (name: string) => name === './sealed' ? sealed : name === './game-clock' ? clock : realRequire(name), module, module.exports)
  const route = module.exports as {
    probeStep(session: { bot: typeof bot }, ctl: { aborted: boolean }, grid: { mark(): void },
      move: { kind: string; from: Vec3; to: Vec3 }, state: { mismatch: number; digFails: number; stepFails: number; dug: number }): Promise<string>
    probeCost(session: { bot: typeof bot }): number
  }
  for (let x = 1; x <= 4; x++) {
    assert.equal(await route.probeStep({ bot }, { aborted: false }, { mark() {} },
      { kind: 'flat', from: bot.entity.position.clone(), to: new Vec3(x, 64, 0) },
      { mismatch: 0, digFails: 0, stepFails: 0, dug: 0 }), 'ok')
  }
  assert.equal(route.probeCost({ bot }), 1.5, 'a new RPC session reuses eight actual native receipts from this connection')
  bot.game.dimension = 'overworld'
  assert.equal(route.probeCost({ bot }), 0, 'a dimension transfer invalidates that native cost window')
})

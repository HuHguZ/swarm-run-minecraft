import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { bodySource } from './source-fixture'

test('a dig receipt after disconnect cannot continue an old route or write into the new bot cost history', async () => {
  const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry as any)
  const bot = {
    version: '1.21.11', game: { dimension: 'the_nether' }, registry,
    entity: { position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), onGround: true },
    inventory: { items() { throw new Error('old route resumed after disconnect') } },
    blockAt(at) {
      const cell = at.floored()
      const name = cell.equals(new Vec3(1, 65, 0)) ? 'netherrack' : cell.y < 64 ? 'stone' : 'air'
      const block = Block.fromStateId(registry.blocksByName[name].defaultState)
      block.position = cell
      return block
    },
    setControlState() {}
  }
  const filename = require.resolve('../src/nether-route')
  const realRequire = createRequire(filename)
  for (const { replacement, aborted } of [{ replacement: null, aborted: true }, { replacement: {}, aborted: false }]) {
    const session = { bot: bot as typeof bot | null | object }
    const ctl = { aborted: false }
    const st = { mismatch: 0, digFails: 0, stepFails: 0, dug: 0 }
    const marks: unknown[] = []
    let costWrites = 0
    const module = { exports: {} as Record<string, any> }
    const localRequire = name => name === './game-clock' ? { now: () => 0 }
      : name === './environments/receipt-cost' ? { ReceiptCostWindow: class { observe() { costWrites++ } } }
        : name === './sealed' ? { async digCell(_bot, _at, options) {
          session.bot = replacement
          ctl.aborted = aborted
          options.onReceipt({ gameMs: 1, wallMs: 1, serverWaitWallMs: 1, notificationDelayWallMs: 0, result: 'confirmed', packet: 'single' })
          return 'ok'
        } } : realRequire(name)
    new Function('require', 'module', 'exports', bodySource(filename) + '\nmodule.exports.stepOne = stepOne')(
      localRequire, module, module.exports)
    const result = await module.exports.stepOne(session, ctl, { mark: (...args) => marks.push(args) },
      { kind: 'flat', from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 0 } }, st)
    assert.equal(result, 'stop:прервано')
    assert.equal(costWrites, 0)
    assert.equal(st.dug, 0)
    assert.deepEqual(marks, [])
  }
})

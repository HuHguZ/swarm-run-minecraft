'use strict'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'

// Load the analysis without opening the scene's WebSocket/RCON connections.
const source = fs.readFileSync(path.join(__dirname, '..', 'scenes', 'end', 'try-lab-dragon-blast.js'), 'utf8')
const analysis = source.slice(source.indexOf('const dist ='), source.search(/\nasync function toEnd\s*\(/))
function load (tickRate) {
  const ctx: any = { gameClock: { snapshot: () => ({ tickRate }) }, PLAYER: 'NeuroFarm1', r2: v => Math.round(v * 100) / 100 }
  vm.runInNewContext(analysis + '\nresult = analyse', cjsContext(ctx))
  return ctx.result
}
const events = [
  { t: 'pose', tick: 10, ms: 1000, head: [0, 0, 0] },
  { t: 'pose', tick: 11, ms: 1010, head: [0, 0, 0] },
  { t: 'pose', tick: 12, ms: 1020, head: [0, 0, 0] },
  { t: 'bx', tick: 11, ms: 1021, type: 'BED', c: [0, 0, 0] }
]
const bed = { sent: 101019, fcT: 101002, sentWall: 1019, fcWall: 1002, pass: 1, dmg: 30 }

test('DragonLab correlates accelerated game records using wall stamps', () => {
  const rec = load(100)(events, { beds: [bed] }, 'A', 1).blasts[0]
  assert.equal(rec.bot.dmg, 30)
  assert.equal(rec.sentTick, 0)
  assert.equal(rec.sentInTick, 9)
  assert.equal(rec.aimErr, 0)
  assert.equal(rec.fcInTick, 2)
})

test('legacy game stamps are accepted only at known 20 TPS', () => {
  const legacy = { sent: 1019, fcT: 1002, pass: 1, dmg: 30 }
  assert.equal(load(20)(events, { beds: [legacy] }, 'A', 1).blasts[0].aimErr, 0)
  for (const rate of [100, undefined]) {
    assert.equal(load(rate)(events, { beds: [legacy] }, 'A', 1).blasts[0].bot, undefined)
  }
})

test('explicit sentWall never permits a missing fcWall to fall back at acceleration', () => {
  const partial = { ...bed }; delete partial.fcWall
  const rec = load(100)(events, { beds: [partial] }, 'A', 1).blasts[0]
  assert.equal(rec.bot.dmg, 30)
  assert.equal(rec.aimErr, undefined)
  assert.equal(rec.fcInTick, undefined)
})

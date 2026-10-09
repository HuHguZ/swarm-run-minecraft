import test from 'node:test'
import assert from 'node:assert/strict'
import { createPathMiningProgress } from '../src/pvp/movement'

function fixture(ms = 10000) {
  let time = 0
  let mining = true
  const block = { name: 'cobblestone', stateId: 123 }
  const bot = { targetDigBlock: block, pathfinder: { isMining: () => mining }, digTime: () => ms }
  return { bot, progress: createPathMiningProgress(bot, () => time), at: t => { time = t }, stop: () => { mining = false } }
}

test('combat route timers preserve a ten-second dig through three-second stationary checks', () => {
  const f = fixture()
  assert.equal(f.progress(), true)
  for (const at of [3000, 6000, 9000, 10000]) { f.at(at); assert.equal(f.progress(), true) }
  f.at(10100)
  assert.equal(f.progress(), false, 'an unconfirmed dig is bounded by its physical time and receipt ticks')
  f.at(30000)
  assert.equal(f.progress(), false, 'repeated polls cannot renew a stuck dig')
})

test('completion or explicit cancellation immediately stops counting mining as movement', () => {
  const f = fixture()
  assert.equal(f.progress(), true)
  f.at(1000); f.stop()
  assert.equal(f.progress(), false)
})

test('a distinct dig gets its own duration, without renewing the current target', () => {
  const f = fixture(400)
  assert.equal(f.progress(), true)
  f.at(500)
  assert.equal(f.progress(), false)
  f.bot.targetDigBlock = { ...f.bot.targetDigBlock }
  assert.equal(f.progress(), true)
  f.at(1000)
  assert.equal(f.progress(), false)
})

test('unknown or unbreakable blocks cannot suspend route replanning', () => {
  for (const ms of [Infinity, NaN, -1, 0]) assert.equal(fixture(ms).progress(), false)
  const f = fixture()
  f.bot.digTime = () => { throw new Error('missing block') }
  assert.equal(f.progress(), false)
  f.bot.targetDigBlock = null
  assert.equal(f.progress(), false)
})

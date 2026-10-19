'use strict'
import { campaignScript, withSetters } from './campaign-source'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import 'node:fs'
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as gameClock from '../src/game-clock'
import { clockFixture } from './clock-fixture'
import { transpiledSource } from './source-fixture'

const campaignSource = campaignScript()
const turn = () => new Promise<any>(resolve => setImmediate(resolve))

// Keep actual campaign branches in the fixture while holding game time frozen.
// Only the transport boundary advances, without sockets or a Minecraft world.
function frozenCampaign (code, context) {
  const clock = new gameClock.GameClock({ manual: true, epoch: 0 })
  clock.setState({ is_frozen: true })
  let wallMs = 0
  const waits = []
  const port = clockFixture({ setTimeout: (...args: Parameters<typeof clock.setTimeout>) => clock.setTimeout(...args) })
  const setWallTimeout = (resolve, ms) => {
    const wait = { at: wallMs + ms, resolve }
    waits.push(wait)
    return wait
  }
  port.wall = { ...port.wall,
    sleep: ms => new Promise<any>(resolve => setWallTimeout(resolve, ms)),
    setTimeout: setWallTimeout,
    clearTimeout: wait => { const index = waits.indexOf(wait); if (index >= 0) waits.splice(index, 1) }
  }
  const sandbox = { ...context, gameClock: port, module: { exports: null } }
  vm.runInNewContext(`const sleep = ms => gameClock.sleep(ms); ${code}; module.exports = run`, cjsContext(withSetters(sandbox)))
  return {
    clock, run: sandbox.module.exports,
    advanceWall (ms) {
      wallMs += ms
      for (let i = waits.length - 1; i >= 0; i--) {
        if (waits[i].at <= wallMs) waits.splice(i, 1)[0].resolve()
      }
    }
  }
}

test('campaign retries a failed connection using wall time while game ticks are stopped', async () => {
  const start = campaignSource.indexOf('      if (state.connected === false) {')
  const end = campaignSource.indexOf('      if (dim() !== lastDim)', start)
  assert.ok(start >= 0 && end > start)
  const state: Record<string, any> = { connected: false }
  let attempts = 0
  const context = { state, stage: '-', log () {}, async refresh () {},
    async act (method) { assert.equal(method, 'connect'); if (++attempts === 2) state.connected = true } }
  const fixture = frozenCampaign(`async function run () {
    for (let turn = 0; turn < 2; turn++) { ${campaignSource.slice(start, end)} }
  }`, context)
  const running = fixture.run()
  try {
    await turn()
    assert.equal(attempts, 1)
    fixture.advanceWall(29999)
    await turn()
    assert.equal(attempts, 1)
    fixture.advanceWall(1)
    await turn()
    assert.equal(attempts, 2)
    await running
    assert.equal(fixture.clock.ticks, 0)
  } finally { fixture.clock.dispose() }
})

test('campaign closes its socket after the wall RPC watchdog in a frozen world', async () => {
  const start = campaignSource.indexOf('    if (!detached && !manualControl')
  const end = campaignSource.indexOf('\n  }\n}', start) // конец runCampaign (campaign/loop)
  assert.ok(start >= 0 && end > start)
  let closed = false
  const context = { detached: false, manualControl: false, state: {} as Record<string, any>, log () {},
    call: () => new Promise<void>(() => {}), ws: { close () { closed = true } } }
  const fixture = frozenCampaign(`async function run () { ${campaignSource.slice(start, end)} }`, context)
  const running = fixture.run()
  try {
    fixture.advanceWall(14999)
    await turn()
    assert.equal(closed, false)
    fixture.advanceWall(1)
    await turn()
    assert.equal(closed, true)
    await running
    assert.equal(fixture.clock.ticks, 0)
  } finally { fixture.clock.dispose() }
})

test('Director loop installs its next wait on replacement clocks after disconnect', async () => {
  const { Director }: typeof import('../src/director') = require('../src/director')
  let botReads = 0
  const director = Object.create(Director.prototype)
  Object.assign(director, { on: true, session: { get bot () { botReads++; return null } } })
  const first = gameClock.activate(new gameClock.GameClock({ manual: true }))
  let second
  const running = director.loop()
  try {
    assert.equal(first.timers.size, 1)
    first.dispose()
    second = gameClock.activate(new gameClock.GameClock({ manual: true }))
    await turn()
    assert.equal(botReads, 1)
    assert.equal(second.timers.size, 1)
    second.advanceTicks(20)
    await turn()
    assert.equal(botReads, 2)
    assert.equal(second.timers.size, 1)
    director.on = false
    second.dispose()
    await running
    assert.equal(director.step, null)
  } finally {
    director.on = false
    first.dispose(); second?.dispose(); gameClock.activate(null)
  }
})

test('shared movement wait unwinds controls when its clock ends during an intent', async () => {
  const { escapeWater }: typeof import('../src/movement') = require('../src/movement')
  // The A6 water budget plans only visible routes; this fake bot has no world to raycast, so pin the legacy path —
  // the subject here is the clock unwinding, not route visibility.
  const prevBudget = process.env.ND_WATER_ESCAPE_BUDGET
  process.env.ND_WATER_ESCAPE_BUDGET = '0'
  const clock = gameClock.activate(new gameClock.GameClock({ manual: true }))
  const ctl: Record<string, any> = { aborted: false }
  let cleared = 0
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), isInWater: true }, food: 20,
    pathfinder: { setGoal () {} }, async lookAt () {}, setControlState () {},
    clearControlStates () { cleared++ },
    blockAt (p) {
      if (p.y < 64) return { name: 'stone', boundingBox: 'block' }
      return { name: p.x < 1 && p.y < 66 ? 'water' : 'air', boundingBox: 'empty' }
    }
  }
  let settled = false
  const moving = escapeWater(bot, ctl).then(r => { settled = true; return r })
  try {
    await turn()
    assert.equal(clock.timers.size, 1)
    ctl.aborted = true
    clock.dispose()
    await turn()
    assert.equal(settled, true)
    await moving
    assert.equal(cleared, 1)
  } finally {
    ctl.aborted = true; clock.dispose(); gameClock.activate(null)
    if (prevBudget === undefined) delete process.env.ND_WATER_ESCAPE_BUDGET
    else process.env.ND_WATER_ESCAPE_BUDGET = prevBudget
  }
})

test('Director restart while frozen keeps one cycle and discards the previous generation', async () => {
  const { Director }: typeof import('../src/director') = require('../src/director')
  const clock = gameClock.activate(new gameClock.GameClock({ manual: true }))
  clock.setState({ is_frozen: true })
  const director = Object.create(Director.prototype)
  let botReads = 0
  const loops = []
  Object.assign(director, { on: false, session: { get bot () { botReads++; return null } },
    status () { return { on: this.on } }, note () {},
    loop (...args) { const pending = Director.prototype.loop.apply(this, args); loops.push(pending); return pending } })
  try {
    director.start()
    director.stop()
    director.start()
    const currentStep = director.step = { name: 'current generation' }
    assert.equal(clock.ticks, 0)
    assert.equal(botReads, 0)
    clock.advanceTicks(20)
    await turn()
    assert.equal(botReads, 1)
    assert.equal(clock.timers.size, 1)
    assert.equal(director.step, currentStep)
    clock.advanceTicks(20)
    await turn()
    assert.equal(botReads, 2)
    assert.equal(clock.timers.size, 1)
  } finally {
    director.stop()
    clock.dispose(); gameClock.activate(null)
    await Promise.all(loops)
  }
})

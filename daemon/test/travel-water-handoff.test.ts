import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'

function fixture({ swim = 'ok', deadline = 10000, cancelNever = false }: any = {}) {
  const file = path.resolve(__dirname, '../src/movement.ts'), local = createRequire(file)
  const module = { exports: {} as any }
  const code = (require('esbuild') as typeof import('esbuild')).transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap(code + '\nmodule.exports.testWater = fn => { escapeWater = fn }; module.exports.testPath = fn => { gotoPath = fn }'), { filename: file })
    (module.exports, local, module, file, path.dirname(file))
  const movement = module.exports
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(-191, 64, 15), onGround: true, isInWater: false }
  bot.blockAt = (p: any) => ({ name: 'air', boundingBox: 'empty', position: p.floored() })
  const calls: any[] = [], goals: any[] = []
  bot.pathfinder = { goal: null, moving: false, mining: false, building: false,
    isMoving() { return this.moving }, isMining() { return this.mining }, isBuilding() { return this.building },
    setGoal(goal: any) { goals.push(goal); this.goal = goal; bot.emit('goal_updated', goal); bot.emit('path_reset', 'goal_updated') } }
  movement.testWater(async (_bot: any, _ctl: any, options: any) => {
    calls.push({ options, goal: bot.pathfinder.goal, listeners: bot.eventNames().filter((name: any) => bot.listenerCount(name)) })
    if (swim === 'failed') return { ok: false, error: 'no connected dry bank' }
    bot.entity.isInWater = false
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    return { ok: true }
  })
  if (cancelNever) movement.testPath((_bot: any, goal: any) => {
    bot.pathfinder.setGoal(goal)
    return Object.assign(new Promise(() => {}), { cancel() { calls.push({ cancelled: true }); return new Promise(() => {}) } })
  })
  const ctl: any = { aborted: false, onAbort: [] }
  const run = movement.travelXZ(bot, ctl, 0, 0, { range: 0, retries: 0, deadline })
  const initialGoal = bot.pathfinder.goal
  const tick = async (count = 1) => { for (let i = 0; i < count; i++) { timer.advanceTicks(1); bot.emit('physicsTick'); await new Promise(resolve => setImmediate(resolve)) } }
  const wet = () => { bot.entity.position = new Vec3(-190.54157934547777, 61, 7.5); bot.entity.isInWater = true }
  const close = async () => {
    ctl.aborted = true
    for (const fn of ctl.onAbort) fn()
    bot.pathfinder.setGoal(null)
    if (!cancelNever) await run
    timer.dispose(); clock.activate(null)
  }
  return { bot, ctl, timer, initialGoal, calls, goals, tick, wet, close, run }
}

test('CJ23 dry leg becoming wet with an empty executor hands off before the 8-second generic guard', async () => {
  const f = fixture()
  try {
    f.wet(); await f.tick(65)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].goal, null)
    assert.deepEqual(f.calls[0].listeners, [], 'owned path, physics listener and stuck timers are removed before swimming')
    await f.tick()
    assert.equal((await f.run).ok, true, 'successful dry exit resumes the same bounded destination even with retries=0')
  } finally { await f.close() }
})

for (const mode of ['dry', 'moving partial', 'mining', 'building', 'digging', 'using item', 'window', 'reached']) test(`${mode} does not hand control to the swimmer`, async () => {
  const f = fixture()
  try {
    if (mode !== 'dry') f.wet()
    if (mode === 'moving partial') f.bot.pathfinder.moving = true
    if (mode === 'mining') f.bot.pathfinder.mining = true
    if (mode === 'building') f.bot.pathfinder.building = true
    if (mode === 'digging') f.bot.targetDigBlock = {}
    if (mode === 'using item') f.bot.usingHeldItem = true
    if (mode === 'window') f.bot.currentWindow = {}
    if (mode === 'reached') { f.bot.entity.position = new Vec3(.5, 64, .5); f.bot.emit('goal_reached', f.initialGoal) }
    await f.tick(65)
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})

for (const mode of ['aborted', 'other goal', 'other tactical owner']) test(`${mode} between wet detection and continuation is preserved`, async () => {
  const f = fixture()
  try {
    f.wet(); f.bot.emit('physicsTick')
    const replacement = {}
    if (mode === 'aborted') f.ctl.aborted = true
    if (mode === 'other goal') f.bot.pathfinder.setGoal(replacement)
    if (mode === 'other tactical owner') f.bot._ndReflexSession = { bot: f.bot, _reflexState: { active: { owner: 'Tactical', ctl: {} } } }
    await f.tick()
    assert.equal(f.calls.length, 0)
    if (mode === 'other goal') assert.equal(f.bot.pathfinder.goal, replacement)
    if (mode === 'other tactical owner') assert.equal(f.bot.pathfinder.goal, f.initialGoal)
  } finally { await f.close() }
})

test('failed swimming preserves its physical refusal and does not claim arrival', async () => {
  const f = fixture({ swim: 'failed' })
  try {
    f.wet(); await f.tick(65)
    assert.equal(f.calls.length, 1)
    const r = await f.run
    assert.equal(r.ok, false)
    assert.equal(r.error, 'no connected dry bank')
  } finally { await f.close() }
})

test('the handoff retains the existing deadline and does not await a nonterminating cancel callback', async () => {
  const f = fixture({ swim: 'failed', deadline: 100, cancelNever: true })
  try {
    f.wet(); await f.tick(2)
    const swimmer = f.calls.find(c => c.options)
    assert.ok(swimmer)
    assert.equal(swimmer.options.timeoutMs, 50)
    assert.equal((await f.run).ok, false)
  } finally { await f.close() }
})

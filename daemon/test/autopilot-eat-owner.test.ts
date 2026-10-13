import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const { transformSync } = require('esbuild')
const Vec3 = require('vec3')
const { eat } = require('../src/actions')
const locks = require('../src/reflex-lock')
const clock = require('../src/game-clock')

function fixture(tacticsEnabled = true) {
  const file = path.join(__dirname, '../src/autopilot.js'), req = createRequire(file)
  const calls: string[] = [], events: string[] = []
  const source = transformSync(fs.readFileSync(file.replace(/\.js$/, '.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code
  const context: any = { module: { exports: {} }, process, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (name: string) => name === './combat' ? { ...req(name), retreat: async () => { calls.push('cover') } }
      : name === './combat-safety' ? { ...req(name), inspect: () => ({ action: 'recover', threshold: 12 }),
        disengage: async () => { calls.push('run') } } : req(name) }
  vm.runInNewContext(source, context)
  const bot: any = new EventEmitter()
  const sword = { name: 'stone_sword', type: 1, count: 1 }, food = { name: 'apple', type: 2, count: 10 }
  const table = { name: 'crafting_table', type: 3, count: 3 }
  const slots: any[] = []; slots[45] = table
  const enemy = { id: 2, name: 'skeleton', isValid: true, position: new Vec3(.5, 64, 10) }
  Object.assign(bot, { health: 16, food: 16, heldItem: sword, version: '1.21.11', registry: require('minecraft-data')('1.21.11'),
    entity: { position: new Vec3(.5, 64, .5), onGround: true }, entities: { 2: enemy }, nearestEntity: () => enemy,
    inventory: { slots, items: () => [sword, food, table].filter(i => i.count > 0) },
    pathfinder: { setGoal: () => {} }, clearControlStates: () => {}, stopDigging: () => {},
    equip: async (item: any, where: string) => { if (where === 'off-hand') slots[45] = item; else bot.heldItem = item },
    deactivateItem: () => { bot.usingHeldItem = false }, activateItem: () => { bot.usingHeldItem = true } })
  const session: any = { bot, eating: true, current: null, tactics: { enabled: () => tacticsEnabled, snapshot: () => ({ threatLevel: 0 }),
    update: () => calls.push('urgent') }, bus: { emit: (type: string) => events.push(type) },
    mcData: { foodsByName: { apple: { foodPoints: 4, saturation: 2.4 } } } }
  const auto = new context.module.exports.Autopilot(session, { lowHealth: 8 })
  return { auto, bot, session, calls, events, food }
}

test('idle flight does not release an immediate recovery bite while the tactical arbiter owns urgent decisions', async () => {
  const f = fixture(), gc = new clock.GameClock({ manual: true, epoch: 0 })
  clock.activate(gc)
  let biteAt: number | null = null, called = false
  f.bot.activateItem = () => { f.bot.usingHeldItem = true; biteAt = gc.ticks }
  locks.install(f.session)
  let finished = false
  const meal = eat(f.session).finally(() => { finished = true })
  try {
    for (let i = 0; i < 150 && !finished; i++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      gc.advanceTicks(1)
      if (biteAt !== null && !called) { called = true; await f.auto.fleeIfDying(f.bot) }
      if (biteAt !== null && f.bot.usingHeldItem && gc.ticks - biteAt >= 32) {
        f.food.count--; f.bot.food = 20; f.bot.usingHeldItem = false; biteAt = null
      }
    }
    const result = await meal
    assert.equal(result.ate, 'apple', JSON.stringify({ result, ticks: gc.ticks, biteAt, calls: f.calls, events: f.events }))
    assert.equal(result.spent, 1)
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.events, [])
  } finally { locks.cancel(f.session); gc.dispose(); clock.activate(null) }
})

test('idle flight still acts after the bite and in the legacy mode without tactical ownership', async () => {
  for (const enabled of [true, false]) {
    const f = fixture(enabled)
    if (enabled) f.session.eating = false
    await f.auto.fleeIfDying(f.bot)
    assert.deepEqual(f.calls, ['run', 'cover'])
    assert.deepEqual(f.events, ['fleeing'])
  }
})

test('an immediate bite does not suppress urgent tactical observations', async () => {
  const f = fixture()
  await f.auto.emergency(f.bot)
  assert.deepEqual(f.calls, ['urgent'])
})

test('Emergency retains the hands and cancels an immediate bite before its 32-tick completion', async () => {
  const f = fixture(), gc = new clock.GameClock({ manual: true, epoch: 0 })
  clock.activate(gc)
  let taken = false, finished = false
  f.bot.activateItem = () => {
    f.bot.usingHeldItem = true
    locks.emergency(f.session, () => { taken = locks.owner(f.session)?.owner === 'Emergency' }, 200)
  }
  locks.install(f.session)
  const meal = eat(f.session).finally(() => { finished = true })
  try {
    for (let i = 0; i < 150 && !finished; i++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      gc.advanceTicks(1)
    }
    assert.equal(taken, true)
    assert.equal((await meal).ate, null)
    assert.equal(f.food.count, 10)
    assert.equal(f.bot.usingHeldItem, false)
  } finally { locks.cancel(f.session); gc.dispose(); clock.activate(null) }
})

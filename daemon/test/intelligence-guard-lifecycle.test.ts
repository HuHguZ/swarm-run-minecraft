import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Vec3 } from 'vec3'
import { cjsContext } from './cjs-context'
import locks = require('../src/reflex-lock')
import { withClockFixture } from './clock-fixture'
import { bodySource } from './source-fixture'

interface Controller { aborted: boolean; onAbort: Array<() => void> }
interface Result { acted: boolean; cancelled?: boolean; how?: string }

function fixture() {
  const calls: string[] = []
  const logs: string[] = []
  const entity = { id: 1, position: new Vec3(.5, 64, .5), onGround: true }
  const hoglin = { id: 2, name: 'hoglin', position: new Vec3(2, 64, .5), height: 1.4, metadata: [] }
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(), entity, entities: { 1: entity, 2: hoglin },
    health: 20, food: 20, game: { dimension: 'the_nether' }, registry: { entitiesByName: {} },
    inventory: { slots: [], items: () => [{ name: 'netherrack', count: 8 }] },
    blockAt: (point: Vec3) => ({ name: 'air', boundingBox: 'empty', position: point }),
    lookAt: async () => { calls.push('look') }, attack: () => calls.push('attack'),
    clearControlStates: () => { calls.push('clear') }, pathfinder: { setGoal: () => {} }
  })
  const session = { bot }
  let resolveTower!: (value: { ok: boolean }) => void
  let started!: () => void
  const towerStarted = new Promise<void>(resolve => { started = resolve })
  const tower = new Promise<{ ok: boolean }>(resolve => { resolveTower = resolve })
  const context = withClockFixture({
    module: { exports: {} }, process, setTimeout, clearTimeout,
    console: { log: (...args: unknown[]) => logs.push(args.join(' ')) },
    require: (name: string) => {
      if (name === 'vec3') return { Vec3 }
      if (name === './reflex-lock') return locks
      if (name === './movement') return { sleep: async () => {} }
      if (name === './worlds') return { worldOf: () => bot.game.dimension }
      if (name === './sealed') return { fillerCount: () => 8, fillerName: () => 'netherrack' }
      if (name === './build') return { towerUp: () => { calls.push('tower'); started(); return tower } }
      // meleeFoes sees through the pick ray (no x-ray): the hoglin stands in plain sight here.
      if (name === './pick') return { aim: (_bot: unknown, e: { position: Vec3 }) => ({ point: e.position }), canHit: () => true }
      throw new Error('unexpected dependency: ' + name)
    }
  })
  // ne-guard — фасад + части (src/ne-guard/**) одной областью видимости.
  runInNewContext(bodySource(process.env.GUARD_TEST_SOURCE || join(__dirname, '../src/ne-guard.js')), cjsContext(context))
  const guard = context.module.exports as { react(targetSession: typeof session, ctl: Controller, options: unknown): Promise<Result> }
  return { bot, session, guard, hoglin, calls, logs, towerStarted, resolveTower }
}

test('death cancels a queued defensive lease before its action starts after respawn', async () => {
  const f = fixture()
  const pending = locks.start(f.session, async () => { f.calls.push('old action'); return { acted: true } })
  f.bot.health = 0; f.bot.emit('death'); f.bot.health = 20
  const result = await pending
  await Promise.resolve()
  assert.equal(result.cancelled, true)
  assert.equal(f.calls.includes('old action'), false)
  f.bot.emit('end')
})

test('an aborted defensive controller never starts a guard or reports survival at respawn health', async () => {
  const f = fixture()
  const result = await f.guard.react(f.session, { aborted: true, onAbort: [] }, { _owned: true, force: { e: f.hoglin } })
  assert.equal(result.cancelled, true)
  assert.equal(result.acted, false)
  assert.deepEqual(f.calls, [])
  assert.equal(f.logs.some(line => line.includes('ответ')), false)
  f.bot.emit('end')
})

test('a tower completion from the previous life cannot use the higher spawn position as escape success', async () => {
  const f = fixture()
  let work!: Promise<Result>
  const pending = locks.start(f.session, (ctl: Controller) => {
    work = f.guard.react(f.session, ctl, { _owned: true, force: { e: f.hoglin }, sitMs: 0 })
    return work
  })
  await f.towerStarted
  f.bot.health = 0; f.bot.emit('death')
  f.bot.health = 20; f.bot.entity.position = new Vec3(5, 77, 4); f.bot.game.dimension = 'overworld'
  f.resolveTower({ ok: true })
  assert.equal((await pending).cancelled, true)
  const stale = await work
  assert.equal(stale.cancelled, true)
  assert.equal(stale.acted, false)
  assert.equal(f.logs.some(line => line.includes('ответ')), false)
  f.bot.emit('end')
})

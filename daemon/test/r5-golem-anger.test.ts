'use strict'
import { bodySource } from './source-fixture'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import path = require('node:path')
import * as vm from 'node:vm'
import { withClockFixture } from './clock-fixture'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

function fixture (rememberAnger, canAim = false, fill = 64) {
  const clock: Record<string, any> = { t: 1000 }; const digs = []
  const bot: any = new EventEmitter()
  const golem = { id: 2, name: 'iron_golem', position: new Vec3(2.5, 64, .5) }
  bot.entity = { position: new Vec3(.5, 67, .5) }
  bot.entities = { 2: golem }; bot.health = 20
  bot.inventory = { items: () => [{ name: 'cobblestone', count: fill }, { name: 'stone_axe', count: 1 }] }
  bot.pathfinder = { setGoal () {} }
  bot.equip = async i => { bot.heldItem = i }
  bot.lookAt = async () => {}; bot.attack = () => {}
  bot.blockAt = p => ({ name: p.y <= 63 || (p.x === 0 && p.z === 0 && p.y <= 66) ? 'stone' : 'air',
    boundingBox: p.y <= 63 || (p.x === 0 && p.z === 0 && p.y <= 66) ? 'block' : 'empty' })
  const session: Record<string, any> = { bot }
  if (rememberAnger) session._golemAngry = new WeakSet([golem])
  class Time extends Date { static now () { return clock.t } }
  const filename = path.resolve(__dirname, '../src/fauna.js')
  const local = createRequire(filename)
  const ctx = { module: { exports: {} as Record<string, any> }, process, Date: Time, console,
    require: name => name === './pick' ? { aim: () => canAim ? { point: golem.position } : null }
      : name === './build' ? { towerUp: async () => { bot.entity.position.y++; return { placed: 1 } }, pickFiller () {} }
      : local(name),
    advance: async ms => { clock.t += ms },
    descend: async () => { digs.push('descend'); bot.entity.position.y = 64 },
    approachFixture: async () => false }
  vm.runInNewContext(bodySource(filename) + `
    sleep = advance; visible = () => true; descendPillar = descend; approach = approachFixture;
  `, cjsContext(withClockFixture(ctx)))
  return { session, golem, digs, run: () => ctx.module.exports.golemKill(session, { aborted: false, onAbort: [] }, { timeoutSeconds: 20 }) }
}
test('retry with zero new hits never descends to a previously attacked live golem', async () => {
  const f = fixture(true); const r = await f.run()
  assert.equal(r.hits, 0); assert.equal(r.killed, false)
  assert.equal(f.digs.length, 0)
  assert.equal(f.session.bot.entity.position.y, 67)
})
test('explicit anger disable restores the former retry descent', async () => {
  const previous = process.env.ND_GOLEM_ANGER
  try {
    process.env.ND_GOLEM_ANGER = '0'
    const f = fixture(true); await f.run()
    assert.ok(f.digs.length > 0)
  } finally {
    if (previous === undefined) delete process.env.ND_GOLEM_ANGER
    else process.env.ND_GOLEM_ANGER = previous
  }
})
test('actual attack remembers anger for a later RPC on the same entity', async () => {
  const f = fixture(false, true); const r = await f.run()
  assert.ok(r.hits > 0)
  assert.ok(f.session._golemAngry?.has(f.golem))
})
test('an untouched neutral golem still permits a normal pillar exit', async () => {
  const f = fixture(false); await f.run()
  assert.ok(f.digs.length > 0)
})

test('an existing supported perch permits defensive hits without new filler blocks', async () => {
  const f = fixture(true, true, 0); const r = await f.run()
  assert.ok(r.hits > 0, 'no building material is needed for the existing perch')
  assert.equal(f.digs.length, 0)
  assert.equal(f.session.bot.entity.position.y, 67)
})

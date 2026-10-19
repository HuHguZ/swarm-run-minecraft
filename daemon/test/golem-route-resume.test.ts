'use strict'
import { cjsContext } from './cjs-context'
import { bodySource } from './source-fixture'
import test = require('node:test')
import assert = require('node:assert/strict')
import path = require('node:path')
import * as vm from 'node:vm'
import { createRequire } from 'node:module'
const filename = path.resolve(__dirname, '../src/campaign/overworld-route.js')
// Маршрут целиком (фасад и части overworld-route/) одной областью — require настоящий, от файла маршрута.
const source = bodySource(filename)
const box = { module: { exports: {} as Record<string, any> }, require: createRequire(filename) }
vm.runInNewContext(source, cjsContext(box))

function fixture () {
  let fill = 8, mode = 'injury', escape = false, pursuing = false, arrived = true
  const calls = []
  const interrupted = Object.assign(new Error('STRATEGY_INTERRUPTED'), { strategyInterrupted: true })
  const ctx: any = {
    state: { health: 20, food: 17, pos: { x: 68, y: 72, z: 56 } }, process: { env: {} }, sit: { surface: true }, died: false,
    refresh: async () => {}, sense: async () => {}, rlog () {}, have: () => 0, foodUnits: () => 0,
    routeGo: async () => { calls.push('routeGo'); return true }, fillerCount: () => fill, routeInfoGet: () => null,
    routeBlocks: async () => { calls.push('mine supports'); ctx.state.pos.y = 65 }, routeFood: async () => {},
    act: async (name, p) => {
      calls.push(name)
      if (name === 'goto' && p.retreat) {
        if (!escape) throw interrupted
        if (arrived) ctx.state.pos = { ...ctx.state.pos, x: p.x, z: p.z }
        return { status: 'done', detail: { arrived: ctx.state.pos } }
      }
      if (name === 'observe') return { detail: { entities: pursuing ? [{ name: 'Iron Golem', dist: 3, pos: { ...ctx.state.pos } }] : [] } }
      if (name === 'golem') {
        if (mode === 'injury') { ctx.state.health = 10; return { detail: { hits: 1, hpLost: 10, killed: false } } }
        return { detail: mode === 'noSpot' ? { hits: 0, killed: false, noSpot: true }
          : mode === 'angryNoSpot' ? { hits: 1, killed: false, noSpot: true }
          : mode === 'missing' ? { hits: 0, killed: false, stopped: 'голема не вижу в 64 бл.' }
          : { hits: 0, killed: mode === 'killed' } }
      }
      return { detail: {} }
    }
  }
  const route = box.module.exports.createOverworldRoute(ctx)
  const village = { kind: 'village', at: { x: 100, z: 60 } }
  return { ctx, calls, interrupted, run: () => route.routeStep(village), next: value => { calls.length = 0; fill = 1; mode = value },
    escape: (follow = false, moved = true) => { escape = true; pursuing = follow; arrived = moved } }
}

test('a retreat interrupted after an actual golem hit resumes defense before walking or mining the perch', async () => {
  const f = fixture()
  await assert.rejects(f.run(), e => e === f.interrupted)
  f.next('live')
  await assert.rejects(f.run(), e => e === f.interrupted)
  assert.deepEqual(f.calls, ['golem', 'goto'], 'only defense and its interrupted retreat, no routeGo or filler mine')
  assert.equal(f.ctx.state.pos.y, 72)
  // A retry with zero new hits retains the original encounter.
  f.next('live'); await assert.rejects(f.run(), e => e === f.interrupted); assert.deepEqual(f.calls, ['golem', 'goto'])
})

test('a killed golem releases the remembered encounter', async () => {
  const f = fixture(); await assert.rejects(f.run())
  f.next('killed'); await f.run()
  assert.equal(f.calls[0], 'golem'); assert.ok(f.calls.includes('routeGo'))
})

test('zero new defensive hits can end in an actual observed escape before continuing the route', async () => {
  const f = fixture(); await assert.rejects(f.run())
  f.next('live'); f.escape()
  await f.run()
  assert.deepEqual(f.calls.slice(0, 4), ['golem', 'goto', 'observe', 'routeGo'])
})

test('a retreat receipt without physical arrival does not release the actual encounter', async () => {
  const f = fixture(); await assert.rejects(f.run())
  f.next('live'); f.escape(false, false)
  assert.equal(await f.run(), false)
  assert.deepEqual(f.calls, ['golem', 'goto'])
})

test('a visibly pursuing golem keeps the encounter even after a large completed displacement', async () => {
  const f = fixture(); await assert.rejects(f.run())
  f.next('live'); f.ctx.state.pos.x += 80; f.escape(true)
  assert.equal(await f.run(), false)
  assert.deepEqual(f.calls, ['golem', 'goto', 'observe'])
})

test('a neutral golem with no confirmed hit never creates a pending encounter', async () => {
  const f = fixture(); f.next('killed'); await f.run()
  f.calls.length = 0; await f.run(); assert.equal(f.calls[0], 'routeGo')
})

test('a physically blocked neutral perch switches to village resources after its first receipt', async () => {
  const f = fixture(); f.next('noSpot')
  f.ctx.fillerCount = () => 8
  f.ctx.routeFood = async () => { f.calls.push('food') }
  await f.run()
  assert.equal(f.calls.filter(x => x === 'golem').length, 1, 'no identical golem retries before another observation or move')
  assert.ok(f.calls.indexOf('structure') > f.calls.indexOf('golem'), 'the existing village exploration remains available')
  assert.ok(f.calls.includes('food'))
  // New view/route calls may try the pillar again: this receipt is not a permanent village ban.
  f.ctx.state.pos.x += 8; f.calls.length = 0
  await f.run()
  assert.equal(f.calls.filter(x => x === 'golem').length, 1)
})

test('a blocked perch receipt after an actual hit retains defense and physical retreat', async () => {
  const f = fixture(); f.next('angryNoSpot'); f.ctx.fillerCount = () => 8; f.escape()
  await f.run()
  assert.equal(f.calls.filter(x => x === 'golem').length, 5)
  assert.ok(f.calls.indexOf('goto') > f.calls.indexOf('golem'))
  assert.ok(f.calls.indexOf('observe') > f.calls.indexOf('goto'))
})

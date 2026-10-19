import { campaignTs } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { transformSync } from 'esbuild'
const source = campaignTs()
const start = source.indexOf('function netherFoodNeed (')
const fn = source.slice(start, source.indexOf('\n}', start) + 2)

function need ({ night = true, surface = true, far = 10, env = {} as any } = {}) {
  const ctx: any = { sit: { night, surface }, known: { portal: { x: 0, y: 64, z: 0 } }, portalFar: () => far, rodsNow: () => 0, process: { env } }
  vm.runInNewContext(transformSync(fn + '\nthis.f=netherFoodNeed', { loader: 'ts' }).code, cjsContext(ctx))
  return ctx.f()
}

test('fp1-s13-1: night at a lit portal on the surface needs 3 meals, not 6', () => {
  assert.equal(need(), 3)
  assert.equal(need({ surface: false }), 3)
  assert.equal(need({ night: false }), 6, 'day: the old reserve')
  assert.equal(need({ far: 80 }), 6, 'portal far: the old reserve')
  assert.equal(need({ env: { ND_NIGHT_PORTAL_SURFACE: '0' } }), 6, 'switch off: only from below')
})

test('kd2-7-102: five cooked porkchops are 40 nutrition = 6.67 meals, enough for the 6-meal Nether reserve', () => {
  const line = source.slice(source.indexOf('const netherFoodHave ='), source.indexOf('\n', source.indexOf('const netherFoodHave =')))
  const { foodUnits, foodPoints }: typeof import('../src/play-policy') = require('../src/play-policy')
  const run = (inventory: any, env: any = {}) => {
    const ctx: any = { state: { inventory }, process: { env }, pointsOfFood: foodPoints, foodUnits: () => foodUnits(inventory) }
    vm.runInNewContext(transformSync(line + '\nthis.f=netherFoodHave', { loader: 'ts' }).code, cjsContext(ctx))
    return ctx.f()
  }
  assert.equal(run({ cooked_porkchop: 5 }), 6.67)
  assert.equal(run({ cooked_porkchop: 5 }, { ND_NETHER_FOOD_POINTS: '0' }), 5, 'switch off: count of items')
  assert.equal(run({ bread: 6 }), 5, 'small food is not inflated: bread 5 nutrition')
  assert.equal(run({ porkchop: 4 }), 4, 'raw meat keeps its cooking credit')
})

test('kc6-fp1-s16-1-kit-202: with lava near and the kit ready, the daytime food search waits for the cast', () => {
  const at = source.indexOf('const castFirst =')
  const line = source.slice(at, source.indexOf('\n', at))
  const run = (ctx: any) => { vm.runInNewContext(transformSync(line + '\nthis.f=castFirst', { loader: 'ts' }).code, cjsContext(ctx)); return ctx.f }
  const base = { process: { env: {} }, known: {}, castNear: () => true, state: { food: 9 } }
  assert.equal(run({ ...base }), true)
  assert.equal(run({ ...base, state: { food: 6 } }), false, 'hunger 6: no sprint — food first')
  assert.equal(run({ ...base, known: { portal: {} } }), false, 'portal already lit')
  assert.equal(run({ ...base, castNear: () => false }), false, 'lava not near')
  assert.equal(run({ ...base, process: { env: { ND_CAST_BEFORE_FOOD: '0' } } }), false, 'switch off')
})

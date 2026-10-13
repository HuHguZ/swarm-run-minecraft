import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const esbuild = require('esbuild')

function sourceModule(name: string, overrides: Record<string, unknown> = {}) {
  const file = path.resolve(__dirname, '../src', name + '.ts'), local = createRequire(file)
  const module = { exports: {} as any }
  const code = esbuild.transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext(require('node:module').wrap(code), { filename: file })(module.exports,
    (id: string) => id in overrides ? overrides[id] : local(id), module, file, path.dirname(file))
  return module.exports
}
const progress = sourceModule('tactics/escape-progress')
const { TacticalSystem } = sourceModule('tactics/minecraft', { './escape-progress': progress })

// CG23 native Flee62/64: both returned chased=true; a normal +1Y step hid the first failure.
const native = [
  [{ x: 276.45181402051105, y: 63, z: -241.64029644917014 }, 9.148674929613144,
    { x: 294.56097253251545, y: 64, z: -241.80935557942186 }, 4.70058878202854],
  [{ x: 293.9379706019021, y: 64, z: -241.17549733063305 }, 4.451049256457287,
    { x: 283.4895046837731, y: 63, z: -242.70351457365345 }, 4.678211361063786]
] as const

function replay({ action = 'Flee', rows = native, results = ['completed', 'completed'], details = [{ chased: true }, { chased: true }] }: any = {}) {
  let state: any
  const session: any = { bot: { entity: { position: null }, health: 3 }, bus: { emit() {} } }
  const system: any = new TacticalSystem(session, { observe: () => state, record() {} })
  const set = (position: any, distance: number) => {
    session.bot.entity.position = position
    state = { at: 1000, health: 3, food: 9, armor: 0, weapon: true, shield: true, blocks: 3,
      enemies: [{ id: 1, kind: 'zombie', distance, threatening: true, player: false }],
      escapeRoute: true, cover: false, shelter: null, water: true, edible: false, canFight: false, contact: true,
      lava: false, burning: false, fireResistance: false, dangerousFall: false, inWater: false,
      explosion: false, incomingProjectiles: 0, emergencyController: false, protectedEncounter: false }
    return system.escapeObservation(state)
  }
  const observed = []
  for (const [index, [before, d0, after, d1]] of rows.entries()) {
    const start = set(before, d0)
    system.escapes.observe(start); system.escapes.begin(action, start)
    const end = set(after, d1)
    system.finish({ action: { id: action }, hp: 3, at: 1000, level: 3, state: {}, candidates: [] }, results[index], details[index])
    observed.push(system.escapes.observe(end))
  }
  return observed
}

test('actual TacticalSystem.finish preserves both failed native chases despite the first +1Y step', () => {
  const result = replay()
  assert.equal(result[0].exhausted, false)
  assert.equal(result[1].exhausted, true)
})

for (const result of ['interrupted', 'preempted']) test(`${result} movement does not become a failed chase from partial detail`, () => {
  assert.equal(replay({ results: [result, 'completed'] })[1].exhausted, false)
})

const ascent = native.map(([before, d0, after]) => [before, d0, { ...after, y: before.y + 3 }, d0 + 10])
test('actual safe one-block step and higher ascent still reset pursuit failures', () => {
  for (const rise of [1, 3]) {
    const safe = native.map(([before, d0, after]) => [before, d0, { ...after, y: before.y + rise }, d0 + 10])
    assert.equal(replay({ rows: safe, details: [{ safe: true }, { safe: true }] })[1].exhausted, false)
  }
})

test('ordinary ascent without explicit failure and unrelated enemy health keep the existing geometric result', () => {
  assert.equal(replay({ details: [{ player: true, health: 0 }, { enderman: true, health: 0 }] })[1].exhausted, false)
  assert.equal(replay({ details: [{ chased: 'true' }, { chased: 'true' }] })[1].exhausted, false)
})

test('a chase flag cannot turn supported pillar ascent into failed fleeing', () => {
  assert.equal(replay({ action: 'PillarUp', rows: ascent })[1].exhausted, false)
})

test('legacy observed failed pursuits still count without a receipt', () => {
  const flat = native.map(([before, d0, after, d1]) => [before, d0, { ...after, y: before.y }, d1])
  assert.equal(replay({ rows: flat, details: [null, null] })[1].exhausted, true)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

// Лут построек ценой (пользователь 14.10): campaign.lootSeenStructures на заглушках тела.
function fixture ({ known = [], bag = {} as Record<string, number>, portal = null as any, explore = { status: 'done', detail: { done: true } } }: any = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
  const fn = source.slice(source.indexOf('// Постройки на виду — лут ценой'), source.indexOf('async function surfaceLavaSurvey'))
  const calls: any[] = []
  const lines: string[] = []
  const facts: Record<string, any> = {}
  const context: any = { module: { exports: {} }, require, path, __dirname: path.join(__dirname, '..'), process: { env: {} },
    state: { pos: { x: 0, y: 64, z: 0 }, inventory: { ...bag } }, known: { portal }, died: false, BEDS_END: 5, PICK_IRON: /^(iron|diamond|netherite)_pickaxe$/,
    gameClock: { now: () => 0 }, dim: () => 'overworld', goldOn: () => false, shieldOn: () => false, lighter: () => !!(bag.flint_and_steel || bag.fire_charge),
    foodUnits: () => bag.bread || 0, have: re => Object.entries(context.state.inventory).filter(([k]) => typeof re === 'string' ? re === k : re.test(k)).reduce((n, [, v]: any) => n + v, 0),
    refresh: async () => {}, craft: async () => {}, log: (s: string) => lines.push(s), graphFact: (k, v) => { facts[k] = v },
    sense: async () => {}, sit: { inWater: false },
    goToward: async (p) => { calls.push({ method: 'goToward', params: p }); context.state.pos = { x: p.x, y: 64, z: p.z }; return true },
    act: async (method, params) => {
      calls.push({ method, params })
      if (method === 'structure' && params.mode === 'list') return { detail: { known } }
      // Заход взял постройку целиком (explore done) — только такой закрывает ресурс в графе.
      if (method === 'structure' && params.mode === 'explore') { context.state.inventory.flint_and_steel = 1; return explore }
      return { detail: {} }
    } }
  vm.runInNewContext(transformSync(`${fn}\nmodule.exports = lootSeenStructures`, { loader: 'ts', format: 'cjs' }).code, context)
  return { calls, lines, facts, sit: context.sit, run: context.module.exports }
}

const ruins = { kind: 'ruined_portal', name: 'руины портала', at: { x: 50, y: 64, z: 0 }, done: false }

test('seen ruins without a lighter are looted, with the price in the log', async () => {
  const f = fixture({ known: [ruins] })
  assert.equal(await f.run(), true)
  const explore = f.calls.find(c => c.params?.mode === 'explore')
  assert.equal(explore.params.kind, 'ruined_portal')
  assert.ok(f.lines.some(l => /руины портала в 50 бл\.: путь ≈ \d+ с .*выгода ≈ \d+ с .* — иду/.test(l)), f.lines.join('\n'))
  assert.ok(f.lines.some(l => /взял flint_and_steel\+1/.test(l)), f.lines.join('\n'))
})

test('a structure not worth its walk is passed by, and an opened one is not reconsidered', async () => {
  const far = fixture({ known: [{ ...ruins, at: { x: 150, y: 64, z: 0 } }], bag: { flint_and_steel: 1, iron_ingot: 20, bread: 8, golden_boots: 1 }, portal: { x: 0, z: 0 } })
  assert.equal(await far.run(), false)
  assert.ok(far.lines.some(l => /— мимо/.test(l)))
  assert.ok(!far.calls.some(c => c.params?.mode === 'explore'))
  const opened = fixture({ known: [{ ...ruins, done: true }] })
  assert.equal(await opened.run(), false)
  assert.ok(!opened.calls.some(c => c.params?.mode === 'explore'))
})

test('a visit that would end after the dusk carries the night price in the log', async () => {
  const day = fixture({ known: [ruins] })
  await day.run()
  const dusk = fixture({ known: [ruins] })
  dusk.sit.tod = 11700 // 7 s to the dusk
  await dusk.run()
  const net = (lines: string[]) => Number((/→ ([+-]?\d+) с/.exec(lines.find(l => /руины портала в 50/.test(l)) || '') || [])[1])
  assert.ok(dusk.lines.some(l => /ночь на исходе захода −\d+ с/.test(l)), dusk.lines.join('\n'))
  assert.ok(net(dusk.lines) < net(day.lines), `${net(dusk.lines)} < ${net(day.lines)}`)
})

test('gold for the boots makes far ruins worth the walk; with a golden piece in the bag they are passed by', async () => {
  const at = { ...ruins, at: { x: 150, y: 64, z: 0 } }
  const bag = { flint_and_steel: 1, iron_ingot: 20, bread: 8 }
  const want = fixture({ known: [at], bag: { ...bag }, portal: { x: 0, z: 0 } })
  assert.equal(await want.run(), true)
  assert.ok(want.lines.some(l => /gold 0\.93: \d+ с/.test(l) && /— иду/.test(l)), want.lines.join('\n'))
  const dressed = fixture({ known: [at], bag: { ...bag, golden_helmet: 1 }, portal: { x: 0, z: 0 } })
  assert.equal(await dressed.run(), false)
})

test('a looted village is reported to the graph as exhausted', async () => {
  const f = fixture({ known: [{ kind: 'village', name: 'деревня', at: { x: 15, y: 64, z: 0 }, done: false }] })
  await f.run()
  assert.equal(f.facts.village_exhausted, true)
})

test('an interrupted or partial visit does not close the resource in the graph', async () => {
  for (const explore of [{ status: 'interrupted', detail: {} }, { status: 'done', detail: { done: false } }]) {
    const f = fixture({ known: [{ kind: 'village', name: 'деревня', at: { x: 15, y: 64, z: 0 }, done: false }], explore })
    await f.run()
    assert.equal(f.facts.village_exhausted, undefined, JSON.stringify(explore))
  }
})

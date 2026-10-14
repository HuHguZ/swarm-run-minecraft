import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

// Сундук руин портала рядом — до Ада (агент Ада 14.10: без золотой вещи пиглины враждебны).
function fixture ({ gold = false, done = false, at = { x: 20, z: 0 }, loot = 'golden_boots' }: any = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
  const fn = source.slice(source.indexOf('async function ruinsChestNear'), source.indexOf('async function surfaceLavaSurvey'))
  const calls: any[] = []
  const bag: Record<string, number> = {}
  const context: any = { module: { exports: {} }, state: { pos: { x: 0, y: 64, z: 0 } }, died: false,
    dim: () => 'overworld', goldOn: () => gold, have: re => Object.entries(bag).filter(([k]) => (typeof re === 'string' ? re === k : re.test(k))).reduce((n, [, v]) => n + v, 0),
    refresh: async () => {}, log() {}, craft: async () => {},
    act: async (method, params) => {
      calls.push({ method, params })
      if (method === 'structure' && params.mode === 'list') return { detail: { known: [{ kind: 'ruined_portal', at: { ...at, y: 64 }, done }] } }
      if (method === 'structure' && params.mode === 'explore') { bag[loot] = 1; return { detail: { took: { [loot]: 1 } } } }
      if (method === 'armor') gold = true
      return { detail: {} }
    } }
  vm.runInNewContext(transformSync(`${fn}\nmodule.exports = ruinsChestNear`, { loader: 'ts', format: 'cjs' }).code, context)
  return { calls, run: context.module.exports }
}

test('ruins in reach are looted before the Nether and their golden armour is put on', async () => {
  const f = fixture()
  await f.run(32)
  const explore = f.calls.find(c => c.method === 'structure' && c.params.mode === 'explore')
  assert.ok(explore, JSON.stringify(f.calls))
  assert.equal(explore.params.kind, 'ruined_portal')
  assert.ok(f.calls.some(c => c.method === 'armor'))
})

test('no detour for the ruins chest with gold already on, ruins already opened or too far', async () => {
  for (const f of [fixture({ gold: true }), fixture({ done: true }), fixture({ at: { x: 60, z: 0 } })]) {
    await f.run(32)
    assert.ok(!f.calls.some(c => c.params && c.params.mode === 'explore'), JSON.stringify(f.calls))
  }
})

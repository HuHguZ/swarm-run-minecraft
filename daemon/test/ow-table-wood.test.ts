import { campaignTs } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
const source = campaignTs()
const start = source.indexOf('async function ensureTable (')
const ensureTable = source.slice(start, source.indexOf('\n}', start) + 2)

// owC9-07: 2 доски, ни бревна, верстака нет — 19 игр. мин набор/кирка «НЕ ГОТОВ».
async function run (env: Record<string, string>) {
  const inv: Record<string, number> = { oak_planks: 2, cobblestone: 227, iron_ingot: 3 }
  const calls: string[] = []
  const have = re => Object.entries(inv).reduce((n, [k, v]) => n + ((typeof re === 'string' ? k === re : re.test(k)) ? v : 0), 0)
  const ctx: any = { process: { env }, state: { health: 20 }, died: false, strategyInterrupted: false, LOGS: /_(log|stem)$/, have,
    dim: () => 'overworld', refresh: async () => {}, sleep: async () => {}, planksFor: () => have(/_log$/) ? 'oak_planks' : null,
    lumber: async () => { calls.push('lumber'); inv.oak_log = 1 },
    act: async (m, p) => {
      calls.push(`${m}:${p.item || p.block}`)
      if (m === 'craft' && p.item === 'oak_planks' && inv.oak_log) { inv.oak_log--; inv.oak_planks += 4 }
      if (m === 'craft' && p.item === 'crafting_table' && inv.oak_planks >= 4) { inv.oak_planks -= 4; inv.crafting_table = 1 }
      return { status: m === 'mine' ? 'failed' : 'done' }
    } }
  vm.runInNewContext(transformSync(ensureTable + '\nthis.ensureTable=ensureTable', { loader: 'ts' }).code, ctx)
  return { ok: await ctx.ensureTable(), calls }
}

test('ND_OW_TABLE_WOOD: no planks for a table and no logs — one log, then the table; off keeps the old refusal', async () => {
  const on = await run({ ND_OW_TABLE_WOOD: '1' })
  assert.equal(on.ok, true)
  assert.deepEqual(on.calls.filter(c => c !== 'mine:crafting_table'), ['lumber', 'craft:oak_planks', 'craft:crafting_table'])
  const off = await run({})
  assert.equal(off.ok, false)
  assert.equal(off.calls.includes('lumber'), false)
})

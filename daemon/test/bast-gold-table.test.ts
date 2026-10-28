// Поток bast 27.10: ND_BAST_GOLD_ON (nether-trip.goldUp — золото рюкзака в ботинки) и ND_BAST_TABLE_BACK (kit.ensureTable — свой
// брошенный верстак вместо отказа, когда досок нет).
import { campaignTs } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
const source = campaignTs()
const fn = (name: string) => { const start = source.indexOf(`async function ${name} (`); return source.slice(start, source.indexOf('\n}', start) + 2) }

function bag (inv: Record<string, number>) {
  return (re: string | RegExp) => Object.entries(inv).reduce((n, [k, v]) => n + ((typeof re === 'string' ? k === re : re.test(k)) ? v : 0), 0)
}

test('goldUp: 43 самородка → 4 слитка → ботинки; блок — 9 слитков; надетое — ничего не делает', async () => {
  const run = async (inv: Record<string, number>, worn = false) => {
    const calls: string[] = []
    const ctx: any = { have: bag(inv), refresh: async () => {}, goldOn: () => worn,
      craft: async (item: string, n: number) => {
        calls.push(`${item}:${n}`)
        if (item === 'gold_ingot' && inv.gold_nugget >= 9 * n) { inv.gold_nugget -= 9 * n; inv.gold_ingot = (inv.gold_ingot || 0) + n }
        if (item === 'gold_ingot' && inv.gold_block && n === 9) { inv.gold_block--; inv.gold_ingot = (inv.gold_ingot || 0) + 9 }
        return true
      },
      wearGold: async () => { calls.push('wear'); worn = true } }
    vm.runInNewContext(transformSync(fn('goldUp') + '\nthis.goldUp=goldUp', { loader: 'ts' }).code, ctx)
    return { ok: await ctx.goldUp(), calls }
  }
  assert.deepEqual(await run({ gold_nugget: 43 }), { ok: true, calls: ['gold_ingot:4', 'wear'] })
  assert.deepEqual(await run({ gold_block: 3 }), { ok: true, calls: ['gold_ingot:9', 'wear'] })
  assert.deepEqual(await run({ gold_nugget: 30 }), { ok: false, calls: ['gold_ingot:3'] })
  assert.deepEqual(await run({ gold_ingot: 9 }, true), { ok: true, calls: [] })
})

test('ND_BAST_TABLE_BACK: досок нет — сперва свой брошенный верстак (craft ownTableBack); без флага — прежний отказ', async () => {
  const run = async (env: Record<string, string>) => {
    const inv: Record<string, number> = { oak_planks: 1, cobblestone: 100, stick: 2 }
    const calls: string[] = []
    const ctx: any = { process: { env }, state: { health: 20 }, died: false, strategyInterrupted: false, LOGS: /_(log|stem)$/, have: bag(inv),
      dim: () => 'the_nether', refresh: async () => {}, sleep: async () => {}, planksFor: () => null, lumber: async () => {},
      act: async (m: string, p: any) => {
        calls.push(`${m}:${p.item || p.block}${p.ownTableBack ? ':back' : ''}`)
        if (m === 'craft' && p.ownTableBack) inv.crafting_table = 1
        return { status: m === 'mine' ? 'failed' : 'done' }
      } }
    vm.runInNewContext(transformSync(fn('ensureTable') + '\nthis.ensureTable=ensureTable', { loader: 'ts' }).code, ctx)
    return { ok: await ctx.ensureTable(), calls }
  }
  const on = await run({ ND_BAST_TABLE_BACK: '1' })
  assert.equal(on.ok, true)
  assert.ok(on.calls.includes('craft:crafting_table:back'))
  const off = await run({})
  assert.equal(off.ok, false)
  assert.equal(off.calls.some(c => c.endsWith(':back')), false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { declarationsOf } from './source-fixture'
import { campaignTs } from './campaign-source'
import { cjsContext } from './cjs-context'

// ND_OW_FLINT_BELOW (ow 27.10): кремень под землёй — видимый гравий и короткие штреки, без подъёма к разведке поверху.
const code = transformSync(declarationsOf(campaignTs(), 'flintSearchSeen', 'flintSearchViews', 'flintBelow', 'ensureFlint'), { loader: 'ts' }).code

function run (env: Record<string, string>, gravelAfterLegs: number) {
  const inventory: Record<string, number> = { iron_ingot: 1 }
  const calls: string[] = []
  let legs = 0
  const ctx: any = cjsContext({
    process: { env }, state: { inventory, pos: { x: 0, y: 15, z: 0 } }, sit: { surface: false }, died: false, strategyInterrupted: false,
    known: {}, gameClock: { now: () => 0 }, log () {}, graphFact () {}, portalFar: () => 0,
    have: (re: any) => Object.entries(inventory).reduce((n, [k, v]) => n + ((typeof re === 'string' ? k === re : re.test(k)) ? v : 0), 0),
    dim: () => 'overworld', y: () => 15, refresh: async () => {}, sense: async () => {},
    craft: async (item: string) => { if (item === 'flint_and_steel') { inventory.flint--; inventory.iron_ingot--; inventory.flint_and_steel = 1 } },
    act: async (method: string, p: any) => {
      calls.push(`${method}:${p.block || p.direction || ''}`)
      if (method === 'tunnel') legs++
      if (method === 'mine' && p.block === 'gravel' && legs >= gravelAfterLegs) inventory.gravel = (inventory.gravel || 0) + 2
      if (method === 'flint_grind' && inventory.gravel) inventory.flint = 1
      return { status: 'done', detail: {} }
    }
  })
  vm.createContext(ctx)
  vm.runInContext(code + '\nthis.ensureFlint = ensureFlint', ctx)
  return { ctx, calls, inventory }
}

test('ND_OW_FLINT_BELOW: underground gravel comes from a fresh-rock leg, no surface search', async () => {
  const f = run({ ND_OW_FLINT_BELOW: '1' }, 2)
  assert.equal(await f.ctx.ensureFlint(), true)
  assert.deepEqual(f.calls.filter(c => c.startsWith('tunnel')), ['tunnel:north', 'tunnel:east'])
  assert.ok(!f.calls.some(c => c.startsWith('explore')), f.calls.join(' '))
  assert.equal(f.inventory.flint_and_steel, 1)
})

test('without the flag the same body goes to the surface search', async () => {
  const f = run({}, 99)
  await f.ctx.ensureFlint()
  assert.ok(f.calls.some(c => c.startsWith('explore')), f.calls.join(' '))
  assert.ok(!f.calls.some(c => c.startsWith('tunnel')))
})

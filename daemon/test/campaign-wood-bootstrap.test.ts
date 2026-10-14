import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { functionSource } from './source-fixture'

const campaign = path.join(__dirname, '../campaign.js')
function fixture() {
  const source = fs.readFileSync(process.env.WOOD_BOOTSTRAP_SOURCE || campaign, 'utf8')
  const wood = source.slice(source.indexOf('let woodRoofed ='), source.indexOf("defStage(\"stone\""))
  const inventory: Record<string, number> = {}, calls: any[] = [], stages: any[] = []
  const have = re => Object.entries(inventory).reduce((n, [name, count]) => n + ((typeof re === 'string' ? name === re : re.test(name)) ? count : 0), 0)
  const context: any = { process: { env: {} }, STAGES: stages, inventory, known: {}, died: false, state: {},
    sit: { surface: true, night: false }, LOGS: /_(log|stem)$/, have,
    woodNow: () => have(/_log$/) + Math.floor(have(/_planks$/) / 4),
    defStage: (name, _needed, run) => stages.push({ name, run }), planksFor: () => 'oak_planks',
    sense: async () => {}, nightGuard: async () => {}, recoverGuard: async () => {}, refresh: async () => {},
    log() {}, act: async (method, params) => { calls.push({ method, params }); if (method === 'mine') inventory.oak_log = (inventory.oak_log || 0) + params.count; return { status: 'done', detail: { dug: params.count || 0 } } },
    craft: async (item, count = 1) => {
      if (item === 'oak_planks') { inventory.oak_log -= Math.ceil(count / 4); inventory.oak_planks = (inventory.oak_planks || 0) + Math.ceil(count / 4) * 4 }
      else { inventory.oak_planks -= item === 'crafting_table' ? 4 : 3; inventory[item] = 1; if (item === 'wooden_pickaxe') inventory.stick -= 2 }
    }, sticks: async count => { inventory.oak_planks -= Math.ceil(count / 4) * 2; inventory.stick = Math.ceil(count / 4) * 4 },
    strategyExecuting: false, strategyInterrupted: false }
  assert.ok(wood.startsWith('let woodRoofed =') && wood.includes('defStage'), 'actual wood actor source must be captured')
  vm.runInNewContext(transformSync(wood, { loader: 'js', format: 'cjs' }).code, context)
  vm.runInNewContext(functionSource(process.env.WOOD_BOOTSTRAP_SOURCE || campaign, 'executeStrategy') + ';this.execute=executeStrategy', context)
  return { context, calls, inventory, wood: stages[0].run }
}

test('AcquireWood harvests the five-log bootstrap before returning control to the planner', async () => {
  const f = fixture()
  const result = await f.context.execute({ skill: 'wood', strategy: 'AcquireWood', params: {} }, new AbortController().signal)
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(f.calls.find(c => c.method === 'mine').params.count, 5)
  assert.equal(f.inventory.crafting_table, 1); assert.equal(f.inventory.wooden_pickaxe, 1)
  assert.ok(f.inventory.stick >= 2)
  assert.ok(f.inventory.oak_log * 4 + f.inventory.oak_planks >= 5, 'remaining real wood satisfies the graph receipt')
})

test('the standalone legacy wood actor retains its original reserve', async () => {
  const f = fixture(); await f.wood()
  assert.equal(f.calls.find(c => c.method === 'mine').params.count, 14)
})

test('in speedrun the legacy wood actor starts with six logs, the rest comes from reserve on the way (cl-u 14.10)', async () => {
  const f = fixture(); f.context.state.playPolicy = { mode: 'speedrun' }; await f.wood()
  assert.equal(f.calls.find(c => c.method === 'mine').params.count, 6)
})

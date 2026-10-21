import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { campaignTs, campaignRequire } from './campaign-source'
const data = campaignRequire('minecraft-data')('1.21.11')
const source = campaignTs()
function declaration(name) {
  const start = source.indexOf(`async function ${name} (`)
  assert.notEqual(start, -1)
  const end = source.indexOf('\n}', start)
  assert.notEqual(end, -1)
  return source.slice(start, end + 2)
}
function fixture(inv: Record<string, number>, flag?: string, dimension = 'overworld') {
  if (arguments.length < 2) flag = '1'
  inv = { ...inv }
  const calls = [], failed = []
  const have = re => Object.entries(inv).reduce((n, [k, v]) => n + ((typeof re === 'string' ? k === re : re.test(k)) ? v : 0), 0)
  const context: any = { process: { env: { ND_OW_TORCH_MATERIALS: flag } }, have, dim: () => dimension,
    refresh: async () => {}, planksFor: () => Object.keys(inv).find(k => /_log$/.test(k))?.replace('_log', '_planks') || null,
    craft: async (item, count) => {
      calls.push({ item, count })
      if (item === 'stick') {
        if (have(/_planks$/) < 2) { failed.push(item); return false }
        const plank = Object.keys(inv).find(k => /_planks$/.test(k) && inv[k] >= 2)
        inv[plank] -= 2; inv.stick = (inv.stick || 0) + 4; return true
      }
      if (/_planks$/.test(item)) {
        const log = Object.keys(inv).find(k => k.replace('_log', '_planks') === item && inv[k])
        if (!log) { failed.push(item); return false }
        inv[log]--; inv[item] = (inv[item] || 0) + 4; return true
      }
      assert.equal(item, 'torch')
      const batches = Math.ceil(count / 4)
      if (have('stick') < batches || have(/^(coal|charcoal)$/) < batches) { failed.push(item); return false }
      inv.stick -= batches
      for (let n = 0; n < batches; n++) { const fuel = inv.coal > 0 ? 'coal' : 'charcoal'; inv[fuel]-- }
      inv.torch = (inv.torch || 0) + batches * 4
      return true
    }
  }
  vm.runInNewContext(transformSync(declaration('sticks') + '\n' + declaration('torches') + '\nthis.run=torches', { loader: 'ts' }).code, context)
  return { inv, calls, failed, run: () => context.run() }
}

test('1.21.11 torch recipe confirms four output per stick and coal/charcoal', () => {
  const recipes = data.recipes[data.itemsByName.torch.id]
  for (const fuel of ['coal', 'charcoal']) assert.ok(recipes.some(r => r.result.count === 4 && r.inShape?.flat().includes(data.itemsByName.stick.id) && r.inShape.flat().includes(data.itemsByName[fuel].id)))
})
test('flag on: repeated owC2-09 missing-stick state makes no impossible craft RPC', async () => {
  const f = fixture({ coal: 17, oak_planks: 1 })
  await f.run(); await f.run()
  assert.deepEqual(f.calls, [])
})
test('flag on: one stick can produce four torches from coal or charcoal', async () => {
  for (const fuel of ['coal', 'charcoal']) {
    const f = fixture({ [fuel]: 1, stick: 1 })
    await f.run()
    assert.deepEqual(f.calls, [{ item: 'torch', count: 4 }])
    assert.equal(f.inv.torch, 4); assert.deepEqual(f.failed, [])
  }
})
test('flag on: two sticks and coal preserve eight output; wood conversion still works', async () => {
  for (const inv of [{ coal: 2, stick: 2 }, { coal: 3, oak_log: 1 }]) {
    const f = fixture(inv); await f.run()
    assert.equal(f.inv.torch, 8); assert.deepEqual(f.failed, [])
  }
})
test('off/absent retain legacy impossible RPC and single-coal refusal', async () => {
  for (const flag of ['0', undefined]) {
    const f = fixture({ coal: 17, oak_planks: 1 }, flag); await f.run()
    assert.deepEqual(f.calls, [{ item: 'torch', count: 8 }])
    const g = fixture({ coal: 1, stick: 1 }, flag); await g.run(); assert.deepEqual(g.calls, [])
  }
})
test('flag on: stocked or fuel-free inventory makes no craft calls', async () => {
  for (const inv of [{ coal: 2, stick: 2, torch: 16 }, { stick: 2 }]) {
    const f = fixture(inv); await f.run(); assert.deepEqual(f.calls, [])
  }
})
test('Nether flag on keeps legacy impossible RPC and single-coal refusal', async () => {
  const f = fixture({ coal: 17, oak_planks: 1 }, '1', 'the_nether'); await f.run()
  assert.deepEqual(f.calls, [{ item: 'torch', count: 8 }])
  const g = fixture({ coal: 1, stick: 1 }, '1', 'the_nether'); await g.run(); assert.deepEqual(g.calls, [])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { declSource } from './source-fixture'

// Лава в ведре от прошлого захода (раздел «3а.» castOne) — oneResume в cast1/one.ts; состояние захода — ox, его помощники
// (cnt, pourInto, dumpLava, regainWater, tr) — заглушки контекста (первым аргументом — ox).
const resume = declSource(path.join(__dirname, '../src/cast1.js'), 'oneResume')

async function fixture(visible = true) {
  const calls: string[] = [], inventory: Record<string, number> = { lava_bucket: 1 }
  const pending = { c: 'upper-frame', w: 'upper-water', lava: [['upper-support', 'face']], h: 2 }
  const ox = {
    bot: { blockAt: q => ({ name: q === pending.w ? 'water' : q === pending.c && !inventory.lava_bucket ? 'obsidian' : 'air' }) },
    g: {}, session: {}, ctl: {}, report: { cast: [] }
  }
  const context = {
    ox, cells: () => [pending], cnt: (_ox, n) => inventory[n] || 0,
    pourInto: async (_bot, name, refs) => {
      calls.push('pour'); assert.equal(name, 'lava_bucket'); assert.equal(refs, pending.lava)
      if (visible) { inventory.lava_bucket = 0; inventory.bucket = 1 }
      return { ok: visible }
    },
    dumpLava: async _ox => { calls.push('dump'); return false },
    regainWater: async _ox => { calls.push('water'); if (inventory.bucket) { inventory.bucket = 0; inventory.water_bucket = 1 } },
    gameClock: { now: () => 0 }, sleep: async () => {}, tr: (_ox, _m) => {}, xyz: q => q,
    require: () => ({ fillBucket: async () => { throw new Error('own water should be recovered first') } })
  }
  const result = await vm.runInNewContext(`${resume}\noneResume(ox)`, cjsContext(context))
  return { result, calls, inventory }
}

test('one-bucket casting resumes a pending upper cell through the actual guarded pour', async () => {
  const f = await fixture()
  assert.equal(f.result, undefined)
  assert.deepEqual(f.calls, ['pour', 'water'])
  assert.equal(f.inventory.water_bucket, 1)
})

test('an unreachable upper pour does not invent a completed cell or a water bucket', async () => {
  const f = await fixture(false)
  assert.equal(f.result.built, false)
  assert.equal(f.inventory.lava_bucket, 1)
  assert.equal(f.inventory.water_bucket, undefined)
})

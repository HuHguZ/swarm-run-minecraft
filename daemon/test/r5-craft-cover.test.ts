'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { withClockFixture } = require('./clock-fixture')
const path = require('node:path')
const { Vec3 } = require('vec3')
function fixture (visible) {
  let crafts = 0
  const b = { entity: { position: new Vec3(.5,64,.5) }, inventory: { items: () => [] }, craft: async (_recipe?: unknown, _count?: number) => { crafts++ } }
  const s = { bot: b }; const foe = { position: new Vec3(3,64,.5), height: 1.95 }
  const ctx = { module: { exports: {} as Record<string, any> }, process, Date,
    require: n => n === 'node:async_hooks' ? require(n) : n === './worlds' ? { worldOf: () => 'the_nether' } : n === './ne-guard' ? { meleeFoes: () => [foe] } : n === './perception' ? { eyePos: () => b.entity.position, raySees: () => visible } : {} as Record<string, any> }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/reflex-lock.js'),'utf8'),withClockFixture(ctx))
  const R = ctx.module.exports; R.install(s)
  return { run: () => R.run(s,{ aborted: false },() => b.craft({ result: { id: 1, count: 1 } },1)), crafts: () => crafts }
}
test('a mob behind the closed wall does not prohibit unpacking gold', async () => {
  const f = fixture(false); await f.run(); assert.equal(f.crafts(),1)
})
test('a visible enemy still prohibits crafting', async () => {
  const f = fixture(true); await assert.rejects(f.run(),{ code: 'REFLEX_UNSAFE_CRAFT' }); assert.equal(f.crafts(),0)
})
test('ND_CRAFT_COVER=0 restores the old radius-only refusal', async () => {
  const old = process.env.ND_CRAFT_COVER; process.env.ND_CRAFT_COVER = '0'
  try { await assert.rejects(fixture(false).run(),{ code: 'REFLEX_UNSAFE_CRAFT' }) } finally { if (old === undefined) delete process.env.ND_CRAFT_COVER; else process.env.ND_CRAFT_COVER = old }
})

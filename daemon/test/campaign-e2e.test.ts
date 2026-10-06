'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { load, ready } = require('./campaign-seams-fixture')

test('E2E death stops before another gameplay intention, even with retained inventory', () => {
  const state = ready()
  const c = load(state, undefined, { ND_E2E: '1' })
  assert.throws(() => c.acceptResult({ state, by: { type: 'death', at: 123 } }),
    e => e.stopCampaign && e.code === 'E2E_DEATH')
  assert.equal(c.calls.length, 0)
})

test('E2E detects a new death stamp even when another RPC drained the death event', () => {
  const c = load(ready(), undefined, { ND_E2E: '1' })
  c.acceptResult({ state: { ...ready(), lastDeathAt: 10 } })
  assert.throws(() => c.acceptResult({ state: { ...ready(), lastDeathAt: 11 } }), /E2E_DEATH/)
})

test('historical death stamp is only a startup baseline', () => {
  const c = load(ready(), undefined, { ND_E2E: '1' })
  assert.doesNotThrow(() => c.acceptResult({ state: { ...ready(), lastDeathAt: 10 } }))
  assert.doesNotThrow(() => c.acceptResult({ state: { ...ready(), lastDeathAt: 10 } }))
})

test('ND_E2E=0 retains the recovery campaign', () => {
  const c = load(ready(), undefined, { ND_E2E: '0' })
  assert.doesNotThrow(() => c.acceptResult({ state: ready(), by: { type: 'death' } }))
})

test('seam log contains equipped gear, health and explicit gameplay flags, excludes secret env', () => {
  const state = ready()
  state.armor = { torso: 'iron_chestplate' }; state.offHand = { item: 'shield' }
  const c = load(state, undefined, { ND_E2E: '1', ND_SH_NETHER: '1', ND_API_KEY: 'do-not-serialize' })
  assert.equal(typeof c.snapshot, 'function')
  c.snapshot('test-boundary')
  const line = c.logs.find(l => l.includes('СТЫК '))
  const r = JSON.parse(line.slice(line.indexOf('СТЫК ') + 5))
  assert.equal(r.body.health, 20)
  assert.equal(r.body.inventory.red_bed, 5)
  assert.equal(r.body.armor.torso, 'iron_chestplate')
  assert.equal(r.body.offHand.item, 'shield')
  assert.equal(r.flagsExplicit.ND_SH_NETHER, '1')
  assert.equal(JSON.stringify(r).includes('do-not-serialize'), false)
})

test('End fill records before and after body without scene resets', async () => {
  const state = ready()
  const c = load(state, (method, p) => {
    if (method === 'stronghold' && p.mode === 'fill') { state.dimension = 'the_end'; return { entered: true } }
    return method === 'dragon' ? { dragon: { won: true } } : {} as Record<string, any>
  }, { ND_E2E: '1' })
  c.known.endPortal = { x: 0, y: 60, z: 0 }
  await c.run('dragon')
  const rows = c.logs.filter(l => l.includes('СТЫК ')).map(l => JSON.parse(l.slice(l.indexOf('СТЫК ') + 5)))
  assert.ok(rows.some(r => r.seam === 'before-end' && r.body.dimension === 'overworld'))
  assert.ok(rows.some(r => r.seam === 'overworld->the_end' && r.body.dimension === 'the_end'))
  assert.equal(c.calls.some(x => x.method === 'say'), false)
})

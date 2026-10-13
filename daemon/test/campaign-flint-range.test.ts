import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

function fixture(distance: number, visible = true) {
  const source = fs.readFileSync(path.resolve(__dirname, '../campaign.ts'), 'utf8')
  const body = source.slice(source.indexOf('async function ensureFlint ()'), source.indexOf('let castRuns ='))
  const inventory: Record<string, number> = { iron_ingot: 1 }
  const calls: Array<{ method: string, params: any }> = []
  let now = 0, walking = 0
  const context: any = { state: { health: 20 }, known: {}, died: false, flintTries: 0,
    gameClock: { now: () => now }, have: name => inventory[name] || 0, log() {}, portalFar: () => 100,
    refresh: async () => {}, craft: async name => { assert.equal(inventory.flint, 1); inventory.flint--; inventory.iron_ingot--; inventory[name] = 1 },
    act: async (method, params) => {
      calls.push({ method, params }); now += 1000
      // Same observed block and geometric range for discovery and acquisition.
      // Seeing it costs no movement; mining it requires the real approach.
      if (method === 'explore') return { status: 'done', detail: { found: visible && distance <= params.radius ? 'gravel' : null, walked: 0 } }
      if (method === 'mine') {
        if (!visible || distance > params.radius) return { status: 'failed', error: 'no visible gravel in range', detail: {} }
        walking += distance; inventory.gravel = 1
        return { status: 'done', detail: { dug: 1 } }
      }
      if (method === 'flint_grind') { assert.equal(inventory.gravel, 1); inventory.gravel = 0; inventory.flint = 1; return { status: 'done', detail: { ok: true } } }
      throw Error('unexpected method ' + method)
    } }
  vm.runInNewContext(body + '\nmodule.exports = ensureFlint', Object.assign(context, { module: { exports: {} } }))
  return { run: context.module.exports, calls, inventory, walked: () => walking }
}

test('the portal kit acquires visible dry gravel at the saved S22 distance instead of rediscovering it without moving', async () => {
  const f = fixture(43.34674150472351)
  assert.equal(await f.run(), true)
  assert.equal(f.inventory.flint_and_steel, 1)
  assert.ok(f.walked() > 40)
  assert.equal(f.calls.filter(c => c.method === 'mine').length, 1)
  assert.equal(f.calls.filter(c => c.method === 'explore').length, 0)
})

test('nearby visible gravel still produces a lighter with one acquisition', async () => {
  const f = fixture(7)
  assert.equal(await f.run(), true)
  assert.equal(f.inventory.flint_and_steel, 1)
})

test('gravel outside discovery range or hidden gravel does not invent a lighter', async () => {
  for (const [distance, visible] of [[49, true], [12, false]] as Array<[number, boolean]>) {
    const f = fixture(distance, visible)
    assert.equal(await f.run(), false)
    assert.equal(f.inventory.flint_and_steel || 0, 0)
    assert.equal(f.inventory.iron_ingot, 1)
    assert.equal(f.walked(), 0)
  }
})

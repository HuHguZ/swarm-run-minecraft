import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
  const body = source.slice(source.indexOf('async function ensureFlint ()'), source.indexOf('let castRuns ='))
  const inventory: Record<string, number> = { gravel: 1, iron_ingot: 1 }
  const calls: Array<{ method: string, params: any }> = []
  let attempt = 0
  let interrupted = false
  let now = 0
  const durations: Record<string, number> = {}
  let interruptedMethod = ''
  let exploreFound = false
  const context: any = { flintTries: 0, state: { health: 20 }, known: {}, died: false,
    gameClock: { now: () => now }, have: name => inventory[name] || 0, log() {}, portalFar: () => 100,
    async refresh() {},
    async craft(item) { inventory[item] = 1; inventory.flint = 0 },
    async act(method, params) {
      calls.push({ method, params }); now += durations[method] ?? 1000
      if (method === interruptedMethod) return { status: 'interrupted', detail: { found: true } }
      if (method === 'flint_grind') {
        if (interrupted) return { status: 'interrupted', detail: { tries: 1 } }
        if (attempt >= 2) { inventory.flint = 1; inventory.gravel = 0 }
        return { status: 'done', detail: { tries: 40 } }
      }
      if (method === 'place') inventory.gravel--
      if (method === 'mine' && params.count === 1) inventory.gravel++
      if (method === 'mine' && params.count === 8 && attempt >= 2) { inventory.gravel = 1; return { status: 'done', detail: { dug: 1 } } }
      return { status: 'done', detail: { dug: 0, found: method === 'explore' && exploreFound } }
    }
  }
  vm.createContext(context)
  vm.runInContext(body + '\nthis.ensure = ensureFlint', context)
  return { inventory, calls, durations, ensure: context.ensure, setAttempt: n => { attempt = n }, interrupt: () => { interrupted = true }, interruptMethod: method => { interruptedMethod = method }, findGravel: () => { exploreFound = true } }
}

test('portal kit reuses the bounded flint grinder without a permanent two-attempt ban', async () => {
  const f = fixture()
  assert.equal(await f.ensure(), false)
  f.setAttempt(1)
  assert.equal(await f.ensure(), false)
  f.calls.length = 0
  f.setAttempt(2)
  assert.equal(await f.ensure(), true)
  assert.equal(f.inventory.flint_and_steel, 1)
  assert.equal(f.calls[0].method, 'flint_grind')
  assert.ok(f.calls[0].params.timeoutSeconds <= 90)
  assert.ok(!f.calls.some(c => c.method === 'place'))
})

test('gravel gathered during the search is recycled before another long search', async () => {
  const f = fixture()
  f.inventory.gravel = 0
  f.setAttempt(2)
  assert.equal(await f.ensure(), true)
  assert.deepEqual(f.calls.map(c => c.method), ['mine', 'flint_grind'])
})

test('an interrupted grinder yields control without starting a gravel hunt', async () => {
  const f = fixture()
  f.interrupt()
  assert.equal(await f.ensure(), false)
  assert.deepEqual(f.calls.map(c => c.method), ['flint_grind'])
})

test('an available fire charge requires no flint work', async () => {
  const f = fixture()
  f.inventory.fire_charge = 1
  assert.equal(await f.ensure(), true)
  assert.equal(f.calls.length, 0)
})

test('gravel search does not start another leg after its grinder spends the remaining budget', async () => {
  const f = fixture()
  f.durations.flint_grind = 90000
  f.durations.mine = 60000
  assert.equal(await f.ensure(), false)
  assert.deepEqual(f.calls.map(c => c.method), ['flint_grind', 'mine', 'flint_grind'])
})

test('the final gravel search leg uses only the remaining search budget', async () => {
  const f = fixture()
  f.inventory.gravel = 0
  f.durations.mine = 60000
  f.durations.explore = 50000
  f.findGravel()
  assert.equal(await f.ensure(), false)
  const searches = f.calls.filter(c => c.method === 'explore')
  assert.equal(searches[1].params.timeoutSeconds, 10)
})

test('an interrupted gravel exploration stops the next mining leg', async () => {
  const f = fixture()
  f.inventory.gravel = 0
  f.interruptMethod('explore')
  // It found a clue immediately before interruption; ownership still belongs to the reflex.
  const interrupted = f.calls
  assert.equal(await f.ensure(), false)
  assert.deepEqual(interrupted.map(c => c.method), ['mine', 'explore'])
})

test('flint search keeps visible gravel first and requests a surface route after local failure', async () => {
  const f = fixture()
  f.inventory.gravel = 0
  await f.ensure()
  assert.deepEqual(f.calls.map(c => c.method), ['mine', 'explore'])
  assert.equal(f.calls[1].params.surface, true)
  assert.ok(f.calls[1].params.timeoutSeconds <= 60)
})

test('the flint grinder chooses a new cell after walking onto its previous drop', async () => {
  const Vec3 = require('vec3')
  const cells = new Map<string, string>()
  const inventory = { gravel: 1, flint: 0 }
  const placed: number[] = []
  let now = 0
  let dug = 0
  const bot = { entity: { position: new Vec3(.5, 64, .5) }, pathfinder: { setGoal() {} },
    inventory: { items: () => Object.entries(inventory).filter(([, count]) => count).map(([name, count]) => ({ name, count })) },
    blockAt(p) { return { position: p, name: cells.get(p.toString()) || (p.y < 64 ? 'stone' : 'air'), boundingBox: p.y < 64 ? 'block' : 'empty' } } }
  const context: any = { module: { exports: {} }, process: { env: {} }, require(name) {
    if (name === './game-clock') return { now: () => now, sleep: async ms => { now += ms } }
    if (name === './items') return { equipBestTool: async () => {} }
    if (name === './build') return { placeBlockAt: async (_bot, at) => {
      if (at.equals(bot.entity.position.floored())) return { ok: false, reason: 'own body' }
      cells.set(at.toString(), 'gravel'); inventory.gravel--; placed.push(at.x); return { ok: true }
    } }
    if (name === './cast') return { _in: { digVisible: async (_bot, block) => {
      cells.delete(block.position.toString())
      if (++dug === 2) inventory.flint++
    } } }
    if (name === './actions') return { collectNearbyDrops: async () => {
      inventory.gravel++; bot.entity.position = new Vec3(1.5, 64, .5)
    } }
    throw new Error(name)
  } }
  const file = path.join(__dirname, '../src/flint-grind.ts')
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, context)
  const result = await context.module.exports.flintGrind({ bot }, { aborted: false }, { max: 4 })
  assert.equal(result.ok, true)
  assert.deepEqual(placed, [1, 2])
})

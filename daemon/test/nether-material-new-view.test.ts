import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
const Vec3 = require('vec3')

// Complete production modules, with visibility, native movement/digging and
// crafting as boundaries. The supply fallback dispatches the actual explore.
const code = Object.fromEntries(['actions', 'campaign/nether-supply'].map(name => [name,
  transformSync(fs.readFileSync(path.join(__dirname, `../src/${name}.ts`), 'utf8'), { loader: 'ts', format: 'cjs' }).code]))

function fixture(options: any = {}) {
  let now = 0, walks = 0, interrupted = false
  const calls: Array<{ method: string; params: any; result?: any }> = []
  const state: any = { dimension: 'the_nether', health: 20, pickSwings: 150,
    inventory: { oak_planks: 16, stick: 8, crafting_table: 1, iron_ingot: 2, stone_pickaxe: 1 } }
  const old = { name: 'blackstone', position: new Vec3(9, 56, 0) }
  const fresh = Array.from({ length: 6 }, (_, i) => ({ name: 'blackstone', position: new Vec3(40 + i, 56, 0) }))
  const removed = new Set<string>()
  const ctl: any = { aborted: false, onAbort: [] }
  const bot: any = {
    game: { dimension: 'the_nether' }, entity: { position: new Vec3(0.5, 56, 0.5), width: .6 },
    inventory: { items: () => Object.entries(state.inventory).map(([name, count]) => ({ name, count })) },
    pathfinder: { movements: { canDig: true, scafoldingBlocks: [] },
      goto: async () => { throw new Error('No path: lava gap') } },
    blockAt: p => [old, ...fresh].find(b => b.position.equals(p) && !removed.has(p.toString())) || { name: 'air', position: p },
    canDigBlock: b => !!b?.position && (b !== old || !!options.oldReachable && walks > 0) && b.position.distanceTo(bot.entity.position) <= 6,
    async dig(b) { removed.add(b.position.toString()); state.inventory.blackstone = (state.inventory.blackstone || 0) + 1 }
  }
  if (options.memory) bot._ndEyes = {}
  const visible = (_bot, _ids, radius, opts: any = {}) => [old, ...(walks && !options.noFresh ? fresh : [])]
    .filter(b => !removed.has(b.position.toString()) && b.position.distanceTo(bot.entity.position) <= radius && !opts.skip?.(b.position))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    .slice(0, opts.max ?? 12)
  const imports: Record<string, any> = {
    './game-clock': { now: () => now }, 'vec3': Vec3,
    'mineflayer-pathfinder': { goals: { GoalLookAtBlock: class {}, GoalNear: class {} } },
    './movement': { xyz: p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }),
      sleep: async ms => { now += ms },
      travelXZ: async (_bot, _ctl, x, z) => {
        walks++; now += 1000
        if (options.cancel) { ctl.aborted = interrupted = true; return { ok: false, error: 'TACTICAL' } }
        if (options.noMove) return { ok: false, error: 'No path' }
        bot.entity.position = options.oldReachable ? new Vec3(8.5, 56, .5) : new Vec3(x, 56, z)
        return { ok: true }
      } },
    './items': { GROUPS: {}, resolveBlockIds: () => [1], missingHarvestTool: () => null,
      equipBestTool: async () => {}, countItems: () => ({ ...state.inventory }),
      diffItems: (before, after) => Object.fromEntries(Object.entries(after).filter(([name, count]) => Number(count) !== (before[name] || 0)).map(([name, count]) => [name, Number(count) - (before[name] || 0)])) },
    // reachBlock caps each approach with build.withTimeout (14.10); the stub passes the walk through.
    './build': { withTimeout: p => p }, './pick': { blockSeen: () => !options.noPick }, './sight': { visibleOf: visible },
    './worlds': { worldOf: () => 'the_nether' },
    './perception/eyes': { nearest: () => [{ name: 'blackstone', x: 9, y: 56, z: 0, dist: 9, ago: 1 }] }
  }
  const load = (name: string): any => {
    const module = { exports: {} }
    vm.runInNewContext(code[name], { module, exports: module.exports, process: { env: {} }, console: { log() {} },
      require(request: string) {
        if (request in imports) return imports[request]
        throw new Error(`unexpected dependency ${request}`)
      } }, { filename: path.join(__dirname, `../src/${name}.ts`) })
    return module.exports
  }
  const actions = load('actions'), supply = load('campaign/nether-supply')
  const session: any = { bot, cfg: { fairPlay: true }, mcData: { blocks: { 1: { name: 'blackstone' } } }, underSky: () => false }
  const port: any = { observe: async () => state, now: () => now, interrupted: () => interrupted, log() {},
    async act(method: string, params: any) {
      const call: any = { method, params }; calls.push(call)
      try { call.result = await actions[method](session, ctl, method === 'mine' ? { ...params, collect: false } : params) }
      catch (e) { call.result = { failed: true, error: e.message }; now += Number(params.timeoutSeconds) * 1000 }
    },
    async craft(item: string) {
      calls.push({ method: 'craft', params: { item } })
      if (item !== 'stone_pickaxe' || !(state.inventory.blackstone >= 3) || state.inventory.stick < 2) return false
      state.inventory.blackstone -= 3; state.inventory.stick -= 2; state.inventory.stone_pickaxe++; state.pickSwings += 131
      return true
    } }
  return { state, calls, bot, old, ctl, walks: () => walks, now: () => now,
    supply: () => supply.replenishNetherTools(port),
    explore: (params: any = {}) => actions.explore(session, ctl, { block: 'blackstone', radius: 24, stepDistance: 40, timeoutSeconds: 3, fair: true, dry: true, ...params }) }
}

test('failed physical material mining dispatches a new actual view before retrying, then obtains a pick', async () => {
  const f = fixture()
  const result = await f.supply()
  assert.equal(result.ready, true)
  assert.equal(f.walks(), 1, 'the visible unreachable blackstone cannot finish the fallback at zero XYZ')
  const search = f.calls.find(c => c.method === 'explore')!
  assert.equal(search.params.newView, true)
  assert.equal(search.result.at.x, 40)
  assert.equal(f.calls.filter(c => c.method === 'mine')[1].result.dug, 6)
  assert.equal(f.state.pickSwings, 281)
})

test('ordinary exploration still returns an already visible remote material without moving', async () => {
  const f = fixture()
  const result = await f.explore()
  assert.equal(result.at.x, 9)
  assert.equal(result.walked, 0)
  assert.equal(f.walks(), 0)
})

test('a remembered initially visible inaccessible material does not repeat the same failed goal', async () => {
  const f = fixture({ memory: true })
  const result = await f.explore({ newView: true })
  assert.equal(result.at.x, 40)
  assert.equal(f.walks(), 1)
  assert.equal(result.legs.some((leg: string) => leg.includes('память')), false)
})

test('a known block may complete a changed view only after it is physically diggable and picked', async () => {
  const good = fixture({ noFresh: true, oldReachable: true })
  assert.equal((await good.explore({ newView: true })).at.x, 9)
  assert.equal(good.walks(), 1)
  const hidden = fixture({ noFresh: true, oldReachable: true, noPick: true })
  assert.equal((await hidden.explore({ newView: true })).found, null)
  assert.ok(hidden.now() >= 3000)
})

test('a failed zero XYZ walk cannot turn the initial visible candidate into new discovery', async () => {
  const f = fixture({ noMove: true, noFresh: true })
  const result = await f.explore({ newView: true })
  assert.equal(result.found, null)
  assert.ok(f.walks() > 0)
  assert.ok(f.now() <= 4000)
  assert.equal(f.bot.entity.position.x, .5)
})

test('Tactical interruption of the new view ends the supply fallback before another mine', async () => {
  const f = fixture({ cancel: true })
  const result = await f.supply()
  assert.equal(result.interrupted, true)
  assert.equal(f.calls.at(-1)?.method, 'explore')
  assert.equal(f.calls.filter(c => c.method === 'mine').length, 1)
})

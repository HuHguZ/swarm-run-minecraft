import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import path from 'node:path'
import { transformSync } from 'esbuild'
import { partSource } from './source-fixture'
import { CAMPAIGN, campaignRequire, withSetters } from './campaign-source'
import { cjsContext } from './cjs-context'

function fixture(on = true) {
  const calls: any[] = [], inventory: any = { bucket: 1, flint_and_steel: 1, stone_pickaxe: 1, cobblestone: 64 }
  const ctx: any = { process: { env: { ND_NIGHT_WORK_SAFE: '1', ...(on ? { ND_NIGHT_WATER_ROUTE_MEMORY: '1' } : {}) } },
    require: campaignRequire, path, __dirname: path.join(__dirname, '..'),
    state: { pos: { x: 470, y: 138, z: -279 }, health: 20, food: 20, inventory, dimension: 'overworld' },
    sit: { surface: false, night: true, foes: 0, work: { block: 15, sky: 0, roof: true, walls: 4, floor: true, sealed: true } },
    known: {}, knownWater: { x: 470, y: 138, z: -277 }, died: false, strategyInterrupted: false, manualControl: false,
    OW_HEAR: true, DEEP_Y: -54, LOGS: /_log$/, COBBLE: /^cobblestone$/, PICK_IRON: /^iron_pickaxe$/, FOOD: /cooked_/, RAW: /^(beef|porkchop)$/,
    MOB_BLOCKED: /blocked-mob/, CAVE_FOES: /zombie/, lavaSourceKnown: false,
    gameClock: { now: () => 1000 }, log() {}, dim: () => 'overworld', y: () => ctx.state.pos.y,
    have: re => Object.entries(inventory).reduce((n, [k, v]) => n + ((typeof re === 'string' ? k === re : re.test(k)) ? Number(v) : 0), 0),
    near3: (q, d) => q && Math.hypot(q.x - ctx.state.pos.x, q.y - ctx.state.pos.y, q.z - ctx.state.pos.z) <= d,
    lighter: () => true, portalBuckets: () => 1, shieldOn: () => true, netherFoodNeed: () => 3,
    READY: { nether: () => false, cast: () => false }, portalFar: () => Infinity,
    refresh: async () => {}, sense: async () => {}, readMemory: async () => {}, spares: async () => {},
    owWoodBudget: () => null, smeltAll: async () => {}, spendIron: async () => {}, torches: async () => {}, cook: async () => {},
    call: async () => ({ detail: { spots: [] } }),
    intelligence: { environment: { observe: async () => ({}) }, registry: { get: () => ({ estimateRisk: () => 0 }) } },
    structureValue: { SECONDS: { iron: 152 } },
    act: async (method, params) => {
      calls.push({ method, params })
      if (method === 'bucket') { if (ctx.fillLocal) inventory.water_bucket = 1; return { status: 'done', detail: { stopped: 'не вижу источника воды' } } }
      if (method === 'portal') return { status: 'done', detail: { heard: [{ dir: 'south', flat: 2, dist: 2 }] } }
      if (method === 'tunnel') return { status: 'done', detail: { stopped: 'вода на 470,138,-277: нет видимой грани для затычки — обходи другим направлением' } }
      if (method === 'dig_down') { ctx.state.pos.y--; return { status: 'done', detail: { dug: ctx.dug || 0, steps: 1 } } }
      return { status: 'done', detail: {} }
    }
  }
  const source = partSource(CAMPAIGN, 'night-work-step', { ts: true })
  vm.runInNewContext(transformSync(source + '\nthis.water=nightWorkWater;this.work=nightWorkStep', { loader: 'ts' }).code, cjsContext(withSetters(ctx)))
  return { ctx, calls, inventory, tunnels: () => calls.filter(c => c.method === 'tunnel').length }
}

test('L water: an unchanged failed inlet survives the 16-block retreat and return, HP and cobble drift', async () => {
  const f = fixture(); await f.ctx.water()
  for (const z of [-295, -287, -279]) { f.ctx.state.pos.z = z; f.ctx.state.health--; f.inventory.cobblestone--; await f.ctx.water() }
  assert.equal(f.tunnels(), 1, 'no return trip to the same unplaceable inlet')
  assert.equal(f.calls.filter(c => c.method === 'bucket').length, 4, 'each view still probes local sources')
})

test('L water: disabled flag preserves the repeated legacy route', async () => {
  const f = fixture(false); await f.ctx.water(); f.ctx.state.pos.z = -295; await f.ctx.water()
  assert.equal(f.tunnels(), 2)
})

for (const changed of ['side', 'height', 'source']) test(`L water: a changed ${changed} admits an independent approach`, async () => {
  const f = fixture(); await f.ctx.water()
  if (changed === 'side') f.ctx.state.pos = { x: 474, y: 138, z: -277 }
  if (changed === 'height') f.ctx.state.pos.y++
  if (changed === 'source') f.ctx.knownWater = { x: 471, y: 138, z: -277 }
  await f.ctx.water(); assert.equal(f.tunnels(), 2)
})

test('L water: a newly scoopable local source overrides remembered route failure', async () => {
  const f = fixture(); await f.ctx.water(); f.ctx.fillLocal = true
  const r = await f.ctx.water(); assert.equal(f.inventory.water_bucket, 1); assert.equal(r.status, 'done'); assert.equal(f.tunnels(), 1)
})

test('L water: actual nightWorkStep excavation invalidates the old geometry, empty traversal does not', async () => {
  for (const dug of [0, 3]) {
    const f = fixture(); await f.ctx.water(); f.ctx.dug = dug
    const r = await f.ctx.work(); assert.equal(r.progress, true)
    f.ctx.state.pos = { x: 470, y: 138, z: -279 }; await f.ctx.water()
    assert.equal(f.tunnels(), dug ? 2 : 1)
  }
})

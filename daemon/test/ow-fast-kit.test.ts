import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { REPO_ROOT } from '../src/paths'

// Run against the applied TypeScript sources, including when npm test executes from dist/.
const source = (name: string): string => fs.readFileSync(path.join(REPO_ROOT, name), 'utf8')
const declaration = (src: string, name: string): string => {
  let start = src.indexOf(`async function ${name} (`)
  if (start < 0) start = src.indexOf(`function ${name} (`)
  return start < 0 ? '' : src.slice(start, src.indexOf('\n}', start) + 2)
}
function fixture(options: any = {}) {
  const calls: any[] = [], inv: Record<string, number> = { crafting_table: 1, stone_pickaxe: 1, cobblestone: 64, stick: 4, ...options.inv }
  const ctx: any = { process: { env: { ND_OW_FAST_KIT: '1', ND_OW_FAST_DESCENT: '1', ...options.env } },
    OW_DEEP: true, known: { lava: { x: 80, y: 64, z: 0 }, ...options.known }, knownWater: { x: 30, y: 63, z: 20 },
    state: { inventory: inv, dimension: 'overworld', health: 20, pos: { x: 0, y: 64, z: 0 } },
    sit: { surface: true, pickLeft: 131, pickReturn: { depth: 0, swings: 0, verified: true } },
    died: false, strategyInterrupted: false, lavaSourceKnown: true, stairEntrance: null, castSurfaceFailed: false, SWINGS_PER_LEVEL: 4.05,
    LOGS: /_(log|stem)$/, COBBLE: /^(cobblestone|cobbled_deepslate|blackstone)$/, RAW: /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/,
    PICK_IRON: /^(iron|diamond|netherite)_pickaxe$/, lighter: () => !!inv.flint_and_steel || !!inv.fire_charge,
    portalBuckets: () => options.buckets ?? 1, shieldOn: () => !!inv.shield,
    have: re => Object.entries(inv).reduce((n, [name, count]) => n + ((typeof re === 'string' ? name === re : re.test(name)) ? count : 0), 0),
    y: () => ctx.state.pos.y, dim: () => ctx.state.dimension, nightHold: () => !!ctx.sit.night,
    surfaceLavaNear: () => !!ctx.known.lava && ctx.known.lava.y >= 0 && Math.hypot(ctx.known.lava.x - ctx.state.pos.x, ctx.known.lava.z - ctx.state.pos.z) <= 96,
    log() {}, sense: async () => {}, act: async (method, params) => {
      calls.push({ method, params })
      if (options.failed) return { status: 'failed', error: 'no dry surface path' }
      if (method !== 'goto') return { status: 'done', detail: {} }
      ctx.state.pos = { x: params.x - 12, y: 64, z: params.z }; return { status: 'done' }
    } }
  const kit = source('daemon/campaign/kit.ts'), ow = source('daemon/campaign/stages/overworld.ts')
  const smeltStart = kit.indexOf('const ironToSmelt = () => {'), smeltEnd = kit.indexOf('\n}', smeltStart) + 2
  const anchor = declaration(ow, 'fastIronAnchor')
  vm.runInNewContext(transformSync(declaration(kit, 'owWoodBudget') + '\n' + kit.slice(smeltStart, smeltEnd) +
    '\nconst fastIronAnchorFailed = new Set();\n' + anchor +
    '\nthis.smelt=ironToSmelt;this.anchor=typeof fastIronAnchor === "function" ? fastIronAnchor : async()=>{}', { loader: 'ts' }).code, ctx)
  return { ctx, inv, calls }
}
test('O kit: plan purchases four iron; carried safety tools stay usable', () => {
  assert.equal(fixture().ctx.smelt(), 4)
})
test('O kit: existing bucket, fire charge, ingot and two-bucket cast affect exact remaining demand', () => {
  assert.equal(fixture({ inv: { water_bucket: 1, fire_charge: 1 } }).ctx.smelt(), 0)
  assert.equal(fixture({ inv: { bucket: 1 } }).ctx.smelt(), 1)
  assert.equal(fixture({ buckets: 2 }).ctx.smelt(), 7)
  assert.equal(fixture({ inv: { iron_ingot: 2 } }).ctx.smelt(), 2)
  const shallow = fixture(); shallow.ctx.OW_DEEP = false; assert.equal(shallow.ctx.smelt(), 4)
})
test('O kit: known portal and cast failure retain the old fallback', () => {
  assert.equal(fixture({ known: { portal: { x: 1, y: 64, z: 0 } } }).ctx.smelt(), Infinity)
  const f = fixture(); f.ctx.castSurfaceFailed = true; assert.equal(f.ctx.smelt(), 7)
})
test('O descent: known lava yields a strict dry approach with range 12 before shaft', async () => {
  const f = fixture(); await f.ctx.anchor()
  assert.equal(f.calls.length, 1); const call = f.calls[0]
  assert.equal(call.method, 'goto'); assert.equal(call.params.surface, 'strict'); assert.equal(call.params.range, 12)
  assert.equal(call.params.y, undefined); assert.equal(call.params.x, 80)
})
test('O descent: unchanged failed shoreline is not retried for HP, inventory or small position drift', async () => {
  const f = fixture({ failed: true }); await f.ctx.anchor(); f.ctx.state.health = 19; f.inv.cobblestone--
  f.ctx.state.pos.x = 2; await f.ctx.anchor(); assert.equal(f.calls.length, 1)
  f.ctx.known.lava = { x: 82, y: 64, z: 0 }; await f.ctx.anchor(); assert.equal(f.calls.length, 2)
})
test('O descent: unknown/deep lava, underground, night, known portal or disabled flag leave original route', async () => {
  const variants = [f => f.ctx.known.lava = null, f => f.ctx.known.lava.y = -54, f => f.ctx.known.lava.y = 16,
    f => f.ctx.lavaSourceKnown = false,
    f => f.ctx.sit.surface = false, f => f.ctx.sit.night = true,
    f => f.ctx.known.portal = { x: 1, y: 64, z: 0 }, f => f.ctx.process.env.ND_OW_FAST_DESCENT = '0']
  for (const alter of variants) { const f = fixture(); alter(f); await f.ctx.anchor(); assert.equal(f.calls.length, 0) }
})
test('O actual iron stage: remembered vein supplies kit before any anchor or new mining shaft', async () => {
  const f = fixture(), stages: any = {}, requests: any[] = []
  Object.assign(f.ctx, {
    defStage: (name, ready, run) => { stages[name] = { ready, run } },
    ARMOR_SLOT: { chestplate: 'torso', leggings: 'legs', helmet: 'head', boots: 'feet' },
    ARMOR_COST: { iron_chestplate: 8, iron_leggings: 7, iron_helmet: 5, iron_boots: 4 },
    worn: () => false, gearWorth: () => ({ missing: true, take: true, line: 'armour offer' }),
    owFastTrack: () => true,
    weakAndHungry: () => false, foodUnits: () => 0, woodNow: () => 10, refresh: async () => {},
    cook: async () => {}, lightUp: async () => {},
    mineSeenAll: async (block, distance, remaining) => {
      const need = remaining(); requests.push({ block, need }); f.inv.raw_iron = need
    },
    smeltAll: async (from, into, opts) => {
      const qty = Math.min(f.inv[from] || 0, opts?.max ?? Infinity)
      f.inv[from] = (f.inv[from] || 0) - qty; f.inv[into] = (f.inv[into] || 0) + qty
    }, ironToSmelt: f.ctx.smelt,
    spendIron: async () => { f.inv.bucket = 1; f.inv.flint_and_steel = 1; f.inv.iron_ingot -= 4 },
    readMemory: async () => {}, descend: async () => { throw Error('new shaft must not run') },
    earlyShield: async () => false,
  })
  const code = transformSync(source('daemon/campaign/stages/overworld.ts'), { loader: 'ts', format: 'cjs' }).code
  vm.runInNewContext(code, { require: () => f.ctx, exports: {}, module: { exports: {} }, process: f.ctx.process })
  await stages.iron.run()
  assert.equal(requests.length, 1); assert.equal(requests[0].need, 4)
  assert.equal(f.calls.filter(c => c.method === 'goto').length, 0)
  assert.equal(f.inv.bucket, 1); assert.equal(f.inv.flint_and_steel, 1)
})
test('O earlyShield price protects fourth kit ingot but retains an emergency or surplus option', async () => {
  for (const [hp, iron, expected] of [[20, 4, false], [6, 4, false], [3, 4, false], [2, 4, true], [20, 5, true]]) {
    const f = fixture({ inv: { iron_ingot: iron, oak_planks: 10 } }); f.ctx.state.health = hp; f.ctx.sit.night = true
    const shieldSrc = source('daemon/src/ow-shield.ts'), start = shieldSrc.indexOf('export function price(')
    const price = shieldSrc.slice(start, shieldSrc.indexOf('\n}', start) + 2).replace('export ', '')
    const priceCtx: any = { Math, process: f.ctx.process, enabled: () => true, DEATH_S: 3600, route: {} }
    const riskSrc = source('daemon/src/route/risk.ts')
    const risk = declaration(riskSrc, 'scoutLegPrice').replace('export ', '')
    vm.runInNewContext(transformSync(risk + '\nthis.route.scoutLegPrice=scoutLegPrice;\n' + price + '\nthis.price=price', { loader: 'ts' }).code, priceCtx)
    Object.assign(f.ctx, { earlyShieldBusy: false, earlyShieldFailed: null, fighting: false, resting: false,
      require: () => ({ price: priceCtx.price }), refresh: async () => {}, ensureTable: async () => {},
      planksFor: () => 'oak_planks', craft: async item => { f.inv[item] = 1; return true } })
    vm.runInNewContext(transformSync(declaration(source('daemon/campaign/gear.ts'), 'earlyShield') + '\nthis.early=earlyShield', { loader: 'ts' }).code, f.ctx)
    assert.equal(await f.ctx.early(), expected, `hp${hp}, iron${iron}`)
  }
})

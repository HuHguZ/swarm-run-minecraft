import { partSource } from './source-fixture'
import { CAMPAIGN, campaignRequire, campaignTs, withSetters } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { transformSync } from 'esbuild'
const source = campaignTs()

function fixture(env = {}) {
  // Часть night-work-step целиком (от nightWorkEnabled до nightWorkStepInner)
  const nightWork = partSource(CAMPAIGN, 'night-work-step', { ts: true })
  assert.ok(nightWork.includes('const nightWorkEnabled ='), 'world-driven night worker must exist')
  const calls: any[] = [], logs: string[] = []
  const inventory: any = { water_bucket: 1, flint_and_steel: 1, stone_pickaxe: 1, cobblestone: 64 }
  const ctx: any = { process: { env: { ND_NIGHT_WORK_SAFE: '0', ...env } }, require: campaignRequire, path, __dirname: path.join(__dirname, '..'), state: { pos: { x: 0, y: 16, z: 0 }, health: 20, food: 20, inventory, dimension: 'overworld' },
    sit: { surface: false, night: true, pickLeft: 100, foes: 0 }, known: {}, knownWater: null,
    died: false, strategyInterrupted: false, stage: '-', OW_HEAR: true, heardLava: null, DEEP_Y: -54,
    LOGS: /_log$/, COBBLE: /^(cobblestone|cobbled_deepslate|blackstone)$/, PICK_STONE: /^(stone|iron|diamond)_pickaxe$/, PICK_IRON: /^iron_pickaxe$/,
    CAVE_FOES: /^(zombie|skeleton|creeper)$/,
    MOB_BLOCKED: /дойдёт до меня|блоках (впереди|позади|снизу|сверху)|бл. (снизу|сверху)|CAST_UNSAFE/,
    FOOD: /cooked_/, RAW: /^(beef|porkchop)$/, lavaSourceKnown: false, stairEntrance: { y: 64 }, surfaceShaft: null,
    gameClock: { now: () => 1 }, log: line => logs.push(line), dim: () => ctx.state.dimension, y: () => ctx.state.pos.y,
    have: re => Object.entries(inventory).reduce((n, [k, v]) => n + ((typeof re === 'string' ? k === re : re.test(k)) ? Number(v) : 0), 0),
    lighter: () => inventory.flint_and_steel || inventory.fire_charge || 0, portalBuckets: () => 1,
    READY: { nether: () => true, cast: () => !!ctx.have(/bucket$/) && !!ctx.lighter() },
    portalFar: () => ctx.known.portal ? Math.hypot(ctx.known.portal.x - ctx.state.pos.x, ctx.known.portal.z - ctx.state.pos.z) : 0,
    near3: (q, d) => !!q && Math.hypot(q.x - ctx.state.pos.x, q.y - ctx.state.pos.y, q.z - ctx.state.pos.z) <= d,
    lavaApproachSeconds: q => Math.hypot(q.x - ctx.state.pos.x, q.y - ctx.state.pos.y, q.z - ctx.state.pos.z),
    shieldOn: () => !!inventory.shield, netherFoodNeed: () => 3, readMemory: async () => {}, refresh: async () => {}, sense: async () => {},
    spares: async () => {}, ensurePick: async () => !!ctx.have(/_pickaxe$/), spendIron: async () => {},
    torches: async () => {},
    smeltAll: async () => {}, cook: async () => {}, kitWaterHere: async () => { calls.push({ method: 'kitWaterHere' }); return false },
    approachCastLava: async () => {}, castForKit: async () => { calls.push({ method: 'castForKit' }); return { detail: { stopped: 'места на берегу нет' } } },
    enterNether: async () => { calls.push({ method: 'enterNether' }); ctx.state.dimension = 'the_nether' },
    leaveWater: async () => { calls.push({ method: 'leaveWater' }); ctx.sit.inWater = false },
    intelligence: { environment: { observe: async () => ({ health: ctx.state.health }) }, registry: { get: id => ({ estimateRisk: s => (id === 'GetWater' ? .015 : id === 'ScoutLava' ? .02 : .04) * 20 / s.health }) } },
    structureValue: { SECONDS: { iron: 152 } },
    call: async () => ({ detail: { spots: [] } }),
    act: async (method, params) => {
      calls.push({ method, params })
      if (method === 'dig_down') { ctx.state.pos.y -= params.depth; return { status: 'done', detail: { dug: params.depth * 3, descended: params.depth } } }
      if (method === 'tunnel') { ctx.state.pos.x += params.length; return { status: 'done', detail: { dug: params.length * 2, walked: params.length } } }
      return { status: 'done', detail: {} }
    }
  }
  vm.runInNewContext(transformSync(nightWork + '\nthis.work=nightWorkStep;this.here=nightWorkHere;this.blocked=nightWorkBlocked;this.failures=nightWorkFailures', { loader: 'ts' }).code, cjsContext(withSetters(ctx)))
  return { ctx, calls, inventory, logs }
}

function carriedKit(env = {}) {
  const f = fixture(env)
  delete f.inventory.water_bucket; delete f.inventory.flint_and_steel
  Object.assign(f.inventory, { iron_ingot: 2, raw_iron: 2, flint: 1, coal: 2, furnace: 1, crafting_table: 1 })
  f.ctx.sit.night = false
  return f
}
test('R6: on dawn C7 finishes the carried kit before an unrelated surface return', async () => {
  const f = carriedKit({ ND_IRON_FINISH_HERE: '1' })
  assert.equal(!!f.ctx.here(), true)
  f.ctx.smeltAll = async () => { f.calls.push({ method: 'smelt' }); f.inventory.raw_iron = 0; f.inventory.iron_ingot = 4 }
  f.ctx.spendIron = async () => { f.calls.push({ method: 'craft' }); f.inventory.iron_ingot = 0; f.inventory.bucket = 1; f.inventory.flint_and_steel = 1 }
  assert.equal((await f.ctx.work()).progress, true)
  assert.equal(!!f.ctx.here(), true)
  assert.equal((await f.ctx.work()).progress, true)
  assert.equal(!!f.ctx.here(), false, 'a completed kit does not enable unrelated daytime tunnelling')
  assert.deepEqual(f.calls.filter(c => ['smelt', 'craft'].includes(c.method)).map(c => c.method), ['smelt', 'craft'])
  assert.equal(f.calls.some(c => /surface|dig_down|tunnel|mine_seen/.test(c.method)), false)
})
test('R6: incomplete materials, no fuel, the surface, and disabled C7 keep the previous admission', () => {
  assert.equal(!!carriedKit().ctx.here(), false)
  const short = carriedKit({ ND_IRON_FINISH_HERE: '1' }); short.inventory.raw_iron = 1; assert.equal(!!short.ctx.here(), false)
  const fuel = carriedKit({ ND_IRON_FINISH_HERE: '1' }); delete fuel.inventory.coal; assert.equal(!!fuel.ctx.here(), false)
  const top = carriedKit({ ND_IRON_FINISH_HERE: '1' }); top.ctx.sit.surface = true; assert.equal(!!top.ctx.here(), false)
  assert.equal(!!carriedKit({ ND_IRON_FINISH_HERE: '1', ND_NIGHT_WORK: '0' }).ctx.here(), false)
  const plank = carriedKit({ ND_IRON_FINISH_HERE: '1' }); delete plank.inventory.coal; plank.inventory.oak_log = 2; assert.equal(!!plank.ctx.here(), true)
})
test('R6: failed carried smelting cannot start new daytime mining or poll the same refusal', async () => {
  const f = carriedKit({ ND_IRON_FINISH_HERE: '1' })
  f.ctx.smeltAll = async () => { f.calls.push({ method: 'smelt' }) }
  await f.ctx.work(); await f.ctx.work()
  assert.equal(f.calls.filter(c => c.method === 'smelt').length, 1)
  assert.equal(f.calls.some(c => /dig_down|tunnel|mine_seen|refuge|wait/.test(c.method)), false)
})
test('R6: a carried dawn kit preserves C8 cover and lighting before smelting', async () => {
  const f = carriedKit({ ND_IRON_FINISH_HERE: '1', ND_NIGHT_WORK_SAFE: '1' })
  f.ctx.sit.work = { sealed: false, floor: true, walls: 2, roof: true, block: 0, sky: 0, coverSeconds: .66 }
  f.ctx.sit.fight = { order: [] }; f.inventory.torch = 2
  const act = f.ctx.act
  f.ctx.act = async (method, params) => {
    const r = await act(method, params)
    if (method === 'shelter' && params.mode === 'box') f.ctx.sit.work.sealed = true
    if (method === 'shelter' && params.mode === 'light') { f.ctx.sit.work.block = 12; f.inventory.torch-- }
    return r
  }
  f.ctx.smeltAll = async () => { f.calls.push({ method: 'smelt' }); f.inventory.raw_iron = 0; f.inventory.iron_ingot = 4 }
  assert.equal(!!f.ctx.here(), true)
  for (let i = 0; i < 3; i++) await f.ctx.work()
  assert.deepEqual(f.calls.filter(c => c.method === 'shelter' || c.method === 'smelt').map(c => c.params?.mode || c.method), ['box', 'light', 'smelt'])
  assert.equal(f.calls.some(c => /dig_down|tunnel|refuge|wait/.test(c.method)), false)
})
test('a healthy completed water kit works toward deep lava without iron or a timer', async () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) assert.equal((await f.ctx.work()).progress, true)
  assert.equal(f.calls.filter(c => c.method === 'dig_down').length, 3)
  assert.equal(f.calls.some(c => /refuge|wait|iron/.test(c.method)), false)
  assert.equal(f.ctx.state.pos.y, -20)
})

test('at the deep lava band the next leg is horizontal, never below the world', async () => {
  const f = fixture(); f.ctx.state.pos.y = -54
  await f.ctx.work()
  assert.equal(f.calls.some(c => c.method === 'dig_down'), false)
  assert.ok(f.calls.some(c => c.method === 'tunnel' && c.params.length === 16))
})

test('an empty water kit tries local water and searches its current band, not -54', async () => {
  const f = fixture(); delete f.inventory.water_bucket; f.inventory.bucket = 1
  await f.ctx.work()
  assert.ok(f.calls.some(c => c.method === 'kitWaterHere'))
  assert.ok(f.calls.some(c => c.method === 'tunnel'))
  assert.equal(f.calls.some(c => c.method === 'dig_down'), false)
})

test('no kit descends for iron; held gravel is ground instead of another iron stage', async () => {
  const f = fixture(); delete f.inventory.water_bucket; delete f.inventory.flint_and_steel; f.inventory.gravel = 2; f.inventory.iron_ingot = 1
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); if (method === 'flint_grind') { f.inventory.flint = 1; f.inventory.gravel-- }; return { status: 'done', detail: {} } }
  await f.ctx.work()
  assert.equal(f.calls.at(-1).method, 'flint_grind')
  const iron = fixture(); delete iron.inventory.water_bucket; delete iron.inventory.flint_and_steel; iron.ctx.state.pos.y = 40
  await iron.ctx.work()
  assert.ok(iron.calls.some(c => c.method === 'dig_down' && c.params.depth === 12))
})

test('existing pick durability is usable with no new wood gate', async () => {
  const f = fixture(); assert.equal(f.ctx.have('stick'), 0)
  await f.ctx.work()
  assert.ok(f.calls.some(c => c.method === 'dig_down'))
})

test('refused geometry stays refused after time, unrelated coal and health changes', async () => {
  const f = fixture(); f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { status: 'done', detail: method === 'dig_down' || method === 'tunnel' ? { stopped: 'бедрок, нет пути' } : {} } }
  await f.ctx.work()
  const n = f.calls.filter(c => /dig_down|tunnel/.test(c.method)).length
  f.ctx.gameClock.now = () => 999999999; f.inventory.coal = 8; f.ctx.state.health = 19
  await f.ctx.work()
  assert.equal(f.calls.filter(c => /dig_down|tunnel/.test(c.method)).length, n)
  f.ctx.state.pos.x = 7.9; await f.ctx.work()
  assert.equal(f.calls.filter(c => /dig_down|tunnel/.test(c.method)).length, n)
  f.ctx.state.pos.x = 8; await f.ctx.work()
  assert.ok(f.calls.filter(c => /dig_down|tunnel/.test(c.method)).length > n)
  assert.ok(f.logs.some(s => s.includes('нет доступной работы') && s.includes('бедрок')))
})

test('a new genuinely seen lava offers casting after search refusals', async () => {
  const f = fixture(); f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { detail: /dig_down|tunnel/.test(method) ? { stopped: 'вода впереди' } : {} } }
  await f.ctx.work(); f.ctx.known.lava = { x: 2, y: 16, z: 0 }
  f.ctx.castForKit = async () => { f.calls.push({ method: 'castForKit' }); f.ctx.known.portal = { x: 2, y: 16, z: 0 }; return { status: 'done', detail: { lit: true } } }
  assert.equal((await f.ctx.work()).progress, true)
  assert.equal(f.calls.at(-1).method, 'castForKit')
})

test('fresh sound chooses a direction, never an invented exact lava target', async () => {
  const f = fixture()
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { status: 'done', detail: params.listen ? { heard: [{ dir: 'east', flat: 6, height: 0, dist: 6 }] } : method === 'tunnel' ? { walked: 9, dug: 18 } : {} } }
  await f.ctx.work()
  assert.ok(f.calls.some(c => c.method === 'tunnel' && c.params.direction === 'east'))
  assert.equal(f.ctx.known.lava, undefined)
  assert.equal(f.ctx.heardLava.dir, 'east')
})

test('new visible lava sources reconsider a cast refused at the same coordinates', async () => {
  const f = fixture(); f.ctx.known.lava = { x: 2, y: 16, z: 0 }
  let count = 4, cast = 0
  f.ctx.castForKit = async () => { cast++; return { status: 'done', detail: { stopped: 'лавы со столба не достать' } } }
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { status: 'done', detail: method === 'observe'
    ? { blocks: [{ name: 'lava', nearest: f.ctx.known.lava, count }] } : /tunnel|dig_down/.test(method) ? { stopped: 'нет пути' } : {} } }
  await f.ctx.work(); await f.ctx.work(); assert.equal(cast, 1)
  count = 6; await f.ctx.work(); assert.equal(cast, 2)
})

test('a tactical interruption yields before any further physical night step', async () => {
  const f = fixture(); f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { status: 'interrupted', detail: {} } }
  assert.equal((await f.ctx.work()).progress, false)
  assert.equal(f.calls.length, 1)
})

test('a failed spare craft also needs a changed cause before it can repeat', async () => {
  const f = fixture(); f.ctx.sit.pickLeft = 30; let crafts = 0
  f.ctx.spares = async () => { crafts++ }
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { detail: /tunnel|dig_down/.test(method) ? { stopped: 'нет пути' } : {} } }
  await f.ctx.work(); await f.ctx.work(); assert.equal(crafts, 1)
  f.inventory.stick = 2; await f.ctx.work(); assert.equal(crafts, 2)
})

test('visible iron is used before another blind tunnel and is not scanned through walls', async () => {
  const f = fixture(); delete f.inventory.water_bucket; delete f.inventory.flint_and_steel
  f.ctx.call = async () => ({ detail: { spots: [{ name: 'iron_ore', at: { x: 1, y: 16, z: 1 }, fromMe: 2, why: 'стена штрека' }] } })
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); if (method === 'mine_seen') f.inventory.raw_iron = 4; return { status: 'done', detail: {} } }
  await f.ctx.work()
  assert.equal(f.calls.at(-1).method, 'mine_seen')
  assert.equal(f.calls.at(-1).params.at.x, 1)
})

test('portal is an immediate alternative to overnight mining when ready', async () => {
  const f = fixture(); f.ctx.known.portal = { x: 3, y: 16, z: 0 }
  assert.equal((await f.ctx.work()).progress, true)
  assert.equal(f.calls.at(-1).method, 'enterNether')
  assert.equal(f.calls.some(c => c.method === 'dig_down'), false)
})

test('unready portal uses remaining local preparation, then explains the lack of work', async () => {
  const f = fixture(); f.ctx.known.portal = { x: 3, y: 16, z: 0 }; f.ctx.READY.nether = () => false
  f.inventory.shield = 1; f.inventory.iron_pickaxe = 1; f.inventory.stone_pickaxe = 2; f.inventory.coal = 2
  await f.ctx.work()
  assert.equal(f.calls.some(c => /dig_down|tunnel/.test(c.method)), false)
  assert.ok(f.logs.some(s => s.includes('нет доступной работы') && s.includes('еда')))
})

test('on the surface the worker leaves shelter construction to the existing night guard', async () => {
  const f = fixture(); f.ctx.sit.surface = true
  assert.equal(await f.ctx.work(), null)
  assert.equal(f.calls.length, 0)
})

test('OFF returns to the original night branch without any calls', async () => {
  const f = fixture({ ND_NIGHT_WORK: '0' })
  assert.equal(await f.ctx.work(), null); assert.equal(f.ctx.here(), false); assert.equal(f.calls.length, 0)
})

function safeFixture() {
  const f = fixture({ ND_NIGHT_WORK_SAFE: '1' })
  f.ctx.sit.work = { sealed: true, floor: true, walls: 4, roof: true, block: 0, sky: 0, coverSeconds: .66 }
  f.ctx.sit.fight = { order: [] }
  return f
}
test('C8: no useful work waits in place without calling moving refuge, even at full hp', async () => {
  const f = safeFixture()
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { detail: /dig_down|tunnel/.test(method) ? { stopped: 'бедрок' } : {} } }
  await f.ctx.work(); await f.ctx.work()
  assert.equal(f.calls.some(c => c.method === 'refuge' || c.method === 'shelter'), false)
  assert.ok(f.calls.some(c => c.method === 'wait'))
  assert.deepEqual(f.ctx.state.pos, { x: 0, y: 16, z: 0 })
})
test('C8: healing uses regeneration behind cover without selecting flee or pillar', async () => {
  const f = safeFixture(); f.ctx.state.health = 12
  const act = f.ctx.act; f.ctx.act = async (method, params) => { const r = await act(method, params); if (method === 'wait') f.ctx.state.health++; return r }
  await f.ctx.work()
  assert.equal(f.calls.at(-1).method, 'wait')
  assert.equal(f.calls.at(-1).params.seconds, 5)
  assert.equal(f.calls.some(c => c.method === 'refuge'), false)
})
test('C8: a distant remembered water source uses a guarded excavation, never a long goto', async () => {
  const f = safeFixture(); delete f.inventory.water_bucket; f.inventory.bucket = 1
  f.ctx.knownWater = { x: 25, y: 4, z: 0 }
  await f.ctx.work()
  assert.ok(f.calls.some(c => c.method === 'bucket' && c.params.walk === false && c.params.radius === 4))
  assert.ok(f.calls.some(c => c.method === 'dig_down' && c.params.maxFallHp === 0))
  assert.equal(f.calls.some(c => /goto|kitWaterHere/.test(c.method)), false)
})
test('C8: exposed dark casting first closes in place; a lit open cast remains possible by price', async () => {
  const f = safeFixture(); f.ctx.known.lava = { x: 2, y: 16, z: 0 }
  f.ctx.sit.work = { sealed: false, floor: true, walls: 0, roof: false, block: 0, sky: 0, coverSeconds: 2 }
  const act = f.ctx.act; f.ctx.act = async (method, params) => { const r = await act(method, params); if (method === 'shelter') { f.ctx.sit.work.sealed = true; f.inventory.cobblestone -= 8 }; return r }
  await f.ctx.work()
  assert.equal(f.calls.at(-1).method, 'shelter')
  assert.equal(f.calls.at(-1).params.mode, 'box')
  assert.equal(f.calls.some(c => c.method === 'castForKit' || c.method === 'refuge'), false)
  const lit = safeFixture(); lit.ctx.known.lava = { x: 2, y: 16, z: 0 }
  lit.ctx.sit.work = { ...f.ctx.sit.work, block: 14 }
  await lit.ctx.work()
  assert.ok(lit.calls.some(c => c.method === 'castForKit'))
})
test('C8: risk refusal is not retried after elapsed time; changed light reopens the decision', async () => {
  const f = safeFixture()
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { detail: /dig_down|tunnel/.test(method) ? { stopped: 'NIGHT_RISK: открытая темнота' } : {} } }
  await f.ctx.work()
  const n = f.calls.filter(c => /dig_down|tunnel/.test(c.method)).length
  f.ctx.gameClock.now = () => 999999999
  await f.ctx.work()
  assert.equal(f.calls.filter(c => /dig_down|tunnel/.test(c.method)).length, n)
  f.ctx.sit.work.block = 12
  await f.ctx.work()
  assert.ok(f.calls.filter(c => /dig_down|tunnel/.test(c.method)).length > n)
})
test('C8: carried fuel makes torches before another dark leg; carried torches are placed', async () => {
  const f = safeFixture(); f.inventory.coal = 2; f.inventory.stick = 4
  let crafted = false; f.ctx.torches = async () => { crafted = true; f.inventory.torch = 8; f.inventory.coal = 0 }
  const act = f.ctx.act; f.ctx.act = async (method, params) => { const r = await act(method, params); if (method === 'shelter') { f.inventory.torch--; f.ctx.sit.work.block = 12 }; return r }
  await f.ctx.work(); assert.equal(crafted, true)
  await f.ctx.work()
  assert.equal(f.calls.at(-1).method, 'shelter')
  assert.equal(f.calls.at(-1).params.mode, 'light')
})

test('dawn keeps only nearby feasible portal work, not an unfinished blind deep descent', () => {
  const f = fixture(); assert.equal(f.ctx.here(), false)
  f.ctx.known.lava = { x: 2, y: 16, z: 0 }; assert.equal(f.ctx.here(), true)
  f.ctx.known.lava.x = 200; assert.equal(f.ctx.here(), false)
})

test('known reachable lava is priced against the whole remaining deep search, not one cheap digging leg', async () => {
  const f = fixture(); f.ctx.known.lava = { x: 40, y: 16, z: 0 }
  f.ctx.approachCastLava = async () => { f.calls.push({ method: 'approachCastLava' }); f.ctx.state.pos.x = 37 }
  assert.equal((await f.ctx.work()).progress, true)
  assert.equal(f.calls.at(-1).method, 'approachCastLava')
  assert.equal(f.calls.some(c => c.method === 'dig_down'), false)
})

test('a health refusal is reconsidered after actual healing, not after a clock jump', async () => {
  const f = fixture(); f.ctx.state.health = 5; f.ctx.state.food = 9
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { detail: /tunnel|dig_down/.test(method) ? { stopped: 'хп 5 — работу бросаю' } : {} } }
  await f.ctx.work(); const n = f.calls.filter(c => /tunnel|dig_down/.test(c.method)).length
  f.ctx.gameClock.now = () => 999999; await f.ctx.work()
  assert.equal(f.calls.filter(c => /tunnel|dig_down/.test(c.method)).length, n)
  f.ctx.state.health = 8; await f.ctx.work()
  assert.ok(f.calls.filter(c => /tunnel|dig_down/.test(c.method)).length > n)
})

test('losing the last pick underground does not send a held night into surface hunting', () => {
  const start = source.indexOf('const nightHold ='), end = source.indexOf('\n//', start)
  const ctx: any = { dim: () => 'overworld', sit: { night: true, surface: false }, state: { playPolicy: { mode: 'speedrun' } },
    armorPointsNow: () => 0, have: () => 0, nightHeld: true, process: { env: {} } }
  vm.runInNewContext(source.slice(start, end) + '\nthis.hold=nightHold', cjsContext(withSetters(ctx)))
  assert.equal(ctx.hold(), true)
  ctx.process.env.ND_NIGHT_WORK = '0'; assert.equal(ctx.hold(), false)
  delete ctx.process.env.ND_NIGHT_WORK; ctx.sit.night = false; assert.equal(ctx.hold(), false)
})

test('the main night loop calls the worker before the old timed branch', () => {
  const a = source.indexOf('if (!died && nightHold()) {', source.indexOf('async function loopNight (')) // ночь хода — campaign/loop/night
  const b = source.indexOf('if (only && dim()', a)
  const main = source.slice(a, b)
  assert.ok(main.indexOf('await nightWorkStep()') >= 0)
  assert.ok(main.indexOf('await nightWorkStep()') < main.indexOf('gameClock.now() >= nightCastAt'))
  assert.match(main, /nightWorkEnabled[\s\S]*if \(worked\)[\s\S]*continue/)
})

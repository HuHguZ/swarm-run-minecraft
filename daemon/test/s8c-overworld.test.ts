'use strict'
import { bodySource } from './source-fixture'
import { cjsContext } from './cjs-context'
// S8c (07.10, верхний мир «новый мир → Ад», продолжение S8b).
import test = require('node:test')
import assert = require('node:assert')
import route = require('../src/route')

const SEED = '3816274920780408390' // есть скан farm/route-scan/<сид>.json и строка good-v2

function withEnv (env: Record<string, string | undefined>, fn: () => void) {
  const old: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  try { fn() } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k] } }
}

test('знание карты: struct — постройки и лава, без руды/гравия/воды/деревьев скана; blocks — всё; 0 и по умолчанию — ничего', () => {
  withEnv({ ND_MAP: undefined, ND_KNOWLEDGE: undefined }, () => assert.strictEqual(route.routeInfo(SEED), null))
  withEnv({ ND_MAP: 'struct' }, () => {
    const i = route.routeInfo(SEED)
    assert.strictEqual(i.map, 'struct')
    for (const k of ['iron', 'ironBuried', 'gravel', 'gravelBuried', 'water', 'trees', 'coal', 'animals']) assert.deepStrictEqual(i.ores[k], [], k)
    assert.ok(i.ores.chests.length > 0 && i.ores.lava.length > 0 && i.ores.structures.length > 0, 'сундуки, лава и коробки построек остаются')
    assert.ok(i.ores.wood.every((w: any) => w.in), 'дерево — только построек')
    const p = route.plan(i)
    assert.ok(!p.steps.some((s: any) => s.kind === 'ore'), 'жил скана в плане нет')
    const wood = p.steps.find((s: any) => s.kind === 'wood')
    assert.ok(!wood || wood.src === 'village' || wood.src === 'mapwood' || !wood.at, 'роща не из скана')
    assert.match(route.describe(p), /карта struct/)
  })
  withEnv({ ND_MAP: 'blocks' }, () => {
    const i = route.routeInfo(SEED)
    assert.strictEqual(i.map, 'blocks')
    assert.ok(i.ores.iron.length > 0 && i.ores.trees.length > 0 && i.ores.water.length > 0)
  })
  withEnv({ ND_MAP: '0' }, () => assert.strictEqual(route.routeInfo(SEED), null))
})

test('копка маршрута — цена и риск: враги вычитаются ожидаемым уроном, вода — только для копки, завалило — сперва откопаться', () => {
  // Одиночный зомби (урон ~3) при 20 хп — копать; толпа/крипер (урон 25) — сперва ответ угрозе.
  assert.strictEqual(route.routeActRisk({ hp: 20, canEat: true, foeDamage: 3, digging: true }).refuse, false)
  const crowd = route.routeActRisk({ hp: 20, canEat: true, foeDamage: 25, digging: true })
  assert.strictEqual(crowd.refuse, true)
  assert.match(crowd.why, /урон врагов 25/)
  // Вода: копка — выйти дешевле; спуск goto в воде — как есть.
  assert.strictEqual(route.routeActRisk({ hp: 20, canEat: true, inWater: true, digging: true }).refuse, true)
  assert.strictEqual(route.routeActRisk({ hp: 20, canEat: true, inWater: true, digging: false }).refuse, false)
  assert.strictEqual(route.routeActRisk({ hp: 20, canEat: true, buried: true }).refuse, true)
  // Прежний порог 13 больше не запрет: хп 8 с едой — копать (регенерация по ходу), полсердца — лечение.
  assert.strictEqual(route.routeActRisk({ hp: 8, canEat: true, digging: true }).refuse, false)
  assert.strictEqual(route.routeActRisk({ hp: 0.5, canEat: true, digging: true }).refuse, true)
})

test('вслепую с ведром, огнивом и водой, лава неизвестна: граф ищет лаву, а не алмазы (цены запасного пути по телеметрии)', () => {
  const { emptyWorld, knows }: typeof import('../src/core/world-state') = require('../src/core/world-state')
  const { speedrunRegistry }: typeof import('../src/core/speedrun') = require('../src/core/speedrun')
  const { plan }: typeof import('../src/core/strategy') = require('../src/core/strategy')
  const w = emptyWorld()
  w.resources = { stone_tool: 1, bucket: 1, lighter: 1, water: 1, iron: 3, food: 6 }
  const steps = plan(speedrunRegistry(), w, (s: any) => knows(s, 'portal')).steps.map((s: any) => s.id)
  assert.deepStrictEqual(steps, ['ScoutLava', 'LavaPoolPortal'])
  const reg = speedrunRegistry()
  assert.ok(reg.get('AcquireDiamondPick').estimateRisk(w) > 0.3, 'смерть в алмазном этапе 16 из 46')
})

test('постройки — ценой против копки: без руды по карте деревня в 215 м в плане; с рудой скана — прежний бюджет 180 с', () => {
  const seed = '8324584926638139164' // деревня 214 м от спавна (seedtool), вне квадрата скана
  withEnv({ ND_MAP: 'struct' }, () => {
    const p = route.plan(route.routeInfo(seed))
    assert.ok(p.steps.some((s: any) => s.kind === 'village'), route.describe(p))
    assert.ok(p.structureBudgetSeconds >= 600, 'бюджет построек — цена копки: ' + p.structureBudgetSeconds)
  })
  withEnv({ ND_MAP: 'blocks' }, () => {
    const p = route.plan(route.routeInfo(seed))
    assert.strictEqual(p.structureBudgetSeconds, 180)
  })
})

// Брёвна дерева — один подбор на дерево (скорость, S8c): копка 3 брёвен ствола — один collect, дальний ствол — второй.
function mineFixture (logs: Array<[number, number, number]>) {
  const fs: typeof import('node:fs') = require('node:fs'), path: typeof import('node:path') = require('node:path'), vm: typeof import('node:vm') = require('node:vm')
  const { createRequire }: typeof import('node:module') = require('node:module')
  const Vec3: typeof import('vec3').Vec3 = require('vec3')
  const file = path.join(__dirname, '../src/actions.js')
  const realRequire = createRequire(file)
  const blocks = logs.map(([x, y, z]) => ({ name: 'oak_log', position: new Vec3(x, y, z), type: 1 }))
  const moves = { dug: [] as any[], collections: [] as any[] }
  const bot = { entity: { position: new Vec3(0.5, 60, 1.5) }, canDigBlock: () => true, blockAt: () => ({ name: 'air' }),
    dig: async (b: any) => { moves.dug.push(b.position); blocks.splice(blocks.indexOf(b), 1) } }
  const context = { module: { exports: {} as Record<string, any> }, console, Date, setTimeout, clearTimeout, moves, process,
    require: (name: string) => {
      const actual = realRequire(name)
      if (name === './items') return { ...actual, resolveBlockIds: () => [1], countItems: () => ({}), missingHarvestTool: () => null, equipBestTool: async () => {} }
      if (name === './sight') return { ...actual, visibleOf: (_b: any, _i: any, _r: any, opts: any) => blocks.filter(b => !opts.skip(b.position)) }
      return actual
    } }
  vm.runInNewContext(bodySource(file) + `
    underFeet = () => [];
    collectNearbyDrops = async (_bot, _ctl, o) => { moves.collections.push(o && o.from ? o.from.x : null); };
  `, cjsContext(context))
  const session = { bot, mcData: {}, cfg: { fairPlay: true } }
  return { moves, mine: (p: any) => context.module.exports.mine(session, { aborted: false, onAbort: [] }, p) }
}
test('подбор одним заходом: брёвна — один на ствол, дальний ствол — свой подбор; ND_MINE_BATCH=0 — после каждого', async () => {
  const f = mineFixture([[0, 60, 0], [0, 61, 0], [0, 62, 0], [10, 60, 0]])
  const r = await f.mine({ block: 'any_log', count: 4 })
  assert.strictEqual(r.dug, 4)
  assert.deepStrictEqual(f.moves.collections, [0, 10])
  // Земля/камень — так же; руда — после каждого блока (пещеры, лава рядом).
  const st = mineFixture([[0, 60, 0], [1, 60, 0], [2, 60, 0]])
  await st.mine({ block: 'grass_block,dirt', count: 3 })
  assert.strictEqual(st.moves.collections.length, 1)
  const ore = mineFixture([[0, 60, 0], [1, 60, 0]])
  await ore.mine({ block: 'iron_ore,deepslate_iron_ore', count: 2 })
  assert.strictEqual(ore.moves.collections.length, 2)
  process.env.ND_MINE_BATCH = '0'
  try {
    const g = mineFixture([[0, 60, 0], [0, 61, 0]])
    await g.mine({ block: 'any_log', count: 2 })
    assert.strictEqual(g.moves.collections.length, 2)
  } finally { delete process.env.ND_MINE_BATCH }
})

test('вслепую: план из увиденного — деревня по взгляду в плане, лавы не видно — разведка лавы, увидел лаву — литьё к ней', () => {
  const spawn = { x: 0, z: 0 }
  const none = route.plan(route.seenInfo({ spawn }))
  const ids = none.steps.map((s: any) => s.kind)
  assert.ok(ids.includes('scoutLava') && !ids.includes('castDeep'), ids.join(','))
  assert.ok(ids.includes('mine'), 'железо без построек — видимая руда')
  withEnv({ ND_ROUTE_SCOUTIRON: '1' }, () => {
    const afterMine = route.plan(route.seenInfo({ spawn }), { avoid: ['mine'] }).steps.map((s: any) => s.kind)
    assert.ok(afterMine.includes('scoutIron') && !afterMine.includes('ironStage'), 'руды на виду нет — разведка построек раньше штреков: ' + afterMine.join(','))
  })
  assert.ok(!route.plan(route.seenInfo({ spawn }), { avoid: ['mine'] }).steps.some((s: any) => s.kind === 'scoutIron'), 'по умолчанию разведки нет')
  assert.strictEqual(ids.indexOf('lookout'), ids.indexOf('stone') + 1, 'осмотр со столба — сразу после камня')
  assert.ok(!route.plan(route.seenInfo({ spawn }), { done: ['lookout'] }).steps.some((s: any) => s.kind === 'lookout'))
  const seen = route.seenInfo({ spawn, structures: [{ kind: 'village', at: { x: 120, y: 70, z: 40 }, dist: 126 }, { kind: 'village', at: { x: 9, z: 9 }, done: true }],
    lava: { x: 60, y: 64, z: -30, sky: true } })
  const p = route.plan(seen)
  const v = p.steps.find((s: any) => s.kind === 'village')
  assert.ok(v && v.at.x === 120, route.describe(p))
  assert.ok(p.steps.some((s: any) => s.kind === 'castSky' && s.at.x === 60), route.describe(p))
  assert.strictEqual(p.map, 'blind')
  withEnv({ ND_MAP: undefined, ND_KNOWLEDGE: 'ssg' }, () => assert.strictEqual(route.mapLevel(), 'struct'))
  withEnv({ ND_MAP: undefined, ND_KNOWLEDGE: undefined }, () => assert.strictEqual(route.mapLevel(), 'blind'))
})

test('вслепую: лава поверху и в пещере — обе в кандидатах; поверху не вышло — к пещерной', () => {
  const i = route.seenInfo({ spawn: { x: 0, z: 0 }, lava: { x: 50, y: 70, z: 0, sky: true }, cave: { x: -40, y: 14, z: 10, sky: false } })
  const p = route.plan(i)
  const sky = p.steps.find((s: any) => s.kind === 'castSky')
  assert.ok(sky && sky.at.x === 50, route.describe(p))
  const q = route.plan(i, { avoid: [sky.id] })
  assert.ok(q.steps.some((s: any) => s.kind === 'castCave' && s.at.x === -40), route.describe(q))
})

test('вслепую: лава у первой не вышла — разведка засчитывает только новую, и она идёт в план вместо прежней', async () => {
  const { createOverworldRoute }: typeof import('../src/campaign/overworld-route') = require('../src/campaign/overworld-route')
  const avoid = new Set<string>()
  const calls: string[] = []
  const ctx: Record<string, any> = {
    ROUTE: true, process: { env: { ND_ROUTE: '1', ND_ROUTE_LAVADIG: '0', ND_ROUTE_LAKES: '0' } }, routeMod: route, routeAvoid: avoid, died: false,
    state: { pos: { x: 0, y: 70, z: 0 } }, sit: { surface: true, night: false }, known: { lava: { x: 30, y: 70, z: 0 } }, skyLavaSeen: null, heardLava: null,
    routeInfoV: undefined, rlog: () => {}, sense: async () => {}, refresh: async () => {}, have: () => 0,
    act: async (m: string, p: any) => {
      calls.push(m)
      if (m === 'explore') return { status: 'done', detail: { found: 'lava', at: { x: -80, y: 66, z: 20 } } }
      if (m === 'structure') return { status: 'done', detail: { known: [] } }
      return { status: 'done', detail: {} }
    }
  }
  const r = createOverworldRoute(ctx)
  ctx.routeInfoGet = r.routeInfoGet
  await r.routeSeenRefresh()
  assert.strictEqual(ctx.routeInfoV.sky.x, 30, 'сперва — известная лава поверху')
  avoid.add('lava:sky:30,0')
  assert.strictEqual(await r.routeStep({ kind: 'scoutLava' }), true, 'новая лава — успех')
  await r.routeSeenRefresh()
  assert.strictEqual(ctx.routeInfoV.sky.x, -80, 'в плане — новая, прежняя не вышла')
  calls.length = 0
  assert.strictEqual(await r.routeStep({ kind: 'scoutLava' }), false, 'та же лава снова — не новая')
})

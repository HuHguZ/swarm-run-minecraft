'use strict'
// S8 (07.10, верхний мир «новый мир → Ад»): выбор лавы по ожидаемой цене, маршрут без кровати в спидране.
const test = require('node:test')
const assert = require('node:assert')
const route = require('../src/route')

const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
  const old: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  try { fn() } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k] } }
}

// Озеро поверху в 300 м и глубокая закрытая пещера в 30 м; лава у руин рядом.
const info = {
  seed: '1', spawn: { x: 0, z: 0 }, rp: null, village: null, ship: null, treasure: null,
  sky: { x: 300, y: 64, z: 0, cls: 'surface', src: 90, d: 300 },
  lava: { x: 20, y: 70, z: 10, cls: 'rp', depth: 0, src: 14, d: 22 },
  ores: { v: 6, lava: [{ x: 30, y: 40, z: 0, depth: 16, top: 50, openTop: 0 }] }
}

test('castOdds: руины ≈ 0, глубокая пещера < озеро поверху < неглубокая пещера', () => {
  assert.ok(route.castOdds('sky', 'rp', 0, 14) < 0.05)
  assert.ok(route.castOdds('cave', 'closed-cave', 16, 50) < route.castOdds('sky', 'surface', 0, 90))
  assert.ok(route.castOdds('sky', 'surface', 0, 20) < route.castOdds('sky', 'surface', 0, 90))
})

test('ND_ROUTE_LAVAP (умолчание): дальнее озеро поверху раньше ближней глубокой пещеры и лавы у руин; =0 — прежний порядок', () => {
  withEnv({ ND_ROUTE_LAVAP: '1' }, () => {
    const c = route.lavaCands(info, { x: 0, z: 0 })
    assert.strictEqual(c[0].kind, 'sky')
    assert.strictEqual(c[0].cls, 'surface', JSON.stringify(c.map(x => [x.id, Math.round(x.cost)])))
    assert.strictEqual(c[c.length - 1].cls, 'rp')
  })
  withEnv({ ND_ROUTE_LAVAP: '0' }, () => {
    const c = route.lavaCands(info, { x: 0, z: 0 })
    assert.strictEqual(c[0].cls, 'rp', JSON.stringify(c.map(x => [x.id, Math.round(x.cost)])))
  })
})

test('цена, не флаг: в верхнем мире с картой граф сам берёт маршрут по карте (RuinedPortal — по цене этапа cast), после двух провалов — кусочные стратегии', async () => {
  const { createCampaignIntelligence } = require('../src/campaign/intelligence')
  const { modelFor } = require('../src/core/cost-model')
  const known = { status: 'known', value: true, source: 'observed', at: 0, confidence: 1 }
  const records: any[] = []
  const intelligence = createCampaignIntelligence({
    eyes: 10, beds: 0, now: () => 0,
    observe: async () => ({ state: { dimension: 'overworld', health: 20, food: 20, inventory: {} }, facts: { ruined_portal: known, village: known } }),
    call: async () => ({}), sleep: async () => {}, record: (r: any) => records.push(r),
    execute: async () => ({ outcome: 'FAILURE', events: [] })
  })
  // Цена RuinedPortal — из этапа, который он исполняет (cast), а не из шага маршрута ruin (только сундук, 512 тиков).
  const models = new Map(require('../src/environments/cost-data').loadCosts().map((m: any) => [m.key, m]))
  const ruined = intelligence.registry.get('RuinedPortal')
  const state = { dimension: 'overworld', health: 20 }
  assert.ok(['RuinedPortal', 'cast'].includes(String(modelFor(ruined, state, models)?.key).split('@')[0]), String(modelFor(ruined, state, models)?.key))
  const stage = (name: string) => ({ name, needed: () => true, ready: () => true, defer: () => false, done: () => false, run: async () => {} })
  const stages = [stage('wood'), stage('stone'), stage('route')]
  for (let i = 0; i < 2; i++) {
    const s = await intelligence.select(stages, () => false)
    assert.strictEqual(s.strategy.id, 'MappedOverworldRoute', JSON.stringify(records.filter(r => r.level === 'decision').pop()?.alternatives))
    await s.stage.run()
  }
  assert.ok(!records.some(r => /ND_ROUTE_FIRST/.test(String(r.reason))), 'выбор — решением графа, не флагом')
  const next = await intelligence.select(stages, () => false)
  assert.notStrictEqual(next?.strategy?.id, 'MappedOverworldRoute')
})

test('ND_ROUTE_CAVEDOWN=1: пещерная лава на 12 ниже тела — сперва колодец вниз, литьё сверху не пробуется', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  const work: string[] = []
  let y = 80
  const ctx: any = {
    process: { env: { ND_ROUTE_CAVEDOWN: '1' } }, died: false, state: { pos: { x: 0, y: 80, z: 0 } }, known: {},
    have: (p: any) => (String(p).includes('bucket') ? 1 : 0), refresh: async () => {}, y: () => y,
    routeWater: async () => true, routeBlocks: async () => true, routeBlockTarget: () => 12, routeGo: async () => true, fillerCount: () => 20,
    castOneAt: async () => { work.push(`cast@${y}`); return y <= 70 },
    descend: async (toY: number) => { work.push(`descend ${toY}`); y = toY + 1 }
  }
  const route = createOverworldRoute(ctx)
  Object.assign(ctx, { castOneAt: ctx.castOneAt })
  const ok = await route.routeStep({ kind: 'castCave', at: { x: 5, y: 68, z: 5 } })
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(work, ['descend 69', 'cast@70'])
})

test('еда маршрута: без топлива сырое не жарится (не копать печь впустую); вода на виду — в ведро без крюка к карте', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  const work: string[] = []
  const bag: Record<string, number> = { beef: 8, furnace: 1, oak_log: 2, oak_planks: 3, bucket: 1 }
  const have = (p: any) => Object.entries(bag).filter(([k]) => (p instanceof RegExp ? p.test(k) : p === k)).reduce((n, [, v]) => n + v, 0)
  const ctx: any = {
    process: { env: {} }, died: false, state: { pos: { x: 0, y: 64, z: 0 } }, sit: { surface: true }, known: {},
    RAW: /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/, LOGS: /_log$/, have, refresh: async () => {}, sense: async () => {},
    craft: async () => {}, cook: async () => { work.push('cook') }, routeCookHunger: () => 12,
    act: async (m: string, p: any) => { work.push(`${m}:${p.radius ?? ''}`); if (m === 'bucket') { bag.water_bucket = 1; bag.bucket = 0 } return { status: 'done', detail: {} } },
    routeGo: async () => { work.push('routeGo'); return true }
  }
  const route = createOverworldRoute(ctx)
  await route.routeFood()
  assert.deepStrictEqual(work, [])
  bag.oak_log = 6
  await route.routeFood()
  assert.deepStrictEqual(work, ['cook'])
  work.length = 0
  assert.strictEqual(await route.routeStep({ kind: 'water', at: { x: 200, z: 0 } }), true)
  assert.deepStrictEqual(work, ['bucket:24'])
})

test('ND_ROUTE_CAVEDOWN=1: озеро под холмом — castOneAt сперва колодцем к уровню лавы, потом литьё', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  const work: string[] = []
  let y = 90
  const ctx: any = {
    process: { env: { ND_ROUTE_CAVEDOWN: '1' } }, died: false, state: { pos: { x: 0, y: 90, z: 0 } }, sit: { night: false, surface: true }, known: {},
    refresh: async () => {}, sense: async () => {}, readMemory: async () => {}, rlog: () => {}, y: () => y,
    routeGo: async () => true, routeGoPush: async () => true,
    descend: async (toY: number) => { work.push(`descend ${toY}`); y = toY + 1 },
    act: async (m: string) => { work.push(`${m}@${y}`); if (m === 'portal') { ctx.known.portal = { x: 1, y: 67, z: 1 }; return { status: 'done', detail: { lit: true } } } return { status: 'done', detail: {} } }
  }
  const route = createOverworldRoute(ctx)
  assert.strictEqual(await route.castOneAt({ x: 30, y: 66, z: 30 }), true)
  assert.deepStrictEqual(work, ['goto@90', 'descend 67', 'portal@68'])
})

test('дерево по карте: тело на кронах выше стволов — лесенкой вниз к ним и снова брёвна', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  const work: string[] = []
  let y = 91
  let logs = 0
  const ctx: any = {
    process: { env: { ND_ROUTE_WOODN: '6' } }, died: false, state: { pos: { x: 0, y: 91, z: 0 } }, known: {},
    have: (p: any) => (String(p).includes('pickaxe') && logs >= 6 ? 1 : 0), refresh: async () => {}, y: () => y, woodNow: () => logs,
    routeLeaveOutpost: async () => {}, routeGo: async () => true, planksFor: () => 'oak_planks', craft: async () => true,
    routeInfoGet: () => null, routeMod: {}, stageRun: () => async () => {}, rlog: () => {},
    act: async (m: string, p: any) => {
      work.push(m === 'dig_down' ? `dig_down ${p.depth}` : `${m}@${y}`)
      if (m === 'dig_down') y -= p.depth
      if (m === 'mine' && y <= 84) logs = 6
      return { status: 'done', detail: {} }
    }
  }
  const route = createOverworldRoute(ctx)
  await route.routeStep({ kind: 'wood', src: 'mapwood', at: { x: 5, y: 83, z: 5 } })
  // S8b: к стволу — клетки рядом с ним (до 3), тело всё ещё на кронах — дальше прежний ход: брёвна, вниз, брёвна.
  assert.deepStrictEqual(work.slice(0, 6), ['goto@91', 'goto@91', 'goto@91', 'mine@91', 'dig_down 8', 'mine@83'])
})

test('литьё: вода кончилась посреди рамы — набрать воду и продолжить ту же раму', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  const work: string[] = []
  let calls = 0
  const ctx: any = {
    process: { env: {} }, died: false, state: { pos: { x: 30, y: 67, z: 30 } }, sit: { night: false, surface: true }, known: {},
    refresh: async () => {}, sense: async () => {}, readMemory: async () => {}, rlog: () => {}, y: () => 67,
    have: (p: any) => (p === 'bucket' ? 1 : 0),
    routeGo: async () => { work.push('routeGo'); return true }, routeWater: async () => { work.push('water'); return true },
    act: async (m: string) => {
      work.push(m)
      if (m === 'portal' && ++calls === 1) return { status: 'done', detail: { frame: '7/10 обсидиан', stopped: 'нет воды в ведре' } }
      if (m === 'portal') { ctx.known.portal = { x: 30, y: 67, z: 30 }; return { status: 'done', detail: { lit: true } } }
      return { status: 'done', detail: {} }
    }
  }
  const route = createOverworldRoute(ctx)
  assert.strictEqual(await route.castOneAt({ x: 31, y: 66, z: 31 }), true)
  assert.deepStrictEqual(work, ['portal', 'water', 'routeGo', 'portal'])
})

test('flint_grind: гравий у ног — ставит и копает до кремня, без ходьбы; клетки без пола — отказ', async () => {
  const Vec3 = require('vec3')
  const build = require('../src/build'); const items = require('../src/items'); const cast = require('../src/cast')
  const saved = [build.placeBlockAt, items.equipBestTool, cast._in.digVisible]
  const world = new Map<string, string>()
  const key = (p: any) => `${p.x},${p.y},${p.z}`
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) world.set(key({ x, y: 63, z }), 'stone')
  const inv: Record<string, number> = { gravel: 1 }
  let digs = 0
  const bot: any = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: (p: any) => { const n = world.get(key(p)) || 'air'; return { name: n, position: p, boundingBox: n === 'air' ? 'empty' : 'block' } },
    inventory: { items: () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })) }
  }
  build.placeBlockAt = async (_b: any, p: any) => { world.set(key(p), 'gravel'); inv.gravel--; return { ok: true } }
  items.equipBestTool = async () => {}
  cast._in.digVisible = async (_b: any, g: any) => { world.delete(key(g.position)); if (++digs === 3) inv.flint = 1; else inv.gravel++ }
  delete require.cache[require.resolve('../src/flint-grind')]
  try {
    const { flintGrind } = require('../src/flint-grind')
    const r = await flintGrind({ bot }, { aborted: false }, { max: 10, timeoutSeconds: 30 })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.tries, 3)
    world.clear()
    const r2 = await flintGrind({ bot }, { aborted: false }, {})
    assert.strictEqual(r2.ok, false)
    assert.match(r2.stopped, /некуда поставить/)
  } finally { [build.placeBlockAt, items.equipBestTool, cast._in.digVisible] = saved; delete require.cache[require.resolve('../src/flint-grind')] }
})

test('pathfinder: порошковый снег в blocksToAvoid (пустой по форме — тело вязло и замерзало)', () => {
  const worlds = require('../src/worlds')
  const reg = require('minecraft-data')('1.21.11')
  const movements: any = { blocksToAvoid: new Set(), blocksCantBreak: new Set(), getNeighbors: () => [] }
  const bot: any = { registry: reg, entity: { position: { y: 64 } }, game: { dimension: 'overworld' } }
  worlds.tuneMovements(bot, movements)
  assert.ok(movements.blocksToAvoid.has(reg.blocksByName.powder_snow.id))
  assert.ok(movements.blocksToAvoid.has(reg.blocksByName.nether_portal.id))
})

test('шаг еды (ND_ROUTE_FOODMAP=1, «со знанием стад»): стадо съедобных по скану с крюком ≤ 60 с и по высоте рядом — точка шага; без стада и по умолчанию — без точки', () => withEnv({ ND_ROUTE_FOODMAP: '1' }, () => {
  const base = { seed: '1', spawn: { x: 0, z: 0 }, rp: null, village: null, ship: null, treasure: null,
    sky: { x: 200, y: 64, z: 0, cls: 'surface', src: 90, d: 200 }, lava: null,
    ores: { v: 6, spawn: { x: 0, z: 0 }, half: 160, animals: [{ id: 'cow', x: 100, y: 65, z: 10 }, { id: 'cow', x: 104, y: 65, z: 12 }, { id: 'pig', x: 30, y: 140, z: 0 }, { id: 'pig', x: 33, y: 140, z: 2 }] } }
  const p = route.plan(base, { have: { stone_pickaxe: 1, bucket: 1, flint_and_steel: 1, water_bucket: 1 }, fromY: 64 })
  const food = p.steps.find(x => x.id === 'food')
  assert.ok(food && food.at && food.at.x > 90, JSON.stringify(food))
  const none = route.plan({ ...base, ores: { ...base.ores, animals: [] } }, { have: { stone_pickaxe: 1, bucket: 1, flint_and_steel: 1, water_bucket: 1 }, fromY: 64 })
  assert.ok(!none.steps.find(x => x.id === 'food').at)
  withEnv({ ND_ROUTE_FOODMAP: undefined }, () => {
    assert.ok(!route.plan(base, { have: { stone_pickaxe: 1, bucket: 1, flint_and_steel: 1, water_bucket: 1 }, fromY: 64 }).steps.find(x => x.id === 'food').at)
  })
}))

test('литьё: источники у берега — вперёд (ND_CAST1_EDGE), середина озера — после', () => {
  const Vec3 = require('vec3')
  const cast1 = require('../src/cast1')
  const blocks = new Map<string, any>()
  const put = (x: number, y: number, z: number, name: string) => blocks.set(`${x},${y},${z}`, { name, boundingBox: /air|lava/.test(name) ? 'empty' : 'block', position: new Vec3(x, y, z), shapes: /air|lava/.test(name) ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ level: 0 }) })
  for (let x = -2; x <= 8; x++) for (let z = -2; z <= 8; z++) put(x, 64, z, x >= 0 && x <= 6 && z >= 0 && z <= 6 ? 'lava' : 'stone')
  const bot: any = { blockAt: (p: any) => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || null }
  const lava: any[] = []
  for (let x = 3; x >= 0; x--) lava.push(new Vec3(x, 64, 3))
  const out = cast1.shoreFirst(bot, lava)
  assert.deepStrictEqual(out.map((p: any) => p.x), [0, 3, 2, 1])
})

test('ND_ROUTE_FURNDIR=1: печь — лесенка в воду не идёт, другая сторона и штрек дают булыжник', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  const work: string[] = []
  const bag: Record<string, number> = { cobblestone: 0 }
  const ctx: any = {
    process: { env: { ND_ROUTE_FURNDIR: '1' } }, died: false, state: { pos: { x: 0, y: 64, z: 0 } }, COBBLE: /^(cobblestone|cobbled_deepslate|blackstone)$/,
    have: (p: any) => Object.entries(bag).filter(([k]) => (p instanceof RegExp ? p.test(k) : p === k)).reduce((n, [, v]) => n + v, 0),
    refresh: async () => {}, furnaceBack: async () => {}, ensureTable: async () => {}, craft: async (n: string) => { work.push(`craft ${n}`); if (n === 'furnace') { bag.cobblestone -= 8; bag.furnace = 1 } return true },
    act: async (m: string, p: any) => {
      work.push(`${m}${p.direction ? ' ' + p.direction : ''}`)
      if (m === 'dig_down' && p.direction === 'north') return { status: 'done', detail: { steps: 0, stopped: 'вода у 1,62,0 — дальше не копаю' } }
      if (m === 'dig_down') { bag.cobblestone += 3; return { status: 'done', detail: { steps: 4 } } }
      if (m === 'tunnel') { bag.cobblestone += 6; return { status: 'done', detail: {} } }
      return { status: 'failed', detail: {} }
    }
  }
  const route = createOverworldRoute(ctx)
  assert.strictEqual(await route.routeFurnaceSupply(), true)
  assert.deepStrictEqual(work.filter(w => /dig_down|tunnel|furnace/.test(w)), ['dig_down north', 'dig_down east', 'tunnel', 'craft furnace'])
})

test('кремень: огниво скрафчено из первого кремня — гравий больше не копается (кремня 0 — не «нужен ещё»)', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  const work: string[] = []
  const bag: Record<string, number> = { iron_ingot: 1 }
  const have = (p: any) => Object.entries(bag).filter(([k]) => (p instanceof RegExp ? p.test(k) : p === k)).reduce((n, [, v]) => n + v, 0)
  const ctx: any = {
    process: { env: {} }, died: false, state: { pos: { x: 0, y: 64, z: 0 } }, known: {}, have, refresh: async () => {}, sense: async () => {}, rlog: () => {},
    lighter: () => have('flint_and_steel') > 0, routeGo: async () => true, ensureFlint: async () => { work.push('ensureFlint') },
    craft: async (n: string) => { work.push(`craft ${n}`); if (n === 'flint_and_steel') { bag.flint--; bag.iron_ingot--; bag.flint_and_steel = 1 } return true },
    act: async (m: string) => {
      work.push(m)
      if (m === 'mine') bag.gravel = (bag.gravel || 0) + 2
      if (m === 'flint_grind') { bag.flint = 1; return { status: 'done', detail: { tries: 3 } } }
      return { status: 'done', detail: { dug: 2 } }
    }
  }
  const route = createOverworldRoute(ctx)
  ctx.routeFlintFromBag = route.routeFlintFromBag
  assert.strictEqual(await route.routeStep({ kind: 'flint', at: { x: 5, y: 64, z: 5 } }), true)
  assert.strictEqual(work.filter(w => w === 'mine').length, 1, work.join(','))
})

test('flint_grind: стороны у ног заняты — гравий ставится по диагонали; сыпучий пол — только на твёрдом', () => {
  const Vec3 = require('vec3')
  const { grindSpot } = require('../src/flint-grind')
  const world = new Map<string, string>()
  const key = (p: any) => `${p.x},${p.y},${p.z}`
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) world.set(key({ x, y: 63, z }), 'gravel')
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) world.set(key({ x, y: 64, z }), 'gravel')
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: (p: any) => { const n = world.get(key(p)) || 'air'; return { name: n, position: p, boundingBox: n === 'air' ? 'empty' : 'block' } } }
  assert.strictEqual(grindSpot(bot), null, 'гравий на воздухе — нельзя')
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) world.set(key({ x, y: 62, z }), 'stone')
  const c = grindSpot(bot)
  assert.ok(c && Math.abs(c.x) === 1 && Math.abs(c.z) === 1, JSON.stringify(c))
})

test('дерево под плавку: в плане жила — 8 брёвен, железо из построек — по умолчанию (6)', () => {
  const base = { seed: '1', spawn: { x: 0, z: 0 }, rp: null, village: null, ship: null, treasure: null,
    sky: { x: 200, y: 64, z: 0, cls: 'surface', src: 90, d: 200 }, lava: null,
    ores: { v: 6, spawn: { x: 0, z: 0 }, half: 160, trees: [{ x: 20, y: 66, z: 0, n: 9 }], iron: [{ x: 60, y: 60, z: 0, n: 5, depth: 3, open: 3, wet: 0 }] } }
  const p = route.plan(base, { fromY: 64 })
  assert.ok(p.steps.some(x => x.kind === 'ore'), p.steps.map(x => x.id).join(','))
  assert.strictEqual(p.steps.find(x => x.kind === 'wood').logs, 8)
  const q = route.plan({ ...base, ores: { ...base.ores, iron: [] }, village: null }, { fromY: 64, have: { iron_ingot: 3, flint_and_steel: 1 } })
  const w = q.steps.find(x => x.kind === 'wood')
  assert.ok(!w || !w.logs, JSON.stringify(w))
})

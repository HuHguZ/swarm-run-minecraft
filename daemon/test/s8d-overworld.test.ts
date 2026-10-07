'use strict'
// S8d (07.10): верхний мир вслепую — честная лава (замечание «а»), озёра лавы, цена копки в воде и ночного отрезка («г»),
// риск голема против риска копки («д»), шаг «пещера» (железо в стенах пещеры по виду), explore без пути во все стороны.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const route = require('../src/route')
const { withClockFixture } = require('./clock-fixture')

test('озёра лавы: зеркало озера — цель, лавопад из одного источника — нет', () => {
  const lake = []
  for (let x = 0; x < 4; x++) for (let z = 0; z < 3; z++) lake.push({ x: 100 + x, y: 62, z: 50 + z })
  const fall = [{ x: -20, y: 80, z: 0 }, { x: -20, y: 79, z: 1 }, { x: -20, y: 78, z: 1 }, { x: -20, y: 77, z: 2 }, { x: -20, y: 76, z: 2 }, { x: -19, y: 76, z: 2 }]
  const L = route.lavaLakes([...fall, ...lake, { x: 300, y: 20, z: 300 }])
  assert.equal(L[0].level, 12, 'первым — озеро (12 клеток на уровне 62)')
  assert.ok(Math.abs(L[0].x - 101.5) <= 1 && L[0].y === 62 && L[0].sky)
  const f = L.find(l => l.x <= -19)
  assert.ok(f && f.level <= 2 && f.n === 6, 'лавопад: 6 клеток, на уровне — 2')
  assert.ok(L.some(l => l.n === 1 && l.y === 20 && !l.sky), 'одиночная пещерная клетка — отдельно')
})

test('копка в воде — цена от объёма и берега, а не всегда отказ', () => {
  const base = { hp: 20, canEat: true, inWater: true, digging: true }
  assert.equal(route.routeActRisk({ ...base, digBlocks: 1, shoreDist: 10 }).refuse, false, 'один блок (3 с) дешевле выхода (~6.5 с)')
  const r = route.routeActRisk({ ...base, digBlocks: route.digBlocksOf('dig_down', { mode: 'stairs', depth: 16 }), shoreDist: 10 })
  assert.equal(r.refuse, true, 'лесенка на 16 в воде — дороже выхода')
  assert.match(r.why, /копка ×5/)
  assert.equal(route.routeActRisk({ ...base, digBlocks: 3, shoreDist: 30 }).refuse, false, 'берег далеко (30 бл.) — три блока копать здесь')
  assert.equal(route.routeActRisk({ ...base, digBlocks: 3, shoreDist: 1 }).refuse, true, 'берег в 1 бл. — выйти дешевле')
  assert.equal(route.digBlocksOf('tunnel', { direction: 'north', length: 24 }), 48)
})

test('ночной отрезок разведки поверху — цена против подземного поиска, а не запрет', () => {
  assert.equal(route.scoutLegPrice({ night: false, hp: 20 }).pick, 'surface')
  assert.equal(route.scoutLegPrice({ night: true, hp: 20, shield: false }).pick, 'under', 'ночью без щита — под землю')
  assert.equal(route.scoutLegPrice({ night: true, hp: 20, shield: true }).pick, 'surface', 'со щитом и полным хп — поверху дешевле')
  assert.equal(route.scoutLegPrice({ night: true, hp: 8, shield: true }).pick, 'under', 'ранен — под землю')
})

test('деревня: риск голема против риска копки — в цене, бюджет поиска построек — только время', () => {
  const info = { seed: 'seen', map: 'blind', spawn: { x: 0, z: 0 }, village: { x: 120, z: 0 }, sky: null, lava: null, outposts: [], ores: null }
  const p = route.plan(info, { have: { stone_pickaxe: 1 }, done: ['wood', 'stone', 'lookout'] })
  const v = p.steps.find(s => s.kind === 'village')
  assert.ok(v, route.describe(p))
  assert.match(v.why, /риск голема/)
  const far = route.plan({ ...info, village: { x: 600, z: 0 } }, { have: { stone_pickaxe: 1 }, done: ['wood', 'stone', 'lookout'] })
  assert.ok(!far.steps.some(s => s.kind === 'village'), 'деревня в 600 м — дороже копки и с риском')
})

test('вслепую без построек: шаг «пещера» перед этапом железа, после провала — этап железа', () => {
  const info = route.seenInfo({ spawn: { x: 0, z: 0 } })
  const p = route.plan(info, { have: { stone_pickaxe: 1 }, done: ['wood', 'stone', 'lookout', 'mine'] })
  const ids = p.steps.map(s => s.id)
  assert.ok(ids.includes('cave') && !ids.includes('ironStage'), ids.join(','))
  const book = { done: new Set<string>(['wood', 'stone', 'lookout', 'mine']), fails: new Map(), avoid: new Set<string>() }
  route.bookStep('cave', false, book)
  const q = route.plan(info, { have: { stone_pickaxe: 1 }, done: book.done, avoid: book.avoid })
  assert.ok(q.steps.some(s => s.id === 'ironStage'), route.describe(q))
})

function owCtx (over: Record<string, any> = {}) {
  const inv: Record<string, number> = { stone_pickaxe: 1, cobblestone: 30, oak_log: 3 }
  const calls: any[] = []
  const ctx: Record<string, any> = {
    ROUTE: true, process: { env: { ND_ROUTE: '1' } }, routeMod: route, routeAvoid: new Set(), died: false, PICK_STONE: /^(stone|iron|diamond)_pickaxe$/,
    state: { pos: { x: 0, y: 70, z: 0 }, health: 20, food: 20, inventory: inv }, sit: { surface: true, night: false }, known: {}, heardLava: null,
    rlog: () => {}, sense: async () => {}, refresh: async () => {}, lighter: () => (inv.flint_and_steel || 0) > 0,
    have: (k: any) => Object.entries(inv).filter(([n]) => typeof k === 'string' ? n === k : k.test(n)).reduce((a, [, v]) => a + v, 0),
    y: () => ctx.state.pos.y, gameClock: { now: () => 0 }, routeRememberShaft: () => {}, acceptResult: () => {},
    calls, inv, ...over
  }
  return ctx
}

test('пещера: колодец до потолка пещеры, спрыгнуть, руда в стенах по виду — железа хватает', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  let inCaveNow = false
  const ctx = owCtx()
  ctx.act = async (m: string, p: any) => {
    ctx.calls.push({ m, p })
    if (m === 'tunnel' && p.direction === 'down') { ctx.state.pos = { x: 0, y: 40, z: 0 }; return { status: 'done', detail: { stopped: 'под ногами пустота (пещера) глубже 3 — колодец бросаю на 0,40,0' } } }
    if (m === 'dig_down') { ctx.state.pos = { x: 0, y: 34, z: 0 }; inCaveNow = true; return { status: 'done', detail: {} } }
    if (m === 'observe') return { status: 'done', detail: { blocks: [{ name: 'iron_ore', count: 5, nearest: { x: 6, y: 35, z: 2 }, dist: 6 }] } }
    if (m === 'mine') { ctx.inv.raw_iron = (ctx.inv.raw_iron || 0) + 4; return { status: 'done', detail: { dug: 4 } } }
    return { status: 'done', detail: {} }
  }
  ctx.call = async (m: string, p: any) => m === 'perceive' && p.mode === 'surface' ? { status: 'done', detail: { surface: inCaveNow ? { name: 'stone', dist: 14, pos: {} } : { name: 'stone', dist: 1, pos: {} } } } : { status: 'done', detail: {} }
  const r = createOverworldRoute(ctx)
  assert.equal(await r.routeStep({ kind: 'cave', budget: 240 }), true)
  const ms = ctx.calls.map(c => c.m)
  assert.ok(ms.indexOf('dig_down') > ms.indexOf('tunnel'), ms.join(','))
  const mine = ctx.calls.find(c => c.m === 'mine')
  assert.equal(mine.p.radius, 32)
  assert.equal(ctx.calls.find(c => c.m === 'dig_down').p.maxFallHp, 5, 'прыжок в пещеру оплачен хп (≤ 5 при 20)')
})

test('пещера: колодец дошёл донизу без пещеры — шаг не вышел (дальше этап железа)', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  const ctx = owCtx()
  ctx.act = async (m: string, p: any) => {
    ctx.calls.push({ m, p })
    if (m === 'tunnel' && p.direction === 'down') { ctx.state.pos = { x: 0, y: 10, z: 0 }; return { status: 'done', detail: { descended: 60 } } }
    return { status: 'done', detail: {} }
  }
  ctx.call = async () => ({ status: 'done', detail: { surface: { name: 'stone', dist: 1, pos: {} } } })
  const r = createOverworldRoute(ctx)
  assert.equal(await r.routeStep({ kind: 'cave', budget: 240 }), false)
  assert.ok(!ctx.calls.some(c => c.m === 'mine'))
})

test('scoutLava с озёрами: одиночная лава — не успех, увиденное озеро — успех и цель плана', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  let seen: any[] = [{ name: 'lava', x: 30, y: 70, z: 0 }]
  const ctx = owCtx({ routeInfoV: undefined })
  ctx.process.env.ND_ROUTE_LAVADIG = '0'
  ctx.act = async (m: string) => {
    if (m === 'explore') { seen = [...seen, ...Array.from({ length: 8 }, (_, i) => ({ name: 'lava', x: -80 + (i % 4), y: 66, z: 20 + Math.floor(i / 4) }))]; return { status: 'done', detail: { found: 'lava', at: { x: -80, y: 66, z: 20 } } } }
    if (m === 'structure') return { status: 'done', detail: { known: [] } }
    return { status: 'done', detail: {} }
  }
  ctx.call = async (m: string, p: any) => m === 'perceive' && p.mode === 'seen' ? { status: 'done', detail: { seen } } : { status: 'done', detail: {} }
  ctx.ROUTE = true
  ctx.routeMod = { ...route, mapLevel: () => 'blind' }
  const r = createOverworldRoute(ctx)
  ctx.routeInfoGet = r.routeInfoGet
  await r.routeSeenRefresh()
  assert.equal(ctx.routeInfoV.sky, null, 'одна клетка лавы — не озеро, литья нет')
  assert.equal(await r.routeStep({ kind: 'scoutLava' }), true)
  await r.routeSeenRefresh()
  assert.ok(ctx.routeInfoV.sky && ctx.routeInfoV.sky.x <= -77 && ctx.routeInfoV.sky.y === 66, JSON.stringify(ctx.routeInfoV.sky))
})

// Кампания в песочнице (как test/campaign.test.ts): RPC вместо Minecraft.
function campaign (state, situation, handle: (m: string, p: any) => any, env: Record<string, any> = {}) {
  class Socket {
    declare listeners: any
    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method, params } = JSON.parse(raw)
      const detail = method === 'situation' ? situation : method === 'status' ? {} : handle(method, params)
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({ id, ok: true, result: { status: 'done', detail, state, events: [] } })))
    }
    close () {}
  }
  const context: Record<string, any> = {
    require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync () {} } : require(name),
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
    process: { argv: ['node', 'campaign.js'], env }, console: { log () {}, error () {} }, setTimeout, Date, queueMicrotask
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../campaign.js'), 'utf8') + `
    module.exports = { act, known, init: () => { state = testState; sit = testSituation; } }
  `, withClockFixture(Object.assign(context, { testState: state, testSituation: situation })))
  context.module.exports.init()
  return context.module.exports
}

test('честная лава: «лава у x,y,z» из стопа штрека — цель, только если её видно', async () => {
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 20, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const hidden = campaign(state, { surface: false, foes: 0 }, m => m === 'tunnel' ? { stopped: 'лава у 5,19,0 — дальше не копаю' } : {}, { ND_OW_DEEP: '1' })
  await hidden.act('tunnel', { direction: 'east', length: 8 })
  assert.equal(hidden.known.lava ?? null, null, 'за блоком, не видна и не слышна — не цель')
  const shown = campaign(state, { surface: false, foes: 0 }, (m, p) => m === 'tunnel' ? { stopped: 'лава у 5,19,0 — дальше не копаю' }
    : m === 'perceive' && p.mode === 'seen' ? { seen: [{ name: 'lava', x: 5, y: 19, z: 0, dist: 5, ago: 0 }] } : {}, { ND_OW_DEEP: '1' })
  await shown.act('tunnel', { direction: 'east', length: 8 })
  assert.deepEqual({ ...shown.known.lava }, { x: 5, y: 19, z: 0 }, 'увиденная — запомнена')
  const legacy = campaign(state, { surface: false, foes: 0 }, m => m === 'tunnel' ? { stopped: 'лава у 5,19,0 — дальше не копаю' } : {}, { ND_OW_DEEP: '1', ND_HONEST_LAVA: '0' })
  await legacy.act('tunnel', { direction: 'east', length: 8 })
  assert.equal(legacy.known.lava.x, 5, 'ND_HONEST_LAVA=0 — прежнее')
})

test('шаг, сорванный тактикой 3 раза: постройка — провал, железо и кремень — нет', () => {
  assert.equal(route.interruptCap('ship', 2), false)
  assert.equal(route.interruptCap('ship', 3), true)
  assert.equal(route.interruptCap('village', 3), true)
  assert.equal(route.interruptCap('ironStage', 9), false)
  assert.equal(route.interruptCap('flint', 9), false)
  assert.equal(route.interruptCap('ship', 9, 0), false, 'ND_ROUTE_INTERRUPT_MAX=0 — прежнее')
})

test('пещеры нет, но руду в стенке колодца глаза видели — к ней по памяти и копать', async () => {
  const { createOverworldRoute } = require('../src/campaign/overworld-route')
  const ctx = owCtx()
  ctx.act = async (m: string, p: any) => {
    ctx.calls.push({ m, p })
    if (m === 'tunnel' && p.direction === 'down') { ctx.state.pos = { x: 0, y: 10, z: 0 }; return { status: 'done', detail: { descended: 60 } } }
    if (m === 'mine') { ctx.inv.raw_iron = 4; return { status: 'done', detail: { dug: 4 } } }
    return { status: 'done', detail: {} }
  }
  ctx.call = async (m: string, p: any) => p.mode === 'seen' ? { status: 'done', detail: { seen: [{ name: 'iron_ore', x: 1, y: 18, z: 0, dist: 8 }] } }
    : { status: 'done', detail: { surface: { name: 'stone', dist: 1, pos: {} } } }
  const r = createOverworldRoute(ctx)
  assert.equal(await r.routeStep({ kind: 'cave', budget: 240 }), true)
  const g = ctx.calls.find(c => c.m === 'goto')
  assert.deepEqual({ x: g.p.x, y: g.p.y, z: g.p.z }, { x: 1, y: 18, z: 0 })
})

test('explore: 8 сторон подряд без пути, тело на месте — отказ отсюда (stuck), а не кручение до срока', { timeout: 15000 }, async () => {
  const Vec3 = require('vec3')
  const gameClock = require('../src/game-clock')
  const { explore } = require('../src/actions')
  const mcData = require('minecraft-data')('1.21.11')
  const c = new gameClock.GameClock({ epoch: 0, stallMs: 0 }); c.setState({ tick_rate: 200 }); gameClock.activate(c); c.start()
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), isInWater: false, onGround: true, yaw: 0, pitch: 0, eyeHeight: 1.62 },
    blockAt: p => p.y < 64 ? { name: 'ice', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p } : { name: 'air', boundingBox: 'empty', shapes: [], position: p },
    registry: mcData, game: { minY: -64, height: 384 }, world: { getColumn: () => null },
    pathfinder: { setGoal: () => {}, movements: null, goto: () => Promise.reject(new Error('noPath')) },
    clearControlStates: () => {}, setControlState: () => {}, lookAt: async () => {}, oxygenLevel: 20, food: 20 }
  const session: any = { bot, mcData, cfg: { fairPlay: true } }
  try {
    const r = await explore(session, { aborted: false, onAbort: [] }, { block: 'iron_ore', timeoutSeconds: 60 })
    assert.equal(r.found, null)
    assert.equal(r.stuck, true)
    assert.equal(r.legs.length, 8)
    assert.ok(c.now() < 60000, 'раньше срока')
  } finally { c.dispose(); gameClock.activate(null) }
})

test('постройки: сундуки/золото/кровати — по глазам (eyes.locate), а не findBlocks сквозь стены; ND_STRUCT_EYES=0 — прежнее', () => {
  const Vec3 = require('vec3')
  const eyesPath = require.resolve('../src/perception/eyes')
  const saved = require.cache[eyesPath]
  const seenCalls: any[] = []
  require.cache[eyesPath] = { id: eyesPath, filename: eyesPath, loaded: true, exports: { locate: (bot, names, o) => { seenCalls.push({ names, o }); return [new Vec3(10, 64, 0), new Vec3(40, 64, 0)].filter(o.filter) } } } as any
  try {
    const { seenNear } = require('../src/structures')
    const bot: any = { entity: { position: new Vec3(0, 64, 0) }, registry: { blocksByName: { chest: { id: 1 } } }, findBlocks: () => [new Vec3(3, 50, 0)] }
    const got = seenNear(bot, ['chest'], { x: 8, y: 64, z: 0 }, 12)
    assert.deepEqual(got.map(v => v.x), [10], 'видимый сундук в радиусе постройки; спрятанный в толще (findBlocks) — нет')
    assert.ok(seenCalls[0].o.radius >= 20)
    process.env.ND_STRUCT_EYES = '0'
    assert.deepEqual(seenNear(bot, ['chest'], { x: 8, y: 64, z: 0 }, 12).map(v => v.y), [50])
  } finally { delete process.env.ND_STRUCT_EYES; if (saved) require.cache[eyesPath] = saved; else delete require.cache[eyesPath] }
})

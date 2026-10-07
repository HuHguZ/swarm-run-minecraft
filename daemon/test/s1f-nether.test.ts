'use strict'
// S1f (07.10): Ад на случайном сиде — честные сущности, сетка только на scan, цены вместо порогов (проверка S1e).
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

function withEnv (env: Record<string, string | undefined>, fn: () => any) {
  const old: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  try { return fn() } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k] } }
}

// Мир из настоящих чанков 1.21.11 (как test/s10-perception): пол y 50..63, стена z = −3.
function world () {
  const registry = require('prismarine-registry')('1.21.11')
  const Chunk = require('prismarine-chunk')(registry)
  const Block = require('prismarine-block')(registry)
  const columns = new Map()
  const w: any = new EventEmitter()
  w.getColumn = (cx, cz) => {
    if (Math.abs(cx) > 4 || Math.abs(cz) > 4) return null
    const k = `${cx},${cz}`
    if (!columns.has(k)) columns.set(k, new Chunk({ minY: -64, worldHeight: 384 }))
    return columns.get(k)
  }
  const id = n => registry.blocksByName[n].defaultState
  const set = (x, y, z, n) => w.getColumn(x >> 4, z >> 4).setBlockStateId(new Vec3(x & 15, y, z & 15), id(n))
  const get = (x, y, z) => { const c = w.getColumn(x >> 4, z >> 4); return c ? c.getBlockStateId(new Vec3(x & 15, y, z & 15)) : null }
  for (let x = -16; x < 32; x++) for (let z = -16; z < 32; z++) for (let y = 50; y <= 63; y++) set(x, y, z, 'stone')
  for (let x = -8; x <= 8; x++) for (let y = 64; y <= 70; y++) set(x, y, -3, 'stone')
  const bot: any = new EventEmitter()
  Object.assign(bot, {
    registry,
    version: '1.21.11',
    game: { minY: -64, height: 384, dimension: 'the_nether' },
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, height: 1.8, yaw: 0, pitch: 0 },
    entities: {},
    world: w,
    blockAt: p => { const s = get(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); if (s === null) return null; const b = Block.fromStateId(s, 0); b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b }
  })
  return { bot }
}

test('eyes.knownEntities: эндермен за стеной не известен, на виду — известен; без глаз и при ND_HONEST_ENT=0 — все', () => {
  const eyes = require('../src/perception/eyes')
  const { bot } = world()
  const em = (id, x, z) => ({ id, name: 'enderman', type: 'hostile', position: new Vec3(x, 64, z), height: 2.9, isValid: true })
  bot.entities = { 1: em(1, 0.5, 8.5), 2: em(2, 0.5, -8.5) } // 2 — за стеной z = −3
  withEnv({ ND_KNOWLEDGE: 'rsg', ND_HONEST_ENT: undefined }, () => {
    assert.deepEqual(eyes.knownEntities(bot).map(e => e.id), [1, 2], 'без глаз (тесты, ND_EYES=0) — как было')
    eyes.install(bot, { every: 100000 })
    assert.deepEqual(eyes.knownEntities(bot).map(e => e.id), [1], 'за стеной — не видим и не слышим')
  })
  withEnv({ ND_KNOWLEDGE: 'rsg', ND_HONEST_ENT: '0' }, () => assert.deepEqual(eyes.knownEntities(bot).map(e => e.id), [1, 2]))
  withEnv({ ND_KNOWLEDGE: 'scan', ND_HONEST_ENT: undefined }, () => assert.deepEqual(eyes.knownEntities(bot).map(e => e.id), [1, 2], 'scan — полное знание'))
})

test('pearls/blaze: выбор цели — через eyes.knownEntities (эндермен за стеной не цель)', () => {
  const fs = require('fs')
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'pearls.ts'), 'utf8')
  const fn = src.slice(src.indexOf('function nearestEnderman'), src.indexOf('function nearestEnderman') + 700)
  assert.match(fn, /return ents\(bot\)/)
  const bz = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'blaze.ts'), 'utf8')
  for (const f of ['function nearestBlaze', 'function droppedRods', 'function arrowsOnFloor']) {
    const body = bz.slice(bz.indexOf(f), bz.indexOf(f) + 500)
    assert.match(body, /ents\(bot\)/, f)
    assert.doesNotMatch(body.split('\n').slice(0, 6).join('\n'), /Object\.values\(bot\.entities\)/, f)
  }
})

test('nether-route.gridOf: сетка копии читается только на scan', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1f-grid-'))
  const NG = require('../src/nether-grid')
  NG.save(dir, new NG.Grid({ x0: 0, y0: 0, z0: 0, sx: 2, sy: 2, sz: 2 }), {})
  const NR = require('../src/nether-route')
  const session = { cfg: { memoryDir: dir } }
  withEnv({ ND_KNOWLEDGE: 'rsg' }, () => assert.equal(NR.gridOf(session), null, 'rsg — без сетки'))
  withEnv({ ND_KNOWLEDGE: 'ssg' }, () => assert.equal(NR.gridOf(session), null, 'ssg — без сетки'))
  withEnv({ ND_KNOWLEDGE: 'scan' }, () => assert.ok(NR.gridOf(session), 'scan — сетка есть'))
})

test('бастион: цель у дома брута — ценой от брони и хп (не порог 16)', () => {
  const B = require('../src/bastion/bastion')
  const A = require('../src/assess')
  const iron = A.gearOf(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots'].map(name => ({ name })))
  withEnv({ ND_BRUTE_HOME_PRICE: undefined }, () => {
    assert.equal(B.bruteHomeTake(20, iron).take, true, 'железо, хп 20: два удара (2×9.1) переживаем')
    assert.equal(B.bruteHomeTake(17, iron).take, false, 'хп 17 < 2 ударов — риск 0.25 × час дороже золота')
    assert.equal(B.bruteHomeTake(20, {}).take, false, 'голое тело: удар 13, два — смерть')
    const at = x => ({ pos: new Vec3(x, 60, 0) })
    const brutes = [[12, 60, 0]]
    assert.deepEqual(B.targetsByBruteHome([at(12)], t => t.pos, brutes, 20, iron).length, 1)
    assert.deepEqual(B.targetsByBruteHome([at(12)], t => t.pos, brutes, 17, iron).length, 0)
  })
  withEnv({ ND_BRUTE_HOME_PRICE: '0' }, () => {
    const at = x => ({ pos: new Vec3(x, 60, 0) })
    assert.equal(B.targetsByBruteHome([at(12)], t => t.pos, [[12, 60, 0]], 17, iron).length, 1, 'выключатель — прежний порог хп ≥ 16')
  })
})

test('бастион: ждать злость перед ямой — ценой (злых нет — не ждать; мало осталось — ждать; долго — не ждать)', () => {
  const B = require('../src/bastion/bastion')
  const A = require('../src/assess')
  const iron = A.gearOf(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots'].map(name => ({ name })))
  assert.equal(B.pitAngerWait({ angry: 0, hp: 20, leftS: 30, gear: iron }).wait, false)
  assert.equal(B.pitAngerWait({ angry: 1, hp: 20, leftS: 30, gear: iron }).wait, true)
  assert.equal(B.pitAngerWait({ angry: 1, hp: 20, leftS: 600, gear: iron }).wait, false)
  assert.equal(B.pitAngerWait({ angry: 4, hp: 10, leftS: 600, gear: iron }).wait, true, 'четверо злых при 10 хп — риск 0.5')
})

test('fortress.spawnerHint: «пирог» F3 со спавнером за стеной — пеленг в его сторону (клетка не известна); пусто — null', () => {
  const eyes = require('../src/perception/eyes')
  const F = require('../src/fortress')
  const W = world()
  const { bot } = W
  eyes.install(bot, { every: 100000 })
  assert.equal(F.spawnerHint(bot), null, 'ни спавнера, ни звука')
  // Спавнер в 30 бл. на восток, закрыт камнем со всех сторон — глазами не виден, «пирог» его считает.
  const reg = bot.registry
  const col = (x, z) => bot.world.getColumn(x >> 4, z >> 4)
  const put = (x, y, z, n) => col(x, z).setBlockStateId(new Vec3(x & 15, y, z & 15), reg.blocksByName[n].defaultState)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) put(30 + dx, 65 + dy, dz, 'stone')
  put(30, 65, 0, 'spawner')
  bot._ndEyes.cache && bot._ndEyes.cache.clear && bot._ndEyes.cache.clear()
  const h = F.spawnerHint(bot, { leg: 20 })
  assert.ok(h, 'подсказка есть')
  assert.equal(h.by, 'пирог')
  assert.ok(h.x > 15 && Math.abs(h.z) < 6, `на восток: ${JSON.stringify(h)}`)
  assert.equal(eyes.locate(bot, ['spawner'], { radius: 64 }).length, 0, 'сам спавнер глазами не найден')
})

test('fortress.bastionRegions: регион увиденного бастиона (nether_complexes: одна постройка на регион 432) — крепость там не ищем', () => {
  const F = require('../src/fortress')
  const places = { 'бастион (ад)': { x: 100, y: 60, z: -20, dimension: 'the_nether' }, 'бастион 2 (ад)': { x: 300, y: 50, z: -10, dimension: 'the_nether' },
    'бастион 3 (ад)': { x: 900, y: 50, z: 10, dimension: 'overworld' } }
  assert.deepEqual(F.bastionRegions(places), [[0, -1]], 'два бастиона одного региона — один; запись верхнего мира — мимо')
  assert.deepEqual(F.regionOf(-1, 431), [-1, 0])
})

test('граф по умолчанию: цена охоты на эндерменов — недостача × факт endermen_seconds_per_pearl (ND_EM_PRICE=0 — 600 с)', () => {
  const { speedrunRegistry } = require('../src/core/speedrun')
  const { fact } = require('../src/core/world-state')
  const { worldFromObservation } = require('../src/environments/mineflayer')
  const state = (sec: number) => worldFromObservation({ state: { dimension: 'the_nether', health: 20, inventory: { ender_pearl: 8 } },
    facts: { bastions_exhausted: fact(true, 'observed', 0), endermen_allowed: fact(true, 'observed', 0), endermen_seconds_per_pearl: fact(sec, 'observed', 0) } }, 0)
  withEnv({ ND_EM_PRICE: undefined }, () => {
    const hunt = speedrunRegistry({ eyes: 12 }).get('HuntEndermen')!
    assert.equal(hunt.estimateCost(state(240)), 4 * 240 * 20, 'лес увиден: 4 жемчуга × 240 с')
    assert.equal(hunt.estimateCost(state(3600)), 4 * 3600 * 20, 'два пустых захода — час на жемчуг')
  })
  withEnv({ ND_EM_PRICE: '0' }, () => {
    const hunt = speedrunRegistry({ eyes: 12 }).get('HuntEndermen')!
    assert.equal(hunt.estimateCost(state(3600)) < 4 * 3600 * 20, true, 'выключатель — прежние постоянные 600 с')
  })
})

test('мост в Аду: над смертельной высотой (lethalDepth) — нет, над мелким провалом — да', () => {
  const data = require('minecraft-data')('1.21.11')
  const Block = require('prismarine-block')('1.21.11')
  const { Movements, goals } = require('mineflayer-pathfinder')
  const { AStar } = require('mineflayer-pathfinder/lib/astar') ?? {}
  const AS = AStar || require('mineflayer-pathfinder/lib/astar')
  const Move = require('mineflayer-pathfinder/lib/move')
  const bm = require('../src/blockmoves')
  const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const world = terrain => ({ getBlock: p => { const b = Block.fromStateId(data.blocksByName[terrain(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))].defaultState, 0); b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b } })
  const moves = w => {
    const bot: any = { registry: data, version: '1.21.11', blockAt: p => w.getBlock(p), entities: {}, entity: { position: new Vec3(0.5, 64, 0.5), effects: {} },
      inventory: { items: () => [] }, game: { minY: -64 }, pathfinder: { bestHarvestTool: () => null } }
    const mv = new Movements(bot); mv.allowSprinting = false; mv.canDig = false
    mv.exclusionAreasPlace.push(b => { for (let d = 1; d <= 5; d++) { const q = w.getBlock(b.position.offset(0, -d, 0)); if (q.boundingBox !== 'empty') return 0 } return 100 })
    return mv
  }
  const plan = (mv, goal) => { const a = new (AS.AStar || AS)(new Move(0, 64, 0, 16, 0), mv, goal, 2500, 250); let r = a.compute(); while (r.status === 'partial') r = a.compute(); return r }
  const gap = floorY => p => (p.y === 63 && (p.x < 1 || p.x > 5)) || p.y === floorY ? 'stone' : 'air'
  const goal = new goals.GoalBlock(8, 64, 0)
  void key
  assert.equal(plan(bm.addBridge(moves(world(gap(20))), { depthMax: 64 }), goal).status, 'success', 'без lethalDepth — мост над 43')
  assert.notEqual(plan(bm.addBridge(moves(world(gap(20))), { depthMax: 64, lethalDepth: 20 }), goal).status, 'success', 'над 43 — нет')
  assert.equal(plan(bm.addBridge(moves(world(gap(52))), { depthMax: 64, lethalDepth: 20 }), goal).status, 'success', 'над 11 — да')
})

test('fortress.walkLeg: ниже 44 в Аду отрезок целится вверх (до 56), а не вдоль берега лавы', async () => {
  const F = require('../src/fortress')
  const goalsSeen: any[] = []
  const bot: any = { entity: { position: new Vec3(0.5, 35, 0.5) }, health: 20,
    pathfinder: { goto: async (g: any) => { goalsSeen.push(g); bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5) }, setGoal () {} } }
  const ctl = { aborted: false, onAbort: [] }
  withEnv({ ND_NE_RISE: undefined }, () => {})
  const r = await F.walkLeg(bot, ctl, 16, 0, require('../src/game-clock').now() + 60000)
  assert.equal(r.ok, true)
  assert.equal(goalsSeen[0].y, 47, 'y 35 + 12')
  assert.equal(r.up, 12)
})

test('fortress.hintFlipped: пеленг развернулся > 110° — цель между точками (вертикаль), иначе — нет', () => {
  const F = require('../src/fortress')
  assert.equal(F.hintFlipped(156, -70), true, 's1f-A2-3: 156° → −70°')
  assert.equal(F.hintFlipped(-63, 104), true)
  assert.equal(F.hintFlipped(170, -170), false, 'через ±180 — 20°')
  assert.equal(F.hintFlipped(10, 90), false)
})

test('fortress.keepBlocks: в Аду меньше 12 строительных — добыть незерак (не чаще раза в минуту); хватает — нет', async () => {
  const F = require('../src/fortress')
  const A = require('../src/actions')
  const mine0 = A.mine
  const items: any[] = [{ name: 'netherrack', count: 3 }]
  const bot: any = { game: { dimension: 'the_nether' }, inventory: { items: () => items } }
  let calls = 0
  A.mine = async (_s: any, _c: any, p: any) => { calls++; assert.equal(p.block, 'netherrack'); items[0].count += p.count; return { dug: p.count } }
  try {
    withEnv({ ND_NE_KEEP_BLOCKS: undefined }, () => {})
    assert.equal(await F.keepBlocks({ bot }, { aborted: false }), 37)
    items[0].count = 3
    assert.equal(await F.keepBlocks({ bot }, { aborted: false }), null, 'раз в игровую минуту')
    bot._ndKeepBlocksAt = 0; items[0].count = 30
    assert.equal(await F.keepBlocks({ bot }, { aborted: false }), null, 'хватает')
    assert.equal(calls, 1)
  } finally { A.mine = mine0 }
})

test('клатч: доски — последними (в Аду дерево нужно на палки и кирки)', () => {
  const C = require('../src/clutch')
  const slots: any[] = []
  slots[36] = { name: 'oak_planks', count: 16, slot: 36 }
  slots[37] = { name: 'netherrack', count: 5, slot: 37 }
  assert.equal(C.selectBlock(slots).name, 'netherrack')
  slots[37] = null
  assert.equal(C.selectBlock(slots).name, 'oak_planks', 'нечем больше — доски')
})

test('штрек бастиона: тело на песке душ (y N.88) — клетка ног выше пола, план стартует из неё (ND_SOUL_FEET=0 — прежнее floored)', () => {
  const SL = require('../src/sealed')
  const bot: any = { entity: { position: new Vec3(-85.5, 51.875, -44.5), onGround: true } }
  assert.deepEqual(SL.bodyCells(bot)[0].toArray(), [-86, 52, -45], 'ноги — над песком душ')
  const fs = require('fs')
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'bastion', 'bastion.ts'), 'utf8')
  assert.match(src, /const me = feet\(\)/, 'старт плана — feet()')
  assert.match(src, /SL\.bodyCells\(bot\)\[0\]/)
})

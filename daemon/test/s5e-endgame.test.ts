'use strict'
// S5e (07.10): конец игры на случайном сиде — честный спуск к крепости (без рентгена толщи), «пирог» к комнате.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

// Мир из настоящих чанков 1.21.11 (как в s10-perception): камень y 0..70, воздух выше.
function world (fill: (x: number, y: number, z: number) => string | null = () => null) {
  const registry = require('prismarine-registry')('1.21.11')
  const Chunk = require('prismarine-chunk')(registry)
  const Block = require('prismarine-block')(registry)
  const columns = new Map()
  const w: any = {}
  w.getColumn = (cx: number, cz: number) => {
    if (Math.abs(cx) > 2 || Math.abs(cz) > 2) return null
    const k = `${cx},${cz}`
    if (!columns.has(k)) {
      const c = new Chunk({ minY: -64, worldHeight: 384 })
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y <= 70; y++) {
        const n = fill(cx * 16 + x, y, cz * 16 + z) || 'stone'
        c.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[n].defaultState)
      }
      columns.set(k, c)
    }
    return columns.get(k)
  }
  const get = (x: number, y: number, z: number) => { const c = w.getColumn(x >> 4, z >> 4); return c ? c.getBlockStateId(new Vec3(x & 15, y, z & 15)) : null }
  const set = (p: any, n: string) => w.getColumn(p.x >> 4, p.z >> 4).setBlockStateId(new Vec3(p.x & 15, p.y, p.z & 15), registry.blocksByName[n].defaultState)
  const bot: any = {
    registry,
    game: { minY: -64, height: 384, dimension: 'overworld' },
    entity: { position: new Vec3(0.5, 60, 0.5), eyeHeight: 1.62, height: 1.8 },
    world: w,
    health: 20,
    blockAt: (p: any) => { const s = get(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); if (s === null) return null; const b = Block.fromStateId(s, 0); b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b }
  }
  return { bot, set }
}

// Тело в своей шахте: ноги на (0,60,0), над головой открыто до неба.
function inShaft (W: any) { for (let y = 60; y <= 70; y++) W.set(new Vec3(0, y, 0), 'air') }

// Ступень на восток до шага: решения judgeStep, копка — по решению (клетка → воздух).
function stepDecisions (W: any, opts: any = {}) {
  const { judgeStep } = require('../src/endportal-descent')
  const F = new Vec3(0, 60, 0)
  const out = []
  for (let i = 0; i < 8; i++) {
    const j = judgeStep(W.bot, F, [1, 0], opts)
    out.push(j.act + (j.cell ? `@${j.cell.x},${j.cell.y},${j.cell.z}` : '') + (j.fall !== undefined ? `/${j.fall}` : ''))
    if (j.act !== 'dig') break
    W.set(j.cell, 'air')
  }
  return out
}

test('честный спуск: решения ступени одинаковы в мирах, разных лишь за стеной (пещера под полом ступени, лава за забоем)', () => {
  const A = world(); inShaft(A)
  // B: пещера под полом следующей ступени (y 54..57 под клеткой 1,58) и лава в двух клетках за забоем — из шахты не видно.
  const B = world((x, y, z) => (x >= 0 && x <= 3 && z >= -1 && z <= 1 && y >= 54 && y <= 57 ? 'cave_air' : x === 3 && z === 0 && y === 60 ? 'lava' : null)); inShaft(B)
  const a = stepDecisions(A); const b = stepDecisions(B)
  assert.deepEqual(b, a, 'скрытое не меняет решений')
  assert.deepEqual(a, ['dig@1,61,0', 'dig@1,60,0', 'dig@1,59,0', 'step/0'])
})

test('честный спуск: пустота под ступенью, видимая в проём, — мост (дна не видно/глубоко) или спуск ≤ 3 на видимое дно', () => {
  // Пещера сразу под ступенью: дно на y 52 (глубоко) — мост в клетку пола.
  const deep = world((x, y, z) => (x === 1 && z === 0 && y >= 53 && y <= 58 ? 'cave_air' : null)); inShaft(deep)
  assert.deepEqual(stepDecisions(deep).slice(-1), ['bridge@1,58,0'])
  // Неглубоко: пол на y 57 виден в проём — спуск 2 бл. даром.
  const low = world((x, y, z) => (x === 1 && z === 0 && y === 58 ? 'cave_air' : null)); inShaft(low)
  assert.deepEqual(stepDecisions(low).slice(-1), ['step/2'])
  // Дно на y 54 из шахты 1×1 не видно (свой пол заслоняет крутой луч) — мост, а не прыжок «на авось».
  const mid = world((x, y, z) => (x === 1 && z === 0 && y >= 55 && y <= 58 ? 'cave_air' : null)); inShaft(mid)
  assert.deepEqual(stepDecisions(mid).slice(-1), ['bridge@1,58,0'])
})

test('честный спуск: увиденная в проёме лава — заложить; кирпич крепости в забое — пришли', () => {
  const lava = world((x, y, z) => (x === 2 && z === 0 && y === 60 ? 'lava' : null)); inShaft(lava)
  const d = stepDecisions(lava)
  assert.equal(d[d.length - 1], 'seal@2,60,0', d.join(' '))
  const { BRICKS } = require('../src/endportal')
  const brick = world((x, y, z) => (x === 1 && z === 0 && y === 59 ? 'stone_bricks' : null)); inShaft(brick)
  assert.deepEqual(stepDecisions(brick, { bricks: BRICKS }), ['dig@1,61,0', 'dig@1,60,0', 'brick@1,59,0'])
})

test('выбор колонки шахты в rsg не читает пещер толщи (колонка над пещерой — та же, что над сплошной), в scan — обходит', () => {
  const { dryEntry } = require('../src/endportal')
  const blockAt = (p: any) => {
    if (p.y > 70) return { name: 'air', boundingBox: 'empty' }
    if (p.x >= 96 && p.x <= 104 && Math.abs(p.z) <= 4 && p.y >= 50 && p.y <= 60) return { name: 'cave_air', boundingBox: 'empty' }
    return { name: 'stone', boundingBox: 'block' }
  }
  // Глаза видят только верх (y ≥ 70): толща скрыта.
  const bot: any = { entity: { position: new Vec3(100, 71, 0) }, blockAt }
  const eyes = require('../src/perception/eyes')
  const old = eyes.seesNow
  eyes.seesNow = (_b: any, p: any) => p.y >= 70
  const save = process.env.ND_KNOWLEDGE
  try {
    process.env.ND_KNOWLEDGE = 'rsg'
    const d = dryEntry(bot, { x: 100, z: 0 }, 96, 40)
    assert.deepEqual([d.x, d.z], [100, 0], 'rsg: колонка прямо над входом')
    process.env.ND_KNOWLEDGE = 'scan'
    const s = dryEntry(bot, { x: 100, z: 0 }, 96, 40)
    assert.ok(s.x < 96 || s.x > 104 || Math.abs(s.z) > 4, `scan: мимо пещеры ${s.x},${s.z}`)
  } finally { eyes.seesNow = old; if (save === undefined) delete process.env.ND_KNOWLEDGE; else process.env.ND_KNOWLEDGE = save }
})

// Тактика (узкая правка S5e): под землёй на навыке stronghold бег не выход (s5d-T-1: бег из шахты в пещеру — падение 24 бл.;
// T-7/R-8 — бег вниз до хп 2–9) — escapeRoute снят, бой/заслон; под небом и на другом навыке — как прежде.
test('тактика: в шахте к крепости (без неба) бег не предлагается, под небом и вне навыка — предлагается', () => {
  const { EventEmitter } = require('node:events')
  const { observeTactics } = require('../src/tactics/minecraft')
  const { candidates } = require('../src/tactics/state')
  const md = require('minecraft-data')('1.21.11')
  const session = (current: string, sky: number) => {
    const bot: any = new EventEmitter()
    bot.version = '1.21.11'; bot.health = 14; bot.food = 20
    bot.inventory = { slots: [], items: () => [{ name: 'iron_sword', count: 1 }] }
    bot.registry = md
    bot.entity = { id: 1, position: new Vec3(.5, 40, .5), height: 1.8, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [], yaw: 0, pitch: 0, velocity: new Vec3(0, 0, 0) }
    bot.entities = { 2: { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(2.5, 40, .5), height: 1.95, width: 0.6, metadata: [], velocity: new Vec3(0, 0, 0), equipment: [] } }
    bot.game = { dimension: 'overworld', gameMode: 'survival' }
    bot.blockAt = (p: any) => ({ name: p.y < 40 ? 'stone' : 'air', boundingBox: p.y < 40 ? 'block' : 'empty', position: p.floored(), skyLight: sky, shapes: p.y < 40 ? [[0, 0, 0, 1, 1, 1]] : [] })
    return { bot, current: { name: current, params: { mode: 'room' } }, reflex: null, bus: { emit: () => {} }, tempo: null }
  }
  const dark = observeTactics(session('stronghold', 0))
  const open = observeTactics(session('stronghold', 15))
  const other = observeTactics(session('mine', 0))
  assert.equal(dark.escapeRoute, false, 'под землёй на stronghold — без бега')
  assert.equal(open.escapeRoute, true, 'под небом — бег есть')
  assert.equal(other.escapeRoute, true, 'другой навык — как прежде')
  assert.ok(!candidates(dark).some((c: any) => /Flee|CreateDistance/.test(c.id)), JSON.stringify(candidates(dark)))
})

// S5e (г): бой без кроватей — оценка: хп дракона ≤ 40 — добить его самого (mode dragon), иначе кристаллы (full); своё хп < 14 —
// сперва поесть/отлежаться (s5d-T-5: full при 20 хп дракона — смерть от дыхания; T-6: full 20 мин по кристаллам при 10 хп дракона).
test('дракон без кроватей: full, пока хп дракона не известно/высоко; ≤ 40 — режим dragon; низкое своё хп — еда перед боем', async () => {
  const { load, ready } = require('./campaign-seams-fixture')
  const state = ready({ red_bed: 0 }); state.dimension = 'the_end'; state.health = 12
  const hps = [120, 30]
  let k = 0
  const c = load(state, (method: string) => {
    if (method === 'dragon') { const hp = hps[Math.min(k, hps.length - 1)]; k++; return k >= 3 ? { dragon: { won: true, hpNow: 0 } } : { dragon: { hpNow: hp } } }
    if (method === 'eat') state.health = 20
    return {}
  })
  c.known.endPortal = { x: 0, y: 60, z: 0 }
  await c.run('dragon')
  const modes = c.calls.filter((x: any) => x.method === 'dragon').map((x: any) => x.params.mode)
  assert.deepEqual(modes, ['full', 'full', 'dragon'])
  assert.ok(c.calls.findIndex((x: any) => x.method === 'eat') < c.calls.findIndex((x: any) => x.method === 'dragon'), 'еда до первого боя при хп 12')
})

// Внутрь крепости сквозь потолок коридора: дно из проёма 1×1 не видно — в спуске (honestShaft) мост, во входе (honestEnter,
// dropUnknown) — спрыгнуть по цене при хп ≥ 14; видимая лава внизу — никогда.
test('честный вход: сквозь потолок коридора — спрыгнуть по цене (дна не видно), в обычном спуске — мост', () => {
  const corridor = (lava = false) => world((x, y, z) => {
    if (x >= 0 && x <= 3 && Math.abs(z) <= 1 && y >= 54 && y <= 58) return lava && y === 58 && x === 2 ? 'lava' : 'cave_air'
    if (x === 1 && z === 0 && y === 59) return 'stone_bricks'
    return null
  })
  const { BRICKS } = require('../src/endportal')
  const a = corridor(); inShaft(a)
  assert.deepEqual(stepDecisions(a, { bricks: BRICKS, throughBricks: true }).slice(-1), ['bridge@1,58,0'])
  const b = corridor(); inShaft(b)
  assert.deepEqual(stepDecisions(b, { bricks: BRICKS, throughBricks: true, dropUnknown: true }).slice(-1), ['step/4'])
  const c = corridor(); inShaft(c)
  assert.deepEqual(stepDecisions(c, { bricks: BRICKS, throughBricks: true, dropUnknown: true, hp: 10 }).slice(-1), ['bridge@1,58,0'])
})

// «Пирог» по вертикали: угол возвышения спавнера (наклон камеры) → высота при известной дальности, ±2 бл.
test('«пирог» по вертикали: высота спавнера в 10 и 30 бл. — с точностью ±2', () => {
  const { pieElevation } = require('../src/endportal-descent')
  for (const [sx, sy] of [[10, 40], [30, 52]]) {
    const W = world((x, y, z) => (x === sx && y === sy && z === 0 ? 'spawner' : null))
    W.bot.entity.position = new Vec3(0.5, 71, 0.5)
    const el = pieElevation(W.bot, Math.hypot(sx + 0.5 - 0.5, 0))
    assert.ok(el && Math.abs(el.y - sy) <= 2, `спавнер y ${sy}: оценка ${JSON.stringify(el)}`)
  }
})

// Вода, натёкшая в клетку ступени (озеро над лестницей, s5e-M-2 — «утонул»): заткнуть клетку и в другую сторону, а не идти по воде.
test('честный спуск: вода в клетке ступени — заткнуть (plug), а не идти', () => {
  const W = world((x, y, z) => (x === 1 && z === 0 && y === 60 ? 'water' : null)); inShaft(W)
  assert.deepEqual(stepDecisions(W).slice(-1), ['plug@1,60,0'])
})

// Зигзаг 2×1: вторая ступень обратно — голова у неё уже воздух (ноги первой), 2 блока на уровень вместо 3.
test('честный спуск: зигзаг — вторая ступень (обратно) копает 2 блока, пол виден до шага', () => {
  const { judgeStep } = require('../src/endportal-descent')
  const W = world(); inShaft(W)
  for (const c of [[1, 61, 0], [1, 60, 0], [1, 59, 0]]) W.set(new Vec3(c[0], c[1], c[2]), 'air')
  W.bot.entity.position = new Vec3(1.5, 59, 0.5)
  const F = new Vec3(1, 59, 0)
  const out = []
  for (let i = 0; i < 6; i++) {
    const j = judgeStep(W.bot, F, [-1, 0])
    out.push(j.act + (j.cell ? `@${j.cell.x},${j.cell.y},${j.cell.z}` : '') + (j.fall !== undefined ? `/${j.fall}` : ''))
    if (j.act !== 'dig') break
    W.set(j.cell, 'air')
  }
  assert.deepEqual(out, ['dig@0,59,0', 'dig@0,58,0', 'step/0'])
})

// Очи в рамках найденной комнаты — тоже очи для графа (s5e-G-1: 7 вставлено, 7 у тела — граф увёл в Ад «за очами»).
test('граф: очи в рамках комнаты считаются вместе с очами у тела', () => {
  const { worldFromObservation } = require('../src/environments/mineflayer')
  const obs = (known: any) => ({ state: { dimension: 'overworld', pos: { x: 0, y: 60, z: 0 }, health: 20, food: 20, inventory: { ender_eye: 7 } }, known, situation: {}, facts: {}, map: {} })
  assert.equal(worldFromObservation(obs({ endPortal: { x: 1, y: 2, z: 3 }, portalEyes: 7 }), 0).resources.eyes, 14)
  assert.equal(worldFromObservation(obs({}), 0).resources.eyes, 7)
})

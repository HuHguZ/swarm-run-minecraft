'use strict'
// Маршрут по знанию карты (поток route, 03.10.2026): план шагов по сиду, голем со столба, литьё — трава и песок.
const test = require('node:test')
const assert = require('node:assert')
const Vec3 = require('vec3')
const route = require('../src/route')

const base = {
  seed: '1',
  spawn: { x: 0, z: 0 },
  rp: { x: 60, z: 0, d: 60 },
  village: { x: 0, z: 120, d: 120 },
  ship: null,
  treasure: null,
  sky: { x: 100, y: 64, z: 20, cls: 'surface', src: 40, d: 102 },
  lava: { x: 100, y: 64, z: 20, cls: 'surface', depth: 0, src: 40, d: 102 },
  ores: null
}

test('план с пустым рюкзаком: дерево, камень, руины и деревня, вёдра, вода, литьё поверху, вход', () => {
  const p = route.plan(base)
  const ids = p.steps.map(s => s.id)
  assert.deepStrictEqual(ids.slice(0, 2), ['wood', 'stone'])
  assert.ok(ids.includes('ruin'), ids.join(','))
  assert.ok(ids.includes('village'), ids.join(','))
  assert.ok(ids.indexOf('smelt') > ids.indexOf('village'))
  assert.ok(ids[ids.length - 2].startsWith('lava:sky'), ids.join(','))
  assert.strictEqual(ids[ids.length - 1], 'enter')
  assert.strictEqual(p.lava.kind, 'sky')
  assert.ok(p.budget > 0)
})

test('кирка и вёдра уже есть — без дерева, камня и железа', () => {
  const p = route.plan(base, { have: { stone_pickaxe: 1, bucket: 1, water_bucket: 1, flint_and_steel: 1, obsidian: 2 } })
  const ids = p.steps.map(s => s.id)
  assert.ok(!ids.includes('wood') && !ids.includes('stone'), ids.join(','))
  assert.ok(!ids.includes('village') && !ids.includes('mine'), ids.join(','))
  assert.strictEqual(route.ironNeed({ bucket: 1, water_bucket: 1, flint_and_steel: 1 }, { buckets: 2 }), 0)
  assert.strictEqual(route.ironNeed({}, { buckets: 2 }), 7)
  assert.strictEqual(route.ironNeed({ fire_charge: 1, iron_ingot: 2, iron_nugget: 9 }, { buckets: 2 }), 3)
  // Одно ведро (cast1.js): голема (3–5) хватает.
  assert.strictEqual(route.ironNeed({}, { buckets: 1 }), 4)
  assert.strictEqual(route.ironNeed({ fire_charge: 1, iron_ingot: 3 }, { buckets: 1 }), 0)
})

test('провал шага — в avoid: лава под небом не вышла → пещера по скану, её нет → вниз', () => {
  const info = { ...base, lava: { x: 30, y: 50, z: 30, cls: 'open-cave', depth: 15, src: 200, d: 42 } }
  assert.strictEqual(route.plan(info).lava.kind, 'sky')
  const p2 = route.plan(info, { avoid: ['lava:sky'] })
  assert.strictEqual(p2.lava.kind, 'cave')
  assert.ok(p2.steps.some(s => s.id.startsWith('lava:cave')))
  const p3 = route.plan(info, { avoid: ['lava:sky', 'lava:cave'] })
  assert.strictEqual(p3.lava.kind, 'deep')
  assert.ok(p3.steps.some(s => s.id === 'lava:deep'))
})

test('железа мало от одной деревни — клад рядом добирает, порядок точек — кратчайший', () => {
  const info = { ...base, treasure: { x: 90, z: 30, d: 95 } }
  const p = route.plan(info, { done: ['wood', 'stone'] })
  const ids = p.steps.map(s => s.id)
  assert.ok(ids.includes('treasure'), ids.join(','))
  const order = route.orderPoints({ x: 0, z: 0 }, [{ id: 'a', at: { x: 100, z: 0 } }, { id: 'b', at: { x: 50, z: 0 } }], { x: 150, z: 0 })
  assert.deepStrictEqual(order.order.map(o => o.id), ['b', 'a'])
})

test('голем: из глаз на столбе 3 удар достаёт макушку, а голем ноги игрока — нет', () => {
  const { golemReach, GOLEM_PILLAR } = require('../src/fauna')
  // Тело на столбе высотой 3 над полом y 64, голем вплотную к столбу.
  const bot = { entity: { position: new Vec3(0.5, 64 + GOLEM_PILLAR, 0.5) } }
  const golem = { position: new Vec3(1.9, 64, 0.5), width: 1.4, height: 2.7 }
  assert.ok(golemReach(bot, golem) <= 2.95, `достаёт: ${golemReach(bot, golem)}`)
  // Коробка атаки голема: своя, раздутая по горизонтали на √2.04 − 0.6, по высоте — нет (Mob.getAttackBoundingBox).
  const inflate = Math.sqrt(2.04) - 0.6
  const top = golem.position.y + golem.height
  const feet = bot.entity.position.y
  assert.ok(feet > top, 'ноги выше коробки атаки голема')
  assert.ok(inflate < 1)
  // На столбе 2 — ноги ниже макушки: голем достаёт.
  assert.ok(64 + 2 < top)
})

test('литьё: трава в проёме видна контуром, песок с опорой — пол', () => {
  const cast = require('../src/cast')
  const blocks = new Map()
  const put = (x, y, z, name, bb = 'block', props = {}) => blocks.set(`${x},${y},${z}`, { name, boundingBox: bb, position: new Vec3(x, y, z), shapes: bb === 'block' ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => props })
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) { put(x, 63, z, 'sand'); put(x, 62, z, 'sandstone'); put(x, 64, z, 'air', 'empty'); put(x, 65, z, 'air', 'empty'); put(x, 66, z, 'air', 'empty') }
  put(1, 64, 0, 'short_grass', 'empty')
  put(2, 64, 2, 'snow', 'empty', { layers: 1 })
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: p => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || null, getControlState: () => false }
  const read = p => bot.blockAt(p)
  assert.ok(cast.steadyFloor(read, new Vec3(0, 63, 0)), 'песок на песчанике держится')
  put(-3, 62, -3, 'air', 'empty')
  assert.ok(!cast.steadyFloor(read, new Vec3(-3, 63, -3)), 'песок над пустотой — не пол')
  const aim = cast.outlineAim(bot, bot.blockAt(new Vec3(1, 64, 0)))
  assert.ok(aim && aim.y < 65 && aim.y > 64, `трава: прицел в контур ${aim}`)
  const aimSnow = cast.outlineAim(bot, bot.blockAt(new Vec3(2, 64, 2)))
  assert.ok(aimSnow && aimSnow.y - 64 <= 2 / 16 + 1e-9, `снег: прицел в слой ${aimSnow}`)
  assert.strictEqual(cast.outlineAim(bot, bot.blockAt(new Vec3(0, 63, 0))), null)
})

test('добор лавы: всё тело озера по связности, ближние к раме открытые источники', () => {
  const cast = require('../src/cast')
  const blocks = new Map()
  const put = (x, y, z, name, bb = 'block', props = {}) => blocks.set(`${x},${y},${z}`, { name, boundingBox: bb, position: new Vec3(x, y, z), shapes: bb === 'block' ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => props })
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) { put(x, 62, z, 'stone'); put(x, 64, z, 'air', 'empty'); put(x, 65, z, 'air', 'empty'); put(x, 63, z, 'stone') }
  // Озеро 10×1 по x от 0 до 9 на y 63 (гладь), сверху воздух; берег — z ±1.
  for (let x = 0; x <= 9; x++) put(x, 63, 0, 'lava', 'empty', { level: 0 })
  const bot = { entity: { position: new Vec3(-5.5, 64, 0.5) }, blockAt: p => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || null, getControlState: () => false, entities: {} }
  const live = cast.liveLava(bot, [new Vec3(9, 63, 0)], new Vec3(-5, 64, 0), { limit: 4 })
  assert.ok(live.length >= 1, `живых: ${live.length}`)
  assert.ok(live[0].x <= 3, `ближний к раме — с края у рамы: ${live[0]}`)
})

test('скан копии v2: руины по сундуку, руины под водой и затонувший корабль — мимо, деревня без голема и кузниц — мимо', () => {
  const ores = {
    v: 2, spawn: { x: 0, z: 0 }, half: 160, iron: [], water: [], gravel: [], trees: [], lava: [], golems: [],
    chests: [
      { x: 70, y: 64, z: 4, table: 'ruined_portal' },
      { x: 5, y: 40, z: 130, table: 'shipwreck_treasure' }
    ],
    structures: [
      { name: 'ruined_portal', bb: [60, 60, -5, 75, 70, 10] },
      { name: 'shipwreck', bb: [0, 35, 125, 10, 45, 135] }
    ]
  }
  const info = { ...base, ship: { x: 0, z: 128, d: 128 }, village: { x: 0, z: 120, d: 120 }, ores }
  const p = route.plan(info, { done: ['wood', 'stone'] })
  const ruin = p.steps.find(s => s.id === 'ruin')
  assert.ok(ruin && ruin.at.x === 70 && ruin.at.z === 4, JSON.stringify(ruin))
  assert.ok(!p.steps.some(s => s.id === 'ship'), 'затонувший корабль — под водой')
  assert.ok(!p.steps.some(s => s.id === 'village'), 'деревни нет в скане (ни голема, ни сундуков)')
  const wet = { ...ores, structures: [{ name: 'ruined_portal_ocean', bb: [60, 40, -5, 75, 70, 10] }] }
  const p2 = route.plan({ ...info, ores: wet }, { done: ['wood', 'stone'] })
  assert.ok(!p2.steps.some(s => s.id === 'ruin'), 'руины под водой — мимо')
})

test('голем: место для столба — ровно в 2 бл. вокруг; бугор рядом — столб 4 или мимо', () => {
  const { golemTopNear, golemSpotNear } = require('../src/fauna')
  const blocks = new Map()
  const put = (x, y, z, name) => blocks.set(`${x},${y},${z}`, { name, boundingBox: name === 'air' ? 'empty' : 'block' })
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) { put(x, 63, z, 'grass_block'); for (let y = 64; y <= 72; y++) put(x, y, z, 'air') }
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: p => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || null }
  const golem = { position: new Vec3(3.5, 64, 0.5) }
  assert.strictEqual(golemTopNear(bot, new Vec3(1, 64, 0)), 64)
  const spot = golemSpotNear(bot, golem)
  assert.ok(spot, 'на ровном есть место')
  const h = Math.hypot(spot.x + 0.5 - 3.5, spot.z + 0.5 - 0.5)
  assert.ok(h >= 1.6 && h <= 3.6, `в досягаемости: ${h}`)
  // Бугор в 2 клетках от клетки столба — голем на нём на блок выше.
  put(3, 64, 2, 'stone')
  assert.strictEqual(golemTopNear(bot, new Vec3(1, 64, 2)), 65)
  // Стена вокруг (2 высоты) — места нет.
  put(3, 64, 2, 'air')
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) if ((x + z) % 2 === 0) { put(x, 64, z, 'stone'); put(x, 65, z, 'stone') }
  assert.strictEqual(golemSpotNear(bot, golem), null)
})

test('литьё одним ведром: место на ровном берегу у озера, вровень с лавой; клетки и грани раскладки', () => {
  const cast1 = require('../src/cast1')
  const blocks = new Map()
  const put = (x, y, z, name, props = {}) => blocks.set(`${x},${y},${z}`, { name, boundingBox: /air|lava|water/.test(name) ? 'empty' : 'block', position: new Vec3(x, y, z), shapes: /air|lava|water/.test(name) ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => props })
  for (let x = -16; x <= 16; x++) for (let z = -12; z <= 12; z++) { for (let y = 90; y <= 99; y++) put(x, y, z, 'stone'); for (let y = 100; y <= 112; y++) put(x, y, z, 'air') }
  for (let x = 2; x <= 9; x++) for (let z = -5; z <= 5; z++) put(x, 99, z, 'lava', { level: 0 })
  const bot = { entity: { position: new Vec3(-1.5, 100, 0.5) }, blockAt: p => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || null, getControlState: () => false, entities: {} }
  const lava = []
  for (let x = 2; x <= 9; x++) for (let z = -5; z <= 5; z++) lava.push(new Vec3(x, 99, z))
  lava.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  const r = cast1.plan1(bot, lava)
  assert.ok(r.ok, JSON.stringify(r.reasons))
  const g = cast1.geom1(new Vec3(r.plan.origin.x, r.plan.origin.y, r.plan.origin.z), r.plan.axis, r.plan.side)
  // Низ рамы вровень с лавой (y 99), берег — пол на 99, тело на 100.
  assert.strictEqual(g.at(0, -1).y, 99)
  assert.strictEqual(bot.blockAt(g.G(0, -1)).name, 'stone')
  assert.strictEqual(bot.blockAt(g.H(0, -1)).name, 'lava')
  const cs = cast1.cells(g)
  assert.strictEqual(cs.length, 10)
  for (const t of cs) {
    // Вода и лава ложатся в «грань + сосед»: w и c.
    assert.ok(t.water.some(([ref, f]) => ref.plus(f).equals(t.w)), 'вода в w')
    assert.ok(t.lava.some(([ref, f]) => ref.plus(f).equals(t.c)), 'лава в c')
    // w — перед c (жёлоб), c и w соседи.
    assert.strictEqual(t.c.distanceTo(t.w), 1)
  }
})

test('литьё одним ведром: лава в досягаемости черпака — с земли ≥ 6, со столба ≥ 4; узкая полоса лавы — мимо', () => {
  const cast1 = require('../src/cast1')
  const mk = lavaBox => {
    const blocks = new Map()
    const put = (x, y, z, name, props = {}) => blocks.set(`${x},${y},${z}`, { name, boundingBox: /air|lava|water/.test(name) ? 'empty' : 'block', position: new Vec3(x, y, z), shapes: /air|lava|water/.test(name) ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => props })
    for (let x = -16; x <= 16; x++) for (let z = -12; z <= 12; z++) { for (let y = 90; y <= 99; y++) put(x, y, z, 'stone'); for (let y = 100; y <= 112; y++) put(x, y, z, 'air') }
    const lava = []
    for (let x = lavaBox[0]; x <= lavaBox[1]; x++) for (let z = lavaBox[2]; z <= lavaBox[3]; z++) { put(x, 99, z, 'lava', { level: 0 }); lava.push(new Vec3(x, 99, z)) }
    const bot = { entity: { position: new Vec3(-1.5, 100, 0.5) }, blockAt: p => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || null, getControlState: () => false, entities: {} }
    return { bot, lava }
  }
  // Озеро 8×11: место есть, со столба достаётся ≥ 4.
  const big = mk([2, 9, -5, 5])
  const r = cast1.plan1(big.bot, big.lava)
  assert.ok(r.ok, JSON.stringify(r.reasons))
  const g = cast1.geom1(new Vec3(r.plan.origin.x, r.plan.origin.y, r.plan.origin.z), r.plan.axis, r.plan.side)
  const R = cast1.lakeReach(p => big.bot.blockAt(p), g)
  assert.ok(R.ground.size >= 6 && R.top.size >= 4, `с земли ${R.ground.size}, со столба ${R.top.size}`)
  // Полоса 1×4 у берега: источников 4 < 11 — места нет, причина — досягаемость.
  const thin = mk([2, 2, -2, 1])
  const r2 = cast1.plan1(thin.bot, thin.lava)
  assert.ok(!r2.ok)
  assert.ok(r2.reasons.some(w => /лавы в досягаемости/.test(w)), JSON.stringify(r2.reasons))
})

test('клик ведром: пауза ≥ 55 мс между кликами, пропавший клик — повтор, ответ — по убыли предмета', async () => {
  const cast1 = require('../src/cast1')
  const inv = [{ name: 'water_bucket', count: 1 }]
  const calls = []
  let drop = 1
  const bot = {
    heldItem: inv[0],
    entity: { position: new Vec3(0, 0, 0), yaw: 0, pitch: 0 },
    inventory: { items: () => inv.filter(i => i.count > 0) },
    equip: async () => {},
    lookAt: async () => {},
    activateItem: () => {
      calls.push(Date.now())
      if (drop-- > 0) return // сервер уронил клик
      setTimeout(() => { inv[0] = { name: 'bucket', count: 1 }; bot.heldItem = inv[0] }, 15)
    }
  }
  bot._ndCast1Last = Date.now()
  const ok = await cast1.useAt(bot, new Vec3(1, 1, 1), 'water_bucket', { wait: 120 })
  assert.ok(ok)
  assert.strictEqual(calls.length, 2)
  assert.ok(calls[1] - calls[0] >= 54, `пауза ${calls[1] - calls[0]} мс`)
  // Предмета нет — клика нет.
  const none = await cast1.useAt(bot, new Vec3(1, 1, 1), 'lava_bucket')
  assert.ok(!none)
})

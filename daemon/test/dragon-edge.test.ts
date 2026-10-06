'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const dragon = require('../src/dragon')

// Край острова по трассе dtr-1-1 (2026-09-29, смерть на 45 с, out_of_world):
// тело на эндерняке у края (83.4, 55, −6.1), фаербол падает рядом (82.9, 56.9,
// −6.7), чистой клетки escapeSpot не нашёл. К востоку от x 83 между z −4 и 0 —
// выемка в пустоту, за ней полка острова ниже (z ≥ 1), по z = 0 на y 48 — наш
// мост с платформы. Запасной ход «напрямик» проверял только край у цели:
// цель за выемкой «не у края», а путь к ней — через пустоту.
function edgeWorld () {
  const solid = new Set()
  const put = (x, y, z) => solid.add(`${x},${y},${z}`)
  // Остров к западу (x ≤ 82) — сплошной, верх y 54 (ноги 55).
  for (let x = 60; x <= 82; x++) for (let z = -12; z <= 10; z++) for (let y = 40; y <= 54; y++) put(x, y, z)
  // Полоса у края (x 83..86, z −12..−5), верх 54, ступенька в блок на z = −5.
  for (let x = 83; x <= 86; x++) for (let z = -12; z <= -5; z++) for (let y = 44; y <= 54; y++) put(x, y, z)
  for (let x = 83; x <= 86; x++) put(x, 55, -5)
  // Полка ниже за выемкой (x 83..90, z 1..8), верх 49.
  for (let x = 83; x <= 90; x++) for (let z = 1; z <= 8; z++) for (let y = 40; y <= 49; y++) put(x, y, z)
  // Мост с платформы: z = 0, y 48, x 83..100.
  for (let x = 83; x <= 100; x++) put(x, 48, 0)
  return p => {
    const s = solid.has(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
    return { name: s ? 'end_stone' : 'air', boundingBox: s ? 'block' : 'empty', position: p }
  }
}
const bodyAt = (pos, entities: any = {} as Record<string, any>) => ({ entity: { position: pos }, blockAt: edgeWorld(), entities })

// Прямая от a к b: есть ли на ней точка без пола в трёх блоках ниже ног.
function crossesVoid (bot, a, b) {
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  let y = a.y
  for (let s = 0.2; s <= len; s += 0.2) {
    const x = a.x + (b.x - a.x) / len * s; const z = a.z + (b.z - a.z) / len * s
    let floor = null
    for (let yy = Math.floor(y) + 1; yy >= Math.floor(y) - 4; yy--) {
      if (bot.blockAt(new Vec3(x, yy, z)).boundingBox === 'block') { floor = yy + 1; break }
    }
    if (floor == null) return true
    y = floor
  }
  return false
}

test('уход «напрямик» у края: цель за выемкой отвергнута, путь целиком по земле', () => {
  const me = new Vec3(83.4, 55, -6.1)
  const bot = bodyAt(me)
  const away = new Vec3(82.9, 56.9, -6.7)
  const t = dragon.straightOut(bot, me, away)
  assert.ok(t, 'путь прочь по земле есть (к западу, в глубь острова)')
  assert.equal(crossesVoid(bot, me, t), false, `путь к ${t} идёт над пустотой`)
  assert.ok(Math.hypot(t.x - away.x, t.z - away.z) - Math.hypot(me.x - away.x, me.z - away.z) >= 2, 'цель дальше от удара')
})

test('уход «напрямик»: со всех сторон пустота — стоять (null), а не прыгать', () => {
  // Столбик 1×1 над пустотой: земли вокруг нет.
  const bot = { entity: { position: new Vec3(0.5, 61, 0.5) }, entities: {} as Record<string, any>, blockAt: p => {
    const s = Math.floor(p.x) === 0 && Math.floor(p.z) === 0 && Math.floor(p.y) <= 60 && Math.floor(p.y) >= 50
    return { name: s ? 'end_stone' : 'air', boundingBox: s ? 'block' : 'empty', position: p }
  } }
  assert.equal(dragon.straightOut(bot, bot.entity.position, new Vec3(1.5, 61, 0.5)), null)
})

test('шаг клавишами у выемки: обрыв впереди виден за два блока, бег и прыжок запрещены', () => {
  const me = new Vec3(83.4, 55, -6.1)
  const bot = bodyAt(me)
  const target = new Vec3(84.3, 55, 3.9)
  const k = dragon.stepKeys(bot, me, target, { sprint: true, onGround: true })
  assert.equal(k.stop, null, 'до обрыва больше блока — шагать можно')
  assert.equal(k.sprint, false, 'у обрыва не бежать')
  // У самой ступеньки (на z −5 — блок, за ней выемка): прыгать на неё нельзя —
  // с разбега тело пролетает ступеньку в блок шириной (dtr-1-1: 83.3,56.2,−4.9 →
  // 83.3,55.8,−3.8 → пустота).
  const atStep = new Vec3(83.4, 55, -5.9)
  const k2 = dragon.stepKeys(bodyAt(atStep), atStep, target, { sprint: true, onGround: true })
  assert.equal(k2.jump, false, 'за ступенькой пустота — не прыгать')
  // Совсем у края выемки (на ступеньке, z −4.3): стоп.
  const onStep = new Vec3(83.4, 56, -4.3)
  const k3 = dragon.stepKeys(bodyAt(onStep), onStep, target, { sprint: false, onGround: true })
  assert.ok(k3.stop && /обрыв/.test(k3.stop), `стоп у обрыва, а не шаг: ${JSON.stringify(k3)}`)
})

test('шаг клавишами по ровному: бег и прыжок на ступеньку разрешены', () => {
  const me = new Vec3(70.5, 55, -6.5)
  const world = edgeWorld()
  const bot = { entity: { position: me }, entities: {} as Record<string, any>, blockAt: p => (Math.floor(p.x) === 72 && Math.floor(p.y) === 55 && Math.floor(p.z) === -7)
    ? { name: 'end_stone', boundingBox: 'block', position: p } : world(p) }
  const target = new Vec3(78.5, 55, -6.5)
  const k = dragon.stepKeys(bot, me, target, { sprint: true, onGround: true })
  assert.equal(k.stop, null)
  assert.equal(k.sprint, true, 'по ровному острову бежать можно')
  const near = new Vec3(71.3, 55, -6.5)
  const k2 = dragon.stepKeys(bot, near, target, { sprint: true, onGround: true })
  assert.equal(k2.jump, true, 'ступенька в блок, за ней ровно — прыжок')
})

test('мост с платформы — сразу на высоте верха острова (стена у x 82, верх 54)', () => {
  const bot = { entity: { position: new Vec3(100.5, 49, 0.5) }, blockAt: p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const platform = y === 48 && x >= 98 && x <= 102 && z >= -2 && z <= 2
    const island = x <= 82 && y >= 40 && y <= 54
    const s = platform || island
    return { name: platform ? 'obsidian' : s ? 'end_stone' : 'air', boundingBox: s ? 'block' : 'empty', position: p }
  } }
  const edge = dragon.islandEdgeTop(bot, bot.entity.position, { x: -1, z: 0 })
  assert.deepEqual(edge, { k: 18, top: 55 })
})

test('уход «напрямик» не идёт сквозь чужое облако (d4-26: уход от посадки сквозь два облака)', () => {
  const me = new Vec3(73.4, 55, -6.1)
  const cloud = { id: 9, name: 'area_effect_cloud', position: new Vec3(67.5, 55, -6.1), isValid: true }
  const bot = bodyAt(me, { 9: cloud })
  const away = new Vec3(75.4, 55, -6.1)
  const t = dragon.straightOut(bot, me, away)
  assert.ok(t, 'путь в обход облака есть')
  const len = Math.hypot(t.x - me.x, t.z - me.z)
  for (let k = 0.5; k <= len; k += 0.5) {
    const x = me.x + (t.x - me.x) / len * k; const z = me.z + (t.z - me.z) / len * k
    assert.ok(Math.hypot(x - 67.5, z + 6.1) > 3.3, `путь в облаке: ${x.toFixed(1)},${z.toFixed(1)}`)
  }
})

// Одна проверка пути для всех ходов (d4–d14n: облака — 12 смертей из 34, ход сквозь свежее облако).
function flatWithCloud (cloudAt) {
  const flat = p => { const s = Math.floor(p.y) <= 60; return { name: s ? 'end_stone' : 'air', boundingBox: s ? 'block' : 'empty', position: p } }
  return { entity: { position: new Vec3(0.5, 61, 0.5) }, blockAt: flat, entities: cloudAt ? { 9: { id: 9, name: 'area_effect_cloud', position: cloudAt, isValid: true } } : {} as Record<string, any> }
}
test('облако на пути: шаг в него — стоп, из него наружу — можно, вглубь — нельзя', () => {
  const bot = flatWithCloud(new Vec3(10.5, 61, 0.5))
  const zones = dragon.cloudZones(bot)
  assert.equal(zones.length, 1)
  // Снаружи к облаку: радиус 3 + запас 0.8 → край на x ≈ 6.7; с x 5.8 шаг на блок — в облако.
  const k = dragon.stepKeys(bot, new Vec3(5.8, 61, 0.5), new Vec3(20.5, 61, 0.5), { zones })
  assert.ok(k.stop && /облак/.test(k.stop), JSON.stringify(k))
  // Изнутри наружу — можно.
  const k2 = dragon.stepKeys(bot, new Vec3(9.5, 61, 0.5), new Vec3(0.5, 61, 0.5), { zones })
  assert.equal(k2.stop, null)
  // Изнутри вглубь — нельзя.
  const k3 = dragon.stepKeys(bot, new Vec3(8.5, 61, 0.5), new Vec3(12.5, 61, 0.5), { zones })
  assert.ok(k3.stop, 'вглубь облака — стоп')
  // На блок выше облака (стоим на столбе над ним) коробка облака не достаёт.
  assert.equal(dragon.stepIntoZone(zones, new Vec3(8.5, 62, 0.5), new Vec3(9.5, 62, 0.5)), null)
})

// ab-23 (30.09): столб подъёма моста на платформе стоит в (101, 49..56, 1), тело
// на нём в (101.7, 57, 0.9) — центр над воздухом (101, 56, 0), хитбокс держится
// за столб. Мост «от клетки под центром» ставил блок по диагонали от столба, а
// следующий вызов не видел под ногами опоры и не строил мост вовсе.
function platformWorld ({ pillar = true, spike = false, islandPillar = false }: any = {} as Record<string, any>) {
  const at = new Map()
  const put = (x, y, z, name) => at.set(`${x},${y},${z}`, name)
  for (let x = 98; x <= 102; x++) for (let z = -2; z <= 2; z++) put(x, 48, z, 'obsidian')
  if (pillar) for (let y = 49; y <= 56; y++) put(101, y, 1, 'cobblestone')
  if (spike) for (let y = 0; y <= 80; y++) put(0, y, 0, 'obsidian')
  if (islandPillar) { for (let y = 40; y <= 60; y++) put(20, y, 20, 'end_stone'); put(20, 61, 20, 'cobblestone') }
  return p => {
    const n = at.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
    return { name: n || 'air', boundingBox: n ? 'block' : 'empty', position: p }
  }
}

test('опора под хитбоксом: со столба, свесившись центром над воздухом — столб, и это не остров', () => {
  const bot = { entity: { position: new Vec3(101.7, 57, 0.9) }, blockAt: platformWorld() }
  const sup = dragon.supportCell(bot)
  assert.deepEqual([sup.x, sup.y, sup.z], [101, 56, 1])
  assert.equal(dragon.offIsland(bot, sup), true, 'столб на платформе — над пустотой: мост')
  // Центр над опорой — она же.
  const bot2 = { entity: { position: new Vec3(100.5, 49, 0.5) }, blockAt: platformWorld({ pillar: false }) }
  const s2 = dragon.supportCell(bot2)
  assert.deepEqual([s2.x, s2.y, s2.z], [100, 48, 0])
  assert.equal(dragon.offIsland(bot2, s2), true, 'платформа — мост')
  // Под хитбоксом пусто — null.
  const bot3 = { entity: { position: new Vec3(104.5, 49, 0.5) }, blockAt: platformWorld({ pillar: false }) }
  assert.equal(dragon.supportCell(bot3), null)
})

test('не мост: верх обсидианового шипа (до самого низа без пустоты) и столб на острове', () => {
  const w = platformWorld({ pillar: false, spike: true, islandPillar: true })
  const spike = { entity: { position: new Vec3(0.5, 81, 0.5) }, blockAt: w }
  assert.equal(dragon.offIsland(spike, dragon.supportCell(spike)), false)
  const pil = { entity: { position: new Vec3(20.5, 62, 20.5) }, blockAt: w }
  assert.equal(dragon.offIsland(pil, dragon.supportCell(pil)), false)
})

// ab-24 (30.09, 208–213 с): тело на блоке (12.7, 62, 6.5) над краем старого облака
// (15.6, 61, 6.5; r 3.4–3.6), фаербол падает в (13.6, 60.9, 2.8). Любой шаг с блока
// вниз — в облако: escapeSpot 2 с отвечал «некуда», облако фаербола переехало на
// ноги, три удара по 6. Сквозь край облака (полблока пути) — лучше, чем стоять.
test('загнан на блок над краем облака, фаербол летит: уход краем облака, а не «некуда»', () => {
  const blockAt = p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const s = (x >= -20 && x <= 40 && z >= -20 && z <= 30 && y >= 40 && y <= 60) || (x === 12 && z === 6 && y === 61)
    return { name: s ? (y === 61 ? 'cobblestone' : 'end_stone') : 'air', boundingBox: s ? 'block' : 'empty', position: p }
  }
  const me = new Vec3(12.7, 62, 6.5)
  const bot = { entity: { position: me }, entities: {} as Record<string, any>, blockAt }
  const cloud = { pos: new Vec3(15.6, 61, 6.5), r: 3.6 }
  const f = { at: new Vec3(13.6, 60.9, 2.8), ground: new Vec3(13.6, 60.9, 2.8), line: null, ticks: 30 }
  const ctx = { clouds: [cloud], fireballs: [f], parts: null, breath: null }
  assert.equal(dragon.escapeSpot(bot, ctx, { away: f.at, budgetMs: 1350 }), null, 'чистого пути нет (как в ab-24)')
  const esc = dragon.escapeSpot(bot, ctx, { away: f.at, budgetMs: 1350, through: true })
  assert.ok(esc, 'краем облака — есть куда')
  assert.ok(esc.through > 0 && esc.through <= 2, `в облаке ${esc.through} блока пути`)
  assert.ok(esc.feet.distanceTo(f.at) >= 5.5, 'вне места фаербола')
  assert.ok(Math.hypot(esc.feet.x - cloud.pos.x, esc.feet.z - cloud.pos.z) >= cloud.r + 2.2, 'цель вне облака с запасом')
})

// ab-25 (30.09, 269–297 с): уход на клетку блоком выше из щели высотой в два
// блока (потолок над головой) — прыжки в потолок на месте 28 с, смерть в облаке.
test('на ступеньку — только если над головой есть куда подпрыгнуть', () => {
  const world = (ceiling) => p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const s = (y <= 60 && y >= 50 && x >= -5 && x <= 20 && z >= -5 && z <= 20) || // земля, ноги на 61
      (x <= 7 && y === 61 && x >= -5 && z >= -5 && z <= 20) || // ступень: к западу от x 8 земля на блок выше
      (ceiling && x === 8 && y === 63 && z === 7)
    return { name: s ? 'end_stone' : 'air', boundingBox: s ? 'block' : 'empty', position: p }
  }
  const from = new Vec3(8.3, 61, 7.5); const to = new Vec3(6.5, 62, 7.5)
  assert.equal(dragon.straightWalkable({ blockAt: world(false) }, from, to), true, 'без потолка — можно')
  assert.equal(dragon.straightWalkable({ blockAt: world(true) }, from, to), false, 'потолок над головой — не запрыгнуть')
})

// c3-19 (30.09, 186–200 с): сброшен драконом со столба у клетки на верх соседнего
// обелиска (обсидиан, 18 блоков над землёй) — там «копал эндерняк», облако и
// отброс с края. Верх шипа надо узнавать и слезать; платформа и остров — не шип.
test('верх обелиска — не остров и не платформа: слезать', () => {
  const at = new Map()
  const put = (x, y, z, n) => at.set(`${x},${y},${z}`, n)
  // Шип радиуса 2 в (12, *, -40) от 0 до 78; земля вокруг — эндерняк до 60.
  for (let x = 0; x <= 24; x++) for (let z = -52; z <= -28; z++) for (let y = 50; y <= 60; y++) put(x, y, z, 'end_stone')
  for (let x = 10; x <= 14; x++) for (let z = -42; z <= -38; z++) for (let y = 0; y <= 78; y++) put(x, y, z, 'obsidian')
  // Платформа у (100, 48, 0).
  for (let x = 98; x <= 102; x++) for (let z = -2; z <= 2; z++) put(x, 48, z, 'obsidian')
  const blockAt = p => { const n = at.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`); return { name: n || 'air', boundingBox: n ? 'block' : 'empty', position: p } }
  assert.equal(dragon.onSpike({ entity: { position: new Vec3(12.5, 79, -39.5) }, blockAt }), true, 'верх шипа')
  assert.equal(dragon.onSpike({ entity: { position: new Vec3(100.5, 49, 0.5) }, blockAt }), false, 'платформа — мост, не шип')
  assert.equal(dragon.onSpike({ entity: { position: new Vec3(20.5, 61, -30.5) }, blockAt }), false, 'земля острова')
})

// v2-26 (30.09, 188–221 с): сброс со столба у клетки не удался (шагнул в прыжке и
// остался на краю), бой пошёл с верхушки в 21 блоке — крылья, облако, смерть.
// Свой столб под ногами узнаётся, и вниз — копая его.
test('свой столб у клетки: высота до земли; невысокий блок и земля — не столб', () => {
  const at = new Map()
  const put = (x, y, z, n) => at.set(`${x},${y},${z}`, n)
  for (let x = 20; x <= 40; x++) for (let z = -35; z <= -15; z++) for (let y = 50; y <= 60; y++) put(x, y, z, 'end_stone')
  for (let y = 61; y <= 82; y++) put(30, y, -25, 'cobblestone')
  put(25, 61, -20, 'cobblestone')
  const blockAt = p => { const n = at.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`); return { name: n || 'air', boundingBox: n ? 'block' : 'empty', position: p } }
  const top = dragon.onOwnPillar({ entity: { position: new Vec3(30.5, 83, -24.5) }, blockAt })
  assert.deepEqual(top, { gy: 61, n: 22 })
  assert.equal(dragon.onOwnPillar({ entity: { position: new Vec3(25.5, 62, -19.5) }, blockAt }), null, 'блок «на блок» — не столб')
  assert.equal(dragon.onOwnPillar({ entity: { position: new Vec3(22.5, 61, -30.5) }, blockAt }), null, 'земля')
})

// v7-22 (30.09, 147–150 с): облако легло на уровне земли (y 61), тело в своей яме
// на блок ниже (ноги 60) — «на блок» (+1) оставлял ноги в полблоке облака, три удара.
test('на блок — выше верха облака: из ямы под облаком — на два', () => {
  const c = { pos: new Vec3(0, 61, 0), r: 5 }
  assert.equal(dragon.aboveCloudY(new Vec3(0.5, 60, 0.5), c), 62, 'из ямы — на два')
  assert.equal(dragon.aboveCloudY(new Vec3(0.5, 61, 0.5), c), 62, 'с земли — на один')
  assert.equal(dragon.aboveCloudY(new Vec3(0.5, 64, 0.5), c), 65, 'над облаком — как раньше, на один')
})

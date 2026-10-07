'use strict'
// S5d (07.10): конец игры — путь к крепости через Ад, подход к комнате, дракон.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

// Толща незерака со штреком 1×2 вдоль +x (y 48–49, z 0) — как у точки выхода после nether_tunnel (s5d-p1-1).
function tunnelWorld (extra: (p: any) => string | null = () => null) {
  const air = new Set<string>()
  for (let x = -10; x <= 10; x++) for (const y of [48, 49]) air.add(`${x},${y},0`)
  const read = (p: any) => {
    const e = extra(p)
    if (e) return { name: e, boundingBox: /lava|water|air/.test(e) ? 'empty' : 'block', position: p }
    return air.has(`${p.x},${p.y},${p.z}`) ? { name: 'air', boundingBox: 'empty', position: p } : { name: 'netherrack', boundingBox: 'block', position: p }
  }
  return { read, air }
}

// S5e (07.10): шахта и штрек по прогруженным чанкам (рентген толщи) — только «полный скан»; в rsg/ssg — честный спуск
// (endportal-descent, test/s5e-endgame). Эти тесты — про ход scan.
function scanFor (t: any) { const s = process.env.ND_KNOWLEDGE; process.env.ND_KNOWLEDGE = 'scan'; t.after(() => { if (s === undefined) delete process.env.ND_KNOWLEDGE; else process.env.ND_KNOWLEDGE = s }) }

test('камера под раму выхода: в толще со штреком стройка без камеры не находит места или копает невидимое, с камерой — рама в камере', () => {
  const { chamberPlan } = require('../src/travel')
  const nether = require('../src/nether')
  const { read, air } = tunnelWorld()
  const feet = new Vec3(0, 48, 0)
  const nearAir = (c: any) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => air.has(`${c.x + x},${c.y + y},${c.z + z}`))
  const before = nether.planPortal(read, feet)
  assert.ok(!before.ok || before.plan.dig.some((c: any) => !nearAir(c)), 'без камеры рама в толще требует копать закрытые клетки')
  const ch = chamberPlan(read, feet)
  assert.ok(ch.ok, JSON.stringify(ch))
  assert.ok(ch.cells.length <= 36, `камера ${ch.cells.length} клеток`)
  for (const c of ch.cells) air.add(`${c.x},${c.y},${c.z}`)
  const site = nether.planPortal(read, feet)
  assert.ok(site.ok, JSON.stringify(site))
  // Всё, что стройка будет копать, — в камере или рядом с её воздухом (видно), не за стенкой штрека.
  assert.ok(site.plan.dig.length <= 6, `копать ${site.plan.dig.length}`)
  for (const c of site.plan.dig) assert.ok(nearAir(c), `клетка ${c} без открытой грани`)
})

test('камера: сторона с лавой в 2 бл. от будущей рамы — не годится; лава со всех сторон — отказ с причиной', () => {
  const { chamberPlan } = require('../src/travel')
  const feet = new Vec3(0, 48, 0)
  // Лава в z = +3 (сбоку от камеры по +x/−x и прямо перед камерой по +z).
  const side = tunnelWorld(p => (p.z === 3 && p.y === 48 ? 'lava' : null))
  const a = chamberPlan(side.read, feet)
  assert.ok(a.ok)
  assert.deepEqual(a.dir, { x: 0, z: -1 }, `камера прочь от лавы: ${JSON.stringify(a.dir)}`)
  const all = tunnelWorld(p => (Math.max(Math.abs(p.x), Math.abs(p.z)) === 4 && p.y === 49 ? 'lava' : null))
  const b = chamberPlan(all.read, feet)
  assert.equal(b.ok, false)
  assert.match(b.why, /lava/)
})

test('камера: у края лавового озера здесь не ставится — ближняя годная клетка в 11 бл. от точки Ада (s5d-p3-1)', () => {
  const { chamberPlan, chamberSpot } = require('../src/travel')
  // Пол незерака y ≤ 78, воздух выше; лавовое озеро в полу x ∈ [0, 5], z ∈ [-3, 3].
  const read = (p: any) => {
    if (p.y === 78 && p.x >= 0 && p.x <= 5 && Math.abs(p.z) <= 3) return { name: 'lava', boundingBox: 'empty', position: p }
    return p.y <= 78 ? { name: 'netherrack', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p }
  }
  const feet = new Vec3(-1, 79, 0)
  assert.equal(chamberPlan(read, feet).ok, false)
  const s = chamberSpot(read, feet, { x: 0, z: 0 })
  assert.ok(s && s.ok, 'нашлась клетка')
  assert.ok(Math.hypot(s.at.x, s.at.z) <= 11, `в 11 бл. от точки: ${s.at}`)
  assert.ok(chamberPlan(read, s.at).ok)
})

test('шахта к комнате по карте: колонка с пещерой до уровня комнаты — не вход, берётся целая в 24 бл. (s5d-p4-1)', (t) => {
  scanFor(t)
  const { dryEntry } = require('../src/endportal')
  // Суша: камень до y 70, воздух выше. Пещера x ∈ [96, 104], y 50..60 (под шахтой x 100); комната на y 40.
  const blockAt = (p: any) => {
    if (p.y > 70) return { name: 'air', boundingBox: 'empty' }
    if (p.x >= 96 && p.x <= 104 && Math.abs(p.z) <= 4 && p.y >= 50 && p.y <= 60) return { name: 'cave_air', boundingBox: 'empty' }
    return { name: 'stone', boundingBox: 'block' }
  }
  const bot: any = { entity: { position: new Vec3(100, 71, 0) }, blockAt }
  const old = dryEntry(bot, { x: 100, z: 0 })
  assert.deepEqual([old.x, old.z], [100, 0], 'без уровня комнаты — сухая колонка прямо над пещерой')
  const d = dryEntry(bot, { x: 100, z: 0 }, 96, 40)
  assert.ok(d && d.sound, JSON.stringify(d))
  assert.ok(d.x < 96 || d.x > 104 || Math.abs(d.z) > 4, `колонка мимо пещеры: ${d.x},${d.z}`)
  assert.ok(d.r <= 24)
})

// Тактика (узкая правка S5d): одни чешуйницы/эндермиты при броне ≥ 10 — навык идёт (s5d-p6-1: Fight сквозь решётку ×100+,
// s5d-p6-2: еда у комнаты оборвана — БЛОКЕР «hunger 6/18»); зомби или чешуйница без брони — тактика как прежде.
test('тактика: чешуйницы у портальной комнаты в броне не забирают навык, зомби и голое тело — забирают', () => {
  const { EventEmitter } = require('node:events')
  const { observeTactics } = require('../src/tactics/minecraft')
  const md = require('minecraft-data')('1.21.11')
  const session = (mob: string | null, armor: boolean, hp = 20) => {
    const bot: any = new EventEmitter()
    bot.version = '1.21.11'; bot.health = hp; bot.food = 20
    bot.inventory = { slots: armor ? Object.assign([], { 5: { name: 'iron_helmet' }, 6: { name: 'iron_chestplate' }, 7: { name: 'iron_leggings' }, 8: { name: 'iron_boots' } }) : [], items: () => [{ name: 'iron_sword', count: 1 }] }
    bot.registry = md
    bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [], yaw: 0, pitch: 0, velocity: new Vec3(0, 0, 0) }
    bot.entities = mob ? { 2: { id: 2, name: mob, type: 'hostile', position: new Vec3(2.5, 64, .5), height: 0.3, width: 0.4, metadata: [], velocity: new Vec3(0, 0, 0), equipment: [] } } : {}
    bot.game = { dimension: 'overworld', gameMode: 'survival' }
    bot.blockAt = (p: any) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
    return { bot, current: { name: 'eat' }, reflex: null, bus: { emit: () => {} }, tempo: null }
  }
  const st = observeTactics(session('silverfish', true))
  assert.ok(st.armor >= 10, `броня ${st.armor}`)
  assert.equal(st.protectedEncounter, true, JSON.stringify(st.enemies))
  assert.equal(observeTactics(session('silverfish', false)).protectedEncounter, false)
  assert.equal(observeTactics(session('zombie', true)).protectedEncounter, false)
  assert.equal(observeTactics(session(null, true)).protectedEncounter, false)
  assert.equal(observeTactics(session('silverfish', true, 12)).protectedEncounter, false, 'хп < 16 — рой, бой тактики (s5d-p7-2)')
})

test('шахта к комнате: колонка, от которой штрек на уровне комнаты идёт мимо воды (s5d-p7-1)', (t) => {
  scanFor(t)
  const { dryEntry } = require('../src/endportal')
  // Камень до y 70; на уровне комнаты (y 39–42) вода x ∈ [102, 105], z ∈ [−8, −2] — прямо между колонкой (100, −5) и целью
  // (108, 40, −5); годна колонка, от которой прямая до цели идёт мимо воды.
  const blockAt = (p: any) => {
    if (p.y > 70) return { name: 'air', boundingBox: 'empty' }
    if (p.y >= 39 && p.y <= 42 && p.x >= 102 && p.x <= 105 && p.z >= -8 && p.z <= -2) return { name: 'water', boundingBox: 'empty' }
    return { name: 'stone', boundingBox: 'block' }
  }
  const bot: any = { entity: { position: new Vec3(100, 71, 0) }, blockAt }
  const target = { x: 108, y: 40, z: -5 }
  const d = dryEntry(bot, { x: 100, z: -5 }, 96, 40, target)
  assert.ok(d && d.sound, JSON.stringify(d))
  assert.ok(!(d.x === 100 && d.z === -5), 'прямо через воду не идёт')
})

test('камера: под гравием не ставится — сторона или клетка без сыпучего над камерой (s5d-H-2)', () => {
  const { chamberPlan } = require('../src/travel')
  const feet = new Vec3(0, 48, 0)
  // Гравий над камерой по +x (x 1..2, y 51..52) — камера уходит в другую сторону.
  const w = tunnelWorld(p => (p.x >= 1 && p.x <= 2 && p.y >= 51 && p.y <= 52 && Math.abs(p.z) <= 2 ? 'gravel' : null))
  const ch = chamberPlan(w.read, feet)
  assert.ok(ch.ok)
  assert.equal(ch.dir.x, -1, `камера прочь от гравия: ${JSON.stringify(ch.dir)}`)
})

test('шахта: целой колонки нет нигде — колонка с пещерой ≤ 4 бл. без капельника, а не первая сухая (s5d-R-1)', (t) => {
  scanFor(t)
  const { dryEntry } = require('../src/endportal')
  // Везде пещера y 50..52 (3 бл.); у колонки шахты (|x−100| ≤ 3) в пещере капельник.
  const blockAt = (p: any) => {
    if (p.y > 70) return { name: 'air', boundingBox: 'empty' }
    if (p.y >= 50 && p.y <= 52) return Math.abs(p.x - 100) <= 3 && Math.abs(p.z) <= 3 && p.y === 52 ? { name: 'pointed_dripstone', boundingBox: 'block' } : { name: 'cave_air', boundingBox: 'empty' }
    return { name: 'stone', boundingBox: 'block' }
  }
  const bot: any = { entity: { position: new Vec3(100, 71, 0) }, blockAt }
  const d = dryEntry(bot, { x: 100, z: 0 }, 96, 40)
  assert.equal(d.sound, 'caves', JSON.stringify(d))
  assert.ok(Math.abs(d.x - 100) > 3 || Math.abs(d.z) > 3, `мимо капельника: ${d.x},${d.z}`)
})

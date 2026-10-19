'use strict'
// S10 (07.10): честное восприятие — переключатель знания, глаза + память, «пирог» без клетки, слух, F3.
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'events'
import { Vec3 } from 'vec3'
import * as knowledge from '../src/perception/knowledge'
import * as eyes from '../src/perception/eyes'
import * as senses from '../src/perception/senses'

function withEnv (env: Record<string, string | undefined>, fn: () => void) {
  const old: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  try { fn() } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k] } }
}
const CLEAN = { ND_KNOWLEDGE: undefined, ND_MAP: undefined, MAP: undefined, GRID: undefined, MAP_SH: undefined, MAP_BASTIONS: undefined, MAP_LAVA: undefined, ND_ROUTE: undefined }

test('ND_KNOWLEDGE: по умолчанию rsg; старые флаги выводят уровень; явный уровень — потолок', () => {
  withEnv(CLEAN, () => {
    assert.equal(knowledge.level(), 'rsg')
    assert.equal(knowledge.mapLevel(), 'blind')
    for (const what of ['seedtool', 'structures', 'lava', 'blocks', 'grid', 'gold']) assert.equal(knowledge.allows(what), false, what)
  })
  withEnv({ ...CLEAN, ND_MAP: 'struct' }, () => { assert.equal(knowledge.level(), 'ssg'); assert.equal(knowledge.mapLevel(), 'struct') })
  withEnv({ ...CLEAN, ND_MAP: 'blocks' }, () => assert.equal(knowledge.level(), 'scan'))
  withEnv({ ...CLEAN, MAP: '1', GRID: '1', MAP_SH: '1' }, () => assert.equal(knowledge.level(), 'scan'))
  withEnv({ ...CLEAN, MAP_SH: '1' }, () => assert.equal(knowledge.level(), 'ssg'))
  withEnv({ ...CLEAN, ND_ROUTE: '1', MAP_LAVA: '1' }, () => assert.equal(knowledge.level(), 'rsg', 'ND_ROUTE и MAP_LAVA уровня не поднимают (S8c)'))
  withEnv({ ...CLEAN, ND_MAP: '0', MAP: '1' }, () => assert.equal(knowledge.level(), 'rsg', 'ND_MAP=0 — окончательно вслепую'))
  // Явный уровень — потолок: ND_MAP выше него не действует, ниже — действует.
  withEnv({ ...CLEAN, ND_KNOWLEDGE: 'rsg', ND_MAP: 'blocks', GRID: '1' }, () => {
    assert.equal(knowledge.level(), 'rsg'); assert.equal(knowledge.mapLevel(), 'blind'); assert.equal(knowledge.allows('grid'), false)
  })
  withEnv({ ...CLEAN, ND_KNOWLEDGE: 'scan', ND_MAP: 'struct' }, () => { assert.equal(knowledge.mapLevel(), 'struct'); assert.equal(knowledge.allows('gold'), true) })
  withEnv({ ...CLEAN, ND_KNOWLEDGE: 'ssg' }, () => {
    assert.equal(knowledge.allows('seedtool'), true); assert.equal(knowledge.allows('lava'), true)
    assert.equal(knowledge.allows('blocks'), false); assert.equal(knowledge.allows('grid'), false)
  })
  assert.throws(() => knowledge.allows('xray'), /неизвестный вид/)
})

test('rsg: загрузчики не читают ни скан копии, ни seedtool, ни его кэш (проверка в загрузчике)', () => {
  const fs: typeof import('fs') = require('fs')
  const cp: typeof import('child_process') = require('child_process')
  const reads = []
  const rf = fs.readFileSync; const ex = fs.existsSync; const ef = cp.execFileSync
  fs.readFileSync = function (f, ...a) { reads.push(String(f)); return rf.call(this, f, ...a) }
  fs.existsSync = function (f) { reads.push(String(f)); return ex.call(this, f) }
  cp.execFileSync = function (...a) { reads.push('exec ' + a[0]); return ef.apply(this, a) }
  const SEED = '3816274920780408390' // есть строка good-v2 и скан farm/route-scan (как в s8c-overworld)
  try {
    const route: typeof import('../src/route') = require('../src/route')
    const pn: typeof import('../src/portal-natural') = require('../src/portal-natural')
    withEnv({ ...CLEAN, ND_KNOWLEDGE: 'rsg', ND_MAP: 'blocks' }, () => {
      assert.equal(route.routeInfo(SEED), null)
      assert.equal(route.seedInfo(SEED), null)
      assert.equal(route.poolRow(SEED), null)
      assert.equal(route.oresOf(SEED), null)
      assert.deepEqual(pn.poolInfo(SEED), { scanned: false, hint: null })
    })
    const leaked = reads.filter(f => /good-v2|route-scan|route-info|seedtool|portal-scan/.test(f))
    assert.deepEqual(leaked, [], 'в rsg ни одного чтения карты')
    // Тот же сид на ssg — карта есть: значит, null выше дал именно запрет уровня.
    withEnv({ ...CLEAN, ND_KNOWLEDGE: 'ssg' }, () => {
      const i = route.routeInfo(SEED)
      assert.ok(i && i.map === 'struct', 'ssg — карта построек и лавы')
      assert.deepEqual(i.ores.iron, [], 'ssg — без руды скана')
    })
  } finally { fs.readFileSync = rf; fs.existsSync = ex; cp.execFileSync = ef }
})

// ---------------------------------------------------------------- мир из настоящих чанков 1.21.11

function world () {
  const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
  const Chunk: any = (require('prismarine-chunk') as typeof import('prismarine-chunk').default)(registry)
  const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
  const columns = new Map()
  const w: any = new EventEmitter()
  w.getColumn = (cx, cz) => {
    if (Math.abs(cx) > 4 || Math.abs(cz) > 4) return null // прорисовка: 9×9 столбцов
    const k = `${cx},${cz}`
    if (!columns.has(k)) columns.set(k, new Chunk({ minY: -64, worldHeight: 384 }))
    return columns.get(k)
  }
  const id = n => registry.blocksByName[n].defaultState
  const set = (x, y, z, n) => w.getColumn(x >> 4, z >> 4).setBlockStateId(new Vec3(x & 15, y, z & 15), id(n))
  const get = (x, y, z) => { const c = w.getColumn(x >> 4, z >> 4); return c ? c.getBlockStateId(new Vec3(x & 15, y, z & 15)) : null }
  // Пол — камень y 50..63 в 3×3 чанках у начала.
  for (let x = -16; x < 32; x++) for (let z = -16; z < 32; z++) for (let y = 50; y <= 63; y++) set(x, y, z, 'stone')
  const bot: any = new EventEmitter()
  Object.assign(bot, {
    registry,
    version: '1.21.11',
    game: { minY: -64, height: 384, dimension: 'overworld' },
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, height: 1.8, yaw: 0, pitch: 0 },
    entities: {},
    world: w,
    blockAt: p => { const s = get(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); if (s === null) return null; const b = Block.fromStateId(s, 0); b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b }
  })
  // Луч мира — как prismarine-world raycast (sight.seesBlock, visibleOf).
  const { RaycastIterator } = (require('prismarine-world') as typeof import('prismarine-world')).iterators
  w.raycast = (from, dir, range, matcher = null) => {
    const iter = new RaycastIterator(from, dir, range)
    let pos = iter.next()
    while (pos) {
      const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (b && (!matcher || matcher(b, iter))) { const hit = iter.intersect(b.shapes, b.position); if (hit) return b }
      pos = iter.next()
    }
    return null
  }
  // Смена клетки — как mineflayer: blockUpdate(old, new) у мира.
  const change = (x, y, z, n) => { const old = bot.blockAt(new Vec3(x, y, z)); set(x, y, z, n); w.emit('blockUpdate', old, bot.blockAt(new Vec3(x, y, z))) }
  return { bot, set, change, registry }
}

function scene () {
  const W = world()
  const { set } = W
  set(6, 64, 0, 'chest') // на виду
  set(-6, 64, 0, 'iron_ore') // руда на виду
  set(0, 58, 6, 'chest') // закопан в камне
  set(-4, 57, -4, 'iron_ore') // руда в толще
  // За стеной: стена z = -3 (x -6..6, y 64..69), за ней сундук и руда — с открытыми гранями, но луч упирается в стену.
  for (let x = -6; x <= 6; x++) for (let y = 64; y <= 69; y++) set(x, y, -3, 'stone')
  set(0, 64, -6, 'chest')
  set(2, 64, -6, 'iron_ore')
  set(3, 64, 5, 'barrel') // бочка: у неё нет отрисовщика — «пирог» её не считает
  return W
}

test('глаза: видимые сундук и руда — в памяти; за стеной и под землёй — нет (рентгена нет)', () => {
  const { bot } = scene()
  const e = eyes.install(bot, { every: 1000 })
  for (let i = 0; i < 6; i++) e.sweep({ rays: 5000, maxMs: 1000 })
  const chests = eyes.nearest(bot, 'chest', { max: 10 })
  assert.deepEqual(chests.map(c => [c.x, c.y, c.z]), [[6, 64, 0]])
  const ores = eyes.nearest(bot, 'iron*', { max: 10 })
  assert.deepEqual(ores.map(c => [c.x, c.y, c.z]), [[-6, 64, 0]])
  assert.equal(eyes.seesNow(bot, { x: 0, y: 64, z: -6 }), false, 'сундук за стеной')
  assert.equal(eyes.seesNow(bot, { x: 0, y: 58, z: 6 }), false, 'сундук в толще')
  assert.equal(eyes.seesNow(bot, { x: 6, y: 64, z: 0 }), true)
  e.detach()
})

test('память: увиденное помнится за спиной, blockUpdate забывает; вскрытая руда видна после копки', () => {
  const W = scene()
  const { bot, change } = W
  const e = eyes.install(bot, { every: 1000 })
  e.sweep({ rays: 5000, maxMs: 1000 })
  // Ушёл за стену (z = -5): сундук на 6,64,0 отсюда не виден, но помнится.
  bot.entity.position = new Vec3(0.5, 64, -5.5)
  assert.equal(eyes.seesNow(bot, { x: 6, y: 64, z: 0 }), false)
  e.sweep({ rays: 5000, maxMs: 1000 })
  const names = eyes.nearest(bot, 'chest', { max: 10 }).map(c => `${c.x},${c.y},${c.z}`)
  assert.ok(names.includes('6,64,0'), 'помнит увиденный раньше')
  assert.ok(names.includes('0,64,-6'), 'за стеной теперь видно')
  // Сундук сломали — забыт.
  change(6, 64, 0, 'air')
  assert.ok(!eyes.nearest(bot, 'chest', { max: 10 }).some(c => c.x === 6), 'сменённая клетка забыта')
  // Руда в толще: вскрыли камень над ней — грань открылась, обход её видит (секция пересканирована).
  for (let y = 57; y <= 63; y++) change(-4, y, -3, 'air') // колодец рядом с рудой: клетка 57 — у её грани +z
  assert.ok(!eyes.nearest(bot, 'iron_ore', { max: 10 }).some(c => c.y === 57), 'до обхода — не видел')
  bot.entity.position = new Vec3(-3.5, 58, -2.5) // стою в колодце
  e.sweep({ rays: 5000, maxMs: 1000 })
  assert.ok(eyes.nearest(bot, 'iron_ore', { max: 10 }).some(c => c.x === -4 && c.y === 57 && c.z === -4), 'вскрытая руда увидена')
  e.detach()
})

test('«пирог»: счёт по типу в прорисовке без клетки; бочку не считает; сектор и пеленг; место — ходом по пеленгам', () => {
  const { bot } = scene()
  const p: any = senses.pie(bot)
  assert.equal(p.byType.chest, 3, 'видимый, закопанный и за стеной — все в «пироге»')
  assert.equal(p.byType.barrel, undefined, 'у бочки нет отрисовщика')
  const flat = JSON.stringify(p)
  assert.ok(!/"x"|"y"|"z"/.test(flat), 'в ответе нет клеток: ' + flat)
  // Сектор взгляда: на север (yaw 180) — только сундук за стеной (0,64,-6).
  assert.equal((senses.pie(bot, { yaw: 180, fov: 30 }).byType as Record<string, number>).chest, 1)
  assert.equal((senses.pie(bot, { yaw: 0, fov: 30 }).byType as Record<string, number>).chest, 1, 'юг — закопанный 0,58,6')
  // Пеленг дугой поворота: один сундук — середина дуги на его направлении (±шаг).
  const arcs = senses.pieArcs(bot, 'chest', { fov: 30, step: 2 })
  const north = arcs.find(a => Math.abs(Math.abs(a.center) - 180) < 4)
  assert.ok(north, JSON.stringify(arcs))
  const truth = senses.yawOf(0.5 - 0.5, -6 + 0.5 - 0.5) // от глаз к центру сундука 0,64,-6
  assert.ok(Math.abs(Math.abs(north.center) - Math.abs(truth)) <= 2, `${north.center} vs ${truth}`)
  // Два пеленга из разных точек — место с точностью до пары блоков.
  const target = { x: 40, z: -25 }
  const s = [{ x: 0, z: 0 }, { x: 24, z: 10 }].map(q => ({ ...q, yaw: Math.round(senses.yawOf(target.x - q.x, target.z - q.z) / 2) * 2 }))
  const t = senses.triangulate(s)
  assert.ok(t && Math.hypot(t.x - target.x, t.z - target.z) < 3, JSON.stringify(t))
  assert.equal(senses.triangulate([s[0], { ...s[0], x: 1 }]), null, 'почти параллельные — нет места')
})

test('слух: субтитр — что, сторона (8 румбов) и полоса дальности; звук моба — к мобу без его места', () => {
  const W = scene()
  const { bot } = W
  bot.entities = { 7: { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(10.5, 64, -9.5), height: 1.95 } }
  bot._client = new EventEmitter()
  senses.installHearing(bot)
  // Номер в пакете — номер реестра игры (с 0), в minecraft-data — с 1 (s10-e-1: хаск слышался как entity.hostile.swim).
  const sid = (Object.values(bot.registry.sounds) as any[]).find((x: any) => x.name === 'entity.zombie.ambient').id - 1
  bot._client.emit('sound_effect', { sound: { soundId: sid }, soundCategory: 'hostile', x: 10.5 * 8, y: 65 * 8, z: -9.5 * 8, volume: 1, pitch: 1 })
  const h = senses.heard(bot)
  assert.equal(h.length, 1)
  assert.deepEqual({ who: h[0].who, kind: h[0].kind, dir8: h[0].dir8, dir4: h[0].dir4, band: h[0].band }, { who: 'zombie', kind: 'mob', dir8: 'northeast', dir4: 'east', band: 'средне' })
  assert.ok(!('x' in h[0]), 'без точки')
  assert.equal(senses.band(3), 'рядом'); assert.equal(senses.band(7.5), 'близко'); assert.equal(senses.band(20), 'далеко')
  assert.equal(senses.dir8(0, 5), 'south'); assert.equal(senses.dir8(-3, -3), 'northwest')
  // Сущности: зомби за стеной (z -9.5, стена z -3) не виден; слышен — есть в списке, но без места.
  bot.entity.position = new Vec3(10.5, 64, 0.5)
  for (let x = 6; x <= 14; x++) for (let y = 64; y <= 69; y++) W.set(x, y, -3, 'stone')
  const known = eyes.entities(bot)
  assert.equal(known.length, 1)
  assert.equal(known[0].seen, false)
  assert.ok(known[0].heard && !known[0].pos, JSON.stringify(known[0]))
  // Тишина и стена — его нет.
  bot._ndEars.log.length = 0
  assert.deepEqual(eyes.entities(bot), [])
  // Стены нет — виден, место есть.
  for (let x = 6; x <= 14; x++) for (let y = 64; y <= 69; y++) W.set(x, y, -3, 'air')
  const seen = eyes.entities(bot)
  assert.ok(seen[0].seen && seen[0].pos)
})

test('F3: координаты, чанк, направление как F3, биом/свет без ошибок, блок под прицелом', () => {
  const { bot } = scene()
  bot.entity.yaw = Math.PI // mineflayer: π — лицом на юг (+Z)
  bot.entity.pitch = 0
  const f = senses.f3(bot)
  assert.deepEqual(f.block, { x: 0, y: 64, z: 0 })
  assert.deepEqual(f.chunk, { x: 0, z: 0, in: { x: 0, z: 0 } })
  assert.equal(f.facing.dir4, 'south')
  assert.equal(f.facing.yaw, 0)
  bot.entity.yaw = Math.PI / 2 // запад (−X), взгляд чуть вниз — на руду 6 бл. к западу
  bot.entity.pitch = -Math.atan2(65.62 - 64.5, 6)
  const g = senses.f3(bot)
  assert.equal(g.facing.dir4, 'west'); assert.equal(g.facing.yaw, 90)
  assert.equal(g.target && g.target.name, 'iron_ore', 'на западе руда в 6 бл.')
})

test('бюджет обхода: лучей не больше заданного за обход', () => {
  const { bot } = scene()
  const e = eyes.install(bot, { every: 1000 })
  const r = e.sweep({ rays: 3, maxMs: 1000 })
  assert.ok(r.rays <= 3 + 12, `лучей ${r.rays}`) // кандидат начатый — до 13 лучей
  const st = eyes.stats(bot)
  assert.equal(st.sweeps, 1)
  assert.ok(st.cpu && typeof st.cpu.share !== 'undefined')
  e.detach()
})

test('eyes.locate: rsg — только увиденное (память + взгляд), scan — как findBlocks (знание карты)', () => {
  const { bot } = scene()
  bot.findBlocks = () => [new Vec3(0, 58, 6), new Vec3(0, 64, -6), new Vec3(6, 64, 0)]
  withEnv({ ...CLEAN, ND_KNOWLEDGE: 'rsg' }, () => {
    const e = eyes.install(bot, { every: 1000 })
    const got = eyes.locate(bot, ['chest'], { radius: 64 }).map(p => `${p.x},${p.y},${p.z}`)
    assert.deepEqual(got, ['6,64,0'], 'закопанный и за стеной — не найдены')
    e.detach()
  })
  withEnv({ ...CLEAN, ND_KNOWLEDGE: 'scan' }, () => assert.equal(eyes.locate(bot, ['chest']).length, 3))
})

test('explore: увиденное раньше (за стеной теперь) — первым отрезком к нему, а не веером', async () => {
  const W = scene()
  const { bot, set, registry } = W
  // Бревно на западе за стеной x = −10; с 20 бл. к северу от стены оно на виду.
  for (let z = -12; z <= 12; z++) for (let y = 64; y <= 72; y++) set(-10, y, z, 'stone')
  set(-40, 64, 0, 'oak_log')
  for (let x = -60; x <= -11; x++) for (let y = 50; y <= 63; y++) for (let z = -20; z <= 20; z++) set(x, y, z, 'stone')
  const e = eyes.install(bot, { every: 1000 })
  bot.entity.position = new Vec3(-25.5, 64, -20.5)
  e.sweep({ rays: 5000, maxMs: 1000 })
  assert.ok(eyes.nearest(bot, 'oak_log').length === 1, 'увидел бревно с севера')
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  assert.equal(eyes.seesNow(bot, { x: -40, y: 64, z: 0 }), false, 'отсюда не видно')
  bot.pathfinder = { goto: async g => { bot.entity.position = new Vec3(g.x + (g.x < bot.entity.position.x ? 3 : -3) + 0.5, 64, g.z + 0.5) }, setGoal (g) { if (g) this.goto(g).then(() => bot.emit('goal_reached', g)) }, movements: null }
  const actions: typeof import('../src/actions') = require('../src/actions')
  const r = await actions.explore({ bot, mcData: registry, cfg: { fairPlay: true } }, { aborted: false, onAbort: [] }, { block: 'oak_log', radius: 32, timeoutSeconds: 5 })
  assert.equal(r.found, 'oak_log', JSON.stringify(r))
  assert.match(r.legs[0], /^память oak_log -40,64,0/)
  assert.equal(r.note, 'видел раньше — подошёл')
  e.detach()
})

test('observe: увиденное раньше (сейчас за стеной) — в blocks с пометкой remembered; ND_OBSERVE_MEM=0 — нет', () => {
  const { bot, registry } = scene()
  const e = eyes.install(bot, { every: 1000 })
  e.sweep({ rays: 5000, maxMs: 1000 })
  bot.entity.position = new Vec3(0.5, 64, -5.5) // за стеной: сундук 6,64,0 не виден
  bot.blockAtCursor = () => null
  const { observe }: typeof import('../src/perception') = require('../src/perception')
  const o = observe(bot, registry, { radius: 24 })
  // Бочка 3,64,5 видна была от начала, отсюда — за стеной: помнится. Сундук отсюда виден (0,64,-6) — группа зрения, без пометки.
  const barrel = o.blocks.find(b => b.name === 'barrel')
  assert.ok(barrel && barrel.remembered && barrel.nearest.z === 5, JSON.stringify(o.blocks))
  assert.ok(o.blocks.find(b => b.name === 'chest' && !b.remembered))
  withEnv({ ND_OBSERVE_MEM: '0' }, () => assert.ok(!observe(bot, registry, { radius: 24 }).blocks.some(b => b.remembered)))
  e.detach()
})

test('fairPlay выключается только на scan: в rsg ND_FAIR_PLAY=false не даёт рентгена', () => {
  const load = () => { delete require.cache[require.resolve('../src/config')]; const c: any = require('../src/config'); return (c.cfg || c.config || c).fairPlay }
  withEnv({ ...CLEAN, ND_FAIR_PLAY: 'false', ND_KNOWLEDGE: 'rsg' }, () => assert.equal(load(), true))
  withEnv({ ...CLEAN, ND_FAIR_PLAY: 'false', ND_KNOWLEDGE: 'scan' }, () => assert.equal(load(), false))
  withEnv({ ...CLEAN, ND_FAIR_PLAY: undefined }, () => assert.equal(load(), true))
  delete require.cache[require.resolve('../src/config')]
})

test('pieSeek: закопанный сундук — пеленг, шаг поперёк, пеленг, ближе — оценка в пару блоков и чанк, клетки не видно', async () => {
  const W = world()
  const { bot, set } = W
  for (let x = 38; x <= 42; x++) for (let y = 55; y <= 61; y++) for (let z = 28; z <= 32; z++) set(x, y, z, 'stone')
  set(40, 58, 30, 'chest')
  bot.pathfinder = { goto: async g => { bot.entity.position = new Vec3(g.x + 0.5, 64, g.z + 0.5) }, setGoal (g) { if (g) this.goto(g).then(() => bot.emit('goal_reached', g)) }, movements: null }
  const r = await senses.pieSeek({ bot }, { aborted: false, onAbort: [] }, { type: 'chest', base: 24, timeoutSeconds: 60 })
  assert.ok(r.found, JSON.stringify(r))
  const err = Math.hypot(r.estimate.x - 40.5, r.estimate.z - 30.5)
  assert.ok(err < 3, `ошибка ${err}: ${JSON.stringify(r)}`)
  assert.deepEqual(r.chunk, { x: 2, z: 1 })
  assert.equal(r.samples.length, 3)
  assert.equal(eyes.seesNow(bot, { x: 40, y: 58, z: 30 }), false, 'сундук в толще — не виден и после поиска')
})

test('слух лавы: только лава с воздухом сверху (звук клиента), наружу — румб 22.5° и дальность до 4 бл.; skip — следующая', () => {
  const W = world()
  const { bot, set } = W
  set(20, 55, 0, 'lava') // в толще — молчит
  assert.equal(senses.hearLavaPoint(bot), null)
  set(20, 63, 0, 'lava') // в полу, над ней воздух — слышно
  const h = senses.hearLavaPoint(bot)
  assert.ok(h && Math.abs(h.yaw + 90) < 1e-9, JSON.stringify(h)) // восток: F3-yaw −90
  assert.ok(h.dist % 4 === 0 && Math.abs(h.at.x - 20) <= 4 && Math.abs(h.at.z) <= 4, JSON.stringify(h))
  set(-12, 63, 0, 'lava')
  assert.ok(senses.hearLavaPoint(bot).yaw === 90, 'ближняя — на западе')
  assert.ok(senses.hearLavaPoint(bot, { skip: q => q.x === -12 }).yaw === -90, 'отброшенная — следующий звук')
  // Слышимая сущность без места → точка на середине полосы по румбу.
  const p = senses.hearPoint(bot, { dir8: 'south', band: 'средне' })
  assert.deepEqual([p.x, p.z], [0.5, 12.5])
})

test('stateSummary: живой с 0.24 хп — health 1, а не 0 (арена читала 0 как смерть, S7d)', () => {
  const { stateSummary }: typeof import('../src/perception') = require('../src/perception')
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5), effects: {} }, inventory: { slots: new Array(46).fill(null), items: () => [] }, players: {}, game: { dimension: 'overworld' }, blockAt: () => null, food: 20 }
  bot.health = 0.24
  assert.equal(stateSummary(bot).health, 1)
  bot.health = 0
  assert.equal(stateSummary(bot).health, 0)
  bot.health = 13.6
  assert.equal(stateSummary(bot).health, 14)
})

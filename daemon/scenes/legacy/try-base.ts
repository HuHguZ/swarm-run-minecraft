'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// База и общак: место, которое бот считает своим, и сундук, про который он
// знает, что в нём лежит, не открывая его.
//
// Что здесь на самом деле проверяется. Не «сундук работает» — это закрыто
// прошлым заходом (try-tools/try-table). Проверяются семь вещей, каждая из
// которых ломает наивную версию:
//   а. место выбирается по правилам, а не «где стою»: лава в четырёх блоках и
//      песок под ногами — это отказ, и в мире после вызова реально стоят
//      сундук и факел (проверяется observe, а не только ответ демона);
//   б. mc_base без параметров отвечает координатами и НЕ двигает тело — ни на
//      блок, ни на полблока: мозг думает раз в 10-30 секунд, и «где мой дом»
//      не имеет права стоить ход;
//   в. «сложить лишнее» оставляет при боте снаряжение — включая случай
//      item='all', где раньше «all» разворачивался в список имён и клал в
//      сундук кирку, ведро и последний стейк;
//   г. забрать обратно, штучно и с бюджетом;
//   д. дорога домой по координатам из памяти с шестидесяти блоков (и отказ
//      идти за сорок восемь: это отдельный ход, а не молчаливая прогулка);
//   е. КОНТРОЛЬ: чужой сундук в пяти блоках от базы бот не трогает, пока свой
//      цел, — ни кладя, ни забирая, ни записывая его в память;
//   ж. запись живёт в memory/state.json и переживает перезапуск демона — это
//      проверяется тем, что прогон поднимает ВТОРОЙ Journal над тем же
//      каталогом и читает базу его глазами, кодом самого демона.
//
// ГРАБЛИ ИЗМЕРЕНИЯ (оплачены прошлыми заходами):
// * Шину событий дренит ЛЮБОЙ ответ демона, включая ответ на /give. Поэтому
//   события копятся здесь, на транспорте (`heard`), а не запрашиваются
//   отдельным status'ом — второй status подряд приходит пустым.
// * Автопилот кует инструмент из булыжника, как только видит, что оружия нет,
//   и жрёт при food<=16 (config.eatBelowFood). Поэтому меч и кирка выдаются в
//   КАЖДОЙ сцене, а перед каждым замером еды даётся saturation: иначе рутина
//   съест стейк и «еды оставлено 16» станет ложью не по вине общака.
// * Броня, НАДЕТАЯ на тело, уходит из bot.inventory.items(), а значит и из
//   status.state.inventory. Поэтому брони выдаётся по две штуки на слот:
//   лучшую бот наденет, худшая обязана остаться в рюкзаке — вот её и меряем.
// * Чанки. Утверждать «мир не прогружен» по факту отъезда нельзя: сервер
//   выгружает чанк, когда сочтёт нужным. Детерминированная форма того же
//   вопроса — координаты, которых заведомо нет ни в одном тикете (+5000).
// * Координаты в командах — через ПРОБЕЛ. `/setblock 1,2,3` молча не
//   выполняется.
// * /fill молча отказывается работать в непрогруженных чанках и молча
//   отказывается делать больше 32768 блоков, поэтому сначала /tp и пауза,
//   потом объёмы (самый большой здесь — 26250).
// * /clear @s — первым делом: в полный рюкзак /give роняет предмет на землю.
//
// Запуск: node dist/daemon/scenes/legacy/try-base.js   (демон уже поднят, бот в игре)
import WebSocket = require('ws')
import * as fs from 'fs'
import path = require('path')

const MEMORY_DIR = path.resolve(REPO_ROOT, 'memory')
const STATE_FILE = path.join(MEMORY_DIR, 'state.json')

// Код демона, поднятый здесь ЖЕ — но своим экземпляром. Journal над тем же
// каталогом — это и есть перезапуск демона без перезапуска демона, а readBase
// читает запись ровно так, как её прочитает живой процесс после рестарта.
import { Journal } from '../../src/journal'
import * as containers from '../../src/containers'

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

// Всё, что демон когда-либо сказал за прогон.
const heard = []
const mark = () => heard.length
const since = (n, type?: any) => heard.slice(n).filter(e => !type || e.type === type)

ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.ok && m.result && Array.isArray(m.result.events)) heard.push(...m.result.events)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

const sleep = ms => gameClock.sleep(ms)

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

async function step (label, method, params) {
  const r: any = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const problem = r.status === 'failed' ? ` ← ${r.error}` : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`${label.padEnd(28)} ${String(r.status).padEnd(11)} ${JSON.stringify(r.detail ?? null)}${problem}`)
  if (r.by) console.log(`${''.padEnd(28)} прервано: ${r.by.type}`)
  return r
}

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

const detail = r => (r && r.detail) || {} as Record<string, any>
// Упавший вызов роняет detail в {}, и тогда «away=undefined» — это не диагноз, а
// следствие, и читатель лога ищет причину в другом месте. Красная строка обязана
// называть статус и ошибку сама — оплачено игровым прогоном.
const why = r => (r && r.status === 'done' ? '' : ` [${r && r.status}${r && r.error ? ': ' + r.error : ''}]`)
const inv = async () => (((await call('status')) as any).state.inventory) || {} as Record<string, any>
const pos = async () => ((await call('status')) as any).state.pos
// Файла может ещё не быть: демон создаёт state.json первой же записью, а на
// свежей установке прогон обязан сказать это словами, а не упасть с ENOENT
// в первой строке (поймано на сухом прогоне сцены).
const onDisk = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} as Record<string, any> }
}
const diskBase = () => (onDisk().places || {} as Record<string, any>)['база'] || null
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z))
const liveChests = () => ((diskBase() || {} as Record<string, any>).chests || []).filter(c => !c.gone)
const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z

// Имена мест, которые были в памяти до прогона: общак не имеет права стереть
// «полигон» или «убежище».
let placesBefore = []

// Что реально стоит в мире вокруг тела. Контроль без предмета в мире ничего
// не доказывает: демон может отчитаться о сундуке, которого нет.
async function world (label, radius = 10) {
  const r = await call('observe', { radius, fair: false })
  const d = detail(r)
  const blocks = (d.blocks || []).map(b => `${b.name}×${b.count}@${b.nearest.x},${b.nearest.y},${b.nearest.z}`)
  console.log(`  мир (${label}): под ногами ${d.terrain && d.terrain.standingOn}, вокруг: ${blocks.join(' ') || 'пусто'}`)
  return d
}

// ---------------------------------------------------------------- арена

// Далеко от арен всех остальных прогонов (-26..-4, 120..180, 300..329,
// 400..429, 594..640, 686..783, 850..990) и от убежища на 1050,37,1140.
const X0 = 1300
const Z0 = 1300
const Y = 80 // пол на Y-1
// Плита 95x41, вытянутая на запад: 41 блок вширь хватает на выбор места
// радиусом 10, а 74 на запад — на дорогу домой с шестидесяти блоков, ради
// которой всё это и строится. Запас 4 блока не украшение: pickBaseSpot ищет в
// radius 10, поэтому база может встать на X0-10, а старт дороги — на X0-70, и
// стартовать пathfinder'у с самой кромки плиты незачем.
// Самый большой /fill здесь 26250 из 32768.
const XMIN = X0 - 74
const XMAX = X0 + 20
const ZMIN = Z0 - 20
const ZMAX = Z0 + 20
// Небо над центром вычищено на 41 блок вверх: openSky() смотрит на 40, и без
// этого «над базой открытое небо» меряло бы рельеф 1300,1300, а не код.
const SKY = 12

const LAVA = { x: X0 + 2, z: Z0 } // лужа в полу: база обязана уйти от неё на 5
const SAND = { x0: X0 - 4, x1: X0 - 2, z0: Z0 - 1, z1: Z0 + 1 }

// Один комплект на все сцены: меч и кирка не дают автопилоту вмешаться
// (toolPlan видит оружие и инструмент и не лезет ковать). Факелов здесь НЕТ
// намеренно: пока они лежали в BASIC, всякая выдача тихо добавляла 16 штук к
// заказанным, и «сдано 16 из 48» на деле мерило 64 — поймано сухим прогоном.
// Свет выдаётся поимённо там, где он нужен, и виден в списке выдачи.
const BASIC = ['minecraft:iron_pickaxe 1', 'minecraft:iron_sword 1']
const TORCHES = 'minecraft:torch 16'

async function give (gives) {
  await cmd('/clear @s')
  for (const g of gives) await cmd(`/give @s ${g}`)
  // Сытость под потолок: автопилот ест при food<=16 и тем ломает счёт еды.
  await cmd('/effect give @s minecraft:saturation 1 5 true')
  await sleep(1500) // инвентарь долетает до клиента отдельным пакетом
  return inv()
}

async function standAt (x, z, y = Y) {
  await cmd(`/tp @s ${x}.5 ${y} ${z}.5`)
  await sleep(2500)
}

async function buildArena () {
  console.log('=== арена ===')
  await call('stop')
  await sleep(800)
  await cmd('/clear @s') // забитый рюкзак роняет /give на землю
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/gamerule advance_weather false')
  await cmd('/gamerule fire_spread_radius_around_player 0')
  await cmd('/time set day')
  await cmd('/difficulty normal')

  // Эффекты ДО телепорта: /tp с высоты убивает, и лечить потом уже некого.
  await cmd('/effect give @s minecraft:slow_falling 60 0 true')
  await cmd('/effect give @s minecraft:fire_resistance 60 0 true')
  // Строим из середины плиты, а не из её края: /fill молчит в непрогруженных
  // чанках, а 91 блок вширь — это ±45 от тела, то есть три чанка в каждую
  // сторону при view-distance 10.
  await cmd(`/tp @s ${X0 - 27} ${Y + 2} ${Z0}`)
  await sleep(3500)

  await cmd(`/fill ${XMIN} ${Y - 4} ${ZMIN} ${XMAX} ${Y - 1} ${ZMAX} minecraft:stone`)
  await cmd(`/fill ${XMIN} ${Y} ${ZMIN} ${XMAX} ${Y + 5} ${ZMAX} minecraft:air`)
  await cmd(`/fill ${X0 - SKY} ${Y} ${Z0 - SKY} ${X0 + SKY} ${Y + 41} ${Z0 + SKY} minecraft:air`)
  // Лава утоплена в пол: соседи по горизонтали — камень, вверх она не течёт.
  await cmd(`/setblock ${LAVA.x} ${Y - 1} ${LAVA.z} minecraft:lava`)
  await cmd(`/fill ${SAND.x0} ${Y - 1} ${SAND.z0} ${SAND.x1} ${Y - 1} ${SAND.z1} minecraft:sand`)
  await cmd('/kill @e[type=!player,distance=..96]')

  await standAt(X0, Z0)
  // Своя точка возрождения. Чужая уже ломала прогон: try-diamond возродился в
  // арене try-surface, и двадцать строк лога мерили замену тела.
  await cmd(`/spawnpoint @s ${X0} ${Y} ${Z0}`)
  await cmd('/effect give @s minecraft:instant_health 1 10 true')
  await sleep(800)

  const st: any = await call('status')
  const p = st.state.pos
  check('стартую там, где думаю', cheb(p, { x: X0, z: Z0 }) <= 1 && Math.abs(p.y - Y) <= 1, JSON.stringify(p))
  check('стартую на полном здоровье', st.state.health === 20, `hp=${st.state.health}`)

  // Арена проверяется в мире, а не по отсутствию ошибки от /fill.
  const centre = await world('центр', 12)
  check('пол под ногами — камень', centre.terrain && centre.terrain.standingOn === 'stone',
    JSON.stringify(centre.terrain))
  const lava = (centre.blocks || []).find(b => b.name === 'lava')
  check('лава в полу там, где положили', !!lava && lava.nearest.x === LAVA.x && lava.nearest.z === LAVA.z,
    JSON.stringify(lava && lava.nearest))

  await standAt(X0 - 3, Z0)
  const sandy = await world('песок')
  check('песок в полу там, где положили', sandy.terrain && sandy.terrain.standingOn === 'sand',
    JSON.stringify(sandy.terrain))

  await standAt(XMIN + 10, Z0)
  const west = await world('западный край')
  check('дальний конец плиты есть, по нему можно идти домой',
    west.terrain && west.terrain.standingOn === 'stone' && Math.abs(west.terrain.y - Y) <= 1,
    JSON.stringify(west.terrain))

  await standAt(X0, Z0)
  console.log(`  точка возрождения этого прогона: ${X0} ${Y} ${Z0}`)
}

// ---------------------------------------------------------------- а

async function sceneSet () {
  console.log('\n=== а. назначить базу здесь ===')
  const bag = await give([...BASIC, TORCHES, 'minecraft:chest 1', 'minecraft:crafting_table 1'])
  console.log('  выдано:', JSON.stringify(bag))
  await standAt(X0, Z0)

  const t0 = mark()
  const r: any = await step('поставить базу', 'base', { mode: 'set', radius: 10 })
  const d = detail(r)
  check('база поставлена', r.status === 'done' && !!d.at, JSON.stringify(d.at || d))
  if (!d.at) return null

  check('ушёл от лавы дальше 4 блоков', cheb(d.at, LAVA) >= 5, `chebyshev=${cheb(d.at, LAVA)} до ${LAVA.x},${LAVA.z}`)
  const onSand = d.at.x >= SAND.x0 && d.at.x <= SAND.x1 && d.at.z >= SAND.z0 && d.at.z <= SAND.z1
  check('не встал на песок', !onSand, JSON.stringify(d.at))
  check('и не ушёл дальше запрошенных 10 блоков', cheb(d.at, { x: X0, z: Z0 }) <= 10, JSON.stringify(d.at))
  check('над базой открытое небо', d.sky === true, `sky=${d.sky}`)
  check('решение объяснено словами', typeof d.why === 'string' && /открытое небо/.test(d.why), d.why)
  check('сундук на базе есть', Array.isArray(d.chests) && d.chests.length >= 1, JSON.stringify(d.chests))
  if (d.chests && d.chests[0]) {
    check('сундук стоит вплотную к базе', cheb(d.chests[0].at, d.at) <= 1, JSON.stringify(d.chests[0].at))
  }
  check('база помечена факелом', d.torch === true, `torch=${d.torch}`)
  console.log('  сказано:', JSON.stringify(since(t0).map(e => e.type)))

  // Ответ демона — это ещё не постройка. Смотрим в мир.
  const seen = await world('база', 8)
  const chestSeen = (seen.blocks || []).find(b => b.name === 'chest')
  const torchSeen = (seen.blocks || []).find(b => /torch/.test(b.name))
  check('сундук ЕСТЬ В МИРЕ на записанных координатах',
    !!chestSeen && !!d.chests[0] && same(chestSeen.nearest, d.chests[0].at),
    JSON.stringify({ мир: chestSeen && chestSeen.nearest, память: d.chests[0] && d.chests[0].at }))
  check('факел ЕСТЬ В МИРЕ рядом с базой',
    !!torchSeen && cheb(torchSeen.nearest, d.at) <= 1, JSON.stringify(torchSeen && torchSeen.nearest))

  // Второй set — это не ошибка и не тихий переезд: базу нельзя потерять из-за
  // лишнего вызова из шахты.
  const again = await step('поставить ещё раз', 'base', { mode: 'set' })
  const a = detail(again)
  check('вторая постановка отказывается переносить', a.already === true, JSON.stringify(a))
  check('и называет, где база и как вернуться',
    typeof a.note === 'string' && /base mode=go/.test(a.note) && a.note.includes(String(d.at.x)), a.note)

  return d.at
}

// ---------------------------------------------------------------- ж

function sceneMemory (at) {
  console.log('\n=== ж. запись переживает перезапуск демона ===')
  const disk = onDisk()
  const rec = (disk.places || {} as Record<string, any>)['база']
  check('в файле на диске есть places.база', !!rec, JSON.stringify(Object.keys(disk.places || {} as Record<string, any>)))
  if (!rec) return
  check('координаты в файле те же', same(rec, at), JSON.stringify({ x: rec.x, y: rec.y, z: rec.z }))
  check('формат places не сломан (x,y,z,note)',
    typeof rec.note === 'string' && Number.isFinite(rec.x), JSON.stringify({ note: rec.note }))
  check('в файле лежит и общак', Array.isArray(rec.chests) && rec.chests.length >= 1, JSON.stringify(rec.chests))
  const c = (rec.chests || [])[0] || {} as Record<string, any>
  check('у сундука записано содержимое и время', !!c.contents && !!Date.parse(c.seenAt || ''), JSON.stringify(c))
  const lost = placesBefore.filter(n => !(disk.places || {} as Record<string, any>)[n])
  check('чужие места в памяти не тронуты', lost.length === 0, `пропали: ${lost.join(', ')}`)

  // Вот это и есть «переживает перезапуск»: второй Journal над тем же
  // каталогом — ровно то, что сделает демон, когда его поднимут заново, и
  // читает его тот же readBase, которым пользуются base/stash.
  const restarted = { journal: new Journal(MEMORY_DIR) }
  const read = containers.readBase(restarted, containers.BASE_PLACE)
  check('свежий Journal читает базу с диска', !!read && same(read, at),
    JSON.stringify(read && { x: read.x, y: read.y, z: read.z }))
  check('и общак вместе с ней', !!read && read.chests.length >= 1 && !!read.chests[0].contents,
    JSON.stringify(read && read.chests.map(k => [k.x, k.y, k.z])))
}

// ---------------------------------------------------------------- б

async function sceneWhere (at) {
  console.log('\n=== б. mc_base без параметров: отвечает и не двигает тело ===')
  // Тридцать блоков, а не десять: база выбирается в radius 10 от X0,Z0, и с
  // близкой точки «сказал, сколько идти» могло бы провалиться не по вине кода.
  await standAt(X0 - 30, Z0)
  const before = await pos()

  const t0 = gameClock.now()
  // Без единого параметра — ровно так, как это вызовет мозг.
  const r: any = await call('base', {} as Record<string, any>)
  const ms = gameClock.now() - t0
  const d = detail(r)
  console.log(`  base{}                       ${r.status} ${JSON.stringify(d)}`)

  check('ответил координатами базы', r.status === 'done' && !!d.base && same(d.base, at), JSON.stringify(d.base))
  check('и сказал, сколько идти', typeof d.away === 'number' && d.away > 4, `away=${d.away}`)
  check('и что лежит в общаке', !!d.stash && typeof d.stash === 'object', JSON.stringify(d.stash))
  // Заголовок состояния снят демоном в том же ответе — это самый тесный замер,
  // какой вообще возможен: между «до» и «после» нет ни одного чужого пакета.
  check('тело не сдвинулось НИ НА БЛОК',
    !!r.state && r.state.pos.x === before.x && r.state.pos.y === before.y && r.state.pos.z === before.z,
    `было ${JSON.stringify(before)}, стало ${JSON.stringify(r.state && r.state.pos)}`)
  check('и это не стоило хода', ms < 1500, `${ms}мс`)

  await sleep(1200)
  const after = await pos()
  check('и через секунду тело всё там же', same(after, before), JSON.stringify(after))

  // stash без параметров — та же гарантия с другой стороны.
  const s: any = await call('stash', {} as Record<string, any>)
  const sd = detail(s)
  check('stash без параметров тоже отвечает из памяти', s.status === 'done' && !!sd.stash, JSON.stringify(sd.stash))
  check('и тоже не двигает тело',
    !!s.state && same(s.state.pos, before), JSON.stringify(s.state && s.state.pos))
}

// ---------------------------------------------------------------- е (постановка)

// Чужой сундук: не наш, стоит в пяти блоках от центра базы — то есть ВНУТРИ
// радиуса, в котором liveShelves() усыновляет чужую тару, когда своей не
// осталось. Пока своя цела, трогать его нельзя ничем.
async function putNeighbour (at) {
  console.log('\n=== е (постановка). чужой сундук в пяти блоках ===')
  const n = { x: at.x, y: at.y, z: at.z + 5 }
  await standAt(at.x, at.z)
  await cmd(`/setblock ${n.x} ${n.y} ${n.z} minecraft:chest`)
  await cmd(`/item replace block ${n.x} ${n.y} ${n.z} container.0 with minecraft:emerald 7`)
  await sleep(800)

  const r: any = await step('заглянуть в чужой', 'chest_list', n)
  const d = detail(r)
  check('чужой сундук поставлен и открывается', r.status === 'done' && !!d.contents, JSON.stringify(d))
  check('в нём метка — 7 изумрудов', (d.contents || {} as Record<string, any>).emerald === 7, JSON.stringify(d.contents))
  check('и он НЕ записан как сундук базы', d.base === undefined, `base=${d.base}`)
  const mine = liveChests()
  check('в памяти базы его координат нет', !mine.some(c => same(c, n)),
    JSON.stringify(mine.map(c => [c.x, c.y, c.z])))
  return { at: n, baseline: d.contents || {} as Record<string, any> }
}

// ---------------------------------------------------------------- в

async function sceneStore (at) {
  console.log('\n=== в. сложить добычу: снаряжение остаётся при боте ===')
  const bag = await give([
    ...BASIC,
    // Броня по две на слот: лучшую бот наденет (и она уйдёт из инвентаря),
    // худшая обязана остаться в рюкзаке — вот её и меряем.
    'minecraft:iron_chestplate 1', 'minecraft:leather_chestplate 1',
    'minecraft:chainmail_helmet 1', 'minecraft:leather_helmet 1',
    // Пустое ведро — это НЕ water_bucket: /_bucket$/ его не ловило.
    'minecraft:bucket 1', 'minecraft:water_bucket 1',
    'minecraft:red_bed 2',
    'minecraft:cooked_beef 40', 'minecraft:torch 48', 'minecraft:cobblestone 200',
    'minecraft:oak_planks 40', 'minecraft:crafting_table 1',
    'minecraft:raw_iron 33', 'minecraft:diamond 5', 'minecraft:gold_ingot 12'
  ])
  console.log('  выдано:', JSON.stringify(bag))
  const dressed = await step('надеть броню', 'armor', {} as Record<string, any>)
  console.log('  надето:', JSON.stringify(detail(dressed).worn))
  await standAt(at.x, at.z)

  const r: any = await step('сложить лишнее', 'stash', { mode: 'put' })
  const d = detail(r)
  const put = d.put || {} as Record<string, any>
  check('вызов прошёл', r.status === 'done', r.error || '')
  check('руда ушла целиком', put.raw_iron === 33, JSON.stringify(put.raw_iron))
  check('алмазы ушли целиком', put.diamond === 5, JSON.stringify(put.diamond))
  check('слитки ушли целиком', put.gold_ingot === 12, JSON.stringify(put.gold_ingot))
  check('еды сдано 24 из 40', put.cooked_beef === 24, JSON.stringify(put.cooked_beef))
  check('факелов сдано 16 из 48', put.torch === 16, JSON.stringify(put.torch))
  check('булыжника сдано 136 из 200', put.cobblestone === 136, JSON.stringify(put.cobblestone))
  check('досок сдано 24 из 40', put.oak_planks === 24, JSON.stringify(put.oak_planks))
  check('вторая кровать сдана, первая нет', put.red_bed === 1, JSON.stringify(put.red_bed))
  const gear = Object.keys(put).filter(n => /_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots)$/.test(n) || /bucket/.test(n))
  check('снаряжения в сундуке нет ни одного вида', gear.length === 0, JSON.stringify(gear))

  const bag2 = await inv()
  console.log('  рюкзак после сдачи:', JSON.stringify(bag2))
  check('кирка осталась при мне', bag2.iron_pickaxe === 1, `iron_pickaxe=${bag2.iron_pickaxe}`)
  check('меч остался при мне', bag2.iron_sword === 1, `iron_sword=${bag2.iron_sword}`)
  check('ПУСТОЕ ведро осталось при мне', bag2.bucket === 1, `bucket=${bag2.bucket}`)
  check('ведро с водой осталось при мне', bag2.water_bucket === 1, `water_bucket=${bag2.water_bucket}`)
  // Одна из пары надета (её в inventory нет), вторая обязана лежать в рюкзаке.
  check('запасная кираса осталась при мне',
    (bag2.leather_chestplate || 0) + (bag2.iron_chestplate || 0) === 1,
    JSON.stringify({ leather: bag2.leather_chestplate, iron: bag2.iron_chestplate }))
  check('запасной шлем остался при мне',
    (bag2.leather_helmet || 0) + (bag2.chainmail_helmet || 0) === 1,
    JSON.stringify({ leather: bag2.leather_helmet, chain: bag2.chainmail_helmet }))
  check('кровать осталась одна', bag2.red_bed === 1, `red_bed=${bag2.red_bed}`)
  check('еды оставлено 16', bag2.cooked_beef === 16, `cooked_beef=${bag2.cooked_beef}`)
  check('факелов оставлено 32', bag2.torch === 32, `torch=${bag2.torch}`)
  check('булыжника оставлено 64', bag2.cobblestone === 64, `cobblestone=${bag2.cobblestone}`)
  check('досок оставлено 16', bag2.oak_planks === 16, `oak_planks=${bag2.oak_planks}`)
  check('верстак остался при мне', bag2.crafting_table === 1, `crafting_table=${bag2.crafting_table}`)
  check('добычи при мне не осталось', !bag2.raw_iron && !bag2.diamond && !bag2.gold_ingot, JSON.stringify(bag2))
  check('ответ называет, что оставил и почему',
    typeof d.note === 'string' && /при мне оставил нужное/.test(d.note), d.note)
  check('и отдаёт это полем kept', !!d.kept && d.kept.iron_pickaxe === 1, JSON.stringify(d.kept))

  // ГЛАВНЫЙ СЛУЧАЙ: «all» раньше разворачивалось в список имён и обходило
  // резервы целиком — кирка, ведро и последний стейк уезжали в сундук.
  console.log('\n  --- то же самое, но словом «all» ---')
  const bag3 = await give([...BASIC, 'minecraft:bucket 1', 'minecraft:cooked_beef 20',
    'minecraft:torch 40', 'minecraft:redstone 9', 'minecraft:cobblestone 100'])
  console.log('  выдано:', JSON.stringify(bag3))
  await standAt(at.x, at.z)
  const all = await step('сложить «all»', 'stash', { mode: 'put', item: 'all' })
  const ad = detail(all)
  const ap = ad.put || {} as Record<string, any>
  check('«all» не кладёт кирку', !ap.iron_pickaxe, JSON.stringify(ap.iron_pickaxe))
  check('«all» не кладёт меч', !ap.iron_sword, JSON.stringify(ap.iron_sword))
  check('«all» не кладёт ведро', !ap.bucket, JSON.stringify(ap.bucket))
  check('«all» оставляет 16 еды', ap.cooked_beef === 4, JSON.stringify(ap.cooked_beef))
  check('«all» оставляет 32 факела', ap.torch === 8, JSON.stringify(ap.torch))
  check('«all» сдаёт добычу целиком', ap.redstone === 9, JSON.stringify(ap.redstone))
  check('«all» оставляет 64 булыжника', ap.cobblestone === 36, JSON.stringify(ap.cobblestone))
  const bag4 = await inv()
  check('после «all» снаряжение всё ещё при боте',
    bag4.iron_pickaxe === 1 && bag4.iron_sword === 1 && bag4.bucket === 1 &&
    bag4.cooked_beef === 16 && bag4.torch === 32, JSON.stringify(bag4))

  // Явный список — это мозг, который снимает резерв осознанно.
  const forced = await step('отдать весь булыжник', 'stash', { mode: 'put', item: 'cobblestone' })
  check('явное имя перебивает резерв: уехали все 64',
    (detail(forced).put || {} as Record<string, any>).cobblestone === 64, JSON.stringify(detail(forced).put))
  check('и kept при явном списке не выдумывается', detail(forced).kept === undefined,
    JSON.stringify(detail(forced).kept))
  const bag5 = await inv()
  check('булыжника при мне не осталось', !bag5.cobblestone, `cobblestone=${bag5.cobblestone}`)
}

// ---------------------------------------------------------------- е (проверка)

async function sceneNeighbour (at, neighbour) {
  console.log('\n=== е. КОНТРОЛЬ: чужой сундук не тронут ===')
  await standAt(at.x, at.z)
  const r = await step('заглянуть в чужой снова', 'chest_list', neighbour.at)
  const now = detail(r).contents || {} as Record<string, any>
  const beforeKeys = Object.keys(neighbour.baseline).sort()
  const nowKeys = Object.keys(now).sort()
  check('в чужом сундуке ровно то же, что было',
    JSON.stringify(beforeKeys.map(k => [k, neighbour.baseline[k]])) === JSON.stringify(nowKeys.map(k => [k, now[k]])),
    `было ${JSON.stringify(neighbour.baseline)}, стало ${JSON.stringify(now)}`)
  check('и ничего чужого туда не положено', !now.raw_iron && !now.cobblestone && !now.gold_ingot,
    JSON.stringify(now))

  const mine = liveChests()
  check('в памяти базы его так и нет', !mine.some(c => same(c, neighbour.at)),
    JSON.stringify(mine.map(c => [c.x, c.y, c.z])))

  const totals = detail(await call('stash', {} as Record<string, any>)).stash || {} as Record<string, any>
  check('изумруды не попали в счёт общака', !totals.emerald, JSON.stringify(totals))

  const raid: any = await step('забрать изумруды из общака', 'stash', { mode: 'take', item: 'emerald' })
  const rd = detail(raid)
  check('«в общаке нет» — это ответ, а не набег на соседа',
    raid.status === 'done' && /в общаке нет/.test(rd.note || '') && !Object.keys(rd.took || {} as Record<string, any>).length,
    JSON.stringify({ note: rd.note, took: rd.took }))
  const bag = await inv()
  check('и изумрудов в рюкзаке не появилось', !bag.emerald, `emerald=${bag.emerald}`)
}

// ---------------------------------------------------------------- г

async function sceneTake (at) {
  console.log('\n=== г. забрать из общака ===')
  const bag0 = await give([...BASIC, TORCHES])
  console.log('  выдано:', JSON.stringify(bag0))
  await standAt(at.x, at.z)

  const r = await step('забрать алмазы', 'stash', { mode: 'take', item: 'diamond' })
  const d = detail(r)
  check('алмазы вернулись', (d.took || {} as Record<string, any>).diamond === 5, JSON.stringify(d.took))
  const bag = await inv()
  check('и лежат в рюкзаке', bag.diamond === 5, `diamond=${bag.diamond}`)
  check('в общаке их больше нет', !(d.stash || {} as Record<string, any>).diamond, JSON.stringify(d.stash))

  const some = await step('забрать 10 руды', 'stash', { mode: 'take', item: 'raw_iron', count: 10 })
  const sd = detail(some)
  check('взято ровно 10', (sd.took || {} as Record<string, any>).raw_iron === 10, JSON.stringify(sd.took))
  check('остальное осталось в общаке', (sd.stash || {} as Record<string, any>).raw_iron === 23, JSON.stringify((sd.stash || {} as Record<string, any>).raw_iron))
  const bag2 = await inv()
  check('и десять руды в рюкзаке', bag2.raw_iron === 10, `raw_iron=${bag2.raw_iron}`)
}

// ---------------------------------------------------------------- д

async function sceneGoHome (at) {
  console.log('\n=== д. дорога домой с шестидесяти блоков ===')
  await standAt(at.x - 60, at.z)
  await cmd('/effect give @s minecraft:instant_health 1 10 true')
  await cmd('/effect give @s minecraft:saturation 1 5 true')
  await sleep(800)
  const start = await pos()
  const away0 = Math.round(Math.hypot(start.x - at.x, start.z - at.z))
  check('стою ровно в шестидесяти блоках от базы', away0 >= 58 && away0 <= 62, `${away0} блоков, ${JSON.stringify(start)}`)
  const hp = ((await call('status')) as any).state.health
  check('и живой', hp === 20, `hp=${hp}`)

  // Отсюда класть — это не «не вышло», а «это отдельная дорога».
  const far = await step('сложить с 60 блоков', 'stash', { mode: 'put', item: 'torch' })
  const fd = detail(far)
  check('дальний put не идёт молча', fd.went === false, JSON.stringify(fd))
  check('и называет расстояние и следующий ход',
    typeof fd.note === 'string' && /base mode=go/.test(fd.note) && /\d+ блоков/.test(fd.note), fd.note)
  check('и всё равно говорит, где база', !!fd.at && same(fd.at, at), JSON.stringify(fd.at))

  const r = await step('домой', 'base', { mode: 'go', timeoutSeconds: 120 })
  const d = detail(r)
  check('дошёл до базы', d.arrived === true, `away=${d.away}, ${d.note}${why(r)}`)
  check('пришёл именно на записанные координаты', typeof d.away === 'number' && d.away <= 6, `away=${d.away}`)
  check('сундуки на месте пересчитаны', !d.lost && Array.isArray(d.chests) && d.chests.length >= 1,
    JSON.stringify(d.chests))
  check('общак приехал вместе с дорогой', (d.stash || {} as Record<string, any>).raw_iron === 23, JSON.stringify(d.stash))
  const p = await pos()
  check('тело действительно у базы', cheb(p, at) <= 6, JSON.stringify(p))
}

// ---------------------------------------------------------------- сломанный

async function sceneBroken (at, neighbour) {
  console.log('\n=== доп. сундук сломали ===')
  // Соседа убираем: пока он стоит, liveShelves() имеет право усыновить его
  // вместо постройки нового — а мерить мы хотим именно постройку.
  await standAt(at.x, at.z)
  await cmd(`/setblock ${neighbour.at.x} ${neighbour.at.y} ${neighbour.at.z} minecraft:air`)
  await cmd('/kill @e[type=item,distance=..24]')
  await sleep(800)

  const alive = liveChests()
  check('перед сломом свой сундук в памяти есть', alive.length >= 1, JSON.stringify(alive.map(c => [c.x, c.y, c.z])))
  if (!alive.length) return
  const victim = alive[0]

  // 16 досок и стол: 8 уходит на сундук, и на верстак из тех же восьми уже
  // не осталось бы — отказ был бы про верстак, а мерим мы сундук.
  await give([...BASIC, TORCHES, 'minecraft:oak_planks 16', 'minecraft:crafting_table 1'])
  await standAt(at.x, at.z)
  await cmd(`/setblock ${victim.x} ${victim.y} ${victim.z} minecraft:air`)
  await cmd('/kill @e[type=item,distance=..24]')
  await sleep(1200)
  const gone = await world('после слома', 8)
  check('сундука в мире действительно нет',
    !(gone.blocks || []).some(b => b.name === 'chest'), JSON.stringify((gone.blocks || []).map(b => b.name)))

  await standAt(at.x - 12, at.z - 8)
  const r = await step('домой к сломанному', 'base', { mode: 'go' })
  const d = detail(r)
  check('дошёл', d.arrived === true, `away=${d.away}${why(r)}`)
  check('пропажа замечена', Array.isArray(d.lost) && d.lost.length === 1, JSON.stringify(d.lost))
  check('сказано «сломан», а не «не прогружено»',
    typeof d.note === 'string' && /сломан/.test(d.note) && !/непрогруж/.test(d.note), d.note)
  check('названы координаты и что там теперь',
    Array.isArray(d.lost) && d.lost[0] && d.lost[0].instead === 'air' && d.lost[0].x === victim.x,
    JSON.stringify(d.lost))

  const marked = ((diskBase() || {} as Record<string, any>).chests || []).find(c => same(c, victim))
  check('в памяти сундук помечен сломанным', !!marked && marked.gone === true, JSON.stringify(marked))

  // Общак без сундука — это не тупик: доски есть, значит сундук будет.
  const put = await step('сложить в пустую базу', 'stash', { mode: 'put', item: 'torch', count: 8 })
  const p = detail(put)
  check('поставил новый сундук сам', Array.isArray(p.chests) && p.chests.some(c => c.fresh),
    JSON.stringify(p.chests) + why(put))
  check('и положил в него', (p.put || {} as Record<string, any>).torch === 8, JSON.stringify(p.put))
  // Просили восемь из шестнадцати — значит, оставшиеся восемь это НЕ «не влезло»,
  // а ровно то, о чём просили. Раньше остаток бюджета читался как нехватка места,
  // и бот строил второй сундук, который так и оставался пустым на 27 слотов.
  check('и только ОДИН сундук, без лишнего пустого',
    Array.isArray(p.chests) && p.chests.filter(c => c.fresh).length === 1, JSON.stringify(p.chests))
  check('и остаток не выдуман: просили 8, положили 8',
    p.leftOnMe === undefined && !/не влезло/.test(p.note || ''),
    JSON.stringify({ leftOnMe: p.leftOnMe, note: p.note }))
  const fresh = ((diskBase() || {} as Record<string, any>).chests || []).filter(c => !c.gone)
  check('новый сундук записан в память',
    fresh.some(c => c.contents && c.contents.torch === 8),
    JSON.stringify(fresh.map(c => ({ at: [c.x, c.y, c.z], has: c.contents }))))
  const seen = await world('новый сундук', 8)
  check('и он ЕСТЬ В МИРЕ', (seen.blocks || []).some(b => b.name === 'chest'),
    JSON.stringify((seen.blocks || []).map(b => b.name)))
  return fresh
}

// ---------------------------------------------------------------- переполнение

// Шестьдесят четыре вида мусора, и ни у одного нет резерва в KEEP — значит
// каждый уезжает в сундук целиком и счёт слотов честный.
const JUNK = [
  'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool', 'lime_wool',
  'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool', 'purple_wool', 'blue_wool',
  'brown_wool', 'green_wool', 'red_wool', 'black_wool',
  'white_dye', 'orange_dye', 'magenta_dye', 'light_blue_dye', 'yellow_dye', 'lime_dye',
  'pink_dye', 'gray_dye', 'light_gray_dye', 'cyan_dye', 'purple_dye', 'blue_dye',
  'brown_dye', 'green_dye', 'red_dye', 'black_dye',
  'paper', 'book', 'feather', 'string', 'leather', 'brick',
  'flint', 'bone', 'gunpowder', 'rotten_flesh', 'spider_eye', 'ink_sac', 'glow_ink_sac',
  'glowstone_dust', 'sugar', 'wheat_seeds', 'pumpkin_seeds', 'melon_seeds', 'beetroot_seeds',
  'clay_ball', 'bowl', 'egg', 'snowball', 'slime_ball', 'phantom_membrane', 'rabbit_hide',
  'rabbit_foot', 'prismarine_shard', 'prismarine_crystals', 'amethyst_shard', 'iron_nugget',
  'gold_nugget'
]

// Вид выдаётся РОВНО ОДИН раз за прогон. Выданный второй раз, он доложится в
// уже лежащую в сундуке неполную стопку — и «полка полная» перестанет быть
// правдой не по вине кода.
let junkAt = 0
const nextJunk = () => (junkAt < JUNK.length ? JUNK[junkAt++] : null)

// Забить ВСЕ живые полки под ноль, сколько бы их ни было. Раньше сцена
// набивала «двадцать шесть видов в одну полку» по числу, взятому из головы, —
// а в игре полок оказалось две, и отказ, которого сцена ждала, перестал
// воспроизводиться. Считаем по факту: спрашиваем free и добиваем.
// Один свежий вид за заход, стопками по 64: одна выдача закрывает до тридцати
// слотов (1920 штук — это 30 слотов рюкзака из тридцати шести). Досок и брёвен
// в выдаче нет, поэтому общак вырасти не может и набивка сходится.
async function fillShelves (at, label) {
  for (let round = 1; round <= 5; round++) {
    const shelves = liveChests()
    const free = shelves.reduce((n, c) => n + (c.free || 0), 0)
    console.log(`  ${label} ${round}: полок ${shelves.length}, свободно ${free} слотов — ` +
      JSON.stringify(shelves.map(c => ({ at: [c.x, c.y, c.z], free: c.free }))))
    if (!shelves.length) return { ok: false, note: 'полок нет вовсе', shelves }
    if (free === 0) return { ok: true, shelves }
    const kind = nextJunk()
    if (!kind) return { ok: false, note: `кончился мусор, осталось ${free} свободных слотов`, shelves }
    await give([...BASIC, `minecraft:${kind} ${Math.min(free, 30) * 64}`])
    await standAt(at.x, at.z)
    await step(`${label} ${round}`, 'stash', { mode: 'put' })
  }
  return { ok: false, note: 'за пять заходов полки не забились', shelves: liveChests() }
}

// Два разных обещания, а не одно. Раньше сцена умела требовать только отказа,
// и когда бот научился строить, она покраснела на ПРАВИЛЬНОМ поведении.
// С материалом бот ОБЯЗАН вырастить общак; без материала — отказать числами.
async function sceneOverflow (at) {
  console.log('\n=== доп. полка кончилась ===')
  const full = await fillShelves(at, 'набивка')
  check('все полки забиты под ноль', full.ok,
    full.note || JSON.stringify(full.shelves.map(c => ({ at: [c.x, c.y, c.z], free: c.free }))))
  if (!full.ok) return
  const before = full.shelves.length

  console.log('\n  --- полка кончилась, но доски есть: общак обязан вырасти ---')
  const grew = nextJunk()
  await give([...BASIC, 'minecraft:oak_planks 8', 'minecraft:crafting_table 1', `minecraft:${grew} 8`])
  await standAt(at.x, at.z)
  const grow = await step('полка полна, доски есть', 'stash', { mode: 'put' })
  const g = detail(grow)
  check('общак вырос сам', Array.isArray(g.chests) && g.chests.some(c => c.fresh),
    JSON.stringify(g.chests) + why(grow))
  check('и добыча уехала в новую полку', (g.put || {} as Record<string, any>)[grew] === 8, JSON.stringify(g.put))
  const after = liveChests()
  check('и полок в памяти стало больше', after.length === before + 1,
    JSON.stringify(after.map(c => [c.x, c.y, c.z])))
  const seen = await world('после роста', 8)
  const inWorld = (seen.blocks || []).find(b => b.name === 'chest')
  check('новая полка ЕСТЬ В МИРЕ', !!inWorld && inWorld.count >= before + 1,
    JSON.stringify((seen.blocks || []).map(b => `${b.name}×${b.count}`)))

  console.log('\n  --- полки кончились, и строить не из чего ---')
  const full2 = await fillShelves(at, 'добивка')
  check('и новая полка забита под ноль', full2.ok, full2.note || 'все полки полны')
  if (!full2.ok) return

  const rest = [nextJunk(), nextJunk(), nextJunk()].filter(Boolean)
  await give([...BASIC, ...rest.map(n => `minecraft:${n} 4`)])
  await standAt(at.x, at.z)
  // Предусловие важнее самой проверки: «строить не из чего» имеет смысл ровно
  // тогда, когда строить действительно не из чего. Если материал в рюкзаке
  // есть, бот ОБЯЗАН построить, и красная строка ниже была бы претензией к
  // правильному поведению — ровно это и случилось в прошлом прогоне.
  const bag0 = await inv()
  const material = Object.keys(bag0).filter(n => /_planks$|_log$|_stem$|^chest$/.test(n))
  check('ПРЕДУСЛОВИЕ: строить действительно не из чего', material.length === 0, JSON.stringify(bag0))

  const over: any = await step('сложить в полный', 'stash', { mode: 'put' })
  const d = detail(over)
  check('вызов не упал', over.status === 'done', over.error || '')
  check('остаток назван поимённо и числом',
    !!d.leftOnMe && Object.keys(d.leftOnMe).length > 0, JSON.stringify(d.leftOnMe) + why(over))
  // Обе формы отказа честные: либо нет материала, либо вокруг базы кончились
  // клетки под ещё один сундук. Важно, что причина названа, а не «не вышло».
  check('сказано, почему нового сундука не будет',
    typeof d.note === 'string' && /не влезло/.test(d.note) && /досок|некуда/.test(d.note), d.note)
  const bag = await inv()
  const stillMine = Object.keys(d.leftOnMe || {} as Record<string, any>).every(n => (bag[n] || 0) > 0)
  check('несданное осталось в рюкзаке, а не на земле', stillMine, JSON.stringify(bag))
}

// ---------------------------------------------------------------- пустота

async function sceneNowhere (at) {
  console.log('\n=== доп. база в непрогруженном чанке ===')
  // Детерминированная форма «мира вокруг координат нет»: чанк, который не
  // держит ни один тикет. По факту отъезда это утверждать нельзя — сервер
  // выгружает чанки когда захочет, и проверка врала бы через раз.
  const r: any = await step('база в пустоте', 'base',
    { mode: 'set', x: X0 + 5000, y: Y, z: Z0 + 5000, move: true })
  check('в непрогруженный чанк базу не ставим',
    r.status === 'failed' && /не прогружен/.test(r.error || ''), r.error)
  // И самое важное: отказ не должен был стереть настоящую базу по дороге.
  const still = diskBase()
  check('настоящая база от этого не пострадала', !!still && same(still, at),
    JSON.stringify(still && { x: still.x, y: still.y, z: still.z }))
  check('и общак на месте', !!still && (still.chests || []).some(c => !c.gone),
    JSON.stringify((still || {} as Record<string, any>).chests))
}

// ---------------------------------------------------------------- уборка

async function cleanUp (before) {
  console.log('\n=== уборка ===')
  const forget = await step('забыть базу', 'base', { mode: 'forget' })
  check('запись убрана', detail(forget).forgot === 'база' && !diskBase(),
    JSON.stringify(Object.keys(onDisk().places || {} as Record<string, any>)))
  const lost = placesBefore.filter(n => !(onDisk().places || {} as Record<string, any>)[n])
  check('чужие места пережили уборку', lost.length === 0, `пропали: ${lost.join(', ')}`)
  if (before) {
    console.log('  ВНИМАНИЕ: до прогона в памяти была база, восстанови её вручную:')
    console.log('  ' + JSON.stringify(before))
  }

  // Сносим стоя внутри: /kill @e и /fill видят только прогруженные чанки.
  await cmd('/effect give @s minecraft:slow_falling 120 0 true')
  await cmd('/effect give @s minecraft:fire_resistance 120 0 true')
  await cmd('/effect give @s minecraft:resistance 120 4 true')
  await standAt(X0 - 27, Z0, Y + 3)
  await cmd('/kill @e[type=!player,distance=..96]')
  await cmd(`/fill ${XMIN} ${Y - 4} ${ZMIN} ${XMAX} ${Y + 1} ${ZMAX} minecraft:air`)
  await cmd(`/fill ${XMIN} ${Y + 2} ${ZMIN} ${XMAX} ${Y + 5} ${ZMAX} minecraft:air`)
  await cmd(`/fill ${X0 - SKY} ${Y + 6} ${Z0 - SKY} ${X0 + SKY} ${Y + 41} ${Z0 + SKY} minecraft:air`)
  // Один блок под ноги: без него тело падает сквозь снесённую плиту на
  // незнакомый рельеф, и следующий прогон начинается с «где я».
  await cmd(`/setblock ${X0} ${Y - 1} ${Z0} minecraft:stone`)
  await cmd(`/tp @s ${X0}.5 ${Y} ${Z0}.5`)
  await sleep(1500)
  await cmd('/kill @e[type=!player,distance=..96]')
  await cmd('/clear @s')
  console.log(`  арена ${XMIN}..${XMAX} / ${ZMIN}..${ZMAX} снесена`)
  console.log(`  оставлен один блок камня на ${X0} ${Y - 1} ${Z0} — под ногами тела`)
  console.log(`  точка возрождения осталась на ${X0} ${Y} ${Z0} — следующий прогон обязан поставить свою`)
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  let before = null
  try {
    await call('connect')
    placesBefore = Object.keys(onDisk().places || {} as Record<string, any>).filter(n => n !== 'база')
    before = diskBase()
    if (before) {
      console.log('в памяти уже есть база, прогон её сотрёт и поставит свою:', JSON.stringify(before))
      // Иначе первый же set вернёт already=true и сцена «а» ничего не измерит.
      await step('забыть старую базу', 'base', { mode: 'forget' })
    }

    await buildArena()
    const at = await sceneSet()
    if (at) {
      sceneMemory(at)
      await sceneWhere(at)
      const neighbour = await putNeighbour(at)
      await sceneStore(at)
      await sceneNeighbour(at, neighbour)
      await sceneTake(at)
      await sceneGoHome(at)
      await sceneNowhere(at)
      await sceneBroken(at, neighbour)
      await sceneOverflow(at)
    } else {
      check('без базы остальные сцены не измеримы', false, 'set не вернул координат')
    }
    await cleanUp(before)

    console.log(`\nитог: ${failures ? failures + ' проверок не прошло' : 'все проверки прошли'}`)
    if (failures) process.exitCode = 1
  } catch (e) {
    console.error('FAILED:', e.stack || e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })

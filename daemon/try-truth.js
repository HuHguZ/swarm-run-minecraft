'use strict'
// Сцена для трёх правок, где врал не текст описания, а код под ним.
//
//   А. Автопилот внутри mc_wait. Инструкция мозгу кончается словами «паркуйся
//      в mc_wait(280)», а три рутины из шести считали mc_wait занятостью и на
//      эти 280 секунд замолкали: не ели ниже food 16, не надевали броню из
//      собственного рюкзака, не ковали кирку. Проверяем не «код не упал», а
//      что события ate/armor/tool приезжают ИМЕННО ВНУТРИ ожидания.
//   Б. mc_remember place=<база> дописывает запись, а не подменяет её. Проверка
//      на диске: memory/state.json до и после, ключ chests обязан выжить.
//   В. Долгий интент, оборванный по времени, приносит числа. В прогоне
//      recover от 2026-08-31 тело дошло до кучи — координаты это подтверждали,
//      — а detail приехал пустой, и снаружи это неотличимо от «не пошёл
//      вовсе»: две ложные красные в сцене, накануне зелёной.
//
// Про окно замера. Любой ответ демона выгребает шину, поэтому события копятся
// ЗДЕСЬ, на транспорте: каждый пришедший ответ отдаёт свои events в общий
// журнал, а окно задаётся двумя концами по времени — открыли перед стартом
// работы, закрыли когда работа вернулась. Без второго конца в замер попадает
// то, что сцена сама сделала с миром после него.
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

const STATE = path.resolve(__dirname, '..', 'memory', 'state.json')
// Своё имя базы, не «база»: сцена не имеет права переносить настоящий дом бота
// и терять настоящий общак. В конце запись убирается через base mode=forget.
const PLACE = 'правда-сцена'

// Арена подальше от всего, чем заняты другие сцены.
const AX = 2100
const AY = 70
const AZ = 2100

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
// seq -> событие. Map, а не массив: одно и то же событие приезжает один раз,
// но ответов, которые могли бы его привезти, много.
const journal = new Map()

const call = (method, params = {}) => new Promise((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  const r = m.result
  if (r) {
    if (Array.isArray(r.events)) for (const e of r.events) journal.set(e.seq, e)
    // Причина прерывания едет отдельным полем и в events её нет.
    if (r.by && r.by.seq !== undefined) journal.set(r.by.seq, r.by)
  }
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(r) : p.reject(new Error(m.error))
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0
let fail = 0
function ok (label, cond, extra) {
  if (cond) pass++
  else fail++
  console.log(`   [${cond ? ' OK ' : 'ПЛОХО'}] ${label}${extra ? ' — ' + extra : ''}`)
}
function note (text) { console.log(`   [ .. ] ${text}`) }

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

async function step (label, method, params) {
  const r = await call(method, params)
    .catch(e => ({ status: 'RPC', error: e.message, stack: e.stack }))
  const tail = r.error ? ` ← ${r.error}` : ''
  console.log(`${label.padEnd(34)} ${String(r.status).padEnd(9)} ${JSON.stringify(r.detail ?? null)}${tail}`)
  if (r.status === 'RPC' && r.stack) {
    console.log(`${''.padEnd(34)} стек: ${String(r.stack).split('\n').slice(1, 4).map(s => s.trim()).join(' <- ')}`)
  }
  if (r.partial) console.log(`${''.padEnd(34)} (отчёт частичный — работа шла, время кончилось)`)
  return r
}

// Оба конца окна. `open` заодно выгребает всё, что накопилось до него: события
// прошлой ветки не должны считаться за события этой.
async function open () {
  await call('status')
  return { from: Date.now() }
}
function close (win) {
  win.to = Date.now()
  return win
}
function inside (win, type) {
  return [...journal.values()].filter(e =>
    e.type === type && e.at >= win.from && e.at <= (win.to ?? Date.now()))
}
function typesInside (win) {
  const seen = [...journal.values()]
    .filter(e => e.at >= win.from && e.at <= (win.to ?? Date.now()))
    .map(e => e.type)
  return [...new Set(seen)].join(', ') || 'ничего'
}

const state = async () => (await call('status')).state

function readState () {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch (e) { return { places: {}, __error: e.message } }
}

// Чистый пол без мобов и без ночи. /kill до /tp вычищает арену, ИЗ которой
// уходим (@e видит только прогруженные чанки), второй — ту, в которую пришли.
// Координаты через пробел: запятая тут не разделитель.
async function arena () {
  await call('stop')
  await sleep(800)
  await cmd('/gamerule spawn_mobs false')
  await cmd('/kill @e[type=!player,type=!item]')
  await cmd('/time set 6000')
  await cmd('/weather clear')
  await cmd(`/tp @s ${AX} ${AY} ${AZ}`)
  await cmd('/kill @e[type=!player]')
  await sleep(3000)
  await cmd(`/fill ${AX - 10} ${AY - 2} ${AZ - 10} ${AX + 10} ${AY - 1} ${AZ + 10} minecraft:stone`)
  await cmd(`/fill ${AX - 10} ${AY} ${AZ - 10} ${AX + 10} ${AY + 4} ${AZ + 10} minecraft:air`)
  await cmd(`/tp @s ${AX} ${AY} ${AZ}`)
  await sleep(1500)
  await cmd('/clear @s')
  await cmd('/effect clear @s')
  await sleep(1200)
}

async function give (...gives) {
  for (const g of gives) await cmd(`/give @s minecraft:${g}`)
  await sleep(700)
}

// Голод не выставляется, только тратится: 0.005*(amplifier+1) истощения за тик,
// amplifier 20 — примерно очко за две секунды. Гнать только на пустой рюкзак:
// ниже food 16 автопилот ест каждую секунду и отменит слив быстрее, чем он идёт.
async function drainTo (target, timeoutMs = 120000) {
  await cmd('/effect give @s minecraft:hunger 120 20 true')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await state()
    if (s.food <= target) break
    await sleep(500)
  }
  await cmd('/effect clear @s minecraft:hunger')
  await sleep(400)
  const s = await state()
  note(`голод доведён до ${s.food} (цель <=${target})`)
  return s.food
}

// Ровно тот набор, который автопилот обязан пустить в дело: еда (ate), броня в
// рюкзаке (armor), и материал на кирку при нулевом запасе взмахов (tool —
// toolPlan просит кирку, пока в сумке меньше 40 ударов, а после /clear их 0).
async function feedTheAutopilot () {
  await give('cooked_beef 8')
  await give('iron_chestplate 1', 'iron_helmet 1')
  await give('cobblestone 16', 'stick 8', 'oak_planks 16')
}

// ------------------------------------------------------------------ А

async function branchWait () {
  console.log('\n=== А. автопилот внутри mc_wait ===')
  await arena()
  await drainTo(12)

  // Окно открывается ровно на старте ожидания, и всё, чем автопилот должен
  // воспользоваться, выдаётся УЖЕ ВНУТРИ него. Иначе тело успевает поесть и
  // одеться на подготовке — с пустой шиной к моменту вызова wait, и зелёная
  // правка выглядела бы красной.
  const win = await open()
  const waiting = step('  mc_wait(70)', 'wait', { seconds: 70 })
  await sleep(1500)
  await feedTheAutopilot()
  const r = await waiting
  close(win)

  console.log(`   события внутри ожидания: ${typesInside(win)}`)
  ok('mc_wait ответил без ошибки', r.status === 'done' || r.status === 'interrupted', r.error || r.status)
  ok('поел внутри ожидания', inside(win, 'ate').length > 0,
    JSON.stringify(inside(win, 'ate').map(e => e.item)))
  ok('оделся внутри ожидания', inside(win, 'armor').length > 0,
    JSON.stringify(inside(win, 'armor').map(e => e.equipped)))
  const tools = inside(win, 'tool')
  ok('сковал инструмент внутри ожидания', tools.length > 0,
    JSON.stringify(tools.map(e => `${e.made} (${e.was}->${e.left})`)))
  if (!tools.length) {
    const nope = inside(win, 'no_tool')
    if (nope.length) note(`вместо tool приехал no_tool: ${JSON.stringify(nope.map(e => e.why))}`)
  }
  const s = await state()
  note(`после ожидания: еда ${s.food}, рюкзак ${JSON.stringify(s.inventory)}`)
}

// Негативный контроль. Тот же набор, та же длительность, но тело действительно
// занято — и те же три события обязаны НЕ приехать. Без этого конца ветка А
// доказывает только то, что за семьдесят секунд что-то случилось.
async function branchBusyControl () {
  console.log('\n=== А-контроль: то же самое под настоящим интентом ===')
  await arena()
  await drainTo(12)

  const win = await open()
  // ancient_debris в верхнем мире не бывает — explore гарантированно не найдёт
  // и отработает весь срок, а не вернётся на первой же сосне.
  const exploring = step('  mc_explore(50)', 'explore',
    { block: 'ancient_debris', timeoutSeconds: 50, stepDistance: 8, radius: 16 })
  await sleep(1500)
  await feedTheAutopilot()
  const r = await exploring
  close(win)

  console.log(`   события внутри explore: ${typesInside(win)}`)
  ok('explore отработал срок', r.status === 'done' || r.status === 'timeout', r.error || r.status)
  ok('контроль: НЕ ел под интентом', inside(win, 'ate').length === 0,
    JSON.stringify(inside(win, 'ate').map(e => e.item)))
  ok('контроль: НЕ одевался под интентом', inside(win, 'armor').length === 0)
  ok('контроль: НЕ ковал под интентом', inside(win, 'tool').length === 0)
}

// ------------------------------------------------------------------ Б

async function branchRemember () {
  console.log('\n=== Б. mc_remember не стирает общак ===')
  await arena()
  await give('chest 2', 'torch 4', 'oak_planks 16', 'cobblestone 16', 'iron_pickaxe 1')

  const set = await step(`  base set name=${PLACE}`, 'base', { mode: 'set', name: PLACE, radius: 6 })
  if (set.status !== 'done') {
    note('база не встала — дальше проверять нечего, ветка не отработала')
    ok('base mode=set отработал', false, set.error || set.status)
    return
  }

  const before = readState().places[PLACE]
  if (!before) { ok('запись базы легла на диск', false, 'в state.json нет ' + PLACE); return }
  const keysBefore = Object.keys(before)
  note(`на диске до: ${JSON.stringify(before)}`)
  ok('в записи есть общак', Array.isArray(before.chests), JSON.stringify(before.chests))

  // Отойти, чтобы переписанные координаты было видно, но остаться внутри
  // STASH_RADIUS=24 — иначе сундук отфильтруется по расстоянию и мы увидим
  // «потерян» там, где на самом деле «переехали».
  await cmd(`/tp @s ${AX + 5} ${AY} ${AZ + 5}`)
  await sleep(1200)

  const r = await step(`  remember place=${PLACE}`, 'remember',
    { text: 'проверка: запись должна уцелеть целиком', place: PLACE })
  ok('remember отработал', r.status === 'done', r.error || r.status)

  const after = readState().places[PLACE]
  note(`на диске после: ${JSON.stringify(after)}`)
  ok('запись на месте', !!after)
  if (!after) return

  ok('note переписан', after.note === 'проверка: запись должна уцелеть целиком', after.note)
  ok('координаты переписаны на текущие', after.x === AX + 5 && after.z === AZ + 5,
    `${after.x},${after.y},${after.z}`)
  ok('СУНДУКИ УЦЕЛЕЛИ', Array.isArray(after.chests) && after.chests.length === (before.chests || []).length,
    JSON.stringify(after.chests))
  const lost = keysBefore.filter(k => !(k in after))
  ok('ни один ключ записи не пропал', lost.length === 0, lost.length ? 'потеряно: ' + lost.join(', ') : '')

  // И через глаза демона, а не только через файл: список общака всё ещё виден.
  const stash = await step('  stash list', 'stash', { mode: 'list', name: PLACE })
  note(`общак глазами демона: ${JSON.stringify(stash.detail)}`)

  await step(`  base forget name=${PLACE}`, 'base', { mode: 'forget', name: PLACE })
  const gone = readState().places[PLACE]
  ok('запись сцены за собой убрана', !gone)
}

// ------------------------------------------------------------------ В

async function branchPartial () {
  console.log('\n=== В. оборванный по времени интент приносит числа ===')
  await arena()
  await give('iron_pickaxe 2', 'cooked_beef 8')

  // В1. Шахта вниз со своим дедлайном. Раньше срок жил только снаружи, в
  // runIntent, и при его истечении detail терялся целиком. Теперь действие
  // останавливает себя само и отвечает done с числами и причиной.
  const d = await step('  dig_down depth=40 t=20', 'dig_down',
    { depth: 40, mode: 'shaft', timeoutSeconds: 20 })
  ok('dig_down ответил с отчётом', !!d.detail, JSON.stringify(d.detail))
  ok('dig_down: выкопанное посчитано', !!d.detail && typeof d.detail.dug === 'number' && d.detail.dug > 0,
    d.detail && String(d.detail.dug))
  ok('dig_down: сказал, почему встал', !!d.detail && typeof d.detail.stopped === 'string',
    d.detail && d.detail.stopped)
  ok('dig_down: timeoutSeconds сработал раньше глубины', !!d.detail && d.detail.dug < 40,
    d.detail && `${d.detail.dug} из 40`)

  await arena()
  await give('iron_pickaxe 2')

  // Дальше замеряется, что происходит, когда работу обрывают. Значит обрывать
  // её должна ТОЛЬКО сцена. Первый прогон этого не обеспечил: mine выгрызает
  // пол под собой, тело падает в собственную яму, прилетает fall damage — и
  // ветка ловила interrupted вместо замеряемого таймаута («окно не поймано»).
  // Урон от падения выключается на обе подветки и включается обратно в конце.
  await cmd('/gamerule fall_damage false')

  // В2. Тот самый путь, что стоил двух ложных красных: у mine своего дедлайна
  // нет, срок кончается снаружи. Отчёт обязан доехать всё равно.
  const m = await step('  mine stone x64 t=10', 'mine',
    { block: 'stone', count: 64, radius: 16, fair: false, timeoutSeconds: 10 })
  ok('mine: сработал именно срок', m.status === 'timeout', m.status)
  ok('mine: принёс отчёт, а не пустоту', !!m.detail, JSON.stringify(m.detail))
  ok('mine: в отчёте числа', !!m.detail && m.detail.dug > 0, m.detail && String(m.detail.dug))
  ok('mine: помечен как частичный', m.partial === true)

  // В2б. Обрыв не по часам, а по событию, и это НЕ чат: за damage, low_health,
  // death, kicked и disconnected никто не ждёт ответа, а терялось при них ровно
  // то же самое — штрек на сорок блоков, оборванный царапиной, приезжал как
  // interrupted null, неотличимо от «не начинал».
  //
  // Оба конца окна: урон наносит сама сцена в известный момент, и падать тут
  // больше не с чего — значит прерывание может быть только наше.
  await arena()
  await give('iron_pickaxe 2')
  await cmd('/gamerule fall_damage false')
  const digging = step('  mine stone x64, урон на 4с', 'mine',
    { block: 'stone', count: 64, radius: 16, fair: false, timeoutSeconds: 60 })
  await sleep(4000)
  await cmd('/damage @s 4 minecraft:generic')
  const mi = await digging
  ok('прервано, и прервано нами', mi.status === 'interrupted' && mi.by && mi.by.type === 'damage',
    mi.status + (mi.by ? ' by ' + mi.by.type : ''))
  ok('ОБРЫВ НЕ ЧАТОМ ПРИНЁС ОТЧЁТ', !!mi.detail, JSON.stringify(mi.detail))
  ok('в отчёте числа', !!mi.detail && mi.detail.dug > 0, mi.detail && String(mi.detail.dug))
  ok('помечен как частичный', mi.partial === true)
  ok('stopped называет причину обрыва', !!mi.detail && /прервано/.test(mi.detail.stopped || ''),
    mi.detail && mi.detail.stopped)
  await cmd('/gamerule fall_damage true')

  // В3. Дорога, которой нет. Это единственное красное первого прогона: у goto
  // не было своего срока, он держался на часах runIntent, а на обрыве бросает —
  // и когда аборт заставал его внутри unstick (секунда удержанных клавиш плюс
  // look), воркер не успевал размотаться за грейс, и до мозга не доезжало
  // НИЧЕГО: ни чисел, ни слов. Теперь тело останавливает себя само и успевает
  // сказать, где стоит и сколько осталось.
  const g = await step('  goto далеко t=10', 'goto',
    { x: AX + 4000, y: AY, z: AZ + 4000, range: 2, timeoutSeconds: 10 })
  const words = (g.detail && g.detail.stopped) || g.error || null
  ok('goto объяснил словами, почему не дошёл', !!words, words || JSON.stringify(g.detail))
  ok('goto остановился по своему сроку, а не по чужому', g.status !== 'timeout', g.status)
  if (g.detail) {
    ok('goto сказал, где осталось тело', !!g.detail.at, JSON.stringify(g.detail.at))
    ok('goto не притворился дошедшим', g.detail.arrived === undefined)
    note(`до цели оставалось ${g.detail.awayBlocks} блоков, попыток ${g.detail.attempts}`)
  }

  await arena()
}

// ------------------------------------------------------------------ пуск

ws.on('open', async () => {
  try {
    await call('connect')
    await branchWait()
    await branchBusyControl()
    await branchRemember()
    await branchPartial()

    console.log('\nчего ждём:')
    console.log('  А  — ate, armor и tool ВНУТРИ mc_wait; в контроле их там нет.')
    console.log('  Б  — chests и остальные ключи записи переживают mc_remember.')
    console.log('  В  — у оборванного по времени интента есть dug/gained и stopped,')
    console.log('       а не detail:null. Пустой detail тут значит, что тело работало,')
    console.log('       а мозгу об этом не сказали — ровно та ошибка, что дала две')
    console.log('       ложные красные в recover 2026-08-31. goto при этом обязан')
    console.log('       отвечать САМ (статус не timeout): свой срок у него теперь есть.')
    console.log('       Обрыв по damage/low_health/death тоже приносит отчёт; без')
    console.log('       отчёта отвечают только на chat — там ждёт живой человек.')
    console.log(`\nитого: ${pass} ok, ${fail} плохо`)
    process.exitCode = fail ? 1 : 0
  } catch (e) {
    console.error('СЦЕНА УПАЛА:', e.message)
    console.error(e.stack)
    process.exitCode = 2
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })

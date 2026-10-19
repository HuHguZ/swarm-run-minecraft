'use strict'
import * as gameClock from '../../src/game-clock'
// Путь от «игрок написал» до «мозг это увидел» — целиком, по частям, с часами.
//
// Подозрение, ради которого сцена написана: `bus.nextInterrupt()` (events.js:49)
// заводит ожидателя и НИКОГДА не смотрит в буфер. Значит, сообщение, пришедшее
// пока мозг между ходами, не может разбудить следующий `wait` — оно уже лежит,
// а будить некого. Проверяется это одним числом: сколько миллисекунд длился
// `wait(30)`, позванный ПОСЛЕ сообщения. 30000 — подозрение верно.
//
// ГРАБЛИ ИЗМЕРЕНИЯ, все три — про то, что мерить нечем, если мерил неаккуратно:
//
// * Шину выгребает ЛЮБОЙ ответ демона (session.js:299 и :318 —
//   `result.events = this.bus.drain()`), а не только тот, который читают.
//   Поэтому между «Igrok сказал» и замеряемым вызовом здесь НЕТ ни одной
//   команды: один `cmd('/tp ...')` — и событие уехало в ответ на телепорт.
//   Всё, что демон когда-либо сказал, копится на транспорте в `heard`, включая
//   поле `by` (событие, которым прервали) — иначе прерывание не видно вообще
//   нигде: runIntent вычёркивает `by` из `events` по seq (session.js:300).
// * Мобы. Любой удар — это 'damage', тоже прерывание, и он ломает замер «что
//   именно разбудило wait». Отсюда /difficulty peaceful: заодно не падает
//   сытость, то есть автопилот не ест и не подмешивает своих событий.
// * Второй игрок — настоящий клиент (scene-player.js), а не /say и не /summon:
//   чат и шёпот от игрока приходят разными обработчиками (session.js:152 и
//   :158), и сцена, которая шлёт их командой от имени бота, проверяет не то —
//   свой же чат демон отфильтровывает по username.
//
// Часть проверок — чистые, без мира: шина и format.render — обычные функции.
// Они идут ПЕРВЫМИ, чтобы сломанная правка падала за секунду, а не за пять
// минут постройки арены.
import path = require('path')
import { pathToFileURL } from 'url'
import WebSocket = require('ws')
import { EventBus } from '../../src/events'
import { joinAsPlayer } from '../lib/scene-player'

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

const heard = []
const mark = () => heard.length
const since = (n, type) => heard.slice(n).filter(e => !type || e.type === type)

ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.ok && m.result) {
    // Порядок важен: `by` всегда старше того, что налипло после него.
    if (m.result.by && m.result.by.type) heard.push(m.result.by)
    if (Array.isArray(m.result.events)) heard.push(...m.result.events)
  }
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

const sleep = ms => gameClock.sleep(ms)

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

// ---------------------------------------------------------------- вердикты

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

// ---------------------------------------------------------------- арена

// x=1500 — своя полоса. Чужие арены: z -26..-4, 190..210, 300..329, 400..429,
// 600..630, 686..783 и x=850 z=850..990; соседние агенты сидят на x=1300 и
// x=1400. Две полосы вместо шести: разговору арена не нужна вовсе, коридор
// нужен только тому случаю, где сообщение прилетает посреди ходьбы.
const X0 = 1500
const LANE_TALK = 1500
const LANE_WALK = 1520
const Y = 70

async function arena (lane, corridor = false) {
  await call('stop')
  await sleep(600)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set day')
  // Мир без урона: 'damage' — тоже прерывание, и он подменил бы ответ на
  // вопрос «чем именно разбудили». На peaceful ещё и не убывает сытость, так
  // что автопилот не ест и не досыпает своих событий в буфер.
  await cmd('/difficulty peaceful')
  await cmd(`/tp @s ${X0} ${Y + 1} ${lane}`)
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000) // чанки: без этого /fill молча не срабатывает
  const half = corridor ? 20 : 6
  await cmd(`/fill ${X0 - half} ${Y - 2} ${lane - 4} ${X0 + half} ${Y - 1} ${lane + 4} minecraft:stone`)
  await cmd(`/fill ${X0 - half} ${Y} ${lane - 4} ${X0 + half} ${Y + 4} ${lane + 4} minecraft:air`)
  await cmd(`/tp @s ${X0 - (corridor ? 16 : 0)}.5 ${Y} ${lane}.5`)
  await cmd(`/tp Igrok ${X0 - (corridor ? 16 : 0)}.5 ${Y} ${lane + 3}.5`)
  await cmd('/effect give @s minecraft:saturation 1 5 true')
  await sleep(1500)
}

// ------------------------------------------------- 0. шина, без мира и бота

// Ровно та развилка, из-за которой сообщение не будит: буфер и ожидатели —
// два независимых механизма, и emit кладёт в оба только для тех, кто уже ждал.
async function checkBus () {
  console.log('\n=== 0. шина событий: разбудит ли уже лежащее сообщение ===')

  const waits = (bus, ms = 400) =>
    Promise.race([bus.nextInterrupt(), sleep(ms).then(() => 'ЖДЁТ')])

  const a = new EventBus()
  a.emit('chat', { from: 'Igrok', text: 'ты где?' })
  const got = await waits(a)
  check('chat, уже лежащий в буфере, будит сразу',
    got !== 'ЖДЁТ' && got.type === 'chat' && got.text === 'ты где?', JSON.stringify(got))

  // Обратная сторона: выгребли — значит, отдали. Второй раз то же сообщение
  // будить не должно, иначе каждый следующий интент рвался бы о прошлое.
  const b = new EventBus()
  b.emit('chat', { from: 'Igrok', text: 'привет' })
  b.drain()
  check('выгребленный chat больше не будит', await waits(b) === 'ЖДЁТ')

  // damage лежит в буфере постоянно (его никто не выгребает, пока мозг молчит).
  // Если бы он будил из буфера, каждый интент после драки рвался бы на старте.
  const c = new EventBus()
  c.emit('damage', { health: 14, lost: 2 })
  check('лежащий damage интент НЕ рвёт', await waits(c) === 'ЖДЁТ')

  // Живой путь не должен сломаться правкой: пришло во время ожидания — будит.
  const d = new EventBus()
  const p = d.nextInterrupt()
  gameClock.setTimeout(() => d.emit('chat', { from: 'Igrok', text: 'на ходу' }), 120)
  const live = await Promise.race([p, sleep(800).then(() => 'ЖДЁТ')])
  check('chat во время ожидания будит по-прежнему',
    live !== 'ЖДЁТ' && live.text === 'на ходу', JSON.stringify(live))

  // Предел буфера. MAX_BUFFER=60, лишнее срезается с головы, то есть первым
  // выпадает самое старое — а самое старое здесь и есть непрочитанное
  // сообщение. Одна драка (damage на каждый удар) даёт эти 60 легко.
  const e = new EventBus()
  e.emit('chat', { from: 'Igrok', text: 'меня нельзя терять' })
  for (let i = 0; i < 120; i++) e.emit('ate', { item: 'bread', food: 18 })
  const survived = e.drain().filter(x => x.type === 'chat')
  check('сообщение переживает переполнение буфера', survived.length === 1,
    `осталось ${survived.length} chat из 121 события`)
}

// ------------------------------------------- 0b. формат, без мира и бота

// format.render — чистая функция, и весь смысл правки в ней: непрочитанное
// сообщение обязано вылезти наверх, а не лежать в хвосте рядом с «рассвело».
async function checkFormat () {
  console.log('\n=== 0b. format.render: сообщение наверху ответа ===')
  const url = pathToFileURL(path.resolve(__dirname, '..', '..', '..', 'mcp', 'src', 'format.js')).href
  const fmt = await import(url)

  const state = {
    connected: true,
    health: 20,
    food: 20,
    pos: { x: 1500, y: 70, z: 1500 },
    biome: 'plains',
    time: 'день',
    inventory: {} as Record<string, any>
  }

  // Прерывание: текст приезжает в `by`.
  const one = fmt.render('wait', {
    status: 'interrupted',
    by: { seq: 7, at: gameClock.now(), type: 'chat', from: 'Igrok', text: 'ты где?' },
    events: [{ seq: 8, at: gameClock.now(), type: 'ate', item: 'bread', food: 18 }],
    state
  }).split('\n')
  console.log(one.map(l => '    | ' + l).join('\n'))
  check('строка про игрока — вторая, сразу под шапкой', /^‼/.test(one[1] || ''), one[1])
  check('в ней есть имя и текст',
    /Igrok/.test(one[1] || '') && /ты где\?/.test(one[1] || ''), one[1])
  check('текст сообщения не напечатан дважды',
    one.join('\n').split('ты где?').length - 1 === 1)
  check('прочие события остались внизу', one.some(l => /поел bread/.test(l)))

  // Простой ответ: текст приезжает в `events`, поле другое — человек тот же.
  const two = fmt.render('status', {
    status: 'done',
    detail: null,
    events: [
      { seq: 3, at: gameClock.now(), type: 'chat', from: 'Igrok', text: 'открой дверь' },
      { seq: 4, at: gameClock.now(), type: 'chat', from: 'Igrok', text: 'это лично', whisper: true }
    ],
    state
  }).split('\n')
  console.log(two.map(l => '    | ' + l).join('\n'))
  check('оба сообщения подняты наверх',
    /^‼/.test(two[1] || '') && /^‼/.test(two[2] || ''), `${two[1]} / ${two[2]}`)
  check('порядок сохранён', /открой дверь/.test(two[1] || ''), two[1])
  check('шёпот помечен шёпотом и отделён от общего чата',
    /шёпот/i.test(two[2] || '') && !/шёпот/i.test(two[1] || ''), two[2])
  check('в хвосте «события:» чатов уже нет', !two.some(l => /^· (чат|шёпот)/.test(l)))
}

// ------------------------------------------------------ 1. мозг между ходами

// Сообщение пришло, когда не шло ничего. Оно обязано доехать целиком — имя,
// текст, отдельный признак шёпота — в первый же ответ демона, каким бы он ни был.
async function sceneIdle (igrok) {
  console.log('\n=== 1. сообщение пришло, пока ничего не шло ===')
  const t0 = mark()
  await igrok.say('привет, я тут')
  await igrok.whisper('NeuroDown', 'а это лично тебе')
  await sleep(1200)

  const r: any = await call('status')
  const chats = (r.events || []).filter(e => e.type === 'chat')
  console.log('  приехало:', JSON.stringify(chats))
  check('оба сообщения в первом же ответе', chats.length === 2, `${chats.length} шт.`)
  check('имя отправителя доехало', chats.every(e => e.from === 'Igrok'),
    JSON.stringify(chats.map(e => e.from)))
  check('текст общего чата целый',
    chats.some(e => e.text === 'привет, я тут' && !e.whisper))
  check('шёпот отмечен отдельно',
    chats.some(e => e.text === 'а это лично тебе' && e.whisper === true))
  check('на транспорте видно ровно два', since(t0, 'chat').length === 2)
}

// -------------------------------------------------- 2. wait ПОСЛЕ сообщения

// Главный замер. Между `igrok.say` и `wait` нет ни одного вызова демона —
// значит, сообщение гарантированно лежит в буфере, и вопрос ровно один:
// смотрит ли `wait` в буфер или заводит ожидателя в пустоту.
async function sceneWaitAfter (igrok) {
  console.log('\n=== 2. сообщение УЖЕ лежит, потом wait(30) ===')
  await igrok.say('эй, ответь мне')
  await sleep(1500)

  const t = gameClock.now()
  const r: any = await call('wait', { seconds: 30 })
  const ms = gameClock.now() - t
  console.log(`  wait вернулся за ${ms}мс, статус ${r.status}, by=${JSON.stringify(r.by || null)}`)

  check('wait не проспал все 30 секунд', ms < 5000, `${ms}мс`)
  check('wait вернулся именно прерыванием', r.status === 'interrupted', r.status)
  check('разбудило сообщение игрока', !!r.by && r.by.type === 'chat',
    JSON.stringify(r.by || null))
  check('в ответе есть сам текст, а не только тип',
    !!r.by && r.by.text === 'эй, ответь мне' && r.by.from === 'Igrok',
    JSON.stringify(r.by || null))
}

// -------------------------------------------------- 3. wait ДО сообщения

// Контроль: путь, который работал и до правки. Если он сломался, правка
// заменила одну глухоту другой.
async function sceneWaitBefore (igrok) {
  console.log('\n=== 3. wait(30) уже идёт, сообщение приходит потом ===')
  const t = gameClock.now()
  const p = call('wait', { seconds: 30 })
  await sleep(2500)
  await igrok.say('просыпайся')
  const r: any = await p
  const ms = gameClock.now() - t
  console.log(`  wait вернулся за ${ms}мс, статус ${r.status}`)

  check('wait прервался на сообщении, а не по сроку', ms < 12000 && r.status === 'interrupted',
    `${ms}мс, ${r.status}`)
  check('текст приехал', !!r.by && r.by.text === 'просыпайся', JSON.stringify(r.by || null))
}

// --------------------------------------------------------- 4. два подряд

// Буфер — массив с push, так что затирать нечему; проверяется это, а не вера.
async function sceneTwo (igrok) {
  console.log('\n=== 4. два сообщения подряд ===')
  await igrok.say('первое')
  await igrok.say('второе')
  await sleep(1200)

  const r: any = await call('status')
  const chats = (r.events || []).filter(e => e.type === 'chat')
  console.log('  приехало:', JSON.stringify(chats.map(e => e.text)))
  check('доехали оба', chats.length === 2, `${chats.length} шт.`)
  check('второе не затёрло первое', chats[0] && chats[0].text === 'первое', JSON.stringify(chats[0]))
  check('порядок как в жизни', chats[1] && chats[1].text === 'второе', JSON.stringify(chats[1]))
}

// ------------------------------------------------------- 5. гонка дренажа

// Два ответа уезжают одновременно. Сообщение не теряется — но достаётся тому,
// кто ответил первым, а не тому, кто его ждал. Это и есть причина, по которой
// поднимать сообщение наверх обязан формат: предсказать, к какому ответу оно
// прилипнет, нельзя.
async function sceneRace (igrok) {
  console.log('\n=== 5. гонка: ответ уехал раньше на другой вызов ===')
  await igrok.say('кому я достанусь')
  await sleep(1200)

  const [r1, r2] = await Promise.all([call('status'), call('observe', { radius: 8 })])
  const has = r => (r.events || []).some(e => e.type === 'chat' && e.text === 'кому я достанусь')
  console.log(`  в первом ответе: ${has(r1)}, во втором: ${has(r2)}`)
  check('сообщение не потерялось', has(r1) || has(r2))
  check('и не задвоилось', !(has(r1) && has(r2)))
  check('досталось тому, кто ответил первым', has(r1), 'если false — порядок ответов другой')
}

// ---------------------------------------------- 6. сообщение во время дела

// Тут проверяется не пробуждение, а содержимое прерывания: `by` — это целое
// событие или один тип. От этого зависит, придётся ли мозгу тратить ход на
// «а что он там сказал».
async function sceneDuringIntent (igrok) {
  console.log('\n=== 6. сообщение посреди намерения (goto) ===')
  const p = call('goto', { x: X0 + 16, z: LANE_WALK, range: 0, timeoutSeconds: 60 })
  await sleep(3000)
  await igrok.say('стой, не туда')
  const r: any = await p
  console.log(`  goto: ${r.status}, by=${JSON.stringify(r.by || null)}`)

  check('намерение прервано', r.status === 'interrupted', r.status)
  check('в прерывании есть текст и имя',
    !!r.by && r.by.type === 'chat' && r.by.from === 'Igrok' && r.by.text === 'стой, не туда',
    JSON.stringify(r.by || null))
  check('это же событие не продублировано в events',
    !(r.events || []).some(e => e.seq === (r.by && r.by.seq)))
}

// ------------------------------------------------------- 7. ответ адресату

// Отвечать в общий чат на то, что сказали шёпотом, — другой поступок: это
// читает весь сервер. Проверяется, что ответ уходит тем же каналом.
async function sceneReply (igrok) {
  console.log('\n=== 7. ответить именно тому, кто написал ===')
  const whispers = []
  const publics = []
  const onW = (from, message) => whispers.push({ from, message })
  const onC = (from, message) => publics.push({ from, message })
  igrok.bot.on('whisper', onW)
  igrok.bot.on('chat', onC)

  try {
    await call('say', { text: 'слышу тебя, иду', to: 'Igrok' })
    await sleep(1500)
    console.log('  шёпотом:', JSON.stringify(whispers), 'в общий:', JSON.stringify(publics))
    check('ответ дошёл до адресата шёпотом',
      whispers.some(w => w.message === 'слышу тебя, иду'), JSON.stringify(whispers))
    check('и не ушёл в общий чат',
      !publics.some(c => c.message === 'слышу тебя, иду'), JSON.stringify(publics))

    await call('say', { text: 'всем привет' })
    await sleep(1500)
    check('без to — по-прежнему общий чат',
      publics.some(c => c.message === 'всем привет'), JSON.stringify(publics))
  } finally {
    igrok.bot.removeListener('whisper', onW)
    igrok.bot.removeListener('chat', onC)
  }
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  let igrok = null
  try {
    await checkBus()
    await checkFormat()

    await call('connect')
    igrok = await joinAsPlayer({ username: 'Igrok' })
    console.log(`\nIgrok в мире (${igrok.name})`)

    await arena(LANE_TALK)
    await sceneIdle(igrok)
    await sceneWaitAfter(igrok)
    await sceneWaitBefore(igrok)
    await sceneTwo(igrok)
    await sceneRace(igrok)
    await sceneReply(igrok)

    await arena(LANE_WALK, true)
    await sceneDuringIntent(igrok)

    await call('stop')
    await cmd('/difficulty normal')
    console.log(`\nитог: ${failures ? failures + ' проверок не прошло' : 'все проверки прошли'}`)
    if (failures) process.exitCode = 1
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    if (igrok) await igrok.leave().catch(() => {})
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })

'use strict'
import * as gameClock from '../../src/game-clock'
// Тело замечает человека — проверено фактом мира, а не ощущением.
//
// До этой сцены про игрока в демоне было ровно три вещи: чат и шёпот
// (session.js:152-161), вход и выход (session.js:184-187) и список имён в
// perception.playersOnline. Ни расстояния, ни направления, ни одного рефлекса:
// игрок мог подойти вплотную, постоять и уйти, и тело не замечало ничего.
//
// Проверяются шесть вещей, и ни одна не видна снаружи:
//   а. вход игрока доезжает до мозга отдельным событием;
//   б. подход ближе 6 блоков рождает player_near с именем, расстоянием,
//      направлением и тем, что в руке, — и тело поворачивается лицом;
//   в. тот же подход во время длинного намерения событие приносит, а намерение
//      не ломает и голову не отворачивает;
//   г. чат и шёпот намерение прерывают, и текст доезжает целиком;
//   д. КОНТРОЛЬ: уход за 12 блоков говорится РОВНО ОДИН раз, а не раз в
//      секунду — гистерезис, а не порог;
//   е. удар игрока не превращает игрока в цель. Это главное: сервер общий, и
//      бить владельца нельзя ни при каких обстоятельствах.
//
// ГРАБЛИ ИЗМЕРЕНИЯ, на которых этот проект стоял одиннадцать раз:
// * Шину событий опустошает ЛЮБОЙ ответ демона (session.js → immediate:
//   `result.events = this.bus.drain()`), включая ответ на /tp. Поэтому события
//   копятся на транспорте — `heard` ниже, — а не читаются из одного ответа.
// * Включающее действие идёт ПОСЛЕ mark(): игрок телепортируется в поле зрения
//   только после отметки, иначе автопилот успевает заметить его до начала
//   наблюдения, и окно видит уже отработавший рефлекс.
// * Поворот головы проверяется числом, а не картинкой: yaw тела приезжает
//   через players() (bot.entity.yaw) и НЕЗАВИСИМО — глазами второго клиента,
//   которому сервер шлёт повороты чужих тел пакетами.
// * Урон не измеряется здоровьем: регенерация при сытости 20 затягивает
//   единицу за пару секунд. Факт удара — событие 'damage', оно точное.
//
// Сцена требует применённых диффов (autopilot.js tick, session.players,
// index.js, combat.js). Без них случай (е) не просто не пройдёт: бот побьёт
// игрока, и это ровно та дыра, ради которой сцена написана.
//
// Отдельно про сервер: удар игрока по боту требует pvp=true в
// server.properties. Если событие 'damage' не приехало вовсе — смотреть надо
// туда, а не в код.
import WebSocket = require('ws')
import { joinAsPlayer } from '../lib/scene-player'

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
  console.log(`${label.padEnd(26)} ${String(r.status).padEnd(11)} ${JSON.stringify(r.detail ?? null)}${problem}`)
  if (r.by) console.log(`${''.padEnd(26)} прервано: ${r.by.type} «${r.by.text || ''}»`)
  return r
}

// ---------------------------------------------------------------- вердикты

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

// ---------------------------------------------------------------- арена

// x=1300: далеко от арен всех остальных прогонов (z -26..-4, 190..210,
// 300..329, 400..429, 600..630, 686..783 и x=850 z=850..990), чтобы чужой
// мусор нельзя было принять за местность этой.
const X0 = 1300
const Y = 60
const LANES = {
  join: 1300, // вход: игрок далеко, важен только сам факт
  near: 1330, // подход на 4 блока к стоящему боту
  tunnel: 1360, // подход во время штрека
  chat: 1390, // чат и шёпот в середине намерения
  gone: 1420, // уход за 12 блоков: одно событие, а не поток
  hit: 1450 // удар: цель из игрока не делается
}

// Гистерезис из social.js: ближе 6 — заметил, дальше 12 — забыл.
const NEAR = 6
const FAR = 12
// Куда отводится игрок между случаями. Внутри вырубленной комнаты, а не «куда
// подальше»: игрок, поставленный в толщу камня, задыхается по хиту в секунду,
// и следующий случай начинается с полудохлого участника. Восемнадцать блоков —
// дальше порога забывания в 12 и ближе радиуса обзора в 20, то есть «виден, но
// не рядом».
const PARK = 18

const deg = rad => ((rad * 180 / Math.PI) % 360 + 360) % 360
const angleDiff = (a, b) => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}
// Тот же yaw, который получится у тела после bot.lookAt: atan2(-dx, -dz).
const yawFromTo = (from, to) => deg(Math.atan2(-(to.x - from.x), -(to.z - from.z)))

// Комната из воздуха в сплошном камне: на восток остаётся порода, в которую
// можно вести штрек, а на юг — коридор длиной PARK, чтобы игроку было где
// стоять «далеко», не задыхаясь. east=2 оставляет забой в двух блоках от бота;
// east=8 нужен там, где игрок подходит с востока и должен стоять в воздухе.
async function arena (lane, { east = 8 }: any = {} as Record<string, any>) {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set day')
  await cmd('/difficulty normal')
  await cmd('/gamemode survival @s') // в креативе урон не проходит вовсе
  await cmd(`/tp @s ${X0} ${Y + 1} ${lane}`)
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000) // чанки: без этого /fill молча не сработает
  // 31×10×29 — под лимитом /fill в 32768 блоков, за которым команда молча
  // отказывается.
  await cmd(`/fill ${X0 - 8} ${Y - 3} ${lane - 8} ${X0 + 22} ${Y + 6} ${lane + PARK + 2} minecraft:stone`)
  await cmd(`/fill ${X0 - 6} ${Y} ${lane - 6} ${X0 + east} ${Y + 2} ${lane + PARK} minecraft:air`)
  // Сытый бот не запускает eatIfHungry: одна рутина в кадре, а не две.
  await cmd('/effect give @s minecraft:saturation 1 5 true')
}

async function standAt (lane) {
  await cmd(`/tp @s ${X0}.5 ${Y} ${lane}.5`)
  await sleep(2000)
}

async function tpIgrok (x, y, z) {
  await cmd(`/tp Igrok ${x} ${y} ${z}`)
  await sleep(2500) // сущность игрока доезжает до клиента бота отдельным пакетом
}

async function give (list) {
  await cmd('/clear @s')
  for (const g of list) await cmd(`/give @s ${g}`)
  await sleep(1200)
}

async function where () {
  const r: any = await call('status')
  return (r.state && r.state.pos) || { x: 0, y: 0, z: 0 }
}

// Ответ инструмента, которого мозг ждёт: кто рядом и куда смотрит тело.
// Отдельная обёртка, потому что без применённых диффов метода просто нет, и
// это должно быть видно строкой, а не падением всей сцены.
async function seen () {
  const r: any = await call('players', {} as Record<string, any>).catch(e => ({ status: 'RPC', error: e.message }))
  if (r.status === 'RPC') {
    console.log(`  players() недоступен: ${r.error} — применены ли диффы в session.js и index.js?`)
    return null
  }
  return r.detail || {} as Record<string, any>
}

// ---------------------------------------------------------------- а

// Вход. Единственное, что уже работало до этой задачи, — и потому годится как
// проверка транспорта: если сюда не доехало, дальше мерить нечего.
async function sceneJoined (igrokRef) {
  console.log('\n=== а. игрок зашёл: мозг узнал ===')
  await arena(LANES.join)
  await standAt(LANES.join)

  const t0 = mark()
  const igrok = await joinAsPlayer({ username: 'Igrok' })
  igrokRef.value = igrok
  await sleep(2000)
  await call('status') // дренаж шины в коллектор

  const joined = since(t0, 'player_joined').filter(e => e.username === 'Igrok')
  console.log('  сказано:', JSON.stringify(since(t0).map(e => e.type)))
  check('о входе сказано', joined.length >= 1, JSON.stringify(since(t0, 'player_joined')))
  check('о входе сказано один раз', joined.length === 1, `${joined.length} событий`)

  const s = await seen()
  if (s) {
    check('игрок в списке онлайн', (s.online || []).includes('Igrok'), JSON.stringify(s.online))
    // Онлайн и рядом — разные факты, и путать их нельзя: игрок в тысяче блоков
    // не повод здороваться.
    check('но рядом его нет', s.text === 'рядом никого', s.text)
  }
  await cmd('/gamemode survival Igrok')
}

// ---------------------------------------------------------------- б

// Подход к стоящему боту. Тело обязано заметить один раз и повернуться.
async function sceneNear (igrok) {
  console.log('\n=== б. подошёл на 4 блока, пока бот стоит ===')
  const lane = LANES.near
  await arena(lane)
  await standAt(lane)
  await give(['minecraft:iron_pickaxe 1'])

  // Игрок далеко и с киркой в руке. Кирка выдаётся ДО отметки: она не включает
  // рутину, включает её появление игрока в шести блоках.
  await tpIgrok(`${X0}.5`, Y, `${lane + PARK}.5`)
  await cmd('/give Igrok minecraft:iron_pickaxe 1')
  await sleep(1200)
  try {
    const pick = igrok.bot.inventory.items().find(i => i.name === 'iron_pickaxe')
    if (pick) await igrok.bot.equip(pick, 'hand')
  } catch (e) { console.log('  кирку в руку не дал:', e.message) }
  await sleep(1000)

  // Отвернуться на запад, чтобы поворот было видно как изменение, а не как
  // совпадение: запад — это yaw 90, восток — 270, разница в полкруга.
  await step('отвернуться на запад', 'look_at', { x: X0 - 12, y: Y + 1, z: lane })
  const before = await seen()
  if (before) {
    check('до подхода тело смотрит на запад', angleDiff(before.yaw, 90) <= 20, `yaw=${before.yaw}`)
  }

  const t0 = mark()
  await tpIgrok(`${X0 + 4}.5`, Y, `${lane}.5`) // ровно 4 блока на восток, то есть за спину
  await sleep(4000) // автопилот думает раз в секунду

  // Сперва ответ, потом счёт: события лежат в буфере демона, пока их не заберёт
  // ЛЮБОЙ ответ. Посчитать `heard` раньше первого ответа после телепорта —
  // значит посчитать пустоту.
  const after = await seen()
  const near = since(t0, 'player_near')
  console.log('  сказано:', JSON.stringify(since(t0).map(e => e.type)))
  console.log('  событие:', JSON.stringify(near[0] || null))
  check('о подходе сказано ровно один раз', near.length === 1,
    `${near.length} событий при пороге замечания в ${NEAR} блоков`)
  const ev = near[0] || {} as Record<string, any>
  check('названо имя', ev.name === 'Igrok', String(ev.name))
  check('названо расстояние', Math.abs((ev.dist ?? 99) - 4) <= 1.5, `dist=${ev.dist}`)
  // Направление снято в момент, когда бот его заметил, то есть ДО поворота:
  // игрок стоял за спиной. Это и есть та фраза, которую ждёт мозг.
  check('названо направление в момент, когда заметил', ev.where === 'позади', String(ev.where))
  check('названо, что в руке', ev.holding === 'iron_pickaxe', String(ev.holding))
  check('сказано, что видим глазами', ev.canSee === true, String(ev.canSee))
  check('фраза собрана целиком', /Igrok в 4 блоках позади.*в руке кирка/.test(ev.text || ''), ev.text)

  const igrokPos = igrok.entity.position
  if (after) {
    const me = after.players && after.players[0]
    console.log(`  yaw: было ${before ? before.yaw : '?'}, стало ${after.yaw}`)
    check('тело повернулось к игроку', after.lookingAt === 'Igrok',
      `lookingAt=${after.lookingAt}, yaw=${after.yaw}`)
    check('угол до игрока сошёлся', !!me && me.angle <= 20, me ? `angle=${me.angle}` : 'игрока нет в списке')
  }

  // Независимая проверка того же факта: чужой клиент видит поворот тела
  // пакетами, а не с наших слов.
  const view = igrok.sees('NeuroDown')
  if (view) {
    const want = yawFromTo(view.pos, igrokPos)
    console.log(`  глазами игрока: NeuroDown yaw=${view.yaw}, надо ~${Math.round(want)}`)
    check('поворот виден со стороны', angleDiff(view.yaw, want) <= 30,
      `yaw=${view.yaw}, ожидалось ~${Math.round(want)}`)
  } else {
    check('поворот виден со стороны', false, 'игрок не видит NeuroDown')
  }
}

// ---------------------------------------------------------------- в

// Тот же подход, но во время длинного намерения. Рутина обязана сказать и
// обязана не вмешаться: ни отменить штрек, ни отвернуть голову от забоя.
async function sceneDuringIntent (igrok) {
  console.log('\n=== в. подошёл во время штрека ===')
  const lane = LANES.tunnel
  // east=2: забой должен начаться сразу, иначе бот половину штрека идёт по
  // воздуху комнаты и никуда не углубляется.
  await arena(lane, { east: 2 })
  await standAt(lane)
  await give(['minecraft:iron_pickaxe 1'])
  await tpIgrok(`${X0}.5`, Y, `${lane + PARK}.5`)
  await sleep(1500)

  const t0 = mark()
  const work = step('штрек на восток 12', 'tunnel', { direction: 'восток', length: 12, timeoutSeconds: 120 })
  await sleep(9000) // дать боту войти в породу

  const at = await where()
  console.log(`  бот в забое на x=${at.x}`)
  // Ставим игрока в уже прорубленный коридор за спиной у бота: там воздух и
  // два блока высоты, задохнуться негде.
  await tpIgrok(`${at.x - 2}.5`, Y, `${lane}.5`)
  await sleep(3000)

  const view = igrok.sees('NeuroDown')
  const r: any = await work
  const d = r.detail || {} as Record<string, any>
  // Считается после ответа намерения, а не до: именно этот ответ и привозит
  // накопленное — в том и вопрос, доедет ли событие, не сломав работу.
  const nearDuring = since(t0, 'player_near')

  console.log('  сказано:', JSON.stringify(since(t0).map(e => e.type)))
  check('о подходе сказали и посреди работы', nearDuring.length === 1,
    `${nearDuring.length} событий: ${JSON.stringify(nearDuring.map(e => e.dist))}`)
  check('намерение не сломалось', r.status === 'done', `${r.status}${r.by ? ' по ' + r.by.type : ''}`)
  check('штрек дошёл до конца', (d.walked ?? 0) >= 8 && !d.stopped,
    `walked=${d.walked}, stopped=${d.stopped || '-'}`)
  // Голова во время намерения принадлежит намерению: если бы рефлекс её
  // повернул, бот смотрел бы на запад, на игрока, а не в забой на восток.
  if (view) {
    console.log(`  глазами игрока во время работы: NeuroDown yaw=${view.yaw} (восток ≈ 270)`)
    check('голову от забоя не отвернул', angleDiff(view.yaw, 270) <= 60, `yaw=${view.yaw}`)
  } else {
    check('голову от забоя не отвернул', false, 'игрок не видит NeuroDown')
  }
}

// ---------------------------------------------------------------- г

// Чат и шёпот. Единственные два случая, когда игрок ОБЯЗАН прервать работу:
// это единственный способ его дозваться.
async function sceneChat (igrok) {
  console.log('\n=== г. написал в чат: намерение прервалось ===')
  const lane = LANES.chat
  await arena(lane, { east: 2 })
  await standAt(lane)
  await give(['minecraft:iron_pickaxe 1'])
  // Восемь блоков: дальше порога в шесть, чтобы в окне был только чат.
  await tpIgrok(`${X0}.5`, Y, `${lane + 8}.5`)
  await sleep(1500)

  const PHRASE = 'НейроДаун, бросай кирку и иди сюда: за углом скелет, и он не мой'
  const work = step('штрек на восток 12', 'tunnel', { direction: 'восток', length: 12, timeoutSeconds: 120 })
  await sleep(6000)
  await igrok.say(PHRASE)
  const r: any = await work

  check('намерение прервано', r.status === 'interrupted', r.status)
  check('прервано именно чатом', !!r.by && r.by.type === 'chat', r.by ? r.by.type : 'нет by')
  check('названо, кто говорил', !!r.by && r.by.from === 'Igrok', r.by ? String(r.by.from) : '-')
  check('текст доехал целиком', !!r.by && r.by.text === PHRASE, r.by ? `«${r.by.text}»` : '-')

  // Шёпот — та же дверь, но другой обработчик (session.js:158), и ломается он
  // отдельно.
  const SECRET = 'тихо: сундук за спиной, в нём три алмаза, никому не говори'
  const idle = step('ожидание 20с', 'wait', { seconds: 20 })
  await sleep(2500)
  await igrok.whisper('NeuroDown', SECRET)
  const w: any = await idle
  check('шёпот тоже прерывает', w.status === 'interrupted' && !!w.by && w.by.type === 'chat',
    `${w.status}${w.by ? '/' + w.by.type : ''}`)
  check('шёпот помечен шёпотом', !!w.by && w.by.whisper === true, w.by ? String(w.by.whisper) : '-')
  check('текст шёпота доехал целиком', !!w.by && w.by.text === SECRET, w.by ? `«${w.by.text}»` : '-')
}

// ---------------------------------------------------------------- д

// КОНТРОЛЬ. Уход — это одно событие на один уход, а не поток раз в секунду.
// Именно здесь ломается «рутина без гистерезиса»: порог, перейдённый один раз,
// проверяется каждый тик, и тело двадцать раз сообщает одно и то же.
async function sceneGone (igrok) {
  console.log('\n=== д. отошёл на 15 блоков: одно событие, а не поток ===')
  const lane = LANES.gone
  await arena(lane)
  await standAt(lane)
  await tpIgrok(`${X0}.5`, Y, `${lane + PARK}.5`)
  await sleep(1500)

  // Сперва подойти, иначе уходить будет некому.
  const t0 = mark()
  await tpIgrok(`${X0 + 3}.5`, Y, `${lane}.5`)
  await sleep(4000)
  await call('status') // забрать player_near из буфера, иначе счёт пустой
  const cameBack = since(t0, 'player_near').length
  check('подход перед уходом состоялся', cameBack === 1, `${cameBack} player_near`)

  // Окно наблюдения открывается ПОСЛЕ подхода: всё, что попадёт в него, —
  // следствие ухода и только его.
  const t1 = mark()
  await tpIgrok(`${X0}.5`, Y, `${lane + 15}.5`) // дальше порога забывания в 12
  console.log('  ... простой 18с: восемнадцать тиков автопилота на один уход')
  await sleep(18000)
  await call('status')

  const gone = since(t1, 'player_gone')
  console.log('  сказано:', JSON.stringify(since(t1).map(e => e.type)))
  console.log('  событие:', JSON.stringify(gone[0] || null))
  check('об уходе сказано', gone.length >= 1, JSON.stringify(gone))
  check('сказано РОВНО один раз, а не раз в секунду', gone.length === 1,
    `${gone.length} событий за 18с при пороге забывания в ${FAR} блоков`)
  check('названо имя', (gone[0] || {} as Record<string, any>).name === 'Igrok', String((gone[0] || {} as Record<string, any>).name))
  check('названо расстояние', Math.abs(((gone[0] || {} as Record<string, any>).dist ?? 0) - 15) <= 2,
    `dist=${(gone[0] || {} as Record<string, any>).dist}`)
  check('нового подхода не выдумано', since(t1, 'player_near').length === 0,
    JSON.stringify(since(t1, 'player_near')))

  // Забыл — не значит ослеп: на пятнадцати блоках игрок всё ещё виден, просто
  // это больше не новость. Разница между гистерезисом и радиусом обзора.
  const s = await seen()
  if (s) {
    const still = (s.players || []).find(p => p.name === 'Igrok')
    check('игрок всё ещё виден, просто это не новость', !!still && Math.abs(still.dist - 15) <= 2,
      still ? `dist=${still.dist}` : 'не видно вовсе')
  }
}

// ---------------------------------------------------------------- е

// Самое важное. Сервер общий, и владелец — тот, кто чаще всего подходит
// вплотную. Игрок, который нас ударил, не становится целью ни сам собой, ни по
// команде «бей ближайшего»: до правки combat.js findTarget возвращал его через
// liveAttacker, то есть «ближайший» означал «тот, кто меня трогал», а трогает
// нас обычно хозяин.
async function sceneHit (igrok) {
  console.log('\n=== е. игрок ударил: в ответ не бить ===')
  const lane = LANES.hit
  await arena(lane)
  await standAt(lane)
  await give([]) // кулаки: если ответный удар и случится, он будет дешёвым
  await tpIgrok(`${X0}.5`, Y, `${lane + PARK}.5`)
  await sleep(1500)
  await cmd('/gamemode survival Igrok')
  await tpIgrok(`${X0 + 1}.5`, Y, `${lane}.5`)
  await sleep(2500)

  const hpBefore = igrok.health
  const t0 = mark()
  let hit = null
  try {
    hit = await igrok.hit('NeuroDown')
    console.log('  удар:', JSON.stringify(hit))
  } catch (e) {
    console.log('  ударить не вышло:', e.message)
  }
  await sleep(5000)
  await call('status')

  const damage = since(t0, 'damage')
  check('удар вообще прошёл', damage.length >= 1,
    'нет события damage: проверь pvp=true в server.properties')
  check('здоровье игрока не тронуто сразу после удара', igrok.health === hpBefore,
    `${hpBefore} → ${igrok.health}`)

  // Две двери в бой, и обе должны быть закрыты. Первая: «бей ближайшего» — до
  // правки сюда приезжал liveAttacker, то есть тот же игрок.
  const auto: any = await step('бей ближайшего', 'fight', { target: 'ближайший' })
  check('«ближайший» игроком не оказался', auto.status === 'failed' && /не вижу цель/.test(auto.error || ''),
    `${auto.status}: ${auto.error || JSON.stringify(auto.detail)}`)
  // Память о том, кто ударил, при этом остаётся: отказ бить и амнезия — разные
  // вещи, и вторая мозгу вредна.
  check('но кто ударил — помнит', /Igrok/.test(auto.error || ''), auto.error || '-')

  // Вторая: по имени. Совпадение имени с игроком не должно давать цели.
  const byName: any = await step('бей Igrok', 'fight', { target: 'Igrok' })
  check('по имени игрока бить отказался', byName.status === 'failed',
    `${byName.status}: ${byName.error || JSON.stringify(byName.detail)}`)
  check('отказ объяснён словом «игрок», а не «не вижу»',
    /игрок/.test(byName.error || ''), byName.error || '-')

  // Третья, из того же гнезда: entity.name у игрока — буквально 'player'.
  const byType: any = await step('бей player', 'fight', { target: 'player' })
  check('слово player целью тоже не делает', byType.status === 'failed',
    `${byType.status}: ${byType.error || JSON.stringify(byType.detail)}`)

  await sleep(3000)
  check('игрок цел после всех трёх попыток', igrok.health === hpBefore,
    `${hpBefore} → ${igrok.health}`)
  const at = await where()
  console.log(`  бот стоит на ${at.x},${at.y},${at.z}; игрок на ${igrok.entity.position.x.toFixed(1)}`)
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  const igrokRef: Record<string, any> = { value: null }
  try {
    await call('connect')
    await sceneJoined(igrokRef)
    const igrok = igrokRef.value
    await sceneNear(igrok)
    await sceneDuringIntent(igrok)
    await sceneChat(igrok)
    await sceneGone(igrok)
    await sceneHit(igrok)

    await cmd('/kill @e[type=!player]')
    console.log(`\nитог: ${failures ? failures + ' проверок не прошло' : 'все проверки прошли'}`)
    if (failures) process.exitCode = 1
  } catch (e) {
    console.error('FAILED:', e.stack || e.message)
    process.exitCode = 1
  } finally {
    if (igrokRef.value) await igrokRef.value.leave().catch(() => {})
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })

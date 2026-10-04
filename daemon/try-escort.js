'use strict'
// Сопровождение, которому можно доверить тело.
//
// До этого файла было только `follow`: поставить GoalFollow и вернуться. Что из
// этого следует, видно прямо в библиотеке — GoalFollow.isValid спрашивает лишь
// «entity != null» (node_modules/mineflayer-pathfinder/lib/goals.js:363), а сам
// объект переживает выход игрока с сервера. То есть цель живёт дольше игрока, за
// которым её поставили, и тело идёт к его последнему месту, пока кто-нибудь не
// догадается позвать stop. Отставание при этом никто не мерит, голод никто не
// смотрит, лаву по дороге никто не видит.
//
// Сцена проверяет то, что снаружи невидимо, и каждый случай — про свой отказ:
//   1. игрок отошёл на 20 блоков по коридору — бот пришёл и встал в distance;
//   2. КОНТРОЛЬ: игрок стоит, 20 секунд сопровождения — бот не топчется по нему
//      и не тратит еду (это про «не делай второй реализации еды»: сытый бот не
//      ест ни через автопилот, ни через намерение);
//   3. игрок телепортировался на 60 блоков — честное «не догнать» с его
//      координатами, и ТЕЛО СТОИТ: координаты через 5 секунд те же. Это и есть
//      проверка уборки цели, ровно тот баг, который у нас уже был в craft —
//      намерение сказало «таймаут», а тело тем временем копало вниз;
//   4. лава поперёк коридора — сопровождение не идёт за игрока в огонь и
//      называет, где именно лава;
//   5. игрок вышел с сервера посреди дороги — честный отчёт, тело стоит;
//   6. игрока с таким ником нет вовсе — в ответе список тех, кто онлайн.
//
// ГРАБЛИ ИЗМЕРЕНИЯ (те же, что у try-tools):
// * шину событий выгребает ЛЮБОЙ ответ демона (session.js → immediate:
//   `result.events = this.bus.drain()`), а не только тот, который читают. Здесь
//   это особенно больно: `cmd('/tp ...')` летит ПОСРЕДИ работающего escort и
//   уносит с собой всё, что накопилось. Поэтому события копятся на транспорте, в
//   `heard`, и читаются оттуда.
// * escort блокирующий, поэтому телепорт игрока делается ПОСЛЕ старта вызова, но
//   промис не ждётся: демон обрабатывает каждое сообщение WebSocket отдельным
//   обработчиком (index.js:82), так что `say` во время `escort` проходит.
// * «тело стоит» проверяется координатами мира через 5 секунд, а не тем, что
//   ответ пришёл. Ответ приходит и у сломанной уборки — в этом весь баг.
//
// Арена на x=1400: чужие арены стоят по z -26..-4, 190..210, 300..329, 400..429,
// 600..630, 686..783 и на x=850 z=850..990; сосед делает x=1300, слух — x=1500.
// /fill работает только в прогруженных чанках и молча отказывается на объёмах
// больше 32768, поэтому бот сперва телепортируется в середину будущего коридора,
// и каждый объём мелкий.
//
//   node daemon/try-escort.js
//
// Нужен поднятый демон (start-all.ps1). Код выхода ненулевой, если хоть один
// случай пришёл [ПЛОХО].
const WebSocket = require('ws')

// Второй игрок в сцене — отдельный модуль, его пишет другой агент. Без него
// сцена не имеет смысла, и падать надо словами, а не стеком.
let joinAsPlayer
try {
  ({ joinAsPlayer } = require('./scene-player'))
} catch (err) {
  console.error('нет daemon/scene-player.js — вторым игроком сцену поднимать нечем.')
  console.error('нужен контракт: joinAsPlayer({username}) → {name, entity, say, whisper, hit, stare, leave}')
  console.error('подробность:', err.message)
  process.exit(1)
}

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

// Всё, что демон сказал за прогон. Собирается здесь, а не в месте проверки.
const heard = []
const mark = () => heard.length
const since = (n, type) => heard.slice(n).filter(e => !type || e.type === type)
const types = list => list.map(e => e.type)

ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.ok && m.result && Array.isArray(m.result.events)) heard.push(...m.result.events)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

function report (label, r) {
  const problem = r.status === 'failed' ? ` ← ${r.error}` : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`${label.padEnd(26)} ${String(r.status).padEnd(11)} ${JSON.stringify(r.detail ?? null)}${problem}`)
  if (r.by) console.log(`${''.padEnd(26)} прервано: ${r.by.type}`)
  return r
}

async function step (label, method, params) {
  const r = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  return report(label, r)
}

// ---------------------------------------------------------------- вердикты

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

// ---------------------------------------------------------------- арена

const X = 1400
const Y = 70
const LANES = {
  walk: 100,  // коридор 30: игрок отходит на 20
  idle: 140,  // короткий тупик: контроль «игрок стоит»
  far: 180,   // коридор 70: телепорт на 60
  lava: 300,  // коридор 20 с траншеей лавы поперёк
  leave: 340  // коридор 30: игрок выходит на ходу
}

const NICK = 'Igrok'

async function arena (lane, length) {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set day')
  await cmd('/difficulty normal')
  // В середину будущего коридора: /fill в непрогруженных чанках молча не работает.
  await cmd(`/tp @s ${X} ${Y + 2} ${lane + Math.floor(length / 2)}`)
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000)
  await cmd(`/fill ${X - 5} ${Y - 2} ${lane - 4} ${X + 5} ${Y + 6} ${lane + length + 4} minecraft:stone`)
  await cmd(`/fill ${X - 1} ${Y + 1} ${lane - 2} ${X + 1} ${Y + 3} ${lane + length + 2} minecraft:air`)
  await cmd(`/tp @s ${X}.5 ${Y + 1} ${lane}.5`)
  await sleep(2500)
}

// Еда в рюкзаке есть, сытость полная. Так «не поел» значит «решил не есть», а не
// «есть было нечего». Кирки нет намеренно: без неё Movements.canDig=false
// (session.js:93), и pathfinder не прокопает себе дорогу в обход препятствия —
// коридор остаётся коридором.
async function kit () {
  await cmd('/clear @s')
  await cmd(`/give @s minecraft:cooked_beef 16`)
  await cmd('/effect give @s minecraft:saturation 1 5 true')
  await sleep(1500)
}

async function put (lane, dz) {
  await cmd(`/tp ${NICK} ${X}.5 ${Y + 1} ${lane + dz}.5`)
  await sleep(1500)
}

async function where () {
  const r = await call('status')
  return (r.state && r.state.pos) || { x: 0, y: 0, z: 0 }
}

async function bag () {
  const r = await call('status')
  return (r.state && r.state.inventory) || {}
}

async function health () {
  const r = await call('status')
  return (r.state && r.state.health) || 0
}

const flat = (a, b) => Math.round(Math.hypot(a.x - b.x, a.z - b.z) * 10) / 10

// Тело стоит? Мерится миром: координаты сразу после ответа и через 5 секунд.
// Живая цель pathfinder'а за это время утащила бы бота блоков на двадцать.
async function stillFor (seconds = 5) {
  const before = await where()
  await sleep(seconds * 1000)
  const after = await where()
  return { before, after, moved: flat(before, after) }
}

// ---------------------------------------------------------------- 1

// Игрок отходит по коридору на 20 блоков. Телепорт идёт ПОСЛЕ старта escort:
// пока игрок рядом, догонять нечего, и «дошёл» ничего бы не значило.
async function sceneWalk (igrok) {
  console.log('\n=== 1. игрок отошёл на 20 блоков по коридору')
  const lane = LANES.walk
  await arena(lane, 30)
  await kit()
  await put(lane, 2)

  const run = call('escort', { player: NICK, distance: 3, forSeconds: 22 })
  await sleep(2000)
  await put(lane, 22)
  const r = report('escort 22с', await run)
  const d = r.detail || {}

  const me = await where()
  const him = igrok.entity ? igrok.entity.position : null
  const gapWorld = him ? flat(me, { x: him.x, z: him.z }) : null

  check('escort доработал до конца времени', r.status === 'done' && !d.stopped,
    `${r.status}${d.stopped ? ', встал: ' + d.stopped : ''}`)
  check('тело реально прошло дорогу', (d.walked || 0) >= 12, `прошло ${d.walked} бл.`)
  check('отставание посчитано', (d.lagged || 0) >= 1 && (d.maxGap || 0) >= 15,
    `отставал ${d.lagged} раз, макс. разрыв ${d.maxGap}`)
  check('на конец идём в пределах distance', (d.player && d.player.gap) <= 4.5,
    `разрыв ${d.player && d.player.gap} при distance ${d.distance}`)
  check('мир согласен: бот рядом с игроком', gapWorld !== null && gapWorld <= 4.5,
    `по миру ${gapWorld} бл. (бот ${me.x},${me.z}, игрок ${him ? Math.floor(him.x) + ',' + Math.floor(him.z) : '?'})`)
  check('не толкались', (d.closest ?? 0) >= 1, `ближе всего подходили на ${d.closest} бл.`)
}

// ---------------------------------------------------------------- 2

// КОНТРОЛЬ. Игрок стоит на месте — сопровождение обязано быть скучным: тело не
// сходит с места и не открывает рот. Еду проверяем и по счётчику намерения, и по
// рюкзаку: съеденный стейк из инвентаря не спрячешь.
async function sceneIdle () {
  console.log('\n=== 2. КОНТРОЛЬ: игрок стоит, 20 секунд сопровождения')
  const lane = LANES.idle
  await arena(lane, 10)
  await kit()
  await put(lane, 2)

  const t0 = mark()
  const before = await bag()
  const posBefore = await where()
  const r = await step('escort 20с на месте', 'escort', { player: NICK, distance: 3, forSeconds: 20 })
  const after = await bag()
  const posAfter = await where()
  const d = r.detail || {}
  const ate = since(t0, 'ate')

  check('escort доработал до конца времени', r.status === 'done' && !d.stopped,
    `${r.status}${d.stopped ? ', встал: ' + d.stopped : ''}`)
  check('тело не топталось', flat(posBefore, posAfter) <= 2 && (d.walked || 0) <= 3,
    `по миру ${flat(posBefore, posAfter)} бл., по отчёту ${d.walked}`)
  check('не встал игроку на голову', (d.closest ?? 0) >= 1, `ближе всего ${d.closest} бл.`)
  check('еду не тратил', d.meals === 0 && ate.length === 0,
    `meals=${d.meals}, событий ate: ${ate.length} (${types(since(t0)).join(',') || 'тишина'})`)
  check('стейк на месте', (after.cooked_beef || 0) === (before.cooked_beef || 0),
    `было ${before.cooked_beef}, стало ${after.cooked_beef}`)
}

// ---------------------------------------------------------------- 3

// Телепорт на 60 блоков и главная проверка файла: цель pathfinder'а убрана.
async function sceneFar () {
  console.log('\n=== 3. игрок телепортировался на 60 блоков')
  const lane = LANES.far
  await arena(lane, 70)
  await kit()
  await put(lane, 3)

  const run = call('escort', { player: NICK, distance: 3, forSeconds: 30 })
  await sleep(2500)
  await put(lane, 63)
  const r = report('escort 30с', await run)
  const d = r.detail || {}
  const still = await stillFor(5)

  check('ответ пришёл сам, до конца времени', r.status === 'done' && !!d.stopped,
    `${r.status}, встал: ${d.stopped}`)
  check('причина честная — не догнать', /не догнать/.test(d.stopped || ''), d.stopped)
  check('в ответе последние координаты игрока',
    !!(d.player && d.player.at) && Math.abs(d.player.at.z - (lane + 63)) <= 3,
    JSON.stringify(d.player))
  check('в подсказке те же координаты, а не «поищи сам»',
    (d.note || '').includes(String(lane + 63)), d.note)
  check('ТЕЛО СТОИТ через 5с после ответа', still.moved <= 1.5,
    `${JSON.stringify(still.before)} → ${JSON.stringify(still.after)}, ушло ${still.moved} бл.`)
  check('тело стоит там же, где отчиталось', flat(d.at || { x: 0, z: 0 }, still.after) <= 2,
    `отчёт: ${JSON.stringify(d.at)}, мир: ${JSON.stringify(still.after)}`)
}

// ---------------------------------------------------------------- 4

// Лава поперёк коридора. Траншея на два блока в глубину источниками — они не
// текут, так что арена одинаковая от прогона к прогону.
async function sceneLava () {
  console.log('\n=== 4. лава поперёк коридора')
  const lane = LANES.lava
  await arena(lane, 20)
  await kit()
  await cmd(`/fill ${X - 1} ${Y - 1} ${lane + 6} ${X + 1} ${Y} ${lane + 7} minecraft:lava`)
  await sleep(1500)
  await put(lane, 12)

  const before = await where()
  const r = await step('escort через лаву', 'escort', { player: NICK, distance: 3, forSeconds: 25 })
  const after = await where()
  const hp = await health()
  const d = r.detail || {}

  check('встал сам, не по таймауту', r.status === 'done' && !!d.stopped, `${r.status}, ${d.stopped}`)
  check('причина названа лавой', /лава/.test(d.stopped || ''), d.stopped)
  check('сказано, где именно лава', (d.stopped || '').includes(`${X},${Y},${lane + 6}`), d.stopped)
  check('в подсказке сказано, что делать',
    /mc_goto|mc_say/.test(d.note || ''), d.note)
  check('в огонь не пошёл', flat(before, after) <= 3 && hp === 20,
    `сдвинулся на ${flat(before, after)} бл., здоровье ${hp}`)
}

// ---------------------------------------------------------------- 5

// Игрок выходит с сервера посреди дороги. Сначала он отходит, чтобы тело точно
// было В ДВИЖЕНИИ: «тело стоит» у стоящего тела ничего не доказывает.
async function sceneLeave (igrok) {
  console.log('\n=== 5. игрок вышел с сервера посреди сопровождения')
  const lane = LANES.leave
  await arena(lane, 30)
  await kit()
  await put(lane, 2)

  const t0 = mark()
  const run = call('escort', { player: NICK, distance: 3, forSeconds: 30 })
  await sleep(1500)
  await put(lane, 25)
  await sleep(2500) // тело уже идёт
  await igrok.leave()
  const r = report('escort 30с', await run)
  const d = r.detail || {}
  const still = await stillFor(5)

  check('ответ пришёл сам, до конца времени', r.status === 'done' && !!d.stopped,
    `${r.status}, встал: ${d.stopped}`)
  check('причина честная — вышел с сервера', /вышел с сервера/.test(d.stopped || ''), d.stopped)
  check('в отчёте он больше не онлайн', d.player && d.player.online === false, JSON.stringify(d.player))
  check('сказано, где он был в последний раз',
    !!(d.player && d.player.at) && (d.note || '').includes(String(d.player.at.z)), d.note)
  check('тело успело пойти за ним до выхода', (d.walked || 0) >= 4, `прошло ${d.walked} бл.`)
  check('ТЕЛО СТОИТ через 5с после ответа', still.moved <= 1.5,
    `${JSON.stringify(still.before)} → ${JSON.stringify(still.after)}, ушло ${still.moved} бл.`)
  check('событие player_left доехало', since(t0, 'player_left').length >= 1,
    types(since(t0)).join(',') || 'тишина')
}

// ---------------------------------------------------------------- 6

// Ника нет на сервере вовсе. Ответ не должен быть «не вижу игрока»: из него не
// следует ничего — ни что ник неверный, ни что игрок вышел.
async function sceneUnknown (online) {
  console.log('\n=== 6. такого игрока нет')
  const r = await step('escort к призраку', 'escort', { player: 'NetTakogo', forSeconds: 10 })
  const d = r.detail || {}
  check('ответил сразу, не потратил время', r.status === 'done' && d.seconds === 0,
    `${r.status}, ${d.seconds}с`)
  check('сказано, что его нет', /не на сервере/.test(d.stopped || ''), d.stopped)
  check('перечислено, кто онлайн',
    Array.isArray(d.onlineNow) && (!online.length || d.onlineNow.includes(online[0])),
    JSON.stringify(d.onlineNow))
  check('в подсказке сказано, что делать', /ник|player_joined/.test(d.note || ''), d.note)
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  let igrok = null
  try {
    await call('connect')

    // Метода может не быть: диффы для session.js и index.js применяет человек.
    // Падать здесь надо словами, а не шестью красными случаями подряд.
    const probe = await call('escort', { player: 'ProbeNikto', forSeconds: 5 })
      .catch(e => ({ rpcError: e.message }))
    if (probe.rpcError) {
      console.error('демон не знает escort:', probe.rpcError)
      console.error('примени диффы к daemon/src/session.js и daemon/src/index.js и перезапусти демон')
      process.exitCode = 1
      return
    }

    igrok = await joinAsPlayer({ username: NICK })
    await sleep(2000)
    const st = await call('status')
    const online = (st.state && st.state.playersOnline) || []
    console.log(`онлайн: ${online.join(', ') || 'никого'}`)
    if (!online.includes(NICK)) {
      console.error(`${NICK} не виден демону — сцена без второго игрока бессмысленна`)
      process.exitCode = 1
      return
    }

    await sceneUnknown(online)
    await sceneWalk(igrok)
    await sceneIdle()
    await sceneFar()
    await sceneLava()
    await sceneLeave(igrok) // последним: после него игрока на сервере нет
    igrok = null

    await call('stop')
    await cmd('/kill @e[type=!player]')
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

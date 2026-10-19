'use strict'
import * as gameClock from '../../src/game-clock'
// Удушье: единственная смерть, которая не оставляет следов.
//
// Поход за алмазами 2026-08-31 кончился строкой в логе сервера — «NeuroDown
// suffocated in a wall». Гравий обвалился в штреке, тело оказалось внутри
// блока, и дальше всё — прерванный штрек, крафт каменной кирки, две попытки
// подъёма — происходило с головой в камне. Ни моба, ни события «меня завалило»,
// просто двенадцать тиков урона подряд и hp 0.
//
// Причина была в одной строке `autopilot.js → freeIfBuried`:
//
//     const busy = this.session.current && this.session.current.name !== 'wait'
//     if (busy || this.freeing) return
//
// Рутина, которая откапывает тело, была выключена, пока идёт намерение. А
// задыхается бот ровно тогда, когда работает, — он же и копает.
//
// Признак, по которому теперь можно вмешиваться посреди намерения: голова в
// твёрдом блоке И здоровье падает. Ни один законный случай не даёт пары.
// Намерения, которые кладут блок близко к голове, кладут его на feet+2
// (потолок убежища; towerUp вообще отказывается прыгать в потолок), а не на
// уровень глаз, и ни одно из них не стоит здоровья. Поэтому здесь четыре
// сцены на срабатывание и одна — контрольная, на НЕсрабатывание: если рутина
// начнёт вскрывать убежище, ночь станет смертельной, и это будет хуже
// исходной болезни.
//
// Грабли измерения — те же, что в try-tools, и по тем же причинам:
// события собираются на транспорте (любой ответ демона дренит шину), а то, что
// ВКЛЮЧАЕТ проверяемое поведение, подаётся после mark().
//
// /fill не работает в непрогруженных чанках и молча отказывается делать больше
// 32768 блоков, поэтому сначала /tp, потом мелкие объёмы. /clear @s первым
// делом: в полный рюкзак /give роняет предмет на землю.
import WebSocket = require('ws')

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
const since = (n, type?: any) => heard.slice(n).filter(e => !type || e.type === type)
// Окно с двумя концами. Там, где сцена сама вмешивается в мир после замера,
// «всё, что сказано с начала» уже включает ответ демона на это вмешательство.
const between = (a, b, type?: any) => heard.slice(a, b).filter(e => !type || e.type === type)
const types = list => list.map(e => e.type)

ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.ok && m.result && Array.isArray(m.result.events)) heard.push(...m.result.events)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

const sleep = ms => gameClock.sleep(ms)

// Ждать, не переставая слушать. Шина хранит последние 60 событий (events.js
// MAX_BUFFER) и выгребается ЛЮБЫМ ответом демона, поэтому окно ожидания без
// единого RPC — это окно, из которого события могут молча выпасть, а окно,
// кончающееся раньше самих событий, их просто не увидит. status —
// immediate-операция (session.js), она ничего не отменяет и только забирает
// накопленное.
async function settle (ms, every = 2000) {
  const until = gameClock.now() + ms
  while (gameClock.now() < until) {
    await sleep(Math.min(every, until - gameClock.now()))
    await call('status').catch(() => null)
  }
}

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

async function step (label, method, params) {
  const r: any = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const problem = r.status === 'failed' ? ` ← ${r.error}` : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`${label.padEnd(26)} ${String(r.status).padEnd(11)} ${JSON.stringify(r.detail ?? null)}${problem}`)
  return r
}

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

// ---------------------------------------------------------------- арена

// Далеко от арен всех прочих прогонов (-26..-4, 190..210, 300..329, 400..429,
// 600..630, 686..783, 850..970).
const X0 = 1050
const LANES = { idle: 1050, busy: 1080, gravel: 1110, shelter: 1140, notool: 1170 }
const Y = 40
const Y_DEEP = -40

async function arena (lane, y, material) {
  await call('stop')
  await sleep(800)
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set day')
  await cmd('/difficulty normal')
  await cmd(`/tp @s ${X0} ${y + 1} ${lane}`)
  await sleep(3000) // чанки
  // Мобов гасим ЗДЕСЬ, а не до /tp: @e выбирает только прогруженные чанки
  // (та же грабля, что с /fill в шапке), то есть kill до телепорта чистил арену,
  // из которой мы уходим, а не ту, в которую идём. В прогоне 2026-08-31 в штреке
  // так завёлся крипер (behindRock в ответе tunnel), а в пятой сцене бот умер.
  await cmd('/kill @e[type=!player]')
  await cmd(`/fill ${X0 - 8} ${y - 3} ${lane - 6} ${X0 + 30} ${y + 8} ${lane + 6} minecraft:${material}`)
  await cmd(`/fill ${X0 - 4} ${y} ${lane - 4} ${X0 + 4} ${y + 3} ${lane + 4} minecraft:air`)
  await cmd('/effect give @s minecraft:saturation 1 5 true')
}

async function give (gives) {
  await cmd('/clear @s')
  for (const g of gives) await cmd(`/give @s ${g}`)
  await sleep(1500)
}

async function standAt (lane, y) {
  // И ещё раз перед самим замером: между arena() и ним проходит give() с
  // полдюжины команд, а голого и безоружного бота хватит одного зомби,
  // чтобы столкнуть его с клетки, в которую целится /setblock.
  await cmd('/kill @e[type=!player]')
  await cmd(`/tp @s ${X0}.5 ${y} ${lane}.5`)
  await sleep(2500)
}

async function state () {
  const r: any = await call('status')
  return r.state || {} as Record<string, any>
}

// Замуровать тело там, где оно сейчас. Координаты в шапке состояния — floor,
// а не round (perception.js → round), то есть ровно те, что понимает /setblock.
//
// С проверкой попадания. Один /setblock по позиции, прочитанной секунду назад, —
// это замер завала, которого не было: тело успевает сойти с клетки (штрек
// шагнул вперёд, моб толкнул), блок ложится ему в спину, и сцена потом ищет
// событие, которому неоткуда взяться. Попаданием считается то, что после
// установки бот стоит в той же клетке, куда мы целились.
async function burnyHead (block = 'stone', tries = 4) {
  let p = null
  for (let i = 0; i < tries; i++) {
    p = (await state()).pos
    await cmd(`/setblock ${p.x} ${p.y + 1} ${p.z} minecraft:${block}`)
    const now = (await state()).pos
    if (now.x === p.x && now.y === p.y && now.z === p.z) return p
    console.log(`  промах: целился в ${p.x},${p.y + 1},${p.z}, тело уже на ${now.x},${now.y},${now.z}`)
  }
  return p
}

// ---------------------------------------------------------------- 1

// Простой. Так рутина работала и раньше — сцена нужна, чтобы починка занятого
// тела не сломала уже работавший случай.
async function sceneIdle () {
  console.log('\n=== 1. замурован в простое ===')
  const lane = LANES.idle
  await arena(lane, Y, 'stone')
  await give(['minecraft:iron_pickaxe 1', 'minecraft:cooked_beef 8'])
  await standAt(lane, Y)

  const t0 = mark()
  const at = await burnyHead('stone')
  console.log(`  замуровал голову на ${at.x},${at.y + 1},${at.z}`)
  await settle(12000)
  const s = await state()

  console.log('  сказано:', JSON.stringify(types(since(t0))))
  check('заметил завал', since(t0, 'buried').length >= 1, JSON.stringify(since(t0, 'buried')))
  const out = since(t0, 'freed')
  check('откопался', out.length >= 1, JSON.stringify(out))
  check('откопался сам, а не «рассосалось»', out.length >= 1 && out[0].byItself === false,
    JSON.stringify(out[0]))
  check('не сообщил о провале', since(t0, 'still_buried').length === 0,
    JSON.stringify(since(t0, 'still_buried')))
  check('жив и почти цел', s.health >= 15, `hp=${s.health}`)
}

// ---------------------------------------------------------------- 2

// То, на чём умер поход. Штрек запускается и НЕ ожидается, тело замуровывается
// посреди намерения. status и say — immediate-операции (session.js), они не
// отменяют текущее намерение, поэтому сцена может и смотреть, и ставить блоки,
// пока бот копает.
//
// Дипслейт и y=-40 — та же порода и та же глубина, что в погибшем прогоне:
// он ломается вдвое дольше камня, и окно, в которое надо попасть блоком,
// соответственно шире.
async function sceneBusy () {
  console.log('\n=== 2. замурован посреди штрека ===')
  const lane = LANES.busy
  await arena(lane, Y_DEEP, 'deepslate')
  await give(['minecraft:iron_pickaxe 1', 'minecraft:torch 16', 'minecraft:cooked_beef 8'])
  await standAt(lane, Y_DEEP)

  const t0 = mark()
  const running = call('tunnel', { direction: 'east', length: 24, timeoutSeconds: 120 })
    .catch(e => ({ status: 'RPC', error: e.message }))
  await sleep(6000) // дать штреку отойти от устья

  // Завал идёт за телом. Три одиночных /setblock мерили завал, которого не
  // было: в прогоне 2026-08-31 все три легли в одну клетку 1056,-39,1080, штрек
  // прошёл все 24 блока и не заметил ничего — тело ушло вперёд раньше, чем
  // блок лёг. Автопилот тикает раз в секунду и ищет пару «голова в камне И hp
  // падает», то есть завал обязан прожить хотя бы один тик. Замуровываем
  // заново, пока тревога не поднимется или попытки не кончатся.
  const walls = []
  for (let i = 0; i < 10 && !since(t0, 'buried').length; i++) {
    const at = await burnyHead('deepslate', 1)
    walls.push(`${at.x},${at.y + 1},${at.z}`)
    await sleep(300)
  }
  console.log(`  замуровывал голову ${walls.length} раз: ${[...new Set(walls)].join(' ')}`)

  const r: any = await running
  console.log(`  штрек: ${r.status} ${JSON.stringify(r.detail ?? r.error ?? null)}`)
  // Окно измерения кончалось раньше события, которое ищет. Снять тревогу
  // может только тик автопилота, а он раз в секунду и сам длится секунды; к
  // тому же рутина теперь отбирает рот у намерения, и штрек отвечает «прервано» ровно
  // в тот момент, когда спасение только началось. Ждём его конца.
  await settle(8000)
  const s = await state()

  const buried = since(t0, 'buried')
  console.log('  сказано:', JSON.stringify(types(since(t0))))
  check('бот жив', (s.health || 0) > 0, `hp=${s.health}`)
  check('смерти не было', since(t0, 'death').length === 0, JSON.stringify(since(t0, 'death')))
  check('заметил завал посреди намерения', buried.length >= 1, JSON.stringify(buried))
  check('в событии названо, что шло намерение',
    buried.length >= 1 && buried[0].during === 'tunnel',
    JSON.stringify(buried[0]))
  // Тревога обязана быть снята тем, кто её поднял, даже если клетку освободил
  // сам штрек: byItself:true — это законный исход, а молчание — нет.
  const out = since(t0, 'freed')
  check('тревога закрыта', out.length >= 1, JSON.stringify(out))
  check('на каждое buried по одному freed', out.length === buried.length,
    `buried=${buried.length} freed=${out.length}`)
  if (out.length) console.log(`  закрыто ${out[0].byItself ? 'само (штрек выкопал)' : 'рутиной'}`)
}

// ---------------------------------------------------------------- 3

// Гравий сыплется обратно в клетку, которую только что освободили. Один взмах
// тут не спасение: колонка из трёх блоков требует трёх, и предел в четыре
// попытки взят именно под этот случай.
async function sceneGravel () {
  console.log('\n=== 3. гравий сыплется повторно ===')
  const lane = LANES.gravel
  await arena(lane, Y, 'stone')
  await give(['minecraft:iron_pickaxe 1', 'minecraft:cooked_beef 8'])
  await standAt(lane, Y)

  const t0 = mark()
  const s0 = await state()
  const p = s0.pos
  // Снизу вверх: три гравия друг на друге, нижний — на уровне глаз. Каждый
  // выкопанный роняет следующий на своё место.
  for (const dy of [1, 2, 3]) {
    await cmd(`/setblock ${p.x} ${p.y + dy} ${p.z} minecraft:gravel`)
  }
  console.log(`  колонка гравия на ${p.x},${p.y + 1}..${p.y + 3},${p.z}`)
  await settle(20000)
  const s = await state()

  const freed = since(t0, 'freed')
  const working = since(t0, 'digging_out')
  const locked = since(t0, 'still_buried')
  console.log('  сказано:', JSON.stringify(types(since(t0))))
  check('заметил завал', since(t0, 'buried').length >= 1, JSON.stringify(since(t0, 'buried')))
  check('откопался', freed.length >= 1, JSON.stringify(freed))
  // Счётчик взмахов теперь накопительный — один на весь завал, а не на проход, и
  // его несёт любое из трёх событий. Сцена смотрела только на два из них и читала
  // попассовое число как итоговое — оттуда и бралось «в рюкзаке два гравия, а
  // взмахов ноль»: оба числа верны, они мерили разное.
  const swings = Math.max(...[0, ...working.map(e => e.dug), ...freed.map(e => e.dug), ...locked.map(e => e.dug)])
  check('копал больше одного раза', swings >= 2,
    `взмахов ${swings}: digging_out=${JSON.stringify(working)} freed=${JSON.stringify(freed)}`)
  // Рюкзак — второе, независимое измерение того же числа. Расхождение значит,
  // что сломана отчётность, а не копка, и это должно быть отдельной строкой.
  check('счётчик взмахов сошёлся с рюкзаком', swings >= ((s.inventory || {} as Record<string, any>).gravel || 0),
    `события: ${swings}, в рюкзаке: ${(s.inventory || {} as Record<string, any>).gravel || 0}`)
  // Главное этой сцены: выгребающийся бот не должен выглядеть как запертый.
  check('не назвал себя запертым, пока выгребался', since(t0, 'still_buried').length === 0,
    JSON.stringify(since(t0, 'still_buried')))
  check('жив', (s.health || 0) > 0, `hp=${s.health}`)
  check('гравий в рюкзаке — значит копал именно его', (s.inventory || {} as Record<string, any>).gravel >= 1,
    JSON.stringify(s.inventory))
}

// ---------------------------------------------------------------- 4

// Контроль, и он важнее остальных. mc_shelter закрывает за собой потолок; если
// рутина примет его за завал и разломает, ночь станет смертельной. Потолок
// убежища ложится на feet+2, а проверка смотрит на уровень глаз (feet+1.2) —
// то есть срабатывать не должно вовсе, и ни одного события быть не должно.
async function sceneShelter () {
  console.log('\n=== 4. контроль: убежище не вскрывать ===')
  const lane = LANES.shelter
  await arena(lane, Y, 'stone')
  await give([
    'minecraft:iron_pickaxe 1',
    'minecraft:cobblestone 64',
    'minecraft:torch 16',
    'minecraft:cooked_beef 8'
  ])
  await standAt(lane, Y)

  const t0 = mark()
  const r: any = await step('убежище', 'shelter', { mode: 'enter', depth: 2, torch: true })
  const inside = await state()
  console.log(`  ... простой 25с под потолком`)
  await settle(25000)
  const after = await state()

  console.log('  сказано:', JSON.stringify(types(since(t0))))
  check('убежище построено', r.status === 'done', JSON.stringify(r.detail ?? r.error))
  check('рутина не тронула потолок', since(t0, 'buried').length === 0,
    JSON.stringify(since(t0, 'buried')))
  check('и ничего не откапывала', since(t0, 'freed').length === 0,
    JSON.stringify(since(t0, 'freed')))
  check('и не пыталась', since(t0, 'digging_out').length === 0,
    JSON.stringify(since(t0, 'digging_out')))
  check('бот остался на той же глубине', after.pos.y === inside.pos.y,
    `${inside.pos.y} -> ${after.pos.y}`)
  check('жив и цел', after.health >= 19, `hp=${after.health}`)
}

// ---------------------------------------------------------------- 5

// Откопаться нечем. Раньше событие `buried` уходило ДО попытки и никогда не
// поправлялось: провалившееся спасение приезжало мозгу как сообщение о том,
// что всё уже сделано. Ровно та дыра, что была у no_tool.
//
// Бот тут честно задыхается, поэтому окно короткое и в конце его выпускают
// руками.
async function sceneNoTool () {
  console.log('\n=== 5. завалило, а копать нечем ===')
  const lane = LANES.notool
  await arena(lane, Y, 'stone')
  await give(['minecraft:cooked_beef 8']) // ни кирки, ничего
  await standAt(lane, Y)

  const t0 = mark()
  const at = await burnyHead('stone')
  await settle(7000)
  const s = await state()
  // Окно замера закрывается ЗДЕСЬ, до освобождения. Дальше сцена сама снимает
  // блок и лечит бота — и рутина законно закрывает тревогу через `freed byItself`,
  // потому что голова действительно освободилась, только не её усилиями.
  // Проверка «не соврал, что откопался» смотрела на всю шину целиком и ловила
  // это спасение как враньё: /setblock и /effect идут через say, а любой ответ
  // демона дренит шину (шапка файла), так что событие успевало приехать до самих
  // проверок. Измерено: в том freed стояло health:20, а 20 хп у замурованного без
  // кирки бота после семи секунд удушья берутся ровно из instant_health ниже.
  const t1 = mark()
  // Выпустить, пока жив: сцена проверяет отчёт, а не гибель.
  await cmd(`/setblock ${at.x} ${at.y + 1} ${at.z} minecraft:air`)
  await cmd('/effect give @s minecraft:instant_health 1 5 true')
  await settle(3000)

  const said = between(t0, t1, 'still_buried')
  console.log('  сказано в завале:', JSON.stringify(types(between(t0, t1))))
  console.log('  сказано после освобождения:', JSON.stringify(types(since(t1))))
  check('заметил завал', between(t0, t1, 'buried').length >= 1,
    JSON.stringify(between(t0, t1, 'buried')))
  check('сказал, что откопаться не вышло', said.length >= 1, JSON.stringify(said))
  check('в причине названа кирка',
    said.length >= 1 && /кирк/i.test(said[0].why || ''), JSON.stringify(said[0]))
  check('в отчёте о запертости ноль взмахов', said.length >= 1 && said[0].dug === 0,
    JSON.stringify(said[0]))
  // Пока голова в камне — ни одного слова об успехе. Именно это и проверялось;
  // спасение чужими руками после окна к этому вопросу отношения не имеет.
  check('не соврал, что откопался', between(t0, t1, 'freed').length === 0,
    JSON.stringify(between(t0, t1, 'freed')))
  check('и не соврал, что выгребается', between(t0, t1, 'digging_out').length === 0,
    JSON.stringify(between(t0, t1, 'digging_out')))
  check('сказал один раз, а не раз в секунду', said.length === 1,
    `${said.length} сообщений за 7с`)
  // А после освобождения тревога обязана быть снята, и именно как byItself:
  // рутина не вынула ни одного блока, завал разобрали за неё. Раньше этот
  // законный исход сцена считала враньём — теперь она его требует.
  const out = since(t1, 'freed')
  check('после освобождения тревога закрыта', out.length >= 1, JSON.stringify(out))
  check('и закрыта честно: завал разобрали не мы',
    out.length >= 1 && out[0].byItself === true && out[0].dug === 0, JSON.stringify(out[0]))
  // Смерть — отдельной строкой, и она главнее всего остального здесь.
  // hp в шапке после возрождения равно 20, то есть старая проверка
  // «бот дожил» горела зелёным ровно тогда, когда бот умирал: измерено
  // 2026-08-31, hp=20 при death в том же окне.
  const died = between(t0, t1, 'death')
  check('смерти не было', died.length === 0, JSON.stringify(died))
  check('бот дожил до отчёта', died.length === 0 && (s.health || 0) > 0, `hp=${s.health}`)
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  try {
    await call('connect')
    await sceneIdle()
    await sceneBusy()
    await sceneGravel()
    await sceneShelter()
    await sceneNoTool()

    await cmd('/kill @e[type=!player]')
    console.log(`\nитог: ${failures ? failures + ' проверок не прошло' : 'все проверки прошли'}`)
    if (failures) process.exitCode = 1
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })

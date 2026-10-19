'use strict'
import * as gameClock from '../../src/game-clock'
// Верстак — расходник, который обязан возвращаться, и четыре доски, которые
// нельзя трогать.
//
// Поход 2026-08-31 кончился так: бот дошёл до y=-59, нашёл алмазы, выжил на 20
// хп и не поднялся домой. Два независимых промаха, оба про одно и то же дерево.
//   1. Первый крафт каменной кирки поставил верстак и БРОСИЛ его. Через сорок
//      блоков штреков кирка снова кончилась — и «сделать stone_pickaxe» ответил
//      «нужен верстак, а его нет ни рядом, ни в инвентаре». Верстак стоял в
//      сорока блоках позади.
//   2. Досок в рюкзаке было 16, на верстак нужно 4, а мозг дважды попросил
//      «палки, count 4». bot.craft повторяет рецепт count РАЗ (node_modules/
//      mineflayer/lib/plugins/craft.js: `for (let i = 0; i < count; i++)`), то
//      есть 8 досок за вызов: все 16 досок уехали в 32 палки, из которых нужны
//      были две.
//
// Отсюда проверки: (а) верстак после крафта в РЮКЗАКЕ, а не на земле; (б) второй
// крафт в двадцати блоках не тащит тело обратно; (в) КОНТРОЛЬ — чужой верстак,
// который бот не ставил, остаётся стоять (на общем сервере это чужое имущество);
// (г) резерв в 4 доски не трогается, а отказ говорит, что делать; (д) второй
// крафт не медленнее первого больше чем на 15 секунд.
//
// ЧЕМ ЛОМАЕТСЯ ВЕРСТАК. minecraft-data 1.21.11: crafting_table — hardness 2.5,
// material mineable/axe, drops [332] (сам себя) и БЕЗ harvestTools. Значит
// ломается чем угодно и всегда даёт предмет: голыми руками 3.75с, топором ~1с.
// Голыми руками — намеренно: удар инструментом снимает единицу прочности с
// ЛЮБОГО инструмента в руке, а ударов кирки нам как раз и не хватило на дорогу
// домой.
//
// ГРАБЛИ ИЗМЕРЕНИЯ (те же, что в try-tools, и наступать на них снова не надо):
// * Любой ответ демона выгребает шину (`this.bus.drain()`), поэтому события
//   копятся здесь, в `heard`, а не читаются вторым вызовом status.
// * Материал выдаётся ПОСЛЕ отметки: автопилот решает раз в секунду и успел бы
//   сделать всё до начала наблюдения. Здесь он вдобавок заглушен целой киркой и
//   целым мечом — toolPlan при таком рюкзаке возвращает null и рутина молчит.
// * Проверяется факт мира: координаты тела, рюкзак и блок на клетке (observe с
//   fair:false — сцена измеряет, а не играет), а не время и не отсутствие
//   ошибки. Время меряется только там, где оно и есть предмет проверки (д), и
//   меряется по кругу RPC мозга, а не по событию автопилота: у автопилота свой
//   такт в 15 секунд, и он один съедает весь допуск.
// * /clear @s первым делом (в полный рюкзак /give роняет предмет на землю),
//   /fill только после /tp в район — в непрогруженных чанках он молча ничего
//   не делает.
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
  return r
}

// Крафт с секундомером: (д) меряет именно круг RPC мозга.
async function timedCraft (label, params) {
  const t = gameClock.now()
  const r: any = await step(label, 'craft', params)
  r.ms = gameClock.now() - t
  console.log(`${''.padEnd(28)} ${r.ms}мс`)
  return r
}

// ---------------------------------------------------------------- вердикты

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

// ---------------------------------------------------------------- арена

// x=1600 — своя полоса. Заняты чужими прогонами: z -26..-4, 190..210, 300..329,
// 400..429, 600..630, 686..783; x=850 z=850..990; x=1300, 1400, 1500.
const X0 = 1600
const LANES = {
  back: 1000, // (а) первый крафт на глубине: верстак обязан вернуться
  far: 1030, // (б,д) второй крафт в 20 блоках, позади стоит чужой стол
  guest: 1060, // (в) КОНТРОЛЬ: чужой верстак рядом — не трогать
  wood: 1090 // (г) резерв в 4 доски
}
const Y = -40

// Целая кирка и целый меч: при таком рюкзаке toolPlan возвращает null, автопилот
// не крафтит и не ставит своих верстаков. Сцена меряет мозг, а не рутину.
const QUIET = ['minecraft:iron_pickaxe 1', 'minecraft:iron_sword 1', 'minecraft:torch 16']

async function arena (lane, { long = false }: any = {} as Record<string, any>) {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set day')
  await cmd(`/tp @s ${X0}.5 ${Y} ${lane}.5`)
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000) // чанки: без этого /fill молча не сработает
  const east = long ? X0 + 30 : X0 + 8
  await cmd(`/fill ${X0 - 6} ${Y - 3} ${lane - 6} ${east} ${Y + 6} ${lane + 6} minecraft:deepslate`)
  await cmd(`/fill ${X0 - 2} ${Y} ${lane - 2} ${long ? X0 + 26 : X0 + 4} ${Y + 2} ${lane + 2} minecraft:air`)
  // Голод не должен вмешиваться: сытый бот не запускает eatIfHungry.
  await cmd('/effect give @s minecraft:saturation 1 5 true')
}

async function give (gives) {
  await cmd('/clear @s')
  await giveMore(gives)
}

async function giveMore (gives) {
  for (const g of gives) await cmd(`/give @s ${g}`)
  await sleep(1500) // инвентарь долетает до клиента отдельным пакетом
}

async function standAt (lane, x = X0) {
  await cmd(`/tp @s ${x}.5 ${Y} ${lane}.5`)
  await sleep(2500)
}

async function snapshot () {
  const r: any = await call('status')
  return (r.state && r.state.inventory) || {} as Record<string, any>
}

async function where () {
  const r: any = await call('status')
  return (r.state && r.state.pos) || { x: 0, y: 0, z: 0 }
}

// Что реально стоит в мире. fair:false намеренно: это измерительный прибор, а
// не глаза бота — верстак за спиной честному взгляду не виден.
async function tablesAround (radius = 24) {
  const r: any = await call('observe', { radius, fair: false })
  const blocks = (r.detail && r.detail.blocks) || []
  return blocks.filter(b => b.name === 'crafting_table')
}

const flat = (a, b) => Math.round(Math.hypot(a.x - b.x, a.z - b.z))
const num = (inv, name) => inv[name] || 0

// ---------------------------------------------------------------- 1 (а)

// Ровно ситуация первого крафта из похода: глубина, дипслейт, досок 16, верстака
// нет ни в мире, ни в рюкзаке. Верстак придётся сделать из досок и поставить —
// и вот он-то и обязан уехать с телом.
async function sceneReturns () {
  console.log('\n=== 1. (а) крафт с постановкой стола: верстак обязан вернуться ===')
  const lane = LANES.back
  await arena(lane)
  await give(QUIET.concat([
    'minecraft:cobbled_deepslate 64',
    'minecraft:oak_planks 16',
    'minecraft:stick 8'
  ]))
  await standAt(lane)

  const t0 = mark()
  const before = await snapshot()
  const from = await where()
  const r: any = await timedCraft('мозг: stone_pickaxe', { item: 'stone_pickaxe', count: 1 })
  const inv = await snapshot()
  const at = await where()
  const tables = await tablesAround(10)
  console.log('  рюкзак:', JSON.stringify(inv))
  console.log('  верстаки в мире:', JSON.stringify(tables))

  check('кирка сделана', r.status === 'done' && num(inv, 'stone_pickaxe') >= 1,
    `${r.status}, stone_pickaxe=${num(inv, 'stone_pickaxe')}`)
  check('крафт шёл через верстак', !!(r.detail && r.detail.usedTable), JSON.stringify(r.detail))
  check('верстак лежит в рюкзаке', num(inv, 'crafting_table') >= 1,
    `crafting_table=${num(inv, 'crafting_table')}`)
  check('демон сам говорит, что забрал его', !!(r.detail && r.detail.tableBack === true),
    JSON.stringify(r.detail))
  check('на земле верстака не осталось', tables.length === 0, JSON.stringify(tables))
  check('на верстак ушли ровно 4 доски',
    num(inv, 'oak_planks') === num(before, 'oak_planks') - 4,
    `было ${num(before, 'oak_planks')}, стало ${num(inv, 'oak_planks')}`)
  check('тело осталось на месте', flat(from, at) <= 3, `прошло ${flat(from, at)} блоков`)
  check('автопилот в это не лез', since(t0, 'tool').length === 0,
    JSON.stringify(since(t0).map(e => e.type)))
  return r.ms
}

// ---------------------------------------------------------------- 2 (б, д)

// Второй крафт из другого места — та самая пара, где первый занял 3.3с, а второй
// 28.9с. Позади намеренно оставлен ЧУЖОЙ верстак (/setblock, бот его не ставил):
// это ровно та приманка, на которую ensureTable уходил в pathfinder с
// разрешённой копкой и уводил тело на одиннадцать уровней вниз.
//
// Главная проверка здесь — не время, а перемещение: время шумит, а «ушло тело к
// старому столу или нет» имеет однозначный ответ. Время проверяется отдельно и
// по кругу RPC, без такта автопилота внутри.
async function sceneTwice () {
  console.log('\n=== 2. (б,д) второй крафт в 20 блоках от чужого стола ===')
  const lane = LANES.far
  await arena(lane, { long: true })
  await give(QUIET.concat([
    'minecraft:cobbled_deepslate 64',
    'minecraft:oak_planks 16',
    'minecraft:stick 8'
  ]))
  await standAt(lane)

  const first: any = await timedCraft('крафт №1 (на месте)', { item: 'stone_pickaxe', count: 1 })
  const invFirst = await snapshot()
  check('первая кирка сделана', first.status === 'done' && num(invFirst, 'stone_pickaxe') >= 1,
    `${first.status}, ${JSON.stringify(invFirst)}`)
  check('верстак уехал с телом', num(invFirst, 'crafting_table') >= 1,
    `crafting_table=${num(invFirst, 'crafting_table')}`)

  // Приманка: чужой стол на месте первого крафта. Ставится ПОСЛЕ телепорта —
  // клетка X0,Y,lane это ровно та, в которой стоит тело, и /setblock в неё
  // замуровал бы бота вместо того, чтобы разложить приманку.
  await standAt(lane, X0 + 20)
  await cmd(`/setblock ${X0} ${Y} ${lane} minecraft:crafting_table`)
  await sleep(1200)
  const from = await where()
  const second: any = await timedCraft('крафт №2 (в 20 блоках)', { item: 'stone_pickaxe', count: 1 })
  const inv = await snapshot()
  const at = await where()
  const walked = flat(from, at)
  const tables = await tablesAround(30)
  console.log('  рюкзак:', JSON.stringify(inv))
  console.log('  верстаки в мире:', JSON.stringify(tables))

  check('вторая кирка сделана', second.status === 'done' && num(inv, 'stone_pickaxe') >= 2,
    `${second.status}, stone_pickaxe=${num(inv, 'stone_pickaxe')}`)
  check('тело не ушло к старому столу', walked <= 3,
    `прошло ${walked} блоков; чужой стол в 20 блоках позади`)
  check('свой верстак снова в рюкзаке', num(inv, 'crafting_table') >= 1,
    `crafting_table=${num(inv, 'crafting_table')}`)
  check('второй раз доски не тратились',
    num(inv, 'oak_planks') === num(invFirst, 'oak_planks'),
    `было ${num(invFirst, 'oak_planks')}, стало ${num(inv, 'oak_planks')}`)
  // count, а не только length: observe группирует блоки по имени, и «один
  // верстак» от «двух верстаков» отличается именно счётчиком внутри группы.
  check('чужой стол остался стоять, и он там один',
    tables.length === 1 && tables[0].count === 1 && tables[0].nearest && tables[0].nearest.x === X0,
    JSON.stringify(tables))
  check('(д) второй крафт не медленнее первого больше чем на 15с',
    second.ms - first.ms <= 15000, `первый ${first.ms}мс, второй ${second.ms}мс`)
  // Прямой зонд на болезнь: 20 секунд — это ровно один windowOpen, которого не
  // дождались (mineflayer promise_utils.js: once(..., timeout = 20000)).
  check('(д) каждый крафт уложился в 25с', first.ms <= 25000 && second.ms <= 25000,
    `первый ${first.ms}мс, второй ${second.ms}мс`)
}

// ---------------------------------------------------------------- 3 (в)

// КОНТРОЛЬ. Верстак рядом, но бот его не ставил — на общем сервере это чужое
// имущество, и «я его поставил» отличается от «он тут стоял» только нашей
// собственной памятью о постановке. Ломать нельзя, пользоваться можно.
async function sceneGuest () {
  console.log('\n=== 3. (в) КОНТРОЛЬ: чужой верстак рядом — остаётся стоять ===')
  const lane = LANES.guest
  await arena(lane)
  await give(QUIET.concat([
    'minecraft:cobbled_deepslate 64',
    'minecraft:stick 8'
  ])) // досок нет вовсе: свой верстак сделать не из чего, только чужой
  await standAt(lane)
  await cmd(`/setblock ${X0 + 2} ${Y} ${lane} minecraft:crafting_table`)
  await sleep(1200)

  const beforeTables = await tablesAround(10)
  check('чужой стол в мире появился', beforeTables.length === 1, JSON.stringify(beforeTables))

  const r: any = await timedCraft('мозг: stone_pickaxe', { item: 'stone_pickaxe', count: 1 })
  const inv = await snapshot()
  const tables = await tablesAround(10)
  console.log('  рюкзак:', JSON.stringify(inv))
  console.log('  верстаки в мире:', JSON.stringify(tables))

  check('кирка сделана на чужом столе', r.status === 'done' && num(inv, 'stone_pickaxe') >= 1,
    `${r.status}, ${JSON.stringify(r.detail)}`)
  check('чужой верстак остался стоять, и он там один',
    tables.length === 1 && tables[0].count === 1 && tables[0].nearest && tables[0].nearest.x === X0 + 2,
    JSON.stringify(tables))
  check('чужой верстак не уехал в рюкзаке', num(inv, 'crafting_table') === 0,
    `crafting_table=${num(inv, 'crafting_table')}`)
  check('в ответе нет разговора про возврат стола', !(r.detail && 'tableBack' in r.detail),
    JSON.stringify(r.detail))
}

// ---------------------------------------------------------------- 4 (г)

// Резерв. Досок ровно 4 — это ровно один верстак и ноль палок. Правильный ответ
// не «сделал 8 палок», а отказ, который говорит, что делать дальше.
async function sceneReserve () {
  console.log('\n=== 4. (г) четыре доски — неприкосновенный запас ===')
  const lane = LANES.wood
  await arena(lane)
  await give(QUIET.concat(['minecraft:cobbled_deepslate 64', 'minecraft:oak_planks 4']))
  await standAt(lane)

  const r1: any = await step('палки при 4 досках', 'craft', { item: 'stick', count: 4 })
  const inv1 = await snapshot()
  check('отказ, а не тихая трата', r1.status === 'failed', `${r1.status}`)
  check('доски целы', num(inv1, 'oak_planks') === 4 && num(inv1, 'stick') === 0,
    JSON.stringify(inv1))
  check('в отказе назван верстак', /верстак/.test(r1.error || ''), r1.error)
  check('в отказе сказано, что делать',
    /бревн|crafting_table/.test(r1.error || ''), r1.error)

  // Частичное выполнение: досок 6, просят 16 палок. Резерв держим, остальное
  // отдаём — и говорим, сколько и почему.
  await giveMore(['minecraft:oak_planks 2'])
  const r2: any = await step('16 палок при 6 досках', 'craft', { item: 'stick', count: 16 })
  const inv2 = await snapshot()
  check('сделал сколько влезло, а не отказался',
    r2.status === 'done' && r2.detail && r2.detail.count === 4 && r2.detail.asked === 16,
    JSON.stringify(r2.detail))
  check('резерв после частичного крафта цел', num(inv2, 'oak_planks') === 4,
    JSON.stringify(inv2))
  check('сказано по-русски, почему меньше',
    !!(r2.detail && /верстак/.test(r2.detail.note || '')), JSON.stringify(r2.detail))

  // Сам верстак резервом не блокируется — иначе резерв запрещал бы ровно то,
  // ради чего он держится.
  const r3: any = await step('сам верстак из тех же 4 досок', 'craft', { item: 'crafting_table', count: 1 })
  const inv3 = await snapshot()
  check('верстак сделан', r3.status === 'done' && num(inv3, 'crafting_table') === 1,
    `${r3.status}, ${JSON.stringify(inv3)}`)

  // И обратный ход: с верстаком в рюкзаке доски снова свободны.
  await giveMore(['minecraft:oak_planks 2'])
  const r4: any = await step('палки с верстаком в рюкзаке', 'craft', { item: 'stick', count: 4 })
  const inv4 = await snapshot()
  // Палки считаются приростом: четыре штуки уже лежат с частичного крафта выше.
  check('с верстаком в рюкзаке доски свободны',
    r4.status === 'done' && num(inv4, 'stick') === num(inv3, 'stick') + 4,
    `${r4.status}, было ${num(inv3, 'stick')}, стало ${num(inv4, 'stick')}`)

  // Резерв — правило, а не стена: тот, кто знает, что делает, говорит об этом
  // прямо. Проверяется отдельно, на чистом рюкзаке, чтобы не портить счёт выше.
  await give(QUIET.concat(['minecraft:oak_planks 4']))
  await standAt(lane)
  const r5: any = await step('палки с явным spendReserve', 'craft',
    { item: 'stick', count: 4, spendReserve: true })
  const inv5 = await snapshot()
  check('явное разрешение резерв снимает',
    r5.status === 'done' && num(inv5, 'stick') === 4 && num(inv5, 'oak_planks') === 2,
    `${r5.status}, ${JSON.stringify(inv5)}`)
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  try {
    await call('connect')
    await sceneReturns()
    await sceneTwice()
    await sceneGuest()
    await sceneReserve()

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

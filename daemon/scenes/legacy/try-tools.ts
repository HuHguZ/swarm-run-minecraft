'use strict'
import * as gameClock from '../../src/game-clock'
// Инструмент как расходник, проверенный против рюкзака, а не против ощущений.
//
// Прогон try-diamond довёл бота с y=82 до y=-58 живым и там замуровал: две
// железные кирки — это 500 использований, спуск съел 475, а в рюкзаке лежали
// 208 булыжника, 271 дипслейта, 16 досок и верстак. Игрок сделал бы каменную
// кирку за десять секунд. Бот вместо этого получил «для deepslate нужен
// инструмент (wooden_pickaxe / copper_pickaxe / stone_pickaxe /
// golden_pickaxe), а его нет» — перечисление тиров, из которого не следует ни
// что кирки нет вовсе, ни что она собирается из того, что уже в руках.
//
// Проверяются три вещи, и все три невидимы снаружи:
//   1. долгая раскопка останавливается ЗАРАНЕЕ, с запасом на дорогу назад, а
//      не ломается о факт «инструмента нет»;
//   2. автопилот сам чинит инструмент, пока мозг между ходами, и вслух говорит
//      и когда починил, и когда не берётся;
//   3. отказ называет вид инструмента, факт его отсутствия и то, из чего его
//      сделать.
//
// ГРАБЛИ ИЗМЕРЕНИЯ. Этот файл наступил на них трижды, все три — одна и та же
// ошибка: мерить после того, как проверяемое уже случилось.
//
// * Шину событий опустошает ЛЮБОЙ ответ демона (session.js → immediate:
//   `result.events = this.bus.drain()`), а не только тот, который читают. Два
//   status подряд — и события уехали в первый, а второй пришёл пустым. Лечится
//   не аккуратностью, а тем, что события собираются на транспорте: `heard`
//   ниже впитывает `events` из каждого ответа, включая ответы на /give.
// * Автопилот действует, как только в рюкзаке появилось чем. Если материал
//   выдан во время подготовки, починка случается ТАМ, и окно наблюдения видит
//   уже прибранный рюкзак и тишину — «меч сделан» проходит, «о мече сказано»
//   нет. Поэтому включающая выдача идёт ПОСЛЕ отметки `mark()`: до неё бот
//   физически не мог принять решение.
// * Измерять износ раскопкой можно только там, где рутине чинить нечем по
//   уставу, а не по расписанию. Отсюда случай 1: железные слитки — не расходник
//   рутины (FREE_TIERS — камень и дерево, то есть то, что бот накопал сам),
//   так что зонд не соревнуется с починкой за то же тело.
//
// Как и в try-tunnel: /clear @s первым делом (в полный рюкзак /give роняет
// предмет на землю), /fill только после /tp в район — в непрогруженных чанках
// он молча ничего не делает, и объёмы мелкие, потому что за 32768 блоков /fill
// тоже молча отказывается.
//
// Износ задаётся компонентом предмета: с 1.20.5 формат стека в командах — не
// NBT {Damage:190}, а компоненты [minecraft:damage=190]. prismarine-item читает
// именно componentMap.damage (node_modules/prismarine-item/index.js:369), так
// что bot.inventory видит ровно то, что выдала команда.
import WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

// Всё, что демон когда-либо сказал за прогон. Собирается здесь, а не в месте
// проверки: каждый ответ дренит шину, поэтому событие, приехавшее с ответом на
// /give, иначе теряется навсегда.
const heard = []
const mark = () => heard.length
const since = (n, type?: any) => heard.slice(n).filter(e => !type || e.type === type)
const types = list => list.map(e => e.type + (e.made ? ':' + e.made : ''))

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
  if (r.by) console.log(`${''.padEnd(26)} прервано: ${r.by.type}`)
  return r
}

// ---------------------------------------------------------------- вердикты

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

// ---------------------------------------------------------------- арена

// Далеко от арен всех остальных прогонов (-26..-4, 190..210, 300..329,
// 400..429, 600..630, 686..783), чтобы чужой мусор нельзя было принять за
// местность этого.
const X0 = 850
const LANES = {
  refuse: 850, // зонд: кирка почти стёрта, чинить рутине нечем
  craft: 870, // булыжник и доски: автопилот обязан сделать кирку
  deep: 890, // то же, но материал — дипслейт
  truth: 910, // глубина, кирки нет вовсе, в рюкзаке только дипслейт
  dig: 930, // сплошной камень: спуск обязан встать заранее
  idle: 950, // кирка целая — автопилот не должен трогать ничего
  sword: 970, // оружия нет вовсе
  twice: 990 // две кирки подряд из разных мест: крафт не должен ходить
}
const Y = 40
const Y_DEEP = -40

// Пауза, за которую автопилот обязан успеть: он думает раз в секунду, но
// решение по инструменту берёт не чаще раза в 15 секунд (та же частота, что у
// wearArmor). Крафт с постановкой верстака — ещё десяток. Три окна с запасом.
const IDLE_MS = 55000

async function arena (lane, y, material) {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set day')
  await cmd('/difficulty normal')
  await cmd(`/tp @s ${X0} ${y + 1} ${lane}`)
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000) // чанки: без этого /fill молча не сработает
  await cmd(`/fill ${X0 - 8} ${y - 3} ${lane - 8} ${X0 + 8} ${y + 6} ${lane + 8} minecraft:${material}`)
  await cmd(`/fill ${X0 - 4} ${y} ${lane - 4} ${X0 + 4} ${y + 2} ${lane + 4} minecraft:air`)
  // Голод не должен вмешиваться: сытый бот не запускает eatIfHungry, и
  // «инвентарь не изменился» остаётся честной проверкой.
  await cmd('/effect give @s minecraft:saturation 1 5 true')
}

// Полная замена рюкзака. В полный /give роняет предмет на землю, поэтому
// каждый прогон начинается с /clear.
async function give (gives) {
  await cmd('/clear @s')
  await giveMore(gives)
}

// Доложить в рюкзак, ничего не стирая. Так выдаётся то, что ВКЛЮЧАЕТ рутину, —
// после mark(), чтобы решение не могло быть принято до начала наблюдения.
async function giveMore (gives) {
  for (const g of gives) await cmd(`/give @s ${g}`)
  await sleep(1500) // инвентарь долетает до клиента отдельным пакетом
}

async function standAt (lane, y) {
  await cmd(`/tp @s ${X0}.5 ${y} ${lane}.5`)
  await sleep(2500)
}

// Рюкзак. События читаются не отсюда, а из `heard` — этот вызов нужен ещё и
// затем, чтобы дренуть буфер демона в коллектор после простоя.
async function snapshot () {
  const r: any = await call('status')
  return (r.state && r.state.inventory) || {} as Record<string, any>
}

async function where () {
  const r: any = await call('status')
  return (r.state && r.state.pos) || { x: 0, y: 0, z: 0 }
}

const flat = (a, b) => Math.round(Math.hypot(a.x - b.x, a.z - b.z))

// ---------------------------------------------------------------- 1

// Зонд износа, поставленный туда, где автопилот заведомо не вмешается: кирка
// почти стёрта, а из материалов только железные слитки. Рутина слитки не
// тратит намеренно, так что мерить можно сколько угодно. Заодно это
// единственное место, где проверяется сам этот раздел устава.
//
// Кирка выдаётся ПОСЛЕ mark(): пока её нет, положение дел другое (кирки нет
// вовсе, left=0), и разговор про left=5 не может состояться раньше отметки.
async function sceneRefuse () {
  console.log('\n=== 1. кирка почти стёрта, чинить рутине нечем: зонд износа ===')
  const lane = LANES.refuse
  await arena(lane, Y, 'stone')
  await give([
    'minecraft:iron_ingot 3', // на кирку хватает, но это не расходник рутины
    'minecraft:stick 2',
    'minecraft:iron_sword 1', // чтобы в игре была только кирка
    'minecraft:torch 16'
  ])
  await standAt(lane, Y)

  const t0 = mark()
  await giveMore(['minecraft:iron_pickaxe[minecraft:damage=245] 1']) // 5 ударов из 250

  const r: any = await step('зонд: лесенка 1', 'dig_down', { mode: 'stairs', depth: 1 })
  const d = r.detail || {} as Record<string, any>
  check('износ через компонент доехал', d.pickaxeLeft === 5, `pickaxeLeft=${d.pickaxeLeft}`)
  check('в ответе есть разбивка по киркам',
    Array.isArray(d.pickaxes) && d.pickaxes.length === 1 && d.pickaxes[0].left === 5,
    JSON.stringify(d.pickaxes))
  check('раскопка не сделала ни ступеньки', d.steps === 0, `steps=${d.steps}`)
  check('отказ говорит, что остановился заранее',
    !!d.stopped && /останавливаюсь заранее/.test(d.stopped), d.stopped)
  check('отказ называет, что скрафтить',
    !!d.stopped && /iron_pickaxe/.test(d.stopped), d.stopped)

  console.log(`  ... простой ${IDLE_MS / 1000}с, мозг не трогает тело`)
  await sleep(IDLE_MS)
  const inv = await snapshot()

  const said = since(t0, 'no_tool').filter(e => e.left === 5)
  console.log('  рюкзак:', JSON.stringify(inv))
  console.log('  сказано:', JSON.stringify(since(t0).map(e => e.type)))
  check('слитки не потрачены', inv.iron_ingot === 3, `iron_ingot=${inv.iron_ingot}`)
  check('вторую железную кирку не сделал', inv.iron_pickaxe === 1,
    `iron_pickaxe=${inv.iron_pickaxe}`)
  check('автопилот объяснил, почему не берётся', said.length >= 1,
    JSON.stringify(since(t0, 'no_tool')))
  check('объяснение названо словами, а не молчанием',
    said.length >= 1 && /сам не берусь/.test(said[0].why || ''), JSON.stringify(said[0]))
  check('сказал один раз, а не раз в секунду', said.length === 1,
    `${said.length} сообщений за ${IDLE_MS / 1000}с`)
}

// ---------------------------------------------------------------- 2

// Ровно ситуация из try-diamond, только на два уровня раньше: кирка почти
// стёрта, в рюкзаке булыжник, доски и верстак. Мозг между ходами не делает
// ничего — работать обязан автопилот. Зонда здесь нет специально: он бы
// соревновался с починкой за то же тело.
async function sceneCraft () {
  console.log('\n=== 2. кирка почти стёрта, есть булыжник и доски ===')
  const lane = LANES.craft
  await arena(lane, Y, 'stone')
  await give([
    'minecraft:iron_pickaxe[minecraft:damage=245] 1',
    'minecraft:iron_sword 1',
    'minecraft:torch 16'
  ])
  await standAt(lane, Y)

  const t0 = mark()
  await giveMore(['minecraft:cobblestone 64', 'minecraft:oak_planks 16', 'minecraft:crafting_table 1'])
  console.log(`  ... простой ${IDLE_MS / 1000}с, мозг не трогает тело`)
  await sleep(IDLE_MS)
  const inv = await snapshot()

  const made = since(t0, 'tool')
  console.log('  рюкзак:', JSON.stringify(inv))
  console.log('  сказано:', JSON.stringify(types(since(t0))))
  check('автопилот сам сделал каменную кирку', (inv.stone_pickaxe || 0) >= 1,
    `stone_pickaxe=${inv.stone_pickaxe || 0}`)
  check('о новой кирке сказано мозгу', made.length >= 1, JSON.stringify(made))
  check('в событии есть «было» и «стало»',
    made.length >= 1 && made[0].was === 5 && made[0].left > 100, JSON.stringify(made[0]))
  check('палки сделаны из досок, а не выдуманы', (inv.oak_planks || 0) < 16,
    `oak_planks=${inv.oak_planks || 0}`)
  check('булыжник потрачен на кирку', (inv.cobblestone || 0) === 61,
    `cobblestone=${inv.cobblestone}`)
}

// ---------------------------------------------------------------- 3

// Тот же случай, но материал только дипслейтовый и верстака нет — ровно то,
// чем полон рюкзак на глубине. minecraft-data 1.21.11 знает три каменных
// варианта рецепта (cobbled_deepslate / blackstone / cobblestone), как и
// ванильный тег #stone_tool_materials; в игре это подтвердилось. Проверка
// остаётся отдельной: если она вдруг провалится, значит данные разошлись с
// сервером, и это надо знать до следующего спуска, а не после.
async function sceneDeepslate () {
  console.log('\n=== 3. материал только cobbled_deepslate, верстака нет ===')
  const lane = LANES.deep
  await arena(lane, Y, 'stone')
  await give([
    'minecraft:iron_pickaxe[minecraft:damage=245] 1',
    'minecraft:iron_sword 1',
    'minecraft:torch 16'
  ])
  await standAt(lane, Y)

  const t0 = mark()
  await giveMore(['minecraft:cobbled_deepslate 64', 'minecraft:oak_planks 16']) // 4 на верстак + 2 на палки
  console.log(`  ... простой ${IDLE_MS / 1000}с`)
  await sleep(IDLE_MS)
  const inv = await snapshot()

  console.log('  рюкзак:', JSON.stringify(inv))
  console.log('  сказано:', JSON.stringify(types(since(t0))))
  check('кирка сделана из дипслейта', (inv.stone_pickaxe || 0) >= 1,
    `stone_pickaxe=${inv.stone_pickaxe || 0}; если ПЛОХО — cobbled_deepslate на сервере не тянет на каменный тир, чинить craftPlan`)
  check('верстак автопилот собрал сам', (inv.oak_planks || 0) <= 10,
    `oak_planks=${inv.oak_planks || 0}`)
  check('о новой кирке сказано мозгу', since(t0, 'tool').length >= 1,
    JSON.stringify(types(since(t0))))
}

// ---------------------------------------------------------------- 4

// Глубина, кирки нет вовсе, в рюкзаке только дипслейт и ни одной доски. Сделать
// нечего — и вот это как раз надо сказать вслух, а не молча пытаться.
//
// Отметка стоит до /clear: положение «кирки нет» создаётся именно им, а
// предыдущая сцена оставила бота с рабочей киркой, то есть с чистой памятью
// рутины (toolPlan вернул null и сбросил сказанное).
async function sceneTruth () {
  console.log('\n=== 4. кирки нет вовсе, в рюкзаке только дипслейт ===')
  const lane = LANES.truth
  await arena(lane, Y_DEEP, 'deepslate')

  const t0 = mark()
  await give(['minecraft:cobbled_deepslate 64', 'minecraft:torch 16'])
  await standAt(lane, Y_DEEP)

  // tunnel спрашивает про инструмент до первого взмаха и бросает — это самый
  // короткий путь к тексту missingHarvestTool.
  const t: any = await step('штрек east 8', 'tunnel', { direction: 'east', length: 8, timeoutSeconds: 60 })
  const msg = t.error || (t.detail && t.detail.stopped) || ''
  check('сказано, что кирки нет вовсе', /кирки .*нет вовсе/.test(msg), msg)
  check('названо, чего не хватает на кирку', /не хватает/.test(msg) && /stick/.test(msg), msg)
  check('старой формулировки «а его нет» больше нет', !/а его нет/.test(msg), msg)

  const r: any = await step('лесенка 8', 'dig_down', { mode: 'stairs', depth: 8 })
  const d = r.detail || {} as Record<string, any>
  check('спуск отказался, а не сломался о факт',
    !!d.stopped && /нет вовсе/.test(d.stopped), d.stopped)
  check('спуск честно говорит, что сделать не из чего',
    !!d.stopped && /сделать не из чего/.test(d.stopped), d.stopped)

  console.log(`  ... простой ${IDLE_MS / 1000}с`)
  await sleep(IDLE_MS)
  const inv = await snapshot()

  const said = since(t0, 'no_tool')
  console.log('  рюкзак:', JSON.stringify(inv))
  console.log('  сказано:', JSON.stringify(types(since(t0))))
  check('ничего не наколдовал из воздуха', !inv.stone_pickaxe && !inv.wooden_pickaxe,
    JSON.stringify(inv))
  check('автопилот сказал мозгу, что чинить нечем', said.length >= 1, JSON.stringify(said))
  check('в причине названы палки',
    said.length >= 1 && /stick/.test(said[0].why || ''), JSON.stringify(said[0]))
  check('сказал один раз, а не раз в секунду', said.length === 1,
    `${said.length} сообщений за всю сцену`)
}

// ---------------------------------------------------------------- 5

// Спуск в сплошном камне с киркой на 60 ударов. Порог — 40 ударов запаса плюс
// стоимость следующей ступеньки: замерено на try-diamond, лесенка на 40
// ступеней стоила 166 и 182 использования, то есть ~4 удара на уровень, три
// ячейки на ступеньку. Досок нет специально: автопилоту не из чего сделать
// новую кирку, и видно чистое поведение самой раскопки.
async function sceneStopEarly () {
  console.log('\n=== 5. кирка почти стёрта посреди dig_down ===')
  const lane = LANES.dig
  await arena(lane, Y, 'stone')
  // Спуск идёт на восток и вниз: под ареной нужен сплошной камень.
  await cmd(`/fill ${X0 - 4} ${Y - 26} ${lane - 4} ${X0 + 20} ${Y - 1} ${lane + 4} minecraft:stone`)
  await give([
    'minecraft:iron_pickaxe[minecraft:damage=190] 1', // 60 ударов из 250
    'minecraft:iron_sword 1',
    'minecraft:torch 32'
  ])
  await standAt(lane, Y)

  const r: any = await step('лесенка east 40', 'dig_down',
    { mode: 'stairs', direction: 'east', depth: 40, timeoutSeconds: 200 })
  const d = r.detail || {} as Record<string, any>
  check('спуск начался', (d.steps || 0) >= 1, `steps=${d.steps}`)
  check('спуск не дошёл до 40', (d.steps || 0) < 40, `steps=${d.steps}`)
  check('встал заранее, а не «нет инструмента»',
    !!d.stopped && /останавливаюсь заранее/.test(d.stopped), d.stopped)
  check('запас на дорогу назад цел', d.pickaxeLeft >= 40 && d.pickaxeLeft <= 50,
    `pickaxeLeft=${d.pickaxeLeft}`)
  check('разбивка показывает ту же одну кирку',
    Array.isArray(d.pickaxes) && d.pickaxes.length === 1 && d.pickaxes[0].left === d.pickaxeLeft,
    JSON.stringify(d.pickaxes))
  check('порог не съел весь спуск', (d.steps || 0) >= 3 && (d.steps || 0) <= 8,
    `steps=${d.steps} (ждём 4..6 при ~4 ударах на уровень)`)
  check('камень при этом добыт', (d.gained && (d.gained.cobblestone || 0) > 0),
    JSON.stringify(d.gained))
}

// ---------------------------------------------------------------- 6

// Обратный случай. Кирка целая, меч есть, материал есть — автопилот обязан не
// делать ничего. Рутина, которая срабатывает без повода, дороже рутины,
// которой нет: она тратит ресурсы и двигает тело, когда никто не смотрит.
async function sceneIdle () {
  console.log('\n=== 6. кирка целая: автопилот не трогает ничего ===')
  const lane = LANES.idle
  await arena(lane, Y, 'stone')
  await give([
    'minecraft:iron_pickaxe 1',
    'minecraft:iron_sword 1',
    'minecraft:cobblestone 64',
    'minecraft:oak_planks 16',
    'minecraft:stick 8',
    'minecraft:crafting_table 1',
    'minecraft:torch 16'
  ])
  await standAt(lane, Y)
  const before = await snapshot()
  const t0 = mark()
  console.log(`  ... простой ${IDLE_MS / 1000}с`)
  await sleep(IDLE_MS)
  const after = await snapshot()

  const noisy = since(t0).filter(e => e.type === 'tool' || e.type === 'no_tool')
  console.log('  было:', JSON.stringify(before))
  console.log('  стало:', JSON.stringify(after))
  console.log('  сказано:', JSON.stringify(types(since(t0))))
  check('ничего не скрафтил', !after.stone_pickaxe && !after.stone_sword,
    JSON.stringify(after))
  check('булыжник не тронут', after.cobblestone === before.cobblestone,
    `${before.cobblestone} -> ${after.cobblestone}`)
  check('доски не тронуты', after.oak_planks === before.oak_planks,
    `${before.oak_planks} -> ${after.oak_planks}`)
  check('верстак не поставлен', after.crafting_table === before.crafting_table,
    `${before.crafting_table} -> ${after.crafting_table}`)
  check('мозгу нечего сказать', noisy.length === 0, JSON.stringify(noisy))
}

// ---------------------------------------------------------------- 7

// Меч — вторая и последняя вещь в рутине. Спринт выключен, от зомби не убежать
// (README, три замера), так что пустые руки в штреке — это смерть. Лопата и
// топор в рутину не входят намеренно: земля, песок, гравий и дерево падают и
// голыми руками, то есть они покупают скорость за те же булыжник и палки,
// которые нужны кирке и мечу.
//
// Булыжник и палки выдаются после mark(): именно они включают рутину, и до
// этой секунды меч не мог быть сделан ни при каком раскладе тактов.
async function sceneWeapon () {
  console.log('\n=== 7. оружия нет вовсе: делается меч, но не лопата и не топор ===')
  const lane = LANES.sword
  await arena(lane, Y, 'stone')
  await give([
    'minecraft:iron_pickaxe 1', // кирка цела: очередь доходит до меча
    'minecraft:crafting_table 1',
    'minecraft:torch 16'
  ])
  await standAt(lane, Y)

  const t0 = mark()
  await giveMore(['minecraft:cobblestone 64', 'minecraft:stick 8'])
  console.log(`  ... простой ${IDLE_MS / 1000}с`)
  await sleep(IDLE_MS)
  const inv = await snapshot()

  const made = since(t0, 'tool').filter(e => e.kind === 'sword')
  console.log('  рюкзак:', JSON.stringify(inv))
  console.log('  сказано:', JSON.stringify(types(since(t0))))
  check('меч сделан', (inv.stone_sword || 0) >= 1, `stone_sword=${inv.stone_sword || 0}`)
  check('о мече сказано мозгу', made.length >= 1, JSON.stringify(types(since(t0))))
  check('в событии есть «было» и «стало»',
    made.length >= 1 && made[0].was === 0 && made[0].left === 131, JSON.stringify(made[0]))
  check('лопата не сделана', !inv.stone_shovel, JSON.stringify(inv))
  check('топор не сделан', !inv.stone_axe, JSON.stringify(inv))
  check('кирку не трогал', (inv.iron_pickaxe || 0) === 1 && !inv.stone_pickaxe,
    JSON.stringify(inv))
}


// ---------------------------------------------------------------- 8

// Крафт кирки дважды подряд из разных мест — то, на чём встал поход 2026-08-31.
// Первый крафт прошёл за секунды, второй словил таймаут в 60с, и бот оказался
// на одиннадцать уровней ниже, чем начинал подъём.
//
// Разница между первым и вторым — не в рюкзаке и не в глубине, а в том, что
// после первого в мире остался ВЕРСТАК. `actions.js → ensureTable` ищет стол в
// радиусе двадцати блоков и, если находит, идёт к нему `pathfinder.goto` — без
// таймаута, без onAbort и с движениями предыдущего интента (то есть с
// разрешённой копкой, потому что session.craft не зовёт updateMovements).
// Отсюда и минута, и одиннадцать уровней: интент вернул `timeout`, цель у
// pathfinder осталась, тело продолжило идти.
//
// Поэтому главная проверка здесь — НЕ время, а перемещение: время шумит на
// пятнадцатисекундном такте автопилота, а вот ушло тело к старому столу или
// осталось на месте — вопрос с однозначным ответом.
async function sceneTwice () {
  console.log('\n=== 8. две кирки подряд из разных мест ===')
  const lane = LANES.twice
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set day')
  await cmd(`/tp @s ${X0 + 6} ${Y_DEEP + 1} ${lane}`)
  await sleep(3000)
  // Коридор длиннее обычной каморки: второй крафт должен идти в двенадцати
  // блоках от первого стола — то есть внутри тех самых двадцати, в которых
  // ensureTable его найдёт и захочет к нему пойти.
  await cmd(`/fill ${X0 - 6} ${Y_DEEP - 3} ${lane - 4} ${X0 + 26} ${Y_DEEP + 6} ${lane + 4} minecraft:deepslate`)
  await cmd(`/fill ${X0 - 2} ${Y_DEEP} ${lane - 2} ${X0 + 22} ${Y_DEEP + 2} ${lane + 2} minecraft:air`)
  await cmd('/effect give @s minecraft:saturation 1 5 true')

  // Изношенная кирка выдаётся ПЕРВОЙ, а материал — после mark(). Наоборот было
  // бы бессмысленно: между /clear и выдачей кирки рюкзак выглядит как «кирки
  // нет вовсе, а булыжник есть», и автопилот выковал бы кирку ещё до начала
  // замера. Ровно те же грабли, что в случаях 1 и 7.
  const worn = [
    'minecraft:iron_pickaxe[minecraft:damage=245] 1',
    'minecraft:iron_sword 1',
    'minecraft:torch 16'
  ]
  const stock = ['minecraft:cobblestone 64', 'minecraft:oak_planks 32']

  // --- первая кирка, стола в мире ещё нет
  await give(worn)
  await standAt(lane, Y_DEEP)
  let t0 = mark()
  let began = gameClock.now()
  await giveMore(stock)
  const from1 = await where()
  await sleep(40000)
  let inv = await snapshot()
  const first = since(t0, 'tool')[0]
  const at1 = await where()
  const firstMs = first ? first.at - began : null
  console.log(`  первая: ${JSON.stringify(inv.stone_pickaxe || 0)} кирка за ${firstMs}мс, тело ${JSON.stringify(from1)} -> ${JSON.stringify(at1)}`)
  check('первая кирка сделана', (inv.stone_pickaxe || 0) >= 1, JSON.stringify(inv))
  check('первый крафт уложился в 40с', !!first, JSON.stringify(types(since(t0))))

  // --- вторая: тот же рюкзак, но в двенадцати блоках, и позади остался стол
  await cmd(`/tp @s ${at1.x + 12}.5 ${Y_DEEP} ${lane}.5`)
  await sleep(2500)
  await give(worn)
  t0 = mark()
  began = gameClock.now()
  await giveMore(stock)
  const from2 = await where()
  await sleep(40000)
  inv = await snapshot()
  const second = since(t0, 'tool')[0]
  const at2 = await where()
  const secondMs = second ? second.at - began : null
  const walked = flat(from2, at2)
  console.log(`  вторая: ${JSON.stringify(inv.stone_pickaxe || 0)} кирка за ${secondMs}мс, тело ${JSON.stringify(from2)} -> ${JSON.stringify(at2)} (${walked} бл.)`)

  check('вторая кирка сделана', (inv.stone_pickaxe || 0) >= 1, JSON.stringify(inv))
  check('второй крафт уложился в 40с', !!second, JSON.stringify(types(since(t0))))
  // Вот это и есть проверка на болезнь: к старому столу ходить нельзя.
  check('тело не ушло к старому столу', walked <= 3,
    `прошло ${walked} блоков; стол остался в 12 блоках позади`)
  check('второй крафт не медленнее первого более чем на 15с',
    firstMs !== null && secondMs !== null && secondMs - firstMs <= 15000,
    `первый ${firstMs}мс, второй ${secondMs}мс`)

  // --- и замер чужого пути: крафт по команде мозга в двенадцати блоках от стола.
  // Автопилот сюда не лезет — кирка целая, меч есть. Это измерение
  // session.craft + ensureTable, то есть ровно того, что словило таймаут.
  await give([
    'minecraft:iron_pickaxe 1',
    'minecraft:iron_sword 1',
    'minecraft:cobblestone 64',
    'minecraft:stick 8',
    'minecraft:torch 16'
  ])
  await cmd(`/tp @s ${at1.x + 12}.5 ${Y_DEEP} ${lane}.5`)
  await sleep(2500)
  const beforeBrain = await where()
  const t = gameClock.now()
  const r: any = await step('мозг: stone_pickaxe', 'craft', { item: 'stone_pickaxe', count: 1 })
  const brainMs = gameClock.now() - t
  const afterBrain = await where()
  const brainWalked = flat(beforeBrain, afterBrain)
  console.log(`  мозг: ${r.status} за ${brainMs}мс, тело прошло ${brainWalked} бл.`)
  check('крафт мозга уложился в отпущенные 60с', r.status === 'done',
    `${r.status} за ${brainMs}мс — если timeout, честный таймаут для session.craft считать отсюда`)
  check('крафт мозга не утащил тело', brainWalked <= 3,
    `прошло ${brainWalked} блоков: ensureTable ушёл к столу за ${flat(beforeBrain, at1)} бл.`)
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  try {
    await call('connect')
    await sceneRefuse()
    await sceneCraft()
    await sceneDeepslate()
    await sceneTruth()
    await sceneStopEarly()
    await sceneIdle()
    await sceneWeapon()
    await sceneTwice()

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

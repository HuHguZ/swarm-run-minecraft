'use strict'
import * as gameClock from '../../src/game-clock'
// Обмен вещами с живым человеком: отдать в руки и взять с земли.
//
// До этого файла у тела был только mc_drop: бросить стак под ноги там, где
// стоишь, и ответить «dropped: cobblestone, count: 8». Человека в этом ответе
// нет, дороги к нему нет, свидетеля того, что вещь кому-то доехала, нет, и
// границы «это не отдам» тоже нет — последнюю кирку mc_drop выбросит так же
// охотно, как лишний булыжник.
//
// ОТВЕТ ПРО БРОСОК (закрыт прогоном 2026-09-01, 4 броска на угол, азимут от
// известной телепортом точки против точного `at` сущности). Он РАЗДЕЛЬНЫЙ, и
// поэтому не давался пять кругов подряд: мы мерили два разных вопроса одним
// числом.
//   СТОРОНА — ПРИЦЕЛЬНАЯ. Из 12 бросков 7 имели годное угловое разрешение, и
//   все 7 легли в передней четверти. При равномерном разлёте это один шанс на
//   десять тысяч. Значит повернуться к человеку — не вежливость, а половина
//   дела.
//   ДАЛЬНОСТЬ — РАЗЛЁТ. Разброс ВНУТРИ одного наклона (до 1.2 бл.) оказался
//   больше разницы МЕЖДУ наклонами (0.9), то есть наклон дальность не решает, и
//   ничто другое из подвластного нам — тоже. Живые броски с одного места дали
//   от 0 до 2.8 блока.
// Отсюда: константы дальности не существует, калибровка в handover.js — не
// запасной путь, а механизм; стенд-офф 2 верен при обеих половинах ответа.
// Любопытная мелочь, на которой НЕ надо строить модель: в том прогоне все
// четыре броска в горизонт дали 0 смещения, а вниз — 0.4-1.2. Похоже, дело не в
// «косинусе наоборот», а в том, что горизонтальная составляющая мала и решает,
// куда предмет скатится, упав.
//
// Главный вопрос, на который пришлось ответить до кода: с какого расстояния
// брошенное долетает? Ответ — ни с какого, и это не про измерение. mineflayer
// бросает вещь кликом мимо окна инвентаря (bot.toss → transfer с
// destStart: -999, simple_inventory.js:29-40 → clickWindow, inventory.js:557-610),
// а в пакете window_click нет ни направления, ни цели. Куда ляжет стак, решают
// сервер и то, где стоит тело; наш yaw в этом не участвует. Поэтому «кинуть
// точнее» — не то, что можно написать, а «долетело» — не то, что можно
// объявить: это можно только проверить по миру. Единственный честный свидетель
// — пакет collect от сервера, mineflayer отдаёт его как playerCollect
// (entities.js:149-154).
//
// Отсюда и проверки: инвентарь ТЕСТОВОГО КЛИЕНТА, а не слова бота.
//   1. дать 8 стейков человеку в 5 блоках — у Igrok'а в рюкзаке стало на 8
//      больше (мерим его клиентом, не отчётом бота);
//   2. человек бросает стак булыжника ПОСЛЕ старта mc_take — бот дожидается
//      дропа окном и подбирает. Это ровно та дыра, на которой сегодня погорел
//      добор руды: collectNearbyDrops спрашивает мир один раз и выходит
//      (`if (!drop) break`, actions.js:41-42), а пакет спавна предмета приезжает
//      на тик-другой позже;
//   3. просят последнюю кирку — отказ с причиной, кирка остаётся на месте,
//      Igrok'у ничего не досталось; force=true тем же вызовом её отдаёт (иначе
//      «как перебить» в отказе — пустое обещание);
//   4. просят то, чего нет вовсе — отказ называет, что есть;
//   5. КОНТРОЛЬ: человек в 40 блоках — бот НЕ бросает ничего: рюкзак цел, тело
//      стоит на месте, на арене не появилось ни одного предмета на земле, а в
//      ответе сказано, сколько идти.
//
// ГРАБЛИ (оплачены сегодня, повторять не надо):
// * шину событий выгребает ЛЮБОЙ ответ демона (`result.events = this.bus.drain()`),
//   а не только тот, который читают, — поэтому события копятся на транспорте, в
//   `heard`, и читаются оттуда;
// * `/kill @e[type=!player]` видит только прогруженные чанки: чистить арену
//   можно только стоя в ней, иначе чистится та, из которой уходишь. Здесь это
//   особенно важно — сцена вся про предметы на земле, и чужой дроп с прошлого
//   случая превратит любую проверку в ложь;
// * координаты в командах через ПРОБЕЛ: `/setblock 1,2,3` молча не выполняется;
// * `/fill` молчит в непрогруженных чанках, поэтому бот сперва телепортируется
//   в середину будущего коридора, и каждый объём мелкий;
// * `/clear @s` первым делом, иначе «последняя кирка» окажется не последней.
//
// Арена на x=1900: чужие арены стоят на x=1300, 1400, 1500 и по z -26..-4,
// 190..210, 300..329, 400..429, 600..630, 686..783, x=850 z=850..990.
//
//   node dist/daemon/scenes/legacy/try-give.js
//
// Нужен поднятый демон (start-all.ps1) с применёнными диффами для
// daemon/src/session.js, daemon/src/index.js и mcp/src/index.js. Код выхода
// ненулевой, если хоть один случай пришёл [ПЛОХО].
import WebSocket = require('ws')

let joinAsPlayer
try {
  ({ joinAsPlayer } = (require('../lib/scene-player') as typeof import('../lib/scene-player')))
} catch (err) {
  console.error('нет daemon/scenes/lib/scene-player.js — вторым игроком сцену поднимать нечем.')
  console.error('подробность:', err.message)
  process.exit(1)
}

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

// Всё, что демон сказал за прогон. Собирается здесь, а не в месте проверки.
const heard = []
const mark = () => heard.length
const since = (n, type?: any) => heard.slice(n).filter(e => !type || e.type === type)
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

const X = 1900
const Y = 70
const LANES = {
  give: 100, // коридор 16: отдать еду
  take: 140, // коридор 16: взять брошенное
  line: 180, // коридор 16: граница — последняя кирка, force, «нет такого»
  far: 220 // коридор 50: контроль, человек в 40 блоках
}

const NICK = 'Igrok'

async function arena (lane, length) {
  ARENA = { lane, length }
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set day')
  // peaceful на всю сцену: в ней нет ни одного случая про мобов, а моб у арены
  // ломает и выдачу, и подбор. ВОЗВРАТ В NORMAL — в хвосте прогона (restoreServer):
  // сложность сервер помнит и после выхода, и оставленный peaceful уже стоил
  // соседней сцене двух кругов разбора поведения, которого не было — призванный
  // моб на peaceful исчезает следующим тиком, а /summon об этом молчит.
  await cmd('/difficulty peaceful')
  // В середину будущего коридора: /fill в непрогруженных чанках молча не работает.
  await cmd(`/tp @s ${X} ${Y + 2} ${lane + Math.floor(length / 2)}`)
  // @e видит только прогруженные чанки, поэтому чистить арену можно только
  // стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000)
  await cmd(`/fill ${X - 5} ${Y - 2} ${lane - 4} ${X + 5} ${Y + 6} ${lane + length + 4} minecraft:stone`)
  await cmd(`/fill ${X - 1} ${Y + 1} ${lane - 2} ${X + 1} ${Y + 3} ${lane + length + 2} minecraft:air`)
  await cmd(`/tp @s ${X}.5 ${Y + 1} ${lane}.5`)
  await sleep(2500)
  // Ещё раз, уже стоя в готовом коридоре: /fill мог выбить что-то из стен.
  await cmd('/kill @e[type=!player]')
  await sleep(1200)
}

// Предметы на земле в выдаче observe. Дроп приезжает как сущность с
// displayName 'Item' (minecraft-data 1.21.11: entitiesByName.item.displayName),
// kind 'other' — ни username, ни имени предмета в observe нет, поэтому ловим
// по обоим полям сразу.
const itemsOf = d => ((d && d.entities) || []).filter(e => /item/i.test(e.name || '') || /item/i.test(e.kind || ''))
const at = p => `${p.x},${p.y},${p.z}`

// Какая полоса сейчас построена. Нужна, чтобы отличать СВОЙ мусор от чужого:
// observe светит на 24 блока, а в этом мире рядом работают другие сцены — их
// дроп в 23 блоках и на 11 ниже пола нашей арены попадал в проверку «арена
// чистая» и красил её. Проверять надо свой ящик, а не окрестности.
let ARENA = { lane: 0, length: 0 }
const inArena = p => Math.abs(p.x - X) <= 6 && Math.abs(p.y - Y) <= 6 &&
  p.z >= ARENA.lane - 4 && p.z <= ARENA.lane + ARENA.length + 4
const showItems = list => list.map(e => `${e.name} на ${e.pos.x},${e.pos.y},${e.pos.z} (${e.dist} бл.)`).join('; ')

// Мир после постройки: что под ногами и что валяется на арене — С КООРДИНАТАМИ.
// Первый прогон в игре встал именно на этом: сцена сказала «на арене что-то
// лежит», а что и где — не сказала, и три версии происходящего оказались
// неразличимы. Факт печатается целиком, а не сводится к «пусто/непусто».
async function probeWorld (label, igrok = null) {
  const r: any = await call('observe', { radius: 24, fair: false })
  const d = r.detail || {} as Record<string, any>
  const all = itemsOf(d)
  const items = all.filter(e => inArena(e.pos))
  const alien = all.filter(e => !inArena(e.pos))
  const me = (r.state && r.state.pos) || null
  const him = igrok ? igrokAt(igrok) : null
  const ents = (d.entities || []).map(e => `${e.name}(${e.kind}) в ${e.dist}`)
  // Координаты обоих тел в КАЖДОМ снимке: без них «стак в 5.9 бл. от тела»
  // ничего не значит — непонятно, промахнулся бросок или бот стоял не там.
  console.log(`  мир [${label}]: тело ${me ? `${me.x},${me.y},${me.z}` : '?'}` +
    (him ? `, ${NICK} ${him.x},${him.y},${him.z}` : '') +
    `, под ногами ${d.terrain && d.terrain.standingOn}, рядом: ${ents.length ? ents.join(', ') : 'пусто'}`)
  if (items.length) console.log(`  мир [${label}] НА ЗЕМЛЕ: ${showItems(items)}`)
  if (alien.length) console.log(`  мир [${label}] чужое рядом (не наша арена, не считаем): ${showItems(alien)}`)
  return { items, alien, entities: d.entities || [], text: showItems(items), me, him }
}

// Всё, что сервер помнит между прогонами, вернуть как было. Арена заявляет свои
// предусловия целиком — значит и убирать за собой обязана целиком, иначе
// следующая сцена меряет мир, который настроил не её автор.
let restored = false
async function restoreServer () {
  if (restored) return
  restored = true
  await cmd('/difficulty normal')
  await cmd('/gamerule spawn_mobs true')
  await cmd('/gamerule advance_time true')
}

async function kit (lines) {
  await cmd('/clear @s')
  for (const line of lines) await cmd(line)
  await cmd('/effect give @s minecraft:saturation 1 5 true')
  await sleep(1500)
}

async function put (lane, dz) {
  await cmd(`/tp ${NICK} ${X}.5 ${Y + 1} ${lane + dz}.5`)
  await sleep(1500)
}

async function where () {
  const r: any = await call('status')
  return (r.state && r.state.pos) || { x: 0, y: 0, z: 0 }
}

async function bag () {
  const r: any = await call('status')
  return (r.state && r.state.inventory) || {} as Record<string, any>
}

const flat = (a, b) => Math.round(Math.hypot(a.x - b.x, a.z - b.z) * 10) / 10

// ------------------------------------------------- рюкзак тестового клиента

// Главное измерение всей сцены. Не «бот сказал, что бросил», а что реально
// лежит у человека: это его собственный клиент, отдельное соединение и
// отдельные пакеты инвентаря.
function bagOf (igrok, name) {
  try {
    return igrok.bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
  } catch {
    return 0
  }
}

// Весь рюкзак человека и где он стоит — для строки отчёта, а не для проверки:
// «было 0, стало 0» само по себе не говорит, доехало ли вообще что-нибудь.
function igrokBag (igrok) {
  try {
    const out: Record<string, any> = {} as Record<string, any>
    for (const i of igrok.bot.inventory.items()) out[i.name] = (out[i.name] || 0) + i.count
    return out
  } catch { return {} as Record<string, any> }
}

function igrokAt (igrok) {
  // igrok.entity — документированное поле ручки scene-player; bot.entity это то
  // же самое, но через сырой клиент, и оно нужно как запас.
  try {
    const p = (igrok.entity || igrok.bot.entity).position
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  } catch { return null }
}

// Пакеты инвентаря приезжают своим темпом, поэтому ждём числа, а не спим
// наугад; если не дождались — возвращаем то, что есть, и это и попадёт в отчёт.
async function untilBag (igrok, name, want, ms = 4000) {
  const deadline = gameClock.now() + ms
  while (gameClock.now() < deadline) {
    if (bagOf(igrok, name) >= want) break
    await sleep(200)
  }
  return bagOf(igrok, name)
}

// Бросок со стороны человека — обычный toss его собственного клиента.
async function igrokTosses (igrok, name, count) {
  const it = igrok.bot.inventory.items().find(i => i.name === name)
  if (!it) throw new Error(`у ${NICK} нет ${name} — /give не доехал`)
  await igrok.bot.toss(it.type, null, count)
  return { tossed: name, count }
}

// ---------------------------------------------------------------- 0

// ЗАМЕР, а не проверка поведения. Отвечает на два вопроса, без которых любой
// красный в этом файле неразличим: видно ли брошенное через observe вообще, и
// НА СКОЛЬКО БЛОКОВ его уносит. Второе — то самое число, которого нет ни в
// mineflayer, ни в minecraft-data: пакет броска (window_click со слотом -999)
// не содержит ни направления, ни силы, так что узнать это можно только у мира.
// Первый снимок мира, в котором на земле уже что-то лежит.
//
// Именно опрос, а не пауза. У брошенного предмета есть короткая
// неприкосновенность к тому, кто его бросил, а после неё тело поднимает свой же
// бросок обратно — ногами, само. Замер со сном на 2 секунды попадал ровно в
// этот промежуток и печатал «сущностей в 24 бл.: 0», из чего можно заключить
// что угодно, кроме правды: стейк к тому моменту лежал в рюкзаке.
// Раньше этого стак ещё не мог долететь: полёт занимает несколько тиков, а два
// одинаковых замера, снятых в первые миллисекунды, — это не «лёг», а «ещё не
// сдвинулся». Дешёвая страховка от той же ошибки с другой стороны.
const MIN_FLIGHT_MS = 500

async function untilDrop (ms) {
  const started = gameClock.now()
  const deadline = started + ms
  const trace = []
  let last = null
  let seen = null
  for (;;) {
    const r: any = await call('observe', { radius: 24, fair: false })
    const d = r.detail || {} as Record<string, any>
    const items = itemsOf(d).filter(e => inArena(e.pos))
    const now = items[0] || null
    if (now) {
      trace.push(`${gameClock.now() - deadline + ms}мс:${now.dist}`)
      // observe не отдаёт точных координат, но отдаёт dist с точностью 0.1 —
      // этого хватает, чтобы отличить летящий стак от лежащего, пока тело стоит
      // на месте. Остановился — два одинаковых замера подряд.
      if (last !== null && Math.abs(now.dist - last) < 0.05 && gameClock.now() - started >= MIN_FLIGHT_MS) {
        return { items, entities: d.entities || [], fair: d.fair, settled: true, trace }
      }
      last = now.dist
      seen = { items, entities: d.entities || [], fair: d.fair }
    }
    if (gameClock.now() >= deadline) {
      return seen
        ? { ...seen, settled: false, trace }
        : { items: [], entities: (r.detail || {} as Record<string, any>).entities || [], fair: (r.detail || {} as Record<string, any>).fair, settled: false, trace }
    }
    await sleep(150)
  }
}

// Наклон взгляда — параметр броска, а не деталь вежливости. Три замера подряд с
// разными углами: если версия верна, дальность падает вместе с наклоном.
const AIMS = [
  { name: 'в горизонт', dy: 0, dz: 20 },
  { name: 'вниз ~45', dy: -20, dz: 20 },
  { name: 'под ноги', dy: -3, dz: 1 }
]

// Сколько бросков на каждый угол. Одного мало: по одному замеру на угол нельзя
// отличить «дальность зависит от наклона» от «дальность гуляет сама по себе», а
// разница между этими двумя ответами — вся разница в устройстве передачи.
// Четыре даёт разброс внутри угла, с которым можно сравнить разницу между
// углами; больше — дороже по времени, а сцена и так гоняется целиком.
const SHOTS = 4

// Среднее, крайние и разброс. Разброс ВНУТРИ угла — то, с чем сравнивается
// разница МЕЖДУ углами: если он не меньше, зависимость от наклона недоказуема,
// чем бы ни выглядела таблица средних.
function stat (list) {
  const v = list.filter(x => typeof x === 'number')
  if (!v.length) return null
  const min = Math.min(...v)
  const max = Math.max(...v)
  const mean = Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10
  return { n: v.length, min, max, mean, spread: Math.round((max - min) * 10) / 10 }
}

async function sceneThrow () {
  console.log('\n=== 0. замер: от чего зависит дальность броска')
  const lane = LANES.give
  await arena(lane, 16)
  const rows = []

  for (const aim of AIMS) {
    await cmd('/kill @e[type=!player]')
    await kit(['/give @s minecraft:cooked_beef 16'])
    const clean = await probeWorld(`до серии, ${aim.name}`)
    if (clean.items.length) console.log(`  ВНИМАНИЕ: перед броском на земле уже лежит ${clean.text}`)

    // Наклон задаём точкой прицела и знаем его по построению: pitch = atan2(dy, dz).
    // Читать его из мира нечем — ни status, ни observe наклон не отдают.
    const pitch = Math.round(Math.atan2(aim.dy, aim.dz) * 180 / Math.PI)
    const shots = []

    for (let k = 1; k <= SHOTS; k++) {
      // Убрать предыдущий бросок: иначе следующий замер найдёт старый стак.
      await cmd('/kill @e[type=item]')
      // Ставим тело телепортом в ОДНУ И ТУ ЖЕ точку перед каждым броском. Две
      // причины, и вторая важнее: все броски сравниваются из одного места, и —
      // главное — координаты точки известны сцене ТОЧНО. Позицию тела ни status,
      // ни observe с десятыми не отдают (бота нет в списке сущностей), а разница
      // двух срезанных координат гуляет на блок; на броске в 1.2 блока это ±40°
      // угла, из-за чего замер стороны и был бесполезен.
      await cmd(`/tp @s ${X}.5 ${Y + 1} ${lane}.5`)
      await sleep(700)
      const origin = { x: X + 0.5, z: lane + 0.5 }
      const me = await where()
      // Тело могло снести физикой — тогда точка броска не та, что мы думаем.
      const drift = Math.abs(me.x - X) > 0 || Math.abs(me.z - lane) > 0
      await step(`смотреть ${aim.name} (${pitch}), бросок ${k}/${SHOTS}`, 'look_at',
        { x: me.x + 0.5, y: me.y + 1.62 + aim.dy, z: me.z + 0.5 + aim.dz })

      // Рыскание тела перед броском: без него дальность ничего не решает — надо
      // знать, КУДА лёг стак относительно взгляда.
      const seen: any = await call('players', { radius: 8 })
      const yaw = (seen.detail && seen.detail.yaw) != null ? seen.detail.yaw : null

      const had = (await bag()).cooked_beef || 0
      await step('mc_drop 1 стейк', 'drop', { item: 'cooked_beef', count: 1 })
      const shot = await untilDrop(4000)
      const d = shot.items[0] || null
      // Дальность — ПО ГОРИЗОНТАЛИ и по точной позиции, раз она теперь есть:
      // observe.dist трёхмерный и считается от клиентского положения тела, а нас
      // интересует, насколько бросок унесло вбок от точки, которую мы знаем
      // точно. Старый демон без `at` — откат на observe.dist (0.1), это лучше,
      // чем блочные координаты, на которых прошлый прогон дал «0, 0, 1».
      const spot0 = d ? (d.at || null) : null
      const flight = d
        ? (spot0 ? Math.round(Math.hypot(spot0.x - (X + 0.5), spot0.z - (lane + 0.5)) * 10) / 10 : d.dist)
        : null
      let bearing = null
      let bearErr = null
      // Точная позиция стака — новое поле `at` (два знака). Если демон старый и
      // поля нет, честно откатываемся на блочное `pos` и говорим об этом
      // погрешностью, а не молча считаем как ни в чём не бывало.
      const spot = d ? (d.at || d.pos) : null
      const coarse = !!(d && !d.at)
      if (spot && yaw !== null && !drift) {
        const dir = ((Math.atan2(-(spot.x - origin.x), -(spot.z - origin.z)) * 180 / Math.PI) % 360 + 360) % 360
        bearing = Math.round(((dir - yaw + 540) % 360) - 180)
        // Осталось только округление: 0.01 у стака при точке броска, известной
        // из телепорта. Если демон отдал только блочную позицию — снова блок.
        bearErr = flight ? Math.round(Math.atan2(coarse ? 1 : 0.05, flight) * 180 / Math.PI) : null
      }
      console.log(`    ${k}/${SHOTS} наклон ${String(pitch).padStart(4)}: ` +
        `${flight === null ? 'не увидели' : String(flight).padStart(4) + ' бл.'}` +
        `, в сторону ${bearing === null ? '?' : String(bearing).padStart(5)}` +
        `${bearErr === null ? '' : ' (+-' + bearErr + (coarse ? ', демон без at' : '') + ')'}` +
        `${drift ? '  (ТЕЛО СНЕСЛО, угол не считаю)' : ''}` +
        `${d && !shot.settled ? '  (ОСТАНОВИТЬСЯ НЕ УСПЕЛ)' : ''}` +
        `  [${shot.trace.join(' ')}]`)
      shots.push({ flight, bearing, bearErr, settled: !!shot.settled, seen: !!d })

      const now = (await bag()).cooked_beef || 0
      if (now >= had) console.log('      (стак вернулся в рюкзак — тело подобрало свой бросок)')

      if (aim === AIMS[0] && k === 1) {
        check('брошенное ВИДНО через observe', !!d,
          `сущностей в 24 бл.: ${shot.entities.length}, observe вернул fair=${shot.fair}`)
        check('стак успел ОСТАНОВИТЬСЯ до замера', !d || shot.settled === true,
          `settled=${shot.settled} — замер в полёте даёт заниженную дальность`)
      }
    }

    rows.push({ aim: aim.name, pitch, shots, stat: stat(shots.filter(x => x.settled).map(x => x.flight)) })
  }

  console.log(`  ТАБЛИЦА: наклон -> дальность (${SHOTS} броска на угол)`)
  for (const r of rows) {
    const st = r.stat
    console.log(`    наклон ${String(r.pitch).padStart(4)}  ${r.aim.padEnd(12)} ` +
      (st
        ? `среднее ${String(st.mean).padStart(4)}  (от ${st.min} до ${st.max}, разброс ${st.spread}, замеров ${st.n})`
        : 'ни одного замера'))
  }

  // ВЕРДИКТ по выборке, а не по трём точкам. Сравниваем разброс ВНУТРИ угла с
  // разницей МЕЖДУ углами: если внутри гуляет не меньше, чем между, — правит
  // разлёт, и таблица средних ничего не значит.
  const good = rows.filter(r => r.stat)
  const withinMax = good.length ? Math.max(...good.map(r => r.stat.spread)) : null
  const means = good.map(r => r.stat.mean)
  const between = means.length > 1 ? Math.round((Math.max(...means) - Math.min(...means)) * 10) / 10 : null
  const monotone = means.length > 1 && means.every((m, i) => i === 0 || m <= means[i - 1] + 0.1)

  if (withinMax !== null && between !== null) {
    console.log(`  ВЫВОД (дальность): между углами ${between} бл., внутри угла до ${withinMax} бл. — ` +
      (between > withinMax
        ? `дальность ПАДАЕТ с наклоном${monotone ? ' монотонно' : ''} (${SHOTS} броска на угол)`
        : 'внутри угла разброс не меньше, чем между углами — правит разлёт, зависимость от наклона недоказуема'))
  }

  // И то же самое про сторону, тоже по всей выборке. При равномерном разлёте
  // четверть бросков попадает в переднюю четверть; сравниваем с этим.
  // Считаем только те броски, у которых угол вообще что-то значит: координаты
  // срезаны до блока, и на коротком броске погрешность азимута больше самой
  // передней четверти. Считать такие наравне с дальними — это ровно та ошибка
  // разрешения, из-за которой уже пришлось отзывать верную модель.
  const allShots = rows.flatMap(r => r.shots).filter(x => x.bearing !== null)
  const all = allShots.filter(x => x.bearErr !== null && x.bearErr <= 30)
  const front = all.filter(x => Math.abs(x.bearing) <= 45).length
  if (allShots.length && !all.length) {
    console.log(`  ВЫВОД (сторона): все ${allShots.length} бросков короче полутора блоков — ` +
      'угол в них недостоверен (координаты срезаны до блока), сказать про прицельность нечего')
  }
  if (all.length) {
    const expect = Math.round(all.length * 0.25 * 10) / 10
    console.log(`  ВЫВОД (сторона, годных ${all.length} из ${allShots.length}): перед лицом ${front}, ` +
      `при равномерном разлёте ожидалось бы ~${expect}` +
      (front === all.length ? ` (вероятность такого при разлёте ${(Math.pow(0.25, all.length) * 100).toFixed(2)}%)` : '') +
      ' — ' + (front > all.length * 0.6 ? 'бросок похож на ПРИЦЕЛЬНЫЙ' : 'стороны разные, похоже на РАЗЛЁТ'))
  }

  // Проверяем не исход (обе развязки полезны), а что выборки хватило на ответ.
  const measured = rows.flatMap(r => r.shots).filter(x => x.settled && x.flight !== null)
  check(`выборки хватило на вывод (${SHOTS} броска на угол)`,
    good.length === rows.length && good.every(r => r.stat.n >= 3),
    good.map(r => `${r.pitch}: ${r.stat ? r.stat.n : 0} замеров`).join(', '))
  // Число, на котором держится вся раскладка: стенд-офф 2 и калибровка в
  // пределах 1.5-3.5 верны, пока бросок не уносит дальше четырёх блоков.
  const far = measured.filter(r => r.flight > 4)
  check('бросок не уносит дальше 4 блоков (на этом держится стенд-офф 2)', far.length === 0,
    far.map(r => `${r.flight}`).join(', ') || `максимум ${Math.max(...measured.map(r => r.flight), 0)}`)
}

// ---------------------------------------------------------------- 0б

// Независимая нить: подбирает ли ТЕСТОВЫЙ КЛИЕНТ вообще хоть что-нибудь.
// scene-player — обычный mineflayer-клиент, и если сервер держит его не там,
// где сцена его телепортировала, то предмет в блоке от него он не поднимет — и
// тогда красное в случае 1 не про handover.js, а про сцену. Проверяем его
// собственным дропом: бросил, отошёл, вернулся на то же место.
async function scenePickup (igrok) {
  console.log('\n=== 0б) умеет ли тестовый клиент подбирать (проверка самой сцены)')
  const lane = LANES.take
  await arena(lane, 16)
  await kit([])
  await cmd(`/clear ${NICK}`)
  await cmd(`/give ${NICK} minecraft:cobblestone 8`)
  await put(lane, 6)
  await sleep(1500)

  const had = bagOf(igrok, 'cobblestone')
  const thrown: any = await igrokTosses(igrok, 'cobblestone', 8).catch(e => ({ error: e.message }))
  await sleep(1500)
  const afterToss = bagOf(igrok, 'cobblestone')
  const w1 = await probeWorld('после броска игрока', igrok)

  check('бросок игрока состоялся', !thrown.error && afterToss < had,
    `${thrown.error || ''} было ${had}, стало ${afterToss}`)
  check('дроп игрока виден демону', w1.items.length >= 1, w1.text)

  // Отойти и вернуться ровно на кучу.
  await put(lane, 12)
  await sleep(1500)
  const target = w1.items[0]
  if (target) await cmd(`/tp ${NICK} ${target.pos.x}.5 ${Y + 1} ${target.pos.z}.5`)
  await sleep(2500)
  const back = bagOf(igrok, 'cobblestone')

  check('ТЕСТОВЫЙ КЛИЕНТ ПОДБИРАЕТ: вернулся на кучу и забрал',
    back > afterToss,
    `после броска ${afterToss}, после возврата ${back}; куча была на ${target ? at(target.pos) : '?'}`)
  const w2 = await probeWorld('после возврата', igrok)
  if (w2.items.length) console.log(`  ВНИМАНИЕ: куча осталась лежать — ${w2.text}`)
}

// ---------------------------------------------------------------- 1

// Отдать 8 стейков человеку в 5 блоках. Проверка одна и та же с двух сторон:
// у него стало на 8 больше, у бота на 8 меньше.
async function sceneGive (igrok) {
  console.log('\n=== 1. дать 8 стейков человеку в 5 блоках')
  const lane = LANES.give
  await arena(lane, 16)
  await kit(['/give @s minecraft:cooked_beef 16', '/give @s minecraft:stone_pickaxe 1', '/give @s minecraft:iron_pickaxe 1'])
  await cmd(`/clear ${NICK}`)
  await put(lane, 5)
  await probeWorld('перед выдачей')

  const mineBefore = await bag()
  const hisBefore = bagOf(igrok, 'cooked_beef')
  const posBefore = await where()

  const t0 = mark()
  // ТРИ СНИМКА: до, сразу после и через две секунды. Один снимок не отличает
  // «бросок лёг мимо» от «человек ещё не успел поднять».
  const snapBefore = await probeWorld('1/3 до выдачи', igrok)
  const r = await step('give 8 стейков', 'give', { player: NICK, item: 'cooked_beef', count: 8 })
  const d = r.detail || {} as Record<string, any>
  const snapAfter = await probeWorld('2/3 сразу после', igrok)
  const hisAfter = await untilBag(igrok, 'cooked_beef', hisBefore + 8, 8000)
  const mineAfter = await bag()
  await sleep(2000)
  const world = await probeWorld('3/3 через 2с', igrok)
  check('до выдачи арена была чистая', snapBefore.items.length === 0, snapBefore.text)
  if (snapAfter.items.length) console.log(`  сразу после броска на земле: ${snapAfter.text}`)

  console.log(`  попытки: ${JSON.stringify(d.attempts || [])}`)
  console.log(`  рюкзак ${NICK}: ${JSON.stringify(igrokBag(igrok))}, он стоит на ${JSON.stringify(igrokAt(igrok))}`)
  // Главная арифметика прогона: с какой дистанции бросали и куда легло. Если
  // stoodOff и flight не сходятся — виновата дистанция, а не подбор.
  for (const a of d.attempts || []) {
    console.log(`  попытка ${a.try}: стоял в ${a.stoodOff} от человека, бросок унесло на ${a.flight}` +
      (a.fromPlayer != null ? `, стак лёг в ${a.fromPlayer} от него` : '') +
      (a.census ? `, своего броска не нашёл — предметов на земле ${a.census.count}` : ''))
  }
  if (d.drop) console.log(`  бот говорит, что стак лежит на ${JSON.stringify(d.drop.at)}, в ${d.drop.fromPlayer} бл. от человека`)
  check('намерение доработало', r.status === 'done', `${r.status}${d.stopped ? ', встал: ' + d.stopped : ''}`)
  check('У ЧЕЛОВЕКА В РЮКЗАКЕ СТАЛО НА 8 БОЛЬШЕ', hisAfter - hisBefore === 8,
    `было ${hisBefore}, стало ${hisAfter}`)
  check('у бота убыло ровно 8', (mineBefore.cooked_beef || 0) - (mineAfter.cooked_beef || 0) === 8,
    `${mineBefore.cooked_beef} → ${mineAfter.cooked_beef}`)
  check('took=true, и это пакет collect, а не слова', d.took === true && d.gave && d.gave.count === 8,
    JSON.stringify(d.gave))
  const a0 = (d.attempts || [])[0] || {} as Record<string, any>
  // Границы под рабочую дистанцию 2 (±0.7 допуска): не в упор и не издалека.
  // Пять блоков — это то, с чего в игре промахнулись.
  check('встал на рабочую дистанцию', a0.stoodOff >= 1.2 && a0.stoodOff <= 4,
    `stoodOff=${a0.stoodOff}, прошёл ${d.walked} бл., тело сдвинулось на ${flat(posBefore, await where())}`)
  check('бросал с ровным наклоном, а не под ноги', Math.abs(a0.pitch || 0) <= 10, `pitch=${a0.pitch}`)
  check('в ответе сказано, кому отдал', (d.note || '').includes(NICK), d.note)
  check('на арене не осталось валяющегося стейка', world.items.length === 0, world.text)
  if (since(t0).length) console.log(`  события: ${types(since(t0)).join(', ')}`)
}

// ---------------------------------------------------------------- 2

// Человек бросает стак ПОСЛЕ старта mc_take. Дыра, на которой сегодня погорел
// добор руды: один опрос мира вместо окна.
async function sceneTake (igrok) {
  console.log('\n=== 2. человек бросил стак булыжника (бросок ПОСЛЕ старта take)')
  const lane = LANES.take
  await arena(lane, 16)
  await kit([])
  await cmd(`/clear ${NICK}`)
  await cmd(`/give ${NICK} minecraft:cobblestone 64`)
  await put(lane, 3)
  await sleep(1500)
  await probeWorld('перед броском')

  const hisBefore = bagOf(igrok, 'cobblestone')
  const mineBefore = await bag()

  const run = call('take', { item: 'cobblestone', radius: 8, timeoutSeconds: 30 })
  await sleep(600) // стак появляется уже ВНУТРИ вызова, а не до него
  const thrown: any = await igrokTosses(igrok, 'cobblestone', 64).catch(e => ({ error: e.message }))
  const r = report('take булыжник', await run)
  const d = r.detail || {} as Record<string, any>
  const mineAfter = await bag()

  check('человеку было что бросать', !thrown.error, thrown.error || `${hisBefore} булыжника`)
  check('намерение доработало', r.status === 'done', `${r.status}${d.stopped ? ', встал: ' + d.stopped : ''}`)
  check('БОТ ПОДОБРАЛ, и это видно по его рюкзаку',
    (mineAfter.cobblestone || 0) - (mineBefore.cobblestone || 0) === 64,
    `${mineBefore.cobblestone || 0} → ${mineAfter.cobblestone || 0}`)
  check('в отчёте назван именно булыжник', !!(d.took && d.took.cobblestone), JSON.stringify(d.took))
  check('у человека булыжника больше нет', bagOf(igrok, 'cobblestone') === 0, `осталось ${bagOf(igrok, 'cobblestone')}`)
  const leftover = await probeWorld('после подбора')
  check('на арене ничего не осталось лежать', leftover.items.length === 0, leftover.text)
}

// ---------------------------------------------------------------- 3

// Просят последнюю кирку. Отказ обязан назвать, что жалко, и как перебить — и
// то, чем он предлагает перебить, обязано работать.
async function sceneLastPickaxe (igrok) {
  console.log('\n=== 3. просят последнюю кирку')
  const lane = LANES.line
  await arena(lane, 16)
  await kit(['/give @s minecraft:stone_pickaxe 1', '/give @s minecraft:cooked_beef 8'])
  await cmd(`/clear ${NICK}`)
  await put(lane, 4)

  const r = await step('give кирку', 'give', { player: NICK, item: 'кирку' })
  const d = r.detail || {} as Record<string, any>
  const mine = await bag()

  check('не отдал', d.took === false && !d.gave, JSON.stringify(d.gave))
  check('кирка осталась в рюкзаке', (mine.stone_pickaxe || 0) === 1, JSON.stringify(mine))
  check('человеку ничего не досталось', bagOf(igrok, 'stone_pickaxe') === 0)
  check('сказано, что именно жалко', /кирка/.test(d.keep || '') || /кирка/.test(d.stopped || ''),
    `${d.keep} / ${d.stopped}`)
  check('сказано, как перебить', /force=true/.test(d.note || ''), d.note)
  const clean3 = await probeWorld('после отказа')
  check('на арене ничего не валяется', clean3.items.length === 0, clean3.text)

  // Обещание из отказа проверяем тем же вызовом: иначе «перебивается force»
  // — это просто текст.
  const r2 = await step('give кирку force', 'give', { player: NICK, item: 'кирку', force: true })
  const d2 = r2.detail || {} as Record<string, any>
  const his = await untilBag(igrok, 'stone_pickaxe', 1)
  check('force=true действительно отдаёт', d2.took === true && his === 1,
    `took=${d2.took}, у человека ${his}${d2.stopped ? ', встал: ' + d2.stopped : ''}`)
  check('у бота кирки больше нет', ((await bag()).stone_pickaxe || 0) === 0)
}

// ---------------------------------------------------------------- 4

// Просят то, чего нет вовсе. «Нет» без списка того, что есть, — это ответ, из
// которого человеку нечего выбрать.
async function sceneNothing () {
  console.log('\n=== 4. просят то, чего нет')
  const lane = LANES.line
  await cmd('/kill @e[type=!player]')
  await kit(['/give @s minecraft:cooked_beef 8', '/give @s minecraft:cobblestone 30'])

  const r = await step('give diamond', 'give', { player: NICK, item: 'diamond' })
  const d = r.detail || {} as Record<string, any>
  check('не отдал', d.took === false && !d.gave)
  check('сказано, что такого нет', /нет/.test(d.stopped || ''), d.stopped)
  check('перечислено, что ЕСТЬ', /cooked_beef|cobblestone/.test(d.note || ''), d.note)

  const r2 = await step('give топор', 'give', { player: NICK, item: 'топор' })
  const d2 = r2.detail || {} as Record<string, any>
  check('про инструмент отвечает про инструменты', /нет|инструмент/.test((d2.stopped || '') + (d2.note || '')),
    `${d2.stopped} / ${d2.note}`)
}

// ---------------------------------------------------------------- 5

// КОНТРОЛЬ. Человек в 40 блоках. Бросить отсюда — значит потерять вещь в
// коридоре и соврать, что отдал. Проверяем мир: рюкзак цел, тело на месте, на
// арене НИ ОДНОГО предмета на земле.
async function sceneFar (igrok) {
  console.log('\n=== 5. КОНТРОЛЬ: человек в 40 блоках')
  const lane = LANES.far
  await arena(lane, 50)
  await kit(['/give @s minecraft:cooked_beef 16'])
  await cmd(`/clear ${NICK}`)
  await put(lane, 40)
  const before5 = await probeWorld('перед контролем', igrok)
  check('перед контролем арена чистая', before5.items.length === 0, before5.text)

  // Сперва убедиться, что проверка вообще про дальность: если игрок за 40
  // блоков не прогружен как сущность, модуль честно ответит «не прогружен», и
  // красный `road` будет означать не то, что кажется.
  const seen: any = await call('players', { radius: 64 })
  const him = (((seen.detail || {} as Record<string, any>).players) || []).find(x => x.name === NICK)
  check('демон видит человека на 40 бл.', !!him && him.dist >= 35, JSON.stringify(him || null))

  const mineBefore = await bag()
  const posBefore = await where()
  const r = await step('give еды за 40 бл.', 'give', { player: NICK, item: 'cooked_beef', count: 8 })
  const d = r.detail || {} as Record<string, any>
  await sleep(1500)
  const mineAfter = await bag()
  const posAfter = await where()
  const world = await probeWorld('после контроля')

  check('ответил, а не пошёл', r.status === 'done', r.status)
  check('НИЧЕГО НЕ БРОСИЛ: рюкзак цел',
    (mineAfter.cooked_beef || 0) === (mineBefore.cooked_beef || 0),
    `${mineBefore.cooked_beef} → ${mineAfter.cooked_beef}`)
  check('на арене не появилось ни одного предмета на земле', world.items.length === 0, world.text)
  check('тело стоит там же', flat(posBefore, posAfter) <= 1.5,
    `${JSON.stringify(posBefore)} → ${JSON.stringify(posAfter)}`)
  check('человеку ничего не досталось', bagOf(igrok, 'cooked_beef') === 0)
  check('сказано, сколько идти', !!(d.road && d.road.walk >= 35 && d.road.walkSeconds >= 1),
    JSON.stringify(d.road))
  check('в подсказке есть куда идти', /mc_goto/.test(d.note || ''), d.note)
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  let igrok = null
  try {
    await call('connect')

    // Методов может не быть: диффы для session.js и index.js применяет человек.
    // Падать здесь надо словами, а не десятью красными случаями подряд.
    for (const method of ['give', 'take']) {
      const probe: any = await call(method, { player: 'ProbeNikto', item: 'stone' })
        .catch(e => ({ rpcError: e.message }))
      if (probe.rpcError) {
        console.error(`демон не знает ${method}:`, probe.rpcError)
        console.error('примени диффы к daemon/src/session.js и daemon/src/index.js и перезапусти демон')
        process.exitCode = 1
        return
      }
    }

    igrok = await joinAsPlayer({ username: NICK })
    await sleep(2000)
    const st: any = await call('status')
    const online = (st.state && st.state.playersOnline) || []
    console.log(`онлайн: ${online.join(', ') || 'никого'}`)
    if (!online.includes(NICK)) {
      console.error(`${NICK} не виден демону — сцена без второго игрока бессмысленна`)
      process.exitCode = 1
      return
    }

    await sceneThrow()
    await scenePickup(igrok)
    await sceneGive(igrok)
    await sceneTake(igrok)
    await sceneLastPickaxe(igrok)
    await sceneNothing()
    await sceneFar(igrok)

    await call('stop')
    await cmd('/kill @e[type=!player]')
    await cmd(`/clear ${NICK}`)
    await restoreServer()
    console.log(`\nитог: ${failures ? failures + ' проверок не прошло' : 'все проверки прошли'}`)
    if (failures) process.exitCode = 1
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    // И на падении, и на раннем выходе: мир не должен оставаться настроенным
    // под эту сцену просто потому, что она не доиграла.
    await restoreServer().catch(() => {})
    if (igrok) await igrok.leave().catch(() => {})
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })

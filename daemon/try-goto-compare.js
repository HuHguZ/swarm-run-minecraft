'use strict'
const gameClock = require('./src/game-clock')
// Один и тот же набор маршрутов, два разных pathfinder'а под телом.
//
// Прогон меряет ровно те пять случаев, ради которых в movement.js написаны
// костыли (README → «Известные ограничения»), плюс одну контрольную прямую:
//
//   flat     — прямая по плите. Контроль: если он красный, красное всё остальное
//              — дело не в pathfinder'е, а в сцене.
//   pit      — дно собственной ямы 1×1 глубиной 8. Это тот случай, ради которого
//              mc_goto вызывает escapePit ПЕРЕД планированием.
//   chimney  — подъём по столбу 1×1 на 8 из открытого места. Тот же навык, но
//              escapePit тут не срабатывает (бот стартует на плите, inPit=false),
//              поэтому лезет именно pathfinder. Это и есть честный ответ на
//              вопрос «можно ли выкинуть костыль».
//   water    — переплыть водоём в 12 блоков. Ради этого написан escapeWater.
//   cliff    — спуск с обрыва в 6 блоков. README: глубже 4 не преодолеваются.
//   rough    — сложный рельеф: ступени вверх-вниз, канава, ров.
//   drift    — узкий штрек 1×2 в сплошном камне, 21 блок.
//
// КАК ЗАПУСКАТЬ. Движок выбирается переменной окружения демона, а демон один,
// поэтому арены гоняются последовательно, по одному движку за раз:
//
//   1) демон со старым pathfinder'ом (по умолчанию):
//        node daemon/try-goto-compare.js
//   2) остановить демона, поднять его с ND_PATHFINDER=nxg, и:
//        ND_PATHFINDER=nxg node daemon/try-goto-compare.js
//
// Второй прогон подхватит результаты первого из goto-compare.old.json и
// напечатает общую таблицу. Переменная у сцены нужна только чтобы подписать
// колонку: по WebSocket у демона нельзя спросить, какой в нём движок.
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

const ARM = process.env.ND_PATHFINDER === 'nxg' ? 'nxg' : 'old'
const OTHER = ARM === 'nxg' ? 'old' : 'nxg'
const OUT = f => path.join(__dirname, `goto-compare.${f}.json`)

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

const sleep = ms => gameClock.sleep(ms)
const pos = async () => (await call('status')).state.pos

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${JSON.stringify(saw)}`}`)
}

// ------------------------------------------------------------------- арена
//
// Свежий квадрат: все прошлые арены перечислены в TODO («Прибраться в мире»),
// и прогон, который пошёл по чужой лестнице, врёт своим же числам.
// Плита 60×60 в сплошном камне: природный рельеф не должен подмешиваться ни в
// один маршрут. /fill молча отказывается делать больше 32768 блоков и молча
// отказывается работать в непрогруженных чанках — отсюда /tp, пауза и заливка
// полосами по z.
const X0 = 820
const Z0 = 820
const HOME = { x: 824, y: 80, z: 824 }

async function arena () {
  await call('stop')
  await sleep(800)
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set 6000')
  await cmd('/kill @e[type=!player]')
  // Забитый рюкзак заставляет /give ронять предмет на землю, и потом полдня
  // непонятно, почему «нет блоков на столб».
  await cmd('/clear @s')
  // Своя точка возрождения: сцена, которая её не ставит, ломает следующую —
  // и ломается сама, если предыдущая оставила чужую.
  await cmd(`/spawnpoint @s ${HOME.x} ${HOME.y} ${HOME.z}`)
  // Эффект до телепорта, а не после: /tp на y=100 — это падение с двадцати
  // блоков, и оно успевает снять половину здоровья раньше, чем приедет лечение.
  await cmd('/effect give @s minecraft:slow_falling 30 1 true')
  await cmd(`/tp @s ${HOME.x} 100 ${HOME.z}`)
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000) // чанки должны приехать раньше заливки

  // Тело плиты: камень y=60..79 (ходят по y=80), воздух y=80..100.
  for (const z of [820, 840, 860]) {
    await cmd(`/fill ${X0} 60 ${z} 879 79 ${z + 19} minecraft:stone`)
    await cmd(`/fill ${X0} 80 ${z} 879 100 ${z + 19} minecraft:air`)
  }

  // pit: колодец 1×1 на 8 вниз. Пол колодца — верх блока y=71, ноги на y=72,
  // от поверхности y=80 это ровно восемь уровней.
  await cmd('/fill 826 72 826 826 79 826 minecraft:air')

  // chimney: куб 7×7 от y=80 до y=87. Внутри — глухой столб 1×1 на всю высоту
  // и штрек 1×2 к нему от южной грани. Наверх (ходят по y=88) другой дороги
  // нет: боковые грани куба — отвесные восемь блоков.
  await cmd('/fill 834 80 824 840 87 830 minecraft:stone')
  await cmd('/fill 837 80 827 837 87 827 minecraft:air')
  await cmd('/fill 837 80 828 837 81 830 minecraft:air')

  // cliff: нижняя полка. Снимаем y=74..79 — ходят по y=74, обрыв с y=80 ровно 6.
  await cmd('/fill 846 74 820 873 79 847 minecraft:air')

  // water: закрытая чаша 12×12, вода вровень с поверхностью плиты (y=77..79).
  // Берега — камень со всех четырёх сторон, поэтому вода никуда не течёт.
  await cmd('/fill 824 77 856 835 79 867 minecraft:water')

  // rough: лесенка вверх на три и вниз на три, потом канава и ров.
  await cmd('/fill 848 80 852 849 80 871 minecraft:stone')
  await cmd('/fill 850 80 852 851 81 871 minecraft:stone')
  await cmd('/fill 852 80 852 853 82 871 minecraft:stone')
  await cmd('/fill 854 80 852 855 81 871 minecraft:stone')
  await cmd('/fill 856 80 852 857 80 871 minecraft:stone')
  await cmd('/fill 862 78 852 862 79 871 minecraft:air')
  await cmd('/fill 866 77 852 866 79 871 minecraft:air')
  await cmd('/fill 870 80 852 871 80 871 minecraft:stone')

  // drift: штрек 1×2 в теле плиты. Ноги на y=70, голова y=71, пол y=69.
  await cmd('/fill 822 70 876 845 71 876 minecraft:air')

  await cmd(`/tp @s ${HOME.x} ${HOME.y} ${HOME.z}`)
  await sleep(1200)
}

// Снаряжение одинаковое для обоих движков и намеренно без кирки: с киркой
// session.updateMovements включает canDig, и тогда «сложный рельеф» решается
// подкопом, а меряется уже не ходьба. Булыжник нужен, чтобы столб 1×1 вообще
// был законным ходом (allow1by1towers включается от восьми блоков).
async function kit () {
  await cmd('/clear @s')
  await cmd('/give @s minecraft:cobblestone 64')
  await sleep(600)
}

// Телепорт роняет тело; половина отказов иначе будет по здоровью, а не по
// геометрии. И сразу же снимаем всё обратно: slow_falling, которым прикрыт
// телепорт, отменил бы падение на маршруте cliff — то есть измерил бы эффект,
// а не pathfinder.
async function heal () {
  await cmd('/effect give @s minecraft:instant_health 1 5 true')
  await cmd('/effect give @s minecraft:saturation 1 5 true')
  await sleep(800)
  await cmd('/effect clear @s')
  await sleep(400)
}

// ------------------------------------------------------------------ маршруты

const ROUTES = [
  {
    key: 'flat',
    name: 'плита, прямая 20',
    from: { x: 824, y: 80, z: 824 },
    to: { x: 824, y: 80, z: 844, range: 2 },
    seconds: 60
  },
  {
    key: 'pit',
    name: 'дно ямы 1×1, глубина 8',
    from: { x: 826, y: 72, z: 826 },
    to: { x: 824, y: 80, z: 836, range: 2 },
    seconds: 90
  },
  {
    // Читается так: дошёл при attempts === 1 — столб 1×1 взял сам pathfinder.
    // Дошёл при attempts > 1 — заслуга под вопросом: перед каждой повторной
    // попыткой session.goto зовёт escapePit, а к тому моменту тело уже стоит в
    // столбе, и вылезти оно могло костылём. Обойти escapePit из сцены нельзя:
    // он вшит в mc_goto до планирования.
    key: 'chimney',
    name: 'столб 1×1 вверх на 8',
    from: { x: 837, y: 80, z: 833 },
    to: { x: 836, y: 88, z: 826, range: 1 },
    seconds: 90
  },
  {
    key: 'water',
    name: 'переплыть 12 блоков',
    from: { x: 822, y: 80, z: 861 },
    to: { x: 838, y: 80, z: 861, range: 2 },
    seconds: 90
  },
  {
    key: 'cliff',
    name: 'спуск с обрыва 6',
    from: { x: 843, y: 80, z: 833 },
    to: { x: 860, y: 74, z: 833, range: 2 },
    seconds: 90
  },
  {
    key: 'rough',
    name: 'сложный рельеф 26',
    from: { x: 846, y: 80, z: 861 },
    to: { x: 874, y: 80, z: 861, range: 2 },
    seconds: 120
  },
  {
    key: 'drift',
    name: 'штрек 1×2, 21 блок',
    from: { x: 823, y: 70, z: 876 },
    to: { x: 844, y: 70, z: 876, range: 1 },
    seconds: 120
  }
]

// Сколько раз внутри интента сработал сторож застревания. На отказе это видно
// точно: session.goto складывает причину каждой попытки в текст ошибки. На
// успехе такого текста нет вовсе, и остаётся только число попыток — поэтому
// колонка «попыток» рядом обязательна, а не для красоты.
function stuckHits (r) {
  const text = String(r.error || '')
  return (text.match(/застрял/g) || []).length
}

async function run (route) {
  await kit()
  await cmd(`/effect give @s minecraft:slow_falling 20 1 true`)
  await cmd(`/tp @s ${route.from.x + 0.5} ${route.from.y} ${route.from.z + 0.5}`)
  await sleep(1500)
  await heal()

  const before = await pos()
  const ok = before.x === route.from.x && before.z === route.from.z && Math.abs(before.y - route.from.y) <= 1
  if (!ok) console.log(`   ! стартовал не там, где думал: ${JSON.stringify(before)} вместо ${JSON.stringify(route.from)}`)

  const t0 = gameClock.now()
  const r = await call('goto', { ...route.to, timeoutSeconds: route.seconds })
    .catch(e => ({ status: 'RPC', error: e.message }))
  const secs = Math.round((gameClock.now() - t0) / 100) / 10

  const after = r.state ? r.state.pos : await pos()
  const detail = r.detail || {}
  const row = {
    key: route.key,
    name: route.name,
    arrived: r.status === 'done',
    seconds: secs,
    attempts: detail.attempts ?? null,
    // Сколько блоков escapePit вылез ДО планирования. Это и есть костыль: если
    // на маршруте pit он ненулевой, дорогу открыл он, а не pathfinder.
    climbedOut: detail.climbedOut ?? 0,
    stuck: stuckHits(r),
    startedRight: ok,
    at: after,
    status: r.status,
    error: r.error || null
  }

  console.log(
    `${route.name.padEnd(26)} ${(row.arrived ? 'дошёл' : 'НЕ ДОШЁЛ').padEnd(9)} ` +
    `${String(row.seconds).padStart(6)}с  попыток ${String(row.attempts ?? '-').padStart(2)}  ` +
    `сторож ${row.stuck}  ${row.climbedOut ? 'вылез из ямы на ' + row.climbedOut + '  ' : ''}` +
    `${row.error ? '<- ' + row.error : ''}`
  )
  return row
}

// ------------------------------------------------------------------ таблица

function table (mine, theirs) {
  const head = ['маршрут', ARM, OTHER]
  const cell = row => row
    ? `${row.arrived ? 'дошёл' : 'нет'} / ${row.seconds}с / ${row.attempts ?? '-'}поп / стор ${row.stuck}${row.climbedOut ? ' / костыль +' + row.climbedOut : ''}`
    : '—'
  const rows = ROUTES.map(rt => [
    rt.name,
    cell(mine.find(r => r.key === rt.key)),
    cell(theirs && theirs.rows ? theirs.rows.find(r => r.key === rt.key) : null)
  ])
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)))
  const line = cols => '| ' + cols.map((c, i) => c.padEnd(w[i])).join(' | ') + ' |'
  console.log('')
  console.log(line(head))
  console.log('|-' + w.map(n => '-'.repeat(n)).join('-|-') + '-|')
  for (const r of rows) console.log(line(r))
  if (!theirs) {
    console.log('')
    console.log(`второй колонки нет: не найден ${path.basename(OUT(OTHER))}.`)
    console.log(`подними демона с ND_PATHFINDER=${OTHER === 'nxg' ? 'nxg' : ''} и запусти сцену ещё раз.`)
  }
}

// ---------------------------------------------------------------------- ход

ws.on('open', async () => {
  try {
    console.log(`движок под телом: ${ARM} (по ND_PATHFINDER у сцены; демон надо было поднять с тем же значением)`)
    await call('connect')
    console.log('строю арену…')
    await arena()

    const start = await pos()
    check('стою в своей арене', start.x >= X0 && start.x < X0 + 60 && start.z >= Z0 && start.z < Z0 + 60, start)
    const hp = (await call('status')).state.health
    check('стартую на полном здоровье', hp >= 19, hp)

    console.log('')
    const rows = []
    for (const route of ROUTES) rows.push(await run(route))

    console.log('')
    for (const row of rows) {
      if (row.key === 'flat') check('контрольная прямая пройдена', row.arrived, row.error)
      if (!row.startedRight) check(`${row.key}: стартовал там, где задумано`, false, row.at)
    }

    fs.writeFileSync(OUT(ARM), JSON.stringify({ arm: ARM, when: new Date().toISOString(), rows }, null, 2))
    let theirs = null
    try { theirs = JSON.parse(fs.readFileSync(OUT(OTHER), 'utf8')) } catch {}
    table(rows, theirs)

    console.log('')
    console.log(`записал ${path.basename(OUT(ARM))}`)
    if (failures) console.log(`${failures} проверок красные`)
    process.exitCode = failures ? 1 : 0
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    try { await call('stop') } catch {}
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })

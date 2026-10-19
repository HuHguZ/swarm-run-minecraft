'use strict'
import * as gameClock from '../../src/game-clock'
// Портал в Ад: рама, огонь и координаты в памяти.
//
// Что здесь проверяется и почему именно это:
//
//  1. РАМА ИЗ ДЕСЯТИ. Минимальный портал — дырка 2x3, а рама вокруг неё без
//     углов: paper-1.21.11.jar, net/minecraft/world/level/portal/PortalShape —
//     MIN_WIDTH=2, MIN_HEIGHT=3, при этом getDistanceUntilEdgeAboveFrame ходит
//     по нижнему ряду только под дыркой, а hasTopFrame крутит i от 0 до
//     width-1, то есть по ширине дырки. Ни один из них в угол не смотрит.
//     Случай (а) проверяет это в мире: боту выдаётся 14 обсидиана, а уйти
//     должно ровно 10.
//  2. ЧЕСТНЫЕ ОТКАЗЫ. Мозг ходит раз в 10-30 секунд, поэтому отказ обязан
//     называть число и место, где взять недостающее. Случаи (б) и (в).
//  3. КОНТРОЛЬ (г): рядом уже горит чужой портал — не строит второй и не ломает
//     чужой. И (д): повтор доделывает НАЧАТУЮ раму, а не кладёт вторую рядом.
//  4. ГРАНИЦЫ (е) и (ж): вода в котловане и коробка, в которую рама не влезает.
//
// ГРАБЛИ, оплаченные кровью, и одна оплаченная этим файлом:
//  · /kill @e[type=!player] видит только прогруженные чанки — чистить арену
//    можно только стоя в ней, поэтому kill идёт и до /tp, и после;
//  · координаты в командах через ПРОБЕЛ: /setblock 1800 70 0, форма с запятыми
//    молча не выполняется;
//  · /fill в непрогруженном чанке молча ничего не делает (отсюда пауза после
//    /tp И проверка мира после засыпки), и он отказывается делать больше 32768
//    блоков — здесь 37x10x37 = 13690, влезает;
//  · /clear @s первым делом: в полный рюкзак /give роняет предмет на землю;
//  · ЛЮБОЙ ответ демона выгребает шину событий, поэтому события копятся в heard.
//
//  · И СВОЯ, самая дорогая: АРЕНА ДОЛЖНА БЫТЬ ЧИЩЕ, ЧЕМ ИНТЕНТ ВИДИТ ДАЛЕКО.
//    Первый прогон случая (д) дал obsidian=16, nether_portal=1 и нетронутый
//    рюкзак — числа, не сходившиеся ни с одной простой историей. Разгадка:
//    арена чистилась на ±8, гейт смотрел мир на 12, а интент ищет чужие порталы
//    на scan=16. В кольце 12..16 лежал чужой горящий портал: гейт его не видел,
//    интент видел — и честно вернул mode:'already', lit:true, не потратив ни
//    блока. Проверка «портал горит» при этом ПРОШЛА и спрятала подмену.
//    Отсюда три правила ниже, и их стоит держать в любой сцене:
//      (1) ARENA_HALF >= SCAN — чистим дальше, чем интент смотрит;
//      (2) смотрим мир радиусом OBSERVE > SCAN — гейт обязан видеть всё, что
//          видит интент, иначе он проверяет не то;
//      (3) перед замером проверяем, что чужого портала НЕТ, и после замера
//          требуем mode:'build' — «загорелось» и «построил» это разные факты.
//
// Что докажет прогон одной строкой: бот ставит раму ровно из десяти обсидианов
// и зажигает её, отказывается числом, когда обсидиана или огнива нет, повтор
// доделывает начатую раму, а рядом с чужим горящим порталом бот не трогает ни
// рюкзак, ни чужие блоки.
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

// x=1800 свободен: заняты -26..-4, 190..210, 300..329, 400..429, 600..630,
// 686..783, x=850 z=850..990, и x=1300/1400/1500/1600/1700/1900/2000 у соседей.
const X0 = 1800

// Сколько интент смотрит вокруг в поисках чужого портала. Задаётся явно, а не
// берётся по умолчанию: от этого числа считаются и ширина арены, и радиус
// наблюдения, и вся эта сцена держится на том, что они согласованы.
const SCAN = 16
// Чистим ДАЛЬШЕ, чем интент смотрит. 37x37 в плане: /fill за раз 37*10*37=13690.
const ARENA_HALF = 18
// Смотрим мир ДАЛЬШЕ, чем интент. Гейт, который видит меньше подсудимого,
// проверяет не то — это и стоило прогона.
const OBSERVE = 20

// Полосы через 48, чтобы арены (±18) не перекрывались и одна не подчищала
// соседнюю. При 30 они налезали друг на друга.
const LANES = {
  build: 0, // всё есть: рама встала, портал горит
  short: 48, // обсидиана 4 из 10
  nofire: 96, // обсидиана хватает, зажечь нечем
  neighbour: 144, // КОНТРОЛЬ: чужой горящий портал в трёх блоках
  resume: 192, // недостроенная рама: повтор обязан доделать ЕЁ
  water: 240, // вода в котловане
  tight: 288 // коробка 5x5x3 — рама не влезает
}
const Y = 70

async function arena (lane, { floor = 'stone' }: any = {} as Record<string, any>) {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/gamerule fire_spread_radius_around_player 0') // огонь от огнива не должен разбегаться
  await cmd('/time set day')
  await cmd('/difficulty peaceful')
  await cmd(`/tp @s ${X0} ${Y + 2} ${lane}`)
  await cmd('/kill @e[type=!player]')
  await sleep(4000) // чанки: без этого /fill молча не сработает
  const h = ARENA_HALF
  await cmd(`/fill ${X0 - h} ${Y - 3} ${lane - h} ${X0 + h} ${Y} ${lane + h} minecraft:${floor}`)
  await cmd(`/fill ${X0 - h} ${Y + 1} ${lane - h} ${X0 + h} ${Y + 10} ${lane + h} minecraft:air`)
  await cmd('/effect give @s minecraft:saturation 1 5 true')
  await cmd('/effect give @s minecraft:fire_resistance 600 5 true')
}

async function give (gives) {
  await cmd('/clear @s')
  for (const g of gives) await cmd(`/give @s ${g}`)
  await sleep(1500) // инвентарь долетает до клиента отдельным пакетом
}

async function standAt (lane, y = Y + 1) {
  await cmd(`/tp @s ${X0}.5 ${y} ${lane}.5`)
  await sleep(2500)
}

async function snapshot () {
  const r: any = await call('status')
  return (r.state && r.state.inventory) || {} as Record<string, any>
}

async function header () {
  const r: any = await call('status')
  return r.state || {} as Record<string, any>
}

// Мир, а не ответ интента. observe с fair:false — это findBlocks без тумана
// войны, и obsidian с nether_portal у него в списке «интересного»
// (perception.js: INTERESTING). Единственный свидетель, который не зависит от
// того, что интент про себя рассказал.
async function world (radius = OBSERVE) {
  const r: any = await call('observe', { radius, fair: false })
  const d = r.detail || {} as Record<string, any>
  const map: Record<string, any> = {} as Record<string, any>
  for (const b of d.blocks || []) map[b.name] = b.count
  return { map, blocks: d.blocks || [], terrain: d.terrain || {} as Record<string, any> }
}

const cnt = (w, name) => w.map[name] || 0
const nearestOf = (w, name) => {
  const b = (w.blocks || []).find(x => x.name === name)
  return b ? b.nearest : null
}

// Проверка мира сразу после постройки арены. Без неё контроль ничего не
// доказывает: /fill в непрогруженном чанке молчит, а чужой хлам в кольце между
// старой ареной и радиусом зрения интента подменяет весь случай.
async function assertArena (lane, { floor = 'stone', expectObsidian = 0 }: any = {} as Record<string, any>) {
  const w = await world(OBSERVE)
  console.log('  мир до:', JSON.stringify(w.map), '| под ногами:', w.terrain.standingOn)
  check('арена засыпалась: под ногами то, чем заливали', w.terrain.standingOn === floor,
    `standingOn=${w.terrain.standingOn} — если не ${floor}, /fill молча не выполнился и весь случай пустой`)
  check('в арене нет чужого портала', cnt(w, 'nether_portal') === 0,
    `nether_portal=${cnt(w, 'nether_portal')} в радиусе ${OBSERVE} (интент смотрит на ${SCAN})`)
  check(`обсидиана в арене ${expectObsidian}`, cnt(w, 'obsidian') === expectObsidian,
    `obsidian=${cnt(w, 'obsidian')}`)
  return w
}

const clean = w => cnt(w, 'nether_portal') === 0

async function memory () {
  const r: any = await call('recall', { lines: 5 })
  const places = (r.detail && r.detail.state && r.detail.state.places) || {} as Record<string, any>
  return places['портал'] || null
}

async function forgetPortal () {
  await call('portal', { mode: 'forget' }).catch(() => {})
}

// Десять клеток рамы вокруг дырки с левым нижним углом в (x, y, lane), ось x.
// Выписаны руками и НЕ берутся из nether.js: свидетель должен быть независим от
// подсудимого.
function frameCells (x, y, lane) {
  return [
    [x, y - 1, lane], [x + 1, y - 1, lane],
    [x - 1, y, lane], [x - 1, y + 1, lane], [x - 1, y + 2, lane],
    [x + 2, y, lane], [x + 2, y + 1, lane], [x + 2, y + 2, lane],
    [x, y + 3, lane], [x + 1, y + 3, lane]
  ]
}

const atOneOf = (pos, cells) =>
  !!pos && cells.some(([a, b, c]: any) => pos.x === a && pos.y === b && pos.z === c)

// ---------------------------------------------------------------- 1

async function sceneBuild () {
  console.log('\n=== 1. всё есть: рама встала, портал горит, координаты в памяти ===')
  const lane = LANES.build
  await arena(lane)
  await forgetPortal()
  await give([
    'minecraft:obsidian 14', // на 4 больше, чем надо: сдача докажет, что взял 10
    'minecraft:flint_and_steel 1',
    'minecraft:cobblestone 32', // подпорка в угол; обсидиан на неё тратить нельзя
    'minecraft:iron_pickaxe 1',
    'minecraft:torch 8'
  ])
  await standAt(lane)

  const before = await assertArena(lane)
  if (!clean(before)) { console.log('  ПРОПУСКАЮ ЗАМЕР: арена грязная'); return }

  const r: any = await step('portal', 'portal', { timeoutSeconds: 150, scan: SCAN })
  const d = r.detail || {} as Record<string, any>
  const after = await world(OBSERVE)
  const inv = await snapshot()
  const head = await header()
  const mem = await memory()
  console.log('  мир после:', JSON.stringify(after.map))
  console.log('  рюкзак:', JSON.stringify(inv))
  console.log('  память:', JSON.stringify(mem))
  // Какие клетки не встали и почему: «ответа от сервера нет» — наш поводок,
  // «не к чему прислонить» — геометрия. Разные болезни, разное лечение.
  if (d.frame) console.log('  рама:', JSON.stringify(d.frame))

  // «Загорелось» и «построил» — разные факты, и путать их дорого: ответ
  // mode:'already' тоже приходит с lit:true, не потратив ни блока.
  check('интент СТРОИЛ, а не нашёл готовое', d.mode === 'build', `mode=${d.mode}`)
  check('интент сказал, что построил', d.built === true, JSON.stringify({ status: r.status, stopped: d.stopped }))
  check('интент сказал, что горит', d.lit === true, `lit=${d.lit}`)
  // Круга два — честная норма (один отказ сервера съедает повтор на месте, два
  // подряд стоят круга), а вот третьего быть не может.
  check('рама собралась не больше чем в два круга', !d.frame || d.frame.passes <= 2, JSON.stringify(d.frame))

  check('В МИРЕ шесть клеток nether_portal', cnt(after, 'nether_portal') === 6,
    `nether_portal=${cnt(after, 'nether_portal')}`)
  // И это же — доказательство, что углы не нужны: их четыре, и если бы игра их
  // требовала, десяти блоков не хватило бы и портал бы не зажёгся.
  check('В МИРЕ ровно 10 обсидиана — рама без углов', cnt(after, 'obsidian') === 10,
    `obsidian=${cnt(after, 'obsidian')}; 14 значило бы, что углы всё-таки заложены`)
  check('потратил ровно 10 обсидиана', (inv.obsidian || 0) === 4, `в рюкзаке осталось ${inv.obsidian}`)
  check('огниво не потерял', (inv.flint_and_steel || 0) === 1, `flint_and_steel=${inv.flint_and_steel}`)

  check('координаты записаны в память', !!mem && Number.isFinite(mem.x), JSON.stringify(mem))
  check('в памяти помечено, что портал горит', !!mem && mem.lit === true, mem && String(mem.lit))
  check('в памяти помечено, что портал свой', !!mem && mem.mine === true, mem && String(mem.mine))
  check('в памяти есть ось рамы', !!mem && /^[xz]$/.test(String(mem.axis)), mem && String(mem.axis))
  check('в заметке сказано не заходить внутрь', !!mem && /не заходить/.test(mem.note || ''), mem && mem.note)
  check('к записанным координатам можно подойти',
    !!mem && Math.hypot(mem.x - head.pos.x, mem.z - head.pos.z) <= 8,
    mem ? `запись ${mem.x},${mem.y},${mem.z}, бот ${head.pos.x},${head.pos.y},${head.pos.z}` : '-')

  // Ради этого интент и останавливается на пороге: шаг внутрь — смена мира.
  check('бот остался в верхнем мире', /overworld/.test(String(head.dimension)), String(head.dimension))
  check('и сам в портал не зашёл', !d.inside, JSON.stringify(d.inside))
  check('в ответе сказано, почему в портал не идём', /другое измерение/.test(d.note || ''), d.note)
}

// ---------------------------------------------------------------- 2

async function sceneShort () {
  console.log('\n=== 2. обсидиана не хватает: отказ с числом ===')
  const lane = LANES.short
  await arena(lane)
  await forgetPortal()
  await give([
    'minecraft:obsidian 4',
    'minecraft:flint_and_steel 1',
    'minecraft:cobblestone 32',
    'minecraft:iron_pickaxe 1'
  ])
  await standAt(lane)

  const before = await assertArena(lane)
  if (!clean(before)) { console.log('  ПРОПУСКАЮ ЗАМЕР: арена грязная'); return }

  const r: any = await step('portal', 'portal', { timeoutSeconds: 60, scan: SCAN })
  const d = r.detail || {} as Record<string, any>
  const after = await world(OBSERVE)
  const inv = await snapshot()
  console.log('  мир после:', JSON.stringify(after.map))
  console.log('  отказ:', d.stopped)

  check('не построил', d.built === false, `built=${d.built}`)
  check('в мире не появилось ни одного обсидиана', cnt(after, 'obsidian') === 0, `obsidian=${cnt(after, 'obsidian')}`)
  check('обсидиан в рюкзаке цел', (inv.obsidian || 0) === 4, `obsidian=${inv.obsidian}`)
  check('need называет обсидиан', d.need && d.need.what === 'obsidian', JSON.stringify(d.need))
  check('need называет НЕДОСТАЧУ, а не потребность', d.need && d.need.count === 6, JSON.stringify(d.need))
  check('need говорит, сколько уже есть', d.need && d.need.have === 4, JSON.stringify(d.need))
  check('текст отказа содержит число', /не хватает 6/.test(d.stopped || ''), d.stopped)
  check('текст отказа говорит, где взять', /лавов|портал/.test(d.stopped || ''), d.stopped)
  check('текст отказа называет нужную кирку', /diamond_pickaxe|алмазн/.test(d.stopped || ''), d.stopped)
}

// ---------------------------------------------------------------- 3

async function sceneNoFire () {
  console.log('\n=== 3. зажечь нечем: отказ называет предмет ===')
  const lane = LANES.nofire
  await arena(lane)
  await forgetPortal()
  await give([
    'minecraft:obsidian 16',
    'minecraft:cobblestone 32',
    'minecraft:iron_pickaxe 1'
  ])
  await standAt(lane)

  const before = await assertArena(lane)
  if (!clean(before)) { console.log('  ПРОПУСКАЮ ЗАМЕР: арена грязная'); return }

  const r: any = await step('portal', 'portal', { timeoutSeconds: 60, scan: SCAN })
  const d = r.detail || {} as Record<string, any>
  const after = await world(OBSERVE)
  const inv = await snapshot()
  console.log('  мир после:', JSON.stringify(after.map))
  console.log('  отказ:', d.stopped)

  check('не построил', d.built === false, `built=${d.built}`)
  check('отказ называет предмет', /flint_and_steel/.test(d.stopped || ''), d.stopped)
  check('и говорит, из чего он делается', /iron_ingot|flint/.test(d.stopped || ''), d.stopped)
  check('и что верстак для него не нужен', /верстак не нужен/.test(d.stopped || ''), d.stopped)
  check('need указывает на огниво', d.need && d.need.what === 'flint_and_steel', JSON.stringify(d.need))
  // Отказ ДО стройки: рама без огня — это десять обсидиана в чистом поле.
  check('обсидиан не потрачен', (inv.obsidian || 0) === 16, `obsidian=${inv.obsidian}`)
  check('в мире рамы нет', cnt(after, 'obsidian') === 0, `obsidian=${cnt(after, 'obsidian')}`)
}

// ---------------------------------------------------------------- 4 (контроль)

async function buildForeignPortal (lane) {
  const y = Y + 1
  const x = X0 + 3
  for (const [a, b, c] of frameCells(x, y, lane)) {
    await cmd(`/setblock ${a} ${b} ${c} minecraft:obsidian`)
  }
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 2; i++) {
      await cmd(`/setblock ${x + i} ${y + j} ${lane} minecraft:nether_portal[axis=x]`)
    }
  }
}

async function sceneNeighbour () {
  console.log('\n=== 4. КОНТРОЛЬ: рядом уже горит чужой портал ===')
  const lane = LANES.neighbour
  await arena(lane)
  await forgetPortal()
  // Сначала убеждаюсь, что арена пуста, и только потом кладу чужой портал:
  // иначе «чужой портал стоит» может оказаться остатком прошлого прогона.
  const empty = await assertArena(lane)
  if (!clean(empty) || cnt(empty, 'obsidian') !== 0) {
    console.log('  ПРОПУСКАЮ ЗАМЕР: арена грязная ещё до постройки чужого портала')
    return
  }

  await buildForeignPortal(lane)
  await give([
    'minecraft:obsidian 64',
    'minecraft:flint_and_steel 1',
    'minecraft:cobblestone 64',
    'minecraft:iron_pickaxe 1'
  ])
  await standAt(lane)

  // ПРОВЕРЯЮ МИР ДО ЗАМЕРА. Контроль без предмета в мире ничего не доказывает.
  const before = await world(OBSERVE)
  console.log('  мир до:', JSON.stringify(before.map))
  const expect = frameCells(X0 + 3, Y + 1, lane)
  check('чужой портал действительно стоит: 6 клеток', cnt(before, 'nether_portal') === 6,
    `nether_portal=${cnt(before, 'nether_portal')} — если 0, /setblock не выполнился и случай пустой`)
  check('и его рама — 10 обсидиана', cnt(before, 'obsidian') === 10, `obsidian=${cnt(before, 'obsidian')}`)
  check('и лежит она там, куда я её клал', atOneOf(nearestOf(before, 'obsidian'), expect),
    JSON.stringify(nearestOf(before, 'obsidian')))
  if (cnt(before, 'nether_portal') !== 6 || cnt(before, 'obsidian') !== 10) {
    console.log('  ПРОПУСКАЮ ЗАМЕР: чужой портал в мире не тот, мерить нечего')
    return
  }

  const r: any = await step('portal', 'portal', { timeoutSeconds: 90, scan: SCAN })
  const d = r.detail || {} as Record<string, any>
  const after = await world(OBSERVE)
  const inv = await snapshot()
  const mem = await memory()
  console.log('  мир после:', JSON.stringify(after.map))
  console.log('  рюкзак:', JSON.stringify(inv))

  check('второй портал не строил', d.built === false, `built=${d.built}`)
  check('и сказал об этом прямо', d.mode === 'already', `mode=${d.mode}`)
  check('чужую раму не тронул: обсидиана всё те же 10', cnt(after, 'obsidian') === 10,
    `obsidian=${cnt(after, 'obsidian')}`)
  check('чужой портал всё ещё горит: 6 клеток', cnt(after, 'nether_portal') === 6,
    `nether_portal=${cnt(after, 'nether_portal')}`)
  check('свой обсидиан не потратил', (inv.obsidian || 0) === 64, `obsidian=${inv.obsidian}`)
  check('огниво не израсходовал', (inv.flint_and_steel || 0) === 1, `flint_and_steel=${inv.flint_and_steel}`)
  check('координаты чужого записал в память', !!mem && Number.isFinite(mem.x), JSON.stringify(mem))
  check('и пометил, что портал не свой', !!mem && mem.mine === false, mem && String(mem.mine))
  check('бот остался в верхнем мире', /overworld/.test(String((await header()).dimension)))
}

// ---------------------------------------------------------------- 5

// Повтор после обрыва. Кладу восемь блоков рамы из десяти — ровно то, чем
// кончился первый прогон в игре, — и требую, чтобы вызов доложил ДВА блока в эту
// же раму, а не выложил рядом вторую. Недостроенную раму findFrames не находит
// (она неполная), так что площадку держит только needObsidian в счёте выбора
// места, и проверяется здесь именно он.
async function sceneResume () {
  console.log('\n=== 5. повтор доделывает начатую раму, а не строит вторую ===')
  const lane = LANES.resume
  await arena(lane)
  await forgetPortal()

  const empty = await assertArena(lane)
  if (!clean(empty) || cnt(empty, 'obsidian') !== 0) {
    console.log('  ПРОПУСКАЮ ЗАМЕР: арена грязная ещё до засыпки рамы')
    return
  }

  const x = X0 + 3
  const y = Y + 1
  const all = frameCells(x, y, lane)
  const laid = all.slice(0, 8) // без верхнего ряда
  for (const [a, b, c] of laid) await cmd(`/setblock ${a} ${b} ${c} minecraft:obsidian`)
  await give([
    'minecraft:obsidian 64',
    'minecraft:flint_and_steel 1',
    'minecraft:cobblestone 32',
    'minecraft:iron_pickaxe 1'
  ])
  await standAt(lane)

  const before = await world(OBSERVE)
  console.log('  мир до:', JSON.stringify(before.map))
  check('восемь блоков рамы действительно лежат', cnt(before, 'obsidian') === 8,
    `obsidian=${cnt(before, 'obsidian')} — если не 8, /setblock не выполнился и случай пустой`)
  check('и лежат они там, куда я их клал', atOneOf(nearestOf(before, 'obsidian'), laid),
    JSON.stringify(nearestOf(before, 'obsidian')))
  check('чужого портала рядом нет', cnt(before, 'nether_portal') === 0,
    `nether_portal=${cnt(before, 'nether_portal')} — иначе интент вернёт mode:already и случай пустой`)
  if (cnt(before, 'obsidian') !== 8 || cnt(before, 'nether_portal') !== 0) {
    console.log('  ПРОПУСКАЮ ЗАМЕР: недостроенной рамы в мире нет или рядом чужой портал')
    return
  }

  const r: any = await step('portal', 'portal', { timeoutSeconds: 120, scan: SCAN })
  const d = r.detail || {} as Record<string, any>
  const after = await world(OBSERVE)
  const inv = await snapshot()
  console.log('  мир после:', JSON.stringify(after.map))
  if (d.frame) console.log('  рама:', JSON.stringify(d.frame))

  check('интент СТРОИЛ, а не нашёл готовое', d.mode === 'build', `mode=${d.mode}`)
  check('портал горит', d.lit === true, JSON.stringify({ built: d.built, stopped: d.stopped }))
  // Вот и весь смысл случая: обсидиана в мире стало 10, а не 18.
  check('в мире ОДНА рама, а не две', cnt(after, 'obsidian') === 10,
    `obsidian=${cnt(after, 'obsidian')}; 18 значило бы, что рядом начата вторая`)
  check('доделал ИМЕННО начатую раму', atOneOf(nearestOf(after, 'obsidian'), all),
    JSON.stringify(nearestOf(after, 'obsidian')))
  check('шесть клеток портала', cnt(after, 'nether_portal') === 6, `nether_portal=${cnt(after, 'nether_portal')}`)
  check('доложил ровно 2 блока', (inv.obsidian || 0) === 62, `в рюкзаке ${inv.obsidian} из 64`)
}

// ---------------------------------------------------------------- 6

// Вода в котловане. Слой в один блок, бот стоит на каменной тумбе посреди него:
// утонуть негде, а внутрь рамы вода попадает при любом выборе места, и портал в
// такой дырке не соберётся (PortalShape.isEmpty — только воздух, огонь или сам
// портал).
async function sceneWater () {
  console.log('\n=== 6. вода мешает: честный отказ, а не тихая неудача ===')
  const lane = LANES.water
  await arena(lane)
  await forgetPortal()
  await cmd(`/fill ${X0 - 6} ${Y} ${lane - 6} ${X0 + 6} ${Y} ${lane + 6} minecraft:water`)
  await cmd(`/setblock ${X0} ${Y} ${lane} minecraft:stone`) // тумба под ноги
  await sleep(1500)
  await give([
    'minecraft:obsidian 32',
    'minecraft:flint_and_steel 1',
    'minecraft:cobblestone 32',
    'minecraft:iron_pickaxe 1'
  ])
  await standAt(lane, Y + 1)

  const before = await world(OBSERVE)
  console.log('  мир до:', JSON.stringify(before.map), '| под ногами:', before.terrain.standingOn)
  check('вода действительно налита', cnt(before, 'water') > 0, `water=${cnt(before, 'water')}`)
  check('бот стоит на тумбе, а не в воде', before.terrain.standingOn === 'stone',
    `standingOn=${before.terrain.standingOn}`)
  check('чужого портала рядом нет', cnt(before, 'nether_portal') === 0, `nether_portal=${cnt(before, 'nether_portal')}`)

  const r: any = await step('portal', 'portal', { timeoutSeconds: 60, scan: SCAN })
  const d = r.detail || {} as Record<string, any>
  const after = await world(OBSERVE)
  const inv = await snapshot()
  console.log('  мир после:', JSON.stringify(after.map))
  console.log('  отказ:', d.stopped)

  check('не построил', d.built === false, `built=${d.built}`)
  check('обсидиан не потрачен', (inv.obsidian || 0) === 32, `obsidian=${inv.obsidian}`)
  check('в мире рамы нет', cnt(after, 'obsidian') === 0, `obsidian=${cnt(after, 'obsidian')}`)
  check('отказ называет воду', /вода/.test(d.stopped || ''), d.stopped)
  check('и говорит, что делать', /Отойди|прокопай/.test(d.stopped || ''), d.stopped)
}

// ---------------------------------------------------------------- 7

// Коробка 5x5x3 из бедрока: рама 4x5 в неё не влезает ни по одной оси, и
// прокопать выход нечем.
async function sceneTight () {
  console.log('\n=== 7. места под раму нет: отказ говорит, чего не хватает ===')
  const lane = LANES.tight
  await arena(lane, { floor: 'bedrock' })
  await forgetPortal()
  await cmd(`/fill ${X0 - 6} ${Y + 1} ${lane - 6} ${X0 + 6} ${Y + 8} ${lane + 6} minecraft:bedrock`)
  await cmd(`/fill ${X0 - 2} ${Y + 1} ${lane - 2} ${X0 + 2} ${Y + 3} ${lane + 2} minecraft:air`)
  await sleep(1500)
  await give([
    'minecraft:obsidian 32',
    'minecraft:flint_and_steel 1',
    'minecraft:cobblestone 32',
    'minecraft:diamond_pickaxe 1' // чтобы отказ не свалился на «нечем копать»
  ])
  await standAt(lane, Y + 1)

  const before = await world(OBSERVE)
  console.log('  мир до:', JSON.stringify(before.map), '| под ногами:', before.terrain.standingOn)
  check('коробка построилась: под ногами бедрок', before.terrain.standingOn === 'bedrock',
    `standingOn=${before.terrain.standingOn}`)
  check('обсидиана в мире нет', cnt(before, 'obsidian') === 0, `obsidian=${cnt(before, 'obsidian')}`)

  const r: any = await step('portal', 'portal', { timeoutSeconds: 60, scan: SCAN })
  const d = r.detail || {} as Record<string, any>
  const after = await world(OBSERVE)
  const inv = await snapshot()
  console.log('  мир после:', JSON.stringify(after.map))
  console.log('  отказ:', d.stopped)

  check('не построил', d.built === false, `built=${d.built}`)
  check('отказ про место, а не про рюкзак', /Места под раму нет/.test(d.stopped || ''), d.stopped)
  check('отказ называет нужный размер рамы', /4x5/.test(d.stopped || ''), d.stopped)
  check('отказ говорит, что делать дальше', /прокопай|Отойди/.test(d.stopped || ''), d.stopped)
  check('обсидиан не потрачен', (inv.obsidian || 0) === 32, `obsidian=${inv.obsidian}`)
  check('в мире рамы нет', cnt(after, 'obsidian') === 0, `obsidian=${cnt(after, 'obsidian')}`)
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  try {
    await call('connect')
    await sceneBuild()
    await sceneShort()
    await sceneNoFire()
    await sceneNeighbour()
    await sceneResume()
    await sceneWater()
    await sceneTight()

    await cmd('/kill @e[type=!player]')
    await cmd('/gamerule fire_spread_radius_around_player 128')
    await cmd('/difficulty normal')
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

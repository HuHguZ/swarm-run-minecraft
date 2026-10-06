'use strict'
const gameClock = require('./src/game-clock')
const { createGameBot } = require('./scene-kit')
// Архитектор: mc_build, mc_sort, mc_sign.
//
// Что здесь проверяется и почему именно это:
//
//  1. ПОСТРОЙКИ ИЗ ГОТОВЫХ: хижина на первую ночь (А), дом с двускатной
//     крышей, окнами, дверью, светом и мебелью (Б), землянка, которую КОПАЮТ в
//     склоне (В), замок поменьше (Д), комната-база в шахте (З). Каждую судит не
//     ответ демона, а второй клиент — зритель BuildEye в режиме наблюдателя:
//     блоки читает он, и «built:true» без стен в мире здесь не пройдёт.
//  2. ОРИЕНТАЦИЯ. Сервер берёт facing ступени, двери, кровати из направления
//     игрока в момент клика (StairBlock/DoorBlock/BedBlock.getStateForPlacement
//     → BlockPlaceContext.getHorizontalDirection, байткод paper-1.21.11.jar),
//     а mineflayer.placeBlock смотрит в центр грани и выбирает его за нас.
//     Поэтому каждая ступень крыши сверяется: смотрит к коньку, а дверь — внутрь.
//  3. СКЛАД И ТАБЛИЧКИ (Г): текст пишется только тем, кого сервер назначил
//     редактором (SignBlockEntity.updateSignText: playerWhoMayEdit), — текст
//     читает зритель. Потом бардак в сундуке и mc_sort: в каждом сундуке после
//     сортировки только своя категория, по данным сундука, а не отчёта.
//  4. ОБРЫВ (Е): дом с таймаутом 25 с встаёт на полпути, повтор тем же вызовом
//     достраивает ТОТ ЖЕ дом (то же место), двери в мире одна.
//  5. ОТКАЗ ПО СМЕТЕ (Ж): десять досок на дом — отказ с need {what, count,
//     have} ДО того, как тронут мир: зритель считает блоки до и после.
//  6. ВОДА (И): названное место в пруду — отказ до стройки; своё место
//     автовыбор находит на суше.
//
// Запуск: node try-build.js (всё, ~12 мин) или ONLY=hut,storage node try-build.js.
//
// ГРАБЛИ, оплаченные этим файлом:
//  · pathfinder 2.4.5 открывать умеет только калитки (movements.js openable —
//    имена с «gate»): дверь, поставленная раньше крыши, запирала тело снаружи
//    своего же недостроенного дома. Дверь — последней, и снаружи;
//  · проём двери был полон земли в землянке, и тело копало комнату СНАРУЖИ
//    сквозь стену (сервер не смотрит линию взгляда при копании) — заднюю
//    стенку так и не достало. Проём вынимается первым;
//  · место встать выбиралось по близости, а не по достижимости: 5104 частичных
//    поиска pathfinder и 15 таймаутов на один дом, 243 с из 315 — ходьба;
//  · сразу после входа чанки ещё не пришли: вся постройка «висела в воздухе»;
//  · /tp в воздух над будущей площадкой убивает падением (slow_falling ДО /tp);
//  · леса под конёк встали в клетке прямо за дверью — и сами заперли тело
//    внутри: выход наружу искался, стоя на них. Сперва слезть, потом искать.
//  · в снежном биоме снег ложится на площадку сам: «мир не тронут» считал его.
//
// Сервер — свой, build (127.0.0.1:25566): правила игры и время меняются тут
// свободно. Демон — ND_WS (по умолчанию ws://127.0.0.1:8771), игрок NeuroBuild.
const path = require('path')
const Vec3 = require('vec3')
const { connect, createKit, sleep } = require('./scene-kit')
const sorting = require('./src/sorting')
const architect = require('./src/architect')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8771'
const PLAYER = process.env.ND_PLAYER || 'NeuroBuild'
const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 25566)
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', process.env.ND_SERVER_DIR || 'server-build', 'logs', 'latest.log')
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null
const mcData = require('minecraft-data')('1.21.11')

const Y = 150
const R = 20
const LANES = { hut: 1000, house: 1080, dugout: 1160, storage: 1240, castle: 1320, resume: 1400, refuse: 1480, mine: 1560, water: 1640 }
const Z0 = 1000
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east' }

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

const c = connect(WS)
const call = c.call
let kit = null
let eye = null

async function step (label, method, params) {
  const r = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const d = r.detail || {} as Record<string, any>
  const brief = { built: d.built, placed: d.placed, dug: d.dug, left: d.left, skipped: d.skipped, why: d.why, need: d.need, stopped: d.stopped, seconds: d.seconds, timing: d.timing }
  console.log(`${label.padEnd(24)} ${String(r.status).padEnd(10)} ${JSON.stringify(method === 'build' ? brief : d).slice(0, 600)}${r.error ? ' ← ' + r.error : ''}`)
  return r
}

// Зритель: второй клиент в режиме наблюдателя. Блоки мира читает он.
async function eyeOpen () {
  eye = createGameBot({ host: HOST, port: PORT, username: 'BuildEye', version: '1.21.11', auth: 'offline' })
  await new Promise<any>((resolve, reject) => { eye.once('spawn', resolve); eye.once('error', reject); eye.once('kicked', r => reject(new Error('зрителя выкинули: ' + r))) })
  await kit.cmd('/gamemode spectator BuildEye')
}

async function eyeTo (x, y, z) {
  await kit.cmd(`/tp BuildEye ${x} ${y} ${z}`)
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 15000) {
    const p = eye.entity && eye.entity.position
    if (p && Math.abs(p.x - x) < 2 && Math.abs(p.z - z) < 2 && eye.blockAt(new Vec3(x, Y, z))) break
    await sleep(300)
  }
  await sleep(1500)
}

const at = (x, y, z) => eye.blockAt(new Vec3(x, y, z))
const props = b => { try { return b.getProperties() } catch { return {} as Record<string, any> } }
const solid = b => !!b && b.boundingBox === 'block'
function scan (x1, y1, z1, x2, y2, z2, fn) {
  const out = []
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
        const b = at(x, y, z)
        if (b && fn(b)) out.push(b)
      }
    }
  }
  return out
}

// Площадка на высоте Y: 41×41 травы, воздух на двадцать вверх, зритель над ней.
async function arena (X, gives, { extra = null }: any = {} as Record<string, any>) {
  await call('stop')
  await sleep(500)
  await kit.cmd('/effect give @s minecraft:resistance 900 4 true')
  await kit.cmd('/effect give @s minecraft:slow_falling 25 1 true')
  await kit.cmd(`/tp @s ${X} ${Y + 2} ${Z0}`)
  await sleep(3000)
  await kit.fillExact(null, [[X - R, Y - 3, Z0 - R], [X + R, Y, Z0 + R]], 'grass_block')
  await kit.fillExact(null, [[X - R, Y + 1, Z0 - R], [X + R, Y + 10, Z0 + R]], 'air')
  await kit.fillExact(null, [[X - R, Y + 11, Z0 - R], [X + R, Y + 20, Z0 + R]], 'air')
  if (extra) await extra(X)
  await kit.cmd(`/tp @s ${X} ${Y + 1} ${Z0}`)
  await kit.cmd(`/spawnpoint @s ${X} ${Y + 1} ${Z0}`)
  await kit.cmd('/effect clear @s minecraft:slow_falling')
  await kit.cmd('/kill @e[type=!player,distance=..60]')
  await kit.cmd('/clear @s')
  for (const [item, n] of gives) await kit.must(`/give @s ${item} ${n}`, /^Gave \d+ /, `не выдан ${item}`)
  await call('build', { mode: 'forget' })
  await eyeTo(X, Y + 14, Z0)
  await sleep(800)
}

async function bag () {
  const s = await call('status')
  return (s.state && s.state.inventory) || {} as Record<string, any>
}

// Прямоугольник постройки по отчёту: угол at, размеры size (с крыльцом и свесом).
const rect = d => ({ x1: d.at.x, z1: d.at.z, x2: d.at.x + d.size.w - 1, z2: d.at.z + d.size.d - 1, y0: d.at.y })

async function buildUntil (label, params, maxCalls = 3) {
  let r = null
  let calls = 0
  let placed = 0
  while (calls < maxCalls) {
    calls++
    r = await step(`${label} #${calls}`, 'build', params)
    if (r.detail) placed += r.detail.placed || 0
    if (!r.detail || r.detail.built || r.status !== 'done' || r.detail.built === undefined) break
    if (r.detail.need) break
  }
  return { r, calls, placed }
}

// ------------------------------------------------------------------ cases

async function caseHut () {
  console.log('\n(А) хижина-укрытие на первую ночь: земля, дверь, факел')
  const X = LANES.hut
  await arena(X, [['dirt', 64], ['oak_door', 1], ['torch', 4]])
  const before = await bag()
  const { r } = await buildUntil('hut', { kind: 'hut', timeoutSeconds: 200 })
  const d = r.detail || {} as Record<string, any>
  check('хижина построена', d.built === true, JSON.stringify({ left: d.left, why: d.why }))
  if (!d.at) return
  await eyeTo(X, Y + 12, Z0)
  const q = rect(d)
  const roof = scan(q.x1, Y + 3, q.z1, q.x2, Y + 3, q.z2, solid).length
  const l1 = scan(q.x1, Y + 1, q.z1, q.x2, Y + 1, q.z2, solid).length
  const l2 = scan(q.x1, Y + 2, q.z1, q.x2, Y + 2, q.z2, solid).length
  check('крыша 5×5 целиком', roof === 25, `твёрдых на y+3: ${roof}`)
  check('стены по периметру на обеих высотах (16 = 15 блоков + дверь)', l1 === 16 && l2 === 16, `y+1: ${l1}, y+2: ${l2}`)
  const e = d.entrance
  const lo = at(e.x, e.y, e.z); const hi = at(e.x, e.y + 1, e.z)
  check('дверь целая: нижняя и верхняя половины', lo && hi && lo.name === 'oak_door' && props(lo).half === 'lower' && hi.name === 'oak_door' && props(hi).half === 'upper',
    `${lo && lo.name}/${lo && props(lo).half} над ней ${hi && hi.name}/${hi && props(hi).half}`)
  check('дверь смотрит внутрь (facing против фасада)', lo && props(lo).facing === OPP[d.front], `facing ${lo && props(lo).facing}, фасад ${d.front}`)
  const torches = scan(q.x1, Y + 1, q.z1, q.x2, Y + 3, q.z2, b => /torch/.test(b.name))
  check('факел внутри', torches.length >= 1, torches.map(b => b.name).join(','))
  const after = await bag()
  const spent = (before.dirt - (after.dirt || 0)) + (before.oak_door - (after.oak_door || 0)) + (before.torch - (after.torch || 0))
  check('ушло из рюкзака ровно столько, сколько поставлено', spent === d.placed, `ушло ${spent}, placed ${d.placed}`)
  const me = (await call('status')).state.pos
  check('тело снаружи, не замуровано', !(me.x > q.x1 && me.x < q.x2 && me.z > q.z1 && me.z < q.z2 && me.y <= Y + 3), JSON.stringify(me))
}

async function caseHouse () {
  console.log('\n(Б) дом: двускатная крыша со свесом, окна, дверь, свет, мебель')
  const X = LANES.house
  await arena(X, [['spruce_planks', 256], ['spruce_log', 32], ['spruce_stairs', 128], ['spruce_slab', 32], ['glass_pane', 32],
    ['spruce_door', 2], ['torch', 16], ['dirt', 64], ['red_bed', 1], ['chest', 1], ['crafting_table', 1]])
  const pv = await step('preview', 'build', { mode: 'preview', kind: 'house', material: 'spruce', furnish: true })
  const p = pv.detail || {} as Record<string, any>
  check('смета до стройки: хватает, фраза для чата есть', p.verdict === 'хватает' && typeof p.say === 'string', p.say)
  const { r, calls } = await buildUntil('house', { kind: 'house', material: 'spruce', furnish: true, timeoutSeconds: 480 }, 3)
  const d = r.detail || {} as Record<string, any>
  check('дом достроен', d.built === true, `вызовов ${calls}; left ${d.left} ${JSON.stringify(d.why || {} as Record<string, any>)}`)
  check('место то же, что в смете', p.at && d.at && p.at.x === d.at.x && p.at.z === d.at.z, `${JSON.stringify(p.at)} → ${JSON.stringify(d.at)}`)
  if (!d.at) return
  await eyeTo(X, Y + 14, Z0)
  const q = rect(d)
  const cx = (q.x1 + q.x2) / 2; const cz = (q.z1 + q.z2) / 2
  const alongZ = d.front === 'north' || d.front === 'south'
  const stairs = scan(q.x1, Y + 1, q.z1, q.x2, Y + 10, q.z2, b => b.name === 'spruce_stairs')
  const wrong = stairs.filter(b => {
    const f = props(b).facing
    const want = alongZ ? (b.position.x < cx ? 'east' : 'west') : (b.position.z < cz ? 'south' : 'north')
    return f !== want || props(b).half !== 'bottom'
  })
  check('88 ступеней крыши, и каждая смотрит к коньку', stairs.length === 88 && wrong.length === 0,
    `ступеней ${stairs.length}, не туда ${wrong.length}${wrong[0] ? ` (напр. ${wrong[0].position} ${JSON.stringify(props(wrong[0]))})` : ''}`)
  const slabs = scan(q.x1, Y + 1, q.z1, q.x2, Y + 10, q.z2, b => b.name === 'spruce_slab')
  check('конёк из плит', slabs.length === 11, `плит ${slabs.length}`)
  const e = d.entrance
  const lo = at(e.x, e.y, e.z); const hi = at(e.x, e.y + 1, e.z)
  check('дверь: обе половины, смотрит внутрь', lo && hi && lo.name === 'spruce_door' && hi.name === 'spruce_door' && props(lo).facing === OPP[d.front],
    `${lo && lo.name} ${JSON.stringify(lo && props(lo))}`)
  const panes = scan(q.x1, Y + 1, q.z1, q.x2, Y + 4, q.z2, b => b.name === 'glass_pane')
  check('окна стеклом', panes.length >= 8, `панелей ${panes.length}`)
  const torches = scan(q.x1 - 1, Y + 1, q.z1 - 1, q.x2 + 1, Y + 4, q.z2 + 1, b => b.name === 'wall_torch')
  check('свет: факелы на стенах внутри и у входа', torches.length >= 3, `настенных факелов ${torches.length}`)
  const bed = scan(q.x1, Y + 1, q.z1, q.x2, Y + 1, q.z2, b => b.name === 'red_bed')
  const chest = scan(q.x1, Y + 1, q.z1, q.x2, Y + 1, q.z2, b => b.name === 'chest')
  const table = scan(q.x1, Y + 1, q.z1, q.x2, Y + 1, q.z2, b => b.name === 'crafting_table')
  check('мебель: кровать целиком, сундук, верстак', bed.length === 2 && chest.length === 1 && table.length === 1,
    `кровать ${bed.map(b => props(b).part).join('+')}, сундук ${chest.length}, верстак ${table.length}`)
  const logs = scan(q.x1, Y + 1, q.z1, q.x2, Y + 4, q.z2, b => b.name === 'spruce_log' && props(b).axis === 'y')
  check('каркас: брёвна по углам стоя', logs.length === 16, `вертикальных брёвен ${logs.length}`)
  const me = (await call('status')).state.pos
  const walls = { x1: q.x1 + 1, x2: q.x2 - 1, z1: q.z1 + 1, z2: q.z2 - 1 }
  check('тело снаружи: дверь ставилась последней и снаружи', !(me.x > walls.x1 && me.x < walls.x2 && me.z > walls.z1 && me.z < walls.z2), JSON.stringify(me))
  check('леса разобраны', !d.towersLeft, JSON.stringify(d.towersLeft || null))
}

async function caseDugout () {
  console.log('\n(В) землянка: склон ищет сама и КОПАЕТ комнату, а не строит')
  const X = LANES.dugout
  const hill = async X => {
    await kit.fillExact(null, [[X - 8, Y + 1, Z0 + 4], [X + 8, Y + 7, Z0 + 15]], 'dirt')
    await kit.fillExact(null, [[X - 8, Y + 8, Z0 + 4], [X + 8, Y + 8, Z0 + 15]], 'grass_block')
  }
  await arena(X, [['dirt', 32], ['oak_door', 1], ['torch', 4], ['wooden_shovel', 1]], { extra: hill })
  const { r } = await buildUntil('dugout', { kind: 'dugout', timeoutSeconds: 240 })
  const d = r.detail || {} as Record<string, any>
  check('землянка готова', d.built === true, JSON.stringify({ left: d.left, why: d.why }))
  check('склон нашла сама, вход смотрит из холма', d.front === 'north', `фасад ${d.front}`)
  check('копала, а не строила', (d.dug || 0) >= 30 && (d.placed || 0) <= 6, `выкопано ${d.dug}, поставлено ${d.placed}`)
  if (!d.entrance) return
  await eyeTo(X, Y + 12, Z0 + 4)
  const e = d.entrance
  const lo = at(e.x, e.y, e.z)
  check('дверь в проёме', lo && lo.name === 'oak_door' && props(lo).half === 'lower', lo && lo.name)
  // Комната за дверью: 3 в ширину, 4 вглубь, 3 в высоту — воздух; вокруг — земля.
  const room = scan(e.x - 1, e.y, e.z + 1, e.x + 1, e.y + 2, e.z + 4, b => b.boundingBox === 'empty')
  check('комната 3×4×3 выкопана', room.length === 36, `пустых клеток ${room.length} из 36`)
  const shell = [
    ...scan(e.x - 2, e.y, e.z + 1, e.x - 2, e.y + 2, e.z + 4, b => true),
    ...scan(e.x + 2, e.y, e.z + 1, e.x + 2, e.y + 2, e.z + 4, b => true),
    ...scan(e.x - 1, e.y + 3, e.z + 1, e.x + 1, e.y + 3, e.z + 4, b => true),
    ...scan(e.x - 1, e.y, e.z + 5, e.x + 1, e.y + 2, e.z + 5, b => true)
  ]
  check('стены, потолок и задняя стенка целы', shell.every(solid), `твёрдых ${shell.filter(solid).length} из ${shell.length}`)
  const torch = scan(e.x - 1, e.y, e.z + 1, e.x + 1, e.y + 2, e.z + 4, b => /torch/.test(b.name))
  check('факел внутри', torch.length === 1, torch.map(b => b.name).join(','))
}

async function caseStorage () {
  console.log('\n(Г) склад: сундуки с табличками, бардак, mc_sort, mc_sign')
  const X = LANES.storage
  const cats = ['ores', 'blocks', 'food', 'mob', 'rare', 'misc']
  await arena(X, [['chest', 6], ['oak_sign', 7], ['cobblestone', 64], ['torch', 8], ['iron_ingot', 5], ['raw_iron', 3],
    ['diamond', 2], ['bread', 20], ['rotten_flesh', 7], ['bone', 4], ['string', 3], ['enchanted_book', 1], ['dirt', 20],
    ['stick', 12], ['flint', 3], ['stone_pickaxe', 1]])
  const { r } = await buildUntil('storage', { kind: 'storage', material: 'cobblestone', categories: cats, timeoutSeconds: 240 })
  const d = r.detail || {} as Record<string, any>
  check('склад построен, таблички записаны', d.built === true && d.signs === 6, JSON.stringify({ left: d.left, signs: d.signs, signFails: d.signFails }))
  if (!d.at) return
  await eyeTo(X, Y + 10, Z0)
  const q = rect(d)
  const chests = scan(q.x1, Y + 1, q.z1, q.x2, Y + 1, q.z2, b => b.name === 'chest')
  const labelled = []
  for (const ch of chests) {
    const sign = at(ch.position.x, Y + 2, ch.position.z)
    const t = sign && /_sign$/.test(sign.name) ? architect.signText(eye, sign.position) : null
    const text = t ? t.front.join(' ') : ''
    labelled.push({ at: ch.position, text, cat: sorting.categoryFromText(text), type: props(ch).type })
  }
  check('шесть одиночных сундуков, над каждым табличка своей категории',
    chests.length === 6 && labelled.every(l => l.cat) && new Set(labelled.map(l => l.cat)).size === 6 && labelled.every(l => l.type === 'single'),
    labelled.map(l => `${l.text || '—'}(${l.type})`).join('; '))
  // Бардак: гнилую плоть — в сундук с едой.
  const food = labelled.find(l => l.cat === 'food')
  if (food) {
    await step('бардак в «Еду»', 'chest_put', { item: 'rotten_flesh', x: food.at.x, y: food.at.y, z: food.at.z })
  }
  const s = await step('sort', 'sort', { timeoutSeconds: 300 })
  const sd = s.detail || {} as Record<string, any>
  check('mc_sort отработал', sd.sorted === true, sd.note)
  // Проверка по самим сундукам: в каждом только своя категория.
  const bad = []
  for (const l of labelled) {
    const lr = await call('chest_list', { x: l.at.x, y: l.at.y, z: l.at.z })
    const items = (lr.detail && lr.detail.contents) || {} as Record<string, any>
    for (const n of Object.keys(items)) if (sorting.categoryOf(n, mcData) !== l.cat) bad.push(`${n} в «${l.text}»`)
    l.items = items
  }
  check('в каждом сундуке только своя категория', bad.length === 0, bad.join('; ') || labelled.map(l => `${l.cat}:${Object.keys(l.items).join('+')}`).join(' '))
  const mob = labelled.find(l => l.cat === 'mob')
  check('гнилая плоть переехала из «Еды» в «Мобьё»', mob && mob.items.rotten_flesh === 7 && !(food.items || {} as Record<string, any>).rotten_flesh, JSON.stringify(mob && mob.items))
  const b = await bag()
  const loose = Object.keys(b).filter(n => ['iron_ingot', 'raw_iron', 'diamond', 'rotten_flesh', 'bone', 'string', 'enchanted_book', 'dirt', 'flint'].includes(n))
  check('в рюкзаке не осталось разложимого, снаряжение при себе', !loose.length && b.stone_pickaxe === 1 && b.stick === 8, `осталось ${JSON.stringify(b)}`)
  // Переписать табличку.
  if (food) {
    const signAt = { x: food.at.x, y: Y + 2, z: food.at.z }
    await step('mc_sign переписать', 'sign', { ...signAt, text: 'Еда|не трогать!' })
    await sleep(800)
    const t = architect.signText(eye, new Vec3(signAt.x, signAt.y, signAt.z))
    check('зритель видит новый текст таблички', t && t.front[0] === 'Еда' && t.front[1] === 'не трогать!', JSON.stringify(t))
  }
}

async function caseCastle () {
  console.log('\n(Д) замок поменьше: стена с зубцами, четыре башни, ворота')
  const X = LANES.castle
  await arena(X, [['cobblestone', 384], ['torch', 8], ['ladder', 4], ['dirt', 64]])
  const { r, calls, placed } = await buildUntil('castle', { kind: 'castle', width: 9, height: 3, material: 'cobblestone', timeoutSeconds: 480 }, 3)
  const d = r.detail || {} as Record<string, any>
  check('замок достроен', d.built === true, `вызовов ${calls}, поставлено ${placed}; left ${d.left} ${JSON.stringify(d.why || {} as Record<string, any>)}`)
  if (!d.at) return
  await eyeTo(X, Y + 14, Z0)
  const q = rect(d)
  // Квадрат 9×9 — прямоугольник без ряда перед воротами.
  const S = 9
  const sq: Record<string, any> = { x1: q.x1, z1: q.z1, x2: q.x2, z2: q.z2 }
  if (d.front === 'south') sq.z2 = sq.z1 + S - 1
  if (d.front === 'north') sq.z1 = sq.z2 - S + 1
  if (d.front === 'east') sq.x2 = sq.x1 + S - 1
  if (d.front === 'west') sq.x1 = sq.x2 - S + 1
  const H = 3
  const corners = [[sq.x1, sq.z1], [sq.x2, sq.z1], [sq.x1, sq.z2], [sq.x2, sq.z2]]
  const towers = corners.filter(([x, z]: any) => solid(at(x, Y + H + 2, z)) && solid(at(x, Y + H + 3, z)))
  check('четыре угловые башни выше стены, с зубцом на углу', towers.length === 4, `башен ${towers.length}`)
  // Зубцы — на верху стен между башнями, через один: по два на сторону при 9×9.
  const tower = b => (b.position.x - sq.x1 < 3 || sq.x2 - b.position.x < 3) && (b.position.z - sq.z1 < 3 || sq.z2 - b.position.z < 3)
  const merlons = scan(sq.x1, Y + H + 1, sq.z1, sq.x2, Y + H + 1, sq.z2, b => solid(b) && !tower(b)).length
  check('зубцы на стенах через один', merlons === 8, `зубцов на y+${H + 1}: ${merlons}`)
  const e = d.entrance
  const gate = [at(e.x, e.y, e.z), at(e.x, e.y + 1, e.z)]
  check('ворота открыты: проём 1×2 в стене', gate.every(b => b && b.boundingBox === 'empty') && solid(at(e.x, e.y + 2, e.z)),
    `${gate.map(b => b && b.name).join('/')}, над ними ${(at(e.x, e.y + 2, e.z) || {} as Record<string, any>).name}`)
  const walls = scan(sq.x1, Y + 1, sq.z1, sq.x2, Y + H, sq.z2, b => b.name === 'cobblestone').length
  check('стены и башни стоят', walls >= 140, `булыжника на высоте стен ${walls}`)
  check('леса разобраны', !d.towersLeft, JSON.stringify(d.towersLeft || null))
}

async function caseResume () {
  console.log('\n(Е) обрыв на полпути и продолжение тем же вызовом')
  const X = LANES.resume
  await arena(X, [['oak_planks', 192], ['oak_log', 16], ['oak_stairs', 64], ['oak_slab', 16], ['oak_door', 2], ['torch', 8], ['dirt', 32]])
  const params = { kind: 'house', material: 'oak', width: 5, depth: 7, windows: false }
  const a = await step('house, 25 с', 'build', { ...params, timeoutSeconds: 25 })
  const ad = a.detail || {} as Record<string, any>
  check('первый вызов встал на полпути с отчётом', ad.built === false && ad.placed > 0 && ad.left > 0, `placed ${ad.placed}, left ${ad.left}, stopped «${ad.stopped}»`)
  const b = await buildUntil('house, повтор', { ...params, timeoutSeconds: 300 }, 2)
  const bd = b.r.detail || {} as Record<string, any>
  check('повтор узнал свой дом и достроил', bd.built === true && bd.site && bd.site.how === 'продолжаю начатое', JSON.stringify({ built: bd.built, site: bd.site, left: bd.left }))
  check('то же место', ad.at && bd.at && ad.at.x === bd.at.x && ad.at.y === bd.at.y && ad.at.z === bd.at.z, `${JSON.stringify(ad.at)} → ${JSON.stringify(bd.at)}`)
  check('второй вызов не ставил заново поставленное', !bd.redo && bd.standing >= ad.placed, `стояло ${bd.standing}, первым вызовом поставлено ${ad.placed}, redo ${bd.redo}`)
  await eyeTo(X, Y + 12, Z0)
  const doors = scan(X - R, Y + 1, Z0 - R, X + R, Y + 2, Z0 + R, b => b.name === 'oak_door')
  check('в мире один дом: одна дверь (две половины)', doors.length === 2, `дверных блоков ${doors.length}`)
}

async function caseRefuse () {
  console.log('\n(Ж) отказ по смете: десять досок на дом')
  const X = LANES.refuse
  await arena(X, [['oak_planks', 10], ['torch', 4]])
  await eyeTo(X, Y + 12, Z0)
  const count = () => scan(X - R, Y + 1, Z0 - R, X + R, Y + 8, Z0 + R, b => b.name !== 'air' && b.name !== 'snow').length +
    scan(X - R, Y, Z0 - R, X + R, Y, Z0 + R, b => b.name !== 'grass_block').length
  const before = count()
  const r = await step('house из 10 досок', 'build', { kind: 'house', material: 'oak', timeoutSeconds: 60 })
  const d = r.detail || {} as Record<string, any>
  check('отказ: built=false и stopped «НЕ СТРОЮ»', d.built === false && /^НЕ СТРОЮ/.test(d.stopped || ''), d.stopped)
  check('need {what, count, have} с числами', d.need && d.need.what === 'oak_planks' && d.need.have === 10 && d.need.count > 100, JSON.stringify(d.need))
  check('в отказе — из чего сделать', Array.isArray(d.short) && d.short.some(s => s.craft), JSON.stringify((d.short || []).map(s => s.craft)))
  await sleep(1000)
  const after = count()
  const b = await bag()
  check('мир не тронут и рюкзак цел', before === after && b.oak_planks === 10, `блоков до ${before}, после ${after}; досок ${b.oak_planks}`)
}

// Вода: названное место в пруду — отказ до стройки, а своё место — мимо пруда.
async function caseWater () {
  console.log('\n(И) вода: в пруду не строит, место выбирает мимо него')
  const X = LANES.water
  const pond = async X => { await kit.fillExact(null, [[X - 20, Y, Z0 - 20], [X + 20, Y, Z0 + 2]], 'water') }
  await arena(X, [['cobblestone', 64], ['torch', 2]], { extra: pond })
  await kit.cmd(`/tp @s ${X} ${Y + 1} ${Z0 + 8}`)
  await sleep(1500)
  const r = await step('hut в пруду', 'build', { kind: 'hut', material: 'cobblestone', origin: { x: X - 2, y: Y, z: Z0 - 6 } })
  const d = r.detail || {} as Record<string, any>
  check('в воде не строит: отказ с причиной', d.built === false && /НЕ СТРОЮ/.test(d.stopped || '') && /water/.test(d.stopped || ''), d.stopped)
  const p = await step('hut где сам решит', 'build', { mode: 'preview', kind: 'hut', material: 'cobblestone' })
  const pd = p.detail || {} as Record<string, any>
  check('своё место — на суше', pd.at && pd.at.z > Z0 + 3 && pd.verdict === 'хватает', JSON.stringify({ at: pd.at, verdict: pd.verdict }))
}

async function caseMine () {
  console.log('\n(З) комната-база в шахте прямо перед телом')
  const X = LANES.mine
  const rock = async X => {
    await kit.fillExact(null, [[X - 10, Y - 14, Z0 - 10], [X + 10, Y - 2, Z0 + 10]], 'stone')
    await kit.fillExact(null, [[X, Y - 9, Z0 - 8], [X, Y - 8, Z0 - 4]], 'air')
  }
  await arena(X, [['stone_pickaxe', 1], ['torch', 8], ['cobblestone', 32], ['chest', 1], ['crafting_table', 1], ['furnace', 1]], { extra: rock })
  await kit.cmd(`/tp @s ${X} ${Y - 9} ${Z0 - 6} 0 0`)
  await sleep(2000)
  const { r } = await buildUntil('mine_room', { kind: 'mine_room', direction: 'south', furnish: true, timeoutSeconds: 300 })
  const d = r.detail || {} as Record<string, any>
  check('комната в шахте готова', d.built === true, JSON.stringify({ left: d.left, why: d.why }))
  if (!d.entrance) return
  await eyeTo(X, Y - 20, Z0)
  await kit.cmd(`/tp BuildEye ${X} ${Y - 7} ${Z0}`)
  await sleep(2000)
  const e = d.entrance
  const room = scan(e.x - 2, e.y, e.z + 1, e.x + 2, e.y + 2, e.z + 5, b => b.boundingBox === 'empty' || /torch/.test(b.name))
  const furn = scan(e.x - 2, e.y, e.z + 1, e.x + 2, e.y, e.z + 5, b => /^(chest|crafting_table|furnace)$/.test(b.name))
  const lights = scan(e.x - 2, e.y, e.z + 1, e.x + 2, e.y + 2, e.z + 5, b => b.name === 'wall_torch')
  check('выкопано 5×5×3 (кроме мебели)', room.length + furn.length === 75, `пусто ${room.length}, мебель ${furn.length}`)
  check('мебель: сундук, верстак, печь', furn.length === 3, furn.map(b => b.name).join(','))
  check('факелы на стенах', lights.length >= 2, `факелов ${lights.length}`)
}

// ------------------------------------------------------------------ run

;(async () => {
  await c.ready
  kit = createKit({ call, heard: c.heard, player: PLAYER, logFile: LOG })
  await call('connect')
  await call('stop')
  await kit.gamerule('advance_time', 'false')
  await kit.gamerule('spawn_mobs', 'false')
  // Снег: в снежном биоме слой снега ложится на площадку сам, и счёт «мир не
  // тронут» видел шесть новых блоков, которых никто не ставил.
  await kit.gamerule('advance_weather', 'false')
  await kit.cmd('/weather clear')
  await kit.cmd('/time set day')
  await eyeOpen()
  const cases = { hut: caseHut, house: caseHouse, dugout: caseDugout, storage: caseStorage, castle: caseCastle, resume: caseResume, refuse: caseRefuse, mine: caseMine, water: caseWater }
  for (const [name, fn] of Object.entries<any>(cases)) {
    if (ONLY && !ONLY.includes(name)) continue
    try { await fn() } catch (e) { check(`${name}: сцена упала`, false, e.message) }
  }
  console.log(`\n${failures ? `ПЛОХО: ${failures}` : 'всё зелёное'}`)
  try { eye.quit() } catch {}
  c.close()
  process.exit(failures ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })

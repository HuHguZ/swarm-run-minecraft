'use strict'
const gameClock = require('./src/game-clock')
// Арена: два NeuroDown дерутся друг с другом через свои демоны, чтобы PvP
// оттачивался на равном противнике, а человек смотрел со стороны.
//
// Запуск (два демона на тестовом Paper, 25565):
//   ND_WS_PORT=8767 MC_USERNAME=NeuroDown  -> первый (оп, раздаёт предметы)
//   ND_WS_PORT=8768 MC_USERNAME=NeuroDown2 -> второй
//   node arena.js [раундов на набор] [фильтр набора]
// Чары на все предметы наборов, равной силы, пары раундов с обменом —
// ARENA_ENCH*, ARENA_PAIR (у kitSides; 2026-09-26). Чётное число раундов —
// пары целые.
//
// Смотреть: клиент 1.21.11, сервер 127.0.0.1:25565, арена на 200 100 200 —
// стеклянная коробка без крыши. ARENA_STYLE=colosseum — Колизей вокруг поля
// (colosseum.js, build-colosseum.js; см. STYLE ниже).
const WebSocket = require('ws')
const fs = require('fs')
const path = require('path')

const A_URL = process.env.ARENA_A || 'ws://127.0.0.1:8767'
const B_URL = process.env.ARENA_B || 'ws://127.0.0.1:8768'
const ROUNDS = Number(process.argv[2] || 1) // 0 — без конца, пока в чат не напишут «хватит»
// Без таймера: раунд до смерти бота или всех людей.
const NOTIMER = !!process.env.ARENA_NOTIMER
// «хватит» в чате — стоп. Читаем лог клиента хоста (там весь чат сервера).
const MC_LOG = path.join(process.env.APPDATA || '', '.minecraft', 'logs', 'latest.log')
const startedAt = gameClock.wall.now()
function stopRequested () {
  try {
    const st = fs.statSync(MC_LOG)
    const fd = fs.openSync(MC_LOG, 'r')
    const len = Math.min(st.size, 20000)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    const now = new Date()
    return buf.toString('utf8').split('\n').some(l => {
      const m = l.match(/^\[(\d\d):(\d\d):(\d\d)\] \[Server thread\/INFO\]: (?:\[Not Secure\] )?<[^>]+> .*хватит/i)
      if (!m) return false
      const t = new Date(now); t.setHours(+m[1], +m[2], +m[3], 0)
      return t.getTime() > startedAt
    })
  } catch { return false }
}
const ONLY = process.argv[3] || null
// Лог и замок — по порту первого бойца: тестовая арена агентов на своём
// сервере не должна гасить живую арену в мире пользователя (8765).
const A_PORT = (A_URL.match(/:(\d+)\/?$/) || [])[1] || 'x'
const LOG = path.join(__dirname, A_PORT === '8765' ? 'arena.log' : `arena-${A_PORT}.log`)

const sleep = ms => gameClock.sleep(ms)
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`
  console.log(line)
  fs.appendFileSync(LOG, line + '\n')
}

// Both bots share server ticks; keep the first connection as the time source.
let clockSource = null
function client (url) {
  clockSource ??= url
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString()); if (url === clockSource) gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}

// Одна арена за раз: вторая копия (незаметно оставшаяся от прерванного
// запуска) посреди боя начинала свой раунд и перевыдавала всем вещи.
const LOCK = path.join(__dirname, A_PORT === '8765' ? 'arena.lock' : `arena-${A_PORT}.lock`)
try { const old = Number(fs.readFileSync(LOCK, 'utf8')); if (old && old !== process.pid) { try { process.kill(old) } catch {} } } catch {}
fs.writeFileSync(LOCK, String(process.pid))
process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK) } catch {} })

const A = client(A_URL)
// ARENA_HUMAN=Ник — второй боец живой человек: ему только выдаём и телепортируем,
// а победу считаем по бою NeuroDown. ARENA_WATCH=Ник — зритель в режиме наблюдателя.
// Можно несколько через запятую — тогда люди командой против NeuroDown.
const HUMANS = (process.env.ARENA_HUMAN || '').split(',').map(x => x.trim()).filter(Boolean)
const HUMAN = HUMANS[0] || null
const WATCH = process.env.ARENA_WATCH || null
const humanStub = { ready: Promise.resolve(), ws: { close () {} }, call: async (m) => m === 'status' ? { state: { health: 20, inventory: { any: 1 } } } : { status: 'done', detail: {} } }
const B = HUMAN ? humanStub : client(B_URL)
const NA = 'NeuroDown'
const NB = HUMANS.length > 1 ? HUMANS.join('+') : HUMAN || 'NeuroDown2'

// Антиспам ванильного сервера: +20 за сообщение, −1 за тик, кик после 200 —
// и LAN-бот не оператор, так что его это касается (ECONNRESET 2026-09-25 на
// выдаче «арсенала»: 40 команд по 350 мс). Держим счётчик ниже 140.
//
// Но кикает он только не-операторов, а в LAN с читами оператор каждый
// (allowCommandsForAllPlayers): в логе хоста за 2026-09-25 ни одного кика за
// спам — отключения были от удара по себе. Счётчик растягивал выдачу арсенала
// до минут («ждёшь полчаса, пока предметы выдаются»), так что он включается
// только ARENA_THROTTLE=1 — на чужом сервере, где бот не оп.
const THROTTLE = !!process.env.ARENA_THROTTLE
let spam = 0
let spamAt = gameClock.now()
async function cmd (text) {
  if (THROTTLE) {
    const decay = () => { const now = gameClock.now(); spam = Math.max(0, spam - (now - spamAt) / 50); spamAt = now }
    decay()
    if (spam + 20 > 185) { await sleep((spam + 20 - 185) * 50); decay() }
  }
  await A.call('say', { text })
  spam += 20
  if (THROTTLE) await sleep(60)
}

// Где ставить арену: ARENA_POS="x y z" (y — уровень пола, на котором стоят).
// В чужом мире (ARENA_GENTLE=1) правила игры, время и точки возрождения не трогаем.
const POS = (process.env.ARENA_POS || '200 100 200').split(/\s+/).map(Number)
const X = POS[0]; const Y = POS[1]; const Z = POS[2]
const GENTLE = !!process.env.ARENA_GENTLE
// Пол: обсидиан, чтобы в драке не проламывали дыры (киркой 9 с на блок).
const FLOOR = 'minecraft:' + (process.env.ARENA_FLOOR || 'smooth_stone')

// Стиль (2026-09-26): classic — стеклянная коробка, как было; colosseum —
// Колизей вокруг поля (colosseum.js; строится один раз build-colosseum.js или
// здесь при первом запуске, флаг colosseum-built.json). В нём сдерживание
// поля — сплошной барьер от слоя пола до потолка по всему периметру: взрывы
// до силы 6 наружу не проходят (дно щели у стены и фундамент — обсидиан);
// потолок всегда (ARENA_CEIL=0 — снять); свет поля — светокамень вдоль x
// (взрыв выбивает — дыр больше) и плачущий обсидиан вдоль z (свет 10, не
// выбить); зритель — в пульвинаре на малой оси, лицом к полю.
const STYLE = process.env.ARENA_STYLE || 'classic'
const COLOS = STYLE === 'colosseum'
const CZ = COLOS ? require('./colosseum') : null
const CZB = COLOS ? require('./build-colosseum') : null
let CZM = null // модель Колизея: место зрителя, габарит для /kill мобов
let CZFP = null

// Потолок (mace.js, 2026-09-26): заряд ветра под ноги поднимает на 6–11
// блоков (замер probe-mace), «Порыв ветра» булавы — до 24, а стены 5 — бойцы
// вылетали бы из коробки в небе. Стекло до Y+CEIL_H−1 и невидимый барьер на
// Y+CEIL_H: голова на вершине взлёта (≤ Y+13) до него не достаёт. По
// умолчанию — только если в выбранных наборах есть заряды ветра или булава;
// ARENA_CEIL=0/1 — выключить/включить явно.
const CEIL_H = Number(process.env.ARENA_CEIL_H || 16)
let CEIL = false
const TOP = () => (CEIL ? Y + CEIL_H - 1 : Y + 4)
// Взрывчатка в наборах (boom.js, 2026-09-26: вагонетки с TNT, кристаллы):
// стекло стен (стойкость 0.3) взрыв выбивает — бойцы вылетали бы из коробки в
// небе. В классике за стеклом — оболочка из барьера (стойкость 3600000, не
// выбить, и не видно), от слоя пола до потолка; в Колизее сдерживание и так
// барьерное (colosseum.fieldCommands). Ставится, только если такие наборы
// выбраны (BLAST) — остальные арены как были.
let BLAST = false
async function blastShell () {
  if (!BLAST || COLOS) return
  const R = CLEAN_R + 2
  const T = CEIL ? Y + CEIL_H : TOP() + 1
  await cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X + R} ${T} ${Z - R} minecraft:barrier`)
  await cmd(`/fill ${X - R} ${Y - 1} ${Z + R} ${X + R} ${T} ${Z + R} minecraft:barrier`)
  await cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X - R} ${T} ${Z + R} minecraft:barrier`)
  await cmd(`/fill ${X + R} ${Y - 1} ${Z - R} ${X + R} ${T} ${Z + R} minecraft:barrier`)
  if (CEIL) await cmd(`/fill ${X - R} ${Y + CEIL_H} ${Z - R} ${X + R} ${Y + CEIL_H} ${Z + R} minecraft:barrier`)
}

async function buildArena () {
  await cmd(`/tp ${NA} ${X} ${Y + 2} ${Z}`)
  await sleep(1500)
  // Уже стоит большая арена (arena-mobs) — свою коробку внутри не строим.
  if (process.env.ARENA_NOBUILD) return
  if (COLOS) {
    await ensureColosseum()
    await walls()
    await fillBox(X - CLEAN_R, Y - 1, Z - CLEAN_R, X + CLEAN_R, Y - 1, Z + CLEAN_R, FLOOR)
    return
  }
  const R = CLEAN_R
  await fillBox(X - R - 1, Y - 1, Z - R - 1, X + R + 1, TOP(), Z + R + 1, 'minecraft:glass hollow')
  await fillBox(X - R, Y - 1, Z - R, X + R, Y - 1, Z + R, FLOOR)
  await fillBox(X - R, TOP(), Z - R, X + R, TOP(), Z + R, 'minecraft:air')
  if (CEIL) await fillBox(X - R - 1, Y + CEIL_H, Z - R - 1, X + R + 1, Y + CEIL_H, Z + R + 1, 'minecraft:barrier')
  await blastShell()
}

// Колизей уже стоит? Читать блоки арена не умеет — верим флагу постройки
// (build-colosseum.js пишет его после проверки контрольных блоков). Нет флага
// (или другой R/версия модели) — строим сами, один раз: ~12 тыс. команд,
// минуты полторы-две; перед этим объём постройки (кроме поля) очищается.
async function ensureColosseum () {
  const f = CZB.readFlag({ X, Y, Z })
  if (CZB.flagMatches(f, { R: CLEAN_R })) { log(`Колизей уже стоит (флаг ${f.builtAt}) — не строю`); return }
  log(`Колизея у ${X} ${Y} ${Z} нет${f ? ` (флаг на R=${f.R}, версия ${f.version})` : ''} — строю один раз`)
  await CZB.run({ call: (m, p) => A.call(m, p), log, X, Y, Z, R: CLEAN_R, ceilH: CEIL_H, who: NA, rules: false, rate: Number(process.env.ARENA_COLOS_RATE || 150) })
}

// /fill берёт не больше 32768 блоков — большие объёмы режем по высоте.
async function fillBox (x1, y1, z1, x2, y2, z2, block) {
  const area = (Math.abs(x2 - x1) + 1) * (Math.abs(z2 - z1) + 1)
  const step = Math.max(1, Math.floor(32768 / area))
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += step) {
    await cmd(`/fill ${x1} ${y} ${z1} ${x2} ${Math.min(Math.max(y1, y2), y + step - 1)} ${z2} ${block}`)
  }
}

// Сколько чистить вокруг центра: в большой арене (arena-mobs, R=30) бойцы
// разбегаются дальше 15, а столбы (побег от игрока) — до 6 блоков в высоту.
const CLEAN_R = Number(process.env.ARENA_R || 15)
// Рельеф (arena-terrain.js): ямы, лава, вода, высоты, укрытия — каждый раунд новый.
const TERRAIN = !!process.env.ARENA_TERRAIN
const terrainMod = require('./arena-terrain')

// Между раундами: убрать лаву, огонь, паутину, столбы и дроп, всё вернуть к ровному полу.
// Свет: ночью в коробке ничего не видно. Полосы светокамня в полу каждые 8
// блоков и пояс по стенам — десяток /fill вместо сотни /setblock.
async function lightArena () {
  if (COLOS) { for (const c of CZ.fieldLightCommands({ X, Y, Z, R: CLEAN_R })) await cmd(c); return }
  const R = CLEAN_R
  for (let d = -R + 4; d <= R - 4; d += 8) {
    await cmd(`/fill ${X + d} ${Y - 1} ${Z - R} ${X + d} ${Y - 1} ${Z + R} minecraft:glowstone`)
    await cmd(`/fill ${X - R} ${Y - 1} ${Z + d} ${X + R} ${Y - 1} ${Z + d} minecraft:glowstone`)
  }
  await cmd(`/fill ${X - R - 1} ${Y + 2} ${Z - R - 1} ${X + R + 1} ${Y + 2} ${Z - R - 1} minecraft:sea_lantern`)
  await cmd(`/fill ${X - R - 1} ${Y + 2} ${Z + R + 1} ${X + R + 1} ${Y + 2} ${Z + R + 1} minecraft:sea_lantern`)
  await cmd(`/fill ${X - R - 1} ${Y + 2} ${Z - R - 1} ${X - R - 1} ${Y + 2} ${Z + R + 1} minecraft:sea_lantern`)
  await cmd(`/fill ${X + R + 1} ${Y + 2} ${Z - R - 1} ${X + R + 1} ${Y + 2} ${Z + R + 1} minecraft:sea_lantern`)
}

// Стены чинить каждый раунд: люди ломали стекло посреди боя, и коробка
// переставала держать бойцов (арена в небе — выпавший летит полсотни блоков).
async function walls () {
  // Колизей: барьер от слоя пола до потолка по всему периметру, потолок,
  // дно щели — плачущий обсидиан (colosseum.fieldCommands).
  if (COLOS) { for (const c of CZ.fieldCommands({ X, Y, Z, R: CLEAN_R, ceilH: CEIL ? CEIL_H : TOP() - Y + 1, ceiling: CEIL })) await cmd(c); return }
  const R = CLEAN_R + 1
  const T = TOP()
  await cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X + R} ${T} ${Z - R} minecraft:glass`)
  await cmd(`/fill ${X - R} ${Y - 1} ${Z + R} ${X + R} ${T} ${Z + R} minecraft:glass`)
  await cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X - R} ${T} ${Z + R} minecraft:glass`)
  await cmd(`/fill ${X + R} ${Y - 1} ${Z - R} ${X + R} ${T} ${Z + R} minecraft:glass`)
  if (CEIL) await cmd(`/fill ${X - R} ${Y + CEIL_H} ${Z - R} ${X + R} ${Y + CEIL_H} ${Z + R} minecraft:barrier`)
  await blastShell()
}

// Дыры в полу (ARENA_HOLES=n, каждый раунд новые): арена в небе, и в дыру
// падают насмерть. Бойцы должны видеть край, обходить его и сбивать туда
// противника (просьба 2026-09-25). Места старта (X±6..8) и проход у стен не
// трогаем.
const HOLES = Number(process.env.ARENA_HOLES || 0)
async function holes () {
  const made = []
  const starts = [[X - 6, Z], [X + 6, Z], [X + 8, Z - 2], [X + 8, Z + 2]]
  for (let tries = 0; made.length < HOLES && tries < HOLES * 30; tries++) {
    const s = 2 + Math.floor(Math.random() * 2)
    const x = X - CLEAN_R + 3 + Math.floor(Math.random() * (2 * CLEAN_R - 5 - s))
    const z = Z - CLEAN_R + 3 + Math.floor(Math.random() * (2 * CLEAN_R - 5 - s))
    const near = (ax, az, gap) => ax >= x - gap && ax <= x + s - 1 + gap && az >= z - gap && az <= z + s - 1 + gap
    if (starts.some(([sx, sz]) => near(sx, sz, 4))) continue
    if (made.some(h => near(h.x, h.z, h.s + 3) || near(h.x + h.s - 1, h.z + h.s - 1, h.s + 3))) continue
    made.push({ x, z, s })
    await cmd(`/fill ${x} ${Y - 1} ${z} ${x + s - 1} ${Y - 1} ${z + s - 1} minecraft:air`)
  }
  if (made.length) log(`дыры в полу: ${made.map(h => `${h.x},${h.z} ${h.s}×${h.s}`).join('; ')}`)
}

// Дроп и стрелы — только внутри коробки: мир чужой, и /kill @e[type=item]
// без границ стирал бы вещи по всему миру.
const INSIDE = () => `x=${X - CLEAN_R - 1},y=${Y - 2},z=${Z - CLEAN_R - 1},dx=${2 * CLEAN_R + 2},dy=${CEIL ? CEIL_H + 2 : 16},dz=${2 * CLEAN_R + 2}`
// Диких мобов — в Колизее по его габариту (фундамент — мачты): шар ..40 от
// центра не доставал до трибун, а вниз доставал до земли под ареной.
const MOBS_AT = () => COLOS && CZFP
  ? `x=${CZFP.x0},y=${CZFP.y0 - 1},z=${CZFP.z0},dx=${CZFP.x1 - CZFP.x0},dy=${CZFP.y1 - CZFP.y0 + 2},dz=${CZFP.z1 - CZFP.z0}`
  : `x=${X},y=${Y},z=${Z},distance=..40`

async function resetArena () {
  if (TERRAIN) {
    await terrainMod.clearTerrain(cmd, fillBox, { X, Y, Z, R: CLEAN_R, top: TOP() })
    const features = await terrainMod.buildTerrain(cmd, { X, Y, Z, R: CLEAN_R, avoid: [[X - 6, Z], [X + 6, Z]] })
    const kinds = {}
    for (const f of features) kinds[f.kind] = (kinds[f.kind] || 0) + 1
    log('рельеф: ' + Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join(', '))
  } else {
    await fillBox(X - CLEAN_R, Y, Z - CLEAN_R, X + CLEAN_R, Math.max(Y + 8, TOP()), Z + CLEAN_R, 'minecraft:air')
    await fillBox(X - CLEAN_R, Y - 1, Z - CLEAN_R, X + CLEAN_R, Y - 1, Z + CLEAN_R, FLOOR)
    if (!process.env.ARENA_NOBUILD) await walls()
    await lightArena()
    await holes()
  }
  await cmd(`/kill @e[type=item,${INSIDE()}]`)
  await cmd(`/kill @e[type=arrow,${INSIDE()}]`)
  await cmd(`/kill @e[type=experience_orb,${INSIDE()}]`)
  // Взрывчатка прошлого раунда (boom.js): вагонетки, кристаллы, ракеты — не
  // оставлять новому раунду (рельсы снял пол-заливкой выше).
  if (BLAST) for (const t of ['tnt_minecart', 'end_crystal', 'tnt', 'firework_rocket']) await cmd(`/kill @e[type=${t},${INSIDE()}]`)
  // Под крышей темно — ночью внутри спавнятся дикие мобы и мешают дуэли.
  for (const t of ['zombie', 'husk', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'zombie_villager', 'drowned', 'slime', 'phantom']) {
    await cmd(`/kill @e[type=${t},${MOBS_AT()}]`)
  }
}

const ARMOR = {
  iron: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
  diamond: ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
}

// Наборы. Каждый — что получает A и что получает B. Зелья через компонент
// potion_contents (синтаксис /give 1.21).
// Режим арены: kits — готовые наборы (как было), craft — сырьё и крафт перед
// боем, all — всё подряд.
const MODE = process.env.ARENA_MODE || 'kits'
// Сырьё на полный комплект: алмазный меч, железная броня (24 слитка), щит,
// топор и кирка (6), лук (нитки), брёвна на доски, палки и верстак.
const RAW = ['oak_log 6', 'iron_ingot 31', 'diamond 2', 'string 3', 'arrow 16', 'cobblestone 64', 'golden_apple 2', 'cooked_beef 8']
const pot = (kind, name, n = 1) => `${kind}[potion_contents={potion:"minecraft:${name}"}] ${n}`
// Булава (PVP-RESEARCH г.3, без чар): меч и булава, заряды ветра, топор под
// щит, вода, яблоки, тотемы; против — меч, топор, щит, лук.
const MACE_KIT = ['diamond_sword', 'mace', 'wind_charge 32', 'diamond_axe', 'golden_apple 4', 'water_bucket', 'cobblestone 64', 'ender_pearl 4', 'totem_of_undying', 'totem_of_undying', pot('splash_potion', 'strong_healing', 2)]
const SHIELD_KIT = ['diamond_sword', 'diamond_axe', 'golden_apple 4', 'water_bucket', 'cobblestone 64', 'bow', 'arrow 32', 'totem_of_undying', 'totem_of_undying', pot('splash_potion', 'strong_healing', 2)]
// Дальний бой (2026-09-26): компоненты 1.21.5+ без обёртки levels.
const tipped = (name, n) => `tipped_arrow[potion_contents={potion:"minecraft:${name}"}] ${n}`
const ROCKET3 = 'firework_rocket[fireworks={flight_duration:1,explosions:[{shape:"small_ball"},{shape:"small_ball"},{shape:"small_ball"}]}]'
const XBOW_MULTI = 'crossbow[enchantments={quick_charge:3,multishot:1}]'
const XBOW_PIERCE = 'crossbow[enchantments={quick_charge:3,piercing:4}]'
const KITS = [
  { name: 'крафт: рывок против полного', craft: { a: 'rush', b: 'full' }, a: RAW, b: RAW },
  { name: 'крафт: умный против умного', craft: { a: 'smart', b: 'smart' }, a: RAW, b: RAW },
  { name: 'крафт: полный против рывка', craft: { a: 'full', b: 'rush' }, a: RAW, b: RAW },
  { name: 'кулаки', a: [], b: [] },
  { name: 'железо: меч+броня', a: ['iron_sword', ...ARMOR.iron], b: ['iron_sword', ...ARMOR.iron] },
  { name: 'топор против щита', a: ['diamond_axe', ...ARMOR.iron], b: ['diamond_sword', 'shield', ...ARMOR.iron] },
  { name: 'паутина и яблоки против лавы и огня', a: ['iron_sword', 'cobweb 8', 'golden_apple 3', ...ARMOR.iron], b: ['iron_sword', 'lava_bucket', 'flint_and_steel', 'water_bucket', ...ARMOR.iron] },
  { name: 'лук против щита', a: ['bow', 'arrow 32', 'iron_sword', 'cobblestone 32', ...ARMOR.iron], b: ['iron_sword', 'shield', 'cobblestone 32', ...ARMOR.iron] },
  { name: 'перестрелка: лук и щит', a: ['bow', 'arrow 64', 'shield', ...ARMOR.iron], b: ['bow', 'arrow 64', 'shield', ...ARMOR.iron] },
  { name: 'дуэль лучников', a: ['bow', 'arrow 64', 'iron_sword', 'cobblestone 32', 'golden_apple 2', ...ARMOR.iron], b: ['bow', 'arrow 64', 'iron_sword', 'cobblestone 32', 'golden_apple 2', ...ARMOR.iron] },
  {
    name: 'зелья',
    a: ['iron_sword', pot('splash_potion', 'strong_healing', 3), pot('potion', 'strength'), pot('splash_potion', 'harming', 2), ...ARMOR.iron],
    b: ['iron_sword', pot('splash_potion', 'healing', 3), pot('potion', 'swiftness'), pot('splash_potion', 'poison', 2), ...ARMOR.iron]
  },
  // Кошки-мышки: закрыться в коробке и лечиться, ломать чужую киркой.
  { name: 'крепость', a: ['iron_sword', 'iron_pickaxe', 'cobblestone 64', 'golden_apple 3', ...ARMOR.iron], b: ['iron_sword', 'iron_pickaxe', 'cobblestone 64', 'golden_apple 3', ...ARMOR.iron] },
  // Булава и заряды ветра (mace.js, 2026-09-26): A/B — одной стороне булава,
  // другой щит (PVP-RESEARCH г.3). Броня и щит — сразу на тело (onBody).
  { name: 'булава против щита', onBody: true, a: [...ARMOR.diamond, ...MACE_KIT], b: [...ARMOR.diamond, 'shield', ...SHIELD_KIT] },
  { name: 'булава на булаву', onBody: true, a: [...ARMOR.diamond, 'shield', ...MACE_KIT], b: null },
  // Подручное (utility.js, 2026-09-26; PVP-RESEARCH г.3 «удочка и лава», «ловушка»,
  // «хорус и жемчуг»): удочка — со столба, в яму, едока к мечу; паутина, лава и
  // наковальни — ловушки застрявшему; хорус — уход, когда жемчуг хуже. Броня на
  // тело, в рюкзаке 11 слотов. Пустое ведро после лавы — тот же слот.
  { name: 'ловушки и удочка', onBody: true, a: [...ARMOR.iron, 'iron_sword', 'fishing_rod', 'cobweb 12', 'anvil 4', 'lava_bucket', 'water_bucket', 'cobblestone 64', 'chorus_fruit 8', 'ender_pearl 2', 'golden_apple 3', 'iron_pickaxe'], b: null },
  // Трезубцы под дождём (weather: «Тягун» работает только в воде или под дождём,
  // TridentItem.use; в мире пользователя погоду не трогаем — ARENA_GENTLE):
  // «Верность» — бросок и возврат, «Тягун» — рывок, «Громовержец» — в грозу.
  { name: 'трезубцы', onBody: true, weather: 'rain', a: [...ARMOR.iron, 'trident[enchantments={loyalty:3}]', 'trident[enchantments={riptide:3}]', 'trident[enchantments={channeling:1,loyalty:1}]', 'iron_sword', 'water_bucket', 'golden_apple 3', 'cobblestone 64', 'chorus_fruit 4'], b: null },
  // Дальний бой (ranged.js, read.js, 2026-09-26; PVP-RESEARCH г.3 «арбалеты»):
  // A — два арбалета с «Быстрой перезарядкой III»: «Тройной выстрел» под
  // фейерверки с тремя звёздами (5 + 2·3 = 11 взрывом), «Пронзание IV» под
  // стрелы (щит не держит); стрелы с медлительностью и слабостью; B — лук, меч,
  // щит. Броня и щит — на тело. Рюкзак: A 12, B 8.
  { name: 'арбалет', onBody: true, a: [...ARMOR.iron, 'shield', XBOW_MULTI, XBOW_PIERCE, `${ROCKET3} 32`, 'arrow 64', tipped('slowness', 16), tipped('weakness', 16), 'diamond_sword', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', pot('splash_potion', 'strong_healing', 2)], b: [...ARMOR.iron, 'shield', 'bow', 'arrow 64', 'diamond_sword', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', pot('splash_potion', 'strong_healing', 2)] },
  // Стрелы с эффектом (ranged.pickArrow; г.3 «стрелы и зелья»): вред II — добить и
  // коротким натяжением мимо брони, слабость — сильно бьющему, медлительность —
  // убегающему. Обеим сторонам одно. Рюкзак 9.
  { name: 'стрелы с эффектом', onBody: true, a: [...ARMOR.iron, 'shield', 'bow[enchantments={power:3}]', tipped('strong_harming', 16), tipped('weakness', 16), tipped('strong_slowness', 16), 'arrow 32', 'iron_sword', 'golden_apple 3', 'cobblestone 64', pot('splash_potion', 'strong_healing', 2)], b: null },
  // Копья (spear.js; г.3 «копья»): A — копья (укол STAB с 2.0–4.5, разгон),
  // меч на случай «обнял»; B — меч, топор, щит: против копья он должен
  // прилипнуть ближе 1.9. Броня — на тело. Рюкзак: A 10, B 8.
  { name: 'копья', onBody: true, a: [...ARMOR.diamond, 'diamond_spear[enchantments={lunge:3}]', 'netherite_spear', 'diamond_sword', 'diamond_axe', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', 'ender_pearl 4', pot('splash_potion', 'strong_healing', 2)], b: [...ARMOR.diamond, 'shield', 'diamond_sword', 'diamond_axe', 'golden_apple 4', 'totem_of_undying', 'cobblestone 64', 'ender_pearl 4', pot('splash_potion', 'strong_healing', 2)] },
  {
    name: 'арсенал',
    // Броня и щит — на тело (/item replace, onBody): рюкзак 36 слотов весь под
    // вещи — 23 вещи + 12 зелий (зелья не стакаются — каждое слот) = 35.
    // Булава и заряды ветра — в начале: /give кладёт первые девять в хотбар.
    // Удочка, хорус и трезубец с «Верностью» (utility.js, 2026-09-26) — в конце.
    onBody: true,
    // Арбалет с «Быстрой перезарядкой III» (ranged.js, 2026-09-26) — 36-й слот:
    // заряженный — мгновенный выстрел в окно; стрелы те же.
    a: [...ARMOR.diamond, 'shield', 'diamond_sword', 'mace', 'wind_charge 32', 'diamond_axe', 'golden_apple 4', 'water_bucket', 'ender_pearl 6', 'cobblestone 64', 'bow',
      'arrow 64', 'crossbow[enchantments={quick_charge:3}]', 'diamond_pickaxe', 'cobweb 8', 'enchanted_golden_apple 1',
      'lava_bucket', 'lava_bucket', 'totem_of_undying', 'flint_and_steel',
      'oak_planks 64', 'obsidian 16', 'cooked_beef 16',
      pot('splash_potion', 'strong_healing', 3), pot('potion', 'strong_regeneration'), pot('potion', 'strong_strength'), pot('potion', 'strong_swiftness'),
      pot('potion', 'turtle_master'), pot('splash_potion', 'strong_harming', 2), pot('splash_potion', 'strong_poison'), pot('splash_potion', 'slowness'), pot('splash_potion', 'weakness'),
      'fishing_rod', 'chorus_fruit 8', 'trident[enchantments={loyalty:3}]'],
    b: null // люди получают ровно то же, что бот (просьба 2026-09-25: «дай нам такие же зелья»)
  },
  // Небо и порох (elytra.js, boom.js, 2026-09-26): элитры и фейерверки (уход
  // лечиться в воздух, пике с булавой, когда его щит выбит — топор), лук с
  // «Огнём» и вагонетки с TNT на рельсах (стрела в вагонетку — взрыв сразу),
  // кристаллы Края (пол — обсидиан), обсидиан под них. Броня и щит — на тело.
  // Взрыв выбивает светокамень пола и стекло: дыр больше с каждым взрывом.
  // ench: 'blast' — розыгрыш чар знает, что взрывов тут много
  // (arena-ench.W_BLAST: «Взрывоустойчивость» в цене). Стены держат взрывы:
  // Колизей — барьером, классика — барьерной оболочкой за стеклом (blastShell).
  // Рюкзак 25 из 36.
  {
    name: 'небо и порох',
    onBody: true,
    ench: 'blast',
    a: [...ARMOR.diamond, 'shield', 'diamond_sword', 'diamond_axe', 'mace', 'elytra', 'firework_rocket 48', 'bow[enchantments={flame:1}]', 'arrow 48',
      'rail 16', 'tnt_minecart', 'tnt_minecart', 'tnt_minecart', 'tnt_minecart', 'end_crystal 16', 'obsidian 16',
      'golden_apple 4', 'enchanted_golden_apple 1', 'totem_of_undying', 'totem_of_undying', 'water_bucket', 'ender_pearl 4', 'cobblestone 64',
      pot('splash_potion', 'strong_healing', 2), pot('potion', 'strong_regeneration'), pot('potion', 'strong_strength')],
    b: null
  },
  {
    name: 'полный кит',
    a: ['diamond_sword', 'diamond_axe', 'shield', 'bow', 'arrow 16', 'cobweb 4', 'golden_apple 2', 'lava_bucket', 'water_bucket', 'ender_pearl 2', 'totem_of_undying', 'cobblestone 64', 'diamond_pickaxe', pot('splash_potion', 'strong_healing', 2), pot('potion', 'strength'), ...ARMOR.diamond],
    b: ['diamond_sword', 'diamond_axe', 'shield', 'bow', 'arrow 16', 'cobweb 4', 'golden_apple 2', 'flint_and_steel', 'water_bucket', 'ender_pearl 2', 'totem_of_undying', 'cobblestone 64', 'diamond_pickaxe', pot('splash_potion', 'strong_healing', 2), pot('potion', 'swiftness'), ...ARMOR.diamond]
  }
]

// Куда на тело (onBody): броня — armor.*, щит — левая рука (PVP-RESEARCH г.1:
// /item replace entity <кто> armor.head with …) — мимо рюкзака, и боту не
// тратить время на equipBestArmor.
const BODY = { helmet: 'armor.head', chestplate: 'armor.chest', leggings: 'armor.legs', boots: 'armor.feet' }
function bodySlot (name) {
  const base = name.replace(/\[.*$/, '').replace(/^minecraft:/, '')
  const m = base.match(/_(helmet|chestplate|leggings|boots)$/)
  if (m) return BODY[m[1]]
  return base === 'shield' ? 'weapon.offhand' : null
}

async function equip (who, items, { onBody = false } = {}) {
  await cmd(`/clear ${who}`)
  await cmd(`/effect clear ${who}`)
  if (onBody) {
    const rest = []
    for (const it of items) {
      const name = it.split(' ')[0]
      const slot = bodySlot(name)
      if (slot) await cmd(`/item replace entity ${who} ${slot} with ${name.includes(':') ? name : 'minecraft:' + name}`)
      else rest.push(it)
    }
    items = rest
  }
  // Броня — первой: рюкзак 36 слотов, и что не влезло, сервер роняет на пол
  // (арсенал 2026-09-25: броня выдавалась последней и валялась под ногами).
  items = [...items].sort((a, b) => (/_(helmet|chestplate|leggings|boots)\b/.test(b) ? 1 : 0) - (/_(helmet|chestplate|leggings|boots)\b/.test(a) ? 1 : 0))
  for (const it of items) {
    const [name, ...rest] = it.split(' ')
    const n = rest.length ? rest.join(' ') : '1'
    await cmd(`/give ${who} ${name.includes(':') || name.includes('[') ? name : 'minecraft:' + name} ${n}`)
  }
}

// Выдача проверяется по рюкзаку: в прогоне «полный кит» NeuroDown вышел с
// пустыми руками — /give пришёл, пока он ещё возрождался после прошлого раунда.
async function equipChecked (c, who, items, opts = {}) {
  // Рюкзак человека нам не виден — выдаём один раз.
  // Людям — ещё и обычная еда: без неё не отъесться между стычками.
  if (HUMANS.length && !who.startsWith('NeuroDown')) { for (const h of ACTIVE) { await equip(h, items, opts); await cmd(`/give ${h} minecraft:cooked_beef 32`) } return true }
  for (let attempt = 0; attempt < 3; attempt++) {
    await equip(who, items, opts)
    if (!items.length) return true
    await sleep(700)
    const st = await c.call('status').catch(() => null)
    const inv = (st && st.state && st.state.inventory) || {}
    const want = items[0].split(/[ [\]]/)[0].replace(/^minecraft:/, '')
    const worn = Object.values((st && st.state && st.state.armor) || {}).filter(Boolean).map(x => String(x.name || x))
    if (Object.keys(inv).some(k => k.includes(want)) || worn.some(n => n.includes(want))) return true
    log(`${who}: набор не дошёл (нет ${want}), выдаю ещё раз`)
    await sleep(1500)
  }
  return false
}

// Чары (arena-ench.js, просьба 2026-09-26): каждому предмету набора — случайные
// чары из тех, что игра ему разрешает (таблица из jar 1.21.11), бойцам разные,
// но равной силы — чтобы случай не решал бой: оба набора добирают один бюджет
// (случайный на пару), суммы — в допуске. Во втором раунде пары бойцы
// меняются наборами: за пару каждый дрался обоими — для счёта побед и отбора.
// Закреплённое в наборе (quick_charge:3 арбалета, loyalty:3 трезубца — на них
// логика бота) не трогается, «Тягун» к «Верности» не встаёт.
//   ARENA_ENCH=0 — без чар; force — не спрашивать демонов (см. main);
//   ARENA_ENCH_BUDGET=40-70 — сила набора на пару (единица ≈ процент боя);
//   ARENA_ENCH_TOL=3 — допуск разницы сил пары;
//   ARENA_PAIR=0 — каждый раунд новая пара, без обмена; sides — меняться и в
//     наборах с разными предметами (a ≠ b): бойцы меняются сторонами целиком
//     (по умолчанию такие наборы тянутся заново каждый раунд — кто за какую
//     сторону, задумано в самом наборе);
//   ARENA_ENCH_SEED=строка — повторяемые розыгрыши.
const enchMod = require('./arena-ench')
const ENCH_ARG = process.env.ARENA_ENCH || '1'
let ENCH = ENCH_ARG !== '0'
const ENCH_BUDGET = (process.env.ARENA_ENCH_BUDGET || '40-70').split(/[-,]/).map(Number)
if (!(ENCH_BUDGET[1] >= ENCH_BUDGET[0])) ENCH_BUDGET[1] = ENCH_BUDGET[0]
const ENCH_TOL = Number(process.env.ARENA_ENCH_TOL || 3)
const PAIR = process.env.ARENA_PAIR || '1'
const enchRandom = enchMod.rng(process.env.ARENA_ENCH_SEED)
const enchPairs = new Map()
let pairNo = 0

// Что выдать сторонам в раунде n набора: первый раунд пары тянет два набора
// (X — первому бойцу, Y — второму), второй отдаёт те же, обменяв.
function kitSides (kit, n) {
  const a = kit.a
  const b = kit.b || kit.a
  if (!ENCH || (!enchMod.enchantable(a) && !enchMod.enchantable(b))) return { a, b }
  const paired = PAIR !== '0' && (enchMod.sameItems(a, b) || PAIR === 'sides')
  const prev = enchPairs.get(kit.name)
  if (paired && prev && prev.round === n - 1 && !prev.swapped) {
    prev.swapped = true
    return { a: prev.d.b.strings, b: prev.d.a.strings, ench: { a: prev.d.b, b: prev.d.a, va: 'Y', vb: 'X', no: prev.no, swapped: true } }
  }
  // Набор со своими весами чар (ench: 'blast' — взрывы в цене, arena-ench.W_BLAST).
  const d = enchMod.drawPair(a, b, { budget: ENCH_BUDGET, tol: ENCH_TOL, random: enchRandom, weights: kit.ench === 'blast' ? enchMod.W_BLAST : undefined })
  const no = paired ? ++pairNo : null
  enchPairs.set(kit.name, { round: n, no, d, swapped: false })
  if (d.diff > ENCH_TOL) log(`чары: за ${d.tries} попыток разница сил ${d.diff} — больше допуска ${ENCH_TOL}, беру ближайшую`)
  return { a: d.a.strings, b: d.b.strings, ench: { a: d.a, b: d.b, va: 'X', vb: 'Y', no, swapped: false } }
}

// Строка на бойца: что выпало (только случайное — закреплённое в наборе и так
// известно), сила, дошло ли (status { enchants } против розыгрыша) и сколько
// шла выдача. Людям в руки не заглянуть — у них без «дошли».
async function enchLog (e, ms) {
  for (const [c, who, side, v, t, human] of [[A, NA, e.a, e.va, ms[0], false], [B, NB, e.b, e.vb, ms[1], !!HUMAN]]) {
    const bits = []
    if (e.no) bits.push(`пара ${e.no}·${v}${e.swapped ? ', обмен' : ''}`)
    bits.push(`сила ${side.power.toFixed(1)}`)
    if (!human) {
      const st = await c.call('status', { enchants: true }).catch(() => null)
      const got = st && st.detail && st.detail.enchants
      if (Array.isArray(got)) {
        const r = enchMod.verify(side, got)
        bits.push(r.missing.length ? `НЕ дошли ${r.missing.join(', ')} (${r.got}/${r.total})` : `дошли ${r.got}/${r.total}`)
      }
    }
    bits.push(`выдача ${(t / 1000).toFixed(1)} с`)
    log(`чары ${who} [${bits.join(', ')}]: ${enchMod.describe(side)}`)
  }
}

async function heal (who) {
  await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`)
  await cmd(`/effect give ${who} minecraft:saturation 1 20 true`)
}

async function alive (c) {
  for (let i = 0; i < 20; i++) {
    const st = await c.call('status').catch(() => null)
    if (st && st.state && st.state.health > 0) return st
    await sleep(500)
  }
  return null
}

// Люди, которые сейчас на сервере: вышедший выбывает — ему не выдаём, не
// телепортируем и не ждём его в бою (2026-09-25 друг вышел посреди арены).
let ACTIVE = HUMANS
async function onlineHumans () {
  if (!HUMANS.length) return []
  const st = await A.call('status').catch(() => null)
  const on = st && st.state && st.state.playersOnline
  return Array.isArray(on) ? HUMANS.filter(h => on.includes(h)) : HUMANS
}

// Смерть бойца. Флаг died pvp выставить не успевает: сессия рвёт интент по
// событию death раньше, и бой приходит «прерван» (2026-09-25 бота убили,
// он возродился у спавна, а арена гоняла его в бой дальше). Вторая примета —
// он внизу или далеко в стороне от коробки: возродился или выпал за стену.
const diedIn = r => !!(r && ((r.detail && r.detail.died) || (r.status === 'interrupted' && r.by && r.by.type === 'death')))
const lostLink = r => !!(r && r.status === 'interrupted' && r.by && /kicked|disconnected/.test(r.by.type))
async function where (c, out = {}) {
  const st = await c.call('status').catch(() => null)
  if (!st || !st.state || st.state.connected === false) return null
  out.hp = st.state.health
  if (!(st.state.health > 0)) return 'dead'
  const p = st.state.pos
  // Колизей: за барьером поля (хорус переносит сквозь стену) или на потолке —
  // обратно не попасть, это не «выпал и лезет назад»: gone, вылет через GONE_MS.
  if (COLOS && p && p.y >= Y - 2 && (Math.abs(p.x - (X + 0.5)) > CLEAN_R + 1.5 || Math.abs(p.z - (Z + 0.5)) > CLEAN_R + 1.5 || (CEIL && p.y > Y + CEIL_H + 0.5))) return 'gone'
  return p && (p.y < Y - 8 || Math.abs(p.x - X) > CLEAN_R + 16 || Math.abs(p.z - Z) > CLEAN_R + 16) ? 'out' : 'in'
}

// Застой: боты встали друг против друга и минутами не бьют (прогон темпа
// 2026-09-26: 4.8 блока, разная высота, больше 10 минут без удара). Без
// таймера такой раунд не кончится — ARENA_STALL_S секунд без урона у обоих
// = ничья. Против людей не действует: человек сам решает, когда прятаться.
const STALL_MS = Number(process.env.ARENA_STALL_S ?? 120) * 1000
// Предел раунда: обычный бой кончается за 1-5 минут, а застрявший (оба внизу
// под ареной, урон от огня сбивает счётчик застоя) шёл 14 минут. ARENA_MAX_S
// секунд — и ничья; 0 — без предела.
const MAX_MS = Number(process.env.ARENA_MAX_S ?? 420) * 1000

// Выпавший живым — ещё не проигравший: пользователь хочет, чтобы бот
// строился обратно наверх и продолжал бой (2026-09-25: «смотрит наверх на
// противника и не понимает, что между ними огромная высота»). На возвращение —
// ARENA_RETURN_S секунд, потом это вылет с ринга и поражение.
const RETURN_MS = Number(process.env.ARENA_RETURN_S || 45) * 1000
// За стеной Колизея (where → gone) вернуться нельзя — ждать RETURN_S незачем.
const GONE_MS = Number(process.env.ARENA_GONE_S || 10) * 1000

function short (r) {
  if (!r) return 'нет ответа'
  const d = r.detail || {}
  const bits = [r.status]
  if (d.killed) bits.push(`УБИЛ ${d.killed}`)
  if (d.died) bits.push(d.ringout ? 'вылетел с ринга' : 'погиб')
  if (d.retreated) bits.push(`отступил (${d.mode || ''})`)
  if (d.timeout) bits.push('время вышло')
  if (d.lost) bits.push(d.lost)
  if (r.error) bits.push(r.error)
  bits.push(`хп ${d.hp || '?'}`, `удары ${d.swings ?? '?'}/${d.landed ?? '?'}`, `криты ${d.crits ?? 0}`, `спринт ${d.sprintHits ?? 0}`)
  if (d.arrows) bits.push(`стрел ${d.arrows}, попали ${d.arrowHits ?? '?'}`)
  if (d.blocks) bits.push(`блоков поставил ${d.blocks}`)
  if (d.dodges) bits.push(`уклонов ${d.dodges}`)
  if (d.axeOnShield) bits.push(`топор по щиту ${d.axeOnShield}`)
  // Булава и заряды ветра (mace.js): взлёты и высота, удары с падения и урон,
  // толчки и сбросы, угрозы булавой и ответ на них.
  const m = d.mace
  if (m) bits.push('булава: ' + [m.launches && `взлётов ${m.launched || 0}/${m.launches}, вершина ~${m.peak ?? '?'} бл.`, (m.smashes || m.fallSmash) && `ударов с падения ${m.smashHits || 0} из ${(m.smashes || 0) + (m.fallSmash || 0)}${m.dealt ? ` (снял ${m.dealt.join(', ')})` : ''}`, m.selfDmg && `себе −${m.selfDmg}`, m.pushes && `заряд в него ${m.pushes} (${Object.entries(m.pushWhy || {}).map(([k, v]) => `${k}×${v}`).join(', ')}), попал ${m.pushHits || 0}, сбросил ${m.knockoffs || 0}`, m.threats && `булава сверху ×${m.threats}: щит ${m.shieldUps || 0}, уклон ${m.dodges || 0}, в ответ ${m.counterHits || 0}, получил ${m.threatHp || 0}`, m.mlg && `заряд под ноги ${m.mlg}`, m.retries && `второй заряд стоя ${m.retries}`, (m.burnDodge || m.burnNoWay) && `посадка в огонь: увёл ${m.burnDodge || 0}, не смог ${m.burnNoWay || 0}`].filter(Boolean).join('; '))
  // Элитры (elytra.js) и «динамит» (boom.js), 2026-09-26: взлёты, уходы с
  // лечением, пике; мины, взрывы, урон ему и себе, выбитые блоки (дыры).
  const el = d.elytra
  if (el) bits.push('элитры: ' + [el.takeoffs && `взлётов ${el.takeoffs}, ракет ${el.rockets || 0}`, el.escapes && `уходов ${el.escapes} (${el.escapeS} с, хп +${el.escapeHp || 0}, в воздухе −${el.hurtAir || 0})`, el.dives && `пике ${el.diveHits || 0}/${el.dives}${el.diveDealt ? ` (снял ${el.diveDealt.join(', ')})` : ''}${el.diveSelf ? `, себе −${el.diveSelf}` : ''}`, el.landDmg && `посадки −${el.landDmg}`, el.foe && `он летал ${el.foe.airS || 0} с, стрел по нему ${el.foe.shots || 0}/${el.foe.hits || 0}, щит к пике ${el.foe.shieldUps || 0}, уклон ${el.foe.dodges || 0}`].filter(Boolean).join('; '))
  const bo = d.boom
  if (bo) bits.push('взрывчатка: ' + [bo.placed && `поставил ${Object.entries(bo.placed).map(([k, v]) => `${k}×${v}`).join(', ')}`, bo.shots && `взорвал ${bo.shots}`, bo.dealt && `ему ${bo.dealt.join(', ')}`, bo.self && `себе −${bo.self}`, bo.kills && `убил ${bo.kills}`, bo.defuse && `разобрал его ${bo.defuse}`, bo.counter && `его взрывчатку — в него ${bo.counter}`, bo.dodges && `уходил ${bo.dodges}`, bo.broken && `выбито блоков ${bo.broken} (светокамня ${bo.holes || 0})`].filter(Boolean).join('; '))
  // Ближний бой по звукам сервера (melee.js, 2026-09-26): спринт-удары и криты
  // (правда сервера), выбор, серии, W/S-tap, отброс с jump-reset и без, свапы,
  // щитом погашено; тотем; замедление с предметом в руке.
  const ml = d.melee
  if (ml) bits.push('ближний (звуки сервера): ' + [`махов ${ml.swings}, спринт-ударов ${ml.sprintHits} (пыток ${ml.sprintTries}), критов ${ml.crits}`, ml.choice && `выбор ${Object.entries(ml.choice).map(([k, v]) => `${k}×${v}`).join(' ')}`, ml.critConv && `крит из выбора ${ml.critConv.hits}/${ml.critConv.tries}${ml.critConv.miss ? ' (мимо: ' + Object.entries(ml.critConv.miss).map(([k, v]) => `${k}×${v}`).join(', ') + ')' : ''}`, ml.combo &&`серии max ${ml.combo.max}, ср ${ml.combo.avg}`, (ml.wtaps || ml.staps || ml.rearms) && `W-tap ${ml.wtaps || 0}, S-tap ${ml.staps || 0}, перевзвод ${ml.rearms || 0}`, ml.slow06 && `×0.6 себе ${ml.slow06}`, ml.sprintCrit && `спринт-крит ${ml.sprintCrit}`, ml.knocks && `отброс: получил ${ml.knocks}, jump-reset ${ml.jumpResets || 0}, ответный ${ml.counterHits || 0}, путь ${ml.kbPlain ?? '-'} / с прыжком ${ml.kbReset ?? '-'}`, ml.swaps && `свап на топор ${ml.swaps}, щит выбит ${ml.shieldBreaks || 0}`, ml.shieldBlocks && `щитом погасил ${ml.shieldBlocks}`, ml.his && `у него спринт ${ml.his.sprintHits}, криты ${ml.his.crits}`].filter(Boolean).join('; '))
  // Щит (combat.makeShield): погашенные — по звуку item.shield.block с поправкой
  // номера (melee.soundName, 2026-09-26); сверять с «щитом погасил» выше.
  const sh = d.shield || r.shield
  if (sh && (sh.raises || sh.blocked)) bits.push(`щит: поднимал ${sh.raises || 0}, погашено по звуку ${sh.blocked || 0}`)
  if (d.totem) bits.push(`тотем: сработал ${d.totem.pops}, снова в руке ${d.totem.reequips}, надевал ${Object.entries(d.totem.why || {}).map(([k, v]) => `${k}×${v}`).join(', ')}`)
  if (d.itemUse && (d.itemUse.slowTicks || d.itemUse.sprintStops || d.itemUse.wallStops)) bits.push(`с предметом медленно ${d.itemUse.slowTicks} тиков, спринт не дан ${d.itemUse.sprintBlocked}; спринт без «вперёд»: не начат ${d.itemUse.sprintNoFwd || 0}, погашен ${d.itemUse.sprintStops || 0}, начат с «вперёд» ${d.itemUse.sprintStarts || 0}; в стену (не вскользь): спринт погашен/не начат ${d.itemUse.wallStops || 0}, тиков у стены ${d.itemUse.wallTicks || 0}`)
  if (d.tricks) bits.push('приёмы ' + Object.entries(d.tricks).map(([k, v]) => `${k}×${v}`).join(', '))
  if (d.healed) bits.push('лечился ' + d.healed.join(', '))
  if (d.style) bits.push(`характер: агрессия ${d.style['агрессия']}, реакция ${d.style['реакцияМс']} мс, в коробку на ${d.style['коробкаНа']} хп`)
  // Темп (pvp.js/tempo.js): начало боя, еда под давлением, наказания занятого, вскрытия коробки.
  const tp = d.tempo
  if (tp) bits.push(`темп${tp.on ? '' : ' (выкл)'}: начало ${tp.open || '-'}, ел ${tp.ate} (под давлением ${tp.pressured}, бросил ${tp.aborted}${tp.desperate ? ', прижат ' + tp.desperate : ''}${tp.refused ? ', не стал ' + tp.refused : ''}), он ел ${tp.foeAte}, попал по занятому ${tp.busyHits}${tp.punish ? ', наказания ' + Object.entries(tp.punish).map(([k, v]) => `${k}×${v}`).join(' ') : ''}${tp.breaches ? `, коробку вскрыли ${tp.breaches}, вырвался ${tp.escapes || 0}` : ''}`)
  if (d.left) bits.push('осталось ' + Object.entries(d.left).map(([k, v]) => `${k}×${v}`).join(', '))
  // Качество боя (pvp.js, 2026-09-26): окна без размена ≥10 с, оба ели/пили
  // разом, стройка под его рукой и брошенная, наказания едока, нажим, фазы
  // человека. JSON — для сводки (agg.js), одной строкой.
  if (d.quality) { const q = { ...d.quality }; if (q.eatPunish) q.eatPunish = { tries: q.eatPunish.tries, swaps: q.eatPunish.swaps }; bits.push('качество: ' + JSON.stringify(q)) }
  return bits.join(' | ')
}

const score = { [NA]: 0, [NB]: 0, draw: 0 }

async function round (kit, n) {
  if (HUMANS.length) {
    ACTIVE = await onlineHumans()
    if (!ACTIVE.length) log('людей на сервере нет — жду, пока кто-нибудь зайдёт')
    while (!ACTIVE.length && !stopRequested()) { await gameClock.wall.sleep(10000); ACTIVE = await onlineHumans() }
    if (!ACTIVE.length) return
    const gone = HUMANS.filter(h => !ACTIVE.includes(h))
    if (gone.length) log(`вышли: ${gone.join(', ')} — раунд без них`)
  }
  log(`=== ${kit.name}, раунд ${n} ===`)
  // Отвалившегося за прошлый раунд бойца — обратно на сервер.
  await A.call('connect').catch(() => {})
  if (!HUMAN) await B.call('connect').catch(() => {})
  await resetArena()
  // Погода набора (трезубцы: «Тягун» — только под дождём); в чужом мире не трогаем.
  if (!GENTLE) await cmd(`/weather ${kit.weather || 'clear'}`)
  await alive(A); await alive(B)
  // Наборы раунда — с чарами (kitSides) или как в KITS.
  const sides = kitSides(kit, n)
  const t0 = gameClock.now()
  await equipChecked(A, NA, sides.a, { onBody: !!kit.onBody })
  const t1 = gameClock.now()
  await equipChecked(B, NB, sides.b, { onBody: !!kit.onBody })
  if (sides.ench) await enchLog(sides.ench, [t1 - t0, gameClock.now() - t1])
  await cmd(`/tp ${NA} ${X - 6} ${Y} ${Z} -90 0`)
  if (HUMANS.length) {
    for (let i = 0; i < ACTIVE.length; i++) { await cmd(`/tp ${ACTIVE[i]} ${X + 8} ${Y} ${Z + (i - (ACTIVE.length - 1) / 2) * 4} 90 0`); await heal(ACTIVE[i]) }
    await heal(NA)
  } else {
    await cmd(`/tp ${NB} ${X + 6} ${Y} ${Z} 90 0`)
    await heal(NA); await heal(NB)
  }
  await sleep(1500)
  // Броня на тело — до боя, как сделал бы человек.
  // Одеться с проверкой: бот выходил на бой голым с бронёй в рюкзаке.
  const dress = async (c, who) => {
    for (let i = 0; i < 4; i++) {
      const r = await c.call('armor').catch(() => null)
      const w = r && r.detail && r.detail.worn
      if (!w || (w.torso && w.head && w.legs && w.feet)) return
      await sleep(800)
    }
    log(`${who}: броня не наделась`)
  }
  await Promise.all([dress(A, NA), HUMAN ? null : dress(B, NB)])
  await sleep(500)

  // Поле — бою (pvp.js): держать арену, когда он выпал, и возвращаться, когда выпал сам.
  const fight = { target: null, allowPlayer: true, timeoutSeconds: HUMANS.length > 1 ? 150 : 90, retreatAtHealth: 3, arena: { x: X + 0.5, y: Y, z: Z + 0.5, r: CLEAN_R } }
  // Крафт-режим: каждый сперва готовится по своей тактике и идёт в бой, как
  // только закончил, — рывок успевает напасть, пока второй за верстаком (того
  // прерывает первый же удар, и он дерётся тем, что успел).
  // Бой до конца: fight возвращается кусками (таймаут, «не вижу цель»,
  // отступил) — тогда снова в бой. Раунд кончается смертью бойца или всех его
  // противников; over общий — умер один, второго останавливаем, чтобы он не
  // гнался за возродившимся у спавна.
  const over = { done: false }
  const go = async (c, me, foes, strategy, peer) => {
    if (strategy) {
      const pr = await c.call('prep', { strategy, enemy: foes[0] }).catch(e => ({ status: 'failed', error: e.message }))
      const d = pr.detail || {}
      log(`${me} [${strategy}] крафт ${d.seconds ?? '?'} с: ${(d.made || []).map(m => `${m.what}@${m.s}`).join(', ') || pr.error || pr.status}${pr.status === 'interrupted' ? ' — прервали' : ''}`)
    }
    const end = NOTIMER ? Infinity : gameClock.now() + fight.timeoutSeconds * 1000
    const dead = new Set()
    let last = { status: 'done', detail: {} }
    let turn = 0
    const finish = () => { if (!over.done) { over.done = true; if (peer) peer.call('stop').catch(() => {}) } }
    while (!over.done && gameClock.now() < end) {
      let left = foes.filter(f => !dead.has(f))
      if (HUMANS.length) { const on = await onlineHumans(); left = left.filter(f => on.includes(f)) }
      if (!left.length) break
      const foeNow = left[turn++ % left.length]
      last = await c.call('fight', { ...fight, target: foeNow, timeoutSeconds: NOTIMER ? 300 : Math.max(5, Math.round((end - gameClock.now()) / 1000)) }).catch(e => ({ status: 'failed', error: e.message }))
      const dd = last.detail || (last.detail = {})
      const at = diedIn(last) ? 'dead' : await where(c)
      if (at === 'dead') { dd.died = true; finish(); break }
      if ((at === 'out' || at === 'gone') && over.ringout === me) { dd.died = true; dd.ringout = true; finish(); break }
      if (lostLink(last)) { finish(); break }
      if (dd.killed) {
        // Убит не противник по раунду (зритель в выживании ударил бота, и тот
        // развернулся на него — 2026-09-26) — бой не кончен, дальше.
        const hit = String(dd.killed).split(', ').filter(k => foes.includes(k))
        for (const k of hit) dead.add(k)
        if (foes.every(f => dead.has(f))) { finish(); break }
        if (!hit.length) delete dd.killed
        continue
      }
      // Не видно / остыл / сбежал — не выбывший: пауза и следующий по кругу,
      // до конца раунда (раньше раунд обрывался на «не вижу цель»).
      await sleep(last.status === 'failed' ? 1500 : 300)
    }
    if (foes.length > 1 && foes.every(f => dead.has(f))) last.detail.killed = NB
    return last
  }
  // «хватит» в чате — посреди драки тоже: fight длится до 300 с, и ждать его
  // конца, чтобы прочитать чат, — это пять минут боя после просьбы остановиться.
  // Тот же таймер следит за вылетом: fight длится до 300 с, и узнавать после
  // него, что боец давно внизу, — поздно.
  const outSince = {}
  const hpWas = {}
  let hurtAt = gameClock.now()
  const roundAt = gameClock.now()
  // Human stop requests still work while ticks are frozen.
  const stopWatch = gameClock.wall.setInterval(() => {
    if (over.done || !stopRequested()) return
    over.done = true
    A.call('stop').catch(() => {})
    if (!HUMAN) B.call('stop').catch(() => {})
  }, 3000)
  const gameWatch = gameClock.setInterval(async () => {
    if (over.done) return
    for (const [c, who] of HUMAN ? [[A, NA]] : [[A, NA], [B, NB]]) {
      const got = {}
      const at = await where(c, got)
      if (got.hp !== undefined) { if (hpWas[who] !== undefined && got.hp < hpWas[who]) hurtAt = gameClock.now(); hpWas[who] = got.hp }
      if (at !== 'out' && at !== 'gone') { if (outSince[who]) log(`${who} вернулся на арену за ${Math.round((gameClock.now() - outSince[who]) / 1000)} с`); delete outSince[who]; continue }
      const limit = at === 'gone' ? GONE_MS : RETURN_MS
      if (!outSince[who]) { outSince[who] = gameClock.now(); log(at === 'gone' ? `${who} за стеной поля — ${limit / 1000} с, и вылет` : `${who} выпал с арены — ${limit / 1000} с на возвращение`) }
      if (gameClock.now() - outSince[who] > limit && !over.done) {
        over.done = true
        over.ringout = who
        log(`${who} не вернулся — вылет с ринга`)
        A.call('stop').catch(() => {})
        if (!HUMAN) B.call('stop').catch(() => {})
      }
    }
    if (!HUMAN && MAX_MS > 0 && !over.done && gameClock.now() - roundAt > MAX_MS) {
      over.done = true
      log(`раунд затянулся: ${Math.round(MAX_MS / 60000)} мин — ничья`)
      A.call('stop').catch(() => {})
      B.call('stop').catch(() => {})
    }
    if (!HUMAN && STALL_MS > 0 && !over.done && gameClock.now() - hurtAt > STALL_MS) {
      over.done = true
      log(`застой: ${Math.round(STALL_MS / 1000)} с никто не получал урона — ничья`)
      A.call('stop').catch(() => {})
      B.call('stop').catch(() => {})
    }
  }, 3000)
  const vs = HUMAN ? `${NA} ${score[NA]} : ${score[NB]} вы` : `${NA} ${score[NA]} : ${score[NB]} ${NB}`
  await cmd(`/say Раунд ${n}: ${kit.name}. Счёт ${vs}. 3... 2... 1... БОЙ!`); await sleep(3000)
  const [ra, rb] = await Promise.all([
    go(A, NA, HUMAN ? ACTIVE : [NB], kit.craft && kit.craft.a, HUMAN ? null : B),
    HUMAN ? Promise.resolve({ status: 'done', detail: {} }) : go(B, NB, [NA], kit.craft && kit.craft.b, A)
  ])
  gameClock.wall.clearInterval(stopWatch)
  gameClock.clearInterval(gameWatch)
  log(`${NA}: ${short(ra)}`)
  log(`${NB}: ${short(rb)}`)
  const da = ra.detail || {}
  const db = rb.detail || {}
  // Проиграл тот, кто умер (или выпал за стену); оба — ничья.
  if (over.ringout === NA) { da.died = true; da.ringout = true }
  if (over.ringout === NB) { db.died = true; db.ringout = true }
  const winner = da.died && !db.died ? NB : db.died && !da.died ? NA : !da.died && !db.died && da.killed ? NA : null
  if (winner) score[winner]++
  else score.draw++
  log(`итог: ${winner ? 'победил ' + winner : 'ничья'} | счёт ${NA} ${score[NA]} : ${score[NB]} ${NB}, ничьих ${score.draw}`)
  await sleep(4000)
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    // На арене никто не обижается сам: дерутся только по команде раунда.
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    // Чары — только демонам, которые с ними справляются: без gamedata.fixEnchants
    // бот с зачарованной киркой или мечом в руке не копает вовсе (try-ench.js
    // 2026-09-26: «enchantments.concat is not a function» — ни обсидиан, ни
    // паутина). Такой демон и параметр status { enchants } молча пропускает —
    // по нему и видно. ARENA_ENCH=force — не спрашивать.
    if (ENCH && ENCH_ARG !== 'force') {
      for (const [c, who] of HUMAN ? [[A, NA]] : [[A, NA], [B, NB]]) {
        const st = await c.call('status', { enchants: true }).catch(() => null)
        if (st && st.detail && Array.isArray(st.detail.enchants)) continue
        ENCH = false
        log(`чары выключены: демон ${who} не показывает чары предметов (src без gamedata.fixEnchants — с зачарованным инструментом не копает); ARENA_ENCH=force — выдавать всё равно`)
        break
      }
    }
    if (ENCH) log(`чары: бюджет ${ENCH_BUDGET.join('–')} на пару, допуск ±${ENCH_TOL}, ${PAIR === '0' ? 'без пар' : PAIR === 'sides' ? 'пары с обменом (и сторон)' : 'пары с обменом'}${process.env.ARENA_ENCH_SEED ? ', seed ' + process.env.ARENA_ENCH_SEED : ''}`)
    if (!GENTLE) {
      await cmd('/difficulty normal')
      await cmd('/time set day')
      await cmd('/gamerule do_daylight_cycle false')
      await cmd('/gamerule spawn_mobs false')
      await cmd('/gamerule do_immediate_respawn true')
    }
    // Чат не засорять ответами на /give, /tp, /fill: пользователь просил только
    // объявление перед боем. Правило возвращается в конце.
    await cmd('/gamerule send_command_feedback false')
    await cmd('/gamerule log_admin_commands false')
    // Потолок — если в выбранных наборах есть заряды ветра или булава (см. CEIL_H).
    const chosen = KITS.filter(k => (!ONLY || ONLY.split(',').some(f => k.name.includes(f))) && !(MODE === 'kits' && k.craft) && !(MODE === 'craft' && !k.craft))
    // В Колизее — всегда: взрывы и элитры не должны выносить бойцов и лучи на трибуны.
    CEIL = process.env.ARENA_CEIL ? process.env.ARENA_CEIL === '1' : COLOS || chosen.some(k => [...(k.a || []), ...(k.b || [])].some(i => /^(minecraft:)?(wind_charge|mace|elytra)\b/.test(i)))
    if (CEIL) log(`потолок: ${COLOS ? 'барьер' : 'стекло'} до ${TOP()}, барьер на ${Y + CEIL_H}`)
    // Взрывчатка в наборах — барьерная оболочка за стеклом (blastShell) и уборка
    // вагонеток и кристаллов между раундами.
    BLAST = chosen.some(k => [...(k.a || []), ...(k.b || [])].some(i => /^(minecraft:)?(tnt_minecart|end_crystal|tnt)\b/.test(i)))
    if (BLAST) log(`взрывчатка в наборах: ${COLOS ? 'стены Колизея — барьер' : 'за стеклом оболочка из барьера'}`)
    if (COLOS) { CZM = CZ.model({ R: CLEAN_R, ceilH: CEIL_H }); CZFP = CZ.footprint(CZM, { X, Y, Z }) }
    await buildArena()
    for (const h of HUMANS) await cmd(`/gamemode survival ${h}`)
    if (WATCH) {
      await cmd(`/gamemode spectator ${WATCH}`)
      // В Колизее — в императорскую ложу (пульвинар), лицом к полю.
      if (COLOS) { const w = CZ.watchSpot(CZM, { X, Y, Z }); await cmd(`/tp ${WATCH} ${w.x} ${w.y} ${w.z} ${w.yaw} ${w.pitch}`) } else await cmd(`/tp ${WATCH} ${X} ${Y + 6} ${Z}`)
    }
    if (!GENTLE) {
      await cmd(`/spawnpoint ${NA} ${X - 6} ${Y} ${Z}`)
      await cmd(`/spawnpoint ${NB} ${X + 6} ${Y} ${Z}`)
    }
    log(`арена готова: ${X} ${Y} ${Z}`)
    const playKits = KITS.filter(kit => !(ONLY && !ONLY.split(',').some(f => kit.name.includes(f))) && !(MODE === 'kits' && kit.craft) && !(MODE === 'craft' && !kit.craft))
    // Без конца и наборов несколько («арсенал,небо и порох») — по очереди,
    // раунд за раундом: иначе первый шёл бы вечно, а до второго не доходило.
    if (ROUNDS === 0 && playKits.length > 1) {
      for (let i = 1; !stopRequested(); i++) await round(playKits[(i - 1) % playKits.length], i)
      log('СТОП: в чате «хватит»')
    } else {
      for (const kit of playKits) {
        for (let i = 1; (ROUNDS === 0 || i <= ROUNDS) && !stopRequested(); i++) await round(kit, i)
        if (stopRequested()) { log('СТОП: в чате «хватит»'); break }
      }
    }
    log(`ФИНАЛ: ${NA} ${score[NA]} : ${score[NB]} ${NB}, ничьих ${score.draw}`)
  } catch (e) {
    log('FAILED:', e.stack || e.message)
    process.exitCode = 1
  } finally {
    // Характер основному бойцу — обратно: в обычной игре он должен отвечать.
    await cmd('/gamerule send_command_feedback true').catch(() => {})
    await cmd('/gamerule log_admin_commands true').catch(() => {})
    // Зрителя — обратно в выживание, на пол арены (в воздухе он бы упал).
    // В Колизее — на пол пульвинара: в поле его заперли бы барьеры.
    if (WATCH) {
      if (COLOS && CZM) { const w = CZ.watchSpot(CZM, { X, Y, Z }); await cmd(`/tp ${WATCH} ${w.x} ${w.y} ${w.z} ${w.yaw} 0`).catch(() => {}) } else await cmd(`/tp ${WATCH} ${X} ${Y} ${Z}`).catch(() => {})
      await cmd(`/gamemode survival ${WATCH}`).catch(() => {})
    }
    // Ответка — в полную силу, как до арены (просьба 2026-09-25).
    await A.call('temper', { enabled: true, firstHitChance: 1, fightSeconds: 300, calmSeconds: 30, retreatAtHealth: 3 }).catch(() => {})
    A.ws.close(); B.ws.close()
  }
})()

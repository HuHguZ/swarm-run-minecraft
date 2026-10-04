'use strict'
// Спуск под охраной: лесенка вниз и моб, который приходит сзади по ней же.
//
// Откуда сцена: поход 2026-09-16, «--- вниз ---». Нога west с y=-7 принесла
// события damage ×4 и 14 хп, следующая — ещё ×5 и прерывание по low_health, а
// штрек сразу после неё встретил «zombie в 0.7 блоках впереди, вплотную».
// Девять ударов по телу, которое всё это время копало: у dig_down нет ни моба в
// interruptOn (и правильно — урон не должен обрывать спуск), ни собственных
// глаз. Теперь они есть: actions.descentGuard смотрит перед каждым взмахом,
// спрашивает reach.reachOf «дотянется ли он до меня», закрывается блоками, если
// дотянется, и называет бой с целью, если закрыться нечем.
//
// Здесь это проверяется на настоящем сервере в трёх положениях, и у каждого
// своя цена ошибки:
//   (а) КОНТРОЛЬ, обязан покраснеть: зомби на моей лесенке, а я просто стою —
//       арена должна кусаться. Если она не кусается, зелёное в (б) ничего не
//       значит, и (б) печатается как ПРОП, а не как OK.
//   (б) ОБЯЗАН ЗАКРЫТЬСЯ: тот же зомби, но бот копает. Стена — две клетки
//       ступеньки позади (клетка ног той ступеньки и клетка над ней), и после
//       неё ни одного удара.
//   (в) ОБЯЗАН ПРОЙТИ МИМО: зомби в замурованной пещере под лесенкой, за 4+
//       блоками породы. Ни одного блока, ни одной остановки — и всё равно назван
//       в behindRock: иначе «прошёл мимо» неотличимо от «не заметил».
//   (г) НЕ ЗАКРЫТЬСЯ ЧЕСТНО: зомби стоит в самой клетке, куда пошла бы стена.
//       Остановка с threat.next, бой по названной цели, и та же нога после боя
//       не отвечает тем же самым — иначе ход, который назвал отказ, не работает.
//
// Арена x≈3000: дальше всех остальных сцен (600..670 штрек, 2000 щит, 2400
// преflight), чтобы чужой мусор нельзя было принять за местность этой.
const fs = require('fs')
const WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
const state = async () => (await call('status')).state
const pos = async () => (await state()).pos

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

async function step (label, method, params) {
  const r = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const problem = r.status === 'failed' ? ` ← ${r.error}` : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`${label.padEnd(26)} ${String(r.status).padEnd(11)} ${JSON.stringify(r.detail ?? null)}${problem}`)
  if (r.by) console.log(`${''.padEnd(26)} прервано: ${r.by.type}`)
  const ev = (r.events || []).map(e => e.type)
  if (ev.length) console.log(`${''.padEnd(26)} события: ${ev.join(', ')}`)
  return r
}
const damageIn = r => (r.events || []).filter(e => e && e.type === 'damage').length

// ---------------------------------------------------------------- вердикты

let failures = 0
let skipped = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'ПЛОХО'} ${label}${note === '' ? '' : ' — ' + note}`)
}
// «Код сделал не то» и «опыт не поставлен» — разные новости. Сцена, которая
// печатает их одинаково, стоит вечера спора не о том баге.
function skip (label, why) {
  skipped++
  console.log(`  ПРОП  ${label} — ${why}`)
}
let caseName = ''
function header (name) {
  caseName = name
  console.log('\n=== ' + name + ' ===')
}
async function ready () {
  const st = await state()
  if (st.health >= 18) return true
  skip(caseName, `вошёл с ${st.health} хп — опыт не поставлен, а не провален`)
  return false
}

// Ответ сервера, а не факт отправки. Команда, от которой зависит условие сцены,
// подтверждается строкой в server/logs/latest.log: отказ оператору в лог не
// пишется, и все прошлые «арены без мобов» были аренами со спавном.
const LOG = process.env.ND_SERVER_LOG || 'C:/Users/user/Desktop/work/minecraft-claude/server/logs/latest.log'
function logSize () {
  try { return fs.statSync(LOG).size } catch { return null }
}
function logSince (from) {
  if (from === null) return null
  try {
    const fd = fs.openSync(LOG, 'r')
    const size = fs.statSync(LOG).size
    const buf = Buffer.alloc(Math.max(0, size - from))
    fs.readSync(fd, buf, 0, buf.length, from)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch { return null }
}
// Выполнить команду и проверить, что сервер ответил тем, чем должен.
async function confirm (label, text, re) {
  const at = logSize()
  await cmd(text)
  await sleep(400)
  const tail = logSince(at)
  if (tail === null) { skip(label, `лог сервера не прочитать (${LOG})`); return null }
  const ok = re.test(tail)
  check(label, ok, ok ? '' : `в логе нет ${re}: ${tail.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 160)}`)
  return ok
}
// Есть ли блок в клетке — глазами сервера, а не отчётом демона. Ответ приходит
// в лог тем же путём, что и всё остальное.
async function blockIs (label, [x, y, z], name) {
  const at = logSize()
  await cmd(`/execute if block ${x} ${y} ${z} minecraft:${name} run say ЕСТЬ ${x} ${y} ${z} ${name}`)
  await sleep(400)
  const tail = logSince(at)
  if (tail === null) { skip(label, 'лог сервера не прочитать'); return null }
  const ok = tail.includes(`ЕСТЬ ${x} ${y} ${z} ${name}`)
  check(label, ok, ok ? '' : `сервер не подтвердил ${name} на ${x} ${y} ${z}`)
  return ok
}

// ---------------------------------------------------------------- арена

const X0 = 3000
const Z = 3000
const TOP = 70 // ступенька k стоит на x = X0 + k, ноги на TOP - k
const STAND_K = 6
const STAND = { x: X0 + STAND_K, y: TOP - STAND_K, z: Z } // 3006, 64, 3000
const stepCell = k => ({ x: X0 + k, y: TOP - k, z: Z })
const feetOfColumn = x => TOP - (x - X0)
// Первая клетка, которую нога на east обязана ПРОРУБИТЬ: ноги на STAND, средняя
// клетка следующей ступеньки. Если она окажется воздухом, арена вернулась к той,
// где нога бежит по готовой лесенке.
const FIRST_CUT = { x: STAND.x + 1, y: STAND.y, z: Z }

// Коробка льётся, пока бот стоит НАД ней: сплошная заливка вокруг тела на
// полсекунды замуровала бы его, а голова в камне при падающем здоровье — это
// ровно тот сигнал, по которому автопилот начинает рыть арену, которую сцена
// ещё строит.
async function arena (label) {
  header(label)
  await call('stop')
  await sleep(800)
  await cmd('/difficulty normal')
  await cmd('/gamerule advance_time false')
  await cmd('/effect give @s minecraft:slow_falling 30 0 true')
  await cmd(`/tp @s ${X0}.5 90 ${Z}.5`)
  await sleep(3500) // чанки должны доехать до заливки
  // @e видит только прогруженные чанки, поэтому чистить арену можно только
  // стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  const spawn = await confirm('сервер принял spawn_mobs false', '/gamerule spawn_mobs false', /spawn_mobs.*false/i)
  if (spawn === false) return false
  // 41 x 37 x 11 = 16687 блоков — под пределом /fill в 32768.
  await cmd(`/fill ${X0 - 10} 40 ${Z - 5} ${X0 + 30} 76 ${Z + 5} minecraft:stone`)
  // Прорезаны только ступеньки ПОЗАДИ бота (k = 0..6): мобу этого хватает,
  // чтобы спуститься ко мне, а вперёд нога идёт по сплошному камню — и это не
  // мелочь. В digStairs взгляд стража перед взмахом стоит ПОСЛЕ проверки
  // «клетка и так пуста», так что по готовой лесенке нога пробегает вообще без
  // единого взмаха: страж смотрит только сверху уровня, уровень занимает не
  // секунды, а доли, и «зомби не ударил ни разу» было бы замерено в лёгком
  // случае — не в том, ради которого сцена написана. Уровень в камне — это три
  // взмаха плюс шаг, то самое окно, которое зомби на живом сервере и выигрывает.
  for (let k = 0; k <= STAND_K; k++) {
    const c = stepCell(k)
    await cmd(`/fill ${c.x} ${c.y} ${c.z} ${c.x} ${c.y + 2} ${c.z} minecraft:air`)
  }
  // Замурованный карман под лесенкой: потолок y=52, а пол ступеньки k=12 лежит
  // на y=57 — четыре блока породы, и ни одной дороги наверх.
  await cmd(`/fill ${X0 + 8} 50 ${Z - 1} ${X0 + 12} 52 ${Z + 1} minecraft:air`)
  await cmd('/clear @s')
  for (const give of [
    'minecraft:iron_pickaxe 2', 'minecraft:iron_sword 1', 'minecraft:cobblestone 64',
    'minecraft:torch 32', 'minecraft:cooked_beef 16',
    'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1', 'minecraft:iron_leggings 1', 'minecraft:iron_boots 1'
  ]) await cmd(`/give @s ${give}`)
  await cmd(`/tp @s ${STAND.x}.5 ${STAND.y} ${STAND.z}.5`)
  await cmd(`/spawnpoint @s ${STAND.x} ${STAND.y} ${STAND.z}`)
  await sleep(2000)
  await cmd('/kill @e[type=!player]')
  await cmd('/effect give @s minecraft:regeneration 12 5 true')
  await sleep(6000)

  // Мир после постройки, до замера: коробка, не вставшая из-за непрогруженного
  // чанка, — это сломанная арена, и всё, что сцена дальше скажет, было бы о ней.
  const p = await pos()
  const here = p.x === STAND.x && p.y === STAND.y && p.z === STAND.z
  if (!here) { skip(caseName, `стою на ${JSON.stringify(p)}, а не на ${JSON.stringify(STAND)} — арена не встала`); return false }
  const wall = await blockIs('арена: ступенька позади ещё открыта (воздух на 3005,65)', [X0 + 5, feetOfColumn(X0 + 5), Z], 'air')
  if (wall === false) { skip(caseName, 'лесенка позади не прорезана — мобу не по чему ко мне идти'); return false }
  // Вторая половина того же вопроса, и без неё сцена тихо вырождается: копать
  // впереди должно быть что.
  const rock = await blockIs(`арена: впереди камень, а не готовая лесенка (${FIRST_CUT.x},${FIRST_CUT.y})`, [FIRST_CUT.x, FIRST_CUT.y, FIRST_CUT.z], 'stone')
  if (rock === false) { skip(caseName, 'путь вперёд уже прорезан — нога пройдёт без взмахов, и замер будет не о том'); return false }
  return ready()
}

// Зомби на ступеньке k, без ИИ: он должен стоять там, где его поставили, пока
// сцена не разрешит ему идти. Иначе замер начинается неизвестно откуда.
async function summonOnStep (k, { awake = true } = {}) {
  const c = stepCell(k)
  await cmd(`/summon minecraft:zombie ${c.x}.5 ${c.y} ${c.z}.5 {PersistenceRequired:1b,NoAI:1b,Health:20f}`)
  await sleep(900)
  const seen = await call('observe', { radius: 24, fair: false }).catch(() => null)
  const ents = (seen && seen.detail && seen.detail.entities) || []
  const z = ents.find(e => /zombie/i.test(`${e.name} ${e.kind || ''}`))
  if (!z) return null
  if (awake) {
    await cmd('/data merge entity @e[type=zombie,limit=1,sort=nearest] {NoAI:0b}')
  }
  return z
}

const wallCells = d => (d.met || []).filter(m => m.what === 'заложился').flatMap(m => m.wall || [])
const onStairsBehind = c => c.z === Z && (c.y === feetOfColumn(c.x) || c.y === feetOfColumn(c.x) + 1)

// ------------------------------------------------- (а) контроль: арена кусается

// Единственный случай, которому положено покраснеть. Без него «зомби не ударил
// ни разу» в (б) может значить всё что угодно — в том числе что зомби вообще не
// пошёл. Проверка, которая не может провалиться, ничего не доказывает.
let arenaBites = null
async function caseControlBites () {
  if (!await arena('(а) КОНТРОЛЬ: зомби на лесенке, а я стою — арена обязана кусаться')) return
  const z = await summonOnStep(1)
  if (!z) { skip(caseName, 'зомби не появился'); return }
  const before = await state()
  const r = await step('стою 12 секунд', 'wait', { seconds: 12 })
  const after = await state()
  const hurt = damageIn(r) + Math.max(0, before.health - after.health)
  arenaBites = hurt > 0
  console.log(`  хп ${before.health} -> ${after.health}, событий damage ${damageIn(r)}`)
  check('арена кусается: стоя рядом с зомби, тело получает урон (ЭТО ожидаемое красное для бота, но зелёное для сцены)', arenaBites,
    arenaBites ? '' : 'зомби не дошёл и не ударил — арена беззубая, и (б) ниже ничего не докажет')
  await cmd('/kill @e[type=zombie]')
}

// ------------------------------------------------- (б) обязан закрыться

async function caseMustClose () {
  if (!await arena('(б) зомби сверху по моей же лесенке: закрыться двумя блоками и копать дальше')) return
  const z = await summonOnStep(1)
  if (!z) { skip(caseName, 'зомби не появился'); return }
  const before = await state()
  const r = await step('лесенка east 6', 'dig_down',
    { mode: 'stairs', depth: 6, direction: 'east', torchEvery: 0, timeoutSeconds: 120 })
  const d = r.detail || {}
  const after = await state()
  if (!d.met && !d.threat) {
    check('страж вообще увидел зомби', false, `met=${JSON.stringify(d.met)} threat=${JSON.stringify(d.threat)} stopped=${d.stopped || '-'}`)
  }
  const cells = wallCells(d)
  check('страж закрылся от зомби', cells.length >= 1, `met=${JSON.stringify(d.met)}`)
  check('стена — клетки ступеньки позади, а не на моём уровне', cells.length >= 1 && cells.every(onStairsBehind), JSON.stringify(cells))
  if (cells.length) await blockIs('сервер подтверждает первый блок стены', [cells[0].x, cells[0].y, cells[0].z], 'cobblestone')
  const hurt = damageIn(r) + Math.max(0, before.health - after.health)
  // Не «!== false», а «!== true»: контроль (а) остаётся null на каждом своём
  // пути в обход (арена не встала, spawn_mobs не принят, зомби не появился, мало
  // хп) — и тогда о зубах арены не известно ничего. Контроль, который не
  // отработал, и контроль, который отработал и покраснел, одинаково не дают
  // права назвать это победой стража.
  if (arenaBites !== true) {
    skip('зомби не ударил ни разу', arenaBites === false
      ? 'арена в (а) не кусалась — это не победа стража'
      : 'контроль (а) не отработал: кусается арена или нет, неизвестно')
  } else check('зомби не ударил ни разу', hurt === 0, `урон ${hurt}, хп ${before.health} -> ${after.health}`)
  check('лесенка не встала на нём, а прошла вниз', (d.steps || 0) >= 4 && !d.threat, `steps=${d.steps} stopped=${d.stopped || '-'}`)
  await cmd('/kill @e[type=zombie]')
}

// ------------------------------------------------- (в) обязан пройти мимо

async function caseMustIgnore () {
  if (!await arena('(в) зомби в замурованной пещере под лесенкой: не закрываться, не вставать, но назвать')) return
  await cmd(`/summon minecraft:zombie ${X0 + 10}.5 50 ${Z}.5 {PersistenceRequired:1b}`)
  await sleep(1200)
  const seen = await call('observe', { radius: 24, fair: false }).catch(() => null)
  const ents = (seen && seen.detail && seen.detail.entities) || []
  const z = ents.find(e => /zombie/i.test(`${e.name} ${e.kind || ''}`))
  if (!z) { skip(caseName, 'зомби не появился'); return }
  check('арена: зомби в кармане, а не на лесенке', z.pos.y <= 52, JSON.stringify(z.pos))
  const r = await step('лесенка east 6', 'dig_down',
    { mode: 'stairs', depth: 6, direction: 'east', torchEvery: 0, timeoutSeconds: 120 })
  const d = r.detail || {}
  check('прошёл все 6 уровней', (d.steps || 0) === 6, `steps=${d.steps} stopped=${d.stopped || '-'}`)
  check('не встал и угрозы не назвал', !d.stopped && !d.threat, `${d.stopped || ''} ${JSON.stringify(d.threat || null)}`)
  check('ни одной стены от него не поставлено', wallCells(d).length === 0, JSON.stringify(d.met || null))
  // Без этой строки та же зелень получилась бы, если бы зомби просто не
  // прогрузился: «прошёл мимо» и «не заметил» надо различать.
  check('но зомби назван фоном (behindRock)', !!(d.behindRock && /zombie/.test(d.behindRock.mob)), JSON.stringify(d.behindRock || null))
  await cmd('/kill @e[type=zombie]')
}

// ------------------------------------------------- (г) закрыться нечем

async function caseContact () {
  if (!await arena('(г) зомби стоит в самой клетке стены: встать честно, назвать бой, и чтобы ход сработал')) return
  const z = await summonOnStep(5)
  if (!z) { skip(caseName, 'зомби не появился'); return }
  const r = await step('лесенка east 6', 'dig_down',
    { mode: 'stairs', depth: 6, direction: 'east', torchEvery: 0, timeoutSeconds: 120 })
  const d = r.detail || {}
  const t = d.threat || null
  check('встал именно на зомби', !!(t && /zombie/.test(t.mob)), `${d.stopped || '-'}`)
  check('сказал, что закрыться не вышло, а не приписал себе стену', !!t && t.sealed === false, JSON.stringify(t))
  check('назвал бой с целью полями (threat.next)', !!(t && t.next && t.next.call === 'mc_fight' && t.next.target === 'zombie'), JSON.stringify(t && t.next))
  check('в словах тот же бой и тот же вызов обратно', /mc_fight target=zombie/.test(d.stopped || '') && /mc_dig_down mode=stairs direction=east/.test(d.stopped || ''), d.stopped)
  check('сосчитал, со скольких сторон до него дотягиваются', typeof (t && t.reach) === 'number', JSON.stringify(t && t.reach))
  if (!t) { await cmd('/kill @e[type=zombie]'); return }
  // Ход, названный отказом, должен работать: бой по названной цели, потом та же
  // нога с того же места. Отказ, который возвращает сам себя, — тупик.
  const f = await step('  бой по названной цели', 'fight', { target: t.next.target, retreatAtHealth: 7, timeoutSeconds: 45 })
  const again = await step('лесенка east 6 (после боя)', 'dig_down',
    { mode: 'stairs', depth: 6, direction: 'east', torchEvery: 0, timeoutSeconds: 120 })
  const ad = again.detail || {}
  const same = !!(ad.threat && ad.threat.mob === t.mob && ad.threat.sealed === false && (ad.steps || 0) === 0)
  check('после названного боя лесенка пошла, а не вернула тот же отказ', !same,
    `убит=${(f.detail && f.detail.killed) || '-'} steps=${ad.steps} stopped=${ad.stopped || '-'}`)
  await cmd('/kill @e[type=zombie]')
}

ws.on('open', async () => {
  try {
    await call('connect')
    await caseControlBites()
    await caseMustClose()
    await caseMustIgnore()
    await caseContact()
    await cmd('/kill @e[type=!player,type=!item]')
    // spawn_mobs остаётся выключенным в мире после сцены — перед живой игрой его
    // надо вернуть, и сцена говорит это вслух, а не оставляет сюрпризом.
    await cmd('/gamerule spawn_mobs true')
    console.log(`\nитог: красных ${failures}, пропущенных ${skipped}` +
      (arenaBites === true ? '' : arenaBites === false
        ? ' (арена не кусалась: «зомби не ударил» нигде не считается победой)'
        : ' (контроль (а) не отработал: зубы арены не измерены, «зомби не ударил» нигде не засчитан)'))
    if (failures) process.exitCode = 1
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })

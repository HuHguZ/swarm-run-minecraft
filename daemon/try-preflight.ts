'use strict'
const gameClock = require('./src/game-clock')
// Снаряжение на входе в долгое намерение: сцена для daemon/src/preflight.js.
//
// До этой правки тело уходило в работу в том, что случайно было на нём.
// Броню надевал ровно один механизм — таймер автопилота, а он стоит в стороне
// всё время любого намерения (autopilot.js bodyBusy); одевался только бой.
// Факелы проверялись лениво и молча, и штрек узнавал, что светить нечем, на
// двадцатом блоке. recover шёл к куче с прошлой смерти с тем, что было в руке.
//
// Теперь session.runIntent сверяет тело с таблицей (preflight.js NEEDS): броню
// из рюкзака и оружие получше надевает сам и пишет в gear.did, а то, что может
// решить только мозг (факелы, еда, щит), НЕ отказывает, а кладёт словами в
// gear.need — отдельным полем, чтобы detail.need действия никто не затёр.
//
// Что проверено без сервера (scratchpad wf2: check-preflight.js и
// check-fixes.js, у каждой проверки контрольная поломка, которая краснеет) и
// потому здесь НЕ перепроверяется: арифметика таблицы и еды, порядок строк в
// format.js, мгновенный ответ на чат в гонке, потолок в 3 с, «моб ближе шести
// блоков и видит меня — броню не трогаю, меч беру», урон по убойности, а не
// «меч всегда лучше топора».
// Здесь — только то, чего заглушка видеть не может:
//   (а) сервер подтверждает броню, надетую на пороге штрека: gear.did обязан
//       совпасть с тем, что через секунду лежит в слотах (свидетель на
//       состоянии, а не на клике), и штрек при этом ИДЁТ, а не отказывает;
//   (б) всё на месте — поля gear нет вовсе (ноль строк мозгу);
//   (в) recover кладёт меч в руку, и сервер руку не откатывает; щит словами;
//   (в2) recover на три уровня вниз: лесенка берёт кирку на каждый рез, и у
//       кучи меч обязан быть в руке снова (survival.recoverLoot -> preflight.rearm);
//   (г) урон посреди ожидания курсора (бот ест) обрывает намерение ДО работы:
//       тело не копает за спиной ответа — свидетель: камня в рюкзаке нет через
//       три секунды; ответ говорит notStarted;
//   (д) то же для чата живого игрока — только с ND_PREFLIGHT_CHAT=1, потому что
//       это второй клиент в мире;
//   (е) короткое намерение (craft) поля gear не несёт.
//
// ГРАБЛИ (оплачены другими сценами):
//   * первым делом stop — прошлый прогон мог оставить демона доигрывать;
//   * /clear @s до выдачи: в полный рюкзак /give роняет предмет, и он же снимает
//     надетое — иначе броня из прошлого случая «надета без клика»;
//   * координаты в командах — через ПРОБЕЛ; /fill меньше 32768 и после /tp;
//   * /kill @e[type=!player] только СТОЯ в арене — после /tp, и ещё раз перед
//     замером;
//   * сложность, моб-спавн, время и точка возрождения объявлены здесь целиком:
//     на peaceful голод не убывает, и случай (г) не смог бы поесть;
//   * /tp с высоты убивает — медленное падение даётся ДО телепорта;
//   * мир проверяется после постройки, до замера: под ногами обязан быть камень;
//   * события копятся на транспорте: любой ответ демона дренит шину;
//   * красное — только там, где виноват код. «Автопилот успел одеть раньше»,
//     «урон пришёл уже после проверки» — это [ЦИФРА] и «случай не лёг», а не
//     провал.
//
//   node daemon/try-preflight.js
//   ND_PREFLIGHT_CHAT=1 node daemon/try-preflight.js   — плюс случай (д) с игроком Igrok
//
// Нужен поднятый демон и бот в игре (оператор). Код возврата ненулевой, если
// хоть одна проверка пришла [ПЛОХО].
const WebSocket = require('ws')

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

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}
function report (label, note) {
  console.log(`  [ЦИФРА] ${label} — ${note}`)
}
// Предусловие случая. Не выполнено — это мир (автопилот успел раньше, сытость
// не та), а не код: печатается цифрой, и случай дальше не мерится.
function gate (label, ok, note = '') {
  if (!ok) report('случай не лёг', `${label}${note ? ': ' + note : ''}`)
  return ok
}

const state = async () => ((await call('status')) as any).state
const needOf = (r, what) => ((r && r.gear && r.gear.need) || []).find(n => n.what === what)
const didText = r => ((r && r.gear && r.gear.did) || []).join('; ')
const offHandName = s => {
  const v = s && s.offHand
  if (!v) return null
  return typeof v === 'string' ? v : (v.item || null)
}

async function step (label, method, params) {
  const t0 = gameClock.now()
  const r: any = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const ms = gameClock.now() - t0
  const tail = r.error ? ` ← ${r.error}` : ''
  console.log(`  ${label.padEnd(28)} ${String(r.status).padEnd(11)} ${ms} мс${tail}`)
  if (r.gear) console.log(`  ${''.padEnd(28)} gear ${JSON.stringify(r.gear)}`)
  if (r.detail) console.log(`  ${''.padEnd(28)} detail ${JSON.stringify(r.detail).slice(0, 300)}`)
  if (r.by) console.log(`  ${''.padEnd(28)} прервано: ${r.by.type}`)
  r.ms = ms
  return r
}

// ------------------------------------------------------------------- арена

// x=2400: дальше арен всех остальных прогонов (try-shield живёт у 2000, соседи
// у 1300..1900), чтобы чужой мусор нельзя было принять за местность этой.
// Комната в камне и сплошная порода к востоку от неё — туда идёт штрек.
//
// Коробка льётся КУСКАМИ вокруг комнаты, а не сплошняком с последующей
// выемкой: бот стоит в комнате, и сплошная заливка на полсекунды замуровала бы
// его — а голова в камне при падающем здоровье это ровно тот сигнал, по
// которому автопилот начинает откапываться (autopilot.js freeIfBuried), то
// есть рыть дыры в арене, которую сцена ещё строит.
const SHELL = [
  ['2388 75 2388', '2430 80 2412'], // пол, 43x6x25 = 6450
  ['2388 86 2388', '2430 90 2412'], // потолок, 43x5x25 = 5375
  ['2388 81 2388', '2389 85 2412'], // запад, 2x5x25
  ['2406 81 2388', '2430 85 2412'], // восток — порода под штрек, 25x5x25 = 3125
  ['2390 81 2388', '2405 85 2389'], // север, 16x5x2
  ['2390 81 2411', '2405 85 2412'] //  юг, 16x5x2
]
const ROOM = ['2390 81 2390', '2405 85 2410']   // 16x5x21 = 1680, пол y=80
const STAND = '2405.5 81 2400.5'                 // лицом к стене x=2406
const STAND_XZ = { x: 2405, y: 81, z: 2400 }

async function arena (label) {
  console.log(`\n=== ${label} ===`)
  await call('stop')
  await sleep(800)
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set 6000')
  // normal, а не peaceful: на peaceful сытость не убывает, а случаю (г) надо
  // поесть. Мобов в комнате нет потому, что коробка закрыта со всех сторон и
  // каждая её клетка ближе 24 блоков к боту, а ближе враждебные не спавнятся.
  // Правило спавна выше — страховка сверху, не защита: сервер принимает его
  // только под именем, которое знает 1.21.11, и без ответной строки в
  // server/logs/latest.log оно не сработало.
  await cmd('/difficulty normal')
  await cmd('/effect give @s minecraft:slow_falling 10 0 true')
  await cmd(`/tp @s ${STAND}`)
  await cmd('/kill @e[type=!player]')
  await sleep(3000) // чанки должны доехать до заливки
  // Воздух первым: он же убирает факелы и огрызки прошлого случая из комнаты,
  // а порода к востоку заливается заново и закрывает прошлый штрек.
  await cmd(`/fill ${ROOM[0]} ${ROOM[1]} minecraft:air`)
  for (const [a, b] of SHELL) await cmd(`/fill ${a} ${b} minecraft:stone`)
  await cmd(`/tp @s ${STAND}`)
  await cmd(`/spawnpoint @s ${STAND_XZ.x} ${STAND_XZ.y} ${STAND_XZ.z}`)
  await cmd('/clear @s')
  await cmd('/effect clear @s')
  await cmd('/effect give @s minecraft:saturation 1 20 true')
  await sleep(1500)
  await cmd('/kill @e[type=!player]')

  // Мир после постройки, до замера. Коробка, не вставшая из-за непрогруженного
  // чанка, — это сломанная арена, и всё, что сцена дальше скажет, было бы о ней.
  const s = await state()
  const seen = await call('observe', { radius: 4, fair: false }).catch(() => null)
  const under = seen && seen.detail && seen.detail.terrain ? seen.detail.terrain.standingOn : null
  const inside = s.pos && s.pos.x === STAND_XZ.x && s.pos.z === STAND_XZ.z && s.pos.y === STAND_XZ.y
  const ok = inside && under === 'stone'
  if (!ok) {
    console.log(`  АРЕНА НЕ ВСТАЛА: я на ${JSON.stringify(s.pos)}, под ногами ${under} — случай пропускаю`)
  }
  return ok
}

async function give (...items) {
  for (const it of items) await cmd(`/give @s minecraft:${it}`)
  await sleep(700)
}

const SET = ['iron_helmet 1', 'iron_chestplate 1', 'iron_leggings 1', 'iron_boots 1']
const WORN_WANT = { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' }

// ------------------------------------------------------------------- (а)

async function caseTunnelDress () {
  if (!await arena('(а) штрек: броня и щит из рюкзака на пороге, факелов нет')) return
  // Броня — последней и без пауз по 600 мс. Автопилот одевает бота сам раз в
  // 15 секунд, и всё время между первой выданной вещью брони и вызовом штрека —
  // это шанс, что он успеет раньше проверки: при семи выдачах подряд (~5 с) это
  // примерно один прогон из трёх, при четырёх по 250 мс (~1.5 с) — один из
  // десяти. Кика за спам не будет: счётчик сервера — +20 за команду, −1 за тик,
  // порог 200, и оператора он не выгоняет вовсе (paper-1.21.11,
  // ServerGamePacketListenerImpl.detectRateSpam спрашивает isOp), а бот оператор.
  // Еды нет нарочно: штрек на 4 блока — 8 клеток породы, еду просят с 48.
  await give('shield 1', 'iron_pickaxe 1')
  await cmd('/kill @e[type=!player]')
  const from = mark()
  for (const it of SET) {
    await call('say', { text: `/give @s minecraft:${it}` })
    await sleep(250)
  }
  await sleep(500)
  const before = await state()
  const early = since(from, 'armor')
  const bare = Object.entries<any>(WORN_WANT).filter(([slot, name]: any) => before.inventory[name] && !(before.armor && before.armor[slot]))
  // Предмет в мире обязан быть — иначе «надел» ничего не доказывает.
  if (!gate('до вызова вся броня лежит в рюкзаке, а не на теле', bare.length === 4 && !early.length,
    JSON.stringify({ вРюкзаке: bare.map(([, n]: any) => n), надето: before.armor, автопилот: early.map(e => e.equipped) }))) return

  const r: any = await step('tunnel east 4, факел через 2', 'tunnel', { direction: 'east', length: 4, torchEvery: 2, timeoutSeconds: 60 })
  const armorEvents = since(from, 'armor')
  await sleep(1200) // окно, в которое сервер откатил бы непринятый клик
  const after = await state()

  if (!r.gear || !r.gear.did) {
    // Автопилот одевается раз в 15 секунд, и его тик мог прийтись ровно между
    // выдачей и вызовом. Это мир, а не код.
    if (armorEvents.length || (before.armor && before.armor.torso)) {
      report('случай не лёг', `автопилот успел одеть сам: ${JSON.stringify(armorEvents.map(e => e.equipped))}`)
    } else {
      check('gear.did есть — тело одето на пороге', false, JSON.stringify(r.gear))
    }
  } else {
    const did = didText(r)
    for (const [slot, name] of Object.entries<any>(WORN_WANT)) {
      const claimed = did.includes(name)
      const onBody = after.armor && after.armor[slot] === name
      // Красное ровно одно: сказал «надел», а на теле нет. Обратное — «не
      // сказал, но надето» — значит, что успел автопилот.
      if (claimed) check(`${name}: сказано «надел» и сервер оставил на теле`, onBody, JSON.stringify(after.armor))
      else report(`${name} в did нет`, `на теле ${after.armor && after.armor[slot]}; skipped ${JSON.stringify(r.gear.skipped || null)}`)
    }
    if (did.includes('щит')) check('щит: сказано и в левой руке', offHandName(after) === 'shield', JSON.stringify(after.offHand))
    report('цена одевания', `${r.gear.ms} мс на ${did}`)
  }
  check('штрек не отказал: done с отчётом', r.status === 'done' && r.detail && typeof r.detail.dug === 'number', r.error || r.status)
  const torch = needOf(r, 'факелы')
  check('факелы: нужно 2, в рюкзаке 0', !!torch && torch.count === 2 && torch.have === 0, JSON.stringify(torch))
  check('need действия не затёрт снаряжением', !(r.detail && r.detail.need && r.detail.need.what === 'факелы'),
    JSON.stringify(r.detail && r.detail.need))
  // Не проверка кода, а свойство мира: без факелов в рюкзаке ставить нечего.
  if (r.detail) report('факелов поставлено (в рюкзаке их не было)', `${r.detail.torches}`)
  report('события armor внутри вызова (автопилот)', `${armorEvents.length}`)
}

// ------------------------------------------------------------------- (б)

async function caseAllThere () {
  if (!await arena('(б) штрек: всё при себе — поля gear нет')) return
  await give('iron_pickaxe 1', 'torch 8', 'cooked_beef 2')
  await cmd('/kill @e[type=!player]')
  const before = await state()
  if (!gate('факелы в рюкзаке есть', (before.inventory.torch || 0) >= 2, JSON.stringify(before.inventory))) return
  const r: any = await step('tunnel east 4, факел через 2', 'tunnel', { direction: 'east', length: 4, torchEvery: 2, timeoutSeconds: 60 })
  check('поля gear нет вовсе', r.gear === undefined, JSON.stringify(r.gear))
  if (r.detail) report('факелов поставлено', `${r.detail.torches}`)
}

// ------------------------------------------------------------------- (в)

async function caseRecover () {
  if (!await arena('(в) recover: меч в руку, щит словами')) return
  await give('stone_pickaxe 1', 'iron_sword 1')
  await step('кирку в руку', 'equip', { item: 'stone_pickaxe', destination: 'hand' })
  await cmd('/kill @e[type=!player]')
  const before = await state()
  if (!gate('до вызова в руке кирка', before.held === 'stone_pickaxe', before.held)) return

  // Явные координаты не несут часов (survival.recoverLoot), значит, отказа «вещи
  // пропали» не будет: восемь блоков по ровному полу комнаты.
  const r: any = await step('recover 2397 81 2400', 'recover', { x: 2397, y: 81, z: 2400, radius: 2, timeoutSeconds: 40 })
  await sleep(1200)
  const after = await state()
  if (/взял в руку iron_sword/.test(didText(r))) {
    check('сказано «взял меч» — и в руке меч после дороги', after.held === 'iron_sword', after.held)
  } else {
    check('gear.did называет меч в руке', false, JSON.stringify(r.gear))
  }
  const sh = needOf(r, 'щит')
  check('щит словами: нужно 1, в рюкзаке 0', !!sh && sh.count === 1 && sh.have === 0, JSON.stringify(sh))
  check('оружия словами не просит — меч есть', !needOf(r, 'оружие'), `need ${JSON.stringify((r.gear && r.gear.need) || [])}`)
  check('recover пошёл, а не отказал', r.detail && r.detail.went === true, JSON.stringify(r.detail && { went: r.detail.went, stopped: r.detail.stopped }))
}

// ------------------------------------------------------------------- (в2)

// Меч на пороге — ещё не меч у кучи. digStairs берёт кирку перед каждым резом
// (items.equipBestTool), и без правки recover доходил до кучи с киркой в руке —
// ровно туда, где стоит то, что убило. Цель — в полу комнаты: пол y=75..80
// льётся сплошным камнем, и лесенка с 81 на 78 целиком внутри него.
async function caseRecoverDown () {
  if (!await arena('(в2) recover на три уровня вниз: у кучи меч снова в руке')) return
  await give('stone_pickaxe 1', 'iron_sword 1')
  await step('кирку в руку', 'equip', { item: 'stone_pickaxe', destination: 'hand' })
  await cmd('/kill @e[type=!player]')
  const before = await state()
  if (!gate('до вызова в руке кирка, меч в рюкзаке', before.held === 'stone_pickaxe' && !!before.inventory.iron_sword,
    JSON.stringify({ held: before.held, bag: before.inventory }))) return

  const r: any = await step('recover 2399 78 2400', 'recover', { x: 2399, y: 78, z: 2400, radius: 2, timeoutSeconds: 60 })
  const d = r.detail || {} as Record<string, any>
  // Лесенки могло не быть по причинам мира (не дошёл до места, не хватило
  // времени) — тогда мерить нечего, и это цифра, а не провал.
  if (!gate('лесенка была: спуск прокопан', !!(d.descended && d.descended.steps >= 2),
    JSON.stringify({ status: r.status, descended: d.descended || null, stopped: d.stopped || null }))) return
  await sleep(1200)
  const after = await state()
  check('у кучи в руке меч, а не кирка лесенки', after.held === 'iron_sword',
    `в руке ${after.held}, стою на y=${after.pos && after.pos.y}, ступеней ${d.descended.steps}`)
}

// ------------------------------------------------------------------- (г)/(д)

async function drainTo (target, timeoutMs = 120000) {
  await cmd('/effect give @s minecraft:hunger 120 20 true')
  const deadline = gameClock.now() + timeoutMs
  while (gameClock.now() < deadline) {
    const s = await state()
    if (s.food <= target) break
    await sleep(500)
  }
  await cmd('/effect clear @s minecraft:hunger')
  await sleep(400)
  return (await state()).food
}

// Окно открывается едой: session.eat держит session.eating ~1.6 с, и проверка
// снаряжения ждёт курсор (preflight.js handsBusy) — прерывание в это окно
// попадает ВНУТРЬ проверки, до работы. mine выбран потому, что его работа
// видна в мире: камень ломается и ложится в рюкзак.
//
// Кираса выдаётся ПОСЛЕ того, как бот начал есть, и это не мелочь. Выданная до
// drainTo, она сорок секунд лежала в рюкзаке без намерения, автопилот надевал её
// сам (wearArmor на каждом холостом тике раз в 15 с), проверке нечего было
// ждать — и случай не ложился НИ РАЗУ, а сцена всё равно кончалась «всё
// зелёное». Во время еды автопилот одеть не может: equipBestArmor отказывает
// «ем» (armor.js), а когда еда кончится, уже идёт mine и тело занято.
//
// Свидетели «лёг» — мир и часы, а не текст ответа: кираса в рюкзаке и не на
// теле прямо перед mine, ответ на eat ещё не пришёл в момент прерывания (значит,
// session.eating держался всё окно), и прервало именно то, что сцена послала.
// Всё, что после этого, краснеет только по вине кода.
async function caseInterrupt (kind, igrok = null) {
  const title = kind === 'chat'
    ? '(д) чат игрока посреди ожидания курсора'
    : '(г) урон посреди ожидания курсора'
  if (!await arena(title)) return
  await give('iron_pickaxe 1', 'cooked_beef 4')
  const food = await drainTo(18)
  if (food >= 20 || food < 17) {
    report('случай не лёг', `сытость ${food}: при 20 есть не станет, ниже 17 ест автопилот`)
    return
  }
  if (kind === 'chat') {
    // После постройки арены, не до: заливка прошла бы по игроку.
    await cmd(`/tp ${igrok.name} 2398.5 81 2400.5`)
    await sleep(1000)
  }
  await cmd('/kill @e[type=!player]')

  const from = mark()
  let eatDone = false
  const eating = call('eat', {} as Record<string, any>).catch(e => ({ status: 'RPC', error: e.message })).then(x => { eatDone = true; return x })
  await call('say', { text: '/give @s minecraft:iron_chestplate 1' })
  await sleep(350)
  const before = await state()
  const bare = !!before.inventory.iron_chestplate && !(before.armor && before.armor.torso)
  const t0 = gameClock.now()
  const mining = call('mine', { block: 'stone', count: 1, radius: 8, timeoutSeconds: 30 })
    .catch(e => ({ status: 'RPC', error: e.message }))
  await sleep(500)
  const sentAt = gameClock.now()
  const eatingWhenSent = !eatDone
  if (kind === 'chat') igrok.bot.chat('стой, ты куда')
  else call('say', { text: '/damage @s 1 minecraft:generic' }).catch(() => {})
  const r: any = await mining
  const answeredMs = gameClock.now() - sentAt
  const ate = await eating
  console.log(`  mine ${r.status} через ${gameClock.now() - t0} мс, после ${kind} ${answeredMs} мс; error ${r.error || '-'}; notStarted ${r.notStarted}`)
  console.log(`  gear ${JSON.stringify(r.gear || null)}`)

  const landed = gate('кираса в рюкзаке и не на теле перед mine', bare,
    JSON.stringify({ bag: before.inventory.iron_chestplate || 0, torso: before.armor && before.armor.torso, stone: before.inventory.stone || 0 })) &&
    gate('в момент прерывания бот ещё ел (ответа на eat не было)', eatingWhenSent, `eat ${ate && ate.status}`) &&
    gate('в рюкзаке до вызова не было камня', !before.inventory.stone && !before.inventory.cobblestone, JSON.stringify(before.inventory)) &&
    gate(`прервало именно ${kind}`, r.status === 'interrupted' && !!r.by && r.by.type === kind,
      `status ${r.status}, by ${r.by && r.by.type}`)
  if (!landed) return

  await sleep(3000)
  const after = await state()
  check('работа не началась за спиной ответа: камня в рюкзаке нет через 3 с',
    !after.inventory.stone && !after.inventory.cobblestone, `stone ${after.inventory.stone || 0}, cobblestone ${after.inventory.cobblestone || 0}`)
  check('отчёта действия нет — работы не было', !r.detail && !r.partial, JSON.stringify(r.detail || null))
  check('ответ говорит «к работе не приступал» (notStarted)', r.notStarted === true, `notStarted ${r.notStarted}`)
  // Бот ел всё окно, кираса лежала в рюкзаке: проверка обязана была ждать руки
  // и обязана об этом сказать — у чата тоже, хотя его ответ уходит без grace.
  const dress = needOf(r, 'надеть броню')
  check('в ответе сказано, что ждал руки: «надеть броню … (ем)»', !!dress && /\(ем\)/.test(dress.why),
    JSON.stringify((r.gear && r.gear.need) || null))
  if (kind === 'chat') {
    // Без правки ответ ждал бы конца еды и клики брони: ~1.6 с + 0.4 с.
    check('чат отвечен сразу, а не после одевания', answeredMs < 700, `${answeredMs} мс`)
    report('события внутри вызова', since(from).map(e => e.type).join(', ') || '—')
  } else {
    check('в error сказано «прервано ещё до начала»', /прервано ещё до начала/.test(r.error || ''), r.error)
  }
}

// ------------------------------------------------------------------- (е)

async function caseShort () {
  if (!await arena('(е) craft: короткое намерение не платит')) return
  // Восемь досок, не четыре: последние четыре craft бережёт под верстак и
  // откажет — а отказ крафта к этой сцене отношения не имеет.
  await give('iron_chestplate 1', 'oak_planks 8')
  const r: any = await step('craft stick 4', 'craft', { item: 'stick', count: 4 })
  check('в ответе craft поля gear нет', r.gear === undefined, JSON.stringify(r.gear))
  report('craft', `${r.status}${r.error ? ' ← ' + r.error : ''}`)
}

// ------------------------------------------------------------------- main

ws.on('open', async () => {
  let igrok = null
  try {
    await call('connect')
    await caseTunnelDress()
    await caseAllThere()
    await caseRecover()
    await caseRecoverDown()
    await caseInterrupt('damage')
    if (process.env.ND_PREFLIGHT_CHAT === '1') {
      const { joinAsPlayer } = require('./scene-player')
      igrok = await joinAsPlayer({ username: 'Igrok' })
      await caseInterrupt('chat', igrok)
    } else {
      console.log('\n(д) пропущен: ND_PREFLIGHT_CHAT=1 приводит второго игрока')
    }
    await caseShort()
    await call('stop')
    console.log(`\nитог: ${failures ? `[ПЛОХО] ${failures}` : 'всё зелёное'}`)
  } catch (e) {
    console.error('FAILED:', e.message)
    console.error(e.stack)
    failures++
  } finally {
    if (igrok) await igrok.leave().catch(() => {})
    if (failures) process.exitCode = 1
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })

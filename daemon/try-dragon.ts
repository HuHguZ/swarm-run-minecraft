'use strict'
const gameClock = require('./src/game-clock')
// Эндер-дракон (dragon.js, RPC dragon / mc_dragon) на своём сервере server-end
// (25568): мир — Энд с живым драконом, бот NeuroEnd — оператор.
//
// Ложь, которую ловит сцена. Бой с драконом — это десяток мест, где «сделал»
// сказать легко, не сделав: кристалл «сбит», а сервер его видит; удар «в
// голову», а урон как по телу (не голова — урон/4 + 1, EnderDragon.hurt);
// «пережил дыхание», потому что дракон так и не дохнул; «победил», потому что
// дракон просто улетел из прорисовки. Поэтому свидетель везде — СЕРВЕР, а не
// отчёт бота:
//   · кристаллы — сколько строк «[End Crystal] nd-…» дала команда
//     execute as @e[type=end_crystal] run say (каждый кристалл говорит сам);
//   · здоровье дракона — execute store … data get entity … Health в счёт и
//     поиск порога через execute if score … run say;
//   · победа — у сервера нет дракона и выходной портал горит (ачивка «Free
//     the End» не годится: её дают один раз, со второго дракона её нет);
//   · смерть бота — событие death (разность хп после возрождения врёт).
//
// Случаи (по умолчанию все по порядку; можно перечислить):
//   kit      пустой рюкзак → need {what,count,have} ДО входа и тело не сдвинулось;
//   arrive   с обсидиановой платформы (100,49,0) — мост и до центра острова;
//   crystals сбить кристаллы (сервер считает до и после; CRYSTALS=N — сколько
//            требовать, по умолчанию все);
//   perch    дракона сажают (DragonPhase 2 — заход на посадку), бот бьёт в голову
//            одну посадку: здоровье по серверу упало, удары засчитаны головой,
//            бот жив; если за посадку дракон дохнул огнём — жив и после этого;
//   full     бой до смерти дракона (вызовы по 600 с, пока не победит);
//   home     яйцо и домой через выходной портал: мир — overworld;
//   respawn  четыре кристалла на края выходного портала → новый дракон.
//
//   node try-dragon.js [случай ...]   (ND_WS — демон, по умолчанию 8773)
//   RESIST=1 — сопротивление V боту (только отладка ходьбы: сцена тогда
//   печатает, что замер нечестный, и вердикты по хп не выносит).
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8773'
const PLAYER = process.env.MC_USERNAME || 'NeuroEnd'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-end', 'logs', 'latest.log')
const RESIST = process.env.RESIST === '1'
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const CASES = process.argv.slice(2).length ? process.argv.slice(2) : ['kit', 'arrive', 'crystals', 'perch', 'full', 'home']

const KIT = [
  'bow', 'arrow 64', 'arrow 64', 'cobblestone 64', 'cobblestone 64', 'cobblestone 64',
  'diamond_sword', 'diamond_pickaxe', 'cooked_beef 32', 'golden_apple 4', 'torch 8', 'water_bucket',
  'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'
]

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const note = s => console.log(`   · ${s}`)
const header = async () => ((await call('status')) || {} as Record<string, any>).state || {} as Record<string, any>
const end = c => `/execute in minecraft:the_end run ${c.replace(/^\//, '')}`
// Смерть приходит двумя путями: событием в шине — и причиной прерывания
// (runIntent забирает прервавшее событие из events в by). Считать оба.
const deathAt = []
const deaths = (t0) => conn.heard.filter(e => e && e.type === 'death' && (e.gameAt ?? e.at ?? 0) >= t0).length + deathAt.filter(t => t >= t0).length

// ------------------------------------------------------------ свидетели

let seq = 0
// Сколько сущностей типа есть у сервера: каждая сама говорит строку. @e
// видит только прогруженные чанки: сразу после телепорта в Энд кристаллы на
// обелисках ещё не подгружены — ноль переспрашивается, пока тело там стоит.
async function serverCount (type, { settle = 4 }: any = {} as Record<string, any>) {
  for (let i = 0; i < settle; i++) {
    const n = await serverCountOnce(type)
    if (n > 0) return n
    await sleep(2500)
  }
  return 0
}
async function serverCountOnce (type) {
  const tag = `nd-${type.replace(/_/g, '')}-${++seq}`
  const from = kit.serverLog.mark()
  await kit.cmd(end(`execute as @e[type=minecraft:${type}] run say ${tag}`))
  await sleep(800)
  const { lines } = kit.serverLog.linesFrom(from)
  return lines.filter(l => l.text.includes(`] ${tag}`) && !l.text.includes('issued server command')).length
}

// Здоровье дракона по серверу: в счёт, потом порог через say. null — дракона нет.
async function dragonHp () {
  await kit.cmd('/scoreboard objectives add nd_hp dummy')
  await kit.cmd('/scoreboard players set nd_dragon nd_hp -1')
  await kit.cmd(end('execute store result score nd_dragon nd_hp run data get entity @e[type=minecraft:ender_dragon,limit=1] Health 1'))
  const said = async (min) => {
    const tag = `nd-hp-${++seq}`
    const from = kit.serverLog.mark()
    await kit.cmd(`/execute if score nd_dragon nd_hp matches ${min}.. run say ${tag}`)
    await sleep(500)
    return kit.serverLog.linesFrom(from).lines.some(l => l.text.includes(`] ${tag}`) && !l.text.includes('issued server command'))
  }
  if (!(await said(0))) return null
  let lo = 0; let hi = 200
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (await said(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

async function dragonPhase (n) {
  return kit.cmd(end(`data merge entity @e[type=minecraft:ender_dragon,limit=1] {DragonPhase:${n}}`))
}

async function giveKit () {
  await kit.cmd('/clear @s')
  for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  if (RESIST) await kit.cmd('/effect give @s minecraft:resistance 1200 4 true')
  await kit.cmd('/effect give @s minecraft:saturation 5 10 true')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
}

async function dragonCall (params) {
  const r = await call('dragon', params)
  const d = (r && r.detail) || {} as Record<string, any>
  if (r && r.by && r.by.type === 'death') deathAt.push(r.by.gameAt ?? r.by.at ?? gameClock.now())
  console.log(`   ${r.status}${r.partial ? ' (partial)' : ''}${r.error ? ' — ' + r.error : ''}${d.stopped ? ` · stopped: ${d.stopped}` : ''}`)
  return { r, d }
}

// ------------------------------------------------------------ случаи

async function caseKit () {
  console.log('\n(kit) пустой рюкзак: отказ числом до входа')
  await kit.cmd('/clear @s')
  // /tp с высоты убивает (грабли прогонов): медленное падение ДО телепорта.
  await kit.cmd('/effect give @s minecraft:slow_falling 15 0 true')
  await kit.ensureWorld('the_end', { tp: '0.5 70 -30.5' })
  await inEnd()
  const before = (await header()).pos
  const { d } = await dragonCall({ mode: 'full', timeoutSeconds: 30 })
  const after = (await header()).pos
  check('need назван: что, сколько, сколько есть', !!(d.need && d.need.what && d.need.count && d.need.have !== undefined), d.need)
  check('тело не сдвинулось', before && after && Math.hypot(before.x - after.x, before.z - after.z) < 1, { before, after })
  await giveKit()
  const { d: d2 } = await dragonCall({ mode: 'look' })
  check('с набором — снаряжения хватает', !!d2.kit && d2.kit.bow === 1 && d2.kit.arrows >= 64, d2.kit)
}

async function caseArrive () {
  console.log('\n(arrive) с обсидиановой платформы до центра острова')
  await giveKit()
  await kit.cmd(end('tp @s 100.5 49 0.5'))
  await sleep(3000)
  const t0 = gameClock.now()
  const { d } = await dragonCall({ mode: 'arrive', timeoutSeconds: 300 })
  const st = await header()
  const pos = st.pos || {} as Record<string, any>
  const fromCenter = Math.hypot(pos.x - 0.5, pos.z - 0.5)
  check('не умер', deaths(t0) === 0, deaths(t0))
  // Мост мог остаться от прошлого прогона — тогда тело идёт по нему, не ставя
  // блоков. Проверяется, что с платформы ушло по мосту, а не число блоков.
  check('с платформы ушёл по мосту (свой или прошлый)', !!(d.bridge && (d.bridge.placed > 0 || d.bridge.steps > 0)), d.bridge)
  if (d.approach) note(`подход к центру: ${JSON.stringify(d.approach)}`)
  check('стоит у центра острова (≤ 25 блоков)', fromCenter <= 25 && st.dimension === 'the_end', { pos, fromCenter: Math.round(fromCenter) })
}

// Заголовок уже говорит «the_end», а тело ещё нет: первый вход в свежий Энд
// генерирует остров, и мир бота переключается позже ответа сервера. Ждать,
// пока сам модуль согласится, что он в Энде.
async function inEnd (ms = 30000) {
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < ms) {
    const r = await call('dragon', { mode: 'look' })
    if (r && r.status === 'done') return true
    await sleep(1500)
  }
  return false
}

// Перед случаем: в Энде, полное здоровье, набор на месте. Смерть в прошлом
// случае не должна проваливать следующий — у каждого свой замер.
async function ready () {
  // Пока сцена раздаёт набор (полсотни команд — секунд десять), дракон бьёт
  // праздно стоящее тело фаерболами: прошлый прогон начал случай с 6 хп и умер
  // на первом облаке. На время подготовки — сопротивление, снимается перед
  // самим вызовом (fair()).
  await kit.cmd('/effect give @s minecraft:resistance 60 4 true')
  const st = await header()
  // Набор — каждый случай заново (стрелы, блоки, яблоки тратятся), а в Энд —
  // только если тело не там (умерло в прошлом случае).
  await giveKit()
  if (st.dimension !== 'the_end') {
    note('тело не в Энде (умерло?) — в Энд к центру')
    await kit.cmd('/effect give @s minecraft:slow_falling 15 0 true')
    await kit.ensureWorld('the_end', { tp: '0.5 70 -20.5' })
    await inEnd()
  }
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 5 10 true')
}
// Честный замер: сопротивление подготовки снять, здоровье полное.
async function fair () {
  if (!RESIST) await kit.cmd('/effect clear @s minecraft:resistance')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
}

async function caseCrystals () {
  console.log('\n(crystals) сбить кристаллы на обелисках')
  await ready()
  const before = await serverCount('end_crystal')
  note(`сервер видит кристаллов: ${before}`)
  if (!before) { note('кристаллов нет — случай нечего проверять'); return }
  const need = Number(process.env.CRYSTALS || before)
  await fair()
  const t0 = gameClock.now()
  let last = null
  for (let i = 0; i < 3; i++) {
    last = await dragonCall({ mode: 'crystals', timeoutSeconds: 600 })
    if (deaths(t0) || (await serverCount('end_crystal')) === 0) break
  }
  const after = await serverCount('end_crystal')
  const d = last.d
  console.log(`   отчёт: сбито ${d.crystals && d.crystals.destroyed}, стрел ${d.crystals && d.crystals.arrows}, клетки ${JSON.stringify((d.cages || []).map(c => ({ at: c.at, broke: c.broke, down: c.down })))}, хп ${d.hp}, уклонов ${JSON.stringify(d.dodged)}`)
  if (d.crystals && d.crystals.notes) note(`заметки: ${d.crystals.notes.join(' | ')}`)
  check('не умер', deaths(t0) === 0, deaths(t0))
  check(`сервер: сбито ${before - after} из ${before} (нужно ${need})`, before - after >= need, { before, after })
  check('отчёт не врёт числом оставшихся', d.crystals && d.crystals.left === after, { report: d.crystals && d.crystals.left, server: after })
}

async function casePerch () {
  console.log('\n(perch) сидящему — в голову')
  await ready()
  const crystals = await serverCount('end_crystal')
  if (crystals) {
    note(`кристаллов ${crystals}: для проверки посадки убираю их командой (сбивать — случай crystals)`)
    await kit.cmd(end('kill @e[type=minecraft:end_crystal]'))
  }
  const hp0 = await dragonHp()
  if (hp0 == null) { note('дракона нет — случай нечего проверять'); return }
  await dragonPhase(2)
  await fair()
  const t0 = gameClock.now()
  const botHp0 = (await header()).health
  const { d } = await dragonCall({ mode: 'dragon', perches: 1, timeoutSeconds: 180 })
  const hp1 = await dragonHp()
  const per = ((d.dragon && d.dragon.melee && d.dragon.melee.byPerch) || [])
  const p = per[per.length - 1] || {} as Record<string, any>
  console.log(`   посадка: ${JSON.stringify(p)}; фазы: ${(d.dragon && d.dragon.phases || []).join(' → ')}`)
  check('не умер', deaths(t0) === 0, deaths(t0))
  check('сервер: здоровье дракона упало', hp0 != null && hp1 != null && hp1 < hp0, { было: hp0, стало: hp1 })
  check('удары засчитаны головой (урон ≥ 4 за удар)', p.head > 0, { head: p.head, body: p.body, hits: p.hits })
  const flamed = (d.dragon && d.dragon.phases || []).some(s => /огнём/.test(s))
  if (flamed && !RESIST) check('пережил сидячий огонь', deaths(t0) === 0, { хп: `${botHp0} -> ${(await header()).health}` })
  else note(flamed ? 'огонь был, но RESIST=1 — вердикт по хп не выношу' : 'дракон за эту посадку не дохнул — огонь не проверен')
}

async function caseFull () {
  console.log('\n(full) бой до смерти дракона')
  await ready()
  const hp0 = await dragonHp()
  if (hp0 == null) { note('дракона нет'); return }
  await fair()
  const t0 = gameClock.now()
  const from = kit.serverLog.mark()
  let won = false
  let last = null
  for (let i = 0; i < 4 && !won; i++) {
    last = await dragonCall({ mode: 'full', timeoutSeconds: 600, home: false, egg: false })
    won = !!(last.d.dragon && last.d.dragon.won)
    if (deaths(t0)) break
  }
  // Ачивка «Free the End» даётся игроку один раз за жизнь мира — со второго
  // дракона её нет. Поэтому свидетель — сервер не видит дракона (тело стоит в
  // центре, чанки прогружены) и выходной портал горит (его видит модуль).
  const adv = kit.serverLog.linesFrom(from).lines.some(l => /Free the End/.test(l.text))
  await sleep(12000) // анимация смерти — 200 тиков
  const dragonsLeft = await serverCountOnce('ender_dragon')
  const look = await call('dragon', { mode: 'look' })
  const portal = !!(look && look.detail && look.detail.portal)
  const killed = dragonsLeft === 0 && portal
  const d = last.d
  const secs = Math.round((gameClock.now() - t0) / 1000)
  console.log(`   за ${secs} с, хп бота ${d.hp}; ближний: ${JSON.stringify(d.dragon && d.dragon.melee)}; стрелы: ${JSON.stringify(d.dragon && d.dragon.arrows)}; уклоны ${JSON.stringify(d.dodged)}; эндермены ${JSON.stringify(d.endermen)}`)
  check('не умер', deaths(t0) === 0, deaths(t0))
  check('сервер: дракона нет и выходной портал горит', killed, { драконов: dragonsLeft, портал: portal, ачивка: adv })
  check('отчёт говорит то же', won === killed, won)
}

async function caseHome () {
  console.log('\n(home) яйцо и домой')
  const { d } = await dragonCall({ mode: 'home', timeoutSeconds: 180 })
  const st = await header()
  console.log(`   яйцо: ${JSON.stringify(d.egg)}; портал: ${JSON.stringify(d.home)}`)
  check('дома: мир overworld', st.dimension === 'overworld', st.dimension)
  note(`яйцо в рюкзаке: ${(st.inventory || {} as Record<string, any>).dragon_egg || 0}`)
}

// Кровати у сидящего: те же условия, что perch, но в рюкзаке 4 кровати.
// Свидетели: здоровье дракона по серверу упало, взрывов ≥ 1 (кровати из
// рюкзака ушли), бот жив, и сколько хп он потерял на своих взрывах.
async function caseBed () {
  console.log('\n(bed) сидящему — кровать у головы, из-за заслона')
  await ready()
  await kit.cmd('/give @s minecraft:red_bed 4')
  const crystals = await serverCount('end_crystal')
  if (crystals) await kit.cmd(end('kill @e[type=minecraft:end_crystal]'))
  const hp0 = await dragonHp()
  if (hp0 == null) { note('дракона нет — случай нечего проверять'); return }
  await dragonPhase(2)
  await fair()
  const t0 = gameClock.now()
  const clock0 = (await header()).clock
  const wall0 = gameClock.wall.monotonic()
  const { r: response, d } = await dragonCall({ mode: 'dragon', perches: 1, timeoutSeconds: 180 })
  const wallSecs = +((gameClock.wall.monotonic() - wall0) / 1000).toFixed(3)
  const clock1 = response.state?.clock
  const timing = { rate: clock0?.tickRate ?? null, gameTicks: clock0 && clock1 ? clock1.ticks - clock0.ticks : null,
    serverTicks: clock0?.serverTicks != null && clock1?.serverTicks != null ? clock1.serverTicks - clock0.serverTicks : null,
    wallSecs, lagTicks: clock1?.lagTicks ?? null }
  const beds = (d.dragon && d.dragon.beds) || {} as Record<string, any>
  let hp1 = null; let hpError = null
  try { hp1 = await dragonHp() } catch (error) { hpError = error.message; throw error }
  finally {
    if (process.env.LAB_OUT) require('fs').appendFileSync(process.env.LAB_OUT, JSON.stringify({ case: 'bed', ...timing,
      hp0, hp1, hpError, beds, died: deaths(t0) > 0 || !!d.died, status: response.status, code: response.code, error: response.error, by: response.by }) + '\n')
  }
  console.log(`   кровати: ${JSON.stringify(beds)}; хп бота ${d.hp}; фазы: ${(d.dragon && d.dragon.phases || []).join(' → ')}`)
  console.log(`   часы: ${JSON.stringify(timing)}`)
  check('не умер', deaths(t0) === 0, deaths(t0))
  check('взорвал хоть одну кровать', (beds.used || 0) > 0, beds.used)
  check('сервер: здоровье дракона упало', hp0 != null && hp1 != null && hp1 < hp0, { было: hp0, стало: hp1 })
}

// Клетки (2026-09-26): свежий дракон (обелиски и клетки заново), дракон
// заморожен (NoAI — ни фаерболов, ни посадок: проверяется сама механика
// столба, прута, выстрела в дыру и спуска), бот у центра с набором, mode
// crystals. Свидетели: сервер — кристаллов 0; отчёт — cages со временем.
async function caseCage () {
  console.log('\n(cage) клетки: столб, один прут, выстрел в дыру, спуск')
  // CAGE_KEEP=1 — без воскрешения: добить то, что осталось (быстрая проверка клеток).
  if (process.env.CAGE_KEEP !== '1' && !(await freshDragon())) { note('дракона нет и не воскрес'); return }
  await kit.cmd(end('data merge entity @e[type=minecraft:ender_dragon,limit=1] {NoAI:1b}'))
  await ready()
  await kit.cmd(end('tp @s 0.5 70 -12.5'))
  await sleep(4000)
  const before = await serverCount('end_crystal')
  note(`сервер видит кристаллов: ${before}`)
  await fair()
  const t0 = gameClock.now()
  const { d } = await dragonCall({ mode: 'crystals', timeoutSeconds: 600 })
  const after = await serverCount('end_crystal', { settle: 1 })
  console.log(`   клетки: ${JSON.stringify(d.cages)}; падения ${JSON.stringify(d.clutch)}; хп ${d.hp}; за ${Math.round((gameClock.now() - t0) / 1000)} с`)
  if (d.crystals && d.crystals.notes) note(`заметки: ${d.crystals.notes.join(' | ')}`)
  check('не умер', deaths(t0) === 0, deaths(t0))
  check(`сервер: кристаллов не осталось (было ${before})`, after === 0, after)
  await kit.cmd(end('data merge entity @e[type=minecraft:ender_dragon,limit=1] {NoAI:0b}'))
}

// Станция кроватей (2026-09-26): кристаллы убраны командой, дракона сажают
// (DragonPhase 2 — заход на посадку), бот сам строит станцию и жмёт кровати
// на посадке, сидя и на взлёте. Свидетели: здоровье по серверу до и после,
// отчёт — какие кровати в какой фазе сколько сняли; бот жив.
async function caseStation () {
  const P = Number(process.env.PERCHES || 1)
  console.log(`\n(station) станция кроватей: посадок ${P}`)
  await ready()
  await kit.cmd(`/give @s minecraft:red_bed ${Number(process.env.E2E_BEDS || 8)}`)
  const crystals = await serverCount('end_crystal')
  if (crystals) await kit.cmd(end('kill @e[type=minecraft:end_crystal]'))
  // STATION_FRESH=1 — новый дракон (/summon): у дракона память «видел ли
  // игрока» не чистится никогда (EnderDragon.aiStep без serverAiStep → Sensing
  // без tick), и старый дракон прошлых сцен мог «не видеть» бота навсегда.
  if (process.env.STATION_FRESH === '1') {
    await kit.cmd(end('kill @e[type=minecraft:ender_dragon]'))
    await sleep(2000)
    await kit.cmd(end('summon minecraft:ender_dragon 0 100 -40 {DragonPhase:0}'))
    await sleep(3000)
  }
  const hp0 = await dragonHp()
  if (hp0 == null) { note('дракона нет — случай нечего проверять'); return }
  await dragonPhase(2)
  await fair()
  const t0 = gameClock.now()
  const { d } = await dragonCall({ mode: 'dragon', perches: P, timeoutSeconds: 300 })
  const hp1 = await dragonHp()
  const beds = (d.dragon && d.dragon.beds) || {} as Record<string, any>
  console.log(`   кровати: ${JSON.stringify(beds)}; станция ${JSON.stringify(d.dragon && d.dragon.station)}; хп бота ${d.hp}; фазы: ${(d.dragon && d.dragon.phases || []).join(' → ')}`)
  check('не умер', deaths(t0) === 0, deaths(t0))
  check('взорвал хоть одну кровать', (beds.used || 0) > 0, beds.used)
  check('сервер: здоровье дракона упало', hp0 != null && (hp1 == null || hp1 < hp0), { было: hp0, стало: hp1 })
}

// Падение: тело подбрасывают на 30 блоков над землёй посреди работы — ведро
// воды под ноги (fallGuard). Свидетель — хп по заголовку до и после и смерть.
async function caseClutch () {
  console.log('\n(clutch) падение с 30 блоков: ведро воды под ноги')
  await ready()
  // На землю в 35 блоках от центра — медленным падением (с 70 до земли ~57
  // это 13 блоков: прошлый прогон начал случай с 12 хп из 20).
  await kit.cmd('/effect give @s minecraft:slow_falling 8 0 true')
  await kit.cmd(end('tp @s 25.5 70 25.5'))
  await sleep(6000)
  await kit.cmd('/effect clear @s minecraft:slow_falling')
  await fair()
  await sleep(500)
  const st0 = await header()
  const t0 = gameClock.now()
  const pr = call('dragon', { mode: 'arrive', timeoutSeconds: 60 })
  await sleep(1500)
  const gy = Math.floor(st0.pos.y)
  // CLUTCH_EDGE=1 (2026-09-30): соседняя колонка на блок выше, тело — краем
  // хитбокса над ней (как спуск со столба у клетки, сцена cage-1): вода под
  // центром, а встаёт тело на соседний блок — если не выровняться в воздухе.
  let tx = st0.pos.x
  if (process.env.CLUTCH_EDGE === '1') {
    const cx = Math.floor(st0.pos.x); const cz = Math.floor(st0.pos.z)
    await kit.cmd(end(`setblock ${cx + 1} ${gy} ${cz} minecraft:end_stone`))
    tx = cx + 0.85
  }
  await kit.cmd(end(`tp @s ${tx.toFixed(2)} ${gy + 30} ${st0.pos.z.toFixed(1)}`))
  await sleep(6000)
  const st1 = await header()
  const r = await pr
  if (r && r.by && r.by.type === 'death') deathAt.push(r.by.gameAt ?? r.by.at ?? gameClock.now())
  const d = (r && r.detail) || {} as Record<string, any>
  console.log(`   ведро: ${JSON.stringify(d.clutch)}; хп ${st0.health} -> ${st1.health}; вода в рюкзаке: ${JSON.stringify((st1.inventory || {} as Record<string, any>).water_bucket)}`)
  check('не умер', deaths(t0) === 0, deaths(t0))
  check('ведро вылито в падении', !!(d.clutch && d.clutch.water), d.clutch)
  check('упал без урона (хп не меньше, чем было, − 1)', st1.health >= st0.health - 1, { было: st0.health, стало: st1.health })
}

// Честный сквозной прогон (E2E=N попыток, по умолчанию 3): каждый раз свежий
// дракон (воскрешён четырьмя кристаллами — обелиски, кристаллы и клетки
// заново), тело — на обсидиановой платформе (100,48,0), как из портала
// крепости, с «разумным» набором: железная броня, железный меч и кирка, лук,
// 64 стрелы, 128 булыжника, 20 стейков, 4 золотых яблока, ведро воды, факелы
// (E2E_BEDS=4 — ещё кровати). Дальше тело само: мост, кристаллы, дракон,
// выходной портал (home). Свидетели — сервер: дракона нет (центр острова
// удержан forceload, иначе @e не видит ушедшего из прорисовки) и выходной
// портал горит; тело в overworld; смертей 0.
// Набор (2026-09-26): E2E_KIT=iron (по умолчанию) | diamond — броня и меч;
// E2E_BEDS — кроватей; E2E_GAPPLES — золотых яблок (4); E2E_POTIONS — питьевые
// зелья через запятую, «имя:число» (healing:2,slow_falling:1,fire_resistance:1);
// E2E_OUT — файл jsonl, куда ложится итог каждой попытки (таблица прогонов).
// E2E_MODE — режим боя (full — с кристаллами); без него — режим RPC по умолчанию,
// с 30.09.2026 «только кровати» (beds). Итог: кроватей и посадок за все вызовы,
// урон по посадкам, кристаллы по серверу до и после (кольцо обелисков — forceload).
function e2eKit () {
  // campaign — что реально приносит кампания (2026-09-27): железо, железный меч,
  // щит, кирка, лук и 64 стрелы, 64 булыжника, еда, 1–2 золотых яблока, ведро
  // воды, кровати (E2E_BEDS). Без факелов и зелий.
  // campaign2 — набор, переданный координатором для campaign.js (30.09): +64 булыжника,
  // «Защита» на броне (здесь II), второе ведро воды, золотые яблоки (E2E_GAPPLES, по
  // умолчанию 2). Проверка, что даст основному миру обновлённый набор.
  if (process.env.E2E_KIT === 'campaign2') {
    const prot = n => `${n}[enchantments={protection:2}]`
    const out = [prot('iron_helmet'), prot('iron_chestplate'), prot('iron_leggings'), prot('iron_boots'), 'iron_sword', 'shield', 'iron_pickaxe',
      'bow', 'arrow 64', 'cobblestone 64', 'cobblestone 64', 'cooked_beef 16', 'water_bucket', 'water_bucket']
    const gapples = Number(process.env.E2E_GAPPLES ?? 2)
    if (gapples) out.push(`golden_apple ${gapples}`)
    // Якоря возрождения (просьба пользователя, 01.10: доп. взрывы, как у спидраннеров) и светокамень
    // на зарядку: E2E_ANCHORS — якорей, E2E_GLOW — светокамня (по умолчанию 2 на якорь).
    const anchors = Number(process.env.E2E_ANCHORS || 0)
    if (anchors) out.push(`respawn_anchor ${anchors}`)
    const glow = Number(process.env.E2E_GLOW ?? anchors * 2)
    if (glow) out.push(`glowstone ${glow}`)
    // Обсидиан для станции у столба (опора и укрытие, взрыв не сносит): E2E_OBSIDIAN, E2E_CRYING — штук.
    const obs = Number(process.env.E2E_OBSIDIAN || 0)
    if (obs) out.push(`obsidian ${obs}`)
    const cry = Number(process.env.E2E_CRYING || 0)
    if (cry) out.push(`crying_obsidian ${cry}`)
    // Эндер-жемчуг (01.10, A/B подхода жемчугом): сколько остаётся после очей — E2E_PEARLS штук.
    const pearls = Number(process.env.E2E_PEARLS || 0)
    if (pearls) out.push(`ender_pearl ${pearls}`)
    return out
  }
  if (process.env.E2E_KIT === 'campaign') {
    const out = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword', 'shield', 'iron_pickaxe',
      'bow', 'arrow 64', 'cobblestone 64', 'cooked_beef 16', 'water_bucket']
    const gapples = Number(process.env.E2E_GAPPLES ?? 2)
    if (gapples) out.push(`golden_apple ${gapples}`)
    return out
  }
  const tier = process.env.E2E_KIT === 'diamond' ? 'diamond' : 'iron'
  const out = [`${tier}_helmet`, `${tier}_chestplate`, `${tier}_leggings`, `${tier}_boots`, `${tier}_sword`, 'iron_pickaxe',
    'bow', 'arrow 64', 'cobblestone 64', 'cobblestone 64', 'cobblestone 64', 'cooked_beef 20', 'water_bucket', 'torch 8']
  const gapples = Number(process.env.E2E_GAPPLES ?? 4)
  if (gapples) out.push(`golden_apple ${gapples}`)
  const obs = Number(process.env.E2E_OBSIDIAN || 0)
  if (obs) out.push(`obsidian ${obs}`)
  const cry = Number(process.env.E2E_CRYING || 0)
  if (cry) out.push(`crying_obsidian ${cry}`)
  for (const s of String(process.env.E2E_POTIONS || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const [name, n] = s.split(':')
    out.push(`potion[potion_contents={potion:"minecraft:${name}"}] ${Number(n || 1)}`)
  }
  return out
}
// Причина смерти — по трассе боя (ND_DRAGON_TRACE у демона): последние удары
// перед событием death — тип урона, чем было занято тело, где стояло, фаза.
function deathCause (file) {
  try {
    const lines = require('fs').readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    const death = lines.find(l => l.k === 'death')
    if (!death) return null
    const hurts = lines.filter(l => l.k === 'hurt' && l.t <= death.t && l.t >= death.t - 8000)
    const last = [...lines].reverse().find(l => l.k === 's' && l.t <= death.t) || {} as Record<string, any>
    const types: Record<string, any> = {} as Record<string, any>
    for (const h of hurts) types[h.type] = (types[h.type] || 0) + 1
    return { t: Math.round(death.t / 1000), doing: death.doing, types, lastHurt: hurts.length ? hurts[hurts.length - 1] : null, at: last.p, dragon: last.d ? { ph: last.d.ph, hp: last.d.hp } : null, clouds: last.cl }
  } catch (e) { return { error: e.message } }
}
// Остров между попытками (2026-09-26): каждый прогон оставляет у фонтана
// воронки от кроватей, огонь, свои стенки и столбы у клеток, а на мосту от
// платформы — свой булыжник. Следующая попытка шла бы по чужим постройкам, а
// воскрешение не доходило до четвёртой стороны портала через воронки («не
// дошёл за 20с», repro2). Поэтому перед воскрешением: булыжник, огонь и кровати
// — в воздух (у центра, у каждого обелиска, на полосе моста), воронки у
// фонтана до уровня y 60 — эндерняком. Обелиски, кристаллы и клетки встанут
// заново сами при воскрешении (SpikeFeature). /fill — не больше 32768 блоков.
const SPIKES = Array.from({ length: 10 }, (_, i) => ({
  x: Math.floor(42 * Math.cos(2 * (-Math.PI + 0.3141592653589793 * i))),
  z: Math.floor(42 * Math.sin(2 * (-Math.PI + 0.3141592653589793 * i)))
}))
async function cleanArena () {
  const boxes = [[-20, 20, -20, -1], [-20, 20, 0, 20]]
  for (const [x1, x2, z1, z2] of boxes) {
    for (const b of ['cobblestone', 'fire', 'red_bed', 'water']) await kit.cmd(end(`fill ${x1} 55 ${z1} ${x2} 90 ${z2} minecraft:air replace minecraft:${b}`))
    await kit.cmd(end(`fill ${x1} 50 ${z1} ${x2} 60 ${z2} minecraft:end_stone replace minecraft:air`))
  }
  for (const s of SPIKES) {
    for (const b of ['cobblestone', 'water']) await kit.cmd(end(`fill ${s.x - 5} 45 ${s.z - 5} ${s.x + 5} 110 ${s.z + 5} minecraft:air replace minecraft:${b}`))
  }
  await kit.cmd(end('fill 40 44 -4 104 52 4 minecraft:air replace minecraft:cobblestone'))
}
async function freshDragon () {
  await kit.cmd('/effect give @s minecraft:resistance 90 4 true')
  const h = await header()
  if (h.dimension !== 'the_end') {
    await kit.cmd('/effect give @s minecraft:slow_falling 15 0 true')
    await kit.ensureWorld('the_end', { tp: '0.5 70 -20.5' })
    await inEnd()
  } else {
    await kit.cmd('/effect give @s minecraft:slow_falling 10 0 true')
    await kit.cmd(end('tp @s 0.5 70 -20.5'))
    await sleep(4000)
  }
  // Живой дракон от прошлых случаев — подбитый и без кристаллов: не свежий.
  // Убить командой (смерть идёт своим чередом: 200 тиков, потом портал) и
  // воскресить — обелиски, кристаллы и клетки встанут заново.
  // Нетронутый Энд (мир слота пересоздан без world_the_end): дракон жив и все 10
  // кристаллов на обелисках — это и есть свежий бой, воскрешать не надо
  // (dragon-e2e-3: «воскресить не вышло: выходного портала не видно»).
  if (await serverCount('ender_dragon', { settle: 2 }) && (await serverCount('end_crystal')) >= 10) {
    await kit.cmd('/clear @s')
    return true
  }
  if (await serverCount('ender_dragon', { settle: 2 })) {
    await kit.cmd(end('kill @e[type=minecraft:ender_dragon]'))
    await sleep(15000)
  }
  await kit.cmd('/clear @s')
  await cleanArena()
  // Мусор прошлых боёв над краями портала (шары опыта, стрелы, предметы):
  // кристалл не ставится, если в его коробке 1×2×1 есть хоть одна сущность
  // (EndCrystalItem.useOn) — «ответа от сервера нет» раз за разом на одной стороне.
  for (const t of ['experience_orb', 'item', 'arrow']) await kit.cmd(end(`kill @e[type=minecraft:${t},x=0,y=62,z=0,distance=..8]`))
  await kit.cmd('/give @s minecraft:end_crystal 4')
  await kit.cmd('/give @s minecraft:cobblestone 32')
  const { d } = await dragonCall({ mode: 'respawn', timeoutSeconds: 120 })
  if (!d.respawn || !d.respawn.started) { note(`воскресить не вышло: ${JSON.stringify(d.respawn)}`); return false }
  for (let i = 0; i < 18; i++) { await sleep(5000); if (await serverCount('ender_dragon', { settle: 1 })) return true }
  return false
}
// Блок в Энде такой-то (по ответу сервера в его логе: say из execute if block).
async function blockIs (x, y, z, name) {
  const tag = `nd-block-${++seq}`
  const from = kit.serverLog.mark()
  await kit.cmd(`/execute in minecraft:the_end if block ${x} ${y} ${z} minecraft:${name} run say ${tag}`)
  await sleep(300)
  return kit.serverLog.linesFrom(from).lines.some(l => l.text.includes(`] ${tag}`) && !l.text.includes('issued server command'))
}
async function caseE2E () {
  const N = Number(process.env.E2E || 3)
  const beds = Number(process.env.E2E_BEDS || 0)
  const E2E_KIT = e2eKit()
  const kitName = `${process.env.E2E_KIT === 'campaign2' ? 'кампания+' : process.env.E2E_KIT === 'campaign' ? 'кампания' : process.env.E2E_KIT === 'diamond' ? 'алмаз' : 'железо'}, кроватей ${beds}${process.env.E2E_POTIONS ? `, зелья ${process.env.E2E_POTIONS}` : ''}`
  const params = process.env.E2E_PARAMS ? JSON.parse(process.env.E2E_PARAMS) : {} as Record<string, any>
  console.log(`\n(e2e) с платформы до выходного портала, попыток ${N}; набор: ${kitName}${Object.keys(params).length ? `; параметры ${JSON.stringify(params)}` : ''}`)
  // Боевой режим (правило пользователя 02.10): keep_inventory=false во всех трёх мирах — смерть = провал прогона.
  await kit.gamerule('keep_inventory', process.env.E2E_KEEPINV === '1' ? 'true' : 'false')
  await kit.cmd(end('forceload add -16 -16 15 15'))
  // Обелиски (42 от центра) — тоже: сервер считает кристаллы до и после боя.
  await kit.cmd(end('forceload add -48 -48 47 47'))
  const results = []
  // 750 TPS (s5, 06.10): подготовка сцены (~25 команд по 20–50 мс реального времени) — это 30–40 игровых с, дракон
  // успевал сбить тело с платформы до вызова боя (s5-b1-s1/s2: пустота до первого шага). Подготовка — на 20 тиках,
  // бой — на целевом темпе (TICK_RATE от фермы).
  const rate = Number(process.env.TICK_RATE || 20)
  const setRate = async (n) => {
    if (rate === 20) return
    await kit.cmd(`/tick rate ${n}`)
    for (let i = 0; i < 40 && (await header()).clock?.tickRate !== n; i++) await gameClock.wall.sleep(50)
  }
  for (let a = 1; a <= N; a++) {
    await setRate(20)
    if (!(await freshDragon())) { note(`попытка ${a}: дракона нет и не воскрес`); results.push({ a, won: false, why: 'нет дракона' }); continue }
    // Кристаллы на обелисках (кольцо 42 держит forceload) — до боя.
    const crystals0 = await serverCount('end_crystal', { settle: 2 })
    // Опыт (01.10): верхняя граница «кристаллы не лечат» — убрать их командой до боя (только ферма).
    if (process.env.E2E_NOCRYSTALS === '1') await kit.cmd(end('kill @e[type=minecraft:end_crystal]'))
    // Платформа — как её строит игра (ServerPlayer.createEndPlatform): 5x5
    // обсидиана на y=48 и воздух на три блока над ней. Сначала тело туда,
    // потом /fill (в непрогруженном чанке fill молчит).
    await kit.cmd('/effect give @s minecraft:slow_falling 10 0 true')
    await kit.cmd(end('tp @s 100.5 60 0.5'))
    await sleep(3000)
    // /fill молчит, пока чанк не прогружен, а под нагрузкой фермы 3 с бывает
    // мало (ab-26, 30.09: платформы не было — тело упало в пустоту на 6-й с).
    // Ставить, пока угловые блоки не окажутся обсидианом.
    let platform = false
    for (let k = 0; k < 10 && !platform; k++) {
      if (k) { await kit.cmd(end('tp @s 100.5 60 0.5')); await sleep(2000) }
      await kit.cmd(end('fill 98 48 -2 102 48 2 minecraft:obsidian'))
      await kit.cmd(end('fill 98 49 -2 102 51 2 minecraft:air'))
      platform = await blockIs(98, 48, -2, 'obsidian') && await blockIs(102, 48, 2, 'obsidian')
    }
    if (!platform) { note(`попытка ${a}: платформа не встала`); results.push({ a, won: false, why: 'платформа не встала' }); continue }
    await kit.cmd(end('tp @s 100.5 49 0.5'))
    // Эндермены у платформы, пока сцена выдаёт набор (тело без брони и без
    // намерения): сбросили в пустоту до начала боя (v13-23-2, 30.09: вызов начался
    // на y −58 в 5 блоках от края). Убрать их командой — это подготовка сцены.
    await kit.cmd(end('kill @e[type=minecraft:enderman,x=100,y=49,z=0,distance=..24]'))
    await kit.cmd('/clear @s')
    for (const g of E2E_KIT) await kit.cmd(`/give @s minecraft:${g}`)
    if (beds) await kit.cmd(`/give @s minecraft:red_bed ${beds}`)
    await sleep(2500)
    await kit.cmd(end('kill @e[type=minecraft:enderman,x=100,y=49,z=0,distance=..24]'))
    await kit.cmd(end('tp @s 100.5 49 0.5'))
    await kit.cmd('/effect clear @s')
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
    await sleep(1000)
    await setRate(rate)
    const clock0 = (await header()).clock
    const t0 = gameClock.now()
    const wall0 = gameClock.wall.monotonic()
    let last = null; let won = false
    let killSecs = null; let crystalSecs = null
    // Подход (01.10): прибыл к центру (< 30), станция у столба построена, жемчуг на подходе.
    let centerSecs = null; let stationSecs = null; let pearl = null
    let callsMade = 0
    const traces = []
    // Счёт по всем вызовам (2026-09-30, «только кровати»): кровати, посадки с
    // кроватями, урон по посадкам; кристаллы — сколько видит сервер до и после.
    let bedsUsed = 0; let perchCount = 0
    const bedPerches = []
    // Срок на бой (2026-09-30): E2E_MIN минут (по умолчанию 30) вызовами по ≤ 600 с. Трёх вызовов
    // по 600 с бывало мало: d12-27 оборвался при драконе 2 хп.
    const budgetMs = Number(process.env.E2E_MIN || 30) * 60000
    for (let i = 0; !won && gameClock.now() - t0 < budgetMs - 30000; i++) {
      const tc = gameClock.now()
      const left = Math.round((budgetMs - (tc - t0)) / 1000)
      // E2E_MODE — режим боя; без него — режим по умолчанию (как зовёт кампания).
      const modeP = process.env.E2E_MODE ? { mode: process.env.E2E_MODE } : {} as Record<string, any>
      last = await dragonCall({ ...modeP, timeoutSeconds: Math.max(60, Math.min(600, left)), ...params })
      callsMade++
      won = !!(last.d.dragon && last.d.dragon.won)
      {
        const dg = last.d.dragon || {} as Record<string, any>
        bedsUsed += (dg.beds && dg.beds.used) || 0
        perchCount += dg.perchCount || 0
        for (const p of dg.bedPerches || []) bedPerches.push(p)
      }
      const tm = last.d.timing || {} as Record<string, any>
      const off = Math.round((tc - t0) / 1000)
      if (tm.crystals != null && crystalSecs == null && !(last.d.crystals && last.d.crystals.left)) crystalSecs = off + tm.crystals
      if (tm.killed != null) killSecs = off + tm.killed
      if (tm.center != null && centerSecs == null) centerSecs = Math.round(off + tm.center)
      if (tm.station != null && stationSecs == null) stationSecs = Math.round(off + tm.station)
      if (last.d.pearl && !pearl) pearl = last.d.pearl
      if (last.d.trace) traces.push(last.d.trace)
      if (deaths(t0)) break
      if ((await header()).dimension !== 'the_end') break
      // Отказ на входе («не хватает снаряжения») — дальше звать без толку (ab-22:
      // 920 тысяч вызовов подряд за 33 минуты).
      if (last.d.need || /ни шагу не сделал/.test(last.d.stopped || '')) break
      if (gameClock.now() - tc < 2000) await sleep(2000)
    }
    const clock1 = (await header()).clock
    const wallSecs = +((gameClock.wall.monotonic() - wall0) / 1000).toFixed(3)
    const gameTicks = clock0 && clock1 ? clock1.ticks - clock0.ticks : null
    const serverTicks = clock0?.serverTicks != null && clock1?.serverTicks != null ? clock1.serverTicks - clock0.serverTicks : null
    const secs = Math.round((gameClock.now() - t0) / 1000)
    await sleep(3000)
    // Убийство — без ожидания портала (02.10, fr1-s18/s19: дракон убит 4 кроватями, но через 3 с он ещё «умирает» —
    // анимация 200 тиков, под нагрузкой фермы дольше — и бой записался «не убил»). Бот видел смерть (won) — ждать,
    // пока сервер не уберёт дракона (до 45 с); портал — отдельная метрика.
    let dragons = await serverCountOnce('ender_dragon')
    for (let w = 0; won && dragons > 0 && w < 15; w++) { await sleep(3000); dragons = await serverCountOnce('ender_dragon') }
    // Высота выходного портала своя в каждом мире: EndDragonFight ставит его по карте высот над
    // (0,0) и спускает сквозь бедрок. Здесь стояло «1 61 0» — и 10 побед из 28 прогонов
    // (dragon-e2e-1…6b, 29.09: killSecs есть, титры видел) записались как «не убил».
    let portal = false
    for (let y = 50; y <= 75 && !portal; y++) {
      const tag = `nd-portal-${++seq}`
      const from = kit.serverLog.mark()
      await kit.cmd(`/execute in minecraft:the_end if block 1 ${y} 0 minecraft:end_portal run say ${tag}`)
      await sleep(250)
      portal = kit.serverLog.linesFrom(from).lines.some(l => l.text.includes(`] ${tag}`) && !l.text.includes('issued server command'))
    }
    const st = await header()
    const d = last.d
    const died = deaths(t0) > 0
    const credits = !!(d.home && d.home.credits)
    // Кристаллы по серверу после боя (тело к этому времени у центра или дома —
    // центр острова держит forceload, обелиски в 42 блоках могут быть не
    // прогружены: тогда null, а не «сбиты»).
    const crystals1 = await serverCountOnce('end_crystal')
    const r: Record<string, any> = { a, kit: kitName, mode: process.env.E2E_MODE || 'default', params: Object.keys(params).length ? params : undefined, calls: callsMade, killed: dragons === 0 && (won || portal || credits), portal, died, home: st.dimension === 'overworld', secs, wallSecs, gameTicks, serverTicks, rate: clock0?.tickRate ?? null, lagTicks: clock1?.lagTicks ?? null, killSecs, crystalSecs, centerSecs, stationSecs, pearl, hp: d.hp, dragonHp: d.dragon && d.dragon.hp, crystals: d.crystals && `${d.crystals.destroyed}/${d.crystals.seen}`, crystalsServer: `${crystals0}->${crystals1}`, crysWait: d.crystals && d.crystals.wait, perches: perchCount, meleePerches: d.dragon && d.dragon.melee && d.dragon.melee.perches, perchCount, bedsTotal: bedsUsed, dragonHpMin: bedPerches.reduce((m, p) => p.hp1 != null ? Math.min(m, p.hp1) : m, 200), bestPerch: bedPerches.reduce((m, p) => p.hp0 != null && p.hp1 != null ? Math.max(m, p.hp0 - p.hp1) : m, 0), bedPerches: bedPerches.map(p => ({ at: p.at, hp0: p.hp0, hp1: p.hp1, beds: p.beds, why: p.why || p.lastWhy, s: p.secs })), beds: d.dragon && d.dragon.beds && d.dragon.beds.used, arrows: d.dragon && d.dragon.arrows, sword: d.dragon && d.dragon.sword, dodged: d.dodged, ate: d.ate, clutch: d.clutch, credits: d.home && d.home.credits, stopped: d.stopped, traces }
    if (died && traces.length) r.cause = deathCause(traces[traces.length - 1])
    results.push(r)
    console.log(`   попытка ${a}: ${JSON.stringify(r)}`)
    if (process.env.E2E_OUT) require('fs').appendFileSync(process.env.E2E_OUT, JSON.stringify({ at: new Date().toISOString(), ...r }) + '\n')
  }
  await kit.cmd(end('forceload remove -16 -16 15 15'))
  await kit.cmd(end('forceload remove -48 -48 47 47'))
  const wins = results.filter(r => r.killed && !r.died).length
  const times = results.filter(r => r.killed && !r.died && r.killSecs != null).map(r => r.killSecs).sort((x, y) => x - y)
  if (times.length) console.log(`   время до смерти дракона, с: ${times.join(', ')} (медиана ${times[Math.floor(times.length / 2)]})`)
  console.log(`   ИТОГ e2e: убил дракона без смерти ${wins} из ${N}; домой через портал ${results.filter(r => r.killed && !r.died && r.home && (r.portal || r.credits)).length} из ${N}`)
  check(`e2e: побед без смерти ${wins}/${N}`, wins === N, results.map(r => ({ a: r.a, killed: r.killed, died: r.died, home: r.home, secs: r.secs })))
}

async function caseRespawn () {
  console.log('\n(respawn) четыре кристалла на портал → новый дракон')
  await ready()
  const alive = await serverCount('ender_dragon', { settle: 1 })
  if (alive) { note('дракон жив — воскрешать некого'); return }
  await kit.cmd('/give @s minecraft:end_crystal 4')
  await fair()
  const { d } = await dragonCall({ mode: 'respawn', timeoutSeconds: 120 })
  console.log(`   ${JSON.stringify(d.respawn)}`)
  let seen = 0
  for (let i = 0; i < 12 && !seen; i++) { await sleep(5000); seen = await serverCount('ender_dragon') }
  check('сервер: дракон снова есть', seen > 0, seen)
}

const RUN = { kit: caseKit, arrive: caseArrive, crystals: caseCrystals, perch: casePerch, bed: caseBed, clutch: caseClutch, cage: caseCage, station: caseStation, e2e: caseE2E, full: caseFull, home: caseHome, respawn: caseRespawn }

;(async () => {
  try {
    await conn.ready
    await call('connect')
    await sleep(1500)
    await call('stop').catch(() => {})
    await kit.setDifficulty('normal')
    if (RESIST) note('RESIST=1: боту сопротивление V — движение проверяется, хп нет')
    for (const c of CASES) {
      if (!RUN[c]) { console.log(`нет случая ${c}`); failures++; continue }
      await RUN[c]()
    }
  } catch (e) {
    console.error('СЦЕНА УПАЛА:', e.message)
    failures++
  } finally {
    console.log(`\n${failures ? `[ПЛОХО] ${failures}` : '[ OK ] всё'}`)
    conn.close()
    process.exitCode = failures ? 1 : 0
  }
})()

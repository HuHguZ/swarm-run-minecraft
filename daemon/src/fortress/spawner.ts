'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz, sleep, gotoPath } from '../movement'
import * as worlds from '../worlds'
import { PLACE, SPAWNER_PLACE, log, rememberSpawner, placeOf } from './look'
import { legTo, climbTo } from './legs'
import { tour } from './tour'

// mode=spawner — дойти до спавнера блейзов. Спавнер виден клиенту, как только
// прогружен его чанк (findBlocks по загруженным чанкам — так решил
// координатор: «виден» без луча), а тур по видимому кирпичу до тронного зала
// не доходил: у найденной крепости «блейзов в 20 блоках не вижу» 20+ раз
// (2026-09-26/27). Дальний — отрезками (legTo: ноги, штрек), ближний —
// climbTo (pathfinder к клетке над спавнером, столб/ступени). Стоп в 10 блоках:
// бой у спавнера ведёт blaze.js (коробка с окном у спавнера).
// Над залом спавнера (штрек вывел на крышу крепости — neF-Q26-1 02.10: 18 бл. над спавнером в 4 бл. по горизонтали,
// 14 вызовов climbTo «на мост не вышел», потом иссушитель): копать вниз под собой, пока ноги выше уровня спавнера.
// Не копать: над лавой (без огнестойкости), у лавы сбоку от клетки (затечёт в шахту), если падение > 6, сам спавнер.
async function digDownTo (session, ctl, sp, deadline) {
  const bot = session.bot
  const SL: typeof import('../sealed') = require('../sealed')
  const fireproof = () => !!(bot.entity.effects && (Object.values(bot.entity.effects) as any[]).some((e : any) => e && (e.id === 12 || /fire_resistance/.test(String(e.name || '')))))
  const lavaAt = v => { const b = bot.blockAt(v); return !!b && /lava/.test(b.name) }
  let dug = 0
  for (let k = 0; k < 40 && !ctl.aborted && gameClock.now() < deadline; k++) {
    const f = bot.entity.position.floored()
    if (f.y <= sp.y + 1) return { ok: true, dug }
    const c = f.offset(0, -1, 0)
    const b1 = bot.blockAt(c)
    if (!b1) return { ok: false, dug, why: 'непрогруженный мир' }
    if (/lava|water|fire/.test(b1.name)) return { ok: false, dug, why: `под ногами ${b1.name}` }
    if (b1.boundingBox === 'empty') { await sleep(300); continue }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (lavaAt(c.offset(dx, 0, dz))) return { ok: false, dug, why: 'лава у шахты' }
    let depth = 0; let land = null
    for (let d = 2; d <= 14; d++) {
      const b = bot.blockAt(f.offset(0, -d, 0))
      if (!b) break
      if (b.boundingBox !== 'empty' || /lava|water/.test(b.name)) { land = b; break }
      depth++
    }
    if (land && /lava/.test(land.name) && !fireproof()) return { ok: false, dug, why: 'под колонной лава' }
    // Падение глубже 6 — только с полным здоровьем (урон = высота − 3: до 9 при 11 клетках воздуха под копкой).
    const maxDepth = (bot.health ?? 20) >= 18 ? 11 : 6
    if (!land || depth > maxDepth) return { ok: false, dug, why: `падение ${land ? depth : depth + '+'}` }
    const r = await SL.digCell(bot, c, { allowGuard: false })
    if (r !== 'ok' && r !== 'air') return { ok: false, dug, why: `копка: ${r}` }
    dug++
    for (let i = 0; i < 30 && !bot.entity.onGround; i++) await sleep(100)
    await sleep(150)
  }
  return { ok: false, dug, why: 'не спустился' }
}

// Тело у зала в толще (штрек/ноги довели «на уровень» в 2–9 бл.), а спавнер не виден: прямой ход 1×2 к клетке
// помоста рядом со спавнером (MonsterThrone: помост 5×5 вокруг спавнера, ноги — на его высоте). neF-XF21-2 03.10: тело
// в 5 бл. (120,67,69 при спавнере 123,67,73) за стеной зала — 3 боя по 400 с «ифриты за стеной», 0 убийств.
// Копает только клетки хода (лицо впереди — его видно), у лавы и над обрывом — стоп. Вкл. — ND_SPAWNER_BREACH=1.
async function breachToSpawner (session, ctl, sp, deadline) {
  const bot = session.bot
  const SL: typeof import('../sealed') = require('../sealed')
  const seesSp = () => { try { const b = bot.blockAt(sp); return !!b && bot.canSeeBlock(b) } catch { return false } }
  const solid = b => !!b && b.boundingBox === 'block'
  const hot = b => !!b && /lava|fire|magma/.test(b.name)
  const me0 = bot.entity.position.floored()
  // Цель — соседняя со спавнером клетка помоста, ближняя к телу (ноги на sp.y, под ногами — твёрдое, не лава).
  const goals0 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    .map(([dx, dz]) => sp.offset(dx, 0, dz))
    .filter(c => !hot(bot.blockAt(c.offset(0, -1, 0))) && solid(bot.blockAt(c.offset(0, -1, 0))))
    .sort((a, b) => a.distanceTo(me0) - b.distanceTo(me0))
  const goal = goals0[0] || sp.offset(Math.sign(me0.x - sp.x) || 1, 0, 0)
  const out: any = { ok: false, steps: 0, dug: 0, goal: xyz(goal) }
  const lavaAround = c => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => { const b = bot.blockAt(c.offset(x, y, z)); return !!b && /lava/.test(b.name) })
  for (let s = 0; s < 16 && !ctl.aborted && gameClock.now() < deadline; s++) {
    if (seesSp()) { out.ok = true; break }
    const f = bot.entity.position.floored()
    if (f.equals(goal)) break
    const dx = goal.x - f.x; const dz = goal.z - f.z; const dy = goal.y - f.y
    // Сперва по высоте (ступенью), потом по длинной оси.
    let step
    if (Math.abs(dx) >= Math.abs(dz) && dx !== 0) step = [Math.sign(dx), 0]
    else if (dz !== 0) step = [0, Math.sign(dz)]
    else step = [0, 0]
    const up = dy > 0 ? 1 : dy < 0 ? -1 : 0
    if (!step[0] && !step[1] && !up) break
    const next = f.offset(step[0], up, step[1])
    // Клетки хода: ноги и голова следующей клетки; ступень вверх — ещё над своей головой.
    const cells = [next.offset(0, 1, 0), next]
    if (up > 0) cells.unshift(f.offset(0, 2, 0))
    if (up < 0) cells.unshift(next.offset(0, 2, 0))
    let bad = ''
    for (const c of cells) {
      const b = bot.blockAt(c)
      if (!b) { bad = 'не прогружено'; break }
      if (/lava/.test(b.name) || lavaAround(c)) { bad = 'лава у хода'; break }
      if (b.boundingBox === 'empty') continue
      if (c.equals(sp)) { bad = 'спавнер на пути'; break }
      const r = await SL.digCell(bot, c)
      if (r === 'ok' || r === 'air') { out.dug++; continue }
      bad = `${b.name}: ${r}`; break
    }
    if (bad) { out.why = bad; break }
    // Пол под следующей клеткой: воздух — обрыв (через ограду зала не прыгать), лава — нельзя.
    const floor = bot.blockAt(next.offset(0, -1, 0))
    if (!floor || hot(floor)) { out.why = 'пол у хода — лава'; break }
    if (floor.boundingBox === 'empty') {
      const f2 = bot.blockAt(next.offset(0, -2, 0))
      if (!solid(f2) || hot(f2)) { out.why = 'обрыв у хода'; break }
    }
    const moved = await SL.stepMove(bot, ctl, { kind: up > 0 ? 'up' : 'flat', to: next })
    out.steps++
    if (!moved && !bot.entity.position.floored().equals(next)) { out.why = 'не шагнул'; break }
  }
  out.ok = out.ok || seesSp()
  out.at = xyz(bot.entity.position.floored())
  log('ход к спавнеру сквозь стену', out)
  return out
}

// ND_NE_ROUTE=1: аварийный отход автопилота у тронного зала (бег на месте под блейзами/иссушителями) кончался смертью
// (neF-B4f22, B6f22, B7f31 03.10) — на время пути к спавнеру тело бережёт себя само (бой на ходу, огнестойкость).
async function toSpawner (session, ctl, opts) {
  // Только при сетке копии мира (ход по ней) — иначе как было.
  if (process.env.ND_NE_ROUTE === '0' || !(require('../nether-route') as typeof import('../nether-route')).gridOf(session)) return toSpawnerBody(session, ctl, opts)
  const em0 = session.emergencyOff
  session.emergencyOff = true
  try { return await toSpawnerBody(session, ctl, opts) } finally { session.emergencyOff = em0 }
}

// Подход к спавнеру (toSpawnerBody) — состояние подхода. Прежние let и стрелки замыкания toSpawnerBody — поля объекта sb
// (SpawnerWalk), значения одного шага цикла подхода — tk (SpawnerTick). Фаза или шаг возвращает итог подхода (конец),
// 'next' (прежний continue цикла) или ничего (дальше).
interface SpawnerWalk {
  session: any
  ctl: any
  deadline: number
  tunnel: boolean
  breach: boolean
  bot: any
  sp: any
  legs: any[]
  fort: any
  spawnerNear: () => any
  toured: any
  atLevel: () => boolean
  floorCells: () => any[]
  floorFails: number
  badFloor: Set<string>
  tunnelTries: number
  digDowns: number
  towerFails: number
  viewTries: number
  breachTries: number
  seesSp: () => boolean
  walkFr: boolean
  walkDrinks: number
  nearDrinks: number
  frWalkFails: number
  frCount: () => number
  frWalk: () => boolean
  legsMax: number
}

interface SpawnerTick {
  i?: number
  me?: any
  d?: number
  flat?: number
  w?: any
}

function swOpen (session, ctl, { deadline, tunnel = false, breach = false }: any): SpawnerWalk {
  const bot = session.bot
  return { session, ctl, deadline, tunnel, breach, bot } as SpawnerWalk
}

// Где спавнер: увиденный глазами или запись памяти этого мира.
function swFind (sb: SpawnerWalk) {
  const { bot, session } = sb
  const id = session.mcData.blocksByName.spawner.id
  // S10: спавнер — увиденный (память глаз + взгляд сейчас), не из памяти клиента сквозь толщу (на scan — как было).
  const found = (require('../perception/eyes') as typeof import('../perception/eyes')).locate(bot, ['spawner'], { radius: 160, max: 6 })
  const rec = placeOf(session, SPAWNER_PLACE)
  sb.sp = null
  if (found.length) {
    const me = bot.entity.position
    // Спавнер крепости — на высоте мостов (48..90), ниже 40 — не наш.
    const ok = found.filter(p => p.y >= 40).sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    if (ok.length) sb.sp = ok[0]
  }
  if (!sb.sp && rec && worlds.worldOfRecord(rec) === 'the_nether') sb.sp = new Vec3(rec.x, rec.y, rec.z)
}

async function swGrid (sb: SpawnerWalk) {
  const { bot, session, ctl, deadline } = sb
  sb.legs = []
  // ND_NE_ROUTE=1 и сетка копии мира есть — весь путь к помосту спавнера одним планом (nether-route: штрек, мосты,
  // спрыгивания по 2–3, без лавы в клетке от тела), а не отрезками legTo/штреком по живым чанкам (neF-A0f22-2 03.10:
  // штрек вывел на крышу над залом в 18 бл., вниз «падение 13+», иссушитель — смерть на 5-й мин).
  const NR: typeof import('../nether-route') = require('../nether-route')
  if (sb.sp && NR.enabled() && NR.gridOf(session) && !ctl.aborted) {
    const B: typeof import('../blaze') = require('../blaze')
    const { potionOf }: typeof import('../pvp') = require('../pvp')
    const frN = () => bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
    // Цель — клетка в 3 бл. НАД помостом (ноги на высоте спавнера +3) в 3 бл. от спавнера: иссушители помоста не
    // достают (рамка удара — только вширь), блейзы — в досягаемости меча (neF-B5f22/B6f22 03.10: на самом помосте два
    // иссушителя убивали за 16 с). План сам решит: мост сверху или столб с помоста.
    // Огнестойкость — на опасные шаги пути (открыто у края/лавы), бою у спавнера оставить 2 зелья (routeTo frKeep).
    const hole = process.env.ND_BLAZE_HOLE === '1' || process.env.ND_BLAZE_CAMP !== '1'
    // Зал открыт сверху (по сетке копии: над помостом на +3..+5 воздух) — сперва точка на +3 над помостом: иссушители на
    // помосте её не достают; оттуда луком всех видимых иссушителей/брутов, и только потом на помост (D2-32/B15o22/B11f22
    // 03.10, сид 6: спуск прямо на помост — 2–3 иссушителя, смерть за 2–7 с).
    const G0 = NR.gridOf(session)
    const NGm: typeof import('../nether-grid') = require('../nether-grid')
    let air = 0; let tot = 0
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 3; dy <= 5; dy++) { tot++; if (NGm.passable(G0.get(sb.sp.x + dx, sb.sp.y + dy, sb.sp.z + dz))) air++ }
    const openAbove = air / tot > 0.8
    if (hole && openAbove && !ctl.aborted) {
      // ND_THRONE_HOT=1: открытое на уровне помоста (ноги от −2 до +2 к спавнеру, ±7 по горизонтали) — +12 за шаг: к точке
      // +3 — мостом сверху или штреком в толще, а не подъёмом с помоста (D6-26 03.10, сид 6: подъём у помоста — иссушитель, смерть).
      const hot = process.env.ND_THRONE_HOT === '1' ? [[sb.sp.x - 7, sb.sp.y - 2, sb.sp.z - 7, sb.sp.x + 7, sb.sp.y + 2, sb.sp.z + 7, 12]] : undefined
      const r0 = await NR.routeTo(session, ctl, { x: sb.sp.x, y: sb.sp.y + 3, z: sb.sp.z, r: 3, dy: 0, solidFloor: true, frKeep: 3, frNear: { x: sb.sp.x, y: sb.sp.y, z: sb.sp.z, r: 22 }, ironOk: true, hot, timeoutSeconds: Math.max(60, Math.round((deadline - gameClock.now()) / 1000) - 60) })
      log('к спавнеру: точка над помостом', { ok: r0.ok, why: r0.why, steps: r0.steps, s: r0.seconds })
      if (r0.ok) {
        const c0 = await NR.rangedClear(session, ctl, { ranged: 0 }, { radius: 14, maxMs: 45000, tower: false }).catch(e => e.message)
        log('к спавнеру: помост сверху луком', { done: c0 })
      }
    }
    const rr = await NR.routeTo(session, ctl, { x: sb.sp.x, y: hole ? sb.sp.y : sb.sp.y + 3, z: sb.sp.z, r: hole ? 2 : 3, dy: 0, solidFloor: true, frKeep: 3, frNear: { x: sb.sp.x, y: sb.sp.y, z: sb.sp.z, r: 22 }, ironOk: true, timeoutSeconds: Math.max(60, Math.round((deadline - gameClock.now()) / 1000) - 30) })
    const seen = (() => { try { const b = bot.blockAt(sb.sp); return !!b && bot.canSeeBlock(b) } catch { return false } })()
    log('к спавнеру по сетке', { ok: rr.ok, why: rr.why, steps: rr.steps, dug: rr.dug, placed: rr.placed, plans: rr.plans, s: rr.seconds, seen })
    // Дошёл до точки над помостом — «дошёл», даже если сам спавнер не виден (стоим на блоках над ним: B8f23 03.10).
    if (rr.ok) return { found: true, reached: true, spawner: xyz(sb.sp), dist: Math.round(bot.entity.position.distanceTo(sb.sp.offset(0.5, 0.5, 0.5))), legs: sb.legs, seen, route: { steps: rr.steps, s: rr.seconds } }
  }
}

async function swLegs (sb: SpawnerWalk) {
  const { bot, session, ctl, deadline } = sb
  // Спавнера не знаем, а крепость в памяти — к ней отрезками legTo (ноги под
  // охраной боя, штрек по незераку на 64+, если ногами не пройти), после
  // каждого — искать спавнер. goto «по прямой» отрезками в 64 от портала
  // кончился огнём и лавой на y=41-58 (2026-09-27, 08:49).
  sb.fort = placeOf(session, PLACE)
  sb.spawnerNear = () => {
    const me = bot.entity.position
    const got = (require('../perception/eyes') as typeof import('../perception/eyes')).locate(bot, ['spawner'], { radius: 160, max: 6, filter: p => p.y >= 40 })
    got.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    return got[0] || null
  }
  for (let i = 0; !sb.sp && sb.fort && worlds.worldOfRecord(sb.fort) === 'the_nether' && i < 40 && !ctl.aborted && gameClock.now() < deadline; i++) {
    const me = bot.entity.position
    const before = me.clone()
    const flat = Math.hypot(sb.fort.x - me.x, sb.fort.z - me.z)
    if (flat <= 24) break
    const k = Math.min(1, 24 / flat)
    const w = await legTo(session, ctl, Math.round(me.x + (sb.fort.x - me.x) * k), Math.round(me.z + (sb.fort.z - me.z) * k), deadline)
    sb.legs.push({ ok: !!w.ok, at: xyz(bot.entity.position), error: w.ok ? undefined : w.error })
    if (w.fought && (bot.health ?? 0) < 10) return { found: false, reached: false, stopped: `бой по дороге к крепости, хп ${Math.round(bot.health ?? 0)}`, legs: sb.legs }
    sb.sp = sb.spawnerNear()
    if (process.env.ND_FORTRESS_FRONTIER !== '0' && !sb.sp && !w.fought && bot.entity.position.distanceTo(before) < 0.8) break
  }
  if (!sb.sp) sb.sp = sb.spawnerNear()
}

async function swTour (sb: SpawnerWalk) {
  const { bot, session, ctl, deadline } = sb
  // tour already follows F3/sound hints, after attempting the visible walking deck.
  // S1f (вслепую — главное открытое S1e: 0 стержней во всех M4, «крепость видна, спавнера в прогруженных нет»): у крепости
  // спавнер не виден и «пирог» отсюда молчит — обход крепости по видимому кирпичу (палубы мостов 48–75) с «пирогом» и слухом
  // ифритов на каждой остановке (tour pie), как игрок с F3. ND_TOUR_PIE=0 — без обхода (прежнее «не видно»).
  sb.toured = null
  if (!sb.sp && sb.fort && worlds.worldOfRecord(sb.fort) === 'the_nether' && process.env.ND_TOUR_PIE !== '0' && !ctl.aborted && gameClock.now() < deadline - 20000) {
    sb.toured = await tour(session, ctl, { deadline: Math.min(deadline - 10000, gameClock.now() + 300000), hops: 14, pie: true })
    if (sb.toured.spawners && sb.toured.spawners.length) sb.sp = new Vec3(sb.toured.spawners[0].x, sb.toured.spawners[0].y, sb.toured.spawners[0].z)
    if (!sb.sp) sb.sp = sb.spawnerNear()
    sb.legs.push({ ok: !!sb.sp, tour: (sb.toured.hops || []).length, deckSteps: sb.toured.deckSteps, deckVisited: sb.toured.deckVisited, at: xyz(bot.entity.position) })
  }
  if (!sb.sp) return { found: false, explored: sb.toured?.explored, frontierRevision: sb.toured?.frontierRevision, stopped: sb.fort ? `у крепости спавнера в прогруженных чанках не видно${sb.toured ? ` (обход ${(sb.toured.hops || []).length} остановок)` : ''}` : 'крепости в памяти нет — сперва найти (fortress без mode)', legs: sb.legs, ...(sb.toured && sb.toured.blazes ? { blazes: sb.toured.blazes } : {}) }
}

// Спавнер известен: проверки «дошёл», клетки пола зала, счётчики попыток, бюджет зелий и отрезков.
function swArm (sb: SpawnerWalk) {
  const { bot, session } = sb
  rememberSpawner(session, { x: sb.sp.x, y: sb.sp.y, z: sb.sp.z })
  // «Дошёл» — на уровне спавнера (±2) и в 6 блоках по горизонтали: блейзы
  // спавнятся в коробке 9×3×9 вокруг него, и из-под пола (8 блоков, но на 7
  // ниже — 2026-09-27, 10:32) их не видно и не достать: 400 с, ноль убитых.
  // И не под ним: из-под спавнера (над головой — он сам) коробка лаборатории
  // не закрылась, и блейз убил тело (2026-09-27, 10:42). Стоять на полу его
  // зала: ноги на уровне спавнера или на блок ниже, в 2..6 блоках сбоку.
  sb.atLevel = () => {
    const p = bot.entity.position
    const h = Math.hypot(p.x - sb.sp.x - 0.5, p.z - sb.sp.z - 0.5)
    // 02.10 (слот 21, новый мир): штрек поднял тело на уровень зала в 7 блоках от спавнера, а «дошёл» требовал ≤ 6 —
    // вызов кончился «не на его уровне». Точку боя у спавнера blaze.choosePost и так ищет в 1.4..9 бл. и ±2 по высоте.
    const dy = Math.floor(p.y) - sb.sp.y
    // Вплотную сбоку (по диагонали, 1.4 бл.) — тоже «дошёл»: neF-e2e-3 02.10 тело у 93,70,23 при спавнере 92,70,24 —
    // 12 шагов «ok» на месте и «не на его уровне» раз в 4 с. Под/над спавнером не бывает: |dy| ≤ 2 и h ≥ 1.2.
    return dy >= -2 && dy <= 2 && h >= 1.2 && h <= 9
  }
  // Клетка пола зала: ноги в воздухе, голова в воздухе, под ногами твёрдое,
  // в 3..5 блоках от спавнера на его уровне (или на блок ниже).
  sb.floorCells = () => {
    const out = []
    for (let dx = -5; dx <= 5; dx++) {
      for (let dz = -5; dz <= 5; dz++) {
        const h = Math.hypot(dx, dz)
        // Помост MonsterThrone — 5×5 вокруг спавнера: дальше 2.8 по нему не встать (слот 22 02.10, срез мира).
        if (h < 1.9 || h > 5) continue
        // Пол зала MonsterThrone — на 2 ниже спавнера (он на помосте): ноги на sp.y−2 тоже.
        for (const dy of [0, -1, -2]) {
          const c = sb.sp.offset(dx, dy, dz)
          const a0 = bot.blockAt(c)
          const b0 = bot.blockAt(c.offset(0, 1, 0))
          const u0 = bot.blockAt(c.offset(0, -1, 0))
          if (a0 && b0 && u0 && a0.boundingBox === 'empty' && b0.boundingBox === 'empty' && u0.boundingBox === 'block' && !/lava|fire/.test(a0.name + u0.name)) out.push(c)
        }
      }
    }
    const me = bot.entity.position
    return out.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  }
  // Пол зала виден, но снизу к нему пути нет: 2026-09-29 14:11–14:16 бот в
  // коридоре на 18 ниже спавнера 300 с звал pathfinder к полу зала (по 40 с) и
  // не сдвинулся. После первого такого провала — столбом вверх, как без пола.
  sb.floorFails = 0
  sb.badFloor = new Set()
  sb.tunnelTries = 0
  sb.digDowns = 0
  sb.towerFails = 0
  sb.viewTries = 0
  sb.breachTries = 0
  sb.seesSp = () => { try { const b = bot.blockAt(sb.sp); return !!b && bot.canSeeBlock(b) } catch { return false } }
  sb.walkFr = false
  sb.walkDrinks = 0
  sb.nearDrinks = 0
  sb.frWalkFails = 0
  sb.frCount = () => { const { potionOf }: typeof import('../pvp') = require('../pvp'); return bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0) }
  // Бюджет зелий: бою у спавнера — 2 (≈ 6 мин), подходу к крепости — 1, ногам — только сверх этого (≥ 4).
  sb.frWalk = () => sb.frWalkFails < 4 && ((require('../blaze') as typeof import('../blaze')).hasEffect(bot, 'fire_resistance') || (sb.walkDrinks < 2 && sb.frCount() >= 4))
  // Спавнер из памяти далеко (карта копии мира: neF-map21-1 02.10 — 589 бл.): 12 отрезков по 24 бл. кончались на
  // 404 бл. «не на его уровне». Отрезков — сколько нужно на расстояние, плюс 12 на сам зал.
  sb.legsMax = 12 + Math.ceil(Math.hypot(sb.sp.x - bot.entity.position.x, sb.sp.z - bot.entity.position.z) / 24)
}

async function swCheck (sb: SpawnerWalk, tk: SpawnerTick) {
  const { bot, session, ctl, deadline, tunnel, breach } = sb
  tk.me = bot.entity.position
  tk.d = tk.me.distanceTo(sb.sp.offset(0.5, 0.5, 0.5))
  // Штреком дошли «на уровень», но тело в толще у зала, спавнер не виден (neF-Sb23-1 02.10: 6 бл. от спавнера в своём
  // штреке, 6 блейзов в 7–15 бл. — vis 0, 4 мин «ифриты за стеной», 0 стержней). В tunnel-режиме «дошёл» — когда
  // спавнер виден; иначе к полу зала (pathfinder с копкой, ветка floorCells ниже), до 3 раз.
  // Спавнер рядом (≤ 9 бл.), на уровне, но не виден — ход сквозь стену зала к помосту (до 2 раз), а не «дошёл» за стеной.
  if (sb.atLevel() && !sb.seesSp() && sb.breachTries < 2 && (breach || process.env.ND_SPAWNER_BREACH === '1')) {
    sb.breachTries++
    const br = await breachToSpawner(session, ctl, sb.sp, Math.min(deadline, gameClock.now() + 60000))
    if (br.ok) return { found: true, reached: true, spawner: xyz(sb.sp), dist: Math.round(bot.entity.position.distanceTo(sb.sp.offset(0.5, 0.5, 0.5))), legs: sb.legs, seen: true, breach: br }
  }
  if (sb.atLevel() && (!tunnel || sb.seesSp() || sb.viewTries >= 3)) return { found: true, reached: true, spawner: xyz(sb.sp), dist: Math.round(tk.d), legs: sb.legs, seen: sb.seesSp() }
  if (sb.atLevel()) { sb.viewTries++; console.log('[fortress] у спавнера, но не вижу его — к полу зала', JSON.stringify({ viewTries: sb.viewTries, at: xyz(bot.entity.position.floored()) })) }
}

async function swWither (sb: SpawnerWalk, tk: SpawnerTick) {
  const { bot, session, ctl, tunnel } = sb
  tk.flat = Math.hypot(sb.sp.x - tk.me.x, sb.sp.z - tk.me.z)
  // Иссушитель рядом и видит нас — бой мечом под щитом, пока хп высокое, а не ждать аварийного отхода: «сперва
  // отрываюсь» в коридоре крепости при иссушителе в 0.3 бл. кончался смертью (neF-F22-2 02.10, neF-Sb26-1).
  if (tunnel && (bot.health ?? 20) >= 12) {
    const { raySees, eyePos }: typeof import('../perception') = require('../perception')
    const ws: any = (Object.values(bot.entities || {}) as any[]).filter((e : any) => e && e.name === 'wither_skeleton' && e.position && e.isValid !== false &&
      e.position.distanceTo(bot.entity.position) < 8 && raySees(bot, eyePos(bot), e.position.offset(0, 1.6, 0)))
      .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (ws) {
      const r = await (require('../combat') as typeof import('../combat')).fight(session, ctl, { target: '#' + ws.id, timeoutSeconds: 25, retreatAtHealth: 7, shield: 'always', clearArea: 0 }).catch(e => ({ error: e.message }))
      console.log('[fortress] иссушитель рядом — бой', JSON.stringify({ killed: !!(r && (r.killed || (r.kills && r.kills.length))), hp: Math.round(bot.health ?? 0), error: r && r.error }))
      return 'next'
    }
  }
}

async function swDrink (sb: SpawnerWalk, tk: SpawnerTick) {
  const { bot, tunnel } = sb
  // У крепости (≤ 64 бл.) — под огнестойкостью: мосты над лавовым морем, блейзы и бой с откидыванием (neF-S26-1 02.10:
  // бой с блейзом на мосту y 74, тело слетело к лаве на y 24 после конца зелья — «tried to swim in lava»).
  if (tunnel && tk.flat <= 64 && sb.nearDrinks < 2 && sb.frCount() >= 3 && !(require('../blaze') as typeof import('../blaze')).hasEffect(bot, 'fire_resistance')) {
    sb.nearDrinks++
    const d0 = await (require('../blaze') as typeof import('../blaze')).drinkFireResistance(bot).catch(e => e.message)
    console.log('[fortress] у крепости: огнестойкость', JSON.stringify({ d: d0, left: sb.frCount(), flat: Math.round(tk.flat) }))
  }
}

// Ход шага цикла подхода: по положению относительно спавнера — вниз к залу, столбом вверх, ногами, штреком, к полу зала.
async function swMove (sb: SpawnerWalk, tk: SpawnerTick) {
  const { bot, tunnel } = sb
  if (Math.floor(tk.me.y) > sb.sp.y + 2 && tk.flat <= 10 && sb.digDowns < 3) {
    await swDigDown(sb, tk)
  } else if (tk.flat <= 6 && Math.floor(tk.me.y) < sb.sp.y - 2 && sb.towerFails < 3 && (!sb.floorCells().length || sb.floorFails >= 1)) {
    await swTower(sb, tk)
  } else if (tk.flat > 24 && tunnel && sb.frWalk()) {
    await swWalkFr(sb, tk)
  } else if (tk.flat > 24 && tunnel && sb.tunnelTries < 2) {
    await swTunnel(sb, tk)
  } else if (tk.flat > 24 && tunnel && !(require('../blaze') as typeof import('../blaze')).hasEffect(bot, 'fire_resistance') && sb.frCount() === 0) {
    // Штрек не довёл, а огнестойкости нет — ногами по Аду не идти (neF-Sc26-1 02.10: без зелья к спавнеру в 230 бл. по
    // уровню лавового моря — гаст, «tried to swim in lava»). Этап кончится неудачей, а не смертью.
    return { found: true, reached: false, spawner: xyz(sb.sp), legs: sb.legs, stopped: `штрек к спавнеру не довёл, огнестойкости нет — ногами по Аду не иду (${Math.round(tk.flat)} бл.)` }
  } else if (tk.flat > 24) {
    await swWalkFar(sb, tk)
  } else {
    await swFloor(sb, tk)
  }
}

async function swDigDown (sb: SpawnerWalk, tk: SpawnerTick) {
  const { bot, session, ctl, deadline } = sb
  // Над залом (штрек/ноги вывели на крышу крепости) — к колонне в 2.5..5 бл. от спавнера на своей высоте, оттуда
  // копкой вниз сквозь крышу в зал (digDownTo: не над лавой, без лавы у шахты, падение ≤ 6).
  sb.digDowns++
  const fy = Math.floor(tk.me.y)
  let col = null
  for (let r = 3; r <= 5 && !col; r++) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r - 1, r - 1], [1 - r, r - 1], [r - 1, 1 - r], [1 - r, 1 - r]]) {
      const c = new Vec3(sb.sp.x + dx, fy, sb.sp.z + dz)
      const a0 = bot.blockAt(c); const b0 = bot.blockAt(c.offset(0, 1, 0)); const u0 = bot.blockAt(c.offset(0, -1, 0))
      if (!(a0 && b0 && u0 && a0.boundingBox === 'empty' && b0.boundingBox === 'empty' && u0.boundingBox === 'block' && !/lava|fire/.test(a0.name + u0.name))) continue
      // Сколько падать в этой колонне: твёрдое под ногами копаем, потом воздух до пола; лава — не годится.
      let y = fy - 1; while (y > sb.sp.y - 3) { const b = bot.blockAt(new Vec3(c.x, y, c.z)); if (!b || b.boundingBox === 'empty' || /lava/.test(b.name)) break; y-- }
      let air = 0; let lava = false; while (y > sb.sp.y - 4) { const b = bot.blockAt(new Vec3(c.x, y, c.z)); if (!b) break; if (/lava/.test(b.name)) { lava = true; break } if (b.boundingBox !== 'empty') break; air++; y-- }
      if (lava) continue
      const cost = air * 4 + c.distanceTo(tk.me)
      if (!col || cost < col.cost) col = Object.assign(c, { cost, air })
    }
  }
  if (col && col.distanceTo(tk.me.floored()) > 0.5) {
    const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
    let t = null
    const path = gotoPath(bot, new goals.GoalBlock(col.x, col.y, col.z))
    try { await Promise.race([path, new Promise<any>((_r, rej) => { t = gameClock.setTimeout(() => rej(new Error('время')), 10000) })]) } catch { try { bot.pathfinder.setGoal(null) } catch {} } finally { path.cancel?.(); if (t) gameClock.clearTimeout(t) }
  }
  const dh = Math.hypot(bot.entity.position.x - sb.sp.x - 0.5, bot.entity.position.z - sb.sp.z - 0.5)
  if (dh >= 1.6) {
    const dw = await digDownTo(session, ctl, sb.sp, Math.min(deadline, gameClock.now() + 60000))
    console.log('[fortress] вниз к залу', JSON.stringify({ col: col ? xyz(col) : null, ...dw, at: xyz(bot.entity.position.floored()) }))
    tk.w = { ok: dw.ok, error: dw.ok ? undefined : `вниз к залу: ${dw.why}` }
  } else tk.w = { ok: false, error: 'над самым спавнером — колонны рядом нет' }
}

async function swTower (sb: SpawnerWalk, tk: SpawnerTick) {
  const { bot, ctl, deadline } = sb
  // Под спавнером — столбом вверх до его уровня (блок под себя; кирпич над
  // головой towerUp ломает). Прямо под ним столб упрётся в сам спавнер —
  // сперва на соседнюю клетку в 2 блоках (2026-09-27, 10:32: тело в
  // полости на 7 ниже, над ним три ряда кирпича и спавнер).
  if (Math.hypot(tk.me.x - sb.sp.x - 0.5, tk.me.z - sb.sp.z - 0.5) < 1.6) {
    const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
    const fy = Math.floor(tk.me.y)
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const c = new Vec3(sb.sp.x + dx, fy, sb.sp.z + dz)
      const a0 = bot.blockAt(c)
      const b0 = bot.blockAt(c.offset(0, 1, 0))
      const u0 = bot.blockAt(c.offset(0, -1, 0))
      if (!a0 || !b0 || !u0 || a0.boundingBox !== 'empty' || b0.boundingBox !== 'empty' || u0.boundingBox !== 'block') continue
      let t = null
      const path = gotoPath(bot, new goals.GoalBlock(c.x, c.y, c.z))
      try {
        await Promise.race([path, new Promise<any>((_r, rej) => { t = gameClock.setTimeout(() => rej(new Error('время')), 8000) })])
      } catch { try { bot.pathfinder.setGoal(null) } catch {} } finally { path.cancel?.(); if (t) gameClock.clearTimeout(t) }
      break
    }
  }
  // Столб по одному блоку; над головой твёрдое (пол зала над нами) — сломать его (видно прямо над головой), лава выше
  // — стоп. towerUp сам потолок не ломает («потолок nether_bricks»; neF-F22 02.10: 12 шагов подряд на месте в 9 бл.
  // под спавнером).
  const SL: typeof import('../sealed') = require('../sealed')
  const need = Math.min(12, sb.sp.y - Math.floor(bot.entity.position.y))
  let climbed = 0; let why = ''
  for (let s2 = 0; s2 < need && !ctl.aborted && gameClock.now() < deadline; s2++) {
    const f0 = bot.entity.position.floored()
    const h2 = f0.offset(0, 2, 0)
    const hb = bot.blockAt(h2)
    if (hb && hb.boundingBox === 'block') {
      const above = bot.blockAt(h2.offset(0, 1, 0))
      if (above && /lava/.test(above.name)) { why = 'над потолком лава'; break }
      if (sb.sp.x === h2.x && sb.sp.z === h2.z && sb.sp.y === h2.y) { why = 'над головой спавнер'; break }
      const r = await SL.digCell(bot, h2)
      if (r !== 'ok' && r !== 'air') { why = `потолок ${hb.name}: ${r}`; break }
    }
    const up1 = await (require('../build') as typeof import('../build')).towerUp(bot, ctl, 1, { sneak: true })
    if (!up1.ok) { why = up1.reason || 'столб не вырос'; break }
    climbed++
  }
  tk.w = climbed > 0 ? { ok: true, climbed } : { ok: false, error: why || 'столб не вырос' }
  if (!tk.w.ok) sb.towerFails++
}

async function swWalkFr (sb: SpawnerWalk, tk: SpawnerTick) {
  const { bot, session, ctl, deadline } = sb
  // Под огнестойкостью — ногами (legTo, ~2–3 бл/с): штрек по Аду ~0.2–1 бл/с (neF-R23-1 02.10: 170 бл. за 16 мин),
  // а лава под зельем не убивает. Зелье на ход — только пока на бой у спавнера остаётся ≥ 2.
  const B: typeof import('../blaze') = require('../blaze')
  if (!B.hasEffect(bot, 'fire_resistance')) { sb.walkDrinks++; const d = await B.drinkFireResistance(bot).catch(e => e.message); for (let q = 0; q < 40 && !B.hasEffect(bot, 'fire_resistance'); q++) await sleep(100); console.log('[fortress] ногами к спавнеру: огнестойкость', JSON.stringify({ d, left: sb.frCount() })) }
  const k = 24 / tk.flat
  tk.w = await legTo(session, ctl, Math.round(tk.me.x + (sb.sp.x - tk.me.x) * k), Math.round(tk.me.z + (sb.sp.z - tk.me.z) * k), deadline)
  if (!tk.w.ok) sb.frWalkFails++
}

async function swTunnel (sb: SpawnerWalk, tk: SpawnerTick) {
  const { session, ctl, deadline, tunnel, breach } = sb
  // Спавнер известен (карта копии мира) и далеко — закрытым штреком (tunnel.js) к точке в 4 бл. от него со своей
  // стороны, на его высоте: ноги legTo по Аду гибли в лаве и падали (neF-Pa24-1 02.10: «не на его уровне» в 238 бл.,
  // потом пешком — «tried to swim in lava»). Штрек не начался с открытого — закопаться (bastion.burrow) и снова.
  sb.tunnelTries++
  const hx = tk.me.x - sb.sp.x - 0.5; const hz = tk.me.z - sb.sp.z - 0.5; const hd = Math.hypot(hx, hz) || 1
  const P = { x: Math.floor(sb.sp.x + 0.5 + hx / hd * 4), y: sb.sp.y, z: Math.floor(sb.sp.z + 0.5 + hz / hd * 4) }
  const { tunnelTo }: typeof import('../tunnel') = require('../tunnel')
  // ironOk: к спавнеру идут после бастиона (порядок BASTION_FIRST) — железная кирка золоту больше не нужна; без неё
  // каменные кончались, и штрек копал рукой (neF-R23-1 02.10: «кирок нет — копаю чем есть», 0.2 бл/с).
  const tOpts = () => ({ radius: 6, band: Math.max(40, Math.min(100, sb.sp.y)), ironOk: true, deadline: Math.min(deadline - 20000, gameClock.now() + 90000 + tk.flat * 2500), log: (wh, d) => console.log('[fortress] ' + wh, JSON.stringify(d)) })
  let tr = await tunnelTo(session, ctl, P, tOpts())
  if (!tr.ok && !tr.segs && !tr.dug && !ctl.aborted) {
    const bw = await (require('../bastion') as typeof import('../bastion')).burrow(session, ctl, {}, 'штрек к спавнеру не начался')
    if (bw.ok) tr = await tunnelTo(session, ctl, P, tOpts())
  }
  delete tr.own
  console.log('[fortress] штрек к спавнеру', JSON.stringify({ ok: tr.ok, why: tr.why, segs: tr.segs, dug: tr.dug, breach: tr.breach, at: tr.at, to: P }))
  tk.w = { ok: tr.ok, error: tr.ok ? undefined : `штрек: ${tr.why}` }
}

async function swWalkFar (sb: SpawnerWalk, tk: SpawnerTick) {
  const { bot, session, ctl, deadline, tunnel } = sb
  // Ногами по Аду к дальнему спавнеру — под огнестойкостью, если зелий хватает и на бой (≥ 3): лава на пути ногами
  // — главная смерть перехода (neF-Pa24-1 02.10: «tried to swim in lava»). Шар блейза под ней тоже не жжёт.
  if (tunnel && !sb.walkFr) {
    sb.walkFr = true
    const B: typeof import('../blaze') = require('../blaze')
    const { potionOf }: typeof import('../pvp') = require('../pvp')
    const frN = bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
    if (frN >= 3 && !B.hasEffect(bot, 'fire_resistance')) { const d = await B.drinkFireResistance(bot).catch(e => e.message); console.log('[fortress] ногами к спавнеру: огнестойкость', JSON.stringify({ d, left: frN - 1 })) }
  }
  // Отрезок в 24 блока к спавнеру (ноги, штрек — legTo).
  const k = 24 / tk.flat
  tk.w = await legTo(session, ctl, Math.round(tk.me.x + (sb.sp.x - tk.me.x) * k), Math.round(tk.me.z + (sb.sp.z - tk.me.z) * k), deadline)
}

async function swFloor (sb: SpawnerWalk, tk: SpawnerTick) {
  const { bot, session, ctl, deadline } = sb
  // Пол зала, к которому pathfinder уже не нашёл пути, второй раз не берём: 02.10 (слот 21, новый мир) тело в 20
  // блоках под залом звало pathfinder к той же клетке 12 раз за 4 с («No path»), вызов и этап — пусто, пауза 5 мин.
  const cells = sb.floorCells().filter(c => !sb.badFloor.has(`${c.x},${c.y},${c.z}`))
  if (cells.length && sb.floorFails < 2) {
    const c = cells[0]
    const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
    let t = null
    const path = gotoPath(bot, new goals.GoalBlock(c.x, c.y, c.z))
    try {
      await Promise.race([path, new Promise<any>((_r, rej) => { t = gameClock.setTimeout(() => rej(new Error('время')), 40000) })])
      // goto «дошёл», а тело на месте (neF-map21-1 02.10: 4 шага «ok» у 554,27,105 при поле зала на y 67–69) — провал.
      const f = bot.entity.position
      if (Math.hypot(f.x - c.x - 0.5, f.z - c.z - 0.5) > 1.6 || Math.abs(Math.floor(f.y) - c.y) > 1) throw new Error(`goto кончился в ${Math.round(f.x)},${Math.floor(f.y)},${Math.round(f.z)}`)
      tk.w = { ok: true }
    } catch (e) { try { bot.pathfinder.setGoal(null) } catch {} sb.floorFails++; sb.badFloor.add(`${c.x},${c.y},${c.z}`); tk.w = { ok: false, error: `к полу зала ${c.x},${c.y},${c.z}: ${e.message}` } } finally { path.cancel?.(); if (t) gameClock.clearTimeout(t) }
  } else {
    // Ногами к полу не выйти — подъём ступеньками штрека (climbTo → nether.bore) не к самому спавнеру (штрек
    // встал бы вплотную к нему, а «дошёл» — это 2..6 сбоку), а к точке в 3.5 блока от него со своей стороны.
    const hx = tk.me.x - sb.sp.x - 0.5; const hz = tk.me.z - sb.sp.z - 0.5; const hd = Math.hypot(hx, hz) || 1
    const P = { x: Math.floor(sb.sp.x + 0.5 + hx / hd * 3.5), y: sb.sp.y - 1, z: Math.floor(sb.sp.z + 0.5 + hz / hd * 3.5) }
    tk.w = await climbTo(session, ctl, P, deadline)
  }
}

async function swLog (sb: SpawnerWalk, tk: SpawnerTick) {
  const { bot, ctl, deadline } = sb
  sb.legs.push({ ok: !!tk.w.ok, at: xyz(bot.entity.position), error: tk.w.ok ? undefined : tk.w.error })
  console.log('[fortress] к спавнеру', JSON.stringify({ i: tk.i, floorFails: sb.floorFails, aborted: ctl.aborted, left: Math.round((deadline - gameClock.now()) / 1000), at: xyz(bot.entity.position), sp: xyz(sb.sp), ok: !!tk.w.ok, error: tk.w.ok ? undefined : String(tk.w.error || '').slice(0, 120) }))
  if (tk.w.fought && (bot.health ?? 0) < 10) return { found: true, reached: false, spawner: xyz(sb.sp), stopped: `бой по дороге, хп ${Math.round(bot.health ?? 0)}`, legs: sb.legs }
}

function swFinal (sb: SpawnerWalk) {
  const { bot } = sb
  const d = bot.entity.position.distanceTo(sb.sp.offset(0.5, 0.5, 0.5))
  const lvl = sb.atLevel()
  return { found: true, reached: lvl, spawner: xyz(sb.sp), dist: Math.round(d), legs: sb.legs, stopped: lvl ? undefined : `до спавнера ${Math.round(d)} блоков, по высоте ${Math.floor(bot.entity.position.y) - sb.sp.y} — не на его уровне` }
}

// Фазы до цикла и шаги цикла подхода — порядок прежнего тела toSpawnerBody.
const SW_PHASES: ((sb: SpawnerWalk) => any)[] = [swFind, swGrid, swLegs, swTour]
const SW_STEPS: ((sb: SpawnerWalk, tk: SpawnerTick) => Promise<any>)[] = [swCheck, swWither, swDrink, swMove, swLog]

async function toSpawnerBody (session, ctl, opts: any) {
  const sb = swOpen(session, ctl, opts)
  const { deadline } = sb
  for (const phase of SW_PHASES) {
    const r = await phase(sb)
    if (r !== undefined) return r
  }
  swArm(sb)
  turn: for (let i = 0; i < sb.legsMax && !ctl.aborted && gameClock.now() < deadline; i++) {
    const tk: SpawnerTick = { i }
    for (const step of SW_STEPS) {
      const r = await step(sb, tk)
      if (r === 'next') continue turn
      if (r !== undefined) return r
    }
  }
  return swFinal(sb)
}

export { toSpawner }

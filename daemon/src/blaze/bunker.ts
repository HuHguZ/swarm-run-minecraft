'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from '../movement'
import { walkable } from '../walkable'
import { lavaNear } from './targets'
import { walkNear } from './approach'
import { losClearBut } from './radar'
import { DOOR_SIDES, solidB, airB } from './post'

const REST_BLOCKS = 10

// Коробка на отдых: 10 блоков, поесть, ждать хп, выйти к спавнеру.
// Клетка под коробку: пол под ней и под всеми четырьмя соседями (стенам есть на
// что встать), над головой и вокруг — воздух или блок (не лава, не огонь), лавы
// в 3 блоках нет. Ближайшая, кроме той, где не вышло.
function boxSpot (bot, not) {
  const nodes = walkable(bot, bot.entity.position, { radius: 10, maxNodes: 1500 })
  for (const { pos, d } of nodes) {
    if (d < 1 || (not && pos.equals(not))) continue
    let ok = true
    for (const sd of DOOR_SIDES) {
      const g = bot.blockAt(pos.plus(sd).offset(0, -1, 0))
      const f = bot.blockAt(pos.plus(sd))
      const h = bot.blockAt(pos.plus(sd).offset(0, 1, 0))
      if (!solidB(g) && !solidB(f)) { ok = false; break }
      if (!(solidB(f) || airB(f)) || !(solidB(h) || airB(h))) { ok = false; break }
    }
    if (!ok) continue
    const roof = bot.blockAt(pos.offset(0, 2, 0))
    if (!(solidB(roof) || airB(roof))) continue
    if (lavaNear(bot, pos, 3)) continue
    return pos
  }
  return null
}

async function boxRest (session, ctl, { toward, until = 19, maxMs = 60000, hardMs = maxMs, onPhase = () => {}, threat = null, minimumBlocks = REST_BLOCKS }: any = {}) {
  const bot = session.bot
  const fortify: typeof import('../fortify') = require('../fortify')
  const actions: typeof import('../actions') = require('../actions')
  const { pickFiller }: typeof import('../build') = require('../build')
  const filler = pickFiller(bot)
  const blocks = bot.inventory.items().filter(i => /^(cobblestone|cobbled_deepslate|netherrack|stone|dirt|blackstone|basalt|nether_bricks|soul_soil|andesite|diorite|granite|tuff|deepslate)$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  if (!filler || blocks < minimumBlocks) return { rested: false, why: `блоков на коробку мало (${blocks} из ${minimumBlocks})` }
  const hp0 = Math.round(bot.health ?? 0)
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  onPhase('коробка')
  let box = null
  let enc = null
  const tries = []
  // Враг вплотную или бьют во время стройки — коробку бросить: 2026-09-29
  // 13:55 основной бот строил её рядом с ифритом, клетки заняты, «другое
  // место» — и три удара 10.7 → 0. Решает вызвавший (бегство, не стройка).
  const underAttack = () => (threat && threat()) || (bot.health ?? 0) <= hp0 - 4
  for (let attempt = 0; attempt < 3 && !ctl.aborted; attempt++) {
    if (underAttack()) return { rested: false, threat: true, why: 'враг вплотную — коробку не строю', tries }
    box = await fortify.boxIn(bot, { toward, roof: true, ctl, timeoutMs: 800, hard: false })
    if (!box.sealed) {
      // Недостроено: достроить (патч по тому же плану) — на краю моста опоры нет.
      await fortify.patch(bot, box.plan, { timeoutMs: 800 }).catch(() => 0)
    }
    enc = fortify.enclosure(bot, box.cell)
    tries.push({ at: xyz(box.cell), placed: box.placed, walls: enc.walls, roof: enc.roof, failed: box.failed ? box.failed.slice(0, 2) : undefined })
    if (enc.sealed) break
    if (underAttack()) return { rested: false, threat: true, why: 'враг вплотную — коробку не достроить', tries }
    // Не закрылось (проём в стене крепости, край помоста): сидеть в полукоробке
    // под шарами — смерть (замер 3: «placed 1», 26 с на огне и в лаве). Клетка,
    // где у всех четырёх сторон есть пол, без лавы в 3 блоках — и снова.
    const spot = boxSpot(bot, box.cell)
    if (!spot) break
    onPhase('коробка: другое место')
    await walkNear(bot, ctl, spot, 0, 8000)
    if (!bot.entity.position.floored().equals(spot)) break
  }
  if (!enc || !enc.sealed) {
    return { rested: false, why: 'коробка не закрылась', tries }
  }
  const t0 = gameClock.now()
  let ate = 0
  // Лечение идёт — сидеть и после maxMs (до hardMs), пока хп растёт: 2026-09-29
  // 12:27 закрытая коробка за 60 с вылечила дольками арбуза 11 → 18, отдых
  // объявлен незавершённым на 18 из 19, и бой у спавнера брошен целиком.
  // 20 с без прибавки — лечение встало (еда кончилась, сытость < 18).
  let bestHp = bot.health ?? 0
  let riseAt = t0
  onPhase('отдых в коробке')
  while (!ctl.aborted && (bot.health ?? 0) < until) {
    const now = gameClock.now()
    if ((bot.health ?? 0) > bestHp) { bestHp = bot.health ?? 0; riseAt = now }
    if (now - t0 >= maxMs && (now - t0 >= hardMs || now - riseAt > 20000)) break
    if ((bot.food ?? 20) < 20) {
      try { const r = await actions.eat(session, {}); if (r && r.ate) ate++ } catch {}
    }
    if ((bot.food ?? 20) < 18 && !bot.inventory.items().some(i => /cooked|bread|apple|carrot|potato|steak|porkchop|mutton|chicken|rabbit|cod|salmon|beef|stew|cookie|pie|melon|berries/.test(i.name))) break
    await sleep(500)
  }
  const healed = `${hp0} -> ${Math.round(bot.health ?? 0)}`
  const rested = !ctl.aborted && (bot.health ?? 0) >= until && (bot.food ?? 0) >= 18
  if (!rested) return { rested: false, why: 'лечение в коробке не завершено', placed: box.placed,
    sealed: enc.sealed, seconds: Math.round((gameClock.now() - t0) / 1000), hp: healed, ate, exited: false }
  onPhase('выход из коробки')
  const out: Awaited<ReturnType<typeof fortify.breakOut>> = await fortify.breakOut(bot, box.cell, { toward }).catch(e => ({ ok: false, steps: [e.message] }))
  // Выломанное — в рюкзак (коробка ест 10 блоков, запас 64).
  try { await actions.collectNearbyDrops(bot, ctl, { radius: 3, timeoutMs: 2500 }) } catch {}
  // Дыра в стене ещё не выход. Сбор своего дропа оставлял тело внутри
  // коробки: второй бой 400 с не видел ни одного ифрита. Выйти ногами и
  // проверить клетку после сбора, пока следующая тактика не взяла руки.
  let exited = false
  if (out.ok && out.outside && !ctl.aborted) {
    await walkNear(bot, ctl, out.outside, 0, 5000)
    exited = bot.entity.position.floored().equals(out.outside)
  }
  return {
    rested: true,
    placed: box.placed,
    tries: tries.length > 1 ? tries : undefined,
    sealed: enc.sealed,
    seconds: Math.round((gameClock.now() - t0) / 1000),
    hp: healed,
    ate: ate || undefined,
    exited,
    out: exited ? 'вышел' : `выход не завершён: ${(out.steps || []).join(', ')}`
  }
}

// Где строить: клетка в 2.5..7 блоках от спавнера по горизонтали, глаза не
// ниже его центра на 3 и не выше на 2, дверь (сосед к спавнеру, ноги и
// голова) свободна, спавнер виден из глаз через дверь не дальше 40° от её
// оси, стены ставятся с пола (край моста — нет).
function planBunker (bot, spawner, have, { hMin=2.5,hMax=9,hBest=4,fullWalls=false,openOnly=false }: any = {}) {
  const solid = fullWalls ? b => !!b && b.shapes?.length === 1 && b.shapes[0].every((v,i)=>v===(i<3?0:1)) : solidB
  const c = spawner.offset(0.5, 0.5, 0.5)
  const lava = bot.registry.blocksByName.lava.id
  const nodes = walkable(bot, bot.entity.position, { radius: 18, maxNodes: 3000 })
  let best = null
  const tried = { n: 0, far: 0, door: 0, los: 0, hot: 0, edge: 0, blocks: 0 }
  for (const { pos, d } of nodes) {
    tried.n++
    const h = Math.hypot(pos.x + 0.5 - c.x, pos.z + 0.5 - c.z)
    const dyEye = c.y - (pos.y + 1.62)
    if (fullWalls && Math.abs(pos.y-spawner.y)>1) { tried.far++; continue }
    if (h < hMin || h > hMax || dyEye < -2.5 || dyEye > 3.5 || pos.offset(0.5, 1.62, 0.5).distanceTo(c) > 13) { tried.far++; continue }
    const vx = c.x - (pos.x + 0.5); const vz = c.z - (pos.z + 0.5)
    const front = Math.abs(vx) >= Math.abs(vz) ? new Vec3(Math.sign(vx), 0, 0) : new Vec3(0, 0, Math.sign(vz))
    const ang = Math.acos(Math.max(-1, Math.min(1, (vx * front.x + vz * front.z) / (Math.hypot(vx, vz) || 1))))
    if (ang > 0.7) { tried.door++; continue }
    // Окно — голова со стороны спавнера: воздух или кирпич, который выкопаем;
    // ноги с той стороны — воздух (дверь) или блок (подоконник).
    const winCell = pos.plus(front).offset(0, 1, 0)
    const win = bot.blockAt(winCell)
    const sill = bot.blockAt(pos.plus(front))
    const digWin = solid(win) && /nether_brick|netherrack|cobblestone|stone|blackstone|basalt|soul|gravel|dirt/.test(win.name) && !/spawner|chest/.test(win.name)
    if (openOnly && (digWin || !airB(sill))) { tried.door++; continue }
    if (!(airB(win) || digWin) || !(airB(sill) || solid(sill))) { tried.door++; continue }
    const eye = pos.offset(0.5, 1.62, 0.5)
    let hot = false
    for (let x = -2; x <= 2 && !hot; x++) for (let y = -1; y <= 2 && !hot; y++) for (let z = -2; z <= 2 && !hot; z++) {
      const b = bot.blockAt(pos.offset(x, y, z))
      if (b && (b.type === lava || /fire/.test(b.name))) hot = true
    }
    if (hot) { tried.hot++; continue }
    // Стены: три стороны кроме двери, ноги и голова; крыша над головой.
    const walls = []
    let bad = false
    for (const s of DOOR_SIDES) {
      if (s.equals(front)) continue
      for (const y of [0, 1]) {
        const q = pos.plus(s).offset(0, y, 0)
        const b = bot.blockAt(q)
        if (solid(b)) continue
        if (!airB(b)) { bad = true; break }
        // Ноги стены ставятся на пол под ней (или к соседу по стене);
        // голова — на ноги.
        if (y === 0 && !solid(bot.blockAt(q.offset(0, -1, 0)))) { bad = true; break }
        walls.push(q)
      }
      if (bad) break
    }
    if (bad) { tried.edge++; continue }
    const roof = pos.offset(0, 2, 0)
    let roofNeed = []
    if (!solid(bot.blockAt(roof))) {
      // Крыше опереться: блок над стеной сзади (back+2) — на её голову.
      const back = front.scaled(-1)
      const sup = pos.plus(back).offset(0, 2, 0)
      roofNeed = solid(bot.blockAt(sup)) ? [roof] : [sup, roof]
      if (!airB(bot.blockAt(roof))) { tried.edge++; continue }
    }
    const need = walls.length + roofNeed.length
    if (need > have) { tried.blocks++; continue }
    // Сколько клеток куба спавна видно из двери — туда смотрит бой.
    let seen = 0
    for (let x = -3; x <= 3; x += 2) for (let z = -3; z <= 3; z += 2) for (const y of [0, 1.5]) {
      const q = c.offset(x, y, z)
      if (q.distanceTo(eye) < 1.5) continue
      const dx = q.x - eye.x; const dz = q.z - eye.z
      if ((dx * front.x + dz * front.z) / (Math.hypot(dx, dz) || 1) < 0.72) continue
      if (losClearBut(bot, eye, q, digWin ? [winCell] : [])) seen++
    }
    if (seen < 3) { tried.los++; continue }
    const score = seen * 1.2 - need * 0.8 - (digWin ? 1 : 0) - Math.abs(h - hBest) * 1.2 - Math.abs(dyEye - 0.5) * 0.7 - d * 0.05
    if (!best || score > best.score) best = { cell: pos, front, walls, roof: roofNeed, need, digWin: digWin ? winCell : null, sill: solid(sill), h: Math.round(h * 10) / 10, seen, score }
  }
  if (best) best.tried = tried
  return best || { none: true, tried }
}

// Блок на верх соседнего блока, чья верхняя грань выше глаз: из клетки 1x2
// её не видно (честная стройка — только по видимым граням, pick.faceAim), а в
// прыжке глаза на 1.25 выше — видно. Так ставится опора крыши на заднюю стену.
async function jumpPlaceTop (bot, below, timeoutMs = 900, { ctl=null,stopIf=null }: any = {}) {
  const stopped=()=>!!ctl?.aborted||!!stopIf?.()
  if(stopped()) return {ok:false,why:"прервано"}
  const { pickFiller, withTimeout }: typeof import('../build') = require('../build')
  const { faceAim }: typeof import('../pick') = require('../pick')
  const stack = pickFiller(bot)
  if (!stack) return { ok: false, why: 'нечем строить' }
  if (!bot.heldItem || bot.heldItem.type !== stack.type) { try { await bot.equip(stack, 'hand') } catch (e) { return { ok: false, why: e.message } } }
  if(stopped()) return {ok:false,why:"прервано"}
  const ref = bot.blockAt(below)
  if (!solidB(ref)) return { ok: false, why: 'опоры нет' }
  const up = new Vec3(0, 1, 0)
  bot.setControlState('jump', true)
  const t0 = gameClock.now()
  let seen = false
  try {
    while (!stopped() && gameClock.now() - t0 < 900) {
      await sleep(20)
      if (bot.entity.position.y + 1.62 > below.y + 1.2 && faceAim(bot, below, up)) { seen = true; break }
    }
  } finally { bot.setControlState('jump', false) }
  if (stopped() || !seen) return { ok: false, why: 'прервано или не увидел верхнюю грань' }
  try {
    await bot.lookAt(below.offset(0.5, 1, 0.5), true)
    if(stopped()) return {ok:false,why:"прервано"}
    await withTimeout(bot.placeBlock(ref, up), timeoutMs)
  } catch {}
  await sleep(200)
  return { ok: solidB(bot.blockAt(below.offset(0, 1, 0))) }
}

// Коробка с окном у спавнера (лаборатория 2026-09-27, замеры 10-12: в открытую
// у спавнера смерть в 4 попытках из 5 — огонь от шаров со спины, иссушитель,
// удары блейзов в упор). Клетка в 1..5 блоках от спавнера на его высоте ±1,
// стены с четырёх сторон на ноги и голову, крыша; открыт один блок на уровне
// головы — окно в сторону, откуда видно больше всего куба спавна. Всё, что
// летит в нас, летит в окно: щит к окну держит каждый шар (±90° по
// горизонтали), блейз (1.8) и иссушитель (2.4) в окно 1x1 не пролезают, а
// меч из окна достаёт того, кто подлетел (3 блока от глаз). Подбор снаружи
// через стену не гарантирован: Player.aiStep расширяет нашу рамку лишь на 1 блок.
function planKillBox (bot, spawner, have, { hMin = 3, hMax = 7.5, hBest = 5, lowWindow = false }: any = {}) {
  const c = spawner.offset(0.5, 0.5, 0.5)
  const nodes = walkable(bot, bot.entity.position, { radius: 16, maxNodes: 3000 })
  let best = null
  const tried = { n: 0, far: 0, hot: 0, walls: 0, blocks: 0, view: 0 }
  for (const { pos, d } of nodes) {
    tried.n++
    const h = Math.hypot(pos.x + 0.5 - c.x, pos.z + 0.5 - c.z)
    // 3..7 блоков: конус окна (±45° по горизонтали, −51..+37° по вертикали)
    // накрывает куб спавна ±4 только издали — замер 21: коробка в 2 блоках от
    // спавнера видела одного блейза из пяти, 1 стрела за 70 с.
    // Пол зала тоже годится (на 3-4 ниже спавнера): блейзы висят на его высоте
    // и выше, окно смотрит на них снизу вверх (до +37°).
    if (h < hMin || h > hMax || pos.y - spawner.y > 1 || pos.y - spawner.y < -4 || d > 30) { tried.far++; continue }
    if (lavaNear(bot, pos, 2)) { tried.hot++; continue }
    const walls = []
    let bad = false
    for (const sd of DOOR_SIDES) {
      const f = pos.plus(sd); const hd = f.offset(0, 1, 0)
      const bf = bot.blockAt(f); const bh = bot.blockAt(hd)
      if (!(solidB(bf) || airB(bf)) || !(solidB(bh) || airB(bh))) { bad = true; break }
      if (airB(bf)) {
        // Край помоста: под стеной пусто — сначала подпорка (к блоку под нашими
        // ногами она встаёт боком), потом стена (замер 22: у края все 18 клеток
        // отпали, «места под коробку нет»).
        // Под стеной пусто (край помоста) — не годится: подпорку честно (по
        // видимой грани) из клетки не поставить — замер 24, «не к чему
        // прислонить блок» трижды.
        if (!solidB(bot.blockAt(f.offset(0, -1, 0)))) { bad = true; break }
        walls.push(f)
      }
      if (airB(bh)) walls.push(hd)
    }
    if (bad) { tried.walls++; continue }
    const roofAt = pos.offset(0, 2, 0)
    const rb = bot.blockAt(roofAt)
    if (!(solidB(rb) || airB(rb))) { tried.walls++; continue }
    const eye = pos.offset(0.5, 1.62, 0.5)
    for (const sd of DOOR_SIDES) {
      const win = pos.plus(sd).offset(0, lowWindow ? 0 : 1, 0)
      const pad = pos.plus(sd.scaled(2))
      if (lowWindow && (!solidB(bot.blockAt(pad.offset(0, -1, 0))) || !airB(bot.blockAt(pad)) || !airB(bot.blockAt(pad.offset(0, 1, 0))))) continue
      const wb = bot.blockAt(win)
      if (!wb || wb.name === 'spawner') continue
      const digWin = solidB(wb)
      if (digWin && !/nether_brick|netherrack|cobblestone|stone|blackstone|basalt|soul_soil/.test(wb.name)) continue
      let roof = []
      if (!solidB(rb)) {
        const back = pos.minus(sd).offset(0, 2, 0)
        roof = solidB(bot.blockAt(back)) ? [roofAt] : [back, roofAt]
      }
      const myWalls = walls.filter(q => !q.equals(win))
      const need = myWalls.length + roof.length + (lowWindow ? 1 : 0)
      if (need > have) { tried.blocks++; continue }
      // Куб спавна через окно: луч из глаз проходит плоскость стены в
      // пределах грани окна и дальше чист.
      let seen = 0
      if (!lowWindow) for (const x of [-3, -1, 1, 3]) for (const z of [-3, -1, 1, 3]) for (const y of [0, 1.5, 3]) {
        const q = c.offset(x, y, z)
        const dx = q.x - eye.x; const dz = q.z - eye.z
        const along = dx * sd.x + dz * sd.z
        if (along < 0.6) continue
        const t = 0.5 / along
        const lat = (dx * Math.abs(sd.z) + dz * Math.abs(sd.x)) * t
        const hy = eye.y + (q.y - eye.y) * t
        if (Math.abs(lat) > 0.45 || hy < pos.y + 1.05 || hy > pos.y + 1.95) continue
        if (losClearBut(bot, eye, q, [win])) seen++
      }
      if (!lowWindow && seen < 3) { tried.view++; continue }
      const score = seen * 2 - need * 0.5 - Math.abs(h - hBest) * 0.8 - d * 0.3 - (lowWindow ? pad.offset(0.5, 0.5, 0.5).distanceTo(c) : 0)
      if (!best || score > best.score) best = { cell: pos, front: sd, walls: myWalls, roof, digWin: digWin ? win : null, win, lowWindow, seen, need, h: Math.round(h * 10) / 10, score }
    }
  }
  if (best) best.tried = tried
  return best || { none: true, tried }
}

async function buildBunker (session, ctl, plan, setPhase, { stopIf=null,maxPlacements=Infinity }: any = {}) {
  const bot = session.bot
  const { placeBlockAt }: typeof import('../build') = require('../build')
  const fortify: typeof import('../fortify') = require('../fortify')
  setPhase('к шалашу')
  if (stopIf && (ctl.aborted || stopIf())) return { ok:false,placed:0,why:'обстановка изменилась' }
  const w = await walkNear(bot, ctl, plan.cell, 0, 15000, {stopIf})
  if (!bot.entity.position.floored().equals(plan.cell)) {
    // Ещё шаг: pathfinder «дошёл» в соседнюю клетку.
    if (!stopIf?.()) await walkNear(bot, ctl, plan.cell, 0, 5000, {stopIf})
  }
  if (!bot.entity.position.floored().equals(plan.cell)) return { ok: false, why: `до клетки шалаша не дошёл (${w.error || 'встал рядом'})` }
  await fortify.centerInCell(bot,700,null,stopIf?ctl:null)
  if(stopIf && (ctl.aborted||stopIf())) return {ok:false,placed:0,why:"прервано при центровке"}
  setPhase('стройка шалаша')
  let placed = 0
  const failed = []
  const workAt=gameClock.now()
  for (const q of [...plan.walls, ...plan.roof]) {
    if (ctl.aborted || stopIf?.() || placed>=maxPlacements) break
    let r = await placeBlockAt(bot, q, { timeoutMs: 900, honest: true,...(stopIf?{steady:true,ctl}:{}) }).catch(e => ({ ok: false, reason: e.message }))
    // Опора крыши на задней стене: её верх выше глаз — в прыжке.
    if (!r.ok && !stopIf?.() && solidB(bot.blockAt(q.offset(0, -1, 0)))) {
      await fortify.centerInCell(bot,700,null,stopIf?ctl:null)
      if(stopIf && (ctl.aborted||stopIf())) break
      const j = await jumpPlaceTop(bot, q.offset(0, -1, 0),900,{ctl:stopIf?ctl:null,stopIf})
      await sleep(300)
      r = j.ok ? { ok: true } : { ok: false, reason: `${r.reason}; в прыжке: ${j.why || 'не встал'}` }
    }
    if (r.ok && !r.already) placed++
    else if (!r.ok) failed.push(`${q.x},${q.y},${q.z}: ${r.reason}`)
  }
  if ((!stopIf || !ctl.aborted && !stopIf()) && placed<maxPlacements && plan.digWin && solidB(bot.blockAt(plan.digWin))) {
    try { await (require('../tools') as typeof import('../tools')).breakFast(bot, plan.digWin, { maxMs: 4000 }) } catch {}
  }
  const cell = plan.cell
  let open = 0
  for (const s of DOOR_SIDES) {
    if (s.equals(plan.front)) { if (plan.win && (!solidB(bot.blockAt(cell.plus(s).offset(0, plan.lowWindow ? 1 : 0, 0))) || !airB(bot.blockAt(plan.win)))) open++; continue }
    for (const y of [0, 1]) if (!solidB(bot.blockAt(cell.plus(s).offset(0, y, 0)))) open++
  }
  const roofed = solidB(bot.blockAt(cell.offset(0, 2, 0)))
  return { ok: open === 0 && roofed, placed, open, roofed,workMs:gameClock.now()-workAt, failed: failed.length ? failed.slice(0, 4) : undefined }
}

// Дверь заложить (отдых) и открыть снова.
async function shutDoor (bot, b) {
  const { placeBlockAt }: typeof import('../build') = require('../build')
  const cells = [b.cell.plus(b.front), b.cell.plus(b.front).offset(0, 1, 0)].filter(q => !solidB(bot.blockAt(q)))
  b.shut = cells.length ? cells : (b.shut || [b.win || b.cell.plus(b.front).offset(0, 1, 0)])
  let ok = 0
  for (const q of cells) {
    const r = await placeBlockAt(bot, q, { timeoutMs: 900 }).catch(() => ({ ok: false }))
    if (r.ok) ok++
  }
  return ok === cells.length && [0, 1].every(y => solidB(bot.blockAt(b.cell.plus(b.front).offset(0, y, 0))))
}
async function openDoor (bot, b) {
  const tools: typeof import('../tools') = require('../tools')
  for (const q of (b.shut || [b.cell.plus(b.front).offset(0, 1, 0)]).slice().reverse()) {
    const blk = bot.blockAt(q)
    if (blk && blk.boundingBox === 'block') { try { await tools.breakFast(bot, q, { maxMs: 4000 }) } catch {} }
  }
  return (b.shut || []).every(q => airB(bot.blockAt(q)))
}

export { boxRest, planBunker, planKillBox, buildBunker, shutDoor, openDoor }

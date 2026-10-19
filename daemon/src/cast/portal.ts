'use strict'
// Литьё портала (cast.ts): castPortal — рама целиком (режимы, план, расчистка, углы, клетки, подпорки).
import { Vec3 } from 'vec3'
import { xyz } from '../movement'
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { missingHarvestTool, equipBestTool } from '../items'
import { placeBlockAt } from '../build'
import {
  FILLER_STEADY, LAVA_KEEP, MAX_DIG, PLACE, REACH, SOFT_PLANT, UP, centre, clearanceKeys, countOf, digRisk, digVisible,
  eyes, feetCell, frameKeys, geom, geomOf, isAir, isSolid, levelOf
} from './base'
import { hearLava, hearWater, lavaSources, planCast, refillState, resumeOnePlan } from './plan'
import { scoopAim, scoopableSources, standSpots } from './bucket'
import { descend, openWindow, stand, walk, windowCandidates } from './walk'
import { castCell } from './cell'


// ---------------------------------------------------------------- целиком

// hint — где чутьё штрека нашло лаву за блоком ({x,y,z}); maxDig/keep — см. judge; windows — разрешить окна к
// лаве и при доборе (глубокое литьё в штреке, кампания: ND_OW_DEEP).
export async function castPortal (session, ctl, { timeoutSeconds = 540, radius = 9, maxDig = MAX_DIG, keep = LAVA_KEEP, hint = null, windows = false, waterHint = null }: any = {}) {
  const bot = session.bot
  const mode = await castModes(session, ctl, arguments[2], waterHint)
  if (mode) return mode.ret
  const deadline = gameClock.now() + Math.max(60, Math.min(600, timeoutSeconds)) * 1000 - 5000
  const report: any = { cast: [], refills: 0, placed: 0, dug: 0 }
  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  })
  const buckets = countOf(bot, 'bucket') + countOf(bot, 'water_bucket') + countOf(bot, 'lava_bucket')
  if (buckets < 2) {
    return { ...report, built: false, stopped: 'нужно два ведра: одно под воду, одно под лаву (6 железа)', need: { what: 'bucket', count: 2, have: buckets } }
  }
  // Все годные наполнители, а не первый по списку: 8 булыжника и 30 земли — это 38 блоков, а не 8 («нужно блоков 10»).
  const filler = () => FILLER_STEADY.reduce((n, name) => n + countOf(bot, name), 0)
  if (filler() < 10) return { ...report, built: false, stopped: 'на углы, столбы и подпорки нужно блоков 10', need: { what: 'cobblestone', count: 10, have: filler() } }

  const site = await castSite(session, ctl, report, { radius, maxDig, keep, hint, windows })
  if (site.ret) return site.ret
  const plan = site.plan
  const g = geomOf(plan)
  report.site = { origin: plan.origin, axis: plan.axis, side: plan.side, lavaDist: plan.lavaDist }
  if (process.env.ND_OW_KIT_FRAME !== '0' && session.castLavaFailure) {
    const current = refillState(bot, plan)
    if (current.empty && current.key === session.castLavaFailure.key) return { ...report, built: false, frame: current.frame,
      stopped: session.castLavaFailure.stopped, retryBlocked: true }
    session.castLavaFailure = null
  }
  const late = () => gameClock.now() > deadline || ctl.aborted
  const groundY = g.F(0, -1).y

  const dropped = await clearSite(session, ctl, plan, g, report, late)
  if (dropped) return dropped
  const stopped = await castFrame(session, ctl, plan, g, report, late)
  // 4. Вниз, подпорки долой, проём чистый.
  await descend(bot, ctl, groundY, report)
  if (!stopped) {
    await stand(session, ctl, g, 0, -1, report)
    for (let j = 2; j >= 0; j--) {
      for (const i of [0, 1]) {
        const p = g.at(i, j)
        const b = bot.blockAt(p)
        // Трава и слой снега в проёме тоже долой: зажечь можно только пустой проём (PortalShape.isEmpty).
        if (!b || isAir(b) || (b.boundingBox === 'empty' && !SOFT_PLANT.test(b.name))) continue
        if (/water|lava/.test(b.name)) continue
        try { await equipBestTool(bot, b); await digVisible(bot, b, 6000); report.dug++ } catch {}
      }
    }
  }
  const frame = frameKeys(g).map(p => bot.blockAt(p)).map(b => (b ? b.name : '?'))
  const done = frame.filter(n => n === 'obsidian').length
  const built = done === 10
  if (process.env.ND_OW_KIT_FRAME !== '0' && !built && !ctl.aborted && /лава кончилась/.test(stopped || '')) {
    const current = refillState(bot, plan)
    if (current.empty) session.castLavaFailure = { key: current.key, stopped }
  }
  return {
    ...report,
    built,
    frame: `${done}/10 обсидиан`,
    stopped: built ? undefined : (stopped || `рама не собралась: ${done}/10`)
  }
}

// Режимы без литья: одно ведро (cast1), слух, отладка у подсказки, только вода глубоко. Итог — { ret } для возврата из
// castPortal или undefined (литьё рамы).
async function castModes (session, ctl, args, waterHint) {
  const bot = session.bot
  // Одно ведро, с берега озера (cast1.js, поток route): portal cast {one: true}.
  if (args && args.one) return { ret: (require('../cast1') as typeof import('../cast1')).castOne(session, ctl, args) }
  // Слух (ND_OW_HEAR): лава с воздухом над ней в 16 бл. — направление и примерная дальность, без движения тела.
  if (args && args.listen) {
    const rad = Number(args.listen) > 1 ? Number(args.listen) : 16
    return { ret: { built: false, heard: args.fluid === 'water' ? hearWater(bot, { radius: rad }) : hearLava(bot, { radius: rad }) } }
  }
  // Отладка (сцены): что видит литьё у подсказки — без движения тела.
  if (args && args.probe) {
    const pr = args.probe
    const h = new Vec3(Math.floor(pr.x), Math.floor(pr.y), Math.floor(pr.z))
    const near = []
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 0; dy++) {
      const q = h.offset(dx, dy, dz); const b = bot.blockAt(q)
      if (b && b.name === 'lava') near.push({ at: xyz(q), level: levelOf(b), up: (bot.blockAt(q.plus(UP)) || {}).name, sees: (() => { try { return (require('../sight') as typeof import('../sight')).seesBlock(bot, b) } catch (e) { return 'err ' + e.message } })(), aim: !!scoopAim(bot, q) })
    }
    return { ret: { built: false, probe: true, pos: xyz(bot.entity.position), eye: (p => [p.x, p.y, p.z].map(v => Math.round(v * 100) / 100))(eyes(bot)), sources: lavaSources(bot, 28).map(b => xyz(b.position)).slice(0, 10), near: near.filter(n => n.level === 0).slice(0, 20), spots: standSpots(bot, h).slice(0, 5).map(x => xyz(x.S)), windows: windowCandidates(bot, h).slice(0, 5).map(c => xyz(c.w)) } }
  }
  // Только вода глубоко (ведро ещё пустое, штрек встал у воды за блоком): окно над источником и черпак — тем же
  // ходом литья, без отдельного RPC (session.bucket окон не открывает).
  if (waterHint) {
    const rep0 = { cast: [], refills: 0, placed: 0, dug: 0 }
    if (countOf(bot, 'water_bucket')) return { ret: { ...rep0, water: true, built: false } }
    if (!countOf(bot, 'bucket')) return { ret: { ...rep0, water: false, built: false, stopped: 'нет пустого ведра' } }
    await openWindow(session, ctl, waterHint, rep0, { fluid: 'water' })
    const r = await (require('../obsidian') as typeof import('../obsidian')).fillBucket(session, ctl, { fluid: 'water', radius: 8 })
    return { ret: { ...rep0, water: !!(r && (r.filled || r.already)), built: false, stopped: r && r.stopped } }
  }
}

// Место рамы: прошлый план (сессия или журнал мира), продолжение начатой рамы из набора, новое место у видимой лавы.
// ret — итог для возврата из castPortal (лавы не видно, места нет).
async function castSite (session, ctl, report, { radius, maxDig, keep, hint, windows }) {
  const bot = session.bot
  // План: прошлый, если его рама ещё не испорчена, иначе новый у видимой лавы.
  // Прошлый переживает и перезапуск демона — он в памяти мира (place), иначе
  // вторая попытка начала бы вторую раму рядом с наполовину отлитой первой.
  let plan = session.castPlan
  if (!plan) {
    const rec = ((session.journal.state && session.journal.state.places) || {})[PLACE]
    const here = bot.game ? bot.game.dimension : null
    if (rec && rec.axis && rec.side && (rec.dimension || 'overworld') === (here || 'overworld')) {
      const g0 = geom(new Vec3(rec.x, rec.y, rec.z), rec.axis, rec.side)
      plan = { axis: rec.axis, side: rec.side, origin: { x: rec.x, y: rec.y, z: rec.z }, dig: rec.dig || clearanceKeys(g0).map(xyz), corners: [xyz(g0.at(-1, -1)), xyz(g0.at(2, -1))], lavaDist: rec.lavaDist, lavaAt: rec.lavaAt || [], windows: !!(rec.windows || windows) }
    }
  }
  if (plan) {
    session.castPlan = plan // Refill must see the plan restored from the journal.
    const g0 = geomOf(plan)
    const far = g0.at(0, 0).distanceTo(bot.entity.position) > 24
    if (far) { plan = null; session.castPlan = null }
  }
  if (!plan && process.env.ND_OW_KIT_FRAME !== '0') {
    plan = resumeOnePlan(session, { maxDig, windows })
    if (plan) {
      session.castPlan = plan
      session.journal.patch(st => {
        st.places ||= {}; st.places[PLACE] = { ...plan.origin, dimension: bot.game?.dimension, axis: plan.axis, side: plan.side,
          lavaAt: plan.lavaAt, windows: plan.windows, dig: plan.dig, note: 'литьё рамы' }
      })
    }
  }
  if (!plan) {
    const hintList = hint ? [hint] : []
    let lava = scoopableSources(bot, hintList).map(b => b.position)
    if (!lava.length) lava = lavaSources(bot, 24).map(b => b.position)
    // Лава известна, но отсюда не видна (тело отошло — прошлое место рамы, край штрека заслоняет): к клетке, откуда
    // черпак её достаёт, и смотреть оттуда; не видна и там — окно над источником.
    if (!lava.length && hint && windows) {
      const h = new Vec3(Math.floor(hint.x), Math.floor(hint.y), Math.floor(hint.z))
      const sp = standSpots(bot, h).map(x => x.S)
      for (const S of sp.slice(0, 2)) { if (await walk(bot, ctl, new goals.GoalBlock(S.x, S.y, S.z), 20000)) break }
      lava = scoopableSources(bot, hintList).map(b => b.position)
      if (!lava.length) lava = lavaSources(bot, 24).map(b => b.position)
    }
    if (!lava.length && hint && windows) {
      await openWindow(session, ctl, hint, report)
      lava = scoopableSources(bot, [...hintList, ...(report.lastWindow ? [report.lastWindow] : [])]).map(b => b.position)
    }
    if (!lava.length) return { ret: { ...report, built: false, stopped: 'не вижу лавы-источника в 24 блоках — подойди к лаве (озеро, пещера)' } }
    const found = planCast(bot, lava, { radius, maxDig, keep, groundY: windows ? feetCell(bot).y : null, mcData: session.mcData })
    if (!found.ok) return { ret: { ...report, built: false, stopped: `места под раму у лавы нет: ${found.reasons.join(', ')}` } }
    plan = found.plan
    // Где лава, которую видели при выборе места: со стойки у рамы её может
    // заслонять край ямы, и черпать тогда идут сюда (refillLava).
    plan.lavaAt = lava.slice(0, 12).map(p => xyz(p))
    plan.windows = !!windows
    session.castPlan = plan
    session.journal.patch(s => {
      if (!s.places) s.places = {}
      s.places[PLACE] = { ...plan.origin, dimension: bot.game ? bot.game.dimension : null, axis: plan.axis, side: plan.side, lavaDist: plan.lavaDist, lavaAt: plan.lavaAt, windows: plan.windows, dig: plan.dig, note: `литьё рамы: ось ${plan.axis}, сторона ${plan.side}` }
    })
  }
  return { plan, ret: undefined }
}

async function clearSite (session, ctl, plan, g, report, late) {
  const bot = session.bot
  // 1. Расчистка. Сначала проход на уровне ног и головы (ряд перед рамой, j=-1..0) — от ближней клетки: так тело
  // само прокапывает себе дорогу (в штреке глубоко место копается почти целиком). Потом остальное сверху вниз —
  // стоя на полу перед своей колонкой рамы, только то, до чего достать с пола: к недосягаемой клетке pathfinder
  // строил столб булыжника прямо в ряду перед рамой (потом «потолок cobblestone» у литья).
  const digCell = async p => {
    const b = bot.blockAt(p)
    if (!b || isAir(b) || /lava|water/.test(b.name)) return null
    const risk = digRisk(p => bot.blockAt(p), p)
    if (risk) return risk
    const problem = b.boundingBox === 'empty' ? null : missingHarvestTool(bot, b, session.mcData)
    if (problem) return problem
    try { await equipBestTool(bot, b); await digVisible(bot, b, 8000); report.dug++ } catch {}
    const after = bot.blockAt(p)
    return after && isAir(after) ? null : 'клетка не выкопана'
  }
  const floorFor = p => {
    let best = null
    for (let i = -1; i <= 2; i++) {
      const f = g.F(i, -1)
      const d = f.offset(0.5, 1.62, 0.5).distanceTo(centre(p))
      if (!best || d < best.d) best = { f, d }
    }
    return best
  }
  const groundY0 = g.F(0, -1).y
  const frameSet = new Set(frameKeys(g).map(p => `${p.x},${p.y},${p.z}`))
  const cellsToDig = plan.dig.map(c => new Vec3(c.x, c.y, c.z))
    .filter(p => !(frameSet.has(`${p.x},${p.y},${p.z}`) && (bot.blockAt(p) || {}).name === 'obsidian'))
  const low = cellsToDig.filter(p => p.y <= groundY0 + 1)
  const inFront = p => g.axis === 'x' ? p.z === g.F(0, 0).z : p.x === g.F(0, 0).x
  const high = cellsToDig.filter(p => p.y > groundY0 + 1)
    .sort((a, b) => a.y - b.y || Number(inFront(b)) - Number(inFront(a)))
  // Невидимая сейчас клетка (за ещё не выкопанной соседкой) — не повод бросать литьё: в следующий проход, когда
  // соседку снимут, её грань откроется. Останов — только по риску (жидкость/сыпучее рядом) и по инструменту.
  const notDug = why => why === 'клетка не выкопана'
  // Место оказалось негодным при копке (жидкость за стенкой, сыпучее сверху, нечем копать) — план забыть, иначе
  // каждый следующий вызов поднимает его из журнала и встаёт на той же клетке (ow-L1 02.10, слот 15: три вызова за
  // секунду «жидкость сбоку»). Следующий вызов выберет место заново.
  const dropPlan = r => {
    session.castPlan = null
    try { session.journal.patch(st => { if (st.places) delete st.places[PLACE] }) } catch {}
    return r
  }
  for (let pass = 0; pass < 3 && !late(); pass++) {
    let left = 0
    const lowLeft = low.filter(p => { const b = bot.blockAt(p); return b && !isAir(b) && !/lava|water/.test(b.name) })
    while (lowLeft.length && !late()) {
      lowLeft.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      const p = lowLeft.shift()
      if (eyes(bot).distanceTo(centre(p)) > REACH) await walk(bot, ctl, new goals.GoalNear(p.x, p.y, p.z, 1), 15000, { clearance: true })
      const why = await digCell(p)
      if (why && !notDug(why)) return dropPlan({ ...report, built: false, stopped: `расчистить место: ${why}` })
      if (why) left++
    }
    for (const p of high) {
      if (late()) break
      const b = bot.blockAt(p)
      if (!b || isAir(b) || /lava|water/.test(b.name)) continue
      const st = floorFor(p)
      if (!st || st.d > REACH + 0.2) { report.skipped = (report.skipped || 0) + 1; continue }
      if (eyes(bot).distanceTo(centre(p)) > REACH) {
        const f = feetCell(bot)
        if (!f.equals(st.f)) await walk(bot, ctl, new goals.GoalBlock(st.f.x, st.f.y, st.f.z), 15000)
      }
      if (eyes(bot).distanceTo(centre(p)) > REACH + 0.2) { report.skipped = (report.skipped || 0) + 1; continue }
      const why = await digCell(p)
      if (why && !notDug(why)) return dropPlan({ ...report, built: false, stopped: `расчистить место: ${why}` })
      if (why) left++
    }
    // Следующий проход — то, что осыпалось (гравий над выкопанным) или было закрыто соседкой.
    if (!left) break
  }
  {
    // Что осталось невыкопанным из нужного воздуха (разбор: «не встал на …» после расчистки).
    const frameSet2 = new Set(frameKeys(g).map(p => `${p.x},${p.y},${p.z}`))
    const left = clearanceKeys(g).filter(p => { const b = bot.blockAt(p); return b && !isAir(b) && !/lava|water/.test(b.name) && !(frameSet2.has(`${p.x},${p.y},${p.z}`) && b.name === 'obsidian') })
    if (left.length) {
      report.trace = report.trace || []
      report.trace.push(`не выкопано ${left.length}: ${left.slice(0, 4).map(p => `${p.x},${p.y},${p.z} ${(bot.blockAt(p) || {}).name}`).join('; ')}`)
    }
  }
}

// Углы, клетки рамы в порядке раскладки и подпорки; итог — почему литьё встало (или null).
async function castFrame (session, ctl, plan, g, report, late) {
  const bot = session.bot
  // 2. Нижние углы — опора стоек.
  for (const c of plan.corners) {
    if (late()) break
    const p = new Vec3(c.x, c.y, c.z)
    if (isSolid(bot.blockAt(p))) continue
    if (eyes(bot).distanceTo(centre(p)) > REACH) await stand(session, ctl, g, 0, -1, report)
    const r = await placeBlockAt(bot, p, { steady: true })
    if (r.ok) report.placed++
  }

  // 3. Клетки рамы в порядке раскладки.
  const T = [
    { cell: g.at(0, -1), lavaRef: g.at(0, -2), waterRef: g.F(0, -2), col: 0, h: -1 },
    { cell: g.at(1, -1), lavaRef: g.at(1, -2), waterRef: g.F(1, -2), col: 1, h: -1 },
    { cell: g.at(-1, 0), lavaRef: g.at(-1, -1), waterRef: g.at(0, -1), col: 0, h: -1 },
    { cell: g.at(2, 0), lavaRef: g.at(2, -1), waterRef: g.at(1, -1), col: 1, h: -1 },
    { cell: g.at(-1, 1), lavaRef: g.at(-1, 0), waterRef: g.F(-1, 0), col: -1, h: 1 },
    { cell: g.at(-1, 2), lavaRef: g.at(-1, 1), waterRef: g.F(-1, 1), col: -1, h: 2 },
    { props: true },
    { cell: g.at(2, 1), lavaRef: g.at(2, 0), waterRef: g.F(2, 0), col: 2, h: 1 },
    { cell: g.at(2, 2), lavaRef: g.at(2, 1), waterRef: g.F(2, 1), col: 2, h: 2 },
    { cell: g.at(1, 3), lavaRef: g.at(1, 2), waterRef: g.at(2, 2), col: 2, h: 3 },
    { cell: g.at(0, 3), lavaRef: g.at(0, 2), waterRef: g.at(-1, 2), col: -1, h: 3 }
  ]
  let stopped = null
  for (const t of T) {
    if (late()) { stopped = 'время вышло — позови ещё раз, продолжу с этой рамы'; break }
    if (t.props) {
      // Временные подпорки в верхний ряд проёма — с земли, у стоек.
      const s = await stand(session, ctl, g, 0, -1, report)
      if (!s.ok) { stopped = s.why; break }
      for (const p of [g.at(0, 2), g.at(1, 2)]) {
        if (isSolid(bot.blockAt(p))) continue
        const r = await placeBlockAt(bot, p, { steady: true })
        if (r.ok) report.placed++
        else { stopped = `подпорка ${p.x},${p.y},${p.z}: ${r.reason}`; break }
      }
      if (stopped) break
      continue
    }
    const r = await castCell(session, ctl, g, t, report)
    if (!r.ok) {
      if (r.fatal) { stopped = r.why; break }
      // Одна повторная попытка — лава кончилась посреди, вода утекла и т. п.
      const again = await castCell(session, ctl, g, t, report)
      if (!again.ok) { stopped = `клетка ${t.cell.x},${t.cell.y},${t.cell.z}: ${again.why}`; break }
    }
  }
  return stopped
}

'use strict'
// Литьё одним ведром (cast1.ts): castOne — фазы захода (план, берег, расчистка, перемычки, своё, лава в ведре, клетки, итог).
import { Vec3 } from 'vec3'
import { placeBlockAt } from '../build'
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import {
  OneCast, climb, cnt, digOne, dropPlan, dumpLava, fill, goG, hazard, late, placeOne, regainWater, strayWater, syncH, tr
} from './kit'
import { C, PLACE1, cells, fluid, geomOf1, isAirB, keyOf, solid, sourceState1 } from './geometry'
import { lavaBodyOpen, materialNeed1, plan1, pourInto, shoreFirst } from './plan'
import { castCell, shiftPillar } from './cell'


// План: прошлый (в памяти мира), если рядом, иначе новый у видимой лавы. ret — итог для возврата из castOne.
async function onePlan (ox: OneCast) {
  const { session, p, bot, report } = ox
  // План: прошлый (в памяти мира), если рядом, иначе новый у видимой лавы.
  let plan = session.castPlan1
  if (!plan) {
    const rec = ((session.journal.state && session.journal.state.places) || {})[PLACE1]
    if (rec && rec.axis) plan = { axis: rec.axis, side: rec.side, origin: { x: rec.x, y: rec.y, z: rec.z }, dig: rec.dig || [], place: rec.place || [] }
  }
  if (plan && geomOf1(plan).G(0, 0).distanceTo(bot.entity.position) > 24) plan = null
  if (!plan) {
    const hint = p.hint ? new Vec3(Math.floor(p.hint.x), Math.floor(p.hint.y), Math.floor(p.hint.z)) : null
    let lava = C().lavaSources(bot, 24).map(b => b.position)
    if (hint) {
      // Тело лавы у подсказки (карта копии мира) по связности — без требования «есть где встать с черпаком»: в закрытой
      // пещере стоять негде, пока место не выкопано (rt-R4 слот 10: «не вижу лавы» в 8 бл. от озера под породой).
      const seen = new Set(lava.map(q => `${q.x},${q.y},${q.z}`))
      for (const q of lavaBodyOpen(bot, hint)) if (!seen.has(`${q.x},${q.y},${q.z}`)) { seen.add(`${q.x},${q.y},${q.z}`); lava.push(q) }
    }
    lava = lava.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    if (!lava.length) return { ret: { ...report, built: false, stopped: 'не вижу лавы-источника в 24 блоках — подойди к озеру' } }
    // Сперва источники у берега (ND_CAST1_EDGE=0 — прежний порядок) (сосед на том же уровне — твёрдый не-лава блок): берег рамы H→G только у них, а 60
    // ближних к телу у большого озера — середина и дальний «плохой» берег (s8-f2-9: «берег не твёрдый (52)» у озера 72,-42, где в
    // s8-r2-8 литьё вышло за 53 с с другой стороны). И кандидатов вдвое больше.
    const edgeFirst = process.env.ND_CAST1_EDGE !== '0'
    if (edgeFirst) lava = shoreFirst(bot, lava)
    const found = plan1(bot, lava, { maxDig: Math.max(20, Math.min(90, p.maxDig || 40)), ...(edgeFirst ? { maxCand: 120 } : {}) })
    if (!found.ok) return { ret: { ...report, built: false, stopped: `места на берегу нет: ${found.reasons.join(', ')}` } }
    plan = found.plan
    try { session.journal.patch(s => { if (!s.places) s.places = {}; s.places[PLACE1] = { ...plan.origin, dimension: bot.game ? bot.game.dimension : null, axis: plan.axis, side: plan.side, dig: plan.dig, place: plan.place, note: 'литьё одним ведром' } }) } catch {}
  }
  return { plan, ret: undefined }
}

async function oneShore (ox: OneCast) {
  const { ctl, bot, report, plan, g } = ox
  // 1. К берегу. Берег ниже ног (озеро в чаше, «low»: путь литья вниз не копает) — сперва выкопать досягаемое из плана
  // (клетки берега, столб, жёлоб), потом ещё раз (лаб ow-c1n: «не встал на берег» в 1-м вызове из 2).
  if (!(await goG(ox, 0))) {
    const near = plan.dig.map(q => new Vec3(q.x, q.y, q.z)).filter(q => C().eyes(bot).distanceTo(q.offset(0.5, 0.5, 0.5)) <= 4.3).sort((a, b) => b.y - a.y)
    for (const q of near.slice(0, 12)) { if (late(ox)) break; await digOne(ox, q) }
    if (!(await goG(ox, 0))) return { ...report, built: false, stopped: `не встал на берег ${g.G(0, 0).x},${g.G(0, 0).y},${g.G(0, 0).z}` }
  }
  await C().centreOn(bot, ctl, g.G(0, 0))
  tr(ox, 'на берегу')
  // Пол берега, где его нет (план: place G(±1|2,−1); воздух или лава у кромки) — до расчистки: он держит воду жёлоба от
  // озера и лаву от клеток жёлоба.
  for (const q of [-1, 1, 2].map(i => g.G(i, -1)).filter(q => !solid(bot.blockAt(q)))) {
    let r = await placeBlockAt(bot, q, { steady: true, honest: true })
    // Не к чему прислонить (вокруг воздух/лава): сперва блоки под ним, до 3 вниз, потом он сам (S8c 07.10, s8c-a-s1-4: тот же
    // отказ трижды подряд — рама брошена). ND_CAST1_SHORE_PROP=0 — выкл.
    if (!r.ok && /прислонить/.test(String(r.reason)) && process.env.ND_CAST1_SHORE_PROP !== '0') {
      const under = []
      for (let d = 1; d <= 3; d++) { const u = q.offset(0, -d, 0); under.push(u); if (solid(bot.blockAt(u.offset(0, -1, 0)))) break }
      for (const u of under.reverse()) { if (!solid(bot.blockAt(u)) && (await placeBlockAt(bot, u, { steady: true, honest: true })).ok) report.placed++ }
      r = await placeBlockAt(bot, q, { steady: true, honest: true })
    }
    if (!r.ok) return dropPlan(ox, { ...report, built: false, stopped: `пол берега ${q.x},${q.y},${q.z} не встал: ${r.reason}` })
    report.placed++
    tr(ox, `пол берега ${q.x},${q.y},${q.z}`)
  }
}

async function oneClear (ox: OneCast) {
  const { bot, report, plan, g } = ox
  // С земли — всё, до чего достать (до O.y+1) и столб тела G(0,·) целиком (иначе «потолок» у столба); выше — со столба.
  const allDigs = plan.dig.map(q => new Vec3(q.x, q.y, q.z))
  const g0 = ox.g0 = g.G(0, 0)
  const lowDig = q => q.y <= g.origin.y + 1 || (q.x === g0.x && q.z === g0.z)
  const digs = allDigs.filter(lowDig).sort((a, b) => a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  ox.highDigs = allDigs.filter(q => !lowDig(q)).sort((a, b) => a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  for (let pass = 0; pass < 2 && !late(ox); pass++) {
    let left = 0
    for (const q of digs) { const w = await digOne(ox, q); if (w && w !== 'не выкопано') return dropPlan(ox, { ...report, built: false, stopped: `расчистка: ${w}` }); if (w) left++ }
    if (!left) break
  }
}

async function oneBarriers (ox: OneCast) {
  const { report, g } = ox
  // 3. Перемычки и стенки жёлоба внизу (с земли: j ≤ 1).
  // Опора для блока без твёрдой грани рядом (S8b 07.10: «не к чему прислонить» ×25 в s8-f2..f4 — стенка жёлоба F(−2,1) или
  // подпорка F(−1,3) без нижнего блока стенки, который раньше не встал без ошибки): стенка — блок под ней, подпорка — стенка.
  // Блоки кончились посреди рамы (s8-f2..f4: «подпорка не встала: must be holding an item») — в ответе need: маршрут добирает
  // блоки (castOneAt) и зовёт ещё раз, план рамы в памяти сессии.
  ox.noBlocks = false
  const support = ox.support = new Map()
  for (const i of [-2, 3]) for (let j = 0; j <= 3; j++) support.set(keyOf(g.F(i, j)), g.F(i, j - 1))
  support.set(keyOf(g.F(-1, 3)), g.F(-2, 3)); support.set(keyOf(g.F(2, 3)), g.F(3, 3))
  for (const q of [g.F(-2, -1), g.F(3, -1), g.B(0, -1), g.B(1, -1), g.at(-1, -1), g.at(2, -1), g.F(-2, 0), g.F(3, 0), g.F(-2, 1), g.F(3, 1)]) {
    if (late(ox)) break
    if (!(await placeOne(ox, q)) && q.y <= g.origin.y - 1) return dropPlan(ox, { ...report, built: false, stopped: `перемычка ${q.x},${q.y},${q.z} не встала — вода уйдёт` })
  }
}

function oneOwn (ox: OneCast) {
  const { g, g0 } = ox
  // Своё не копать: рама, опоры, стенки и дно жёлоба, пол берега, перемычки; столб под ногами.
  const own = ox.own = new Set()
  for (let i = -1; i <= 2; i++) for (const j of [-1, 0, 1, 2, 3]) if (!((i === 0 || i === 1) && j >= 0 && j <= 1)) own.add(keyOf(g.at(i, j)))
  for (const i of [-2, 3]) for (let j = -1; j <= 3; j++) own.add(keyOf(g.F(i, j)))
  for (let i = -2; i <= 3; i++) { own.add(keyOf(g.F(i, -2))); own.add(keyOf(g.G(i, -1))); own.add(keyOf(g.at(i, -2))) }
  for (const q of [g.F(-1, 3), g.F(2, 3), g.B(0, -1), g.B(1, -1)]) own.add(keyOf(q))
  ox.h = 0
  // Колонка столба: G(0), после сдвига (лавы со столба нет) — G(±1).
  ox.col = 0
  ox.pc = g0
}

async function oneResume (ox: OneCast) {
  const { session, ctl, bot, report, g } = ox
  // 3а. Лава в ведре (прошлый заход оборвался между лавой и водой): долить ею клетку, у которой вода ещё стоит в жёлобе,
  // иначе назад в озеро. Потом воду — в ведро.
  if (cnt(ox, 'lava_bucket') && !cnt(ox, 'water_bucket')) {
    let fixed = false
    for (const t of cells(g)) {
      if ((bot.blockAt(t.c) || {}).name === 'obsidian') continue
      const wb = bot.blockAt(t.w)
      if (!wb || !/water/.test(wb.name)) continue
      const lr = await pourInto(bot, 'lava_bucket', t.lava)
      if (lr.ok) {
        const tq = gameClock.now()
        while (gameClock.now() - tq < 800 && (bot.blockAt(t.c) || {}).name !== 'obsidian') await sleep(40)
        tr(ox, `лава из ведра → ${t.c.x},${t.c.y},${t.c.z}: ${(bot.blockAt(t.c) || {}).name}`)
        if ((bot.blockAt(t.c) || {}).name === 'obsidian') report.cast.push(xyz(t.c))
        fixed = true
        break
      }
    }
    if (!fixed) fixed = await dumpLava(ox)
    if (!cnt(ox, 'water_bucket')) await regainWater(ox)
    if (!cnt(ox, 'water_bucket') && cnt(ox, 'bucket')) await require('../obsidian').fillBucket(session, ctl, { fluid: 'water', radius: 32 })
    if (!cnt(ox, 'water_bucket')) return { ...report, built: false, stopped: cnt(ox, 'lava_bucket') ? 'в ведре лава — вылить некуда' : 'нет воды в ведре' }
  }
}

async function oneCells (ox: OneCast) {
  const { ctl, bot, report, g, g0, highDigs } = ox
  let stopped = null
  let wet = false
  for (const t of cells(g)) {
    const threat = hazard(ox, bot.entity.position)
    if (threat) { stopped = `CAST_UNSAFE: ${threat.name}`; break }
    if (late(ox)) { stopped = 'время вышло — позови ещё раз, продолжу с этой рамы'; break }
    if ((bot.blockAt(t.c) || {}).name === 'obsidian') { tr(ox, `${t.c.x},${t.c.y},${t.c.z}: obsidian`); continue }
    // Нижняя клетка, а тело на столбе (прошлый заход) — вниз.
    if (t.h === 0 && ox.h > 0) { await C().descend(bot, ctl, g0.y, report); syncH(ox) }
    if (t.h > ox.h) {
      // Наверх: столб 2 в G(0), стенки жёлоба j=2,3, после стоек — подпорки в проёме и уголки жёлоба.
      if (ox.h === 0) { await goG(ox, ox.col); await C().centreOn(bot, ctl, g.G(ox.col, 0)) }
      const w = await climb(ox, t.h)
      if (w) { stopped = w; break }
      // Со столба — расчистка верха (чаша озера ниже рельефа: жёлоб и рама выше земли — в породе; lab ow-c1c bowl).
      for (let pass = 0; pass < 2 && !late(ox); pass++) {
        let left = 0
        for (const q of highDigs) { const w2 = await digOne(ox, q); if (w2 && w2 !== 'не выкопано') { stopped = `расчистка верха: ${w2}`; break } if (w2) left++ }
        if (stopped || !left) break
      }
      if (stopped) break
      for (const q of [g.F(-2, 2), g.F(3, 2), g.F(-2, 3), g.F(3, 3)]) await placeOne(ox, q)
    }
    if (t.top) {
      for (const q of [g.at(0, 2), g.at(1, 2), g.F(-1, 3), g.F(2, 3)]) {
        if (!(await placeOne(ox, q))) { stopped = `подпорка ${q.x},${q.y},${q.z} не встала`; break }
      }
      if (stopped) break
    }
    let r = await castCell(ox, t)
    for (let k = 0; k < 2 && !r.ok && !r.fatal && !late(ox); k++) { tr(ox, `${t.c.x},${t.c.y},${t.c.z}: ${r.why} — ещё раз${bot._ndCast1Drop ? ` [${bot._ndCast1Drop}]` : ''}`); bot._ndCast1Drop = null; r = await castCell(ox, t) }
    // Лавы со столба нет — столб на соседнюю клетку берега (S8b 07.10: рамы 8/10–9/10 «лавы со столба не достать» — треть
    // таймаутов литья; верх рамы достаётся и из G(±1), а лава под ним — новые клетки озера). ND_CAST1_SHIFT=0 — выкл.
    while (!r.ok && r.fatal && /со столба|в досягаемости нет/.test(r.why) && !late(ox) && await shiftPillar(ox, t.h)) r = await castCell(ox, t)
    tr(ox, `${t.c.x},${t.c.y},${t.c.z}: ${r.ok ? `obsidian${r.dbg ? ` (${r.dbg})` : ''}` : r.why}`)
    if (!wet) { const sw = strayWater(ox); if (sw.length) { wet = true; tr(ox, `вода вне жёлоба: ${sw.slice(0, 6).join(' ')}${sw.length > 6 ? ` …всего ${sw.length}` : ''}`) } }
    if (!r.ok) { stopped = `клетка ${t.c.x},${t.c.y},${t.c.z}: ${r.why}`; break }
  }
  return stopped
}

async function oneFinish (ox: OneCast, stopped) {
  const { session, ctl, bot, t0, report, plan, g } = ox
  // 5. Подпорки из проёма долой, вниз со столба.
  if (!stopped) {
    for (const q of [g.at(0, 2), g.at(1, 2)]) {
      const b = bot.blockAt(q)
      if (b && !isAirB(b) && !fluid(b)) await digOne(ox, q)
    }
  }
  if (ox.h > 0) await C().descend(bot, ctl, g.G(0, 0).y, report)
  const frame = [g.at(0, -1), g.at(1, -1), g.at(-1, 0), g.at(-1, 1), g.at(-1, 2), g.at(2, 0), g.at(2, 1), g.at(2, 2), g.at(0, 3), g.at(1, 3)]
  const done = frame.filter(q => (bot.blockAt(q) || {}).name === 'obsidian').length
  const built = done === 10
  if (process.env.ND_OW_KIT_FRAME !== '0' && !built && !ctl.aborted && /лавы со столба не достать|лавы в досягаемости нет/.test(stopped || '')) {
    const current = sourceState1(bot, plan)
    if (current.short) session.castOneSourceFailure = { plan, key: current.key, report: { built: false, frame: current.frame, stopped } }
  }
  return { ...report, built, frame: `${done}/10 обсидиан`, seconds: Math.round((gameClock.now() - t0) / 1000), stopped: built ? undefined : (stopped || `рама не собралась: ${done}/10`),
    ...(!built && ox.noBlocks ? { need: { what: 'cobblestone', count: Math.max(1, materialNeed1(q => bot.blockAt(q), plan)), have: fill(ox) } } : {}) }
}

export async function castOne (session, ctl, p: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + Math.max(1, Math.min(600, p.timeoutSeconds || 420)) * 1000
  const report: any = { mode: 'one', cast: [], refills: 0, placed: 0, dug: 0, trace: [] }
  const ox: OneCast = { session, ctl, p, bot, t0, deadline, report }
  const firstThreat = hazard(ox, bot.entity.position)
  if (firstThreat) return { ...report, code: 'CAST_UNSAFE', hazard: firstThreat, built: false, stopped: `CAST_UNSAFE: ${firstThreat.name}` }
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} try { bot.clearControlStates() } catch {} })
  const buckets = cnt(ox, 'bucket') + cnt(ox, 'water_bucket') + cnt(ox, 'lava_bucket')
  if (buckets < 1) return { ...report, built: false, stopped: 'нужно ведро', need: { what: 'bucket', count: 1, have: 0 } }
  // Вода в ведре — с собой (одно ведро: её не из чего набрать у рамы, кроме своей же). С лавой в ведре (прошлый заход
  // оборвался) — разобраться у рамы, ниже.
  if (!cnt(ox, 'water_bucket') && !cnt(ox, 'lava_bucket')) {
    const r = await require('../obsidian').fillBucket(session, ctl, { fluid: 'water', radius: 32 })
    if (!(r && (r.filled || r.already)) && !cnt(ox, 'water_bucket')) return { ...report, built: false, stopped: 'нет воды в ведре (одно ведро: вода с собой)', need: { what: 'water_bucket', count: 1, have: 0 } }
  }
  const planned = await onePlan(ox)
  if (planned.ret) return planned.ret
  const plan = ox.plan = planned.plan
  session.castPlan1 = plan
  const g = ox.g = geomOf1(plan)
  const siteThreat = hazard(ox, g.G(0, 0))
  if (siteThreat) return { ...report, code: 'CAST_UNSAFE', hazard: siteThreat, built: false, stopped: `CAST_UNSAFE: ${siteThreat.name}` }
  report.site = { origin: plan.origin, axis: plan.axis, side: plan.side, lava: plan.lava }
  const failed = session.castOneSourceFailure
  if (process.env.ND_OW_KIT_FRAME !== '0' && failed?.plan === plan) {
    const current = sourceState1(bot, plan)
    if (current.short && current.key === failed.key) return { ...report, ...failed.report, frame: current.frame, retryBlocked: true, seconds: 0 }
    session.castOneSourceFailure = null
  }
  const materialNeed = materialNeed1(q => bot.blockAt(q), plan)
  if (fill(ox) < materialNeed) return { ...report, built: false, stopped: `на выбранную раму нужно блоков ${materialNeed}`, need: { what: 'cobblestone', count: materialNeed, have: fill(ox) } }
  const shore = await oneShore(ox)
  if (shore) return shore
  const cleared = await oneClear(ox)
  if (cleared) return cleared
  const barriers = await oneBarriers(ox)
  if (barriers) return barriers
  oneOwn(ox)
  const resumed = await oneResume(ox)
  if (resumed) return resumed
  // 4. Клетки.
  ox.used = new Set()
  ox.digKeys = new Set(plan.dig.map(q => `${q.x},${q.y},${q.z}`))
  // Высота по факту: прошлый заход мог оставить тело на своём столбе (rt-L3 слот 14: h считалось 0 — «луч к грани»).
  syncH(ox)
  ox.shifted = new Set([0])
  const stopped = await oneCells(ox)
  return oneFinish(ox, stopped)
}

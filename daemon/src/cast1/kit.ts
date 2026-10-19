'use strict'
// Литьё одним ведром (cast1.ts): состояние захода castOne (ox) и действия над ним — ход к берегу, копка, блоки, прицел, вода и лава, столб.
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep } from '../movement'
import { missingHarvestTool, equipBestTool } from '../items'
import { placeBlockAt, towerUp } from '../build'
import { C, DOWN, FILLER, PLACE1, SIDES4, UP, cells, fluid, isAirB, keyOf, solid, useAt } from './geometry'


// --------------------------------------------------------------- одно ведро: литьё
// Состояние одного захода castOne — объект ox (OneCast); прежние стрелки castOne — функции с ox первым аргументом,
// прежние фазы — oneWater/onePlan/oneShore/oneClear/oneBarriers/oneOwn/oneResume/oneCells/oneFinish.
export interface OneCast {
  session: any
  ctl: any
  p: any
  bot: any
  t0: number
  deadline: number
  report: any
  plan?: any
  g?: any
  g0?: any
  highDigs?: any[]
  noBlocks?: boolean
  support?: Map<string, any>
  own?: Set<string>
  h?: number
  col?: number
  pc?: any
  used?: Set<string>
  digKeys?: Set<string>
  shifted?: Set<number>
}

export function late (ox: OneCast) { return gameClock.now() > ox.deadline || ox.ctl.aborted }

export function hazard (ox: OneCast, at) { return process.env.ND_CAST1_SAFE === '0' ? null : require('../fauna').castHazard(ox.bot, at) }

export function tr (ox: OneCast, m) { const { report, t0 } = ox; report.trace.push(`${Math.round((gameClock.now() - t0) / 100) / 10}с ${m}`); if (report.trace.length > 60) report.trace.shift() }

export function cnt (ox: OneCast, n) { return C().countOf(ox.bot, n) }

export function fill (ox: OneCast) { return FILLER.reduce((n, x) => n + cnt(ox, x), 0) }

export function dropPlan (ox: OneCast, r) { const { session } = ox; session.castPlan1 = null; try { session.journal.patch(st => { if (st.places) delete st.places[PLACE1] }) } catch {}; return r }

export async function goG (ox: OneCast, i = 0) {
  const { ctl, bot, g } = ox
  const S = g.G(i, 0)
  const f = bot.entity.position.floored()
  if (f.x === S.x && f.z === S.z && f.y >= S.y && f.y <= S.y + 3) return true
  const ok = await C().walk(bot, ctl, new goals.GoalBlock(S.x, S.y, S.z), 20000, { clearance: true })
  if (ok && bot.entity.position.floored().equals(S)) return true
  // Соседняя клетка на том же уровне, проход свободен, а путь pathfinder'а не нашёлся (у лавы — s8-f3: «не встал на берег
  // -1,67,234» из -2,67,234) — шаг руками к центру клетки.
  const p0 = bot.entity.position.floored()
  const clear = [0, 1].every(j => { const b = bot.blockAt(S.offset(0, j, 0)); return !!b && b.boundingBox === 'empty' && !fluid(b) }) && solid(bot.blockAt(S.offset(0, -1, 0)))
  if (clear && p0.y === S.y && Math.abs(p0.x - S.x) + Math.abs(p0.z - S.z) === 1) { await C().centreOn(bot, ctl, S); return bot.entity.position.floored().equals(S) }
  return false
}

// 2. Расчистка снизу вверх (видимые грани; трава и снег — контуром).
export async function digOne (ox: OneCast, q) {
  const { session, bot, report } = ox
  const threat = hazard(ox, bot.entity.position)
  if (threat) return `CAST_UNSAFE: ${threat.name}`
  const b = bot.blockAt(q)
  if (!b || isAirB(b) || fluid(b)) return null
  // Своя рама (повторный заход) не копается.
  if (b.name === 'obsidian') return null
  // Огонь (лава поджигает траву у берега — rt-L2 слот 9: «клетка занята (fire): не выкопано») — потушить ударом; не
  // вышло — не беда: жидкость из ведра огонь заменяет.
  if (/^(fire|soul_fire)$/.test(b.name)) {
    try { await bot.dig(b, true) } catch {}
    await sleep(80)
    return /fire/.test((bot.blockAt(q) || {}).name || '') ? 'огонь не потушен' : null
  }
  const risk = C().digRisk(x => bot.blockAt(x), q)
  if (risk && !/жидкость сбоку/.test(risk)) return risk
  const problem = b.boundingBox === 'empty' ? null : missingHarvestTool(bot, b, session.mcData)
  if (problem) return problem
  try { await equipBestTool(bot, b); await C().digVisible(bot, b, 8000); report.dug++ } catch {}
  return isAirB(bot.blockAt(q)) ? null : 'не выкопано'
}

export async function placeOne (ox: OneCast, q, depth = 0) {
  const { bot, report, support } = ox
  if (solid(bot.blockAt(q))) return true
  let r = await placeBlockAt(bot, q, { steady: true, honest: true })
  if (!r.ok && depth < 4 && /не к чему прислонить/.test(String(r.reason)) && support.has(keyOf(q)) && await placeOne(ox, support.get(keyOf(q)), depth + 1)) {
    r = await placeBlockAt(bot, q, { steady: true, honest: true })
  }
  if (r.ok) { report.placed++; return true }
  if (/нечем строить|must be holding/.test(String(r.reason))) ox.noBlocks = true
  tr(ox, `не поставил ${q.x},${q.y},${q.z}: ${r.reason}`)
  return false
}

function isOwn (ox: OneCast, q) { return ox.own.has(keyOf(q)) || (q.x === ox.pc.x && q.z === ox.pc.z && q.y < ox.pc.y + ox.h) }

// Прицел в грань refs (жидкость ляжет в expect); луч упёрся в постороннее ближе грани — выкопать и ещё раз (rt-L1:
// невыкопанная клетка жёлоба, порода над берегом в пещере).
export async function aimClear (ox: OneCast, refs, expect) {
  const { bot } = ox
  let why = 'нет грани'
  for (let k = 0; k < 3; k++) {
    for (const [ref, face] of refs) { const a = C().aimFor(bot, ref, face, expect); if (a) return { aim: a } }
    const [ref, face] = refs[0]
    if (!solid(bot.blockAt(ref))) {
      if (!(await placeOne(ox, ref))) return { why: `опоры ${ref.x},${ref.y},${ref.z} нет` }
      continue
    }
    const c = ref.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
    const e = C().eyes(bot)
    const d = e.distanceTo(c)
    if (d > 4.4) return { why: `до грани ${Math.round(d * 10) / 10} бл. — не достать` }
    const l = C().landing(bot, c)
    if (!l) return { why: `луч к грани ${ref.x},${ref.y},${ref.z} — в пустоту` }
    const hit = l.hit
    why = `луч к грани ${ref.x},${ref.y},${ref.z} упирается в ${hit.x},${hit.y},${hit.z}`
    if (hit.equals(ref) || isOwn(ox, hit) || e.distanceTo(hit.offset(0.5, 0.5, 0.5)) > d + 0.3) return { why }
    const w = await digOne(ox, hit)
    if (w) return { why: `${why}: ${w}` }
    tr(ox, `луч: выкопал ${hit.x},${hit.y},${hit.z}`)
  }
  return { why }
}

// Вода в ведро из любого источника рядом (своя в жёлобе, легла не туда — rt-L1 слот 8 «вода не видна за 1.2 с»).
export async function regainWater (ox: OneCast) {
  const { bot } = ox
  if (cnt(ox, 'water_bucket')) return true
  if (!cnt(ox, 'bucket')) return false
  const me = C().eyes(bot)
  const e = me.floored()
  const cand = []
  for (let dx = -5; dx <= 5; dx++) {
    for (let dy = -5; dy <= 4; dy++) {
      for (let dz = -5; dz <= 5; dz++) {
        const q = e.offset(dx, dy, dz)
        const b = bot.blockAt(q)
        if (b && b.name === 'water' && C().levelOf(b) === 0) cand.push(q)
      }
    }
  }
  cand.sort((a, b) => a.offset(0.5, 0.5, 0.5).distanceTo(me) - b.offset(0.5, 0.5, 0.5).distanceTo(me))
  for (const q of cand.slice(0, 10)) {
    const aim = C().scoopAim(bot, q)
    if (!aim) continue
    await useAt(bot, aim, 'bucket')
    if (cnt(ox, 'water_bucket')) { tr(ox, `вода в ведро из ${q.x},${q.y},${q.z}`); return true }
    if (cnt(ox, 'lava_bucket')) return false
  }
  return false
}

// Лаву из ведра — назад в озеро: клетка озера без источника (воздух, текущая лава) с опорой под или сбоку.
export async function dumpLava (ox: OneCast) {
  const { bot, g } = ox
  if (!cnt(ox, 'lava_bucket')) return true
  for (let i = -4; i <= 5; i++) {
    for (const row of ['H', 'I', 'J', 'K']) {
      for (const dy of [-1, -2]) {
        const q = g[row](i, dy)
        const b = bot.blockAt(q)
        if (!b || !(isAirB(b) || (b.name === 'lava' && C().levelOf(b) !== 0))) continue
        for (const [ref, face] of [[q.offset(0, -1, 0), UP], ...SIDES4.map(v => [q.minus(v), v])]) {
          if (!solid(bot.blockAt(ref))) continue
          const aim = C().aimFor(bot, ref, face, q)
          if (aim && await useAt(bot, aim, 'lava_bucket')) { tr(ox, `лава назад в озеро ${q.x},${q.y},${q.z}`); return true }
        }
      }
    }
  }
  return false
}

// Со столба лавы по лучу нет, а по расстоянию есть — выкопать то, что закрывает луч (порода над озером в пещере), если
// рядом с ним нет лавы (вскрыть озеро сбоку — нельзя).
export async function clearLavaRay (ox: OneCast) {
  const { bot, g, used } = ox
  const e = C().eyes(bot)
  const cands = []
  for (let i = -4; i <= 5; i++) {
    for (const row of ['H', 'I', 'J', 'K']) {
      for (const dy of [-1, -2]) {
        const p = g[row](i, dy)
        const b = bot.blockAt(p)
        if (!b || b.name !== 'lava' || C().levelOf(b) !== 0 || used.has(keyOf(p)) || !isAirB(bot.blockAt(p.plus(UP)))) continue
        const P = p.offset(0.5, 0.8, 0.5)
        if (e.distanceTo(P) <= 4.3) cands.push({ p, P, d: e.distanceTo(P) })
      }
    }
  }
  cands.sort((a, b) => a.d - b.d)
  for (const c of cands.slice(0, 4)) {
    for (let k = 0; k < 3 && !late(ox); k++) {
      if (C().scoopAim(bot, c.p)) return true
      const d = c.P.minus(e)
      const n = Math.ceil(d.norm() / 0.08)
      let hit = null
      let last = null
      for (let m = 1; m < n; m++) {
        const q = e.plus(d.scaled(m / n)).floored()
        if (last && q.equals(last)) continue
        last = q
        if (q.equals(c.p)) break
        const b = bot.blockAt(q)
        if (b && b.boundingBox === 'block' && !fluid(b)) { hit = q; break }
      }
      if (!hit || isOwn(ox, hit)) break
      if ([...SIDES4, UP, DOWN].some(v => /lava/.test((bot.blockAt(hit.plus(v)) || {}).name || ''))) break
      const w = await digOne(ox, hit)
      if (w) break
      tr(ox, `луч к лаве ${c.p.x},${c.p.y},${c.p.z}: выкопал ${hit.x},${hit.y},${hit.z}`)
    }
  }
  return false
}

export function syncH (ox: OneCast) { const f = ox.bot.entity.position.floored(); ox.h = (f.x === ox.pc.x && f.z === ox.pc.z) ? Math.max(0, f.y - ox.pc.y) : 0 }

export async function climb (ox: OneCast, want) {
  const { ctl, bot, report } = ox
  let fails = 0
  while (ox.h < want && !late(ox)) {
    await C().dryFeet(bot, ctl, 2500)
    // Потолок над головой (клетка столба не выкопалась с земли) — выкопать до прыжка.
    const f0 = bot.entity.position.floored()
    const hd = bot.blockAt(f0.offset(0, 2, 0))
    if (hd && hd.boundingBox === 'block' && !fluid(hd) && !isOwn(ox, hd.position)) await digOne(ox, hd.position)
    const t = await towerUp(bot, ctl, 1, { sneak: true })
    report.placed += t.placed || 0
    await sleep(120)
    syncH(ox)
    if (t.placed) continue
    const why = (t.why || []).join('; ') || t.reason || '?'
    if (++fails >= 3) return `столб не вырос (${why})`
    tr(ox, `столб: ${why} — ещё раз`)
    const f = bot.entity.position.floored()
    const head = bot.blockAt(f.offset(0, 2, 0))
    if (head && !isAirB(head) && !fluid(head) && !isOwn(ox, head.position)) await digOne(ox, head.position)
    await C().centreOn(bot, ctl, f)
  }
  return ox.h >= want ? null : 'время вышло на столбе'
}

export function topLeft (ox: OneCast) { const { bot, g } = ox; return cells(g).filter(t => t.h > 0 && (bot.blockAt(t.c) || {}).name !== 'obsidian').length }

// Вода вне жёлоба (берег, над озером, за рамой): где и какая — для разбора.
export function strayWater (ox: OneCast) {
  const { bot, g } = ox
  const out = []
  for (let i = -3; i <= 4; i++) {
    for (let j = -1; j <= 4; j++) {
      for (const q of [g.G(i, j), g.H(i, j), g.I(i, j), g.B(i, j), g.at(i, j)]) {
        const b = bot.blockAt(q)
        if (b && /water/.test(b.name)) out.push(`${q.x},${q.y},${q.z}(${C().levelOf(b)})`)
      }
    }
  }
  return out
}

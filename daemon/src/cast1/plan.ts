'use strict'
// Литьё одним ведром (cast1.ts): выбор места на берегу (judge1/plan1), тело лавы, материалы, клетки места, лава в досягаемости.
import { Vec3 } from 'vec3'
import { xyz } from '../movement'
import { AX, C, DOWN, FALL, SIDES4, UP, cells, fluid, geom1, geomOf1, isAirB, keyOf, lakeReach, shiftOn, solid } from './geometry'


// Оценка места. read(p) — блок или null. Возвращает { plan } или { why }.
// Вердикт judge1: why — отказ, plan — рама у озера.
interface Judge1 { why?: string; plan?: { axis: any; side: any; origin: any; dig: any[]; place: any[]; lava: number; high: number; high0: number; score: number } }
export function judge1 (read, g, { me = null, maxDig = 40 }: any = {}): Judge1 {
  const dig = []
  const place = []
  const bad = why => ({ why })
  const blockAt = p => read(p)
  const need = (p, ok, why) => { const b = blockAt(p); if (!b) return 'чанк не прогружен'; return ok(b) ? null : why }
  // Озеро за берегом: источники с воздухом сверху В ДОСЯГАЕМОСТИ черпака — с земли на 6 нижних клеток, со столба на 4
  // верхние, всего 10 + 1 запас (rt-L1: «лавы у берега 18», а достать с G(0) — 6–7, дальние ряды J/K не в счёт;
  // со столба лавы нет — вниз с водой в жёлобе нельзя, она растекается).
  const cols = shiftOn() ? [0, 1, -1] : [0]
  const R = lakeReach(read, g, { cols })
  const union = new Set([...R.ground, ...R.top])
  const lava = union.size
  const high = R.top.size
  const sourcesNeeded = process.env.ND_OW_KIT_FRAME === '0' ? 11 : 10
  if (R.ground.size < 6 || high < 4 || lava < sourcesNeeded) return bad(`лавы в досягаемости: с земли ${R.ground.size}, со столба ${high}, всего ${lava}`)
  // Берег: пол G(i,-1) твёрдый и не сыпучий (сыпучий, если держится); над ним 2 (у G(0) — 5) воздуха.
  for (let i = -1; i <= 2; i++) {
    const fl = blockAt(g.G(i, -1))
    if (!fl) return bad('чанк не прогружен')
    // Пол берега не под телом — воздух/трава над твёрдым: поставить блок (S8b 07.10: «берег не твёрдый» — частая причина
    // «места на берегу нет» в s8-f2..f4). ND_CAST1_SHORE=0 — выкл.
    const under = blockAt(g.G(i, -2))
    if (i !== 0 && !solid(fl) && !/water/.test(fl.name) && (isAirB(fl) || fl.boundingBox === 'empty') && under && solid(under) && process.env.ND_CAST1_SHORE !== '0') place.push(g.G(i, -1))
    else if (!solid(fl) || (FALL.test(fl.name) && !solid(blockAt(g.G(i, -2))))) return bad('берег не твёрдый')
    // Над берегом: столб G(0) — 5 воздуха; G(±1) — 4: со столба луч воды к стенкам жёлоба F(−2,2)/F(3,2) и опорам
    // F(−1,3)/F(2,3) идёт через G(−1,3)/G(1,3) (rt-L1, пещеры 11/27/28: «луч к грани … упирается в G(−1,3)»).
    const hmax = i === 0 ? 4 : (i === 2 ? 1 : 3)
    for (let j = 0; j <= hmax; j++) {
      const b = blockAt(g.G(i, j))
      if (!b) return bad('чанк не прогружен')
      if (fluid(b)) return bad('жидкость на берегу')
      if (!isAirB(b)) { if (b.boundingBox === 'block') dig.push(g.G(i, j)); else dig.push(g.G(i, j)) }
    }
  }
  // Дно жёлоба и пол рамы — твёрдые.
  for (let i = -1; i <= 2; i++) { const w = need(g.F(i, -2), b => solid(b), 'нет дна жёлоба'); if (w) return bad(w) }
  for (let i = 0; i <= 1; i++) { const w = need(g.at(i, -2), b => solid(b), 'нет пола рамы'); if (w) return bad(w) }
  // Перемычки, которые держат воду в жёлобе на уровне y0: концы жёлоба, пол берега (выше), углы рамы, за низом рамы.
  for (const p of [g.F(-2, -1), g.F(3, -1), g.B(0, -1), g.B(1, -1)]) {
    const b = blockAt(p)
    if (!b) return bad('чанк не прогружен')
    if (fluid(b)) return bad('жидкость у жёлоба')
    if (!solid(b)) place.push(p)
  }
  for (const p of [g.at(-1, -1), g.at(2, -1)]) {
    const b = blockAt(p)
    if (!b) return bad('чанк не прогружен')
    if (fluid(b)) return bad('жидкость в углу рамы')
    if (!solid(b) || FALL.test(b.name)) { if (!isAirB(b) && b.boundingBox !== 'empty') dig.push(p); place.push(p) }
  }
  // Жёлоб F(i,-1..4), рама и проём at(i,-1..3) (кроме углов) — воздух; стенки жёлоба F(-2,0..3), F(3,0..3) — блоки.
  for (let i = -1; i <= 2; i++) {
    for (let j = -1; j <= 4; j++) {
      const p = g.F(i, j)
      const b = blockAt(p)
      if (!b) return bad('чанк не прогружен')
      if (fluid(b)) return bad('жидкость в жёлобе')
      if (!isAirB(b)) dig.push(p)
    }
    for (let j = -1; j <= 3; j++) {
      if ((i === -1 || i === 2) && (j === -1 || j === 3)) continue
      const p = g.at(i, j)
      const b = blockAt(p)
      if (!b) return bad('чанк не прогружен')
      if (fluid(b)) return bad('жидкость в раме')
      if (b.name === 'obsidian' || /chest|portal|bedrock/.test(b.name)) return bad(`в раме ${b.name}`)
      if (!isAirB(b)) dig.push(p)
    }
  }
  for (const i of [-2, 3]) {
    for (let j = 0; j <= 3; j++) {
      const p = g.F(i, j)
      const b = blockAt(p)
      if (!b) return bad('чанк не прогружен')
      if (fluid(b)) return bad('жидкость у стенки жёлоба')
      if (!solid(b)) place.push(p)
    }
  }
  if (dig.length > maxDig) return bad(`копать ${dig.length}`)
  // Лава по лучу — с учётом того, что будет выкопано.
  const R2 = lakeReach(read, g, { rays: true, dig: new Set(dig.map(keyOf)), cols })
  const union2 = new Set([...R2.ground, ...R2.top])
  if (R2.ground.size < 6 || R2.top.size < 4 || union2.size < sourcesNeeded) return bad(`лава за породой: по лучу с земли ${R2.ground.size}, со столба ${R2.top.size}, всего ${union2.size}`)
  // Без сдвига столба — дешевле: верх из G(0).
  const top0 = cols.length > 1 ? lakeReach(read, g, { rays: true, dig: new Set(dig.map(keyOf)) }).top.size : R2.top.size
  // Копка рядом с жидкостью и под сыпучим — нельзя (то же чутьё, что у cast.js).
  const placed = new Set(place.map(keyOf))
  for (const p of dig) {
    const r = C().digRisk(read, p)
    if (r && !/жидкость сбоку/.test(r)) return bad(r)
    // Сбоку жидкость — только если это не наша будущая вода/лава озера: у клетки жёлоба сосед — пол берега, не лава.
    for (const v of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), UP]) {
      const n = blockAt(p.plus(v))
      if (n && /lava/.test(n.name) && !placed.has(keyOf(p.plus(v)))) return bad('лава у клетки копки')
    }
  }
  const score = dig.length * 2 + place.length * 3 - union2.size - Math.min(top0, 6) * 3 - Math.min(R2.top.size - top0, 3) + (me ? Math.round(g.G(0, 0).distanceTo(me)) : 0)
  return { plan: { axis: g.axis, side: g.side, origin: xyz(g.origin), dig: dig.map(xyz), place: place.map(xyz), lava: union2.size, high: R2.top.size, high0: top0, score } }
}

// Места у берега: для каждого открытого источника лавы L и направления p — рамы, у которых L в H/I-ряду.
export function plan1 (bot, lavaCells, { maxCand = 60, maxDig = 40 }: any = {}) {
  const read = p => bot.blockAt(p)
  const me = bot.entity.position
  let best = null
  const why = new Map()
  const seen = new Set()
  for (const L of lavaCells.slice(0, maxCand)) {
    for (const axis of ['x', 'z']) {
      for (const side of [1, -1]) {
        for (let k = -1; k <= 2; k++) {
          // H(k,-1) = L → at(k,-1) = L − 3p → O = at(0,0) = L − 3p − k·u + UP.
          const perp = axis === 'x' ? AX.z : AX.x
          const u = AX[axis]
          const O = L.offset(-perp.x * side * 3 - u.x * k, 1, -perp.z * side * 3 - u.z * k)
          const key = `${O.x},${O.y},${O.z},${axis},${side}`
          if (seen.has(key)) continue
          seen.add(key)
          const g = geom1(O, axis, side)
          const r: any = judge1(read, g, { me, maxDig })
          if (r.why) { why.set(r.why, (why.get(r.why) || 0) + 1); continue }
          if (!best || r.plan.score < best.score) best = r.plan
        }
      }
    }
  }
  if (best) return { ok: true, plan: best }
  return { ok: false, reasons: [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} (${n})`) }
}

// Открытые сверху источники тела лавы у клетки hint (±2), по связности, до cap клеток.
export function lavaBodyOpen (bot, hint, { cap = 1500, limit = 80 }: any = {}) {
  const key = p => `${p.x},${p.y},${p.z}`
  const seen = new Set()
  const q = []
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
    const p = hint.offset(dx, dy, dz)
    const b = bot.blockAt(p)
    if (b && b.name === 'lava' && !seen.has(key(p))) { seen.add(key(p)); q.push(p) }
  }
  const out = []
  for (let i = 0; i < q.length && seen.size < cap; i++) {
    const p = q[i]
    const b = bot.blockAt(p)
    if (b && C().levelOf(b) === 0 && isAirB(bot.blockAt(p.plus(UP)))) out.push(p)
    for (const v of [...SIDES4, UP, DOWN]) {
      const n = p.plus(v)
      if (seen.has(key(n))) continue
      const nb = bot.blockAt(n)
      if (nb && nb.name === 'lava') { seen.add(key(n)); q.push(n) }
    }
  }
  const me = bot.entity.position
  return out.sort((a, b) => a.distanceTo(me) - b.distanceTo(me)).slice(0, limit)
}

// Источники у берега (сосед на том же уровне — твёрдый не-лава блок) — вперёд, порядок внутри групп сохраняется.
export function shoreFirst (bot, lava) {
  const edge = p => SIDES4.some(v => { const n = bot.blockAt(p.plus(v)); return !!n && n.name !== 'lava' && solid(n) })
  return [...lava.filter(edge), ...lava.filter(q => !edge(q))]
}

export function materialNeed1 (read, plan) {
  const g = geomOf1(plan)
  const required = new Map([g.F(-2, -1), g.F(3, -1), g.B(0, -1), g.B(1, -1), g.at(-1, -1), g.at(2, -1),
    g.F(-2, 0), g.F(3, 0), g.F(-2, 1), g.F(3, 1), g.G(-1, -1), g.G(1, -1), g.G(2, -1)].map(q => [keyOf(q), q]))
  const cleared = new Set(plan.dig.map(keyOf))
  if (cells(g).some(t => t.h > 0 && (read(t.c) || {}).name !== 'obsidian')) {
    for (const q of [g.F(-2, 2), g.F(3, 2), g.F(-2, 3), g.F(3, 3), g.at(0, 2), g.at(1, 2), g.F(-1, 3), g.F(2, 3), g.G(0, 0), g.G(0, 1)]) required.set(keyOf(q), q)
  }
  // Clearing can supply drops; only carried material and standing supports are confirmed.
  return [...required.values()].filter(q => cleared.has(keyOf(q)) || !solid(read(q))).length
}

// Resource gathering must not recycle a frame that casting will resume. This
// footprint is our own plan, not a terrain scan; cells() supplies the casting
// faces, with the same shore props and climbing columns used below.
export function siteCells1 (plan) {
  const own = new Set<string>()
  if (!plan?.origin || !['x', 'z'].includes(plan.axis) || ![-1, 1].includes(plan.side) ||
      !['x', 'y', 'z'].every(k => Number.isInteger(plan.origin[k]))) return own
  const g = geomOf1(plan)
  const keep = q => own.add(keyOf(q))
  for (const t of cells(g)) {
    keep(t.c); keep(t.w)
    for (const [ref] of [...t.water, ...t.lava]) keep(ref)
  }
  for (const i of [-2, 3]) for (let j = -1; j <= 3; j++) keep(g.F(i, j))
  for (let i = -2; i <= 3; i++) { keep(g.F(i, -2)); keep(g.at(i, -2)); keep(g.G(i, -1)) }
  for (const i of [0, 1]) keep(g.B(i, -1))
  for (const i of [-1, 0, 1]) for (const j of [0, 1]) keep(g.G(i, j))
  for (const i of [-1, 1, 2]) for (let j = -2; j >= -4; j--) keep(g.G(i, j))
  for (const q of plan.place || []) keep(q)
  return own
}

// Лава в досягаемости черпака отсюда: источник с воздухом сверху, луч черпака есть. С земли — сперва дальние (ряды
// I…K и края H): ближние к столбу H(−2..2), I(0) — запас на верхние клетки, со столба 2 до других не достать
// (lab ow-c1a: 8/10 — «лавы в досягаемости нет» на верхней клетке, ближнюю лаву вычерпали с земли).
// Запас — источники, досягаемые со столба (lakeReach.top, живьём); с земли из запаса берётся не больше, чем его
// останется сверх keep — числа ещё не отлитых верхних клеток.
export function lavaInReach (bot, g, avoid = new Set(), { high = false, keep = 0, dig = null }: any = {}) {
  const free = []
  const res = []
  const me = C().eyes(bot)
  // Запас по лучу с учётом ещё не выкопанного верха (G(±1,2..3) копаются со столба): без этого лава «за невыкопанным»
  // уходила на нижние клетки, а со столба её потом не было (rt-L3, пещеры 10/11/13/27: рамы 8–9/10, «со столба 1»).
  const reserve = high ? new Set() : new Set([...lakeReach(p => bot.blockAt(p), g, { rays: true, dig }).top].filter(k => process.env.ND_CAST1_RESERVE === '0' || !avoid.has(k)))
  for (let i = -4; i <= 5; i++) {
    for (const row of ['H', 'I', 'J', 'K']) {
      if (!g[row]) continue
      for (const dy of [-1, -2]) {
        const p = g[row](i, dy)
        const k = keyOf(p)
        if (avoid.has(k)) continue
        const b = bot.blockAt(p)
        if (!b || b.name !== 'lava' || C().levelOf(b) !== 0) continue
        if (!isAirB(bot.blockAt(p.plus(UP)))) continue
        const aim = C().scoopAim(bot, p)
        if (!aim) continue
        ;(reserve.has(k) ? res : free).push({ p, aim, d: p.offset(0.5, 0.5, 0.5).distanceTo(me) })
      }
    }
  }
  free.sort((a, b) => a.d - b.d)
  // Из запаса — дальние от столба первыми не выйдет (запас и так ближний): по расстоянию, но не больше лишка.
  res.sort((a, b) => b.d - a.d)
  const spare = Math.max(0, reserve.size - keep)
  return [...free, ...res.slice(0, spare)]
}

// Налить из полного ведра в клетку target — через первую подходящую грань из списка refs.
export async function pourInto (bot, full, refs) {
  let last = null
  for (const [ref, face] of refs) {
    const r = await C().pour(bot, full, ref, face)
    if (r.ok) return r
    last = r
  }
  return last || { ok: false, why: 'нет грани' }
}

'use strict'
// Литьё портала (cast.ts): выбор места рамы у лавы, план литья, продолжение начатой рамы, слух лавы и воды.
import { xyz } from '../movement'
import { missingHarvestTool } from '../items'
import { visibleOf } from '../sight'
import {
  FALLING, LAVA_FAR, LAVA_KEEP, MAX_DIG, PROTECTED, UP, clearanceKeys, countOf, digRisk, frameKeys, geom, geomOf,
  hasFluid, isAir, isEmptyish, isSolid, levelOf, steadyFloor
} from './base'


// ---------------------------------------------------------------- план места

// Одна площадка целиком. Возвращает { plan } или { why }.
// maxDig — сколько клеток можно выкопать под место (поверху 48; глубоко в штреке место копается почти целиком —
// рама 18 + ряд перед ней 20, там больше); keep — ближе этого к лаве рабочее место не ставить (глубоко — дальше:
// вода по полу штрека дотекает до окна к лаве и стелет его обсидианом).
export function judge (read, g, lava, me, { maxDig = MAX_DIG, keep = LAVA_KEEP, canDig = null }: any = {}) {
  const dig = []
  const corners = []
  const need = (p, why) => { const b = read(p); if (!b) return { why: 'чанк не прогружен' }; return { b, why } }
  // Проём, рама, углы: всё, что не угол, должно стать воздухом.
  for (let i = -1; i <= 2; i++) {
    for (let j = -1; j <= 3; j++) {
      const p = g.at(i, j)
      const b = read(p)
      if (!b) return { why: 'чанк не прогружен' }
      if (/water|lava/.test(b.name)) return { why: 'жидкость в раме' }
      if (PROTECTED.test(b.name) || b.name === 'obsidian') return { why: `в раме ${b.name}` }
      const bottomCorner = (i === -1 || i === 2) && j === -1
      if (bottomCorner) {
        // Нижний угол — опора стойки: годится свой твёрдый не-сыпучий камень.
        if (isSolid(b) && !FALLING.test(b.name)) continue
        if (!isEmptyish(b)) dig.push(p)
        corners.push(p)
        continue
      }
      // Только воздух: трава, цветы, снег ловят луч ведра (у сервера он по
      // OUTLINE), и лава легла бы клеткой выше.
      if (!isAir(b)) dig.push(p)
    }
  }
  // Пол под низом рамы и под нижними углами — твёрдый: на него льётся лава
  // низа и опирается булыжник углов.
  for (const i of [-1, 0, 1, 2]) {
    const b = read(g.at(i, -2))
    if (!b) return { why: 'чанк не прогружен' }
    if (!steadyFloor(read, g.at(i, -2))) return { why: 'под низом рамы нет твёрдого пола' }
  }
  // Ряд перед рамой: пол твёрдый, над ним до j=4 — воздух (столб до j=2,
  // тело на нём до j=3, голова j=4). j=5 — без жидкости, воздухом быть не обязан: прыжок со столба h=2 упирается
  // в него на высоте ног +1.2 (потолок y+6, рост 1.8), а блок под ноги встаёт уже с +1.0 (build.towerUp смотрит
  // только клетку над головой). Раньше j=5 копался тоже — глубоко до него не достать с пола (4.9 бл. от глаз), и
  // pathfinder строил к нему столбы булыжника прямо в ряду перед рамой: «столб не вырос (потолок cobblestone)».
  for (let i = -1; i <= 2; i++) {
    const fl = read(g.F(i, -2))
    if (!fl) return { why: 'чанк не прогружен' }
    if (!steadyFloor(read, g.F(i, -2))) return { why: 'перед рамой нет твёрдого пола' }
    for (let j = -1; j <= 5; j++) {
      const b = read(g.F(i, j))
      if (!b) return { why: 'чанк не прогружен' }
      if (/water|lava/.test(b.name)) return { why: 'жидкость перед рамой' }
      if (j === 5) { if (FALLING.test(b.name)) return { why: 'над рядом перед рамой гравий или песок' }; continue }
      if (PROTECTED.test(b.name)) return { why: `перед рамой ${b.name}` }
      if (!isAir(b)) dig.push(g.F(i, j))
    }
  }
  if (dig.length > maxDig) return { why: `копать ${dig.length} клеток` }
  for (const p of dig) {
    const risk = digRisk(read, p)
    if (risk) return { why: risk }
    // Руда не по нашей кирке (золото, редстоун, алмаз у дна — каменной не ломаются): место не годится (ow-L3 02.10,
    // слот 12: «расчистить место: для deepslate_gold_ore нужна кирка получше»).
    if (canDig) { const b = read(p); if (b && b.boundingBox === 'block' && !canDig(b)) return { why: `копать нечем: ${b.name}` } }
  }
  // Лава не ближе LAVA_KEEP к рабочему месту, но и не дальше LAVA_FAR.
  const work = []
  for (let i = -1; i <= 2; i++) for (let j = -1; j <= 4; j++) { work.push(g.at(i, j)); work.push(g.F(i, j)) }
  let nearest = Infinity
  for (const l of lava) {
    for (const w of work) {
      const d = Math.max(Math.abs(l.x - w.x), Math.abs(l.y - w.y), Math.abs(l.z - w.z))
      if (d < keep) return { why: `лава в ${d} бл. от места` }
    }
    nearest = Math.min(nearest, l.distanceTo(g.at(0, 0)))
  }
  if (nearest > LAVA_FAR) return { why: 'лава далеко' }
  // Сверху не должно сыпаться: гравий над проёмом упадёт в раму, над рядом
  // перед ней — на голову, когда столб дорастёт.
  for (let i = -1; i <= 2; i++) {
    const b = read(g.at(i, 4))
    if (b && FALLING.test(b.name)) return { why: 'над рамой гравий или песок' }
    const f = read(g.F(i, 6))
    if (f && FALLING.test(f.name)) return { why: 'над рядом перед рамой гравий или песок' }
  }
  return {
    plan: {
      axis: g.axis,
      side: g.side,
      origin: xyz(g.origin),
      dig: dig.sort((a, b) => b.y - a.y).map(xyz),
      corners: corners.map(xyz),
      lavaDist: Math.round(nearest),
      score: dig.length * 2 + corners.length + Math.round(nearest) + 3 * Math.round(g.origin.distanceTo(me))
    }
  }
}

export function planCast (bot, lava, { radius = 7, maxDig = MAX_DIG, keep = LAVA_KEEP, groundY = null, mcData = null }: any = {}) {
  const canDig = mcData ? (b => !missingHarvestTool(bot, b, mcData)) : null
  const read = p => bot.blockAt(p)
  const me = bot.entity.position.floored()
  let best = null
  const why = new Map()
  for (let dy = 2; dy >= -3; dy--) {
    if (groundY !== null && me.y + dy - 1 !== groundY) continue
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (const axis of ['x', 'z']) {
          for (const side of [1, -1]) {
            const g = geom(me.offset(dx, dy, dz), axis, side)
            const r = judge(read, g, lava, me, { maxDig, keep, canDig })
            if (r.why) { why.set(r.why, (why.get(r.why) || 0) + 1); continue }
            if (!best || r.plan.score < best.score) best = r.plan
          }
        }
      }
    }
  }
  if (best) return { ok: true, plan: best }
  const ranked = [...why.entries()].sort((a, b) => b[1] - a[1])
  return { ok: false, reasons: ranked.slice(0, 3).map(([w, n]) => `${w} (${n})`) }
}

// Keep the observed partial frame when changing the bucket layout.
export function resumeOnePlan (session, { maxDig = MAX_DIG, windows = false }: any = {}) {
  const bot = session.bot
  if (bot.game?.dimension !== 'overworld') return null
  const rec = session.journal.state?.places?.[(require('../cast1') as typeof import('../cast1')).PLACE1]
  const one = session.castPlan1 || (rec && (rec.dimension || 'overworld') === 'overworld'
    ? { origin: { x: rec.x, y: rec.y, z: rec.z }, axis: rec.axis, side: rec.side } : null)
  if (!one || !['x', 'z'].includes(one.axis) || ![-1, 1].includes(one.side) ||
      !['x', 'y', 'z'].every(k => Number.isInteger(one.origin?.[k]))) return null
  const g = geomOf(one), read = p => bot.blockAt(p)
  if (g.at(0, 0).distanceTo(bot.entity.position) > 24) return null
  const frame = new Set(frameKeys(g).map(p => p.toString()))
  if (!frameKeys(g).some(p => read(p)?.name === 'obsidian')) return null
  for (let i = -1; i <= 2; i++) {
    if (!steadyFloor(read, g.at(i, -2)) || !steadyFloor(read, g.F(i, -2))) return null
    for (const p of [g.at(i, 4), g.F(i, 6)]) {
      const b = read(p)
      if (!b || hasFluid(b) || FALLING.test(b.name)) return null
    }
  }
  const dig = []
  for (const p of clearanceKeys(g)) {
    const b = read(p)
    if (!b || hasFluid(b)) return null
    if (b.name === 'obsidian' && frame.has(p.toString())) continue
    if (isAir(b)) continue
    if (digRisk(read, p)) return null
    dig.push(xyz(p))
  }
  if (dig.length > maxDig) return null
  return { origin: xyz(g.origin), axis: g.axis, side: g.side, dig,
    corners: [xyz(g.at(-1, -1)), xyz(g.at(2, -1))], lavaAt: [], windows: !!windows }
}

export function refillState (bot, plan) {
  const frame = frameKeys(geomOf(plan)).map(p => (bot.blockAt(p) || {}).name || '?')
  const visible = lavaSources(bot, 28).map(b => b.position.toString()).sort()
  const carried = countOf(bot, 'lava_bucket')
  return { frame: `${frame.filter(n => n === 'obsidian').length}/10 обсидиан`, empty: !visible.length && !carried,
    key: JSON.stringify([plan.origin, plan.axis, plan.side, bot.entity.position.floored().toString(), frame, visible, carried, countOf(bot, 'water_bucket')]) }
}

// ---------------------------------------------------------------- вёдра

// Видимые источники лавы. Через sight.visibleOf: ближние клетки могут быть за стеной.
export function lavaSources (bot, radius = 24) {
  const id = bot.registry.blocksByName.lava.id
  const me = bot.entity.position
  // Только источник, открытый сверху (воздух над ним): луч зрения проходит сквозь лаву (у неё пустая коробка), и
  // «видимым» оказывался источник под потолком за первым — черпать его неоткуда (ow-M1 02.10: «видно 1» — источник
  // в 3 клетках за окном под камнем, «не дошёл»).
  // ND_CAST_SRC_SKIP=1 — текущая лава и источник под крышей отсеиваются до потолка max/rays: 80 ближних видимых клеток текущей
  // лавы (лавопад, край озера) иначе вытесняли дальний открытый источник (Codex A 21.10: «не вижу лавы-источника» ×134).
  const usable = b => b && levelOf(b) === 0 && isAir(bot.blockAt(b.position.plus(UP)))
  const skip = process.env.ND_CAST_SRC_SKIP === '1' ? p => !usable(bot.blockAt(p)) : null
  return visibleOf(bot, [id], radius, { max: 80, rays: 1500, skip })
    .filter(usable)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

// Слух. Клиент игры сам, без пакетов сервера, раз в тик перебирает случайные клетки в 16 и 32 бл. вокруг игрока
// (ClientLevel.animateTick) и у лавы, над которой воздух, с вероятностью 1/100 пускает «бульк» (LAVA_POP) и 1/200 —
// гул (LAVA_AMBIENT), громкость 0.2–0.4 — слышно до 16 бл. (LavaFluid.animateTick, клиентский код 1.21; на сервере
// его нет — сверено по памяти о клиенте, не по jar сервера). Человек под землёй так и находит лаву: «слышу
// бульканье справа». Здесь — то же: лава с воздухом над ней в radius от головы; наружу отдаётся только
// направление (сторона света по главной оси, выше/ниже) и дальность, округлённая до 2 бл., — не клетка.
export function hearLava (bot, { radius = 16 }: any = {}) {
  const head = bot.entity.position.offset(0, 1.62, 0)
  const c = head.floored()
  const r = Math.ceil(radius)
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue
      for (let dy = -r; dy <= r; dy++) {
        const p = c.offset(dx, dy, dz)
        const b = bot.blockAt(p)
        if (!b || b.name !== 'lava') continue
        const up = bot.blockAt(p.plus(UP))
        if (!isAir(up)) continue
        const d = p.offset(0.5, 0.5, 0.5).distanceTo(head)
        if (d > radius) continue
        if (!best || d < best.d) best = { p, d }
      }
    }
  }
  if (!best) return []
  const v = best.p.offset(0.5, 0.5, 0.5).minus(head)
  const dir = Math.abs(v.x) >= Math.abs(v.z) ? (v.x >= 0 ? 'east' : 'west') : (v.z >= 0 ? 'south' : 'north')
  // height — высота звука над глазами, округлённая до 2 (как дальность): оценка «выше/ниже» без sqrt двух округлённых
  // чисел (Codex ow-review1: ошибка той оценки до 7 бл.).
  return [{ dir, dist: Math.round(best.d / 2) * 2, flat: Math.round(Math.hypot(v.x, v.z) / 2) * 2, height: Math.round(v.y / 2) * 2, below: v.y < -1, above: v.y > 2 }]
}

// Слух воды. WaterFluid.animateTick (клиент 1.21): текущая вода, не падающая, раз в 64 тика шумит (WATER_AMBIENT,
// громкость 0.75–1.0 — до 16 бл.); источник и водопад молчат. Под землёй это ручьи от родников в стенах пещер — у них
// рядом источник. Наружу — сторона света, дальность до 2 бл., выше/ниже.
export function hearWater (bot, { radius = 16 }: any = {}) {
  const head = bot.entity.position.offset(0, 1.62, 0)
  const c = head.floored()
  const r = Math.ceil(radius)
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue
      for (let dy = -r; dy <= r; dy++) {
        const p = c.offset(dx, dy, dz)
        const b = bot.blockAt(p)
        if (!b || b.name !== 'water') continue
        const lv = levelOf(b)
        if (!(lv > 0 && lv < 8)) continue // источник (0) и падающая (8+) — молчат
        const d = p.offset(0.5, 0.5, 0.5).distanceTo(head)
        if (d > radius) continue
        if (!best || d < best.d) best = { p, d }
      }
    }
  }
  if (!best) return []
  const v = best.p.offset(0.5, 0.5, 0.5).minus(head)
  const dir = Math.abs(v.x) >= Math.abs(v.z) ? (v.x >= 0 ? 'east' : 'west') : (v.z >= 0 ? 'south' : 'north')
  return [{ dir, dist: Math.round(best.d / 2) * 2, flat: Math.round(Math.hypot(v.x, v.z) / 2) * 2, below: v.y < -1, above: v.y > 2 }]
}

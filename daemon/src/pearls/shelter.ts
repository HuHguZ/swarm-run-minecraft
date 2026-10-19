'use strict'
import { sleep, xyz } from '../movement'
import { towerUp } from '../build'
import { log, ents, walkTo, CARDINAL, digCell, hazardNear, stepInto, solidAt, diggable } from './common'
import { clearRay } from './aim'

function hideoutPlan (bot, mcData, top = bot.entity.position.floored()) {
  for (const depth of [3, 4]) {
    let ok = true
    for (let i = 1; i <= depth && ok; i++) {
      const c = top.offset(0, -i, 0)
      if (!solidAt(bot, c) || !diggable(bot, mcData, c) || hazardNear(bot, c)) ok = false
    }
    // Под дном шахты — пол (иначе провалимся дальше).
    if (!ok || !solidAt(bot, top.offset(0, -depth - 1, 0))) continue
    const shaft = top.offset(0, -depth, 0)
    for (const [dx, dz] of CARDINAL) {
      const t1 = shaft.offset(dx, 0, dz)
      const t2 = shaft.offset(2 * dx, 0, 2 * dz)
      if (!solidAt(bot, t1.offset(0, 2, 0)) || !solidAt(bot, t2.offset(0, 2, 0))) continue
      if (!solidAt(bot, t1.offset(0, -1, 0)) || !solidAt(bot, t2.offset(0, -1, 0))) continue
      if (hazardNear(bot, t1) || hazardNear(bot, t2)) continue
      if (![t1, t1.offset(0, 1, 0), t2, t2.offset(0, 1, 0)].every(c => diggable(bot, mcData, c))) continue
      return { top, depth, dir: [dx, dz] }
    }
  }
  return null
}

async function digHideout (bot, ctl, mcData, plan = null) {
  // Встать в середину клетки: с края тело держится на соседнем блоке и в
  // выкопанную под собой яму не падает (лаборатория 2026-09-27: «шахта вышла
  // глубиной 0/1» три вызова подряд).
  try { await (require('../fortify') as typeof import('../fortify')).centerInCell(bot, 900) } catch {}
  const top = bot.entity.position.floored()
  const depth = plan && plan.top.equals(top) ? plan.depth : 3
  // Шахта: три (четыре) блока вниз, тело падает само.
  for (let i = 0; i < depth && !ctl.aborted; i++) {
    const feet = bot.entity.position.floored()
    const h = hazardNear(bot, feet.offset(0, -1, 0))
    if (h) return { ok: false, why: `рядом ${h} — укрытие тут не копаю` }
    const err = await digCell(bot, mcData, feet.offset(0, -1, 0))
    if (err) return { ok: false, why: err }
    await sleep(450)
  }
  const shaft = bot.entity.position.floored()
  if (top.y - shaft.y < 3) return { ok: false, why: `шахта вышла глубиной ${top.y - shaft.y}` }
  // Штрек: сторона, где над обеими клетками твёрдый потолок и нет жидкостей;
  // сторона из плана — первой.
  const dirs = plan && plan.top.equals(top) ? [plan.dir, ...CARDINAL.filter(d => d[0] !== plan.dir[0] || d[1] !== plan.dir[1])] : CARDINAL
  for (const [dx, dz] of dirs) {
    const t1 = shaft.offset(dx, 0, dz)
    const t2 = shaft.offset(2 * dx, 0, 2 * dz)
    const roof1 = bot.blockAt(t1.offset(0, 2, 0))
    const roof2 = bot.blockAt(t2.offset(0, 2, 0))
    if (!roof1 || !roof2 || roof1.boundingBox !== 'block' || roof2.boundingBox !== 'block') continue
    if (hazardNear(bot, t1) || hazardNear(bot, t2)) continue
    let err = null
    for (const c of [t1.offset(0, 1, 0), t1, t2.offset(0, 1, 0), t2]) {
      err = await digCell(bot, mcData, c)
      if (err) break
    }
    if (err) continue
    if (!(await stepInto(bot, t1)) || !(await stepInto(bot, t2))) continue
    // Лицом к шахте — оттуда придёт.
    try { await bot.lookAt(shaft.offset(0.5, 0.3, 0.5), true) } catch {}
    return { ok: true, shaft, stand: t2, top }
  }
  return { ok: false, why: 'штрек от дна шахты вбок не вышел ни в одну сторону (нет потолка или жидкость рядом)', shaft }
}

// Назад: к дну шахты и столбом наверх (порода из шахты и штрека — в рюкзаке).
async function climbOut (bot, ctl, hide) {
  if (!hide) return { ok: true }
  if (!bot.entity.position.floored().equals(hide.shaft)) {
    const t1 = hide.shaft.plus(hide.stand.minus(hide.shaft).scaled(0.5)).floored()
    await stepInto(bot, t1)
    await stepInto(bot, hide.shaft)
  }
  const r = await towerUp(bot, ctl, hide.top.y - bot.entity.position.floored().y)
  return { ok: bot.entity.position.floored().y >= hide.top.y, placed: r.placed, why: r.reason }
}

// ------------------------------------------------------------ hunt: столб
// Лаборатория этапов (2026-09-27, искажённый лес Ада у 0,0 server-nether):
// нора «шахта + штрек» в 6 раундах из 6 не дождалась злого эндермена — к
// шахте он не идёт (30 с ожидания, с 4 и с 12 блоков), а место под нору в
// лесу с карманами лавы находилось через раз. Столб в 3 блока:
//   * Mob.getAttackBoundingBox раздувает его коробку на 0.83 только по
//     горизонтали: с земли у столба (рост 2.9) до наших ног (+3) не хватает
//     0.1 — ударить не может, если вокруг столба нет ступеньки выше подножия;
//   * путь к нам MeleeAttackGoal не находит и ведёт к ближайшей клетке —
//     подножию столба; меч сверху достаёт его голову (1.7 от глаз);
//   * смотреть ему в ноги, не в глаза: взгляд в глаза ближе 4 блоков —
//     телепорт (EndermanLookForPlayerGoal), в ноги с высоты — 12° мимо конуса.
// Высота столба для этой клетки (0 — нельзя). Самая высокая поверхность у
// соседей s (блок на уровне подножия — s = 1): столб h должен поднять ноги
// выше его макушки (s + 2.9) — h >= s + 3; меч сверху достаёт макушку того,
// кто стоит на подножии, только с h <= 4 (глаза на h + 1.62, до макушки 2.9 —
// не больше 2.8 по вертикали). Над подножием — h + 2 клетки воздуха.
function pillarSpot (bot, feet, why = null) {
  const lava = bot.registry.blocksByName.lava.id
  const solid = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'block' }
  const liquid = q => { const b = bot.blockAt(q); return !!b && /lava|water/.test(b.name) }
  const no = k => { if (why) why[k] = (why[k] || 0) + 1; return 0 }
  if (!solid(feet.offset(0, -1, 0))) return no('floor')
  let s = 0
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      for (let y = 4; y >= 0; y--) if (solid(feet.offset(dx, y, dz))) { s = Math.max(s, y + 1); break }
    }
  }
  const h = s + 3
  if (h > 5) return no('high')
  for (let y = 0; y <= h + 1; y++) { const b = bot.blockAt(feet.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || liquid(feet.offset(0, y, 0))) return no('air') }
  for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) {
    const b = bot.blockAt(feet.offset(dx, dy, dz))
    if (b && b.type === lava) return no('lava')
  }
  return h
}

async function pillarUp (bot, ctl, opts: any = {}) {
  const { walkable }: typeof import('../walkable') = require('../walkable')
  let feet = bot.entity.position.floored()
  let h = 0
  {
    // Место, откуда с вершины видно глаза эндерменов (6..24 блока) — в лесу
    // их закрывают ножки грибов и край обрыва: лаборатория, прогон 10 — 20
    // эндерменов в 48 блоках, ни одного с видимыми глазами со столба.
    const nodes = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 6000 })
    const ems = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !(opts.skip && opts.skip.has(e.id)) && !trappedEm(bot, e))
    let best = null
    let checked = 0
    const why = { nodes: nodes.length }
    for (const n of nodes) {
      const hh = pillarSpot(bot, n.pos, why)
      if (!hh) continue
      if (++checked > 250) break
      const eye = n.pos.offset(0.5, hh + 1.62, 0.5)
      let seen = 0
      for (const e of (ems as any)) {
        const d = e.position.distanceTo(eye)
        if (d < 6 || d > 24) continue
        if (clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++
      }
      const score = seen * 10 - n.d * 0.3 + (hh === 3 ? 2 : 0)
      if (!best || score > best.score) best = { pos: n.pos, h: hh, seen, score }
    }
    const spot = best ? { pos: best.pos } : null
    if (best && best.pos.equals(feet)) { h = best.h }
    else if (spot) {
    // (дальше — дойти до места)
    h = pillarSpot(bot, spot.pos)
    const wk = await walkTo(bot, ctl, spot.pos, 0, 15000, opts.stopIf)
    if (!wk.ok && opts.stopIf && opts.stopIf()) return { ok: false, danger: true, why: 'злой рядом — столб прямо здесь' }
    if (!bot.entity.position.floored().equals(spot.pos)) await stepInto(bot, spot.pos)
    feet = bot.entity.position.floored()
    // Встал рядом — годится и эта клетка, если столб на ней выходит.
    if (!feet.equals(spot.pos)) {
      const here = pillarSpot(bot, feet)
      if (!here) return { ok: false, why: 'до места под столб не дошёл' }
      h = here
    }
    }
    if (!spot) return { ok: false, why: `места под столб (соседи не выше подножия+2, над ним 5-7 блоков воздуха, лавы в 3 нет) рядом нет: ${JSON.stringify(why)}` }
    if (best) log('место под столб', { at: xyz(best.pos), h: best.h, eyesSeen: best.seen, checked })
  }
  try { await (require('../fortify') as typeof import('../fortify')).centerInCell(bot, 900) } catch {}
  // Кто дойдёт до подножия ногами (злить только их: лаборатория — злой
  // застревал ниже обрыва в 5 блоках и стоял там полминуты).
  let reach = null
  try { reach = endermanReach(bot, bot.entity.position.floored()) } catch (e) { log('заливка', { error: e.message }) }
  const r = await towerUp(bot, ctl, h)
  const top = bot.entity.position.floored()
  return { ok: top.y - feet.y >= h, base: feet, top, h, reach, placed: r.placed, why: r.reason }
}

// Эндермен в яме: ни в одну из четырёх сторон не шагнуть (ровно или на блок
// вверх, три клетки воздуха над новой опорой). Прогон 30: четверо в старой
// шахте прошлых прогонов — глаза видно со столба, прийти не могут, и место
// под столб выбиралось по ним.
function trappedEm (bot, e) {
  const f = e.position.floored()
  const empty = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/lava/.test(b.name) }
  for (const [dx, dz] of CARDINAL) {
    const n = f.offset(dx, 0, dz)
    if (empty(n) && empty(n.offset(0, 1, 0)) && empty(n.offset(0, 2, 0))) return false
    if (empty(n.offset(0, 1, 0)) && empty(n.offset(0, 2, 0)) && empty(n.offset(0, 3, 0)) && empty(f.offset(0, 3, 0))) return false
  }
  return true
}

// Откуда злой эндермен дойдёт до подножия столба: обратная заливка от
// подножия. Он шагает на блок вверх/вниз (шаг 1.0) и прыгает с обрыва — у моба
// с целью getMaxFallDistance = 3 + (хп − 33% макс.) − 4·(3 − сложность): у
// эндермена на normal до 25 блоков. Значит в обратную сторону: соседняя клетка
// на −1..+1, или выше на сколько угодно (до 12), если над нашей клеткой в её
// сторону — воздух до его головы. Рост 2.9 — три клетки воздуха.
// (Прогон 28: обычная заливка «куда дойду я» не пускала ни одного из 5
// видимых — все стояли выше подножия.)
function endermanReach (bot, base, { radius = 26, maxNodes = 5000 }: any = {}) {
  const key = q => `${q.x},${q.y},${q.z}`
  const empty = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
  const floor = q => { const b = bot.blockAt(q.offset(0, -1, 0)); return !!b && b.boundingBox === 'block' && !/magma|lava/.test(b.name) }
  const stand3 = q => floor(q) && empty(q) && empty(q.offset(0, 1, 0)) && empty(q.offset(0, 2, 0))
  const seen = new Set([key(base)])
  const out = [base]
  const r2 = radius * radius
  for (let i = 0; i < out.length && out.length < maxNodes; i++) {
    const L = out[i]
    for (const [dx, dz] of CARDINAL) {
      const x = L.x + dx; const z = L.z + dz
      if ((x - base.x) ** 2 + (z - base.z) ** 2 > r2) continue
      // Над нашей клеткой L воздух до какой высоты (для прыжка оттуда вниз).
      for (let dy = -1; dy <= 12; dy++) {
        const H = L.offset(dx, dy, dz)
        if (seen.has(key(H))) continue
        if (!stand3(H)) continue
        if (dy >= 2) {
          let clear = true
          for (let y = L.y + 3; y <= H.y + 2 && clear; y++) if (!empty(L.offset(0, y - L.y, 0))) clear = false
          if (!clear) continue
        } else if (dy === 1) {
          if (!empty(L.offset(0, 3, 0))) continue
        } else if (dy === -1) {
          if (!empty(H.offset(0, 3, 0))) continue
        }
        seen.add(key(H))
        out.push(H)
      }
    }
  }
  return seen
}

// Столб прямо здесь — злой рядом (место не выбираем): 3 блока, если над
// головой 5 клеток воздуха (или сколько велит pillarSpot при соседях выше).
async function emergencyPillar (bot, ctl) {
  const feet = bot.entity.position.floored()
  let h = pillarSpot(bot, feet)
  if (!h) {
    let ok = true
    for (let y = 0; y <= 4; y++) { const b = bot.blockAt(feet.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || /lava|water/.test(b.name)) ok = false }
    h = ok ? 3 : 0
  }
  if (!h) return { ok: false, why: 'над головой нет места под столб' }
  try { await (require('../fortify') as typeof import('../fortify')).centerInCell(bot, 600) } catch {}
  const r = await towerUp(bot, ctl, h)
  const top = bot.entity.position.floored()
  return { ok: top.y - feet.y >= h, base: feet, top, h, reach: null, placed: r.placed, why: r.reason, emergency: true }
}

// Вниз со столба: копать под собой (блоки назад в рюкзак).
async function pillarDown (bot, ctl, mcData, base) {
  for (let i = 0; i < 4 && !ctl.aborted; i++) {
    const feet = bot.entity.position.floored()
    if (feet.y <= base.y) break
    const err = await digCell(bot, mcData, feet.offset(0, -1, 0))
    if (err) return { ok: false, why: err }
    await sleep(350)
  }
  return { ok: bot.entity.position.floored().y <= base.y }
}

export { hideoutPlan, digHideout, climbOut, pillarUp, trappedEm, endermanReach, emergencyPillar, pillarDown }

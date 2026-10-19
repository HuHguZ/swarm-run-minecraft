'use strict'
// Застревание: инструменты ступеней — видимая точка и копка, безопасный пролом, удержание клавиш, суша рядом, путь вплавь.
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { bodyBox, shapeBoxes, standPositions } from '../navigation/geometry'
import { at, IMPEDE, solid, SOFT, UNBREAKABLE, DIRS, liquid, AQUATIC, waterB, sleepReal, lavaB, axisTo } from './diagnose'

// ------------------------------------------------------------------ ступени
// ctx: { bot, session, ctl, toward, diag, mcData, sleep }
export const aborted = ctx => !!(ctx.ctl && ctx.ctl.aborted)

function eye (bot) { return bot.entity.position.offset(0, 1.62, 0) }

// Видимая точка блока: луч из глаз до неё упирается именно в этот блок (как прицел клиента), не дальше 4.5.
export function visiblePoint (bot, pos) {
  const pick: typeof import('../pick') = require('../pick')
  const o = eye(bot)
  const c = pos.offset(0.5, 0.5, 0.5)
  const d0 = c.minus(o)
  const len = d0.norm()
  if (len < 1e-3) return c
  const tb = at(bot, pos)
  if (tb && tb.boundingBox !== 'block' && IMPEDE.test(tb.name)) {
    // Контур — куб клетки: виден, если луч до входа в клетку не упёрся в твёрдое. Глаза внутри клетки — виден.
    if (len > 4.5) return null
    const d = d0.scaled(1 / len)
    const tIn = pick.rayBox(o, d, pos, pos.offset(1, 1, 1), len + 1)
    if (tIn == null) return null
    const hit = pick.blockOnRay(bot, o, d, Math.max(tIn, 0.001))
    return !hit || hit.t >= tIn - 1e-6 ? c : null
  }
  if (len <= 4.5) {
    const hit = pick.blockOnRay(bot, o, d0.scaled(1 / len), len + 0.6)
    if (hit && hit.pos.equals(pos)) return c
  }
  // Грани, обращённые к глазам.
  const faces = []
  for (const f of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
    const fc = c.offset(f.x * 0.5, f.y * 0.5, f.z * 0.5)
    if ((o.x - fc.x) * f.x + (o.y - fc.y) * f.y + (o.z - fc.z) * f.z > 0) faces.push(f)
  }
  for (const f of faces) {
    const P = pick.faceAim(bot, pos, f)
    if (P) return P
  }
  return null
}

// Можно ли вскрыть блок: не жидкость за ним (кроме нашей стороны), не бедрок/контейнер, не пол под ногами.
export function safeToBreak (bot, pos, { maxMs = 6000 }: any = {}) {
  const b = at(bot, pos)
  if (!solid(b) && !(b && SOFT.test(b.name) && b.name !== 'water')) return { ok: false, why: 'не твёрдый' }
  if (UNBREAKABLE.test(b.name)) return { ok: false, why: b.name }
  const feet = bot.entity.position.floored()
  if (pos.equals(feet.offset(0, -1, 0))) return { ok: false, why: 'пол под ногами' }
  const body = bodyBox(bot, bot.entity.position)
  if (shapeBoxes(b).some(box => Math.abs(box.maxY - body.minY) <= .04 &&
    box.minX < body.maxX - 1e-7 && box.maxX > body.minX + 1e-7 && box.minZ < body.maxZ - 1e-7 && box.maxZ > body.minZ + 1e-7)) {
    return { ok: false, why: 'опора тела' }
  }
  for (const d of [new Vec3(0, 1, 0), ...DIRS, new Vec3(0, -1, 0)]) {
    const n = at(bot, pos.plus(d))
    if (n && liquid(n) && !(AQUATIC.test(b.name) && waterB(n))) {
      // Жидкость в клетке тела или головы — уже наша сторона.
      const np = pos.plus(d)
      if (np.equals(feet) || np.equals(feet.offset(0, 1, 0))) continue
      return { ok: false, why: `${n.name} за ${b.name}` }
    }
  }
  try {
    const tools: typeof import('../tools') = require('../tools')
    if (!tools.breakable(b)) return { ok: false, why: `${b.name} не ломается` }
    const plan = tools.bestFor(bot, b)
    if (plan.ms > maxMs) return { ok: false, why: `${b.name}: ${(plan.ms / 1000).toFixed(1)} с` }
  } catch {}
  return { ok: true, block: b }
}

export async function digVisible (ctx, pos, opts: any = {}) {
  const { bot } = ctx
  const s = safeToBreak(bot, pos, opts)
  if (!s.ok) return { ok: false, why: s.why }
  const P = visiblePoint(bot, pos)
  if (!P) return { ok: false, why: `${s.block.name} не видно` }
  try {
    await bot.lookAt(P, true)
    let ms = 6000
    try { ms = (require('../tools') as typeof import('../tools')).bestFor(bot, s.block).ms } catch {}
    const done = bot.dig(s.block, 'ignore')
    await withTimeout(done, ms + 1500)
    return { ok: true, name: s.block.name }
  } catch (err) {
    try { bot.stopDigging() } catch {}
    return { ok: false, why: String(err && err.message || err).slice(0, 80) }
  }
}

function withTimeout (p, ms) {
  let t = null
  return Promise.race([p, new Promise<any>((_r, reject) => { t = gameClock.setTimeout(() => reject(new Error('копка не кончилась')), ms) })]).finally(() => gameClock.clearTimeout(t))
}

export async function hold (ctx, keys, ms) {
  const { bot } = ctx
  try {
    for (const k of keys) bot.setControlState(k, true)
    await (ctx.sleep || sleepReal)(ms)
  } finally {
    for (const k of keys) { try { bot.setControlState(k, false) } catch {} }
  }
}

// Пол в 3 вниз у клетки (не лава): шагнуть туда не значит упасть.
export function groundNear (bot, cell) {
  for (let dy = 0; dy <= 3; dy++) {
    const b = at(bot, cell.offset(0, -dy - 1, 0))
    if (!b) return false
    if (lavaB(b)) return false
    if (solid(b) || waterB(b)) return true
  }
  return false
}

// Путь по клеткам жидкости (fluid) и воздуха до сухой опоры (ноги и голова — воздух, под ногами твёрдое): BFS как
// movement.findSwimRoute, но для любой жидкости. { target, path } или null.
export function fluidRoute (bot, fluid, { radius = 8, rise = 8, toward = null }: any = {}) {
  const start = bot.entity.position.floored()
  const key = p => `${p.x},${p.y},${p.z}`
  const wet = b => !!b && (fluid(b) || (AQUATIC.test(b.name) && !lavaB(b)))
  const pass = b => !!b && (wet(b) || (b.boundingBox === 'empty' && !liquid(b)))
  const land = (fb, hb, gb) => !!fb && !!hb && !wet(fb) && !wet(hb) && fb.boundingBox === 'empty' && hb.boundingBox === 'empty' && solid(gb) && !lavaB(gb)
  const q = [{ p: start, parent: -1 }]
  const seen = new Set([key(start)])
  let best = null
  for (let i = 0; i < q.length && i < 6000; i++) {
    const p = q[i].p
    const f = at(bot, p); const h = at(bot, p.offset(0, 1, 0)); const g = at(bot, p.offset(0, -1, 0))
    if (land(f, h, g)) {
      // Берег: без цели — первый (ближний); с целью — лучший по «шаги + полрасстояния до цели» (стенка пруда сзади не
      // годится, если берег к цели рядом — kelp, us-main1: тело выплыло к западной стенке, а цель на востоке).
      let steps = 0; let j = i
      while (q[j].parent >= 0) { steps++; j = q[j].parent }
      const score = steps + (toward ? 0.5 * Math.hypot(p.x + 0.5 - toward.x, p.z + 0.5 - toward.z) : 0)
      if (!best || score < best.score) best = { i, score }
      if (!toward) break
      continue
    }
    const next = [...DIRS.map(d => p.plus(d)), p.offset(0, 1, 0)]
    // Прыжок из воды на уступ в 1 блок (как findSwimRoute): над клеткой свободно.
    if (wet(f) && pass(at(bot, p.offset(0, 2, 0)))) next.push(...DIRS.map(d => p.plus(d).offset(0, 1, 0)))
    // С поверхности (голова над водой) — на берег на 1 выше воды: в воде у стенки с прыжком тело лезет вверх
    // (LivingEntity.travel: в жидкости и упёрся — +0.3 по y).
    if (wet(f) && !wet(h) && pass(at(bot, p.offset(0, 2, 0))) && pass(at(bot, p.offset(0, 3, 0)))) next.push(...DIRS.filter(d => solid(at(bot, p.plus(d).offset(0, 1, 0)))).map(d => p.plus(d).offset(0, 2, 0)))
    for (const n of next) {
      if (Math.max(Math.abs(n.x - start.x), Math.abs(n.z - start.z)) > radius || n.y - start.y > rise || n.y < start.y - 2) continue
      if (seen.has(key(n))) continue
      const nf = at(bot, n); const nh = at(bot, n.offset(0, 1, 0)); const ng = at(bot, n.offset(0, -1, 0))
      if (!pass(nf) || !pass(nh)) continue
      // По воздуху не летаем: клетка без жидкости — только берег (твёрдое под ногами).
      if (!wet(nf) && !wet(nh) && !land(nf, nh, ng)) continue
      seen.add(key(n))
      q.push({ p: n, parent: i })
    }
  }
  if (!best) return null
  const path = []; let j = best.i
  while (q[j].parent >= 0) { path.unshift(q[j].p); j = q[j].parent }
  return { target: q[best.i].p, path }
}

// Плыть по пути fluidRoute к берегу: взгляд на следующую клетку, вперёд и прыжок (в жидкости — всплытие).
export async function swimTo (ctx, fluid, inFluid, { radius = 8, ms = 8000 }: any = {}) {
  const { bot } = ctx
  const toward = ctx.toward || null
  const route = fluidRoute(bot, fluid, { radius, toward })
  if (!route) return { applied: false, why: 'берега рядом нет' }
  const t0 = gameClock.now()
  const p0 = bot.entity.position.clone()
  // До сухой опоры: тело на земле и не в жидкости. «Вышел из воды» на миг (прыжок у стенки) — ещё не берег: отпустить
  // клавиши там — упасть обратно (kelp, us-main1).
  const dry = () => !inFluid() && !!bot.entity.onGround
  try {
    let bestD = Infinity; let bestT = gameClock.now()
    while (gameClock.now() - t0 < ms && !aborted(ctx) && !dry()) {
      // 3 с не ближе к берегу (упёрся в стенку, не вылезти) — бросить: следующая ступень (выемка, ступенька).
      const dT = bot.entity.position.distanceTo(route.target.offset(0.5, 0, 0.5))
      if (dT < bestD - 0.2) { bestD = dT; bestT = gameClock.now() } else if (gameClock.now() - bestT > 3000) break
      const r = (inFluid() && fluidRoute(bot, fluid, { radius, toward })) || route
      const next = inFluid() ? (r.path[0] || r.target) : r.target
      await bot.lookAt(next.offset(0.5, 1.6, 0.5), true)
      const hz = Math.hypot(next.x + 0.5 - bot.entity.position.x, next.z + 0.5 - bot.entity.position.z)
      bot.setControlState('forward', hz > 0.2)
      bot.setControlState('jump', true)
      await (ctx.sleep || sleepReal)(150)
    }
  } finally { try { bot.clearControlStates() } catch {} }
  const out = dry()
  return { applied: out || bot.entity.position.distanceTo(p0) > 2, why: out ? `вышел на берег ${route.target.x},${route.target.y},${route.target.z}` : 'плыл к берегу, не вышел' }
}

export async function breakToward (ctx, depth) {
  const { bot, toward } = ctx
  const dir = axisTo(bot, toward)
  if (!dir) return { applied: false, why: 'нет направления' }
  const feet = bot.entity.position.floored()
  const up = toward && toward.y > bot.entity.position.y + 0.6
  const down = toward && toward.y < bot.entity.position.y - 1.2
  const cells = []
  // Вверх — лесенкой: над головой, впереди на +2 и +1; клетка ног впереди остаётся ступенькой (на неё и прыжок).
  // Ровно — проход 1×2. Вниз — ещё и клетка под проходом (ступень вниз).
  for (let k = 1; k <= depth; k++) {
    const f = feet.plus(dir.scaled(k))
    const y0 = up ? k - 1 : 0
    if (up) cells.push(feet.offset(0, 2 + y0, 0).plus(dir.scaled(k - 1)), f.offset(0, 2 + y0, 0), f.offset(0, 1 + y0, 0))
    else cells.push(f.offset(0, 1, 0), f)
    // Ступень вниз — только если под ней опора в 2 бл. (не лава): иначе шаг в дыру над пещерой — падение.
    if (down && k === 1 && groundNear(bot, f.offset(0, -1, 0)) && solid(at(bot, f.offset(0, -2, 0)))) cells.push(f.offset(0, -1, 0))
  }
  const dug = []; const skip = []
  for (const c of cells) {
    if (aborted(ctx)) break
    const b = at(bot, c)
    if (!b || (!solid(b) && !IMPEDE.test(b.name) && !(SOFT.test(b.name) && b.boundingBox !== 'empty'))) continue
    const r = await digVisible(ctx, c)
    if (r.ok) dug.push(r.name)
    else skip.push(`${b.name}: ${r.why}`)
  }
  if (dug.length) {
    // Removing a visible wall does not establish that its far side has a floor.
    // Use the same observed landing/controller as normal navigation; a refused
    // edge leaves the body on its present support for the next path replan.
    if (bot.physics && typeof bot.waitForTicks === 'function' && !aborted(ctx)) {
      const next = bot.entity.position.floored().plus(dir)
      const targets = standPositions(bot, next, { rise: 1.25, drop: down ? 3 : 0 })
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      for (const target of targets.slice(0, 3)) {
        const moved = await (require('../navigation/parkour') as typeof import('../navigation/parkour')).executeJump(bot, ctx.ctl || { aborted: false }, target, { allowWalk: true, planningMs: 180 })
        if (moved.ok || moved.ticks || aborted(ctx)) break
      }
    }
  }
  return { applied: dug.length > 0, why: dug.length ? `снёс ${dug.join(', ')}` : skip.length ? `не снёс: ${skip.slice(0, 2).join('; ')}` : 'впереди пусто' }
}

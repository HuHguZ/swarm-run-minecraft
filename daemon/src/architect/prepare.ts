'use strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz } from '../movement'
import { withTimeout } from '../build'
import { countItems } from '../items'
import * as bp from '../blueprint'
import { sleep, isDone } from './world'
import { hasName, makeParts, place, relOf, cardinalTo, facingOf, sigOf } from './plan'
import { pickSurfaceSite, pickHillside } from './site'
import { jobOf, tally, scaffoldNeed } from './estimate'

// ---------------------------------------------------------------- entry

// Разобрать запрос до мировых клеток, место и смету — общее для preview и build.
async function prepare (session, ctl, p) {
  const bot = session.bot
  const mcData = session.mcData
  const has = hasName(mcData)
  const stock = countItems(bot)
  const job = jobOf(session)
  let kind = p.plan ? 'plan' : String(p.kind || '').toLowerCase()
  const resume = p.mode === 'resume' || (!p.kind && !p.plan && job && job.status !== 'done' && p.mode !== 'preview')

  let plan
  let front
  let origin = p.origin ? { x: Math.floor(p.origin.x), y: Math.floor(p.origin.y), z: Math.floor(p.origin.z) } : null
  let site = null
  let reused = false

  if (resume) {
    if (!job) throw new Error('продолжать нечего: в памяти нет начатой стройки')
    kind = job.kind
    plan = { kind, parts: job.parts, subs: job.subs || [], material: job.material, labels: job.labels || null }
    front = job.front
    origin = job.origin
    reused = true
  } else {
    if (!kind) kind = 'house'
    plan = makeParts(session, { ...p, kind }, stock)
    const sig = sigOf(kind, p)
    // Тот же заказ, что в памяти, и рядом — это продолжение того же дома.
    if (!origin && !p.fresh && job && job.sig === sig && job.origin &&
        new Vec3(job.origin.x, job.origin.y, job.origin.z).distanceTo(bot.entity.position) < 64) {
      plan = { kind, parts: job.parts, subs: job.subs || plan.subs, material: job.material, labels: job.labels || plan.labels }
      front = job.front
      origin = job.origin
      reused = true
    }
    front = front || p.front || null
  }

  const spec = bp.KINDS[kind] || { site: 'surface', ru: 'постройка' }
  if (!origin) {
    if (spec.site === 'hill') {
      const probe = bp.layout(plan.parts, { front: 'south', has })
      const W = probe.size.w - 2; const D = probe.size.d - 3; const H = probe.size.y2 - 1
      const hill = pickHillside(bot, { W, D, H, radius: Math.max(4, Math.min(24, p.radius ?? 12)) })
      if (!hill) return { refused: { stopped: `Склона под землянку рядом нет: нужен холм, где комната ${W}×${D}×${H} целиком в земле и над ней ещё слой. Подойди к склону или скажи место (origin), или строй дом (kind=house).` } }
      front = bp.OPP[hill.dir]
      const L = bp.layout(plan.parts, { front, has })
      const mid = Math.floor(W / 2)
      const porch = relOf(L, plan.parts, has, mid, D + 1)
      origin = { x: hill.E.x - porch.x, y: hill.E.y - 1, z: hill.E.z - porch.z }
      site = { how: 'склон нашёл сам', entrance: xyz(hill.E), into: hill.dir, rock: hill.ratio, roof: hill.roof, dist: hill.dist }
    } else if (spec.site === 'ahead') {
      const dir = p.direction || facingOf(bot)
      front = bp.OPP[dir]
      const L = bp.layout(plan.parts, { front, has })
      const probe = bp.layout(plan.parts, { front: 'south', has })
      const W = probe.size.w - 2; const D = probe.size.d - 3
      const porch = relOf(L, plan.parts, has, Math.floor(W / 2), D + 1)
      const feet = bot.entity.position.floored()
      origin = { x: feet.x - porch.x, y: feet.y - 1, z: feet.z - porch.z }
      site = { how: 'прямо передо мной', into: dir }
    } else {
      const L0 = bp.layout(plan.parts, { front: 'south', has })
      const s = pickSurfaceSite(bot, { w: L0.size.w, d: L0.size.d, h: L0.size.y2, radius: Math.max(4, Math.min(32, p.radius ?? 16)) })
      if (!s) return { refused: { stopped: `Ровного места под ${spec.ru} ${L0.size.w}×${L0.size.d} в ${p.radius ?? 16} блоках нет: везде вода, обрыв или чужие постройки. Назови место (origin) или отойди на открытое.` } }
      const centreXZ = { x: s.x0 + s.L / 2, z: s.z0 + s.L / 2 }
      front = front || cardinalTo(centreXZ, bot.entity.position)
      const L = bp.layout(plan.parts, { front, has })
      origin = { x: Math.floor(centreXZ.x - L.size.w / 2), y: s.y0, z: Math.floor(centreXZ.z - L.size.d / 2) }
      site = { how: 'выбрал сам', levelling: { dig: s.cut, fill: s.fill, trees: s.trees || undefined }, dist: s.dist }
    }
  } else if (!site) {
    site = { how: reused ? 'продолжаю начатое' : 'назвал ты' }
  }

  front = front || 'south'
  const L = bp.layout(plan.parts, { front, has })
  const cells = place(L, origin)
  // Мир вокруг места должен быть прогружен: blockAt в непрогруженном чанке —
  // null, и такая клетка читается как «висит в воздухе». Сразу после входа на
  // сервер или телепорта это вся постройка.
  let t = tally(bot, cells)
  for (let i = 0; i < 20 && t.unknown && !ctl.aborted; i++) {
    if (i === 0) { try { await withTimeout(bot.waitForChunksToLoad(), 8000, 'чанки') } catch {} }
    await sleep(400)
    t = tally(bot, cells)
  }
  if (t.unknown) return { refused: { stopped: `Место не прогружено: ${t.unknown} клеток постройки в чанках, которых тело не видит. Подойди ближе и позови снова.` } }
  const groundY = origin.y
  const lift = scaffoldNeed(cells.filter(c => !isDone(bot, c)), groundY)
  return { plan, kind, spec, front, origin, site, reused, L, cells, tally: t, lift, stock }
}

export { prepare }

// Место для боя с толпой (21.10): куда встать в ближайших 4 бл., пока удар перезаряжается. Человек против троих и
// больше держит всех спереди, встаёт туда, откуда бить по нему могут немногие (узкий проход, угол, спина к стене),
// прячется от лучника за стенкой или столбом и не стоит у обрыва и лавы — удар отбросит туда. Обобщение duo.bestSpot
// (двое) на N: клещи — разбросом всех ближних, «откуда бить» — свободные клетки вокруг, лучник — луч до его глаз.
// Отброс удара — ~0.4–0.9 бл. (LivingEntity.knockback 0.4 + спринт-удар 0.5): у края ближе 1.5 бл. — штраф.
import * as edges from '../edges'
import { raySees } from '../perception'
import { solid } from '../moves'
import { spread, type CrowdFoe } from './crowd-threat'
import { EYE } from './rules'
import { Vec3 } from './vec3'

const BAD = /lava|fire|magma|cactus|campfire|sweet_berry|powder_snow|cobweb/
const PINCER = 100 * Math.PI / 180
const RANGED = /^(bow|crossbow|trident)$/
const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

function standable (bot, c) {
  const f = bot.blockAt(c); const h = bot.blockAt(c.offset(0, 1, 0)); const g = bot.blockAt(c.offset(0, -1, 0))
  if (!f || !h || !g) return false
  if (f.boundingBox !== 'empty' || h.boundingBox !== 'empty' || g.boundingBox !== 'block') return false
  return !BAD.test(f.name) && !BAD.test(h.name) && !BAD.test(g.name)
}

// Оценка точки S: чем больше, тем лучше. null — встать нельзя (у обрыва/лавы вплотную, в руке у двоих сразу).
// edgeWant — сколько хочу до обрыва/лавы: 1.5 от удара; 5 — когда рядом заряд ветра (взрыв ветра кидает вверх и прочь
// на 4–6 бл. мимо щита и неуязвимости, сцена CROWD_START=edge: 7 из 8 раундов — за край).
function scoreAt (bot, S, foes: CrowdFoe[], cache, edgeWant = 1.5) {
  const melee = foes.filter(f => !f.flying && !(f.held && RANGED.test(f.held) && hd(f.p, S) > 5))
  const archers = foes.filter(f => f.held && RANGED.test(f.held) && hd(f.p, S) > 5)
  const clr = edges.clearance(bot, S, Math.max(2.0, edgeWant), cache)
  if (clr < 0.5) return null
  let s = 0
  const why: string[] = []
  const near = melee.filter(f => hd(f.p, S) < 8)
  const sp = spread(S, near.map(f => f.p))
  if (sp > PINCER) s -= 6 + (sp - PINCER) * 4
  else if (near.length >= 2) { s += 2; why.push('все спереди') }
  s -= near.filter(f => hd(f.p, S) < 3.2).length * 1.5
  for (const a of archers) {
    if (raySees(bot, S.offset(0, EYE, 0), new Vec3(a.p.x, a.p.y + 1.5, a.p.z))) s -= 2.5
    else { s += 2; why.push('лучник за стеной') }
  }
  // Откуда по мне бить: свободные клетки в 1.5 бл. по 8 сторонам — меньше лучше, но закрыть сторону может только стена
  // (проход, угол). Пустота за краем — не «узкое место», а обрыв под отброс (c5h: бой на краю обрыва «встаю: узкое место»).
  let open = 0; let wall = 0; let drop = 0
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4
    const c = new Vec3(Math.floor(S.x + Math.cos(a) * 1.5), Math.floor(S.y), Math.floor(S.z + Math.sin(a) * 1.5))
    if (standable(bot, c)) open++
    else if (solid(bot, c) || solid(bot, c.offset(0, 1, 0))) wall++
    else drop++
  }
  s -= open * 0.6 + drop * 1.5
  if (wall >= 3 && open <= 4) why.push('узкое место')
  // Спина к стене (от центра ближних) — плюс, обрыв и лава в 1.5 бл. — минус: отброс удара.
  if (near.length) {
    const cx = near.reduce((t, f) => t + f.p.x, 0) / near.length - S.x; const cz = near.reduce((t, f) => t + f.p.z, 0) / near.length - S.z
    const n = Math.hypot(cx, cz) || 1
    const back = new Vec3(Math.floor(S.x - cx / n), Math.floor(S.y), Math.floor(S.z - cz / n))
    if (solid(bot, back) || solid(bot, back.offset(0, 1, 0))) { s += 1.5; why.push('спина к стене') }
  }
  if (clr < 1.5) s -= (1.5 - clr) * 6
  if (edgeWant > 1.5 && clr < edgeWant) { s -= (edgeWant - clr) * 3; if (clr < 1.5) why.push('прочь от края') }
  return { s, why }
}

// Лучшая клетка в radius бл. (прямой проход, не мимо врага вплотную). null — здесь не хуже (запас 1.5).
export function crowdSpot (bot, foes: CrowdFoe[], { radius = 4, edgeWant = 1.5 } = {}) {
  const me = bot.entity.position
  const cache = new Map()
  const here = scoreAt(bot, me, foes, cache, edgeWant)
  const base = me.floored()
  let best = null
  // Шире 4 бл. — через клетку (до 100 точек вместо 361: оценка точки — сотня blockAt).
  const step = radius > 4 ? 2 : 1
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      if ((!dx && !dz) || dx * dx + dz * dz > radius * radius) continue
      let c = null
      for (const dy of [0, 1, -1]) { const q = base.offset(dx, dy, dz); if (standable(bot, q)) { c = q; break } }
      if (!c) continue
      const S = new Vec3(c.x + 0.5, c.y, c.z + 0.5)
      const travel = hd(S, me)
      let blocked = false
      const n = Math.max(2, Math.ceil(travel))
      for (let i = 1; i < n; i++) {
        const t = i / n
        const m = new Vec3(Math.floor(me.x + (S.x - me.x) * t), Math.floor(me.y), Math.floor(me.z + (S.z - me.z) * t))
        if (!standable(bot, m) && !standable(bot, m.offset(0, 1, 0)) && !standable(bot, m.offset(0, -1, 0))) { blocked = true; break }
        if (foes.some(f => !f.flying && hd(f.p, { x: me.x + (S.x - me.x) * t, z: me.z + (S.z - me.z) * t }) < 1.2)) { blocked = true; break }
      }
      if (blocked) continue
      const v = scoreAt(bot, S, foes, cache, edgeWant)
      if (!v) continue
      const s = v.s - travel * 0.7
      if (!best || s > best.s) best = { x: S.x, y: S.y, z: S.z, s, why: v.why }
    }
  }
  if (!best || (here && best.s < here.s + 1.5)) return null
  return { x: best.x, y: best.y, z: best.z, why: best.why.join(', ') || 'меньше под ударом' }
}

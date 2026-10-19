'use strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { seesBlock } from '../sight'
import { raySees, eyePos, biomeName } from '../perception'
import { dimOf, flat, groupNames, groupMin } from './common'
import { kindsFor } from './kinds'
import { remember } from './memory'

// ------------------------------------------------------------------ зрение

// Где лежат блоки этих имён в радиусе — ОДИН проход по секциям чанков.
// bot.findBlocks на каждое имя стоил ~60 мс даже впустую (Block.fromStateId
// на каждую запись палитры каждой секции): 160 имён — 8 с стоящего цикла
// событий, и сервер выкидывал бота по тайм-ауту (2026-09-25). Здесь палитра
// секции сверяется с набором stateId, и только совпавшие секции читаются.
function gather (bot, names, radius, perName = 64) {
  const R = bot.registry.blocksByName
  const byState = new Map()
  for (const n of names) {
    const b = R[n]
    if (!b || n.startsWith('e:')) continue
    for (let st = b.minStateId; st <= b.maxStateId; st++) byState.set(st, n)
  }
  const out = new Map()
  if (!byState.size) return out
  const me = bot.entity.position
  const minY = bot.game.minY || 0
  const cr = Math.ceil(radius / 16)
  const cx0 = Math.floor(me.x / 16)
  const cz0 = Math.floor(me.z / 16)
  const syLo = Math.max(0, Math.floor((me.y - radius - minY) / 16))
  const syHi = Math.floor((me.y + radius - minY) / 16)
  const r2 = radius * radius
  for (let dx = -cr; dx <= cr; dx++) {
    for (let dz = -cr; dz <= cr; dz++) {
      const col = bot.world.getColumn(cx0 + dx, cz0 + dz)
      if (!col || !col.sections) continue
      for (let sy = syLo; sy <= syHi && sy < col.sections.length; sy++) {
        const sec = col.sections[sy]
        const data = sec && sec.data
        if (!data) continue
        if (data.palette) {
          if (!data.palette.some(st => byState.has(st))) continue
        } else if (data.value !== undefined) {
          if (!byState.has(data.value)) continue
        }
        const bx = (cx0 + dx) * 16
        const bz = (cz0 + dz) * 16
        const by = sy * 16 + minY
        for (let i = 0; i < 4096; i++) {
          const n = byState.get(data.get(i))
          if (!n) continue
          const x = bx + (i & 15)
          const y = by + (i >> 8)
          const z = bz + ((i >> 4) & 15)
          const ddx = x + 0.5 - me.x
          const ddy = y + 0.5 - me.y
          const ddz = z + 0.5 - me.z
          if (ddx * ddx + ddy * ddy + ddz * ddz > r2) continue
          let list = out.get(n)
          if (!list) out.set(n, list = [])
          if (list.length < perName * 4) list.push(new Vec3(x, y, z))
        }
      }
    }
  }
  for (const [n, list] of out) {
    list.sort((a, b) => a.distanceSquared(me) - b.distanceSquared(me))
    if (list.length > perName) out.set(n, list.slice(0, perName))
  }
  return out
}

// Виден ли блок: луч к центру (sight.seesBlock), а нет — к центрам граней,
// обращённых к глазам. Блок в стене видно краем, хотя центр закрыт соседом:
// башня храма, торчащая из дюны, человеку видна, а лучу в центр — нет.
function sees (bot, block) {
  if (seesBlock(bot, block)) return true
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
  const p = block.position
  const c = p.offset(0.5, 0.5, 0.5)
  const faces = []
  if (eye.x < p.x) faces.push(c.offset(-0.45, 0, 0)); else if (eye.x > p.x + 1) faces.push(c.offset(0.45, 0, 0))
  if (eye.y < p.y) faces.push(c.offset(0, -0.45, 0)); else if (eye.y > p.y + 1) faces.push(c.offset(0, 0.45, 0))
  if (eye.z < p.z) faces.push(c.offset(0, 0, -0.45)); else if (eye.z > p.z + 1) faces.push(c.offset(0, 0, 0.45))
  const match = (b, iter) => b.position.equals(p) || !!iter.intersect(b.shapes, b.position)
  for (const f of faces) {
    const d = f.minus(eye)
    const dist = d.norm()
    try {
      const hit = bot.world.raycast(eye, d.normalize(), dist + 0.3, match)
      if (hit && hit.position.equals(p)) return true
    } catch {}
  }
  return false
}

// Один взгляд: кандидаты — из gather, у каждого имени свой бюджет лучей
// (как fortress.look), чтобы обычный камень не съедал бюджет редких блоков.
function look (bot, names, { radius = 40, rays = 24, enough = 8 }: any = {}) {
  const seen = new Map()
  const me = bot.entity.position
  const all = gather(bot, names, radius)
  for (const [name, found] of all) {
    const hits = []
    let tried = 0
    const want = name === 'polished_blackstone_bricks' || name === 'cracked_polished_blackstone_bricks' ? 30 : enough
    const step = Math.max(1, Math.floor(found.length / (rays * 2)))
    for (let i = 0; i < found.length && tried < rays * 2 && hits.length < want; i += step) {
      tried++
      const p = found[i]
      const block = bot.blockAt(p)
      if (!block) continue
      // Вплотную (руку протянуть) — видно и за углом.
      if (p.offset(0.5, 0.5, 0.5).distanceTo(me.offset(0, 1.62, 0)) <= 2.2 || sees(bot, block)) hits.push(p)
    }
    if (hits.length) seen.set(name, hits)
  }
  // Сущности — по лучу к середине тела.
  const ents = new Map()
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e === bot.entity || !e.name || !e.position) continue
    if (e.position.distanceTo(me) > radius) continue
    const k = `e:${e.name}`
    if (!names.has(k)) continue
    const mid = e.position.offset(0, (e.height || 1) / 2, 0)
    if (!raySees(bot, eyePos(bot), mid)) continue
    if (!ents.has(k)) ents.set(k, [])
    ents.get(k).push(e.position.floored())
  }
  for (const [k, v] of ents) seen.set(k, v)
  return seen
}

// Узнать постройки в увиденном. Якорь — видимый блок обязательной группы;
// остальные группы засчитываются в радиусе r от него.
function evaluate (bot, kind, K, seen) {
  const hitsOf = K.groups.map(g => groupNames(g).flatMap(n => (seen.get(n) || []).map(p => ({ n, p }))))
  const anchorGroups = K.must || K.groups.map((_, i) => i)
  const anchors = anchorGroups.flatMap(i => hitsOf[i]).slice(0, 24)
  let best = null
  for (const a of anchors) {
    const got = []
    hitsOf.forEach((hits, i) => {
      const near = hits.filter(h => h.p.distanceTo(a.p) <= K.r * 1.5)
      if (near.length >= groupMin(K.groups[i])) got.push({ i, n: near[0].n, list: near })
    })
    if (!got.some(g => anchorGroups.includes(g.i))) continue
    if (!best || got.length > best.got.length) best = { anchor: a.p, got }
  }
  if (!best || best.got.length < K.min) return null
  // Исключения: светится портал внутри рамки — это чей-то портал, не руины.
  if (K.not && K.not.some(n => (seen.get(n) || []).some(p => p.distanceTo(best.anchor) <= (K.notR || K.r)))) return null
  if (K.wet) {
    const w = bot.registry.blocksByName.water
    if (!w || !bot.findBlock({ matching: w.id, maxDistance: K.wet, point: best.anchor })) return null
  }
  if (K.biomes) {
    // Биом проверяется у старта постройки, а её блоки лежат и на соседнем:
    // храм у -5254,1690 стоит краем на wooded_badlands. Поэтому — любой из
    // пяти точек вокруг якоря; неизвестный (#id) — не спорим.
    const pts = [best.anchor, ...[[16, 0], [-16, 0], [0, 16], [0, -16]].map(([dx, dz]) => best.anchor.offset(dx, 0, dz))]
    const names = pts.map(q => biomeName(bot, q)).filter(Boolean)
    if (names.length && !names.some(b => /^biome#/.test(b) || K.biomes.test(b))) return null
  }
  const pts = best.got.flatMap(g => g.list.map(h => h.p))
  const c = pts.reduce((s, p) => s.plus(p), new Vec3(0, 0, 0)).scaled(1 / pts.length)
  // Колокол деревни — на площади в центре (пулы town_centers): увиден — он и есть центр.
  const bell = kind === 'village' ? best.got.flatMap(g => g.list).find(h => h.n === 'bell') : null
  return {
    kind,
    name: K.ru,
    at: { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) },
    evidence: [...new Set(best.got.map(g => g.n.replace(/^e:/, '')))],
    groups: best.got.length,
    ...(bell ? { bell: { x: bell.p.x, y: bell.p.y, z: bell.p.z } } : {})
  }
}

// Честный осмотр: что из построек видно отсюда. record — записать в память.
function scan (session, { radius = 40, record = true }: any = {}) {
  const bot = session.bot
  const dim = dimOf(bot)
  const kinds = kindsFor(dim)
  const names = new Set(kinds.flatMap(([, K]) => K.groups.flatMap(groupNames)))
  for (const [, K] of (kinds as any)) for (const n of (K.not || [])) names.add(n)
  const seen = look(bot, names, { radius })
  const found = []
  for (const [kind, K] of kinds) {
    const d = evaluate(bot, kind, K, seen)
    if (d) found.push(d)
  }
  // Руины портала — часть сигнатуры бастиона (блэкстоун-кирпич): бастион главнее.
  const me = bot.entity.position
  for (const d of found) d.dist = Math.round(flat(me, d.at))
  const fresh = []
  if (record) {
    for (const d of found) {
      const r = remember(session, d, dim)
      if (r.fresh) fresh.push(d)
      d.known = !r.fresh
      d.done = !!r.rec.done
    }
  }
  const blocks = {}
  for (const [n, list] of seen) blocks[n.replace(/^e:/, '')] = list.length
  return { dim, found: found.sort((a, b) => a.dist - b.dist), fresh, blocks }
}

export { gather, sees, look, evaluate, scan }

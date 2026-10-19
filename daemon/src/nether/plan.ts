'use strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz } from '../movement'
import { pickFiller } from '../build'
import { itemNamed, countOf } from '../items'
import * as worlds from '../worlds'
import {
  FRAME_MIN, FRAME_BLOCK, IGNITERS, FLINT_PER_GRAVEL, OBSIDIAN_TOOLS, OBSIDIAN_SECONDS, AXES, innerCells,
  frameCells, cornerCells, propFor, isSolid, isFluid, isPortalEmpty, PROTECTED, neighbours, PLACE_RADIUS,
  MAX_DIG, LAVA_KEEP, WATER_KEEP, REACH, eyesAt, centre, chebyshev
} from './shape'

// Is there a fluid of this kind within `keep` of any of these cells?
function fluidNear (read, cells, re, keep) {
  const seen = new Set()
  for (const c of cells) {
    for (let dx = -keep; dx <= keep; dx++) {
      for (let dy = -keep; dy <= keep; dy++) {
        for (let dz = -keep; dz <= keep; dz++) {
          const p = c.offset(dx, dy, dz)
          const k = `${p.x},${p.y},${p.z}`
          if (seen.has(k)) continue
          seen.add(k)
          const b = read(p)
          if (b && re.test(b.name)) return { name: b.name, pos: xyz(p), dist: chebyshev(c, p) }
        }
      }
    }
  }
  return null
}

// Where the body stands while it builds and while it lights. Never inside the
// envelope: a bot standing in its own portal when it catches is a bot in the
// Nether four seconds later, which is exactly the trip this intent refuses to
// make.
// `rank` 0 is two blocks back from the plane and 1 is right against it. Both
// are safe — only a body *inside* a portal block travels — but two blocks back
// leaves room for the fire and is what a person would do, so it wins ties.
function standSpots (origin, axis, envelope) {
  const u = AXES[axis]
  const perp = axis === 'x' ? AXES.z : AXES.x
  const out = []
  for (const [rank, away] of [[0, 2], [1, 1]]) {
    for (const side of [1, -1]) {
      for (let i = -1; i <= 2; i++) {
        for (const dy of [0, -1, 1]) {
          const p = origin.offset(u.x * i + perp.x * side * away, dy, u.z * i + perp.z * side * away)
          if (envelope.some(c => c.equals(p) || c.equals(p.offset(0, 1, 0)))) continue
          out.push({ pos: p, rank })
        }
      }
    }
  }
  return out
}

function standable (read, p, { allowDig = true }: any = {}) {
  const ground = read(p.offset(0, -1, 0))
  const feet = read(p)
  const head = read(p.offset(0, 1, 0))
  if (!ground || !feet || !head) return null
  if (!isSolid(ground) || isFluid(ground)) return null
  const dig = []
  for (const [cell, b] of [[p, feet], [p.offset(0, 1, 0), head]]) {
    if (b.boundingBox === 'empty' && !isFluid(b)) continue
    if (isFluid(b) || PROTECTED.test(b.name) || b.name === FRAME_BLOCK) return null
    if (!allowDig) return null
    dig.push(cell)
  }
  return { pos: p, dig }
}

// One candidate site, fully judged. Returns a plan or the reason it is out.
function judge (read, origin, axis, me) {
  const inner = innerCells(origin, axis)
  const frame = frameCells(origin, axis)
  const envelope = [...inner, ...frame, ...cornerCells(origin, axis)]

  for (const c of [...inner, ...frame]) {
    if (!read(c)) return { why: 'чанк не прогружен' }
  }

  // Our own body inside the envelope means placements get refused one by one
  // and the bot ends up standing in a half-built frame.
  if (envelope.some(c => c.equals(me) || c.equals(me.offset(0, 1, 0)))) return { why: 'я сам стою в раме' }

  const lava = fluidNear(read, [...inner, ...frame], /lava/, LAVA_KEEP)
  if (lava) return { why: `лава в ${lava.dist} бл.`, lava }
  const water = fluidNear(read, inner, /^(water|bubble_column|flowing_water)$/, WATER_KEEP)
  if (water) return { why: `вода в ${water.dist} бл.`, water }

  const dig = []
  let needObsidian = 0
  for (const c of inner) {
    const b = read(c)
    if (isPortalEmpty(b)) continue
    if (b.name === FRAME_BLOCK) return { why: 'внутри рамы уже лежит обсидиан' }
    if (PROTECTED.test(b.name)) return { why: `внутри ${b.name} — не ломаю` }
    dig.push(c)
  }
  for (const c of frame) {
    const b = read(c)
    if (b.name === FRAME_BLOCK) continue
    needObsidian++
    if (b.boundingBox === 'empty' && !isFluid(b)) continue
    if (PROTECTED.test(b.name)) return { why: `в раме ${b.name} — не ломаю` }
    dig.push(c)
  }
  if (dig.length > MAX_DIG) return { why: `копать ${dig.length} клеток — дороже, чем стоит` }

  // Props: cells that will have nothing to lean on when their turn comes.
  // Computed against the world *as it will be*, so a frame cell already placed
  // earlier in the order counts as support.
  const placed = new Set()
  const props = []
  const willBeSolid = p => {
    const k = `${p.x},${p.y},${p.z}`
    if (placed.has(k)) return true
    if (inner.some(c => c.equals(p))) return false
    if (dig.some(c => c.equals(p))) return false
    return isSolid(read(p)) && !isFluid(read(p))
  }
  for (const c of frame) {
    if (!neighbours(c).some(willBeSolid)) {
      const prop = propFor(origin, axis, c)
      if (!prop) return { why: 'раму не к чему прислонить' }
      if (!neighbours(prop).some(willBeSolid)) return { why: 'раму не к чему прислонить' }
      const pb = read(prop)
      if (!pb || (pb.boundingBox !== 'empty' && !isSolid(pb))) return { why: 'угол под подпорку занят' }
      if (isSolid(pb)) { placed.add(`${prop.x},${prop.y},${prop.z}`) } else {
        props.push(prop)
        placed.add(`${prop.x},${prop.y},${prop.z}`)
      }
    }
    placed.add(`${c.x},${c.y},${c.z}`)
  }

  // The spot to stand on is required to be free as it is. Clearing it would
  // have to happen before the walk and the rest of the clearing after it, and
  // an ordering like that is how a bot ends up digging the floor out from under
  // its own feet. There are two dozen candidates; if none of them is free the
  // site genuinely is too tight.
  const candidates = []
  for (const s of standSpots(origin, axis, envelope)) {
    const ok = standable(read, s.pos, { allowDig: false })
    if (!ok) continue
    if (eyesAt(s.pos).distanceTo(centre(frame[0])) > REACH) continue
    candidates.push({ ...ok, rank: s.rank })
  }
  candidates.sort((a, b) => a.rank - b.rank || a.pos.distanceTo(me) - b.pos.distanceTo(me))
  const stand = candidates[0]
  if (!stand) return { why: 'негде встать рядом' }

  return {
    plan: {
      axis,
      origin,
      inner,
      frame,
      corners: cornerCells(origin, axis),
      props,
      // Top down: gravel above a cleared cell pours into it, and a dig list
      // that works upwards refills its own holes.
      dig: dig.slice().sort((a, b) => b.y - a.y),
      stand: stand.pos,
      needObsidian,
      // Digging is what makes one site cost more than another. Props weigh more
      // than they look: each one is another placement that can fail, and a
      // frame whose bottom row sits flush in the ground needs none at all.
      // needObsidian в счёте — это обещание «позови ещё раз, доставлю недостающие»,
      // сделанное правдой: недостроенная рама стоит 2, а чистое место 10, и повтор
      // выбирает ту же площадку, а не начинает вторую рядом.
      score: dig.length * 3 + props.length * 4 + needObsidian * 3 + Math.round(origin.distanceTo(me))
    }
  }
}

// Pick the cheapest site around `me`. Pure over `read`, so a stub world drives
// it exactly the way the server does.
function planPortal (read, me, { axis = null, radius = PLACE_RADIUS }: any = {}) {
  const axes = axis ? [axis] : ['x', 'z']
  let best = null
  const why = new Map()
  for (let dy = 1; dy >= -2; dy--) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (const a of axes) {
          const origin = me.offset(dx, dy, dz)
          const r = judge(read, origin, a, me)
          if (r.why) { why.set(r.why, (why.get(r.why) || 0) + 1); continue }
          if (!best || r.plan.score < best.score) best = r.plan
        }
      }
    }
  }
  if (best) return { ok: true, plan: best }
  // The most common complaint is the one worth telling the brain about.
  const ranked = [...why.entries()].sort((a, b) => b[1] - a[1])
  return { ok: false, reasons: ranked.slice(0, 3).map(([w, n]) => `${w} (${n})`) }
}

// ------------------------------------------------------- finding what exists

// Is there a whole frame here, and is it already burning? Called on every
// obsidian block nearby, so that the bot never builds a second portal three
// blocks from a working one and never has to break anything to find out.
function frameAt (read, origin, axis) {
  for (const c of frameCells(origin, axis)) {
    const b = read(c)
    if (!b || b.name !== FRAME_BLOCK) return null
  }
  const inner = innerCells(origin, axis)
  let lit = 0
  for (const c of inner) {
    const b = read(c)
    if (!isPortalEmpty(b)) return null
    if (b.name === 'nether_portal') lit++
  }
  return { origin, axis, lit: lit === inner.length, portalBlocks: lit, inner }
}

// Every complete frame whose obsidian is within reach of `centre`. A frame's
// bottom-left frame block is always one below and one "left" of its interior
// origin, so each obsidian block is tried as both ends of both axes.
function findFrames (read, obsidian) {
  const out = []
  const seen = new Set()
  for (const b of obsidian) {
    for (const axis of ['x', 'z']) {
      const u = AXES[axis]
      for (const shift of [0, -1]) {
        const origin = b.offset(u.x * shift, 1, u.z * shift)
        const key = `${axis}:${origin.x},${origin.y},${origin.z}`
        if (seen.has(key)) continue
        seen.add(key)
        const f = frameAt(read, origin, axis)
        if (f) out.push(f)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- memory

const PORTAL = 'портал'

// Why the coordinates matter more here than anywhere else: on the other side
// there is no map, no bed and no landmark the bot knows, and the way home is
// this one rectangle. Written in the shape mc_recall already dumps, so it
// survives a restart and a compaction for free.
function portalNote (rec) {
  const bits = [rec.lit ? 'горит' : 'НЕ ГОРИТ — нужно огниво', `ось ${rec.axis}`]
  if (rec.mine === false) bits.push('не мой, нашёл готовым')
  bits.push(`вставать на ${rec.x},${rec.y},${rec.z}`)
  if (rec.leadsTo) bits.push(`ведёт ${worlds.inWorld(rec.leadsTo.world)} к ${rec.leadsTo.x},${rec.leadsTo.y},${rec.leadsTo.z}`)
  bits.push('самому не заходить — переход только mc_portal mode=enter (он же выводит из портала прибытия)')
  return bits.join('; ')
}

// Ключ — по миру записи (worlds.portalKey): «портал» в верхнем мире, как и
// было, «портал (ад)» в Аду. Раньше одна запись на оба мира, и вызов у портала
// прибытия затёр бы дорогу домой. leadsTo прежней записи того же мира
// сохраняется, если портал тот же (в 4 блоках): его знает только переход.
function rememberPortal (session, rec) {
  const dim = rec.dimension || worlds.worldOf(session.bot)
  const key = worlds.portalKey(dim)
  const old = ((session.journal.state && session.journal.state.places) || {})[key]
  const same = old && worlds.worldOfRecord(old) === dim &&
    Math.abs(old.x - rec.x) <= 4 && Math.abs(old.y - rec.y) <= 4 && Math.abs(old.z - rec.z) <= 4
  const merged = { ...rec, dimension: dim }
  if (!merged.leadsTo && same && old.leadsTo) merged.leadsTo = old.leadsTo
  const full = { ...merged, note: portalNote(merged), seenAt: new Date().toISOString() }
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[key] = full
  })
  session.journal.append(key, full.note, new Vec3(rec.x, rec.y, rec.z))
  return full
}

// Оба мира сразу: какой портал записан где, и до какого можно дойти отсюда.
// forget стирает запись ТЕКУЩЕГО мира (без бота — верхнего): чужой мир отсюда
// не проверить глазами.
function portalNow (session, p: any = {}) {
  const places: any = (session.journal.state && session.journal.state.places) || {}
  const bot = session.bot && session.bot.entity ? session.bot : null
  const here = bot ? worlds.worldOf(bot) : 'overworld'
  const all = {}
  for (const [dim, key] of (Object.entries(worlds.PORTAL_KEYS) as [string, any][])) {
    if (places[key]) all[dim] = { key, ...places[key] }
  }
  const rec = all[here] || null
  if (String(p.mode || '') === 'forget') {
    const dim = worlds.PORTAL_KEYS[p.world] ? p.world : here
    const key = worlds.portalKey(dim)
    session.journal.patch(s => { if (s.places) delete s.places[key] })
    return { mode: 'forget', world: dim, forgot: !!all[dim] }
  }
  const other = (Object.values(all) as any[]).filter(r => worlds.worldOfRecord(r) !== here)
    .map((r : any) => `${worlds.inWorld(worlds.worldOfRecord(r))}: «${r.key}» на ${r.x},${r.y},${r.z}`)
  return {
    mode: 'where',
    world: here,
    portal: rec,
    portals: all,
    note: (rec
      ? `портал ${worlds.inWorld(here)}: ${rec.x},${rec.y},${rec.z} — ${rec.note}`
      : `портала ${worlds.inWorld(here)} в памяти нет` +
        (here === 'overworld' ? ' — построй его там, где сам найдёшь: у базы, а не в случайном штреке' : '')) +
      (other.length ? `. Другие миры (отсюда пешком не дойти): ${other.join('; ')}` : '')
  }
}

// -------------------------------------------------------------- the refusals

// What the brain has to go and get, in the shape format.js already prints
// («▸ нужно: X ×N, в рюкзаке M»).
function obsidianShortfall (bot, need) {
  const have = countOf(bot, FRAME_BLOCK)
  if (have >= need) return null
  const tool = OBSIDIAN_TOOLS.find(t => itemNamed(bot, t))
  const short = need - have
  const where = tool
    ? `ломать есть чем (${tool}), ~${OBSIDIAN_SECONDS}с на блок — это ${Math.ceil(short * OBSIDIAN_SECONDS)}с чистой копки`
    : `и сломать его нечем: обсидиан роняет ТОЛЬКО алмазная или незеритовая кирка (${OBSIDIAN_TOOLS.join(' / ')}), ` +
      'железная разобьёт блок впустую'
  return {
    need: { what: FRAME_BLOCK, count: short, have },
    stopped:
      `Обсидиана ${have} из ${need} — не хватает ${short}. Рама без углов, меньше ${FRAME_MIN} не бывает. ` +
      `Искать на дне лавовых озёр (y от -10 и ниже) и в разрушенных порталах; ${where}.`
  }
}

// The scaffolding is cheap but not free, and running out of it mid-frame is
// the failure that leaves eight blocks standing and two in the bag. Obsidian is
// deliberately not allowed to become a prop: that would quietly spend an
// eleventh block on a cell the game never looks at.
function propShortfall (bot, props) {
  if (!props || !props.length) return null
  if (pickFiller(bot)) return null
  // Число вынесено в скобки, а не склеено со словом: «нужно 1 подпорок»
  // читается как баг в демоне, а не как число, по которому надо действовать.
  return {
    need: { what: 'cobblestone', count: props.length, have: 0 },
    stopped:
      `Раме не хватает подпорок в углах (${props.length} шт.; без них верхние блоки не к чему прислонить), ` +
      'а строить ими нечего: нужен любой булыжник, дипслейт или доски. Обсидиан на подпорки не трачу — ' +
      'игра углы не проверяет, и это был бы одиннадцатый блок впустую.'
  }
}

function igniterShortfall (bot) {
  const found = IGNITERS.find(n => itemNamed(bot, n))
  if (found) return null
  const iron = countOf(bot, 'iron_ingot')
  const flint = countOf(bot, 'flint')
  return {
    need: { what: 'flint_and_steel', count: 1, have: 0 },
    stopped:
      'Зажечь нечем: нужно flint_and_steel. Рецепт бесформенный, iron_ingot + flint, ' +
      `в 2x2 — верстак не нужен (в рюкзаке железа ${iron}, кремня ${flint}). ` +
      `Кремень падает с гравия примерно раз из десяти (${Math.round(1 / FLINT_PER_GRAVEL)} гравия на кремень), ` +
      'с fortune III — с каждого. fire_charge тоже зажёг бы, но огненный порошок сам за этим порталом.'
  }
}


// ------------------------------------------------------------ linking

// Единый контракт для кампании и link. Кирка не заменяет обсидиан в рюкзаке:
// разбор рамы — отдельное явно выбранное действие travel.takeFrame.
function exitKit (inventory) {
  const items = inventory && inventory.inventory && inventory.inventory.items ? inventory.inventory.items() : null
  const n = name => items ? items.filter(i => i.name === name && (!i.maxDurability || (i.durabilityUsed || 0) < i.maxDurability)).reduce((s, i) => s + i.count, 0) : Number(inventory && inventory[name]) || 0
  const obsidian = n(FRAME_BLOCK)
  const lighter = IGNITERS.find(name => n(name) > 0) || null
  const need = []
  if (obsidian < FRAME_MIN) need.push({ what: FRAME_BLOCK, count: FRAME_MIN, have: obsidian })
  if (!lighter) need.push({ what: 'flint_and_steel', count: 1, have: 0 })
  return { ready: need.length === 0, obsidian, lighter, need }
}

export {
  standSpots, standable, judge, planPortal, frameAt, findFrames, PORTAL, portalNote, rememberPortal, portalNow,
  obsidianShortfall, propShortfall, igniterShortfall, exitKit
}

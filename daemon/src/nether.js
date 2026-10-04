'use strict'
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { xyz, stuckGuard, unstick } = require('./movement')
const { placeBlockAt, pickFiller, withTimeout, waitForBlock } = require('./build')
const { itemNamed, countOf, equipBestTool, missingHarvestTool } = require('./items')
const worlds = require('./worlds')

// The fourth milestone: a way out of the overworld. `build` is deliberately
// narrow — frame, fire, and the coordinates in memory; it never walks in (see
// WHY_NOT_THROUGH). Going through is `enter` at the bottom of this file: its own
// memory per world (worlds.js portalKey) and its own witness of arrival
// (worlds.js installWorldTracker).

// ---------------------------------------------------------------- the shape

// Read out of the server we actually run, not out of memory: paper-1.21.11.jar,
// net/minecraft/world/level/portal/PortalShape — MIN_WIDTH=2, MAX_WIDTH=21,
// MIN_HEIGHT=3, MAX_HEIGHT=21 (ConstantValue attributes on the static fields).
// So the smallest portal is a 2x3 hole.
const INNER_W = 2
const INNER_H = 3

// Ten, not fourteen. In the same class, calculateWidth walks the bottom row
// only under the interior (getDistanceUntilEdgeAboveFrame: cell must be empty
// AND the block below it must be FRAME), and hasTopFrame loops i from 0 to
// width-1 — the interior width, not width+2. Neither ever looks at a corner, so
// the four corner cells are not part of the frame at all.
const FRAME_MIN = 2 + 2 + INNER_H * 2

// FRAME in that class is `state.is(Blocks.OBSIDIAN)` — obsidian and nothing
// else. crying_obsidian does not count, and neither does anything that merely
// looks like stone.
const FRAME_BLOCK = 'obsidian'

// PortalShape.isEmpty = isAir() || is(BlockTags.FIRE) || is(NETHER_PORTAL).
// Water, lava, a torch or a slab in the hole all break the shape, which is why
// the interior is checked and cleared rather than assumed.
const PORTAL_EMPTY = /^(air|cave_air|void_air|fire|soul_fire|nether_portal)$/

// What lights it. flint_and_steel is the only one the bot can actually make
// before it has been to the Nether: minecraft-data 1.21.11 gives it a shapeless
// recipe of [iron_ingot, flint] — two ingredients, so it fits the 2x2 grid and
// needs no crafting table. fire_charge needs blaze powder, which is behind the
// portal it would be lighting; it is accepted only because a chest or a player
// can hand one over.
const IGNITERS = ['flint_and_steel', 'fire_charge']

// Where flint comes from, for the refusal that has to say something useful:
// paper-1.21.11.jar data/minecraft/loot_table/blocks/gravel.json — a
// table_bonus with chances [0.1, 0.142857, 0.25, 1.0], so one flint per ten
// gravel bare-handed and one per gravel with fortune III.
const FLINT_PER_GRAVEL = 0.1

// Obsidian breaks only for a diamond or netherite pickaxe: minecraft-data
// 1.21.11 blocks.json, obsidian (id 192) harvestTools = {938: diamond_pickaxe,
// 943: netherite_pickaxe}. An iron pickaxe destroys the block and drops
// nothing, which is the worst possible way to spend a minute.
const OBSIDIAN_TOOLS = ['diamond_pickaxe', 'netherite_pickaxe']

// 50 hardness * 1.5 / 8 (diamond tier speed) = 9.375s per block in the game.
// NOT what mineflayer will tell you: minecraft-data's materials table for
// obsidian's material ("incorrect_for_wooden_tool") lists only wooden tools, so
// prismarine-block finds no speed multiplier for a diamond pickaxe, falls back
// to speed 1 and answers bot.digTime(obsidian) = 75000ms. bot.dig() survives
// that only because the server breaks the block on its own and the blockUpdate
// clears the timer. Anything that wraps a dig in a timeout must leave room for
// the real 9.4s and not for the 75 the library predicts — mining.js:214 already
// uses 20000ms, so `mine obsidian` works; a 8s wrapper would not.
const OBSIDIAN_SECONDS = 9.4

// ---------------------------------------------------------------- geometry

const AXES = { x: new Vec3(1, 0, 0), z: new Vec3(0, 0, 1) }
const UP = new Vec3(0, 1, 0)

// `origin` is the bottom-left interior cell — the one the fire goes into.
const at = (origin, u, i, j) => origin.offset(u.x * i, j, u.z * i)

function innerCells (origin, axis) {
  const u = AXES[axis]
  const out = []
  for (let j = 0; j < INNER_H; j++) for (let i = 0; i < INNER_W; i++) out.push(at(origin, u, i, j))
  return out
}

// In build order, and the order is load-bearing. mineflayer can only place a
// block *against* a neighbour, so every cell here has to have one already
// standing by the time its turn comes: bottom row first (it leans on the
// ground), then each side column bottom-up, then the top row.
function frameCells (origin, axis) {
  const u = AXES[axis]
  return [
    at(origin, u, 0, -1), at(origin, u, 1, -1),
    at(origin, u, -1, 0), at(origin, u, -1, 1), at(origin, u, -1, 2),
    at(origin, u, 2, 0), at(origin, u, 2, 1), at(origin, u, 2, 2),
    at(origin, u, 0, 3), at(origin, u, 1, 3)
  ]
}

// The four cells the game never looks at. Reported so the answer can prove it
// built ten and not fourteen, and used as scaffolding below.
function cornerCells (origin, axis) {
  const u = AXES[axis]
  return [at(origin, u, -1, -1), at(origin, u, 2, -1), at(origin, u, -1, 3), at(origin, u, 2, 3)]
}

// The corner that props up a frame cell with nothing else to lean on. The two
// side columns start one block above a bottom corner; the top row sits one
// block above the interior, whose own neighbours are all empty by definition —
// its only handhold is a top corner, and that corner in turn leans on the side
// column we just finished. So the props are always corners, and they go in
// only when the world offers nothing better.
function propFor (origin, axis, cell) {
  const u = AXES[axis]
  const k = c => `${c.x},${c.y},${c.z}`
  // Каждой клетке — СВОЙ угол, со своей стороны. Первая версия отдавала обоим
  // верхним блокам один левый угол, а до правого от него два блока: правый
  // верхний мог опереться только на левый верхний, и когда тот не встал, ряд
  // лёг парой. Измерено в игре: «1799,74,-1: ответа от сервера нет», сразу за
  // ним «1800,74,-1: не к чему прислонить блок». Теперь опора каждого блока
  // идёт вниз до земли своей цепочкой и от чужой неудачи не зависит.
  const map = new Map([
    [k(at(origin, u, -1, 0)), at(origin, u, -1, -1)], // низ левой стойки -> левый нижний угол
    [k(at(origin, u, 2, 0)), at(origin, u, 2, -1)], // низ правой стойки -> правый нижний угол
    [k(at(origin, u, 0, 3)), at(origin, u, -1, 3)], // левый верхний -> левый верхний угол
    [k(at(origin, u, 1, 3)), at(origin, u, 2, 3)] // правый верхний -> правый верхний угол
  ])
  return map.get(k(cell)) || null
}

// ---------------------------------------------------------------- world reads

const isSolid = b => !!b && b.boundingBox === 'block'
const isFluid = b => !!b && /^(water|lava|bubble_column|flowing_water|flowing_lava)$/.test(b.name)
const isPortalEmpty = b => !!b && PORTAL_EMPTY.test(b.name)

// Somebody's things. A portal is not worth a stolen chest or a broken bed, and
// the bot has no way to tell its own base from a stranger's.
const PROTECTED = /chest|barrel|shulker|furnace|smoker|anvil|_bed$|crafting_table|enchanting_table|brewing_stand|beacon|spawner|respawn_anchor|lodestone|_sign$|_banner$|bedrock|_door$|ladder|rail/

// A block reader that answers for a stub world just as well as for a real one.
// Every planning decision below goes through this and nothing else, which is
// what makes the plan testable without a server.
function reader (bot) {
  return pos => bot.blockAt(pos)
}

function neighbours (pos) {
  return [
    pos.offset(0, -1, 0), pos.offset(0, 1, 0),
    pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
    pos.offset(0, 0, 1), pos.offset(0, 0, -1)
  ]
}

// ---------------------------------------------------------------- the plan

const PLACE_RADIUS = 4
const MAX_DIG = 16
// One block of air between us and lava is not clearance: lava spreads, and
// standing next to a source while placing ten blocks is the shape of every
// burn death in the journal.
const LAVA_KEEP = 2
// Water only matters where it can flow into the hole and stop the shape from
// forming; two blocks is how far a source reaches on flat ground.
const WATER_KEEP = 2
// The server measures interaction range from the eyes, not from the feet
// (block_interaction_range, 4.5 by default on 1.21). Measuring from the feet
// makes a block three above your head look out of reach when it is not, and
// then the body walks somewhere it had no business going.
const REACH = 4.2
const eyes = bot => bot.entity.position.offset(0, bot.entity.height || 1.62, 0)
const eyesAt = p => p.offset(0.5, 1.62, 0.5)
const centre = p => p.offset(0.5, 0.5, 0.5)

function chebyshev (a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z))
}

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

function standable (read, p, { allowDig = true } = {}) {
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
function planPortal (read, me, { axis = null, radius = PLACE_RADIUS } = {}) {
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
function portalNow (session, p = {}) {
  const places = (session.journal.state && session.journal.state.places) || {}
  const bot = session.bot && session.bot.entity ? session.bot : null
  const here = bot ? worlds.worldOf(bot) : 'overworld'
  const all = {}
  for (const [dim, key] of Object.entries(worlds.PORTAL_KEYS)) {
    if (places[key]) all[dim] = { key, ...places[key] }
  }
  const rec = all[here] || null
  if (String(p.mode || '') === 'forget') {
    const dim = worlds.PORTAL_KEYS[p.world] ? p.world : here
    const key = worlds.portalKey(dim)
    session.journal.patch(s => { if (s.places) delete s.places[key] })
    return { mode: 'forget', world: dim, forgot: !!all[dim] }
  }
  const other = Object.values(all).filter(r => worlds.worldOfRecord(r) !== here)
    .map(r => `${worlds.inWorld(worlds.worldOfRecord(r))}: «${r.key}» на ${r.x},${r.y},${r.z}`)
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

// ---------------------------------------------------------------- doing it

function sleep (ms, ctl) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { clearTimeout(t); resolve() })
  })
}

async function walkNear (session, ctl, target, range = 1) {
  const bot = session.bot
  if (bot.entity.position.distanceTo(target.offset(0.5, 0, 0.5)) <= range + 0.5) return { ok: true, walked: false }
  const guard = stuckGuard(bot, ctl)
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, range)),
      guard.promise
    ])
    return { ok: true, walked: true }
  } catch (e) {
    try { bot.pathfinder.setGoal(null) } catch {}
    await unstick(bot)
    return { ok: false, walked: true, error: e.message }
  } finally {
    guard.stop()
  }
}

// The server refuses a dig or a placement past the interaction range (4.5 on
// 1.21), and every refusal is silent — the block simply stays. A site chosen
// four blocks away can have a far corner seven blocks off, so the body walks to
// whatever it is about to touch instead of reaching for it.
async function inReach (session, ctl, cell) {
  const bot = session.bot
  if (eyes(bot).distanceTo(centre(cell)) <= REACH) return true
  await walkNear(session, ctl, cell, 2)
  return eyes(bot).distanceTo(centre(cell)) <= REACH + 0.5
}

async function clearCells (session, ctl, cells) {
  const bot = session.bot
  let dug = 0
  for (const c of cells) {
    if (ctl.aborted) return { dug, stopped: 'прервано' }
    const b = bot.blockAt(c)
    if (!b) return { dug, stopped: `клетка ${c.x},${c.y},${c.z} не прогружена` }
    if (PORTAL_EMPTY.test(b.name)) continue
    if (/water|lava/.test(b.name)) return { dug, stopped: `${b.name} внутри рамы — сначала заделать источник` }
    if (!(await inReach(session, ctl, c))) return { dug, stopped: `до ${b.name} на ${c.x},${c.y},${c.z} не дотянуться` }
    if (!require('./sight').seesBlock(bot, b)) return { dug, stopped: `${b.name} не виден в прицеле` }
    const problem = missingHarvestTool(bot, b, session.mcData)
    const byHand = problem && (b.hardness ?? 99) >= 0 && (b.hardness ?? 99) <= 2 && !/obsidian|bedrock|portal/.test(b.name)
    if (problem && !byHand) return { dug, stopped: problem }
    try {
      await equipBestTool(bot, b)
      // 20s and not 8: the same wrapper mining.js uses. Nothing here is
      // obsidian, but gravel refilling the slot and a dropped swing both cost
      // whole seconds, and a wrapper that fires early leaves a half-cleared hole.
      await withTimeout(bot.dig(b), 20000, `${b.name} не ломается`)
      dug++
      await sleep(120, ctl)
      const after = bot.blockAt(c)
      if (!after || !PORTAL_EMPTY.test(after.name)) return { dug, stopped: `${b.name} остался на ${c.x},${c.y},${c.z} после копки` }
    } catch (e) {
      return { dug, stopped: `${b.name} на ${c.x},${c.y},${c.z}: ${e.message}` }
    }
  }
  return { dug }
}

// Один блок рамы, а потом вопрос МИРУ, а не возвращаемому значению.
//
// «ответа от сервера нет» — это build.withTimeout, то есть НАШ поводок, а не
// ответ сервера: mineflayer шлёт пакет и ждёт blockUpdate до 5000 мс
// (mineflayer/lib/plugins/place_block.js:13) и только после этого говорит своё
// «No block has been placed». Поводок короче пяти секунд обрывает собственную
// библиотеку и печатает своё молчание как чужой отказ — в первом прогоне так и
// пропал верхний блок рамы (1799,74,-1). Отсюда две вещи: поводок с запасом над
// этими пятью секундами и ещё одно чтение мира после него, потому что блок мог
// встать, пока мы уже не слушали.
// Сколько ждать подтверждения одной постановки. Вынесено отдельно и наружу,
// чтобы это число можно было сверить с библиотекой, а не с памятью: заглушка
// вычитывает `timeout: 5000` прямо из place_block.js и требует, чтобы наш
// поводок был длиннее. Треть остатка — потому что placeBlockAt тратит поводок
// на КАЖДУЮ пригодную грань, а бюджет должен пережить клетку, а не попытку.
const MINEFLAYER_PLACE_WAIT_MS = 5000
function placeLeash (leftMs) {
  return Math.max(MINEFLAYER_PLACE_WAIT_MS + 1500, Math.min(6500, Math.floor(leftMs / 3)))
}

async function putFrameBlock (bot, at, item, leftMs) {
  const leash = placeLeash(leftMs)
  const r = await placeBlockAt(bot, at, { item: item || undefined, timeoutMs: leash })
  if (r.ok) return { ok: true, already: !!r.already }
  await sleep(250) // пакет мог быть ещё в воздухе, когда поводок кончился
  const now = bot.blockAt(at)
  if (now && now.boundingBox === 'block' && (!item || now.name === item)) return { ok: true, late: true }
  return { ok: false, why: r.reason }
}

async function buildFrame (session, ctl, plan, deadline) {
  const bot = session.bot
  const propped = []
  const failed = new Map()
  const k = c => `${c.x},${c.y},${c.z}`
  let placed = 0
  let late = 0
  let attempts = 0

  // Опора спрашивается по живому миру, а не по плану: расчистка могла убрать
  // тот самый блок, на который план рассчитывал. Клетки дырки опорой не
  // считаются никогда — они обязаны остаться пустыми.
  const supported = c => neighbours(c).some(n => {
    const b = bot.blockAt(n)
    return isSolid(b) && !isFluid(b) && !plan.inner.some(i => i.equals(n))
  })

  // Подпорка в свой угол — и только когда клетке правда не на что опереться.
  const propUp = async (c) => {
    if (supported(c)) return
    const prop = propFor(plan.origin, plan.axis, c)
    const pb = prop && bot.blockAt(prop)
    if (!prop || !pb || pb.boundingBox !== 'empty') return
    const filler = pickFiller(bot)
    const pr = await putFrameBlock(bot, prop, filler ? filler.name : null, deadline - Date.now())
    if (pr.ok && !pr.already) propped.push(xyz(prop))
  }

  // Повтор делается НА МЕСТЕ, а не следующим кругом. Разница не в упрямстве, а
  // в том, на что опирается соседняя клетка: цепочка опор идёт снизу вверх, и
  // пока клетка пуста, следующая за ней вынуждена звать свой угол. Измерено в
  // игре: верхний левый блок сорвался один раз, верхний правый из-за этого
  // потребовал вторую подпорку, и рама собралась в два прохода (passes: 2,
  // props: оба верхних угла). Вторая попытка тут же стоит одного поводка,
  // проход — поводка на каждую оставшуюся клетку.
  const ATTEMPTS = 2
  const putOne = async (c) => {
    const existing = bot.blockAt(c)
    if (existing && existing.name === FRAME_BLOCK) { failed.delete(k(c)); return true }
    if (!(await inReach(session, ctl, c))) { failed.set(k(c), 'не дотянуться'); return false }
    let why = null
    for (let n = 0; n < ATTEMPTS && !ctl.aborted && Date.now() < deadline; n++) {
      if (n) { attempts++; await sleep(300, ctl) }
      await propUp(c)
      const r = await putFrameBlock(bot, c, FRAME_BLOCK, deadline - Date.now())
      if (r.ok) {
        if (!r.already) placed++
        if (r.late) late++
        failed.delete(k(c))
        return true
      }
      why = r.why
    }
    failed.set(k(c), why)
    return false
  }

  // Два круга, и второй — честная норма, а не запас на глупость. Порядок опор
  // детерминированный (каждая клетка опирается на поставленное раньше или на
  // свой угол), но УСПЕХ постановки нам не принадлежит: сервер вправе отказать.
  // Один отказ подряд съедает повтор на месте выше, и тогда круг один. Два
  // отказа подряд — это уже не дрожание, и тогда второй круг доносит клетку
  // после того, как соседи встали. Проверено по заглушке: один отказ -> passes 1,
  // два подряд -> passes 2 и рама всё равно целая.
  let passes = 0
  for (let pass = 0; pass < 2 && !ctl.aborted; pass++) {
    passes++
    let missing = 0
    for (const c of plan.frame) {
      if (ctl.aborted || Date.now() > deadline) break
      const b = bot.blockAt(c)
      if (b && b.name === FRAME_BLOCK) continue
      if (!(await putOne(c))) missing++
    }
    if (!missing) break
    await sleep(400, ctl)
  }

  const standing = plan.frame.filter(c => {
    const b = bot.blockAt(c)
    return b && b.name === FRAME_BLOCK
  }).length

  return {
    placed,
    late: late || undefined,
    retries: attempts || undefined,
    // Кругов, а не попыток. Второе чтение мира внутри putFrameBlock стоит
    // 250 мс и экономит целый круг: без него опоздавший блок замечает только
    // следующий проход, а проход — это поводок на каждую оставшуюся клетку,
    // то есть секунды из бюджета, за которые портал должен успеть загореться.
    passes,
    standing,
    propped,
    failed: failed.size ? [...failed].map(([at, why]) => `${at}: ${why}`) : undefined
  }
}

// Right-click the top of a bottom frame block with flint and steel: the fire
// lands in the interior cell above it, and BaseFireBlock.onPlace runs
// PortalShape and fills the hole. bot.activateBlock would do, but _genericPlace
// is what build.js already uses for exactly this reason — mineflayer's
// placeBlock waits for a block update the 1.21.11 server does not always send
// for the cell you aimed at, and here the cell turns into nether_portal rather
// than into fire, which is a different update again. So: fire the packet, then
// read the world.
async function ignite (session, ctl, plan) {
  const bot = session.bot
  const item = IGNITERS.map(n => itemNamed(bot, n)).find(Boolean)
  if (!item) return { lit: false, reason: 'зажигать нечем' }
  try { await bot.equip(item, 'hand') } catch (e) { return { lit: false, reason: e.message } }

  const u = AXES[plan.axis]
  // Two aims, both landing fire in the bottom-left interior cell: the top face
  // of the frame block under it, and the inward face of the column beside it.
  const aims = [
    { ref: at(plan.origin, u, 0, -1), face: UP },
    { ref: at(plan.origin, u, 1, -1), face: UP },
    { ref: at(plan.origin, u, -1, 0), face: new Vec3(u.x, 0, u.z) }
  ]

  const tried = []
  for (let round = 0; round < 2 && !ctl.aborted; round++) {
    for (const aim of aims) {
      if (ctl.aborted) break
      const ref = bot.blockAt(aim.ref)
      if (!ref || ref.name !== FRAME_BLOCK) continue
      const target = aim.ref.plus(aim.face)
      if (eyes(bot).distanceTo(centre(aim.ref)) > REACH) {
        tried.push(`${aim.ref.x},${aim.ref.y},${aim.ref.z}: далеко`)
        continue
      }
      try {
        await bot._genericPlace(ref, aim.face, { forceLook: true, swingArm: 'right' })
      } catch (e) {
        tried.push(e.message.slice(0, 60))
        continue
      }
      // Poll rather than wait on an event: fire and nether_portal are two
      // different block updates in the same cell within a tick or two.
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const b = bot.blockAt(target)
        if (b && b.name === 'nether_portal') return { lit: true, aim: xyz(aim.ref) }
        await sleep(100, ctl)
      }
      const now = bot.blockAt(target)
      tried.push(`${aim.ref.x},${aim.ref.y},${aim.ref.z}: получилось ${now ? now.name : '?'}`)
    }
    await sleep(400, ctl)
  }
  return { lit: false, reason: `огонь не поджёг портал (${tried.slice(0, 3).join('; ')})` }
}

function countLit (bot, plan) {
  return plan.inner.filter(c => {
    const b = bot.blockAt(c)
    return b && b.name === 'nether_portal'
  }).length
}

// What waits on the other side, and why this intent stops at the doorway. Not
// a mood — three concrete things break the moment the dimension changes:
//   * places. session.js:779 writes {x,y,z,note} and nothing else; journal.js
//     documents a `dimension` field that no writer fills and no reader checks.
//     Every remembered coordinate silently becomes a lie about another world,
//     and the Nether compresses x/z by 8, so "база на 300,64,-120" points at
//     37,?,-15 over there.
//   * the way back. Deaths are stored the same way, so `recover` would walk
//     overworld coordinates in the Nether; and a bed there explodes, so the
//     spawn point cannot be moved closer.
//   * the body. pathfinder's Movements are built once per inventory signature
//     from the world it was standing in (session.updateMovements), and the
//     ground over there is netherrack over lava with no water to break a fall.
// So: frame, fire, coordinates. Going through is its own intent with its own
// memory, and it should start from a portal whose coordinates are already
// written down — which is what this one leaves behind.
const WHY_NOT_THROUGH =
  'Стройка в портал не заходит: за ним другое измерение. Переход — отдельный вызов mc_portal mode=enter: ' +
  'он дойдёт до этой рамы, шагнёт внутрь, дождётся смены мира, выйдет из портала прибытия и запишет пару ' +
  'порталов, каждый со своим миром. В Аду x/z сжаты в 8 раз, кровать взрывается, точку возрождения туда не ' +
  'перенести — огниво брать с собой обязательно.'

async function portal (session, ctl, p = {}) {
  if (p.mode === 'link') return link(session, ctl, p)
  const bot = session.bot
  const mcData = session.mcData
  const read = reader(bot)
  const me = bot.entity.position.floored()
  const scan = Math.max(4, Math.min(32, p.scan ?? 16))
  // Бюджет на всю работу, а не на попытку. Из него putFrameBlock берёт себе
  // поводок на клетку, и из-за него десять безнадёжных клеток по шесть граней
  // не могут съесть весь интент. Пять секунд с конца — на поджиг и на ответ.
  const deadline = Date.now() + Math.max(20, Math.min(600, p.timeoutSeconds ?? 150)) * 1000 - 5000

  // --- 1. is there already one? Never build a second, never break the first.
  // Asked two ways on purpose. bot.findBlock spots the portal blocks even when
  // the obsidian around them is out of scan range; findFrames spots a frame
  // whose portal blocks somehow are not in the search result. Either one alone
  // would let the bot adopt a burning portal as its own — which is what the
  // sabotage run did when the first check was removed.
  const obsidianNear = bot.findBlocks({
    matching: [mcData.blocksByName[FRAME_BLOCK].id], maxDistance: scan, count: 64
  })
  const frames = findFrames(read, obsidianNear)
  const burning = frames.find(f => f.lit) || null
  const portalIds = [mcData.blocksByName.nether_portal.id]
  const lit = bot.findBlock({ matching: portalIds, maxDistance: scan }) ||
    (burning ? bot.blockAt(burning.origin) : null)
  if (lit) {
    const found = burning
    const stand = found
      ? (standSpots(found.origin, found.axis, [...found.inner, ...frameCells(found.origin, found.axis)])
          .map(s => standable(read, s.pos, { allowDig: false })).find(Boolean) || {}).pos
      : null
    const where = stand || lit.position
    const rec = rememberPortal(session, {
      ...xyz(where),
      dimension: bot.game ? bot.game.dimension : null,
      axis: found ? found.axis : '?',
      inner: found ? xyz(found.origin) : xyz(lit.position),
      lit: true,
      mine: false
    })
    return {
      mode: 'already',
      built: false,
      lit: true,
      already: { ...xyz(lit.position), portalBlocks: found ? found.portalBlocks : null },
      place: rec,
      note: `Портал уже горит на ${lit.position.x},${lit.position.y},${lit.position.z} — второй не строю и этот не ломаю. ` +
        `Записал в память как «${PORTAL}». ` + WHY_NOT_THROUGH
    }
  }

  // --- 2. a finished but unlit frame is worth a match, not ten more obsidian.
  // Also what makes the intent safe to call twice: an interrupted run leaves a
  // frame behind, and the second call finishes it instead of starting another.
  const ready = frames.find(f => !f.lit) || null

  let plan = null
  if (ready) {
    const envelope = [...ready.inner, ...frameCells(ready.origin, ready.axis), ...cornerCells(ready.origin, ready.axis)]
    const spot = standSpots(ready.origin, ready.axis, envelope)
      .map(s => {
        const ok = standable(read, s.pos, { allowDig: false })
        return ok && { ...ok, rank: s.rank }
      }).filter(Boolean)
      .sort((a, b) => a.rank - b.rank || a.pos.distanceTo(me) - b.pos.distanceTo(me))[0]
    if (spot) {
      plan = {
        axis: ready.axis,
        origin: ready.origin,
        inner: ready.inner,
        frame: frameCells(ready.origin, ready.axis),
        corners: cornerCells(ready.origin, ready.axis),
        props: [],
        dig: spot.dig,
        stand: spot.pos,
        needObsidian: 0,
        adopted: true
      }
    }
  }

  // --- 3. otherwise pick a site.
  if (!plan) {
    const site = planPortal(read, me, { axis: p.axis || null, radius: Math.max(2, Math.min(8, p.radius ?? PLACE_RADIUS)) })
    if (!site.ok) {
      return {
        mode: 'build',
        built: false,
        lit: false,
        stopped: `Места под раму нет: ${site.reasons.join(', ')}. ` +
          `Нужен свободный прямоугольник ${INNER_W + 2}x${INNER_H + 2} в одной плоскости плюс клетка встать рядом. ` +
          'Отойди на открытое место, или прокопай камеру (mc_tunnel), или убери лаву булыжником — и позови снова.',
        note: WHY_NOT_THROUGH
      }
    }
    plan = site.plan
  }

  // --- 4. refuse before touching the world, and name everything that is short.
  const shortObsidian = plan.needObsidian ? obsidianShortfall(bot, plan.needObsidian) : null
  const shortProps = propShortfall(bot, plan.props)
  const shortIgniter = p.frameOnly ? null : igniterShortfall(bot)
  if (shortObsidian || shortProps || shortIgniter) {
    const first = shortObsidian || shortProps || shortIgniter
    return {
      mode: 'build',
      built: false,
      lit: false,
      site: { ...xyz(plan.origin), axis: plan.axis, frame: FRAME_MIN, needObsidian: plan.needObsidian },
      need: first.need,
      stopped: [shortObsidian && shortObsidian.stopped, shortProps && shortProps.stopped,
        shortIgniter && shortIgniter.stopped].filter(Boolean).join(' '),
      note: shortObsidian && !shortIgniter && plan.needObsidian
        ? 'Место под раму нашёл и держу — обсидиан принеси, и позови снова. ' + WHY_NOT_THROUGH
        : WHY_NOT_THROUGH
    }
  }

  // --- 5. stand clear, clear the hole, build, light.
  const walk = await walkNear(session, ctl, plan.stand, 1)
  // И новая, и уже собранная рама: все шесть клеток отверстия, сверху вниз.
  // V2-30: принятая готовая рама чистила лишь место для ног, незерак внутри оставался.
  const digCells = [...new Map([...plan.dig, ...plan.inner].map(c => [c.toString(), c])).values()].sort((a, b) => b.y - a.y)
  const cleared = await clearCells(session, ctl, digCells)
  if (cleared.stopped) {
    return {
      mode: 'build',
      built: false,
      lit: false,
      site: { ...xyz(plan.origin), axis: plan.axis },
      dug: cleared.dug,
      stopped: `Не расчистил место под раму: ${cleared.stopped}`,
      note: 'Рама ещё не тронута, обсидиан цел. ' + WHY_NOT_THROUGH
    }
  }

  const built = plan.adopted
    ? { placed: 0, standing: FRAME_MIN, propped: [], passes: 0 }
    : await buildFrame(session, ctl, plan, deadline)
  if (built.standing < FRAME_MIN) {
    // Статус интента остаётся done, и это не оговорка: runIntent говорит done
    // про «интент завершился», а не про «сделал что просили» — ровно так же
    // штатно останавливаются на полпути dig_down, tunnel и surface, и это
    // написано в шапке инструментов. Но «done» рядом с «портала нет» читается
    // как успех, поэтому первое слово отказа — приговор, а не описание: строку
    // stopped format.js печатает как «⚠ встал: ...» раньше всего остального.
    // Память при этом НЕ трогаем: недостроенная рама под именем «портал» —
    // это обещание дороги в Ад, которой нет.
    return {
      mode: 'build',
      built: false,
      lit: false,
      portalBlocks: 0,
      site: { ...xyz(plan.origin), axis: plan.axis },
      frame: {
        standing: built.standing,
        of: FRAME_MIN,
        placed: built.placed,
        late: built.late,
        retries: built.retries,
        passes: built.passes,
        failed: built.failed
      },
      stopped: `ПОРТАЛА НЕТ: рама неполная, ${built.standing} блоков из ${FRAME_MIN}. ` +
        (built.failed ? `Не встали: ${built.failed.slice(0, 3).join('; ')}. ` : '') +
        'Позови ещё раз — повтор выбирает эту же площадку и доставляет только недостающие блоки, ' +
        'а не начинает вторую раму рядом.',
      note: 'В память ничего не записал: незажжённый портал под этим именем — обещание дороги, которой нет. ' +
        WHY_NOT_THROUGH
    }
  }

  // The body must not be in the hole when it catches: four seconds inside a lit
  // portal is a dimension change nobody asked for.
  const feet = bot.entity.position.floored()
  if (plan.inner.some(c => c.equals(feet) || c.equals(feet.offset(0, -1, 0)) || c.equals(feet.offset(0, 1, 0)))) {
    await walkNear(session, ctl, plan.stand, 0)
  }

  const blocked = plan.inner.find(c => { const b = bot.blockAt(c); return !b || !PORTAL_EMPTY.test(b.name) })
  if (blocked) return { mode: 'build', built: true, lit: false, stopped: `отверстие рамы не расчищено: ${blocked.x},${blocked.y},${blocked.z}` }
  const fire = await ignite(session, ctl, plan)
  await sleep(300, ctl)
  const portalBlocks = countLit(bot, plan)
  const inside = plan.inner.some(c => c.equals(bot.entity.position.floored()))

  const rec = rememberPortal(session, {
    ...xyz(plan.stand),
    dimension: bot.game ? bot.game.dimension : null,
    axis: plan.axis,
    inner: xyz(plan.origin),
    lit: portalBlocks > 0,
    mine: true
  })

  const detail = {
    mode: 'build',
    built: true,
    lit: portalBlocks > 0,
    adopted: !!plan.adopted,
    axis: plan.axis,
    inner: xyz(plan.origin),
    stand: xyz(plan.stand),
    frame: {
      obsidian: FRAME_MIN,
      placed: built.placed,
      late: built.late,
      retries: built.retries,
      passes: built.passes,
      corners: 'пустые — игра их не проверяет',
      props: built.propped && built.propped.length ? built.propped : undefined
    },
    portalBlocks,
    dug: cleared.dug,
    walked: walk.walked || undefined,
    place: rec,
    inside: inside || undefined
  }

  if (portalBlocks === INNER_W * INNER_H) {
    detail.note =
      `Портал горит: ${portalBlocks} клеток, рама ${FRAME_MIN} обсидиана (углы пустые). ` +
      `Вход с ${rec.x},${rec.y},${rec.z}, записал в память как «${PORTAL}». ` + WHY_NOT_THROUGH
  } else if (portalBlocks > 0) {
    detail.stopped = `ПОРТАЛ НЕПОЛНЫЙ: клеток ${portalBlocks} из ${INNER_W * INNER_H} — посмотри, что лежит внутри рамы.`
    detail.note = WHY_NOT_THROUGH
  } else {
    detail.stopped = `ПОРТАЛА НЕТ: рама стоит (${FRAME_MIN} обсидиана), а огонь не взялся: ${fire.reason}. ` +
      'Проверь, что внутри рамы только воздух, и позови снова — обсидиан переставлять не надо.'
    detail.note = WHY_NOT_THROUGH
  }
  return detail
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

// Связанный портал: рама там, где сервер свяжет её с порталом другого мира.
// Факты (paper-1.21.11, SPEEDRUN.md): coordinate_scale Ада 8 — точка в Аду =
// верх/8; PortalForcer ищет готовый портал в 16 блоках от точки в Аду и в 128
// наверху, иначе строит свой в 16. Цель — x,z в координатах ДРУГОГО мира; без
// них — записанный портал того мира (дом). Дойти до точки здесь (отрезками и
// штреком), сложить раму обычной стройкой и зажечь. Слепой переход спидраннеров:
// в Аду x,z = место назначения наверху (крепость, база) — выйдешь в ~16 от него.
async function link (session, ctl, p = {}) {
  const bot = session.bot
  const t0 = Date.now()
  const deadline = t0 + Math.max(30, Math.min(600, p.timeoutSeconds ?? 300)) * 1000 - 5000
  const here = worlds.worldOf(bot)
  const other = here === 'the_nether' ? 'overworld' : 'the_nether'
  const places = (session.journal.state && session.journal.state.places) || {}
  const rec = places[worlds.portalKey(other)]
  const src = Number.isFinite(p.x) && Number.isFinite(p.z)
    ? { x: p.x, z: p.z, from: 'задано' }
    : rec && worlds.worldOfRecord(rec) === other ? { x: rec.x, z: rec.z, from: `«${worlds.portalKey(other)}»` } : null
  const base = { mode: 'link', world: here }
  if (!src) {
    return { ...base, built: false, stopped: `С чем связывать — не знаю: портала ${worlds.inWorld(other)} в памяти нет. Дай x,z в координатах ${worlds.ofWorld(other)}.` }
  }
  const k = worlds.scaleOf(other) / worlds.scaleOf(here)
  const target = { x: Math.floor(src.x * k), z: Math.floor(src.z * k) }
  // Отказ до дороги: без обсидиана и огнива идти незачем.
  const obs = obsidianShortfall(bot, FRAME_MIN)
  const ign = IGNITERS.some(n => itemNamed(bot, n)) ? null : igniterShortfall(bot)
  if (obs || ign) {
    return { ...base, built: false, target, source: src, need: (obs || ign).need, stopped: `ПОРТАЛА НЕТ: ${(obs || ign).stopped}` }
  }
  const me = bot.entity.position
  let walked = null
  if (Math.hypot(me.x - target.x, me.z - target.z) > 4) {
    walked = await walkToward(session, ctl, new Vec3(target.x, me.y, target.z), deadline, { range: 2, xz: true })
    if (ctl.aborted) return { ...base, built: false, target, stopped: 'прервано по дороге' }
  }
  const off = Math.round(Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z))
  // Сервер ищет готовый портал в 16 блоках (в Аду) — дальше строить незачем.
  const tolerance = here === 'the_nether' ? 12 : 64
  if (off > tolerance) {
    return {
      ...base, built: false, target, source: src, walked, awayBlocks: off,
      stopped: `до точки ${target.x},${target.z} не дошёл (осталось ${off} бл.${walked && walked.error ? `: ${walked.error}` : ''}) — позови снова, продолжу`
    }
  }
  const r = await portal(session, ctl, { ...p, mode: 'build', timeoutSeconds: Math.max(20, Math.round((deadline - Date.now()) / 1000)) })
  return {
    ...r,
    ...base,
    target,
    source: src,
    offBlocks: off,
    walked: walked || undefined,
    note: `${r.note || ''} Связь: ${worlds.inWorld(here)} точка ${target.x},${target.z} = ${src.from} ${src.x},${src.z} × ${k}; ` +
      `сервер свяжет, если в ${here === 'the_nether' ? 16 : 128} блоках от неё нет другого портала ближе. Переход — mc_portal mode=enter.`
  }
}

// ------------------------------------------------------------ going through

// Меньше этого в портал не шагаем: по ту сторону может ждать лава, гаст или
// толпа у портала, а назад — ещё несколько секунд стояния в портале прибытия.
const MIN_ENTER_HP = 10
// Сколько стоять в портале, прежде чем сказать «перехода нет». Задержка игрока
// в выживании — правило players_nether_portal_default_delay (80 тиков = 4с),
// плюс кулдаун портала, если только что прошли обратным ходом (см. ответ
// enter: heldSeconds). 25с — с запасом на оба.
const HOLD_LIMIT_MS = 25000
// Столько ждём «устроился» от трекера мира после смены (worlds.js READY_MS).
const SETTLE_MS = 15000
const cellKey = p => `${p.x},${p.y},${p.z}`

// Все клетки одного портала: заливка по nether_portal от найденной. Ось — из
// состояния блока (axis x: плоскость X-Y, тонкий по Z; axis z — наоборот), так
// что рамы не 2x3 и порталы, поставленные сервером, понимаются так же.
function portalCells (bot, start, max = 441) {
  const seen = new Set([cellKey(start)])
  const cells = [start]
  for (let i = 0; i < cells.length && cells.length < max; i++) {
    for (const n of neighbours(cells[i])) {
      const k = cellKey(n)
      if (seen.has(k)) continue
      seen.add(k)
      const b = bot.blockAt(n)
      if (b && b.name === 'nether_portal') cells.push(n)
    }
  }
  return cells
}

function describePortal (bot, start) {
  const cells = portalCells(bot, start)
  let axis = 'x'
  try { axis = (bot.blockAt(start).getProperties().axis) || 'x' } catch {}
  const minY = Math.min(...cells.map(c => c.y))
  const bottom = cells.filter(c => c.y === minY)
  const origin = new Vec3(Math.min(...cells.map(c => c.x)), minY, Math.min(...cells.map(c => c.z)))
  return { cells, axis, bottom, origin, keys: new Set(cells.map(cellKey)) }
}

// Ближайший горящий портал в scan. Портал — свой, его видно, поэтому
// bot.findBlocks, а не честное зрение: вопрос тут «где дверь», а не «что вижу».
function findLitPortal (bot, mcData, scan, near = null) {
  const ids = [mcData.blocksByName.nether_portal.id]
  const at = near || bot.entity.position
  const found = bot.findBlocks({ matching: ids, maxDistance: scan, count: 64, point: near || undefined })
  if (!found.length) return null
  found.sort((a, b) => a.distanceTo(at) - b.distanceTo(at))
  return describePortal(bot, found[0])
}

// Клетка, где можно стоять у портала и из которой шаг ведёт внутрь: пол
// твёрдый, ноги и голова свободны, и ни портала, ни огня, ни лавы.
function clearStand (read, p) {
  const g = read(p.offset(0, -1, 0))
  const f = read(p)
  const h = read(p.offset(0, 1, 0))
  if (!g || !f || !h) return false
  if (g.boundingBox !== 'block' || /lava|magma_block|campfire/.test(g.name)) return false
  for (const b of [f, h]) {
    if (b.boundingBox !== 'empty' || /lava|water|fire|portal|gateway/.test(b.name)) return false
  }
  return true
}

// A missing doorstep is one placement, not a reason to abandon a lit portal.
// Only ordinary terrain may be cleared; the frame and containers stay intact.
function doorwayPlan (read, p) {
  const floor = p.offset(0, -1, 0)
  const g = read(floor)
  if (!g || /lava|water|bubble_column|magma_block|campfire|fire/.test(g.name)) return null
  const missingFloor = /^(air|cave_air|void_air)$/.test(g.name)
  if (!missingFloor && g.boundingBox !== 'block') return null
  const dig = []
  for (const c of [p, p.offset(0, 1, 0)]) {
    const b = read(c)
    if (!b || /lava|water|bubble_column|fire|portal|gateway/.test(b.name)) return null
    if (b.boundingBox === 'empty') continue
    if (b.diggable === false || PROTECTED.test(b.name) || b.name === FRAME_BLOCK || /sand$|gravel$/.test(b.name)) return null
    // Keep the plug between the body and any neighbouring liquid.
    if (neighbours(c).some(n => isFluid(read(n)))) return null
    dig.push(c)
  }
  return { pos: p, floor: missingFloor ? floor : null, dig }
}

async function prepareDoorway (session, ctl, door, deadline) {
  const bot = session.bot
  const read = reader(bot)
  const candidates = doorways(door).map(d => ({ ...d, plan: doorwayPlan(read, d.pos) }))
    .filter(d => d.plan && (d.plan.floor || d.plan.dig.length))
    .sort((a, b) => (a.plan.dig.length + !!a.plan.floor) - (b.plan.dig.length + !!b.plan.floor) ||
      a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position))
  const result = { placed: 0, dug: 0 }
  for (const d of candidates) {
    if (ctl.aborted || Date.now() > deadline) break
    const target = d.plan.floor || d.plan.dig[0]
    if (!(await inReach(session, ctl, target))) continue
    const plan = doorwayPlan(read, d.pos)
    if (!plan) continue
    if (plan.floor) {
      if (!pickFiller(bot, { steady: true })) { result.stopped = 'нет блока для пола у портала'; break }
      const put = await placeBlockAt(bot, plan.floor, { steady: true, honest: true, timeoutMs: 2000 })
      if (!put.ok) { result.stopped = put.reason; continue }
      if (!put.already) result.placed++
    }
    for (const c of plan.dig) {
      if (ctl.aborted || Date.now() > deadline || !doorwayPlan(read, d.pos)) break
      const r = await clearCells(session, ctl, [c])
      result.dug += r.dug
      if (r.stopped) { result.stopped = r.stopped; break }
    }
    if (clearStand(read, d.pos)) return { ...result, at: xyz(d.pos), ok: true }
  }
  return { ...result, ok: false }
}

// Пороги: по одной клетке с каждой стороны от нижнего ряда портала, поперёк
// его плоскости.
function doorways (portal) {
  const perp = portal.axis === 'x' ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0)
  const out = []
  for (const c of portal.bottom) {
    for (const side of [1, -1]) out.push({ pos: c.plus(perp.scaled(side)), cell: c, side })
  }
  return out
}

// Тело «в клетке» c: та же колонка, ноги в c.y — или на низком полу клетки ниже (грязь, песок душ — 0.875, грядка и
// тропа — 0.9375): там ноги на c.y − 0.125, и position.floored() даёт клетку пола. Портал на грязи (мангры, слот 23
// 02.10) и порог на песке душ: «до порога не дошёл ни с одной стороны», хотя тело стояло на пороге.
function sameCell (pos, c) {
  if (Math.floor(pos.x) !== c.x || Math.floor(pos.z) !== c.z) return false
  const fy = Math.floor(pos.y)
  return fy === c.y || (fy === c.y - 1 && pos.y - fy >= 0.8)
}

// Последний шаг — клавишами, не pathfinder'ом: портал у него в blocksToAvoid
// (worlds.js tuneMovements), и так и должно быть для всех остальных дорог.
// Идём к центру клетки и отпускаем клавишу в 0.15 от него — инерция доносит
// ещё на десятую, а портал внутри клетки тоньше её.
async function stepTo (bot, ctl, target, { ms = 3000 } = {}) {
  const t0 = Date.now()
  try {
    while (!ctl.aborted && Date.now() - t0 < ms) {
      const pos = bot.entity.position
      const dx = target.x - pos.x
      const dz = target.z - pos.z
      if (Math.hypot(dx, dz) < 0.15) return true
      await bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', true)
      await sleep(50)
    }
    return false
  } finally {
    try { bot.setControlState('forward', false) } catch {}
  }
}

const insidePortal = (bot, portal) => {
  const f = bot.entity.position.floored()
  return portal.keys.has(cellKey(f)) || portal.keys.has(cellKey(f.offset(0, 1, 0)))
}

function portalChanged (session, bot, from, seq) {
  // Stop using overworld coordinates as soon as the header changes, even if
  // the arrival witness is still loading or came from a new connection.
  const wc = session.worldChange
  return worlds.worldOf(bot) !== from || !!(wc && wc.seq > seq && wc.to && wc.to !== from)
}

// Штрек по Аду к точке — когда ногами не пройти. pathfinder в Аду встаёт у
// лавовых озёр и обрывов («путь длиной 0», try-nether-trip 2026-09-25: разведка
// крепости простояла на 205,84,112 восемь взглядов подряд), а netherrack
// (твёрдость 0.4) кирка берёт за доли секунды — так ходят и спидраннеры.
// Шаг — две клетки в сторону цели по большей оси (не вышло — по меньшей); с
// minY — ступенькой вниз, пока выше. Клетку с лавой (или лавой рядом, или
// лавой под полом) не трогаем: эта ось закрыта. Пустоту под ногами
// закладываем блоком. Кирпич крепости в забое — готовый ответ разведке.
// Ответ в форме endportal.tunnelUnder: { ok, dug, moved, placed, lava, why, bricks }.
const HEAT = /lava|water/
const BRICK = /^nether_brick/
async function bore (session, ctl, target, { deadline = Date.now() + 60000, maxSteps = 24, minY = null, maxY = null, throughBricks = false } = {}) {
  const bot = session.bot
  const mcData = session.mcData
  let dug = 0
  let moved = 0
  let placed = 0
  let lava = 0
  const hot = c => {
    for (const n of [c, c.offset(1, 0, 0), c.offset(-1, 0, 0), c.offset(0, 0, 1), c.offset(0, 0, -1), c.offset(0, 1, 0)]) {
      const b = bot.blockAt(n)
      if (!b) return 'непрогруженный мир'
      if (HEAT.test(b.name)) return b.name
    }
    return null
  }
  const out = (ok, extra = {}) => ({ ok, dug, moved, placed, lava: lava || undefined, at: xyz(bot.entity.position), ...extra })
  try { bot.pathfinder.setGoal(null) } catch {}
  for (let s = 0; s < maxSteps; s++) {
    if (ctl.aborted) return out(false, { why: 'прервано' })
    if (Date.now() > deadline) return out(false, { why: 'время вышло' })
    const f = bot.entity.position.floored()
    const ddx = target.x - f.x
    const ddz = target.z - f.z
    if (Math.abs(ddx) <= 1 && Math.abs(ddz) <= 1) return out(true)
    const axes = Math.abs(ddx) >= Math.abs(ddz)
      ? [[Math.sign(ddx), 0], [0, Math.sign(ddz)]]
      : [[0, Math.sign(ddz)], [Math.sign(ddx), 0]]
    // Ступенькой вниз, пока выше minY; вверх — пока ниже maxY (дорога домой
    // к порталу на y=116 из крепости на y=47).
    const dys = minY !== null && f.y > minY ? [-1, 0] : maxY !== null && f.y < maxY ? [1, 0] : [0]
    let stepped = false
    let why = null
    for (const [sx, sz] of axes) {
      if (stepped) break
      if (!sx && !sz) continue
      for (const dy of dys) {
        const feet = f.offset(sx, dy, sz)
        const head = feet.offset(0, 1, 0)
        // Вниз ступенькой тело проходит и клетку над новой головой, вверх —
        // клетку над своей головой (прыжок).
        const cells = dy < 0 ? [head.offset(0, 1, 0), head, feet] : dy > 0 ? [f.offset(0, 2, 0), head, feet] : [head, feet]
        const heat = cells.map(hot).find(Boolean)
        if (heat) { if (/lava/.test(heat)) lava++; why = `у забоя ${heat}`; continue }
        const floor = bot.blockAt(feet.offset(0, -1, 0))
        if (!floor) { why = 'непрогруженный мир'; continue }
        if (HEAT.test(floor.name)) { lava++; why = 'под полом забоя лава'; continue }
        const brick = cells.map(c => bot.blockAt(c)).find(b => b && BRICK.test(b.name))
        // Разведке кирпич — ответ; дороге домой — просто стена (прогон 12:
        // из коридора крепости штрек «находил» её на каждом шаге и не шёл).
        if (brick && !throughBricks) return out(true, { bricks: { name: brick.name, at: xyz(brick.position) } })
        let err = null
        for (const c of cells) {
          // Гравий сыплется сверху — до четырёх раз в ту же клетку.
          for (let k = 0; k < 4 && !err; k++) {
            const b = bot.blockAt(c)
            if (!b || (b.boundingBox === 'empty' && !/fire/.test(b.name))) break
            // Спавнер не ломать: штрек к залу блейзов (fortress climbTo) и к комнате крепости шёл прямо на него.
            if (b.diggable === false || /bedrock|portal|^spawner$/.test(b.name)) { err = `${b.name} не копается`; break }
            // Кирпич с чешуйницей не ломать: выпущенная зовёт соседних (ферма,
            // штрек к комнате крепости A — «slain by Silverfish»).
            if (/^infested_/.test(b.name)) { err = `${b.name} — там чешуйница`; break }
            const problem = missingHarvestTool(bot, b, mcData)
            if (problem) { err = problem; break }
            try { await equipBestTool(bot, b); await bot.dig(b, true); dug++ } catch (e) { err = e.message }
            await sleep(60)
          }
          if (err) break
        }
        if (err) { why = err; continue }
        // Вскрыли лаву копкой — назад не лезем.
        const after = cells.map(hot).find(h => h && /lava/.test(h))
        if (after) { lava++; why = `вскрыл ${after}`; continue }
        const fl = bot.blockAt(feet.offset(0, -1, 0))
        if (fl && fl.boundingBox !== 'block') {
          const below = bot.blockAt(feet.offset(0, -2, 0))
          if (below && HEAT.test(below.name)) { lava++; why = 'под забоем пустота над лавой'; continue }
          const r = await placeBlockAt(bot, feet.offset(0, -1, 0), { steady: true }).catch(e => ({ ok: false, reason: e.message }))
          if (!r.ok) { why = `пол забоя не заложить: ${r.reason}`; continue }
          placed++
        }
        const t0 = Date.now()
        try {
          while (Date.now() - t0 < 1800 && !sameCell(bot.entity.position, feet)) {
            await bot.lookAt(feet.offset(0.5, 1.6, 0.5), true)
            bot.setControlState('forward', true)
            if (dy > 0) bot.setControlState('jump', true)
            await sleep(50)
          }
        } finally { try { bot.setControlState('forward', false); bot.setControlState('jump', false) } catch {} }
        if (sameCell(bot.entity.position, feet)) { moved++; stepped = true; break }
        why = 'в забой не шагнуть'
      }
    }
    if (!stepped) return out(false, { why: why || 'штрек не пошёл' })
  }
  return out(false, { why: `за ${maxSteps} шагов штреком не дошёл` })
}

// Бьют по дороге — ответить, а не идти дальше: эндермен, разозлённый взглядом
// по пути, убил тело за 10 с, пока разведка шла следующим отрезком
// (try-nether-trip 2026-09-25, «slain by Enderman»; автопилот в намерении
// молчит). run(sub) — отрезок под своим ctl, который рвётся на удар живого
// врага в 6 блоках (combat.liveAttacker); дальше бой с ним и еда.
async function guarded (session, ctl, run) {
  const bot = session.bot
  const combat = require('./combat')
  const sub = { aborted: false, onAbort: [] }
  let hitBy = null
  const cut = () => {
    if (sub.aborted) return
    sub.aborted = true
    for (const fn of sub.onAbort) { try { fn() } catch {} }
  }
  const onHurt = victim => {
    if (victim !== bot.entity || hitBy) return
    const a = combat.liveAttacker(session)
    if (!a || !a.position || a.position.distanceTo(bot.entity.position) > 6) return
    // The session reflex pauses goto and resumes it. The old local cut/return
    // would abort that same step and initiate a second defence on top of it.
    if (worlds.worldOf(bot) === 'the_nether' && require('./reflex-lock').on() && /^(piglin|piglin_brute|hoglin|zoglin|zombified_piglin|wither_skeleton|magma_cube|zombie|husk|vindicator)$/.test(a.name || '')) return
    hitBy = a
    cut()
  }
  const relay = setInterval(() => { if (ctl.aborted) cut() }, 200)
  // Взгляд в пол на ходу (только Ад). pathfinder идёт с pitch 0
  // (mineflayer-pathfinder index.js: bot.look(yaw, 0)), а эндермен злится, если
  // игрок смотрит ему в глаза: EnderMan.isLookingAtMe — dot > 1 - 0.025/d, то
  // есть на 20 блоках допуск 2.9°, а его глаза на 0.93 выше наших — 2.7°.
  // Идя по ровному на эндермена в 15–60 блоках, тело злит его само (прогоны
  // 2026-09-25: дважды «slain by Enderman» / падение в лаву в бою с ним).
  // Направление шага задаёт только yaw; pitch ниже -0.6 (≈34° вниз) правим
  // после pathfinder'а в том же тике, до отправки позиции (physics.js).
  const inNether = worlds.worldOf(bot) === 'the_nether'
  const lookDown = () => { if (!session.reflex && bot.entity && bot.entity.pitch > -0.6) bot.entity.pitch = -0.6 }
  if (inNether) bot.on('physicsTick', lookDown)
  bot.on('entityHurt', onHurt)
  let r
  try { r = await run(sub) } finally {
    clearInterval(relay)
    bot.removeListener('entityHurt', onHurt)
    if (inNether) bot.removeListener('physicsTick', lookDown)
  }
  if (!hitBy || ctl.aborted) return r
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
  // Эндермена — на месте, без погони: он телепортируется, и погоня за ним по
  // краю обрыва кончилась падением в лавовое море (прогон 4, 2026-09-25). Он
  // сам подходит бить — меч встречает его в упор.
  // ND_GUARD=1: брут/хоглин/зоглин/иссушитель (или злых трое, хп < 9) — не бой на земле, а яма на 2 вниз/столб (ne-guard).
  if (process.env.ND_GUARD !== '0' && hitBy.name !== 'enderman') {
    const G = require('./ne-guard')
    const foes = G.meleeFoes(bot, 6)
    if (G.HIDE_FROM.test(hitBy.name || '') || foes.length >= 3 || (bot.health ?? 20) < 9) {
      const rr = await G.react(session, ctl, { force: { e: hitBy, why: 'удар ' + hitBy.name } })
      return { ...(r || {}), ok: false, fought: { with: hitBy.name, won: !!rr.killed, hp: Math.round(bot.health ?? 0), how: rr.how }, error: `по дороге напал ${hitBy.name} — ${rr.how || 'ответ'}` }
    }
  }
  const f = hitBy.name === 'enderman'
    ? await standAndSwing(session, ctl, hitBy, 25000)
    : await combat.fight(session, ctl, { target: '#' + hitBy.id, timeoutSeconds: 30, retreatAtHealth: 5, clearArea: 0 })
      .catch(e => ({ error: String(e.message || e) }))
  if ((bot.food ?? 20) < 18 && !ctl.aborted) { try { await require('./actions').eat(session, {}) } catch {} }
  const won = !!(f.killed || (f.kills && f.kills.length))
  console.log('[nether] ответил', JSON.stringify({ to: hitBy.name, won, hp: Math.round(bot.health ?? 0), why: f.error || f.stopped }))
  return {
    ...(r || {}),
    ok: false,
    fought: { with: hitBy.name, won, hp: Math.round(bot.health ?? 0) },
    error: `по дороге напал ${hitBy.name} — ${won ? 'убил' : `бой без победы${f.error ? `: ${f.error}` : ''}`}`
  }
}

async function standAndSwing (session, ctl, mob, ms) {
  const bot = session.bot
  const { bestWeapon } = require('./items')
  const w = bestWeapon(bot)
  if (w) { try { await bot.equip(w, 'hand') } catch {} }
  try { bot.clearControlStates() } catch {}
  const t0 = Date.now()
  let swings = 0
  let last = 0
  while (!ctl.aborted && Date.now() - t0 < ms && mob.isValid !== false && bot.entities[mob.id]) {
    if ((bot.health ?? 0) <= 5) return { stopped: `хп ${Math.round(bot.health ?? 0)}`, swings }
    const d = mob.position.distanceTo(bot.entity.position)
    if (d <= 3.2 && Date.now() - last >= 650) {
      try { await bot.lookAt(mob.position.offset(0, 1.0, 0), true); bot.attack(mob); swings++; last = Date.now() } catch {}
    }
    await sleep(60)
  }
  const gone = mob.isValid === false || !bot.entities[mob.id]
  return { killed: gone && swings > 0 ? mob.name : undefined, swings, stopped: gone ? undefined : 'не подошёл' }
}

// До записанного портала своего мира, если он дальше, чем видно.
async function walkToward (session, ctl, target, deadline, { range = 3, xz = false } = {}) {
  const bot = session.bot
  const { travelXZ } = require('./movement')
  // Издалека — отрезками по 24 блока по прямой, со сдвигом вбок, если прямо
  // не пройти: одним GoalNear на 290 блоков по Аду pathfinder отвечает «No
  // path to the goal!» за 5 с поиска (try-nether-trip, 2026-09-25), а
  // отрезками тот же рельеф проходится.
  let side = 0
  let fails = 0
  let dug = 0
  while (!ctl.aborted && Date.now() < deadline) {
    const me = bot.entity.position
    const dx = target.x - me.x
    const dz = target.z - me.z
    const dist = Math.hypot(dx, dz)
    if (dist <= 24) break
    const ux = dx / dist
    const uz = dz / dist
    const tx = Math.round(me.x + ux * 24 - uz * side)
    const tz = Math.round(me.z + uz * 24 + ux * side)
    const w = await guarded(session, ctl, sub => travelXZ(bot, sub, tx, tz, { range: 3, retries: 1, deadline: Math.min(deadline, Date.now() + 40000) }))
    if (w.fought && (bot.health ?? 0) < 8) return { ok: false, error: w.error, fought: w.fought }
    if (w.ok || w.fought) { side = 0; fails = 0; continue }
    // Два обхода не вышло — штрек прямо к порталу (на его высоту) на 16 шагов.
    if (fails >= 2) {
      const b = await bore(session, ctl, { x: Math.round(target.x), z: Math.round(target.z) }, {
        deadline: Math.min(deadline, Date.now() + 45000), maxSteps: 16, minY: target.y, maxY: target.y, throughBricks: true
      })
      dug += b.dug
      if (b.moved >= 4) { side = 0; fails = 0; continue }
    }
    if (++fails > 6) return { ok: false, error: w.error, dug: dug || undefined }
    side = side <= 0 ? -side + 8 : -side
  }
  const last = async () => {
    const guard = stuckGuard(bot, ctl)
    let timer = null
    try {
      await Promise.race([
        bot.pathfinder.goto(xz ? new goals.GoalNearXZ(target.x, target.z, range) : new goals.GoalNear(target.x, target.y, target.z, range)),
        guard.promise,
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('время вышло')), Math.max(1000, Math.min(60000, deadline - Date.now()))) })
      ])
      const p1 = bot.entity.position
      if ((xz ? Math.hypot(p1.x - target.x, p1.z - target.z) : p1.distanceTo(new Vec3(target.x, target.y, target.z))) > range + 3) return { ok: false, error: 'pathfinder не нашёл ни шага к цели' }
      return { ok: true }
    } catch (e) {
      try { bot.pathfinder.setGoal(null) } catch {}
      return { ok: false, error: e.message }
    } finally {
      guard.stop()
      if (timer) clearTimeout(timer)
    }
  }
  const r = await last()
  // Цель высоко над нами (портал на 19 блоков выше, кампания 2026-09-28, 14:09):
  // pathfinder без столба 1x1 в Аду подъёма не находит («Took to long to decide
  // path», а goto отвечал «done» без шага). Подняться лестницей штрека (bore:
  // ступенька вверх на каждый шаг, пока ниже maxY) в ту сторону, где места
  // больше, — прочь от цели, чтобы хватило длины, — и снова к цели.
  if (!r.ok && !xz && Number.isFinite(target.y) && target.y - bot.entity.position.y > 3 && !ctl.aborted && Date.now() < deadline - 15000) {
    const f = bot.entity.position.floored()
    const up = Math.ceil(target.y - f.y)
    const tries = []
    for (const [sx, sz] of [[Math.sign(f.x - target.x) || 1, 0], [0, Math.sign(f.z - target.z) || 1], [-(Math.sign(f.x - target.x) || 1), 0], [0, -(Math.sign(f.z - target.z) || 1)]]) {
      if (ctl.aborted || bot.entity.position.y >= target.y - 1) break
      const b = await bore(session, ctl, { x: f.x + sx * (up + 12), z: f.z + sz * (up + 12) }, {
        deadline: Math.min(deadline - 5000, Date.now() + 60000), maxSteps: up + 4, maxY: Math.floor(target.y), throughBricks: true
      })
      tries.push({ dir: [sx, sz], moved: b.moved, y: Math.floor(bot.entity.position.y), why: b.why })
      if (bot.entity.position.y >= target.y - 1) break
    }
    console.log('[nether] подъём к цели', JSON.stringify({ target: xyz(target), tries }))
    if (bot.entity.position.y >= target.y - 2) {
      const r2 = await walkToward(session, ctl, target, deadline, { range, xz })
      return { ...r2, climbed: tries }
    }
    return { ...r, climbed: tries }
  }
  return r
}

// Что вокруг портала прибытия: лава в 4 блоках и враги, которых видно в 16.
function surroundings (bot, mcData) {
  const { HOSTILES } = require('./combat')
  const { canSeePoint } = require('./perception')
  const me = bot.entity.position
  let lava = []
  try {
    lava = bot.findBlocks({ matching: [mcData.blocksByName.lava.id], maxDistance: 4, count: 30 })
  } catch {}
  const hostiles = Object.values(bot.entities)
    .filter(e => e && e !== bot.entity && e.position && HOSTILES.has(e.name) && e.position.distanceTo(me) <= 16 &&
      canSeePoint(bot, e.position.offset(0, (e.height || 1) * 0.6, 0)))
    .map(e => ({ name: e.name, dist: Math.round(e.position.distanceTo(me) * 10) / 10 }))
    .sort((a, b) => a.dist - b.dist)
  const nearestLava = lava.length ? Math.round(Math.min(...lava.map(p => p.distanceTo(me))) * 10) / 10 : null
  return { lava: lava.length, nearestLava, hostiles }
}

// Один вызов — один переход: дойти до портала своего мира, шагнуть, дождаться
// смены мира (свидетель — трекер worlds.js, а не «постоял»), выйти из портала
// прибытия, осмотреться и записать пару порталов, каждый под ключом своего мира
// и со ссылкой leadsTo на другой.
async function enter (session, ctl, p = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const read = reader(bot)
  const from = worlds.worldOf(bot)
  const scan = Math.max(4, Math.min(32, p.scan ?? 16))
  const deadline = Date.now() + Math.max(20, Math.min(600, p.timeoutSeconds ?? 90)) * 1000 - 3000
  const base = { mode: 'enter', world: from }

  const hp = Math.round(bot.health ?? 0)
  if (hp < MIN_ENTER_HP) {
    return {
      ...base,
      went: false,
      stopped: `На ${hp} хп в портал не шагаю: по ту сторону может быть лава, гаст или толпа у портала, а ` +
        `назад — снова стоять в портале. Поешь и подожди до ${MIN_ENTER_HP}+ (mc_eat, mc_wait), потом зови снова.`
    }
  }
  if (from === 'overworld' && !IGNITERS.some(n => itemNamed(bot, n)) && !p.noIgniter) {
    const s = igniterShortfall(bot)
    return {
      ...base,
      went: false,
      need: s.need,
      stopped: 'В Ад без огнива не пойду: гаст взрывом гасит портал, и без огнива дорога домой закрыта. ' + s.stopped
    }
  }

  // --- 1. Портал своего мира: горящий рядом, иначе из памяти, иначе рама без огня.
  const places = (session.journal.state && session.journal.state.places) || {}
  const key = worlds.portalKey(from)
  const rec = places[key] && worlds.worldOfRecord(places[key]) === from ? places[key] : null
  let door = findLitPortal(bot, mcData, scan)
  let walked = null
  if (!door && rec) {
    const target = new Vec3(rec.x, rec.y, rec.z)
    if (bot.entity.position.distanceTo(target) > scan - 2) {
      walked = await walkToward(session, ctl, target, deadline)
      if (ctl.aborted) return { ...base, went: false, stopped: 'прервано по дороге к порталу' }
      if (!walked.ok) {
        return {
          ...base,
          went: false,
          walked,
          awayBlocks: Math.round(bot.entity.position.distanceTo(target)),
          stopped: `до портала из памяти («${key}» на ${rec.x},${rec.y},${rec.z}) не дошёл: ${walked.error}. ` +
            'Подойди ближе mc_goto и позови снова.'
        }
      }
    }
    door = findLitPortal(bot, mcData, scan)
  }
  let lit = null
  if (!door) {
    const obs = bot.findBlocks({ matching: [mcData.blocksByName[FRAME_BLOCK].id], maxDistance: scan, count: 64 })
    const frames = findFrames(read, obs)
    if (frames.some(f => !f.lit) && IGNITERS.some(n => itemNamed(bot, n))) {
      lit = await portal(session, ctl, { scan, timeoutSeconds: Math.max(20, Math.round((deadline - Date.now()) / 1000)) })
      door = findLitPortal(bot, mcData, scan)
    }
  }
  if (!door) {
    return {
      ...base,
      went: false,
      lit: lit ? { stopped: lit.stopped, portalBlocks: lit.portalBlocks } : undefined,
      stopped: `ПЕРЕХОДА НЕТ: горящего портала в ${scan} блоках не вижу` +
        (rec ? ` (в памяти «${key}» на ${rec.x},${rec.y},${rec.z})` : `, и «${key}» в памяти нет`) +
        (from === 'overworld' ? '. Построить: mc_portal mode=build.' : '. Портал прибытия мог погаснуть от гаста — зажечь огнивом: mc_portal mode=build рядом с рамой.')
    }
  }

  // --- 2. На порог.
  const me = bot.entity.position
  let spots = doorways(door).filter(d => clearStand(read, d.pos))
    .sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me))
  if (!spots.length) {
    base.access = await prepareDoorway(session, ctl, door, Math.min(deadline, Date.now() + 30000))
    spots = doorways(door).filter(d => clearStand(read, d.pos))
      .sort((a, b) => a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position))
  }
  if (!spots.length) {
    return {
      ...base,
      went: false,
      portal: { inner: xyz(door.origin), axis: door.axis, blocks: door.cells.length },
      stopped: 'К порталу не подойти: ни с одной стороны нижнего ряда нет клетки, где встать (пол, ноги и голова свободны). ' +
        (base.access?.stopped || 'Безопасно восстановить порог не удалось.')
    }
  }
  let spot = null
  for (const s of spots.slice(0, 4)) {
    if (ctl.aborted || Date.now() > deadline) break
    await walkNear(session, ctl, s.pos, 0)
    if (sameCell(bot.entity.position, s.pos)) { spot = s; break }
  }
  if (!spot) {
    return {
      ...base,
      went: false,
      awayBlocks: Math.round(bot.entity.position.distanceTo(spots[0].pos)),
      stopped: ctl.aborted ? 'прервано у портала' : 'до порога портала не дошёл ни с одной стороны — позови ещё раз или подойди mc_goto'
    }
  }

  // --- 3. Шаг внутрь и стояние. Переход засчитывается только по смене мира.
  const seq0 = session.worldChange ? session.worldChange.seq : 0
  const changed = () => portalChanged(session, bot, from, seq0)
  const centre = spot.cell.offset(0.5, 0, 0.5)
  const t0 = Date.now()
  let inAt = null
  let steps = 0
  while (!changed()) {
    if (ctl.aborted || Date.now() > deadline || Date.now() - t0 > HOLD_LIMIT_MS) break
    if (!insidePortal(bot, door)) {
      if (steps >= 4) break
      steps++
      await stepTo(bot, ctl, centre, { ms: 2500 })
    }
    if (inAt === null && insidePortal(bot, door)) inAt = Date.now()
    await sleep(100, ctl)
  }
  const heldSeconds = inAt ? Math.round((Date.now() - inAt) / 100) / 10 : 0
  if (!changed()) {
    // Обрыв или «сервер не пустил»: из портала — назад на порог.
    if (insidePortal(bot, door)) await stepTo(bot, { aborted: false }, spot.pos.offset(0.5, 0, 0.5), { ms: 1500 })
    return {
      ...base,
      went: false,
      heldSeconds,
      steps,
      out: !insidePortal(bot, door),
      stopped: ctl.aborted
        ? `прервано: простоял в портале ${heldSeconds}с, мир тот же — вышел обратно на порог`
        : `ПЕРЕХОДА НЕТ: простоял в портале ${heldSeconds}с, мир тот же — сервер не пускает или портал не рабочий. ` +
          'Проверь правило allow_entering_nether_using_portals и что внутри рамы 6 клеток портала (mc_observe).'
    }
  }

  // --- 4. Прибытие: ждём «устроился» от трекера.
  const t1 = Date.now()
  const arrivalReady = () => session.worldChange && session.worldChange.seq > seq0 &&
    session.worldChange.from === from && session.worldChange.to === worlds.worldOf(bot) && session.worldChange.ready
  while (!arrivalReady() && Date.now() - t1 < SETTLE_MS && !ctl.aborted) await sleep(100)
  const wc = session.worldChange
  const to = worlds.worldOf(bot)
  const departure = { world: from, ...xyz(spot.pos) }
  if (!arrivalReady()) {
    return {
      ...base,
      went: true,
      ready: false,
      from: departure,
      to: { world: to },
      heldSeconds,
      stopped: `Мир сменился (${worlds.worldName(from)} → ${worlds.worldName(to)}), но тело не устроилось за ${SETTLE_MS / 1000}с: ` +
        'позиции от сервера нет или мир под ногами не прогружен. Подожди mc_wait 5 и посмотри mc_observe.'
    }
  }
  // Колонки вокруг приходят не разом: портал прибытия надо прочитать целиком.
  for (let i = 0; i < 20; i++) {
    const b = bot.blockAt(bot.entity.position.offset(0, 0.5, 0))
    if (b) break
    await sleep(100)
  }
  await sleep(250)

  // --- 5. Из портала прибытия — на порог.
  let arrival = null
  const feet = bot.entity.position.floored()
  for (const c of [feet, feet.offset(0, 1, 0)]) {
    const b = bot.blockAt(c)
    if (b && b.name === 'nether_portal') { arrival = describePortal(bot, c); break }
  }
  if (!arrival) arrival = findLitPortal(bot, mcData, 4)
  let out = null
  if (arrival) {
    const here = bot.entity.position
    const exits = doorways(arrival).filter(d => clearStand(read, d.pos))
      .sort((a, b) => a.pos.distanceTo(here) - b.pos.distanceTo(here))
    for (const e of exits.slice(0, 4)) {
      await stepTo(bot, { aborted: false }, e.pos.offset(0.5, 0, 0.5), { ms: 2500 })
      if (!insidePortal(bot, arrival)) { out = bot.entity.position.floored(); break }
    }
    if (!out && !insidePortal(bot, arrival)) out = bot.entity.position.floored()
    // Чистого порога у портала прибытия нет (камень, обрыв без пола): расчистить ближний, как у портала ухода
    // (prepareDoorway: пол заложить, камень выкопать, у жидкости не трогать) — neF-map23-2 02.10: тело осталось в
    // портале прибытия, и штрек, и ноги к бастиону и спавнеру отказали на месте 6 раз подряд.
    if (!out && insidePortal(bot, arrival)) {
      const pd = await prepareDoorway(session, ctl, arrival, Date.now() + 15000).catch(e => ({ ok: false, stopped: e.message }))
      if (pd.ok && pd.at) {
        await stepTo(bot, { aborted: false }, new Vec3(pd.at.x + 0.5, pd.at.y, pd.at.z + 0.5), { ms: 2500 })
        if (!insidePortal(bot, arrival)) out = bot.entity.position.floored()
      }
    }
  } else {
    out = bot.entity.position.floored()
  }
  const stillInside = arrival ? insidePortal(bot, arrival) : false

  // --- 6. Осмотр и память: пара порталов, каждый в своём мире.
  const around = surroundings(bot, mcData)
  const standAt = out || bot.entity.position.floored()
  const arrivalPlace = arrival
    ? rememberPortal(session, {
      ...xyz(standAt),
      dimension: to,
      axis: arrival.axis,
      inner: xyz(arrival.origin),
      lit: true,
      mine: false,
      leadsTo: departure
    })
    : null
  const sameAsRecord = rec && Math.abs(rec.x - spot.pos.x) <= 4 && Math.abs(rec.y - spot.pos.y) <= 4 && Math.abs(rec.z - spot.pos.z) <= 4
  const departurePlace = rememberPortal(session, {
    ...xyz(spot.pos),
    dimension: from,
    axis: door.axis,
    inner: xyz(door.origin),
    lit: true,
    mine: sameAsRecord ? rec.mine : false,
    leadsTo: { world: to, ...xyz(standAt) }
  })
  const ratio = worlds.scaleOf(from) / worlds.scaleOf(to)
  const predicted = { x: Math.floor(spot.pos.x * ratio), z: Math.floor(spot.pos.z * ratio) }
  const toKey = worlds.portalKey(to)
  const home = arrival ? Math.round(standAt.distanceTo(arrival.bottom[0])) : null

  const detail = {
    ...base,
    went: true,
    ready: true,
    from: departure,
    to: { world: to, ...xyz(bot.entity.position) },
    heldSeconds,
    settledMs: wc.ms,
    out: out ? xyz(out) : null,
    inPortal: stillInside || undefined,
    arrivalPortal: arrival ? { inner: xyz(arrival.origin), axis: arrival.axis, blocks: arrival.cells.length } : null,
    predicted,
    place: arrivalPlace ? { key: toKey, x: arrivalPlace.x, y: arrivalPlace.y, z: arrivalPlace.z, leadsTo: arrivalPlace.leadsTo } : null,
    departure: { key, leadsTo: departurePlace.leadsTo },
    around,
    lit: lit ? { portalBlocks: lit.portalBlocks, built: lit.built } : undefined,
    gear: { flint_and_steel: countOf(bot, 'flint_and_steel'), obsidian: countOf(bot, FRAME_BLOCK) }
  }
  const danger = []
  if (around.nearestLava !== null && around.nearestLava <= 3) danger.push(`лава в ${around.nearestLava} бл.`)
  if (around.hostiles.length) danger.push('вижу: ' + around.hostiles.slice(0, 4).map(h => `${h.name} ${h.dist}`).join(', '))
  if (stillInside || !out) {
    detail.stopped = `Я ${worlds.inWorld(to)}, но из портала прибытия не вышел: вокруг нет клетки, где встать. ` +
      'Постою — и портал вернёт обратно. Выйти руками: mc_goto на 2 блока в сторону.'
  }
  detail.note = `Я ${worlds.inWorld(to)} на ${detail.to.x},${detail.to.y},${detail.to.z}. Простоял в портале ${heldSeconds}с. ` +
    (arrival ? `Портал домой в ${home} бл., записал как «${toKey}» (ведёт к «${key}»). ` : 'Портала прибытия рядом не нашёл — запиши место сам. ') +
    `Координаты ${worlds.ofWorld(from)} здесь не действуют — обратно тем же вызовом.` +
    (danger.length ? ` Осторожно: ${danger.join('; ')}.` : '')
  return detail
}

module.exports = {
  exitKit,
  clearCells,
  portal,
  enter,
  sameCell,
  bore,
  walkToward,
  guarded,
  findLitPortal,
  describePortal,
  doorways,
  clearStand,
  doorwayPlan,
  prepareDoorway,
  portalChanged,
  portalNow,
  planPortal,
  judge,
  frameAt,
  findFrames,
  innerCells,
  frameCells,
  cornerCells,
  propFor,
  standSpots,
  standable,
  reader,
  obsidianShortfall,
  propShortfall,
  placeLeash,
  MINEFLAYER_PLACE_WAIT_MS,
  igniterShortfall,
  portalNote,
  PORTAL,
  FRAME_MIN,
  INNER_W,
  INNER_H,
  FRAME_BLOCK,
  IGNITERS,
  OBSIDIAN_TOOLS,
  OBSIDIAN_SECONDS,
  MAX_DIG,
  WHY_NOT_THROUGH
}

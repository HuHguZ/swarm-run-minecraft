'use strict'
const Vec3 = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const { sleep, xyz, describeStall, stuckGuard } = require('./movement')
const {
  equipBestTool, missingHarvestTool, itemNamed,
  countItems, diffItems, resolveBlockIds, toolBudget, toolShortfall, SWINGS_PER_CELL
} = require('./items')
const { placeBlockAt, withTimeout, FACES, FILLER, occupiedByEntity } = require('./build')
const { HOSTILES } = require('./combat')
const { reachOf, sceneryOf } = require('./reach')

// The strip mine. digDown puts the bot at iron depth and leaves it standing in
// a one-block shaft, which touches almost nothing: ore sits in the *walls* of a
// corridor. This is the horizontal half of the same job — and the half where
// the classic deaths are, so every step is a safety check first and a pickaxe
// swing second.

// Same mapping as COMPASS in actions.js: north is -z.
const DIRS = {
  east: { name: 'east', ru: 'восток', dx: 1, dz: 0 },
  west: { name: 'west', ru: 'запад', dx: -1, dz: 0 },
  south: { name: 'south', ru: 'юг', dx: 0, dz: 1 },
  north: { name: 'north', ru: 'север', dx: 0, dz: -1 }
}
DIRS.восток = DIRS.east
DIRS.запад = DIRS.west
DIRS.юг = DIRS.south
DIRS.север = DIRS.north

const MAX_LENGTH = 128
const STEP_MS = 2500 // one block of walking; anything longer means we are stuck

// Six blocks is roughly three seconds of zombie walking, and a brain turn costs
// ten to thirty. So the warning distance is not "far enough to think about it" —
// it never was — it is "far enough to put a block down".
const MOB_RADIUS = 6
// On low health there is no margin left to spend on being wrong about range.
const MOB_RADIUS_HURT = 12
// How far the errand that comes back for ore looks before a swing. Short on
// purpose — a two-block errand only asks whether something is already on it —
// and it is only where to look: whether that something counts is reachOf's
// answer, never this radius. It used to be both, as «within 3 blocks», and 3
// blocks straight down through the floor is how mine_seen refused three calls
// running for a zombie in the cave underneath.
const ERRAND_LOOK = 4
const LOW_HEALTH = 6
// Short leash on every placement made under threat, the same reason combat's
// raiseWall uses one: a square that refuses the first block is not worth a
// second while something is walking at us.
const SEAL_MS = 1500

const at = p => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
const flatDist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const isLava = b => !!b && /lava/.test(b.name)
const isWater = b => !!b && /^(water|bubble_column)$/.test(b.name)

function clamp (value, lo, hi, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

// ---------------------------------------------------------------- direction

// mineflayer's yaw is not the protocol's: bot.lookAt builds it as
// atan2(-dx, -dz), so the way the body is pointing reads back as (-sin, -cos).
function facing (bot) {
  const yaw = bot.entity.yaw || 0
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? DIRS.east : DIRS.west
  return dz >= 0 ? DIRS.south : DIRS.north
}

function resolveDirection (bot, direction) {
  if (!direction) return facing(bot)
  const dir = DIRS[String(direction).trim().toLowerCase()]
  if (!dir) throw new Error(`не знаю направления «${direction}» — бывает север, юг, восток, запад`)
  return dir
}

// Where a thing sits in the corridor's own frame. "лава на 132,-29,172" is a
// coordinate the brain then has to do trigonometry on before it can decide
// anything; "лава в 1 впереди справа" is the same fact already in the terms the
// next decision is made in — dig on, turn, or go round.
// Left is (dir.dz, -dir.dx): facing east, north is on the left.
function bearing (from, dir, pos) {
  const along = Math.round((pos.x - from.x) * dir.dx + (pos.z - from.z) * dir.dz)
  const side = Math.round((pos.x - from.x) * dir.dz + (pos.z - from.z) * -dir.dx)
  const up = Math.round(pos.y - from.y)
  const parts = []
  if (along > 0) parts.push(`в ${along} впереди`)
  else if (along < 0) parts.push(`в ${-along} позади`)
  if (side > 0) parts.push('слева')
  else if (side < 0) parts.push('справа')
  if (up > 0) parts.push('сверху')
  else if (up < 0) parts.push('снизу')
  return parts.length ? parts.join(' ') : 'вплотную'
}

// ---------------------------------------------------------------- safety

// Feeling the heat. This is the one place the bot looks through solid stone,
// and it may only ever say "no" — breaking sideways into a lava pocket is how
// a strip mine ends. Never used to find anything.
function danger (bot, from, cell, height, dir) {
  for (let h = 0; h < height; h++) {
    const pos = cell.offset(0, h, 0)
    const here = bot.blockAt(pos)
    if (!here) return `мир на ${at(pos)} не прогружен — постой рядом и позови ещё раз`
    if (here.name === 'bedrock') return `бедрок на ${at(pos)} (${bearing(from, dir, pos)}) — ниже мира нет, штрек надо вести выше`

    const around = [
      here,
      bot.blockAt(pos.offset(0, 1, 0)),
      bot.blockAt(pos.offset(0, -1, 0)),
      bot.blockAt(pos.offset(-dir.dz, 0, dir.dx)),
      bot.blockAt(pos.offset(dir.dz, 0, -dir.dx)),
      bot.blockAt(pos.offset(dir.dx, 0, dir.dz))
    ]
    for (const b of around) {
      // Naming which way the water or lava is turns "не копаю" into a choice:
      // a pocket on the left is dodged by going right, one straight ahead is
      // dodged by changing direction or height.
      if (isLava(b)) return `лава на ${at(b.position)} (${bearing(from, dir, b.position)}) — не копаю, обходи другим направлением или на 3 блока в сторону`
      if (isWater(b)) return `вода на ${at(b.position)} (${bearing(from, dir, b.position)}) — не копаю, обходи другим направлением или на 3 блока в сторону`
    }
  }
  return null
}

// The tool question is about the rock we will actually hit, not about the air
// in front of the face. Unlike danger() this probe does NOT get the x-ray
// exception: its answer ends up in a message that names the block, and a
// refusal reading "для deepslate_diamond_ore нужна кирка" would tell the brain
// what is buried ahead. Only what the eyes can reach counts.
function firstSolidAhead (bot, origin, dir, height, length, useFair) {
  for (let step = 1; step <= Math.min(length, 8); step++) {
    for (let h = 0; h < height; h++) {
      const b = bot.blockAt(origin.offset(dir.dx * step, h, dir.dz * step))
      if (!b || b.boundingBox !== 'block') continue
      if (!useFair) return b
      try {
        if (bot.canSeeBlock(b)) return b
      } catch {
        // A raycast into a half-loaded chunk throws; that is "not seen".
      }
    }
  }
  return null
}

// How much rubble the bag actually holds, counted the way placeBlockAt spends
// it: FILLER first, planks as the last resort. "нечем строить" is a true answer
// and a useless one — a brain that is told the number can pack it.
function fillerCount (bot) {
  return bot.inventory.items().reduce(
    (n, i) => n + ((FILLER.includes(i.name) || /_planks$/.test(i.name)) ? i.count : 0), 0)
}

function columnSolid (bot, cell, height) {
  for (let h = 0; h < height; h++) {
    const b = bot.blockAt(cell.offset(0, h, 0))
    if (!b || b.boundingBox !== 'block') return false
  }
  return true
}

// Somewhere the body can stand right now, with no pathfinder involved. Used
// only for cells of our own drift, which is why a floor is required rather than
// searched for: a corridor cell with no floor is a hole we bridged and lost.
function walkableCell (bot, cell) {
  const feet = bot.blockAt(cell)
  const head = bot.blockAt(cell.offset(0, 1, 0))
  const floor = bot.blockAt(cell.offset(0, -1, 0))
  return !!feet && feet.boundingBox === 'empty' &&
    !!head && head.boundingBox === 'empty' &&
    !!floor && floor.boundingBox === 'block' &&
    !occupiedByEntity(bot, cell)
}

// ---------------------------------------------------------------- digging

// `watch` is the standing guard: it is asked between swings, not between
// columns, because one block of deepslate is under a second of digging but a
// column that keeps refusing burns the full 20s dig timeout six times over —
// and a zombie covers six blocks in three seconds.
async function digColumn (bot, mcData, ctl, cell, height, deadline, watch = null) {
  let dug = 0
  // Top down: the head slot is where falling gravel lands, and clearing it
  // first means the body never stands under a live column.
  for (let h = height - 1; h >= 0; h--) {
    const pos = cell.offset(0, h, 0)
    let lastError = null

    // Gravel drops into the slot the moment it is empty, and a swing the server
    // quietly refuses leaves the block standing — so the block is re-read every
    // swing instead of trusting a plan made three swings ago.
    for (let tries = 0; tries < 6; tries++) {
      if (ctl.aborted) return { dug, stopped: 'прервано' }
      if (Date.now() >= deadline) return { dug, stopped: `время вышло в забое на ${at(pos)}` }
      const alarm = watch && watch()
      if (alarm) return { dug, alarm }

      const block = bot.blockAt(pos)
      if (!block) return { dug, stopped: `мир на ${at(pos)} не прогружен — постой рядом и позови ещё раз` }
      if (isLava(block) || isWater(block)) return { dug, stopped: `${block.name} в забое на ${at(pos)} — дальше не копаю` }
      if (block.name === 'bedrock') return { dug, stopped: `бедрок на ${at(pos)} — ниже мира нет, штрек надо вести выше` }
      if (block.boundingBox === 'empty') break

      const problem = quickBreak(bot, block) ? null : missingHarvestTool(bot, block, mcData)
      if (problem) return { dug, stopped: problem, need: { what: `кирка под ${block.name}`, count: 1, have: 0 } }

      try {
        await equipBestTool(bot, block)
        // A dig whose block update never arrives would eat the whole intent.
        await withTimeout(bot.dig(block), 20000, `${block.name} не ломается`)
        dug++
      } catch (e) {
        lastError = e
        // We stopped waiting, mineflayer did not: it keeps a swing interval
        // running and targetDigBlock set until the block update finally lands.
        try { bot.stopDigging() } catch {}
      }
      await sleep(120) // let a falling column settle before re-reading it
    }

    const left = bot.blockAt(pos)
    if (left && left.boundingBox === 'block') {
      const why = /sand|gravel/.test(left.name)
        ? `сверху сыпется ${left.name} на ${at(pos)} — колонка не кончается, веди штрек на уровень ниже`
        : `${left.name} на ${at(pos)} не поддаётся`
      return { dug, stopped: why + (lastError ? `: ${lastError.message}` : '') }
    }
  }
  return { dug, stopped: null }
}

// A block or so of walking on manual controls. Pathfinder re-plans the whole
// route for a single step, and with canDig on it happily digs its own detour
// out of the corridor we are trying to keep straight.
async function walkTo (bot, ctl, cell, ms = STEP_MS) {
  const centre = cell.offset(0.5, 0, 0.5)
  const until = Date.now() + ms
  try {
    await bot.lookAt(centre.offset(0, 1.6, 0), true)
    bot.setControlState('forward', true)
    while (Date.now() < until && !ctl.aborted) {
      if (flatDist(bot.entity.position, centre) < 0.35) break
      await sleep(60)
    }
  } catch {
    // A refused look is not a reason to give up the step — the body may have
    // drifted into the cell anyway, and the check below is the real answer.
  } finally {
    try { bot.clearControlStates() } catch {}
  }
  await sleep(120)
  return flatDist(bot.entity.position, centre) < 0.75
}

// ---------------------------------------------------------------- the axis

// A drift has exactly one coordinate that is allowed to change. Everything
// else — the body, a drop worth stepping aside for — is judged against the
// other one, which is fixed for the whole corridor by where we started.
function axisLine (start, dir) {
  const fixed = dir.dx ? Math.floor(start.z) : Math.floor(start.x)
  return p => (dir.dx ? Math.floor(p.z) : Math.floor(p.x)) === fixed
}

// Which end of the drift a thing is at. The corridor is open in exactly two
// directions, so the answer is a sign and not a vector.
function axisSign (from, dir, pos) {
  const along = (pos.x - (from.x + 0.5)) * dir.dx + (pos.z - (from.z + 0.5)) * dir.dz
  return along >= 0 ? 1 : -1
}

// Drops, but never at the price of the corridor. This used to be
// collectNearbyDrops, which hands every item to pathfinder.goto: one
// cobblestone that rolled into a side pocket was enough to walk the body a
// block off the line, and the drift then carried on from the new spot — a
// corridor asked to go due east came back a block off the line it started on.
// So a drop still on the line is worth a short manual step and a drop off it
// is left lying and merely counted: coming back for cobblestone is cheap,
// re-digging a bent corridor is not. `abandoned` lives for the whole corridor,
// because the same lost cobblestone is in range for the next four steps too and
// counting it four times would read as four losses.
async function sweepDrops (bot, ctl, onLine, budgetMs, abandoned) {
  const until = Date.now() + budgetMs
  const tried = new Set(abandoned)
  while (Date.now() < until && !ctl.aborted) {
    const me = bot.entity.position
    const drop = bot.nearestEntity(e =>
      e && e.name === 'item' && e.position && !tried.has(e.id) && e.position.distanceTo(me) <= 4)
    if (!drop) break
    tried.add(drop.id)
    if (!onLine(drop.position)) { abandoned.add(drop.id); continue }
    // Standing on top of an item is enough; the server hands it over a beat
    // later, and mineflayer has no event to wait on that is worth the wiring.
    await walkTo(bot, ctl, drop.position.floored(), 1200)
    await sleep(250)
  }
}

// ---------------------------------------------------------------- sealing off

// Every hostile in range, nearest first. combat.nearestHostile answers with one
// and only by distance, and distance alone is what walled this drift in: see
// mobVerdict below.
function hostilesWithin (bot, radius) {
  const me = bot.entity.position
  const out = []
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.name || !e.position) continue
    if (!HOSTILES.has(e.name)) continue
    if (e.position.distanceTo(me) > radius) continue
    out.push(e)
  }
  return out.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

// The question is not "is there a mob within six blocks" but "can this one get
// at me". Asking the first version paralysed the y=-51 run: a skeleton five
// blocks away behind untouched deepslate stopped four calls in a row at
// dug 0 / walked 0, and the answer even said so out loud — "между нами
// сплошная порода". The knowledge was there and did not reach the decision.
//
// Three answers, and the middle one is why direction has to be part of this:
//   reaches — reach.reachOf: it can hit us, shoot us, or walk to a square it
//             can hit us from within PATH_MAX cells;
//   ahead   — it cannot, it does not see us, and it sits in the tube this
//             drift is about to cut, so the rock protecting us is the rock we
//             are swinging at;
//   blocked — neither: background, keep digging.
// «Reaches» used to be «within 3 blocks, or canSeePoint», and over the cave at
// y=1 (run-surface-diamond.log 244-252) that stopped six drift calls in a row
// on mobs in the cave under the floor — the last a zombie straight down through
// a single block, which read «seen» at 3 blocks and «not seen» at 4. That last
// one is the proven case — behind a wall that did not close it never reached
// the bot; the five before it each ended behind a wall that did, so the log
// cannot say which of them had a way up (reach.js, top). Sight is the question
// for an arrow; for a walker it is whether there is a way, and reach.js asks
// that for both.
// A mob can still walk round, and that is covered by asking again between
// swings rather than by remembering where it stood — a mob that starts moving
// invalidates any history the moment it does, and the recheck sees it arrive.
// `r` is passed in when the caller already asked: one path search per mob per
// look, however many directions freeDirections tries it against.
function mobVerdict (bot, cursor, dir, tall, mob, r = reachOf(bot, mob)) {
  if (r.reaches) return 'reaches'
  const p = mob.position

  const along = (p.x - (cursor.x + 0.5)) * dir.dx + (p.z - (cursor.z + 0.5)) * dir.dz
  const side = (p.x - (cursor.x + 0.5)) * dir.dz + (p.z - (cursor.z + 0.5)) * -dir.dx
  const up = p.y - cursor.y
  // The drift is one square wide and `tall` high. Half a block of slack on each
  // face, so a mob in the cell behind a side wall counts as in the tube and one
  // cell further out does not — measured against the arena, not guessed: the
  // pocket beside a drift is what a natural cave looks like from in here.
  // Only without sight. A mob that sees us has air between us, not rock: on the
  // axis across a chasm it read «порода между нами есть, но штрек вскроет её» —
  // two false facts and a stop — where the same mob one cell off the axis was
  // rightly scenery. What keeps it out is the gap, not the face; and if the drift
  // closes that gap (a bridge, a window cut to two high), the next look between
  // swings asks reachOf again, gets «дойдёт», and walls it off there.
  const inTube = !r.sees && along > 0 && Math.abs(side) <= 1.5 && up > -1.5 && up < tall + 0.5
  return inTube ? 'ahead' : 'blocked'
}

// Which way this drift could be re-aimed without walking into the same answer.
// A refusal that repeats word for word four calls running is a hang, and the
// cheapest cure is naming the directions that are not refused.
function freeDirections (bot, cursor, tall, mobs) {
  const cache = new Map()
  const reach = mobs.map(m => reachOf(bot, m, { cache }))
  const out = []
  for (const key of ['east', 'west', 'north', 'south']) {
    const d = DIRS[key]
    if (mobs.every((m, i) => mobVerdict(bot, cursor, d, tall, m, reach[i]) === 'blocked')) out.push(key)
  }
  return out
}

// What the guard let be, as one record for the answer: the nearest, and how
// many there were. Kept per entity rather than in one slot, because the same
// mob can be scenery at one look and the threat at the next — log line 252 is
// exactly that zombie, reported beside itself as if there were two. A mob that
// has since left the world is not scenery any more and is not reported.
function nearestScenery (bot, scenery) {
  const live = [...scenery.entries()]
    .filter(([id]) => { const e = bot.entities[id]; return !!e && e.isValid !== false })
    .map(([, rec]) => rec)
    .sort((a, b) => a.dist - b.dist)
  if (!live.length) return undefined
  return live.length > 1 ? { ...live[0], seen: live.length } : live[0]
}

// How a mob that can get at us says so, in the words the brain decides with.
// «в 3 блоках» alone was read as «на мне» for a zombie that could not get up
// through the floor; the number of steps is what separates the two.
function reachWords (r) {
  if (r.how === 'дойдёт') return `дойдёт до меня за ${r.steps} шаг.`
  if (r.how === 'стреляет') return 'видит меня и бьёт с дистанции'
  if (r.how === 'сквозь стены') return 'достаёт сквозь породу'
  if (r.how === 'вплотную') return 'вплотную'
  return 'видит меня'
}

// The two mobs reach.js lets through rock, and why a wall is not an answer to
// either: a vex has no collision and flies through blocks; a warden's sonic boom
// ignores them inside BOOM_RANGE (SonicBoom in the server jar fires only while
// Warden.closerThan(target, 15, 20) — horizontal, vertical). A wall still stops a
// warden walking in, which is why sealOff still builds one, but «отгородись
// (mc_place)» sends the brain after the one move that does not help.
const BOOM_RANGE = 15
function wallWontHold (name) {
  return name === 'vex'
    ? 'стена его не держит — он летает сквозь блоки'
    : `стена его не держит — он бьёт сквозь породу на ${BOOM_RANGE} блоков`
}
function throughWallsCounter (name) {
  return name === 'vex'
    ? 'убей его (mc_fight)'
    : `уходи дальше ${BOOM_RANGE} блоков (mc_goto) или наверх (mc_surface)`
}

// The square (or two) between the body and the mob, in the *mob's* direction
// rather than the corridor's. In a drift those are the same thing — a mob can
// only come at you down the line. But the alarm also fires at the mouth, before
// the first column is cut, and there the corridor face is untouched stone while
// the mob is walking in from the cave the shaft broke into. That is exactly the
// diamond4.log case: dug 0, walked 0, zombie at six blocks. Sealing the face
// there would have reported "закрылся" over an opening that was never the way in.
function stepsToward (stand, target) {
  const dx = target.x - (stand.x + 0.5)
  const dz = target.z - (stand.z + 0.5)
  const ex = { dx: dx >= 0 ? 1 : -1, dz: 0 }
  const ez = { dx: 0, dz: dz >= 0 ? 1 : -1 }
  const out = Math.abs(dx) >= Math.abs(dz) ? [ex, ez] : [ez, ex]
  // A mob dead ahead down the corridor has no second direction worth a block.
  return Math.min(Math.abs(dx), Math.abs(dz)) < 0.6 ? out.slice(0, 1) : out
}

// Wall ourselves off instead of standing there. A drift 1 wide and 2 high is
// the best ground this bot ever gets — floor, ceiling and both walls to lean a
// block against, so one column of blocks closes it and only one mob can reach
// you, only head on. Open ground has none of that, which is why combat.retreat
// has to build its own cover from nothing. Here it is three-quarters built.
//
// Measured the other way round, diamond4.log at y=-29: the drift saw the zombie
// at six blocks, stopped honestly, reported, and left the body in the open
// corridor for the 10-30s a brain turn costs. The zombie walked six blocks in
// about three. Two lines later the log reads "здоровья 0".
async function sealOff (bot, ctl, stand, height, mob, mobPos, canBuild) {
  const out = { wall: null, placed: 0, sealed: false, solid: false, movedTo: null, reason: null }
  // `here` follows the body: the second direction is walled relative to where
  // the first one left us standing, not to where we started.
  let here = stand

  for (const step of stepsToward(stand, mobPos)) {
    let wall = here.offset(step.dx, 0, step.dz)

    // The mob standing in the very square the wall goes into is the ordinary
    // case at six blocks of warning, and the server refuses a placement inside
    // a living entity every time — build.js pays a full placement timeout for
    // each refusal. One cell back is a square we dug ourselves: walkable,
    // floored, and it hands us an empty square to build in.
    // Only worth a step with something to build once we get there: with an
    // empty bag this walk is a second and a half of being followed for nothing.
    if (canBuild && occupiedByEntity(bot, wall)) {
      const back = here.offset(-step.dx, 0, -step.dz)
      if (walkableCell(bot, back)) {
        await walkTo(bot, ctl, back, 1200)
        // The square we vacated is now the square between us and it.
        wall = here
        here = back
        out.movedTo = back
      }
    }

    // Head level first. A mob cannot walk through a one-high gap but it can
    // still reach through one, and the head block is also the one that breaks
    // line of sight.
    // Deliberately not checking ctl.aborted between the two blocks. The
    // low_health interrupt fires at 8 hp — three zombie hits — which is exactly
    // the middle of this loop, and an abort there would leave the corridor open
    // with one block lying in it. runIntent has already answered the brain by
    // then; the body finishing the wall behind that answer is the whole point,
    // and it is bounded at SEAL_MS per block.
    const reasons = []
    const footless = []
    for (let h = height - 1; h >= 0; h--) {
      const r = await placeBlockAt(bot, wall.offset(0, h, 0), { timeoutMs: SEAL_MS })
      if (r.ok) { if (!r.already) out.placed++ } else if (r.noFooting) footless.push(h)
      else reasons.push(r.reason)
    }
    // Head first has nothing to lean on outside a drift: on a bridge across a
    // room the head cell is open on all six sides until the block under it is in
    // (measured offline on exactly that bridge: «не к чему прислонить блок»,
    // placed 1, with a floor under the wall and blocks in the bag). The lower
    // block is that face, so those cells get one more try. Only those: a refusal
    // for any other reason — a mob in the cell, the server — would just be paid
    // for twice.
    for (const h of footless) {
      const r = await placeBlockAt(bot, wall.offset(0, h, 0), { timeoutMs: SEAL_MS })
      if (r.ok) { if (!r.already) out.placed++ } else reasons.push(r.reason)
    }

    out.wall = wall
    out.solid = columnSolid(bot, wall, height)
    if (!out.solid) { out.reason = reasons[0] || 'блок не встал'; continue }
    // Solid is not the same as safe. A wall that closes the corridor cuts every
    // way it had to us; one it can walk round or shoot past does not, and that
    // difference is the whole point of asking. Judged by the same question that
    // raised the alarm: a looser test here is how «закрыться не вышло» came back
    // at y=1 for a zombie under the floor that no wall could have mattered to.
    // A mob that died or despawned mid-wall is no longer a question at all.
    const left = mob.isValid ? reachOf(bot, mob) : null
    if (!left || !left.reaches) { out.sealed = true; return out }
    // One branch per way reachOf can still say yes, each true by construction.
    // The old catch-all «он не по оси штрека» was a guess, and a false one for a
    // warden standing on the axis. «долетит» and «не просчитал» both require
    // sight, so the last line holds for them.
    out.reason = left.how === 'дойдёт'
      ? `стена его не отрезает — обойдёт за ${left.steps} шаг.`
      : left.how === 'сквозь стены'
        ? wallWontHold(mob.name)
        : left.how === 'вплотную'
          ? 'он уже вплотную ко мне'
          : 'стена его не отрезает — он видит меня мимо неё'
  }
  return out
}

// Is the body standing in a drift — one square wide, roofed, walls on both
// sides — or merely somewhere a corridor happens to lead? try-cave-fight.js
// calls the two shapes opposites and it is right: in a drift one mob reaches
// you and only head on, and that single fact is what decides whether a fight
// here is winnable. Six blockAt calls, and the answer belongs in the report,
// because the brain is the one choosing between mc_fight and something else.
function inDrift (bot, cell, dir, height) {
  const solid = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' }
  for (let h = 0; h < height; h++) {
    if (!solid(cell.offset(dir.dz, h, -dir.dx))) return false
    if (!solid(cell.offset(-dir.dz, h, dir.dx))) return false
  }
  return solid(cell.offset(0, height, 0))
}

// ---------------------------------------------------------------- torches, ore

// placeBlockAt judges success by the target becoming solid, and a torch never
// is, so it reports failure even while the torch is burning: check by name.
// It also keeps trying the remaining faces after the torch has already landed,
// hence the short per-face wait. A torch that does not stick is never a reason
// to abandon the corridor.
async function placeTorch (bot, pos) {
  if (!itemNamed(bot, 'torch')) return false
  // Already lit (we are re-walking an old corridor): nothing to place, and
  // nothing to count either.
  const already = bot.blockAt(pos)
  if (already && /torch/.test(already.name)) return false
  try {
    await placeBlockAt(bot, pos, { item: 'torch', timeoutMs: 1200 })
  } catch {}
  const now = bot.blockAt(pos)
  return !!now && /torch/.test(now.name)
}

// Where the fair-play line runs, stated once because this is the exact edge
// the project cares about:
//
//   a block with a face on a cell we have just emptied is a block a player
//   standing in this corridor is looking at — recording it is honest;
//   a block still sealed in stone is not ours to know, however plainly
//   findBlocks reads it out of chunk memory.
//
// So the walls are written down at the moment they are opened. canSeeBlock
// only ever answers from where the body is standing *now*, and by the end of a
// run the first walls are behind it — that is how the iron two blocks into the
// drift went unreported while the coal near the face did not. This pass does
// not raycast at all: it does not have to, the wall is open by construction.
function noteExposedOre (bot, oreSet, cell, height, seen, groups, why) {
  for (let h = 0; h < height; h++) {
    const pos = cell.offset(0, h, 0)
    const air = bot.blockAt(pos)
    // A column the server refused to break is still stone, and everything
    // around it is still buried — nothing there is ours to report. Lava and
    // water count as 'empty' too, and those cells are exactly the ones we
    // turned back from: their walls were never opened and are not ours either.
    if (!air || air.boundingBox !== 'empty' || isLava(air) || isWater(air)) continue
    for (const face of FACES) {
      const block = bot.blockAt(pos.plus(face))
      if (!block || !oreSet.has(block.type)) continue
      const p = block.position
      const key = `${p.x},${p.y},${p.z}`
      if (seen.has(key)) continue
      seen.add(key)
      // Which claim this spot rests on. The wall of our own drift is open by
      // construction and stays true until something changes it; a raycast is
      // true about a moment. rememberOre keeps the difference so the brain can
      // read it back weeks later.
      if (why) why.set(key, 'стена штрека')
      const g = groups.get(block.name)
      if (g) g.push(p)
      else groups.set(block.name, [p])
    }
  }
}

// The other half of the report: ore that is further off but genuinely in view —
// across a cave the corridor broke into, say. noteExposedOre cannot see that,
// and line of sight is the whole point here, so this one does raycast. Asked
// every step rather than once at the end, because by the end the near walls are
// behind us and out of sight.
// Positions are kept, not distances: the bot moves a block between scans, and
// a "nearest" built from distances measured at four different standing spots
// points at the wrong ore. Ranking happens once, at the end, from where the
// body actually ended up.
function scanOres (bot, ids, useFair, seen, groups, radius, why) {
  let found = []
  try {
    found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 48 })
  } catch {
    return
  }
  for (const pos of found) {
    const key = `${pos.x},${pos.y},${pos.z}`
    if (seen.has(key)) continue
    try {
      const block = bot.blockAt(pos)
      if (!block) continue
      // findBlocks reads the chunk straight out of memory; this line is the
      // whole fog of war for the ore report.
      if (useFair && !bot.canSeeBlock(block)) continue
      seen.add(key)
      if (why) why.set(key, 'в прямой видимости')
      const g = groups.get(block.name)
      if (g) g.push(pos)
      else groups.set(block.name, [pos])
    } catch {
      // canSeeBlock raycasts and can throw on a chunk that is going away. One
      // unreadable block must not cost us the scan, let alone the tunnel.
    }
  }
}

// ---------------------------------------------------------------- tunnel

// ---------------------------------------------------------------- shaft down

// Колодец 1×1 вниз (поток overworld 02.10.2026, кампания ND_OW_DEEP): лесенка — 3.25 с на уровень (медиана 467
// шагов A1–A5), колодец — один блок на уровень, ~1–1.5 с. Старая беда колодца — карман лавы СБОКУ (2026-09-26,
// y 66→50: «tried to swim in lava»): actions.digDown смотрит только под ноги. Здесь перед каждым ударом чутьё
// (как danger(): только «нет», никогда не находит) смотрит клетку под ногами, две ниже и их четыре стороны:
// лава или вода — стоп и место названо (кампания уходит лесенкой/штреком); пустота под ногами глубже 3 блоков
// (прыжок с уроном) — стоп; враг рядом — стоп. Копается только блок под ногами (его верхняя грань видна).
const SHAFT_FREE_FALL = 3
// Сухое возвышение рядом для колодца (поток overworld, 02.10 вечер): низина с водой под самым дёрном (заснеженная
// равнина у замёрзшей реки, болото — ow-P1 слот 8: 10 колодцев подряд «вода на … (снизу)» в 100 бл. вокруг, ночь, смерть).
// Смотрим только верх рельефа — то, что видно глазами с места (холм выше воды), под землю не заглядываем: кольца 12…44 бл.,
// 16 направлений, верхний твёрдый блок столбца (не листва, не бревно, не вода/лёд), клетка над ним — воздух. Выше на ≥ 4 —
// лучше; ближе — лучше. Возвращает { x, y, z } (клетка ног) или null.
function dryGround (bot, { minRise = 4, rings = [12, 20, 28, 36, 44] } = {}) {
  try {
    const me = bot.entity.position.floored()
    let best = null
    for (const r of rings) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        const x = me.x + Math.round(Math.cos(a) * r)
        const z = me.z + Math.round(Math.sin(a) * r)
        let top = null
        for (let yy = me.y + 24; yy >= me.y - 6; yy--) {
          const b = bot.blockAt(new Vec3(x, yy, z))
          if (!b) break
          if (b.boundingBox === 'empty' && !/water|lava/.test(b.name)) continue
          if (/leaves|_log$|_wood$|vine|snow$/.test(b.name) && b.name !== 'snow_block') continue
          top = b
          break
        }
        if (!top || /water|lava|ice|magma|powder_snow/.test(top.name)) continue
        const over = bot.blockAt(top.position.offset(0, 1, 0))
        const head = bot.blockAt(top.position.offset(0, 2, 0))
        if (!over || !head || over.boundingBox !== 'empty' || head.boundingBox !== 'empty' || /water|lava/.test(over.name)) continue
        const rise = top.position.y + 1 - me.y
        if (rise < minRise) continue
        const score = rise - r / 12
        if (!best || score > best.score) best = { score, x, y: top.position.y + 1, z }
      }
    }
    return best ? { x: best.x, y: best.y, z: best.z } : null
  } catch { return null }
}
// Блок без «своего» инструмента, но ломается быстро (снег, наст — нужна лопата только ради снежков, рукой ~1 с:
// digTime без годного инструмента — /100 вместо /30): в проходке дроп не нужен. Руда — нет (её не тратим впустую),
// и только если лучший предмет в рюкзаке ломает за ≤ 1.5 с (ow-E3 02.10: «snow_block голыми руками не ломается» ×33
// у колодца и лесенки в снегах — пул хороших сидов наполовину заснеженный).
function quickBreak (bot, block) {
  try {
    // Лёд без шёлка оставляет воду (IceBlock.playerDestroy), рыхлый снег и магма — не проходка (Codex ow-review1).
    if (!block || /_ore$|ancient_debris|obsidian|spawner|^ice$|frosted_ice|powder_snow|magma_block/.test(block.name)) return false
    if (block.diggable === false || block.hardness == null || block.hardness < 0) return false
    // Время — как стоя на земле и не в воде (на неполном блоке снега onGround бывает false — digTime ×5, и снег
    // «не ломается» по порогу: ow-P3 02.10, слот 8 — «snow голыми руками не ломается» у колодца).
    let ms = Infinity
    for (const it of [null, ...((bot.inventory && bot.inventory.items()) || []).filter(i => /_(pickaxe|shovel|axe|hoe|sword)$/.test(i.name))]) {
      try { ms = Math.min(ms, block.digTime(it ? it.type : null, false, false, false, (it && it.enchants) || [], {})) } catch {}
    }
    return Number.isFinite(ms) && ms <= 1500
  } catch { return false }
}
async function shaftDown (session, ctl, { length = 16, timeoutSeconds = 180 } = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const want = clamp(length, 1, MAX_LENGTH, 16)
  const deadline = Date.now() + clamp(timeoutSeconds, 10, 600, 180) * 1000
  const before = countItems(bot)
  const from = xyz(bot.entity.position)
  let dug = 0
  let stopped = null
  let stuck = 0
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const startY = bot.entity.position.floored().y
  let sealedAt = null
  let lidAt = null
  let lidNote = null
  const lidHolds = () => {
    if (!lidAt) return false
    const b = bot.blockAt(lidAt)
    if (!b || b.boundingBox !== 'block') return false
    return sides.every(([dx, dz]) => { const n = bot.blockAt(lidAt.offset(dx, 0, dz)); return n && n.boundingBox === 'block' })
  }
  for (let i = 0; i < want * 2 && !ctl.aborted; i++) {
    const feet = bot.entity.position.floored()
    if (startY - feet.y >= want) break
    if (Date.now() > deadline) { stopped = `время вышло на ${startY - feet.y}-м уровне`; break }
    if ((bot.health ?? 20) <= LOW_HEALTH) { stopped = `хп ${Math.round(bot.health ?? 0)} — колодец бросаю`; break }
    // Моб — помеха, только если может до нас добраться (reach.reachOf: удар, выстрел, путь) или стоит прямо под
    // колодцем (вскроем его следующим ударом). Крипер в пещере за камнем в 5 блоках ниже — фон (ow-L2 02.10, слот 12:
    // десять «колодец бросаю» за секунду на одном месте).
    const mob = hostilesWithin(bot, MOB_RADIUS).find(m => {
      // Колодец закрыт блоком над головой (крышка цела, все 4 стенки у неё) — кто выше крышки, до нас не доберётся.
      if (sealedAt !== null && m.position.y > sealedAt && lidHolds()) return false
      let r = null
      try { r = reachOf(bot, m) } catch {}
      if (r && r.reaches) return true
      const p = m.position
      return Math.abs(p.x - (feet.x + 0.5)) <= 1.5 && Math.abs(p.z - (feet.z + 0.5)) <= 1.5 && p.y < feet.y && p.y > feet.y - 4
    })
    // Моб сверху, а я уже в колодце (стенки вокруг головы) — крышка: блок над головой к стенке по видимой грани
    // (build.placeBlockAt honest), и копать дальше. Так делает человек; раньше колодец бросался и кампания отвечала
    // мобу наверху (ow-E3 02.10: «крипер/паук/зомби сверху — колодец бросаю» ×30 за ночь, спуск по кругу).
    if (mob && sealedAt === null && mob.position.y > feet.y + 1 && startY - feet.y >= 2) {
      const lid = feet.offset(0, 2, 0)
      const walls = sides.filter(([dx, dz]) => { const b = bot.blockAt(lid.offset(dx, 0, dz)); return b && b.boundingBox === 'block' }).length
      // Только в целом колодце (4 стенки у крышки) и стоя на опоре: верх тела ниже клетки крышки (Codex: floored()
      // ноги при y+0.3 — тело уже в клетке ноги+2, сервер установку откажет).
      const top = bot.entity.position.y + (bot.entity.height || 1.8)
      if (walls === 4 && bot.entity.onGround !== false && top <= lid.y + 0.001) {
        let r = null
        try { r = await require('./build').placeBlockAt(bot, lid, { honest: true, steady: true, timeoutMs: 3000 }) } catch (e) { r = { ok: false, reason: e.message } }
        const lb = bot.blockAt(lid)
        if (r && r.ok && lb && lb.boundingBox === 'block') { sealedAt = lid.y; lidAt = lid; lidNote = `крышка над колодцем на ${at(lid)} (${mob.name} сверху)`; continue }
      }
    }
    if (mob) { stopped = `${mob.name} в ${mob.position.distanceTo(bot.entity.position).toFixed(1)} блоках ${mob.position.y < feet.y - 0.5 ? 'снизу' : 'сверху'} — колодец бросаю`; break }
    const below = bot.blockAt(feet.offset(0, -1, 0))
    if (!below) { stopped = `мир на ${at(feet.offset(0, -1, 0))} не прогружен`; break }
    if (below.name === 'bedrock') { stopped = `бедрок на ${at(below.position)} — ниже мира нет`; break }
    if (isLava(below)) { stopped = `лава на ${at(below.position)} (снизу) — не копаю`; break }
    if (isWater(below)) { stopped = `вода на ${at(below.position)} (снизу) — не копаю`; break }
    // Чутьё: клетка под ногами и та, что под ней, и их стороны.
    let hazard = null
    for (const dy of [-1, -2]) {
      const c = feet.offset(0, dy, 0)
      for (const [dx, dz] of [[0, 0], ...sides]) {
        if (dy === -1 && dx === 0 && dz === 0) continue
        const b = bot.blockAt(c.offset(dx, 0, dz))
        if (!b) { hazard = `мир на ${at(c.offset(dx, 0, dz))} не прогружен`; break }
        if (isLava(b)) { hazard = `лава на ${at(b.position)} (снизу) — колодец не копаю, обходи лесенкой или штреком`; break }
        if (isWater(b)) { hazard = `вода на ${at(b.position)} (снизу) — колодец не копаю, обходи лесенкой или штреком`; break }
      }
      if (hazard) break
    }
    if (hazard) { stopped = hazard; break }
    // Пустота под копаемым блоком: сколько лететь до опоры.
    const under = bot.blockAt(feet.offset(0, -2, 0))
    if (under && under.boundingBox === 'empty') {
      let fall = 1
      for (; fall <= 40; fall++) {
        const b = bot.blockAt(feet.offset(0, -1 - fall, 0))
        if (!b) break
        if (isLava(b) || isWater(b)) { fall = 99; break }
        if (b.boundingBox !== 'empty') break
      }
      if (fall > SHAFT_FREE_FALL) { stopped = `под ногами пустота (пещера) глубже ${SHAFT_FREE_FALL} — колодец бросаю на ${at(feet)}`; break }
    }
    const problem = quickBreak(bot, below) ? null : missingHarvestTool(bot, below, mcData)
    if (problem) { stopped = problem; break }
    try {
      await equipBestTool(bot, below)
      await withTimeout(bot.dig(below, true, new Vec3(0, 1, 0)), 8000, 'не копается')
      dug++
    } catch (e) { stopped = `не копается ${below.name}: ${e.message}`; break }
    const t0 = Date.now()
    while (Date.now() - t0 < 1200 && bot.entity.position.floored().y >= feet.y && !ctl.aborted) await sleep(50)
    for (let k = 0; k < 10 && !bot.entity.onGround && !ctl.aborted; k++) await sleep(50)
    // Удар без спуска (листва кроны, трава, блок вернулся) — три подряд: колодец здесь не идёт (ow-E2 02.10, слот 9:
    // 3 мин на месте на кроне тёмного дуба).
    if (bot.entity.position.floored().y >= feet.y) { if (++stuck >= 3) { stopped = `колодец не идёт с ${at(feet)} (копаю — не опускаюсь)`; break } } else stuck = 0
  }
  // Встал у воды у самой поверхности — подсказать сухое возвышение рядом (dryGround: только верх рельефа).
  const wetTop = stopped && /^вода на/.test(stopped) && startY - bot.entity.position.floored().y <= 4
  const dryAt = wetTop ? dryGround(bot) : null
  return {
    dug,
    from,
    depth: xyz(bot.entity.position),
    descended: startY - bot.entity.position.floored().y,
    gained: diffItems(before, countItems(bot)),
    ...(lidNote ? { note: lidNote } : {}),
    ...(dryAt ? { dryAt } : {}),
    stopped: stopped || undefined
  }
}

// Колодец вверх (поток overworld, 02.10 вечер): подъём по своему колодцу 1×1 столбом под ноги — build.digUp (потолок
// копается, если надо, с проверкой жидкости за ним; прыжок и блок под ноги, towerUp). Нужен глубокому пути: вода
// штреками у y 16 не нашлась (ow-P1: 2 из 8 прогонов без воды до конца), а поверху она почти всегда видна — подняться
// своим колодцем, зачерпнуть и снова вниз. toY — до какой высоты ног (устье колодца); моб, который дотянется, — стоп.
async function shaftUp (session, ctl, { length = 16, timeoutSeconds = 120, toY = null } = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const build = require('./build')
  const want = clamp(length, 1, MAX_LENGTH, 16)
  const deadline = Date.now() + clamp(timeoutSeconds, 10, 600, 120) * 1000
  const from = xyz(bot.entity.position)
  const startY = bot.entity.position.y
  let stopped = null
  const guard = () => {
    const m = hostilesWithin(bot, MOB_RADIUS).find(e => { try { const r = reachOf(bot, e); return r && r.reaches } catch { return false } })
    return m ? { who: m, dist: m.position.distanceTo(bot.entity.position) } : null
  }
  for (let i = 0; i < want * 2 && !ctl.aborted; i++) {
    const y = bot.entity.position.y
    if (toY !== null && Math.floor(y) >= toY) break
    if (y - startY >= want) break
    if (Date.now() > deadline) { stopped = `время вышло на +${Math.round(y - startY)}`; break }
    if ((bot.health ?? 20) <= LOW_HEALTH) { stopped = `хп ${Math.round(bot.health ?? 0)} — подъём бросаю`; break }
    const r = await build.digUp(bot, ctl, { blocks: 1, mcData, tower: true, guard })
    if (bot.entity.position.y - y < 0.5) { stopped = r.stopped || 'выше не поднимаюсь'; break }
  }
  return { from, to: xyz(bot.entity.position), climbed: Math.round(bot.entity.position.y - startY), stopped: stopped || undefined }
}

async function tunnel (session, ctl, {
  direction = null,
  length = 16,
  height = 2,
  torchEvery = 8,
  timeoutSeconds = 180,
  toY = null
} = {}) {
  // Вниз — колодец со своим чутьём (см. shaftDown); вверх — своим колодцем столбом (shaftUp).
  if (direction === 'down' || direction === 'вниз') return shaftDown(session, ctl, { length, timeoutSeconds })
  if (direction === 'up' || direction === 'вверх') return shaftUp(session, ctl, { length, timeoutSeconds, toY })
  const bot = session.bot
  const mcData = session.mcData
  const dir = resolveDirection(bot, direction)
  const len = clamp(length, 1, MAX_LENGTH, 16)
  // The body is two blocks tall. A one-high corridor is a hole it cannot enter,
  // so a request for one is rounded up instead of dug and then reported as a
  // failure on the first step.
  const tall = clamp(height, 2, 3, 2)
  const every = clamp(torchEvery, 0, MAX_LENGTH, 8)
  const deadline = Date.now() + clamp(timeoutSeconds, 10, 600, 180) * 1000

  const useFair = session.cfg.fairPlay !== false

  // Three minutes of bare-handed swinging that yields nothing is the worst way
  // to spend an intent, so the tool question is settled before the first swing.
  let cursor = bot.entity.position.floored()
  const rock = firstSolidAhead(bot, cursor, dir, tall, len, useFair)
  if (rock) {
    const problem = quickBreak(bot, rock) ? null : missingHarvestTool(bot, rock, mcData)
    if (problem) throw new Error(problem)
  }

  const from = xyz(bot.entity.position)
  // Where the corridor starts is the end the bot walks back in from, which is
  // what makes distance-from-the-mouth the number the brain can act on.
  const mouth = cursor.clone()
  const onLine = axisLine(cursor, dir)
  const before = countItems(bot)
  const oreIds = resolveBlockIds('any_ore', mcData)
  const oreSet = new Set(oreIds)
  const seen = new Set()
  const groups = new Map()
  // Why each spot is in the report, carried alongside it so the ledger written
  // at the end can say "стена штрека" or "в прямой видимости" instead of
  // flattening two different degrees of knowledge into one.
  const why = new Map()

  // The shaft we are standing in is open air we did not have to cut, and its
  // walls are as visible as any we are about to open.
  noteExposedOre(bot, oreSet, cursor, tall, seen, groups, why)

  // runIntent answers the brain the moment an interrupt fires and leaves this
  // loop running behind it, so everything that outlives us is torn down here:
  // a held key and a live swing. Nothing in the drift sets a pathfinder goal
  // any more, but one left over from the intent before would keep walking the
  // body out of the corridor, and clearing it costs nothing.
  ctl.onAbort.push(() => {
    try { bot.clearControlStates() } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.stopDigging() } catch {}
  })

  let dug = 0
  let walked = 0
  let torches = 0
  let offAxis = 0
  let lastTorch = null
  const abandoned = new Set()
  let stopped = null
  // What the brain has to bring for the same call to get further next time.
  // A refusal that only says "нечем" is readable and not actionable.
  let need = null
  let threat = null
  // Set only when calling this again, unchanged, would answer the same thing.
  // Same convention as survival.surface, and for the same reason: the brain
  // calls these in a loop, so a refusal that repeats word for word has to say
  // out loud that it is a wall and not a wait.
  let note = null
  // Hostiles the guard looked at and decided were scenery, by entity id. Worth
  // reporting even though they changed nothing: the brain should hear that
  // there is a zombie under the floor even when the drift walks straight on.
  const scenery = new Map()

  // The plan is what the corridor follows, never the body. Plenty can shove us
  // off the line — a drop we stepped aside for, a mob, a gravel column coming
  // down — and a drift that resumes from wherever the feet ended up is a drift
  // that bends. So the body is put back on the cursor before the next column is
  // cut, and the count goes into the result instead of quietly into the corridor.
  //
  // Distance *along* the line is held for a harder reason than tidiness. The
  // drop sweep is allowed to walk a couple of blocks back down the corridor,
  // and bot.dig never checks reach — mineflayer has canDigBlock but dig does
  // not call it — so a swing at a column four blocks away is dropped by the
  // server without a word and costs the full 20s dig timeout before digColumn
  // reports the stone as unbreakable. False means the body could not be brought
  // back within reach of the next column: a reason to end the drift honestly
  // rather than keep swinging at nothing.
  const offCursor = () => flatDist(bot.entity.position, cursor.offset(0.5, 0, 0.5))
  const holdAxis = async () => {
    if (ctl.aborted) return true
    const drifted = !onLine(bot.entity.position)
    if (!drifted && offCursor() < 1.2) return true
    if (drifted) offAxis++
    await walkTo(bot, ctl, cursor, 1500)
    return offCursor() <= 2.5
  }

  // The standing guard. Asked at the top of every step and between swings
  // inside digColumn, so the worst case between two looks is one block of
  // digging rather than one whole column.
  const watch = () => {
    const health = Math.round(bot.health ?? 20)
    const hurt = health < LOW_HEALTH
    const near = hostilesWithin(bot, hurt ? MOB_RADIUS_HURT : MOB_RADIUS)
    // One block read per cell for the whole look, however many mobs share it.
    const cache = new Map()
    for (const mob of near) {
      const r = reachOf(bot, mob, { cache })
      const why = mobVerdict(bot, cursor, dir, tall, mob, r)
      if (why === 'blocked') { scenery.set(mob.id, sceneryOf(mob, r)); continue }
      scenery.delete(mob.id)
      return { kind: 'mob', mob, health, why, reach: r }
    }
    if (hurt) return { kind: 'health', health }
    return null
  }

  // Close the corridor first, report second. The old order — report first,
  // close never — is the one that got the bot killed at y=-29.
  const answerMob = async (mob, health, why, r) => {
    const stand = bot.entity.position.floored()
    // Snapshot: everything reported is measured at the moment of the alarm, so
    // the numbers in the answer belong to the same instant as the decision.
    const mobPos = mob.position.clone()
    const dist = Math.round(mobPos.distanceTo(bot.entity.position) * 10) / 10
    const sign = axisSign(stand, dir, mobPos)
    const where = sign > 0 ? 'впереди' : 'позади'
    const have = fillerCount(bot)
    threat = { mob: mob.name, where, dist, at: xyz(mobPos), health, drift: inDrift(bot, stand, dir, tall) }
    // How it gets at us, so the stop can be told apart from the y=1 kind: a
    // number of steps is a way in, «вплотную» is contact, «стреляет» is sight.
    if (r && r.how) { threat.how = r.how; if (r.steps !== null) threat.steps = r.steps }

    // Rock between us and it, and it sits in the tube we are cutting. No wall is
    // attempted: the wall is already there and it is ours to break, so reporting
    // "заложился, placed 0" would credit the bot with building the very stone it
    // is about to remove — the exact sentence that repeated four calls running.
    if (why === 'ahead') {
      threat.rockBetween = true
      threat.inPath = true
      const free = freeDirections(bot, stand, tall, hostilesWithin(bot, MOB_RADIUS_HURT))
      note = free.length
        ? `штрек на ${dir.ru} упирается в ${mob.name} за породой — этим же вызовом ничего не изменится; свободно: ${free.join(', ')}`
        : `${mob.name} перекрывает все четыре стороны — копать отсюда бесполезно, сначала убей (mc_fight) или уйди по вертикали`
      return `${mob.name} в ${dist} блоках ${where} на ${at(mobPos)}: порода между нами есть, но штрек идёт прямо на него и вскроет её`
    }

    const seal = await sealOff(bot, ctl, stand, tall, mob, mobPos, have > 0)
    if (seal.wall) threat.wall = xyz(seal.wall)
    threat.placed = seal.placed
    threat.sealed = seal.sealed
    // The body may have stepped back out of the square the wall went into; the
    // corridor plan follows it, or the tidy-up walk at the end would march
    // straight back into the wall we just built.
    if (seal.movedTo) cursor = seal.movedTo

    const how = r ? `, ${reachWords(r)}` : ''
    if (seal.sealed) {
      // The way in can close between the alarm and the wall — the mob moves.
      // Saying "заложился" then would credit the bot with a wall it did not
      // build and hide the fact that the way in is somewhere else entirely.
      return seal.placed
        ? `${mob.name} в ${dist} блоках ${where}${how} — заложился на ${at(seal.wall)}, ${seal.placed} бл., проход закрыт`
        : `${mob.name} в ${dist} блоках ${where}, между нами сплошная порода на ${at(seal.wall)} — стою за ней`
    }

    // The wall did not close. The old answer here walked the body back down
    // the drift to the last torch, and that answer is dead: measured in
    // try-tunnel, the bot backed seven blocks off a zombie and died on the
    // square the retreat ended at (memory/state.json, 598,50,620); measured
    // again in try-corridor, three blocks back cost 17 hp in six seconds.
    // Sprint is off to keep the physics in sync with the server, so a zombie is
    // simply faster than this body — README has said so from the first day and
    // this is the third confirmation. Walking away from melee does not work in
    // any amount.
    //
    // So the retreat is not traded for a better retreat, it is removed. What it
    // actually spent was the one thing that does help: the seconds before the
    // brain gets to decide. This branch now answers in well under a second when
    // the bag is empty — pickFiller returns null before a single packet goes
    // out. Choosing to fight instead is not a mining intent's call to make, and
    // combat doctrine lives in combat.js, so the answer states the ground it
    // would be fought on and leaves mc_fight to the brain.
    const refusal = seal.reason || 'блок не встал'
    // Blocks and the shape of the drift are both beside the point against a mob
    // that comes through rock: asking for blocks, or saying «only head on», would
    // steer the brain towards a wall or a fight in the drift.
    const throughWalls = !!r && r.how === 'сквозь стены'
    if (!have && !throughWalls) need = { what: 'любые блоки на перегородку', count: tall, have: 0 }
    const ground = throughWalls
      ? 'штрек от него не укрывает'
      : threat.drift
        ? 'штрек 1×2, подойти он может только в лоб'
        : 'я не в штреке, обойти ему есть где'
    // It can get at us, so it will be able to again: this refusal repeats word
    // for word until the mob or the empty bag is dealt with, and neither of
    // those two moves belongs to a mining intent. Same wording problem
    // survival.surface hit and solved the same way.
    note = throughWalls
      ? `штрек будет отвечать то же самое, пока ${mob.name} рядом, и стена тут не поможет — ${throughWallsCounter(mob.name)}`
      : have
        ? `штрек будет отвечать то же самое, пока ${mob.name} рядом — убей (mc_fight) или отгородись (mc_place), потом зови`
        : `штрек будет отвечать то же самое с пустым рюкзаком — принеси ${tall} блока на перегородку или убей (mc_fight)`
    return `${mob.name} в ${dist} блоках ${where}${how}, закрыться не вышло (${refusal}); ${ground}`
  }

  const answerAlarm = async (alarm) => {
    if (alarm.kind === 'mob') return answerMob(alarm.mob, alarm.health, alarm.why, alarm.reach)
    note = 'на этом здоровье штрек будет вставать сразу — поешь или отлежись, потом зови'
    return `здоровья ${alarm.health} из 20 — вылезаю, штрек брошен на ${walked}-м блоке из ${len}`
  }

  for (let step = 1; step <= len; step++) {
    if (ctl.aborted) { stopped = `прервано на ${walked}-м блоке из ${len}`; break }
    if (Date.now() >= deadline) { stopped = `время вышло на ${walked}-м блоке из ${len} — позови ещё раз, продолжу отсюда`; break }

    const alarm = watch()
    if (alarm) { stopped = await answerAlarm(alarm); break }

    // The same line the staircase holds, priced per cell: a drift cuts `tall`
    // of them per block. Stopping here with forty swings left is what pays for
    // the walk back to the mouth; stopping when the pickaxe is already gone
    // pays for nothing — that is the y=-58 shape exactly.
    const worn = toolShortfall(bot, mcData, { need: tall * SWINGS_PER_CELL })
    if (worn) {
      stopped = worn
      need = { what: 'кирка', count: 1, have: 0, swingsLeft: toolBudget(bot, 'pickaxe') }
      break
    }

    if (!(await holdAxis())) {
      stopped = `сбило с оси: я на ${at(bot.entity.position)}, штрек идёт по ${at(cursor)} — вернуться не смог`
      break
    }

    const cell = cursor.offset(dir.dx, 0, dir.dz)
    const risk = danger(bot, cursor, cell, tall, dir)
    if (risk) { stopped = risk; break }

    const cut = await digColumn(bot, mcData, ctl, cell, tall, deadline, watch)
    dug += cut.dug
    // Before the break, not after it: a column that only opened halfway still
    // opened, and the wall it uncovered is the reason we came down here.
    noteExposedOre(bot, oreSet, cell, tall, seen, groups, why)
    if (cut.alarm) { stopped = await answerAlarm(cut.alarm); break }
    if (cut.stopped) { stopped = cut.stopped; need = cut.need || null; break }

    // A cave under the next step is a fall we would then have to climb out of,
    // so the floor gets laid before the foot goes down.
    const floorPos = cell.offset(0, -1, 0)
    const floor = bot.blockAt(floorPos)
    if (!floor || floor.boundingBox !== 'block') {
      const bridge = await placeBlockAt(bot, floorPos, { timeoutMs: 4000 })
      if (!bridge.ok) {
        // "нечем строить" told the brain nothing it could act on: dug 0 walked 4
        // and no idea what to pack. An estimate of the whole rest of the drift
        // is the honest upper bound — a cave under one step is usually a cave
        // under the next ten.
        const rest = Math.max(1, len - walked)
        const have = fillerCount(bot)
        need = { what: 'любые блоки на засыпку пола', count: rest, have }
        stopped = `под ногами дыра на ${at(floorPos)}: нужно ~${rest} блоков на засыпку, в рюкзаке ${have} (${bridge.reason})`
        break
      }
    }

    const behind = cursor
    const moved = await walkTo(bot, ctl, cell)
    if (!moved) {
      const stall = describeStall(bot)
      stopped = `не смог шагнуть в ${at(cell)}: в ногах ${stall.legs}, в голове ${stall.head}, под ногами ${stall.ground}`
      break
    }
    walked++

    // The body is the source of truth for height: one unnoticed step down and
    // every column after it would be cut at the wrong level.
    const stood = bot.entity.position.floored()
    cursor = Math.abs(stood.y - cell.y) <= 2 ? cell.offset(0, stood.y - cell.y, 0) : cell
    // Stepping down into a cave puts the body in a cell nobody cut, whose walls
    // are open all the same. Without this the drift loses exactly the ore it
    // just walked past — the same loss noteExposedOre exists to prevent.
    if (!cursor.equals(cell)) noteExposedOre(bot, oreSet, cursor, tall, seen, groups, why)

    await sweepDrops(bot, ctl, onLine, 2500, abandoned)
    // Back on the cursor before the torch goes in: a sweep that walked two
    // blocks back leaves the torch either in the wrong square or out of reach,
    // and an unlit corridor is what the walk home is ambushed in.
    await holdAxis()

    // The cell we just left: empty, floored, and out of the way of the swing.
    if (every && step % every === 0) {
      if (await placeTorch(bot, behind)) { torches++; lastTorch = behind }
    }

    scanOres(bot, oreIds, useFair, seen, groups, 4, why)
  }

  // Whatever else went wrong, we do not leave the body standing in a side
  // pocket: the corridor is the way back to the mouth, and `to` is read as
  // where the drift ended. A deliberate retreat or a step back to build a wall
  // has already moved the cursor with the body, so this does not undo either.
  await holdAxis()

  scanOres(bot, oreIds, useFair, seen, groups, 6, why)
  const here = bot.entity.position
  const round1 = d => Math.round(d * 10) / 10
  // Two distances, because they answer two different questions: fromHere is
  // what it costs to turn round and dig it out now, fromMouth is what it costs
  // to come back for it later down a corridor that is already lit.
  const ores = [...groups.entries()]
    .map(([name, spots]) => {
      const nearest = spots.reduce((a, b) => (a.distanceTo(here) <= b.distanceTo(here) ? a : b))
      return { name, count: spots.length, nearest, dist: nearest.distanceTo(here) }
    })
    .sort((a, b) => a.dist - b.dist)
    .map(g => ({
      name: g.name,
      count: g.count,
      nearest: xyz(g.nearest),
      fromHere: round1(g.dist),
      fromMouth: round1(g.nearest.distanceTo(mouth))
    }))

  // The drift's own memory, and the only place in the daemon it is written.
  // Everything in groups got there through noteExposedOre or through a raycast
  // that reached the block, so writing all of it down writes down exactly what
  // a person walking this corridor saw — no more. The ores list above keeps
  // only the nearest of each kind because that is what fits in an answer; the
  // ledger keeps every spot, because nearest is the one the bot is about to
  // take and the other three are the reason to come back.
  const spots = []
  for (const [name, positions] of groups) {
    for (const p of positions) {
      spots.push({ name, x: p.x, y: p.y, z: p.z, seen: stamp(), why: why.get(`${p.x},${p.y},${p.z}`) || 'стена штрека' })
    }
  }
  let remembered = 0
  try { remembered = rememberOre(session, spots) } catch {}

  // A call that dug nothing and walked nowhere will answer the same thing next
  // time unless something outside this intent changes, and the y=-51 run spent
  // four calls proving it. Naming that is the whole difference between a
  // refusal and a hang.
  if (!note && stopped && !walked && !dug) {
    note = /лава|вода|бедрок/.test(stopped)
      ? 'в эту сторону штрек не пойдёт вообще — меняй направление или уровень'
      : 'с этого места вызов повторится тем же ответом'
  }

  // A corridor is a place the bot comes back to; coordinates that live only in
  // one tool result are lost the moment the context is compacted.
  if (walked || threat) {
    try {
      session.journal.append(
        'шахта',
        `штрек на ${dir.ru}, ${walked} блоков, ` +
        (ores.length ? `в стенах: ${ores.map(o => `${o.name}×${o.count}`).join(', ')}` : 'руды не видно') +
        (offAxis ? `, ${offAxis} раз сносило с оси` : '') +
        (threat ? `, ${threat.mob} ${threat.where}: ${threat.inPath ? 'в забое за породой' : threat.sealed ? 'заложился' : 'закрыться не вышло'}` : '') +
        (stopped ? ` (встал: ${stopped})` : ''),
        bot.entity.position
      )
    } catch {}
  }

  return {
    direction: dir.name,
    from,
    to: xyz(bot.entity.position),
    dug,
    gained: diffItems(before, countItems(bot)),
    walked,
    remaining: Math.max(0, len - walked),
    torches,
    offAxis,
    leftBehind: abandoned.size,
    lastTorch: lastTorch ? xyz(lastTorch) : undefined,
    ores,
    // How many of those spots are new to memory, and how many the bot is
    // carrying in total. This is what makes mc_mine_seen callable later: the
    // coordinates outlive the tool result they arrived in.
    remembered,
    oreMemory: (() => { try { return ledgerOf(session).length } catch { return undefined } })(),
    threat: threat || undefined,
    behindRock: nearestScenery(bot, scenery),
    need: need || undefined,
    stopped: stopped || undefined,
    note: note || undefined
  }
}


// ---------------------------------------------------------------- ore memory

// Where the drift's ore report used to end: inside one tool result, which the
// next context compaction threw away. The y=-59 run is the whole argument. The
// drift answered
//     deepslate_diamond_ore x2, nearest 139,-57,159, fromMouth 16.1
// and four drifts later `mine deepslate_diamond_ore` answered
//     не вижу deepslate_diamond_ore в радиусе 24
//     (смотрю честно, только по прямой видимости)
// Both halves are correct on their own terms — the drift reported a wall it had
// personally opened, mine re-derived visibility from where the body was now
// standing — and between them they lost the diamonds while the coordinates sat
// in the brain's own context.
//
// Fair play (config.fairPlay) does not say "only what is in front of the eyes
// right now". It says only what a person could know, and a person who saw
// diamonds in the wall of their own drift remembers where they are and walks
// back for them. Forgotten ore is knowledge, not x-ray. So the ledger is
// allowed, and it is fenced by the same two rules the report already obeys:
//
//   written — only from a face opened onto a cell we emptied (noteExposedOre)
//             or from a raycast that actually reached the block (scanOres).
//             Never from findBlocks alone: that is the fog of war and it stays
//             exactly where it was.
//   read    — only a coordinate already in this ledger is actionable. One the
//             brain invents is refused however plainly the chunk reads out
//             underneath it. That refusal IS the x-ray guard, and try-ore case
//             (г) measures it: a real diamond block the bot never saw, still in
//             the wall after the call.
//
// And the third rule, which keeps memory from turning into a lie: memory is
// never reported as sight. The block is re-read on arrival, from within reach,
// and «помню» and «вижу» stay different words in the answer — the vein can be
// gone (a cave-in, another player, lava), and "добыл" for a block that is not
// there costs more than saying nothing.

// Capped on the way in. The deaths list in memory/state.json grew without a
// bound until compactState had to be written to stop it eating the answer;
// this one does not get to repeat that.
const LEDGER_MAX = 120
// How far off a remembered coordinate a request may land and still mean it.
// One block: a brain copying coordinates out of a drift report is exact, and a
// brain that is one out meant the block it can name. Two would start being a
// search, and a search through stone is the x-ray we are avoiding.
const SNAP = 1
// Where memory is allowed to become sight. Within five blocks the wall is
// simply in front of the body — the same "open by construction" the drift's own
// report leans on. Reading blockAt from forty blocks away is reading the chunk
// out of client memory, which is precisely what fairPlay forbids.
const VERIFY_RANGE = 5
// A walk this long is not a detour, it is a trip, and it should be the brain's
// decision (mc_goto) rather than a surprise inside a mining call.
const MAX_TRIP = 200

const posKey = p => `${p.x},${p.y},${p.z}`
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 16)

function ledgerOf (session) {
  const s = session.journal.state
  // EMPTY_STATE in journal.js predates this key, and loadState() merges the
  // file over the template — so in a memory written before today the key is
  // simply absent rather than empty.
  if (!Array.isArray(s.ore)) s.ore = []
  return s.ore
}

// One row per block, never per vein: four rows is four coordinates the brain
// can hand back one at a time. `why` is kept because "стена штрека" (opened by
// us, certain) and "в прямой видимости" (a raycast across a cave, and whatever
// was in the way can move) are different degrees of the same claim.
function rememberOre (session, spots) {
  if (!spots || !spots.length) return 0
  let added = 0
  session.journal.patch(s => {
    if (!Array.isArray(s.ore)) s.ore = []
    const have = new Set(s.ore.map(posKey))
    for (const spot of spots) {
      if (have.has(posKey(spot))) continue
      have.add(posKey(spot))
      s.ore.push(spot)
      added++
    }
    if (s.ore.length > LEDGER_MAX) s.ore.splice(0, s.ore.length - LEDGER_MAX)
  })
  return added
}

// Struck off the moment the world disagrees — whether we took the block or
// found the square bare. A ledger that keeps offering a coordinate the body has
// already stood on and found empty is worse than no ledger.
function forgetOre (session, positions) {
  if (!positions.length) return
  const gone = new Set(positions.map(posKey))
  session.journal.patch(s => {
    if (Array.isArray(s.ore)) s.ore = s.ore.filter(r => !gone.has(posKey(r)))
  })
}

// What the bot remembers, and nothing else: this never touches the world. It is
// tempting to blockAt() every row and mark the stale ones, and that is exactly
// the x-ray — freshness is only ever established by walking there, which is why
// every row goes out with the warning attached.
function recallOre (session, { block = null, limit = 12 } = {}) {
  const bot = session.bot
  const me = bot && bot.entity ? bot.entity.position : null
  const want = block ? String(block).trim().toLowerCase() : null
  let rows = ledgerOf(session)
  if (want && want !== 'any_ore') {
    rows = rows.filter(r => r.name === want || r.name.includes(want) || want.includes(r.name))
  }
  const spots = rows.map(r => ({
    name: r.name,
    at: { x: r.x, y: r.y, z: r.z },
    seen: r.seen,
    why: r.why,
    fromMe: me ? Math.round(Math.hypot(r.x - me.x, r.y - me.y, r.z - me.z) * 10) / 10 : undefined
  })).sort((a, b) => (a.fromMe ?? 0) - (b.fromMe ?? 0))

  const kinds = {}
  for (const r of rows) kinds[r.name] = (kinds[r.name] || 0) + 1
  return {
    remembered: rows.length,
    kinds,
    spots: spots.slice(0, limit),
    note: rows.length
      ? 'это память, а не зрение: блока может уже не быть — проверю на месте и скажу честно'
      : 'руды не помню вообще — копай штрек (mc_tunnel), он записывает стены в момент вскрытия'
  }
}

// The refusal has to be actionable or it is a hang. "не помню" on its own sends
// the brain round the same call; the y=-51 log is four turns of exactly that.
function noSuchMemory (session, asked, name) {
  const mem = recallOre(session, {})
  const kinds = Object.entries(mem.kinds).map(([n, c]) => `${n}x${c}`).join(', ')
  const what = asked ? `на ${at(asked)}` : `${name || 'такой руды'} нигде`
  const known = mem.remembered
    ? `Помню: ${kinds}; ближайшая ${mem.spots[0].name} на ${at(mem.spots[0].at)} (${mem.spots[0].fromMe} от меня) — зови с этими координатами. `
    : 'Не помню пока ничего. '
  return new Error(
    `не помню руды ${what} — я её не видел, а сквозь камень не смотрю. ${known}` +
    'Чтобы было что добывать: копай штрек (mc_tunnel) на глубине от -59 до -54, ' +
    'он записывает руду в момент вскрытия стены и отдаёт координаты в ores — с ними и зови.'
  )
}

// Exact hit first, then one block of slack, and never a search: the rows are
// the only candidates that exist, so the worst this can do is aim at something
// the bot has already seen.
function pickTarget (session, asked, name) {
  const rows = ledgerOf(session)
  if (!rows.length) return null
  if (asked) {
    const p = { x: Math.floor(asked.x), y: Math.floor(asked.y), z: Math.floor(asked.z) }
    const exact = rows.find(r => r.x === p.x && r.y === p.y && r.z === p.z)
    if (exact) return { row: exact, asked: p, snapped: false }
    const near = rows
      .filter(r => Math.max(Math.abs(r.x - p.x), Math.abs(r.y - p.y), Math.abs(r.z - p.z)) <= SNAP)
      .sort((a, b) =>
        (Math.abs(a.x - p.x) + Math.abs(a.y - p.y) + Math.abs(a.z - p.z)) -
        (Math.abs(b.x - p.x) + Math.abs(b.y - p.y) + Math.abs(b.z - p.z)))[0]
    return near ? { row: near, asked: p, snapped: true } : null
  }
  const want = name ? String(name).trim().toLowerCase() : null
  const me = session.bot.entity.position
  const fit = rows
    .filter(r => !want || want === 'any_ore' || r.name === want || r.name.includes(want) || want.includes(r.name))
    .sort((a, b) =>
      Math.hypot(a.x - me.x, a.y - me.y, a.z - me.z) - Math.hypot(b.x - me.x, b.y - me.y, b.z - me.z))
  return fit.length ? { row: fit[0], asked: null, snapped: false } : null
}

// The moment memory meets sight, and the only place in this file where a
// remembered coordinate is allowed to become a fact. The body is within reach
// of a square it has been carrying since some earlier drift, so for the first
// time the block can honestly be looked at.
//
// Four answers, and «далеко» is the one that makes the other three legal.
// blockAt on a coordinate forty blocks away reads the chunk straight out of
// client memory — that is precisely the x-ray fairPlay forbids, and it is the
// same call findBlocks makes that the fog of war exists to filter. So outside
// VERIFY_RANGE this refuses to look at all and concludes nothing: the freshness
// of a row is established by walking there, never by asking from the mouth of
// the corridor.
//
// «не прогружено» is deliberately not folded into «нет». An unloaded chunk is
// the absence of knowledge, and answering «нет» to it would strike a live vein
// off the ledger for good on the strength of a packet that had not arrived.
function verify (bot, row) {
  const pos = new Vec3(row.x, row.y, row.z)
  const gap = bot.entity.position.distanceTo(pos)
  if (gap > VERIFY_RANGE) return { state: 'далеко', gap: Math.round(gap * 10) / 10 }
  const b = bot.blockAt(pos)
  if (!b) return { state: 'не прогружено' }
  if (b.name === row.name) return { state: 'на месте', block: b }
  return { state: 'нет', found: b.name, block: b }
}

// Walking a corridor we already cut is the cheap half of coming back for ore,
// and it only stays cheap if pathfinder is not allowed to invent a shortcut:
// with canDig on it will cut a fresh diagonal through the wall and spend the
// pickaxe we came here to use. So the road is attempted walk-only first, the
// digging movements are the fallback, and the difference is reported —
// dugOnTheWay true means the corridor is broken somewhere, and our own anti-mob
// wall from an earlier drift is the usual reason.
async function travelTo (session, ctl, target, budgetMs) {
  const bot = session.bot
  const started = Date.now()
  const swingsBefore = toolBudget(bot, 'pickaxe')
  const from = bot.entity.position.clone()
  const goal = new Vec3(target.x + 0.5, target.y, target.z + 0.5)

  const left = () => Math.max(0, budgetMs - (Date.now() - started))
  let error = null
  let dugOnTheWay = false

  // Already within reach of the wall — the "два блока вбок" case — must not
  // cost a pathfinder plan at all.
  if (from.distanceTo(goal) > VERIFY_RANGE) {
    const walkOnly = new Movements(bot)
    walkOnly.canDig = false
    walkOnly.allow1by1towers = false
    walkOnly.allowSprinting = false

    for (const leg of [{ mv: walkOnly, dug: false }, { mv: null, dug: true }]) {
      if (ctl.aborted || left() < 3000) break
      if (leg.mv) bot.pathfinder.setMovements(leg.mv)
      else session.updateMovements(true)

      const guard = stuckGuard(bot, ctl, 8000)
      let timer = null
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 3)),
          guard.promise,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('дорога не уложилась в срок')), left())
          })
        ])
        dugOnTheWay = leg.dug
        error = null
        break
      } catch (e) {
        error = e
        try { bot.pathfinder.setGoal(null) } catch {}
      } finally {
        guard.stop()
        if (timer) clearTimeout(timer)
      }
    }
    session.updateMovements(true)
  }

  const to = bot.entity.position
  return {
    from: xyz(from),
    to: xyz(to),
    meters: Math.round(from.distanceTo(to) * 10) / 10,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    // The number the brain budgets with. Down a corridor that is already cut
    // this is zero, and zero is the entire point of the walk-only leg.
    swings: Math.max(0, swingsBefore - toolBudget(bot, 'pickaxe')),
    dugOnTheWay,
    left: Math.round(to.distanceTo(goal) * 10) / 10,
    error: error ? error.message : undefined
  }
}

// Getting inside pickaxe reach of a block in the wall. Three rungs, cheapest
// first, and the third one is the drift's own step — danger(), digColumn(),
// walkTo() — because a notch is a one-cell drift and this file already knows
// how to cut one. Nothing new is invented here on purpose.
async function approach (session, ctl, pos, deadline) {
  const bot = session.bot
  const mcData = session.mcData
  const reachable = () => { const b = bot.blockAt(pos); return !!b && bot.canDigBlock(b) }

  if (reachable()) return { ok: true, notch: 0 }

  // Rung two: let pathfinder find a square the block can be swung from.
  // Walk-only first, for the same reason the road is.
  const walkOnly = new Movements(bot)
  walkOnly.canDig = false
  walkOnly.allowSprinting = false
  for (const mv of [walkOnly, null]) {
    if (ctl.aborted || Date.now() >= deadline) break
    if (mv) bot.pathfinder.setMovements(mv)
    else session.updateMovements(true)
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 })),
        Math.min(20000, Math.max(4000, deadline - Date.now())),
        'не подойти'
      )
    } catch {
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    if (reachable()) { session.updateMovements(true); return { ok: true, notch: 0 } }
  }
  session.updateMovements(true)

  // Rung three: cut toward it. Two cells is enough for anything in the wall of
  // our own drift; further than that and the honest answer is that the ore is
  // not where we thought the corridor was.
  let notch = 0
  for (let i = 0; i < 2; i++) {
    if (ctl.aborted || Date.now() >= deadline) break
    const me = bot.entity.position.floored()
    const dx = pos.x - me.x
    const dz = pos.z - me.z
    // Straight up or straight down: reach is the answer, and a notch here would
    // only dig the floor out from under the body.
    if (!dx && !dz) break
    const dir = Math.abs(dx) >= Math.abs(dz)
      ? (dx >= 0 ? DIRS.east : DIRS.west)
      : (dz >= 0 ? DIRS.south : DIRS.north)
    const cell = me.offset(dir.dx, 0, dir.dz)
    // The same probe the drift runs before every column, under the same rule:
    // it may only ever refuse. A lava pocket behind the vein is found here,
    // before the swing, instead of in the face after it.
    const risk = danger(bot, me, cell, 2, dir)
    if (risk) return { ok: false, reason: risk, notch }
    const cut = await digColumn(bot, mcData, ctl, cell, 2, Math.min(deadline, Date.now() + 25000))
    if (cut.stopped) return { ok: false, reason: cut.stopped, need: cut.need, notch }
    if (!(await walkTo(bot, ctl, cell))) {
      const stall = describeStall(bot)
      return { ok: false, reason: `не смог шагнуть в ${at(cell)}: в ногах ${stall.legs}, в голове ${stall.head}`, notch }
    }
    notch++
    if (reachable()) return { ok: true, notch }
  }
  return { ok: false, reason: `до ${at(pos)} не дотянуться: выемка на ${notch} блока не помогла`, notch }
}

// Picking up what we just broke, and saying so when we cannot.
//
// Measured, y=-59 arena, 2026-08-31: case (б) dug the ore, the block vanished
// from the wall, and the answer read `dug: 1, gained: {}`. Case (д) took a
// four-block vein and read `dug: 4, gained: {}`. Two separate causes, and the
// old one-line call to sweepDrops was blind to both.
//
// Cause one is timing. sweepDrops polls bot.entities ONCE and breaks the moment
// nothing is in range — which is right for the drift, where it runs after every
// one of twenty-four steps and a 2.5s wait per step would cost a minute of
// nothing. Called once, straight after a dig, it runs before the server's spawn
// packet for the item has arrived, finds an empty list, and returns. The report
// was then assembled around an inventory nothing had been added to yet. So the
// drops are waited FOR before they are judged missing.
//
// Cause two is reach, and it is not a bug. Vanilla hands an item over at about
// a block; a vein opened sideways scatters its drops across cells whose floor
// we never cut, so the body has nowhere to stand and no honest way to get them
// without digging more. tunnel already has the name for that — `leftBehind`,
// drops it counted and deliberately did not chase — so this reports the same
// thing with the coordinates attached. "добыл 4, поднял 1, три лежат на
// 1704,-59,1822" is a sentence the brain can act on. `gained: {}` next to
// `dug: 4` is the exact silence this whole task is about.
const DROP_NEAR = 3.5

async function collectVein (bot, ctl, spots, { waitMs = 1500, budgetMs = 8000 } = {}) {
  const until = Date.now() + budgetMs
  const mine = () => Object.values(bot.entities).filter(e =>
    e && e.name === 'item' && e.position &&
    spots.some(s => e.position.distanceTo(s) <= DROP_NEAR))

  // Wait for them to exist at all: anything decided before this is decided
  // about a packet that has not landed. Its own short window, not the whole
  // budget — a block that drops nothing (or drops it down a cave) must cost
  // a second and a half, not eight.
  const waitUntil = Date.now() + waitMs
  while (Date.now() < waitUntil && !ctl.aborted && !mine().length) await sleep(150)

  // Then sweep for as long as sweeping is still achieving something. Each pass
  // is the drift's own collector with the axis rule switched off — outside a
  // corridor there is no line to bend, and the item is the whole reason we came
  // back. A pass that moves nothing means the rest is out of reach, and one
  // wasted pass is the cheapest possible way to establish that.
  const abandoned = new Set()
  let guard = 0
  while (Date.now() < until && !ctl.aborted && mine().length && guard++ < 4) {
    const before = mine().length
    await sweepDrops(bot, ctl, () => true, Math.min(2500, until - Date.now()), abandoned)
    await sleep(300) // the server hands the stack over a beat after we stand on it
    if (mine().length >= before) break
  }

  // Дроп провалился в карман жилы в стене («туда телу не встать, в стене под
  // ними нет пола»): шаг вперёд (walkTo) туда не ведёт, а живой игрок просто
  // прорубит клетку. Кампания 2026-09-26: жила железа — 8 руды, в рюкзаке 1,
  // пять слитков в стене при том, что железа на кирку и ведро не хватало.
  // Pathfinder с копанием (updateMovements: canDig при кирке; dontCreateFlow —
  // жидкость не вскрывает), ближние — не дальше 6 блоков, по 6 с на каждый.
  for (const e of mine().slice(0, 4)) {
    if (ctl.aborted) break
    if (!e.position || e.position.distanceTo(bot.entity.position) > 6) continue
    const c = e.position.floored()
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(c.x, c.y, c.z, 1)), 6000, 'не дошёл до дропа')
    } catch {
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    await sleep(400)
  }

  return mine().map(e => xyz(e.position))
}

// Come back for ore the bot has already seen with its own eyes.
//
// This is the intent the y=-59 run was missing. `mine` stays the right tool for
// "there is a tree in front of me": it looks, finds and takes. This one starts
// from the ledger instead of from the eyes, and that is the only difference
// that matters — it is also the difference between a bot that walks past its
// own diamonds and one that goes back for them.
async function mineSeen (session, ctl, {
  at: asked = null,
  block = null,
  count = 8,
  timeoutSeconds = 180
} = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const deadline = Date.now() + clamp(timeoutSeconds, 20, 600, 180) * 1000
  const want = clamp(count, 1, 64, 8)

  const chosen = pickTarget(session, asked, block)
  if (!chosen) throw noSuchMemory(session, asked || null, block)
  const row = chosen.row
  const first = new Vec3(row.x, row.y, row.z)

  const trip = bot.entity.position.distanceTo(first)
  if (trip > MAX_TRIP) {
    throw new Error(
      `${row.name} на ${at(row)} я помню, но до неё ${Math.round(trip)} блоков — это поход, а не добор. ` +
      `Дойди сначала (mc_goto x=${Math.floor(row.x)} z=${Math.floor(row.z)} y=${Math.floor(row.y)}), потом зови меня оттуда.`)
  }

  // Naming the block in a refusal is safe here and only here: it is already in
  // the ledger, so the sentence tells the brain nothing it did not write down
  // itself. firstSolidAhead has the opposite rule for the opposite reason — the
  // rock in front of a fresh drift has never been seen by anyone.
  const probe = bot.blockAt(first)
  if (probe && probe.name === row.name) {
    const problem = missingHarvestTool(bot, probe, mcData)
    if (problem) throw new Error(problem)
  }

  const before = countItems(bot)
  const oreSet = new Set(resolveBlockIds('any_ore', mcData))
  ctl.onAbort.push(() => {
    try { bot.clearControlStates() } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.stopDigging() } catch {}
  })

  // Not the drift's whole mob doctrine — that lives in tunnel() and combat.js
  // and does not belong to a two-block errand. Just the one question a person
  // digging in a wall would actually ask: can something close by get at me.
  // Asked with the drift's own reachOf, because this guard used to be a private
  // «within 3 blocks, or canSeePoint» and at y=1 it refused three calls in a row
  // with «zombie в 3 блоках вплотную» — for a zombie in the cave under a
  // one-block floor, which the drift beside it had already called scenery.
  const scenery = new Map()
  const watch = () => {
    const cache = new Map()
    for (const mob of hostilesWithin(bot, ERRAND_LOOK)) {
      const r = reachOf(bot, mob, { cache })
      if (!r.reaches) { scenery.set(mob.id, sceneryOf(mob, r)); continue }
      scenery.delete(mob.id)
      return { kind: 'mob', mob, reach: r }
    }
    return null
  }
  // One sentence for both places the errand can meet it, carrying the words
  // that tell contact from a way in: «вплотную» is said only when it is true.
  const mobStop = (alarm) => {
    const r = alarm.reach
    threat = { mob: alarm.mob.name, dist: r.dist, at: xyz(alarm.mob.position), where: r.where, how: r.how }
    if (r.steps !== null) threat.steps = r.steps
    return `${threat.mob} в ${threat.dist} блоках ${r.where}, ${reachWords(r)} — добор бросил, взято ${taken.length}`
  }

  const travel = await travelTo(session, ctl, first,
    Math.min(90000, Math.max(15000, (deadline - Date.now()) * 0.6)))

  const taken = []
  const struck = []
  const gone = []
  const exposed = []
  let stopped = null
  let need = null
  let threat = null

  // The vein. The first block is opened from memory; everything after it is
  // opened from sight, by exactly the rule noteExposedOre uses for the report —
  // a face on a cell we have just emptied is a face a person standing here is
  // looking at. Which is why the rest of the vein never has to be in the ledger,
  // and why a corner-only neighbour is left alone: a player would have to break
  // more stone to see that one too.
  const queue = [first]
  const done = new Set()

  while (queue.length && taken.length < want) {
    const pos = queue.shift()
    if (done.has(posKey(pos))) continue
    done.add(posKey(pos))
    if (ctl.aborted) { stopped = `прервано, взято ${taken.length}`; break }
    if (Date.now() >= deadline) { stopped = `время вышло, взято ${taken.length} из ${want}`; break }

    const alarm = watch()
    if (alarm) { stopped = mobStop(alarm); break }

    // Memory meets sight, and the order matters: the square is read before the
    // body is walked toward it, not after. Being close enough to see it is the
    // whole licence to look at all — from forty blocks away blockAt is reading
    // the chunk out of client memory, which is the x-ray fairPlay forbids, so
    // verify() answers «далеко» there and nothing is concluded from it.
    let seenNow = verify(bot, { name: row.name, x: pos.x, y: pos.y, z: pos.z })
    if (seenNow.state === 'не прогружено') {
      stopped = `мир на ${at(pos)} не прогружен — постой рядом и позови ещё раз`
      break
    }
    // The ore is gone and we can already see that it is: answered from where
    // the body stands, without a pathfind into a wall with nothing behind it.
    if (seenNow.state === 'нет') {
      gone.push({ at: xyz(pos), помнил: row.name, сейчас: seenNow.found })
      struck.push(pos)
      if (pos.equals(first)) break
      continue
    }

    const near = await approach(session, ctl, pos, deadline)
    if (!near.ok) {
      // The first block failing is the whole call failing; a vein block failing
      // is one block left in the wall, and the rest of the vein is still ours.
      if (!taken.length) {
        // When the road itself never arrived, the road's reason is the true one:
        // "до X не дотянуться" would blame the wall for a corridor that is
        // blocked thirty blocks back.
        stopped = travel.error && travel.left > VERIFY_RANGE
          ? `не дошёл до ${at(pos)}: ${travel.error} (осталось ${travel.left})`
          : near.reason
        need = near.need || null
        break
      }
      continue
    }

    // The walk took a second or two, and a square can change in one. This is
    // the read that decides, and it happens with the body within reach.
    seenNow = verify(bot, { name: row.name, x: pos.x, y: pos.y, z: pos.z })
    // Could not look, as opposed to looked and found nothing. approach() only
    // returns ok when canDigBlock passes, so this is close to impossible — but
    // the two outcomes strike the row off and the difference between them is
    // losing a live vein for good, so they do not share a branch.
    if (seenNow.state === 'далеко' || seenNow.state === 'не прогружено') {
      if (!taken.length) { stopped = `не разглядел ${at(pos)} вблизи (${seenNow.state})`; break }
      continue
    }
    const here = seenNow.block
    if (seenNow.state !== 'на месте' || !here || !oreSet.has(here.type)) {
      // Honest, and this is the whole of case (в): the coordinate is right, the
      // ore is not. "добыл" here, or a throw, would both be worse than simply
      // saying what is in the square now.
      gone.push({
        at: xyz(pos),
        помнил: row.name,
        сейчас: seenNow.found || (here ? here.name : 'не прогружено')
      })
      struck.push(pos)
      if (pos.equals(first)) break
      continue
    }

    // Lava behind the vein, asked before the swing rather than felt after it.
    // Same probe, same wording, same one-way rule as every other cell this file
    // cuts: danger() may refuse and may never point at anything worth having.
    const me = bot.entity.position.floored()
    const toward = Math.abs(pos.x - me.x) >= Math.abs(pos.z - me.z)
      ? (pos.x - me.x >= 0 ? DIRS.east : DIRS.west)
      : (pos.z - me.z >= 0 ? DIRS.south : DIRS.north)
    const risk = danger(bot, me, pos, 1, toward)
    if (risk) {
      stopped = risk
      if (!taken.length) break
      continue
    }

    const name = here.name
    const cut = await digColumn(bot, mcData, ctl, pos, 1, Math.min(deadline, Date.now() + 30000), watch)
    if (cut.alarm) { stopped = mobStop(cut.alarm); break }
    if (!cut.dug) {
      if (!taken.length) { stopped = cut.stopped; need = cut.need || null; break }
      continue
    }
    taken.push({ name, at: xyz(pos) })
    struck.push(pos)

    // The cell is empty now, so its six faces are open — the same instant
    // noteExposedOre is written for. Ore of our kind joins the vein; ore of
    // another kind is not ours to dig on this call, but it IS now genuinely
    // seen, so it goes into the ledger for the next one.
    const opened = []
    for (const face of FACES) {
      const nb = bot.blockAt(pos.plus(face))
      if (!nb || !oreSet.has(nb.type)) continue
      if (nb.name === name) {
        if (!done.has(posKey(nb.position))) queue.push(nb.position)
      } else {
        opened.push({
          name: nb.name,
          x: nb.position.x,
          y: nb.position.y,
          z: nb.position.z,
          seen: stamp(),
          why: 'вскрыл жилу'
        })
        exposed.push({ name: nb.name, at: xyz(nb.position) })
      }
    }
    if (opened.length) rememberOre(session, opened)

    // Lava that flowed in after the block came out. digColumn refuses to swing
    // into lava but cannot know what was behind the block it just removed.
    const spill = FACES.map(f => bot.blockAt(pos.plus(f))).find(isLava)
    if (spill) {
      stopped = `за рудой на ${at(pos)} оказалась лава (${at(spill.position)}) — взял ${taken.length}, ` +
        'дальше не лезу; заткни (mc_place) или обходи с другой стороны'
      break
    }
  }

  // The drops, judged against the squares we actually opened rather than
  // against whatever happens to be lying near the body.
  let leftDrops = []
  if (taken.length && !ctl.aborted) {
    leftDrops = await collectVein(bot, ctl, taken.map(t => new Vec3(t.at.x, t.at.y, t.at.z)))
  }

  // Struck off whether we took it or found the square bare: both are the world
  // disagreeing with the row, and a row still offered after the body has stood
  // on it is the ledger lying.
  forgetOre(session, struck)

  const gained = diffItems(before, countItems(bot))
  // Items, not blocks: one lapis ore pays out four or more. The pair
  // (dug, picked) is what makes a shortfall visible at a glance.
  const picked = Object.values(gained).reduce((sum, c) => sum + c, 0)
  const left = recallOre(session, { block: row.name, limit: 3 })
  const status = taken.length ? 'добыл' : gone.length ? 'пусто' : 'не вышло'

  let note = null
  // Полный рюкзак — первое, что проверить: дроп рядом не подбирается вовсе,
  // и раньше это читалось как «туда телу не встать» (кампания 2026-09-26:
  // «ещё 4 лежат» в клетке самого штрека, а после pack tidy тело подобрало 17).
  const bagFull = bot.inventory.emptySlotCount() === 0
  if (leftDrops.length && bagFull) {
    note = `добыл ${taken.length}, в рюкзаке ${picked}, ещё ${leftDrops.length} лежат на ${at(leftDrops[0])}` +
      `${leftDrops.length > 1 ? ' и рядом' : ''} — РЮКЗАК ПОЛОН, подобрать некуда. ` +
      'Освободи место (mc_pack mode=tidy, also cobblestone:128) — лежащее рядом подберётся само.'
  } else if (leftDrops.length) {
    note = `добыл ${taken.length}, в рюкзаке ${picked}, ещё ${leftDrops.length} лежат на ${at(leftDrops[0])}` +
      `${leftDrops.length > 1 ? ' и рядом' : ''} — туда телу не встать, в стене под ними нет пола. ` +
      'Забрать: прокопай клетку вбок (mc_tunnel length 1) и позови ещё раз, или брось их — это выбор, а не потеря.'
  } else if (!taken.length && gone.length) {
    note = `блока на ${at(gone[0].at)} больше нет — из памяти вычеркнул, второй раз не предлагай. ` +
      (left.remembered
        ? `Ещё помню ${row.name}: ${left.remembered} шт, ближайшая на ${at(left.spots[0].at)}.`
        : `Другой ${row.name} не помню — нужен новый штрек (mc_tunnel).`)
  } else if (taken.length && !picked) {
    note = `сломал ${taken.length}, а в рюкзаке пусто и дропа рядом не вижу — ` +
      'скорее всего укатился (пещера, вода) или рюкзак полон. Проверь инвентарь и осмотрись (mc_observe).'
  } else if (taken.length && left.remembered) {
    note = `${row.name} помню ещё ${left.remembered} шт, ближайшая на ${at(left.spots[0].at)} — ` +
      'зови ещё раз с этими координатами'
  } else if (threat && !taken.length) {
    // «сначала убери причину» names no call; for a mob there are exactly two —
    // and for one that comes through rock, the wall is not one of them.
    note = threat.how === 'сквозь стены'
      ? `пока ${threat.mob} рядом, добор отсюда ответит то же, и стена тут не поможет — ${throughWallsCounter(threat.mob)}`
      : `пока ${threat.mob} может до меня добраться, добор отсюда ответит то же — убей его (mc_fight) или отгородись (mc_place), потом зови`
  } else if (!taken.length && !gone.length && stopped) {
    note = 'с этого места вызов повторится тем же ответом — сначала убери причину из stopped'
  }

  try {
    session.journal.append('шахта',
      `добор по памяти: ${row.name} на ${at(row)} (видел ${row.seen || '?'}) — ` +
      (taken.length ? `взял ${taken.length}` : gone.length ? 'блока уже нет' : `не вышло: ${stopped || '?'}`) +
      `; дорога ${travel.meters} бл., ${travel.seconds}с, кирка ${travel.swings} ударов`,
      bot.entity.position)
  } catch {}

  return {
    status,
    target: { x: row.x, y: row.y, z: row.z },
    name: row.name,
    // The honesty line, in the answer and not only in the docs: this is what
    // the bot remembered and when, never what it can see from here.
    помнил: { руда: row.name, видел: row.seen || null, откуда: row.why || null },
    snapped: chosen.snapped ? { просили: chosen.asked, взял: { x: row.x, y: row.y, z: row.z } } : undefined,
    travel,
    dug: taken.length,
    vein: taken.map(t => t.at),
    gained,
    // Same word tunnel uses for the same thing, so the brain learns it once.
    // A count beside `dug` and `picked` is what turns a silent shortfall into
    // a fact; the coordinates are what make it recoverable.
    picked,
    leftBehind: leftDrops.length || undefined,
    leftAt: leftDrops.length ? leftDrops : undefined,
    gone: gone.length ? gone : undefined,
    exposed: exposed.length ? exposed : undefined,
    // Deliberately not named "threat": format.js keys its warning line on that
    // field and prints «закрыться НЕ вышло» for it — a claim about a wall this
    // intent never tries to build. The stop reason already spells the mob out,
    // and the renderer promotes that one honestly.
    mob: threat || undefined,
    // Same record, same field name as tunnel's: a mob close by that cannot
    // get at us, said so that the errand carrying on is not read as blindness.
    behindRock: nearestScenery(bot, scenery),
    remembered: ledgerOf(session).length,
    need: need || undefined,
    stopped: stopped || undefined,
    note: note || undefined
  }
}

module.exports = { tunnel, shaftDown, shaftUp, dryGround, mineSeen, recallOre, rememberOre }

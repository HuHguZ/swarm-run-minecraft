'use strict'
import { placeBlockAt, occupiedByEntity } from '../build'
import { HOSTILES } from '../combat'
import { reachOf } from '../reach'
import { DIRS, SEAL_MS, columnSolid, walkableCell, walkTo } from './dig-core'

// ---------------------------------------------------------------- sealing off

// Every hostile in range, nearest first. combat.nearestHostile answers with one
// and only by distance, and distance alone is what walled this drift in: see
// mobVerdict below.
function hostilesWithin (bot, radius) {
  const me = bot.entity.position
  const out = []
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
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

export { hostilesWithin, mobVerdict, freeDirections, nearestScenery, reachWords, throughWallsCounter, sealOff, inDrift }

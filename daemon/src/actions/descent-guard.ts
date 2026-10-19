'use strict'
// Сторож спуска: стена вокруг тела, когда рядом мобы (descentGuard).
// ---------------------------------------------------------------- the guard on the way down
import { dirName, standingCell } from './stair-steps'
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { xyz }: typeof import('../movement') = require('../movement')
const { placeBlockAt, pickFiller }: typeof import('../build') = require('../build')
// The way down had no eyes, and try-diamond «вниз» of 2026-09-16 paid for it:
// the leg west from y=-7 came back with four damage events and 14 hp, the next
// leg took five more and was cut off by low_health, and the drift called right
// after met «zombie в 0.7 блоках впереди, вплотную». Nine hits on a body that
// kept swinging. Nothing in the staircase or the shaft ever asked about a mob,
// and dig_down is rightly not interrupted by damage (session.js: chip damage
// must not throw a descent away) — so between two autopilot turns nobody looked.
//
// The drift (mining.tunnel's watch) and the climb (survival.surface's watch)
// already answer this, and the answer here is theirs: look between swings, ask
// reach.reachOf whether the mob can actually get at us, close the way with
// blocks when it can, report it as scenery when it cannot, and stop with the
// reason and a call when the wall does not close. A radius instead of reachOf
// would stop the staircase for every zombie in every cave it passes over — the
// y=1 paralysis reach.js was written to end.
//
// Twelve blocks for the climb's reason (MOB_WATCH): reach.PATH_MAX is twelve
// cells, and a look before every swing sees anything further off arrive.
const GUARD_RADIUS = 12
// Per placement. A wall that works lands in a tenth of a second (survival.js,
// case з); what this bounds is a refused face, and placeBlockAt pays it once per
// usable face of the cell.
const GUARD_LEASH_MS = 1000
// Everything one alarm may spend before the answer is «не закрылся» — the
// climb's WALL_BUDGET_MS, measured there: past it the wall is not slow, it is
// not happening, and the body is standing still being hit.
const GUARD_WALL_MS = 2500
// What one call may spend on walls, counted both ways, the climb's WALL_LIMIT
// and WALL_BLOCKS: past them the walls are not closing anything.
const GUARD_WALLS = 4
const GUARD_BLOCKS = 10

// Where the wall goes. Not survival.wallOff, although it is the same move,
// because on a staircase down its column stands one step too low. Both its
// shapes put the blocks at OUR feet and head toward the mob, and a mob on a
// descent comes down the steps we just cut: the step behind has its tread level
// with our feet and its open cells one higher than ours. The feet cell toward it
// is that tread — rock — so wallOff places one block, leaves the step's upper
// cell open, and asks a ray (shutOut) whether that worked: «заслон не закрыл его
// (1 бл.)» over a walker the block did stop, and a clear line down the stairs
// for a skeleton.
//
// So the cells are found from our own air rather than from our height: the open
// cells touching the column the body stands in — feet, head, and the cell over
// the head when it is open, which a staircase and a shaft both have — one face
// at a time. On a staircase with the mob behind, that face IS the step behind:
// its cell level with our head and the one over it. Two blocks, and a walker on
// the step above then stands on our block with rock over our head — nowhere for
// 1.95 of body to go, and too high for its attack box, which grows sideways and
// never up. In a shaft the face is the cell over the head when the mob is above,
// and the cave mouth beside us when it is not. Order: the bearing it mostly lies
// in, then overhead, then the other bearing, and reachOf is asked after each
// face, so a face that did not matter costs nothing more.
//
// The cell is standingCell's — the one digStairs itself cuts from — and not
// position.floored(). Over a cave the body comes to rest past the edge of the
// step holding it up (standingCell's own comment, measured), floored() then
// names the column ahead, and every face computed from it is one column off:
// the guard lays a single block over its own head, the step behind — the way
// down the mob is walking — stays wide open, and reachOf, asked from that same
// drifted body, sees that block on the eye line and answers «closed». Review
// arena of 2026-09-16: wall [106,56], one block, «заложился», and the leg
// walking on, where the centred body walls 105,55 and 105,56.
function guardFaces (bot, mob) {
  const feet = standingCell(bot)
  const open = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'empty' && !/lava|water/.test(b.name) }
  const tall = open(feet.offset(0, 2, 0)) ? 3 : 2
  const dx = mob.position.x - (feet.x + 0.5)
  const dz = mob.position.z - (feet.z + 0.5)
  const alongX = Math.abs(dx) >= Math.abs(dz)
  const main = alongX ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1]
  const other = alongX ? [0, Math.sign(dz) || 1] : [Math.sign(dx) || 1, 0]
  const face = ([sx, sz]: any) => ({
    bearing: [sx, sz],
    cells: [0, 1, 2].slice(0, tall).map(h => feet.offset(sx, h, sz)).filter(open)
  })
  const faces = [face(main)]
  if (tall === 3 && mob.position.y >= feet.y + 2 && open(feet.offset(0, 3, 0))) {
    faces.push({ bearing: null, cells: [feet.offset(0, 2, 0)] })
  }
  faces.push(face(other))
  return faces.filter(f => f.cells.length)
}

// Put the faces down and ask reachOf after each, the way mining.sealOff judges
// its own wall: solid is not the same as closed. No ctl.aborted between cells,
// for sealOff's reason too — low_health fires in the middle of exactly this, and
// an abort there leaves the way open with one block lying in it.
async function guardWall (bot, mob) {
  const { reachOf }: typeof import('../reach') = require('../reach')
  const deadline = gameClock.now() + GUARD_WALL_MS
  const put = []
  const why = []
  let left = null
  const faces = guardFaces(bot, mob)
  // It gets at us through cells that are not ours to fill — up through a floor
  // we are standing on the edge of, or down a shaft whose ceiling is rock. Said
  // out loud, because «блоки встали, но не перекрыли» would be a lie about
  // blocks that were never placed.
  if (!faces.length) why.push('между нами нет ни одной открытой клетки, которую я могу заложить')
  for (const f of faces) {
    for (const cell of f.cells) {
      if (gameClock.now() >= deadline) break
      const r = await placeBlockAt(bot, cell, { timeoutMs: GUARD_LEASH_MS })
      if (r.ok && !r.already) put.push({ at: cell, bearing: f.bearing })
      else if (!r.ok && !why.includes(r.reason)) why.push(r.reason)
    }
    left = mob.isValid === false ? null : reachOf(bot, mob)
    if (!left || !left.reaches) return { sealed: true, put, why }
    if (gameClock.now() >= deadline) { why.push('время на стену вышло'); break }
  }
  if (!left) left = mob.isValid === false ? null : reachOf(bot, mob)
  if (!left || !left.reaches) return { sealed: true, put, why }
  return { sealed: false, put, why, left }
}

// The words mining.tunnel answers with, so the brain hears the same sentence
// from the drift and from the stairs.
function reachWords (r) {
  if (r.how === 'дойдёт') return `дойдёт до меня за ${r.steps} шаг.`
  if (r.how === 'стреляет') return 'видит меня и бьёт с дистанции'
  if (r.how === 'сквозь стены') return 'достаёт сквозь породу'
  if (r.how === 'вплотную') return 'вплотную'
  return 'видит меня'
}

// One guard per call. `dir` is the staircase's bearing (null for the shaft): a
// wall in that bearing is a wall the next swing cuts back out. `again` is the
// call that resumes this descent, named in every stop.
//
// The report carries what the drift and the climb carry: `met` — every mob this
// call answered and what the answer was (заложился / закрыт породой / мимо / не
// закрылся / сквозь стены), `threat` — the one that stopped it, with `next` as
// fields ({call, target | direction}) for a caller that reads fields rather
// than Russian, and `behindRock` — the nearest mob seen and let be.
//
// `own` says whether `again` is our own mc_dig_down. It is not always: mc_recover
// digs with this same staircase and chose the bearing itself, so a stop there
// that names «mc_dig_down direction=…» abandons the errand — mc_dig_down knows
// nothing about the pile — and the bearing is not ours to change either.
function descentGuard (session, { dir = null, again, own = true }: any) {
  const bot = session.bot
  const met = []
  const scenery = new Map()
  // survival.surface's `passed`: a mob whose wall failed and which was doing
  // nothing to us, re-asked on every look by the same test that let it pass.
  const passed = new Set()
  let walls = 0
  let blocks = 0
  let threat = null
  // Required at call time: survival requires this module back at load.
  // dangerousNow/whereToFight сейчас экспортирует survival/out-of-water, а не survival: здесь они не находятся (BLIND).
  const survival = (): Partial<typeof import('../survival')> & { dangerousNow?: typeof import('../survival/out-of-water').dangerousNow, whereToFight?: (trail: any[], reach: number, seen?: number, who?: string, again?: string) => string } => { try { return (require('../survival') as typeof import('../survival')) } catch { return {} } }

  // survival.dangerousNow when survival.js exports it. Without it every wall
  // that did not close is a stop — the cautious reading, never a quiet «мимо».
  // The words are about the bot, not about the tree: which export is missing is
  // not a fact the brain has any lever on, and `danger` is read aloud. The cause
  // stays visible where it is actionable — a machine field for whoever greps.
  const BLIND = 'опасен он сейчас или нет, я проверить не могу — считаю опасным'
  const dangerous = (mob) => {
    const s = survival()
    if (typeof s.dangerousNow !== 'function') return BLIND
    return s.dangerousNow(session, { who: mob, dist: mob.position.distanceTo(bot.entity.position) })
  }

  // survival.whereToFight without a trail: its «на 2 ступеньки вниз по моей же
  // лестнице» is the climb's retreat, and on the way down our stairs lead up —
  // to where the mob usually came from. Its fifth argument names the call to
  // come back to; a survival.js from before that argument says «подъём», which
  // is swapped for ours rather than handed to the brain.
  // The way back is appended when the line does not name it: whereToFight's
  // cheapest-fight sentence ends on the fight, and a stop has to end on a call
  // that resumes the descent.
  const fightLine = (reach, seen, name) => {
    const s = survival()
    const line = typeof s.whereToFight === 'function'
      ? s.whereToFight([], reach, seen, name, again).replace('зови подъём снова', `зови ${again} снова`)
      : reach <= 1 || seen <= 1
        ? `${reach <= 1 ? 'тут шириной в клетку, ко мне пролезет только один' : 'он тут один'} — дерись прямо здесь: mc_fight target=${name}`
        : `до меня дотягиваются с ${reach} сторон — сначала отгороди фланги (mc_place), потом mc_fight target=${name}`
    return line.includes(again) ? line : `${line}; потом зови ${again}`
  }

  const look = () => {
    const { HOSTILES }: typeof import('../combat') = require('../combat')
    const { reachOf, sceneryOf }: typeof import('../reach') = require('../reach')
    const me = bot.entity.position
    // One block read per cell for the whole look, however many mobs share it.
    const cache = new Map()
    const near = (Object.values(bot.entities || {}) as any[])
      .filter((e : any) => e && e !== bot.entity && e.name && e.position && e.isValid !== false &&
        HOSTILES.has(e.name) && e.position.distanceTo(me) <= GUARD_RADIUS)
      .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
    let first = null
    let seen = 0
    for (const mob of (near as any)) {
      const r = reachOf(bot, mob, { cache })
      if (!r.reaches) { scenery.set(mob.id, sceneryOf(mob, r)); continue }
      scenery.delete(mob.id)
      if (passed.has(mob.id) && !dangerous(mob)) continue
      seen++
      if (!first) first = { mob, r }
    }
    return first ? { ...first, seen } : null
  }

  // Returns the stop sentence, or null to carry on.
  const answer = async ({ mob, r, seen }: any) => {
    const { openSides }: typeof import('../combat') = require('../combat')
    // standingCell, for guardFaces' reason: the wall's bearing is worked out
    // from this cell too, and a drifted floored() names the wrong column.
    const feet = standingCell(bot)
    const name = mob.name
    const at = xyz(mob.position)
    const rec: any = { who: name, dist: r.dist, at, where: r.where, how: r.how, seen, y: feet.y }
    if (r.steps !== null) rec.steps = r.steps
    // Bounded, because a mob that keeps stepping in and out of reach would
    // otherwise write one line per swing.
    if (met.length < 12) met.push(rec)
    const how = reachWords(r)

    if (r.how === 'сквозь стены') {
      rec.what = 'сквозь стены'
      const vex = name === 'vex'
      threat = { mob: name, where: r.where, dist: r.dist, at, how: r.how, seen, next: vex ? { call: 'mc_fight', target: name } : { call: 'mc_surface' } }
      return `${name} в ${r.dist} бл. ${r.where}, ${how} — стена от него не спасает, спуск бросаю: ` +
        (vex ? `убей его (mc_fight target=${name}), потом зови ${again}` : 'уходи от него наверх (mc_surface)')
    }

    let wall
    if (walls >= GUARD_WALLS || blocks >= GUARD_BLOCKS) {
      wall = { sealed: false, put: [], why: [`за этот вызов я уже поставил ${walls} стен(ы), ${blocks} бл., а до меня снова дотягиваются — дальше это пустой рюкзак`] }
    } else if (!pickFiller(bot)) {
      wall = { sealed: false, put: [], why: ['нечем: в сумке ни одного блока — булыжник, дипслейт, доски, любой сплошной'] }
    } else {
      wall = await guardWall(bot, mob)
    }
    const placed = wall.put.length
    if (placed) {
      rec.wall = wall.put.map(p => xyz(p.at))
      rec.placed = placed
      blocks += placed
      walls++
    }

    if (wall.sealed) {
      rec.what = placed ? 'заложился' : 'закрыт породой'
      // Behind us, over us, beside us: the descent walks away from that wall.
      // In the bearing of travel it is the first thing the next swing removes.
      const ahead = dir && wall.put.some(p => p.bearing && p.bearing[0] === dir[0] && p.bearing[1] === dir[1])
      if (!ahead) return null
      const perps = [[dir[1], dir[0]], [-dir[1], -dir[0]]]
      const lateral = (mob.position.x - (feet.x + 0.5)) * perps[0][0] + (mob.position.z - (feet.z + 0.5)) * perps[0][1]
      const side = lateral > 0 ? perps[1] : perps[0]
      // Ours to re-aim, or one level aside and then back into the caller's own
      // call: `then` is the same field mc_place→mc_fight uses below. A foreign
      // caller re-planning from the same square would pick the same bearing —
      // its plan is drawn from where the pile lies, not from our wall — so the
      // move that unblocks it has to be the step sideways, not the repeat.
      threat = {
        mob: name, where: r.where, dist: r.dist, at, how: r.how, seen, wall: rec.wall, placed, sealed: true,
        next: own
          ? { call: 'mc_dig_down', mode: 'stairs', direction: dirName(side) }
          : { call: 'mc_dig_down', mode: 'stairs', direction: dirName(side), depth: 1, then: again }
      }
      return `${name} в ${r.dist} бл. ${r.where}, ${how} — заложился прямо по ходу лесенки ` +
        `(${rec.wall.map(p => `${p.x},${p.y},${p.z}`).join(' и ')}), ${placed} бл.; следующая ступенька на ${dirName(dir)} ` +
        `вскроет эту стену первым же взмахом, так что туда не копаю: ` +
        (own
          ? `зови mc_dig_down mode=stairs direction=${dirName(side)}`
          : `сторону на этом спуске выбрал не я, и тем же вызовом я опять пойду на ${dirName(dir)} — ` +
            `сведи меня на ступеньку в сторону сам (mc_dig_down mode=stairs direction=${dirName(side)} depth=1), потом зови ${again}`)
    }

    const why = wall.why.length
      ? wall.why.join('; ')
      : wall.left && wall.left.how === 'дойдёт'
        ? `${placed} бл. встали, но он обойдёт их за ${wall.left.steps} шаг.`
        : `${placed} бл. встали, но линию ко мне не перекрыли`
    rec.why = why
    const danger = dangerous(mob)
    if (!danger) {
      rec.what = 'мимо'
      passed.add(mob.id)
      return null
    }
    rec.what = 'не закрылся'
    rec.danger = danger
    if (danger === BLIND) rec.dangerCheck = 'unavailable'
    // How many sides a walker can reach us from: combat's measured table is
    // indexed by this, not by head count. On a staircase it is 0 or 1 — the
    // step behind is a tread, not a side — which is the cheapest fight there is.
    const reach = openSides(bot, 2).length
    rec.reach = reach
    const lone = reach <= 1 || seen <= 1
    threat = {
      mob: name, where: r.where, dist: r.dist, at, how: r.how, seen, reach, wall: rec.wall, placed, sealed: false, danger,
      next: lone ? { call: 'mc_fight', target: name } : { call: 'mc_place', then: 'mc_fight', target: name }
    }
    if (r.steps !== null) threat.steps = r.steps
    if (danger === BLIND) threat.dangerCheck = 'unavailable'
    return `${name} в ${r.dist} бл. ${r.where}, ${how} — закрыться не вышло (${why}). ${fightLine(reach, seen, name)}`
  }

  return {
    async check () {
      if (!bot.entity) return null
      const g = look()
      return g ? answer(g) : null
    },
    report () {
      const live = [...scenery.entries()]
        .filter(([id]) => { const e = bot.entities && bot.entities[id]; return !!e && e.isValid !== false })
        .map(([, rec]) => rec)
        .sort((a, b) => a.dist - b.dist)
      return {
        met: met.length ? met : undefined,
        threat: threat || undefined,
        behindRock: live.length ? (live.length > 1 ? { ...live[0], seen: live.length } : live[0]) : undefined
      }
    }
  }
}

export { descentGuard }

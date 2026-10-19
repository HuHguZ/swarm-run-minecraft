'use strict'
// Бой (combat.ts): отход — укрытие от стрелка, стенка, шаг назад, отход в штреке и на открытом месте.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { sleep, xyz, standableY, travelXZ, inWater, escapeWater }: typeof import('../movement') = require('../movement')
const { raySees, eyePos }: typeof import('../perception') = require('../perception')
const { placeBlockAt, towerUp }: typeof import('../build') = require('../build')
const flee: typeof import('../flee') = require('../flee')
const { RANGED, CANNOT_BE_OUTPILLARED, DO_NOT_TRADE_WITH, countHostiles, threatPoint }: typeof import('./foes') = require('./foes')
const { headroomAt, openSides, corridorShape, openRun, sealCorridor, shieldFlanks, holdTheLine }: typeof import('./corridor') = require('./corridor')

// ---------------------------------------------------------------- retreat

// Standing spots around us from which the threat cannot see us. This is the
// whole idea behind retreating from an archer: cover, not distance.
function coverSpots (bot, threat, maxRadius = 20) {
  const from = bot.entity.position.floored()
  const myDist = bot.entity.position.distanceTo(threat)
  const out = []
  const DIRS = 16

  for (let r = 4; r <= maxRadius; r += 3) {
    for (let k = 0; k < DIRS; k++) {
      const a = (k / DIRS) * Math.PI * 2
      const x = Math.round(from.x + Math.cos(a) * r)
      const z = Math.round(from.z + Math.sin(a) * r)
      const y = standableY(bot, x, from.y, z)
      if (y === null) continue

      const stand = new Vec3(x + 0.5, y, z + 0.5)
      // Cover we have to run past the archer to reach is not cover.
      if (stand.distanceTo(threat) < myDist - 1) continue
      if (raySees(bot, new Vec3(x + 0.5, y + 1.62, z + 0.5), threat)) continue

      out.push({ x, y, z, travel: r, fromThreat: Math.round(stand.distanceTo(threat)) })
    }
  }

  // Nearest first: the value is entirely in getting behind something *now*.
  // Ties go to whatever ends up further from the shooter.
  out.sort((a, b) => a.travel - b.travel || b.fromThreat - a.fromThreat)
  return out
}

// Open ground with an archer on it: build the cover that is not there. One
// block at eye height in the line of fire is the entire trick.
async function raiseWall (session, ctl, threat) {
  const bot = session.bot
  const eye = eyePos(bot)
  const dir = threat.minus(eye)
  dir.y = 0
  if (dir.norm() < 0.01) return { ok: false, reason: 'цель прямо надо мной' }

  const step = dir.normalize()
  const feet = bot.entity.position.floored()
  const spots = []
  for (const d of [1, 2]) {
    const px = Math.round(feet.x + step.x * d)
    const pz = Math.round(feet.z + step.z * d)
    // Bottom-up, and it matters: on open ground the only thing to place
    // against is the floor, so the head-height block has nothing to attach to
    // until the one under it exists. Built head-first, only the foot blocks
    // landed and the arrows kept coming in at eye level.
    spots.push(new Vec3(px, feet.y, pz), new Vec3(px, feet.y + 1, pz))
  }

  let placed = 0
  for (const pos of spots) {
    if (ctl.aborted) break
    // Short leash: this is happening while something is hitting us, so a
    // square that does not take a block on the first try is not worth a second.
    const r = await placeBlockAt(bot, pos, { timeoutMs: 1200 })
    if (r.ok && !r.already) placed++
    // Stop as soon as the shot is actually blocked — every extra block is
    // another second of standing still being shot.
    if (!raySees(bot, eyePos(bot), threat)) return { ok: true, placed, covered: true }
  }
  return { ok: false, placed, covered: false }
}

// Walk directly away under manual control. Pathfinder will not plan a route
// for one second of movement, and here the direction matters far more than the
// route: the point is only to stop standing inside the mob's reach.
async function backOff (bot, threat, ms) {
  const away = bot.entity.position.minus(threat)
  away.y = 0
  if (away.norm() < 0.01) return
  const look = bot.entity.position.plus(away.normalize().scaled(6))
  try {
    await bot.lookAt(look.offset(0, 1.6, 0), true)
    bot.setControlState('forward', true)
    await sleep(ms)
  } catch {
  } finally {
    try { bot.setControlState('forward', false) } catch {}
  }
}

// Getting out of a fight alive inside a drift. Nothing from the open-ground
// playbook applies, and the two threats want opposite answers here — measured,
// run by run, in try-corridor:
//
//   archer  — the wall works perfectly. Run 3: skeleton ten blocks down the
//             drift, two blocks placed, zero damage, zero swings.
//   walker  — the wall only works if the square in front is free, which it is
//             not once contact is made, and walking the axis to break contact
//             does not work at all. Runs 5 and 6 walked away and were eaten
//             standing: 17 -> 3 and 14 -> 4 hp in the six seconds after. So
//             the answer to a walker is to hit it.
async function retreatInCorridor (session, ctl, shape, entity, deadline) {
  const bot = session.bot
  if (!shape.towardOpen && !shape.backOpen) {
    // Both ends of our own cell are stone: we are already inside a sealed
    // pocket, and whatever hit us cannot follow.
    return { mode: 'я в норе, ко мне не пройти', corridor: true, sealed: true, at: xyz(bot.entity.position) }
  }

  const ranged = !!(entity.name && RANGED.has(entity.name))

  if (!ranged && !DO_NOT_TRADE_WITH.has(entity.name)) {
    const held = await holdTheLine(session, ctl, shape, entity, deadline)
    if (held.held) {
      return {
        mode: held.sealed ? 'запечатал штрек' : (held.killed ? 'убил в штреке' : 'держу штрек — отсюда не отходят'),
        corridor: true,
        sealed: !!held.sealed,
        killed: held.killed,
        mobs: countHostiles(bot, 6),
        placed: held.placed,
        at: held.at || xyz(bot.entity.position),
        swings: held.swings
      }
    }
    // Nothing to hit with. Falling through to the axis walk is not a good
    // answer — it is the least bad one left.
  }

  const seal = await sealCorridor(session, ctl, shape)
  if (seal.ok) {
    return { mode: 'запечатал штрек', corridor: true, sealed: true, placed: seal.placed, at: seal.at }
  }

  const feet = bot.entity.position.floored()
  const run = openRun(bot, feet, shape.back, shape.headroom, 12)
  if (run < 2) {
    return {
      mode: 'тупик: запечатать нечем, отходить некуда',
      corridor: true,
      sealed: false,
      why: seal.why,
      at: xyz(feet)
    }
  }
  const to = feet.offset(shape.back.dx * run, 0, shape.back.dz * run)
  const r = await travelXZ(bot, ctl, to.x, to.z, { range: 1, retries: 0, deadline })
  return {
    mode: `отошёл по штреку на ${run}`,
    corridor: true,
    sealed: false,
    why: seal.why,
    at: xyz(bot.entity.position),
    ok: r.ok,
    error: r.ok ? undefined : r.error
  }
}

// Get out of a fight alive. Ranged threats get cover; melee threats get
// distance, which is all they understand.
async function retreat (session, ctl, entity, { maxRadius = 20, timeoutMs = 15000 }: any = {}) {
  const bot = session.bot
  try { bot.pathfinder.setGoal(null) } catch {}

  // Nothing below works while swimming: pathfinder cannot get out of water on
  // its own, and open water has no solid neighbour to build a wall against.
  // Observed in game — the bot took twenty arrows treading water.
  if (inWater(bot)) await escapeWater(bot, ctl, { timeoutMs: 8000 })

  const threat = threatPoint(entity)
  if (!threat) return { mode: 'цель пропала' }
  const ranged = !!(entity.name && RANGED.has(entity.name))
  const deadline = gameClock.now() + timeoutMs
  let towerTrouble = null

  // Shape before doctrine. Inside a drift this is the answer for archers too:
  // a filled cell stops arrows exactly as well as it stops feet, and it is
  // found by reading four blocks instead of walking a cover search that cannot
  // succeed in a corridor with no way around anything.
  const shape = corridorShape(bot, threat)
  if (shape.corridor) return retreatInCorridor(session, ctl, shape, entity, deadline)

  // Открытое место, и врагов больше одного или это крипер: «прочь от этого»
  // ведёт в другого, а стоять и строить рядом с крипером — это взрыв. Тут
  // бежим с оглядкой на всех (flee.js); прижали — дальше старая доктрина.
  const crowd = countHostiles(bot, 14)
  if (headroomAt(bot, 6) > 6 && (crowd >= 2 || DO_NOT_TRADE_WITH.has(entity.name))) {
    const ran = await flee.smartFlee(session, ctl, { timeoutMs: Math.max(3000, deadline - gameClock.now()) })
    if (!ran.cornered) return { ...ran, mode: `убежал с оглядкой: ${ran.mode}` }
  }

  // An open cave is not open ground. Everything the branch below does needs
  // sky, terrain or distance, and a cave has none of the three:
  //
  //   * the pillar needs feet+2 free to place a block and feet+3 for the one
  //     after it, and retreat only counts a pillar at two blocks or more --
  //     so a cave roof at three blocks lets exactly one block go up and the
  //     branch is guaranteed to fall through to the run;
  //   * cover means walking through rock;
  //   * running from a walker is the death this project has measured twice.
  //
  // Measured at y=-31: the bot took fourteen hits in full iron and died with
  // the intent still inside this function. Fourteen hits at about one a second
  // is fourteen seconds of not swinging, and backOff (0.9s) plus a pillar that
  // cannot go up (~5s) plus a run the pathfinder has to dig its way through
  // (~8s of stuck guard) is exactly that budget. It never swung once.
  //
  // What a cave does have is stone on most sides. Close the rest and fight:
  // one contact costs about 2 hp, two about 7, three about 14, four is death,
  // so the number worth spending blocks on is the contact count and not the
  // mob count.
  const roof = headroomAt(bot, 6)
  if (!ranged && roof <= 6 && !DO_NOT_TRADE_WITH.has(entity.name)) {
    const mobs = countHostiles(bot, 6)
    // One walker reaches us from one side whatever the room looks like, and
    // the sword wins that trade outright. Blocks are worth spending from two.
    const shield = mobs >= 2 ? await shieldFlanks(session, ctl, threat, { deadline }) : null
    const sides = openSides(bot, 2).length
    // Three things in contact costs about 14 hp to fight through and four
    // kills. If the sides could not be closed and there are that many, the
    // pillar below is worth its five seconds after all -- but only where it
    // can actually go up: it needs feet+2 free to place a block and feet+3 for
    // the second, and retreat only counts two as a pillar. Under a roof of
    // three it can place exactly one, which is how the old branch used to end
    // up running instead.
    const pillarPossible = roof >= 4
    if (!(mobs >= 3 && sides >= 3 && pillarPossible)) {
    // Shielding can turn the spot into a genuine drift, and then the seal is
    // available for free between swings.
      const walled = corridorShape(bot, threat)
      const held = await holdTheLine(session, ctl, walled.corridor ? walled : null, entity, deadline)
      if (held.held) {
        return {
          mode: held.sealed ? 'запечатался в пещере' : (held.killed ? 'убил в пещере' : 'держу место в пещере'),
          cave: true,
          roof,
          mobs,
          sides: openSides(bot, 2).length,
          shielded: shield ? shield.placed : 0,
          sealed: !!held.sealed,
          killed: held.killed,
          swings: held.swings,
          at: xyz(bot.entity.position)
        }
      }
    }
    // Either nothing to hit with, or too many sides open and a roof high
    // enough to climb out of reach. The old branch owns both cases.
  }

  if (ranged) {
    // Wall first, cover second. This order was learned by dying: hunting for
    // natural cover means walking under fire for as long as the search takes,
    // and the bot went 20 hp to 0 three times doing that on open ground. Two
    // blocks dropped in the line of fire take under a second and end the
    // shooting immediately.
    const tried = []
    const wall = await raiseWall(session, ctl, threat)
    if (wall.ok) return { mode: 'заложился блоком', at: xyz(bot.entity.position), placed: wall.placed }

    for (const spot of coverSpots(bot, threat, maxRadius).slice(0, 3)) {
      if (ctl.aborted || gameClock.now() >= deadline) break
      // One bad candidate must not eat the whole budget.
      const leg = Math.min(deadline, gameClock.now() + 5000)
      const r = await travelXZ(bot, ctl, spot.x, spot.z, { range: 1, retries: 0, deadline: leg })
      tried.push(`${spot.x},${spot.z}${r.ok ? '' : ' ✗'}`)
      if (!r.ok) continue
      if (!raySees(bot, eyePos(bot), threat)) {
        return { mode: 'ушёл за укрытие', at: xyz(bot.entity.position), tried }
      }
    }
    // Fall through: distance is worse than cover but better than standing here.
  } else if (!CANNOT_BE_OUTPILLARED.has(entity.name)) {
    // Measured in game: a zombie walks faster than this bot, because sprinting
    // is off to keep the physics in sync with the server. Walking away is a
    // slower death — 20 hp to 0, twice. Up is the answer, but a bare pillar
    // fails too: every hit knocks the body off the one block it just placed.
    // So block the contact first, then climb in the gap that buys.
    // A melee mob that is already on us is standing in the exact square the
    // wall needs, and a placement into an entity is refused every time. One
    // second of walking away buys the block of separation that makes the wall
    // possible at all.
    await backOff(bot, threat, 900)

    // The shape has to be re-read where the body ended up, not where it
    // decided to move from: backOff walks about four blocks, and four blocks
    // is enough to leave the room it started in. Run 7 is why — the bot backed
    // out of an open cave towards its own drift and then spent nine seconds
    // there on the open-ground answers, building a wall into an occupied
    // square and a pillar into a ceiling, 17 hp down to 1. In a drift the
    // measured answer is the sword, and it is one blockAt sweep away.
    const nowShape = corridorShape(bot, threat)
    if (nowShape.corridor) return retreatInCorridor(session, ctl, nowShape, entity, deadline)

    const wall = await raiseWall(session, ctl, threat)
    // The instant contact is broken, stop and hand control back. The version
    // that kept climbing "to be safe" after the wall was already up spent ten
    // more seconds standing in melee range, and that is what killed the bot.
    if (wall.ok) return { mode: 'заложился блоком', placed: wall.placed, at: xyz(bot.entity.position) }

    let placed = 0
    const why = []
    for (let attempt = 0; attempt < 3 && placed < 3 && !ctl.aborted; attempt++) {
      const up = await towerUp(bot, ctl, 3 - placed)
      placed += up.placed
      if (up.why) why.push(...up.why)
      if (!up.placed && attempt > 0) break
    }
    if (placed >= 2) {
      return { mode: 'встал на столб', placed, at: xyz(bot.entity.position) }
    }
    if (why.length) towerTrouble = why.slice(0, 6)
  }

  // Последний довод — бег. Не по прямой «прочь от этого» пешком, а спринтом и
  // с оглядкой на всех, кто рядом (flee.js).
  const ran = await flee.smartFlee(session, ctl, { timeoutMs: Math.max(3000, deadline - gameClock.now()) })
  return {
    ...ran,
    mode: ranged ? `укрытия не нашёл — ${ran.mode}` : `столб не вышел — ${ran.mode}`,
    towerTrouble: towerTrouble || undefined
  }
}

export {
  coverSpots, raiseWall, backOff, retreatInCorridor, retreat
}

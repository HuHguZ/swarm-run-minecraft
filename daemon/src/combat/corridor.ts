'use strict'
// Бой (combat.ts): форма штрека — стены, проходы, перекрыть штрек, закрыть бока, стоять в проходе.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { sleep, xyz }: typeof import('../movement') = require('../movement')
const { bestWeapon }: typeof import('../items') = require('../items')
const { placeBlockAt, occupiedByEntity, pickFiller }: typeof import('../build') = require('../build')

// ----------------------------------------------------------- corridor shape

// A mine drift — one block wide, two high — is not the worst ground to be
// caught on, it is the best: one filled cell is a wall the mob cannot walk
// around, and only one mob can ever be in contact. But every move the
// open-ground retreat makes is wrong here. The pillar hits the ceiling at
// feet+2, the cover search walks past the mob because there is no way past it,
// and "away from the threat" as a vector points into the side wall as soon as
// the body drifts half a block off the axis. So the shape has to be recognised
// before the doctrine is picked.
//
// Block reads only — about fifteen blockAt() calls, no raycasts — because this
// runs inside the swing loop.

function solidAt (bot, p) {
  const b = bot.blockAt(p)
  return !!b && b.boundingBox === 'block'
}

function openAt (bot, p) {
  const b = bot.blockAt(p)
  // An unloaded block is not "open". Reading null as walkable is how a retreat
  // ends up walking into a wall it never actually looked at.
  return !!b && b.boundingBox === 'empty' && !/lava/.test(b.name)
}

const AXES = [{ name: 'x', dx: 1, dz: 0 }, { name: 'z', dx: 0, dz: 1 }]

// mc_tunnel digs two high by default and three on request, so the ceiling is
// looked for at either height; anything taller is a room, not a drift.
// Open cells counted from the feet up; the ceiling is the block at
// feet+headroom. Capped, because the question is always "is there a ceiling
// within N", never how far away the sky is.
function headroomAt (bot, max = 3) {
  const feet = bot.entity.position.floored()
  let n = 0
  for (let h = 0; h <= max; h++) {
    if (!openAt(bot, feet.offset(0, h, 0))) break
    n = h + 1
  }
  return n
}

const DIRS4 = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }]

// The orthogonal cells a walking mob could stand in to reach us. This is the
// number that decides everything underground: two of them is a drift, three is
// a wall at our back, four is open ground. Measured cost of standing and
// fighting, iron sword against zombies in full iron armour: one contact costs
// about 2 hp, two about 7, three about 14, four kills. So the thing worth
// spending blocks on is not the mob count, it is the contact count.
function openSides (bot, levels = 2) {
  const feet = bot.entity.position.floored()
  const out = []
  for (const d of DIRS4) {
    let ok = true
    for (let h = 0; h < levels && ok; h++) ok = openAt(bot, feet.offset(d.dx, h, d.dz))
    if (ok) out.push(d)
  }
  return out
}

// The one of the four directions a point mostly lies in.
function dominantStep (dx, dz) {
  return Math.abs(dx) >= Math.abs(dz)
    ? { dx: dx >= 0 ? 1 : -1, dz: 0 }
    : { dx: 0, dz: dz >= 0 ? 1 : -1 }
}

// A wall a walker cannot climb is two blocks, because it can step up one. In a
// drift the ceiling does the second block for us, so filling everything but
// the last cell under the roof is enough and is one placement faster.
function walkerLevels (shape) {
  return Math.max(1, Math.min(2, shape.headroom - 1))
}

function corridorShape (bot, threat) {
  if (!bot || !bot.entity || !threat) return { corridor: false, why: 'нечего мерить' }
  const feet = bot.entity.position.floored()

  const headroom = headroomAt(bot, 3)
  if (headroom < 2) return { corridor: false, why: 'встать негде' }
  if (headroom > 3) return { corridor: false, why: 'потолка нет — это не штрек' }

  const walled = []
  for (const a of AXES) {
    // The pair of walls across the axis: what the mob would have to walk
    // around, and what a placed block leans against.
    const sx = a.dz
    const sz = a.dx
    let ok = true
    for (let h = 0; h < headroom && ok; h++) {
      ok = solidAt(bot, feet.offset(sx, h, sz)) && solidAt(bot, feet.offset(-sx, h, -sz))
    }
    if (!ok) continue
    const delta = a.name === 'x' ? threat.x - (feet.x + 0.5) : threat.z - (feet.z + 0.5)
    walled.push({ a, delta })
  }
  if (!walled.length) return { corridor: false, why: 'стен с обеих сторон нет' }

  // Both axes walled means a 1x1 pocket rather than a drift. Pick the axis the
  // threat actually lies along, so "toward" keeps meaning something.
  walled.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta))
  const pick = walled[0]
  const sign = pick.delta >= 0 ? 1 : -1
  const step = { dx: pick.a.dx * sign, dz: pick.a.dz * sign }
  const back = { dx: -step.dx, dz: -step.dz }
  const open = (d) => {
    for (let h = 0; h < headroom; h++) if (!openAt(bot, feet.offset(d.dx, h, d.dz))) return false
    return true
  }
  return {
    corridor: true,
    axis: pick.a.name,
    headroom,
    step,
    back,
    towardOpen: open(step),
    backOpen: open(back)
  }
}

// How many cells of drift are actually open this way. Cheaper and far more
// honest than handing pathfinder a coordinate ten blocks inside bedrock and
// waiting for the stuck guard to say so eight seconds later.
function openRun (bot, from, dir, headroom, max = 12) {
  let n = 0
  for (let d = 1; d <= max; d++) {
    let ok = true
    for (let h = 0; h < headroom && ok; h++) ok = openAt(bot, from.offset(dir.dx * d, h, dir.dz * d))
    if (!ok) break
    n = d
  }
  return n
}

// Contact distance below which a melee mob is not worth trying to wall out.
// Run 1 of try-corridor is the whole argument: the bot met the zombie head-on,
// the square in front of it was occupied from that moment on, and the two
// attempts to buy it back by stepping away cost 19 hp and did not place a
// single block out of 64. A mob walks about a block every quarter second and a
// placement that lands is one server round trip, so five blocks is roughly two
// placements of margin — and if the attempt fails anyway it now costs one
// placement window instead of the fight.
const SEAL_GAP = 5

// Fill the cell of drift between us and the mob. One attempt, no walking: the
// square is either free right now or it is not, and every step taken to make
// it free is a free hit for something that moves faster than we do.
//
// Height depends on what is coming. An archer needs the full column, because
// it shoots over a knee-high wall — run 3 measured that: skeleton at ten
// blocks, two blocks placed, zero damage taken. A walker needs only the floor
// block: nothing that walks can enter a one-block-high gap, and from the next
// cell out it is two blocks away, past a zombie's reach. The floor block also
// goes down in half the time, which is the half that decides the race.
async function sealCorridor (session, ctl, shape, { levels = 0 }: any = {}) {
  const bot = session.bot
  const why = []
  let placed = 0

  // Asked first. An empty backpack does not get better on a second look, and
  // finding that out costs a second of standing in reach.
  if (!pickFiller(bot)) return { ok: false, placed: 0, why: ['нечем строить'] }

  const feet = bot.entity.position.floored()
  const cell = feet.offset(shape.step.dx, 0, shape.step.dz)
  const height = Math.min(shape.headroom, levels > 0 ? levels : shape.headroom)
  const column = []
  for (let h = 0; h < height; h++) column.push(cell.offset(0, h, 0))

  const squatter = column.map(p => occupiedByEntity(bot, p)).find(Boolean)
  // The server refuses every placement into a living entity, and each refusal
  // costs a full placement timeout. Say so and let the caller swing instead.
  if (squatter) return { ok: false, placed: 0, why: [`в клетке ${squatter}`] }

  for (const pos of column) {
    if (ctl && ctl.aborted) break
    // Short leash: this happens while something is hitting us, so a square
    // that does not take a block on the first try is not worth a second.
    const r = await placeBlockAt(bot, pos, { timeoutMs: 1200 })
    if (r.ok) { if (!r.already) placed++ } else if (!why.includes(r.reason)) why.push(r.reason)
  }

  // Verified by reading blocks, not by a raycast. In a drift the question is
  // literally "is the tunnel full", and blockAt answers exactly that.
  if (column.every(p => solidAt(bot, p))) {
    return { ok: true, placed, at: xyz(cell), height, why: why.length ? why.slice(0, 4) : undefined }
  }
  return { ok: false, placed, why: why.slice(0, 4) }
}

// Underground the bot is standing in stone with holes in it, and the holes are
// the whole problem: each open side is one more mob that can be in contact at
// the same time, and contact count is what decides the fight. Closing a side
// is two blocks and it never has to win a race, because a mob can only be
// standing in one of them at a time. The side the threat is on stays open on
// purpose: that is the one we mean to fight through, and walling it is the
// seal, not the shield.
async function shieldFlanks (session, ctl, threat, { budget = 6, deadline = 0 }: any = {}) {
  const bot = session.bot
  const before = openSides(bot, 2).length
  if (!pickFiller(bot)) return { placed: 0, before, after: before, why: 'нечем строить' }

  const feet = bot.entity.position.floored()
  const me = bot.entity.position
  const toward = dominantStep(threat.x - me.x, threat.z - me.z)
  let placed = 0

  for (const d of openSides(bot, 2)) {
    if ((ctl && ctl.aborted) || placed >= budget) break
    if (deadline && gameClock.now() >= deadline) break
    if (d.dx === toward.dx && d.dz === toward.dz) continue
    const cell = feet.offset(d.dx, 0, d.dz)
    // A refused placement into a mob costs a full timeout; skip the side it is
    // standing in and take the ones that are actually free.
    if (occupiedByEntity(bot, cell) || occupiedByEntity(bot, cell.offset(0, 1, 0))) continue
    for (let h = 0; h < 2; h++) {
      const r = await placeBlockAt(bot, cell.offset(0, h, 0), { timeoutMs: 1200 })
      if (r.ok && !r.already) placed++
    }
  }
  return { placed, before, after: openSides(bot, 2).length }
}

// Swing, and take the wall the moment it is offered. This is the melee answer
// in a drift and it is measured, not reasoned: runs 2 and 4 killed the zombie
// for 2 and 9 hp with the same iron sword, while every run that tried to break
// contact — 1, 5 and 6 — ended between 1 and 4 hp with the mob still on the
// bot. In a 1x2 drift only one thing can reach us and it can only come head
// on, so standing still and hitting it is the cheapest exit there is.
//
// The seal is not abandoned, it is just never paid for with movement: the
// square in front is checked between swings, and the instant the mob is far
// enough off it the block goes down and the fight is over for free.
async function holdTheLine (session, ctl, shape, entity, deadline) {
  const bot = session.bot
  const weapon = bestWeapon(bot)
  // Bare fists do about one damage against twenty points of zombie. That is
  // not a fight, it is a slower version of standing still, so the caller has
  // to be told to do something else.
  if (!weapon) return { held: false, why: 'бить нечем' }
  try { await bot.equip(weapon, 'hand') } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}

  let swings = 0
  let lastSeal = 0
  while (!(ctl && ctl.aborted) && gameClock.now() < deadline) {
    if (!entity.isValid) return { held: true, killed: entity.username || entity.name, swings }
    const dist = entity.position.distanceTo(bot.entity.position)

    // Only a drift can be sealed: filling one cell of a cave just gives the
    // mob a step to walk around.
    if (shape && dist >= SEAL_GAP && gameClock.now() - lastSeal > 3000) {
      lastSeal = gameClock.now()
      const seal = await sealCorridor(session, ctl, shape, { levels: walkerLevels(shape) })
      if (seal.ok) {
        // The floor block already denies entry; the rest of the column is a
        // bonus taken only because there is time for it right now.
        const top = await sealCorridor(session, ctl, shape)
        return { held: true, sealed: true, placed: seal.placed + (top.ok ? top.placed : 0), at: seal.at, swings }
      }
      continue
    }

    if (dist <= 3.2) {
      try {
        await bot.lookAt(entity.position.offset(0, (entity.height || 1.8) * 0.85, 0), true)
        bot.attack(entity)
        swings++
      } catch {}
    }
    // Sword cooldown is 0.625s; swinging faster just wastes damage.
    await sleep(650)
  }
  return { held: true, swings, timeout: true }
}

export {
  solidAt, openAt, AXES, headroomAt, DIRS4, openSides, dominantStep, walkerLevels, corridorShape, openRun, SEAL_GAP, sealCorridor, shieldFlanks, holdTheLine
}

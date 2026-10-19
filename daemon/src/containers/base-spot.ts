'use strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

const LAVA = /lava/
const WATER = /^(water|bubble_column|kelp|seagrass|tall_seagrass)$/
// Ground that pours. A chest under gravel gets buried by the first block broken
// above it, and a staircase dug through sand refills itself.
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$|_concrete_powder$/
const HARD = /^(stone|deepslate|andesite|diorite|granite|tuff|calcite|basalt|blackstone|cobblestone|cobbled_deepslate|obsidian|netherrack|end_stone|bricks|stone_bricks)$|_planks$/

const CARDINALS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// Two chests sharing a side merge into one double chest. Then two remembered
// coordinates open the same 54-slot window and the cache counts everything
// twice. Diagonals never merge — neither with each other nor with a cardinal.
const DIAGONALS = [[1, 1], [-1, -1], [1, -1], [-1, 1]]

// ---------------------------------------------------------------- choosing

function stands (bot, p) {
  const ground = bot.blockAt(p.offset(0, -1, 0))
  const feet = bot.blockAt(p)
  const head = bot.blockAt(p.offset(0, 1, 0))
  if (!ground || !feet || !head) return false
  if (ground.boundingBox !== 'block') return false
  if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') return false
  if (WATER.test(feet.name) || WATER.test(head.name)) return false
  if (LAVA.test(feet.name) || LAVA.test(head.name)) return false
  return true
}

// Top-down, so a column answers with its surface rather than with the first
// cave it happens to contain.
function surfaceAt (bot, x, z, aroundY, span = 6) {
  for (let dy = span; dy >= -span; dy--) {
    const p = new Vec3(x, aroundY + dy, z)
    if (stands(bot, p)) return p
  }
  return null
}

// The geometric question, not the light one: mc_surface learned the hard way
// that skyLight over the bottom of our own shaft reads as honest daylight.
function openSky (bot, p, upTo = 40) {
  for (let dy = 1; dy <= upTo; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (!b) return null // unloaded: we do not know, and guessing is worse
    if (b.boundingBox !== 'empty') return false
  }
  return true
}

// Offsets of a cube of side 2r+1, ordered by Chebyshev distance from the
// centre. Precomputed once because the ORDER is the whole optimisation: both
// callers really ask "is there any of this within r", and shell order lets a
// column standing IN a lava lake answer after twenty-seven lookups instead of
// grinding all 729. That is what makes it affordable to keep looking past the
// rejected columns instead of giving up after the nearest handful.
function shell (radius) {
  const out = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        out.push([dx, dy, dz, Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))])
      }
    }
  }
  return out.sort((a, b) => a[3] - b[3])
}
const LAVA_SHELL = shell(4)
const WATER_SHELL = shell(3)

// First hit in shell order IS the nearest, so this returns the same number the
// old triple loop did — it just stops as soon as it has it.
function nearest (bot, p, re, offsets) {
  for (const [dx, dy, dz, d] of offsets) {
    const b = bot.blockAt(p.offset(dx, dy, dz))
    if (b && re.test(b.name)) return d
  }
  return null
}

function spotWhy (c) {
  return [
    c.sky === true ? 'открытое небо' : c.sky === false ? 'под потолком' : 'небо не проверить',
    `ровно ${c.flat} из 8`,
    `земля ${c.ground}`,
    c.water === null ? 'воды в 3 нет' : `вода в ${c.water}`,
    'лавы в 4 нет'
  ].join(', ')
}

// Why these rules and not prettier ones. The base exists to be the place the
// bot comes back to from underground, so what it must have is: a floor that
// does not pour (a chest under gravel gets buried), no lava within four (the
// mine entrance is dug right here, and the descent already turned twice to get
// round lava at y=-56), three-by-three of standing room — two chests on the
// diagonals, a furnace and a table on the cardinals, a body in the middle —
// and open sky, because that is where mc_surface breaks out and the only thing
// that makes the spot findable at night. Underground is allowed and merely
// scores worse: at y=-50 a forward base beats no base at all.
// How many acceptable spots we look at before settling, and the hard ceiling on
// examinations. `slice(0, 32)` used to do both jobs at once and did the second
// one badly: sorted by distance, thirty-two columns is a circle of radius 3.2,
// so a lava pool four blocks east made `radius: 10` answer "негде" while good
// ground stood at six. Rejections are cheap to keep looking past; it is the
// ACCEPTED ones that have to be capped, because score already pays -1.5 a block
// and the thirteenth candidate can never win.
const SPOTS_ENOUGH = 12
const SPOTS_LOOKED = 300

function pickBaseSpot (bot, { radius = 10 }: any = {}) {
  const me = bot.entity.position.floored()
  // Honest names: a column with no answer is usually a lava well or a wall,
  // not an unloaded chunk, and calling it "непрогружено" would send the brain
  // off to wait for chunks that are already here.
  const saw = { колонок: 0, сыпучая: 0, нетпола: 0, тесно: 0, лава: 0, вода: 0, годных: 0, проверено: 0 }
  const columns = []

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const p = surfaceAt(bot, me.x + dx, me.z + dz, me.y, 6)
      if (!p) { saw.нетпола++; continue }
      const ground = bot.blockAt(p.offset(0, -1, 0))
      if (GRAVITY.test(ground.name)) { saw.сыпучая++; continue }
      saw.колонок++
      columns.push({ p, ground: ground.name, dist: Math.hypot(dx, dz) })
    }
  }
  columns.sort((a, b) => a.dist - b.dist)

  let best = null
  // The expensive tests (a lava sphere is 729 lookups) only run on the nearest
  // handful: walking further for a marginally better spot is a bad trade. An
  // ACCEPTED candidate costs ~1120 blockAt (729 of them the lava sphere), so
  // the open-field case stops at twelve — 13k lookups, a quarter of what the
  // flat cap of 32 spent. A REJECTED one is cheap now that nearest() stops on
  // its first hit, which is why the ceiling can afford to be 300: a nine-by-nine
  // lava lake underfoot rejects ~250 columns and still finds ground at nine.
  for (const c of columns) {
    if (saw.годных >= SPOTS_ENOUGH || saw.проверено >= SPOTS_LOOKED) break
    saw.проверено++
    const flat = CARDINALS4.concat(DIAGONALS).filter(([dx, dz]) => stands(bot, c.p.offset(dx, 0, dz))).length
    const slots = DIAGONALS.filter(([dx, dz]) => stands(bot, c.p.offset(dx, 0, dz))).length
    if (flat < 5 || slots < 2) { saw.тесно++; continue }
    if (nearest(bot, c.p, LAVA, LAVA_SHELL) !== null) { saw.лава++; continue }
    saw.годных++
    const water = nearest(bot, c.p, WATER, WATER_SHELL)
    if (water !== null) saw.вода++
    const sky = openSky(bot, c.p, 40)

    let score = flat * 4
    if (sky === true) score += 30
    if (HARD.test(c.ground)) score += 8
    if (c.p.y >= 63) score += 6
    if (water !== null) score -= 12
    score -= Math.round(c.dist * 1.5)

    const cand = { pos: c.p, ground: c.ground, dist: Math.round(c.dist * 10) / 10, flat, slots, sky, water, score }
    if (!best || cand.score > best.score) best = cand
  }
  if (best) best.why = spotWhy(best)
  // The radius comes back out because baseSet clamps it before calling and the
  // refusal quotes a number: saying "в 40 блоках негде" after looking in 24 is
  // the kind of lie that sends the brain walking for nothing.
  return { best, saw, radius }
}

// ---------------------------------------------------------------- shelves

function containerNextTo (bot, pos) {
  for (const [dx, dz] of CARDINALS4) {
    const b = bot.blockAt(pos.offset(dx, 0, dz))
    if (b && /^(chest|trapped_chest)$/.test(b.name)) return b
  }
  return null
}

// A torch has boundingBox 'empty' and is not replaceable: baseSet plants one on
// a cardinal of the centre immediately before growStash runs, so "empty" alone
// would offer that exact square as a shelf spot and spend a placement timeout
// failing on it. Only the cells a player could build straight into count.
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|dead_bush|snow)$/

// Where a new shelf may go. Diagonals first (they cannot merge into a double
// chest), then cardinals, and never the square the body stands on
// (placeBlockAt refuses it — build.js isOurOwnSpace).
function chestSpots (bot, centre) {
  const out = []
  for (const [dx, dz] of DIAGONALS.concat(CARDINALS4)) {
    const p = centre.offset(dx, 0, dz)
    const here = bot.blockAt(p)
    const under = bot.blockAt(p.offset(0, -1, 0))
    const over = bot.blockAt(p.offset(0, 1, 0))
    if (!here || !under || !over) continue
    if (!REPLACEABLE.test(here.name)) continue
    if (under.boundingBox !== 'block') continue
    // A chest with an opaque block on top does not open — vanilla rule, and
    // from the outside it looks exactly like the 1.21.11 activation bug.
    if (over.boundingBox !== 'empty') continue
    if (containerNextTo(bot, p)) continue
    out.push(p)
  }
  return out
}

export { CARDINALS4, surfaceAt, openSky, pickBaseSpot, chestSpots }

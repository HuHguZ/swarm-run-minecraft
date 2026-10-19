'use strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

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

// Тело «в клетке» c: та же колонка, ноги в c.y — или на низком полу клетки ниже (грязь, песок душ — 0.875, грядка и
// тропа — 0.9375): там ноги на c.y − 0.125, и position.floored() даёт клетку пола. Портал на грязи (мангры, слот 23
// 02.10) и порог на песке душ: «до порога не дошёл ни с одной стороны», хотя тело стояло на пороге.
function sameCell (pos, c) {
  if (Math.floor(pos.x) !== c.x || Math.floor(pos.z) !== c.z) return false
  const fy = Math.floor(pos.y)
  return fy === c.y || (fy === c.y - 1 && pos.y - fy >= 0.8)
}

export {
  INNER_W, INNER_H, FRAME_MIN, FRAME_BLOCK, PORTAL_EMPTY, IGNITERS, FLINT_PER_GRAVEL, OBSIDIAN_TOOLS,
  OBSIDIAN_SECONDS, AXES, UP, at, innerCells, frameCells, cornerCells, propFor, isSolid, isFluid, isPortalEmpty,
  PROTECTED, reader, neighbours, PLACE_RADIUS, MAX_DIG, LAVA_KEEP, WATER_KEEP, REACH, eyes, eyesAt, centre,
  chebyshev, sameCell
}

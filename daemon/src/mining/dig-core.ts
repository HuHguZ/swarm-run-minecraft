'use strict'
import * as gameClock from '../game-clock'
import { sleep } from '../movement'
import { equipBestTool, missingHarvestTool } from '../items'
import { withTimeout, FILLER, occupiedByEntity } from '../build'

// Same mapping as COMPASS in actions.js: north is -z.
const DIRS: any = {
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
      if (gameClock.now() >= deadline) return { dug, stopped: `время вышло в забое на ${at(pos)}` }
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
  const until = gameClock.now() + ms
  try {
    await bot.lookAt(centre.offset(0, 1.6, 0), true)
    bot.setControlState('forward', true)
    while (gameClock.now() < until && !ctl.aborted) {
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
  const until = gameClock.now() + budgetMs
  const tried = new Set(abandoned)
  while (gameClock.now() < until && !ctl.aborted) {
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

export {
  DIRS, MAX_LENGTH, MOB_RADIUS, MOB_RADIUS_HURT, ERRAND_LOOK, LOW_HEALTH, SEAL_MS, at, flatDist, isLava, isWater,
  clamp, resolveDirection, danger, firstSolidAhead, fillerCount, columnSolid, walkableCell, digColumn, walkTo,
  axisLine, axisSign, sweepDrops, quickBreak
}

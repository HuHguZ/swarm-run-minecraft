'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

const EYE = 1.62
// От глаз до центра клетки. Сервер пускает клик до block_interaction_range
// (4.5) + 1 до ближайшей точки КЛИКНУТОГО блока (handleUseItemOn), клик идёт в
// соседа клетки, так что 4.5 до центра самой клетки — с запасом.
const REACH = 4.5
const AIR = new Set(['air', 'cave_air', 'void_air'])
const FLUID = /^(water|lava|bubble_column)$/
// Блоки, клик по которым что-то открывает или переключает: ставить на них можно
// только присев (ServerPlayerGameMode.useItemOn пропускает use блока, если
// isSecondaryUseActive и в руке предмет).
const INTERACTIVE = /chest|barrel|furnace|smoker|crafting_table|_door$|trapdoor|fence_gate|_bed$|_sign$|button|lever|anvil|enchanting_table|shulker_box|hopper|dispenser|dropper|beacon|brewing_stand|jukebox|note_block|loom|grindstone|stonecutter|cartography_table|smithing_table|lectern|bell|repeater|comparator|daylight_detector|cake|composter|respawn_anchor|decorated_pot|crafter|chiseled_bookshelf|flower_pot|campfire/
// За это не держится ни факел, ни табличка: грань не «крепкая».
const FLIMSY = /pane|fence|_wall$|iron_bars|chain|_slab$|_stairs$|glass_pane|ladder|_sign|torch|lantern|_door$|trapdoor|_bed$|chest/
// Мир, который трогать нельзя: сделанное руками. Автовыбор места обходит его.
const MADE = /_planks$|_stairs$|_slab$|_door$|_bed$|chest|barrel|furnace|crafting_table|torch|lantern|glass|_bricks$|^bricks$|_fence|_wall$|_sign$|ladder|_wool$|_carpet$|bookshelf|_log$/
// mineflayer: yaw 0 — север, растёт против часовой (conversions.js toNotchianYaw = 180° − yaw).
const YAW = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }
const V = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0),
  up: new Vec3(0, 1, 0),
  down: new Vec3(0, -1, 0)
}
const HORIZ = ['north', 'east', 'south', 'west']
const JOB = 'build'

const sleep = ms => new Promise<any>(resolve => gameClock.setTimeout(resolve, ms))
const k3 = p => `${p.x},${p.y},${p.z}`

// ---------------------------------------------------------------- world bits

const isSolid = b => !!b && b.boundingBox === 'block' && !FLUID.test(b.name)
const isPassable = b => !!b && b.boundingBox === 'empty' && !FLUID.test(b.name)
const sturdy = b => isSolid(b) && !FLIMSY.test(b.name)
// Табличку держит то, что isSolid() в игре (WallSignBlock и StandingSignBlock
// canSurvive): сундук годится, хотя факел на нём не висит.
const holds = (c, b) => /_sign$/.test(c.name || '')
  ? isSolid(b) && !/pane|fence|iron_bars|chain|_wall$/.test(b.name)
  : sturdy(b)

function propsOf (block) {
  try { return block.getProperties() || {} } catch { return {} }
}

function propsMatch (block, want) {
  if (!want) return true
  const got = propsOf(block)
  for (const [k, v] of (Object.entries(want) as [string, any][])) {
    if (got[k] === undefined) continue
    if (String(got[k]) !== String(v)) return false
  }
  return true
}

function isDone (bot, c) {
  const w = bot.blockAt(c.pos)
  if (!w) return false
  if (c.kind === 'air') return AIR.has(w.name) || (!!c.allow && w.name === c.allow)
  if (c.kind === 'seal') return isSolid(w) || w.name === c.name
  return w.name === c.name && propsMatch(w, c.props)
}

function eyeOf (bot) { return bot.entity.position.offset(0, EYE, 0) }
const centre = p => p.offset(0.5, 0.5, 0.5)
const inReach = (bot, c) => eyeOf(bot).distanceTo(centre(c.pos)) <= REACH

// Тело — не точка: бот на x=10.9 занимает и клетку 11. Сервер не ставит блок,
// пересекающий игрока, и каждый такой отказ стоит полного ожидания.
function bodyInCell (bot, p) {
  const e = bot.entity.position
  return e.x + 0.3 > p.x && e.x - 0.3 < p.x + 1 && e.z + 0.3 > p.z && e.z - 0.3 < p.z + 1 &&
    e.y + 1.8 > p.y && e.y < p.y + 1
}

function squatter (bot, p) {
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e === bot.entity || !e.position || /^(item|experience_orb|arrow|spectral_arrow|item_frame|painting|glow_item_frame)$/.test(e.name || '')) continue
    const half = (e.width || 0.6) / 2
    const q = e.position
    if (q.x + half <= p.x || q.x - half >= p.x + 1 || q.z + half <= p.z || q.z - half >= p.z + 1) continue
    if (q.y + (e.height || 1.8) <= p.y || q.y >= p.y + 1) continue
    return e.name || 'кто-то'
  }
  return null
}

function canStand (bot, p) {
  return isPassable(bot.blockAt(p)) && isPassable(bot.blockAt(p.offset(0, 1, 0))) && isSolid(bot.blockAt(p.offset(0, -1, 0)))
}

const insideBox = (p, box) => p.x >= box.x1 && p.x <= box.x2 && p.z >= box.z1 && p.z <= box.z2 && p.y >= box.y1 && p.y <= box.y2

export {
  EYE, REACH, AIR, FLUID, INTERACTIVE, MADE, YAW, V, HORIZ, JOB, sleep, k3, isSolid, isPassable, holds, propsOf,
  isDone, eyeOf, centre, inReach, bodyInCell, squatter, canStand, insideBox
}

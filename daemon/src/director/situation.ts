'use strict'
// Директор: обстановка (ночь, еда, кирка, своя кровать) и её строка; владелец шагов директора.
import * as gameClock from '../game-clock'
import { AsyncLocalStorage } from 'async_hooks'
import * as assess from '../assess'
import * as bedtime from '../bedtime'

// Чьё намерение: контекст «это директор» тянется через все await шага, а
// вызовы мозга по WebSocket приходят без него (session.runIntent смотрит сюда).
export const owner = new AsyncLocalStorage<{ director?: boolean }>()
export function byDirector () { const st = owner.getStore(); return !!(st && st.director) }

const NIGHT_FROM = 12542
export const NIGHT_TO = 23459
export const TICK_MS = 1000

export function isNight (bot) {
  const t = bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : 6000
  return t >= NIGHT_FROM && t <= NIGHT_TO
}

export function sleep (ms) { return gameClock.sleep(ms) }

export function count (bot, re) {
  let n = 0
  for (const it of bot.inventory.items()) if (typeof re === 'string' ? it.name === re : re.test(it.name)) n += it.count
  return n
}

export const WOOL = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const FOOD = /^(cooked_[a-z_]+|bread|baked_potato|golden_carrot|apple|carrot|sweet_berries|melon_slice|pumpkin_pie|golden_apple|mushroom_stew|beetroot_soup|rabbit_stew|dried_kelp|cookie)$/
export const RAW = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato)$/
export const PICK = { wooden_pickaxe: 1, stone_pickaxe: 2, golden_pickaxe: 1, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }

function pickTier (bot) {
  let t = 0
  for (const it of bot.inventory.items()) if (PICK[it.name] > t) t = PICK[it.name]
  return t
}

// ------------------------------------------------------------ обстановка

export function situation (d) {
  const bot = d.session.bot
  const e = bot.entity
  const feet = e.position.floored()
  const here = bot.blockAt(feet)
  const head = bot.blockAt(feet.offset(0, 1, 0))
  // Под землёй — это порода над головой, а не полумрак своей ямы.
  let roofed = false
  for (let dy = 2; dy <= 24; dy++) {
    const b = bot.blockAt(feet.offset(0, dy, 0))
    if (!b) break
    if (b.boundingBox === 'block' && !/leaves|log/.test(b.name)) { roofed = true; break }
  }
  if (bot.game?.dimension === 'overworld' && typeof head?.skyLight === 'number' && head.skyLight <= 7) roofed = true
  const flags = e.metadata && typeof e.metadata[0] === 'number' ? e.metadata[0] : 0
  let fight = null
  try { fight = assess.plan(bot, { radius: 16 }) } catch {}
  const now = gameClock.now()
  return {
    hp: bot.health ?? 20,
    food: bot.food ?? 20,
    oxygen: typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 20,
    inLava: !!(here && here.name === 'lava') || !!(head && head.name === 'lava'),
    onFire: (flags & 0x01) !== 0,
    inWater: !!e.isInWater,
    y: e.position.y,
    surface: !roofed,
    night: isNight(bot),
    dimension: bot.game ? bot.game.dimension : 'overworld',
    foes: fight && typeof fight.foes === 'number' ? fight.foes : 0,
    verdict: fight ? fight.verdict : 'чисто',
    fight,
    ...(process.env.ND_NIGHT_WORK_SAFE !== '0' && bot.game?.dimension === 'overworld' ? { work: (require('../night-work') as typeof import('../night-work')).profile(bot) } : {}),
    hurtRecently: now - (d.lastHurt || 0) < 4000,
    armed: count(bot, /_(sword|axe)$/) > 0,
    edible: count(bot, FOOD) + count(bot, RAW),
    cooked: count(bot, FOOD),
    raw: count(bot, RAW),
    pick: pickTier(bot),
    free: bot.inventory.emptySlotCount(),
    // Кровать — в рюкзаке или своя, поставленная рядом (bedtime.js её помнит).
    bed: count(bot, /_bed$/) > 0 || ownBedNear(d.session, e.position),
    sleeping: !!bot.isSleeping,
    dusk: (() => { const t = bot.time ? bot.time.timeOfDay : 6000; return t >= bedtime.DUSK_FROM && t < NIGHT_FROM })(),
    day: bot.time && typeof bot.time.day === 'number' ? bot.time.day : 0
  }
}

function ownBedNear (session, pos) {
  if (!session.myBeds || !session.myBeds.size) return false
  for (const k of session.myBeds) {
    const [x, y, z] = k.split(',').map(Number)
    if (Math.abs(x - pos.x) <= 12 && Math.abs(y - pos.y) <= 6 && Math.abs(z - pos.z) <= 12) return true
  }
  return false
}

export function sitText (s) {
  const bits = [`хп ${Math.round(s.hp)}`, `еда ${s.food}`]
  if (s.foes) bits.push(`врагов ${s.foes} (${s.verdict})`)
  if (s.night) bits.push('ночь')
  bits.push(s.surface ? 'на поверхности' : `под землёй y=${Math.floor(s.y)}`)
  if (s.inLava) bits.push('В ЛАВЕ')
  if (s.onFire) bits.push('горит')
  if (s.inWater && s.oxygen < 10) bits.push(`тонет (воздух ${s.oxygen})`)
  return bits.join(', ')
}

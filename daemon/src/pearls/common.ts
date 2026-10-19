'use strict'
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, stuckGuard } from '../movement'
import { equipBestTool, missingHarvestTool } from '../items'
import { canSeePoint } from '../perception'

const SWING_MS = 650
// Удар-вызов из окопа: спокойный эндермен до стольких блоков от ямы (ферма
// 29.09, foxhole-3 с радиусом 10: ни одного вызова за 4 прогона — в 10 блоках
// никого, а в 24 — от 1 до 7).
const POKE_R = 16
// Что эндермен уносит (tags/block/enderman_holdable 1.21.11, те, что бывают у ямы).
const HOLDABLE = /^(warped_nylium|crimson_nylium|grass_block|dirt|coarse_dirt|podzol|mycelium|rooted_dirt|moss_block|mud|sand|red_sand|gravel|clay|warped_roots|crimson_roots|warped_fungus|crimson_fungus)$/
// Кого обходить на охоте за жемчугом: спокойные эндермены нейтральны, а обход
// всех враждебных делал клетки леса «дорогими» — путь к месту окопа выходил
// partial (ферма 29.09).
const FOX_AVOID = new Set(['hoglin', 'zoglin', 'piglin_brute', 'ghast', 'magma_cube', 'blaze', 'wither_skeleton', 'skeleton', 'creeper', 'zombie', 'husk', 'spider', 'witch', 'slime'])

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
const log = (what, o) => console.log('[pearls]', what, JSON.stringify(o))

function meta (bot, e, key) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys.indexOf(key)
    return i >= 0 ? e.metadata[i] : undefined
  } catch { return undefined }
}

const seesMob = (bot, e, frac = 0.55) => canSeePoint(bot, e.position.offset(0, (e.height || 1.8) * frac, 0))
// S1f (аудит S10 №20): эндермены, зомби-пиглины и прочие в решениях охоты — только известные телу (видимые/слышимые: eyes.knownEntities).
const ents = (bot): any[] => (require('../perception/eyes') as typeof import('../perception/eyes')).knownEntities(bot)

// xz — цель по горизонтали (GoalNearXZ): жемчуг на крыше окопа (на 2 выше пола) GoalNear(…, 0) не достигался никогда.
async function walkTo (bot, ctl, target, range, ms, stopIf = null, xz = false) {
  const guard = stuckGuard(bot, ctl, 8000)
  let timer = null
  let poll = null
  try {
    await Promise.race([
      bot.pathfinder.goto(xz ? new goals.GoalNearXZ(target.x, target.z, range) : new goals.GoalNear(target.x, target.y, target.z, range)),
      guard.promise,
      new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), Math.max(500, ms)) }),
      new Promise<any>((_resolve, reject) => { if (stopIf) poll = gameClock.setInterval(() => { try { if (stopIf()) reject(new Error('опасность рядом')) } catch {} }, 250) })
    ])
    return { ok: true }
  } catch (e) {
    try { bot.pathfinder.setGoal(null) } catch {}
    return { ok: false, error: e.message }
  } finally {
    guard.stop()
    if (timer) gameClock.clearTimeout(timer)
    if (poll) gameClock.clearInterval(poll)
  }
}

async function pickUp (bot, ctl, radius, ms) {
  const { collectNearbyDrops }: typeof import('../actions') = require('../actions')
  return collectNearbyDrops(bot, ctl, { radius, timeoutMs: ms })
}

// ------------------------------------------------------------------ hunt

// Укрытие буквой «Г»: шахта 1x1 в три блока и штрек 1x2 в два блока от её дна.
// Просто яма не держит: pathfinder моба считает клетку ямы проходимой (над ней
// небо, высоты хватает), эндермен спрыгивает в неё прямо на бота и бьёт
// (прогон 2026-09-25: «NeuroNether was slain by Enderman» из ямы в 2 блока).
// В штрек высотой 2 он (2.9) не влезает, со дна шахты до бота 2 блока —
// дальше его 1.43 по оси; меч от глаз до его коробки достаёт на 1.7.
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]]

async function digCell (bot, mcData, c) {
  const b = bot.blockAt(c)
  if (!b) return 'мир не прогружен'
  if (b.boundingBox === 'empty' && !/lava|water/.test(b.name)) return null
  if (/lava|water/.test(b.name) || b.name === 'bedrock') return `на пути ${b.name}`
  const problem = missingHarvestTool(bot, b, mcData)
  if (problem) return problem
  try { await equipBestTool(bot, b); await bot.dig(b) } catch (e) { return e.message }
  return null
}

function hazardNear (bot, c) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = bot.blockAt(c.offset(dx, dy, dz))
        if (b && /lava|water/.test(b.name)) return b.name
      }
    }
  }
  return null
}

async function stepInto (bot, cell) {
  const target = cell.offset(0.5, 0, 0.5)
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 2000 && bot.entity.position.floored().distanceTo(cell) >= 0.5) {
      await bot.lookAt(target.offset(0, 1.6, 0), true)
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false) }
  await sleep(250)
  return bot.entity.position.floored().equals(cell)
}

// План норы ДО того, как злить (лаборатория 2026-09-27, прогон 2: злой
// эндермен пришёл, пока тело искало, куда копать штрек, — «slain by Enderman»
// за 22 с). Шахта глубиной 3 (или 4, если на 3 потолка штрека нет): клетки
// шахты — твёрдые, копаемые, без жидкости рядом; штрек 2 клетки в сторону —
// копаемые или воздух, над обеими твёрдый потолок. null — здесь норы не будет.
function solidAt (bot, p) { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' }
function diggable (bot, mcData, p) {
  const b = bot.blockAt(p)
  if (!b) return false
  if (b.boundingBox === 'empty') return !/lava|water/.test(b.name)
  if (b.name === 'bedrock' || /lava|water/.test(b.name)) return false
  return !missingHarvestTool(bot, b, mcData)
}

export {
  SWING_MS, POKE_R, HOLDABLE, FOX_AVOID, clamp, log, meta, seesMob, ents, walkTo, pickUp, CARDINAL, digCell,
  hazardNear, stepInto, solidAt, diggable
}

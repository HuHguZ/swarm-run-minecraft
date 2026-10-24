'use strict'
// Тело и метаданные (pvp.ts): досягаемость, флаги живого, огонь, безопасный шаг, следующий враг, хп мобов.
// healthOf — точное хп из метаданных: только мобам и телеметрии; игроки — через pvp/combat-observe.trackFoe (оценка).

import { stepSafe as stepSafeRaw } from '../moves'
import * as gameClock from '../game-clock'
import * as assess from '../assess'
import * as read from '../read'
import { rayBox } from '../pick'
import { FOES, isPlayer } from './rules'

function hasEffect (bot, name) {
  return require('../fightkit').hasEffect(bot, name)
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function reachFrom (eye, e) {
  const hw = (e.width || 0.6) / 2
  const h = e.height || 1.8
  const p = e.position
  const cx = clamp(eye.x, p.x - hw, p.x + hw)
  const cy = clamp(eye.y, p.y, p.y + h)
  const cz = clamp(eye.z, p.z - hw, p.z + hw)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

function livingFlags (bot, e) {
  try {
    const keys = bot.registry.entitiesByName.player.metadataKeys
    const i = keys.indexOf('living_entity_flags')
    const f = e.metadata[i >= 0 ? i : 8]
    return typeof f === 'number' ? f : 0
  } catch { return 0 }
}

function usingItem (bot, e) {
  const f = livingFlags(bot, e)
  if (!(f & 0x01)) return null
  const eq = e.equipment || []
  const it = (f & 0x02) ? eq[1] : eq[0]
  return it ? it.name : 'что-то'
}

function onFire (bot) {
  try { return (bot.entity.metadata[0] & 0x01) !== 0 } catch { return false }
}

// Края рамки тела (ширина 0.6) по ходу — не над лавой и огнём: центр шага на камне, а край над ямой — и толчок или
// срезанный угол кидает в лаву (стенд 15×15, раунд a8 21.10: 4 смерти «tried to swim in lava» без чужого удара; на поле
// Колизея лава — ямы на −1 у холмов, края — магма). Свой шаг в лаву — нет; сбил его удар — законно.
const BURNS = /^(lava|fire|soul_fire)$/
function edgeBurns (bot, dir, reach = 0.9) {
  const me = bot.entity.position
  for (const s of [-0.3, 0.3]) {
    const p = me.offset(dir.x * reach - dir.z * s, 0, dir.z * reach + dir.x * s)
    for (const dy of [0, -1]) {
      const b = bot.blockAt(p.offset(0, dy, 0).floored())
      if (b && BURNS.test(b.name)) return true
    }
  }
  return false
}
function stepSafe (bot, dir, { reach = .9 }: any = {}) {
  const swim = (bot._ndSwimUntil || 0) > gameClock.now()
  return stepSafeRaw(bot, dir, { reach, water: swim || onFire(bot) || !!(bot.entity && bot.entity.isInWater) }) && !edgeBurns(bot, dir, reach)
}

// Будущая яма ещё выглядит безопасным полом: проверяем весь проход рамки тела.
function digStepSafe (ctx, dir, reach = .9) {
  const bot = ctx.bot
  if (ctx.floorEscape || ctx.behindDrop || bot.entity.isInWeb || bot.entity.isInWater || bot.entity.isInLava || onFire(bot) || ctx.dodgeKey && ctx.dodgeLine) return true
  const avoid = ctx.opts?.digAvoid ?? ctx.session?.current?.params?.digAvoid
  if (!Array.isArray(avoid)) return true
  const me = bot.entity.position, half = (bot.entity.width || .6) / 2
  const motion = { x: dir.x * reach, y: 0, z: dir.z * reach }, end = me.offset(motion.x, 0, motion.z)
  return !avoid.some(p => {
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite) || p.feetY !== undefined && !Number.isFinite(p.feetY)) return false
    const feetY = p.feetY ?? p.y + 1
    const lo = { x: p.x - half + 1e-7, y: feetY - 1e-7, z: p.z - half + 1e-7 }
    const hi = { x: p.x + 1 + half - 1e-7, y: feetY + (bot.entity.height || 1.8), z: p.z + 1 + half - 1e-7 }
    const inside = q => q.x >= lo.x && q.x <= hi.x && q.y >= lo.y && q.y <= hi.y && q.z >= lo.z && q.z <= hi.z
    return rayBox(me, motion, lo, hi, 1) != null && (!inside(me) || inside(end))
  })
}
function makeTracker (entity) {
  return require('../bow').trackTarget(entity)
}

function yawTo (from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

function nextFoe (bot, radius, dead = null) {
  const me = bot.entity.position
  return bot.nearestEntity(e => e && e.position && FOES.has(e.name) && e.name !== 'iron_golem' &&
    e.position.distanceTo(me) < radius && e.isValid !== false && !(dead && dead.has(e.id)) && !lookDead(bot, e) &&
    assess.inSight(bot, e)) || null
}

function healthOf (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' ? h + read.absorptionOf(bot, e) : null
  } catch { return null }
}

function lookDead (bot, e) {
  // Player deaths are confirmed by entityDead; their health metadata is private.
  if (isPlayer(e) || e?.name === 'player') return false
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' && h <= 0
  } catch { return false }
}

function creeperSwelling (bot, e) {
  try {
    const keys = bot.registry.entitiesByName.creeper.metadataKeys
    const i = keys.indexOf('swell_dir')
    return e.metadata[i >= 0 ? i : 16] === 1
  } catch { return false }
}

// Бросившие заряд ветра (bot._ndWindBy: id → когда): заряд-сущность рядом с ним — его бросок.
function noteWindThrowers (bot, foes, now) {
  const by = bot._ndWindBy || (bot._ndWindBy = new Map())
  for (const w of Object.values(bot.entities || {}) as any[]) {
    if (!w || !/wind_charge/.test(w.name || '') || !w.position) continue
    for (const f of foes) if (f && f.position && f.position.distanceTo(w.position) < 2.5) by.set(f.id, now)
  }
  return by
}

export { hasEffect, clamp, reachFrom, livingFlags, usingItem, onFire, stepSafe, digStepSafe, edgeBurns, noteWindThrowers, makeTracker, yawTo, nextFoe, healthOf, lookDead, creeperSwelling }

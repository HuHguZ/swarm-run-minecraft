'use strict'
// Тело и метаданные (pvp.ts): досягаемость, флаги живого, огонь, безопасный шаг, следующий враг, хп мобов.
// healthOf — точное хп из метаданных: только мобам и телеметрии; игроки — через pvp/combat-observe.trackFoe (оценка).

import { stepSafe as stepSafeRaw } from '../moves'
import * as assess from '../assess'
import * as read from '../read'
import { FOES } from './rules'

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

function stepSafe (bot, dir) {
  return stepSafeRaw(bot, dir, { water: onFire(bot) || !!(bot.entity && bot.entity.isInWater) })
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

export { hasEffect, clamp, reachFrom, livingFlags, usingItem, onFire, stepSafe, makeTracker, yawTo, nextFoe, healthOf, lookDead, creeperSwelling }

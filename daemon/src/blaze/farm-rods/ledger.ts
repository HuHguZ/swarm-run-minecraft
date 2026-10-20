'use strict'
// Учёт урона навыка стержней (farmRods): куда ушли хп — тип урона и занятие тела.
import * as gameClock from '../../game-clock'
import { log } from '../targets'

// Типы урона — номер в реестре damage_type (пакет damage_event), реестр по
// алфавиту имён: data/minecraft/damage_type/*.json в server-1.21.11.jar, 50
// штук (сверено 2026-09-27; тот же список в dragon.js).
const DAMAGE_TYPES = ['arrow', 'bad_respawn_point', 'cactus', 'campfire', 'cramming', 'dragon_breath', 'drown', 'dry_out',
  'ender_pearl', 'explosion', 'fall', 'falling_anvil', 'falling_block', 'falling_stalactite', 'fireball', 'fireworks',
  'fly_into_wall', 'freeze', 'generic', 'generic_kill', 'hot_floor', 'in_fire', 'in_wall', 'indirect_magic', 'lava',
  'lightning_bolt', 'mace_smash', 'magic', 'mob_attack', 'mob_attack_no_aggro', 'mob_projectile', 'on_fire',
  'out_of_world', 'outside_border', 'player_attack', 'player_explosion', 'sonic_boom', 'spear', 'spit', 'stalagmite',
  'starve', 'sting', 'sweet_berry_bush', 'thorns', 'thrown', 'trident', 'unattributed_fireball', 'wind_charge',
  'wither', 'wither_skull']

// Куда ушли хп: каждая потеря здоровья — к последнему damage_event по нам
// (тип и кто), и к тому, чем тело было занято (phase). Разбор смертей в
// лаборатории этапов: «сгорел» от шара, от огня после шара, от лавы — это три
// разные поправки.
function damageLedger (bot, phaseOf) {
  const byType = {}
  const byPhase = {}
  const hits = []
  let last = null
  let hp = bot.health ?? 20
  const onPk = pk => {
    if (!bot.entity || !pk || pk.entityId !== bot.entity.id) return
    const src = pk.sourceCauseId > 0 ? bot.entities[pk.sourceCauseId - 1] : null
    const direct = pk.sourceDirectId > 0 ? bot.entities[pk.sourceDirectId - 1] : null
    last = { type: DAMAGE_TYPES[pk.sourceTypeId] || String(pk.sourceTypeId), by: src ? src.name : undefined, t: gameClock.now() }
    // Геометрия щита в миг удара: куда смотрим, откуда прилетело (снаряд или
    // тот, кто бил), поднят ли щит по метаданным и сколько мс назад.
    try {
      const from = (direct && direct.position) || (src && src.position)
      if (from && ledger.probe) {
        const me = bot.entity.position
        const dx = from.x - me.x; const dz = from.z - me.z; const n = Math.hypot(dx, dz) || 1
        const fx = -Math.sin(bot.entity.yaw); const fz = -Math.cos(bot.entity.yaw)
        last.geo = { ang: Math.round(Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / n))) * 180 / Math.PI), ...ledger.probe() }
      }
    } catch {}
  }
  const onHealth = () => {
    const now = bot.health ?? 0
    if (now < hp) {
      const lost = hp - now
      const fresh = last && gameClock.now() - last.t < 600
      const key = fresh ? last.type + (last.by && last.by !== last.type ? ':' + last.by : '') : 'unknown'
      const phase = phaseOf() || '-'
      byType[key] = (byType[key] || 0) + lost
      byPhase[phase] = (byPhase[phase] || 0) + lost
      if (hits.length < 60) hits.push({ t: gameClock.now(), k: key, lost: Math.round(lost * 10) / 10, hp: Math.round(now * 10) / 10, ph: phase, geo: fresh && last.geo && key !== 'on_fire' ? last.geo : undefined })
      if (fresh && last.geo && key !== 'on_fire') log('удар', { k: key, lost: Math.round(lost * 10) / 10, hp: Math.round(now * 10) / 10, ph: phase, ...last.geo })
    }
    hp = now
  }
  bot._client.on('damage_event', onPk)
  bot.on('health', onHealth)
  const r1 = o => Object.fromEntries((Object.entries(o) as [string, any][]).map(([k, v]: any) => [k, Math.round(v * 10) / 10]).sort((a: any, b: any) => b[1] - a[1]))
  const ledger = {
    probe: null,
    stop () {
      bot._client.removeListener('damage_event', onPk)
      bot.removeListener('health', onHealth)
    },
    report () {
      const total: any = (Object.values(byType) as any[]).reduce((s: any, v) => s + v, 0)
      return total > 0 ? { total: Math.round(total * 10) / 10, byType: r1(byType), byPhase: r1(byPhase) } : undefined
    },
    hits
  }
  return ledger
}

export { damageLedger }

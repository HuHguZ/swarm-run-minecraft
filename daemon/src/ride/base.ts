'use strict'
// Езда (ride.ts): константы, такт, атрибуты лошади, проходимость клеток, пакеты управления транспортом.
import * as gameClock from '../game-clock'
import attribute = require('prismarine-physics/lib/attribute')

export const HORSES = { horse: { w: 1.3964844, h: 1.6 }, donkey: { w: 1.3964844, h: 1.5 }, mule: { w: 1.3964844, h: 1.6 }, skeleton_horse: { w: 1.3964844, h: 1.6 }, zombie_horse: { w: 1.3964844, h: 1.6 } }
export const BOAT = { w: 1.375, h: 0.5625 }
export const isBoatName = n => /(_boat|_raft)$/.test(n || '')
export const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo']
export const TICK = 50
export const RAD = 180 / Math.PI
export const DEBUG = !!process.env.ND_DEBUG_RIDE

export function sleep (ms, ctl?: any) {
  return new Promise<any>(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve(undefined) })
  })
}

// Ровно 20 тиков в секунду по часам: sleep(50) плюс работа тика — это ~16 Гц,
// и транспорт ехал бы медленнее, чем в игре. Отстали больше чем на 5 тиков
// (перестройка маршрута) — не догонять рывком, а считать заново отсюда.
export function pacer (ctl) {
  let base = gameClock.now(); let n = 0
  return () => {
    n++
    let wait = base + n * TICK - gameClock.now()
    if (wait < -5 * TICK) { base = gameClock.now(); n = 0; wait = 0 }
    return sleep(Math.max(0, wait), ctl)
  }
}

// mineflayer: yaw 0 — север, против часовой; сервер — градусы, 0 — юг.
export const toMcYaw = yaw => (Math.PI - yaw) * RAD
export const fromMcYaw = deg => Math.PI - deg / RAD
export const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
export const xyz = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

// minecraft-data 1.21.11: у маппера атрибутов в пакете entity_update_attributes
// нет mining_efficiency (20), movement_efficiency (21), oxygen_bonus (23),
// sneaking_speed (26), и с id 20 имена съехали. Реестр сервера (Attributes,
// javap): 22 — movement_speed, 25 — scale; а маппер зовёт 22 «generic.scale».
// Скорость лошади приходит под чужим именем, прыжок (15) — под своим. Здесь
// имя из маппера переводится обратно в id, а id — в настоящее имя реестра.
let ATTR_FIX = null
export function attrFix (bot) {
  if (ATTR_FIX || !bot || !bot.registry) return
  const map: any = {}
  try {
    const find = o => {
      if (!o || typeof o !== 'object') return null
      if (o.mappings && (Object.values(o.mappings) as any[]).includes('generic.armor')) return o.mappings
      for (const v of (Object.values(o) as any[])) { const r = find(v); if (r) return r }
      return null
    }
    const mapper = find(bot.registry.protocol.play.toClient.types.packet_entity_update_attributes) || {}
    const real = bot.registry.attributesArray || []
    for (const [id, key] of (Object.entries(mapper) as [string, any][])) if (real[id]) map[key] = real[id].resource.replace(/^minecraft:/, '')
  } catch {}
  ATTR_FIX = map
}
const attrName = k => (ATTR_FIX && ATTR_FIX[k]) || k.replace(/^minecraft:/, '').replace(/^(generic|player|zombie)\./, '')

export function attr (e, name, dflt) {
  const a = e && e.attributes
  if (!a) return dflt
  const k = Object.keys(a).find(k => attrName(k) === name)
  if (!k) return dflt
  try { return attribute.getAttributeValue(a[k]) } catch { return a[k].value ?? dflt }
}

const horseFlags = e => { const f = e.metadata && e.metadata[17]; return typeof f === 'number' ? f : 0 }
export const isTamedHorse = e => (horseFlags(e) & 0x02) !== 0
export const isBaby = e => !!(e.metadata && e.metadata[16] === true)
export function isSaddled (e) {
  const eq = e.equipment || []
  if (eq.some(it => it && it.name === 'saddle')) return true
  return (horseFlags(e) & 0x04) !== 0
}

// Блоки: проходимо (для ног и головы) и можно стоять сверху.
const LIQUID = /^(water|lava|bubble_column)$/
const HURTS = /^(cactus|sweet_berry_bush|fire|soul_fire|magma_block|campfire|soul_campfire|powder_snow|wither_rose|pointed_dripstone)$/
export const passable = b => !!b && b.boundingBox === 'empty' && !LIQUID.test(b.name) && !HURTS.test(b.name)
export const standOn = b => !!b && b.boundingBox === 'block' && !HURTS.test(b.name) && !/fence|_wall$|iron_bars|pane/.test(b.name)
export const isWater = b => !!b && (b.name === 'water' || b.name === 'bubble_column' || (() => { try { return b.getProperties().waterlogged === true } catch { return false } })())

// ------------------------------------------------------------------ пакеты

export function sendLook (bot, yawDeg, pitchDeg) {
  try { bot._client.write('look', { yaw: yawDeg, pitch: pitchDeg, onGround: false, flags: { onGround: false, hasHorizontalCollision: false } }) } catch {}
}

export function sendInput (bot, inp) {
  try {
    bot._client.write('player_input', {
      inputs: { forward: !!inp.forward, backward: !!inp.back, left: !!inp.left, right: !!inp.right, jump: !!inp.jump, shift: !!inp.shift, sprint: false }
    })
  } catch {}
}

export function sendVehicle (bot, pos, yawDeg, onGround) {
  try { bot._client.write('vehicle_move', { x: pos.x, y: pos.y, z: pos.z, yaw: yawDeg, pitch: 0, onGround: !!onGround }) } catch {}
}

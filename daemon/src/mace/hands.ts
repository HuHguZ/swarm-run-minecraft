// Булава (mace.ts): руки и инвентарь — предметы и хотбар, его хп и щит, удар (оглушающий), «после пакета этого тика»,
// перезарядка и выстрел зарядом ветра.
import * as gameClock from '../game-clock'
import { SWAP, WIND_CD_MS } from './consts'

export function densityOf (bot) {
  const m = findItem(bot, 'mace')
  try { return m ? (require('../read') as typeof import('../read')).enchLevel(bot, m, 'density') : 0 } catch { return 0 }
}

export function countOf (bot, name) {
  return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
}
export function findItem (bot, name) {
  return bot.inventory.items().find(i => i.name === name) || null
}
export function hotbarIndex (bot, name) {
  for (let i = 0; i < 9; i++) {
    const it = bot.inventory.slots[36 + i]
    if (it && it.name === name) return i
  }
  return -1
}
export function healthOf (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' ? h : null
  } catch { return null }
}
function livingFlags (bot, e) {
  try {
    const keys = bot.registry.entitiesByName.player.metadataKeys
    const i = keys.indexOf('living_entity_flags')
    const f = e.metadata[i >= 0 ? i : 8]
    return typeof f === 'number' ? f : 0
  } catch { return 0 }
}
export function heldName (e) {
  const eq = e && e.equipment
  return eq && eq[0] ? eq[0].name : ''
}
// Его щит поднят и смотрит на нас (передняя полусфера по горизонтали). Прямо сверху — тоже держит:
// LivingEntity.applyItemBlocking берёт горизонталь к источнику, у нуля normalize() = 0, acos(0) = 90° — ещё в угле
// (BlocksAttacks.DamageReduction: блок, пока угол ≤ 90°, javap 1.21.11; s7b 06.10 — раньше над макушкой считали «мимо»).
export function shieldAtUs (bot, e, at = bot.entity.position) {
  const f = livingFlags(bot, e)
  if (!(f & 0x01)) return false
  const eq = e.equipment || []
  const it = (f & 0x02) ? eq[1] : eq[0]
  if (!it || it.name !== 'shield') return false
  const fx = -Math.sin(e.yaw || 0); const fz = -Math.cos(e.yaw || 0)
  const tx = at.x - e.position.x; const tz = at.z - e.position.z
  const h = Math.hypot(tx, tz)
  if (h < 0.35) return true
  return (fx * tx + fz * tz) / h >= -0.02
}

// Удар булавой с падения по поднятому щиту — 0 урона (s7c: 2 из 5 «снял 0» — щит; булава щит не выбивает:
// Items.MACE Weapon(1)). «Оглушающий удар» (stun slam): в одном тике топор (Weapon axe: щит на 5 с в откат,
// BlocksAttacks.disable → stopUsingItem) и сразу булава — она уже не в щит. Бонус падения к заряду не привязан
// (Player.attack: getAttackDamageBonus прибавляется после множителя заряда, javap 1.21.11), так что сброс заряда
// топором удар с падения не портит. Возвращает true, если был топор.
export function slamHit (bot, e, stats = null) {
  const mi = hotbarIndex(bot, 'mace')
  const cur = bot.quickBarSlot
  let ai = -1
  if (shieldAtUs(bot, e)) for (let i = 0; i < 9; i++) { const it = bot.inventory.slots[36 + i]; if (it && /_axe$/.test(it.name)) { ai = i; break } }
  if (ai >= 0) {
    bot.setQuickBarSlot(ai)
    bot.attack(e)
    if (stats) stats.stunSlams = (stats.stunSlams || 0) + 1
  }
  if (mi >= 0 && bot.quickBarSlot !== mi) bot.setQuickBarSlot(mi)
  bot.attack(e)
  return { stun: ai >= 0, swapped: mi >= 0 && mi !== cur, cur }
}

// Общая граница после movement/tick_end сохраняет позицию и владельца действия;
// edges оставляет fallback для клиентов без адаптера и вызовов между тиками.
export function afterPacket (bot, fn) {
  return (require('../edges') as typeof import('../edges')).afterPacket(bot, fn)
}

export const nextTick = (bot) => new Promise<any>(resolve => {
  const on = () => { gameClock.clearTimeout(t); resolve(true) }
  const t = gameClock.setTimeout(() => { bot.removeListener('physicsTick', on); resolve(false) }, 300)
  bot.once('physicsTick', on)
})

// Перезарядка заряда ветра — по пакету set_cooldown (группа minecraft:
// wind_charge): mineflayer его не разбирает (ждёт itemID, а в 1.21.11 там
// cooldownGroup), читаем сырой пакет, один раз на бота.
const nativeWindCooldown = new WeakSet<object>()

export function windCooling (bot) {
  return nativeWindCooldown.has(bot) || gameClock.now() < (bot._ndWindCd || 0)
}

export function install (bot) {
  if (bot._ndMaceInstalled) return
  bot._ndMaceInstalled = true
  bot._ndWindCd = 0
  try {
    const client = bot._client, native = bot.version === '1.21.11'
    const cooldown = p => {
      const group = p?.cooldownGroup, ticks = p?.cooldownTicks
      if ((group !== 'minecraft:wind_charge' && group !== 'wind_charge') || !Number.isSafeInteger(ticks) || ticks < 0) return
      if (native) {
        // Predicted body ticks can overtake the native cooldown. The server sends zero when it expires.
        if (ticks > 0) nativeWindCooldown.add(bot)
        else nativeWindCooldown.delete(bot)
      }
      bot._ndWindCd = gameClock.now() + ticks * 50
    }
    client.on('set_cooldown', cooldown)
    // Paper retains the server player's cooldowns across death and dimension changes.
    if (native) bot.once?.('end', () => {
      client.removeListener('set_cooldown', cooldown)
      nativeWindCooldown.delete(bot)
      bot._ndWindCd = 0
    })
  } catch {}
  // Когда булава взята в правую: заряд (33 тика) считается от смены предмета.
  bot._ndMaceHeldAt = 0
  bot.on('heldItemChanged', (it) => {
    if (it && it.name === 'mace') { if (!bot._ndMaceHeldAt) bot._ndMaceHeldAt = gameClock.now() } else bot._ndMaceHeldAt = 0
  })
  // Сторож ведра (edges.installFallGuard) спрашивает, не прикрыто ли падение
  // зарядом ветра: тогда вода не нужна, а рука занята булавой.
  bot._ndWindFall = (top) => {
    const w = bot._ndWind
    if (!w || gameClock.now() > w.until) return false
    // Урон = floor(min(падение, всплеск − y) − 3): сел не ниже всплеска − 3 — ноль.
    return top >= w.impactY - 3 + 0.2
  }
}

// Заряды ветра в левой руке (слот 45).
export function offWind (bot) {
  const it = bot.inventory.slots[45]
  return !!(it && it.name === 'wind_charge')
}

// Сколько зарядов: рюкзак (inventory.items() — слоты 9..44) и левая рука.
export function windCount (bot) {
  return countOf(bot, 'wind_charge') + (offWind(bot) ? bot.inventory.slots[45].count : 0)
}

export function windReady (bot) {
  return !windCooling(bot) && windCount(bot) > 0
}

// Нужное — в хотбар (свап берёт слоты хотбара, из рюкзака — только кликами).
// Сначала свободный/неценный слот; при полном хотбаре обмен возвращает вещь в рюкзак.
const KEEP = /_sword$|_axe$|^mace$|^wind_charge$|^bow$|^crossbow$|^totem_of_undying$|golden_apple$|^water_bucket$|^ender_pearl$|^shield$/
export async function ensureHotbar (bot, names) {
  for (const name of names) {
    if (hotbarIndex(bot, name) >= 0) continue
    const it = findItem(bot, name)
    if (!it) return false
    if (bot.currentWindow || bot.inventory.selectedItem) return false
    let dest = -1
    for (let i = 0; i < 9; i++) if (i !== bot.quickBarSlot && !bot.inventory.slots[36 + i]) { dest = i; break }
    if (dest < 0) for (let i = 8; i >= 0; i--) { const s = bot.inventory.slots[36 + i]; if (i !== bot.quickBarSlot && s && !KEEP.test(s.name)) { dest = i; break } }
    if (dest < 0) for (let i = 8; i >= 0; i--) if (i !== bot.quickBarSlot && !names.some(name => hotbarIndex(bot, name) === i)) { dest = i; break }
    if (dest < 0) return false
    try { await bot.moveSlotItem(it.slot, 36 + dest) } catch { return false }
    if (hotbarIndex(bot, name) < 0) return false
  }
  return true
}

// Видимая грань пола, реальный сдвиг бросающего и положение ног к разрыву (jar 1.21.11).
export function selfWindAim (bot, { yaw = bot.entity.yaw, back = 0, moved }: any) {
  const pick = require('../pick') as typeof import('../pick')
  const edges = require('../edges') as typeof import('../edges')
  const wind = require('../combat/team-wind') as typeof import('../combat/team-wind')
  const { Vec3 } = require('vec3') as typeof import('vec3')
  const from = pick.eyeOf(bot), down = new Vec3(0, -1, 0)
  const above = from.offset(Math.sin(yaw) * back, 0, Math.cos(yaw) * back)
  const floor = pick.blockOnRay(bot, above, down, from.y - bot.game.minY)
  if (!floor) return null
  moved = moved.clone()
  if (bot.entity.onGround) moved.y = 0
  const shot = wind.windShot(bot, from, above.plus(down.scaled(floor.t)), moved)
  if (!shot || shot.normal.y !== 1) return null
  const control = { ...edges.IDLE }
  for (const key of Object.keys(control)) control[key] = !!bot.getControlState(key)
  const state = edges.stateOf(bot, control), world = edges.worldOf(bot), sim = edges.simOf(bot)
  const falling = !state.onGround && state.vel.y < 0
  for (let tick = 0; tick < shot.ticks; tick++) {
    sim(state, world)
    // Посадка раньше разрыва уже нанесёт урон: поздний MLG заряд не спасёт.
    if (falling && state.onGround && tick < shot.ticks - 1) return null
  }
  return wind.windImpulse(bot, state.pos, shot.burst).y > 0 ? shot : null
}

// Бросок после пакета позиции; immediate — текущий тик MLG, чтобы не ждать приземления.
export function fireWind (bot, aim, { swap = SWAP, before = null, hand = null, immediate = false, allies = [], packetAim = false, canFire = null }: any = {}) {
  return new Promise<any>(resolve => {
    const off = hand === 'off' || (hand == null && offWind(bot))
    const wi = off ? -1 : hotbarIndex(bot, 'wind_charge')
    if (!off && wi < 0) return resolve({ fired: false, why: 'заряда нет в хотбаре' })
    if (windCooling(bot)) return resolve({ fired: false, why: 'перезарядка' })
    const lastPos = bot.entity.position.clone()
    let done = false
    const onT = () => {
      if (done) return
      done = true
      gameClock.clearTimeout(timer)
      bot.removeListener('physicsTick', onT)
      let sol = null
      const aimPos = bot.entity.position.clone(), aimMovement = bot._ndLaunchMovement?.() || aimPos.minus(lastPos)
      try { if (before) before(); if (!packetAim) sol = aim(aimMovement) } catch { return resolve({ fired: false, why: 'некуда' }) }
      if (!packetAim) {
        if (!sol) return resolve({ fired: false, why: 'некуда' })
        bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      }
      afterPacket(bot, () => {
        try {
          if (windCooling(bot)) return resolve({ fired: false, why: 'перезарядка' })
          if (canFire && !canFire()) return resolve({ fired: false, why: 'прервали' })
          const moved = bot._ndLaunchMovement?.() || (bot.entity.position.equals(aimPos) ? aimMovement.clone() : bot.entity.position.minus(aimPos))
          if (bot.entity.onGround) moved.y = 0
          if (packetAim) {
            if (off ? !offWind(bot) : bot.inventory.slots[36 + wi]?.name !== 'wind_charge') return resolve({ fired: false, why: 'заряд сменился' })
            sol = aim(moved)
            if (!sol) return resolve({ fired: false, why: 'некуда' })
          }
          const actual = packetAim ? sol : { yaw: bot.entity.yaw, pitch: bot.entity.pitch }
          const { WIND, useWindAtAngle } = require('../combat/team-wind') as typeof import('../combat/team-wind')
          const agreement = Math.sin(actual.pitch) * Math.sin(sol.pitch) +
            Math.cos(actual.pitch) * Math.cos(sol.pitch) * Math.cos(actual.yaw - sol.yaw)
          if (!Number.isFinite(agreement) || agreement < Math.cos(WIND.dispersion)) {
            resolve({ fired: false, why: 'wind_look_changed' }); return
          }
          const { windReleaseSafe } = require('../combat/wind-safety') as typeof import('../combat/wind-safety')
          if (!windReleaseSafe(bot, sol, moved, undefined, allies) || (actual.yaw !== sol.yaw || actual.pitch !== sol.pitch) && !windReleaseSafe(bot, actual, moved, undefined, allies)) {
            resolve({ fired: false, why: 'unsafe_allied_wind' }); return
          }
          const back = bot.quickBarSlot
          if (!off && back !== wi) bot.setQuickBarSlot(wi)
          try {
            if (packetAim) useWindAtAngle(bot, off, sol, true)
            else if (off) bot.activateItem(true)
            else bot.activateItem()
          } finally { if (!off && swap && back !== wi) bot.setQuickBarSlot(back) }
          // Заряд — не «натягивают»: mineflayer иначе считает руку занятой.
          bot.usingHeldItem = false
          bot._ndWindCd = gameClock.now() + WIND_CD_MS
          resolve({ fired: true, yaw: sol.yaw, pitch: sol.pitch, from: bot.entity.position.clone(), shot: sol, off, swapped: !off && swap && back !== wi })
        } catch (e) { resolve({ fired: false, why: e.message }) }
      })
    }
    const timer = gameClock.setTimeout(() => { if (!done) { done = true; bot.removeListener('physicsTick', onT); resolve({ fired: false, why: 'физика стоит' }) } }, 400)
    bot.on('physicsTick', onT)
    if (immediate) onT()
  })
}

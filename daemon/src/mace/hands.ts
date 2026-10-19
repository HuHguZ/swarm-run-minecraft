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

// Сделать fn после пакета позиции этого тика: setImmediate — или в начале
// следующего тика, если он пришёл раньше. mineflayer, отстав, гонит два тика
// физики подряд в одном таймере, и setImmediate срабатывал уже ПОСЛЕ пакета
// приземления: сервер обнулял высоту падения до удара, и булава била без
// бонуса (замер 2026-09-26: из трёх ударов с 8 бл. два — по 1.56 хп, один
// убил; в трассе тики с одной меткой времени).
export function afterPacket (bot, fn) {
  let done = false
  const run = () => {
    if (done) return
    done = true
    bot.removeListener('physicsTick', run)
    try { fn() } catch {}
  }
  bot.prependListener('physicsTick', run)
  setImmediate(run)
}

export const nextTick = (bot) => new Promise<any>(resolve => {
  const on = () => { gameClock.clearTimeout(t); resolve(true) }
  const t = gameClock.setTimeout(() => { bot.removeListener('physicsTick', on); resolve(false) }, 300)
  bot.once('physicsTick', on)
})

// Перезарядка заряда ветра — по пакету set_cooldown (группа minecraft:
// wind_charge): mineflayer его не разбирает (ждёт itemID, а в 1.21.11 там
// cooldownGroup), читаем сырой пакет, один раз на бота.
export function install (bot) {
  if (bot._ndMaceInstalled) return
  bot._ndMaceInstalled = true
  bot._ndWindCd = 0
  try {
    bot._client.on('set_cooldown', (p) => {
      const g = String((p && p.cooldownGroup) || '')
      if (/wind_charge/.test(g)) bot._ndWindCd = gameClock.now() + Math.max(0, p.cooldownTicks || 0) * 50
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
  return gameClock.now() >= (bot._ndWindCd || 0) && windCount(bot) > 0
}

// Нужное — в хотбар (свап берёт слоты хотбара, из рюкзака — только кликами).
// Не на выбранный слот и не поверх оружия, еды, тотема, ведра.
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
    if (dest < 0) return false
    try { await bot.moveSlotItem(it.slot, 36 + dest) } catch { return false }
    if (hotbarIndex(bot, name) < 0) return false
  }
  return true
}

// Заряд ветра на тике физики: aim() считает взгляд по позиции этого тика
// (пакет позиции уйдёт с ним же), бросок — после пакета (afterPacket; как у
// лука и броска, throw.js). Заряды в левой руке — «использовать» левой, правая
// не меняется. Иначе — выбрать слот заряда, «использовать» и (swap) сразу
// вернуть прежний: на Paper заряд меча всё равно обнулится (см. SWAP), зато
// меч снова в руке без лишнего тика.
export function fireWind (bot, aim, { swap = SWAP, before = null, hand = null }: any = {}) {
  return new Promise<any>(resolve => {
    const off = hand === 'off' || (hand == null && offWind(bot))
    const wi = off ? -1 : hotbarIndex(bot, 'wind_charge')
    if (!off && wi < 0) return resolve({ fired: false, why: 'заряда нет в хотбаре' })
    if (gameClock.now() < (bot._ndWindCd || 0)) return resolve({ fired: false, why: 'перезарядка' })
    let done = false
    const onT = () => {
      if (done) return
      done = true
      gameClock.clearTimeout(timer)
      bot.removeListener('physicsTick', onT)
      let sol = null
      try { if (before) before(); sol = aim() } catch {}
      if (!sol) return resolve({ fired: false, why: 'некуда' })
      bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      afterPacket(bot, () => {
        try {
          const back = bot.quickBarSlot
          if (off) bot.activateItem(true)
          else {
            if (back !== wi) bot.setQuickBarSlot(wi)
            bot.activateItem()
            if (swap && back !== wi) bot.setQuickBarSlot(back)
          }
          // Заряд — не «натягивают»: mineflayer иначе считает руку занятой.
          bot.usingHeldItem = false
          bot._ndWindCd = gameClock.now() + WIND_CD_MS
          resolve({ fired: true, yaw: sol.yaw, pitch: sol.pitch, from: bot.entity.position.clone(), off, swapped: !off && swap && back !== wi })
        } catch (e) { resolve({ fired: false, why: e.message }) }
      })
    }
    const timer = gameClock.setTimeout(() => { if (!done) { done = true; bot.removeListener('physicsTick', onT); resolve({ fired: false, why: 'физика стоит' }) } }, 400)
    bot.on('physicsTick', onT)
  })
}

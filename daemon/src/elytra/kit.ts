'use strict'
// Элитры (elytra.ts): тело — элитры, нагрудник, фейерверки, хотбар, смена элитр на нагрудник.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { sleep }: typeof import('./consts') = require('./consts')

// ---------------------------------------------------------------- тело

function findItem (bot, test) {
  const f = typeof test === 'string' ? (i => i.name === test) : test
  return bot.inventory.items().find(f) || null
}
function countOf (bot, name) {
  return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
}
function offName (bot) { const o = bot.inventory.slots[45]; return o ? o.name : null }
function chestName (bot) { const c = bot.inventory.slots[6]; return c ? c.name : null }
function hotbarIndex (bot, name) {
  for (let i = 0; i < 9; i++) { const it = bot.inventory.slots[36 + i]; if (it && it.name === name) return i }
  return -1
}
function rocketCount (bot) {
  return countOf(bot, 'firework_rocket') + (offName(bot) === 'firework_rocket' ? bot.inventory.slots[45].count : 0)
}
// Фейерверк со звёздами взрывается на прицепленном: 5 + 2·звёзд по себе
// (FireworkRocketEntity.dealExplosionDamage) — для полёта только пустые.
function plainRocket (it) {
  if (!it || it.name !== 'firework_rocket') return false
  try {
    const c = it.componentMap && it.componentMap.get('fireworks')
    const ex = c && c.data && (c.data.explosions || c.data.explosion)
    return !(Array.isArray(ex) && ex.length)
  } catch { return true }
}
function bestChest (bot) {
  const order = ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'chainmail_chestplate', 'golden_chestplate', 'copper_chestplate', 'leather_chestplate']
  for (const n of order) { const it = findItem(bot, n); if (it) return it }
  return null
}
const hasElytra = (bot) => chestName(bot) === 'elytra' || !!findItem(bot, 'elytra') || offName(bot) === 'elytra'
const wearingElytra = (bot) => chestName(bot) === 'elytra'
// Что есть для полёта: элитры (на теле или в рюкзаке) и простые фейерверки.
function kit (bot) {
  const rockets = bot.inventory.items().filter(plainRocket).reduce((n, i) => n + i.count, 0) + (plainRocket(bot.inventory.slots[45]) ? bot.inventory.slots[45].count : 0)
  return { elytra: hasElytra(bot), rockets, mace: !!findItem(bot, 'mace'), chest: !!bestChest(bot) || /_chestplate$/.test(chestName(bot) || '') }
}

// Предмет в хотбар (оттуда — «использовать» сменой слота). Не на выбранный
// слот и не поверх оружия/тотема/ведра.
const KEEP = /_sword$|_axe$|^mace$|^bow$|^crossbow$|^totem_of_undying$|golden_apple$|^water_bucket$|^ender_pearl$|^shield$/
async function toHotbar (bot, pred) {
  for (let i = 0; i < 9; i++) if (pred(bot.inventory.slots[36 + i])) return i
  const it = bot.inventory.items().find(pred)
  if (!it || bot.currentWindow) return -1
  let dest = -1
  for (let i = 0; i < 9; i++) if (i !== bot.quickBarSlot && !bot.inventory.slots[36 + i]) { dest = i; break }
  if (dest < 0) for (let i = 8; i >= 0; i--) { const s = bot.inventory.slots[36 + i]; if (i !== bot.quickBarSlot && s && !KEEP.test(s.name)) { dest = i; break } }
  if (dest < 0) return -1
  try { await bot.moveSlotItem(it.slot, 36 + dest) } catch { return -1 }
  return pred(bot.inventory.slots[36 + dest]) ? dest : -1
}

// Элитры ↔ нагрудник одним «использовать» (Equippable.swapWithEquipmentSlot):
// предмет в руке встаёт на тело, снятое — в ту же руку. hand 'off' — левой:
// заряд оружия в правой не сбрасывается. Ждём подтверждения сервера (слот 6).
async function swapChest (bot, want, { hand = 'main', waitMs = 400, ctl = null }: any = {}) {
  const trace = stage => {
    if (process.env.ND_ELYTRA_EQUIP_TRACE === '1') console.log('[elytra-equip]', JSON.stringify({
      stage, at: gameClock.now(), wallAt: gameClock.wall.now(), want, hand, aborted: !!ctl?.aborted,
      chest: chestName(bot), held: bot.heldItem?.name || null, off: offName(bot), slot: bot.quickBarSlot,
      onGround: !!bot.entity?.onGround, vy: bot.entity?.velocity?.y, phase: bot._ndElytra?.phase
    }))
  }
  trace('begin')
  if (ctl?.aborted) return { ok: false, why: 'flight_superseded' }
  const isWanted = (n) => want === 'elytra' ? n === 'elytra' : /_chestplate$/.test(n || '')
  if (isWanted(chestName(bot))) return { ok: true, already: true }
  const item = want === 'elytra' ? (offName(bot) === 'elytra' ? bot.inventory.slots[45] : findItem(bot, 'elytra')) : (/_chestplate$/.test(offName(bot) || '') ? bot.inventory.slots[45] : bestChest(bot))
  if (!item) return { ok: false, why: want === 'elytra' ? 'элитр нет' : 'нагрудника нет' }
  try {
    if (hand === 'off') {
      if (bot.inventory.slots[45] !== item) await bot.equip(item, 'off-hand')
      if (ctl?.aborted) return { ok: false, why: 'flight_superseded' }
      trace('use')
      bot.activateItem(true)
    } else {
      const idx = await toHotbar(bot, (it) => !!it && it.name === item.name)
      if (ctl?.aborted) return { ok: false, why: 'flight_superseded' }
      if (idx < 0) { await bot.equip(item, 'hand') } else if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
      if (ctl?.aborted) return { ok: false, why: 'flight_superseded' }
      trace('use')
      bot.activateItem()
    }
    bot.usingHeldItem = false
  } catch (e) { return { ok: false, why: e.message } }
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < waitMs && !ctl?.aborted && !isWanted(chestName(bot))) await sleep(25)
  if (ctl?.aborted) return { ok: false, why: 'flight_superseded' }
  trace(isWanted(chestName(bot)) ? 'ack' : 'timeout')
  return isWanted(chestName(bot)) ? { ok: true, ms: gameClock.now() - t0 } : { ok: false, why: 'сервер не надел' }
}

export {
  findItem, countOf, offName, chestName, hotbarIndex, rocketCount, plainRocket, bestChest, hasElytra, wearingElytra, kit, KEEP, toHotbar, swapChest
}

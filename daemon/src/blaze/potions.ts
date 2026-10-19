'use strict'
import * as gameClock from '../game-clock'
import { sleep } from '../movement'

// minecraft-data 1.21.11 зовёт эффекты по-старому, в PascalCase
// (effectsByName.FireResistance, id 11 — совпадает с номером в пакете
// entity_effect); по snake_case там пусто, и проверка «зелье уже действует»
// молча отвечала «нет».
// Огнестойкость, выпитая самим телом, — по часам (16.10: в сценах у спавнера entity.effects тела пуст всегда — эффекта клиент не видит,
// а сервер его дал; цикл боя пил все зелья подряд и сгорал после первых 3 мин). Зелье огнестойкости — 3600 тиков (jar Potions:
// fire_resistance 3600), взрывное — то же.
function frByClock (bot) { return !!bot._ndFrUntil && gameClock.now() < bot._ndFrUntil }
function hasEffect (bot, name) {
  if (name === 'fire_resistance' && frByClock(bot)) return true
  try {
    const pascal = String(name).split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')
    const eff = bot.registry.effectsByName[name] || bot.registry.effectsByName[pascal]
    return !!(eff && bot.entity.effects && bot.entity.effects[eff.id])
  } catch { return false }
}

// Огнестойкость, если она есть: шар — это огонь, и под зельем он не жжёт
// вовсе (fireball в #is_fire). Пьём заранее, а не на половине хп.
// Есть ли зелье огнестойкости (обычное или взрывное) — для боя мечом (blaze-melee.ts).
function drinkable (bot) {
  const { potionOf }: typeof import('../pvp') = require('../pvp')
  return bot.inventory.items().some(i => /^(potion|splash_potion)$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || ''))
}
async function drinkFireResistance (bot, { renew = false }: any = {}) {
  if (hasEffect(bot, 'fire_resistance') && !renew) return 'уже действует'
  const { potionOf }: typeof import('../pvp') = require('../pvp')
  const pot = bot.inventory.items().find(i => i.name === 'potion' && /fire_resistance$/.test(potionOf(i) || ''))
  if (!pot) {
    // Взрывное из бартера (8 из 469, как и обычное): бросить себе под ноги —
    // в центре облака действие полное (ThrownPotion: 1 − расстояние/4).
    const splash = bot.inventory.items().find(i => i.name === 'splash_potion' && /fire_resistance$/.test(potionOf(i) || ''))
    if (!splash) return null
    try {
      await bot.equip(splash, 'hand')
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      bot.activateItem()
      await sleep(250)
      bot.deactivateItem()
      bot._ndFrUntil = gameClock.now() + 3600 * 50 - 2000
      return 'выпил fire_resistance'
    } catch (e) {
      return `взрывное не бросил: ${e.message}`
    }
  }
  try {
    const before = bot.inventory.items().filter(i => i.name === 'potion' && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
    await bot.equip(pot, 'hand')
    await bot.consume()
    const after = bot.inventory.items().filter(i => i.name === 'potion' && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
    if (after < before) bot._ndFrUntil = gameClock.now() + 3600 * 50 - 2000
    return 'выпил fire_resistance'
  } catch (e) {
    return `зелье не выпил: ${e.message}`
  }
}

export { hasEffect, drinkable, drinkFireResistance }

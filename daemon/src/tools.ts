'use strict'
// Чем ломать — по правилам самой игры, а не по таблице «на глаз». У каждого
// блока в minecraft-data есть твёрдость и материал (mineable/pickaxe, /axe,
// /shovel, /hoe, меч — паутина, ножницы — шерсть и листва), а
// prismarine-block.digTime считает время ровно как клиент
// (AbstractBlock#calcBlockBreakingDelta: инструмент подходящего материала —
// его множитель, иначе 1; «эффективность», спешка, усталость, вода, прыжок;
// делитель 30, если блок снимается этим предметом, и 100 — если нет: обсидиан
// без алмазной кирки ломается 250 с, а с ней — 9.4). Здесь — перебрать всё,
// что в рюкзаке, и взять самое быстрое; в бою это решает, чем вскрывать
// укрытие и какой блок в нём самый слабый.

import { withTimeout } from './build'
import { conserveTool } from './items'

const TOOL = /_(pickaxe|axe|shovel|hoe|sword)$|^shears$/

// Что вообще ломается. Воздух, бедрок, барьер, порталы — diggable: false или
// твёрдость −1; вода и лава в данных diggable с твёрдостью 100 — их не
// сломать, только вычерпать. Паутина без коллизии (boundingBox 'empty'), но
// ломается: твёрдость 4, меч и ножницы ×15 и снимают её — 8 тиков (0.4 с),
// рукой и любым блоком — 400 тиков (20 с). Раньше всё без коллизии считалось
// «не ломается»: время резки паутины выходило бесконечным, и бот в паутине
// рядом с противником не резал её и не смывал (арена 2026-09-26).
const FLUID = /^(water|lava|bubble_column)$/
function breakable (block) {
  return !!block && block.diggable !== false && block.hardness != null && block.hardness >= 0 && !FLUID.test(block.name)
}
// Клетка свободна: ломать нечего (воздух, вода, лава, портал).
const clear = (b) => !b || (b.boundingBox === 'empty' && !breakable(b))

// Сколько миллисекунд ломать block предметом item (null — рукой).
function digMs (bot, block, item) {
  try {
    return block.digTime(
      item ? item.type : null,
      false,
      !!(bot.entity && bot.entity.isInWater),
      !(bot.entity && bot.entity.onGround),
      item && item.enchants ? item.enchants : [],
      (bot.entity && bot.entity.effects) || {}
    )
  } catch {
    return Infinity
  }
}

// Лучший предмет для блока: { item (null — рука), ms, harvest }.
function bestFor (bot, block) {
  if (!breakable(block)) return { item: null, ms: Infinity, unbreakable: true }
  let best = { item: null, ms: digMs(bot, block, null) }
  // Каждый предмет отдельно, не по имени: две алмазные кирки с разной
  // «Эффективностью» (арена с чарами) — разные инструменты.
  for (const it of bot.inventory.items()) {
    if (!TOOL.test(it.name)) continue
    if (/_sword$/.test(it.name) && !/^(cobweb|bamboo|bamboo_sapling)$/.test(block.name)) continue
    // Ограничение на время работы (штрек по Аду, бастион): железную кирку — только для золота и того,
    // что каменная не добывает; иначе обёртка bot.dig брала железную как более быструю (ревью Codex 30.09).
    if (bot._ndToolFilter && !bot._ndToolFilter(it, block)) continue
    const ms = digMs(bot, block, it)
    if (ms < best.ms) best = { item: it, ms }
  }
  const reserved = conserveTool(bot, block, best.item)
  if (reserved !== best.item) best = { item: reserved, ms: digMs(bot, block, reserved) }
  let harvest = false
  try { harvest = block.canHarvest(best.item ? best.item.type : null) } catch {}
  return { ...best, harvest }
}

// Из нескольких блоков — самый быстрый для нас (для осады: ломать не
// обсидиан, а булыжник рядом).
function weakest (bot, positions) {
  let out = null
  for (const pos of positions) {
    const b = bot.blockAt(pos)
    if (!b || b.boundingBox !== 'block') continue
    const plan = bestFor(bot, b)
    if (!out || plan.ms < out.ms) out = { pos, block: b, ...plan }
  }
  return out
}

// Сломать блок самым быстрым, что есть. Возвращает { ok, ms, tool }.
async function breakFast (bot, pos, { maxMs = 8000 }: any = {}) {
  const b = bot.blockAt(pos)
  if (clear(b)) return { ok: true, ms: 0 }
  const plan = bestFor(bot, b)
  if (plan.unbreakable || plan.ms > maxMs) return { ok: false, ms: plan.ms, tool: plan.item ? plan.item.name : 'рука', why: 'слишком долго' }
  if (plan.item && (!bot.heldItem || bot.heldItem.name !== plan.item.name)) {
    try { await bot.equip(plan.item, 'hand') } catch {}
  }
  try { await withTimeout(bot.dig(b, true), plan.ms + 1500) } catch {}
  return { ok: clear(bot.blockAt(pos)), ms: Math.round(plan.ms), tool: plan.item ? plan.item.name : 'рука' }
}

// Самое быстрое для блока — в руку, если в руке медленнее. Правило то же,
// что у игрока: ломать тем, что ломает быстро (паутину мечом, а не блоком,
// который остался в руке после столба: живая арена 2026-09-26, бот ковырял
// паутину булыжником 20 с, стоя в лаве, и сгорел). В руке уже не хуже —
// ничего не трогаем: лишняя смена предмета сбрасывает заряд удара.
async function equipFastest (bot, block) {
  if (block?.name === 'tripwire' && bot.heldItem?.name === 'shears') return bot.heldItem
  if (!breakable(block) || !bot.inventory) return null
  const plan = bestFor(bot, block)
  if (!plan.item) {
    if (bot.heldItem?.maxDurability) {
      const safe = bot.inventory.items().find(i => !i.maxDurability)
      if (safe) await bot.equip(safe, 'hand')
      else await bot.unequip('hand')
    }
    return null
  }
  const held = bot.heldItem
  if (held && held.slot === plan.item.slot) return held
  if (held && conserveTool(bot, block, held) === held && !/_sword$/.test(held.name) && digMs(bot, block, held) <= plan.ms) return held
  await bot.equip(plan.item, 'hand')
  return plan.item
}

// Любая копка тела — лучшим инструментом: pathfinder, столб (build.towerUp),
// ремесло, бой — всё идёт через bot.dig, и mineflayer копает тем, что в руке.
// Обёртка ставится один раз на тело (session.js).
//
// Копка, пережившая смерть, вешала pathfinder навсегда (регрессия спуска 30.09, ферма mlg-leaves-1/2 и mlg-reg-probe6):
// mineflayer-pathfinder держит свой флаг digging, пока промис bot.dig не кончится, а на новом месте после
// возрождения он доигрывал старый путь — копка блока в 3000 блоках (чанк выгружен, _updateBlockState молчит)
// не кончается никогда, и каждый следующий goto стоит «застрял на air у air», isMining() = true. Поэтому:
// блок дальше досягаемости не копается (сразу отказ), а смерть обрывает копку (отказ, pathfinder сбрасывает путь).
const DIG_REACH = 7
function install (bot) {
  if (!bot || bot._ndFastDig || typeof bot.dig !== 'function') return
  const raw = bot.dig
  bot._ndFastDig = true
  bot.dig = async function (block, forceLook, digFace, ctl = null) {
    const me = bot.entity && bot.entity.position
    if (block && block.position && me && me.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5)) > DIG_REACH) {
      throw new Error(`Digging aborted: блок ${block.position} вне досягаемости`)
    }
    if (ctl?.aborted) throw new Error('прервано')
    try { await equipFastest(bot, block) } catch {}
    if (ctl?.aborted) throw new Error('прервано')
    let onDeath = null
    const death = new Promise<any>((resolve, reject) => { onDeath = () => reject(new Error('Digging aborted: смерть')); if (typeof bot.once === 'function') bot.once('death', onDeath) })
    try {
      return await Promise.race([raw.call(bot, block, forceLook, digFace), death])
    } finally {
      try { bot.removeListener('death', onDeath) } catch {}
    }
  }
}

// Флаг копки pathfinder'а остался от копки, которой уже нет (bot.targetDigBlock пуст): сбросить путь (resetPath
// вешает свой сброс флага на diggingAborted) и отдать это событие. Зовётся при возрождении (session.wire).
function unstickPathfinderDig (bot) {
  try {
    if (!bot || !bot.pathfinder || typeof bot.pathfinder.isMining !== 'function' || !bot.pathfinder.isMining() || bot.targetDigBlock) return false
    bot.pathfinder.setGoal(null)
    bot.emit('diggingAborted', null)
    return !bot.pathfinder.isMining()
  } catch { return false }
}

export { breakable, digMs, bestFor, weakest, breakFast, equipFastest, install, unstickPathfinderDig, DIG_REACH }

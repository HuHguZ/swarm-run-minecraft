'use strict'
// Подготовка к бою из сырья: брёвна, слитки, алмазы → доски, палки, верстак,
// меч, броня, щит, кирка. Рецепты — из самой игры (mineflayer recipesFor по
// minecraft-data), здесь только порядок и выбор материала: из чего хватит на
// лучшее. Верстак ставится один раз и всё крафтится за ним — actions.craft
// ставит и забирает верстак на каждую вещь, в бою на это нет времени.
//
// Тактики:
//   rush — доски, палки, верстак, лучший меч — и в бой, пока он ещё крафтит;
//   full — всё: меч, топор (щит ломать), нагрудник, поножи, шлем, ботинки, щит,
//          кирка (вскрывать коробки), лук, если есть нитки;
//   smart — меч и нагрудник (самое ценное за слиток), дальше по обстановке:
//          если он уже идёт на нас — в бой, иначе докрафтить остальное.

const Vec3 = require('vec3')
const { placeBlockAt, withTimeout } = require('./build')
const { sleep } = require('./movement')

const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']

function count (bot, name) {
  return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
}
function has (bot, re) {
  return bot.inventory.items().some(i => re.test(i.name))
}

// Окно верстака на 1.21.11 открывается не всегда с первого раза — тычем ещё
// (та же причина, что в actions.craftWithNudge).
function craftAt (bot, recipe, times, table) {
  if (!table) return bot.craft(recipe, times, null)
  let done = false
  const work = bot.craft(recipe, times, table)
  work.then(() => { done = true }, () => { done = true })
  ;(async () => {
    for (const ms of [2500, 2500, 3000]) {
      await sleep(ms)
      if (done || bot.currentWindow) return
      try { await bot.activateBlock(table) } catch {}
    }
  })().catch(() => {})
  return work
}

async function closeWindow (bot) {
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
}

async function craftOne (bot, mcData, name, times, table) {
  const it = mcData.itemsByName[name]
  if (!it) return false
  const recipes = bot.recipesFor(it.id, null, 1, table || null)
  if (!recipes.length) return false
  try {
    await withTimeout(craftAt(bot, recipes[0], times, table), 12000, `крафт ${name} завис`)
    return true
  } catch {
    return false
  } finally {
    await closeWindow(bot)
  }
}

// Все брёвна — в доски (тип доски — от бревна).
async function logsToPlanks (bot, mcData) {
  let made = 0
  for (const log of bot.inventory.items().filter(i => /_log$|_stem$/.test(i.name))) {
    const wood = log.name.replace(/_log$|_stem$/, '')
    const planks = `${wood}_planks`
    if (!mcData.itemsByName[planks]) continue
    if (await craftOne(bot, mcData, planks, log.count, null)) made += log.count * 4
  }
  return made
}

function planksCount (bot) {
  return bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((n, i) => n + i.count, 0)
}

async function ensureSticks (bot, mcData, need) {
  if (count(bot, 'stick') >= need) return true
  const times = Math.ceil((need - count(bot, 'stick')) / 4)
  return craftOne(bot, mcData, 'stick', times, null)
}

// Верстак — в соседнюю клетку на уровне ног (с той стороны, где не мешает).
async function placeTable (bot, mcData) {
  const near = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 3 })
  if (near) return near
  if (!count(bot, 'crafting_table')) {
    if (!(await craftOne(bot, mcData, 'crafting_table', 1, null))) return null
  }
  const me = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const at = me.offset(dx, 0, dz)
    const r = await placeBlockAt(bot, at, { item: 'crafting_table', timeoutMs: 1500 })
    if (r.ok) {
      await sleep(150)
      const b = bot.blockAt(at)
      if (b && b.name === 'crafting_table') return b
    }
  }
  return null
}

// Лучшее, на что хватает: перебор уровней от лучшего к худшему.
async function craftBest (bot, mcData, kind, table, tiers = TIERS) {
  for (const t of tiers) {
    const name = `${t}_${kind}`
    if (!mcData.itemsByName[name]) continue
    if (bot.inventory.items().some(i => i.name === name)) return name
    if (await craftOne(bot, mcData, name, 1, table)) return name
  }
  return null
}

const PLANS = {
  rush: ['sword'],
  smart: ['sword', 'chestplate', 'leggings', 'helmet', 'boots', 'shield', 'axe', 'pickaxe'],
  full: ['sword', 'chestplate', 'leggings', 'helmet', 'boots', 'shield', 'axe', 'pickaxe', 'bow']
}

// shouldStop() — пора бросать крафт и драться (он пришёл, нас бьют).
async function prepare (session, ctl, { strategy = 'full', shouldStop = null } = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = Date.now()
  const made = []
  const stop = () => ctl.aborted || (shouldStop && shouldStop())
  const mark = (what) => made.push({ what, s: Math.round((Date.now() - t0) / 100) / 10 })

  await closeWindow(bot)
  const planks = await logsToPlanks(bot, mcData)
  if (planks) mark(`доски ×${planks}`)
  if (stop()) return { strategy, made, stopped: true, seconds: (Date.now() - t0) / 1000 }
  await ensureSticks(bot, mcData, 6)
  const table = await placeTable(bot, mcData)
  if (table) mark('верстак')

  // Кристаллы Края (2026-09-30, крафт-режим арены): 7 стекла вокруг, око Края в
  // середине, слеза гаста под ним — на верстаке; сколько хватит. Есть сырьё —
  // сразу после меча: в этом наборе кристалл — главное оружие (crystal.js), и
  // «он уже идёт» (shouldStop) их не отменяет — только удар (ctl).
  let crystalsDone = false
  const crystals = async () => {
    if (crystalsDone) return
    crystalsDone = true
    const n = Math.min(Math.floor(count(bot, 'glass') / 7), count(bot, 'ender_eye'), count(bot, 'ghast_tear'))
    // По одному и с повтором: первый крафт в только что открытом окне верстака
    // падает «missing ingredient» (окно не успело прийти, проба
    // farm/crystal/craft-probe.js 2026-09-30), второй — проходит.
    let made = 0
    for (let fails = 0; made < n && fails < 3 && !ctl.aborted;) {
      if (await craftOne(bot, mcData, 'end_crystal', 1, table)) made++
      else { fails++; await sleep(250) }
    }
    if (made) mark(`end_crystal ×${count(bot, 'end_crystal')}`)
  }
  for (const kind of PLANS[strategy] || PLANS.full) {
    if (kind !== 'sword' && table && !ctl.aborted) await crystals()
    if (stop()) break
    // smart: после брони посмотреть, не идёт ли он уже — тогда в бой.
    if (strategy === 'smart' && ['shield', 'axe', 'pickaxe'].includes(kind) && shouldStop && shouldStop('soon')) break
    if (['sword', 'axe', 'pickaxe'].includes(kind)) await ensureSticks(bot, mcData, 2)
    let got = null
    if (kind === 'shield') got = (await craftOne(bot, mcData, 'shield', 1, table)) ? 'shield' : null
    else if (kind === 'bow') got = count(bot, 'string') >= 3 && (await ensureSticks(bot, mcData, 3)) && (await craftOne(bot, mcData, 'bow', 1, table)) ? 'bow' : null
    else got = await craftBest(bot, mcData, kind, table, ['helmet', 'chestplate', 'leggings', 'boots'].includes(kind) ? ARMOR_TIERS : TIERS)
    if (got) mark(got)
  }
  if (!ctl.aborted && table) await crystals()
  await closeWindow(bot)
  // Надеть броню и щит — это делает бой (armor, guard.wear), но надеть сразу
  // дешевле: первый удар в бою уже по броне.
  try { await require('./armor').equipBestArmor(session, ctl, { confirmMs: 300 }) } catch {}
  return {
    strategy,
    made,
    stopped: stop() || undefined,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    planksLeft: planksCount(bot) || undefined
  }
}

module.exports = { prepare, PLANS }

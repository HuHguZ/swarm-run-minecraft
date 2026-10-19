'use strict'
import * as gameClock from './game-clock'
// Зелья: варочная стойка, огненный порошок, бутылки с водой, адский нарост →
// «неловкое», дальше то, что нужно для прохождения. Рецепты — из самой игры:
// PotionBrewing.addVanillaMixes (paper-1.21.11), см. SPEEDRUN.md «Зелья».
//
//   BrewingStandBlockEntity: FUEL_USES = 20 (1 порошок = 20 варок), варка 400
//     тиков = 20 с; клетки окна 0-2 бутылки, 3 ингредиент, 4 топливо.
//   addStartMix(X, P): вода + X → «банальное» (бесполезно), неловкое + X → P.
//   Редстоун продлевает, светопыль усиливает (не у всех), порох — во взрывное.
//
// Бот варит партиями по 3 бутылки: один ингредиент и одна единица топлива на
// шаг — на 3 бутылки столько же, сколько на одну.

import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from './movement'
import { withTimeout } from './build'
import actions = require('./actions')
import { countOf } from './items'

// ------------------------------------------------------------ рецепты

// зелье: [основа, ингредиент] — addMix/addStartMix из байткода.
const MIX = {
  awkward: ['water', 'nether_wart'],
  mundane: ['water', 'redstone'],
  thick: ['water', 'glowstone_dust'],
  night_vision: ['awkward', 'golden_carrot'], long_night_vision: ['night_vision', 'redstone'],
  invisibility: ['night_vision', 'fermented_spider_eye'], long_invisibility: ['invisibility', 'redstone'],
  fire_resistance: ['awkward', 'magma_cream'], long_fire_resistance: ['fire_resistance', 'redstone'],
  leaping: ['awkward', 'rabbit_foot'], long_leaping: ['leaping', 'redstone'], strong_leaping: ['leaping', 'glowstone_dust'],
  swiftness: ['awkward', 'sugar'], long_swiftness: ['swiftness', 'redstone'], strong_swiftness: ['swiftness', 'glowstone_dust'],
  slowness: ['swiftness', 'fermented_spider_eye'], long_slowness: ['slowness', 'redstone'], strong_slowness: ['slowness', 'glowstone_dust'],
  turtle_master: ['awkward', 'turtle_helmet'],
  water_breathing: ['awkward', 'pufferfish'], long_water_breathing: ['water_breathing', 'redstone'],
  healing: ['awkward', 'glistering_melon_slice'], strong_healing: ['healing', 'glowstone_dust'],
  harming: ['healing', 'fermented_spider_eye'], strong_harming: ['harming', 'glowstone_dust'],
  poison: ['awkward', 'spider_eye'], long_poison: ['poison', 'redstone'], strong_poison: ['poison', 'glowstone_dust'],
  regeneration: ['awkward', 'ghast_tear'], long_regeneration: ['regeneration', 'redstone'], strong_regeneration: ['regeneration', 'glowstone_dust'],
  strength: ['awkward', 'blaze_powder'], long_strength: ['strength', 'redstone'], strong_strength: ['strength', 'glowstone_dust'],
  weakness: ['water', 'fermented_spider_eye'], long_weakness: ['weakness', 'redstone'],
  slow_falling: ['awkward', 'phantom_membrane'], long_slow_falling: ['slow_falling', 'redstone']
}

// Длительность в секундах (Potions.java, тики/20) и зачем зелье для прохождения.
const USE = {
  fire_resistance: [180, 'Ад: лава, огонь, огненные шары гастов и ифритов — не горишь вовсе. Пить ДО крепости и бастиона'],
  long_fire_resistance: [480, 'то же на 8 минут — на весь поход за стержнями'],
  strength: [180, '+3 урона каждому удару: дракон, иссушители, бастион'],
  long_strength: [480, 'сила на 8 минут'], strong_strength: [90, 'сила II: +6 урона'],
  healing: [0, 'мгновенно +4 сердца (II: +8); взрывное — бросить под ноги в бою'],
  strong_healing: [0, 'мгновенно +8 сердец'],
  regeneration: [45, 'лечит в бою ~9 сердец за 45 с'], long_regeneration: [90, 'регенерация 90 с'], strong_regeneration: [22, 'быстрая регенерация'],
  slow_falling: [90, 'Энд: дракон подбрасывает, падение с колонн, прыжок в портал без урона'],
  long_slow_falling: [240, 'медленное падение 4 минуты'],
  swiftness: [180, '+20% скорости: догнать, убежать, быстрее по Аду'], long_swiftness: [480, 'скорость 8 минут'], strong_swiftness: [90, 'скорость II'],
  night_vision: [180, 'видно в темноте и под водой'], long_night_vision: [480, 'ночное зрение 8 минут'],
  invisibility: [180, 'мобы не видят (броня видна)'], water_breathing: [180, 'дышать под водой'],
  leaping: [180, 'прыжок выше'], turtle_master: [20, 'сопротивление III, но медленно'],
  weakness: [90, 'лечение зомби-жителя (с золотым яблоком)'],
  harming: [0, 'урон; нежить лечит'], poison: [45, 'яд на врага']
}

// Где брать — одна строка на ингредиент.
const WHERE = {
  nether_wart: 'Ад: у лестниц крепости Ада и в бастионах, растёт на песке душ',
  blaze_rod: 'ифриты в крепости Ада',
  blaze_powder: 'стержень ифрита → 2 порошка (он же топливо стойки: 1 = 20 варок)',
  magma_cream: 'кубы магмы в Аду или крафт: огненный порошок + слизь',
  slime_ball: 'слизни (болота ночью)',
  glistering_melon_slice: 'крафт: ломтик арбуза + 8 золотых самородков',
  melon_slice: 'арбузы (джунгли, деревни)',
  gold_nugget: 'слиток золота → 9 самородков, зомби-пиглины',
  ghast_tear: 'гасты в Аду (слеза часто падает в лаву)',
  sugar: 'тростник → сахар',
  sugar_cane: 'у воды',
  phantom_membrane: 'фантомы (не спать 3+ ночи)',
  golden_carrot: 'морковь + 8 золотых самородков',
  fermented_spider_eye: 'крафт: глаз паука + бурый гриб + сахар',
  spider_eye: 'пауки, ведьмы',
  redstone: 'редстоун-руда (ниже y 16), ведьмы — продлевает',
  glowstone_dust: 'светокамень в Аду (с блока 2-4 пыли) — усиливает',
  gunpowder: 'криперы, гасты — делает взрывным',
  glass_bottle: '3 стекла → 3 бутылки; стекло — песок в печи',
  rabbit_foot: 'кролики', pufferfish: 'рыбалка', turtle_helmet: 'черепаший щиток',
  brewing_stand: 'стержень ифрита + 3 булыжника'
}

// Цепочка ингредиентов от воды: fire_resistance → [nether_wart, magma_cream].
function chainOf (potion) {
  const steps = []
  let p = potion
  for (let i = 0; i < 6 && p !== 'water'; i++) {
    const m = MIX[p]
    if (!m) return null
    steps.unshift(m[1])
    p = m[0]
  }
  return p === 'water' ? steps : null
}

// Имя зелья из запроса: «огнестойкость», fire_res, long_fire_resistance…
const ALIAS = {
  fire_res: 'fire_resistance', fire: 'fire_resistance', 'огнестойкость': 'fire_resistance',
  'сила': 'strength', 'лечение': 'healing', heal: 'healing', 'исцеление': 'healing', regen: 'regeneration', 'регенерация': 'regeneration',
  'медленное_падение': 'slow_falling', 'скорость': 'swiftness', speed: 'swiftness', 'ночное_зрение': 'night_vision'
}
function resolvePotion (name) {
  const n = String(name || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  return MIX[n] ? n : ALIAS[n] || null
}

// ------------------------------------------------------------ предметы

function potionName (item) {
  if (!item || !/potion$/.test(item.name)) return null
  try { return (require('./pvp') as typeof import('./pvp')).potionOf(item) } catch { return null }
}
const isWaterBottle = i => i && i.name === 'potion' && potionName(i) === 'water'
function countPotions (bot, name, container = 'potion') {
  return bot.inventory.items().filter(i => i.name === container && potionName(i) === name).length
}

// ------------------------------------------------------------ окна (как в enchant.js)

async function closeAny (bot) {
  const w = bot.currentWindow
  if (!w) return
  try { if (typeof w.close === 'function') w.close(); else bot.closeWindow(w) } catch {}
  await sleep(250)
}
async function openStand (bot, block) {
  let last = null
  for (let i = 0; i < 3; i++) {
    await closeAny(bot)
    let gaveUp = false
    const opening = bot.openBlock(block)
    opening.then(w => { if (gaveUp && bot.currentWindow === w) { try { w.close() } catch {} } }, () => {})
    try {
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
      return await withTimeout(opening, 6000, 'стойка не открылась')
    } catch (e) { gaveUp = true; last = e; await sleep(400) }
  }
  throw last
}
async function click (bot, slot, button = 0) { await bot.clickWindow(slot, button, 0) }
// Номер клетки берём ДО клика: prismarine-windows переписывает item.slot.
async function putOne (bot, win, item, dest) {
  const src = item.slot
  await click(bot, src)
  await click(bot, dest, 1)
  if (win.selectedItem) await click(bot, src)
  await sleep(120)
}
async function takeOut (bot, win, slot) {
  if (!win.slots[slot]) return false
  try { await bot.putAway(slot); return true } catch { return false }
}

// ------------------------------------------------------------ вода

function findWater (bot, mcData, r = 24) {
  const id = mcData.blocksByName.water.id
  const all = bot.findBlocks({ matching: id, maxDistance: r, count: 40 })
  const me = bot.entity.position
  const src = all.map(p => bot.blockAt(p)).filter(b => b && b.getProperties && String(b.getProperties().level) === '0')
  src.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
  return src[0] || null
}

// Наполнить бутылки: смотреть на источник воды и «использовать» бутылку.
// Проба 2026-09-25: activateItem, глядя на воду, — +1 бутылка воды.
async function fillBottles (session, ctl, want, lines) {
  const bot = session.bot
  const mcData = session.mcData
  const have = () => bot.inventory.items().filter(isWaterBottle).length
  if (have() >= want) return have()
  let water = findWater(bot, mcData)
  let placed = null
  if (!water && countOf(bot, 'water_bucket')) {
    // Своя лужа: вылить ведро рядом, набрать, забрать обратно.
    const me = bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const floor = bot.blockAt(me.offset(dx, -1, dz))
      const cell = bot.blockAt(me.offset(dx, 0, dz))
      if (!floor || !cell || floor.boundingBox !== 'block' || cell.boundingBox !== 'empty') continue
      try {
        await bot.equip(bot.inventory.items().find(i => i.name === 'water_bucket'), 'hand')
        await bot.lookAt(floor.position.offset(0.5, 1, 0.5), true)
        bot.activateItem()
        await sleep(500)
      } catch {}
      const w = bot.blockAt(me.offset(dx, 0, dz))
      if (w && w.name === 'water') { water = w; placed = w.position; break }
    }
  }
  if (!water) throw new Error('воды рядом нет (24 блока) и ведра с водой нет — бутылки наполнить нечем')
  try {
    if (bot.entity.position.distanceTo(water.position) > 3.5) {
      try {
        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(water.position.x, water.position.y + 1, water.position.z, 2)), 15000, 'до воды не дошёл')
      } catch {} finally { try { bot.pathfinder.setGoal(null) } catch {} }
    }
    let tries = 0
    while (have() < want && tries < want * 3 && !ctl.aborted) {
      tries++
      const bottle = bot.inventory.items().find(i => i.name === 'glass_bottle')
      if (!bottle) break
      const before = have()
      try {
        await bot.equip(bottle, 'hand')
        await bot.lookAt(water.position.offset(0.5, 0.85, 0.5), true)
        bot.activateItem()
        await sleep(250)
        bot.deactivateItem()
      } catch {}
      for (let t = 0; t < 10 && have() <= before; t++) await sleep(80)
    }
  } finally {
    if (placed) {
      try {
        const bucket = bot.inventory.items().find(i => i.name === 'bucket')
        if (bucket) {
          await bot.equip(bucket, 'hand')
          await bot.lookAt(placed.offset(0.5, 0.5, 0.5), true)
          bot.activateItem()
          await sleep(400)
        }
      } catch {}
    }
  }
  const n = have()
  if (n < want) lines.push(`⚠ бутылок с водой ${n} из ${want}`)
  return n
}

// ------------------------------------------------------------ подготовка

// Порциями и с паузой: рюкзак после окна верстака сверяется не сразу
// (invsync), а серию крафтов mineflayer на 1.21.11 рвёт на середине.
async function craftUpTo (session, ctl, name, want) {
  const bot = session.bot
  let error = null
  for (let i = 0; i < 8 && !ctl.aborted; i++) {
    const have = countOf(bot, name)
    if (have >= want) break
    try {
      await actions.craft(session, ctl, { item: name, count: want - have, spendReserve: true })
      error = null
    } catch (e) { error = e.message }
    await sleep(700)
    if (countOf(bot, name) <= have) break
  }
  const have = countOf(bot, name)
  return { have, error: have >= want ? undefined : error || undefined }
}

// Стойка, бутылки, наковальня — рецепты 3x3: нужен верстак. actions.craft
// ставит его сам, но только из досок; бревно в доски он не переводит («для
// brewing_stand нужен верстак, а его нет» при бревне в рюкзаке — прогон
// try-brew). Четыре доски из бревна, если верстака нет ни рядом, ни с собой.
async function readyPlanks (session, ctl) {
  const bot = session.bot
  const mcData = session.mcData
  if (countOf(bot, 'crafting_table')) return true
  if (bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 6 })) return true
  const planks = bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  if (planks >= 4) return true
  const log = bot.inventory.items().find(i => /_(log|stem)$/.test(i.name) && mcData.itemsByName[i.name.replace(/_(log|stem)$/, '_planks')])
  if (!log) return false
  try {
    await actions.craft(session, ctl, { item: log.name.replace(/_(log|stem)$/, '_planks'), count: 4, spendReserve: true })
    return true
  } catch { return false }
}

// Что нужно на заказ: ингредиенты по шагам, порошок на топливо, бутылки.
function needsFor (steps, batches, bottles, { standFuel = 0, haveStand = false }: any = {}) {
  const need = {}
  const add = (k, n) => { need[k] = (need[k] || 0) + n }
  for (const s of steps) add(s, batches)
  const uses = steps.length * batches
  const powders = Math.max(0, Math.ceil((uses - standFuel) / 20))
  if (powders) add('blaze_powder', powders)
  if (!haveStand) add('brewing_stand', 1)
  add('water_bottle', bottles)
  return need
}

// Докрафтить промежуточное: порошок, сливки, дыня, сахар, бутылки, стойку.
async function prepare (session, ctl, need, lines) {
  const bot = session.bot
  const rodsNeededForStand = need.brewing_stand && !countOf(bot, 'brewing_stand') ? 1 : 0
  if ((rodsNeededForStand && countOf(bot, 'blaze_rod')) || need.water_bottle) await readyPlanks(session, ctl)
  if (rodsNeededForStand && countOf(bot, 'blaze_rod')) {
    const r = await craftUpTo(session, ctl, 'brewing_stand', 1)
    if (r.error) lines.push(`⚠ стойку не скрафтил: ${r.error}`)
  }
  // Сливки тоже из порошка — считаем его вместе.
  const cream = Math.max(0, (need.magma_cream || 0) - countOf(bot, 'magma_cream'))
  const powderWant = (need.blaze_powder || 0) + Math.min(cream, countOf(bot, 'slime_ball'))
  if (countOf(bot, 'blaze_powder') < powderWant && countOf(bot, 'blaze_rod')) {
    await craftUpTo(session, ctl, 'blaze_powder', powderWant)
  }
  if (cream && countOf(bot, 'slime_ball')) await craftUpTo(session, ctl, 'magma_cream', need.magma_cream)
  if (need.glistering_melon_slice && countOf(bot, 'glistering_melon_slice') < need.glistering_melon_slice) {
    const want = need.glistering_melon_slice - countOf(bot, 'glistering_melon_slice')
    if (countOf(bot, 'gold_nugget') < 8 * want && countOf(bot, 'gold_ingot')) {
      await craftUpTo(session, ctl, 'gold_nugget', 8 * want)
    }
    await craftUpTo(session, ctl, 'glistering_melon_slice', need.glistering_melon_slice)
  }
  if (need.golden_carrot && countOf(bot, 'golden_carrot') < need.golden_carrot) {
    if (countOf(bot, 'gold_nugget') < 8 && countOf(bot, 'gold_ingot')) await craftUpTo(session, ctl, 'gold_nugget', 8)
    await craftUpTo(session, ctl, 'golden_carrot', need.golden_carrot)
  }
  if (need.sugar && countOf(bot, 'sugar') < need.sugar && countOf(bot, 'sugar_cane')) await craftUpTo(session, ctl, 'sugar', need.sugar)
  if (need.fermented_spider_eye && countOf(bot, 'fermented_spider_eye') < need.fermented_spider_eye) {
    if (!countOf(bot, 'sugar') && countOf(bot, 'sugar_cane')) await craftUpTo(session, ctl, 'sugar', 1)
    await craftUpTo(session, ctl, 'fermented_spider_eye', need.fermented_spider_eye)
  }
  // Бутылки: стекло → бутылки (3 стекла = 3 бутылки), песок → стекло в печи.
  const water = bot.inventory.items().filter(isWaterBottle).length
  const bottlesShort = Math.max(0, (need.water_bottle || 0) - water - countOf(bot, 'glass_bottle'))
  if (bottlesShort > 0) {
    const glassWant = Math.ceil(bottlesShort / 3) * 3
    if (countOf(bot, 'glass') < glassWant && countOf(bot, 'sand') + countOf(bot, 'red_sand') > 0) {
      try {
        const smelt = (require('./containers') as typeof import('./containers')).smelt
        await smelt(session, ctl, { item: 'glass', count: glassWant - countOf(bot, 'glass'), timeoutSeconds: 90 })
      } catch (e) { lines.push(`⚠ стекло не выплавил: ${e.message}`) }
    }
    if (countOf(bot, 'glass') >= 3) await craftUpTo(session, ctl, 'glass_bottle', countOf(bot, 'glass_bottle') + Math.min(bottlesShort, Math.floor(countOf(bot, 'glass') / 3) * 3))
  }
}

function missingOf (bot, need, { haveStand }: any) {
  const miss = []
  for (const [k, n] of (Object.entries(need) as [string, any][])) {
    if (k === 'water_bottle') {
      const have = bot.inventory.items().filter(isWaterBottle).length + countOf(bot, 'glass_bottle')
      if (have < n) miss.push({ what: 'glass_bottle', count: n, have, where: WHERE.glass_bottle })
      continue
    }
    if (k === 'brewing_stand') {
      if (!haveStand && !countOf(bot, 'brewing_stand')) miss.push({ what: 'brewing_stand', count: 1, have: 0, where: WHERE.brewing_stand })
      continue
    }
    const have = countOf(bot, k)
    if (have < n) miss.push({ what: k, count: n, have, where: WHERE[k] || '' })
  }
  return miss
}

// ------------------------------------------------------------ варка

function findStand (bot, mcData, r = 16) {
  return bot.findBlock({ matching: mcData.blocksByName.brewing_stand.id, maxDistance: r })
}

function watchProps (bot, win) {
  const st: any = { props: {}, at: 0 }
  const on = p => { if (p.windowId !== win.id) return; st.props[p.property] = p.value; st.at = gameClock.now() }
  bot._client.on('craft_progress_bar', on)
  st.stop = () => bot._client.removeListener('craft_progress_bar', on)
  return st
}

// Шаг варки: ингредиент в клетку 3 и ждать, пока зелья в 0-2 сменятся.
async function brewStep (bot, win, st, ingredient, ctl) {
  const it = win.items().find(i => i.name === ingredient)
  if (!it) throw new Error(`нет ${ingredient}`)
  const sig = () => [0, 1, 2].map(s => win.slots[s] ? `${win.slots[s].name}:${potionName(win.slots[s])}` : '-').join('|')
  const before = sig()
  await putOne(bot, win, it, 3)
  const t0 = gameClock.now()
  let started = false
  while (gameClock.now() - t0 < 30000 && !ctl.aborted) {
    if ((st.props[0] || 0) > 0) started = true
    if (sig() !== before) return { seconds: Math.round((gameClock.now() - t0) / 1000) }
    // Три секунды без отсчёта — стойка этот ингредиент не берёт.
    if (!started && gameClock.now() - t0 > 3500) {
      await takeOut(bot, win, 3)
      throw new Error(`стойка не варит ${ingredient} с тем, что в бутылках (${before})`)
    }
    await sleep(200)
  }
  throw new Error(ctl.aborted ? 'прервано посреди варки' : `варка ${ingredient} не закончилась за 30 с`)
}

async function brewBatch (session, ctl, stand, steps, n, lines) {
  const bot = session.bot
  const win = await openStand(bot, stand)
  const st: any = watchProps(bot, win)
  const log = []
  try {
    await sleep(300)
    // Топливо: порошок в клетку 4, если заряда не хватит на все шаги.
    const fuelUses = st.props[1] || 0
    if (fuelUses < steps.length && !win.slots[4]) {
      const powder = win.items().find(i => i.name === 'blaze_powder')
      if (!powder) throw new Error('нет огненного порошка на топливо')
      await putOne(bot, win, powder, 4)
    }
    // Чужое в бутылочных клетках — забрать.
    for (const s of [0, 1, 2, 3]) {
      const it = win.slots[s]
      if (it && !(s < 3 && isWaterBottle(it))) await takeOut(bot, win, s)
    }
    let put = [0, 1, 2].filter(s => isWaterBottle(win.slots[s])).length
    for (const s of [0, 1, 2]) {
      if (put >= n) break
      if (win.slots[s]) continue
      const b = win.items().find(isWaterBottle)
      if (!b) break
      await putOne(bot, win, b, s)
      put++
    }
    if (!put) throw new Error('нет бутылок с водой')
    for (const ing of steps) {
      if (ctl.aborted) break
      const r = await brewStep(bot, win, st, ing, ctl)
      const now = potionName(win.slots[0]) || win.slots[0]?.name
      log.push(`${ing} → ${win.slots[0] && win.slots[0].name === 'splash_potion' ? 'взрывное ' : ''}${now} (${r.seconds} с)`)
    }
    return { bottles: put, log, fuelLeft: st.props[1] }
  } finally {
    st.stop()
    try {
      if (bot.currentWindow === win) {
        for (const s of [0, 1, 2, 3, 4]) await takeOut(bot, win, s)
      }
    } catch {}
    try { win.close() } catch {}
    await sleep(600)
  }
}

// ------------------------------------------------------------ вход

async function brew (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const potion = resolvePotion(p.potion || 'fire_resistance')
  if (!potion) throw new Error(`не знаю зелья ${p.potion}. Знаю: ${Object.keys(USE).join(', ')}`)
  const steps = chainOf(potion)
  const container = p.splash ? 'splash_potion' : 'potion'
  if (p.splash) steps.push('gunpowder')
  const count = Math.max(1, Math.min(6, Math.floor(p.count || 3)))
  const batches = Math.ceil(count / 3)
  const lines = []

  let stand = findStand(bot, mcData)
  const need = needsFor(steps, batches, count, { haveStand: !!stand })
  const use = USE[potion]
  const header = `${p.splash ? 'взрывное ' : ''}${potion}: ${steps.join(' → ')}` + (use ? ` — ${use[1]}` : '')

  if (p.plan) {
    const miss = missingOf(bot, need, { haveStand: !!stand })
    for (const m of miss) lines.push(`⚠ ${m.what}: нужно ${m.count}, есть ${m.have} — ${m.where}`)
    return { potion, splash: !!p.splash, steps, need, missing: miss, ready: !miss.length, seconds: steps.length * 20 * batches, lines: [`▸ ${header}`, ...lines] }
  }

  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  await prepare(session, ctl, need, lines)
  const miss = missingOf(bot, need, { haveStand: !!stand })
  if (miss.length) {
    for (const m of miss) lines.push(`⚠ ${m.what}: нужно ${m.count}, есть ${m.have} — ${m.where}`)
    return { potion, steps, made: 0, missing: miss, stopped: `не хватает: ${miss.map(m => `${m.what} ${m.have}/${m.count}`).join(', ')}`, need: { what: miss[0].what, count: miss[0].count, have: miss[0].have }, lines: [`▸ ${header}`, ...lines] }
  }

  const bottles = await fillBottles(session, ctl, count, lines)
  if (!bottles) throw new Error('ни одной бутылки с водой')

  if (!stand) {
    await actions.place(session, ctl, { block: 'brewing_stand' })
    await sleep(300)
    stand = findStand(bot, mcData, 6)
    if (!stand) throw new Error('стойка не встала')
  }
  if (bot.entity.position.distanceTo(stand.position) > 3.5) {
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(stand.position.x, stand.position.y, stand.position.z, 2)), 15000, 'не дошёл')
    } catch {} finally { try { bot.pathfinder.setGoal(null) } catch {} }
  }

  const before = countPotions(bot, potion, container)
  const log = []
  let left = Math.min(count, bottles)
  for (let b = 0; b < batches && left > 0 && !ctl.aborted; b++) {
    const n = Math.min(3, left)
    const r = await brewBatch(session, ctl, stand, steps, n, lines)
    log.push(...r.log)
    left -= r.bottles
  }
  await sleep(400)
  const made = countPotions(bot, potion, container) - before
  lines.unshift(`▸ ${header}`)
  if (made > 0) lines.push(`▸ сварил ${made}× ${p.splash ? 'взрывное ' : ''}${potion}` + (use && use[0] ? ` (${use[0]} с)` : ''))
  else lines.push('⚠ зелье в рюкзаке не прибавилось')
  return {
    potion,
    splash: !!p.splash || undefined,
    made,
    have: countPotions(bot, potion, container),
    steps: log,
    stand: xyz(stand.position),
    lines,
    stopped: made > 0 ? undefined : 'зелье не сварилось'
  }
}

export { brew, chainOf, resolvePotion, needsFor, readyPlanks, MIX, USE, WHERE, potionName, countPotions }

'use strict'
// Сборы перед большим делом и «не забыть» в бою: золотые яблоки, зелья, лук и
// стрелы, щит, еда, блоки, ведро, кровати на дракона. Чек-лист на поход
// (nether, bastion, end/dragon, fight) — что есть, чего нет, что скрафчено
// сейчас и где взять остальное. Плюс два рефлекса (autoUse, healInFight):
// горишь — пьёшь огнестойкость, хп мало в тяжёлом бою — ешь золотое яблоко.
//
// Факты игры (paper-1.21.11, SPEEDRUN.md «Золотые яблоки»):
//   recipe/golden_apple.json — 8 золотых слитков вокруг яблока;
//   Consumables.GOLDEN_APPLE — регенерация II на 5 с + поглощение I на 2 мин
//     (+4 золотых сердца), ест всегда, даже сытым;
//   loot_table/blocks/oak_leaves.json, dark_oak_leaves.json — яблоко 0.5% с
//     листа без ножниц (удача: 0.56 / 0.63 / 0.83 / 2.5%) — ~200 листьев на яблоко.

const { sleep } = require('./movement')
const { withTimeout } = require('./build')
const actions = require('./actions')
const { countOf } = require('./items')

// ------------------------------------------------------------ мелочи

function hasEffect (bot, name) {
  try {
    const pascal = String(name).split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')
    const eff = bot.registry.effectsByName[name] || bot.registry.effectsByName[pascal]
    return !!(eff && bot.entity.effects && bot.entity.effects[eff.id])
  } catch { return false }
}
function onFire (bot) {
  try { return (bot.entity.metadata[0] & 0x01) !== 0 } catch { return false }
}
function potionName (item) {
  try { return require('./pvp').potionOf(item) } catch { return null }
}
function findPotion (bot, base, { splash = null } = {}) {
  return bot.inventory.items().find(i =>
    (splash === true ? i.name === 'splash_potion' : splash === false ? i.name === 'potion' : /^(splash_)?potion$/.test(i.name)) &&
    String(potionName(i) || '').replace(/^(long|strong)_/, '') === base) || null
}
function potionsOf (bot) {
  const out = {}
  for (const i of bot.inventory.items()) {
    if (!/potion$/.test(i.name)) continue
    const n = potionName(i)
    if (!n || n === 'water') continue
    const k = (i.name === 'splash_potion' ? 'splash_' : '') + n
    out[k] = (out[k] || 0) + i.count
  }
  return out
}
const countRe = (bot, re) => bot.inventory.items().reduce((n, i) => n + (re.test(i.name) ? i.count : 0), 0)
const wornOrHas = (bot, re) => bot.inventory.items().some(i => re.test(i.name)) ||
  [5, 6, 7, 8, 45].some(s => bot.inventory.slots[s] && re.test(bot.inventory.slots[s].name))

// Выпить/съесть и дождаться свидетеля: эффекта или убыли стопки. Рука — назад.
async function consume (bot, item, effect, ms = 3500) {
  const previous = bot.heldItem
  const had = countOf(bot, item.name)
  let ok = false
  try {
    await bot.equip(item, 'hand')
    const eating = bot.consume().catch(() => {})
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if ((effect && hasEffect(bot, effect)) || countOf(bot, item.name) < had) { ok = true; break }
      await sleep(100)
    }
    await Promise.race([eating, sleep(300)])
  } catch {}
  if (previous && previous.name !== item.name) {
    const back = bot.inventory.items().find(i => i.name === previous.name)
    if (back) { try { await bot.equip(back, 'hand') } catch {} }
  }
  return ok
}

// ------------------------------------------------------------ рефлексы

const HOSTILE = /^(zombie|husk|drowned|skeleton|stray|bogged|parched|spider|cave_spider|creeper|witch|enderman|blaze|ghast|magma_cube|slime|piglin_brute|hoglin|zoglin|wither_skeleton|wither|pillager|vindicator|evoker|ravager|vex|guardian|elder_guardian|phantom|silverfish|endermite|shulker|warden|breeze|ender_dragon|zombified_piglin|piglin)$/
function foeNear (bot, r = 8) {
  const me = bot.entity.position
  return bot.nearestEntity(e => e && e.name && HOSTILE.test(e.name) && e.position && e.position.distanceTo(me) < r)
}

// Автопилот, каждую секунду. Огонь — всегда (зелье не мешает идти); яблоко —
// только когда тело свободно: в бою это делает сам бой (healInFight), а pvp.js
// лечится по-своему.
async function autoUse (autopilot, bot) {
  const s = autopilot.session
  if (!bot || !bot.entity || s.eating || autopilot.kitBusy) return
  const now = Date.now()
  // Флаг «горит» (метаданные, бит 0x01) своему игроку сервер шлёт не всегда —
  // проба в лаве: isInLava true, флаг undefined. Поэтому ещё и клетка: огонь
  // или лава в ногах/голове — и 8 с после неё (столько горит игрок).
  const feet = bot.blockAt(bot.entity.position)
  const head = bot.blockAt(bot.entity.position.offset(0, 1, 0))
  const hot = b => b && /^(fire|soul_fire|lava|campfire|soul_campfire|magma_block)$/.test(b.name)
  if (bot.entity.isInLava || hot(feet) || hot(head)) autopilot.kitHotAt = now
  const burning = onFire(bot) || now - (autopilot.kitHotAt || 0) < 8000
  if (burning && !hasEffect(bot, 'fire_resistance') && now > (autopilot.kitFireAt || 0) && !bot.currentWindow) {
    // Темп (2026-09-25): в бою с человеком (pvp.js держит session.tempo) пить
    // 1.6 с со скоростью ×0.2 — только если он не успеет добежать или
    // дострелить; взрывное под ноги — мгновенно, его можно всегда.
    const tempoMod = require('./tempo')
    const duel = s.tempo && tempoMod.ON ? s.tempo : null
    const splashFr = findPotion(bot, 'fire_resistance', { splash: true })
    const drinkFr = findPotion(bot, 'fire_resistance', { splash: false })
    const pot = duel ? (splashFr || (duel.safe(tempoMod.consumeMs('potion'), { ignoreFire: true }).ok ? drinkFr : null)) : (drinkFr || splashFr)
    if (pot) {
      autopilot.kitFireAt = now + 4000
      autopilot.kitBusy = true
      try {
        let ok
        if (pot.name === 'splash_potion') {
          await bot.equip(pot, 'hand')
          await bot.look(bot.entity.yaw, -Math.PI / 2, true)
          bot.activateItem()
          await sleep(600)
          ok = hasEffect(bot, 'fire_resistance')
        } else ok = await consume(bot, pot, 'fire_resistance')
        s.bus.emit('drank', { text: ok ? `горел — выпил огнестойкость (${potionName(pot)})` : 'горел, огнестойкость выпить не вышло', potion: potionName(pot), ok })
      } finally { autopilot.kitBusy = false }
      return
    }
  }
  const cur = s.current
  const idle = !(cur && cur.name !== 'wait')
  if (!idle) return
  const hp = bot.health ?? 20
  if (hp > 10 || now < (autopilot.kitAppleAt || 0) || hasEffect(bot, 'absorption')) return
  if (!foeNear(bot, 10)) return
  const apple = (hp <= 6 && bot.inventory.items().find(i => i.name === 'enchanted_golden_apple')) ||
    bot.inventory.items().find(i => i.name === 'golden_apple')
  if (!apple) return
  autopilot.kitAppleAt = now + 8000
  autopilot.kitBusy = true
  s.eating = true
  try {
    const ok = await consume(bot, apple, 'absorption')
    s.bus.emit('ate', { item: apple.name, food: Math.round(bot.food ?? 0), text: ok ? `хп ${Math.round(hp)} и враг рядом — съел ${apple.name}` : undefined })
  } finally { s.eating = false; autopilot.kitBusy = false }
}

// Бой (combat.fightBody): хп упало — яблоко, пока ещё есть чем бить. Вернёт
// true, если съел (цикл боя просто продолжает). Раз в 8 с, не при поглощении.
async function healInFight (session, ctl, { weapon = null, retreatAtHealth = 6 } = {}) {
  const bot = session.bot
  const hp = bot.health ?? 20
  const line = Math.max(10, retreatAtHealth + 4)
  if (hp > line || ctl.aborted || session.eating) return false
  const now = Date.now()
  if (now < (session.kitAppleAt || 0) || hasEffect(bot, 'absorption')) return false
  const apple = (hp <= 6 && bot.inventory.items().find(i => i.name === 'enchanted_golden_apple')) ||
    bot.inventory.items().find(i => i.name === 'golden_apple')
  if (!apple) return false
  session.kitAppleAt = now + 8000
  session.eating = true
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    const ok = await consume(bot, apple, 'absorption')
    if (weapon) { const w = bot.inventory.items().find(i => i.name === weapon.name); if (w) { try { await bot.equip(w, 'hand') } catch {} } }
    if (ok) session.bus.emit('ate', { item: apple.name, food: Math.round(bot.food ?? 0), text: `в бою на ${Math.round(hp)} хп — ${apple.name}` })
    return ok
  } finally { session.eating = false }
}

// ------------------------------------------------------------ чек-листы

// what: имя или /regex/; count; need: обязательно (иначе «лучше взять»);
// why — зачем; how — где взять; craft — что крафтить (actions.craft).
const FOOD_RE = /^(cooked_[a-z_]+|bread|baked_potato|golden_carrot|pumpkin_pie|rabbit_stew|mushroom_stew|beetroot_soup|steak)$/
const BLOCK_RE = /^(cobblestone|cobbled_deepslate|blackstone|netherrack|dirt|stone|deepslate|andesite|diorite|granite|end_stone)$/
const ITEMS = {
  sword: { re: /_sword$/, count: 1, need: true, why: 'бить', how: 'mc_prep / mc_craft iron_sword', craft: ['diamond_sword', 'iron_sword', 'stone_sword'] },
  pickaxe: { re: /^(iron|diamond|netherite)_pickaxe$/, count: 1, need: true, why: 'копать и выбраться; обсидиан — алмазной', how: 'mc_craft iron_pickaxe', craft: ['diamond_pickaxe', 'iron_pickaxe'] },
  armor: { re: /^(iron|diamond|netherite)_chestplate$/, count: 1, need: true, why: 'нагрудник — больше всего брони за слиток', how: 'mc_prep strategy:smart', craft: ['diamond_chestplate', 'iron_chestplate'] },
  shield: { re: /^shield$/, count: 1, need: false, why: 'блок стрел, огненных шаров, ударов', how: '1 железо + 6 досок', craft: ['shield'] },
  bow: { re: /^bow$/, count: 1, need: false, why: 'гасты, скелеты, кристаллы Энда', how: '3 нитки (пауки) + 3 палки', craft: ['bow'] },
  arrows: { re: /^(arrow|spectral_arrow|tipped_arrow)$/, count: 16, need: false, why: 'к луку', how: 'кремень (гравий) + палка + перо (курицы) → 4', craft: ['arrow'] },
  food: { re: FOOD_RE, count: 8, need: true, why: 'сытость ≥18 — само лечится; драться голодным нельзя', how: 'жареное мясо (mc_smelt cooked_beef), хлеб' },
  blocks: { re: BLOCK_RE, count: 64, need: true, why: 'мосты, столбы, закрыться от мобов', how: 'булыжник — копать камень' },
  gapple: { re: /^(golden_apple|enchanted_golden_apple)$/, count: 2, need: false, why: 'поглощение +4 сердца и регенерация II — спасает тяжёлый бой', how: '8 золотых слитков + яблоко (яблоко с дуба 0.5% с листа)', craft: ['golden_apple'] },
  flint_and_steel: { re: /^flint_and_steel$/, count: 1, need: true, why: 'зажечь портал обратно, если гаст погасит', how: 'железо + кремень', craft: ['flint_and_steel'] },
  gold_armor: { re: /^golden_(helmet|chestplate|leggings|boots)$/, count: 1, need: true, why: 'пиглины не трогают, пока на тебе хоть что-то золотое', how: 'золотой шлем: 5 слитков (брони столько же, сколько у железного)', craft: ['golden_helmet', 'golden_boots'], worn: true },
  fire_res: { potion: 'fire_resistance', count: 1, need: false, why: 'лава и огонь не жгут 3-8 мин', how: 'mc_brew fire_resistance (нарост + сливки магмы)' },
  water_bucket: { re: /^water_bucket$/, count: 1, need: true, why: 'падение (вода внизу), тушить себя, эндермены не подойдут', how: '3 железа → ведро, набрать воды (mc_bucket)', craft: ['bucket'] },
  beds: { re: /_bed$/, count: 4, need: false, why: 'взрыв кровати по дракону на насесте — самый быстрый урон (5+ сердец)', how: '3 шерсти (овцы) + 3 доски', craft: ['white_bed'] },
  anchors: { re: /^respawn_anchor$/, count: 2, need: false, why: 'взрыв якоря (сила 5, как кровать) по дракону: дракон его не сносит, соседние взрывы тоже — можно поставить заранее прямо на путь головы', how: '6 плачущего обсидиана (бартер пиглинов) + 3 светокамня' },
  glowstone: { re: /^glowstone$/, count: 4, need: false, why: 'зарядить якорь возрождения (1 на заряд)', how: 'светокамень в Аду (4 пыли = 1 блок)' },
  obsidian: { re: /^(obsidian|crying_obsidian)$/, count: 4, need: false, why: 'опора кровати и заслон у головы дракона — взрыв кровати обсидиан не сносит', how: 'ведро воды на лаву, алмазная кирка; остаток рамки портала' },
  pearls: { re: /^ender_pearl$/, count: 2, need: false, why: 'уйти с края/с колонны, вернуться к порталу', how: 'эндермены, бартер пиглинов' },
  slow_falling: { potion: 'slow_falling', count: 1, need: false, why: 'дракон подбрасывает — падение без урона', how: 'mc_brew slow_falling (мембрана фантома)' },
  strength: { potion: 'strength', count: 1, need: false, why: '+3 к удару', how: 'mc_brew strength (огненный порошок)' },
  healing: { potion: 'healing', count: 1, need: false, why: 'мгновенно +4 сердца', how: 'mc_brew healing (сверкающий ломтик)' },
  gold: { re: /^gold_ingot$/, count: 16, need: false, why: 'бартер с пиглинами: жемчуг, огнестойкость, обсидиан', how: 'золотая руда, адская золотая руда' },
  eyes: { re: /^ender_eye$/, count: 12, need: false, why: 'найти крепость и заполнить рамку портала (в рамке часть глаз уже стоит)', how: 'жемчуг + огненный порошок' }
}
const KITS = {
  nether: ['sword', 'pickaxe', 'armor', 'gold_armor', 'shield', 'food', 'blocks', 'flint_and_steel', 'fire_res', 'gapple', 'bow', 'arrows'],
  bastion: ['sword', 'pickaxe', 'armor', 'gold_armor', 'shield', 'food', 'blocks', 'fire_res', 'gapple', 'gold', 'bow', 'arrows', 'flint_and_steel'],
  // Энд (30.09.2026): дракон — кроватями; кровати обязательны. Лук и стрелы (32, COUNTS) — не обязательны:
  // с 03.10 (решение пользователя 02.10) лук сбивает открытые кристаллы, пока дракон кружит (без лука — не сбивать),
  // и добивает дракона в полёте, когда после посадки у него ≤ 20 хп.
  end: ['sword', 'pickaxe', 'armor', 'beds', 'blocks', 'food', 'water_bucket', 'gapple', 'obsidian', 'pearls', 'slow_falling', 'strength', 'shield', 'bow', 'arrows', 'anchors', 'glowstone'],
  stronghold: ['sword', 'pickaxe', 'armor', 'eyes', 'food', 'blocks', 'water_bucket', 'shield', 'gapple'],
  fight: ['sword', 'armor', 'shield', 'food', 'gapple', 'bow', 'arrows', 'healing', 'strength', 'blocks']
}
const ALIAS = { dragon: 'end', 'дракон': 'end', 'энд': 'end', 'ад': 'nether', 'бастион': 'bastion', 'крепость': 'stronghold', pvp: 'fight', 'бой': 'fight' }
// Большие числа только для Энда: кроватей — 2–3 на посадку, посадок 3–5 (кристаллы
// лечат дракона ~120 хп между посадками — dragon.js, «бой только кроватями»);
// блоков — мост с платформы и заслоны/пол у головы.
// 03.10: стрел на Энд — 32, как кампания (ARROWS_END): лук сбивает открытые кристаллы, пока дракон кружит (dragon.js crystalWait,
// ~1.5 стрелы на кристалл, 8 открытых, 6 — запас на добивание).
const COUNTS = { end: { beds: 5, blocks: 96, gapple: 3, obsidian: 4, arrows: 32 }, bastion: { blocks: 128, gapple: 3 } }
// Что в этом походе обязательно, хотя вообще — «лучше взять».
// Обсидиан (или плачущий) — опора и укрытие станции у столба (дракон в LANDING взрывами, 01.10):
// взрыв кровати его не сносит. Для режима «станция у столба» — обязателен.
const MUST = { end: ['beds', 'obsidian'] }

function haveOf (bot, key, spec) {
  if (spec.potion) {
    const p = potionsOf(bot)
    return Object.entries(p).filter(([k]) => k.replace(/^splash_/, '').replace(/^(long|strong)_/, '') === spec.potion).reduce((n, [, c]) => n + c, 0)
  }
  if (spec.worn) return wornOrHas(bot, spec.re) ? 1 : 0
  if (key === 'armor') return wornOrHas(bot, spec.re) ? 1 : 0
  return countRe(bot, spec.re)
}

// Надёжнее спросить рецепт, чем гадать: можно ли это скрафтить из рюкзака.
function craftable (bot, mcData, name, n = 1) {
  const it = mcData.itemsByName[name]
  if (!it) return false
  try { return bot.recipesFor(it.id, null, n, true).length > 0 } catch { return false }
}

// После окна верстака рюкзак клиента сверяется с сервером не сразу (invsync:
// полная копия через ~150 мс) — считать сразу значит недосчитаться. И серию
// крафтов mineflayer на 1.21.11 рвёт на середине (яблок ×2 вышло одно) —
// поэтому по одному заходу, пока растёт.
async function craftSome (session, ctl, name, count, made) {
  const bot = session.bot
  const before = countOf(bot, name)
  let error = null
  for (let i = 0; i < 16 && !ctl.aborted; i++) {
    const have = countOf(bot, name)
    if (have - before >= count) break
    try {
      await actions.craft(session, ctl, { item: name, count: count - (have - before), spendReserve: true })
      error = null
    } catch (e) { error = e.message }
    await sleep(700)
    if (countOf(bot, name) <= have) break
  }
  const got = countOf(bot, name) - before
  if (got > 0) made.push(`${name} ×${got}`)
  return got > 0 ? null : error
}

// Золотые яблоки: слитки из самородков/блоков, потом по 8 на яблоко.
async function makeGapples (session, ctl, want, made, lines) {
  const bot = session.bot
  const mcData = session.mcData
  let n = Math.min(want, countOf(bot, 'apple'))
  if (!n) return 0
  if (countOf(bot, 'gold_ingot') < 8 * n && countOf(bot, 'gold_block')) await craftSome(session, ctl, 'gold_ingot', 9 * countOf(bot, 'gold_block'), made)
  if (countOf(bot, 'gold_ingot') < 8 * n && countOf(bot, 'gold_nugget') >= 9) await craftSome(session, ctl, 'gold_ingot', Math.floor(countOf(bot, 'gold_nugget') / 9), made)
  n = Math.min(n, Math.floor(countOf(bot, 'gold_ingot') / 8))
  if (!n || !craftable(bot, mcData, 'golden_apple')) return 0
  const err = await craftSome(session, ctl, 'golden_apple', n, made)
  if (err) lines.push(`⚠ золотое яблоко: ${err}`)
  return n
}

async function kit (session, ctl, p = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const goal = ALIAS[p.for] || p.for || 'nether'
  const list = KITS[goal]
  if (!list) throw new Error(`не знаю похода ${p.for}; знаю: ${Object.keys(KITS).join(', ')}`)
  const doCraft = p.craft !== false
  const made = []
  const lines = []
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })

  const want = key => (COUNTS[goal] && COUNTS[goal][key]) || ITEMS[key].count

  if (doCraft) {
    // Оружие и броня — через prep.js (он знает материалы и порядок).
    const needGear = list.some(k => (k === 'sword' || k === 'armor') && haveOf(bot, k, ITEMS[k]) < 1)
    const hasMats = countRe(bot, /^(iron_ingot|diamond|.*_log|.*_planks)$/) > 0
    if (needGear && hasMats && !ctl.aborted) {
      try {
        const r = await require('./prep').prepare(session, ctl, { strategy: 'smart' })
        for (const m of (r.made || [])) made.push(m.what)
      } catch (e) { lines.push(`⚠ prep: ${e.message}`) }
    }
    // Дерево под щит, лук, стрелы, кровати: брёвна → доски, палки про запас.
    const wantsWood = list.some(k => ['shield', 'bow', 'arrows', 'beds'].includes(k) && haveOf(bot, k, ITEMS[k]) < want(k))
    if (wantsWood && !ctl.aborted) {
      for (const log of bot.inventory.items().filter(i => /_(log|stem)$/.test(i.name))) {
        const planks = log.name.replace(/_(log|stem)$/, '_planks')
        if (mcData.itemsByName[planks]) await craftSome(session, ctl, planks, log.count * 4, made)
      }
      const sticks = (list.includes('bow') && haveOf(bot, 'bow', ITEMS.bow) < 1 ? 3 : 0) +
        (list.includes('arrows') ? Math.min(countOf(bot, 'flint'), countOf(bot, 'feather')) : 0)
      if (countOf(bot, 'stick') < sticks) await craftSome(session, ctl, 'stick', sticks - countOf(bot, 'stick'), made)
    }
    for (const key of list) {
      if (ctl.aborted) break
      const spec = ITEMS[key]
      if (!spec.craft) continue
      const have = haveOf(bot, key, spec)
      const need = want(key)
      if (have >= need) continue
      if (key === 'gapple') { await makeGapples(session, ctl, need - have, made, lines); continue }
      if (key === 'arrows') {
        const n = Math.min(Math.ceil((need - have) / 4), countOf(bot, 'flint'), countOf(bot, 'feather'))
        if (n > 0 && craftable(bot, mcData, 'arrow')) await craftSome(session, ctl, 'arrow', n * 4, made)
        continue
      }
      if (key === 'beds') {
        const wools = bot.inventory.items().filter(i => /_wool$/.test(i.name))
        let n = Math.min(need - have, Math.floor(wools.reduce((s, i) => s + i.count, 0) / 3))
        for (const w of wools) {
          if (n <= 0 || ctl.aborted) break
          const bed = w.name.replace(/_wool$/, '_bed')
          const k = Math.min(n, Math.floor(countOf(bot, w.name) / 3))
          if (k > 0 && craftable(bot, mcData, bed)) { await craftSome(session, ctl, bed, k, made); n -= k }
        }
        continue
      }
      if (key === 'water_bucket') {
        if (!countOf(bot, 'bucket') && craftable(bot, mcData, 'bucket')) await craftSome(session, ctl, 'bucket', 1, made)
        continue
      }
      if (key === 'gold_armor' && goal !== 'nether' && goal !== 'bastion') continue
      for (const name of spec.craft) {
        if (haveOf(bot, key, spec) >= need || ctl.aborted) break
        if (!craftable(bot, mcData, name)) continue
        const err = await craftSome(session, ctl, name, 1, made)
        if (!err) break
      }
    }
    // Золото надеть сразу: пиглин смотрит на броню, а не в рюкзак.
    if ((goal === 'nether' || goal === 'bastion') && ![5, 6, 7, 8].some(s => bot.inventory.slots[s] && /^golden_/.test(bot.inventory.slots[s].name))) {
      const g = bot.inventory.items().find(i => /^golden_(helmet|boots|leggings|chestplate)$/.test(i.name))
      if (g) {
        const dest = /helmet/.test(g.name) ? 'head' : /boots/.test(g.name) ? 'feet' : /leggings/.test(g.name) ? 'legs' : 'torso'
        try { await bot.equip(g, dest); made.push(`надел ${g.name}`) } catch {}
      }
    }
  }

  const items = []
  let ready = true
  for (const key of list) {
    const spec = ITEMS[key]
    const need = want(key)
    const have = haveOf(bot, key, spec)
    const ok = have >= need
    const must = spec.need || (MUST[goal] || []).includes(key)
    if (!ok && must) ready = false
    items.push({ key, have, need, ok, must: must || undefined })
    if (!ok) lines.push(`${must ? '⚠' : '▸'} ${key}: ${have}/${need} — ${spec.why}; ${spec.how}`)
  }
  if (goal === 'nether' || goal === 'bastion') {
    if (countRe(bot, /_bed$/)) lines.push('⚠ кровать в Аду взрывается — спать нельзя (как бомба — можно, издалека)')
    if (countOf(bot, 'water_bucket')) lines.push('▸ вода в Аду испаряется — ведро там не поможет')
  }
  if (made.length) lines.unshift(`▸ скрафтил: ${made.join(', ')}`)
  const pot = potionsOf(bot)
  return {
    for: goal,
    ready,
    made,
    items,
    potions: Object.keys(pot).length ? pot : undefined,
    gapples: countRe(bot, /golden_apple$/),
    lines,
    stopped: ready ? undefined : `не готов к ${goal}: ${items.filter(i => !i.ok && i.must).map(i => `${i.key} ${i.have}/${i.need}`).join(', ')}`
  }
}

module.exports = { kit, autoUse, healInFight, consume, hasEffect, onFire, findPotion, potionsOf, makeGapples, KITS, ITEMS }

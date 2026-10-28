'use strict'
// Крафт и верстак: свой стоящий, новый, подсказка окну крафта, описание нехватки.
import { collectNearbyDrops, posKey } from './gather'
import { place, rememberOwnBlock, isOwnBlock, forgetOwnBlock } from './place'
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
const { sleep, xyz }: typeof import('../movement') = require('../movement')
const { countOf, bestOfKind, plankCount, spendablePlanks, planksPerCraft, TABLE_PLANKS }: typeof import('../items') = require('../items')
const { withTimeout }: typeof import('../build') = require('../build')
// A window left open blocks every window after it (README), so this runs before
// digging and after crafting either way.
async function closeStrayWindow (bot) {
  if (!bot.currentWindow) return false
  try { bot.closeWindow(bot.currentWindow) } catch {}
  await sleep(200)
  return true
}

// Bare hands on purpose. minecraft-data 1.21.11: crafting_table is hardness
// 2.5, material mineable/axe, drops [332] — itself — and has NO harvestTools,
// so anything breaks it and it always drops. But digging with a tool in hand
// costs that tool a point of durability whatever the block is, and pickaxe
// swings are the entire reason we are carrying the table home. An axe is worth
// it (0.95s against 3.75s, and an axe is not the way out); a pickaxe is not.
async function handForBreaking (bot) {
  const axe = bestOfKind(bot, 'axe')
  if (axe) { await bot.equip(axe, 'hand'); return axe.name }
  const held = bot.heldItem
  if (!held || !held.maxDurability) return held ? held.name : 'пусто'
  const junk = bot.inventory.items().find(i => !i.maxDurability)
  try {
    if (junk) { await bot.equip(junk, 'hand'); return junk.name }
    await bot.unequip('hand')
    return 'пусто'
  } catch {
    return held.name
  }
}

// Break a table we put down ourselves and take it with us. Never throws: a
// table left standing is a loss worth reporting, not a reason to fail a craft
// that already succeeded.
async function reclaimTable (session, ctl, table) {
  const bot = session.bot
  if (!table || ctl.aborted) return null
  const at = table.position
  if (!isOwnBlock(session, at) && !session._ndOwnTables?.has(posKey(at))) return null
  const here = bot.blockAt(at)
  if (!here || here.name !== 'crafting_table') { forgetOwnBlock(session, at); session._ndOwnTables?.delete(posKey(at)); return null }
  await closeStrayWindow(bot)
  if (!bot.canDigBlock(here)) {
    return { kept: false, at: xyz(at), note: 'до верстака не дотянуться — оставил стоять, вернись за ним' }
  }

  const before = countOf(bot, 'crafting_table')
  const receipt = bot.version === '1.21.11' && bot._client
    ? (require('../environments/dig-receipt') as typeof import('../environments/dig-receipt')).watchDigReceipt(bot, at, () => ctl.aborted) : null
  try {
    await handForBreaking(bot)
    await withTimeout(bot.dig(here), 12000, 'верстак не ломается')
    if (receipt && await receipt.settle() !== 'confirmed') throw new Error('сервер не подтвердил разрушение')
  } catch (e) {
    return { kept: false, at: xyz(at), note: `верстак остался стоять (${e.message}) — сломай сам, это 4 доски` }
  } finally { receipt?.close() }
  forgetOwnBlock(session, at)
  session._ndOwnTables?.delete(posKey(at))

  // Vanilla only vacuums up a drop within about a block, and the table is one
  // to three squares away. Wait for the free pickup first, walk only if it does
  // not come — walking is what cost eleven levels of altitude last time.
  const deadline = gameClock.now() + 1500
  while (gameClock.now() < deadline && countOf(bot, 'crafting_table') <= before) await sleep(150)
  if (countOf(bot, 'crafting_table') <= before) {
    try { await withTimeout(collectNearbyDrops(bot, ctl, { radius: 3, timeoutMs: 3000, appearMs: 3000 }), 5000) } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
  }
  // Второй заход — шире и дольше. Верстак, брошенный в штреке, — это конец
  // на глубине: без него ни кирки, ни печи (2026-09-26, 12:52: «подобрать не
  // успел», а через три минуты — y=29 без кирки и верстака).
  if (countOf(bot, 'crafting_table') <= before && !ctl.aborted) {
    try { await withTimeout(collectNearbyDrops(bot, ctl, { radius: 6, timeoutMs: 6000, appearMs: 6000 }), 8000) } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
  }

  const kept = countOf(bot, 'crafting_table') > before
  if (kept) return { kept, at: xyz(at) }
  // Что на самом деле: стоит ли он ещё (удар «прошёл», а блок цел) и какие
  // предметы лежат рядом — чтобы следующий заход чинил правду, а не догадку.
  const still = bot.blockAt(at)
  const standing = !!still && still.name === 'crafting_table'
  if (standing) rememberOwnBlock(session, 'crafting_table', at)
  const drops = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 10)
    .map((e : any) => { let n = '?'; try { n = e.getDroppedItem().name } catch {} return `${n}@${xyz(e.position).x},${xyz(e.position).y},${xyz(e.position).z}` })
  return {
    kept,
    at: xyz(at),
    standing,
    drops: drops.slice(0, 6),
    note: standing
      ? `верстак не сломался — стоит на ${xyz(at).x},${xyz(at).y},${xyz(at).z}`
      : `верстак сломал, но подобрать не успел — рядом: ${drops.slice(0, 4).join(', ') || 'ничего'}`
  }
}

// ---------------------------------------------------------------- craft

function findTable (bot, mcData, maxDistance = 3) {
  return bot.findBlock({ matching: [mcData.blocksByName.crafting_table.id], maxDistance })
}

// Свои поставленные верстаки — отдельно от ownBlocks (там 24 последних, заплатки штрека вытесняют верстак за минуту).
function ownTable (session, table) {
  if (table) (session._ndOwnTables ||= new Map()).set(posKey(table.position), table.position.clone())
  return table
}
// ND_BAST_TABLE_BACK=1 (поток bast 27.10, выкл.): верстака нет и сделать не из чего — к своему брошенному (память, не обзор) до 64 бл.:
// тактика рвала reclaimTable (ctl.aborted), верстак оставался в штреке бастиона, а пополнение кирок искало стебли по открытому
// 20+ мин («не вижу crafting_table в радиусе 3», sr27-bast-A4 слот 14: 4 доски, 0/260 взмахов).
function ownTableFar (session, maxDistance = 64) {
  const bot = session.bot
  if (process.env.ND_BAST_TABLE_BACK !== '1' || !session._ndOwnTables) return null
  let best = null, bestD = maxDistance
  for (const [key, pos] of session._ndOwnTables) {
    const here = bot.blockAt(pos)
    if (!here) continue
    if (here.name !== 'crafting_table') { session._ndOwnTables.delete(key); continue }
    const d = bot.entity.position.distanceTo(pos)
    if (d < bestD) { best = here; bestD = d }
  }
  return best
}

// bot.craft() opens the table by activating the block, which silently does
// nothing when the bot is out of reach or has no line of sight — and then the
// call hangs 20s waiting for a window that never opens. So guarantee a table
// right next to us: walk to a known one, or build a fresh one on the spot.
// Put a brand new table directly next to us, crafting one first if needed.
async function placeFreshTable (session, ctl) {
  const bot = session.bot
  const mcData = session.mcData
  let item = bot.inventory.items().find(i => i.name === 'crafting_table')
  if (!item) {
    const own = bot.recipesFor(mcData.itemsByName.crafting_table.id, null, 1, null)
    if (!own.length) return null
    await bot.craft(own[0], 1, null)
    item = bot.inventory.items().find(i => i.name === 'crafting_table')
  }
  if (!item) return null
  await place(session, ctl, { block: 'crafting_table' })
  return ownTable(session, findTable(bot, mcData, 3))
}

async function ensureTable (session, ctl) {
  const bot = session.bot
  const mcData = session.mcData

  let table = findTable(bot, mcData, 3)
  if (table) return table

  // Walking to a table we can see is only worth it when it is genuinely close
  // and we cannot simply stand one up. Twenty blocks underground is not close.
  // Measured: the second craft of a run went looking for the table the first
  // craft had left behind twelve blocks back, spent the entire 60s intent
  // budget inside pathfinder, and answered `timeout` — with canDig movements
  // inherited from the drift, because craft is one of the few intents that
  // never calls updateMovements. It was not walking to the table, it was
  // digging its way back to it. A crafting table costs four planks; a minute
  // at y=-59 costs the climb.
  const canPlace = !!bot.inventory.items().find(i => i.name === 'crafting_table') ||
    bot.recipesFor(mcData.itemsByName.crafting_table.id, null, 1, null).length > 0
  const own = canPlace ? null : ownTableFar(session)
  const far = findTable(bot, mcData, canPlace ? 6 : 20) || own
  if (far) {
    const p = far.position
    // Bounded, and cleared afterwards either way: pathfinder outlives the
    // promise we stopped waiting for, and a goal left set keeps walking the
    // body long after this call has answered.
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)), far === own ? 45000 : 15000, 'до верстака не дошёл')
    } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    table = findTable(bot, mcData, 3)
    if (table) return table
  }

  let item = bot.inventory.items().find(i => i.name === 'crafting_table')
  if (!item) {
    const own = bot.recipesFor(mcData.itemsByName.crafting_table.id, null, 1, null)
    if (!own.length) return null
    await bot.craft(own[0], 1, null)
    item = bot.inventory.items().find(i => i.name === 'crafting_table')
  }
  if (!item) return null

  await place(session, ctl, { block: 'crafting_table' })
  return ownTable(session, findTable(bot, mcData, 3))
}

// mineflayer waits a flat twenty seconds for the table window and there is no
// way to ask it to wait less: promise_utils.js `once (emitter, event, timeout =
// 20000)`, awaited in craft.js immediately after `bot.activateBlock(table)`.
// That single wait is the bulk of the 28.9s a second craft cost in try-tools
// against 3.3s for the first — what goes missing on 1.21.11 is the activate,
// not the crafting.
//
// We cannot shorten someone else's timer, but we can poke the same block again
// while it runs: craft.js waits for the FIRST windowOpen event, whoever caused
// it, so a repeat activate is not a second craft — it is the same one asking
// again. Poking stops the moment a window exists, and bot.currentWindow is set
// by the open_window packet handler one beat BEFORE the event is emitted
// (inventory.js: prepareWindow), so reading it cannot arrive late.
// Six seconds before the first poke, not one: a window that is merely slow must
// be allowed to arrive on its own. Two windows for one craft would be worse than
// the wait — mineflayer would keep clicking into the first while the server
// answers about the second — and a normally opening table takes under a third of
// a second. After that, 10.5s and 15.5s, all still inside mineflayer's own 20.
const NUDGE_AT_MS = [6000, 4500, 5000]

// How many runs of this recipe the bag can actually pay for. recipesFor only
// answers yes/no for the exact number asked, and its "no" used to send craft
// off table-hunting for a craft that was never about the table: «палки, count
// 16» with six planks placed a crafting table, spent four of the six planks on
// it, and then answered «для stick нужен верстак, а его нет ни рядом, ни в
// инвентаре». Fewer sticks is a better answer than that in every case.
function affordableCrafts (bot, recipe) {
  const have = {}
  for (const i of bot.inventory.items()) have[i.type] = (have[i.type] || 0) + i.count
  let n = Infinity
  for (const d of (recipe && recipe.delta) || []) {
    if (d.count >= 0) continue
    n = Math.min(n, Math.floor((have[d.id] || 0) / -d.count))
  }
  return Number.isFinite(n) ? n : 1
}

function craftWithNudge (bot, recipe, times, table, ctl = null) {
  if (bot.version === '1.21.11') return (require('../craft-confirmed') as typeof import('../craft-confirmed')).craftConfirmed(bot, recipe, times, table, () => !!ctl?.aborted)
  // Mineflayer predicts output locally; verify every inventory craft against
  // the server before the next iteration can spend those predicted items.
  if (!table && times > 1) {
    // И с паузой: подряд без неё второй заход падал так же — ждём, пока сервер
    // положит результат в рюкзак (это и есть свидетель, что заход прошёл).
    const made = () => bot.inventory.items().reduce((n, i) => n + (i.type === recipe.result.id ? i.count : 0), 0)
    return (async () => {
      for (let i = 0; i < times; i++) {
        const before = made()
        await bot.craft(recipe, 1, null)
        if (bot.version === '1.21.11' && !(await (require('../invsync') as typeof import('../invsync')).refresh(bot))) throw new Error('крафт: сервер не подтвердил инвентарь')
        for (let t = 0; t < 30 && made() <= before; t++) await sleep(50)
        await sleep(150)
      }
    })()
  }
  if (!table) return bot.craft(recipe, times, null)
  let done = false
  const work = bot.craft(recipe, times, table)
  work.then(() => { done = true }, () => { done = true })
  const nudge = async () => {
    for (const ms of NUDGE_AT_MS) {
      await sleep(ms)
      if (done || bot.currentWindow) return
      try { await bot.activateBlock(table) } catch {}
    }
  }
  nudge().catch(() => {})
  return work
}

async function craft (session, ctl, { item: name, count = 1, spendReserve = false, conversionStep = false, conversionInputs = null, conversionTimes = 1, planOnly = false, repair = false, ownTableBack = false }: any = {}) {
  const bot = session.bot
  // ownTableBack (ND_BAST_TABLE_BACK, кампания: верстака нет, досок < 4) — только вернуть свой брошенный верстак в рюкзак.
  if (ownTableBack) {
    const t = ownTableFar(session)
    if (!t) return { made: 0, note: 'своего верстака в памяти нет' }
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2)), 45000, 'до верстака не дошёл') } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    const back = await reclaimTable(session, ctl, bot.blockAt(t.position))
    return { made: 0, tableBack: !!back?.kept, note: back?.note || (back?.kept ? `свой верстак забрал с ${xyz(t.position).x},${xyz(t.position).y},${xyz(t.position).z}` : 'верстак не вернул') }
  }
  if (repair) return (require('../conversions/repair') as typeof import('../conversions/repair')).repairItems(session, ctl, { item: name, planOnly })
  const mcData = session.mcData
  const itemData = mcData.itemsByName[name]
  if (!itemData) throw new Error(`нет такого предмета: ${name}`)
  if (!conversionStep && bot.version === '1.21.11') {
    const converted = await (require('../conversions/runtime') as typeof import('../conversions/runtime')).craftConverted(session, ctl, { item: name, count, spendReserve, planOnly })
    if (converted) return converted
  }

  // runIntent aborts the ctl on timeout and nothing in here used to listen, so
  // a craft that ran out of time left the body walking to a table under a goal
  // nobody cleared. That is how a climb from y=-48 ended at y=-59 with the
  // intent already reported as `timeout`. Same teardown tunnel and surface do.
  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  })

  // Anything below may put a table on the ground, and a table we stood up has
  // to come back with the body — including when the craft fails, because the
  // four planks are worth exactly as much either way.
  const placed = []
  const taken = []
  const reclaimAll = async () => {
    while (placed.length) {
      const r = await reclaimTable(session, ctl, placed.shift())
      if (r) taken.push(r)
    }
  }
  // Что застряло в сетке 2×2 от прошлого сорванного крафта — сначала вернуть в
  // рюкзак (invsync.flushGrid), иначе рецепт «не видит» своих же досок.
  const inventorySync: typeof import('../invsync') = require('../invsync')
  if (bot.version === '1.21.11') {
    if (!(await inventorySync.refresh(bot, 2000, true))) throw new Error('крафт: сервер не подтвердил возврат сетки')
  } else if (inventorySync.flushGrid(bot)) await sleep(350)
  // Свидетель — рюкзак, а не отсутствие исключения (см. ниже, после крафта).
  // Считаем и надетое: автопилот надевает свежий нагрудник и берёт щит в левую
  // руку раньше, чем мы успеваем посчитать (2026-09-26: нагрудник скрафтился,
  // был надет, а проверка по рюкзаку сказала «не прибавилось»).
  const owned = () => {
    let n = countOf(bot, name)
    for (const s of [5, 6, 7, 8, 45]) { const it = bot.inventory.slots[s]; if (it && it.name === name) n += it.count }
    return n
  }
  const before = owned()

  try {
    bot._ndCrafting = true
    // Try the 2x2 inventory grid first. Handing bot.craft a table it does not
    // need makes it open the table UI, and if the bot has since wandered out of
    // reach the window never opens and the call hangs for 20s. Asked for one
    // item and not for `count`, because the question here is only "can this be
    // made at all, and does it need the 3x3 grid" — how many is a separate
    // question, answered from the bag below.
    let table = null
    let recipes = bot.recipesFor(itemData.id, null, 1, null)
    const planned = recipe => {
      const consumed = Object.fromEntries(recipe.delta.filter(d => d.count < 0).map(d => [mcData.items[d.id].name, -d.count]))
      return Object.keys(consumed).length === Object.keys(conversionInputs).length &&
        Object.entries(conversionInputs).every(([item, quantity]: [string, number]) => consumed[item] === quantity / conversionTimes)
    }

    // В сетке 2×2 есть только свёртка «блок → 9 слитков», а план — самородки на верстаке: искать и с верстаком
    // (s1-full48 06.10: iron_block из сундука бастиона + самородки → «рецепт не совпал» ×4, кирки не сделаны).
    if (!recipes.length || conversionInputs && !recipes.some(planned)) {
      table = await ensureTable(session, ctl)
      if (table) {
        placed.push(table)
        await bot.lookAt(table.position.offset(0.5, 0.5, 0.5), true)
        recipes = bot.recipesFor(itemData.id, null, 1, table)
      }
    }

    if (!recipes.length) {
      const known = bot.recipesAll(itemData.id, null, table || true)
      if (!known.length) throw new Error(`не знаю рецепта для ${name}`)
      const missing = describeMissing(bot, known, mcData)
      // Everything is in the bag and it still will not craft: the only thing in
      // the way is the 3x3 grid. Saying "не хватает ингредиентов" while the bot
      // is carrying 64 cobblestone sends the brain hunting for the wrong thing.
      if (!missing) throw new Error(`для ${name} нужен верстак, а его нет ни рядом, ни в инвентаре`)
      throw new Error(`не хватает на ${name}: ${missing}` + (table ? '' : ' (и верстака рядом нет)'))
    }

    if (conversionInputs) recipes = recipes.filter(planned)
    if (!recipes.length) throw new Error(`серверный рецепт для ${name} не совпал с планом преобразования`)
    const recipe = recipes[0]
    const preserve = new Set(recipe.delta.filter(ingredient => ingredient.count < 0).map(ingredient => mcData.items[ingredient.id].name))
    // `count` is how many items the caller wants to own, and that is also how
    // recipesFor above read it (minResultCount). bot.craft reads the same number
    // as how many TIMES to run the recipe (craft.js: `for (let i = 0; i < count;
    // i++) await craftOnce(...)`), and for sticks the two disagree by a factor of
    // four. That is where sixteen planks went on 2026-08-31: the brain asked for
    // «палки, count 4» twice, got four crafts each time — eight planks a call,
    // 32 sticks — and then had nothing left to build the table it needed to leave.
    const perCraft = (recipe.result && recipe.result.count) || 1
    let times = Math.max(1, Math.min(Math.ceil(count / perCraft), affordableCrafts(bot, recipe)))

    // The same reserve idea as TOOL_RESERVE, in wood. Four planks are a crafting
    // table, a table is the 3x3 grid, and the grid is the only road to a stone
    // pickaxe — so at depth they are as untouchable as the swings for the climb.
    // Exempt: the table itself, and a caller that says outright it means to
    // spend them.
    const perCraftPlanks = planksPerCraft(recipe, mcData)
    let heldBack = 0
    if (perCraftPlanks > 0 && name !== 'crafting_table' && !spendReserve) {
      const fit = Math.floor(spendablePlanks(bot, mcData) / perCraftPlanks)
      if (fit <= 0) {
        throw new Error(
          `не трачу последние доски (их ${plankCount(bot)}): ${TABLE_PLANKS} держу на верстак, ` +
          'без него внизу не собрать ни кирку, ни меч. Нужно дерево — одно бревно даёт 4 доски. ' +
          'Если верстак не нужен, сначала скрафти crafting_table: с ним в рюкзаке доски снова свободны')
      }
      if (fit < times) { heldBack = times - fit; times = fit }
    }

    const outputRoom = async () => {
      const pack: typeof import('../pack') = require('../pack')
      const slots = pack.outputSlots(bot, name, times * perCraft) +
        (placed.length && !countOf(bot, 'crafting_table') ? 1 : 0)
      if (bot.inventory.emptySlotCount() < slots) await pack.makeRoom(bot, { slots, forItem: name, preserve, allowEqual: true })
      if (bot.inventory.emptySlotCount() < slots) throw new Error(`нет места для ${name} и возврата верстака — сначала разгрузи рюкзак; материалы не трачу`)
    }
    await outputRoom()
    const inputs = (recipe.delta || []).filter(d => d.count < 0).map(d => {
      const item = mcData.items[d.id]?.name
      return { item, before: item ? countOf(bot, item) : 0 }
    })
    const spent = () => inputs.some(i => i.item && countOf(bot, i.item) < i.before)
    const consumedError = () => new Error(`крафт ${name}: материалы списаны, результат не подтверждён — проверь дроп или сетку крафта; новый рецепт не запускаю`)
    const notes = []
    let usedTable = !!table
    try {
      await craftWithNudge(bot, recipe, times, table, ctl)
    } catch (err) {
      if (/missing ingredient/.test(err.message)) {
        const w = bot.currentWindow || bot.inventory
        const slots = w.slots.map((it, slot) => it && { slot, item: it.name, count: it.count }).filter(Boolean)
        throw new Error(`${err.message}: ${JSON.stringify({ window: w.id, cursor: w.selectedItem?.name ?? null, slots })}`)
      }
      // Opening a table that is merely "nearby" fails often on 1.21.11 — the
      // activate packet goes nowhere and mineflayer waits 20s for a window.
      // Crafting at a table we just placed under our own feet does work, so
      // that is the retry.
      if (!table || !/windowOpen|updateSlot/.test(err.message)) throw err
      if (spent()) throw consumedError()
      await reclaimAll()
      const fresh = await placeFreshTable(session, ctl)
      if (!fresh) throw new Error(`верстак не открылся и новый поставить не вышло: ${err.message}`)
      placed.push(fresh)
      await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true)
      const retry = bot.recipesFor(itemData.id, null, 1, fresh)
      if (!retry.length) throw new Error(`после переустановки верстака рецепт ${name} не собрался`)
      await outputRoom()
      await craftWithNudge(bot, retry[0], times, fresh, ctl)
      usedTable = true
      notes.push('верстак пришлось переставить')
    }

    await reclaimAll()
    await closeStrayWindow(bot)

    // Верстак на 1.21.11 иногда молчит: bot.craft возвращается без ошибки, а
    // сервер не скрафтил ничего и ничего не списал. Отчёт писал count = times ×
    // perCraft, и кампания 2026-09-26 дважды шла дальше «с киркой», которой нет
    // (деревянная в первом круге, каменная во втором: меч и топор есть, кирки
    // нет, булыжник и палки на неё целы). Считаем по рюкзаку — после сверки
    // invsync (~150 мс после окна) — и один раз повторяем у свежего верстака.
    let got = owned() - before
    if (got <= 0) { await sleep(400); got = owned() - before }
    if (got <= 0 && spent()) throw consumedError()
    if (got <= 0 && usedTable && !ctl.aborted) {
      const fresh = await placeFreshTable(session, ctl)
      if (fresh) {
        placed.push(fresh)
        await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true)
        const again = bot.recipesFor(itemData.id, null, 1, fresh)
        if (again.length) {
          await outputRoom()
          try { await craftWithNudge(bot, again[0], times, fresh, ctl) } catch {}
        }
        await reclaimAll()
        await closeStrayWindow(bot)
        await sleep(400)
        got = owned() - before
        if (got > 0) notes.push('первый заход верстак не принял — повторил у свежего')
      }
    }
    if (got <= 0) {
      if (spent()) throw consumedError()
      throw new Error(`крафт ${name} прошёл без ошибки, а в рюкзаке его не прибавилось — ` +
        'верстак не ответил (болезнь 1.21.11); повтори вызов')
    }

    const made = got
    const out: any = { crafted: name, count: made, usedTable }
    if (made !== count) out.asked = count
    if (heldBack) {
      notes.push(`сделал меньше: ${TABLE_PLANKS} доски оставил на верстак, без него внизу не скрафтить кирку`)
    }
    if (taken.length) {
      // The brain needs this as much as the scene does: a table left on the
      // floor forty blocks back is the same as no table at all.
      out.tableBack = taken.every(t => t.kept)
      for (const t of taken) if (t.note) notes.push(t.note)
    }
    if (notes.length) out.note = notes.join('; ')
    return out
  } finally {
    bot._ndCrafting = false
    // Never let the teardown mask the real error.
    try { await reclaimAll() } catch {}
    try { await closeStrayWindow(bot) } catch {}
    // Сорванный крафт в сетке 2×2 оставляет ингредиенты в ней — вернуть.
    try { (require('../invsync') as typeof import('../invsync')).flushGrid(bot) } catch {}
  }
}

// Most items have several recipe variants (one per wood species, say). Naming
// the first one is actively misleading — "нужен cherry_planks" when the bot is
// carrying oak. Report the variant the bot is closest to completing.
// «oak_planks×2» and «cherry_planks×2» differ only in the wood, and the wood
// is exactly the part the bot can do nothing about: it has never seen cherry.
// Measured on the expedition — an empty bag makes all thirteen stick recipes
// equal, the tie broke on list order, and the refusal named a tree that does
// not grow anywhere the bot has been.
function sameKind (a, b) {
  if (a === b) return a
  const tail = s => (s.match(/_([a-z_]+×\d+)$/) || [])[1]
  const ta = tail(a)
  return ta && ta === tail(b) ? `любые ${ta}` : a
}

function describeMissing (bot, recipes, mcData) {
  const have = {}
  for (const i of bot.inventory.items()) have[i.type] = (have[i.type] || 0) + i.count

  let best = null
  for (const recipe of recipes) {
    const need = {}
    for (const d of recipe.delta || []) {
      if (d.count < 0) need[d.id] = (need[d.id] || 0) + (-d.count)
    }
    const parts = []
    let total = 0
    let untouched = 0
    for (const [id, n] of ((Object.entries(need) as [string, any][]) as any)) {
      const owned = have[id] || 0
      const short = n - owned
      if (short > 0) {
        total += short
        // An ingredient we own none of means a whole separate sub-quest.
        // Counting those first keeps "3 доски + шерсть которая уже есть" from
        // losing to "покрасить чёрную кровать, которой тоже нет".
        if (owned === 0) untouched++
        parts.push(`${mcData.items[id] ? mcData.items[id].name : id}×${short}`)
      }
    }
    if (!best || untouched < best.untouched || (untouched === best.untouched && total < best.total)) {
      best = { untouched, total, parts }
    } else if (untouched === best.untouched && total === best.total) {
      // A tie between wood types is not a choice, it is a coincidence: say the
      // thing they have in common instead of picking one at random.
      for (let i = 0; i < best.parts.length && i < parts.length; i++) {
        best.parts[i] = sameKind(best.parts[i], parts[i])
      }
    }
  }

  // Null, not a vague sentence: the caller has to be able to tell "nothing is
  // missing" from "something is missing and I cannot name it".
  if (!best || !best.parts.length) return null
  const suffix = recipes.length > 1 ? ` (вариантов рецепта: ${recipes.length}, показан ближайший)` : ''
  return best.parts.join(', ') + suffix
}

export { ensureTable, craft }

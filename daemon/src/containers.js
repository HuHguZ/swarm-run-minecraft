'use strict'
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, xyz, travelXZ } = require('./movement')
const { GROUPS, countOf, countItems, diffItems, resolveItemNames, itemNamed } = require('./items')
const { withTimeout, placeBlockAt, escapePit } = require('./build')
const actions = require('./actions')
const worlds = require('./worlds')

// Everything that needs a block UI open in front of the bot. Grouped in one
// file because furnaces and chests fail the same way on 1.21.11 — the server
// silently ignores the activation, mineflayer waits 20s for a window that never
// arrives, and a window left open wedges the body so nothing else can open one.
//
// The base lives here too (bottom of the file) rather than in survival.js: a
// base IS its stash, and the only thing that makes the stash cheap for the
// brain is that the cache is written by the very chest calls above it.

// ---------------------------------------------------------------- tables

// minecraft-data 3.112.0 ships NO smelting recipes and NO fuel burn times for
// 1.21.11 — recipes.json is crafting-only and an item entry carries nothing but
// {id,name,displayName,stackSize}. Both tables below are therefore written out
// by hand from vanilla; every name in them was checked against itemsByName.
const SMELTS = {
  iron_ore: 'iron_ingot',
  deepslate_iron_ore: 'iron_ingot',
  raw_iron: 'iron_ingot',
  gold_ore: 'gold_ingot',
  deepslate_gold_ore: 'gold_ingot',
  nether_gold_ore: 'gold_ingot',
  raw_gold: 'gold_ingot',
  copper_ore: 'copper_ingot',
  deepslate_copper_ore: 'copper_ingot',
  raw_copper: 'copper_ingot',
  ancient_debris: 'netherite_scrap',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  nether_quartz_ore: 'quartz',
  sand: 'glass',
  red_sand: 'glass',
  cobblestone: 'stone',
  stone: 'smooth_stone',
  cobbled_deepslate: 'deepslate',
  clay_ball: 'brick',
  clay: 'terracotta',
  netherrack: 'nether_brick',
  sandstone: 'smooth_sandstone',
  red_sandstone: 'smooth_red_sandstone',
  quartz_block: 'smooth_quartz',
  basalt: 'smooth_basalt',
  stone_bricks: 'cracked_stone_bricks',
  nether_bricks: 'cracked_nether_bricks',
  polished_blackstone_bricks: 'cracked_polished_blackstone_bricks',
  cactus: 'green_dye',
  sea_pickle: 'lime_dye',
  chorus_fruit: 'popped_chorus_fruit',
  wet_sponge: 'sponge',
  porkchop: 'cooked_porkchop',
  beef: 'cooked_beef',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp'
}

// Any log burns down to charcoal, and there are 45 log-shaped item names on
// 1.21.11 — a regex beats 45 more table rows. Nether wood is the exception:
// crimson and warped do not burn at all, neither into charcoal nor as fuel.
const WOOD = /_log$|_wood$|_stem$|_hyphae$/
const isFirewood = name => WOOD.test(name) && !/crimson|warped/.test(name)

const smeltOutput = name => SMELTS[name] || (isFirewood(name) ? 'charcoal' : null)

// A blast furnace only accepts ore and raw metal, a smoker only meat and
// vegetables; both cook twice as fast. A plain furnace accepts everything,
// which is why it is the fallback and the only thing we ever build ourselves.
const ORE_LIKE = /_ore$|^raw_(iron|gold|copper)$|^ancient_debris$/
const FOOD_LIKE = /^(porkchop|beef|chicken|mutton|rabbit|cod|salmon|potato)$/
const KINDS = {
  furnace: { ms: 10000, takes: () => true },
  blast_furnace: { ms: 5000, takes: n => ORE_LIKE.test(n) },
  smoker: { ms: 5000, takes: n => FOOD_LIKE.test(n) }
}

// Items smelted per unit of fuel, ordered the way a player reaches into the
// bag rather than by raw burn value: coal is dug for exactly this job, planks
// and logs are the wood the tools are made of, a blaze rod is brewing stock.
// `keep` is the reserve we refuse to burn, so smelting can never eat the last
// of a crafting material — and nothing here is a tool, a bed or armour.
const FUELS = [
  { name: 'coal', items: 8 },
  { name: 'charcoal', items: 8 },
  { name: 'coal_block', items: 80 },
  { name: 'dried_kelp_block', items: 20 },
  { group: 'any_planks', items: 1.5, keep: 24 },
  { group: 'any_wood', items: 1.5, keep: 8 },
  { name: 'stick', items: 0.5, keep: 16 },
  { name: 'bamboo', items: 0.25 },
  { name: 'blaze_rod', items: 12, keep: 2 },
  // 100 items per bucket and we still never reach for it unasked: the empty
  // bucket stays behind in the fuel slot and jams the next load.
  { name: 'lava_bucket', items: 100, onlyIfAsked: true }
]

// ---------------------------------------------------------------- windows

const slotCount = (item, name) => (item && item.name === name ? item.count : 0)
const stackOf = (mcData, name) => (mcData.itemsByName[name] ? mcData.itemsByName[name].stackSize : 64)

// bot.currentWindow is the only honest answer to "is that screen still up".
// The server closes a window from its own side — we drift out of range, someone
// breaks the block, we get knocked back — and from then on clickWindow() falls
// back to the PLAYER inventory, where slot 1 is a crafting square and not the
// fuel slot. That is how a stack of coal ends up in the 2x2 grid, invisible to
// every countItems() afterwards. So nothing gets clicked without asking first.
const live = (bot, win) => bot.currentWindow === win

// The brain writes these numbers by hand, and a count that is not a number is
// far worse than a wrong one: mineflayer's transfer() does `count -= 1` until
// it reaches zero, and NaN never does — it clicks forever and the server drops
// us for packet spam.
function budgetOf (count) {
  if (count === null || count === undefined || count === '') return Infinity
  const n = Math.floor(Number(count))
  if (!Number.isFinite(n) || n < 0) throw new Error(`не понял, сколько: ${count}`)
  return n
}

// pathfinder.goto has no deadline of its own and no idea that the intent above
// it has already answered the brain — an abandoned walk keeps the body moving
// through the next action. Both ends are handled here and on ctl.onAbort.
const WALK_MS = 12000

async function walkTo (bot, goal, ms = WALK_MS) {
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, 'дойти не успел')
  } catch (err) {
    try { bot.pathfinder.setGoal(null) } catch {}
    throw err
  }
}

function stopWalkingOnAbort (bot, ctl) {
  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  })
}

// close() is not politeness. It is the only path that copies the window's
// player rows back into bot.inventory, so every countItems() after an unclosed
// window is a lie. Once only: a second close would copy those same rows again
// over whatever has happened since.
function closer (win) {
  let done = false
  return () => {
    if (done) return
    done = true
    try { win.close() } catch {}
  }
}

// runIntent fires every ctl.onAbort callback the moment it aborts and never
// looks at the array again, so a close registered by a call that was still
// opening when that happened would never run. Close on the spot instead.
function guardWindow (ctl, win) {
  win.ndOwned = true // see raceOpen: marks this window as somebody's live handle
  const shut = closer(win)
  if (ctl.aborted) shut()
  else ctl.onAbort.push(shut)
  return shut
}

// A window we are not holding a handle for still blocks the next open — the
// server refuses to show a second screen — and it can arrive seconds after we
// gave up waiting for it.
async function closeStray (bot) {
  const win = bot.currentWindow
  if (!win) return
  try {
    if (typeof win.close === 'function') win.close()
    else {
      // No close() means extendWindow never ran, which means the item list
      // never arrived, which means every slot in this window is still null.
      // bot.closeWindow() would copy those nulls over the player rows of
      // bot.inventory and leave the bot believing it owns nothing — and the
      // server, which thinks we already know our own inventory, never resends
      // it. So write the packet by hand and skip the copy.
      bot._client.write('close_window', { windowId: win.id })
      bot.currentWindow = null
      bot.emit('windowClose', win)
    }
  } catch {}
  await sleep(150)
}

// The losing side of the race is not harmless. mineflayer goes on waiting its
// own 20s, and the window it eventually hands back is one nobody holds a
// reference to — an open screen that blocks every UI for the rest of the
// session. So keep the handle alive long enough to shut it.
async function raceOpen (bot, opening, ms, message) {
  let gaveUp = false
  opening.then(
    async win => {
      if (!gaveUp) return
      // mineflayer's windowOpen listener from a dropped activation is still
      // armed, so it resolves on whatever opens NEXT — a "late" window is
      // sometimes the next call's live one. Let its owner claim it first.
      await sleep(250)
      // closeWindow() nulls bot.currentWindow and copies the window's player
      // rows into bot.inventory whichever window object it is handed, so
      // closing one that is no longer on screen corrupts the one that is.
      if (!win.ndOwned && bot.currentWindow === win) { try { win.close() } catch {} }
    },
    () => {} // the loser still rejects, 20s from now, with nobody listening
  )
  try {
    return await withTimeout(opening, ms, message)
  } catch (err) {
    gaveUp = true
    await closeStray(bot)
    throw err
  }
}

// The window's own 'update' as a wake-up tick, with a poll as the floor: a
// furnace that never lights sends nothing at all, and waiting on the event
// alone would hang until the intent timeout.
function waitUpdate (win, ms) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      win.removeListener('update', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    win.once('update', done)
  })
}

// Putting a loaded cursor back is only safe while the screen is still up:
// putSelectedItemRange loops until THIS window's cursor is empty, but every
// click inside it goes to bot.currentWindow instead — so on a window the
// server has taken away the cursor never clears and it writes window_click
// packets in a tight loop until we are dropped for spam.
async function unloadCursor (bot, win, start, end) {
  if (!win.selectedItem || !live(bot, win)) return
  try { await bot.putSelectedItemRange(start, end, win, null) } catch {}
}

// transfer() fills the destination slot and then throws 'destination full'
// with the remainder still sitting on the cursor; closing the window at that
// point makes the server drop it on the ground. So never overfill a slot.
function roomFor (slotItem, name, stackSize) {
  if (!slotItem) return stackSize
  if (slotItem.name !== name) return 0
  return Math.max(0, stackSize - slotItem.count)
}

// putAway tosses whatever it could not fit on the ground, so nothing comes out
// of a container until the WHOLE stack has somewhere to land — one empty slot
// is not enough room for a stack of 64 when the rest of the bag is full. The
// same count on the other side is what keeps transfer() from ever reaching
// 'destination full', which is the only way the cursor ends up loaded.
function roomIn (win, start, end, name, stackSize) {
  let room = 0
  for (let i = start; i < end; i++) {
    const item = win.slots[i]
    if (!item) room += stackSize
    else if (item.name === name) room += Math.max(0, stackSize - item.count)
  }
  return room
}

const bagRoom = (win, name, stackSize) => roomIn(win, win.inventoryStart, win.inventoryEnd, name, stackSize)
const shelfRoom = (win, name, stackSize) => roomIn(win, 0, win.inventoryStart, name, stackSize)

function canStow (win, name, stackSize, count = 1) {
  return bagRoom(win, name, stackSize) >= count
}

// Clear out a slot somebody else left loaded. `keep` is the one item we are
// happy to find there — our own fuel, or ore already waiting. Returns how much
// came back, because it lands in the same bag the smelt is measured against.
async function clearSlot (bot, mcData, win, item, keep, take) {
  if (!item || item.name === keep || !live(bot, win)) return 0
  if (!canStow(win, item.name, stackOf(mcData, item.name), item.count)) return 0
  // Read the count first: the take mutates the very Item object it is handed,
  // so afterwards item.count is 0 and the caller would report nothing moved.
  const had = item.count
  try { await take() } catch { return 0 }
  return had
}

// ---------------------------------------------------------------- smelt

// The brain says "iron_ingot" about as often as "raw_iron", so accept both ends
// of the recipe. Naming the output picks whichever input we are actually
// carrying the most of, which is what a player would grab.
function resolveSmelt (bot, want) {
  const asked = String(want || '').trim()
  if (!asked) throw new Error('не сказано, что плавить')

  const direct = smeltOutput(asked)
  // "stone" is both an input and an output. Reading it as an input first is
  // right when the bag holds stone, but "выплавь stone" from someone carrying
  // cobblestone means the recipe, not smooth_stone.
  if (direct && countOf(bot, asked)) return { from: asked, into: direct }

  const inputs = [...new Set(Object.keys(SMELTS).filter(k => SMELTS[k] === asked))]
  if (asked === 'charcoal') {
    for (const i of bot.inventory.items()) if (isFirewood(i.name) && !inputs.includes(i.name)) inputs.push(i.name)
  }
  if (!inputs.length) {
    if (direct) return { from: asked, into: direct }
    // Charcoal is a recipe we know perfectly well; what is missing is the wood.
    if (asked === 'charcoal') throw new Error('нет брёвен на уголь (адское дерево не горит)')
    throw new Error(`не знаю, как выплавить ${asked}`)
  }

  inputs.sort((a, b) => countOf(bot, b) - countOf(bot, a))
  if (!countOf(bot, inputs[0])) {
    throw new Error(`не из чего плавить ${asked}: нужен ${inputs.slice(0, 3).join(' или ')}`)
  }
  return { from: inputs[0], into: asked }
}

// How much of one fuel we are willing to burn, and which exact item name it is
// (the biggest pile — one fuel slot holds one kind, so burn the spruce planks
// rather than the single cherry one).
function fuelOption (bot, entry) {
  let names = []
  if (entry.name) {
    if (countOf(bot, entry.name)) names = [entry.name]
  } else {
    const re = GROUPS[entry.group]
    const piles = {}
    for (const i of bot.inventory.items()) {
      if (!re.test(i.name)) continue
      if (entry.group === 'any_wood' && !isFirewood(i.name)) continue
      piles[i.name] = (piles[i.name] || 0) + i.count
    }
    names = Object.keys(piles).sort((a, b) => piles[b] - piles[a])
  }
  if (!names.length) return null

  const total = names.reduce((n, name) => n + countOf(bot, name), 0)
  const spare = Math.min(total - (entry.keep || 0), countOf(bot, names[0]))
  if (spare < 1 || Math.floor(spare * entry.items) < 1) return null
  return { name: names[0], items: entry.items, spare }
}

function pickFuel (bot, need, asked) {
  if (asked) {
    // A group alias is the same vocabulary mine() and chestPut() take, so it
    // has to work here too — with the reserve dropped, which is the whole
    // point of naming the fuel by hand.
    const byGroup = FUELS.find(f => f.group === asked)
    if (byGroup) {
      const option = fuelOption(bot, { group: byGroup.group, items: byGroup.items })
      if (!option) throw new Error(`нет ${asked} в инвентаре`)
      return option
    }
    const entry = FUELS.find(f => f.name === asked) ||
      FUELS.find(f => f.group && GROUPS[f.group].test(asked))
    if (!entry) throw new Error(`не знаю, сколько горит ${asked}`)
    // Crimson and warped are wood-shaped and burn in nothing. Loading them
    // leaves a furnace that never lights, which reads as "печка погасла" ten
    // seconds later instead of as the flat refusal it is.
    if (entry.group === 'any_wood' && !isFirewood(asked)) throw new Error(`${asked} не горит`)
    const have = countOf(bot, asked)
    if (!have) throw new Error(`нет ${asked} в инвентаре`)
    return { name: asked, items: entry.items, spare: have }
  }

  const options = FUELS.filter(f => !f.onlyIfAsked).map(f => fuelOption(bot, f)).filter(Boolean)
  if (!options.length) return null
  for (const o of options) if (o.spare >= Math.ceil(need / o.items)) return o
  // Nothing covers the whole batch. Burn whatever yields the most and report a
  // short run — three ingots out of eight still beat refusing to start.
  return options.reduce((a, b) => (b.spare * b.items > a.spare * a.items ? b : a))
}

function findFurnace (bot, mcData, from, maxDistance) {
  const ids = Object.keys(KINDS)
    .filter(k => KINDS[k].takes(from))
    .map(k => mcData.blocksByName[k].id)
  const found = bot.findBlock({ matching: ids, maxDistance })
  return found || null
}

function cobbleOnHand (bot) {
  return countOf(bot, 'cobblestone') + countOf(bot, 'cobbled_deepslate') + countOf(bot, 'blackstone')
}

async function ensureFurnace (session, ctl, from) {
  const bot = session.bot
  const mcData = session.mcData

  let block = findFurnace(bot, mcData, from, 4)
  if (block) return block

  const far = findFurnace(bot, mcData, from, 20)
  if (far) {
    const p = far.position
    try { await walkTo(bot, new goals.GoalNear(p.x, p.y, p.z, 2)) } catch {}
    block = findFurnace(bot, mcData, from, 4)
    if (block) return block
  }

  if (!itemNamed(bot, 'furnace')) {
    const cobble = cobbleOnHand(bot)
    if (cobble < 8) {
      throw new Error(`печки нет: рядом не вижу, в инвентаре нет, на крафт не хватает камня (${cobble} из 8)`)
    }
    await actions.craft(session, ctl, { item: 'furnace', count: 1 })
  }
  await actions.place(session, ctl, { block: 'furnace' })
  block = findFurnace(bot, mcData, from, 4)
  if (!block) throw new Error('печку поставил, а в мире её не вижу')
  return block
}

// The craft() lesson applied to furnaces: a block we merely walked up to
// sometimes never opens, but one we just put down at our own feet does.
async function placeFreshFurnace (session, ctl) {
  const bot = session.bot
  if (!itemNamed(bot, 'furnace')) {
    if (cobbleOnHand(bot) < 8) return null
    try { await actions.craft(session, ctl, { item: 'furnace', count: 1 }) } catch { return null }
  }
  try { await actions.place(session, ctl, { block: 'furnace' }) } catch { return null }
  return bot.findBlock({ matching: [session.mcData.blocksByName.furnace.id], maxDistance: 4 })
}

// openFurnace inherits mineflayer's 20s windowOpen wait and, on the way out,
// leaves bot.currentWindow set if the window turns up late. Race it short and
// sweep up after ourselves either way.
async function openFurnaceAt (bot, block, ms = 6000) {
  await closeStray(bot)
  // activateBlock does its own lookAt(pos, false), which blocks on a physics
  // 'move' that does not always come. Aiming at exactly the same point with
  // force:true first makes that call return on the spot.
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
  return raceOpen(bot, bot.openFurnace(block), ms, 'печка не открылась')
}

async function smelt (session, ctl, { item, count = 1, fuel = null, timeoutSeconds = 120 } = {}) {
  const bot = session.bot
  const mcData = session.mcData

  const asked = Math.floor(Number(count))
  if (!Number.isFinite(asked) || asked < 1) throw new Error(`не понял, сколько плавить: ${count}`)
  const seconds = Math.floor(Number(timeoutSeconds))
  const runMs = Math.max(20, Math.min(600, Number.isFinite(seconds) ? seconds : 120)) * 1000

  const { from, into } = resolveSmelt(bot, item)
  const inputData = mcData.itemsByName[from]
  if (!inputData) throw new Error(`нет такого предмета: ${from}`)
  const have = countOf(bot, from)
  if (!have) throw new Error(`нет ${from} в инвентаре`)

  // One furnace slot holds one stack; a bigger order is several calls.
  const need = Math.min(asked, have, 64)

  const chosen = pickFuel(bot, need, fuel)
  // Naming a fuel explicitly bypasses the `keep` reserves — that is the escape
  // hatch when the only wood left is the wood we were saving.
  if (!chosen) throw new Error('нечем топить: угля нет, а последнее дерево жечь не буду — скажи fuel явно, если надо')
  const fuelData = mcData.itemsByName[chosen.name]
  if (!fuelData) throw new Error(`нет такого предмета: ${chosen.name}`)

  const units = Math.max(1, Math.min(Math.ceil(need / chosen.items), chosen.spare, fuelData.stackSize))
  const covered = Math.floor(units * chosen.items)
  if (covered < 1) throw new Error(`${chosen.name} не хватит даже на один предмет`)
  const batch = Math.min(need, covered)

  stopWalkingOnAbort(bot, ctl)
  let block = await ensureFurnace(session, ctl, from)
  let note = covered < need ? `топлива хватило только на ${covered}` : null

  // Snapshot after the furnace exists: crafting one costs cobblestone, and that
  // has nothing to do with what the smelt earned.
  const before = countItems(bot)

  let furnace
  try {
    furnace = await openFurnaceAt(bot, block)
  } catch (err) {
    if (!/windowOpen|не открылась/.test(err.message)) throw err
    const fresh = await placeFreshFurnace(session, ctl)
    if (!fresh) throw new Error(`печка не открылась и новую поставить не вышло: ${err.message}`)
    furnace = await openFurnaceAt(bot, fresh)
    block = fresh
    note = note ? `${note}; печку пришлось переставить` : 'печку пришлось переставить'
  }

  const kind = KINDS[block.name] || KINDS.furnace
  const shut = guardWindow(ctl, furnace)
  // A server-side close (we get knocked out of range, someone breaks the
  // furnace) fires only the bot's 'windowClose', never the window's own
  // 'close' — and mineflayer unhooks its packet listener only on the latter.
  // Eleven smelts later that is a MaxListenersExceeded warning and stale ids.
  // on(), not once(): any other window closing first would eat a once() and
  // leave this furnace's listener hooked forever. The finally unhooks it.
  const onClose = w => { if (w === furnace) { try { furnace.emit('close') } catch {} } }
  bot.on('windowClose', onClose)

  let made = 0
  let loadedFuel = 0
  let backFuel = 0
  let salvaged = 0
  let stopped = null
  let inside = null

  try {
    // ctl.abort() may have fired while the window was still opening; its
    // callbacks have already run, so every click from here would go into a
    // window guardWindow just shut.
    if (ctl.aborted) throw new Error('прервано')

    // Somebody else's leftovers in a slot make transfer() throw 'destination
    // full' before it moves anything, so clear a foreign stack out first. The
    // output slot goes first and goes unconditionally: a furnace whose output
    // holds anything but what we are about to make refuses to smelt at all,
    // and even our own ingots sitting there would eat the room we need.
    const stuckOut = furnace.outputItem()
    const rescued = await clearSlot(bot, mcData, furnace, stuckOut, null, () => furnace.takeOutput())
    // Only somebody's ingots of the very thing we are about to make have to be
    // discounted from the count later; anything else in there is just a find.
    if (stuckOut && stuckOut.name === into) salvaged = rescued
    await clearSlot(bot, mcData, furnace, furnace.fuelItem(), chosen.name, () => furnace.takeFuel())
    await clearSlot(bot, mcData, furnace, furnace.inputItem(), from, () => furnace.takeInput())
    if (!live(bot, furnace)) throw new Error('печка закрылась')

    // The zero line for counting, read before the load rather than after it:
    // a furnace we walked up to may already be mid-cook, and anything it drops
    // in the output while we are still clicking is ours as much as the rest.
    const started = slotCount(furnace.outputItem(), into)

    // Decide the input load before moving anything: a furnace whose input slot
    // is still full of someone else's ore is a refusal, and refusing after the
    // fuel is already inside means walking away from the coal we just spent.
    const inputRoom = roomFor(furnace.inputItem(), from, inputData.stackSize)
    const target = Math.min(batch, inputRoom, furnace.count(inputData.id, null))
    if (target < 1) throw new Error(`во входной слот печки ${from} не влезает`)

    // Fuel first while the furnace is cold: it lights the instant the input
    // lands, and the progress packets we tick on only flow once it is lit.
    const fuelRoom = roomFor(furnace.fuelItem(), chosen.name, fuelData.stackSize)
    const fuelUnits = Math.min(units, fuelRoom, furnace.count(fuelData.id, null))
    if (fuelUnits > 0) {
      try {
        await furnace.putFuel(fuelData.id, null, fuelUnits)
        loadedFuel += fuelUnits
      } catch (err) {
        // transfer() gives up with the remainder still on the cursor, and a
        // window closed on a loaded cursor makes the server drop it at our feet.
        await unloadCursor(bot, furnace, furnace.inventoryStart, furnace.inventoryEnd)
        throw new Error(`топливо в печку не легло: ${err.message}`)
      }
      await sleep(250)
    }

    if (!live(bot, furnace)) throw new Error('печка закрылась')
    try {
      await furnace.putInput(inputData.id, null, target)
    } catch (err) {
      await unloadCursor(bot, furnace, furnace.inventoryStart, furnace.inventoryEnd)
      // The coal is already inside and burning down for nothing. Take back
      // whatever has not caught yet rather than walking away from it. Through
      // clearSlot, because takeFuel() on a window the server has closed means
      // putAway clicking slot 1 of the PLAYER inventory — the 2x2 grid.
      if (loadedFuel) {
        backFuel += await clearSlot(bot, mcData, furnace, furnace.fuelItem(), null, () => furnace.takeFuel())
      }
      throw new Error(`${from} в печку не лёг: ${err.message}`)
    }
    await sleep(250)

    const deadline = Date.now() + runMs
    // Progress is unreadable on this version — it is null until packets arrive
    // and the first reading is a spurious 0, because the fraction is computed
    // against a total that only lands afterwards. So watch the slots move, and
    // treat "nothing has moved for longer than one item takes" as gone dark.
    const stallMs = kind.ms + 8000
    let seen = null
    let lastChange = Date.now()

    while (!ctl.aborted) {
      if (!live(bot, furnace)) { stopped = 'печка закрылась'; break }
      const inCount = slotCount(furnace.inputItem(), from)
      const outCount = slotCount(furnace.outputItem(), into)
      const mark = `${inCount}/${outCount}`
      if (mark !== seen) {
        seen = mark
        lastChange = Date.now()
      }
      made = outCount - started
      if (made >= target) break
      if (Date.now() >= deadline) {
        stopped = 'время вышло'
        break
      }
      // The last item leaves the input slot a tick before it lands in the
      // output, so an empty input is only final once nothing else moves.
      if (!inCount && Date.now() - lastChange > 3000) {
        stopped = made < target ? 'плавить больше нечего' : null
        break
      }
      if (Date.now() - lastChange > stallMs) {
        // Only an empty fuel slot is a furnace that ran out. If our coal is
        // still lying in there unburnt then the fuel was never the problem,
        // and topping it up just feeds a furnace that is stuck for some other
        // reason — one stall window at a time, until the whole bag is inside.
        const dry = !furnace.fuelItem()
        const inBag = dry ? furnace.count(fuelData.id, null) : 0
        const room = roomFor(furnace.fuelItem(), chosen.name, fuelData.stackSize)
        const add = Math.min(inBag, room, Math.max(1, Math.ceil((target - made) / chosen.items)))
        if (add > 0) {
          try {
            await furnace.putFuel(fuelData.id, null, add)
            loadedFuel += add
          } catch {
            await unloadCursor(bot, furnace, furnace.inventoryStart, furnace.inventoryEnd)
            stopped = 'печка погасла, подбросить не вышло'
            break
          }
          lastChange = Date.now()
          await sleep(250)
          continue
        }
        stopped = dry ? 'печка погасла — топливо кончилось' : 'печка стоит и ничего не плавит'
        break
      }
      await waitUpdate(furnace, 1000)
    }
    // On abort the cleanup on ctl.onAbort has already closed the window, and a
    // window the server took away is no better: every click from here would
    // land in the player inventory instead. Read the slots, click nothing.
    const dead = ctl.aborted || !live(bot, furnace)
    if (dead) stopped = stopped || (ctl.aborted ? 'прервано' : 'печка закрылась')

    // out.name, not `into`: a foreign stack clearSlot could not lift out at the
    // start is still sitting there, and it is that stack we need room for.
    const out = dead ? null : furnace.outputItem()
    if (out && canStow(furnace, out.name, stackOf(mcData, out.name), out.count)) {
      try { await furnace.takeOutput() } catch {}
      await sleep(200)
    } else if (out) {
      stopped = stopped || 'инвентарь полон — выплавленное осталось в печке'
    }

    // Never walk away from our own goods. Unburnt fuel comes back too — what is
    // already alight is gone either way, the slot only holds units not yet lit.
    const restFuel = dead || !live(bot, furnace) ? null : furnace.fuelItem()
    const back = restFuel ? restFuel.count : 0
    if (restFuel && canStow(furnace, restFuel.name, stackOf(mcData, restFuel.name), back)) {
      try { await furnace.takeFuel(); backFuel += back } catch {}
    }
    const restInput = dead || !stopped || !live(bot, furnace) ? null : furnace.inputItem()
    if (restInput && canStow(furnace, restInput.name, stackOf(mcData, restInput.name), restInput.count)) {
      try { await furnace.takeInput() } catch {}
    }
  } finally {
    // A cursor still holding something turns close() into "drop it on the
    // ground", so it goes back in the bag before the screen comes down.
    await unloadCursor(bot, furnace, furnace.inventoryStart, furnace.inventoryEnd)
    // Counted here, not above, so a throw on the way in is reported too.
    const rest = {}
    for (const it of [furnace.outputItem(), furnace.inputItem(), furnace.fuelItem()]) {
      if (it) rest[it.name] = (rest[it.name] || 0) + it.count
    }
    if (Object.keys(rest).length) inside = rest
    shut()
    bot.removeListener('windowClose', onClose)
    // An abort makes runIntent throw this whole result away and a throw hides
    // it too, so goods we are walking away from go in the journal: coordinates
    // that live in one tool result are lost at the next compaction.
    if (inside) {
      const what = Object.entries(inside).map(([n, c]) => `${n}×${c}`).join(', ')
      try {
        session.journal.append('печка', `осталось внутри: ${what}${stopped ? ` (${stopped})` : ''}`, block.position)
      } catch {}
    }
    await sleep(150)
  }

  const gained = diffItems(before, countItems(bot))
  // Ingots someone else left in the output slot land in the same bag and would
  // otherwise be counted as ours.
  const earned = Math.max(0, (gained[into] || 0) - salvaged)
  return {
    smelted: into,
    count: earned || Math.max(0, made),
    from,
    fuel: chosen.name,
    used: Math.max(0, loadedFuel - backFuel),
    gained,
    kind: block.name,
    at: xyz(block.position),
    foundInside: salvaged || undefined,
    leftInside: inside || undefined,
    note: note || undefined,
    stopped: stopped || undefined
  }
}

// ---------------------------------------------------------------- chests

// GROUPS.any_container is the brain-facing alias and stops at ender chests;
// openContainer also takes placed shulker boxes, so match those too.
const CONTAINER = /^(chest|trapped_chest|barrel|ender_chest|shulker_box|[a-z_]+_shulker_box)$/

// The server's block_interaction_range is 4.5, but canDigBlock — what
// actions.reachBlock gates on — allows 5.1. That gap is exactly the case where
// pathfinder reports success and the chest still never opens, so containers
// get their own, stricter check with slack for the body drifting.
const EYE = 1.62
const REACH = 3.6

// One budget for the whole call, walk included. session.js allows a chest
// intent 60s; three walk plans and two open attempts add up to more than that
// on their own, and a walk that eats the lot leaves nothing for the clicking.
const CHEST_MS = 45000

function inReach (bot, block) {
  return block.position.offset(0.5, 0.5, 0.5)
    .distanceTo(bot.entity.position.offset(0, EYE, 0)) <= REACH
}

function containerAt (bot, x, y, z) {
  const block = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
  if (!block) throw new Error(`на ${x},${y},${z} мир не прогружен`)
  if (!CONTAINER.test(block.name)) throw new Error(`на ${x},${y},${z} не контейнер, а ${block.name}`)
  return block
}

async function reachContainer (bot, ctl, block, deadline) {
  if (inReach(bot, block)) return
  const p = block.position
  const plans = [
    () => new goals.GoalLookAtBlock(p, bot.world, { reach: 3.5 }),
    () => new goals.GoalNear(p.x, p.y, p.z, 2),
    () => new goals.GoalNear(p.x, p.y, p.z, 1)
  ]
  let last = null
  for (const make of plans) {
    if (ctl.aborted) return
    const left = deadline - Date.now()
    if (left <= 0) break
    try {
      await walkTo(bot, make(), Math.min(WALK_MS, left))
      if (inReach(bot, block)) return
    } catch (e) {
      last = e
    }
  }
  if (!inReach(bot, block)) {
    const at = xyz(p)
    throw new Error(`не дотянуться до ${block.name} на ${at.x},${at.y},${at.z}${last ? ': ' + last.message : ''}`)
  }
}

async function openContainerAt (bot, ctl, block, deadline) {
  const aim = block.position.offset(0.5, 0.5, 0.5)
  let last = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctl.aborted) throw new Error('прервано')
    // The first attempt goes ahead whatever the clock says — opening the thing
    // is the point of the call, and refusing to try at all is a worse answer
    // than trying once and failing.
    if (attempt && Date.now() >= deadline) break
    await closeStray(bot)
    await bot.lookAt(aim, true) // force: see openFurnaceAt
    try {
      return await raceOpen(bot, bot.openContainer(block), 6000, `${block.name} не открылся`)
    } catch (err) {
      last = err
      if (!/windowOpen|не открылся/.test(err.message)) throw err
      // Out of reach is far and away the usual cause, and the reach check above
      // only guarantees we were close enough when we started walking.
      const p = block.position
      const left = deadline - Date.now()
      if (left <= 0) break
      try { await walkTo(bot, new goals.GoalNear(p.x, p.y, p.z, 1), Math.min(WALK_MS, left)) } catch {}
    }
  }
  throw new Error(`${block.name} не открылся: ${last.message}`)
}

async function findAndOpen (session, ctl, { x, y, z }, deadline) {
  const bot = session.bot
  // The one place all three chest actions walk from, so the teardown for the
  // walk lives here too.
  stopWalkingOnAbort(bot, ctl)
  const given = x !== undefined && x !== null && y !== undefined && y !== null && z !== undefined && z !== null
  const block = given
    ? containerAt(bot, x, y, z)
    : bot.findBlock({ matching: b => !!b && CONTAINER.test(b.name), maxDistance: 16 })
  if (!block) throw new Error('рядом нет ни сундука, ни бочки — в 16 блоках пусто')
  await reachContainer(bot, ctl, block, deadline)
  const win = await openContainerAt(bot, ctl, block, deadline)
  return { block, win }
}

const mapOf = items => items.reduce((o, i) => { o[i.name] = (o[i.name] || 0) + i.count; return o }, {})

// inventoryStart is the container's own size: 27 for a barrel or single chest,
// 54 once the server decides it is a double.
function shelfFacts (win) {
  const slots = win.inventoryStart
  const used = win.containerItems().length
  return { slots, used, free: slots - used }
}

async function chestList (session, ctl, { x, y, z } = {}) {
  const { block, win } = await findAndOpen(session, ctl, { x, y, z }, Date.now() + CHEST_MS)
  const shut = guardWindow(ctl, win)
  try {
    const facts = { contents: mapOf(win.containerItems()), ...shelfFacts(win) }
    // The shelf is open and counted right now. Writing that into the base
    // record here is the whole reason `stash mode=list` can answer later
    // without spending a turn walking back to look.
    const base = touchChest(session, block, facts)
    return { at: xyz(block.position), kind: block.name, ...facts, base: base || undefined }
  } finally {
    shut()
    await sleep(120)
  }
}

// One deposit pass over an already-open window. Extracted so the stash reuses
// the parts that were paid for in game: the 250 ms re-count (1.21.11 never
// acknowledges a container click, so counting the chest again is the only
// proof), and putting the cursor back before the screen comes down (a loaded
// cursor at close time is a stack on the floor).
//
// `caps` is the per-name ceiling the stash needs and chest_put does not have:
// "положи всё лишнее" means leaving sixteen steaks in the bag, not all of them.
async function depositPass (bot, mcData, win, names, { budget = Infinity, caps = null, deadline = Infinity, ctl = null } = {}) {
  const put = {}
  const left = {}
  let stopped = null
  let full = false

  for (const name of names) {
    if ((ctl && ctl.aborted) || budget <= 0) break
    if (Date.now() >= deadline) { stopped = 'время вышло'; break }
    if (!live(bot, win)) { left[name] = 'сундук закрылся'; break }
    const data = mcData.itemsByName[name]
    if (!data) { left[name] = 'нет такого предмета'; continue }

    const have = win.count(data.id, null)
    if (!have) { left[name] = 'нет в инвентаре'; continue }
    const cap = caps && caps[name] !== undefined ? caps[name] : Infinity
    // Ask for no more than the shelf can hold: that is what keeps transfer()
    // from ever reaching 'destination full' with a loaded cursor.
    const wanted = Math.min(budget, have, cap)
    if (wanted <= 0) continue
    const want = Math.min(wanted, shelfRoom(win, name, data.stackSize))

    let noRoom = want < wanted
    let moved = 0
    if (want > 0) {
      const before = win.containerCount(data.id, null)
      try {
        await win.deposit(data.id, null, want, null)
      } catch (err) {
        // Belt and braces: the cursor may still be loaded, and closing the
        // window then makes the server drop it on the ground. Put it back
        // before deciding anything, whatever the reason.
        await unloadCursor(bot, win, win.inventoryStart, win.inventoryEnd)
        if (/destination full/.test(err.message)) noRoom = true
        else left[name] = err.message
      }
      await sleep(250)
      moved = Math.max(0, win.containerCount(data.id, null) - before)
    }

    if (moved > 0) put[name] = moved
    budget -= moved
    if (noRoom) full = true
    const kept = wanted - moved
    if (kept > 0 && !left[name]) {
      left[name] = noRoom ? `сундук полон, ${kept} осталось при мне` : `перенёс ${moved} из ${wanted}`
    }
    // No break on a full chest: the next name may still have a part-filled
    // stack to top up, and if it does not it costs one more empty pass and
    // says so in `left` instead of silently going missing from the report.
  }
  return { put, left, budget, full, stopped }
}

async function withdrawPass (bot, mcData, win, names, { budget = Infinity, caps = null, deadline = Infinity, ctl = null } = {}) {
  const took = {}
  const left = {}
  let stopped = null
  let full = false

  for (const name of names) {
    if ((ctl && ctl.aborted) || budget <= 0) break
    if (Date.now() >= deadline) { stopped = 'время вышло'; break }
    if (!live(bot, win)) { left[name] = 'сундук закрылся'; break }
    const data = mcData.itemsByName[name]
    if (!data) { left[name] = 'нет такого предмета'; continue }

    const stock = win.containerCount(data.id, null)
    if (!stock) { left[name] = 'в контейнере нет'; continue }

    const cap = caps && caps[name] !== undefined ? caps[name] : Infinity
    // Take only as much as the bag can actually hold — a stack pulled out
    // with nowhere to put it is a stack on the ground.
    const wanted = Math.min(budget, stock, cap)
    if (wanted <= 0) continue
    const want = Math.min(wanted, bagRoom(win, name, data.stackSize))
    let noRoom = want < wanted
    let moved = 0

    if (want > 0) {
      const before = win.count(data.id, null)
      try {
        await win.withdraw(data.id, null, want, null)
      } catch (err) {
        // Whatever went wrong, the cursor may still be holding the stack, and
        // a window closed on a full cursor drops it. Back into the chest first.
        await unloadCursor(bot, win, 0, win.inventoryStart)
        // mineflayer's own "inventory is full" guard reads bot.inventory, which
        // froze when the window opened, so it fires on stale numbers too.
        if (/inventory is full|destination full/i.test(err.message)) noRoom = true
        else left[name] = err.message
      }
      await sleep(250)
      moved = Math.max(0, win.count(data.id, null) - before)
    }

    if (moved > 0) took[name] = moved
    budget -= moved
    if (noRoom) full = true
    const kept = wanted - moved
    if (kept > 0 && !left[name]) {
      left[name] = noRoom ? `инвентарь полон, ${kept} осталось в сундуке` : `взял ${moved} из ${wanted}`
    }
  }
  return { took, left, budget, full, stopped }
}

async function chestPut (session, ctl, { item, count = null, x, y, z } = {}) {
  const bot = session.bot
  const mcData = session.mcData

  // Resolve before opening: bot.inventory freezes the moment a window is up,
  // and 'all' plus the group aliases are answered from it.
  const names = resolveItemNames(item, bot)
  if (!names.length) throw new Error('не сказано, что класть')

  // count is a budget for the whole call, not per name: "положи 32 any_ore"
  // means 32 items, not 32 of each kind of ore.
  let budget = budgetOf(count)

  const deadline = Date.now() + CHEST_MS
  const { block, win } = await findAndOpen(session, ctl, { x, y, z }, deadline)
  const shut = guardWindow(ctl, win)

  let pass = null
  let facts = null

  try {
    pass = await depositPass(bot, mcData, win, names, { budget, deadline, ctl })
    facts = { contents: mapOf(win.containerItems()), ...shelfFacts(win) }
  } finally {
    shut()
    await sleep(120)
  }

  const base = facts ? touchChest(session, block, facts) : null

  return {
    at: xyz(block.position),
    kind: block.name,
    put: pass ? pass.put : {},
    left: pass && Object.keys(pass.left).length ? pass.left : undefined,
    free: facts ? facts.free : undefined,
    base: base || undefined,
    stopped: (pass && pass.stopped) || undefined
  }
}

// The same three words items.js resolveItemNames takes, kept in one place
// because stashPut has to recognise them WITHOUT expanding them into names.
const ALL_ALIAS = /^(all|всё|все)$/i

// resolveItemNames() answers "what of MINE matches this", which is the wrong
// question when withdrawing: 'all' means the whole chest, and any_ore has to
// match ore we do not own yet.
function resolveFromContainer (win, name) {
  const parts = String(name || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!parts.length) return []
  const inside = [...new Set(win.containerItems().map(i => i.name))]
  const out = new Set()
  for (const part of parts) {
    if (ALL_ALIAS.test(part)) {
      for (const n of inside) out.add(n)
    } else if (GROUPS[part]) {
      for (const n of inside) if (GROUPS[part].test(n)) out.add(n)
    } else {
      out.add(part)
    }
  }
  return [...out]
}

async function chestTake (session, ctl, { item, count = null, x, y, z } = {}) {
  const bot = session.bot
  const mcData = session.mcData
  if (!String(item || '').trim()) throw new Error('не сказано, что брать')

  let budget = budgetOf(count)

  const deadline = Date.now() + CHEST_MS
  const { block, win } = await findAndOpen(session, ctl, { x, y, z }, deadline)
  const shut = guardWindow(ctl, win)

  let pass = null
  let facts = null

  try {
    pass = await withdrawPass(bot, mcData, win, resolveFromContainer(win, item), { budget, deadline, ctl })
    facts = { contents: mapOf(win.containerItems()), ...shelfFacts(win) }
  } finally {
    shut()
    await sleep(120)
  }

  const base = facts ? touchChest(session, block, facts) : null

  return {
    at: xyz(block.position),
    kind: block.name,
    took: pass ? pass.took : {},
    left: pass && Object.keys(pass.left).length ? pass.left : undefined,
    contents: facts ? facts.contents : undefined,
    free: facts ? facts.free : undefined,
    base: base || undefined,
    stopped: (pass && pass.stopped) || undefined
  }
}

// ------------------------------------------------------------------- base

// A base is not a building. It is one record in memory plus the operations
// that keep that record true. The brain thinks once every 10-30 seconds, so
// "сходи посмотри, что в общаке" spends a whole turn on a fact the bot already
// had in its hands when it closed the lid. Hence the cache below: written by
// the same three calls that change a shelf, read back without moving the body.
//
// The record lives in state.places under one name, in the shape mc_remember
// and mc_recall already use — {x,y,z,note} plus our own keys. Nothing else had
// to be taught anything: mc_recall dumps places whole, so the base and what is
// in it survive a daemon restart and a context compaction for free.

const BASE = 'база'

// A shelf farther than this from the centre belongs to a base that has since
// moved: mc_remember place=база rewrites x/y/z and leaves our keys alone, and
// a chest three hundred blocks back would otherwise stay on the list forever.
const STASH_RADIUS = 24

// Past this the walk home is its own intent with its own budget. A stash call
// gets 90s; two hundred blocks of walking eat all of it and answer nothing.
const STASH_WALK = 48

// Chunks stream in behind the body. blockAt over an unloaded chunk answers
// null, and reading that as "сундук сломали" is the worst possible lie to tell
// about somebody's stash.
const LOAD_MS = 5000

const LAVA = /lava/
const WATER = /^(water|bubble_column|kelp|seagrass|tall_seagrass)$/
// Ground that pours. A chest under gravel gets buried by the first block broken
// above it, and a staircase dug through sand refills itself.
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$|_concrete_powder$/
const HARD = /^(stone|deepslate|andesite|diorite|granite|tuff|calcite|basalt|blackstone|cobblestone|cobbled_deepslate|obsidian|netherrack|end_stone|bricks|stone_bricks)$|_planks$/

const CARDINALS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// Two chests sharing a side merge into one double chest. Then two remembered
// coordinates open the same 54-slot window and the cache counts everything
// twice. Diagonals never merge — neither with each other nor with a cardinal.
const DIAGONALS = [[1, 1], [-1, -1], [1, -1], [-1, 1]]

// ---------------------------------------------------------------- record

const iso = () => new Date().toISOString()
const minutesSince = s => {
  const t = Date.parse(s || '')
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null
}
const samePos = (c, p) => c.x === p.x && c.y === p.y && c.z === p.z

function placesOf (session) {
  return (session.journal.state && session.journal.state.places) || {}
}

// A place is a base if it carries a stash list. That is also what survives
// mc_remember: rewriting the note by hand keeps the array, and if somebody
// wipes it the record simply reads as "база без общака" and the next put
// adopts or builds one.
function baseNames (session) {
  const places = placesOf(session)
  return Object.keys(places).filter(n => n === BASE || Array.isArray(places[n].chests))
}

function readBase (session, name = BASE) {
  const rec = placesOf(session)[name]
  if (!rec || !Number.isFinite(rec.x) || !Number.isFinite(rec.y) || !Number.isFinite(rec.z)) return null
  const centre = new Vec3(rec.x, rec.y, rec.z)
  const chests = (Array.isArray(rec.chests) ? rec.chests : [])
    .filter(c => c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z))
    .filter(c => centre.distanceTo(new Vec3(c.x, c.y, c.z)) <= STASH_RADIUS)
  return { ...rec, name, chests, centre }
}

// The note is the one field the rest of the system already reads (mc_recall
// prints it, the journal quotes it), so it is regenerated on every write and
// stays one line.
function baseNote (rec) {
  const alive = (Array.isArray(rec.chests) ? rec.chests : []).filter(c => !c.gone)
  const bits = [alive.length ? `общак: ${alive.length} шт` : 'общака нет']
  if (rec.furnace) bits.push('печь')
  if (rec.table) bits.push('верстак')
  if (rec.sky === false) bits.push('под землёй')
  if (rec.why) bits.push(rec.why)
  return bits.join('; ')
}

function patchBase (session, name, fn) {
  let out = null
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    const rec = Object.assign({}, s.places[name] || {})
    fn(rec)
    rec.note = baseNote(rec)
    s.places[name] = rec
    out = rec
  })
  return out
}

function rememberChest (session, name, block, facts = {}) {
  const p = block.position
  patchBase(session, name, r => {
    const list = Array.isArray(r.chests) ? r.chests.slice() : []
    const j = list.findIndex(c => samePos(c, p))
    const was = j >= 0 ? list[j] : {}
    const entry = { ...was, x: p.x, y: p.y, z: p.z, kind: block.name, ...facts, seenAt: iso(), gone: false }
    if (j >= 0) list[j] = entry
    else list.push(entry)
    // Six shelves is more than a player keeps at one base, and the whole list
    // is dumped on every mc_recall.
    r.chests = list.slice(-6)
  })
}

function markChest (session, name, pos, patch) {
  patchBase(session, name, r => {
    const list = Array.isArray(r.chests) ? r.chests.slice() : []
    const j = list.findIndex(c => samePos(c, pos))
    if (j < 0) return
    list[j] = { ...list[j], ...patch }
    r.chests = list
  })
}

// Called from the three chest actions while the shelf is still open in front
// of the bot. This is the whole trick behind `stash mode=list`: the cache is
// never separately fetched, it is a by-product of the work that changed it.
function touchChest (session, block, facts) {
  try {
    for (const name of baseNames(session)) {
      const rec = readBase(session, name)
      if (!rec || !rec.chests.some(c => samePos(c, block.position))) continue
      rememberChest(session, name, block, facts)
      return name
    }
  } catch {}
  return null
}

function stashTotals (rec) {
  const total = {}
  for (const c of rec.chests) {
    if (c.gone || !c.contents) continue
    for (const [n, k] of Object.entries(c.contents)) total[n] = (total[n] || 0) + k
  }
  return total
}

function chestView (c) {
  return {
    at: { x: c.x, y: c.y, z: c.z },
    kind: c.kind || 'chest',
    free: c.free,
    slots: c.slots,
    contents: c.contents || {},
    seenMinutesAgo: minutesSince(c.seenAt),
    gone: c.gone || undefined
  }
}

const aliveChests = rec => rec.chests.filter(c => !c.gone)
const freeSlots = rec => aliveChests(rec).reduce((n, c) => n + (c.free || 0), 0)
const stalest = rec => aliveChests(rec).reduce((m, c) => {
  const s = minutesSince(c.seenAt)
  return s === null ? m : Math.max(m, s)
}, 0)

// ---------------------------------------------------------------- choosing

function stands (bot, p) {
  const ground = bot.blockAt(p.offset(0, -1, 0))
  const feet = bot.blockAt(p)
  const head = bot.blockAt(p.offset(0, 1, 0))
  if (!ground || !feet || !head) return false
  if (ground.boundingBox !== 'block') return false
  if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') return false
  if (WATER.test(feet.name) || WATER.test(head.name)) return false
  if (LAVA.test(feet.name) || LAVA.test(head.name)) return false
  return true
}

// Top-down, so a column answers with its surface rather than with the first
// cave it happens to contain.
function surfaceAt (bot, x, z, aroundY, span = 6) {
  for (let dy = span; dy >= -span; dy--) {
    const p = new Vec3(x, aroundY + dy, z)
    if (stands(bot, p)) return p
  }
  return null
}

// The geometric question, not the light one: mc_surface learned the hard way
// that skyLight over the bottom of our own shaft reads as honest daylight.
function openSky (bot, p, upTo = 40) {
  for (let dy = 1; dy <= upTo; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (!b) return null // unloaded: we do not know, and guessing is worse
    if (b.boundingBox !== 'empty') return false
  }
  return true
}

// Offsets of a cube of side 2r+1, ordered by Chebyshev distance from the
// centre. Precomputed once because the ORDER is the whole optimisation: both
// callers really ask "is there any of this within r", and shell order lets a
// column standing IN a lava lake answer after twenty-seven lookups instead of
// grinding all 729. That is what makes it affordable to keep looking past the
// rejected columns instead of giving up after the nearest handful.
function shell (radius) {
  const out = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        out.push([dx, dy, dz, Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))])
      }
    }
  }
  return out.sort((a, b) => a[3] - b[3])
}
const LAVA_SHELL = shell(4)
const WATER_SHELL = shell(3)

// First hit in shell order IS the nearest, so this returns the same number the
// old triple loop did — it just stops as soon as it has it.
function nearest (bot, p, re, offsets) {
  for (const [dx, dy, dz, d] of offsets) {
    const b = bot.blockAt(p.offset(dx, dy, dz))
    if (b && re.test(b.name)) return d
  }
  return null
}

function spotWhy (c) {
  return [
    c.sky === true ? 'открытое небо' : c.sky === false ? 'под потолком' : 'небо не проверить',
    `ровно ${c.flat} из 8`,
    `земля ${c.ground}`,
    c.water === null ? 'воды в 3 нет' : `вода в ${c.water}`,
    'лавы в 4 нет'
  ].join(', ')
}

// Why these rules and not prettier ones. The base exists to be the place the
// bot comes back to from underground, so what it must have is: a floor that
// does not pour (a chest under gravel gets buried), no lava within four (the
// mine entrance is dug right here, and the descent already turned twice to get
// round lava at y=-56), three-by-three of standing room — two chests on the
// diagonals, a furnace and a table on the cardinals, a body in the middle —
// and open sky, because that is where mc_surface breaks out and the only thing
// that makes the spot findable at night. Underground is allowed and merely
// scores worse: at y=-50 a forward base beats no base at all.
// How many acceptable spots we look at before settling, and the hard ceiling on
// examinations. `slice(0, 32)` used to do both jobs at once and did the second
// one badly: sorted by distance, thirty-two columns is a circle of radius 3.2,
// so a lava pool four blocks east made `radius: 10` answer "негде" while good
// ground stood at six. Rejections are cheap to keep looking past; it is the
// ACCEPTED ones that have to be capped, because score already pays -1.5 a block
// and the thirteenth candidate can never win.
const SPOTS_ENOUGH = 12
const SPOTS_LOOKED = 300

function pickBaseSpot (bot, { radius = 10 } = {}) {
  const me = bot.entity.position.floored()
  // Honest names: a column with no answer is usually a lava well or a wall,
  // not an unloaded chunk, and calling it "непрогружено" would send the brain
  // off to wait for chunks that are already here.
  const saw = { колонок: 0, сыпучая: 0, нетпола: 0, тесно: 0, лава: 0, вода: 0, годных: 0, проверено: 0 }
  const columns = []

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const p = surfaceAt(bot, me.x + dx, me.z + dz, me.y, 6)
      if (!p) { saw.нетпола++; continue }
      const ground = bot.blockAt(p.offset(0, -1, 0))
      if (GRAVITY.test(ground.name)) { saw.сыпучая++; continue }
      saw.колонок++
      columns.push({ p, ground: ground.name, dist: Math.hypot(dx, dz) })
    }
  }
  columns.sort((a, b) => a.dist - b.dist)

  let best = null
  // The expensive tests (a lava sphere is 729 lookups) only run on the nearest
  // handful: walking further for a marginally better spot is a bad trade. An
  // ACCEPTED candidate costs ~1120 blockAt (729 of them the lava sphere), so
  // the open-field case stops at twelve — 13k lookups, a quarter of what the
  // flat cap of 32 spent. A REJECTED one is cheap now that nearest() stops on
  // its first hit, which is why the ceiling can afford to be 300: a nine-by-nine
  // lava lake underfoot rejects ~250 columns and still finds ground at nine.
  for (const c of columns) {
    if (saw.годных >= SPOTS_ENOUGH || saw.проверено >= SPOTS_LOOKED) break
    saw.проверено++
    const flat = CARDINALS4.concat(DIAGONALS).filter(([dx, dz]) => stands(bot, c.p.offset(dx, 0, dz))).length
    const slots = DIAGONALS.filter(([dx, dz]) => stands(bot, c.p.offset(dx, 0, dz))).length
    if (flat < 5 || slots < 2) { saw.тесно++; continue }
    if (nearest(bot, c.p, LAVA, LAVA_SHELL) !== null) { saw.лава++; continue }
    saw.годных++
    const water = nearest(bot, c.p, WATER, WATER_SHELL)
    if (water !== null) saw.вода++
    const sky = openSky(bot, c.p, 40)

    let score = flat * 4
    if (sky === true) score += 30
    if (HARD.test(c.ground)) score += 8
    if (c.p.y >= 63) score += 6
    if (water !== null) score -= 12
    score -= Math.round(c.dist * 1.5)

    const cand = { pos: c.p, ground: c.ground, dist: Math.round(c.dist * 10) / 10, flat, slots, sky, water, score }
    if (!best || cand.score > best.score) best = cand
  }
  if (best) best.why = spotWhy(best)
  // The radius comes back out because baseSet clamps it before calling and the
  // refusal quotes a number: saying "в 40 блоках негде" after looking in 24 is
  // the kind of lie that sends the brain walking for nothing.
  return { best, saw, radius }
}

// ---------------------------------------------------------------- shelves

function containerNextTo (bot, pos) {
  for (const [dx, dz] of CARDINALS4) {
    const b = bot.blockAt(pos.offset(dx, 0, dz))
    if (b && /^(chest|trapped_chest)$/.test(b.name)) return b
  }
  return null
}

// A torch has boundingBox 'empty' and is not replaceable: baseSet plants one on
// a cardinal of the centre immediately before growStash runs, so "empty" alone
// would offer that exact square as a shelf spot and spend a placement timeout
// failing on it. Only the cells a player could build straight into count.
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|dead_bush|snow)$/

// Where a new shelf may go. Diagonals first (they cannot merge into a double
// chest), then cardinals, and never the square the body stands on
// (placeBlockAt refuses it — build.js isOurOwnSpace).
function chestSpots (bot, centre) {
  const out = []
  for (const [dx, dz] of DIAGONALS.concat(CARDINALS4)) {
    const p = centre.offset(dx, 0, dz)
    const here = bot.blockAt(p)
    const under = bot.blockAt(p.offset(0, -1, 0))
    const over = bot.blockAt(p.offset(0, 1, 0))
    if (!here || !under || !over) continue
    if (!REPLACEABLE.test(here.name)) continue
    if (under.boundingBox !== 'block') continue
    // A chest with an opaque block on top does not open — vanilla rule, and
    // from the outside it looks exactly like the 1.21.11 activation bug.
    if (over.boundingBox !== 'empty') continue
    if (containerNextTo(bot, p)) continue
    out.push(p)
  }
  return out
}

// null means "we cannot see that far", which is not the same answer as "your
// chest is gone" and must never be reported as one.
function checkChest (bot, c) {
  const b = bot.blockAt(new Vec3(c.x, c.y, c.z))
  if (!b) return { state: 'unloaded' }
  if (!CONTAINER.test(b.name)) return { state: 'gone', instead: b.name }
  return { state: 'ok', block: b }
}

async function waitLoaded (bot, pos, ms = LOAD_MS) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (bot.blockAt(pos)) return true
    await sleep(250)
  }
  return !!bot.blockAt(pos)
}

// Put one more shelf on the base. Returns the block, or a reason with numbers:
// "нечем" is useless, "нужно 8 досок, в рюкзаке 3, брёвен 0" is a decision.
async function growStash (session, ctl, rec) {
  const bot = session.bot
  const spots = chestSpots(bot, rec.centre)
  if (!spots.length) {
    return { ok: false, why: `вокруг ${rec.x},${rec.y},${rec.z} некуда поставить сундук — клетки заняты` }
  }

  if (!itemNamed(bot, 'chest')) {
    const planks = bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((n, i) => n + i.count, 0)
    const logs = bot.inventory.items().filter(i => /_log$|_stem$/.test(i.name)).reduce((n, i) => n + i.count, 0)
    if (planks < 8 && logs < 2) {
      return { ok: false, why: `сундука нет и делать не из чего: нужно 8 досок (или 2 бревна), в рюкзаке досок ${planks}, брёвен ${logs}` }
    }
    try {
      await actions.craft(session, ctl, { item: 'chest', count: 1 })
    } catch (e) {
      return { ok: false, why: `сундук не скрафтился: ${e.message}` }
    }
    // craft() drops a table at its own feet and steps onto it, so by now the
    // body can be three blocks off the centre — and the server refuses a
    // placement past 4.5, one full placement timeout per refused spot. The
    // coordinates in `spots` were read before the craft and are still right.
    if (bot.entity && bot.entity.position.distanceTo(rec.centre) > 2.5) {
      try { await walkTo(bot, new goals.GoalNear(rec.x, rec.y, rec.z, 1), 8000) } catch {}
    }
  }

  for (const p of spots) {
    if (ctl.aborted) break
    const r = await placeBlockAt(bot, p, { item: 'chest' })
    if (!r.ok) continue
    await sleep(250)
    const b = bot.blockAt(p)
    if (b && CONTAINER.test(b.name)) {
      rememberChest(session, rec.name, b, { contents: {}, slots: 27, used: 0, free: 27 })
      return { ok: true, block: b, placed: true }
    }
  }
  return { ok: false, why: 'сундук в руках есть, а поставить не вышло — сервер отказал во всех клетках' }
}

// Everything the base owns that can actually be opened right now. Verifies
// against the world, adopts a container left standing on the spot, and builds
// one only when asked to.
async function liveShelves (session, ctl, rec, { grow = false } = {}) {
  const bot = session.bot
  const ok = []
  const lost = []
  const unloaded = []

  for (const c of rec.chests) {
    const r = checkChest(bot, c)
    if (r.state === 'ok') { ok.push(r.block); continue }
    if (r.state === 'unloaded') { unloaded.push({ x: c.x, y: c.y, z: c.z }); continue }
    markChest(session, rec.name, c, { gone: true, instead: r.instead })
    lost.push({ x: c.x, y: c.y, z: c.z, instead: r.instead })
  }

  if (!ok.length) {
    // Nothing remembered stands here any more. A chest somebody left on the
    // base square is still our common stash — adopting it beats building a
    // second one right next to it.
    // NEVER touch block.position inside a `matching` function. mineflayer runs
    // the matcher twice with two different kinds of argument: once per real
    // block, and once per section PALETTE entry, to decide whether a section is
    // worth scanning at all (blocks.js isBlockInSection ->
    // Block.fromStateId(stateId, 0)). A palette probe has position === null, so
    // the moment any nearby section's palette contained `chest` this threw
    // "Cannot read properties of null (reading 'distanceTo')" — a crash, not a
    // refusal, and it took base mode=go and every stash call down with it the
    // first time a base stood with no shelf left. Measured in game.
    // Distance is filtered afterwards, and from the CENTRE rather than from the
    // body: the shelf belongs to the base, not to wherever we happen to stand.
    const near = bot.findBlocks({
      matching: b => !!b && CONTAINER.test(b.name),
      point: rec.centre,
      maxDistance: 6,
      count: 16
    }).find(p => p.distanceTo(rec.centre) <= 6)
    const found = near ? bot.blockAt(near) : null
    if (found) {
      rememberChest(session, rec.name, found, {})
      ok.push(found)
    }
  }

  let built = null
  if (!ok.length && grow) {
    built = await growStash(session, ctl, rec)
    if (built.ok) ok.push(built.block)
  }

  return { ok, lost, unloaded, built }
}

// ---------------------------------------------------------------- surplus

// What never goes in the chest, and why. A bot that walks into a mine without
// a pickaxe, a torch and a steak is a bot that dies in it: measured here,
// forty staircase steps cost ~166 pickaxe uses, and the run that reached y=-58
// was doomed by having nothing left to dig with. `Infinity` means "this is
// equipment, not loot".
const KEEP = [
  { re: /_(pickaxe|axe|shovel|sword|hoe)$/, keep: Infinity },
  { re: /_(helmet|chestplate|leggings|boots)$/, keep: Infinity },
  { re: /^(shield|elytra|totem_of_undying|flint_and_steel|clock|compass|map)$/, keep: Infinity },
  // The EMPTY bucket is `bucket`, with no underscore: /_bucket$/ matched
  // water_bucket and lava_bucket and handed the empty one to the chest as loot,
  // which is the one of the three the bot actually carries down a shaft.
  { re: /^bucket$|_bucket$/, keep: Infinity },
  { re: /_bed$/, keep: 1 },
  { re: /^cooked_\w+$/, keep: 16 },
  { re: /^(beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/, keep: 16 },
  { re: /^(bread|apple|golden_apple|enchanted_golden_apple|carrot|potato|baked_potato|beetroot|melon_slice|sweet_berries|glow_berries|dried_kelp|pumpkin_pie|cookie|rabbit_stew|mushroom_stew|beetroot_soup|suspicious_stew|honey_bottle)$/, keep: 16 },
  { name: 'torch', keep: 32 },
  { name: 'coal', keep: 16 },
  { name: 'charcoal', keep: 16 },
  { name: 'cobblestone', keep: 64 },
  { name: 'cobbled_deepslate', keep: 64 },
  { name: 'stick', keep: 8 },
  { re: /_planks$/, keep: 16 },
  { name: 'crafting_table', keep: 1 },
  { name: 'furnace', keep: 1 },
  { name: 'chest', keep: 1 },
  // Прохождение: то, без чего дракона не убить, из рюкзака не выкидывается ради
  // места никогда. Раньше keepFor давал им 0, и makeRoom под подобранный меч
  // (worth 9) мог выбросить жемчуг или стержни (worth 3).
  { re: /^(ender_pearl|ender_eye|blaze_rod|blaze_powder|obsidian|gold_ingot|gold_block|gold_nugget|potion|splash_potion|string|white_wool|fire_charge|magma_cream|nether_wart|arrow|spectral_arrow|golden_carrot|book|leather|paper|diamond)$/, keep: Infinity }
]

function keepFor (name, override) {
  if (override && override[name] !== undefined) return override[name]
  for (const rule of KEEP) {
    if (rule.name ? rule.name === name : rule.re.test(name)) return rule.keep
  }
  return 0
}

// "cobblestone:0, torch:64" — a string, not an object, because that is what a
// tool schema carries without turning into a second-class API.
function parseKeep (text) {
  const out = {}
  for (const part of String(text || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [name, n] = part.split(':').map(s => s.trim())
    const k = n === undefined || n === '' ? Infinity : Number(n)
    if (!name || !(k === Infinity || (Number.isFinite(k) && k >= 0))) {
      throw new Error(`не понял keep: ${part} (надо имя:число, например cobblestone:0)`)
    }
    out[name] = k
  }
  return out
}

function surplusPlan (bot, override) {
  const plan = {}
  const kept = {}
  for (const [name, have] of Object.entries(countItems(bot))) {
    const cap = keepFor(name, override)
    const spare = cap === Infinity ? 0 : Math.max(0, have - cap)
    if (spare > 0) plan[name] = spare
    if (have - spare > 0) kept[name] = have - spare
  }
  return { plan, kept }
}

// ---------------------------------------------------------------- ops

function needBase (session, name) {
  const rec = readBase(session, name)
  if (!rec) {
    throw new Error(`базы «${name}» в памяти нет. base mode=set выберет место там, где я стою, поставит сундук и запишет координаты`)
  }
  return rec
}

// Через миры расстояния нет (worlds.js): число от Ада до базы в верхнем мире —
// ложь, и «до неё 312 блоков» звало бы идти пешком.
const awayFrom = (bot, rec) => (bot && bot.entity && worlds.sameWorld(bot, rec) ? Math.round(bot.entity.position.distanceTo(rec.centre)) : null)

// Instant by design: knowing where home is and what lies in it must never cost
// a turn, and must answer with the body offline.
function baseNow (session, { mode = 'where', name = BASE } = {}) {
  const how = String(mode || 'where').trim().toLowerCase()
  if (how === 'forget') {
    const had = readBase(session, name)
    session.journal.patch(s => { if (s.places) delete s.places[name] })
    session.journal.append('база', `забыл базу «${name}»${had ? ` на ${had.x},${had.y},${had.z}` : ''}`, null)
    return { forgot: name, was: had ? { x: had.x, y: had.y, z: had.z } : null }
  }
  if (how !== 'where') throw new Error(`не знаю режим ${mode}, бывает where / set / go / forget`)

  const rec = readBase(session, name)
  if (!rec) {
    return { base: null, note: `базы «${name}» нет. base mode=set выберет место там, где я стою, поставит сундук и запишет координаты` }
  }
  const bot = session.bot && session.bot.entity ? session.bot : null
  const alive = aliveChests(rec)
  const away = bot ? awayFrom(bot, rec) : null

  const parts = [`база на ${rec.x},${rec.y},${rec.z}`]
  if (away !== null) parts.push(away <= 4 ? 'я на ней' : `до неё ${away} блоков`)
  if (bot && !worlds.sameWorld(bot, rec)) parts.push(`она ${worlds.inWorld(worlds.worldOfRecord(rec))}, а я ${worlds.inWorld(worlds.worldOf(bot))} — домой только через портал (mc_portal mode=enter)`)
  parts.push(alive.length
    ? `общак: ${alive.length} сундук(ов), свободно ${freeSlots(rec)} слотов`
    : 'сундуков в памяти нет — stash mode=put найдёт или поставит')
  if (alive.length && stalest(rec) >= 30) {
    parts.push(`это память, сундук не открывали ${stalest(rec)} мин — stash mode=check пересчитает`)
  }
  if (rec.why) parts.push(rec.why)

  return {
    base: { x: rec.x, y: rec.y, z: rec.z, name, since: rec.since || null, sky: rec.sky },
    away,
    chests: rec.chests.map(chestView),
    stash: stashTotals(rec),
    furnace: rec.furnace || null,
    table: rec.table || null,
    note: parts.join('; ')
  }
}

function stashNow (session, { name = BASE } = {}) {
  const rec = readBase(session, name)
  if (!rec) return { base: null, note: `базы «${name}» нет — общаку негде быть. base mode=set` }
  const alive = aliveChests(rec)
  const total = stashTotals(rec)
  const parts = [`общак на ${rec.x},${rec.y},${rec.z}: ${alive.length} сундук(ов), ${Object.keys(total).length} видов, свободно ${freeSlots(rec)} слотов`]
  if (!alive.length) parts.push('сундуков в памяти нет — stash mode=put найдёт или поставит')
  else if (stalest(rec) >= 30) parts.push(`последний раз открывали ${stalest(rec)} мин назад; stash mode=check пересчитает`)
  const away = session.bot && session.bot.entity ? awayFrom(session.bot, rec) : null
  if (away !== null && away > 4) parts.push(`я в ${away} блоках`)
  return { at: { x: rec.x, y: rec.y, z: rec.z }, away, chests: rec.chests.map(chestView), stash: total, note: parts.join('; ') }
}

async function walkHome (session, ctl, rec, { range = 3, deadline }) {
  const bot = session.bot
  stopWalkingOnAbort(bot, ctl)
  // Never plan a route from the bottom of our own shaft: pathfinder cannot
  // climb a 1x1 column, so the whole budget goes on a route the body cannot
  // walk. The same call goto makes, for the same measured reason.
  const pit = await escapePit(bot, ctl, { mcData: session.mcData, maxClimb: 24 })

  let trip = { ok: true }
  if (awayFrom(bot, rec) > range) {
    trip = await travelXZ(bot, ctl, rec.x, rec.z, { range: Math.max(1, range), retries: 2, deadline })
  }
  // Chunks arrive behind the body: a blockAt right after the last step is
  // often still null, and that is not a missing base.
  await waitLoaded(bot, rec.centre, LOAD_MS)
  return { trip, climbedOut: pit.wasInPit ? pit.climbed : undefined, away: awayFrom(bot, rec) }
}

async function baseGo (session, ctl, { name = BASE, range = 3, timeoutSeconds = 120 } = {}) {
  const bot = session.bot
  const rec = needBase(session, name)
  const deadline = Date.now() + Math.max(10, Math.min(600, timeoutSeconds)) * 1000

  // База в другом мире: ни шага. Pathfinder честно пошёл бы к тем же числам в
  // Аду — к лаве, а не домой (NETHER.md §4, строка 5).
  const other = worlds.refuseOtherWorld(bot, rec, `База «${name}»`)
  if (other) {
    return {
      went: false,
      moved: 0,
      world: { here: worlds.worldOf(bot), record: worlds.worldOfRecord(rec) },
      base: { x: rec.x, y: rec.y, z: rec.z, name },
      stopped: other
    }
  }

  const walk = await walkHome(session, ctl, rec, { range, deadline })
  // away is null when there is no body to measure from (death mid-walk), and
  // `null <= 5` is true — which would report a corpse as "дошёл".
  const arrived = walk.away !== null && walk.away <= Math.max(4, range + 2)

  const shelves = arrived
    ? await liveShelves(session, ctl, rec, { grow: false })
    : { ok: [], lost: [], unloaded: [] }
  const fresh = readBase(session, name) || rec

  const parts = []
  if (!arrived) {
    parts.push(`не дошёл: до базы ещё ${walk.away} блоков (${walk.trip.error || 'время вышло'}) — позови ещё раз`)
  } else {
    parts.push(`на базе ${rec.x},${rec.y},${rec.z}`)
    parts.push(shelves.ok.length ? `сундуков на месте ${shelves.ok.length}` : 'сундуков на месте нет')
  }
  if (shelves.lost.length) {
    parts.push(`сундук сломан на ${shelves.lost.map(c => `${c.x},${c.y},${c.z} (там ${c.instead})`).join('; ')} — stash mode=put поставит новый`)
  }
  if (shelves.unloaded.length) {
    parts.push(`${shelves.unloaded.length} сундук(ов) в непрогруженных чанках — это не «сломали»: подожди и позови ещё раз`)
  }
  if (walk.climbedOut) parts.push(`из ямы вылез на ${walk.climbedOut}`)

  return {
    at: { x: rec.x, y: rec.y, z: rec.z },
    arrived,
    away: walk.away,
    // Dying on the way home replaces bot.entity, and reading .position off the
    // gap is a TypeError where the honest answer is "тела нет". The intent is
    // interrupted by then, but the throw would still bury the walk's result.
    standing: bot.entity ? xyz(bot.entity.position) : null,
    chests: fresh.chests.map(chestView),
    lost: shelves.lost.length ? shelves.lost : undefined,
    unloaded: shelves.unloaded.length ? shelves.unloaded : undefined,
    stash: stashTotals(fresh),
    climbedOut: walk.climbedOut,
    note: parts.join('; ')
  }
}

async function baseSet (session, ctl, { name = BASE, x, y, z, radius = 10, move = false, torch = true } = {}) {
  const bot = session.bot
  const had = readBase(session, name)
  // Refusing is the right answer, not an error: a second `set` from the mine
  // would otherwise quietly move home and orphan the whole stash.
  if (had && move !== true) {
    const away = awayFrom(bot, had)
    return {
      already: true,
      at: { x: had.x, y: had.y, z: had.z },
      away,
      chests: had.chests.map(chestView),
      stash: stashTotals(had),
      note: `база уже есть на ${had.x},${had.y},${had.z} (${away} блоков отсюда). move=true — перенести сюда, base mode=go — вернуться`
    }
  }

  const given = x !== undefined && x !== null && z !== undefined && z !== null
  let spot = null
  let why = null

  if (given) {
    const fromY = Math.floor(y === undefined || y === null ? bot.entity.position.y : y)
    const at = new Vec3(Math.floor(x), fromY, Math.floor(z))
    if (!bot.blockAt(at)) throw new Error(`на ${at.x},${at.y},${at.z} мир не прогружен — дойди туда и позови без координат`)
    const p = surfaceAt(bot, at.x, at.z, at.y, 4)
    if (!p) throw new Error(`на ${at.x},${at.y},${at.z} встать негде: нет твёрдого пола с двумя блоками воздуха над ним`)
    spot = p
    why = 'место указано мозгом'
  } else {
    const found = pickBaseSpot(bot, { radius: Math.max(4, Math.min(24, radius)) })
    if (!found.best) {
      throw new Error(
        `в ${found.radius} блоках базу ставить негде: осмотрел ${found.saw.колонок} колонок, ` +
        `проверил ${found.saw.проверено} из них, тесно у ${found.saw.тесно}, лава рядом у ${found.saw.лава}, ` +
        `сыпучая земля у ${found.saw.сыпучая}, встать негде в ${found.saw.нетпола}. ` +
        'отойди на десяток блоков и позови ещё раз или подними radius')
    }
    spot = found.best.pos
    why = found.best.why
  }

  const deadline = Date.now() + 60000
  if (bot.entity.position.distanceTo(spot) > 1.5) {
    try {
      await walkTo(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 1), Math.min(WALK_MS * 2, Math.max(2000, deadline - Date.now())))
    } catch (e) {
      throw new Error(`до места ${spot.x},${spot.y},${spot.z} не дошёл: ${e.message}`)
    }
  }

  const sky = openSky(bot, spot, 40)
  patchBase(session, name, r => {
    r.x = spot.x
    r.y = spot.y
    r.z = spot.z
    r.dimension = bot.game ? bot.game.dimension : null
    r.since = r.since && !move ? r.since : iso()
    r.why = why
    r.sky = sky
    // A move keeps nothing: the old shelves stand at the old place.
    if (move || !Array.isArray(r.chests)) r.chests = []
  })

  // A torch is not decoration. It stops mobs spawning on the square the bot
  // trades on, and at night it is the only thing that says "this is the place"
  // from thirty blocks away.
  let lit = false
  if (torch !== false && itemNamed(bot, 'torch')) {
    for (const [dx, dz] of CARDINALS4) {
      const p = spot.offset(dx, 0, dz)
      const b = bot.blockAt(p)
      if (!b || b.boundingBox !== 'empty') continue
      try { await placeBlockAt(bot, p, { item: 'torch', timeoutMs: 1200 }) } catch {}
      const now = bot.blockAt(p)
      if (now && /torch/.test(now.name)) { lit = true; break }
    }
  }

  const shelves = await liveShelves(session, ctl, readBase(session, name), { grow: true })

  // Count the fresh shelf once, standing right here: that first entry is what
  // the brain reads later without walking.
  if (shelves.ok.length) {
    try { await chestList(session, ctl, xyz(shelves.ok[0].position)) } catch {}
  }

  const furnace = bot.findBlock({ matching: b => !!b && /^(furnace|blast_furnace|smoker)$/.test(b.name), maxDistance: 6 })
  const table = bot.findBlock({ matching: b => !!b && b.name === 'crafting_table', maxDistance: 6 })
  patchBase(session, name, r => {
    r.furnace = furnace ? xyz(furnace.position) : null
    r.table = table ? xyz(table.position) : null
  })

  const out = readBase(session, name)
  const parts = [`база на ${spot.x},${spot.y},${spot.z}: ${why}`]
  parts.push(shelves.ok.length
    ? `общак: ${shelves.ok.length} сундук(ов)`
    : `сундука нет — ${(shelves.built && shelves.built.why) || 'поставить не вышло'}`)
  if (lit) parts.push('горит факел')
  if (furnace) parts.push('печь рядом')
  if (table) parts.push('верстак рядом')
  if (sky === false) parts.push('небо закрыто — сюда mc_surface не выйдет')

  session.journal.append('база', parts.join('; '), spot)

  return {
    at: { x: spot.x, y: spot.y, z: spot.z },
    moved: !!(had && move),
    why,
    sky,
    torch: lit,
    chests: out.chests.map(chestView),
    furnace: out.furnace,
    table: out.table,
    note: parts.join('; ')
  }
}

// Common preamble for put/take/check: get home, get the shelves, and refuse
// with numbers rather than spending a 90-second budget on a 200-block walk.
async function atStash (session, ctl, rec, { grow, deadline }) {
  const bot = session.bot
  const away = awayFrom(bot, rec)
  if (away > STASH_WALK) {
    return { far: `до базы ${away} блоков — это отдельная дорога: сначала base mode=go, потом сюда` }
  }
  if (away > 4) {
    const walk = await walkHome(session, ctl, rec, { range: 3, deadline })
    if (walk.away > 6) {
      return { far: `до базы не дошёл, осталось ${walk.away} блоков (${walk.trip.error || 'время вышло'}) — base mode=go` }
    }
  }
  await waitLoaded(bot, rec.centre, LOAD_MS)
  return { shelves: await liveShelves(session, ctl, rec, { grow }) }
}

// Open one shelf, move what the plan still asks for, close, and write what is
// now inside into the cache. Every stash call goes through here, so the memory
// can never drift from the world by more than one failed window.
async function useShelf (session, ctl, name, block, deadline, work) {
  const opened = await findAndOpen(session, ctl, xyz(block.position), deadline)
  const shut = guardWindow(ctl, opened.win)
  let pass = null
  let facts = null
  try {
    pass = await work(opened.win)
    facts = { contents: mapOf(opened.win.containerItems()), ...shelfFacts(opened.win) }
  } finally {
    shut()
    await sleep(120)
  }
  rememberChest(session, name, block, facts)
  return { pass, facts }
}

async function stashPut (session, ctl, { name = BASE, item = null, count = null, keep = null } = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const rec = needBase(session, name)
  const deadline = Date.now() + 70000

  const asks = String(item === null || item === undefined ? '' : item)
    .split(',').map(s => s.trim()).filter(Boolean)
  // "all" is not a list of item names. resolveItemNames answers it with every
  // stack in the bag, which put the pickaxe, the bucket and the last steak in
  // the chest — the exact thing mc_stash promises it will never do. The brain
  // saying "положи всё" means the loot, and the loot is what surplusPlan
  // computes; naming items or a group is still the escape hatch that drops the
  // reserve on purpose, the same one smelt gives for fuel.
  const wholeBag = asks.some(p => ALL_ALIAS.test(p))
  const asked = asks.length > 0 && !wholeBag

  const override = { ...(keep ? parseKeep(keep) : null) }
  // "all,cobblestone" is the brain asking for the loot AND for that reserve
  // dropped, so the named ones lose their cap — unless keep= says otherwise.
  if (wholeBag) {
    const named = asks.filter(p => !ALL_ALIAS.test(p))
    if (named.length) {
      for (const n of resolveItemNames(named.join(','), bot)) {
        if (override[n] === undefined) override[n] = 0
      }
    }
  }

  const surplus = asked ? null : surplusPlan(bot, override)
  const want = asked
    ? resolveItemNames(item, bot).reduce((o, n) => { o[n] = countOf(bot, n); return o }, {})
    : surplus.plan
  const kept = asked ? null : surplus.kept

  if (!Object.keys(want).filter(n => want[n] > 0).length) {
    const note = asked ? `${item} в рюкзаке нет` : 'лишнего нет — всё, что при мне, нужно в дороге'
    return { at: { x: rec.x, y: rec.y, z: rec.z }, put: {}, kept: kept || undefined, note }
  }

  const home = await atStash(session, ctl, rec, { grow: true, deadline })
  // `at` even on the refusal: the brain's next move is base mode=go, and it
  // must not have to spend another call finding out where that is.
  if (home.far) return { at: { x: rec.x, y: rec.y, z: rec.z }, put: {}, went: false, stopped: home.far, note: home.far }

  let budget = budgetOf(count)
  const remain = { ...want }
  const put = {}
  const failed = {}
  const used = []
  let stopped = null

  const spendOn = async (block, fresh = false) => {
    const names = Object.keys(remain).filter(n => remain[n] > 0)
    if (!names.length) return false
    let done
    try {
      done = await useShelf(session, ctl, name, block, deadline, win =>
        depositPass(bot, mcData, win, names, { budget, caps: remain, deadline, ctl }))
    } catch (e) {
      failed[`${block.position.x},${block.position.y},${block.position.z}`] = e.message
      return false
    }
    for (const [n, k] of Object.entries(done.pass.put)) {
      put[n] = (put[n] || 0) + k
      remain[n] -= k
    }
    budget = done.pass.budget
    used.push({ at: xyz(block.position), put: done.pass.put, free: done.facts.free, fresh: fresh || undefined })
    if (done.pass.stopped) stopped = done.pass.stopped
    return true
  }

  // A shelf that had to be built because the old one is gone is news, not
  // bookkeeping: the brain asked to put things away and got a new chest at a
  // new coordinate out of it.
  const rebuilt = home.shelves.built && home.shelves.built.ok ? home.shelves.built.block : null
  for (const block of home.shelves.ok) {
    if (ctl.aborted || budget <= 0 || stopped) break
    if (Date.now() >= deadline) { stopped = 'время вышло'; break }
    await spendOn(block, block === rebuilt)
  }

  // Everything full and nothing left to build with is the case the naive
  // version gets wrong: it drops the remainder on the floor and says "готово".
  // A leftover only means "did not fit" while there was still budget to spend
  // on it. `stash put item=torch count=8` with sixteen torches in the bag ends
  // with eight in `remain` that were never asked for — and counting those as a
  // shortfall built a second chest nobody needed (measured in game: an empty
  // 27-slot shelf at the base) and reported the brain's own instruction back to
  // it as "не влезло". A null count leaves budget at Infinity, so the
  // no-count case is unchanged.
  const short = () => (budget > 0 ? Object.entries(remain).filter(([, k]) => k > 0) : [])

  let grew = null
  if (short().length && !stopped && !ctl.aborted && Date.now() < deadline) {
    grew = await growStash(session, ctl, readBase(session, name))
    if (grew.ok) await spendOn(grew.block, true)
  }

  const still = short()
  const fresh = readBase(session, name) || rec
  const moved = Object.values(put).reduce((n, k) => n + k, 0)

  const parts = [`положил ${moved} предметов в ${used.length} сундук(ов), свободно ${freeSlots(fresh)} слотов`]
  const placed = used.filter(u => u.fresh)
  if (placed.length) {
    parts.push(`поставил новый сундук на ${placed.map(u => `${u.at.x},${u.at.y},${u.at.z}`).join('; ')}`)
  }
  if (!home.shelves.ok.length && !(grew && grew.ok)) {
    parts.push(`сундука на базе нет: ${(home.shelves.built && home.shelves.built.why) || (grew && grew.why) || 'поставить не вышло'}`)
  }
  if (still.length) {
    parts.push(`не влезло: ${still.map(([n, k]) => `${n}×${k}`).join(', ')} — ` +
      (grew && !grew.ok ? grew.why : 'общак полон, нужен ещё сундук (8 досок)'))
  }
  if (kept && Object.keys(kept).length) {
    parts.push(`при мне оставил нужное: ${Object.entries(kept).map(([n, k]) => `${n}×${k}`).join(', ')}`)
  }
  if (stopped) parts.push(stopped)

  return {
    at: { x: rec.x, y: rec.y, z: rec.z },
    put,
    kept: kept || undefined,
    chests: used,
    leftOnMe: still.length ? Object.fromEntries(still) : undefined,
    free: freeSlots(fresh),
    stash: stashTotals(fresh),
    failed: Object.keys(failed).length ? failed : undefined,
    stopped: stopped || undefined,
    note: parts.join('; ')
  }
}

async function stashTake (session, ctl, { name = BASE, item, count = null } = {}) {
  const bot = session.bot
  const mcData = session.mcData
  if (!String(item || '').trim()) throw new Error('не сказано, что брать из общака')
  const rec = needBase(session, name)
  const deadline = Date.now() + 70000

  // A full backpack is why "взял 0" used to be indistinguishable from "там
  // пусто". Say which one it is before walking anywhere.
  if (bot.inventory.emptySlotCount() === 0) {
    const note = 'рюкзак забит под завязку, ни одного пустого слота — сначала stash mode=put, потом take'
    return { at: { x: rec.x, y: rec.y, z: rec.z }, took: {}, went: false, stopped: note, note }
  }

  const home = await atStash(session, ctl, rec, { grow: false, deadline })
  if (home.far) return { at: { x: rec.x, y: rec.y, z: rec.z }, took: {}, went: false, stopped: home.far, note: home.far }

  let budget = budgetOf(count)
  const took = {}
  const left = {}
  const from = []
  let stopped = null

  for (const block of home.shelves.ok) {
    if (ctl.aborted || budget <= 0 || stopped) break
    if (Date.now() >= deadline) { stopped = 'время вышло'; break }
    let done
    try {
      done = await useShelf(session, ctl, name, block, deadline, win =>
        withdrawPass(bot, mcData, win, resolveFromContainer(win, item), { budget, deadline, ctl }))
    } catch (e) {
      left[`${block.position.x},${block.position.y},${block.position.z}`] = e.message
      continue
    }
    if (Object.keys(done.pass.took).length) from.push({ at: xyz(block.position), took: done.pass.took })
    for (const [n, k] of Object.entries(done.pass.took)) took[n] = (took[n] || 0) + k
    Object.assign(left, done.pass.left)
    budget = done.pass.budget
    if (done.pass.full) stopped = 'рюкзак полон — что не влезло, осталось в общаке'
    else if (done.pass.stopped) stopped = done.pass.stopped
  }

  const fresh = readBase(session, name) || rec
  const got = Object.values(took).reduce((n, k) => n + k, 0)
  const parts = []
  if (got) parts.push(`взял ${Object.entries(took).map(([n, k]) => `${n}×${k}`).join(', ')} из ${from.length} сундук(ов)`)
  else if (!home.shelves.ok.length) parts.push('сундуков на базе не нашёл — stash mode=put поставит новый')
  else parts.push(`${item} в общаке нет`)
  if (home.shelves.lost.length) parts.push(`сундук сломан на ${home.shelves.lost.map(c => `${c.x},${c.y},${c.z}`).join('; ')}`)
  if (stopped) parts.push(stopped)

  return {
    at: { x: rec.x, y: rec.y, z: rec.z },
    took,
    from,
    left: Object.keys(left).length ? left : undefined,
    stash: stashTotals(fresh),
    stopped: stopped || undefined,
    note: parts.join('; ')
  }
}

// Open every shelf and recount. The honest counterpart to `list`: for when the
// cache is old or somebody else has been here.
async function stashCheck (session, ctl, { name = BASE } = {}) {
  const rec = needBase(session, name)
  const deadline = Date.now() + 70000
  const home = await atStash(session, ctl, rec, { grow: false, deadline })
  if (home.far) return { at: { x: rec.x, y: rec.y, z: rec.z }, went: false, stopped: home.far, note: home.far }

  const seen = []
  for (const block of home.shelves.ok) {
    if (ctl.aborted || Date.now() >= deadline) break
    // chestList writes the cache itself through touchChest, so this loop is
    // both the recount and the refresh.
    try { seen.push(await chestList(session, ctl, xyz(block.position))) } catch (e) {
      seen.push({ at: xyz(block.position), error: e.message })
    }
  }
  const fresh = readBase(session, name) || rec
  const parts = [`пересчитал ${seen.length} сундук(ов), свободно ${freeSlots(fresh)} слотов`]
  if (!seen.length) parts.push('открывать нечего: сундуков на базе нет — stash mode=put поставит')
  if (home.shelves.lost.length) parts.push(`сундук сломан на ${home.shelves.lost.map(c => `${c.x},${c.y},${c.z}`).join('; ')}`)
  if (home.shelves.unloaded.length) parts.push(`${home.shelves.unloaded.length} в непрогруженных чанках`)
  return {
    at: { x: rec.x, y: rec.y, z: rec.z },
    chests: fresh.chests.map(chestView),
    stash: stashTotals(fresh),
    lost: home.shelves.lost.length ? home.shelves.lost : undefined,
    note: parts.join('; ')
  }
}

// Reading is the default on both dispatchers. A tool called with no mode at
// all must not move the body or move somebody's goods: `mc_base` answers where
// home is, `mc_stash` answers what is in it.
async function base (session, ctl, p = {}) {
  const how = String(p.mode || 'where').trim().toLowerCase()
  if (how === 'set') return baseSet(session, ctl, p)
  if (how === 'go') return baseGo(session, ctl, p)
  if (how === 'where' || how === 'forget') return baseNow(session, p)
  throw new Error(`не знаю режим ${p.mode}, бывает where / set / go / forget`)
}

async function stash (session, ctl, p = {}) {
  const how = String(p.mode || 'list').trim().toLowerCase()
  if (how === 'put') return stashPut(session, ctl, p)
  if (how === 'take') return stashTake(session, ctl, p)
  if (how === 'check') return stashCheck(session, ctl, p)
  if (how === 'list') return stashNow(session, p)
  throw new Error(`не знаю режим ${p.mode}, бывает list / put / take / check`)
}

module.exports = {
  smelt,
  chestPut,
  chestTake,
  chestList,
  base,
  baseNow,
  stash,
  stashNow,
  // Exported the way build.js exports inPit: the choice rules and the reserve
  // list are the two things worth checking without a server, and the autopilot
  // will want surplusPlan the day it starts tidying up on its own.
  pickBaseSpot,
  surplusPlan,
  // Запас, который не выбрасывается и не кладётся (pack.js: рюкзак полон).
  keepFor,
  readBase,
  BASE_PLACE: BASE,
  // Для архитектора и склада (architect.js, sorting.js): открыть сундук со
  // всеми здешними обходами болезней окна и переложить за один заход.
  findAndOpen,
  guardWindow,
  depositPass,
  withdrawPass
}

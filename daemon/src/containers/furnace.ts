'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from '../movement'
import { countOf, countItems, diffItems, itemNamed } from '../items'
import * as actions from '../actions'
import * as worlds from '../worlds'
import { slotCount, stackOf, live, walkTo, stopWalkingOnAbort, guardWindow, closeStray, raceOpen, waitUpdate, unloadCursor, roomFor, canStow, clearSlot } from './window'
import { KINDS, resolveSmelt, pickFuel } from './fuel'

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

// The order in numbers before anything moves: what into what, how many, on which fuel and for how long.
function smeltOrder (session, { item, count, fuel, timeoutSeconds }) {
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
  return { bot, mcData, runMs, from, into, inputData, need, chosen, fuelData, units, covered, batch }
}

// A furnace in front of us, open and guarded: one nearby or a crafted one, a fresh one at our feet if it would not open.
async function openForSmelt (session, ctl, order) {
  const { bot, from, covered, need } = order
  stopWalkingOnAbort(bot, ctl)
  // order.at — эта печь (вторая печь раздельной плавки, возврат к первой), а не ближайшая.
  let block = order.at || await ensureFurnace(session, ctl, from)
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

  return { ...order, session, ctl, block, note, before, furnace, kind, shut, onClose,
    made: 0, loadedFuel: 0, backFuel: 0, salvaged: 0, stopped: null, inside: null }
}
type SmeltRun = Awaited<ReturnType<typeof openForSmelt>>

// Foreign stacks out, then our fuel and input in. Returns the zero line of the output count and the input load.
async function loadFurnace (sm: SmeltRun) {
  const { ctl, bot, mcData, furnace, into, chosen, from, inputData, batch, fuelData, units } = sm
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
  if (stuckOut && stuckOut.name === into) sm.salvaged = rescued
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
      sm.loadedFuel += fuelUnits
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
    if (sm.loadedFuel) {
      sm.backFuel += await clearSlot(bot, mcData, furnace, furnace.fuelItem(), null, () => furnace.takeFuel())
    }
    throw new Error(`${from} в печку не лёг: ${err.message}`)
  }
  await sleep(250)
  return { started, target }
}

// Watch the slots move until the load is done, the time is up or the furnace stalls; top up the fuel on a stall.
async function watchSmelt (sm: SmeltRun, started, target) {
  const { ctl, bot, furnace, runMs, kind, from, into, fuelData, chosen } = sm
  const deadline = gameClock.now() + runMs
  // Progress is unreadable on this version — it is null until packets arrive
  // and the first reading is a spurious 0, because the fraction is computed
  // against a total that only lands afterwards. So watch the slots move, and
  // treat "nothing has moved for longer than one item takes" as gone dark.
  const stallMs = kind.ms + 8000
  let seen = null
  let lastChange = gameClock.now()

  while (!ctl.aborted) {
    if (!live(bot, furnace)) { sm.stopped = 'печка закрылась'; break }
    const inCount = slotCount(furnace.inputItem(), from)
    const outCount = slotCount(furnace.outputItem(), into)
    const mark = `${inCount}/${outCount}`
    if (mark !== seen) {
      seen = mark
      lastChange = gameClock.now()
    }
    sm.made = outCount - started
    if (sm.made >= target) break
    if (gameClock.now() >= deadline) {
      sm.stopped = 'время вышло'
      break
    }
    // The last item leaves the input slot a tick before it lands in the
    // output, so an empty input is only final once nothing else moves.
    if (!inCount && gameClock.now() - lastChange > 3000) {
      sm.stopped = sm.made < target ? 'плавить больше нечего' : null
      break
    }
    if (gameClock.now() - lastChange > stallMs) {
      // Only an empty fuel slot is a furnace that ran out. If our coal is
      // still lying in there unburnt then the fuel was never the problem,
      // and topping it up just feeds a furnace that is stuck for some other
      // reason — one stall window at a time, until the whole bag is inside.
      const dry = !furnace.fuelItem()
      const inBag = dry ? furnace.count(fuelData.id, null) : 0
      const room = roomFor(furnace.fuelItem(), chosen.name, fuelData.stackSize)
      const add = Math.min(inBag, room, Math.max(1, Math.ceil((target - sm.made) / chosen.items)))
      if (add > 0) {
        try {
          await furnace.putFuel(fuelData.id, null, add)
          sm.loadedFuel += add
        } catch {
          await unloadCursor(bot, furnace, furnace.inventoryStart, furnace.inventoryEnd)
          sm.stopped = 'печка погасла, подбросить не вышло'
          break
        }
        lastChange = gameClock.now()
        await sleep(250)
        continue
      }
      sm.stopped = dry ? 'печка погасла — топливо кончилось' : 'печка стоит и ничего не плавит'
      break
    }
    await waitUpdate(furnace, 1000)
  }
}

// Take the goods out: the output, unburnt fuel, and the input when the smelt stopped short.
async function collectFurnace (sm: SmeltRun) {
  const { ctl, bot, mcData, furnace } = sm
  // On abort the cleanup on ctl.onAbort has already closed the window, and a
  // window the server took away is no better: every click from here would
  // land in the player inventory instead. Read the slots, click nothing.
  const dead = ctl.aborted || !live(bot, furnace)
  if (dead) sm.stopped = sm.stopped || (ctl.aborted ? 'прервано' : 'печка закрылась')

  // out.name, not `into`: a foreign stack clearSlot could not lift out at the
  // start is still sitting there, and it is that stack we need room for.
  const out = dead ? null : furnace.outputItem()
  if (out && canStow(furnace, out.name, stackOf(mcData, out.name), out.count)) {
    try { await furnace.takeOutput() } catch {}
    await sleep(200)
  } else if (out) {
    sm.stopped = sm.stopped || 'инвентарь полон — выплавленное осталось в печке'
  }

  // Never walk away from our own goods. Unburnt fuel comes back too — what is
  // already alight is gone either way, the slot only holds units not yet lit.
  const restFuel = dead || !live(bot, furnace) ? null : furnace.fuelItem()
  const back = restFuel ? restFuel.count : 0
  if (restFuel && canStow(furnace, restFuel.name, stackOf(mcData, restFuel.name), back)) {
    try { await furnace.takeFuel(); sm.backFuel += back } catch {}
  }
  const restInput = dead || !sm.stopped || !live(bot, furnace) ? null : furnace.inputItem()
  if (restInput && canStow(furnace, restInput.name, stackOf(mcData, restInput.name), restInput.count)) {
    try { await furnace.takeInput() } catch {}
  }
}

// The finally of a smelt: cursor back in the bag, what is left inside counted and remembered, the window shut.
async function closeFurnace (sm: SmeltRun) {
  const { bot, furnace, stopped, shut, onClose, session, block } = sm
  // A cursor still holding something turns close() into "drop it on the
  // ground", so it goes back in the bag before the screen comes down.
  await unloadCursor(bot, furnace, furnace.inventoryStart, furnace.inventoryEnd)
  // Counted here, not above, so a throw on the way in is reported too.
  const rest = {}
  for (const it of [furnace.outputItem(), furnace.inputItem(), furnace.fuelItem()]) {
    if (it) rest[it.name] = (rest[it.name] || 0) + it.count
  }
  if (Object.keys(rest).length) sm.inside = rest
  shut()
  bot.removeListener('windowClose', onClose)
  // An abort makes runIntent throw this whole result away and a throw hides
  // it too, so goods we are walking away from go in the journal: coordinates
  // that live in one tool result are lost at the next compaction.
  if (sm.inside) {
    const what = (Object.entries(sm.inside) as [string, any][]).map(([n, c]) => `${n}×${c}`).join(', ')
    try {
      session.journal.append('печка', `осталось внутри: ${what}${stopped ? ` (${stopped})` : ''}`, block.position)
    } catch {}
  }
  // Своё добро в печке — за ним вернуться (takeFurnace): прерванная плавка оставляла сырьё, и тело копало его заново.
  if (sm.inside) session.furnaceLeft = { at: xyz(block.position), dimension: worlds.worldOf(bot), items: sm.inside }
  else if (session.furnaceLeft && block.position.equals(new Vec3(session.furnaceLeft.at.x, session.furnaceLeft.at.y, session.furnaceLeft.at.z))) session.furnaceLeft = null
  await sleep(150)
}

function smeltResult (sm: SmeltRun) {
  const { bot, before, into, salvaged, made, from, chosen, loadedFuel, backFuel, block, inside, note, stopped } = sm
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

// ND_SMELT_SPLIT=1 (ow 27.10): руда (≥ 4) — в две печи разом: первая загружена и оставлена гореть, вторая — свежая у ног
// (8 булыжника), ждём вторую, потом забираем первую. Слиток — 10 с в любой печи: 8 слитков набора портала за ~40 с, а не 80.
// Вторую печь поставить не вышло — ждём первую, как обычная плавка.
function furnaceNear (bot, mcData, except) {
  const ids = ['furnace', 'blast_furnace'].map(n => mcData.blocksByName[n]?.id).filter(Boolean)
  const all = bot.findBlocks({ matching: ids, maxDistance: 4, count: 8 })
  const p = all.find(q => !q.equals(except))
  return p ? bot.blockAt(p) : null
}
async function smeltSplit (session, ctl, p, n) {
  const bot = session.bot, mcData = session.mcData
  const half = Math.floor(n / 2)
  const orderA = smeltOrder(session, { ...p, count: n - half })
  const smA = await openForSmelt(session, ctl, orderA)
  let a
  try { a = await loadFurnace(smA) } finally { await closeFurnace(smA) }
  const atA = smA.block
  let b = null
  if (!ctl.aborted && countOf(bot, orderA.from) > 0) {
    let second = furnaceNear(bot, mcData, atA.position)
    if (!second && (itemNamed(bot, 'furnace') || cobbleOnHand(bot) >= 8)) {
      try {
        if (!itemNamed(bot, 'furnace')) await actions.craft(session, ctl, { item: 'furnace', count: 1 })
        await actions.place(session, ctl, { block: 'furnace' })
      } catch {}
      second = furnaceNear(bot, mcData, atA.position)
    }
    if (second) {
      try {
        const smB = await openForSmelt(session, ctl, { ...smeltOrder(session, { ...p, count: half }), at: second })
        try {
          const lb = await loadFurnace(smB)
          await watchSmelt(smB, lb.started, lb.target)
          await collectFurnace(smB)
        } finally { await closeFurnace(smB) }
        b = smeltResult(smB)
      } catch {}
    }
  }
  const smA2 = await openForSmelt(session, ctl, { ...orderA, at: atA })
  try {
    await watchSmelt(smA2, a.started, a.target)
    await collectFurnace(smA2)
  } finally { await closeFurnace(smA2) }
  const r = smeltResult(smA2)
  if (!b) return r
  const gained = { ...b.gained }
  for (const [k, v] of Object.entries(r.gained)) gained[k] = (gained[k] || 0) + (v as number)
  return { ...r, count: r.count + b.count, gained, split: [r.count, b.count], note: [r.note, 'две печи'].filter(Boolean).join('; ') }
}

async function smelt (session, ctl, { item, count = 1, fuel = null, timeoutSeconds = 120 }: any = {}) {
  if (process.env.ND_SMELT_SPLIT === '1') {
    const { from } = resolveSmelt(session.bot, item)
    const n = Math.min(Math.floor(Number(count)), countOf(session.bot, from), 64)
    if (/^raw_(iron|gold|copper)$|_ore$/.test(from) && n >= 4) return smeltSplit(session, ctl, { item, fuel, timeoutSeconds }, n)
  }
  const order = smeltOrder(session, { item, count, fuel, timeoutSeconds })
  const sm = await openForSmelt(session, ctl, order)
  try {
    const { started, target } = await loadFurnace(sm)
    await watchSmelt(sm, started, target)
    await collectFurnace(sm)
  } finally {
    await closeFurnace(sm)
  }
  return smeltResult(sm)
}

// Плавку оборвали (тактика, таймаут шага графа) — сырьё и выплавленное остались в своей печке (smelt запомнил её в
// session.furnaceLeft). cl-a 14.10: 13 сырого железа ушли в печку, тело копало железо заново ещё 10 минут. Как игрок:
// вернуться, открыть, вынуть выход, вход и несгоревшее топливо.
async function takeFurnace (session, ctl, { maxDistance = 48 }: any = {}) {
  const bot = session.bot
  const left = session.furnaceLeft
  if (!left) return { took: {}, note: 'в печках ничего не оставлял' }
  if (left.dimension !== worlds.worldOf(bot)) return { took: {}, note: `печка в другом мире (${left.dimension})` }
  const pos = new Vec3(left.at.x, left.at.y, left.at.z)
  if (bot.entity.position.distanceTo(pos) > maxDistance) return { took: {}, note: `печка дальше ${maxDistance} бл.` }
  const block = bot.blockAt(pos)
  if (!block || !KINDS[block.name]) { session.furnaceLeft = null; return { took: {}, note: 'печки на месте нет' } }
  // Не дошёл/не открыл трижды — не ходить по кругу: добро списано.
  if ((left.tries = (left.tries || 0) + 1) > 3) { session.furnaceLeft = null; return { took: {}, note: 'к печке не пробился трижды — оставляю' } }
  stopWalkingOnAbort(bot, ctl)
  if (bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) {
    await walkTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 30000)
  }
  if (ctl.aborted) return { took: {}, stopped: 'прервано' }
  const before = countItems(bot)
  const furnace = await openFurnaceAt(bot, bot.blockAt(pos))
  const shut = guardWindow(ctl, furnace)
  try {
    const slots: Array<[() => any, () => Promise<any>]> = [[() => furnace.outputItem(), () => furnace.takeOutput()],
      [() => furnace.inputItem(), () => furnace.takeInput()], [() => furnace.fuelItem(), () => furnace.takeFuel()]]
    for (const [item, take] of slots) {
      if (ctl.aborted || !live(bot, furnace)) break
      await clearSlot(bot, session.mcData, furnace, item(), null, take)
    }
    if (live(bot, furnace) && !furnace.outputItem() && !furnace.inputItem()) session.furnaceLeft = null
  } finally {
    await unloadCursor(bot, furnace, furnace.inventoryStart, furnace.inventoryEnd)
    shut()
    await sleep(150)
  }
  return { took: diffItems(before, countItems(bot)), at: left.at, left: session.furnaceLeft ? session.furnaceLeft.items : undefined }
}

export { smelt, takeFurnace }

'use strict'
import * as gameClock from '../game-clock'
import { sleep } from '../movement'
import { withTimeout } from '../build'

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
async function raceOpen (bot, opening, ms, message, ctl = null) {
  let gaveUp = false
  let abort
  const cancelled = ctl && Array.isArray(ctl.onAbort) && new Promise((_resolve, reject) => {
    abort = () => reject(new Error('прервано'))
    if (ctl.aborted) abort(); else ctl.onAbort.push(abort)
  })
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
    return await withTimeout(cancelled ? Promise.race([opening, cancelled]) : opening, ms, message)
  } catch (err) {
    gaveUp = true
    if (!ctl?.aborted) await closeStray(bot)
    throw err
  } finally { const i = cancelled ? ctl.onAbort.indexOf(abort) : -1; if (i >= 0) ctl.onAbort.splice(i, 1) }
}

// The window's own 'update' as a wake-up tick, with a poll as the floor: a
// furnace that never lights sends nothing at all, and waiting on the event
// alone would hang until the intent timeout.
function waitUpdate (win, ms) {
  return new Promise<any>(resolve => {
    const done = () => {
      gameClock.clearTimeout(timer)
      win.removeListener('update', done)
      resolve(undefined)
    }
    const timer = gameClock.setTimeout(done, ms)
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

export {
  slotCount, stackOf, live, budgetOf, WALK_MS, walkTo, stopWalkingOnAbort, guardWindow, closeStray, raceOpen,
  waitUpdate, unloadCursor, roomFor, bagRoom, shelfRoom, canStow, clearSlot
}

'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from '../movement'
import { GROUPS, resolveItemNames } from '../items'
import { live, budgetOf, WALK_MS, walkTo, stopWalkingOnAbort, guardWindow, closeStray, raceOpen, unloadCursor, bagRoom, shelfRoom } from './window'
import { touchChest } from './base-record'

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

function chestTakeMs (timeoutSeconds = 45) {
  const seconds = Number(timeoutSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('timeoutSeconds должен быть положительным числом')
  return Math.min(CHEST_MS, seconds * 1000)
}

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
    const left = deadline - gameClock.now()
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

async function openContainerAt (bot, ctl, block, deadline, visibleOnly = false, stay = false) {
  const aim = block.position.offset(0.5, 0.5, 0.5)
  let last = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctl.aborted) throw new Error('прервано')
    if (gameClock.now() >= deadline) throw new Error('время открытия сундука вышло')
    await closeStray(bot)
    await bot.lookAt(aim, true) // force: see openFurnaceAt
    const left = deadline - gameClock.now()
    if (ctl.aborted || left <= 0) throw new Error('время открытия сундука вышло или прервано')
    if (visibleOnly) {
      const eye = (require('../pick') as typeof import('../pick')).eyeOf(bot)
      const delta = aim.minus(eye)
      const hit = (require('../pick') as typeof import('../pick')).blockOnRay(bot, eye, delta.scaled(1 / delta.norm()), Math.min(4.5, delta.norm()))
      if (!hit || !hit.pos.equals(block.position)) throw new Error('сундук не в прицеле — не открываю сквозь стену')
    }
    try {
      return await raceOpen(bot, bot.openContainer(block), Math.min(6000, left), `${block.name} не открылся`, ctl)
    } catch (err) {
      last = err
      if (stay || !/windowOpen|не открылся/.test(err.message)) throw err
      // Out of reach is far and away the usual cause, and the reach check above
      // only guarantees we were close enough when we started walking.
      const p = block.position
      const left = deadline - gameClock.now()
      if (left <= 0) break
      try { await walkTo(bot, new goals.GoalNear(p.x, p.y, p.z, 1), Math.min(WALK_MS, left)) } catch {}
    }
  }
  throw new Error(`${block.name} не открылся: ${last.message}`)
}

async function findAndOpen (session, ctl, { x, y, z, visibleOnly = false, stay = false }: any, deadline) {
  const bot = session.bot
  // The one place all three chest actions walk from, so the teardown for the
  // walk lives here too.
  stopWalkingOnAbort(bot, ctl)
  const given = x !== undefined && x !== null && y !== undefined && y !== null && z !== undefined && z !== null
  const block = given
    ? containerAt(bot, x, y, z)
    : bot.findBlock({ matching: b => !!b && CONTAINER.test(b.name), maxDistance: 16 })
  if (!block) throw new Error('рядом нет ни сундука, ни бочки — в 16 блоках пусто')
  if (stay && !inReach(bot, block)) throw new Error('до сундука отсюда не дотянуться')
  if (!stay) await reachContainer(bot, ctl, block, deadline)
  const win = await openContainerAt(bot, ctl, block, deadline, visibleOnly, stay)
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

async function chestList (session, ctl, { x, y, z }: any = {}) {
  const { block, win } = await findAndOpen(session, ctl, { x, y, z }, gameClock.now() + CHEST_MS)
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
async function depositPass (bot, mcData, win, names, { budget = Infinity, caps = null, deadline = Infinity, ctl = null }: any = {}) {
  const put = {}
  const left = {}
  let stopped = null
  let full = false

  for (const name of names) {
    if ((ctl && ctl.aborted) || budget <= 0) break
    if (gameClock.now() >= deadline) { stopped = 'время вышло'; break }
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

async function withdrawPass (bot, mcData, win, names, { budget = Infinity, caps = null, deadline = Infinity, ctl = null }: any = {}) {
  const took = {}
  const left = {}
  let stopped = null
  let full = false

  for (const name of names) {
    if ((ctl && ctl.aborted) || budget <= 0) break
    if (gameClock.now() >= deadline) { stopped = 'время вышло'; break }
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

async function chestPut (session, ctl, { item, count = null, x, y, z }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData

  // Resolve before opening: bot.inventory freezes the moment a window is up,
  // and 'all' plus the group aliases are answered from it.
  const names = resolveItemNames(item, bot)
  if (!names.length) throw new Error('не сказано, что класть')

  // count is a budget for the whole call, not per name: "положи 32 any_ore"
  // means 32 items, not 32 of each kind of ore.
  let budget = budgetOf(count)

  const deadline = gameClock.now() + CHEST_MS
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

async function chestTake (session, ctl, { item, count = null, x, y, z, timeoutSeconds, visibleOnly = false, stay = false }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  if (!String(item || '').trim()) throw new Error('не сказано, что брать')

  let budget = budgetOf(count)

  const deadline = gameClock.now() + chestTakeMs(timeoutSeconds)
  const { block, win } = await findAndOpen(session, ctl, { x, y, z, visibleOnly, stay }, deadline)
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

export {
  CONTAINER, chestTakeMs, findAndOpen, mapOf, shelfFacts, chestList, depositPass, withdrawPass, chestPut,
  ALL_ALIAS, resolveFromContainer, chestTake
}

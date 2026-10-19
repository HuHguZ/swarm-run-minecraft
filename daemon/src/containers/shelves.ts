'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { sleep, travelXZ } from '../movement'
import { itemNamed } from '../items'
import { placeBlockAt, escapePit } from '../build'
import actions = require('../actions')
import * as worlds from '../worlds'
import { walkTo, stopWalkingOnAbort } from './window'
import { LOAD_MS, readBase, rememberChest, markChest } from './base-record'
import { CONTAINER } from './chest'
import { chestSpots } from './base-spot'

// null means "we cannot see that far", which is not the same answer as "your
// chest is gone" and must never be reported as one.
function checkChest (bot, c) {
  const b = bot.blockAt(new Vec3(c.x, c.y, c.z))
  if (!b) return { state: 'unloaded' }
  if (!CONTAINER.test(b.name)) return { state: 'gone', instead: b.name }
  return { state: 'ok', block: b }
}

async function waitLoaded (bot, pos, ms = LOAD_MS) {
  const deadline = gameClock.now() + ms
  while (gameClock.now() < deadline) {
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
async function liveShelves (session, ctl, rec, { grow = false }: any = {}) {
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

async function walkHome (session, ctl, rec, { range = 3, deadline }: any) {
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

export { waitLoaded, growStash, liveShelves, needBase, awayFrom, walkHome }

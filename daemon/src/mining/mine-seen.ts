'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals, Movements } from 'mineflayer-pathfinder'
import { sleep, xyz, describeStall, stuckGuard } from '../movement'
import { missingHarvestTool, countItems, diffItems, resolveBlockIds, toolBudget } from '../items'
import { withTimeout, FACES } from '../build'
import { reachOf, sceneryOf } from '../reach'
import { DIRS, ERRAND_LOOK, at, isLava, clamp, danger, digColumn, walkTo, sweepDrops } from './dig-core'
import { hostilesWithin, nearestScenery, reachWords, throughWallsCounter } from './seal'
import { VERIFY_RANGE, MAX_TRIP, posKey, stamp, ledgerOf, rememberOre, forgetOre, recallOre, noSuchMemory, pickTarget, verify } from './ore-ledger'

// Walking a corridor we already cut is the cheap half of coming back for ore,
// and it only stays cheap if pathfinder is not allowed to invent a shortcut:
// with canDig on it will cut a fresh diagonal through the wall and spend the
// pickaxe we came here to use. So the road is attempted walk-only first, the
// digging movements are the fallback, and the difference is reported —
// dugOnTheWay true means the corridor is broken somewhere, and our own anti-mob
// wall from an earlier drift is the usual reason.
async function travelTo (session, ctl, target, budgetMs) {
  const bot = session.bot
  const started = gameClock.now()
  const swingsBefore = toolBudget(bot, 'pickaxe')
  const from = bot.entity.position.clone()
  const goal = new Vec3(target.x + 0.5, target.y, target.z + 0.5)

  const left = () => Math.max(0, budgetMs - (gameClock.now() - started))
  let error = null
  let dugOnTheWay = false

  // Already within reach of the wall — the "два блока вбок" case — must not
  // cost a pathfinder plan at all.
  if (from.distanceTo(goal) > VERIFY_RANGE) {
    const walkOnly = new Movements(bot)
    walkOnly.canDig = false
    walkOnly.allow1by1towers = false
    walkOnly.allowSprinting = false

    for (const leg of [{ mv: walkOnly, dug: false }, { mv: null, dug: true }]) {
      if (ctl.aborted || left() < 3000) break
      if (leg.mv) bot.pathfinder.setMovements(leg.mv)
      else session.updateMovements(true)

      const guard = stuckGuard(bot, ctl, 8000)
      let timer = null
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 3)),
          guard.promise,
          new Promise<any>((_resolve, reject) => {
            timer = gameClock.setTimeout(() => reject(new Error('дорога не уложилась в срок')), left())
          })
        ])
        dugOnTheWay = leg.dug
        error = null
        break
      } catch (e) {
        error = e
        try { bot.pathfinder.setGoal(null) } catch {}
      } finally {
        guard.stop()
        if (timer) gameClock.clearTimeout(timer)
      }
    }
    session.updateMovements(true)
  }

  const to = bot.entity.position
  return {
    from: xyz(from),
    to: xyz(to),
    meters: Math.round(from.distanceTo(to) * 10) / 10,
    seconds: Math.round((gameClock.now() - started) / 100) / 10,
    // The number the brain budgets with. Down a corridor that is already cut
    // this is zero, and zero is the entire point of the walk-only leg.
    swings: Math.max(0, swingsBefore - toolBudget(bot, 'pickaxe')),
    dugOnTheWay,
    left: Math.round(to.distanceTo(goal) * 10) / 10,
    error: error ? error.message : undefined
  }
}

// Getting inside pickaxe reach of a block in the wall. Three rungs, cheapest
// first, and the third one is the drift's own step — danger(), digColumn(),
// walkTo() — because a notch is a one-cell drift and this file already knows
// how to cut one. Nothing new is invented here on purpose.
async function approach (session, ctl, pos, deadline) {
  const bot = session.bot
  const mcData = session.mcData
  const reachable = () => { const b = bot.blockAt(pos); return !!b && bot.canDigBlock(b) }

  if (reachable()) return { ok: true, notch: 0 }

  // Rung two: let pathfinder find a square the block can be swung from.
  // Walk-only first, for the same reason the road is.
  const walkOnly = new Movements(bot)
  walkOnly.canDig = false
  walkOnly.allowSprinting = false
  for (const mv of [walkOnly, null]) {
    if (ctl.aborted || gameClock.now() >= deadline) break
    if (mv) bot.pathfinder.setMovements(mv)
    else session.updateMovements(true)
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 })),
        Math.min(20000, Math.max(4000, deadline - gameClock.now())),
        'не подойти'
      )
    } catch {
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    if (reachable()) { session.updateMovements(true); return { ok: true, notch: 0 } }
  }
  session.updateMovements(true)

  // Rung three: cut toward it. Two cells is enough for anything in the wall of
  // our own drift; further than that and the honest answer is that the ore is
  // not where we thought the corridor was.
  let notch = 0
  for (let i = 0; i < 2; i++) {
    if (ctl.aborted || gameClock.now() >= deadline) break
    const me = bot.entity.position.floored()
    const dx = pos.x - me.x
    const dz = pos.z - me.z
    // Straight up or straight down: reach is the answer, and a notch here would
    // only dig the floor out from under the body.
    if (!dx && !dz) break
    const dir = Math.abs(dx) >= Math.abs(dz)
      ? (dx >= 0 ? DIRS.east : DIRS.west)
      : (dz >= 0 ? DIRS.south : DIRS.north)
    const cell = me.offset(dir.dx, 0, dir.dz)
    // The same probe the drift runs before every column, under the same rule:
    // it may only ever refuse. A lava pocket behind the vein is found here,
    // before the swing, instead of in the face after it.
    const risk = danger(bot, me, cell, 2, dir)
    if (risk) return { ok: false, reason: risk, notch }
    const cut = await digColumn(bot, mcData, ctl, cell, 2, Math.min(deadline, gameClock.now() + 25000))
    if (cut.stopped) return { ok: false, reason: cut.stopped, need: cut.need, notch }
    if (!(await walkTo(bot, ctl, cell))) {
      const stall = describeStall(bot)
      return { ok: false, reason: `не смог шагнуть в ${at(cell)}: в ногах ${stall.legs}, в голове ${stall.head}`, notch }
    }
    notch++
    if (reachable()) return { ok: true, notch }
  }
  return { ok: false, reason: `до ${at(pos)} не дотянуться: выемка на ${notch} блока не помогла`, notch }
}

// Picking up what we just broke, and saying so when we cannot.
//
// Measured, y=-59 arena, 2026-08-31: case (б) dug the ore, the block vanished
// from the wall, and the answer read `dug: 1, gained: {}`. Case (д) took a
// four-block vein and read `dug: 4, gained: {}`. Two separate causes, and the
// old one-line call to sweepDrops was blind to both.
//
// Cause one is timing. sweepDrops polls bot.entities ONCE and breaks the moment
// nothing is in range — which is right for the drift, where it runs after every
// one of twenty-four steps and a 2.5s wait per step would cost a minute of
// nothing. Called once, straight after a dig, it runs before the server's spawn
// packet for the item has arrived, finds an empty list, and returns. The report
// was then assembled around an inventory nothing had been added to yet. So the
// drops are waited FOR before they are judged missing.
//
// Cause two is reach, and it is not a bug. Vanilla hands an item over at about
// a block; a vein opened sideways scatters its drops across cells whose floor
// we never cut, so the body has nowhere to stand and no honest way to get them
// without digging more. tunnel already has the name for that — `leftBehind`,
// drops it counted and deliberately did not chase — so this reports the same
// thing with the coordinates attached. "добыл 4, поднял 1, три лежат на
// 1704,-59,1822" is a sentence the brain can act on. `gained: {}` next to
// `dug: 4` is the exact silence this whole task is about.
const DROP_NEAR = 3.5

async function collectVein (bot, ctl, spots, { waitMs = 1500, budgetMs = 8000 }: any = {}) {
  const until = gameClock.now() + budgetMs
  const mine = () => (Object.values(bot.entities) as any[]).filter((e : any) =>
    e && e.name === 'item' && e.position &&
    spots.some(s => e.position.distanceTo(s) <= DROP_NEAR))

  // Wait for them to exist at all: anything decided before this is decided
  // about a packet that has not landed. Its own short window, not the whole
  // budget — a block that drops nothing (or drops it down a cave) must cost
  // a second and a half, not eight.
  const waitUntil = gameClock.now() + waitMs
  while (gameClock.now() < waitUntil && !ctl.aborted && !mine().length) await sleep(150)

  // Then sweep for as long as sweeping is still achieving something. Each pass
  // is the drift's own collector with the axis rule switched off — outside a
  // corridor there is no line to bend, and the item is the whole reason we came
  // back. A pass that moves nothing means the rest is out of reach, and one
  // wasted pass is the cheapest possible way to establish that.
  const abandoned = new Set()
  let guard = 0
  while (gameClock.now() < until && !ctl.aborted && mine().length && guard++ < 4) {
    const before = mine().length
    await sweepDrops(bot, ctl, () => true, Math.min(2500, until - gameClock.now()), abandoned)
    await sleep(300) // the server hands the stack over a beat after we stand on it
    if (mine().length >= before) break
  }

  // Дроп провалился в карман жилы в стене («туда телу не встать, в стене под
  // ними нет пола»): шаг вперёд (walkTo) туда не ведёт, а живой игрок просто
  // прорубит клетку. Кампания 2026-09-26: жила железа — 8 руды, в рюкзаке 1,
  // пять слитков в стене при том, что железа на кирку и ведро не хватало.
  // Pathfinder с копанием (updateMovements: canDig при кирке; dontCreateFlow —
  // жидкость не вскрывает), ближние — не дальше 6 блоков, по 6 с на каждый.
  for (const e of (mine().slice(0, 4) as any)) {
    if (ctl.aborted) break
    if (!e.position || e.position.distanceTo(bot.entity.position) > 6) continue
    const c = e.position.floored()
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(c.x, c.y, c.z, 1)), 6000, 'не дошёл до дропа')
    } catch {
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    await sleep(400)
  }

  return mine().map((e : any) => xyz(e.position))
}

// Come back for ore the bot has already seen with its own eyes.
//
// This is the intent the y=-59 run was missing. `mine` stays the right tool for
// "there is a tree in front of me": it looks, finds and takes. This one starts
// from the ledger instead of from the eyes, and that is the only difference
// that matters — it is also the difference between a bot that walks past its
// own diamonds and one that goes back for them.
//
// По шагам: startErrand — цель из памяти, отказы до хода и дорога; veinStep — один блок жилы (ответ 'stop' —
// прежний break, 'next' — прежний continue); finishErrand — дроп, вычерк из памяти и ответ. ctx — всё, что было
// замыканием mineSeen (бывшие let — поля ctx; watch и mobStop — те же замыкания, привязанные к ctx).
interface ErrandCtx {
  session: any; ctl: any; bot: any; mcData: any; deadline: any; want: any; chosen: any; row: any; first: any;
  before: any; oreSet: any; scenery: any; travel: any; taken: any; struck: any; gone: any; exposed: any;
  queue: any; done: any; stopped: any; need: any; threat: any;
  watch: () => any; mobStop: (alarm: any) => string
}

async function mineSeen (session, ctl, {
  at: asked = null,
  block = null,
  count = 8,
  timeoutSeconds = 180
}: any = {}) {
  const ctx = await startErrand(session, ctl, { asked, block, count, timeoutSeconds })
  while (ctx.queue.length && ctx.taken.length < ctx.want) {
    if (await veinStep(ctx) === 'stop') break
  }
  return finishErrand(ctx)
}

async function startErrand (session, ctl, { asked, block, count, timeoutSeconds }): Promise<ErrandCtx> {
  const bot = session.bot
  const mcData = session.mcData
  const deadline = gameClock.now() + clamp(timeoutSeconds, 20, 600, 180) * 1000
  const want = clamp(count, 1, 64, 8)

  const chosen = pickTarget(session, asked, block)
  if (!chosen) throw noSuchMemory(session, asked || null, block)
  const row = chosen.row
  const first = new Vec3(row.x, row.y, row.z)

  const trip = bot.entity.position.distanceTo(first)
  if (trip > MAX_TRIP) {
    throw new Error(
      `${row.name} на ${at(row)} я помню, но до неё ${Math.round(trip)} блоков — это поход, а не добор. ` +
      `Дойди сначала (mc_goto x=${Math.floor(row.x)} z=${Math.floor(row.z)} y=${Math.floor(row.y)}), потом зови меня оттуда.`)
  }

  // Naming the block in a refusal is safe here and only here: it is already in
  // the ledger, so the sentence tells the brain nothing it did not write down
  // itself. firstSolidAhead has the opposite rule for the opposite reason — the
  // rock in front of a fresh drift has never been seen by anyone.
  const probe = bot.blockAt(first)
  if (probe && probe.name === row.name) {
    const problem = missingHarvestTool(bot, probe, mcData)
    if (problem) throw new Error(problem)
  }

  const before = countItems(bot)
  const oreSet = new Set(resolveBlockIds('any_ore', mcData))
  ctl.onAbort.push(() => {
    try { bot.clearControlStates() } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.stopDigging() } catch {}
  })

  const scenery = new Map()

  const travel = await travelTo(session, ctl, first,
    Math.min(90000, Math.max(15000, (deadline - gameClock.now()) * 0.6)))

  const taken = []
  const struck = []
  const gone = []
  const exposed = []
  let stopped = null
  let need = null
  let threat = null

  // The vein. The first block is opened from memory; everything after it is
  // opened from sight, by exactly the rule noteExposedOre uses for the report —
  // a face on a cell we have just emptied is a face a person standing here is
  // looking at. Which is why the rest of the vein never has to be in the ledger,
  // and why a corner-only neighbour is left alone: a player would have to break
  // more stone to see that one too.
  const queue = [first]
  const done = new Set()

  const ctx: ErrandCtx = {
    session, ctl, bot, mcData, deadline, want, chosen, row, first, before, oreSet, scenery, travel,
    taken, struck, gone, exposed, queue, done, stopped, need, threat,
    watch: () => watchErrand(ctx),
    mobStop: alarm => errandMobStop(ctx, alarm)
  }
  return ctx
}

// Not the drift's whole mob doctrine — that lives in tunnel() and combat.js
// and does not belong to a two-block errand. Just the one question a person
// digging in a wall would actually ask: can something close by get at me.
// Asked with the drift's own reachOf, because this guard used to be a private
// «within 3 blocks, or canSeePoint» and at y=1 it refused three calls in a row
// with «zombie в 3 блоках вплотную» — for a zombie in the cave under a
// one-block floor, which the drift beside it had already called scenery.
function watchErrand (ctx: ErrandCtx) {
  const { bot, scenery } = ctx
  const cache = new Map()
  for (const mob of hostilesWithin(bot, ERRAND_LOOK)) {
    const r = reachOf(bot, mob, { cache })
    if (!r.reaches) { scenery.set(mob.id, sceneryOf(mob, r)); continue }
    scenery.delete(mob.id)
    return { kind: 'mob', mob, reach: r }
  }
  return null
}

// One sentence for both places the errand can meet it, carrying the words
// that tell contact from a way in: «вплотную» is said only when it is true.
function errandMobStop (ctx: ErrandCtx, alarm) {
  const { taken } = ctx
  const r = alarm.reach
  ctx.threat = { mob: alarm.mob.name, dist: r.dist, at: xyz(alarm.mob.position), where: r.where, how: r.how }
  if (r.steps !== null) ctx.threat.steps = r.steps
  return `${ctx.threat.mob} в ${ctx.threat.dist} блоках ${r.where}, ${reachWords(r)} — добор бросил, взято ${taken.length}`
}

// Один блок жилы: взгляд, сверка памяти с глазами, подход, лава, удар, грани вскрытой клетки.
async function veinStep (ctx: ErrandCtx): Promise<'stop' | 'next' | undefined> {
  const { session, ctl, bot, mcData, deadline, want, row, first, oreSet, travel, taken, struck, gone, exposed, queue, done,
    watch, mobStop } = ctx
  const pos = queue.shift()
  if (done.has(posKey(pos))) return 'next'
  done.add(posKey(pos))
  if (ctl.aborted) { ctx.stopped = `прервано, взято ${taken.length}`; return 'stop' }
  if (gameClock.now() >= deadline) { ctx.stopped = `время вышло, взято ${taken.length} из ${want}`; return 'stop' }

  const alarm = watch()
  if (alarm) { ctx.stopped = mobStop(alarm); return 'stop' }

  // Memory meets sight, and the order matters: the square is read before the
  // body is walked toward it, not after. Being close enough to see it is the
  // whole licence to look at all — from forty blocks away blockAt is reading
  // the chunk out of client memory, which is the x-ray fairPlay forbids, so
  // verify() answers «далеко» there and nothing is concluded from it.
  let seenNow = verify(bot, { name: row.name, x: pos.x, y: pos.y, z: pos.z })
  if (seenNow.state === 'не прогружено') {
    ctx.stopped = `мир на ${at(pos)} не прогружен — постой рядом и позови ещё раз`
    return 'stop'
  }
  // The ore is gone and we can already see that it is: answered from where
  // the body stands, without a pathfind into a wall with nothing behind it.
  if (seenNow.state === 'нет') {
    gone.push({ at: xyz(pos), помнил: row.name, сейчас: seenNow.found })
    struck.push(pos)
    if (pos.equals(first)) return 'stop'
    return 'next'
  }

  const near = await approach(session, ctl, pos, deadline)
  if (!near.ok) {
    // The first block failing is the whole call failing; a vein block failing
    // is one block left in the wall, and the rest of the vein is still ours.
    if (!taken.length) {
      // When the road itself never arrived, the road's reason is the true one:
      // "до X не дотянуться" would blame the wall for a corridor that is
      // blocked thirty blocks back.
      ctx.stopped = travel.error && travel.left > VERIFY_RANGE
        ? `не дошёл до ${at(pos)}: ${travel.error} (осталось ${travel.left})`
        : near.reason
      ctx.need = near.need || null
      return 'stop'
    }
    return 'next'
  }

  // The walk took a second or two, and a square can change in one. This is
  // the read that decides, and it happens with the body within reach.
  seenNow = verify(bot, { name: row.name, x: pos.x, y: pos.y, z: pos.z })
  // Could not look, as opposed to looked and found nothing. approach() only
  // returns ok when canDigBlock passes, so this is close to impossible — but
  // the two outcomes strike the row off and the difference between them is
  // losing a live vein for good, so they do not share a branch.
  if (seenNow.state === 'далеко' || seenNow.state === 'не прогружено') {
    if (!taken.length) { ctx.stopped = `не разглядел ${at(pos)} вблизи (${seenNow.state})`; return 'stop' }
    return 'next'
  }
  const here = seenNow.block
  if (seenNow.state !== 'на месте' || !here || !oreSet.has(here.type)) {
    // Honest, and this is the whole of case (в): the coordinate is right, the
    // ore is not. "добыл" here, or a throw, would both be worse than simply
    // saying what is in the square now.
    gone.push({
      at: xyz(pos),
      помнил: row.name,
      сейчас: seenNow.found || (here ? here.name : 'не прогружено')
    })
    struck.push(pos)
    if (pos.equals(first)) return 'stop'
    return 'next'
  }

  // Lava behind the vein, asked before the swing rather than felt after it.
  // Same probe, same wording, same one-way rule as every other cell this file
  // cuts: danger() may refuse and may never point at anything worth having.
  const me = bot.entity.position.floored()
  const toward = Math.abs(pos.x - me.x) >= Math.abs(pos.z - me.z)
    ? (pos.x - me.x >= 0 ? DIRS.east : DIRS.west)
    : (pos.z - me.z >= 0 ? DIRS.south : DIRS.north)
  const risk = danger(bot, me, pos, 1, toward)
  if (risk) {
    ctx.stopped = risk
    if (!taken.length) return 'stop'
    return 'next'
  }

  const name = here.name
  const cut = await digColumn(bot, mcData, ctl, pos, 1, Math.min(deadline, gameClock.now() + 30000), watch)
  if (cut.alarm) { ctx.stopped = mobStop(cut.alarm); return 'stop' }
  if (!cut.dug) {
    if (!taken.length) { ctx.stopped = cut.stopped; ctx.need = cut.need || null; return 'stop' }
    return 'next'
  }
  taken.push({ name, at: xyz(pos) })
  struck.push(pos)

  // The cell is empty now, so its six faces are open — the same instant
  // noteExposedOre is written for. Ore of our kind joins the vein; ore of
  // another kind is not ours to dig on this call, but it IS now genuinely
  // seen, so it goes into the ledger for the next one.
  const opened = []
  for (const face of FACES) {
    const nb = bot.blockAt(pos.plus(face))
    if (!nb || !oreSet.has(nb.type)) continue
    if (nb.name === name) {
      if (!done.has(posKey(nb.position))) queue.push(nb.position)
    } else {
      opened.push({
        name: nb.name,
        x: nb.position.x,
        y: nb.position.y,
        z: nb.position.z,
        seen: stamp(),
        why: 'вскрыл жилу'
      })
      exposed.push({ name: nb.name, at: xyz(nb.position) })
    }
  }
  if (opened.length) rememberOre(session, opened)

  // Lava that flowed in after the block came out. digColumn refuses to swing
  // into lava but cannot know what was behind the block it just removed.
  const spill = FACES.map(f => bot.blockAt(pos.plus(f))).find(isLava)
  if (spill) {
    ctx.stopped = `за рудой на ${at(pos)} оказалась лава (${at(spill.position)}) — взял ${taken.length}, ` +
      'дальше не лезу; заткни (mc_place) или обходи с другой стороны'
    return 'stop'
  }
}

// Итог добора: дроп, вычерк из памяти, подсказка, журнал, ответ. После жилы ctx больше не меняется.
async function finishErrand (ctx: ErrandCtx) {
  const { session, ctl, bot, row, chosen, before, travel, taken, struck, gone, exposed, scenery, stopped, need, threat } = ctx
  // The drops, judged against the squares we actually opened rather than
  // against whatever happens to be lying near the body.
  let leftDrops = []
  if (taken.length && !ctl.aborted) {
    leftDrops = await collectVein(bot, ctl, taken.map(t => new Vec3(t.at.x, t.at.y, t.at.z)))
  }

  // Struck off whether we took it or found the square bare: both are the world
  // disagreeing with the row, and a row still offered after the body has stood
  // on it is the ledger lying.
  forgetOre(session, struck)

  const gained = diffItems(before, countItems(bot))
  // Items, not blocks: one lapis ore pays out four or more. The pair
  // (dug, picked) is what makes a shortfall visible at a glance.
  const picked = (Object.values(gained) as any[]).reduce((sum: any, c) => sum + c, 0)
  const left = recallOre(session, { block: row.name, limit: 3 })
  const status = taken.length ? 'добыл' : gone.length ? 'пусто' : 'не вышло'

  let note = null
  // Полный рюкзак — первое, что проверить: дроп рядом не подбирается вовсе,
  // и раньше это читалось как «туда телу не встать» (кампания 2026-09-26:
  // «ещё 4 лежат» в клетке самого штрека, а после pack tidy тело подобрало 17).
  const bagFull = bot.inventory.emptySlotCount() === 0
  if (leftDrops.length && bagFull) {
    note = `добыл ${taken.length}, в рюкзаке ${picked}, ещё ${leftDrops.length} лежат на ${at(leftDrops[0])}` +
      `${leftDrops.length > 1 ? ' и рядом' : ''} — РЮКЗАК ПОЛОН, подобрать некуда. ` +
      'Освободи место (mc_pack mode=tidy, also cobblestone:128) — лежащее рядом подберётся само.'
  } else if (leftDrops.length) {
    note = `добыл ${taken.length}, в рюкзаке ${picked}, ещё ${leftDrops.length} лежат на ${at(leftDrops[0])}` +
      `${leftDrops.length > 1 ? ' и рядом' : ''} — туда телу не встать, в стене под ними нет пола. ` +
      'Забрать: прокопай клетку вбок (mc_tunnel length 1) и позови ещё раз, или брось их — это выбор, а не потеря.'
  } else if (!taken.length && gone.length) {
    note = `блока на ${at(gone[0].at)} больше нет — из памяти вычеркнул, второй раз не предлагай. ` +
      (left.remembered
        ? `Ещё помню ${row.name}: ${left.remembered} шт, ближайшая на ${at(left.spots[0].at)}.`
        : `Другой ${row.name} не помню — нужен новый штрек (mc_tunnel).`)
  } else if (taken.length && !picked) {
    note = `сломал ${taken.length}, а в рюкзаке пусто и дропа рядом не вижу — ` +
      'скорее всего укатился (пещера, вода) или рюкзак полон. Проверь инвентарь и осмотрись (mc_observe).'
  } else if (taken.length && left.remembered) {
    note = `${row.name} помню ещё ${left.remembered} шт, ближайшая на ${at(left.spots[0].at)} — ` +
      'зови ещё раз с этими координатами'
  } else if (threat && !taken.length) {
    // «сначала убери причину» names no call; for a mob there are exactly two —
    // and for one that comes through rock, the wall is not one of them.
    note = threat.how === 'сквозь стены'
      ? `пока ${threat.mob} рядом, добор отсюда ответит то же, и стена тут не поможет — ${throughWallsCounter(threat.mob)}`
      : `пока ${threat.mob} может до меня добраться, добор отсюда ответит то же — убей его (mc_fight) или отгородись (mc_place), потом зови`
  } else if (!taken.length && !gone.length && stopped) {
    note = 'с этого места вызов повторится тем же ответом — сначала убери причину из stopped'
  }

  try {
    session.journal.append('шахта',
      `добор по памяти: ${row.name} на ${at(row)} (видел ${row.seen || '?'}) — ` +
      (taken.length ? `взял ${taken.length}` : gone.length ? 'блока уже нет' : `не вышло: ${stopped || '?'}`) +
      `; дорога ${travel.meters} бл., ${travel.seconds}с, кирка ${travel.swings} ударов`,
      bot.entity.position)
  } catch {}

  return {
    status,
    target: { x: row.x, y: row.y, z: row.z },
    name: row.name,
    // The honesty line, in the answer and not only in the docs: this is what
    // the bot remembered and when, never what it can see from here.
    помнил: { руда: row.name, видел: row.seen || null, откуда: row.why || null },
    snapped: chosen.snapped ? { просили: chosen.asked, взял: { x: row.x, y: row.y, z: row.z } } : undefined,
    travel,
    dug: taken.length,
    vein: taken.map(t => t.at),
    gained,
    // Same word tunnel uses for the same thing, so the brain learns it once.
    // A count beside `dug` and `picked` is what turns a silent shortfall into
    // a fact; the coordinates are what make it recoverable.
    picked,
    leftBehind: leftDrops.length || undefined,
    leftAt: leftDrops.length ? leftDrops : undefined,
    gone: gone.length ? gone : undefined,
    exposed: exposed.length ? exposed : undefined,
    // Deliberately not named "threat": format.js keys its warning line on that
    // field and prints «закрыться НЕ вышло» for it — a claim about a wall this
    // intent never tries to build. The stop reason already spells the mob out,
    // and the renderer promotes that one honestly.
    mob: threat || undefined,
    // Same record, same field name as tunnel's: a mob close by that cannot
    // get at us, said so that the errand carrying on is not read as blindness.
    behindRock: nearestScenery(bot, scenery),
    remembered: ledgerOf(session).length,
    need: need || undefined,
    stopped: stopped || undefined,
    note: note || undefined
  }
}

export { mineSeen }

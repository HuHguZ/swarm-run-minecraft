'use strict'
// Вниз: колодец (digDown) и лестница (digStairs).
// ---------------------------------------------------------------- dig down
import { collectNearbyDrops } from './gather'
import { hazardAt, FREE_FALL, floorBelow, groundUnder, judgeDrop, dropFields, settleFall, recordDrop } from './drop-judge'
import { STAIR_DIRS, facingDir, dirName, STAIR_DIR_LIST, canFootStep, shaftWayOut, ledgeReport, stepForward,
  standingCell, walkOff, placeTorch } from './stair-steps'
import { descentGuard } from './descent-guard'
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { sleep, xyz }: typeof import('../movement') = require('../movement')
const { equipBestTool, missingHarvestTool, countItems, diffItems, toolShortfall, toolStatus, SWINGS_PER_LEVEL }: typeof import('../items') = require('../items')
const { withTimeout, placeBlockAt, pickFiller }: typeof import('../build') = require('../build')
// Stone does not lie around on the surface; getting to it means going down.
// Straight down is how players die to lava, so check two blocks ahead before
// every swing and refuse rather than gamble.
async function digDown (session, ctl, p: any = {}) {
  // A staircase is a different shape of the same intent, so it lives behind
  // the same tool rather than a thirty-fifth one the brain has to learn.
  if (p.mode === 'stairs' || p.mode === 'лестница') return digStairs(session, ctl, p)
  const { depth = 5, maxFallHp = 0 } = p
  const bot = session.bot
  const mcData = session.mcData
  const before = countItems(bot)
  let dug = 0
  const drops = []
  // Health this call has already paid for drops out of maxFallHp.
  let spent = 0
  // The shaft is a column the mob drops into from above or walks into from the
  // cave it breaks; the guard's faces are the cell over the head and that mouth.
  const guard = descentGuard(session, { again: 'mc_dig_down mode=shaft' })
  const finish = (stopped, ledge?: any) => finishDig(bot, ctl, before, dug, stopped, { drops, ledge, guard })
  // Its own deadline, the way digStairs has had one all along. Without it the
  // shaft could only ever be stopped from outside by runIntent, and until today
  // that path answered `timeout` with no detail at all: the blocks were dug and
  // the report was thrown away. session.js hands down the very number it
  // budgeted the intent with and keeps twenty seconds more for itself, so
  // stopping here is the normal ending and the brain gets numbers rather than a
  // bare clock. The fallback repeats session.js's formula for a direct call.
  const deadline = gameClock.now() + Math.max(10, Math.min(600,
    p.budgetSeconds ?? p.timeoutSeconds ?? (25 + Math.max(1, Math.min(128, depth)) * 4))) * 1000

  for (let i = 0; i < depth && !ctl.aborted; i++) {
    if (gameClock.now() >= deadline) {
      return finish(`время вышло на ${dug}-м блоке`)
    }
    // Before the swing: a swing is seconds and the answer to a mob is a block.
    const alarm = await guard.check()
    if (alarm) return finish(alarm)
    const feet = bot.entity.position.floored()
    const below = bot.blockAt(feet.offset(0, -1, 0))
    const under = bot.blockAt(feet.offset(0, -2, 0))
    if (!below) break
    if (below.name === 'bedrock') break

    if (under && /lava/.test(under.name)) {
      return finish('под ногами лава — дальше не копаю')
    }
    if (under && under.name === 'water') {
      return finish('под ногами вода — дальше не копаю')
    }
    // A cave two below used to be a flat «дальше не копаю», and on the run of
    // 2026-09-15 that sentence ended the whole trip at y=1 with the floor five
    // blocks down for two points out of eighteen. The same verdict the staircase
    // uses decides it now: a free drop is taken, a paid one only when the call
    // said how much it will pay, and the refusal names that parameter.
    let jump = null
    if (under && under.boundingBox === 'empty') {
      const deeper = bot.blockAt(feet.offset(0, -3, 0))
      if (deeper && deeper.boundingBox === 'empty') {
        const verdict: any = judgeDrop(session, bot, feet, groundUnder(bot, feet, 32, [below.position]),
          maxFallHp, spent, 'mc_dig_down mode=shaft')
        if (!verdict.ok) {
          // A retry is a way on only while it is one: lava, a bottomless cave
          // and a price no health can pay name no call, and the shaft used to
          // stop right there, on a sentence with nothing to do in it.
          const out = verdict.retry ? null : shaftWayOut(bot, feet, verdict.fall)
          return finish(`под ногами пустота (пещера) — ${verdict.text}${out ? `; ${out.text}` : ''}`,
            { at: xyz(feet), mode: 'shaft', ...dropFields(verdict), ...(out ? out.fields : {}) })
        }
        jump = { verdict, hp: bot.health ?? 20 }
      }
    }

    const problem = missingHarvestTool(bot, below, mcData)
    if (problem) return finish(problem)

    await equipBestTool(bot, below)
    await bot.dig(below)
    dug++
    if (!jump) {
      await sleep(450) // let the body drop into the hole before the next swing
      continue
    }
    await settleFall(bot, ctl, feet.y, jump.verdict.fall)
    const fell = feet.y - bot.entity.position.floored().y
    if (fell > 0) spent += recordDrop(drops, bot, feet, fell, jump)
  }

  return finish(null)
}

async function finishDig (bot, ctl, before, dug, stopped, { drops = [], ledge = null, guard = null }: any = {}) {
  await collectNearbyDrops(bot, ctl, { radius: 4, timeoutMs: 4000 })
  return {
    dug,
    gained: diffItems(before, countItems(bot)),
    depth: xyz(bot.entity.position),
    drops: drops.length ? drops : undefined,
    ...(guard ? guard.report() : {}),
    ledge: ledge || undefined,
    stopped: stopped || undefined
  }
}

// A staircase instead of a shaft. Costs one extra block per level and is worth
// it every time: you can walk back up it, you cannot fall down it, and it does
// not leave the bot stranded at the bottom of a hole pathfinder cannot climb.
// The vertical shaft is still the right answer when the only goal is depth.
// `call` is how the caller's own tool is named in a refusal: mc_recover digs
// with this same staircase, and «прыгну, если позовёшь mc_dig_down» sent from
// inside it would name a sixteen-level dig past the pile instead of the retry.
async function digStairs (session, ctl, {
  depth = 16, direction = null, torchEvery = 6, timeoutSeconds = 240, maxFallHp = 0, call = null, nightWork = false
}: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const dir = direction && STAIR_DIRS[direction] ? STAIR_DIRS[direction] : facingDir(bot)
  const [dx, dz] = dir
  const want = Math.max(1, Math.min(128, depth))
  const deadline = gameClock.now() + Math.max(10, Math.min(600, timeoutSeconds)) * 1000
  const again = call || `mc_dig_down mode=stairs direction=${dirName(dir)}`

  const before = countItems(bot)
  const from = xyz(bot.entity.position)
  let cut = 0
  let stalls = 0
  let torches = 0
  let stopped = null
  // Not «this direction did not work» but «direction is not what is wrong here».
  // Whoever loops over the four outside reads this instead of parsing Russian.
  let noFooting = false
  // Steps founded on a block we placed, and how many of those needed a prop in
  // the open step cell first — the case that used to end the trip.
  let bridged = 0
  let propped = 0
  // Of the bridged steps, those whose block went against the underside of the
  // one above it — the placement no run has yet seen the server accept.
  let underside = 0
  const drops = []
  let spent = 0
  let ledge = null
  const guard = descentGuard(session, { dir, again, own: !call })

  ctl.onAbort.push(() => { try { bot.clearControlStates() } catch {} })

  // Loop on levels delivered, not swings taken: the caller asked for a depth,
  // and a lip-stop that costs an iteration should not cost a metre of descent.
  // The iteration cap is only a runaway guard.
  for (let i = 0; cut < want && i < want * 3 && !ctl.aborted; i++) {
    if (gameClock.now() >= deadline) { stopped = `время вышло на ${cut}-й ступеньке`; break }
    const hp = bot.health ?? 20
    if (hp < 6) { stopped = `здоровья ${Math.round(hp)} — дальше не копаю`; break }

    // Ten levels of pickaxe left is the line, not zero. Measured on the descent
    // that stranded the bot at y=-58: forty levels cost 166 swings and then 182,
    // so a level is four, and running out at depth is not a setback but the end
    // of the run — it could neither dig on nor cut a staircase home, carrying
    // 208 cobblestone the whole time. Asked every level, so the same line is
    // also the up-front refusal when the bag is already under it.
    const worn = toolShortfall(bot, mcData, { need: SWINGS_PER_LEVEL })
    if (worn) { stopped = worn; break }

    // Once at the top of every level and again before every swing below: a
    // step is three cells of rock, several seconds, and a zombie covers the
    // whole watch radius inside one step (the climb measured that as eight hits
    // and no wall, survival.js stairStep).
    const alarm = await guard.check()
    if (alarm) { stopped = alarm; break }

    const feet = standingCell(bot)
    // Stepping from feet down to (dir, -1): the body walks through the two
    // cells at its own height and drops into the one below them.
    const head = feet.offset(dx, 1, dz)
    const mid = feet.offset(dx, 0, dz)
    const low = feet.offset(dx, -1, dz)
    const land = feet.offset(dx, -2, dz)

    const hz = hazardAt(bot, [head, mid, low])
    if (hz) { stopped = `${hz} — дальше не копаю`; break }
    const lowBlock = bot.blockAt(low)
    if (lowBlock && lowBlock.name === 'bedrock') { stopped = 'бедрок — ниже не пройти'; break }

    // Nothing to land on means a cave under the step. Bridging keeps the
    // staircase walkable both ways, but a block can only be placed against a
    // solid neighbour and over open cave there frequently is none — that is
    // exactly where the first real descent stopped, at y=-27 with four
    // directions all refusing. A cave is not an obstacle on the way down, it is
    // a free thirty blocks, so drop into it when the floor is close enough to
    // land on unhurt, and only bridge when it is not.
    //
    // Order, and why: free drop, then support, then a paid drop, then refuse.
    // Support comes BEFORE any cutting: the cell under the step has no face of
    // its own over a cave, but until the step is cut the step block is a face
    // (its underside), and when the step cell is already open — the run of
    // 2026-09-15 stopped on exactly that lip, eight legs at 160,40,120 and down —
    // a prop in it against the side of our own floor makes one. The prop is cut
    // out again as the step itself, so the staircase keeps its shape and costs
    // one block per level over the cave. Health comes after blocks because
    // health is the resource whose shortage ends the trip, and every step gives
    // back two or three cobblestone.
    const under = bot.blockAt(land)
    let drop = 1
    let jump = null
    if (!under || under.boundingBox !== 'block') {
      const reach = floorBelow(bot, low, FREE_FALL)
      if (reach !== null) {
        drop = reach
      } else {
        const put = await placeBlockAt(bot, land, { steady: true, prop: low })
        if (put.ok) {
          bridged++
          if (put.prop) propped++
          if (put.face === 'bottom') underside++
        } else {
          const verdict: any = judgeDrop(session, bot, mid, groundUnder(bot, mid, 32, [low]), maxFallHp, spent, again)
          if (verdict.ok) {
            drop = verdict.fall
            jump = { verdict, hp: bot.health ?? 20 }
          } else {
            // Asked before the answer is written rather than after: whether the
            // other three directions are worth a leg of the trip is the one thing
            // the caller cannot work out from the words on its own.
            const canBuild = !!pickFiller(bot, { steady: true })
            const other = STAIR_DIR_LIST
              .filter(d => d[0] !== dx || d[1] !== dz)
              .find(d => canFootStep(bot, feet, d[0], d[1], canBuild))
            noFooting = !other && !canFootStep(bot, feet, dx, dz, canBuild)
            ;({ stopped, ledge } = ledgeReport(bot, feet, dir, put, other, noFooting, verdict, { canBuild, call: again }))
            break
          }
        }
      }
    }

    let refused = null
    for (const cell of [head, mid, low]) {
      if (ctl.aborted) break
      const b = bot.blockAt(cell)
      if (!b || b.boundingBox === 'empty') continue
      const seen = await guard.check()
      if (seen) { refused = seen; break }
      const problem = missingHarvestTool(bot, b, mcData)
      if (problem) { refused = problem; break }
      try {
        await equipBestTool(bot, b)
        await withTimeout(bot.dig(b), 20000, 'блок не ломается')
      } catch (e) {
        refused = e.message
        break
      }
      // Verify rather than trust. Gravel refills the slot as fast as we empty
      // it, and a swing the server quietly refuses returns without error and
      // leaves the block standing — the bot then walks onto the step instead of
      // into it, and the staircase flattens. One retry, then give up honestly.
      const left = bot.blockAt(cell)
      if (left && left.boundingBox !== 'empty') {
        try {
          await equipBestTool(bot, left)
          await withTimeout(bot.dig(left), 20000, 'блок не ломается')
        } catch (e) {
          refused = e.message
          break
        }
        const still = bot.blockAt(cell)
        if (still && still.boundingBox !== 'empty') {
          refused = `${still.name} на ${cell.x},${cell.y},${cell.z} не ломается`
          break
        }
      }
    }
    if (refused) { stopped = refused; break }
    // The last cell cut is the one most likely to have opened a cave, and the
    // step itself is the next second or so.
    const opened = await guard.check()
    if (opened) { stopped = opened; break }
    const work = nightWork ? (require('../night-work') as typeof import('../night-work')).step(bot, low, feet, 3.25, undefined, 3) : null
    if (work?.stopped) {
      const cover = await (require('../night-work') as typeof import('../night-work')).closeBehind(bot, ctl, mid)
      stopped = `${work.stopped}; ${cover || 'проход закрыт перед собой'}`
      break
    }

    // Into a drop the body goes by walkOff, which lands it in the column the
    // drop was judged on; a free three-block drop that drifts onto a deeper
    // floor next door is a paid one nobody agreed to.
    if (drop > 1) {
      if (!await walkOff(bot, ctl, low, dir, feet.y)) { stopped = 'не смог сойти с уступа в пещеру'; break }
    } else if (!await stepForward(bot, ctl, low)) { stopped = 'не смог шагнуть на ступеньку'; break }

    // Confirm the body is standing IN the step, not on its lip. Planning the
    // next cut from the old level flattens the staircase into a corridor —
    // measured: 20 steps for 13 levels. Waiting for onGround alone is not
    // enough, because standing on the edge is also "on ground"; the height has
    // to have actually changed.
    // A long drop needs a long wait: twelve blocks take most of a second in the
    // air, and reading the height mid-fall counts a stall.
    const settleFor = drop > 1 ? 1500 + drop * 150 : 1200
    let settle = gameClock.now() + settleFor
    while (gameClock.now() < settle && !ctl.aborted) {
      if (bot.entity.position.floored().y <= low.y && bot.entity.onGround) break
      if (drop > 1 && bot.entity.position.floored().y < feet.y && bot.entity.onGround) break
      await sleep(60)
    }
    // Still on the lip. The second push used to aim at the same column centre,
    // and stepForward counts half a block short of that as arrived — so it
    // returned without a tick of walking, from exactly the spot where a body
    // whose hitbox still overhangs the edge stands on it. That is the flattened
    // staircase above, and over a cave it is also a decided drop not taken.
    // Aim past the centre: in rock the uncut wall ahead stops the body anyway,
    // on a bridged step the landing block is still under it at +0.4.
    if (bot.entity.position.floored().y >= feet.y && !ctl.aborted) {
      await stepForward(bot, ctl, low.offset(dx * 0.4, 0, dz * 0.4), 900)
      settle = gameClock.now() + settleFor
      while (gameClock.now() < settle && !ctl.aborted) {
        if (bot.entity.position.floored().y < feet.y && bot.entity.onGround) break
        await sleep(60)
      }
    }
    if (jump) {
      await sleep(400) // fall damage lands on the landing tick, update_health a packet later
      const fell = feet.y - bot.entity.position.floored().y
      if (fell > 0) spent += recordDrop(drops, bot, feet, fell, jump)
    }

    // Count levels actually gained, not swings taken. A step that cut its cells
    // but left the body at the same height is not progress, and three of those
    // in a row means something is in the way that another lap will not move.
    const gainedLevels = feet.y - bot.entity.position.floored().y
    if (gainedLevels > 0) {
      // A step into a cave can be worth several levels at once, and the caller
      // asked for depth, not for swings.
      cut += gainedLevels
      stalls = 0
    } else if (++stalls >= 3) {
      stopped = 'ступенька не углубляется — что-то мешает'
      break
    }
    // Before the torch and the pickup: the pickup walks for up to two and a half
    // seconds every fourth level, the longest stretch of a level with no look.
    const landed = await guard.check()
    if (landed) { stopped = landed; break }
    if (work?.close) {
      stopped = await (require('../night-work') as typeof import('../night-work')).closeBehind(bot, ctl, feet)
      if (stopped) break
    }
    // Light the step we just left. An unlit staircase is a mob spawner pointed
    // at our own back — the run that died at depth was killed by something that
    // spawned in the dark behind it, not by anything it dug into.
    if (!work?.close && torchEvery > 0 && cut % torchEvery === 0 && await placeTorch(bot, feet)) torches++

    // Collecting after every step costs more than the cobblestone is worth.
    if (!work?.close && cut % 4 === 0) await collectNearbyDrops(bot, ctl, { radius: 3, timeoutMs: 2500 })
  }

  if (!nightWork) await collectNearbyDrops(bot, ctl, { radius: 4, timeoutMs: 4000 })
  // Swings left matters more the deeper we are: the climb home is three digs a
  // level, so the brain has to be able to turn back while it still can.
  const picks = toolStatus(bot, 'pickaxe')
  return {
    mode: 'лестница',
    direction: dirName(dir),
    from,
    at: xyz(bot.entity.position),
    steps: cut,
    torches,
    bridged,
    propped,
    underside,
    drops: drops.length ? drops : undefined,
    gained: diffItems(before, countItems(bot)),
    pickaxeLeft: picks.total,
    // The sum alone misled try-tools into reading 135 as "the give did not
    // land": it was five swings of worn iron plus a fresh stone pick the
    // autopilot had just made. A brain reading the sum has the same blind
    // spot — it cannot see that the tool in hand is one block from breaking.
    pickaxes: picks.count ? picks.tools : undefined,
    directionWontHelp: noFooting || undefined,
    ...guard.report(),
    ledge: ledge || undefined,
    stopped: stopped || undefined
  }
}

export { digDown, digStairs }

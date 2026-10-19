'use strict'
import * as gameClock from '../game-clock'
import { xyz, describeStall } from '../movement'
import { missingHarvestTool, itemNamed, countItems, diffItems, resolveBlockIds, toolBudget, toolShortfall, SWINGS_PER_CELL } from '../items'
import { placeBlockAt } from '../build'
import { reachOf, sceneryOf } from '../reach'
import { MAX_LENGTH, MOB_RADIUS, MOB_RADIUS_HURT, LOW_HEALTH, at, flatDist, clamp, resolveDirection, danger, firstSolidAhead, fillerCount, digColumn, walkTo, axisLine, axisSign, sweepDrops, quickBreak } from './dig-core'
import { hostilesWithin, mobVerdict, freeDirections, nearestScenery, reachWords, throughWallsCounter, sealOff, inDrift } from './seal'
import { shaftDown, shaftUp } from './shaft'
import { noteExposedOre, scanOres, stamp, ledgerOf, rememberOre } from './ore-ledger'

// ---------------------------------------------------------------- torches, ore

// placeBlockAt judges success by the target becoming solid, and a torch never
// is, so it reports failure even while the torch is burning: check by name.
// It also keeps trying the remaining faces after the torch has already landed,
// hence the short per-face wait. A torch that does not stick is never a reason
// to abandon the corridor.
async function placeTorch (bot, pos) {
  if (!itemNamed(bot, 'torch')) return false
  // Already lit (we are re-walking an old corridor): nothing to place, and
  // nothing to count either.
  const already = bot.blockAt(pos)
  if (already && /torch/.test(already.name)) return false
  try {
    await placeBlockAt(bot, pos, { item: 'torch', timeoutMs: 1200 })
  } catch {}
  const now = bot.blockAt(pos)
  return !!now && /torch/.test(now.name)
}

// ---------------------------------------------------------------- tunnel

async function tunnel (session, ctl, {
  direction = null,
  length = 16,
  height = 2,
  torchEvery = 8,
  timeoutSeconds = 180,
  toY = null,
  nightWork = false
}: any = {}) {
  // Вниз — колодец со своим чутьём (см. shaftDown); вверх — своим колодцем столбом (shaftUp).
  if (direction === 'down' || direction === 'вниз') return shaftDown(session, ctl, { length, timeoutSeconds, nightWork })
  if (direction === 'up' || direction === 'вверх') return shaftUp(session, ctl, { length, timeoutSeconds, toY, nightWork })
  const bot = session.bot
  const mcData = session.mcData
  const dir = resolveDirection(bot, direction)
  const len = clamp(length, 1, MAX_LENGTH, 16)
  // The body is two blocks tall. A one-high corridor is a hole it cannot enter,
  // so a request for one is rounded up instead of dug and then reported as a
  // failure on the first step.
  const tall = clamp(height, 2, 3, 2)
  const every = clamp(torchEvery, 0, MAX_LENGTH, 8)
  const deadline = gameClock.now() + clamp(timeoutSeconds, 10, 600, 180) * 1000

  const useFair = session.cfg.fairPlay !== false

  // Three minutes of bare-handed swinging that yields nothing is the worst way
  // to spend an intent, so the tool question is settled before the first swing.
  let cursor = bot.entity.position.floored()
  const rock = firstSolidAhead(bot, cursor, dir, tall, len, useFair)
  if (rock) {
    const problem = quickBreak(bot, rock) ? null : missingHarvestTool(bot, rock, mcData)
    if (problem) throw new Error(problem)
  }

  const from = xyz(bot.entity.position)
  // Where the corridor starts is the end the bot walks back in from, which is
  // what makes distance-from-the-mouth the number the brain can act on.
  const mouth = cursor.clone()
  const onLine = axisLine(cursor, dir)
  const before = countItems(bot)
  const oreIds = resolveBlockIds('any_ore', mcData)
  const oreSet = new Set(oreIds)
  const seen = new Set()
  const groups = new Map()
  // Why each spot is in the report, carried alongside it so the ledger written
  // at the end can say "стена штрека" or "в прямой видимости" instead of
  // flattening two different degrees of knowledge into one.
  const why = new Map()

  // The shaft we are standing in is open air we did not have to cut, and its
  // walls are as visible as any we are about to open.
  noteExposedOre(bot, oreSet, cursor, tall, seen, groups, why)

  // runIntent answers the brain the moment an interrupt fires and leaves this
  // loop running behind it, so everything that outlives us is torn down here:
  // a held key and a live swing. Nothing in the drift sets a pathfinder goal
  // any more, but one left over from the intent before would keep walking the
  // body out of the corridor, and clearing it costs nothing.
  ctl.onAbort.push(() => {
    try { bot.clearControlStates() } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.stopDigging() } catch {}
  })

  let dug = 0
  let walked = 0
  let torches = 0
  let offAxis = 0
  let lastTorch = null
  const abandoned = new Set()
  let stopped = null
  // What the brain has to bring for the same call to get further next time.
  // A refusal that only says "нечем" is readable and not actionable.
  let need = null
  let threat = null
  // Set only when calling this again, unchanged, would answer the same thing.
  // Same convention as survival.surface, and for the same reason: the brain
  // calls these in a loop, so a refusal that repeats word for word has to say
  // out loud that it is a wall and not a wait.
  let note = null
  // Hostiles the guard looked at and decided were scenery, by entity id. Worth
  // reporting even though they changed nothing: the brain should hear that
  // there is a zombie under the floor even when the drift walks straight on.
  const scenery = new Map()

  // The plan is what the corridor follows, never the body. Plenty can shove us
  // off the line — a drop we stepped aside for, a mob, a gravel column coming
  // down — and a drift that resumes from wherever the feet ended up is a drift
  // that bends. So the body is put back on the cursor before the next column is
  // cut, and the count goes into the result instead of quietly into the corridor.
  //
  // Distance *along* the line is held for a harder reason than tidiness. The
  // drop sweep is allowed to walk a couple of blocks back down the corridor,
  // and bot.dig never checks reach — mineflayer has canDigBlock but dig does
  // not call it — so a swing at a column four blocks away is dropped by the
  // server without a word and costs the full 20s dig timeout before digColumn
  // reports the stone as unbreakable. False means the body could not be brought
  // back within reach of the next column: a reason to end the drift honestly
  // rather than keep swinging at nothing.
  const offCursor = () => flatDist(bot.entity.position, cursor.offset(0.5, 0, 0.5))
  const holdAxis = async () => {
    if (ctl.aborted) return true
    const drifted = !onLine(bot.entity.position)
    if (!drifted && offCursor() < 1.2) return true
    if (drifted) offAxis++
    await walkTo(bot, ctl, cursor, 1500)
    return offCursor() <= 2.5
  }

  // The standing guard. Asked at the top of every step and between swings
  // inside digColumn, so the worst case between two looks is one block of
  // digging rather than one whole column.
  const watch = () => {
    const health = Math.round(bot.health ?? 20)
    const hurt = health < LOW_HEALTH
    const near = hostilesWithin(bot, hurt ? MOB_RADIUS_HURT : MOB_RADIUS)
    // One block read per cell for the whole look, however many mobs share it.
    const cache = new Map()
    for (const mob of near) {
      const r = reachOf(bot, mob, { cache })
      const why = mobVerdict(bot, cursor, dir, tall, mob, r)
      if (why === 'blocked') { scenery.set(mob.id, sceneryOf(mob, r)); continue }
      scenery.delete(mob.id)
      return { kind: 'mob', mob, health, why, reach: r }
    }
    if (hurt) return { kind: 'health', health }
    return null
  }

  // Close the corridor first, report second. The old order — report first,
  // close never — is the one that got the bot killed at y=-29.
  const answerMob = async (mob, health, why, r) => {
    const stand = bot.entity.position.floored()
    // Snapshot: everything reported is measured at the moment of the alarm, so
    // the numbers in the answer belong to the same instant as the decision.
    const mobPos = mob.position.clone()
    const dist = Math.round(mobPos.distanceTo(bot.entity.position) * 10) / 10
    const sign = axisSign(stand, dir, mobPos)
    const where = sign > 0 ? 'впереди' : 'позади'
    const have = fillerCount(bot)
    threat = { mob: mob.name, where, dist, at: xyz(mobPos), health, drift: inDrift(bot, stand, dir, tall) }
    // How it gets at us, so the stop can be told apart from the y=1 kind: a
    // number of steps is a way in, «вплотную» is contact, «стреляет» is sight.
    if (r && r.how) { threat.how = r.how; if (r.steps !== null) threat.steps = r.steps }

    // Rock between us and it, and it sits in the tube we are cutting. No wall is
    // attempted: the wall is already there and it is ours to break, so reporting
    // "заложился, placed 0" would credit the bot with building the very stone it
    // is about to remove — the exact sentence that repeated four calls running.
    if (why === 'ahead') {
      threat.rockBetween = true
      threat.inPath = true
      const free = freeDirections(bot, stand, tall, hostilesWithin(bot, MOB_RADIUS_HURT))
      note = free.length
        ? `штрек на ${dir.ru} упирается в ${mob.name} за породой — этим же вызовом ничего не изменится; свободно: ${free.join(', ')}`
        : `${mob.name} перекрывает все четыре стороны — копать отсюда бесполезно, сначала убей (mc_fight) или уйди по вертикали`
      return `${mob.name} в ${dist} блоках ${where} на ${at(mobPos)}: порода между нами есть, но штрек идёт прямо на него и вскроет её`
    }

    const seal = await sealOff(bot, ctl, stand, tall, mob, mobPos, have > 0)
    if (seal.wall) threat.wall = xyz(seal.wall)
    threat.placed = seal.placed
    threat.sealed = seal.sealed
    // The body may have stepped back out of the square the wall went into; the
    // corridor plan follows it, or the tidy-up walk at the end would march
    // straight back into the wall we just built.
    if (seal.movedTo) cursor = seal.movedTo

    const how = r ? `, ${reachWords(r)}` : ''
    if (seal.sealed) {
      // The way in can close between the alarm and the wall — the mob moves.
      // Saying "заложился" then would credit the bot with a wall it did not
      // build and hide the fact that the way in is somewhere else entirely.
      return seal.placed
        ? `${mob.name} в ${dist} блоках ${where}${how} — заложился на ${at(seal.wall)}, ${seal.placed} бл., проход закрыт`
        : `${mob.name} в ${dist} блоках ${where}, между нами сплошная порода на ${at(seal.wall)} — стою за ней`
    }

    // The wall did not close. The old answer here walked the body back down
    // the drift to the last torch, and that answer is dead: measured in
    // try-tunnel, the bot backed seven blocks off a zombie and died on the
    // square the retreat ended at (memory/state.json, 598,50,620); measured
    // again in try-corridor, three blocks back cost 17 hp in six seconds.
    // Sprint is off to keep the physics in sync with the server, so a zombie is
    // simply faster than this body — README has said so from the first day and
    // this is the third confirmation. Walking away from melee does not work in
    // any amount.
    //
    // So the retreat is not traded for a better retreat, it is removed. What it
    // actually spent was the one thing that does help: the seconds before the
    // brain gets to decide. This branch now answers in well under a second when
    // the bag is empty — pickFiller returns null before a single packet goes
    // out. Choosing to fight instead is not a mining intent's call to make, and
    // combat doctrine lives in combat.js, so the answer states the ground it
    // would be fought on and leaves mc_fight to the brain.
    const refusal = seal.reason || 'блок не встал'
    // Blocks and the shape of the drift are both beside the point against a mob
    // that comes through rock: asking for blocks, or saying «only head on», would
    // steer the brain towards a wall or a fight in the drift.
    const throughWalls = !!r && r.how === 'сквозь стены'
    if (!have && !throughWalls) need = { what: 'любые блоки на перегородку', count: tall, have: 0 }
    const ground = throughWalls
      ? 'штрек от него не укрывает'
      : threat.drift
        ? 'штрек 1×2, подойти он может только в лоб'
        : 'я не в штреке, обойти ему есть где'
    // It can get at us, so it will be able to again: this refusal repeats word
    // for word until the mob or the empty bag is dealt with, and neither of
    // those two moves belongs to a mining intent. Same wording problem
    // survival.surface hit and solved the same way.
    note = throughWalls
      ? `штрек будет отвечать то же самое, пока ${mob.name} рядом, и стена тут не поможет — ${throughWallsCounter(mob.name)}`
      : have
        ? `штрек будет отвечать то же самое, пока ${mob.name} рядом — убей (mc_fight) или отгородись (mc_place), потом зови`
        : `штрек будет отвечать то же самое с пустым рюкзаком — принеси ${tall} блока на перегородку или убей (mc_fight)`
    return `${mob.name} в ${dist} блоках ${where}${how}, закрыться не вышло (${refusal}); ${ground}`
  }

  const answerAlarm = async (alarm) => {
    if (alarm.kind === 'mob') return answerMob(alarm.mob, alarm.health, alarm.why, alarm.reach)
    note = 'на этом здоровье штрек будет вставать сразу — поешь или отлежись, потом зови'
    return `здоровья ${alarm.health} из 20 — вылезаю, штрек брошен на ${walked}-м блоке из ${len}`
  }

  for (let step = 1; step <= len; step++) {
    if (ctl.aborted) { stopped = `прервано на ${walked}-м блоке из ${len}`; break }
    if (gameClock.now() >= deadline) { stopped = `время вышло на ${walked}-м блоке из ${len} — позови ещё раз, продолжу отсюда`; break }

    const alarm = watch()
    if (alarm) { stopped = await answerAlarm(alarm); break }

    // The same line the staircase holds, priced per cell: a drift cuts `tall`
    // of them per block. Stopping here with forty swings left is what pays for
    // the walk back to the mouth; stopping when the pickaxe is already gone
    // pays for nothing — that is the y=-58 shape exactly.
    const worn = toolShortfall(bot, mcData, { need: tall * SWINGS_PER_CELL })
    if (worn) {
      stopped = worn
      need = { what: 'кирка', count: 1, have: 0, swingsLeft: toolBudget(bot, 'pickaxe') }
      break
    }

    if (!(await holdAxis())) {
      stopped = `сбило с оси: я на ${at(bot.entity.position)}, штрек идёт по ${at(cursor)} — вернуться не смог`
      break
    }

    const cell = cursor.offset(dir.dx, 0, dir.dz)
    const risk = danger(bot, cursor, cell, tall, dir)
    if (risk) { stopped = risk; break }

    const cut = await digColumn(bot, mcData, ctl, cell, tall, deadline, watch)
    dug += cut.dug
    // Before the break, not after it: a column that only opened halfway still
    // opened, and the wall it uncovered is the reason we came down here.
    noteExposedOre(bot, oreSet, cell, tall, seen, groups, why)
    if (cut.alarm) { stopped = await answerAlarm(cut.alarm); break }
    if (cut.stopped) { stopped = cut.stopped; need = cut.need || null; break }

    // A cave under the next step is a fall we would then have to climb out of,
    // so the floor gets laid before the foot goes down.
    const floorPos = cell.offset(0, -1, 0)
    const floor = bot.blockAt(floorPos)
    if (!floor || floor.boundingBox !== 'block') {
      const bridge = await placeBlockAt(bot, floorPos, { timeoutMs: 4000 })
      if (!bridge.ok) {
        // "нечем строить" told the brain nothing it could act on: dug 0 walked 4
        // and no idea what to pack. An estimate of the whole rest of the drift
        // is the honest upper bound — a cave under one step is usually a cave
        // under the next ten.
        const rest = Math.max(1, len - walked)
        const have = fillerCount(bot)
        need = { what: 'любые блоки на засыпку пола', count: rest, have }
        stopped = `под ногами дыра на ${at(floorPos)}: нужно ~${rest} блоков на засыпку, в рюкзаке ${have} (${bridge.reason})`
        break
      }
    }

    const behind = cursor
    const work = nightWork ? (require('../night-work') as typeof import('../night-work')).step(bot, cell, behind, 2, undefined, tall) : null
    if (work?.stopped) {
      const cover = await (require('../night-work') as typeof import('../night-work')).closeBehind(bot, ctl, cell)
      stopped = `${work.stopped}; ${cover || 'проход закрыт перед собой'}`
      break
    }
    const moved = await walkTo(bot, ctl, cell)
    if (!moved) {
      const stall = describeStall(bot)
      stopped = `не смог шагнуть в ${at(cell)}: в ногах ${stall.legs}, в голове ${stall.head}, под ногами ${stall.ground}`
      break
    }
    walked++

    // The body is the source of truth for height: one unnoticed step down and
    // every column after it would be cut at the wrong level.
    const stood = bot.entity.position.floored()
    cursor = Math.abs(stood.y - cell.y) <= 2 ? cell.offset(0, stood.y - cell.y, 0) : cell
    // Stepping down into a cave puts the body in a cell nobody cut, whose walls
    // are open all the same. Without this the drift loses exactly the ore it
    // just walked past — the same loss noteExposedOre exists to prevent.
    if (!cursor.equals(cell)) noteExposedOre(bot, oreSet, cursor, tall, seen, groups, why)

    if (work?.close) {
      stopped = await (require('../night-work') as typeof import('../night-work')).closeBehind(bot, ctl, behind)
      if (stopped) break
    } else await sweepDrops(bot, ctl, onLine, 2500, abandoned)
    // Back on the cursor before the torch goes in: a sweep that walked two
    // blocks back leaves the torch either in the wrong square or out of reach,
    // and an unlit corridor is what the walk home is ambushed in.
    await holdAxis()

    // The cell we just left: empty, floored, and out of the way of the swing.
    if (!work?.close && every && step % every === 0) {
      if (await placeTorch(bot, behind)) { torches++; lastTorch = behind }
    }

    scanOres(bot, oreIds, useFair, seen, groups, 4, why)
  }

  // Whatever else went wrong, we do not leave the body standing in a side
  // pocket: the corridor is the way back to the mouth, and `to` is read as
  // where the drift ended. A deliberate retreat or a step back to build a wall
  // has already moved the cursor with the body, so this does not undo either.
  await holdAxis()

  scanOres(bot, oreIds, useFair, seen, groups, 6, why)
  const here = bot.entity.position
  const round1 = d => Math.round(d * 10) / 10
  // Two distances, because they answer two different questions: fromHere is
  // what it costs to turn round and dig it out now, fromMouth is what it costs
  // to come back for it later down a corridor that is already lit.
  const ores = [...groups.entries()]
    .map(([name, spots]) => {
      const nearest = spots.reduce((a, b) => (a.distanceTo(here) <= b.distanceTo(here) ? a : b))
      return { name, count: spots.length, nearest, dist: nearest.distanceTo(here) }
    })
    .sort((a, b) => a.dist - b.dist)
    .map(g => ({
      name: g.name,
      count: g.count,
      nearest: xyz(g.nearest),
      fromHere: round1(g.dist),
      fromMouth: round1(g.nearest.distanceTo(mouth))
    }))

  // The drift's own memory, and the only place in the daemon it is written.
  // Everything in groups got there through noteExposedOre or through a raycast
  // that reached the block, so writing all of it down writes down exactly what
  // a person walking this corridor saw — no more. The ores list above keeps
  // only the nearest of each kind because that is what fits in an answer; the
  // ledger keeps every spot, because nearest is the one the bot is about to
  // take and the other three are the reason to come back.
  const spots = []
  for (const [name, positions] of groups) {
    for (const p of positions) {
      spots.push({ name, x: p.x, y: p.y, z: p.z, seen: stamp(), why: why.get(`${p.x},${p.y},${p.z}`) || 'стена штрека' })
    }
  }
  let remembered = 0
  try { remembered = rememberOre(session, spots) } catch {}

  // A call that dug nothing and walked nowhere will answer the same thing next
  // time unless something outside this intent changes, and the y=-51 run spent
  // four calls proving it. Naming that is the whole difference between a
  // refusal and a hang.
  if (!note && stopped && !walked && !dug) {
    note = /лава|вода|бедрок/.test(stopped)
      ? 'в эту сторону штрек не пойдёт вообще — меняй направление или уровень'
      : 'с этого места вызов повторится тем же ответом'
  }

  // A corridor is a place the bot comes back to; coordinates that live only in
  // one tool result are lost the moment the context is compacted.
  if (walked || threat) {
    try {
      session.journal.append(
        'шахта',
        `штрек на ${dir.ru}, ${walked} блоков, ` +
        (ores.length ? `в стенах: ${ores.map(o => `${o.name}×${o.count}`).join(', ')}` : 'руды не видно') +
        (offAxis ? `, ${offAxis} раз сносило с оси` : '') +
        (threat ? `, ${threat.mob} ${threat.where}: ${threat.inPath ? 'в забое за породой' : threat.sealed ? 'заложился' : 'закрыться не вышло'}` : '') +
        (stopped ? ` (встал: ${stopped})` : ''),
        bot.entity.position
      )
    } catch {}
  }

  return {
    direction: dir.name,
    from,
    to: xyz(bot.entity.position),
    dug,
    gained: diffItems(before, countItems(bot)),
    walked,
    remaining: Math.max(0, len - walked),
    torches,
    offAxis,
    leftBehind: abandoned.size,
    lastTorch: lastTorch ? xyz(lastTorch) : undefined,
    ores,
    // How many of those spots are new to memory, and how many the bot is
    // carrying in total. This is what makes mc_mine_seen callable later: the
    // coordinates outlive the tool result they arrived in.
    remembered,
    oreMemory: (() => { try { return ledgerOf(session).length } catch { return undefined } })(),
    threat: threat || undefined,
    behindRock: nearestScenery(bot, scenery),
    need: need || undefined,
    stopped: stopped || undefined,
    note: note || undefined
  }
}

export { tunnel }

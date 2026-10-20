import { deathPos, worlds, sleep, xyz, travelXZ, inWater, findNearestLand, findSwimRoute, escapeWater, gameClock, DESPAWN_MINUTES, itemNamed, countItems, diffItems, equipBestTool, missingHarvestTool, toolBudget, toolShortfall, SWINGS_PER_LEVEL, descentPlan, BLOCKS_PER_SECOND, SECONDS_PER_LEVEL, PICKUP_RESERVE_MS, digStairs, ledgerOf, isDrop, spot, WRITTEN_OFF_MS, sweepDrops, nearestHostile, HOSTILES, corridorShape, openSides, liveAttacker, RANGED, AROUND, stackWord, SWEEP_HOP_MS, leftWhy, stackLabel, Vec3, SIDES, canSeePoint, placeBlockAt, digUp, pickFiller, withTimeout, occupiedByEntity } from './enter-shelter'
// Поход за вещами (recoverLoot): цель, цена дороги, спуск лесенкой, обход кучи и ответ — по шагам; общие значения шагов
// (прежние const и `let` тела) — поля объекта lr (LootRun), прежние внутренние стрелки (away, hurt, refuse) — функции с lr.
interface LootRun {
  session: any
  ctl: any
  bot: any
  deaths: any[]
  target: any
  slot: any
  diedAt: any
  ageSeconds?: number | null
  ageMinutes?: number | null
  ticked?: any
  leftSeconds?: number | null
  budgetSeconds?: number
  deadline?: number
  reach?: number
  before?: any
  plan?: any
  walkBlocks?: number
  walkSeconds?: number
  digSeconds?: number
  etaSeconds?: number
  road?: any
  picks?: number
  trip?: any
  stairs?: any
  health?: any
  ledged?: boolean
  arrived?: boolean
  ledger?: any
  carried?: any[]
  sweptFrom?: any
  sweep?: any
  guard?: any
}

async function recoverLoot (session, ctl, { x, y, z, index = null, radius = 6, timeoutSeconds = 90, force = false, maxFallHp = 0 }: any = {}) {
  const lr = lootTarget(session, ctl, { x, y, z, index })
  const other = otherWorld(lr)
  if (other) return other
  lootRoad(lr, { radius, timeoutSeconds })

  if (force !== true) {
    const refused = lootRefusal(lr)
    if (refused) return refused
  }

  await lootTrip(lr, { maxFallHp })
  await lootSweep(lr)

  await sleep(500) // the last stack lands in the inventory a tick or two after the walk
  const tally = lootTally(lr)
  const { note, ledgeStop } = lootNote(lr, tally)
  return lootResult(lr, tally, note, ledgeStop)
}

// Куда идти: явные координаты, смерть по номеру или последняя незабранная.
function lootTarget (session, ctl, { x, y, z, index }): LootRun {
  const bot = session.bot
  const deaths = Array.isArray(session.journal.state.deaths) ? session.journal.state.deaths : []

  let target = null
  let slot = null
  let diedAt = null

  if (x !== undefined && x !== null && z !== undefined && z !== null) {
    const yy = y === undefined || y === null ? bot.entity.position.y : y
    target = { x: Math.round(Number(x)), y: Math.round(Number(yy)), z: Math.round(Number(z)) }
    // A NaN goal is not a failed walk, it is a walk that never ends: pathfinder
    // searches for a node that cannot exist until the budget runs out.
    if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) {
      throw new Error(`это не координаты: ${x}, ${z}`)
    }
  } else if (index !== null && index !== undefined) {
    const p = deathPos(deaths[index])
    if (!p) throw new Error(`смерти №${index} с координатами в памяти нет`)
    slot = Number(index)
    diedAt = deaths[index].at
    target = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }
  } else {
    for (let i = deaths.length - 1; i >= 0; i--) {
      const p = deathPos(deaths[i])
      if (!p || deaths[i].recovered === true) continue
      slot = i
      diedAt = deaths[i].at
      target = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }
      break
    }
    if (!target) throw new Error('идти не за чем: незабранных смертей с координатами в памяти нет')
  }
  return { session, ctl, bot, deaths, target, slot, diedAt }
}

function otherWorld (lr: LootRun) {
  const { bot, deaths, target, slot } = lr
  // Смерть в другом мире (worlds.js): ни шага. Pathfinder пошёл бы к тем же
  if (slot !== null && deaths[slot]) {
    const other = worlds.refuseOtherWorld(bot, { ...target, dimension: deaths[slot].dimension }, `Смерть №${slot}`)
    if (other) {
      return {
        at: xyz(bot.entity.position),
        target,
        death: slot,
        went: false,
        moved: 0,
        world: { here: worlds.worldOf(bot), record: worlds.worldOfRecord(deaths[slot]) },
        stopped: other + ` Потом mc_recover index=${slot}.`
      }
    }
  }
  return null
}

// Сроки кучи и цена всей дороги — до первого шага.
function lootRoad (lr: LootRun, { radius, timeoutSeconds }) {
  const { bot, deaths, target, slot, diedAt } = lr
  // The oldest death records carry x and z and no y at all, and Math.round of
  if (!Number.isFinite(target.y)) target.y = Math.floor(bot.entity.position.y)

  const died = diedAt ? Date.parse(diedAt) : NaN
  const ageSeconds = Number.isFinite(died) ? Math.round((gameClock.wall.now() - died) / 1000) : null
  const ageMinutes = ageSeconds === null ? null : Math.round(ageSeconds / 60)
  // Explicit coordinates carry no clock — a stash the brain dropped on purpose
  const ticked = slot !== null && deaths[slot] && typeof deaths[slot].ticking === 'number' ? deaths[slot].ticking : null
  const leftSeconds = ageSeconds === null ? null : DESPAWN_MINUTES * 60 - (ticked ?? ageSeconds)

  const budgetSeconds = Math.max(15, Math.min(280, Number(timeoutSeconds) || 90))
  const deadline = gameClock.now() + budgetSeconds * 1000
  // Same reason clampDepth guards against null: a null radius sails through the
  const reach = Math.max(1, Math.min(24, Math.round(Number(radius)) || 6))
  const before = countItems(bot)

  // Cost the whole trip before taking a single step. Walking two hundred
  const feetNow = bot.entity.position.floored()
  const plan = descentPlan(feetNow, target)
  const walkBlocks = Math.round(Math.hypot(feetNow.x - plan.from.x, feetNow.z - plan.from.z))
  const walkSeconds = Math.round(walkBlocks / BLOCKS_PER_SECOND)
  const digSeconds = plan.down >= 2 ? plan.down * SECONDS_PER_LEVEL : 0
  const etaSeconds = walkSeconds + digSeconds
  const road: any = { walk: walkBlocks, down: plan.down, walkSeconds, digSeconds, etaSeconds, leftSeconds }
  const picks = toolBudget(bot, 'pickaxe')
  Object.assign(lr, { ageSeconds, ageMinutes, ticked, leftSeconds, budgetSeconds, deadline, reach, before, plan, walkBlocks, walkSeconds, digSeconds, etaSeconds, road, picks })
}

const away = (lr: LootRun) => Math.round(Math.hypot(lr.bot.entity.position.x - lr.target.x, lr.bot.entity.position.z - lr.target.z))

// A loot run no longer stops on `damage` (session.js), and it must not: this
const hurt = (lr: LootRun) => Math.round(lr.bot.health ?? 20) < 6

const refuse = (lr: LootRun, why) => {
  const { session, bot, target, slot, ageMinutes, road, plan, walkBlocks, walkSeconds, digSeconds, leftSeconds } = lr
  const note = `${why}. Идти ${walkBlocks} блоков (~${walkSeconds}с)` +
    (digSeconds ? `, потом вниз ${plan.down} уровней (~${digSeconds}с)` : '') +
    (leftSeconds !== null ? `; вещам лежать ещё ${Math.max(0, leftSeconds)}с` : '')
  session.journal.append('лут',
    `не пошёл за вещами на ${target.x},${target.y},${target.z}: ${note}`, bot.entity.position)
  return {
    at: xyz(bot.entity.position),
    target,
    death: slot === null ? undefined : slot,
    ageMinutes,
    picked: 0,
    gained: {},
    arrived: false,
    went: false,
    road,
    note,
    stopped: why
  }
}

// Без force: куча уже пропала, кирки нет на спуск, не успеть до исчезновения или в срок вызова — отказ до первого шага.
function lootRefusal (lr: LootRun) {
  const { session, slot, ageSeconds, ageMinutes, ticked, leftSeconds, budgetSeconds, plan, walkBlocks, digSeconds, etaSeconds, picks } = lr
  if (leftSeconds !== null && leftSeconds <= 0) {
    // Not a guess: the five minutes are up. Write the death off so the next
    if (slot !== null) {
      session.journal.patch(s => {
        const d = s.deaths[slot]
        if (d) { d.recovered = true; d.lost = 'пролежало 5 минут и пропало' }
      })
    }
    return refuse(lr, `умер ${ageMinutes} мин назад, куча тикала ${ticked ?? ageSeconds} с из ${DESPAWN_MINUTES * 60} — вещей там уже нет, списал эту смерть`)
  }
  if (plan.down >= 2 && !(picks > 0)) {
    // The usual state after a death: respawned with an empty backpack. There
    // is no point walking anywhere first.
    return refuse(lr, `до кучи вниз ${plan.down} уровней, а кирки нет — прокопаться нечем`)
  }
  // Куча стареет, только пока её чанк тикает (lootclock.js): вдали от неё
  const tickingEta = ticked !== null
    ? Math.round(Math.min(walkBlocks, (require('.././lootclock') as typeof import('.././lootclock')).SIM * 16) / BLOCKS_PER_SECOND) + digSeconds
    : etaSeconds
  if (leftSeconds !== null && tickingEta > leftSeconds) {
    return refuse(lr, `не успею: дорога ~${etaSeconds}с (из них у кучи ~${tickingEta}с), а вещи пропадут через ${leftSeconds}с`)
  }
  if (etaSeconds > budgetSeconds) {
    return refuse(lr, `за ${budgetSeconds}с не успею, дорога ~${etaSeconds}с — дай timeoutSeconds побольше`)
  }
  return null
}

// Дорога: дойти к началу спуска, лесенкой вниз к куче, добрать остаток сверху.
async function lootTrip (lr: LootRun, { maxFallHp }) {
  const { session, ctl, bot, target, slot, deadline, reach, plan, digSeconds, road } = lr
  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  })

  // Keep the last twenty seconds back for the pickup itself: arriving with an
  const walkUntil = Math.max(gameClock.now() + 5000, deadline - PICKUP_RESERVE_MS - digSeconds * 1000)
  const trip = await travelXZ(bot, ctl, plan.from.x, plan.from.z, { range: 2, retries: 1, deadline: walkUntil })
  const offStart = () => Math.round(Math.hypot(bot.entity.position.x - plan.from.x, bot.entity.position.z - plan.from.z))

  // Phase two: the hole. Pathfinder never goes down a hundred blocks on its own
  let stairs = null
  let health = null
  if (plan.down >= 2 && !ctl.aborted && hurt(lr)) {
    // Going down a fresh staircase on four hearts is how the trip becomes the
    // second death and the second pile.
    health = `здоровья ${Math.round(bot.health ?? 20)} — вниз за вещами не полезу`
  } else if (plan.down >= 2 && !ctl.aborted && (trip.ok || offStart() <= 4)) {
    const left = Math.round((deadline - PICKUP_RESERVE_MS - gameClock.now()) / 1000)
    // The depth is read again at the head of the staircase: the plan was drawn
    const drop = bot.entity.position.floored().y - target.y
    if (left >= 15 && drop >= 2) {
      // Timed here rather than trusted from the estimate. SECONDS_PER_LEVEL is
      const began = gameClock.now()
      // A cave on the way down is priced the way mc_dig_down prices it and paid
      const again = slot !== null
        ? `mc_recover index=${slot}`
        : `mc_recover x=${target.x} y=${target.y} z=${target.z}`
      stairs = await digStairs(session, ctl, {
        depth: drop, direction: plan.direction, torchEvery: 8, timeoutSeconds: left,
        maxFallHp, call: reach === 6 ? again : `${again} radius=${reach}`
      })
      road.digActual = Math.round((gameClock.now() - began) / 1000)
      road.levels = drop
    }
  }

  // A staircase that stopped over a cave and priced the jump (stairs.ledge) is
  const ledged = !!(stairs && stairs.ledge)

  // A staircase lands short often enough to plan for it: the ground at its head
  if (stairs && !ledged && !ctl.aborted && away(lr) > 2 && gameClock.now() < deadline - 12000) {
    // Ends ten seconds before the deadline, not five: the sweep still has to
    const leg = Math.min(deadline - 10000, gameClock.now() + 12000)
    await travelXZ(bot, ctl, target.x, target.z, { range: 2, retries: 0, deadline: leg })
  }
  Object.assign(lr, { trip, stairs, health, ledged })
}

// Подбор: обход кучи (и клеток вокруг на открытом месте), с учётом списанного прошлыми заходами.
async function lootSweep (lr: LootRun) {
  const { session, ctl, bot, target, deadline, reach, plan, trip, stairs, ledged } = lr
  // Pathfinder calls a stop short of the goal a failure; for picking things up
  const arrived = !ledged && (away(lr) <= reach || (trip.ok && plan.down < 2))

  // The weapon the preflight put in hand at the door is not in hand here: the
  const rearm = () => (require('.././preflight') as typeof import('.././preflight')).rearm(session, ctl).catch(() => null)
  await rearm()

  // One ledger for every sweep of this call: a stack written off at the pile is
  const tried = new Set()
  // And what earlier calls wrote off, still lying in the same cell inside its
  // two minutes: skipped here, named in the report — see WRITTEN_OFF_MS.
  const ledger = ledgerOf(bot)
  const carried = []
  for (const [id, rec] of ledger) {
    const e = bot.entities[id]
    const stale = !e || !isDrop(e) || e.isValid === false ||
      spot(e.position.floored()) !== rec.cell || gameClock.now() - rec.t > WRITTEN_OFF_MS
    if (stale) { ledger.delete(id); continue }
    tried.add(id)
    carried.push({ ent: e, rec })
  }
  const sweptFrom = bot.entity.position.clone()
  const sweep = { walked: 0, taken: 0, left: [], reached: [], ended: 'обошёл всё', unvisited: 0 }
  const gather = async () => {
    const s: any = await sweepDrops(bot, ctl, { radius: reach, until: deadline - 1500, tried })
    sweep.walked += s.walked
    sweep.taken += s.taken
    sweep.left.push(...s.left)
    sweep.reached.push(...s.reached)
    sweep.ended = s.ended
    sweep.unvisited = s.unvisited || 0
  }
  if (!ledged) await gather()
  // The graveyard is usually still guarded, and whatever killed us once can do
  // it again. Report it, do not swing at it.
  let guard = nearestHostile(bot, 8)

  // The sweep hops are a surface move: on open ground the stacks are spread
  if (arrived && !stairs) {
    for (const [dx, dz] of AROUND) {
      if (ctl.aborted || gameClock.now() >= deadline - 12000) break
      if (hurt(lr)) { lr.health = `здоровья ${Math.round(bot.health ?? 20)} — дальше по куче не хожу`; break }
      // travelXZ hands a single leg the whole remaining budget, and pathfinder
      const leg = Math.min(deadline - 6000, gameClock.now() + 8000)
      await travelXZ(bot, ctl, target.x + dx, target.z + dz, { range: 1, retries: 0, deadline: leg })
      await gather()
      guard = guard || nearestHostile(bot, 8)
    }
  }
  // Every walk of the sweep is pathfinder with a pickaxe — the hops above, and
  await rearm()
  Object.assign(lr, { arrived, ledger, carried, sweptFrom, sweep, guard })
}

// Что взял и что осталось лежать — по миру, а не по счёту обхода.
function lootTally (lr: LootRun) {
  const { session, bot, slot, before, reach, arrived, carried, sweptFrom, sweep } = lr
  const picked = sweep.walked
  // Written off at one point of the sweep and walked over at another is taken,
  // not left: only what is still in the world goes into the report.
  const lost = sweep.left.filter(l => l.ent.isValid !== false)
  const left = lost.map(({ ent, ...record }: any) => record)
  // Skipped on an earlier call's word, and still there — inside this sweep's
  // radius only, so a write-off from another pile does not leak into this one.
  const skipped = carried.filter(c => c.ent.isValid !== false && c.ent.position.distanceTo(sweptFrom) <= reach)
  const unvisited = sweep.ended === 'срок' ? sweep.unvisited : 0
  // «Больше ничего не лежит» is a claim about the world, so it is read off the
  const known = new Set([...lost, ...skipped].map(l => l.ent.id))
  const reached = new Set(sweep.reached)
  const lyingNow = arrived && !unvisited
    ? (Object.values(bot.entities) as any[])
      .filter((e : any) => isDrop(e) && e.isValid !== false && !known.has(e.id) && e.position.distanceTo(bot.entity.position) <= reach)
      .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    : []
  const strays: any = lyingNow.filter((e : any) => !reached.has(e.id))
  const didNotFit = lyingNow.length - strays.length
  // The one ending of the pickup that is a stop, so it goes into `stopped` as
  // well — word for word inside the note, which format.js then prints once.
  const cut = arrived && unvisited
    ? `подбор оборвал срок: ещё ${unvisited} ${stackWord(unvisited)} в ${reach} бл. не обошёл`
    : null
  const gained = diffItems(before, countItems(bot))
  const got = Object.keys(gained).length > 0
  if (got && slot !== null) {
    session.journal.patch(s => {
      const d = s.deaths[slot]
      if (d) d.recovered = true
    })
  }
  return { picked, lost, left, skipped, unvisited, lyingNow, strays, didNotFit, cut, gained, got }
}

// Записка: почему кончилось, что осталось и как добрать.
function lootNote (lr: LootRun, { picked, left, skipped, unvisited, lyingNow, strays, didNotFit, cut, got }) {
  const { bot, target, ageMinutes, ticked, budgetSeconds, reach, road, trip, stairs, health, ledged, arrived, sweep, guard } = lr
  // Stopped on a lip, the staircase's refusal is the reason — «время вышло»
  const ledgeStop = ledged ? stairs.stopped || 'лесенка встала над пещерой' : null
  const parts = []
  if (!arrived) {
    parts.push(`не дошёл (${ledged ? 'лесенка встала над пещерой' : trip.error || 'время вышло'}), до места ещё ${away(lr)} блоков`)
  }
  if (stairs) parts.push(`спустился лесенкой на ${stairs.steps}${stairs.stopped ? ` (${stairs.stopped})` : ''}`)
  if (health) parts.push(health)
  if (ageMinutes !== null && ageMinutes >= DESPAWN_MINUTES && !(ticked !== null && ticked < DESPAWN_MINUTES * 60)) {
    parts.push(`умер ${ageMinutes} мин назад, а вещи лежат ${DESPAWN_MINUTES} — куча могла пропасть`)
  }
  if (road.digActual && road.digSeconds && road.digActual > road.digSeconds * 1.3) {
    parts.push(`лестница на ${road.levels} уровней шла ${road.digActual}с при оценке ${road.digSeconds}с — на такую глубину закладывай ~${Math.ceil(road.digActual / road.levels)}с на уровень`)
  }
  if (guard) parts.push(`рядом ${guard.name} — не трогаю, решай сам`)
  // Why the pickup ended, always, because «ended» was exactly what the run that
  if (cut) {
    // The repeat's road is costed from where the body stands NOW, with the same
    const feet = bot.entity.position.floored()
    const back = descentPlan(feet, target)
    const backWalk = Math.round(Math.hypot(feet.x - back.from.x, feet.z - back.from.z) / BLOCKS_PER_SECOND)
    const backDig = back.down >= 2 ? back.down * SECONDS_PER_LEVEL : 0
    const need = backWalk + (backDig ? Math.max(backDig, 15) : 0) +
      Math.max(PICKUP_RESERVE_MS / 1000, Math.ceil(unvisited * SWEEP_HOP_MS / 1000) + 5)
    const again = Math.min(280, Math.max(budgetSeconds, need))
    parts.push(`${cut} — позови mc_recover x=${target.x} y=${target.y} z=${target.z} radius=${reach} timeoutSeconds=${again} ещё раз: ` +
      `к списанным стакам второй раз не пойду, дорога отсюда ~${backWalk + backDig} с` +
      (backDig ? ` (я выше кучи на ${back.down} — снова лесенкой вниз)` : ''))
  }
  if (arrived && left.length) {
    // Each with its own call: which of them is worth a walk is the brain's
    const shown = left.slice(0, 3)
      .map(l => `${l.what} — mc_goto ${l.at.x} ${l.at.y} ${l.at.z} (${leftWhy(l.why)})`).join('; ')
    parts.push(`не достал ${left.length} ${stackWord(left.length)}: ${shown}` +
      (left.length > 3 ? `; и ещё ${left.length - 3} — их клетки в sweep.left` : '') +
      ' — стак подбирается сам, когда встаю на его клетку')
  }
  if (arrived && skipped.length) {
    const wait = Math.max(...skipped.map(c => Math.ceil((WRITTEN_OFF_MS - (gameClock.now() - c.rec.t)) / 1000)))
    const shown = skipped.slice(0, 3).map(c => {
      const p = xyz(c.ent.position)
      return `${c.rec.what} — mc_goto ${p.x} ${p.y} ${p.z} (${leftWhy(c.rec.why)})`
    }).join('; ')
    parts.push(`ещё ${skipped.length} ${stackWord(skipped.length)} списал прошлый заход, и mc_recover к ним второй раз не ходит ` +
      `(ещё до ${wait} с) — туда только mc_goto: ${shown}` +
      (skipped.length > 3 ? `; и ещё ${skipped.length - 3} — их клетки в sweep.left` : ''))
  }
  if (strays.length) {
    const s = xyz(strays[0].position)
    parts.push(`в ${reach} бл. от меня ${strays.length === 1 ? 'лежит' : 'лежат'} ещё ${strays.length} ${stackWord(strays.length)} не из той кучи, ` +
      `что я обходил (осыпь от копания или лежали за краем радиуса) — за ${strays.length === 1 ? 'ним' : 'ними'} не гонялся: ближний ${stackLabel(strays[0])} — mc_goto ${s.x} ${s.y} ${s.z}`)
  }
  // Walking over stacks and gaining nothing means the backpack is full, not
  const nothingLies = !unvisited && !left.length && !skipped.length && !lyingNow.length
  if (arrived && !got && picked) parts.push(`прошёл по ${picked} кучам и ничего не влезло — инвентарь полон`)
  else if (arrived && got && didNotFit) {
    parts.push(`ещё ${didNotFit} ${stackWord(didNotFit)} я прошёл, а ${didNotFit === 1 ? 'он остался лежать — не влез' : 'они остались лежать — не влезли'}, ` +
      'инвентарь полон: освободи место (mc_drop или mc_stash) и зови снова')
  } else if (arrived && !got && nothingLies) parts.push('на месте пусто')
  else if (arrived && got && nothingLies && sweep.ended === 'обошёл всё') {
    parts.push(`в ${reach} бл. от меня больше ничего не лежит — подбор кончен`)
  }
  const note = parts.length ? parts.join('; ') : 'забрал всё, что лежало'
  return { note, ledgeStop }
}

// Списанное этим заходом — в журнал стаков, запись похода и ответ.
function lootResult (lr: LootRun, { picked, lost, left, skipped, unvisited, strays, cut, gained, got }, note, ledgeStop) {
  const { session, bot, target, slot, ageMinutes, road, trip, stairs, health, arrived, ledger, sweep, guard } = lr
  // Written off by this call, stamped at its end. Skipped stacks keep their old
  // stamp: a call that did not try a stack does not buy it more time off.
  for (const l of lost) {
    ledger.set(l.ent.id, { cell: spot(l.ent.position.floored()), what: l.what, why: l.why, t: gameClock.now() })
  }

  const spoils = (Object.entries(gained) as [string, any][]).map(([k, v]) => `${k}×${v}`).join(', ')
  session.journal.append('лут',
    `ходил за вещами на ${target.x},${target.y},${target.z}: ${got ? spoils : 'ничего'} (${note})`,
    bot.entity.position)

  return {
    at: xyz(bot.entity.position),
    target,
    death: slot === null ? undefined : slot,
    ageMinutes,
    picked,
    gained,
    arrived,
    went: true,
    road,
    // drops and ledge are the staircase's own: what a cave on the way cost, and
    // the price and the retry when it stopped at one.
    descended: stairs
      ? { steps: stairs.steps, direction: stairs.direction, drops: stairs.drops, ledge: stairs.ledge, stopped: stairs.stopped }
      : undefined,
    guard: guard ? { who: guard.name, dist: Math.round(guard.position.distanceTo(bot.entity.position)) } : undefined,
    // How the pickup ended, in fields: «обошёл всё» — every stack in the radius
    sweep: arrived
      ? {
          ended: sweep.ended,
          walked: sweep.walked,
          taken: sweep.taken,
          left: left.length || skipped.length
            ? [...left, ...skipped.map(c => ({ what: c.rec.what, at: xyz(c.ent.position), why: 'списан раньше', was: c.rec.why }))]
            : undefined,
          unvisited: unvisited || undefined,
          stray: strays.length ? strays.map((e : any) => ({ what: stackLabel(e), at: xyz(e.position) })) : undefined
        }
      : undefined,
    note,
    stopped: health || (arrived ? (cut || undefined) : (ledgeStop || trip.error || 'время вышло'))
  }
}

const TOUCHING = [new Vec3(0, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), ...SIDES]

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

function hazardNear (bot, pos) {
  for (const d of TOUCHING) {
    const b = bot.blockAt(pos.plus(d))
    if (!b) continue
    if (/lava|water|bubble_column/.test(b.name)) return b
  }
  return null
}

const hazardLine = b => `${/lava/.test(b.name) ? 'лава' : 'вода'} у ${spot(b.position)} — туда не копаю`

function wet (bot, pos) {
  const b = hazardNear(bot, pos)
  return b ? hazardLine(b) : null
}

const FALLS = new Set([
  'gravel', 'suspicious_gravel', 'sand', 'red_sand', 'suspicious_sand',
  'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'pointed_dripstone',
  'white_concrete_powder', 'orange_concrete_powder', 'magenta_concrete_powder',
  'light_blue_concrete_powder', 'yellow_concrete_powder', 'lime_concrete_powder',
  'pink_concrete_powder', 'gray_concrete_powder', 'light_gray_concrete_powder',
  'cyan_concrete_powder', 'purple_concrete_powder', 'blue_concrete_powder',
  'brown_concrete_powder', 'green_concrete_powder', 'red_concrete_powder',
  'black_concrete_powder'
])

const LOOSE_REACH = 12

const LOOSE_LIMIT = 3

function looseOver (bot, pos) {
  const here = bot.blockAt(pos)
  if (!here) return null
  const from = here.boundingBox === 'block' && FALLS.has(here.name) ? 0 : 1
  let n = 0
  let name = null
  for (let h = from; h < LOOSE_REACH; h++) {
    const b = bot.blockAt(pos.offset(0, h, 0))
    if (!b || b.boundingBox !== 'block' || !FALLS.has(b.name)) break
    if (!name) name = b.name
    n++
  }
  return n >= LOOSE_LIMIT ? { name, height: n, cell: pos } : null
}

const looseLine = l => `колонка ${l.name} в ${l.height} бл. над ${spot(l.cell)} — сыплется в забой быстрее, чем я копаю`

function worldTop (bot) {
  const g = bot.game || {}
  const top = g.minY + g.height
  return Number.isFinite(top) ? top : 320 // overworld, if the server sent no dimension data
}

function openSky (bot, feet, top) {
  for (let y = feet.y + 2; y < top; y++) {
    const b = bot.blockAt(new Vec3(feet.x, y, feet.z))
    // A cell we cannot read is not a cell we may call daylight: one section
    if (!b) return false
    // A canopy is not a ceiling. Leaves are a full block to the physics engine,
    if (/_leaves$/.test(b.name)) continue
    if (b.boundingBox === 'block') return false
    if (/water|lava/.test(b.name)) return false // a ceiling of ocean is not sky either
  }
  return true
}

const PIT_REACH = 5

const STEP_UP = 1

const STEPS = [0, STEP_UP, -1, -2, -3]

function walkAway (bot, feet, dir, reach = PIT_REACH) {
  let y = feet.y
  for (let d = 1; d <= reach; d++) {
    let stepped = false
    for (const dy of STEPS) {
      // A step up needs headroom over the square being LEFT, not only over the
      if (dy > 0) {
        const over = bot.blockAt(new Vec3(feet.x + dir.x * (d - 1), y + 2, feet.z + dir.z * (d - 1)))
        if (!over || over.boundingBox !== 'empty') continue
      }
      const at = new Vec3(feet.x + dir.x * d, y + dy, feet.z + dir.z * d)
      const foot = bot.blockAt(at)
      const head = bot.blockAt(at.offset(0, 1, 0))
      const floor = bot.blockAt(at.offset(0, -1, 0))
      // An unread cell is not a way out, for the same reason it is not daylight.
      if (!foot || !head || !floor) break
      if (foot.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue
      // Lava has no collision box, so without this a route through it reads as
      // a perfectly good corridor.
      if (/lava/.test(foot.name) || /lava/.test(head.name)) continue
      if (floor.boundingBox !== 'block') continue
      y += dy
      stepped = true
      break
    }
    if (!stepped) return { dist: d - 1, rise: y - feet.y, at: end(feet, dir, d - 1, y) }
  }
  return { dist: reach, rise: y - feet.y, at: end(feet, dir, reach, y) }
}

const end = (feet, dir, d, y) => new Vec3(feet.x + dir.x * d, y, feet.z + dir.z * d)

function pitCheck (bot, feet = bot.entity.position.floored(), top = worldTop(bot)) {
  const sky = openSky(bot, feet, top)
  let free = false
  let out = false
  let best = { dist: 0, rise: 0 }
  for (const dir of SIDES) {
    const r = walkAway(bot, feet, dir)
    if (r.dist > best.dist) best = r
    if (r.dist < PIT_REACH) continue
    if (r.rise <= STEP_UP) free = true
    if (out || Math.abs(r.rise) > STEP_UP) continue
    if (openSky(bot, r.at, top)) out = true
  }
  return { out, sky, free, reach: best.dist, rise: best.rise }
}

const SECONDS_PER_CLIMB_LEVEL = 5

function levelWord (n) {
  const t = n % 10
  const h = n % 100
  if (t === 1 && h !== 11) return 'уровень'
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return 'уровня'
  return 'уровней'
}

function legLevels (deadline, wantY, y) {
  const byClock = Math.max(1, Math.floor(Math.max(0, deadline - gameClock.now()) / 1000 / SECONDS_PER_CLIMB_LEVEL))
  // No targetY means the depth is unknown, and guessing it high here would
  // stop a three-block climb to craft a pickaxe it does not need.
  if (wantY === null) return 1
  return Math.min(Math.max(0, wantY - y), byClock)
}

const MOB_WATCH = 12

function seenBy (bot, radius = 6, skip = null) {
  const me = bot.entity.position
  let near = null
  let seen = 0
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || !e.name || !e.position || !HOSTILES.has(e.name)) continue
    const dist = e.position.distanceTo(me)
    if (dist >= radius) continue
    if (skip && skip(e)) continue
    // Aim at the body, not the feet: a mob standing in a block would otherwise
    // be hidden by the floor it is standing on.
    if (!canSeePoint(bot, e.position.offset(0, (e.height || 1.8) * 0.85, 0))) continue
    seen++
    if (!near || dist < near.dist) near = { who: e, dist }
  }
  if (near) near.seen = seen
  return near
}

function threatEye (e) {
  return e && e.position ? e.position.offset(0, (e.height || 1.8) * 0.85, 0) : null
}

const NEAR_SLACK = 2.5

function shutOut (bot, wall, e) {
  if (!e || !e.position || !e.isValid) return true
  const eye = threatEye(e)
  if (eye && !canSeePoint(bot, eye)) return true
  if (!eye || e.position.distanceTo(bot.entity.position) > NEAR_SLACK) return false
  for (let h = 0; h < wall.height; h++) {
    const b = bot.blockAt(wall.cell.offset(0, h, 0))
    if (!b || b.boundingBox !== 'block') return false
  }
  return behindWall(bot, wall, e)
}

function behindWall (bot, wall, e) {
  const me = bot.entity.position
  const inRow = wall.step.dx
    ? Math.floor(e.position.z) === wall.cell.z
    : Math.floor(e.position.x) === wall.cell.x
  return inRow && (e.position.x - me.x) * wall.step.dx + (e.position.z - me.z) * wall.step.dz > 0
}

const WALL_LIMIT = 4

const WALL_BLOCKS = 10

const CONTACT = 2.5

const WALL_BUDGET_MS = 2500

async function putBlock (bot, at, leftMs) {
  // A third of what is left, because build.placeBlockAt spends this leash on
  const leash = Math.max(300, Math.min(1200, Math.floor(leftMs / 3)))
  const r = await placeBlockAt(bot, at, { timeoutMs: leash })
  if (r.ok) return { ok: true }
  await sleep(200) // the packet may still be in the air when the leash expires
  const now = bot.blockAt(at)
  if (now && now.boundingBox === 'block') return { ok: true, late: true }
  return { ok: false, why: r.reason }
}

async function buildColumn (bot, cell, height, deadline) {
  const why = []
  let placed = 0
  let late = 0
  let refused = 0
  // Counted, because «nothing placed» has two readings that want different
  // sentences: the cells refused a block, or they were rock to begin with.
  let already = 0
  // Where the blocks went, because a wall that failed still stands in the world:
  // the verdict has to say so, and the brain walks back past those cells.
  const cells = []
  for (let h = 0; h < height; h++) {
    const at = cell.offset(0, h, 0)
    const was = bot.blockAt(at)
    if (was && was.boundingBox === 'block') { already++; continue } // already rock, nothing owed
    // Every refused placement into a living body costs a full timeout on each
    // of six faces. Skip the square it is standing in and say so.
    const squatter = occupiedByEntity(bot, at)
    if (squatter) { why.push(`в клетке ${squatter}`); continue }
    const left = deadline - gameClock.now()
    if (left <= 0) { why.push('время на стену вышло'); break }
    const r = await putBlock(bot, at, left)
    if (r.ok) { placed++; cells.push(at); if (r.late) late++ } else {
      refused++
      if (!why.includes(r.why)) why.push(r.why)
    }
  }
  return { placed, late, refused, already, why, cells }
}

function wallRecord (bot, wall, mob, built, began) {
  // Which cells actually ended up solid, so that «стена стоит» later means the
  wall.solid = []
  let put = null
  for (let h = 0; h < wall.height; h++) {
    const b = bot.blockAt(wall.cell.offset(0, h, 0))
    if (b && b.boundingBox === 'block') { wall.solid.push(h); if (!put) put = b }
  }
  wall.block = put ? put.name : undefined
  wall.blocks = built.placed
  // Said out loud because it is the number that decides whether the leash is
  // too short or the server is saying no, and only a run can tell us.
  if (built.late) wall.late = built.late
  wall.seconds = Math.round((gameClock.now() - began) / 100) / 10
  wall.from = Math.round(mob.dist)
  return { ok: true, wall }
}

async function sealDrift (session, ctl, mob, shape, deadline) {
  const bot = session.bot
  const cell = bot.entity.position.floored().offset(shape.step.dx, 0, shape.step.dz)
  const began = gameClock.now()
  const built = await buildColumn(bot, cell, shape.headroom, deadline)
  const wall = { cell, height: shape.headroom, step: shape.step, who: mob.who.name, id: mob.who.id, kind: 'штрек' }
  // Solid is not the same as safe — mining.sealOff learned this the same way:
  if (!shutOut(bot, wall, mob.who)) {
    return { ok: false, built, why: `стена в штреке не закрыла его (${built.placed} бл. из ${shape.headroom})${built.why.length ? ': ' + built.why.join('; ') : ', он не по оси'}` }
  }
  return wallRecord(bot, wall, mob, built, began)
}

async function screenOff (session, ctl, mob, deadline) {
  const bot = session.bot
  if (!pickFiller(bot)) {
    return { ok: false, why: 'закрыться нечем: нужно 2 блока на заслон (булыжник, дипслейт, доски — любой сплошной), а в сумке ни одного' }
  }
  const feet = bot.entity.position.floored()
  const me = bot.entity.position
  const dx = mob.who.position.x - me.x
  const dz = mob.who.position.z - me.z
  // The one of four bearings it mostly lies in — combat.dominantStep, which is
  // three lines and not exported.
  const step = Math.abs(dx) >= Math.abs(dz)
    ? { dx: dx >= 0 ? 1 : -1, dz: 0 }
    : { dx: 0, dz: dz >= 0 ? 1 : -1 }

  const began = gameClock.now()
  const total = { placed: 0, late: 0, refused: 0, already: 0, why: [], cells: [] }
  let last = null
  for (const d of [1, 2]) {
    if (ctl && ctl.aborted) break
    if (gameClock.now() >= deadline) { total.why.push('время на стену вышло'); break }
    const cell = feet.offset(step.dx * d, 0, step.dz * d)
    // The id rides along so the climb can tell, later in the same call, that
    // the thing now at contact is the one this screen was built against.
    const wall = { cell, height: 2, step, who: mob.who.name, id: mob.who.id, kind: d === 1 ? 'заслон' : 'заслон через клетку' }
    const built = await buildColumn(bot, cell, 2, deadline)
    total.placed += built.placed
    total.late += built.late
    total.refused += built.refused
    total.already += built.already
    total.cells.push(...built.cells)
    for (const w of built.why) if (!total.why.includes(w)) total.why.push(w)
    last = wall
    // Both cells of the near column go down before this is asked, because the
    if (shutOut(bot, wall, mob.who)) return wallRecord(bot, wall, mob, total, began)
  }
  return { ok: false, built: total, cell: last && last.cell, why: `заслон не закрыл его (${total.placed} бл.)${total.why.length ? ': ' + total.why.join('; ') : ''}` }
}

export {
  recoverLoot, TOUCHING, flat, hazardNear, hazardLine, wet, FALLS, LOOSE_REACH, LOOSE_LIMIT, looseOver, looseLine,
  worldTop, openSky, PIT_REACH, STEP_UP, STEPS, walkAway, end, pitCheck, SECONDS_PER_CLIMB_LEVEL, levelWord,
  legLevels, MOB_WATCH, seenBy, threatEye, NEAR_SLACK, shutOut, behindWall, WALL_LIMIT, WALL_BLOCKS, CONTACT,
  WALL_BUDGET_MS, putBlock, buildColumn, wallRecord, sealDrift, screenOff
}

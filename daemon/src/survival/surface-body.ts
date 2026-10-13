const { SIDES, gameClock, itemNamed, countItems, diffItems, equipBestTool, missingHarvestTool, toolBudget, toolShortfall, SWINGS_PER_LEVEL, spot, placeBlockAt, digUp, pickFiller, withTimeout, occupiedByEntity, sleep, xyz, travelXZ, inWater, findNearestLand, findSwimRoute, escapeWater, nearestHostile, HOSTILES, corridorShape, openSides, liveAttacker, RANGED, Vec3 } = require('./enter-shelter')
const { flat, looseOver, wet, looseLine, worldTop, pitCheck, openSky, seenBy, MOB_WATCH, shutOut, WALL_LIMIT, WALL_BLOCKS, behindWall, legLevels, FALLS, levelWord, hazardNear, hazardLine } = require('./recover-loot')
const { stepUpInto, dangerousNow, wallOff, whereToFight, WET_LIMIT, waterStop, outOfWater, ASIDE_LIMIT, eyeWet, waterNext, AGAIN_WONT_HELP } = require('./out-of-water')
let handClimb = false

function handBreaks (bot, b) {
  if (!handClimb || !b) return false
  try {
    const t = b.digTime(null, false, false, false, [], bot.entity.effects)
    return Number.isFinite(t) && t <= 16000
  } catch { return false }
}

async function breakAt (bot, mcData, ctl, pos, deadline) {
  let dug = 0
  let last = null
  for (let tries = 0; tries < 6; tries++) {
    if (ctl.aborted) return { dug, reason: 'прервано' }
    if (gameClock.now() >= deadline) return { dug, reason: 'время вышло в забое' }

    const b = bot.blockAt(pos)
    if (!b) return { dug, reason: `мир на ${spot(pos)} не прогружен` }
    if (b.boundingBox === 'empty' && !/water|lava/.test(b.name)) return { dug }
    if (/lava/.test(b.name)) return { dug, reason: `лава на ${spot(pos)}` }
    if (/water|bubble_column/.test(b.name)) return { dug, reason: `вода на ${spot(pos)}` }
    if (b.name === 'bedrock') return { dug, reason: `бедрок на ${spot(pos)}` }
    const noTool = missingHarvestTool(bot, b, mcData)
    if (noTool && !handBreaks(bot, b)) return { dug, reason: noTool }

    try {
      await equipBestTool(bot, b)
      // A dig whose block update never arrives would eat the whole intent.
      await withTimeout(bot.dig(b), 20000, `${b.name} не ломается`)
      dug++
    } catch (e) {
      last = e
      // We stopped waiting, mineflayer did not: it keeps a swing interval
      // running and targetDigBlock set until the block update finally lands.
      try { bot.stopDigging() } catch {}
    }
    await sleep(120) // let a falling column settle before re-reading it
  }
  // The sixth swing lands after the last re-read, so the loop can fall out of
  const left = bot.blockAt(pos)
  if (left && left.boundingBox === 'empty' && !/water|lava/.test(left.name)) return { dug }
  return { dug, reason: `${left ? left.name : 'блок'} на ${spot(pos)} не поддаётся${last ? ': ' + last.message : ''}` }
}

async function stairStep (bot, mcData, ctl, feet, dir, deadline, guard = null) {
  const ahead = feet.plus(dir)
  const stand = ahead.offset(0, 1, 0)
  // Three blocks, not two. The body is 1.8 tall and a jump lifts it 1.25, so
  const cells = [feet.offset(0, 2, 0), ahead.offset(0, 2, 0), stand]

  // The whole route is read before the first swing, so a direction that cannot
  // work costs no time and leaves no half-dug hole behind.
  for (const pos of cells) {
    const b = bot.blockAt(pos)
    if (!b) return { dug: 0, reason: `мир на ${spot(pos)} не прогружен` }
    if (b.name === 'bedrock') return { dug: 0, reason: `бедрок на ${spot(pos)}` }
    const risk = wet(bot, pos)
    if (risk) return { dug: 0, reason: risk }
    // Asked here and not after six failed swings, because of which cell this
    const loose = looseOver(bot, pos)
    if (loose) return { dug: 0, reason: looseLine(loose) }
    if (b.boundingBox !== 'empty') {
      const noTool = missingHarvestTool(bot, b, mcData)
      if (noTool && !handBreaks(bot, b)) return { dug: 0, reason: noTool }
    }
  }
  const under = bot.blockAt(ahead)
  if (!under) return { dug: 0, reason: `мир на ${spot(ahead)} не прогружен` }
  if (under.boundingBox !== 'block' && !pickFiller(bot)) {
    return { dug: 0, reason: 'ступеньку не на что положить, и строить нечем' }
  }

  let dug = 0
  for (const pos of cells) {
    // Before the swing, not after: a swing takes seconds and the answer to a
    // mob arriving is a block, which takes a tenth of one.
    const seen = guard && guard()
    if (seen) return { dug, mob: seen, reason: `${seen.who.name} подошёл на ${Math.round(seen.dist)} — бросаю ступеньку` }
    const cut = await breakAt(bot, mcData, ctl, pos, deadline)
    dug += cut.dug
    if (cut.reason) return { dug, reason: cut.reason }
  }

  // The step has to hold weight: a hole under the foot is a fall back down a
  // shaft we have already paid for once.
  let floor = bot.blockAt(ahead)
  // A wall torch from lighting this corridor on the way down has no collision
  if (floor && floor.boundingBox === 'empty' && !/water|lava|bubble_column|air$/.test(floor.name)) {
    try {
      await equipBestTool(bot, floor)
      await withTimeout(bot.dig(floor), 5000)
      await sleep(150)
    } catch {
      try { bot.stopDigging() } catch {}
    }
    floor = bot.blockAt(ahead)
  }
  if (!floor || floor.boundingBox !== 'block') {
    const laid = await placeBlockAt(bot, ahead, { timeoutMs: 4000 })
    if (!laid.ok) return { dug, reason: `ступеньку не положить: ${laid.reason}` }
  }

  // The first jump often clips the corner of the block we just broke; a second
  for (let tries = 0; tries < 2; tries++) {
    if (ctl.aborted) return { dug, reason: 'прервано' }
    if (gameClock.now() >= deadline) return { dug, reason: 'время вышло на ступеньке' }
    if (await stepUpInto(bot, ctl, stand)) return { ok: true, dug }
  }
  return { dug, reason: `не смог шагнуть на ${spot(stand)}` }
}

async function sideStep (bot, mcData, ctl, deadline, away) {
  const feet = bot.entity.position.floored()
  let dug = 0
  // Furthest from the hazard first; a bearing that walks into it is not an
  // escape, and one that walks back is how a bot paces between two squares.
  const order = SIDES.slice().sort((a, b) => flat(feet.plus(b), away) - flat(feet.plus(a), away))
  for (const d of order) {
    if (ctl.aborted || gameClock.now() >= deadline) break
    const to = feet.plus(d)
    if (flat(to, away) <= flat(feet, away)) continue
    // The height has to survive the move: this is a detour, not a descent, and
    const floor = bot.blockAt(to.offset(0, -1, 0))
    if (!floor || floor.boundingBox !== 'block') continue

    // The square we step into has to be one the climb can actually use, and
    if (looseOver(bot, to.offset(0, 2, 0))) continue
    const cells = [to, to.offset(0, 1, 0)]
    let refused = false
    for (const pos of cells) {
      const b = bot.blockAt(pos)
      if (!b || b.name === 'bedrock' || wet(bot, pos)) { refused = true; break }
      if (looseOver(bot, pos)) { refused = true; break }
      if (b.boundingBox !== 'empty' && missingHarvestTool(bot, b, mcData) && !handBreaks(bot, b)) { refused = true; break }
    }
    if (refused) continue

    for (const pos of cells) {
      const cut = await breakAt(bot, mcData, ctl, pos, deadline)
      dug += cut.dug
      if (cut.reason) { refused = true; break }
    }
    if (refused) continue
    // stepUpInto with a target at our own height is a plain walk — the jump it
    // holds is stopped by the ceiling we deliberately did not cut.
    if (await stepUpInto(bot, ctl, to)) return { ok: true, dug }
  }
  return { ok: false, dug }
}

async function surface (session, ctl, p: any = {}) {
  handClimb = !!p.hand
  try { return await surfaceBody(session, ctl, p) } finally { handClimb = false }
}

async function surfaceBody (session, ctl, { targetY = null, timeoutSeconds = 240, preferPillar = false }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const top = worldTop(bot)
  // The same trap clampDepth guards against: the brain fills optional JSON
  const wantY = targetY === null || targetY === undefined ? null : Math.round(Number(targetY))
  if (wantY !== null && !Number.isFinite(wantY)) throw new Error(`это не высота: ${targetY}`)
  const budgetSeconds = Math.max(10, Math.min(600, Math.round(Number(timeoutSeconds)) || 240))
  const deadline = gameClock.now() + budgetSeconds * 1000

  const from = xyz(bot.entity.position)
  const startY = bot.entity.position.y
  const before = countItems(bot)
  // Out of the hole ends the climb whatever targetY said. The brain passes
  const arrived = () => {
    const feet = bot.entity.position.floored()
    if (pitCheck(bot, feet, top).out) return true
    // Небо над головой и не меньше двух открытых сторон (пусто и на уровне ног,
    if (openSky(bot, feet, top)) {
      let open = 0
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = bot.blockAt(feet.offset(dx, 0, dz))
        const b = bot.blockAt(feet.offset(dx, 1, dz))
        if (a && b && a.boundingBox === 'empty' && b.boundingBox === 'empty' && !/lava/.test(a.name)) open++
      }
      if (open >= 2) return true
    }
    return wantY !== null && feet.y >= wantY
  }

  ctl.onAbort.push(() => {
    try { bot.clearControlStates() } catch {}
    try { bot.stopDigging() } catch {}
  })

  let stairs = 0
  let pillar = 0
  let aside = 0
  let dug = 0
  let stopped = null
  let dir = null
  // Walls this call built, and the bearing they stand on. Both outlive the
  const walls = []
  let noGo = null

  // Every mob this call had to answer for, and what the answer was. walls says
  const met = []

  // The cells the body stood in before each successful step, newest last. Four
  const trail = []

  // Ids of creatures this call looked at, could not wall off, and walked past
  const passed = new Set()
  const stillScenery = (e) => {
    if (!passed.has(e.id)) return false
    return !dangerousNow(session, { who: e, dist: e.position.distanceTo(bot.entity.position) })
  }

  // One question, asked from three places: the top of the level, between the
  const watch = () => seenBy(bot, MOB_WATCH,
    e => stillScenery(e) || walls.some(w => shutOut(bot, w, e)))

  // The screen that the creature which stopped this call walked round, if it
  let outflanked = null
  // The same mistake the other way round: blocks of the failed wall that went
  let standingUseless = null

  // Everything that happens when the watch answers. Lives out here because the
  const dealWith = async (mob) => {
    // Two numbers, and the second is the one that decides. combat measured the
    const seen: any = {
      who: mob.who.name,
      dist: Math.round(mob.dist),
      y: Math.floor(bot.entity.position.y),
      seen: mob.seen || 1,
      reach: openSides(bot, 2).length
    }
    met.push(seen)
    const spent = walls.reduce((n, w) => n + w.blocks, 0)
    const wall: any = walls.length >= WALL_LIMIT || spent >= WALL_BLOCKS
      ? { ok: false, why: `за этот вызов я уже поставил ${walls.length} стены (${spent} бл.), а он всё равно меня видит — дальше это просто пустой рюкзак` }
      : await wallOff(session, ctl, mob)
    // A wall that did not close the line is still blocks in the world — on the
    if (!wall.ok && wall.placed) seen.built = { blocks: wall.placed, at: wall.cells.map(xyz) }
    if (!wall.ok) {
      // The wall is gone as an option; now the question is whether this thing
      const danger = dangerousNow(session, mob)
      if (!danger) {
        seen.what = 'мимо'
        seen.why = wall.why
        passed.add(mob.who.id)
        return true
      }
      seen.danger = danger
      seen.what = 'не закрылся'
      // The reason, not just the verdict. «не закрылся» on its own cost a whole
      const round = walls.find(w => w.id === mob.who.id && /заслон/.test(w.kind) && !behindWall(bot, w, mob.who))
      if (round) outflanked = round
      if (seen.built) standingUseless = seen.built
      // «Вокруг открыто» only where it is: once the climb is on its own
      seen.why = round
        ? `обошёл мой ${round.kind} на ${spot(round.cell)}: заслон закрывает линию, а не дорогу` +
          `${seen.reach >= 2 ? `, а вокруг открыто, сторон ${seen.reach}` : ''}; ${wall.why}`
        : wall.why
      stopped = `${mob.who.name} в ${Math.round(mob.dist)} блоках и видит меня — спиной к нему на лестницу не полезу; ${seen.why}. ` +
        `Вижу таких ${seen.seen}, дотянуться разом могут ${seen.reach}. ${whereToFight(trail, seen.reach, seen.seen, mob.who.name)}`
      return false
    }
    seen.what = wall.wall.kind
    walls.push(wall.wall)
    // A staircase cuts the square ahead of it before anything else, so the
    noGo = new Vec3(wall.wall.step.dx, 0, wall.wall.step.dz)
    if (dir && dir.equals(noGo)) dir = null
    return true
  }

  // The tool refusal has to reach the note: it is not AGAIN_WONT_HELP (a craft
  let worn = null

  // What the water cost this call, for the answer: moves made, cells plugged
  let wetMoves = 0
  // Moves since the last level gained. The limit is on these: a long climb that
  // cuts into three separate leaks and shuts each one has not been refused once.
  let wetRun = 0
  const plugs = []
  let swum = 0

  // The world is 384 blocks tall. Past that this is not a climb any more, it is
  for (let level = 0; level < 400 && (!arrived() || inWater(bot)); level++) {
    if (ctl.aborted) { stopped = 'прервано'; break }
    if (gameClock.now() >= deadline) { stopped = 'время вышло'; break }

    // Ahead of health, ahead of the pickaxe and ahead of the mob — and this
    if (inWater(bot)) {
      if (wetRun >= WET_LIMIT) {
        stopped = waterStop(bot, [`вылезал из воды ${wetRun} раза подряд, не поднявшись ни на уровень, а она снова на мне`])
        break
      }
      wetMoves++
      wetRun++
      const w = await outOfWater(bot, ctl, deadline)
      plugs.push(...(w.plugged || []))
      swum += w.swam || 0
      if (w.ok) continue
      if (ctl.aborted) { stopped = 'прервано'; break }
      if (gameClock.now() >= deadline) { stopped = 'время вышло'; break }
      stopped = waterStop(bot, w.tried)
      break
    }

    const health = Math.round(bot.health ?? 20)
    // Стоять внизу на малом хп имеет смысл, только если оно вернётся: сытость
    const canHeal = (bot.food ?? 20) >= 18 || !!(session.mcData && require('.././actions').bestFood(bot, session.mcData))
    if (health < 6 && canHeal) { stopped = `здоровья ${health} — дальше не лезу`; break }

    // The climb is what the reserve exists for, so nothing is held back here:
    const feetY = bot.entity.position.floored().y
    const legWant = legLevels(deadline, wantY, feetY)
    const column = bot.entity.position.floored()
    const fastPillar = preferPillar && !noGo && pickFiller(bot, { steady: true }) &&
      !wet(bot, column.offset(0, 2, 0)) && !wet(bot, column.offset(0, 3, 0)) &&
      !looseOver(bot, column.offset(0, 2, 0)) && !looseOver(bot, column.offset(0, 3, 0)) &&
      // digUp also removes feet+3 for the jump. Even one falling block on that
      // support drops into our own head; stairs clear the future square instead.
      !FALLS.has(bot.blockAt(column.offset(0, 4, 0))?.name) &&
      [2, 3].every(h => {
        const b = bot.blockAt(column.offset(0, h, 0))
        return b && b.name !== 'bedrock' && !FALLS.has(b.name)
      })
    const swingsPerLevel = fastPillar ? 1 : SWINGS_PER_LEVEL
    const short = toolShortfall(bot, mcData, {
      need: legWant * swingsPerLevel + (fastPillar ? 1 : 0),
      reserve: 0,
      onlyIfFixable: true
    })
    if (short) {
      // «Останавливаюсь заранее» is right and it is not enough. Measured twice:
      const left = toolBudget(bot, 'pickaxe')
      const afford = Number.isFinite(left) ? Math.floor(Math.max(0, left) / swingsPerLevel) : 0
      stopped = afford > 0
        ? `${short} Но встать намертво тоже нельзя: на остатке я пройду ещё ~${afford} ${levelWord(afford)} из ${legWant} — позови mc_surface с targetY=${feetY + afford}, столько я вырублю без починки.`
        : `${short} На подъём не осталось ни одного уровня — без новой кирки я отсюда не сдвинусь вообще.`
      worn = stopped
      break
    }
    const mob = watch()
    if (mob) {
      if (!(await dealWith(mob))) break
      continue
    }
    // Быстрый выход из одноразовой шахты: один новый блок над головой вместо
    if (fastPillar) {
      const was = bot.entity.position.y
      const up = await digUp(bot, ctl, { blocks: 1, mcData, tower: true, guard: watch })
      dug += up.dug
      if (bot.entity.position.y - was >= 0.9) { pillar++; wetRun = 0; continue }
      if (ctl.aborted) { stopped = 'прервано'; break }
      if (gameClock.now() >= deadline) { stopped = 'время вышло'; break }
    }
    // Stick to the direction that worked last time: a staircase that changes
    let usable = SIDES
    if (noGo) {
      // Picked out of SIDES rather than negated, so every bearing in the list
      const away = SIDES.find(d => d.x === -noGo.x && d.z === -noGo.z)
      usable = [away, ...SIDES.filter(d => !d.equals(noGo) && d !== away)]
    }
    const order = dir && usable.some(d => d.equals(dir))
      ? [dir, ...usable.filter(d => !d.equals(dir))]
      : usable
    const why = []
    let moved = false
    let intruder = null

    for (const d of order) {
      if (ctl.aborted || gameClock.now() >= deadline) break
      // The body is read again for every direction. A step that failed held
      const step = await stairStep(bot, mcData, ctl, bot.entity.position.floored(), d, deadline, watch)
      dug += step.dug
      if (step.ok) {
        trail.push(bot.entity.position.floored().offset(-d.x, -1, -d.z))
        if (trail.length > 4) trail.shift()
        dir = d; stairs++; wetRun = 0; moved = true; break
      }
      // A step dropped because something walked into view is not a bearing that
      if (step.mob) { intruder = step.mob; break }
      why.push(step.reason)
    }
    if (intruder) {
      if (!(await dealWith(intruder))) break
      continue
    }
    if (moved) continue
    // Four directions of swinging can eat the rest of the budget on their own,
    // and the pillar below would then spend it twice over.
    if (ctl.aborted) { stopped = 'прервано'; break }
    if (gameClock.now() >= deadline) { stopped = 'время вышло'; break }

    // Nowhere to cut a step. The pillar costs a block a level and any hit
    const blocked = why.find(w => /лава|вода/.test(w)) || why.find(w => /сыплется/.test(w)) || why[0] || 'некуда'
    const feet = bot.entity.position.floored()

    // Refused up by a hazard on every bearing AND on the pillar means the block
    const hazard = /лава|вода/.test(blocked)
      ? (hazardNear(bot, feet.offset(0, 2, 0)) || hazardNear(bot, feet.offset(0, 3, 0)))
      : null
    if (hazard) {
      if (aside >= ASIDE_LIMIT) {
        stopped = `${hazardLine(hazard)}; отошёл на ${aside} и всё равно упираюсь`
        break
      }
      const off = await sideStep(bot, mcData, ctl, deadline, hazard.position)
      dug += off.dug
      if (!off.ok) { stopped = `${hazardLine(hazard)}, и в сторону не отойти`; break }
      aside++
      dir = null // the bearing that worked under the old column means nothing here
      continue
    }

    // Loose overhead is the lava case with a different material and exactly the
    const loose = looseOver(bot, feet.offset(0, 2, 0)) || looseOver(bot, feet.offset(0, 3, 0))
    if (loose) {
      if (aside >= ASIDE_LIMIT) {
        stopped = `${looseLine(loose)}; отошёл на ${aside} и всё ещё под сыпучим — уведи меня mc_goto блоков на ${ASIDE_LIMIT + 2} в сторону и зови подъём оттуда`
        break
      }
      // Away from our own square: a column directly overhead has no direction
      const off = await sideStep(bot, mcData, ctl, deadline, feet)
      dug += off.dug
      if (!off.ok) {
        stopped = `${looseLine(loose)}, и в сторону не отойти: ` +
          (pickFiller(bot)
            ? `вокруг то же сыпучее или шагнуть некуда — уведи меня mc_goto блоков на ${ASIDE_LIMIT + 2} в сторону и зови оттуда`
            : 'и блоков нет — ни отойти, ни подпереть')
        break
      }
      aside++
      dir = null // the bearing that worked under the old column means nothing here
      continue
    }

    const risk = wet(bot, feet.offset(0, 2, 0)) || wet(bot, feet.offset(0, 3, 0))
    if (risk) { stopped = risk; break }
    if (!pickFiller(bot)) { stopped = `столб строить нечем, а лестницу не вырубить: ${blocked}`; break }

    const was = bot.entity.position.y
    const up = await digUp(bot, ctl, { blocks: 1, mcData, tower: true })
    dug += up.dug
    if (bot.entity.position.y - was >= 0.9) { pillar++; wetRun = 0 }
    else { stopped = `${up.stopped || 'столб не встал'}; лестница — ${blocked}`; break }
  }

  const here = pitCheck(bot, bot.entity.position.floored(), top)
  const nowY = Math.floor(bot.entity.position.y)
  const out = arrived()
  // The full remainder, which the per-leg check above deliberately does not
  const swings = toolBudget(bot, 'pickaxe')
  const toTop = wantY === null ? null : Math.max(0, wantY - nowY)
  const estimate = preferPillar && pillar && !stairs ? 1 : SWINGS_PER_LEVEL
  const pickaxe = Number.isFinite(swings)
    ? {
        left: Math.round(swings),
        leg: Math.ceil(legLevels(gameClock.now() + budgetSeconds * 1000, wantY, nowY) * estimate + (estimate === 1 ? 1 : 0)),
        // Swings are what the tool has; levels are what the brain plans in.
        levels: Math.floor(Math.max(0, swings) / estimate),
        toTop: toTop === null ? undefined : Math.ceil(toTop * estimate)
      }
    : undefined
  if (!out && !stopped) stopped = 'подъём встал на месте'
  const climbed = Math.round(bot.entity.position.y - startY)
  const mode = stairs && pillar ? 'смешанный' : pillar ? 'столб' : 'лестница'

  let note = `поднялся на ${climbed} — позови ещё раз, полезу дальше отсюда`
  // Ahead of every other branch, «пришёл» included. Reproduced offline in a 1x1
  if (stopped && (/из воды сам не выбраться/.test(stopped) || inWater(bot))) {
    const mine = /из воды сам не выбраться/.test(stopped)
    note = `${climbed ? `поднялся на ${climbed}, дальше не полезу` : 'вверх ни на блок'}: ${stopped}. ` +
      (mine
        ? 'Звать подъём ещё раз с этого места бесполезно — сначала сделай названное'
        : `Я всё ещё в воде на ${spot(bot.entity.position.floored())}${eyeWet(bot) ? ', голова под водой' : ''}, и сама она с меня не сойдёт: ${waterNext(bot)}`)
  } else if (out && !climbed) note = here.out ? 'и так наверху, лезть не пришлось' : `и так на y=${nowY}, выше не просили`
  else if (here.out && wantY !== null && nowY < wantY) {
    // Not a failure and not worth another call: the mine is behind us and the
    // rest of the difference is open air over a field.
    note = `вылез наружу на y=${nowY}; до заказанных ${wantY} отсюда только столбом — это уже не подъём из шахты`
  } else if (out && wantY === null) note = 'вылез под открытое небо'
  else if (out) note = `поднялся до y=${nowY}`
  else if (/спиной к нему/.test(stopped || '')) {
    // Ahead of the sidestep line because a mob that turned up after the
    const fix = /нужно \d+ блока/.test(stopped)
      ? 'дай мне блоков на стену (накопай камня или достань из сундука) или убей его (mc_fight) — и зови снова'
      : outflanked
        ? `сделай, как сказано выше, и зови снова — заслон на ${spot(outflanked.cell)} стоит, но вокруг открыто и его обходят, второй такой же его не остановит`
        : standingUseless
          ? `сделай, как сказано выше, и зови снова — блоки я ставлю, ${standingUseless.blocks} встали на ${standingUseless.at.map(spot).join(', ')}, но линию к нему отсюда не режут, и второй заход поставит то же`
          : 'сделай, как сказано выше, и зови снова — сам я тут стену поставить не могу'
    note = `${climbed ? `поднялся на ${climbed}, дальше не полезу: ` : ''}${stopped}. Отсюда подъём будет отвечать то же самое — ${fix}`
  } else if (!climbed && worn) {
    // Deliberately not folded into AGAIN_WONT_HELP: a craft really does make
    note = `вверх ни на блок. ${stopped}`
  } else if (!climbed && /^здоровья \d/.test(stopped || '')) {
    // The same lie as the pickaxe refusal one branch up, and now reachable where
    note = `вверх ни на блок. ${stopped} — сначала поешь (mc_eat) и дай хп вернуться (mc_wait 60); звать подъём раньше бесполезно`
  } else if (!climbed && aside) {
    // «отсюда» is a different square than the one this call started on, so
    note = `вверх не пустило, отошёл от опасного места на ${aside} — позови ещё раз, отсюда полезу`
  } else if (!climbed && AGAIN_WONT_HELP.test(stopped || '')) {
    // The brain calls this in a loop until it gains height, so a stop that the
    // next call would hit identically has to say so out loud.
    note = here.free
      ? `не в яме — вокруг открыто, а вверх отсюда ничего не сделать (${stopped}); звать ещё раз бесполезно`
      : `не поднялся ни на блок (${stopped}); звать ещё раз с этого места бесполезно`
  }

  // What the wall is made of and where it stands, read back out of the world
  const walled = walls.map(w => {
    let standing = w.solid.length > 0
    for (const h of w.solid) {
      if (!standing) break
      const b = bot.blockAt(w.cell.offset(0, h, 0))
      standing = !!b && b.boundingBox === 'block'
    }
    return {
      who: w.who,
      // Which of the two shapes it was. A drift wall closes the corridor and
      kind: w.kind,
      at: xyz(w.cell),
      block: w.block,
      blocks: w.blocks,
      height: w.height,
      from: w.from,
      seconds: w.seconds,
      standing
    }
  })
  const past = met.filter(m => m.what === 'мимо')
  if (past.length) {
    const m = past[past.length - 1]
    note += `; мимо ${m.who} в ${m.dist} бл. полез не останавливаясь: он меня ни разу не тронул, вплотную не подошёл и с дистанции не бьёт — если это неверно, скажи, и я буду вставать и на таких`
  }
  if (walled.length) {
    const w = walled[walled.length - 1]
    const spent = walled.reduce((n, x) => n + x.blocks, 0)
    note += `; закрылся от ${w.who} (${w.kind} на ${spot(w.at)}, ${w.block || 'чем было'})` +
      (walled.length > 1 ? `, всего ${walled.length} стены на ${spent} бл.` : `, ${w.blocks} бл. за ${w.seconds} с`)
    if (!w.standing) note += '; СТЕНЫ ТАМ УЖЕ НЕТ — он снова на свободе'
    else if (outflanked && spot(outflanked.cell) === spot(w.at)) note += ' — стоит, но он его обошёл'
  }

  // Climbing past a mob on purpose and failing to notice one look identical in
  // an answer that does not mention it, and only one of them is trustworthy.
  if (climbed && !walled.length) {
    const near = nearestHostile(bot, MOB_WATCH)
    if (near && !seenBy(bot, MOB_WATCH)) note += `; рядом ${near.name}, но между нами порода — потому и полез`
  }

  // Said out loud only when the two answers differ: the leg is paid for, the
  // top is not, and the brain has to arrange more pickaxe before it gets there.
  if (pickaxe && pickaxe.toTop && pickaxe.left < pickaxe.toTop && !out) {
    note += `; кирки хватит примерно на ${pickaxe.levels} ${levelWord(pickaxe.levels)} из ${toTop}`
  }

  if (climbed) {
    session.journal.append('подъём',
      `вверх на ${climbed} (${mode}: ступеней ${stairs}, столб ${pillar}) — ${note}`,
      bot.entity.position)
  }

  return {
    from,
    at: xyz(bot.entity.position),
    climbed,
    mode,
    stairs,
    pillar,
    aside,
    dug,
    // Undefined and not an empty array on purpose: «стен не строил» is the
    // normal climb, and a field that is always there stops being read.
    walls: walled.length ? walled : undefined,
    met: met.length ? met : undefined,
    // Same rule as walls: absent on a dry climb. `plugged` are blocks now
    // standing where water ran, `dry` whether the body ended the call out of it.
    water: wetMoves
      ? { moves: wetMoves, plugged: plugs.length ? plugs : undefined, swam: swum || undefined, dry: !inWater(bot) }
      : undefined,
    pickaxe,
    // A default climb also exits through open sky and two sides; report its actual arrival proof.
    out: here.out || wantY === null && out,
    sky: here.sky,
    // «я больше не в яме» and «я на поверхности» are separate decisions: the
    pit: !here.free,
    gained: diffItems(before, countItems(bot)),
    note,
    stopped: stopped || undefined
  }
}

const REFUGE_NEUTRAL = /^(enderman|piglin|zombified_piglin)$/

const MOB_SPEED = {
  zombie: 0.23, husk: 0.23, drowned: 0.23, zombie_villager: 0.23, blaze: 0.23,
  skeleton: 0.25, stray: 0.25, bogged: 0.25, parched: 0.25, wither_skeleton: 0.25, creeper: 0.25,
  witch: 0.25, silverfish: 0.25, endermite: 0.25, magma_cube: 0.2,
  spider: 0.3, cave_spider: 0.3, hoglin: 0.3, zoglin: 0.3, ravager: 0.3,
  piglin_brute: 0.35, vindicator: 0.35, pillager: 0.35
}

function chaseBps (name) {
  const s = MOB_SPEED[name] ?? 0.3
  return 20 * 0.98 * s * s / (1 - 0.6 * 0.91)
}

const MOB_REACH = 1.45

const HOLE_DEPTH = 3

const REFUGE_FLEE_MS = 2500

const HOT_CELL = /^(lava|fire|soul_fire)$/

function holePlan (bot, mcData, feet) {
  let ms = 0
  for (let k = 1; k <= HOLE_DEPTH; k++) {
    const b = bot.blockAt(feet.offset(0, -k, 0))
    if (!b || b.boundingBox !== 'block' || b.name === 'bedrock' || /water|lava/.test(b.name) || FALLS.has(b.name)) return null
    for (const s of SIDES) {
      const side = bot.blockAt(feet.offset(s.x, -k, s.z))
      if (!side || /water|lava|bubble_column/.test(side.name)) return null
      // Клетки тела на дне (ноги и голова) — со всех сторон сплошь: нора у склона/пещеры с открытым боком — вход
      // мобам (trapJ 03.10, lowhp: «нора на 3, потолок закрыт» на склоне — зомби вошёл сбоку, 5 → 0).
      if (k >= HOLE_DEPTH - 1 && side.boundingBox !== 'block') return null
    }
    if (mcData && missingHarvestTool(bot, b, mcData)) return null
    let t = Infinity
    try { t = require('.././tools').bestFor(bot, b).ms } catch {}
    if (!Number.isFinite(t) || t > 2500) return null
    ms += t + 450 // и падение в выкопанное (sinkOne ждёт 450 мс)
  }
  const floor = bot.blockAt(feet.offset(0, -HOLE_DEPTH - 1, 0))
  if (!floor || floor.boundingBox !== 'block' || /water|lava/.test(floor.name)) return null
  return { depth: HOLE_DEPTH, ms: Math.round(ms) }
}

function pocketOf (bot, foes) {
  let air = null
  try { air = require('.././sealed').localAir(bot) } catch { return null }
  if (!air || air.size < 2 || require('.././sealed').exposure(bot, new Set(air)).length) return null
  for (const h of foes) {
    // Клетка, занятая мобом, для localAir — не воздух (liveCls), и карман «замыкался» у самого зомби: trap0 02.10,
    // лесенка в пещере — «карман без врагов» при зомби в 0.7 бл., смерть. Моб в кармане или у его края — не карман.
    if (h.d <= 3) return null
    const p = h.e.position.floored()
    for (const dy of [0, 1]) if (air.has(`${p.x},${p.y + dy},${p.z}`)) return null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1]) if (air.has(`${p.x + dx},${p.y + dy},${p.z + dz}`)) return null
    }
  }
  return air
}

const PILLAR = 4

const CLIMBERS = /^(spider|cave_spider|drowned)$/

module.exports = { handClimb, handBreaks, breakAt, stairStep, sideStep, surface, surfaceBody, REFUGE_NEUTRAL, MOB_SPEED, chaseBps, MOB_REACH, HOLE_DEPTH, REFUGE_FLEE_MS, HOT_CELL, holePlan, pocketOf, PILLAR, CLIMBERS }

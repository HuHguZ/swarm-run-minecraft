const { reachOf, nearestHostile, HOSTILES, corridorShape, openSides, liveAttacker, RANGED, spot, gameClock, placeBlockAt, digUp, pickFiller, withTimeout, occupiedByEntity, sleep, xyz, travelXZ, inWater, findNearestLand, findSwimRoute, escapeWater, SIDES } = require('./enter-shelter')
const { CONTACT, threatEye, WALL_BUDGET_MS, sealDrift, screenOff, flat } = require('./recover-loot')
function dangerousNow (session, mob) {
  const r = reachOf(session.bot, mob.who)
  if (mob.dist <= CONTACT && r.reaches && (r.steps === null || r.steps <= 1)) return 'вплотную'
  if (RANGED.has(mob.who.name) && r.sees) return 'бьёт с дистанции'
  const hitter = liveAttacker(session)
  if (hitter) return `меня только что били (${hitter.name || 'кто-то'})`
  return null
}

function whereToFight (trail, reach, seen = 1, who = null) {
  const fight = who ? `mc_fight target=${who}` : 'mc_fight'
  if (reach <= 1) {
    return `тут ко мне пролезет только один — дерись прямо здесь (${fight}), это самый дешёвый бой, какой у меня бывает`
  }
  if (seen <= 1 && who && who !== 'creeper') {
    return `он тут один: открытых сторон ${reach}, но бить меня разом может только он — это бой один на один, ` +
      `и ни проход, ни фланги его не удешевят, а уходить от него спиной хуже. Дерись прямо здесь: mc_fight target=${who}, потом зови подъём снова`
  }
  const back = trail.length >= 2 ? trail[trail.length - 2] : null
  if (back) {
    return `здесь не дерись: отойди на 2 ступеньки вниз по моей же лестнице, на ${spot(back)} — она шириной в клетку, туда пролезет только один. Сначала mc_goto ${back.x} ${back.y} ${back.z}, потом ${fight}`
  }
  return `здесь до меня дотягиваются с ${reach} сторон разом — уведи меня mc_goto в проход шириной в клетку или отгороди фланги (mc_place, по 2 блока на сторону), и только потом mc_fight`
}

async function wallOff (session, ctl, mob) {
  const bot = session.bot
  const eye = threatEye(mob.who)
  if (!eye) return { ok: false, why: 'он пропал, пока я на него смотрел' }

  // Contact. Measured in try-corridor runs 1, 5 and 6: once a walker is on the
  if (mob.dist <= CONTACT) {
    return { ok: false, why: `он вплотную (${Math.round(mob.dist)} бл.) — в занятую им клетку блок не встанет, тут сначала бой (mc_fight) или уход` }
  }

  const deadline = gameClock.now() + WALL_BUDGET_MS
  const shape = corridorShape(bot, eye)
  let first = null
  // What both shapes did with their cells, summed, because the verdict below
  // is a claim about those cells and has to be the true one of four.
  const cells = { late: 0, placed: 0, refused: 0, already: 0, excuses: 0, at: [] }
  const tally = b => {
    if (!b) return
    cells.late += b.late || 0
    cells.placed += b.placed || 0
    cells.refused += b.refused || 0
    cells.already += b.already || 0
    cells.excuses += (b.why || []).length
    cells.at.push(...(b.cells || []))
  }
  if (shape.corridor && shape.towardOpen && pickFiller(bot)) {
    const r: any = await sealDrift(session, ctl, mob, shape, deadline)
    if (r.ok) return r
    first = r.why
    tally(r.built)
  }
  const scr: any = await screenOff(session, ctl, mob, deadline)
  if (scr.ok) return scr
  tally(scr.built)
  const late = cells.late

  // The honest end of the road, and it has to name the next move rather than
  const why = first ? `${first}; и ${scr.why}` : scr.why
  // An empty backpack never got as far as a placement, so neither verdict
  // below applies to it and both would contradict what it just said.
  if (!first && !scr.built) return { ok: false, why }
  const bow = RANGED.has(mob.who.name)
  // The third verdict. Nothing placed and nothing refused, every cell counted as
  const dy = Math.floor(mob.who.position.y) - Math.floor(bot.entity.position.y)
  const above = Math.abs(dy) >= 2 ? `он на ${Math.abs(dy)} ${dy < 0 ? 'ниже' : 'выше'} меня` : null
  // The fourth verdict. Blocks went down on time and stand, and the line runs
  const columns = []
  for (const p of cells.at) if (!columns.some(c => c.x === p.x && c.z === p.z)) columns.push(p)
  columns.forEach((p, i) => { columns[i] = spot(p) })
  const tail = late
    ? `; блок(и) всё-таки встали, но уже после того, как я перестал ждать — значит сервер медлит, а не отказывает: позови ещё раз, со второго захода стена обычно встаёт`
    : !cells.placed && !cells.refused && !cells.excuses && cells.already
      ? `; ставить было некуда — клетки заслона между нами и так сплошные` +
        (above ? `, а ${above}: сбоку такое не закрывается` : '')
      : cells.placed
        ? `; ${cells.placed} бл. встали (${columns.length > 1 ? 'столбики' : 'столбик'} ${columns.join(' и ')}) и стоят, но линию не перекрыли — ` +
          `${above || 'он не прямо за ними, линия к нему идёт мимо'}: заслон в мой рост закрывает только того, кто стоит со мной на одной высоте прямо за ним. ` +
          `Второй такой же не поможет — ${bow ? 'а он стреляет, так что ' : ''}дальше бой (mc_fight target=${mob.who.name}) или уход`
        : bow
          ? `; клетки так и остались воздухом, а он стреляет всё это время — стену тут не поставить, дальше только бой (mc_fight) или увести его`
          : `; клетки так и остались воздухом — стену тут не поставить, нужен бой (mc_fight) или уход`
  return { ok: false, why: why + tail, placed: cells.placed, cells: cells.at }
}

const AGAIN_WONT_HELP = /строить нечем|нечем строить|нужен инструмент|сделать не из чего|бедрок|не поддаётся|не прогружен|не к чему прислонить|в сторону не отойти|спиной к нему/

async function stepUpInto (bot, ctl, cell) {
  const centre = cell.offset(0.5, 0, 0.5)
  const until = gameClock.now() + 3000
  try {
    await bot.lookAt(centre.offset(0, 1.6, 0), true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    while (gameClock.now() < until && !ctl.aborted) {
      if (bot.entity.position.y >= cell.y && flat(bot.entity.position, centre) < 0.35) break
      await sleep(60)
    }
  } catch {
    // A refused look is not a reason to give up the step — the body may have
    // gone up anyway, and the check below is the real answer.
  } finally {
    try { bot.clearControlStates() } catch {}
  }
  await sleep(200) // the body is still coming down onto the new step
  const p = bot.entity.position
  return Math.floor(p.y) >= cell.y && flat(p, centre) < 0.8
}

const ASIDE_LIMIT = 4

const isWater = b => !!b && (b.name === 'water' || b.name === 'bubble_column')

function waterLevel (b) {
  if (!isWater(b)) return null
  if (b.name === 'bubble_column') return 0 // a column is fed by a source at its foot
  try {
    const p = typeof b.getProperties === 'function' ? b.getProperties() : null
    if (p && Number.isFinite(Number(p.level))) return Number(p.level)
  } catch {}
  return Number.isFinite(b.metadata) ? b.metadata : null
}

function pushOf (b) {
  if (!isWater(b)) return -1
  const l = waterLevel(b)
  return l === null || l === 0 || l >= 8 ? 8 : 8 - l
}

function waterFeeders (bot, feet) {
  const out = []
  const over = bot.blockAt(feet.offset(0, 2, 0))
  if (isWater(over)) out.push(over)
  for (const c of [feet, feet.offset(0, 1, 0)]) {
    const mine = pushOf(bot.blockAt(c))
    for (const d of SIDES) {
      const n = bot.blockAt(c.plus(d))
      if (!isWater(n)) continue
      if (waterLevel(n) === 0 || pushOf(n) > mine) out.push(n)
    }
  }
  return out
}

function standingInSource (bot, feet) {
  return [feet, feet.offset(0, 1, 0)].some(c => waterLevel(bot.blockAt(c)) === 0)
}

const SWIM_REACH = 8

const SWIM_MS_PER_BLOCK = 900

function airOver (bot, feet) {
  for (let h = 1; h <= SWIM_REACH + 1; h++) {
    const b = bot.blockAt(feet.offset(0, h, 0))
    if (!b) return { unread: feet.offset(0, h, 0) }
    if (isWater(b)) continue
    if (b.boundingBox !== 'empty' || /lava/.test(b.name)) return { roof: b, water: h - 1 }
    return { air: b.position, water: h - 1 }
  }
  return { deep: SWIM_REACH }
}

const dryCell = b => !!b && b.boundingBox === 'empty' && !isWater(b) && !/lava/.test(b.name)

function dryStep (bot, feet) {
  for (const dy of [1, 0]) {
    if (dy > 0) {
      const over = bot.blockAt(feet.offset(0, 2, 0))
      if (!over || over.boundingBox !== 'empty') continue
    }
    for (const d of SIDES) {
      const to = feet.plus(d).offset(0, dy, 0)
      const floor = bot.blockAt(to.offset(0, -1, 0))
      if (dryCell(bot.blockAt(to)) && dryCell(bot.blockAt(to.offset(0, 1, 0))) && floor && floor.boundingBox === 'block') return to
    }
  }
  return null
}

const PLUG_MS = 1200

const DRAIN_MS = 2000

const WET_LIMIT = 4

const eyeWet = bot => isWater(bot.blockAt(bot.entity.position.offset(0, 1.62, 0)))

async function outOfWater (bot, ctl, deadline) {
  const feet = bot.entity.position.floored()
  const tried = []
  const plugged = []

  // An open swim costs no tool or block and must precede sealing the pool.
  // The roof directly overhead says nothing about the adjacent water column.
  const route = findSwimRoute(bot)
  if (route) {
    const swim = await escapeWater(bot, ctl, { timeoutMs: Math.min(12000, Math.max(0, deadline - gameClock.now())) })
    if (swim.ok) return { ok: true, how: 'выплыл на берег', plugged, swam: Math.max(0, Math.round(bot.entity.position.y - feet.y)), to: swim.target }
    tried.push(swim.error)
    if (ctl.aborted || gameClock.now() >= deadline) return { ok: false, plugged, tried }
  }

  // 1. Shut what is coming in. Keeps the staircase, costs a block a leak, and is
  //    the only move in a pocket with a roof over the leak.
  const inflow = standingInSource(bot, feet) ? [] : waterFeeders(bot, feet)
  if (!inflow.length) {
    tried.push(standingInSource(bot, feet)
      ? 'стою в стоячей воде — затыкать нечего, она не натекает, а стоит'
      : 'откуда течёт, не вижу: ни над головой, ни по бокам воды сильнее моей нет')
  } else if (!pickFiller(bot)) {
    tried.push(`заткнуть ${spot(inflow[0].position)} нечем — в сумке ни одного блока`)
  } else {
    for (const b of inflow) {
      if (ctl.aborted || gameClock.now() >= deadline) break
      const r = await placeBlockAt(bot, b.position, { timeoutMs: PLUG_MS })
      if (r.ok && !r.already) plugged.push(xyz(b.position))
      else if (!r.ok) tried.push(`заткнуть ${spot(b.position)} не вышло: ${r.reason}`)
    }
    if (plugged.length) {
      const until = Math.min(deadline, gameClock.now() + DRAIN_MS)
      while (gameClock.now() < until && !ctl.aborted && inWater(bot)) await sleep(100)
      if (!inWater(bot)) return { ok: true, how: 'заткнул', plugged }
      tried.push(`заткнул ${plugged.map(spot).join(', ')}, а вода за ${DRAIN_MS / 1000} с не сошла`)
    }
  }
  if (ctl.aborted || gameClock.now() >= deadline) return { ok: false, plugged, tried }

  // 2. Up, when all that is over the head is water and then air.
  let swam = 0
  if (eyeWet(bot)) {
    const col = airOver(bot, feet)
    if (col.roof) tried.push(`всплыть некуда — над ${col.water} бл. воды ${col.roof.name} на ${spot(col.roof.position)}`)
    else if (col.deep) tried.push(`до воздуха больше ${SWIM_REACH} бл. воды — на одном вдохе не всплыву`)
    else if (col.unread) tried.push(`над головой мир на ${spot(col.unread)} не прогружен — всплывать вслепую не стану`)
    else {
      const y0 = bot.entity.position.y
      const t0 = gameClock.now()
      try {
        bot.setControlState('jump', true)
        const until = Math.min(deadline, t0 + SWIM_MS_PER_BLOCK * Math.max(1, col.water) + 1500)
        while (gameClock.now() < until && !ctl.aborted && eyeWet(bot)) await sleep(80)
        swam = Math.max(0, Math.round(bot.entity.position.y - y0))
        if (eyeWet(bot)) {
          tried.push(`всплывал ${Math.round((gameClock.now() - t0) / 100) / 10} с к воздуху на ${spot(col.air)} (воды ${col.water} бл.) и не вынырнул`)
        } else {
          // Eyes out is not yet feet high enough to step: a body holding jump
          let to = null
          let top = bot.entity.position.y
          let stall = gameClock.now()
          while (!ctl.aborted && gameClock.now() < deadline && gameClock.now() - stall < 500) {
            to = dryStep(bot, bot.entity.position.floored())
            if (to) break
            await sleep(80)
            if (bot.entity.position.y > top + 0.05) { top = bot.entity.position.y; stall = gameClock.now() }
          }
          swam = Math.max(0, Math.round(bot.entity.position.y - y0))
          if (to && await stepUpInto(bot, ctl, to)) return { ok: true, how: 'всплыл и вышел', plugged, swam, to: xyz(to) }
          tried.push(to ? `всплыл на ${swam}, а шагнуть на ${spot(to)} не смог` : `всплыл на ${swam}, а выйти из воды не на что — вокруг вода или стена`)
        }
      } finally {
        try { bot.clearControlStates() } catch {}
      }
    }
  }
  if (ctl.aborted || gameClock.now() >= deadline) return { ok: false, plugged, swam, tried }

  // 3. Aside onto something dry. The water may follow into the square just left;
  //    the next move then finds that square among the feeders and shuts it.
  const here = bot.entity.position.floored()
  const to = dryStep(bot, here)
  if (to && await stepUpInto(bot, ctl, to)) return { ok: true, how: 'вышел', plugged, swam, to: xyz(to) }
  tried.push(to ? `шагнуть на сухое ${spot(to)} не смог` : 'сухой клетки рядом нет')
  return { ok: false, plugged, swam, tried }
}

function waterNext (bot, tried: any = []) {
  const land = findNearestLand(bot, 24)
  if (land) return `ближайшее сухое место ${spot(land)} — уведи меня туда mc_goto x=${land.x} y=${land.y} z=${land.z} и зови подъём оттуда`
  if (!pickFiller(bot)) return 'сухого места в 24 бл. нет — дай мне блоков (mc_chest_take, или mc_mine block=stone_like count=4), заткну воду и полезу'
  // With blocks in the bag the bag is not what is missing, and «затыкать нечего»
  return 'доступного берега не найдено — нужен другой путь: открыть видимый блок к воздуху или сделать воздушный карман; невозможность самостоятельного выхода не доказана'
}

function waterStop (bot, tried) {
  const feet = bot.entity.position.floored()
  return `в воде на ${spot(feet)}${eyeWet(bot) ? ', голова под водой' : ''}: ${tried.join('; ')} — из воды сам не выбраться; ${waterNext(bot, tried)}`
}

module.exports = { dangerousNow, whereToFight, wallOff, AGAIN_WONT_HELP, stepUpInto, ASIDE_LIMIT, isWater, waterLevel, pushOf, waterFeeders, standingInSource, SWIM_REACH, SWIM_MS_PER_BLOCK, airOver, dryCell, dryStep, PLUG_MS, DRAIN_MS, WET_LIMIT, eyeWet, outOfWater, waterNext, waterStop }

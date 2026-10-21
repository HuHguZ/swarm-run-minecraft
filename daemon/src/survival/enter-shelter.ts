
const gameClock: typeof import('.././game-clock') = require('.././game-clock')

const Vec3: typeof import('vec3').Vec3 = require('vec3')

const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')

const { sleep, xyz, travelXZ, inWater, findNearestLand, findSwimRoute, escapeWater }: typeof import('.././movement') = require('.././movement')

const {
  itemNamed, countItems, diffItems, equipBestTool, missingHarvestTool, toolBudget,
  toolShortfall, SWINGS_PER_LEVEL
}: typeof import('.././items') = require('.././items')

const { placeBlockAt, digUp, pickFiller, withTimeout, occupiedByEntity }: typeof import('.././build') = require('.././build')

const { digStairs }: typeof import('.././actions') = require('.././actions')

const { nearestHostile, HOSTILES, corridorShape, openSides, liveAttacker, RANGED }: typeof import('.././combat') = require('.././combat')

const { canSeePoint }: typeof import('.././perception') = require('.././perception')

const { reachOf }: typeof import('.././reach') = require('.././reach')

const worlds: typeof import('.././worlds') = require('.././worlds')

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

function clampDepth (depth) {
  if (depth === null || depth === undefined) return 2
  const n = Math.round(Number(depth))
  if (!Number.isFinite(n)) return 2
  return Math.max(1, Math.min(3, n))
}

function canStepOut (bot) {
  const feet = bot.entity.position.floored()
  for (const dir of SIDES) {
    const side = bot.blockAt(feet.plus(dir))
    const over = bot.blockAt(feet.plus(dir).offset(0, 1, 0))
    if (side && over && side.boundingBox === 'empty' && over.boundingBox === 'empty') return true
  }
  return false
}

async function lightNiche (bot, ctl) {
  const item = itemNamed(bot, 'torch')
  if (!item) return false
  try {
    // equip is a window click and waits on the server like everything else.
    await withTimeout(bot.equip(item, 'hand'), 5000)
    const feet = bot.entity.position.floored()
    for (const at of [feet.offset(0, 1, 0), feet]) {
      for (const dir of SIDES) {
        if (ctl.aborted) return false
        const wall = bot.blockAt(at.plus(dir))
        if (!wall || wall.boundingBox !== 'block') continue
        if (/water|lava/.test(wall.name)) continue
        try {
          await bot.lookAt(at.offset(0.5, 0.5, 0.5), true)
          await withTimeout(bot.placeBlock(wall, dir.scaled(-1)), 4000)
        } catch {}
        const now = bot.blockAt(at)
        if (now && /torch/.test(now.name)) return true
      }
    }
  } catch {
    // A dark hole is still a hole — a torch is never worth failing the shelter.
  }
  return false
}

async function sinkOne (bot, mcData, handSandstone = false) {
  const feet = bot.entity.position.floored()
  const below = bot.blockAt(feet.offset(0, -1, 0))
  const under = bot.blockAt(feet.offset(0, -2, 0))
  if (!below) return { stopped: 'мир под ногами не прогружен' }
  if (below.name === 'bedrock') return { stopped: 'под ногами бедрок' }

  if (under && /lava/.test(under.name)) return { stopped: 'под ногами лава — дальше не копаю' }
  if (under && under.name === 'water') return { stopped: 'под ногами вода — дальше не копаю' }
  // Лава сбоку от клетки, в которую упадём: вскроем стенку — затечёт в нору.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [-1, -2]) {
      const side = bot.blockAt(feet.offset(dx, dy, dz))
      if (side && /lava/.test(side.name)) return { stopped: 'лава в стенке ямы — тут не копаю' }
      // Вода в стенке затечёт в нору, а закрытый потолок сделает её ловушкой (tw-a-s1-3 15.10: нора у пруда, утонул).
      if (side && /^(water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/.test(side.name)) return { stopped: 'вода в стенке ямы — тут не копаю' }
    }
  }
  if (under && under.boundingBox === 'empty') {
    const deeper = bot.blockAt(feet.offset(0, -3, 0))
    if (deeper && deeper.boundingBox === 'empty') {
      return { stopped: 'под ногами пустота (пещера) — дальше не копаю' }
    }
  }

  const noHarvest = missingHarvestTool(bot, below, mcData)
  if (noHarvest && !(handSandstone && /^(sandstone|red_sandstone)$/.test(below.name))) return { stopped: noHarvest }

  try {
    await equipBestTool(bot, below)
    await bot.dig(below)
  } catch (e) {
    return { stopped: e.message }
  }
  await sleep(450) // the block below is only the right one once the fall is over
  return { ok: true }
}

async function sealAbove (bot, ctl, steady = false) {
  let last = null
  for (let attempt = 0; attempt < 2 && !ctl.aborted; attempt++) {
    if (attempt) await sleep(700) // the body is usually still settling into the shaft
    const r = await placeBlockAt(bot, bot.entity.position.floored().offset(0, 2, 0), { steady, ...(steady ? { honest: true, ctl } : {}) })
    if (r.ok) return r
    last = r
  }
  return last || { ok: false, reason: 'прервано' }
}

async function shelter (session, ctl, { mode = 'enter', depth = 2, torch = true }: any = {}) {
  // A null mode means "you decide", not "unknown mode": the brain leaves
  // optional JSON fields null far more often than it leaves them out.
  const how = mode === null || mode === undefined ? 'enter' : String(mode).trim().toLowerCase()
  if (how === 'enter') return enterShelter(session, ctl, { depth, torch: torch !== false })
  if (how === 'exit') return exitShelter(session, ctl, { depth })
  if (how === 'box') return await boxShelter(session, ctl, true) || { stopped: 'не удалось закрыться на месте', sealed: false }
  if (how === 'light') return { torch: await lightNiche(session.bot, ctl) }
  // Digging a hole because the mode was misspelled is the worst possible
  // reading of an unclear order.
  throw new Error(`не знаю режим ${mode}, бывает enter, exit, box или light`)
}

async function enterShelter (session, ctl, { depth, torch, box = true, maxSwings = null, center = false }: any) {
  const bot = session.bot
  const mcData = session.mcData
  const want = clampDepth(depth)

  // Sealing yourself under water is drowning with extra steps.
  if (inWater(bot)) throw new Error('я в воде — тут не окопаешься')

  const ground = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  if (!ground) throw new Error('подо мной мир не прогружен — копать нечего')
  const handDesert = process.env.ND_OW_DESERT_HAND_SHELTER === '1' && worlds.worldOf(bot) === 'overworld' &&
    !bot.inventory.items().some(i => /_pickaxe$/.test(i.name)) && /^(sand|sandstone|red_sandstone)$/.test(ground.name)
  const noTool = missingHarvestTool(bot, ground, mcData)
  if (noTool && !(handDesert && /^(sandstone|red_sandstone)$/.test(ground.name))) throw new Error(noTool)
  if (handDesert) {
    let ready = false
    try { ready = await (require('../actions/desert') as typeof import('../actions/desert')).desertRoof(session, ctl) } catch {}
    if (ctl.aborted) return { mode: 'enter', sealed: false, stopped: 'прервано' }
    if (!ready) return { mode: 'enter', sealed: false, stopped: 'desert shelter: stable roof and three exit blocks unavailable' }
  }

  // Dusk is short; a shaft that is not finished in a minute is not a shelter.
  const deadline = gameClock.now() + 60000
  const startY = Math.floor(bot.entity.position.y)
  // Depth is how far the body actually fell, not how many times we swung:
  const depthNow = () => startY - Math.floor(bot.entity.position.y)
  let stopped = null
  let swings = 0

  // maxSwings — refuge: яма, которая не углубляется, под зомби — 9 взмахов (~9 с)
  // стоят жизни (H); два лишних — и хватит.
  const swingCap = maxSwings || want * 3
  while (depthNow() < want && swings < swingCap && !ctl.aborted && gameClock.now() < deadline) {
    // center (refuge): тело, сдвинутое к краю клетки (толкнул моб), стоит и на
    const was = depthNow()
    const step = await sinkOne(bot, mcData, handDesert)
    swings++
    if (step.stopped) { stopped = step.stopped; break }
    if (center && depthNow() === was) { try { await (require('.././fortify') as typeof import('.././fortify')).centerInCell(bot, 500) } catch {} await sleep(250) }
  }
  if (!stopped && depthNow() < want) {
    if (ctl.aborted) stopped = 'прервано'
    else if (gameClock.now() >= deadline) stopped = 'время вышло'
    else stopped = 'яма не углубляется — сверху осыпается'
  }

  let dug = depthNow()
  if (!dug) {
    // Нора не копается (песок и гравий сыплются, под ногами листва или
    if (!ctl.aborted && box) {
      const boxed = await boxShelter(session, ctl)
      if (boxed) return boxed
    }
    const note = `яму не выкопал (${stopped || 'прервано'}) — ночевать тут нельзя`
    session.journal.append('убежище', note, bot.entity.position)
    return {
      mode: 'enter',
      at: xyz(bot.entity.position),
      depth: 0,
      sealed: false,
      torch: false,
      note,
      stopped: stopped || undefined
    }
  }

  // Вода натекла в нору (бок, промытый ход) — потолок над водой не ставить: это утопление, а не ночлег.
  if (inWater(bot)) {
    const note = `нора на ${dug} вниз залита водой — потолок не ставлю, выхожу`
    session.journal.append('убежище', note, bot.entity.position)
    try { await escapeWater(bot, ctl, { timeoutMs: 15000 }) } catch {}
    return { mode: 'enter', at: xyz(bot.entity.position), depth: dug, sealed: false, torch: false, note, stopped: 'вода в норе' }
  }
  let seal = await sealAbove(bot, ctl, handDesert)
  // Two deep leaves the roof hanging in the air above the surface with no
  if (!seal.ok && dug < 3 && !stopped && !ctl.aborted && gameClock.now() < deadline) {
    const step = await sinkOne(bot, mcData, handDesert)
    if (step.stopped) stopped = step.stopped
    if (depthNow() > dug) {
      dug = depthNow()
      seal = await sealAbove(bot, ctl, handDesert)
    }
  }

  // Бока клетки тела (ноги, голова) — сплошь; открытый бок (нора у склона, у пещеры) заложить, не вышло — нора не
  // закрыта (ND_REFUGE_SIT; trapJ 03.10, lowhp: «нора на 3, потолок закрыт» на склоне — зомби вошёл сбоку, 5 → 0).
  let sideOpen = 0
  if (sitOn() && seal.ok && !ctl.aborted) {
    const f0 = bot.entity.position.floored()
    for (const dir of SIDES) {
      for (const dy of [0, 1]) {
        const p = f0.plus(dir).offset(0, dy, 0)
        const b = bot.blockAt(p)
        if (b && b.boundingBox === 'block') continue
        let r = null
        try { r = await placeBlockAt(bot, p, { timeoutMs: 1500 }) } catch {}
        if (!(r && r.ok)) sideOpen++
      }
    }
    if (sideOpen) seal = { ok: false, reason: `бок открыт (${sideOpen} кл.) — не заложить` }
  }

  const lit = torch ? await lightNiche(bot, ctl) : false

  const parts = [`нора на ${dug} вниз`]
  parts.push(seal.ok
    ? 'потолок закрыт'
    : `ПОТОЛОК ОТКРЫТ (${seal.reason}) — мобы залезут, это ещё не ночлег`)
  // Still hanging in the air, which means the extra block down above never
  if (!seal.ok && /прислонить/.test(seal.reason || '') && dug < 3) {
    parts.push('копни ещё на 1 вниз и закройся оттуда')
  }
  if (lit) parts.push('горит факел')
  else if (torch) parts.push(itemNamed(bot, 'torch') ? 'факел не встал' : 'факелов нет')
  if (dug < 2) parts.push('вниз всего 1 — голова над землёй, стен вокруг нет')
  if (stopped) parts.push(stopped)
  const note = parts.join('; ')

  const at = xyz(bot.entity.position)
  session.journal.patch(s => { s.places['убежище'] = { ...at, note } })
  session.journal.append('убежище', note, bot.entity.position)

  const guarded = seal.ok ? armShelterGuard(session) : 0

  return {
    mode: 'enter',
    at,
    depth: dug,
    sealed: !!seal.ok,
    guarded: guarded || undefined,
    torch: lit,
    note,
    stopped: stopped || undefined
  }
}

function armShelterGuard (session) {
  const bot = session.bot
  if (session.shelterGuard) session.shelterGuard.disarm()
  const feet = bot.entity.position.floored()
  const cells = [feet.offset(0, 2, 0)]
  for (const dir of SIDES) {
    cells.push(feet.plus(dir))
    cells.push(feet.plus(dir).offset(0, 1, 0))
  }
  // Сторожим только то, что сейчас стоит: открытый бок, которого и не было,
  // «вскрытым» не назовёшь.
  const watched = cells.filter(p => {
    const b = bot.blockAt(p)
    return b && b.boundingBox === 'block'
  })
  const keys = new Set(watched.map(p => `${p.x},${p.y},${p.z}`))
  const guard: any = { feet, patched: 0, failed: 0, lastSaid: 0, busy: false }

  const inside = () => bot.entity && bot.entity.position.floored().equals(feet)

  const tell = (type, extra) => {
    const now = gameClock.now()
    if (type === 'shelter_patched' && now - guard.lastSaid < 15000) return
    guard.lastSaid = now
    session.bus.emit(type, { patched: guard.patched, ...extra })
  }

  const patch = async (pos) => {
    if (guard.busy) { gameClock.setTimeout(() => patch(pos), 150); return }
    guard.busy = true
    try {
      const b = bot.blockAt(pos)
      if (b && b.boundingBox === 'block') return
      // Упало что-то сыпучее и лежит в клетке — это уже не дыра.
      const r = await placeBlockAt(bot, pos, { timeoutMs: 1500 })
      if (r.ok) {
        guard.patched++
        const who = nearestPlayerName(bot, 6)
        tell('shelter_patched', { at: xyz(pos), by: who || undefined, roof: pos.y > feet.y + 1 })
      } else {
        guard.failed++
        // Нечем закладывать — сказать один раз и честно, что нора открыта.
        if (guard.failed === 1 || /нечем|нет/.test(r.reason || '')) {
          tell('shelter_open', { at: xyz(pos), why: r.reason })
        }
      }
    } catch {} finally {
      guard.busy = false
    }
  }

  const onUpdate = (oldBlock, newBlock) => {
    if (!newBlock || !keys.has(`${newBlock.position.x},${newBlock.position.y},${newBlock.position.z}`)) return
    if (!inside()) { disarm(); return }
    if (newBlock.boundingBox === 'block') return
    // Мозг сам повёл тело копать (штрек из норы, лесенка вниз) — это не
    // вскрытие, и закладывать то, что мы же рубим, значит драться с собой.
    const cur = session.current
    // refuge сидит в норе сам (аварийный отход): вскрытие латает этот караул.
    if (cur && cur.name !== 'wait' && cur.name !== 'retaliate' && cur.name !== 'refuge') { disarm(); return }
    patch(newBlock.position)
  }

  const disarm = () => {
    bot.removeListener('blockUpdate', onUpdate)
    bot.removeListener('death', disarm)
    gameClock.clearInterval(leave)
    if (session.shelterGuard === guard) session.shelterGuard = null
  }
  // Вылез сам — караул снят. Раз в секунду, а не по каждому движению.
  const leave = gameClock.setInterval(() => { if (!inside()) disarm() }, 1000)
  if (leave.unref) leave.unref()

  guard.disarm = disarm
  bot.on('blockUpdate', onUpdate)
  bot.once('death', disarm)
  session.shelterGuard = guard
  return watched.length
}

function nearestPlayerName (bot, radius) {
  let best = null
  for (const p of ((Object.values(bot.players || {}) as any[]) as any)) {
    const e = p.entity
    if (!e || e === bot.entity || !e.position) continue
    const d = e.position.distanceTo(bot.entity.position)
    if (d <= radius && (!best || d < best.d)) best = { d, name: p.username }
  }
  return best ? best.name : null
}

async function boxShelter (session, ctl, explain = false) {
  const bot = session.bot
  const fortify: typeof import('.././fortify') = require('.././fortify')
  try {
    const box = await fortify.boxIn(bot, { roof: true, ctl, timeoutMs: 800, hard: false })
    if (!ctl.aborted && !box.sealed && box.plan) await fortify.patch(bot, box.plan, { timeoutMs: 800, ctl }).catch(() => 0)
    if (!box.cell || !fortify.enclosure(bot, box.cell).sealed) return explain
      ? { stopped: `не удалось закрыться на месте: ${box.why || box.failed?.join('; ') || 'остались открытые стены или крыша'}`, sealed: false }
      : null
    session.shelterBox = box.cell
    const note = 'закрылся коробкой из блоков на месте'
    session.journal.append('убежище', note, bot.entity.position)
    return { mode: 'enter', at: xyz(bot.entity.position), depth: 0, sealed: true, box: true, torch: false, note }
  } catch (e) { return explain ? { stopped: `не удалось закрыться на месте: ${e.message}`, sealed: false } : null }
}

async function exitShelter (session, ctl, { depth }: any) {
  const bot = session.bot
  if (process.env.ND_BRUTE_MEMORY === '1') {
    const memory = await (require('../brute-shelter') as typeof import('../brute-shelter')).ensureShelterExit(session, ctl)
    if (memory) return { mode: 'exit', at: xyz(bot.entity.position), out: false, climbed: 0, stopped: 'brute memory: replan covered exit', bruteMemory: memory }
  }
  // Сами ломаем потолок — караул не должен закладывать его обратно.
  if (session.shelterGuard) session.shelterGuard.disarm()
  // Коробка вместо норы (boxShelter): выход сбоку, как из коробки ифритов,
  // а не столбом через крышу. Чужая старая клетка (смерть внутри) — мимо.
  const boxCell = session.shelterBox
  session.shelterBox = null
  if (boxCell && bot.entity.position.floored().distanceTo(boxCell) < 1.5) {
    try { await (require('.././fortify') as typeof import('.././fortify')).breakOut(bot, boxCell, {}) } catch {}
  }
  // The shaft we dug plus the ceiling we sealed, and one spare for whatever
  // fell in on top of us while we sat there.
  const limit = clampDepth(depth) + 2
  const from = bot.entity.position.y
  const deadline = gameClock.now() + 60000
  let stopped = null

  ctl.onAbort.push(() => { try { bot.clearControlStates() } catch {} })

  for (let i = 0; i < limit && !ctl.aborted && gameClock.now() < deadline; i++) {
    if (canStepOut(bot)) break
    if (process.env.ND_BRUTE_MEMORY === '1') {
      const memory = await (require('../brute-shelter') as typeof import('../brute-shelter')).ensureShelterExit(session, ctl, undefined, { knownShelter: true })
      if (memory) return { mode: 'exit', at: xyz(bot.entity.position), out: false, climbed: Math.round(bot.entity.position.y - from), stopped: 'brute memory: replan covered exit', bruteMemory: memory }
    }
    const was = bot.entity.position.y
    const r = await digUp(bot, ctl, { blocks: 1, mcData: session.mcData, tower: true,
      handSandstone: process.env.ND_OW_DESERT_HAND_SHELTER === '1' && worlds.worldOf(bot) === 'overworld' })
    if (r.stopped) { stopped = r.stopped; break }
    // Nothing broken and no height gained: no pick for the ceiling, or nothing
    // left to build the pillar from. Another lap would only repeat it.
    if (!r.dug && bot.entity.position.y - was < 0.5) {
      stopped = 'не поднимаюсь — нечем копать или не из чего строить столб'
      break
    }
  }

  const out = canStepOut(bot)
  const climbed = Math.round(bot.entity.position.y - from)
  return {
    mode: 'exit',
    at: xyz(bot.entity.position),
    climbed,
    out,
    stopped: stopped || (out ? undefined : 'наружу так и не выбрался'),
    note: out && !climbed ? 'и так не был заперт' : undefined
  }
}

const DESPAWN_MINUTES = 5

const SECONDS_PER_LEVEL = 8

const PICKUP_RESERVE_MS = 25000

const BLOCKS_PER_SECOND = 3

const AROUND = [[3, 0], [-3, 0], [0, 3], [0, -3]]

function deathPos (d) {
  if (!d) return null
  if (d.pos && typeof d.pos.x === 'number') return d.pos
  if (typeof d.x === 'number') return { x: d.x, y: d.y, z: d.z }
  return null
}

function descentPlan (feet, target) {
  const down = feet.y - target.y
  // One level is a step down, not a staircase; and a target above us is not a
  // descent at all.
  if (down < 2) return { down, direction: null, from: { x: target.x, z: target.z } }
  const dx = feet.x - target.x
  const dz = feet.z - target.z
  const alongX = Math.abs(dx) >= Math.abs(dz)
  const sign = (alongX ? dx : dz) >= 0 ? 1 : -1
  return {
    down,
    // digStairs walks +x for east and +z for south, so digging back toward the
    // target is the opposite of the side we staged on.
    direction: alongX ? (sign > 0 ? 'west' : 'east') : (sign > 0 ? 'north' : 'south'),
    from: alongX
      ? { x: target.x + sign * down, z: target.z }
      : { x: target.x, z: target.z + sign * down }
  }
}

const SWEEP_HOP_MS = 8000

const SWEEP_STALL_MS = 4000

const WRITTEN_OFF_MS = 120000

const writtenOff = new WeakMap()

function ledgerOf (bot) {
  let m = writtenOff.get(bot)
  if (!m) { m = new Map(); writtenOff.set(bot, m) }
  return m
}

function isDrop (e) {
  return !!e && !!e.position && (e.name === 'item' || e.displayName === 'Item' || e.name === 'item_stack')
}

function stackLabel (e) {
  let it = null
  try { it = e.getDroppedItem() } catch {}
  return it ? `${it.name}×${it.count}` : 'стак'
}

function stackWord (n) {
  const t = n % 10
  const h = n % 100
  if (t === 1 && h !== 11) return 'стак'
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return 'стака'
  return 'стаков'
}

async function hopOnto (bot, ctl, e, until) {
  const p = e.position.clone()
  const gap = () => e.position.distanceTo(bot.entity.position)
  let best = gap()
  let anchor = bot.entity.position.clone()
  let movedAt = gameClock.now()
  let tick = null
  // A witness on state, polled: whether the stack still exists, how far it is
  const watch = new Promise<any>(resolve => {
    tick = gameClock.setInterval(() => {
      if (ctl.aborted) return resolve('прервано')
      if (e.isValid === false) return resolve('взял')
      const d = gap()
      if (d < best - 0.5) { best = d; movedAt = gameClock.now() }
      // 0.6 is movement.stuckGuard's threshold for «moved at all».
      if (bot.entity.position.distanceTo(anchor) > 0.6) { anchor = bot.entity.position.clone(); movedAt = gameClock.now() }
      if (gameClock.now() - movedAt >= SWEEP_STALL_MS) return resolve('встал')
      if (gameClock.now() >= until) return resolve('время')
    }, 200)
  })
  // A resolved goto is not arrival either: lib/goto.js resolves on ANY
  const walk = bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1))
    .then(() => (e.isValid === false ? 'взял' : gap() <= 2 ? 'дошёл' : 'нет пути'),
      err => `нет пути${err && err.message ? ': ' + err.message : ''}`)
  const how = await Promise.race([walk, watch])
  gameClock.clearInterval(tick)
  // Always, whoever won. A goto that lost the race is still steering; one that
  try { bot.pathfinder.setGoal(null) } catch {}
  return how
}

async function sweepDrops (bot, ctl, { radius, until, tried }: any) {
  const out: any = { walked: 0, taken: 0, left: [], reached: [], ended: 'обошёл всё' }
  // The radius is measured from where the sweep began, not from the body: every
  const from = bot.entity.position.clone()
  const lying = () => (Object.values(bot.entities) as any[])
    .filter((e : any) => isDrop(e) && !tried.has(e.id) && e.position.distanceTo(from) <= radius)
    .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  const pile = new Set(lying().map((e : any) => e.id))
  for (;;) {
    if (ctl.aborted) { out.ended = 'прервано'; break }
    const waiting = lying().filter((e : any) => pile.has(e.id))
    if (!waiting.length) break
    if (gameClock.now() >= until) { out.ended = 'срок'; out.unvisited = waiting.length; break }
    const next: any = waiting[0]
    tried.add(next.id)
    const how = await hopOnto(bot, ctl, next, Math.min(until, gameClock.now() + SWEEP_HOP_MS))
    if (ctl.aborted) { out.ended = 'прервано'; break }
    if (how === 'дошёл') await sleep(350) // the collect packet trails the arrival by a tick or two
    if (how === 'дошёл' || how === 'взял') out.walked++
    if (next.isValid === false) { out.taken++; continue }
    // Reached and still lying there is a full bag, not a stack out of reach;
    // the caller already has a sentence for that one.
    if (how === 'дошёл') { out.reached.push(next.id); continue }
    // The call's clock ended this walk, not the stack's own hop cap: the stack
    if (how === 'время' && gameClock.now() >= until) { tried.delete(next.id); continue }
    out.left.push({ ent: next, what: stackLabel(next), at: xyz(next.position), why: how })
  }
  return out
}

const leftWhy = why => why === 'встал'
  ? `${SWEEP_STALL_MS / 1000} с ни ближе к нему, ни с места`
  : why === 'время'
    ? `за ${SWEEP_HOP_MS / 1000} с не дошёл`
    : 'пути к нему не нашлось'

const spot = p => `${p.x},${p.y},${p.z}`

const sitOn = () => process.env.ND_REFUGE_SIT !== '0'

module.exports = { gameClock, Vec3, goals, sleep, xyz, travelXZ, inWater, findNearestLand, findSwimRoute, escapeWater, itemNamed, countItems, diffItems, equipBestTool, missingHarvestTool, toolBudget, toolShortfall, SWINGS_PER_LEVEL, placeBlockAt, digUp, pickFiller, withTimeout, occupiedByEntity, digStairs, nearestHostile, HOSTILES, corridorShape, openSides, liveAttacker, RANGED, canSeePoint, reachOf, worlds, SIDES, clampDepth, canStepOut, lightNiche, sinkOne, sealAbove, shelter, enterShelter, armShelterGuard, nearestPlayerName, boxShelter, exitShelter, DESPAWN_MINUTES, SECONDS_PER_LEVEL, PICKUP_RESERVE_MS, BLOCKS_PER_SECOND, AROUND, deathPos, descentPlan, SWEEP_HOP_MS, SWEEP_STALL_MS, WRITTEN_OFF_MS, writtenOff, ledgerOf, isDrop, stackLabel, stackWord, hopOnto, sweepDrops, leftWhy, spot, sitOn }
export {
  gameClock, Vec3, goals, sleep, xyz, travelXZ, inWater, findNearestLand, findSwimRoute, escapeWater, itemNamed,
  countItems, diffItems, equipBestTool, missingHarvestTool, toolBudget, toolShortfall, SWINGS_PER_LEVEL,
  placeBlockAt, digUp, pickFiller, withTimeout, occupiedByEntity, digStairs, nearestHostile, HOSTILES,
  corridorShape, openSides, liveAttacker, RANGED, canSeePoint, reachOf, worlds, SIDES, clampDepth, canStepOut,
  lightNiche, sinkOne, sealAbove, shelter, enterShelter, armShelterGuard, nearestPlayerName, boxShelter,
  exitShelter, DESPAWN_MINUTES, SECONDS_PER_LEVEL, PICKUP_RESERVE_MS, BLOCKS_PER_SECOND, AROUND, deathPos,
  descentPlan, SWEEP_HOP_MS, SWEEP_STALL_MS, WRITTEN_OFF_MS, writtenOff, ledgerOf, isDrop, stackLabel, stackWord,
  hopOnto, sweepDrops, leftWhy, spot, sitOn
}

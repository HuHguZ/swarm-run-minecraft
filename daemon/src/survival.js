'use strict'
const gameClock = require('./game-clock')
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, xyz, travelXZ, inWater, findNearestLand, findSwimRoute, escapeWater } = require('./movement')
const {
  itemNamed, countItems, diffItems, equipBestTool, missingHarvestTool, toolBudget,
  toolShortfall, SWINGS_PER_LEVEL
} = require('./items')
const { placeBlockAt, digUp, pickFiller, withTimeout, occupiedByEntity } = require('./build')
const { digStairs } = require('./actions')
const { nearestHostile, HOSTILES, corridorShape, openSides, liveAttacker, RANGED } = require('./combat')
const { canSeePoint } = require('./perception')
const { reachOf } = require('./reach')
const worlds = require('./worlds')

// Surviving the night, paying for a death, and getting back up. Nothing here
// is clever, and that is the point: a hole with the lid pulled shut when there
// is no bed to reach, a walk back to the pile every death dumps on the ground,
// and the hundred and twenty blocks of climbing between a diamond seam and the
// daylight.

// The four horizontal neighbours. Answers both "which wall can hold a torch"
// and "is there a way out of here sideways".
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

// ---------------------------------------------------------------- shelter

// Two deep puts the head below ground level, but the roof then has to go one
// level ABOVE the surrounding surface, where nothing touches it and vanilla
// refuses to place at all — measured in game, not guessed. Three is what
// actually closes over the head, and the deepest worth digging by hand at dusk.
// null arrives here as often as undefined: the brain fills optional JSON fields
// with it, and Number(null) is a very quiet 0.
function clampDepth (depth) {
  if (depth === null || depth === undefined) return 2
  const n = Math.round(Number(depth))
  if (!Number.isFinite(n)) return 2
  return Math.max(1, Math.min(3, n))
}

// "Out" means the body can walk away, not that there is air overhead: standing
// at the bottom of a one-block shaft under open sky is still trapped.
function canStepOut (bot) {
  const feet = bot.entity.position.floored()
  for (const dir of SIDES) {
    const side = bot.blockAt(feet.plus(dir))
    const over = bot.blockAt(feet.plus(dir).offset(0, 1, 0))
    if (side && over && side.boundingBox === 'empty' && over.boundingBox === 'empty') return true
  }
  return false
}

// The only room for a torch in a 1x1 niche is the space the body itself
// occupies, and that is legal because a torch has no collision box.
// placeBlockAt() cannot do this job: it confirms a placement by boundingBox,
// which a torch does not have, so it would read a landed torch as a miss and
// spend the next one on another wall.
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

// One block down, carrying digDown's exact two-blocks-ahead probe. That probe
// reads through solid stone, which is only ever allowed to talk us out of a
// swing — never to find anything.
async function sinkOne (bot, mcData) {
  const feet = bot.entity.position.floored()
  const below = bot.blockAt(feet.offset(0, -1, 0))
  const under = bot.blockAt(feet.offset(0, -2, 0))
  if (!below) return { stopped: 'мир под ногами не прогружен' }
  if (below.name === 'bedrock') return { stopped: 'под ногами бедрок' }

  if (under && /lava/.test(under.name)) return { stopped: 'под ногами лава — дальше не копаю' }
  if (under && under.name === 'water') return { stopped: 'под ногами вода — дальше не копаю' }
  // Лава сбоку от клетки, в которую упадём: вскроем стенку — затечёт в нору.
  // Кампания 2026-09-28 (13:10): нора у лавового озера портала (−17,61,−20) —
  // горел от 20 до 0 хп, escape_fire и новые норы по кругу.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [-1, -2]) {
      const side = bot.blockAt(feet.offset(dx, dy, dz))
      if (side && /lava/.test(side.name)) return { stopped: 'лава в стенке ямы — тут не копаю' }
    }
  }
  if (under && under.boundingBox === 'empty') {
    const deeper = bot.blockAt(feet.offset(0, -3, 0))
    if (deeper && deeper.boundingBox === 'empty') {
      return { stopped: 'под ногами пустота (пещера) — дальше не копаю' }
    }
  }

  const noHarvest = missingHarvestTool(bot, below, mcData)
  if (noHarvest) return { stopped: noHarvest }

  try {
    await equipBestTool(bot, below)
    await bot.dig(below)
  } catch (e) {
    return { stopped: e.message }
  }
  await sleep(450) // the block below is only the right one once the fall is over
  return { ok: true }
}

// The roof goes over our own head, and the head is wherever the body finished
// falling — so the position is read again on the retry instead of reused.
async function sealAbove (bot, ctl) {
  let last = null
  for (let attempt = 0; attempt < 2 && !ctl.aborted; attempt++) {
    if (attempt) await sleep(700) // the body is usually still settling into the shaft
    const r = await placeBlockAt(bot, bot.entity.position.floored().offset(0, 2, 0))
    if (r.ok) return r
    last = r
  }
  return last || { ok: false, reason: 'прервано' }
}

async function shelter (session, ctl, { mode = 'enter', depth = 2, torch = true } = {}) {
  // A null mode means "you decide", not "unknown mode": the brain leaves
  // optional JSON fields null far more often than it leaves them out.
  const how = mode === null || mode === undefined ? 'enter' : String(mode).trim().toLowerCase()
  if (how === 'enter') return enterShelter(session, ctl, { depth, torch: torch !== false })
  if (how === 'exit') return exitShelter(session, ctl, { depth })
  // Digging a hole because the mode was misspelled is the worst possible
  // reading of an unclear order.
  throw new Error(`не знаю режим ${mode}, бывает enter или exit`)
}

async function enterShelter (session, ctl, { depth, torch, box = true, maxSwings = null, center = false }) {
  const bot = session.bot
  const mcData = session.mcData
  const want = clampDepth(depth)

  // Sealing yourself under water is drowning with extra steps.
  if (inWater(bot)) throw new Error('я в воде — тут не окопаешься')

  const ground = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  if (!ground) throw new Error('подо мной мир не прогружен — копать нечего')
  const noTool = missingHarvestTool(bot, ground, mcData)
  if (noTool) throw new Error(noTool)

  // Dusk is short; a shaft that is not finished in a minute is not a shelter.
  const deadline = gameClock.now() + 60000
  const startY = Math.floor(bot.entity.position.y)
  // Depth is how far the body actually fell, not how many times we swung:
  // gravel and sand pour straight back into the shaft, so a counted swing can
  // leave the hole exactly as deep as it was.
  const depthNow = () => startY - Math.floor(bot.entity.position.y)
  let stopped = null
  let swings = 0

  // maxSwings — refuge: яма, которая не углубляется, под зомби — 9 взмахов (~9 с)
  // стоят жизни (H); два лишних — и хватит.
  const swingCap = maxSwings || want * 3
  while (depthNow() < want && swings < swingCap && !ctl.aborted && gameClock.now() < deadline) {
    // center (refuge): тело, сдвинутое к краю клетки (толкнул моб), стоит и на
    // соседнем блоке — вырытый под floored-клеткой не роняет его, и яма «не
    // углубляется» (I: 5 взмахов впустую под зомби). В центр — до и после взмаха.
    const was = depthNow()
    const step = await sinkOne(bot, mcData)
    swings++
    if (step.stopped) { stopped = step.stopped; break }
    if (center && depthNow() === was) { try { await require('./fortify').centerInCell(bot, 500) } catch {} await sleep(250) }
  }
  if (!stopped && depthNow() < want) {
    if (ctl.aborted) stopped = 'прервано'
    else if (gameClock.now() >= deadline) stopped = 'время вышло'
    else stopped = 'яма не углубляется — сверху осыпается'
  }

  let dug = depthNow()
  if (!dug) {
    // Нора не копается (песок и гравий сыплются, под ногами листва или
    // дерево): коробка из блоков вокруг себя, как у ифритов (fortify.boxIn).
    // 2026-09-29 12:54: ночью в джунглях «яма не углубляется» — кампания
    // встала блокером, бот на 16 хп остался среди мобов.
    // box:false — refuge: у него своя (честная) коробка и свой порядок отката.
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

  let seal = await sealAbove(bot, ctl)
  // Two deep leaves the roof hanging in the air above the surface with no
  // neighbour to place it against: a failure of geometry, which no number of
  // retries at the same spot can fix. One more block down and the roof lands
  // between the walls of the shaft — and the block it is made of is the one we
  // just dug, so this also answers "нечем строить".
  if (!seal.ok && dug < 3 && !stopped && !ctl.aborted && gameClock.now() < deadline) {
    const step = await sinkOne(bot, mcData)
    if (step.stopped) stopped = step.stopped
    if (depthNow() > dug) {
      dug = depthNow()
      seal = await sealAbove(bot, ctl)
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
  // happened (lava, no tool, out of time). Hand the brain the same move —
  // a second enter from inside the hole seals it.
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

// Караул в норе. Закрыться мало: человек сверху ломает крышку за полсекунды, и
// раньше бот сидел под открытым небом до следующего хода мозга. Теперь каждая
// клетка, которая держит нору, — потолок и стенки на уровне ног и головы, —
// под присмотром: стала пустой — тут же закладываем обратно тем, что есть в
// руках. blockUpdate, а не тик автопилота: секунда — это два удара в голову.
//
// Сказать об этом — одним событием на вскрытие, а не строкой на каждый блок:
// «кто-то ломает — заложил, 3-й раз» полезно, «потолок сломан» ×20 — шум.
// Кончается сам, когда тело вышло из своей клетки (вылезли, упали, умерли).
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
  const guard = { feet, patched: 0, failed: 0, lastSaid: 0, busy: false }

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
  for (const p of Object.values(bot.players || {})) {
    const e = p.entity
    if (!e || e === bot.entity || !e.position) continue
    const d = e.position.distanceTo(bot.entity.position)
    if (d <= radius && (!best || d < best.d)) best = { d, name: p.username }
  }
  return best ? best.name : null
}

// Коробка на месте: стены и крыша из блоков рюкзака. null — не закрылась.
async function boxShelter (session, ctl) {
  const bot = session.bot
  const fortify = require('./fortify')
  try {
    const box = await fortify.boxIn(bot, { roof: true, ctl, timeoutMs: 800, hard: false })
    if (!box.sealed && box.plan) await fortify.patch(bot, box.plan, { timeoutMs: 800 }).catch(() => 0)
    if (!box.cell || !fortify.enclosure(bot, box.cell).sealed) return null
    session.shelterBox = box.cell
    const note = 'нора не копается — закрылся коробкой из блоков'
    session.journal.append('убежище', note, bot.entity.position)
    return { mode: 'enter', at: xyz(bot.entity.position), depth: 0, sealed: true, box: true, torch: false, note }
  } catch { return null }
}

async function exitShelter (session, ctl, { depth }) {
  const bot = session.bot
  // Сами ломаем потолок — караул не должен закладывать его обратно.
  if (session.shelterGuard) session.shelterGuard.disarm()
  // Коробка вместо норы (boxShelter): выход сбоку, как из коробки ифритов,
  // а не столбом через крышу. Чужая старая клетка (смерть внутри) — мимо.
  const boxCell = session.shelterBox
  session.shelterBox = null
  if (boxCell && bot.entity.position.floored().distanceTo(boxCell) < 1.5) {
    try { await require('./fortify').breakOut(bot, boxCell, {}) } catch {}
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
    const was = bot.entity.position.y
    const r = await digUp(bot, ctl, { blocks: 1, mcData: session.mcData, tower: true })
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

// ---------------------------------------------------------------- loot

// Items on the ground despawn after 6000 ticks. Every loot run is a race
// against this number, and at depth it is a race the bot loses: the walk is
// cheap, the hundred and nine levels between a surface respawn and the place
// the diamond run died are not.
const DESPAWN_MINUTES = 5

// Measured on the diamond run: three staircase legs carried the bot from y=82
// down to y=-29 — 111 levels — and each leg finished inside its own 240-second
// budget. That is 37 levels per 240 s, or 6.5 a level, and the old constant of
// 6 called itself "rounded the pessimistic way" while rounding the other way.
// The arena caught the difference: 14 levels of stone were costed at 84 s and
// the descent finished so far past that the intent died on the session clock
// with the body already standing on the pile. Eight, because this number does
// not buy speed — it decides whether the bot walks into a five-minute race it
// cannot win, and being wrong low there costs the whole pile.
const SECONDS_PER_LEVEL = 8

// What the pickup needs after the staircase lands: one pathfinder hop to the
// pile, one sweep, and the half second the last stack takes to reach the
// inventory. The old reserve was fifteen seconds against a tail that could
// legitimately run nineteen, so a descent that used its whole allowance
// finished the job and then overran the session wrapper — «работа сделана,
// отчёта нет». Every step of the tail below is clamped to this.
const PICKUP_RESERVE_MS = 25000

// Sprinting is off — it is the main source of physics divergence with the
// server — so the body walks, and pathfinder on real terrain (corners, jumps,
// the odd re-plan) never gets near the 4.3 blocks a second the game gives a
// walking player.
const BLOCKS_PER_SECOND = 3

// A pile from one death spreads over a few blocks, and every stack has to be
// physically walked over, so standing on the exact coordinate collects half of
// it at best.
const AROUND = [[3, 0], [-3, 0], [0, 3], [0, -3]]

// state.json has carried two shapes for a death: session.js writes { at, pos },
// older entries kept the coordinates on the record itself.
function deathPos (d) {
  if (!d) return null
  if (d.pos && typeof d.pos.x === 'number') return d.pos
  if (typeof d.x === 'number') return { x: d.x, y: d.y, z: d.z }
  return null
}

// Where to start digging so the staircase ENDS on the pile. digStairs spends
// one block of horizontal travel per level, so a descent begun on the target
// column lands `down` blocks away from it — which for a death at y=-29 is a
// hundred blocks of "почти дошёл". Stage that far out on the side the body is
// already coming from and walk the hole back to the target.
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

// The pickup, bounded per stack instead of per call.
//
// actions.collectNearbyDrops takes a timeoutMs and reads it only BETWEEN
// stacks: the walk to each one is a bare pathfinder.goto, and goto
// (mineflayer-pathfinder 2.4.5, lib/goto.js) settles on goal_reached, an empty
// path, noPath or a changed goal — never on «stuck», which index.js answers
// with resetPath('stuck') and a fresh plan, forever. Measured on try-surface
// (г2), 2026-09-15: the staircase landed in 34 s, the diamonds were in the bag,
// and one stack pathfinder could not reach held the intent for the rest of its
// 265 s. daemon.out.log shows the shape: thirty-nine «reset: stuck» re-plans
// over ~135 s with the body hanging at y=70.00 over air, then ~80 s with no
// path event at all, and the first «reset: goal_updated» only at the session's
// own abort. The body ended at 766,69,765, off the staircase's z=761 — nowhere
// recoverLoot itself walks. (г3), the same machine for a real death, had
// nothing unreachable in its radius and came home in time; the mode was never
// the difference.
//
// So each stack gets one hop, and the hop ends on the first of: the stack is
// gone, the goal is reached, pathfinder answers, the body stalls, or the clock.
// A stack that could not be reached is written off and named in the report —
// not tried again, because nothing about a second attempt from the same square
// would differ from the first.
const SWEEP_HOP_MS = 8000

// A stall is neither getting closer nor going anywhere. Both, because either
// alone misfires: a detour round a pillar walks away from the stack before it
// walks to it, and a body digging its way there stands still for a swing. Four
// seconds is several swings of stone and a walked detour of a dozen blocks; the
// hang above was two hundred seconds of neither.
const SWEEP_STALL_MS = 4000

// The write-off outlives the call that made it, because the call itself sends
// the brain straight back: a pickup the clock cut short says «позови mc_recover
// ещё раз», and a repeat that starts with an empty ledger hops again, nearest
// first, to every stack the first call already wrote off — the same seconds, the
// same «ещё N стака не обошёл», a loop. Measured offline on twelve stacks out of
// reach: call two spent 44.1 s of a 45 s budget and ten of its twelve hops went
// to stacks call one had written off; with the ledger kept it took 14 s, hopped
// only to the three call one never reached and one stack of new spill, and
// ended «обошёл всё».
//
// Per bot, so a reconnect — new entity ids, new world view — starts clean. An
// entry dies when its stack is gone, when the stack is no longer in the cell it
// was written off in (it slid or fell, so the way to it is a different one), or
// after two minutes: a couple of brain turns, enough for «позови ещё раз» and
// short enough that a way opened by hand in the meantime gets its second hop.
// Two minutes is counted from the end of the call that wrote it off and is not
// renewed by a call that merely skipped it, so a chain of repeats retries each
// stack at most once per window.
const WRITTEN_OFF_MS = 120000
const writtenOff = new WeakMap()
function ledgerOf (bot) {
  let m = writtenOff.get(bot)
  if (!m) { m = new Map(); writtenOff.set(bot, m) }
  return m
}

// Same test handover.lyingAround uses, for the same reason: observe prints a
// dropped stack as «Item», and a module that only asks for name === 'item'
// would not see what the scene sees in the same run.
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
  // and whether the body is going anywhere. The alternative — waiting for goto
  // to say something — is the hang.
  const watch = new Promise(resolve => {
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
  // path_update whose path is empty, and asks that before it asks for 'noPath'
  // — so «no way there» can come back as success with the body where it was.
  // The distance decides; two blocks is GoalNear's box (block cells within one)
  // measured from the stack's real position.
  const walk = bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1))
    .then(() => (e.isValid === false ? 'взял' : gap() <= 2 ? 'дошёл' : 'нет пути'),
      err => `нет пути${err && err.message ? ': ' + err.message : ''}`)
  const how = await Promise.race([walk, watch])
  gameClock.clearInterval(tick)
  // Always, whoever won. A goto that lost the race is still steering; one that
  // «resolved» on an empty path leaves its goal set, and pathfinder re-plans a
  // live goal on the next block update — the body would walk off after a stack
  // this call has already written off. `walk` swallows the GoalChanged.
  try { bot.pathfinder.setGoal(null) } catch {}
  return how
}

// Only stacks that were already lying here when the sweep began. Anything that
// appears later is spill from our own digging — pathfinder with a pickaxe
// breaks blocks on the way to a stack — and chasing it is how one unreachable
// cobblestone turns into a chain of them.
async function sweepDrops (bot, ctl, { radius, until, tried }) {
  const out = { walked: 0, taken: 0, left: [], reached: [], ended: 'обошёл всё' }
  // The radius is measured from where the sweep began, not from the body: every
  // hop moves the body, and a stack at the edge of the pile would otherwise
  // drop out of the count between two hops — neither taken nor reported.
  const from = bot.entity.position.clone()
  const lying = () => Object.values(bot.entities)
    .filter(e => isDrop(e) && !tried.has(e.id) && e.position.distanceTo(from) <= radius)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  const pile = new Set(lying().map(e => e.id))
  for (;;) {
    if (ctl.aborted) { out.ended = 'прервано'; break }
    const waiting = lying().filter(e => pile.has(e.id))
    if (!waiting.length) break
    if (gameClock.now() >= until) { out.ended = 'срок'; out.unvisited = waiting.length; break }
    const next = waiting[0]
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
    // was not tried, so it is not written off. Back into the queue, where the
    // top of the loop counts it as unvisited — «за 8 с не дошёл» about a hop cut
    // at three seconds would be false, and a ledger entry for it would make the
    // advised repeat skip a stack nobody tried.
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

async function recoverLoot (session, ctl, { x, y, z, index = null, radius = 6, timeoutSeconds = 90, force = false, maxFallHp = 0 } = {}) {
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

  // Смерть в другом мире (worlds.js): ни шага. Pathfinder пошёл бы к тем же
  // числам здесь и доложил бы «на месте пусто», а вещи лежат по ту сторону
  // портала. Запись не трогаем: за ней ещё можно вернуться.
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

  // The oldest death records carry x and z and no y at all, and Math.round of
  // undefined is a NaN that rides all the way out into the result — where the
  // brain reads it back as a coordinate and hands it to the next tool.
  if (!Number.isFinite(target.y)) target.y = Math.floor(bot.entity.position.y)

  const died = diedAt ? Date.parse(diedAt) : NaN
  const ageSeconds = Number.isFinite(died) ? Math.round((gameClock.wall.now() - died) / 1000) : null
  const ageMinutes = ageSeconds === null ? null : Math.round(ageSeconds / 60)
  // Explicit coordinates carry no clock — a stash the brain dropped on purpose
  // is not a death — so there the despawn arithmetic has nothing to say and
  // must not pretend otherwise.
  // Куча стареет, только пока её чанк тикает (lootclock.js): берём эти
  // секунды, а не настенные часы, если они посчитаны.
  const ticked = slot !== null && deaths[slot] && typeof deaths[slot].ticking === 'number' ? deaths[slot].ticking : null
  const leftSeconds = ageSeconds === null ? null : DESPAWN_MINUTES * 60 - (ticked ?? ageSeconds)

  const budgetSeconds = Math.max(15, Math.min(280, Number(timeoutSeconds) || 90))
  const deadline = gameClock.now() + budgetSeconds * 1000
  // Same reason clampDepth guards against null: a null radius sails through the
  // default and turns every `distanceTo <= radius` into false, so the bot walks
  // to the pile and picks up nothing at all.
  const reach = Math.max(1, Math.min(24, Math.round(Number(radius)) || 6))
  const before = countItems(bot)
  const away = () => Math.round(Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z))

  // A loot run no longer stops on `damage` (session.js), and it must not: this
  // action now digs, and one point of chip damage was throwing away the whole
  // descent the way one falling gravel block used to end a twenty-four-step
  // dig_down. So it watches its own health instead, on the same threshold
  // surface and dig_down use. low_health at 8 still interrupts from outside;
  // this is the floor under that.
  const hurt = () => Math.round(bot.health ?? 20) < 6

  // Cost the whole trip before taking a single step. Walking two hundred
  // blocks to report «не дошёл» tells the brain nothing it can act on, and a
  // death at the diamond layer is not a walk at all — it is a walk plus a
  // second descent, and the pile has five minutes.
  const feetNow = bot.entity.position.floored()
  const plan = descentPlan(feetNow, target)
  const walkBlocks = Math.round(Math.hypot(feetNow.x - plan.from.x, feetNow.z - plan.from.z))
  const walkSeconds = Math.round(walkBlocks / BLOCKS_PER_SECOND)
  const digSeconds = plan.down >= 2 ? plan.down * SECONDS_PER_LEVEL : 0
  const etaSeconds = walkSeconds + digSeconds
  const road = { walk: walkBlocks, down: plan.down, walkSeconds, digSeconds, etaSeconds, leftSeconds }
  const picks = toolBudget(bot, 'pickaxe')

  const refuse = (why) => {
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

  if (force !== true) {
    if (leftSeconds !== null && leftSeconds <= 0) {
      // Not a guess: the five minutes are up. Write the death off so the next
      // argument-less call picks a different one instead of walking to the same
      // empty floor forever.
      if (slot !== null) {
        session.journal.patch(s => {
          const d = s.deaths[slot]
          if (d) { d.recovered = true; d.lost = 'пролежало 5 минут и пропало' }
        })
      }
      return refuse(`умер ${ageMinutes} мин назад, куча тикала ${ticked ?? ageSeconds} с из ${DESPAWN_MINUTES * 60} — вещей там уже нет, списал эту смерть`)
    }
    if (plan.down >= 2 && !(picks > 0)) {
      // The usual state after a death: respawned with an empty backpack. There
      // is no point walking anywhere first.
      return refuse(`до кучи вниз ${plan.down} уровней, а кирки нет — прокопаться нечем`)
    }
    // Куча стареет, только пока её чанк тикает (lootclock.js): вдали от неё
    // часы стоят, так что считается лишь дорога внутри дистанции симуляции
    // плюс спуск. Без счёта тиков — по-старому, вся дорога.
    const tickingEta = ticked !== null
      ? Math.round(Math.min(walkBlocks, require('./lootclock').SIM * 16) / BLOCKS_PER_SECOND) + digSeconds
      : etaSeconds
    if (leftSeconds !== null && tickingEta > leftSeconds) {
      return refuse(`не успею: дорога ~${etaSeconds}с (из них у кучи ~${tickingEta}с), а вещи пропадут через ${leftSeconds}с`)
    }
    if (etaSeconds > budgetSeconds) {
      return refuse(`за ${budgetSeconds}с не успею, дорога ~${etaSeconds}с — дай timeoutSeconds побольше`)
    }
  }

  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  })

  // Keep the last twenty seconds back for the pickup itself: arriving with an
  // empty budget is the same as not arriving, and the walk will happily eat
  // everything it is given — including the digging.
  const walkUntil = Math.max(gameClock.now() + 5000, deadline - PICKUP_RESERVE_MS - digSeconds * 1000)
  const trip = await travelXZ(bot, ctl, plan.from.x, plan.from.z, { range: 2, retries: 1, deadline: walkUntil })
  const offStart = () => Math.round(Math.hypot(bot.entity.position.x - plan.from.x, bot.entity.position.z - plan.from.z))

  // Phase two: the hole. Pathfinder never goes down a hundred blocks on its own
  // — it refuses drops over four and it will not mine a shaft — so the descent
  // is dug, not walked. Digging one from the wrong place is just vandalism, so
  // it only starts if the body actually reached the head of the staircase.
  let stairs = null
  let health = null
  if (plan.down >= 2 && !ctl.aborted && hurt()) {
    // Going down a fresh staircase on four hearts is how the trip becomes the
    // second death and the second pile.
    health = `здоровья ${Math.round(bot.health ?? 20)} — вниз за вещами не полезу`
  } else if (plan.down >= 2 && !ctl.aborted && (trip.ok || offStart() <= 4)) {
    const left = Math.round((deadline - PICKUP_RESERVE_MS - gameClock.now()) / 1000)
    // The depth is read again at the head of the staircase: the plan was drawn
    // from wherever the body stood when the tool was called, and two hundred
    // blocks of terrain later that height is a different one.
    const drop = bot.entity.position.floored().y - target.y
    if (left >= 15 && drop >= 2) {
      // Timed here rather than trusted from the estimate. SECONDS_PER_LEVEL is
      // the number the whole refusal turns on and the only way it ever gets
      // better is a run reporting what a level actually cost.
      const began = gameClock.now()
      // A cave on the way down is priced the way mc_dig_down prices it and paid
      // only on the brain's word. Until 2026-09-15 this staircase took a
      // four-block drop for a point without asking anyone; now it stops there,
      // and the refusal has to name THIS call with the price — the staircase's
      // own «позови mc_dig_down» would send a sixteen-level dig past the pile.
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
  // an answer, not a short landing, and nothing below may walk on from its lip.
  // Pathfinder plans drops of up to four blocks (Movements.maxDropDown, 2.4.5's
  // default), so the leg below — and a sweep hop to a pile within `reach` of the
  // lip — would take the very four-block drop the staircase had just declined
  // without maxFallHp, and the refusal naming «mc_recover … maxFallHp=1» would
  // ride out on a body already at the pile, a point lighter. Found joining the
  // descent's price to this leg, 2026-09-15: the descent's own check ran
  // pathfinder as a no-op and could not see it.
  const ledged = !!(stairs && stairs.ledge)

  // A staircase lands short often enough to plan for it: the ground at its head
  // was not the height the plan assumed, or the leg stopped on water. The last
  // few blocks underground are the one thing pathfinder with a pickaxe is
  // genuinely good at.
  if (stairs && !ledged && !ctl.aborted && away() > 2 && gameClock.now() < deadline - 12000) {
    // Ends ten seconds before the deadline, not five: the sweep still has to
    // happen after it, and a leg that finishes exactly on the line leaves the
    // pickup — the entire point of the trip — outside the budget.
    const leg = Math.min(deadline - 10000, gameClock.now() + 12000)
    await travelXZ(bot, ctl, target.x, target.z, { range: 2, retries: 0, deadline: leg })
  }

  // Pathfinder calls a stop short of the goal a failure; for picking things up
  // off the ground, close enough to sweep is close enough. On a lip over a cave
  // it is not: four blocks off in x and four above reads as «close enough» and
  // is exactly the drop nobody paid for.
  const arrived = !ledged && (away() <= reach || (trip.ok && plan.down < 2))

  // The weapon the preflight put in hand at the door is not in hand here: the
  // staircase took the pickaxe back for every cut (digStairs -> equipBestTool),
  // and pathfinder does the same for any block on the walk. The pile is where
  // the thing that killed us stands, so the hand is re-armed at the pile —
  // the one moment it is worth a click. Required lazily: preflight pulls
  // combat and actions, and this file is itself inside that require cycle.
  const rearm = () => require('./preflight').rearm(session, ctl).catch(() => null)
  await rearm()

  // One ledger for every sweep of this call: a stack written off at the pile is
  // not chased again from a sweep hop three blocks over. The last second and a
  // half is the report's, not the pickup's.
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
    const s = await sweepDrops(bot, ctl, { radius: reach, until: deadline - 1500, tried })
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
  // over a few blocks and have to be walked over. At the bottom of a fresh
  // staircase there is nowhere to hop to, and pathfinder with a pickaxe would
  // answer every hop by tunnelling three blocks into the wall.
  if (arrived && !stairs) {
    for (const [dx, dz] of AROUND) {
      if (ctl.aborted || gameClock.now() >= deadline - 12000) break
      if (hurt()) { health = `здоровья ${Math.round(bot.health ?? 20)} — дальше по куче не хожу`; break }
      // travelXZ hands a single leg the whole remaining budget, and pathfinder
      // will spend all of it circling three blocks it cannot cross. A sweep hop
      // is worth ten seconds and not one more.
      const leg = Math.min(deadline - 6000, gameClock.now() + 8000)
      await travelXZ(bot, ctl, target.x + dx, target.z + dz, { range: 1, retries: 0, deadline: leg })
      await gather()
      guard = guard || nearestHostile(bot, 8)
    }
  }
  // Every walk of the sweep is pathfinder with a pickaxe — the hops above, and
  // the first gather at the bottom of a staircase, where the stacks lie in a
  // corridor one block wide — and a walk that cut a block took the pickaxe
  // back. So the hand is re-armed after the last of them, whichever branch ran:
  // the hand this call returns with is the one the pile's guard meets.
  await rearm()

  await sleep(500) // the last stack lands in the inventory a tick or two after the walk
  const picked = sweep.walked
  // Written off at one point of the sweep and walked over at another is taken,
  // not left: only what is still in the world goes into the report.
  const lost = sweep.left.filter(l => l.ent.isValid !== false)
  const left = lost.map(({ ent, ...record }) => record)
  // Skipped on an earlier call's word, and still there — inside this sweep's
  // radius only, so a write-off from another pile does not leak into this one.
  const skipped = carried.filter(c => c.ent.isValid !== false && c.ent.position.distanceTo(sweptFrom) <= reach)
  const unvisited = sweep.ended === 'срок' ? sweep.unvisited : 0
  // «Больше ничего не лежит» is a claim about the world, so it is read off the
  // world, now, around the body — not off the pile ledger, which only knows the
  // stacks that lay there when the sweep began, measured from where it began.
  // Spill from pathfinder's own digging, a stack that slid, one inside `reach`
  // of where the body ended but not of where it started: all lying, none in the
  // ledger. Measured offline: one cobblestone dropped two blocks from the body by
  // the first hop, and the note said «больше ничего не лежит» over it. Not
  // chased — that is how one unreachable stack becomes a chain — only named.
  // Skipped when the clock cut the pickup: the unvisited stacks are lying too,
  // and the repeat the note asks for picks up whatever is here. Stacks the note
  // names elsewhere (left, skipped) are not counted twice; stacks the sweep
  // walked onto and that stayed on the ground are a full bag, not spill.
  const known = new Set([...lost, ...skipped].map(l => l.ent.id))
  const reached = new Set(sweep.reached)
  const lyingNow = arrived && !unvisited
    ? Object.values(bot.entities)
      .filter(e => isDrop(e) && e.isValid !== false && !known.has(e.id) && e.position.distanceTo(bot.entity.position) <= reach)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    : []
  const strays = lyingNow.filter(e => !reached.has(e.id))
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

  // Stopped on a lip, the staircase's refusal is the reason — «время вышло»
  // there would send the brain to raise timeoutSeconds, while the price and the
  // call that pays it are in the staircase's own words.
  const ledgeStop = ledged ? stairs.stopped || 'лесенка встала над пещерой' : null
  const parts = []
  if (!arrived) {
    parts.push(`не дошёл (${ledged ? 'лесенка встала над пещерой' : trip.error || 'время вышло'}), до места ещё ${away()} блоков`)
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
  // hung could not say: from outside, a sweep circling one stack it cannot reach
  // and a sweep still collecting diamonds look the same until the clock runs out.
  if (cut) {
    // The repeat's road is costed from where the body stands NOW, with the same
    // arithmetic the call itself refuses by. «Я уже у кучи, ~0 с» was false
    // exactly where it mattered: the live (г2) hang left the body at 766,69,765,
    // three above a pile at y=66, and from there descentPlan answers with a new
    // three-level staircase, ~24 s. The budget covers that road — at least 15 s
    // of it when there is a staircase, because below that the call does not dig
    // one — plus a full hop cap per unvisited stack or the pickup reserve,
    // whichever is more, and never less than the budget this call just had.
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
    // question, and a single mc_goto for the first one would answer it for it.
    // Three in words; the rest carry their cells in sweep.left, and the note says
    // so, because «и ещё 8» with nothing to call is a dead end.
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
  // that the pile was gone. Saying "на месте пусто" there sends the brain off
  // to look somewhere else for loot it is literally standing on.
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

  // Written off by this call, stamped at its end. Skipped stacks keep their old
  // stamp: a call that did not try a stack does not buy it more time off.
  for (const l of lost) {
    ledger.set(l.ent.id, { cell: spot(l.ent.position.floored()), what: l.what, why: l.why, t: gameClock.now() })
  }

  const spoils = Object.entries(gained).map(([k, v]) => `${k}×${v}`).join(', ')
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
    // got its hop; «срок» — the clock ended it with `unvisited` still lying;
    // «прервано» — the session did. `left` is what was tried and is still there,
    // plus what an earlier call wrote off and this one skipped (why «списан
    // раньше», the earlier reason in `was`); `stray` is what lies within reach of
    // the body at return and was never part of the pile.
    sweep: arrived
      ? {
          ended: sweep.ended,
          walked: sweep.walked,
          taken: sweep.taken,
          left: left.length || skipped.length
            ? [...left, ...skipped.map(c => ({ what: c.rec.what, at: xyz(c.ent.position), why: 'списан раньше', was: c.rec.why }))]
            : undefined,
          unvisited: unvisited || undefined,
          stray: strays.length ? strays.map(e => ({ what: stackLabel(e), at: xyz(e.position) })) : undefined
        }
      : undefined,
    note,
    stopped: health || (arrived ? (cut || undefined) : (ledgeStop || trip.error || 'время вышло'))
  }
}

// ---------------------------------------------------------------- surface

// Getting home. dig_down and tunnel between them leave the bot a hundred and
// twenty blocks under the world at the bottom of a shaft it dug itself, and
// exitShelter is not the same job: it climbs the three blocks of its own hole
// and stops the moment the body can walk sideways.

// Everything touching a block we are about to break. Seven reads is nothing
// next to opening a wall into a lava pocket at y=-59.
const TOUCHING = [new Vec3(0, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), ...SIDES]

const spot = p => `${p.x},${p.y},${p.z}`
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

// The second place in the daemon that looks through solid stone (digDown is the
// first), and it carries the same rule: it may only ever talk us out of a
// swing, never point at anything worth having.
function hazardNear (bot, pos) {
  for (const d of TOUCHING) {
    const b = bot.blockAt(pos.plus(d))
    if (!b) continue
    if (/lava|water|bubble_column/.test(b.name)) return b
  }
  return null
}

const hazardLine = b => `${/lava/.test(b.name) ? 'лава' : 'вода'} у ${spot(b.position)} — туда не копаю`

// The sentence half, kept because every existing caller wants the sentence and
// only the climb wants the block.
function wet (bot, pos) {
  const b = hazardNear(bot, pos)
  return b ? hazardLine(b) : null
}

// Blocks that fall the moment the cell under them opens. By name and not by
// material, for the same reason autopilot keeps the same list: minecraft-data
// tags them only as mineable/shovel, which also covers soul_sand and dirt, and
// those do not fall. Это третья копия списка в демоне (autopilot.buriedBy и
// /sand|gravel/ в mining.digColumn) — свести их в общий модуль стоит, но не
// посреди этой задачи.
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

// Deeper than any natural lens (two to four blocks) — past that the number
// only has to mean "a lot".
const LOOSE_REACH = 12

// How tall a column one step can still absorb. breakAt gets six swings a cell
// and re-reads between them precisely because gravel refills the slot, so one
// or two blocks are ordinary work. Three is where the swings run out with the
// cell still full — the same wall mining.digColumn hits from the other side,
// six refusals and «колонка не кончается».
const LOOSE_LIMIT = 3

// What would come down if this cell were opened, and only when it is enough to
// matter. The cell itself counts: cutting into the bottom of a lens releases
// everything resting on it as well.
//
// Read up, never sideways. Gravel falls straight down its own column, so a lens
// one square over is somebody else's problem — the same rule autopilot's
// fallingOverhead applies on the entity side.
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

// Is there a roof over me? Nothing solid between the head and the top of the
// world. The skylight value would be one lookup instead of two hundred, but the
// mineflayer world hands back zeroes for chunks it has not lit yet, and a bot
// that believes those calls the first cave ceiling open sky.
//
// This is half of the answer and never all of it: the bottom of our own
// dig_down shaft has honest daylight twenty blocks over its floor.
function openSky (bot, feet, top) {
  for (let y = feet.y + 2; y < top; y++) {
    const b = bot.blockAt(new Vec3(feet.x, y, feet.z))
    // A cell we cannot read is not a cell we may call daylight: one section
    // overhead the server has not sent would otherwise turn the probe into a
    // yes and end the climb at the bottom of the mine.
    if (!b) return false
    // A canopy is not a ceiling. Leaves are a full block to the physics engine,
    // so a bot that respawns in a forest reads the tree it is standing under as
    // roof and starts cutting a staircase up through it.
    if (/_leaves$/.test(b.name)) continue
    if (b.boundingBox === 'block') return false
    if (/water|lava/.test(b.name)) return false // a ceiling of ocean is not sky either
  }
  return true
}

// ------------------------------------------------- am I still in the hole

// How far the body has to get from where it stands before the place stops
// being a hole. Five is one more than the widest excavation the daemon makes
// for itself — a dig_down shaft and a tunnel are one block wide, a shelter
// niche is one square — so anything that answers "five" is terrain rather than
// our own digging.
const PIT_REACH = 5

// A walking body climbs one block by itself. Two is a wall it has to build
// against, which is the definition of being below the floor around you.
const STEP_UP = 1

// The heights a body can move between in one square, best first: level ground
// before a step up, a step up before a drop. Four down is where falling starts
// costing health (README), so three is the deepest we call "a way out".
const STEPS = [0, STEP_UP, -1, -2, -3]

// March outward one square at a time on the rules a walking body obeys.
// Answers both halves of "стою ли я ещё в колодце": walled in at head height
// comes back as dist 0, and a floor that sits above my own feet comes back as
// a rise the body cannot step.
function walkAway (bot, feet, dir, reach = PIT_REACH) {
  let y = feet.y
  for (let d = 1; d <= reach; d++) {
    let stepped = false
    for (const dy of STEPS) {
      // A step up needs headroom over the square being LEFT, not only over the
      // one being entered: in a corridor two blocks high the body walks into
      // the lip and stays where it was. Same three blocks stairStep cuts.
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

// The question mc_surface actually has to answer, and the one it used to get
// wrong: not "is there sky above me" but "am I still down a hole". Measured on
// the diamond run — the bot stood on flat ground under open sky and spent a
// whole intent trying to pillar two blocks into the air, because the only way
// it could tell "outside" from "shaft bottom" was a targetY the brain guessed.
// Two different facts, and the bot needs both. `free` is mobility: can a
// walking body get away from this square at all — the question build.js asks
// before it lets pathfinder plan, and there a way DOWN counts, because walking
// down one's own staircase is a perfectly good way to leave a hole.
//
// `out` is the surface, and it is stricter on exactly that point: a ray running
// back down the staircase we just cut used to satisfy «ушёл на пять блоков», so
// the deeper the staircase got the easier it became to call the middle of it
// daylight — measured, the climb declared itself finished at y=74 of an
// eighty-block plate, and before that at 78 and 79. Two conditions fix it: the
// route may not gain or lose more than a step over its whole length, and the
// square it ends on has to be under open sky itself. The second one alone
// closes the original shaft-and-drift shape, where the body stands under its
// own daylight at y=-29 with a level tunnel running off into solid rock.
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

// Measured in the arena scene: 23 levels of staircase inside a 120-second call,
// in plain stone. Deepslate is slower, so as an estimate of what one leg can
// spend this errs high — and erring high is the safe side of a tool check.
const SECONDS_PER_CLIMB_LEVEL = 5

// «1 уровней» is where a human stops reading the sentence the number is in.
function levelWord (n) {
  const t = n % 10
  const h = n % 100
  if (t === 1 && h !== 11) return 'уровень'
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return 'уровня'
  return 'уровней'
}

// Levels one call can realistically deliver: never more than the climb has
// left, never less than one, and otherwise whatever the clock allows.
function legLevels (deadline, wantY, y) {
  const byClock = Math.max(1, Math.floor(Math.max(0, deadline - gameClock.now()) / 1000 / SECONDS_PER_CLIMB_LEVEL))
  // No targetY means the depth is unknown, and guessing it high here would
  // stop a three-block climb to craft a pickaxe it does not need.
  if (wantY === null) return 1
  return Math.min(Math.max(0, wantY - y), byClock)
}

// How far out the climb looks for eyes. Six was a contact number for a
// decision that is made at range, and both threats said so on the arena:
//   * a walker covers a block every quarter second (combat.js), and one step of
//     staircase is three cells of deepslate — four to eight seconds. So it
//     crosses the whole six-block radius inside a single step: case (з) went
//     from «никого не вижу» to eight hits taken without the loop ever getting
//     its turn back.
//   * an archer does not have to come at all. try-corridor run 3 measured the
//     wall against a skeleton ten blocks down a drift, which is four blocks
//     outside what this used to look at.
// Twelve is the walker's six seconds of warning and the archer's measured
// range, and the wall it buys costs two blocks and 0.1 s — measured on this
// same scene, case (ж).
const MOB_WATCH = 12

// Whose eyes are actually on us. nearestHostile answers a different question —
// the nearest hostile, seen or not — and underground the nearest one is
// routinely on the far side of the wall the bot has just built for exactly
// that purpose. Measured: the bot sealed itself off from a skeleton at y=-51,
// tunnel reported «между нами сплошная порода — стою за ней», combat reported
// «я в норе, ко мне не пройти», and the climb refused to move because the same
// skeleton was five blocks away. Three modules agreeing the mob cannot reach
// us, and all three standing still.
//
// Line of sight is the honest question for an archer — no line, no arrow — and
// for anything that walks it is the cheapest true statement available: there is
// rock in the way. What makes that safe here rather than optimistic is that the
// climb asks again on every level, and a staircase opens rock as it goes: the
// step that exposes us is the step this stops on.
// `skip` is how the climb hands back what it already dealt with: a mob behind
// a wall this call built is not a reason to stop again on the next level.
//
// The nearest one is what the caller acts on; `seen` on it is how many there
// are, and that number is not decoration. combat measured the cost of standing
// and fighting — one contact ≈ 2 hp, two ≈ 7, three ≈ 14, four kills — and a
// climb that knows «zombie» but not «три зомби» hands the brain a fight it
// priced as one.
//
// The early-out on `dist >= near.dist` is gone on purpose, and it is the whole
// cost of the count: one raycast per hostile inside the radius instead of one
// per candidate closer than the best so far. Underground that is nought to
// four rays a call, against three cells of deepslate per level.
function seenBy (bot, radius = 6, skip = null) {
  const me = bot.entity.position
  let near = null
  let seen = 0
  for (const e of Object.values(bot.entities)) {
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

// ------------------------------------------------- closing the mob out

// The point on a mob that either has a clear line to us or does not. combat and
// mining each keep a private copy of this three-liner; a third one here is
// cheaper than widening combat's exports for it.
function threatEye (e) {
  return e && e.position ? e.position.offset(0, (e.height || 1.8) * 0.85, 0) : null
}

// Below this the raycast stops being evidence. raySees() forgives 1.2 blocks
// around the target — deliberately, so that a mob standing inside a block is
// not hidden by its own floor — and our wall goes up one block away, where the
// ray stops about 1.07 from the eye. The test it then applies is
// «hit >= dist - 1.2», so any mob closer than about 2.3 reads as visible
// through a solid column. A zombie pressed against the far side of a wall we
// just built sits at exactly 2.0. Past 2.5 there is no room for the slack to
// be the wall, and the ray is worth believing again.
const NEAR_SLACK = 2.5

// Is this mob out of the picture because of a wall we built? No line of sight
// is the honest answer and it is checked first. The second half only exists
// for the near case above, and there the block read wins over the ray: three
// cells of solid rock between us, and the mob still on the far side of them.
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

// Behind a wall is past its plane AND in its own row. The plane alone was
// enough while every wall stood in a drift, where the side walls keep the mob
// in the wall's row anyway; a screen stands in the open, and a skeleton
// stepping round it passes the diagonal squares — past the plane, 1.4 blocks
// from us, with a clear line — which the plane test called «behind the wall»
// and the ray slack above could not contradict.
function behindWall (bot, wall, e) {
  const me = bot.entity.position
  const inRow = wall.step.dx
    ? Math.floor(e.position.z) === wall.cell.z
    : Math.floor(e.position.x) === wall.cell.x
  return inRow && (e.position.x - me.x) * wall.step.dx + (e.position.z - me.z) * wall.step.dz > 0
}

// What one call may spend on walls, counted both ways because either alone
// lies. A drift wall is two blocks and a screen is two or four, so four walls
// is between eight and sixteen — and it is the blocks that matter, not the
// number of attempts. Ten is one leg of the climb, cheap next to the ~4 swings
// a level the staircase costs anyway; past that the walls are not closing
// anything and the bot is emptying the bag standing still.
const WALL_LIMIT = 4
const WALL_BLOCKS = 10

// Nearer than this and there is no wall to build: the mob's own body is in the
// square the block would go into, and the server answers a placement inside a
// living entity with a full timeout on every one of six faces — up to 7 s of
// standing still being hit. Measured the other way too: case (ж) sealed with
// the skeleton at 3 blocks in 0.1 s, so the line is contact, not distance.
// combat's SEAL_GAP of 5 is a different question — it guards a retreat that
// has to give the mob up entirely.
const CONTACT = 2.5

// Everything one wall may spend, from the first block to the verdict. Case (ж)
// measured what not having this costs: two shapes, two cells each, up to three
// usable faces per cell and a 1200 ms leash on every one — fourteen seconds of
// standing still under arrows, six hp, and not one block placed. A wall that
// works costs 0.1 s: case (з) put two blocks down in that, and so did the
// skeleton run before it. So past a couple of seconds this is not a slow wall,
// it is a wall that is not going to happen, and the answer is a different one.
const WALL_BUDGET_MS = 2500

// Place one cell, then ask the world instead of the return value.
//
// «ответа от сервера нет» is build.withTimeout's default message and it is our
// own leash, not the server's answer — checked in mineflayer 4.37.1:
// placeBlock() sends the packet and then waits up to 5000 ms for
// `blockUpdate:${dest}`, and only after that does it throw its own «No block
// has been placed». We cut it off at 1200. So the sentence the run reported
// means «я перестал слушать», and the two possibilities behind it want
// opposite answers: a block that lands late is a wall we already have, and a
// cell that is still air after the dust settles is a refusal we must stop
// paying for. One block read buys that distinction, and it puts the answer in
// the report so the next run says which of the two it was.
async function putBlock (bot, at, leftMs) {
  // A third of what is left, because build.placeBlockAt spends this leash on
  // every usable face of the cell — in a drift that is three — and the budget
  // has to survive the cell, not one attempt at it. Case (з) landed a block in
  // 50 ms, so 300 is still six times what the happy path needs.
  const leash = Math.max(300, Math.min(1200, Math.floor(leftMs / 3)))
  const r = await placeBlockAt(bot, at, { timeoutMs: leash })
  if (r.ok) return { ok: true }
  await sleep(200) // the packet may still be in the air when the leash expires
  const now = bot.blockAt(at)
  if (now && now.boundingBox === 'block') return { ok: true, late: true }
  return { ok: false, why: r.reason }
}

// A column of blocks in one square, bottom up, bounded by the clock.
//
// This used to be combat.sealCorridor and mostly still is — same cells, same
// order, same entity check. What it cannot be is a call with no bound: the
// leash inside it is fixed at 1200 ms per face, and there is no argument that
// makes a refused column cost less than seven seconds. Under arrows that is
// the whole difference between a move and a mistake.
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

// Finish a wall record the same way for every shape, so the report and
// shutOut() see one thing and not two.
function wallRecord (bot, wall, mob, built, began) {
  // Which cells actually ended up solid, so that «стена стоит» later means the
  // same thing it meant when it was built. A screen whose lower cell was
  // refused still cuts the line; reporting it as fallen because that gap is
  // still there would raise the wrong alarm.
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

// Fill the cell of drift between us and it. The cheap case, and the only one
// that also closes the corridor rather than just the line: two blocks, and on
// the arena it took 0.1 s.
async function sealDrift (session, ctl, mob, shape, deadline) {
  const bot = session.bot
  const cell = bot.entity.position.floored().offset(shape.step.dx, 0, shape.step.dz)
  const began = gameClock.now()
  const built = await buildColumn(bot, cell, shape.headroom, deadline)
  const wall = { cell, height: shape.headroom, step: shape.step, who: mob.who.name, id: mob.who.id, kind: 'штрек' }
  // Solid is not the same as safe — mining.sealOff learned this the same way:
  // a wall the mob is merely standing beside closes the corridor and not the
  // line, and reporting «закрылся» over that is how the next level walks into
  // an arrow. The caller falls through to the screen when this fails, because
  // a line the corridor does not cover is exactly what the screen covers.
  if (!shutOut(bot, wall, mob.who)) {
    return { ok: false, built, why: `стена в штреке не закрыла его (${built.placed} бл. из ${shape.headroom})${built.why.length ? ': ' + built.why.join('; ') : ', он не по оси'}` }
  }
  return wallRecord(bot, wall, mob, built, began)
}

// Not a drift: a staircase, a cave mouth, the middle of a room. Nothing to
// fill, so the block goes where the line goes — one cell toward it, at our own
// feet and at our own head.
//
// This is the move the first arena run was missing, and the run says why. The
// drift wall was built at y=-50 and it was perfect there: two blocks, 0.1 s,
// zero damage. Then the climb rose two levels and looked over it — not because
// the wall fell, but because a staircase cuts feet+2 and ahead+2 on every
// step, so it opens the roof of the drift as it goes. seenBy's own comment
// promised this ("a staircase opens rock as it goes: the step that exposes us
// is the step this stops on"); what was missing is that the step which exposes
// us is also a step where corridorShape says «стен с обеих сторон нет», and
// the only answer on offer was a refusal. The body ended safe and stuck at
// y=-48 — the same dead end as -51, two blocks higher.
//
// Two cells out, not one, and the second one is why this is not just combat's
// raiseWall inlined: on the second arena run the near cell would not take a
// block at all under fire, and a line can be cut anywhere along its length. The
// far cell is a different square with different neighbours to lean on, and
// trying it costs one placement window that the budget already accounts for.
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
    // lower one is what stops a walker climbing the staircase we just cut and
    // the upper one is what stops the arrow — one without the other is half a
    // move at full price.
    if (shutOut(bot, wall, mob.who)) return wallRecord(bot, wall, mob, total, began)
  }
  return { ok: false, built: total, cell: last && last.cell, why: `заслон не закрыл его (${total.placed} бл.)${total.why.length ? ': ' + total.why.join('; ') : ''}` }
}

// Hostile by type is not the same as dangerous now, and the climb has been
// paying the difference. Measured on the поход: the climb reached y=-42 alive
// and stopped for an enderman ten blocks away; the refusal sent the brain to
// mc_fight, and that call spent 45.3 seconds, swung zero times, left the target
// alive and took zero damage. An enderman teleports out of every swing and had
// never attacked in the first place — so the refusal named a tool that could
// not answer it, which is a dead end with extra steps.
//
// Worse, it is a dead end we walk into ourselves. Nothing in the climb ever
// looks at a mob: seenBy and canSeePoint are raycasts, and stepUpInto, breakAt
// and placeBlockAt all aim at blocks. The only lookAt in the daemon that aims
// at a body is combat's (holdTheLine and fight). So the refusal is the one
// thing that puts the crosshair on the creature that turns hostile when looked
// at — and «убей его» is the sentence that pulls the trigger.
//
// Three ways to be dangerous right now, and any one is enough:
//   * close enough to touch us — inside CONTACT, the same line the wall uses,
//     AND able to get at us from there (reach.reachOf): a walker within one
//     step, and anything whose way in is not a path at all — a warden or vex
//     through the rock, a phantom through the air, a search that could not
//     finish while the mob sees us;
//   * it hurts from range by type, so waiting for the first arrow is the cost
//     of finding out, and combat.RANGED is the list that already says which —
//     but only with a clear line to us: an archer under the floor has no arrow;
//   * something actually hit us inside combat's attacker TTL (20 s) — the
//     hardest fact available, and the one an enderman standing about fails.
// Everything else is scenery, and scenery gets reported, not obeyed.
// The first two were a radius and a type, blind to rock the same way mining's
// guard was: at y=1 over a cave (run-surface-diamond.log 252-257) a zombie three
// blocks straight down through the floor stopped the drift and the errand.
//
// Asked only AFTER the wall has failed, never instead of it. A zombie at ten
// blocks has hit nobody yet either, and walling it there costs two blocks
// while meeting it at CONTACT costs the fight — so the cheap move goes first
// and this only decides what to do when the cheap move is unavailable.
function dangerousNow (session, mob) {
  const r = reachOf(session.bot, mob.who)
  if (mob.dist <= CONTACT && r.reaches && (r.steps === null || r.steps <= 1)) return 'вплотную'
  if (RANGED.has(mob.who.name) && r.sees) return 'бьёт с дистанции'
  const hitter = liveAttacker(session)
  if (hitter) return `меня только что били (${hitter.name || 'кто-то'})`
  return null
}

// Where to fight, not merely that fighting is the move.
//
// The refusal used to name the verb and leave the room to chance, and the
// поход paid for it: the brain obeyed «убей (mc_fight)», the fight happened
// where the body stood — at the mouth of a cave — and eleven damage events
// went through fifteen points of iron and a worn shield. Two steps back down
// its own staircase the same fight is the two-hp column of combat's table,
// because a cut staircase is one square wide and only one thing can reach us
// in it. The bot knew that ground; it just never said so.
//
// `reach` is openSides(): how many of the four orthogonal cells a walker can
// stand in. That is the number the measured table is indexed by — 1 ≈ 2 hp,
// 2 ≈ 7, 3 ≈ 14, 4 kills — and not the head count, which is why a queue of
// three in a drift is still the two-hp case.
//
// The same arithmetic runs the other way, and the refusal used to miss it:
// contacts are the smaller of the two numbers, not the sides alone. One
// creature stands in one square however many are open, so a lone skeleton at
// contact in a room is the one-contact fight too — and «уведи меня в проход /
// отгороди фланги» there prices it as three and sends the brain to walk away
// from an archer, or to lay six blocks with it standing a metre off. Measured
// on try-surface (е), 2026-09-15: seen 1, reach 3, and exactly that advice.
// A creeper is left out: combat.js holds it in DO_NOT_TRADE_WITH, and
// «дерись прямо здесь» is the one sentence it must never be handed.
//
// The call carries its target wherever the creature is known. mc_fight without
// one takes the nearest hostile, which is this one only while nothing else is
// nearer — and the answer can name the right one for free.
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

// Shut the mob out, then climb behind the wall.
//
// The climb used to stop here, and stopping was right about the staircase and
// wrong about the call.
//
// Right about the staircase, and by more than the wording says. stepUpInto
// turns the body with bot.lookAt() onto the cell it is stepping into, so the
// yaw does point up the climb and the mob is behind — but the yaw is the small
// half. The large half is that a staircase is a walkable ramp by construction
// (that is the whole reason it is preferred over the pillar), so a walker
// follows us up it; and a straight one keeps a clear line down its own axis,
// so an archer keeps shooting. Climbing past a mob that can see us hands it
// both the road and the shot, for the ~4 swings a level the climb costs anyway.
//
// Wrong about the call, because the line can simply be cut, and the cost is
// two blocks. Measured in try-corridor run 3 — skeleton ten blocks down a
// drift, two blocks placed, zero damage and zero swings — and again on this
// file's own arena against a walker: 2 блока, 0.1 с, hp 20 -> 20, out.
//
// Two shapes, tried in that order, because they are not the same price: the
// drift wall closes the corridor as well as the line and cannot be walked
// round, the screen only closes the line and has to be rebuilt as we rise. And
// one clock over both of them, because the third thing a wall can be is
// refused, and that is the one that has to end quickly.
async function wallOff (session, ctl, mob) {
  const bot = session.bot
  const eye = threatEye(mob.who)
  if (!eye) return { ok: false, why: 'он пропал, пока я на него смотрел' }

  // Contact. Measured in try-corridor runs 1, 5 and 6: once a walker is on the
  // body, buying the square back costs 19 hp and places no blocks at all. The
  // climb has nothing to offer here and the fight does.
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
    const r = await sealDrift(session, ctl, mob, shape, deadline)
    if (r.ok) return r
    first = r.why
    tally(r.built)
  }
  const scr = await screenOff(session, ctl, mob, deadline)
  if (scr.ok) return scr
  tally(scr.built)
  const late = cells.late

  // The honest end of the road, and it has to name the next move rather than
  // just the failure. Two different failures, and they are not the same
  // problem: a block that landed after we stopped listening means the leash is
  // short and the wall is nearly working; a cell that stayed air means the
  // server would not take it, and against something that shoots there is
  // nothing left to build with.
  const why = first ? `${first}; и ${scr.why}` : scr.why
  // An empty backpack never got as far as a placement, so neither verdict
  // below applies to it and both would contradict what it just said.
  if (!first && !scr.built) return { ok: false, why }
  const bow = RANGED.has(mob.who.name)
  // The third verdict. Nothing placed and nothing refused, every cell counted as
  // rock already: there was no air to fill, so «клетки так и остались
  // воздухом» is false. Measured on try-diamond «наверх», 2026-09-15 — «заслон
  // не закрыл его (0 бл.)» over a zombie three blocks BELOW the floor, which a
  // horizontal screen cannot cover by construction. Whether that zombie could
  // see us at all is perception's question, not this sentence's.
  const dy = Math.floor(mob.who.position.y) - Math.floor(bot.entity.position.y)
  const above = Math.abs(dy) >= 2 ? `он на ${Math.abs(dy)} ${dy < 0 ? 'ниже' : 'выше'} меня` : null
  // The fourth verdict. Blocks went down on time and stand, and the line runs
  // past them: the mob is above, below or off the screen's row, and a column in
  // our own height closes only what stands level with us straight behind it.
  // «Клетки так и остались воздухом» there was false twice over — the blocks are
  // in the world and in the way of the walk back — and it was the sentence the
  // counter was added to prevent. Reproduced offline: skeleton on a ledge
  // 4.7 blocks off and three up, four blocks placed, «воздухом» anyway.
  // Columns rather than blocks: two per column, and the base names it.
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

// Stops that the next call from the same square with the same backpack would
// hit word for word. One call is one leg of the climb and the brain is
// supposed to keep calling, so the difference between "полезу дальше отсюда"
// and "здесь всё" has to be in the answer. Time, mobs, health and water are
// the other kind — they pass on their own.
// «сделать не из чего» is the stable half of the new no-tool line: no pickaxe
// in the bag and nothing in the bag that can become one, so the next call from
// this square swings at the same stone with the same hands. «нужен инструмент»
// stays for the exotic harvestTools lists that still answer in that shape.
// «в сторону не отойти» belongs here for the opposite reason lava does not:
// the detour is not missing, it was tried from this square and refused. And a
// mob that has line of sight on us has it on the next call too — the situation
// changes only if somebody changes it, and only the brain can.
const AGAIN_WONT_HELP = /строить нечем|нечем строить|нужен инструмент|сделать не из чего|бедрок|не поддаётся|не прогружен|не к чему прислонить|в сторону не отойти|спиной к нему/

// Подъём без кирки (surface hand:true, когда её не из чего сделать): дроп не
// нужен, нужен проход. Блок, который рука ломает за разумное время, — рукой
// (без верного инструмента делитель 100 вместо 30, BlockBehaviour.
// getDestroyProgress; mineflayer digTime считает так же): камень 7.5 с,
// глубинный сланец 15 с. Руда глубинная, обсидиан — нет. 2026-09-26 (12:59)
// тело на y=29 без кирки и дерева отвечало «stone голыми руками не
// ломается» и стояло до конца.
let handClimb = false
function handBreaks (bot, b) {
  if (!handClimb || !b) return false
  try {
    const t = b.digTime(null, false, false, false, [], bot.entity.effects)
    return Number.isFinite(t) && t <= 16000
  } catch { return false }
}

// One block, re-read every swing: gravel and sand pour into a slot the moment
// it is empty, and a swing the server quietly refuses leaves the block
// standing, so a plan made three swings ago is worth nothing.
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
  // a cell it has just opened — and calling that a refusal throws away a step
  // already paid for. Gravel needs all six swings often enough to matter.
  const left = bot.blockAt(pos)
  if (left && left.boundingBox === 'empty' && !/water|lava/.test(left.name)) return { dug }
  return { dug, reason: `${left ? left.name : 'блок'} на ${spot(pos)} не поддаётся${last ? ': ' + last.message : ''}` }
}

// One block up and one across, on manual controls — tunnel's stepInto plus the
// jump. Pathfinder re-plans the whole route for a single step and with canDig
// on it digs its own detour out of the staircase we are trying to keep
// walkable; and walking alone will not do it, the body climbs 0.6 of a block
// by itself and a step is a whole one.
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

// One step of staircase. It costs nothing but swings, it leaves a corridor we
// can walk back down, and unlike a pillar it cannot be knocked out from under
// the body by the first thing that hits us.
// guard is the climb's own eyes, handed down one level. Checking for a mob
// once per level is too coarse for anything that walks: a step is three cells
// of deepslate — four to eight seconds — and a mob covers a block every
// quarter second, so it crosses the whole watch radius inside a single step
// and the loop never gets its turn back. Measured on the arena, case (з):
// zombie summoned nine blocks down the drift, eight hits taken, hp 20 -> 7,
// and not one block placed. Three checks a step instead of one costs three
// raycasts and buys the wall its window.
async function stairStep (bot, mcData, ctl, feet, dir, deadline, guard = null) {
  const ahead = feet.plus(dir)
  const stand = ahead.offset(0, 1, 0)
  // Three blocks, not two. The body is 1.8 tall and a jump lifts it 1.25, so
  // with the ceiling still at feet+2 it rises 0.2 and goes nowhere — the block
  // over our own head has to go as well. Top down, the way tunnel cuts a
  // column: whatever is loose up there falls into the square we are still
  // standing in.
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
    // is. cells[0] is the block over our own head and cells[1] is the one that
    // becomes our head after the step: opening either under a live column puts
    // the gravel exactly where the body is going to be. Measured on the поход
    // at y=-58 — the drift refused honestly, the climb tried anyway, and the
    // answer was «прервано» after fourteen points of suffocation.
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
  // box, so it neither holds the foot nor lets a block be put in its square —
  // the same thing that stalled towerUp one block up its own shaft. Best
  // effort: if it will not come out, the placement below reports why.
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
  // one from wherever the body ended up usually lands, and both together are
  // cheaper than giving this level to the pillar.
  for (let tries = 0; tries < 2; tries++) {
    if (ctl.aborted) return { dug, reason: 'прервано' }
    if (gameClock.now() >= deadline) return { dug, reason: 'время вышло на ступеньке' }
    if (await stepUpInto(bot, ctl, stand)) return { ok: true, dug }
  }
  return { dug, reason: `не смог шагнуть на ${spot(stand)}` }
}

// How many times one call may shuffle sideways before it admits the whole area
// is lava. Four blocks clears a pocket three wide, and `wet` only looks one
// block around each cell it cuts, so four is the width of problem this move
// can actually solve.
const ASIDE_LIMIT = 4

// Sideways at the same height, when up is refused. Four bearings of staircase
// is one bearing when the thing in the way is directly overhead: the first
// cell every staircase cuts is the block over our own head, and the pillar
// goes through that same block. Measured on the fourth leg of the diamond run
// — lava at 124,-33,142 with the body at 124,-36,142 refused the pillar and
// all four staircases at once, and every later call refused identically:
// climbed 0, same lava, same sentence, with the bot alive on 19 hp and three
// pickaxes. Two swings to the side cost nothing and move the whole problem.
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
    // stepping into a hole trades a lava problem for a fall down the shaft we
    // just paid to climb.
    const floor = bot.blockAt(to.offset(0, -1, 0))
    if (!floor || floor.boundingBox !== 'block') continue

    // The square we step into has to be one the climb can actually use, and
    // that is decided one cell higher than the step: the next staircase from
    // there cuts to+2 first. Stepping out from under a lens into the next lens
    // is four blocks of walking for nothing — and a nine-wide gravel field
    // would eat all four of them before saying so.
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

// ------------------------------------------------- water in the staircase
//
// The climb used to answer water with one sentence and no move: «стою в воде —
// отсюда не поднимаюсь». Measured on the поход, 2026-09-16: the fourth leg
// stopped on it at 166,56,162 (seven blocks under sea level, sand and dirt in
// what it had just dug), the fifth answered the same with climbed 0, and the
// body drowned on that square 23 seconds after the scene gave up — server log
// «NeuroDown drowned», so the head was under, not the ankles. Nothing else
// takes a body out of water while an intent runs: autopilot's escapeWaterIfIdle
// waits for bodyBusy, and the brain calls surface again at once. So the climb
// does what a player does — shuts the water off, swims up to air, or steps out
// onto something dry — and when none of the three works, says which one the
// brain can buy it.

const isWater = b => !!b && (b.name === 'water' || b.name === 'bubble_column')

// prismarine-block keeps a fluid's level as its only property: 0 a source, 1..7
// flowing, 8 and up falling. null when the block does not say, and every caller
// reads null as «could be feeding me», the side that costs a block and not a life.
function waterLevel (b) {
  if (!isWater(b)) return null
  if (b.name === 'bubble_column') return 0 // a column is fed by a source at its foot
  try {
    const p = typeof b.getProperties === 'function' ? b.getProperties() : null
    if (p && Number.isFinite(Number(p.level))) return Number(p.level)
  } catch {}
  return Number.isFinite(b.metadata) ? b.metadata : null
}

// How hard a cell pushes water into its neighbours: a source or a falling column
// feeds anything, flowing water only what is weaker than itself.
function pushOf (b) {
  if (!isWater(b)) return -1
  const l = waterLevel(b)
  return l === null || l === 0 || l >= 8 ? 8 : 8 - l
}

// The cells that pour water into the two the body occupies. The block over the
// head feeds by falling whatever its level; a side cell only if it is a source
// or stronger than the cell beside it — the water running OUT of us down the
// staircase is ours, and a block there only shuts the way back down.
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

// A source in the body's own cell does not drain when its neighbours are shut —
// that is standing in a pool, not under a leak, and a plug there only walls the
// swim in. Measured offline in the flooded-shaft arena on this file with the
// guard taken out: the plug went over the head and a two-second swim became
// «всплыть некуда — над 1 бл. воды cobblestone».
function standingInSource (bot, feet) {
  return [feet, feet.offset(0, 1, 0)].some(c => waterLevel(bot.blockAt(c)) === 0)
}

// Water cells a swim may cross to reach air. Breath is 15 s (300 ticks); holding
// jump lifts a body about two blocks a second in still water and less under a
// falling column, so eight is four to eight seconds of the fifteen and leaves the
// rest for the step out at the top. Deeper than that is a drowning, not a route.
const SWIM_REACH = 8
const SWIM_MS_PER_BLOCK = 900

// Straight up from the head: the first breathable cell, or what stops the swim.
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

// A square beside me with dry feet, dry head and a floor, level or one up — the
// most a body leaves water by. One up needs the cell over my own head open, the
// same headroom stairStep cuts for a jump.
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

// Every face the server refuses costs the whole timeout, and with the head under
// water those seconds are breath. The underside of the block over the head is
// the likeliest refusal: try-diamond saw it refused once in one attempt.
const PLUG_MS = 1200

// Flowing water leaves one block per five ticks once its source is shut, and the
// body's own column is two blocks of it.
const DRAIN_MS = 2000

// Water moves in a row without a level gained. Each one that works either dries
// the body or changes the square it stands in; a fifth is the same water giving
// the same answer, and the breath is better spent on the brain's move.
const WET_LIMIT = 4

const eyeWet = bot => isWater(bot.blockAt(bot.entity.position.offset(0, 1.62, 0)))

// One move out of water, cheapest first. Returns ok when the body is dry or on a
// new square; otherwise the sentences of what was tried, for the stop.
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
          // keeps rising until only its ankles are under, and the ledge beside a
          // flooded shaft is one over the WATER, not over the eyes. Measured
          // offline in the swim arena: stopping at the eyes left the feet a cell
          // short and the ledge two up — «выйти не на что» beside a dry floor.
          // So keep holding and look for the step as the body comes up, until it
          // is found or the rise stalls. Letting go anywhere here sinks the body
          // straight back under, so the step has to come from inside the swim.
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

// The one move the brain can make for a body that cannot get out by itself. The
// nearest dry square is a coordinate mc_goto takes as it is — travelXZ swims out
// of water before it plans — and a bag with no block is the one thing a plug
// needs that the brain can bring.
function waterNext (bot, tried = []) {
  const land = findNearestLand(bot, 24)
  if (land) return `ближайшее сухое место ${spot(land)} — уведи меня туда mc_goto x=${land.x} y=${land.y} z=${land.z} и зови подъём оттуда`
  if (!pickFiller(bot)) return 'сухого места в 24 бл. нет — дай мне блоков (mc_chest_take, или mc_mine block=stone_like count=4), заткну воду и полезу'
  // With blocks in the bag the bag is not what is missing, and «затыкать нечего»
  // is true of exactly one of the four ways out of outOfWater — the one where
  // nothing was pouring in. Over a refused plug, or a plug that went in and left
  // the water standing, it is a second diagnosis laid on top of the real one,
  // which is in the same sentence two clauses back.
  return 'доступного берега не найдено — нужен другой путь: открыть видимый блок к воздуху или сделать воздушный карман; невозможность самостоятельного выхода не доказана'
}

// The stop when no move works, and it must name a move the brain can make.
function waterStop (bot, tried) {
  const feet = bot.entity.position.floored()
  return `в воде на ${spot(feet)}${eyeWet(bot) ? ', голова под водой' : ''}: ${tried.join('; ')} — из воды сам не выбраться; ${waterNext(bot, tried)}`
}

// Climb out from wherever we are. One call is one leg of the climb, the way
// explore is one leg of a search: eighty blocks and a `stopped` is a good
// answer, the brain just calls it again.
// hand:true — копать рукой то, что рука ломает (handBreaks), когда кирки нет.
async function surface (session, ctl, p = {}) {
  handClimb = !!p.hand
  try { return await surfaceBody(session, ctl, p) } finally { handClimb = false }
}

async function surfaceBody (session, ctl, { targetY = null, timeoutSeconds = 240, preferPillar = false } = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const top = worldTop(bot)
  // The same trap clampDepth guards against: the brain fills optional JSON
  // fields with null far more often than it leaves them out, and Number(null)
  // is a very quiet 0 — which from a mine at y=-59 reads as "climb to sea
  // level" and stops sixty blocks short of the daylight that was asked for.
  const wantY = targetY === null || targetY === undefined ? null : Math.round(Number(targetY))
  if (wantY !== null && !Number.isFinite(wantY)) throw new Error(`это не высота: ${targetY}`)
  const budgetSeconds = Math.max(10, Math.min(600, Math.round(Number(timeoutSeconds)) || 240))
  const deadline = gameClock.now() + budgetSeconds * 1000

  const from = xyz(bot.entity.position)
  const startY = bot.entity.position.y
  const before = countItems(bot)
  // Out of the hole ends the climb whatever targetY said. The brain passes
  // targetY as its best guess of the height it set out from — a floor, not a
  // contract — and the guess is routinely a block or two above the ground it
  // is standing on. Measured on the diamond run: respawned on flat grass at
  // y=80, asked for 81, and burned the whole intent failing to pillar into
  // open air with an empty backpack. Below ground the two agree anyway.
  const arrived = () => {
    const feet = bot.entity.position.floored()
    if (pitCheck(bot, feet, top).out) return true
    // Небо над головой и не меньше двух открытых сторон (пусто и на уровне ног,
    // и на уровне головы) — это уже не яма, даже если пяти шагов по ровному тут
    // нет. На узком крутом пике pitCheck.out не бывает никогда (отовсюду обрыв
    // больше ступеньки), и подъём продолжал столбом в небо: кампания 2026-09-26
    // «поднялся на 229» — с y=91 до потолка мира, 3 блока земли на y=316.
    // В колодце и в лестничном ходе стороны — стены, сюда они не проходят.
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
  // level that made them: the wall is what lets every later level ignore the
  // mob behind it, and the bearing is the one the staircase must never cut.
  const walls = []
  let noGo = null

  // Every mob this call had to answer for, and what the answer was. walls says
  // what got built; this says what was *seen*, and that is the half that was
  // missing when a climb past a skeleton could not be told apart from a climb
  // that never noticed one. Two readings of the same answer wanting opposite
  // fixes is a reporting bug, not a doctrine question.
  const met = []

  // The cells the body stood in before each successful step, newest last. Four
  // is enough: the only question ever asked of it is «где было на две ступеньки
  // ниже», and a staircase two steps back is a coordinate the brain can walk to.
  const trail = []

  // Ids of creatures this call looked at, could not wall off, and walked past
  // because they were doing nothing to us. Kept so the next level does not pay
  // the failed wall a second time — and re-checked on every look, not trusted:
  // the moment one of them can touch us, hits us, or gets a line to shoot
  // along, it stops being scenery in the middle of the same call. Decided by
  // the same dangerousNow that let it pass, so nothing is scenery by one test
  // and a threat by another; asked only for ids already passed, so the path
  // search behind it runs for a handful of mobs at most.
  const passed = new Set()
  const stillScenery = (e) => {
    if (!passed.has(e.id)) return false
    return !dangerousNow(session, { who: e, dist: e.position.distanceTo(bot.entity.position) })
  }

  // One question, asked from three places: the top of the level, between the
  // cells of a step, and after a step that dropped out because of it. A mob
  // already shut out by one of our own walls is not an answer to it.
  const watch = () => seenBy(bot, MOB_WATCH,
    e => stillScenery(e) || walls.some(w => shutOut(bot, w, e)))

  // The screen that the creature which stopped this call walked round, if it
  // did. The note needs it: «стену тут не поставить» is the wrong advice about a
  // wall that is standing.
  let outflanked = null
  // The same mistake the other way round: blocks of the failed wall that went
  // down and stand, but do not cut the line. «Стену поставить не могу» is false
  // about them too; «второй заход поставит то же» is what is true.
  let standingUseless = null

  // Everything that happens when the watch answers. Lives out here because the
  // two places that ask are inside two different loops, and the state it sets
  // — the bearing the wall stands on, the list for the report — outlives both.
  // Returns false when the climb is over.
  const dealWith = async (mob) => {
    // Two numbers, and the second is the one that decides. combat measured the
    // cost of standing and fighting by CONTACT count, not by head count, so a
    // report that says «зомби 3» and nothing else would send the brain running
    // from a queue a corridor has already reduced to one.
    const seen = {
      who: mob.who.name,
      dist: Math.round(mob.dist),
      y: Math.floor(bot.entity.position.y),
      seen: mob.seen || 1,
      reach: openSides(bot, 2).length
    }
    met.push(seen)
    const spent = walls.reduce((n, w) => n + w.blocks, 0)
    const wall = walls.length >= WALL_LIMIT || spent >= WALL_BLOCKS
      ? { ok: false, why: `за этот вызов я уже поставил ${walls.length} стены (${spent} бл.), а он всё равно меня видит — дальше это просто пустой рюкзак` }
      : await wallOff(session, ctl, mob)
    // A wall that did not close the line is still blocks in the world — on the
    // way the brain will walk back down — and `walls` lists only the ones that
    // closed it. So they ride on the sighting that paid for them.
    if (!wall.ok && wall.placed) seen.built = { blocks: wall.placed, at: wall.cells.map(xyz) }
    if (!wall.ok) {
      // The wall is gone as an option; now the question is whether this thing
      // is worth stopping for at all. See dangerousNow(): an enderman that has
      // not touched us is scenery, and standing in front of it is how the
      // поход ended — 45 seconds, zero swings, zero damage, and no climb.
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
      // run of guessing: on the поход a zombie at four blocks on a staircase
      // that corridorShape reads as a drift should have taken a wall, and there
      // was no way to tell an empty backpack from a misread shape.
      //
      // One reason the wall itself cannot know: this is the creature a screen of
      // this call was built against, and it is now at us from outside that
      // screen's row. It walked round. Vanilla's RangedBowAttackGoal answers a
      // lost line by pathing straight at the target, so in an open room a
      // one-wide screen buys the few steps round its edge and no more. Measured
      // on try-surface (е), 2026-09-15: screen in 0 s, the first swing right
      // after it, and the same skeleton at 1 block before the third cell of that
      // one step — about two swings, against a step that also needs a floor
      // block and a jump. No order of the same moves wins that, so it is a
      // fight, and the answer has to say so. It used to say «сам я тут стену
      // поставить не могу» next to «закрылся заслоном», and both were wrong: the
      // wall stood, the room is what made it useless.
      const round = walls.find(w => w.id === mob.who.id && /заслон/.test(w.kind) && !behindWall(bot, w, mob.who))
      if (round) outflanked = round
      if (seen.built) standingUseless = seen.built
      // «Вокруг открыто» only where it is: once the climb is on its own
      // staircase the sides are rock (reach 0 or 1 offline in the slow-archer
      // arena), and the walk-round is then the screen closing a line and not a
      // road — which is true in both places.
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
    // first swing of the next level would take our own wall back out. That
    // bearing is off the list until the next wall replaces it, and the one
    // straight away from it goes to the front, because every step that way
    // puts another metre of rock between the line of fire and us.
    noGo = new Vec3(wall.wall.step.dx, 0, wall.wall.step.dz)
    if (dir && dir.equals(noGo)) dir = null
    return true
  }

  // The tool refusal has to reach the note: it is not AGAIN_WONT_HELP (a craft
  // makes the very same call work) but repeating the call unchanged is exactly
  // as useless, and the default note promises the opposite.
  let worn = null

  // What the water cost this call, for the answer: moves made, cells plugged
  // (blocks now standing in the staircase the brain walks back down) and blocks
  // swum up.
  let wetMoves = 0
  // Moves since the last level gained. The limit is on these: a long climb that
  // cuts into three separate leaks and shuts each one has not been refused once.
  let wetRun = 0
  const plugs = []
  let swum = 0

  // The world is 384 blocks tall. Past that this is not a climb any more, it is
  // a loop that has stopped gaining height.
  //
  // And `|| inWater(bot)` because arriving is not the same as surviving. targetY is
  // the brain's guess at the height it started from, and a guess lands inside a
  // flooded pocket as easily as anywhere: with the plain `!arrived()` such a call
  // returns without a single move, leaving the body under water on the timer
  // that killed it in the поход. Bounded — every wet pass either dries the body,
  // and then arrived() ends the loop on the next turn, or spends one of WET_LIMIT.
  for (let level = 0; level < 400 && (!arrived() || inWater(bot)); level++) {
    if (ctl.aborted) { stopped = 'прервано'; break }
    if (gameClock.now() >= deadline) { stopped = 'время вышло'; break }

    // Ahead of health, ahead of the pickaxe and ahead of the mob — and this
    // order is the whole of the fix. Measured: on the поход the body stopped in
    // water at hp 8, drowning takes 2 hp a second, and the health gate below
    // answers under 6 with exactly the sentence and exactly the note the fifth
    // leg died on — without one move. None of the three moves here needs a
    // pickaxe or a hit point: a plug is a block out of the bag, a swim is a held
    // jump, a step aside is a walk. Reproduced offline on the flooded arena with
    // hp set to 5: the call returned in 0.0 s, water undefined, and the body
    // drowned 2 hp over the next twenty seconds with nobody coming for it.
    //
    // Going ahead of the mob does not weaken that doctrine: it forbids turning a
    // back to DIG a staircase, and nothing here digs. A wet pass that works ends
    // in `continue`, which meets watch() again before the next swing.
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
    // ≥ 18 (FoodData.tick) или есть что съесть. Лечиться нечем — еда наверху,
    // и отказ подниматься запирал тело внизу навсегда: 2026-09-26 (09:28) 2 хп,
    // сытость 17, пустой рюкзак на дне своей лесенки — «дальше не лезу» раз за
    // разом, и этап еды не мог начаться.
    const canHeal = (bot.food ?? 20) >= 18 || !!(session.mcData && require('./actions').bestFood(bot, session.mcData))
    if (health < 6 && canHeal) { stopped = `здоровья ${health} — дальше не лезу`; break }

    // The climb is what the reserve exists for, so nothing is held back here:
    // reserve 0, and onlyIfFixable means this fires only when stopping is
    // strictly better than climbing — a replacement is craftable out of what is
    // already in the bag, and crafting costs no swings at all. At y=-58 with 33
    // swings left, eight more levels of staircase and then nothing is worse than
    // standing still and making a pickaxe out of the cobblestone already carried;
    // the autopilot does exactly that between brain turns.
    // What THIS call can spend, not what the whole climb will. One call is one
    // leg by design, and asking for the pickaxe of all hundred and forty levels
    // up front cost three brain turns and three crafts in a row on the diamond
    // run — 294, then 425, then 556 swings, none of them spent on climbing —
    // and left the bag with no planks at all, which is the one thing that
    // cannot be dug back at depth. The full remainder still goes out in the
    // answer, as a number the brain can plan the next legs with.
    const feetY = bot.entity.position.floored().y
    const legWant = legLevels(deadline, wantY, feetY)
    const column = bot.entity.position.floored()
    const fastPillar = preferPillar && !noGo && pickFiller(bot, { steady: true }) &&
      !wet(bot, column.offset(0, 2, 0)) && !wet(bot, column.offset(0, 3, 0)) &&
      !looseOver(bot, column.offset(0, 2, 0)) && !looseOver(bot, column.offset(0, 3, 0)) &&
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
      // at y=-58 with 43 swings against 163, and again at y=-59 with 76 against
      // 158 — the second time with hp 20, four drifts of ore in the bag and the
      // crafting table left on the floor forty blocks back, so the craft the
      // refusal offered could not happen and the body stayed on the bottom.
      //
      // What the bag CAN still buy is a number this loop already computes, and
      // it is the one the brain plans with. Better still, it names a call that
      // is guaranteed to be accepted: legLevels() caps the demand at wantY - y,
      // so asking for exactly this many levels makes the same check pass with
      // nothing left over. Say the number, and say the call.
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
    // трёх на ступеньку. Проверки жидкости, сыпучего и мобов уже пройдены;
    // у заслона оставляем лестницу. Не встал столб — обычный обход ступенькой.
    if (fastPillar) {
      const was = bot.entity.position.y
      const up = await digUp(bot, ctl, { blocks: 1, mcData, tower: true, guard: watch })
      dug += up.dug
      if (bot.entity.position.y - was >= 0.9) { pillar++; wetRun = 0; continue }
      if (ctl.aborted) { stopped = 'прервано'; break }
      if (gameClock.now() >= deadline) { stopped = 'время вышло'; break }
    }
    // Stick to the direction that worked last time: a staircase that changes
    // its mind every level is a spiral nobody can walk back down. Minus the
    // bearing a wall of ours stands on, and with the bearing straight away
    // from that wall promoted to first.
    let usable = SIDES
    if (noGo) {
      // Picked out of SIDES rather than negated, so every bearing in the list
      // is the same object the rest of the loop compares against — scaled(-1)
      // hands back -0 components, and identity here is worth more than brevity.
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
      // `forward` for three seconds and can leave the feet a square over;
      // cutting the next attempt from where we stood before it would put the
      // column, the filler and the jump each one block off the other.
      const step = await stairStep(bot, mcData, ctl, bot.entity.position.floored(), d, deadline, watch)
      dug += step.dug
      if (step.ok) {
        trail.push(bot.entity.position.floored().offset(-d.x, -1, -d.z))
        if (trail.length > 4) trail.shift()
        dir = d; stairs++; wetRun = 0; moved = true; break
      }
      // A step dropped because something walked into view is not a bearing that
      // failed: trying the next three would be three more staircases cut with
      // the mob closing. Deal with the mob and start the level over.
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
    // knocks the body off the one block it just placed, which is exactly why it
    // is the fallback and not the plan.
    const blocked = why.find(w => /лава|вода/.test(w)) || why.find(w => /сыплется/.test(w)) || why[0] || 'некуда'
    const feet = bot.entity.position.floored()

    // Refused up by a hazard on every bearing AND on the pillar means the block
    // in the way is over our own head, so it is this column that is finished,
    // not the climb. Step out from under it and carry on from the same height.
    // Only when the staircases named the hazard too: a column that failed for
    // want of a tool has a different answer, and it is below.
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
    // same geometry, which is why it takes the same move. The first cell every
    // staircase cuts is the block over our own head, and the pillar goes
    // through that same block — so four bearings are one bearing, and the only
    // answer is to get out from under it.
    //
    // What is NOT the same as lava: this is not a thing to avoid touching, it
    // is a thing that refills what we dig. A column of N costs N swings in one
    // cell and pours into the two beside it, and the body ends up standing
    // under the part that has not fallen yet. Measured on the поход at y=-58:
    // the drift said «колонка не кончается», the climb said «прервано», and
    // between them the body lost eleven hp to suffocation with a fresh pickaxe,
    // a full bag of blocks and no mob within sight.
    // Geometry, not wording. We are only here because all four bearings failed,
    // and a live column over our own head defeats every one of them plus the
    // pillar, whatever sentence each of them came back with — a stair step that
    // died on «не смог шагнуть» under three metres of gravel is the same
    // situation as one that named it.
    const loose = looseOver(bot, feet.offset(0, 2, 0)) || looseOver(bot, feet.offset(0, 3, 0))
    if (loose) {
      if (aside >= ASIDE_LIMIT) {
        stopped = `${looseLine(loose)}; отошёл на ${aside} и всё ещё под сыпучим — уведи меня mc_goto блоков на ${ASIDE_LIMIT + 2} в сторону и зови подъём оттуда`
        break
      }
      // Away from our own square: a column directly overhead has no direction
      // to run from, every neighbour is an improvement, and sideStep already
      // refuses the ones that are under a lens of their own.
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
  // demand: this leg being affordable and the whole climb being affordable are
  // two different questions, and the brain is the one that plans the legs.
  const swings = toolBudget(bot, 'pickaxe')
  const toTop = wantY === null ? null : Math.max(0, wantY - nowY)
  const estimate = preferPillar && pillar && !stairs ? 1 : SWINGS_PER_LEVEL
  const pickaxe = Number.isFinite(swings)
    ? {
        left: Math.round(swings),
        leg: Math.ceil(legLevels(gameClock.now() + budgetSeconds * 1000, wantY, nowY) * estimate + (estimate === 1 ? 1 : 0)),
        // Swings are what the tool has; levels are what the brain plans in.
        // The division was being done in prose in one branch of the note and
        // nowhere else, so the one number the refusal turns on never left the
        // function in machine-readable form.
        levels: Math.floor(Math.max(0, swings) / estimate),
        toTop: toTop === null ? undefined : Math.ceil(toTop * estimate)
      }
    : undefined
  if (!out && !stopped) stopped = 'подъём встал на месте'
  const climbed = Math.round(bot.entity.position.y - startY)
  const mode = stairs && pillar ? 'смешанный' : pillar ? 'столб' : 'лестница'

  let note = `поднялся на ${climbed} — позови ещё раз, полезу дальше отсюда`
  // Ahead of every other branch, «пришёл» included. Reproduced offline in a 1x1
  // shaft of sources with targetY below the top of the water: the swim itself
  // lifted the feet past targetY, arrived() went true, and the honest water stop
  // was answered by «поднялся до y=18» — while the body floated there and sank
  // four blocks back over the next twenty seconds. Height reached is not an
  // answer to a body still in the water. The same holds for a stop that is not
  // the water's own: a timeout or an interrupt in mid-swim leaves the feet wet,
  // and «позови ещё раз» is the sentence that lets the brain do nothing.
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
    // detour is what the next call hits, not the detour.
    //
    // Whether or not this call gained height first. A climb that rose two
    // levels and was then stopped by a mob with a line on us used to fall to the
    // default note — «позови ещё раз, полезу дальше отсюда» — right under a
    // `stopped` saying it would not climb with its back to that mob; the next
    // call from this square meets the same mob, which is why «спиной к нему» is
    // in AGAIN_WONT_HELP. Reproduced offline in (е) on the file before this
    // fix: climbed 2, stopped on the same skeleton, and the note promised the
    // climb.
    //
    // By the time this fires the climb has already tried the wall itself, so
    // the old advice — «отгородись (mc_place)» — is the move that just failed,
    // and repeating it is how a loop starts. What is left depends on why it
    // failed, and the two answers are different jobs.
    // A third job since the screen can be walked round: the wall went up and
    // stands, so neither «дай блоков» nor «стену не поставить» is true. And a
    // fourth, its mirror: the blocks went up and stand and miss the line.
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
    // this exact call work. What does not work is calling it again unchanged,
    // and «позови ещё раз, полезу дальше отсюда» is what the default note says.
    note = `вверх ни на блок. ${stopped}`
  } else if (!climbed && /^здоровья \d/.test(stopped || '')) {
    // The same lie as the pickaxe refusal one branch up, and now reachable where
    // it was not before: the water move runs ahead of this gate, so a body that
    // climbs out of a leak at hp 5 lands on it with climbed 0. The climb never
    // reached a swing, so «полезу дальше отсюда» promises a leg this very call
    // proved it will not walk. What lifts the gate is food, not another call.
    note = `вверх ни на блок. ${stopped} — сначала поешь (mc_eat) и дай хп вернуться (mc_wait 60); звать подъём раньше бесполезно`
  } else if (!climbed && aside) {
    // «отсюда» is a different square than the one this call started on, so
    // another call really can make progress — which is exactly what the old
    // wording promised falsely when the answer was the same lava every time.
    note = `вверх не пустило, отошёл от опасного места на ${aside} — позови ещё раз, отсюда полезу`
  } else if (!climbed && AGAIN_WONT_HELP.test(stopped || '')) {
    // The brain calls this in a loop until it gains height, so a stop that the
    // next call would hit identically has to say so out loud.
    note = here.free
      ? `не в яме — вокруг открыто, а вверх отсюда ничего не сделать (${stopped}); звать ещё раз бесполезно`
      : `не поднялся ни на блок (${stopped}); звать ещё раз с этого места бесполезно`
  }

  // What the wall is made of and where it stands, read back out of the world
  // rather than remembered: this is the same drift the brain will send the
  // body back down, and a wall it does not know about is a wall it walks into.
  // A wall that is no longer there is the louder half — it means the thing
  // behind it is loose again.
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
      // cannot be walked round; a screen closes only the line and has to be
      // rebuilt a level higher — the brain plans the way back down with them
      // differently, so the answer has to tell them apart.
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
    out: here.out,
    sky: here.sky,
    // «я больше не в яме» and «я на поверхности» are separate decisions: the
    // first says pathfinder will work from here, the second says this is a
    // place to put a bed. One flag answering both is how the climb stopped
    // halfway up its own staircase.
    pit: !here.free,
    gained: diffItems(before, countItems(bot)),
    note,
    stopped: stopped || undefined
  }
}

// pitCheck and descentPlan are the two answers here that can be checked
// without a server — one against a synthetic world, one against arithmetic —
// so they are exported to be checkable. build.js → inPit asks a cruder version
// of the first question (three walls at head height, nothing about the floor
// around them) and could be folded into this one.
// ---------------------------------------------------------------- refuge
//
// Аварийный отход (research/05-synthesis.md F.5). Пользователь 30.09: «мало
// здоровья — проанализировать пространство вокруг и быстро построить крепость,
// как в PvP, или подойти к стене и замуроваться; там спокойно поесть,
// подлечиться — и дальше по делу». Нового по механике тут нет — выбор из
// готовых способов по быстрой оценке места (refugeLook: без хода, мс):
//   box    — коробка у стены (fortify.refugeCell/refugeBox: клетка как в
//            pvp.js cellOk/fortSpot, стены вокруг — в зачёт, установка честная);
//   hole   — нора вниз на 3 с крышкой (enterShelter; в Аду — никогда);
//   pocket — тело уже в замкнутом кармане без врагов (sealed.localAir: свой
//            штрек в Аду) — строить нечего;
//   pillar — столб в 4 под себя, когда на коробку блоков мало, а враги только
//            ходячие (рука моба не растёт вверх);
//   flee   — бегство (flee.smartFlee): крипер, вода, лава, нечем строить.
// Ходячий дойдёт раньше конца стройки — сперва рывок прочь (outrun).
// Внутри — зелье, яблоко, еда до сытости, ожидание до minHp (не дольше
// maxSeconds), латание; потом выход (fortify.breakOut / exitShelter).
// Урон и low_health отход не рвут — у намерения их нет в прерываниях
// (runRefuge): укрытие не должно прерываться тем, от чего укрывает.

// Нейтральные, пока их не разозлить: в отходе за врагов не считаются (иначе
// каждый двор бастиона — «толпа»).
const REFUGE_NEUTRAL = /^(enderman|piglin|zombified_piglin)$/

// Скорость погони — «успеет ли он дойти, пока я строюсь». Не на глаз, по
// paper-1.21.11.jar (javap): Mob.setSpeed(s) ставит zza = s, LivingEntity.
// applyInput умножает zza на 0.98, по земле ускорение zza × s × 0.21600002/0.6³
// (getFrictionInfluencedSpeed, трение 0.6), предел скорости — ÷(1 − 0.6·0.91).
// Итог 0.98·s²/0.454 бл/тик. MOVEMENT_SPEED из createAttributes: зомби (кадавр,
// утопленник) 0.23, скелеты и визер-скелет 0.25, крипер/ведьма/чешуйница 0.25,
// паук 0.3, хоглин/зоглин/разоритель 0.3, брут/поборник/разбойник 0.35, магмовый
// куб 0.2. Зомби — 2.3 бл/с, мы шагом 4.3, спринтом 5.6 (tempo.js).
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
// С какого расстояния (центр до центра, по горизонтали) моб бьёт: его
// полуширина 0.3 + Mob.getAttackBoundingBox (+√2.04 − 0.6 ≈ 0.83,
// codex-lab/audit-context-barter.md) + наша полуширина 0.3.
const MOB_REACH = 1.45
const HOLE_DEPTH = 3
// Отрыв перед стройкой: столько бежать, пока он не отстанет на время стройки.
const REFUGE_FLEE_MS = 2500
const HOT_CELL = /^(lava|fire|soul_fire)$/

// Нора вниз на HOLE_DEPTH: копается ли и сколько займёт. Те же стопы, что у
// sinkOne (лава под ногами и в стенке, пещера, бедрок, нет инструмента), плюс
// вода в стенке и сыпучее (гравий засыпает обратно — «яма не углубляется»).
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
    try { t = require('./tools').bestFor(bot, b).ms } catch {}
    if (!Number.isFinite(t) || t > 2500) return null
    ms += t + 450 // и падение в выкопанное (sinkOne ждёт 450 мс)
  }
  const floor = bot.blockAt(feet.offset(0, -HOLE_DEPTH - 1, 0))
  if (!floor || floor.boundingBox !== 'block' || /water|lava/.test(floor.name)) return null
  return { depth: HOLE_DEPTH, ms: Math.round(ms) }
}

// Замкнутый карман вокруг тела без врагов внутри — укрытие уже есть.
function pocketOf (bot, foes) {
  let air = null
  try { air = require('./sealed').localAir(bot) } catch { return null }
  if (!air || air.size < 2) return null
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

// Столб в 4 блока (build.towerUp): рамка удара моба (Mob.getAttackBoundingBox =
// inflate(r, 0, r), javap) растёт только вбок, а зомби в прыжке — 1.95 + 1.25 =
// 3.2 над своим полом: ноги на +4 рукой не достать (на +3 доставал, s7). Спуск —
// прыжок: урон падения — сверх 3 блоков, с 4 — 1 хп. Не от стрелков и не от
// пауков (лезут по столбу); крипер — отдельно (бегство).
const PILLAR = 4
// Утопленник с трезубцем бросает издали (MOBS.md §3): на столбе он достаёт — как стрелок.
const CLIMBERS = /^(spider|cave_spider|drowned)$/
function pillarPlan (bot, blocks, foes, shooters) {
  if (blocks < PILLAR || shooters.length) return null
  if (foes.some(h => CLIMBERS.test(h.e.name) || h.e.name === 'creeper' || (h.doc.radius === 0 && h.doc.range))) return null
  const feet = require('./fortify').feetCell(bot)
  const lift = standTop(bot, feet)
  if (blocks < PILLAR + lift) return null
  // Над головой свободно на весь подъём и прыжок с верха.
  for (let k = 2; k <= PILLAR + lift + 2; k++) {
    const b = bot.blockAt(feet.offset(0, k, 0))
    if (!b || b.boundingBox !== 'empty' || /water|lava/.test(b.name)) return null
  }
  return { height: PILLAR + lift, lift, ms: 300 + (PILLAR + lift) * 600 }
}

// Докуда рядом со столбом может встать ходячий: блок в 1 у соседа (8 клеток) —
// ступенька, на него запрыгнет; 2 — только если рядом есть ступенька в 1
// (s7: столб встал в недостроенной коробке, зомби залез на её стенку и достал
// на +4). Столб растёт на столько же выше.
function standTop (bot, feet) {
  const h = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      let k = 0
      while (k < 3) {
        const b = bot.blockAt(feet.offset(dx, k, dz))
        if (!b || b.boundingBox !== 'block') break
        k++
      }
      h.push(k)
    }
  }
  const one = h.some(k => k === 1)
  if (h.some(k => k >= 2) && one) return 2
  return one ? 1 : 0
}

// Тот же бот, но на полу и не в воде — для цены копки «когда встану».
function grounded (bot) {
  const g = Object.create(bot)
  g.entity = Object.create(bot.entity)
  g.entity.onGround = true
  g.entity.isInWater = false
  return g
}

// Оценка места, без хода и без ожиданий. Всё, что нужно выбору (chooseRefuge).
function refugeLook (session, { radius = 16 } = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const fortify = require('./fortify')
  const flee = require('./flee')
  const assess = require('./assess')
  const dim = worlds.worldOf(bot)
  const nether = dim === 'the_nether'
  const feet = fortify.feetCell(bot)
  const me = bot.entity.position
  const foes = flee.hostilesAround(bot, radius)
    .filter(h => !REFUGE_NEUTRAL.test(h.e.name) && h.e.isValid !== false)
  // Ходячий — угроза, если он на нашем уровне (±4): со скалы в 10 блоках не спустится за стройку.
  const walkers = foes.filter(h => h.doc.radius > 0 && Math.abs(h.e.position.y - me.y) <= 4)
  const shooters = foes.filter(h => h.doc.range && h.d <= h.doc.range && assess.inSight(bot, h.e))
  const near = walkers[0] || null
  const creeper = foes.find(h => h.e.name === 'creeper' && (h.d <= 9 || h.swelling))
  const blocks = require('./pack').buildCount(bot, dim)
  const filler = pickFiller(bot, { steady: true })
  let lava = !!bot.entity.isInLava
  for (const dy of [0, 1]) {
    const b = bot.blockAt(me.offset(0, dy, 0))
    if (b && HOT_CELL.test(b.name)) lava = true
  }
  const from = near ? near.e.position : shooters[0] ? shooters[0].e.position : null
  const cell = fortify.refugeCell(bot, from, { have: blocks, foes: foes.map(h => h.e) })
  const a = {
    dim,
    nether,
    water: inWater(bot),
    lava,
    foes: foes.length,
    walkers: walkers.length,
    shooters: shooters.length,
    nearest: near ? {
      name: near.e.name,
      d: Math.round(near.d * 10) / 10,
      etaMs: Math.round(Math.max(0, Math.hypot(near.e.position.x - me.x, near.e.position.z - me.z) - MOB_REACH) / chaseBps(near.e.name) * 1000)
    } : null,
    creeper: creeper ? { d: Math.round(creeper.d * 10) / 10, swelling: !!creeper.swelling } : null,
    // Ходячий в 16 бл. придёт — укрытие ставить сейчас, пока он идёт (нора его
    // не остановит: выход из норы под ним — самое уязвимое место отхода).
    foeClose: !!near || shooters.length > 0,
    blocks,
    filler: filler ? filler.name : null,
    pickaxe: !!fortify.pickaxeOf(bot),
    // Как будто стоим на полу: оценка бывает в прыжке после рывка, а копка в
    // воздухе впятеро дольше (digTime notOnGround) — «не выломаться» было ложным.
    canBreakOut: filler ? fortify.canBreakOut(grounded(bot), filler) : false,
    hole: nether ? null : holePlan(grounded(bot), session.mcData, feet),
    pillar: pillarPlan(bot, blocks, foes, shooters),
    pocket: 0,
    cell: cell || null
  }
  const pocket = pocketOf(bot, foes)
  a.pocket = pocket ? pocket.size : 0
  // Ниша в стене (ND_REFUGE_NICHE=1): вкопаться на клетку и заложить проём — fortify.nichePlan.
  a.niche = null
  if (nicheOn()) {
    try {
      const np = fortify.nichePlan(grounded(bot), feet, { away: from })
      if (np) a.niche = { side: np.side, cell: np.cell, digMs: np.digMs, ms: np.digMs + 300 + 2 * 180 + 300 }
    } catch {}
  }
  a.ms = gameClock.now() - t0
  return a
}
const nicheOn = () => process.env.ND_REFUGE_NICHE !== '0'

// Выбор способа по оценке (чистая функция: тест на фейковом боте и сцена).
// Порядок — research/05-synthesis.md F.5.2.
function chooseRefuge (a) {
  if (a.lava) return { how: 'flee', code: 'LAVA', why: 'в лаве или огне — не место для укрытия' }
  if (a.water) return { how: 'flee', code: 'IN_WATER', why: 'в воде не закрыться' }
  // Крипер. Закрытая коробка от него держит: SwellGoal.tick гасит фитиль без прямой видимости, а взрыв за целой стеной
  // бьёт на 1 хп (codex-lab/surv-mobs/MOBS.md §1, §7). Бегство — только если он уже шипит или вплотную (≤ 4 бл.), а
  // это ловит рефлекс автопилота (dodgeCreeper). по умолчанию так; ND_CREEPER_DODGE=0 — прежнее «крипер ≤ 9 — бегство».
  if (a.creeper && (process.env.ND_CREEPER_DODGE === '0' || a.creeper.swelling || a.creeper.d <= 4)) {
    return { how: 'flee', why: `крипер в ${a.creeper.d} бл.${a.creeper.swelling ? ' шипит' : ''} — коробка его не держит, стоять в ней значит не убежать` }
  }
  if (a.pocket) return { how: 'pocket', why: 'вокруг замкнутый карман без врагов — строить нечего' }
  const box = !!a.cell && a.canBreakOut
  // Под стрелком нору не копать: 3 с на месте под прицелом — 3–4 стрелы (C:
  // скелет в 1.5 бл., хп 10 → 0 в недокопанной норе). Сперва из-под прицела.
  const hole = !!a.hole && !a.nether && !a.shooters
  const boxWhy = () => `коробка: ${a.cell.walls ? `стен готовых ${a.cell.walls}, ` : ''}${a.cell.blocks} бл. из ${a.blocks}` +
    (a.cell.dist ? `, клетка в ${a.cell.dist} бл.` : '')
  const pillar = !!a.pillar
  const pillarWhy = `столб в ${a.pillar ? a.pillar.height : PILLAR}: ходячие рукой не достанут (блоков ${a.blocks})`
  // Ниша быстрее коробки (пещера, склон) или коробки нет — в нишу.
  const boxMs = box ? require('./fortify').refugeBuildMs(a.cell) + (a.cell.dist || 0) / 4.3 * 1000 : Infinity
  const nicheWhy = () => `ниша в стене: копать ~${(a.niche.digMs / 1000).toFixed(1)} с, заложить 2 бл.`
  if (a.foeClose && a.niche && a.niche.ms < boxMs && (a.blocks >= 2)) return { how: 'niche', why: nicheWhy() }
  if (a.foeClose && box) return { how: 'box', why: boxWhy() }
  if (a.foeClose && pillar) return { how: 'pillar', why: pillarWhy }
  if (hole) return { how: 'hole', why: `нора вниз на ${a.hole.depth} (~${(a.hole.ms / 1000).toFixed(1)} с)` }
  if (box) return { how: 'box', why: boxWhy() }
  if (pillar) return { how: 'pillar', why: pillarWhy }
  if (a.cell && !a.canBreakOut) return { how: 'flee', code: 'NO_BLOCKS', why: `из коробки из ${a.filler} не выломаться — нет кирки` }
  return {
    how: 'flee',
    code: 'NO_BLOCKS',
    why: a.nether
      ? `в Аду вниз не копаю, а на коробку блоков нет (${a.blocks})`
      : a.hole && a.shooters
        ? `на коробку блоков нет (${a.blocks}), а нору под стрелком не копаю`
        : `на коробку блоков нет (${a.blocks}), пол не копается`
  }
}

// Сколько стройка займёт с дорогой до клетки (мс) и «успеет ли он». Запаса на
// «лицо к нему первым» нет: ходячих обычно несколько и с разных сторон — пока
// встаёт лицо, второй встаёт в клетку стены, и коробка остаётся с дырой (s6:
// 3 из 12 коробок). Дойдёт раньше конца стройки — сперва рывок.
function buildMsOf (a, how) {
  if (how === 'niche' && a.niche) return a.niche.ms
  if (how === 'box' && a.cell) return require('./fortify').refugeBuildMs(a.cell) + a.cell.dist / 4.3 * 1000
  if (how === 'hole' && a.hole) return a.hole.ms * 2 / 3 // на 2 вниз рука моба уже не достаёт
  if (how === 'pillar' && a.pillar) return 300 + PILLAR * 600
  return 0
}
function outrun (a, how) {
  if (!a.nearest || (how !== 'box' && how !== 'hole' && how !== 'pillar' && how !== 'niche')) return false
  return a.nearest.etaMs < buildMsOf(a, how)
}

function lookLine (a) {
  const bits = [a.dim === 'the_nether' ? 'Ад' : a.dim === 'the_end' ? 'Энд' : 'верхний мир']
  bits.push(a.foes ? `врагов ${a.foes}${a.nearest ? `, ближний ${a.nearest.name} в ${a.nearest.d} бл. (дойдёт за ${(a.nearest.etaMs / 1000).toFixed(1)} с)` : ''}` : 'врагов нет')
  if (a.creeper) bits.push(`крипер в ${a.creeper.d} бл.`)
  bits.push(`блоков ${a.blocks}${a.filler ? ` (${a.filler}${a.canBreakOut ? '' : ', не выломаться'})` : ''}`)
  if (a.cell) bits.push(`клетка ${a.cell.cell.x},${a.cell.cell.y},${a.cell.cell.z} (${a.cell.blocks} бл., стен ${a.cell.walls})`)
  if (a.hole) bits.push(`нора ~${(a.hole.ms / 1000).toFixed(1)} с`)
  if (a.pocket) bits.push(`карман ${a.pocket} кл.`)
  if (a.niche) bits.push(`ниша ~${(a.niche.ms / 1000).toFixed(1)} с`)
  if (a.water) bits.push('в воде')
  if (a.lava) bits.push('в огне')
  return bits.join('; ')
}

const REFUGE_FOOD_BAD = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|chicken|suspicious_stew)$/
function hasFood (session) {
  const bot = session.bot
  const foods = (session.mcData && session.mcData.foodsByName) || (bot.registry && bot.registry.foodsByName) || {}
  return bot.inventory.items().some(i => foods[i.name] && !REFUGE_FOOD_BAD.test(i.name) && !/_bucket$/.test(i.name))
}

// Лечиться: зелье/яблоко на малом хп, иначе еда до полной сытости (при 20 и
// насыщении реген идёт раз в 10 тиков, при 18–19 — раз в 80: FoodData.tick).
async function healStep (session, ctl, minHp) {
  const bot = session.bot
  const kit = require('./fightkit')
  const hp = bot.health ?? 0
  if (hp >= minHp) return null
  const apple = !kit.hasEffect(bot, 'absorption') && hp <= 8 &&
    (bot.inventory.items().find(i => i.name === 'enchanted_golden_apple') || bot.inventory.items().find(i => i.name === 'golden_apple'))
  const potion = hp <= 10 && (kit.findPotion(bot, 'healing', { splash: false }) || kit.findPotion(bot, 'regeneration', { splash: false }))
  const pick = apple || potion
  if (pick) {
    session.eating = true
    try { if (await kit.consume(bot, pick, apple ? 'absorption' : null)) return pick.name } finally { session.eating = false }
  }
  if ((bot.food ?? 0) < 20 && hasFood(session)) {
    session.eating = true
    try {
      const r = await require('./actions').eat(session, {})
      if (r && r.ate) return r.ate
    } catch {} finally { session.eating = false }
  }
  return null
}

// «Занят: refuge» в шапке — не ложь. mc_wait (намерение без exclusive) пишет
// себя в session.current поверх отхода и, кончившись, обнуляет его: мозг видит
// «свободен» и зовёт новое дело, а оно обрывает отход. Пока отход жив и его
// не отменили, вернуть его в current.
function holdMouth (session, ctl) {
  const entry = ctl && ctl.entry
  if (!entry || ctl.aborted || session.current === entry) return
  if (!session.current || session.current.name === 'wait') session.current = entry
}

// Сидеть и лечиться. kind — box | hole | pocket | open (после бегства).
// Выход из цикла: вылечился, время вышло, лечиться нечем, в укрытии бьют.
async function holdOut (session, ctl, { kind, box = null, minHp, deadline, note, topY = null }) {
  const bot = session.bot
  const fortify = require('./fortify')
  const flee = require('./flee')
  const st = { ate: [], patched: 0, breaches: 0, why: null }
  let lastHp = bot.health ?? 0
  let hurtAt = 0
  const hurtTimes = []
  let lastPatch = 0
  while (!ctl.aborted) {
    holdMouth(session, ctl)
    const hp = bot.health ?? 0
    if (hp <= 0) { st.why = 'died'; break }
    if (hp < lastHp) { hurtAt = gameClock.now(); hurtTimes.push(hurtAt) }
    lastHp = hp
    if (hp >= minHp) {
      // Вылечился — доесть до 18 перед выходом, если есть что: снаружи бой.
      if ((bot.food ?? 0) < 18 && hasFood(session)) {
        const got = await healStep(session, ctl, 21)
        if (got) st.ate.push(got)
      }
      st.why = 'healed'
      break
    }
    if (gameClock.now() >= deadline) { st.why = 'timeout'; break }
    // Стены. Нору латает её караул (armShelterGuard); коробку — здесь.
    if (kind === 'box' && box) {
      const enc = fortify.enclosure(bot, box.cell)
      if (!enc.sealed && gameClock.now() - lastPatch > 400) {
        st.breaches++
        lastPatch = gameClock.now()
        const n = await fortify.refugePatch(bot, box, { ctl })
        st.patched += n
        if (!n && !st.noFill && !require('./build').pickFiller(bot, { steady: true })) { st.noFill = true; note('латать нечем — коробка открыта') }
      }
    }
    // Бьют внутри закрытого укрытия — кто-то внутри или рядом с дырой, которую
    // не заложить: сидеть дальше значит умереть на месте.
    const closeFoe = flee.hostilesAround(bot, 3).find(h => !REFUGE_NEUTRAL.test(h.e.name) && h.d < 2.2)
    if (gameClock.now() - hurtAt < 700 && closeFoe && kind !== 'open') {
      const sealedNow = kind === 'box' && box ? fortify.enclosure(bot, box.cell).sealed : true
      // Один удар в закрытой коробке — это чаще стрела, пущенная до крыши (E:
      // «вскрыли» при целой коробке): вскрыли — если бьют снова за 3 с.
      const again = hurtTimes.filter(t => gameClock.now() - t < 3000).length >= 2
      if ((sealedNow && again) || st.breaches >= 6) { st.why = 'breached'; st.by = closeFoe.e.name; break }
    }
    // На столбе: достают — стрелок видит или бьют — слезать и бежать.
    if (kind === 'pillar') {
      if (topY !== null && bot.entity.position.y < topY - 0.6 && !st.fell) { st.fell = true; note(`со столба упал: ноги y${bot.entity.position.y.toFixed(1)} при верхе ${topY}`) }
      const shot = flee.hostilesAround(bot, 16).some(h => !REFUGE_NEUTRAL.test(h.e.name) && h.doc.range && h.d <= h.doc.range && require('./assess').inSight(bot, h.e))
      if (shot) { st.why = 'breached'; break }
      if (gameClock.now() - hurtAt < 700) {
        // Достают снизу — выше, пока есть блоки (до +2), и только потом слезать.
        if ((st.raised || 0) < 2 && require('./pack').buildCount(bot, worlds.worldOf(bot)) > 0) {
          let r = null
          try { r = await require('./build').towerUp(bot, ctl, 1, { sneak: true, fast: true }) } catch {}
          if (r && r.placed) { st.raised = (st.raised || 0) + 1; note('достают — столб выше'); hurtAt = 0; continue }
        }
        st.why = 'breached'; break
      }
    }
    // На открытом месте (после бегства): подошли — снова бежать.
    if (kind === 'open') {
      // Ходячий ближе 7 бл. — до удара ~2.4 с (зомби): кусок уже не доесть.
      // Стрелок видит — тоже бежать (из-под прицела), а не есть под стрелами.
      const hs = flee.hostilesAround(bot, 16).filter(h => !REFUGE_NEUTRAL.test(h.e.name))
      const near = hs.filter(h => h.doc.radius > 0 && h.d < 7)
      const aimed = hs.some(h => h.doc.range && h.d <= h.doc.range && require('./assess').inSight(bot, h.e))
      if (near.length || aimed) { st.why = 'contact'; break }
    }
    const got = await healStep(session, ctl, minHp)
    if (got) { st.ate.push(got); continue }
    // Лечиться нечем: сытость ниже 18 — регенерации нет (FoodData.tick).
    if ((bot.food ?? 0) < 18 && !hasFood(session)) { st.why = 'no_food'; break }
    await sleep(250)
  }
  if (!st.why) st.why = ctl.aborted ? 'aborted' : 'stopped'
  return st
}

async function refuge (session, ctl, p = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, n)) : d }
  const minHp = num(p.minHp, 16, 6, 20)
  const maxMs = num(p.maxSeconds, 120, 10, 300) * 1000
  const deadline = t0 + maxMs
  const out = { how: 'none', code: 'OK', hp0: Math.round(bot.health ?? 0), why: p.why || undefined, steps: [] }
  // Смерть внутри отхода: возрождение тут же даёт хп 20, и отход писал «вылечился» (ревью Codex 02.10, 6 случаев) —
  // сверять номер смерти на входе и в итоге.
  const deathAt0 = (session.lastDeath && session.lastDeath.at) || 0
  Object.defineProperty(out, 'diedInside', { value: () => ((session.lastDeath && session.lastDeath.at) || 0) !== deathAt0, enumerable: false })
  // Сидеть до рассвета (кампания: ночь наверху без кровати, ND_NIGHT_BOX) — пересидка не только по врагам у стен.
  if (p.untilDawn) out.untilDawn = true
  // stayIn (кампания, ND_NIGHT_DOWN): из закрытой коробки не выходить — дальше вниз прямо из неё (нора под ногами,
  // крыша коробки над головой): ночью «укрытие → вниз работать», а не выход к тем, от кого прятался.
  if (p.stayIn) out.stayIn = true
  // Шаг — с секундой от начала отхода: где ушло время (рывок, стройка, еда).
  const step = s => { out.steps.push(`${((gameClock.now() - t0) / 1000).toFixed(1)}с ${s}`) }
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} try { bot.clearControlStates() } catch {} })
  try { if (typeof session.updateMovements === 'function') session.updateMovements() } catch {}

  // Кто и чем бил за время отхода (damage_event 1.21.11) — для разбора.
  const hurts = []
  const onHurt = pk => {
    if (!pk || !bot.entity || pk.entityId !== bot.entity.id || hurts.length >= 10) return
    let type = null
    try { type = require('./gamedata').damageTypeName(pk.sourceTypeId) } catch {}
    const src = pk.sourceCauseId > 0 && bot.entities ? bot.entities[pk.sourceCauseId - 1] : null
    // Откуда бил: смещение моба от нас (разбор «достают на столбе»).
    const off = src && src.position ? ` @${(src.position.x - bot.entity.position.x).toFixed(1)},${(src.position.y - bot.entity.position.y).toFixed(1)},${(src.position.z - bot.entity.position.z).toFixed(1)}` : ''
    hurts.push(`${((gameClock.now() - t0) / 1000).toFixed(1)}с ${type || pk.sourceTypeId}${src ? ' ' + (src.username || src.name) : ''}${off} y${bot.entity.position.y.toFixed(1)}${bot.entity.onGround ? '' : ' в воздухе'}`)
  }
  try { bot._client.on('damage_event', onHurt) } catch {}
  ctl.onAbort.push(() => { try { bot._client.removeListener('damage_event', onHurt) } catch {} })
  try {
    // Только выйти из воды на берег (кампания: утопленник бьёт, я в воде) — без коробки и лечения.
    if (p.shore) {
      out.how = 'shore'
      if (inWater(bot)) {
        const r = await toShore(session, ctl, { step, timeoutMs: Math.min(20000, maxMs) })
        out.code = r.ok ? 'OK' : 'IN_WATER'
        out.target = r.target || undefined
      }
      const hp = Math.round(bot.health ?? 0)
      out.hp = hp
      out.healed = hp >= minHp
      out.dry = !inWater(bot)
      out.seconds = Math.round((gameClock.now() - t0) / 100) / 10
      if (hurts.length) out.hurts = hurts
      if (hp <= 0 || out.diedInside()) { out.code = 'DIED'; out.healed = false }
      out.note = `берег: ${out.dry ? 'на суше' : 'в воде'}, хп ${out.hp0} → ${hp}, ${out.seconds} с`
      if (out.code !== 'OK') out.stopped = `${out.code}: ${out.note}`
      console.log('[refuge]', JSON.stringify(out))
      return out
    }
    return await refugeBody(session, ctl, { t0, minHp, deadline, out, step, hurts })
  } finally {
    try { bot._client.removeListener('damage_event', onHurt) } catch {}
  }
}

async function refugeBody (session, ctl, { t0, minHp, deadline, out, step, hurts }) {
  const bot = session.bot
  const flee = require('./flee')
  // Клетка ног — с пола: в прыжке floored-клетка на блок выше, и вся оценка
  // (клетка коробки, нора) съезжает на уровень.
  try { bot.pathfinder.setGoal(null) } catch {}
  await require('./fortify').landed(bot, 600)
  let a = refugeLook(session)
  out.look = lookLine(a)
  out.lookMs = a.ms

  if (a.lava && !ctl.aborted) {
    step('в огне — вон из него')
    try { if (session.director && typeof session.director.escapeFire === 'function') await session.director.escapeFire() } catch {}
    a = refugeLook(session)
  }
  if (a.water && !ctl.aborted && process.env.ND_REFUGE_SHORE !== '0') {
    // Из воды — на берег подальше от утопленников (toShore), а не «всплыть»: тело оставалось в воде.
    step('в воде — плыву к берегу')
    try {
      const r = await toShore(session, ctl, { step })
      step(`берег: ${r.ok ? 'на суше' : 'не вышел'} за ${r.seconds} с`)
    } catch (e) { step(`берег: ${e.message}`) }
    await require('./fortify').landed(bot, 600)
    a = refugeLook(session)
  }
  if (a.water && !ctl.aborted) {
    // Из воды — к суше, как campaign.rest: открытый воздух важнее норы.
    step('в воде — выхожу на сушу')
    try {
      const r = await surface(session, ctl, { targetY: Math.floor(bot.entity.position.y) + 2, timeoutSeconds: 25, preferPillar: false })
      if (r && r.stopped) step(`суша: ${r.stopped}`)
    } catch (e) { step(`суша: ${e.message}`) }
    a = refugeLook(session)
  }
  let pick = chooseRefuge(a)
  // Паук вплотную, а с ним не больше одного ходячего — сперва бой (ND_REFUGE_SPIDER=1): от паука не оторваться в
  // темноте и на рельефе (прыжок-атака с 2–4 бл.), а его рамка 1.4 занимает клетки стен — коробка с ним рядом не
  // встаёт (trap2 02.10, ночь: два рывка от паука, нора под ним, 20 → 0 за 15 с). 16 хп — 4 удара камнем, 4 деревом.
  const spiderFirst = async () => {
    if (process.env.ND_REFUGE_SPIDER === '0' || ctl.aborted || (bot.health ?? 0) < 8 || !require('./items').bestWeapon(bot)) return false
    const hs = flee.hostilesAround(bot, 10).filter(h => !REFUGE_NEUTRAL.test(h.e.name))
    // Паук в 6 бл. — дойдёт за 1.5 с (3.9 бл/с, прыжок с 2–4): от него не оторваться и коробку при нём не закрыть.
    const sp = hs.find(h => /^(spider|cave_spider)$/.test(h.e.name) && h.d <= 6 && Math.abs(h.e.position.y - bot.entity.position.y) <= 3)
    // Только один на один: с зомби рядом бой с пауком тянется 7–8 с под его ударами (trap3/4: 12 → 0).
    const others = hs.filter(h => h !== sp && (h.doc.radius > 0 || h.doc.range) && h.d <= 8).length
    if (!sp || others > 0 || a.creeper) return false
    {
      step(`${sp.e.name} вплотную (${sp.d.toFixed(1)} бл.) — сперва бой`)
      let r = null
      try { r = await require('./combat').fight(session, ctl, { target: '#' + sp.e.id, timeoutSeconds: 12, retreatAtHealth: 5, purpose: 'defense' }) } catch (e) { r = { error: e.message } }
      step(`паук: ${r && (r.killed || (r.kills && r.kills.length)) ? 'убит' : String((r && (r.stopped || r.error)) || 'бой кончился').slice(0, 60)}, хп ${Math.round(bot.health ?? 0)}`)
      await require('./fortify').landed(bot, 600)
      a = refugeLook(session)
      pick = chooseRefuge(a)
      return true
    }
  }
  await spiderFirst()
  // Блоков мало, а брёвна есть (начало игры: после дерева, до камня) — доски из брёвен в сетке 2×2 (~0.5 с на
  // бревно, 1 → 4): коробка и ниша из досок держат так же. ND_REFUGE_PLANKS=1. trap1 02.10, ночь: «flee NO_BLOCKS»
  // при 6 брёвнах в рюкзаке — бегство под скелетом, смерть.
  if (process.env.ND_REFUGE_PLANKS !== '0' && !ctl.aborted && a.blocks < 8 && !a.nether &&
    (pick.code === 'NO_BLOCKS' || a.foeClose || (pick.how === 'box' && a.cell && a.cell.blocks > a.blocks))) {
    const made = await planksFromLogs(session, ctl, Math.ceil((8 - a.blocks) / 4))
    if (made) {
      step(`доски из брёвен: +${made}`)
      a = refugeLook(session)
      pick = chooseRefuge(a)
    }
  }

  // Он дойдёт раньше, чем встанут стены, — сперва оторваться: зомби 2.3 бл/с,
  // мы спринтом 5.6. Два коротких рывка, потом строиться где стоим.
  for (let k = 0; k < 2 && !ctl.aborted && outrun(a, pick.how); k++) {
    // От паука не оторваться — с ним бой (если он один на один), а не рывок.
    if (process.env.ND_REFUGE_SPIDER !== '0' && /^(spider|cave_spider)$/.test(a.nearest.name) && await spiderFirst()) continue
    step(`${a.nearest.name} в ${a.nearest.d} бл. дойдёт за ${(a.nearest.etaMs / 1000).toFixed(1)} с, стройка ~${(buildMsOf(a, pick.how) / 1000).toFixed(1)} с — сперва отрываюсь`)
    const p0 = bot.entity.position.clone()
    const f = await flee.smartFlee(session, ctl, { timeoutMs: REFUGE_FLEE_MS, safeDist: 10 })
    const moved = bot.entity.position.distanceTo(p0)
    out.ran = (out.ran || 0) + Math.round(moved)
    await require('./fortify').landed(bot, 600)
    a = refugeLook(session)
    pick = chooseRefuge(a)
    if (f.cornered) { step('прижали — строюсь где стою'); break }
    // Рывок не сдвинул (лесенка шириной в клетку, тупик штрека): второй такой же — ещё 2.5 с под ударами
    // (trap0 02.10: два рывка по 0 бл. и смерть). Строиться здесь, отталкивая ударом (refugeBox — shove).
    if (moved < 2) { step(`рывок не сдвинул (${moved.toFixed(1)} бл.) — строюсь где стою`); break }
  }
  out.choice = pick.why

  let hold = null
  let exitRes = null
  // Способ, за ним откаты. Не встал первый, а ходячий уже рядом (≤ 8 бл.) — сразу
  // бегство: нора и столб под зомби вплотную — смерть на 2-м блоке (J, K: 9 из 10
  // смертей в откатах), а круг «оторваться — поесть» лечит и без блоков (16/16).
  // После недостроенной коробки — нора в её же стенах раньше столба: стенки
  // прикрывают, пока копаешь, а на недостроенную стенку зомби залезает и
  // достаёт столб (D: 5 из 5 столбов после коробки 2–3/4). В Аду норы нет.
  const alt = [a.niche ? 'niche' : null, a.cell && a.canBreakOut ? 'box' : null, a.hole && !a.shooters ? 'hole' : null, a.pillar ? 'pillar' : null].filter(Boolean)
  const order = pick.how === 'flee' || pick.how === 'pocket'
    ? [pick.how, 'flee']
    : [pick.how, ...alt.filter(h => h !== pick.how), 'flee']
  let first = true
  for (const how of order) {
    if (ctl.aborted || (bot.health ?? 0) <= 0) break
    // Откат (коробка не встала): место и мобы уже другие — если ходячий дойдёт
    // раньше, чем встанет нора или столб, сперва рывок (H: нора под зомби —
    // смерть на 2-м блоке).
    if (!first && (how === 'hole' || how === 'pillar')) {
      await require('./fortify').landed(bot, 600)
      a = refugeLook(session)
      if (a.nearest && a.nearest.d <= 8) { step(`${how}: ${a.nearest.name} в ${a.nearest.d} бл. — не успеть, бегство`); continue }
      if (outrun(a, how)) {
        step(`${how}: ${a.nearest.name} в ${a.nearest.d} бл. — сперва рывок`)
        const f = await flee.smartFlee(session, ctl, { timeoutMs: REFUGE_FLEE_MS, safeDist: 10 })
        out.ran = (out.ran || 0) + (f.ran || 0)
        await require('./fortify').landed(bot, 600)
        a = refugeLook(session)
        if ((how === 'hole' && !a.hole) || (how === 'pillar' && !a.pillar)) continue
      }
    }
    first = false
    if (how === 'box' || how === 'niche') {
      const b = how === 'niche' ? await takeNiche(session, ctl, a, step) : await takeBox(session, ctl, a, step)
      if (!b) { a = refugeLook(session); continue }
      out.how = how
      out.cell = xyz(b.cell)
      out.placed = b.placed
      hold = await holdOut(session, ctl, { kind: 'box', box: b, minHp, deadline, note: step })
      if (out.stayIn && hold.why !== 'breached' && hold.why !== 'died' && !ctl.aborted && (bot.health ?? 0) > 0 &&
        require('./fortify').enclosure(bot, b.cell).sealed) {
        step('остаюсь в коробке — дальше вниз из неё')
        out.stayed = true
        break
      }
      // Снаружи опасно, а коробка цела — сидеть (NO_FOOD/срок не повод выходить к ним).
      if ((sitOn() || out.untilDawn) && hold.why !== 'breached' && hold.why !== 'died' && require('./fortify').enclosure(bot, b.cell).sealed) {
        const st = await sitTight(session, ctl, { at: b.cell, t0, box: b, step, untilDawn: out.untilDawn })
        if (st.sat) out.sat = Math.round(st.sat / 1000)
      }
      // Вскрыли — не ждать у дыры, выходить с дальней стороны.
      if (hold.why !== 'breached' && require('./fortify').enclosure(bot, b.cell).sealed) {
        const clear = await waitClear(session, ctl, b.cell, { deadline: Math.min(deadline + 20000, gameClock.now() + 30000), reach: 4, step })
        // Срок вышел и хп полное — не повод вскрывать целую коробку к толпе (как у норы ниже; Codex ne-deaths №4:
        // VR25-3 — вышел к 10 ифритам, VR26-1 — к эндерменам). Дальше — вниз/вбок из коробки, как stayIn.
        if (!clear && sitOn() && !ctl.aborted && (bot.health ?? 0) > 0 && require('./fortify').enclosure(bot, b.cell).sealed) {
          step('у выхода враги — коробку не вскрываю, остаюсь')
          out.stayed = true
          break
        }
      }
      exitRes = await leaveBox(session, ctl, b, hold, step)
      break
    }
    if (how === 'pillar') {
      const pl = await takePillar(session, ctl, step)
      if (!pl) { a = refugeLook(session); continue }
      out.how = 'pillar'
      out.height = pl.height
      hold = await holdOut(session, ctl, { kind: 'pillar', minHp, deadline, note: step, topY: Math.floor(bot.entity.position.y) })
      exitRes = await leavePillar(session, ctl, step)
      break
    }
    if (how === 'hole') {
      const h = await takeHole(session, ctl, step)
      if (!h) { a = refugeLook(session); continue }
      out.how = 'hole'
      out.depth = h.depth
      hold = await holdOut(session, ctl, { kind: 'hole', minHp, deadline, note: step })
      if ((sitOn() || out.untilDawn) && !h.open && hold.why !== 'breached' && hold.why !== 'died') {
        const st = await sitTight(session, ctl, { at: bot.entity.position.floored(), t0, step, untilDawn: out.untilDawn })
        if (st.sat) out.sat = Math.round(st.sat / 1000)
      }
      // Вылезать столбом, пока у края стоит ходячий, — голова выходит ему под руку
      // (smoke 30.09: из норы на 16 хп вылез к зомби и умер). Ждать, пока отойдут
      // (без прямой видимости цель теряют за 3 с, NearestAttackableTargetGoal).
      const top = bot.entity.position.floored().offset(0, h.depth, 0)
      const clear = await waitClear(session, ctl, top, { deadline: Math.min(deadline + 30000, gameClock.now() + 30000), reach: 4, step })
      // Не ушли от края — наверх не лезть (ND_REFUGE_SIT): pool1 02.10 слот 18 — нора в штреке, «у выхода ждал 30 с —
      // не ушли, выхожу» → вылез к трём зомби, «прижали» → бой → смерть. Нора закрыта сверху, работа — отсюда, вниз и вбок
      // (лесенка, штрек), к ним наверх ход не ведёт.
      if (!clear && sitOn() && !h.open && hold.why !== 'breached' && !ctl.aborted && (bot.health ?? 0) > 0) {
        step('у выхода ждут — наверх не лезу, остаюсь внизу')
        out.stayed = true
      } else if (!(hold.why === 'breached' && (bot.health ?? 0) <= 4)) {
        exitRes = await exitShelter(session, ctl, { depth: h.depth })
        if (exitRes && exitRes.stopped) step(`выход из норы: ${exitRes.stopped}`)
      }
      break
    }
    if (how === 'pocket') {
      out.how = 'pocket'
      step(`сижу в замкнутом кармане (${a.pocket} кл.)`)
      hold = await holdOut(session, ctl, { kind: 'pocket', minHp, deadline, note: step })
      if ((sitOn() || out.untilDawn) && hold.why !== 'breached' && hold.why !== 'died') {
        const st = await sitTight(session, ctl, { at: bot.entity.position.floored(), t0, step, untilDawn: out.untilDawn })
        if (st.sat) out.sat = Math.round(st.sat / 1000)
      }
      break
    }
    // Бегство: оторваться, в тихом месте поесть; подошли — снова.
    out.how = 'flee'
    if (pick.code) out.code = pick.code
    // Круги «оторваться — поесть»: зомби 2.3 бл/с, кусок 1.6 с — на круг один-два куска.
    for (let k = 0; k < 10 && !ctl.aborted && gameClock.now() < deadline && (bot.health ?? 0) > 0; k++) {
      const f = await flee.smartFlee(session, ctl, { timeoutMs: Math.min(15000, Math.max(3000, deadline - gameClock.now())), safeDist: 16 })
      out.ran = (out.ran || 0) + (f.ran || 0)
      step(`бегство: ${f.mode}`)
      if (f.cornered) { out.code = 'CORNERED'; break }
      hold = await holdOut(session, ctl, { kind: 'open', minHp, deadline, note: step })
      if (hold.why !== 'contact') break
    }
    break
  }

  // Вышел, а ходячие ждут у стен (ночью зомби не расходятся: H — 4 из 6 смертей
  // через 2–3 с после выхода, 4 зомби бьют ~9 хп/с) — сразу оторваться: мы
  // спринтом 5.6 бл/с, зомби 2.3. Дальше — дело того, кто звал.
  if (exitRes && out.how !== 'flee' && !ctl.aborted && (bot.health ?? 0) > 0) {
    const near = flee.hostilesAround(bot, 8).filter(h => !REFUGE_NEUTRAL.test(h.e.name) && h.doc.radius > 0)
    if (near.length) {
      const f = await flee.smartFlee(session, ctl, { timeoutMs: 6000, safeDist: 12 })
      out.ran = (out.ran || 0) + (f.ran || 0)
      step(`после выхода (${near.length} рядом): ${f.mode}`)
    }
  }

  // Итог.
  const hp = Math.round(bot.health ?? 0)
  out.hp = hp
  out.healed = hp >= minHp
  out.seconds = Math.round((gameClock.now() - t0) / 100) / 10
  if (hold) {
    if (hold.ate.length) out.ate = hold.ate
    if (hold.patched) out.patched = hold.patched
    if (hold.breaches) out.breaches = hold.breaches
    out.held = hold.why
  }
  if (exitRes) out.out = exitRes.ok !== undefined ? exitRes.ok : exitRes.out
  // Оборвал не урон (его в прерываниях нет), а чужое намерение, чат или смерть.
  if (ctl.aborted) out.aborted = true
  if (hurts.length) out.hurts = hurts
  if (out.diedInside && out.diedInside()) out.healed = false
  if (hp <= 0 || (out.diedInside && out.diedInside())) out.code = 'DIED'
  else if (out.code === 'OK' && hold && hold.why === 'no_food' && !out.healed) out.code = 'NO_FOOD'
  else if (out.code === 'OK' && hold && hold.why === 'breached') out.code = 'CORNERED'
  else if (out.code === 'OK' && out.how === 'none') out.code = 'CORNERED'
  const words = { box: 'коробка', niche: 'ниша', hole: 'нора', pocket: 'карман', pillar: 'столб', flee: 'бегство', none: 'укрыться не вышло' }
  out.note = `${words[out.how]}: хп ${out.hp0} → ${hp}${out.healed ? '' : ` (до ${minHp} не дотянул${hold && hold.why === 'no_food' ? ' — лечиться нечем' : hold && hold.why === 'timeout' ? ' — время вышло' : ''})`}` +
    (out.ate ? `, съел ${out.ate.join(', ')}` : '') + `, ${out.seconds} с`
  if (out.code !== 'OK') out.stopped = `${out.code}: ${out.note}`
  try { session.journal.append('отход', `${out.note}; ${out.choice || ''}`, bot.entity.position) } catch {}
  console.log('[refuge]', JSON.stringify(out))
  return out
}

// Доски из брёвен (сетка 2×2, без верстака): logs брёвен → logs·4 досок. Вернёт, сколько досок прибавилось.
async function planksFromLogs (session, ctl, logs = 2) {
  const bot = session.bot
  const log = bot.inventory.items().find(i => /_(log|stem)$/.test(i.name) && !/^stripped_/.test(i.name)) ||
    bot.inventory.items().find(i => /_(log|stem)$/.test(i.name))
  if (!log) return 0
  const plank = log.name.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks')
  if (!session.mcData.itemsByName[plank]) return 0
  const before = bot.inventory.items().filter(i => i.name === plank).reduce((n, i) => n + i.count, 0)
  try {
    await require('./actions').craft(session, ctl, { item: plank, count: before + Math.min(logs, log.count) * 4, spendReserve: true })
  } catch {}
  const after = bot.inventory.items().filter(i => i.name === plank).reduce((n, i) => n + i.count, 0)
  return Math.max(0, after - before)
}

// Ниша: вкопаться в стену на клетку и заложить проём (fortify.nichePlan/takeNicheBody). null — не закрылась.
async function takeNiche (session, ctl, a, step) {
  const bot = session.bot
  const fortify = require('./fortify')
  await fortify.landed(bot, 600)
  const feet = fortify.feetCell(bot)
  const near = a.nearest ? require('./flee').hostilesAround(bot, 16).find(h => h.e.name === a.nearest.name) : null
  const plan = fortify.nichePlan(bot, feet, { away: near ? near.e.position : null })
  if (!plan) { step('ниша: здесь не вкопаться'); return null }
  try { await fortify.centerInCell(bot, 500) } catch {}
  const r = await fortify.takeNicheBody(bot, feet, plan, { ctl, toward: near ? near.e.position : null })
  step(`ниша: вкопал ${r.dug}/2, поставил ${r.placed}${r.steps.length ? ' — ' + r.steps.slice(0, 2).join('; ') : ''}`)
  if (!r.box) return null
  const b = r.box
  for (let k = 0; k < 2 && !ctl.aborted && !fortify.enclosure(bot, b.cell).sealed; k++) {
    b.placed += await fortify.refugePatch(bot, b, { ctl })
    if (!fortify.enclosure(bot, b.cell).sealed) await sleep(300)
  }
  const enc = fortify.enclosure(bot, b.cell)
  step(`ниша: стен ${enc.walls}/4, крыша ${enc.roof ? 'есть' : 'нет'}`)
  if (!enc.sealed) return null
  session.shelterBox = b.cell
  return b
}

// Коробка: дойти до клетки, закрыться, долатать. null — не закрылась.
async function takeBox (session, ctl, a, step) {
  const bot = session.bot
  const fortify = require('./fortify')
  const target = a.cell
  if (!target) return null
  const toward = a.nearest ? require('./flee').hostilesAround(bot, 16).find(h => h.e.name === a.nearest.name)?.e.position : null
  // Клетка в том же столбце (на блок ниже/выше ног) — тело ещё в прыжке после выхода из воды или рывка: дождаться пола,
  // а не «идти» к ней (trap2 02.10, вода: «к клетке (0 бл.) — до клетки не дошёл», откат на столб под трезубцем).
  {
    const f = fortify.feetCell(bot)
    if (!target.cell.equals(f) && target.cell.x === f.x && target.cell.z === f.z) await fortify.landed(bot, 1200)
  }
  if (!target.cell.equals(fortify.feetCell(bot))) {
    step(`к клетке у стены: ${target.cell.x},${target.cell.y},${target.cell.z} (${target.dist} бл.)`)
    // Шагом по прямой, не pathfinder'ом: у мобов его путь дорог (обход мобов),
    // и частичный путь уводил тело на 7–15 бл. от клетки, пока шла стройка
    // (C: «тело 2991,3014» при клетке 2998,3001).
    await stepTo(bot, ctl, target.cell, 1500)
    if (!fortify.feetCell(bot).equals(target.cell)) {
      // Не дошёл — строиться там, где стою, если тут годится.
      const here = fortify.refugeNeed(bot, fortify.feetCell(bot))
      if (!here || here.blocks > a.blocks) { step('до клетки не дошёл'); return null }
      target.cell = fortify.feetCell(bot)
    }
  }
  const b = await fortify.refugeBox(bot, target.cell, { toward, ctl })
  // Не закрылась — ещё до двух заходов латания (зомби отходит из клетки стены).
  for (let k = 0; k < 2 && !ctl.aborted && !fortify.enclosure(bot, b.cell).sealed; k++) {
    b.placed += await fortify.refugePatch(bot, b, { ctl })
    if (!fortify.enclosure(bot, b.cell).sealed) await sleep(300)
  }
  // Стены целы, а крыша не встаёт (подпорку в прыжке не взять) — как игрок:
  // вниз на 1 блок в своей же коробке, и крышка ложится на уровень головы, в
  // бок стены (грань видна снизу): подпорка не нужна (I: 4/4 без крыши × 4).
  {
    const e0 = fortify.enclosure(bot, b.cell)
    if (!e0.sealed && e0.walls === 4 && !e0.roof && !ctl.aborted && !worlds.worldOf(bot).includes('end')) {
      const low = await fortify.sinkRoof(bot, b.cell, { ctl, why: w => step(`осесть не вышло: ${w}`) })
      if (low) { step('крыша не встала — осел на 1 и закрылся на уровне головы'); b.cell = low; b.sunk = true }
    }
  }
  const enc = fortify.enclosure(bot, b.cell)
  step(`коробка: поставил ${b.placed}, стен ${enc.walls}/4, крыша ${enc.roof ? 'есть' : 'нет'}${b.failed ? ` — ${b.failed.slice(0, 2).join('; ')}` : ''}`)
  // С открытой стороной это не укрытие, а угол: через неё бьют, пока ешь
  // (A: 2 смерти из 12 в коробке 3/4). Не закрылась — дальше по списку (столб
  // в тех же стенах: на стены в 2 блока без ступеньки ходячему не залезть).
  if (!enc.sealed) return null
  session.shelterBox = b.cell
  return b
}

// Шаг к соседней клетке по прямой: смотреть в её центр и идти (прыжок, если она
// на блок выше), пока ноги не в ней, но не дольше ms.
async function stepTo (bot, ctl, cell, ms = 1500) {
  const fortify = require('./fortify')
  try { bot.pathfinder.setGoal(null) } catch {}
  const until = gameClock.now() + ms
  try {
    while (gameClock.now() < until && !ctl.aborted && !fortify.feetCell(bot).equals(cell)) {
      const p = bot.entity.position
      const dx = cell.x + 0.5 - p.x
      const dz = cell.z + 0.5 - p.z
      await bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
      bot.setControlState('forward', true)
      bot.setControlState('jump', cell.y > Math.floor(p.y + 1e-3) && bot.entity.onGround)
      await sleep(50)
    }
  } finally { try { bot.clearControlStates() } catch {} }
  await fortify.landed(bot, 600)
  return fortify.feetCell(bot).equals(cell)
}

// Нора вниз (enterShelter без её коробки-отката: откат решает refuge).
async function takeHole (session, ctl, step) {
  // Место могло смениться (рывок, коробка не встала) — нора копается ли здесь.
  if (!holePlan(grounded(session.bot), session.mcData, require('./fortify').feetCell(session.bot))) { step('нора: здесь не копается'); return null }
  try {
    // После рывка тело где попало на клетке: sinkOne копает блок под floored-клеткой,
    // а стоит тело и на соседней — не проваливается. Сперва встать в центр.
    try { await require('./fortify').centerInCell(session.bot) } catch {}
    const r = await enterShelter(session, ctl, { depth: HOLE_DEPTH, torch: false, box: false, maxSwings: HOLE_DEPTH + 2, center: true })
    step(`нора: ${r.note || ''}`)
    if (r.sealed) return { depth: r.depth }
    // Крышка не встала (моб стоит в её клетке) — ещё пару раз; на 2+ вниз рука
    // ходячего и так не достаёт (рамка удара — только вбок): сидеть в открытой,
    // а не вылезать к ним (D: вылез из открытой норы — «прижали», смерть).
    for (let k = 0; k < 3 && !r.sealed && r.depth >= 2 && !ctl.aborted; k++) {
      await sleep(400)
      const top = session.bot.entity.position.floored().offset(0, 2, 0)
      const q = await placeBlockAt(session.bot, top, { timeoutMs: 600, steady: true }).catch(() => ({ ok: false }))
      if (q.ok) { r.sealed = true; step('нора: крышку закрыл со второго раза') }
    }
    if (r.sealed) return { depth: r.depth }
    // Открытая нора при ходячих рядом — не укрытие: зомби сваливается в ствол
    // сверху и бьёт в голову (J: 3 смерти). Сидеть — только если их нет.
    const walkers = require('./flee').hostilesAround(session.bot, 8).filter(h => !REFUGE_NEUTRAL.test(h.e.name) && h.doc.radius > 0)
    if (r.depth >= 2 && !walkers.length) { step('нора открыта, но на 2+ вниз и ходячих нет — сижу'); return { depth: r.depth, open: true } }
    if (r.depth) await exitShelter(session, ctl, { depth: r.depth })
  } catch (e) { step(`нора: ${e.message}`) }
  return null
}

// Сидеть в закрытом укрытии, пока снаружи опасно (ND_REFUGE_SIT=1). Отход кончался «лечиться нечем» (NO_FOOD) или
// по сроку и выходил к тем, от кого прятался: A5 слот 12 — хп 11, есть нечего, вышел из коробки к трём мобам, смерть
// через 8 с. Опасно снаружи: ходячих ≥ 2 в 12 бл. (или один при хп < 10), крипер в 10 бл., стрелок, который видит
// выход; ночью на поверхности при хп < 12 — до рассвета (зомби и скелеты горят утром, ночью новые идут). Не дольше
// SIT_CAP_MS от начала отхода. Пока сидим — доедать и латать коробку. Вернёт { sat: мс, why }.
const SIT_CAP_MS = 9.5 * 60000 // ночь — ~8.3 мин (13000→23000), с запасом до рассвета
const sitOn = () => process.env.ND_REFUGE_SIT !== '0'
function outsideDanger (bot, at, { untilDawn = false } = {}) {
  const flee = require('./flee')
  const hs = flee.hostilesAround(bot, 16).filter(h => !REFUGE_NEUTRAL.test(h.e.name))
  const hp = bot.health ?? 0
  // Ходячие у самых стен (≤ 6 бл. по горизонтали от клетки) — выйти значит в их руки. Бродящие дальше — не повод
  // сидеть: без видимости зомби теряет цель за ~3 с (MOBS.md §6), а «2 в 12 бл.» держало до предела 9.5 мин
  // (ревью Codex 02.10).
  const horiz = h => Math.hypot(h.e.position.x - (at.x + 0.5), h.e.position.z - (at.z + 0.5))
  // Двое в 10 бл. — снова найдут (trap2 с «2 в 12» — 26/30, trap3–4 с «у стен ≤ 6» — выходил к ним); один — если
  // у самой стены и хп мало.
  const walkers = hs.filter(h => h.doc.radius > 0 && horiz(h) <= 10 && Math.abs(h.e.position.y - at.y) <= 4)
  const close = walkers.filter(h => horiz(h) <= 6)
  if (walkers.length >= 2 || (close.length && hp < 12)) return `ходячих ${walkers.length} в 10 бл.`
  if (hs.some(h => h.e.name === 'creeper' && h.d <= 8)) return 'крипер у стен'
  // Стрелок в своей дальности: на выходе первая же стрела (на открытом месте без щита — 3–5 хп раз в ~3 с).
  if (hs.some(h => /^(skeleton|stray|bogged|parched|pillager)$/.test(h.e.name) && h.d <= 16)) return 'стрелок рядом'
  const t = bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : 6000
  const night = t >= 12542 && t <= 23459
  // До рассвета (кампания уже решила: ночь наверху) — без проверки неба: листва над коробкой — не крыша от мобов
  // (trap4 02.10: «до рассвета» вышел через 16 с в лесу).
  if (night && untilDawn && worlds.worldOf(bot) === 'overworld') return 'ночь — до рассвета'
  if (night && hp < 12 && worlds.worldOf(bot) === 'overworld' && openSkyOver(bot, at)) return `ночь наверху, хп ${Math.round(hp)}`
  // Рассвет (23459…600) при хп < 8: зомби и скелеты ещё не сгорели (горят по яркости, не сразу) — выход к ним на 5 хп
  // и охота = смерть (trapJ 03.10, lowhp ×2: сидел до 23460, вышел, зомби в 8 бл. → смерть). Сидеть до утра (≤ SIT_CAP).
  if (hp < 8 && (t > 23459 || t < 600) && worlds.worldOf(bot) === 'overworld' && openSkyOver(bot, at)) return `рассвет, хп ${Math.round(hp)} — пока не сгорят`
  // ND_REFUGE_SIT2=1: ночью наверху сидеть и при хп < 16 или без еды — без еды не вылечиться, а ночью мобы прибывают
  // (camp1 02.10: коробка NO_FOOD на 12 хп — выход к пауку, скелет добил; столб NO_FOOD на 5 — слез и умер).
  if (process.env.ND_REFUGE_SIT2 === '1' && night && worlds.worldOf(bot) === 'overworld' && openSkyOver(bot, at) &&
    (hp < 16 || !bot.inventory.items().some(i => /^(cooked_|bread|baked_potato|golden_carrot|apple|carrot|melon_slice|sweet_berries|beef|porkchop|mutton|rabbit|cod|salmon)/.test(i.name)))) return `ночь наверху, хп ${Math.round(hp)}, без еды или ранен`
  return null
}
// Над укрытием небо: от крыши вверх до 24 бл. нет ни одного блока, кроме самой крыши.
// Листва — не крыша: ночью в лесу мобы спавнятся и ходят так же (trapK 03.10, lowhp: коробка под кроной — «стрелок
// рядом» 127 с, ушёл — и вышел ночью на 5 хп к двум зомби, смерть). Брёвна ствола над головой — тоже не подземелье.
function openSkyOver (bot, at) {
  for (let dy = 3; dy <= 24; dy++) {
    const b = bot.blockAt(at.offset(0, dy, 0))
    if (b && b.boundingBox === 'block' && !/leaves|_log$|_wood$|mushroom_block/.test(b.name)) return false
  }
  return true
}
async function sitTight (session, ctl, { at, t0, box = null, step, untilDawn = false }) {
  const bot = session.bot
  const fortify = require('./fortify')
  const s0 = gameClock.now()
  let why = outsideDanger(bot, at, { untilDawn })
  if (!why) return { sat: 0 }
  step(`снаружи опасно (${why}) — сижу`)
  let clearSince = 0
  let lastPatch = 0
  let failedPatches = 0
  // Не до рассвета — не дольше 3 мин: под землёй мобы не горят, а ждать «пока уйдут» можно бесконечно.
  const t = bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : 6000
  const night = t >= 12542 && t <= 23459 && worlds.worldOf(bot) === 'overworld'
  const nightSky = night && openSkyOver(bot, at)
  const cap = (nightSky && ((bot.health ?? 0) < 12 || process.env.ND_REFUGE_SIT2 === '1')) || (night && untilDawn) ? SIT_CAP_MS : Math.min(SIT_CAP_MS, gameClock.now() - t0 + 180000)
  while (!ctl.aborted && (bot.health ?? 0) > 0 && gameClock.now() - t0 < cap) {
    holdMouth(session, ctl)
    if (box && gameClock.now() - lastPatch > 600 && !fortify.enclosure(bot, box.cell).sealed) {
      lastPatch = gameClock.now()
      let n = 0
      try { n = await fortify.refugePatch(bot, box, { ctl }) } catch {}
      // Дыру не заложить (нечем, моб в клетке стены) — сидеть в открытой коробке незачем.
      if (!n && !fortify.enclosure(bot, box.cell).sealed && ++failedPatches >= 5) { step('коробку не залатать — не сижу'); break }
    }
    await healStep(session, ctl, 20).catch(() => null)
    const w = outsideDanger(bot, at, { untilDawn })
    if (w) { why = w; clearSince = 0 } else if (!clearSince) clearSince = gameClock.now()
    // Стихло 8 с подряд — выходить.
    if (clearSince && gameClock.now() - clearSince >= 8000) break
    await sleep(500)
  }
  const sat = gameClock.now() - s0
  step(`сидел ${Math.round(sat / 1000)} с${gameClock.now() - t0 >= cap ? ' — до предела' : ''}`)
  return { sat, why }
}

// Ждать у выхода, пока рядом стоит ходячий (reach по горизонтали от at, по
// высоте −1..+4), но не дольше deadline. Вернёт, дождался ли.
async function waitClear (session, ctl, at, { deadline, reach = 3, step }) {
  const bot = session.bot
  const flee = require('./flee')
  const t0 = gameClock.now()
  const near = () => flee.hostilesAround(bot, 12).some(h => !REFUGE_NEUTRAL.test(h.e.name) && h.doc.radius > 0 &&
    Math.hypot(h.e.position.x - (at.x + 0.5), h.e.position.z - (at.z + 0.5)) <= reach &&
    h.e.position.y - at.y >= -1 && h.e.position.y - at.y <= 4)
  if (!near()) return true
  while (!ctl.aborted && gameClock.now() < deadline && (bot.health ?? 0) > 0 && near()) {
    // Ждём сытыми: доесть, пока стоят.
    holdMouth(session, ctl)
    await healStep(session, ctl, 21).catch(() => null)
    await sleep(400)
  }
  const ok = !near()
  if (step) step(`у выхода ждал ${Math.round((gameClock.now() - t0) / 1000)} с${ok ? '' : ' — не ушли, выхожу'}`)
  return ok
}

// Столб: в центр, 3 блока под себя в прыжке (build.towerUp — ставит в верх
// блока под ногами, грань видна). null — не вырос хотя бы на 2.
async function takePillar (session, ctl, step) {
  const bot = session.bot
  try { await require('./fortify').centerInCell(bot) } catch {}
  const lift = standTop(bot, require('./fortify').feetCell(bot))
  const want = PILLAR + lift
  if (require('./pack').buildCount(bot, worlds.worldOf(bot)) < want) { step(`столб: на ${want} блоков не хватает`); return null }
  const y0 = bot.entity.position.y
  // Ходячий вплотную толкает тело с прыжка: блок встаёт, а тело — рядом на земле
  // (G: «4 бл., ноги y150»). Сперва отбросить его ударом, как у стены коробки.
  try { await require('./fortify').shoveNear(bot, 1.6) } catch {}
  let r
  try { r = await require('./build').towerUp(bot, ctl, want, { sneak: true, fast: true }) } catch (e) { r = { placed: 0, why: [e.message] } }
  const rose = bot.entity.position.y - y0
  step(`столб: ${r.placed} бл., подъём ${rose.toFixed(1)}${r.why ? ' — ' + r.why.slice(0, 2).join('; ') : ''}`)
  // Верх — по телу, а не по счёту блоков.
  if (rose < PILLAR + lift - 0.5) return null
  return { height: Math.round(rose), lift }
}

// Со столба — прыжком в сторону от ходячих: с 3 бл. урона нет (падение считается
// от 3), внизу дальше бой или бег — решает тот, кто звал.
async function leavePillar (session, ctl, step) {
  const bot = session.bot
  if ((bot.health ?? 0) <= 0) return null
  const foes = require('./flee').hostilesAround(bot, 16).filter(h => !REFUGE_NEUTRAL.test(h.e.name))
  let yaw = bot.entity.yaw
  if (foes.length) {
    const f = foes[0].e.position
    const dx = bot.entity.position.x - f.x
    const dz = bot.entity.position.z - f.z
    yaw = Math.atan2(-dx, -dz)
  }
  try {
    await bot.look(yaw, 0, true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    await sleep(450)
  } catch {} finally { try { bot.clearControlStates() } catch {} }
  await require('./fortify').landed(bot, 1500)
  step(`слез со столба, хп ${Math.round(bot.health ?? 0)}`)
  return { ok: true }
}

async function leaveBox (session, ctl, b, hold, step) {
  const bot = session.bot
  const fortify = require('./fortify')
  session.shelterBox = null
  if (hold.why === 'died' || (bot.health ?? 0) <= 0) return null
  // Отход оборвали (новое намерение, чат, смерть) — стены не ломать и не выходить: решает тот, кто оборвал.
  if (ctl.aborted) return null
  if (!bot.entity.position.floored().equals(b.cell) && !fortify.feetCell(bot).equals(b.cell)) return { ok: true, note: 'уже снаружи' }
  const foes = require('./flee').hostilesAround(bot, 12).filter(h => !REFUGE_NEUTRAL.test(h.e.name))
  const away = foes.length ? foes[0].e.position : null
  let r = null
  // Ниша: выйти тем же проёмом — выломать свои 2 блока и шагнуть.
  if (b.front) {
    let ok = true
    for (const y of [1, 0]) {
      if (ctl.aborted) return null
      if (fortify.solidAt(bot, b.front.offset(0, y, 0))) ok = (await fortify.breakBlock(bot, b.front.offset(0, y, 0), { maxMs: 4000 })) && ok
    }
    if (ok) {
      try {
        await bot.lookAt(b.front.offset(0.5, 1.2, 0.5), true)
        bot.setControlState('forward', true)
        await sleep(400)
      } catch {} finally { try { bot.setControlState('forward', false) } catch {} }
      return { ok: true, front: true }
    }
  }
  try { r = await fortify.breakOut(bot, b.cell, { away }) } catch (e) { r = { ok: false, steps: [e.message] } }
  if (r.ok) {
    try {
      await bot.lookAt(r.exit.offset(0.5, 1.2, 0.5), true)
      bot.setControlState('forward', true)
      await sleep(350)
    } catch {} finally { try { bot.setControlState('forward', false) } catch {} }
  } else {
    step(`выход из коробки: ${(r.steps || []).join('; ')}`)
    // Вбок некуда (коробка в яме, за стенами порода) — вверх, как из норы:
    // крышу долой и столбом (exitShelter).
    try {
      const up = await exitShelter(session, ctl, { depth: 1 })
      step(`выход вверх: ${up.out ? 'вышел' : up.stopped || 'не вышел'}`)
      r = { ok: !!up.out, up: true }
    } catch (e) { step(`выход вверх: ${e.message}`) }
  }
  return r
}

// Из воды на берег — подальше от утопленников (отход, ND_REFUGE_SHORE=1). Прежний ход «всплыть» (surface) поднимал
// голову над водой, и тело оставалось в ней: бегство в воде медленное, утопленник в воде быстрее, трезубец бьёт
// издали (A6 30.09: «none DIED» в воде ×3; разбор A1–A4: 31 смерть из 98 — вода). Здесь: поиск в ширину по
// плавательным клеткам до 16 бл. (как movement.findSwimRoute), каждая сухая клетка-берег — кандидат, цена — длина
// пути плюс штраф за врагов у берега и у пути; плыть спринтом с прыжком, пересчёт раз в 0.6 с; на суше — ещё 4 бл.
// прочь от воды. Возвращает { ok, how, steps, dist } — ok: ноги на сухом.
function shoreRoute (bot, { radius = 16, rise = 6, drop = 4, foes = [] } = {}) {
  const start = bot.entity.position.floored()
  const key = p => `${p.x},${p.y},${p.z}`
  const water = b => !!b && /^(water|bubble_column)$/.test(b.name)
  const passable = b => !!b && b.boundingBox === 'empty' && !/lava/.test(b.name)
  const queue = [{ p: start, parent: -1, n: 0 }]
  const seen = new Set([key(start)])
  const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  let best = null
  // Ближний берег важнее тихого: в воде тело ~1.96 бл/с даже со спринтом (prismarine-physics), трезубец 8 хп раз в 2 с
  // (codex-lab/surv-mobs/MOBS.md §3) — штраф за врага у берега мягкий, на суше утопленник медленнее нас вдвое.
  const danger = p => {
    let c = 0
    for (const f of foes) {
      const d = Math.hypot(f.x - (p.x + 0.5), f.z - (p.z + 0.5))
      if (d < 4) c += (4 - d) * 1.5
    }
    return c
  }
  for (let i = 0; i < queue.length && queue.length < 6000; i++) {
    const { p } = queue[i]
    const feet = bot.blockAt(p)
    const head = bot.blockAt(p.offset(0, 1, 0))
    const floor = bot.blockAt(p.offset(0, -1, 0))
    if (i > 0 && passable(feet) && passable(head) && !water(feet) && !water(head) && floor && floor.boundingBox === 'block' && !water(floor) &&
      !/^(magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|pointed_dripstone|powder_snow)$/.test(floor.name) && !/fire|lava/.test(feet.name)) {
      // Путь до берега: опасность у пути — по точкам пути.
      let k = i
      let pathDanger = 0
      while (queue[k].parent >= 0) { pathDanger += danger(queue[k].p) * 0.5; k = queue[k].parent }
      const cost = queue[i].n + danger(p) + pathDanger
      if (!best || cost < best.cost) best = { i, cost }
      continue // через берег дальше не ищем
    }
    if (best && queue[i].n > best.cost) break
    const over = bot.blockAt(p.offset(0, 2, 0))
    const next = [...sides.map(d => p.plus(d)), p.offset(0, 1, 0)]
    if (passable(over)) next.push(...sides.map(d => p.plus(d).offset(0, 1, 0)))
    for (const q of next) {
      if (Math.max(Math.abs(q.x - start.x), Math.abs(q.z - start.z)) > radius || q.y - start.y > rise || start.y - q.y > drop) continue
      if (seen.has(key(q))) continue
      const f = bot.blockAt(q); const h = bot.blockAt(q.offset(0, 1, 0)); const g = bot.blockAt(q.offset(0, -1, 0))
      if (!passable(f) || !passable(h)) continue
      if (!water(f) && !water(h) && !(g && g.boundingBox === 'block')) continue
      seen.add(key(q))
      queue.push({ p: q, parent: i, n: queue[i].n + 1 })
    }
  }
  if (!best) return null
  const path = []
  let k = best.i
  while (queue[k].parent >= 0) { path.unshift(queue[k].p); k = queue[k].parent }
  return { target: queue[best.i].p, path, cost: Math.round(best.cost) }
}

async function toShore (session, ctl, { timeoutMs = 15000, step = () => {} } = {}) {
  const bot = session.bot
  const flee = require('./flee')
  const t0 = gameClock.now()
  const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
  const stop = () => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(k, false) }
  const dry = () => !inWater(bot) && bot.entity.onGround
  try { bot.pathfinder.setGoal(null) } catch {}
  let route = null
  let planAt = 0
  let target = null
  try {
    while (!ctl.aborted && gameClock.now() - t0 < timeoutMs && (bot.health ?? 0) > 0 && !dry()) {
      if (!route || gameClock.now() - planAt > 600) {
        const foes = flee.hostilesAround(bot, 20).filter(h => !REFUGE_NEUTRAL.test(h.e.name)).map(h => h.e.position)
        // Ближнего берега нет — шире и выше (затопленная лесенка: сухие ступени выше 6 бл.; pool1 02.10 слот 16 — «берега в
        // 16 бл. не вижу» за 0.1 с, утопленник добил).
        route = shoreRoute(bot, { foes }) || shoreRoute(bot, { foes, radius: 24, rise: 14, drop: 8 })
        planAt = gameClock.now()
        if (!route) { step('берега в 16 бл. не вижу'); break }
        if (!target || !target.equals(route.target)) { target = route.target; step(`к берегу ${target.x},${target.y},${target.z} (${route.path.length} кл.)`) }
      }
      const me = bot.entity.position
      // Ближайшая точка пути, до которой ещё не доплыли.
      let next = route.path.find(c => Math.hypot(c.x + 0.5 - me.x, c.z + 0.5 - me.z) > 0.7) || route.target
      const dx = next.x + 0.5 - me.x
      const dz = next.z + 0.5 - me.z
      await bot.look(Math.atan2(-dx, -dz), next.y + 0.5 > me.y + 0.3 ? 0.3 : 0, true).catch(() => {})
      set('forward', true)
      set('sprint', (bot.food ?? 20) > 6)
      set('jump', true)
      await sleep(80)
    }
  } finally { stop() }
  const ok = dry()
  if (ok) {
    // Ещё несколько шагов прочь от воды: утопленник на берегу бьёт из воды, трезубец — по прямой.
    try {
      const me = bot.entity.position
      let wx = 0; let wz = 0; let n = 0
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        for (const dy of [-1, 0]) {
          const b = bot.blockAt(me.offset(dx, dy, dz))
          if (b && b.name === 'water') { wx += dx; wz += dz; n++ }
        }
      }
      if (n) {
        const yaw = Math.atan2(wx / n, wz / n) // прочь от середины воды
        const until = gameClock.now() + 900
        await bot.look(yaw, 0, true).catch(() => {})
        const { stepSafe, keyDir } = require('./moves')
        while (gameClock.now() < until && !ctl.aborted && (bot.health ?? 0) > 0) {
          const f = keyDir(bot, 'forward')
          set('forward', stepSafe(bot, f))
          set('sprint', (bot.food ?? 20) > 6)
          const ahead = bot.blockAt(bot.entity.position.offset(f.x * 0.8, 0, f.z * 0.8).floored())
          set('jump', !!(ahead && ahead.boundingBox === 'block'))
          await sleep(50)
        }
        stop()
        await require('./fortify').landed(bot, 600)
      }
    } catch {} finally { stop() }
  }
  return { ok, seconds: Math.round((gameClock.now() - t0) / 100) / 10, target: target ? xyz(target) : null }
}

// Уход от крипера (автопилот, autopilot.creeperReflex): крипер шипит рядом или подошёл вплотную, а тело занято
// делом (копает, строит спиной к нему). Механика 1.21.11 (Creeper.SwellGoal): шипеть начинает с < 3 бл. до цели и
// стоит на месте, пока шипит; фитиль 30 тиков (1.5 с); шипение гаснет, если цель дальше 7 бл. или не видна. Взрыв
// силы 3 бьёт до 6 бл. (2·сила). Спринт 5.6 бл/с: с 3 бл. до 8 — меньше секунды. Поэтому — не коробка, а рывок прочь
// до 8 бл. (не дольше 3 с), направление — flee.pickDirection (рельеф, обрывы, остальные мобы). Дальше — тот, кто
// звал: кампания после «отхода» дерётся с 1–2 мобами (pvp.js: удар и отход от крипера) или уходит.
async function dodgeCreeper (session, ctl, { id = null, minDist = 8, maxMs = 3000 } = {}) {
  const bot = session.bot
  const flee = require('./flee')
  const { stepSafe, keyDir } = require('./moves')
  const t0 = gameClock.now()
  const hp0 = Math.round(bot.health ?? 0)
  const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
  const stop = () => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(k, false) }
  ctl.onAbort.push(stop)
  try { bot.stopDigging() } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}
  const edgeGuard = require('./edges').guard(bot)
  // Ближний опасный крипер на каждом шаге: шипящий важнее, второй крипер не забывать (ревью Codex 02.10).
  const creeper = () => {
    let best = null
    for (const x of Object.values(bot.entities || {})) {
      if (!x || x.name !== 'creeper' || !x.position || x.isValid === false) continue
      const d = x.position.distanceTo(bot.entity.position)
      if (d >= 9) continue
      let sw = false
      try { sw = flee.creeperSwelling(bot, x) } catch {}
      const score = d - (sw ? 4 : 0) - (x.id === id ? 0.5 : 0)
      if (!best || score < best.score) best = { e: x, d, score }
    }
    return best ? best.e : null
  }
  let dist = null
  let plan = null
  let replanAt = 0
  let prevYaw = null
  let hits = 0
  let hitAt = 0
  let walled = false
  let wall = 0
  let lastPos = bot.entity.position.clone()
  let stuckSince = 0
  try {
    while (!ctl.aborted && gameClock.now() - t0 < maxMs && (bot.health ?? 0) > 0) {
      const c = creeper()
      if (!c) { dist = null; break }
      dist = c.position.distanceTo(bot.entity.position)
      if (dist >= minDist) break
      const now = gameClock.now()
      if (!plan || now >= replanAt) {
        plan = flee.pickDirection(bot, flee.hostilesAround(bot, 16), prevYaw)
        replanAt = now + 250
        if (plan) prevYaw = plan.yaw
      }
      // Бежать некуда (лесенка, тупик) или не сдвинулись за полсекунды, а он вплотную — ударить: отброс 0.4 (+0.5
      // со спринта) выигрывает время до следующего шага прочь (trap1 02.10: в лесенке «ушёл на 3 бл. за 3 с»).
      const moved = bot.entity.position.distanceTo(lastPos)
      if (moved > 0.4) { lastPos = bot.entity.position.clone(); stuckSince = 0 } else if (!stuckSince) stuckSince = now
      // Прижали — сперва заслон: блок между нами на уровне глаз (и ног) рвёт ему видимость, а без неё SwellGoal.tick
      // гасит фитиль (MOBS.md §1). Ставится честно (placeBlockAt honest), ~0.2 с. Не встал — удар.
      if ((!plan || (stuckSince && now - stuckSince > 500)) && dist <= 4.5 && !walled && require('./build').pickFiller(bot)) {
        walled = true
        stop()
        const me = bot.entity.position
        const dx = c.position.x - me.x
        const dz = c.position.z - me.z
        const step = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
        const cell = me.floored().plus(step)
        let put = 0
        for (const dy of [1, 0]) {
          try {
            const r = await require('./build').placeBlockAt(bot, cell.offset(0, dy, 0), { timeoutMs: 500, honest: true, steady: true })
            if (r && r.ok) put++
          } catch {}
        }
        wall = put
        if (put) { await sleep(100); continue }
      }
      if ((!plan || (stuckSince && now - stuckSince > 500)) && dist <= 3.6 && now - hitAt > 650) {
        const aimed = require('./pick').aim(bot, c)
        if (aimed && aimed.point) {
          stop()
          try {
            const w = require('./items').bestWeapon(bot)
            if (w && (!bot.heldItem || bot.heldItem.type !== w.type)) await bot.equip(w, 'hand').catch(() => {})
            await bot.lookAt(aimed.point, true)
            bot.attack(c)
            hits++
          } catch {}
          hitAt = gameClock.now()
          await sleep(100)
          continue
        }
      }
      const me = bot.entity.position
      const yaw = plan ? plan.yaw : Math.atan2(-(me.x - c.position.x), -(me.z - c.position.z))
      bot.look(yaw, 0, true).catch(() => {})
      const f = keyDir(bot, 'forward')
      set('forward', stepSafe(bot, f) || require('./movement').inWater(bot))
      set('sprint', (bot.food ?? 20) > 6)
      const ahead = bot.blockAt(me.offset(f.x * 0.8, 0, f.z * 0.8).floored())
      set('jump', !!(ahead && ahead.boundingBox === 'block'))
      await sleep(50)
    }
  } finally {
    stop()
    edgeGuard.stop()
  }
  const hp = Math.round(bot.health ?? 0)
  const out = {
    how: 'dodge',
    // Фитиль гаснет только при d > 7 (SwellGoal.tick, MOBS.md §1): 7 ровно — ещё шипит.
    code: hp <= 0 ? 'DIED' : dist !== null && dist <= 7.2 ? 'CORNERED' : 'OK',
    hp0,
    hp,
    healed: hp >= 16,
    dist: dist === null ? null : Math.round(dist * 10) / 10,
    hits: hits || undefined,
    wall: wall || undefined,
    seconds: Math.round((gameClock.now() - t0) / 100) / 10
  }
  out.note = `крипер: ушёл на ${out.dist ?? '?'} бл. за ${out.seconds} с, хп ${hp0} → ${hp}`
  if (out.code !== 'OK') out.stopped = `${out.code}: ${out.note}`
  try { session.journal.append('отход', out.note, bot.entity.position) } catch {}
  return out
}

function runDodgeCreeper (session, p = {}) {
  return session.runIntent('refuge', ctl => {
    session.require()
    return dodgeCreeper(session, ctl, p)
  }, { timeoutMs: 8000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] })
}

// Одна точка запуска и для RPC, и для автопилота: те же прерывания и срок.
function runRefuge (session, p = {}) {
  const secs = Math.max(10, Math.min(300, Number(p.maxSeconds) || 120))
  return session.runIntent('refuge', ctl => {
    session.require()
    ctl.entry = session.current
    return refuge(session, ctl, p)
  }, { timeoutMs: (Math.max(secs, sitOn() || p.untilDawn ? SIT_CAP_MS / 1000 : 0) + 60) * 1000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] })
}

module.exports = {
  shelter, recoverLoot, surface, pitCheck, descentPlan, legLevels, seenBy, sinkOne,
  refuge, runRefuge, refugeLook, chooseRefuge, holePlan, pillarPlan, chaseBps, outrun, buildMsOf, REFUGE_NEUTRAL, MOB_SPEED,
  dodgeCreeper, runDodgeCreeper, shoreRoute, toShore, outsideDanger
}

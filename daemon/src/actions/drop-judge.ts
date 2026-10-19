'use strict'
// Цена прыжка вниз: что под ногами, лава рядом, моб на месте приземления, запас хп (judgeDrop).
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { sleep, xyz }: typeof import('../movement') = require('../movement')
// Same "feel the heat" probe digDown uses, applied to a whole step. It looks
// through solid stone, which is only ever allowed to REFUSE a dig — never to
// find anything.
const AROUND_CELL = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]

function hazardAt (bot, cells) {
  for (const c of cells) {
    for (const [dx, dy, dz] of AROUND_CELL) {
      const b = bot.blockAt(c.offset(dx, dy, dz))
      if (!b) continue
      if (/lava/.test(b.name)) return `лава у ${c.x + dx},${c.y + dy},${c.z + dz}`
      if (b.name === 'water') return `вода у ${c.x + dx},${c.y + dy},${c.z + dz}`
    }
  }
  return null
}

// Vanilla fall damage, read out of paper-1.21.11.jar rather than remembered:
// LivingEntity.calculateFallDamage is floor(fall + 1e-6 - safe_fall_distance),
// safe_fall_distance 3, and armour does not enter into it. Three blocks are
// free, four cost one point, six cost three, thirteen cost ten. That arithmetic
// is why a drop is an ordinary move rather than a last resort — and also why a
// paid one is not decided here: only the brain knows whether three points are
// worth paying on the trip it is on, so it says so with maxFallHp.
const fallCost = d => Math.max(0, Math.floor(d) - 3)
const FREE_FALL = 3

// How far a body walking in at the level above `pos` falls before it stands
// again, or null when that is past the free drop. Floor d cells under `pos`
// means feet d lower than they started. The loop used to run to maxDrop + 1,
// and the fourth block is the one that costs a point: a «free» drop that took
// health without asking is exactly what maxFallHp exists to stop.
function floorBelow (bot, pos, maxDrop = FREE_FALL) {
  for (let d = 1; d <= maxDrop; d++) {
    const b = bot.blockAt(pos.offset(0, -d, 0))
    if (!b) return null
    if (/lava|water/.test(b.name)) return null
    if (b.boundingBox === 'block') return d
  }
  return null
}

// floorBelow answers «can I step down here for free» and is allowed to decide a
// step. This answers a different question — «how far is the ground at all» — and
// only ever goes into a sentence, so it may look as far as it likes. The
// distance is the entire difference between «дна не видно» and «до пола шесть
// блоков»: measured at y=-36, the cave floor lay well past the four cells
// floorBelow inspects, which is precisely why the free-drop rule never fired and
// the staircase went hunting for something to prop a block against instead.
//
// Returns how far the body would FALL from `from`, not the index of the block:
// feet in `from` land on top of the solid cell d below, so the fall is d - 1.
// `open` are cells the caller is about to cut: until today the staircase priced
// a jump through its own uncut step as «до пола 0 блоков».
function groundUnder (bot, from, maxDrop = 32, open: any = []) {
  const cut = p => open.some(o => o.x === p.x && o.y === p.y && o.z === p.z)
  for (let d = 1; d <= maxDrop; d++) {
    const at = from.offset(0, -d, 0)
    if (cut(at)) continue
    const b = bot.blockAt(at)
    if (!b) return null
    if (/lava/.test(b.name)) return { fall: d - 1, lava: true }
    if (/water/.test(b.name)) return { fall: d - 1, water: true }
    if (b.boundingBox === 'block') return { fall: d - 1, name: b.name }
  }
  return null
}

const blockWord = n => {
  const t = n % 100
  const u = n % 10
  if (t >= 11 && t <= 14) return 'блоков'
  return u === 1 ? 'блок' : u >= 2 && u <= 4 ? 'блока' : 'блоков'
}

function lavaNear (bot, cell) {
  for (const [dx, dy, dz] of AROUND_CELL) {
    const b = bot.blockAt(cell.offset(dx, dy, dz))
    if (b && /lava/.test(b.name)) return `лава у ${cell.x + dx},${cell.y + dy},${cell.z + dz}`
  }
  return null
}

// Level with the landing, not the whole column: the drift on the same run kept
// stopping for zombies five blocks under its floor, behind rock, and a mob
// that cannot reach the landing is no reason to stay on the ledge. Required
// here, not at the top: combat.js requires this module back.
const MOB_AT_LANDING = 5
// A zombie on a cave floor wanders off in about this long, or it does not and
// the second refusal says so with the same numbers.
const MOB_WAIT_SECONDS = 15
function mobAtLanding (bot, landing) {
  const { HOSTILES }: typeof import('../combat') = require('../combat')
  let best = null
  for (const e of ((Object.values(bot.entities || {}) as any[]) as any)) {
    if (!e || e === bot.entity || !e.position || !HOSTILES.has(e.name)) continue
    const dy = e.position.y - landing.y
    if (dy < -1 || dy > 2) continue
    const dist = Math.hypot(e.position.x - (landing.x + 0.5), e.position.z - (landing.z + 0.5))
    if (dist > MOB_AT_LANDING) continue
    if (!best || dist < best.dist) best = { who: e.name, dist: Math.round(dist * 10) / 10 }
  }
  return best
}

// Health a paid drop must leave standing. Not a number of its own: every long
// dig is interrupted the moment health crosses cfg.lowHealth (session.js,
// low_health), so a drop landing at or under it would reach the brain as
// «interrupted» instead of as the drop it paid for. One above that line.
function fallReserve (session) {
  const low = session && session.cfg && Number.isFinite(session.cfg.lowHealth) ? session.cfg.lowHealth : 8
  return low + 1
}

// A player's full bar. Health Boost could raise it; the bot never drinks one,
// and reading the ceiling low only refuses a jump, never pays for one.
const MAX_HEALTH = 20

// One verdict on «jump here?» for the staircase and the shaft alike, so the
// refusal and the jump can never disagree about the price. `from` is the cell
// the body falls out of, `call` the exact call that would come back and jump.
// ok means jump now: free drops always, paid ones only up to maxFallHp — a
// default that pays health nobody agreed to is a fall, not a move.
//
// maxFallHp is what the whole call may pay, not each drop: `spent` is what it
// already has. Per drop, one «9» said for one twelve-block cave would also buy
// every later drop of the same leg down to the reserve — eleven points taken
// on an agreement to nine.
function judgeDrop (session, bot, from, ground, maxFallHp, spent, call) {
  const hp = Math.round(bot.health ?? 20)
  const reserve = fallReserve(session)
  const pay = Math.max(0, Math.floor(Number(maxFallHp) || 0))
  const left = Math.max(0, pay - spent)
  const base = { hp, reserve, maxFallHp: pay, spent }
  if (!ground) {
    return { ...base, ok: false, drop: 'deep', text: 'дна не видно на 32 блока вниз — не прыгаю ни с каким maxFallHp' }
  }
  const fall = ground.fall
  const inBlocks = `в ${fall} ${fall % 10 === 1 && fall % 100 !== 11 ? 'блоке' : 'блоках'}`
  const toFloor = `до пола ${fall} ${blockWord(fall)}`
  if (ground.lava) return { ...base, ok: false, drop: 'lava', fall, text: `${inBlocks} внизу лава — не прыгаю` }
  if (ground.water) return { ...base, ok: false, drop: 'water', fall, text: `внизу вода ${inBlocks} — в воду вслепую не прыгаю` }
  const cost = fallCost(fall)
  const after = hp - cost
  const landing = from.offset(0, -fall, 0)
  const out = { ...base, fall, floor: ground.name, cost, after, landing: xyz(landing) }
  const hot = lavaNear(bot, landing)
  if (hot) return { ...out, ok: false, drop: 'hazard', text: `${toFloor}, но у места приземления ${hot} — не прыгаю` }
  if (cost === 0) return { ...out, ok: true, drop: 'free' }
  // A price no health can pay is not a price. «Подлечись» used to be said for
  // it too, with healTo = cost + reserve: 21 for fifteen blocks, 23 for
  // seventeen, and the named retry at full health came back with the same
  // refusal from the same spot (review of 2026-09-15). So no retry and no heal
  // target here — the caller names the moves that do exist instead.
  if (cost + reserve > MAX_HEALTH) {
    return {
      ...out,
      ok: false,
      drop: 'high',
      text: `${toFloor}, прыжок стоит ${cost} хп — даже с полными ${MAX_HEALTH} осталось бы ${MAX_HEALTH - cost}, ` +
        `а ниже ${reserve} не прыгаю ни с каким maxFallHp`
    }
  }
  // A paid drop lands short of full health in a cave nobody has lit, and on the
  // run it was meant for the cave floor had zombies on it. A mob at the landing
  // is part of the price, and not one maxFallHp can pay. The words name a wait
  // and a call, so the fields carry the same wait and the same call.
  const mob = mobAtLanding(bot, landing)
  if (mob) {
    return {
      ...out,
      ok: false,
      drop: 'mob',
      mob,
      waitSeconds: MOB_WAIT_SECONDS,
      retry: { maxFallHp: cost },
      text: `${toFloor}, но у места приземления ${mob.who} в ${mob.dist} бл. — прыгать к нему на ${after} хп не буду; ` +
        `подожди mc_wait seconds=${MOB_WAIT_SECONDS}, пока уйдёт, и зови ${call} maxFallHp=${cost}`
    }
  }
  if (after < reserve) {
    // Natural regeneration is a point per four seconds on a fed bar, which is
    // the only way this number turns into a jump without anyone's help.
    const healTo = cost + reserve
    const waitSeconds = Math.min(300, (healTo - hp) * 4)
    return {
      ...out,
      ok: false,
      drop: 'hurt',
      healTo,
      waitSeconds,
      retry: { maxFallHp: cost },
      text: `${toFloor}, прыжок стоит ${cost} хп, а у меня ${hp} — осталось бы ${after}, ` +
        `а ниже ${reserve} не прыгаю ни с каким maxFallHp; подлечись до ${healTo}: mc_eat, потом ` +
        `mc_wait seconds=${waitSeconds}, и зови ${call} maxFallHp=${cost}`
    }
  }
  if (cost > left) {
    const already = spent > 0 ? `; из maxFallHp=${pay} этого вызова ${spent} уже ушло на прыжки выше` : ''
    return {
      ...out,
      ok: false,
      drop: 'price',
      retry: { maxFallHp: cost },
      text: `${toFloor}, прыжок стоит ${cost} хп из ${hp} (останется ${after})${already}; ` +
        `прыгну, если позовёшь ${call} maxFallHp=${cost}`
    }
  }
  return { ...out, ok: true, drop: 'paid' }
}

// The machine half of a drop refusal: everything the words say, minus the words.
function dropFields (v) {
  const { ok, text, ...fields } = v
  return fields
}

// Wait out a fall the body has already started. Health is read a beat after
// landing: the server applies fall damage on the landing tick and update_health
// reaches us a packet later.
async function settleFall (bot, ctl, fromY, fall) {
  const until = gameClock.now() + 1500 + fall * 150
  while (gameClock.now() < until && !ctl.aborted) {
    if (bot.entity.onGround && bot.entity.position.floored().y < fromY) break
    await sleep(50)
  }
  await sleep(400)
}

// What a drop actually cost next to what it was priced at. The two disagreeing
// is either a mob hitting during the fall or fallCost being wrong, and only a
// report that carries both numbers can tell the brain which. Returns what the
// drop takes out of maxFallHp: the larger of the two, because a budget the
// brain set is a ceiling on health lost, whatever took it.
function recordDrop (drops, bot, feet, fell, jump) {
  const now = bot.health ?? 20
  const rec = {
    from: xyz(feet),
    to: xyz(bot.entity.position),
    fell,
    cost: jump.verdict.cost,
    paid: Math.max(0, Math.round(jump.hp - now)),
    hp: Math.round(now)
  }
  drops.push(rec)
  return Math.max(rec.cost, rec.paid)
}

export { hazardAt, fallCost, FREE_FALL, floorBelow, groundUnder, lavaNear, judgeDrop, dropFields, settleFall,
  recordDrop }

'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { xyz } from '../movement'
import { itemNamed } from '../items'
import { placeBlockAt } from '../build'
import * as worlds from '../worlds'
import { WALK_MS, walkTo } from './window'
import { BASE, iso, readBase, patchBase, stashTotals, chestView, aliveChests, freeSlots, stalest } from './base-record'
import { chestList } from './chest'
import { CARDINALS4, surfaceAt, openSky, pickBaseSpot } from './base-spot'
import { liveShelves, needBase, awayFrom, walkHome } from './shelves'

// Instant by design: knowing where home is and what lies in it must never cost
// a turn, and must answer with the body offline.
function baseNow (session, { mode = 'where', name = BASE }: any = {}) {
  const how = String(mode || 'where').trim().toLowerCase()
  if (how === 'forget') {
    const had = readBase(session, name)
    session.journal.patch(s => { if (s.places) delete s.places[name] })
    session.journal.append('база', `забыл базу «${name}»${had ? ` на ${had.x},${had.y},${had.z}` : ''}`, null)
    return { forgot: name, was: had ? { x: had.x, y: had.y, z: had.z } : null }
  }
  if (how !== 'where') throw new Error(`не знаю режим ${mode}, бывает where / set / go / forget`)

  const rec = readBase(session, name)
  if (!rec) {
    return { base: null, note: `базы «${name}» нет. base mode=set выберет место там, где я стою, поставит сундук и запишет координаты` }
  }
  const bot = session.bot && session.bot.entity ? session.bot : null
  const alive = aliveChests(rec)
  const away = bot ? awayFrom(bot, rec) : null

  const parts = [`база на ${rec.x},${rec.y},${rec.z}`]
  if (away !== null) parts.push(away <= 4 ? 'я на ней' : `до неё ${away} блоков`)
  if (bot && !worlds.sameWorld(bot, rec)) parts.push(`она ${worlds.inWorld(worlds.worldOfRecord(rec))}, а я ${worlds.inWorld(worlds.worldOf(bot))} — домой только через портал (mc_portal mode=enter)`)
  parts.push(alive.length
    ? `общак: ${alive.length} сундук(ов), свободно ${freeSlots(rec)} слотов`
    : 'сундуков в памяти нет — stash mode=put найдёт или поставит')
  if (alive.length && stalest(rec) >= 30) {
    parts.push(`это память, сундук не открывали ${stalest(rec)} мин — stash mode=check пересчитает`)
  }
  if (rec.why) parts.push(rec.why)

  return {
    base: { x: rec.x, y: rec.y, z: rec.z, name, since: rec.since || null, sky: rec.sky },
    away,
    chests: rec.chests.map(chestView),
    stash: stashTotals(rec),
    furnace: rec.furnace || null,
    table: rec.table || null,
    note: parts.join('; ')
  }
}

async function baseGo (session, ctl, { name = BASE, range = 3, timeoutSeconds = 120 }: any = {}) {
  const bot = session.bot
  const rec = needBase(session, name)
  const deadline = gameClock.now() + Math.max(10, Math.min(600, timeoutSeconds)) * 1000

  // База в другом мире: ни шага. Pathfinder честно пошёл бы к тем же числам в
  // Аду — к лаве, а не домой (NETHER.md §4, строка 5).
  const other = worlds.refuseOtherWorld(bot, rec, `База «${name}»`)
  if (other) {
    return {
      went: false,
      moved: 0,
      world: { here: worlds.worldOf(bot), record: worlds.worldOfRecord(rec) },
      base: { x: rec.x, y: rec.y, z: rec.z, name },
      stopped: other
    }
  }

  const walk: any = await walkHome(session, ctl, rec, { range, deadline })
  // away is null when there is no body to measure from (death mid-walk), and
  // `null <= 5` is true — which would report a corpse as "дошёл".
  const arrived = walk.away !== null && walk.away <= Math.max(4, range + 2)

  const shelves = arrived
    ? await liveShelves(session, ctl, rec, { grow: false })
    : { ok: [], lost: [], unloaded: [] }
  const fresh = readBase(session, name) || rec

  const parts = []
  if (!arrived) {
    parts.push(`не дошёл: до базы ещё ${walk.away} блоков (${walk.trip.error || 'время вышло'}) — позови ещё раз`)
  } else {
    parts.push(`на базе ${rec.x},${rec.y},${rec.z}`)
    parts.push(shelves.ok.length ? `сундуков на месте ${shelves.ok.length}` : 'сундуков на месте нет')
  }
  if (shelves.lost.length) {
    parts.push(`сундук сломан на ${shelves.lost.map(c => `${c.x},${c.y},${c.z} (там ${c.instead})`).join('; ')} — stash mode=put поставит новый`)
  }
  if (shelves.unloaded.length) {
    parts.push(`${shelves.unloaded.length} сундук(ов) в непрогруженных чанках — это не «сломали»: подожди и позови ещё раз`)
  }
  if (walk.climbedOut) parts.push(`из ямы вылез на ${walk.climbedOut}`)

  return {
    at: { x: rec.x, y: rec.y, z: rec.z },
    arrived,
    away: walk.away,
    // Dying on the way home replaces bot.entity, and reading .position off the
    // gap is a TypeError where the honest answer is "тела нет". The intent is
    // interrupted by then, but the throw would still bury the walk's result.
    standing: bot.entity ? xyz(bot.entity.position) : null,
    chests: fresh.chests.map(chestView),
    lost: shelves.lost.length ? shelves.lost : undefined,
    unloaded: shelves.unloaded.length ? shelves.unloaded : undefined,
    stash: stashTotals(fresh),
    climbedOut: walk.climbedOut,
    note: parts.join('; ')
  }
}

async function baseSet (session, ctl, { name = BASE, x, y, z, radius = 10, move = false, torch = true }: any = {}) {
  const bot = session.bot
  const had = readBase(session, name)
  // Refusing is the right answer, not an error: a second `set` from the mine
  // would otherwise quietly move home and orphan the whole stash.
  if (had && move !== true) {
    const away = awayFrom(bot, had)
    return {
      already: true,
      at: { x: had.x, y: had.y, z: had.z },
      away,
      chests: had.chests.map(chestView),
      stash: stashTotals(had),
      note: `база уже есть на ${had.x},${had.y},${had.z} (${away} блоков отсюда). move=true — перенести сюда, base mode=go — вернуться`
    }
  }

  const given = x !== undefined && x !== null && z !== undefined && z !== null
  let spot = null
  let why = null

  if (given) {
    const fromY = Math.floor(y === undefined || y === null ? bot.entity.position.y : y)
    const at = new Vec3(Math.floor(x), fromY, Math.floor(z))
    if (!bot.blockAt(at)) throw new Error(`на ${at.x},${at.y},${at.z} мир не прогружен — дойди туда и позови без координат`)
    const p = surfaceAt(bot, at.x, at.z, at.y, 4)
    if (!p) throw new Error(`на ${at.x},${at.y},${at.z} встать негде: нет твёрдого пола с двумя блоками воздуха над ним`)
    spot = p
    why = 'место указано мозгом'
  } else {
    const found = pickBaseSpot(bot, { radius: Math.max(4, Math.min(24, radius)) })
    if (!found.best) {
      throw new Error(
        `в ${found.radius} блоках базу ставить негде: осмотрел ${found.saw.колонок} колонок, ` +
        `проверил ${found.saw.проверено} из них, тесно у ${found.saw.тесно}, лава рядом у ${found.saw.лава}, ` +
        `сыпучая земля у ${found.saw.сыпучая}, встать негде в ${found.saw.нетпола}. ` +
        'отойди на десяток блоков и позови ещё раз или подними radius')
    }
    spot = found.best.pos
    why = found.best.why
  }

  const deadline = gameClock.now() + 60000
  if (bot.entity.position.distanceTo(spot) > 1.5) {
    try {
      await walkTo(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 1), Math.min(WALK_MS * 2, Math.max(2000, deadline - gameClock.now())))
    } catch (e) {
      throw new Error(`до места ${spot.x},${spot.y},${spot.z} не дошёл: ${e.message}`)
    }
  }

  const sky = openSky(bot, spot, 40)
  patchBase(session, name, r => {
    r.x = spot.x
    r.y = spot.y
    r.z = spot.z
    r.dimension = bot.game ? bot.game.dimension : null
    r.since = r.since && !move ? r.since : iso()
    r.why = why
    r.sky = sky
    // A move keeps nothing: the old shelves stand at the old place.
    if (move || !Array.isArray(r.chests)) r.chests = []
  })

  // A torch is not decoration. It stops mobs spawning on the square the bot
  // trades on, and at night it is the only thing that says "this is the place"
  // from thirty blocks away.
  let lit = false
  if (torch !== false && itemNamed(bot, 'torch')) {
    for (const [dx, dz] of CARDINALS4) {
      const p = spot.offset(dx, 0, dz)
      const b = bot.blockAt(p)
      if (!b || b.boundingBox !== 'empty') continue
      try { await placeBlockAt(bot, p, { item: 'torch', timeoutMs: 1200 }) } catch {}
      const now = bot.blockAt(p)
      if (now && /torch/.test(now.name)) { lit = true; break }
    }
  }

  const shelves = await liveShelves(session, ctl, readBase(session, name), { grow: true })

  // Count the fresh shelf once, standing right here: that first entry is what
  // the brain reads later without walking.
  if (shelves.ok.length) {
    try { await chestList(session, ctl, xyz(shelves.ok[0].position)) } catch {}
  }

  const furnace = bot.findBlock({ matching: b => !!b && /^(furnace|blast_furnace|smoker)$/.test(b.name), maxDistance: 6 })
  const table = bot.findBlock({ matching: b => !!b && b.name === 'crafting_table', maxDistance: 6 })
  patchBase(session, name, r => {
    r.furnace = furnace ? xyz(furnace.position) : null
    r.table = table ? xyz(table.position) : null
  })

  const out = readBase(session, name)
  const parts = [`база на ${spot.x},${spot.y},${spot.z}: ${why}`]
  parts.push(shelves.ok.length
    ? `общак: ${shelves.ok.length} сундук(ов)`
    : `сундука нет — ${(shelves.built && shelves.built.why) || 'поставить не вышло'}`)
  if (lit) parts.push('горит факел')
  if (furnace) parts.push('печь рядом')
  if (table) parts.push('верстак рядом')
  if (sky === false) parts.push('небо закрыто — сюда mc_surface не выйдет')

  session.journal.append('база', parts.join('; '), spot)

  return {
    at: { x: spot.x, y: spot.y, z: spot.z },
    moved: !!(had && move),
    why,
    sky,
    torch: lit,
    chests: out.chests.map(chestView),
    furnace: out.furnace,
    table: out.table,
    note: parts.join('; ')
  }
}

// Reading is the default on both dispatchers. A tool called with no mode at
// all must not move the body or move somebody's goods: `mc_base` answers where
// home is, `mc_stash` answers what is in it.
async function base (session, ctl, p: any = {}) {
  const how = String(p.mode || 'where').trim().toLowerCase()
  if (how === 'set') return baseSet(session, ctl, p)
  if (how === 'go') return baseGo(session, ctl, p)
  if (how === 'where' || how === 'forget') return baseNow(session, p)
  throw new Error(`не знаю режим ${p.mode}, бывает where / set / go / forget`)
}

export { baseNow, base }

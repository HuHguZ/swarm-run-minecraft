'use strict'
import * as gameClock from './game-clock'
import { goals } from 'mineflayer-pathfinder'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz, inWater, escapeWater } from './movement'
import { eat } from './actions'
import { HOSTILES, liveAttacker } from './combat'

// Escorting a player, watched. session.follow sets a GoalFollow and returns, and
// everything that goes wrong afterwards goes wrong silently: GoalFollow.isValid
// only asks `entity != null` (node_modules/mineflayer-pathfinder/lib/goals.js:363)
// and the entity object survives the player logging out, so the goal outlives
// the player it was pointed at. Nobody measures the gap, nobody looks at hunger,
// nobody notices the lava. This module is the standing watch that does.

// How often the watch looks. Sprint is off (session.js:109), so the body covers
// under two blocks between two looks — a hazard eight blocks down the line is
// still six blocks away when it is reported.
const WATCH_MS = 400

// Past this the escort is over. Closing a gap this size is a journey with its
// own hazards and its own budget, and calling it "escort" is what let the body
// walk off into the dark behind a player who had already teleported away.
const GIVE_UP = 40

// How far past `distance` counts as falling behind. GoalFollow only re-plans
// when the player leaves the goal radius (goals.js:349 hasChanged), so a gap of
// exactly `distance` is the normal resting state and not a lag.
const LAG_MARGIN = 2

// How far down the line between us and the player the hazard scan looks.
const SCAN_AHEAD = 8

// A hole this deep is one the body cannot follow anyone into: pathfinder refuses
// to plan a drop further than Movements.maxDropDown, which is 4
// (node_modules/mineflayer-pathfinder/lib/movements.js:107).
const DROP_DEEP = 5

// A hole is only reported from its rim — the cell before it has to be ground we
// could be standing on. Without that rule any hillside reads as a cliff: on an
// even descent the cell eight blocks out is six blocks below our feet and looks
// from here exactly like the edge of a ravine.
const DROP_REACH = 5

// A failed meal must not be retried every 400 ms. The autopilot's own eater is
// rate-limited by its one-second tick; this loop is faster than that.
const EAT_RETRY_MS = 15000

// Being in water is normally the autopilot's problem, but the autopilot counts
// a running intent as busy (autopilot.js:62) and stands down for exactly as long
// as an escort lasts. Same three seconds it uses, so behaviour does not change
// depending on who is watching.
const WET_MS = 3000

const round1 = n => Math.round(n * 10) / 10
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const at = p => `${p.x},${p.y},${p.z}`

function clamp (value, lo, hi, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

// Where each player was last actually seen. mineflayer deletes the whole record
// the moment somebody logs out (node_modules/mineflayer/lib/plugins/entities.js:740
// `delete bot.players[player.username]`), so without this the honest answer to
// "не вижу игрока" would be a shrug with no facts in it.
const LAST_SEEN = new Map()

function rememberSeen (name, pos) {
  LAST_SEEN.set(name, { ...pos, at: gameClock.now() })
}

// This process first, then memory: LAST_SEEN dies with the daemon, and the
// journal is the only copy that survives a restart.
function recallSeen (session, name) {
  const live = LAST_SEEN.get(name)
  if (live) return { x: live.x, y: live.y, z: live.z, agoSeconds: Math.round((gameClock.now() - live.at) / 1000) }
  try {
    const rec = session.journal.state.people[name]
    const seen = rec && typeof rec === 'object' ? rec.lastSeen : null
    if (!seen) return null
    return { x: seen.x, y: seen.y, z: seen.z, at: seen.at }
  } catch {
    return null
  }
}

// Non-destructive: `people` is documented as a free-form note per username
// (journal.js:9) and older entries really are plain strings.
function noteSeen (session, name, pos) {
  try {
    session.journal.patch(s => {
      const prev = s.people[name]
      const base = prev && typeof prev === 'object' ? prev : (prev ? { note: prev } : {})
      s.people[name] = { ...base, lastSeen: { ...pos, at: new Date().toISOString() } }
    })
  } catch {}
}

function seenLine (seen) {
  if (!seen) return null
  const when = typeof seen.agoSeconds === 'number' ? `${seen.agoSeconds}с назад` : seen.at
  return `последний раз видел на ${at(seen)} (${when})`
}

// What lies on the straight line between us and the player. Only the line and
// only in front: pathfinder walks around a lava lake off to one side by itself
// (lava is in Movements.blocksToAvoid — movements.js:53), and stopping for
// scenery would end every escort underground on the first cave.
//
// An unreadable block is skipped rather than treated as air. Assuming air is how
// a chunk that has not arrived yet turns into a reported cliff.
function pathHazard (bot, target) {
  const me = bot.entity.position
  const dx = target.x - me.x
  const dz = target.z - me.z
  const span = Math.hypot(dx, dz)
  if (span < 1) return null
  const limit = Math.min(SCAN_AHEAD, Math.floor(span))

  // How far the floor is below a cell: 0 means solid ground right under it, null
  // means the column could not be read at all. We start on our own feet, which
  // are by definition standing on something.
  const drop = (cell) => {
    let open = 0
    for (let k = 1; k <= DROP_DEEP; k++) {
      const b = bot.blockAt(cell.offset(0, -k, 0))
      if (!b) return null
      if (b.boundingBox === 'block') return open
      open++
    }
    return open
  }

  let prev = 0
  for (let d = 1; d <= limit; d++) {
    const cell = new Vec3(
      Math.floor(me.x + (dx / span) * d),
      Math.floor(me.y),
      Math.floor(me.z + (dz / span) * d)
    )

    // Feet, body and the block we would stand on: all three burn.
    for (const dy of [-1, 0, 1]) {
      const b = bot.blockAt(cell.offset(0, dy, 0))
      if (b && /lava/.test(b.name)) return { kind: 'лава', at: xyz(b.position), dist: d }
    }

    const below = drop(cell)
    if (below === null) { prev = 0; continue }
    if (d <= DROP_REACH && below >= DROP_DEEP && prev <= 1) {
      return { kind: 'обрыв', at: xyz(cell), dist: d, depth: below }
    }
    prev = below
  }
  return null
}

// Did a mob get its teeth into us during THIS escort? The identity comes from
// combat.trackAttackers, which remembers the last hit whatever it was
// (combat.js:73) — including another player's punch, which is not a reason to
// abandon that player's own escort.
function biteBy (session, since) {
  const rec = session.lastAttacker
  if (!rec || rec.at < since) return null
  const live = liveAttacker(session)
  if (live && live.type === 'player') return null
  if (!live && !HOSTILES.has(rec.name)) return null
  const pos = live && live.position ? live.position : null
  return {
    mob: rec.name,
    at: pos ? xyz(pos) : rec.pos,
    dist: pos ? round1(pos.distanceTo(session.bot.entity.position)) : null,
    gone: !pos
  }
}

async function escort (session, ctl, { player, distance = 3, forSeconds = 60 }: any = {}) {
  const bot = session.bot
  const name = String(player || '').trim()
  if (!name) throw new Error('кого сопровождать? escort нужен player — ник игрока')

  const keep = clamp(distance, 1, 16, 3)
  const budget = clamp(forSeconds, 5, 300, 60)
  const startedAt = gameClock.now()
  const deadline = startedAt + budget * 1000
  const from = xyz(bot.entity.position)
  const elapsed = () => Math.round((gameClock.now() - startedAt) / 1000)

  // A nick typed from memory in the wrong case must not come back as "такого
  // игрока нет" about somebody standing two blocks away.
  const key = bot.players[name]
    ? name
    : Object.keys(bot.players).find(n => n.toLowerCase() === name.toLowerCase())

  const online = Object.keys(bot.players).filter(n => n !== bot.username)

  if (!key) {
    const seen = recallSeen(session, name)
    return {
      player: { name, online: false },
      onlineNow: online,
      lastSeen: seen || undefined,
      from,
      at: from,
      seconds: 0,
      walked: 0,
      stopped: `${name} не на сервере`,
      note:
        (online.length ? `сейчас онлайн: ${online.join(', ')}` : 'на сервере вообще никого нет') +
        `; ${seenLine(seen) || `где ${name} — не знаю`}. ` +
        'Сопровождать некого: проверь ник, или дождись события player_joined и зови escort снова.'
    }
  }

  if (!bot.players[key].entity) {
    // Loaded in the tab list, absent as an entity: mineflayer nulls the entity
    // when the server stops sending it (entities.js:295), which means he is
    // beyond render distance or in another dimension.
    const seen = recallSeen(session, key)
    return {
      player: { name: key, online: true, loaded: false },
      onlineNow: online,
      lastSeen: seen || undefined,
      from,
      at: from,
      seconds: 0,
      walked: 0,
      stopped: `${key} на сервере, но не прогружен — он дальше прорисовки или в другом мире`,
      note:
        `${seenLine(seen) || 'где он — не знаю'}. Подойди ближе` +
        (seen ? ` (mc_goto ${seen.x} ${seen.z})` : ' (mc_goto к его координатам)') +
        ' или спроси координаты в чате (mc_say), потом зови escort снова.'
    }
  }

  // Everything that outlives this function is torn down here, and it is the
  // whole reason escort exists as an intent. runIntent answers the brain the
  // moment an interrupt or the outer timeout fires and leaves the worker running
  // behind it (session.js:292-297); a follow goal left standing then keeps
  // walking the body long after the answer said it had stopped. That exact bug
  // cost a craft eleven levels of unplanned descent.
  const stand = () => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  }
  ctl.onAbort.push(stand)

  let target = bot.players[key].entity
  const arm = () => bot.pathfinder.setGoal(new goals.GoalFollow(target, keep), true)
  arm()

  let last = bot.entity.position.clone()
  let seenAt = xyz(target.position)
  let gap = round1(target.position.distanceTo(bot.entity.position))
  let maxGap = gap
  let closest = gap
  let walked = 0
  let lagged = 0
  let behind = false
  let meals = 0
  let lastMeal = 0
  let wetSince = null
  let need = null
  let threat = null
  let stopped = null
  let note = null

  try {
    for (;;) {
      // The wait is deliberately not abortable. The abort handler above has
      // already stopped the body, so the worst this costs is that the loop
      // notices 400 ms late — and the check below runs before anything can
      // re-arm the goal that abort just cleared.
      await sleep(WATCH_MS)
      if (ctl.aborted) { stopped = `прервано на ${elapsed()}-й секунде`; break }
      if (gameClock.now() >= deadline) break

      const here = bot.entity.position
      walked += flat(here, last)
      last = here.clone()

      const rec = bot.players[key]
      if (!rec) {
        stopped = `${key} вышел с сервера на ${elapsed()}-й секунде сопровождения`
        note =
          `сопровождать некого, встал на ${at(xyz(here))}, он ушёл с ${at(seenAt)}. ` +
          'Вернётся — придёт событие player_joined, тогда зови escort снова; сам он не возобновится.'
        break
      }
      if (!rec.entity) {
        stopped = `${key} пропал из виду на ${elapsed()}-й секунде — ушёл дальше прорисовки`
        note =
          `последний раз был на ${at(seenAt)}, я на ${at(xyz(here))}, разрыв был ${gap} бл. ` +
          `Сходи туда (mc_goto ${seenAt.x} ${seenAt.z}) или спроси в чате, куда он делся (mc_say).`
        break
      }
      // The entity object is replaced when a player re-enters render distance,
      // and GoalFollow stores the reference it was built with (goals.js:328), so
      // the goal is re-pointed instead of left aiming at an object nobody updates.
      if (rec.entity !== target) { target = rec.entity; arm() }

      seenAt = xyz(target.position)
      rememberSeen(key, seenAt)
      gap = round1(target.position.distanceTo(here))
      if (gap > maxGap) maxGap = gap
      if (gap < closest) closest = gap
      if (gap > keep + LAG_MARGIN) {
        if (!behind) { behind = true; lagged++ }
      } else behind = false

      if (gap > GIVE_UP) {
        stopped = `${key} в ${gap} бл. — не догнать (сопровождение держит до ${GIVE_UP})`
        note =
          `он на ${at(seenAt)}, я встал на ${at(xyz(here))}. С такого разрыва это уже дорога, а не ` +
          `сопровождение: иди mc_goto ${seenAt.x} ${seenAt.z}, а как будешь рядом — зови escort снова.`
        break
      }

      // Not our fight, and saying so is the point. Which mob and how close is
      // what the brain needs to choose between mc_fight and walking the player
      // out; escort choosing for it is how a courier turns into a corpse.
      const bite = biteBy(session, startedAt)
      if (bite) {
        threat = { mob: bite.mob, where: 'рядом', dist: bite.dist, at: bite.at }
        stopped =
          `${bite.mob} бьёт меня` +
          (bite.dist === null ? ` (сам он уже не виден, бил у ${at(bite.at)})` : `, он в ${bite.dist} бл. на ${at(bite.at)}`) +
          ' — сопровождение бросаю'
        note =
          `драться или уходить — твоё решение, escort его не принимает: либо mc_fight ${bite.mob}, ` +
          `либо уводи ${key} отсюда. ${key} остался на ${at(seenAt)}; escort сам не возобновится.`
        break
      }

      const hz = pathHazard(bot, target.position)
      if (hz && hz.dist < gap) {
        stopped = `${hz.kind} на пути в ${hz.dist} бл. у ${at(hz.at)} — за ним туда не иду`
        note =
          `${key} на ${at(seenAt)}, между нами ${hz.kind}. Обходить сам не буду: скажи ему вернуться ` +
          `(mc_say) или проведи тело в обход через mc_goto, потом зови escort снова.`
        break
      }

      if (inWater(bot)) {
        if (!wetSince) wetSince = gameClock.now()
        else if (gameClock.now() - wetSince > WET_MS) {
          wetSince = null
          const out = await escapeWater(bot, ctl)
          if (!out.ok) {
            stopped = `застрял в воде на ${at(xyz(bot.entity.position))} — сопровождение отсюда не идёт`
            note = `${key} на ${at(seenAt)}. Вытащи тело сам (mc_goto на сушу), потом зови escort снова.`
            break
          }
          // escapeWater clears the pathfinder goal on entry (movement.js:144),
          // so the follow has to be put back or the body stands on the bank.
          // Not after an abort, though: re-arming there is the very bug this
          // module exists to remove.
          if (!ctl.aborted) arm()
        }
      } else wetSince = null

      // Hunger, through the brain's own eat() and the same one-mouth flag the
      // autopilot uses (autopilot.js:306): mineflayer's consume() opens by
      // cancelling any bite already in flight, so two eaters is two failed meals.
      // The autopilot cannot do this for us — it stands down while an intent runs.
      const eatBelow = session.cfg.eatBelowFood ?? 16
      if ((bot.food ?? 20) <= eatBelow && !session.eating && gameClock.now() - lastMeal > EAT_RETRY_MS) {
        lastMeal = gameClock.now()
        session.eating = true
        const meal = await eat(session, {}).catch(() => null).finally(() => { session.eating = false })
        if (meal && meal.ate) {
          meals++
          session.bus.emit('ate', { item: meal.ate, food: meal.food })
        } else if (meal && !meal.ate) {
          need = { what: 'еда', count: 1, have: 0 }
        }
      }
    }
  } finally {
    // Belt and braces with ctl.onAbort: this covers the ordinary end of the
    // loop, where nothing was aborted and the goal would otherwise stay armed.
    stand()
  }

  const endedAt = xyz(bot.entity.position)
  const seconds = elapsed()
  walked = Math.round(walked)

  if (!stopped) {
    note =
      `сопровождал ${key} ${seconds}с: прошёл ${walked} бл., отставал ${lagged} раз, ` +
      `макс. разрыв ${round1(maxGap)} бл., на конец ${gap} бл. Время вышло — надо дальше, зови escort снова; ` +
      'тело сейчас стоит на месте.'
  }
  if (need) note += ' Еды в рюкзаке нет — на длинной дороге это следующая остановка.'

  noteSeen(session, key, seenAt)
  if (walked || stopped) {
    try {
      session.journal.append(
        'сопровождение',
        `${key}: ${walked} бл. за ${seconds}с, разрыв макс ${round1(maxGap)}, отставал ${lagged} раз` +
        (stopped ? ` (встал: ${stopped})` : ''),
        bot.entity.position
      )
    } catch {}
  }

  return {
    player: { name: key, at: seenAt, gap, online: !!bot.players[key] },
    from,
    at: endedAt,
    distance: keep,
    seconds,
    walked,
    lagged,
    maxGap: round1(maxGap),
    closest: round1(closest),
    meals,
    threat: threat || undefined,
    need: need || undefined,
    stopped: stopped || undefined,
    note
  }
}

export { escort, pathHazard }

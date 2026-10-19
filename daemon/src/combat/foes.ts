'use strict'
// Бой (combat.ts): кто враг, кто нас ударил, цель боя, сколько их рядом.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { xyz }: typeof import('../movement') = require('../movement')
const { raySees, eyePos }: typeof import('../perception') = require('../perception')
const { isPlayerEntity }: typeof import('../social') = require('../social')

const HOSTILES = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'parched',
  'wither_skeleton', 'spider', 'cave_spider', 'creeper', 'enderman', 'endermite',
  'silverfish', 'witch', 'slime', 'magma_cube', 'blaze', 'ghast', 'phantom',
  'pillager', 'vindicator', 'evoker', 'vex', 'ravager', 'illusioner',
  'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'guardian', 'elder_guardian',
  'shulker', 'warden', 'breeze', 'creaking'
])

// Everything that can hurt us without touching us. The distinction matters
// because the two threats want opposite retreats: from a zombie you walk away,
// from a skeleton walking away is just presenting your back. Drowned and
// piglins are only sometimes armed at range — assumed armed, because guessing
// wrong the cautious way costs a few seconds and guessing wrong the other way
// costs the run.
const RANGED = new Set([
  'skeleton', 'stray', 'bogged', 'parched', 'witch', 'pillager', 'illusioner',
  'blaze', 'ghast', 'shulker', 'drowned', 'piglin', 'breeze', 'evoker'
])

// Two blocks of pillar puts you out of reach of anything that has to walk up
// and touch you — except the things that do not walk. Spiders climb, creepers
// blow the pillar out from under you, endermen teleport onto it, and slimes are
// tall enough to hit you anyway. Those get distance instead.
const CANNOT_BE_OUTPILLARED = new Set([
  'spider', 'cave_spider', 'creeper', 'enderman', 'slime', 'magma_cube',
  'warden', 'ravager', 'phantom', 'vex'
])

// --------------------------------------------------------------- who hit me

// Underground, "не вижу цель" is the ordinary answer nearestEntity() gives
// about the thing that is beating on us: the drift bends, the mob stands in an
// unlit chunk behind the corner, and by the time the brain gets its turn 10-30
// seconds later the entity may already be out of bot.entities. The identity is
// only available at the moment of the hit, so it has to be caught then.
//
// Checked against the mineflayer actually installed here (4.37.1) rather than
// from memory: lib/plugins/entities.js has a `damage_event` handler (the 1.20+
// packet, and 1.21.11 does carry it — sourceTypeId / sourceCauseId /
// sourceDirectId) which emits `entityHurt(victim, source)` with source resolved
// from sourceCauseId. The older `entity_status` path emits the same event name
// with no second argument, so a missing source is a real case, not decoration.
const ATTACKER_TTL_MS = 20000

// Registers the listeners that remember our last attacker on the session.
// Called once per connection, after the bot object exists.
function trackAttackers (session) {
  const bot = session && session.bot
  if (!bot || bot.__ndAttackerTracker) return { ok: false, reason: 'нечего слушать' }
  bot.__ndAttackerTracker = true

  const remember = (source, how) => {
    if (!source || source === bot.entity || !source.position) return
    session.lastAttacker = {
      id: source.id,
      name: source.username || source.name || 'кто-то',
      pos: xyz(source.position),
      at: gameClock.now(),
      how,
      // Remembered, not filtered out. Who hit us is worth knowing even when the
      // answer is a person — attackerHint() below still says it out loud, and
      // «меня бьёт Vasya» is a fact the brain must have. What must never happen
      // is this record turning into a target, and that is refused one function
      // down, in liveAttacker().
      player: isPlayerEntity(source)
    }
  }

  bot.on('entityHurt', (victim, source) => {
    if (victim !== bot.entity) return
    if (source) remember(source, 'damage_event')
    // No source in the packet: blame whatever is close enough to have swung.
    // Deliberately tight — suffocation and fall damage must not get pinned on
    // a mob that merely happened to be walking past.
    else remember(nearestHostile(bot, 4), 'рядом стоял')
  })

  // Death respawns the body at the world spawn, and whatever was hitting it is
  // now a hundred blocks away. Keeping that memory is how the brain ends up
  // ordering a fight with a mob it left behind at y=-29.
  bot.on('death', () => { session.lastAttacker = null })

  return { ok: true }
}

// The remembered attacker, but only while it is still something we could
// actually swing at: fresh, still tracked by the server, still alive.
function liveAttacker (session) {
  const rec = session && session.lastAttacker
  const bot = session && session.bot
  if (!rec || !bot || !bot.entity) return null
  if (gameClock.now() - rec.at > ATTACKER_TTL_MS) return null
  const live = bot.entities[rec.id]
  if (!live || live === bot.entity || live.isValid === false || !live.position) return null
  // A person is never handed back as something to swing at. This is the door
  // that actually mattered: with no mob in range findTarget('ближайший')
  // returns whoever last hit us, and on a shared server whoever last hit us is
  // usually the owner walking up to say hello. The record itself survives —
  // only its use as a target does not.
  if (isPlayerEntity(live)) return null
  return live
}

// What we know about the last hit even when the mob itself is gone. Goes into
// the failure message so the brain gets a direction instead of a shrug.
function attackerHint (session) {
  const rec = session && session.lastAttacker
  if (!rec) return ''
  const ago = Math.round((gameClock.now() - rec.at) / 1000)
  if (ago > 120) return ''
  return `; последним бил ${rec.name} ${ago}с назад у ${rec.pos.x},${rec.pos.y},${rec.pos.z}`
}

// Standing still next to one of these is not a fight, it is a demolition
// charge with legs. Whatever the shape of the room, a creeper gets distance.
const DO_NOT_TRADE_WITH = new Set(['creeper'])

// Three ways in, and a person could walk through all three: whoever last hit
// us (a player is a perfectly valid `source` in the damage_event handler
// above), a name looked up in bot.players, and the scan by entity name — where
// a player's entity.name is the literal word 'player' (mineflayer 4.37.1,
// lib/plugins/entities.js:192-194). All three are shut here and not in fight(),
// because findTarget is the single place that turns a word into a body.
// allowPlayer is a parameter and not a name match on purpose: hitting a person
// has to be a sentence somebody wrote, never a coincidence of spelling.
// Нейтральные, которых «ближайший» не трогает, пока они не злы: эндермен без
// крика (метаданные creepy — он злится, только если смотреть ему в глаза) и
// пиглин, пока на нас золото (PiglinAi.isWearingSafeArmor: одной вещи хватит).
// Ударить такого — поднять толпу: пиглин передаёт злость всем в 16 блоках.
// Тот, кто ударил сам, приходит через liveAttacker, а по имени бить можно всегда.
function calmNeutral (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name] && bot.registry.entitiesByName[e.name].metadataKeys
    if (e.name === 'enderman') {
      const i = keys ? keys.indexOf('creepy') : -1
      return !(i >= 0 && e.metadata[i])
    }
    if (e.name === 'piglin') {
      return [5, 6, 7, 8].some(s => { const it = bot.inventory.slots[s]; return it && /^golden_/.test(it.name) })
    }
  } catch {}
  return false
}

function findTarget (bot, target, session = null, { allowPlayer = false, radius = 24 }: any = {}) {
  const me = bot.entity.position
  if (!target || target === 'ближайший' || target === 'nearest') {
    // Дальше 24 — только те, кого видно: большой радиус нужен для зачистки
    // площадки, а не чтобы найти моба в пещере под ней.
    const near = bot.nearestEntity(e =>
      e && e.position && HOSTILES.has(e.name) && !calmNeutral(bot, e) && e.position.distanceTo(me) < radius &&
      (e.position.distanceTo(me) < 24 || raySees(bot, eyePos(bot), e.position.offset(0, (e.height || 1.8) * 0.6, 0))))
    // Whoever just hit us outranks both the hostile list and the radius: it is
    // by definition close enough to matter, and it may well be something the
    // list does not name at all. HOSTILES has no 'player' in it and
    // liveAttacker no longer returns people, so «ближайший» can no longer come
    // back as the owner.
    return near || liveAttacker(session)
  }
  // «#123» — конкретная сущность по id: защита друга бьёт того моба, который
  // ударил его, а не ближайшего с тем же именем.
  if (typeof target === 'string' && /^#\d+$/.test(target)) {
    const e = bot.entities[Number(target.slice(1))]
    if (!e || !e.position) return null
    if (isPlayerEntity(e) && !allowPlayer) throw new Error('это игрок, а не моб: на людей сам не нападаю')
    return e
  }
  if (bot.players[target] && bot.players[target].entity) {
    if (!allowPlayer) {
      throw new Error(
        `${target} — игрок, а не моб: на людей сам не нападаю. ` +
        'Если это правда нужно, зови fight с allowPlayer: true')
    }
    return bot.players[target].entity
  }
  const named = bot.nearestEntity(e =>
    e && e.name === target && !isPlayerEntity(e) && e.position && e.position.distanceTo(me) < 32)
  if (named) return named
  const hit = liveAttacker(session)
  if (hit && (hit.name === target || hit.username === target)) return hit
  return null
}

// Nearest hostile within radius, or null. Used by the autopilot and by
// anything that needs to know whether it is safe to stand still.
function nearestHostile (bot, radius = 16) {
  if (!bot || !bot.entity) return null
  const me = bot.entity.position
  return bot.nearestEntity(e =>
    e && e.name && HOSTILES.has(e.name) && e.position && e.position.distanceTo(me) < radius)
}

// How many of them there are. In a drift the difference between one mob and
// two is the difference between a fight we win and a queue that grinds us
// down, because the next one steps into contact the moment this one drops.
function countHostiles (bot, radius = 8) {
  if (!bot || !bot.entity) return 0
  const me = bot.entity.position
  let n = 0
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e === bot.entity || !e.position || !e.name) continue
    if (HOSTILES.has(e.name) && e.position.distanceTo(me) <= radius) n++
  }
  return n
}

function threatPoint (entity) {
  if (!entity || !entity.position) return null
  return entity.position.offset(0, (entity.height || 1.8) * 0.85, 0)
}

export {
  HOSTILES, RANGED, CANNOT_BE_OUTPILLARED, ATTACKER_TTL_MS, trackAttackers, liveAttacker, attackerHint, DO_NOT_TRADE_WITH, calmNeutral, findTarget, nearestHostile, countHostiles, threatPoint
}

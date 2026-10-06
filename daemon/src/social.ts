'use strict'
const gameClock = require('./game-clock')
const cfg = require('./config')
const { canSeePoint } = require('./perception')

// Everything the body knows about the people on the server, and the one reflex
// it is allowed to have about them.
//
// Before this file the daemon knew three things about players: chat/whisper
// (session.js:152-161), playerJoined/playerLeft (session.js:184-187) and
// perception.playersOnline (perception.js:105) — a list of names with no
// distance, no direction and no reflex behind it. A player could walk up,
// stand on our head and walk away and nothing in the body ever noticed.
//
// The line this file does not cross: noticing is a rule, talking is reasoning.
// The routine emits facts and turns the head; it never opens its mouth and
// never touches a running intent.

// Hysteresis, not a single threshold: a player standing at exactly the edge
// jitters across it several times a second (server position updates are ~20/s
// and walking speed is 4.3 blocks/s), and the routine ticks once a second, so
// one threshold means a stream of player_near/player_gone pairs about somebody
// who never went anywhere.
const NEAR = 6
const FAR = 12
// Wider than FAR so that a player who stepped out of the "gone" band is still
// a tracked fact and not a fresh arrival on the next step back.
const SCAN = 20

// Turning is free but the packet is not: without a deadband the body sends a
// look packet every second at a player who has not moved. 10 degrees is under
// half of what the scene checks for.
const FACE_DEADBAND_DEG = 10

// A player's entity is `type: 'player'`, `name: 'player'`, `username: 'Vasya'`
// (mineflayer 4.37.1, lib/plugins/entities.js:192-194). Both halves are checked
// because the same predicate guards combat: `name` alone is the word 'player',
// which is exactly the hole that let fight({target:'player'}) pick a person.
function isPlayerEntity (e) {
  return !!e && (e.type === 'player' || !!e.username)
}

// The body's own frame. yaw 0 is north and forward is (-sin, -cos) — the maths
// actions.js:171-176 already relies on for stair directions.
function facingVec (bot) {
  const yaw = bot.entity.yaw
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) }
}

// Same vocabulary mining.js:82-93 uses inside a drift («в 3 впереди слева»),
// because a person reading the two of them must not have to learn a second set
// of words for the same fact. Left is (f.z, -f.x): facing east, north is left.
// Pure directions until the two components are within a factor of two of each
// other — «позади» is what a human says about somebody almost directly behind,
// not «позади чуть слева».
function whereIs (bot, pos) {
  const f = facingVec(bot)
  const me = bot.entity.position
  const dx = pos.x - me.x
  const dz = pos.z - me.z
  const along = dx * f.x + dz * f.z
  const side = dx * f.z + dz * -f.x
  if (Math.hypot(along, side) < 0.6) return 'вплотную'
  const ahead = along >= 0 ? 'впереди' : 'позади'
  const hand = side >= 0 ? 'слева' : 'справа'
  if (Math.abs(along) > 2 * Math.abs(side)) return ahead
  if (Math.abs(side) > 2 * Math.abs(along)) return hand
  return `${ahead} ${hand}`
}

// Degrees between our nose and the direction to a point. Same yaw the body
// would end up with after bot.lookAt(): yaw = atan2(-dx, -dz)
// (mineflayer physics.js:357-362), so 0 here means "already looking at him".
function angleTo (bot, pos) {
  const dx = pos.x - bot.entity.position.x
  const dz = pos.z - bot.entity.position.z
  const want = Math.atan2(-dx, -dz)
  let err = want - bot.entity.yaw
  while (err > Math.PI) err -= 2 * Math.PI
  while (err < -Math.PI) err += 2 * Math.PI
  return Math.round(Math.abs(err) * 180 / Math.PI)
}

// What is in his hand, in the words a person would use. Only the things that
// change what you do next are translated; anything else keeps its game name
// rather than going through an invented dictionary — the state header already
// reports items that way (perception.js:91).
const HELD_RU = {
  pickaxe: 'кирка', sword: 'меч', axe: 'топор', shovel: 'лопата', hoe: 'мотыга',
  bow: 'лук', crossbow: 'арбалет', trident: 'трезубец', shield: 'щит',
  fishing_rod: 'удочка', flint_and_steel: 'огниво', torch: 'факел',
  bucket: 'ведро', tnt: 'тнт'
}

function heldWord (name) {
  if (!name) return null
  for (const [key, ru] of (Object.entries(HELD_RU) as [string, any][])) {
    if (name === key || name.endsWith('_' + key)) return ru
  }
  return name
}

// Is he holding something that makes a difference if he swings it.
function isWeaponish (name) {
  return !!name && /_(sword|axe|pickaxe|shovel|hoe)$|^(bow|crossbow|trident)$/.test(name)
}

// Who is around, as a person would see it: name, how far, which way, what is in
// his hand, and whether we actually have a line to him.
//
// fairPlay is honoured, but not the way observe() honours it. observe()
// (perception.js:121) drops an entity we cannot see outright — that is right
// for a mob in a cave and wrong for a person: vanilla renders player nameplates
// through terrain, so a player behind a wall is exactly the thing a human
// player still knows about. So the raycast becomes a field on the record
// (canSee) instead of a filter: it decides whether we could swing at him or
// look him in the eye, not whether we noticed him at all. With fairPlay off
// there is no fog of war at all and canSee is simply true.
function nearbyPlayers (bot, radius = SCAN, { fair }: any = {}) {
  const out = []
  if (!bot || !bot.entity || !bot.players) return out
  const useFair = fair === undefined ? cfg.fairPlay : !!fair
  const me = bot.entity.position
  for (const [name, rec] of ((Object.entries(bot.players) as [string, any][]) as any)) {
    if (name === bot.username) continue
    // A tab-list entry with no entity is a player on the far side of the world:
    // known to be online, not present. playersOnline already lists those.
    const ent = rec && rec.entity
    if (!ent || !ent.position || ent === bot.entity) continue
    const dist = ent.position.distanceTo(me)
    if (dist > radius) continue
    // The server announces equipment only for slots that are not empty, so a
    // null here means "nothing visible in his hand", not "we failed to look".
    const holding = ent.heldItem ? ent.heldItem.name : null
    out.push({
      name,
      dist: Math.round(dist * 10) / 10,
      where: whereIs(bot, ent.position),
      dy: Math.round(ent.position.y - me.y),
      holding,
      armed: isWeaponish(holding),
      canSee: useFair ? canSeePoint(bot, ent.position.offset(0, (ent.height || 1.8) * 0.6, 0)) : true,
      angle: angleTo(bot, ent.position)
    })
  }
  out.sort((a, b) => a.dist - b.dist)
  return out
}

// One player, one sentence. The brain gets the whole answer in the first tool
// result and never has to ask a second question to act on it.
function describe (p) {
  const parts = [`${p.name} в ${Math.round(p.dist)} блоках ${p.where}`]
  if (p.dy >= 2) parts.push(`на ${p.dy} выше`)
  else if (p.dy <= -2) parts.push(`на ${-p.dy} ниже`)
  parts.push(p.holding ? `в руке ${heldWord(p.holding)}` : 'в руках пусто')
  if (!p.canSee) parts.push('за стеной, глазами не вижу')
  return parts.join(', ')
}

// ------------------------------------------------------------------- routine

// True while the brain is driving. 'wait' is the brain idling and listening,
// which is precisely when the body may take the wheel — the same rule
// escapeWaterIfIdle states at autopilot.js:79.
function brainBusy (session) {
  return !!(session.current && session.current.name !== 'wait')
}

// Turning the head is cheap and honest: a body that is looked at is a body that
// noticed you. But the head is also how mineflayer aims a dig and how
// pathfinder steers, so the reflex only runs when nothing else owns it.
//
// Only at somebody actually within NEAR, the same threshold player_near uses:
// one rule for one distance. Tracking a stranger nineteen blocks off across a
// field is not what a person idling does, and it would mean the head follows
// people the body never said a word about.
async function faceNearest (bot, session, seen) {
  if (brainBusy(session)) return null
  if (bot.isSleeping || bot.targetDigBlock) return null
  try {
    // follow() sets a persistent goal and returns through immediate(), so
    // session.current is null while the body is walking (session.js:426).
    // Fighting pathfinder for the yaw would make it walk sideways.
    if (bot.pathfinder && (bot.pathfinder.isMoving() || bot.pathfinder.isMining() || bot.pathfinder.isBuilding())) return null
  } catch {}
  const p = seen[0]
  if (!p || p.dist > NEAR) return null
  if (p.angle <= FACE_DEADBAND_DEG) return p.name
  const ent = bot.players[p.name] && bot.players[p.name].entity
  if (!ent || !ent.position) return null
  // force=true: the smooth version awaits a physics task (physics.js:329-354),
  // and this runs inside the autopilot tick loop, which is the same loop that
  // digs the body out of a wall. Nothing in a reflex may hold that.
  try { await bot.lookAt(ent.position.offset(0, (ent.height || 1.8) * 0.9, 0), true) } catch {}
  return p.name
}

// The routine itself. Called once per autopilot tick.
//
// It emits and it turns the head; it does not speak and it does not cancel
// anything. player_near/player_gone are deliberately absent from INTERRUPTING
// (events.js:9), so a person walking past a two-minute drift is news the brain
// reads when the drift is done, not a reason to abandon it.
async function noticePlayers (ap) {
  const session = ap.session
  const bot = session && session.bot
  if (!bot || !bot.entity) return
  // Keyed by name and owned by the autopilot instance, like every other piece
  // of routine state (this.toolSig, this.buriedSince).
  const known = ap.socialNear || (ap.socialNear = new Map())

  const seen = nearbyPlayers(bot, SCAN)
  const byName = new Map(seen.map(p => [p.name, p]))

  for (const p of seen) {
    if (p.dist > NEAR || known.has(p.name)) continue
    known.set(p.name, { at: gameClock.now(), last: p.dist })
    // Everything a person notices in the same glance, so that the brain's first
    // reaction does not have to start with another tool call.
    session.bus.emit('player_near', {
      name: p.name,
      dist: p.dist,
      where: p.where,
      dy: p.dy,
      holding: p.holding,
      armed: p.armed,
      canSee: p.canSee,
      text: describe(p)
    })
  }

  for (const [name, rec] of known) {
    const now = byName.get(name)
    if (now) {
      rec.last = now.dist
      if (now.dist < FAR) continue
    }
    known.delete(name)
    // He logged out rather than walked off: session.js:187 already emits
    // player_left for that, and saying it twice in two vocabularies is how a
    // brain ends up answering the same fact twice.
    if (!bot.players[name]) continue
    session.bus.emit('player_gone', {
      name,
      dist: now ? now.dist : null,
      seconds: Math.round((gameClock.now() - rec.at) / 1000),
      why: now ? 'отошёл' : 'пропал из виду'
    })
  }

  await faceNearest(bot, session, seen)
}

// --------------------------------------------------------------- for the brain

// The answer to "кто рядом" in one sentence, because the alternative is the
// brain calling observe() and doing trigonometry on coordinates before it can
// say hello. Goes through immediate(): knowing who is standing next to us must
// not cost a running intent.
function players (session, { radius = SCAN, fair }: any = {}) {
  const bot = session.bot
  const seen = nearbyPlayers(bot, radius, { fair })
  const facing = seen.find(p => p.angle <= 20) || null
  // Куда каждый смотрит сейчас и на что последним указывал долгим взглядом
  // (gestures.js): «вот это», «сюда», «сломай его» без координат в чате.
  // Лениво: gestures.js сам тянет этот файл.
  const gestures = require('./gestures')
  const ap = session.autopilot
  const people = ap && ap.gestureState ? ap.gestureState.people : null
  for (const p of seen) {
    const ent = bot.players[p.name] && bot.players[p.name].entity
    const g = ent ? gestures.gaze(bot, ent) : null
    if (g) p.gaze = g
    const hp = ent ? gestures.hpOf(ent) : null
    if (hp !== null) p.hp = hp
    const r = people && people.get(p.name)
    if (r && r.pointing && gameClock.now() - r.pointing.at < 60000) p.pointed = r.pointing
  }
  const words = (p) => {
    let line = describe(p)
    if (typeof p.hp === 'number' && p.hp < 20) line += `, хп ${p.hp}${p.hp <= 8 ? ' — ранен' : ''}`
    if (p.gaze) line += `, ${p.gaze.text}`
    if (p.pointed && (!p.gaze || p.gaze.atMe || p.gaze.x !== p.pointed.x || p.gaze.y !== p.pointed.y || p.gaze.z !== p.pointed.z)) {
      line += `, недавно указывал взглядом на ${p.pointed.block} (${p.pointed.x}, ${p.pointed.y}, ${p.pointed.z})`
    }
    return line
  }
  // Настроение и отношение (mood.js) — чтобы мозг говорил в тон тому, что
  // было за сессию: подарки, драки, «зовёт пятый раз».
  const mood = session.mood ? session.mood.report() : null
  return {
    mood,
    text: (seen.length ? seen.map(words).join('; ') : 'рядом никого') + (mood ? `. ${mood.text}` : ''),
    players: seen,
    // Where the head actually points, straight off bot.entity.yaw — the fact
    // that says whether the reflex above did its job. Degrees, 0 is north.
    yaw: Math.round(((bot.entity.yaw * 180 / Math.PI) % 360 + 360) % 360),
    lookingAt: facing ? facing.name : null,
    online: Object.keys(bot.players).filter(n => n !== bot.username),
    radius
  }
}

module.exports = {
  nearbyPlayers,
  noticePlayers,
  players,
  describe,
  isPlayerEntity,
  whereIs,
  angleTo,
  NEAR,
  FAR,
  SCAN
}

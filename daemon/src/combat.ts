'use strict'
const gameClock = require('./game-clock')
const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const { sleep, xyz, standableY, travelXZ, inWater, escapeWater } = require('./movement')
const { raySees, eyePos } = require('./perception')
const { bestWeapon, itemNamed, countItems, diffItems } = require('./items')
const { placeBlockAt, towerUp, occupiedByEntity, pickFiller } = require('./build')
const { collectNearbyDrops } = require('./actions')
// Одеться перед боем — не побочное дело combat.js, а его прямое: автопилот
// не одевается, пока работает намерение, а бой — намерение. Цикла импортов
// нет: armor.js тянет только ./movement.
const armor = require('./armor')
// One definition of "who is a person", shared with the reflex that watches
// them: two copies is two things to forget to update, and the routine that
// turns the head toward a player and the code that refuses to swing at one
// must never disagree about the same body.
const { isPlayerEntity } = require('./social')
const pvp = require('./pvp')
const flee = require('./flee')
const { decideFight } = require('./play-policy')
const survival = require('./combat-safety')

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

// ----------------------------------------------------------- corridor shape

// A mine drift — one block wide, two high — is not the worst ground to be
// caught on, it is the best: one filled cell is a wall the mob cannot walk
// around, and only one mob can ever be in contact. But every move the
// open-ground retreat makes is wrong here. The pillar hits the ceiling at
// feet+2, the cover search walks past the mob because there is no way past it,
// and "away from the threat" as a vector points into the side wall as soon as
// the body drifts half a block off the axis. So the shape has to be recognised
// before the doctrine is picked.
//
// Block reads only — about fifteen blockAt() calls, no raycasts — because this
// runs inside the swing loop.

function solidAt (bot, p) {
  const b = bot.blockAt(p)
  return !!b && b.boundingBox === 'block'
}

function openAt (bot, p) {
  const b = bot.blockAt(p)
  // An unloaded block is not "open". Reading null as walkable is how a retreat
  // ends up walking into a wall it never actually looked at.
  return !!b && b.boundingBox === 'empty' && !/lava/.test(b.name)
}

const AXES = [{ name: 'x', dx: 1, dz: 0 }, { name: 'z', dx: 0, dz: 1 }]

// mc_tunnel digs two high by default and three on request, so the ceiling is
// looked for at either height; anything taller is a room, not a drift.
// Open cells counted from the feet up; the ceiling is the block at
// feet+headroom. Capped, because the question is always "is there a ceiling
// within N", never how far away the sky is.
function headroomAt (bot, max = 3) {
  const feet = bot.entity.position.floored()
  let n = 0
  for (let h = 0; h <= max; h++) {
    if (!openAt(bot, feet.offset(0, h, 0))) break
    n = h + 1
  }
  return n
}

const DIRS4 = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }]

// The orthogonal cells a walking mob could stand in to reach us. This is the
// number that decides everything underground: two of them is a drift, three is
// a wall at our back, four is open ground. Measured cost of standing and
// fighting, iron sword against zombies in full iron armour: one contact costs
// about 2 hp, two about 7, three about 14, four kills. So the thing worth
// spending blocks on is not the mob count, it is the contact count.
function openSides (bot, levels = 2) {
  const feet = bot.entity.position.floored()
  const out = []
  for (const d of DIRS4) {
    let ok = true
    for (let h = 0; h < levels && ok; h++) ok = openAt(bot, feet.offset(d.dx, h, d.dz))
    if (ok) out.push(d)
  }
  return out
}

// The one of the four directions a point mostly lies in.
function dominantStep (dx, dz) {
  return Math.abs(dx) >= Math.abs(dz)
    ? { dx: dx >= 0 ? 1 : -1, dz: 0 }
    : { dx: 0, dz: dz >= 0 ? 1 : -1 }
}

// A wall a walker cannot climb is two blocks, because it can step up one. In a
// drift the ceiling does the second block for us, so filling everything but
// the last cell under the roof is enough and is one placement faster.
function walkerLevels (shape) {
  return Math.max(1, Math.min(2, shape.headroom - 1))
}

function corridorShape (bot, threat) {
  if (!bot || !bot.entity || !threat) return { corridor: false, why: 'нечего мерить' }
  const feet = bot.entity.position.floored()

  const headroom = headroomAt(bot, 3)
  if (headroom < 2) return { corridor: false, why: 'встать негде' }
  if (headroom > 3) return { corridor: false, why: 'потолка нет — это не штрек' }

  const walled = []
  for (const a of AXES) {
    // The pair of walls across the axis: what the mob would have to walk
    // around, and what a placed block leans against.
    const sx = a.dz
    const sz = a.dx
    let ok = true
    for (let h = 0; h < headroom && ok; h++) {
      ok = solidAt(bot, feet.offset(sx, h, sz)) && solidAt(bot, feet.offset(-sx, h, -sz))
    }
    if (!ok) continue
    const delta = a.name === 'x' ? threat.x - (feet.x + 0.5) : threat.z - (feet.z + 0.5)
    walled.push({ a, delta })
  }
  if (!walled.length) return { corridor: false, why: 'стен с обеих сторон нет' }

  // Both axes walled means a 1x1 pocket rather than a drift. Pick the axis the
  // threat actually lies along, so "toward" keeps meaning something.
  walled.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta))
  const pick = walled[0]
  const sign = pick.delta >= 0 ? 1 : -1
  const step = { dx: pick.a.dx * sign, dz: pick.a.dz * sign }
  const back = { dx: -step.dx, dz: -step.dz }
  const open = (d) => {
    for (let h = 0; h < headroom; h++) if (!openAt(bot, feet.offset(d.dx, h, d.dz))) return false
    return true
  }
  return {
    corridor: true,
    axis: pick.a.name,
    headroom,
    step,
    back,
    towardOpen: open(step),
    backOpen: open(back)
  }
}

// How many cells of drift are actually open this way. Cheaper and far more
// honest than handing pathfinder a coordinate ten blocks inside bedrock and
// waiting for the stuck guard to say so eight seconds later.
function openRun (bot, from, dir, headroom, max = 12) {
  let n = 0
  for (let d = 1; d <= max; d++) {
    let ok = true
    for (let h = 0; h < headroom && ok; h++) ok = openAt(bot, from.offset(dir.dx * d, h, dir.dz * d))
    if (!ok) break
    n = d
  }
  return n
}

// Contact distance below which a melee mob is not worth trying to wall out.
// Run 1 of try-corridor is the whole argument: the bot met the zombie head-on,
// the square in front of it was occupied from that moment on, and the two
// attempts to buy it back by stepping away cost 19 hp and did not place a
// single block out of 64. A mob walks about a block every quarter second and a
// placement that lands is one server round trip, so five blocks is roughly two
// placements of margin — and if the attempt fails anyway it now costs one
// placement window instead of the fight.
const SEAL_GAP = 5

// Fill the cell of drift between us and the mob. One attempt, no walking: the
// square is either free right now or it is not, and every step taken to make
// it free is a free hit for something that moves faster than we do.
//
// Height depends on what is coming. An archer needs the full column, because
// it shoots over a knee-high wall — run 3 measured that: skeleton at ten
// blocks, two blocks placed, zero damage taken. A walker needs only the floor
// block: nothing that walks can enter a one-block-high gap, and from the next
// cell out it is two blocks away, past a zombie's reach. The floor block also
// goes down in half the time, which is the half that decides the race.
async function sealCorridor (session, ctl, shape, { levels = 0 }: any = {}) {
  const bot = session.bot
  const why = []
  let placed = 0

  // Asked first. An empty backpack does not get better on a second look, and
  // finding that out costs a second of standing in reach.
  if (!pickFiller(bot)) return { ok: false, placed: 0, why: ['нечем строить'] }

  const feet = bot.entity.position.floored()
  const cell = feet.offset(shape.step.dx, 0, shape.step.dz)
  const height = Math.min(shape.headroom, levels > 0 ? levels : shape.headroom)
  const column = []
  for (let h = 0; h < height; h++) column.push(cell.offset(0, h, 0))

  const squatter = column.map(p => occupiedByEntity(bot, p)).find(Boolean)
  // The server refuses every placement into a living entity, and each refusal
  // costs a full placement timeout. Say so and let the caller swing instead.
  if (squatter) return { ok: false, placed: 0, why: [`в клетке ${squatter}`] }

  for (const pos of column) {
    if (ctl && ctl.aborted) break
    // Short leash: this happens while something is hitting us, so a square
    // that does not take a block on the first try is not worth a second.
    const r = await placeBlockAt(bot, pos, { timeoutMs: 1200 })
    if (r.ok) { if (!r.already) placed++ } else if (!why.includes(r.reason)) why.push(r.reason)
  }

  // Verified by reading blocks, not by a raycast. In a drift the question is
  // literally "is the tunnel full", and blockAt answers exactly that.
  if (column.every(p => solidAt(bot, p))) {
    return { ok: true, placed, at: xyz(cell), height, why: why.length ? why.slice(0, 4) : undefined }
  }
  return { ok: false, placed, why: why.slice(0, 4) }
}

// Underground the bot is standing in stone with holes in it, and the holes are
// the whole problem: each open side is one more mob that can be in contact at
// the same time, and contact count is what decides the fight. Closing a side
// is two blocks and it never has to win a race, because a mob can only be
// standing in one of them at a time. The side the threat is on stays open on
// purpose: that is the one we mean to fight through, and walling it is the
// seal, not the shield.
async function shieldFlanks (session, ctl, threat, { budget = 6, deadline = 0 }: any = {}) {
  const bot = session.bot
  const before = openSides(bot, 2).length
  if (!pickFiller(bot)) return { placed: 0, before, after: before, why: 'нечем строить' }

  const feet = bot.entity.position.floored()
  const me = bot.entity.position
  const toward = dominantStep(threat.x - me.x, threat.z - me.z)
  let placed = 0

  for (const d of openSides(bot, 2)) {
    if ((ctl && ctl.aborted) || placed >= budget) break
    if (deadline && gameClock.now() >= deadline) break
    if (d.dx === toward.dx && d.dz === toward.dz) continue
    const cell = feet.offset(d.dx, 0, d.dz)
    // A refused placement into a mob costs a full timeout; skip the side it is
    // standing in and take the ones that are actually free.
    if (occupiedByEntity(bot, cell) || occupiedByEntity(bot, cell.offset(0, 1, 0))) continue
    for (let h = 0; h < 2; h++) {
      const r = await placeBlockAt(bot, cell.offset(0, h, 0), { timeoutMs: 1200 })
      if (r.ok && !r.already) placed++
    }
  }
  return { placed, before, after: openSides(bot, 2).length }
}

// Swing, and take the wall the moment it is offered. This is the melee answer
// in a drift and it is measured, not reasoned: runs 2 and 4 killed the zombie
// for 2 and 9 hp with the same iron sword, while every run that tried to break
// contact — 1, 5 and 6 — ended between 1 and 4 hp with the mob still on the
// bot. In a 1x2 drift only one thing can reach us and it can only come head
// on, so standing still and hitting it is the cheapest exit there is.
//
// The seal is not abandoned, it is just never paid for with movement: the
// square in front is checked between swings, and the instant the mob is far
// enough off it the block goes down and the fight is over for free.
async function holdTheLine (session, ctl, shape, entity, deadline) {
  const bot = session.bot
  const weapon = bestWeapon(bot)
  // Bare fists do about one damage against twenty points of zombie. That is
  // not a fight, it is a slower version of standing still, so the caller has
  // to be told to do something else.
  if (!weapon) return { held: false, why: 'бить нечем' }
  try { await bot.equip(weapon, 'hand') } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}

  let swings = 0
  let lastSeal = 0
  while (!(ctl && ctl.aborted) && gameClock.now() < deadline) {
    if (!entity.isValid) return { held: true, killed: entity.username || entity.name, swings }
    const dist = entity.position.distanceTo(bot.entity.position)

    // Only a drift can be sealed: filling one cell of a cave just gives the
    // mob a step to walk around.
    if (shape && dist >= SEAL_GAP && gameClock.now() - lastSeal > 3000) {
      lastSeal = gameClock.now()
      const seal = await sealCorridor(session, ctl, shape, { levels: walkerLevels(shape) })
      if (seal.ok) {
        // The floor block already denies entry; the rest of the column is a
        // bonus taken only because there is time for it right now.
        const top = await sealCorridor(session, ctl, shape)
        return { held: true, sealed: true, placed: seal.placed + (top.ok ? top.placed : 0), at: seal.at, swings }
      }
      continue
    }

    if (dist <= 3.2) {
      try {
        await bot.lookAt(entity.position.offset(0, (entity.height || 1.8) * 0.85, 0), true)
        bot.attack(entity)
        swings++
      } catch {}
    }
    // Sword cooldown is 0.625s; swinging faster just wastes damage.
    await sleep(650)
  }
  return { held: true, swings, timeout: true }
}

// ---------------------------------------------------------------- retreat

// Standing spots around us from which the threat cannot see us. This is the
// whole idea behind retreating from an archer: cover, not distance.
function coverSpots (bot, threat, maxRadius = 20) {
  const from = bot.entity.position.floored()
  const myDist = bot.entity.position.distanceTo(threat)
  const out = []
  const DIRS = 16

  for (let r = 4; r <= maxRadius; r += 3) {
    for (let k = 0; k < DIRS; k++) {
      const a = (k / DIRS) * Math.PI * 2
      const x = Math.round(from.x + Math.cos(a) * r)
      const z = Math.round(from.z + Math.sin(a) * r)
      const y = standableY(bot, x, from.y, z)
      if (y === null) continue

      const stand = new Vec3(x + 0.5, y, z + 0.5)
      // Cover we have to run past the archer to reach is not cover.
      if (stand.distanceTo(threat) < myDist - 1) continue
      if (raySees(bot, new Vec3(x + 0.5, y + 1.62, z + 0.5), threat)) continue

      out.push({ x, y, z, travel: r, fromThreat: Math.round(stand.distanceTo(threat)) })
    }
  }

  // Nearest first: the value is entirely in getting behind something *now*.
  // Ties go to whatever ends up further from the shooter.
  out.sort((a, b) => a.travel - b.travel || b.fromThreat - a.fromThreat)
  return out
}

// Open ground with an archer on it: build the cover that is not there. One
// block at eye height in the line of fire is the entire trick.
async function raiseWall (session, ctl, threat) {
  const bot = session.bot
  const eye = eyePos(bot)
  const dir = threat.minus(eye)
  dir.y = 0
  if (dir.norm() < 0.01) return { ok: false, reason: 'цель прямо надо мной' }

  const step = dir.normalize()
  const feet = bot.entity.position.floored()
  const spots = []
  for (const d of [1, 2]) {
    const px = Math.round(feet.x + step.x * d)
    const pz = Math.round(feet.z + step.z * d)
    // Bottom-up, and it matters: on open ground the only thing to place
    // against is the floor, so the head-height block has nothing to attach to
    // until the one under it exists. Built head-first, only the foot blocks
    // landed and the arrows kept coming in at eye level.
    spots.push(new Vec3(px, feet.y, pz), new Vec3(px, feet.y + 1, pz))
  }

  let placed = 0
  for (const pos of spots) {
    if (ctl.aborted) break
    // Short leash: this is happening while something is hitting us, so a
    // square that does not take a block on the first try is not worth a second.
    const r = await placeBlockAt(bot, pos, { timeoutMs: 1200 })
    if (r.ok && !r.already) placed++
    // Stop as soon as the shot is actually blocked — every extra block is
    // another second of standing still being shot.
    if (!raySees(bot, eyePos(bot), threat)) return { ok: true, placed, covered: true }
  }
  return { ok: false, placed, covered: false }
}

// Walk directly away under manual control. Pathfinder will not plan a route
// for one second of movement, and here the direction matters far more than the
// route: the point is only to stop standing inside the mob's reach.
async function backOff (bot, threat, ms) {
  const away = bot.entity.position.minus(threat)
  away.y = 0
  if (away.norm() < 0.01) return
  const look = bot.entity.position.plus(away.normalize().scaled(6))
  try {
    await bot.lookAt(look.offset(0, 1.6, 0), true)
    bot.setControlState('forward', true)
    await sleep(ms)
  } catch {
  } finally {
    try { bot.setControlState('forward', false) } catch {}
  }
}

// Getting out of a fight alive inside a drift. Nothing from the open-ground
// playbook applies, and the two threats want opposite answers here — measured,
// run by run, in try-corridor:
//
//   archer  — the wall works perfectly. Run 3: skeleton ten blocks down the
//             drift, two blocks placed, zero damage, zero swings.
//   walker  — the wall only works if the square in front is free, which it is
//             not once contact is made, and walking the axis to break contact
//             does not work at all. Runs 5 and 6 walked away and were eaten
//             standing: 17 -> 3 and 14 -> 4 hp in the six seconds after. So
//             the answer to a walker is to hit it.
async function retreatInCorridor (session, ctl, shape, entity, deadline) {
  const bot = session.bot
  if (!shape.towardOpen && !shape.backOpen) {
    // Both ends of our own cell are stone: we are already inside a sealed
    // pocket, and whatever hit us cannot follow.
    return { mode: 'я в норе, ко мне не пройти', corridor: true, sealed: true, at: xyz(bot.entity.position) }
  }

  const ranged = !!(entity.name && RANGED.has(entity.name))

  if (!ranged && !DO_NOT_TRADE_WITH.has(entity.name)) {
    const held = await holdTheLine(session, ctl, shape, entity, deadline)
    if (held.held) {
      return {
        mode: held.sealed ? 'запечатал штрек' : (held.killed ? 'убил в штреке' : 'держу штрек — отсюда не отходят'),
        corridor: true,
        sealed: !!held.sealed,
        killed: held.killed,
        mobs: countHostiles(bot, 6),
        placed: held.placed,
        at: held.at || xyz(bot.entity.position),
        swings: held.swings
      }
    }
    // Nothing to hit with. Falling through to the axis walk is not a good
    // answer — it is the least bad one left.
  }

  const seal = await sealCorridor(session, ctl, shape)
  if (seal.ok) {
    return { mode: 'запечатал штрек', corridor: true, sealed: true, placed: seal.placed, at: seal.at }
  }

  const feet = bot.entity.position.floored()
  const run = openRun(bot, feet, shape.back, shape.headroom, 12)
  if (run < 2) {
    return {
      mode: 'тупик: запечатать нечем, отходить некуда',
      corridor: true,
      sealed: false,
      why: seal.why,
      at: xyz(feet)
    }
  }
  const to = feet.offset(shape.back.dx * run, 0, shape.back.dz * run)
  const r = await travelXZ(bot, ctl, to.x, to.z, { range: 1, retries: 0, deadline })
  return {
    mode: `отошёл по штреку на ${run}`,
    corridor: true,
    sealed: false,
    why: seal.why,
    at: xyz(bot.entity.position),
    ok: r.ok,
    error: r.ok ? undefined : r.error
  }
}

// Get out of a fight alive. Ranged threats get cover; melee threats get
// distance, which is all they understand.
async function retreat (session, ctl, entity, { maxRadius = 20, timeoutMs = 15000 }: any = {}) {
  const bot = session.bot
  try { bot.pathfinder.setGoal(null) } catch {}

  // Nothing below works while swimming: pathfinder cannot get out of water on
  // its own, and open water has no solid neighbour to build a wall against.
  // Observed in game — the bot took twenty arrows treading water.
  if (inWater(bot)) await escapeWater(bot, ctl, { timeoutMs: 8000 })

  const threat = threatPoint(entity)
  if (!threat) return { mode: 'цель пропала' }
  const ranged = !!(entity.name && RANGED.has(entity.name))
  const deadline = gameClock.now() + timeoutMs
  let towerTrouble = null

  // Shape before doctrine. Inside a drift this is the answer for archers too:
  // a filled cell stops arrows exactly as well as it stops feet, and it is
  // found by reading four blocks instead of walking a cover search that cannot
  // succeed in a corridor with no way around anything.
  const shape = corridorShape(bot, threat)
  if (shape.corridor) return retreatInCorridor(session, ctl, shape, entity, deadline)

  // Открытое место, и врагов больше одного или это крипер: «прочь от этого»
  // ведёт в другого, а стоять и строить рядом с крипером — это взрыв. Тут
  // бежим с оглядкой на всех (flee.js); прижали — дальше старая доктрина.
  const crowd = countHostiles(bot, 14)
  if (headroomAt(bot, 6) > 6 && (crowd >= 2 || DO_NOT_TRADE_WITH.has(entity.name))) {
    const ran = await flee.smartFlee(session, ctl, { timeoutMs: Math.max(3000, deadline - gameClock.now()) })
    if (!ran.cornered) return { ...ran, mode: `убежал с оглядкой: ${ran.mode}` }
  }

  // An open cave is not open ground. Everything the branch below does needs
  // sky, terrain or distance, and a cave has none of the three:
  //
  //   * the pillar needs feet+2 free to place a block and feet+3 for the one
  //     after it, and retreat only counts a pillar at two blocks or more --
  //     so a cave roof at three blocks lets exactly one block go up and the
  //     branch is guaranteed to fall through to the run;
  //   * cover means walking through rock;
  //   * running from a walker is the death this project has measured twice.
  //
  // Measured at y=-31: the bot took fourteen hits in full iron and died with
  // the intent still inside this function. Fourteen hits at about one a second
  // is fourteen seconds of not swinging, and backOff (0.9s) plus a pillar that
  // cannot go up (~5s) plus a run the pathfinder has to dig its way through
  // (~8s of stuck guard) is exactly that budget. It never swung once.
  //
  // What a cave does have is stone on most sides. Close the rest and fight:
  // one contact costs about 2 hp, two about 7, three about 14, four is death,
  // so the number worth spending blocks on is the contact count and not the
  // mob count.
  const roof = headroomAt(bot, 6)
  if (!ranged && roof <= 6 && !DO_NOT_TRADE_WITH.has(entity.name)) {
    const mobs = countHostiles(bot, 6)
    // One walker reaches us from one side whatever the room looks like, and
    // the sword wins that trade outright. Blocks are worth spending from two.
    const shield = mobs >= 2 ? await shieldFlanks(session, ctl, threat, { deadline }) : null
    const sides = openSides(bot, 2).length
    // Three things in contact costs about 14 hp to fight through and four
    // kills. If the sides could not be closed and there are that many, the
    // pillar below is worth its five seconds after all -- but only where it
    // can actually go up: it needs feet+2 free to place a block and feet+3 for
    // the second, and retreat only counts two as a pillar. Under a roof of
    // three it can place exactly one, which is how the old branch used to end
    // up running instead.
    const pillarPossible = roof >= 4
    if (!(mobs >= 3 && sides >= 3 && pillarPossible)) {
    // Shielding can turn the spot into a genuine drift, and then the seal is
    // available for free between swings.
      const walled = corridorShape(bot, threat)
      const held = await holdTheLine(session, ctl, walled.corridor ? walled : null, entity, deadline)
      if (held.held) {
        return {
          mode: held.sealed ? 'запечатался в пещере' : (held.killed ? 'убил в пещере' : 'держу место в пещере'),
          cave: true,
          roof,
          mobs,
          sides: openSides(bot, 2).length,
          shielded: shield ? shield.placed : 0,
          sealed: !!held.sealed,
          killed: held.killed,
          swings: held.swings,
          at: xyz(bot.entity.position)
        }
      }
    }
    // Either nothing to hit with, or too many sides open and a roof high
    // enough to climb out of reach. The old branch owns both cases.
  }

  if (ranged) {
    // Wall first, cover second. This order was learned by dying: hunting for
    // natural cover means walking under fire for as long as the search takes,
    // and the bot went 20 hp to 0 three times doing that on open ground. Two
    // blocks dropped in the line of fire take under a second and end the
    // shooting immediately.
    const tried = []
    const wall = await raiseWall(session, ctl, threat)
    if (wall.ok) return { mode: 'заложился блоком', at: xyz(bot.entity.position), placed: wall.placed }

    for (const spot of coverSpots(bot, threat, maxRadius).slice(0, 3)) {
      if (ctl.aborted || gameClock.now() >= deadline) break
      // One bad candidate must not eat the whole budget.
      const leg = Math.min(deadline, gameClock.now() + 5000)
      const r = await travelXZ(bot, ctl, spot.x, spot.z, { range: 1, retries: 0, deadline: leg })
      tried.push(`${spot.x},${spot.z}${r.ok ? '' : ' ✗'}`)
      if (!r.ok) continue
      if (!raySees(bot, eyePos(bot), threat)) {
        return { mode: 'ушёл за укрытие', at: xyz(bot.entity.position), tried }
      }
    }
    // Fall through: distance is worse than cover but better than standing here.
  } else if (!CANNOT_BE_OUTPILLARED.has(entity.name)) {
    // Measured in game: a zombie walks faster than this bot, because sprinting
    // is off to keep the physics in sync with the server. Walking away is a
    // slower death — 20 hp to 0, twice. Up is the answer, but a bare pillar
    // fails too: every hit knocks the body off the one block it just placed.
    // So block the contact first, then climb in the gap that buys.
    // A melee mob that is already on us is standing in the exact square the
    // wall needs, and a placement into an entity is refused every time. One
    // second of walking away buys the block of separation that makes the wall
    // possible at all.
    await backOff(bot, threat, 900)

    // The shape has to be re-read where the body ended up, not where it
    // decided to move from: backOff walks about four blocks, and four blocks
    // is enough to leave the room it started in. Run 7 is why — the bot backed
    // out of an open cave towards its own drift and then spent nine seconds
    // there on the open-ground answers, building a wall into an occupied
    // square and a pillar into a ceiling, 17 hp down to 1. In a drift the
    // measured answer is the sword, and it is one blockAt sweep away.
    const nowShape = corridorShape(bot, threat)
    if (nowShape.corridor) return retreatInCorridor(session, ctl, nowShape, entity, deadline)

    const wall = await raiseWall(session, ctl, threat)
    // The instant contact is broken, stop and hand control back. The version
    // that kept climbing "to be safe" after the wall was already up spent ten
    // more seconds standing in melee range, and that is what killed the bot.
    if (wall.ok) return { mode: 'заложился блоком', placed: wall.placed, at: xyz(bot.entity.position) }

    let placed = 0
    const why = []
    for (let attempt = 0; attempt < 3 && placed < 3 && !ctl.aborted; attempt++) {
      const up = await towerUp(bot, ctl, 3 - placed)
      placed += up.placed
      if (up.why) why.push(...up.why)
      if (!up.placed && attempt > 0) break
    }
    if (placed >= 2) {
      return { mode: 'встал на столб', placed, at: xyz(bot.entity.position) }
    }
    if (why.length) towerTrouble = why.slice(0, 6)
  }

  // Последний довод — бег. Не по прямой «прочь от этого» пешком, а спринтом и
  // с оглядкой на всех, кто рядом (flee.js).
  const ran = await flee.smartFlee(session, ctl, { timeoutMs: Math.max(3000, deadline - gameClock.now()) })
  return {
    ...ran,
    mode: ranged ? `укрытия не нашёл — ${ran.mode}` : `столб не вышел — ${ran.mode}`,
    towerTrouble: towerTrouble || undefined
  }
}

// --------------------------------------------------------------- shield

// mineflayer keeps the off-hand at slot 45 (mineflayer/lib/plugins/
// simple_inventory.js:19, behind the shieldSlot feature that
// minecraft-data features.json:475 lists as 1.9..latest, so 45 on 1.21.11).
// The number has to be spelled out here because bot.inventory.items() is slots
// 9..44 and nothing else (prismarine-windows/index.js:44 sets the inventory
// window range, Window.js:414 items() = itemsRange over exactly that range).
// So a shield already on the arm is invisible to itemNamed() — which is how the
// previous version lost its own shield the instant it put it on: the first
// fight equipped it, and every fight after that decided the bot had none.
// armor.js:76 says the same thing about the four armour slots.
const OFF_HAND_SLOT = 45

// Bits of the player's `living_entity_flags` metadata: 0x01 "a hand is in use",
// 0x02 "and that hand is the off-hand". Both must be set for a raised shield.
const HAND_ACTIVE = 0x01
const HAND_IS_OFF = 0x02

// How long ONE raise is willing to block a fight tick waiting for the server to
// agree. It is a leash on the call, not a verdict on the shield: a raise that
// returns false here has still sent its packet, and the 100ms sampler below
// goes on listening for the whole fight. Confusing "I stopped listening" with
// "the server refused" cost this project a whole false diagnosis on block
// placement — that one was a 1200ms leash of ours against the 5000ms mineflayer
// itself waits. So the leash stays short (a fight tick is 650ms and the bot
// must not stand still inside it), and confirmMs/lateConfirms in the report are
// what say whether it is too short — measured, not argued.
const SHIELD_CONFIRM_MS = 600
// Items.SHIELD / BlocksAttacks.blockDelayTicks, native Java 1.21.11: round(.25 * 20).
const SHIELD_DELAY_TICKS = 5
// Two native age broadcasts (20 ticks each) plus the existing metadata ACK leash.
const SHIELD_NATIVE_CONFIRM_MS = 2 * 20 * 50 + SHIELD_CONFIRM_MS

// item.shield.block is played at the blocker's feet, so anything further than
// this is somebody else's shield.
const SHIELD_SOUND_RANGE = 3

// One swing of a sword: the cooldown the fight loop paces itself by, and the
// unit the shield's cost is billed in — a second of block inside sword reach is
// a second and a half of damage not dealt.
const SWING_MS = 650

// Полупериод чередования в режиме замера. Три секунды — это и заметно больше
// задержки подъёма (замерено 43мс), и достаточно, чтобы в каждую фазу попало
// несколько стрел.
const MEASURE_PHASE_MS = 3000

function offHandItem (bot) {
  try { return bot.inventory.slots[OFF_HAND_SLOT] || null } catch { return null }
}

// A shield wherever it is. `worn` is the whole difference between "put it on"
// and "leave it alone", and it is the case items() cannot see.
function findShield (bot) {
  const off = offHandItem(bot)
  if (off && off.name === 'shield') return { item: off, worn: true }
  const bag = itemNamed(bot, 'shield')
  return bag ? { item: bag, worn: false } : null
}

// mcData carries the metadata layout, so the index is read rather than
// remembered: entitiesByName.player.metadataKeys on 1.21.11 is
// [shared_flags, air_supply, custom_name, custom_name_visible, silent,
//  no_gravity, pose, ticks_frozen, living_entity_flags, ...] — 8 today, and the
// lookup keeps it right the day it is not.
function livingFlagsKey (bot) {
  try {
    const keys = bot.registry.entitiesByName.player.metadataKeys
    const i = keys.indexOf('living_entity_flags')
    if (i >= 0) return i
  } catch {}
  return 8
}

// The only server-confirmed answer to "is the shield actually up".
// bot.entity is registered in bot.entities under our own id (entities.js:105)
// and the entity_metadata handler (entities.js:449) writes every key into
// entity.metadata — ours included, because the server sends a player its own
// metadata. bot.usingHeldItem is NOT this: inventory.js:116 sets it before the
// packet is even written, so it records our intention and nothing else.
function shieldUp (bot) {
  try {
    const flags = bot.entity.metadata[livingFlagsKey(bot)]
    if (typeof flags !== 'number') return false
    return (flags & HAND_ACTIVE) !== 0 && (flags & HAND_IS_OFF) !== 0
  } catch { return false }
}

// A shield only stops what comes at the front, and this is the half of that
// rule the bot can check about itself: the cosine between where its head points
// and where the threat is, on the horizontal plane. yaw -> direction uses the
// same convention pathfinder writes at index.js:607
// (bot.look(Math.atan2(-dx, -dz), 0)), i.e. the view vector is (-sin, -cos).
// Positive means the threat is in the front half.
function facingCos (bot, point) {
  try {
    const p = bot.entity.position
    const dx = point.x - p.x
    const dz = point.z - p.z
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) return 1
    const yaw = bot.entity.yaw
    return (dx / len) * -Math.sin(yaw) + (dz / len) * -Math.cos(yaw)
  } catch { return 0 }
}

// Everything the bot can learn about its own shield while a fight is running,
// in one object: whether it is on the arm, whether the server agrees it is up,
// what it stopped, and what holding it cost in swings. The last two are the
// reason this exists at all — "щит поднят" is not a result, and the brain
// cannot decide «драться или закрыться» without a price on the second option.
//
// policy:
//   'never'  — do not wear it, do not raise it. The control.
//   'ranged' — wear it, raise it only walking into a shooter. Old doctrine.
//   'always' — also hold it between swings in melee, through the sword cooldown.
//   'measure' — ДЛЯ СЦЕН, не доктрина: не преследовать вовсе и поднимать блок
//             циклом. Сравнение «со щитом против без» между прогонами тонет в
//             разбросе арены — 12 секунд обстрела дали 1.5 хп против 1, то есть
//             одну стрелу. Чередование внутри ОДНОГО боя даёт парное сравнение
//             под одними и теми же стрелами, и разброс арены сокращается сам.
//             Заодно снимает нужду в геометрии, удерживающей бота от сближения.
function makeShield (session, ctl, { shield: policy = 'ranged' }: any = {}) {
  const bot = session.bot
  const on = policy !== 'never'
  const st = {
    policy,
    have: false,
    worn: false,
    raises: 0,
    confirmed: 0,
    blocked: 0,
    disabled: 0,
    // Worst observed lag between asking and the server agreeing, and how many
    // of those agreements landed after raise() had already given up waiting.
    confirmMs: 0,
    lateConfirms: 0,
    // Подъёмы, которых мы не просили. Раньше такой фронт списывался в
    // задержку последнего заказа и давал confirmMs 11827 при окне 600: это
    // не «сервер думал двенадцать секунд», это два разных события, сшитых
    // в одно. Заказ теперь ПОГАШАЕТСЯ первым же фронтом, а всё, что пришло
    // после, считается здесь и в задержку не попадает.
    spontaneous: 0,
    // Сколько звуков вообще долетело за бой. Один integer, который
    // отличает «сервер молчал» от «звуков было сорок, щитового ни одного» —
    // без него ноль погашенных не диагностируется вообще ничем.
    soundsHeard: 0,
    upMs: 0,
    openMs: 0,
    facingMs: 0,
    idleMs: 0,
    reachMs: 0,
    swings: 0,
    hpUp: 0,
    hpDown: 0
  }
  let why = null
  let want = false
  let up = false
  let disabledUntil = 0
  let lastAsk = 0
  let target = null
  let reach = 3.2
  let lastHp = bot && typeof bot.health === 'number' ? bot.health : 20
  let lastTick = 0
  let closed = false
  let charge = null
  const blocking = () => !closed && !ctl.aborted && offHandItem(bot)?.name === 'shield' &&
    gameClock.now() >= Math.max(disabledUntil, bot._ndShieldDisabledUntil || 0) && shieldUp(bot) && !!charge?.ready(SHIELD_DELAY_TICKS)
  const census = process.env.ND_SHIELD_SOUNDS ? new Map() : null

  // Server-confirmed proof that the block did something. Packet coordinates
  // are eighths, hence a plain distance check against our own feet.
  // Имя звука — через melee.soundName (2026-09-26): mineflayer (sound.js)
  // берёт bot.registry.sounds[id] без сдвига, а номера minecraft-data 1.21.11
  // на 1 меньше серверных (замер melee.js, SOUND_SHIFT) — по его
  // soundEffectHeard «item.shield.block» был выбитый щит (item.shield.break), а
  // настоящий блок приходил чужим именем, и счёт погашенных врал.
  const onSound = (name, pt) => {
    if (!pt || !name) return
    try {
      if (bot.entity.position.distanceTo(pt) > SHIELD_SOUND_RANGE) return
    } catch { return }
    st.soundsHeard++
    // Перепись имён — только по требованию: она нужна ровно один раз, когда
    // надо выяснить, под каким именем звук приходит и приходит ли. Держать
    // её в каждом отчёте боя — платить токенами за отладку, которая кончилась.
    if (census) census.set(String(name), (census.get(String(name)) || 0) + 1)
    if (String(name).endsWith('item.shield.block')) st.blocked++
  }

  // An axe hit knocks the shield out of use for a few seconds, and the only
  // thing said about it on the wire is a cooldown. mineflayer's own handler
  // (inventory.js:91) reads packet.itemID, which does not exist in 1.21.11 —
  // the field is cooldownGroup, a string like "minecraft:shield" — so it always
  // returns early and this has to be read off the raw packet.
  const onCooldown = (pkt) => {
    const group = String((pkt && pkt.cooldownGroup) || '')
    if (!/shield/.test(group)) return
    st.disabled++
    disabledUntil = gameClock.now() + Math.max(0, (pkt.cooldownTicks || 0)) * 50
    bot._ndShieldDisabledUntil = disabledUntil
  }

  // Damage split by whether the block was actually up when it landed. This is
  // the honest version of "сколько урона щит съел": the counterfactual is not
  // knowable, two columns are.
  const onHealth = () => {
    const now = typeof bot.health === 'number' ? bot.health : lastHp
    const lost = lastHp - now
    lastHp = now
    if (lost <= 0) return
    if (blocking()) st.hpUp += lost
    else st.hpDown += lost
  }

  // Sampled rather than counted from our own raise/lower calls, because the
  // server drops the block under us (an axe does exactly that) and a tally of
  // what we asked for would never notice.
  const tick = () => {
    const now = gameClock.now()
    const dt = lastTick ? now - lastTick : 0
    lastTick = now
    const nowUp = shieldUp(bot)
    // The rising edge is counted HERE and nowhere else. raise() waits only long
    // enough to answer its own caller; a confirmation that arrives after that is
    // still a confirmation, and this loop is the one that never stops listening.
    // That is the whole difference between «сервер отказал» and «я перестал
    // слушать», and only one of the two means the shield is not working.
    if (nowUp && !up) {
      st.confirmed++
      if (lastAsk) {
        const lag = now - lastAsk
        // Гасим заказ: следующий фронт — это уже другое событие, и мерить
        // его от этого же lastAsk значит складывать время между событиями с
        // задержкой ответа.
        lastAsk = 0
        if (lag > st.confirmMs) st.confirmMs = lag
        if (lag > SHIELD_CONFIRM_MS) st.lateConfirms++
      } else {
        st.spontaneous++
      }
    }
    up = nowUp
    // A gap this long means the timer was starved, not that the shield was up
    // for a second: do not bill it.
    if (dt <= 0 || dt >= 1000) return
    let close = false
    if (target && target.isValid) {
      try { close = target.position.distanceTo(bot.entity.position) <= reach } catch {}
    }
    // Time in contact is billed whether or not the shield is up: it is the
    // denominator the tempo is measured against, and without it "щит стоил
    // ударов" has no number to be true or false against.
    if (close) st.reachMs += dt
    if (nowUp) {
      st.upMs += dt
      if (close) st.idleMs += dt
      if (target && target.isValid && facingCos(bot, target.position) > 0) st.facingMs += dt
    } else {
      // Знаменатель для второй колонки урона. Без него hpUnderShield и hpOpen
      // сравнивать нельзя: 3 хп за секунду и 3 хп за минуту — это одно число.
      st.openMs += dt
    }
  }

  const onRawSound = (p) => {
    try {
      const n = require('./melee').soundName(bot, p)
      if (n) onSound(n, new Vec3(p.x / 8, p.y / 8, p.z / 8))
    } catch {}
  }
  try { bot._client.on('sound_effect', onRawSound) } catch {}
  bot.on('health', onHealth)
  try { bot._client.on('set_cooldown', onCooldown) } catch {}
  const timer = gameClock.setInterval(tick, 100)
  if (timer.unref) timer.unref()

  const phase0 = gameClock.now()
  const guard = {
    melee: policy === 'always',
    measure: policy === 'measure',
    // Ровно половину времени щит поднят, ровно половину опущен, фазами по три
    // секунды. Обе колонки урона набираются в одном бою под одним обстрелом.
    phase () { return Math.floor((gameClock.now() - phase0) / MEASURE_PHASE_MS) % 2 === 0 },
    stats: st,
    // Предполётный отчёт живёт здесь по той же причине, что и щитовой: это
    // единственный объект, переживающий все выходы из тела боя, а «что я
    // надел перед дракой» должно доехать до мозга и с трупа, и с таймаута.
    pre: null,
    // Сколько врагов было рядом: на входе и в худший момент. Пока это только
    // цифра в отчёте, а не политика, и намеренно. Единственный замер щита в
    // ближнем бою («платит за себя: хп 0.7 -> 0 ценой 6.2 -> 6.6с, боёв 6»)
    // снят против ОДНОГО зомби, а в своре арифметика переворачивается: пока
    // щит поднят, бот не бьёт, свора живёт дольше и бьёт дольше, и гасится
    // при этом только фронт. Менять доктрину по этому рассуждению нельзя —
    // сначала померить. Поле нужно, чтобы мерить стало на чем: теперь каждый
    // бой, живой в том числе, приносит своё число врагов рядом с исходом.
    mobs: null,
    sawMobs (n) {
      if (!this.mobs) this.mobs = { atStart: n, max: n }
      else if (n > this.mobs.max) this.mobs.max = n
    },

    // Every swing, so the report can say what the block cost in tempo rather
    // than in arithmetic: seconds of contact divided by swings landed is the
    // one number that is comparable between a run with a shield and one
    // without, and it is the only thing «щит стоит своей цены» can mean.
    swung () { st.swings++ },

    // Which mob the accounting is about. Without it upMs is still honest but
    // the tempo — what the block cost — has nothing to measure against.
    watch (entity, r) {
      target = entity || null
      if (typeof r === 'number') reach = r
    },
    blocking,
    nativeUse () { return charge?.snapshot() ?? { useConfirmed: false, confirmedTicks: null } },
    failure () { return charge?.why() || (gameClock.now() < Math.max(disabledUntil, bot._ndShieldDisabledUntil || 0) ? 'shield_cooldown' : null) },
    get cancelled () { return charge?.cancelled },

    // Put it on the arm and make the server say so. Returns false with a reason
    // in the report rather than throwing: a fight without a shield is a fight,
    // and this must never be the thing that ends one.
    async wear () {
      if (!on) return false
      const found = findShield(bot)
      if (!found) { why = 'щита нет ни в руке, ни в рюкзаке'; return false }
      st.have = true
      if (found.worn) { st.worn = true; return true }
      // Тотем в левой руке на малом хп не менять на щит: в бою 2026-09-25 новый
      // бой надел щит поверх тотема, и бот умер на 7 хп с тотемом в рюкзаке.
      const offNow = bot.inventory.slots[45]
      if (offNow && offNow.name === 'totem_of_undying' && (bot.health ?? 20) <= 16) { why = 'в левой руке тотем — хп мало, щит не надеваю'; return false }
      // The cursor is shared with the autopilot's eating and with armor.js.
      // Two click loops at once strand an item on it — armor.js:200 pays for
      // that lesson, and this is the same cursor.
      if (bot.currentWindow) { why = 'открыт сундук — щит не трогаю'; return false }
      if (session.armorBusy) { why = 'переодеваюсь — щит потом'; return false }
      if (bot.inventory.selectedItem) { why = 'руки заняты другим кликом'; return false }
      session.armorBusy = true
      try {
        await bot.equip(found.item, 'off-hand')
      } catch (err) {
        why = String((err && err.message) || err)
        return false
      } finally {
        session.armorBusy = false
      }
      // moveSlotItem applies the click to bot.inventory itself and only then
      // writes the packet (inventory.js:658), so reading slot 45 straight back
      // is our own guess wearing a hat. One settle window, then look — the same
      // rule armor.js:236 states for the armour slots.
      await sleep(250)
      const off = offHandItem(bot)
      st.worn = !!(off && off.name === 'shield')
      if (!st.worn) why = 'сервер не подтвердил off-hand'
      return st.worn
    },

    // Raise or lower, and for a raise wait for the metadata to agree.
    // Re-sends when the server has dropped the block under us: `want` alone is
    // a memory of a packet, and an axe hit makes that memory wrong.
    async raise (raised) {
      if (!on || !st.worn) return false
      if (!raised) {
        if (!want) return false
        want = false
        charge?.close(); charge = null
        try { bot.deactivateItem() } catch {}
        // Close the edge here rather than waiting for the sampler to notice.
        // Lower and raise sit 60ms apart in a melee cycle, the sampler runs
        // every 100ms, and a cycle that fits between two samples looked like no
        // edge at all: five raises came back as three confirmations. Damage
        // attribution does not suffer, because onHealth still reads the live
        // metadata and the server has not lowered anything yet.
        up = false
        return false
      }
      if (want) {
        if (shieldUp(bot)) return true
        // Re-asking is only safe once the server has been seen to answer at
        // least once. Every activateItem() writes a fresh use_item
        // (inventory.js:115-138) and a fresh use restarts the block from zero,
        // so a bot that re-sent every tick because it could not see its own
        // metadata would hold a shield that never finishes raising. If nothing
        // has ever been confirmed, ask once and leave it: the packet did go out.
        if (!st.confirmed || gameClock.now() - lastAsk < 1000) return false
      }
      // Do not spam the packet at a shield the server is holding on cooldown;
      // the disable is timed and re-asking cannot shorten it.
      if (gameClock.now() < Math.max(disabledUntil, bot._ndShieldDisabledUntil || 0)) return false
      want = true
      lastAsk = gameClock.now()
      st.raises++
      try {
        charge?.close()
        charge = require('./bow').observeCharge(bot, { item: 'shield', hand: 'off-hand' })
        if (!charge.start()) { why = charge.why() || 'shield_native_use_not_started'; return false }
      } catch (err) {
        why = String((err && err.message) || err)
        return false
      }
      const deadline = gameClock.now() + SHIELD_CONFIRM_MS
      let aborted
      const abort = new Promise(resolve => { aborted = () => resolve(null); if (ctl.aborted) aborted(); else ctl.onAbort?.push(aborted) })
      try { while (gameClock.now() < deadline && !ctl.aborted && !closed && charge) {
        // tick() and not a counter of our own: the rising edge has exactly one
        // owner, and polling at 40ms sees blocks that go up and back down
        // between two 100ms samples — five melee raises came back as three
        // confirmations before this line existed.
        if (shieldUp(bot)) { tick(); return true }
        if (charge.why()) return false
        await Promise.race([sleep(40), charge.cancelled, abort])
      } } finally {
        const i = ctl.onAbort?.indexOf(aborted)
        if (i >= 0) ctl.onAbort.splice(i, 1)
      }
      // Not «сервер отказал» — only «не в то окно, ради которого стоит держать
      // тик боя». The sampler keeps watching and will still count it.
      return false
    },

    // Null when there was nothing to say, so an ordinary fistfight report does
    // not grow a paragraph about a shield nobody has.
    report () {
      if (!st.have && !st.raises && policy !== 'never') {
        const bare: any = { policy, worn: false, why: why || 'щита нет' }
        bare.note = shieldNote(bare)
        return bare
      }
      const sec = ms => Math.round(ms / 100) / 10
      const out: any = {
        policy,
        worn: st.worn,
        raises: st.raises,
        confirmed: st.confirmed,
        confirmMs: st.confirmMs || undefined,
        lateConfirms: st.lateConfirms || undefined,
        spontaneous: st.spontaneous || undefined,
        // Погашенные удары считаются по звуку item.shield.block с сервера, и
        // это свидетель, которого может не быть: прогон 2026-09-01 дал
        // blocked 0 при щите, который урон явно резал. Поэтому ниже идёт
        // второй свидетель — урон в секунду под щитом и без, — и решать
        // «работает ли щит» надо по нему, а не по этому счётчику.
        blocked: st.blocked,
        soundsHeard: st.soundsHeard,
        sounds: census ? [...census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) : undefined,
        disabled: st.disabled || undefined,
        ...guard.nativeUse(),
        blocking: blocking(),
        upSeconds: sec(st.upMs),
        facingSeconds: sec(st.facingMs),
        // Time the block was up while the mob was inside sword reach: the only
        // stretch where holding it could have cost anything at all.
        closedSeconds: sec(st.idleMs),
        contactSeconds: sec(st.reachMs),
        swings: st.swings,
        // Seconds of contact per swing landed. The loop aims at 0.65; anything
        // above that is time the bot stood in melee dealing no damage, whatever
        // the reason, and that is the price the brain has to weigh.
        secondsPerSwing: st.swings ? Math.round((st.reachMs / st.swings) / 100) / 10 : null,
        hpUnderShield: Math.round(st.hpUp * 10) / 10,
        hpOpen: Math.round(st.hpDown * 10) / 10,
        openSeconds: sec(st.openMs),
        // Вот это и есть ответ на «работает ли щит», не требующий ни звука,
        // ни контрфактического прогона: урон в секунду, пока блок стоял,
        // против урона в секунду, пока он был опущен, в одном и том же бою.
        hpPerSecUnder: st.upMs > 500 ? Math.round((st.hpUp / (st.upMs / 1000)) * 100) / 100 : null,
        hpPerSecOpen: st.openMs > 500 ? Math.round((st.hpDown / (st.openMs / 1000)) * 100) / 100 : null,
        why: why || undefined
      }
      out.note = shieldNote(out)
      return out
    },

    close () {
      if (closed) return
      closed = true
      charge?.close(); charge = null
      gameClock.clearInterval(timer)
      try { bot._client.removeListener('sound_effect', onRawSound) } catch {}
      bot.removeListener('health', onHealth)
      try { bot._client.removeListener('set_cooldown', onCooldown) } catch {}
      if (want) { want = false; try { bot.deactivateItem() } catch {} }
    }
  }
  return guard
}

// One line for a person, and it has to be able to say the unwelcome thing:
// a shield that never went up is worse than no shield, because the code that
// thought it was up also stopped swinging.
function shieldNote (s) {
  if (s.policy === 'never') return 'щит не поднимался (велено без щита)'
  if (!s.worn) return `щит не надет: ${s.why || 'причина неизвестна'}`
  if (s.raises && !s.confirmed) {
    return 'поднимал ' + s.raises + ' раз, и за весь бой сервер не подтвердил ни разу ' +
      '(слушали всё время боя, а не только окно ожидания) — считай, что щита нет'
  }
  if (!s.raises) return 'щит на руке, поднимать не пришлось'
  const bits = [`щит был поднят ${s.upSeconds}с`]
  // Урон в секунду под щитом против урона в секунду без него. Это ведущая
  // цифра, а не счётчик погашенных: прогон 2026-09-01 дал ноль погашенных при
  // щите, который урон резал, — свидетель по звуку оказался тем, которого
  // может не быть, а этот считается из хп, которые видно всегда.
  const under = s.hpPerSecUnder
  const open = s.hpPerSecOpen
  if (under !== null && under !== undefined && open !== null && open !== undefined) {
    bits.push(`урон ${under}/с под щитом против ${open}/с без него`)
  } else {
    bits.push(`урон под щитом ${s.hpUnderShield}, без щита ${s.hpOpen}`)
  }
  if (s.blocked) bits.push(`сервер насчитал погашенных: ${s.blocked}`)
  else if (under !== null && under !== undefined && open) {
    bits.push(under < open
      ? 'по звуку сервер о блоках молчит, но урон под щитом ниже — щит работает'
      : 'погашенных нет и урон не ниже — щит тут не помог')
  }
  if (s.upSeconds > 0 && s.facingSeconds < s.upSeconds * 0.6) {
    bits.push(`но лицом к цели только ${s.facingSeconds}с — блок гасит только спереди`)
  }
  if (s.closedSeconds > 0) {
    bits.push(`в упор стоял под щитом ${s.closedSeconds}с из ${s.contactSeconds}с`)
  }
  if (s.secondsPerSwing !== null && s.secondsPerSwing !== undefined) {
    bits.push(`темп ${s.secondsPerSwing}с/удар при норме 0.65`)
  }
  if (s.lateConfirms) {
    bits.push(`подтверждение приходило до ${s.confirmMs}мс — щит работал, ` +
      'просто медленнее окна ожидания')
  }
  if (s.disabled) bits.push(`сбит топором ${s.disabled} раз`)
  return bits.join(', ')
}

// ------------------------------------------------------------ pre-flight

// Ближе этого одеваться поздно: план из четырёх предметов — это восемь
// кликов и окно подтверждения, около секунды с небольшим, а зомби проходит
// шесть блоков примерно за три. Внутри этого радиуса дерёмся в том, что есть.
const ARMOR_GAP = 6

// Броня перед боем, один раз и до сближения.
//
// Автопилот одевает бота раз в 15 секунд и НЕ берётся за это, пока работает
// намерение (autopilot.js:457) — правило разумное, щёлкать инвентарём посреди
// работы вредно. Но бой — это намерение, в котором броня нужна больше, чем в
// любом другом. Замерено 2026-09-01 на try-shield: бот отдрался целый раунд с
// полным железным набором в рюкзаке и defense 0, потому что /clear снял
// надетое, а таймер автопилота до боя не подошёл. То есть исключение не
// размывает правило, а достаёт из него ровно один случай — и ровно один
// момент, когда это дёшево: пока моб ещё идёт к нам.
async function dressForFight (session, ctl, entity) {
  const bot = session.bot
  let gap = Infinity
  try { gap = entity.position.distanceTo(bot.entity.position) } catch {}
  // Голым — одеваться даже вплотную: секунда кликов дешевле боя с защитой 0
  // (арена 2026-09-25: бот раз за разом дрался без брони, полный комплект в рюкзаке).
  const naked = [5, 6, 7, 8].every(s => !bot.inventory.slots[s])
  const hasArmor = bot.inventory.items().some(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name))
  if (gap <= ARMOR_GAP && !(naked && hasArmor)) return { skipped: `вплотную (${Math.round(gap)} бл.) — дерусь в чём есть` }
  // Рот и руки — один курсор: actions.eat таскает еду через bot.equip
  // (actions.js:1103). armor.js теперь проверяет этот же флаг у себя, но
  // спросить до кликов дешевле, чем получить отказ после.
  if (session.eating) return { skipped: 'ем — дерусь в чём есть' }

  const t0 = gameClock.now()
  let r
  try {
    r = await armor.equipBestArmor(session, ctl, { confirmMs: 400 })
  } catch (err) {
    // Одеться не вышло — это не причина не драться. Мозг увидит причину
    // словами и решит сам, стоит ли отступать.
    return { skipped: String((err && err.message) || err) }
  }
  const seconds = Math.round((gameClock.now() - t0) / 100) / 10
  if (r.stopped) return { skipped: r.stopped, defense: r.defense }
  if (!r.equipped.length) return { already: true, defense: r.defense }
  // Цена видна: это клики, и они стоят секунд перед контактом.
  return {
    put: r.equipped.map(e => e.item),
    defense: r.defense,
    seconds,
    skipped: r.skipped ? r.skipped.join('; ') : undefined
  }
}

// ---------------------------------------------------------------- fight

// The brain picks the target, the weapon and when to bail. The swinging is
// done here, because a 2-5 second round trip cannot hit anything.
// Except one target it does not get to pick by accident: a person. allowPlayer
// has to be written into the call, and findTarget refuses every other way in.
// The shield lives outside the body so that every one of the body's exits —
// kill, seal, retreat, timeout, throw — reports the same accounting and drops
// the block on the way out. Missing one of those returns is how a bot walks
// away from a won fight still standing there with its shield up.
const FIGHT_NOAVOID = () => process.env.ND_FIGHT_NOAVOID !== '0'
// Сторож боя (ND_FIGHT_WATCH=1): бой мобу, которого не достать (зомби на краю лесенки сверху, паук прыгает), шёл
// десятки секунд без взмахов, пока бьют (trap4 02.10: «взмахов 0, попаданий 1», 16 → 0 за 20 с; пещера — паук 7.8 с при
// зомби рядом). Ни одного удара за 4 с при потере ≥ 4 хп, или за 8 с при ≥ 8 — бросить бой: дальше отвечает тот, кто
// звал (кампания, автопилот EMERGENCY — бой самоохраняемый, его он не рвёт).
const FIGHT_WATCH = () => process.env.ND_FIGHT_WATCH !== '0'
function watchFight (bot, parent) {
  const sub: any = { aborted: false, onAbort: [], why: null }
  sub.abort = () => {
    if (sub.aborted) return
    sub.aborted = true
    for (const fn of sub.onAbort) { try { fn() } catch {} }
  }
  parent.onAbort.push(() => sub.abort())
  if (parent.aborted) sub.abort()
  if (!FIGHT_WATCH() || !bot) return { ctl: sub, close: () => {} }
  const hp0 = bot.health ?? 20
  const t0 = gameClock.now()
  let swings = 0
  const attack = bot.attack
  bot.attack = function (...args: any[]) { swings++; return attack.apply(this, args) }
  // Прогресс боя — не только взмах (S7d, ревью Codex по гонке вооружений: лучник/арбалетчик стрелял и попадал, а сторож
  // «ни одного удара за 4 с» бросал бой — 9 из 12 боёв проигравшего оборваны): выстрел/бросок (отпустил «использовать»)
  // и урон по другой сущности рядом — тоже ход.
  const deact = bot.deactivateItem
  if (typeof deact === 'function') bot.deactivateItem = function (...args: any[]) { swings++; return deact.apply(this, args) }
  const onHurt = (e) => { try { if (e && e !== bot.entity && bot.entity && e.position && e.position.distanceTo(bot.entity.position) < 48) swings++ } catch {} }
  try { bot.on('entityHurt', onHurt) } catch {}
  const timer = gameClock.setInterval(() => {
    const lost = hp0 - (bot.health ?? 0)
    const dt = gameClock.now() - t0
    if (swings === 0 && ((dt >= 4000 && lost >= 4) || (dt >= 8000 && lost >= 8))) {
      sub.why = `ни одного удара за ${Math.round(dt / 1000)} с, а потерял ${Math.round(lost)} хп — бросил бой`
      sub.abort()
    }
  }, 250)
  return { ctl: sub, close: () => { gameClock.clearInterval(timer); if (bot.attack !== attack) bot.attack = attack; if (typeof deact === 'function' && bot.deactivateItem !== deact) bot.deactivateItem = deact; try { bot.removeListener('entityHurt', onHurt) } catch {} } }
}

// The producer owns the price comparison. This mailbox belongs to one intent,
// not watchFight's child controller, and never aborts a physical action.
function strategicYieldState (ctl) {
  if (!ctl._ndStrategicYield) {
    const state = ctl._ndStrategicYield = { pending: null, closed: false }
    ctl.onAbort.push(() => { state.pending = null; state.closed = true })
  }
  return ctl._ndStrategicYield
}

function requestStrategicYield (session, p: any = {}) {
  const current = session.current
  if (current?.name !== 'fight' || !current.ctl || current.ctl.aborted || current.ctl._ndStrategicYield?.closed) return { accepted: false, reason: 'no active fight' }
  if (current.params?.allowStrategicYield !== true) return { accepted: false, reason: 'fight did not opt in' }
  for (const key of ['roundScope', 'fightId', 'target']) {
    if (typeof p?.[key] !== 'string' || !p[key] || p[key] !== current.params[key]) return { accepted: false, reason: `${key} mismatch` }
  }
  const r = p.request
  if (r !== null && (!r || typeof r.requestId !== 'string' || !r.requestId ||
    !['LootChest', 'Recover'].includes(r.preparation) || typeof r.quoteEvidence !== 'string' ||
    !Number.isFinite(r.before) || !Number.isFinite(r.after))) return { accepted: false, reason: 'invalid preparation request' }
  const state = strategicYieldState(current.ctl)
  const receivedAt = gameClock.now()
  state.pending = r === null ? null : { requestId: r.requestId, preparation: r.preparation,
    quoteEvidence: r.quoteEvidence, before: r.before, after: r.after, receivedAt }
  return { accepted: true, receivedAt }
}

async function fight (session, ctl, opts: any = {}) {
  const w = watchFight(session.bot, ctl)
  const pctl = ctl
  const yieldState = opts.allowStrategicYield === true ? strategicYieldState(pctl) : null
  const strategicYield = () => {
    if (!yieldState || yieldState.closed || pctl.aborted || session.current?.ctl !== pctl) return null
    const pending = yieldState.pending
    // Two 500-game-ms watcher periods: stale prices must be quoted again.
    return pending && gameClock.now() - pending.receivedAt < 1000 ? { ...pending } : null
  }
  ctl = w.ctl
  const guard: any = makeShield(session, ctl, opts)
  guard.safety = survival.watch(session.bot)
  // Обход мобов pathfinder'а (flee.mobAvoidance) в бою мешает дойти до цели: клетки у самой цели и у её соседей
  // стоят по 30–50, поиск кончается partial/noPath, и тело стоит под ударами (trap0 02.10, пещера: «взмахов 0»,
  // 18 → 0 за 15 с, путь partial length 3 → noPath). В бою к цели — без обхода; отход (retreat/disengage) — с ним.
  // По умолчанию так (замер survival 02.10–03.10); ND_FIGHT_NOAVOID=0 — по-старому.
  const bot = session.bot
  const avoidWas = bot._ndNoMobAvoid
  if (FIGHT_NOAVOID()) bot._ndNoMobAvoid = true
  try {
    let r
    try {
      r = await fightBody(session, ctl, { ...opts, strategicYield }, guard)
    } catch (e) {
      if (!ctl.why || pctl.aborted) throw e
      r = {}
    }
    if (ctl.why && !pctl.aborted) {
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      r = { ...r, stopped: ctl.why, watched: true }
    }
    return { ...r, shield: guard.report(), armor: guard.pre || undefined, mobs: guard.mobs || undefined }
  } finally {
    if (yieldState) { yieldState.pending = null; yieldState.closed = true }
    w.close()
    bot._ndNoMobAvoid = avoidWas
    guard.safety.close()
    guard.close()
  }
}

async function fightBody (session, ctl, { target, retreatAtHealth = 6, reach = 3.2, timeoutSeconds = 60, allowPlayer = false, calmAfterMs = 0, clearArea, arena = null, purpose, resourceGoal, allowRanged, lastStand = false, repelLava = false, engaged = false, roundScope = null, strategicYield = null }: any = {}, guard) {
  const bot = session.bot
  // Зачистка большой площадки: искать первого по всему её радиусу.
  const entity = findTarget(bot, target, session, { allowPlayer, radius: Math.max(24, clearArea || 0) })
  if (!entity) throw new Error(`не вижу цель${target ? ' ' + target : ''}${attackerHint(session)}`)
  const decision = decideFight(session, entity, { target, clearArea, purpose, resourceGoal })
  if (decision.skip) return { skipped: true, stopped: decision.stopped, purpose: decision.purpose }

  const label = entity.username || entity.name
  const ranged = !!(entity.name && RANGED.has(entity.name))

  // Fighting from the water is not fighting: pathfinder will not swim to the
  // target and the body just floats there being shot.
  let wasWet = false
  if (inWater(bot) && !lastStand) {
    wasWet = true
    await escapeWater(bot, ctl, { timeoutMs: 8000 })
  }

  const weapon = bestWeapon(bot)
  if (weapon) await bot.equip(weapon, 'hand')

  // Порядок не случаен: armor.js кладёт щит в свободную левую руку последним
  // шагом своего плана, так что после него guard.wear() чаще всего находит
  // щит уже надетым и не кликает второй раз.
  guard.pre = await dressForFight(session, ctl, entity)

  // A shield in the off-hand is the difference between trading with a skeleton
  // and being pincushioned on the approach. It goes on for every fight and not
  // only against shooters: the clicks cost two hundred milliseconds once, and
  // a bot that equips it mid-fight equips it while being shot at.
  guard.watch(entity, reach)
  guard.sawMobs(countHostiles(bot, 8))
  await guard.wear()

  // Модуль PvP распознаёт также лечебные зелья; общий вход проверяет еду и
  // оружие, а его цикл — безопасное окно для конкретного лечебного предмета.
  const potionHeal = bot.inventory.items().some(i => /potion$/.test(i.name) && ['heal', 'regen'].includes(pvp.potionRole(pvp.potionOf(i))))
  // engaged (S4d, tactics/minecraft.ts Fight; ND_S4D=0 — прежнее): тактика уже взвесила бой у тела (размен/«дёшево»), и проверка
  // начала боя («нет запаса еды после восстановления сытости») не отменяет его — 60 из 3135 тактических Fight живой телеметрии
  // кончились «skipped» без единого взмаха, тактика выбирала их снова. Остаётся проверка продолжения боя (phase continue).
  const preparation = guard.safety.check({ target: entity, phase: engaged && process.env.ND_S4D !== '0' ? 'continue' : 'start', minHealth: Math.max(8, retreatAtHealth), instantHeal: potionHeal, repelLava })
  // Арена с игроком (arena задан): бой до конца, как arenaStay в pvp.duel — без оружия и еды тоже (гонка вооружений, s7).
  const arenaDuel = !!arena && isPlayerEntity(entity) && preparation.action !== 'dead'
  if (!lastStand && !arenaDuel && preparation.action !== 'fight') {
    await guard.raise(false)
    if (FIGHT_NOAVOID()) bot._ndNoMobAvoid = false
    const escape = await survival.disengage(session, ctl, () => [entity, ...flee.hostilesAround(bot, 16).map(h => h.e)])
    return { skipped: true, lowHealth: preparation.action === 'recover', stopped: preparation.reason, safety: preparation, escape }
  }

  // Человек — другой бой. Моб идёт по прямой и бьёт, когда достал; человек
  // отходит в перезарядке, крутится и бьёт в прыжке, и доктрина «подошёл и
  // махай раз в 650 мс» проигрывает ему всухую (живой прогон 2026-09-24: 12
  // ударов бота против 20). Вся тактика — в pvp.js.
  if (isPlayerEntity(entity)) {
    const r = await pvp.duel(session, ctl, entity, {
      retreatAtHealth,
      timeoutSeconds,
      guard,
      calmAfterMs: calmAfterMs || 0,
      allowRanged,
      lastStand,
      repelLava,
      purpose: decision.purpose,
      roundScope,
      strategicYield,
      // Поле арены (arena.js): не уходить с него за соперником, вернуться, если выпал.
      arena
    })
    if (!lastStand && r.lowHealth && !ctl.aborted && (bot.health ?? 0) > 0) {
      if (FIGHT_NOAVOID()) bot._ndNoMobAvoid = false
      const how = await retreat(session, ctl, entity)
      return { ...r, retreated: true, ...how }
    }
    return r
  }

  // Моб на открытом месте — то же микро: зомби достаёт на ~1.4 блока, мы на
  // 2.9, так что удар с края и шаг назад в перезарядке оставляют его без
  // ответа; скелету — зигзаг и уклон от стрел; криперу — спринт-удар и отход.
  // В штреке остаётся старая доктрина ниже: там не отступают и запечатывают.
  // Здоровье кончилось — отход по доктрине (retreat), как и раньше.
  if (lastStand || repelLava || !corridorShape(bot, threatPoint(entity)).corridor) {
    const hunting = /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(entity.name || '')
    const r = await pvp.duel(session, ctl, entity, {
      retreatAtHealth,
      timeoutSeconds,
      guard,
      clearArea: decision.clearArea,
      allowRanged,
      lastStand,
      repelLava,
      purpose: decision.purpose
    })
    if (!lastStand && r.lowHealth && !ctl.aborted && (bot.health ?? 0) > 0) {
      const from = entity.isValid ? entity : nearestHostile(bot, 16)
      if (FIGHT_NOAVOID()) bot._ndNoMobAvoid = false
      const how = from ? await retreat(session, ctl, from) : { mode: 'врагов рядом уже нет' }
      return { ...r, retreated: true, from: from ? (from.name || '?') : undefined, ...how }
    }
    // Добыча: мясо с животного, порох с крипера, стрелы со скелета. Бой в
    // поле (pvp.duel) кончается на смерти цели, а дроп остаётся лежать —
    // охота за едой приносила ноль свинины (прогон campaign 2026-09-25).
    // Штрековая ветка ниже подбирает сама; здесь — то же, если цель умерла.
    if ((r.kills && r.kills.length) || !entity.isValid) {
      const before = countItems(bot)
      // Животное могло умереть от стрелы вне прежних восьми блоков. Подбор
      // должен видеть место смерти, иначе охота тратит стрелы и приносит ноль.
      const radius = hunting ? Math.max(8, Math.min(24, Math.ceil(entity.position.distanceTo(bot.entity.position)) + 2)) : 8
      try { await collectNearbyDrops(bot, ctl, { radius, timeoutMs: 5000 }) } catch {}
      r.gained = diffItems(before, countItems(bot))
      r.picked = (Object.values(r.gained) as any[]).reduce((n: any, count) => n + count, 0)
    }
    return r
  }

  // Walking at an archer down a straight drift is the one approach with no
  // cover at any point of it, and the price is measured, not guessed: run 3b
  // walked fifteen blocks and went 17 hp to 5 while landing two swings, run 3
  // walked nine and paid 4. Call it 0.8 hp per block and use the worse of the
  // two readings, because guessing high costs two blocks of cobblestone and
  // guessing low costs twelve hp. The wall is the other side of that trade:
  // run 3 sealed at ten blocks for two blocks and zero damage.
  const APPROACH_COST_PER_BLOCK = 0.8

  // Decided before the chase starts rather than at the health threshold,
  // because reaching that threshold means taking the arrows first: the same
  // code sealed from its own square at 17 hp and walked nine blocks into the
  // line at 20, in the same drift, purely because of where health started.
  //
  // And decided against retreatAtHealth alone. An earlier version had its own
  // quiet second threshold two points above that one; it never actually fired
  // in a run, but a policy the brain cannot see is a policy it cannot argue
  // with. The brain sets exactly one number, and the only question asked here
  // is whether the walk would spend it -- with the arithmetic put into the
  // result in words, so "I stopped short of a fight you ordered" arrives as a
  // sentence and not as a surprise.
  if (ranged && !ctl.aborted) {
    const gap = entity.position.distanceTo(bot.entity.position)
    const toll = Math.round(gap * APPROACH_COST_PER_BLOCK)
    const line = corridorShape(bot, threatPoint(entity))
    // Under about four blocks it is already inside sword reach, and the sword
    // is faster than a wall.
    if (line.corridor && gap > 4 && (bot.health ?? 20) - toll <= retreatAtHealth) {
      const seal = await sealCorridor(session, ctl, line)
      if (seal.ok) {
        return {
          retreated: true,
          from: label,
          health: Math.round(bot.health ?? 0),
          swings: 0,
          mode: seal.placed ? 'запечатал штрек' : 'штрек уже перекрыт',
          why: `не пошёл на сближение: ${Math.round(gap)} блоков по прямой стоили бы ~${toll} хп, а бросать бой велено на ${retreatAtHealth}`,
          corridor: true,
          sealed: true,
          placed: seal.placed,
          at: seal.at
        }
      }
    }
  }

  // В режиме замера тело не двигается вовсе: сближение кончается ближним боем,
  // а ближний бой опускает щит и меряет уже не то. Один if вместо арены со рвом.
  const chase = () => {
    if (guard.measure) return
    try { bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true) } catch {}
  }
  chase()
  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.deactivateItem() } catch {}
  })

  const deadline = gameClock.now() + Math.min(300, timeoutSeconds) * 1000
  let swings = 0
  let stood = null
  let lastSeal = 0

  while (!ctl.aborted && gameClock.now() < deadline) {
    if (!entity.isValid) {
      await guard.raise(false)
      try { bot.pathfinder.setGoal(null) } catch {}
      await collectNearbyDrops(bot, ctl, { radius: 8, timeoutMs: 5000 })
      return {
        killed: label,
        swings,
        weapon: weapon ? weapon.name : 'кулаки',
        wasWet: wasWet || undefined,
        stoodGround: stood || undefined
      }
    }

    // Золотое яблоко раньше отхода: +4 сердца поглощения и регенерация II
    // (fightkit.healInFight — раз в 8 с, только если хп упало до 10 и ниже).
    if ((bot.health ?? 20) <= Math.max(10, retreatAtHealth + 4) && bot.inventory.items().some(i => /golden_apple$/.test(i.name))) {
      await guard.raise(false)
      if (await require('./fightkit').healInFight(session, ctl, { weapon, retreatAtHealth }).catch(() => false)) continue
    }
    const hp = bot.health ?? 20
    const safety = guard.safety.check({ target: entity, minHealth: Math.max(8, retreatAtHealth) })
    if (safety.action !== 'fight') {
      await guard.raise(false)
      if (safety.action === 'dead') return { stopped: safety.reason, safety }
      // Режим замера кончается САМ и отход не делает. Порог срабатывал и
      // раньше — ветка выше никогда не смотрела на guard.measure, — но
      // дальше тело уходило в retreat(), а отход по открытому месту от
      // стрелка это шестнадцать блоков спиной к нему, с места, без разгона
      // (mode «укрытия не нашёл, просто убежал»). Пять прогонов из пяти
      // кончились смертью ВО ВРЕМЯ отхода: замер укладывался в бюджет, а
      // отход — нет, и весь бюджет выживания держался на нём.
      // Дальше тело подхватывает автопилот: как только намерение кончилось,
      // session.current пуст, и fleeIfDying уводит бота сам. То есть выживание
      // здесь стоит не на боевой доктрине, а на рутине, и это сказано вслух.
      if (guard.measure) {
        try { bot.pathfinder.setGoal(null) } catch {}
        return {
          measured: true,
          from: label,
          health: Math.round(hp),
          swings,
          stopped: `бюджет хп исчерпан: порог ${retreatAtHealth}, отход не делаю`,
          survivesOn: 'дальше уводит автопилот (fleeIfDying), боевого отхода в режиме замера нет'
        }
      }
      if (FIGHT_NOAVOID()) bot._ndNoMobAvoid = false
      const escape = await survival.disengage(session, ctl, () => [entity, ...flee.hostilesAround(bot, 16).map(h => h.e)])
      guard.safety.lastEscape = escape
      const how = await retreat(session, ctl, entity)
      return { retreated: true, from: label, health: Math.round(bot.health), swings, safety, escape, ...how }
    }

    const tick = gameClock.now()
    guard.sawMobs(countHostiles(bot, 8))
    const dist = entity.position.distanceTo(bot.entity.position)
    if (dist <= reach) {
      await guard.raise(false)
      try {
        await bot.lookAt(entity.position.offset(0, (entity.height || 1.8) * 0.85, 0), true)
        bot.attack(entity)
        swings++
        guard.swung()
      } catch {}
      // Melee shielding is a swap, not a bonus: the block only goes up during
      // the cooldown, when there is nothing to swing with anyway. Off unless
      // asked for, because it also spends the turn the next swing needs —
      // try-shield.js case (в) is what decides whether it pays.
      if (guard.melee) await guard.raise(true)
    } else if (ranged) {
      // The block only counts against what comes at the front, and pathfinder
      // stops steering the head the moment the goal is reached (index.js:607 is
      // inside its path loop). Standing at an archer's feet with the shield up
      // and the back turned is a shield that measures as doing nothing.
      try { await bot.lookAt(threatPoint(entity), true) } catch {}
      await guard.raise(guard.measure ? guard.phase() : true)
    }
    // Sword cooldown is 0.625s; swinging faster just wastes damage. Sleeping
    // the REMAINDER of the tick rather than a flat 650, because everything
    // above it takes real time: lookAt awaits a packet and a shield raise
    // waits for the server to confirm. A flat sleep turned the stated 650 into
    // a second and more, and then a shield comparison measures the sleep.
    await sleep(Math.max(0, SWING_MS - (gameClock.now() - tick)))
  }

  await guard.raise(false)
  try { bot.pathfinder.setGoal(null) } catch {}
  return { timeout: true, target: label, swings, targetAlive: entity.isValid, stoodGround: stood || undefined }
}

module.exports = {
  fight,
  requestStrategicYield,
  watchFight,
  retreat,
  coverSpots,
  findTarget,
  nearestHostile,
  countHostiles,
  corridorShape,
  sealCorridor,
  openRun,
  headroomAt,
  openSides,
  shieldFlanks,
  dressForFight,
  ARMOR_GAP,
  makeShield,
  findShield,
  shieldUp,
  facingCos,
  offHandItem,
  OFF_HAND_SLOT,
  SHIELD_DELAY_TICKS,
  SHIELD_NATIVE_CONFIRM_MS,
  SWING_MS,
  trackAttackers,
  liveAttacker,
  HOSTILES,
  RANGED
}

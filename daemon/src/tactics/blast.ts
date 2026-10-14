// Hazards that are not mobs: primed TNT and a falling block over the head (stress stand, 06.10: the tactics did not see
// them at all). 1.21.11: PrimedTnt power 4, default fuse 80, synced fuse metadata (minecraft-data key "fuse"); entity
// damage of an explosion reaches 2 * power blocks (ExplosionDamageCalculator). A falling anvil/dripstone hurts, sand or
// gravel buries: step out of its column.
const gameClock = require('../game-clock')
const movement = require('../movement')
const flee = require('../flee')
const moves = require('../moves')

type Bot = Record<string, any>
export interface Blast { id: number; kind: 'tnt' | 'falling_block' | 'charged_creeper'; distance: number; fuse: number | null; reach: number; alarm: boolean }

export const TNT_REACH = 8

function keyOf(bot: Bot, key: string, fallback: number): number {
  const index = bot.registry?.entitiesByName?.creeper?.metadataKeys?.indexOf(key)
  return typeof index === 'number' && index >= 0 ? index : fallback
}

function fuseOf(bot: Bot, entity: Bot): number | null {
  const keys: string[] | undefined = bot.registry?.entitiesByName?.tnt?.metadataKeys
  const value = entity.metadata?.[keys ? keys.indexOf('fuse') : 8]
  return typeof value === 'number' ? value : null
}

// margin: the dodge runs 2 blocks past the alarm distance, so a flight from a mob does not re-enter it at once.
// A charged creeper (powered: blast radius 6, entity damage out to 12 blocks) is a blast too: survival.dodgeCreeper stops
// at 8-9 blocks (farm s4-stress-1, 750 TPS: Dodge selected, death); alarm when it swells or stands at the body.
export function blastNear(bot: Bot, margin = 0): Blast | null {
  const me = bot.entity?.position
  if (!me) return null
  let best: Blast | null = null
  for (const entity of Object.values(bot.entities || {}) as Bot[]) {
    if (!entity?.position || entity.isValid === false) continue
    let blast: Blast | null = null
    if (entity.name === 'tnt') {
      const distance = entity.position.distanceTo(me)
      if (distance <= TNT_REACH + 1 + margin) blast = { id: entity.id, kind: 'tnt', distance, fuse: fuseOf(bot, entity), reach: TNT_REACH + 1 + margin, alarm: distance <= TNT_REACH + 1 }
    } else if (entity.name === 'falling_block') {
      // It lands in its own column: a danger only while that column overlaps the body (half widths 0.49 + 0.3 per axis). The
      // circle of 1.2 also took the next column of a staircase dug through gravel - Dodge broke dig_down nine times in a row
      // and the iron stage paused (cl-k 14.10).
      const dx = Math.abs(entity.position.x - me.x), dz = Math.abs(entity.position.z - me.z)
      const above = entity.position.y - me.y
      const reach = 0.8 + margin / 4
      if (dx < reach && dz < reach && above > 0.5 && above < 12) blast = { id: entity.id, kind: 'falling_block', distance: Math.hypot(dx, dz), fuse: null, reach, alarm: dx < 0.8 && dz < 0.8 }
    } else if (entity.name === 'creeper' && entity.metadata?.[keyOf(bot, 'is_powered', 17)] === true) {
      const distance = entity.position.distanceTo(me)
      const swelling = entity.metadata?.[keyOf(bot, 'swell_dir', 16)] === 1
      if (distance <= 13 + margin) blast = { id: entity.id, kind: 'charged_creeper', distance, fuse: null, reach: 13 + margin, alarm: swelling || distance <= 3.3 }
    }
    // An alarming source first (a primed TNT beats a calm charged creeper), then the deepest inside its reach.
    if (blast && (!best || (blast.alarm !== best.alarm ? blast.alarm : blast.reach - blast.distance > best.reach - best.distance))) best = blast
  }
  return best
}

// The source to face: a primed TNT or charged creeper in alarm, else a creeper hissing within its 7-block swell reach
// (Creeper.SwellGoal) or standing at the body (3.3, autopilot.CREEPER.closeDist).
export function shieldableBlast(bot: Bot): { entity: Bot; kind: string; distance: number } | null {
  const me = bot.entity?.position
  if (!me) return null
  const alarm = blastNear(bot)
  if (alarm?.alarm && alarm.kind !== 'falling_block' && bot.entities[alarm.id]) return { entity: bot.entities[alarm.id], kind: alarm.kind, distance: alarm.distance }
  let best: { entity: Bot; kind: string; distance: number } | null = null
  for (const entity of Object.values(bot.entities || {}) as Bot[]) {
    if (entity?.name !== 'creeper' || !entity.position || entity.isValid === false) continue
    const distance = entity.position.distanceTo(me)
    if (distance <= 7 && (flee.creeperSwelling(bot, entity) || distance <= 3.3) && (!best || distance < best.distance)) best = { entity, kind: 'creeper', distance }
  }
  return best
}

// S4d (07.10): a raised shield facing the blast takes all of it. 1.21.11 jar: damage_type tag bypasses_shield has no
// explosion (only #bypasses_armor, cactus, fire, lava, falling anvil/stalactite...), LivingEntity.applyItemBlocking compares
// the look vector with DamageSource.getSourcePosition (the creeper/TNT itself), shield block delay 0.25 s. The run
// (dodgeCreeper) left zombies and skeletons hitting the back for 3 s per dodge and a creeper that kept up: Dodge x4-5 to
// death in live telemetry (s5c-b1-1/2, s8-f1-6, f2-11 and f3-11 "blown up" while dodging). Standing still, the creeper
// walks in and spends itself on the shield.
export async function shieldBlast(session: Bot, ctl: { aborted: boolean; onAbort: Array<() => void> }, { maxMs = 4000 } = {}) {
  const bot = session.bot
  const start = gameClock.now()
  const shield = require('../combat').makeShield(session, ctl, { shield: 'always' })
  try { bot.pathfinder?.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
  let kind: string | null = null
  let blocked = false
  try {
    if (!await shield.wear()) return { how: 'shield-blast', unavailable: true, reason: 'shield not worn' }
    while (!ctl.aborted && gameClock.now() - start < maxMs && (bot.health ?? 0) > 0) {
      const source = shieldableBlast(bot)
      if (!source) break
      kind = source.kind
      await bot.lookAt(source.entity.position.offset(0, (source.entity.height || 1) * .5, 0), true)
      if (!shield.blocking()) await shield.raise(true)
      const failure = shield.failure()
      if (failure) return { how: 'shield-blast', kind, failed: true, reason: failure }
      blocked ||= shield.blocking()
      await movement.sleep(50)
    }
  } finally { shield.close() }
  return { how: 'shield-blast', kind, blocked, clear: !shieldableBlast(bot), seconds: Math.round((gameClock.now() - start) / 100) / 10 }
}

// Run out of reach along flee.pickDirection (terrain run length, mobs on the way): the blast is one more danger source,
// so dodging TNT does not run into a creeper (stress stand: TNT + creeper, dodged into the creeper's blast).
export async function dodgeBlast(session: Bot, ctl: { aborted: boolean; onAbort: Array<() => void> }, { maxMs = 4000 } = {}) {
  const bot = session.bot
  const start = gameClock.now()
  const set = (key: string, value: boolean) => { try { bot.setControlState(key, value) } catch {} }
  const stop = () => { for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(key, false) }
  ctl.onAbort.push(stop)
  try { bot.pathfinder?.setGoal(null) } catch {}
  let last: Blast | null = null
  let prevYaw: number | null = null
  try {
    while (!ctl.aborted && gameClock.now() - start < maxMs && (bot.health ?? 0) > 0) {
      const blast = blastNear(bot, 2)
      // A calm charged creeper nearby is no reason to keep running once nothing alarms.
      if (!blast || blast.kind === 'charged_creeper' && !blast.alarm && last?.kind !== 'charged_creeper') break
      last = blast
      const me = bot.entity.position
      const source = { e: bot.entities[blast.id], doc: { radius: blast.reach, weight: 10, blast: blast.reach }, d: blast.distance, swelling: true }
      const plan: { yaw: number; dir: { x: number; z: number } } | null = flee.pickDirection(bot, [source, ...flee.hostilesAround(bot, 16)], prevYaw)
      if (!plan) { stop(); break }
      prevYaw = plan.yaw
      await bot.look(plan.yaw, 0, true)
      // A step only where it is safe (review g, S4c): the run's direction was chosen by run length, but sprint momentum at
      // the end of it slid over edges; moves.stepSafe as in smartFlee (drop > 3, lava, fire, magma under the step).
      set('forward', moves.stepSafe(bot, moves.keyDir(bot, 'forward'))); set('sprint', (bot.food ?? 20) > 6)
      const ahead = bot.blockAt(me.offset(plan.dir.x * 0.8, 0, plan.dir.z * 0.8).floored())
      set('jump', ahead?.boundingBox === 'block')
      await movement.sleep(50)
    }
  } finally { stop() }
  const remaining = blastNear(bot)
  return { how: 'dodge-blast', kind: last?.kind ?? null, clear: !remaining, distance: remaining ? Math.round(remaining.distance * 10) / 10 : null,
    seconds: Math.round((gameClock.now() - start) / 100) / 10 }
}

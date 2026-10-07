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
      const flat = Math.hypot(entity.position.x - me.x, entity.position.z - me.z)
      const above = entity.position.y - me.y
      if (flat < 1.2 + margin / 4 && above > 0.5 && above < 12) blast = { id: entity.id, kind: 'falling_block', distance: flat, fuse: null, reach: 1.6 + margin / 4, alarm: flat < 1.2 }
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

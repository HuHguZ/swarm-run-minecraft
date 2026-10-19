import * as clock from './game-clock'
import pick = require('./pick')
import * as read from './read'
import route = require('./route')

export const enabled = (bot?: any): boolean => process.env.ND_OW_SHIELD !== '0' && (!bot || bot.game?.dimension === 'overworld')
const ARCHER = /^(skeleton|stray|bogged|parched)$/
const WALKER = /^(zombie|zombie_villager|husk|drowned)$/
const ORDINARY = /^(skeleton|stray|bogged|parched|drowned|zombie|zombie_villager|husk|spider|cave_spider|creeper)$/
export const RAISE_TICKS = 5 // Items.BLOCKS_ATTACKS .25s; one delivery tick is added only to the ETA below.
const ATTACK_TICKS = 20 // MeleeAttackGoal.resetAttackCooldown; spear goals are separate.
const REACH = Math.sqrt(Math.fround(2.04)) - Math.fround(.6) // Mob.DEFAULT_ATTACK_REACH
const draws = new WeakMap<object, { id: number; from: any; to: any; until?: number }>()

export function price({ inventory: inv, shield = false, hp = 20, night = false, surface = true, exposedDps = 0,
  kitIron = 4, deathS = (Number(process.env.ND_DEATH_COST_MIN) || 60) * 60, ironS = 66 }: any) {
  const count = (re: RegExp) => Object.entries(inv || {}).reduce((n, [name, value]) => n + (re.test(name) ? Number(value) : 0), 0)
  const wood = count(/_planks$/) + count(/_(log|stem)$/) * 4
  const possible = !shield && !inv?.shield && inv?.iron_ingot >= 1 && wood >= 6 + (inv?.crafting_table ? 0 : 4)
  const replacementS = inv?.iron_ingot > kitIron ? 0 : (inv?.iron_ingot || 0) + (inv?.raw_iron || 0) > kitIron ? 10 : ironS
  const craftDamage = Math.max(0, exposedDps) * 4
  const costS = 4 + replacementS + craftDamage * 4 + (craftDamage >= hp ? deathS : 0) // slow regen: 1HP/80 ticks
  const bare = route.scoutLegPrice({ night, hp, shield: false }).risk
  const guarded = route.scoutLegPrice({ night, hp, shield: true }).risk
  // shortcut: cave risk uses the route's .02 underground prior and its .6 shield share; calibrate with paired iron scenes.
  const risk = surface ? bare : Math.min(.5, .02 * 20 / Math.max(1, hp))
  const riskWithShield = surface ? guarded : risk * .6
  const avoidedS = Math.max(0, risk - riskWithShield) * deathS
  return { take: enabled() && possible && avoidedS > costS, costS, avoidedS, replacementS, risk, riskWithShield }
}

export interface GuardPoint { id: number; point: { x: number; y: number; z: number }; kind: string }
export function rangedGuard(bot: any, entities: any[], incoming: any[] | null = null): GuardPoint | null | undefined {
  if (!enabled(bot) || entities.some(e => !!e.username || e.player)) { draws.delete(bot); return undefined }
  incoming ??= (require('./threats') as typeof import('./threats')).incoming(bot) as any[]
  const shot = incoming.find(p => /^(arrow|spectral_arrow|trident)$/.test(p.name) && p.ticks <= 10)
  const mobs = entities.map(e => bot.entities[e.id] || e).filter(e => ORDINARY.test(e.name || e.kind || ''))
  let drawing: GuardPoint | null = null
  for (const e of mobs) {
    if (!ARCHER.test(e.name) || e.isValid === false || !e.position || !pick.aim(bot, e, { range: 32 })?.point || read.aimAngle(bot, e) > 90) continue
    const keys = bot.registry.entitiesByName[e.name]?.metadataKeys || []
    const flags = e.metadata?.[keys.indexOf('living_entity_flags')]
    const hand = e.equipment?.[typeof flags === 'number' && flags & 2 ? 1 : 0]?.name
    if (typeof flags === 'number' && flags & 1 && hand === 'bow') {
      drawing = { id: e.id, point: e.position.offset(0, (e.height || 1.8) * .75, 0), kind: hand }
      draws.set(bot, { id: e.id, from: e.position.offset(0, 1.64, 0), to: bot.entity.position.clone() })
      break
    }
  }
  if (shot) { if (!drawing) draws.delete(bot); return { id: shot.entity.id, point: shot.entity.position.clone(), kind: shot.name } }
  if (drawing) return drawing
  const release = draws.get(bot), source = release && bot.entities[release.id]
  const flags = source?.metadata?.[bot.registry.entitiesByName[source?.name]?.metadataKeys?.indexOf('living_entity_flags')]
  if (release && !(typeof flags === 'number' && flags & 1) && source?.isValid !== false && source?.position && pick.aim(bot, source, { range: 32 })?.point) {
    const dx = release.to.x - release.from.x, dz = release.to.z - release.from.z, d = Math.hypot(dx, dz)
    const across = d ? Math.abs((bot.entity.position.x - release.from.x) * dz - (bot.entity.position.z - release.from.z) * dx) / d : 0
    if (release.until === undefined) {
      const dy = release.to.y + .6 - release.from.y + d * Math.fround(.2), n = Math.hypot(dx, dy, dz) || 1
      const hit = (require('./threats') as typeof import('./threats')).closestApproach(bot, release.from, { x: dx / n * Math.fround(1.6), y: dy / n * Math.fround(1.6), z: dz / n * Math.fround(1.6) }, .05, 24)
      // Release can precede the arrow's second position receipt: retain its ballistic ETA, never a renewed grace timer.
      release.until = clock.now() + (hit.ticks + 1) * 50
    }
    if (across <= .9 && clock.now() < release.until!) return { id: release.id, point: release.from, kind: 'unmeasured bow flight' }
  }
  draws.delete(bot)
  if (!mobs.length) return undefined
  return null
}

export function meleeGuard(bot: any, e: any, lastSwingAt = 0, holding = false): boolean | null {
  if (!enabled(bot) || e.username || !WALKER.test(e.name) || /spear$|_axe$|^trident$/.test(e.equipment?.[0]?.name || '')) return null
  if (!pick.aim(bot, e, { range: 16 })?.point) return false
  const lead = RAISE_TICKS + 1, me = bot.entity, p = me.position, q = e.position
  const vx = (e.velocity?.x || 0) - (me.velocity?.x || 0), vz = (e.velocity?.z || 0) - (me.velocity?.z || 0)
  const dx = q.x - p.x, dz = q.z - p.z, width = ((me.width || .6) + (e.width || .6)) / 2
  const half = width + REACH + (holding ? width : 0) // exit one combined half-width past the entry reach
  const near = Math.abs(dx) < half + Math.max(0, -Math.sign(dx) * vx) * lead &&
    Math.abs(dz) < half + Math.max(0, -Math.sign(dz) * vz) * lead && q.y < p.y + (me.height || 1.8) && q.y + (e.height || 1.95) > p.y
  return near && (!lastSwingAt || lastSwingAt + ATTACK_TICKS * 50 - clock.now() <= lead * 50)
}

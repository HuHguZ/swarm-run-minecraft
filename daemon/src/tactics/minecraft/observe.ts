import { ownsHuntCover } from '../../pearls/hunt-cover'
// Тактика: типы порта Minecraft, снимок состояния для телеметрии, наблюдение угроз и выходов (observeTactics).
import { S4D, digDownCost, boxBuildCost, threatLevel, sustainableFight, meleeReachable, type TacticalState, type TacticalEnemy, type Candidate, type ThreatLevel, type ControlOwner, type ActionId } from '../state'
import { lavaCapabilities, inLava } from '../lava-escape'
import { createEmergencyEscape, lavaFallFloor } from '../../combat/emergency-escape'
import { webBoatPlan } from '../web-boat'
import { boatHopAvailable } from '../../combat/boat-hop'
import { mountedBoatDry } from '../../combat/boat-placement'
import { blastNear } from '../blast'
import { rangedGuard } from '../../ow-shield'
import * as clock from '../../game-clock'
import * as locks from '../../reflex-lock'
import * as survival from '../../survival'
import * as safety from '../../combat-safety'
import * as flee from '../../flee'
import * as guard from '../../ne-guard'
import * as movement from '../../movement'
import * as pick from '../../pick'
import * as polarBear from '../../polar-bear'
import * as actions from '../../actions'

// Mineflayer plugins extend the bot/session at runtime; this is the protocol boundary.
export type MinecraftSession = Record<string, any>
export type MinecraftEntity = Record<string, any>
export interface Controller { aborted: boolean; onAbort: Array<() => void>; abort(): void }
export interface Episode { action: Candidate; at: number; hp: number; level: ThreatLevel; candidates: Candidate[]; token: number; state: Record<string, unknown>; intent?: Controller }

// What the arbiter saw when it chose (telemetry, farm/analysis/tactics-report): enough to replay a death on the stress stand.
export function stateSnapshot(state: TacticalState, bot?: MinecraftEntity): Record<string, unknown> {
  const flags = ['lava', 'burning', 'hotFloor', 'fireResistance', 'explosion', 'dangerousFall', 'inWater', 'drowning', 'waterEmergency', 'waterEscape', 'cover', 'escapeRoute', 'contact',
    'canFight', 'weapon', 'shield', 'edible', 'water', 'embedded', 'airborne', 'lavaAhead', 'lavaEscapePending', 'escapeExhausted',
    'piglinWitnesses', 'protectedEncounter', 'niche', 'netherHide', 'ghastEdge', 'pearlEscape', 'flightEscape', 'fireResistancePotion'] as const
  return { ...(bot ? { body: (require('../../gamedata') as typeof import('../../gamedata')).bodySnapshot(bot) } : {}), hp: Math.round(state.health * 10) / 10, food: state.food, armor: state.armor, blocks: state.blocks, shelter: state.shelter,
    blast: state.blast ?? undefined, digDownCostHp: state.digDownCostHp, buildCostHp: state.buildCostHp, polarBear: state.polarBear ?? undefined, owGuard: state.owGuard, projectiles: state.incomingProjectiles || undefined, failed: state.failedEscapes?.length ? state.failedEscapes : undefined,
    on: flags.filter(flag => state[flag]),
    enemies: state.enemies.map(enemy => ({ id: enemy.id, kind: enemy.kind, unseen: enemy.unseen || undefined, d: Math.round(enemy.distance * 10) / 10, ...(enemy.threatening ? {} : { calm: true }),
      ...(typeof enemy.hit === 'number' ? { hit: Math.round(enemy.hit * 10) / 10 } : {}) })) }
}
let autopilot: any, threats: any, itemTools: any, pack: any
export const foodActions: {
  bestFood(bot: MinecraftEntity, data: MinecraftEntity): MinecraftEntity | null
  eat(session: MinecraftSession, ctl: Controller, options: Record<string, unknown>): Promise<unknown>
} = actions

function exitsNear(bot: MinecraftEntity): { route: boolean; signature: string } {
  // A run is judged from the ground under the body: in a crit jump the floored feet are a block up for 6 of 12 ticks and
  // saw no floor - no route, "exhausted" - then a route again on landing (farm 06.10, slot 30: Fight<->LastStand every
  // sample while jumping at blazes, 11 swaps in 2 s, then death).
  let feet = bot.entity.position.floored()
  if (!bot.entity.onGround && bot.blockAt(feet.offset(0, -1, 0))?.boundingBox !== 'block' &&
      bot.blockAt(feet.offset(0, -2, 0))?.boundingBox === 'block') feet = feet.offset(0, -1, 0)
  const facts: string[] = []
  let route = false
  // A run walks terrain: a step up (with head room to jump) or a drop of 1-2 is a route, as for smartFlee's runLength. The
  // flat-only check saw no exit on natural ground at every other cell, and escapeExhausted swapped LastStand and
  // CreateDistance on every step (farm slot 18, 06.10 22:57:41-46 MSK: 4 deaths, LastStand<->CreateDistance in 1-2 game s).
  const clear = (block: MinecraftEntity | null) => block?.boundingBox === 'empty' && !/lava|fire/.test(block.name)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    let open = true
    let y = 0
    for (let distance = 1; distance <= 3 && open; distance++) {
      const point = feet.offset(dx * distance, 0, dz * distance)
      facts.push([-1, 0, 1].map(dy => {
        const block = bot.blockAt(point.offset(0, dy, 0))
        return block ? `${block.name}:${block.boundingBox}:${JSON.stringify(block.shapes || [])}` : 'unknown'
      }).join('/'))
      const step = [0, 1, -1, -2].find(dy => {
        const at = point.offset(0, y + dy, 0)
        const room = dy === 1 ? clear(bot.blockAt(feet.offset(dx * (distance - 1), y + 2, dz * (distance - 1))))
          : dy >= 0 || clear(bot.blockAt(point.offset(0, y, 0))) && clear(bot.blockAt(point.offset(0, y + 1, 0)))
        return room && bot.blockAt(at.offset(0, -1, 0))?.boundingBox === 'block' && clear(bot.blockAt(at)) && clear(bot.blockAt(at.offset(0, 1, 0)))
      })
      if (step === undefined) open = false
      else y += step
    }
    route ||= open
  }
  return { route, signature: facts.join('|') }
}

// S4d: a blast throws the body away from its source by 1-4 blocks (creeper power 3 at the swell distances); a cell on that
// line with no floor in 4 below, or lava/fire, is a fall the shield does not stop. Unloaded cells count as floor.
export function dropBehind(bot: MinecraftEntity, from: { x: number; z: number }): boolean {
  const me = bot.entity.position
  const base = me.floored()
  const length = Math.hypot(me.x - from.x, me.z - from.z) || 1
  for (let step = 1; step <= 4; step++) {
    const ox = Math.floor(me.x + (me.x - from.x) / length * step) - base.x
    const oz = Math.floor(me.z + (me.z - from.z) / length * step) - base.z
    let floor = false
    for (let dy = 1; dy <= 4 && !floor; dy++) {
      const block = bot.blockAt(base.offset(ox, -dy, oz))
      if (!block) { floor = true; break }
      if (/lava|fire/.test(block.name)) return true
      floor = block.boundingBox === 'block' || block.name === 'water'
    }
    if (!floor) return true
  }
  return false
}

export const FLEE_SAFE_DISTANCE = 17
export const EXHAUSTION_HOLD_MS = 400
export const FIGHT_RECOVERY_HP = 4
export const IDLE_COOLED = new Set<ActionId>(['Fight', 'LastStand', 'Hide', 'Heal', 'BlockOff', 'PillarUp', 'DigDown'])

interface UnreachableContact { entity: MinecraftEntity; dimension: string; facts: string }
function contactFacts(bot: MinecraftEntity, entity: MinecraftEntity): string {
  const tools = bot.inventory.items().filter((item: MinecraftEntity) => /_(sword|axe|pickaxe|spear)$|^trident$|^mace$/.test(item.name) &&
    (itemTools ??= (require('../../items') as typeof import('../../items'))).usesLeft(item) >= 4)
    .map((item: MinecraftEntity) => item.name + ':' + JSON.stringify(item.enchants || []))
  return [bot.entity.position.floored(), entity.position.floored(), exitsNear(bot).signature, [...new Set(tools)].sort().join(',')].join('|')
}
export function rememberUnreachable(session: MinecraftSession, entity: MinecraftEntity): void {
  if (!entity || entity.isValid === false) return
  const entries: Map<number, UnreachableContact> = session._ndUnreachable ||= new Map()
  const bot = session.bot, dimension = String(bot.game?.dimension || '')
  for (const [id, entry] of entries) if (bot.entities[id] !== entry.entity || entry.entity.isValid === false || entry.dimension !== dimension) entries.delete(id)
  entries.set(entity.id, { entity, dimension, facts: contactFacts(bot, entity) })
}
function unreachableContact(session: MinecraftSession, entity: MinecraftEntity): boolean {
  const entries: Map<number, UnreachableContact> | undefined = session._ndUnreachable
  const entry = entries?.get(entity.id), bot = session.bot
  if (!entry) return false
  if (entry.entity !== entity || entity.isValid === false || entry.dimension !== String(bot.game?.dimension || '')) { entries!.delete(entity.id); return false }
  // Hidden movement is not new information about the failed contact.
  if (!pick.aim(bot, entity, { range: 16 })?.point) return true
  if (entity.position.distanceTo(bot.entity.position) <= 4 || contactFacts(bot, entity) !== entry.facts) { entries!.delete(entity.id); return false }
  return true
}

export interface TacticalSnapshot {
  threatLevel: ThreatLevel
  action: string | null
  owner: ControlOwner
  replanRevision: number
  requireObservation: boolean
  state: TacticalState | null
  error?: string
}

// S1f (проверка S1e (г), лаборатория s1f-L1: 3 из 3 вызовов охоты второй попытки прерваны рефлексом Shield — снаряд стрелка вдали):
// тело в своём окопе (pearls: bot._ndInFoxhole) — стрелков (гаст, скелет, ифрит) в 8+ бл. держит окоп с крышей, охоту не рвать.
// Ближние и прочие — как прежде. ND_FOXHOLE_HOLD=0 — выкл.
function foxholeHolds (bot: any, hostile: any[]): boolean {
  if (process.env.ND_FOXHOLE_HOLD === '0' || typeof bot._ndInFoxhole !== 'function') return false
  let inside = false
  try { inside = !!bot._ndInFoxhole() } catch {}
  return inside && hostile.every((enemy: any) => enemy.kind === 'enderman' || (/^(ghast|skeleton|stray|bogged|blaze)$/.test(enemy.kind) && enemy.distance >= 8))
}

export function observeTactics(session: MinecraftSession): TacticalState | null {
  const bot = session.bot
  if (!bot?.entity) return null
  session.autopilot?.syncDamageContext?.(bot)
  const preparation = /^(creative|spectator)$/.test(bot.game?.gameMode || '')
  const dimension = String(bot.game?.dimension || '')
  if (preparation || session._tacticalInWallDimension !== undefined && session._tacticalInWallDimension !== dimension) {
    session._tacticalInWallAt = -Infinity; session._tacticalEmbedded = false
  }
  if ((bot.health ?? 0) <= 0 || preparation) return null
  const at: number = clock.now()
  const items: MinecraftEntity[] = bot.inventory.items()
  const shield = bot.inventory.slots[45]?.name === 'shield' && at >= (bot._ndShieldDisabledUntil || 0)
  const weapon = items.some(item => /_(sword|axe)$|^trident$|^mace$|_spear$/.test(item.name) && (itemTools ??= (require('../../items') as typeof import('../../items'))).usesLeft(item) >= 4)
  const targetName = session.current?.target || session.current?.params?.target
  const target = targetName ? (Object.values(bot.entities || {}) as MinecraftEntity[]).find(entity =>
    entity && (entity.username === targetName || entity.name === targetName || '#' + entity.id === targetName)) : null
  // Whoever hit us in the last 10 s is a threat: a player (stress stand: an attacking diamond player stayed "not
  // threatening") and a neutral mob that combat-safety skips unless it is the target - an angry enderman, piglin or
  // zombified piglin (stress stand v2: 6 of 16 deaths that only the real observation had; S1: 5 deaths by zombified piglins).
  const incident = session.autopilot?.lastHurt
  const sameWorld = !!incident && (incident.dimension === undefined || incident.dimension === dimension)
  const struck = sameWorld && incident.sourceId != null && at - incident.at < 10000 ? bot.entities?.[incident.sourceId] : null
  const attacker = struck && struck !== bot.entity && struck.isValid !== false && (struck.username || /^(enderman|piglin|zombified_piglin)$/.test(struck.name)) ? struck : null
  const bears: any[] = polarBear.risks(bot, sameWorld ? struck?.id : null)
  const bearRoute = bears.filter(bear => !bear.attacking).map(bear => `${bear.e.id}:${bear.e.position.floored()}:${bear.avoiding}`).sort().join('|')
  if (bearRoute !== (session._ndBearRoute ?? '')) {
    session._ndBearRoute = bearRoute
    if (session.current && !locks.owner(session) && !bot._ndNoMobAvoid) session.updateMovements?.(true)
  }
  // A piglin with an attack target (mob_flags, no gold on us) is a threat on sight, not on its first strike: the shield needs
  // 5 ticks, and a fight that began at 2 blocks took the first 8 hp before it every time (try-lab-ne-piglin 14.10).
  // A failed contact is retried after a changed visible stance, route or tool, or on arrival at the body.
  const unreachable = (entity: MinecraftEntity) => unreachableContact(session, entity)
  const angry: MinecraftEntity[] = /nether/.test(dimension) && process.env.ND_PIGLIN_SIGHT !== '0'
    ? (guard.meleeFoes(bot, 12) as MinecraftEntity[]).filter(entity => /^(piglin|zombified_piglin)$/.test(entity.name || '') && !unreachable(entity) && !!pick.aim(bot, entity, { range: 16 })?.point) : []
  const inspected = safety.inspect(bot, { target: target ?? (attacker && !unreachable(attacker) ? attacker : null) ?? angry[0] ?? null })
  const hot = guard.hot(bot)
  const seen = new Set<number>()
  const enemies: TacticalEnemy[] = []
  // S4d: the mob that struck in melee within 1.5 s is known without the eye ray - the client gets its id in damage_event
  // (the hurt tilt points at it) and hears it. A zombie the ray missed (at the body, past a block corner) left contact
  // with no foe: "unidentified attacker", CreateDistance 85 and 12 s of run with it hitting the back (s5c-g3-3: 19.5 ->
  // 8.2 -> death; live telemetry 06-07.10: 176 such runs, 8 deaths). Strikes still go only where pick.js sees it.
  const struckMelee = S4D() && sameWorld && incident.sourceId != null && at - incident.at < 1500 && incident.byMob && /mob_attack/.test(String(incident.type || '')) ? incident.sourceId : null
  for (const threat of [...(inspected.threats || []), ...(hot ? [{ id: hot.e.id, distance: hot.e.position.distanceTo(bot.entity.position) }] : []),
    ...angry.map(entity => ({ id: entity.id, distance: entity.position.distanceTo(bot.entity.position) })),
    ...bears.filter(bear => bear.visible && bear.attacking && polarBear.canReach(bot, bear.e)).map(bear => ({ id: bear.e.id, distance: bear.d }))]) {
    const entity: MinecraftEntity | undefined = bot.entities[threat.id]
    if (!entity?.position || entity.isValid === false || seen.has(entity.id)) continue
    const unseen = !pick.aim(bot, entity, { range: entity.name === 'polar_bear' && polarBear.enabled() ? 32 : 16 })?.point
    if (unseen && !(entity.id === struckMelee && threat.distance <= 4.5)) continue
    seen.add(entity.id)
    enemies.push({ id: entity.id, kind: entity.name || entity.username, distance: threat.distance,
      player: !!entity.username, threatening: true, ...(typeof threat.hit === 'number' ? { hit: threat.hit } : {}), ...(unseen ? { unseen: true } : {}) })
  }
  // Nearby players are observable facts; they become threats only after an attack or an explicit fight.
  for (const entity of Object.values(bot.entities || {}) as MinecraftEntity[]) {
    if (!entity?.username || entity === bot.entity || seen.has(entity.id) || !entity.position) continue
    const distance = entity.position.distanceTo(bot.entity.position)
    if (distance <= 16) enemies.push({ id: entity.id, kind: entity.username, distance, player: true, threatening: false, ...((session._ndFoes as string[] | undefined)?.includes(entity.username) ? { foe: true } : {}) })
  }
  let incomingProjectiles = 0
  try { incomingProjectiles = (threats ??= (require('../../threats') as typeof import('../../threats'))).incoming(bot).filter((projectile: MinecraftEntity) => projectile.ticks <= 10).length } catch {}
  // S4d: a shooter past the 16-block horizon that is shooting at the body (a shot in flight, or a hit by a shot in 3 s) is in
  // plain sight up to its reach (flee.DOCTRINE, jar: blaze 48, ghast 64). Blind to blazes at 17-48 on a fortress bridge, the
  // tactics read the fireballs as "an unidentified attacker" and ran (CreateDistance 85) instead of shielding them: natives
  // s4d-smoke bridge, both arms, burned to death / 5 hp.
  // The shot is remembered past the fire it lit: each burning tick (on_fire, no source) replaces autopilot.lastHurt, and
  // the blazes left the list between volleys (natives s4d-ab bridge: CreateDistance "from nobody" while burning).
  if (sameWorld && incident.byMob && !/mob_attack/.test(String(incident.type || ''))) session._tacticalShotAt = Math.max(session._tacticalShotAt ?? -Infinity, incident.at)
  const shot = at - (session._tacticalShotAt ?? -Infinity) < 3000
  if (S4D() && (incomingProjectiles > 0 || shot)) {
    for (const h of flee.hostilesAround(bot, 64) as Array<{ e: MinecraftEntity; doc: { range?: number }; d: number }>) {
      if (seen.has(h.e.id) || !h.doc.range || h.d <= 16 || h.d > h.doc.range || h.e.isValid === false || !pick.aim(bot, h.e, { range: h.d + 1 })?.point) continue
      seen.add(h.e.id)
      enemies.push({ id: h.e.id, kind: h.e.name, distance: h.d, player: false, threatening: true })
    }
  }
  const MOBS = (require('../../assess') as typeof import('../../assess')).MOBS
  // Only line-of-sight enemies already admitted above; no hidden source coordinates or PvP policy changes.
  const rangedApproach = process.env.ND_OW_DEATH_RANGED === '1' && dimension.replace(/^minecraft:/, '') === 'overworld' && !shield && !enemies.some(e => e.player)
    ? enemies.filter(e => e.threatening && !e.unseen && /^(skeleton|stray|bogged|parched)$/.test(e.kind) &&
      !Object.hasOwn((require('../../assess') as typeof import('../../assess')).WEAPON, String(bot.entities[e.id]?.equipment?.[0]?.name || ''))) : []
  const owRangedApproachHp = rangedApproach.length ? rangedApproach.reduce((hp, e) => hp +
    (e.hit ?? MOBS[e.kind].dmg) * Math.ceil(Math.max(0, e.distance - 3) / 4.3 / MOBS[e.kind].every), 0) : undefined
  const dryMountedBoat = mountedBoatDry(bot)
  const lava = !dryMountedBoat && inLava(bot)
  const lavaEscapePending = !!(session._tacticalLavaClimbGoal && !session._tacticalLavaClimbGoal.failed && at < session._tacticalLavaClimbGoal.deadline)
  let refuge: MinecraftEntity | null = null
  // Geometry is cached by TacticalSystem; avoid this scan when there is no incident to solve.
  // A ghast in sight with a drop behind the body (no floor 4 down or lava within 4 blocks away from it): its blast throws the body
  // 2-3 blocks, and from a ledge over the lava sea that is the death (c2-6-1 14.10: 20 fireballs swatted at y 82, the 20th threw
  // the body into the lava at y 28; b16-5-2: the same through a floor the blast broke). A sealed box stops the shot and its throw.
  // Any ghast in sight within 64 counts, not only one already shooting (c15-7-1 14.10: the first fireball at y 71 over the lava
  // sea - the swat missed, the blast threw the body 44 blocks down into the lava).
  const ghastEdge = /nether/.test(dimension) && process.env.ND_GHAST_EDGE !== '0' && (Object.values(bot.entities || {}) as MinecraftEntity[]).some(entity =>
    entity?.name === 'ghast' && entity.position && entity.isValid !== false && entity.position.distanceTo(bot.entity.position) <= 64 &&
    dropBehind(bot, entity.position) && !!pick.aim(bot, entity, { range: 66 })?.point)
  if (!lava && !lavaEscapePending && (process.env.ND_TACTICS_WATER_HURT === '1' && session._tacticalWaterEscape && bot.entity.onGround || ghastEdge || enemies.some(enemy => enemy.threatening) && (bot.health < 16 || inspected.action !== 'fight' || owRangedApproachHp !== undefined || !weapon && enemies.some(enemy => enemy.threatening && enemy.kind === 'enderman')))) {
    try { refuge = survival.refugeLook(session, { radius: 16 }) } catch {}
  }
  let fireResistance = false
  const resistance = bot.registry?.effectsByName?.fire_resistance || bot.registry?.effectsByName?.FireResistance
  if (resistance) fireResistance = !!bot.entity.effects?.[resistance.id]
  // Выпитая телом огнестойкость по часам (blaze.ts frByClock): эффект тела клиент не всегда видит (16.10).
  if (!fireResistance && bot._ndFrUntil && clock.now() < bot._ndFrUntil) fireResistance = true
  const burning = !!(bot.entity.metadata?.[0] & 1)
  // Contact heat sets neither the burning bit nor isInLava. Sample the real
  // support surface: a campfire holds the feet at its fractional top (.4375).
  const support = bot.blockAt(bot.entity.position.offset(0, -.01, 0))
  const lit = support?.getProperties?.().lit
  const contactHeat = incident?.type === 'hot_floor' && support?.name === 'magma_block' ||
    incident?.type === 'campfire' && /^(campfire|soul_campfire)$/.test(support?.name || '') && (lit === true || lit === 'true')
  const hotFloor = !dryMountedBoat && !fireResistance && sameWorld && contactHeat &&
    at >= incident.at && at - incident.at < 1000 && bot.entity.onGround
  const creeper = process.env.ND_CREEPER_DODGE === '0' ? null : (autopilot ??= (require('../../autopilot') as typeof import('../../autopilot'))).creeperNeed(bot)
  const blast = blastNear(bot, 2)
  // The alarm is the blast reach; the 2 blocks past it only keep a fight from walking back into it (TNT: Fight>Dodge>Fight).
  const blastAlarm = !!blast?.alarm
  const babyKey = bot.registry?.entitiesByName?.piglin?.metadataKeys?.indexOf('is_baby') ?? -1
  // Only a brute fight needs witnesses: the raycasts run every 150 game ms (4 ms of wall time at 750 TPS).
  const piglinWitnesses = enemies.some(enemy => enemy.threatening && enemy.kind === 'piglin_brute') &&
    (Object.values(bot.entities || {}) as MinecraftEntity[]).some(entity => entity?.name === 'piglin' &&
    entity.position && entity.isValid !== false && entity.position.distanceTo(bot.entity.position) <= 16 &&
    !(babyKey >= 0 && entity.metadata?.[babyKey] === true) && !!pick.aim(bot, entity, { range: 16 })?.point)
  // Walkers of the Nether the shield duel does not answer (ne-guard.bigMelee) near: the guard's hole two down, or the hole or pillar
  // it is in already. A pillar is no first answer: knockback throws the body off the cell mid-climb ("did not jump up", c4: brute
  // 7 of 8 deaths); without diggable ground the box stays the refuge. Not blazes or magma cubes (they fly or jump up to it); not
  // in sight of piglins when our gold keeps them calm - a strike at a brute there turns them (S1, s1-full46/49).
  let netherHide = false
  if (/nether/.test(dimension) && process.env.ND_NETHER_HIDE !== '0') {
    try {
      // Only the ones in sight (pick ray): an entity behind a wall is not known to a player (AGENTS.md, no x-ray).
      const near = (guard.meleeFoes(bot, process.env.ND_BRUTE_GUARD === '1' ? 16 : 12) as MinecraftEntity[]).filter(entity => !/^(blaze|magma_cube)$/.test(entity.name || '') && !unreachable(entity) &&
        (entity.position.distanceTo(bot.entity.position) <= 12 || process.env.ND_BRUTE_GUARD === '1' && entity.name === 'piglin_brute') &&
        !!pick.aim(bot, entity, { range: 16 })?.point)
      // Capture the observed brute before the tactic seals away the eye ray.
      if (process.env.ND_BRUTE_MEMORY === '1' && near.some(entity => entity.name === 'piglin_brute')) (require('../../brute-memory') as typeof import('../../brute-memory')).observe(bot, true)
      const gold = [5, 6, 7, 8].some(slot => /^golden_/.test(bot.inventory.slots[slot]?.name || ''))
      // The hole goes down before they arrive: dug with a walker at the body it lets them into the shaft before the plug (c10:
      // three piglins at 3 blocks, the plug failed in 6 of 8 holes, 8 deaths). At the body the shield duel and the run stay.
      // A brute, a hoglin or a zoglin from 3.5 blocks; a crowd of three only from 6 (piglins run faster than the hole goes down:
      // c12, 2 swords and a crossbow from 7 blocks - 12 deaths of 12 in the hole, 4 of 8 with the duel and the run in c2).
      // A brute or a hoglin is met from 12 blocks (c15-7-2 14.10: a box against a hoglin at 11, 12 -> 0); a crowd counts in 8.
      const distance = (entity: MinecraftEntity) => entity.position.distanceTo(bot.entity.position)
      const nearest = Math.min(...near.map(distance))
      const heavy = near.some(entity => guard.hideFrom(bot, entity.name || ''))
      const crowd = near.filter(entity => distance(entity) <= 8)
      const bruteGuard = process.env.ND_BRUTE_GUARD === '1' && near.some(entity => entity.name === 'piglin_brute')
      netherHide = near.length > 0 && (heavy || crowd.length > 0 && guard.bigMelee(bot, crowd, null, { lowHp: false, walkers: true })) && (!(gold && piglinWitnesses) || bruteGuard) &&
        (guard.above(bot, near) || nearest > (heavy ? 3.5 : 6) && (guard.holeFits(bot) || bruteGuard &&
          (guard.pillarFits(bot) || !!refuge?.cell && refuge.canBreakOut))) ||
        !!session._ndHideCtl && !session._ndHideCtl.aborted
    } catch {}
  }
  const recentHit = sameWorld && at - incident.at < 1500 && incident.byMob && incident.at > (session._tacticalRetreatSafeAt ?? -Infinity)
  const current = session.current?.name || ''
  const owWater = movement.owDeathWaterOn(bot)
  const waterSafety = process.env.ND_TACTICS_WATER_HURT === '1' || owWater
  const wetBody = waterSafety ? !dryMountedBoat && movement.inWater(bot) : !!bot.entity.isInWater
  const breathBlock = waterSafety ? bot.blockAt(pick.eyeOf(bot)) : null
  const breathing = !!breathBlock && breathBlock.boundingBox === 'empty' && (!movement.waterCell(breathBlock) || breathBlock.name === 'bubble_column')
  const safeSupport = waterSafety && bot.entity.onGround && bot.blockAt(bot.entity.position.offset(0, -0.2, 0))?.boundingBox === 'block' && (!wetBody || refuge?.pocket && breathing)
  const clearAir = breathing && (bot.oxygenLevel ?? 20) >= 18 && !hot && !recentHit && !enemies.some(enemy => enemy.threatening)
  if (!waterSafety || safeSupport || clearAir || session._tacticalWaterWorld !== dimension) session._tacticalWaterEscape = false
  session._tacticalWaterWorld = dimension
  if (waterSafety && wetBody && !safeSupport && recentHit && (owWater || /^(structure|mine|explore)$/.test(current))) session._tacticalWaterEscape = true
  const hostile = enemies.filter(enemy => enemy.threatening)
  const contact = !!hot || !!recentHit || hostile.some(enemy => enemy.distance <= 4.5 || (flee.DOCTRINE[enemy.kind]?.range || 0) >= enemy.distance)
  const fall = !lava && !dryMountedBoat && (bot._ndClutch?.lastDecision?.action === 'clutch' || bot._ndClutch?.lastDecision?.action === 'water' || !!bot._ndFallGuard?.placed)
  const control = locks.owner(session)
  const emergencyController = !lava && !!(control?.owner === 'Emergency' && control.source === 'fall-controller' && !bot.entity.onGround && !dryMountedBoat)
  const lavaAhead = !dryMountedBoat && !fall && !emergencyController && lavaFallFloor(bot) !== null
  const aerialCombat = !!(bot._ndDescend || bot._ndSmashNow || bot.entity.elytraFlying || bot._ndAerialRecovering?.())
  const boatEncounter = bot._ndEndermanBoatEncounter
  let protectedBoat = false
  if (current === 'pearls' && boatEncounter && boatEncounter.expiresAt >= at &&
      bot.entities[boatEncounter.boatId] && hostile.every(enemy => enemy.id === boatEncounter.targetId)) {
    try { protectedBoat = boatEncounter.safe() === true } catch {}
  }
  let embedded = false
  try {
    const buried = !!session.autopilot?.buriedBy(bot)
    const confirmed = at - (session._tacticalInWallAt ?? -Infinity) < 2000 || at - (session._tacticalTeleportAt ?? -Infinity) < 1500
    // Teleport/damage proves the cause; geometry ends the incident, including slow server-confirmed digs.
    embedded = buried && (session._tacticalEmbedded === true || confirmed)
    session._tacticalEmbedded = embedded
  } catch {}
  const portalId = bot.registry?.blocksByName?.nether_portal?.id
  let portal = false
  if (portalId !== undefined && !fall && bot.health >= 10 && bot.health < 12) {
    try { portal = !!bot.findBlock({ matching: portalId, maxDistance: 4 }) } catch {}
  }
  const choice = refuge ? survival.chooseRefuge(refuge) : null
  const shelter = choice?.how === 'box' || choice?.how === 'niche' ? 'BlockOff' : choice?.how === 'pillar' ? 'PillarUp' : choice?.how === 'hole' ? 'DigDown' : choice?.how === 'pocket' ? 'Hide' : null
  // Every dig/sink is priced by the hits of the walkers that reach the body meanwhile (state.digDownCost). The open
  // three-block shaft admits an Enderman until its roof closes: with one near, the supported roof is part of the dig.
  const enderman = enemies.some(enemy => enemy.threatening && enemy.kind === 'enderman')
  const digDownMs = shelter === 'DigDown' && refuge?.hole ? refuge.hole.ms + (enderman ? (require('../../fortify') as typeof import('../../fortify')).refugeBuildMs({ blocks: 1, roofSolid: false, leans: true }) : 0) : 0
  const buildMs = shelter === 'BlockOff' ? survival.buildMsOf(refuge, choice!.how) : 0
  // The attack phase is unknown: a visible shooter can release its next shot during this construction interval.
  const buildCostHp = shelter === 'BlockOff' && /overworld/.test(dimension) && Number.isFinite(buildMs) ? boxBuildCost(enemies.filter(enemy => enemy.threatening)
    .map(enemy => ({ kind: enemy.kind, distance: MOBS[enemy.kind]?.ranged ? 0 : enemy.distance,
      hit: enemy.hit, everyMs: (MOBS[enemy.kind]?.every ?? 0) * 1000 })), buildMs) : undefined
  const digDownCostHp = shelter === 'DigDown' && refuge?.hole ? digDownCost(enemies.filter(enemy => enemy.threatening && !MOBS[enemy.kind]?.ranged && enemy.distance <= 12)
    .map(enemy => ({ kind: enemy.kind, distance: enemy.distance, hit: enemy.hit, everyMs: (MOBS[enemy.kind]?.every ?? 0) * 1000 })), digDownMs) : undefined
  const ground = exitsNear(bot)
  const rescue = lava || lavaEscapePending || hotFloor || burning && !fireResistance ? lavaCapabilities(session) : { potion: false, climb: false, exit: '' }
  const air = lava || lavaAhead ? createEmergencyEscape(bot, { away: () => bot.entities[hostile[0]?.id]?.position }).snapshot() : { flightReady: false, pearlReady: false, landing: null }
  const webBoat = lava && !!webBoatPlan(session)
  const boatLavaHop = lava && boatHopAvailable(bot)
  const repel = fireResistance && (lava || lavaEscapePending) && weapon && hostile.some(enemy =>
    enemy.distance <= 3 && !!pick.aim(bot, bot.entities[enemy.id], { range: 3.2 })?.point)
  session._tacticalExitGeometry = ground.signature + '|' + rescue.exit + '|' + [portal, rescue.potion, rescue.climb, air.flightReady, air.pearlReady, webBoat, boatLavaHop].join(',')
  // S5e (07.10): спуск к крепости и штрек к комнате (навык stronghold под землёй, без неба) — бег из шахты/лестницы в соседнюю
  // пещеру уводил тело вниз (s5d-T-1: падение 24 бл. на капельник; T-7: бег до y −11, хп 20 → 9; R-8: бег до хп 2, скелет).
  // Здесь бег — не выход: бой у тела, заслон/коробка, щит (кандидаты без escapeRoute). Лава, падение, утопление — как прежде.
  // ND_SHAFT_STAND=0 — прежнее.
  let shaftStand = false
  if (current === 'stronghold' && process.env.ND_SHAFT_STAND !== '0' && /overworld/.test(dimension) && !lava && !burning) {
    try { const here = bot.blockAt(bot.entity.position.floored()); shaftStand = !!here && here.skyLight === 0 } catch {}
  }
  return { dimension, at, health: bot.health ?? 20, food: bot.food ?? 20, armor: inspected.ourArmor || 0, polarBear: polarBear.plan(session, bears),
    weapon, shield: bot.inventory.slots[45]?.name === 'shield' && clock.now() >= (bot._ndShieldDisabledUntil || 0), owRangedApproachHp,
    enemies, incomingProjectiles, owGuard: rangedGuard(bot, enemies), burning, hotFloor, lava, lavaAhead, fireResistance,
    explosion: !!(creeper && (creeper.swelling || creeper.d <= 3.3)) || blastAlarm, blast: blast?.kind ?? null, dangerousFall: !!fall, emergencyController,
    waterEmergency: movement.owAirEmergency(bot), inWater: wetBody, drowning: (bot.oxygenLevel ?? 20) <= (session._airManaged ? 4 : 8) && movement.inWater(bot), waterEscape: !!session._tacticalWaterEscape, piglinWitnesses, cover: !!refuge?.pocket, portal, escapeRoute: !fall && ground.route && !shaftStand && !(clock.now() < (session._ndCoverUntil || 0)),
    blocks: refuge?.blocks ?? (pack ??= (require('../../pack') as typeof import('../../pack'))).buildCount(bot, /nether/.test(dimension) ? 'the_nether' : 'overworld'),
    water: !/nether/.test(dimension) && items.some(item => item.name === 'water_bucket'),
    edible: !!foodActions.bestFood(bot, session.mcData ?? bot.registry), canFight: hostile.length > 0 && (sustainableFight(inspected, bot.health ?? 0) || repel), contact,
    // PvP-дуэль (pvp.duel держит session.tempo) ведёт бой сама: щит, лечение и укрытие у неё свои; Shield тактики
    // снимал ей путь и управление (s7 06.10, булава на булаву при 750: 10/10 ничьих, 0 махов). Уровень ≥3 — как прежде.
    // blaze (s1 06.10): навык у спавнера сам ведёт бой — лук, отдых за углом, коробка, огнестойкость; Fight тактики по
    // ифриту давал «взмахов 0, не достать» и рвал навык (s1-post01b/s1-post02: TACTICAL ×20, смерть). Уровень ≥3 — как прежде.
    // portal (s1 06.10): вход в портал — сам уход от угрозы (4 с в раме); Fight тактики рвал его у самого портала, и тело с 5
    // стержнями и 10 очами гибло в 1 бл. от рамы (s1-LG-10: «прервано у портала», смерть через 7 мин). Уровень ≥3 — как прежде.
    // Только mode=enter: cast/build у лавы с мобами — обычная работа, её тактика прерывает (s1c 06.10, замечание проверки).
    // bastion (s1c 06.10): навык сам ведёт угрозы бастиона — заложиться в своём ходе (hunker), брут (bruteDefense), ne-guard, бой с
    // напавшим; уровень <3 тактики рвал его 96 раз в 27 std-прогонах (s1-S*, s1c-A/B: 256 мин прерванных вызовов, каждый —
    // новый подход и укрытие), а Fight/LastStand тактики в яме злил пиглинов (COORD 19:10, 23:06). Уровень ≥3 — как прежде.
    // S4d (граница с навыком blaze, COORD 07.10): навык ведёт бой с ифритами, а ходячий не-ифрит вплотную (иссушитель, куб
    // магмы, брут) — не его бой: s1c-A-5 — «slain by Wither Skeleton» у спавнера, 40 с без единой строки тактики.
    // S5d (07.10): одни чешуйницы/эндермиты при броне ≥ 10 (спавнер портальной комнаты, заражённый кирпич; удар 1) — работа навыка
    // идёт: Fight тактики по ним сквозь решётку «acted:false, cancelled» ×100+ 25 игр. мин (s5d-p6-1), обрыв fill и еды у комнаты —
    // БЛОКЕР «hunger 6/18» при 16 стейках (s5d-p6-2). Только пока хп ≥ 16: рой (6 чешуйниц ≈ 2.8 хп/с по железу) — бой тактики
    // (s5d-p7-2: fill под роем, 20 → 0 за 8 с, «slain by Silverfish»). Уровень ≥3 — как прежде.
    // S1e (07.10): охота на эндерменов (pearls hunt) сама ведёт бой с ними — окоп под крышей, штрек, дуэль со щитом, лодка; Fight
    // тактики по эндермену рвал её («reflex: действие прервано» в каждом вызове лаборатории s1e-L0: крыша окопа не вставала, дуэль
    // без хозяина — 3 эндермена, смерть). Только пока в угрозе одни эндермены; уровень ≥3 — как прежде. ND_PEARLS_OWN=0 — выкл.
    // Осмотр бастиона не защищает от гаста: щит и укрытие должны прервать открытую вышку. И от стрелков (скелеты долины душ,
    // ифриты): ход навыка к бастиону на них не отвечает — 6 стрел за 5 с, 20 → 0 хп без щита (b2-5-1 14.10).
    niche: /nether/.test(dimension) && !!refuge?.niche && refuge.blocks >= 2, netherHide, ghastEdge,
    buildCostHp,
    shelter, digDownCostHp, protectedEncounter: !!session._refugeBuild && (session._refugeBuild === session.current?.ctl || session._refugeBuild === locks.owner(session)?.ctl) && !session._refugeBuild.aborted || current === 'pearls' && (process.env.ND_HUNT_OPEN_GROUND === '1' && (!session.current?.params?.style || ['foxhole', 'tunnel'].includes(session.current.params.style)) ? ownsHuntCover(session) : !!session.current?.params?.style) && process.env.ND_PEARLS_OWN !== '0' && hostile.length > 0 && (hostile.every(enemy => enemy.kind === 'enderman') || foxholeHolds(bot, hostile)) || current === 'dragon' || current === 'blaze' && (process.env.ND_BLAZE_WORLD_STATE === '0' || !!session._blazeCombatCtl && session._blazeCombatCtl === session.current?.ctl) && !(S4D() && hostile.some(enemy => enemy.kind !== 'blaze' && !(process.env.ND_BLAZE_MELEE !== '0' && /^(wither_skeleton|magma_cube)$/.test(enemy.kind)) && !enemy.player && enemy.distance <= 4.5 && meleeReachable(enemy))) || current === 'bastion' && !hostile.some(enemy => /^(ghast|skeleton|stray|bogged|blaze)$/.test(enemy.kind)) || !!current && (inspected.ourArmor || 0) >= 10 && (bot.health ?? 0) >= 16 && hostile.length > 0 && hostile.every(enemy => /^(silverfish|endermite)$/.test(enemy.kind)) || current === 'portal' && session.current?.params?.mode === 'enter' && !(process.env.ND_WITHER_HIDE === '1' && hostile.some(enemy => enemy.kind === 'wither_skeleton' && enemy.distance <= 10)) || protectedBoat || (aerialCombat || !!session.tempo) && /^(fight|retaliate|defend)$/.test(current) ||
      // Бой на арене с игроком (fight с arena): лечение, отход, щит ведёт сам PvP — тактика тело не отбирает (колизей 10.10:
      // «прервано (tactical)» каждые 1–3 с при 20 хп — бот метался и не бил).
      current === 'fight' && !!session.current?.params?.arena && hostile.some(enemy => enemy.player), embedded, airborne: !bot.entity.onGround && !dryMountedBoat,
    aerialCombat,
    flightEscape: air.flightReady, pearlEscape: air.pearlReady, fireResistancePotion: rescue.potion, lavaClimb: rescue.climb, lavaEscapePending, webBoatEscape: webBoat, boatLavaHop }
}

// Minecraft binding of the controller; the stress stand (sim-run.ts) swaps observation, effects and telemetry.
export interface TacticalPorts {
  observe(session: MinecraftSession): TacticalState | null
  record(row: Record<string, unknown>): void
  execute?(action: Candidate, ctl: Controller, state: TacticalState): Promise<unknown>
}
// MC_PORT ties the shared daemon/skills.jsonl rows of farm daemons to their slot (farm/analysis/tactics-report).
export const minecraftPorts: TacticalPorts = { observe: observeTactics,
  record: row => (require('../../telemetry') as typeof import('../../telemetry')).record({ ...row, ...(process.env.MC_PORT ? { mcPort: Number(process.env.MC_PORT) } : {}) }) }

export function shieldCanContinue(state: TacticalState | null): state is TacticalState {
  if (state?.owGuard !== undefined) return !!state.shield && !!state.owGuard && !state.dangerousFall && !state.drowning && !state.lava
  return !!state?.shield && !state.dangerousFall && !state.airborne &&
    (threatLevel(state) === 1 || state.incomingProjectiles > 0 || state.enemies.some(enemy =>
      enemy.threatening && !enemy.unseen && (flee.DOCTRINE[enemy.kind]?.range || 0) >= enemy.distance))
}

// lava_escape (rpc/pvp-escape, поток «окружение» 21.10): выход из лавы без pathfinder'а — тактика его не перебивает
// (a39: «прервано (tactical)» и своё бегство вместо выхода — 4 смерти «tried to swim in lava» из 17).
const COMMANDED_ESCAPE = /^(evade|juke|take_cover|douse_lava|lava_escape|wind_jump|pearl_to|fly_to|burrow|block_behind|peek_shot|wind_leap|dodge_blast|clear_web)$/
export function commandedEscape(session: any): boolean { const c = session.current; return !!c && !c.ctl?.aborted && (COMMANDED_ESCAPE.test(c.name || '') || locks.protectedClimb(session)) }

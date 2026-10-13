import { TacticalArbiter } from './arbiter'
import { S4D, threatLevel, hasObservedTarget, canRepelLavaAttacker, sustainableFight, meleeReachable, type TacticalState, type TacticalEnemy, type Candidate, type ThreatLevel, type ControlOwner, type ActionId } from './state'
import { EscapeProgress, type EscapeObservation } from './escape-progress'
import { lavaCapabilities, inLava, drinkFireResistance, climbFromLava } from './lava-escape'
import { createEmergencyEscape, lavaFallFloor } from '../combat/emergency-escape'
import { webBoatPlan, webBoatEscape } from './web-boat'
import { boatHopAvailable, runBoatHop } from '../combat/boat-hop'
import { mountedBoatDry } from '../combat/boat-placement'
import { blastNear, dodgeBlast, shieldBlast, shieldableBlast } from './blast'

// Mineflayer plugins extend the bot/session at runtime; this is the protocol boundary.
type MinecraftSession = Record<string, any>
type MinecraftEntity = Record<string, any>
interface Controller { aborted: boolean; onAbort: Array<() => void>; abort(): void }
interface Episode { action: Candidate; at: number; hp: number; level: ThreatLevel; candidates: Candidate[]; token: number; state: Record<string, unknown>; intent?: Controller }

// What the arbiter saw when it chose (telemetry, farm/tactics-report): enough to replay a death on the stress stand.
export function stateSnapshot(state: TacticalState): Record<string, unknown> {
  const flags = ['lava', 'burning', 'hotFloor', 'fireResistance', 'explosion', 'dangerousFall', 'inWater', 'drowning', 'cover', 'escapeRoute', 'contact',
    'canFight', 'weapon', 'shield', 'edible', 'water', 'embedded', 'airborne', 'lavaAhead', 'lavaEscapePending', 'escapeExhausted',
    'piglinWitnesses', 'protectedEncounter', 'pearlEscape', 'flightEscape', 'fireResistancePotion'] as const
  return { hp: Math.round(state.health * 10) / 10, food: state.food, armor: state.armor, blocks: state.blocks, shelter: state.shelter,
    blast: state.blast ?? undefined, digDownCostHp: state.digDownCostHp, projectiles: state.incomingProjectiles || undefined, failed: state.failedEscapes?.length ? state.failedEscapes : undefined,
    on: flags.filter(flag => state[flag]),
    enemies: state.enemies.map(enemy => ({ kind: enemy.kind, d: Math.round(enemy.distance * 10) / 10, ...(enemy.threatening ? {} : { calm: true }),
      ...(typeof enemy.hit === 'number' ? { hit: Math.round(enemy.hit * 10) / 10 } : {}) })) }
}

const clock = require('../game-clock')
const locks = require('../reflex-lock')
const survival = require('../survival')
const safety = require('../combat-safety')
const flee = require('../flee')
const guard = require('../ne-guard')
const movement = require('../movement')
const pick = require('../pick')
let autopilot: any, threats: any, itemTools: any, pack: any
const foodActions: {
  bestFood(bot: MinecraftEntity, data: MinecraftEntity): MinecraftEntity | null
  eat(session: MinecraftSession, ctl: Controller, options: Record<string, unknown>): Promise<unknown>
} = require('../actions')

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
      facts.push([-1, 0, 1].map(dy => bot.blockAt(point.offset(0, dy, 0))?.name ?? 'unknown').join('/'))
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
const IDLE_COOLED = new Set<ActionId>(['Fight', 'LastStand', 'Hide', 'Heal', 'BlockOff', 'PillarUp', 'DigDown'])

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
  const weapon = items.some(item => /_(sword|axe)$|^trident$|^mace$|_spear$/.test(item.name) && (itemTools ??= require('../items')).usesLeft(item) >= 4)
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
  const inspected = safety.inspect(bot, { target: target ?? attacker })
  const hot = guard.hot(bot)
  const seen = new Set<number>()
  const enemies: TacticalEnemy[] = []
  // S4d: the mob that struck in melee within 1.5 s is known without the eye ray - the client gets its id in damage_event
  // (the hurt tilt points at it) and hears it. A zombie the ray missed (at the body, past a block corner) left contact
  // with no foe: "unidentified attacker", CreateDistance 85 and 12 s of run with it hitting the back (s5c-g3-3: 19.5 ->
  // 8.2 -> death; live telemetry 06-07.10: 176 such runs, 8 deaths). Strikes still go only where pick.js sees it.
  const struckMelee = S4D() && sameWorld && incident.sourceId != null && at - incident.at < 1500 && incident.byMob && /mob_attack/.test(String(incident.type || '')) ? incident.sourceId : null
  for (const threat of [...(inspected.threats || []), ...(hot ? [{ id: hot.e.id, distance: hot.e.position.distanceTo(bot.entity.position) }] : [])]) {
    const entity: MinecraftEntity | undefined = bot.entities[threat.id]
    if (!entity?.position || entity.isValid === false || seen.has(entity.id)) continue
    const unseen = !pick.aim(bot, entity, { range: 16 })?.point
    if (unseen && !(entity.id === struckMelee && threat.distance <= 4.5)) continue
    seen.add(entity.id)
    enemies.push({ id: entity.id, kind: entity.name || entity.username, distance: threat.distance,
      player: !!entity.username, threatening: true, ...(typeof threat.hit === 'number' ? { hit: threat.hit } : {}), ...(unseen ? { unseen: true } : {}) })
  }
  // Nearby players are observable facts; they become threats only after an attack or an explicit fight.
  for (const entity of Object.values(bot.entities || {}) as MinecraftEntity[]) {
    if (!entity?.username || entity === bot.entity || seen.has(entity.id) || !entity.position) continue
    const distance = entity.position.distanceTo(bot.entity.position)
    if (distance <= 16) enemies.push({ id: entity.id, kind: entity.username, distance, player: true, threatening: false })
  }
  let incomingProjectiles = 0
  try { incomingProjectiles = (threats ??= require('../threats')).incoming(bot).filter((projectile: MinecraftEntity) => projectile.ticks <= 10).length } catch {}
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
  const dryMountedBoat = mountedBoatDry(bot)
  const lava = !dryMountedBoat && inLava(bot)
  const lavaEscapePending = !!(session._tacticalLavaClimbGoal && !session._tacticalLavaClimbGoal.failed && at < session._tacticalLavaClimbGoal.deadline)
  let refuge: MinecraftEntity | null = null
  // Geometry is cached by TacticalSystem; avoid this scan when there is no incident to solve.
  if (!lava && !lavaEscapePending && enemies.some(enemy => enemy.threatening) && (bot.health < 16 || inspected.action !== 'fight' || !weapon && enemies.some(enemy => enemy.threatening && enemy.kind === 'enderman'))) {
    try { refuge = survival.refugeLook(session, { radius: 16 }) } catch {}
  }
  let fireResistance = false
  const resistance = bot.registry?.effectsByName?.fire_resistance || bot.registry?.effectsByName?.FireResistance
  if (resistance) fireResistance = !!bot.entity.effects?.[resistance.id]
  const burning = !!(bot.entity.metadata?.[0] & 1)
  // Contact heat sets neither the burning bit nor isInLava. Sample the real
  // support surface: a campfire holds the feet at its fractional top (.4375).
  const support = bot.blockAt(bot.entity.position.offset(0, -.01, 0))
  const lit = support?.getProperties?.().lit
  const contactHeat = incident?.type === 'hot_floor' && support?.name === 'magma_block' ||
    incident?.type === 'campfire' && /^(campfire|soul_campfire)$/.test(support?.name || '') && (lit === true || lit === 'true')
  const hotFloor = !dryMountedBoat && !fireResistance && sameWorld && contactHeat &&
    at >= incident.at && at - incident.at < 1000 && bot.entity.onGround
  const creeper = process.env.ND_CREEPER_DODGE === '0' ? null : (autopilot ??= require('../autopilot')).creeperNeed(bot)
  const blast = blastNear(bot, 2)
  // The alarm is the blast reach; the 2 blocks past it only keep a fight from walking back into it (TNT: Fight>Dodge>Fight).
  const blastAlarm = !!blast?.alarm
  const babyKey = bot.registry?.entitiesByName?.piglin?.metadataKeys?.indexOf('is_baby') ?? -1
  // Only a brute fight needs witnesses: the raycasts run every 150 game ms (4 ms of wall time at 750 TPS).
  const piglinWitnesses = enemies.some(enemy => enemy.threatening && enemy.kind === 'piglin_brute') &&
    (Object.values(bot.entities || {}) as MinecraftEntity[]).some(entity => entity?.name === 'piglin' &&
    entity.position && entity.isValid !== false && entity.position.distanceTo(bot.entity.position) <= 16 &&
    !(babyKey >= 0 && entity.metadata?.[babyKey] === true) && !!pick.aim(bot, entity, { range: 16 })?.point)
  const recentHit = sameWorld && at - incident.at < 1500 && incident.byMob && incident.at > (session._tacticalRetreatSafeAt ?? -Infinity)
  const current = session.current?.name || ''
  const hostile = enemies.filter(enemy => enemy.threatening)
  const contact = !!hot || !!recentHit || hostile.some(enemy => enemy.distance <= 4.5 || (flee.DOCTRINE[enemy.kind]?.range || 0) >= enemy.distance)
  const fall = !dryMountedBoat && (bot._ndClutch?.lastDecision?.action === 'clutch' || bot._ndClutch?.lastDecision?.action === 'water' || !!bot._ndFallGuard?.placed)
  const control = locks.owner(session)
  const emergencyController = !!(control?.owner === 'Emergency' && control.source === 'fall-controller' && !bot.entity.onGround && !dryMountedBoat)
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
  // The open three-block shaft admits an Enderman until its roof closes. Price
  // every dig/sink and that supported roof, including the final incoming hit.
  const digDownMs = shelter === 'DigDown' && refuge?.hole ? refuge.hole.ms + require('../fortify').refugeBuildMs({ blocks: 1, roofSolid: false, leans: true }) : 0
  const digDownCostHp = shelter === 'DigDown' && refuge?.hole && enemies.some(enemy => enemy.threatening && enemy.kind === 'enderman') ? enemies.reduce((cost, enemy) => {
    const every = require('../assess').MOBS[enemy.kind]?.every
    return cost + (enemy.threatening && enemy.distance <= 4.5 && every ? (enemy.hit ?? 0) * Math.ceil(digDownMs / (every * 1000)) : 0)
  }, 0) : undefined
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
  return { at, health: bot.health ?? 20, food: bot.food ?? 20, armor: inspected.ourArmor || 0,
    weapon, shield: bot.inventory.slots[45]?.name === 'shield' && clock.now() >= (bot._ndShieldDisabledUntil || 0),
    enemies, incomingProjectiles, burning, hotFloor, lava, lavaAhead, fireResistance,
    explosion: !!(creeper && (creeper.swelling || creeper.d <= 3.3)) || blastAlarm, blast: blast?.kind ?? null, dangerousFall: !!fall, emergencyController,
    inWater: !!bot.entity.isInWater, drowning: (bot.oxygenLevel ?? 20) <= 8 && movement.inWater(bot), piglinWitnesses, cover: !!refuge?.pocket, portal, escapeRoute: !fall && ground.route && !shaftStand,
    blocks: refuge?.blocks ?? (pack ??= require('../pack')).buildCount(bot, /nether/.test(dimension) ? 'the_nether' : 'overworld'),
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
    // Осмотр бастиона не защищает от гаста: щит и укрытие должны прервать открытую вышку.
    shelter, digDownCostHp, protectedEncounter: !!session._refugeBuild && (session._refugeBuild === session.current?.ctl || session._refugeBuild === locks.owner(session)?.ctl) && !session._refugeBuild.aborted || current === 'pearls' && !!session.current?.params?.style && process.env.ND_PEARLS_OWN !== '0' && hostile.length > 0 && (hostile.every(enemy => enemy.kind === 'enderman') || foxholeHolds(bot, hostile)) || current === 'dragon' || current === 'blaze' && !(S4D() && hostile.some(enemy => enemy.kind !== 'blaze' && !enemy.player && enemy.distance <= 4.5 && meleeReachable(enemy))) || current === 'bastion' && !hostile.some(enemy => enemy.kind === 'ghast') || !!current && (inspected.ourArmor || 0) >= 10 && (bot.health ?? 0) >= 16 && hostile.length > 0 && hostile.every(enemy => /^(silverfish|endermite)$/.test(enemy.kind)) || current === 'portal' && session.current?.params?.mode === 'enter' || protectedBoat || (aerialCombat || !!session.tempo) && /^(fight|retaliate|defend)$/.test(current) ||
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
// MC_PORT ties the shared daemon/skills.jsonl rows of farm daemons to their slot (farm/tactics-report).
const minecraftPorts: TacticalPorts = { observe: observeTactics,
  record: row => require('../telemetry').record({ ...row, ...(process.env.MC_PORT ? { mcPort: Number(process.env.MC_PORT) } : {}) }) }

function shieldCanContinue(state: TacticalState | null): state is TacticalState {
  return !!state?.shield && !state.dangerousFall && !state.airborne &&
    (threatLevel(state) === 1 || state.incomingProjectiles > 0 || state.enemies.some(enemy =>
      enemy.threatening && !enemy.unseen && (flee.DOCTRINE[enemy.kind]?.range || 0) >= enemy.distance))
}

const COMMANDED_ESCAPE = /^(evade|juke|take_cover|douse_lava|wind_jump|pearl_to|fly_to|burrow|block_behind|peek_shot|wind_leap)$/
function commandedEscape(session: any): boolean { const c = session.current; return !!c && !c.ctl?.aborted && COMMANDED_ESCAPE.test(c.name || '') }

export class TacticalSystem {
  private readonly ports: TacticalPorts
  private readonly arbiter = new TacticalArbiter()
  private readonly escapes = new EscapeProgress()
  // An action that fails at once (its precondition was a wrong observation) sits out 2 s instead of being re-selected on
  // every 150 ms sample (stress stand, real observation: Heal on a "cover" it could not confirm, x13 in 2 s).
  private readonly failedAt = new Map<ActionId, number>()
  private exhaustion: { value: boolean; since: number | null } = { value: false, since: null }
  private unfitLow: number | null = null
  private state: TacticalState | null = null
  private bot: MinecraftEntity | null = null
  private episode: Episode | null = null
  private generation = 0
  private lastSample = -Infinity
  private substantive = false
  private needsObservation = false
  private level: ThreatLevel = 0
  private observationError: string | undefined
  private pending: Promise<unknown> | null = null
  private incident: { at: number; hp: number; threat: ThreatLevel; actions: Set<string>; chain: string[]; state: Record<string, unknown>; intent?: Controller } | null = null
  private readonly onTick = () => this.update()
  private readonly onDamage = (packet?: MinecraftEntity) => {
    if (packet?.entityId === this.bot?.entity?.id && packet?.sourceTypeId === 22) {
      this.session._tacticalInWallAt = clock.now()
      this.session._tacticalInWallDimension = String(this.bot?.game?.dimension || '')
    }
    this.update(true)
  }
  private readonly onForcedMove = () => { this.session._tacticalTeleportAt = clock.now(); this.update(true) }
  private readonly onEnd = () => this.detach()

  constructor(private readonly session: MinecraftSession, ports: Partial<TacticalPorts> = {}) { this.ports = { ...minecraftPorts, ...ports } }

  attach(bot: MinecraftEntity): void {
    if (this.bot === bot) return
    this.detach()
    this.bot = bot
    locks.install(this.session)
    guard.attach(this.session)
    bot.on('physicsTick', this.onTick)
    bot.on('health', this.onDamage)
    bot.on('forcedMove', this.onForcedMove)
    bot._client?.on('damage_event', this.onDamage)
    bot.once('end', this.onEnd)
  }

  enabled(): boolean { return process.env.ND_TACTICS !== '0' && !!this.bot }

  snapshot(): TacticalSnapshot {
    const owner: ControlOwner = locks.owner(this.session)?.owner || 'Skill'
    return { threatLevel: this.level, action: this.episode?.action.id || null, owner,
      replanRevision: this.session.replanRevision || 0, requireObservation: this.needsObservation, state: this.state,
      ...(this.observationError ? { error: this.observationError } : {}) }
  }

  async waitForRelease(): Promise<void> {
    while (this.pending || this.session.reflex) {
      await (this.pending || this.session.reflex)
    }
  }

  observed(): void { if (!this.pending && !this.session.reflex) this.needsObservation = false }

  requestGuard(): Promise<unknown> {
    this.update(true)
    return this.pending || Promise.resolve({ acted: false })
  }

  update(force = false): void {
    if (!this.enabled() || this.session.bot !== this.bot) return
    const now = clock.now()
    if (!force && now - this.lastSample < 150) return
    this.lastSample = now
    let state: TacticalState | null
    try { state = this.ports.observe(this.session); this.observationError = undefined }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.observationError) this.session.bus.emit('tactical_observation_failed', { error: message })
      this.observationError = message
      return
    }
    if (!state) { this.release('unavailable'); return }
    const escape = this.escapes.observe(this.escapeObservation(state))
    const now2 = clock.now()
    // A run that sat out for "escaping" nobody is still the swim out of lava or fire (escapeFire): the cooldown of the
    // no-op flight left the body in a pool with no action for 2 s (stand fuzz-1312: TNT, then lava, level 4 unhandled).
    const swim = state.lava || state.burning && !state.fireResistance && state.water
    const quick = [...this.failedAt].filter(([id, at]) => now2 - at < 2000 && !(swim && (id === 'Flee' || id === 'CreateDistance'))).map(([id]) => id)
    state.failedEscapes = quick.length ? [...new Set([...escape.failed, ...quick])] : escape.failed
    // A corner is a place, not a sample: inside an incident the flag turns only after the new value held EXHAUSTION_HOLD_MS.
    // It gates LastStand against Fight/Flee/refuge, and a flag that flickered with each cell walked (or jump) swapped them
    // on every 150 ms sample (farm 06.10: Fight<->LastStand 94, BlockOff<->LastStand 51 alternations within 2 s).
    // A rising threat takes the fact as it is: in lava without a dry run the swim to shore (exits now "open") waited out the
    // hold of the old dead end, 10 ticks without any action (stress stand fuzz-6159/9456: level4-unhandled, burned).
    const rising = threatLevel(state)
    if (this.level === 0 && !this.episode || rising === 4 || rising > this.level || escape.exhausted === this.exhaustion.value) this.exhaustion = { value: escape.exhausted, since: null }
    else if ((this.exhaustion.since ??= now2) <= now2 - EXHAUSTION_HOLD_MS) this.exhaustion = { value: escape.exhausted, since: null }
    state.escapeExhausted = this.exhaustion.value
    // A fight dropped as unsustainable comes back only after a real recovery, FIGHT_RECOVERY_HP over the low point: the
    // verdict crossed its threshold with each arrow and each regenerated point, and the body walked back to a skeleton it
    // had just fled (stress stand fuzz-274/513: Fight>CreateDistance>Fight in 1.6 s). A lava repel keeps its own verdict.
    if (this.level === 0 && !this.episode) this.unfitLow = null
    if (!(state.fireResistance && (state.lava || state.lavaEscapePending))) {
      if (!state.canFight && state.enemies.some(enemy => enemy.threatening)) this.unfitLow = Math.min(this.unfitLow ?? Infinity, state.health)
      else if (state.canFight && this.unfitLow !== null) {
        // One more exchange of margin: a single hit must not cross the threshold again (fuzz-513: skeleton 3.5 per arrow).
        const hit = Math.max(0, ...state.enemies.filter(enemy => enemy.threatening).map(enemy => enemy.hit ?? 0))
        // S4d: capped at full health - a fight dropped at 20 hp (hunger, not wounds: «сытость не позволяет лечиться») asked for
        // 24 and never came back in the incident (natives s4d-ab3: a wither skeleton run from ×13 at 20 hp, then death).
        const recovered = this.unfitLow + Math.max(FIGHT_RECOVERY_HP, 2 * hit)
        if (state.health < (S4D() ? Math.min(recovered, (this.bot?.maxHealth ?? 20) - 0.5) : recovered)) state.canFight = false
        else this.unfitLow = null
      }
    }
    this.state = state
    const decision = this.arbiter.decide(state)
    this.level = decision.level
    // An arena duel (pvp.duel with tempo, fight { arena }) is to the death by design: a retreat at level 3 only interrupted
    // the losing side's fight (S7 20:08, arms race). Lava, a fall, a blast, a wall or water stay with the tactics.
    const hazard = state.lava || state.lavaAhead || state.dangerousFall || state.embedded || state.explosion || state.drowning
    const arena = state.protectedEncounter && !!this.session.current?.params?.arena && !hazard
    // The blaze skill under fire resistance keeps level 3 too (S1 21:01): at the spawner a crowd of 3+ blazes makes hp < 12
    // level 3, and the takeover (BlockOff/Flee off the platform) died in at least 35 of 66 such episodes in S1's farm
    // telemetry (06.10, slots 21/22/30); the skill holds the shield, eats and strikes on its own. Level 4 stays tactical.
    // Без огнестойкости — тоже (s1c 06.10, решение пользователя «FR — не допуск»): навык сам ведёт бой без неё (радар залпов, щит,
    // коробка с окном, отдых и возврат); перехват уровня 3 рвал его и кампания звала его снова — два хозяина одного боя.
    const blazeOwned = state.protectedEncounter && this.session.current?.name === 'blaze' && !hazard
    if (state.protectedEncounter && (decision.level < 3 || arena || blazeOwned)) {
      // Защищённый навык (blaze/дракон/дуэль) забирает руки у начатого раньше эпизода уровня <3: иначе Fight тактики держал
      // аренду, lookAt навыка ждал её, а ифриты били в упор (s1-post05 06.10: blaze «меч» 0 взмахов, 30 урона, смерть).
      if (this.episode && (this.episode.level < 3 || arena || blazeOwned) && locks.owner(this.session)?.owner !== 'Emergency' &&
          locks.owner(this.session)?.ctl !== this.session._refugeBuild) locks.cancel(this.session)
      return
    }
    // Падение ведёт рефлекс (клатч/вода, clutch.ts); тактике в нём выбрать нечего (арбитр: dangerousFall не выбирает
    // действие). Обрыв навыка только снимал клавиши посреди перехода (s5c-f2-3 06.10: 49 эпизодов L4 «dangerousFall» без
    // действия за 8 игр. мин — goto к крепости рвался, стратегия ушла в паузу 5 мин; S6b 21:52 — то же у прыжка паркура).
    // Блок клатча ставится под арендой Emergency (reflex-lock fall-controller) — это тот же рефлекс падения (S6c 07.10: спуск
    // блоками вдоль стены, try-descent wall — goto «прервано» после каждого первого блока).
    const fallOnly = !decision.selected && (state.dangerousFall || state.emergencyController) && threatLevel({ ...state, dangerousFall: false, emergencyController: false }) < 3
    if (decision.level >= 2) {
      // Чистое падение под рефлексом не «существенно»: по его концу release() не рвёт навык (MLG pathfinder'а, спуск блоками:
      // goto «interrupted» сразу после посадки — s6c-desc-bucket2 4/4 в обоих плечах).
      if (!fallOnly) this.substantive = true
      this.incident ||= { at: state.at, hp: state.health, threat: decision.level, actions: new Set(), chain: [], state: stateSnapshot(state), intent: this.session.current?.ctl }
      this.incident.threat = Math.max(this.incident.threat, decision.level) as ThreatLevel
    }
    if (decision.level === 0 && !this.episode && !this.pending && !this.session.reflex) { this.release('safe'); return }
    // Уворот/побег по приказу (арена 12.10: рывок от зелья и булавы, джук от лука, ветер, жемчуг, элитры, укрытие) — это уже
    // ответ на угрозу: щит/бой тактики рвали его («reflex: действие прервано», mace-5: булава сверху — угроза 3-го уровня,
    // и рывок обрывался щитом). Пока он идёт — тактика не вмешивается; аварии (падение, лава) — свой рефлекс Emergency.
    if (commandedEscape(this.session)) return
    if (decision.level >= 3 && !fallOnly) this.interruptSkill(decision.level)
    // A fireball disappears on impact, before its later hurt sample. The observed shooter remains: cancelling the
    // started guard here dropped offhand use before the native five-tick ACK (sr1011-b ghast scene). Keep its existing
    // bounded executor unless a more valuable defence or an emergency takes over; unseen shooters do not hold it.
    if (this.pending && this.episode?.action.id === 'Shield' && decision.level < 3 && shieldCanContinue(state) &&
        (!decision.selected || decision.selected.score <= this.episode.action.score)) {
      this.arbiter.hold(this.episode.action)
      return
    }
    // Losing contact while a wall is placed must not cancel bounded defence for Shield. A flight runs to its own safe
    // distance: released at the 16-block sight edge, a pursuer still inside its FOLLOW_RANGE walked back into contact.
    if (this.pending && (decision.level <= 1 && ['Fight', 'LastStand', 'BlockOff', 'PillarUp', 'DigDown', 'Hide'].includes(this.episode?.action.id || '') ||
      decision.level === 0 && ['FreeEmbedded', 'FlightEscape', 'PearlEscape', 'ClimbOut', 'WebBoatEscape', 'BoatLavaHop', 'Flee', 'CreateDistance'].includes(this.episode?.action.id || ''))) {
      if (this.episode) this.arbiter.hold(this.episode.action)
      return
    }
    if (decision.release) {
      if (this.episode && (decision.level === 0 || locks.owner(this.session)?.owner !== 'Emergency')) locks.cancel(this.session)
      if (decision.level === 0) this.release('safe')
      return
    }
    if (!decision.selected || !decision.change && this.episode) return
    if (decision.selected.id === 'Fight' && /^(fight|retaliate|defend)$/.test(this.session.current?.name || '') && decision.level < 3) return
    // The fight skill is already the favourable fight: a run the arbiter picked only because Fight sat out its re-entry
    // (dropped a moment ago) must not take the hands from it — native slot 1 14.10: a lone zombie, Fight 90 > Flee 65, the
    // fight RPC interrupted by Flee four rounds out of four, the zombie left alive to follow.
    const fightBest = decision.candidates.find(candidate => candidate.id === 'Fight')
    if (fightBest && fightBest.score >= decision.selected.score && /^(fight|retaliate|defend)$/.test(this.session.current?.name || '') && decision.level < 3) return
    const active = locks.owner(this.session)
    const repelDuringClimb = active?.source === 'ClimbOut' && decision.selected.id === 'Fight' && canRepelLavaAttacker(state)
    if (active?.owner === 'Emergency' && decision.selected.id !== 'FreeEmbedded' && !repelDuringClimb) return
    this.begin(decision.selected, decision.candidates, state, decision.level)
  }

  private interruptSkill(level: ThreatLevel): void {
    const current = this.session.current
    if (!current?.ctl || current.ctl.aborted || commandedEscape(this.session)) return
    current.ctl.interruptedBy = { type: 'tactical', threatLevel: level, requireObservation: true }
    current.ctl.abort()
  }

  private begin(action: Candidate, candidates: Candidate[], state: TacticalState, level: ThreatLevel): void {
    const previous = this.episode
    if (previous) { this.finish(previous, 'preempted', { by: action.id }); locks.cancel(this.session) }
    const episode: Episode = { action, at: state.at, hp: state.health, level, candidates, token: ++this.generation, state: stateSnapshot(state), intent: this.session.current?.ctl }
    this.episode = episode
    this.escapes.begin(action.id, this.escapeObservation(state))
    this.incident?.actions.add(action.id)
    this.incident?.chain.push(action.id)
    this.session.bus.emit('tactical_selected', { action: action.id, threatLevel: level, candidates, during: this.session.current?.name || null,
      ...(state.lavaAhead ? { lavaAhead: true, health: state.health, position: this.session.bot.entity.position.clone() } : {}) })
    let ending = 'completed'
    const pending: Promise<unknown> = locks.start(this.session, async (ctl: Controller) => {
      try {
        const result = await (this.ports.execute ? this.ports.execute(action, ctl, state) : this.execute(action, ctl, state))
        if (result && typeof result === 'object' && 'failed' in result && result.failed) {
          ending = 'failed'
          this.session.bus.emit('tactical_failed', { action: action.id, reason: 'reason' in result ? result.reason : 'action not confirmed', threatLevel: level })
        }
        return result
      }
      catch (error) {
        ending = ctl.aborted ? 'interrupted' : 'failed'
        const reason = error instanceof Error ? error.message : String(error)
        if (!ctl.aborted && action.id !== 'FreeEmbedded') this.session.bus.emit('tactical_failed', { action: action.id, reason, threatLevel: level })
        return { error: reason }
      }
      finally {
        if (ctl.aborted) ending = 'interrupted'
        if (this.episode === episode && level >= 2 && this.session.current?.ctl === episode.intent) this.interruptSkill(level)
      }
    }, { source: action.id, owner: level === 4 || ['FlightEscape', 'PearlEscape', 'WebBoatEscape', 'UseFireResistance', 'ClimbOut', 'BoatLavaHop'].includes(action.id) ? 'Emergency' : 'Tactical', priority: level === 4 || ['FlightEscape', 'PearlEscape', 'WebBoatEscape', 'UseFireResistance', 'ClimbOut', 'BoatLavaHop'].includes(action.id) ? 3 : 2, preempt: true })
    this.pending = pending
    void pending.then(result => {
      // A flight that reported safety ends the old hit's contact (else the 1.5 s hit memory restarts the same flight).
      if ((action.id === 'Flee' || action.id === 'CreateDistance') && result && typeof result === 'object' &&
          ((result as { mode?: string }).mode === 'оторвался' || (result as { safe?: boolean }).safe === true)) this.session._tacticalRetreatSafeAt = clock.now()
      // So does a kill: the dead attacker's hit kept "contact" for 1.5 s and started a flight from nobody (stress stand
      // fuzz-513: Fight killed the spider, CreateDistance with no enemy in sight, then a new skeleton read as a flap).
      if ((action.id === 'Fight' || action.id === 'LastStand') && result && typeof result === 'object' && (result as { killed?: boolean }).killed) {
        this.session._tacticalRetreatSafeAt = clock.now()
        if (S4D()) this.arbiter.forgive('Fight')
      }
      if (this.episode !== episode) return
      if (result && typeof result === 'object' && 'cancelled' in result && result.cancelled) ending = 'interrupted'
      const failed = ending === 'failed' || !!(result && typeof result === 'object' && 'unavailable' in result && result.unavailable)
      // A strike that ends in the tick it began did nothing (farm 06.10, slot 21: Fight vs a hovering blaze "out of melee",
      // 0 swings, 447 re-selections); it sits out like a failure.
      // So does a refuge run that ended at once (already healed, nothing to hide from): re-selected on each sample otherwise
      // (stress stand fuzz-730: Hide>Heal>Hide, each "healed" in a tick at level 2 with a skeleton at 10 blocks).
      // A run that "escaped" at once had nobody in reach to run from (a shot still flying from a shooter already past its
      // range): Flee and CreateDistance - one run under two names - sit out together (stand fuzz-68: CD>Flee>CD in 6 ticks).
      // So does one that "escaped" within a second while the incident goes on (burning at low health, a zombie past 17 blocks:
      // each run safe in 3 ticks, CD>Flee>CD - stand fuzz-5085).
      const run = action.id === 'Flee' || action.id === 'CreateDistance'
      const escaped = !!result && typeof result === 'object' && ((result as { mode?: string }).mode === 'оторвался' || (result as { safe?: boolean }).safe === true)
      const idle = (IDLE_COOLED.has(action.id) || run) && clock.now() - episode.at < 100 &&
        !(result && typeof result === 'object' && 'killed' in result && result.killed) || run && escaped && clock.now() - episode.at < 1000
      if ((failed || idle) && action.id !== 'FreeEmbedded' && clock.now() - episode.at < 1000) {
        for (const id of run && idle ? ['Flee', 'CreateDistance'] as const : [action.id]) this.failedAt.set(id, clock.now())
      }
      this.finish(episode, ending, result)
      this.episode = null
      this.arbiter.finished()
    }).finally(() => {
      if (this.pending === pending) this.pending = null
      if (!this.episode) {
        try { this.state = this.ports.observe(this.session) } catch {}
      }
      if (!this.episode && (!this.state || threatLevel(this.state) === 0)) this.release('safe')
    })
  }

  private async execute(action: Candidate, ctl: Controller, state: TacticalState): Promise<unknown> {
    const session = this.session
    const bot = session.bot
    // The strike goes to the nearest foe a sword reaches (the entity table order is arbitrary: a LastStand against a
    // circling phantom walked to a brute 13 blocks away that had not even engaged - stress stand).
    const enemy = state.enemies.filter(candidate => candidate.threatening)
      .sort((a, b) => Number(meleeReachable(b)) - Number(meleeReachable(a)) || a.distance - b.distance)
      .find(candidate => bot.entities[candidate.id]?.position &&
      bot.entities[candidate.id].isValid !== false && (candidate.unseen || pick.aim(bot, bot.entities[candidate.id], {
        range: action.id === 'Shield' ? Math.max(16, candidate.distance + 1) : 16 })?.point))
    if ((action.id === 'Fight' || action.id === 'LastStand') && !enemy) {
      return { unavailable: true, reason: 'observed target disappeared or lost line of sight before act' }
    }
    switch (action.id) {
      case 'BoatLavaHop': {
        const result = await runBoatHop(session, ctl)
        if (!result.ok && !ctl.aborted) throw Object.assign(new Error(result.why || 'boat hop exit not confirmed'), { detail: result })
        return result
      }
      case 'WebBoatEscape': {
        const result = await webBoatEscape(session, ctl)
        if (!result.ok && !ctl.aborted) throw new Error(result.why || 'web boat rescue not confirmed')
        return result
      }
      case 'FlightEscape': case 'PearlEscape': {
        const escape = createEmergencyEscape(bot, { away: () => enemy ? bot.entities[enemy.id]?.position : null })
        const result = await escape.run(ctl, action.id === 'FlightEscape' ? 'flight' : 'pearl')
        if (!result.ok && !ctl.aborted) throw new Error(result.why || 'emergency escape not confirmed')
        return result
      }
      case 'UseFireResistance': {
        const result = await drinkFireResistance(session, ctl)
        if (!result.ok && !ctl.aborted) throw new Error(result.why || 'fire resistance not confirmed')
        return result
      }
      case 'ClimbOut': {
        const result = await climbFromLava(session, ctl)
        if (!result.ok && !ctl.aborted) throw new Error(result.why || 'lava climb not confirmed')
        return result
      }
      case 'FreeEmbedded': {
        const result = await session.autopilot?.freeIfBuried(bot, { ctl, force: true })
        if (ctl.aborted) return { cancelled: true }
        if (result?.freed === false || session.autopilot?.buriedBy(bot)) {
          const reason = result?.reason || 'body remains embedded after visible escape dig'
          session.bus.emit('tactical_failed', { action: action.id, reason, threatLevel: 4 })
          throw Object.assign(new Error(reason), { code: 'STILL_EMBEDDED' })
        }
        return result ?? { freed: true, dug: 0 }
      }
      case 'LastStand': return require('../combat').fight(session, ctl, { target: enemy ? '#' + enemy.id : undefined,
        allowPlayer: enemy?.player, timeoutSeconds: 15, lastStand: true, retreatAtHealth: 0, purpose: 'defense' })
      case 'Fight': {
        const attacker = state.enemies.find(candidate => candidate.threatening && candidate.distance <= 3 &&
          bot.entities[candidate.id]?.isValid !== false && bot.entities[candidate.id]?.position &&
          pick.aim(bot, bot.entities[candidate.id], { range: 3.2 })?.point)
        if (attacker && canRepelLavaAttacker(state)) {
          return require('../combat').fight(session, ctl, { target: '#' + attacker.id, allowPlayer: attacker.player,
            timeoutSeconds: 4, purpose: 'defense', repelLava: true })
        }
        if (/nether/.test(String(bot.game?.dimension || '')) && enemy) {
          const entity = bot.entities[enemy.id]
          return guard.react(session, ctl, { force: { e: entity, why: 'tactical fight' }, _owned: true, duelMs: 15000, sitMs: 8000 })
        }
        return require('../combat').fight(session, ctl, { target: enemy ? '#' + enemy.id : undefined, allowPlayer: enemy?.player, timeoutSeconds: 15, engaged: true })
      }
      case 'Dodge':
        // S4d: with a shield the blast is taken on it, facing the source (tactics/blast.ts shieldBlast) - unless a fall waits
        // behind the body: the explosion knockback still applies to a blocking player (ServerExplosion.hurtEntities pushes
        // every entity whose damage was not cancelled).
        if (S4D() && state.shield && state.blast !== 'falling_block') {
          const source = shieldableBlast(bot)
          if (source && !dropBehind(bot, source.entity.position)) return shieldBlast(session, ctl, { maxMs: 4000 })
        }
        return state.blast ? dodgeBlast(session, ctl, { maxMs: state.blast === 'charged_creeper' ? 5000 : 4000 }) : survival.dodgeCreeper(session, ctl, {})
      case 'Flee': case 'CreateDistance':
        // Lava: the swim out. Burning on dry ground: a water bucket puts it out (escapeFire pours it); without one a run does
        // not, and escapeFire's blind 1.2 s sprint-jump toward the nearest floor cell went over platform and bridge edges
        // (review g, S4c) - the run is smartFlee's from the shooters (edge guard, stepSafe, no fire cells).
        // No foe in sight while burning: smartFlee "escaped" nobody in a tick and the body stood in burning grass (s8-f3-15).
        if (state.hotFloor || state.lava || state.burning && !state.fireResistance && (state.water || !hasObservedTarget(state))) {
          const result = await require('../director').escapeFire(session, ctl)
          return result.status === 'failed' ? { ...result, failed: true, reason: result.detail?.how || 'contact escape not confirmed' } : result
        }
        // Past the default FOLLOW_RANGE 16 (Mob.createMobAttributes): smartFlee's own 14 left the creeper/skeleton/spider
        // still targeting, so it walked back into contact and the same flight repeated (stress stand, charged-creeper).
        // smartFlee steers by mobs only: near a primed TNT the first leg is dodgeBlast (TNT and mobs), then the flight.
        if (blastNear(bot, 2)) await dodgeBlast(session, ctl)
        if (ctl.aborted) return { cancelled: true }
        // An attacking player is a pursuer too (smartFlee steers by mob doctrine; without him it "escaped" in a tick).
        return flee.smartFlee(session, ctl, { timeoutMs: 12000, reason: 'tactical', safeDist: FLEE_SAFE_DISTANCE, chaseExit: true,
          foes: state.enemies.filter(foe => foe.player && foe.threatening).map(foe => foe.id) })
      case 'DigDown':
        if (state.enemies.some(foe => foe.threatening && foe.kind === 'enderman')) {
          const fortify = require('../fortify')
          const valid = () => bot.entity.onGround && survival.holePlan(bot, session.mcData, fortify.feetCell(bot))
          if (!valid()) return { failed: true, reason: 'physical hole disappeared before descent' }
          await fortify.centerInCell(bot)
          if (ctl.aborted) return { cancelled: true }
          if (!valid()) return { failed: true, reason: 'physical hole changed while centering' }
          const previous = session._refugeBuild
          session._refugeBuild = ctl
          let entry: any
          try {
            entry = await require('../survival/enter-shelter').enterShelter(session, ctl,
              { depth: 3, torch: false, box: false, maxSwings: 5, center: true })
          } finally { if (session._refugeBuild === ctl) session._refugeBuild = previous }
          if (ctl.aborted) return { cancelled: true, entry }
          if (!entry.sealed || !survival.refugeLook(session).pocket) return { failed: true, entry, reason: 'closed hole was not confirmed' }
          // The same recovery runs only after the existing pocket is real. Its generic outrun preface cannot help against
          // a teleporting pursuer and must not replace the selected descent before a single block is dug.
          const result = await survival.refuge(session, ctl, { minHp: 16, maxSeconds: 30, stayIn: true, why: 'tactical DigDown' })
          return result?.code && result.code !== 'OK' ? { ...result, entry, failed: true, reason: result.stopped || 'refuge was not confirmed' } : { ...result, entry }
        }
      case 'BlockOff': case 'PillarUp': case 'Hide': case 'Heal':
        {
          const result = await survival.refuge(session, ctl, { minHp: 16, maxSeconds: 30, stayIn: action.id === 'BlockOff', why: 'tactical ' + action.id })
          return result?.code && result.code !== 'OK' ? { ...result, failed: true, reason: result.stopped || 'refuge was not confirmed' } : result
        }
      case 'Eat': {
        if (state.burning && !state.fireResistance) {
          const escape = await require('../director').escapeFire(session, ctl)
          if (ctl.aborted) return { cancelled: true }
          if (escape.status !== 'done') return { failed: true, reason: 'fire contact remains before recovery bite', detail: escape.detail }
        }
        return foodActions.eat(session, ctl, {})
      }
      case 'Shield': {
        const combat = require('../combat')
        const shield = combat.makeShield(session, ctl, { shield: 'always' })
        let abort!: () => void
        const cancelled = new Promise<void>(resolve => { abort = resolve; if (ctl.aborted) resolve(); else ctl.onAbort.push(abort) })
        try {
          if (!await shield.wear()) throw new Error('shield unavailable')
          if (enemy && bot.entities[enemy.id]) await bot.lookAt(bot.entities[enemy.id].position.offset(0, 1.5, 0), true)
          if (ctl.aborted) return { cancelled: true }
          const deadline = clock.now() + combat.SHIELD_NATIVE_CONFIRM_MS
          await shield.raise(true)
          for (;;) {
            if (ctl.aborted) return { cancelled: true }
            const failure = shield.failure()
            if (failure) throw new Error(failure)
            const observed = observeTactics(session)
            const permissible = shieldCanContinue(observed)
            if (!permissible || clock.now() >= deadline) {
              // The threat passing before the server confirmed the block is not a failed shield (farm telemetry 06.10:
              // 13 of 28 Shields "failed", several within 1-2 ticks of raising); only the confirmation deadline is.
              if (!shield.blocking() && permissible) throw new Error('shield blocking not confirmed')
              return { shielded: shield.blocking(), shield: shield.report() }
            }
            const facing = observed.enemies.filter(candidate => candidate.threatening).sort((a, b) => a.distance - b.distance)
              .find(candidate => bot.entities[candidate.id]?.position && bot.entities[candidate.id].isValid !== false &&
                pick.aim(bot, bot.entities[candidate.id], { range: Math.max(16, candidate.distance + 1) })?.point)
            if (facing) {
              const entity = bot.entities[facing.id]
              await bot.lookAt(entity.position.offset(0, (entity.height || 1.8) * .75, 0), true)
            }
            await Promise.race([movement.sleep(40), shield.cancelled, cancelled])
          }
        } finally {
          const i = ctl.onAbort.indexOf(abort)
          if (i >= 0) ctl.onAbort.splice(i, 1)
          shield.close()
        }
      }
      case 'UseWater': {
        const bucket = bot.inventory.items().find((item: MinecraftEntity) => item.name === 'water_bucket')
        if (!bucket || ctl.aborted) return { unavailable: true }
        await bot.equip(bucket, 'hand')
        if (ctl.aborted) return { cancelled: true }
        await bot.look(bot.entity.yaw, -Math.PI / 2, true)
        bot.activateItem()
        await movement.sleep(200)
        return { extinguished: !!bot.entity.isInWater }
      }
      case 'Surface': return movement.escapeWater(bot, ctl, { timeoutMs: 15000 })
      case 'EnterPortal': return require('../nether').enter(session, ctl, { scan: 4, timeoutSeconds: 20, noIgniter: true })
    }
  }

  private finish(episode: Episode, result: string, detail?: unknown): void {
    const hp = this.session.bot?.health ?? 0
    let state = this.state
    try { state = this.ports.observe(this.session) || state } catch {}
    if (state) this.escapes.finish(episode.action.id, this.escapeObservation(state), result, result === 'completed' && (detail as { chased?: boolean } | undefined)?.chased === true)
    this.session.bus.emit('tactical_finished', { action: episode.action.id, result: hp <= 0 ? 'died' : result, hpBefore: episode.hp, hp,
      gameMs: clock.now() - episode.at, detail })
    // TODO plan, step 1: outcome died / killed / escaped / alive, next to the technical result.
    const facts = (detail && typeof detail === 'object' ? detail : {}) as { killed?: boolean; mode?: string; safe?: boolean }
    const outcome = hp <= 0 ? 'died' : facts.killed ? 'killed' : facts.mode === 'оторвался' || facts.safe ? 'escaped' : 'alive'
    this.ports.record({ level: 'tactical', skill: episode.action.id, skillVersion: 1, threat: episode.level,
      candidates: episode.candidates, selected: episode.action.id, sec: (clock.now() - episode.at) / 1000,
      hp0: episode.hp, hp, result: hp <= 0 ? 'died' : result, outcome, alive: hp > 0, detail, state: episode.state })
  }

  private escapeObservation(state: TacticalState): EscapeObservation {
    const position = this.session.bot?.entity?.position || { x: 0, y: 0, z: 0 }
    const actions: ActionId[] = []
    const add = (id: ActionId, enabled: boolean | undefined) => { if (enabled) actions.push(id) }
    const route = state.escapeRoute || state.lava && !state.fireResistance
    add('Flee', route); add('CreateDistance', route)
    add('FlightEscape', state.flightEscape); add('PearlEscape', state.pearlEscape); add('EnterPortal', state.portal)
    add('WebBoatEscape', state.webBoatEscape)
    add('BoatLavaHop', state.boatLavaHop)
    add('UseFireResistance', state.fireResistancePotion && !state.fireResistance); add('ClimbOut', state.lavaClimb && state.fireResistance)
    add('Hide', state.cover && !state.lava)
    if (state.shelter) add(state.shelter, (state.blocks > 0 || state.shelter === 'DigDown' || state.shelter === 'Hide') && !state.lava)
    return { at: state.at, position: { x: position.x, y: position.y, z: position.z },
      threatDistance: state.enemies.filter(enemy => enemy.threatening).reduce<number | null>((distance, enemy) => distance === null ? enemy.distance : Math.min(distance, enemy.distance), null),
      exits: this.session._tacticalExitGeometry || '',
      available: actions.length > 0, actions, swim: state.lava || state.burning && !state.fireResistance && state.water, armed: state.weapon }
  }

  private release(reason: string): void {
    if (reason === 'unavailable' || reason === 'disconnected') {
      locks.cancel(this.session)
      delete this.session._tacticalLavaClimbGoal
      this.state = null
      this.level = 0
      this.arbiter.finished()
    }
    if (this.episode) { this.finish(this.episode, reason); this.episode = null; this.arbiter.finished() }
    if (this.substantive) {
      // A worker accepted after waitForRelease belongs to the next plan.
      if (reason !== 'unavailable' && reason !== 'disconnected' && this.session.current?.ctl === this.incident?.intent) this.interruptSkill(this.level)
      this.substantive = false
      this.escapes.clear()
      this.needsObservation = true
      this.session.replanRevision = (this.session.replanRevision || 0) + 1
      if (this.incident) {
        const hp = this.session.bot?.health ?? 0
        this.ports.record({ level: 'tactical_episode', threat: this.incident.threat,
          actions: [...this.incident.actions], chain: this.incident.chain, state: this.incident.state, sec: (clock.now() - this.incident.at) / 1000,
          hp0: this.incident.hp, hp, result: hp <= 0 ? 'died' : reason, replanRevision: this.session.replanRevision })
        this.incident = null
      }
      this.session.bus.emit('tactical_released', { reason, replanRevision: this.session.replanRevision, requireObservation: true })
    }
  }

  detach(): void {
    const bot = this.bot
    if (!bot) return
    locks.cancel(this.session)
    this.release('disconnected')
    bot.removeListener('physicsTick', this.onTick)
    bot.removeListener('health', this.onDamage)
    bot.removeListener('forcedMove', this.onForcedMove)
    bot.removeListener('end', this.onEnd)
    bot._client?.removeListener('damage_event', this.onDamage)
    this.bot = null
    this.state = null
    this.level = 0
    this.observationError = undefined
    this.lastSample = -Infinity
    this.session._tacticalEmbedded = false
    this.escapes.clear()
  }
}

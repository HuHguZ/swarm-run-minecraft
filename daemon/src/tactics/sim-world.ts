// Abstract tactical stress world (no Minecraft): a scenario is a tape of events (an attacker appears, TNT falls, lava
// under the feet...) plus damage/effect models checked against 1.21.11 bytecode/data of the farm's Paper jar
// (farm/server-30/versions/1.21.11/paper-1.21.11.jar, javap; data/minecraft/** of server-1.21.11.jar):
// - armor: CombatRules.getDamageAfterAbsorb = dmg * (1 - clamp(armor - dmg / (2 + tough / 4), armor * .2, 20) / 25);
//   tag bypasses_armor: on_fire, in_wall, drown, fall, ender_pearl (lava, mob, arrow, explosion are reduced);
// - i-frames: LivingEntity.hurtServer, invulnerableTime > duration(20) / 2 admits only amount > lastHurt (the excess);
// - explosion: ExplosionDamageCalculator.getEntityDamageAmount, ((1 - d / 2r) * exposure)^2 + same) / 2 * 7 * 2r + 1,
//   damage_type/explosion scaling "always" (normal difficulty = x1); PrimedTnt power 4, fuse 80; Creeper radius 3
//   (powered x2), maxSwell 30;
// - lava: Entity.lavaHurt 4.0 and igniteForSeconds(15); fire: 1.0 every 20 ticks outside lava; drown: 2.0 at air -20;
//   in_wall 1.0 per tick (i-frames); fall: BASE_SAFE_FALL_DISTANCE 3;
// - regen: FoodData food >= 18 every 80 ticks, food 20 with saturation every 10 ticks;
// - shields: bypasses_shield excludes mob/player/arrow/explosion, i.e. a raised shield stops them from the front;
// - FOLLOW_RANGE: Mob.createMobAttributes 16, Zombie 35 (husk inherits), PiglinBrute 12 (class constants of the jar);
//   goal mobs drop the target beyond it (TargetGoal.canContinueToUse), the brute's brain keeps an acquired target.
// Mob numbers: assess.MOBS (hp, melee damage with the held weapon, attack period), speeds: surface-body.chaseBps.
// Everything the bot does is a coarse effect model (ponytail: hand calibrated; calibrate from `tactical` telemetry).
import { sustainableFight, type ActionId, type TacticalEnemy, type TacticalState } from './state'

const assess: { MOBS: Record<string, { hp: number; dmg: number; every: number; ranged?: boolean; armor?: number }>; afterArmor(dmg: number, armor: number, tough: number): number } = require('../assess')
const safety: { evaluate(input: Record<string, unknown>): { action: string } } = require('../combat-safety')
const flee: { DOCTRINE: Record<string, { range?: number; radius?: number }> } = require('../flee')

export const MECH = {
  safeFall: 3, lavaDamage: 4, lavaIgniteTicks: 300, fireDamage: 1, fireEvery: 20, inWall: 1, drown: 2, airMax: 300,
  tntPower: 4, tntFuse: 80, creeperRadius: 3, creeperSwell: 30, creeperStart: 3, creeperStop: 7, pearlDamage: 5,
  regenSlow: 80, regenFast: 10, iframes: 20, shieldDelay: 5, shieldDisable: 100, eatTicks: 32,
  sprint: 5.6, walk: 4.3, playerAttackTicks: 13
}
const BYPASS_ARMOR = new Set(['on_fire', 'in_wall', 'drown', 'fall', 'ender_pearl'])
const SHIELDABLE = new Set(['mob', 'player', 'arrow', 'explosion'])
const WEAPON: Record<string, { dmg: number; ticks: number; disablesShield?: boolean }> = {
  fist: { dmg: 1, ticks: 5 }, stone_sword: { dmg: 5, ticks: 13 }, iron_sword: { dmg: 6, ticks: 13 }, diamond_sword: { dmg: 7, ticks: 13 },
  iron_axe: { dmg: 9, ticks: 22, disablesShield: true }, diamond_axe: { dmg: 9, ticks: 20, disablesShield: true }
}
const chaseBps = (speed: number) => 20 * 0.98 * speed * speed / (1 - 0.6 * 0.91)
// A crit jump (melee.ts critNow: strike while falling): LivingEntity jump power .42, gravity .08, drag .98 per tick. The
// feet are a block up for ticks 3-8 (floored y + 1) - an observation taken then sees no ground (farm 06.10, slot 30:
// Fight<->LastStand every sample while jumping at blazes).
export const JUMP: number[] = (() => { const h = [0]; for (let y = 0, v = .42; ;) { y += v; v = (v - .08) * .98; if (y <= 0) return h; h.push(y) } })()
export const jumpHeight = (w: SimWorld): number => JUMP[w.tick - w.body.jumpAt] ?? 0
// Ghast FOLLOW_RANGE 100, EnderMan 64 / speed .3, MagmaCube speed .2, Hoglin speed .3 (createAttributes of the jar, javap
// 06.10 round 2); the rest inherit Monster/Zombie/Spider/AbstractSkeleton defaults. A ghast hovers at range (flying .06).
const FOLLOW: Record<string, number> = { zombie: 35, husk: 35, drowned: 35, piglin_brute: 12, phantom: 64, ghast: 100, enderman: 64, blaze: 48 }
const MOB_SPEED: Record<string, number> = { phantom: .55, zombie: .23, husk: .23, drowned: .23, skeleton: .25, creeper: .25, spider: .3, cave_spider: .3,
  piglin_brute: .35, piglin: .35, wither_skeleton: .25, enderman: .3, magma_cube: .2, hoglin: .3, vindicator: .35, ghast: .1 }

export type SimEvent =
  | { at: number; type: 'enemy'; kind: string; distance: number; angle?: number; player?: boolean; damage?: number; hp?: number;
      armor?: number; toughness?: number; every?: number; charged?: boolean; axe?: boolean; breakTicks?: number; hostile?: boolean }
  | { at: number; type: 'tnt'; distance: number; fuse?: number }
  | { at: number; type: 'lava' }
  | { at: number; type: 'fall'; height: number }
  | { at: number; type: 'fire'; ticks?: number }
  | { at: number; type: 'suffocate' }
  | { at: number; type: 'water'; ticks?: number }
  | { at: number; type: 'damage'; amount: number; kind?: string }
  | { at: number; type: 'loseBlocks' }

export interface BodySpec {
  hp: number; food: number; armor: number; toughness: number; weapon: string; shield: boolean; blocks: number; meals: number
  waterBucket: boolean; frPotion: number; pearls: number
}
// physics: the share of game ticks the bot's client actually simulates (farm 750 TPS: 0.41-0.69, once 0.08 - s4-stress,
// S7 status.physicsTicks/clock.ticks). Body movement and block placing go that much slower in game time; the server-timed
// effects (mobs, eating, fuses, damage) do not.
// rough: stage B ground with 1-block steps (natural terrain; the farm's slot-18 deaths of 06.10 22:57 MSK), the mirror ignores it.
export interface WorldSpec { exits: boolean; cover: boolean; nether: boolean; floorDiggable: boolean; lavaExit: boolean; landing: boolean; portal: boolean; physics: number; rough?: boolean }
// skill: the long job the distractions interrupt (default mine): dig blocks, walk a path, or craft through window clicks.
export interface Scenario { name: string; seed?: number; ticks?: number; body?: Partial<BodySpec>; world?: Partial<WorldSpec>; skill?: boolean | 'mine' | 'walk' | 'craft'; events: SimEvent[] }

export interface SimEnemy {
  id: number; kind: string; x: number; z: number; hp: number; damage: number; every: number; reach: number; speed: number
  range: number; armor: number; toughness: number; player: boolean; hostile: boolean; cooldown: number; swell: number
  charged: boolean; axe: boolean; breakTicks: number; provoked: boolean; engaged: boolean
}
// fired/x/z: where and when it left the shooter (the facade of stage B flies it as an entity toward the body).
export interface Arrow { from: number; damage: number; due: number; fired: number; x: number; z: number }
interface Tnt { x: number; z: number; fuse: number }
export type Shelter = { kind: 'box' | 'pillar' | 'hole' | 'pocket'; breach: number }
export interface ActionRun { id: ActionId; started: number; data: Record<string, number> }

export interface SimWorld {
  tick: number; spec: WorldSpec; body: BodySpec & {
    x: number; z: number; saturation: number; burning: number; fireRes: number; inLava: boolean; embedded: boolean; air: number
    submerged: number; falling: { height: number; ticks: number } | null; shelter: Shelter | null; shieldUp: number; shieldOff: number
    invul: number; lastHurt: number; hurtAt: number; hurtByMob: boolean; hurtBy: number | null; regen: number; escaped: boolean
    jumpAt: number
  }
  enemies: SimEnemy[]; tnts: Tnt[]; arrows: Arrow[]; events: SimEvent[]; nextId: number; rng: () => number
  log: string[]; died: string | null; onHurt?: () => void
}

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}

export function createWorld(scenario: Scenario): SimWorld {
  const body: BodySpec = { hp: 20, food: 20, armor: 15, toughness: 0, weapon: 'iron_sword', shield: false, blocks: 16, meals: 8,
    waterBucket: false, frPotion: 0, pearls: 0, ...scenario.body }
  const spec: WorldSpec = { exits: true, cover: false, nether: false, floorDiggable: true, lavaExit: true, landing: true, portal: false, physics: 1, ...scenario.world }
  return { tick: 0, spec, body: { ...body, x: 0, z: 0, saturation: 5, burning: 0, fireRes: 0, inLava: false, embedded: false, air: MECH.airMax,
    submerged: 0, falling: null, shelter: null, shieldUp: 0, shieldOff: 0, invul: 0, lastHurt: 0, hurtAt: -1e9, hurtByMob: false, hurtBy: null,
    regen: 0, escaped: false, jumpAt: -1e9 },
  enemies: [], tnts: [], arrows: [], events: [...scenario.events].sort((a, b) => a.at - b.at), nextId: 2, rng: rng(scenario.seed ?? 1),
  log: [], died: null }
}

const dist = (w: SimWorld, x: number, z: number) => Math.hypot(x - w.body.x, z - w.body.z)
const alive = (w: SimWorld) => w.enemies.filter(enemy => enemy.hp > 0)

export function hurt(w: SimWorld, amount: number, type: string, source: SimEnemy | null = null): number {
  const b = w.body
  if (b.hp <= 0 || amount <= 0 || b.escaped) return 0
  if (SHIELDABLE.has(type) && b.shield && b.shieldUp >= MECH.shieldDelay && b.shieldOff <= 0) {
    if (source?.axe) { b.shieldOff = MECH.shieldDisable; b.shieldUp = 0 }
    return 0
  }
  if ((type === 'lava' || type === 'on_fire') && b.fireRes > 0) return 0
  let applied = amount
  if (b.invul > MECH.iframes / 2) {
    if (amount <= b.lastHurt) return 0
    applied = amount - b.lastHurt
    b.lastHurt = amount
  } else { b.lastHurt = amount; b.invul = MECH.iframes }
  if (!BYPASS_ARMOR.has(type)) applied = assess.afterArmor(applied, b.armor, b.toughness)
  b.hp = Math.max(0, b.hp - applied)
  b.hurtAt = w.tick; b.hurtByMob = !!source || type === 'explosion' || type === 'arrow'; b.hurtBy = source?.id ?? null
  if (source?.player) source.provoked = true
  w.log.push(`${w.tick} hurt ${type} ${applied.toFixed(1)} -> ${b.hp.toFixed(1)}`)
  if (b.hp <= 0) w.died = type
  w.onHurt?.()
  return applied
}

function explode(w: SimWorld, x: number, z: number, radius: number, label: string): void {
  const d = dist(w, x, z) / (radius * 2)
  if (d > 1) return
  // ponytail: exposure 1 everywhere (a box/hole is not modelled as ray cover); TNT also breaks the shelter it hits.
  const impact = 1 - d
  hurt(w, (impact * impact + impact) / 2 * 7 * radius * 2 + 1, 'explosion')
  if (w.body.shelter && d < .5) w.body.shelter = null
  w.log.push(`${w.tick} boom ${label} d=${(d * radius * 2).toFixed(1)}`)
}

function spawn(w: SimWorld, e: Extract<SimEvent, { type: 'enemy' }>): void {
  const mob = assess.MOBS[e.kind] || { hp: 20, dmg: 3, every: 1 }
  const angle = e.angle ?? 0
  const player = !!e.player
  const doctrine = flee.DOCTRINE[e.kind]
  const ranged = !player && !!mob.ranged
  // Shooters cap at 15 blocks, a ghast fires from 64 (Ghast$GhastShootFireballGoal: distanceToSqr < 4096), a blaze from its
  // follow range 48 (BlazeAttackGoal.getFollowDistance; javap 06.10 round 2): a 17-block flight is no escape from them.
  const shot = e.kind === 'ghast' ? 64 : e.kind === 'blaze' ? 48 : Math.min(15, doctrine?.range ?? 15)
  w.enemies.push({ id: w.nextId++, kind: e.kind, x: w.body.x + Math.cos(angle) * e.distance, z: w.body.z + Math.sin(angle) * e.distance,
    hp: e.hp ?? (player ? 20 : mob.hp), damage: e.damage ?? (player ? 7 : mob.dmg), every: e.every ?? (player ? MECH.playerAttackTicks : Math.round(mob.every * 20)),
    reach: ranged ? shot : e.kind === 'creeper' ? 0 : 2.5, speed: player ? MECH.sprint : chaseBps(MOB_SPEED[e.kind] ?? .25),
    range: ranged ? shot : 0, armor: e.armor ?? (player ? 0 : mob.armor ?? 0), toughness: e.toughness ?? 0, player,
    hostile: e.hostile ?? true, cooldown: 0, swell: 0, charged: !!e.charged, axe: !!e.axe || e.kind === 'piglin_brute', breakTicks: e.breakTicks ?? (player ? 40 : 0),
    provoked: false, engaged: false })
}

function applyEvent(w: SimWorld, e: SimEvent): void {
  const b = w.body
  w.log.push(`${w.tick} event ${e.type}`)
  switch (e.type) {
    case 'enemy': spawn(w, e); break
    case 'tnt': w.tnts.push({ x: b.x + e.distance, z: b.z, fuse: e.fuse ?? MECH.tntFuse }); break
    case 'lava': b.inLava = true; b.shelter = null; break
    case 'fall': b.falling = { height: e.height, ticks: Math.max(4, Math.round(Math.sqrt(e.height) * 5)) }; b.shelter = null; break
    case 'fire': b.burning = Math.max(b.burning, e.ticks ?? 160); break
    case 'suffocate': b.embedded = true; break
    case 'water': b.submerged = e.ticks ?? 400; break
    case 'damage': hurt(w, e.amount, e.kind ?? 'generic'); break
    case 'loseBlocks': b.blocks = 0; break
  }
}

// One server tick of the world, without the bot's own action (stepAction runs first).
export function stepWorld(w: SimWorld): void {
  const b = w.body
  w.tick++
  while (w.events.length && w.events[0].at <= w.tick) applyEvent(w, w.events.shift()!)
  if (b.hp <= 0 || b.escaped) return
  if (b.invul > 0) b.invul--
  if (b.shieldOff > 0) b.shieldOff--
  if (b.fireRes > 0) b.fireRes--
  // environment
  if (b.inLava) { hurt(w, MECH.lavaDamage, 'lava'); b.burning = Math.max(b.burning, MECH.lavaIgniteTicks) }
  else if (b.burning > 0) { if (b.burning % MECH.fireEvery === 0) hurt(w, MECH.fireDamage, 'on_fire'); b.burning-- }
  if (b.fireRes > 0 && !b.inLava) b.burning = 0
  if (b.embedded) hurt(w, MECH.inWall, 'in_wall')
  if (b.submerged > 0) { b.submerged--; b.burning = 0; if (--b.air <= -20) { b.air = 0; hurt(w, MECH.drown, 'drown') } }
  else b.air = Math.min(MECH.airMax, b.air + 4)
  if (b.falling && --b.falling.ticks <= 0) {
    const clutch = b.waterBucket && !w.spec.nether
    const damage = clutch ? 0 : Math.ceil(b.falling.height - MECH.safeFall)
    b.falling = null
    if (damage > 0) hurt(w, damage, 'fall')
  }
  // explosives
  for (const t of [...w.tnts]) if (--t.fuse <= 0) { w.tnts.splice(w.tnts.indexOf(t), 1); explode(w, t.x, t.z, MECH.tntPower, 'tnt') }
  // projectiles
  for (const a of [...w.arrows]) if (a.due <= w.tick) {
    w.arrows.splice(w.arrows.indexOf(a), 1)
    const shooter = w.enemies.find(enemy => enemy.id === a.from) ?? null
    const covered = b.shelter && b.shelter.kind !== 'pillar' && b.shelter.breach <= 0
    if (!covered && w.rng() < .8) hurt(w, a.damage, 'arrow', shooter)
  }
  // enemies
  for (const e of alive(w)) {
    const d = dist(w, e.x, e.z)
    const sheltered = !!b.shelter && b.shelter.breach <= 0
    if (e.kind === 'creeper') {
      const sees = !(sheltered && b.shelter!.kind === 'box')
      if (e.hostile && sees && (d < MECH.creeperStart || e.swell > 0 && d < MECH.creeperStop)) e.swell++
      else if (e.swell > 0) e.swell--
      if (e.swell >= MECH.creeperSwell) { e.hp = 0; explode(w, e.x, e.z, MECH.creeperRadius * (e.charged ? 2 : 1), 'creeper'); continue }
    }
    if (!e.hostile && !(e.player && e.provoked)) continue
    const follow = e.player ? Infinity : FOLLOW[e.kind] ?? 16
    if (d <= follow) e.engaged = true
    else if (e.kind !== 'piglin_brute') e.engaged = false
    if (!e.engaged) continue
    // ponytail: a phantom swoops at ~8 b/s and circles 12 blocks out until its attack cools down (no altitude modelled).
    if (e.kind === 'phantom' && e.cooldown > 0) { if (d < 12) { e.x += (e.x - b.x) / Math.max(.1, d) * .4; e.z += (e.z - b.z) / Math.max(.1, d) * .4 } e.cooldown--; continue }
    const want = e.range ? Math.min(e.range - 3, 10) : e.kind === 'creeper' ? 1.5 : 1.5
    if (d > want) { const step = Math.min(d - want, e.speed / 20); e.x += (b.x - e.x) / d * step; e.z += (b.z - e.z) / d * step }
    if (e.cooldown > 0) { e.cooldown--; continue }
    if (e.kind === 'creeper') continue
    if (e.range && d <= e.range) {
      w.arrows.push({ from: e.id, damage: e.damage, due: w.tick + Math.max(2, Math.round(d / 1.6)), fired: w.tick, x: e.x, z: e.z })
      e.cooldown = e.every
    } else if (!e.range && d <= e.reach + .5) {
      // A pillar or a hole is out of a walker's reach; a player reaches 3 blocks up or down (eye 1.62 + reach 3), a flyer
      // (phantom, vex, bee) comes to it.
      const blocked = sheltered && (b.shelter!.kind === 'box' || b.shelter!.kind === 'pocket' || !e.player && !/^(phantom|vex|bee)$/.test(e.kind))
      if (blocked && e.breakTicks > 0 && b.shelter!.kind === 'box') { if (--b.shelter!.breach <= -e.breakTicks) { b.shelter = null; w.log.push(`${w.tick} box broken by ${e.kind}`) }; continue }
      if (blocked) continue
      const crit = e.player && w.rng() < .7 ? 1.5 : 1
      hurt(w, e.damage * crit, e.player ? 'player' : 'mob', e)
      e.cooldown = e.every
    }
  }
  // natural regeneration
  if (b.hp > 0 && b.hp < 20 && b.food >= 18) {
    b.regen++
    const fast = b.food >= 20 && b.saturation > 0
    if (b.regen >= (fast ? MECH.regenFast : MECH.regenSlow)) { b.regen = 0; b.hp = Math.min(20, b.hp + 1); if (fast) b.saturation = Math.max(0, b.saturation - 1.5); else b.food = Math.max(0, b.food - (w.rng() < .25 ? 1 : 0)) }
  }
}

export function threatTruth(w: SimWorld): { level4: boolean; why: string } {
  const b = w.body
  if (b.hp <= 0 || b.escaped) return { level4: false, why: '' }
  if (b.inLava && b.fireRes <= 0) return { level4: true, why: 'lava' }
  if (b.embedded) return { level4: true, why: 'embedded' }
  if (b.submerged > 0 && b.air <= 60) return { level4: true, why: 'drown' }
  if (w.enemies.some(e => e.hp > 0 && e.kind === 'creeper' && e.swell > 0 && dist(w, e.x, e.z) <= 5)) return { level4: true, why: 'creeper' }
  if (w.tnts.some(t => t.fuse <= 40 && dist(w, t.x, t.z) < MECH.tntPower * 2)) return { level4: true, why: 'tnt' }
  return { level4: false, why: '' }
}

// The same facts observeTactics derives from mineflayer (tactics/minecraft.ts), from the abstract world.
export function observeWorld(w: SimWorld, session: Record<string, unknown> = {}): TacticalState | null {
  const b = w.body
  if (b.hp <= 0 || b.escaped) return null
  const at = w.tick * 50
  const sheltered = !!b.shelter && b.shelter.breach <= 0
  const hiddenBy = sheltered && b.shelter!.kind === 'box'
  const visible = alive(w).filter(e => dist(w, e.x, e.z) <= 16 && !hiddenBy)
  const recent = b.hurtByMob && at - b.hurtAt * 50 < 1500 && b.hurtAt * 50 > ((session._tacticalRetreatSafeAt as number | undefined) ?? -Infinity)
  const enemies: TacticalEnemy[] = visible.map(e => {
    const attacker = e.player && b.hurtBy === e.id && at - b.hurtAt * 50 < 10000
    const threatening = e.player ? attacker : e.hostile
    return { id: e.id, kind: e.kind, distance: dist(w, e.x, e.z), player: e.player, threatening,
      ...(threatening ? { hit: assess.afterArmor(e.damage * (e.player ? 1.5 : 1), b.armor, b.toughness) } : {}) }
  })
  const hostile = enemies.filter(enemy => enemy.threatening)
  const doctrineContact = hostile.some(enemy => enemy.distance <= 4.5 || (flee.DOCTRINE[enemy.kind]?.range || 0) >= enemy.distance)
  const contact = recent || doctrineContact
  const creeper = visible.filter(e => e.kind === 'creeper' && dist(w, e.x, e.z) <= 7).find(e => e.swell > 0 || dist(w, e.x, e.z) <= 3.3)
  const tnt = w.tnts.some(t => dist(w, t.x, t.z) <= MECH.tntPower * 2 + 1)
  const tntNear = w.tnts.some(t => dist(w, t.x, t.z) <= MECH.tntPower * 2 + 3)
  const chargedNear = visible.some(e => e.kind === 'creeper' && e.charged && dist(w, e.x, e.z) <= 15)
  const threats = hostile.map(enemy => ({ id: enemy.id, name: enemy.kind, distance: enemy.distance, hit: enemy.hit ?? 0 }))
  const weapon = WEAPON[b.weapon] ?? WEAPON.fist
  const expected = threats.length ? threats.reduce((sum, t) => sum + t.hit, 0) * Math.max(1, threats.reduce((sum, t) => sum + (w.enemies.find(e => e.id === t.id)?.hp ?? 0), 0) / (weapon.dmg * 1.3) / 1.5) : null
  const verdict = safety.evaluate({ health: b.hp, food: b.food, foodPoints: b.meals * 6, weapon: b.weapon !== 'fist', threats, minHealth: 8, expected,
    dangerous: threats.length > 0 })
  // survival/hold-out.chooseRefuge: a swelling creeper or one within 4 blocks means flee, not a box.
  const boxBreaker = visible.some(e => e.kind === 'creeper' && (e.swell > 0 && dist(w, e.x, e.z) <= 7 || dist(w, e.x, e.z) <= 4))
  const shelter = shelterChoice(w, hostile, boxBreaker)
  // Lava under the body changes the real signature (exitsNear block names, the rescue exit); so does it here.
  session._tacticalExitGeometry = `${Math.round(b.x)},${Math.round(b.z)}|${b.inLava}|${w.spec.exits}|${b.shelter?.kind ?? ''}|${shelter}|${b.pearls > 0}|${b.frPotion > 0}`
  const lava = b.inLava
  const falling = !!b.falling && b.falling.height > MECH.safeFall
  return { at, health: b.hp, food: b.food, armor: b.armor, weapon: b.weapon !== 'fist', shield: b.shield && b.shieldOff <= 0,
    enemies, incomingProjectiles: w.arrows.filter(a => a.due - w.tick <= 10).length, burning: b.burning > 0, lava, lavaAhead: false,
    fireResistance: b.fireRes > 0, explosion: !!creeper || tnt, blast: tntNear ? 'tnt' : chargedNear ? 'charged_creeper' : null, dangerousFall: falling && b.waterBucket && !w.spec.nether, emergencyController: false,
    inWater: b.submerged > 0, drowning: b.submerged > 0 && b.air <= 120, cover: w.spec.cover && !lava, portal: w.spec.portal && b.hp >= 10 && b.hp < 12, escapeRoute: w.spec.exits && !b.falling,
    blocks: b.blocks, water: !w.spec.nether && b.waterBucket, edible: b.meals > 0, canFight: hostile.length > 0 && sustainableFight(verdict, b.hp), contact,
    shelter, protectedEncounter: false, embedded: b.embedded, airborne: !!b.falling || jumpHeight(w) > 0, aerialCombat: false,
    flightEscape: false, pearlEscape: lava && b.pearls > 0 && w.spec.landing, fireResistancePotion: (lava || b.burning > 0) && b.frPotion > 0,
    lavaClimb: w.spec.lavaExit, lavaEscapePending: false, webBoatEscape: false, boatLavaHop: false }
}


function shelterChoice(w: SimWorld, hostile: TacticalEnemy[], creeper: boolean): TacticalState['shelter'] {
  const b = w.body
  if (!hostile.length || b.inLava || b.submerged > 0 || creeper) return null
  if (w.spec.cover) return 'Hide'
  const shooters = hostile.some(enemy => (flee.DOCTRINE[enemy.kind]?.range || 0) >= enemy.distance && !enemy.player)
  if (b.blocks >= 5) return 'BlockOff'
  if (b.blocks >= 4 && !shooters && !hostile.some(enemy => /spider|creeper/.test(enemy.kind))) return 'PillarUp'
  if (w.spec.floorDiggable && !w.spec.nether && !shooters) return 'DigDown'
  return null
}

// Effect model of one action for one tick. Returns a result when the action ends.
export function stepAction(w: SimWorld, run: ActionRun): Record<string, unknown> | null {
  const b = w.body
  const t = w.tick - run.started
  const enemies = alive(w)
  const engaged = enemies.filter(e => e.hostile || e.player && e.provoked).sort((p, q) => dist(w, p.x, p.z) - dist(w, q.x, q.z))
  const nearest = engaged[0]
  // minecraft.ts: a strike goes to the nearest foe in sword reach (ghast never, blaze/phantom only within 3.5).
  const reachable = (e: SimEnemy) => e.kind !== 'ghast' && (!/^(blaze|phantom)$/.test(e.kind) || dist(w, e.x, e.z) <= 3.5)
  const target = engaged.find(reachable) ?? nearest
  const away = (from: { x: number; z: number } | undefined, speed: number) => {
    if (!from || !w.spec.exits || b.falling || b.embedded) return
    const d = Math.max(.01, dist(w, from.x, from.z))
    b.x += (b.x - from.x) / d * speed * w.spec.physics / 20; b.z += (b.z - from.z) / d * speed * w.spec.physics / 20
    if (b.shelter) b.shelter = null
  }
  switch (run.id) {
    case 'Fight': case 'LastStand': {
      if (!target) return { killed: false, lost: true }
      const d = dist(w, target.x, target.z)
      if (d > 2.8) { const step = Math.min(d - 2.5, MECH.walk * w.spec.physics / 20); b.x += (target.x - b.x) / d * step; b.z += (target.z - b.z) / d * step; return null }
      const weapon = WEAPON[b.weapon] ?? WEAPON.fist
      run.data.cool = (run.data.cool ?? 0) - 1
      // A crit is a jump that strikes on the way down: it leaves the ground 7 ticks before the swing.
      if (run.data.cool === 7 && run.data.crit === undefined) {
        run.data.crit = w.rng() < .6 ? 1 : 0
        if (run.data.crit && !b.shelter && !b.falling && !b.inLava && b.submerged <= 0) b.jumpAt = w.tick
      }
      if (run.data.cool <= 0) {
        const crit = (run.data.crit ?? (w.rng() < .6 ? 1 : 0)) ? 1.5 : 1
        delete run.data.crit
        target.hp -= assess.afterArmor(weapon.dmg * crit, target.armor, target.toughness)
        if (target.player) target.provoked = true
        run.data.cool = weapon.ticks
        if (target.hp <= 0) return { killed: true }
      }
      if (run.id === 'Fight' && b.hp <= 6) return { retreated: true }
      return t >= 300 ? { timeout: true } : null
    }
    case 'Flee': case 'CreateDistance': {
      if (b.inLava) { if (w.spec.lavaExit && t >= 60) { b.inLava = false; return { swamOut: true } } return t >= 240 ? { failed: true, reason: 'no shore' } : null }
      // minecraft.ts: burning with a bucket - escapeFire pours it; without one the run is smartFlee's (below).
      if (b.burning > 0 && b.fireRes <= 0 && b.waterBucket && !w.spec.nether) return t >= 12 ? (b.burning = 0, { extinguished: true }) : null
      const tnt = w.tnts.find(t => dist(w, t.x, t.z) <= MECH.tntPower * 2 + 3)
      if (tnt) { const blast = tnt; dodgeAway(w, blast, enemies); return null } // minecraft.ts: dodgeBlast first near TNT
      // flee.smartFlee (S4c): an attacking player is run from too (the tactics pass his id); escaped when the walkers are past
      // safeDist (the tactics pass 17) and every shooter is past its weapon's reach (jar: blaze 48, ghast 64) or behind a wall:
      // with cover nearby (spec.cover) the run reaches it in ~2 s and breaks the line of fire.
      const mob = engaged[0]
      away(mob, b.food > 6 ? MECH.sprint : MECH.walk)
      const shaken = (e: SimEnemy) => e.range ? dist(w, e.x, e.z) >= e.range + 1 || w.spec.cover && t >= 40 : dist(w, e.x, e.z) >= 17
      if (engaged.every(shaken)) return { safe: true }
      return t >= 240 ? { timeout: true } : null
    }
    case 'BlockOff': case 'PillarUp': case 'DigDown': case 'Hide': case 'Heal': {
      if (!b.shelter) {
        const kind = run.id === 'Hide' || run.id === 'Heal' && w.spec.cover ? 'pocket' : run.id === 'PillarUp' ? 'pillar' : run.id === 'DigDown' ? 'hole' : 'box'
        const need = kind === 'box' ? 5 : kind === 'pillar' ? 4 : 0
        const build = (kind === 'pocket' ? 0 : kind === 'box' ? 30 : kind === 'pillar' ? 42 : 50) / w.spec.physics
        if (run.id === 'Heal' && !w.spec.cover && b.blocks < 5) return { failed: true, reason: 'no cover' }
        if (b.blocks < need) return { failed: true, reason: 'blocks' }
        if (t < build) return null
        b.blocks -= need
        b.shelter = { kind, breach: 0 }
        run.data.built = w.tick
        w.log.push(`${w.tick} built ${kind}`)
      }
      if (b.food < 18 && b.meals > 0) { run.data.eat = (run.data.eat ?? 0) + 1; if (run.data.eat >= MECH.eatTicks) { run.data.eat = 0; b.meals--; b.food = Math.min(20, b.food + 6); b.saturation += 7 } }
      const clear = !nearest || dist(w, nearest.x, nearest.z) > 8
      if (b.hp >= 16 && clear) { b.shelter = null; return { healed: true } }
      if (t >= 600) { b.shelter = null; return { timeout: true } }
      return null
    }
    case 'Eat':
      if (b.meals <= 0) return { failed: true }
      if (t < MECH.eatTicks) return null
      b.meals--; b.food = Math.min(20, b.food + 6); b.saturation += 7
      return { ate: true }
    case 'Shield':
      if (!b.shield || b.shieldOff > 0) return { failed: true, reason: 'shield unavailable' }
      b.shieldUp++
      return t >= 50 ? (b.shieldUp = 0, { shielded: true }) : null
    case 'Dodge': {
      // tactics/minecraft.ts: a blast source (TNT) is dodged by dodgeBlast before survival.dodgeCreeper.
      const tnt = w.tnts.find(t => dist(w, t.x, t.z) <= MECH.tntPower * 2 + 1)
      // survival.dodgeCreeper: the nearest dangerous creeper on every step, a swelling one counts 4 blocks nearer (the first
      // in the list was a far one already "clear" while the near one swelled - stand fuzz-6443, Dodge every 3 ticks).
      const danger = (e: SimEnemy) => dist(w, e.x, e.z) - (e.swell > 0 ? 4 : 0)
      const creeper = tnt ? undefined : enemies.filter(e => e.kind === 'creeper' && dist(w, e.x, e.z) < 9).sort((p, q) => danger(p) - danger(q))[0]
      const blast = tnt ?? creeper
      const clear = creeper ? creeper.charged ? 13 : 8 : MECH.tntPower * 2 + 3
      // dodgeBlast/dodgeCreeper pick the direction among all dangers (flee.pickDirection): away from the blast and the mobs.
      if (blast) dodgeAway(w, blast, enemies)
      return !blast || dist(w, blast.x, blast.z) >= clear || t >= (creeper ? creeper.charged ? 100 : 60 : 80) ? { dodged: !blast || dist(w, blast.x, blast.z) >= clear } : null
    }
    case 'UseWater':
      if (!b.waterBucket || w.spec.nether) return { unavailable: true }
      if (t < 4) return null
      b.burning = 0
      return { extinguished: true }
    case 'Surface': if (t >= 20) { b.submerged = 0; return { ok: true } } return null
    case 'EnterPortal': if (t >= 80) { b.escaped = true; return { entered: true } } return null
    case 'FreeEmbedded': if (t >= 20) { b.embedded = false; return { freed: true } } return null
    case 'FlightEscape': case 'PearlEscape':
      if (t < 20) return null
      if (run.id === 'PearlEscape') { if (b.pearls <= 0) throw new Error('no pearl'); b.pearls--; b.inLava = false; hurt(w, MECH.pearlDamage, 'ender_pearl'); return { ok: true } }
      b.inLava = false
      return { ok: true }
    case 'UseFireResistance':
      if (b.frPotion <= 0) throw new Error('fire resistance not confirmed')
      if (t < MECH.eatTicks) return null
      b.frPotion--; b.fireRes = 3600; b.burning = 0
      return { ok: true }
    case 'ClimbOut':
      if (b.fireRes <= 0) throw new Error('lava climb not confirmed')
      if (!w.spec.lavaExit) return t >= 100 ? (() => { throw new Error('lava climb not confirmed') })() : null
      if (t >= 60) { b.inLava = false; return { ok: true } }
      return null
    case 'WebBoatEscape': case 'BoatLavaHop':
      if (t >= 60) { b.inLava = false; return { ok: true } }
      return null
  }
  return { unknown: true }
}

// dodgeBlast/dodgeCreeper pick the direction among all dangers (flee.pickDirection): away from the blast and the mobs.
function dodgeAway(w: SimWorld, blast: { x: number; z: number }, enemies: SimEnemy[]): void {
  const b = w.body
  if (!w.spec.exits || b.falling || b.embedded) return
  const sources = [{ x: blast.x, z: blast.z, weight: 3 }, ...enemies.filter(e => e !== blast && dist(w, e.x, e.z) < 12).map(e => ({ x: e.x, z: e.z, weight: 1 }))]
  const push = sources.reduce((sum, s) => { const d = Math.max(.5, dist(w, s.x, s.z)); return { x: sum.x + (b.x - s.x) / d / d * s.weight, z: sum.z + (b.z - s.z) / d / d * s.weight } }, { x: 0, z: 0 })
  const norm = Math.max(1e-6, Math.hypot(push.x, push.z))
  b.x += push.x / norm * MECH.sprint * w.spec.physics / 20; b.z += push.z / norm * MECH.sprint * w.spec.physics / 20
  if (b.shelter) b.shelter = null
}

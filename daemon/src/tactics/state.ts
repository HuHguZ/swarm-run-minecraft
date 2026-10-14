export type ThreatLevel = 0 | 1 | 2 | 3 | 4
export type ActionId = 'Fight' | 'LastStand' | 'Flee' | 'Heal' | 'Eat' | 'Shield' | 'Dodge' | 'CreateDistance' | 'BlockOff' | 'PillarUp' | 'DigDown' | 'EnterPortal' | 'UseWater' | 'Hide' | 'FreeEmbedded' | 'FlightEscape' | 'PearlEscape' | 'UseFireResistance' | 'ClimbOut' | 'WebBoatEscape' | 'BoatLavaHop' | 'Surface'
export type ControlOwner = 'Skill' | 'Tactical' | 'Emergency'

export interface TacticalEnemy {
  id: number
  kind: string
  distance: number
  player: boolean
  threatening: boolean
  /** expected damage of one hit after our armor (combat-safety), when known */
  hit?: number
  /** struck us in melee within 1.5 s but the eye ray misses it (S4d): known from damage_event, not seen */
  unseen?: boolean
}

/** S4d round-4 tactics (07.10): ND_S4D=0 restores the S4c behaviour for the native A/B on one code. */
export const S4D = (): boolean => process.env.ND_S4D !== '0'

export interface TacticalState {
  at: number
  health: number
  food: number
  armor: number
  weapon: boolean
  shield: boolean
  enemies: TacticalEnemy[]
  incomingProjectiles: number
  burning: boolean
  hotFloor?: boolean
  lava: boolean
  lavaAhead?: boolean
  fireResistance: boolean
  explosion: boolean
  /** non-mob blast source near (tactics/blast.ts, 2 blocks past the alarm: explosion is the alarm itself) */
  blast?: 'tnt' | 'falling_block' | 'charged_creeper' | null
  dangerousFall: boolean
  emergencyController: boolean
  inWater: boolean
  /** submerged with air at or below 8 of 20 bubbles (stress stand: drowning was invisible to the tactics) */
  drowning?: boolean
  /** adult piglins in sight: hitting a brute broadcasts its anger to them (PiglinBruteAi.wasHurtBy -> PiglinAi.maybeRetaliate) */
  piglinWitnesses?: boolean
  cover: boolean
  portal: boolean
  escapeRoute: boolean
  blocks: number
  water: boolean
  edible: boolean
  canFight: boolean
  contact: boolean
  shelter: 'BlockOff' | 'PillarUp' | 'DigDown' | 'Hide' | null
  niche?: boolean
  /** Nether walkers the shield duel does not answer (brute, hoglin, three and more) near, and a hole or our own refuge holds. */
  netherHide?: boolean
  /** A ghast in sight with a lethal drop behind the body: its blast throws the body off the ledge. */
  ghastEdge?: boolean
  /** Damage expected during the physically planned descent, before the shelter closes. */
  digDownCostHp?: number
  protectedEncounter: boolean
  embedded?: boolean
  airborne?: boolean
  aerialCombat?: boolean
  flightEscape?: boolean
  pearlEscape?: boolean
  fireResistancePotion?: boolean
  lavaClimb?: boolean
  lavaEscapePending?: boolean
  webBoatEscape?: boolean
  boatLavaHop?: boolean
  escapeExhausted?: boolean
  failedEscapes?: ActionId[]
}

export interface Candidate {
  id: ActionId
  score: number
  reason: string
}

export const hasObservedTarget = (state: TacticalState): boolean => state.enemies.some(enemy => enemy.threatening)
// A nearby sealed niche breaks piglin sight without an exposed run - before melee: a piglin within reach strikes every
// second through the build, and the shield duel answers it there (try-lab-ne-piglin 14.10: niche at 1.6 blocks, 12 -> 0 hp).
export const piglinNiche = (s: TacticalState): boolean => !!s.niche && s.shield && s.shelter === 'BlockOff' &&
  hasObservedTarget(s) && s.enemies.every(e => !e.threatening || e.kind === 'piglin' && !e.player && e.distance > 3.5) &&
  !s.lava && !s.lavaAhead && !s.lavaEscapePending && !s.burning && !s.hotFloor && !s.explosion && !s.blast &&
  !s.dangerousFall && !s.emergencyController && !s.embedded && !s.inWater && !s.drowning && !s.airborne &&
  !s.failedEscapes?.includes('BlockOff')
// A sword reaches a ghast never and a hovering blaze only when it comes down to the body (farm telemetry 06.10 19:46,
// slot 21: LastStand re-selected ~100 times in 120 s against five blazes, 0 swings, death).
export const meleeReachable = (enemy: TacticalEnemy): boolean => enemy.kind !== 'ghast' && (!/^(blaze|phantom)$/.test(enemy.kind) || enemy.distance <= 3.5)
// No flight shakes a phantom, vex or bee: between swoops a phantom circles out of range, smartFlee reported "escaped"
// after 1-2 blocks and the phantom swooped again (farm 06.10 19:49, slot 17: Flee x3 at hp 6.9 -> death). Defend as in a
// dead end.
// A ghast out-ranges any run (FOLLOW_RANGE 100, javap 06.10 round 2; doctrine range 40): a flight "escaped" at 17 blocks and
// the next fireball started it again, every 2.5 s for the whole tape (stress stand v2, 11 of 14 cycles). Keep working,
// shield the shots, box up when low.
const OUTPACING = /^(phantom|vex|bee|ghast|blaze)$/
const SHOOTERS = /^(creeper|skeleton|stray|bogged|parched|pillager|witch|drowned|evoker|breeze|guardian|elder_guardian|shulker|piglin)$/
export function outpaced(state: TacticalState): boolean {
  const near = state.enemies.filter(enemy => enemy.threatening && enemy.distance <= 16)
  return state.contact && near.length > 0 && near.every(enemy => OUTPACING.test(enemy.kind))
}
// What a run buys, 0..1 - a price, not a ban (user 06.10, AGENTS.md "flexibility"; S4c replaces the round-2 bans F19-F21,
// which closed running from players, from blazes and from unseen shots at any health). A walker slower than a sprint is
// left behind (1). A flyer that outpaces any run (phantom, vex, bee) or a shooter whose reach outlasts it (blaze 48, ghast
// 64 - javap BlazeAttackGoal/GhastShootFireballGoal) is only shaken behind a wall: .3. A player sprints as fast as we do:
// .4. Shots with no foe in sight: the run is to the nearest cover, .5. A run is worth what it buys against the foe it does
// shake: a creeper or a zombie beside a phantom is still run from at full price (the worst pursuer deciding flipped the
// price each time a circling phantom crossed the 16-block edge - stand regress-creeper-build, Flee>BlockOff>Flee).
// (The "escaped at once" loops behind those bans were smartFlee's: doctrine ranges 20/40 and no players - fixed in flee.ts.)
export function runGain(state: TacticalState): number {
  // Lava: the swim to the shore. Fire on dry ground is put out by a bucket, not by running (it burns 8 s anyway).
  if (state.lava || state.burning && !state.fireResistance && state.water) return 1
  const near = state.enemies.filter(enemy => enemy.threatening && enemy.distance <= 16)
  // S4d: a shooter firing from past the 16-block horizon (observeTactics lists it only while it shoots) out-ranges the run
  // like one inside it.
  const far = S4D() ? state.enemies.filter(enemy => enemy.threatening && !enemy.player && enemy.distance > 16) : []
  if (!near.length && !far.length) return state.contact ? 1 : .5
  // S4d: a walker this armed body would fight on arrival is no reason to run before it arrives (natives s4d-ab bridge:
  // Flee from a wither skeleton 7 blocks off while burning, 3 s under the blazes, 18.7 -> 9.6 hp, then death). Not a creeper:
  // without a shield the run from one is the answer.
  // Nor a shooter: it does not come, it shoots (the retreat from a skeleton ends at its safe distance - stress-tactics).
  // Burning with no shooter around, the run is the way out of the fire cell (stand fuzz2-713: stood in fire for the spider).
  const underFire = state.enemies.some(enemy => enemy.threatening && (OUTPACING.test(enemy.kind) || SHOOTERS.test(enemy.kind) && enemy.kind !== 'creeper'))
  const awaited = (enemy: TacticalEnemy) => S4D() && state.canFight && state.weapon && !enemy.player && !SHOOTERS.test(enemy.kind) && enemy.distance > 4.5 && (!state.burning || underFire)
  // The angry enderman teleports after a retreat (flee.DOCTRINE.fast): a run buys cover, not separation. It remains a
  // walker for shelter geometry; adding it to OUTPACING would also inherit the flyer dead-end rules.
  return Math.max(...near.map(enemy => enemy.player ? .4 : OUTPACING.test(enemy.kind) || enemy.kind === 'enderman' ? .3 : awaited(enemy) ? .2 : 1), ...far.map(enemy => OUTPACING.test(enemy.kind) || enemy.kind === 'enderman' ? .3 : .5))
}
export const deadEnd = (state: TacticalState): boolean => hasObservedTarget(state) && (!!state.escapeExhausted || outpaced(state))
export const hasMeleeTarget = (state: TacticalState): boolean => state.enemies.some(enemy => enemy.threatening && meleeReachable(enemy))
export const canRepelLavaAttacker = (state: TacticalState): boolean => state.health > 0 && state.fireResistance &&
  (state.lava || !!state.lavaEscapePending) && state.weapon && state.canFight && state.contact &&
  !state.embedded && !state.explosion && !state.dangerousFall && !state.emergencyController &&
  state.enemies.some(enemy => enemy.threatening && enemy.distance <= 3)

// A fight the safety verdict abandons after the next exchange is a trade, not a favourable fight: the bot took one brute
// hit at 20 HP and then could not outrun it (stress stand brute-in-nether, cf. Full40). Cheap fights keep their verdict.
// A trade at the body (combat-safety, S4d: the walker already hits whatever we do) is sustainable by its own measure.
export function sustainableFight(verdict: { action?: string; cheap?: boolean; trade?: boolean; hit?: number; threshold?: number }, health: number): boolean {
  return verdict.action === 'fight' && (!!verdict.cheap || !!verdict.trade || health - (verdict.hit || 0) > (verdict.threshold || 0))
}

// Cover is no rest from a creeper walking up (stress stand: Heal/Hide/a held box and Dodge in turns until the blast).
export const creeperWalksUp = (state: TacticalState): boolean =>
  state.enemies.some(enemy => enemy.threatening && enemy.kind === 'creeper' && enemy.distance <= 12)

export const frWorth = (state: TacticalState): boolean => state.lava || !!state.hotFloor && !state.explosion || state.burning && state.health <= 10
// H2: after the lava exit at food 17, running cannot extinguish the residual burn.
// A 32-tick bite restores food 20 and saturation for fast regeneration. Use the
// existing healing price: a dry run cannot extinguish this fire or restore health.
export const burnRecovery = (state: TacticalState): boolean => state.burning && !state.fireResistance &&
  state.food < 20 && !state.lava && !state.lavaAhead && !state.lavaEscapePending && !state.water && !state.dangerousFall &&
  !state.emergencyController && !state.explosion && !state.contact && !state.incomingProjectiles && !hasObservedTarget(state)

export function threatLevel(state: TacticalState): ThreatLevel {
  if (state.health <= 0) return 0
  if (state.embedded || state.emergencyController || state.dangerousFall || state.lavaAhead || state.lava && !state.fireResistance || state.explosion) return 4
  if (state.hotFloor) return 3
  const foes = state.enemies.filter(enemy => enemy.threatening && enemy.distance <= 12)
  if (state.contact && (state.health <= 6 || foes.length >= 3 && state.health < 12)) return 3
  if (state.burning && !state.fireResistance && state.health <= 8) return 3
  if (state.drowning) return 3
  if (state.lava || state.lavaEscapePending) return 2
  // A brute, a hoglin or three walkers coming (netherHide, 8 blocks): the hole goes down before they arrive, not under them.
  if (state.contact || state.netherHide || state.incomingProjectiles > 0 || state.burning && !state.fireResistance) return 2
  if (foes.length) return 1
  return 0
}

export const KEEP_WORKING = 30
export function candidates(state: TacticalState, level = threatLevel(state)): Candidate[] {
  if (level === 0) return []
  const result: Candidate[] = []
  // Below level 3 an action is weighed against keeping the skill going (KEEP_WORKING): a run priced down by a pursuer that
  // keeps up (a lone blaze in sight at full health: Flee 19.5) is not worth the interrupted work (stand fuzz2/fuzz-2601:
  // Hide>Flee to cover and back every 2 s at 20 hp). At level 3 anything beats standing still.
  // A contacting enderman still needs a fallback when neither a safe strike nor a local shelter is available. Its
  // discounted run must compete with the risky hole, not disappear below the "keep working" price.
  const floor = level >= 3 || state.contact && state.enemies.some(enemy => enemy.threatening && enemy.kind === 'enderman') ? -Infinity : KEEP_WORKING
  const add = (id: ActionId, score: number, reason: string, available: boolean) => {
    if (available && !state.failedEscapes?.includes(id) && Number.isFinite(score) && score >= floor) result.push({ id, score, reason })
  }
  const critical = level >= 3
  const contact = state.contact
  const observedTarget = hasObservedTarget(state)
  const escapeExhausted = deadEnd(state)
  const niche = piglinNiche(state)
  // S1 (s1-full46/49): LastStand against a brute at the barter pit turned the watching piglins on the bot. Never strike a
  // brute in their sight; wall it off instead, even in an exhausted corner.
  const provokes = !!state.piglinWitnesses && state.enemies.some(enemy => enemy.threatening && enemy.kind === 'piglin_brute')
  const melee = hasMeleeTarget(state)
  // A last stand answers the foe at the body: a reachable one 13 blocks off that never engaged is no reason to walk out
  // (stress stand: a circling phantom made the cornered body attack a distant brute).
  const atBody = state.enemies.some(enemy => enemy.threatening && meleeReachable(enemy) && enemy.distance <= 6)
  // An armed, healthy body answers a circling phantom on its swoop; a box per pass only burns blocks (stress stand: box x4
  // in 20 s, also when hunger alone made the verdict "recover").
  // (Shooters that out-range a run - blaze, ghast - are walled off at any health: a wall stops their shots.)
  const swoops = outpaced(state) && !state.enemies.some(enemy => enemy.threatening && /^(blaze|ghast)$/.test(enemy.kind))
  const sheltered = (!escapeExhausted || provokes || !atBody) && !(swoops && state.weapon && state.health >= 10)
  // A wall takes ~1.5 s inside the attacker's reach (contact: a brute closes 4.5 blocks in under a second): two hits that
  // leave less than the 8 HP fight floor make building in place a trade (stress stand brute-in-nether: box at 20 HP,
  // abandoned 3 ticks before the seal at 4.8 HP, cf. Full40). Break contact first, as refuge does when the walker outruns
  // the build.
  const pressure = state.enemies.reduce((sum, enemy) => sum + (enemy.threatening && enemy.distance <= 4.5 ? enemy.hit ?? 0 : 0), 0)
  // A creeper closes 4 blocks (2.7 b/s) while a wall goes up (~1.5 s), and at 4 blocks refuge refuses the box: a build
  // started inside 8 blocks was dropped a sample later (stress stand fuzz-2564: Flee>BlockOff>Flee at hp 3). A score, not a
  // gate: a box started further out keeps the score it was chosen with (arbiter SHELTERS) as the creeper walks in.
  const creeperInBuild = state.enemies.some(enemy => enemy.threatening && enemy.kind === 'creeper' && enemy.distance <= 8)
  const exposedBuild = state.escapeRoute && !state.dangerousFall && (pressure > 0 && state.health - pressure * 2 < 8 || creeperInBuild)
  const creeperNear = creeperWalksUp(state)

  // A favourable verdict without a weapon is no fight (Fight needs one): score the retreats as for an unfavourable one
  // (stress stand: fists vs a husk -> Flee every few seconds, the husk follows 35 blocks).
  const armed = state.canFight && state.weapon
  // A player reaches up a 3-block pillar and down into a 2-deep hole (eye 1.62 + reach 3): only walls delay one (farm
  // telemetry 06.10, arena slot 27: DigDown against an attacking player, death).
  const playerFoe = state.enemies.some(enemy => enemy.threatening && enemy.player)
  // A primed blast or a charged creeper (radius 6) breaks the walls it would be hidden behind (farm s4-stress-6: BlockOff
  // at a charged creeper, then death).
  // Nor does it stop a flyer: a phantom swoops onto a pillar, a blaze shoots down at it (farm s1-LK-8: PillarUp x3 under
  // blazes 15 -> 5 hp, then death; stand: PillarUp against a phantom and a husk, killed on top).
  const flyer = state.enemies.some(enemy => enemy.threatening && /^(phantom|vex|bee|blaze|ghast)$/.test(enemy.kind))
  const shelterHolds = !((playerFoe || flyer) && (state.shelter === 'DigDown' || state.shelter === 'PillarUp')) && !state.blast
  // Lava without fire resistance: the swim to the shore finds its own exit (lava pools have no dry 3-block run).
  const route = state.escapeRoute || state.lava && !state.fireResistance
  add('FreeEmbedded', 180, 'solid block after teleport or suffocation', !!state.embedded)
  add('FlightEscape', 172, 'loaded safe landing with elytra and rockets', (state.lava || !!state.lavaAhead) && !!state.flightEscape)
  add('PearlEscape', 166, 'safe pearl landing and enough health', (state.lava || !!state.lavaAhead) && !!state.pearlEscape)
  add('WebBoatEscape', 160, 'cobweb, two wall supports and a boat', state.lava && !!state.webBoatEscape)
  // Горение без лавы при 11+ хп — секунды по 1 хп, а зелье — на бой у спавнера (sr-i-3 10.10: все 3 выпиты до боя, смерть в огне).
  add('UseFireResistance', 156, 'available fire resistance before climbing', frWorth(state) && !state.fireResistance && !!state.fireResistancePotion)
  add('BoatLavaHop', 154, 'existing expendable boats and a visible collision-free lava route', state.lava && !!state.boatLavaHop)
  add('ClimbOut', 140, 'fire resistant swimming or visible wall steps', (state.lava || !!state.lavaEscapePending) && state.fireResistance && !!state.lavaClimb)
  add('Surface', 148, 'air running out under water', !!state.drowning && !state.dangerousFall)
  add('Flee', 142, 'leave damaging magma', !!state.hotFloor && !state.dangerousFall && !state.emergencyController)
  add('UseWater', 145, 'fire', state.water && state.burning && !state.fireResistance && !state.lava)
  add('Dodge', 150, 'explosion', state.explosion)
  add('EnterPortal', 115, 'nearby escape', critical && state.portal && !state.dangerousFall)
  // Never a stand inside a blast alarm: LastStand (155) outscored Dodge (150) at a swelling charged creeper (farm s4-stress-3).
  // Nor in water: a stand among drowned outscored Surface (148) - hp 18 to 0 in a second (cl-l 14.10); with the head above water
  // LastStand and Surface took turns, hp 9 to 0 in 0.6 s (cl-s 14.10). In water the drowned swim and strike, our hits do not crit.
  add('LastStand', niche ? 90 : 155, 'observed escape attempts exhausted; defend until a new exit opens', level >= 2 && observedTarget && atBody && contact && escapeExhausted && !provokes && !state.explosion && !state.blast && !state.lava && !state.lavaEscapePending && !state.dangerousFall && !state.embedded && !state.aerialCombat && !state.drowning && !state.inWater)
  const repel = canRepelLavaAttacker(state)
  add('Fight', repel ? 157 : critical ? -100 : 90, repel ? 'repel a close attacker before resuming the fire resistant escape' : 'favorable fight', repel || level >= 2 && observedTarget && melee && state.canFight && state.weapon && contact && !state.blast && !state.protectedEncounter && !provokes && !state.lava && !state.lavaEscapePending && !escapeExhausted)
  // The Nether guard's answer to a brute, a hoglin or three walkers near is its hole two down (their reach stops at their feet) and
  // strikes from it: a run from a brute is two axe blows in a second (c2-5-2, c2-6-3 14.10: CreateDistance "does not get away",
  // 20 -> 0; try-lab-ne-piglin: hole 1-2 deaths of 8). Its own id (PillarUp), so the arbiter leaves a running duel for it; above a
  // last stand - the hole is the new exit.
  add('PillarUp', critical ? 160 : 158, 'hole or pillar out of the reach of Nether walkers', !!state.netherHide && level >= 2 &&
    !state.blast && !state.explosion && !state.protectedEncounter && !state.lava && !state.lavaEscapePending && !state.dangerousFall &&
    !state.embedded && !state.aerialCombat && !state.inWater)
  // A dead end is about the attackers; the swim out of lava (escapeFire) is no run from them: a ghast overhead made the pool
  // a "dead end" and the body burned with no action at all (stress stand v2 fuzz2-2182/2376/4393, level 4 unhandled); under
  // fire resistance too, when no wall step offers a climb. A swim that already failed (observed exhaustion) stays out.
  // Only runs that were tried and failed here (observed exhaustion) are out; a pursuer that keeps up prices the run down
  // (runGain) instead of closing it, so a body with no wall, shield or strike still runs for cover (S4c).
  const runOpen = !(observedTarget && state.escapeExhausted)
  const gain = runGain(state)
  add('Flee', (critical ? 100 : 65) * gain, 'create safe distance', level >= 2 && route && !state.dangerousFall && !state.aerialCombat && !state.lavaEscapePending && runOpen)
  // Not gated by canFight: a verdict flickering at the health threshold must not invalidate the retreat in progress.
  add('CreateDistance', (!armed || !observedTarget ? 85 : 50) * gain, 'unfavorable or unidentified attacker', level >= 2 && route && !state.dangerousFall && !state.aerialCombat && !state.lavaEscapePending && runOpen)
  // A ghast over a ledge: the box beats the shield and the swat - one missed fireball throws the body into the lava sea.
  const ghastBox = !!state.ghastEdge && state.shelter === 'BlockOff'
  const shelterScore = (ghastBox ? 130 : niche ? 110 : exposedBuild ? 60 : critical ? 120 : armed ? 45 : 95) *
    (state.shelter === 'DigDown' && state.digDownCostHp !== undefined ? Math.max(0, 1 - state.digDownCostHp / state.health) : 1)
  // A validated shaft supplies its own closing block as it is dug; an existing pocket needs no construction.
  if (state.shelter) add(state.shelter, shelterScore, 'available refuge', level >= 2 && shelterHolds && (state.blocks > 0 || state.shelter === 'DigDown' || state.shelter === 'Hide') && !state.dangerousFall && !state.aerialCombat && !state.lava && !state.lavaEscapePending && (sheltered || niche))
  add('Hide', 110, 'existing cover', critical && state.cover && !creeperNear && !state.dangerousFall && !state.lava && sheltered)
  add('Shield', 80, 'incoming threat', state.shield && !state.dangerousFall && !state.aerialCombat && (level === 1 || state.incomingProjectiles > 0))
  add('Heal', 105, 'recover behind cover', state.cover && !creeperNear && state.health < 16 && state.edible && !state.dangerousFall && !state.aerialCombat && !state.lava && !state.lavaEscapePending)
  const recoverBurn = burnRecovery(state)
  add('Eat', recoverBurn ? 105 : 45, recoverBurn ? 'restore regeneration after burning' : 'restore food',
    (recoverBurn || level <= 1 && state.food < 16) && state.edible && !state.dangerousFall)
  return result.sort((a, b) => b.score - a.score)
}

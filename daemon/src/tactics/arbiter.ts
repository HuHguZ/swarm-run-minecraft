import { threatLevel, creeperWalksUp, outpaced, hasObservedTarget, burnRecovery, type ActionId, type Candidate, type TacticalState, type ThreatLevel } from './state'
import { TacticalGraph, type TacticalNodeId } from './graph'

export interface TacticalDecision {
  level: ThreatLevel
  selected: Candidate | null
  candidates: Candidate[]
  change: boolean
  release: boolean
}

// Bounded actions keep their own goal after contact is lost (level 1): fleeing past contact range is the point of
// fleeing, and a released Flee let the zombie catch up at once (stress stand: CreateDistance every 0.3 s).
const CONTINUES_AT_LEVEL_1 = new Set<ActionId>(['Flee', 'CreateDistance', 'Dodge'])
// One executor (smartFlee/escapeFire) under two names: switching between them only restarts the same run (stress stand
// skeleton: CreateDistance>Flee>CreateDistance on every 2<->3 level change).
const SAME_RUN: Partial<Record<ActionId, string>> = { Flee: 'retreat', CreateDistance: 'retreat' }
// A started refuge keeps the score it was chosen with: the attacker walking into reach lowers a NEW build's score
// (state.ts exposedBuild), and abandoning a half-built box for a flight and back cycled until death (stress stand).
// Heal is the same refuge run (survival.refuge to minHp 16): a regenerated point crossing its "< 16" start condition
// dropped it for a fight and back (stress stand fuzz-2394: Fight>Heal>Fight in 16 ticks); the run ends itself at 16.
const SHELTERS = new Set<ActionId>(['BlockOff', 'PillarUp', 'DigDown', 'Hide', 'Heal'])
const BACK_MARGIN = 30

export class TacticalArbiter {
  readonly graph = new TacticalGraph()
  private current: Candidate | null = null
  private level: ThreatLevel = 0
  // The fall controller is a graph node: while it owns the body, the next choices leave through its edges.
  private node: TacticalNodeId = 'Strategic'
  private readonly left = new Set<ActionId>()
  private high: ThreatLevel = 0
  private foes = new Set<number>()

  constructor(private readonly margin = 15) {}

  decide(state: TacticalState): TacticalDecision {
    const level = threatLevel(state)
    const choices = this.graph.candidates(state, this.current?.id || this.node)
    const foes = new Set(state.enemies.filter(enemy => enemy.threatening).map(enemy => enemy.id))
    const newFoe = [...foes].some(id => !this.foes.has(id))
    if (level === 0 && !this.current) { this.high = 0; this.left.clear(); this.foes.clear() }
    if (newFoe) { this.high = 0; this.left.clear() }
    // Re-crossing the same injury threshold is not a new incident, however long the action has run.
    const escalated = level >= 3 && (level > this.high || level === 4 && level > this.level)
    this.high = Math.max(this.high, level) as ThreatLevel
    for (const id of foes) this.foes.add(id)
    const best = choices[0] || null
    const found = choices.find(candidate => candidate.id === this.current?.id)
    // A sealed refuge hides the attacker: its candidate disappears with the attacker's line of sight, and the 1.5 s hit
    // memory then pulled the body out of a finished box into the archer's fire (stress stand, skeleton at hp 8).
    const sealed = !!this.current && SHELTERS.has(this.current.id) && level >= 2 && level < 4 && !creeperWalksUp(state)
    const currentScore = (found && SHELTERS.has(found.id) ? { ...found, score: Math.max(found.score, this.current!.score) } : found) ??
      (level === 1 && this.current && CONTINUES_AT_LEVEL_1.has(this.current.id) || sealed ? this.current! : undefined)
    const release = !!this.current && level === 0
    const invalid = !!this.current && !currentScore
    // A flight running past contact at level 1 is not traded for standing behind a shield (husk: Shield>Flee in turns), nor
    // a running flight for a shield raised at a passing arrow or a rest in a cover that flickers (Flee>Shield|Heal>Flee); a started refuge is not left
    // for a strike at a phantom's swoop (BlockOff>LastStand>BlockOff).
    // A refuge is not left to raise a shield at each fireball either: the shelter stops the shot, the restart costs the
    // build (stress stand: Hide>Shield>Hide on every blaze volley); only a pillar stands in the open.
    // A retreat is not traded for a fight by preference either: fast regeneration made the verdict favourable again 1.6 s
    // into the run and the body walked 11 blocks back to the skeleton (stress stand fuzz-274); it ends at its safe distance.
    const running = !!currentScore && CONTINUES_AT_LEVEL_1.has(currentScore.id) && (level <= 1 || best?.id === 'Shield' || best?.id === 'Heal' || best?.id === 'Fight' && !!SAME_RUN[currentScore.id]) ||
      !!currentScore && SHELTERS.has(currentScore.id) && (best?.id === 'LastStand' || best?.id === 'Fight') && outpaced(state) ||
      !!currentScore && SHELTERS.has(currentScore.id) && currentScore.id !== 'PillarUp' && best?.id === 'Shield' ||
      // nor for a run from an attacker the walls now hide (unidentified: CreateDistance 85 outscored an armed box's 45 and
      // walked out under the blaze - stand regress-tnt-and-blaze, BlockOff>CreateDistance>BlockOff)
      !!currentScore && SHELTERS.has(currentScore.id) && !!best && !!SAME_RUN[best.id] && !hasObservedTarget(state)
    // Returning by preference needs the wider margin throughout this run; invalid guards and emergencies still win.
    const back = !!best && this.left.has(best.id) ? BACK_MARGIN : 0
    const better = !!best && !!currentScore && !running && best.score >= currentScore.score + this.margin + back
    const sameRun = !!best && !!currentScore && !!SAME_RUN[best.id] && SAME_RUN[best.id] === SAME_RUN[currentScore.id]
    let selected = this.current
    if (release) selected = null
    else if (sameRun && !invalid) selected = currentScore
    else if (best && (!this.current || invalid || escalated || better)) selected = best
    else if (currentScore) selected = currentScore
    else if (invalid && level > 0) selected = null
    // Airborne rescue belongs to the existing tick controller; no path or shelter action may race it.
    const falling = !state.embedded && (state.dangerousFall || state.emergencyController)
    if (falling) selected = null
    this.node = falling ? 'EmergencyController' : 'Strategic'
    // A residual fire tick crossing level 3 must not cancel and restart the same 32-tick bite. Nor the Nether hole half dug: the
    // hit that escalated to level 3 restarted it from the top, 2.4 s instead of 1.1 (try-lab-ne-piglin c7: "PillarUp preempted by
    // PillarUp", the piglins in the shaft before the plug).
    const change = selected?.id !== this.current?.id || escalated && !!selected && !(selected.id === 'Eat' && burnRecovery(state)) &&
      !(selected.id === 'PillarUp' && !!state.netherHide)
    if (this.current && selected?.id !== this.current.id && level > 0) this.left.add(this.current.id)
    this.current = selected
    this.level = level
    return { level, selected, candidates: choices, change, release: release || !selected && (level === 4 || invalid && level > 0) }
  }

  finished(): void { this.current = null; this.left.clear() }
  // A confirmed kill ends the old contact's commitment (s4d-smoke2 hungry-zombies: kill, then Flee from zombie 2).
  forgive(id: ActionId): void { this.left.delete(id) }
  // The system keeps a bounded action running through a calm sample (a sealed box, a flight past the sight edge); the
  // arbiter must not forget it, or the next stray arrow starts a new action that drags the body out (stress stand, blaze).
  hold(action: Candidate): void { this.current = action }
}

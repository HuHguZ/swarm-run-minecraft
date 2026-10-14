import { threatLevel, canRepelLavaAttacker, creeperWalksUp, outpaced, hasObservedTarget, burnRecovery, type ActionId, type Candidate, type TacticalState, type ThreatLevel } from './state'
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
// Opportunity actions dropped as unsafe are not re-entered at once: canFight flickers at the health threshold, and a
// shelter flickers with an approaching creeper's distance (stress stand creeper-skeleton-hp3: BlockOff>Flee>BlockOff).
const REENTRY = new Set<ActionId>(['Fight', 'BlockOff', 'PillarUp', 'DigDown', 'Hide', 'Heal'])

const BACK_MS = 2000
const BACK_MARGIN = 30

export class TacticalArbiter {
  readonly graph = new TacticalGraph()
  private current: Candidate | null = null
  private level: ThreatLevel = 0
  private changedAt = -Infinity
  // The fall controller is a graph node: while it owns the body, the next choices leave through its edges.
  private node: TacticalNodeId = 'Strategic'
  private safeSince: number | null = null
  private readonly dropped = new Map<ActionId, number>()
  // When each action was last left, for any reason: going back to it by preference needs a wider margin for a while.
  private readonly left = new Map<ActionId, number>()
  private readonly highAt = new Map<number, number>()

  constructor(private readonly margin = 15, private readonly minimumHoldMs = 350, private readonly releaseMs = 300, private readonly reentryMs = 1500) {}

  decide(state: TacticalState): TacticalDecision {
    const level = threatLevel(state)
    const choices = this.graph.candidates(state, this.current?.id || this.node)
    // Level 3 reached again within BACK_MS is a flicker, not news: burning at 8 hp crossed it with each fire tick and each
    // regenerated point, and every crossing re-picked by the moment's scores (stand fuzz-8604: Flee>BlockOff>Flee).
    const escalated = level > this.level && level >= 3 && (level === 4 || state.at - (this.highAt.get(level) ?? -Infinity) >= BACK_MS)
    for (let l = 1; l <= level; l++) this.highAt.set(l, state.at)
    const cooling = (candidate: Candidate) => REENTRY.has(candidate.id) && candidate.id !== this.current?.id && !escalated &&
      state.at - (this.dropped.get(candidate.id) ?? -Infinity) < this.reentryMs
    const best = choices.find(candidate => !cooling(candidate)) || choices[0] || null
    const found = choices.find(candidate => candidate.id === this.current?.id)
    // A sealed refuge hides the attacker: its candidate disappears with the attacker's line of sight, and the 1.5 s hit
    // memory then pulled the body out of a finished box into the archer's fire (stress stand, skeleton at hp 8).
    const sealed = !!this.current && SHELTERS.has(this.current.id) && level >= 2 && level < 4 && !creeperWalksUp(state)
    const currentScore = (found && SHELTERS.has(found.id) ? { ...found, score: Math.max(found.score, this.current!.score) } : found) ??
      (level === 1 && this.current && CONTINUES_AT_LEVEL_1.has(this.current.id) || sealed ? this.current! : undefined)
    if (level === 0) this.safeSince ??= state.at
    else this.safeSince = null
    const release = !!this.current && level === 0 && this.safeSince !== null && state.at - this.safeSince >= this.releaseMs
    const invalid = !!this.current && !currentScore
    if (invalid) this.dropped.set(this.current!.id, state.at)
    // Switching by preference into an ordinary fight waits the re-entry time: a canFight that flickers with regeneration
    // otherwise drags a started refuge into a fight and back (stress stand blocks-lost-in-box: BlockOff>Fight>BlockOff).
    const hold = best?.id === 'Fight' && !canRepelLavaAttacker(state) ? this.reentryMs : this.minimumHoldMs
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
    // Going back by preference to an action left less than BACK_MS ago needs BACK_MARGIN more: a boundary fact (a spider at
    // the 4.5-block build-exposure edge, burning on and off) swapped a box and a flight every second (stand fuzz-8652).
    const back = !!best && state.at - (this.left.get(best.id) ?? -Infinity) < BACK_MS ? BACK_MARGIN : 0
    const better = !!best && !!currentScore && !running && best.score >= currentScore.score + this.margin + back && state.at - this.changedAt >= hold
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
    if (change) this.changedAt = state.at
    if (this.current && selected?.id !== this.current.id) this.left.set(this.current.id, state.at)
    this.current = selected
    this.level = level
    return { level, selected, candidates: choices, change, release: release || !selected && (level === 4 || invalid && level > 0) }
  }

  finished(): void { this.current = null }
  // S4d: a fight that ended in a kill is no flicker - the next attacker is met with a sword, not with a 12 s run because the
  // dead one's candidate "dropped" Fight a moment ago (natives s4d-smoke2 hungry-zombies: kill, then Flee from zombie 2).
  forgive(id: ActionId): void { this.dropped.delete(id) }
  // The system keeps a bounded action running through a calm sample (a sealed box, a flight past the sight edge); the
  // arbiter must not forget it, or the next stray arrow starts a new action that drags the body out (stress stand, blaze).
  hold(action: Candidate): void { this.current = action }
}

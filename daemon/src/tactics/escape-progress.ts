import type { ActionId } from './state'

export interface EscapeObservation {
  at: number
  position: { x: number; y: number; z: number }
  threatDistance: number | null
  exits: string
  available: boolean
  actions?: ActionId[]
  /** in lava or burning without fire resistance: the run is the swim out, not a run from the pursuer */
  swim?: boolean
  /** armed: a stand has a chance; with fists a chased run is still the better bet (stand v2 fuzz2-2835) */
  armed?: boolean
}
const escapeActions = new Set<ActionId>(['Flee', 'CreateDistance', 'BlockOff', 'PillarUp', 'DigDown', 'Hide', 'EnterPortal', 'FlightEscape', 'PearlEscape', 'UseFireResistance', 'ClimbOut', 'WebBoatEscape', 'BoatLavaHop'])

const RUNS = new Set<ActionId>(['Flee', 'CreateDistance'])
// Runs that ended with the pursuer as close as they started, counted across places for the whole incident: a new cell is a
// new exit signature, so in open ground the per-place count never reached 2 - the body ran from a wither skeleton (it keeps
// within 4 blocks on a bounded platform) six times in a phase until a hit knocked it over the edge (native A/B s4c-ab /
// s4c-ab2, both arms: 5 of 16 wither-skeleton phases "fell from a high place"). Two such runs make the escape exhausted.
export const RUN_FAILURES = 2

export class EscapeProgress {
  private previous: EscapeObservation | null = null
  private failures = 0
  private runFailures = 0
  private signature = ''
  private readonly failed = new Set<ActionId>()

  observe(observation: EscapeObservation): { exhausted: boolean; failed: ActionId[] } {
    if (observation.exits !== this.signature) {
      this.signature = observation.exits
      this.failures = 0
      this.failed.clear()
    }
    if (observation.swim) this.runFailures = 0
    const available = observation.actions ? observation.actions.some(action => !this.failed.has(action)) : observation.available
    return { exhausted: !available || this.failures >= 2 || this.runFailures >= RUN_FAILURES, failed: [...this.failed] }
  }

  begin(action: ActionId, observation: EscapeObservation): void {
    this.previous = escapeActions.has(action) ? observation : null
  }

  finish(action: ActionId, observation: EscapeObservation, result: string): void {
    if (!escapeActions.has(action) || !this.previous || result === 'preempted' || result === 'interrupted') return
    const before = this.previous
    this.previous = null
    const moved = Math.hypot(observation.position.x - before.position.x, observation.position.z - before.position.z)
    const farther = before.threatDistance !== null && observation.threatDistance !== null && observation.threatDistance >= before.threatDistance + 1.5
    const climbed = observation.position.y >= before.position.y + 1
    // A run that moved but left the pursuer as close (both distances seen) did not escape; an unseen one is judged by the move.
    const chased = RUNS.has(action) && !before.swim && !!before.armed && before.threatDistance !== null && observation.threatDistance !== null && !farther && !climbed
    if (chased) this.runFailures++
    else if (RUNS.has(action)) this.runFailures = 0
    if (result === 'failed' || action !== 'UseFireResistance' && !farther && !climbed && moved < 1.5) {
      this.failures++
      this.failed.add(action)
    } else {
      this.failures = 0
      this.failed.clear()
    }
  }

  clear(): void { this.previous = null; this.failures = 0; this.runFailures = 0; this.signature = ''; this.failed.clear() }
}

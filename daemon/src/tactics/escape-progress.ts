import type { ActionId } from './state'

export interface EscapeObservation {
  at: number
  position: { x: number; y: number; z: number }
  threatDistance: number | null
  exits: string
  available: boolean
  actions?: ActionId[]
}
const escapeActions = new Set<ActionId>(['Flee', 'CreateDistance', 'BlockOff', 'PillarUp', 'DigDown', 'Hide', 'EnterPortal', 'FlightEscape', 'PearlEscape', 'UseFireResistance', 'ClimbOut', 'WebBoatEscape', 'BoatLavaHop'])

export class EscapeProgress {
  private previous: EscapeObservation | null = null
  private failures = 0
  private signature = ''
  private readonly failed = new Set<ActionId>()

  observe(observation: EscapeObservation): { exhausted: boolean; failed: ActionId[] } {
    if (observation.exits !== this.signature) {
      this.signature = observation.exits
      this.failures = 0
      this.failed.clear()
    }
    const available = observation.actions ? observation.actions.some(action => !this.failed.has(action)) : observation.available
    return { exhausted: !available || this.failures >= 2, failed: [...this.failed] }
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
    if (result === 'failed' || action !== 'UseFireResistance' && !farther && !climbed && moved < 1.5) {
      this.failures++
      this.failed.add(action)
    } else {
      this.failures = 0
      this.failed.clear()
    }
  }

  clear(): void { this.previous = null; this.failures = 0; this.signature = ''; this.failed.clear() }
}

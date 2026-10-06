import { threatLevel, type Candidate, type TacticalState, type ThreatLevel } from './state'
import { TacticalGraph } from './graph'

export interface TacticalDecision {
  level: ThreatLevel
  selected: Candidate | null
  candidates: Candidate[]
  change: boolean
  release: boolean
}

export class TacticalArbiter {
  readonly graph = new TacticalGraph()
  private current: Candidate | null = null
  private level: ThreatLevel = 0
  private changedAt = -Infinity
  private safeSince: number | null = null

  constructor(private readonly margin = 15, private readonly minimumHoldMs = 350, private readonly releaseMs = 300) {}

  decide(state: TacticalState): TacticalDecision {
    const level = threatLevel(state)
    const choices = this.graph.candidates(state, this.current?.id || 'Strategic')
    const best = choices[0] || null
    const currentScore = choices.find(candidate => candidate.id === this.current?.id)
    if (level === 0) this.safeSince ??= state.at
    else this.safeSince = null
    const release = !!this.current && level === 0 && this.safeSince !== null && state.at - this.safeSince >= this.releaseMs
    const escalated = level > this.level && level >= 3
    const invalid = !!this.current && !currentScore
    const better = !!best && !!currentScore && best.score >= currentScore.score + this.margin && state.at - this.changedAt >= this.minimumHoldMs
    let selected = this.current
    if (release) selected = null
    else if (best && (!this.current || invalid || escalated || better)) selected = best
    else if (currentScore) selected = currentScore
    else if (invalid && level > 0) selected = null
    // Airborne rescue belongs to the existing tick controller; no path or shelter action may race it.
    if (!state.embedded && (state.dangerousFall || state.emergencyController)) selected = null
    const change = selected?.id !== this.current?.id || escalated && !!selected
    if (change) this.changedAt = state.at
    this.current = selected
    this.level = level
    return { level, selected, candidates: choices, change, release: release || !selected && (level === 4 || invalid && level > 0) }
  }

  finished(): void { this.current = null }
}

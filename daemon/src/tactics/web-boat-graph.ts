export type WebBoatPhase = 'PlaceWeb' | 'EnterWeb' | 'BuildSupports' | 'PlaceBoat' | 'MountBoat' | 'VerifyExit' | 'Done' | 'Failed'
export interface WebBoatFacts {
  aborted: boolean
  alive: boolean
  webPlaced: boolean
  inWeb: boolean
  supports: number
  boatSpawned: boolean
  mounted: boolean
  safeHeight: boolean
}
const guards: Record<Exclude<WebBoatPhase, 'Done' | 'Failed'>, (facts: WebBoatFacts) => boolean> = {
  PlaceWeb: facts => facts.webPlaced,
  EnterWeb: facts => facts.inWeb,
  BuildSupports: facts => facts.supports >= 2,
  PlaceBoat: facts => facts.boatSpawned,
  MountBoat: facts => facts.mounted,
  VerifyExit: facts => facts.mounted && facts.safeHeight
}
const phases: WebBoatPhase[] = ['PlaceWeb', 'EnterWeb', 'BuildSupports', 'PlaceBoat', 'MountBoat', 'VerifyExit', 'Done']
export class WebBoatGraph {
  phase: WebBoatPhase = 'PlaceWeb'
  advance(facts: WebBoatFacts): WebBoatPhase {
    if (this.phase === 'Done' || this.phase === 'Failed') return this.phase
    if (facts.aborted || !facts.alive || !guards[this.phase](facts)) return this.phase = 'Failed'
    return this.phase = phases[phases.indexOf(this.phase) + 1]
  }
}

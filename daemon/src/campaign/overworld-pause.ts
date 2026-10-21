import type { Observation } from '../environments/mineflayer'

// Retry metadata only: never a planner fact or evidence of useful progress.
export function overworldPauseCause(observation: Observation): string {
  const state: any = observation.state, sit: any = observation.situation || {}, known: any = observation.known || {}
  const inventory = Object.entries(state.inventory || {}).filter(([, n]) => Number(n) > 0).sort(([a], [b]) => a.localeCompare(b))
  const places = Object.entries(known).filter(([, p]: any) => p && Number.isFinite(p.x) && Number.isFinite(p.z) &&
    (!p.dimension || p.dimension === 'overworld')).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, p]: any) => [name, p.x, p.y ?? null, p.z])
  return JSON.stringify([state.dimension, inventory, state.health ?? 20, state.food ?? 20, places,
    !!sit.night, !!sit.dusk, !!sit.surface, !!sit.inWater, !!sit.inLava, !!sit.onFire, !!sit.buried,
    state.tactics?.threatLevel ?? 0, state.tactics?.action ?? null,
    sit.work ? [!!sit.work.floor, !!sit.work.roof, sit.work.walls, !!sit.work.sealed] : null])
}

export type BoatTrapNode = 'CheckBoat' | 'CraftBoat' | 'PlaceBoat' | 'LureEnderman' | 'Captured' | 'KillCaptured' | 'Done' | 'Fallback'
export const boatTrapEdges: Readonly<Record<BoatTrapNode, readonly BoatTrapNode[]>> = {
  CheckBoat: ['CraftBoat', 'PlaceBoat', 'Fallback'], CraftBoat: ['PlaceBoat', 'Fallback'],
  PlaceBoat: ['LureEnderman', 'Fallback'], LureEnderman: ['Captured', 'Fallback'],
  Captured: ['KillCaptured', 'Fallback'], KillCaptured: ['Done', 'Fallback'], Done: [], Fallback: []
}
export class PassengerWitness {
  private readonly passengers = new Map<number, readonly number[]>()
  record(entityId: number, passengers: readonly number[]): void { this.passengers.set(entityId, [...passengers]) }
  has(boat: number, target: number): boolean { return this.passengers.get(boat)?.includes(target) ?? false }
}
export interface BoatTrapPort {
  now(): number
  sleep(ms: number): Promise<void>
  available(): boolean
  craftable(): boolean
  craft(): Promise<boolean>
  place(maxMs: number): Promise<number | null>
  safe(): boolean
  targetValid(): boolean
  captured(boat: number): boolean
  dead(): boolean
  lure(elapsedMs: number): Promise<void>
  attack(): Promise<boolean>
  cleanup(): Promise<void>
}
export interface BoatTrapResult { attempted: boolean; captured: boolean; killed: boolean; swings: number; boat?: number; why?: string; path: BoatTrapNode[]; seconds: number; observed?: Record<string, unknown> }
export async function runBoatTrap(port: BoatTrapPort, { captureMs = 10000, killMs = 25000 }: { captureMs?: number; killMs?: number } = {}): Promise<BoatTrapResult> {
  const began = port.now()
  const path: BoatTrapNode[] = ['CheckBoat']
  const result: BoatTrapResult = { attempted: false, captured: false, killed: false, swings: 0, path, seconds: 0 }
  const transition = (node: BoatTrapNode) => {
    if (!boatTrapEdges[path[path.length - 1]!]!.includes(node)) throw new Error(`Invalid boat transition: ${path[path.length - 1]} -> ${node}`)
    path.push(node)
  }
  const fallback = (why: string) => { transition('Fallback'); result.why = why; return result }
  try {
    if (!port.safe() || !port.targetValid()) return fallback('unsafe target')
    if (!port.available()) {
      if (!port.craftable()) return fallback('boat unavailable')
      result.attempted = true
      transition('CraftBoat')
      if (!await port.craft() || !port.safe() || !port.targetValid()) return fallback('boat craft failed')
    }
    result.attempted = true
    transition('PlaceBoat')
    const boat = await port.place(Math.min(2500, Math.max(0, captureMs - (port.now() - began))))
    if (boat === null || !port.safe()) return fallback('boat spawn not confirmed')
    result.boat = boat
    transition('LureEnderman')
    const lureAt = port.now()
    while (port.safe() && port.targetValid() && port.now() - began < captureMs && !port.captured(boat)) {
      await port.lure(port.now() - lureAt)
      await port.sleep(50)
    }
    if (!port.safe() || !port.targetValid() || !port.captured(boat)) return fallback('server passenger capture not confirmed')
    result.captured = true
    transition('Captured')
    transition('KillCaptured')
    const killAt = port.now()
    while (port.safe() && port.targetValid() && port.captured(boat) && !port.dead() && port.now() - killAt < killMs) {
      if (await port.attack()) result.swings++
      await port.sleep(50)
    }
    if (!port.dead()) return fallback(!port.captured(boat) ? 'passenger escaped' : 'captured kill interrupted or timed out')
    result.killed = true
    transition('Done')
    return result
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error))
  } finally {
    result.seconds = Math.round((port.now() - began) / 100) / 10
    await port.cleanup()
  }
}

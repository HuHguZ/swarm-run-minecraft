export type BoatHopPhase = 'Plan' | 'Place' | 'Mount' | 'Verify' | 'Break' | 'Done' | 'Failed'
export interface HopPosition { x: number; y: number; z: number; source?: 'player' | 'vehicle' }
export interface BoatHopPlan { at: HopPosition; surface: 'lava' | 'dry' }
export interface BoatHopPort {
  now(): number
  sleep(ms: number): Promise<void>
  health(): number
  aborted(): boolean
  stock(): number
  position(): HopPosition
  plan(): BoatHopPlan | null
  place(plan: BoatHopPlan, ms: number): Promise<number | null>
  mount(id: number, ms: number): Promise<boolean>
  breakBoat(id: number, ms: number): Promise<boolean>
  safe(): boolean
  phase(phase: BoatHopPhase, facts: Record<string, unknown>): void
}
export interface BoatHopResult {
  ok: boolean
  phase: BoatHopPhase
  hops: number
  spent: number
  healthBefore: number
  health: number
  died: boolean
  why?: string
  path: BoatHopPhase[]
  witnesses: Array<{ boatId: number; before: HopPosition; after: HopPosition; stockBefore: number; stockAfter: number; health: number }>
}
export const boatHopEdges: Record<BoatHopPhase, BoatHopPhase[]> = {
  Plan: ['Place', 'Done', 'Failed'], Place: ['Mount', 'Failed'], Mount: ['Verify', 'Failed'],
  Verify: ['Done', 'Break', 'Failed'], Break: ['Plan', 'Failed'], Done: [], Failed: []
}

export async function runBoatHops(port: BoatHopPort, { maxHops = 8, budgetMs = 10000, fallClutch = false } = {}): Promise<BoatHopResult> {
  const began = port.now()
  const result: BoatHopResult = { ok: false, phase: 'Plan', hops: 0, spent: 0, healthBefore: port.health(), health: port.health(), died: false, path: ['Plan'], witnesses: [] }
  const alive = () => !port.aborted() && port.health() > 0 && port.now() - began < budgetMs
  const advance = (phase: BoatHopPhase, facts: Record<string, unknown> = {}) => {
    if (!boatHopEdges[result.phase].includes(phase)) throw new Error(`invalid boat hop edge ${result.phase} -> ${phase}`)
    result.phase = phase; result.path.push(phase); port.phase(phase, facts)
  }
  const failure = (why: string) => { advance('Failed', { why }); result.why = why; return result }
  try {
    for (let hop = 0; hop < maxHops; hop++) {
      if (!alive()) return failure(port.health() <= 0 ? 'died' : port.aborted() ? 'interrupted' : 'boat hop time exhausted')
      if (port.safe()) { advance('Done'); result.ok = true; return result }
      const stockBefore = port.stock()
      if (stockBefore < 1) return failure('available boats exhausted')
      let plan = port.plan()
      if (fallClutch) while (!plan && alive()) { await port.sleep(50); plan = port.plan() }
      if (!plan) return failure('no visible collision-free boat surface')
      const before = port.position()
      advance('Place', { hop, stockBefore, at: plan.at, surface: plan.surface })
      const id = await port.place(plan, Math.min(1000, budgetMs - (port.now() - began)))
      const stockAfter = port.stock()
      if (id !== null) result.spent += Math.min(1, Math.max(0, stockBefore - stockAfter))
      if (id === null || !alive()) return failure(id === null ? 'actual boat spawn not confirmed' : 'interrupted after placement')
      advance('Mount', { boatId: id, stockAfter })
      if (!await port.mount(id, 750) || !alive()) return failure('actual passenger mount not confirmed')
      result.hops++
      const after = port.position()
      result.witnesses.push({ boatId: id, before, after, stockBefore, stockAfter, health: port.health() })
      advance('Verify', { boatId: id, before, after, health: port.health() })
      if (fallClutch) {
        const until = Math.min(began + budgetMs, port.now() + 1500)
        while (alive() && !port.safe() && port.now() < until) await port.sleep(50)
      }
      if (port.safe()) await port.sleep(300)
      if (!alive()) return failure(port.health() <= 0 ? 'died before stable landing' : port.aborted() ? 'interrupted before stable landing' : 'landing time exhausted')
      if (port.safe()) { advance('Done'); result.ok = true; return result }
      if (fallClutch) return failure('mount occurred but a safe ground landing was not confirmed')
      if (Math.hypot(after.x - before.x, after.z - before.z) < .4 && after.y - before.y < .2) return failure('mount gave no observed position progress')
      advance('Break', { boatId: id, pickupRequired: false })
      if (!await port.breakBoat(id, 1000) || !alive()) return failure('boat removal not confirmed')
      advance('Plan', { remaining: port.stock() })
    }
    return failure('bounded boat hop count exhausted')
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error))
  } finally {
    result.health = port.health()
    result.died = result.health <= 0
  }
}

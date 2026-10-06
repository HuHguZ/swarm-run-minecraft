import type { Position } from '../core/world-state'
export interface FlightGate { id: string; center: Position; normal: Position; radius: number }
export interface GateCrossing { id: string; point: Position; error: number; fraction: number }
const dot = (a: Position, b: Position) => a.x * b.x + a.y * b.y + a.z * b.z
const subtract = (a: Position, b: Position): Position => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const offset = (point: Position, normal: Position, scale: number): Position => ({ x: point.x + normal.x * scale, y: point.y + normal.y * scale, z: point.z + normal.z * scale })
export function validateFlightGate(gate: FlightGate): FlightGate {
  if (!gate.id || !Number.isFinite(gate.radius) || gate.radius <= .5 || gate.radius > 20
    || ![...Object.values(gate.center), ...Object.values(gate.normal)].every(Number.isFinite)) throw new Error('Invalid flight gate')
  const length = Math.hypot(gate.normal.x, gate.normal.y, gate.normal.z)
  if (length < .001) throw new Error('Flight gate needs a plane normal')
  return { ...gate, normal: { x: gate.normal.x / length, y: gate.normal.y / length, z: gate.normal.z / length } }
}
export function crossFlightGate(gate: FlightGate, from: Position, to: Position, margin = .35): GateCrossing | null {
  const before = dot(subtract(from, gate.center), gate.normal)
  const after = dot(subtract(to, gate.center), gate.normal)
  if (before >= 0 || after < 0 || Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) > 12) return null
  const fraction = -before / (after - before)
  const point = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction, z: from.z + (to.z - from.z) * fraction }
  const error = Math.hypot(point.x - gate.center.x, point.y - gate.center.y, point.z - gate.center.z)
  return error <= gate.radius - margin ? { id: gate.id, point, error, fraction } : null
}
export class FlightRouteGraph {
  readonly gates: FlightGate[]
  readonly crossings: GateCrossing[] = []
  private previous: Position | null = null
  private stage: 'approach' | 'cross' = 'cross'
  constructor(gates: FlightGate[]) {
    if (!gates.length || gates.length > 64 || new Set(gates.map(g => g.id)).size !== gates.length) throw new Error('Flight route needs unique ordered gates')
    this.gates = gates.map(validateFlightGate)
  }
  get index(): number { return this.crossings.length }
  get complete(): boolean { return this.index === this.gates.length }
  observe(point: Position): GateCrossing | null {
    const gate = this.gates[this.index]
    const crossing = gate && this.previous ? crossFlightGate(gate, this.previous, point) : null
    this.previous = { ...point }
    if (crossing) { this.crossings.push(crossing); this.stage = 'cross'; return crossing }
    if (gate) {
      const distance = dot(subtract(point, gate.center), gate.normal)
      if (distance > 0) this.stage = 'approach'
      if (distance < -3) this.stage = 'cross'
    }
    return null
  }
  target(): Position | null {
    const gate = this.gates[this.index]
    return gate ? offset(gate.center, gate.normal, this.stage === 'approach' ? -6 : 3) : null
  }
}

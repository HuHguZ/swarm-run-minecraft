import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FlightRouteGraph, crossFlightGate, type FlightGate } from '../src/combat/flight-route-graph'
const gate: FlightGate = { id: 'turn', center: { x: 10, y: 20, z: 30 }, normal: { x: 1, y: 0, z: 0 }, radius: 4 }
test('flight gate measures the actual directed segment-plane crossing', () => {
  const crossing = crossFlightGate(gate, { x: 7, y: 21, z: 30 }, { x: 13, y: 21, z: 30 })!
  assert.equal(crossing.error, 1)
  assert.deepEqual(crossing.point, { x: 10, y: 21, z: 30 })
  assert.equal(crossFlightGate(gate, { x: 13, y: 20, z: 30 }, { x: 7, y: 20, z: 30 }), null)
  assert.equal(crossFlightGate(gate, { x: 7, y: 25, z: 30 }, { x: 13, y: 25, z: 30 }), null)
  assert.equal(crossFlightGate(gate, { x: -100, y: 20, z: 30 }, { x: 100, y: 20, z: 30 }), null)
})
test('future gates and nearby arrivals never replace sequential crossing; a miss returns behind the plane', () => {
  const graph = new FlightRouteGraph([gate, { ...gate, id: 'land', center: { x: 16, y: 20, z: 30 } }])
  graph.observe({ x: 9, y: 25, z: 30 })
  graph.observe({ x: 11, y: 25, z: 30 })
  assert.equal(graph.index, 0)
  assert.equal(graph.target()!.x, 4)
  graph.observe({ x: 6, y: 20, z: 30 })
  graph.observe({ x: 12, y: 20, z: 30 })
  assert.equal(graph.index, 1)
  graph.observe({ x: 18, y: 20, z: 30 })
  assert.equal(graph.complete, true)
})

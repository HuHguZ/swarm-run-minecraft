import test from 'node:test'
import assert from 'node:assert/strict'
import { flightCourse } from '../try-flight-route'
import { FlightRouteGraph } from '../src/combat/flight-route-graph'

test('flight course has isolated grounded pads and twelve ordered physical ring gates', () => {
  const course = flightCourse({ min: 65, max: 80 })
  assert.equal(course.launch.y, 83)
  assert.equal(course.landing.y, 83)
  assert.equal(course.gates.length, 12)
  assert.ok(course.gates.every(gate => gate.center.x >= 3700 && gate.center.y > course.launch.y + 5))
  assert.ok(course.commands.includes('fill 3695 64 3395 3705 82 3405 minecraft:stone'))
  assert.ok(course.commands.some(command => command.endsWith('minecraft:cyan_concrete')))
  const graph = new FlightRouteGraph(course.gates)
  for (const gate of course.gates) {
    graph.observe({ x: gate.center.x - gate.normal.x, y: gate.center.y, z: gate.center.z - gate.normal.z })
    graph.observe({ x: gate.center.x + gate.normal.x, y: gate.center.y, z: gate.center.z + gate.normal.z })
  }
  assert.equal(graph.complete, true)
  assert.deepEqual(graph.crossings.map(gate => gate.id), course.gates.map(gate => gate.id))
})

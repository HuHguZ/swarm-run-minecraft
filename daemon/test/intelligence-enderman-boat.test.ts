import test from 'node:test'
import assert from 'node:assert/strict'
import { PassengerWitness, runBoatTrap, type BoatTrapPort } from '../src/combat/enderman-boat-graph'

function fixture(captureAt: number, releaseAt = Infinity) {
  let now = 0
  let swings = 0
  let dead = false
  let cleaned = false
  const witness = new PassengerWitness()
  const attacks: number[] = []
  const port: BoatTrapPort = { now: () => now, available: () => true, craftable: () => false,
    craft: async () => false, place: async () => 41, safe: () => true, targetValid: () => !dead,
    captured: boat => witness.has(boat, 7), dead: () => dead,
    async sleep(ms) { now += ms; if (now >= captureAt) witness.record(41, now >= releaseAt ? [] : [7]) },
    lure: async () => {},
    async attack() { attacks.push(now); assert.equal(witness.has(41, 7), true); swings++; if (swings >= 3) dead = true; return true },
    async cleanup() { cleaned = true }
  }
  return { port, attacks, witness, cleaned: () => cleaned }
}
test('boat trap waits for server passengers before any attack and verifies actual death', async () => {
  const f = fixture(150)
  const result = await runBoatTrap(f.port, { captureMs: 1000, killMs: 1000 })
  assert.deepEqual(result.path, ['CheckBoat', 'PlaceBoat', 'LureEnderman', 'Captured', 'KillCaptured', 'Done'])
  assert.equal(result.captured, true)
  assert.equal(result.killed, true)
  assert.equal(result.swings, 3)
  assert.ok(f.attacks.every(time => time >= 150))
  assert.equal(f.cleaned(), true)
})
test('missing capture times out; real dismount invalidates stale vehicle data and stops attacking', async () => {
  const missing = fixture(Infinity)
  const fail = await runBoatTrap(missing.port, { captureMs: 200, killMs: 1000 })
  assert.equal(fail.killed, false)
  assert.equal(fail.path.at(-1), 'Fallback')
  assert.deepEqual(missing.attacks, [])
  assert.equal(missing.cleaned(), true)
  const escaped = fixture(50, 100)
  const lost = await runBoatTrap(escaped.port, { captureMs: 1000, killMs: 1000 })
  assert.equal(lost.captured, true)
  assert.equal(lost.killed, false)
  assert.equal(lost.why, 'passenger escaped')
  assert.deepEqual(escaped.attacks, [50])
  assert.equal(escaped.witness.has(41, 7), false)
})

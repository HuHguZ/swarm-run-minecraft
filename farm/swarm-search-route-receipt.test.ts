import assert from 'node:assert/strict'
import test from 'node:test'
import { createSwarmDriver } from './swarm/swarm-driver'

function hunter(reply) {
  let time = 1000
  const origin = { x: 0, y: 120, z: 0 }, clue = { x: 26, y: 120, z: 0 }
  const goals: Array<typeof origin> = []
  const frame = { p: { ...origin }, hp: 20, inv: { iron_sword: 1 }, armor: { torso: 'iron_chestplate' } }
  const b = { name: 'Hunter', team: 'blue', c: { async call(method, params) {
    if (method !== 'goto') return { status: 'done', detail: {} }
    const at = { x: params.x, y: params.y, z: params.z }
    goals.push(at)
    return reply(at, frame, clue)
  } } }
  const driver = createSwarmDriver({ bots: [b], pos: { Hunter: frame }, now: () => time, alive: () => true,
    arena: { x: 0, y: 120, z: 0, r: 60 }, home: () => origin, hostile: (_, id) => id === 'Foe', log() {} })
  function seeAndLose() {
    driver.observe(b, [{ id: 'Foe', visible: true, position: clue }])
    time += 9000
  }
  async function step() { time += 1000; driver.observe(b, []); await driver.turn(b) }
  return { goals, clue, frame, seeAndLose, step }
}

test('after a terminal no-path receipt a hunter sweeps from the rejected approach until there is fresh evidence', async () => {
  const f = hunter((at, frame, clue) => at.x === clue.x
    ? { status: 'failed', code: 'NO_PATH', state: { pos: { ...frame.p } } }
    : { status: 'interrupted' })
  f.seeAndLose()
  await f.step(); await f.step(); await f.step()
  assert.deepEqual(f.goals[0], f.clue)
  assert.equal(f.goals.filter(p => p.x === f.clue.x).length, 1)
  assert.equal(f.goals.length, 3, 'both remaining turns actually scout other ground')
  f.seeAndLose()
  await f.step()
  assert.deepEqual(f.goals.at(-1), f.clue, 'a new sighting at this location reopens the approach')
  f.frame.p.x += 3
  await f.step()
  assert.deepEqual(f.goals.at(-1), f.clue, 'a new starting position can reach a previously blocked route')
})

test('a preemption, transient load, or an incomplete but advancing route does not condemn the clue', async () => {
  for (const mode of ['not started', 'rpc', 'timeout', 'moved']) {
    const f = hunter((_at, frame) => {
      if (mode === 'rpc') throw Error('socket reset')
      if (mode === 'timeout') return { status: 'timeout', state: { pos: frame.p } }
      if (mode === 'not started') return { status: 'failed', code: 'DEFENSE_BUSY', notStarted: true, state: { pos: frame.p } }
      return { status: 'failed', code: 'NO_PATH', state: { pos: { ...frame.p, x: frame.p.x + 4 } } }
    })
    f.seeAndLose(); await f.step(); await f.step()
    assert.deepEqual(f.goals, [f.clue, f.clue], mode)
  }
})

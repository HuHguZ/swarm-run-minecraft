import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'

function scenario(gap: number, inventory: Record<string, number>, equipped = false, cornered = false,
  shove: { edge?: { x: number; z: number; at: number; drop: number; lava?: boolean }; enchanted?: boolean } = {}) {
  const calls: any[] = []
  let now = 1000
  const b: any = { name: 'A', team: 'blue', c: { async call(method, params) {
    calls.push({ method, params })
    return { status: 'done', detail: { ok: true, cornered } }
  } } }
  const armor = equipped ? { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' } : { torso: 'diamond_chestplate' }
  const pos = { A: { p: { x: gap, y: 64, z: 0 }, hp: 20, inv: inventory, armor } }
  const perch = { x: 24, y: 76, z: 0 }
  const driver = createSwarmDriver({ bots: [b], pos, alive: () => true, aggressive: true,
    now: () => now, arena: { x: 0, y: 64, z: 0, r: 80 }, perches: [perch],
    home: () => pos.A.p, hostile: () => true, edgeOf: () => shove.edge || null, log() {} })
  const observation: any = { id: 'Human', visible: true, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    equipment: { weapon: 'netherite_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: shove.enchanted ?? true } }
  Object.defineProperty(observation, 'health', { get() { throw Error('hidden player HP') } })
  driver.observe(b, [observation])
  return { calls, b, driver, perch, pos, observation, observe: () => { now += 500; driver.observe(b, [observation]) } }
}

test('one chestplate and no weapon do not turn a stationary nearby human into a voluntary fist fight', async () => {
  for (const gap of [3, 4.5, 5]) {
    const f = scenario(gap, { elytra: 1, firework_rocket: 16 })
    await f.driver.turn(f.b)
    assert.equal(f.b.swarmTask.kind, 'flee', `${gap} blocks: equipment risk still applies`)
    assert.deepEqual(f.calls.find(c => c.method === 'fly_to')?.params.at, f.perch)
    assert.equal(f.calls.some(c => c.method === 'fight'), false)
  }
})

test('without a perch the unarmed body checks escape before a physically cornered last stand', async () => {
  for (const cornered of [false, true]) {
    const f = scenario(3, {}, false, cornered)
    await f.driver.turn(f.b)
    assert.deepEqual(f.calls.map(c => c.method), cornered ? ['flee', 'fight'] : ['flee'])
    if (cornered) assert.equal(f.calls[1].params.lastStand, true)
  }
})

test('a capable armed fighter still attacks the same stationary human nearby', async () => {
  for (const gap of [3, 4.5, 5]) {
    const f = scenario(gap, { netherite_sword: 1 }, true)
    await f.driver.turn(f.b)
    assert.equal(f.b.swarmTask.kind, 'fight')
    assert.ok(f.calls.some(c => c.method === 'fight'))
    assert.equal(f.calls.some(c => c.method === 'flee' || c.method === 'fly_to'), false)
  }
})

test('a previous fight does not trap a newly unarmed fighter inside the old six-block boundary', async () => {
  const f = scenario(4.5, { netherite_sword: 1 }, true)
  await f.driver.turn(f.b)
  assert.equal(f.b.swarmTask.kind, 'fight')
  f.calls.length = 0
  Object.assign(f.pos.A, { inv: { elytra: 1, firework_rocket: 16 }, armor: { torso: 'diamond_chestplate' } })
  f.observe()
  await f.driver.turn(f.b)
  assert.equal(f.b.swarmTask.kind, 'flee')
  assert.equal(f.calls.some(c => c.method === 'fight'), false)
})

test('an unarmed fighter does not buy a two-hit lava shove with less survival time than its work', async () => {
  const f = scenario(4.5, { elytra: 1, firework_rocket: 16 }, false, false,
    { edge: { x: 1, z: 0, at: 2.9, drop: Infinity, lava: true }, enchanted: false })
  await f.driver.turn(f.b)
  assert.equal(f.b.swarmTask.kind, 'flee', 'a useful-looking hazard cannot override the available safe retreat')
  assert.deepEqual(f.calls.find(c => c.method === 'fly_to')?.params.at, f.perch)
  assert.equal(f.calls.some(c => c.method === 'fight'), false)
})

test('wind charges do not buy a losing melee shove when the ranged plan cannot fire', async () => {
  for (const wind of [1, 2, 32]) {
    const f = scenario(-2.5, { bow: 1, arrow: 64, wind_charge: wind, elytra: 1, firework_rocket: 16 }, false, false,
      { edge: { x: 1, z: 0, at: 10, drop: Infinity } })
    await f.driver.turn(f.b)
    assert.equal(f.b.swarmTask.kind, 'flee', `${wind} charges do not shorten a multi-hit melee chain`)
    assert.deepEqual(f.calls.find(c => c.method === 'fly_to')?.params.at, f.perch)
    assert.equal(f.calls.some(c => c.method === 'fight'), false, 'a refused wind push must not fall through to fists')
  }
})

test('a held shove is repriced after visible protection and incoming damage worsen the trade', async () => {
  const f = scenario(4.5, { elytra: 1, firework_rocket: 16 }, true, false,
    { edge: { x: 1, z: 0, at: 2.9, drop: Infinity, lava: true }, enchanted: false })
  await f.driver.turn(f.b)
  assert.equal(f.b.swarmTask.kind, 'fight')
  assert.equal(f.b.swarmTask.data.shove, true)
  f.calls.length = 0
  f.observation.equipment.enchanted = true; f.observe()
  await f.driver.turn(f.b)
  assert.equal(f.b.swarmTask.kind, 'flee', 'the old shove token is not an unlimited exemption from rearming')
  assert.equal(f.calls.some(c => c.method === 'fight'), false)
})

test('an unarmed fighter keeps a reachable one-hit void shove that wins before the response', async () => {
  for (const wind of [0, 32]) {
    const f = scenario(-2.5, { elytra: 1, firework_rocket: 16, wind_charge: wind }, false, false,
      { edge: { x: 1, z: 0, at: .1, drop: Infinity } })
    await f.driver.turn(f.b)
    assert.equal(f.b.swarmTask.kind, 'fight')
    assert.equal(f.b.swarmTask.data.shove, true)
    assert.equal(f.calls.some(c => c.method === 'flee' || c.method === 'fly_to'), false)
  }
})

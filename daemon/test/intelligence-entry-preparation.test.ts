import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareOverworldEntry, confirmSurvivalReadiness, cleanupPreparationThreats, type SurvivalSample } from '../scene-nether-entry'

function fixture() {
  const portal = { x: -2, y: 71, z: 8, dimension: 'overworld', axis: 'x', inner: { x: -1, y: 70, z: 10 }, lit: true }
  const state = { dimension: 'the_nether', pos: { x: 2.6, y: 69, z: 4.5 } }
  let floor: string | null = 'stone'
  let wall = 0
  let loaded = true
  let adopted = { ...portal }
  const events: string[] = []
  const port = {
    async call(method: string): Promise<unknown> {
      events.push(method)
      if (method === 'recall') return { detail: { state: { places: { портал: portal } } } }
      if (method === 'portal') { assert.equal(state.dimension, 'overworld'); assert.equal(loaded, true); return { detail: { lit: true, place: adopted } } }
      if (method === 'observe') return { detail: { terrain: { standingOn: loaded ? floor : null }, blocks: loaded ? [{ name: 'nether_portal', count: 6 }] : [] } }
      return {}
    },
    async creative() { events.push('creative') },
    async returnToOverworld(point: { x: number; y: number; z: number }) {
      assert.ok(events.includes('creative'))
      state.dimension = 'overworld'; state.pos = point; events.push('return to safe stand')
    },
    async state() { return state },
    now: () => wall,
    async sleep() { wall += 100 }
  }
  return { port, state, events, setLoaded(value: boolean) { loaded = value }, setFloor(value: string | null) { floor = value }, setAdopted(value: typeof portal) { adopted = value } }
}

test('an accidental preparation portal transfer returns to the observed safe overworld stand before measuring entry', async () => {
  const f = fixture()
  assert.equal(f.state.dimension, 'the_nether')
  const safe = await prepareOverworldEntry(f.port)
  assert.deepEqual(safe, { x: -1.5, y: 71, z: 8.5 })
  assert.equal(f.state.dimension, 'overworld')
  assert.equal(f.events.includes('portal'), true, 'native stand geometry is rechecked after return')
  assert.equal(f.events.filter(event => event === 'return to safe stand').length, 2)
})

test('dimension acknowledgement alone cannot start portal adoption before the returned position and native blocks load', async () => {
  const f = fixture()
  const move = f.port.returnToOverworld
  let sleeps = 0
  let destination = { x: 0, y: 0, z: 0 }
  f.port.returnToOverworld = async point => {
    destination = point
    await move(point)
    if (sleeps === 0) {
      f.state.pos = { x: 2.6, y: 69, z: 4.5 }
      f.setLoaded(false)
    }
  }
  const sleep = f.port.sleep
  f.port.sleep = async () => {
    await sleep()
    sleeps++
    if (sleeps === 1) f.state.pos = destination
    if (sleeps === 3) f.setLoaded(true)
  }
  await prepareOverworldEntry(f.port)
  assert.equal(sleeps, 3)
  assert.ok(f.events.indexOf('observe') < f.events.indexOf('portal'))
})

test('an absent native lit portal times out with observed geometry instead of trusting its old memory', async () => {
  const f = fixture()
  const call = f.port.call
  f.port.call = async method => method === 'observe' ? { detail: { terrain: { standingOn: 'stone' }, blocks: [] } } : call(method)
  await assert.rejects(prepareOverworldEntry(f.port), /горящий портал.*не подтверждён.*stone/)
  assert.equal(f.events.includes('portal'), false, 'an unloaded or extinguished remembered portal must not start a speculative new frame')
})

test('preparation cleanup is restricted to actual native hostile receipts within16 of the OW entrance', async () => {
  const commands: string[] = []
  const receipts = await cleanupPreparationThreats({ x: 6.5, y: 70, z: -.5 }, async text => {
    commands.push(text)
    return text.includes('type=minecraft:zombie,') ? 'Killed 2 entities' : 'No entity was found'
  })
  assert.equal(receipts.zombie, 'Killed 2 entities')
  assert.ok(commands.every(text => text.startsWith('execute in minecraft:overworld positioned 6.5 70 -0.5 run kill ') && text.endsWith(',distance=..16]')))
  assert.ok(commands.every(text => !/the_nether|player|piglin|hoglin|item,|type=!/.test(text)))
  await assert.rejects(cleanupPreparationThreats({ x: 6.5, y: 70, z: -.5 }, async () => 'Unknown command'), /не подтверждена/)
})

test('a lit portal cell cannot replace the preparation stand and an unloaded or hazardous floor blocks measurement', async () => {
  const touching = fixture()
  touching.setAdopted({ x: -1, y: 70, z: 10, dimension: 'overworld', axis: 'x', inner: { x: -1, y: 70, z: 10 }, lit: true })
  await assert.rejects(prepareOverworldEntry(touching.port), /касается клеток портала/)
  for (const floor of [null, 'air', 'lava', 'magma_block', 'campfire']) {
    const f = fixture(); f.setFloor(floor)
    await assert.rejects(prepareOverworldEntry(f.port), /пол не подтверждён/)
  }
})

test('Survival preparation waits for native ticks after healing and verifies full health after effects are cleared', async () => {
  let ticks = 0, wall = 0, heals = 0, clears = 0
  let health = 19.75
  const clearTicks: number[] = []
  const result = await confirmSurvivalReadiness({
    sample: async () => ({ dimension: 'overworld', health, food: 20, serverTicks: ticks, safe: true }),
    now: () => wall,
    sleep: async () => { wall += 25; ticks += 5 },
    heal: async () => { heals++; health = 20 },
    clearEffects: async () => { clearTicks.push(ticks); clears++; if (clears === 1) health = 19 }
  })
  assert.equal(heals, 2, 'a post-clear native HP decrease cannot be hidden by the rounded header or the earlier heal')
  assert.equal(clears, 2)
  assert.ok(clearTicks[0] >= 20, 'instant healing cannot be cleared before actual server ticks apply it')
  assert.ok(result.serverTicks! - clearTicks[1] >= 20)
  assert.equal(result.health, 20)
})

test('no tick acknowledgement, a real active threat, or health rounded up from below20 cannot start measurement', async () => {
  for (const change of [{ serverTicks: null }, { safe: false }, { health: 19.75 }]) {
    let ticks = 0, wall = 0
    await assert.rejects(confirmSurvivalReadiness({
      sample: async (): Promise<SurvivalSample> => ({ dimension: 'overworld', health: 20, food: 20, serverTicks: ticks, safe: true, ...change }),
      now: () => wall,
      sleep: async () => { wall += 1000; ticks += 20 },
      heal: async () => {}, clearEffects: async () => {}
    }), /не подтверждены|не подтверждено/)
  }
})

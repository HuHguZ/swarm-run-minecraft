import assert from 'node:assert/strict'
import test from 'node:test'
import { SwarmBoard, planPvp, type SwarmMember } from '../daemon/src/swarm'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'

function scene(shield?: 'aligned' | 'step', workingBlocks = true) {
  let time = 1000
  const at = (x, z = 0) => ({ x, y: 64, z }), calls = []
  const archer = at(20), ward = { name: 'Ward', team: 'blue', arrowThreat: { active: true, at: time,
    ward: at(0), bows: [{ name: 'Archer', at: archer }] } }
  const helper: any = { name: 'Builder', team: 'blue', c: { async call(method, params) {
    calls.push({ method, params }); return { status: 'done', detail: {} }
  } } }
  const fighter = { name: 'Knight', team: 'blue' }, armor = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
  const members: SwarmMember[] = [
    { id: helper.name, team: 'blue', position: at(0, 1), health: 20, strength: 45, role: 'fighter', armor, inventory: { stone: 2 } },
    { id: ward.name, team: 'blue', position: at(0), health: 6, strength: 20, role: 'fighter', armor, inventory: { bread: 1 }, bowAims: ward.arrowThreat.bows },
    { id: fighter.name, team: 'blue', position: at(-3), health: 20, strength: 75, role: 'fighter', armor, inventory: { diamond_sword: 1 } }
  ]
  if (shield) {
    Object.assign(members[0], { offHand: 'shield', inventory: {}, position: at(1, shield === 'step' ? 1 : 0) })
    Object.assign(members[1], { health: 20, workingBlocks })
  }
  const board = new SwarmBoard('blue', () => time)
  board.setMembers(members)
  board.observe(ward.name, time, { visible: true, id: 'Archer', position: archer, equipment: { weapon: 'bow', armor: [] } })
  const task = planPvp(board, members, { doctrine: 'hunt' }).get(helper.name)!
  if (!shield) assert.equal(task.data.coverWall, true)
  const pos = Object.fromEntries(members.map(m => [m.id, { p: m.position, hp: m.health, inv: m.inventory, offHand: m.offHand }]))
  const context = { board, members, member: members[0], task }
  const sw: any = { pos, generation: 1, now: () => time, alive: () => true, log() {}, refresh: () => context,
    bots: [helper, ward, fighter], teamOf: b => b.team, arena: { x: 0, y: 64, z: 0, r: 32 }, placed: new Map(),
    say() {}, detail: r => r.detail, onslaught: () => false, chestSafe: () => true, chestAtHand: () => true,
    loot: async () => { calls.push({ method: 'loot' }); return true }, transfer: () => false, cacheTurn: () => false,
    positionStep: async () => { calls.push({ method: 'perch' }); return true } }
  Object.assign(sw, swarmTurnWork(sw))
  return { driver: swarmTurn(sw), sw, context, helper, ward, calls, advance: ms => { time += ms } }
}

test('a local wall assignment reaches the real assist before nearby loot or a sniper position without a weapon', async () => {
  const f = scene()
  await f.driver.turn(f.helper)
  assert.deepEqual(f.calls.map(c => [c.method, c.params?.mode, c.params?.ally, c.params?.foe]), [['assist', 'wall', 'Ward', 'Archer']])
  await f.driver.turn(f.helper)
  assert.equal(f.calls.length, 1)
})

for (const stance of ['aligned', 'step'] as const) test(`shield protects a healthy working ally before looting: ${stance}`, async () => {
  const f = scene(stance), b = f.helper
  assert.equal(f.context.task.data.coverShield, true)
  assert.equal(f.context.task.data.cover, 'Ward')
  b.swarmTask = { kind: 'fight', data: { target: 'Archer' } }
  b.swarmExecuting = true; b.last = { m: 'goto', p: { x: 20, y: 64, z: 0 }, pending: true }
  assert.equal(f.driver.preempt(b), true)
  assert.equal(f.driver.preempt(b), false)
  b.last.pending = false; b.swarmExecuting = false
  await f.driver.turn(b)
  assert.deepEqual(f.calls.map(c => c.method), ['stop', 'swarm_hold'])
  assert.equal(f.calls[1].params.coverAlly, 'Ward')
  assert.equal(f.calls[1].params.whileDraw, 'Archer')
  assert.equal(!!f.calls[1].params.stepIntoLane, stance === 'step')
})

test('a healthy teammate with free hands does not request a work escort', () => {
  const f = scene('aligned', false)
  assert.equal(f.context.task.data.cover, undefined)
})

test('a cached shield order preserves the current walk after the worker steps out of the reported lane', () => {
  const f = scene('aligned'), b = f.helper
  b.swarmTask = { kind: 'fight', data: { target: 'Archer' } }
  b.swarmExecuting = true; b.last = { m: 'goto', p: { x: 20, y: 64, z: 0 }, pending: true }
  f.sw.pos.Ward.p = { x: 0, y: 64, z: 1 }
  assert.equal(f.driver.preempt(b), false)
  assert.deepEqual(f.calls, [])
})

for (const status of ['walk', 'active chest', 'active flight from danger', 'emergency', 'stale draw', 'ward moved', 'melee arrived']) {
  test(`a local wall assignment can replace an earlier approach to the same archer: ${status}`, async () => {
    const f = scene(), b = f.helper
    b.swarmTask = { kind: 'fight', data: { target: 'Archer' } }
    b.swarmExecuting = true
    b.last = status === 'active chest' ? { m: 'chest_take', p: { stay: true }, pending: true } :
      status === 'active flight from danger' ? { m: 'flee', pending: true } : { m: 'goto', p: { x: 20, y: 64, z: 0 }, pending: true }
    if (status === 'emergency') f.sw.pos.Builder.tactics = { owner: 'Emergency' }
    if (status === 'stale draw') f.advance(2000)
    if (status === 'ward moved') f.sw.pos.Ward.p = { x: 5, y: 64, z: 0 }
    if (status === 'melee arrived') f.context.board.observe('Builder', 1000, { id: 'Swordsman', visible: true, position: { x: .5, y: 64, z: 2 } })
    assert.equal(f.driver.preempt(b), status === 'walk')
    if (status !== 'walk') { assert.deepEqual(f.calls, []); return }
    assert.equal(f.driver.preempt(b), false, 'one stop for this handover')
    b.last.pending = false; b.swarmExecuting = false
    await f.driver.turn(b)
    assert.deepEqual(f.calls.map(c => c.method), ['stop', 'assist'])
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../daemon/src/swarm'
import { swarmTurn } from './swarm/swarm-driver/turn'

for (const recovers of [false, true]) test('assigned healer checks team reports after the approach, recovery=' + recovers, async () => {
  const now = () => 10000, board = new SwarmBoard('blue', now)
  const members: SwarmMember[] = ['medic', 'patient', 'friend', 'stale'].map((id, i) => ({
    id, role: i ? 'fighter' : 'healer', canHeal: !i, team: 'blue', position: { x: i ? 8 : 0, y: 64, z: 0 },
    health: [20, 6, 11, 15][i], strength: 50, inventory: i ? {} : { splash_potion: 1 }
  }))
  board.setMembers(members)
  const task = planPvp(board, members, { doctrine: 'ring' }).get('medic')!
  assert.equal(task.kind, 'heal')
  const pos = Object.fromEntries(members.map(m => [m.id, { p: m.position, hp: m.health, tick: 200, clockId: m.id, hpAskedAt: now(), observedAt: now(), frameAt: now() }]))
  pos.stale.hpAskedAt -= 2000
  const calls = []
  const b = { name: 'medic', c: { async call(method, params) { calls.push({ method, params }) } } }
  const sw: any = { now, pos, generation: 1, alive: () => true, log() {}, say() {}, onslaught: () => true,
    chestAtHand: () => true, loot: () => assert.fail('looting delayed patient care'), grab: () => assert.fail('pickup delayed patient care'),
    refresh: () => ({ board, member: members[0], members, task }), go: async () => {
      calls.push({ method: 'approach' })
      pos.medic.p = pos.patient.p
      pos.patient.hp = recovers ? 20 : 8
    } }
  await swarmTurn(sw).turn(b)
  assert.deepEqual(calls.map(c => c.method), recovers ? ['approach'] : ['approach', 'assist'])
  if (!recovers) assert.deepEqual(calls[1].params, { mode: 'heal', ally: 'patient', clockId: 'medic', reports: {
    patient: { hp: 8, untilTick: 220 }, friend: { hp: 11, untilTick: 220 } } })
})

for (const danger of ['weak', 'champion', 'unreported', 'new round', 'rescue']) test('a blocked medic changes action and can resume care: ' + danger, async () => {
  let time = 10000, blocked = true
  const now = () => time, board = new SwarmBoard('blue', now)
  const members: SwarmMember[] = ['medic', 'patient', 'friend'].map((id, i) => ({
    id, role: i ? 'fighter' : 'healer', team: 'blue', canHeal: !i, position: { x: i ? 3 : 0, y: 64, z: 0 },
    health: i === 1 ? 6 : 20, strength: 40, inventory: i ? {} : danger === 'champion' ? { splash_potion: 1 } : { iron_sword: 1, splash_potion: 1 }
  }))
  board.setMembers(members)
  const task = planPvp(board, members, { doctrine: 'ring' }).get('medic')!
  assert.equal(task.kind, 'heal')
  const pos = Object.fromEntries(members.map(m => [m.id, { p: m.position, hp: m.health, inv: m.inventory,
    tick: 200, clockId: 17, frameAt: time, hpAskedAt: time, observedAt: time }]))
  const observe = z => board.observe('medic', now(), { id: 'Red', position: { x: 0, y: 64, z }, visible: true,
    equipment: danger === 'champion' ? { weapon: 'netherite_sword', weaponEnchanted: true, armor: ['netherite_chestplate'] } : { weapon: 'stick' } })
  const actions = [], b = { name: 'medic', c: { async call(method, params) {
    actions.push(method)
    if (method !== 'assist') { assert.equal(params.target || params.from[0], 'Red'); return { status: 'done' } }
    if (danger === 'new round') sw.generation++
    if (danger === 'rescue') pos.medic['rescuing'] = true
    if (danger !== 'unreported') observe(blocked ? 2.5 : 15)
    return { status: 'done', detail: blocked ? { ok: false, why: 'enemy_at_launch', threat: 'Red' } : { ok: true } }
  } } }
  const sw: any = { now, board, pos, generation: 1, alive: () => true, say() {}, log() {}, onslaught: () => true,
    chestAtHand: () => false, detail: r => r.detail, arena: { x: 0, y: 64, z: 0, r: 32 },
    refresh: () => ({ board, member: members[0], members, task }) }
  const driver = swarmTurn(sw), response = danger === 'weak' ? 'fight' : 'flee'
  await driver.turn(b)
  if (danger === 'new round' || danger === 'rescue') { assert.deepEqual(actions, ['assist']); return }
  assert.deepEqual(actions, ['assist', response])
  if (danger === 'unreported') return
  time += 200; observe(2.5); await driver.turn(b)
  assert.deepEqual(actions, ['assist', response, response], 'unchanged personal sight must not repeat a refused throw')
  time += 200; blocked = false; observe(15); await driver.turn(b)
  assert.deepEqual(actions, ['assist', response, response, 'assist'])
})

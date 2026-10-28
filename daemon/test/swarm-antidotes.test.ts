import test from 'node:test'
import assert from 'node:assert/strict'
import { antidoteExchange, antidoteTransferValue, pvpAntidotes } from '../src/swarm/antidotes'
import { SwarmBoard } from '../src/swarm/board'
import { planPvp } from '../src/swarm/plan-pvp'

const p = (x = 0, z = 0) => ({ x, y: 64, z })
function member(id: string, items: any = {}, bad = true): any {
  return { id, team: 'blue', health: 20, strength: 20, role: 'fighter', weapon: 'diamond_sword', position: p(), inventory: items,
    antidote: { receivedAt: 10000, using: false, state: { health: 20, effects: bad ? [{ name: 'poison', amplifier: 1, remainingTicks: 600 }] : [],
      inventory: { honey_bottle: items.honey_bottle || 0, milk_bucket: items.milk_bucket || 0 }, damagePerTick: .04 } } }
}
function frame(team: any[], enemies: any[] = [], plan = new Map()): any {
  return { team, enemies, plan, board: { now: () => 10000 }, put(m, kind, data, at) {
    plan.set(m.id, { id: 'pvp:' + m.id, kind, data, position: at, assignedTo: m.id })
  } }
}
const foe = () => Object.defineProperty({ id: 'enemy', position: p(8), seenAt: 10000, sources: ['R'], equipment: { weapon: 'iron_sword' } }, 'health', {
  get() { throw Error('enemy exact HP leak') }
})

test('aged reports use driver receipt wall time and never freshen unknown duration', () => {
  const m = member('R', { honey_bottle: 1 })
  assert.ok(antidoteExchange(m, 10000, []).choice)
  assert.equal(antidoteExchange(m, 40000, []).choice, null)
  m.antidote.state.effects[0].remainingTicks = null
  assert.equal(antidoteExchange(m, 10000, ['honey_bottle']).need, null)
  assert.equal(antidoteExchange(m, 9999, ['honey_bottle']).choice, null)
})

test('last useful own dose is reserved even for a forager with zero generic reserve', () => {
  const m = member('D', { honey_bottle: 1 }); m.reserve = { honey_bottle: 0 }
  const x = antidoteExchange(m, 10000, ['honey_bottle'])
  assert.equal(x.reserve.honey_bottle, 1); assert.equal(x.needs.honey_bottle, 1)
  assert.equal(antidoteTransferValue(m, member('R'), 'honey_bottle', 10000, 40), 0)
})

test('requests name one real team-stock item; no stock or an owned usable dose needs no transfer', () => {
  const r = member('R')
  assert.equal(antidoteExchange(r, 10000, []).need, null)
  const x = antidoteExchange(r, 10000, ['honey_bottle'])
  assert.equal(x.need?.item, 'honey_bottle'); assert.deepEqual(x.needs, { honey_bottle: 1 })
  const d = member('D', { honey_bottle: 2 }, false)
  assert.ok(antidoteTransferValue(d, r, 'honey_bottle', 10000, 40) > 0)
  r.inventory.honey_bottle = 1
  assert.equal(antidoteTransferValue(d, r, 'honey_bottle', 10000, 40), 0)
})

test('transfer charges donor travel opportunity once, while pickup wait permits donor to resume', () => {
  const d = member('D', { honey_bottle: 2 }, false), r = member('R')
  d.antidote.state.damagePerTick = 100
  assert.ok(antidoteTransferValue(d, r, 'honey_bottle', 10000, 40) > 0)
  assert.equal(antidoteTransferValue(d, r, 'honey_bottle', 10000, 50), 0)
  assert.equal(antidoteTransferValue(d, r, 'honey_bottle', 10000, 40, 1), 0)
})

test('own cleanse gets recover plus a nearby shield cover without a healthy-HP threshold', () => {
  const r = member('R', { honey_bottle: 1 }), c = member('C', { shield: 1 }, false); c.position = p(1)
  const S = frame([r, c], [foe()]); pvpAntidotes(S)
  assert.equal(S.plan.get('R')?.kind, 'recover'); assert.equal(S.plan.get('R')?.data.antidote.item, 'honey_bottle')
  assert.equal(S.plan.get('R')?.data.antidote.cover, 'C')
  assert.equal(S.plan.get('C')?.data.hold, 'shield'); assert.equal(S.plan.get('C')?.data.antidoteCover, 'R')
  assert.equal(S.plan.get('C')?.data.target, 'enemy'); assert.equal(S.plan.get('C')?.data.range, .6)
  assert.deepEqual(S.plan.get('C')?.data.face, p(8))
})

test('physical panic/flee is preserved and lack of shield does not forbid a positive own cleanse', () => {
  const r = member('R', { honey_bottle: 1 }), c = member('C', { shield: 1 }, false)
  const plan = new Map([['C', { kind: 'flee', data: { panic: true } }]])
  const S = frame([r, c], [foe()], plan); pvpAntidotes(S)
  assert.equal(plan.get('C')?.kind, 'flee'); assert.equal(plan.get('R')?.kind, 'recover')
  assert.equal((plan.get('R') as any).data.antidote.cover, undefined)
  const panic = new Map([['R', { kind: 'flee', data: { panic: true } }]])
  pvpAntidotes(frame([r, c], [foe()], panic)); assert.equal(panic.get('R')?.kind, 'flee')
})

test('no report leaves plan untouched; distant expensive cover is not assigned', () => {
  const r = member('R', { honey_bottle: 1 }), c = member('C', { shield: 1 }, false); c.position = p(100)
  const S = frame([r, c], [foe()]); pvpAntidotes(S)
  assert.equal(S.plan.get('C'), undefined); assert.equal(S.plan.get('R')?.kind, 'recover')
  delete r.antidote; delete c.antidote
  const none = frame([r, c], [foe()]); pvpAntidotes(none); assert.equal(none.plan.size, 0)
})

test('normal full planner preserves antidote shield duty through endgame assignment', () => {
  const r = member('R', { honey_bottle: 1 }), c = member('C', { shield: 1 }, false); c.position = p(1)
  const board = new SwarmBoard('blue', () => 10000)
  board.setMembers([r, c]); board.observe('R', 10000, { ...foe(), visible: true })
  const plan = planPvp(board, [r, c], { doctrine: 'line', quorum: 1, foesLeft: 1 })
  assert.equal(plan.get('R')?.data?.antidote?.item, 'honey_bottle')
  assert.equal(plan.get('C')?.data?.antidoteCover, 'R')
})

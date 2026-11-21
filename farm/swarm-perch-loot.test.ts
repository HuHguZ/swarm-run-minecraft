import test from 'node:test'
import assert from 'node:assert/strict'
import { planPvp } from '../daemon/src/swarm'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmTeam } from './swarm/swarm-driver/team'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmClimb } from './swarm/swarm-driver/climb'

const p = (x, y, z) => ({ x, y, z })
// Match N, status 76474: S has reached the pillar and sees the unarmored Base on the floor.
const post = p(587.5, 133, 606.5), gallery = p(595.5, 134, 647.5)
const base = { id: 'Base', visible: true, position: p(601.7, 120, 598.5), equipment: { weapon: 'oak_planks', armor: [] } }

function replay(closeLoot = false) {
  let clock = 1000, released = 1
  const calls: any[] = [], pos: any = {}, bots: any[] = []
  for (const [name, position] of [['S', post], ...['Ally', 'G', 'K', 'Q'].map((id, i) => [id, p(625 + i, 120, 579)] as const)] as const) {
    pos[name] = { p: position, hp: name === 'S' ? 13 : 20, food: 14,
      inv: { bow: 1, arrow: 31, iron_axe: 1 }, attackArrows: 31, armor: { torso: 'iron_chestplate', legs: 'chainmail_leggings' } }
    bots.push({ name, team: 'blue', c: { async call(method, params) {
      calls.push({ method, params })
      return { status: 'done', detail: { shot: !!released } }
    } } })
  }
  const [b, ally] = bots
  const sw = createDriverState({ bots, pos, alive: () => true, hostile: () => true, arms: true, now: () => clock,
    arena: { x: 600, y: 120, z: 600, r: 80 }, home: () => post, log() {} })
  Object.assign(sw, swarmTeam(sw), swarmRetry(sw), swarmMoves(sw), { preempt() {} })
  sw.observe(b, [base], clock)
  const board = sw.boardOf(b), members = sw.membersOf(b), member = members.find(m => m.id === b.name)
  const offer = { position: closeLoot ? p(592.5, 133, 606.5) : gallery, tier: 4, seconds: closeLoot ? 4 : 34.8 }
  const task = planPvp(board, members, { foesLeft: 12, lootOffer: () => offer }).get(b.name)!
  assert.equal(task.kind, 'loot')
  b.swarmPosition = { at: post, purpose: 'ranged' }
  Object.assign(sw, { refresh: () => ({ board, members, member, task }), say() {}, chestAtHand: () => false,
    detail: r => r.detail, transfer: async () => false, loot: async () => { await b.c.call('goto', offer.position); return true },
    cacheTurn: async () => { await b.c.call('goto', offer.position); return true } })
  const driver = swarmTurn(sw)
  return { b, ally, calls, task, pos, sw, run: () => driver.turn(b), preempt: () => driver.preempt(b),
    see: (observer, foes: any[]) => sw.observe(observer, foes, ++clock), age: () => { clock += 1001 }, noRelease: () => { released = 0 } }
}

test('S takes a short ranged engagement from its reached pillar before the priced 35s upper loot route', async () => {
  const f = replay()
  const foe = (id, position, weapon, armor, enchanted = false) => ({ id, visible: true, position, equipment: { weapon, armor, enchanted } })
  f.see(f.b, [base, foe('P', p(592.588, 120, 603.94), 'iron_sword', ['iron_boots', 'iron_leggings']),
    foe('L', p(584.58, 120, 577.63), 'diamond_sword', ['iron_leggings', 'iron_chestplate', 'chainmail_helmet'], true),
    foe('T', p(575.96, 121.25, 607.50), 'cooked_beef', ['netherite_boots', 'netherite_leggings', 'netherite_chestplate', 'netherite_helmet'], true),
    foe('N', p(611.53, 120.80, 583.26), undefined, []), foe('V', p(585.52, 120, 582.68), 'stone_sword', ['iron_boots', 'iron_helmet'], true)])
  f.noRelease()
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['shoot'])
  assert.equal(f.calls[0].params.target, 'P')
  assert.deepEqual(f.calls[0].params.fromPost, post)
  await f.run()
  assert.equal(f.calls[1].method, 'shoot')
  assert.equal(f.calls[1].params.target, 'Base', 'a blocked arc to the nearest viable target leaves an alternative from the same post')
})

test('archer yields the route decision to useful nearby loot, depletion, threats, movement or lost personal sight', async () => {
  for (const reason of ['close loot', 'empty quiver', 'enemy archer', 'enemy on pillar', 'new blank poll', 'ally only', 'nametag', 'stale poll', 'left post', 'incoming arrow']) {
    const f = replay(reason === 'close loot')
    if (reason === 'empty quiver') f.pos.S.attackArrows = 0
    if (reason === 'enemy archer') f.see(f.b, [base, { ...base, id: 'Archer', equipment: { weapon: 'crossbow' } }])
    if (reason === 'enemy on pillar') f.see(f.b, [base, { ...base, id: 'Climber', position: p(593, 133, 608) }])
    if (reason === 'new blank poll' || reason === 'ally only') f.see(f.b, [])
    if (reason === 'ally only') f.see(f.ally, [base])
    if (reason === 'nametag') f.see(f.b, [{ ...base, visible: false, nametag: true }])
    if (reason === 'stale poll') f.age()
    if (reason === 'left post') f.pos.S.p = p(587.5, 120, 606.5)
    if (reason === 'incoming arrow') f.b.arrowThreat = { active: true, at: 1000 }
    await f.run()
    assert.equal(f.calls.some(c => c.method === 'shoot'), false, reason)
    if (!['enemy on pillar', 'left post'].includes(reason)) assert.equal(f.calls[0].method, 'goto', reason)
  }
})

test('an unreleased shot frees the archer for loot until the visible target moves', async () => {
  const f = replay()
  f.noRelease()
  await f.run(); await f.run()
  f.see(f.b, [{ ...base, position: p(base.position.x + 3, 120, base.position.z) }])
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['shoot', 'goto', 'shoot'])
})

test('newly visible shot interrupts the outbound trip and leaves an open local chest alone', () => {
  for (const active of ['goto', 'chest_take']) {
    const f = replay()
    Object.assign(f.b, { swarmExecuting: true, swarmTask: f.task, last: { m: active, pending: true } })
    assert.equal(f.preempt(), active === 'goto')
    assert.deepEqual(f.calls.map(c => c.method), active === 'goto' ? ['stop'] : [])
  }
})

test('a confirmed pearl landing on the team1 roof gives its archer a firing opportunity before the next loot trip', async () => {
  const roof = p(621.5, 150.5, 546.5), lower = { ...base, position: p(602.5, 143, 545.5) }
  for (const mode of ['clear', 'new order', 'miss', 'no teleport', 'unsafe footing', 'outside', 'old round', 'hidden', 'no bow', 'incoming']) {
    const f = replay()
    delete f.b.swarmPosition
    f.pos.S.p = p(619.5, 136, 545.5)
    f.pos.S.inv.ender_pearl = 2
    const transport = f.b.c.call
    f.b.c.call = (method, args) => method !== 'pearl_up' ? transport(method, args) : Promise.resolve({ status: 'done', detail: {
      ok: mode !== 'miss', hops: mode === 'no teleport' ? 0 : 1, at: p(622,151,547),
      landing: mode === 'unsafe footing' ? undefined : mode === 'outside' ? p(680,150.5,546.5) : roof } })
    await swarmClimb(f.sw).pearlUp(f.b, roof)
    f.pos.S.p = roof
    if (mode === 'old round') f.sw.generation++
    if (mode === 'no bow') delete f.pos.S.inv.bow
    f.see(f.b, mode === 'hidden' ? [] : [lower])
    if (mode === 'incoming') f.b.arrowThreat = { active: true, at: f.sw.now() }
    if (mode === 'new order') {
      f.b.swarmExecuting = true
      f.b.swarmTurnOwner = { cancelled: false }
      const call = f.b.c.call
      let finish: () => void
      f.b.c.call = async (method, args) => {
        if (method !== 'shoot') return call(method, args)
        f.b.last = { m: 'shoot', pending: true }
        await new Promise<void>(resolve => { finish = resolve })
        return { status: 'interrupted' }
      }
      const active = f.run()
      try {
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(f.b.last.m, 'shoot')
        assert.equal(f.preempt(), false, 'the same opportunity leaves the current draw intact')
        Object.assign(f.task, { kind: 'goto', position: gallery, data: { commanded: true } })
        assert.equal(f.preempt(), true, 'a new order releases the old shooting stance')
        assert.equal(f.b.swarmTurnOwner.cancelled, true)
        assert.deepEqual(f.calls.map(c => c.method), ['stop'])
      } finally { finish?.(); await active }
      continue
    }
    await f.run()
    const shot = f.calls.find(c => c.method === 'shoot')
    assert.equal(!!shot, mode === 'clear', mode)
    if (shot) assert.deepEqual(shot.params.fromPost, roof)
  }
})

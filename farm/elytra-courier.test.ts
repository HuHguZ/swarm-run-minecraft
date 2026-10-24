import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmTeam } from './swarm/swarm-driver/team'
import { swarmPosition } from './swarm/swarm-driver/position'
import { SwarmBoard, planTransfers } from '../daemon/src/swarm'

const p = (x = 0) => ({ x, y: 64, z: 0 })

test('courier stock improves worn armor and spear kits without donating its own pending upgrade', () => {
  const bots: any[] = ['D', 'R', 'OwnUpgrade'].map(name => ({ name, team: 'blue' }))
  const pos = {
    D: { p: p(), hp: 20, inv: { iron_sword: 1, stone_sword: 1, iron_spear: 1, iron_boots: 1 }, armor: { feet: 'diamond_boots' } },
    R: { p: p(30), hp: 20, inv: { iron_spear: 1 }, armor: { feet: 'leather_boots', torso: 'elytra' } },
    OwnUpgrade: { p: p(40), hp: 20, inv: { diamond_boots: 2, iron_spear: 1 }, armor: { feet: 'iron_boots' }, enchants: [{ slot: 9, name: 'diamond_boots', ench: { protection: 4 } }] }
  }
  const sw = { bots, pos, alive: () => true, now: () => 1000, boards: new Map(), blueprints: new Map() }
  const team = swarmTeam(sw), members = team.membersOf(bots[0]), donor = members[0], recipient = members[1]
  assert.equal(recipient.needs.iron_boots, 1, 'leather is upgraded even when the slot is occupied')
  assert.equal(recipient.needs.diamond_boots, 1)
  assert.equal(recipient.needs.iron_sword, 1, 'a lance does not replace a grounded weapon')
  assert.equal(donor.reserve.iron_sword, 1)
  assert.equal(donor.reserve.stone_sword, 0)
  assert.equal(donor.reserve.iron_spear, 1, 'flight weapon remains reserved')
  assert.equal(members[2].reserve.diamond_boots, 2, 'name-only toss cannot select which enchanted copy to keep until the own upgrade is equipped')
  const tasks = planTransfers(team.boardOf(bots[0]), members)
  assert.ok(tasks.some(t => t.data?.recipient === 'R' && t.data.item === 'iron_boots'), 'one reserved diamond item cannot hide available iron')
})

test('courier stops a sheltered receiver before flight, corrects a stale landing and releases it on danger', async () => {
  for (const scenario of ['success', 'danger', 'interrupted', 'open', 'safeOpen', 'stale', 'partialCover', 'resetAfterToss']) {
    let time = 1000, actualDonor = p(), stopped = false
    const calls: any[] = [], bots: any[] = [{ name: 'D', team: 'blue' }, { name: 'R', team: 'blue' }]
    const [donor, recipient] = bots
    const pos: any = { D: { p: p(), inv: { iron_boots: 1 } }, R: { p: p(60), inv: {}, armor: { feet: 'leather_boots' } } }
    recipient.swarmExecuting = true
    recipient.swarmTask = { kind: 'flee', position: p(60), data: { hide: true } }
    recipient.last = { m: 'swarm_hold', pending: true }
    recipient.swarmPosition = { at: p(60), cover: 1 }
    if (['open', 'safeOpen', 'stale'].includes(scenario)) { recipient.swarmTask = { kind: 'loot', data: {} }; delete recipient.swarmPosition }
    if (scenario === 'partialCover') recipient.swarmPosition.cover = .4
    const board = new SwarmBoard('blue', () => time)
    const members = bots.map(b => ({ id: b.name, team: 'blue', position: pos[b.name].p, health: 20, strength: 20, role: 'fighter', inventory: pos[b.name].inv, armor: pos[b.name].armor }))
    board.setMembers(members as any)
    if (scenario === 'open') board.observe('D', time, { id: 'Human', visible: true, position: p(70), equipment: { weapon: 'netherite_sword', enchanted: true } })
    if (scenario === 'safeOpen' || scenario === 'partialCover') board.observe('D', time, { id: 'Human', visible: true, position: p(scenario === 'safeOpen' ? 150 : 110), equipment: { weapon: 'netherite_sword', enchanted: true } })
    if (scenario === 'stale') board.observe('D', time - 2999, { id: 'Human', visible: true, position: p(70), equipment: { weapon: 'netherite_sword', enchanted: true } })
    const task = board.upsert({ id: 'transfer:D:R:iron_boots', kind: 'transfer', assignedTo: 'D', participants: ['D', 'R'], data: { donor: 'D', recipient: 'R', item: 'iron_boots', count: 1, reserve: 0 } })
    for (const b of bots) b.c = { call: async (method, params) => {
      calls.push({ who: b.name, method, params })
      if (method === 'stop') { assert.equal(b, recipient); stopped = true; recipient.swarmExecuting = false }
      if (method === 'status') return { state: { pos: b === donor ? actualDonor : pos.R.p, inventory: { ...pos[b.name].inv }, armor: { ...pos[b.name].armor } } }
      if (method === 'assist' && params.mode === 'toss') { pos.D.inv.iron_boots--; if (scenario === 'resetAfterToss') sw.generation++ }
      if (method === 'assist' && params.mode === 'pickup') pos.R.armor.feet = 'iron_boots'
      return { detail: { ok: true } }
    } }
    const failures = new Set<string>()
    const sw: any = { bots, pos, arena: {}, now: () => time, generation: 1, alive: () => true,
      transfers: new Map([['blue', [task]]]), telemetry: { transfers: 0 }, teamOf: b => b.team,
      fighting: b => !!b.swarmExecuting && b.swarmTask?.kind === 'flee', panic: () => false,
      lootSafe: () => true, lootArena: () => ({}), blocked: (_, key) => failures.has(key), failed: (_, key) => failures.add(key), cleared: key => failures.delete(key),
      travelCost: () => ({ walk: 15, fly: 5 }),
      positionQueries: 0, execute: async () => ({ observed: true, candidates: [] }),
      log: () => {}, detail: r => r.detail || r, renew: (bd, b, c) => bd.renew(c.id, b.name, c.claim.token, 25000),
      go: async (b, at, range, seconds, arena, air) => {
        calls.push({ who: b.name, method: 'go', air })
        assert.equal(stopped, true)
        assert.equal(b, donor, 'receiver stays inside its cover')
        if (air) {
          assert.equal(recipient.swarmReserved, undefined, 'urgent receiver turns remain possible during flight')
          time += 20000
          assert.ok(board.tasks().some(t => t.status === 'claimed'), 'lease survives a long flight')
          actualDonor = p(63.6); pos.D.p = p(61)
          if (scenario === 'danger') board.observe('D', time, { id: 'Human', visible: true, position: p(64) })
          if (scenario === 'interrupted') return { status: 'interrupted' }
        } else actualDonor = pos.D.p = p(61)
      } }
    const actions = swarmPosition(sw)
    await actions.transfer(donor, { board, members })
    assert.deepEqual(pos.R.p, p(60))
    assert.equal(recipient.swarmReserved, undefined)
    const tosses = calls.filter(c => c.method === 'assist' && c.params.mode === 'toss')
    const delivered = ['success', 'safeOpen', 'stale', 'partialCover'].includes(scenario)
    assert.equal(tosses.length, delivered || scenario === 'resetAfterToss' ? 1 : 0, scenario)
    assert.equal(sw.telemetry.transfers, delivered ? 1 : 0, scenario)
    if (delivered) assert.equal(calls.filter(c => c.method === 'go').length, 2, 'walk in using fresh status after an imprecise landing')
    else assert.ok(board.tasks().every(t => t.status !== 'claimed'))
    if (scenario === 'resetAfterToss') assert.equal(calls.some(c => c.method === 'assist' && c.params.mode === 'pickup'), false)
    if (scenario === 'open') {
      assert.equal(calls.filter(c => c.method === 'go').length, 0, 'do not turn failed cover search into an open-field handover')
      time += 3001
      await actions.transfer(donor, { board, members })
      assert.equal(sw.telemetry.transfers, 1, 'stale threat changes the price without requiring the sheltered receiver to move')
    }
  }
})

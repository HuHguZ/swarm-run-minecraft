import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, planTransfers, addBlueprint, nextBuild, selectDoctrine, assessSwarmFight, ownedCount, type SwarmMember } from '../src/swarm'

const p = (x = 0, y = 64, z = 0) => ({ x, y, z })
const member = (id: string, extra: Partial<SwarmMember> = {}): SwarmMember => ({ id, team: 'blue', position: p(), health: 20, strength: 20, role: 'fighter', ...extra })
function scene(members = [member('a'), member('b')]) {
  let time = 1000
  const board = new SwarmBoard('blue', () => time, 3000)
  board.setMembers(members)
  return { board, members, advance: (ms: number) => { time += ms }, see: (source = 'a', id = 'enemy', position = p(8), extra = {}) => board.observe(source, time, { id, position, visible: true, ...extra }) }
}

test('army parity prices simultaneous incoming hits through shared hurt resistance instead of making twenty equals panic', () => {
  for (const bows of [false, true]) {
    const team = Array.from({ length: 20 }, (_, i) => member('a' + i, {
      position: p(i % 5 * .3, 64, Math.floor(i / 5) * .3),
      inventory: bows ? { bow: 1, arrow: 64 } : {}, role: bows ? 'ranged' : 'fighter'
    }))
    const f = scene(team)
    for (let i = 0; i < 20; i++) for (const ally of team) f.see(ally.id, 'e' + i, p(12 + i % 5 * .3, 64, Math.floor(i / 5) * .3), {
      equipment: { weapon: bows ? 'bow' : null, armor: [] }, threat: bows ? 'bow' : 'melee'
    })
    const risk = assessSwarmFight(team[0], f.board.enemies(), team)
    assert.ok(risk.ready >= 2, 'actual nearby allies remain available during the shared damage window')
    assert.equal(risk.unsafe, false, bows ? 'equal bow army has feasible contact' : 'equal empty kits have feasible contact')
    assert.ok([...planPvp(f.board, team, { quorum: 2 }).values()].some(t => t.kind === 'fight'))
  }
})

test('one and two synchronized equal bow opponents do not invent an extra full hit inside the same hurt window', () => {
  const team = Array.from({ length: 20 }, (_, i) => member('a' + i, { position: p(0, 64, i % 4), inventory: { bow: 1, arrow: 64 }, role: 'ranged' }))
  const f = scene(team)
  for (const ally of team) f.see(ally.id, 'e0', p(12), { equipment: { weapon: 'bow', armor: [] }, threat: 'bow' })
  const one = assessSwarmFight(team[0], f.board.enemies(), team)
  for (const ally of team) f.see(ally.id, 'e1', p(12), { equipment: { weapon: 'bow', armor: [] }, threat: 'bow' })
  const two = assessSwarmFight(team[0], f.board.enemies(), team)
  assert.equal(one.unsafe, false)
  assert.equal(two.unsafe, false)
  assert.equal(two.ready, one.ready)
  assert.equal(two.survivalSeconds, one.survivalSeconds)
})

test('all ten doctrines have a natural winning context without forced selection and bow possession does not veto another feasible tactic', () => {
  const base = Array.from({ length: 6 }, (_, i) => member('a' + i, { strength: 100, inventory: { iron_sword: 1 }, weapon: 'iron_sword' }))
  const withRoles = (roles: SwarmMember['role'][], extra: Partial<SwarmMember> = {}) => base.map((m, i) => ({ ...m, ...extra, role: roles[i] || 'fighter' }))
  const contexts: Array<{ doctrine: any; team: SwarmMember[]; foe?: any }> = [
    { doctrine: 'line', team: base.slice(0, 2) },
    { doctrine: 'buffalo', team: base },
    { doctrine: 'ring', team: withRoles(['healer'], { canHeal: true, inventory: { iron_sword: 1, shield: 1 } }), foe: { equipment: { weapon: 'bow' }, threat: 'bow' } },
    { doctrine: 'fountain', team: base, foe: { equipment: { weapon: 'end_crystal' }, threat: 'blast' } },
    { doctrine: 'weak-center', team: base.map((m, i) => i ? m : { ...m, health: 4 }) },
    { doctrine: 'cocoon', team: withRoles(['miner-builder', 'miner-builder'], { inventory: { cobblestone: 64 } }), foe: { equipment: { weapon: 'bow' }, threat: 'bow' } },
    { doctrine: 'wave', team: withRoles([], { inventory: { wind_charge: 8 } }), foe: { position: p(8, 69), threat: 'aerial' } },
    { doctrine: 'hunt', team: withRoles(['miner-builder', 'miner-builder', 'flank', 'flank'], { inventory: { cobblestone: 64 } }), foe: { velocity: p(.09, 0, 0), equipment: { weapon: 'bow' }, threat: 'bow' } },
    { doctrine: 'false-weakness', team: withRoles(['healer', 'flank', 'flank', 'flank'], { canHeal: true }), foe: {} },
    { doctrine: 'false-retreat', team: base, foe: { velocity: p(.2, 0, 0) } }
  ]
  for (const { doctrine, team, foe } of contexts) {
    const f = scene(team)
    if (foe) f.see('a0', 'enemy', foe.position || p(8), foe)
    assert.equal(selectDoctrine(f.board, team), doctrine, `${doctrine} competes on its real context`)
  }
})

test('all ten doctrines assign executable construction, push, bait and rotating-line jobs without overriding panic', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f']
  const team = names.map((id, i) => member(id, { strength: 100, weapon: 'netherite_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], ench: { protection: 16 }, role: i < 2 ? 'miner-builder' : i === 2 ? 'healer' : 'fighter', inventory: { cobblestone: 64, wind_charge: 8 } }))
  for (const doctrine of ['cocoon', 'hunt', 'wave', 'false-weakness', 'false-retreat'] as const) {
    const f = scene(team); f.see('a'); f.see('b')
    const plan = [...planPvp(f.board, team, { doctrine, quorum: 2 }).values()]
    assert.ok(plan.every(t => t.data.doctrine === doctrine))
    if (doctrine === 'cocoon' || doctrine === 'hunt') assert.equal(plan.filter(t => t.data.buildKind === (doctrine === 'hunt' ? 'cutoff' : 'cocoon')).length, 2)
    if (doctrine === 'wave') assert.ok(plan.some(t => t.data.push))
    if (doctrine === 'false-weakness' || doctrine === 'false-retreat') assert.ok(plan.some(t => t.kind === 'goto' && t.data.bait))
  }
  const f = scene(team), equipment = { weapon: 'netherite_sword', armor: team[0].armor }
  f.see('a', 'enemy', p(8), { equipment }); f.see('b', 'enemy', p(8), { equipment })
  const first = planPvp(f.board, team, { doctrine: 'line', quorum: 2 })
  assert.equal(first.get('d').kind, 'fight')
  f.advance(22500); f.see('a', 'enemy', p(8), { equipment }); f.see('b', 'enemy', p(8), { equipment })
  const next = planPvp(f.board, team, { doctrine: 'line', quorum: 2 })
  assert.equal(next.get('d').kind, 'goto')
  assert.equal(next.get('e').kind, 'fight')
  const poor = scene([member('a')]); poor.see('a', 'enemy', p(3), { equipment: { weapon: 'netherite_sword', armor: team[0].armor, enchanted: true } })
  for (const doctrine of ['cocoon', 'wave', 'hunt', 'false-weakness', 'false-retreat'] as const) assert.equal(planPvp(poor.board, poor.members, { doctrine }).get('a').kind, 'flee')
})

test('swarm: claims are exclusive, leased, fenced and freed on cancellation/death', () => {
  const f = scene()
  f.board.upsert({ id: 'scout', kind: 'scout', position: p(10) })
  const first = f.board.claim('scout', 'a', 100)!
  assert.equal(f.board.claim('scout', 'b', 100), null)
  assert.equal(f.board.ack('scout', 'b', { token: first.claim.token, confirmed: true }), false)
  f.advance(100)
  const second = f.board.claim('scout', 'b', 100)!
  assert.equal(f.board.ack('scout', 'a', { token: first.claim.token, confirmed: true }), false)
  assert.notEqual(first.claim.token, second.claim.token)
  f.board.releaseOwner('b')
  assert.ok(f.board.claim('scout', 'a', 100))
  f.board.setMembers([member('a', { health: 0 }), member('b')])
  assert.ok(f.board.claim('scout', 'b', 100))
  assert.equal(f.board.claim('scout', 'outsider', 100), null)
})

test('swarm: team sight expires and sanitizes hidden HP/inventory without reading them', () => {
  const f = scene()
  const enemy: any = { id: 'enemy', position: p(8), visible: true, equipment: { weapon: 'bow', armor: ['iron_helmet'] } }
  for (const key of ['hp', 'health', 'inventory', 'strength']) Object.defineProperty(enemy, key, { enumerable: true, get() { throw new Error('hidden data read') } })
  assert.equal(f.board.observe('outsider', 1000, enemy), false)
  assert.equal(f.board.observe('a', 1000, Object.assign(Object.create(enemy), { visible: false })), false)
  assert.equal(f.board.observe('a', 1000, enemy), true)
  assert.equal(JSON.stringify(f.board.enemies()).includes('inventory'), false)
  assert.equal('hp' in f.board.enemies()[0], false)
  f.advance(3000)
  assert.equal(f.board.enemies().length, 0)
})

test('swarm: source sets, out-of-order sight, snapshots and world marks stay within their team', () => {
  const f = scene()
  assert.equal(f.see('a'), true)
  f.advance(200)
  f.see('b', 'enemy', p(9))
  f.board.observe('a', 900, { id: 'enemy', position: p(99), visible: true })
  const e = f.board.enemies()[0]
  assert.deepEqual(e.sources, ['a', 'b'])
  assert.equal(e.position.x, 9)
  e.position.x = 99
  assert.equal(f.board.enemies()[0].position.x, 9)
  assert.equal(f.board.recordFact('outsider', 1200, { id: 'lava', kind: 'mark', position: p(3) }, 500), false)
  assert.ok(f.board.recordFact('a', 1200, { id: 'lava', kind: 'mark', position: p(3) }, 500))
  f.advance(500)
  assert.equal(f.board.facts().length, 0)
  f.advance(2800)
  assert.equal(f.board.enemies().length, 0)
  const red = new SwarmBoard('red', () => 1200)
  red.setMembers(f.members)
  assert.equal(red.observe('a', 1200, { id: 'enemy', position: p(), visible: true }), false)
  assert.equal(red.claim('scout', 'a'), null)
})

test('swarm PvP: full team allocations spread targets and match local fighters without fixed squads', () => {
  const members = Array.from({ length: 12 }, (_, i) => member('a' + i, { position: p(i < 6 ? 0 : 35), strength: 20 + i }))
  const f = scene(members)
  for (const m of members) f.see(m.id, 'left', p(5))
  f.see('a0', 'right', p(40))
  const plan = planPvp(f.board, members)
  assert.equal(plan.size, 12)
  const targets = [...plan.values()].map(t => t.data?.target)
  assert.ok(targets.includes('left') && targets.includes('right'))
  for (const m of members) if (plan.get(m.id)!.data?.target) assert.equal(plan.get(m.id)!.data!.target, m.position.x === 0 ? 'left' : 'right')
  assert.equal(plan.get('a5')!.data!.target, 'left')
  assert.equal(plan.get('a11')!.data!.target, 'right')
  assert.ok([...plan.values()].every(t => t.team === 'blue'))
})

test('swarm PvP: wounded recover, healer and cover coordinate, unseen HP cannot alter planning', () => {
  const members = [member('hurt', { health: 4, armor: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], ench: { protection: 16 } }), member('heal', { role: 'healer', canHeal: true, position: p(-2) }), member('strong', { strength: 80 }), member('flank', { role: 'flank', position: p(3, 64, 5) })]
  const f = scene(members)
  f.see('strong', 'enemy', p(5))
  f.see('flank', 'enemy', p(5))
  const plan = planPvp(f.board, members)
  assert.equal(plan.get('hurt')!.kind, 'recover')
  assert.equal(plan.get('heal')!.kind, 'heal')
  assert.equal(plan.get('heal')!.data!.ally, 'hurt')
  assert.ok([...plan.values()].some(t => t.data?.cover === 'hurt'))
  assert.equal(plan.get('strong')!.data!.doctrine, 'weak-center')
  assert.notDeepEqual(plan.get('strong')!.position, plan.get('flank')!.position)
  const before = JSON.stringify([...plan])
  f.see('strong', 'enemy', p(5), { hp: 1, inventory: { netherite_sword: 99 } })
  assert.equal(JSON.stringify([...planPvp(f.board, members)]), before)
})

test('swarm PvP: shared quorum stages mass attack and defensive doctrines have real geometry', () => {
  const members = [member('a'), member('b'), member('c', { role: 'healer', canHeal: true }), member('d', { role: 'flank' }), member('e', { role: 'ranged' }), member('f')]
  const f = scene(members)
  f.see('a', 'enemy', p(20))
  let plan = planPvp(f.board, members, { doctrine: 'buffalo' })
  assert.ok([...plan.values()].every(t => t.kind !== 'fight'))
  for (const id of ['b', 'd']) f.see(id, 'enemy', p(20))
  plan = planPvp(f.board, members, { doctrine: 'buffalo' })
  assert.ok([...plan.values()].some(t => t.kind === 'fight'))
  assert.notEqual(plan.get('d')!.position!.z, plan.get('a')!.position!.z)
  assert.ok(plan.get('c')!.position!.x < plan.get('a')!.position!.x)
  f.see('a', 'enemy', p(20), { threat: 'blast' })
  assert.equal(selectDoctrine(f.board, members), 'fountain')
  f.see('a', 'enemy', p(20), { threat: 'bow' })
  assert.equal(selectDoctrine(f.board, members), 'ring')
  const ring = planPvp(f.board, members, { doctrine: 'ring' })
  assert.ok(Math.hypot(ring.get('c')!.position!.x, ring.get('c')!.position!.z) < Math.hypot(ring.get('a')!.position!.x, ring.get('a')!.position!.z))
  const healer = ring.get('c')!.position!
  assert.ok([...ring.values()].every(t => Math.hypot(t.position!.x - healer.x, t.position!.z - healer.z) < 4), 'the defensive ring fits a real four-block healing splash')
})

test('swarm: shared successful doctrines survive round reset, observations and claims do not', () => {
  const f = scene()
  f.see()
  assert.equal(f.board.noteTacticOutcome('outsider', 'line', true), false)
  assert.ok(f.board.noteTacticOutcome('a', 'line', true))
  f.board.upsert({ id: 'scout', kind: 'scout' })
  f.board.claim('scout', 'a')
  f.board.resetRound()
  assert.equal(f.board.tasks().length, 0)
  assert.equal(f.board.enemies().length, 0)
  assert.deepEqual(f.board.tacticStats().line, { successes: 1, failures: 0 })
})

test('swarm PvP: a single known enemy gets enough force, reserves and old sightings get search tasks', () => {
  const members = Array.from({ length: 10 }, (_, i) => member('a' + i, { position: p(0, 64, i % 2) }))
  const f = scene(members)
  for (const m of members) f.see(m.id, 'enemy', p(12))
  const first = planPvp(f.board, members)
  const fighters = [...first.values()].filter(t => t.kind === 'fight')
  assert.ok(fighters.length > 0 && fighters.length < members.length)
  assert.ok([...first.values()].some(t => t.data?.reserve))
  const claim = f.board.claim(fighters[0].id, fighters[0].assignedTo!)!
  members[0].position.x = 0.1
  assert.equal(planPvp(f.board, members).get(claim.assignedTo!)!.claim!.token, claim.claim.token, 'formation changes do not revoke the same action lease')
  f.advance(600)
  const stale = planPvp(f.board, members)
  assert.ok([...stale.values()].filter(t => t.data?.target).every(t => t.kind === 'goto' && t.data?.search))
  assert.equal(f.board.ack(claim.id, claim.assignedTo!, { token: claim.claim.token, confirmed: true }), false, 'changed action fences its old receipt')
})

test('swarm transfers: reserves protect last required items and near deficits share surplus fairly', () => {
  const members = [member('donor', { inventory: { bread: 9, iron_sword: 1 }, reserve: { bread: 3, iron_sword: 1 } }), member('close', { position: p(1), inventory: {}, needs: { bread: 6, iron_sword: 1 } }), member('far', { position: p(20), inventory: {}, needs: { bread: 6 } })]
  const f = scene(members)
  const tasks = planTransfers(f.board, members)
  assert.equal(tasks.length, 1, 'one pair per member at a time')
  assert.equal(tasks[0].data!.recipient, 'close')
  assert.equal(tasks[0].data!.item, 'bread')
  assert.equal(tasks[0].data!.count, 6)
  const claim = f.board.claim(tasks[0].id, 'donor')!
  assert.ok(claim)
  assert.equal(f.board.claim(tasks[0].id, 'close'), null)
  assert.equal(planTransfers(f.board, members).length, 1, 'live transfer reserves both participants and its stock')
  assert.ok(f.board.ack(claim.id, 'donor', { token: claim.claim.token, confirmed: true }))
  assert.equal(planTransfers(f.board, members)[0].status, 'done', 'stale inventory cannot schedule an acknowledged transfer twice')
  members[0].inventory!.bread = 3
  members[1].inventory!.bread = 6
  assert.equal(planTransfers(f.board, members).length, 0)
  const donors = [member('d1', { inventory: { bread: 7 }, reserve: { bread: 1 } }), member('d2', { position: p(2), inventory: { bread: 7 }, reserve: { bread: 1 } }), member('r1', { position: p(1), needs: { bread: 4 } }), member('r2', { position: p(3), needs: { bread: 4 } })]
  const g = scene(donors)
  const parallel = planTransfers(g.board, donors)
  assert.equal(parallel.length, 2)
  assert.equal(new Set(parallel.map(t => t.data!.recipient)).size, 2)
})

test('a confirmed armor gift converges after automatic wearing without making worn gear spendable or retaining its pair', () => {
  const donor = member('donor', { inventory: { iron_boots: 2, bread: 9 }, reserve: { iron_boots: 1, bread: 1 }, armor: { feet: 'iron_boots' } })
  const recipient = member('recipient', { position: p(1), inventory: {}, needs: { iron_boots: 1 } })
  const f = scene([donor, recipient])
  const task = planTransfers(f.board, f.members)[0]
  assert.equal(task.data!.recipientBeforeOwned, 0)
  const claim = f.board.claim(task.id, donor.id)!
  assert.ok(f.board.ack(task.id, donor.id, { token: claim.claim.token, confirmed: true }))
  assert.equal(planTransfers(f.board, f.members)[0].status, 'done', 'stale donor/recipient reports still cannot duplicate the gift')
  donor.inventory!.iron_boots = 1
  recipient.armor = { feet: 'iron_boots' }; recipient.needs = { bread: 4 }
  assert.equal(ownedCount(recipient, 'iron_boots'), 1)
  assert.equal(recipient.inventory!.iron_boots, undefined)
  const next = planTransfers(f.board, f.members)
  assert.equal(next.length, 1)
  assert.equal(next[0].data!.item, 'bread', 'the completed gift releases both actors for another actual deficit')
  assert.equal(ownedCount(donor, 'iron_boots'), 2)
  assert.equal(donor.inventory!.iron_boots, 1, 'worn boots never inflate the spendable reserve')
})

test('armor owned before a gift cannot itself satisfy the acknowledged transfer delta', () => {
  const donor = member('donor', { inventory: { iron_boots: 2 }, reserve: { iron_boots: 1 } })
  const recipient = member('recipient', { position: p(1), inventory: {}, armor: ['iron_boots'], needs: { iron_boots: 1 } })
  const f = scene([donor, recipient]), task = planTransfers(f.board, f.members)[0]
  assert.equal(task.data!.recipientBeforeOwned, 1)
  const claim = f.board.claim(task.id, donor.id)!
  assert.ok(f.board.ack(task.id, donor.id, { token: claim.claim.token, confirmed: true }))
  donor.inventory!.iron_boots = 1
  assert.equal(planTransfers(f.board, f.members)[0].status, 'done', 'old worn gear is not a new receipt')
  recipient.inventory!.iron_boots = 1
  assert.equal(planTransfers(f.board, f.members).length, 0)
})

test('swarm blueprint: independent builders work concurrently, dependents need confirmed support', () => {
  const f = scene([member('a', { role: 'miner-builder' }), member('b', { role: 'miner-builder' }), member('c', { role: 'miner-builder' })])
  addBlueprint(f.board, { id: 'wall', cells: [{ id: 'base', position: p(1), block: 'stone', support: p(1, 63) }, { id: 'other', position: p(4), block: 'stone', support: p(4, 63) }, { id: 'top', position: p(1, 65), block: 'stone', dependsOn: ['base'], support: 'base' }] })
  assert.equal(nextBuild(f.board, member('a', { role: 'miner-builder' })), null, 'external support requires a witnessed mark')
  for (const x of [1, 4]) f.board.recordFact('a', 1000, { id: 'floor-' + x, kind: 'support', position: p(x, 63) }, 5000)
  const a = nextBuild(f.board, member('a', { role: 'miner-builder' }))!
  const b = nextBuild(f.board, member('b', { role: 'miner-builder' }))!
  assert.notEqual(a.id, b.id)
  assert.equal(nextBuild(f.board, member('c', { role: 'miner-builder' })), null)
  assert.equal(f.board.ack(a.id, 'a', { token: a.claim.token, confirmed: false, position: a.position, block: 'stone' }), false)
  assert.equal(f.board.ack(a.id, 'a', { token: a.claim.token, confirmed: true, position: p(99), block: 'stone' }), false)
  assert.equal(f.board.ack(a.id, 'a', { token: a.claim.token, confirmed: true, position: a.position, block: 'dirt' }), false)
  assert.ok(f.board.ack(a.id, 'a', { token: a.claim.token, confirmed: true, position: a.position, block: 'stone' }))
  assert.ok(nextBuild(f.board, member('c', { role: 'miner-builder' }))!.id.endsWith(':top'))
})

test('swarm blueprint validates duplicate cells, dependency cycles and claims before mutation', () => {
  const f = scene()
  assert.throws(() => addBlueprint(f.board, { id: 'bad', cells: [{ id: 'a', position: p(), block: 'stone', dependsOn: ['b'] }, { id: 'b', position: p(0, 65), block: 'stone', dependsOn: ['a'] }] }), /cycle/i)
  assert.equal(f.board.tasks().length, 0)
  assert.throws(() => addBlueprint(f.board, { id: 'bad', cells: [{ id: 'a', position: p(), block: 'stone' }, { id: 'b', position: p(), block: 'stone' }] }), /cell/i)
  assert.equal(f.board.tasks().length, 0)
  f.board.upsert({ id: 'first', kind: 'build', position: p(), data: { block: 'stone' } })
  f.board.upsert({ id: 'second', kind: 'build', position: p(), data: { block: 'stone' } })
  assert.ok(f.board.claim('first', 'a'))
  assert.equal(f.board.claim('second', 'b'), null, 'different task IDs cannot claim the same physical cell')
})

const armor = (material: string) => ['helmet', 'chestplate', 'leggings', 'boots'].map(slot => `${material}_${slot}`)
test('never-observed armor is an uncertainty price, not a naked foe or fabricated observation', () => {
  const me = member('a', { weapon: 'iron_sword', inventory: { iron_sword: 1 }, armor: armor('iron') })
  const f = scene([me])
  f.see('a', 'enemy', p(4), { equipment: { weapon: 'iron_sword', armor: [], unknownArmorSlots: 0 } })
  const naked = assessSwarmFight(me, f.board.enemies(), [me])
  f.see('a', 'enemy', p(4), { equipment: { weapon: 'iron_sword', armor: [], unknownArmorSlots: 4 } })
  const unknown = assessSwarmFight(me, f.board.enemies(), [me])
  assert.ok(unknown.killSeconds > naked.killSeconds)
  assert.equal(unknown.unsafe, true)
  assert.equal(naked.unsafe, false)
  assert.equal(unknown.enemyProtection[1], 16)
  assert.equal(f.board.enemies()[0].equipment!.unknownArmorSlots, 4)
  assert.deepEqual(f.board.enemies()[0].equipment!.armor, [], 'upper-bound pricing never claims an unseen item')
  f.see('a', 'enemy', p(4), { equipment: { unknownArmorSlots: 9 } })
  assert.equal(f.board.enemies()[0].equipment!.unknownArmorSlots, undefined)
})
test('swarm causal combat: ten naked and two iron allies cannot swarm an enchanted netherite player', () => {
  const members = Array.from({ length: 12 }, (_, i) => member('a' + i, { position: p(i % 3 - 1, 64, Math.floor(i / 3) - 2), inventory: i < 10 ? {} : { iron_sword: 1 }, armor: i < 10 ? [] : armor('iron'), strength: i < 10 ? 20 : 80 }))
  const f = scene(members)
  for (const m of members) f.see(m.id, 'human', p(5), { equipment: { weapon: 'netherite_sword', armor: armor('netherite'), enchanted: true } })
  const risk = assessSwarmFight(members[0], f.board.enemies(), members)
  assert.equal(risk.unsafe, true)
  assert.ok(risk.killSeconds > risk.survivalSeconds)
  assert.ok(risk.contactSlots <= 2, 'ten fists cannot all deliver additive damage through one player hit window')
  const plan = planPvp(f.board, members)
  assert.ok([...plan.values()].every(t => t.kind === 'flee' && t.data?.panic))
  assert.equal(new Set([...plan.values()].map(t => JSON.stringify(t.position))).size, members.length, 'panic disperses rather than making a new mob')
  f.advance(9000)
  assert.ok([...planPvp(f.board, members).values()].every(t => t.kind === 'loot'), 'empty inventory prices preparation instead of idle scouting')
})

test('swarm causal combat: physical weapon and armor parity allows combat; remote reinforcements do not save an isolated weak bot', () => {
  const equipped = member('a', { armor: armor('netherite'), weapon: 'netherite_sword', inventory: { netherite_sword: 1 }, ench: { sharpness: 5, protection: 16 }, strength: 100 })
  const friend = member('b', { ...equipped, id: 'b', position: p(1, 64, 2) })
  const f = scene([equipped, friend])
  f.see('a', 'human', p(5), { equipment: { weapon: 'netherite_sword', armor: armor('netherite'), enchanted: true } })
  f.see('b', 'human', p(5), { equipment: { weapon: 'netherite_sword', armor: armor('netherite'), enchanted: true } })
  const parity = assessSwarmFight(equipped, f.board.enemies(), [equipped, friend])
  assert.equal(parity.unsafe, false)
  assert.ok([...planPvp(f.board, [equipped, friend]).values()].some(t => t.kind === 'fight'))
  const poor = member('poor', { inventory: {}, armor: [], position: p(4) })
  const distant = Array.from({ length: 8 }, (_, i) => member('strong' + i, { ...equipped, id: 'strong' + i, position: p(100 + i) }))
  const g = scene([poor, ...distant])
  g.see('poor', 'human', p(6), { equipment: { weapon: 'netherite_sword', armor: armor('netherite'), enchanted: true } })
  const isolated = assessSwarmFight(poor, g.board.enemies(), [poor, ...distant])
  assert.equal(isolated.unsafe, true)
  assert.equal(isolated.ready, 1)
  assert.equal(planPvp(g.board, [poor, ...distant]).get('poor')!.kind, 'flee', 'close contact does not override panic')
})

test('swarm causal combat: enchantment glint widens conservative bounds, raw enemy HP and enchant levels are never read', () => {
  const m = member('a', { armor: armor('iron'), inventory: { iron_sword: 1 } })
  const f = scene([m])
  const enemy: any = { id: 'human', position: p(5), visible: true, equipment: { weapon: 'netherite_sword', armor: armor('netherite'), enchanted: true } }
  for (const key of ['hp', 'health', 'inventory', 'ench']) Object.defineProperty(enemy, key, { enumerable: true, get() { throw new Error('hidden stats forbidden') } })
  for (const key of ['sharpness', 'protection', 'ench']) Object.defineProperty(enemy.equipment, key, { enumerable: true, get() { throw new Error('raw enemy enchantments forbidden') } })
  assert.equal(f.board.observe('a', 1000, enemy), true)
  const risk = assessSwarmFight(m, f.board.enemies(), [m])
  assert.equal(risk.unsafe, true)
  assert.deepEqual(risk.enemySharpness, [0, 5])
  assert.deepEqual(risk.enemyProtection, [0, 16])
  assert.equal(JSON.stringify(f.board.enemies()).includes('sharpness'), false)
})

test('swarm causal combat: isolated parity loses to local numerical pressure; blasts punish clustered allies simultaneously', () => {
  const m = member('a', { weapon: 'iron_sword', inventory: { iron_sword: 1 }, armor: armor('iron') })
  const f = scene([m])
  for (const [i, z] of [-2, 0, 2].entries()) f.see('a', 'e' + i, p(4, 64, z), { equipment: { weapon: 'iron_sword', armor: armor('iron') } })
  const risk = assessSwarmFight(m, f.board.enemies(), [m])
  assert.equal(risk.unsafe, true)
  assert.equal(planPvp(f.board, [m]).get('a')!.kind, 'flee')
  const naked = [member('a', { inventory: {}, position: p() }), member('b', { inventory: {}, position: p(0, 64, 1) }), member('c', { inventory: {}, position: p(1) })]
  const g = scene(naked)
  for (const ally of naked) g.see(ally.id, 'crystal', p(5), { threat: 'blast', equipment: { weapon: 'end_crystal' } })
  assert.ok([...planPvp(g.board, naked).values()].every(t => t.kind === 'flee'))
})

test('swarm causal combat: twenty default arena bow kits still flee an enchanted netherite aggressor before the first melee hit', () => {
  const members = Array.from({ length: 20 }, (_, i) => member('b' + i, { position: p(i % 5 * .4, 64, Math.floor(i / 5) * .4),
    inventory: { bow: 1, arrow: 64, wind_charge: 32, ender_pearl: 4, elytra: 1, firework_rocket: 64, stone_pickaxe: 1, cobblestone: 64 }, armor: [], role: i % 2 ? 'ranged' : 'miner-builder' }))
  const f = scene(members)
  for (const m of members) f.see(m.id, 'human', p(6), { velocity: { x: -.28, y: 0, z: 0 }, equipment: { weapon: 'netherite_sword', armor: armor('netherite'), enchanted: true } })
  const plan = planPvp(f.board, members)
  assert.ok([...plan.values()].every(t => t.kind === 'flee'), 'bows, pearls and numeric headcount do not imply armor parity')
  assert.ok([...plan.values()].every(t => t.data!.risk.contactSlots <= 2))
})

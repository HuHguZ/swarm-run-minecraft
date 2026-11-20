import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../daemon/src/swarm'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmLoot } from './swarm/swarm-driver/loot'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'
import { assessSwarmFight, memberFight } from '../daemon/src/swarm/fight'
import { ascentActive } from './swarm/swarm-driver/ascent'

process.env.ARMS_CACHE_MEMORY = '0'
process.env.ARMS_CACHE_SEARCH = '0'

function fixture({ gap = 40, sites = [{ x: -10, y: 64, z: .5 }] as any[], inventory = {}, arms = true, attackArrows = undefined, loadedCrossbow = false } = {}) {
  const calls: any[] = [], now = () => 1000, arena = { x: 0, y: 64, z: 0, r: 100, killY: 60 }
  const members: SwarmMember[] = Array.from({ length: 12 }, (_, i) => ({ id: 'blue' + i, team: 'blue',
    position: { x: .5, y: 64, z: .5 }, health: 20, strength: 20, role: 'fighter', inventory: i ? {} : inventory, armor: [] }))
  const member = members[0], board = new SwarmBoard('blue', now)
  board.setMembers(members)
  for (let i = 0; i < 12; i++) board.observe(member.id, now(), { id: 'red' + i, visible: true,
    position: { x: .5 + gap, y: 64, z: .5 }, equipment: { armor: [] } })
  const task = planPvp(board, members, { quorum: 1, foesLeft: 12, doctrine: 'buffalo' }).get(member.id)!
  const pos = { [member.id]: { p: member.position, hp: 20, inv: inventory, armor: {}, attackArrows, loadedCrossbow } }
  const b: any = { name: member.id, team: 'blue', c: { async call(method, params: any = {}) {
    calls.push({ method, params })
    if (method === 'blocks_around') return { detail: { found: [] } }
    if (method === 'goto') { pos[member.id].p = { x: params.x, y: params.y, z: params.z }; return { status: 'done', detail: { arrived: pos[member.id].p } } }
    return { detail: {} }
  } } }
  const sw: any = createDriverState({ bots: [b], pos, now, arena, arms, chestTops: sites, alive: () => true, log() {} })
  Object.assign(sw, { boardOf: () => board, teamOf: () => 'blue', blocked: () => false, failed() {},
    refresh: () => ({ board, member, members, task }), say() {}, onslaught: () => false,
    pearlUp: async () => null,
    transfer: async () => false, positionStep: async () => false, buildStep: async () => false,
    search: async () => { calls.push({ method: 'search' }) },
    turnFight: async () => { calls.push({ method: 'fight' }) }, turnGoto: async () => { calls.push({ method: 'pursue' }) } })
  Object.assign(sw, swarmMoves(sw))
  Object.assign(sw, swarmLoot(sw))
  sw.cacheTurn = async () => false
  return { calls, task, sw, b, pos, board, member, members, run: () => swarmTurn(sw).turn(b) }
}

function contactLootFixture({ gap = 1.15, inventory = { netherite_sword: 1 } as Record<string, number>, enemyEquipment = { armor: [] } as any, seenAt = 1000 } = {}) {
  const f = fixture({ gap, inventory, sites: [] })
  f.members.splice(1)
  f.member.role = 'healer'
  f.member.weapon = Object.keys(inventory).find(name => /_sword$|_axe$/.test(name))
  f.board.resetRound(); f.board.setMembers(f.members)
  f.board.observe(f.member.id, seenAt, { id: 'red0', visible: true,
    position: { x: .5 + gap, y: 64, z: .5 }, equipment: { unknownArmorSlots: 0, armorVisible: [true, true, true, true], ...enemyEquipment } })
  Object.assign(f.task, { kind: 'loot', position: { x: -10, y: 64, z: .5 }, data: { weak: false, improvement: 2.2, committed: true } })
  f.b.swarmTask = f.task; f.b.last = { m: 'goto', pending: true }
  Object.assign(f.sw, { home: () => f.member.position, rangedAdvantage: () => false,
    turnFlee: async () => { f.calls.push({ method: 'flee' }) }, turnRecover: async () => { f.calls.push({ method: 'recover' }) } })
  f.sw.turnFight = swarmTurnWork(f.sw).turnFight
  return f
}

test('pending loot yields to a profitable contact and its next turn reaches the real fight RPC', async () => {
  const f = contactLootFixture(), enemy = f.board.enemies()[0]
  assert.ok(memberFight(f.member, enemy).attackSeconds < memberFight(f.member, enemy).survival)
  assert.equal(assessSwarmFight(f.member, f.board.enemies(), f.members).unsafe, false)
  f.b.swarmExecuting = true
  assert.equal(swarmTurn(f.sw).preempt(f.b), true)
  assert.deepEqual(f.calls.map(c => c.method), ['stop'])
  assert.equal(f.b.swarmTask.kind, 'fight')
  assert.equal(f.b.swarmTask.data.target, 'red0')
  f.b.swarmExecuting = false; f.b.last.pending = false
  await f.run()
  assert.ok(f.calls.some(c => c.method === 'fight' && c.params.target === 'red0' && c.params.allowPlayer), 'existing turnFight must execute its actual RPC')
  assert.equal(f.calls.some(c => c.method === 'goto'), false, 'the looter must not run away from this winning contact')
})

test('a refreshed fight order interrupts pending loot even when both ordinary phases are empty', async () => {
  const f = contactLootFixture()
  f.b.swarmTask = { ...f.task, data: { ...f.task.data } }
  Object.assign(f.task, { kind: 'fight', data: { target: 'red0', committed: true } })
  f.b.swarmExecuting = true
  assert.equal(swarmTurn(f.sw).phase(f.b.swarmTask), swarmTurn(f.sw).phase(f.task), 'this reproduces the equal-phase handoff')
  assert.equal(swarmTurn(f.sw).preempt(f.b), true, 'the fresh fighter order must stop the previous loot RPC')
  assert.deepEqual(f.calls.map(c => c.method), ['stop'])
  assert.equal(f.b.swarmTask.kind, 'fight')
  f.b.swarmExecuting = false; f.b.last.pending = false
  await f.run()
  assert.ok(f.calls.some(c => c.method === 'fight' && c.params.target === 'red0'))
})

test('idle loot in profitable contact reaches fight without a pending action to preempt', async () => {
  const f = contactLootFixture()
  f.b.last.pending = false
  await f.run()
  assert.ok(f.calls.some(c => c.method === 'fight' && c.params.target === 'red0'))
  assert.equal(f.calls.some(c => c.method === 'goto'), false)
})

test('a loaded offhand crossbow can defend loot contact without a loose inventory bow or arrow', async () => {
  for (const loadedCrossbow of [false, true]) {
    const f = contactLootFixture({ inventory: {} })
    const armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
    f.member.offHand = 'crossbow'; f.member.armor = Object.values(armor)
    f.board.setMembers(f.members)
    Object.assign(f.pos[f.member.id], { armor, loadedCrossbow, attackArrows: 0, offHand: { item: 'crossbow' } })
    assert.equal(f.member.inventory?.crossbow, undefined)
    const duel = memberFight(f.member, f.board.enemies()[0])
    assert.ok(duel.attackSeconds < duel.survival, 'the same real armor advantage makes this contact profitable in both cases')
    assert.equal(assessSwarmFight(f.member, f.board.enemies(), f.members).unsafe, false)
    f.b.last.pending = false
    await f.run()
    assert.equal(f.calls.some(c => c.method === 'fight' && c.params.target === 'red0'), loadedCrossbow)
  }
})

test('profitable contact interrupts an active loot ascent while distant and stale sightings keep it intact', () => {
  for (const input of [{ gap: 1.15 }, { gap: 20 }, { seenAt: -100 }]) {
    const f = contactLootFixture(input), m = f.pos[f.member.id]
    Object.assign(m, { observedAt: 1000, frameAt: 1000, frame: 1 })
    f.b.climbing = true; f.b.swarmExecuting = true
    f.b.swarmAscent = { to: { ...m.p, y: m.p.y + 16 }, left: 16, y: m.p.y,
      blocks: 0, progressAt: 1000, frame: 1, pending: true, stalled: false }
    assert.equal(ascentActive(f.b, m, 1000), true, 'this must exercise the live ascent guard')
    const contact = input.gap === 1.15
    assert.equal(swarmTurn(f.sw).preempt(f.b), contact)
    assert.deepEqual(f.calls.map(c => c.method), contact ? ['stop'] : [])
    if (contact) assert.equal(f.calls[0].params._climb, true)
  }
})

test('unarmed and losing looters keep their preparation rather than being promoted to attack', async () => {
  const naked = contactLootFixture({ inventory: {} })
  naked.b.swarmExecuting = true
  assert.equal(swarmTurn(naked.sw).preempt(naked.b), false)
  naked.b.swarmExecuting = false
  await naked.run()
  assert.equal(naked.calls.some(c => c.method === 'fight' || c.method === 'stop'), false, 'a bare looter is not promoted to an aggressive fist duel')
  const inventories: Record<string, number>[] = [{}, { stone_sword: 1 }]
  for (const inventory of inventories) {
    const f = contactLootFixture({ inventory, enemyEquipment: { weapon: 'netherite_sword', enchanted: true,
      armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'] } })
    const duel = memberFight(f.member, f.board.enemies()[0])
    assert.ok(duel.attackSeconds >= duel.survival)
    f.b.swarmExecuting = true
    assert.equal(swarmTurn(f.sw).preempt(f.b), false)
    f.b.swarmExecuting = false
    await f.run()
    assert.equal(f.calls.some(c => c.method === 'fight' || c.method === 'stop'), false)
  }
})

test('a winning nearby duel does not override lethal pressure from another observed enemy', async () => {
  const f = contactLootFixture()
  f.board.observe(f.member.id, 1000, { id: 'blast', visible: true, threat: 'blast',
    position: { x: 2, y: 64, z: .5 }, equipment: { weapon: 'end_crystal', armor: [] } })
  const duel = memberFight(f.member, f.board.enemies().find(e => e.id === 'red0')!)
  assert.ok(duel.attackSeconds < duel.survival)
  assert.equal(assessSwarmFight(f.member, f.board.enemies(), f.members).lethal, true)
  f.b.swarmExecuting = true
  assert.equal(swarmTurn(f.sw).preempt(f.b), false)
  f.b.swarmExecuting = false
  await f.run()
  assert.equal(f.calls.some(c => c.method === 'fight' || c.method === 'stop'), false)
})

test('distant or stale sightings do not turn loot preparation into a contact attack', async () => {
  for (const input of [{ gap: 20 }, { seenAt: -100 }]) {
    const f = contactLootFixture(input)
    f.b.swarmExecuting = true
    assert.equal(swarmTurn(f.sw).preempt(f.b), false)
    f.b.swarmExecuting = false
    await f.run()
    assert.equal(f.calls.some(c => c.method === 'fight' || c.method === 'stop'), false)
  }
})

test('contact loot cannot steal rescue ownership or override an assigned flee or recover', async () => {
  for (const kind of ['rescue', 'flee', 'recover']) {
    const f = contactLootFixture()
    if (kind === 'rescue') (f.pos[f.member.id] as any).rescuing = true
    else Object.assign(f.task, { kind })
    f.b.swarmExecuting = true
    assert.equal(swarmTurn(f.sw).preempt(f.b), false)
    f.b.swarmExecuting = false
    await f.run()
    assert.equal(f.calls.some(c => c.method === 'fight' || c.method === 'stop'), false)
    if (kind !== 'rescue') assert.ok(f.calls.some(c => c.method === kind))
  }
})

test('empty 12v12 start explores an affordable safe chest site before chasing equally bare enemies', async () => {
  const f = fixture()
  assert.equal(f.task.kind, 'fight', 'the existing relative equipment race sees equal bare teams')
  await f.run()
  const walk = f.calls.find(c => c.method === 'goto')
  assert.equal(walk?.params.x, -10, 'no chest is visible here: reach the safe chest site instead of chasing red')
  assert.equal(f.calls.some(c => c.method === 'fight' || c.method === 'pursue'), false)
})

test('an empty inventory still permits self defense in contact', async () => {
  const f = fixture({ gap: 3 })
  await f.run()
  assert.ok(f.calls.some(c => c.method === 'fight'))
  assert.equal(f.calls.some(c => c.method === 'goto'), false)
})

test('no accessible chest route leaves combat available', async () => {
  const f = fixture({ sites: [] })
  await f.run()
  assert.ok(f.calls.some(c => c.method === 'fight'))
})

test('a chest site requiring unavailable climbing blocks leaves combat available', async () => {
  const f = fixture({ sites: [{ x: -10, y: 90, z: .5, climbFrom: 64 }] })
  await f.run()
  assert.ok(f.calls.some(c => c.method === 'fight'))
  assert.equal(f.calls.some(c => c.method === 'goto'), false)
})

test('an equipped fighter keeps its attack instead of touring distant loot', async () => {
  const f = fixture({ inventory: { iron_sword: 1 } })
  await f.run()
  assert.ok(f.calls.some(c => c.method === 'fight'))
  assert.equal(f.calls.some(c => c.method === 'goto'), false)
})

for (const weapon of ['bow', 'crossbow']) {
  test(`an empty ${weapon} explores an accessible upper chest site instead of pursuing with fists`, async () => {
    const f = fixture({ inventory: { [weapon]: 1, cobblestone: 32 }, sites: [{ x: -10, y: 70, z: .5, climbFrom: 64 }] })
    await f.run()
    const walk = f.calls.find(c => c.method === 'goto')
    assert.equal(walk?.params.y, 70)
    assert.equal(f.calls.some(c => c.method === 'fight' || c.method === 'pursue'), false)
  })

  test(`a usable ${weapon} keeps its attack`, async () => {
    const f = fixture({ inventory: { [weapon]: 1, arrow: 1 } })
    await f.run()
    assert.ok(f.calls.some(c => c.method === 'fight'))
    assert.equal(f.calls.some(c => c.method === 'goto'), false)
  })
}

test('the observed attack-arrow count decides ranged usability', async () => {
  const empty = fixture({ inventory: { bow: 1, arrow: 1 }, attackArrows: 0 })
  await empty.run()
  assert.ok(empty.calls.some(c => c.method === 'goto'))
  assert.equal(empty.calls.some(c => c.method === 'fight'), false)
  const tipped = fixture({ inventory: { crossbow: 1, tipped_arrow: 1 }, attackArrows: 1 })
  await tipped.run()
  assert.ok(tipped.calls.some(c => c.method === 'fight'))
  assert.equal(tipped.calls.some(c => c.method === 'goto'), false)
})

test('a loaded offensive crossbow retains combat with no loose arrows, including the offhand', async () => {
  for (const inventory of [{ crossbow: 1 }, {}]) {
    const f = fixture({ inventory, attackArrows: 0, loadedCrossbow: true })
    await f.run()
    assert.ok(f.calls.some(c => c.method === 'fight'))
    assert.equal(f.calls.some(c => c.method === 'goto'), false)
  }
})

test('ordinary combat without the arms loot mode keeps its attack', async () => {
  const f = fixture({ arms: false })
  await f.run()
  assert.ok(f.calls.some(c => c.method === 'fight'))
  assert.equal(f.calls.some(c => c.method === 'goto'), false)
})

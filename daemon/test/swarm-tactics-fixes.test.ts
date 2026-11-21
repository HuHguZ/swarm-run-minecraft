import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, knownEnemies, pvpState } from '../src/swarm/board'
import { planPvp } from '../src/swarm/plan-pvp'
import { doctrineScores, keepDoctrine } from '../src/swarm/doctrine'
import { assessTeamFight } from '../src/swarm/fight'
import { pvpFrame, type PvpPlan } from '../src/swarm/plan-frame'
import { pvpFlee, pvpRecover } from '../src/swarm/plan-flee'
import { commitPlan } from '../src/swarm/plan-assign'
import { fountain } from '../src/swarm/plan-doctrines'
import type { SwarmMember } from '../src/swarm/types'

const p = (x = 0, y = 64, z = 0) => ({ x, y, z })
const member = (id: string, extra: Partial<SwarmMember> = {}): SwarmMember => ({
  id, team: 'blue', position: p(), health: 20, maxHealth: 20, strength: 60, role: 'fighter',
  weapon: 'iron_sword', inventory: { iron_sword: 1, cooked_beef: 4 }, armor: ['iron_boots', 'iron_leggings', 'iron_chestplate', 'iron_helmet'],
  ...extra
})

test('pruning expired armorSightings deletes empty inner maps and preserves remembered gear across occlusion', () => {
  let time = 1000
  const team = [member('a'), member('b', { position: p(10) })]
  const board = new SwarmBoard('blue', () => time, 3000)
  board.setMembers(team)
  board.observe('a', time, { id: 'foe', position: p(15), visible: true, equipment: { weapon: 'iron_sword', armor: ['iron_chestplate'] } })
  let enemies = knownEnemies(board)
  assert.deepEqual(enemies[0].equipment?.armor, ['iron_chestplate'])
  assert.equal(enemies[0].equipment?.unknownArmorSlots || 0, 0)

  // Enemy ducks behind a wall for > 3s while tracked by nametag: armorSightings expires and must not fabricate unknownArmorSlots=4.
  time = 2500
  board.observe('a', time, { id: 'foe', position: p(16), visible: false, nametag: true })
  time = 4500
  board.observe('a', time, { id: 'foe', position: p(17), visible: false, nametag: true })
  enemies = knownEnemies(board)
  assert.deepEqual(enemies[0].equipment?.armor, ['iron_chestplate'])
  assert.equal(enemies[0].equipment?.unknownArmorSlots || 0, 0)

  // Read-only views reflect live tasks and facts without clobbering public API.
  board.recordFact('a', time, { id: 'f1', kind: 'mark', position: p(1) }, 5000)
  board.upsert({ id: 't1', kind: 'goto', assignedTo: 'a', position: p(2) })
  assert.equal(board.factView('f1')?.id, 'f1')
  assert.equal(board.factsView().length, 1)
  assert.equal(board.taskView('t1')?.id, 't1')
  assert.equal(board.tasksView().length, 1)
})

test('pricedLoot refuses offers inside enemy threatReach outside endgame to stop loot-flee oscillation', () => {
  const time = 1000
  const naked = member('a', { position: p(0), strength: 20, weapon: undefined, inventory: {}, armor: [] })
  const allies = Array.from({ length: 4 }, (_, i) => member('b' + i, { position: p(40 + i) }))
  const team = [naked, ...allies]
  const board = new SwarmBoard('blue', () => time, 8000)
  board.setMembers(team)
  board.observe('a', time, { id: 'boss', position: p(10), visible: true, equipment: { weapon: 'netherite_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: true } })

  // Offer right next to the Netherite boss (distance 2 <= threatReach 16): must not assign loot!
  const riskyPlan = planPvp(board, team, {
    foesLeft: 8, quorum: 1,
    lootOffer: () => ({ position: p(8), tier: 5, seconds: 5 })
  })
  assert.notEqual(riskyPlan.get('a')?.kind, 'loot')

  // Safe distant offer far from boss (with allies nearby so group is not isolated/hopeless): gets loot!
  naked.position = p(36)
  const safePlan = planPvp(board, team, {
    foesLeft: 8, quorum: 1,
    lootOffer: () => ({ position: p(48), tier: 4, seconds: 5 })
  })
  assert.equal(safePlan.get('a')?.kind, 'loot')
})

test('keepDoctrine resists 1s crystal-swap fountain thrashing and brief jump wave oscillation; ring counts offhand shields', () => {
  let time = 1000
  const team = Array.from({ length: 6 }, (_, i) => member('b' + i, {
    position: p(i, 64, 0),
    role: i < 2 ? 'miner-builder' : i === 2 ? 'healer' : 'flank',
    canHeal: i === 2,
    offHand: 'shield',
    inventory: { iron_sword: 1, cobblestone: 32, wind_charge: 8 }
  }))
  const board = new SwarmBoard('blue', () => time, 8000)
  board.setMembers(team)

  // Offhand shield must boost ring score against bow threat.
  board.observe('b0', time, { id: 'e0', position: p(20, 64, 0), visible: true, threat: 'bow', equipment: { weapon: 'bow' } })
  const withOffhand = doctrineScores(board, team).ring
  const noShieldTeam = team.map(m => ({ ...m, offHand: undefined }))
  const withoutOffhand = doctrineScores(board, noShieldTeam).ring
  assert.ok(withOffhand > withoutOffhand, 'offhand shields contribute to ring score')

  // Crystal flash triggers fountain; swapping off crystal 1s later must NOT flip-flop immediately back to hunt.
  time = 2000
  board.observe('b0', time, { id: 'e0', position: p(20, 64, 0), visible: true, threat: 'blast', equipment: { weapon: 'end_crystal' } })
  assert.equal(keepDoctrine(board, team, false), 'fountain')
  time = 3000
  board.observe('b0', time, { id: 'e0', position: p(20, 64, 0), visible: true, threat: 'melee', equipment: { weapon: 'diamond_sword' } })
  assert.equal(keepDoctrine(board, team, false), 'fountain', 'brief crystal swap holds fountain instead of thrashing')

  // After 6s without blast threat, fountain can cleanly transition back.
  time = 9000
  board.observe('b0', time, { id: 'e0', position: p(20, 64, 0), visible: true, threat: 'melee', equipment: { weapon: 'diamond_sword' } })
  assert.notEqual(keepDoctrine(board, team, false), 'fountain')
})

test('fountain corridor lane stays bounded instead of drifting infinitely outward on repeated replans', () => {
  const team = Array.from({ length: 5 }, (_, i) => member('b' + i, { position: p(-2, 64, i === 0 ? 0 : (i % 2 ? 1 : -1) * 14) }))
  const board = new SwarmBoard('blue', () => 1000, 8000)
  board.setMembers(team)
  for (const id of ['b0', 'b1']) board.observe(id, 1000, { id: 'red', position: p(10, 64, 0), visible: true, velocity: p(-.3, 0, 0) })
  const plan = new Map()
  const S = pvpFrame({ board, options: { quorum: 2 }, team, state: pvpState(board), enemies: knownEnemies(board), aggressive: false, doctrine: 'fountain', plan } as PvpPlan)
  S.available = team
  S.now = 1000
  S.loads = new Map([['red', 0]])
  fountain(S)
  for (const m of team.slice(1)) {
    const t = plan.get(m.id)
    assert.equal(t?.data?.fountain, 'open')
    assert.ok(Math.abs(t.position.z) <= Math.abs(m.position.z) + 0.01, `${m.id} already past lane must not drift further outward`)
  }
})

test('pvpFlee floors coordinates for camp/box-failed keys and commitPlan diffs ramBox/ramWall/antidote/origin/block', () => {
  const time = 1000
  const m = member('a', { position: p(10.37, 64, 20.89), health: 5, inventory: { cobblestone: 16, iron_pickaxe: 1, iron_sword: 1 } })
  const allies = Array.from({ length: 4 }, (_, i) => member('b' + i, { position: p(80 + i, 64, 20) }))
  const team = [m, ...allies]
  const board = new SwarmBoard('blue', () => time, 8000)
  board.setMembers(team)
  board.observe('a', time, { id: 'ace', position: p(24, 72, 20.89), visible: true, threat: 'aerial', equipment: { weapon: 'netherite_spear', armor: ['netherite_boots', 'netherite_leggings', 'elytra', 'netherite_helmet'], enchanted: true } })
  const plan1 = planPvp(board, team, { quorum: 1 })
  const task1 = plan1.get('a')!
  assert.equal(task1.data?.ramBox, true)
  assert.equal(task1.data?.camp, '10,64,20', 'camp key is floored integer cell')

  // Claim the task, record box-failed at floored cell, and replan with 0.05-block drift -> must fall back to ramWall and commitPlan must replace the claim!
  const claimed = board.claim(task1.id, 'a', 5000)
  assert.ok(claimed)
  board.recordFact('a', time, { id: 'box-failed:a:10,64,20', kind: 'mark', position: p(10, 64, 20) }, 60000)
  m.position = p(10.42, 64, 20.84)
  const plan2 = planPvp(board, team, { quorum: 1 })
  const task2 = plan2.get('a')!
  assert.equal(task2.data?.ramBox, undefined)
  assert.equal(task2.data?.ramWall, true, 'box-failed lookup succeeds across sub-block drift and commitPlan updates ramBox -> ramWall')

  // Direct commitPlan diff check for antidote, antidoteCover, origin, direction, buildKind, block.
  const b2 = new SwarmBoard('blue', () => time, 8000)
  b2.setMembers([m])
  const baseTask: any = { id: 'pvp:a', kind: 'scout', assignedTo: 'a', position: p(5), data: { buildKind: 'cutoff', block: 'cobblestone', origin: p(5), direction: 'east' } }
  b2.upsert(baseTask)
  b2.claim('pvp:a', 'a', 5000)
  const updated: any = { ...baseTask, data: { ...baseTask.data, origin: p(8), direction: 'west' } }
  const out = commitPlan({ board: b2, plan: new Map([['a', updated]]) } as any)
  assert.deepEqual(out.get('a')?.data?.origin, p(8))
  assert.equal(out.get('a')?.data?.direction, 'west')
})

test('pvpRecover ignores occluded 8-bl enemies and honors recover-noop fact to break infinite eat loop', () => {
  const time = 1000
  // Occluded (nametag) enemy within 8 bl must not block recovery; recover-noop fact releases stalled food>=18 recover.
  const hurt = member('h', { position: p(0), health: 6, food: 20, inventory: { iron_sword: 1, cooked_beef: 4 } })
  const b2 = new SwarmBoard('blue', () => time, 8000)
  b2.setMembers([hurt])
  b2.observe('h', time, { id: 'wallFoe', position: p(5), visible: false, nametag: true })
  const planR1 = new Map()
  const SR1 = pvpFrame({ board: b2, options: {}, team: [hurt], state: pvpState(b2), enemies: knownEnemies(b2), aggressive: true, doctrine: 'hunt', plan: planR1 } as PvpPlan)
  SR1.hunting = () => false
  pvpRecover(SR1)
  assert.equal(planR1.get('h')?.kind, 'recover', 'wall-occluded nametag enemy within 8 bl does not block recovery')

  b2.recordFact('h', time, { id: 'recover-noop:h', kind: 'mark', position: p(0) }, 8000)
  const planR2 = new Map()
  const SR2 = pvpFrame({ board: b2, options: {}, team: [hurt], state: pvpState(b2), enemies: knownEnemies(b2), aggressive: true, doctrine: 'hunt', plan: planR2 } as PvpPlan)
  SR2.hunting = () => false
  pvpRecover(SR2)
  assert.equal(planR2.get('h'), undefined, 'recover-noop releases bot without instant heals from infinite recover loop')
})

test('assessTeamFight includes bow/crossbow inventory weapons and separates armor vs weapon enchant glints', () => {
  const archers = Array.from({ length: 4 }, (_, i) => member('arc' + i, {
    position: p(0, 64, i), weapon: undefined, inventory: { bow: 1, arrow: 32 }, attackArrows: 32, armor: ['iron_chestplate'], ench: { power: 4 }
  }))
  const foe: any = { id: 'foe', position: p(16, 64, 1), seenAt: 1000, sources: ['arc0'], equipment: { weapon: 'stone_sword', armor: [] } }
  const score = assessTeamFight(archers, [foe])
  assert.ok(score.theirLoss > 0.5, 'archers with bow + arrows in inventory deal real ranged damage instead of bare-fist 1 dmg')
})

test('strategic loot economy prices high-tier remaining chests for ally upgrade and denial over aimless clue search or idle reserve', () => {
  let time = 1000
  const fullNeth = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
  const team = [
    member('geared', { position: p(0), weapon: 'netherite_sword', inventory: { netherite_sword: 1 }, armor: fullNeth, strength: 100 }),
    member('ally1', { position: p(2), weapon: 'stone_sword', inventory: { stone_sword: 1 }, armor: ['leather_chestplate'], strength: 25 }),
    member('ally2', { position: p(4), weapon: 'netherite_sword', inventory: { netherite_sword: 1 }, armor: fullNeth, strength: 100 }),
    member('ally3', { position: p(6), weapon: 'netherite_sword', inventory: { netherite_sword: 1 }, armor: fullNeth, strength: 100 }),
    member('ally4', { position: p(8), weapon: 'netherite_sword', inventory: { netherite_sword: 1 }, armor: fullNeth, strength: 100 }),
  ]
  const board = new SwarmBoard('blue', () => time, 8000)
  board.setMembers(team)
  // Enemy seen once, then vanishes into stale clue (no active visible enemy).
  board.observe('geared', time, { id: 'foe', position: p(40), visible: true, equipment: { weapon: 'iron_sword', armor: [] } })
  time += 9000 // clue only, no active enemies
  const offer = { position: p(-12, 72, 0), tier: 4, seconds: 10 }
  const plan = planPvp(board, team, { foesLeft: 10, quorum: 1, lootOffer: () => offer })
  const gearedLooters = ['geared', 'ally2', 'ally3', 'ally4'].filter(id => plan.get(id)?.kind === 'loot')
  assert.ok(gearedLooters.length >= 1, 'geared bots secure remaining high-tier chest for team/denial instead of aimless search')
  assert.deepEqual(plan.get(gearedLooters[0])?.position, offer.position)
  // Team looters are capped so remaining geared allies still scout clues instead of whole team piling onto one chest.
  const looters = [...plan.values()].filter(t => t.kind === 'loot').length
  assert.ok(looters >= 2 && looters < team.length, `expected partial team loot allocation, got ${looters}/${team.length}`)
})

test('pvpFlee marks fledAt so pricedLoot enforces reach+6 hysteresis buffer and prevents flee-loot oscillation', () => {
  const time = 1000
  const runner = member('r', { position: p(0), health: 20, strength: 15, weapon: 'wooden_sword', inventory: { wooden_sword: 1 }, armor: [] })
  const allies = Array.from({ length: 4 }, (_, i) => member('b' + i, { position: p(40 + i) }))
  const team = [runner, ...allies]
  const board = new SwarmBoard('blue', () => time, 8000)
  board.setMembers(team)
  board.observe('r', time, { id: 'boss', position: p(8), visible: true, equipment: { weapon: 'netherite_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: true } })
  const plan1 = planPvp(board, team, { foesLeft: 8, quorum: 1 })
  assert.equal(plan1.get('r')?.kind, 'flee')

  // Runner steps to 19 bl from boss (> reach 16, but <= reach+6 = 22) and joins allies so hopeless clears:
  // pricedLoot must NOT immediately flip back to loot inside the reach+6 hysteresis buffer!
  runner.position = p(27)
  allies.forEach((a, i) => { a.position = p(28 + i) })
  const plan2 = planPvp(board, team, {
    foesLeft: 8, quorum: 1,
    lootOffer: () => ({ position: p(24), tier: 4, seconds: 5 })
  })
  assert.notEqual(plan2.get('r')?.kind, 'loot', 'fled bot respects reach+6 hysteresis buffer before resuming loot')
})

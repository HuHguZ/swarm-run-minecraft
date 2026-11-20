import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'
import { createDriverState } from '../../farm/swarm/swarm-driver/state'
import { swarmMoves } from '../../farm/swarm/swarm-driver/moves'
import { swarmLoot } from '../../farm/swarm/swarm-driver/loot'
import { assignFighters } from '../src/swarm/plan-assign'
import { pvpFrame } from '../src/swarm/plan-frame'
import { pvpTargets } from '../src/swarm/plan-doctrines'
import { pvpSectors } from '../src/swarm/plan-jobs'
import { pvpState } from '../src/swarm/board'

process.env.ARMS_CACHE_MEMORY = '0'
process.env.ARMS_CACHE_SEARCH = '0'
const p = (x = 0, y = 64, z = 0) => ({ x, y, z })
const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
const zone = { ...p(-20, 72), tier: 2 }
function scene(gap = 28, equipment: any = { armor: [] }) {
  const members: SwarmMember[] = Array.from({ length: 12 }, (_, i) => ({ id: 'B' + i, team: 'blue',
    position: p(0, 64, i / 10), health: 20, strength: i ? 100 : 20, role: 'fighter',
    inventory: i ? { netherite_sword: 1 } : {}, weapon: i ? 'netherite_sword' : undefined,
    armor: i ? armor : [], ench: i ? { sharpness: 5, protection: 16 } : {} }))
  const board = new SwarmBoard('blue', () => 1000)
  board.setMembers(members)
  board.observe('B1', 1000, { id: 'Red', position: p(gap), visible: true, velocity: p(-.3, 0), equipment })
  let offer: any = { position: zone, tier: zone.tier, seconds: 12 }
  const options: any = { foesLeft: 12, doctrine: 'fountain', quorum: 1, lootZones: [zone], lootOffer: () => offer }
  return { board, members, options, run: () => planPvp(board, members, options), offer: value => { offer = value } }
}

test('a concrete affordable upper loot offer keeps the bare fighter out of fountain; prepared allies intercept', () => {
  const f = scene(), tasks = f.run()
  assert.equal(tasks.get('B0')?.kind, 'loot')
  assert.deepEqual(tasks.get('B0')?.position, zone)
  assert.equal(tasks.get('B0')?.data?.lootTier, zone.tier)
  assert.equal(tasks.get('B0')?.data?.fountain, undefined)
  assert.ok(f.members.slice(1).every(m => tasks.get(m.id)?.data?.fountain), 'ready allies still perform the combat maneuver')
})

test('contact and an existing emergency retain priority over an upper loot offer', () => {
  const contact = scene(3)
  assert.notEqual(contact.run().get('B0')?.kind, 'loot')
  const hurt = scene()
  hurt.members[0].health = 2
  assert.notEqual(hurt.run().get('B0')?.kind, 'loot')
})

test('a stone sword and leather do not cancel upper loot when the rival has caught up', () => {
  const leather = ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots']
  const f = scene(28, { weapon: 'stone_sword', armor: leather })
  Object.assign(f.members[0], { inventory: { stone_sword: 1 }, weapon: 'stone_sword', armor: leather })
  const task = f.run().get('B0')!
  assert.equal(task.kind, 'loot')
  assert.equal(task.data?.weak, false, 'the price competes even after the old weak boolean has cleared')
})

test('winning stone and iron kits compare affordable upper loot with the price of attacking a naked rival', () => {
  for (const [weapon, material] of [['stone_sword', 'leather'], ['iron_sword', 'iron']]) {
    for (const seconds of [12, 200]) {
      const f = scene(28, { armor: [] })
      Object.assign(f.members[0], { inventory: { [weapon]: 1 }, weapon,
        armor: ['helmet', 'chestplate', 'leggings', 'boots'].map(slot => `${material}_${slot}`) })
      f.offer({ position: zone, tier: zone.tier, seconds })
      const task = f.run().get('B0')!
      if (seconds === 12) {
        assert.equal(task.kind, 'loot', `${weapon}: winning a naked duel cannot bypass an affordable upper improvement`)
        assert.equal(task.data?.weak, false)
        assert.equal(task.data?.lootTier, zone.tier)
      } else assert.ok(task.data?.fountain, `${weapon}: an expensive offer still leaves the winning combat available`)
    }
  }
})

test('no remaining route, a prohibitive price, or an absent runtime offer leaves fountain available', () => {
  for (const mode of ['empty', 'expensive', 'legacy']) {
    const f = scene()
    if (mode === 'empty') f.offer(null)
    if (mode === 'expensive') f.offer({ position: zone, tier: 2, seconds: 100000 })
    if (mode === 'legacy') delete f.options.lootOffer
    assert.ok(f.run().get('B0')?.data?.fountain, mode)
  }
  const f = scene()
  assert.equal(f.run().get('B0')?.kind, 'loot')
  f.offer(null)
  assert.ok(f.run().get('B0')?.data?.fountain, 'a previously chosen route cannot reserve the fighter after it disappears')
})

function upperReserveScene() {
  const f = scene(-28)
  Object.assign(f.members[0], f.members[1], { id: 'B0', position: p(65, 80), role: 'healer' })
  Object.assign(f.options, { doctrine: 'hunt', lootZones: [{ ...p(70, 72), tier: 1 }] })
  f.board.observe('B1', 1000, { id: 'Red', position: p(-28), visible: true, equipment: { weapon: 'stone_sword', armor: [] } })
  f.offer(null)
  return f
}

test('a ready reserve keeps its occupied upper loot area instead of descending toward the center', () => {
  const f = upperReserveScene(), task = f.run().get('B0')!
  assert.equal(task.data?.reserve, true)
  assert.deepEqual(task.position, p(65, 80))
})

test('ordinary reserve movement remains available below, far from or toward upper loot, and without zones', () => {
  for (const mode of ['below', 'far', 'toward', 'absent']) {
    const f = upperReserveScene()
    if (mode === 'below') f.members[0].position.y = 64
    if (mode === 'far') f.options.lootZones[0].x = 300
    if (mode === 'toward') f.options.lootZones[0].x = 0
    if (mode === 'absent') f.options.lootZones = []
    const task = f.run().get('B0')!
    assert.equal(task.data?.reserve, true, mode)
    assert.notDeepEqual(task.position, f.members[0].position, mode)
  }
})

test('holding an upper reserve does not replace contact, finishing or urgent retreat', () => {
  for (const mode of ['contact', 'finishing', 'hurt']) {
    const f = upperReserveScene()
    if (mode === 'finishing') f.options.foesLeft = 1
    if (mode === 'contact' || mode === 'hurt') f.board.observe('B1', 1000, {
      id: 'Red', position: p(62, 80), visible: true, equipment: { weapon: 'stone_sword', armor: [] }
    })
    if (mode === 'hurt') f.members[0].health = 2
    const task = f.run().get('B0')!
    assert.equal(task.data?.reserve, undefined, mode)
    if (mode === 'hurt') assert.ok(['flee', 'recover'].includes(task.kind), task.kind)
    else assert.equal(task.kind, 'fight', mode)
  }
})

test('an occupied upper reserve prices its return while a ready assigned ally covers the rival', () => {
  // I w/u/j geometry; earlier duties are fixed so this phase must count an ally before loads is filled.
  for (const mode of ['expensive', 'cheap', 'alone', 'late', 'contact', 'finishing', 'hurt']) {
    const f = scene(), guard = f.members[0], ally = f.members[1]
    Object.assign(guard, { id: 'NeuroFarm31w', position: p(580.5, 150.5, 545.4996132202406), health: 20, strength: 80,
      role: 'healer', inventory: { netherite_sword: 2 }, weapon: 'netherite_sword',
      armor: [...armor.slice(0, 3), 'leather_boots'], ench: { sharpness: 5, protection: 12 } })
    Object.assign(ally, { id: 'NeuroFarm31u', position: p(593, 125, 561), health: 20, strength: 80,
      inventory: { stone_sword: 1, netherite_axe: 1, netherite_spear: 1 }, weapon: 'netherite_axe', ench: { sharpness: 2, protection: 16 } })
    const foe: any = { id: 'NeuroFarm31j', position: p(581.6793496405181, 131.5358578109741, 558.4975019899514),
      sources: [ally.id, guard.id], seenAt: 1000, equipment: { weapon: 'iron_pickaxe', armor: ['iron_leggings', 'chainmail_helmet'] } }
    if (mode === 'contact') foe.position = p(581.5, 150.5, 545.5)
    const upper = { ...p(578.5, 150, 545.5), tier: 4 }
    const plan = new Map(f.members.slice(1).map(m => [m.id, { id: `pvp:${m.id}`, assignedTo: m.id, kind: 'loot' } as any]))
    plan.set(ally.id, { id: `pvp:${ally.id}`, assignedTo: ally.id, kind: mode === 'alone' ? 'loot' : 'fight', data: { target: foe.id } })
    if (mode === 'hurt') plan.set(guard.id, { id: `pvp:${guard.id}`, assignedTo: guard.id, kind: 'flee' })
    const pricing: any = { pos: Object.fromEntries([guard, ally].map(m => [m.id, { p: m.position, inv: m.inventory, armor: m.armor }])),
      arena: { x: 600.5, y: 120, z: 600.5, r: 80 }, blocked: () => false, lootSafe: () => true,
      ladderRoutes: mode === 'cheap' ? [{ key: 'ready', base: p(578.5, 132, 545.5), top: upper }] : [] }
    const moves = swarmMoves(pricing)
    const options: any = { foesLeft: mode === 'finishing' ? 1 : 12, quorum: 2, doctrine: 'hunt', lootZones: [upper],
      travelSeconds: (m, from, to) => { if (mode === 'late' && m.id === ally.id) return 200; const price = moves.travelCost({ name: m.id }, to, from); return Math.min(price.walk, price.fly) } }
    f.board.setMembers(f.members)
    const S: any = pvpFrame({ board: f.board, options, team: f.members, state: pvpState(f.board), enemies: [foe], aggressive: false, doctrine: 'hunt', plan } as any)
    pvpTargets(S); pvpSectors(S)
    Object.assign(S, { hunting: () => false, gatherers: new Set(), diggers: new Map(), ladderers: new Map(), campers: new Map() })
    assignFighters(S)
    const task = plan.get(guard.id)!
    if (mode === 'expensive') { assert.equal(task.data?.reserve, true); assert.deepEqual(task.position, guard.position) }
    else if (mode === 'hurt') assert.equal(task.kind, 'flee')
    else assert.equal(task.kind, 'fight', mode)
  }
})

test('tour offer is read-only and disappears on real emptiness, reservation, refusal or lack of climbing supplies', () => {
  const b = { name: 'A', team: 'blue', c: { call() { throw new Error('an offer cannot send RPC') } } }
  const pos = { A: { p: p(), hp: 20, inv: {}, armor: {} } }
  const sw: any = createDriverState({ bots: [b], pos, alive: () => true, arms: true, now: () => 1000,
    arena: { x: 0, y: 64, z: 0, r: 100 }, chestTops: [zone], log() {} })
  const board = new SwarmBoard('blue', sw.now)
  let refused = false
  Object.assign(sw, { boardOf: () => board, teamOf: () => 'blue', blocked: () => refused })
  Object.assign(sw, swarmMoves(sw))
  Object.assign(sw, swarmLoot(sw))
  assert.equal(typeof sw.lootOffer, 'function')
  assert.deepEqual(sw.lootOffer(b, board)?.position, zone)
  assert.equal(sw.toured.size, 0, 'pricing must not reserve a tour')
  sw.knownChests.set('blue', new Map([['chest:-20,72,0', { at: zone, report: { by: 'A', time: 1000, items: [] } }]]))
  assert.equal(sw.lootOffer(b, board), null)
  sw.refill(zone)
  sw.toured.set('blue', new Map([[0, { by: 'Other', at: 1000 }]]))
  assert.equal(sw.lootOffer(b, board), null)
  sw.toured.clear(); refused = true
  assert.equal(sw.lootOffer(b, board), null)
  refused = false
  sw.chestTops[0] = { ...zone, climbFrom: 64 }
  assert.equal(sw.lootOffer(b, board), null)
})

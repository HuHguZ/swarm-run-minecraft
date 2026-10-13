import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'

const p = (x = 0, y = 64, z = 0) => ({ x, y, z })
const NETHERITE = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
const member = (id: string, extra: Partial<SwarmMember> = {}): SwarmMember => ({ id, team: 'blue', position: p(), health: 20, strength: 80,
  role: 'fighter', weapon: 'netherite_sword', armor: NETHERITE, ench: { protection: 16, sharpness: 5 }, inventory: { netherite_sword: 1 }, ...extra })
function scene(members: SwarmMember[], time = 1000) {
  const board = new SwarmBoard('blue', () => time, 3000)
  board.setMembers(members)
  const see = (id: string, position, extra = {}) => { for (const m of members) board.observe(m.id, time, { id, position, visible: true, equipment: { weapon: 'wooden_sword', armor: [] }, ...extra }) }
  return { board, members, see, at: (t: number) => { time = t } }
}

test('line: the off-duty rank leaves even a close contact, the on-duty rank takes it', () => {
  const team = ['a', 'b', 'c'].map((id, i) => member(id, { position: p(i === 0 ? 3 : -2, 64, i) }))
  const f = scene(team, 1000)
  f.see('foe', p(4))
  const first = planPvp(f.board, team, { doctrine: 'line', quorum: 2 })
  assert.equal(first.get('a')!.kind, 'fight', 'rank 0 is on duty in the first shift')
  f.at(1000 + 22500); f.see('foe', p(4))
  const next = planPvp(f.board, team, { doctrine: 'line', quorum: 2 })
  assert.equal(next.get('a')!.kind, 'goto', 'the old front is in contact (1 block) and still rotates out')
  assert.equal(next.get('a')!.data!.line, 0)
  assert.equal(next.get('b')!.kind, 'fight')
  const solo = scene([member('a', { position: p(3) })])
  solo.see('foe', p(4))
  for (const t of [1000, 23500, 46000]) { solo.at(t); solo.see('foe', p(4)); assert.equal(planPvp(solo.board, solo.members, { doctrine: 'line' }).get('a')!.kind, 'fight', 'a lone fighter is always on duty') }
})

test('ring: shield bearers hold their ring spot facing outward, the wounded recovers in the middle', () => {
  const team = [member('a', { health: 10 }), member('b', { role: 'healer', canHeal: true, inventory: { splash_potion: 4 } }),
    ...['c', 'd', 'e', 'f'].map((id, i) => member(id, { position: p(Math.cos(i * Math.PI / 2) * 3, 64, Math.sin(i * Math.PI / 2) * 3), offHand: 'shield' })),
    member('g', { position: p(0, 64, 2), inventory: { netherite_sword: 1, shield: 1 } })]
  const f = scene(team)
  f.see('archer', p(12), { equipment: { weapon: 'bow', armor: [] }, threat: 'bow' })
  const plan = planPvp(f.board, team, { doctrine: 'ring', quorum: 2 })
  assert.equal(plan.get('a')!.kind, 'recover')
  const center = { x: team.reduce((s, m) => s + m.position.x, 0) / team.length, z: team.reduce((s, m) => s + m.position.z, 0) / team.length }
  assert.ok(Math.hypot(plan.get('a')!.position!.x - center.x, plan.get('a')!.position!.z - center.z) < .1, 'the wounded stands in the very middle')
  for (const id of ['c', 'd', 'e', 'f', 'g']) {
    const t = plan.get(id)!
    assert.equal(t.data!.hold, 'shield', `${id} holds the shield wall (worn or carried shield)`)
    const out = { x: t.position!.x - center.x, z: t.position!.z - center.z }, face = { x: t.data!.face.x - t.position!.x, z: t.data!.face.z - t.position!.z }
    assert.ok(out.x * face.x + out.z * face.z > 0, `${id} faces away from the middle`)
  }
  const melee = scene(team)
  melee.see('archer', p(12), { equipment: { weapon: 'bow', armor: [] }, threat: 'bow' }); melee.see('brute', p(3.5, 64, 0))
  assert.notEqual(planPvp(melee.board, team, { doctrine: 'ring', quorum: 2 }).get('c')!.data!.hold, 'shield', 'a guard in melee contact fights instead of holding')
})

test('fountain: a charge opens a lane to both sides, a passed predator is encircled from behind', () => {
  const team = Array.from({ length: 8 }, (_, i) => member('b' + i, { position: p(-2, 64, (i - 3.5) * 1.5) }))
  const f = scene(team)
  f.see('red', p(10), { velocity: p(-.3, 0, 0) })
  const open = planPvp(f.board, team, { doctrine: 'fountain', quorum: 2 })
  for (const m of team) {
    const t = open.get(m.id)!
    assert.equal(t.data!.fountain, 'open')
    assert.ok(Math.abs(t.position!.z) >= 4.9, `${m.id} clears the lane`)
    assert.ok(Math.abs(t.position!.z) >= Math.abs(m.position.z) + 1.4, `${m.id} steps outward`)
    assert.ok(Math.sign(t.position!.z) === Math.sign(m.position.z), `${m.id} keeps its own side`)
  }
  f.see('red', p(-6), { velocity: p(-.3, 0, 0) })
  const close = planPvp(f.board, team, { doctrine: 'fountain', quorum: 2 })
  const spots = team.map(m => close.get(m.id)!)
  assert.ok(spots.every(t => t.kind === 'fight' && t.data!.fountain === 'close' && t.data!.target === 'red'))
  assert.ok(spots.some(t => t.position!.x > -6 + 2), 'someone closes behind the charge (it ran toward -x)')
  const sectors = new Set(spots.map(t => Math.floor(((Math.atan2(t.position!.z, t.position!.x + 6) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI / 3))))
  assert.equal(sectors.size, 3, 'the encirclement covers three sectors around the predator')
})

test('false weakness: one flank per side waits ahead of the pocket and strikes once the chaser is inside', () => {
  const team = [member('bait', { health: 14, strength: 40 }), member('h', { role: 'healer', canHeal: true, inventory: { splash_potion: 4 } }),
    member('L', { role: 'flank', position: p(-1, 64, -5) }), member('R', { role: 'flank', position: p(-1, 64, 5) }), member('x', { position: p(-2) })]
  const f = scene(team)
  f.see('red', p(11))
  const wait = planPvp(f.board, team, { doctrine: 'false-weakness', quorum: 2 })
  assert.equal(wait.get('bait')!.data!.bait, true)
  for (const [id, sign] of [['L', -1], ['R', 1]] as const) {
    const t = wait.get(id)!
    assert.equal(t.data!.hold, 'ambush')
    assert.ok(t.position!.x > 1, `${id} waits ahead, at the mouth of the pocket`)
    assert.ok(sign * t.position!.z >= 4, `${id} waits on its own side`)
  }
  f.see('red', p(-1))
  const strike = planPvp(f.board, team, { doctrine: 'false-weakness', quorum: 2 })
  for (const id of ['L', 'R']) { assert.equal(strike.get(id)!.kind, 'fight'); assert.equal(strike.get(id)!.data!.target, 'red') }
})

test('hunt and cocoon: every builder shares one site while the target stays, a moved target gets a new one', () => {
  const builders = (extra = {}) => [member('m1', { role: 'miner-builder', inventory: { cobblestone: 64, netherite_sword: 1 }, ...extra }), member('m2', { role: 'miner-builder', position: p(0, 64, 3), inventory: { cobblestone: 64, netherite_sword: 1 } }), member('f1'), member('f2')]
  const team = builders()
  const f = scene(team)
  f.see('red', p(8.5, 64, .5))
  const first = planPvp(f.board, team, { doctrine: 'hunt', quorum: 2 })
  const site = first.get('m1')!.data!.origin
  assert.deepEqual(first.get('m2')!.data!.origin, site, 'both builders get the same cutoff site')
  f.see('red', p(9.7, 64, .9))
  assert.deepEqual(planPvp(f.board, team, { doctrine: 'hunt', quorum: 2 }).get('m2')!.data!.origin, site, 'a target still short of the wall keeps the site')
  f.see('red', p(14, 64, .5))
  assert.deepEqual(planPvp(f.board, team, { doctrine: 'hunt', quorum: 2 }).get('m1')!.data!.origin, site, 'a target just past the wall keeps it (drivers push it back)')
  f.see('red', p(22.5, 64, .5))
  assert.notDeepEqual(planPvp(f.board, team, { doctrine: 'hunt', quorum: 2 }).get('m1')!.data!.origin, site, 'a target gone further than 10 blocks gets a new site')
})

test('cocoon: until sealed nobody strikes the target, guards stand at the slit exits; sealed — they strike', () => {
  const team = [member('m1', { role: 'miner-builder', position: p(4, 64, -3), inventory: { cobblestone: 64, netherite_sword: 1 } }), member('m2', { role: 'miner-builder', position: p(4, 64, 3), inventory: { cobblestone: 64, netherite_sword: 1 } }),
    member('g1', { position: p(-2) }), member('g2', { position: p(-2, 64, 1.5) }), member('g3', { position: p(-2, 64, -1.5) }), member('g4', { role: 'flank', position: p(-2, 64, 3) }), member('g5', { position: p(-2, 64, -3) })]
  const f = scene(team)
  f.see('red', p(8.5, 64, .5))
  const plan = planPvp(f.board, team, { doctrine: 'cocoon', quorum: 2 })
  assert.deepEqual(plan.get('m1')!.data!.origin, { x: 8, y: 64, z: 0 })
  const guards = ['g1', 'g2', 'g3', 'g4', 'g5'].map(id => plan.get(id)!)
  assert.ok(guards.every(t => t.kind !== 'fight'), 'no one provokes the target before the cocoon closes')
  const exits = guards.filter(t => t.data!.hold === 'cordon').map(t => `${t.position!.x},${t.position!.z}`).sort()
  assert.deepEqual(exits, ['10.5,0.5', '6.5,0.5', '8.5,-1.5', '8.5,2.5'].sort(), 'both slit exits and both sides are guarded')
  for (const t of f.board.tasks().filter(t => t.id.startsWith('pvp:'))) f.board.cancel(t.id)
  const cell = { x: 9, y: 66, z: 0 }
  f.board.upsert({ id: 'build:cocoon:8,64,0:c', kind: 'build', position: cell, data: { blueprint: 'cocoon:8,64,0', block: 'cobblestone' } })
  const claim = f.board.claim('build:cocoon:8,64,0:c', 'm1')!
  f.board.ack(claim.id, 'm1', { token: claim.claim.token, confirmed: true, position: cell, block: 'cobblestone' })
  f.see('red', p(8.5, 64, .5))
  const sealed = planPvp(f.board, team, { doctrine: 'cocoon', quorum: 2 })
  assert.ok(['g1', 'g2', 'g3', 'g4', 'g5'].some(id => sealed.get(id)!.kind === 'fight' && sealed.get(id)!.data!.cordon), 'a sealed cocoon is struck through its slits')
})

test('false weakness: until the trap springs the rest of the team stays passive behind the bait', () => {
  const team = [member('bait', { health: 14, strength: 40 }), member('h', { role: 'healer', canHeal: true, inventory: { splash_potion: 4 } }),
    member('L', { role: 'flank', position: p(-1, 64, -5) }), member('R', { role: 'flank', position: p(-1, 64, 5) }), member('x', { position: p(-2) }), member('y', { position: p(-2, 64, 1) })]
  const f = scene(team)
  f.see('red', p(11))
  const wait = planPvp(f.board, team, { doctrine: 'false-weakness', quorum: 2 })
  for (const id of ['x', 'y']) { assert.equal(wait.get(id)!.kind, 'goto'); assert.equal(wait.get(id)!.data!.feintGuard, true); assert.ok(wait.get(id)!.position!.x < 0, `${id} waits behind`) }
  for (const m of team) m.position = { ...m.position, x: m.position.x + 4 }
  f.see('red', p(9))
  const moved = planPvp(f.board, team, { doctrine: 'false-weakness', quorum: 2 })
  assert.equal(moved.get('L')!.data!.hold, 'ambush', 'the anchor stays put: a team drifting forward does not spring the trap early')
  f.see('red', p(1))
  const sprung = planPvp(f.board, team, { doctrine: 'false-weakness', quorum: 2 })
  for (const id of ['L', 'R']) assert.equal(sprung.get(id)!.kind, 'fight')
  assert.ok(['x', 'y'].every(id => sprung.get(id)!.data!.feintGuard !== true), 'once sprung, the rest joins the fight')
})

test('panic: a flee holds for three game seconds while the risk estimate flickers at its threshold', () => {
  const hurt = member('a', { health: 3 })
  const f = scene([hurt], 1000)
  f.see('foe', p(2), { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } })
  assert.equal(planPvp(f.board, f.members).get('a')!.kind, 'flee', 'three hearts against an enchanted netherite sword')
  hurt.health = 20
  f.at(1500); f.see('foe', p(2))
  assert.equal(planPvp(f.board, f.members).get('a')!.kind, 'flee', 'the next estimate is safe, but the flee is not cut after 0.5 s')
  f.at(4500); f.see('foe', p(2))
  assert.notEqual(planPvp(f.board, f.members).get('a')!.kind, 'flee', 'after 3 s of safe estimates the flee ends')
})

test('risk: allies who can arrive in time count as helpers even if only one of them sees the foes', () => {
  const { assessSwarmFight } = require('../src/swarm')
  const IRON = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
  const team = [['a', 0, 0], ['b', -5, 1], ['c', -5, -1], ['d', -6, 0]].map(([id, x, z]) => member(id as string, { position: p(x as number, 64, z as number), weapon: 'iron_sword', armor: IRON, ench: {}, inventory: { iron_sword: 1 } }))
  const board = new SwarmBoard('blue', () => 1000, 3000)
  board.setMembers(team)
  for (let i = 0; i < 3; i++) board.observe('a', 1000, { id: 'r' + i, position: p(4, 64, i - 1), visible: true, equipment: { weapon: 'iron_sword', armor: IRON } })
  const risk = assessSwarmFight(team[0], board.enemies(), team)
  assert.equal(risk.ready, 4, 'the shared board tells every ally where the foes are')
  assert.equal(risk.unsafe, false, 'four against three is not a reason to flee')
})

test('risk: six armed allies take turns against one stronger foe instead of all fleeing from it', () => {
  const { assessSwarmFight } = require('../src/swarm')
  const IRON = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], DIAMOND = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
  const risk = (n: number) => {
    const team = Array.from({ length: n }, (_, i) => member('b' + i, { position: p(0, 64, i - n / 2), weapon: 'iron_sword', armor: IRON, ench: {}, inventory: { iron_sword: 1 } }))
    const board = new SwarmBoard('blue', () => 1000, 3000)
    board.setMembers(team)
    for (const m of team) board.observe(m.id, 1000, { id: 'foe', position: p(4), visible: true, equipment: { weapon: 'diamond_sword', armor: DIAMOND } })
    return assessSwarmFight(team[0], board.enemies(), team)
  }
  assert.equal(risk(1).unsafe, true, 'alone, iron loses to diamond')
  assert.equal(risk(6).unsafe, false, 'the foe hits one of six at a time; the wounded rotate out')
})

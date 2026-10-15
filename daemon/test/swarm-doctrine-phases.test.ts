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
  const corks = team.filter(m => open.get(m.id)!.data!.fountain === 'cork')
  assert.equal(corks.length, 1, 'one cork stands in the lane')
  const cork = open.get(corks[0].id)!.position!
  assert.ok(cork.x < -2 - 5 && Math.abs(cork.z) < 1, 'the cork waits on the axis far past the centre, where the charge ends')
  for (const m of team.filter(m => m !== corks[0])) {
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
  const ahead = planPvp(f.board, team, { doctrine: 'hunt', quorum: 2 }).get('m1')!.data!.origin
  assert.ok(ahead.x > 14, 'a target that already ran past the wall gets a new wall ahead of it, even an unfinished one')
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
  // Враг в 14 бл. — дальше местного боя (12 бл.): решает личная оценка, и липкость видна в чистом виде.
  const hurt = member('a', { health: 3 })
  const f = scene([hurt], 1000)
  f.see('foe', p(14), { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } })
  assert.equal(planPvp(f.board, f.members).get('a')!.kind, 'flee', 'three hearts against an enchanted netherite sword')
  hurt.health = 20
  f.at(1500); f.see('foe', p(14))
  assert.equal(planPvp(f.board, f.members).get('a')!.kind, 'flee', 'the next estimate is safe, but the flee is not cut after 0.5 s')
  f.at(4500); f.see('foe', p(14))
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

test('hunt: the cutoff leads a sprinting target by its speed and stands across its run', () => {
  const team = [member('m1', { role: 'miner-builder', inventory: { cobblestone: 64, netherite_sword: 1 } }), member('m2', { role: 'miner-builder', position: p(0, 64, 3), inventory: { cobblestone: 64, netherite_sword: 1 } }), member('f1'), member('f2')]
  const f = scene(team)
  // Бежит на юг (по +z) со скоростью спринта: 0.28 бл/тик = 5.6 бл/с.
  f.see('red', p(8.5, 64, .5), { velocity: { x: 0, y: 0, z: .28 } })
  const task = planPvp(f.board, team, { doctrine: 'hunt', quorum: 2 }).get('m1')!
  assert.equal(task.data!.direction, 'south', 'the wall stands across the run, not across the line to our formation')
  assert.equal(task.data!.origin.x, 8)
  assert.ok(task.data!.origin.z >= 8, 'about 1.5 s of the run ahead (5.6 b/s), not 3 blocks')
})

test('fight to the finish: equal or slightly fewer fight on, a crushed group regroups, and an unseen enemy is hunted', () => {
  const IRON = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], gear = { equipment: { weapon: 'iron_sword', armor: IRON } }
  const side = (n: number) => Array.from({ length: n }, (_, i) => member('b' + i, { position: p(0, 64, i * 1.5), weapon: 'iron_sword', armor: IRON, ench: {}, inventory: { iron_sword: 1 } }))
  const against = (n: number, foes: number) => {
    const f = scene(side(n))
    for (let i = 0; i < foes; i++) f.see('r' + i, p(5, 64, i * 1.5), gear)
    return { f, plan: planPvp(f.board, f.members, { quorum: 2 }) }
  }
  for (const [n, foes] of [[6, 6], [6, 7]]) {
    const { plan } = against(n, foes)
    assert.ok([...plan.values()].every(t => t.kind !== 'flee'), `${n} against ${foes}: the swarm fights instead of hiding`)
  }
  const { f, plan } = against(3, 6)
  assert.ok([...plan.values()].every(t => t.kind === 'flee'), 'three against six would be wiped while six keep three: regroup')
  // Враги пропали из вида: свои идут туда, где их видели последним, а не лутают и не стоят дозором.
  const hunt = scene(side(4))
  hunt.see('r0', p(20, 64, 0), gear)
  planPvp(hunt.board, hunt.members, { quorum: 2 })
  hunt.at(1000 + 9000)
  const later = planPvp(hunt.board, hunt.members, { quorum: 2 })
  assert.ok([...later.values()].every(t => t.kind === 'goto' && t.data!.hunt && t.data!.enemyPosition.x > 15), 'armed members hunt the last known enemy position')
  void f
  // Одиночка против двоих, а свои — в стороне: бежит к своим (перегруппировка), а не прочь от врага.
  const crowd = [member('lone', { position: p(0), weapon: 'iron_sword', armor: IRON, ench: {}, inventory: { iron_sword: 1 } }),
    ...Array.from({ length: 4 }, (_, i) => member('g' + i, { position: p(-20, 64, i), weapon: 'iron_sword', armor: IRON, ench: {}, inventory: { iron_sword: 1 } }))]
  const g = scene(crowd)
  for (const [i, z] of [-1, 1].entries()) g.see('r' + i, p(4, 64, z), gear)
  const lone = planPvp(g.board, crowd, { quorum: 2 }).get('lone')!
  assert.equal(lone.kind, 'flee')
  assert.equal(lone.data!.regroup, true, 'outnumbered alone: regroup')
  assert.ok(lone.position!.x < -15, 'toward the allies, not just away from the foes')
})

test('hp estimate: the board keeps the lowest honest upper bound across allies, and the team fight uses it', () => {
  const { assessTeamFight } = require('../src/swarm')
  const IRON = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], gear = { equipment: { weapon: 'iron_sword', armor: IRON } }
  const team = ['a', 'b'].map((id, i) => member(id, { position: p(0, 64, i * 1.5), weapon: 'iron_sword', armor: IRON, ench: {}, inventory: { iron_sword: 1 } }))
  const board = new SwarmBoard('blue', () => 1000, 3000)
  board.setMembers(team)
  for (const [i, hit] of [[0, 12], [1, 7]] as const) board.observe(team[i].id, 1000, { id: 'r0', position: p(4), visible: true, ...gear, hpEstimate: hit } as any)
  board.observe('a', 1000, { id: 'r1', position: p(4, 64, 1.5), visible: true, ...gear })
  const [r0, r1] = board.enemies()
  assert.equal(r0.hpEstimate, 7, 'each ally knows only its own hits: the lowest upper bound wins')
  assert.equal('hpEstimate' in r1, false, 'no confirmed hits — no estimate (the fight assumes 20)')
  const fresh = assessTeamFight(team, [{ ...r0, hpEstimate: undefined }, r1]), hurt = assessTeamFight(team, [r0, r1])
  assert.ok(hurt.ourLoss < fresh.ourLoss, 'a foe already at 7 dies sooner and hurts us less')
})

test('натиск против людей: вооружённые все в бой, голый вплотную дерётся, на 5–16 бл. — за спины своих, вдали лутается', () => {
  const naked = { weapon: undefined, armor: [], ench: { protection: 0, sharpness: 0 }, inventory: {} }
  const team = [member('a', { position: p(0) }), member('a2', { position: p(-4) }), member('a3', { position: p(-6) }),
    member('b', { ...naked, position: p(-2) }), member('c', { ...naked, position: p(30) }), member('d', { ...naked, position: p(8) }),
    member('w', { health: 5, position: p(9) })]
  const f = scene(team)
  f.see('human', p(10), { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } })
  const plan = planPvp(f.board, team, { quorum: 1, aggressive: true, hideouts: [p(-20), p(40)] })
  for (const id of ['a', 'a2', 'a3']) assert.equal(plan.get(id)!.kind, 'fight', `${id}: без резерва, на незерит идут все вооружённые`)
  assert.equal(plan.get('b')!.kind, 'flee')
  assert.ok(plan.get('b')!.data!.regroup, 'свои рядом — к ним, а не в комнату')
  assert.ok(plan.get('b')!.position.x < -4, 'за спины своих, по другую сторону от врага')
  assert.equal(plan.get('c')!.kind, 'loot')
  assert.equal(plan.get('d')!.kind, 'fight', 'вплотную не убежать — драться')
  assert.equal(plan.get('w')!.kind, 'fight', 'раненый у врага под носом не бежит и не ест')
  assert.ok(!['false-weakness', 'false-retreat', 'cocoon', 'line', 'ring', 'weak-center'].includes(f.board.doctrineState()!.doctrine))
})

test('штурм: четверо готовых — все на цель, голые и раненые тоже; потери без урона — отбой и перегруппировка', () => {
  const naked = { weapon: undefined, armor: [], ench: { protection: 0, sharpness: 0 }, inventory: {} }
  const team = [...['a1', 'a2', 'a3', 'a4'].map((id, k) => member(id, { position: p(-k * 2) })), member('b', { ...naked, position: p(-2, 64, 1) }), member('w', { health: 5, position: p(-8) })]
  const f = scene(team)
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  f.see('human', p(10), human)
  const plan = planPvp(f.board, team, { quorum: 1, aggressive: true, hideouts: [p(-20), p(40)] })
  assert.ok(f.board.assault, 'штурм объявлен')
  assert.deepEqual(f.board.assault!.voters.sort(), ['a1', 'a2', 'a3', 'a4'])
  for (const id of ['a1', 'a2', 'a3', 'a4', 'w']) assert.equal(plan.get(id)!.kind, 'fight', `${id}: в штурме все снаряжённые бьют, и раненые`)
  assert.equal(plan.get('b')!.kind, 'flee', 'голый в штурм не идёт — уходит за спины своих (на 12 бл.)')
  f.at(5000); f.see('human', p(10), human)
  const left = team.filter(m => !['a2', 'a3', 'a4'].includes(m.id))
  const after = planPvp(f.board, left, { quorum: 1, aggressive: true, hideouts: [p(-20), p(40)] })
  assert.equal(f.board.assault, null)
  assert.equal(f.board.assaultEnded!.why, 'проигрываем')
  assert.equal(after.get('a1')!.kind, 'flee', 'перегруппировка: не в схватке — в укрытие')
  assert.ok(after.get('a1')!.data!.hide)
})

test('натиск: к двум людям по одному не идут — к своим, а не кольцом; топор без брони — слабый; голый без своих — в укрытие', () => {
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  const team = [member('a', { position: p(0) }), ...['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((id, k) => member(id, { position: p(-60 - k * 2) })),
    member('axe', { weapon: 'stone_axe', armor: [], ench: { protection: 0, sharpness: 0 }, inventory: { stone_axe: 1 }, position: p(26, 64, 12) })]
  const f = scene(team)
  f.see('h1', p(20), human); f.see('h2', p(20, 64, 3), human)
  const plan = planPvp(f.board, team, { quorum: 1, aggressive: true, hideouts: [p(40, 64, 30), p(-80)] })
  assert.equal(plan.get('a')!.kind, 'goto', 'один из готовых у двух людей — не в бой')
  assert.ok(plan.get('a')!.data!.stage)
  // Сбор — на своём секторе кольца в 10 бл. от цели, со своей стороны (14.10: «кучкуются в точке — зельями и молнией их толпой»).
  assert.ok(Number.isInteger(plan.get('a')!.data!.slot), 'у сбора свой сектор')
  assert.ok(Math.abs(Math.hypot(plan.get('a')!.position.x - 20, plan.get('a')!.position.z) - 10) < 0.5 && plan.get('a')!.position.x < 20, 'место — в 10 бл. от цели, со стороны бота')
  assert.equal(f.board.assault, null, 'топор без брони не голосует за штурм')
  assert.equal(plan.get('axe')!.kind, 'flee', 'с одним топором без брони к людям не идёт')
  assert.ok(plan.get('axe')!.data!.hide, 'своих рядом нет — в укрытие')
  assert.deepEqual(plan.get('axe')!.position, p(40, 64, 30))
  // Собрались — идут все разом.
  const crowd = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'].map((id, k) => member(id, { position: p(8, 64, k * 2 - 5) }))
  const g = scene(crowd)
  g.see('h1', p(20), human); g.see('h2', p(20, 64, 3), human)
  const go = planPvp(g.board, crowd, { quorum: 1, aggressive: true })
  for (const m of crowd) assert.equal(go.get(m.id)!.kind, 'fight', `${m.id}: шестеро на двоих — все в бой`)
})

test('натиск: слабый с элитрами и ракетами — на насест подальше от людей; на насесте сидит, пока враг в 28 бл.; без ракет — нет', () => {
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  const flyer = member('fly', { weapon: undefined, armor: [], ench: { protection: 0, sharpness: 0 }, inventory: { elytra: 1, firework_rocket: 8, bow: 1, arrow: 16 }, position: p(0) })
  const grounded = member('walk', { weapon: undefined, armor: [], ench: { protection: 0, sharpness: 0 }, inventory: { elytra: 1, firework_rocket: 1 }, position: p(0, 64, 2) })
  const perches = [p(12, 66, 0), p(-20, 82, 0), p(-30, 90, 30)]
  const f = scene([flyer, grounded])
  f.see('h', p(10), human)
  const plan = planPvp(f.board, [flyer, grounded], { quorum: 1, aggressive: true, perches, hideouts: [p(-40)] })
  assert.equal(plan.get('fly')!.kind, 'flee')
  assert.ok(plan.get('fly')!.data!.perch)
  assert.deepEqual(plan.get('fly')!.position, p(-20, 82, 0), 'насест в 2 бл. от него не годится; из дальних — ближний к себе')
  assert.ok(!plan.get('walk')!.data!.perch, 'одна ракета — не долететь')
  const up = member('fly', { ...flyer, position: p(-20, 82, 0) })
  const g = scene([up])
  g.see('h', p(-5), human)
  const stay = planPvp(g.board, [up], { quorum: 1, aggressive: true, perches })
  assert.equal(stay.get('fly')!.kind, 'flee', 'враг в 28 бл. — с насеста не слезать за лутом')
  assert.deepEqual(stay.get('fly')!.position, p(-20, 82, 0))
})

test('ва-банк: человек с оценкой хп ≤ 10 — все вооружённые в 32 бл. на него, без сбора и без лечения; безоружный — нет', () => {
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true }, hpEstimate: 6, velocity: p(.3, 0, 0) }
  const naked = { weapon: undefined, armor: [], ench: { protection: 0, sharpness: 0 }, inventory: {} }
  const team = [member('lone', { position: p(0) }), member('hurt', { health: 5, position: p(-5) }), member('stick', { ...naked, inventory: { wooden_sword: 1 }, position: p(-3, 64, 3) }),
    member('bare', { ...naked, position: p(-2, 64, -3) }), member('far', { position: p(-40) })]
  const f = scene(team)
  f.see('h', p(20), human)
  const plan = planPvp(f.board, team, { quorum: 1, aggressive: true, hideouts: [p(-30)] })
  for (const id of ['lone', 'hurt', 'stick']) { assert.equal(plan.get(id)!.kind, 'fight', `${id}: добивать`); assert.equal(plan.get(id)!.data!.target, 'h') }
  assert.ok(!plan.get('hurt')!.data!.panic, 'раненый с оружием не бежит и не лечится — добивает')
  assert.notEqual(plan.get('bare')!.kind, 'fight', 'без оружия — не на добивание')
})

test('проигрываем: живых не больше трёх на каждого врага — кто не в схватке, прячется (шифт), вплотную — бой', () => {
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  const team = [member('a', { position: p(0) }), member('b', { position: p(5) }), member('c', { position: p(16) })]
  const f = scene(team)
  f.see('h', p(20), human)
  const plan = planPvp(f.board, team, { quorum: 1, aggressive: true, hideouts: [p(-30), p(60)] })
  for (const id of ['a', 'b']) { assert.equal(plan.get(id)!.kind, 'flee', id); assert.ok(plan.get(id)!.data!.hide, id); assert.deepEqual(plan.get(id)!.position, p(-30)) }
  assert.equal(plan.get('c')!.kind, 'fight', 'в 4 бл. — не убежать, бой')
})

test('окружение: шестеро на одного — разные секторы вокруг цели в 2.5 бл.; у обрыва бьют с другой стороны; блоков нет — добытчики из слабых по дефициту', () => {
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  const crowd = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'].map((id, k) => member(id, { position: p(32, 64, k * 2 - 5) }))
  const g = scene(crowd)
  g.see('h', p(20), human)
  const plan = planPvp(g.board, crowd, { quorum: 1, aggressive: true })
  const slots = crowd.map(m => plan.get(m.id)!.data!.slot)
  assert.ok(new Set(slots).size >= 5, `разные секторы, а не одна толпа: ${slots}`)
  for (const m of crowd) assert.ok(Math.abs(Math.hypot(plan.get(m.id)!.position.x - 20, plan.get(m.id)!.position.z) - 2.5) < 0.01, 'место — в 2.5 бл. от цели')
  // Обрыв у цели на восток (+x), бьющие с востока: большинство уходит на западные секторы — удар отбросит его в обрыв.
  const e = scene(crowd)
  e.see('h', p(20), human)
  const edge = planPvp(e.board, crowd, { quorum: 1, aggressive: true, edgeOf: () => ({ x: 1, z: 0 }) })
  const west = crowd.filter(m => Math.cos(edge.get(m.id)!.data!.slot * Math.PI / 4) < 0.01).length
  assert.ok(west >= 4, `с другой стороны от обрыва ${west} из 6`)
  // Цель наверху, у лезущих нет блоков (дефицит 50): добытчиков ⌈50/32⌉ = 2 — слабые, ближние к месту добычи.
  const naked = { weapon: undefined, armor: [], ench: { protection: 0, sharpness: 0 }, inventory: {} }
  const team = [member('f1', { position: p(10) }), member('f2', { position: p(10, 64, 3) }),
    ...[-10, -20, -30, -40].map((x, k) => member(`w${k}`, { ...naked, position: p(x) }))]
  const t = scene(team)
  t.see('h', p(20, 94), human)
  const work = planPvp(t.board, team, { quorum: 1, aggressive: true, gather: { item: 'sand', deficit: 50, spot: p(0) } })
  const gatherers = team.filter(m => work.get(m.id)!.data?.gather === 'sand').map(m => m.id)
  assert.deepEqual(gatherers, ['w0', 'w1'], 'двое ближних к песку слабых — копать')
})

test('лестница для команды: столб своего у цели наверху — ставит тот, у кого хватит лестниц (или брёвен), не в схватке', () => {
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  const team = [member('far', { position: p(-30), inventory: { netherite_sword: 1, ladder: 32 } }), member('near', { position: p(-6), inventory: { netherite_sword: 1 } }),
    member('logs', { position: p(-10), inventory: { netherite_sword: 1, oak_log: 4 } }), ...['f1', 'f2', 'f3'].map(id => member(id, { position: p(0, 64, 5) }))]
  const f = scene(team)
  f.see('h', p(0, 94, 20), human)
  const site = { key: '0,0', x: 0, y: 64, z: 18, top: 90, face: { x: 0, z: -1 } }
  const plan = planPvp(f.board, team, { quorum: 1, aggressive: true, ladderSites: [site] })
  const who = team.filter(m => plan.get(m.id)!.data?.ladder === '0,0').map(m => m.id)
  assert.deepEqual(who, ['far'], 'на 28 ступеней хватает только 32 лестниц (4 бревна ≈ 12)')
})

test('ямы: быстрые цели первыми, по 1–2 копателя, впереди движения и с разносом 3', () => {
  const team = Array.from({ length: 24 }, (_, i) => member('d' + i, { position: p(Math.floor(i / 8) * 30 + (i % 8 < 4 ? -3.6 : 3.6), 64, 0), inventory: { netherite_sword: 1, netherite_pickaxe: 1 } }))
  const f = scene(team)
  f.see('a-slow', p(0), { velocity: p(0, 0, 0) })
  f.see('m-mid', p(60), { velocity: p(0, 0, .2) })
  f.see('z-fast', p(30), { velocity: p(-.4, 0, 0) })
  const options = { aggressive: true, doctrine: 'buffalo' as const, digSites: q => [-5, -4, -2, 2, 5].map(dx => ({ x: q.x + dx, y: 63, z: 0, feetY: 64, handMs: Infinity })) }
  const digs = plan => [...plan.values()].filter(t => t.data?.dig)
  const first = digs(planPvp(f.board, team, options))
  const counts = Object.fromEntries(['a-slow', 'm-mid', 'z-fast'].map(id => [id, first.filter(t => t.data.target === id).length]))
  assert.deepEqual(counts, { 'a-slow': 1, 'm-mid': 1, 'z-fast': 2 })
  assert.deepEqual(first.filter(t => t.data.target === 'z-fast').map(t => t.position.x).sort((a, b) => a - b), [25, 28])
  for (const a of first) for (const b of first) if (a !== b) assert.ok(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) >= 3)
  const assignments = ts => ts.map(t => [t.assignedTo, t.data.target, t.data.dig]).sort()
  assert.deepEqual(assignments(digs(planPvp(f.board, team, options))), assignments(first), 'начатые ямы не меняют хозяина')
  const g = scene(team)
  g.see('a-empty', p(0))
  g.see('z-fast', p(30), { velocity: p(-.4, 0, 0) })
  const next = digs(planPvp(g.board, team, { ...options, digSites: q => q.x === 0 ? [] : options.digSites(q) }))
  assert.equal(next.length, 2)
  assert.ok(next.every(t => t.data.target === 'z-fast'))
  const solo = scene(team)
  solo.see('z-fast', p(30), { velocity: p(-.4, 0, 0) })
  assert.equal(digs(planPvp(solo.board, team, options)).length, 4)
})

test('натиск: после первого сундука (кожа, каменный меч) на незеритового не идёт — уходит; загнанный дерётся; алмазный — в бою', () => {
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  const leather = { weapon: 'stone_sword', armor: ['leather_helmet', 'leather_chestplate'], ench: { protection: 0, sharpness: 0 }, inventory: { stone_sword: 1 } }
  const diamond = { weapon: 'diamond_sword', armor: ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'], ench: { protection: 0, sharpness: 0 }, inventory: { diamond_sword: 1 } }
  const team = [member('l', { ...leather, position: p(10, 64, 14) }), member('lc', { ...leather, position: p(7) }),
    ...['d1', 'd2', 'd3', 'd4'].map((id, k) => member(id, { ...diamond, position: p(2, 64, k * 2 - 3) }))]
  const f = scene(team)
  f.see('human', p(10), human)
  const plan = planPvp(f.board, team, { quorum: 1, aggressive: true, hideouts: [p(-30), p(40)] })
  assert.notEqual(plan.get('l')!.kind, 'fight', 'кожа с каменным мечом в 14 бл. от незерита — не в бой')
  assert.ok(['flee', 'loot'].includes(plan.get('l')!.kind))
  assert.equal(plan.get('lc')!.kind, 'fight', 'в 3 бл. не убежать — драться')
  for (const id of ['d1', 'd2', 'd3', 'd4']) assert.equal(plan.get(id)!.kind, 'fight', `${id}: алмаз против незерита — бой`)
  assert.ok(!f.board.assault?.voters.includes('l'), 'переигранный за штурм не голосует')
})

test('погоня: слабые свои, отход в контакте, лут после отрыва', () => {
  for (const crowded of [false, true]) for (const naked of [false, true]) {
    const bare = { weapon: undefined, armor: [], inventory: {}, ench: { protection: 0, sharpness: 0 } }
    const gear = naked ? bare : { ...bare, weapon: 'stone_sword',
      armor: ['leather_helmet', 'leather_chestplate'], inventory: { stone_sword: 1 } }
    const team = [member('a', gear), ...['b', 'c', 'd'].map((id, k) =>
      member(id, crowded ? { ...bare, position: p(-5, 64, k * 2 - 2) } : { position: p(-60 - k * 2) }))]
    const f = scene(team), human = {
      equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true }
    }
    const options = { aggressive: true, quorum: 1, hideouts: [p(-20)] }
    f.see('human', p(10), { ...human, velocity: p(-.28, 0, 0) })
    let task = planPvp(f.board, team, options).get('a')!
    assert.equal(task.kind, 'flee'); assert.ok(task.data!.kite)
    assert.equal(task.data!.regroup, crowded); assert.ok(!task.data!.hide)

    f.at(1500); f.see('human', p(4), { ...human, velocity: p(0, 0, 0) })
    task = planPvp(f.board, team, options).get('a')!
    assert.equal(task.kind, 'flee'); assert.ok(task.data!.kite)

    f.at(2000); f.see('human', p(30), { ...human, velocity: p(0, 0, 0) })
    assert.equal(planPvp(f.board, team, options).get('a')!.kind, 'loot')

    // Гистерезис по дистанции, без срока: лутающий уходит с 16, убежавший лутается только дальше 22 (Codex 15.10).
    for (const [t, x, kind] of [[2500, 21, 'loot'], [3000, 15, 'flee'], [3500, 21, 'flee'], [60000, 21, 'flee'], [60500, 23, 'loot']] as const) {
      f.at(t)
      f.see('human', p(x), { ...human, velocity: p(-.28, 0, 0) })
      assert.equal(planPvp(f.board, team, options).get('a')!.kind, kind, `${t} мс, ${x} бл.`)
    }
  }
})

test('натиск: 40 своих — экипированная группа бьёт незеритового, голые не голосуют', () => {
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  for (const [material, equipped, fighters] of [[null, 0, 0], ['leather', 20, 20], ['iron', 10, 10], ['diamond', 10, 10]] as const) {
    const team = Array.from({ length: 40 }, (_, i) => {
      const mat = i < equipped ? material : null
      const weapon = mat ? `${mat === 'leather' ? 'stone' : mat}_sword` : undefined
      return member(`b${i}`, { position: p(-14 + i % 5 * 1.25, 64, -4.375 + Math.floor(i / 5) * 1.25),
        strength: mat ? 80 : 20, weapon, armor: mat ? ['helmet', 'chestplate', 'leggings', 'boots'].map(s => `${mat}_${s}`) : [],
        ench: { sharpness: 0, protection: 0 }, inventory: weapon ? { [weapon]: 1 } : {} })
    })
    const f = scene(team), options = { aggressive: true, quorum: 2, hideouts: [p(-30, 64, -10), p(-30, 64, 10)] }
    for (const moving of [false, true]) {
      f.at(moving ? 1500 : 1000)
      f.see('human', p(), { ...human, velocity: p(moving ? -.28 : 0, 0, 0) })
      const plan = [...planPvp(f.board, team, options).values()]
      assert.equal(plan.filter(t => t.kind === 'fight').length, fighters, `${material}: число атакующих`)
      assert.equal(f.board.assault?.voters.length ?? 0, fighters, `${material}: число голосов`)
      if (moving) assert.equal(plan.filter(t => t.data?.kite).length, 40 - fighters, 'голые продолжают уходить от погони')
    }
  }
})

test('переигранный: потеря видимости не превращает подготовку обратно в охоту', () => {
  const bare = { weapon: undefined, armor: [], ench: { sharpness: 0, protection: 0 }, inventory: {}, strength: 20 }
  const team = Array.from({ length: 40 }, (_, i) => member(`b${i}`, { ...bare, position: p(-i % 5, 64, Math.floor(i / 5)) }))
  team[0] = member('b0', { ...bare, weapon: 'stone_sword', armor: ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots'], inventory: { stone_sword: 1 }, strength: 80 })
  const f = scene(team), options = { aggressive: true, quorum: 2 }
  f.see('human', p(10), { velocity: p(-.28, 0, 0), equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } })
  assert.equal(planPvp(f.board, team, options).get('b0')!.data!.kite, true)
  let plan
  for (let t = 1500; t <= 10000; t += 500) { f.at(t); plan = planPvp(f.board, team, options) }
  assert.equal(plan.get('b0')!.kind, 'loot')
  f.at(10500)
  f.see('human', p(10), { velocity: p(-.28, 0, 0), equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } })
  assert.equal(planPvp(f.board, team, options).get('b0')!.data!.kite, true, 'одиночка по-прежнему избегает сильного')
})

test('натиск: слабый у границы 5 бл. не мигает «бой ↔ укрытие» — убегавший дерётся с 3.5, дерущийся уходит дальше 6', () => {
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  const team = [member('w', { weapon: undefined, armor: [], ench: { protection: 0, sharpness: 0 }, inventory: {}, position: p(0) })]
  const f = scene(team), options = { quorum: 1, aggressive: true, hideouts: [p(-40)] }
  const at = (t: number, x: number) => { f.at(t); f.see('human', p(x), human); return planPvp(f.board, team, options).get('w')!.kind }
  assert.equal(at(1000, 4.5), 'fight', 'вплотную — бой')
  assert.equal(at(1500, 5.5), 'fight', 'дерущийся не бросает бой на 5.5')
  assert.equal(at(2000, 7), 'flee', 'дальше 6 — уходит')
  assert.equal(at(2500, 4.5), 'flee', 'убегавший на 4.5 продолжает уходить')
  assert.equal(at(3000, 3), 'fight', 'вплотную (3.5) — бой')
})

test('fled: reset, departure and death clear the latch; child cancellation does not', () => {
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  const options = { aggressive: true, quorum: 1, hideouts: [p(-40)] }
  for (const reset of ['round', 'leave', 'death', 'child']) {
    const team = [member('a', { weapon: undefined, armor: [], inventory: {}, ench: {} }), ...['b', 'c', 'd'].map((id, i) => member(id, { position: p(-80 - i * 5) }))]
    const f = scene(team)
    f.see('human', p(15), human)
    assert.equal(planPvp(f.board, team, options).get('a')!.kind, 'flee')
    if (reset === 'round') f.board.resetRound()
    if (reset === 'leave') f.board.setMembers(team.slice(1))
    if (reset === 'death') f.board.setMembers(team.map(m => m.id === 'a' ? { ...m, health: 0 } : m))
    f.board.cancel('pvp:a')
    f.board.setMembers(team); f.at(61000); f.see('human', p(20), human)
    assert.equal(planPvp(f.board, team, options).get('a')!.kind, reset === 'child' ? 'flee' : 'loot', reset)
  }
})

function assaultScene(extra: Partial<SwarmMember> = {}) {
  const team = Array.from({ length: 8 }, (_, i) => member('a' + i, { position: p(-i % 3, 64, Math.floor(i / 3)), ...extra }))
  const f = scene(team), options = { aggressive: true, quorum: 1, doctrine: 'buffalo' as const, hideouts: [p(-40)] }
  const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
  f.see('human', p(10), human)
  planPvp(f.board, team, options)
  assert.ok(f.board.assault)
  return { ...f, options, human }
}

test('assault: neither 45 seconds nor loss of sightings ends the episode', () => {
  const f = assaultScene(), since = f.board.assault!.since
  f.at(61000); f.see('human', p(10), f.human)
  planPvp(f.board, f.members, f.options)
  assert.equal(f.board.assault!.since, since, 'the same assault continues past its former deadline')
  f.at(121000)
  const search = planPvp(f.board, f.members, f.options)
  assert.equal(f.board.assault!.since, since, 'unknown is not eliminated')
  assert.ok([...search.values()].every(t => t.kind !== 'fight'), 'an unseen target is searched for')
  f.at(122000); f.see('human', p(60), f.human)
  planPvp(f.board, f.members, f.options)
  assert.equal(f.board.assault, null, 'a fresh target outside every original voter\'s reach ends the assault')
})

test('assault: losses without modeled damage abort; a hit buys continuation, not perpetual permission', () => {
  const f = assaultScene()
  f.at(1500); f.see('human', p(10), { ...f.human, hpEstimate: 18 })
  planPvp(f.board, f.members.slice(1), f.options)
  assert.ok(f.board.assault, 'the loss coincides with real progress by our hit model')
  f.at(2000); f.see('human', p(10), { ...f.human, hpEstimate: 18 })
  planPvp(f.board, f.members.slice(2), f.options)
  assert.ok(f.board.assault, 'one loss without damage is not yet a lost exchange (стенд 15.10: провал за 5 с)')
  f.at(2500); f.see('human', p(10), { ...f.human, hpEstimate: 18 })
  planPvp(f.board, f.members.slice(5), f.options)
  assert.equal(f.board.assault, null, 'four losses of eight voters since the last hit stop this exchange')
  assert.equal(f.board.assaultEnded!.why, 'проигрываем')
})

test('assault: after a failure the swarm retries once the survivors have healed, not after 40 seconds', () => {
  const f = assaultScene()
  const survivors = f.members.slice(4)
  for (const m of survivors) m.health = 13
  f.at(1500); f.see('human', p(10), f.human)
  planPvp(f.board, survivors, f.options)
  assert.equal(f.board.assault, null, 'four losses without damage end the exchange')
  f.at(61000); f.see('human', p(10), f.human)
  const regroup = planPvp(f.board, survivors, f.options)
  assert.equal(f.board.assault, null, 'wounded survivors regroup however long it takes')
  assert.ok([...regroup.values()].every(t => t.kind !== 'fight'), 'regroup outlasts the former 25 seconds')
  for (const m of survivors) m.health = 20
  f.see('human', p(10), f.human)
  planPvp(f.board, survivors, f.options)
  assert.ok(f.board.assault, 'healed survivors return to the fight (пользователь 14.10: до конца, отход — подлечиться)')
})

test('assault: a weaker target, improved equipment or another target permit a new attempt immediately', () => {
  for (const change of ['hurt', 'gear', 'other']) {
    const f = assaultScene({ ench: {} })
    for (const m of f.members) m.health = 13
    f.at(1500); f.see('human', p(10), f.human)
    planPvp(f.board, f.members.slice(4), f.options)
    assert.equal(f.board.assault, null)
    f.board.setMembers(f.members)
    if (change === 'gear') f.members[0].ench = { protection: 16, sharpness: 5 }
    f.see('human', p(10), { ...f.human, ...(change === 'hurt' ? { hpEstimate: 12 } : {}) })
    if (change === 'other') f.see('other', p(9), f.human)
    planPvp(f.board, f.members, f.options)
    assert.ok(f.board.assault, change)
    assert.equal(f.board.assault!.target, change === 'other' ? 'other' : 'human')
  }
})

test('assault: the last participant leaving ends the attempt and a round reset clears its failure', () => {
  const f = assaultScene()
  f.at(1500)
  planPvp(f.board, [], f.options)
  assert.equal(f.board.assault, null)
  assert.equal(f.board.assaultEnded!.lost, 8)
  f.board.resetRound(); f.board.setMembers(f.members)
  f.see('human', p(10), f.human)
  planPvp(f.board, f.members, f.options)
  assert.ok(f.board.assault, 'a new round never inherits a failed balance')
})

test('assault: partial equipment and a missing hp estimate do not prove the failed target became weaker', () => {
  for (const hp of [undefined, 30]) {
    const f = assaultScene()
    if (hp !== undefined) {
      f.board.resetRound(); f.board.setMembers(f.members)
      f.see('human', p(10), { ...f.human, hpEstimate: hp })
      planPvp(f.board, f.members, f.options)
    }
    for (const m of f.members) m.health = 13
    f.at(1500); f.see('human', p(10), { ...f.human, ...(hp !== undefined ? { hpEstimate: hp } : {}) })
    planPvp(f.board, f.members.slice(4), f.options)
    assert.equal(f.board.assault, null)
    f.board.setMembers(f.members)
    f.see('human', p(10), { equipment: {} })
    planPvp(f.board, f.members, f.options)
    assert.equal(f.board.assault, null, 'unknown fields are not observed upgrades to the balance')
  }
})

test('lite: pursuit keeps the existing loot 16 / other task 22 boundary', () => {
  for (const [previous, x, expected] of [['loot', 20, 'loot'], ['flee', 20, 'flee'], ['flee', 23, 'loot']] as const) {
    const team = [member('a', { weapon: undefined, armor: [], inventory: {}, ench: {} }), ...['b', 'c', 'd'].map((id, i) => member(id, { position: p(-80 - i * 5) }))]
    const f = scene(team), options = { aggressive: true, quorum: 1 }
    const human = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
    if (previous === 'flee') { f.see('human', p(15), human); planPvp(f.board, team, options) }
    f.board.upsert({ id: 'pvp:a', kind: previous, assignedTo: 'a', position: p() })
    f.see('human', p(x), { ...human, velocity: p(-.28, 0, 0) })
    assert.equal(planPvp(f.board, team, options).get('a')!.kind, expected)
  }
})

test('lite: roof fight, older-sighting search and invisible-target hunt keep the old contract', () => {
  for (const doctrine of ['hunt', 'wave'] as const) {
    const team = ['a', 'b', 'c'].map(id => member(id)), f = scene(team)
    const options = { aggressive: true, quorum: 1, doctrine }
    f.see('roof', p(8, 70))
    for (const [now, kind] of [[1000, 'fight'], [1600, 'goto'], [5000, 'goto']] as const) {
      f.at(now)
      for (const task of planPvp(f.board, team, options).values()) {
        assert.equal(task.kind, kind, doctrine + ': ' + now)
        assert.equal(!!task.data!.search, kind === 'goto')
        assert.deepEqual(task.data!.enemyPosition, p(8, 70))
        assert.equal(task.data!.climb, undefined)
        assert.equal(task.data!.targetSeenAt, undefined)
        if (now === 5000) { assert.equal(task.data!.hunt, true); assert.equal(task.data!.target, undefined) }
      }
    }
  }
})

test('lite: diggers and ladderers still require current sightings', () => {
  const team = [member('builder', { inventory: { netherite_sword: 1, ladder: 32 } }),
    member('digger', { position: p(4.5, 70, 1.7), inventory: { netherite_sword: 1, netherite_pickaxe: 1 } }), member('a')]
  const f = scene(team), options = { aggressive: true, quorum: 1, doctrine: 'wave' as const,
    digSites: () => [{ x: 6, y: 69, z: 0, feetY: 70, handMs: Infinity }],
    ladderSites: [{ key: '6,0', x: 6, y: 64, z: 0, top: 69, face: { x: -1, z: 0 } }] }
  f.see('roof', p(8, 70))
  const first = planPvp(f.board, team, options)
  assert.equal(first.get('builder')!.data!.ladder, '6,0')
  assert.equal(first.get('digger')!.data!.dig, '6,69,0')
  f.at(5000)
  for (const task of planPvp(f.board, team, options).values()) {
    assert.equal(task.data!.dig, undefined)
    assert.equal(task.data!.ladder, undefined)
  }
})

test('assault: out of reach needs a fresh observation and every original voter', () => {
  const f = assaultScene()
  f.members[0].position = p(60)
  f.see('human', p(60), f.human)
  planPvp(f.board, f.members, f.options)
  assert.ok(f.board.assault, 'one original voter can still reach the target')
  f.members[0].position = p()
  f.members.push(member('newcomer', { position: p(60) }))
  f.at(2000)
  planPvp(f.board, f.members, f.options)
  assert.ok(f.board.assault, 'a stale position cannot prove departure')
  f.at(2001); f.see('human', p(60), f.human)
  planPvp(f.board, f.members, f.options)
  assert.equal(f.board.assault, null, 'a newcomer does not replace the original voters')
  assert.equal(f.board.assaultEnded!.why, 'вне досягаемости')
})

test('assault: a recorded departure remains a loss after the same member returns', () => {
  const f = assaultScene()
  f.board.setMembers(f.members.slice(4))
  f.board.setMembers(f.members)
  f.at(1500); f.see('human', p(10), f.human)
  planPvp(f.board, f.members, f.options)
  assert.equal(f.board.assault, null, 'a respawn between plans does not erase the world loss')
  assert.equal(f.board.assaultEnded!.why, 'проигрываем')
})

test('outmatched: preparation lasts thirty seconds, then the old hunt resumes', () => {
  const team = [member('a', { weapon: 'stone_sword', armor: ['leather_helmet', 'leather_chestplate'], inventory: { stone_sword: 1 }, ench: {} }),
    ...['b', 'c', 'd'].map((id, i) => member(id, { position: p(-80 - i * 5) }))]
  const f = scene(team), options = { aggressive: true, quorum: 1 }
  f.see('human', p(15), { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } })
  planPvp(f.board, team, options)
  f.at(10000); f.board.cancel('pvp:a')
  assert.equal(planPvp(f.board, team, options).get('a')!.kind, 'loot')
  f.at(31000); f.board.cancel('pvp:a')
  const resumed = planPvp(f.board, team, options).get('a')!
  assert.equal(resumed.kind, 'goto', 'the former thirty-second refusal expires without a gear upgrade')
  assert.equal(resumed.data!.hunt, true)
})

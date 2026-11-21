import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'
import { doctrineScores } from '../src/swarm/doctrine'

function scene() {
  let now = 1000
  const board = new SwarmBoard('blue', () => now)
  const members: SwarmMember[] = Array.from({ length: 20 }, (_, i) => ({
    id: 'p' + String(i).padStart(2, '0'), team: 'blue', role: 'fighter', health: i % 3 ? 20 : 11,
    strength: 60, position: { x: -(i % 3), y: 64, z: Math.floor(i / 3) - 3 },
    weapon: 'iron_sword', armor: { torso: 'iron_chestplate' }, inventory: { iron_sword: 1 }
  }))
  board.setMembers(members)
  const see = (weapon = 'iron_sword', extra = {}, x = 7) => {
    for (const m of members) board.observe(m.id, now, { id: 'foe', position: { x, y: 64, z: 0 },
      visible: true, equipment: { weapon }, ...extra })
  }
  const plan = () => planPvp(board, members, { foesLeft: 20 })
  return { board, members, see, plan, later: (ms: number) => { now += ms } }
}

test('twenty fighters switch from buffalo to lines when an exhausted front can actually exchange places', () => {
  const f = scene()
  f.members.forEach(m => { m.health = 20 })
  f.see(); f.plan()
  assert.equal(f.board.doctrineState()?.doctrine, 'buffalo')
  f.members.forEach((m, i) => { if (i % 3 === 0) m.health = 11 })
  const plan = f.plan()
  assert.equal(f.board.doctrineState()?.doctrine, 'line')
  const relieved = f.members.filter((_, i) => i % 3 === 0).map(m => plan.get(m.id)!)
  assert.ok(relieved.every(t => t.kind === 'goto' && t.data?.reserve && t.data.rotation === 1))
  assert.ok(f.members.some((m, i) => i % 3 === 1 && plan.get(m.id)?.kind === 'fight'))
  assert.equal(f.plan().get('p00')?.data?.rotation, 1, 'the next unchanged plan keeps the new front')
})

test('lines need a directly observed fight, a ready relief rank and an effective exchange', () => {
  for (const mode of ['fresh', 'equal', 'away', 'overhead', 'busy', 'no enemy', 'clue', 'old', 'threat far', 'armoured hero']) {
    const f = scene()
    for (const [i, m] of f.members.entries()) {
      if (mode === 'fresh') m.health = 20
      if (mode === 'equal') m.health = 11
      if (mode === 'away' && i % 3 !== 0) m.position.x = -80
      if (mode === 'overhead' && i % 3 !== 0) m.position.y += 30
      if (mode === 'busy' && i % 3 === 1) m.workingBlocks = true
      if (mode === 'armoured hero') { m.inventory = {}; delete m.weapon; m.armor = {}; m.strength = m.health }
    }
    if (mode === 'armoured hero') f.see('netherite_sword', { equipment: { weapon: 'netherite_sword', enchanted: true,
      armor: ['netherite_chestplate', 'netherite_leggings', 'netherite_helmet', 'netherite_boots'] } })
    else if (mode !== 'no enemy') f.see('iron_sword', mode === 'clue' ? { visible: false, nametag: true } : {}, mode === 'threat far' ? 100 : 7)
    if (mode === 'old') f.later(1500)
    const plan = f.plan()
    assert.equal(doctrineScores(f.board, f.members).line, 3, mode)
    assert.notEqual(f.board.doctrineState()?.doctrine, 'line', mode)
    if (mode === 'armoured hero') {
      assert.ok([...plan.values()].some(t => t.kind === 'flee'))
      assert.ok([...plan.values()].every(t => t.kind !== 'fight'))
    }
  }
})

test('ten shields and a healer defend the ring against a bow even when the front is tired', () => {
  const f = scene()
  f.members.slice(0, 10).forEach(m => { m.offHand = 'shield'; m.inventory!.shield = 1 })
  Object.assign(f.members[19], { role: 'healer', canHeal: true })
  f.see('bow', { threat: 'bow' }, 13)
  const plan = f.plan()
  assert.equal(f.board.doctrineState()?.doctrine, 'ring')
  assert.ok([...plan.values()].some(t => t.data?.hold === 'shield'))
})

test('a nearby healthy row can relieve the front when the other reserves cannot reach it', () => {
  for (const axis of ['x', 'y'] as const) {
    const f = scene()
    f.members.forEach((m, i) => { if (i % 3 === 1) m.position[axis] += axis === 'x' ? -80 : 30 })
    f.see()
    const plan = f.plan()
    assert.equal(f.board.doctrineState()?.doctrine, 'line')
    assert.ok(f.members.some((m, i) => i % 3 === 2 && plan.get(m.id)?.kind === 'fight'))
  }
})

test('a nearby nametag or glow leaves a witnessed fight available for line relief', () => {
  for (const clue of ['nametag', 'glowing']) for (const id of ['screened', 'foe']) {
    const f = scene()
    f.see()
    f.later(100)
    f.board.observe('p02', f.board.now(), { id, position: { x: 0, y: 64, z: 0 }, visible: false, [clue]: true })
    const plan = f.plan()
    assert.equal(f.board.doctrineState()?.doctrine, 'line', clue + ' ' + id)
    assert.ok(plan.get('p00')?.data?.reserve)
    assert.ok([...plan.values()].some(t => t.kind === 'fight' && t.data.target === 'foe'))
    assert.equal(f.board.lastKnownEnemy()?.position.x, 0)
    f.later(1001)
    assert.equal(doctrineScores(f.board, f.members).line, 3)
  }
})

test('a through-wall clue cannot start or indefinitely prolong a close fight', () => {
  const f = scene()
  Object.assign(f.members[0], { role: 'healer', canHeal: true })
  const update = (direct: boolean, x: number) => f.board.observe('p00', f.board.now(), {
    id: 'foe', position: { x, y: 64, z: -3 }, visible: direct, nametag: !direct
  })
  const feint = () => doctrineScores(f.board, f.members)['false-weakness']
  update(false, 2)
  assert.ok(feint() > 0)
  update(true, 2)
  assert.equal(feint(), 0)
  f.later(200)
  update(true, 9)
  assert.equal(feint(), 0)
  f.later(200)
  update(false, 3)
  assert.equal(feint(), 0, 'a brief loss of sight should not reset the fight')
  f.later(f.board.enemyTtlMs)
  update(false, 2)
  assert.ok(feint() > 0)
})

test('a remote lookout and a past life cannot report a melee for the fighter behind a wall', () => {
  const f = scene(), point = { x: 1, y: 64, z: -3 }
  Object.assign(f.members[0], { role: 'healer', canHeal: true })
  f.members[19].position.x = 40
  f.board.setMembers(f.members)
  const see = source => f.board.observe(source, f.board.now(), { id: 'foe', visible: true, position: point })
  const feint = () => doctrineScores(f.board, f.members)['false-weakness']
  see('p19')
  assert.ok(feint() > 0)
  see('p00')
  f.board.setMembers(f.members.map(m => m.id === 'p00' ? { ...m, health: 0 } : m))
  f.board.setMembers(f.members)
  assert.ok(feint() > 0)
  see('p00')
  assert.equal(feint(), 0)
})

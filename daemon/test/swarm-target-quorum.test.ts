import test from 'node:test'
import assert from 'node:assert/strict'
import { planPvp, SwarmBoard, type SwarmMember } from '../src/swarm'
import { createSwarmDriver } from '../../farm/swarm/swarm-driver'

function scene(size = 8) {
  let now = 10000
  const at = (x: number) => ({ x, y: 120, z: 0 })
  const team: SwarmMember[] = Array.from({ length: size }, (_, i) => ({ id: `b${i}`, team: 'blue',
    role: 'fighter', position: at(i < 2 ? 15 : -8 - i), strength: 80, health: 20,
    weapon: 'netherite_sword', inventory: { netherite_sword: 1 },
    armor: ['netherite_boots', 'netherite_leggings', 'netherite_chestplate', 'netherite_helmet'] }))
  const board = new SwarmBoard('blue', () => now, 3000)
  board.setMembers(team)
  const see = (i: number, id: string, x: number, extra = {}, seenAt = now) =>
    board.observe(team[i].id, seenAt, { id, position: at(x), visible: true, ...extra })
  const plan = () => planPvp(board, team, { quorum: 2, doctrine: 'wave', aggressive: true, foesLeft: 2 })
  return { team, board, see, plan, tick: (delta = 1) => { now += delta } }
}

test('different opponents, tags and glows cannot vote each other into a team assault', () => {
  const f = scene()
  f.see(0, 'A', 16); f.see(1, 'B', 18)
  f.see(2, 'A', 16, { visible: false, nametag: true }); f.see(3, 'A', 16, { visible: false, glowing: true })
  const first = f.plan()
  assert.equal(f.board.assault, null)
  assert.equal(first.get('b0')?.kind, 'fight'); assert.equal(first.get('b0')?.data?.target, 'A')
  const remote = [...first.values()].filter(t => !['b0','b1'].includes(t.assignedTo!))
  assert.ok(remote.every(t => t.kind !== 'fight'))
  assert.ok(remote.filter(t => t.data?.searchEnemy === 'A').length <= 1)
  assert.ok(remote.some(t => t.data?.searchEnemy), 'a second scout can investigate the tip')
  f.tick(); f.see(2, 'B', 18)
  const consent = f.plan()
  assert.equal(f.board.assault?.target, 'B', 'a nearer independent A report cannot borrow B voters')
  assert.ok([...consent.values()].some(t => t.data?.target === 'B' && t.data?.committed))
  assert.ok([...consent.values()].every(t => !t.data?.assault || t.data?.target === 'B'))
  f.tick(); f.see(3, 'B', 100, { visible: false, nametag: true }); f.plan()
  assert.equal(f.board.assault?.target, 'B', 'a distant name through a wall cannot call off the assault')
  f.tick(4000); const after = f.plan()
  assert.equal(f.board.assault?.target, 'B', 'losing contact alone cannot end the existing assault')
  assert.ok([...after.values()].some(t => t.data?.search))
})

test('a returning observer must confirm from its current life, solo direct combat remains available', () => {
  const f = scene()
  f.see(0, 'A', 16); f.see(1, 'A', 16)
  f.team[1].health = 0; f.board.setMembers(f.team)
  f.tick(2); f.team[1].health = 20; f.board.setMembers(f.team)
  f.see(1, 'A', 16, {}, 10001) // delayed request made while dead
  f.plan(); assert.equal(f.board.assault, null)
  f.see(1, 'A', 16); f.plan(); assert.equal(f.board.assault?.target, 'A')
  const solo = scene(1); solo.see(0, 'A', 16)
  assert.equal(solo.plan().get('b0')?.kind, 'fight')
})

test('a second direct report releases the waiting team plan inside its usual refresh interval', async () => {
  let now = 10000
  const logs: string[] = []
  const bots = ['A', 'B', 'C', 'D', 'E'].map(name => ({ name, team: 'blue', c: { async call() { return { status: 'done', detail: {} } } } }))
  const armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  const pos = Object.fromEntries(bots.map((b, i) => [b.name, { p: { x: i, y: 120, z: 0 }, hp: 20, inv: { netherite_sword: 1 }, armor }]))
  const driver = createSwarmDriver({ bots, pos, now: () => now, alive: () => true, aggressive: true,
    home: () => pos.A.p, arena: { x: 0, y: 120, z: 0, r: 40 }, hostile: (_, id) => id === 'Foe', log: s => logs.push(s) })
  const observe = (i: number, direct: boolean) => driver.observe(bots[i], [{ id: 'Foe', visible: direct, nametag: !direct, position: { x: 15, y: 120, z: 0 } }], now)
  observe(0, true); await driver.turn(bots[0]); now++
  observe(1, false); await driver.turn(bots[1]); assert.ok(!logs.some(s => s.includes('ШТУРМ на Foe')))
  now++; observe(1, true); await driver.turn(bots[2])
  assert.equal(logs.filter(s => s.includes('ШТУРМ на Foe')).length, 1)
})

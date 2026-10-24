import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'
import { pvpState } from '../src/swarm/board'
import { attackSeconds, digSeconds } from '../src/swarm/dislodge'
import { memberFight } from '../src/swarm/fight'
import { shoveHits } from '../src/swarm/shove'
import { swarmTurn } from '../../farm/swarm/swarm-driver/turn'

test('q9d: полезный смертельный подкоп и дальний сброс конкурируют по цене до подтверждённых попаданий', () => {
  const p = (x: number, z: number, y = 120) => ({ x, y, z })
  const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
  // Координаты спавна и состав пола — из модели team1; расстановка, вещи и отсутствие оружия у цели — контроль цены.
  const sites = Array.from({ length: 25 }, (_, i) => {
    const x = 542 + (i % 5 - 2) * 2, z = 593 + (Math.floor(i / 5) - 2) * 2
    return { x, y: 119, z, feetY: 120, drop: Infinity, tier: 2, blocks: ['cut_sandstone', 'obsidian'],
      stands: [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => p(x + .5 + dx, z + .5 + dz)) }
  })
  const scene = (bare = false, moving = false) => {
    const team: SwarmMember[] = Array.from({ length: 30 }, (_, i) => ({ id: `b${String(i).padStart(2, '0')}`, team: 'blue',
      position: p(543 + Math.cos(i * Math.PI / 15) * (i < 2 ? 1 : 2.5), 594 + Math.sin(i * Math.PI / 15) * (i < 2 ? 1 : 2.5)),
      health: 20, strength: 40, role: 'fighter', weapon: 'stone_sword', armor, ench: { protection: 16 },
      inventory: i < 22 ? { stone_sword: 1, diamond_pickaxe: 1 } : { stone_sword: 1 } }))
    const board = new SwarmBoard('blue', () => 10000, 8000); board.setMembers(team)
    const foe: any = { id: 'Champ', position: p(543, 594), visible: true, hpEstimate: 20,
      equipment: { armor: bare ? [] : armor, enchanted: !bare }, ...(moving ? { velocity: { x: .5, y: 0, z: 0 } } : {}) }
    board.observe(team[0].id, 10000, foe)
    return { board, team, foe, options: { aggressive: true, quorum: 1, digSites: () => sites, edgeOf: () => null } }
  }
  const f = scene(), price = memberFight(f.team[0], f.foe)
  assert.ok(Math.abs(digSeconds(f.team[0], sites[0]) - 9.55) < 1e-9)
  assert.ok(Math.abs(price.attackSeconds - 17.09401709401709) < 1e-9)
  assert.equal(price.rearm, false, 'контрольный боец способен выжить, уход за снаряжением не объясняет отсутствие копки')
  assert.equal(attackSeconds(f.team[0], f.foe), price.attackSeconds, 'без попаданий цена берётся только из видимой экипировки')
  assert.equal(!!pvpState(f.board).dislodge, false)
  const plan = planPvp(f.board, f.team, f.options), miners = [...plan.values()].filter(t => t.data?.undermine)
  assert.equal(miners.length, 20, 'из 22 доступных алмазных кирок две прикрывают, остальные выполняют более дешёвую смертельную работу')
  assert.ok([...plan].filter(([, t]) => t.data?.undermine).every(([id]) => f.team.find(m => m.id === id)!.inventory?.diamond_pickaxe), 'кирки не выдумываются у остальных восьми')
  assert.equal(!!pvpState(f.board).dislodge, false, 'назначение не выдаёт модель брони за доказанные пустые попадания')
  const quick = scene(true)
  assert.ok(memberFight(quick.team[0], quick.foe).attackSeconds < digSeconds(quick.team[0], sites[0]))
  assert.equal([...planPvp(quick.board, quick.team, quick.options).values()].filter(t => t.data?.undermine).length, 0, 'дешёвая атака по голому оставляет натиск')
  const running = scene(false, true)
  assert.equal([...planPvp(running.board, running.team, running.options).values()].filter(t => t.data?.undermine).length, 0, 'цель успевает уйти до вскрытия: работа дорожает и уступает атаке')
  const iron = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
  const trapTeam: SwarmMember[] = Array.from({ length: 6 }, (_, i) => ({ id: `trap${i}`, team: 'blue', position: p(5 + i * .1, 0),
    health: 20, strength: 50, role: 'fighter', weapon: 'iron_sword', armor: iron, inventory: { iron_sword: 1, iron_pickaxe: 1 } }))
  const trapBoard = new SwarmBoard('blue', () => 10000, 8000); trapBoard.setMembers(trapTeam)
  trapBoard.observe('trap0', 10000, { id: 'Champ', position: p(0, 0), visible: true, equipment: { weapon: 'iron_sword', armor: iron } })
  const trapSites = [
    { ...p(0, 0, 119), feetY: 120, drop: Infinity, tier: 2, blocks: ['obsidian'], stands: [p(2.5, 0)] },
    { ...p(3, 0, 119), feetY: 120, drop: 2, handMs: 1000, blocks: ['dirt'] }
  ]
  const traps = [...planPvp(trapBoard, trapTeam, { aggressive: true, quorum: 1, digSites: () => trapSites }).values()].filter(t => t.data?.dig)
  assert.equal(traps.length, 1, 'недоступный обсидиан не отменяет обычную доступную ловушку')
  assert.equal(traps[0].data?.dig, '3,119,0')
  assert.equal(traps[0].data?.undermine, false)
  const far = scene(), edge = { x: -1, z: 0, at: 14, drop: Infinity }
  assert.ok(shoveHits(far.foe, edge) * .5 < attackSeconds(far.team[0], far.foe), 'цепь к пустоте дешевле размена по тяжёлой броне')
  const shovers = planPvp(far.board, far.team, { ...far.options, digSites: undefined, edgeOf: () => edge })
  const held = [...shovers.values()].find(t => t.data?.shove)!
  assert.ok(held, 'дальний сброс не ждёт смертей и подтверждённых попаданий')
  const next = { ...held, data: { ...held.data, shove: false } }, logs: string[] = [], calls: string[] = []
  const b: any = { name: held.assignedTo, swarmTask: held, swarmExecuting: true, c: { call: async name => { calls.push(name) } } }
  const driver = swarmTurn({ now: () => 10000, alive: () => true, pos: {}, log: text => logs.push(text),
    refresh: () => ({ task: next, board: far.board, members: far.team, member: far.team.find(m => m.id === b.name) }) } as any)
  assert.equal(driver.preempt(b), true)
  assert.deepEqual(calls, ['stop'])
  assert.match(logs[0], /shove:Champ → обычный бой/, 'строка fight → fight объясняет конкретный сброс, а не скрывает причину отмены')
})

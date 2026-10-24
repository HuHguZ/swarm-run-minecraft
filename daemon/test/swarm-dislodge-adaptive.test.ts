import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'
import { pvpState } from '../src/swarm/board'
import { swarmTurnWork } from '../../farm/swarm/swarm-driver/turn-work'

test('q9 followup: движение и отсутствие прогресса оплачиваются, длинная копка получает свой бюджет, штраф допускает повтор', async () => {
  const p = (x = 0, y = 64, z = 0) => ({ x, y, z })
  const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
  const team: SwarmMember[] = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, team: 'blue', position: p(2.1 + i * .1, 64, (i - 2.5) * .1), health: 20, strength: 60,
    role: 'fighter', weapon: 'netherite_sword', armor, ench: { sharpness: 5, protection: 4 }, inventory: { netherite_sword: 1 } }))
  let time = 10000, velocity = p(.28, 0), edge: any = { x: -1, z: 0, at: 6, drop: Infinity }
  const board = new SwarmBoard('blue', () => time, 3000)
  board.setMembers(team)
  const see = () => board.observe('b0', time, { id: 'foe', position: p(), velocity, visible: true, hpEstimate: 20, equipment: { weapon: 'netherite_sword', armor, enchanted: true },
    hitProof: { healed: 1.6, hits: Array.from({ length: 8 }, (_, i) => ({ ago: (8 - i) * 500, damage: .2, lowDamage: .2, healed: i * .2 })) } })
  const plan = (more = {}) => { see(); return planPvp(board, team, { aggressive: true, quorum: 1, edgeOf: () => edge, ...more }) }
  assert.ok(![...plan().values()].some(t => t.data?.shove), 'бег от края быстрее цепи: обычная атака')
  assert.equal(pvpState(board).dislodge, true, 'отказ не прячет доказательство слабого урона')
  velocity = p(0, 0)
  assert.ok([...plan().values()].some(t => t.data?.shove), 'стоящую цель можно толкать к далёкому краю')
  const { dislodgeSeconds, digSeconds } = require('../src/swarm/dislodge') as typeof import('../src/swarm/dislodge')
  const S: any = { board, state: pvpState(board), team, edgeAt: () => edge }
  const foe = () => board.enemies()[0]
  time += 500; plan()
  time += 3000
  assert.ok(![...plan().values()].some(t => t.data?.shove), 'пустая цепь заканчивается после ожидаемой работы')
  const failed = dislodgeSeconds(S, foe(), 'shove', 2, 20)
  time += 1000; see()
  assert.ok(dislodgeSeconds(S, foe(), 'shove', 2, 20) < failed, 'штраф убывает в игровых секундах')
  time += 10000
  assert.ok([...plan().values()].some(t => t.data?.shove), 'стационарная цель допускает новую попытку после штрафа')
  const approachTeam = [{ ...team[0], id: 'runner', position: p(14) }]
  const approachBoard = new SwarmBoard('blue', () => time, 3000)
  approachBoard.setMembers(approachTeam)
  const approach = () => {
    approachBoard.observe('runner', time, { ...foe(), id: 'foe', visible: true, velocity: p(0, 0) })
    return planPvp(approachBoard, approachTeam, { aggressive: true, quorum: 1, edgeOf: () => ({ x: -1, z: 0, at: 1, drop: Infinity }) }).get('runner')!
  }
  assert.ok(approach().data?.shove, 'полезный толчок у края допускает подход из 14 блоков')
  time += 1100
  assert.ok(approach().data?.shove, 'подход 11 / 5.6 ≈ 1.96 с не исчерпан за 1.1 с')
  time += 2100
  assert.ok(!approach().data?.shove, 'стояние без подхода исчерпывает и его полный бюджет')
  board.resetRound(); board.setMembers(team); velocity = p(.04, 0); see(); S.state = pvpState(board)
  board.upsert({ id: 'pvp:b0', kind: 'fight', assignedTo: 'b0', data: { target: 'foe', shove: true } })
  const moving = dislodgeSeconds(S, foe(), 'shove', 2, 20)
  assert.ok(moving > 2 && moving < 20, 'медленный уход повышает цену, но оставляет физически полезную цепь')
  time += 2600; see()
  assert.ok(dislodgeSeconds(S, foe(), 'shove', 2, 20) < 20, 'бюджет включает дополнительную работу против движения')
  time += 1000; see()
  assert.ok(dislodgeSeconds(S, foe(), 'shove', 2, 20) > 20, 'и расширенный бюджет остаётся конечным')
  velocity = p(0, 0)

  const pick = { ...team[2], inventory: { netherite_sword: 1, diamond_pickaxe: 1 } }
  const site: any = { x: -1, y: 63, z: 0, feetY: 64, drop: Infinity, tier: 2, blocks: ['sand', 'obsidian'], handMs: 250750, stands: [p(.5, 64, .5)] }
  const seconds = digSeconds(pick, site)
  assert.ok(seconds > 9 && seconds < 11, `алмазная кирка по обсидиану: ${seconds} с, а не handMs / 8`)
  assert.ok(digSeconds(pick, { ...site, blocks: ['obsidian'] }) < seconds, 'подтверждённый снятый слой уменьшает оставшуюся работу')
  assert.equal(digSeconds(pick, { ...site, blocks: [] }), 0, 'готовая дыра не требует повторной копки')
  assert.ok(digSeconds({ ...pick, inventory: { iron_pickaxe: 1 } }, site) > seconds * 3, 'неподходящий уровень кирки меняет делитель добычи')
  board.resetRound(); board.setMembers(team); see(); S.state = pvpState(board)
  const method = 'dig:-1,63,0'
  const digTask = board.upsert({ id: 'pvp:b2', kind: 'goto', assignedTo: 'b2', position: site, data: { target: 'foe', dig: '-1,63,0', undermine: true, blocks: site.blocks } })
  assert.ok(dislodgeSeconds(S, foe(), method, seconds, 30) < 30)
  let receipts = 0
  let interrupted = true
  const b: any = { name: 'b2', swarmTask: digTask, c: { call: async name => name === 'status' ? { state: { pos: p(1, 64, .5) } } :
    ++receipts === 1 ? { status: 'done', detail: { ok: true } } : interrupted ? { status: 'interrupted' } : { status: 'done', detail: { ok: false, why: 'blocked' } } } }
  const sw: any = { now: () => time, alive: () => true, log: () => {}, pos: {}, bots: [], arena: {}, home: () => ({}), cooldown: new Map(), holes: [],
    planned: new Map(), walls: new Map(), ladderRoutes: [], go: () => {}, detail: r => r.detail || r, teamOf: () => 'blue', ownProtection: () => [], say2: () => {}, generation: 1, siteFailed: () => {} }
  await swarmTurnWork(sw).turnDig({ b, context: { members: team }, board, task: digTask, round: 1, m: { p: p(1, 64, .5) } } as any)
  const dug = S.state.dislodgeWork.get('foe:dig:-1,63,0').dug
  assert.equal(dug, 1, 'receipt исполнителя доходит до памяти планировщика, а не копии задачи')
  const remaining = digSeconds(pick, site, dug)
  assert.ok(remaining < seconds)
  time += 8500; see()
  assert.ok(dislodgeSeconds(S, foe(), method, remaining, 30) < 30, 'копка обсидиана не бросается по 8-секундной ленте попаданий')
  time += 3000; see()
  assert.ok(dislodgeSeconds(S, foe(), method, remaining, 30) > 30, 'та же клетка без прогресса не держит копателя навечно')
  board.resetRound(); board.setMembers(team); see(); S.state = pvpState(board)
  board.upsert(digTask); dislodgeSeconds(S, foe(), method, seconds, 30)
  interrupted = false; receipts = 0
  await swarmTurnWork(sw).turnDig({ b, context: { members: team }, board, task: digTask, round: 1, m: { p: p(1, 64, .5) } } as any)
  assert.ok(dislodgeSeconds(S, foe(), method, remaining, 30) > 30, 'подтверждённый отказ исполнителя тоже повышает цену, без ожидания таймера')
  board.resetRound(); board.setMembers(team); velocity = p(0, 0, .28); see(); S.state = pvpState(board)
  assert.ok(dislodgeSeconds(S, foe(), method, seconds, 30) > 30, 'цель выйдет из места подкопа до конца работы')
  team[2] = pick
  assert.ok(![...plan({ digSites: () => [site] }).values()].some(t => t.data?.dig), 'движущийся враг возвращает кирочника в обычный план')
  edge = null
  team[0] = { ...team[0], weapon: 'mace', inventory: { mace: 1, wind_charge: 2 } }
  team[1] = { ...team[1], weapon: 'netherite_spear', inventory: { netherite_spear: 1 } }
  const openBoard = new SwarmBoard('blue', () => time, 3000)
  openBoard.setMembers(team)
  openBoard.observe('b0', time, { id: 'foe', position: p(), visible: true, equipment: { weapon: 'iron_sword', armor: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'] } })
  const open = planPvp(openBoard, team, { aggressive: true, quorum: 1 })
  assert.ok(![...open.values()].some(t => t.data?.shove || t.data?.dig), 'без края — обычная атака, булава и копьё')
  for (const id of ['b0', 'b1']) assert.ok(open.get(id)?.kind === 'fight' && !open.get(id)?.data?.rearm, `${id}: булава и копьё продолжают атаковать`)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'
import * as dislodge from '../src/swarm/dislodge'
import { memberFight } from '../src/swarm/fight'
import { shoveHits } from '../src/swarm/shove'
import { swarmTeam } from '../../farm/swarm/swarm-driver/team'
import { createDriverState } from '../../farm/swarm/swarm-driver/state'

test('q9c: урон 11..12 при лечении 12.3 дорожает; цепь до края назначается, отсутствие края видно в распределении', () => {
  const p = (x = 543, y = 120, z = 594) => ({ x, y, z })
  const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
  const members: SwarmMember[] = Array.from({ length: 30 }, (_, i) => ({ id: 'b' + i, team: 'blue', position: p(545 + i % 3, 120, 594 + Math.floor(i / 3) * .1), health: 20, strength: 60, role: 'fighter', weapon: 'netherite_sword', armor, ench: { sharpness: 5, protection: 16 }, inventory: { netherite_sword: 1 } }))
  let now = 1000
  // Размен и координаты — из журнала; экипировка и край в 14 бл. — контроль цены, не реконструкция боя у базы.
  const foe: any = { id: 'HuHguZ', position: p(), equipment: { weapon: 'netherite_sword', armor, enchanted: false }, pressure: { hits: 2, damageLow: 11, damage: 12, healing: 12.3 } }
  assert.equal(typeof (dislodge as any).attackSeconds, 'function')
  assert.ok((dislodge as any).attackSeconds(members[0], foe) > memberFight(members[0], foe).attackSeconds)
  assert.ok((dislodge as any).attackSeconds(members[0], { ...foe, pressure: { ...foe.pressure, damageLow: 0 } }) > memberFight(members[0], foe).attackSeconds, 'нулевой нижний урон тоже является пустым разменом')
  assert.equal((dislodge as any).attackSeconds(members[0], { ...foe, pressure: undefined }), memberFight(members[0], foe).attackSeconds)
  const board = new SwarmBoard('blue', () => now, 8000)
  board.setMembers(members)
  const see = () => board.observe('b0', now, { ...foe, visible: true, hitProof: { healed: 12.3, hits: [{ ago: 1000, damage: 6, lowDamage: 5.5, healed: 0 }, { ago: 500, damage: 6, lowDamage: 5.5, healed: 0 }] } })
  see()
  const edge = { x: -1, z: 0, at: 14, drop: Infinity }
  const chainSeconds = shoveHits(foe, edge) * .5
  assert.ok(memberFight(members[0], foe).attackSeconds < chainSeconds && (dislodge as any).attackSeconds(members[0], foe) > chainSeconds, 'без учёта лечения прежняя цена отвергала эту цепь')
  const plan = planPvp(board, members, { aggressive: true, quorum: 1, edgeOf: () => edge })
  assert.ok([...plan.values()].some(t => t.data?.shove), 'стоящего у далёкого края не записываем в быстрый натиск по сырой модели')
  now += 500; see()
  const open = planPvp(board, members, { aggressive: true, quorum: 1, edgeOf: () => null })
  assert.ok(![...open.values()].some(t => t.data?.shove))
  const bots = members.map(m => ({ name: m.id, team: m.team })), logs: string[] = []
  const pos = Object.fromEntries(members.map(m => [m.id, { p: m.position, hp: 20, inv: m.inventory, armor: {} }]))
  let availableEdge: any = null
  const sw: any = createDriverState({ bots, pos, alive: () => true, now: () => now, log: s => logs.push(s), edgeOf: () => availableEdge })
  Object.assign(sw, swarmTeam(sw))
  const driverBoard = sw.boardOf(bots[0]); driverBoard.setMembers(members)
  driverBoard.observe('b0', now, { ...foe, visible: true })
  sw.planned.set('blue', open); sw.plannedAt.set('blue', now)
  sw.refresh(bots[0])
  assert.match(logs.join('\n'), /края нет — натиск/, 'у базы без смертельного края нет обещания сброса')
  now += 3000
  availableEdge = edge; sw.plannedAt.set('blue', now)
  sw.refresh(bots[0])
  assert.match(logs.at(-1)!, /смертельный край в 14.0 бл./, 'изменение доступного края видно даже при тех же числах распределения')
})

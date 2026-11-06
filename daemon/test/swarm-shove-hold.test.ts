import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'
import { attackSeconds } from '../src/swarm/dislodge'
import { shoveHits, shoveValue } from '../src/swarm/shove'
import { IFRAME_TICKS } from '../src/pvp/damage-model'

// cl28b (15×15, 28.10): цель шла по ярусам Колизея, обрыв под ней менялся 17 ↔ 7–9 бл. — сброс включался и выключался
// каждую секунду (189 смен «сброс да/нет» при живом крае), и бойцы метались между сбросом и резервом.
test('начатый сброс держится, пока выгоден; новый — с полной ценностью; исчезнувший край и лучшая альтернатива снимают сброс', () => {
  const p = (x: number, y = 120, z = 594) => ({ x, y, z })
  const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
  const members: SwarmMember[] = Array.from({ length: 6 }, (_, i) => ({ id: 'b' + i, team: 'blue', position: p(548 + i), health: 20, strength: 30, role: 'fighter', weapon: 'iron_sword', inventory: { iron_sword: 1 }, armor }))
  let now = 1000
  const foe: any = { id: 'Foe', position: p(545), equipment: { weapon: 'iron_sword', armor } }
  const fresh = () => { const b = new SwarmBoard('blue', () => now, 8000); b.setMembers(members); return b }
  const see = (b: SwarmBoard) => b.observe('b0', now, { ...foe, visible: true })
  const shovers = (plan: Map<string, any>) => [...plan.values()].filter(t => t.data?.shove).map(t => t.assignedTo).sort()
  const deep = { x: -1, z: 0, at: 1, drop: 17 }, shallow = { x: -1, z: 0, at: 1, drop: 9 }
  const prices = () => members.map(m => {
    const walk = Math.max(0, m.position.x - foe.position.x - 3) / 5.6
    return { work: shoveHits(foe, shallow) * IFRAME_TICKS / 20 + walk,
      alternative: (attackSeconds(m, foe) + walk) * shoveValue(foe, shallow) }
  })
  assert.ok(prices().every(p => p.work < p.alternative), 'видимая броня делает частичный сброс выгоднее прямого боя для каждого участника')

  const board = fresh(); see(board)
  const first = planPvp(board, members, { aggressive: true, quorum: 1, edgeOf: () => deep })
  const started = shovers(first)
  assert.equal(started.length, members.length, 'обрыв 17 бл. — сброс всей готовой группы')
  for (const t of first.values()) board.upsert(t)

  now += 500; see(board)
  assert.deepEqual(shovers(planPvp(board, members, { aggressive: true, quorum: 1, edgeOf: () => shallow })), started, 'обрыв 9 бл. всё ещё выгоден — начатый сброс не рвётся')

  const other = fresh(); see(other)
  assert.deepEqual(shovers(planPvp(other, members, { aggressive: true, quorum: 1, edgeOf: () => shallow })), [], 'с 9 бл. новый сброс не начинают')

  now += 500; see(board)
  assert.deepEqual(shovers(planPvp(board, members, { aggressive: true, quorum: 1, edgeOf: () => null })), [], 'края нет — сброса нет')

  now += 500; see(board)
  assert.deepEqual(shovers(planPvp(board, members, { aggressive: true, quorum: 1, edgeOf: () => deep })), started)
  foe.equipment.armor = []
  assert.ok(prices().every(p => p.work >= p.alternative), 'после видимого снятия брони прямой бой дешевле частичного сброса')
  now += 500; see(board)
  assert.deepEqual(shovers(planPvp(board, members, { aggressive: true, quorum: 1, edgeOf: () => shallow })), [], 'прежний сброс не сохраняется против более выгодной альтернативы')
})

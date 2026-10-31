import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'

// cl28 (28.10): на земле чаще всего гибли в отходе от летунов с копьём — 35 из 127 наземных смертей, почти все с полным хп и одни
// («держу один»): бег прочь по открытому (он проходит 12 бл. меньше чем за секунду) или полёт на насест ему навстречу. Под крышей
// (камера, галерея) его копьё не достаёт (луч KineticWeapon обрывают блоки) — туда, если есть; от наземных — как прежде.
const p = (x: number, y = 120, z = 600) => ({ x, y, z })
const neth = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], iron = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
const mk = (id: string, x: number, z: number): SwarmMember => ({ id, team: 'blue', position: p(x, 120, z), health: 20, strength: 40, role: 'fighter', weapon: 'diamond_sword', armor: iron, inventory: { diamond_sword: 1, diamond_spear: 1, elytra: 1, firework_rocket: 16 } })
function plan(threat: 'aerial' | 'melee') {
  const ms = [mk('b0', 600, 600), mk('b1', 600, 660), mk('b2', 602, 660)], board = new SwarmBoard('blue', () => 1000, 8000)
  board.setMembers(ms)
  for (let i = 0; i < 2; i++) board.observe('b0', 1000, { id: 'Ram' + i, position: p(612 + i, threat === 'aerial' ? 128 : 120, 600 + i), visible: true, threat, equipment: { weapon: 'netherite_spear', armor: neth } } as any)
  return planPvp(board, ms, { aggressive: false, quorum: 1, hideouts: [p(597, 120, 601)], perches: [p(570, 150, 600)] }).get('b0')
}

test('отход от тарана — под крышу, а не на насест ему навстречу', () => {
  const t = plan('aerial')
  assert.equal(t?.kind, 'flee')
  assert.ok(t?.data?.hide && !t?.data?.perch, JSON.stringify(t?.data).slice(0, 160))
  assert.deepEqual(t?.position, p(597, 120, 601))
})

test('от наземных — без пряток под крышу', () => {
  assert.ok(!plan('melee')?.data?.hide)
})

// Пользователь 28.10: «укрытия умеют строить … если не можешь убежать быстро». Крыша не успевает, а блоки есть — коробка на месте
// (стены и крыша, fortify.boxIn ≈ 0.18 с на блок): задача кемпера с camp, выход — box_out, когда план даст другое дело.
test('крыша не успевает, блоки есть — коробка на месте вместо бега', () => {
  const withBlocks = (b: SwarmMember) => ({ ...b, inventory: { ...b.inventory, dirt: 32 } })
  const ms = [withBlocks(mk('b0', 600, 600)), mk('b1', 600, 720), mk('b2', 602, 720)], board = new SwarmBoard('blue', () => 1000, 8000)
  board.setMembers(ms)
  for (let i = 0; i < 2; i++) board.observe('b0', 1000, { id: 'Ram' + i, position: p(620 + i, 128, 600 + i), velocity: { x: -.4, y: 0, z: 0 }, visible: true, threat: 'aerial', equipment: { weapon: 'netherite_spear', armor: neth } } as any)
  const t = planPvp(board, ms, { aggressive: false, quorum: 1, hideouts: [p(550, 128, 600)], perches: [p(570, 150, 600)] }).get('b0')
  assert.ok(t?.data?.camp && t.data.hold, JSON.stringify(t?.data).slice(0, 140))
  assert.deepEqual(t?.position, ms[0].position)
})

test('коробка на этой клетке не встала — план её здесь больше не предлагает', () => {
  const withBlocks = (b: SwarmMember) => ({ ...b, inventory: { ...b.inventory, dirt: 32 } })
  const ms = [withBlocks(mk('b0', 600, 600)), mk('b1', 600, 720), mk('b2', 602, 720)], board = new SwarmBoard('blue', () => 1000, 8000)
  board.setMembers(ms)
  for (let i = 0; i < 2; i++) board.observe('b0', 1000, { id: 'Ram' + i, position: p(620 + i, 128, 600 + i), velocity: { x: -.4, y: 0, z: 0 }, visible: true, threat: 'aerial', equipment: { weapon: 'netherite_spear', armor: neth } } as any)
  board.recordFact('b0', 1000, { id: 'box-failed:b0:600,120,600', kind: 'mark', position: p(600) }, 60000)
  const t = planPvp(board, ms, { aggressive: false, quorum: 1, hideouts: [p(550, 128, 600)], perches: [p(570, 150, 600)] }).get('b0')
  assert.ok(!t?.data?.ramBox && t?.data?.ramWall, 'коробки здесь нет — стенка')
  board.recordFact('b0', 1000, { id: 'wall-failed:b0:600,120,600', kind: 'mark', position: p(600) }, 60000)
  const u = planPvp(board, ms, { aggressive: false, quorum: 1, hideouts: [p(550, 128, 600)], perches: [p(570, 150, 600)] }).get('b0')
  assert.ok(!u?.data?.camp, 'и стенка не встала — отход, как прежде')
})

test('булыжник без кирки — не коробка (из неё не выйти), а стенка на линии подлёта', () => {
  const ms = [{ ...mk('b0', 600, 600), inventory: { ...mk('b0', 600, 600).inventory, cobblestone: 32 } }, mk('b1', 600, 720), mk('b2', 602, 720)], board = new SwarmBoard('blue', () => 1000, 8000)
  board.setMembers(ms)
  for (let i = 0; i < 2; i++) board.observe('b0', 1000, { id: 'Ram' + i, position: p(620 + i, 128, 600 + i), velocity: { x: -.4, y: 0, z: 0 }, visible: true, threat: 'aerial', equipment: { weapon: 'netherite_spear', armor: neth } } as any)
  const t = planPvp(board, ms, { aggressive: false, quorum: 1, hideouts: [p(550, 128, 600)], perches: [p(570, 150, 600)] }).get('b0')
  assert.ok(t?.data?.ramWall && t.data.target, JSON.stringify(t?.data).slice(0, 140))
})

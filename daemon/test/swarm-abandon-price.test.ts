import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'

// Цикл 20 (29.10, cl74–76): 80 % обрывов дел — смена цели, почти все — «новая ближе на 4+ бл.» (запас удержания 4). Бросить
// начатый бой стоит дороже пути: урон, уже нанесённый цели (оценка хп по своим попаданиям), пропадает, если её не добить.
const p = (x: number) => ({ x, y: 64, z: 0 })
// Шестеро в железе с алмазным мечом против голых — бой, а не лут/отход; b0 решает первым (нагрузки целей ещё нет).
const team = (): SwarmMember[] => [0, 1, -1, 2, -2, 3].map((z, i) => ({ id: 'b' + i, team: 'blue', position: { x: 0, y: 64, z }, health: 20, strength: 30, role: 'fighter',
  weapon: 'diamond_sword', armor: { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' }, inventory: { diamond_sword: 1 } }))
const enemy = (id: string, x: number, hp?: number): any => ({ id, position: p(x), equipment: { weapon: 'wooden_sword', armor: [null, null, null, null] }, visible: true, ...(hp ? { hpEstimate: hp } : {}) })

function retarget(hpA?: number) {
  let now = 1000
  const T = team(), board = new SwarmBoard('blue', () => now, 8000)
  board.setMembers(T)
  board.observe('b0', now, enemy('A', 10, hpA))
  for (const t of planPvp(board, T, { aggressive: true, quorum: 1 }).values()) board.upsert(t)
  now += 500
  board.observe('b0', now, enemy('A', 10, hpA)); board.observe('b0', now, enemy('B', -4))
  return planPvp(board, T, { aggressive: true, quorum: 1 }).get('b0')?.data?.target
}

test('цель без урона — на ближнюю; по прежней уже есть урон — добиваю её', () => {
  assert.equal(retarget(), 'B', 'A цела, B на 6 бл. ближе — запаса 4 не хватает, смена')
  assert.equal(retarget(14), 'A', 'у A ≈14 хп по оценке (не добивание ≤10) — бросить её дороже 6 бл. пути')
})

'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as crowd from '../src/pvp/crowd'

const P = (x: number, z: number) => ({ x, y: 120, z })

test('толпа: «третий лишний» — занятого другим бьют раньше свободного рядом', () => {
  const me = { name: 'me', p: P(0, 0) }
  const free = { name: 'free', p: P(6, 0) }
  const busy = { name: 'busy', p: P(0, 8) }
  const other = { name: 'other', p: P(0, 10) }
  const r = crowd.chooseTarget(me, [free, busy, other], { persona: 'хитрец' })
  assert.equal(r.target, 'busy', JSON.stringify(r))
})

test('толпа: «враг моего врага» — бьющего мою цель не трогаю, пока она жива', () => {
  const me = { name: 'me', p: P(0, 0) }
  const tgt = { name: 'tgt', p: P(6, 0) }
  const ally = { name: 'ally', p: P(9, 0) }
  const r = crowd.chooseTarget(me, [tgt, ally], { persona: 'хитрец', current: 'tgt' })
  assert.equal(r.target, 'tgt')
  // Цели нет — союзник снова противник.
  assert.equal(crowd.chooseTarget(me, [ally], { persona: 'хитрец' }).target, 'ally')
})

test('толпа: тихоня обходит кучу, раненого на глазах добивают', () => {
  const me = { name: 'me', p: P(0, 0) }
  const pile = [{ name: 'a', p: P(8, 0) }, { name: 'b', p: P(9, 1) }, { name: 'c', p: P(9, -1) }]
  const lone = { name: 'lone', p: P(-12, 0) }
  assert.equal(crowd.chooseTarget(me, [...pile, lone], { persona: 'тихоня' }).target, 'lone')
  const hurt = { name: 'hurt', p: P(-10, 0), hurtAgo: 500 }
  assert.equal(crowd.chooseTarget(me, [{ name: 'x', p: P(7, 0) }, hurt], { persona: 'задира' }).target, 'hurt')
})

test('толпа: двое идут на меня — окружён', () => {
  const me = { name: 'me', p: P(0, 0) }
  const a = { name: 'a', p: P(5, 0), v: { x: -0.3, y: 0, z: 0 } }
  const b = { name: 'b', p: P(0, 6), v: { x: 0, y: 0, z: -0.3 } }
  assert.equal(crowd.outnumbered(me, [a, b]), true)
  assert.equal(crowd.outnumbered(me, [a]), false)
})

test('толпа: на элитрах сцепка — по курсу, а не по дистанции (заход с 15 бл.)', () => {
  const me = { name: 'me', p: P(0, 0) }
  const diver = { name: 'diver', p: P(0, 10), v: { x: 1.5, y: 0, z: 0 } } // летит на victim
  const victim = { name: 'victim', p: P(15, 10) }
  const near = { name: 'near', p: P(8, 0) }
  const r = crowd.chooseTarget(me, [diver, victim, near], { persona: 'хитрец' })
  assert.equal(r.target, 'diver', JSON.stringify(r))
  // Моя цель victim — diver на неё летит: союзник, не трогаю.
  const t = crowd.chooseTarget(me, [diver, victim], { persona: 'хитрец', current: 'victim' })
  assert.equal(t.target, 'victim', JSON.stringify(t))
})

test('команда: фокус и прикрытие раненого союзника; лечить — самого раненого рядом', () => {
  const me = { name: 'me', p: P(0, 0) }
  const ally = { name: 'ally', p: P(4, 0), hp: 6, target: 'x' }
  const x = { name: 'x', p: P(9, 0) }
  const y = { name: 'y', p: P(-6, 0) }
  // y ближе, но союзник бьёт x — фокус.
  assert.equal(crowd.chooseTeamTarget(me, [{ ...ally, hp: 20 }], [x, y]).target, 'x')
  // z бьёт раненого союзника — прикрыть.
  const z = { name: 'z', p: P(4, 3) }
  const r = crowd.chooseTeamTarget(me, [{ ...ally, target: null }], [z, y])
  assert.equal(r.target, 'z', JSON.stringify(r))
  assert.equal(crowd.healTarget(me, [ally, { name: 'far', p: P(20, 0), hp: 2 }]).name, 'ally')
  assert.equal(crowd.healTarget(me, [ally], new Set(['ally'])), null)
})

test('команда: зелье — туда, где вылечит больше (двое раненых рядом — между ними; враг в всплеске — минус)', () => {
  const me = { name: 'me', p: P(0, 0), hp: 20 }
  const a = { name: 'a', p: P(3, 0), hp: 8 }
  const b = { name: 'b', p: P(3, 2), hp: 8 }
  const plan = crowd.healPlan(me, [a, b])
  assert.deepEqual(plan.allies.sort(), ['a', 'b'])
  assert.ok(plan.value > 10, JSON.stringify(plan))
  // Почти здоров — зелье не тратить.
  assert.equal(crowd.healPlan(me, [{ name: 'c', p: P(2, 0), hp: 18 }]), null)
  // Враг у раненого — польза ниже.
  const withFoe = crowd.healPlan(me, [a], [{ name: 'x', p: P(3, 0.5) }])
  assert.ok(!withFoe || withFoe.value < crowd.healPlan(me, [a]).value)
})

test('команда: враги у чужого сбора на хилку — в приоритете (сорвать лечение)', () => {
  const me = { name: 'me', p: P(0, 0) }
  const near = { name: 'near', p: P(0, -5) }
  const atRally = { name: 'rally', p: P(9, 0) }
  assert.equal(crowd.chooseTeamTarget(me, [], [near, atRally]).target, 'near')
  const r = crowd.chooseTeamTarget(me, [], [near, atRally], { hotspots: [P(11, 0)] })
  assert.equal(r.target, 'rally', JSON.stringify(r))
})

test('кристаллы: куча врагов — добыча под взрыв, а не риск', () => {
  const me = { name: 'me', p: P(0, 0) }
  const lone = { name: 'lone', p: P(6, 0) }
  const pile = [{ name: 'a', p: P(-9, 0) }, { name: 'b', p: P(-10, 1) }, { name: 'c', p: P(-10, -1) }]
  assert.equal(crowd.chooseTeamTarget(me, [], [lone, ...pile]).target, 'lone')
  assert.ok(['a', 'b', 'c'].includes(crowd.chooseTeamTarget(me, [], [lone, ...pile], { blast: true }).target))
})

test('команда: роли по снаряжению и решение «отходим»', () => {
  const tier = (n: string) => ['iron', 'diamond'].findIndex(t => n.startsWith(t))
  const r = crowd.assignRoles([
    { name: 'a', inv: { splash_potion: 3 }, armor: {} },
    { name: 'b', inv: { bow: 1 }, armor: {} },
    { name: 'c', inv: {}, armor: { head: 'diamond_helmet', torso: 'diamond_chestplate' } },
    { name: 'd', inv: {}, armor: { head: 'iron_helmet' } },
    { name: 'e', inv: {}, armor: {} }
  ], tier)
  assert.equal(r.a, 'лекарь'); assert.equal(r.b, 'стрелок'); assert.equal(r.c, 'танк'); assert.equal(r.e, 'фланг')
  const me = { name: 'me', p: P(0, 0) }
  assert.equal(crowd.teamForce([{ ...me, hp: 6 }, { name: 'x', p: P(1, 0), hp: 5 }], [{ name: 'e1', p: P(9, 0) }, { name: 'e2', p: P(9, 2) }, { name: 'e3', p: P(9, 4) }]).retreat, true)
  assert.equal(crowd.teamForce([{ ...me, hp: 20 }, { name: 'x', p: P(1, 0), hp: 20 }], [{ name: 'e1', p: P(9, 0) }]).retreat, false)
})

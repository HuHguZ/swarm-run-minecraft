import test from 'node:test'
import assert from 'node:assert/strict'
import * as HF from '../src/bastion/hyp-focus'

// ND_BASTION_HYP_FOCUS: цели одной гипотезы; промах у цели снимает гипотезу (кусок с долей 1) или только вариант куска (доля < 1).
test('hyp-focus: one hypothesis in the plan, a miss refutes it', () => {
  process.env.ND_BASTION_HYP_FOCUS = '1'
  const bot: any = { world: {}, game: { dimension: 'the_nether' }, entity: { position: { distanceTo: () => 0 } } }
  const A = 'units|1|32,32,32', B = 'units|2|16,32,48'
  const wall = (hyp, p = 1, x = 0) => ({ piece: 'units/walls/wall_base', r: 1, t: { x, y: 32, z: 0 }, p, hyp })
  const v = (k, w): [string, any] => [k, { pos: { x: 0, y: 0, z: 0, distanceTo: () => 3 }, piece: w.piece, rank: 101, wall: w, sources: [{ rank: 101, wall: w }] }]
  const wa = wall(A), wb = wall(B), side = wall(A, 0.5, 16)
  const st: any = { pred: new Map<string, any>([v('1,1,1', wa), v('2,2,2', wb), v('3,3,3', side), ['9,9,9', { pos: {}, piece: 'видно', rank: 0 }]]),
    chestSeen: new Map([['5,5,5', { pos: {}, pred: true, wall: wb, hyp: B }]]), looted: new Set(), skip: new Map(), hypOrder: new Map([[A, 0], [B, 1]]) }
  assert.equal(HF.focus(st), A)
  assert.ok(HF.predAllowed(st, st.pred.get('1,1,1')) && !HF.predAllowed(st, st.pred.get('2,2,2')) && HF.predAllowed(st, st.pred.get('9,9,9')))
  assert.ok(!HF.chestAllowed(st, st.chestSeen.get('5,5,5')))
  HF.judgeGold(bot, st, st.pred.get('3,3,3'), 'cracked_polished_blackstone_bricks')
  assert.ok(st.pred.has('3,3,3'), 'cracked bricks: processor, not evidence')
  HF.judgeGold(bot, st, st.pred.get('3,3,3'), 'blackstone')
  assert.ok(!st.pred.has('3,3,3') && st.pred.has('1,1,1'), 'p 0.5 variant refuted alone')
  HF.judgeGold(bot, st, st.pred.get('1,1,1'), 'netherrack')
  assert.ok(!st.pred.has('1,1,1') && HF.refutedOf(bot).hyps.has(A))
  assert.equal(HF.focus(st), B, 'next hypothesis takes the plan')
  HF.judgeChest(bot, st, st.chestSeen.get('5,5,5'), 'air')
  assert.equal(HF.focus(st), null)
  assert.ok(st.pred.has('9,9,9'), 'visible gold stays')
  delete process.env.ND_BASTION_HYP_FOCUS // по умолчанию вкл.
})

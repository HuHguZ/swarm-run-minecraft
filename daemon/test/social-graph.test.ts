import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { evaluateSocial, type SocialState } from '../src/social-graph'
import { EventEmitter } from 'node:events'
const locks = require('../src/reflex-lock')

const state: SocialState = { signal: 'crouch', mood: 65, affinity: 60, health: 20,
  threatLevel: 0, bodyBusy: false, airborne: false, interrupted: false, distance: 3 }
test('social graph expresses trust and mood with visible gestures', () => {
  assert.equal(evaluateSocial(state).node, 'Greeting')
  assert.equal(evaluateSocial({ ...state, affinity: 20 }).node, 'Cautious')
  assert.equal(evaluateSocial({ ...state, signal: 'victory' }).gesture, 'crouch')
})
test('danger, interrupted control, and flight cancel social gestures', () => {
  for (const change of [{ threatLevel: 1 }, { interrupted: true }, { airborne: true }, { bodyBusy: true }, { health: 7 }]) {
    assert.equal(evaluateSocial({ ...state, ...change }).gesture, null)
  }
})
test('emergency preempts a gesture and late gesture actions cannot resume', async () => {
  const bot: any = new EventEmitter()
  const actions: string[] = []
  bot.attack = target => actions.push(target)
  bot.clearControlStates = () => {}
  const session: any = { bot, current: null }
  let release: () => void = () => {}
  const suspended = new Promise<void>(resolve => { release = resolve })
  const greeting = locks.start(session, async () => { await suspended; bot.attack('stale gesture') }, { owner: 'Skill', priority: 1, source: 'social-gesture' })
  await new Promise<void>(resolve => setImmediate(resolve))
  await locks.start(session, () => bot.attack('defend'), { owner: 'Emergency', priority: 3, preempt: true, source: 'danger' })
  release()
  await greeting
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(actions, ['defend'])
  assert.equal(locks.owner(session), null)
})

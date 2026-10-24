import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// Игра пользователя 23.10: тактика рвала щит к падающему с булавой («cancelled by tactical»), через 2 с — smashed.
test('a mace shield hold is a commanded escape for reflexes; a plain hold is not', () => {
  const locks = require('../src/reflex-lock')
  const s = (params: any, aborted = false) => ({ current: { name: 'swarm_hold', params, ctl: { aborted } } })
  assert.equal(locks.shieldHold(s({ shield: true, whileSmash: 'Foe' })), true)
  assert.equal(locks.shieldHold(s({ shield: true })), false)
  assert.equal(locks.shieldHold(s({ shield: true, whileSmash: 'Foe' }, true)), false)
})

test('a bow shield hold keeps Tactical out but still yields to an Emergency', async () => {
  const locks = require('../src/reflex-lock')
  const params = { shield: true, whileDraw: 'Foe' }
  const bot: any = new EventEmitter(); bot.clearControlStates = () => {}; bot.pathfinder = { setGoal() {} }
  const session = { bot, current: { name: 'swarm_hold', params, ctl: { aborted: false } } }
  assert.equal(locks.shieldHold(session), true)
  let acted = 0
  await locks.start(session, () => { acted++ })
  assert.equal(acted, 0, 'aim response does not restart a raised shield')
  await locks.start(session, () => { acted++ }, { owner: 'Emergency' })
  assert.equal(acted, 1, 'lava, falling or another emergency can still take control')
  session.current.ctl.aborted = true
  assert.equal(locks.shieldHold(session), false)
})

test('a live mace defense belongs to the current fight and child controller only until its deadline', t => {
  const locks = require('../src/reflex-lock'), clock = require('../src/game-clock')
  t.mock.method(clock, 'now', () => 10000)
  const current: any = { name: 'fight', ctl: { aborted: false } }, ctl = { aborted: false }
  const bot: any = {}, session = { current, bot }
  assert.equal(locks.shieldHold(session), false, 'plain fight is still preemptible')
  bot._ndMaceDefense = { current, ctl, until: 11000 }
  assert.equal(locks.shieldHold(session), true, 'the fight owns a different, live child controller')
  bot._ndMaceDefense.current = { ...current }
  assert.equal(locks.shieldHold(session), false, 'a different intent with the same fields cannot borrow protection')
  bot._ndMaceDefense.current = current
  ctl.aborted = true
  assert.equal(locks.shieldHold(session), false, 'an ended child cannot protect its parent')
  ctl.aborted = false
  current.ctl.aborted = true
  assert.equal(locks.shieldHold(session), false, 'an aborted RPC intent is unprotected')
  current.ctl.aborted = false
  bot._ndMaceDefense.until = 10000
  assert.equal(locks.shieldHold(session), false, 'the deadline is exclusive')
  bot._ndMaceDefense.until = 9999
  assert.equal(locks.shieldHold(session), false)
  bot._ndMaceDefense.until = 11000
  current.name = 'goto'
  assert.equal(locks.shieldHold(session), false, 'the marker cannot protect an unrelated skill')
})

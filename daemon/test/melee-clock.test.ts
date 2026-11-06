import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { GameClock, bind, wall } from '../src/game-clock'
import { install } from '../src/melee'

function fixture(t, { rate = 20, manual = false, anchored = true } = {}) {
  let at = 0
  t.mock.method(wall, 'monotonic', () => at)
  t.mock.method(wall, 'now', () => at)
  const bot: any = new EventEmitter()
  bot.entity = { yaw: 0, pitch: 0, position: { x: 0, y: 0, z: 0 } }
  bot.heldItem = { name: 'netherite_sword' }
  bot._client = new EventEmitter()
  bot._client.write = () => 'original-result'
  bot.game = { serverBrand: 'Paper' }
  bot.getControlState = () => false
  const clock = new GameClock({ epoch: 1e6, manual, stallMs: 0 }).attach(bot)
  clock.setState({ tick_rate: rate })
  bind(bot)
  if (anchored) clock.syncAge(100n)
  const M = install(bot)
  t.after(() => clock.dispose())
  return { bot, clock, M, at: n => { at = n },
    advance: (ticks, ms) => { at += ms; clock.advanceTicks(ticks) },
    hit: () => bot._client.write('use_entity', { target: 1178, mouse: 1 }) }
}

test('recorded T catch-up cannot credit pre-attack elapsed ticks to the next sword hit', t => {
  const f = fixture(t)
  // T BASE packet at +8247 ms, same sword throughout. update_time then jumps
  // the producer +6 ticks in 51 ms. Native attempts were 8 ticks apart (.68),
  // while the old local clock exposed .92 after only 357 wall ms.
  Object.assign(f.clock, { ticks: 1692, serverTicks: 1680, age: 15479046n, serverAt: 0,
    effectiveRate: 19.629512579572932 })
  assert.equal(f.hit(), 'original-result')
  const resetAt = f.M.resetAt
  f.at(89); f.clock.advanceTicks(2)
  const before = f.M.ticksSince()
  f.at(106); f.clock.syncAge(15479066n)
  f.at(140); f.clock.effectiveRate = 20; f.clock.pulse()
  assert.equal(f.clock.ticks, 1700)
  assert.ok(f.M.ticksSince() - before <= 1, 'a corrective producer jump is not six post-packet native ticks')
  f.at(343); f.clock.advanceTicks(4)
  f.at(357)
  assert.equal(f.M.resetAt, resetAt)
  assert.equal(f.M.held, 'netherite_sword')
  assert.ok(f.M.charge() < .91, 'the native .68 attempt must not pass the local .91 race gate')
  assert.ok(f.M.leftMs(.91) > 0, 'leftMs uses the same causal elapsed bound as charge')
  f.at(700); f.clock.advanceTicks(7)
  assert.equal(f.M.charge(), 1, 'the catch-up does not prevent a later fully charged hit')
})

for (const rate of [5, 20, 100, 750]) test(`melee cooldown follows native nominal ticks at ${rate} TPS`, t => {
  const f = fixture(t, { rate })
  assert.equal(f.M.charge(), 1, 'install preserves initial readiness')
  f.hit()
  f.advance(7, 1000 * 7 / rate)
  assert.ok(f.M.charge() < .91)
  f.advance(6, 1000 * 6 / rate)
  assert.equal(f.M.charge(), 1)
  assert.equal(f.M.leftMs(), 0)
})

test('melee cooldown excludes frozen wall time and counts confirmed steps once', t => {
  const f = fixture(t)
  f.hit(); f.advance(5, 250)
  const before = f.M.charge()
  f.clock.setState({ tick_rate: 20, is_frozen: true })
  f.at(100250)
  assert.equal(f.M.charge(), before)
  f.clock.step(1); f.clock.pulse()
  const stepped = f.M.charge()
  assert.ok(stepped > before)
  f.clock.syncAge(106n)
  assert.equal(f.M.charge(), stepped, 'a matching native age does not count the step twice')
  f.clock.setState({ tick_rate: 100, is_frozen: false })
  f.advance(8, 80)
  assert.equal(f.M.charge(), 1)
})

for (const manual of [false, true]) test(`melee preserves ${manual ? 'manual' : 'unanchored'} tick semantics`, t => {
  const f = fixture(t, { manual, anchored: false })
  f.hit(); f.advance(13, 0)
  assert.equal(f.M.charge(), 1)
})

test('all existing reset writers renew the anchor even in the same gameplay tick', t => {
  const f = fixture(t)
  f.hit(); f.advance(13, 650)
  f.M.resetAt = Math.max(f.M.resetAt, f.clock.now()) // showman/posture's existing direct writer.
  assert.equal(f.M.charge(), .04)
  f.advance(13, 650)
  f.bot._client.write('arm_animation', { hand: 0 })
  assert.equal(f.M.charge(), .04, 'Paper air swing resets charge')
  f.advance(13, 650)
  f.bot.heldItem = { name: 'diamond_sword' }; f.bot.emit('physicsTick')
  assert.equal(f.M.charge(), .04, 'held-name change resets charge')
  const sameTickAt = f.M.resetAt
  f.advance(0, 200); f.hit()
  assert.equal(f.M.resetAt, sameTickAt, 'resetAt remains a numeric gameplay timestamp')
  f.advance(12, 400)
  assert.ok(f.M.charge() < .91, 'the second actual packet has its own later observation anchor')
})

test('observation extrapolation cannot charge ahead of completed gameplay ticks', t => {
  const f = fixture(t)
  f.hit(); f.advance(0, 1000)
  assert.equal(f.M.charge(), .04)
  assert.ok(f.M.leftMs() > 0)
  f.clock.advanceTicks(13)
  assert.equal(f.M.charge(), 1)
})

test('respawn and age reanchor do not retain a stale cooldown epoch', t => {
  const f = fixture(t)
  f.hit(); f.advance(13, 650)
  assert.equal(f.M.charge(), 1)
  f.bot.emit('respawn')
  f.clock.syncAge(500000n)
  assert.equal(f.M.charge(), 1, 'completed old cooldown stays completed after reanchor')
  f.hit(); f.advance(1, 50)
  assert.ok(f.M.charge() < .91)
  f.clock.syncAge(1n)
  f.advance(12, 600)
  assert.equal(f.M.charge(), 1, 'a rewind cannot strand the new attack on the old observation epoch')
  const next = new GameClock({ epoch: f.clock.now(), stallMs: 0 }).attach(f.bot)
  bind(f.bot); next.syncAge(100n)
  t.after(() => next.dispose())
  f.hit(); f.advance(0, 650); next.advanceTicks(13)
  assert.equal(f.M.charge(), 1, 'reused melee state anchors a real packet to the current bound clock')
})

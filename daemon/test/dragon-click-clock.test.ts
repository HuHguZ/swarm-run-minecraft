'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Vec3 = require('vec3')
const gameClock = require('../src/game-clock')

const clickSource = require('./source-fixture').functionSource(path.join(__dirname, '..', 'src', 'dragon.js'), 'clickBedAt')
function click (until, untilMono = null) {
  const packets = []
  const ctx: any = {
    gameClock, sleep: gameClock.sleep, runnerOn: () => false, envNum: (_key, fallback) => fallback,
    bot: { setControlState () {}, _client: { write: (...args) => packets.push(args) }, swingArm () {} },
    hit: { point: new Vec3(0.5, 0.5625, 0.5), block: { position: new Vec3(0, 0, 0) } }, until, untilMono
  }
  // The VM timeout makes the old synchronous spin fail instead of hanging the test process.
  vm.runInNewContext(clickSource + '\ncompletion = clickBedAt(bot, hit, { aimed: true, until, untilMono })', ctx, { timeout: 500 })
  return { packets, completion: ctx.completion }
}

test('lockstep native weak blast: an expired mono deadline cannot spend a bed 175 game ms early', async () => {
  const clock = new gameClock.GameClock({ manual: true, lockstep: true })
  clock.setState({ tick_rate: 750, is_frozen: true })
  gameClock.activate(clock)
  try {
    // end-trace clickSchedule2: until is +175 game ms, mono deadline is already 17 ms past.
    const { packets, completion } = click(gameClock.now() + 175, gameClock.wall.monotonic() - 17)
    await gameClock.wall.sleep(20)
    assert.equal(packets.length, 0)
    for (let i = 1; i <= 4; i++) {
      clock.step(1); clock.pulse()
      await gameClock.wall.sleep(0)
      assert.equal(packets.length, i === 4 ? 1 : 0)
    }
    await completion
  } finally { clock.dispose(); gameClock.activate(null) }
})

test('lockstep dragon receipts keep the grant stamp instead of inferring packet lag from older movement', () => {
  const { feedTicks } = require('../src/dragon/pillar-run')
  const clock = new gameClock.GameClock({ manual: true, lockstep: true })
  clock.setState({ tick_rate: 750 }); gameClock.activate(clock)
  try {
    const list = []
    for (const [i, t] of [0, 150, 350].entries()) {
      const r: any = { id: 7, t, mono: i * 4, x: i * 2.4, y: 70, z: 0, vx: 0.8, vy: 0, vz: 0 }
      feedTicks(list, r); list.push(r)
    }
    assert.deepEqual(list.map(r => r.tt), [0, 150, 350])
  } finally { clock.dispose(); gameClock.activate(null) }
})

for (const [wait, steps] of [[5, 1], [85, 2]]) {
  test(`clickBedAt yields during frozen ${wait} game ms and clicks after explicit steps`, async () => {
    const clock = new gameClock.GameClock({ manual: true })
    clock.setState({ is_frozen: true })
    gameClock.activate(clock)
    try {
      const { packets, completion } = click(gameClock.now() + wait)
      let done = false
      completion.then(() => { done = true })
      await gameClock.wall.sleep(20)
      assert.equal(done, false)
      assert.equal(packets.length, 0)
      assert.equal(clock.pulse(), false, 'freeze does not advance without a step')
      for (let i = 1; i <= steps; i++) {
        clock.step(1)
        assert.equal(clock.pulse(), true)
        await gameClock.wall.sleep(0)
        assert.equal(packets.length, i === steps ? 1 : 0)
      }
      const seq = await completion
      assert.equal(packets[0][0], 'block_place')
      assert.equal(packets.length, 1)
      // Own sequence (s5, 750 TPS): bedsBoom waits for its block_changed_ack instead of a game-time window.
      assert.ok(seq > 0x1000000, `sequence ${seq}`)
      assert.equal(packets[0][1].sequence, seq)
    } finally {
      clock.dispose()
      gameClock.activate(null)
    }
  })
}

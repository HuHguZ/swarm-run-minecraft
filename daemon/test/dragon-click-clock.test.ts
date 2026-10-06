'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Vec3 = require('vec3')
const gameClock = require('../src/game-clock')

const clickSource = require('./source-fixture').functionSource(path.join(__dirname, '..', 'src', 'dragon.js'), 'clickBedAt')
function click (until) {
  const packets = []
  const ctx: any = {
    gameClock, sleep: gameClock.sleep, runnerOn: () => false, envNum: (_key, fallback) => fallback,
    bot: { setControlState () {}, _client: { write: (...args) => packets.push(args) }, swingArm () {} },
    hit: { point: new Vec3(0.5, 0.5625, 0.5), block: { position: new Vec3(0, 0, 0) } }, until
  }
  // The VM timeout makes the old synchronous spin fail instead of hanging the test process.
  vm.runInNewContext(clickSource + '\ncompletion = clickBedAt(bot, hit, { aimed: true, until })', ctx, { timeout: 500 })
  return { packets, completion: ctx.completion }
}

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
      await completion
      assert.equal(packets[0][0], 'block_place')
      assert.equal(packets.length, 1)
    } finally {
      clock.dispose()
      gameClock.activate(null)
    }
  })
}

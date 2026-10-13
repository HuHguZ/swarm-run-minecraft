const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')
const { GameClock, wall } = require('../src/game-clock')

// The native hang searched a missing island with no dragon and a frozen game clock.
function search (stop, lostDragon = false) {
  const file = require.resolve('../src/dragon/pillar-run')
  const local = createRequire(file)
  let now = 0; let scans = 0; let pulse = false; let ticks = 0
  const clock = new GameClock({ manual: true, epoch: 0 })
  const ctl: any = { aborted: false, feed: {} }
  const bot: any = { health: 20, isAlive: true, game: { dimension: 'the_end' },
    entity: { position: new Vec3(100.5, 49, 0.5) }, entities: {} }
  const session: any = { bot }
  const stopNextTurn = () => setImmediate(() => { pulse = true; stop({ bot, session, ctl, advance: () => { now = 1000 } }) })
  const mocks: any = {
    './dig-down-to': { ...local('./dig-down-to'), gameClock: { now: () => now, wall,
      setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) },
      makeTrack: () => ({ tick: () => {
        if (lostDragon && ++ticks === 1) return { id: 1, position: new Vec3(0, 60, 0) }
        if (lostDragon && ticks === 2) stopNextTurn()
        return null
      } }), sleep: clock.sleep.bind(clock) },
    './fall-guard': { ...local('./fall-guard'), pickSpot () {
      if (++scans === 1) stopNextTurn()
      if (scans > 50) throw new Error('search starved the event loop')
      return null
    } },
    './pillar-plan': { ...local('./pillar-plan'), portalBlocks: () => [] }
  }
  const module = { exports: {} as any }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, require: name => mocks[name] || local(name), process, console, setImmediate, setTimeout, clearTimeout
  }, { filename: file })
  const rep = { dragon: {} as any }
  return { run: () => module.exports.fightDragon(session, ctl, rep, {}, { deadline: 1000 }),
    rep, scans: () => scans, pulse: () => pulse, pending: () => clock.timers.size, close: () => clock.dispose() }
}

for (const [name, stop] of [
  ['abort', ({ ctl }) => { ctl.aborted = true }],
  ['death', ({ bot }) => { bot.health = 0; bot.isAlive = false }],
  ['body replacement', ({ session }) => { session.bot = null }],
  ['dimension change', ({ bot }) => { bot.game.dimension = 'overworld' }],
  ['deadline', ({ advance }) => advance()]
] as any) for (const lostDragon of [false, true]) {
  test(`${lostDragon ? 'lost dragon' : 'dragon search'} yields and stops on ${name} while the game clock is frozen`, async () => {
    const s = search(stop, lostDragon)
    let timer
    try {
      await Promise.race([s.run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('search did not return')), 1000) })])
      assert.equal(s.pulse(), true, 'I/O and lifecycle events must get a turn')
      assert.equal(s.scans(), lostDragon ? 0 : 1, 'do not rescan after the body or budget ended')
      assert.notEqual(s.rep.dragon.won, true)
      assert.equal(s.pending(), 0, 'cancelled search leaves no game timer')
    } finally { clearTimeout(timer); s.close() }
  })
}

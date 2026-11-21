import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { Session } from '../src/session'
import { EventBus } from '../src/events'
import * as gameClock from '../src/game-clock'
import * as tick from './tick-plugins-fixture'

// A five-block gap separates two short, level passages. Opening the gate lays the missing floor.
for (const change of ['closed', 'moved in cell', 'moved to next cell', 'block update', 'chunk packet', 'open']) test('strict native goto on a finite walkway: ' + change, async t => {
  const clock = tick.testClock(), game = new gameClock.GameClock({ manual: true, epoch: clock.now() })
  gameClock.activate(game)
  const bot = tick.install(clock, { pathfinder: true })
  // Slice by real node expansions so host scheduling cannot decide whether the
  // body starts walking a partial path. The total native time limit still applies.
  const previousSlice = process.env.ND_ASTAR_SLICE_NODES
  process.env.ND_ASTAR_SLICE_NODES = change === 'moved in cell' ? '10' : change === 'moved to next cell' ? '5' : '32'
  t.after(() => {
    if (previousSlice === undefined) delete process.env.ND_ASTAR_SLICE_NODES
    else process.env.ND_ASTAR_SLICE_NODES = previousSlice
  })
  bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
  let open = change === 'open'
  bot.blockAt = pos => {
    const p = pos.floored(), floor = p.y === 119 && Math.abs(p.z) <= 1 && p.x >= -3 && p.x <= 13
    return tick.block(floor && (p.x <= 3 || p.x >= 9 || open) ? 'stone' : 'air', p)
  }
  bot.entity.position = new Vec3(.5, 120, .5)
  bot.entity.velocity = new Vec3(0, -.0784, 0)
  bot.entity.attributes = { [bot.physics.movementSpeedAttribute]: { value: .1, modifiers: [] } }
  bot.health = bot.food = 20; bot.game.dimension = 'overworld'; bot.entity.metadata = []
  const session = new Session({}, new EventBus(), { state: {}, append() {} })
  session.bot = bot
  session.state = () => ({ pos: bot.entity.position })
  t.mock.method(require('../src/blockmoves'), 'on', () => false)
  t.mock.method(require('../src/edges/mlg'), 'mlgDrop', () => ({ ok: false, drop: 4 }))
  const searches: number[] = []
  const roots: string[] = [], bodies: Vec3[] = []
  bot.on('path_update', result => {
    if (result.status !== 'noPath') return
    searches.push(result.visitedNodes)
    let root = result.context.bestNode
    while (root.parent) root = root.parent
    roots.push(root.data.hash)
    bodies.push(bot.entity.position.clone())
    assert.ok(result.path.length, 'the native unreachable result includes its best approach')
    if ((change === 'block update' || change === 'chunk packet') && !open) {
      open = true
      if (change === 'chunk packet') bot._client.emit('packet', {}, { name: 'map_chunk' })
      else for (let x = 4; x <= 8; x++) for (let z = -1; z <= 1; z++) {
        const bridge = new Vec3(x, 119, z)
        bot.emit('blockUpdate', tick.block('air', bridge), tick.block('stone', bridge))
      }
    }
  })
  try {
    const request = session.goto({ x: 12, z: 0, range: 1, timeoutSeconds: 10, arena: { x: 5, z: 0, r: 20, killY: 112 },
      surface: false, pathWait: true, descent: false, pearl: false, unstuck: false })
    let done = false
    request.finally(() => { done = true })
    for (let ticks = 0; !done && ticks < 220; ticks++) { game.advanceTicks(1); await clock.advanceGame(50) }
    assert.ok(done, 'the request finished within its original game-time budget')
    const receipt = await request
    if (change === 'closed') {
      assert.equal(receipt.code, 'NO_PATH', JSON.stringify(receipt))
      assert.deepEqual(bodies[0], new Vec3(.5, 120, .5))
      assert.deepEqual(searches, [21])
    } else if (change.startsWith('moved')) {
      assert.equal(receipt.code, 'NO_PATH', JSON.stringify(receipt))
      assert.deepEqual(searches, [21, 21])
      assert.ok(bodies[0].x > .5)
      assert.deepEqual(roots, ['0,120,0', change === 'moved in cell' ? '0,120,0' : '1,120,0'])
    } else {
      assert.equal(receipt.status, 'done', JSON.stringify(receipt))
      assert.ok(bot.entity.onGround && bot.entity.position.x >= 11)
      assert.equal(searches.length, change === 'open' ? 0 : 1)
    }
  } finally { session.cancel('end test'); bot.emit('end'); game.dispose(); gameClock.activate(null) }
})

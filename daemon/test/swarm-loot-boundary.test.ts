import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { Session } from '../src/session'
import { worldOf, native } from './parkour-fixture'
import * as clock from '../src/game-clock'
import { swarmMoves } from '../../farm/swarm/swarm-driver/moves'

test('H865: a real Session goto boundary failure restores its scope before a remembered-risk escape', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = 568; x <= 613; x++) for (let z = 568; z <= 613; z++) cells.push([x, 119, z, 'stone'])
  const { bot, world } = worldOf(cells)
  const start = new Vec3(590.7076710904037, 121.17675927506424, 591.6013752773171)
  Object.assign(bot.entity, { id: 1, name: 'player', type: 'player', height: 1.8, metadata: [], position: start.clone(),
    velocity: new Vec3(.015483305531029392, -.15233518685055708, .22451701217068432), onGround: false })
  bot.entities = {}; bot.players = {}
  bot.controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.setControlState = (key, value) => { bot.controlState[key] = value }
  bot.clearControlStates = () => { for (const key of Object.keys(bot.controlState)) bot.controlState[key] = false }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.pathfinder = { goal: null, movements: null, isMoving: () => false, isMining: () => false, isBuilding: () => false,
    setGoal(goal) { this.goal = goal }, setMovements(movements) { this.movements = movements } }
  const s: any = Object.assign(Object.create(Session.prototype), { bot, mcData: bot.registry, underSky: () => true,
    stuckCells: new Map(), bus: { drain: () => [] }, state: () => ({ pos: bot.entity.position.floored() }) })
  bot._ndReflexSession = s
  s.runIntent = (name, work, options) => Session.prototype.runIntent.call(s, name, work, { ...options, interruptible: false })
  const avoid = [
    { x: 616.7006255842927, y: 120.41999998688698, z: 611.4340413117765, r: 22 },
    { x: 610.3219847038408, y: 120, z: 591.4947316178432, r: 19.83516984197588 },
    { x: 632.3737208270263, y: 122, z: 577.3145397602915, r: 22 },
    { x: 612.0010137069759, y: 120.12141600251198, z: 598.7540827487211, r: 22 },
    { x: 648.4170453716952, y: 120, z: 583.4861091216353, r: 22 },
    { x: 647.5000153938498, y: 120, z: 581.4999458556349, r: 22 },
    { x: 616.3856507795956, y: 120, z: 604.2939389983982, r: 22 },
    { x: 631.424584286063, y: 120.79670897126198, z: 612.4316225883089, r: 22 },
    { x: 612.481936499961, y: 120, z: 615.3150851865596, r: 22 },
    { x: 615.5106346693942, y: 120, z: 598.2102941704904, r: 22 },
    { x: 628.6998861454938, y: 120, z: 629.1387856502332, r: 22 },
    { x: 646.5, y: 120, z: 619.5, r: 22 }
  ]
  const arena = { x: 600.5, y: 120, z: 600.5, r: 80, killY: 113, ellipse: { a: 77, b: 65 }, avoid }
  const calls: any[] = [], pos = { A: { p: start.floored(), inv: {}, hp: 20 } }, task = { kind: 'loot', data: { weak: true } }
  const b: any = { name: 'A', swarmTask: task, c: { async call(method, params) {
    calls.push({ method, params })
    if (method === 'flee') assert.equal(s.gotoArena, undefined, 'the failed goto must release its hard avoidance scope first')
    const action = b.last = { m: method, p: params, pending: true }
    try { return await s[method](params) } finally { action.pending = false }
  } } }
  const foes = avoid.map((p, i) => ({ id: 'seen' + i, position: p, seenAt: 1000 }))
  const sw: any = { arena, pos, generation: 1, alive: () => true, now: () => 1000, log() {}, boardOf: () => ({ enemies: () => foes }) }
  Object.assign(sw, swarmMoves(sw))
  const game = clock.activate(new clock.GameClock({ manual: true }))
  let result: any
  const pending = sw.go(b, { x: 571.5, y: 120, z: 568.5, tier: 0 }, 2, 6, arena).then(value => { result = value })
  try {
    for (let tick = 0; tick < 100 && !result; tick++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const state = new native.PlayerState(bot, bot.controlState)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      game.advanceTicks(1); bot.emit('physicsTick')
      assert.ok(Math.abs(bot.entity.position.x - arena.x) + .3 <= arena.r && Math.abs(bot.entity.position.z - arena.z) + .3 <= arena.r)
      assert.ok(bot.entity.position.y > arena.killY)
    }
    assert.equal(result?.status, 'failed')
    assert.equal(result?.code, 'ARENA_BOUNDARY', 'the original route receipt stays failed')
    assert.equal(result?.error, 'next physical step leaves arena bounds')
    const escape = calls.find(c => c.method === 'flee')
    assert.ok(escape, 'a near remembered threat requires the existing escape after this native failure')
    assert.deepEqual(escape.params.arena.avoid, avoid)
    assert.ok(Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z) > 1, 'actual intent/physics execution makes bounded progress')
    assert.equal(s.gotoArena, undefined)
    assert.equal(bot.listeners('physicsTick').some(fn => fn.name === 'checkBounds'), false, 'no stale goto boundary handler survives')
  } finally {
    s.cancel('test complete'); game.advanceTicks(200); await pending
    game.dispose(); clock.activate(null)
  }
})

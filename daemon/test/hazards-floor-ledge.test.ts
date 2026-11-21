import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { worldOf, native, drive } from './parkour-fixture'
import { hazardMethods } from '../src/rpc/hazards'
import { Session } from '../src/session'
import { EventBus } from '../src/events'

async function run(length: number, stepped = false, radius = 64, lateral = 0) {
  const cells: Array<[number, number, number, string]> = []
  for (let x = 0; x <= length; x++) {
    cells.push([x, 63, 0, 'stone'])
    if (stepped && x > 0) cells.push([x, 64, 0, 'stone'])
    if (!lateral) for (const z of [-1, 1]) for (let y = 64; y <= 67; y++) cells.push([x, y, z, 'stone'])
  }
  return evadeOn(cells, new Vec3(.5, 64, .5), new Vec3(.18, -.0784, lateral), { x: 1, z: 0 }, radius)
}

async function evadeOn(cells, at, velocity, dir, radius = 64) {
  const { bot, world } = worldOf(cells)
  bot.entity.position = at; bot.entity.velocity = velocity
  drive(bot, world)
  let frames = 0
  bot._ndSimOrig = (s, w) => { frames++; return bot.physics.simulatePlayer(s, w) }
  const looks: number[] = [], look = bot.look
  bot.look = async yaw => { looks.push(yaw); await look(yaw) }
  const samples = [], tick = () => {
    const s = new native.PlayerState(bot, bot.controlState)
    bot.physics.simulatePlayer(s, world); s.apply(bot)
    samples.push({ x: s.pos.x, y: s.pos.y, ground: s.onGround, jump: bot.controlState.jump })
  }
  const session = { require: () => bot, runIntent: (_name, fn) => fn({ aborted: false }) }
  const rpc = hazardMethods({ session, gameClock: { sleep: async () => { tick() } } })
  const result = await rpc.evade({ dir, ticks: 9, jump: true, maxDrop: 0, arena: { x: 0, z: 0, r: radius, killY: 61 } })
  for (let i = 0; i < 24; i++) tick()
  return { samples, result: result.detail ?? result, end: bot.entity.position, looks, frames }
}

test('escaping a cracking floor stops on the short lip after the evade releases its keys', async () => {
  const { samples, end, result } = await run(2)
  assert.equal(result.ok, true)
  assert.ok(end.x > 1.3, 'the body leaves the threatened starting support')
  assert.ok(samples.every(s => s.y >= 64 - 1e-6), JSON.stringify({ end, lowest: Math.min(...samples.map(s => s.y)) }))
})

test('a long supported upper step still permits a jumping floor escape', async () => {
  const { samples, end } = await run(12, true)
  assert.ok(samples.some(s => !s.ground && s.jump))
  assert.ok(end.y === 65 && end.x > 1.3)
})

test('floor outside the arena cannot be used as a braking strip', async () => {
  const { samples, end, result } = await run(12, false, 3.6)
  assert.equal(result.ok, true)
  assert.ok(end.x > 1.3)
  assert.ok(samples.every(s => s.x + .3 <= 3.6))
})

test('a runner carrying lateral momentum stays on the one-block-wide lip', async () => {
  const { samples, end, result } = await run(12, false, 64, .17)
  assert.equal(result.ok, true)
  assert.ok(end.x > 1.3)
  assert.ok(samples.every(s => s.y >= 64 - 1e-6))
})

for (const landing of [true, false]) test(landing ? 'a sideways floor escape arrests outward knockback when the requested direction cannot' :
  'outward knockback with no side landing sends no speculative turn or movement controls', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = landing ? -9 : 0; x <= 0; x++) for (let z = -10; z <= 12; z++) cells.push([x, 63, z, 'stone'])
  const { result, end, samples, looks, frames } = await evadeOn(cells, new Vec3(.72, 64, .5), new Vec3(.30, -.0784, 0), { x: 0, z: 1 })
  assert.equal(result.ok, landing)
  assert.ok(frames > 0 && frames <= 179)
  if (landing) {
    assert.ok(result.dir.x < 0, 'steer inward from the open east edge')
    assert.equal(looks.length, 1, 'only the selected yaw is sent to the client')
    assert.ok(end.x + .3 <= 1 && samples.every(s => s.y >= 64), 'the whole body rests inside the eastern lip')
  } else {
    assert.deepEqual(looks, [])
    assert.equal(samples.length, 24, 'only the uncontrollable coast after the refused command was simulated')
  }
})

test('a floor evacuation takes the live flank route only with a currently supported braking strip', async () => {
  const cells = []
  for (let x = -9; x <= 0; x++) for (let z = -10; z <= 12; z++) cells.push([x, 63, z, 'stone'])
  const { bot, world } = worldOf(cells)
  const original = world.getBlock
  let strip = false, vanished = false, goal = null, clears = 0
  world.getBlock = pos => {
    if (!vanished && (pos.x >= 0 || strip)) return original(pos)
    const air = original(pos.offset(0, -40, 0)); air.position = pos.floored()
    return air
  }
  bot.entity.position = new Vec3(.72, 64, .5); bot.entity.velocity = new Vec3(.30, -.0784, 0)
  drive(bot, world)
  bot.pathfinder = { setGoal(value) { goal = value } }
  const clear = bot.clearControlStates
  bot.clearControlStates = () => { clears++; clear() }
  const session = new Session({}, new EventBus(), { state: {}, append() {} })
  session.bot = bot
  session.state = () => ({ connected: true, busy: session.current?.name })
  session.tactics = { enabled: () => false } as any
  const rpc = hazardMethods({ session, gameClock: { sleep: () => bot.waitForTicks(1) } })
  let began, finish
  const active = new Promise<void>(resolve => { began = resolve })
  const flank = { x: 0, y: 64, z: 11 }
  const walk = session.runIntent('goto', ctl => new Promise(resolve => {
    bot.pathfinder.setGoal(flank); bot.setControlState('forward', true)
    finish = resolve; ctl.onAbort.push(resolve); began()
  }), { interruptible: false, timeoutMs: 0 })
  await active
  const owner = session.current, cleared = clears
  const attempt = () => rpc.evade({ dir: { x: 0, z: 1 }, ticks: 9, jump: true, maxDrop: 0, arena: { x: 0, z: 0, r: 64, killY: 61 } })
  try {
    const no: any = await attempt()
    assert.equal(session.current, owner, 'the failed coast must not cancel the original moving worker')
    assert.equal(owner.ctl.aborted, false); assert.equal(goal, flank)
    assert.equal(clears, cleared); assert.equal(bot.getControlState('forward'), true)
    assert.equal(no.notStarted, true); assert.match(no.detail.why, /остановиться на опоре/)
    const lock = require('../src/reflex-lock')
    let releaseShield
    const shield = new Promise<void>(resolve => { releaseShield = resolve })
    const held = lock.start(session, () => shield, { owner: 'Tactical', priority: 2 })
    try {
      assert.equal((await attempt()).code, 'NO_SAFE_EVADE')
      assert.equal(lock.owner(session)?.owner, 'Tactical'); assert.equal(session.current, owner)
    } finally { releaseShield(); await held }
    // While an emergency owns the feet, the candidate changes without the observer moving.
    const atHandover = async (before: boolean, after: boolean) => {
      strip = before
      let resume
      const wait = new Promise<void>(resolve => { resume = resolve })
      const hold = lock.start(session, () => wait, { owner: 'Emergency', priority: 3 })
      const pending = attempt()
      strip = after
      bot.emit('blockUpdate', null, world.getBlock(new Vec3(-1, 63, 0)))
      resume(); await hold
      return pending
    }
    const closed: any = await atHandover(true, false)
    assert.equal(closed.code, 'NO_SAFE_EVADE')
    assert.equal(closed.notStarted, true); assert.equal(session.current, owner); assert.equal(owner.ctl.aborted, false)
    const yes: any = await atHandover(false, true)
    assert.equal(yes.status, 'done'); assert.equal(yes.detail.ok, true)
    assert.equal(owner.ctl.aborted, true); assert.equal((await walk).by.by, 'evade')
    for (let i = 0; i < 24; i++) await bot.waitForTicks(1)
    assert.ok(bot.entity.position.x + .3 <= 1 && bot.entity.position.y === 64)
    // After a valid takeover, a block removed during look invalidates the braking forecast too.
    bot.entity.position = new Vec3(.72, 64, .5); bot.entity.velocity = new Vec3(.30, -.0784, 0)
    const look = bot.look, keys = bot.setControlState
    let commands = 0
    bot.look = async yaw => { await look(yaw); vanished = true; bot.emit('blockUpdate', null, world.getBlock(new Vec3(0, 63, 0))) }
    bot.setControlState = (k, v) => { if (v) commands++; keys(k, v) }
    const moved: any = await attempt()
    assert.equal(moved.detail.ok, false); assert.match(moved.detail.why, /до начала схода/); assert.equal(commands, 0)
    assert.equal(bot.listenerCount('blockUpdate'), 0)
  } finally { finish(); await walk }
})

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { detectApex, observationStop, observeFlight, windContact, FlightFrame, apexRelease, diveGate, activeStrafe, anvilContact, drainTelemetry, nativeHpAgreement, fixtureReady, fixtureBarrier, waitWindReady, anvilArm } from './swarm/swarm-driver/combo-anvil'

const frame = (ms: number, y: number, vy: number, onGround = false): FlightFrame => ({ ms, x: 600.5, y, z: 600.5, vy, onGround })

test('water rescue changes only the second action while both arms keep first wind and matching starts', () => {
  const off = anvilArm(false, 'water'), on = anvilArm(true, 'water')
  assert.equal(off.firstWind, true); assert.equal(on.firstWind, true)
  assert.equal(off.supportZ, 606.5); assert.equal(on.supportZ, off.supportZ)
  assert.equal(off.waterEnabled, false); assert.equal(on.waterEnabled, true)
  assert.equal(anvilArm(false).firstWind, false); assert.equal(anvilArm(true).firstWind, true)
  assert.equal(anvilArm(false).supportZ, 604.5)
})

test('CLI routes active water rescue through the shared trial with active controls and preserves prior modes', async () => {
  const source = readFileSync(require.resolve('./swarm/swarm-driver/combo-anvil'), 'utf8')
  const main = source.lastIndexOf('if (require.main === module)')
  assert.ok(main > 0)
  for (const [mode, expected] of [
    ['rescue-motion-control', [false, 2, 20, 'water-motion']],
    ['rescue-active', [true, 2, 20, 'water']], ['rescue', [false, 2, 20, 'water']],
    ['active', [true, 2, 20, undefined]], ['active-ready', ['ready', 2, 20, undefined]], ['apex', [false, 2, 20, undefined]],
  ] as const) {
    const calls: any[] = [], exits: number[] = [], module = { exports: {} }
    const localRequire: any = (name: string) => require(name)
    localRequire.main = module
    runInNewContext(source.slice(0, main) + '\napexTrials = capture;\n' + source.slice(main), {
      require: localRequire, module, exports: module.exports, console,
      process: { argv: ['node', 'combo-anvil.js', mode, '2', '20'], exit: (code: number) => exits.push(code) },
      capture: (...args: any[]) => { calls.push(args); return Promise.resolve() },
    })
    await Promise.resolve()
    assert.deepEqual(calls, [[...expected]], mode)
    assert.deepEqual(exits, [0], mode)
  }
})

test('ground idle negative velocity and rising-only observations do not prove an apex', () => {
  assert.equal(detectApex([frame(0, 151, -.0784, true), frame(50, 151, -.0784, true)]), null)
  assert.equal(detectApex([frame(0, 151, 0, true), frame(50, 152, .3), frame(100, 152.3, -.01)]), null)
})

test('a falling position confirms the highest airborne sample, not the post-drag velocity zero', () => {
  const apex = detectApex([frame(0, 151, 0, true), frame(50, 152, .3), frame(100, 152.3, -.01),
    frame(150, 152.29, -.08), frame(200, 152.21, -.16)])
  assert.equal(apex?.y, 152.3)
  assert.equal(apex?.ms, 100)
  assert.equal(apex?.confirmedAtMs, 150)
})

test('stale frames cannot confirm descent or move the selected apex', () => {
  const apex = detectApex([frame(0, 151, 0, true), frame(100, 152, .5), frame(50, 150, -.5),
    frame(150, 153, -.01), frame(200, 152.99, -.08)])
  assert.equal(apex?.ms, 150)
})

test('standing still after a failed launch waits for timeout, airborne then grounded ends observation', () => {
  assert.equal(observationStop([frame(0, 151, -.0784, true)], 3999, false), null)
  assert.equal(observationStop([frame(0, 151, -.0784, true)], 4000, false), 'timeout')
  assert.equal(observationStop([frame(0, 151, 0, true), frame(50, 152, .2), frame(100, 151, -.0784, true)], 100, false), 'landed')
})

test('AUTO-STOP wins even when landing or timeout is simultaneously observed', () => {
  assert.equal(observationStop([frame(0, 152, -.1), frame(50, 151, -.0784, true)], 4000, true), 'AUTO-STOP')
})

test('observation notices STOP while physics is silent and has a wall-clock fallback', async () => {
  assert.equal(await observeFlight([], () => true), 'AUTO-STOP')
  assert.equal(await observeFlight([], () => false, 5), 'timeout')
  let stop = false
  const timer = setTimeout(() => { stop = true }, 5)
  try { assert.equal(await observeFlight([], () => stop), 'AUTO-STOP') }
  finally { clearTimeout(timer) }
})

test('release and HP alone are not native contact; wrong damage cause or shooter does not count', () => {
  for (const damage of [[], [{ sourceTypeId: 26, sourceCauseId: 8 }], [{ sourceTypeId: 47, sourceCauseId: 9 }]])
    assert.equal(windContact({ damage, explosions: [] }, 7).contact, false)
})

test('attributed wind hit and native nonzero burst impulse independently prove contact', () => {
  const direct = windContact({ damage: [{ sourceTypeId: 47, sourceCauseId: 8 }], explosions: [] }, 7)
  assert.equal(direct.contact, true)
  assert.equal(direct.kind, 'direct')
  const burst = windContact({ damage: [], explosions: [{ impulse: { x: 0, y: .8, z: 0 } }] }, 7)
  assert.equal(burst.contact, true)
  assert.equal(burst.kind, 'burst')
  assert.equal(windContact({ damage: [], explosions: [{ impulse: { x: 0, y: 0, z: 0 } }, {}] }, 7).contact, false)
})

test('apex forecast uses fresh rising positions and native gravity/drag, never a repeated pose or descent', () => {
  const old = { x: 0, y: 151, z: 0 }, up = { x: 0, y: 152, z: 0 }
  assert.equal(apexRelease(old, up, 1.2).ready, false)
  assert.equal(apexRelease(old, up, .4).ready, true)
  assert.equal(apexRelease(old, up, .4).remaining, 5)
  assert.equal(apexRelease(up, { ...up }, .01).ready, false)
  assert.equal(apexRelease(up, old, -.1).ready, false)
  assert.equal(apexRelease(null, up, .4).ready, false)
})

test('experimental twenty-HP dive gate waits past two blocks using saved release height and downward motion', () => {
  assert.equal(diveGate(163, 163 - 1.5926046, -.4), false)
  assert.equal(diveGate(163, 161, -.4), false)
  assert.equal(diveGate(163, 163 - 2.10955, .1), false)
  assert.equal(diveGate(163, 163 - 2.10955, -.1), true)
})

test('active strafe has matching ten-tick phases, ends at eighty ticks and cleans death/STOP controls', () => {
  const bot: any = new EventEmitter(), controls: any = {}
  bot.setControlState = (name: string, value: boolean) => { controls[name] = value }
  let stop = false
  const active = activeStrafe(bot, () => stop)
  assert.equal(controls.left, true)
  for (let tick = 0; tick < 9; tick++) bot.emit('physicsTick')
  assert.equal(controls.left, true)
  bot.emit('physicsTick'); assert.equal(controls.right, true)
  for (let tick = 10; tick < 80; tick++) bot.emit('physicsTick')
  assert.equal(active.done, true); assert.equal(active.ticks, 80)
  assert.equal(controls.left, false); assert.equal(controls.right, false)
  const dying = activeStrafe(bot, () => false); bot.emit('death'); assert.equal(dying.done, true)
  const halted = activeStrafe(bot, () => stop); stop = true; bot.emit('physicsTick')
  assert.equal(halted.done, true); assert.equal(bot.listenerCount('physicsTick'), 0)
})

test('native air contact requires matching accepted server damage, packet-only contact keeps airborne unknown', () => {
  const hit = { event: 'mace_damage', attackerId: 7, targetId: 8, cancelled: false, finalDamage: 12,
    damageTypeKey: 'minecraft:mace_smash', targetOnGround: false, fallDistance: 3 }
  const proof = anvilContact([hit], [], 7, 8)
  assert.equal(proof.contact, true); assert.equal(proof.airContact, true)
  assert.equal(anvilContact([{ ...hit, cancelled: true }], [], 7, 8).contact, false)
  assert.equal(anvilContact([hit], [], 9, 8).contact, false)
  assert.equal(anvilContact([{ ...hit, targetOnGround: true }], [], 7, 8).airContact, false)
  const packet = anvilContact([], [{ entityId: 8, sourceTypeId: 26, sourceCauseId: 8 }], 7, 8)
  assert.equal(packet.contact, true); assert.equal(packet.airContact, null)
})

test('a fallback hit after eighty active ticks remains total contact but is not active contact', () => {
  const hit = { event: 'mace_damage', attackerId: 7, targetId: 8, cancelled: false, finalDamage: 12,
    targetOnGround: false, ms: 5100 }
  const window = { fromMs: 1000, throughMs: 5000 }
  const late = anvilContact([hit], [], 7, 8, window)
  assert.equal(late.contact, true)
  assert.equal(late.withinActiveWindow, false)
  assert.equal(late.airWithinActiveWindow, false)
  const active = anvilContact([{ ...hit, ms: 4999 }], [], 7, 8, window)
  assert.equal(active.withinActiveWindow, true)
  assert.equal(active.airWithinActiveWindow, true)
  assert.equal(anvilContact([], [{ entityId: 8, sourceTypeId: 26, sourceCauseId: 8 }], 7, 8, window).withinActiveWindow, null)
})

test('landing before a delayed health packet keeps telemetry open for three further physics ticks', async () => {
  const bot: any = new EventEmitter()
  bot.health = 100; bot.entity = { onGround: true }
  let capturedHp = bot.health
  const health = () => { capturedHp = bot.health }
  bot.on('health', health)
  const draining = drainTelemetry([bot], () => false)
  bot.emit('physicsTick')
  setImmediate(() => {
    bot.health = 93; bot.emit('health')
    bot.emit('physicsTick'); bot.emit('physicsTick')
  })
  const tail = await draining
  bot.removeListener('health', health)
  assert.equal(capturedHp, 93)
  assert.deepEqual(tail.ticks, [3])
  assert.equal(tail.reason, 'drained')
  assert.equal(bot.listenerCount('physicsTick'), 0)
})

test('native HP cross-check exposes missed first-life damage without comparing a respawn to the dead life', () => {
  const raw = 'NeuroFarm28b0 has the following entity data: 93.0f'
  assert.equal(nativeHpAgreement(raw, { hp: 100, deaths: 0 }).matches, false)
  assert.equal(nativeHpAgreement(raw, { hp: 93, deaths: 0 }).matches, true)
  assert.equal(nativeHpAgreement(raw, { hp: 0, deaths: 1 }).matches, null)
  assert.equal(nativeHpAgreement('No entity was found', { hp: 93, deaths: 0 }).matches, null)
})

test('fixture readiness requires the intended client and server pose plus the received glass support', () => {
  const wanted = { x: 600.5, y: 163, z: 597.5 }
  const ready = { client: wanted, native: '[600.5d, 163.0d, 597.5d]', onGround: true,
    support: { name: 'glass', boundingBox: 'block' } }
  assert.equal(fixtureReady(ready, wanted), true)
  assert.equal(fixtureReady({ ...ready, client: { ...wanted, y: 151 } }, wanted), false)
  assert.equal(fixtureReady({ ...ready, native: '[600.5d, 151.0d, 597.5d]' }, wanted), false)
  assert.equal(fixtureReady({ ...ready, support: null }, wanted), false)
  assert.equal(fixtureReady({ ...ready, onGround: false }, wanted), false)
})

test('blocked preparation fails with its receipt before dry hop rather than retrying teleport', async () => {
  const wanted = { x: 600.5, y: 163, z: 597.5 }
  const stale = { client: { ...wanted, y: 151 }, native: '[600.5d, 163.0d, 597.5d]', onGround: true,
    support: { name: 'glass', boundingBox: 'block' } }
  let dryHopped = false, reads = 0
  await assert.rejects(async () => {
    await fixtureBarrier(async () => { reads++; return stale }, wanted, () => false, 0)
    dryHopped = true
  }, (error: any) => error.fixture?.sample.client.y === 151 && error.fixture?.sample.native.includes('163.0d'))
  assert.equal(dryHopped, false)
  assert.equal(reads, 1)
})

const movingReceipt = (t: number, x: number, ageTicks = 0): any => ({ atMs: t, visible: true, afterBaseline: true,
  confidence: true, position: { x, y: 151, z: 600.5 }, receipt: { t, kind: 'rel_entity_move', x, y: 151, z: 600.5 },
  velocity: { x: .15, y: 0, z: 0, ageTicks } })

test('wind readiness waits through a stationary target and times out without refusing the upcoming attempt', async () => {
  let reads = 0
  const result = await waitWindReady(() => ({ ...movingReceipt(++reads, 600.5), velocity: { x: 0, y: 0, z: 0, ageTicks: 0 } }), () => false)
  assert.equal(result.ready, false)
  assert.equal(result.reason, 'timeout')
  assert.ok(result.elapsedMs >= 500)
})

test('stale or unseen moving receipts cannot become ready simply by waiting', async () => {
  let reads = 0
  const result = await waitWindReady(() => ({ ...movingReceipt(++reads, 600.5 + reads / 10, 2), visible: reads % 2 === 0 }), () => false)
  assert.equal(result.ready, false)
  assert.equal(result.reason, 'timeout')
})

test('readiness requires two new distinct horizontal receipts and a fresh known visible velocity', async () => {
  const samples = [{ ...movingReceipt(1, 600.5), afterBaseline: false }, movingReceipt(2, 600.6), movingReceipt(2, 600.6),
    { ...movingReceipt(3, 600.7), confidence: false }, movingReceipt(4, 600.8)]
  let reads = 0
  const result = await waitWindReady(() => samples[Math.min(reads++, samples.length - 1)], () => false)
  assert.equal(result.ready, true)
  assert.equal(result.reason, 'ready')
  assert.equal(reads, 5)
  assert.equal(result.observations.length, 3)
  assert.equal(result.current?.receipt?.t, 4)
})

test('STOP or a first-life death cancels readiness promptly without waiting for its wall timeout', async () => {
  let reads = 0
  assert.equal((await waitWindReady(() => { reads++; return movingReceipt(1, 600.5) }, () => true)).reason, 'cancelled')
  assert.equal(reads, 0)
  let dead = false
  const timer = setTimeout(() => { dead = true }, 5)
  try { assert.equal((await waitWindReady(() => movingReceipt(1, 600.5), () => dead)).reason, 'cancelled') }
  finally { clearTimeout(timer) }
})

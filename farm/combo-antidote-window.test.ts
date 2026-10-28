import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { antidoteWindowPhase } from './swarm/swarm-driver/combo-antidote-window'

function fixture() {
  const bots: any[] = [0, 1].map(i => {
    const bot: any = new EventEmitter(), serializer: any = new EventEmitter()
    serializer.proto = { parsePacketBuffer: (_type: string, b: Buffer) => ({ data: JSON.parse(b.toString()) }) }
    Object.assign(bot, { username: `actor${i}`, health: 100, quickBarSlot: 0, usingHeldItem: false,
      entity: { id: i + 1, position: { x: 600.5, y: 151, z: i ? 600.5 : 606.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true },
      _client: Object.assign(new EventEmitter(), { serializer }), inventory: { slots: [{ name: 'bow' }, { name: 'arrow' }] },
      setQuickBarSlot(slot: number) { bot.quickBarSlot = slot; bot.usingHeldItem = false }, clearControlStates() {},
      activateItem() { bot.usingHeldItem = true; send(bot, 'use_item', {}) },
      deactivateItem() { if (bot.usingHeldItem) { send(bot, 'block_dig', { status: 5 }); bot.usingHeldItem = false } },
      quit() { bot.emit('end') }, waitForTicks(n: number) { return new Promise<void>(resolve => { const fn = () => { if (--n <= 0) { bot.removeListener('physicsTick', fn); resolve() } }; bot.on('physicsTick', fn) }) },
    })
    Object.defineProperty(bot, 'heldItem', { get: () => bot.inventory.slots[bot.quickBarSlot] })
    return bot
  })
  const [shooter, patient] = bots, target = { ...patient.entity, username: patient.username, isValid: true }
  let ticks = 0, visible = true, stopped = false
  const send = (bot: any, name: string, params: any) => bot._client.serializer.emit('data', Buffer.from(JSON.stringify({ name, params })))
  const timer = setInterval(() => { ticks++; bots.forEach(bot => bot.emit('physicsTick')) }, 1)
  const actions: any = { target: () => target, visible: () => visible, landing: async () => ({ reason: 'landed' }), drain: async () => {},
    shoot: async (_bot: any, _target: any, opts: any) => {
      shooter.quickBarSlot = 0; shooter.activateItem()
      for (let i = 0; i < 20; i++) { await shooter.waitForTicks(1); if (opts.shouldStop()) { shooter.setQuickBarSlot(1); return { shot: false, why: 'cancelled' } } }
      opts.holdWhile?.()
      if (opts.shouldStop()) { shooter.setQuickBarSlot(1); return { shot: false, why: 'cancelled' } }
      opts.onRelease?.(); shooter.deactivateItem(); patient.health -= 3; patient.emit('health')
      shooter.emit('entitySpawn', { id: 100 + ticks, name: 'arrow', position: { ...shooter.entity.position } })
      return { shot: true, fullChargeConfirmed: true }
    },
  }
  return { shooter, patient, actions, stop: () => stopped, setStop: () => { stopped = true }, hide: () => { visible = false }, ticks: () => ticks,
    close: () => clearInterval(timer) }
}

test('cold and already-full bow use the same 32-tick window, with no cleanup weak release', async () => {
  for (const [condition, expected] of [['cold', 1], ['prepared_full_ge20', 2]] as const) {
    const f = fixture(), activate = f.shooter.activateItem
    try {
      const result = await antidoteWindowPhase(f.shooter, f.patient, condition, f.stop, f.actions)
      assert.equal(result.window.ticks, 32)
      assert.equal(result.packets.filter(p => p.direction === 'serialized' && p.name === 'block_dig' && p.data.status === 5 && p.phase === 'window').length, expected)
      assert.equal(result.packets.filter(p => p.direction === 'serialized' && p.name === 'block_dig' && p.data.status === 5 && p.phase === 'tail').length, 0)
      assert.ok(result.attempts.some(a => !a.result.shot), 'the unfinished next full draw remains a cancelled attempt')
      assert.equal(result.joined, true); assert.equal(f.shooter.usingHeldItem, false); assert.equal(f.shooter.activateItem, activate)
      assert.equal(f.shooter.listenerCount('physicsTick'), 0)
    } finally { f.close() }
  }
})

test('health received after the boundary belongs to the projectile tail, not the window', async () => {
  const f = fixture()
  f.actions.drain = async () => { await f.shooter.waitForTicks(2); f.patient.health -= 4; f.patient.emit('health') }
  try {
    const result = await antidoteWindowPhase(f.shooter, f.patient, 'cold', f.stop, f.actions)
    assert.equal(result.window.observedHpLoss, 3)
    assert.equal(result.tail.observedHpLoss, 4)
    assert.equal(result.tail.hpEnd, 93)
    assert.equal(result.health.filter(h => h.actor === f.patient.username && h.phase === 'tail').at(-1).hp, 93)
  } finally { f.close() }
})

test('a late health receipt while the cancelled shot is joining is still included in the tail', async () => {
  const f = fixture(), shoot = f.actions.shoot
  f.actions.shoot = async (...args: any[]) => {
    const result = await shoot(...args)
    if (!result.shot) { f.patient.health -= 4; f.patient.emit('health') }
    return result
  }
  try {
    const result = await antidoteWindowPhase(f.shooter, f.patient, 'cold', f.stop, f.actions)
    assert.equal(result.window.observedHpLoss, 3)
    assert.equal(result.tail.observedHpLoss, 4)
    assert.equal(result.tail.hpEnd, 93)
  } finally { f.close() }
})

test('STOP, first-life death or lost public sight cancel the current draw without a release', async () => {
  for (const why of ['stop', 'death', 'respawn', 'sight']) {
    const f = fixture()
    const listener = () => { if (f.ticks() === 7) { if (why === 'stop') f.setStop(); else if (why === 'death') f.shooter.emit('death'); else if (why === 'respawn') {
      f.shooter.entity = { ...f.shooter.entity }; f.shooter.emit('respawn')
    } else f.hide() } }
    f.shooter.on('physicsTick', listener)
    try {
      const result = await antidoteWindowPhase(f.shooter, f.patient, 'cold', f.stop, f.actions)
      assert.equal(result.packets.filter(p => p.direction === 'serialized' && p.name === 'block_dig' && p.data.status === 5).length, 0)
      assert.equal(result.joined, true); assert.equal(f.shooter.usingHeldItem, false)
    } finally { f.shooter.removeListener('physicsTick', listener); f.close() }
  }
})

test('death followed by the same client respawning cannot turn first-life tail HP into fresh health', async () => {
  const f = fixture()
  f.actions.drain = async () => { f.patient.health = 0; f.patient.emit('death'); f.patient.entity = { ...f.patient.entity }; f.patient.health = 20; f.patient.emit('respawn'); f.patient.emit('health') }
  try {
    const result = await antidoteWindowPhase(f.shooter, f.patient, 'cold', f.stop, f.actions)
    assert.equal(result.window.hpEnd, 97)
    assert.equal(result.tail.hpEnd, 0)
    assert.equal(result.tail.observedHpLoss, 97)
    assert.equal(result.health.at(-1).hp, 0)
  } finally { f.close() }
})

test('a stopped physics stream ends through the fixed wall cap and joins the cancelled helper', async () => {
  const f = fixture(), activate = f.shooter.activateItem
  f.close()
  f.actions.shoot = async (_bot: any, _target: any, options: any) => {
    f.shooter.activateItem()
    while (!options.shouldStop()) await new Promise(resolve => setTimeout(resolve, 5))
    f.shooter.setQuickBarSlot(1)
    return { shot: false, why: 'cancelled' }
  }
  const result = await antidoteWindowPhase(f.shooter, f.patient, 'cold', f.stop, f.actions)
  assert.equal(result.why, 'wall_cap'); assert.equal(result.hardClosed, true); assert.equal(result.joined, true)
  assert.equal(result.packets.some(p => p.direction === 'serialized' && p.name === 'block_dig' && p.data.status === 5), false)
  assert.equal(f.shooter.activateItem, activate); assert.equal(f.shooter.listenerCount('physicsTick'), 0)
})

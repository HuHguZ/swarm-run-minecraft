import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { piercingPhase, piercingTrials, piercingPoses } from './swarm/swarm-driver/combo-piercing'

const pause = () => new Promise(resolve => setTimeout(resolve, 1))
const point = (x: number): any => ({ x, y: 151, z: 600.5, offset(dx, dy, dz) { return { x: x + dx, y: 151 + dy, z: 600.5 + dz } } })
function fixture() {
  const calls: any[] = []
  const bots = ['A', 'T', 'E'].map((username, i) => {
    const bot: any = new EventEmitter()
    bot.username = username; bot.health = 100; bot.ticks = 0; bot.controls = {}; bot.usingHeldItem = false
    bot.entity = { id: i + 1, position: point(600.5 + i * 2.8), velocity: { x: 0, y: 0, z: 0 }, onGround: true, yaw: 0, pitch: 0 }
    bot._client = new EventEmitter(); bot._client.serializer = new EventEmitter()
    bot._client.serializer.proto = { parsePacketBuffer: (_, bytes) => ({ data: JSON.parse(bytes.toString()) }) }
    bot._client.write = (name, params) => { calls.push({ name, params }); bot._client.serializer.emit('data', Buffer.from(JSON.stringify({ name, params }))) }
    bot.clearControlStates = () => { bot.controls = {} }; bot.deactivateItem = () => { bot.usingHeldItem = false }
    bot.activateItem = () => { throw Error('ordinary STAB must not activate held use') }
    bot.attack = () => { throw Error('ordinary STAB must not send entity attack') }
    bot.quit = () => bot.emit('end')
    return bot
  })
  const [a, t, e] = bots
  a.heldItem = { name: 'iron_spear' }
  a.entities = Object.fromEntries([t, e].map(bot => {
    const entity: any = { ...bot.entity, username: bot.username }
    Object.defineProperty(entity, 'health', { get() { throw Error('enemy HP is not a decision input') } })
    return [entity.id, entity]
  }))
  let stopped = false, beforeTick = () => {}, pending = 0
  const actions: any = {
    target: (bot, name) => Object.values<any>(bot.entities ?? {}).find(entity => entity.username === name),
    visible: () => true, teamSafe: () => true,
    readyIn: () => a.ticks < 20 ? 50 : 0,
    jabReach: () => ({ ok: true, aim: { yaw: -Math.PI / 2, pitch: 0 } }),
    jab: async (bot, target, opts) => {
      pending++
      try {
        await pause()
        if (opts.abortIf()) return { ok: false, why: 'cancelled' }
        calls.push({ jab: target.username, ticks: a.ticks, using: bot.usingHeldItem })
        bot._client.write('block_dig', { status: 7 }); bot._client.write('arm_animation', { hand: 0 })
        const started = a.ticks
        while (a.ticks - started < 2) await pause()
        for (const other of [t, e]) other._client.emit('damage_event', { entityId: other.entity.id, sourceTypeId: 37, sourceCauseId: a.entity.id + 1, sourceDirectId: a.entity.id + 1 })
        return { ok: true }
      } finally { pending-- }
    },
  }
  const timer = setInterval(() => { beforeTick(); for (const bot of bots) { bot.ticks++; bot.emit('physicsTick') } }, 2)
  return { roles: { spear: a, primary: t, secondary: e }, bots, calls, actions, stop: () => stopped,
    setStop: () => { stopped = true }, atTick: fn => { beforeTick = fn }, get pending() { return pending }, close: () => clearInterval(timer) }
}

function cleaned(f: ReturnType<typeof fixture>) {
  assert.equal(f.pending, 0)
  for (const bot of f.bots) {
    for (const event of ['physicsTick', 'death', 'respawn', 'end']) assert.equal(bot.listenerCount(event), 0)
    assert.equal(bot._client.listenerCount('damage_event'), 0)
    assert.equal(bot._client.serializer.listenerCount('data'), 0)
    assert.ok(!Object.values(bot.controls).some(Boolean)); assert.equal(bot.usingHeldItem, false)
  }
}

test('secondary is four metres away in both arms while only On intersects the same legal T-aimed spear ray', () => {
  const pick = require('../daemon/src/pick')
  for (const enabled of [false, true]) {
    const [a, t, e] = piercingPoses(enabled)
    assert.deepEqual(a, [600.5, 600.5]); assert.deepEqual(t, [603.3, 600.5])
    const distance = Math.hypot(e[0] - a[0], e[1] - a[1])
    assert.ok(Math.abs(distance - 4) < 1e-10, `secondary distance ${distance}`); assert.ok(distance < 4.5)
    const eye = { x: a[0], y: 152.62, z: a[1] }, delta = { x: t[0] - a[0], y: 151 + 1.8 * .55 - eye.y, z: t[1] - a[1] }
    const length = Math.hypot(delta.x, delta.y, delta.z), dir = { x: delta.x / length, y: delta.y / length, z: delta.z / length }
    const hit = pick.rayBox(eye, dir, { x: e[0] - .425, y: 150.875, z: e[1] - .425 }, { x: e[0] + .425, y: 152.925, z: e[1] + .425 }, 4.5)
    assert.equal(hit !== null, enabled)
  }
})

test('one fully ready ordinary jab aims only at T, records actual STAB and both independent public receipts, then drains three ticks', async () => {
  const f = fixture()
  try {
    const row = await piercingPhase(f.roles, f.stop, f.actions)
    const jabs = f.calls.filter(x => x.jab)
    assert.equal(jabs.length, 1); assert.equal(jabs[0].jab, 'T'); assert.ok(jabs[0].ticks >= 20); assert.equal(jabs[0].using, false)
    assert.equal(row.sent, true); assert.equal(row.packets.filter(x => x.name === 'block_dig' && x.data.status === 7).length, 1)
    assert.ok(!row.packets.some(x => ['use_item', 'use_entity'].includes(x.name)))
    assert.deepEqual(row.damage.map(x => x.receiverId), [2, 3]); assert.ok(row.tail.ticks.every(n => n >= 3))
    assert.ok(row.frames.length > 0 && row.frames.every(x => !x.using)); cleaned(f)
  } finally { f.close() }
})

test('STOP or a replaced first life while waiting for charge prevents the single jab', async () => {
  for (const cause of ['stop', 'respawn', 'identity']) for (const atPacket of [false, true]) {
    const f = fixture(); let changed = false
    const change = () => {
      if (!changed) {
        changed = true
        if (cause === 'stop') f.setStop()
        else { f.roles.primary.entity = { ...f.roles.primary.entity }; if (cause === 'respawn') f.roles.primary.emit('respawn') }
      }
    }
    if (atPacket) { const jab = f.actions.jab; f.actions.jab = (...args) => { change(); return jab(...args) } }
    else f.atTick(() => { if (f.roles.spear.ticks >= 5) change() })
    try {
      const row = await piercingPhase(f.roles, f.stop, f.actions)
      assert.equal(row.sent, false); assert.equal(f.calls.filter(x => x.jab).length, 0)
      assert.match(row.why, /cancelled|first_life/); cleaned(f)
    } finally { f.close() }
  }
})

test('a throwing awaited jab is joined and every owned observer is removed before phase returns', async () => {
  const f = fixture(); let joined = false
  f.actions.jab = async () => { try { await pause(); throw Error('injected jab error') } finally { joined = true } }
  try {
    const row = await piercingPhase(f.roles, f.stop, f.actions)
    assert.equal(joined, true); assert.equal(row.sent, false); assert.match(row.error, /injected jab error/); cleaned(f)
    for (const pairs of [0, 21, 1.5, NaN]) await assert.rejects(piercingTrials(pairs), /pairs=3:1\.\.20/)
  } finally { f.close() }
})

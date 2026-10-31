import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import * as L from '../src/combat/aerial-lance'
import * as sky from '../src/elytra'
import * as flight from '../src/elytra/flight'
import * as equipment from '../src/elytra/kit'
import { flightTurn } from '../src/pvp/turn-air'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture(t) {
  let now = 1000, release: () => void
  t.mock.method(clock, 'now', () => now)
  t.mock.method(clock, 'sleep', async () => {})
  const item = { name: 'iron_spear', count: 1 }, rocket = { name: 'firework_rocket', count: 8 }
  const bot: any = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(.5, 107, .5), velocity: new Vec3(.2, -.1, 0), elytraFlying: true, onGround: false }
  bot.health = 20; bot.food = 20; bot.heldItem = item
  bot.inventory = { items: () => [item, rocket], slots: [] }; bot.inventory.slots[6] = { name: 'elytra' }; bot.inventory.slots[45] = rocket
  bot._client = new EventEmitter(); bot._ndElytra = { driving: 0, fd: 0, startedAt: 0 }
  bot.look = async () => {}; bot.activateItem = () => {}; bot.deactivateItem = () => {}
  bot.blockAt = p => ({ name: p.y < 100 ? 'stone' : 'air', boundingBox: p.y < 100 ? 'block' : 'empty' })
  const enemy: any = { id: 2, type: 'player', username: 'foe', position: new Vec3(15, 100, .5), onGround: true, isValid: true }
  const ctl = { aborted: false }, flights: any[] = [], landings: any[] = []
  const landing = new Promise<void>(done => { release = done })
  t.mock.method(flight, 'chestDown', async () => ({ ok: true }))
  t.mock.method(flight, 'land', async (_bot, landCtl) => {
    landings.push(landCtl); await landing
    bot.entity.elytraFlying = false; bot.entity.onGround = true
    return { ok: true }
  })
  return { bot, enemy, ctl, flights, landings, advance: () => { now = 1250 }, release: () => release() }
}

for (const stage of ['before_mount', 'runup', 'approach', 'confirmed_hit', 'exit']) {
  test(`parent deadline expires during ${stage}: stop attack, keep landing and receipts`, async t => {
    const f = fixture(t), stats: any = {}; let combos = 0, finished = false
    t.mock.method(flight, 'fly', async (_bot, _ctl, options) => {
      f.flights.push(options)
      if (stage === 'runup' || stage === 'exit' && options.phase === 'таран: выход') f.advance()
      else options.onTick?.()
      return { why: 'разбег' }
    })
    const done = L.lance(f.bot, f.ctl, f.enemy, { stats, deadline: stage === 'before_mount' ? 1000 : 1250,
      telemetryHp: () => null, afterPass: async () => { combos++; return null } })
    done.then(() => { finished = true }, () => { finished = true })
    try {
      for (let n = 0; n < 20 && !stats.lancePasses && !f.landings.length; n++) await flush()
      if (stage === 'approach' || stage === 'confirmed_hit' || stage === 'exit') {
        assert.equal(stats.lancePasses, 1)
        if (stage === 'confirmed_hit' || stage === 'exit') f.bot._client.emit('damage_event', { entityId: 2, sourceCauseId: 2, sourceDirectId: 2, sourceTypeId: 37 })
        if (stage !== 'exit') f.advance()
        f.bot.emit('physicsTick')
      }
      for (let n = 0; n < 20 && !f.landings.length; n++) await flush()
      assert.equal(f.landings.length, 1, 'expiry must stop the current stage, not wait for the 45-second default')
      assert.equal(f.ctl.aborted, false, 'ending the attack must not abort the parent controller')
      assert.equal(f.landings[0].aborted, false, 'the landing must retain its flight owner')
      assert.equal(f.bot._client.listenerCount('damage_event'), 0)
      assert.equal(f.bot._ndElytra.lance, undefined)
      assert.equal(finished, false, 'return the completed landing, not a detached cleanup')
      assert.equal(combos, 0)
      if (stage === 'before_mount') assert.equal(f.flights.length, 0, 'an expired attack must not start a run-up')
      else assert.ok(f.flights.every(options => options.maxMs <= 250), 'run-up and exit must fit the remaining parent budget')
      f.release()
      const result = await done
      assert.equal(result.landed, true)
      assert.equal(result.hit, stage === 'confirmed_hit' || stage === 'exit')
      assert.equal(result.hits, stage === 'confirmed_hit' || stage === 'exit' ? 1 : 0)
    } finally {
      f.ctl.aborted = true; f.bot.entity.elytraFlying = false; f.bot.entity.onGround = true
      f.release(); f.bot.emit('physicsTick'); await done
    }
  })
}

test('actual flightTurn -> elytra service -> lance carries the absolute duel deadline', async t => {
  const f = fixture(t); let options: any
  t.mock.method(L, 'lance', async (_bot, _ctl, _enemy, opts) => { options = opts; return { hit: true } })
  const service = sky.create(f.bot, { enemy: () => f.enemy })
  const ctx: any = { bot: f.bot, entity: f.enemy, ctl: f.ctl, deadline: 1250,
    prof: { player: true }, maceNow: () => false, healAt: 8, tt: { safe: () => ({ ok: true }) },
    foeGrounded: () => true, gate: () => true, foe: {}, pathTo() {}, clear() {},
    track: { vel: () => new Vec3(0, 0, 0) }, holdWeapon: async () => {},
    st: { swings: 0, healed: [] }, fg: { noteExperience() {} }, windInputs: () => '', nextReady: 0,
    sky: { ...service, decide: () => ({ kind: 'lance' }) } }
  try {
    await flightTurn(ctx, { d: 15, dy: -7, hp: 20, theirR: 15, meInWeb: false } as any)
    assert.equal(options?.deadline, 1250, 'each layer must preserve the same absolute deadline')
  } finally { service.close() }
})

for (const mode of ['ended', 'stale', 'unbraced', 'ally', 'new_use', 'abort', 'target_lost', 'already', 'throw', 'takeoff_new_use']) {
  test(`mounting a lance restores only its interrupted defensive spear use: ${mode}`, async t => {
    const f = fixture(t), spear = f.bot.heldItem
    const original = { hand: 0, name: spear.name, since: 500, confirmed: true }
    const newer = { hand: 1, name: 'shield', since: 1000, confirmed: true }
    f.bot.entity.elytraFlying = false; f.bot.entity.onGround = true
    f.bot.inventory.slots[6] = { name: mode === 'already' ? 'elytra' : 'iron_chestplate' }
    f.bot._ndUse = { cur: mode === 'unbraced' ? null : original }
    let launches = 0, starts = 0, releases = 0, atLaunch: any
    t.mock.method(equipment, 'swapChest', async () => {
      f.bot.inventory.slots[6] = { name: 'elytra' }; f.bot.heldItem = { name: 'iron_chestplate' }
      f.bot._ndUse.cur = mode === 'new_use' ? newer : mode === 'stale' ? original : null
      if (mode === 'abort') f.ctl.aborted = true
      if (mode === 'target_lost') f.enemy.isValid = false
      return { ok: true }
    })
    f.bot.equip = async item => { f.bot.heldItem = item }
    f.bot.deactivateItem = () => { releases++; f.bot._ndUse.cur = null }
    f.bot.activateItem = () => { starts++; f.bot._ndUse.cur = { hand: 0, name: f.bot.heldItem.name, since: clock.now() } }
    t.mock.method(require('../src/spear'), 'teamSafe', () => mode !== 'ally')
    t.mock.method(flight, 'takeoff', async () => {
      launches++; atLaunch = f.bot._ndUse.cur
      if (mode === 'takeoff_new_use') f.bot._ndUse.cur = newer
      if (mode === 'throw') throw new Error('fixture takeoff error')
      return { ok: false, why: 'fixture ends at the takeoff boundary' }
    })
    f.release()
    const pending = L.lance(f.bot, f.ctl, f.enemy, { telemetryHp: () => null })
    if (mode === 'throw') await assert.rejects(pending, /fixture takeoff error/)
    else await pending
    const restored = ['ended', 'stale', 'throw', 'takeoff_new_use'].includes(mode)
    assert.equal(starts, restored ? 1 : 0, 'restore the previously charged spear only after equipment is ready')
    assert.equal(releases, restored ? mode === 'takeoff_new_use' ? 1 : 2 : 0, 'release our restored charge after mount failure, preserving a newer use')
    assert.equal(launches, mode === 'abort' || mode === 'target_lost' ? 0 : 1)
    if (restored) {
      assert.equal(atLaunch?.name, spear.name)
      assert.equal(atLaunch?.since, 1000, 'equipment reset requires a fresh charge delay')
      assert.notEqual(atLaunch, original, 'a stale local receipt cannot retain the previous charge age')
    }
    if (mode === 'new_use') assert.equal(atLaunch, newer)
    if (mode === 'takeoff_new_use') assert.equal(f.bot._ndUse.cur, newer)
    if (restored && mode !== 'takeoff_new_use') assert.equal(f.bot._ndUse.cur, null)
    if (mode === 'already') assert.equal(atLaunch, original, 'no equipment change preserves the existing charge')
  })
}

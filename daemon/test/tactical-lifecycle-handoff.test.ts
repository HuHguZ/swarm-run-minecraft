import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import * as locks from '../src/reflex-lock'
import { TacticalSystem } from '../src/tactics/minecraft'
import { runIntent } from '../src/session/intent-runner'

function controller() {
  return { aborted: false, onAbort: [] as Array<() => void>, abort() {
    if (this.aborted) return
    this.aborted = true
    for (const fn of this.onAbort) fn()
  } }
}

function fixture() {
  const timer = new clock.GameClock({ manual: true, epoch: 0 })
  clock.activate(timer)
  const bot: any = new EventEmitter()
  Object.assign(bot, { health: 20, food: 2, entity: { position: new Vec3(.5, 61.7, .5) },
    inventory: { slots: [], items: () => [] }, _client: new EventEmitter(),
    pathfinder: { setGoal() {}, setMovements() {}, stop() {} }, clearControlStates() {} })
  const events: any[] = []
  const session: any = { bot, current: { name: 'goto', ctl: controller() }, reflex: null,
    bus: { emit: (type: string, detail: any) => events.push({ type, ...detail }), drain: () => [] },
    state: () => ({}), cancel() { this.current?.ctl.abort(); this.current = null } }
  let drowning = true
  const state = () => ({ at: timer.now(), health: 20, food: 2, armor: 0, weapon: true, shield: false,
    enemies: [], incomingProjectiles: 0, burning: false, lava: false, fireResistance: false,
    explosion: false, dangerousFall: false, emergencyController: false, inWater: true, drowning,
    cover: false, portal: false, escapeRoute: false, blocks: 24, water: false, edible: false,
    canFight: false, contact: false, shelter: null, protectedEncounter: false })
  const system: any = session.tactics = new TacticalSystem(session, { observe: state, record() {},
    execute: async () => ({ ok: false, breathing: true }) })
  system.attach(bot)
  return { timer, session, system, state, events, drowning: (value: boolean) => { drowning = value },
    close() { system.detach(); timer.dispose(); clock.activate(null) } }
}

test('safe completion of the previous Surface incident preserves the intent accepted after waitForRelease', async () => {
  const f = fixture()
  let finish!: () => void
  let work: Promise<any> | undefined
  try {
    f.system.update(true)
    await f.system.waitForRelease()
    assert.equal(f.system.snapshot().action, null)
    assert.equal(f.system.snapshot().owner, 'Skill')
    work = runIntent.call(f.session, 'wait', () => new Promise<void>(resolve => { finish = resolve }),
      { exclusive: true, interruptible: false, timeoutMs: 0 })
    await new Promise<void>(resolve => setImmediate(resolve))
    const next = f.session.current.ctl
    f.drowning(false); f.timer.advanceTicks(1); f.system.update(true)
    assert.equal(next.aborted, false, 'safe release belongs to the old intent, not the new worker')
    assert.equal(f.session.replanRevision, 1)
    assert.equal(f.system.snapshot().requireObservation, true, 'the old incident still requests a fresh observation')
    finish()
    assert.equal((await work).status, 'done')
  } finally { finish?.(); if (work) await work; f.close() }
})

test('a current drowning threat still interrupts the new intent after the previous Surface ended', async () => {
  const f = fixture()
  let finish!: () => void
  let work: Promise<any> | undefined
  try {
    f.system.update(true)
    await f.system.waitForRelease()
    work = runIntent.call(f.session, 'wait', () => new Promise<void>(resolve => { finish = resolve }),
      { exclusive: true, interruptible: false, timeoutMs: 0 })
    await new Promise<void>(resolve => setImmediate(resolve))
    const next = f.session.current.ctl
    f.timer.advanceTicks(1); f.system.update(true)
    assert.equal(next.aborted, true)
    assert.equal(next.interruptedBy.threatLevel, 3)
    assert.equal((await work).status, 'interrupted')
  } finally { finish?.(); if (work) await work; await f.system.waitForRelease(); f.close() }
})

test('safe release without an original intent cannot interrupt an intent installed later', async () => {
  const f = fixture()
  try {
    f.session.current = null
    f.system.update(true)
    await f.system.waitForRelease()
    const next = controller()
    f.session.current = { name: 'goto', ctl: next }
    f.drowning(false); f.timer.advanceTicks(1); f.system.update(true)
    assert.equal(next.aborted, false)
    assert.equal(f.session.replanRevision, 1)
  } finally { f.close() }
})

test('completion of a level-two episode interrupts its original worker but not a replacement worker', async () => {
  for (const replace of [false, true]) {
    const f = fixture()
    let finish!: () => void
    try {
      f.drowning(false)
      f.system.ports.execute = () => new Promise<void>(resolve => { finish = resolve })
      const original = f.session.current.ctl
      f.system.begin({ id: 'Hide', score: 120, reason: 'observed cover' }, [], f.state(), 2)
      await new Promise<void>(resolve => setImmediate(resolve))
      const current = replace ? controller() : original
      f.session.current = { name: 'goto', ctl: current }
      finish(); await f.system.waitForRelease()
      assert.equal(current.aborted, !replace, 'only the worker suspended by this episode requires interruption')
    } finally { finish?.(); await f.system.waitForRelease(); f.close() }
  }
})

for (const kind of ['observation', 'spear observation', 'water defence', 'explosion', 'grounded', 'other skill'] as const) {
  test(`arena wind escort tactical release preserves only airborne observation work (${kind})`, async () => {
    const f = fixture()
    try {
      f.drowning(false)
      const ctl = controller()
      f.session.current = { name: kind === 'other skill' ? 'goto' : 'wing_orbit', params: { arena: { x: 600.5, z: 600.5, r: 80 } }, ctl }
      f.session.bot.entity.elytraFlying = kind !== 'grounded'
      f.session.bot.inventory.items = () => kind === 'spear observation' ? [{ name: 'iron_spear', count: 1 }] : [{ name: 'wind_charge', count: 58 }]
      // CD c/d: an approaching projectile registered level two while the flying arbiter kept its controls.
      let danger = true
      const episodes: any[] = []
      f.system.ports.observe = () => ({
        ...f.state(), food: 20, shield: true, inWater: false, airborne: kind !== 'grounded', aerialCombat: kind !== 'grounded',
        incomingProjectiles: danger ? 1 : 0, burning: danger && kind === 'water defence', water: kind === 'water defence',
        explosion: danger && kind === 'explosion', canFight: true
      })
      f.system.ports.record = row => { if (row.level === 'tactical_episode') episodes.push(row) }
      f.system.update(true)
      await f.system.waitForRelease()
      danger = false
      f.timer.advanceTicks(1)
      f.system.update(true)
      assert.equal(episodes.length, 1)
      assert.equal(episodes[0].threat, kind === 'explosion' ? 4 : 2)
      assert.deepEqual(episodes[0].actions, kind === 'explosion' ? ['Dodge'] : kind === 'water defence' ? ['UseWater'] : kind === 'grounded' ? ['Shield'] : [])
      assert.equal(ctl.aborted, !kind.endsWith('observation'))
      assert.equal(f.events.filter(event => event.type === 'tactical_released' && event.reason === 'safe').length, 1)
      assert.equal(f.system.snapshot().requireObservation, true)
      assert.equal(f.session.replanRevision, 1)
    } finally { await f.system.waitForRelease(); f.close() }
  })
}

test('an arena fight can replan after a lava forecast retreat reaches safe loaded ground', async t => {
  for (const kind of ['dry ground', 'airborne', 'missing floor', 'magma support', 'current lava', 'new attacker', 'low health',
    'non-arena fight', 'other skill', 'already cancelled fight', 'started while burning']) await t.test(kind, async () => {
    const f = fixture()
    const bot = f.session.bot, old = controller()
    f.drowning(false)
    f.session.current = { name: kind === 'other skill' ? 'goto' : 'fight', ctl: old,
      params: kind === 'non-arena fight' ? {} : { arena: { x: 600.5, z: 600.5, r: 77 } } }
    if (kind === 'already cancelled fight') old.abort()
    const foe = { id: 647, kind: 'player', player: true, threatening: true, distance: 6.6, hit: 2.1 }
    // Pressure E: a supported sword fighter temporarily leaves the arena fight to avoid a projected lava landing.
    let state = { ...f.state(), food: 20, armor: 20, shield: true, enemies: [foe], canFight: true, escapeRoute: true,
      inWater: false, protectedEncounter: true, airborne: true, lavaAhead: true, burning: kind === 'started while burning' }
    bot.entity.position = new Vec3(597.4, 120.4, 612.1)
    bot.entity.velocity = new Vec3(0, -.3, 0)
    bot.entity.onGround = false
    bot.blockAt = (p: Vec3) => {
      if (p.y < 120 && kind === 'missing floor') return null
      return { position: p.floored(), name: p.y < 120 ? kind === 'magma support' ? 'magma_block' : 'sand' : 'air', boundingBox: p.y < 120 ? 'block' : 'empty' }
    }
    f.system.ports.observe = () => ({ ...state, at: f.timer.now() })
    f.system.ports.execute = (_action: any, ctl: any) => new Promise(resolve => ctl.onAbort.push(() => resolve({ cancelled: true })))
    try {
      f.system.update(true)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(old.aborted, true)
      assert.equal(f.system.snapshot().owner, 'Emergency')
      assert.equal(f.system.snapshot().action, 'Flee')
      f.session.current = null
      bot.entity.position = new Vec3(597.1427804646971, 120, 611.0338570307033)
      bot.entity.velocity = new Vec3(0, -.0784000015258789, 0)
      bot.entity.onGround = kind !== 'airborne'
      bot.entity.isInLava = kind === 'current lava'
      bot.health = kind === 'low health' ? 6 : 20
      state = { ...state, health: bot.health, lava: bot.entity.isInLava, lavaAhead: false, burning: false, airborne: !bot.entity.onGround,
        enemies: kind === 'new attacker' ? [{ ...foe, id: 700, distance: 13 }] : [{ ...foe, threatening: false }], protectedEncounter: false }
      f.timer.advanceTicks(2)
      f.system.update(true)
      if (kind !== 'dry ground') {
        assert.equal(locks.owner(f.session)?.source, 'Flee')
        return
      }
      assert.equal(locks.owner(f.session), null, 'verified dry arena landing releases the terrain retreat immediately')
      await f.system.waitForRelease()
      assert.equal(f.system.snapshot().action, null)
      assert.equal(f.system.snapshot().requireObservation, true)
      assert.equal(f.session.replanRevision, 1)
      const next = controller()
      f.session.current = { name: 'fight', params: { arena: { x: 600.5, z: 600.5, r: 77 } }, ctl: next }
      f.system.update(true)
      assert.equal(next.aborted, false, 'the old terrain episode cannot interrupt a newly accepted fight')
      assert.equal(f.session.replanRevision, 1)
    } finally { locks.cancel(f.session); await f.system.waitForRelease(); f.close() }
  })
})

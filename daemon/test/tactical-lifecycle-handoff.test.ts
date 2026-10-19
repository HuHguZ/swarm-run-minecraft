import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
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

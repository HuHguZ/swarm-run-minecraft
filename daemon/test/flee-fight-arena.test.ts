import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { declSource } from './source-fixture'
import { cjsContext } from './cjs-context'
import { flee } from '../src/session/combat'
import { Session } from '../src/session'
import { testBot } from './tick-plugins-fixture'
import { EventEmitter } from 'node:events'

const source = declSource(join(__dirname, '../src/combat.js'), 'fight')
const arena = { x: 600, y: 120, z: 600, r: 80, killY: 113 }

function fightEntry() {
  const seen: any[] = []
  const fight = runInNewContext(source + '\nfight', cjsContext({
    watchFight() { throw new Error('player combat has no timeout watch') },
    makeShield: () => ({ report: () => ({}), close() {} }),
    survival: { watch: () => ({ close() {} }) }, FIGHT_NOAVOID: () => false,
    fightBody: async (_session, _ctl, options) => { seen.push(options); return {} }
  }))
  return { fight, seen }
}

function arenaSession() {
  const bot: any = new EventEmitter()
  const session: any = { bot, current: null, cancel() {}, journal: { append() {} } }
  bot.quit = () => bot.emit('end')
  const methods = runInNewContext(declSource(join(__dirname, '../src/rpc/aerial.js'), 'aerialMethods') + '\naerialMethods', cjsContext({
    require: name => {
      if (name === '../elytra') return { install() {} }
      if (name === '../combat/wind-out') return { installWindOut() {} }
      throw new Error('unexpected require ' + name)
    }
  }))({ session })
  return { session, methods }
}

test('idle defensive fight uses the active rescue arena, including floor and death boundary', async () => {
  const { session, methods } = arenaSession(), f = fightEntry()
  const request = { safe: { x: 600, y: 120, z: 600 }, killY: 113, arena: { x: 600, z: 600, r: 80 } }
  await methods.rescue_config(request)
  await f.fight(session, { aborted: false, onAbort: [] }, { allowPlayer: true })
  assert.deepEqual({ ...f.seen[0].arena }, arena)
  assert.notEqual(f.seen[0].arena, request.arena)
  session.current = { params: { arena: { ...arena, r: 60 } } }
  await f.fight(session, { aborted: false, onAbort: [] }, { allowPlayer: true })
  assert.equal(f.seen[1].arena.r, 60, 'the current command remains authoritative')
  await f.fight(session, { aborted: false, onAbort: [] }, { allowPlayer: true, arena: { ...arena, r: 40 } })
  assert.equal(f.seen[2].arena.r, 40, 'an explicit arena wins over both sources')
})

test('disabled rescue and a disconnected session do not constrain later survival combat', async () => {
  for (const disconnect of [false, true]) {
    const { session, methods } = arenaSession(), f = fightEntry()
    await methods.rescue_config({ safe: arena, killY: 113, arena })
    if (disconnect) Session.prototype.disconnect.call(session)
    else await methods.rescue_config({ off: true })
    session.bot = new EventEmitter()
    await f.fight(session, { aborted: false, onAbort: [] }, { allowPlayer: true })
    assert.equal(f.seen[0].arena ?? null, null)
  }
})

test('flee publishes its arena to a defensive fight that starts while the worker is suspended', async () => {
  const session: any = { bot: {}, require() {}, runIntent(name, _worker, options) {
    this.current = { name, params: options.params, ctl: { aborted: false } }
  } }
  flee.call(session, { arena, from: ['Foe'], timeoutSeconds: 3 })
  const f = fightEntry()
  await f.fight(session, { aborted: false, onAbort: [] }, { allowPlayer: true })
  assert.equal(f.seen[0].arena, arena, 'the aerial attack must retain the commanded arena')
  assert.equal(session.current.name, 'flee')
})

test('arena goto passes its validated boundary to a defensive fight while navigation owns the intent', async () => {
  const bot = testBot(); bot.entity.position.set(600, 120, 600)
  const session: any = { bot, require: () => bot, runIntent(name, _worker, options) {
    this.current = { name, params: options.params, ctl: { aborted: false } }
  } }
  Session.prototype.goto.call(session, { x: 603, y: 120, z: 600, arena })
  const f = fightEntry()
  await f.fight(session, { aborted: false, onAbort: [] }, { allowPlayer: true })
  assert.deepEqual(f.seen[0].arena, arena, 'the reflex flight must keep the navigation boundary')
  assert.notEqual(f.seen[0].arena, arena, 'inherit the validated frozen copy, not mutable request data')
  assert.equal(Object.isFrozen(f.seen[0].arena), true)
  assert.equal(session.current.name, 'goto')
})

test('defensive fight preserves an explicit arena and never reuses a completed intent boundary', async () => {
  const f = fightEntry(), explicit = { ...arena, r: 40 }, options = { allowPlayer: true, arena: explicit }
  const session: any = { bot: {}, current: { params: { arena }, ctl: { aborted: false } } }
  await f.fight(session, { aborted: false, onAbort: [] }, options)
  assert.equal(f.seen[0].arena, explicit)
  assert.equal(options.arena, explicit)
  session.current = null
  await f.fight(session, { aborted: false, onAbort: [] }, { allowPlayer: true })
  assert.equal(f.seen[1].arena ?? null, null, 'ordinary survival combat remains unbounded')
})

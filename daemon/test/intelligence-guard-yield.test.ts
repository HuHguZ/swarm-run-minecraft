import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Vec3 } from 'vec3'

interface Controller { aborted: boolean; onAbort: Array<() => void> }
interface GuardResult { acted?: boolean; cancelled?: boolean; how?: string }
interface Guard { react(session: unknown, ctl: Controller, options?: unknown): Promise<GuardResult> }

const source = (name: 'GUARD' | 'BASTION') => readFileSync(process.env[`${name}_TEST_SOURCE`] ||
  join(__dirname, name === 'GUARD' ? '../src/ne-guard.js' : '../src/bastion/bastion.js'), 'utf8')

function delegatedGuard() {
  let requests = 0
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(), entity: { id: 1, position: new Vec3(.5, 64, .5) },
    health: 20, game: { dimension: 'the_nether' }, inventory: { slots: [] }
  })
  const session = { bot, tactics: { enabled: () => true, requestGuard: async () => {
    requests++
    return { acted: false }
  } } }
  const context = { module: { exports: {} }, process, setImmediate, console: { log() {} },
    require: (name: string) => {
      if (name === './game-clock') return { now: () => 1000 }
      if (name === './movement') return { sleep: async () => {} }
      if (name === 'vec3') return { Vec3 }
      throw new Error('unexpected dependency: ' + name)
    } }
  runInNewContext(source('GUARD'), context)
  return { bot, session, guard: context.module.exports as Guard, requests: () => requests }
}

test('declined tactical guards yield to the native abort event instead of starving I/O', async () => {
  const f = delegatedGuard()
  const ctl: Controller = { aborted: false, onAbort: [] }
  const aborted = new Promise<void>(resolve => setImmediate(() => { ctl.aborted = true; resolve() }))
  let result: GuardResult = {}
  for (let attempts = 0; attempts < 10 && !ctl.aborted; attempts++) result = await f.guard.react(f.session, ctl)
  assert.equal(ctl.aborted, true, 'a resolved tactical Promise must not keep the native event queued')
  assert.equal(f.requests(), 1)
  assert.equal(result.cancelled, true)
  assert.equal(result.acted, false)
  await aborted
  f.bot.emit('end')
})

test('native end invalidates a delegated guard even if the old bot still exposes health and entity', async () => {
  const f = delegatedGuard()
  setImmediate(() => f.bot.emit('end'))
  const result = await f.guard.react(f.session, { aborted: false, onAbort: [] })
  assert.equal(result.cancelled, true)
  assert.equal(result.acted, false)
  assert.equal(f.bot.health, 20)
})

function sealedFixture(results: GuardResult[]) {
  let requests = 0
  const logs: string[] = []
  const bot = { entity: { position: new Vec3(.5, 64, .5) }, health: 20,
    game: { dimension: 'the_nether' }, inventory: { items: () => [{ name: 'iron_pickaxe' }] } }
  const session = { bot }
  const ctl: Controller = { aborted: false, onAbort: [] }
  const st = { fastSafe: true, pred: new Map(), gold: new Map(), skip: new Map(), blocks: 0 }
  const code = source('BASTION')
  const start = code.indexOf('async function sealedGold(')
  const end = code.indexOf('async function digTrap(', start)
  assert.ok(start >= 0 && end > start)
  const context = {
    process, gameClock: { now: () => 1000 }, GOLD_PICK: /iron_pickaxe/,
    inLava: () => false, answerAttack: async () => false, inOwnTunnel: () => false,
    eatIfHungry: async () => {}, log: (message: string) => logs.push(message), nearBruteHome: () => false,
    require: (name: string) => {
      if (name === '.././sealed') return { exposure: () => [], keyV: (v: Vec3) => v.toString() }
      if (name === '.././tunnel') return { lowPicks: () => 1 }
      if (name === '.././nether-route') return { bruteSpots: () => [] }
      if (name === '.././ne-guard') return { hot: () => requests < results.length ? { why: 'hoglin в 2.5 бл.' } : null,
        react: async () => {
          if (++requests > 10) throw new Error('resolved guard spin')
          return results[Math.min(requests - 1, results.length - 1)]
        } }
      throw new Error('unexpected dependency: ' + name)
    }
  }
  const sealedGold = runInNewContext(code.slice(start, end) + '\nsealedGold', context) as
    (session: unknown, ctl: Controller, state: unknown, until: number) => Promise<unknown>
  return { run: () => sealedGold(session, ctl, st, 100000), requests: () => requests, logs }
}

test('sealed gold proceeds after an explicitly declined tactical guard without claiming a defense', async () => {
  const f = sealedFixture(Array.from({ length: 11 }, () => ({ acted: false })))
  await f.run()
  assert.equal(f.requests(), 1)
  assert.equal(f.logs.includes('штрек: страж'), false)
})

test('sealed gold reobserves after an actual guard action and preserves its defense receipt', async () => {
  const f = sealedFixture([{ acted: true, how: 'яма' }])
  await f.run()
  assert.equal(f.requests(), 1)
  assert.equal(f.logs.filter(message => message === 'штрек: страж').length, 1)
})

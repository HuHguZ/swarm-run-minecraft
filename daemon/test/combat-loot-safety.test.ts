import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
const Vec3 = require('vec3')
const esbuild = require('esbuild')

function sourceModule(name: string, overrides: Record<string, unknown> = {}, extra = '') {
  const file = path.resolve(__dirname, '../src', name + '.ts')
  const local = createRequire(file), module = { exports: {} as Record<string, any> }
  const code = esbuild.transformSync(readFileSync(file, 'utf8') + extra, { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext(require('node:module').wrap(code), { filename: file })(module.exports,
    (id: string) => id in overrides ? overrides[id] : local(id), module, file, path.dirname(file))
  return module.exports
}

function fixture({ foe = 'zombie', distance = 1.1, visible = true, afterDuel = null, duringCollect = null, aborted = false, corridor = false }: any = {}) {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.version = '1.21.11'; bot.health = 14.56; bot.food = 10
  bot.entity = { id: 1, position: new Vec3(104.49, 53, 136.83), width: .6, height: 1.8, metadata: [], onGround: true }
  const weapon = { name: 'stone_sword', count: 1 }
  bot.inventory = { slots: [], items: () => [weapon] }; bot.heldItem = weapon
  bot.registry = { foodsByName: {}, entitiesByName: { item: { id: 71 } } }
  bot.blockAt = (p: any) => ({ name: p.y < 53 ? 'stone' : 'air', boundingBox: p.y < 53 ? 'block' : 'empty', shapes: [], position: p })
  bot.equip = async () => {}; bot.pathfinder = { setGoal() {} }
  const killed = { id: 1966, name: 'zombie', isValid: true, position: bot.entity.position.offset(3, 0, 0), width: .6, height: 1.95 }
  const remaining = { id: 1853, name: foe, isValid: true, position: bot.entity.position.offset(distance, 0, 0), width: .6, height: 1.95, metadata: [] }
  bot.entities = { 1966: killed, ...(foe ? { 1853: remaining } : {}) }
  const safety = sourceModule('combat-safety', { './assess': {
    MOBS: { zombie: { dmg: 3 }, piglin: { dmg: 5 } }, inSight: (_: any, e: any) => visible || e === killed,
    gearOf: () => ({ armor: 8, tough: 0 }), afterArmor: () => 2.22,
    plan: () => ({ foes: 1, expectedDamage: 1 })
  } })
  const ctl: any = { aborted, onAbort: [] }
  const checks: boolean[] = [], seen: any[] = []
  const collector = async (_bot: any, _ctl: any, options: any) => {
    seen.push(options)
    checks.push(options.canContinue ? options.canContinue() : true)
    if (checks[checks.length - 1]) {
      duringCollect?.({ bot, ctl, remaining })
      checks.push(options.canContinue ? options.canContinue() : true)
    }
    return 0
  }
  const actions = sourceModule('actions', { './drops': { collect: collector }, './pack': { ignoreDrop: () => false, fits: () => true } })
  const combat = sourceModule('combat', {
    './actions': actions, './combat-safety': safety,
    './play-policy': { decideFight: () => ({ skip: false }) },
    './pvp': { duel: async () => { killed.isValid = false; afterDuel?.({ bot, ctl, remaining }); return { kills: ['zombie'], hp: '19 -> 15', landed: 4 } } }
  }, `\nmodule.exports.__fightBody = fightBody; dressForFight = async () => ({}); corridorShape = () => ({ corridor: ${corridor} });`)
  const guard = { watch() {}, sawMobs() {}, wear: async () => { if (corridor) killed.isValid = false }, raise: async () => {}, safety: { check: (p: any) => safety.inspect(bot, p) } }
  return { bot, ctl, checks, seen, remaining, run: () => combat.__fightBody({ bot }, ctl, { target: '#1966', engaged: true }, guard) }
}

test('CF22 won duel yields post-kill pickup before native spawn settling while a second zombie can hit', async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(result.landed, 4)
  assert.equal(result.kills[0], 'zombie')
  assert.equal(f.checks[0], false, 'the drop loop must stop before its wall settling or pickup path')
  assert.equal(f.bot.health, 14.56)
  assert.equal(f.bot.listenerCount('physicsTick'), 0, 'pickup tempo listeners must close')
})

test('corridor kill also yields pickup while a second visible zombie can hit', async () => {
  const f = fixture({ corridor: true })
  const result = await f.run()
  assert.equal(result.killed, 'zombie')
  assert.deepEqual(f.checks, [false], 'corridor combat must stop before native settling too')
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('corridor post-kill pickup remains available but rechecks a distant approaching threat', async () => {
  const f = fixture({ corridor: true, distance: 12, duringCollect: ({ bot, remaining }: any) => { remaining.position = bot.entity.position.offset(1.1, 0, 0) } })
  await f.run()
  assert.deepEqual(f.checks, [true, false])
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

for (const [label, change] of [
  ['distant walker', { distance: 12 }], ['occluded walker', { visible: false }],
  ['calm piglin', { foe: 'piglin' }], ['no remaining foe', { foe: null }]
] as const) test(`won duel still collects with ${label}`, async () => {
  const f = fixture(change)
  await f.run()
  assert.deepEqual(f.checks, [true, true])
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('post-kill pickup rechecks an approaching visible threat instead of merely guarding its entry', async () => {
  const f = fixture({ distance: 12, duringCollect: ({ bot, remaining }: any) => { remaining.position = bot.entity.position.offset(1.1, 0, 0) } })
  await f.run()
  assert.deepEqual(f.checks, [true, false])
})

test('post-kill cancellation forwards to drop polling without releasing newer controls', async () => {
  const f = fixture({ foe: null, duringCollect: ({ bot, ctl }: any) => { ctl.aborted = true; bot.controlState = { forward: true }; bot.clearControlStates = () => { throw new Error('new owner controls released') } } })
  await f.run()
  assert.deepEqual(f.checks, [true, false])
  assert.equal(f.bot.controlState.forward, true)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('actual actions → drops contract rejects pressure before the 1.21.11 native wall-settle loop', async () => {
  let gameMs = 2000, wallMs = 1000, sleeps = 0
  const clock = { now: () => gameMs, wall: { monotonic: () => wallMs },
    setTimeout(fn: () => void, ms: number) { sleeps++; gameMs += ms; wallMs += 10; fn() } }
  const drops = sourceModule('drops', { './game-clock': clock })
  const actions = sourceModule('actions', { './drops': drops, './pack': { fits: () => true, ignoreDrop: () => false } })
  const f = fixture({ foe: null })
  f.bot.entities = {}
  assert.equal(await actions.collectNearbyDrops(f.bot, f.ctl, { canContinue: () => false }), 0)
  assert.equal(sleeps, 0, 'no game sleeps or native response settle may start under pressure')
  assert.equal(await actions.collectNearbyDrops(f.bot, f.ctl, {}), 0)
  assert.ok(sleeps > 0, 'ordinary safe collection retains the native spawn settle window')
})

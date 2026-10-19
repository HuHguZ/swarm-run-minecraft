import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as esbuild from 'esbuild'

function sourceModule(name: string, overrides: Record<string, unknown> = {}) {
  const file = path.resolve(__dirname, '../src', name + '.ts')
  const local = createRequire(file), module = { exports: {} as Record<string, any> }
  const source = esbuild.transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap(source), { filename: file })(module.exports,
    (id: string) => id in overrides ? overrides[id] : local(id), module, file, path.dirname(file))
  return module.exports
}

function actor() {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.version = '1.21.11'; bot.health = 14.2; bot.food = 16
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  bot.inventory = { slots: [], items: () => [{ name: 'stone_sword', count: 1 }, { name: 'oak_planks', count: 12 }] }
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, width: .6,
    onGround: true, yaw: 0, pitch: 0, effects: {}, metadata: [] }
  bot.entities = { 2: { id: 2, name: 'spider', position: new Vec3(4.55, 64, .5), height: .9, width: 1.4, equipment: [], metadata: [] } }
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.pathfinder = { setGoal: () => {}, stop: () => {} }; bot.clearControlStates = () => {}
  bot.blockAt = (p: any) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty',
    position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const fn of this.onAbort) fn() } }
  const session: any = { bot, current: { name: 'refuge', ctl }, bus: { emit: () => {} } }
  return { session, bot, ctl }
}

test('U2 spider contact cannot trade the current bounded shelter construction for a tactical fight', async () => {
  const a = actor(), tactics = sourceModule('tactics/minecraft'), calls: string[] = []
  a.session._refugeBuild = a.ctl
  const building = tactics.observeTactics(a.session)
  assert.equal(building.contact, true); assert.equal(building.canFight, true)
  assert.equal(building.protectedEncounter, true, 'only the executing construction owns its walls and roof')
  const system = new tactics.TacticalSystem(a.session, { execute: async (action: any) => { calls.push(action.id); return {} } })
  try {
    system.attach(a.bot); system.update(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(calls, []); assert.equal(a.ctl.aborted, false)
    delete a.session._refugeBuild
    system.update(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls.length, 1, 'the same ordinary threat remains tactical after construction ends')
    assert.equal(tactics.observeTactics(a.session).protectedEncounter, false)
  } finally { system.detach() }
})

for (const how of ['box', 'niche'] as const) for (const ending of ['return', 'throw', 'replace'] as const) test(`${how} construction ownership is scoped to the actual helper and released on ${ending}`, async () => {
  const a = actor(), hold: typeof import('../src/survival/hold-out') = require('../src/survival/hold-out'), fortify: typeof import('../src/fortify') = require('../src/fortify')
  const cell = new Vec3(.5, 64, .5), look = { blocks: 12, nether: true, foes: 0, cell: { cell, blocks: 8 }, canBreakOut: true }
  let builds = 0, holds = 0
  const replacement = { aborted: false }
  const build = async () => {
    builds++; assert.equal(a.session._refugeBuild, a.ctl)
    if (ending === 'throw') throw Error('placement failed')
    if (ending === 'replace') a.session._refugeBuild = replacement
    return { cell, placed: 8 }
  }
  const module = sourceModule('survival/refuge-body', {
    './hold-out': { ...hold, refugeLook: () => look, lookLine: () => '', chooseRefuge: () => ({ how }), takeBox: build, takeNiche: build,
      holdOut: async () => { holds++; assert.equal(a.session._refugeBuild, ending === 'replace' ? replacement : undefined, 'healing is outside the construction scope'); a.bot.health = 16; return { why: 'healed', ate: [] } } },
    '.././fortify': { ...fortify, landed: async () => {}, enclosure: () => ({ sealed: true }) },
    './enter-shelter': { ...(require('../src/survival/enter-shelter') as typeof import('../src/survival/enter-shelter')), sitOn: () => false }
  })
  const out: any = { how: 'none', code: 'OK', hp0: 14, steps: [], stayIn: true }
  const work = module.refugeBody(a.session, a.ctl, { t0: (require('../src/game-clock') as typeof import('../src/game-clock')).now(), minHp: 16, deadline: Infinity, out, step: () => {}, hurts: [] })
  if (ending === 'throw') await assert.rejects(work, /placement failed/)
  else { await work; assert.equal(holds, 1) }
  assert.equal(builds, 1); assert.equal(a.session._refugeBuild, ending === 'replace' ? replacement : undefined)
})

test('a stale or cancelled shelter controller never claims the next intent', () => {
  const a = actor(), tactics = sourceModule('tactics/minecraft')
  a.session._refugeBuild = { aborted: false }
  assert.equal(tactics.observeTactics(a.session).protectedEncounter, false)
  a.session._refugeBuild = a.ctl; a.ctl.aborted = true
  assert.equal(tactics.observeTactics(a.session).protectedEncounter, false)
})

test('a live Tactical BlockOff keeps its own construction lease when current is another intent', async () => {
  const a = actor(), tactics = sourceModule('tactics/minecraft'), locks: typeof import('../src/reflex-lock') = require('../src/reflex-lock')
  a.session.current.name = 'explore'
  let finish!: () => void, building: any
  const system = new tactics.TacticalSystem(a.session, { execute: async (_action: any, ctl: any) => {
    building = ctl; a.session._refugeBuild = ctl
    await new Promise<void>(resolve => { finish = resolve })
    delete a.session._refugeBuild
    return {}
  } })
  try {
    system.attach(a.bot)
    const action = { id: 'BlockOff', score: 80, reason: 'bounded roof construction' }
    system.begin(action, [action], tactics.observeTactics(a.session), 2)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.notEqual(building, a.ctl); assert.equal(locks.owner(a.session)?.ctl, building)
    assert.equal(tactics.observeTactics(a.session).protectedEncounter, true, 'the actual live hand owner may build for BlockOff')
    system.update(true)
    assert.equal(building.aborted, false, 'the protected-encounter branch must not cancel its own construction')
    assert.equal(locks.owner(a.session)?.ctl, building)
    a.session._refugeBuild = { aborted: false }
    assert.equal(tactics.observeTactics(a.session).protectedEncounter, false, 'a different marker cannot borrow the live lease')
    a.session._refugeBuild = building; building.aborted = true
    assert.equal(tactics.observeTactics(a.session).protectedEncounter, false, 'an aborted lease cannot protect construction')
  } finally {
    finish?.(); await new Promise<void>(resolve => setImmediate(resolve)); system.detach()
  }
})

for (const danger of ['critical', 'blast', 'lava', 'fall'] as const) test(`bounded shelter construction preserves ${danger} takeover`, async () => {
  const a = actor(), tactics = sourceModule('tactics/minecraft'), calls: string[] = []
  a.session._refugeBuild = a.ctl
  let state = tactics.observeTactics(a.session)
  state = { ...state, ...(danger === 'critical' ? { health: 4 } : danger === 'blast' ? { explosion: true } :
    danger === 'lava' ? { lava: true, fireResistance: false } : { dangerousFall: true, emergencyController: true }) }
  const system = new tactics.TacticalSystem(a.session, { observe: () => state, execute: async (action: any) => { calls.push(action.id); return {} } })
  try {
    system.attach(a.bot); system.update(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    if (danger === 'fall') assert.equal(system.snapshot().owner, 'Skill', 'the fall remains with its existing Emergency controller')
    else { assert.equal(a.ctl.aborted, true); assert.ok(calls.length, 'an urgent physical danger still invokes tactics') }
  } finally { system.detach() }
})

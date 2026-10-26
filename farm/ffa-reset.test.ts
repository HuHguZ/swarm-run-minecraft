import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installRounds, placeFighters, fighterLoop } from './arena/rounds'
// Ручки окружения, добавляющие выдачу и наборы раунда: тест — на умолчаниях.
delete process.env.ARMS_GIVE; delete process.env.ARMS_AIR; delete process.env.ARMS_CRYSTAL; delete process.env.ARMS_TNT

function placements(fail: boolean | ((name: string) => string | false) = false, solo = false, onCommand = (_command: string) => {}) {
  const bodies: Record<string, { mode: string; safe: boolean }> = { NeuroFarm31: { mode: 'spectator', safe: false }, NeuroFarm31y: { mode: 'spectator', safe: false } }
  const commands: string[] = []
  const sleeps: Array<{ ms: number; modes: Record<string, string> }> = []
  const calls: Array<{ name: string; method: string }> = [], logs: string[] = []
  const bots = Object.keys(bodies).map((name, k) => ({ name, team: k ? 'blue' : 'red',
    c: { call: async (method: string) => { calls.push({ name, method }) } } }))
  const context: any = { bots, names: bots.map(b => b.name), N: bots.length, SOLO: solo, arms: true, teams: true, X: 600, Y: 120, Z: 600,
    L: { spawns: [{ x: -42, y: 8, z: 32 }, { x: 42, y: 8, z: 32 }] }, log: text => logs.push(text),
    between: false, stop: false, round: 1, roundWins: { red: 0, blue: 0 }, kills: {}, deaths: {},
    out: new Set(), deadNow: new Set(), humanOut: new Set(), humanNames: [], humans: {}, HUMAN_TEAM: null, BOX: 'fixture',
    deathAt: {}, radio: {}, opened: new Set(), chestBy: new Map(), chestFail: new Map(), refills: new Map(),
    labNeed: {}, brewed: {}, alchemist: {}, killGaps: [], swarmDriver: { reset() {} },
    sleep: async (ms: number) => { sleeps.push({ ms, modes: Object.fromEntries(Object.entries(bodies).map(([name, b]) => [name, b.mode])) }) }, stockChests: async () => {}, restoreArena: async () => {
      assert.ok(bots.every(b => bodies[b.name].mode === 'spectator'), 'park owned bodies before the clone')
    },
    rcon: async (_slot, command) => {
      commands.push(command)
      onCommand(command)
      const match = /^spreadplayers .* false (\S+)$/.exec(command)
      if (match) {
        assert(match[1] in bodies, 'only an explicitly owned bot may be placed')
        assert.equal(bodies[match[1]].mode, 'spectator')
        const failed = typeof fail === 'function' ? fail(match[1]) : fail && 'Could not spread 1 entity/entities around 642, 632'
        if (failed) return failed
        bodies[match[1]].safe = true
        return 'Spread 1 entity/entities around 642, 632 with an average distance of 0 block(s) apart'
      }
      for (const name of Object.keys(bodies)) {
        if (command === `gamemode spectator ${name}`) bodies[name].mode = 'spectator'
        if (command.startsWith(`tp ${name} `)) bodies[name].safe = false
        if (command === `gamemode survival ${name}`) {
          assert.equal(bodies[name].safe, true, 'the fixed initial y coordinate may be inside terrain')
          bodies[name].mode = 'survival'
        }
      }
      return ''
    }, i: 31 }
  installRounds(context)
  // Свои члены контекста ставит installRounds — подмены после него (reset, spreadBots и giveBlue — настоящие).
  context.armsHome = (b, k) => ({ x: b.team === 'red' ? 558.5 : 642.5, y: 128, z: 632.5 + k })
  context.roundKit = async () => {}
  context.readDeaths = () => { assert.equal(context.between, true) }
  return { bodies, bots, commands, calls, logs, sleeps, context }
}

for (const solo of [false, true]) test(`safe placement covers every owned spectator in ${solo ? 'solo' : '20v20'} setup`, async () => {
  const f = placements(false, solo)
  const ready = await f.context.spreadBots()
  assert.deepEqual([...ready], f.bots.map(b => b.name))
  assert.equal(f.commands.filter(c => c.startsWith('spreadplayers ')).length, 2)
  assert.ok(Object.values(f.bodies).every(b => b.safe && b.mode === 'spectator'))
  assert.ok(f.commands.every(c => !c.includes('@a')), 'placement must not include a human through a broad selector')
})

test('a failed server safe-placement receipt keeps owned bodies in spectator and aborts setup', async () => {
  const f = placements(true)
  await assert.rejects(f.context.spreadBots(), /spread|размест|placement/i)
  assert.ok(Object.values(f.bodies).every(b => b.mode === 'spectator'))
  assert.equal(f.context.stop, true)
  assert.deepEqual([...f.context.out], f.bots.map(b => b.name))
  assert.ok(f.logs.some(log => log.includes('0/2')))
})

for (const solo of [false, true]) test(`partial ${solo ? 'solo' : 'team'} setup activates only confirmed bodies and excludes the missing body`, async () => {
  const f = placements(name => name === 'NeuroFarm31y' && 'Could not spread 1 entity/entities around 642, 632', solo)
  f.bodies.Tester = { mode: 'survival', safe: true }
  await placeFighters(f.context)
  assert.equal(f.bodies.NeuroFarm31.mode, 'survival')
  assert.equal(f.bodies.NeuroFarm31y.mode, 'spectator')
  assert.deepEqual([...f.context.out], ['NeuroFarm31y'])
  assert.equal(f.context.between, false)
  assert.equal(f.context.stop, false)
  assert.ok(f.logs.some(log => log.includes('1/2')))
  assert.ok(!f.commands.includes('gamemode survival NeuroFarm31y'))
  assert.ok(!f.commands.some(command => /\bTester\b|@a/.test(command)), 'the human retains their own mode and position')
})

test('partial reset drains old deaths, excludes the failed body and admits it on the next confirmed reset', async () => {
  const failed = new Set(['NeuroFarm31y'])
  const f = placements(name => failed.has(name) && 'Could not spread 1 entity/entities around 642, 632')
  f.context.out.add('NeuroFarm31'); f.context.deadNow.add('NeuroFarm31')
  for (const b of Object.values(f.bodies)) b.mode = 'survival'
  await f.context.endRound(false, 'fixture')
  assert.equal(f.context.round, 2)
  assert.equal(f.context.between, false)
  assert.deepEqual([...f.context.out], ['NeuroFarm31y'])
  assert.equal(f.context.deadNow.size, 0)
  assert.equal(f.bodies.NeuroFarm31.mode, 'survival')
  assert.equal(f.bodies.NeuroFarm31y.mode, 'spectator')
  assert.ok(!f.commands.includes('gamemode survival NeuroFarm31y'))
  failed.clear()
  await f.context.endRound(false, 'fixture')
  assert.equal(f.context.round, 3)
  assert.equal(f.context.out.size, 0)
  assert.ok(Object.values(f.bodies).every(b => b.safe && b.mode === 'survival'))
  assert.ok(f.logs.some(log => log.includes('1/2')) && f.logs.some(log => log.includes('2/2')))
})

test('all failed reset placements retain the preparation fence and stop without activating guessed positions', async () => {
  const f = placements(true)
  for (const b of Object.values(f.bodies)) b.mode = 'survival'
  await assert.rejects(f.context.endRound(false, 'fixture'), /safe placement/i)
  assert.ok(Object.values(f.bodies).every(b => b.mode === 'spectator'))
  assert.equal(f.context.between, true)
  assert.equal(f.context.stop, true)
  assert.equal(f.context.round, 2)
  assert.ok(!f.commands.some(command => command.startsWith('gamemode survival ')))
  const after = f.commands.length
  await f.context.endRound(false, 'late previous-round trigger')
  for (const b of f.bots) await fighterLoop(f.context, b)
  assert.equal(f.commands.length, after, 'late triggers and stopped fighter loops cannot reopen the failed preparation')
  assert.equal(f.context.round, 2)
})

for (const retrySucceeds of [true, false]) test(`an absent body is retried once and ${retrySucceeds ? 'joins only after confirmation' : 'remains out after a failed retry'}`, async () => {
  let missingCalls = 0
  const f = placements(name => name === 'NeuroFarm31y' && (++missingCalls === 1 || !retrySucceeds) && 'No entity was found')
  const missing = f.bots.find(b => b.name === 'NeuroFarm31y')!
  const originalCall = missing.c.call
  let afterConnect = -1
  missing.c.call = async method => {
    await originalCall(method)
    if (method === 'connect') { f.bodies[missing.name].mode = 'survival'; afterConnect = f.commands.length }
  }
  await placeFighters(f.context)
  assert.deepEqual(f.calls.filter(c => c.method === 'connect'), [{ name: 'NeuroFarm31y', method: 'connect' }])
  assert.equal(f.commands.filter(c => c.startsWith('spreadplayers ')).length, 3)
  assert.equal(f.bodies.NeuroFarm31y.mode, retrySucceeds ? 'survival' : 'spectator')
  assert.equal(f.context.out.has('NeuroFarm31y'), !retrySucceeds)
  assert.equal(f.context.stop, false)
  assert.equal(f.commands[afterConnect], 'gamemode spectator NeuroFarm31y', 'a fresh connection may restore survival from its saved state')
  assert.equal(f.sleeps[0].modes.NeuroFarm31y, 'spectator', 'park the new body before the existing retry wait')
})

test('a failed parking transport after reconnect stops preparation before the retry wait or any activation', async () => {
  let joined = false
  const f = placements(name => name === 'NeuroFarm31y' && 'No entity was found', false, command => {
    if (joined && command === 'gamemode spectator NeuroFarm31y') throw new Error('parking transport unavailable')
  })
  const missing = f.bots.find(b => b.name === 'NeuroFarm31y')!, originalCall = missing.c.call
  missing.c.call = async method => {
    await originalCall(method)
    if (method === 'connect') { joined = true; f.bodies[missing.name].mode = 'survival' }
  }
  await assert.rejects(placeFighters(f.context), /parking transport unavailable/)
  assert.equal(f.context.between, true)
  assert.equal(f.context.stop, true)
  assert.equal(f.sleeps.length, 0)
  assert.equal(f.commands.filter(command => command.startsWith('spreadplayers ')).length, 2)
  assert.ok(!f.commands.some(command => command.startsWith('gamemode survival ')))
})

test('initial arms setup stays spectator through guessed teleports and restores survival after real safe placement', async () => {
  const f = placements()
  for (const b of Object.values(f.bodies)) b.mode = 'survival'
  await placeFighters(f.context)
  assert.ok(Object.values(f.bodies).every(b => b.safe && b.mode === 'survival'))
})

test('between-round log deaths are consumed without eliminating a freshly reset actor', t => {
  const log = '[17:13:14] [Server thread/INFO]: NeuroFarm31y suffocated in a wall\n'
  const LOGF = path.join(os.tmpdir(), `ffa-reset-deaths-${process.pid}.log`)
  fs.writeFileSync(LOGF, log)
  t.after(() => fs.rmSync(LOGF, { force: true }))
  const context: any = { logAt: 0, between: true, LOGF,
    names: ['NeuroFarm31y'], bots: [], humans: {}, deaths: {}, kills: {}, deadNow: new Set(), deathAt: {}, pos: {},
    killGaps: [], lastKillAt: 0, log() {}, teamOf: () => 'blue', teams: true }
  installRounds(context)
  context.endRound = async () => {}
  context.readDeaths()
  assert.equal(context.logAt, Buffer.byteLength(log))
  assert.equal(context.deadNow.size, 0)
  assert.deepEqual(context.deaths, {})
  context.between = false
  context.readDeaths()
  assert.equal(context.deadNow.size, 0, 'the preparation death cannot be replayed in the new round')
})

test('a delayed old death handler cannot park an actor after the next round starts', async () => {
  let release
  const gate = new Promise<void>(resolve => { release = resolve })
  const commands: string[] = []
  const b = { name: 'NeuroFarm31y', team: 'blue', c: { call: () => gate } }
  const context: any = { arms: true, bots: [b], deadNow: new Set([b.name]), out: new Set(), busy: new Set(),
    round: 1, between: false, stop: false, X: 600, Y: 120, Z: 600, pos: { [b.name]: { hp: 20 } },
    swarmDriver: { release() {} }, sleep: async () => {}, rcon: async (_slot, command) => commands.push(command),
    endRound: async () => {}, i: 31, log() {} }
  const pending = fighterLoop(context, b)
  context.round++; context.stop = true
  release()
  await pending
  assert.deepEqual(commands, [], 'the previous death cannot put the reset actor back in spectator or teleport it out')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installRounds, placeFighters, fighterLoop } from './arena/rounds'
// Ручки окружения, добавляющие выдачу и наборы раунда: тест — на умолчаниях.
delete process.env.ARMS_GIVE; delete process.env.ARMS_AIR; delete process.env.ARMS_CRYSTAL; delete process.env.ARMS_TNT

function placements(fail = false, solo = false) {
  const bodies = { NeuroFarm31: { mode: 'spectator', safe: false }, NeuroFarm31y: { mode: 'spectator', safe: false } }
  const commands: string[] = []
  const bots = Object.keys(bodies).map((name, k) => ({ name, team: k ? 'blue' : 'red' }))
  const context: any = { bots, N: bots.length, SOLO: solo, arms: true, X: 600, Y: 120, Z: 600,
    L: { spawns: [{ x: -42, y: 8, z: 32 }, { x: 42, y: 8, z: 32 }] }, log() {},
    rcon: async (_slot, command) => {
      commands.push(command)
      const match = /^spreadplayers .* false (\S+)$/.exec(command)
      if (match) {
        assert(match[1] in bodies, 'only an explicitly owned bot may be placed')
        assert.equal(bodies[match[1]].mode, 'spectator')
        if (fail) return 'Could not spread 1 entity/entities around 642, 632'
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
  return { bodies, bots, commands, context }
}

for (const solo of [false, true]) test(`safe placement covers every owned spectator in ${solo ? 'solo' : '20v20'} setup`, async () => {
  const f = placements(false, solo)
  await f.context.spreadBots()
  assert.equal(f.commands.filter(c => c.startsWith('spreadplayers ')).length, 2)
  assert.ok(Object.values(f.bodies).every(b => b.safe && b.mode === 'spectator'))
  assert.ok(f.commands.every(c => !c.includes('@a')), 'placement must not include a human through a broad selector')
})

test('a failed server safe-placement receipt keeps owned bodies in spectator and aborts setup', async () => {
  const f = placements(true)
  await assert.rejects(f.context.spreadBots(), /spread|размест|placement/i)
  assert.ok(Object.values(f.bodies).every(b => b.mode === 'spectator'))
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

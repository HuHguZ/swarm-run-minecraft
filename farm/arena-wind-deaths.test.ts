import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installRounds } from './arena/rounds'

test('native deaths near a wind throw are temporal observations for bots and humans, never inferred wind kills', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-wind-deaths-')), LOGF = path.join(dir, 'latest.log')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  t.mock.method(Date, 'now', () => 50000)
  fs.writeFileSync(LOGF, '')
  const logs: string[] = [], bot = 'NeuroFarm31h', human = 'Tester'
  const ctx: any = { i: 31, teams: true, arms: true, names: [bot], bots: [], pos: {}, humans: { [human]: {} },
    deaths: {}, kills: {}, deadNow: new Set(), out: new Set(), deathAt: {}, killGaps: [], roundWins: {},
    radio: {}, opened: new Set(), chestBy: new Map(), chestFail: new Map(), refills: new Map(), labNeed: {}, brewed: {}, alchemist: {},
    LOGF, logAt: 0, between: false, humanOut: new Set(), humanOutWatch: async () => {}, kitHuman() {},
    teamOf: () => 'red', log: line => logs.push(line), emote() {}, relSay() {} }
  installRounds(ctx)
  ctx.endRound = async () => {}
  for (const name of [bot, human]) for (const reason of ['keepalive timeout', 'floating too long']) {
    ctx.windOutAt = { [name]: { by: 'NeuroFarm31w', at: 49000, kind: 'volley' } }
    fs.appendFileSync(LOGF, `[20:00:00] [Server thread/INFO]: ${name} was kicked due to ${reason}!\n`)
    ctx.readDeaths()
    assert.equal(ctx.deaths[bot], undefined, 'disconnect must not count as a death')
    assert.equal(ctx.deadNow.size, 0, 'a live bot must remain eligible to reconnect into this round')
    assert.equal(ctx.humanOut.size, 0)
    assert.equal(ctx.windRecentDeaths, undefined, 'a nearby throw cannot turn a kick into a wind death')
    assert(ctx.windOutAt[name], 'a kick does not consume the pending wind observation')
    assert.equal(logs.length, 0)
  }
  const causes = ['was speared by NeuroFarm31v', 'fell from a high place', 'fell out of the world']
  for (const name of [bot, human]) for (const cause of causes) {
    ctx.windOutAt = { [name]: { by: 'NeuroFarm31w', at: 49000, kind: 'volley' } }
    const before = logs.length
    fs.appendFileSync(LOGF, `[20:00:00] [Server thread/INFO]: ${name} ${cause}\n`)
    ctx.readDeaths()
    const recent = logs.slice(before).filter(line => line.startsWith('🌬☠'))
    assert.equal(recent.length, 1)
    assert.ok(!/сброшен ветром|всего сбросов/.test(recent[0]), 'temporal overlap must not claim a causal wind kill')
    assert.ok(recent[0].includes('погиб в течение 4 с после броска ветра'))
    assert.ok(recent[0].includes(`native причина: ${cause}`), 'keep the native death cause even for fall/void')
    assert.equal(ctx.windOutAt[name], undefined)
  }
  assert.equal(ctx.windRecentDeaths, 6)
  assert.equal(ctx.windKills, undefined)
  assert.equal(ctx.deaths[bot], 3, 'ordinary native death accounting remains active')
  for (const name of [bot, human]) {
    ctx.windOutAt = { [name]: { by: 'NeuroFarm31w', at: 46000, kind: 'volley' } }
    const before = logs.length
    fs.appendFileSync(LOGF, `[20:00:00] [Server thread/INFO]: ${name} was speared by NeuroFarm31v\n`)
    ctx.readDeaths()
    assert.ok(!logs.slice(before).some(line => line.startsWith('🌬☠')), 'the exact 4-second boundary is stale')
  }
  assert.equal(ctx.windRecentDeaths, 6)
})

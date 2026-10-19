'use strict'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import Module = require('node:module')
import { transformSync } from 'esbuild'
import { functionSource, declSource } from './source-fixture'
function current (relative) {
  const file = path.join(__dirname, relative); const mod: any = new Module(file, module)
  mod.filename = file; mod.paths = (Module as any)._nodeModulePaths(path.dirname(file))
  mod._compile(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, file)
  return mod.exports
}
const metrics = current('../arena/arena-metrics.ts')
const totem = current('../src/totem.ts')
// Арена — скрипт (вход arena.ts + части arena/): функции берутся по имени из склейки, без запуска.
const arenaJs = path.join(__dirname, '../arena/arena.js')

test('arena return checks use physical position, not the floored exterior strip', async () => {
  const source = functionSource(arenaJs, 'where')
  assert.ok(source.startsWith('async function where(') && source.endsWith('}'))
  const context = vm.createContext(cjsContext({ X: 600, Y: 120, Z: 600, CLEAN_R: 24, COLOS: true, CEIL: true, CEIL_H: 16, deathBase: new Map() }))
  vm.runInContext(source + '\nthis.where = where', context)
  for (const [x, z, expected] of <[number, number, string][]>[[602.5, 626.6, 'gone'], [626.6, 602.5, 'gone'],
    [574.4, 602.5, 'gone'], [602.5, 574.4, 'gone'], [602.5, 624.7, 'in'], [576.3, 602.5, 'in']]) {
    let requested
    const client = { call: async (method, params) => {
      assert.equal(method, 'status'); requested = params
      return { state: { connected: true, health: 20, pos: { x: Math.floor(x), y: 120, z: Math.floor(z) } },
        detail: { physics: { pos: { x, y: 120, z } } } }
    } }
    assert.equal(await context.where(client), expected, `physical ${x},${z}; same-height exterior is not a return`)
    assert.equal(requested.physics, true)
  }
})

// Run the real round loop without Minecraft, sockets, timers or user files.
async function arenaRound ({ missingFinal = false, staleFallback = false, totemBoundary = 'ok' } = {}) {
  let now = 0; let deathAt = 0; let fightAt = 0; let calls = 0; let releaseB
  const waitingB = new Promise(resolve => { releaseB = resolve })
  const lines = []; const samples = []
  const pops = { A: 9, B: 4 }
  const first = { swings: 4, landed: 3, tricks: { hit: 2 }, crystal: { dealt: [3, 5], self: 2 }, totem: { pops: 10 },
    quality: { longestS: 8, quiet10S: 10, bothEatS: 2, gaps10: 1 }, search: { legs: 3, seconds: 2 } }
  const last = { swings: 2, landed: 1, tricks: { hit: 1 }, crystal: { dealt: [7], self: 1 }, died: true, totem: { pops: 12 },
    quality: { longestS: 5, quiet10S: 20, bothEatS: 4, gaps10: 2 }, search: { legs: 4, seconds: 3 } }
  const client = who => ({ call: async (method, params) => {
    if (method === 'fight') {
      if (who === 'B') { await waitingB; return { status: 'done', detail: { swings: 5, killed: 'A' } } }
      if (++calls === 1) { pops.A++; fightAt = now; now += 1000; return { status: 'done', detail: first } }
      pops.A++; now += 2000; deathAt = now; releaseB()
      return missingFinal ? { status: 'interrupted', by: { type: 'death' } } : { status: 'done', detail: last }
    }
    if (method === 'status') {
      const p = who === 'A' && deathAt ? deathAt : now
      samples.push({ who, at: now })
      return { state: { health: who === 'A' && deathAt ? 0 : 20, physicsTicks: p / 50, clock: { ticks: now / 50 } },
        ...(params?.totem && totemBoundary !== 'missing' ? { detail: { totem: { id: who + (totemBoundary === 'replaced' && deathAt ? '-new' : ''), pops: pops[who], reequips: 0, fails: 0, fast: 0, slow: 0, why: {} } } } : {}),
        ...(params?.lastDuel ? { lastDuel: { at: staleFallback ? fightAt : deathAt, detail: staleFallback ? first : last } } : {}) }
    }
    return { status: 'done', detail: {} }
  } })
  const A = client('A'); const B = client('B')
  const clock = { now: () => now, snapshot: () => ({ ticks: now / 50 }),
    setInterval: () => 1, clearInterval () {}, wall: { now: () => now, sleep: async ms => { now += ms }, setInterval: () => 1, clearInterval () {} } }
  const body = functionSource(arenaJs, 'round')
  assert.ok(body.startsWith('async function round(') && !body.includes('await A.ready'))
  const context = vm.createContext(cjsContext({
    A, B, NA: 'A', NB: 'B', A_URL: 'a', B_URL: 'b', HUMANS: [], HUMAN: null, PREP_RATE: 0, FIGHT_RATE: 0,
    GENTLE: false, X: 0, Y: 100, Z: 0, CLEAN_R: 24, TP: '/tp', NOTIMER: true, MAX_MS: 100000, STALL_MS: 100000,
    RETURN_MS: 45000, GONE_MS: 10000, deathBase: new Map(), lagMax: { a: 0, b: 0 }, score: { A: 0, B: 0, draw: 0 },
    gameClock: clock, sleep: async ms => { if (calls === 1 && !deathAt) pops.A++; now += ms }, process: { env: {} }, log: line => lines.push(line),
    stopRequested: () => false, resetArena: async () => {}, alive: async () => {}, kitSides: kit => ({ a: kit.a, b: kit.a }),
    equipChecked: async () => {}, heal: async () => {}, cmd: async () => {}, short: () => '',
    where: async c => c === A && deathAt ? 'dead' : 'in', diedIn: r => !!r.detail?.died || r.by?.type === 'death',
    lostLink: () => false, logSize: () => 0, roundDeaths: () => [{ who: 'A', kind: 'foe' }],
    ...metrics, totemDelta: totem.delta
  }))
  vm.runInContext(body + '\nthis.run = round', context)
  await context.run({ name: 'test', a: [] }, 1)
  return { row: JSON.parse(lines.find(line => line.startsWith('ROUND ')).slice(6)), fightAt, deathAt, samples }
}

test('ROUND totals include every fight call, including the terminal call', async () => {
  const { row } = await arenaRound()
  assert.equal(row.a.swings, 6)
  assert.equal(row.a.landed, 4)
  assert.deepEqual(row.a.tricks, { hit: 3 })
  assert.deepEqual(row.a.crystal.dealt, [3, 5, 7])
  assert.equal(row.a.crystal.self, 3)
  assert.equal(row.a.segments.length, 2)
  assert.equal(row.winner, 'B')
})

test('ROUND totem delta includes the inter-segment pop and excludes previous rounds', async () => {
  const { row } = await arenaRound()
  assert.equal(row.a.totem.pops, 3, 'one in each fight and one in the gap; not the cumulative 10+12')
  assert.equal(row.b.totem.pops, 0)
  assert.deepEqual(row.a.quality, { longestS: 8, quiet10S: 30, bothEatS: 6, gaps10: 3 })
  assert.deepEqual(row.a.search, { legs: 7, seconds: 5 })
})

test('ROUND totem is unknown when a counter boundary is absent or belongs to a replacement bot', async () => {
  for (const totemBoundary of ['missing', 'replaced']) {
    const { row } = await arenaRound({ totemBoundary })
    assert.equal(row.a.totem, null)
    assert.equal(row.a.segments[0].totem.pops, 10, 'raw segment telemetry remains available without claiming a complete total')
  }
})

test('round clocks exclude countdown and post-death respawn/report waits', async () => {
  const { row, fightAt, deathAt } = await arenaRound()
  assert.equal(row.durS, Math.round((deathAt - fightAt) / 1000))
  assert.equal(row.wallS, Math.round((deathAt - fightAt) / 1000))
  assert.equal(row.tps, 20)
  assert.deepEqual(row.physShare, { a: 1, b: 1 })
})

test('a missing terminal report is filled before aggregation and a previous duel cannot be counted twice', async () => {
  assert.equal((await arenaRound({ missingFinal: true })).row.a.swings, 6)
  const { row } = await arenaRound({ missingFinal: true, staleFallback: true })
  assert.equal(row.a.swings, 4)
  assert.equal(row.a.segments.length, 2)
  assert.equal(row.a.died, true)
})

test('round totals weight measured averages, keep maxima and never add cumulative daemon state', () => {
  const { roundDetail } = metrics
  const reports = [
    { hp: '20 -> 14', melee: { combo: { max: 4, avg: 3, n: 2 }, kbPlain: 1.5, skill: { counter: 0.3 } },
      blockLog: { place: { wall: { n: 3, ok: 2, ms: 100 } } }, crystal: { dealt: [2, 4], avg: 3, planN: 4, planMsAvg: 2 },
      mace: { launched: 2, peak: 5 }, elytra: { lancePasses: 2, blockedLooks: 8 }, calc: { plans: 5, last: { score: 3 } },
      boom: { dealt: [2, 4], avg: 3 }, shield: { confirmMs: 80, confirmedTicks: 8, swings: 2, contactSeconds: 4, hpUnderShield: 2, upSeconds: 1, hpPerSecUnder: 2, secondsPerSwing: 2 } },
    { hp: '14 -> 0', melee: { combo: { max: 2, avg: 2, n: 1 }, kbPlain: 2.5, skill: { counter: 0.8 } },
      blockLog: { place: { wall: { n: 1, ok: 1, ms: 400 } } }, crystal: { dealt: [9], avg: 9, planN: 1, planMsAvg: 7 },
      mace: { launched: 1, peak: 8 }, elytra: { lancePasses: 3, blockedLooks: 11 }, calc: { plans: 7, last: { score: 9 } },
      boom: { dealt: [9], avg: 9 }, shield: { confirmMs: 50, confirmedTicks: 5, swings: 1, contactSeconds: 5, hpUnderShield: 4, upSeconds: 2, hpPerSecUnder: 2, secondsPerSwing: 5 } }
  ]
  const before = structuredClone(reports); const d = roundDetail(reports)
  assert.deepEqual(d.melee.combo, { max: 4, avg: 2.67, n: 3 })
  assert.deepEqual(d.blockLog.place.wall, { n: 4, ok: 3, ms: 200 })
  assert.equal(d.crystal.avg, 5)
  assert.equal(d.crystal.planMsAvg, 3)
  assert.equal(d.mace.peak, 6)
  assert.equal(d.boom.avg, 5)
  assert.equal(d.shield.confirmMs, 80)
  assert.equal(d.shield.confirmedTicks, 5)
  assert.equal(d.shield.secondsPerSwing, 3)
  assert.equal(d.shield.hpPerSecUnder, 2)
  assert.equal(d.hp, '20 -> 0')
  assert.equal(d.elytra.lancePasses, 5)
  assert.equal(d.elytra.blockedLooks, 11)
  assert.deepEqual(d.calc, { plans: 12, last: { score: 9 } })
  assert.deepEqual(d.melee.skill, { counter: 0.8 })
  assert.equal(d.melee.kbPlain, null, 'sample counts are unavailable, so no invented aggregate average')
  assert.deepEqual(d.segments, before)
  assert.deepEqual(reports, before)
})

test('farm stop requests read only ND_SERVER_LOG and never the user client log', () => {
  const body = declSource(arenaJs, 'MC_LOG', 'startedAt', 'stopRequested')
  for (const serverLog of ['farm/server-30/logs/latest.log', undefined]) {
    const reads = []
    const context = vm.createContext(cjsContext({ process: { env: { APPDATA: 'USER-CLIENT-MUST-NOT-BE-READ', ND_SERVER_LOG: serverLog } }, path,
      gameClock: { wall: { now: () => 0 } }, fs: { statSync: filename => { reads.push(filename); throw new Error('no server log') } } }))
    vm.runInContext(body + '\nthis.stopped = stopRequested()', context)
    assert.equal(context.stopped, false)
    assert.deepEqual(reads, serverLog ? [serverLog] : [])
  }
})

test('ROUND keeps support-dig intent and outcomes, weighting time by confirmed blocks', () => {
  const rows = [
    { n: 2, ok: 1, failed: 1, pending: 0, unconfirmed: 0, ms: 100 },
    { n: 4, ok: 3, failed: 0, pending: 1, unconfirmed: 0, ms: 300 }
  ]
  const report = metrics.roundDetail(rows.map(row => ({ blockLog: { supportDig: { 'perch-descent': row } } })))
  assert.deepEqual(report.blockLog.supportDig['perch-descent'], { n: 6, ok: 4, failed: 1, pending: 1, unconfirmed: 0, ms: 250 })
  assert.deepEqual(report.segments.map(row => row.blockLog.supportDig['perch-descent']), rows)
})

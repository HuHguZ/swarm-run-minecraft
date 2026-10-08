'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Run the real round loop without Minecraft, sockets, timers or user files.
async function arenaRound ({ missingFinal = false, staleFallback = false } = {}) {
  let now = 0; let deathAt = 0; let fightAt = 0; let calls = 0; let releaseB
  const waitingB = new Promise(resolve => { releaseB = resolve })
  const lines = []; const samples = []
  const first = { swings: 4, landed: 3, tricks: { hit: 2 }, crystal: { dealt: [3, 5], self: 2 } }
  const last = { swings: 2, landed: 1, tricks: { hit: 1 }, crystal: { dealt: [7], self: 1 }, died: true }
  const client = who => ({ call: async (method, params) => {
    if (method === 'fight') {
      if (who === 'B') { await waitingB; return { status: 'done', detail: { swings: 5, killed: 'A' } } }
      if (++calls === 1) { fightAt = now; now += 1000; return { status: 'done', detail: first } }
      now += 2000; deathAt = now; releaseB()
      return missingFinal ? { status: 'interrupted', by: { type: 'death' } } : { status: 'done', detail: last }
    }
    if (method === 'status') {
      const p = who === 'A' && deathAt ? deathAt : now
      samples.push({ who, at: now })
      return { state: { health: who === 'A' && deathAt ? 0 : 20, physicsTicks: p / 50, clock: { ticks: now / 50 } },
        ...(params?.lastDuel ? { lastDuel: { at: staleFallback ? fightAt : deathAt, detail: staleFallback ? first : last } } : {}) }
    }
    return { status: 'done', detail: {} }
  } })
  const A = client('A'); const B = client('B')
  const clock = { now: () => now, snapshot: () => ({ ticks: now / 50 }),
    setInterval: () => 1, clearInterval () {}, wall: { now: () => now, sleep: async ms => { now += ms }, setInterval: () => 1, clearInterval () {} } }
  const source = fs.readFileSync(path.join(__dirname, '../arena.js'), 'utf8')
  const body = source.slice(source.indexOf('async function round(')).split(/\n;?\s*\(async \(\) => \{/)[0]
  assert.ok(body.startsWith('async function round(') && !body.includes('await A.ready'))
  const helper = path.join(__dirname, '../arena-metrics.js')
  const context = vm.createContext({
    A, B, NA: 'A', NB: 'B', A_URL: 'a', B_URL: 'b', HUMANS: [], HUMAN: null, PREP_RATE: 0, FIGHT_RATE: 0,
    GENTLE: false, X: 0, Y: 100, Z: 0, CLEAN_R: 24, TP: '/tp', NOTIMER: true, MAX_MS: 100000, STALL_MS: 100000,
    RETURN_MS: 45000, GONE_MS: 10000, deathBase: new Map(), lagMax: { a: 0, b: 0 }, score: { A: 0, B: 0, draw: 0 },
    gameClock: clock, sleep: async ms => { now += ms }, process: { env: {} }, log: line => lines.push(line),
    stopRequested: () => false, resetArena: async () => {}, alive: async () => {}, kitSides: kit => ({ a: kit.a, b: kit.a }),
    equipChecked: async () => {}, heal: async () => {}, cmd: async () => {}, short: () => '',
    where: async c => c === A && deathAt ? 'dead' : 'in', diedIn: r => !!r.detail?.died || r.by?.type === 'death',
    lostLink: () => false, logSize: () => 0, roundDeaths: () => [{ who: 'A', kind: 'foe' }],
    ...(fs.existsSync(helper) ? require(helper) : {})
  })
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
  const { roundDetail } = require('../arena-metrics')
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
  const source = fs.readFileSync(path.join(__dirname, '../arena.js'), 'utf8')
  const body = source.slice(source.indexOf('const MC_LOG')).split('const ONLY')[0]
  for (const serverLog of ['farm/server-30/logs/latest.log', undefined]) {
    const reads = []
    const context = vm.createContext({ process: { env: { APPDATA: 'USER-CLIENT-MUST-NOT-BE-READ', ND_SERVER_LOG: serverLog } }, path,
      gameClock: { wall: { now: () => 0 } }, fs: { statSync: filename => { reads.push(filename); throw new Error('no server log') } } })
    vm.runInContext(body + '\nthis.stopped = stopRequested()', context)
    assert.equal(context.stopped, false)
    assert.deepEqual(reads, serverLog ? [serverLog] : [])
  }
})

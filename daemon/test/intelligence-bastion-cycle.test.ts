import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { miningProgress, needsKnownGoldApproach } from '../src/bastion/mining-cycle'
import { cjsContext } from './cjs-context'
import { declSource } from './source-fixture'

// Цикл добычи и торга bastion() — mineLoop и его шаги (bastion/run-loop.ts, шаг закрытого пути — bastion/run-trade.ts);
// состояние вызова — bx, общие мелочи (done, spare, goldReady, …) — заглушки контекста.
const LOOP_STEPS = ['mineLoop', 'MINE_STEPS', 'stepSafe', 'stepEntry', 'stepBarterBetween', 'stepGoldOver', 'stepSealed', 'sealedSurvey',
  'stepYard', 'stepTower', 'stepPredicted', 'stepDeferred', 'stepVantage']
const TRADE_STEPS = ['stepTunnelBarter', 'barterAtSite', 'chooseSite', 'tradeAtSite', 'noSite', 'pickStrayPearls']

async function runMiningLoop(firstProgress: boolean, mode = 'auto') {
  const filename = require.resolve('../src/bastion/bastion')
  const source = declSource(require.resolve('../src/bastion/run-trade'), ...TRADE_STEPS) + '\n' +
    declSource(require.resolve('../src/bastion/run'), 'miningSnapshot') + '\n' +
    declSource(require.resolve('../src/bastion/run-loop'), ...LOOP_STEPS)
  assert.ok(source.includes('async function mineLoop('), 'test executes the actual Bastion mining/trading loop')
  const own = new Set(['23,52,50', '23,53,50'])
  const st = { sealed: true, sealedDone: mode === 'barter', sealedState: { own, dug: 0 }, pitDone: false,
    pred: new Map([['87,35,139', { pos: { x: 87, y: 35, z: 139 } }]]), gold: new Map(),
    noPick: false, blocks: 0, chests: [], towered: 3, barterRetry: '', chestSeen: new Map(), looted: new Set() }
  let mined = 0
  const bx = { st, mode, deadline: 1_200_000, goldPhaseEnd: 1_200_000, barterWalks: 0, minedSinceRetry: false, idle: 0, vantage: 0,
    bot: { health: 20 }, ctl: { aborted: false }, session: {}, p: { exit: false }, keep: 0 }
  const context = { bx,
    gameClock: { now: () => 1000 }, BF: { enabled: () => true }, miningCycle: { miningProgress },
    inLava: () => false, eatIfHungry: async () => {}, answerAttack: async () => false,
    bruteDefense: async () => false, done: () => false, spare: () => 0, goldReady: async () => true,
    countOf: () => 0, goldTarget: () => 144, log() {}, survey() {},
    sealedGold: async () => {
      if (++mined > 3) throw new Error('unbounded no-progress mining loop')
      if (firstProgress && mined === 1) { st.sealedState.dug++; own.add('24,52,50') }
    },
    process: { env: { ND_GOLD_ROUTE: '0' } }, require: createRequire(filename),
    out: () => ({ mined, retry: st.barterRetry, remaining: st.pred.size }) }
  return await runInNewContext('(async () => {\n' + source + '\n await mineLoop(bx)\n return out() })()', cjsContext(context))
}

test('failed mining returns with mapped gold preserved instead of starving native packets in a retry loop', async () => {
  const result = await runMiningLoop(false)
  assert.equal(result.mined, 1)
  assert.equal(result.remaining, 1, 'no route cannot assert exhaustion')
  assert.match(result.retry, /добыча не продвинулась/)
  assert.equal((await runMiningLoop(false, 'barter')).mined, 0, 'barter cannot silently switch into mining')
})

test('another gold batch is allowed after actual excavation, then bounded when that progress stops', async () => {
  const result = await runMiningLoop(true)
  assert.equal(result.mined, 2)
  assert.equal(result.remaining, 1)
})

test('a partial own tunnel still requires approaching far mapped gold', () => {
  const target = { x: 87, y: 35, z: 139 }
  assert.equal(needsKnownGoldApproach({ x: 23, y: 52, z: 50 }, target, true, false), true)
  assert.equal(needsKnownGoldApproach({ x: 23, y: 52, z: 50 }, target, true, true), true)
  assert.equal(needsKnownGoldApproach({ x: 57, y: 47, z: 118 }, target, true, true), true,
    'Full21 own partial route is still outside the mapped mining area')
  assert.equal(needsKnownGoldApproach({ x: 86, y: 60, z: 138 }, target, true, true), true,
    'being horizontally close does not prove reaching the gold level')
  assert.equal(needsKnownGoldApproach({ x: 86, y: 35, z: 138 }, target, true, true), false)
})

async function routeHandoff(ok: boolean, aborted = false) {
  const { Vec3 }: typeof import('vec3') = require('vec3')
  // Ход по сетке к известному золоту — routeToGold (bastion/run-approach.ts); подход — объект a, состояние вызова — bx.
  const source = declSource(require.resolve('../src/bastion/run-approach'), 'routeToGold')
  assert.ok(source.includes('const rStart = bot.entity.position.floored()'))
  const own = new Set(['24,58,48', '24,59,48'])
  const receipt = { ok, own, steps: 40, dug: 60, at: { x: 24, y: 58, z: 48 }, why: ok ? undefined : 'время вышло' }
  const st: { sealedState?: { own: Set<string>; exposed: boolean } } = {}
  const remembered: string[][] = []
  const bx = { st, bot: { entity: { position: new Vec3(3.5, 69, 4.5) } }, ctl: { aborted }, session: {}, deadline: 720000 }
  const a = { goal: { x: 87, y: 35, z: 139 }, nearG: { x: 87, y: 35, z: 139 }, KG0: [{ x: 87, y: 35, z: 139 }], far1: 100,
    me0: new Vec3(3.5, 69, 4.5), routed: false,
    NR: { enabled: () => true, gridOf: () => ({}), routeTo: async () => receipt } }
  const context = { gameClock: { now: () => 0 },
    log() {}, lavaWatched: async (_bot, _ctl, run) => run(_ctl),
    require: name => {
      if (name.endsWith('/tunnel')) return { rememberOwn: (_session, cells) => remembered.push([...cells]) }
      if (name.endsWith('/sealed')) return { exposure: () => ['24,58,49'] }
      throw new Error(`unexpected dependency ${name}`)
    } }
  const routeToGold = runInNewContext(source + '\nrouteToGold', cjsContext(context))
  await routeToGold(bx, a)
  return { st, remembered, routed: a.routed }
}

test('partial mapped route keeps actual excavated cells for sealed mining without claiming a closed cover', async () => {
  const result = await routeHandoff(false)
  assert.deepEqual([...result.st.sealedState!.own], ['24,58,48', '24,59,48'])
  assert.equal(result.st.sealedState!.exposed, true, 'current native geometry can still expose a completed walk')
  assert.equal(result.routed, false, 'partial cells do not fabricate arrival')
  assert.deepEqual(result.remembered, [['24,58,48', '24,59,48']])
})

test('completed mapped route still checks exposure and aborted route cannot write shared ownership', async () => {
  const completed = await routeHandoff(true)
  assert.equal(completed.routed, true)
  assert.equal(completed.st.sealedState!.exposed, true)
  const cancelled = await routeHandoff(false, true)
  assert.equal(cancelled.st.sealedState, undefined)
  assert.deepEqual(cancelled.remembered, [])
})

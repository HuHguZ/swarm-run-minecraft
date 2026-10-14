import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { miningProgress, needsKnownGoldApproach } from '../src/bastion/mining-cycle'

async function runMiningLoop(firstProgress: boolean, mode = 'auto') {
  const filename = require.resolve('../src/bastion/bastion')
  const source = readFileSync(filename, 'utf8')
  const start = source.indexOf('    let minedSinceRetry = ')
  const end = source.indexOf('    if (!st.sealedState) await pickUp', start)
  assert.ok(start > 0 && end > start, 'test executes the actual Bastion mining/trading loop')
  const own = new Set(['23,52,50', '23,53,50'])
  const st = { sealed: true, sealedDone: mode === 'barter', sealedState: { own, dug: 0 }, pitDone: false,
    pred: new Map([['87,35,139', { pos: { x: 87, y: 35, z: 139 } }]]), gold: new Map(),
    noPick: false, blocks: 0, chests: [], towered: 3, barterRetry: '', chestSeen: new Map(), looted: new Set() }
  let mined = 0
  const context = { st, mode, deadline: 1_200_000, goldPhaseEnd: 1_200_000, barterWalks: 0,
    gameClock: { now: () => 1000 }, bot: { health: 20 }, ctl: { aborted: false }, session: {},
    p: { exit: false }, keep: 0, BF: { enabled: () => true }, miningCycle: { miningProgress },
    inLava: () => false, eatIfHungry: async () => {}, answerAttack: async () => false,
    bruteDefense: async () => false, done: () => false, spare: () => 0, goldReady: async () => true,
    countOf: () => 0, goldTarget: () => 144, log() {}, survey() {},
    sealedGold: async () => {
      if (++mined > 3) throw new Error('unbounded no-progress mining loop')
      if (firstProgress && mined === 1) { st.sealedState.dug++; own.add('24,52,50') }
    },
    process: { env: { ND_GOLD_ROUTE: '0' } }, require: createRequire(filename),
    out: () => ({ mined, retry: st.barterRetry, remaining: st.pred.size }) }
  return await runInNewContext('(async () => {\n' + source.slice(start, end) + '\n return out() })()', context)
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
  const { Vec3 } = require('vec3')
  const filename = require.resolve('../src/bastion/bastion')
  const source = readFileSync(filename, 'utf8')
  const start = source.indexOf('        const rStart = bot.entity.position.floored()')
  const end = source.indexOf('\n      }\n      if (!routed &&', start)
  assert.ok(start > 0 && end > start)
  const own = new Set(['24,58,48', '24,59,48'])
  const receipt = { ok, own, steps: 40, dug: 60, at: { x: 24, y: 58, z: 48 }, why: ok ? undefined : 'время вышло' }
  const st: { sealedState?: { own: Set<string>; exposed: boolean } } = {}
  const remembered: string[][] = []
  const context = { st, bot: { entity: { position: new Vec3(3.5, 69, 4.5) } }, ctl: { aborted }, session: {},
    deadline: 720000, gameClock: { now: () => 0 }, goal: { x: 87, y: 35, z: 139 }, zone: [], routed: false,
    log() {}, lavaWatched: async (_bot, _ctl, run) => run(_ctl), NR: { routeTo: async () => receipt },
    require: name => {
      if (name.endsWith('/tunnel')) return { rememberOwn: (_session, cells) => remembered.push([...cells]) }
      if (name.endsWith('/sealed')) return { exposure: () => ['24,58,49'] }
      throw new Error(`unexpected dependency ${name}`)
    } }
  await runInNewContext('(async () => {\n' + source.slice(start, end) + '\n})()', context)
  return { st, remembered, routed: context.routed }
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

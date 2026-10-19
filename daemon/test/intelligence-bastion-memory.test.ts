import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Vec3 } from 'vec3'
import { cjsContext } from './cjs-context'
import { transpiledSource } from './source-fixture'

const filename = require.resolve('../src/bastion/bastion')
const source = () => transpiledSource(filename)
// sealedGold (сундук по пути, задачи сундуков) — в bastion/sealed-gold.ts; places/memoSave — в bastion() (bastion/bastion.ts).
const sealedSource = () => transpiledSource(require.resolve('../src/bastion/sealed-gold'))
const chest = new Vec3(90, 73, 137)
const chestKey = '90,73,137'

async function chestRead(receipt: unknown, aborted = false) {
  const body = sealedSource()
  const start = body.indexOf('    if (t.chest) {')
  const end = body.indexOf('\n    const b = bot.blockAt(t.pos)', start)
  assert.ok(start > 0 && end > start)
  const st = { looted: new Set<string>(), skip: new Map<string, number>(), chests: [] }
  const ctl = { aborted }
  const context = { st, ctl, session: {}, t: { chest: true, k: chestKey, pos: chest }, gameClock: { now: () => 1000 },
    routeRetryAt: (ms: number) => 1000 + ms, log() {}, miningCycle: (require('../src/bastion/mining-cycle') as typeof import('../src/bastion/mining-cycle')),
    require: () => ({ takeWorth: async () => {
      if (receipt instanceof Error) throw receipt
      return receipt
    } }) }
  await runInNewContext('(async () => { for (let once = 0; once < 1; once++) {\n' + body.slice(start, end) + '\n} })()', cjsContext(context))
  return st
}

function memoRound(memos: Map<string, unknown>, looted: Set<string>, bot: object, dimension = 'the_nether') {
  const body = source()
  const start = body.indexOf('  const places = ')
  const end = body.indexOf('  if (st.noPick && st.sealed)', start)
  const saveStart = body.indexOf('  const memoSave = () => {', end)
  const nextBarter = /\n  if \(mode === ["']barter["'] && st.sealed\)/.exec(body.slice(saveStart))
  const saveEnd = nextBarter ? saveStart + nextBarter.index : -1
  const sealed = sealedSource()
  const taskStart = sealed.indexOf('    const chestsT = st.lootChests')
  const taskEnd = sealed.indexOf('\n    if (!preds.length', taskStart)
  assert.ok(start > 0 && end > start && saveStart > end && saveEnd > saveStart && taskStart > 0)
  const target = new Vec3(87, 35, 139)
  const st = { sealed: true, lootChests: true, pred: new Map([['87,35,139', { pos: target, rank: 0 }]]),
    looted, chestSeen: new Map([[chestKey, { pos: chest }]]), skip: new Map(),
    sealedState: { own: new Set(['90,73,135', '90,74,135']), filled: new Set(), exposed: false, entry: new Vec3(90, 73, 135) } }
  const context = { st, bot, MEMO: memos, p: { x: 87, y: 35, z: 139 }, mode: 'auto',
    session: { journal: { state: {} } }, PLACE: 'бастион (ад)', Vec3,
    worlds: { worldOf: () => dimension }, gameClock: { now: () => 1000, wall: { now: () => 1000 } },
    require: () => ({ coverRecord: () => null }), log() {} }
  const result = runInNewContext('(function () {\n' + body.slice(start, end) + '\n' + body.slice(saveStart, saveEnd) +
    '\n memoSave();\n' + sealed.slice(taskStart, taskEnd) + '\n return { tasks: chestsT, remaining: st.pred.size } })()', cjsContext(context))
  return { st, tasks: result.tasks as unknown[], remaining: result.remaining as number }
}

function fakeBot() {
  return { entity: { position: new Vec3(90.5, 73, 135.5) }, blockAt: () => ({ name: 'air' }) }
}

test('server-read empty chest survives the next Bastion call and is excluded without exhausting gold', async () => {
  const st = await chestRead({ at: { x: chest.x, y: chest.y, z: chest.z }, kind: 'chest', took: {} })
  assert.equal(st.looted.has(chestKey), true)
  const memos = new Map<string, unknown>()
  const bot = fakeBot()
  memoRound(memos, st.looted, bot)
  const next = memoRound(memos, new Set(), bot)
  assert.equal(next.st.looted.has(chestKey), true)
  assert.equal(next.tasks.length, 0, 'actual repeated RPC must not schedule the read chest again')
  assert.equal(next.remaining, 1, 'a read chest does not fabricate exhaustion of mapped gold')
})

test('interrupted, unread, failed and partial chest requests remain available for a later verified read', async () => {
  const good = { at: { x: chest.x, y: chest.y, z: chest.z }, kind: 'chest', took: {} }
  for (const [receipt, aborted] of [[{ ...good, stopped: 'время вышло' }, false],
    [new Error('windowOpen timeout'), false], [good, true],
    [{ ...good, notTaken: { iron_ingot: 'инвентарь полон' } }, false],
    [{ took: {} }, false], [{ ...good, at: { x: 0, y: 0, z: 0 } }, false]] as const) {
    const read = await chestRead(receipt, aborted)
    assert.equal(read.looted.size, 0, 'failed native read must not enter the memo')
    const result = memoRound(new Map(), read.looted, fakeBot())
    assert.equal(result.tasks.length, 1)
  }
})

test('loot memo is scoped to the original connection and dimension', async () => {
  const bot = fakeBot()
  const memos = new Map<string, unknown>()
  memoRound(memos, new Set([chestKey]), bot)
  assert.equal(memoRound(memos, new Set(), fakeBot()).tasks.length, 1, 'new world connection has its own chest contents')
  memoRound(memos, new Set([chestKey]), bot)
  assert.equal(memoRound(memos, new Set(), bot, 'overworld').tasks.length, 1)
})

test('the existing unsealed chest path also leaves failed or partial reads retryable', async () => {
  const body = readFileSync(require.resolve('../src/bastion/take-gold-block'), 'utf8')
  const start = body.indexOf('async function lootChest(')
  const end = body.indexOf('\nasync function unpackGold(', start)
  assert.ok(start >= 0 && end > start)
  const confirmed = { at: { x: chest.x, y: chest.y, z: chest.z }, kind: 'chest', took: {} }
  for (const receipt of [confirmed, { ...confirmed, stopped: 'время вышло' },
    { ...confirmed, notTaken: { iron_ingot: 'инвентарь полон' } }]) {
    const st = { looted: new Set<string>(), skip: new Map<string, number>(), chests: [] }
    const context = { canReach: () => true, keyOf: () => chestKey, gameClock: { now: () => 1000 },
      require: name => name.endsWith('/structures')
        ? { takeWorth: async () => receipt, piglinsWatching: () => [] }
        : (require('../src/bastion/mining-cycle') as typeof import('../src/bastion/mining-cycle')) }
    const run = runInNewContext(body.slice(start, end) + '\nlootChest', cjsContext(context))
    const result = await run({ bot: {} }, { aborted: false }, chest, st)
    assert.equal(st.looted.has(chestKey), receipt === confirmed)
    assert.equal(result, receipt === confirmed ? 'looted' : 'partial')
  }
})

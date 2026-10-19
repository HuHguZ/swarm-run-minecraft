import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import { EventEmitter } from 'node:events'
import { transformSync } from 'esbuild'
import { declSource } from './source-fixture'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// Real recogniser/templates; only the visible client scene and rays are fixtures.
function scene(n = 30) {
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0, 40, 0) }; bot.health = 20; bot.entities = {}
  bot.registry = { blocksByName: { basalt: { id: 1 }, gold_block: { id: 2 }, chest: { id: 3 } } }
  let reads = 0
  bot.blockAt = p => { reads++; return { name: 'basalt', position: p, boundingBox: 'block' } }
  const seen = Array.from({ length: n }, (_, i) => ({ position: new Vec3(i % 10, 40 + Math.floor(i / 10), 5) }))
  const load = (relative, mocks: Record<string, any>, expose = '') => {
    const file = path.resolve(__dirname, '../src', relative + '.ts')
    const mod: any = new Module(file, module)
    mod.filename = file; mod.paths = module.paths
    const raw = mod.require.bind(mod)
    mod.require = name => name in mocks ? mocks[name] : raw(name)
    mod._compile(transformSync(fs.readFileSync(file, 'utf8') + expose, { loader: 'ts', format: 'cjs' }).code, file)
    return mod.exports
  }
  const bp = load('bastion-pieces', { './sight': { seesBlock: () => true } })
  const pg = load('bastion/predict-gold', {
    './take-gold-block': { visibleOf: (_bot, ids) => ids.includes(1) ? seen : [], log: () => {}, xyz: v => ({ x: v.x, y: v.y, z: v.z }) },
    '.././bastion-pieces': bp
  })
  return { bot, pg, bp, load, reads: () => reads }
}

test('survey processes queued native events before the recognition completes', async () => {
  const { bot, pg } = scene()
  let eventHandled = false
  setImmediate(() => { eventHandled = true })
  await (pg.predictGoldAsync ? pg.predictGoldAsync(bot) : pg.predictGold(bot))
  assert.equal(eventHandled, true, 'synchronous voting starves incoming threat packets')
})

test('cooperative and synchronous recognition use identical votes and verification', async () => {
  const { bot, pg } = scene(8)
  const random = Math.random; Math.random = () => 0.25
  try { assert.deepEqual(await pg.predictGoldAsync(bot), pg.predictGold(bot)) } finally { Math.random = random }
  assert.equal(bot.listenerCount('end'), 0)
})

test('queued cancellation stops recognition before it reads the world', async () => {
  const { bot, pg, reads } = scene()
  const ctl = { aborted: false }
  setImmediate(() => { ctl.aborted = true })
  await assert.rejects(pg.predictGoldAsync(bot, 56, ctl), /прерван/)
  assert.equal(reads(), 0)
  assert.equal(bot.listenerCount('end'), 0)
})

for (const cause of ['end', 'death']) test(`survey stops on ${cause} with a frozen game clock`, async () => {
  const { bot, pg } = scene()
  setImmediate(() => cause === 'end' ? bot.emit('end') : (bot.health = 0))
  await assert.rejects(pg.predictGoldAsync(bot), /прерван/)
  assert.equal(bot.listenerCount('end'), 0)
})

test('recognition honours the higher reflex owner before continuing its work', async () => {
  const { bot, pg, reads } = scene(2)
  let waited = 0
  const ctl = { aborted: false, waitReflex: async () => { waited++; ctl.aborted = true } }
  await assert.rejects(pg.predictGoldAsync(bot, 56, ctl), /прерван/)
  assert.equal(waited, 1); assert.equal(reads(), 0)
})

test('cancellation arriving during the vote stops before the next observed block', async () => {
  const { bot, pg, bp } = scene(80)
  const ctl = { aborted: false }
  const raw = bp.voteByBasaltSteps
  let batches = 0
  bp.voteByBasaltSteps = function * (...args) {
    for (const step of raw(...args)) {
      batches++
      setImmediate(() => { ctl.aborted = true })
      yield step
    }
  }
  await assert.rejects(pg.predictGoldAsync(bot, 56, ctl), /прерван/)
  assert.equal(batches, 1)
  assert.equal(bot.listenerCount('end'), 0)
})

test('tower survey awaits packet-responsive recognition before building the next level', async () => {
  const { bot, load } = scene(1)
  bot.blockAt = p => ({ name: 'air', boundingBox: 'empty', position: p })
  let climbed = 0; let scanned = 0
  const ctl = { aborted: false }
  const ts = load('bastion/tower-scan', {
    './take-gold-block': { gameClock: { now: () => 0 }, log: () => {}, Vec3 },
    './booth-trade': {},
    './predict-gold': {
      // This is the old synchronous call path: it would start towerUp instead.
      predictGold: () => ({ direct: [], walls: [], start: null }),
      predictGoldAsync: async (_bot, _radius, sameCtl) => {
        assert.equal(sameCtl, ctl); scanned++
        await new Promise<void>(resolve => setImmediate(resolve))
        ctl.aborted = true
        throw new Error('обзор бастиона прерван')
      }
    },
    '.././build': { towerUp: async () => { climbed++; ctl.aborted = true; return { placed: 1 } } },
    '.././sealed': { fillerCount: () => 64 }
  })
  await assert.rejects(ts.towerScan({ bot }, ctl, {}), /прерван/)
  assert.equal(scanned, 1); assert.equal(climbed, 0)
})

test('bounded voting top exactly preserves descending order and stable ties', () => {
  const { load } = scene(1)
  const bp = load('bastion-pieces', {}, '\nmodule.exports.topVotesSteps = topVotesSteps')
  const votes = new Map(Array.from({ length: 5000 }, (_, i) => [`candidate-${i}`, (i * 37) % 23]))
  for (const top of [0, 1, 10, 12, 12.5, -1, Infinity, NaN, 5001]) {
    const steps = bp.topVotesSteps(votes, top)
    let next = steps.next(); let yields = 0
    while (!next.done) { yields++; next = steps.next() }
    assert.deepEqual(next.value, [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, top))
    if (next.value.length) assert.ok(yields > 0)
  }
})

test('live read-only scan awaits the same cooperative recogniser and preserves its report', async () => {
  const { bot, pg } = scene(8)
  const random = Math.random; Math.random = () => 0.25
  try { assert.deepEqual(await pg.scanPiecesAsync(bot), pg.scanPieces(bot)) } finally { Math.random = random }
  const ctl = { aborted: false }
  setImmediate(() => { ctl.aborted = true })
  await assert.rejects(pg.scanPiecesAsync(bot, 48, ctl), /прерван/)
  assert.equal(bot.listenerCount('end'), 0)
})

test('actual bastion scan RPC passes its controller and awaits the scan result', async () => {
  // bastion() — оркестр в bastion/bastion.ts; состояние вызова — openRun, итог — report (bastion/run.ts).
  const body = declSource(path.resolve(__dirname, '../src/bastion/bastion.js'), 'bastion') + '\n' +
    declSource(path.resolve(__dirname, '../src/bastion/run.js'), 'openRun', 'report')
  assert.match(body, /mode === ["']scan["']/)
  let queried = 0
  const scan = { proof: 'completed result' }; const bot = {}; const ctl = { aborted: false }
  const scanPiecesAsync = async (sameBot, radius, sameCtl) => {
    assert.equal(sameBot, bot); assert.equal(radius, 37); assert.equal(sameCtl, ctl)
    await new Promise<void>(resolve => setImmediate(resolve)); queried++; return scan
  }
  const call = new Function('require', 'gameClock', 'clamp', 'countOf', 'fireRes', 'BF', 'worlds', 'scanPiecesAsync', 'goldMode',
    body + '\nreturn bastion')(
    () => ({}), { now: () => 0 }, v => v, () => 0, () => 0, { enabled: () => false }, { worldOf: () => 'the_nether' }, scanPiecesAsync,
    { fastSafe: false })
  const result = await call({ bot }, ctl, { mode: 'scan', radius: 37 })
  assert.equal(queried, 1); assert.equal(result.scan, scan)
})

for (const cause of ['end', 'death', 'abort']) test(`${cause} settles a survey waiting for a frozen reflex lease`, async () => {
  const { bot, pg, reads } = scene(1)
  let entered = false
  const ctl = { aborted: false, onAbort: [] as (() => void)[], waitReflex: () => { entered = true; return new Promise<void>(() => {}) } }
  const task = pg.predictGoldAsync(bot, 56, ctl)
  while (!entered) await new Promise<void>(resolve => setImmediate(resolve))
  if (cause === 'abort') { ctl.aborted = true; for (const fn of ctl.onAbort) fn() } else bot.emit(cause)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await assert.rejects(Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('reflex still pending')), 100) })]), /прерван/)
  } finally { clearTimeout(timer) }
  assert.equal(reads(), 0); assert.equal(ctl.onAbort.length, 0)
  assert.equal(bot.listenerCount('end'), 0); assert.equal(bot.listenerCount('death'), 0)
})

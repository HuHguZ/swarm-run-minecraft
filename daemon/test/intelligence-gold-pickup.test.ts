import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import * as esbuild from 'esbuild'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
type Vector = import('vec3').Vec3
const sourceRequire = (require('node:module') as typeof import('node:module')).createRequire(path.join(__dirname, '../src/sealed.ts'))
const sealedModule = { exports: {} }
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(__dirname, '../src/sealed.ts'), 'utf8'),
  { loader: 'ts', format: 'cjs', target: 'node24' }).code,
cjsContext({ module: sealedModule, require: sourceRequire, process, console, setImmediate, performance, Buffer }))
const realSealed = sealedModule.exports as {
  bodyCells(bot: { entity: { position: Vector; onGround?: boolean } }): Vector[]
  keyV(at: Vector): string
  AIR: number
  classOf(block: unknown): number
}

function goldAttempt(options: { threat?: boolean; noDrop?: boolean; fullBag?: boolean; foreign?: boolean; abort?: boolean; takeover?: boolean; opens?: boolean; emptyOwn?: boolean; unknownBody?: boolean; unsafeFloor?: boolean } = {}) {
  // sealedGold живёт в bastion/sealed-gold.ts.
  const source = fs.readFileSync(path.join(__dirname, '../src/bastion/sealed-gold.ts'), 'utf8')
  const start = source.indexOf("    const had = countOf(bot, 'gold_block')", source.indexOf('async function sealedGold'))
  const end = source.indexOf("    log('штрек: золото',", start)
  assert.ok(start >= 0 && end > start)
  const events: string[] = []; let slept = 0; let gold = 0; let collected = 0
  const ctl = { aborted: false }
  const target = new Vec3(1002, 63, 1002)
  const feet = new Vec3(1002.5, 61, 1002.5)
  const drop = { id: 20, e: { position: new Vec3(1002.3652, 63.5, 1002.8016) },
    stack: { name: 'gold_block', count: 1 }, rest: { x: 1002.3652, y: 61, z: 1002.8016 } }
  let spawned = false; let filled = false
  const blockAt = (p: Vector) => {
    if (options.unknownBody && p.y === 62) return null
    if (options.unsafeFloor && p.y === 60) return { name: 'lava', boundingBox: 'empty', shapes: [] }
    const air = p.y === 61 || p.y === 62 || (p.y === 63 && !filled)
    return { name: air ? 'air' : 'blackstone', boundingBox: air ? 'empty' : 'block', shapes: air ? [] : [[0, 0, 0, 1, 1, 1]] }
  }
  const bot = { health: 20, entity: { position: feet }, game: { dimension: 'the_nether' },
    setControlState() {}, blockAt }
  const session = { bot, reflex: null as object | null }
  const S = { own: new Set(options.emptyOwn ? [] : ['1002,61,1002', '1002,62,1002']), fills: 0, exposed: false, fails: [] as string[] }
  const st = { fastSafe: true, pred: new Map([[target.toString(), { rank: 0 }]]), blocks: 0, sealedState: S }
  const keyV = (p: Vector) => `${p.x},${p.y},${p.z}`
  const drops = {
    pickupMark: () => ({ sequence: 0 }), pickupDelta: () => ({ gold_block: collected }),
    inPickup: (at: Vector, item: typeof drop.rest) => Math.abs(at.x - item.x) < 1.4 && Math.abs(at.z - item.z) < 1.4 && Math.abs(at.y - item.y) < 2.3,
    lying: () => spawned && !options.noDrop && !filled ? [drop] : [],
    async collect(_bot: typeof bot, _ctl: typeof ctl, config: { allowMovement: boolean; canContinue: () => boolean; onStack: (item: typeof drop) => Promise<string> }) {
      events.push('collect')
      assert.equal(filled, false, 'server pickup must precede the placement that ejects the item')
      assert.equal(config.allowMovement, false, 'no courtyard pathfinder or nudge for a sealed gold pickup')
      if (!config.canContinue() || await config.onStack(drop) === 'skip') return 0
      if (options.abort) { ctl.aborted = true; return 0 }
      if (options.takeover) { session.reflex = {}; return 0 }
      if (options.foreign) return 0
      gold++; collected++; events.push('self receipt'); return 1
    }
  }
  const sealed = { ...realSealed, exposure: () => [{}],
    async digCell() { events.push('dig'); spawned = true; return 'ok' },
    async fillCell() { events.push('fill'); filled = true; return true } }
  const context = { bot, session, ctl, st, S, t: { k: keyV(target), pos: target }, hit: { rank: 0 }, SL: sealed,
    opens: options.opens !== false, dimension: 'the_nether',
    gameClock: { now: () => 1000 }, countOf: () => gold,
    foesNear: () => options.threat ? [{ name: 'piglin_brute' }] : [],
    sleep: async (ms: number) => { slept += ms }, pickUp: async () => { throw new Error('unrestricted pickup') },
    hunker: async () => false, log() {},
    require: (name: string) => {
      if (name === '.././drops') return drops
      if (name === '.././pack') return { fits: () => !options.fullBag }
      if (name === '.././ne-guard') return { hot: () => options.threat ? { why: 'brute' } : null }
      if (name === '.././sealed') return sealed
      throw new Error('unexpected dependency: ' + name)
    }
  }
  const sharedSource = fs.readFileSync(path.join(__dirname, '../src/bastion/take-gold-block.ts'), 'utf8')
  const ownStart = sharedSource.indexOf('function inOwnTunnel (')
  const ownEnd = sharedSource.indexOf('\n}', ownStart) + 2
  const coverStart = sharedSource.indexOf('function fullCover (')
  const coverEnd = sharedSource.indexOf('\n}', coverStart) + 2
  assert.ok(ownStart >= 0 && coverStart >= 0)
  const body = `${sharedSource.slice(ownStart, ownEnd)}\n${sharedSource.slice(coverStart, coverEnd)}\nasync function attempt() { for (let attempt = 0; attempt < 1; attempt++) { ${source.slice(start, end)} } } attempt()`
  const run = () => vm.runInNewContext(esbuild.transformSync(body, { loader: 'ts', format: 'cjs', target: 'node24' }).code, cjsContext(context))
  return { run, events, slept: () => slept, gold: () => gold, S, ctl }
}

test('stationary pickup uses the exported real sealed body helper including partial support feet', () => {
  assert.equal(typeof realSealed.bodyCells, 'function')
  for (const [height, onGround, expected] of [[61, true, 61], [60.875, true, 61], [60.875, false, 60]] as const) {
    const cells = realSealed.bodyCells({ entity: { position: new Vec3(1002.5, height, 1002.5), onGround } })
    assert.deepEqual(Array.from(cells, cell => [cell.x, cell.y, cell.z]), [[1002, expected, 1002], [1002, expected + 1, 1002]])
  }
})

test('sealed head gold confirms self pickup before either closing path without walking outside', async () => {
  for (const opens of [true, false]) {
    const f = goldAttempt({ opens }); await f.run()
    assert.equal(f.gold(), 1)
    assert.ok(f.events.indexOf('self receipt') < f.events.indexOf('fill'))
  }
})

test('zero-move gold approach keeps the planner implicit current body available to stationary pickup', async () => {
  const f = goldAttempt({ emptyOwn: true, opens: false }); await f.run()
  assert.equal(f.gold(), 1, 'SL.execute([]) leaves own empty; current loaded AIR body is still the validated zero-move start')
  assert.ok(f.events.indexOf('self receipt') < f.events.indexOf('fill'))
  assert.deepEqual([...f.S.own], [], 'pickup must not adopt an unrelated open chamber into tunnel ownership')
})

test('implicit current body needs actual loaded AIR and a firm support before stationary pickup', async () => {
  for (const options of [{ unknownBody: true }, { unsafeFloor: true }]) {
    const f = goldAttempt({ ...options, emptyOwn: true }); await f.run()
    assert.equal(f.gold(), 0)
    assert.equal(f.events.includes('collect'), false)
  }
})

test('obvious pressure or no actual drop does not lengthen the exposed gold closing window', async () => {
  for (const options of [{ threat: true }, { noDrop: true }]) {
    const f = goldAttempt(options); await f.run()
    assert.equal(f.gold(), 0)
    assert.equal(f.events.includes('collect'), false)
    assert.equal(f.slept(), 0)
    assert.ok(f.events.includes('fill'))
  }
})

test('full inventory and another collector never become a credited gold pickup', async () => {
  for (const options of [{ fullBag: true }, { foreign: true }]) {
    const f = goldAttempt(options); await f.run()
    assert.equal(f.gold(), 0)
    assert.ok(f.S.fails.some(reason => /подбор/.test(reason)))
  }
})

test('cancelled gold pickup does not resume a stale placement intent', async () => {
  for (const options of [{ abort: true }, { takeover: true }]) {
    const f = goldAttempt(options); await f.run()
    if (options.abort) assert.equal(f.ctl.aborted, true)
    assert.equal(f.events.includes('fill'), false)
  }
})

function stationaryCollector({ foreign = false, distant = false, cancel = false } = {}) {
  let now = 1000; let gold = 0; let goals = 0; let moved = 0
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(), registry: { entitiesByName: { item: { id: 71 } }, itemsByName: { gold_block: { id: 1 } } },
    entity: { id: 1, position: new Vec3(1002.5, 61, 1002.5) }, entities: {} as Record<number, unknown>,
    clearControlStates() {}, setControlState(_name: string, enabled: boolean) { if (enabled) moved++ },
    look: async () => { moved++ },
    blockAt: (p: Vector) => p.y >= 61 && p.y <= 63 && p.x === 1002 && p.z === 1002
      ? { name: 'air', shapes: [], boundingBox: 'empty' }
      : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block' },
    pathfinder: { goal: null, setGoal(goal: unknown) { if (goal) goals++ }, isMoving: () => false }
  })
  const entity = { id: 20, name: 'item', position: new Vec3(distant ? 1007.5 : 1002.3652, distant ? 61 : 63.5, 1002.8016),
    getDroppedItem: () => ({ name: 'gold_block', count: 1 }) }
  bot.entities[20] = entity
  let drops: { install(bot: unknown): unknown; inPickup(feet: Vector, item: Vector): boolean;
    collect(bot: unknown, ctl: unknown, options: unknown): Promise<number>; pickupMark(bot: unknown): unknown;
    pickupDelta(bot: unknown, mark: unknown): Record<string, number> | null }
  const clock = { now: () => now, wall: { monotonic: () => now }, setTimeout(callback: () => void, ms: number) {
    return setImmediate(() => {
      now += ms
      bot.emit('physicsTick')
      if (cancel) ctl.aborted = true
      if (now >= 1500 && bot.entities[20] && drops.inPickup(bot.entity.position, entity.position)) {
        bot._client.emit('collect', { collectorEntityId: foreign ? 2 : 1, collectedEntityId: 20, pickupItemCount: 1 })
        bot.emit('playerCollect', foreign ? { id: 2 } : bot.entity, entity)
        if (!foreign) gold++
        delete bot.entities[20]
      }
      callback()
    })
  } }
  const context = { module: { exports: {} }, process, console, Buffer, require: (name: string) => name === './game-clock' ? clock : require(name) }
  const source = fs.readFileSync(path.join(__dirname, '../src/drops.ts'), 'utf8')
  vm.runInNewContext(esbuild.transformSync(source, { loader: 'ts', format: 'cjs', target: 'node24' }).code, cjsContext(context))
  drops = context.module.exports as typeof drops
  const mark = drops.pickupMark(bot)
  return { ctl, run: () => drops.collect(bot, ctl, { radius: 8, timeoutMs: 1500, appearMs: 0, allowMovement: false }),
    delta: () => drops.pickupDelta(bot, mark), gold: () => gold, goals: () => goals, moved: () => moved }
}

test('stationary common collector waits for the falling head drop and real self collect without movement', async () => {
  const f = stationaryCollector()
  assert.equal(await f.run(), 1)
  assert.equal(f.gold(), 1)
  assert.equal(f.delta()?.gold_block, 1)
  assert.equal(f.goals(), 0)
  assert.equal(f.moved(), 0)
})

test('stationary common collector refuses distant loot, foreign collection and cancellation', async () => {
  for (const options of [{ distant: true }, { foreign: true }, { cancel: true }]) {
    const f = stationaryCollector(options)
    assert.equal(await f.run(), 0)
    assert.equal(f.gold(), 0)
    assert.equal(f.delta()?.gold_block || 0, 0)
    assert.equal(f.goals(), 0)
    assert.equal(f.moved(), 0)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import Module from 'node:module'
const Vec3 = require('vec3'), esbuild = require('esbuild')
const src = path.resolve(__dirname, '../src')

function sourceModule(name: string, overrides: Record<string, any> = {}) {
  const file = path.join(src, name + '.ts'), local = Module.createRequire(file), mod = { exports: {} as any }
  const text = esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  new vm.Script(Module.wrap(text), { filename: file }).runInThisContext()(mod.exports,
    (id: string) => id in overrides ? overrides[id] : local(id), mod, file, path.dirname(file))
  return mod.exports
}

function boxScene(options: any = {}) {
  let at = 0
  const calls: string[] = [], cell = new Vec3(0, 10, 0), cells = new Map<string, any>()
  const block = (p: any, solid: boolean) => ({ position: p, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] })
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) for (let y = 8; y <= 15; y++) {
    const p = new Vec3(x, y, z); cells.set(p.toString(), block(p, y < 10 || Math.abs(x) + Math.abs(z) === 1 && y < 12))
  }
  const ctl: any = { aborted: !!options.aborted, onAbort: [] }
  const bot: any = { health: options.dead ? 0 : 20, entity: { id: 1, position: cell.offset(.53, 0, .53), onGround: true, width: .6, height: 1.8 },
    entities: {}, blockAt: (p: any) => cells.get(p.floored().toString()), pathfinder: { setGoal() {} }, look: async () => {}, lookAt: async () => {},
    setControlState() {}, clearControlStates() {} }
  const zombie = { id: 2, name: options.kind || 'zombie', position: bot.entity.position.offset(options.outside ? 1.5 : -.2, options.above ? 2 : 0, -.2), width: .6, height: 1.95,
    isValid: !options.invalid, _ndVisible: !options.unseen }
  if (!options.arrivesDuringBuild && !options.noMob) bot.entities[2] = zombie
  const session: any = { bot, current: { name: 'refuge', ctl } }
  const build = sourceModule('build'), pick = sourceModule('pick'), realFortify = sourceModule('fortify')
  const fortify = { ...realFortify,
    refugeNeed: (b: any, p: any) => options.noCube ? null : realFortify.refugeNeed(b, p),
    refugeBox: async (_b: any, p: any) => { calls.push('roof'); if (options.arrivesDuringBuild) bot.entities[2] = zombie; return { cell: p, placed: 0, plan: [], ...realFortify.enclosure(bot, p) } },
    refugePatch: async () => { calls.push('patch'); return 0 }, sinkRoof: async () => { calls.push('sink'); return null } }
  const hold = sourceModule('survival/hold-out', {
    './surface-body': { ...require('../src/survival/surface-body') },
    './enter-shelter': { gameClock: { now: () => at }, sleep: async (ms: number) => { at += ms }, occupiedByEntity: build.occupiedByEntity,
      worlds: { worldOf: () => 'overworld' } },
    '.././fortify': fortify, '.././flee': { hostilesAround: () => Object.values(bot.entities).map((e: any) => ({ e, d: e.position.distanceTo(bot.entity.position) })) },
    '.././pick': pick, '../pick': pick,
    '../combat': { liveAttacker: () => options.knownHurt ? zombie : null }, '../ne-guard': { aggressive: () => false }
  })
  const target = options.fallback ? cell.offset(1, 0, 1) : cell
  return { bot, cell, calls, ctl, run: () => hold.takeBox(session, ctl, { cell: { cell: target, dist: options.fallback ? 1.4 : 0 }, blocks: 7,
    nearest: { name: zombie.name } }, () => {}) }
}

for (const options of [{}, { fallback: true }, { arrivesDuringBuild: true }, { unseen: true, knownHurt: true }]) test(`actual box admission detects an interior hostile ${JSON.stringify(options)}`, async () => {
  const f = boxScene(options), result = await f.run()
  assert.equal(result?.intruder, 'zombie')
  assert.equal(result.cell.equals(f.cell), true, 'use the actual body cell after approach/fallback')
  assert.deepEqual(f.calls, options.arrivesDuringBuild ? ['roof'] : [], 'no roof/patch/floor dig once an interior hostile is known')
  assert.equal(f.bot.entity.position.y, 10)
})

for (const options of [{ noMob: true }, { outside: true }, { above: true }, { unseen: true }, { invalid: true }, { kind: 'piglin' }, { kind: 'enderman' }]) test(`other refuge contacts keep their existing build ${JSON.stringify(options)}`, async () => {
  const f = boxScene(options), result = await f.run()
  assert.equal(result?.intruder, undefined)
  assert.ok(f.calls.includes('roof'))
})

for (const options of [{ aborted: true }, { dead: true }]) test(`a stopped body does not enter a box build ${JSON.stringify(options)}`, async () => {
  const f = boxScene(options)
  assert.equal(await f.run(), null)
  assert.deepEqual(f.calls, [])
})

test('an invalid refuge cell cannot produce an interior-box escape receipt', async () => {
  const f = boxScene({ noCube: true })
  const result = await f.run()
  assert.equal(result?.intruder, undefined)
})

function callerScene({ exit = true, abortedOnExit = false, fled = true } = {}) {
  const calls: string[] = [], cell = new Vec3(0, 10, 0), ctl: any = { aborted: false, onAbort: [] }
  const bot: any = { health: 17, food: 20, entity: { position: cell.offset(.5, 0, .5) }, pathfinder: { setGoal() {} } }
  const session: any = { bot, current: { name: 'refuge', ctl }, journal: { append() {} } }
  const look = { blocks: 7, cell: { cell, blocks: 1 }, canBreakOut: true, foes: 1, nether: true }
  const body = sourceModule('survival/refuge-body', {
    './hold-out': { refugeLook: () => look, lookLine: () => '', chooseRefuge: () => ({ how: 'box' }), outrun: () => false,
      refugeFoe: () => true, takeBox: async () => { calls.push('admission'); assert.equal(session._refugeBuild, ctl); return { cell, placed: 0, intruder: 'zombie' } },
      holdOut: async () => { calls.push('hold'); return { why: 'healed', ate: [] } },
      leaveBox: async (_s: any, _c: any, b: any, hold: any) => { calls.push('exit'); assert.equal(session._refugeBuild, undefined); assert.equal(b.cell, cell); assert.equal(hold.why, 'breached'); ctl.aborted = abortedOnExit; return { ok: exit } } },
    './surface-body': {}, './enter-shelter': { worlds: { worldOf: () => 'overworld' }, xyz: (p: any) => ({ x: p.x, y: p.y, z: p.z }), gameClock: { now: () => 1000 } },
    '.././fortify': { landed: async () => {}, enclosure: () => ({ sealed: true }) }, '.././items': { bestWeapon: () => null },
    '.././flee': { hostilesAround: () => [], smartFlee: async () => { calls.push('flee'); assert.equal(session._refugeBuild, undefined); return { mode: fled ? 'оторвался' : 'не отрывается', ran: fled ? 8 : 0 } } }
  })
  return { calls, ctl, session, run: () => body.refugeBody(session, ctl, { t0: 1000, minHp: 16, deadline: 30000,
    out: { how: 'none', code: 'OK', hp0: 20, steps: [], stayIn: true }, step() {}, hurts: [] }) }
}

test('the actual refuge caller releases construction then opens the occupied box and flees', async () => {
  const f = callerScene(), r = await f.run()
  assert.deepEqual(f.calls, ['admission', 'exit', 'flee'])
  assert.equal(r.code, 'OK'); assert.equal(r.stayed, undefined); assert.equal(f.session._refugeBuild, undefined)
})
for (const options of [{ exit: false }, { abortedOnExit: true }, { fled: false }]) test(`an unconfirmed occupied-box exit never claims safety ${JSON.stringify(options)}`, async () => {
  const f = callerScene(options), r = await f.run()
  assert.deepEqual(f.calls, options.exit === false || options.abortedOnExit ? ['admission', 'exit'] : ['admission', 'exit', 'flee'])
  assert.notEqual(r.code, 'OK'); assert.equal(r.stayed, undefined); assert.equal(f.session._refugeBuild, undefined)
})

function exitScene(stop: string = '', niche = false) {
  const calls: string[] = [], cell = new Vec3(0, 10, 0), ctl: any = { aborted: false }
  const bot: any = { health: 20, entity: { position: cell.offset(.5, 0, .5) },
    blockAt: (p: any) => ({ position: p, boundingBox: 'block', name: 'cobblestone' }),
    lookAt: async () => { calls.push('look'); if (stop === 'look') ctl.aborted = true },
    setControlState: (key: string, value: boolean) => { if (value) calls.push(key) } }
  const fortify = sourceModule('fortify', {
    './tools': { bestFor: () => ({ ms: 750 }), breakFast: async (_b: any, p: any) => {
      calls.push(p.y === 11 ? 'head' : 'feet')
      if (stop === 'head' && p.y === 11 || stop === 'feet' && p.y === 10) ctl.aborted = true
      if (stop === 'death' && p.y === 11) bot.health = 0
      return { ok: true }
    } }, './walkable': { standable: () => true }
  })
  const hold = sourceModule('survival/hold-out', {
    './surface-body': {}, './enter-shelter': { sleep: async () => {}, exitShelter: async () => { calls.push('up'); return { out: true } } },
    '.././fortify': fortify, '.././flee': { hostilesAround: () => [] }
  })
  return { calls, run: () => hold.leaveBox({ bot }, ctl, { cell, ...(niche ? { front: cell.offset(1, 0, 0) } : {}) }, { why: 'breached' }, () => {}) }
}

for (const stop of ['head', 'death']) test(`actual breakOut does not start the feet dig after ${stop}`, async () => {
  const f = exitScene(stop)
  assert.equal(await f.run(), null)
  assert.deepEqual(f.calls, ['head'], 'the current head dig may finish; no new dig, movement or fallback starts')
})
for (const stop of ['feet', 'look']) test(`actual occupied-box exit does not start movement after abort at ${stop}`, async () => {
  const f = exitScene(stop)
  assert.equal(await f.run(), null)
  assert.deepEqual(f.calls, stop === 'look' ? ['head', 'feet', 'look'] : ['head', 'feet'])
})
test('a niche exit also respects death between its two blocks', async () => {
  const f = exitScene('death', true)
  assert.equal(await f.run(), null)
  assert.deepEqual(f.calls, ['head'])
})
test('a live actual wall exit retains its two digs and movement', async () => {
  const f = exitScene()
  assert.equal((await f.run()).ok, true)
  assert.deepEqual(f.calls, ['head', 'feet', 'look', 'forward'])
})

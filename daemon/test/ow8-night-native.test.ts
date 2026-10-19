import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { Vec3 } from 'vec3'
import { cjsContext } from './cjs-context'
import { transformSync } from 'esbuild'

test('C8 bucket reach-only mode never gives pathfinder a hidden walking job; default still approaches', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/obsidian.ts'), 'utf8')
  let walks = 0
  const ctx: any = { REACH: 4.5, countOf: (b, name) => name === 'bucket' ? 1 : 0,
    visibleSources: () => [{ position: new Vec3(9, 40, 0) }], eye: () => new Vec3(.5, 41.62, .5),
    goals: { GoalNear: class {} }, walk: async () => { walks++; return false } }
  vm.runInNewContext(transformSync(source.slice(source.indexOf('async function fillBucket ('), source.indexOf('\nasync function breachWall (')) + '\nthis.run=fillBucket', { loader: 'ts' }).code, cjsContext(ctx))
  const session = { bot: {} }, ctl = { aborted: false }
  assert.match((await ctx.run(session, ctl, { walk: false })).stopped, /отдельный подход/)
  assert.equal(walks, 0)
  await ctx.run(session, ctl, {})
  assert.equal(walks, 1)
})

test('C8 shelter box and light modes never dig a hole or choose a new refuge location', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/survival/enter-shelter.ts'), 'utf8'), calls: string[] = []
  const ctx: any = { boxShelter: async () => { calls.push('box'); return { sealed: true } },
    lightNiche: async () => { calls.push('light'); return true },
    enterShelter: () => { throw Error('must not dig') }, exitShelter: () => { throw Error('must not leave') } }
  const start = source.indexOf('async function shelter (')
  vm.runInNewContext(transformSync(source.slice(start, source.indexOf('\nasync function enterShelter (', start)) + '\nthis.run=shelter', { loader: 'ts' }).code, cjsContext(ctx))
  assert.equal((await ctx.run({ bot: {} }, {}, { mode: 'box' })).sealed, true)
  assert.equal((await ctx.run({ bot: {} }, {}, { mode: 'light' })).torch, true)
  assert.deepEqual(calls, ['box', 'light'])
  ctx.boxShelter = async () => null
  assert.equal((await ctx.run({ bot: {} }, {}, { mode: 'box' })).sealed, false)
})

test('C8 native vertical guard rechecks the opened world, rather than running the entire climb', async () => {
  const { shaftUp }: typeof import('../src/mining') = require('../src/mining'), B: typeof import('../src/build') = require('../src/build'), old = B.digUp
  let digs = 0
  const bot: any = { entity: { position: new Vec3(.5, 16, .5) }, health: 20, entities: {},
    inventory: { items: () => [], slots: [] }, blockAt: p => ({ name: p.y >= bot.entity.position.y && p.y < bot.entity.position.y + 2 ? 'air' : 'stone',
      boundingBox: p.y >= bot.entity.position.y && p.y < bot.entity.position.y + 2 && (digs || p.x === 0 && p.z === 0) ? 'empty' : 'block', light: 0, skyLight: 0 }) }
  B.digUp = async () => { digs++; bot.entity.position = bot.entity.position.offset(0, 1, 0); return {} as any }
  try {
    const r = await shaftUp({ bot, mcData: {} }, { aborted: false, onAbort: [] }, { length: 8, nightWork: true })
    assert.equal(digs, 1, 'one physical level opened the cave; no further tower step')
    assert.match(r.stopped, /NIGHT_RISK/)
  } finally { B.digUp = old }
})

test('C8 telemetry records real local light, floor and closure for the next paired scenes', () => {
  const T: typeof import('../src/telemetry') = require('../src/telemetry')
  const work = { block: 0, sky: 0, walls: 3, roof: true, floor: true, sealed: false }
  assert.deepEqual(T.snapshot({}, { work }).work, work)
  assert.equal(Object.hasOwn(T.snapshot({}, {}), 'work'), false)
})

function diggingBody(cave = false) {
  const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11'), world = new Map<string, string>(), key = p => `${p.x},${p.y},${p.z}`
  for (const y of [40, 41]) world.set(`0,${y},0`, 'air')
  if (cave) for (const y of [40, 41, 42]) for (const z of [-1, 0, 1]) world.set(`1,${y},${z}`, 'air')
  const items = [{ ...data.itemsByName.stone_pickaxe, count: 1, durabilityUsed: 0 }, { ...data.itemsByName.cobblestone, count: 64 }]
  let aim: any
  const bot: any = { health: 20, food: 20, entities: {}, game: { dimension: 'overworld' }, time: { timeOfDay: 18000 },
    entity: { position: new Vec3(.5, 40, .5), onGround: true, height: 1.8 }, heldItem: items[0],
    inventory: { items: () => items, slots: [] }, pathfinder: { setGoal() {} },
    blockAt: p => { const name = world.get(key(p)) || 'stone'; return { ...data.blocksByName[name], name, position: p,
      boundingBox: name === 'air' ? 'empty' : 'block', light: 0, skyLight: 0, digTime: () => 0 } },
    dig: async b => world.set(key(b.position), 'air'), equip: async item => { bot.heldItem = item },
    lookAt: async p => { aim = p }, clearControlStates() {}, stopDigging() {}, findBlocks: () => [], nearestEntity: () => null,
    setControlState(name, on) { if (name !== 'forward' || !on) return
      const x = Math.floor(aim.x), z = Math.floor(aim.z); let y = Math.floor(bot.entity.position.y)
      while (world.get(`${x},${y - 1},${z}`) === 'air') y--
      bot.entity.position = new Vec3(x + .5, y, z + .5)
    } }
  return { bot, world, key, session: { bot, mcData: data, cfg: { fairPlay: false }, journal: { state: {}, append() {} } }, ctl: { aborted: false, onAbort: [] } }
}
for (const stairs of [false, true]) {
  test(`C8 real ${stairs ? 'staircase' : 'tunnel'} closes behind each delivered step and keeps the existing dig/move loop`, async () => {
    const f = diggingBody(), B: typeof import('../src/build') = require('../src/build'), old = B.placeBlockAt
    B.placeBlockAt = async (bot, p) => { assert.notDeepEqual(bot.entity.position.floored(), p, 'do not wall in the standing body'); f.world.set(f.key(p), 'cobblestone'); return { ok: true } }
    try {
      const r: any = stairs ? await (require('../src/actions') as typeof import('../src/actions')).digStairs(f.session, f.ctl, { depth: 2, direction: 'east', nightWork: true })
        : await (require('../src/mining') as typeof import('../src/mining')).tunnel(f.session, f.ctl, { length: 2, direction: 'east', nightWork: true })
      assert.equal(r.stopped, undefined)
      assert.equal(stairs ? r.steps : r.walked, 2)
      assert.equal(f.world.get('0,40,0'), 'cobblestone')
      assert.equal(f.world.get('0,41,0'), 'cobblestone')
    } finally { B.placeBlockAt = old }
  })
  test(`C8 real ${stairs ? 'staircase' : 'tunnel'} refuses a newly exposed dark cave before walking and closes the mouth`, async () => {
    const f = diggingBody(true), B: typeof import('../src/build') = require('../src/build'), old = B.placeBlockAt
    B.placeBlockAt = async (bot, p) => { f.world.set(f.key(p), 'cobblestone'); return { ok: true } }
    try {
      const r = stairs ? await (require('../src/actions') as typeof import('../src/actions')).digStairs(f.session, f.ctl, { depth: 2, direction: 'east', nightWork: true })
        : await (require('../src/mining') as typeof import('../src/mining')).tunnel(f.session, f.ctl, { length: 2, direction: 'east', nightWork: true })
      assert.match(r.stopped, /NIGHT_RISK/)
      assert.equal(f.bot.entity.position.x, .5)
      assert.equal(f.world.get('1,40,0'), 'cobblestone')
      assert.equal(f.world.get('1,41,0'), 'cobblestone')
    } finally { B.placeBlockAt = old }
  })
}

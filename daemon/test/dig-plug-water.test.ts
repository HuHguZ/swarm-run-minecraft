import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { digStairs } from '../src/actions/dig-down'
import { tunnel } from '../src/mining/drift'
import { faceAim } from '../src/pick'
import { plugBudget, plugVisibleLiquids, liquidSeen } from '../src/mining/dig-water'
const data = require('minecraft-data')('1.21.11')
const WorldSync = require('prismarine-world/src/worldsync')

function body() {
  const world = new Map<string, string>(), key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  for (const y of [40, 41]) world.set(`0,${y},0`, 'air')
  const items = [{ ...data.itemsByName.stone_pickaxe, type: data.itemsByName.stone_pickaxe.id, count: 1, durabilityUsed: 0 },
    { ...data.itemsByName.cobblestone, type: data.itemsByName.cobblestone.id, count: 64 }]
  const dug: string[] = [], placed: string[] = []; let aim: any
  const bot: any = {
    health: 20, food: 20, entities: {}, game: { dimension: 'overworld' }, registry: data,
    entity: { position: new Vec3(.5, 40, .5), onGround: true, height: 1.8, eyeHeight: 1.62 }, heldItem: items[0],
    inventory: { items: () => items.filter(i => i.count > 0), slots: [] }, pathfinder: { setGoal() {} },
    blockAt(p) { p = p.floored(); const name = world.get(key(p)) || 'stone', empty = /^(air|water|lava|bubble_column)$/.test(name)
      return { ...data.blocksByName[name], name, position: p, boundingBox: empty ? 'empty' : 'block',
        shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]], digTime: () => 0, getProperties: () => ({ level: 0 }) } },
    async dig(b) { assert.ok(!/water|lava/.test(b.name), 'never swing at fluid'); dug.push(key(b.position)); world.set(key(b.position), 'air') },
    async equip(item) { bot.heldItem = item }, async lookAt(p) { aim = p },
    async _placeBlockWithOptions(ref, face, opts) {
      assert.ok(faceAim(bot, ref.position, face), 'every packet has a visible reference face')
      if (opts.delta) assert.ok(aim.distanceTo(ref.position.plus(opts.delta)) < 1e-8, 'packet cursor matches visible aim')
      const p = ref.position.plus(face)
      placed.push(key(p)); world.set(key(p), bot.heldItem.name); bot.heldItem.count--
    },
    clearControlStates() {}, stopDigging() {}, findBlocks: () => [], nearestEntity: () => null,
    setControlState(name, on) { if (name !== 'forward' || !on) return
      const x = Math.floor(aim.x), z = Math.floor(aim.z); let y = Math.floor(bot.entity.position.y)
      while (world.get(`${x},${y - 1},${z}`) === 'air') y--
      bot.entity.position = new Vec3(x + .5, y, z + .5)
    }
  }
  bot.world = { getBlock: p => bot.blockAt(p), raycast: WorldSync.prototype.raycast }
  return { bot, world, key, dug, placed, items, session: { bot, mcData: data, cfg: { fairPlay: true }, journal: { state: {}, append() {} } }, ctl: { aborted: false, onAbort: [] } }
}
async function flag(value, run) {
  const old = process.env.ND_DIG_PLUG_WATER
  if (value == null) delete process.env.ND_DIG_PLUG_WATER; else process.env.ND_DIG_PLUG_WATER = value
  try { return await run() } finally { if (old == null) delete process.env.ND_DIG_PLUG_WATER; else process.env.ND_DIG_PLUG_WATER = old }
}
async function run(f, stairs) {
  return stairs ? digStairs(f.session, f.ctl, { depth: 1, direction: 'east', torchEvery: 0 })
    : tunnel(f.session, f.ctl, { length: 1, direction: 'east', torchEvery: 0 })
}
for (const stairs of [true, false]) {
  test(`K ${stairs ? 'stairs' : 'tunnel'}: flag off preserves pre-cut water refusal`, () => flag(undefined, async () => {
    const f = body(); f.world.set('2,41,0', 'water')
    const r: any = await run(f, stairs)
    assert.match(r.stopped, /вода/); assert.equal(f.dug.length, 0); assert.equal(f.placed.length, 0)
  }))
  test(`K ${stairs ? 'stairs' : 'tunnel'}: hidden water is opened, plugged honestly and work continues`, () => flag('1', async () => {
    const f = body(); f.world.set('2,41,0', 'water')
    const original = f.bot._placeBlockWithOptions
    f.bot._placeBlockWithOptions = async (...args) => { assert.ok(f.dug.includes('1,41,0'), 'water may be acted on only after exposing rock'); return original(...args) }
    const r: any = await run(f, stairs)
    assert.equal(r.stopped, undefined); assert.equal(stairs ? r.steps : r.walked, 1)
    assert.ok(f.placed.includes('2,41,0')); assert.equal(f.world.get('2,41,0'), 'cobblestone')
  }))
  test(`K ${stairs ? 'stairs' : 'tunnel'}: no blocks stops before entering exposed water`, () => flag('1', async () => {
    const f = body(); f.items[1].count = 0; f.world.set('2,41,0', 'water')
    const r: any = await run(f, stairs)
    assert.match(r.stopped, /вода.*обход|вода.*нечем/); assert.equal(f.bot.entity.position.x, .5); assert.equal(f.placed.length, 0)
  }))
  // 21.10 (ow): лава за камнем — отказ чутья, как без K: вскрытие невидимой лавы убивало (owKP-owA1-05, штрек в лаву на y16).
  test(`K ${stairs ? 'stairs' : 'tunnel'}: hidden lava still refuses the dig (x-ray safety only says no)`, () => flag('1', async () => {
    const f = body(); f.world.set('2,41,0', 'lava')
    const r: any = await run(f, stairs)
    assert.match(String(r.stopped), /лава/); assert.ok(!f.placed.includes('2,41,0'))
  }))
}

test('K tunnel: flowing water in the cut cell is filled then mined, not skipped as air', () => flag('1', async () => {
  const f = body(); f.world.set('1,41,0', 'water')
  const r: any = await run(f, false)
  assert.equal(r.stopped, undefined); assert.equal(r.walked, 1); assert.ok(f.placed.includes('1,41,0')); assert.ok(f.dug.includes('1,41,0'))
}))

test('K tunnel: refill is bounded and stops without walking into the reservoir', () => flag('1', async () => {
  const f = body(), dig = f.bot.dig
  f.world.set('1,41,0', 'water')
  f.bot.dig = async b => { await dig(b); if (f.key(b.position) === '1,41,0') f.world.set('1,41,0', 'water') }
  const r: any = await run(f, false)
  assert.match(r.stopped, /вода.*обход|вода.*бюджет/); assert.ok(f.placed.length <= 2); assert.equal(f.bot.entity.position.x, .5)
}))

test('K tunnel: cancellation during equipment sends no placement packet', () => flag('1', async () => {
  const f = body(); f.world.set('1,41,0', 'water')
  f.bot.equip = async item => { f.bot.heldItem = item; f.ctl.aborted = true }
  const r: any = await run(f, false)
  assert.equal(f.placed.length, 0); assert.equal(r.walked, 0)
}))

test('K stairs: water under an intact tread is exposed before plugging; no placement through the tread', () => flag('1', async () => {
  const f = body(); f.world.set('1,38,0', 'water')
  const original = f.bot._placeBlockWithOptions
  f.bot._placeBlockWithOptions = async (...args) => {
    assert.ok(f.dug.includes('1,39,0'), 'the tread has been cut before the support is plugged')
    return original(...args)
  }
  const r: any = await run(f, true)
  assert.equal(r.stopped, undefined); assert.equal(r.steps, 1); assert.ok(f.placed.includes('1,38,0'))
}))

test('K liquid visibility does not see water through opaque lava', () => flag('1', async () => {
  const f = body(); f.world.set('1,41,0', 'lava'); f.world.set('2,41,0', 'water')
  assert.equal(liquidSeen(f.bot, f.bot.blockAt(new Vec3(1,41,0))), true)
  assert.equal(liquidSeen(f.bot, f.bot.blockAt(new Vec3(2,41,0))), false)
  // 21.10: видимая лава не затыкается (обход), вода за ней не видна — ни одной установки.
  const why = await plugVisibleLiquids(f.bot, f.ctl, [new Vec3(1,41,0)], Date.now()+5000, plugBudget())
  assert.match(String(why), /лава/); assert.deepEqual(f.placed, [])
}))

test('K visible water with no reachable reference face returns an explicit bypass', () => flag('1', async () => {
  const f = body()
  for (let x=-2;x<=3;x++) for(let y=38;y<=43;y++) for(let z=-2;z<=2;z++) f.world.set(`${x},${y},${z}`, 'air')
  f.world.set('1,41,0', 'water')
  const why = await plugVisibleLiquids(f.bot, f.ctl, [new Vec3(1,41,0)], Date.now()+5000, plugBudget())
  assert.match(why, /обходи/); assert.equal(f.placed.length,0)
}))

for (const fluid of ['water', 'lava']) test(`K ${fluid}: planks are priced as filler only where they cannot burn`, () => flag('1', async () => {
  const f = body()
  Object.assign(f.items[1], { ...data.itemsByName.oak_planks, type: data.itemsByName.oak_planks.id, count: 64 })
  f.world.set('1,41,0', fluid)
  const why = await plugVisibleLiquids(f.bot, f.ctl, [new Vec3(1,41,0)], Date.now()+5000, plugBudget())
  if(fluid === 'water') { assert.equal(why,null); assert.equal(f.world.get('1,41,0'),'oak_planks') }
  else { assert.match(why,/обходи/); assert.equal(f.placed.length,0) }
}))

test('K unreachable source does not prevent plugging its actually observed reachable flow', () => flag('1', async () => {
  const f = body()
  f.world.set('1,41,0','water'); f.world.set('2,41,0','water')
  for(const p of ['2,40,0','2,42,0','3,41,0','2,41,1','2,41,-1']) f.world.set(p,'air')
  const why = await plugVisibleLiquids(f.bot, f.ctl, [new Vec3(1,41,0)], Date.now()+5000, plugBudget())
  assert.equal(why,null); assert.deepEqual(f.placed,['1,41,0'])
}))

test('K stairs: hidden water deeper than the open tread stays unknown to the landing judge', () => flag('1', async () => {
  const f=body();f.items[1].count=0
  for(let y=41;y>=37;y--)f.world.set(`1,${y},0`,'air')
  f.world.set('1,37,0','water')
  assert.equal(liquidSeen(f.bot,f.bot.blockAt(new Vec3(1,37,0))),false)
  const r:any=await run(f,true)
  assert.equal(r.steps,0)
  assert.doesNotMatch(r.stopped,/вода|water|1,37,0/)
  assert.ok(!r.ledge?.drop?.water)
}))

test('K stairs: displacement during the last cut stops rather than moving into a newly computed uncut step', () => flag('1', async () => {
  const f=body(),dig=f.bot.dig
  f.world.set('-1,40,0','air');f.world.set('-1,41,0','air')
  f.bot.dig=async b=>{await dig(b);if(f.key(b.position)==='1,39,0')f.bot.entity.position=new Vec3(-.5,40,.5)}
  const r:any=await run(f,true)
  assert.match(r.stopped,/сбило со ступени/);assert.equal(r.steps,0)
  assert.equal(f.bot.entity.position.x,-.5,'no step attempted after displacement')
}))

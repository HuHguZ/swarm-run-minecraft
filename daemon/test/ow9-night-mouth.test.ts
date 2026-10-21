import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block = require('prismarine-block')(data)
const B: typeof import('../src/build') = require('../src/build')
const Mining: typeof import('../src/mining') = require('../src/mining'), Actions: typeof import('../src/actions') = require('../src/actions')
const key = p => `${p.x},${p.y},${p.z}`
function fixture({ stairs = false, torch = true, works = true, light = true, delayed = false, entryLight = 0 }: any = {}) {
  const world = new Map<string, string>(), calls: any[] = [], mouth = new Vec3(1, stairs ? 39 : 40, 0)
  for (const y of [40, 41]) world.set(`0,${y},0`, 'air')
  for (let x = 1; x <= 3; x++) for (let z = -1; z <= 1; z++) for (let y = mouth.y; y <= 42; y++) world.set(`${x},${y},${z}`, 'air')
  const items = [{ ...data.itemsByName.stone_pickaxe, count: 1, durabilityUsed: 0 }, { ...data.itemsByName.cobblestone, count: 64 }, ...(torch ? [{ ...data.itemsByName.torch, count: 3 }] : [])]
  let aim: any, lightReady = !delayed
  const blockAt = p => {
    const name = world.get(key(p)) || 'stone', b = Block.fromStateId(data.blocksByName[name].defaultState, 0)
    b.position = p.clone(); b.light = p.equals(mouth.offset(0, 1, 0)) ? entryLight : 0; b.skyLight = 0; b.digTime = () => 0
    if (light && lightReady) for (const [k, name] of world) if (/^(wall_)?torch$/.test(name)) {
      const [x, y, z] = k.split(',').map(Number), dist = Math.abs(x - p.x) + Math.abs(y - p.y) + Math.abs(z - p.z)
      b.light = Math.max(b.light, 14 - dist)
    }
    return b
  }
  const bot: any = { health: 19, food: 17, entities: {}, game: { dimension: 'overworld' }, time: { timeOfDay: 18000 },
    entity: { position: new Vec3(.5, 40, .5), onGround: true, height: 1.8 }, heldItem: items[0],
    inventory: { items: () => items, slots: [] }, pathfinder: { setGoal() {} }, blockAt,
    dig: async b => world.set(key(b.position), 'air'), equip: async item => { bot.heldItem = item },
    lookAt: async p => { aim = p }, clearControlStates() {}, stopDigging() {}, findBlocks: () => [], nearestEntity: () => null,
    setControlState(name, on) { if (name !== 'forward' || !on) return
      const x = Math.floor(aim.x), z = Math.floor(aim.z); let y = Math.floor(bot.entity.position.y)
      while (world.get(`${x},${y - 1},${z}`) === 'air') y--
      bot.entity.position = new Vec3(x + .5, y, z + .5)
    } }
  const place = async (body, p, options) => {
    calls.push({ at: key(p), ...options })
    assert.equal(options.honest, true, 'all new torch and mouth placement uses client-visible honest faces')
    if (options.item === 'torch') {
      if (!works) return { ok: false, reason: 'face occluded' }
      world.set(key(p), 'torch')
      if (delayed) setTimeout(() => { lightReady = true }, 75)
      return { ok: true }
    }
    world.set(key(p), 'cobblestone'); return { ok: true }
  }
  return { bot, mouth, world, calls, place, ctl: { aborted: false, onAbort: [] }, session: { bot, mcData: data, cfg: { fairPlay: false }, journal: { state: {}, append() {} } } }
}
async function run() {
  let checks = 0
  for (const stairs of [false, true]) for (const scenario of [
    { name: 'real target light 2 and dark body require no new torch', torch: false, entryLight: 2, pass: true },
    { name: 'real torch and light permits cave entry', torch: true, works: true, light: true, pass: true },
    { name: 'no torch seals the mouth with stable refusal', torch: false, pass: false },
    { name: 'failed torch cannot invent illumination', torch: true, works: false, pass: false },
    { name: 'torch block alone is not a light update', torch: true, works: true, light: false, pass: false },
    { name: 'wait only for the observed light packet', torch: true, works: true, light: true, delayed: true, pass: true }
  ]) {
    process.env.ND_NIGHT_STEP_MARGINAL = '1'; process.env.ND_NIGHT_FAIL_KEY = '1'
    const f = fixture({ stairs, ...scenario }), old = B.placeBlockAt
    B.placeBlockAt = f.place
    try {
      const r: any = stairs ? await Actions.digStairs(f.session, f.ctl, { depth: 1, direction: 'east', nightWork: true, torchEvery: 0 })
        : await Mining.tunnel(f.session, f.ctl, { length: 1, direction: 'east', nightWork: true, torchEvery: 0 })
      const label = `${stairs ? 'stairs' : 'tunnel'}: ${scenario.name}`
      if (scenario.pass) { assert.equal(r.stopped, undefined, label); assert.equal(stairs ? r.steps : r.walked, 1, label) }
      else {
        assert.match(r.stopped, /NIGHT_RISK/, label); assert.equal(f.bot.entity.position.x, .5, label)
        assert.deepEqual(r.nightRefusal.target, { x: 1, y: stairs ? 39 : 40, z: 0 }, label)
        assert.equal(r.nightRefusal.view.walls, 0, 'receipt describes open cave, before self sealing')
        assert.equal(r.nightRefusal.standing.walls, 3, 'receipt describes original corridor before self sealing')
        assert.equal(r.nightRefusal.view.block, 0, label)
        assert.equal(r.nightRefusal.corridor, false, label)
        assert.equal(r.nightRefusal.seconds, stairs ? 3.25 : 2, label)
        assert.equal(f.world.get(`1,40,0`), 'cobblestone', label); assert.equal(f.world.get(`1,41,0`), 'cobblestone', label)
      }
      assert.equal(f.calls.filter(c => c.item === 'torch').length, scenario.torch ? 1 : 0, label)
      checks++; console.log('PASS', label)
    } finally { B.placeBlockAt = old }
  }
  process.env.ND_NIGHT_FAIL_KEY = '0'
  for (const stairs of [false, true]) {
    const f = fixture({ stairs }), old = B.placeBlockAt; B.placeBlockAt = f.place
    try {
      const r: any = stairs ? await Actions.digStairs(f.session, f.ctl, { depth: 1, direction: 'east', nightWork: true })
        : await Mining.tunnel(f.session, f.ctl, { length: 1, direction: 'east', nightWork: true })
      assert.match(r.stopped, /NIGHT_RISK/); assert.equal(r.nightRefusal, undefined)
      assert.equal(f.calls.filter(c => c.item === 'torch').length, 0)
      checks++; console.log('PASS', `${stairs ? 'stairs' : 'tunnel'}: flag0 keeps legacy refusal without torch attempt`)
    } finally { B.placeBlockAt = old }
  }
  console.log(JSON.stringify({ checks, version: data.version.minecraftVersion }))
}
test('D2 native tunnel and staircase buy observed cave lighting or retain the open-mouth refusal; flag0 stays legacy', async () => {
  const before = { fail: process.env.ND_NIGHT_FAIL_KEY, marginal: process.env.ND_NIGHT_STEP_MARGINAL }
  try { await run() } finally {
    if (before.fail === undefined) delete process.env.ND_NIGHT_FAIL_KEY; else process.env.ND_NIGHT_FAIL_KEY = before.fail
    if (before.marginal === undefined) delete process.env.ND_NIGHT_STEP_MARGINAL; else process.env.ND_NIGHT_STEP_MARGINAL = before.marginal
  }
})

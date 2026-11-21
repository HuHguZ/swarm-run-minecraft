'use strict'
// Решатель броска жемчуга (pearl-hop.js): угол, отказ при стене, пустоте и малом хп.
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as hop from '../src/pearl-hop'
import { cacheMethods } from '../src/rpc/caches'
import { swarmClimb } from '../../farm/swarm/swarm-driver/climb'
import { block, testBot } from './tick-plugins-fixture'

// Мир: остров end_stone радиуса R с верхом y = top, платформа 5×5 обсидиана на y = 48 у (100, 0),
// extra — Map 'x,y,z' -> имя блока.
function world ({ R = 60, top = 60, extra = new Map() }: any = {} as Record<string, any>) {
  return (x, y, z) => {
    const k = `${x},${y},${z}`
    let name = 'air'
    if (extra.has(k)) name = extra.get(k)
    else if (y <= top && y >= top - 8 && x * x + z * z <= R * R) name = 'end_stone'
    else if (y === 48 && x >= 98 && x <= 102 && z >= -2 && z <= 2) name = 'obsidian'
    return { name, boundingBox: name === 'air' || name === 'water' || name === 'lava' ? 'empty' : 'block' }
  }
}
const feetP = new Vec3(100.5, 49, 0.5)

// 31e launched near (582,120,628) and took ender_pearl damage on the landscape
// at y=65, below the Colosseum kill plane (113). Recreate that failure on a one-cell ledge.
test('pearl_plan and pearl_up reject scatter below the arena and recheck the ledge at the release tick', async t => {
  const from = new Vec3(581.8, 120, 628.2), to = new Vec3(568.5, 135, 639.5)
  const arena = { x: 600.5, y: 120, z: 600.5, r: 85, killY: 113 }
  let radius = 0, erode = false, afterAim = false, lowerReads = 0
  const aims = []
  const bot: any = Object.assign(new EventEmitter(), { entity: { position: from, onGround: true, velocity: new Vec3(0, 0, 0) },
    health: 20, registry: {}, inventory: { slots: [], items: () => [{ name: 'ender_pearl', count: 3 }] }, entities: {}, setControlState() {},
    blockAt(p) {
      const { x, y, z } = p.floored()
      if (y < arena.killY) lowerReads++
      const roof = y === 134 && Math.abs(x - 568) <= radius && Math.abs(z - 639) <= radius
      const launch = y === 119 && Math.abs(x - 582) < 2 && Math.abs(z - 628) < 2
      return { name: y === 63 ? 'grass_block' : roof || launch ? 'sandstone' : 'air', boundingBox: roof || launch || y === 63 ? 'block' : 'empty' }
    } })
  const rpc = cacheMethods({ session: { require: () => bot, immediate: f => f(), runIntent: (_, f) => f({ aborted: false }) } } as any)
  t.mock.method(require('../src/throw'), 'throwAt', async (_, __, opts) => {
    if (erode) radius = 0
    const aim = opts.pick({ from: from.offset(0, hop.EYE, 0), moved: bot.entity.velocity, airborne: false })
    if (afterAim) {
      const at = new Vec3(569, 134, 639), old = bot.blockAt(at)
      radius = 0; bot.emit('blockUpdate', old, bot.blockAt(at))
    }
    aims.push(!!aim && opts.onAim())
    return { thrown: false, why: 'before use_item' }
  })
  assert.equal((await rpc.pearl_plan({ to })).ok, true, 'the one-cell ledge is physically in reach')
  assert.ok(lowerReads > 0, 'the unbounded solver accepts the landscape under a missed ledge')
  lowerReads = 0
  assert.equal((await rpc.pearl_plan({ to, arena })).ok, false, 'a missed ledge teleports onto flat grass below killY')
  await rpc.pearl_up({ to, arena, maxHops: 1 })
  assert.deepEqual(aims, [])
  radius = 2
  assert.equal((await rpc.pearl_plan({ to, arena })).ok, true, 'wide intact upper platform')
  assert.equal((await rpc.pearl_plan({ to, arena: { ...arena, r: 30 } })).ok, false, 'beyond horizontal bounds')
  await rpc.pearl_up({ to, arena, maxHops: 1 })
  assert.deepEqual(aims, [true])
  erode = true
  await rpc.pearl_up({ to, arena, maxHops: 1 })
  assert.deepEqual(aims, [true, false], 'a removed rim no longer catches the spread')
  erode = false; radius = 2; afterAim = true
  await rpc.pearl_up({ to, arena, maxHops: 1 })
  assert.deepEqual(aims, [true, false, false], 'the rim can also disappear after choosing the angle, before releasing the pearl')
  assert.equal(bot.listenerCount('blockUpdate'), 0)
  afterAim = false
  assert.equal(lowerReads, 0, 'no terrain information needed from under the kill plane')

  let bounds: typeof arena & { avoid?: any[] } = arena
  const frame = { p: from, hp: 20, inv: { ender_pearl: 1 } }, calls = []
  const actor = { name: 'A', c: { async call(method, params) {
    calls.push(method)
    return { status: 'done', detail: await rpc[method](params) }
  } } }
  const driver = swarmClimb({ now: () => 1000, alive: () => true, pos: { A: frame }, arena, lootArena: () => bounds,
    failed() {}, blocked: () => false, cleared() {}, log() {}, detail: r => r.detail })
  aims.length = 0; erode = false; radius = 0
  for (const stock of [1, 3]) {
    frame.inv.ender_pearl = stock
    await driver.pearlUp(actor, to)
    assert.equal(aims.length, 0, 'ordinary swarm ascent never releases a pearl with lethal scatter, stock ' + stock)
  }
  radius = 2
  await driver.pearlUp(actor, to)
  assert.deepEqual(aims, [true], 'the same target is usable once the ledge is wide enough')
  bounds = { ...arena, avoid: [{ ...to, r: 8 }] }
  await driver.pearlUp(actor, to)
  assert.deepEqual(aims, [true], 'a fresh team sighting can also exclude the landing')
  assert.equal(lowerReads, 0, 'the real driver supplies killY to preview and execution')
  frame.p = new Vec3(533, 64, 668)
  calls.length = 0
  await driver.pearlUp(actor, to)
  assert.deepEqual(calls, [], 'under the kill plane the body has no loot ascent')
})

function roofActors() {
  const launch = new Vec3(581.8, 120, 628.2), under = new Vec3(588.5, 120, 628.5), roof = new Vec3(568.5, 135, 639.5)
  const arena = { x: 600.5, y: 120, z: 600.5, r: 85, killY: 113 }, cells = new Map()
  const blockAt = p => {
    const cell = p.floored(), { x, y, z } = cell, k = cell.toString()
    if (!cells.has(k)) {
      const canopy = y === 122 && Math.abs(x - 588) <= 3 && Math.abs(z - 628) <= 3
      const platform = y === 134 && Math.abs(x - 568) <= 2 && Math.abs(z - 639) <= 2
      cells.set(k, block(y === 119 || canopy || platform ? 'sandstone' : 'air', cell))
    }
    return cells.get(k)
  }
  const bodies = [], walks = [], pos = {}
  const actor = (name, start) => {
    const bot = testBot()
    const ctl = { aborted: false }
    bot.username = name; bot.health = 20; bot.entity.onGround = true
    bot.entity.position = start; bot.entity.velocity = new Vec3(0, 0, 0)
    bot.inventory.items = () => [{ name: 'ender_pearl', count: 1 }]
    bot.blockAt = blockAt; bot.world = { getBlock: blockAt, raycast: require('prismarine-world/src/worldsync').prototype.raycast }
    bot.setControlState = () => {}; bodies.push(bot)
    pos[name] = { p: start, hp: 20, inv: { ender_pearl: 1 } }
    const rpc = cacheMethods({ session: { require: () => bot, immediate: f => f(), runIntent: (_, f) => f(ctl) } } as any)
    return { name, team: 'blue', ctl, c: { call: async (method, params) => {
      if (method === 'goto') {
        assert.equal(params.exactY, true)
        const at = new Vec3(params.x, params.y, params.z)
        assert.ok(at.equals(launch)); walks.push(name)
        bot.entity.position = at; pos[name].p = at
        return { detail: { arrived: at } }
      }
      return { detail: await rpc[method](params) }
    } } }
  }
  const scout = actor('Scout', launch), ally = actor('Ally', under)
  return { scout, ally, bodies, arena, roof, walks, launch, pos }
}

test('отмена между прицеливанием и пакетом движения сохраняет жемчуг и не сообщает об успешном старте', async () => {
  const { scout, bodies, arena, roof } = roofActors()
  const shooter = bodies[0], held = { name: 'ender_pearl', type: shooter.registry.itemsByName.ender_pearl.id, slot: 36, count: 1 }
  shooter.inventory.items = () => [held]; shooter.heldItem = held
  let aims = 0, uses = 0
  shooter.look = async () => { aims++; scout.ctl.aborted = true }
  shooter.activateItem = () => { uses++; shooter.entity.position = roof }
  const ticks = setInterval(() => shooter.emit('physicsTick'), 3)
  try {
    const r = await scout.c.call('pearl_up', { to: { x: roof.x, y: roof.y, z: roof.z }, arena, maxHops: 2 })
    assert.ok(aims > 0, JSON.stringify(r.detail))
    assert.equal(uses, 0, 'cancelled between aim and movement packet')
    assert.equal(r.detail.hops, 0)
    assert.equal(r.detail.launchAt, undefined)
  } finally { clearInterval(ticks) }
})

test('под низким потолком союзник узнаёт место реального броска, выходит наружу и тоже долетает', async t => {
  const { scout, ally, bodies, arena, roof, walks, launch, pos } = roofActors(), releases = []
  // The driver's old status intentionally differs from the body's true launch position.
  pos[scout.name].p = launch.offset(-3, 0, -2)
  t.mock.method(require('../src/throw'), 'throwAt', async (bot, _, opts) => {
    const feet = bot.entity.position, eye = feet.offset(0, hop.EYE, 0), motion = new Vec3(0, 0, 0)
    const aim = opts.pick({ from: eye, moved: motion, airborne: false })
    assert.ok(aim, 'release tick accepts the arc')
    const world = hop.worldOf(bot, arena.killY), trail = hop.simulate(world, eye, hop.velOf(aim.yaw, aim.pitch))
    assert.ok(trail.tp)
    const landing = hop.settle(world, trail.tp)
    assert.ok(landing.ok && landing.feet.distanceTo(roof) <= 4)
    releases.push(bot.username); bot.entity.position = landing.feet
    return { thrown: true }
  })
  const driver = swarmClimb({ now: () => 1000, generation: 0, alive: () => true, pos, arena,
    failed() {}, blocked: () => false, cleared() {}, log() {}, detail: r => r.detail })
  assert.equal(await driver.pearlUp(ally, roof), null, 'no shot through the canopy')
  assert.equal((await driver.pearlUp(scout, roof))?.arrived, true)
  assert.deepEqual(await driver.pearlUp(ally, roof), { moved: true })
  assert.equal((await driver.pearlUp(ally, roof))?.arrived, true)
  assert.deepEqual(walks, ['Ally'])
  assert.deepEqual(releases, ['Scout', 'Ally'])
  assert.ok(bodies.every(b => b.entity.position.distanceTo(roof) <= 4))
})

test('бросок с платформы на остров: угол найден, посадка на end_stone, к цели ближе', () => {
  const w = world({ R: 70 })
  const r = hop.planHop(w, feetP, new Vec3(8.5, 61, 0.5))
  assert.ok(r.plan, JSON.stringify(r.why))
  const p = r.plan
  assert.ok(p.pitch > 0 && p.pitch < 60 * Math.PI / 180, `наклон ${p.pitch}`)
  assert.equal(p.feet.y, 61)
  assert.ok(p.feet.x < 75, `посадка x ${p.feet.x}`)
  // повтор полёта с тем же углом — та же посадка
  const s = hop.simulate(w, { x: feetP.x, y: feetP.y + hop.EYE, z: feetP.z }, hop.velOf(p.yaw, p.pitch))
  assert.ok(s.tp && Math.abs(s.tp.x - p.tp.x) < 1e-9)
})

test('цель далеко за дальностью — бросок не дальше дальности, но с прогрессом', () => {
  const w = world({ R: 70 })
  const r = hop.planHop(w, feetP, new Vec3(-60.5, 61, 0.5))
  assert.ok(r.plan)
  assert.ok(r.plan.rem < 160 - 25, `остаток ${r.plan.rem}`)
})

test('стена на пути — дуга не врезается: либо высокая дуга, либо отказ, но не посадка в стену', () => {
  const extra = new Map()
  // стена обсидиана x = 75, z −6..6, y 49..90 — между платформой и островом
  for (let y = 49; y <= 90; y++) for (let z = -6; z <= 6; z++) extra.set(`75,${y},${z}`, 'obsidian')
  const w = world({ R: 70, extra })
  const r = hop.planHop(w, feetP, new Vec3(40.5, 61, 0.5), { lateral: [0] })
  if (r.plan) {
    // если нашёлся — траектория обходит стену сверху и садится за ней
    assert.ok(r.plan.feet.x < 75, `посадка ${r.plan.feet.x}`)
  } else {
    assert.ok(Object.keys(r.why).some(k => /врезается|посадка/.test(k)), JSON.stringify(r.why))
  }
  // стена до неба — отказ
  for (let y = 91; y <= 160; y++) for (let z = -6; z <= 6; z++) extra.set(`75,${y},${z}`, 'obsidian')
  const r2 = hop.planHop(world({ R: 70, extra }), feetP, new Vec3(40.5, 61, 0.5), { lateral: [0] })
  assert.equal(r2.plan, null)
})

test('пустота: острова нет в дальности — отказ; край острова — не цель', () => {
  const r = hop.planHop(world({ R: 10 }), feetP, new Vec3(0.5, 61, 0.5))
  assert.equal(r.plan, null)
  // узкая полоска (1 блок) над пустотой — край со всех сторон
  const extra = new Map()
  for (let x = 60; x <= 80; x++) extra.set(`${x},60,0`, 'end_stone')
  const r2 = hop.planHop(world({ R: 10, extra }), feetP, new Vec3(60.5, 61, 0.5), { lateral: [0] })
  assert.equal(r2.plan, null)
})

test('вода и лава — не посадка', () => {
  const extra = new Map()
  for (let x = -80; x <= 80; x++) for (let z = -80; z <= 80; z++) extra.set(`${x},60,${z}`, 'lava')
  const r = hop.planHop(world({ R: 70, extra }), feetP, new Vec3(30.5, 61, 0.5))
  assert.equal(r.plan, null)
})

test('кристалл на пути — отказ от этой дуги', () => {
  const w = world({ R: 70 })
  const r0 = hop.planHop(w, feetP, new Vec3(8.5, 61, 0.5), { lateral: [0] })
  assert.ok(r0.plan)
  const mid = r0.plan
  // кристалл в вершине траектории
  const s = hop.simulate(w, { x: feetP.x, y: feetP.y + hop.EYE, z: feetP.z }, hop.velOf(mid.yaw, mid.pitch))
  const top = s.path.reduce((m, q) => q.y > m.y ? q : m, s.path[0])
  const r = hop.planHop(w, feetP, new Vec3(8.5, 61, 0.5), { lateral: [0], obstacles: [{ pos: top, r: 3, name: 'end_crystal' }], maxTries: 3 })
  assert.ok(!r.plan || Math.hypot(r.plan.tp.x - mid.tp.x, r.plan.tp.z - mid.tp.z) > 0.5 || r.plan.arc !== mid.arc)
})

test('worth: мало хп, нет жемчуга, нет выигрыша — не бросать; мост через пустоту — бросать', () => {
  assert.equal(hop.worth({ walkSec: 60, hopSec: 2, dmg: 3.4, hp: 14, hpMin: 12, pearls: 5, reserve: 1 }).go, false)
  assert.equal(hop.worth({ walkSec: 60, hopSec: 2, dmg: 3.4, hp: 20, pearls: 1, reserve: 1 }).go, false)
  assert.equal(hop.worth({ walkSec: 6, hopSec: 2, dmg: 3.4, hp: 20, pearls: 5, reserve: 1 }).go, false)
  const w = hop.worth({ walkSec: 40, hopSec: 2.5, restSec: 10, dmg: 3.4, hp: 20, pearls: 5, reserve: 1 })
  assert.equal(w.go, true)
  assert.ok(w.gain > 20)
})

test('урон переноса: «Защита II» ×4 → 3.4, без брони — 5', () => {
  const bot = (lvl) => ({ inventory: { slots: [0, 0, 0, 0, 0, ...[5, 6, 7, 8].map(() => lvl ? { enchants: [{ name: 'protection', lvl }] } : null)] }, entity: {} as Record<string, any> })
  assert.equal(hop.pearlDamage(bot(0)), 5)
  assert.equal(hop.pearlDamage(bot(2)), 3.4)
  const modern = { entity: {}, registry: { enchantments: [{ name: 'protection' }] }, inventory: { slots: [null, null, null, null, null,
    { enchants: { enchantments: [] }, componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 0, level: 4 }] } }]]) }] } }
  assert.equal(hop.pearlDamage(modern), 4.2)
})

test('пешком: пустота по пути дороже, чем суша', () => {
  const w = world({ R: 70 })
  const a = hop.walkEstimate(w, feetP, new Vec3(8.5, 61, 0.5))
  const b = hop.walkEstimate(world({ R: 110 }), new Vec3(100.5, 61, 0.5), new Vec3(8.5, 61, 0.5))
  assert.ok(a.voids >= 25, `пустот ${a.voids}`)
  assert.ok(a.sec > b.sec)
})

test('route composes three rising platforms and refuses a chain that spends its health or pearl reserve', () => {
  const levels = [[0, 100], [24, 108], [48, 116], [72, 124]]
  const terrain = (x, y, z) => {
    const solid = levels.some(([at, top]) => Math.abs(x - at) <= 5 && Math.abs(z) <= 5 && y >= top - 3 && y <= top)
    return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty' }
  }
  const from = new Vec3(.5, 101, .5); const goal = new Vec3(72.5, 125, .5)
  const options = { pearls: 4, reserve: 1, hp: 20, hpMin: 1, dmg: 5, hpSec: .1, maxHops: 3, maxR: 30, lateral: [0] }
  const route = hop.planRoute(terrain, from, goal, options)
  assert.equal(route.plans.length, 3)
  assert.deepEqual(route.plans.map(plan => plan.feet.y), [109, 117, 125])
  assert.equal(route.damage, 15)
  assert.ok(route.seconds < hop.walkEstimate(terrain, from, goal).sec)
  for (const plan of route.plans) assert.equal(hop.settle(terrain, plan.tp).ok, true)
  assert.ok(hop.planRoute(terrain, from, goal, { ...options, hpMin: 12 }).plans.length <= 1)
  assert.ok(hop.planRoute(terrain, from, goal, { ...options, reserve: 3 }).plans.length <= 1)
  assert.equal(hop.planRoute(terrain, from, goal, { ...options, reserve: 4 }).plans.length, 0)
})

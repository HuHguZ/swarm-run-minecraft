import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
const tools: typeof import('../src/tools') = require('../src/tools')
const totem: typeof import('../src/totem') = require('../src/totem')
const clock: typeof import('../src/game-clock') = require('../src/game-clock')
const pick: typeof import('../src/pick') = require('../src/pick')
import { webTurn } from '../src/pvp/turn-hazards'
import { NEXT } from '../src/pvp/turn'
import { worldOf, drive, registry } from './parkour-fixture'

test('паутина: щит под ударом, рез в его откате, жемчуг при дорогом выходе', async t => {
  let web = true, head = true, cutMs = 400, eta = 0, cooldown = 0, time = 10000
  const calls: string[] = []
  const me = new Vec3(.5, 64, .5), sword = { name: 'diamond_sword', type: 1 }, pearl = { name: 'ender_pearl', type: 2 }
  const block = p => ({ name: web && p.floored().equals(me.floored()) || head && p.floored().equals(me.floored().offset(0, 1, 0)) ? 'cobweb' : 'air', position: p.floored(), stateId: web ? 1 : 0 })
  const bot: any = { health: 6, entity: { position: me, width: .6, height: 1.8, onGround: true, metadata: [], effects: {} },
    game: { dimension: 'overworld' }, inventory: { items: () => [sword, pearl], slots: [] }, blockAt: block, lookAt: async () => {} }
  const foe = { id: 2, position: me.offset(2, 0, 0), equipment: [{ name: 'diamond_sword' }] }
  t.mock.method(tools, 'bestFor', () => ({ ms: cutMs, item: sword, harvest: true }))
  t.mock.method(totem, 'burstOf', () => 8)
  t.mock.method(clock, 'now', () => time)
  const ctx: any = { bot, entity: foe, ctl: { aborted: false }, prof: { player: true }, aim: 'target',
    guard: { stats: { worn: true }, raise: async up => { calls.push(up ? 'shield' : 'lower'); return up }, blocking: () => true, failure: () => null },
    tt: { eta: () => eta, threats: () => [foe], state: () => ({ swung: cooldown ? { left: cooldown } : null }) },
    mc: { threat: () => null }, maceNow: () => null, ready: () => true, rest: () => {}, used: () => {},
    clear: () => calls.push('clear'), pathTo: () => {}, holdItem: async () => true, holdWeapon: async () => {},
    heldName: () => sword.name, routeInputs: () => 'unchanged', pendingWater: [], st: {},
    sleep: async ms => { time += ms }, digWatch: async () => { calls.push('cut'); web = false; return null },
    escapePearl: async options => { assert.equal(options.jump, false); calls.push('pearl'); web = false; return { thrown: true, clear: true } } }
  const turn: any = { hp: 6, r: 2, me, meInWeb: true, inSight: true, cooldownLeft: 0 }
  // Без жемчуга первый удар закрывается щитом; собственный откат не разрешает резку.
  bot.inventory.items = () => [sword]
  await webTurn(ctx, turn)
  assert.ok(calls.includes('shield')); assert.ok(!calls.includes('cut'))
  cooldown = 600
  ctx.digWatch = async () => { calls.push('cancelled'); return 'прервано' }
  await webTurn(ctx, turn)
  assert.equal(web, true); assert.ok(ctx.failedCutWeb)
  time += cutMs
  ctx.digWatch = async b => { calls.push('cut'); if (b.position.y === 65) head = false; else web = false; return null }
  await webTurn(ctx, turn)
  assert.equal(head, false); assert.equal(web, true, 'две клетки снимаются по одной в отдельные окна')
  await webTurn(ctx, turn)
  assert.ok(calls.includes('cut')); assert.equal(web, false)
  // В воздухе рез дольше; цена ожидаемых ударов выше собственного урона жемчуга.
  web = true; cutMs = 2000; cooldown = 0; bot.inventory.items = () => [sword, pearl]
  calls.length = 0
  await webTurn(ctx, turn)
  assert.ok(calls.includes('shield')); assert.ok(calls.includes('pearl')); assert.ok(!calls.includes('cut'))
  // Пустое ведро само по себе не доказывает смывание: нужен block receipt.
  web = true; eta = Infinity; ctx.tt.threats = () => []; ctx.failedCutWeb = null
  const water = { name: 'water_bucket' }; bot.inventory.items = () => [sword, water]
  bot.look = async () => {}; bot.activateItem = () => { calls.push('water') }
  ctx.used = text => calls.push(text)
  t.mock.method(pick, 'blockOnRay', () => ({ pos: me.floored(), block: block(me), t: 1 }))
  calls.length = 0
  await webTurn(ctx, turn)
  assert.ok(calls.includes('water')); assert.ok(!calls.includes('вода: смыл паутину')); assert.equal(web, true)
  time += turn.webPlan.freeMs
  const pouredAt = time
  ctx.sleep = async ms => { time += ms; if (time - pouredAt >= 300) web = false }
  await webTurn(ctx, turn)
  assert.ok(calls.includes('вода: смыл паутину')); assert.equal(web, false)
})

function fightingWeb(mode = '') {
  const cells: Array<[number, number, number, string]> = [[0, 0, 0, 'stone'], [0, 1, 0, 'cobweb']]
  if (mode !== 'void') for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (x || z) {
    cells.push([x, 0, z, 'stone'])
    if (mode === 'wall') cells.push([x, 1, z, 'stone'], [x, 2, z, 'stone'])
  }
  const { bot, world } = worldOf(cells), ctl = { aborted: false, onAbort: [] as Array<() => void> }
  bot.entity.position = new Vec3(.5, 1, .5); bot.entity.velocity.y = -.0784000015258789; bot.entity.isInWeb = true
  if (mode === 'hidden') bot.canSeeBlock = () => false
  if (mode === 'shears') bot.inventory.items = () => [{ name: 'shears', type: registry.itemsByName.shears.id, count: 1, enchants: [] }]
  const foe = { id: 2, username: 'SeenFoe', type: 'player', name: 'player', position: new Vec3(5.5, 1, .5), equipment: [] }
  Object.defineProperty(foe, 'health', { get() { throw Error('exact enemy HP is forbidden') } })
  const calls = { cuts: 0, shields: [] as boolean[], motion: [] as string[], used: [] as string[], mace: mode === 'mace' }
  const ctx: any = { bot, ctl, entity: foe, prof: { player: true }, aim: 'target', pendingWater: [], st: {},
    arena: { x: .5, y: 1, z: .5, r: 3, killY: 0 }, pathTo() {}, clear: () => bot.clearControlStates(), routeInputs: () => 'one-visible-web',
    guard: mode === 'mace' ? { stats: { worn: true }, raise: async up => { calls.shields.push(up); return up }, failure: () => null } : null,
    tt: { threats: () => [], eta: () => Infinity, state: () => ({}) }, mc: { threat: () => calls.mace },
    ready: () => false, rest() {}, used: message => calls.used.push(message), holdWeapon: async () => {}, holdItem: async () => true,
    sleep: async () => {}, digWatch: async (_block, stop) => {
      const why = stop?.(); if (why) return why
      calls.cuts++; bot.blockAt = p => { const b = world.getBlock(p); return b.name === 'cobweb' ? world.getBlock(new Vec3(9, 1, 9)) : b }; return null
    } }
  bot.lookAt = async () => {}; drive(bot, world)
  const set = bot.setControlState
  bot.setControlState = (key, value) => { if (value && key !== 'sneak') calls.motion.push(key); set(key, value) }
  return { bot, world, ctl, ctx, calls, frame: { hp: 20, r: 5, me: bot.entity.position, inSight: true } as any }
}

test('the actual combat web stage walks to native visible floor before an expensive hand cut and ends its frame', async () => {
  const f = fightingWeb(), web = new Vec3(0, 1, 0)
  assert.ok(tools.bestFor(f.bot, f.bot.blockAt(web)).ms >= 20000)
  assert.equal(await webTurn(f.ctx, f.frame), NEXT, 'the real fight runner consumes this early return before fireTurn')
  assert.equal(f.calls.cuts, 0, 'a walk must not wait for the twenty-second cut')
  assert.equal(require('../src/hazards').webCells(f.bot).length, 0)
  assert.equal(f.world.getBlock(web).name, 'cobweb', 'leaving the body web is distinct from breaking it')
  assert.ok(f.calls.motion.length > 0); assert.ok(!f.calls.motion.includes('jump'))
  assert.equal(f.bot.health, 20); assert.equal(f.bot.entity.position.y, 1)
  assert.equal(f.bot.listenerCount('physicsTick'), 0); assert.equal(f.ctl.onAbort.length, 0)
  assert.equal(f.ctx.aim, 'target')
})

test('combat web walking retains cut price, visible support, solid walls and incoming-mace shield guards', async () => {
  for (const mode of ['shears', 'void', 'hidden', 'wall', 'mace']) {
    const f = fightingWeb(mode)
    await webTurn(f.ctx, f.frame)
    assert.equal(f.calls.motion.length, 0, mode)
    if (mode === 'mace') { assert.deepEqual(f.calls.shields, [true]); assert.equal(f.calls.cuts, 0) }
    else assert.equal(f.calls.cuts, 1, mode)
    assert.equal(f.bot.listenerCount('physicsTick'), 0, mode)
  }
})

test('combat aim cannot invalidate a real web escape forecast while the native planner awaits', async t => {
  const f = fightingWeb(), search = require('../src/navigation/parkour/search'), nativePlan = search.planJumpAsync
  let aimTick: () => void, aimTicks = 0, found = 0
  t.mock.method(clock, 'setInterval', fn => { aimTick = fn; return {} as any })
  Object.assign(f.ctx, { ovl: { at: clock.now() }, session: {}, vision: { observe() {} }, track: { at: () => f.ctx.entity.position.clone() } })
  f.ctx.entity.isValid = true; f.ctx.entity.height = 1.95
  f.bot._ndFallGuard = {}; f.bot.entity.pitch = -.10210176124166193
  const look = f.bot.look
  f.bot.look = async (yaw, pitch) => { await look(yaw); f.bot.entity.pitch = pitch }
  f.bot.lookAt = async point => {
    const d = point.minus(f.bot.entity.position.offset(0, 1.62, 0))
    await f.bot.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)), true)
  }
  require('../src/pvp/duel-events').installFallAndAim(f.ctx)
  t.mock.method(search, 'planJumpAsync', async (...args) => {
    const plan = await nativePlan(...args)
    assert.ok(plan, 'the real native planner found a supported exit, not a mocked success')
    assert.ok(plan.steps.every(step => !step.control.jump)); found++
    aimTick(); aimTicks++
    await new Promise(resolve => setImmediate(resolve))
    return plan
  })
  try {
    assert.equal(await webTurn(f.ctx, f.frame), NEXT)
    assert.ok(found && aimTicks, 'the actual duel aim timer ran during the real forecast await')
    assert.equal(f.calls.cuts, 0, 'target aim must not discard the native walk and select a twenty-second cut')
    assert.ok(f.calls.used.includes('вышел из паутины шагом'))
    assert.equal(require('../src/hazards').webCells(f.bot).length, 0)
    assert.equal(f.world.getBlock(new Vec3(0, 1, 0)).name, 'cobweb')
    assert.equal(f.ctx.aim, 'target'); assert.equal(f.bot.health, 20)
  } finally { f.bot.removeListener('nd_mlg', f.ctx.onMlg) }
  assert.equal(f.bot.listenerCount('physicsTick'), 0); assert.equal(f.ctl.onAbort.length, 0)
})

test('a combat web forecast restores the previous aim after no route or a planner exception', async t => {
  const f = fightingWeb('void')
  f.ctx.aim = 'away'
  f.ctx.routeInputs = () => { assert.equal(f.ctx.aim, 'away', 'null forecast restored its previous owner before choosing another action'); return 'void' }
  await webTurn(f.ctx, f.frame)
  const navigation = require('../src/navigation/web-exit')
  const g = fightingWeb()
  g.ctx.aim = 'point'
  t.mock.method(navigation, 'webExitPlan', async () => { assert.equal(g.ctx.aim, 'free'); throw Error('forecast failed') })
  await assert.rejects(webTurn(g.ctx, g.frame), /forecast failed/)
  assert.equal(g.ctx.aim, 'point'); assert.equal(f.calls.motion.length + g.calls.motion.length, 0)
})


test('a combat web forecast cannot move or cut after deferred cancellation, health loss or a fresh mace threat', async t => {
  const navigation = require('../src/navigation/web-exit'), plan = navigation.webExitPlan
  for (const mode of ['abort', 'hurt', 'mace']) {
    const f = fightingWeb()
    t.mock.method(navigation, 'webExitPlan', async (...args) => {
      const result = await plan(...args)
      assert.ok(result, 'the unchanged native geometry provides an exit')
      if (mode === 'abort') f.ctl.aborted = true
      if (mode === 'hurt') f.bot.health--
      if (mode === 'mace') f.calls.mace = true
      return result
    })
    await webTurn(f.ctx, f.frame)
    assert.equal(f.calls.motion.length, 0, mode); assert.equal(f.calls.cuts, 0, mode)
    assert.equal(f.bot.listenerCount('physicsTick'), 0, mode); assert.equal(f.ctl.onAbort.length, 0, mode)
  }
})

test('combat web native motion releases its controls and forecast on a new mace threat or health loss', async () => {
  for (const mode of ['mace', 'hurt']) {
    const f = fightingWeb()
    f.bot.once('nd_parkour', () => { if (mode === 'mace') f.calls.mace = true; else f.bot.health-- })
    await webTurn(f.ctx, f.frame)
    assert.ok(f.calls.motion.length > 0, 'the native walk really began')
    assert.equal(f.calls.cuts, 0, mode)
    assert.equal(require('../src/hazards').webCells(f.bot).length, 1, 'the guard interrupted before reaching clear floor')
    assert.equal(f.bot.listenerCount('physicsTick'), 0, mode); assert.equal(f.ctl.onAbort.length, 0, mode)
    assert.equal(f.bot._ndParkourForecast, undefined); assert.equal(f.ctx.aim, 'target')
    const presses = f.calls.motion.length
    f.bot.emit('physicsTick')
    assert.equal(f.calls.motion.length, presses, 'an old owner cannot press keys after completion')
  }
})

test('combat web native motion retains the actual arena path boundary', async () => {
  const f = fightingWeb()
  f.ctx.arena.r = .4
  await webTurn(f.ctx, f.frame)
  assert.equal(f.calls.motion.length, 0); assert.equal(f.calls.cuts, 0)
  assert.equal(f.ctx.failedCutWeb.why, 'outside_arena')
  assert.equal(require('../src/hazards').webCells(f.bot).length, 1)
  assert.equal(f.bot.listenerCount('physicsTick'), 0); assert.equal(f.ctl.onAbort.length, 0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
const tools: typeof import('../src/tools') = require('../src/tools')
const totem: typeof import('../src/totem') = require('../src/totem')
const clock: typeof import('../src/game-clock') = require('../src/game-clock')
const pick: typeof import('../src/pick') = require('../src/pick')
import { webTurn } from '../src/pvp/turn-hazards'

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

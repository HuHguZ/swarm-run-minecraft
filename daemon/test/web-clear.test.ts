import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

const turn = () => new Promise(resolve => setImmediate(resolve))

test('self-web is sensed across the body, cut honestly, and never repeatedly cancels a fight', async () => {
  const hazards = require('../src/hazards')
  assert.equal(typeof hazards.webCells, 'function', 'shared body-overlap sensor exists')
  const webs = new Map()
  const block = p => ({ name: webs.has(p.toString()) ? 'cobweb' : 'air', position: p.floored(),
    boundingBox: 'empty', hardness: 4, diggable: true, digTime: type => type === 359 ? 400 : 20000 })
  const me = { type: 'player', position: new Vec3(.95, 64, .95), width: .6, height: 1.8, onGround: true }
  const shears = { name: 'shears', type: 359, slot: 36 }
  const bot: any = { entity: me, entities: {}, inventory: { items: () => [shears] },
    blockAt: p => block(p.floored()), equip: async item => { bot.heldItem = item },
    lookAt: async () => {}, clearControlStates () {}, pathfinder: { setGoal () {} },
    dig: async b => { webs.delete(b.position.toString()) }, stopDigging () {} }
  for (const p of [new Vec3(1, 65, 1), new Vec3(0, 64, 0)]) webs.set(p.toString(), true)
  assert.deepEqual(hazards.webCells(bot).map(p => p.toString()), ['(1, 65, 1)', '(0, 64, 0)'])
  me.position.x = .7; me.position.z = .7
  assert.deepEqual(hazards.webCells(bot).map(p => p.toString()), ['(0, 64, 0)'], 'touching a face is not overlap')
  me.position = new Vec3(.5, 64, .5)
  webs.clear(); webs.set('(0, 65, 0)', true); webs.set('(0, 64, 0)', true)
  const ctl = { aborted: false, onAbort: [] }
  const { hazardMethods } = require('../src/rpc/hazards')
  const session = { require: () => bot, runIntent: async (_name, work) => ({ status: 'done', detail: await work(ctl) }) }
  const clock = { sleep: async () => {}, setInterval: () => 1, clearInterval () {}, now: () => 0 }
  const result = await hazardMethods({ session, gameClock: clock }).clear_web({})
  assert.equal(result.detail.ok, true, 'eyes inside web must still have a valid pick ray')
  assert.equal(result.detail.cut, 2)
  assert.equal(result.detail.left, 0)
  assert.equal(typeof require('../src/threats').smashes, 'function', 'CommonJS preserves the shield watcher export')
  assert.equal(ctl.onAbort.length, 0, 'completed cut releases its abort callback')

  bot.inventory.items = () => [{ name: 'water_bucket', slot: 36 }]
  bot.look = async () => {}
  bot.activateItem = () => webs.clear()
  webs.set('(0, 65, 0)', true)
  const washed = await hazardMethods({ session, gameClock: clock }).clear_web({})
  assert.equal(washed.detail.how, 'water', 'a lone bot without a sword can wash out')
  assert.equal(washed.detail.left, 0)
  bot.inventory.items = () => []
  webs.set('(0, 64, 0)', true)
  const bare = await hazardMethods({ session, gameClock: clock }).clear_web({})
  assert.equal(bare.detail.ok, true, 'a lone bot can cut by hand if no resource is available')
  webs.set('(0, 64, 0)', true)
  bot.health = 20
  let monitor, stopped = false
  const guardedClock = { ...clock, setInterval: fn => { monitor = fn; return 1 } }
  bot.stopDigging = () => { stopped = true }
  bot.dig = async () => { bot.health = 19; monitor(); throw new Error('Digging aborted') }
  const threatened = await hazardMethods({ session, gameClock: guardedClock }).clear_web({})
  assert.equal(threatened.detail.why, 'direct_threat', 'new observed damage yields the hand action to combat')
  assert.equal(stopped, true)
  assert.equal(threatened.detail.left, 1)

  const { installDangers } = require('../../farm/arena/dangers')
  const calls: string[] = [], pending: Array<(r: any) => void> = []
  const b: any = { name: 'A', team: 'blue', last: { m: 'fight', pending: true }, c: { call (method) {
    calls.push(method)
    return new Promise(resolve => pending.push(resolve))
  } } }
  const ctx: any = { round: 1, bots: [b], pos: { A: { p: me.position, inv: { diamond_sword: 1 } } },
    busy: new Set(), out: new Set(), deadNow: new Set(), enemiesOf: () => [], log () {} }
  installDangers(ctx)
  const report = () => b.c.onDanger({ pos: me.position, dangers: { web: [{ at: { x: 0, y: 65, z: 0 }, cells: 2 }] } })
  for (let i = 0; i < 22; i++) report()
  assert.deepEqual(calls, [], 'combat owns its web decisions')
  b.last = { m: 'goto', pending: true }
  report()
  assert.deepEqual(calls, ['clear_web'])
  pending.shift()({ status: 'done', detail: { ok: false, cut: 0, left: 2, why: 'web_not_removed' } })
  await turn()
  for (let i = 0; i < 22; i++) report()
  assert.deepEqual(calls, ['clear_web'], 'unchanged failed web does not cancel work 22 times')
  assert.equal(ctx.busy.size, 0, 'failed fallback releases busy')
  ctx.pos.A.inv.shears = 1
  report()
  assert.deepEqual(calls, ['clear_web', 'clear_web'], 'new equipment reopens the same web episode')
  pending.shift()({ status: 'interrupted' })
  await turn()
  report()
  assert.equal(calls.length, 3, 'cancellation is not a permanent physical failure')
  pending.shift()({ status: 'done', detail: { ok: true, left: 0 } })
  await turn()
  ctx.enemiesOf = () => [{ n: 'Foe', p: me.position.offset(10, 0, 0), d: 10, spd: 6 }]
  report()
  assert.equal(calls.length, 4, 'скорость далёкого врага без направления не запрещает внебоевой выход')
  pending.shift()({ status: 'done', detail: { ok: true, left: 0 } })
  await turn()
  // Игра пользователя 24.10: резку сорвал direct_threat, а боя никто не начинал — застревали. Теперь — бой (webTurn).
  ctx.enemiesOf = () => [{ n: 'Foe', p: me.position.offset(5, 0, 0), d: 5, spd: 0 }]
  ctx.pos.A.inv.cobblestone = 1
  report()
  assert.equal(calls.at(-1), 'clear_web')
  pending.shift()({ status: 'done', detail: { ok: false, cut: 0, left: 2, why: 'direct_threat' } })
  await turn()
  report()
  assert.equal(calls.at(-1), 'fight', 'сорванная угрозой резка — в бой, не снова clear_web')
  pending.shift()({ status: 'done', detail: { ok: true } })
  await turn()
})

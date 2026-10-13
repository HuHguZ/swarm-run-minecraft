'use strict'
// Real penTrade, controlled capture receipts; native normal-AI proof is separate.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const clock = require('../src/game-clock')

async function gather (kind = 'capture') {
  const PT = require('../src/bastion/pen-trap')
  const PG = require('../src/bastion/predict-gold')
  const SL = require('../src/sealed')
  const c = new clock.GameClock({ epoch: 100000 }); clock.activate(c); c.setState({ tick_rate: 2000 }); c.start()
  const old = { hand: PG.handNoWalk, toss: PG.tossOut, filler: SL.fillerName, count: SL.fillerCount }
  const bot: any = new EventEmitter()
  const ctl = { aborted: false }
  const start = c.now(), times = []
  let gold = kind === 'reserve' ? 2 : 20
  Object.assign(bot, {
    _client: new EventEmitter(), health: 20, entity: { position: new Vec3(-0.5, 98, 0.5), onGround: true },
    registry: { entitiesByName: { item: { id: 999 }, piglin: { metadataKeys: ['mob_flags', 'baby'] } } },
    inventory: { items: () => [{ name: 'gold_ingot', count: gold }, { name: 'cobblestone', count: 64 }] },
    blockAt: p => ({ name: p.y < 98 ? 'blackstone' : 'air', boundingBox: p.y < 98 ? 'block' : 'empty', shapes: p.y < 98 ? [[0, 0, 0, 1, 1, 1]] : [] }),
    setControlState: () => {}, lookAt: async () => {}
  })
  const pig = (id, z, inside = false) => ({ id, name: 'piglin', position: new Vec3(1.5, inside ? 98 : 100, z), metadata: [0, false], equipment: inside ? [null, { name: 'gold_ingot' }] : [] })
  bot.entities = { 1: pig(1, 0.5, true), 2: pig(2, 2.5), 3: pig(3, -2.5), 4: pig(4, 3.5) }
  const plan = { ready: true, F: 100, Bf: { x: -1, y: 98, z: 0 }, M: { x: 0, y: 100, z: 0 }, lanes: [-1, 0, 1].map(k => ({ k, T: { x: 1, y: 100, z: k }, Y: { x: 1, y: 99, z: k }, Z: { x: 1, y: 98, z: k } })) }
  if (kind === 'lying') bot.entities[20] = { id: 20, name: 'item', position: new Vec3(1.5, 98, 0.5), getDroppedItem: () => ({ name: 'gold_ingot' }) }
  PG.handNoWalk = async () => { throw new Error('busy traders must not receive a second ingot') }
  PG.tossOut = async () => {
    gold--; times.push(c.now() - start)
    if (kind !== 'stalled') {
      const pg: any = Object.values(bot.entities).find((e: any) => e.name === 'piglin' && !PT.inPen(plan, e))
      pg.position = new Vec3(1.5, 98, 0.5); pg.equipment = [null, { name: 'gold_ingot' }]
    }
    if (kind === 'abort') ctl.aborted = true
    return true
  }
  SL.fillerName = () => 'cobblestone'; SL.fillerCount = () => 64
  try {
    const r = await PT.penTrade({ bot }, ctl, plan, { plan, seconds: 7, keep: kind === 'reserve' ? 1 : 0, done: () => times.length === 3 })
    return { r, times, gold }
  } finally {
    PG.handNoWalk = old.hand; PG.tossOut = old.toss; SL.fillerName = old.filler; SL.fillerCount = old.count; c.dispose()
  }
}

test('a confirmed new adult capture permits the next bait while all traders admire', async () => {
  const { r, times } = await gather()
  assert.equal(r.penNow, 4, JSON.stringify({ r, times }))
  assert.equal(times.length, 3)
  assert.ok(times[2] - times[0] < 2000, JSON.stringify(times))
})

test('no new capture preserves the existing bait retry delay', async () => {
  assert.equal((await gather('stalled')).times.length, 1)
})

test('a lying ingot still prevents a second bait', async () => {
  assert.equal((await gather('lying')).times.length, 0)
})

for (const kind of ['abort', 'reserve']) test(`gathering rechecks ${kind} after a capture`, async () => {
  const r = await gather(kind)
  assert.equal(r.times.length, 1)
  if (kind === 'reserve') assert.equal(r.gold, 1)
})

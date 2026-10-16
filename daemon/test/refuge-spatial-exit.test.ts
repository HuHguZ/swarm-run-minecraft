import test from 'node:test'
import assert from 'node:assert/strict'
const { Vec3 } = require('vec3')
const flee = require('../src/flee')
const assess = require('../src/assess')
const clockMod = require('../src/game-clock')
const { outsideDanger, sitTight } = require('../src/survival/hold-out')

test('a lone occluded skeleton releases the recovered pocket without opening it or waiting eight seconds', async () => {
  const saved = { flag: process.env.ND_REFUGE_SPATIAL_EXIT, hostiles: flee.hostilesAround, sight: assess.inSight }
  const clock = clockMod.activate(new clockMod.GameClock({ manual: true, epoch: 10000 }))
  const at = new Vec3(57, 16, -65), archer = { id: 867, name: 'skeleton', position: new Vec3(59.46, 9.75, -55.94) }
  const bot: any = { health: 20, food: 20, time: { timeOfDay: 6000 }, game: { dimension: 'overworld' },
    entity: { position: at.offset(.5, 0, .5) }, inventory: { items: () => [] } }
  flee.hostilesAround = () => [{ e: archer, d: bot.entity.position.distanceTo(archer.position), doc: flee.DOCTRINE.skeleton }]
  assess.inSight = () => false
  try {
    process.env.ND_REFUGE_SPATIAL_EXIT = '0'
    assert.match(outsideDanger(bot, at), /стрелок/)
    process.env.ND_REFUGE_SPATIAL_EXIT = '1'
    assert.equal(outsideDanger(bot, at), null)
    const result = await sitTight({ bot }, { aborted: false }, { at, t0: clockMod.now(), step() {} })
    assert.equal(result.sat, 0)
    assert.equal(clockMod.now(), 10000)
    assert.equal(outsideDanger(bot, at, { untilDawn: true }), 'стрелок рядом', 'explicit untilDawn keeps its existing contract')
  } finally {
    flee.hostilesAround = saved.hostiles; assess.inSight = saved.sight; clock.dispose()
    if (saved.flag === undefined) delete process.env.ND_REFUGE_SPATIAL_EXIT; else process.env.ND_REFUGE_SPATIAL_EXIT = saved.flag
  }
})

test('visible archer range has a spatial return margin; melee crowd and creeper are still dangers', () => {
  const saved = { flag: process.env.ND_REFUGE_SPATIAL_EXIT, hostiles: flee.hostilesAround, sight: assess.inSight }
  process.env.ND_REFUGE_SPATIAL_EXIT = '1'
  const at = new Vec3(0, 16, 0), archer = { id: 2, name: 'skeleton', position: new Vec3(0, 16, 15) }
  const bot: any = { health: 20, food: 20, game: { dimension: 'overworld' }, time: { timeOfDay: 6000 } }
  let distance = 15, visible = true, foes = [{ e: archer, d: distance, doc: flee.DOCTRINE.skeleton }]
  flee.hostilesAround = () => foes.map(h => ({ ...h, d: distance }))
  assess.inSight = () => visible
  const shooters = new Set<number>()
  try {
    assert.match(outsideDanger(bot, at, { shooters }), /стрелок/)
    distance = 17
    assert.match(outsideDanger(bot, at, { shooters }), /стрелок/, 'already seen at range stays through the two-block margin')
    distance = 19
    assert.equal(outsideDanger(bot, at, { shooters }), null)
    distance = 17
    assert.equal(outsideDanger(bot, at, { shooters }), null, 'return needs actual attack range again')
    distance = 15; visible = false
    assert.equal(outsideDanger(bot, at, { shooters }), null)
    const zombie = { id: 3, name: 'zombie', position: new Vec3(2, 16, 2) }
    foes = [{ e: zombie, d: 2, doc: flee.DOCTRINE.zombie }, { e: { ...zombie, id: 4 }, d: 2, doc: flee.DOCTRINE.zombie }]
    distance = 2
    assert.match(outsideDanger(bot, at, { shooters }), /ходячих 2/)
    foes = [{ e: { ...zombie, name: 'creeper' }, d: 2, doc: flee.DOCTRINE.creeper }]
    assert.match(outsideDanger(bot, at, { shooters }), /крипер/)
  } finally {
    flee.hostilesAround = saved.hostiles; assess.inSight = saved.sight
    if (saved.flag === undefined) delete process.env.ND_REFUGE_SPATIAL_EXIT; else process.env.ND_REFUGE_SPATIAL_EXIT = saved.flag
  }
})

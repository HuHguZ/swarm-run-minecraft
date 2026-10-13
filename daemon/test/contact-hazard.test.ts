import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const { Vec3 } = require('vec3')
const clock = require('../src/game-clock')
const { escapeFire } = require('../src/director')

async function contact(name: string, sealed = false) {
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  const bot: any = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), yaw: 0, pitch: 0, onGround: true }
  bot.game = { dimension: 'overworld' }
  bot.inventory = { items: () => [] }
  bot.blockAt = (p: any) => {
    const q = p.floored(), own = q.x === 0 && q.z === 0
    const hazard = own && q.y === (name === 'magma_block' ? 63 : 64)
    const solid = q.y < 64 || sealed && !own && q.y < 66
    return { name: hazard ? name : solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: q }
  }
  bot.lookAt = async (p: any) => { bot.entity.yaw = Math.atan2(-(p.x - bot.entity.position.x), -(p.z - bot.entity.position.z)) }
  let moved = false
  bot.setControlState = (key: string, on: boolean) => {
    if (key === 'forward' && on) { moved = true; bot.entity.position = bot.entity.position.offset(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw)) }
  }
  bot.clearControlStates = () => {}
  const done = escapeFire({ bot }, { aborted: false, onAbort: [] })
  try {
    for (let n = 0; n < 50; n++) { timer.advanceTicks(1); await new Promise(resolve => setImmediate(resolve)) }
    return { result: await done, moved }
  } finally { timer.dispose(); clock.activate(null) }
}

for (const name of ['sweet_berry_bush', 'cactus', 'wither_rose', 'magma_block']) test(`contact rescue actually leaves ${name}`, async () => {
  const { result, moved } = await contact(name)
  assert.equal(moved, true)
  assert.equal(result.status, 'done')
  assert.equal(result.detail.escaped, true)
})

test('a sealed berry cell is a failed rescue, not a successful zero-distance escape', async () => {
  const { result, moved } = await contact('sweet_berry_bush', true)
  assert.equal(moved, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.detail.escaped, false)
})

test('pathfinding prices berry contact at feet and head without forbidding the route', () => {
  const { tuneMovements } = require('../src/worlds')
  let hazardY = 64, hazardX = 0
  const bot: any = { entity: { position: new Vec3(.5, 64, .5) }, game: { dimension: 'overworld' },
    registry: { blocksByName: { magma_block: { id: 1 } }, itemsByName: {} },
    blockAt: (p: any) => ({ name: p.x === hazardX && p.z === 0 && p.y === hazardY ? 'sweet_berry_bush' : p.y < 64 ? 'stone' : 'air' }) }
  const movements: any = { exclusionAreasStep: [], exclusionAreasPlace: [], blocksToAvoid: new Set() }
  tuneMovements(bot, movements)
  const cost = () => movements.exclusionAreasStep.reduce((n: number, f: any) => n + f({ position: new Vec3(0, 64, 0) }), 0)
  for (hazardY of [64, 65]) { assert.ok(cost() > 0); assert.ok(Number.isFinite(cost())) }
  hazardY = 64; hazardX = 1
  assert.ok(cost() > 0, 'native diagonal steering can clip an adjacent bush with the body edge')
  hazardY = 100
  assert.equal(cost(), 0)
})

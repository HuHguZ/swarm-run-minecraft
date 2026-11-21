import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { block, data, testBot } from './tick-plugins-fixture'
import { assist } from '../src/pvp/team-assist'
import { aim } from '../src/bow/ballistics'
import { createSwarmDriver } from '../../farm/swarm/swarm-driver'
import { installDangers } from '../../farm/arena/dangers'

function scene(interruptReply = false) {
  let now = 10000
  const p = (x, z) => new Vec3(x, 64, z), cells = new Map<string, any>(), results: any[] = []
  const ward = { id: 10, name: 'player', username: 'Ward', type: 'player', width: .6, height: 1.8, position: p(.5, .5),
    velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, metadata: [], equipment: [], onGround: true, isValid: true }
  const archer = { ...ward, id: 11, username: 'Archer', position: p(13.5, .5), yaw: Math.PI / 2, metadata: [], equipment: [{ name: 'bow' }] }
  archer.metadata[data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')] = 1
  archer.pitch = aim(archer.position.offset(0, 1.52, 0), () => ward.position.offset(0, 1.12, 0)).pitch
  const pos: any = {}, armor = { head: 'diamond_helmet', torso: 'diamond_chestplate', legs: 'diamond_leggings', feet: 'diamond_boots' }
  const faces = [[0,-1,0],[0,1,0],[0,0,-1],[0,0,1],[-1,0,0],[1,0,0]].map(([x,y,z]) => new Vec3(x,y,z))
  const builders = ['Near', 'Other'].map((name, i) => {
    const bot = testBot(), start = i ? p(2.5, 2.7) : p(-2.4, .5)
    Object.assign(bot.entity, { id: i + 1, position: start, username: name, name: 'player', type: 'player', width: .6, metadata: [] })
    bot.username = name; bot.health = 20
    // Both clients see the same floor. The first candidate has a hole underneath; the second is beyond Near's block reach.
    bot.blockAt = q => cells.get(q.floored().toString()) || block(q.y < 64 && !(Math.floor(q.x) === 1 && Math.floor(q.z) === 0) ? 'stone' : 'air', q)
    bot.world = { getBlock: bot.blockAt, raycast: require('prismarine-world/src/worldsync').prototype.raycast }
    bot.players = { Ward: { entity: ward }, Archer: { entity: archer } }; bot.entities = { 10: ward, 11: archer }
    bot.pathfinder = { setGoal() {} }
    const item = { name: 'cobblestone', count: 8, slot: 36, type: data.itemsByName.cobblestone.id }
    bot.inventory.slots[36] = bot.heldItem = item; bot.equip = async held => { bot.heldItem = held }
    bot.lookAt = bot.waitForTicks = async () => {}; bot.clearControlStates = bot.setControlState = () => {}
    require('mineflayer/lib/plugins/generic_place')(bot); require('mineflayer/lib/plugins/place_block')(bot)
    const write = bot._client.write
    bot._client.write = (cmd, packet) => {
      write(cmd, packet)
      if (cmd !== 'block_place') return
      const at = packet.location.plus(faces[packet.direction]), solid = block(item.name, at)
      cells.set(at.toString(), solid); bot._client.emit('block_change', { location: at, type: solid.stateId })
    }
    pos[name] = { p: start, hp: 20, armor, inv: { cobblestone: 8, diamond_sword: 1 } }
    return { name, team: 'blue', body: bot, c: { async call(method, params) {
      if (method !== 'assist' || params.mode !== 'wall') return { status: 'done', detail: {} }
      const result = await assist({ bot, require: () => bot }, params, { aborted: false, onAbort: [] })
      results.push({ name, ...result })
      return { status: interruptReply ? 'interrupted' : 'done', detail: result }
    } } }
  })
  for (const b of builders) for (const other of builders) if (b !== other) {
    b.body.players[other.name] = { entity: other.body.entity }
    b.body.entities[other.body.entity.id] = other.body.entity
  }
  const wardBot: any = { name: 'Ward', team: 'blue', c: { async call() { return {} } } }
  pos.Ward = { p: ward.position, hp: 5, armor, inv: { bread: 1 } }
  const bots = [wardBot, ...builders]
  const driver = createSwarmDriver({ bots, pos, now: () => now, alive: () => true, arena: { x: 0, y: 64, z: 0, r: 32 },
    home: () => ward.position, hostile: (_, n) => n === 'Archer', log() {} })
  installDangers({ bots: [wardBot], pos, busy: new Set(), out: new Set(), deadNow: new Set(), enemiesOf: () => [], log() {} } as any)
  const draw = (ms = 0) => {
    now += ms
    wardBot.c.onDanger({ pos: ward.position, observedAt: now, dangers: { aims: [{ name: 'Archer', weapon: 'bow', at: archer.position }] } })
    driver.observe(wardBot, [{ visible: true, id: 'Archer', position: archer.position, equipment: { weapon: 'bow', armor: [] } }])
  }
  return { driver, builders, pos, draw, results, cells, ward, archer }
}

test('an unchanged bow report hands an unreachable wall to the other builder', async () => {
  const f = scene()
  f.draw(); await f.driver.turn(f.builders[0])
  assert.deepEqual(f.results.map(r => r.why), ['нет открытой грани для заслона'])
  f.draw(100); await f.driver.turn(f.builders[0]); await f.driver.turn(f.builders[1])
  assert.deepEqual(f.results.map(r => r.name), ['Near', 'Other'])
  assert.equal(f.results[1].ok, true, f.results[1].why)
  assert.ok(f.results[1].cells.length)
})
test('an interrupted wall attempt does not report an unusable viewpoint to teammates', async () => {
  const f = scene(true)
  f.draw(); await f.driver.turn(f.builders[0])
  f.draw(100); await f.driver.turn(f.builders[0])
  assert.deepEqual(f.results.map(r => [r.name, r.why]), Array(2).fill(['Near', 'нет открытой грани для заслона']))
})
for (const change of ['builder moves', 'ward moves', 'archer moves', 'next sight window', 'new round']) {
  test(`the first wall builder can try again after ${change}`, async () => {
    const f = scene(), near = f.builders[0]
    f.draw(); await f.driver.turn(near)
    assert.equal(f.results[0].why, 'нет открытой грани для заслона')
    if (change === 'builder moves') f.pos.Near.p = near.body.entity.position = new Vec3(1.5, 64, 2.8)
    if (change === 'ward moves') f.pos.Ward.p = f.ward.position = f.ward.position.offset(-.8, 0, 0)
    if (change === 'archer moves') f.archer.position = f.archer.position.offset(1, 0, 0)
    if (change === 'new round') f.driver.reset()
    f.draw(change === 'next sight window' ? 1501 : 100)
    await f.driver.turn(near)
    assert.deepEqual(f.results.map(r => r.name), ['Near', 'Near'])
    if (change === 'builder moves') assert.equal(f.results[1].ok, true, f.results[1].why)
  })
}

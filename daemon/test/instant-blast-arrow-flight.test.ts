import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import * as pick from '../src/pick'
import { dangers } from '../src/threats'

const data = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')('1.21.11')

function flight(t: TestContext, kind = 'end_crystal', x = 3.5) {
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const stone = new Set<string>()
  const playerFlags = data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  const miner: any = Object.assign(new EventEmitter(), {
    id: 2, type: 'player', name: 'player', username: 'Miner', isValid: true, position: new Vec3(3.5, 64, -12.5),
    height: 1.8, width: .6, yaw: Math.PI, pitch: 0, metadata: [], equipment: [{ name: 'bow' }]
  })
  const explosive = { id: 5, name: kind, type: 'object', isValid: true, width: kind === 'end_crystal' ? 2 : .98,
    height: kind === 'end_crystal' ? 2 : .7, position: new Vec3(3.5, 64, .5) }
  const bot: any = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(), registry: data, game: { dimension: 'overworld' }, health: 20,
    entity: { id: 1, username: 'Observer', position: new Vec3(.5, 64, .5), height: 1.8, width: .6, yaw: 0, pitch: 0 },
    entities: { 2: miner, 5: explosive }, players: { Miner: { entity: miner, gamemode: 0 } },
    blockAt(p: Vec3) {
      const pos = p.floored()
      const name = pos.y === 63 || stone.has(pos.toString()) ? 'stone' : 'air'
      const block = Block.fromStateId(data.blocksByName[name].defaultState, 0)
      block.position = pos
      return block
    }
  })
  const height = kind === 'end_crystal' ? 65.12 : 64.52
  const arrow: any = Object.assign(new EventEmitter(), {
    id: 6, name: 'arrow', type: 'projectile', isValid: true, height: .5, width: .5,
    position: new Vec3(x, height, -8.5), metadata: []
  })
  const poll = () => dangers(bot, { foes: ['Miner'] })
  const release = () => {
    miner.metadata[playerFlags] = 0
    bot.entities[arrow.id] = arrow
    bot.emit('entitySpawn', arrow)
    poll()
  }
  const move = () => {
    timer.advanceTicks(1)
    arrow.position = arrow.position.offset(0, -.07, 3)
    arrow.emit('ndPositionObserved')
    bot.emit('physicsTick')
    return poll()
  }
  t.after(() => { bot.emit('end'); timer.dispose(); clock.activate(null) })
  return { bot, stone, miner, playerFlags, explosive, arrow, poll, release, move }
}

test('releasing the bow retains the blast alarm while the observed arrow will hit the crystal, even though it misses the observer', t => {
  const f = flight(t)
  f.miner.metadata[f.playerFlags] = 1
  assert.equal(f.poll().blasts[0]?.foe, 'Miner')
  f.release()
  const report = f.move()
  // Check the impact on the current 1.21.11 crystal box separately from the danger decision.
  const box = pick.hitboxOf(f.bot, f.explosive)
  const step = new Vec3(0, -.07, 3), second = step.scaled(.99).offset(0, -.05, 0)
  const firstDir = step.scaled(1 / step.norm()), secondDir = second.scaled(1 / second.norm())
  assert.equal(pick.rayBox(f.arrow.position, firstDir, box.lo, box.hi, step.norm()), null)
  const from = f.arrow.position.plus(step)
  const hit = pick.rayBox(from, secondDir, box.lo, box.hi, second.norm())
  assert.ok(hit != null)
  assert.ok(!pick.blockOnRay(f.bot, from, secondDir, hit))
  assert.deepEqual(report.arrows, [], 'the arrow does not fly toward this player')
  assert.equal(report.blasts.length, 1)
  assert.equal(report.blasts[0].id, f.explosive.id)
  assert.equal(report.blasts[0].projectile, f.arrow.id)
})

test('a wall or a miss ends the crystal threat even when the flying arrow is visible', t => {
  const blocked = flight(t)
  blocked.stone.add(new Vec3(3, 65, -2).toString())
  blocked.stone.add(new Vec3(3, 64, -2).toString())
  blocked.release()
  assert.deepEqual(blocked.move().blasts, [])
  const misses = flight(t, 'end_crystal', 5.7)
  misses.release()
  assert.deepEqual(misses.move().blasts, [])
})

test('an anonymous visible arrow needs fire to threaten a TNT cart', t => {
  const f = flight(t, 'tnt_minecart')
  delete f.bot.entities[f.miner.id]
  f.release()
  assert.deepEqual(f.move().blasts, [])
  f.arrow.metadata[data.entitiesByName.arrow.metadataKeys.indexOf('shared_flags')] = 1
  const reports = f.move().blasts
  assert.equal(reports.length, 1)
  assert.equal(reports[0].projectile, f.arrow.id)
  assert.equal(reports[0].foe, undefined)
})

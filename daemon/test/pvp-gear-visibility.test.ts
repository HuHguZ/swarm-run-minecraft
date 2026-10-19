import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { swarmSightings } from '../src/swarm-senses'
import { createLastSeen, gearPartVisible } from '../src/pvp/last-seen'

function scene() {
  let wall = true
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(.5, 0, .5), onGround: true },
    registry: (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11'),
    blockAt(p: Vec3) {
      const at = p.floored(), solid = wall && at.x === 3 && at.z === 0 && at.y >= 0 && at.y <= 1
      return { position: at, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, at.y === 1 ? .5 : 1, 1]] : [] }
    }
  })
  const raw: any = Object.assign(new EventEmitter(), {
    id: 2, username: 'Foe', type: 'player', name: 'player', position: new Vec3(4.5, 0, .5),
    height: 1.8, width: .6, isValid: true, onGround: true, metadata: [], equipment: []
  })
  for (const index of [9, 17]) Object.defineProperty(raw.metadata, index, { get() { throw new Error('hidden player health') } })
  bot.entities = { 1: bot.entity, 2: raw }
  return { bot, raw, setWall(value: boolean) { wall = value } }
}
const names = ['iron_sword', 'shield', 'iron_boots', 'iron_leggings', 'iron_chestplate', 'iron_helmet']
function secretBody(raw: any) {
  for (let i = 0; i < 5; i++) Object.defineProperty(raw.equipment, i, { configurable: true, get() { throw new Error(`hidden gear ${i}`) } })
  raw.equipment[5] = { name: 'netherite_helmet', componentMap: new Map([['enchantments', {}]]) }
}

test('head-only vision never reads covered weapon/armor slots or HP getters, including shared swarm observations', () => {
  const f = scene(); secretBody(f.raw)
  assert.equal(gearPartVisible(f.bot, f.raw, 5), true)
  for (let i = 0; i < 5; i++) assert.equal(gearPartVisible(f.bot, f.raw, i), false)
  const vision = createLastSeen(f.bot)
  const seen = vision.observe(f.raw)
  assert.ok(seen?._ndVisible)
  assert.equal(seen.equipment[5].name, 'netherite_helmet')
  assert.deepEqual(seen.equipment.slice(0, 5), [null, null, null, null, null])
  assert.equal(seen._ndUnknownArmorSlots, 3)
  const shared = swarmSightings(f.bot)
  assert.equal(shared[0].equipment.weapon, null)
  assert.deepEqual(shared[0].equipment.armor, ['netherite_helmet'])
  assert.equal(shared[0].equipment.unknownArmorSlots, 3)
  vision.close()
})

test('covered parts preserve previously observed gear and only newly visible parts refresh their memory', () => {
  const f = scene(); f.setWall(false)
  f.raw.equipment = names.map(name => ({ name, componentMap: new Map() }))
  const vision = createLastSeen(f.bot)
  const seen = vision.observe(f.raw)
  swarmSightings(f.bot)
  f.setWall(true); secretBody(f.raw)
  assert.equal(vision.observe(f.raw), seen)
  assert.equal(seen.equipment[0].name, 'iron_sword')
  assert.equal(seen.equipment[2].name, 'iron_boots')
  assert.equal(seen.equipment[4].name, 'iron_chestplate')
  assert.equal(seen.equipment[5].name, 'netherite_helmet')
  assert.equal(seen._ndUnknownArmorSlots, 0)
  const shared = swarmSightings(f.bot)[0]
  assert.equal(shared.equipment.weapon, 'iron_sword')
  assert.equal(shared.equipment.unknownArmorSlots ?? 0, 0)
  assert.ok(shared.equipment.armor.includes('iron_chestplate'))
  vision.close()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { swarmMethods } from '../src/rpc/swarm'

const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)

function scene(position: Vec3, at: Vec3, name = 'cobblestone', reference = at.offset(0, -1, 0)) {
  const cells = new Map<string, number>([[reference.toString(), registry.blocksByName.stone.defaultState]])
  const bot = Object.assign(new EventEmitter(), { version: '1.21.11', registry, health: 20, food: 20,
    _client: new EventEmitter(), entities: {}, players: {}, entity: { type: 'player', name: 'player', position,
      width: .6, height: 1.8, onGround: true, effects: {}, metadata: [] }, inventory: { items: () => [{ name, type: registry.itemsByName[name].id, count: 4 }] },
    blockAt: p => {
      const pos = p.floored(), state = cells.get(pos.toString()) ?? registry.blocksByName.air.defaultState
      const block = Block.fromStateId(state)
      block.position = pos
      return block
    } }) as any
  let clicks = 0, acknowledgements = 0
  bot.lookAt = async () => {}
  bot.equip = async i => { bot.heldItem = i }
  bot._placeBlockWithOptions = async (ref, face) => {
    assert.ok(ref.position.plus(face).equals(at))
    clicks++
    const old = bot.blockAt(at)
    const def = registry.blocksByName[name]
    let state = def.defaultState
    if (name === 'stone_slab') {
      assert.equal(face.y, 1)
      state = Block.fromProperties(def.id, { type: 'bottom' }).stateId
    }
    if (name === 'ladder') {
      assert.equal(face.x, -1)
      state = Block.fromProperties(def.id, { facing: 'west' }).stateId
    }
    cells.set(at.toString(), state)
    const block = bot.blockAt(at)
    const feet = bot.entity.position, height = bot.entity._ndPoseHeight ?? bot.entity.height
    assert.ok(block.shapes.every(([x0,y0,z0,x1,y1,z1]) =>
      feet.x + .3 <= at.x + x0 || feet.x - .3 >= at.x + x1 ||
      feet.y + height <= at.y + y0 || feet.y >= at.y + y1 ||
      feet.z + .3 <= at.z + z0 || feet.z - .3 >= at.z + z1), 'packet fits the placed state')
    acknowledgements++
    bot._client.emit('block_change', { location: at, type: block.stateId })
    bot.emit('blockUpdate', old, block)
  }
  const session = { bot, require: () => bot, runIntent: (_name, fn) => fn({ aborted: false, onAbort: [] }) }
  const rpc = swarmMethods({ session } as any)
  return { bot, clicks: () => clicks, acknowledgements: () => acknowledgements,
    place: () => rpc.swarm_work({ kind: 'place', item: name, at, timeoutSeconds: .6 }) }
}

test('a full block on the team1 deck respects the edge of the builder hitbox and a move during look', async () => {
  const cell = new Vec3(667,143,606)
  for (const duringLook of [false, true]) {
    const f = scene(new Vec3(667.65,143,duringLook ? 605.69 : 605.84), cell)
    if (duringLook) f.bot.lookAt = async () => { f.bot.entity.position.z = 605.84 }
    const r = await f.place()
    assert.equal(r.selfOccupied, true)
    assert.equal(r.done, false)
    assert.equal(f.clicks(), 0)
  }
  const clear = scene(new Vec3(667.65,143,605.7), cell)
  assert.equal((await clear.place()).done, true, 'touching the face leaves the empty cell available')
  assert.equal(clear.clicks(), 1)
})

test('the airborne crown reaches a third cell while crouching leaves clearance underneath it', async () => {
  const cell = new Vec3(1,66,0), position = new Vec3(1.5,64.35,.5)
  const standing = scene(position, cell, 'cobblestone', cell.offset(1,0,0))
  standing.bot.entity.onGround = false
  assert.equal((await standing.place()).selfOccupied, true)
  assert.equal(standing.clicks(), 0)
  const crouching = scene(position, cell, 'cobblestone', cell.offset(1,0,0))
  crouching.bot.entity._ndPoseHeight = 1.5
  assert.equal((await crouching.place()).done, true)
  assert.equal(crouching.clicks(), 1)
})

test('a bottom slab below the feet, a wall ladder and an empty collision shape allow the click', async () => {
  const cell = new Vec3(0,64,0)
  for (const [name, feet, ref] of [
    ['stone_slab', new Vec3(.5,64.5,.5), cell.offset(0,-1,0)],
    ['ladder', new Vec3(.5,64,.5), cell.offset(1,0,0)],
    ['cobweb', new Vec3(.5,64,.5), cell.offset(1,0,0)]
  ] as const) {
    const f = scene(feet, cell, name, ref)
    const result = await f.place()
    assert.equal(f.clicks(), 1, name)
    assert.equal(f.acknowledgements(), 1, name)
    if (name !== 'cobweb') assert.equal(result.done, true, name)
  }
})

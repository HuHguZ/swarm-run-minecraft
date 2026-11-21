import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { pearlStandGallery } from './pearl-stand-fixture'
import { activate, GameClock } from '../src/game-clock'

let game: GameClock
test.beforeEach(() => { game = activate(new GameClock({ manual: true })) })
test.afterEach(() => { game.dispose(); activate(null) })

for (const [from, target] of [[-.99,-.75],[-1.5,-.5]]) test(`a native short walk from z=${from} restores a teammate's observed pearl arc`, async t => {
  const f = pearlStandGallery(from)
  assert.equal((await f.preview()).ok, false)
  const r = await f.walk(target)
  assert.ok(r.ok, JSON.stringify(r)); assert.ok(Math.abs(r.at.z - target) <= .08)
  assert.deepEqual(r.at, { ...f.bot.entity.position }); assert.equal(r.ticks, f.frames.length)
  assert.ok(f.frames.length > 0 && f.frames.every(s => !s.control.jump && s.onGround && s.pos.y === 120))
  assert.deepEqual((await f.preview()).feet, new Vec3(16.5,124,4.5))
  t.diagnostic(`actual z=${r.at.z.toFixed(5)}, ${r.ticks} physics ticks`)
})

for (const event of ['enemy', 'ground lost', 'hurt', 'cancelled', 'new owner', 'window opened']) test(`walking releases the launch point on ${event}`, async () => {
  const f = pearlStandGallery(-1.5)
  f.bot.once('nd_parkour', () => {
    if (event === 'enemy') {
      const foe = { id: 2, username: 'Knight', type: 'player', name: 'player', isValid: true, metadata: [], height:1.8, width:.6,
        position: new Vec3(1.5,120,-.5), equipment: [{ name:'netherite_sword' }] }
      f.bot.entities[2] = foe; f.bot.players.Knight = { entity: foe }
    }
    if (event === 'ground lost') {
      const before = f.bot.blockAt
      f.bot.blockAt = p => p.floored().z === -1 && p.floored().y === 119 ? before(new Vec3(-50, 105, -50)) : before(p)
    }
    if (event === 'hurt') f.bot.health -= 2
    if (event === 'cancelled') { f.ctl.aborted = true; for (const stop of [...f.ctl.onAbort]) stop() }
    if (event === 'new owner') {
      f.session.current = { ctl: { aborted:false, onAbort:[] } }
      f.bot.clearControlStates(); f.bot.setControlState('right',true)
    }
    if (event === 'window opened') f.bot.currentWindow = { title: 'Chest' }
  })
  const r = await f.walk(-.5)
  assert.equal(r.ok, false, JSON.stringify(r)); assert.ok(r.ticks > 0)
  assert.equal(f.bot.getControlState('forward'), false)
  assert.equal(f.bot.getControlState('right'), event === 'new owner')
  if (event === 'ground lost') assert.ok(r.at.z < -1 && r.at.y === 120, 'no step onto the newly exposed gap')
  else assert.equal(r.ticks, 1)
})

test('a swordsman on the other side of the wall does not block a visible launch footing', async () => {
  const f = pearlStandGallery(), original = f.bot.blockAt
  f.bot.blockAt = p => {
    const c = p.floored()
    if (c.x === 1 && c.y >= 120 && c.y <= 122) {
      const stone = original(new Vec3(0,119,0)); return { name:'stone', position:c, type:stone.type, shapes:stone.shapes, boundingBox:'block' }
    }
    return original(p)
  }
  const foe = { id:2, username:'Knight', type:'player', position:new Vec3(2.25,120,-.75), metadata:[], width:.6, height:1.8,
    get equipment() { throw new Error('hidden sword inspected') } }
  f.bot.players.Knight = { entity: foe }; f.bot.entities[2] = foe
  assert.equal((await f.walk()).ok, true)
})

test('twenty distant hunters do not need a sight ray for the short step', async t => {
  const f = pearlStandGallery()
  for (let id = 2; id < 22; id++) {
    const e = { id, name:'player', type:'player', username:`Far${id}`, position:new Vec3(16 + id,120,-.5) }
    f.bot.players[e.username] = { entity: e }; f.bot.entities[id] = e
  }
  const sight = t.mock.method(require('../src/pvp/last-seen'), 'seesPlayer')
  assert.equal((await f.walk()).ok, true)
  assert.equal(sight.mock.callCount(), 0)
})

test('already settled on visible launch footing consumes zero motion ticks', async () => {
  const f = pearlStandGallery(-.75)
  const r = await f.walk()
  assert.equal(r.ok, true); assert.equal(r.ticks, 0); assert.equal(f.frames.length, 0)
  assert.equal(f.bot.entity.position.z, -.75)
})

for (const obstacle of ['unknown', 'missing support', 'magma', 'wall', 'arena boundary']) test(`precise launch footing rejects ${obstacle} before taking a step`, async () => {
  const f = pearlStandGallery(-1.5), original = f.bot.blockAt
  if (obstacle === 'arena boundary') f.arena.killY = 120
  else f.bot.blockAt = p => {
    const c = p.floored()
    if (c.z === -1) {
      if (obstacle === 'unknown') return null
      if (obstacle === 'missing support' && c.y === 119) return original(new Vec3(-99,100,-99))
      if (obstacle === 'wall' && c.y === 120 || obstacle === 'magma' && c.y === 119) {
        const b = original(new Vec3(0,119,0)); return { name: obstacle === 'magma' ? 'magma_block' : 'stone', position:c, shapes:b.shapes, boundingBox:'block', type:b.type }
      }
    }
    return original(p)
  }
  const r = await f.walk(-.5)
  assert.equal(r.ok, false); assert.equal(f.frames.length, 0); assert.equal(f.bot.entity.position.z, -1.5)
})

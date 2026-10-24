import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as edges from '../src/edges'
import { fireWind } from '../src/mace/hands'
import { allyOnSegment } from '../src/combat/ally-safety'
import { windReleaseSafe } from '../src/combat/wind-safety'
import { windTeamSafe } from '../src/combat/enemy-wind'
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()

function fixture(edge = false, lowerFloor?: number, edgeX = 2) {
  const controls = { ...edges.IDLE }, shots: any[] = []
  const world = { getBlock(p: Vec3) {
    const floor = p.y < 1 && (!edge || p.x >= -8 && p.x < edgeX && Math.abs(p.z) < 8) || lowerFloor !== undefined && p.y < lowerFloor
    const b = Block.fromStateId(registry.blocksByName[floor ? 'stone' : 'air'].defaultState)
    b.position = p.floored(); return b
  } }
  const charge = { name: 'wind_charge', count: 64, slot: 36 }
  const bot: any = Object.assign(new EventEmitter(), {
    username: 'A', version: '1.21.11', registry, game: { minY: -64, height: 384 }, health: 20, food: 20,
    inventory: { slots: Array(46).fill(null), items: () => [charge] }, quickBarSlot: 0, entities: {},
    _client: new EventEmitter(), _ndSwarmAllies: ['B'],
    entity: { id: 1, username: 'A', position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      height: 1.8, width: .6, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    blockAt: (p: Vec3) => world.getBlock(p), physics: native.Physics(registry, world),
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    setQuickBarSlot: (slot: number) => { bot.quickBarSlot = slot },
    getControlState: (key: string) => controls[key],
    activateItem: () => shots.push({ yaw: bot.entity.yaw, pitch: bot.entity.pitch })
  })
  bot.inventory.slots[36] = charge
  const ally = (position: Vec3, velocity = new Vec3(0, 0, 0)) => {
    const metadata: any[] = []
    Object.defineProperty(metadata, 9, { get() { throw new Error('allied HP metadata is not a radio report') } })
    const e = { id: 2, username: 'B', type: 'player', position, velocity, onGround: true,
      width: .6, height: 1.8, yaw: 0, metadata, _ndVisible: true }
    bot.entities[2] = e; return e
  }
  return { bot, shots, ally }
}

test('wind release: an allied direct body hit cannot spend unknown HP', async () => {
  const f = fixture(); f.ally(new Vec3(2.5, 1, .5))
  const result = await fireWind(f.bot, () => ({ yaw: -Math.PI / 2, pitch: 0 }), { immediate: true })
  assert.equal(result.fired, false)
  assert.equal(f.shots.length, 0)
  assert.equal(f.bot._ndWindCd, undefined, 'a rejected release must not spend its charge/cooldown')
})

test('wind release: clear self ray still rejects native splash that drops an ally into the void', async () => {
  const f = fixture(true); f.ally(new Vec3(1.65, 1, .5))
  const result = await fireWind(f.bot, () => ({ yaw: 0, pitch: -Math.PI / 2 }), { immediate: true })
  assert.equal(result.fired, false)
  assert.equal(f.shots.length, 0)
})

test('wind release: harmless nearby splash is allowed with unknown allied HP', async () => {
  const f = fixture(); f.ally(new Vec3(1.65, 1, .5))
  const result = await fireWind(f.bot, () => ({ yaw: 0, pitch: -Math.PI / 2 }), { immediate: true })
  assert.equal(result.fired, true)
  assert.equal(f.shots.length, 1)
})

test('wind release: moving allied bodies are checked at projectile arrival', async () => {
  const f = fixture(); f.ally(new Vec3(1.4, 1, .5), new Vec3(-.45, 0, 0))
  const result = await fireWind(f.bot, () => ({ yaw: 0, pitch: -Math.PI / 2 }), { immediate: true })
  assert.equal(result.fired, false)
  assert.equal(f.shots.length, 0)
})

test('wind release: the packet callback checks the latest allied pose again', async () => {
  const f = fixture()
  const pending = fireWind(f.bot, () => ({ yaw: -Math.PI / 2, pitch: 0 }), { immediate: true })
  f.ally(new Vec3(2.5, 1, .5))
  const result = await pending
  assert.equal(result.fired, false)
  assert.equal(f.shots.length, 0)
})

test('wind release: native wind forgiveness does not excuse a lower damaging landing', async () => {
  const f = fixture(true, -7); f.ally(new Vec3(1.65, 1, .5))
  const result = await fireWind(f.bot, () => ({ yaw: 0, pitch: -Math.PI / 2 }), { immediate: true })
  assert.equal(result.fired, false)
})

test('wind release: an enemy body burst also prices allied splash beyond the intended victim', async () => {
  const f = fixture(true, undefined, 4); f.ally(new Vec3(3.7, 1, .5))
  f.bot.entities[3] = { id: 3, username: 'Enemy', type: 'player', position: new Vec3(2.5, 1, .5),
    velocity: new Vec3(0, 0, 0), onGround: true, width: .6, height: 1.8, _ndVisible: true }
  const result = await fireWind(f.bot, () => ({ yaw: -Math.PI / 2, pitch: -.3 }), { immediate: true })
  assert.equal(result.fired, false)
})

test('wind release: native bounded dispersion can hit an ally beside the centre ray', async () => {
  const f = fixture(), ally = f.ally(new Vec3(2.5, 1, .84))
  f.bot.entities[3] = { id: 3, username: 'Enemy', type: 'player', position: new Vec3(4.5, 1, .5),
    velocity: new Vec3(0, 0, 0), onGround: true, width: .6, height: 1.8, _ndVisible: true }
  assert.equal(allyOnSegment(f.bot, [ally], new Vec3(.5, 2.62, .5), new Vec3(3.5, 2.62, .5), 0, 2, 0), null)
  assert.equal(windReleaseSafe(f.bot, { yaw: -Math.PI / 2, pitch: 0 }, new Vec3(0, 0, 0)), false)
})

test('wind release: thirty distant teammates still allow harmless splash', t => {
  const f = fixture()
  f.bot._ndSwarmAllies = []
  for (let i = 0; i < 30; i++) {
    const name = `Ally${i}`
    f.bot._ndSwarmAllies.push(name)
    f.bot.entities[i + 2] = { id: i + 2, username: name, type: 'player', position: new Vec3(8 + i, 1, 4),
      velocity: new Vec3(0, 0, 0), onGround: true, width: .6, height: 1.8, _ndVisible: true }
  }
  const start = performance.now()
  assert.equal(windReleaseSafe(f.bot, { yaw: 0, pitch: -Math.PI / 2 }, new Vec3(0, 0, 0)), true)
  t.diagnostic(JSON.stringify({ thirtyAlliesMs: performance.now() - start }))
})

test('wind release: hidden Blast Protection may turn a safe long jump into a void fall', () => {
  const f = fixture(true), ally = f.ally(new Vec3(1.65, 1, .5))
  f.bot.blockAt = (p: Vec3) => {
    const floor = p.y < 1 && (p.x >= -8 && p.x < 2 || p.x >= 3 && p.x < 8)
    const b = Block.fromStateId(registry.blocksByName[floor ? 'stone' : 'air'].defaultState)
    b.position = p.floored(); return b
  }
  Object.defineProperty(ally, 'attributes', { get() { throw new Error('remote attributes are not own radio evidence') } })
  const report = { id: 'B', position: ally.position, velocity: new Vec3(0, 0, 0), onGround: true }
  const safe = [0, .5, 1].map(value => windTeamSafe(f.bot, [{ ...report,
    attributes: { 'minecraft:explosion_knockback_resistance': { value } } }],
  [{ ticks: 2, burst: new Vec3(.5, 1.25, .5) }], undefined, new Map(), true))
  assert.deepEqual(safe, [true, false, true], 'both interval endpoints are safe; its middle falls into the real one-block gap')
  assert.equal(windReleaseSafe(f.bot, { yaw: 0, pitch: -Math.PI / 2 }, new Vec3(0, 0, 0)), false)
})

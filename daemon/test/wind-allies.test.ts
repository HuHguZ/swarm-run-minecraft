import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as edges from '../src/edges'
import { fireWind } from '../src/mace/hands'
import { allyOnSegment } from '../src/combat/ally-safety'
import { windReleaseSafe } from '../src/combat/wind-safety'
import { enemyWindShot, windTeamSafe } from '../src/combat/enemy-wind'
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

test('wind release: a safe native wall impact beyond thirty ticks is not an artificial range veto', () => {
  const f = fixture(); f.ally(new Vec3(.5, 1, 5.5))
  const blockAt = f.bot.blockAt
  f.bot.blockAt = (p: Vec3) => {
    if (p.x < 50) return blockAt(p)
    const b = Block.fromStateId(registry.blocksByName.stone.defaultState)
    b.position = p.floored(); return b
  }
  assert.equal(windReleaseSafe(f.bot, { yaw: -Math.PI / 2, pitch: 0 }, new Vec3(0, 0, 0)), true)
  f.ally(new Vec3(40.5, 1, .5))
  assert.equal(windReleaseSafe(f.bot, { yaw: -Math.PI / 2, pitch: 0 }, new Vec3(0, 0, 0)), false, 'a distant allied body still forbids the same native trajectory')
})

test('wind release: explicit visible allies retain native safety without changing membership', () => {
  const f = fixture(true); f.ally(new Vec3(1.65, 1, .5)); f.bot._ndSwarmAllies = []
  const aim = { yaw: 0, pitch: -Math.PI / 2 }, still = new Vec3(0, 0, 0)
  assert.equal(windReleaseSafe(f.bot, aim, still), true, 'an unconfigured name is not silently assumed to be a teammate')
  assert.equal(windReleaseSafe(f.bot, aim, still, undefined, ['B', 'B']), false, 'explicit teammate cannot be pushed into the void')
  assert.deepEqual(f.bot._ndSwarmAllies, [], 'request-local identities never mutate global team membership')
  const safe = fixture(); safe.ally(new Vec3(1.65, 1, .5)); safe.bot._ndSwarmAllies = []
  assert.equal(windReleaseSafe(safe.bot, aim, still, undefined, ['B']), true, 'nearby harmless native splash remains legal')
})

test('wind release: explicit ally identity keeps receiver and fair visibility exclusions', () => {
  const f = fixture(); const ally = f.ally(new Vec3(2.5, 1, .5)); f.bot._ndSwarmAllies = []
  const aim = { yaw: -Math.PI / 2, pitch: 0 }, still = new Vec3(0, 0, 0)
  assert.equal(windReleaseSafe(f.bot, aim, still, undefined, ['B']), false)
  assert.equal(windReleaseSafe(f.bot, aim, still, 'B', ['B']), true)
  ally._ndVisible = false
  assert.equal(windReleaseSafe(f.bot, aim, still, undefined, ['B']), true, 'name alone does not reveal a hidden body')
  ally._ndVisible = true; f.bot.players = { B: { gamemode: 3 } }
  assert.equal(windReleaseSafe(f.bot, aim, still, undefined, ['B']), true, 'spectators have no colliding teammate body')
})

test('wind release: native world-ceiling removal checks its actual explosion instead of an imagined distant ray', () => {
  const f = fixture(); f.bot.entity.position.y = 349; f.bot.entity.onGround = false
  f.ally(new Vec3(.5, 349, 5.5))
  const aim = { yaw: -Math.PI / 2, pitch: 0 }, still = new Vec3(0, 0, 0)
  assert.equal(windReleaseSafe(f.bot, aim, still), true, 'the native immediate explosion misses this ally')
  f.ally(new Vec3(1.65, 349, .5))
  assert.equal(windReleaseSafe(f.bot, aim, still), false, 'the same native explosion cannot spend an airborne ally safety')
})

test('wind release: a visible gliding ally keeps its native flight through a future wall splash', () => {
  const f = fixture(); f.bot.entity.position.y = 31; f.bot.entity.onGround = false
  const ally: any = f.ally(new Vec3(38, 34, 2.2), new Vec3(-1.4, -.2, 0))
  ally.onGround = false; ally.elytraFlying = true; ally.metadata[0] = 128
  ally.height = .6; ally.yaw = Math.PI / 2; ally.pitch = 0
  const blockAt = f.bot.blockAt
  f.bot.blockAt = (p: Vec3) => {
    if (Math.floor(p.x) !== 20 || Math.floor(p.z) !== 0) return blockAt(p)
    const b = Block.fromStateId(registry.blocksByName.stone.defaultState); b.position = p.floored(); return b
  }
  assert.equal(windReleaseSafe(f.bot, { yaw: -Math.PI / 2, pitch: 0 }, new Vec3(0, 0, 0)), false,
    'the flyer is still beside the later burst, and an affected safe landing is not known')
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

test('wind enemy shot: a moving allied glider can intercept at the muzzle between native phases', () => {
  const { bot } = fixture()
  const position = new Vec3(558.6483875898844, 137.08280404168002, 606.9868680089414)
  const velocity = new Vec3(-1.424350938583181, .4934868067938324, .18091654138187296)
  Object.assign(bot.entity, { position, velocity, onGround: false, elytraFlying: true, height: .6 })
  const gameTick = 15781146
  bot.ndClock = { age: BigInt(gameTick), ticks: 0, serverTicks: 0 }
  const own = { id: 'A', position, velocity, launchMovement: velocity, gliding: true, onGround: false, eyeHeight: .4,
    gameTick, yaw: 1.2855342160617995, pitch: .33689696106835587 }
  const foe = { id: 3, username: 'Red', type: 'player', position: new Vec3(545.2128, 140.8817, 605.7942), width: .6, height: 1.8 }
  const frames = Array.from({ length: 10 }, () => ({ pos: foe.position.clone(), vel: new Vec3(0, 0, 0), onGround: false }))
  const ally = { id: 'B', position: new Vec3(559.5904010759807, 136.52864256501198, 606.5931156718041),
    velocity: new Vec3(-1.237060546875, .611572265625, .277099609375), gliding: true, onGround: false,
    gameTick, yaw: 1.6718714155573715, pitch: .2799873417611347, eyeHeight: .4 }
  const shot = (report = ally) => enemyWindShot(bot, foe, own, frames, { height: 1.6, allies: [report] })

  assert.equal(shot(), null, 'the next simulated glider overlaps the muzzle, but the preceding native phase may enter it')
  assert.equal(shot({ ...ally, position: ally.position.offset(0, 0, .75) })?.ticks, 5, 'a clear neighboring lane is unchanged')
  assert.equal(shot({ ...ally, position: ally.position.offset(0, -.32, 0) })?.ticks, 5, 'the muzzle is above the native .6-tall gliding collider')
  assert.equal(shot({ ...ally, velocity: new Vec3(0, 0, 0) })?.ticks, 5, 'a glider behind the muzzle does not veto the shot')
})

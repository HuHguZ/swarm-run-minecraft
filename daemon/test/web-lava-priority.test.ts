import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { burningFeet, escapeBurn } from '../src/pvp/lava-exit'
import { fireTurn, webTurn } from '../src/pvp/turn-hazards'
import { createTerrain } from '../src/pvp/terrain'
import { installDangers } from '../../farm/arena/dangers'
import { Block, native, registry, worldOf } from './parkour-fixture'

function fixture (lavaY = 1) {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) cells.push([x, 0, z, 'stone'])
  cells.push([0, lavaY, 0, 'lava'], [1, 1, 0, 'cobweb'])
  const { bot, world } = worldOf(cells)
  bot.entity.position = new Vec3(.71, 1, .5)
  bot.entity.isInWeb = true
  bot.game.dimension = 'overworld'
  bot.inventory.items = () => ['water_bucket', 'ender_pearl'].map(name => ({ name, type: registry.itemsByName[name].id, count: 1 }))
  let keys: Record<string, boolean> = {}, time = 0, cuts = 0, waterAttempts = 0
  bot.setControlState = (key, value) => { keys[key] = value }
  bot.getControlState = key => !!keys[key]
  bot.clearControlStates = () => { keys = {} }
  bot.look = async yaw => { bot.entity.yaw = yaw }
  bot.lookAt = async target => { const d = target.minus(bot.entity.position); bot.entity.yaw = Math.atan2(-d.x, -d.z) }
  const now = () => time
  const sleep = async ms => {
    for (let tick = 0; tick < Math.ceil(ms / 50); tick++) {
      time += 50
      const state = new native.PlayerState(bot, keys)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
    }
  }
  const ctx: any = { bot, ctl: { aborted: false, onAbort: [] }, entity: { position: new Vec3(5.5, 1, .5) }, prof: { player: true },
    aim: 'target', pathTo() {}, clear: () => bot.clearControlStates(), set: bot.setControlState, holdWeapon: async () => {}, holdItem: async () => true,
    tt: { threats: () => [] }, mc: { threat: () => null }, pendingWater: [], routeInputs: () => 'web-and-lava', st: {},
    ready: () => false, rest() {}, used() {}, useOnGroundAt: async () => { waterAttempts++; return false }, sleep, digWatch: async () => { cuts++; return 'test cut boundary' } }
  return { bot, world, ctx, now, sleep, cuts: () => cuts, waterAttempts: () => waterAttempts, frame: { me: bot.entity.position, r: 5 } as any }
}

test('combat web work does not suppress an available native lava escape, while fire resistance retains web work', async t => {
  for (const lavaY of [1, 2]) {
    const control = fixture(lavaY)
    assert.equal((await escapeBurn(control.bot, { now: control.now, sleep: control.sleep })).ok, true, 'real native movement can escape this partial web and lava')
    assert.equal(control.bot.entity.isInLava, false, 'the full native body must leave lava, not only its centre cell')
    assert.ok(control.now() <= 1500, 'the full exit is available within the existing emergency turn')
    const f = fixture(lavaY)
    let pathStopped = false
    f.ctx.pathing = true
    f.ctx.pathTo = on => { assert.equal(on, false); pathStopped = true }
    t.mock.method(clock, 'now', f.now)
    await webTurn(f.ctx, f.frame)
    assert.equal(pathStopped, true, 'the old path must not overwrite rescue controls')
    assert.equal(f.cuts(), 0, `a twenty-second hand cut must not consume the emergency turn, lavaY=${lavaY}`)
    assert.equal(f.waterAttempts(), 1, 'a refused water placement retains the real movement alternative')
    assert.equal(burningFeet(f.bot), false)
    assert.equal(f.bot.entity.isInLava, false, `the admitted fire turn must finish the physical lava exit, lavaY=${lavaY}`)
  }
  const protectedBody = fixture()
  protectedBody.bot.entity.effects[registry.effectsByName.FireResistance.id] = { amplifier: 0, duration: 200 }
  await webTurn(protectedBody.ctx, protectedBody.frame)
  assert.equal(protectedBody.cuts(), 1, 'confirmed fire resistance permits the ordinary web plan')
})

test('ordinary burning retains its close-foe and web water guards', async () => {
  const f = fixture(), readBlock = f.bot.blockAt
  f.bot.blockAt = p => { const b = readBlock(p); return b.name === 'lava' ? { ...b, name: 'air' } : b }
  f.bot.entity.metadata = { 0: 1 }; f.bot.findBlocks = () => []
  f.frame.r = 3; f.frame.meInWeb = true
  await fireTurn(f.ctx, f.frame)
  assert.equal(f.waterAttempts(), 0)
})

test('costly native lava escape offers a survivable pearl once, while a refused throw retains the remaining walk', async t => {
  for (const costly of [false, true]) {
    const f = fixture(2), attempts: Array<{ at: number, hp: number }> = []
    f.bot.health = 20
    f.ctx.useOnGroundAt = async () => { f.bot.health -= 4; return false }
    f.ctx.escapePearl = async options => {
      assert.equal(options.jump, false)
      attempts.push({ at: f.now(), hp: f.bot.health })
      return null // The actual movement, not a fake teleport success, must finish this exit.
    }
    f.ctx.sleep = async ms => {
      for (let tick = 0; tick < Math.ceil(ms / 50); tick++) {
        await f.sleep(50)
        if (costly && f.now() % 500 === 0 && burningFeet(f.bot)) f.bot.health -= 4
      }
    }
    t.mock.method(clock, 'now', f.now)
    await webTurn(f.ctx, f.frame)
    assert.equal(attempts.length, costly ? 1 : 0, 'observed lava loss must exceed the existing five-HP pearl cost')
    if (costly) assert.deepEqual(attempts[0], { at: 500, hp: 12 }, 'reconsider before a bounded walk consumes the remaining survivable HP')
    assert.equal(burningFeet(f.bot), false, 'a refused or unavailable pearl must preserve the remaining native exit')
    assert.equal(f.bot.entity.isInLava, false)
    assert.ok(f.now() <= 1500, 'a failed alternative must not restart the original movement budget')
  }
})

test('lava with no local dry exit still offers the available pearl before a passive-foe hand cut', async t => {
  const f = fixture(2), readBlock = f.bot.blockAt
  f.bot.blockAt = p => p.y === 2 && Math.abs(p.x) <= 4 && Math.abs(p.z) <= 4 ? readBlock(new Vec3(0, 2, 0)) : readBlock(p)
  let attempts = 0
  f.ctx.escapePearl = async options => { assert.equal(options.rescue, true); attempts++; return null }
  t.mock.method(clock, 'now', f.now)
  await webTurn(f.ctx, f.frame)
  assert.equal(attempts, 1, 'an unavailable walk has no cheaper finite exit price')
  assert.equal(f.cuts(), 0, 'zero damage from a passive enemy must not hide the lava emergency')
  assert.equal(burningFeet(f.bot), true, 'a refused throw must not report a successful exit')
  assert.equal(f.ctx.failedOutOfFire?.why, 'hazard_not_left')
})

test('post-rescue fire recovery rejects head-lava water and routes a blocked approach instead of running back through it', async t => {
  for (const hazard of ['target', 'approach', 'none', 'hot']) {
    const f = fixture(), pool = new Vec3(0, 1, 0)
    const block = (p, name) => { const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = p.floored(); return b }
    f.bot.blockAt = p => {
      const q = p.floored()
      if (q.y === 0) return block(q, hazard === 'hot' && q.x === -1 && q.z === 4 ? 'magma_block' : 'stone')
      if (q.equals(pool)) return block(q, 'water')
      if (hazard === 'target' && q.equals(pool.offset(0, 1, 0)) || hazard === 'approach' && q.equals(new Vec3(0, 2, 2))) return block(q, 'lava')
      return block(q, 'air')
    }
    f.world.getBlock = f.bot.blockAt
    f.bot.entity.position = new Vec3(-.56937140051, 1, 4.312052081506)
    f.bot.entity.metadata = { 0: 1 }; f.bot.entity.isInWeb = false
    f.bot.inventory.items = () => []; f.bot.findBlocks = () => [pool]
    f.ctx.entity.position = new Vec3(5.5, 1, 4.312052081506) // The foe line is clear; the actual water line is not.
    f.ctx.Vec3 = Vec3; f.ctx.blockName = (_bot, p) => f.bot.blockAt(p).name
    f.ctx.solid = (_bot, p) => f.bot.blockAt(p).boundingBox === 'block'
    f.ctx.hazardOnLine = createTerrain(f.ctx).hazardOnLine
    let forward = false, path = false, contacts = 0
    const set = f.ctx.set
    f.ctx.set = (key, value) => { if (key === 'forward' && value) forward = true; set(key, value) }
    f.ctx.pathTo = on => { if (on) path = true }
    f.ctx.sleep = async ms => { await f.sleep(ms); if (burningFeet(f.bot)) contacts++ }
    f.frame.me = f.bot.entity.position; f.frame.r = 6
    t.mock.method(clock, 'now', f.now)
    await fireTurn(f.ctx, f.frame)
    assert.equal(forward, hazard === 'none' || hazard === 'hot', `raw water approach: ${hazard}`)
    assert.equal(path, hazard === 'approach', 'safe water behind a hazard retains the existing native route alternative')
    if (hazard !== 'hot') assert.equal(contacts, 0, 'extinguishing must not create another actual lava contact')
    if (hazard === 'none' || hazard === 'hot') assert.equal(f.bot.entity.isInWater, true, 'the unobstructed native water approach still works, including leaving a hot floor')
  }
})

test('native lava contact remains burning after the centre cells become air', async t => {
  const f = fixture(2)
  f.bot.entity.position = new Vec3(-.02, 1.67, .5)
  f.bot.entity.isInLava = true
  assert.equal(f.bot.blockAt(f.bot.entity.position.floored()).name, 'air')
  assert.equal(f.bot.blockAt(f.bot.entity.position.floored().offset(0, 1, 0)).name, 'air')
  assert.equal(burningFeet(f.bot), true, 'native body contact must keep the rescue running')
  f.bot.entity.isInLava = false
  assert.equal(burningFeet(f.bot), true, 'the contracted native flag can clear before the full body edge')
  f.bot.entity.position = new Vec3(-.5, 1, .5)
  assert.equal(burningFeet(f.bot), false)
  f.bot.entity.position = new Vec3(-.02, 1.67, .5)
  f.frame.me = f.bot.entity.position
  t.mock.method(clock, 'now', f.now)
  assert.equal(await fireTurn(f.ctx, f.frame), 'next', 'body-edge contact must still admit the fire rescue')
  assert.equal(f.bot.entity.isInLava, false, 'the real native body must completely clear the source')
  assert.equal(burningFeet(f.bot), false)
})

test('the captured Paper edge remains lava contact when the contracted native fluid box is already dry', () => {
  const f = fixture(2)
  f.bot.entity.position = new Vec3(-.243467399658, 2.492841746895, .406881311286)
  f.bot.entity.isInLava = false; f.bot.entity.onGround = false
  assert.equal(f.bot.blockAt(f.bot.entity.position.floored()).name, 'air')
  assert.equal(f.bot.blockAt(f.bot.entity.position.floored().offset(0, 1, 0)).name, 'air')
  assert.equal(burningFeet(f.bot), true, 'the full body edge still intersects the observed head source')
})

test('a pending web reaction cannot swallow fresh lava contact and prevent the same native escape', async () => {
  const f = fixture(), calls: string[] = []
  const b: any = { name: 'A', team: 'red', last: { m: 'goto', pending: false }, c: { call(method, params) {
    calls.push(method); b.last = { m: method, p: params, pending: true }
    return method === 'lava_escape' ? escapeBurn(f.bot, { now: f.now, sleep: f.sleep }) : new Promise(() => {})
  } } }
  const ctx: any = { round: 1, bots: [b], pos: { A: { p: f.bot.entity.position, inv: { water_bucket: 1, ender_pearl: 1 } } },
    busy: new Set(), out: new Set(), deadNow: new Set(), log() {},
    enemiesOf: () => [{ n: 'Enemy', mob: false, d: 3.9, p: { x: 4, y: 1, z: .5 } }],
    swarmDriver: { panic: () => false, canEngage: () => true } }
  installDangers(ctx)
  const web = [{ at: { x: 1, y: 1, z: 0 }, cells: 1 }]
  b.c.onDanger({ pos: ctx.pos.A.p, observedAt: 1, dangers: { web } })
  assert.deepEqual(calls, ['fight'])
  b.c.onDanger({ pos: ctx.pos.A.p, observedAt: 2, dangers: { web, lava: [{ at: { x: 0, y: 1, z: 0 }, d: 0 }] } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['fight', 'lava_escape'])
  assert.equal(burningFeet(f.bot), false, 'the admitted rescue actually moves the native body out')
})

test('real water placement precedes a spreading lava walk despite web, close foe and an unset fire flag', async t => {
  for (const lavaY of [1, 2]) {
    const f = fixture(lavaY), updates = new Map<string, any>(), readBlock = f.world.getBlock.bind(f.world)
    const put = (p, name) => { const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = p; updates.set(p.toString(), b) }
    f.world.getBlock = p => updates.get(p.floored().toString()) || readBlock(p)
    let waterAt: number | null = null, uses = 0, water = true
    f.bot.entity.metadata = { 0: 0 }
    f.bot.entity.isInLava = true
    f.ctx.Vec3 = Vec3; f.ctx.gameClock = { now: f.now }; f.ctx.blockName = (_bot, p) => f.bot.blockAt(p).name
    f.ctx.findItem = (_bot, pred) => f.bot.inventory.items().find(pred)
    f.ctx.holdItem = async item => { f.bot.heldItem = item; return true }
    f.bot.inventory.items = () => [{ name: water ? 'water_bucket' : 'bucket', slot: 36, count: 1 }]
    const cell = new Vec3(0, 1, 0)
    // The protocol fixture exposes the visible floor face; the real bucket helper must observe its liquid receipt.
    f.ctx.bucketLanding = () => ({ cell })
    f.bot.activateItem = () => { uses++; if (water) { waterAt = f.now(); water = false; put(cell, 'water') } else { water = true; put(cell, 'air') } }
    const terrain = createTerrain(f.ctx)
    f.ctx.useOnGroundAt = terrain.useOnGroundAt; f.ctx.scoop = terrain.scoop
    f.ctx.sleep = async ms => {
      if (f.now() + ms >= 1200 && waterAt === null) put(new Vec3(-1, 1, 0), 'lava')
      await f.sleep(ms)
    }
    t.mock.method(clock, 'now', f.now)
    f.frame.r = 3; f.frame.meInWeb = true
    await webTurn(f.ctx, f.frame)
    assert.ok(waterAt !== null && waterAt < 1200, `actual placement must precede the observed lava spread, lavaY=${lavaY}`)
    assert.ok(uses > 0)
    assert.equal(f.bot.entity.isInLava, false, 'native body actually leaves the remaining lava')
    assert.equal(burningFeet(f.bot), false, 'the complete body, not only the native contracted box, is clear')
    assert.equal(f.cuts(), 0)
  }
})

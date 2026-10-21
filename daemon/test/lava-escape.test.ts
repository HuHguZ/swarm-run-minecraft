import test from 'node:test'
import assert from 'node:assert/strict'
import { splashImpact, drinkFireResistance, climbFromLava, lavaCapabilities } from '../src/tactics/lava-escape'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'

test('an unresisted lava emergency does not scan unusable climbing routes while the pearl waits for physics', () => {
  // fluidRoute определён в src/unstuck/tools: фасад unstuck переэкспортирует его геттером, подмена — на части
  const unstuck: typeof import('../src/unstuck/tools') = require('../src/unstuck/tools')
  const previous = unstuck.fluidRoute
  const bot: any = { health: 20, entity: { position: new Vec3(.5, 100, .5), isInLava: true, effects: {} },
    registry: { effectsByName: { fire_resistance: { id: 12 } } },
    inventory: { items: () => [{ name: 'ender_pearl', count: 8 }] },
    blockAt: () => ({ name: 'lava', boundingBox: 'empty' }) }
  let scans = 0
  unstuck.fluidRoute = () => { scans++; return { target: new Vec3(2.5, 101, .5) } as any }
  try {
    assert.deepEqual(lavaCapabilities({ bot }), { potion: false, climb: false, exit: '' })
    assert.equal(scans, 0)
    bot.entity.effects[12] = { amplifier: 0 }
    assert.equal(lavaCapabilities({ bot }).climb, true)
    assert.equal(scans, 1, 'actual fire resistance makes climbing useful again')
  } finally { unstuck.fluidRoute = previous }
})

test('fire resistance splashes against a visible nearby wall and waits for a delayed server effect', async () => {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  const item = { name: 'splash_potion', count: 1, componentMap: new Map([['potion_contents', { data: { potion: 'fire_resistance' } }]]) }
  let aimed: any = null
  let threw = false
  const events: any[] = []
  const bot: any = { health: 20, entity: { position: new Vec3(2.5, 100, .5), height: 1.8, eyeHeight: 1.62, effects: {}, metadata: [], yaw: 0, pitch: 0 },
    entities: {}, inventory: { items: () => [item] }, registry: { effectsByName: { fire_resistance: { id: 12 } } },
    blockAt: (p: any) => ({ position: p.floored(), name: p.x < 1 ? 'stone' : p.y < 95 ? 'stone' : 'lava',
      boundingBox: p.x < 1 || p.y < 95 ? 'block' : 'empty', shapes: p.x < 1 || p.y < 95 ? [[0, 0, 0, 1, 1, 1]] : [] }),
    equip: async () => {}, lookAt: async (p: any) => { aimed = p }, activateItem: () => {
      threw = true
      c.setTimeout(() => { bot.entity.effects[12] = { amplifier: 0 } }, 900)
    } }
  try {
    const work = drinkFireResistance({ bot, bus: { emit: (type: string, payload: any) => events.push({ type, ...payload }) } }, { aborted: false })
    for (let i = 0; i < 30; i++) { await new Promise<void>(resolve => setImmediate(resolve)); c.advanceTicks(2) }
    const result = await work
    assert.equal(threw, true)
    assert.equal(aimed.x, 1, 'splash hits the nearby visible wall instead of the deep lava floor')
    assert.equal(result.ok, true)
    assert.ok(events.some(event => event.type === 'drank' && event.ok))
    bot.blockAt = (p: any) => ({ position: p.floored(), name: p.y < 95 ? 'stone' : 'lava',
      boundingBox: p.y < 95 ? 'block' : 'empty', shapes: p.y < 95 ? [[0, 0, 0, 1, 1, 1]] : [] })
    assert.equal(splashImpact(bot), null, 'a deep fluid floor is not invented as a nearby splash impact')
  } finally { c.dispose() }
})

test('a dry intermediate platform resumes the original shore goal after a native emergency interrupt', async () => {
  const build: typeof import('../src/build') = require('../src/build')
  const previous = build.towerUp
  const goal = { at: new Vec3(.5, 104, .5), deadline: clock.now() + 12000, startY: 100, placed: 1 }
  const bot: any = { health: 18, entity: { position: new Vec3(.5, 101, .5), onGround: true, effects: { 12: {} } },
    registry: { effectsByName: { fire_resistance: { id: 12 } } }, inventory: { items: () => [{ name: 'cobblestone', count: 20 }] },
    blockAt: (p: any) => ({ name: p.y < 101 ? 'stone' : 'air', boundingBox: p.y < 101 ? 'block' : 'empty', position: p.floored() }),
    setControlState: () => {}, clearControlStates: () => {}, lookAt: async () => {} }
  const session: any = { bot, _tacticalLavaClimbGoal: goal, bus: { emit: () => {} } }
  const first = { aborted: false }
  let towers = 0
  build.towerUp = async (_bot: any, ctl: any) => {
    towers++; bot.entity.position.y++
    if (towers === 1) ctl.aborted = true
    return { ok: true, placed: 1 }
  }
  try {
    const interrupted = await climbFromLava(session, first)
    assert.equal(interrupted.ok, false)
    assert.equal(session._tacticalLavaClimbGoal, goal, 'the rescue objective outlives the cancelled leaf')
    const completed = await climbFromLava(session, { aborted: false })
    assert.equal(completed.ok, true)
    assert.equal(bot.entity.position.y, 104)
    assert.equal(towers, 3, 'already dry does not skip the two remaining height steps')
    assert.equal(session._tacticalLavaClimbGoal, undefined)
  } finally { build.towerUp = previous }
})

test('a failed climb retains the original shore and cannot report its own platform as an exit', async () => {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  const build: typeof import('../src/build') = require('../src/build')
  const previous = build.towerUp
  const goal = { at: new Vec3(-1.5, 105, .5), deadline: 12000, startY: 100, placed: 2 }
  const bot: any = { health: 18, entity: { position: new Vec3(.5, 103, .5), onGround: true, effects: { 12: {} } },
    registry: { effectsByName: { fire_resistance: { id: 12 } } }, inventory: { items: () => [{ name: 'cobblestone', count: 20 }] },
    blockAt: (p: any) => ({ name: p.y < 103 ? 'stone' : 'air', boundingBox: p.y < 103 ? 'block' : 'empty', position: p.floored() }),
    setControlState: () => {}, clearControlStates: () => {}, lookAt: async () => {} }
  const session: any = { bot, _tacticalLavaClimbGoal: goal, bus: { emit: () => {} } }
  let towers = 0
  build.towerUp = async () => { towers++; c.advanceTicks(20); return { ok: false, placed: 0 } }
  try {
    const work = climbFromLava(session, { aborted: false })
    for (let i = 0; i < 20; i++) { await new Promise<void>(resolve => setImmediate(resolve)); c.advanceTicks(2) }
    const result = await work
    assert.equal(result.ok, false)
    assert.equal(session._tacticalLavaClimbGoal, goal)
    assert.equal(session._tacticalLavaClimbGoal.failed, true)
    const capabilities = lavaCapabilities(session)
    assert.equal(capabilities.climb, false)
    assert.equal(capabilities.exit, '-2,105,0', 'new placed blocks cannot replace the original shore')
    const attempts = towers
    assert.equal((await climbFromLava(session, { aborted: false })).ok, false, 'dry is not equivalent to escaped')
    assert.equal(towers, attempts, 'a failed objective is bounded until a new incident')
  } finally { build.towerUp = previous; c.dispose() }
})

test('a platform at shore height still requires walking onto the original shore cell', () => {
  const goal = { at: new Vec3(.5, 105, .5), deadline: clock.now() + 12000, startY: 100, placed: 6 }
  const bot: any = { entity: { position: new Vec3(1.6, 105, .5), onGround: true },
    inventory: { items: () => [] }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) }
  const session: any = { bot, _tacticalLavaClimbGoal: goal }
  assert.equal(lavaCapabilities(session).climb, true)
  assert.equal(session._tacticalLavaClimbGoal, goal)
  bot.entity.position = new Vec3(.6, 105, .6)
  assert.equal(lavaCapabilities(session).climb, false)
  assert.equal(session._tacticalLavaClimbGoal, undefined)
})

test('confirmed stable height progress renews the rescue budget beyond twelve game seconds', async () => {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  const build: typeof import('../src/build') = require('../src/build'); const previous = build.towerUp
  const goal = { at: new Vec3(.5, 105, .5), deadline: 12000, startY: 100, placed: 1 }
  const bot: any = { health: 18, entity: { position: new Vec3(.5, 101, .5), onGround: true, effects: { 12: {} } },
    registry: { effectsByName: { fire_resistance: { id: 12 } } }, inventory: { items: () => [{ name: 'cobblestone', count: 20 }] },
    blockAt: (p: any) => ({ name: p.y < bot.entity.position.y ? 'stone' : 'air', boundingBox: p.y < bot.entity.position.y ? 'block' : 'empty', position: p.floored() }),
    setControlState: () => {}, clearControlStates: () => {}, lookAt: async () => {} }
  const session: any = { bot, _tacticalLavaClimbGoal: goal, bus: { emit: () => {} } }
  build.towerUp = async () => { c.advanceTicks(100); bot.entity.position.y++; return { ok: true, placed: 1 } }
  try {
    const work = climbFromLava(session, { aborted: false })
    for (let i = 0; i < 10; i++) { await new Promise<void>(resolve => setImmediate(resolve)); c.advanceTicks(2) }
    assert.equal((await work).ok, true)
    assert.ok(c.now() > 12000)
    assert.equal(bot.entity.position.y, 105)
    assert.equal(session._tacticalLavaClimbGoal, undefined)
  } finally { build.towerUp = previous; c.dispose() }
})

// ND_BLZ_LAVA_FAR: под FR берега в 10 и стены нет — выход всё равно есть (farOut), а не «ждать конца FR».
test('far lava: with fire resistance and no near exit the climb stays available under ND_BLZ_LAVA_FAR', () => {
  const unstuck: typeof import('../src/unstuck/tools') = require('../src/unstuck/tools')
  const previous = unstuck.fluidRoute, flag = process.env.ND_BLZ_LAVA_FAR
  const bot: any = { health: 20, entity: { position: new Vec3(.5, 22, .5), isInLava: true, effects: { 12: { amplifier: 0 } } },
    registry: { effectsByName: { fire_resistance: { id: 12 } } }, inventory: { items: () => [] },
    blockAt: () => ({ name: 'lava', boundingBox: 'empty' }) }
  unstuck.fluidRoute = () => null as any
  try {
    delete process.env.ND_BLZ_LAVA_FAR
    assert.equal(lavaCapabilities({ bot }).climb, false)
    process.env.ND_BLZ_LAVA_FAR = '1'
    assert.deepEqual(lavaCapabilities({ bot }), { potion: false, climb: true, exit: 'far' })
  } finally { unstuck.fluidRoute = previous; if (flag === undefined) delete process.env.ND_BLZ_LAVA_FAR; else process.env.ND_BLZ_LAVA_FAR = flag }
})

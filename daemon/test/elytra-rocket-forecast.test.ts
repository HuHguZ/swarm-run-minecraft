import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { GameClock } from '../src/game-clock'
import { rocketForecast } from '../src/elytra/rocket-forecast'
import { landingPlan } from '../src/elytra/landing'
import { glideStep, rollout } from '../src/elytra/physics'
import { install } from '../src/elytra/install'

function fixture () {
  const bot: any = new EventEmitter()
  const clock = new GameClock({ manual: true, epoch: 1000 })
  Object.assign(bot, { ndClock: clock, entity: { id: 4, elytraFlying: true }, entities: {}, fireworkRocketDuration: 0,
    registry: { entitiesByName: { firework_rocket: { metadataKeys: ['fireworks_item', 'attached_to_target'] } } } })
  const attach = (id, flight: any = 1, removed = false, target = 4) => {
    const stack = { itemId: 1090, itemCount: 1, components: flight === 'default' ? [] : [{ type: 'fireworks', data: { flightDuration: flight, explosions: [] } }],
      removeComponents: removed ? ['fireworks'] : [] }
    if (removed) stack.components = []
    bot.entities[id] = { id, name: 'firework_rocket', metadata: [stack, target + 1] }
    if (target === 4) bot.fireworkRocketDuration = 40 // Mineflayer sets actual thrust before usedFirework.
    bot.emit('usedFirework', id)
  }
  rocketForecast(bot) // The real flight install hooks before any rocket is used.
  return { bot, clock, attach }
}

for (const [label, flight, removed, want] of [
  ['Flight0', 0, false, 17], ['Flight1', 1, false, 27], ['Flight2', 2, false, 37],
  ['vanilla default', 'default', false, 27], ['removed component', 'default', true, 17], ['unknown Flight', 'bad', false, 40]
] as const) test(`own public rocket ${label} uses its jar mean expiry without changing actual physics`, () => {
  const { bot, clock, attach } = fixture()
  try {
    attach(10, flight, removed)
    const got = rocketForecast(bot)
    assert.equal(got.boost, want)
    assert.equal(got.boostMin, 0, 'an observed attachment receipt does not bound its earlier native birth')
    assert.equal(got.boostMax, Math.min(40, want === 40 ? 40 : want + 5), 'landing retains the jar maximum expiry, clamped by actual remaining thrust')
    assert.equal(bot.fireworkRocketDuration, 40)
  } finally { clock.dispose() }
})

test('AQ35 late own rocket no longer promises seventeen future steps and AQ36 matches zero thrust', () => {
  const { bot, clock, attach } = fixture()
  try {
    attach(890)
    clock.advanceTicks(23) // No local body callback runs; observation age still advances.
    bot.fireworkRocketDuration = 17
    const got = rocketForecast(bot)
    assert.equal(got.boost, 4, 'fixed jar mean expiry26.5 minus observed age23, rounded to full future steps')
    assert.equal(bot.fireworkRocketDuration, 17)
    const p = { x: 607.1993340715385, y: 127.93882150042883, z: 605.7916530158569 }
    const v = { x: 1.0236023952572386, y: -.013431772850868936, z: -.972725484137868 }
    glideStep(p, v, -.8108778960204187, -.55, got.boostMin > 0)
    assert(Math.hypot(p.x - 608.2151083332958, p.y - 127.89355457041337, p.z - 604.8265047288231) < .000101)
    bot.emit('entityGone', bot.entities[890])
    assert.equal(bot.fireworkRocketDuration, 17, 'the existing flight owner alone writes the actual counter')
    bot.fireworkRocketDuration = 0 // Existing install's entityGone listener owns this write.
    assert.equal(rocketForecast(bot).boost, 0)
  } finally { clock.dispose() }
})

test('multiple own rockets retain the later forecast and ignore an attachment to somebody else', () => {
  const { bot, clock, attach } = fixture()
  try {
    attach(10, 0); attach(11, 2); attach(12, 2, false, 99)
    bot.emit('entityGone', bot.entities[10])
    assert.equal(rocketForecast(bot).boost, 37)
    bot.emit('entityGone', bot.entities[11])
    bot.fireworkRocketDuration = 0
    assert.equal(rocketForecast(bot).boost, 0)
  } finally { clock.dispose() }
})

for (const event of ['death', 'respawn', 'end']) test(`own forecast is cleared on ${event}`, () => {
  const { bot, clock, attach } = fixture()
  try {
    attach(10); bot.emit(event)
    assert.equal(rocketForecast(bot).boostUntil, null, 'no forecast from the prior life survives')
    bot.fireworkRocketDuration = 0
    assert.equal(rocketForecast(bot).boost, 0)
  } finally { clock.dispose() }
})

test('replacing the world clock forgets an old rocket and an absent item never invents Flight1', () => {
  const { bot, clock, attach } = fixture(), next = new GameClock({ manual: true, epoch: 2000 })
  try {
    attach(10)
    bot.ndClock = next
    assert.equal(rocketForecast(bot).boostUntil, null)
    bot.entities[11] = { id: 11, name: 'firework_rocket', metadata: [] }
    bot.emit('usedFirework', 11)
    assert.equal(rocketForecast(bot).boost, 40, 'active but unobserved item retains the nominal upper model and the zero-thrust branch')
  } finally { clock.dispose(); next.dispose() }
})

test('frozen game observations do not age the forecast by wall time or repeated queries', () => {
  const { bot, clock, attach } = fixture()
  try {
    attach(10)
    clock.setState({ is_frozen: true })
    const first = rocketForecast(bot)
    for (let i = 0; i < 100; i++) { clock.pulse(); assert.deepEqual(rocketForecast(bot), first) }
    clock.step(1); clock.pulse()
    assert.equal(rocketForecast(bot).boost, 26)
    assert.equal(bot.listenerCount('physicsTick'), 0, 'forecast has no per-body listeners or searches')
  } finally { clock.dispose() }
})

test('forecast reads public item components and never native LifeTime or player HP', () => {
  const { bot, clock, attach } = fixture()
  try {
    attach(10)
    Object.defineProperty(bot.entities[10], 'LifeTime', { get () { throw Error('native NBT is telemetry only') } })
    Object.defineProperty(bot.entity, 'health', { get () { throw Error('health not needed') } })
    assert.equal(rocketForecast(bot).boost, 27)
    clock.advanceTicks(40)
    assert.equal(rocketForecast(bot).boost, 0, 'the fixed mean is not renewed just because the last entity receipt remains present')
  } finally { clock.dispose() }
})

test('fractional observation-age rounding revalidates a cached complete route without a fresh full search', t => {
  const { bot, clock, attach } = fixture()
  let observed = 1000
  t.mock.method(clock, 'observationNow', () => observed)
  const world = () => ({ boxHit: (x, y, z) => y < 120, floorBelow: () => ({ top: 120 }) })
  const W = world(), goal = { at: { x: 605, y: 120, z: 600 } }, price = r => ({ c: 0, safe: true })
  try {
    attach(10)
    // This low approach has a complete common path even when the rocket survives past its mean.
    let st: any = { p: { x: 600, y: 120.5, z: 600 }, v: { x: 1, y: -.1, z: 0 }, fd: .1, ...rocketForecast(bot) }
    const first = landingPlan(W, st, goal, price)
    assert(first)
    for (const at of [1050.1, 1074.9, 1150.1]) {
      const p = rollout(W, st.p, st.v, first.yaw, first.pitch, st.boost, 1, { fd: st.fd })
      assert(!p.kind)
      clock.advanceTicks(1)
      observed = at
      st = { ...p, fd: p.p.y > st.p.y ? 0 : st.fd + Math.max(0, st.p.y - p.p.y), ...rocketForecast(bot) }
      const cached = landingPlan(W, st, goal, price), fresh = landingPlan(world(), st, goal, price)
      assert(cached && fresh)
      assert(cached.work < fresh.work, 'a fixed expiry identity permits full route revalidation through integer age plateaus')
    }
  } finally { clock.dispose() }
})

test('forecast age includes both confirmed observation progress and already consumed game quanta', t => {
  const { bot, clock, attach } = fixture()
  let observed = 1000
  t.mock.method(clock, 'observationNow', () => observed)
  try {
    attach(10)
    observed = 1140
    assert.equal(rocketForecast(bot).boost, 24, 'observation advances while the body clock has not run')
    clock.advanceTicks(10)
    assert.equal(rocketForecast(bot).boost, 17, 'the next body query cannot promise game quanta already consumed')
  } finally { clock.dispose() }
})

test('unobserved active thrust and a mixed unknown rocket retain the actual nominal model with a zero lower bound', () => {
  const { bot, clock, attach } = fixture()
  try {
    bot.fireworkRocketDuration = 40
    assert.deepEqual(rocketForecast(bot), { boost: 40, boostMin: 0, boostMax: 40, boostUntil: null })
    attach(10, 1); attach(11, 'bad')
    assert.deepEqual(rocketForecast(bot), { boost: 40, boostMin: 0, boostMax: 40, boostUntil: null })
    bot.emit('entityGone', bot.entities[11])
    assert.equal(rocketForecast(bot).boost, 27, 'the still-observed known rocket resumes its age model')
  } finally { clock.dispose() }
})

test('the 1.21.11 registry metadata and real protocol item stack provide the own Flight component', () => {
  const { bot, clock } = fixture()
  try {
    bot.registry = require('prismarine-registry')('1.21.11')
    const Item = require('prismarine-item')(bot.registry)
    const item = new Item(bot.registry.itemsByName.firework_rocket.id, 1)
    item.components = [{ type: 'fireworks', data: { flightDuration: 2, explosions: [] } }]
    const keys = bot.registry.entitiesByName.firework_rocket.metadataKeys
    const metadata: any[] = []
    metadata[keys.indexOf('fireworks_item')] = Item.toNotch(item)
    metadata[keys.indexOf('attached_to_target')] = bot.entity.id + 1
    bot.entities[10] = { id: 10, name: 'firework_rocket', metadata }
    bot.fireworkRocketDuration = 40
    bot.emit('usedFirework', 10)
    assert.equal(rocketForecast(bot).boost, 37)
    assert.equal(bot.fireworkRocketDuration, 40)
  } finally { clock.dispose() }
})

test('existing flight black-box ticks show forecast separately from the actual thrust counter', () => {
  const { bot, clock, attach } = fixture()
  bot._client = new EventEmitter()
  Object.assign(bot.entity, { position: { x: 600, y: 130, z: 600 }, velocity: { x: 0, y: 0, z: 0 }, onGround: false, yaw: 0, pitch: 0 })
  try {
    const state = install(bot)
    state.driving = 1
    attach(10, 1)
    bot.emit('physicsTick')
    const tick = state.box.at(-1)
    assert.equal(tick.bst, 40)
    assert.deepEqual(tick.forecast, { boost: 27, boostMin: 0, boostMax: 32, boostUntil: 2325 })
    assert.equal(bot.fireworkRocketDuration, 40)
  } finally { clock.dispose() }
})

test('a legally late Flight1 survivor still has a planning upper bound after the mean expiry', () => {
  const { bot, clock, attach } = fixture()
  try {
    attach(10, 1)
    clock.advanceTicks(27)
    bot.fireworkRocketDuration = 13
    const forecast: any = rocketForecast(bot)
    assert.equal(forecast.boost, 0, 'ordinary point prediction keeps its fixed mean expiry')
    assert.equal(forecast.boostMax, 5, 'jar lifetime31 survives native age27 through expiry age32')
    assert.equal(forecast.boostMin, 0)
    assert.equal(bot.fireworkRocketDuration, 13)
  } finally { clock.dispose() }
})

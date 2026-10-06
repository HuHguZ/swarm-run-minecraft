import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const native = require('../src/tick-plugins').getPhysics()

test('author checkpoint receipt parses the native 1.21.11 respawn position without treating chat absence as activation failure', () => {
  const { authorRespawn } = require('../try-parkour-map')
  assert.deepEqual(authorRespawn('NeuroFarm29 has the following entity data: {pos: [I; -21, 90, -35], forced: 1b, dimension: "minecraft:overworld"}'), { x: -21, y: 90, z: -35 })
  assert.deepEqual(authorRespawn('{pos:[I;-22,99,-38]}'), { x: -22, y: 99, z: -38 })
  assert.equal(authorRespawn('No entity was found'), undefined)
})

function worldOf(cells: Array<[number, number, number, string, Record<string, unknown>?]>) {
  const blocks = new Map(cells.map(([x, y, z, name, properties]) => {
    const block = properties ? Block.fromProperties(name, properties) : Block.fromStateId(registry.blocksByName[name].defaultState)
    block.position = new Vec3(x, y, z)
    return [`${x},${y},${z}`, block]
  }))
  const world = { getBlock(p: Vec3) {
    const q = p.floored()
    const block = blocks.get(`${q.x},${q.y},${q.z}`)
    if (block) return block
    const air = Block.fromStateId(registry.blocksByName.air.defaultState)
    air.position = q
    return air
  } }
  const bot: Record<string, any> = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384 }, inventory: { slots: [], items: () => [] }, health: 20, food: 20,
    entity: { position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    blockAt: (p: Vec3) => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    physics: native.Physics(registry, world)
  })
  return { world, bot }
}

test('hay landing damage uses the collided support and native fallOn multiplier without accepting a harmful dry drop', async () => {
  const { landingDamage } = require('../src/navigation/landing')
  const { supportAt } = require('../src/navigation/geometry')
  const { planJumpAsync, simulatePlan } = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 7, 0, 'stone'], [2, 0, 0, 'hay_block'], [3, 0, 0, 'stone'], [4, 1, 0, 'stone']])
  const hay = bot.blockAt(new Vec3(2, 0, 0)); const stone = bot.blockAt(new Vec3(3, 0, 0))
  assert.equal(landingDamage(hay, 9), 1, 'HayBlock.fallOn passes 0.2f before LivingEntity rounds down; Author41 shaft is not a zero-damage drop')
  assert.equal(landingDamage(hay, 7), 0)
  assert.equal(landingDamage(hay, 8), 1, 'the server epsilon keeps the eight-block threshold harmful')
  assert.equal(landingDamage(stone, 9), 6)
  assert.equal(landingDamage(stone, 7), 4)
  assert.equal(landingDamage(supportAt(bot, new Vec3(2.95, 1, .5), .04).block, 7), 0, 'an actual edge contact can still belong to hay')
  assert.equal(landingDamage(supportAt(bot, new Vec3(3.05, 1, .5), .04).block, 7), 4, 'neighboring stone receives no hay mitigation')
  assert.equal(landingDamage(supportAt(bot, new Vec3(3.8, 2, .5), .04).block, 7), 4, 'a higher neighboring collision is the real floor')
  bot.entity.position = new Vec3(.5, 8, .5); bot.entity.velocity.y = -.0784000015258789
  const before = bot.entity.position.clone(); const target = new Vec3(2.5, 1, .5)
  const options = { allowWalk: true, maxTicks: 38, planningMs: 180 }
  const plan = await planJumpAsync(bot, { aborted: false }, target, options)
  assert.ok(plan, 'the existing native forecast must preserve a genuinely harmless seven-block hay landing')
  const landed = simulatePlan(bot, plan.steps)
  assert.ok(landed.onGround && landed.pos.distanceTo(target) < .22)
  assert.equal(supportAt(bot, landed.pos, .04).block.name, 'hay_block')
  const ordinary = worldOf([[0, 7, 0, 'stone'], [2, 0, 0, 'stone']]).bot
  ordinary.entity.position = before.clone(); ordinary.entity.velocity.y = bot.entity.velocity.y
  assert.equal(await planJumpAsync(ordinary, { aborted: false }, target, options), null, 'the ordinary dry drop guard must still reject stone')
  bot.entity.position.y = 10
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, options), null, 'one HP of actual hay damage still refuses the nine-block drop')
  bot.entity.position = before
  assert.equal(await planJumpAsync(bot, { aborted: true }, target, options), null)
  const observed = bot.blockAt
  bot.blockAt = (p: Vec3) => p.x >= 2 ? null : observed(p)
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, options), null, 'unloaded support cannot grant mitigation')
  assert.deepEqual(bot.entity.position, before, 'planning must not move the actual bot')
})

test('an opt-in controlled hay drop has a real native contact while default, stone, low health and threats refuse it', async () => {
  const { planJumpAsync } = require('../src/navigation/parkour')
  const { supportRoute } = require('../src/navigation/support-route')
  const cells: Array<[number, number, number, string]> = [[0, 9, 0, 'sand'], [1, 9, 0, 'sand'], [2, 0, 0, 'hay_block']]
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(1.63552862687186, 10, .500763381991554); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(2.5, 1, .5); const options = { maxFallDamage: 1, allowWalk: true, planningMs: 180 }
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, { ...options, maxFallDamage: 0 }), null)
  const plan = await planJumpAsync(bot, { aborted: false }, target, options)
  assert.ok(plan, 'the real nine-block hay shaft needs explicit one-HP permission, not a changed integrator')
  assert.equal(plan.fall.damage, 1); assert.equal(plan.fall.supportName, 'hay_block')
  assert.ok(plan.states[plan.fall.tick].onGround && plan.states[plan.fall.tick].pos.y === 1)
  assert.ok((await supportRoute(bot, bot.entity.position, target, new Set(), 6, undefined, undefined, undefined, 1)).some((o: any) => o.target.equals(target)))
  assert.equal((await supportRoute(bot, bot.entity.position, target, new Set(), 6)).length, 0)
  bot.health = 13
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, options), null, 'projected health must stay above the existing safety threshold')
  bot.health = 20
  bot.entities = { 2: { id: 2, name: 'zombie', position: bot.entity.position.offset(1, 0, 0), isValid: true } }
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, options), null, 'fight-ready health does not authorize a voluntary injury near an observed threat')
  bot.entities = {}
  bot._ndReflexSession = { tactics: { snapshot: () => ({ state: { enemies: [{ threatening: true }] } }) } }
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, options), null, 'known PvP threats from the existing tactical observation also refuse the drop')
  delete bot._ndReflexSession
  const observed = bot.blockAt
  const stone = Block.fromStateId(registry.blocksByName.stone.defaultState); stone.position = new Vec3(2, 0, 0)
  bot.blockAt = (p: Vec3) => p.floored().equals(stone.position) ? stone : observed(p)
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, options), null, 'nine blocks onto stone still costs six HP')
  bot.blockAt = (p: Vec3) => p.x >= 2 ? null : observed(p)
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, options), null)
  assert.equal(await planJumpAsync(bot, { aborted: true }, target, options), null)
})

test('controlled deep routing uses an observed open shaft instead of hay behind a solid upper floor', async () => {
  const { supportRoute } = require('../src/navigation/support-route')
  const { planJumpAsync } = require('../src/navigation/parkour')
  // Translated Author42: the lower hay body is clear, but its upper concrete
  // floor cannot be crossed by falling toward the same horizontal position.
  const cells: Array<[number, number, number, string]> = []
  for (let x = 0; x < 5; x++) {
    cells.push([x, 0, 0, 'hay_block'])
    if (x !== 3) cells.push([x, 9, 0, 'white_concrete_powder'])
  }
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(1.5, 10, .5); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(2.5, 1, .5)
  const route = await supportRoute(bot, bot.entity.position, target, new Set(), 6, undefined, undefined, undefined, 1)
  assert.ok(route.length)
  const drop = route.find((option: any, index: number) => option.target.y < (index ? route[index - 1].target.y : 10) - 3.75)
  assert.equal(drop?.target.x, 3.5, 'the deep edge must enter the loaded open shaft, not the closed target column')
  for (const option of route) {
    const plan = await planJumpAsync(bot, { aborted: false }, option.target, { allowWalk: true, maxFallDamage: 1, planningMs: 180 })
    assert.ok(plan, 'each selected approach/drop/walk still needs the existing native forecast')
    plan.states.at(-1).apply(bot)
    if (plan.fall) bot.health -= plan.fall.damage
  }
  assert.equal(bot.health, 19)
  assert.ok(bot.entity.onGround && bot.entity.position.distanceTo(target) < .22)
  const unknown = worldOf(cells).bot
  unknown.entity.position = new Vec3(1.5, 10, .5)
  const observed = unknown.blockAt
  unknown.blockAt = (p: Vec3) => Math.floor(p.x) === 3 && p.y >= 2 && p.y < 9 ? null : observed(p)
  const refused = await supportRoute(unknown, unknown.entity.position, target, new Set(), 6, undefined, undefined, undefined, 1)
  assert.ok(refused.every((option: any) => option.target.y === 10), 'unknown shaft volume cannot supply a deep edge')
  assert.deepEqual(await supportRoute(unknown, unknown.entity.position, target, new Set(), 6, undefined, undefined, () => true, 1), [])
  assert.ok((await supportRoute(bot, new Vec3(1.5, 10, .5), target, new Set(), 6)).every((option: any) => option.target.y === 10), 'ordinary dry-drop policy stays unchanged')
})

test('controlled drop execution accepts only its grounded native fall receipt and bounded health loss, including reversed receipt order', async () => {
  const { planJumpAsync, executePlan, IDLE } = require('../src/navigation/parkour')
  const fallType = require('../src/gamedata').DAMAGE_TYPES.indexOf('fall')
  for (const mode of ['valid', 'health_first', 'late_receipt', 'foreign', 'unknown', 'early', 'excess', 'missing', 'missing_complete_when', 'changed_floor', 'cancel']) {
    const { bot, world } = worldOf([[0, 9, 0, 'sand'], [1, 9, 0, 'sand'], [2, 0, 0, 'hay_block']])
    bot.entity.id = 1; bot.entity.position = new Vec3(1.63552862687186, 10, .500763381991554); bot.entity.velocity.y = -.0784000015258789
    bot._client = new EventEmitter(); let control = { ...IDLE }; let injured = false; let delayed = false; let airborne = false; let frames = 0
    bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
    bot.setControlState = (key: string, value: boolean) => { control[key] = value }
    bot.clearControlStates = () => { control = { ...IDLE } }
    const ctl = { aborted: false, onAbort: [] as Array<() => void> }
    const target = new Vec3(2.5, 1, .5)
    const plan = await planJumpAsync(bot, ctl, target, { maxFallDamage: 1, allowWalk: true, planningMs: 180 })
    assert.ok(plan)
    const receipt = () => bot._client.emit('damage_event', { entityId: 1, sourceTypeId: mode === 'foreign' ? 28 : mode === 'unknown' ? 999 : fallType, sourceCauseId: mode === 'foreign' ? 3 : 0, sourceDirectId: 0 })
    bot.waitForTicks = async (ticks: number) => {
      for (let tick = 0; tick < ticks; tick++) {
        const state = new native.PlayerState(bot, control)
        bot.physics.simulatePlayer(state, world); state.apply(bot); frames++
        bot.emit('physicsTick'); airborne ||= !state.onGround
        const landing = airborne && state.onGround
        if (!injured && (landing || mode === 'early' && airborne || mode === 'cancel' && airborne)) {
          injured = true
          if (mode === 'cancel') { ctl.aborted = true; for (const abort of [...ctl.onAbort]) abort(); continue }
          if (mode === 'changed_floor') {
            const observed = bot.blockAt; const stone = Block.fromStateId(registry.blocksByName.stone.defaultState); stone.position = new Vec3(2, 0, 0)
            bot.blockAt = (p: Vec3) => p.floored().equals(stone.position) ? stone : observed(p)
          }
          if (!['health_first', 'late_receipt', 'missing', 'missing_complete_when'].includes(mode)) receipt()
          bot.health -= mode === 'excess' ? 2 : 1; bot.emit('health')
          if (mode === 'health_first') receipt()
        }
        if (mode === 'late_receipt' && !delayed && frames > plan.ticks) { delayed = true; receipt() }
      }
    }
    const landed = () => bot.entity.onGround && bot.entity.position.distanceTo(target) < .25
    const result = await executePlan(bot, ctl, plan, (state: any) => state.onGround && state.pos.distanceTo(target) < .25,
      mode === 'missing_complete_when' ? landed : undefined)
    assert.equal(result.ok, ['valid', 'health_first', 'late_receipt'].includes(mode), mode)
    if (mode === 'missing_complete_when') assert.equal(result.why, 'fall_damage_not_confirmed', 'completeWhen cannot replace a typed fall receipt')
    assert.equal(bot._client.listenerCount('damage_event'), 0, mode)
    assert.equal(bot.listenerCount('health'), 0, mode)
    assert.equal(bot._ndParkourForecast, undefined, mode); assert.equal(ctl.onAbort.length, 0, mode)
    assert.equal(control.forward, false, mode); assert.equal(control.jump, false, mode)
  }
})

test('a loaded bent runway preserves a real intermediate landing before the next rising jump', async () => {
  const floor: Array<[number, number, number, string]> = [[0, 0, 1, 'stone'], [1, 0, 0, 'stone'], [1, 0, 1, 'stone'], [1, 0, 2, 'stone'], [2, 0, 0, 'stone'], [2, 0, 1, 'stone'], [2, 0, 2, 'stone'], [3, 0, 0, 'stone'], [3, 0, 1, 'stone'], [6, 1, 5, 'stone']]
  const { bot } = worldOf(floor)
  bot.physics.playerHalfWidth = Math.fround(.6) / 2
  bot.entity.position = new Vec3(3.54227155072947, 1, 1.536848335588923); bot.entity.velocity.y = -.0784000015258789
  const before = bot.entity.position.clone(); const target = new Vec3(6.5, 2, 5.5)
  const { planJumpAsync, simulatePlan } = require('../src/navigation/parkour')
  const { bodyClear } = require('../src/navigation/geometry')
  const plan = await planJumpAsync(bot, { aborted: false }, target, { allowWalk: true, maxTicks: 38, planningMs: 180 })
  assert.ok(plan, 'stopping at every center must not erase an observed, physically reachable two-jump continuation')
  assert.deepEqual(bot.entity.position, before, 'forecasting may not move the bot or inject velocity')
  const jumps = plan.steps.flatMap((step: any, i: number) => step.control.jump ? [i] : [])
  assert.ok(jumps.length >= 2, 'both impulses must be earned by actual native grounded jumps')
  assert.ok(plan.states.slice(jumps[0], jumps[1]).some((s: any) => s.onGround && s.isCollidedVertically && s.pos.y === 1), 'the second jump requires an observed native floor collision')
  assert.ok(plan.states.every((s: any) => bodyClear(bot, s.pos) && !s.isInWater && !s.isInLava && s.pos.y >= .6))
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 2)
  assert.ok(landed.pos.distanceTo(target) < .22)
  assert.ok(Math.hypot(landed.vel.x, landed.vel.z) < .035)
  assert.ok(plan.states.slice(-6).every((s: any) => s.onGround && s.pos.y === 2 && s.pos.distanceTo(target) < .22))
  const observed = bot.blockAt
  bot.blockAt = (p: Vec3) => p.x < 3 ? null : observed(p)
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, { allowWalk: true, maxTicks: 38, planningMs: 180 }), null, 'an unobserved runway cannot supply the same earned momentum')
  assert.deepEqual(bot.entity.position, before)
})

test('a native grounded flag after leaving a lava-side ledge cannot supply a delayed rising jump', async () => {
  // Translated observed Author36 geometry; names with equal full collision and
  // friction use stone. State-specific slab tops and the overhead corner stay.
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = []
  const lavaRows = new Map([[0, [1, 2]], [1, [0, 1, 2]], [2, [0, 1, 2, 3]], [3, [0, 1, 2]], [4, [0, 1]], [5, [0]]])
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 6; z++) cells.push([x, 0, z, lavaRows.get(z)?.includes(x) ? 'lava' : 'stone'])
  for (let y = 1; y <= 4; y++) for (let z = 1; z <= 5; z++) cells.push([-1, y, z, 'stone'])
  for (let x = 4; x <= 5; x++) for (let y = 1; y <= 4; y++) for (let z = -1; z <= 3; z++) cells.push([x, y, z, 'stone'])
  for (let y = 1; y <= 3; y++) for (let z = 1; z <= 3; z++) if (y !== 1 || z !== 2) cells.push([3, y, z, 'stone'])
  cells.push([2, 1, 4, 'stone'], [3, 1, 4, 'stone'], [4, 1, 4, 'stone'], [2, 4, 2, 'stone'], [3, 4, 2, 'stone'],
    [3, 2, 4, 'stone_slab', { type: 'bottom', waterlogged: false }], [4, 2, 4, 'stone_slab', { type: 'bottom', waterlogged: false }])
  const { bot } = worldOf(cells)
  bot.physics.playerHalfWidth = Math.fround(.6) / 2
  bot.entity.position = new Vec3(.47467265494781, 1, .562079224545182); bot.entity.velocity.y = -.0784000015258789
  const { planJumpAsync } = require('../src/navigation/parkour')
  const { bodyClear, supportAt } = require('../src/navigation/geometry')
  const plan = await planJumpAsync(bot, { aborted: false }, new Vec3(2.5, 2, 4.5), { allowWalk: true, maxTicks: 38, beam: 24, planningMs: 180 })
  assert.ok(!plan || plan.states.every((s: any) => !s.onGround || s.vel.y >= 0 || supportAt(bot, s.pos, .04) || bodyClear(bot, s.pos.offset(0, s.vel.y, 0))),
    'Author36 frame5 was unsupported over lava; matching client endpoints still received native lava damage')
  const dry = worldOf(cells.map(([x, y, z, name, props]) => [x, y, z, name === 'lava' ? 'air' : name, props]))
  dry.bot.physics.playerHalfWidth = bot.physics.playerHalfWidth
  dry.bot.entity.position = bot.entity.position.clone(); dry.bot.entity.velocity.y = bot.entity.velocity.y
  const ordinary = await planJumpAsync(dry.bot, { aborted: false }, new Vec3(2.5, 2, 4.5), { allowWalk: true, maxTicks: 38, beam: 24, planningMs: 180 })
  assert.ok(ordinary, 'ordinary air overhangs retain the native contact and impulse behavior')
  assert.ok(ordinary.states.some((s: any) => s.onGround && !supportAt(dry.bot, s.pos, .04)), 'the control exercises the retained Y-before-XZ contact')
})

test('one native trajectory preserves a slime rebound and finishes on the next stable support', () => {
  const cells: Array<[number, number, number, string]> = [[0, 5, 0, 'stone'], [1, 5, 0, 'stone'], [2, 5, 0, 'stone'], [4, 0, 0, 'slime_block'], [5, 0, 0, 'slime_block'], [7, 3, 0, 'stone'], [8, 3, 0, 'stone']]
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(2.5, 6, .5); bot.entity.velocity.y = -.0784000015258789
  const { planJump, simulatePlan } = require('../src/navigation/parkour')
  const plan = planJump(bot, new Vec3(7.5, 4, .5), { bounce: new Vec3(4.5, 1, .5), maxTicks: 90 })
  assert.ok(plan, 'the shared native integrator must discover drop, bounce, steering and final rest')
  assert.ok(plan.states.some((state: any) => state.pos.y === 1 && state.vel.y > .3 && state.onGround), 'real slime collision must reverse falling velocity')
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 4)
  assert.ok(landed.pos.distanceTo(new Vec3(7.5, 4, .5)) < .22)
  assert.equal(require('../src/navigation/landing').landingDamage(bot.blockAt(new Vec3(4, 0, 0)), 20), 0)
})

test('an observed diagonal spring approach tries its supported run-up before exhausting unrelated native profiles', () => {
  const { bot } = worldOf([[0, 0, 0, 'stone'], [-5, -5, -3, 'slime_block'], [-4, -5, -3, 'slime_block'], [-9, -2, -6, 'stone'], [-8, -2, -6, 'stone']])
  bot.entity.position = new Vec3(.3942147, 1, .6100089); bot.entity.velocity.y = -.0784000015258789
  const { planJump, simulatePlan } = require('../src/navigation/parkour')
  const diagnostics = { frames: 0, profiles: 0 }
  const target = new Vec3(-8.5, -1, -5.5)
  const plan = planJump(bot, target, { bounce: new Vec3(-4.5, -4, -2.5), maxTicks: 90, diagnostics })
  assert.ok(plan, 'the run-up remains an ordinary supported movement followed by a native slime collision')
  assert.ok(diagnostics.frames < 120, `the bounded planner must reach this profile early, got ${diagnostics.frames} native frames`)
  assert.ok(plan.states.some((state: any) => state.pos.y === -4 && state.vel.y > .3 && state.onGround))
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.ok(landed.pos.distanceTo(target) < .22)
})

test('a higher semantic approach earns the native spring velocity needed for the following lower checkpoint', () => {
  const { planJump, simulatePlan } = require('../src/navigation/parkour')
  const target = new Vec3(7.5, 6, .5)
  for (const height of [5, 9]) {
    const { bot } = worldOf([[0, height - 1, 0, 'stone'], [4, -1, 0, 'slime_block'], [5, -1, 0, 'slime_block'], [7, 5, 0, 'stone'], [8, 5, 0, 'stone']])
    bot.entity.position = new Vec3(.5, height, .5); bot.entity.velocity.y = -.0784000015258789
    const diagnostics: { frames: number; profiles: number; reboundCeiling?: number } = { frames: 0, profiles: 0 }
    const plan = planJump(bot, target, { bounce: new Vec3(4.5, 0, .5), maxTicks: 90, diagnostics })
    if (height === 5) {
      assert.equal(plan, null, 'going directly to the numerically lower checkpoint cannot earn this rebound')
      assert.ok((diagnostics.reboundCeiling ?? Infinity) < target.y, 'all native launch profiles must stay below the required landing')
    } else {
      assert.ok(plan, 'the preceding higher approach must make the same spring and destination reachable')
      assert.ok(plan.states.some((s: any) => s.pos.y === 0 && s.onGround && s.vel.y > .3), 'vertical speed comes from an actual native slime collision')
      const landed = simulatePlan(bot, plan.steps)
      assert.equal(landed.onGround, true); assert.equal(landed.pos.y, target.y)
      assert.ok(landed.pos.distanceTo(target) < .22)
    }
  }
})

test('a native local trajectory catches an offset ladder around a tall corner and exits on real upper support', async () => {
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 2, 'stone']]
  for (let y = 0; y <= 2; y++) cells.push([0, y, 0, 'stone'])
  for (let y = 0; y <= 3; y++) cells.push([0, y, 1, 'stone'])
  for (let y = 1; y <= 2; y++) cells.push([1, y, 0, 'ladder', { facing: 'east', waterlogged: false }])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.5, 1, 2.5); bot.entity.velocity.y = -.0784000015258789
  const { planJumpAsync, simulatePlan } = require('../src/navigation/parkour')
  const target = new Vec3(.5, 3, .5)
  const plan = await planJumpAsync(bot, { aborted: false }, target, { climb: new Vec3(1.5, 1, .5), maxTicks: 90, planningMs: 180 })
  assert.ok(plan, 'the shared predictor must retain native ladder contact after the corner approach')
  assert.ok(plan.states.some((s: any) => bot.blockAt(s.pos.floored()).name === 'ladder' && !s.onGround))
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 3)
  assert.ok(landed.pos.distanceTo(target) < .22)
})

test('a real exposed stair tread beside a high wall stays reachable inside the local native planning budget', async () => {
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone'], [-1, 0, 2, 'stone'], [-1, 1, 2, 'acacia_stairs', { facing: 'south', half: 'bottom', shape: 'straight', waterlogged: false }], [-1, 1, 3, 'acacia_planks']]
  for (let y = 1; y <= 3; y++) cells.push([0, y, 1, 'stone'])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.6074165, 1, .4952658); bot.entity.velocity.y = -.0784000015258789
  const { planJumpAsync, simulatePlan } = require('../src/navigation/parkour')
  const target = new Vec3(-.5, 1.5, 2.2)
  const plan = await planJumpAsync(bot, { aborted: false }, target, { allowWalk: true, planningMs: 180 })
  assert.ok(plan, 'an optional detour cushion cannot hide an actually clear partial support')
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 1.5)
  assert.ok(landed.pos.distanceTo(target) < .22)
})

test('exhausted native spring profiles bound only the impossible height family from that actual source support', async () => {
  const cells: Array<[number, number, number, string]> = [[0, 3, 0, 'stone'], [1, 3, 0, 'stone'], [2, 3, 0, 'stone'], [4, 0, 0, 'slime_block'], [5, 0, 0, 'slime_block'], [7, 4, 0, 'stone'], [8, 4, 0, 'stone']]
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(2.5, 4, .5); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(7.5, 5, .5); const spring = new Vec3(4.5, 1, .5)
  const { planJump } = require('../src/navigation/parkour')
  const { supportRoute, transitionKey, landingKey } = require('../src/navigation/support-route')
  const diagnostics: Record<string, any> = { frames: 0, profiles: 0 }
  assert.equal(planJump(bot, target, { bounce: spring, maxTicks: 90, diagnostics }), null)
  assert.equal(diagnostics.why, undefined, 'a CPU cutoff may not exclude unexplored launch profiles')
  assert.ok(diagnostics.reboundCeiling < target.y && diagnostics.reboundCeiling > 4.5)
  const ceilings = new Map([[`${landingKey(bot.entity.position)}~${landingKey(spring)}`, diagnostics.reboundCeiling]])
  const blocked = new Set([target, new Vec3(8.5, 5, .5)].map(to => transitionKey(bot.entity.position, to)))
  const bounded = await supportRoute(bot, bot.entity.position, target, blocked, 8, undefined, ceilings)
  bounded.forEach((option: any, index: number) => {
    const from = index ? bounded[index - 1].target : bot.entity.position
    if (option.bounce && landingKey(from) === landingKey(bot.entity.position) && landingKey(option.bounce) === landingKey(spring)) assert.ok(option.target.y <= diagnostics.reboundCeiling, 'the exhausted family is bounded from its actual source and spring; a changed approach earns a separate forecast')
  })
  const higher = worldOf(cells.map(([x, y, z, name]) => [x, name === 'stone' && x <= 2 ? 7 : y, z, name]))
  higher.bot.entity.position = new Vec3(2.5, 8, .5); higher.bot.entity.velocity.y = -.0784000015258789
  assert.ok(planJump(higher.bot, target, { bounce: spring, maxTicks: 90 }), 'a higher genuine approach retains its independently reachable spring edge')
})

test('landing visibility uses the exposed collision top when neighbouring floor hides block centers', () => {
  const { bot } = worldOf([[0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone']])
  bot.canSeeBlock = () => false
  let endY = 0
  bot.world = { raycast(from: Vec3, direction: Vec3, distance: number) { endY = from.y + direction.y * distance; return endY < 1 ? {} : null } }
  const { visibleLanding, localOptions } = require('../src/navigation/parkour')
  assert.equal(visibleLanding(bot, new Vec3(2.5, 1, .5)), true)
  assert.ok(endY > 1 && endY < 1.03)
  assert.ok(localOptions(bot, { toward: new Vec3(2.5, 1, .5) }).some((option: any) => option.target.x === 2.5))
  bot.world.raycast = () => ({ position: new Vec3(1, 1, 0) })
  assert.equal(visibleLanding(bot, new Vec3(2.5, 1, .5)), false, 'solid cover still refuses an unobserved landing')
})

test('support routing approaches around a ridge taller than the native jump instead of repeatedly targeting behind it', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -7; x <= 7; x++) for (let z = 0; z <= 7; z++) cells.push([x, 0, z, 'stone'])
  for (let x = -4; x <= 4; x++) for (const y of [1, 2]) cells.push([x, y, 2, 'stone'])
  for (let x = -7; x <= 7; x++) for (let z = 4; z <= 7; z++) cells.push([x, 1, z, 'stone'])
  const { bot } = worldOf(cells)
  bot.entity.velocity.y = -.0784000015258789
  const { supportRoute } = require('../src/navigation/support-route')
  const path = await supportRoute(bot, bot.entity.position, new Vec3(.5, 2, 6.5), new Set(), 8)
  assert.ok(path.length)
  const { planJumpAsync } = require('../src/navigation/parkour')
  for (const option of path) {
    const plan = await planJumpAsync(bot, { aborted: false }, option.target, { allowWalk: true, planningMs: 180 })
    assert.ok(plan, `the chosen approach must have a real native trajectory to ${option.target}`)
    const landed = plan.states[plan.states.length - 1]
    bot.entity.position = landed.pos; bot.entity.velocity = landed.vel; bot.entity.onGround = landed.onGround
  }
})

test('a nearby lower goal can require intermediate supports above its height', async () => {
  const { bot } = worldOf([[0, 0, 0, 'stone'], [1, 1, 0, 'stone'], [2, 2, 0, 'stone'], [3, 3, 0, 'stone'], [4, 4, 0, 'stone'], [5, 3, 0, 'stone'], [6, 2, 0, 'stone'], [7, 1, 0, 'stone']])
  const path = await require('../src/navigation/support-route').supportRoute(bot, bot.entity.position, new Vec3(7.5, 2, .5), new Set(), 8)
  assert.ok(path.some((option: any) => option.target.y >= 4), 'the bounded graph must retain the higher intermediate approach')
})

test('support discovery derives stable exposed edges from collision shapes above the floor block', () => {
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [0, 1, 0, 'oak_fence', { north: false, south: false, east: true, west: true, waterlogged: false }]])
  const { standPositions, bodyClear, supportAt } = require('../src/navigation/geometry')
  const choices = standPositions(bot, new Vec3(0, 1, 0), { rise: 0, drop: 0 })
  assert.ok(choices.length, 'the observed floor has exposed support beside the elevated rail even though its center clips it')
  for (const p of choices) {
    assert.equal(bodyClear(bot, p), true); assert.ok(supportAt(bot, p, .01))
    bot.entity.position = p; bot.entity.velocity = new Vec3(0, -.0784000015258789, 0)
    const state = new native.PlayerState(bot, { ...require('../src/navigation/parkour').IDLE, sneak: true })
    for (let tick = 0; tick < 6; tick++) bot.physics.simulatePlayer(state, world)
    assert.equal(state.onGround, true); assert.equal(state.pos.y, 1); assert.ok(state.pos.distanceTo(p) < 1e-6)
  }
})

test('routing can recognise an actual stable partial top within native step height while refusing unsupported or airborne poses', () => {
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [0, 1, 0, 'daylight_detector']])
  const { settledLanding, IDLE } = require('../src/navigation/parkour')
  bot.entity.position = new Vec3(-.05, 1.375, .64); bot.entity.velocity = new Vec3(0, -.0784000015258789, 0)
  const state = new native.PlayerState(bot, { ...IDLE, sneak: true })
  for (let tick = 0; tick < 6; tick++) {
    bot.physics.simulatePlayer(state, world)
    assert.equal(settledLanding(bot, state, new Vec3(-.3, 1, .5)), true)
  }
  assert.equal(settledLanding(bot, { ...state, pos: new Vec3(-.8, 1.375, .5) }, new Vec3(-.8, 1, .5)), false)
  assert.equal(settledLanding(bot, { ...state, onGround: false }, new Vec3(-.3, 1, .5)), false)
  assert.equal(settledLanding(bot, state, new Vec3(-.3, 0, .5)), false)
})

test('edge support follows actual 1.21.11 shapes, including narrow centers and fence height', () => {
  const { bot } = worldOf([[0, 0, 0, 'oak_fence', { north: false, south: false, east: false, west: false, waterlogged: false }]])
  const support = require('../src/edges').support
  assert.equal(support(bot, new Vec3(.5, 1.5, .5)).drop, 0)
  assert.ok(support(bot, new Vec3(.05, 1.5, .05)).drop > 3, 'the corners of the cell are air, not fence support')
})

test('geometry selects shape tops and tests the entire player body against rotated states', () => {
  const { supportAt, bodyClear, standPositions } = require('../src/navigation/geometry')
  for (const [name, properties, height] of [
    ['skeleton_skull', { rotation: 0 }, .5],
    ['oak_slab', { type: 'bottom', waterlogged: false }, .5],
    ['oak_slab', { type: 'top', waterlogged: false }, 1],
    ['oak_fence', { north: false, south: false, east: false, west: false, waterlogged: false }, 1.5],
    ['glass_pane', { north: false, south: false, east: false, west: false, waterlogged: false }, 1],
    ['pointed_dripstone', { vertical_direction: 'up', thickness: 'tip', waterlogged: false }, .6875]
  ] as const) {
    const { bot } = worldOf([[0, 0, 0, name, properties]])
    assert.equal(supportAt(bot, new Vec3(.5, height, .5), .01)?.top, height, name)
    assert.ok(standPositions(bot, new Vec3(0, height, 0), { rise: 1, drop: 1 }).some((p: Vec3) => p.y === height), name)
  }
  const { bot } = worldOf([[0, 0, 0, 'stone'], [1, 1, 0, 'stone']])
  assert.equal(bodyClear(bot, new Vec3(.8, 1, .5)), false, 'body edge clips the adjacent wall')
  assert.equal(bodyClear(bot, new Vec3(.69, 1, .5)), true)
  for (const facing of ['east', 'west', 'north', 'south']) {
    const stairs = worldOf([[0, 0, 0, 'jungle_stairs', { facing, half: 'bottom', shape: 'straight', waterlogged: false }]])
    assert.ok(standPositions(stairs.bot, new Vec3(0, .5, 0), { rise: .5, drop: 0 }).some((p: Vec3) => p.y === .5), `${facing} lower tread needs an offset body center`)
  }
})

test('native parkour crosses a gap, lands on a narrow support and keeps a safe resting body', () => {
  const { planJump, simulatePlan } = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 0, 0, 'oak_fence', { north: false, south: false, east: false, west: false, waterlogged: false }]])
  const target = new Vec3(2.5, 1.5, .5)
  const plan = planJump(bot, target)
  assert.ok(plan, 'native physics must find a legal jump to the fence')
  const end = simulatePlan(bot, plan.steps)
  assert.ok(end.onGround)
  assert.ok(Math.hypot(end.pos.x - target.x, end.pos.z - target.z) < .25)
  assert.equal(end.pos.y, 1.5)
})

test('air steering goes around a full wall and returns to a fence behind it', () => {
  const { planJump, simulatePlan } = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [0, 0, -1, 'stone'], [1, 1, 0, 'stone'], [1, 2, 0, 'stone'],
    [2, 0, 0, 'oak_fence', { north: false, south: false, east: false, west: false, waterlogged: false }]])
  // Grounded clients retain native downward gravity, including the physical
  // fixture's state. A zero-velocity construction hid run-up search failures.
  const idle = new native.PlayerState(bot, require('../src/navigation/parkour').IDLE)
  bot.physics.simulatePlayer(idle, { getBlock: bot.blockAt })
  bot.entity.velocity = idle.vel
  const target = new Vec3(2.5, 1.5, .5)
  const plan = planJump(bot, target, { beam: 60, maxTicks: 38 })
  assert.ok(plan, 'wall detour needs air steering and a real fence landing')
  const end = simulatePlan(bot, plan.steps)
  assert.ok(end.onGround)
  assert.equal(end.pos.y, 1.5)
  assert.ok(plan.steps.some((step: { yaw: number }) => Math.abs(Math.cos(step.yaw)) > .3), 'plan includes lateral steering')
})

test('normal parkour refuses web trajectories and unsupported or head-blocked targets', () => {
  const { planJump } = require('../src/navigation/parkour')
  const blocked = worldOf([[0, 0, 0, 'stone'], [2, 0, 0, 'stone'], [2, 2, 0, 'stone']])
  assert.equal(planJump(blocked.bot, new Vec3(2.5, 1, .5)), null)
  const web = worldOf([[0, 0, 0, 'stone'], [1, 1, 0, 'cobweb'], [2, 0, 0, 'stone']])
  const plan = planJump(web.bot, new Vec3(2.5, 1, .5))
  if (plan) assert.ok(plan.states.every((state: { isInWeb: boolean }) => !state.isInWeb), 'a detour may pass; crossing the web may not')
})

test('a genuine upward tip may support standing but refuses a damaging fall onto it', () => {
  const { planJump } = require('../src/navigation/parkour')
  const { bodyClear, supportAt } = require('../src/navigation/geometry')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, -1, 0, 'stone'],
    [2, 0, 0, 'pointed_dripstone', { vertical_direction: 'up', thickness: 'tip', waterlogged: false }]])
  const target = new Vec3(2.375, .6875, .375)
  assert.ok(bodyClear(bot, target))
  assert.equal(supportAt(bot, target, .04)?.top, .6875)
  assert.ok(!planJump(bot, target, { beam: 24 }), 'native collision alone omits the server stalagmite fall damage')
})

test('shared scoped physics climbs ordinary, Nether and cave vines from the vanilla 1.21.11 tag', () => {
  const tag = require('../data/climbable-1.21.11.json').climbable.values as string[]
  for (const entry of tag) {
    const name = entry.replace('minecraft:', '')
    if (name === 'scaffolding') continue // Its one-way collision is a separate native-physics limitation.
    const { bot, world } = worldOf(Array.from({ length: 6 }, (_, y) => [0, y, 0, name] as [number, number, number, string]))
    bot.entity.onGround = false
    bot.entity.position.y = 1.5
    bot.entity.velocity.y = -.1
    const control = { forward: false, back: false, left: false, right: false, jump: true, sprint: false, sneak: false }
    const state = new native.PlayerState(bot, control)
    for (let i = 0; i < 20; i++) bot.physics.simulatePlayer(state, world)
    assert.ok(state.pos.y > 3, `${name} must use the shared native climb acceleration`)
  }
})

test('a falling body can steer into an observed web and actually slow in native physics', () => {
  const { planWebCatch, simulatePlan } = require('../src/navigation/parkour')
  const { bot } = worldOf([[1, 3, 0, 'cobweb'], [1, 0, 0, 'stone']])
  bot.entity.position = new Vec3(.9, 7, .5)
  bot.entity.velocity = new Vec3(.04, -.3, 0)
  bot.entity.onGround = false
  const plan = planWebCatch(bot, new Vec3(1.5, 3, .5))
  assert.ok(plan)
  const caught = simulatePlan(bot, plan.steps)
  assert.ok(caught.isInWeb)
  assert.ok(Math.abs(caught.vel.y) < .16)
  assert.ok(caught.pos.y > 2, 'caught above the damaging floor')
})

test('shared route motion walks continuous floor and discovers visible shape landings', () => {
  const { planJump, localOptions } = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'skeleton_skull', { rotation: 0 }]])
  const plan = planJump(bot, new Vec3(1.5, 1, .5), { allowWalk: true, beam: 16 })
  assert.ok(plan)
  assert.ok(plan.steps.every((step: { control: { jump: boolean } }) => !step.control.jump), 'ordinary walking does not force a jump')
  bot.canSeeBlock = (block: { position: Vec3 }) => block.position.x === 2
  const options = localOptions(bot, { toward: new Vec3(3, 1, .5) })
  assert.ok(options.length > 0)
  assert.ok(options.every((option: { support: string; target: Vec3 }) => option.support === 'skeleton_skull' && option.target.y === .5))
})

test('ascending routes try actual higher supports even when the route initially bends away from the goal', () => {
  const { localOptions } = require('../src/navigation/parkour')
  const { bot } = worldOf([[-2, 0, 0, 'stone'], [-1, 0, 0, 'stone'], [0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 1, 0, 'stone']])
  const options = localOptions(bot, { toward: new Vec3(-10, 7, .5) })
  assert.equal(options[0].target.y, 2, 'flat floor closer to a distant checkpoint must not starve its climbing approach')
})

test('cooperative native search shares the block cache with body geometry and keeps timers running', async () => {
  const { planJumpAsync, IDLE } = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [0, 0, -1, 'stone'], [1, 1, 0, 'stone'], [1, 2, 0, 'stone'],
    [2, 0, 0, 'oak_fence', { north: false, south: false, east: false, west: false, waterlogged: false }]])
  const idle = new native.PlayerState(bot, IDLE)
  bot.physics.simulatePlayer(idle, { getBlock: bot.blockAt }); bot.entity.velocity = idle.vel
  const read = bot.blockAt; let reads = 0; let heartbeats = 0
  bot.blockAt = (p: Vec3) => { reads++; return read(p) }
  const timer = setInterval(() => { heartbeats++ }, 1)
  try {
    const plan = await planJumpAsync(bot, { aborted: false }, new Vec3(2.5, 1.5, .5), { beam: 60 })
    assert.ok(plan)
    assert.ok(heartbeats > 20, 'the async search must allow the physical clock to run')
    assert.ok(reads < 500, `body geometry must reuse observed blocks, got ${reads} reads`)
  } finally { clearInterval(timer) }
})

export { worldOf }

test('loaded support graph chooses a chain around the goal and removes refused native edges', async () => {
  const { supportRoute, landingKey } = require('../src/navigation/support-route')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 1, 0, 'stone'], [4, 2, 1, 'stone'], [2, 3, 3, 'stone'], [0, 4, 4, 'stone'], [-2, 5, 4, 'stone']])
  const goal = new Vec3(-1.5, 6, 4.5)
  const path = await supportRoute(bot, bot.entity.position, goal, new Set())
  assert.ok(path.length >= 5, 'a distant ascent uses intermediate actual supports')
  assert.equal(path[0].target.y, 2)
  assert.ok(path[0].target.x > bot.entity.position.x, 'the first waypoint may move away from the checkpoint')
  assert.ok(path[path.length - 1].target.distanceTo(goal) < .8)
  const blocked = new Set([`${landingKey(bot.entity.position)}>${path[0].key}`])
  const retry = await supportRoute(bot, bot.entity.position, goal, blocked)
  assert.ok(!retry.length || retry[0].key !== path[0].key, 'refused edges must not be selected repeatedly')
})

test('a refused optimistic gap leaves loaded short ascents available behind a sight obstruction and away from the goal', async () => {
  const { route, IDLE } = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [1, 0, -1, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone'], [1, 0, 1, 'stone'],
    [-5, 1, 0, 'stone'], [2, 1, -3, 'stone'], [3, 1, -3, 'stone'], [3, 1, -2, 'stone'], [3, 2, -5, 'stone']])
  bot.entity.position = new Vec3(.470686, 1, .471266); bot.entity.velocity.y = -.0784000015258789
  bot.canSeeBlock = () => false
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
    }
  }
  const result = await route(bot, { aborted: false }, { toward: new Vec3(-4.5, 2, .5), maxLandings: 3 })
  assert.ok(result.rejected.length, 'the direct gap has no executable native trajectory')
  assert.ok(result.landings.some((landing: any) => landing.ok && landing.at.x > 2 && landing.at.y >= 2), 'a short observed ascent must reach the same native controller before repeated speculative gap edges exhaust the route')
  assert.equal(bot.health, 20); assert.equal(bot.entity.onGround, true)
})

test('a refused wide gap explores an unvisited flat approach instead of returning to the same inner raised ledge', async () => {
  const cells: Array<[number, number, number, string]> = [[0, 0, 0, 'stone'], [-1, 1, 0, 'stone'], [-7, 1, 0, 'stone']]
  for (let x = 1; x <= 4; x++) cells.push([x, 1, 0, 'stone'])
  for (let z = 1; z <= 5; z++) cells.push([4, 1, z, 'stone'])
  for (let x = -7; x < 4; x++) cells.push([x, 1, 5, 'stone'])
  for (let z = 1; z < 5; z++) cells.push([-7, 1, z, 'stone'])
  cells.push([-7, 2, -2, 'stone'], [-7, 3, -4, 'stone'])
  const { bot, world } = worldOf(cells)
  const { route, IDLE } = require('../src/navigation/parkour')
  bot.entity.velocity.y = -.0784000015258789; bot.canSeeBlock = () => false
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control); bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
    }
  }
  const result = await route(bot, { aborted: false }, { toward: new Vec3(-6.5, 2, .5), maxLandings: 4 })
  assert.ok(result.landings.some((landing: any) => landing.ok && landing.at.x > 1.5 && landing.at.y === 2), JSON.stringify(result.landings))
  assert.equal(bot.health, 20); assert.equal(bot.entity.onGround, true)
})

test('a macro route replans from six real supported stopping frames after a bounded landing correction without claiming its exact target', async () => {
  const { bot, world } = worldOf(Array.from({ length: 9 }, (_, x) => [x, 0, 0, 'stone'] as [number, number, number, string]))
  const { route, IDLE } = require('../src/navigation/parkour')
  bot.entity.velocity.y = -.0784000015258789
  let control = { ...IDLE }; let corrected = false
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control); bot.physics.simulatePlayer(state, world); state.apply(bot)
      if (!corrected && control.sneak && bot.entity.onGround) { bot.entity.position.z += .4; corrected = true }
      bot.emit('physicsTick')
    }
  }
  const target = new Vec3(8.5, 1, .5)
  const result = await route(bot, { aborted: false }, { toward: target, maxLandings: 8 })
  assert.equal(corrected, true)
  assert.equal(result.ok, true, JSON.stringify(result.landings))
  assert.ok(result.landings.some((landing: any) => landing.ok === false && landing.why === 'landing_not_confirmed' && landing.actualLanding?.confirmed === true), 'the exact requested landing stays unconfirmed while the observed stable support lets routing continue')
  assert.ok(bot.entity.position.distanceTo(target) < .35); assert.equal(bot.entity.onGround, true); assert.equal(bot.health, 20)
  assert.equal(bot._ndParkourForecast, undefined)
})

test('loaded support graph connects a real climbable column to its upper platform', async () => {
  const { supportRoute } = require('../src/navigation/support-route')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone']]
  for (let y = 1; y < 6; y++) cells.push([1, y, 0, 'stone'], [0, y, 0, 'ladder', { facing: 'west', waterlogged: false }])
  const { bot } = worldOf(cells)
  const path = await supportRoute(bot, bot.entity.position, new Vec3(1.5, 6, .5), new Set())
  assert.ok(path.length)
  assert.equal(path[0].mode, 'climb')
  assert.equal(path[0].target.y, 6)
})

test('a translated observed closed door and wooden ladder room cannot create a climb graph connection from outside', async () => {
  const { supportRoute } = require('../src/navigation/support-route')
  // Author39: translated by (+21,-102,-41). The exact door state is native;
  // the remaining room shell was read from the official unchanged map copy.
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = []
  for (let x = -3; x <= 3; x++) for (let z = -2; z <= 3; z++) cells.push([x, 0, z, 'white_concrete_powder'])
  for (let y = 1; y <= 4; y++) {
    for (const x of [-1, 1]) for (let z = 0; z <= 2; z++) cells.push([x, y, z, 'birch_wood', { axis: 'y' }])
    cells.push([0, y, 0, y <= 2 ? 'iron_door' : 'birch_wood', y <= 2 ? { facing: 'north', half: y === 1 ? 'lower' : 'upper', hinge: 'left', open: false, powered: false } : { axis: 'y' }])
    cells.push([0, y, 2, y === 2 ? 'white_stained_glass_pane' : 'birch_wood', y === 2 ? { east: true, west: true, north: false, south: false, waterlogged: false } : { axis: 'y' }])
    cells.push([0, y, 1, 'ladder', { facing: 'east', waterlogged: false }])
  }
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.426236141557414, 1, -.50526270235978)
  const path = await supportRoute(bot, bot.entity.position, new Vec3(-.5, 5, .5), new Set(), 6)
  assert.ok(path.every((option: any) => !option.climb), 'a free tagged column behind the closed shape enclosure is not an accessible climb contact')
})

test('a complete observed long ladder or vine connects its actual exit and retains a native stable landing', async () => {
  const { supportRoute } = require('../src/navigation/support-route')
  const { planJumpAsync, simulatePlan } = require('../src/navigation/parkour')
  for (const name of ['ladder', 'vine']) {
    const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone']]
    // The open lower shaft of the map copy, translated from Y94..106 to Y1..13.
    // This does not prove the unobserved approach from the current native pose.
    for (let y = 0; y <= 13; y++) cells.push([-1, y, 0, 'stone'])
    for (let y = 1; y <= 13; y++) cells.push([0, y, 0, name, name === 'ladder' ? { facing: 'east', waterlogged: false } : { west: true }])
    const { bot } = worldOf(cells); bot.entity.velocity.y = -.0784000015258789
    const before = bot.entity.position.clone(); const target = new Vec3(-.5, 14, .5)
    const path = await supportRoute(bot, before, target, new Set(), 6)
    assert.ok(path.some((option: any) => option.climb && option.target.distanceTo(target) < .8), 'the observed column exit must not disappear above the ordinary eight-block support scan')
    const plan = await planJumpAsync(bot, { aborted: false }, target, { climb: { x: .5, y: 1, z: .5 }, maxTicks: 180, planningMs: 180, allowWalk: true })
    assert.ok(plan, 'the full loaded climb must use the existing native direct profile instead of an eight-block height refusal')
    assert.deepEqual(bot.entity.position, before)
    const landed = simulatePlan(bot, plan.steps)
    assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 14)
    assert.ok(landed.pos.distanceTo(target) < .22)
    assert.ok(plan.states.slice(-6).every((state: any) => state.onGround && state.pos.y === 14 && state.pos.distanceTo(target) < .22))
  }
})

test('the shared route executes a full observed long climb through the existing controller and releases its owner', async () => {
  const { route, IDLE } = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone']]
  for (let y = 0; y <= 13; y++) cells.push([-1, y, 0, 'stone'])
  for (let y = 1; y <= 13; y++) cells.push([0, y, 0, 'ladder', { facing: 'east', waterlogged: false }])
  const { bot, world } = worldOf(cells); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(-.5, 14, .5); let control = { ...IDLE }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
    }
  }
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const result = await route(bot, ctl, { toward: target, maxLandings: 3 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.landings.some((receipt: any) => receipt.mode === 'climb' && receipt.ok && receipt.at.y === 14))
  assert.equal(bot.entity.onGround, true); assert.ok(bot.entity.position.distanceTo(target) < .22)
  assert.equal(bot._ndParkourForecast, undefined); assert.equal(ctl.onAbort.length, 0)
  assert.equal(control.forward, false); assert.equal(control.jump, false)
})

test('a long climb refuses an unknown column end or a solid roof before native movement', async () => {
  const { supportRoute } = require('../src/navigation/support-route')
  const { planJumpAsync } = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone']]
  for (let y = 0; y <= 13; y++) cells.push([-1, y, 0, 'stone'])
  for (let y = 1; y <= 13; y++) cells.push([0, y, 0, 'ladder', { facing: 'east', waterlogged: false }])
  const target = new Vec3(-.5, 14, .5); const contact = { x: .5, y: 1, z: .5 }
  const unknown = worldOf(cells); const observed = unknown.bot.blockAt
  unknown.bot.blockAt = (p: Vec3) => p.x >= 0 && p.x < 1 && p.z >= 0 && p.z < 1 && p.y >= 14 ? null : observed(p)
  const missing = await supportRoute(unknown.bot, unknown.bot.entity.position, target, new Set(), 6)
  assert.ok(missing.every((option: any) => option.target.y < 14))
  assert.equal(await planJumpAsync(unknown.bot, { aborted: false }, target, { climb: contact, maxTicks: 180, planningMs: 180 }), null)
  for (let x = -2; x <= 1; x++) for (let z = -1; z <= 1; z++) cells.push([x, 14, z, 'stone'])
  const roof = worldOf(cells)
  const closed = await supportRoute(roof.bot, roof.bot.entity.position, target, new Set(), 6)
  assert.ok(closed.every((option: any) => option.target.y < 14))
  assert.equal(await planJumpAsync(roof.bot, { aborted: false }, target, { climb: contact, maxTicks: 180, planningMs: 180 }), null)
  assert.deepEqual(roof.bot.entity.position, new Vec3(.5, 1, .5))
})

test('complete column observation respects actual world bounds, cancellation and a CPU budget', () => {
  const { climbColumn } = require('../src/navigation/support-route')
  const { bot } = worldOf([[0, 1, 0, 'ladder', { facing: 'east', waterlogged: false }]])
  const ladder = bot.blockAt(new Vec3(0, 1, 0)); let reads = 0
  bot.game = { minY: 0, height: 32 }
  bot.blockAt = (p: Vec3) => { reads++; assert.ok(p.y < 32, 'the scan cannot query beyond the observed dimension'); return { ...ladder, position: p } }
  assert.equal(climbColumn(bot, { x: .5, y: 1, z: .5 }), null)
  assert.equal(reads, 31, 'an endless fake column must stop at the real dimension bound')
  reads = 0
  assert.equal(climbColumn(bot, { x: .5, y: 1, z: .5 }, () => reads >= 3), null)
  assert.equal(reads, 3)
  reads = 0
  assert.equal(climbColumn(bot, { x: .5, y: 1, z: .5 }, undefined, 0), null)
  assert.equal(reads, 0)
})

test('a real side approach around a tall corner remains a native climb connection when the direct body path is blocked', async () => {
  const { supportRoute } = require('../src/navigation/support-route')
  const { planJumpAsync, simulatePlan } = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 2, 'stone']]
  for (let y = 0; y <= 2; y++) cells.push([0, y, 0, 'stone'])
  for (let y = 0; y <= 3; y++) cells.push([0, y, 1, 'stone'])
  for (let y = 1; y <= 2; y++) cells.push([1, y, 0, 'ladder', { facing: 'east', waterlogged: false }])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.5, 1, 2.5); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(.5, 3, .5)
  const path = await supportRoute(bot, bot.entity.position, target, new Set(), 6)
  assert.ok(path.some((option: any) => option.climb), 'a blocked straight ray must not hide the observed side catch')
  const plan = await planJumpAsync(bot, { aborted: false }, target, { climb: new Vec3(1.5, 1, .5), maxTicks: 90, planningMs: 180 })
  assert.ok(plan)
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 3); assert.ok(landed.pos.distanceTo(target) < .22)
})

test('a native jump over a low enclosure can catch its ladder from a higher approach plane', async () => {
  const { supportRoute } = require('../src/navigation/support-route')
  const { planJumpAsync, simulatePlan } = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = []
  for (let x = -2; x <= 2; x++) for (let z = -3; z <= 3; z++) cells.push([x, 0, z, 'stone'])
  for (const x of [-1, 1]) for (let z = 0; z <= 2; z++) cells.push([x, 1, z, 'stone'])
  cells.push([0, 1, 0, 'stone'], [0, 1, 2, 'stone'])
  for (let y = 1; y <= 3; y++) cells.push([-1, y, 1, 'stone'], [0, y, 1, 'ladder', { facing: 'east', waterlogged: false }])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.5, 1, -1.5); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(-.5, 4, 1.5)
  const plan = await planJumpAsync(bot, { aborted: false }, target, { climb: new Vec3(.5, 1, 1.5), maxTicks: 90, planningMs: 180 })
  assert.ok(plan, 'the native integrator earns a real jump over the one-block front wall before ladder contact')
  const landed = simulatePlan(bot, plan.steps)
  assert.equal(landed.onGround, true); assert.equal(landed.pos.y, 4)
  const path = await supportRoute(bot, bot.entity.position, target, new Set(), 6)
  assert.ok(path.some((option: any) => option.climb), 'a ground-only enclosure cannot remove a native reachable elevated catch')
})

test('an optimistic climb refusal preserves its assigned contact and bounded observed body geometry without moving', async () => {
  const { route, IDLE } = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, 0, 0, 'stone']]
  for (let y = 1; y <= 4; y++) cells.push([3, y, 0, 'stone'], [2, y, 0, 'ladder', { facing: 'west', waterlogged: false }])
  for (let y = 1; y <= 6; y++) for (let z = -3; z <= 3; z++) cells.push([1, y, z, 'stone'])
  const { bot } = worldOf(cells); const before = bot.entity.position.clone()
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.waitForTicks = async () => assert.fail('a refused optimistic climb may not execute any motion')
  const result = await route(bot, { aborted: false }, { toward: new Vec3(3.5, 5, .5), maxLandings: 1 })
  const refused = result.rejected.find((receipt: any) => receipt.mode === 'climb')
  assert.ok(refused, 'the loaded tag column creates an optimistic graph edge, then full native body clearance refuses its blocked catch')
  assert.equal(refused.ticks, 0); assert.equal(refused.why, 'no_safe_native_trajectory')
  assert.deepEqual(refused.climb, { x: 2.5, y: 1, z: .5 })
  assert.deepEqual(refused.waypoints[0].climb, refused.climb)
  const observation = refused.forecast.observation
  assert.deepEqual(observation.start.at, { x: .5, y: 1, z: .5 })
  assert.deepEqual(observation.climb.at, refused.climb)
  assert.ok(observation.climb.cells.some((cell: any) => cell.loaded && cell.name === 'ladder' && cell.position.y === 1 && cell.properties.facing === 'west' && cell.shapes.length > 0))
  assert.ok(observation.target.cells.some((cell: any) => cell.loaded && cell.name === 'stone' && cell.position.y === 4))
  assert.ok(Object.values(observation).reduce<number>((count, entry: any) => count + entry.cells.length, 0) <= 64, 'refusal geometry is limited to a few native body neighbourhoods')
  assert.deepEqual(bot.entity.position, before); assert.equal(bot.health, 20); assert.equal(control.forward, false)
})

test('native movement changes controls between every tick of a synchronous catch-up batch', async () => {
  const { planJump, executePlan, IDLE } = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [2, 1, 0, 'stone']])
  const plan = planJump(bot, new Vec3(2.5, 2, .5))
  assert.ok(plan)
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < Math.ceil(ticks / 4) * 4; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      bot.emit('physicsTick')
    }
  }
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const result = await executePlan(bot, ctl, plan, (state: { pos: Vec3; onGround: boolean }) => state.onGround && state.pos.distanceTo(new Vec3(2.5, 2, .5)) < .25)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.ticks, plan.steps.length)
  result.samples.forEach((sample: { pos: { x: number; y: number; z: number } }, tick: number) => {
    assert.ok(new Vec3(sample.pos.x, sample.pos.y, sample.pos.z).distanceTo(plan.states[tick].pos) < 1e-6, `native tick ${tick + 1} must receive its forecast control`)
  })
  assert.equal(bot.listenerCount('physicsTick'), 0)
  assert.equal(bot.listenerCount('end'), 0)
  assert.equal(ctl.onAbort.length, 0)
  assert.equal(bot._ndParkourForecast, undefined)
  assert.equal(control.forward, false); assert.equal(control.sneak, true)
})

test('the shared controller executes through installed Mineflayer look, queued jump, input and tick plugins', async () => {
  const { planJump, executePlan } = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 1, 0, 'stone']])
  const callbacks: Array<() => void> = []; let elapsed = 0
  const clock = { now: () => elapsed, setInterval: (fn: () => void) => { callbacks.push(fn); return fn }, clearInterval() {}, setTimeout: () => null, clearTimeout() {} }
  const packets: string[] = []
  bot._client = Object.assign(new EventEmitter(), { state: 'play', write: (name: string) => { packets.push(name) } })
  bot.supportFeature = registry.supportFeature; bot.entity.id = 1; bot.entities = {}; bot.isAlive = true
  bot.game = { gameMode: 'survival', minY: -64 }
  require('../src/tick-plugins').createTickPlugins(clock).plugins.physics(bot, { physicsEnabled: true })
  bot.emit('login'); bot._client.emit('position', { x: .5, y: 1, z: .5, yaw: 90, pitch: 0, flags: {}, teleportId: 1 })
  for (let tick = 0; tick < 2; tick++) { elapsed += 50; callbacks[0]() } // Actual floor contact after the airborne position receipt.
  const plan = planJump(bot, new Vec3(2.5, 2, .5))
  assert.ok(plan, JSON.stringify(new native.PlayerState(bot, { ...require('../src/navigation/parkour').IDLE })))
  try {
    const work = executePlan(bot, { aborted: false }, plan, (state: { pos: Vec3; onGround: boolean }) => state.onGround && state.pos.distanceTo(new Vec3(2.5, 2, .5)) < .25)
    for (let tick = 0; tick < plan.steps.length; tick++) { elapsed += 50; callbacks[0]() }
    const result = await work
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.ticks, plan.steps.length)
    assert.ok(packets.includes('player_input')); assert.ok(packets.includes('tick_end'))
    assert.equal(bot.getControlState('forward'), false); assert.equal(bot.getControlState('sneak'), true)
  } finally { bot.emit('end') }
})

test('a loaded connected route still executes native movement when the next floor is not visible', async () => {
  const { route, IDLE } = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone']])
  let control = { ...IDLE }
  bot.canSeeBlock = () => false
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world)
      state.apply(bot); bot.emit('physicsTick')
    }
  }
  const result = await route(bot, { aborted: false }, { toward: new Vec3(2.5, 1, .5), maxLandings: 4 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.landings.length, 'a known hidden floor must reach the native movement controller')
  assert.ok(bot.entity.position.distanceTo(new Vec3(2.5, 1, .5)) < .25)
})

test('route returns its completed landings and interrupted trajectory at its own game deadline before the outer RPC timeout', async () => {
  const clockModule = require('../src/game-clock')
  const clock = new clockModule.GameClock({ manual: true, epoch: 0 }); clockModule.activate(clock)
  const { navigate, IDLE } = require('../src/navigation/parkour')
  const { bot, world } = worldOf(Array.from({ length: 5 }, (_, x) => [x, 0, 0, 'stone'] as [number, number, number, string]))
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  let control = { ...IDLE }; let completed = 0
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.on('nd_parkour_route', (receipt: { ok: boolean }) => {
    if (receipt.ok && ++completed === 1) clock.advanceTicks(19997 - clock.ticks)
  })
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      clock.advanceTicks(1); bot.emit('physicsTick')
      if (!bot.listenerCount('physicsTick')) break
    }
  }
  try {
    const result = await navigate(bot, ctl, { mode: 'route', target: new Vec3(4.5, 1, .5), waypoints: [new Vec3(2.5, 1, .5)], maxLandings: 8, timeoutSeconds: 1000 })
    assert.equal(result.ok, false); assert.equal(result.why, 'route_deadline')
    assert.equal(result.landings.length, 2, 'the report keeps the completed landing and the motion interrupted at the deadline')
    assert.equal(result.landings[0].ok, true)
    const interrupted = result.landings[1]
    assert.equal(interrupted.why, 'interrupted'); assert.ok(interrupted.ticks > 0)
    assert.ok(interrupted.trajectory.at(-1).expected)
    assert.ok(interrupted.trajectory.at(-1).observation.actual.cells.length)
    assert.equal(clock.now(), 1000000); assert.ok(clock.now() < 1020000)
    assert.equal(ctl.aborted, false); assert.equal(ctl.onAbort.length, 0)
    assert.equal(bot.listenerCount('physicsTick'), 0); assert.equal(bot.listenerCount('end'), 0)
    assert.equal(bot._ndParkourForecast, undefined); assert.equal(control.forward, false)
  } finally { clock.dispose(); clockModule.activate(null) }
})

test('a support graph stops reading loaded blocks when cancellation arrives at its cooperative yield', async () => {
  const { supportRoute } = require('../src/navigation/support-route')
  const { bot } = worldOf(Array.from({ length: 13 }, (_, i) => Array.from({ length: 13 }, (_, j) => [i - 6, 0, j - 6, 'stone'] as [number, number, number, string])).flat())
  let cancelled = false; let reads = 0; let readsAfterCancellation = 0
  const observed = { physics: bot.physics, blockAt(p: Vec3) { reads++; if (cancelled) readsAfterCancellation++; return bot.blockAt(p) } }
  const cancellation = setImmediate(() => { cancelled = true })
  try {
    const path = await supportRoute(observed, new Vec3(.5, 1, .5), new Vec3(6.5, 1, 6.5), new Set(), 6, {}, undefined, () => cancelled)
    assert.ok(reads > 0, 'cancellation must reach an already-running graph scan')
    assert.equal(readsAfterCancellation, 0, 'resuming a cancelled scan may not keep reading the remaining radius')
    assert.equal(path.length, 0)
  } finally { clearImmediate(cancellation) }
})

test('a route deadline reached inside the next support scan retains the preceding physical landing without launching another edge', async () => {
  const clockModule = require('../src/game-clock')
  const clock = new clockModule.GameClock({ manual: true, epoch: 0 }); clockModule.activate(clock)
  const { navigate, IDLE } = require('../src/navigation/parkour')
  const { bot, world } = worldOf(Array.from({ length: 9 }, (_, x) => [x, 0, 0, 'stone'] as [number, number, number, string]))
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  let control = { ...IDLE }; let expiry: ReturnType<typeof setImmediate> | undefined; let readsAfterDeadline = 0
  const read = bot.blockAt
  bot.blockAt = (p: Vec3) => { if (clock.now() >= 1000000) readsAfterDeadline++; return read(p) }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.once('nd_parkour_route', () => { expiry = setImmediate(() => clock.advanceTicks(20000 - clock.ticks)) })
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot)
      clock.advanceTicks(1); bot.emit('physicsTick')
      if (!bot.listenerCount('physicsTick')) break
    }
  }
  try {
    const result = await navigate(bot, ctl, { mode: 'route', target: new Vec3(8.5, 1, .5), waypoints: [new Vec3(2.5, 1, .5)], maxLandings: 8, timeoutSeconds: 1000 })
    assert.equal(result.why, 'route_deadline'); assert.equal(result.ok, false)
    assert.equal(result.landings.length, 1); assert.equal(result.landings[0].ok, true)
    assert.equal(result.reachedGoals.length, 1); assert.equal(result.rejected.length, 0)
    assert.equal(readsAfterDeadline, 0, 'a cancelled graph returns the report before geometry fallback or another motion forecast')
    assert.equal(ctl.aborted, false); assert.equal(ctl.onAbort.length, 0)
    assert.equal(bot._ndParkourForecast, undefined); assert.equal(control.forward, false)
  } finally { if (expiry) clearImmediate(expiry); clock.dispose(); clockModule.activate(null) }
})

test('failed long bounce forecasts do not blacklist a support reachable after a shorter real bounce', async () => {
  const { route, IDLE } = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[-4, 3, 0, 'stone'], [0, 0, 2, 'slime_block'], [1, 0, 2, 'slime_block'],
    [4, 3, 2, 'spruce_slab'], [5, 3, 2, 'spruce_slab'], [6, 3, 2, 'spruce_slab'], [8, 3, -1, 'spruce_slab']])
  bot.entity.position = new Vec3(-3.41, 4, .49855); bot.entity.velocity.y = -.0784000015258789
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
    }
  }
  const result = await route(bot, { aborted: false }, { toward: new Vec3(8.5, 3.5, -.5), maxLandings: 16 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.rejected.filter((attempt: any) => attempt.target.x === 6.5 && attempt.bounce && attempt.ticks === 0).length >= 2)
  assert.ok(result.landings.some((landing: any) => landing.target.x === 6.5 && !landing.bounce && landing.ok), 'the same observed support remains reachable from the actual intermediate landing')
  assert.equal(bot.health, 20); assert.equal(bot.entity.onGround, true)
})

test('real edge guard retains native simulation for a confirmed plan and resumes after drift, damage or expiry', () => {
  const clockModule = require('../src/game-clock')
  const clock = new clockModule.GameClock({ manual: true }); clockModule.activate(clock)
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [2, 0, 0, 'stone']])
  const control = { ...require('../src/navigation/parkour').IDLE, forward: true }
  const nativeSim = bot.physics.simulatePlayer.bind(bot.physics); let calls = 0
  bot.physics.simulatePlayer = (state: any, terrain: any) => { calls++; return nativeSim(state, terrain) }
  const guard = require('../src/edges').guard(bot)
  const run = () => { calls = 0; return bot.physics.simulatePlayer(new native.PlayerState(bot, control), world) }
  try {
    for (let tick = 0; tick < 3; tick++) { clock.advanceTicks(1); run() }
    bot._ndParkourForecast = { from: { ...bot.entity.position }, until: clockModule.now() + 100, hp: 20 }
    const result = run()
    assert.equal(calls, 1, 'the installed guard keeps the one actual native integration without a second planner')
    assert.ok(result.vel.y < 0, 'native gravity still advances the actual state')
    bot._ndParkourForecast.from.x += .2; run(); assert.ok(calls > 1, 'drift restores normal edge forecasts')
    bot._ndParkourForecast.from = { ...bot.entity.position }; bot.health = 19; run(); assert.ok(calls > 1, 'damage restores normal edge forecasts')
    bot.health = 20; clock.advanceTicks(3); run(); assert.ok(calls > 1, 'stale ownership restores normal edge forecasts')
  } finally { guard.stop(); clock.dispose(); clockModule.activate(null) }
})

test('a refused execution retains native expected frames and the observed fluid layer below the actual body', async () => {
  const { route, IDLE } = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 0, 0, 'stone'], [1, 0, 0, 'lava'], [2, 1, 0, 'stone']])
  bot.entity.velocity.y = -.0784000015258789
  bot._ndClutch = { stats: { water_saved: 0 }, forecast: { landing: { lava: true, top: 0 }, guardAllow: false, intentional: false } }
  let control = { ...IDLE }; let ticks = 0
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (count: number) => {
    for (let tick = 0; tick < count; tick++) {
      const state = new native.PlayerState(bot, control); bot.physics.simulatePlayer(state, world); state.apply(bot)
      if (++ticks === 2) { bot.entity.position.x += .1; bot.health = 16 }
      bot.emit('physicsTick')
      if (bot.health < 20) break
    }
  }
  const result = await route(bot, { aborted: false }, { toward: new Vec3(2.5, 2, .5), maxLandings: 1 })
  assert.equal(result.ok, false); assert.equal(result.why, 'hurt_during_trajectory')
  const last = result.landings[0].trajectory.at(-1)
  assert.equal(last.tick, 2); assert.equal(last.hp, 16)
  assert.ok(Math.abs(last.pos.x - last.expected.pos.x - .1) < 1e-8, 'small real corrections must stay visible even below the controller divergence threshold')
  assert.ok(last.observation.actual.cells.some((cell: any) => cell.name === 'lava' && cell.position.y === 0 && cell.loaded), 'the receipt records actual loaded blocks below the now-rising body')
  assert.equal(last.observation.actual.body.minY, last.pos.y)
  assert.equal(last.fallReflex.marker.hp, 20, 'the failed frame keeps its exact owner before cleanup')
  assert.ok(last.fallReflex.marker.from && last.fallReflex.marker.next)
  assert.deepEqual(last.fallReflex.position, last.pos)
  assert.equal(last.fallReflex.forecast.landing.lava, true)
  assert.equal(last.fallReflex.forecast.guardAllow, false)
  assert.equal(bot._ndParkourForecast, undefined)
})

test('installed edge guard keeps only actual physics for a stationary grounded body and resumes for movement or knockback', () => {
  const clockModule = require('../src/game-clock')
  const clock = new clockModule.GameClock({ manual: true }); clockModule.activate(clock)
  const { bot, world } = worldOf([[0, 0, 0, 'stone']])
  const control = { ...require('../src/navigation/parkour').IDLE, sneak: true }
  const nativeSim = bot.physics.simulatePlayer.bind(bot.physics); let calls = 0
  bot.physics.simulatePlayer = (state: unknown, terrain: unknown) => { calls++; return nativeSim(state, terrain) }
  const guard = require('../src/edges').guard(bot)
  const run = () => { calls = 0; return bot.physics.simulatePlayer(new native.PlayerState(bot, control), world) }
  try {
    for (let tick = 0; tick < 3; tick++) { clock.advanceTicks(1); run() }
    const actual = run()
    assert.equal(calls, 1, 'idle ground cannot need a 5-block hazard scan and another native motion forecast on every accelerated tick')
    assert.ok(actual.vel.y < 0, 'the one actual integration still applies vanilla gravity')
    control.forward = true; run(); assert.ok(calls > 1, 'requested movement restores guard forecasting')
    control.forward = false; bot.entity.velocity.x = .1; run(); assert.ok(calls > 1, 'actual horizontal knockback restores guard forecasting')
    bot.entity.velocity.x = 0; bot.jumpQueued = true; run(); assert.ok(calls > 1, 'a queued jump cannot use the stationary path')
  } finally { guard.stop(); clock.dispose(); clockModule.activate(null) }
})

test('native direct profiles solve ordinary rises before a route edge CPU budget expires', async () => {
  const { planJumpAsync } = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 1, 0, 'stone']])
  const plan = await planJumpAsync(bot, { aborted: false }, new Vec3(2.5, 2, .5), { planningMs: 180 })
  assert.ok(plan)
  assert.ok(plan.states.every((state: { isInLava: boolean; isInWeb: boolean }) => !state.isInLava && !state.isInWeb))
})

test('one-cell water entry uses free body volume beside real waterlogged crystal shapes', () => {
  const { waterEntries } = require('../src/navigation/geometry')
  const { bot } = worldOf([[0, -1, 0, 'stone'], [0, 0, 0, 'large_amethyst_bud', { facing: 'west', waterlogged: true }]])
  const narrow = waterEntries(bot, new Vec3(0, 0, 0))
  assert.ok(narrow.length)
  assert.ok(narrow.filter((p: Vec3) => p.y < .8).every((p: Vec3) => p.x < .388), 'the body must fit in the observed .6875-wide side corridor')
  const blocked = worldOf([[0, -1, 0, 'stone'], [0, 0, 0, 'amethyst_cluster', { facing: 'west', waterlogged: true }]])
  assert.ok(waterEntries(blocked.bot, new Vec3(0, 0, 0)).every((p: Vec3) => p.y >= .8125), '.5625 free side width cannot admit a .6-wide body')
  const top = worldOf([[0, -1, 0, 'stone'], [0, 0, 0, 'amethyst_cluster', { facing: 'up', waterlogged: true }]])
  assert.ok(waterEntries(top.bot, new Vec3(0, 0, 0)).some((p: Vec3) => p.y === .4375), 'a body can occupy the remaining water above a low crystal')
  assert.equal(waterEntries(bot, new Vec3(2, 0, 0)).length, 0, 'dry cells cannot be treated as existing water')
})

test('a route can jump a gap to a slightly lower platform instead of only trying to walk off its edge', async () => {
  const { planJumpAsync } = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 0, 0, 'dirt_path']])
  const plan = await planJumpAsync(bot, { aborted: false }, new Vec3(2.5, .9375, .5), { allowWalk: true, planningMs: 180 })
  assert.ok(plan)
  assert.ok(plan.steps.some((step: { control: { jump: boolean } }) => step.control.jump))
})

test('native search CPU budget excludes time yielded to the physical clock', async () => {
  const { planJumpAsync } = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, 1, 0, 'stone']])
  // A busy clock callback runs while the planner cooperatively yields. It must
  // not turn a short valid native profile into a false unreachable landing.
  const callback = setImmediate(() => { const until = performance.now() + 35; while (performance.now() < until) {} })
  try {
    const plan = await planJumpAsync(bot, { aborted: false }, new Vec3(2.5, 2, .5), { planningMs: 20 })
    assert.ok(plan)
  } finally { clearImmediate(callback) }
})

test('native fall controller reaches observed one-cell water and refuses unreachable water', () => {
  const { planWaterEntry, simulatePlan } = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string, Record<string, unknown>?]> = [[0, -1, 0, 'stone'], [0, 0, 0, 'water']]
  for (const height of [12, 45, 100]) {
    const { bot } = worldOf(cells)
    bot.canSeeBlock = () => true; bot.entity.onGround = false
    bot.entity.position = new Vec3(.9, height, .4); bot.entity.velocity = new Vec3(.09, -.3, -.035)
    const plan = planWaterEntry(bot, new Vec3(.5, 0, .5))
    assert.ok(plan, `observed clear water should be reachable from height ${height}`)
    const state = simulatePlan(bot, plan.steps)
    assert.ok(state.isInWater)
    assert.ok(Math.hypot(state.vel.x, state.vel.z) < .04)
  }
  const { bot } = worldOf(cells)
  bot.canSeeBlock = () => true; bot.entity.onGround = false; bot.entity.position = new Vec3(20.5, 3, .5); bot.entity.velocity.y = -1
  assert.equal(planWaterEntry(bot, new Vec3(.5, 0, .5)), null)
  bot.canSeeBlock = () => false; bot.entity.position = new Vec3(.5, 12, .5)
  assert.equal(planWaterEntry(bot, new Vec3(.5, 0, .5)), null, 'hidden/unconfirmed fluid is refused')
  for (const [facing, reachable] of [['up', true], ['west', false]] as const) {
    const { bot } = worldOf([[0, -1, 0, 'stone'], [0, 0, 0, 'amethyst_cluster', { facing, waterlogged: true }]])
    bot.canSeeBlock = () => true; bot.entity.onGround = false; bot.entity.position = new Vec3(.5, 35, .5); bot.entity.velocity.y = -.3
    const plan = planWaterEntry(bot, new Vec3(.5, 0, .5))
    assert.equal(!!plan, reachable, `native water volume must honor ${facing} crystal orientation`)
  }
  const edge = worldOf([[0, 39, 0, 'stone'], [2, -1, 0, 'stone'], [2, 0, 0, 'water']])
  edge.bot.canSeeBlock = () => true; edge.bot.entity.position = new Vec3(1.2, 40, .5)
  edge.bot.entity.velocity = new Vec3(0, -.0784000015258789, 0)
  assert.ok(planWaterEntry(edge.bot, new Vec3(2.5, 0, .5)), 'the same controller can plan an ordinary step off an observed high edge')
})

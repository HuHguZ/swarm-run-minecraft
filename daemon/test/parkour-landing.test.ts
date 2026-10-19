// Паркур: посадка — сено и урон падения, контролируемый спуск, вода, паутина, лозы, порошковый снег, сход с края.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { repoJson } from '../src/paths'
import { registry, Block, native, worldOf, drive } from './parkour-fixture'

test('author checkpoint receipt parses the native 1.21.11 respawn position without treating chat absence as activation failure', () => {
  const { authorRespawn }: typeof import('../scenes/move/try-parkour-map') = require('../scenes/move/try-parkour-map')
  assert.deepEqual(authorRespawn('NeuroFarm29 has the following entity data: {pos: [I; -21, 90, -35], forced: 1b, dimension: "minecraft:overworld"}'), { x: -21, y: 90, z: -35 })
  assert.deepEqual(authorRespawn('{pos:[I;-22,99,-38]}'), { x: -22, y: 99, z: -38 })
  assert.equal(authorRespawn('No entity was found'), undefined)
})
test('hay landing damage uses the collided support and native fallOn multiplier without accepting a harmful dry drop', async () => {
  const { landingDamage }: typeof import('../src/navigation/landing') = require('../src/navigation/landing')
  const { supportAt }: typeof import('../src/navigation/geometry') = require('../src/navigation/geometry')
  const { planJumpAsync, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
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
  const { planJumpAsync }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
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
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  const { planJumpAsync }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
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
    ;(plan.states.at(-1) as any).apply(bot)
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
  const { planJumpAsync, executePlan, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const fallType = (require('../src/gamedata') as typeof import('../src/gamedata')).DAMAGE_TYPES.indexOf('fall')
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
test('native parkour crosses a gap, lands on a narrow support and keeps a safe resting body', () => {
  const { planJump, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
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
  const { planJump, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [0, 0, -1, 'stone'], [1, 1, 0, 'stone'], [1, 2, 0, 'stone'],
    [2, 0, 0, 'oak_fence', { north: false, south: false, east: false, west: false, waterlogged: false }]])
  // Grounded clients retain native downward gravity, including the physical
  // fixture's state. A zero-velocity construction hid run-up search failures.
  const idle = new native.PlayerState(bot, (require('../src/navigation/parkour') as typeof import('../src/navigation/parkour')).IDLE)
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
  const { planJump }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const blocked = worldOf([[0, 0, 0, 'stone'], [2, 0, 0, 'stone'], [2, 2, 0, 'stone']])
  assert.equal(planJump(blocked.bot, new Vec3(2.5, 1, .5)), null)
  const web = worldOf([[0, 0, 0, 'stone'], [1, 1, 0, 'cobweb'], [2, 0, 0, 'stone']])
  const plan = planJump(web.bot, new Vec3(2.5, 1, .5))
  if (plan) assert.ok(plan.states.every((state: { isInWeb: boolean }) => !state.isInWeb), 'a detour may pass; crossing the web may not')
})
test('a genuine upward tip may support standing but refuses a damaging fall onto it', () => {
  const { planJump }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bodyClear, supportAt }: typeof import('../src/navigation/geometry') = require('../src/navigation/geometry')
  const { bot } = worldOf([[0, 0, 0, 'stone'], [2, -1, 0, 'stone'],
    [2, 0, 0, 'pointed_dripstone', { vertical_direction: 'up', thickness: 'tip', waterlogged: false }]])
  const target = new Vec3(2.375, .6875, .375)
  assert.ok(bodyClear(bot, target))
  assert.equal(supportAt(bot, target, .04)?.top, .6875)
  assert.ok(!planJump(bot, target, { beam: 24 }), 'native collision alone omits the server stalagmite fall damage')
})
test('shared scoped physics climbs ordinary, Nether and cave vines from the vanilla 1.21.11 tag', () => {
  const tag = repoJson('daemon/data/climbable-1.21.11.json').climbable.values as string[]
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
  const { planWebCatch, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
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
test('one-cell water entry uses free body volume beside real waterlogged crystal shapes', () => {
  const { waterEntries }: typeof import('../src/navigation/geometry') = require('../src/navigation/geometry')
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
test('native fall controller reaches observed one-cell water and refuses unreachable water', () => {
  const { planWaterEntry, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
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
test('native physics slows a body only while its feet cell is powder snow (PowderSnowBlock.entityInside 1.21.11)', () => {
  const { simulatePlan, IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const floor: Array<[number, number, number, string]> = Array.from({ length: 12 }, (_, x) => [x, 0, 0, 'stone'] as [number, number, number, string])
  const run = (cells: Array<[number, number, number, string]>) => {
    const { bot } = worldOf([...floor, ...cells]); bot.entity.velocity.y = -.0784000015258789
    const steps = Array.from({ length: 30 }, () => ({ yaw: -Math.PI / 2, control: { ...IDLE, forward: true, sprint: true } }))
    return simulatePlan(bot, steps).pos.x
  }
  const clear = run([])
  const feet = run([2, 3, 4, 5, 6].map(x => [x, 1, 0, 'powder_snow'] as [number, number, number, string]))
  const head = run([2, 3, 4, 5, 6].map(x => [x, 2, 0, 'powder_snow'] as [number, number, number, string]))
  assert.ok(feet < clear - 1.5, `feet in powder snow must be stuck-slowed: ${feet} vs ${clear}`)
  assert.equal(head, clear, 'powder snow at head height only does not slow a living entity')
})
test('a short powder snow crossing is planned without crawling sneak inside the snow (s6-pk-powder6 shape)', () => {
  const { planJump }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const cells: Array<[number, number, number, string]> = [0, 1, 2, 3, 4, 5].map(x => [x, 0, 0, 'stone'] as [number, number, number, string])
  for (const x of [2, 3, 4]) cells.push([x, 1, 0, 'powder_snow'])
  const { bot } = worldOf(cells); bot.entity.velocity.y = -.0784000015258789
  const plan = planJump(bot, new Vec3(5.5, 1, .5), { allowWalk: true, maxTicks: 38, beam: 60 })
  assert.ok(plan && plan.ticks <= 45, `crossing must stay short: ${plan?.ticks}`)
  const snowSneak = plan.steps.some((step: any, i: number) => step.control.sneak && bot.blockAt(plan.states[i].pos.floored()).name === 'powder_snow')
  assert.equal(snowSneak, false)
})
test('a fall is steered onto a nearby hay bale when it hurts less than the floor straight below', () => {
  const { planNearbySoftLanding, simulatePlan }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { landingDamage }: typeof import('../src/navigation/landing') = require('../src/navigation/landing')
  const cells: Array<[number, number, number, string]> = []
  for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) if (x !== 2 || z !== 0) cells.push([x, 0, z, 'stone'])
  cells.push([2, 0, 0, 'hay_block'])
  const { bot } = worldOf(cells)
  bot.entity.position = new Vec3(.5, 30, .5); bot.entity.velocity = new Vec3(0, -.3, 0); bot.entity.onGround = false
  const plan = planNearbySoftLanding(bot, 34)
  assert.ok(plan, 'the hay bale two blocks aside must be reachable in the air')
  assert.equal(plan.damage, landingDamage(bot.blockAt(new Vec3(2, 0, 0)), 33))
  assert.ok(plan.damage < landingDamage(bot.blockAt(new Vec3(0, 0, 0)), 33))
  const landed = simulatePlan(bot, plan.steps, undefined, plan.states[0] && Object.assign(Object.create(Object.getPrototypeOf(plan.states[0])), plan.states[0], { pos: bot.entity.position.clone(), vel: bot.entity.velocity.clone() }))
  assert.ok(landed.onGround && Math.abs(landed.pos.x - 2.5) < .3 && landed.pos.y === 1)
  bot.entity.position = new Vec3(2.5, 30, .5)
  assert.equal(planNearbySoftLanding(bot, 34), null, 'already above the softest floor: nothing to steer')
})
test('an explicit plain-floor fall budget (2..4) takes a 6-block walk-off onto stone; 1 HP still needs a mitigating floor (CP28 shape)', async () => {
  const { planJumpAsync }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { supportRoute }: typeof import('../src/navigation/support-route') = require('../src/navigation/support-route')
  // Cliff top 6 (feet 7) and an island one block lower than 1 HP allows: floor 0 (feet 1), 2.5 blocks out.
  const { bot } = worldOf([[0, 6, 0, 'stone'], [3, 0, 0, 'end_stone'], [4, 0, 0, 'end_stone']])
  bot.entity.position = new Vec3(.5, 7, .5); bot.entity.velocity.y = -.0784000015258789
  const target = new Vec3(3.5, 1, .5); const options = { allowWalk: true, maxTicks: 38, planningMs: 180 }
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, { ...options, maxFallDamage: 1 }), null, 'no mitigator: 1 HP budget refuses a 3 HP landing')
  const plan = await planJumpAsync(bot, { aborted: false }, target, { ...options, maxFallDamage: 3 })
  assert.ok(plan, 'an explicit 3 HP budget accepts the plain-floor drop')
  assert.equal(plan.fall.damage, 3); assert.equal(plan.fall.supportName, 'end_stone')
  assert.equal(await planJumpAsync(bot, { aborted: false }, target, { ...options, maxFallDamage: 2 }), null, 'the budget is a cap')
  assert.ok((await supportRoute(bot, bot.entity.position, target, new Set(), 6, undefined, undefined, undefined, 3)).some((o: any) => o.target.equals(target)), 'the graph offers the drop edge under the budget')
  assert.ok(!(await supportRoute(bot, bot.entity.position, target, new Set(), 6, undefined, undefined, undefined, 1)).some((o: any) => o.target.equals(target)))
})
test('lab drop walks off the ledge with ordinary keys, releases them in the air and reports the landing', async () => {
  const { navigate }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  const { bot, world } = worldOf([[0, 4, 0, 'stone'], [1, 0, 0, 'stone'], [2, 0, 0, 'stone'], [3, 0, 0, 'stone']])
  bot.entity.position = new Vec3(.7, 5, .5); bot.entity.velocity.y = -.0784000015258789
  drive(bot, world)
  let forward = false
  const set = bot.setControlState; bot.setControlState = (key: string, value: boolean) => { if (key === 'forward') forward = value; set(key, value) }
  bot.getControlState = (key: string) => key === 'forward' ? forward : false
  const result: any = await navigate(bot, { aborted: false }, { mode: 'drop', target: new Vec3(3.5, 5, .5), ticks: 80 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.at.y, 1); assert.ok(result.fall >= 3.9 && result.fall <= 4.1, String(result.fall))
  assert.equal(forward, false, 'keys are released once airborne')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import * as spear from '../src/spear'
import { reachFrom, yawTo } from '../src/pvp/body'
import { seesPlayer } from '../src/pvp/last-seen'
import { spearTurn } from '../src/pvp/turn-approach'
import { native, worldOf, drive } from './parkour-fixture'

function scene(t, layout: 'wall' | 'corner' | 'void', speed = 0) {
  const cells: Array<[number, number, number, string]> = []
  for (let x = 0; x <= 6; x++) for (let z = -8; z <= 1; z++) {
    if (layout !== 'void' || x === 0) cells.push([x, 63, z, 'stone'])
    if (z === 1 || layout === 'corner' && x === 1) for (let y = 64; y < 67; y++) cells.push([x, y, z, 'stone'])
  }
  const { bot, world } = worldOf(cells)
  drive(bot, world)
  const pole = { name: 'iron_spear' }, sword = { name: 'wooden_sword' }
  bot.heldItem = pole; bot.inventory.items = () => [pole, sword]
  bot.entity.position = new Vec3(.5, 64, .69); bot.entity.velocity = new Vec3(0, -.0784, 0)
  const enemy = { id: 2, type: 'player', username: 'Knight', isValid: true, height: 1.8, width: .6,
    position: new Vec3(.5, 64, -2.65), metadata: [], equipment: [{ name: 'netherite_sword' }, null, null, { name: 'netherite_chestplate' }] }
  bot.entities = { 2: enemy }; bot.players = { Knight: { entity: enemy } }
  let now = 10000, steps = 0, forecasts = 0
  const packets: Array<[string, number]> = []
  bot._client = { write: (kind, data) => packets.push([kind, data.status]) }; bot.swingArm = () => {}
  bot._ndSimOrig = (st, blocks) => { forecasts++; return bot.physics.simulatePlayer(st, blocks) }
  t.mock.method(clock, 'now', () => now)
  spear.install(bot).lastJab = now - 410 // iron spear has 12 ticks of its cooldown left
  const ctx: any = { bot, entity: enemy, prof: { player: true }, st: {}, AR: { x: 0, z: 0, r: 15, killY: 61 },
    vision: { visible: entity => seesPlayer(bot, entity) },
    track: { vel: () => new Vec3(0, 0, speed) }, lastSwing: 0, targetHurtAt: 0, ready: () => false, rest() {},
    used() {}, routeInputs: () => '', maceNow: () => false, holdWeapon: async () => { bot.heldItem = sword },
    set: bot.setControlState, clear: bot.clearControlStates, strafeStep() { ctx.strafeKey = 'left' }, sleep: async () => {
      const st = new native.PlayerState(bot, bot.controlState); bot.physics.simulatePlayer(st, world); st.apply(bot)
      enemy.position = enemy.position.offset(0, 0, speed); now += 50; steps++
    } }
  const reach = () => reachFrom(bot.entity.position.offset(0, 1.62, 0), enemy)
  const turn = async () => {
    bot.entity.yaw = yawTo(bot.entity.position, enemy.position)
    await spearTurn(ctx, { d: enemy.position.distanceTo(bot.entity.position), me: bot.entity.position, now,
      r: reach(), seesBody: seesPlayer(bot, enemy) } as any)
  }
  return { bot, enemy, reach, turn, packets, setSpeed(value) { speed = value },
    get steps() { return steps }, get forecasts() { return forecasts } }
}

test('a spear user slides along the wall onto the sole supported side and regains reach against a swordsman', async t => {
  const f = scene(t, 'wall')
  const before = f.reach()
  for (let i = 0; i < 12 && f.reach() < 3.4; i++) {
    await f.turn()
    assert.equal(f.bot.heldItem.name, 'iron_spear', 'the open flank keeps the longer weapon useful')
    assert.equal(f.bot.entity.position.y, 64)
  }
  assert.ok(before < 3.4 && f.reach() >= 3.4, JSON.stringify({ before, end: f.bot.entity.position, reach: f.reach(), steps: f.steps }))
  assert.ok(f.bot.entity.position.x > 1 && spear.jabReach(f.bot, f.enemy).ok)
  t.diagnostic(`native ticks ${f.steps}, eye-to-hitbox ${before.toFixed(2)} → ${f.reach().toFixed(2)}, forecast ticks ${f.forecasts}`)
  const jab = f.turn()
  f.bot.emit('physicsTick'); await jab
  assert.deepEqual(f.packets, [['block_dig', 7]], 'the normal spear turn sends the charged STAB')
})

test('a swordsman closing the side lane interrupts the ongoing escape before the melee swap', async t => {
  const f = scene(t, 'wall')
  await f.turn()
  assert.equal(f.bot.getControlState('right'), true)
  f.setSpeed(.27)
  await f.turn()
  assert.equal(f.bot.heldItem.name, 'wooden_sword')
  assert.equal(f.steps, 1)
  assert.ok(!f.bot.getControlState('right') && !f.bot.getControlState('back'))
})

for (const layout of ['corner', 'void', 'rushing', 'hidden'] as const) test(`${layout} keeps the close-range fallback`, async t => {
  const f = scene(t, layout === 'rushing' || layout === 'hidden' ? 'wall' : layout, layout === 'rushing' ? .27 : 0)
  if (layout === 'hidden') { f.enemy.metadata[0] = 0x20; f.enemy.equipment.length = 0 }
  f.bot.setControlState('back', true)
  await f.turn()
  assert.equal(f.bot.heldItem.name, 'wooden_sword')
  assert.equal(f.steps, 0)
  assert.equal(f.bot.getControlState('back'), false, 'withdrawing the plan releases the old movement key')
  if (layout === 'hidden') assert.equal(f.forecasts, 0, 'no forecast of a hidden opponent')
})

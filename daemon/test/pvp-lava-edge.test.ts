import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as flee from '../src/flee'
import { stepSafe } from '../src/pvp/body'
import { combatMovement } from '../src/pvp/movement'
import { burningFeet, escapeBurn, hotSupport, lavaExit } from '../src/pvp/lava-exit'
import { native, worldOf } from './parkour-fixture'

// Поле: пол камень на y −1, ноги на 0; яма лавы на уровне пола (как на Колизее: лава на −1, края — магма).
function field (lava: [number, number][] = []) {
  const isLava = (p: Vec3) => p.y === -1 && lava.some(([x, z]) => x === p.x && z === p.z)
  return {
    entity: { position: new Vec3(.5, 0, .75), yaw: 0, metadata: [0], isInWater: false },
    physics: { playerHalfWidth: Math.fround(.6) / 2, playerHeight: 1.8 },
    blockAt (point: Vec3) {
      const position = point.floored()
      if (isLava(position)) return { position, name: 'lava', boundingBox: 'empty' }
      const solid = position.y < 0
      return { position, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty' }
    }
  }
}
const EAST = { x: 1, y: 0, z: 0 }

function hotEdge() {
  const data = require('minecraft-data')('1.21.11'), Block = require('prismarine-block')('1.21.11')
  const cells = new Map<string, string>(), keys = {}, packets = []
  const death = new Vec3(592.9177, 120, 612.8569)
  for (const [x, z] of [[593, 612], [592, 613], [593, 613]]) cells.set(`${x},119,${z}`, 'magma_block')
  cells.set('592,119,612', 'lava')
  const bot: any = { entity: { position: death, onGround: true, isInLava: false }, health: 19,
    blockAt(point) {
      const pos = point.floored(), name = cells.get([pos.x, pos.y, pos.z].join(',')) ?? (pos.y === 119 ? 'sand' : 'air')
      const block = Block.fromStateId(data.blocksByName[name].defaultState, 0); block.position = pos; return block
    }, lookAt: async () => {}, setControlState: (key, value) => { keys[key] = value }, getControlState: key => !!keys[key],
    supportFeature: () => true, _client: { write: (name, data) => packets.push({ name, data }) } }
  return { bot, death, cells, keys, packets }
}

test('31y hot floor edge: stand across a lava cell on the magma rim and walk crouched until the footprint clears', async () => {
  const cells: Array<[number, number, number, string]> = []
  for (let x = 586; x <= 599; x++) for (let z = 606; z <= 620; z++) {
    const radius = Math.max(Math.abs(x - 591), Math.abs(z - 611))
    cells.push([x, 119, z, radius <= 1 ? 'lava' : radius === 2 ? 'magma_block' : 'sand'])
  }
  const { bot, world } = worldOf(cells), keys = {}
  bot.entity.position = new Vec3(592.9177, 120, 612.8569)
  bot.entity.velocity = new Vec3(0, -.0784, 0); bot.entity.yaw = 1.8334
  bot.setControlState = (k, value) => { keys[k] = value }
  bot.getControlState = k => !!keys[k]
  bot.lookAt = async target => { const d = target.minus(bot.entity.position); bot.entity.yaw = Math.atan2(-d.x, -d.z) }
  assert.equal(bot.blockAt(bot.entity.position.offset(0, -.1, 0)).name, 'lava')
  let time = 0
  const result = await escapeBurn(bot, { now: () => time, sleep: async ms => {
    assert.equal(bot.getControlState('forward'), true)
    assert.equal(bot.getControlState('sneak'), true)
    assert.equal(bot.getControlState('jump'), false, 'flat rim needs no jump')
    assert.equal(bot.getControlState('sprint'), false)
    const state = new native.PlayerState(bot, keys)
    bot.physics.simulatePlayer(state, world); state.apply(bot)
    assert.equal(bot.entity.onGround, true, 'walk along the rim without dropping into the pit')
    assert.equal(bot.entity.isInLava, false)
    time += ms
  } })
  assert.equal(result.ok, true)
  assert.ok(time >= 100 && time < 2500, 'several real steering ticks to a dry stance')
  assert.equal(bot.getControlState('sneak'), false)
  assert.equal(burningFeet(bot), false)
})

test('31y rim input uses actual collision tops and preserves the protective Shift on timeout', async t => {
  const { bot, death, cells, packets } = hotEdge()
  const saved = process.env.ND_MAGMA_ESCAPE
  process.env.ND_MAGMA_ESCAPE = '1'
  t.after(() => { if (saved === undefined) delete process.env.ND_MAGMA_ESCAPE; else process.env.ND_MAGMA_ESCAPE = saved })
  const locks = require('../src/reflex-lock'), session = { bot }
  assert.equal(locks.keepMagmaSneak(session), true)
  assert.equal(packets.at(-1).data.inputs.shift, true)
  let time = 0
  const r = await escapeBurn(bot, { limitMs: 100, now: () => time, sleep: async ms => { time += ms } })
  assert.equal(r.ok, false)
  assert.equal(bot.getControlState('sneak'), true)
  bot.entity.position = new Vec3(592.69, 120, 612.69)
  assert.equal(burningFeet(bot), false, 'outside both magma cells')
  assert.equal(locks.keepMagmaSneak(session), false)
  cells.set('592,120,612', 'stone_slab')
  bot.entity.position = death.offset(0, .5, 0)
  assert.equal(burningFeet(bot), false, 'standing half a block above the rim')
  assert.equal(locks.keepMagmaSneak(session), false)
  bot.entity.position = new Vec3(593.5, 120.42, 612.5); bot.entity.onGround = false
  assert.equal(burningFeet(bot), true, 'the first jump tick above magma is not a dry landing')
  assert.equal(locks.keepMagmaSneak(session), false, 'airborne has no physical foot support')
  bot.entity.onGround = true
  cells.delete('592,120,612')
  for (const hazard of ['lava', 'fire', 'soul_fire']) {
    cells.set('592,120,612', hazard); bot.entity.position = death; time = 0
    assert.equal(burningFeet(bot), true)
    assert.equal(locks.keepMagmaSneak(session), false, 'liquid or flame touching the body takes priority over the magma under it')
    await escapeBurn(bot, { now: () => time, sleep: async ms => {
      assert.equal(bot.getControlState('sneak'), false, hazard)
      assert.equal(bot.getControlState('jump'), true)
      bot.entity.position = new Vec3(591.5, 120, 612.5); time += ms
    } })
  }
})

test('at a mixed rim only the lit block whose actual top supports the feet determines the escape gait', () => {
  const { bot, cells } = hotEdge()
  cells.set('592,119,612', 'campfire')
  cells.set('593,119,613', 'soul_campfire')
  assert.equal(hotSupport(bot), 'magma_block', 'standing on the full-height part of the rim')
  bot.entity.position = new Vec3(592.5, 119 + 7 / 16, 612.5)
  assert.equal(hotSupport(bot), 'campfire', 'the lower collision top matches a lit campfire')
  const blockAt = bot.blockAt
  bot.blockAt = (p, extra) => {
    const b = blockAt(p, extra)
    if (b.name.endsWith('campfire')) b.getProperties = () => ({ lit: false })
    return b
  }
  assert.equal(hotSupport(bot), null, 'unlit campfires at foot height and higher magma cause no hot-floor alarm')
})

test('шаг в бою: край рамки над лавой ямы — не шаг, хотя центр шага на камне', () => {
  assert.equal(stepSafe(field(), EAST), true)
  // Центр шага (1.4, 0.75) — клетка (1, 0) на камне; край рамки z 1.05 — клетка (1, 1), под ней лава.
  assert.equal(stepSafe(field([[1, 1]]), EAST), false)
})

test('бег: пробег кончается до лавы под краем рамки (не только под центром)', () => {
  const free = flee.runLength(field() as any, EAST, 6)
  assert.equal(free.len, 6)
  const r = flee.runLength(field([[3, 1]]) as any, EAST, 6)
  assert.ok(r.len < 3, JSON.stringify(r))
})

test('путь в бою: клетка у лавы дорогая, у сухой — бесплатная', () => {
  const bot: any = field([[3, 1]])
  bot.pathfinder = { movements: { exclusionAreasStep: [], exclusionAreasBreak: [] } }
  const mv = combatMovement(bot)
  const step = bot.pathfinder.movements.exclusionAreasStep[0]
  assert.ok(step({ position: new Vec3(2, 0, 0) }) > 0, 'по диагонали от лавы')
  assert.equal(step({ position: new Vec3(0, 0, 0) }), 0)
  assert.equal(step({ position: new Vec3(3, 0, 1) }), 100, 'над лавой — нельзя')
  mv.restore()
  assert.equal(bot.pathfinder.movements.exclusionAreasStep.length, 0)
})

// Яма Колизея: лава 3×3 вровень с полом (y −1), кольцо магмы, дальше песок; бот в середине ямы ногами на y −1.
function pit () {
  return {
    entity: { position: new Vec3(.5, -1, .5) },
    blockAt (point: Vec3) {
      const p = point.floored()
      const r = Math.max(Math.abs(p.x), Math.abs(p.z))
      let name = 'air'
      if (p.y < -1) name = 'sandstone'
      else if (p.y === -1) name = r <= 1 ? 'lava' : r === 2 ? 'magma_block' : 'sand'
      return { position: p, name, boundingBox: name === 'air' || name === 'lava' ? 'empty' : 'block' }
    }
  }
}

test('выход из лавы: из середины ямы вровень с полом — на поле на блок выше, не на магму (прежний выход видел только свой уровень)', () => {
  const bot = pit()
  const e = lavaExit(bot, bot.entity.position)
  assert.ok(e, 'выход есть')
  assert.equal(e.up, true)
  assert.equal(e.cell.y, 0)
  // Цель — поле за кольцом магмы (с магмы у ямы следующий удар — снова в лаву), в 3 бл.
  assert.equal(e.hot, false, JSON.stringify(e))
  assert.ok(e.d <= 3.2, JSON.stringify(e))
  // Враг на востоке — выход не к нему.
  const w = lavaExit(bot, bot.entity.position, { x: 6, z: .5 })
  assert.ok(w.cell.x <= 0, JSON.stringify(w))
})

test('выход из лавы: escapeBurn ведёт к полю, пока под ногами горит, и отпускает клавиши', async () => {
  const bot: any = pit()
  let target = null
  const keys: Record<string, boolean> = {}
  bot.health = 20
  bot.lookAt = async (p) => { target = p }
  bot.setControlState = (k, v) => { keys[k] = v }
  // Простая «физика»: вперёд — 0.25 бл. за шаг к цели; на блок выше — как только край рядом.
  const sleep = async () => {
    if (!keys.forward || !target) return
    const p = bot.entity.position
    const dx = target.x - p.x; const dz = target.z - p.z; const n = Math.hypot(dx, dz) || 1
    const step = Math.min(0.25, n)
    const q = new Vec3(p.x + dx / n * step, p.y, p.z + dz / n * step)
    if (bot.blockAt(q.floored()).boundingBox === 'block') q.y += 1
    bot.entity.position = q
  }
  let t = 0
  assert.equal(burningFeet(bot), true)
  const r = await escapeBurn(bot, { limitMs: 5000, sleep, now: () => (t += 50) })
  assert.equal(r.ok, true, JSON.stringify({ r, p: bot.entity.position }))
  assert.equal(burningFeet(bot), false)
  assert.equal(keys.forward, false)
})

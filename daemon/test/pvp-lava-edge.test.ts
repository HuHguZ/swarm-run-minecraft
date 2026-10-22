import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as flee from '../src/flee'
import { stepSafe } from '../src/pvp/body'
import { combatMovement } from '../src/pvp/movement'
import { burningFeet, escapeBurn, lavaExit } from '../src/pvp/lava-exit'

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

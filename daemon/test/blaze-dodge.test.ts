import test = require('node:test')
import assert = require('node:assert/strict')
import { planDodge, clearance, keysFor } from '../src/blaze/dodge'

const ok = () => true

test('шар в лоб с 8 бл. — уход поперёк линии, стоя — попадание', () => {
  const body = { x: 0.5, y: 64, z: 0.5, vx: 0, vz: 0 }
  const ball = { p0: { x: 8.5, y: 65, z: 0.5 }, dir: { x: -1, y: 0, z: 0 }, age: 2 }
  assert.ok(clearance(body, [ball], 0, 0) < 0)
  const p = planDodge(body, [ball], ok)
  assert.ok(p && Math.abs(p.uz) > 0.5, JSON.stringify(p))
  assert.ok(p.clear > 0)
})

test('шар мимо на 3 бл. — стоять', () => {
  const body = { x: 0.5, y: 64, z: 0.5, vx: 0, vz: 0 }
  assert.equal(planDodge(body, [{ p0: { x: 8.5, y: 65, z: 3.5 }, dir: { x: -1, y: 0, z: 0 }, age: 0 }], ok), null)
})

test('одна сторона закрыта (лава) — уход в другую', () => {
  const body = { x: 0.5, y: 64, z: 0.5, vx: 0, vz: 0 }
  const ball = { p0: { x: 8.5, y: 65, z: 0.5 }, dir: { x: -1, y: 0, z: 0 }, age: 2 }
  const p = planDodge(body, [ball], (ux, uz) => uz <= 0)
  assert.ok(p && p.uz < 0, JSON.stringify(p))
})

test('клавиши относительно взгляда: смотрит на +x — вперёд к +x, вбок к +z', () => {
  // prismarine-physics: Y = π − yaw, вперёд (−sinY, cosY); yaw = −π/2 → вперёд (+1, 0)
  assert.deepEqual(keysFor(-Math.PI / 2, 1, 0), { forward: true, back: false, right: false, left: false })
  const side = keysFor(-Math.PI / 2, 0, 1)
  assert.equal(side.forward || side.back, false)
  assert.equal(side.left !== side.right, true)
})

// Очередь из трёх шаров (60/66/72 т), каждый метит в тело в миг выстрела (без упреждения и разброса — худший случай). Тело с
// рефлексом (решение каждый тик, клавиши — со следующего тика) — ни одного попадания; стоя — все три.
function volley (reflex: boolean) {
  let x = 0.5, z = 0.5, vx = 0, vz = 0, ux = 0, uz = 0
  const y = 64, from = { x: 8.5, y: 65.5, z: 0.5 }
  const balls: any[] = []
  let hits = 0
  for (let t = 0; t < 60; t++) {
    if (t === 0 || t === 6 || t === 12) {
      const d = { x: x - from.x, y: y + 0.9 - from.y, z: z - from.z }, n = Math.hypot(d.x, d.y, d.z)
      balls.push({ p0: from, dir: { x: d.x / n, y: d.y / n, z: d.z / n }, t0: t, hit: false })
    }
    // ход тела по клавишам прошлого тика
    vx = vx * 0.546 + 0.098 * ux; vz = vz * 0.546 + 0.098 * uz; x += vx; z += vz
    for (const b of balls) {
      if (b.hit) continue
      const age = t - b.t0
      let s = 0, v = 0.1; for (let k = 0; k < age; k++) { v = (v + 0.1) * 0.95; s += v }
      const s1 = s + (v + 0.1) * 0.95
      const m = Math.max(0, Math.min(0.3, (age - 2) / 20)) // ProjectileUtil.computeMargin
      // Сервер проверяет весь отрезок хода шара за тик (getHitResultOnMoveVector) — по 16 точкам.
      for (let j = 0; j < 16 && !b.hit; j++) {
        const sj = s + (s1 - s) * j / 16
        const bx = b.p0.x + b.dir.x * sj, by = b.p0.y + b.dir.y * sj, bz = b.p0.z + b.dir.z * sj
        if (Math.abs(bx - x) < 0.3 + m && Math.abs(bz - z) < 0.3 + m && by > y - m && by < y + 1.8 + m) { b.hit = true; hits++ }
      }
    }
    if (reflex) {
      const live = balls.filter(b => !b.hit).map(b => ({ p0: b.p0, dir: b.dir, age: t - b.t0 }))
      const p = planDodge({ x, y, z, vx, vz }, live, ok)
      ux = p ? p.ux : 0; uz = p ? p.uz : 0
    }
  }
  return hits
}

test('очередь из трёх шаров с 8 бл.: стоя 3 попадания, с рефлексом 0', () => {
  assert.equal(volley(false), 3)
  assert.equal(volley(true), 0)
})

test('рефлекс: ифрит вплотную (1.5 бл. к +x), шаров нет — шаг прочь (к −x), отпустил — клавиши сняты', () => {
  const { EventEmitter } = require('node:events')
  const { Vec3 } = require('vec3')
  const { attachReflex } = require('../src/blaze/dodge')
  const bot: any = new EventEmitter()
  const keys: Record<string, boolean> = {}
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: -Math.PI / 2, onGround: true } // взгляд на +x
  bot.setControlState = (k, v) => { keys[k] = v }
  let near = [new Vec3(2, 64, 0.5)]
  const rx = attachReflex(bot, { flying: () => [] }, () => true, { near: () => near })
  bot.emit('physicsTick')
  assert.equal(rx.active(), true)
  assert.equal(keys.back, true) // взгляд на +x, ход к −x — назад
  near = []
  bot.emit('physicsTick')
  assert.equal(rx.active(), false)
  assert.equal(keys.back, false)
  rx.stop()
})

test('взгляд по ходу (REFLEX_SPRINT): yaw = π − atan2(−ux, uz) — ход только «вперёд»', () => {
  for (const [ux, uz] of [[1, 0], [0, 1], [-0.7071, 0.7071], [0, -1]]) {
    assert.deepEqual(keysFor(Math.PI - Math.atan2(-ux, uz), ux, uz), { forward: true, back: false, right: false, left: false })
  }
})

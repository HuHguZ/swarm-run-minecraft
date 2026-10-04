'use strict'
// «Один цикл» (2026-09-30): физика дракона по байткоду 1.21.11 — прогноз посадки по
// пакетам, отставание головы сидящего (yRotA), станция в окопе для кровати на снижении.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const dragon = require('../src/dragon')

// Плоский мир фермы: земля — ноги на 61, фонтан (столб 0,60..63,0) — верх 64.
function world (extra = new Map()) {
  return p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const k = `${x},${y},${z}`
    if (extra.has(k)) {
      const name = extra.get(k)
      if (name === 'air') return { name, boundingBox: 'empty', position: new Vec3(x, y, z), shapes: [] }
      return { name, boundingBox: 'block', position: new Vec3(x, y, z), shapes: /_bed$/.test(name) ? [[0, 0, 0, 1, 0.5625, 1]] : [[0, 0, 0, 1, 1, 1]] }
    }
    let s = y <= 60 && y >= 40
    if (x === 0 && z === 0 && y >= 60 && y <= 63) s = true
    return { name: s ? 'end_stone' : 'air', boundingBox: s ? 'block' : 'empty', position: new Vec3(x, y, z), shapes: s ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
}
function fakeBot (me = new Vec3(15.5, 61, 0.5)) {
  const blockAt = world()
  return { entity: { position: me, yaw: 0, pitch: 0, height: 1.8, onGround: true }, blockAt, entities: {}, inventory: { items: () => [] } }
}

// Посадка, прожитая той же физикой: пакеты раз в 3 тика, yaw — байтом (как у клиента).
function landing (s0, P = 64) {
  const T = { x: 0.5, y: P, z: 0.5 }
  const s = { ...s0, hist: [] }
  const ticks = []
  for (let k = 0; k < 600; k++) {
    const dx = s.x - T.x; const dy = s.y - T.y; const dz = s.z - T.z
    if (dx * dx + dy * dy + dz * dz < 1) return { ticks, sitAt: k, sit: { ...s } }
    dragon.simStep(s, T, 1.5, dragon.turnLanding)
    ticks.push({ ...s, hist: s.hist.slice() })
  }
  return null
}
const q8 = r => Math.round(r * 256 / 360) * 360 / 256
const pkt = (st, k) => ({ t: k * 50, id: 1, x: st.x, y: st.y, z: st.z, vx: st.vx, vy: st.vy, vz: st.vz, yRot: dragon.yRotOf(Math.PI - q8(st.yRot) * Math.PI / 180), ph: dragon.PHASE.LANDING })

test('посадка: где и в какой тик сядет — по двум пакетам за 1–2 с', () => {
  for (const s0 of [
    { x: 30, y: 80, z: -25, vx: -0.6, vy: -0.1, vz: 0.4, yRot: 60, yRotA: 10 },
    { x: -35, y: 76, z: 10, vx: 0.7, vy: -0.05, vz: -0.1, yRot: -100, yRotA: -20 },
    { x: 5, y: 90, z: 40, vx: 0.1, vy: -0.2, vz: -0.8, yRot: 170, yRotA: 0 }
  ]) {
    const L = landing(s0)
    assert.ok(L, 'сел')
    for (const ahead of [20, 40]) {
      const kb = L.sitAt - ahead
      if (kb < 4) continue
      const a = L.ticks[kb - 4]; const b = L.ticks[kb - 1]
      const fc = dragon.landingForecast({ list: [pkt(a, kb - 3), pkt(b, kb)] }, 64)
      assert.ok(fc, 'есть прогноз')
      assert.ok(Math.abs(kb + fc.n - 1 - L.sitAt) <= 1, `тик посадки ${kb + fc.n - 1} ≈ ${L.sitAt}`)
      const e = Math.hypot(fc.sit.x - L.sit.x, fc.sit.z - L.sit.z)
      assert.ok(e < 0.4, `место посадки ошибка ${e.toFixed(2)}`)
    }
  }
})

test('сидя голова отстаёт от yaw на замороженный yRotA·0.01 рад', () => {
  const s = { x: 0.5, y: 64, z: 0.5, vx: 0, vy: 0, vz: 0, yRot: 90, yRotA: 40, hist: new Array(11).fill(64) }
  const h = dragon.simHead(s, true)
  // по yaw голова была бы в (7, 63, 0.5); отставание 0.4 рад — в сторону уменьшения yRot
  const a = 90 * Math.PI / 180 - 0.4
  assert.ok(Math.abs(h.x - (0.5 + Math.sin(a) * 6.5)) < 0.01)
  assert.ok(Math.abs(h.z - (0.5 - Math.cos(a) * 6.5)) < 0.01)
  assert.equal(Math.round(h.y * 10) / 10, 63)
})

test('станция в окопе: взрыв не видит окоп, бок кровати из окопа виден', () => {
  const bot = fakeBot()
  // голова на снижении: в 6.5 к +x от центра, низ на 63.9 (земля — ноги 61)
  const target = new Vec3(7.2, 63.9, 0.6)
  const plan = dragon.tsPlan(bot, target, { lift: 2 }) || dragon.tsPlan(bot, target, { lift: 1 })
  assert.ok(plan, `план есть: ${JSON.stringify(dragon.tsPlan.why)}`)
  assert.ok(plan.expo <= 0.02, `взрыв видит ${plan.expo}`)
  assert.equal(plan.trench.y, 60)
  assert.ok(plan.dist < 1.6, `центр взрыва от головы ${plan.dist}`)
  assert.ok(plan.expect >= 55)
  // изголовье — изножье + a; окоп — изножье − 2u; заслон — изголовье − u
  assert.deepEqual({ x: plan.F.x + plan.a.x, z: plan.F.z + plan.a.z }, plan.H)
  assert.deepEqual({ x: plan.H.x - plan.u.x, z: plan.H.z - plan.u.z }, plan.W)
})

test('на пути снижения: крылья снижающегося бьют стоящего рядом на земле, окоп — нет', () => {
  const s0 = { x: 20, y: 72, z: 0.5, vx: -0.6, vy: -0.08, vz: 0, yRot: 90, yRotA: 0 }
  const L = landing(s0)
  const kb = L.sitAt - 30
  const a = L.ticks[kb - 4]; const b = L.ticks[kb - 1]
  const fc = dragon.landingForecast({ list: [pkt(a, kb - 3), pkt(b, kb)] }, 64)
  assert.ok(fc)
  const near = fc.head.offset(2, 0, 0)
  assert.ok(dragon.landingHits(fc, new Vec3(near.x, 61, near.z)), 'на земле у головы — под крылом/головой')
  assert.equal(dragon.landingHits(fc, new Vec3(near.x + 1.5, 60, near.z + 3)), null, 'в окопе (ноги 60) — нет')
})

test('вторая кровать снижения (L0) с другой стороны окопа: окоп закрыт от обоих взрывов, кровать L переживает L0', () => {
  const bot = fakeBot()
  bot.registry = require('minecraft-data')('1.21.11')
  const target = new Vec3(7.2, 63.9, 0.6)
  const plan = dragon.tsPlan(bot, target, { lift: 1 })
  assert.ok(plan)
  // путь головы: на тике 25 (n = 40, i0 ≤ 27) — над клеткой за окопом (B − 3u), на 63.6
  const n = 40
  const path = []
  const B = plan.B; const u = plan.u
  for (let k = 1; k <= 45; k++) {
    let head = new Vec3(target.x + 20, 70, target.z)
    if (k - 1 === 25) {
      // перебор a0: голова над (B − 3u + a0) для любого a0 — ставим над B − 3u + (перпендикуляр)
      const a0 = { x: u.z, z: -u.x }
      head = new Vec3(B.x - 3 * u.x + a0.x + 0.5, 63.6, B.z - 3 * u.z + a0.z + 0.5)
    }
    if (k - 1 >= n - 3) head = target
    path.push({ k, head, neck: head.offset(20, 5, 0), pos: head.offset(20, 5, 0), yRot: 0 })
  }
  const fc = { n, path }
  const s2 = dragon.tsSecond(bot, plan, fc, {})
  assert.ok(s2, `L0 есть: ${JSON.stringify(dragon.tsSecond.why)}`)
  assert.ok(s2.i0 <= n - 13)
  assert.ok(s2.expect >= 45, `ожидание L0 ${s2.expect}`)
})

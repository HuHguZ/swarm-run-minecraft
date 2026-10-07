'use strict'
// S7c (замечание проверки S7b а): рефлекс столкновения — летит, а рулит никто (S.driving = 0), нынешний взгляд
// за 8 тиков ведёт в стену с уроном — этот тик взгляд меняется; при руле (fly/таран/пике) — не вмешивается.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

function fakeBot (wallX = 6) {
  const handlers: Record<string, any[]> = {}
  const looks = []
  const bot: Record<string, any> = {
    entity: { id: 1, position: new Vec3(0.5, 110, 0.5), velocity: new Vec3(1.6, 0, 0), yaw: -Math.PI / 2, pitch: 0, onGround: false, elytraFlying: true, isInWater: false },
    blockAt: (p) => { const solid = p.y < 100 || p.x >= wallX; return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: p } },
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn) },
    removeListener: () => {},
    _client: { on: () => {}, removeListener: () => {} },
    look: (yaw, pitch) => { looks.push({ yaw, pitch }); return Promise.resolve() },
    inventory: { items: () => [], slots: [] },
    fireworkRocketDuration: 0
  }
  return { bot, handlers, looks, tick: () => (handlers.physicsTick || []).forEach(f => f()) }
}

test('рефлекс столкновения: без руля в стену — отворот; с рулём — нет', () => {
  const sky = require('../src/elytra')
  const a = fakeBot()
  const S = sky.install(a.bot)
  a.tick()
  assert.equal(a.looks.length, 1, 'взгляд сменён')
  assert.equal(S.guardSaves, 1)
  const L = sky.lookVec(a.looks[0].yaw, a.looks[0].pitch)
  const r = sky.rollout(sky.worldOf(a.bot), a.bot.entity.position, a.bot.entity.velocity, a.looks[0].yaw, a.looks[0].pitch, 0, 8)
  assert.ok(!(r.kind === 'wall' && r.dmg >= 1), `новый взгляд без удара о стену (${r.kind}, ${r.dmg}; взгляд ${L.x.toFixed(2)},${L.z.toFixed(2)})`)
  const b = fakeBot()
  const S2 = sky.install(b.bot)
  S2.driving = 1
  b.tick()
  assert.equal(b.looks.length, 0, 'при руле не вмешивается')
})

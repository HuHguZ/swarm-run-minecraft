'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import dragon = require('../src/dragon')
import bow = require('../src/bow')

function fixture (ph = 1, y = 104) {
  const d = { id: 1, name: 'ender_dragon', position: new Vec3(50, 100, 40), yaw: 0, metadata: [ph, 200] }
  const c = { id: 2, name: 'end_crystal', position: new Vec3(42.5, y, 0.5), isValid: true }
  const bot = {
    entity: { id: 10, position: new Vec3(24.5, 61, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20, food: 20, entities: { 1: d, 2: c },
    registry: { entitiesByName: { ender_dragon: { metadataKeys: ['phase', 'health'] } } },
    inventory: { items: () => [{ name: 'bow', count: 1 }, { name: 'arrow', count: 32 }, { name: 'red_bed', count: 4 }] },
    world: { raycast: () => null },
    blockAt: p => ({ name: p.y < 61 ? 'end_stone' : 'air', boundingBox: p.y < 61 ? 'block' : 'empty', position: p.floored() })
  }
  const stats = { arrows: 0 }
  const events = []
  const ctl = { stats, trace: { ev: (k, o) => events.push({ k, ...o }) } }
  return { bot, d, c, stats, ctl, events }
}
function env (t, entries) {
  for (const [k, v] of Object.entries<any>(entries)) {
    const old = process.env[k]; process.env[k] = v
    t.after(() => { if (old == null) delete process.env[k]; else process.env[k] = old })
  }
}
function requireStep () { assert.equal(typeof dragon.crystalWait, 'function', 'crystalWait доступен для офлайн-сцен') }

test('в STRAFE-only кружение оставляет стрелы и не задерживает основной цикл', async t => {
  env(t, { ND_CRYS_STRAFE_ONLY: '1' }); requireStep()
  const f = fixture(0)
  const old = bow.shoot; bow.shoot = async () => { assert.fail('выстрел в HOLDING') }; t.after(() => { bow.shoot = old })
  assert.equal(await dragon.crystalWait({ bot: f.bot }, f.ctl, f.stats, f.d, 0), false)
  assert.equal(f.stats.arrows, 0)
})
test('высокий открытый кристалл в STRAFE остаётся целью, записана фаза спуска', async t => {
  env(t, { ND_CRYS_STRAFE_ONLY: '1' }); requireStep()
  const f = fixture()
  const old = bow.shoot
  bow.shoot = async (bot, target, opts) => {
    assert.equal(target, f.c); assert.equal(opts.shouldStop(), false)
    if (opts.onRelease) opts.onRelease()
    return { shot: true, flightTicks: 30, pitchDeg: 50 }
  }
  t.after(() => { bow.shoot = old })
  assert.equal(await dragon.crystalWait({ bot: f.bot }, f.ctl, f.stats, f.d, 1), true)
  assert.equal(f.stats.arrows, 1)
  const shot = f.events.find(e => e.k === 'crysShot')
  assert.equal(shot.y, 104); assert.equal(shot.releasePh, 1)
})
test('возврат в HOLDING во время натяжения отменяет стрелу', async t => {
  env(t, { ND_CRYS_STRAFE_ONLY: '1' }); requireStep()
  const f = fixture()
  const old = bow.shoot
  bow.shoot = async (bot, target, opts) => {
    f.d.metadata[0] = 0
    assert.equal(opts.shouldStop(), true)
    return { shot: false, why: 'отменил натяжение' }
  }
  t.after(() => { bow.shoot = old })
  await dragon.crystalWait({ bot: f.bot }, f.ctl, f.stats, f.d, 1)
  assert.equal(f.stats.arrows, 0)
})
test('сближение дракона при натяжении отменяет стрелу', async t => {
  env(t, { ND_CRYS_STRAFE_ONLY: '1', ND_CRYS_STRAFE_D: '24' }); requireStep()
  const f = fixture()
  const old = bow.shoot
  bow.shoot = async (bot, target, opts) => {
    f.d.position = f.bot.entity.position.offset(0, 20, 0)
    assert.equal(opts.shouldStop(), true)
    return { shot: false, why: 'отменил натяжение' }
  }
  t.after(() => { bow.shoot = old })
  await dragon.crystalWait({ bot: f.bot }, f.ctl, f.stats, f.d, 1)
  assert.equal(f.stats.arrows, 0)
})
test('клетка не получает стрелу; запас шести стрел сохраняется', async t => {
  env(t, { ND_CRYS_STRAFE_ONLY: '1' }); requireStep()
  const f = fixture()
  const old = bow.shoot; bow.shoot = async () => { assert.fail('клетка или запас') }; t.after(() => { bow.shoot = old })
  f.bot.blockAt = p => ({ name: 'iron_bars', boundingBox: 'block', position: p.floored() })
  assert.equal(await dragon.crystalWait({ bot: f.bot }, f.ctl, f.stats, f.d, 1), false)
  const g = fixture(); g.bot.inventory.items = () => [{ name: 'bow', count: 1 }, { name: 'arrow', count: 6 }]
  assert.equal(await dragon.crystalWait({ bot: g.bot }, g.ctl, g.stats, g.d, 1), false)
})
test('флаг =0 возвращает исходный выстрел в кружении', async t => {
  env(t, { ND_CRYS_STRAFE_ONLY: '0' }); requireStep()
  const f = fixture(0)
  const old = bow.shoot; bow.shoot = async (bot, target, opts) => {
    assert.equal(opts.shouldStop(), false); if (opts.onRelease) opts.onRelease(); return { shot: true, flightTicks: 30 }
  }; t.after(() => { bow.shoot = old })
  assert.equal(await dragon.crystalWait({ bot: f.bot }, f.ctl, f.stats, f.d, 0), true)
  assert.equal(f.stats.arrows, 1)
})
test('до станции в STRAFE стреляем, на посадке и при готовой станции ранний шаг уступает', async t => {
  env(t, { ND_CRYS_EARLY: '1', ND_CRYS_STRAFE_ONLY: '1', ND_CRYSTALS: '1' })
  assert.equal(typeof dragon.earlyCrystalStep, 'function', 'ранний шаг кристаллов реализован')
  const f: any = fixture(); f.ctl.pillarMode = true
  const old = bow.shoot; bow.shoot = async (bot, target, opts) => { opts.onRelease(); return { shot: true, flightTicks: 30 } }
  t.after(() => { bow.shoot = old })
  assert.equal(await dragon.earlyCrystalStep({ bot: f.bot }, f.ctl, f.stats, f.d, 1), true)
  for (const ph of [0, 2, 3, 5, 6, 7, 8, 9]) assert.equal(await dragon.earlyCrystalStep({ bot: f.bot }, f.ctl, f.stats, f.d, ph), false)
  f.ctl.pillar = { built: true }
  assert.equal(await dragon.earlyCrystalStep({ bot: f.bot }, f.ctl, f.stats, f.d, 1), false)
})
test('ранняя стрельба выключается отдельно и уважает ND_CRYSTALS=0', async t => {
  env(t, { ND_CRYS_EARLY: '0', ND_CRYSTALS: '1' })
  assert.equal(typeof dragon.earlyCrystalStep, 'function')
  const f: any = fixture(); f.ctl.pillarMode = true
  assert.equal(await dragon.earlyCrystalStep({ bot: f.bot }, f.ctl, f.stats, f.d, 1), false)
  process.env.ND_CRYS_EARLY = '1'; process.env.ND_CRYSTALS = '0'
  assert.equal(await dragon.earlyCrystalStep({ bot: f.bot }, f.ctl, f.stats, f.d, 1), false)
})

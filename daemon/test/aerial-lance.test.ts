import test from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../src/combat/aerial-lance'
import sky = require('../src/elytra')
import { EventEmitter } from 'node:events'

// Плоский мир: всё ниже y=100 твёрдое, стена x ≥ wallX (если задана).
function flatWorld (wallX = Infinity, ceilY = Infinity) {
  const at = (x: number, y: number, _z: number) => (y < 100 || y >= ceilY || x >= wallX) ? 1 : 0
  return {
    at,
    solid: (x: number, y: number, z: number) => at(x, y, z) === 1,
    boxHit (x: number, y: number, z: number, h = 1.8) {
      for (let X = Math.floor(x - 0.3); X <= Math.floor(x + 0.3 - 1e-9); X++) for (let Y = Math.floor(y); Y <= Math.floor(y + h - 1e-9); Y++) for (let Z = Math.floor(z - 0.3); Z <= Math.floor(z + 0.3 - 1e-9); Z++) if (at(X, Y, Z)) return true
      return false
    },
    floorBelow (x: number, y: number, z: number, depth = 40) { for (let Y = Math.floor(y); Y >= Math.floor(y) - depth; Y--) if (at(Math.floor(x), Y, Math.floor(z))) return { top: Y + 1 }; return null }
  }
}

test('копьё: отрезок 2.0–4.5(+ход) по взгляду и урон разгона по KineticWeapon (javap 1.21.11)', () => {
  const eye = { x: 0, y: 101.62, z: 0 }
  const look = { x: 0, y: 0, z: -1 } // на север
  const still = { x: 0, y: 0, z: 0 }
  assert.equal(L.lanceHits(eye, look, still, { x: 0, y: 100.5, z: -3 }), true, 'в 3 бл. по лучу')
  assert.equal(L.lanceHits(eye, look, still, { x: 0, y: 100.5, z: -1.2 }), false, 'ближе 2.0 (рамка 0.3+0.125) — мимо')
  assert.equal(L.lanceHits(eye, look, still, { x: 0, y: 100.5, z: -5.5 }), false, 'дальше 4.5 стоя — мимо')
  assert.equal(L.lanceHits(eye, look, { x: 0, y: 0, z: -1.5 }, { x: 0, y: 100.5, z: -5.5 }), true, 'на 1.5 б/т отрезок до 6.0')
  assert.equal(L.lanceHits(eye, look, still, { x: 0.5, y: 100.5, z: -3 }), false, 'вбок 0.5 — мимо рамки 0.3+0.125')
  // Урон: 1 + floor(rel·mult), rel в бл/с; ниже 4.6 — ноль.
  const iron = L.lanceDamage('iron_spear', look, { x: 0, y: 0, z: -1.5 })
  assert.equal(iron.rel, 30); assert.equal(iron.dmg, 1 + Math.floor(30 * 0.95)); assert.equal(iron.knock, true)
  assert.equal(L.lanceDamage('iron_spear', look, { x: 0, y: 0, z: -0.2 }).dmg, 0, '4 бл/с < 4.6')
  // Он убегает вдоль взгляда — относительная скорость меньше.
  assert.equal(L.lanceDamage('diamond_spear', look, { x: 0, y: 0, z: -1.5 }, { x: 0, y: 0, z: -1 }).dmg, 1 + Math.floor(10 * 1.075))
})

test('таран: план находит касание на заходе сверху и не ведёт в пол; без выхода у стены — дороже/нет', () => {
  const W = flatWorld()
  // Летим на север 1.4 б/т на высоте 6 над полом, он стоит в 14 бл. впереди.
  const st = { p: { x: 0.5, y: 106, z: 14.5 }, v: { x: 0, y: -0.1, z: -1.4 }, boost: 0, fd: 0 }
  const foot = () => ({ x: 0.5, y: 100, z: 0.5 })
  const pl = L.chooseLance(W, st, foot, { name: 'iron_spear' })
  assert.ok(pl, 'есть взгляд с касанием')
  assert.ok(pl.hitT <= 14, `касание за ${pl.hitT} тиков`)
  assert.ok(pl.dmg >= 15, `урон ${pl.dmg}`)
  assert.notEqual(pl.exit, 'wall')
  // Проверка тем же прогоном: путь с этим взглядом не касается пола до удара.
  const r = sky.rollout(W, st.p, st.v, pl.yaw, pl.pitch, 0, pl.hitT + 1, { fd: 0 })
  assert.equal(r.kind, null)
  // Он вплотную у стены на пути выхода: касание с выходом в стену — не выбирается.
  const W2 = flatWorld(3)
  const st2 = { p: { x: -12, y: 106, z: 0.5 }, v: { x: 1.4, y: -0.1, z: 0 }, boost: 0, fd: 0 }
  const pl2 = L.chooseLance(W2, st2, () => ({ x: 0.5, y: 100, z: 0.5 }), { name: 'iron_spear' })
  // S7d («гибкость вместо правил»): выход в стену — не запрет, а цена (урон себе ×2): такой план дороже того же
  // захода в открытом поле; в заходе страховка «опасно» (прогон 6 тиков) всё равно выводит до удара.
  const free = L.chooseLance(flatWorld(), st2, () => ({ x: 0.5, y: 100, z: 0.5 }), { name: 'iron_spear' })
  assert.ok(free, 'в открытом поле заход есть')
  if (pl2 && pl2.exit === 'wall') assert.ok(pl2.c > free.c, `выход в стену дороже: ${pl2.c} > ${free.c}`)
})

test('таран: план годен с элитрами, ракетами, копьём и нагрудником; щит — нет', () => {
  const items = [{ name: 'elytra', count: 1 }, { name: 'firework_rocket', count: 8 }, { name: 'iron_spear', count: 1 }, { name: 'diamond_chestplate', count: 1 }]
  const bot: any = {
    inventory: { items: () => items, slots: [] as any[] },
    entity: { position: { x: 0.5, y: 100, z: 0.5, offset (dx: number, dy: number, dz: number) { return { x: this.x + dx, y: this.y + dy, z: this.z + dz } } }, onGround: true, isInWater: false },
    blockAt: () => ({ boundingBox: 'empty', name: 'air' }),
    on () {}
  }
  const e = { position: { x: 10.5, y: 100, z: 0.5 } }
  assert.ok(L.lancePlan(bot, e, { d: 10, hp: 20 }))
  assert.equal(L.lancePlan(bot, e, { d: 10, hp: 20, hisShield: true }), null)
  assert.equal(L.lancePlan(bot, e, { d: 10, hp: 6 }), null)
  items[1].count = 2
  assert.equal(L.lancePlan(bot, e, { d: 10, hp: 20 }), null, 'ракет < 3')
  // Голый с элитрами, копьём и ракетами — тоже таран (стенд 21.10: требование нагрудника не пускало синих на таран).
  items[1].count = 8
  items.pop()
  assert.ok(L.lancePlan(bot, e, { d: 10, hp: 20 }), 'без нагрудника')
})

test('касание тарана — только damage_event цели с причиной «я» (S7c, замечание проверки S7b в)', () => {
  const { ownHit }: typeof import('../src/combat/aerial-lance') = require('../src/combat/aerial-lance')
  assert.equal(ownHit({ entityId: 7, sourceCauseId: 4, sourceDirectId: 4 }, 3, 7), true, 'мой удар')
  assert.equal(ownHit({ entityId: 7, sourceCauseId: 0, sourceDirectId: 0 }, 3, 7), false, 'без источника (падение, кинетическая)')
  assert.equal(ownHit({ entityId: 7, sourceCauseId: 8, sourceDirectId: 9 }, 3, 7), false, 'его же кристалл/другой игрок')
  assert.equal(ownHit({ entityId: 5, sourceCauseId: 4 }, 3, 7), false, 'не цель')
  assert.equal(ownHit(null, 3, 7), false)
})

test('S7d: копьё ещё не готово (задержка) — план касания с дугой подлиннее дороже не становится, ранний — дороже', () => {
  const W = flatWorld()
  const st = { p: { x: 0.5, y: 106, z: 14.5 }, v: { x: 0, y: -0.1, z: -1.4 }, boost: 0, fd: 0 }
  const foot = () => ({ x: 0.5, y: 100, z: 0.5 })
  const now = L.chooseLance(W, st, foot, { name: 'iron_spear', readyIn: 0 })
  const late = L.chooseLance(W, st, foot, { name: 'iron_spear', readyIn: 13 })
  assert.ok(now && late)
  // Готовность через 13 тиков: выбранное касание не раньше прежнего (раннее касание — урона нет, оно и дороже).
  assert.ok(late.hitT >= now.hitT, `${late.hitT} >= ${now.hitT}`)
  assert.ok(late.c >= now.c)
})


test('таран: готовое касание после раннего, ранний план остаётся рулением', () => {
  const foot = () => ({ x: .5, y: 100, z: .5 })
  const ready = L.chooseLance(flatWorld(), {
    p: { x: .5, y: 102, z: 8.5 }, v: { x: 0, y: -.1, z: -.6 }, boost: 0, fd: 0
  }, foot, { readyIn: 10 })
  assert.ok(ready?.ready && ready.hitT + 1 >= 10 && ready.dmg > 0)
  const early = L.chooseLance(flatWorld(), {
    p: { x: .5, y: 106, z: 14.5 }, v: { x: 0, y: -.1, z: -1.4 }, boost: 0, fd: 0
  }, foot, { readyIn: 13 })
  assert.ok(early && !early.ready && early.dmg === 0 && early.hitT + 1 < 13)
})

test('возврат внутрь: стороны и углы, с ракетой и без', () => {
  const { returnInside } = require('../src/elytra/control') as typeof import('../src/elytra/control')
  const arena = { x: 0, z: 0, r: 80 }
  const inside = p => Math.abs(p.x) + .300001 <= 80 && Math.abs(p.z) + .300001 <= 80
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    for (const boost of [0, 26]) {
      const st = { p: { x: dx * 81, y: 150, z: dz * 81 },
        v: { x: dx * 1.6 / Math.hypot(dx, dz), y: 0, z: dz * 1.6 / Math.hypot(dx, dz) }, boost, fd: 0 }
      for (let t = 0; t < 100 && !inside(st.p); t++) {
        const pl = returnInside(flatWorld(), st, arena)
        assert.ok(pl)
        const r = sky.rollout(flatWorld(), st.p, st.v, pl.yaw, pl.pitch, st.boost, 1, { fd: st.fd })
        assert.equal(r.kind, null)
        st.p = r.p; st.v = r.v; st.fd = r.fd; st.boost = Math.max(0, st.boost - 1)
      }
      assert.ok(inside(st.p), dx + ',' + dz + ', boost=' + boost)
    }
  }
})


test('таран: чистый выход выигрывает у удара в потолок', () => {
  const st = { p: { x: .5, y: 103, z: 8.5 }, v: { x: 0, y: -.1, z: -1.4 }, boost: 0, fd: 0 }
  const pl = L.chooseLance(flatWorld(Infinity, 106), st, () => ({ x: .5, y: 100, z: .5 }))
  assert.ok(pl && pl.dmg > 0)
  assert.equal(pl.exit, null)
})

test('заход тарана: ракета проверяется с ускорением; в открытом мире остаётся', async t => {
  const flight = require('../src/elytra/flight') as typeof import('../src/elytra/flight')
  const install = require('../src/elytra/install') as typeof import('../src/elytra/install')
  const Vec3: typeof import('vec3').Vec3 = require('vec3')
  t.mock.method(flight, 'fly', async () => ({ why: 'разбег' }))
  t.mock.method(flight, 'chestDown', async () => ({ ok: true }))
  let fired = 0
  t.mock.method(install, 'fireRocket', () => { fired++; return { ok: true, hand: 'off' } })
  for (const [wallX, expected] of [[7, 0], [Infinity, 1]]) {
    const bot: any = new EventEmitter()
    const item = { name: 'iron_spear', count: 1 }, rocket = { name: 'firework_rocket', count: 8 }
    bot.entity = { id: 1, position: new Vec3(.5, 103, .5), velocity: new Vec3(.2, -.1, 0), elytraFlying: true, onGround: false }
    bot.health = 20; bot.heldItem = item
    bot.inventory = { items: () => [item, rocket], slots: [] }
    bot.inventory.slots[6] = { name: 'elytra' }; bot.inventory.slots[45] = rocket
    bot._client = new EventEmitter(); bot._ndElytra = { driving: 0, fd: 0, startedAt: 0 }
    bot.look = async () => {}; bot.activateItem = () => {}; bot.deactivateItem = () => {}
    bot.fireworkRocketDuration = 0
    bot.blockAt = p => {
      const solid = p.y < 100 || p.x >= wallX
      return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty' }
    }
    const enemy = { id: 2, type: 'player', username: 'foe', position: new Vec3(5, 100, .5), onGround: true, isValid: true }
    const ctl = { aborted: false }, stats: any = {}
    fired = 0
    const done = L.lance(bot, ctl, enemy, { passes: 1, telemetryHp: () => null, stats })
    try {
      for (let n = 0; n < 20 && !stats.lancePasses; n++) await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(stats.lancePasses, 1)
      bot.emit('physicsTick')
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(fired, expected, `стена x=${wallX}`)
    } finally {
      ctl.aborted = true; bot.entity.elytraFlying = false; bot.entity.onGround = true
      bot.emit('physicsTick')
      await done
    }
  }
})

test('разбег против копья: бок/тыл и противоположная сторона союзника внутри арены', () => {
  const e: any = { position: { x: 0, y: 100, z: 0 }, yaw: 0 }
  const point = L.lanceFlankPoint({ x: 0, y: 106, z: -12 }, e, 107)
  assert.ok(point.z >= -1e-9 && Math.abs(point.x) > 10, 'из фронта выбирается ближайший бок')
  const rear = L.lanceFlankPoint({ x: 0, y: 106, z: 12 }, e, 107)
  assert.ok(rear.z > 10, 'за спиной сохраняется тыл')
  const pin = L.lanceFlankPoint({ x: 12, y: 106, z: 0 }, e, 107, null, { x: 0, y: 100, z: -12 })
  assert.ok(pin.z > 10, 'союзник спереди — второй сзади')
  const arena = { x: 0, z: 0, r: 10 }
  const clipped = L.lanceFlankPoint({ x: 0, y: 106, z: -9 }, e, 107, arena)
  assert.ok(Math.abs(clipped.x) <= 7 && Math.abs(clipped.z) <= 7)
})

test('клещи истекают по игровым часам с ускорением, независимо от wall clock', t => {
  const clock = require('../src/game-clock') as typeof import('../src/game-clock')
  const { hint } = require('../src/pvp/team-assist') as typeof import('../src/pvp/team-assist')
  let now = 1000
  t.mock.method(clock, 'now', () => now)
  t.mock.method(Date, 'now', () => 9000000)
  const bot: any = {}, e: any = { username: 'Foe' }, from = { x: 0, y: 100, z: -12 }
  hint({ require: () => bot }, { target: 'Foe', from })
  assert.equal(bot._ndPincer.until, 7000)
  assert.equal(L.lancePincerFrom(bot, e), from)
  now = 7000
  assert.equal(L.lancePincerFrom(bot, e), null)
})

test('разбег по радиусу спереди ещё не закончен: сначала достичь выбранного фланга', async t => {
  const flight = require('../src/elytra/flight') as typeof import('../src/elytra/flight')
  const Vec3: typeof import('vec3').Vec3 = require('vec3')
  const bot: any = new EventEmitter(), item = { name: 'iron_spear', count: 1 }, rocket = { name: 'firework_rocket', count: 8 }
  bot.entity = { id: 1, position: new Vec3(0, 107, -14), velocity: new Vec3(0, 0, -1), elytraFlying: true, onGround: false }
  bot.health = 20; bot.heldItem = item; bot.inventory = { items: () => [item, rocket], slots: [] }
  bot.inventory.slots[6] = { name: 'elytra' }; bot.inventory.slots[45] = rocket
  bot.registry = { entitiesByName: { player: { metadataKeys: [...Array(8).fill(''), 'living_entity_flags'] } } }
  bot._client = new EventEmitter(); bot._ndElytra = { driving: 0, fd: 0, startedAt: 0 }
  bot.look = async () => {}; bot.activateItem = () => {}; bot.deactivateItem = () => {}
  bot.fireworkRocketDuration = 0
  bot.blockAt = p => ({ name: p.y < 100 ? 'stone' : 'air', boundingBox: p.y < 100 ? 'block' : 'empty' })
  const e: any = { id: 2, type: 'player', username: 'Foe', position: new Vec3(0, 100, 0), onGround: true, isValid: true,
    yaw: 0, pitch: 0, metadata: { 8: 1 }, equipment: [{ name: 'iron_spear' }] }
  const ctl = { aborted: false }
  let checked = 0
  t.mock.method(flight, 'fly', async (_b, _ctl, options: any) => {
    const goal = options.goal()
    assert.ok(Math.abs(goal.at.x) > 10 && Math.abs(goal.at.z) < 1e-6)
    assert.equal(options.until(), null, 'старый радиальный критерий ошибочно принимал фронтальный разбег')
    e.yaw = Math.PI / 4
    const afterTurn = options.goal()
    assert.ok(afterTurn.at.distanceTo(goal.at) < 1e-6, 'выбранный фланг не вращается вместе с прицелом')
    bot.entity.position = goal.at
    assert.equal(options.until(), 'разбег')
    checked++
    ctl.aborted = true; bot.entity.elytraFlying = false; bot.entity.onGround = true
    return { why: 'прервали' }
  })
  t.mock.method(flight, 'chestDown', async () => ({ ok: true }))
  await L.lance(bot, ctl, e, { passes: 1, telemetryHp: () => null })
  assert.equal(checked, 1)
})

test('страховка захода: стена за ним после готового касания — заход; выход в стену, раннее касание или пол раньше — отказ', () => {
  const wall = { kind: 'wall', t: 5, dmg: 13.8 }
  assert.equal(L.aheadBail(wall, { ready: true, hitT: 0, exit: null }), null, 'c33: касание на 0 т, стена на 5 т')
  assert.equal(L.aheadBail(wall, { ready: true, hitT: 3, exit: null }), 'стена', 'запас меньше 3 т')
  assert.equal(L.aheadBail(wall, { ready: true, hitT: 0, exit: 'wall' }), 'стена', 'выход плана — в стену')
  assert.equal(L.aheadBail(wall, { ready: false, hitT: 0, exit: null }), 'стена', 'копьё не готово')
  assert.equal(L.aheadBail(wall, null), 'стена', 'плана нет')
  assert.equal(L.aheadBail({ kind: 'wall', t: 2, dmg: 0.5 }, null), null, 'касание стены без урона')
  assert.equal(L.aheadBail({ kind: 'floor', t: 3, fd: 9 }, { ready: true, hitT: 3, exit: null }), null, 'касание не позже пола')
  assert.equal(L.aheadBail({ kind: 'floor', t: 3, fd: 9 }, { ready: true, hitT: 4, exit: null }), 'пол')
})


test('копьё: начало внутри margin не заменяет контакт с настоящей рамкой', () => {
  const eye = { x: 0, y: 101, z: 0 }, look = { x: 0, y: 0, z: -1 }, v = { x: 0, y: 0, z: 0 }
  assert.equal(L.lanceHits(eye, look, v, { x: 0, y: 100, z: -1.6 }), false, 'bare кончается на 1.9; start=2 только в margin')
  assert.equal(L.lanceHits(eye, look, v, { x: 0, y: 100, z: -1.8 }), true, 'start внутри bare')
  assert.equal(L.lanceHits(eye, look, v, { x: .4, y: 100, z: -2 }), false, 'start внутри бокового margin, bare не пересекается')
  assert.equal(L.lanceHits(eye, look, v, { x: .4, y: 100, z: -3 }), true, 'вход снаружи в margin остаётся попаданием без блоков')
})

test('копьё: отн. скорость не заменяет minSpeed=0 атакующего', () => {
  assert.equal(L.lanceDamage('diamond_spear', { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: .1 }, { x: 0, y: 0, z: .5 }).dmg, 0)
})

test('offhand ракета сохраняет локальный флаг use правой руки как сервер', () => {
  const install = require('../src/elytra/install') as typeof import('../src/elytra/install')
  const Vec3: typeof import('vec3').Vec3 = require('vec3')
  for (const active of [false, true]) {
    const bot: any = new EventEmitter()
    const rocket = { name: 'firework_rocket', count: 8 }
    bot.entity = { position: new Vec3(0, 110, 0), velocity: new Vec3(0, 0, -1), elytraFlying: true }
    bot.inventory = { slots: [] }; bot.inventory.slots[45] = rocket
    bot._ndElytra = { lastRocketAt: -Infinity }
    bot.usingHeldItem = active
    let off: any = null
    bot.activateItem = (hand: boolean) => { off = hand; bot.usingHeldItem = true }
    assert.equal(install.fireRocket(bot).ok, true)
    assert.equal(off, true)
    assert.equal(bot.usingHeldItem, active)
  }
})

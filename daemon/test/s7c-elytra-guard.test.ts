'use strict'
// S7c (замечание проверки S7b а): рефлекс столкновения — летит, а рулит никто (S.driving = 0), нынешний взгляд
// за 8 тиков ведёт в стену с уроном — этот тик взгляд меняется; при руле (fly/таран/пике) — не вмешивается.
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')

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

test('startGlide does not send START_FALL_FLYING again while already gliding', () => {
  const { startGlide }: typeof import('../src/elytra/install') = require('../src/elytra/install')
  const { bot } = fakeBot()
  const packets = []
  bot.inventory.slots[6] = { name: 'elytra' }
  bot.supportFeature = () => true
  bot._client.write = (name, data) => packets.push({ name, data })
  assert.equal(startGlide(bot), true)
  assert.equal(packets.length, 0)
  bot.entity.elytraFlying = false
  assert.equal(startGlide(bot), true)
  assert.deepEqual(packets, [{ name: 'entity_action', data: { entityId: 1, actionId: 'start_elytra_flying', jumpBoost: 0 } }])
  assert.equal(startGlide(bot), true)
  assert.equal(packets.length, 1)
  bot.entity.onGround = true
  assert.equal(startGlide(bot), false)
})

test('рефлекс столкновения: без руля в стену — отворот; с рулём — нет', () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
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

test('ракета «надо»: идёт только со взглядом, при котором полёт с ней не кончается стеной с уроном (тормоз ракетой — тоже выход)', () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
  const W = (wallX) => ({ at: (x, y) => (y < 100 || x >= wallX) ? 1 : 0, solid (x, y, z) { return this.at(x, y, z) === 1 }, boxHit (x, y, z, h = 1.8) { for (const X of [Math.floor(x - 0.3), Math.floor(x + 0.3)]) for (let Y = Math.floor(y); Y <= Math.floor(y + h); Y++) if (Y < 100 || X >= wallX) return true; return false }, floorBelow () { return { top: 100 } } })
  const st = { p: { x: 0.5, y: 110, z: 0.5 }, v: { x: 1.6, y: 0, z: 0 }, boost: 0, fd: 0 }
  const goal = { kind: 'point', at: { x: 40, y: 110, z: 0.5 } }
  for (const wallX of [2, 3, 5, 1e9]) {
    const Wx = W(wallX)
    const rc = sky.rocketChoice(Wx, st, goal, sky.choose(Wx, st, goal), true)
    if (!rc.fire) { assert.equal(rc.veto, true); continue }
    const r = sky.rollout(Wx, st.p, st.v, rc.yaw, rc.pitch, 26, 18)
    assert.ok(!(r.kind === 'wall' && r.dmg >= 1), `стена в ${wallX}: полёт с ракетой — ${r.kind} ${r.dmg}`)
  }
  const Wf = W(1e9)
  assert.equal(sky.rocketChoice(Wf, st, goal, sky.choose(Wf, st, goal), true).fire, true, 'в чистом небе ракета идёт')
})

test('S7d: руль один — пока полёт ведёт fly/таран, чужой поворот взгляда отбит, рулевой (steer) проходит', async () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
  const a = fakeBot(1000)
  const S = sky.install(a.bot)
  S.driving = 1
  await a.bot.look(0, 0, true) // прицел боя посреди тарана
  assert.equal(a.looks.length, 0, 'чужой взгляд не дошёл до тела')
  assert.equal(S.blockedLooks, 1)
  await sky.steer(a.bot, 1, 0.2)
  assert.equal(a.looks.length, 1, 'рулевой поворачивает')
  S.driving = 0
  await a.bot.look(2, 0, true)
  assert.equal(a.looks.length, 2, 'без руля — как раньше')
})

test('collision reflex keeps its safe look until the next physical forecast', async () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
  const a = fakeBot()
  a.bot.lookAt = async () => { a.looks.push({ yaw: 99, pitch: 99 }) }
  const S = sky.install(a.bot)
  a.tick()
  assert.equal(S.guardSaves, 1)
  const safe = a.looks[0]
  await a.bot.look(-Math.PI / 2, 0, true) // A ground flee resumes after the physics listener.
  await a.bot.lookAt(new Vec3(6, 110, .5), true)
  assert.deepEqual(a.looks, [safe], 'ground steering must not undo the collision avoidance')
  await sky.steer(a.bot, 1, .2)
  assert.equal(a.looks.length, 2, 'a flight pilot can take over immediately')
  a.bot.entity.position.x = -100
  a.bot.entity.velocity.x = -1
  a.bot.entity.yaw = Math.PI / 2
  a.tick()
  await a.bot.look(2, 0, true)
  assert.equal(a.looks.at(-1).yaw, 2, 'a clear new forecast releases ordinary steering')
  a.bot.entity.position.x = .5
  a.bot.entity.velocity.x = 1.6
  a.bot.entity.yaw = -Math.PI / 2
  a.tick()
  a.bot.entity.elytraFlying = false
  a.bot.entity.onGround = true
  a.tick()
  a.bot.entity.elytraFlying = true
  await a.bot.look(3, 0, true)
  assert.equal(a.looks.at(-1).yaw, 3, 'landing clears the old reflex before another glide')
})

test('S7d: стена в 1 блок под ракетой 1.6 б/т — прогон видит удар (раньше рамка «перепрыгивала» стекло арены)', () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
  // Стекло арены — только клетка x = 175, за ней воздух (арена в небе), пол далеко внизу.
  const at = (x, y, z) => (x === 175 || y <= 99) ? 1 : 0
  const W = { at, boxHit (x, y, z, h = 1.8) { const H = 0.3; for (let X = Math.floor(x - H); X <= Math.floor(x + H - 1e-9); X++) for (let Y = Math.floor(y); Y <= Math.floor(y + h - 1e-9); Y++) for (let Z = Math.floor(z - H); Z <= Math.floor(z + H - 1e-9); Z++) if (at(X, Y, Z)) return true; return false }, floorBelow: () => ({ top: 100 }) }
  // Состояние из [elytra-plan-miss] s7d-d-27p: x 179.6, ход на запад 1.64 б/т, ракета ещё 24 тика.
  const r = sky.rollout(W, { x: 179.59, y: 124.12, z: 331.07 }, { x: -1.635, y: 0.2, z: 0.08 }, 1.74, 0, 24, 18, { fd: 1 })
  assert.equal(r.kind, 'wall')
  assert.ok(r.t <= 3, `удар на ${r.t}-м тике`)
  assert.ok(r.dmg > 10, `урон ${r.dmg}`)
})

test('S7d: полёт кончился высоко (падаю, элитры на теле) — рефлекс раскрывает снова; у пола и с булавой — нет', () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
  const a = fakeBot(1000)
  const writes = []
  a.bot._client.write = (name, data) => writes.push({ name, data })
  a.bot.supportFeature = () => true
  a.bot.inventory.slots[6] = { name: 'elytra' }
  a.bot.entity.elytraFlying = false
  a.bot.entity.velocity = new Vec3(0, -0.9, 0)
  sky.install(a.bot)
  a.tick()
  assert.equal(a.bot.entity.elytraFlying, true, 'раскрыл')
  assert.equal(writes.length, 1)
  // Низко над полом (пол у y 100, тело 102) — не трогает.
  const b = fakeBot(1000)
  b.bot._client.write = () => { throw new Error('не должен') }
  b.bot.supportFeature = () => true
  b.bot.inventory.slots[6] = { name: 'elytra' }
  b.bot.entity.elytraFlying = false
  b.bot.entity.position = new Vec3(0.5, 102, 0.5)
  b.bot.entity.velocity = new Vec3(0, -0.9, 0)
  sky.install(b.bot)
  b.tick()
  assert.equal(b.bot.entity.elytraFlying, false)
})

test('S7d: взлёт — уступ в 2 бл. по заказанному взгляду: launchLook отворачивает или берёт круче; чисто — заказанный', () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
  // Пол y ≤ 99, уступ-стена x 2..3 высотой до y 103 (колизей с рельефом), потолок далеко.
  const wall = (x, y) => x >= 2 && x <= 3 && y <= 103
  const at = (x, y, z) => (y <= 99 || wall(x, y)) ? 1 : 0
  const W = { at, boxHit (x, y, z, h = 1.8) { const H = 0.3; for (let X = Math.floor(x - H); X <= Math.floor(x + H - 1e-9); X++) for (let Y = Math.floor(y); Y <= Math.floor(y + h - 1e-9); Y++) for (let Z = Math.floor(z - H); Z <= Math.floor(z + H - 1e-9); Z++) if (at(X, Y, Z)) return true; return false }, floorBelow: () => ({ top: 100 }) }
  const p = { x: 0.5, y: 100, z: 0.5 }
  const east = -Math.PI / 2 // mineflayer: yaw −π/2 — на +x
  const before = sky.rollout(W, { x: 0.5, y: 100.3, z: 0.5 }, { x: 0, y: 0.3, z: 0 }, east, 0.45, 40, 14)
  assert.equal(before.kind, 'wall', 'заказанный взгляд (бой, 0.45 рад.) — в уступ')
  const ll = sky.launchLook(W, p, east, 0.45)
  assert.equal(ll.bad, false)
  const after = sky.rollout(W, { x: 0.5, y: 100.3, z: 0.5 }, { x: 0, y: 0.3, z: 0 }, ll.yaw, ll.pitch, 40, 14)
  assert.ok(!(after.kind === 'wall' && after.dmg >= 0.5), `после выбора: ${after.kind}`)
  const free = sky.launchLook(W, p, Math.PI / 2, 0.45) // на −x чисто
  assert.equal(free.yaw, Math.PI / 2)
  assert.equal(free.pitch, 0.45)
})

test('S7d: чёрный ящик держит тики полёта 10 тиков после касания (урон падения приходит после)', () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
  const a = fakeBot(1000)
  const S = sky.install(a.bot)
  a.tick(); a.tick()
  assert.ok(S.box.length >= 2)
  a.bot.entity.elytraFlying = false
  a.bot.entity.onGround = true
  for (let i = 0; i < 5; i++) a.tick()
  assert.ok(S.box.length >= 2, 'сразу после касания ящик цел')
  for (let i = 0; i < 10; i++) a.tick()
  assert.equal(S.box.length, 0, 'на земле дольше 10 тиков — чист')
})

test('S7d: воздушный бой с копьём — цель «пролёт у груди» (point+reach+gap) не ведёт в пол; «strike» (модель булавы) — ведёт', () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
  const FLOOR = 120
  const at = (x, y, z) => (y < FLOOR || Math.abs(x - 600) > 40 || Math.abs(z - 600) > 40 || y > 150) ? 1 : 0
  const W = { at, boxHit (x, y, z, h = 1.8) { const H = 0.3; for (let X = Math.floor(x - H); X <= Math.floor(x + H - 1e-9); X++) for (let Y = Math.floor(y); Y <= Math.floor(y + h - 1e-9); Y++) for (let Z = Math.floor(z - H); Z <= Math.floor(z + H - 1e-9); Z++) if (at(X, Y, Z)) return true; return false }, floorBelow (x, y, z, depth = 40) { for (let Y = Math.floor(y); Y >= Math.floor(y) - depth; Y--) if (at(Math.floor(x), Y, Math.floor(z))) return { top: Y + 1 }; return null } }
  const target = new Vec3(600, FLOOR, 600)
  const fly = (goal) => {
    let p = new Vec3(588, FLOOR + 12, 600); let v = new Vec3(1.2, 0, 0); let fd = 1; let minD = 99
    for (let t = 0; t < 30; t++) {
      const pl = sky.choose(W, { p, v, boost: 0, fd }, goal)
      const r = sky.rollout(W, p, v, pl.yaw, pl.pitch, 0, 1, { fd })
      p = new Vec3(r.p.x, r.p.y, r.p.z); v = new Vec3(r.v.x, r.v.y, r.v.z); fd = r.fd
      minD = Math.min(minD, p.distanceTo(target))
      if (r.kind) return { kind: r.kind, fd, minD }
    }
    return { kind: null, fd, minD }
  }
  const old = fly({ kind: 'strike', at: () => target, within: 3.5 })
  assert.equal(old.kind, 'floor')
  assert.ok(old.fd > 6, `strike: пол с высотой падения ${old.fd}`)
  const now = fly({ kind: 'point', at: () => target.offset(0, 1.2, 0), reach: true, gap: 1.0 })
  assert.ok(now.kind !== 'floor' || now.fd <= 3, `point: ${now.kind} fd ${now.fd}`)
  assert.ok(now.minD < 4.5, `прошёл в досягаемости копья: ${now.minD}`)
})

test('S7d: элитры на теле в воздухе — «надеть лучшую броню» нагрудник не ставит (полёт гас), на земле — ставит', () => {
  const armor: typeof import('../src/armor') = require('../src/armor')
  const slots: any[] = new Array(46).fill(null)
  slots[6] = { name: 'elytra', maxDurability: 432, durabilityUsed: 0 }
  const chest = { name: 'diamond_chestplate', maxDurability: 528, durabilityUsed: 0, slot: 20 }
  slots[20] = chest
  const bot: any = { entity: { onGround: false, elytraFlying: true }, inventory: { slots, items: () => [chest] }, game: { dimension: 'overworld' } }
  const air = armor.armorReport({ bot }).better.filter(b => b.slot === 'torso')
  assert.equal(air.length, 0, JSON.stringify(air))
  bot.entity = { onGround: true, elytraFlying: false }
  const ground = armor.armorReport({ bot }).better.filter(b => b.slot === 'torso')
  assert.equal(ground.length, 1)
  assert.equal(ground[0].item, 'diamond_chestplate')
})

test('S7d: посадка с 22 бл. — спуск без пике (высота падения на спуске ≤ 5), касание без урона', () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
  const FLOOR = 120
  const at = (x, y, z) => (y < FLOOR || Math.abs(x - 600) > 30 || Math.abs(z - 600) > 30) ? 1 : 0
  const W = { at, boxHit (x, y, z, h = 1.8) { const H = 0.3; for (let X = Math.floor(x - H); X <= Math.floor(x + H - 1e-9); X++) for (let Y = Math.floor(y); Y <= Math.floor(y + h - 1e-9); Y++) for (let Z = Math.floor(z - H); Z <= Math.floor(z + H - 1e-9); Z++) if (at(X, Y, Z)) return true; return false }, floorBelow (x, y, z, depth = 40) { for (let Y = Math.floor(y); Y >= Math.floor(y) - depth; Y--) if (at(Math.floor(x), Y, Math.floor(z))) return { top: Y + 1 }; return null } }
  let p = new Vec3(600, FLOOR + 22, 600); let v = new Vec3(1.2, 0, 0); let fd = 1; let maxFd = 0; let ev = null
  for (let t = 0; t < 400 && !ev; t++) {
    const pl = sky.choose(W, { p, v, boost: 0, fd }, { kind: 'land', at: new Vec3(605.5, FLOOR, 605.5), away: null, edge: () => false })
    const r = sky.rollout(W, p, v, pl.yaw, pl.pitch, 0, 1, { fd })
    p = new Vec3(r.p.x, r.p.y, r.p.z); v = new Vec3(r.v.x, r.v.y, r.v.z); fd = r.fd; maxFd = Math.max(maxFd, fd); ev = r.kind
  }
  assert.equal(ev, 'floor')
  assert.ok(maxFd <= 5, `высота падения на спуске ${maxFd}`)
  assert.ok(fd <= 3, `на касании ${fd}`)
})

test('S7d: воздушный бой с копьём — цель «в 3 бл. от его груди с моей стороны»: пролёт в окне копья 2–4.5 бл., не в пол', () => {
  const sky: typeof import('../src/elytra') = require('../src/elytra')
  const FLOOR = 120
  const at = (x, y, z) => (y < FLOOR || Math.abs(x - 600) > 40 || Math.abs(z - 600) > 40 || y > 150) ? 1 : 0
  const W = { at, boxHit (x, y, z, h = 1.8) { const H = 0.3; for (let X = Math.floor(x - H); X <= Math.floor(x + H - 1e-9); X++) for (let Y = Math.floor(y); Y <= Math.floor(y + h - 1e-9); Y++) for (let Z = Math.floor(z - H); Z <= Math.floor(z + H - 1e-9); Z++) if (at(X, Y, Z)) return true; return false }, floorBelow (x, y, z, depth = 40) { for (let Y = Math.floor(y); Y >= Math.floor(y) - depth; Y--) if (at(Math.floor(x), Y, Math.floor(z))) return { top: Y + 1 }; return null } }
  const chest = new Vec3(600, FLOOR + 1.2, 600)
  for (const [h, dist] of [[8, 10], [12, 14], [6, 6]]) {
    let p = new Vec3(600 - dist, FLOOR + h, 600); let v = new Vec3(1.0, 0, 0); let fd = 1; let minD = 99; let ev = null
    for (let t = 0; t < 30 && !ev; t++) {
      const m = p
      const stand = () => { const dx = m.x - chest.x; const dy = m.y + 0.4 - chest.y; const dz = m.z - chest.z; const n = Math.hypot(dx, dy, dz) || 1; return chest.offset(dx / n * 3, dy / n * 3, dz / n * 3) }
      const pl = sky.choose(W, { p, v, boost: 0, fd }, { kind: 'point', at: stand, reach: true, gap: 1.0 })
      const r = sky.rollout(W, p, v, pl.yaw, pl.pitch, 0, 1, { fd })
      p = new Vec3(r.p.x, r.p.y, r.p.z); v = new Vec3(r.v.x, r.v.y, r.v.z); fd = r.fd; ev = r.kind
      minD = Math.min(minD, p.offset(0, 0.4, 0).distanceTo(chest))
    }
    assert.ok(!(ev === 'floor' && fd > 3), `h ${h}: ${ev} fd ${fd}`)
    assert.ok(minD >= 1.6 && minD <= 4.5, `h ${h} d ${dist}: ближе всего ${minD.toFixed(2)}`)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../src/combat/aerial-lance'
import sky = require('../src/elytra')

// Плоский мир: всё ниже y=100 твёрдое, стена x ≥ wallX (если задана).
function flatWorld (wallX = Infinity) {
  const at = (x: number, y: number, _z: number) => (y < 100 || x >= wallX) ? 1 : 0
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

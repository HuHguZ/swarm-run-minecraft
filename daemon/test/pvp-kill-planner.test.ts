'use strict'
// Планировщик добивания (src/pvp/kill-planner.ts): решения на конкретных боях и арифметика P(убить).
import test = require('node:test')
import assert = require('node:assert/strict')
import * as kp from '../src/pvp/kill-planner'
import * as dm from '../src/pvp/damage-model'

const kit = (mat, ench = {}) => ['helmet', 'chestplate', 'leggings', 'boots'].map(s => ({ name: `${mat}_${s}`, ench }))
function obs ({ dist = 2.5, hp = { lo: 18, hi: 20, mean: 19 }, totem = false, items = [{ name: 'diamond_sword' }], held = 'diamond_sword', foe = {}, me = {}, ...rest }: any = {}) {
  return {
    difficulty: 'normal',
    dist,
    los: true,
    foe: { player: true, hp, totem, armor: kit('iron'), main: { name: 'iron_sword' }, blocking: false, approach: 0, ...foe },
    me: { ehp: 20, armor: kit('iron'), held, since: 20, onGround: true, canCrit: true, items, hasShield: false, ...me },
    ...rest
  }
}

test('добить стрелой, а не идти мечом: 12 блоков, у него 2–3 хп', () => {
  const r = kp.planAttack(obs({ dist: 12, hp: { lo: 2, hi: 3, mean: 2.5 }, items: [{ name: 'diamond_sword' }, { name: 'crossbow', crossbow: { loaded: true, ammo: 'arrow', piercing: 0 } }] }))
  assert.equal(r.action.kind, 'xbow')
  assert.match(r.why, /^добиваю/)
  // Меч — только после сближения (~33 тика): стрела быстрее.
  assert.ok(r.action.ticks <= 2)
  // Разброс урона попадания — для trackFoe.noteAttack.
  assert.ok(r.action.range.min > 3 && r.action.range.raw === 11)
})

test('в упор хватает удара без заряда — бьём сразу, не ждём крита', () => {
  const r = kp.planAttack(obs({ dist: 2.5, hp: { lo: 2, hi: 3, mean: 2.5 } }))
  assert.equal(r.action.kind, 'melee')
  assert.equal(r.action.variant, 'now')
  assert.equal(r.action.ticks, 0)
})

test('противник с тотемом: одного удара мало, нужен второй — P(убить) копится только с ним', () => {
  const o = obs({ dist: 2.5, hp: { lo: 3, hi: 4, mean: 3.5 }, totem: true })
  const r = kp.planAttack(o)
  assert.ok(r.plan.length >= 2, JSON.stringify(r.plan))
  assert.ok(r.pKill > 0.05)
  assert.match(r.why, /тотем/)
  const one = kp.planAttack(o, { depth: 1 })
  assert.ok(one.pKill < 0.01, `один удар против тотема: ${one.pKill}`)
  // Без тотема тот же один удар — почти наверняка.
  assert.ok(kp.planAttack(obs({ dist: 2.5, hp: { lo: 3, hi: 4, mean: 3.5 } }), { depth: 1 }).pKill > 0.75)
})

test('щит поднят: сначала топором выбить, потом булава с падения', () => {
  const o = obs({
    dist: 2.5,
    hp: { lo: 14, hi: 20, mean: 17 },
    held: 'diamond_axe',
    items: [{ name: 'diamond_axe' }, { name: 'mace' }, { name: 'diamond_sword' }],
    foe: { blocking: true, shieldAngle: 0, armor: kit('diamond') },
    smash: { h: 10, ticks: 30 }
  })
  const r = kp.planAttack(o)
  assert.equal(r.action.kind, 'axe-shield')
  assert.ok(r.plan.some(s => s.kind === 'smash'), JSON.stringify(r.plan))
  assert.ok(r.pKill > 0.3)
  // Без топора всё в щит.
  const noAxe = kp.planAttack({ ...o, me: { ...o.me, items: [{ name: 'mace' }, { name: 'diamond_sword' }], held: 'diamond_sword' } })
  assert.ok(noAxe.pKill < 0.01)
})

test('кристалл не тратим, если добивает удар', () => {
  const r = kp.planAttack(obs({
    dist: 2.5,
    hp: { lo: 1, hi: 2, mean: 1.5 },
    items: [{ name: 'diamond_sword' }, { name: 'end_crystal', count: 4 }, { name: 'obsidian', count: 8 }],
    boom: { crystal: { dist: 1.5, seen: 1 } }
  }))
  assert.notEqual(r.action.kind, 'crystal')
  assert.equal(r.action.expensive, false)
})

test('убить за горизонт нельзя — максимум урона в секунду', () => {
  const r = kp.planAttack(obs({ dist: 2.5, hp: { lo: 19, hi: 20, mean: 19.5 }, foe: { armor: kit('netherite', { protection: 4 }) } }), { horizon: 20 })
  assert.match(r.why, /нельзя/)
  assert.ok(r.dps > 0)
})

test('P(убить): без тотема — по CDF, с тотемом — нужен второй удар ≥ 9 после срабатывания', () => {
  const est = { lo: 4, hi: 4, mean: 4, exact: true }
  assert.equal(kp.pKillHits([{ t: 0, d: 5 }], est, false, 60), 1)
  assert.equal(kp.pKillHits([{ t: 0, d: 5 }], est, true, 60), 0)
  assert.equal(kp.pKillHits([{ t: 0, d: 5 }, { t: 20, d: 8.9 }], est, true, 60), 0)
  assert.equal(kp.pKillHits([{ t: 0, d: 5 }, { t: 20, d: 9 }], est, true, 60), 1)
  // Регенерация II тотема: через 30 тиков нужно уже 10.
  assert.equal(kp.pKillHits([{ t: 0, d: 5 }, { t: 30, d: 9.5 }], est, true, 60), 0)
  // Удар после горизонта не в счёт.
  assert.equal(kp.pKillHits([{ t: 70, d: 50 }], est, false, 60), 0)
})

test('неуязвимость в плане: второй удар в 10 тиков проходит превышением', () => {
  // Он только что получил наш крит (сырой 10.5) 3 тика назад: удар «сейчас» мечом (7) — ноль.
  const o = obs({ dist: 2.5, hp: { lo: 2, hi: 3, mean: 2.5 }, foe: { iframe: { raw: 10.5, ago: 3 } } })
  const r = kp.planAttack(o, { depth: 1 })
  assert.notEqual(r.action.variant, 'now')
})

test('опасность: топор с «Острота V» по железу при 6 хп — разорвать дистанцию; меч и наш щит — щит', () => {
  const axe = kp.dangerOf(obs({ dist: 2.5, foe: { main: { name: 'netherite_axe', ench: { sharpness: 5 } } }, me: { ehp: 6, hasShield: true } }))
  assert.equal(axe.source, 'melee')
  assert.ok(axe.melee > 6)
  assert.equal(axe.advise, 'retreat')
  const sword = kp.dangerOf(obs({ dist: 2.5, foe: { main: { name: 'netherite_sword', ench: { sharpness: 5 } } }, me: { ehp: 6, hasShield: true } }))
  assert.equal(sword.advise, 'shield')
  // Заряженный ракетой арбалет — угроза издалека.
  const xb = kp.dangerOf(obs({ dist: 20, foe: { main: { name: 'crossbow', crossbow: { loaded: true, ammo: 'firework', stars: 3 } } }, me: { ehp: 20 } }))
  assert.equal(xb.source, 'ranged')
  assert.ok(Math.abs(xb.ranged - dm.afterDefense(dm.fireworkRaw(3, 1), 'explosion', dm.defenseOf(kit('iron')))) < 1e-9)
})

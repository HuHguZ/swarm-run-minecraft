'use strict'
// Боевой калькулятор: урон 1.21.11 по байткоду Paper (src/pvp/damage-model.ts). Числа — руками по формулам
// из jar (ссылки в модуле), сверка с уже существующими assess.afterArmor и mace.smashDamage.
import test = require('node:test')
import assert = require('node:assert/strict')
import * as dm from '../src/pvp/damage-model'
import * as assess from '../src/assess'

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`)
const kit = (mat, ench = {}) => ['helmet', 'chestplate', 'leggings', 'boots'].map(s => ({ name: `${mat}_${s}`, ench }))

test('незеритовый меч «Острота V» с критом против алмаза «Защита IV» ×4', () => {
  const def = dm.defenseOf(kit('diamond', { protection: 4 }))
  assert.deepEqual([def.armor, def.tough, def.prot], [20, 8, 16])
  // Player.attack: 8 × 1.5 (крит) + 3 (Острота V: 0.5·5 + 0.5, крит её не множит) = 15.
  const crit = dm.meleeRaw({ weapon: 'netherite_sword', sharpness: 5, charge: 1, crit: true })
  near(crit, 15)
  // Броня: 20 − 15/(2 + 8/4) = 16.25 → ×(1 − 0.65); чары: EPF 16 → ×0.36. 15·0.35·0.36 = 1.89.
  near(dm.afterDefense(crit, 'melee', def), 1.89)
  near(dm.afterDefense(11, 'melee', def), 11 * (1 - 17.25 / 25) * 0.36)
  // Без чар — ровно assess.afterArmor (CombatRules.getDamageAfterAbsorb).
  for (const raw of [1, 7, 15, 40]) near(dm.afterDefense(raw, 'melee', dm.defenseOf(kit('diamond'))), assess.afterArmor(raw, 20, 8))
})

test('заряд атаки: 0.2 + 0.8·c², Острота линейно, крит только при заряде > 0.9', () => {
  // Меч 1.6/с → 12.5 тика: заряд (t + 0.5)/12.5.
  near(dm.attackDelayTicks('diamond_sword'), 12.5)
  near(dm.chargeAfter(5, 'diamond_sword'), 5.5 / 12.5)
  assert.equal(dm.ticksToCharge('diamond_sword'), 12)
  const c = 0.5
  near(dm.meleeRaw({ weapon: 'diamond_sword', sharpness: 5, charge: c, crit: true }), 7 * (0.2 + 0.8 * c * c) + c * 3)
  near(dm.meleeRaw({ weapon: null }), 1) // кулак
  // Сила II (+3·2) и Слабость I (−4).
  near(dm.meleeRaw({ weapon: 'diamond_sword', strength: 1 }), 13)
  near(dm.meleeRaw({ weapon: 'diamond_sword', weakness: 0 }), 3)
})

test('скорости атаки по jar: медный топор 0.8/с (25 тиков), булава 33, копья 20×взмах', () => {
  near(dm.attackDelayTicks('copper_axe'), 25)
  near(dm.attackDelayTicks('iron_axe'), 20 / 0.9)
  assert.equal(dm.ticksToCharge('mace'), 33)
  near(dm.attackDelayTicks('netherite_spear'), 23)
  near(dm.attackDelayTicks('trident'), 20 / 1.1)
  assert.equal(dm.attackDamage('netherite_axe'), 10)
  assert.equal(dm.attackDamage('golden_axe'), 7)
  assert.equal(dm.attackDamage('netherite_spear'), 5)
})

test('булава с 10 блоков против незерита: бонус падения, крит, Плотность, Пролом', () => {
  const def = dm.defenseOf(kit('netherite'))
  assert.deepEqual([def.armor, def.tough], [20, 12])
  // MaceItem: 22 + (10 − 8) = 24; (6 + 24)·1.5 = 45 — то же, что mace.smashDamage.
  const raw = dm.meleeRaw({ weapon: 'mace', fall: 10, charge: 1 })
  near(raw, 45)
  near(raw, (require('../src/mace') as typeof import('../src/mace')).smashDamage(10))
  // 20 − 45/(2 + 3) = 11 → ×(1 − 0.44) = 25.2.
  near(dm.afterDefense(raw, 'melee', def), 25.2)
  // Пролом IV: доля брони 0.44 − 0.6 → 0: весь урон.
  near(dm.afterDefense(raw, 'melee', def, { breach: 4 }), 45)
  near(dm.afterDefense(raw, 'melee', def, { breach: 1 }), 45 * (1 - 0.44 + 0.15))
  // Плотность V: +0.5·5 за блок → (6 + 24 + 25)·1.5.
  near(dm.meleeRaw({ weapon: 'mace', fall: 10, charge: 1, density: 5 }), 82.5)
  // Свап без заряда: бонус к заряду не привязан, крита нет: 6·0.2 + 24.
  near(dm.meleeRaw({ weapon: 'mace', fall: 10, charge: 0 }), 25.2)
  // Не падал больше 1.5 — обычный удар.
  near(dm.meleeRaw({ weapon: 'mace', fall: 1.5, charge: 1 }), 6)
})

test('копьё: укол только с полным зарядом, разгон 1 + floor(отн. скорость × множитель) + Острота', () => {
  near(dm.jabRaw({ weapon: 'netherite_spear', charge: 1 }), 5)
  assert.equal(dm.jabRaw({ weapon: 'netherite_spear', charge: 0.95 }), 0)
  assert.equal(dm.spearChargeRaw({ weapon: 'netherite_spear', rel: 8 }), 1 + 9)
  assert.equal(dm.spearChargeRaw({ weapon: 'netherite_spear', rel: 8, sharpness: 5 }), 13)
  assert.equal(dm.spearChargeRaw({ weapon: 'wooden_spear', rel: 4.5 }), 0) // < 4.6 бл/с
  assert.equal(dm.spearChargeRaw({ weapon: 'wooden_spear', rel: 4.6 }), 1 + Math.floor(4.6 * 0.7))
})

test('стрелы: арбалет 7..11 (всегда крит), лук «Сила V» 15..23, заряд арбалета', () => {
  assert.deepEqual(dm.arrowOutcomes({ speed: 3.15, crit: true }).map(o => o.raw), [7, 8, 9, 10, 11])
  const bow = dm.bowShot(20)
  assert.deepEqual([bow.ok, bow.speed, bow.crit], [true, 3, true])
  const v = dm.arrowOutcomes({ speed: bow.speed, power: 5, crit: true }).map(o => o.raw)
  assert.deepEqual([v[0], v[v.length - 1], v.length], [15, 23, 9])
  assert.equal(dm.bowShot(1).ok, false)
  assert.deepEqual([0, 1, 2, 3].map(dm.crossbowChargeTicks), [25, 20, 15, 10])
  // Стрела — #is_projectile: «Защита от снарядов» 2·L.
  const def = dm.defenseOf([{ name: 'iron_chestplate', ench: { projectile_protection: 4 } }])
  near(dm.epfFor(def, 'projectile'), 8)
  near(dm.epfFor(def, 'melee'), 0)
})

test('ракета из арбалета: (5 + 2·звёзд)·sqrt((5 − d)/5), Взрывоустойчивость', () => {
  near(dm.fireworkRaw(3, 1), 11 * Math.sqrt(0.8))
  assert.equal(dm.fireworkRaw(0, 1), 0)
  assert.equal(dm.fireworkRaw(3, 5), 0)
  const def = dm.defenseOf([{ name: 'diamond_leggings', ench: { blast_protection: 4 } }])
  near(dm.epfFor(def, 'explosion'), 8)
})

test('кристалл и якорь: ExplosionDamageCalculator, сложность', () => {
  // 2 бл. от кристалла (сила 6): q = 2/12, e = 5/6 → (e² + e)/2·7·12 + 1.
  const e = 5 / 6
  near(dm.explosionRaw({ power: 6, dist: 2, seen: 1 }), Math.round(((e * e + e) / 2 * 84 + 1) * 100) / 100, 0.01)
  near(dm.explosionRaw({ power: 6, dist: 2, seen: 1, difficulty: 'hard' }), dm.explosionRaw({ power: 6, dist: 2, seen: 1 }) * 1.5, 0.02)
  assert.equal(dm.explosionRaw({ power: 5, dist: 11, seen: 1 }), 0)
  assert.equal(dm.explosionRaw({ power: 6, dist: 3, seen: 0 }), 1)
})

test('щит: передняя полусфера 90°, Пронзание, топор выбивает на 100 тиков', () => {
  // Он смотрит на −z (yaw 0). Мы спереди — 0°, сзади — 180°, ровно над ним — 90° (блок).
  near(dm.shieldAngle(0, { x: 0, z: 0 }, { x: 0, z: -3 }), 0)
  near(dm.shieldAngle(0, { x: 0, z: 0 }, { x: 0, z: 3 }), 180)
  near(dm.shieldAngle(0, { x: 0, z: 0 }, { x: 0, z: 0 }), 90)
  assert.equal(dm.shieldBlocks({ raised: true, angle: 89 }), true)
  assert.equal(dm.shieldBlocks({ raised: true, angle: 91 }), false)
  assert.equal(dm.shieldBlocks({ raised: true, angle: 0, kind: 'projectile', piercing: 1 }), false)
  assert.equal(dm.shieldBlocks({ raised: true, angle: 0, kind: 'explosion' }), true)
  assert.equal(dm.shieldBlocks({ raised: false, angle: 0 }), false)
  assert.equal(dm.AXE_DISABLE_TICKS, 100)
  assert.equal(dm.SHIELD_DELAY_TICKS, 5)
})

test('кадры неуязвимости: 10 тиков проходит только превышение сырого урона', () => {
  assert.deepEqual(dm.throughIframes(8, null), { raw: 8, last: { raw: 8, ago: 0 }, fresh: true })
  assert.equal(dm.throughIframes(8, { raw: 6, ago: 5 }).raw, 2)
  assert.equal(dm.throughIframes(8, { raw: 6, ago: 5 }).last.raw, 8)
  assert.equal(dm.throughIframes(5, { raw: 6, ago: 9 }).raw, 0)
  assert.equal(dm.throughIframes(5, { raw: 6, ago: 10 }).fresh, true)
})

test('тотем, регенерация, Сопротивление, падение с «Невесомостью»', () => {
  assert.deepEqual([dm.TOTEM.hp, dm.TOTEM.absorption, dm.TOTEM.regenTicks, dm.TOTEM.status], [1, 8, 900, 35])
  assert.equal(dm.regenInterval(1), 25)
  assert.equal(dm.regenInterval(0), 50)
  assert.equal(dm.instantHeal(1), 8)
  near(dm.afterDefense(10, 'melee', { ...dm.NO_DEFENSE, resistance: 0 }), 8)
  // Падение с 10 бл.: floor(10 − 3) = 7, брони нет; «Невесомость IV» + «Защита IV»: EPF 16 → ×0.36.
  assert.equal(dm.fallRaw(10), 7)
  const boots = dm.defenseOf([{ name: 'diamond_boots', ench: { feather_falling: 4, protection: 4 } }])
  near(dm.afterDefense(7, 'fall', boots), 7 * 0.36)
  const heavy = dm.defenseOf([{ name: 'diamond_boots', ench: { feather_falling: 4, protection: 4 } }, { name: 'diamond_helmet', ench: { protection: 4 } }, { name: 'diamond_leggings', ench: { protection: 4 } }])
  near(dm.afterDefense(7, 'fall', heavy), 7 * 0.2) // 12 + 12 = 24 → кап 20 → ×0.2
})

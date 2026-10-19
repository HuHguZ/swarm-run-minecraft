'use strict'
// Боевой калькулятор, часть 1 — урон 1.21.11 (Paper). Чистые функции: ни бота, ни mineflayer —
// на входе имена предметов, уровни чар и числа.
//
// Источник чисел — байткод server-run/versions/1.21.11/paper-1.21.11.jar (sha256 3a73f0cc4020a5eb…),
// `javap -c -p -constants` (JBR Android Studio), и датапак в том же jar
// (data/minecraft/enchantment/*.json, data/minecraft/tags/damage_type/*.json, data/minecraft/damage_type/*.json).
// Номера строк — в выгрузках research/claude-1006/combat-calc-javap/*.javap.txt (только на диске),
// сводка — research/claude-1006/combat-calculator.md, раздел «Формулы».
//
// Переиспользовано импортом (сверено с jar, расхождений нет): assess.afterArmor и assess.gearOf
// (CombatRules.getDamageAfterAbsorb без Breach; очки брони и прочность), assess.WEAPON (урон оружия),
// mace.smashBonus / mace.smashDamage (MaceItem.getAttackDamageBonus + Player.attack), spear.SPEARS и
// spear.DMG_REL (Item$Properties.spear в Items.<clinit>), boom.blast (ExplosionDamageCalculator +
// сложность). Импорт ленивый: ядро грузится без тела и без круга с pvp.ts.

const lazy = (path) => { let m = null; return () => m || (m = require(path)) }
const assess = lazy('../assess')
const mace = lazy('../mace')
const spear = lazy('../spear')
const boom = lazy('../boom')

const TICKS_PER_SECOND = 20

// ---------------------------------------------------------------- оружие

// Скорость атаки, ударов в секунду: Player.createAttributes ATTACK_SPEED 4.0 + модификатор предмета.
// Меч: Item$Properties.sword(материал, 3.0, −2.4) → 1.6. Топоры: Items.<clinit> → new AxeItem(материал,
// урон, скорость): незерит/алмаз (5, −3.0), золото (6, −3.0), железо (6, −3.1), камень/медь (7, −3.2),
// дерево (6, −3.2). Булава: MaceItem.createAttributes −3.4 → 0.6. Трезубец: TridentItem −2.9 → 1.1.
// Копьё: Item$Properties.spear → 1/время взмаха − 4 (spear.SPEARS.swing).
const AXE_SPEED = { wooden_axe: 0.8, stone_axe: 0.8, copper_axe: 0.8, iron_axe: 0.9, golden_axe: 1.0, diamond_axe: 1.0, netherite_axe: 1.0 }
function attackSpeed (name) {
  if (!name) return 4.0
  if (/_sword$/.test(name)) return 1.6
  if (AXE_SPEED[name]) return AXE_SPEED[name]
  if (name === 'mace') return 0.6
  if (name === 'trident') return 1.1
  const s = spear().SPEARS[name]
  return s ? 1 / s.swing : 4.0
}

// Урон атрибута ATTACK_DAMAGE с предметом в руке: база игрока 1.0 (Player.createAttributes dconst_1) +
// модификатор (ToolMaterial.createSwordAttributes/createToolAttributes: урон + attackDamageBonus материала:
// дерево/золото 0, камень/медь 1, железо 2, алмаз 3, незерит 4). Меч 3 + бонус, топор — см. AXE_SPEED,
// булава 5, трезубец 8, копьё 0 + бонус. Таблица — assess.WEAPON (совпадает), копья — spear.SPEARS.
function attackDamage (name) {
  if (!name) return 1
  const w = assess().WEAPON[name]
  if (w) return w
  const s = spear().SPEARS[name]
  return s ? 1 + s.bonus : 1
}

const isAxe = (name) => !!AXE_SPEED[name]
const isSpear = (name) => !!(name && spear().SPEARS[name])
const isMeleeWeapon = (name) => !!(name && (assess().WEAPON[name] || isSpear(name)))

// Player.getCurrentItemAttackStrengthDelay: 1 / ATTACK_SPEED × 20 тиков.
const attackDelayTicks = (name) => TICKS_PER_SECOND / attackSpeed(name)
// Player.getAttackStrengthScale(0.5): clamp((тики с удара или смены предмета + 0.5) / задержка, 0, 1).
// Сброс — resetAttackStrengthTicker: пакет взмаха (ServerPlayer.swing; mineflayer bot.attack шлёт его с ударом,
// Player.attack сам заряд НЕ сбрасывает — onAttack пустой) и смена предмета главной руки на другой
// (Player.tick: !ItemStack.isSameItem — второй такой же меч заряд не сбросит).
function chargeAfter (ticks, name) {
  return Math.max(0, Math.min(1, (ticks + 0.5) / attackDelayTicks(name)))
}
// Сколько тиков ждать заряда c (для крита нужен строго больше 0.9: Player.attack fcmpl 0.9).
function ticksToCharge (name, c = 1) {
  return Math.max(0, Math.ceil(c * attackDelayTicks(name) - 0.5))
}
const CRIT_CHARGE = 0.9

// Щит выбивает только топор: Item$Properties.axe → tool(…, 5.0) → Weapon(2, 5.0 с);
// BlocksAttacks.disableBlockingForTicks = round(5.0 × disableCooldownScale 1.0 × 20) = 100 тиков.
const AXE_DISABLE_TICKS = 100

// ---------------------------------------------------------------- чары

// sharpness.json / power.json: minecraft:add linear base 1.0, per_level_above_first 0.5 → 0.5·L + 0.5.
const sharpBonus = (L) => (L > 0 ? 0.5 * L + 0.5 : 0)
const powerBonus = sharpBonus

// ---------------------------------------------------------------- ближний бой

// Player.attack (javap Player 2276–2509), порядок как в байткоде:
//   f = ATTACK_DAMAGE (с Силой +3·(amp+1) и Слабостью −4·(amp+1): MobEffects.<clinit>, ADD_VALUE);
//   e = заряд × (чары − f)   — getEnchantedDamage: Острота, линейно по заряду;
//   f ×= 0.2 + 0.8·заряд²    — baseDamageScaleFactor;
//   f += Item.getAttackDamageBonus — у булавы бонус падения (к заряду не привязан);
//   крит: заряд > 0.9 и canCriticalAttack (fallDistance > 0, не на земле, не на лестнице, не в воде,
//         без Слепоты — isMobilityRestricted, не верхом, цель живая, НЕ спринт) → f ×= 1.5;
//   итог f + e (крит не множит Остроту).
// Булаву с падения считает mace.smashDamage — та же формула (крит при заряде > 0.9: падая, он всегда есть).
const SMASH_MIN = 1.5 // MaceItem.canSmashAttack: fallDistance > 1.5 и не элитры
function meleeRaw ({ weapon = null, sharpness = 0, strength = -1, weakness = -1, charge = 1, crit = false, fall = 0, density = 0 }: any = {}) {
  const attr = Math.max(0, attackDamage(weapon) + (strength >= 0 ? 3 * (strength + 1) : 0) - (weakness >= 0 ? 4 * (weakness + 1) : 0))
  const ench = charge * sharpBonus(sharpness)
  if (weapon === 'mace' && fall > SMASH_MIN) return mace().smashDamage(fall, { base: attr, charge, density }) + ench
  return attr * (0.2 + 0.8 * charge * charge) * (crit && charge > CRIT_CHARGE ? 1.5 : 1) + ench
}

// Копьё, укол (PiercingWeapon.attack → LivingEntity.stabAttack, javap Player 3134–3303): урон —
// ATTACK_DAMAGE × 0.2+0.8·заряд² + заряд × Острота, без крита. MINIMUM_ATTACK_CHARGE 1.0
// (Item$Properties.spear): с неполным зарядом сервер укол не примет (Player.cannotAttackWithItem).
function jabRaw ({ weapon, sharpness = 0, strength = -1, weakness = -1, charge = 1 }: any) {
  if (!isSpear(weapon) || charge < 1) return 0
  return meleeRaw({ weapon, sharpness, strength, weakness, charge, crit: false })
}

// Копьё, разгон (KineticWeapon.damageEntities): относительная скорость rel = max(0, моя вдоль взгляда − его
// вдоль моего взгляда), бл/с (getKnownSpeed × 20); урон, если rel ≥ 4.6 (Condition.ofRelativeSpeed, у игрока
// множитель 1.0) и время «использования» после задержки не больше окна урона. Урон = базовое значение
// ATTACK_DAMAGE (1.0 — getAttributeBaseValue: ни меча, ни Силы) + floor(rel × damageMultiplier); stabAttack при
// «использовании» заряд не применяет — Острота целиком. Одну цель — раз в 10 тиков (contactCooldownTicks).
function spearChargeRaw ({ weapon, sharpness = 0, rel = 0 }: any) {
  const s = spear().SPEARS[weapon]
  if (!s || !(rel >= spear().DMG_REL)) return 0
  return 1 + Math.floor(rel * s.mult) + sharpBonus(sharpness)
}

// ---------------------------------------------------------------- снаряды

// AbstractArrow.onHitEntity: i = ceil(clamp(|v| × урон, 0, MAX_INT)), урон = baseDamage 2.0 + Сила лука
// (EnchantmentHelper.modifyDamage, power.json, только для #arrows); крит-стрела: i += nextInt(i/2 + 2).
// Возвращает исходы { raw, p } — равновероятные.
function arrowOutcomes ({ speed, power = 0, crit = false }: any) {
  const i = Math.ceil(Math.max(0, speed * (2 + powerBonus(power))))
  if (!crit || i <= 0) return [{ raw: i, p: 1 }]
  const n = Math.floor(i / 2) + 2
  return Array.from({ length: n }, (_, k) => ({ raw: i + k, p: 1 / n }))
}
// Скорость к попаданию: в воздухе стрела теряет 1 % за тик (AbstractArrow: инерция 0.99); тики ≈ путь / v.
// Гравитацию (0.05/тик) для модуля скорости на дистанциях боя опускаем.
const arrowSpeedAt = (v0, dist) => v0 * Math.pow(0.99, Math.max(0, dist) / Math.max(0.1, v0))
// BowItem.getPowerForTime(тики): f = t/20; f = (f² + 2f)/3; ≤ 1. Скорость 3·f, крит только при f = 1,
// выстрела нет при f < 0.1 (BowItem.releaseUsing).
function bowShot (ticks) {
  let f = ticks / TICKS_PER_SECOND
  f = Math.min(1, (f * f + 2 * f) / 3)
  return { ok: f >= 0.1, speed: 3 * f, crit: f >= 1 }
}
const BOW_FULL_TICKS = 20
// Арбалет: CrossbowItem.getShootingPower — 3.15 стрела, 1.6 ракета; performShooting(…, isCrit = стрелок —
// игрок): стрела из арбалета игрока всегда крит. Время заряда getChargeDuration = floor((1.25 − 0.25·Быстрая
// перезарядка) × 20): 25/20/15/10 тиков.
const CROSSBOW_ARROW_SPEED = 3.15
const crossbowChargeTicks = (quickCharge = 0) => Math.floor((1.25 - 0.25 * quickCharge) * TICKS_PER_SECOND)
// FireworkRocketEntity.dealExplosionDamage: f = 5 + 2·взрывов (только если взрывы есть); цели в 5 бл. —
// f × sqrt((5 − d)/5), d — от ракеты до его позиции (ног). При попадании в тело d ≈ 1 → ×0.894.
// Тип fireworks: #is_explosion (Взрывоустойчивость), не #is_projectile; масштаб сложности —
// only when_caused_by_living_non_player, игроку не масштабируется.
function fireworkRaw (stars, d = 1) {
  if (!(stars > 0) || !(d < 5)) return 0
  return (5 + 2 * stars) * Math.sqrt((5 - d) / 5)
}

// ---------------------------------------------------------------- взрывы

// ExplosionDamageCalculator.getEntityDamageAmount: q = |его ноги − центр| / (2P); e = (1 − q) × видимость;
// урон ((e² + e)/2) × 7 × 2P + 1; сложность (player_explosion, bad_respawn_point — scaling always;
// Player.hurtServer: лёгкая min(f/2 + 1, f), трудная ×1.5). Считает boom.blast (тот же код).
// Кристалл — сила 6 (EndCrystal.hurtServer → explode 6.0), якорь — 5 (RespawnAnchorBlock.explode 5.0).
const CRYSTAL_POWER = 6
const ANCHOR_POWER = 5
function explosionRaw ({ power, dist, seen = 1, difficulty = 'normal' }: any) {
  return boom().blast({ game: { difficulty } }, { x: 0, y: 0, z: 0 }, power, { x: dist, y: 0, z: 0 }, { seen }).raw
}

// ---------------------------------------------------------------- защита цели

// Защита из видимых предметов: очки брони и прочность — assess.gearOf (ArmorMaterials), чары — по типам.
// items: [{ name, ench: { protection, … } }] — сапоги..шлем в любом порядке. resistance: −1 — нет / не видно.
function defenseOf (items: any[] = [], { resistance = -1 }: any = {}) {
  const worn = (items || []).filter(Boolean)
  const g = assess().gearOf(worn)
  const sum = (k) => worn.reduce((s, it) => s + ((it.ench && it.ench[k]) || 0), 0)
  return {
    armor: g.armor,
    tough: g.tough,
    prot: sum('protection'),
    blast: sum('blast_protection'),
    proj: sum('projectile_protection'),
    fall: sum('feather_falling'),
    fire: sum('fire_protection'),
    resistance
  }
}
// Защита цели: броня, твёрдость, EPF чар по видам урона, уровень Сопротивления (−1 — нет).
interface Defense { armor: number; tough: number; prot: number; blast: number; proj: number; fall: number; fire: number; resistance: number }
const NO_DEFENSE: Readonly<Defense> = Object.freeze({ armor: 0, tough: 0, prot: 0, blast: 0, proj: 0, fall: 0, fire: 0, resistance: -1 })

// EnchantmentHelper.getDamageProtection — сумма по броне (protection.json 1·L; blast_protection 2·L
// при #is_explosion; projectile_protection 2·L при #is_projectile; feather_falling 3·L при #is_fall;
// fire_protection 2·L при #is_fire); CombatRules.getDamageAfterMagicAbsorb: clamp(0, 20) → ×(1 − EPF/25).
// kind: 'melee' (player_attack, mace_smash, spear, trident) | 'projectile' (arrow, trident) |
// 'explosion' (fireworks, crystal, anchor) | 'fall' | 'fire'.
function epfFor (def, kind) {
  let e = def.prot || 0
  if (kind === 'explosion') e += 2 * (def.blast || 0)
  else if (kind === 'projectile') e += 2 * (def.proj || 0)
  else if (kind === 'fall') e += 3 * (def.fall || 0)
  else if (kind === 'fire') e += 2 * (def.fire || 0)
  return Math.max(0, Math.min(20, e))
}

// Сырой урон → прошедший в здоровье+поглощение. Paper LivingEntity.handleEntityDamage — цепочка
// модификаторов: неуязвимость → заморозка → шлем → щит → броня → Сопротивление → чары → поглощение.
//  * броня: CombatRules.getDamageAfterAbsorb = assess.afterArmor; Breach булавы (breach.json:
//    armor_effectiveness −0.15·L) вычитается из доли брони: clamp(доля − 0.15·L, 0, 1);
//    #bypasses_armor (падение, огонь на теле…) броню пропускает;
//  * Сопротивление: (25 − 5·(amp+1))/25 (lambda$handleEntityDamage$23);
//  * чары — epfFor.
function afterDefense (raw, kind, def: Partial<Defense> = NO_DEFENSE, { breach = 0 }: any = {}) {
  let d = Math.max(0, raw)
  if (d <= 0) return 0
  if (kind !== 'fall') {
    const a = assess().afterArmor(d, def.armor || 0, def.tough || 0)
    d = Math.min(d, a + d * 0.15 * breach)
  }
  if (def.resistance >= 0) d *= Math.max(0, 1 - 0.2 * (def.resistance + 1))
  return d * (1 - epfFor(def, kind) / 25)
}

// ---------------------------------------------------------------- щит

// Щит (Items.SHIELD): BlocksAttacks(задержка 0.25 с → 5 тиков, DamageReduction(90°, любой тип, base 0,
// factor 1), …, bypassed_by #bypasses_shield). LivingEntity.applyItemBlocking: угол — между его
// горизонтальным взглядом (yHeadRot) и горизонталью на ИСТОЧНИК (позицию атакующего, снаряда, кристалла);
// ≤ 90° — гасится весь урон. Прямо над ним горизонталь нулевая → acos(0) = 90° — тоже блок.
// Стрелу с Пронзанием щит не держит (getPierceLevel > 0). #bypasses_shield — лава, огонь, падение и прочее
// без брони; ни удар, ни стрела, ни ракета, ни кристалл в него не входят.
// Держит только через 5 тиков после подъёма (LivingEntity.getItemBlockingWith, blockDelayTicks).
const SHIELD_DELAY_TICKS = 5
const SHIELD_HALF_ANGLE = 90
function shieldAngle (foeYaw, foePos, srcPos) {
  const fx = -Math.sin(foeYaw); const fz = -Math.cos(foeYaw)
  const tx = srcPos.x - foePos.x; const tz = srcPos.z - foePos.z
  const h = Math.hypot(tx, tz)
  if (h < 1e-6) return 90
  return Math.acos(Math.max(-1, Math.min(1, (fx * tx + fz * tz) / h))) * 180 / Math.PI
}
function shieldBlocks ({ raised, angle = 0, kind = 'melee', piercing = 0 }: any) {
  if (!raised) return false
  if (kind === 'fall' || kind === 'fire') return false
  if (kind === 'projectile' && piercing > 0) return false
  return angle <= SHIELD_HALF_ANGLE
}

// ---------------------------------------------------------------- неуязвимость

// LivingEntity.hurtServer (javap LivingEntity 3436–3534): пока invulnerableTime > 20/2 (10 тиков после
// удара), проходит только превышение СЫРОГО урона над прошлым (handleEntityDamage(…, lastHurt)), броня —
// уже к разнице; не больше прошлого — 0, без damage_event и отброса. Свежий удар: lastHurt = сырой,
// invulnerableTime = 20 (invulnerableDuration). last: { raw, ago } | null.
const IFRAME_TICKS = 10
function throughIframes (raw, last) {
  if (!last || !(last.ago < IFRAME_TICKS)) return { raw, last: { raw, ago: 0 }, fresh: true }
  if (raw <= last.raw) return { raw: 0, last, fresh: false }
  return { raw: raw - last.raw, last: { raw, ago: last.ago }, fresh: false }
}

// ---------------------------------------------------------------- тотем и лечение

// LivingEntity.checkTotemDeathProtection (javap 4246–4290): тотем в любой руке (сначала главная), урон не
// #bypasses_invulnerability; setHealth(1.0) — излишек урона пропадает; DeathProtection.TOTEM_OF_UNDYING:
// снять все эффекты, Регенерация II 900 т, Поглощение II 100 т, Огнестойкость 800 т; событие 35.
// AbsorptionMobEffect.onEffectStarted: поглощение = max(текущее, 4·(amp+1)) → 8.
const TOTEM = { hp: 1, absorption: 8, absorptionTicks: 100, regenAmp: 1, regenTicks: 900, fireResTicks: 800, status: 35 }
// RegenerationMobEffect.shouldApplyEffectTickThisTick: +1 хп раз в (50 >> amp) тиков.
const regenInterval = (amp) => Math.max(1, 50 >> Math.max(0, amp))
const absorptionOfAmp = (amp) => 4 * (amp + 1)
// HealOrHarmMobEffect: мгновенное лечение 4 << amp.
const instantHeal = (amp) => 4 << Math.max(0, amp)

// LivingEntity.calculateFallDamage: floor(fallDistance + 1e-6 − 3 (safe_fall_distance)) × множители.
const fallRaw = (h) => Math.max(0, Math.floor(h + 1e-6 - 3))

export {
  TICKS_PER_SECOND, AXE_SPEED, CRIT_CHARGE, AXE_DISABLE_TICKS, SMASH_MIN, BOW_FULL_TICKS, CROSSBOW_ARROW_SPEED,
  CRYSTAL_POWER, ANCHOR_POWER, SHIELD_DELAY_TICKS, SHIELD_HALF_ANGLE, IFRAME_TICKS, TOTEM, NO_DEFENSE,
  attackSpeed, attackDamage, attackDelayTicks, chargeAfter, ticksToCharge, isAxe, isSpear, isMeleeWeapon,
  sharpBonus, powerBonus, meleeRaw, jabRaw, spearChargeRaw,
  arrowOutcomes, arrowSpeedAt, bowShot, crossbowChargeTicks, fireworkRaw, explosionRaw,
  defenseOf, epfFor, afterDefense, shieldAngle, shieldBlocks, throughIframes,
  regenInterval, absorptionOfAmp, instantHeal, fallRaw
}

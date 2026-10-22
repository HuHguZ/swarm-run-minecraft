// Булава и заряды ветра (просьба 2026-09-26: «всё, что даёт версия»).
// Четыре вещи:
//  1. Удар с падения: взлёт на заряде ветра под ноги (или спуск со своего
//     столба) и удар булавой на спуске — бонус растёт с высотой падения.
//  2. Заряд ветра как толчок: в яму, со столба, сбить рывок, сбить еду.
//  3. Защита от чужой булавы: щит к нему, без щита — шаг из-под него, не
//     стоять под тем, кто сидит сверху с булавой.
//  4. Посадка: свой заряд — урон от падения только ниже точки всплеска; иначе
//     вода (edges.installFallGuard) или второй заряд под ноги.
//
// Числа — декомпилированный клиент 1.21.11 (github extremeheat/
// extracted_minecraft_data, ветка client1.21.11, пути от net/minecraft/):
//  * world/item/MaceItem: урон 1 + 5, скорость 4 − 3.4 = 0.6 (33 тика заряда);
//    удар с падения, если fallDistance > 1.5 (canSmashAttack); бонус
//    getAttackDamageBonus: 4h до 3 бл., 12 + 2(h − 3) до 8, 22 + (h − 8) выше;
//    после удара (hurtEnemy) вертикальная скорость бьющего 0.01, падение
//    обнулено (postHurtEnemy), точка для урона от падения — ниже из «точки
//    всплеска ветра» и места удара (calculateImpactPosition);
//  * world/entity/player/Player.attack: бонус прибавляется ПОСЛЕ множителя
//    заряда, крит ×1.5 — заряд > 0.9, падение, не спринт (canCriticalAttack);
//    урон и заряд — атрибуты руки (обновятся в тике), предмет для бонуса —
//    getWeaponItem() в момент пакета: свап «меч → булава» в одном тике даёт
//    урон и заряд меча плюс бонус булавы (MC-28289, PVP-RESEARCH б.3);
//  * world/item/WindChargeItem: скорость 1.5, неточность 1.0, появляется в x,z
//    игрока на высоте глаз, + своё смещение (Projectile.shootFromRotation:
//    x,z всегда, y — если не на земле); перезарядка 0.5 с (Items.WIND_CHARGE);
//  * world/entity/projectile/hurtingprojectile/windcharge/AbstractWindCharge:
//    без гравитации и трения; о блок — всплеск в точке удара + 0.25 по нормали
//    грани (onHitBlock), о сущность — 1 урона и всплеск там же (onHitEntity);
//  * .../windcharge/WindCharge + world/level/ServerExplosion.hurtEntities:
//    радиус 1.2, задевает, если НОГИ в 2.4 от центра; толчок
//    (1 − d/2.4)·видимость·1.22 по направлению «центр → глаза»;
//  * server/level/ServerPlayer.onExplosionHit + Player.causeFallDamage: после
//    заряда ветра игрока урон от падения = min(падение, точка всплеска − y):
//    сел не ниже точки всплеска — урона нет (40 тиков «прощения»);
//  * world/entity/LivingEntity.applyItemBlocking: щит держит, если источник
//    в 90° от взгляда ПО ГОРИЗОНТАЛИ; ровно над головой (горизонталь 0) — нет.
// Замеры — daemon/scenes/pvp/try-mace.js на тестовом сервере (2026-09-26).
// Тело модуля — src/mace/: consts (числа игры, урон с падения), hands (руки, хотбар, его щит, удар, заряд ветра),
// world (досягаемость, опора, огонь, посадка, паутина, потолок), track (слежка за ним), descend (спуск с ударом),
// smash (когда взлетать, взлёт и удар), push (толчок зарядом), defend (защита от булавы сверху).
export { SWAP, REACH, smashBonus, smashDamage } from './mace/consts'
export { install, fireWind, ensureHotbar, hotbarIndex, windReady, shieldAtUs, slamHit,
  // utility.js (2026-09-26): удочка, трезубец — тот же «после пакета этого тика».
  afterPacket } from './mace/hands'
// Посадка в огонь (прогон физики до земли) — для сцены try-burnland.js.
export { headroom, landing, burnAt, fallCost, AIR_KEYS, NO_KEYS } from './mace/world'
export { track } from './mace/track'
export { descend } from './mace/descend'
export { smashPlan, smashCheck, windSmash, fallSmashReady } from './mace/smash'
export { knockOff, pushPlan, windPush } from './mace/push'
export { defend } from './mace/defend'

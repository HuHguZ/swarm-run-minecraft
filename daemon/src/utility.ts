'use strict'
// Удочка, трезубец, хорус, ловушки (2026-09-26, «мега-бот»: всё, чем дерутся
// про-игроки; PVP-RESEARCH б.6, б.12, б.15, б.17; в.12–в.15). Взрывчатки нет
// намеренно: TNT и кристаллы ломают небесную арену пользователя.
//
// Числа — декомпилированный клиент 1.21.11 (github extremeheat/
// extracted_minecraft_data, ветка client1.21.11, пути от net/minecraft/):
//  * world/entity/projectile/FishingHook: поплавок вылетает от глаз, на 0.3
//    вперёд по взгляду; скорость = (взгляд по горизонтали, tan(наклона вверх) в
//    пределах ±5) × (0.6/|v| + треуг(0.5, 0.0103)) — по горизонтали
//    0.6·cos p + 0.5, всего 0.6 + 0.5/cos p; своё движение НЕ прибавляется
//    (скорость задана в конструкторе). Тик в полёте: y −0.03, сдвиг, ×0.92.
//    Попал в сущность — hooked_entity (метаданные №8) = её id + 1, урона и
//    отброса нет. retrieve(): зацеплен — pullEntity: скорость цели += 0.1 ×
//    (владелец − поплавок), поплавок на цели в y + 0.8·рост; событие сущности 31.
//    Игрока тянет ЕГО СОБСТВЕННЫЙ клиент (handleEntityEvent: isLocalPlayer) —
//    бота на mineflayer никто не тянет, поэтому installRodPull делает это за
//    ванильный клиент. Леска рвётся дальше 32 бл. или без удочки в руках
//    (shouldStopFishing: distanceToSqr ≤ 1024). Прочность: сущность −5.
//  * world/entity/LivingEntity: урон не прерывает еду и питьё (stopUsingItem —
//    только смерть, смена предмета, отпускание); удочка «сбивает еду» только
//    тем, что тащит едока (он медленный ×0.2) к нашему мечу, к яме, к лаве.
//  * world/item/TridentItem: бросок — натяжение ≥ 10 тиков, скорость 2.5,
//    неточность 1.0, + своё смещение (spawnProjectileFromRotation); урон 8.
//    «Тягун» — только в воде или под дождём: толчок по взгляду 1.5 + 0.75·(L−1)
//    (Enchantments: trident_spin_attack_strength), с земли сперва +1.2 вверх,
//    20 тиков вращения, касание 8 урона. releaseUsing идёт и у клиента — бот
//    толкает себя сам. world/entity/projectile/arrow/ThrownTrident: физика
//    стрелы (сдвиг, ×0.99, y −0.05), «Верность» L возвращает: ×0.95 + 0.05·L к
//    глазам владельца, как только попал или лежит > 4 тиков.
//  * world/item/consume_effects/TeleportRandomlyConsumeEffect + LivingEntity.
//    randomTeleport: хорус — еда 1.6 с (Consumables.defaultFood), потом до 16
//    попыток: x, y, z ± 8 (diameter 16), вниз до блока, который держит
//    (blocksMotion) — хоть до дна мира; место без столкновений и без жидкости;
//    падение обнуляется. Перезарядка 1 с (Items.CHORUS_FRUIT useCooldown 1.0).
//  * world/entity/item/FallingBlockEntity.causeFallDamage + AnvilBlock.falling:
//    наковальня бьёт всех в своей рамке при посадке на min(floor(2·ceil(h − 1)),
//    40); урон falling_anvil — мимо щита (DamageTypeTagsProvider BYPASSES_SHIELD),
//    шлем ×0.75 (LivingEntity: DAMAGES_HELMET), броня считается. Падает сквозь
//    игрока и паутину (коллизий у них нет).
//  * BucketItem.use: луч от глаз по контуру блоков (паутина — полный куб):
//    лава встаёт в клетку перед гранью, в которую смотрим; поэтому лава на
//    врага в паутине — в верхнюю грань паутины, в клетку его головы.
//
// Тело — в utility/: common (предметы, блоки, тик и пакет), rod (удочка), trident (трезубец, дождь, «Тягун»),
// chorus (хорус), traps (ловушки), fight (create — приёмы на бой).

// Зависимости — в прежнем порядке загрузки (до разбиения на части): порядок первых require в циклах импорта не меняется.
import './game-clock'
import 'vec3'
import './edges'
import './tempo'
import './read'
import './bow'
import './hazards'
import './mace'
import './perception'
import './build'
import './movement'

export { create } from './utility/fight'
export { installRodPull, rodFlight, rodPitch, rodPlan, rodPull, myHook, hookedBy, ROD_MAX } from './utility/rod'
export { tridentPlan, throwTrident, riptide, riptideTo, rainAt } from './utility/trident'
export { chorusOdds, escapeChoice, chorusEscape } from './utility/chorus'
export { stuckOf, anvilPlan, dropAnvil, blockInPlan, blockIn, lavaPlan, pourLava } from './utility/traps'

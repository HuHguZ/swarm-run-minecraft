'use strict'
// Езда: лошадь (осёл, мул) и лодка. Одна и та же суть у обоих: транспорт,
// которым правит игрок, СЧИТАЕТ КЛИЕНТ, а сервер только принимает координаты.
//
// Сверено с paper-1.21.11.jar (javap), а не угадано:
//  · LivingEntity.travelRidden: getRiddenInput → tickRidden → если
//    canSimulateMovement() — travel(), иначе setDeltaMovement(ZERO). На
//    сервере у лошади с игроком в седле canSimulateMovement ложно: лошадь стоит,
//    пока клиент не пришлёт её новое место пакетом vehicle_move
//    (ServerboundMoveVehiclePacket). mineflayer 4.37 этого не делает вовсе: на
//    'mount' он выключает свою физику (physics.js shouldUsePhysics=false) и
//    больше ничего не шлёт — ни позиции, ни взгляда. bot.moveVehicle шлёт
//    только ввод (player_input), от которого на сервере лошадь не двигается.
//    Поэтому здесь своя маленькая физика транспорта и свои пакеты: как у
//    настоящего клиента — look, player_input, vehicle_move каждый тик.
//  · AbstractHorse.getRiddenInput: (xxa·0.5, 0, zza), назад ·0.25;
//    getRiddenSpeed = атрибут movement_speed лошади (у каждой своя, база
//    0.225); шаг вверх — атрибут step_height 1.0 (createBaseHorseAttributes):
//    на блок лошадь заходит без прыжка. Движение — обычное LivingEntity.travel:
//    ускорение speed·0.216/f³ (f=0.6 → ровно speed), трение 0.546 — это же
//    считает prismarine-physics для игрока, её и берём с хитбоксом лошади
//    (1.3964844 × 1.6, у осла 1.5).
//  · Прыжок: executeRidersJump — vy = jump_strength·scale (у лошади своя, база
//    0.7), и если едем вперёд — толчок 0.4·scale по взгляду. Полный прыжок —
//    scale 1 (handleStartJump: сила ≥ 90 → 1.0). Серверу — entity_action
//    start_horse_jump.
//  · Управлять можно только осёдланной (getControllingPassenger → isSaddled) и
//    приручённой (флаг 2 в DATA_ID_FLAGS, метаданные 17). Седло с 1.21.5 —
//    экипировка: клик седлом по приручённой (ItemStack.interactLivingEntity →
//    Equippable, canUseSlot(SADDLE): жива, взрослая, приручена).
//  · Слезть — shift в player_input (wantsToStopRiding). mineflayer.dismount
//    шлёт на 1.21.2+ прыжок, а прыжок в седле — это прыжок лошади.
//  · Лодка (AbstractBoat.controlBoat): влево/вправо — deltaRotation ∓1 за тик,
//    вперёд +0.04, назад −0.005, поворот на месте +0.005; floatBoat в воде —
//    трение 0.9 и скорости, и вращения. Поворот лодки — ВВОДОМ, а не взглядом
//    игрока; предельная скорость 0.4 блока за тик. Место — vehicle_move, весло —
//    paddle_boat.
//  · Сервер (handleMoveVehicle) сам двигает транспорт на присланную разницу с
//    коллизией и отбивает, если вышло не туда — поэтому посылать надо только
//    честно посчитанное место, без прохода сквозь блоки.

export { isTamedHorse, isSaddled, HORSES, isBoatName } from './ride/base'
export { dismount, mountOn, patchVehicle } from './ride/mount'
export { astar } from './ride/plan'
export { tameHorse, horseInfo } from './ride/horse'
export { run, HORSE_MODES, BOAT_MODES } from './ride/run'

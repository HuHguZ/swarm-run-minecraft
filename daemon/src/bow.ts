'use strict'
// Лук. Один модуль и для боя (pvp.js), и для тира (try-bow.js), чтобы то,
// что проверено в тире, и было тем, что стреляет в бою.
//
// Физика стрелы — как в AbstractArrow.tick (Java 1.21): стрела появляется на
// высоте глаз − 0.1, скорость = направление × 3 × сила (сила 1 при полном
// натяжении, 20 тиков); каждый тик позиция += скорость, потом скорость ×= 0.99,
// потом y −= 0.05. Разброс лука ~1° (inaccuracy 1.0) — его не убрать, но всё
// остальное должно быть точным. Прошлый прицел перебирал угол шагом 1° (на 30
// блоках это полблока), упреждал по «дистанция / 3» и держал тетиву ровно 1.05 с —
// на лаге стрела уходила недотянутой и падала короче.
//
// Тело — в bow/: ballistics (физика стрелы и прицел), charge (подтверждение натяжения), track (цель и её скорость),
// shoot (выстрел) с частями shot-aim, shot-release, shot-result над общим состоянием shot-state.

// Зависимости — в прежнем порядке загрузки (до разбиения на части): порядок первых require в циклах импорта не меняется.
import './game-clock'
import './edges'
import 'node:async_hooks'
import 'vec3'
import './movement'
import './pick'

export { DRAW_MS, SPEED, GRAVITY, flight, peakPitch, solvePitch, aim, aimMoving, blockedAt } from './bow/ballistics'
export { observeCharge } from './bow/charge'
export { leadTarget, traceTarget, trackTarget, observedVelocity, hasObservedVelocity } from './bow/track'
export { shoot } from './bow/shoot'

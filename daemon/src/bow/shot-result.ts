'use strict'
// Лук (bow.ts): итог выпущенной стрелы — что показать вызывающему (shotOutcome) и разбор её начальной скорости
// из пакета появления против прицела (arrowDiag, только при follow).
import type { ShotState } from './shot-state'

// Итог выстрела сразу после спуска (fin — как прошёл спуск).
function shotOutcome (S: ShotState, fin) {
  const { entity, charge, traceAim, short, speed } = S
  const out: any = {
    shot: true,
    dist: Math.round(S.me.distanceTo(entity.position) * 10) / 10,
    pitchDeg: Math.round(S.sol.pitch * 1800 / Math.PI) / 10,
    flightTicks: S.sol.ticks,
    aimAt: S.sol.at,
    from: S.sol.from,
    fullChargeConfirmed: !short,
    nativeCharge: charge.snapshot(),
    ...(traceAim ? { aimObservation: { ...S.sol.observation, solvedAt: S.sol.solvedAt, checkedAt: fin?.checkedAt, releasedAt: S.releasedAt } } : {}),
    speed: short ? Math.round(speed * 100) / 100 : undefined,
    speedEstimated: short || undefined
  }
  return out
}

// out.diag: куда полетела стрела по пакету появления против того, куда целились.
function arrowDiag (S: ShotState, out) {
  const { bot, follow } = S
  if (S.spawnPkt) {
    // Скорость в пакете: старые версии — velocityX/Y/Z в 1/8000 блока за тик,
    // 1.21.9+ — вектор velocity. Берём, что есть.
    let v = null
    const pv = S.spawnPkt.velocity
    if (pv && typeof pv.x === 'number') v = { x: pv.x, y: pv.y, z: pv.z }
    else if (typeof S.spawnPkt.velocityX === 'number') v = { x: S.spawnPkt.velocityX / 8000, y: S.spawnPkt.velocityY / 8000, z: S.spawnPkt.velocityZ / 8000 }
    out.diag = {
      wantYaw: Math.round(S.sol.yaw * 180 / Math.PI),
      wantPitch: Math.round(S.sol.pitch * 180 / Math.PI),
      flewYaw: v ? Math.round(Math.atan2(-v.x, -v.z) * 180 / Math.PI) : null,
      flewPitch: v ? Math.round(Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI) : null,
      speed: v ? Math.round(Math.hypot(v.x, v.y, v.z) * 100) / 100 : null,
      mySpeed: bot.entity.velocity ? Math.round(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) * 100) / 100 : null,
      raw: v ? undefined : Object.keys(S.spawnPkt).join(',')
    }
  } else if (follow) {
    out.diag = { note: 'пакета появления стрелы не поймал' }
  }
}

export { shotOutcome, arrowDiag }

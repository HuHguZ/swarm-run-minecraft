'use strict'
// Лук (bow.ts): начало натяжения выстрела — часы натяжения, своё смещение за тик (его сервер прибавит к стреле)
// и решатель прицела solve() над ними. Синхронно: слушатель тика ставится в тот же миг, что и раньше в shoot.
import * as gameClock from '../game-clock'
import { GRAVITY, aim, aimMoving } from './ballistics'
import type { ShotState } from './shot-state'

// Заполняет S.sol, S.t0, S.holdDeadline, S.moved, S.stopTick, S.myVel, S.solve.
function trackShot (S: ShotState) {
  const { bot, drawMs, holdMaxMs, eye, targetNow, mode, speed, steep, traceAim } = S
  S.sol = null
  const t0 = S.t0 = gameClock.now()
  S.holdDeadline = t0 + drawMs + holdMaxMs
  // Что сервер прибавит к стреле — это смещение стрелка за последний тик
  // (замер /data get entity Motion: лишняя скорость стрелы ≈ 2 × velocity
  // mineflayer). velocity в mineflayer — уже после трения за тик (×0.546 на
  // земле), а смещение — до него. Поэтому меряем само смещение.
  let lastPos = bot.entity.position.clone()
  S.moved = { x: 0, y: 0, z: 0 }
  const onTick = () => {
    const p = bot.entity.position
    S.moved = { x: p.x - lastPos.x, y: p.y - lastPos.y, z: p.z - lastPos.z }
    lastPos = p.clone()
  }
  bot.on('physicsTick', onTick)
  S.stopTick = () => { bot.removeListener('physicsTick', onTick) }
  const myVel = S.myVel = () => S.moved
  S.solve = () => {
    const from = eye()
    const target = targetNow()
    const s = mode === 'compensate'
      ? aimMoving(from, target, myVel(), !bot.entity.onGround, speed, GRAVITY, steep)
      : aim(from, target, speed, GRAVITY, steep)
    return s ? { ...s, from, ...(traceAim ? { observation: target.observation, solvedAt: gameClock.serverNow() } : {}) } : null
  }
}

export { trackShot }
